/**
 * A polyline drawn a fixed number of CSS pixels wide (WebGL lines are
 * always 1px), for the orbit. Each frame the points are projected on the
 * CPU, cut where they pass behind the camera, and widened in screen space;
 * the vertex shader only receives normalised device coordinates, so depth
 * still works and the Earth hides the far side of the orbit.
 *
 * Keep-out boxes (the text column): the line is fully transparent within
 * `gap` px of a box and fades in over the next `feather` px, so it ends a
 * clear distance short of the words and never crosses them. Segments that
 * come near a box are cut into short pieces first, so a long segment can't
 * jump across a corner between two sample points.
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

/** Longest piece (CSS px) a segment is cut into near a keep-out box. */
const PIECE_PX = 8;

/**
 * @param {number} maxPoints  most points setPoints will be given
 * @param {{color?: string, widthPx?: number}} [opts]
 */
export function createScreenLine(maxPoints, { color = '#3C9DF5', widthPx = 2 } = {}) {
  const maxVerts = Math.max(maxPoints * 6, 36000);
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
  let boxes = []; // {left, top, right, bottom} in CSS px: the line keeps out of these
  let gap = 48;
  let feather = 32;
  let nearest = Infinity; // closest drawn point to a box last frame, px

  /** Distance (px) from a point to the nearest box, 0 inside one. */
  function distanceToBoxes(x, y) {
    let d = Infinity;
    for (const r of boxes) {
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      d = Math.min(d, Math.hypot(dx, dy));
    }
    return d;
  }

  /** 0 within `gap` of a box, rising smoothly to 1 at gap + feather. */
  function keepOut(x, y) {
    const d = distanceToBoxes(x, y);
    if (d >= gap + feather) return 1;
    if (d <= gap) return 0;
    const t = (d - gap) / feather;
    return t * t * (3 - 2 * t);
  }

  /** Could any part of the segment come within gap + feather of a box? */
  function nearBoxes(x0, y0, x1, y1) {
    const reach = gap + feather;
    const left = Math.min(x0, x1) - reach;
    const right = Math.max(x0, x1) + reach;
    const top = Math.min(y0, y1) - reach;
    const bottom = Math.max(y0, y1) + reach;
    return boxes.some((r) => r.left < right && r.right > left && r.top < bottom && r.bottom > top);
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
    nearest = Infinity;
    const put = (x, y, z, a) => {
      pos[n * 3] = x;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = z;
      alpha[n] = a;
      n += 1;
    };
    const toPx = (x, y) => [(x + 1) * 0.5 * width, (1 - y) * 0.5 * height];
    const lerp4 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    for (let i = 0; i + 1 < count && n + 6 <= maxVerts; i++) {
      let a = clip[i];
      let b = clip[i + 1];
      // keep the part in front of the camera (w > near)
      if (a[3] <= near && b[3] <= near) continue;
      if (a[3] <= near) a = lerp4(a, b, (near - a[3]) / (b[3] - a[3]));
      else if (b[3] <= near) b = lerp4(a, b, (near - a[3]) / (b[3] - a[3]));
      const ax = a[0] / a[3], ay = a[1] / a[3], az = Math.min(a[2] / a[3], 0.9999);
      const bx = b[0] / b[3], by = b[1] / b[3], bz = Math.min(b[2] / b[3], 0.9999);
      // direction in pixels, normal back in NDC
      const dx = (bx - ax) * width;
      const dy = (by - ay) * height;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * (half * 2) / width;
      const ny = (dx / len) * (half * 2) / height;
      const w = weights[i];
      const [pax, pay] = toPx(ax, ay);
      const [pbx, pby] = toPx(bx, by);
      // near the text: short pieces, each end faded by its distance from the boxes
      const pieces = boxes.length && nearBoxes(pax, pay, pbx, pby) ? Math.max(1, Math.ceil(len / 2 / PIECE_PX)) : 1;
      let x0 = ax, y0 = ay, z0 = az;
      let k0 = pieces > 1 || boxes.length ? keepOut(pax, pay) : 1;
      for (let s = 1; s <= pieces && n + 6 <= maxVerts; s++) {
        const t = s / pieces;
        const x1 = ax + (bx - ax) * t;
        const y1 = ay + (by - ay) * t;
        const z1 = az + (bz - az) * t;
        const [px1, py1] = pieces > 1 ? toPx(x1, y1) : [pbx, pby];
        const k1 = boxes.length ? keepOut(px1, py1) : 1;
        if (k0 > 0.002 || k1 > 0.002) {
          const wa = w * k0;
          const wb = w * k1;
          put(x0 - nx, y0 - ny, z0, wa); put(x0 + nx, y0 + ny, z0, wa); put(x1 + nx, y1 + ny, z1, wb);
          put(x0 - nx, y0 - ny, z0, wa); put(x1 + nx, y1 + ny, z1, wb); put(x1 - nx, y1 - ny, z1, wb);
          if (boxes.length) {
            if (k1 > 0.002) nearest = Math.min(nearest, distanceToBoxes(px1, py1));
            if (k0 > 0.002) nearest = Math.min(nearest, distanceToBoxes(...toPx(x0, y0)));
          }
        }
        x0 = x1;
        y0 = y1;
        z0 = z1;
        k0 = k1;
      }
    }
    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.alpha.needsUpdate = true;
  }

  return {
    mesh,
    setPoints,
    update,
    /**
     * Boxes (CSS px, the canvas's own coordinates) the line keeps out of:
     * transparent within `gap` px, fading in over the next `feather` px.
     */
    setKeepOut(list, opts = {}) {
      boxes = Array.isArray(list) ? list : [];
      if (Number.isFinite(opts.gap)) gap = opts.gap;
      if (Number.isFinite(opts.feather)) feather = opts.feather;
    },
    /** Closest any drawn part of the line came to a box in the last update, px (Infinity when none). */
    get nearestPx() {
      return nearest;
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
