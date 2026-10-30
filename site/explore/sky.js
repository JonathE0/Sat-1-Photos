/**
 * The sky behind the Explore-page Earth: the bright stars at their real
 * positions, the Sun and the Moon.
 *
 * Frame: the scene's inertial frame, as in site/globe/scene.js and earth.js.
 * ECI (x, y, z) is drawn at (x, z, -y); one unit is the mean Earth radius.
 * The sky does not turn with GMST; the Earth does. `group` must stay at the
 * origin, unrotated and unscaled.
 *
 * - Stars: Yale Bright Star Catalogue to V 6.0 (5,080 stars; 'phone' keeps V
 *   5.5). J2000 positions, moved by proper motion to 2026, precessed to the
 *   equator and equinox of date (IAU 1976) for the time given. Drawn on the
 *   far plane, so the Earth, the Moon and anything else hides them. They are
 *   constant-size points; brightness and size follow magnitude, and B-V gives
 *   a faint tint. They do not twinkle.
 * - Sun: site/globe/astro.js sunPosition, the same as earth.js's lighting, as
 *   a disc of its true angular size (about 0.53 degrees) with limb darkening
 *   and a very tight falloff. There is no flare or bloom.
 * - Moon: sky/moon.js, the same as earth.js's moonlight. A textured sphere
 *   (NASA LROC) at its true direction and size as seen from the camera,
 *   parallax included, lit by the Sun so the phase is right, with faint
 *   earthshine. It sits at its true distance (~60 Earth radii) when the
 *   camera's far plane allows, otherwise nearer with a matching radius.
 *
 *   const sky = createSky(renderer, { quality: 'high' });
 *   scene.add(sky.group);
 *   // whenever the simulated time changes: sky.setTime(ms, gmst(ms));
 *   // every frame, after moving the camera: sky.update(camera);
 *
 * Stars and Sun are not tone mapped (they are tuned as display values); the
 * Moon follows renderer.toneMapping like the Earth.
 */
import * as THREE from '../globe/vendor/three.module.min.js';
import { sunPosition } from '../globe/astro.js';
import { moonPosition, moonIlluminated } from './sky/moon.js';

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const EARTH_RADIUS_KM = 6371.0;
const MOON_RADIUS_KM = 1737.4;
const SUN_RADIUS_KM = 695_700;

const QUALITY = {
  high: { magLimit: 6.0, moon: 2048, segments: [64, 32] },
  low: { magLimit: 6.0, moon: 2048, segments: [64, 32] },
  phone: { magLimit: 5.5, moon: 1024, segments: [48, 24] },
};

// ECI -> scene: (x, y, z) -> (x, z, -y)
const ECI_TO_SCENE = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0);

/**
 * Precession from J2000 to the mean equator and equinox of date, IAU 1976
 * (Lieske et al. 1977), as a matrix acting on J2000 column vectors.
 */
export function precessionMatrix(ms, out = new THREE.Matrix3()) {
  const T = (ms / 86_400_000 + 2440587.5 - 2451545.0) / 36525;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
  const cz = Math.cos(zeta);
  const sz = Math.sin(zeta);
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return out.set(
    cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
    cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
    cz * st, -sz * st, ct,
  );
}

/** A faint display tint for a star of colour index B-V (mostly white). */
function starTint(bv, out) {
  if (!Number.isFinite(bv)) return out.setRGB(1, 1, 1);
  // B-V to temperature (Ballesteros 2012), then a blackbody approximation
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const c = [r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255);
  const m = Math.max(...c);
  // keep about a third of the colour: real stars read as near-white
  return out.setRGB(...c.map((v) => 1 - 0.32 * (1 - v / m)));
}

const STAR_VS = /* glsl */ `
  attribute float aMag;
  attribute vec3 aTint;
  uniform mat3 toScene;        // J2000 -> equator of date -> scene frame
  uniform float pixelRatio;
  uniform float brightness;
  varying vec3 vColor;
  void main() {
    vec3 dir = toScene * position;
    vec4 clip = projectionMatrix * (viewMatrix * vec4(dir, 0.0));
    clip.z = clip.w;                         // on the far plane, behind everything
    gl_Position = clip;
    // flux relative to a magnitude 1.5 star, which just reaches full brightness.
    // The range is compressed (as eyes and star charts do), so faint stars stay
    // visible; brighter stars grow a little instead of saturating.
    float flux = pow(10.0, -0.4 * (aMag - 1.5)) * brightness;
    // 4 px keeps the Gaussian below wide enough (FWHM ~1.7 px) that a star does
    // not flicker in brightness as it crosses pixel boundaries
    gl_PointSize = 4.0 * pow(max(flux, 1.0), 0.2) * pixelRatio;
    vColor = aTint * 0.9 * min(pow(flux, 0.6), 1.0);
  }
`;

