/**
 * A polyline drawn a fixed number of CSS pixels wide (WebGL lines are
 * always 1px), for the orbit. Each frame the points are projected on the
 * CPU, cut where they pass behind the camera, and widened in screen space;
 * the vertex shader only receives normalised device coordinates, so depth
 * still works and the Earth hides the far side of the orbit.
 */
import * as THREE from '../globe/vendor/three.module.min.js';

const VS = /* glsl */ `
  attribute float alpha;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    gl_Position = vec4(position, 1.0);
  }
`;

const FS = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(color, opacity * vAlpha);
    #include <colorspace_fragment>
  }
`;

/**
 * @param {number} maxPoints  most points setPoints will be given
 * @param {{color?: string, widthPx?: number}} [opts]
 */
export function createScreenLine(maxPoints, { color = '#3C9DF5', widthPx = 2 } = {}) {
  const maxVerts = maxPoints * 6;
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(maxVerts * 3);
  const alpha = new Float32Array(maxVerts);
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: 1 } },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide, // the strip's winding follows the line's direction on screen
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  let points = new Float32Array(0); // world xyz
  let weights = new Float32Array(0); // per point alpha
  let count = 0;
  let masks = []; // {left, top, right, bottom} in CSS px: the line fades out under these
  const FEATHER = 24;

  /** 0 inside a mask rectangle, 1 beyond FEATHER px from all of them. */
  function maskAt(x, y) {
    let k = 1;
    for (const r of masks) {
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < FEATHER) {
        const t = d / FEATHER;
        k = Math.min(k, t * t * (3 - 2 * t));
      }
    }
    return k;
  }
  const clip = []; // per point clip-space x, y, z, w
  const m = new THREE.Matrix4();
  const v = new THREE.Vector4();

  /** points: world-space xyz triples; weights: alpha per point (segment uses its start). */
  function setPoints(xyz, w, n) {
    points = xyz;
    weights = w;
    count = Math.min(n, maxPoints);
  }

  /** Rebuild the strip for this camera. width/height in CSS px. */
  function update(camera, width, height) {
    const half = widthPx / 2;
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (let i = 0; i < count; i++) {
      v.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], 1).applyMatrix4(m);
      clip[i] = [v.x, v.y, v.z, v.w];
    }
    const near = 1e-4;
    let n = 0;
    const put = (x, y, z, a) => {
      pos[n * 3] = x;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = z;
      alpha[n] = a;
      n += 1;
    };
    const lerp4 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    for (let i = 0; i + 1 < count && n + 6 <= maxVerts; i++) {
      let a = clip[i];
      let b = clip[i + 1];
      // keep the part in front of the camera (w > near)
      if (a[3] <= near && b[3] <= near) continue;
      if (a[3] <= near) a = lerp4(a, b, (near - a[3]) / (b[3] - a[3]));
      else if (b[3] <= near) b = lerp4(a, b, (near - a[3]) / (b[3] - a[3]));
      const ax = a[0] / a[3], ay = a[1] / a[3], az = a[2] / a[3];
      const bx = b[0] / b[3], by = b[1] / b[3], bz = b[2] / b[3];
      // direction in pixels, normal back in NDC
      const dx = (bx - ax) * width;
      const dy = (by - ay) * height;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * (half * 2) / width;
      const ny = (dx / len) * (half * 2) / height;
      // clamp depth so segments reaching past the far plane still draw
      const za = Math.min(az, 0.9999), zb = Math.min(bz, 0.9999);
      let wa = weights[i];
      let wb = weights[i];
      if (masks.length) {
        wa *= maskAt((ax + 1) * 0.5 * width, (1 - ay) * 0.5 * height);
        wb *= maskAt((bx + 1) * 0.5 * width, (1 - by) * 0.5 * height);
        if (wa < 0.002 && wb < 0.002) continue;
      }
      put(ax - nx, ay - ny, za, wa); put(ax + nx, ay + ny, za, wa); put(bx + nx, by + ny, zb, wb);
      put(ax - nx, ay - ny, za, wa); put(bx + nx, by + ny, zb, wb); put(bx - nx, by - ny, zb, wb);
    }
    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.alpha.needsUpdate = true;
  }

  return {
    mesh,
    setPoints,
    update,
    /** Rectangles (CSS px, the canvas's own coordinates) the line must not cross, e.g. text. */
    setMasks(list) {
      masks = Array.isArray(list) ? list : [];
    },
    setOpacity(o) {
      material.uniforms.opacity.value = o;
      mesh.visible = o > 0.001;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
