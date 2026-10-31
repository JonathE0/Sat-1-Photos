/**
 * The aurora, for both globes: NOAA's OVATION forecast drawn as glowing light
 * 95 to 340 km up, green below and red above, as it really is.
 *
 * What's real: where the aurora is and how strong, from the forecast (a 1 degree
 * grid, fetched from NOAA by the browser, again every 5 minutes). OVATION is a
 * model driven by the measured solar wind, not a photograph. What isn't: the
 * shimmer, a noise field laid over it so it moves, since the forecast has no
 * rays or arcs in it.
 *
 * The forecast holds for one moment, about an hour ahead. The oval stays facing
 * the Sun while the Earth turns under it, so for other times the map is turned
 * about the magnetic pole by however far the Sun has moved around that pole. At
 * the forecast's own time that is no turn at all. It fades out 3 to 6 hours
 * away, since the forecast says nothing about how activity will change.
 *
 * Frame as in scene.js and earth.js: `object` belongs in the group turned by
 * GMST, so it is Earth-fixed; the north pole is +y; one unit is the Earth's radius.
 *
 *   const aurora = createAurora({ quality, still, onStatus });
 *   aurora.setOn(true);
 *   earthGroup.add(aurora.object);
 *   // each drawn frame: aurora.update(ms, sunEci, gmst, performance.now(), camera);
 */
import * as THREE from './vendor/three.module.min.js';
import { DEG, gmst, sunPosition } from './astro.js';

export const FEED_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const REFRESH_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
/** How far from the forecast's time it stays at full strength, and where it has gone. */
const HOLD_MS = 3 * HOUR_MS;
const GONE_MS = 6 * HOUR_MS;

/** The geomagnetic (dipole) north pole, IGRF 2025: as cts1_gallery/watch.py. */
const POLE_LAT = 80.8;
const POLE_LON = -72.6;
const KM = 1 / 6371;
const BOTTOM = 1 + 95 * KM;
const TOP = 1 + 340 * KM;
/** The shell is only drawn this far from each magnetic pole: down to 30 degrees magnetic latitude. */
const CAP = 60 * DEG;
const STEPS = { high: 14, low: 12, phone: 7 };

