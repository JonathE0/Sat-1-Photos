/**
 * The three.js side of the globe: Earth, atmosphere, markers, tracks,
 * labels and the camera controls. It draws whatever state globe.js hands
 * it and knows nothing about the clock, the data files or the panels.
 *
 * Scene frame: three.js is y-up, so ECI/ECEF (x, y, z) is drawn at
 * (x, z, -y). The north pole is +y and three's default sphere UVs then
 * line up with an equirectangular map in ECEF. One unit is the mean Earth
 * radius. `earth` turns by GMST; the satellite and its orbit live in the
 * (non-rotating) inertial frame.
 */
import * as THREE from './vendor/three.module.min.js';
import { DEG, EARTH_RADIUS_KM } from './astro.js';
import { createAurora } from './aurora.js';
import { labelBox, placeLabel } from './labels.js';
import { RIPPLE_COLOR, RIPPLE_GAP_S, RIPPLE_RADIUS_PX, RIPPLE_S, RIPPLE_STRENGTH, RIPPLE_WAVES, RIPPLE_WAVE_S } from './ripple.js';

const BLUE = '#3C9DF5'; // the satellite and its path, nothing else
const INK = '#E6EBF0';
const MUTED = '#8A96A3';
const BACKGROUND = '#05070A';

const SURFACE = 1.0015; // ground track, coverage circle
const PIN_RADIUS = 1.004;
const MIN_DISTANCE = 1.22;
const MAX_DISTANCE = 9;
/** Camera distance that shows the whole globe with room around it. */
export const DEFAULT_DISTANCE = 4.6;

/** Scene position of a geodetic point `radius` units from the centre. */
export function geoToScene(latDeg, lonDeg, radius = 1, out = new THREE.Vector3()) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  return out.set(radius * c * Math.cos(lon), radius * Math.sin(lat), -radius * c * Math.sin(lon));
}

