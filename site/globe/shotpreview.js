/**
 * Draws what CTS-SAT-1's main camera would see at a moment: one 640 x 480
 * frame, rendered offscreen by its own small WebGLRenderer, which is gone
 * again once the frame is done. Clear sky, because clouds can't be forecast;
 * the same frame with a sample cloud map comes back alongside it.
 *
 *   const { clear, cloudy, state, camera } = await renderShot({ ms, orbit });
 *   document.body.append(clear);                  // a 640 x 480 2D canvas
 *
 * The ground and its lighting are the Explore page's Earth (explore/earth.js);
 * the camera's geometry is in shotcamera.js.
 */
import * as THREE from './vendor/three.module.min.js';
import { createEarth } from '../explore/earth.js';
import { clamp, gmst, sunElevationDeg, sunPosition } from './astro.js';
import { BOOM_OUTLINE, cameraAt, fieldOfView, NOMINAL_POINTING, PICAM, toScene } from './shotcamera.js';

/** 8192-wide maps on a big screen, where the wait and the memory are small; 4096 otherwise. */
export function defaultQuality() {
  const wide = Math.max(window.screen?.width || 0, window.innerWidth || 0) >= 1920;
  const roomy = !(navigator.deviceMemory <= 4) && !navigator.connection?.saveData;
  return wide && roomy ? 'high' : 'low';
}

/** Longest the frame waits for the relief map, which only shades the mountains. */
const RELIEF_WAIT_MS = 2500;

function waitForRelief(surface) {
  const start = performance.now();
  return new Promise((resolve) => {
    (function look() {
      if (surface.material.uniforms.haveRelief.value || performance.now() - start > RELIEF_WAIT_MS) resolve();
      else setTimeout(look, 50);
    })();
  });
}

/** Sits the three.js camera where the picam is, looking where it looks. */
function placeCamera(view, camera, theta) {
  const v = (a) => {
    const s = toScene(a, theta);
    return new THREE.Vector3(s.x, s.y, s.z);
  };
  view.position.copy(v(camera.position));
  // three.js cameras look down their -z, with +y up the picture
  const basis = new THREE.Matrix4().makeBasis(v(camera.right), v(camera.down).negate(), v(camera.bore).negate());
  view.quaternion.setFromRotationMatrix(basis);
  view.updateMatrixWorld(true);
}

/**
 * The picam's exposure and lavender cast, fitted to its real frames
 * (docs/picam-calibration.md). It exposes for the bright end of the scene, so
 * the brightest few percent of the frame set the gain, up to the most it has
 * been seen to use; then a little haze and stray light goes in under the
 * picture and each channel gets its own response.
 */
const LOOK = Object.freeze({
  gain: [0.5725, 0.4532, 0.4962],
  veil: [0.0658, 0.0604, 0.0656],
  saturation: 0.7,
  maxExposure: 6.2,
  brightShare: 0.05,
});

/** The bright-end exposure for a frame of sRGB values (RGBA bytes). */
export function autoExposure(data) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) bins[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)] += 1;
  let left = (data.length / 4) * LOOK.brightShare;
  let level = 255;
  while (level > 1 && (left -= bins[level]) > 0) level -= 1;
  return Math.min(LOOK.maxExposure, 255 / level);
}

/** `amount` runs from 0 (night, left as it is: earth.js's lights already match the night frames) to 1 (day). */
function applyLook(ctx, w, h, amount) {
  if (amount <= 0) return;
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const s = autoExposure(d);
  const { gain, veil, saturation } = LOOK;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] + d[i + 1] + d[i + 2]) / 3;
    for (let c = 0; c < 3; c++) {
      const x = g + saturation * (d[i + c] - g);
      d[i + c] += amount * (s * (gain[c] * x + 255 * veil[c]) - d[i + c]);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** The satellite's boom, in frame in its sunlit pictures: a thin dark line against the bright ground. */
function drawBoom(ctx) {
  ctx.beginPath();
  BOOM_OUTLINE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(46, 48, 82, 0.55)';
  ctx.fill();
}

function snapshot(source, { look, boom }) {
  const canvas = document.createElement('canvas');
  canvas.width = PICAM.width;
  canvas.height = PICAM.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  applyLook(ctx, canvas.width, canvas.height, look);
  if (boom) drawBoom(ctx);
  return canvas;
}

/**
 * @param {object} o
 * @param {number} o.ms          the moment, Unix milliseconds
 * @param {object} o.orbit       an astro.Orbit
 * @param {object} [o.pointing]  { pitchDeg, rollDeg, yawDeg } off NOMINAL_POINTING
 * @param {'high'|'low'|'phone'} [o.quality]  size of the ground maps
 * @param {boolean} [o.look]     the picam's colour (default on)
 * @param {boolean} [o.boom]     the boom, when the satellite is in sunlight (default on)
 * @returns {Promise<{clear: HTMLCanvasElement, cloudy: HTMLCanvasElement, state: object, camera: object, boom: boolean}>}
 */
export async function renderShot({ ms, orbit, pointing = NOMINAL_POINTING, quality = defaultQuality(), look = true, boom = true }) {
  const state = orbit.stateAt(ms);
  if (!state) throw new Error('No orbit at that time');
  const camera = cameraAt(state, pointing);
  const fov = fieldOfView();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  let earth = null;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(PICAM.width, PICAM.height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 1);

    const scene = new THREE.Scene();
    earth = createEarth(renderer, { quality });
    scene.add(earth.group);
    earth.setTime(state.gmst, sunPosition(ms), ms);
    await earth.ready;
    const surface = earth.group.getObjectByName('EarthSurface');
    const clouds = earth.group.getObjectByName('EarthClouds');
    await waitForRelief(surface);

    const view = new THREE.PerspectiveCamera(fov.heightDeg, PICAM.width / PICAM.height, 0.01, 4);
    placeCamera(view, camera, gmst(ms));
    earth.update(0, view);

    // from dusk to full daylight the camera's daytime look comes in
    const sunEl = sunElevationDeg(state.latDeg, state.lonDeg, ms);
    const opts = { look: look ? clamp((sunEl + 6) / 9, 0, 1) : 0, boom: boom && sunlitAt(state, ms) };
    // the map's clouds and their shadows on the ground go together
    const have = surface.material.uniforms.have.value;
    const haveClouds = have.z;
    clouds.visible = false;
    have.z = 0;
    renderer.render(scene, view);
    const clear = snapshot(renderer.domElement, opts);
    clouds.visible = !!haveClouds;
    have.z = haveClouds;
    renderer.render(scene, view);
    const cloudy = snapshot(renderer.domElement, opts);
    return { clear, cloudy, state, camera, boom: opts.boom };
  } finally {
    earth?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function sunlitAt(state, ms) {
  const sun = sunPosition(ms);
  const r = state.eci;
  const d = Math.hypot(r.x, r.y, r.z);
  // the Sun clear of the Earth's disc as seen from the satellite
  const cosNadir = -(r.x * sun.x + r.y * sun.y + r.z * sun.z) / d;
  return cosNadir < Math.cos(Math.asin(Math.min(1, 6371 / d)));
}