const VS = /* glsl */ `
  varying vec3 vShell;
  varying vec3 vCamera;
  void main() {
    vShell = position;
    vCamera = transpose(mat3(modelMatrix)) * (cameraPosition - modelMatrix[3].xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A walk down each line of sight through the shell, adding up the light. Colours
// are as they should look on screen, so neither tone mapping nor sRGB applies.
const FS = /* glsl */ `
  uniform sampler2D forecast;
  uniform sampler2D noise;
  uniform mat3 turn;       // to where this point was, relative to the Sun, at the forecast's time
  uniform vec3 sunLocal;
  uniform vec3 pole;       // these three: magnetic north, and two directions square to it
  uniform vec3 poleX;
  uniform vec3 poleY;
  uniform float seconds;
  uniform float strength;
  varying vec3 vShell;
  varying vec3 vCamera;

  #define STEPS __STEPS__
  #define TAU 6.283185307
  #define PI 3.141592654
  const float BOTTOM = ${BOTTOM.toFixed(5)};
  const float TOP = ${TOP.toFixed(5)};
  const vec3 GREEN = vec3(0.13, 1.0, 0.42);   // atomic oxygen, 557.7 nm
  const vec3 RED = vec3(0.95, 0.12, 0.26);    // atomic oxygen, 630 nm, high and thin
  const vec3 PINK = vec3(0.85, 0.2, 0.62);    // nitrogen, the low edge of a strong display

  // How much the forecast says, 0 to 1, at a point on the Earth.
  float forecastAt(vec3 n) {
    vec3 q = turn * n;
    float lon = atan(-q.z, q.x) / TAU;
    float lat = asin(clamp(q.y, -1.0, 1.0));
    // the grid's values sit on whole degrees: 360 across, 181 from pole to pole
    vec2 uv = vec2(fract(lon) + 0.5 / 360.0, (lat / PI + 0.5) * 180.0 / 181.0 + 0.5 / 181.0);
    return texture2D(forecast, uv).r;
  }

  // The moving part, about 1. Arcs run along magnetic latitude, rays cross them.
  float shimmer(vec3 n) {
    float along = atan(dot(n, poleY), dot(n, poleX)) / TAU;
    float across = asin(clamp(dot(n, pole), -1.0, 1.0));
    float t = seconds;
    float wander = texture2D(noise, vec2(along * 2.0 + t * 0.0016, t * 0.0045)).b - 0.5;
    float y = across + wander * 0.10;
    float arcs = texture2D(noise, vec2(along + t * 0.0013, y * 2.6 - t * 0.0025)).g;
    arcs = smoothstep(0.30, 0.68, arcs);
    float rays = texture2D(noise, vec2(along * 3.0 + wander * 0.5 + t * 0.0036, y * 0.45 + t * 0.021)).r;
    float light = mix(0.42, 1.25, arcs) * (0.52 + 1.05 * rays * rays);
    // close up, from about the satellite's height, finer folds and rays with gaps between them
    float close = 1.0 - smoothstep(1.25, 1.9, length(vCamera));
    if (close > 0.0) {
      float folds = texture2D(noise, vec2(along * 3.0 - t * 0.0028, y * 8.0 + wander)).a;
      float fine = texture2D(noise, vec2(along * 9.0 + wander + t * 0.009, y * 1.4 + t * 0.043)).r;
      light *= mix(1.0, smoothstep(0.34, 0.74, folds) * (0.25 + 1.5 * fine), close);
    }
    return light;
  }

  void main() {
    vec3 ro = vCamera;
    vec3 rd = normalize(vShell - vCamera);
    float b = dot(ro, rd);
    float rr = dot(ro, ro);
    float disc = b * b - (rr - TOP * TOP);
    if (disc <= 0.0) discard;
    float root = sqrt(disc);
    float t0 = max(-b - root, 0.0);
    float t1 = -b + root;
    float low = b * b - (rr - BOTTOM * BOTTOM);
    if (low > 0.0) {
      float hit = -b - sqrt(low);
      if (hit > 0.0) t1 = min(t1, hit);
    }
    if (t1 <= t0) discard;

    // close up the lines of sight are long and the eye is near: twice the steps
    int steps = rr < 1.7 ? STEPS * 2 : STEPS;
    float ds = (t1 - t0) / float(steps);
    // a different start in each pixel, so the steps show as a fine grain and not as bands
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 light = vec3(0.0);
    for (int i = 0; i < steps; i++) {
      vec3 p = ro + rd * (t0 + (float(i) + jitter) * ds);
      float r = length(p);
      float km = (r - 1.0) * 6371.0;
      float green = smoothstep(90.0, 112.0, km) * exp(-max(km - 115.0, 0.0) / 42.0);
      float red = smoothstep(150.0, 230.0, km) * exp(-max(km - 230.0, 0.0) / 60.0);
      if (green + red < 0.004) continue;
      vec3 n = p / r;
      float value = forecastAt(n);
      if (value < 0.05) continue;
      float s = smoothstep(0.05, 0.62, value);
      // there's no seeing it against sunlit ground, so only a trace stays on the day side
      float dark = mix(0.10, 1.0, 1.0 - smoothstep(-0.10, 0.12, dot(n, sunLocal)));
      float pink = smoothstep(0.55, 0.9, value) * smoothstep(90.0, 100.0, km) * exp(-max(km - 100.0, 0.0) / 14.0);
      light += (GREEN * green + RED * red * 0.20 + PINK * pink) * s * dark * shimmer(n);
    }
    // A line of sight along the shell crosses far more of it than one straight down.
    // That's real, but in full it floods the view, so only part of it counts.
    light *= ds * 110.0 * strength / sqrt(max((t1 - t0) / (TOP - BOTTOM), 1.0));
    // a soft ceiling on the brightest channel, so it stays green and doesn't wash out
    // to white, and below full so what's under it still shows
    float peak = max(light.r, max(light.g, light.b));
    if (peak < 0.002) discard;
    gl_FragColor = vec4(light * 0.8 * (1.0 - exp(-peak)) / peak, 1.0);
  }
