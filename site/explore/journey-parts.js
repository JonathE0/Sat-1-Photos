/**
 * Pieces of the landing story (journey.js) that don't need its state:
 * text formatting, stand-ins for earth.js and satellite.js when they fail
 * to load, and a still Earth for browsers without WebGL.
 */
import * as THREE from '../globe/vendor/three.module.min.js';
import { DEG, LAUNCH_MS } from '../globe/astro.js';

// ---- text ----------------------------------------------------------------------

export const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/** "25 Oct 2026, 00:54 UTC" */
export function utcLong(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "30 Oct, 03:58 UTC" */
export function utcShort(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const calgaryClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Edmonton',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** { time: "18:54", zone: "MDT", date: "24 Oct", otherDay: true } in Calgary; otherDay is
 * whether that date differs from the UTC date, which is what most lines already show. */
export function calgaryTime(ms) {
  const parts = {};
  for (const p of calgaryClock.formatToParts(ms)) parts[p.type] = p.value;
  return {
    time: `${parts.hour}:${parts.minute}`,
    zone: parts.timeZoneName || '',
    date: `${parts.day} ${parts.month}`,
    otherDay: Number(parts.day) !== new Date(ms).getUTCDate(),
  };
}

/** "2 h 14 min", "45 min", "3 d 4 h" */
export function duration(ms) {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}\u00b0 ${lat >= 0 ? 'N' : 'S'}`;
export const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}\u00b0 ${lon >= 0 ? 'E' : 'W'}`;
export const fmtLatShort = (lat) => `${Math.round(Math.abs(lat))}\u00b0 ${lat >= 0 ? 'N' : 'S'}`;
export const fmtLonShort = (lon) => `${Math.round(Math.abs(lon))}\u00b0 ${lon >= 0 ? 'E' : 'W'}`;

/** "3 May 2026", from the launch time in astro.js. */
export const launchDate = (() => {
  const d = new Date(LAUNCH_MS);
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
})();

function fractionWords(x) {
  const named = [[1 / 4, 'quarter'], [1 / 3, 'third'], [1 / 2, 'half'], [2 / 3, 'two thirds'], [3 / 4, 'three quarters']];
  for (const [v, word] of named) if (Math.abs(x - v) < 0.03) return word;
  return `${Math.round(x * 100)}%`;
}

/** The one-line note under a picture that isn't checked and whole, or ''. */
export function statusLine(photo) {
  const raw = photo.raw || {};
  const c = Number(raw.completeness);
  switch (photo.status) {
    case 'complete':
      return 'Complete, but there\u2019s no checksum to check it against.';
    case 'partial':
      if (photo.camera === 'adcs') return 'Grey bands are rows that never came down.';
      return Number.isFinite(c)
        ? `Part of this picture never came down: about ${Math.round(c * 100)}% of it arrived.`
        : 'Part of this picture never came down.';
    case 'truncated':
      return Number.isFinite(c) ? `Cut short on board: only the top ${fractionWords(c)} was saved.` : 'Cut short on board.';
    default:
      return '';
  }
}

export function placeOf(photo) {
  return photo.place || photo.computedPlace || null;
}

/** For the viewfinder and the latest picture: not a dark frame, and at least 95% of the picture can be shown. */
export const isNearlyWhole = (photo) => !photo.dark && !((photo.raw?.completeness ?? photo.completeness) < 0.95);

/**
 * How many rows of a loaded picture to show: all, or for one that never fully
 * came down, those above the flat grey a JPEG decoder fills the missing part
 * with, so the picture stops where the data did.
 */
export function rowsWithData(img, photo) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!((photo.raw?.completeness ?? photo.completeness) < 1)) return h;
  try {
    const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    probe.canvas.width = w;
    probe.canvas.height = h;
    probe.drawImage(img, 0, 0);
    const { data } = probe.getImageData(0, 0, w, h);
    const isGrey = (i) => Math.abs(data[i] - 128) < 5 && Math.abs(data[i + 1] - 128) < 5 && Math.abs(data[i + 2] - 128) < 5;
    const samples = Math.ceil(w / 8);
    for (let y = h - 1; y >= 0; y--) {
      // the camera's last line can end a block or two into its row, the rest of
      // it grey: a row counts once more than a stray block of it has data
      let filled = 0;
      for (let x = 0; x < w; x += 8) {
        if (!isGrey((y * w + x) * 4)) filled++;
      }
      if (filled < samples * 0.05) continue;
      if (y + 1 >= h) return h;
      // data ends on a 16-row JPEG block; the few rows past it are only ringing
      return y + 1 - (y + 1) % 16 || y + 1;
    }
  } catch {
    // can't read it back: show the whole file
  }
  return h;
}