const STAR_FS = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = exp(-4.0 * dot(p, p));         // a small Gaussian
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
    #include <colorspace_fragment>
  }
`;

const SUN_VS = /* glsl */ `
  uniform vec3 sunDir;
  uniform float angRadius;     // radians
  uniform float extent;        // quad half-size, in disc radii
  varying vec2 vP;             // position in disc radii
  varying vec3 vTransmit;      // sunlight left after the air between the camera and the Sun
  // the Earth's atmosphere (as in earth.js): Rayleigh + light aerosol, in Earth radii
  const float HR = 8.0 / 6371.0;
  const float HM = 1.2 / 6371.0;
  const vec3 BR = vec3(36.96, 86.38, 210.9);
  const float BME = 28.26 * 0.3;
  // Schueler's Chapman function times exp2(-h); X, h in half-heights
  float chapman(float X, float h, float coschi) {
    float c = sqrt(X + h);
    if (coschi >= 0.0) return c / (c * coschi + 1.0) * exp2(-h);
    float x0 = sqrt(1.0 - coschi * coschi) * (X + h);
    float c0 = sqrt(x0);
    return 2.0 * c0 * exp2(X - x0) - c / (1.0 - c * coschi) * exp2(-h);
  }
  void main() {
    // optical depth from the camera toward the Sun (the Earth is at the origin;
    // if it is in the way the depth test hides the Sun anyway)
    float rc = length(cameraPosition);
    float coschi = dot(cameraPosition / rc, normalize(sunDir));
    float h = max(rc - 1.0, 0.0);
    float tauR = HR * chapman(1.0 / (HR * 0.6931472), h / (HR * 0.6931472), coschi);
    float tauM = HM * chapman(1.0 / (HM * 0.6931472), h / (HM * 0.6931472), coschi);
    vTransmit = exp(-min(BR * tauR + BME * tauM, vec3(80.0)));

    vec3 d = normalize(mat3(viewMatrix) * sunDir);
    vec3 ref = abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 r = normalize(cross(ref, d));
    vec3 u = cross(d, r);
    vec3 v = d + (r * position.x + u * position.y) * tan(angRadius * extent);
    vP = position.xy * extent;
    vec4 clip = projectionMatrix * vec4(v, 0.0);
    clip.z = clip.w;
    gl_Position = clip;
  }