`;

/** Smooth noise that tiles: a different size in each channel, as cells across the tile. */
function makeNoise() {
  const SIZE = 256;
  const data = new Uint8Array(SIZE * SIZE * 4);
  let seed = 20261031;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ease = (x) => x * x * (3 - 2 * x);
  [64, 16, 8, 32].forEach((cells, channel) => {
    const lattice = Float32Array.from({ length: cells * cells }, random);
    for (let y = 0; y < SIZE; y++) {
      const fy = (y / SIZE) * cells;
      const y0 = Math.floor(fy);
      const ty = ease(fy - y0);
      for (let x = 0; x < SIZE; x++) {
        const fx = (x / SIZE) * cells;
        const x0 = Math.floor(fx);
        const tx = ease(fx - x0);
        const at = (i, j) => lattice[(j % cells) * cells + (i % cells)];
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        data[(y * SIZE + x) * 4 + channel] = (top + (bottom - top) * ty) * 255;
      }
    }
  });
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * NOAA's JSON as a grid: one byte per cell, row 0 at the south pole, column 0 on
 * the prime meridian. Throws if it isn't what it should be.
 */
export function parseForecast(json) {
  const cells = json?.coordinates;
  const forecastMs = Date.parse(json?.['Forecast Time']);
  if (!Array.isArray(cells) || cells.length < 1000 || !Number.isFinite(forecastMs)) {
    throw new Error('not an aurora forecast');
  }
  const grid = new Uint8Array(360 * 181);
  let peak = 0;
  for (const [lon, lat, value] of cells) {
    const x = ((Math.round(lon) % 360) + 360) % 360;
    const y = Math.round(lat) + 90;
    if (y < 0 || y > 180 || !(value >= 0)) continue;
    grid[y * 360 + x] = Math.min(255, Math.round(value * 2.55));
    if (value > peak) peak = value;
  }
  return { grid, forecastMs, observedMs: Date.parse(json['Observation Time']), peak };
}

/** A unit vector in the scene's frame, from an ECI one and the Earth's rotation: Earth-fixed. */
function earthFixed(eci, theta, out) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const x = eci.x * c + eci.y * s;
  const y = -eci.x * s + eci.y * c;
  return out.set(x, eci.z, -y).normalize();
}

const magneticPole = () => {
  const lat = POLE_LAT * DEG;
  const lon = POLE_LON * DEG;
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
};
const squareTo = (pole) => {
  const x = new THREE.Vector3(0, 1, 0).cross(pole).normalize();
  return { x, y: pole.clone().cross(x).normalize() };
};

/**
 * The turn about the magnetic pole, in radians, that takes a point at `ms` to the
 * point at the same magnetic latitude and magnetic local time at `forecastMs`.
 */
export function turnSince(ms, forecastMs) {
  const pole = magneticPole();
  const { x, y } = squareTo(pole);
  const azimuth = (t) => {
    const sun = earthFixed(sunPosition(t), gmst(t), new THREE.Vector3());
    return Math.atan2(sun.dot(y), sun.dot(x));
  };
  return azimuth(forecastMs) - azimuth(ms);
}

/**
 * @param {object} [options]
 * @param {'high'|'low'|'phone'} [options.quality] how many steps through the shell
 * @param {boolean} [options.still] no shimmer (?motion=reduced)
 * @param {(status: {state: 'loading'|'ok'|'failed', forecastMs?: number, peak?: number}) => void} [options.onStatus]
 */
export function createAurora({ quality = 'low', still = false, onStatus = () => {} } = {}) {
  const pole = magneticPole();
  const { x: poleX, y: poleY } = squareTo(pole);
  const sunLocal = new THREE.Vector3(1, 0, 0);
  const noise = makeNoise();
  const forecast = new THREE.DataTexture(new Uint8Array(360 * 181), 360, 181, THREE.RedFormat);
  forecast.wrapS = THREE.RepeatWrapping;
  forecast.magFilter = forecast.minFilter = THREE.LinearFilter;

  const uniforms = {
    forecast: { value: forecast },
    noise: { value: noise },
    turn: { value: new THREE.Matrix3() },
    sunLocal: { value: sunLocal },
    pole: { value: pole },
    poleX: { value: poleX },
    poleY: { value: poleY },
    seconds: { value: 0 },
    strength: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'Aurora',
    uniforms,
    vertexShader: VS,
    fragmentShader: FS.replace('__STEPS__', String(STEPS[quality] || STEPS.low)),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  // one cap around each magnetic pole
  const object = new THREE.Group();
  object.name = 'Aurora';
  object.visible = false;
  const geometries = [1, -1].map((side) => {
    const geometry = new THREE.SphereGeometry(TOP, 96, 28, 0, Math.PI * 2, 0, CAP);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), pole.clone().multiplyScalar(side)));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 3; // over the clouds and the atmosphere
    object.add(mesh);
    return geometry;
  });

  let on = false; // nothing is fetched until setOn(true)
  let feed = null;
  let status = { state: 'loading' };
  let timer = 0;
  let disposed = false;
  let lastFetch = 0;
  const abort = new AbortController();
  const sunThen = new THREE.Vector3();
  const rotation = new THREE.Matrix4();

  const say = (next) => {
    status = next;
    onStatus(status);
  };

  async function load() {
    // not while it's off, or nobody's looking: the interval picks it up again
    if (disposed || !on || (document.hidden && feed)) return;
    lastFetch = Date.now();
    try {
      const res = await fetch(FEED_URL, { signal: abort.signal, credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = parseForecast(await res.json());
      if (disposed) return;
      forecast.image.data.set(next.grid);
      forecast.needsUpdate = true;
      feed = next;
      earthFixed(sunPosition(next.forecastMs), gmst(next.forecastMs), sunThen);
      say({ state: 'ok', forecastMs: next.forecastMs, observedMs: next.observedMs, peak: next.peak });
    } catch (err) {
      if (disposed || err?.name === 'AbortError') return;
      console.warn('Aurora: no forecast from NOAA', err);
      // an old forecast is still shown, until it has faded out with time
      if (!feed) say({ state: 'failed' });
    }
  }

  function setOn(value) {
    on = Boolean(value);
    if (!on) object.visible = false;
    else if (Date.now() - lastFetch >= REFRESH_MS) load();
  }

  timer = setInterval(load, REFRESH_MS);

  /** Call before drawing. `seconds` only drives the shimmer. */
  function update(ms, sunEci, theta, nowMs, camera) {
    const away = feed ? Math.abs(ms - feed.forecastMs) : Infinity;
    const k = away <= HOLD_MS ? 1 : away >= GONE_MS ? 0 : 1 - THREE.MathUtils.smoothstep(away, HOLD_MS, GONE_MS);
    object.visible = on && k > 0.002;
    if (!object.visible) return false;
    uniforms.strength.value = k;
    if (!still) uniforms.seconds.value = nowMs / 1000;
    earthFixed(sunEci, theta, sunLocal);
    const azimuth = (v) => Math.atan2(v.dot(poleY), v.dot(poleX));
    uniforms.turn.value.setFromMatrix4(rotation.makeRotationAxis(pole, azimuth(sunThen) - azimuth(sunLocal)));
    // inside the shell its outer faces are behind the camera
    const side = camera && camera.position.length() < TOP * 1.0005 ? THREE.BackSide : THREE.FrontSide;
    if (material.side !== side) {
      material.side = side;
      material.needsUpdate = true;
    }
    return true;
  }

  function dispose() {
    disposed = true;
    abort.abort();
    clearInterval(timer);
    object.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    material.dispose();
    forecast.dispose();
    noise.dispose();
  }

  return {
    object,
    update,
    setOn,
    dispose,
    /** It shimmers, so while it shows the globe has to keep drawing. */
    get animated() {
      return !still && object.visible;
    },
    get status() {
      return status;
    },
    get on() {
      return on;
    },
  };
}

/** The line that says what's being shown, for the page's credits; null when there's nothing to say. */
export function auroraNote(status, ms) {
  if (status.state === 'failed') return 'Aurora: NOAA’s forecast couldn’t be loaded just now.';
  if (status.state !== 'ok') return null;
  const when = new Date(status.forecastMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const at = `${p2(when.getUTCHours())}:${p2(when.getUTCMinutes())} UTC`;
  const away = Math.abs(ms - status.forecastMs);
  if (away >= GONE_MS) return `Aurora: NOAA’s forecast is for ${at}, so it isn’t shown this far from then.`;
  return `Aurora: NOAA’s OVATION forecast for ${at} sets where it is and how strong. The shimmer is only for show.`;
}