/** "24 Oct 2026, 17:37 UTC", or the date alone when that is all there is. */
export function photoTime(photo) {
  const ms = photo.capturedAt ? Date.parse(photo.capturedAt) : NaN;
  if (Number.isFinite(ms)) return utcLong(ms);
  if (photo.captureDate) {
    const d = new Date(`${photo.captureDate}T00:00:00Z`);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return '';
}

export function isSquare(photo) {
  return photo.camera === 'adcs' || (photo.width && photo.width === photo.height);
}

// ---- stand-ins for the two optional modules ------------------------------------------

const FALLBACK_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FALLBACK_FS = /* glsl */ `
  uniform sampler2D dayMap;
  uniform float ready;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vec3 day = ready > 0.5 ? texture2D(dayMap, vUv).rgb : vec3(0.01, 0.02, 0.035);
    float mu = dot(normalize(vNormalW), normalize(sunDir));
    float lit = smoothstep(-0.06, 0.25, mu);
    gl_FragColor = vec4(day * mix(0.025, 1.0, lit), 1.0);
    #include <colorspace_fragment>
  }
`;

/** A plain sphere with the globe page's 2048 day map; the same API as earth.js. */
export function fallbackEarth() {
  const sunDir = new THREE.Vector3(1, 0, 0);
  const uniforms = { dayMap: { value: null }, ready: { value: 0 }, sunDir: { value: sunDir } };
  const geometry = new THREE.SphereGeometry(1, 128, 64);
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: FALLBACK_VS, fragmentShader: FALLBACK_FS });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  let texture = null;
  const ready = new Promise((resolve) => {
    new THREE.TextureLoader().load(
      new URL('../globe/textures/earth-day-2048.jpg', import.meta.url).href,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        texture = tex;
        uniforms.dayMap.value = tex;
        uniforms.ready.value = 1;
        resolve();
      },
      undefined,
      () => resolve(),
    );
  });
  return {
    group,
    ready,
    setTime(theta, sunEci) {
      group.rotation.y = theta;
      sunDir.set(sunEci.x, sunEci.z, -sunEci.y).normalize();
    },
    update() {},
    dispose() {
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      group.removeFromParent();
    },
  };
}

/** A small 3U box; the same API as satellite.js. */
export function fallbackSatellite() {
  const object3d = new THREE.Group();
  const scaler = new THREE.Group();
  object3d.add(scaler);
  const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.3405);
  const material = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.5 });
  const mesh = new THREE.Mesh(geometry, material);
  scaler.add(mesh);
  return {
    object3d,
    hitObjects: [mesh],
    source: 'box',
    bodyBounds: new THREE.Box3(new THREE.Vector3(-0.05, -0.05, -0.17), new THREE.Vector3(0.05, 0.05, 0.17)),
    setScale(s) {
      scaler.scale.setScalar(s);
    },
    setHighlight() {},
    setEarthshine() {},
    dispose() {
      geometry.dispose();
      material.dispose();
      object3d.removeFromParent();
    },
  };
}

// ---- a still Earth for browsers without WebGL ----------------------------------------------

/** Draw the day map as an orthographic globe centred on a point, `cssSize` across. */
export function drawStillEarth(canvas, cssSize, latDeg, lonDeg) {
  const img = new Image();
  img.decoding = 'async';
  img.src = new URL('../globe/textures/earth-day-2048.jpg', import.meta.url).href;
  img.decode().then(() => {
    const srcW = 1024;
    const srcH = 512;
    const src = document.createElement('canvas');
    src.width = srcW;
    src.height = srcH;
    const sctx = src.getContext('2d');
    sctx.drawImage(img, 0, 0, srcW, srcH);
    const data = sctx.getImageData(0, 0, srcW, srcH).data;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const n = Math.round(cssSize * ratio);
    canvas.width = n;
    canvas.height = n;
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(n, n);
    const lat0 = latDeg * DEG;
    const lon0 = lonDeg * DEG;
    const s0 = Math.sin(lat0);
    const c0 = Math.cos(lat0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (2 * (i + 0.5)) / n - 1;
        const y = 1 - (2 * (j + 0.5)) / n;
        const rho2 = x * x + y * y;
        if (rho2 > 1) continue;
        const z = Math.sqrt(1 - rho2);
        // inverse orthographic projection
        const lat = Math.asin(z * s0 + y * c0);
        const lon = lon0 + Math.atan2(x, z * c0 - y * s0);
        const u = ((((lon / (2 * Math.PI) + 0.5) % 1) + 1) % 1) * srcW;
        const v = (0.5 - lat / Math.PI) * srcH;
        const k = (Math.min(srcH - 1, Math.max(0, Math.floor(v))) * srcW + Math.min(srcW - 1, Math.floor(u))) * 4;
        const o = (j * n + i) * 4;
        const edge = Math.min(1, (1 - Math.sqrt(rho2)) * n * 0.5);
        out.data[o] = data[k];
        out.data[o + 1] = data[k + 1];
        out.data[o + 2] = data[k + 2];
        out.data[o + 3] = Math.round(255 * edge);
      }
    }
    ctx.putImageData(out, 0, 0);
  }).catch(() => {});
}