`;

const SUN_FS = /* glsl */ `
  varying vec2 vP;
  varying vec3 vTransmit;
  void main() {
    float r = length(vP);
    float aa = max(fwidth(r), 1e-4);
    float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    float mu = sqrt(max(0.0, 1.0 - r * r));
    float disc = 1.6 * (1.0 - 0.56 * (1.0 - mu));                 // limb darkening
    float aureole = 0.06 * exp(-(r - 1.0) * 5.0) * (1.0 - inside); // light scattered within ~half a radius
    // reddened and dimmed when seen through the limb's air (sunrise from orbit)
    vec3 color = vec3(1.0, 0.98, 0.95) * vTransmit * (disc * inside + aureole);
    if (max(color.r, max(color.g, color.b)) < 0.003) discard;
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const MOON_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const MOON_FS = /* glsl */ `
  uniform sampler2D map;
  uniform float haveMap;
  uniform vec3 sunDir;
  uniform vec3 earthDir;       // from the Moon toward the Earth
  uniform float gain;          // the LROC colour map is stretched bright; the Moon is dark grey rock
  uniform float earthshine;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 albedo = haveMap > 0.5 ? texture2D(map, vec2(vUv.x, 1.0 - vUv.y)).rgb : vec3(0.32);
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float mu0 = max(dot(N, normalize(sunDir)), 0.0);
    float mu = max(dot(N, V), 0.001);
    // Lommel-Seeliger: the full Moon looks evenly lit, without a darkened limb
    float sun = 2.0 * mu0 / (mu0 + mu);
    float shine = earthshine * max(dot(N, normalize(earthDir)), 0.0);
    vec3 color = albedo * gain * (sun + shine * vec3(0.85, 0.92, 1.0));
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

async function loadImage(url, signal) {
  const res = await fetch(url, { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      // fall back to an <img>
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ quality?: 'high' | 'low' | 'phone', base?: string | URL }} [options]
 *   base: URL of the sky data folder; default new URL('./sky/', import.meta.url)
 */
export function createSky(renderer, { quality = 'high', base } = {}) {
  const q = QUALITY[quality] || QUALITY.high;
  const root = base ? new URL(String(base).replace(/\/?$/, '/'), document.baseURI) : new URL('./sky/', import.meta.url);
  const abort = new AbortController();
  let disposed = false;

  const group = new THREE.Group();
  group.name = 'Sky';

  const sunDir = new THREE.Vector3(1, 0, 0);
  const moonDir = new THREE.Vector3(-1, 0, 0);
  const earthDir = new THREE.Vector3(1, 0, 0);
  const toScene = new THREE.Matrix3();
  let moonDistance = 60.3; // Earth radii
  let lastPrecessionMs = NaN;

  // ---- stars
  const starGeometry = new THREE.BufferGeometry();
  const starMaterial = new THREE.ShaderMaterial({
    name: 'SkyStars',
    uniforms: {
      toScene: { value: toScene },
      pixelRatio: { value: renderer.getPixelRatio() },
      brightness: { value: 1 },
    },
    vertexShader: STAR_VS,
    fragmentShader: STAR_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = 'SkyStars';
  stars.frustumCulled = false;
  stars.renderOrder = -2;
  stars.visible = false;
  group.add(stars);

  // ---- Sun
  const sunGeometry = new THREE.PlaneGeometry(2, 2);
  const sunMaterial = new THREE.ShaderMaterial({
    name: 'SkySun',
    uniforms: {
      sunDir: { value: sunDir },
      angRadius: { value: 0.2666 * DEG },
      extent: { value: 2 },
    },
    vertexShader: SUN_VS,
    fragmentShader: SUN_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const sun = new THREE.Mesh(sunGeometry, sunMaterial);
  sun.name = 'SkySun';
  sun.frustumCulled = false;
  // after earth.js's atmosphere (renderOrder 2): the Sun does its own extinction,
  // per colour, instead of taking the shell's grey veil and blue haze on top
  sun.renderOrder = 3;
  group.add(sun);

  // ---- Moon
  const moonGeometry = new THREE.SphereGeometry(1, q.segments[0], q.segments[1]);
  const moonUniforms = {
    map: { value: null },
    haveMap: { value: 0 },
    sunDir: { value: sunDir },
    earthDir: { value: earthDir },
    gain: { value: 0.55 },
    earthshine: { value: 0 },
  };
  const moonMaterial = new THREE.ShaderMaterial({
    name: 'SkyMoon',
    uniforms: moonUniforms,
    vertexShader: MOON_VS,
    fragmentShader: MOON_FS,
  });
  const moon = new THREE.Mesh(moonGeometry, moonMaterial);
  moon.name = 'SkyMoon';
  moon.frustumCulled = false;
  group.add(moon);

  // ---- loading
  const starsLoaded = fetch(new URL('stars.bin', root), { signal: abort.signal, credentials: 'same-origin' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for stars.bin`);
      return res.arrayBuffer();
    })
    .then((buffer) => {
      if (disposed) return;
      const view = new DataView(buffer);
      const n = Math.floor(buffer.byteLength / 8);
      const pos = new Float32Array(n * 3);
      const mag = new Float32Array(n);
      const tint = new Float32Array(n * 3);
      const c = new THREE.Color();
      let shown = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        const x = view.getInt16(o, true) / 32767;
        const y = view.getInt16(o + 2, true) / 32767;
        const z = view.getInt16(o + 4, true) / 32767;
        const l = Math.hypot(x, y, z) || 1;
        pos.set([x / l, y / l, z / l], i * 3);
        mag[i] = view.getUint8(o + 6) / 20 - 2;
        const bvByte = view.getUint8(o + 7);
        starTint(bvByte === 255 ? NaN : bvByte / 100 - 0.5, c);
        tint.set([c.r, c.g, c.b], i * 3);
        if (mag[i] <= q.magLimit) shown = i + 1; // sorted brightest first
      }
      starGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      starGeometry.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
      starGeometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
      starGeometry.setDrawRange(0, shown);
      stars.visible = true;
    })
    .catch((err) => {
      if (!disposed && err?.name !== 'AbortError') console.warn('Sky: could not load the stars', err);
    });

  let moonTexture = null;
  const moonLoaded = loadImage(new URL(`moon-${q.moon}.jpg`, root).href, abort.signal)
    .then((image) => {
      if (disposed) {
        image.close?.();
        return;
      }
      moonTexture = new THREE.Texture(image);
      moonTexture.flipY = false;
      moonTexture.colorSpace = THREE.SRGBColorSpace;
      moonTexture.wrapS = THREE.RepeatWrapping;
      moonTexture.minFilter = THREE.LinearMipmapLinearFilter;
      moonTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      moonTexture.needsUpdate = true;
      renderer.initTexture(moonTexture);
      image.close?.();
      moonUniforms.map.value = moonTexture;
      moonUniforms.haveMap.value = 1;
    })
    .catch((err) => {
      if (!disposed && err?.name !== 'AbortError') console.warn('Sky: could not load the Moon map', err);
    });

  const ready = Promise.all([starsLoaded, moonLoaded]).then(() => undefined);

  // ---- time
  const precession = new THREE.Matrix3();
  const basis = new THREE.Matrix4();
  const pole = new THREE.Vector3();
  const xAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();

  /**
   * ms: simulated time (Unix ms). gmstAngle is accepted for symmetry with
   * earth.setTime; the sky is inertial and does not need it.
   */
  // eslint-disable-next-line no-unused-vars
  function setTime(ms, gmstAngle) {
    // precession moves ~50" a year: recompute at most once a simulated hour
    if (!(Math.abs(ms - lastPrecessionMs) < 3_600_000)) {
      precessionMatrix(ms, precession);
      toScene.multiplyMatrices(ECI_TO_SCENE, precession);
      lastPrecessionMs = ms;
    }
    const s = sunPosition(ms);
    sunDir.set(s.x, s.z, -s.y).normalize();
    sunMaterial.uniforms.angRadius.value = Math.asin(SUN_RADIUS_KM / s.distanceKm);

    const m = moonPosition(ms);
    moonDir.set(m.x, m.z, -m.y).normalize();
    moonDistance = m.distanceKm / EARTH_RADIUS_KM;
    // earthshine: the Earth is nearly full, seen from a thin crescent Moon
    moonUniforms.earthshine.value = 0.012 * (1 - moonIlluminated(m, s)) ** 2;

    // the near side faces the Earth; the Moon's axis is within 1.5 degrees of
    // the ecliptic pole (libration ignored). Local +x is longitude 0, +y north.
    const eps = 23.439 * DEG;
    pole.set(0, Math.cos(eps), Math.sin(eps)); // ecliptic north pole, ECI (0, -sin, cos) in the scene frame
    earthDir.copy(moonDir).negate();
    xAxis.copy(earthDir).addScaledVector(pole, -earthDir.dot(pole)).normalize();
    zAxis.crossVectors(xAxis, pole).normalize();
    basis.makeBasis(xAxis, pole, zAxis);
    moon.quaternion.setFromRotationMatrix(basis);
  }

  const camPos = new THREE.Vector3();
  const toMoon = new THREE.Vector3();

  /** Per frame, after the camera has moved. */
  function update(camera) {
    starMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio();
    if (!camera) return;
    camera.getWorldPosition(camPos);
    // place the Moon so it looks right from this camera: true direction and
    // angular size, at its true distance if the far plane allows
    toMoon.copy(moonDir).multiplyScalar(moonDistance).sub(camPos);
    const trueRange = toMoon.length();
    const range = Math.min(trueRange, (camera.far || 1e9) * 0.9);
    moon.position.copy(camPos).addScaledVector(toMoon, range / trueRange);
    moon.scale.setScalar((MOON_RADIUS_KM / EARTH_RADIUS_KM) * (range / trueRange));
  }

  setTime(Date.now(), 0);

  function dispose() {
    disposed = true;
    abort.abort();
    group.removeFromParent();
    starGeometry.dispose();
    starMaterial.dispose();
    sunGeometry.dispose();
    sunMaterial.dispose();
    moonGeometry.dispose();
    moonMaterial.dispose();
    moonTexture?.dispose();
  }

  return { group, setTime, update, ready, dispose };
}