/** Rotate a scene vector about the polar axis (what earth.rotation.y does). */
function spin(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return v.set(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

const EARTH_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocalNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vLocalNormal = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const EARTH_FS = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform float texturesReady;
  uniform vec3 sunLocal;   // unit vector to the Sun, Earth-fixed
  uniform vec3 sunWorld;   // the same in the scene frame
  varying vec2 vUv;
  varying vec3 vLocalNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 n = normalize(vLocalNormal);
    float mu = dot(n, sunLocal);                 // cosine of the solar zenith angle
    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    if (texturesReady < 0.5) {
      day = vec3(0.035, 0.055, 0.075);
      night = vec3(0.006, 0.009, 0.013);
    }
    // Daylight dims toward the terminator; the night map takes over across
    // civil twilight (Sun 0 to 6 degrees below the horizon).
    float lit = mix(0.22, 1.0, smoothstep(0.0, 0.55, mu));
    float dayWeight = smoothstep(-0.105, 0.035, mu);
    vec3 lights = night * (0.55 + 2.4 * smoothstep(0.02, 0.35, max(night.r, max(night.g, night.b))));
    vec3 color = mix(lights, day * lit, dayWeight);

    // a thin, faint haze along the sunlit limb
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float rim = pow(1.0 - clamp(dot(normalize(vWorldNormal), viewDir), 0.0, 1.0), 4.0);
    float rimLight = smoothstep(-0.2, 0.45, dot(normalize(vWorldNormal), sunWorld));
    color += vec3(0.20, 0.34, 0.62) * rim * rimLight * 0.42;

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const ATMOSPHERE_VS = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ATMOSPHERE_FS = /* glsl */ `
  uniform vec3 sunWorld;
  uniform float shell;
  varying vec3 vWorldPos;
  void main() {
    vec3 rd = normalize(vWorldPos - cameraPosition);
    vec3 closest = cameraPosition - dot(cameraPosition, rd) * rd;   // nearest point to the centre
    float h = (length(closest) - 1.0) / (shell - 1.0);
    float a = pow(clamp(1.0 - h, 0.0, 1.0), 3.5);
    float lit = smoothstep(-0.25, 0.4, dot(normalize(closest), sunWorld));
    gl_FragColor = vec4(vec3(0.16, 0.27, 0.48) * a * (0.12 + 0.88 * lit), 1.0);
    #include <colorspace_fragment>
  }
`;

// Constant-size point markers. Anything the Earth hides is dropped in the
// vertex shader, so markers never get half-clipped at the limb.
const MARKER_VS = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vSize;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 d = world.xyz - cameraPosition;
    float len = length(d);
    d /= len;
    float b = dot(cameraPosition, d);
    float h = b * b - (dot(cameraPosition, cameraPosition) - 0.999);
    bool hidden = h > 0.0 && (-b - sqrt(h)) > 0.0 && (-b - sqrt(h)) < len;
    vColor = aColor;
    vSize = aSize * pixelRatio;
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_PointSize = hidden ? 0.0 : vSize;
  }
`;

const MARKER_FS = /* glsl */ `
  uniform int shape;      // 0 disc, 1 square, 2 diamond, 3 sun
  uniform vec3 outline;
  varying vec3 vColor;
  varying float vSize;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float px = 2.0 / vSize;
    float d = shape == 1 ? max(abs(p.x), abs(p.y))
            : shape == 2 ? (abs(p.x) + abs(p.y))
            : length(p);
    float edge = 1.0 - 0.5 * px;
    float cover = 1.0 - smoothstep(edge - px, edge, d);
    if (cover <= 0.0) discard;
    vec3 color;
    float alpha;
    if (shape == 3) {
      float ring = 1.0 - smoothstep(0.6 * px, 1.6 * px, abs(d - 0.66));
      float core = 1.0 - smoothstep(0.26 - px, 0.26, d);
      float ink = max(ring, core);
      color = mix(outline, vColor, ink);
      alpha = max(ink, 0.5 * cover);
    } else {
      float inner = edge - 1.5 * px;   // 1.5 px dark outline
      color = mix(vColor, outline, smoothstep(inner - px, inner, d));
      alpha = cover;
    }
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

// The red waves from the picture pins (ripple.js), hidden behind the Earth like the pins.
const RIPPLE_VS = /* glsl */ `
  uniform float pixelRatio;
  uniform float size;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 d = world.xyz - cameraPosition;
    float len = length(d);
    d /= len;
    float b = dot(cameraPosition, d);
    float h = b * b - (dot(cameraPosition, cameraPosition) - 0.999);
    bool hidden = h > 0.0 && (-b - sqrt(h)) > 0.0 && (-b - sqrt(h)) < len;
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_PointSize = hidden ? 0.0 : size * pixelRatio;
  }
`;

const RIPPLE_FS = /* glsl */ `
  uniform vec3 color;
  uniform float seconds;
  void main() {
    float r = length(gl_PointCoord * 2.0 - 1.0);
    if (r >= 1.0) discard;
    float a = 0.0;
    for (int i = 0; i < ${RIPPLE_WAVES}; i++) {
      float w = (seconds - float(i) * ${RIPPLE_GAP_S.toFixed(3)}) / ${RIPPLE_WAVE_S.toFixed(3)};
      if (w < 0.0 || w > 1.0) continue;
      float radius = 0.06 + 0.84 * (1.0 - (1.0 - w) * (1.0 - w));
      float ring = (r - radius) / 0.11;
      a += exp(-ring * ring) * smoothstep(0.0, 0.18, w) * (1.0 - w) * (1.0 - w);
    }
    gl_FragColor = vec4(color, min(a, 1.0) * ${RIPPLE_STRENGTH.toFixed(3)});
    #include <colorspace_fragment>
  }
`;

const TRACK_VS = /* glsl */ `
  attribute float fade;
  varying float vFade;
  void main() {
    vFade = fade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRACK_FS = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(color, opacity * vFade);
    #include <colorspace_fragment>
  }
`;

const SHAPES = { disc: 0, square: 1, diamond: 2, sun: 3 };

/** Camera that orbits the globe's centre: drag to turn, wheel or pinch to
 * zoom, with optional inertia and animated moves. */
class GlobeControls {
  constructor(camera, element, { reducedMotion = false, wheelZoom = true, onUserMove = () => {} } = {}) {
    this.camera = camera;
    this.element = element;
    this.reducedMotion = reducedMotion;
    this.wheelZoom = wheelZoom;
    this.onUserMove = onUserMove;
    this.theta = 0; // azimuth about +y
    this.phi = Math.PI / 2; // polar angle from +y
    this.distance = DEFAULT_DISTANCE;
    this.velocity = { theta: 0, phi: 0 };
    this.pointers = new Map();
    this.flight = null;
    this.changed = true;
    this.dragged = false;

    this._down = (e) => this.onPointerDown(e);
    this._move = (e) => this.onPointerMove(e);
    this._up = (e) => this.onPointerUp(e);
    this._wheel = (e) => this.onWheel(e);
    element.addEventListener('pointerdown', this._down);
    element.addEventListener('pointermove', this._move);
    element.addEventListener('pointerup', this._up);
    element.addEventListener('pointercancel', this._up);
    element.addEventListener('wheel', this._wheel, { passive: false });
  }

  dispose() {
    const el = this.element;
    el.removeEventListener('pointerdown', this._down);
    el.removeEventListener('pointermove', this._move);
    el.removeEventListener('pointerup', this._up);
    el.removeEventListener('pointercancel', this._up);
    el.removeEventListener('wheel', this._wheel);
  }

  /** Radians of turn per pixel of drag: slower when zoomed in. */
  get turnPerPixel() {
    const h = this.element.clientHeight || 600;
    const fov = this.camera.fov * DEG;
    return (2 * Math.tan(fov / 2) * Math.max(0.12, this.distance - 0.92)) / h;
  }

  onPointerDown(e) {
    if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') return;
    this.element.setPointerCapture?.(e.pointerId);
    // a second finger makes this a gesture, never a tap
    this.dragged = this.pointers.size > 0;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    this.velocity.theta = 0;
    this.velocity.phi = 0;
    this.flight = null;
    this.pinch = null;
  }

  onPointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > 4) this.dragged = true;
    if (this.pointers.size === 1) {
      this.rotate(dx, dy);
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch && span > 0) {
        this.setDistance(this.distance * (this.pinch / span));
        this.rotate(dx / 2, dy / 2);
      }
      this.pinch = span;
    }
  }

  onPointerUp(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    this.element.releasePointerCapture?.(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    // a drag that came to rest before release shouldn't keep spinning
    if (this.pointers.size > 0 || performance.now() - (this.lastMove || 0) > 80) {
      this.velocity.theta = 0;
      this.velocity.phi = 0;
    }
  }

  onWheel(e) {
    if (!this.wheelZoom && !e.ctrlKey) return;
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.flight = null;
    this.setDistance(this.distance * Math.exp(e.deltaY * lines * 0.0012));
    this.onUserMove('zoom');
  }

  rotate(dx, dy) {
    const k = this.turnPerPixel;
    const dTheta = -dx * k;
    const dPhi = -dy * k;
    this.theta += dTheta;
    this.phi = THREE.MathUtils.clamp(this.phi + dPhi, 0.06, Math.PI - 0.06);
    if (!this.reducedMotion) {
      this.velocity.theta = dTheta;
      this.velocity.phi = dPhi;
    }
    this.lastMove = performance.now();
    this.flight = null;
    this.changed = true;
    this.onUserMove('rotate');
  }

  setDistance(d) {
    this.distance = THREE.MathUtils.clamp(d, MIN_DISTANCE, MAX_DISTANCE);
    this.changed = true;
  }

  /** Point the camera along a scene direction, animated unless reduced motion. */
  flyTo(direction, distance = this.distance, { immediate = false } = {}) {
    const dir = direction.clone().normalize();
    const target = {
      theta: Math.atan2(dir.x, dir.z),
      phi: THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)), 0.06, Math.PI - 0.06),
      distance: THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE),
    };
    let dTheta = target.theta - this.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.velocity.theta = 0;
    this.velocity.phi = 0;
    if (immediate || this.reducedMotion) {
      this.theta += dTheta;
      this.phi = target.phi;
      this.distance = target.distance;
      this.flight = null;
      this.changed = true;
      return;
    }
    this.flight = {
      from: { theta: this.theta, phi: this.phi, distance: this.distance },
      to: { theta: this.theta + dTheta, phi: target.phi, distance: target.distance },
      start: performance.now(),
      duration: 1100,
    };
  }

  /** Ease toward a direction a little each frame (follow mode). */
  track(direction, amount = 0.12) {
    const dir = direction.clone().normalize();
    const theta = Math.atan2(dir.x, dir.z);
    const phi = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)), 0.06, Math.PI - 0.06);
    const dTheta = Math.atan2(Math.sin(theta - this.theta), Math.cos(theta - this.theta));
    const k = this.reducedMotion ? 1 : amount;
    // ignore sub-pixel drift so following at 1x doesn't redraw every frame
    if (Math.abs(dTheta) + Math.abs(phi - this.phi) < 5e-4) return;
    this.theta += dTheta * k;
    this.phi += (phi - this.phi) * k;
    this.changed = true;
  }

  get busy() {
    return (
      this.flight !== null ||
      this.pointers.size > 0 ||
      Math.abs(this.velocity.theta) + Math.abs(this.velocity.phi) > 1e-5
    );
  }

  /** Advance animation and place the camera; returns true if it moved. */
  update(now) {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.start) / f.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.theta = f.from.theta + (f.to.theta - f.from.theta) * e;
      this.phi = f.from.phi + (f.to.phi - f.from.phi) * e;
      this.distance = f.from.distance + (f.to.distance - f.from.distance) * e;
      if (t >= 1) this.flight = null;
      this.changed = true;
    } else if (this.pointers.size === 0 && (this.velocity.theta || this.velocity.phi)) {
      this.theta += this.velocity.theta;
      this.phi = THREE.MathUtils.clamp(this.phi + this.velocity.phi, 0.06, Math.PI - 0.06);
      this.velocity.theta *= 0.9;
      this.velocity.phi *= 0.9;
      if (Math.abs(this.velocity.theta) + Math.abs(this.velocity.phi) < 1e-5) {
        this.velocity.theta = 0;
        this.velocity.phi = 0;
      }
      this.changed = true;
    }
    if (!this.changed) return false;
    const s = Math.sin(this.phi);
    this.camera.position.set(
      this.distance * s * Math.sin(this.theta),
      this.distance * Math.cos(this.phi),
      this.distance * s * Math.cos(this.theta),
    );
    this.camera.lookAt(0, 0, 0);
    this.changed = false;
    return true;
  }
}

function trackGeometry(count) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('fade', new THREE.BufferAttribute(new Float32Array(count), 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

function markerGeometry(count) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(Math.max(1, count)), 1));
  return geometry;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} labelLayer element the HTML labels are placed in
 * @param {object} opts
 */
export function createScene(canvas, labelLayer, opts = {}) {
  const {
    textureBase,
    preferSmallTextures = false,
    reducedMotion = false,
    wheelZoom = true,
    onUserMove = () => {},
    aurora: withAurora = false,
    auroraStill = false,
    auroraOn = true,
    onAurora = () => {},
  } = opts;
  let disposed = false;
  let needsRender = true;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BACKGROUND, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const controls = new GlobeControls(camera, canvas, { reducedMotion, wheelZoom, onUserMove });

  const disposables = [];
  const keep = (x) => {
    disposables.push(x);
    return x;
  };

  // ---- Earth -------------------------------------------------------------
  const earth = new THREE.Group();
  scene.add(earth);

  const sunWorld = new THREE.Vector3(1, 0, 0);
  const sunLocal = new THREE.Vector3(1, 0, 0);
  const earthUniforms = {
    dayMap: { value: null },
    nightMap: { value: null },
    texturesReady: { value: 0 },
    sunLocal: { value: sunLocal },
    sunWorld: { value: sunWorld },
  };
  const earthMesh = new THREE.Mesh(
    keep(new THREE.SphereGeometry(1, 160, 80)),
    keep(new THREE.ShaderMaterial({ uniforms: earthUniforms, vertexShader: EARTH_VS, fragmentShader: EARTH_FS })),
  );
  earth.add(earthMesh);

  const atmosphereShell = 1.022;
  const atmosphere = new THREE.Mesh(
    keep(new THREE.SphereGeometry(atmosphereShell, 96, 48)),
    keep(
      new THREE.ShaderMaterial({
        uniforms: { sunWorld: { value: sunWorld }, shell: { value: atmosphereShell } },
        vertexShader: ATMOSPHERE_VS,
        fragmentShader: ATMOSPHERE_FS,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    ),
  );
  atmosphere.renderOrder = 1;
  scene.add(atmosphere);

  // Textures: 4096-wide unless the device or the view is small.
  const big = !preferSmallTextures && renderer.capabilities.maxTextureSize >= 4096;
  const size = big ? 4096 : 2048;
  const loader = new THREE.TextureLoader();
  let texturesLoaded = 0;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const loadTexture = (name, uniform) => {
    loader.load(
      new URL(`${name}-${size}.jpg`, textureBase).href,
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = anisotropy;
        keep(tex);
        earthUniforms[uniform].value = tex;
        texturesLoaded += 1;
        if (texturesLoaded === 2) earthUniforms.texturesReady.value = 1;
        needsRender = true;
      },
      undefined,
      () => {
        console.warn(`Globe: could not load ${name} texture`);
      },
    );
  };
  loadTexture('earth-day', 'dayMap');
  loadTexture('earth-night', 'nightMap');

  // ---- aurora (aurora.js) -------------------------------------------------
  let aurora = null;
  let lastAurora = 0;
  if (withAurora) {
    try {
      aurora = createAurora({
        quality: big ? 'low' : 'phone',
        still: auroraStill,
        onStatus(status) {
          needsRender = true;
          onAurora(status);
        },
      });
      aurora.setOn(auroraOn);
      earth.add(aurora.object);
    } catch (err) {
      console.warn('Globe: no aurora', err); // decoration on top of the data: the globe goes on without it
    }
  }

  // ---- materials ----------------------------------------------------------
  const outline = new THREE.Color(BACKGROUND);
  const markerMaterial = (shape) =>
    keep(
      new THREE.ShaderMaterial({
        uniforms: {
          pixelRatio: { value: renderer.getPixelRatio() },
          shape: { value: SHAPES[shape] },
          outline: { value: outline },
        },
        vertexShader: MARKER_VS,
        fragmentShader: MARKER_FS,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
  const trackMaterial = (color, opacity) =>
    keep(
      new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: opacity } },
        vertexShader: TRACK_VS,
        fragmentShader: TRACK_FS,
        transparent: true,
        depthWrite: false,
      }),
    );

  const makeMarker = (shape, color, sizePx, parent) => {
    const geometry = keep(markerGeometry(1));
    const points = new THREE.Points(geometry, markerMaterial(shape));
    const c = new THREE.Color(color);
    geometry.attributes.aColor.array.set([c.r, c.g, c.b]);
    geometry.attributes.aSize.array[0] = sizePx;
    points.frustumCulled = false;
    points.renderOrder = 4;
    points.visible = false;
    parent.add(points);
    return {
      points,
      position: new THREE.Vector3(),
      set(v) {
        this.position.copy(v);
        geometry.attributes.position.array.set([v.x, v.y, v.z]);
        geometry.attributes.position.needsUpdate = true;
        points.visible = true;
      },
      hide() {
        points.visible = false;
      },
    };
  };

  // ---- satellite, orbit and ground track ---------------------------------
  const MAX_TRACK = 1024;
  const orbitLine = new THREE.Line(keep(trackGeometry(MAX_TRACK)), trackMaterial(BLUE, 1));
  orbitLine.frustumCulled = false;
  orbitLine.renderOrder = 2;
  scene.add(orbitLine);

  const groundLine = new THREE.Line(keep(trackGeometry(MAX_TRACK)), trackMaterial(BLUE, 0.55));
  groundLine.frustumCulled = false;
  groundLine.renderOrder = 2;
  earth.add(groundLine);

  const nadirLine = new THREE.Line(keep(trackGeometry(2)), trackMaterial(BLUE, 0.4));
  nadirLine.frustumCulled = false;
  nadirLine.renderOrder = 2;
  nadirLine.geometry.attributes.fade.array.set([1, 1]);
  nadirLine.geometry.setDrawRange(0, 2);
  earth.add(nadirLine);

  const COVERAGE_SEGMENTS = 128;
  const coverageLine = new THREE.LineLoop(keep(trackGeometry(COVERAGE_SEGMENTS)), trackMaterial(BLUE, 0.5));
  coverageLine.geometry.attributes.fade.array.fill(1);
  coverageLine.geometry.setDrawRange(0, COVERAGE_SEGMENTS);
  coverageLine.frustumCulled = false;
  coverageLine.renderOrder = 2;
  coverageLine.visible = false;
  earth.add(coverageLine);

  const linkLine = new THREE.Line(keep(trackGeometry(2)), trackMaterial(INK, 0.3));
  linkLine.geometry.attributes.fade.array.set([1, 1]);
  linkLine.geometry.setDrawRange(0, 2);
  linkLine.frustumCulled = false;
  linkLine.renderOrder = 2;
  linkLine.visible = false;
  earth.add(linkLine);

  const satellite = makeMarker('disc', BLUE, 11, scene);
  const station = makeMarker('diamond', INK, 10, earth);
  const subsolar = makeMarker('sun', '#E9E4D4', 13, earth);

  // ---- photo pins ----------------------------------------------------------
  let pins = { points: null, ripple: null, ids: [], positions: [], geometry: null };
  let selectedId = null;
  let hoverId = null;
  const pinColor = new THREE.Color(MUTED);
  const pinSelected = new THREE.Color(INK);
  const pinMaterial = markerMaterial('square');
  const rippleMaterial = keep(
    new THREE.ShaderMaterial({
      uniforms: {
        pixelRatio: { value: renderer.getPixelRatio() },
        size: { value: RIPPLE_RADIUS_PX * 2 },
        color: { value: new THREE.Color(RIPPLE_COLOR) },
        seconds: { value: 0 },
      },
      vertexShader: RIPPLE_VS,
      fragmentShader: RIPPLE_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  let rippleStart = null;

  function highlightPins() {
    rippleStart = performance.now();
    if (pins.ripple) pins.ripple.visible = true;
    needsRender = true;
  }

  function paintPins() {
    if (!pins.geometry) return;
    const colors = pins.geometry.attributes.aColor.array;
    const sizes = pins.geometry.attributes.aSize.array;
    pins.ids.forEach((id, i) => {
      const c = id === selectedId || id === hoverId ? pinSelected : pinColor;
      colors.set([c.r, c.g, c.b], i * 3);
      sizes[i] = id === selectedId ? 12 : id === hoverId ? 10 : 8;
    });
    pins.geometry.attributes.aColor.needsUpdate = true;
    pins.geometry.attributes.aSize.needsUpdate = true;
    needsRender = true;
  }

  function setPins(list) {
    if (pins.points) {
      earth.remove(pins.points, pins.ripple);
      pins.geometry.dispose();
    }
    pins = { points: null, ripple: null, ids: [], positions: [], geometry: null };
    if (!list.length) {
      needsRender = true;
      return;
    }
    const geometry = markerGeometry(list.length);
    const pos = geometry.attributes.position.array;
    list.forEach((p, i) => {
      const v = geoToScene(p.latDeg, p.lonDeg, PIN_RADIUS);
      pos.set([v.x, v.y, v.z], i * 3);
      pins.ids.push(p.id);
      pins.positions.push(v);
    });
    const points = new THREE.Points(geometry, pinMaterial);
    points.frustumCulled = false;
    points.renderOrder = 3;
    const ripple = new THREE.Points(geometry, rippleMaterial);
    ripple.frustumCulled = false;
    ripple.renderOrder = 2.5; // under the pins
    ripple.visible = rippleStart !== null;
    earth.add(ripple, points);
    pins.points = points;
    pins.ripple = ripple;
    pins.geometry = geometry;
    paintPins();
  }

  // ---- labels ----------------------------------------------------------------
  const labels = [];
  function addLabel(text, className, getPosition) {
    const el = document.createElement('div');
    el.className = `cg-label ${className}`;
    el.textContent = text;
    el.hidden = true;
    labelLayer.appendChild(el);
    const label = { el, getPosition, visible: false, x: 0, y: 0 };
    labels.push(label);
    return label;
  }
  const worldPos = new THREE.Vector3();
  const satLabel = addLabel('CTS-SAT-1', 'cg-label-sat', () =>
    satellite.points.visible ? worldPos.copy(satellite.position) : null,
  );
  const gsLabel = addLabel('Calgary', 'cg-label-gs', () =>
    station.points.visible ? station.points.localToWorld(worldPos.copy(station.position)) : null,
  );
  let gsSide = 'right'; // where Calgary's label is: see updateLabels
  let markerScale = 1;
  // measured again once the page's font has arrived
  document.fonts?.ready?.then(() => {
    for (const l of labels) l.w = 0;
    needsRender = true;
  });

  // ---- geometry helpers -----------------------------------------------------
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const pinPoint = new THREE.Vector3();

  /** Is a world point hidden behind the Earth from the camera? */
  function occluded(p) {
    const cam = camera.position;
    tmp2.subVectors(p, cam);
    const len = tmp2.length();
    tmp2.divideScalar(len);
    const b = cam.dot(tmp2);
    const h = b * b - (cam.lengthSq() - 0.999);
    if (h <= 0) return false;
    const t = -b - Math.sqrt(h);
    return t > 0 && t < len;
  }

  /** Screen position (CSS px) of a world point, or null if hidden. */
  function toScreen(p) {
    if (occluded(p)) return null;
    tmp.copy(p).project(camera);
    if (tmp.z > 1) return null;
    return {
      x: (tmp.x * 0.5 + 0.5) * width,
      y: (-tmp.y * 0.5 + 0.5) * height,
    };
  }

  let width = 1;
  let height = 1;

  // ---- per-frame state ------------------------------------------------------
  let gmstNow = 0;
  let timeNow = Date.now();
  let sunNow = { x: 1, y: 0, z: 0 };

  function setSun(sunEci, gmstAngle) {
    // unit vector toward the Sun: scene frame, then Earth-fixed
    sunWorld.set(sunEci.x, sunEci.z, -sunEci.y).normalize();
    sunLocal.copy(sunWorld);
    spin(sunLocal, -gmstAngle);
  }

  function setTime(gmstAngle, sunEci, ms = timeNow) {
    gmstNow = gmstAngle;
    timeNow = ms;
    sunNow = sunEci;
    earth.rotation.y = gmstAngle;
    setSun(sunEci, gmstAngle);
    needsRender = true;
  }

  /**
   * samples: [{ latDeg, lonDeg, altKm, gmst, dtMin }] over about one orbit
   * either side of now (dtMin < 0 is the past).
   */
  function setTrack(samples, periodMin) {
    const n = Math.min(samples.length, MAX_TRACK);
    const orbitPos = orbitLine.geometry.attributes.position.array;
    const orbitFade = orbitLine.geometry.attributes.fade.array;
    const groundPos = groundLine.geometry.attributes.position.array;
    const groundFade = groundLine.geometry.attributes.fade.array;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const x = Math.min(1, Math.abs(s.dtMin) / periodMin);
      const fade = s.dtMin >= 0 ? 1 - 0.75 * x : 0.42 * (1 - 0.85 * x);
      geoToScene(s.latDeg, s.lonDeg, 1 + s.altKm / EARTH_RADIUS_KM, tmp);
      spin(tmp, s.gmst);
      orbitPos[i * 3] = tmp.x;
      orbitPos[i * 3 + 1] = tmp.y;
      orbitPos[i * 3 + 2] = tmp.z;
      orbitFade[i] = fade;
      geoToScene(s.latDeg, s.lonDeg, SURFACE, tmp);
      groundPos[i * 3] = tmp.x;
      groundPos[i * 3 + 1] = tmp.y;
      groundPos[i * 3 + 2] = tmp.z;
      groundFade[i] = fade;
    }
    for (const line of [orbitLine, groundLine]) {
      line.geometry.setDrawRange(0, n);
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.attributes.fade.needsUpdate = true;
      line.visible = n > 1;
    }
    needsRender = true;
  }

  /** sat: { latDeg, lonDeg, altKm } now, or null to hide it. */
  function setSatellite(sat) {
    if (!sat) {
      satellite.hide();
      nadirLine.visible = false;
      orbitLine.visible = false;
      groundLine.visible = false;
      needsRender = true;
      return;
    }
    const r = 1 + sat.altKm / EARTH_RADIUS_KM;
    geoToScene(sat.latDeg, sat.lonDeg, r, tmp);
    const nadirPos = nadirLine.geometry.attributes.position.array;
    nadirPos.set([tmp.x, tmp.y, tmp.z]);
    geoToScene(sat.latDeg, sat.lonDeg, SURFACE, tmp2);
    nadirPos.set([tmp2.x, tmp2.y, tmp2.z], 3);
    nadirLine.geometry.attributes.position.needsUpdate = true;
    nadirLine.visible = true;
    satellite.set(spin(tmp, gmstNow));
    needsRender = true;
  }

  function setStation(latDeg, lonDeg) {
    station.set(geoToScene(latDeg, lonDeg, PIN_RADIUS, tmp));
  }

  /** The orbit's colour (the team blue unless a visitor picks another):
   * the orbit line, ground track, nadir line, footprint and satellite. */
  function setTrackColor(color) {
    const c = new THREE.Color(color);
    for (const line of [orbitLine, groundLine, nadirLine, coverageLine]) line.material.uniforms.color.value.copy(c);
    const sat = satellite.points.geometry.attributes.aColor;
    sat.array.set([c.r, c.g, c.b]);
    sat.needsUpdate = true;
    needsRender = true;
  }

  function setSubsolar(latDeg, lonDeg) {
    subsolar.set(geoToScene(latDeg, lonDeg, PIN_RADIUS, tmp));
  }

  /** Footprint circle around the sub-satellite point (angle in radians),
   * plus the line from the ground station; null hides both. */
  function setCoverage(cov) {
    if (!cov) {
      coverageLine.visible = false;
      linkLine.visible = false;
      needsRender = true;
      return;
    }
    const centre = geoToScene(cov.latDeg, cov.lonDeg, 1, new THREE.Vector3());
    const east = new THREE.Vector3(0, 1, 0).cross(centre);
    if (east.lengthSq() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = centre.clone().cross(east).normalize();
    const pos = coverageLine.geometry.attributes.position.array;
    const ca = Math.cos(cov.angle);
    const sa = Math.sin(cov.angle);
    for (let i = 0; i < COVERAGE_SEGMENTS; i++) {
      const b = (i / COVERAGE_SEGMENTS) * Math.PI * 2;
      tmp.copy(centre).multiplyScalar(ca)
        .addScaledVector(east, sa * Math.cos(b))
        .addScaledVector(north, sa * Math.sin(b))
        .multiplyScalar(SURFACE);
      pos.set([tmp.x, tmp.y, tmp.z], i * 3);
    }
    coverageLine.geometry.attributes.position.needsUpdate = true;
    coverageLine.visible = true;

    const link = linkLine.geometry.attributes.position.array;
    link.set([station.position.x, station.position.y, station.position.z]);
    geoToScene(cov.latDeg, cov.lonDeg, 1 + cov.altKm / EARTH_RADIUS_KM, tmp);
    link.set([tmp.x, tmp.y, tmp.z], 3);
    linkLine.geometry.attributes.position.needsUpdate = true;
    linkLine.visible = true;
    needsRender = true;
  }

  /** Scene direction of a ground point at the current Earth rotation. */
  function groundDirection(latDeg, lonDeg) {
    return spin(geoToScene(latDeg, lonDeg, 1, new THREE.Vector3()), gmstNow);
  }

  function flyToGround(latDeg, lonDeg, { distance, immediate } = {}) {
    controls.flyTo(groundDirection(latDeg, lonDeg), distance ?? Math.min(controls.distance, 2.9), {
      immediate,
    });
    needsRender = true;
  }

  /** Where the camera looks (or is flying to): the ground point under the
   * view centre at the current Earth rotation, and the camera distance. */
  function viewPoint() {
    const c = controls.flight ? controls.flight.to : controls;
    const s = Math.sin(c.phi);
    const v = spin(tmp.set(s * Math.sin(c.theta), Math.cos(c.phi), s * Math.cos(c.theta)), -gmstNow);
    return {
      latDeg: Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) / DEG,
      lonDeg: Math.atan2(-v.z, v.x) / DEG,
      distance: c.distance,
    };
  }

  function flyToSatellite({ distance, immediate } = {}) {
    if (!satellite.points.visible) return;
    controls.flyTo(satellite.position.clone(), distance ?? controls.distance, { immediate });
    needsRender = true;
  }

  function follow() {
    if (satellite.points.visible) controls.track(satellite.position);
  }

  function setSelected(id) {
    selectedId = id;
    paintPins();
  }

  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    paintPins();
  }

  /** Where each picture's pin is on the stage, id to { x, y }; the ones behind the Earth are left out. */
  function pinsOnScreen() {
    earth.updateMatrixWorld();
    const out = new Map();
    pins.positions.forEach((p, i) => {
      const s = toScreen(earth.localToWorld(pinPoint.copy(p)));
      if (s) out.set(pins.ids[i], s);
    });
    return out;
  }

  /** What is under a canvas-relative point (CSS px)? */
  function pick(x, y, radius = 12) {
    earth.updateMatrixWorld();
    camera.updateMatrixWorld();
    let best = null;
    let bestD = radius;
    const consider = (p, hit) => {
      const s = toScreen(p);
      if (!s) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = { ...hit, x: s.x, y: s.y };
      }
    };
    if (station.points.visible) consider(earth.localToWorld(station.position.clone()), { type: 'station' });
    if (subsolar.points.visible) consider(earth.localToWorld(subsolar.position.clone()), { type: 'subsolar' });
    pins.positions.forEach((p, i) => {
      consider(earth.localToWorld(tmp.copy(p)).clone(), { type: 'photo', id: pins.ids[i] });
    });
    // the satellite wins ties: it is the thing people most often reach for
    if (satellite.points.visible) {
      const s = toScreen(satellite.position);
      if (s && Math.hypot(s.x - x, s.y - y) < radius) best = { type: 'satellite', x: s.x, y: s.y };
    }
    return best;
  }

  /** `scale` sizes the markers with the page's type (1 = their drawn size). */
  // The middle of the view, in stage pixels (null: the stage's own middle).
  // Where panels cover part of the stage, globe.js points this at what's left.
  let viewCentre = null;
  let viewGoal = null;

  function applyViewCentre() {
    if (viewCentre) camera.setViewOffset(width, height, width / 2 - viewCentre.x, height / 2 - viewCentre.y, width, height);
    else camera.clearViewOffset();
  }

  /** Move the middle of the view to (x, y), easing over a few frames unless
   * `immediate` or reduced motion. With no arguments, back to the middle. */
  function setViewCentre(x = null, y = null, { immediate = false } = {}) {
    if (x === null) {
      viewCentre = null;
      viewGoal = null;
      applyViewCentre();
      needsRender = true;
      return;
    }
    if (immediate || controls.reducedMotion || !viewCentre) {
      viewCentre = { x, y };
      viewGoal = null;
      applyViewCentre();
      needsRender = true;
      return;
    }
    if (viewCentre.x !== x || viewCentre.y !== y) viewGoal = { x, y };
  }

  function stepViewCentre() {
    if (!viewGoal) return;
    const dx = viewGoal.x - viewCentre.x;
    const dy = viewGoal.y - viewCentre.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) {
      viewCentre = viewGoal;
      viewGoal = null;
    } else {
      viewCentre = { x: viewCentre.x + dx * 0.25, y: viewCentre.y + dy * 0.25 };
    }
    applyViewCentre();
    needsRender = true;
  }

  /** Where the satellite is on the stage, or null if it's hidden or behind the Earth. */
  function satelliteScreen() {
    return satellite.points.visible ? toScreen(satellite.position) : null;
  }

  function resize(w, h, scale = 1) {
    width = Math.max(1, w);
    height = Math.max(1, h);
    markerScale = scale;
    for (const l of labels) l.w = 0;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // on portrait screens hold the horizontal field at 35 degrees instead
    const half = Math.tan((35 * DEG) / 2);
    camera.fov = camera.aspect < 1 ? Math.min(75, (2 * Math.atan(half / camera.aspect)) / DEG) : 35;
    applyViewCentre();
    camera.updateProjectionMatrix();
    const ratio = renderer.getPixelRatio() * scale;
    for (const m of disposables) {
      if (m.uniforms?.pixelRatio) m.uniforms.pixelRatio.value = ratio;
    }
    controls.changed = true;
    needsRender = true;
  }

  /** Show a label at a point on screen, `side` of it; null hides it. */
  function showLabel(label, s, side = 'right') {
    if (!s || !side) {
      if (label.visible) {
        label.el.hidden = true;
        label.visible = false;
      }
      return;
    }
    if (!label.visible) {
      label.el.hidden = false;
      label.visible = true;
    }
    // CSS sets the label off to the right of its point; other sides undo that
    const box = labelBox(side, labelGeometry(label, s));
    const right = labelBox('right', labelGeometry(label, s));
    const x = Math.round(s.x + box.left - right.left);
    const y = Math.round(s.y + box.top - right.top);
    if (x !== label.x || y !== label.y) {
      label.el.style.transform = `translate(${x}px, ${y}px)`;
      label.x = x;
      label.y = y;
    }
  }

  function labelGeometry(label, s) {
    if (!label.w) {
      label.w = label.el.offsetWidth;
      label.h = label.el.offsetHeight;
    }
    return { x: s.x, y: s.y, w: label.w, h: label.h, gap: 12 * markerScale };
  }

  function updateLabels() {
    const onScreen = (label) => {
      const p = label.getPosition();
      return p ? toScreen(p) : null;
    };
    const sat = onScreen(satLabel);
    showLabel(satLabel, sat);
    const gs = onScreen(gsLabel);
    if (!gs) {
      showLabel(gsLabel, null);
      return;
    }
    // the satellite's name wins: Calgary's moves aside, or waits, while they overlap
    if (!gsLabel.w) showLabel(gsLabel, gs); // shown once to measure; nothing paints until this returns
    let side = 'right';
    if (sat && satLabel.w) {
      const reach = 8 * markerScale;
      const avoid = [
        labelBox('right', labelGeometry(satLabel, sat)),
        { left: sat.x - reach, top: sat.y - reach, right: sat.x + reach, bottom: sat.y + reach },
      ];
      side = placeLabel(labelGeometry(gsLabel, gs), avoid, gsSide);
    }
    gsSide = side;
    showLabel(gsLabel, gs, side);
  }

  return {
    camera,
    controls,
    setTime,
    setTrack,
    setSatellite,
    setStation,
    setTrackColor,
    setSubsolar,
    setCoverage,
    setPins,
    pinsOnScreen,
    /** Draw the pins as squares here, or leave them to thumbnails over the canvas (picturepins.js). */
    setPinsDrawn(on) {
      pinMaterial.visible = on;
      needsRender = true;
    },
    highlightPins,
    setSelected,
    setHover,
    flyToGround,
    flyToSatellite,
    viewPoint,
    follow,
    pick,
    resize,
    satelliteLabel: satLabel,
    setViewCentre,
    satelliteScreen,
    /** Show or hide the aurora. */
    setAurora(on) {
      aurora?.setOn(on);
      needsRender = true;
    },
    get auroraStatus() {
      return aurora?.status ?? null;
    },
    /** Render if anything changed; returns true if a frame was drawn. */
    frame(now, force = false) {
      if (aurora) {
        aurora.update(timeNow, sunNow, gmstNow, now, camera);
        // it shimmers: 30 frames a second is plenty
        if (aurora.animated && now - lastAurora >= 33) {
          lastAurora = now;
          needsRender = true;
        }
      }
      if (rippleStart !== null) {
        const seconds = (now - rippleStart) / 1000;
        if (seconds >= RIPPLE_S) {
          rippleStart = null;
          if (pins.ripple) pins.ripple.visible = false;
        } else {
          rippleMaterial.uniforms.seconds.value = Math.max(0, seconds);
        }
        needsRender = true;
      }
      stepViewCentre();
      const moved = controls.update(now);
      if (!(moved || needsRender || force)) return false;
      renderer.render(scene, camera);
      updateLabels();
      needsRender = false;
      return true;
    },
    get busy() {
      return controls.busy;
    },
    dispose() {
      disposed = true;
      controls.dispose();
      if (pins.geometry) pins.geometry.dispose();
      aurora?.dispose();
      for (const d of disposables) d.dispose();
      for (const l of labels) l.el.remove();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
