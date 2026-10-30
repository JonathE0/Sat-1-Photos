/**
 * The orbit page's flat map: the world in plate carrée (equirectangular)
 * from the globe's NASA day and night pictures, shaded for the time shown,
 * with the satellite's ground track about one orbit back and two ahead, its
 * footprint, Calgary and the picture pins.
 *
 *   const map = createMap(stage, { textureBase, onUserMove });
 *   map.resize(width, height, scale, { left, right, top, bottom });
 *   map.setVisible(true);
 *   map.setTime(ms);                       // the Sun, so the night side
 *   map.setSatellite({ latDeg, lonDeg, altKm });
 *   map.setTrack(samples);                 // [{ latDeg, lonDeg, dtMin }]
 *   map.frame(performance.now());          // once per animation frame
 *
 * Like scene.js it draws whatever state globe.js hands it and knows nothing
 * about the clock, the data files or the panels. It uses canvas 2D only, so
 * it works where WebGL doesn't. The map wraps sideways without end, so the
 * track and footprint cross the antimeridian as unbroken lines.
 *
 * The projection and shading helpers above createMap are pure (no DOM), so
 * fixtures/verify.mjs checks them against astro.js under Node.
 */
import { DEG, clamp, footprintAngle, sunDirectionEcef, subsolarPoint } from './astro.js';
import { labelBox, placeLabel } from './labels.js';
import { RIPPLE_COLOR, RIPPLE_GAP_S, RIPPLE_RADIUS_PX, RIPPLE_S, RIPPLE_STRENGTH, RIPPLE_WAVES, RIPPLE_WAVE_S } from './ripple.js';

const BLUE = '#3C9DF5'; // the satellite and its path, nothing else
const INK = '#E6EBF0';
const MUTED = '#8A96A3';
const BACKGROUND = '#05070A';
const SUN = '#E9E4D4';

/** Day/night masks cover the world at half a degree a pixel; drawn
 * scaled up with smoothing, the terminator stays soft at any zoom. */
const MASK_COLS = 720;
const MASK_ROWS = 360;
/** Closest zoom, CSS px per degree (the 4096 pictures hold about 11). */
const MAX_PX_PER_DEG = 64;
const FOOTPRINT_POINTS = 128;

// ---- pure helpers ------------------------------------------------------------

/** Longitude wrapped into [-180, 180). */
export function wrapLon(lonDeg) {
  const t = (((lonDeg + 180) % 360) + 360) % 360;
  return t - 180;
}

/** The same longitudes without jumps of more than 180 degrees between
 * neighbours, so a line drawn through them crosses the antimeridian. */
export function unwrapLons(lons) {
  const out = new Array(lons.length);
  let prev = null;
  for (let i = 0; i < lons.length; i++) {
    const lon = prev === null ? lons[i] : prev + wrapLon(lons[i] - prev);
    out[i] = lon;
    prev = lon;
  }
  return out;
}

/** Cosine of the Sun's zenith angle at a ground point; `sun` is the unit
 * vector to the Sun in ECEF (astro.sunDirectionEcef). Its arcsine is
 * astro.sunElevationDeg. */
export function sunCosine(latDeg, lonDeg, sun) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  return c * Math.cos(lon) * sun.x + c * Math.sin(lon) * sun.y + Math.sin(lat) * sun.z;
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** How much of the day picture shows: all of it with the Sun 2 degrees up,
 * none once it is 6 degrees down (the end of civil twilight). The globe's
 * shader uses the same band, so the two views agree on the terminator. */
export function dayWeight(mu) {
  return smoothstep(-0.105, 0.035, mu);
}

/** Brightness of the day picture, falling gently toward the terminator.
 * Gentler than the globe's shading: on a flat map a strong fall-off reads
 * as a spotlight rather than as a sphere. */
export function daylight(mu) {
  return 0.45 + 0.55 * smoothstep(-0.05, 0.4, mu);
}

/** Longitude and latitude at the centre of mask pixel (i, j). */
export function maskCell(i, j, cols = MASK_COLS, rows = MASK_ROWS) {
  return { lonDeg: -180 + ((i + 0.5) * 360) / cols, latDeg: 90 - ((j + 0.5) * 180) / rows };
}

/** Mask alphas by the Sun's cosine, in steps of 1/2048 (about 0.03 degrees
 * of Sun height near the horizon), so a mask costs no powers or curves. */
const SHADE_STEPS = 4096;
let shadeTables = null;
function shades() {
  if (!shadeTables) {
    const dim = new Uint8Array(SHADE_STEPS + 1);
    const day = new Uint8Array(SHADE_STEPS + 1);
    for (let i = 0; i <= SHADE_STEPS; i++) {
      const mu = (2 * i) / SHADE_STEPS - 1;
      dim[i] = Math.round(255 * (1 - Math.pow(daylight(mu), 1 / 2.2)));
      day[i] = Math.round(255 * dayWeight(mu));
    }
    shadeTables = { dim, day };
  }
  return shadeTables;
}

/**
 * Fill two RGBA masks (cols × rows over the whole map) for the Sun at `sun`
 * (unit vector, ECEF): `dim` is black whose alpha darkens the day picture,
 * `day` is white whose alpha is dayWeight. Blending happens on sRGB values,
 * so the dimming is taken to the 1/2.2 power to match a linear fall-off.
 */
export function shadeMasks(sun, dim, day, cols = MASK_COLS, rows = MASK_ROWS) {
  const table = shades();
  const half = SHADE_STEPS / 2;
  const across = new Float64Array(cols);
  for (let i = 0; i < cols; i++) {
    const lon = maskCell(i, 0, cols, rows).lonDeg * DEG;
    across[i] = Math.cos(lon) * sun.x + Math.sin(lon) * sun.y;
  }
  for (let j = 0; j < rows; j++) {
    const lat = maskCell(0, j, cols, rows).latDeg * DEG;
    const c = Math.cos(lat);
    const s = Math.sin(lat) * sun.z;
    let o = j * cols * 4;
    for (let i = 0; i < cols; i++, o += 4) {
      const k = Math.round((c * across[i] + s + 1) * half);
      dim[o] = dim[o + 1] = dim[o + 2] = 0;
      dim[o + 3] = table.dim[k];
      day[o] = day[o + 1] = day[o + 2] = 255;
      day[o + 3] = table.day[k];
    }
  }
}

/**
 * The edge of a footprint `angle` radians around a ground point, as points
 * with continuous longitudes, ending where it started. Around a pole the
 * ring ends 360 degrees east or west of its start, which the wrapping map
 * draws as one line across the world.
 */
export function footprintRing(latDeg, lonDeg, angle, count = FOOTPRINT_POINTS) {
  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const lats = [];
  const lons = [];
  for (let i = 0; i <= count; i++) {
    const bearing = ((i % count) / count) * 2 * Math.PI;
    const sinLat2 = clamp(sinLat * cosA + cosLat * sinA * Math.cos(bearing), -1, 1);
    const lat2 = Math.asin(sinLat2);
    const dLon = Math.atan2(Math.sin(bearing) * sinA * cosLat, cosA - sinLat * sinLat2);
    lats.push(lat2 / DEG);
    lons.push(lonDeg + dLon / DEG);
  }
  const unwrapped = unwrapLons(lons);
  return lats.map((latDeg2, i) => ({ latDeg: latDeg2, lonDeg: unwrapped[i] }));
}

/**
 * Where the map is looking: `k` CSS px per degree, centred on (cLon, cLat)
 * in the frame (the part of the w × h canvas the page's panels leave free).
 * x grows east and y south; the world repeats every 360 * k px sideways.
 */
export class MapView {
  constructor() {
    this.w = 1;
    this.h = 1;
    this.k = 1;
    this.cLon = 0;
    this.cLat = 0;
    this.inset = { top: 0, right: 0, bottom: 0, left: 0 };
  }

  get cx() {
    return (this.inset.left + this.w - this.inset.right) / 2;
  }

  get cy() {
    return (this.inset.top + this.h - this.inset.bottom) / 2;
  }

  get frameHeight() {
    return Math.max(1, this.h - this.inset.top - this.inset.bottom);
  }

  /** Widest zoom: the world from pole to pole fills the frame's height,
   * and one turn of the world at least fills the canvas's width. */
  get minK() {
    return Math.max(this.frameHeight / 180, this.w / 360);
  }

  get maxK() {
    return Math.max(this.minK, MAX_PX_PER_DEG);
  }

  /** Screen x of a longitude, in the copy of the world nearest the centre. */
  x(lonDeg) {
    return this.cx + wrapLon(lonDeg - this.cLon) * this.k;
  }

  y(latDeg) {
    return this.cy + (this.cLat - latDeg) * this.k;
  }

  /** Longitude under a screen x, not wrapped: cLon plus the offset. */
  lonAt(x) {
    return this.cLon + (x - this.cx) / this.k;
  }

  latAt(y) {
    return this.cLat - (y - this.cy) / this.k;
  }

  /** Keep the zoom in range and the poles at or beyond the frame's edges. */
  clamp() {
    this.k = clamp(this.k, this.minK, this.maxK);
    const half = this.frameHeight / (2 * this.k);
    this.cLat = half >= 90 ? 0 : clamp(this.cLat, -90 + half, 90 - half);
    this.cLon = wrapLon(this.cLon);
  }

  /** Screen x positions of a longitude in every copy of the world that
   * falls within `margin` px of the canvas. */
  xs(lonDeg, margin = 0) {
    const period = 360 * this.k;
    const out = [];
    let x = this.x(lonDeg);
    while (x - period >= -margin) x -= period;
    for (; x <= this.w + margin; x += period) if (x >= -margin) out.push(x);
    return out;
  }

  /** Offsets (multiples of 360 * k px) at which a line whose unwrapped
   * longitudes run from minLon to maxLon reaches into the canvas. */
  copies(minLon, maxLon, margin = 0) {
    const period = 360 * this.k;
    const left = this.cx + (minLon - this.cLon) * this.k;
    const right = this.cx + (maxLon - this.cLon) * this.k;
    const out = [];
    for (let n = Math.ceil((-margin - right) / period); n * period + left <= this.w + margin; n++) out.push(n * period);
    return out;
  }
}

/** "30° N", "0°", "120° W", "180°". */
export function gridLabel(value, axis) {
  const v = axis === 'lon' ? wrapLon(value) : value;
  const a = Math.round(Math.abs(v) * 100) / 100;
  if (a === 0) return '0°';
  if (axis === 'lon' && a === 180) return '180°';
  const hemi = axis === 'lon' ? (v > 0 ? 'E' : 'W') : v > 0 ? 'N' : 'S';
  return `${a}° ${hemi}`;
}

/** Grid spacing in degrees: every 30 degrees, finer as you zoom in. */
export function gridStep(k) {
  const steps = [30, 10, 5, 2, 1];
  let i = 0;
  while (i < steps.length - 1 && steps[i] * k > 300) i++;
  return steps[i];
}

// ---- night lights -------------------------------------------------------------

/** The globe's shader brightens the night picture's city lights in linear
 * light; this does the same to the pixels once, after loading. */
function brightenLights(data) {
  const toLinear = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    toLinear[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const toSrgb = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) {
    const c = i / 4096;
    toSrgb[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  }
  for (let o = 0; o < data.length; o += 4) {
    const r = toLinear[data[o]];
    const g = toLinear[data[o + 1]];
    const b = toLinear[data[o + 2]];
    const f = 0.55 + 2.4 * smoothstep(0.02, 0.35, Math.max(r, g, b));
    data[o] = toSrgb[Math.min(4096, Math.round(r * f * 4096))];
    data[o + 1] = toSrgb[Math.min(4096, Math.round(g * f * 4096))];
    data[o + 2] = toSrgb[Math.min(4096, Math.round(b * f * 4096))];
  }
}

// ---- the map ----------------------------------------------------------------------

/**
 * @param {HTMLElement} container  the element the map fills (the globe's stage)
 * @param {object} opts
 */
export function createMap(container, opts = {}) {
  const {
    textureBase,
    preferSmallTextures = false,
    reducedMotion = false,
    wheelZoom = true,
    onUserMove = () => {},
  } = opts;

  const root = document.createElement('div');
  root.className = 'cg-map';
  root.hidden = true;
  const base = document.createElement('canvas');
  base.className = 'cg-map-base';
  base.setAttribute('aria-hidden', 'true');
  const over = document.createElement('canvas');
  over.className = 'cg-map-over';
  over.tabIndex = 0;
  over.setAttribute('role', 'img');
  over.setAttribute(
    'aria-label',
    'Map of the world showing CTS-SAT-1, its ground track, Calgary and where the pictures were taken',
  );
  root.append(base, over);
  container.appendChild(root);
  const bctx = base.getContext('2d');
  const octx = over.getContext('2d');

  const view = new MapView();
  const controls = { dragged: false, reducedMotion };
  let scale = 1;
  let ratio = 1;
  let visible = false;
  let disposed = false;
  let placed = false; // has the view had its first centre?
  let atWidest = true;
  let flight = null;
  let baseDirty = true;
  let overDirty = true;
  let worldDirty = true;

  // ---- the world picture ---------------------------------------------------------
  // One world-sized canvas holds the day picture, dimmed toward the
  // terminator, under the city lights where the Sun is down. It is rebuilt
  // only when the Sun moves; panning and zooming just draw it again.
  const world = document.createElement('canvas');
  const wctx = world.getContext('2d');
  const masks = {
    dim: document.createElement('canvas'),
    day: document.createElement('canvas'),
  };
  for (const m of Object.values(masks)) {
    m.width = MASK_COLS;
    m.height = MASK_ROWS;
  }
  const dimCtx = masks.dim.getContext('2d');
  const dayCtx = masks.day.getContext('2d');
  const dimData = dimCtx.createImageData(MASK_COLS, MASK_ROWS);
  const dayData = dayCtx.createImageData(MASK_COLS, MASK_ROWS);
  const pictures = { day: null, night: null };
  let textureWidth = 2048;
  let texturesRequested = false;
  let sun = null; // ECEF unit vector of the Sun for the masks drawn
  let wantSun = sunDirectionEcef(Date.now());
  let subsolar = subsolarPoint(Date.now());

  function loadTextures() {
    if (texturesRequested) return;
    texturesRequested = true;
    const big = !preferSmallTextures && Math.max(view.w, view.h) * ratio >= 1200;
    const size = big ? 4096 : 2048;
    textureWidth = size;
    worldDirty = true;
    const load = (name) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Map: could not load ${name}`));
        img.src = new URL(`${name}-${size}.jpg`, textureBase).href;
      });
    load('earth-day')
      .then((img) => {
        if (disposed) return;
        pictures.day = img;
        worldDirty = true;
      })
      .catch((err) => console.warn(err.message));
    load('earth-night')
      .then((img) => brighten(img))
      .then((bitmap) => {
        if (disposed || !bitmap) return;
        pictures.night = bitmap;
        worldDirty = true;
      })
      .catch((err) => console.warn(err.message));
  }

  /** Brighten the lights a band of rows at a time, so loading never
   * holds the page up for long. */
  async function brighten(img) {
    const work = document.createElement('canvas');
    work.width = img.naturalWidth;
    work.height = img.naturalHeight;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const band = 128;
    for (let y = 0; y < work.height; y += band) {
      if (disposed) return null;
      const rows = Math.min(band, work.height - y);
      const strip = ctx.getImageData(0, y, work.width, rows);
      brightenLights(strip.data);
      ctx.putImageData(strip, 0, y);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (typeof createImageBitmap !== 'function') return work;
    const bitmap = await createImageBitmap(work);
    work.width = work.height = 0;
    return bitmap;
  }

  /** Compose the world at the size it is shown (in 512 px steps), up to
   * the pictures' own: at the widest zoom that is a fraction of the 4096
   * pictures' pixels, which matters when the night side moves every frame.
   * It grows as you zoom in and shrinks only once well too big. */
  function sizeWorld() {
    const shown = Math.ceil((360 * view.k * ratio) / 512) * 512;
    const want = clamp(shown, 1024, textureWidth);
    if (want > world.width || want < world.width * 0.6) {
      world.width = want;
      world.height = want / 2;
      worldDirty = true;
    }
  }

  function buildWorld() {
    sun = wantSun;
    shadeMasks(sun, dimData.data, dayData.data);
    dimCtx.putImageData(dimData, 0, 0);
    dayCtx.putImageData(dayData, 0, 0);
    const W = world.width;
    const H = world.height;
    wctx.save();
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.globalCompositeOperation = 'copy';
    // front to back: lights where it's night, the dimming, the day picture
    if (pictures.night) wctx.drawImage(pictures.night, 0, 0, W, H);
    else {
      wctx.fillStyle = '#070A0E';
      wctx.fillRect(0, 0, W, H);
    }
    wctx.globalCompositeOperation = 'destination-out';
    wctx.drawImage(masks.day, 0, 0, W, H);
    wctx.globalCompositeOperation = 'destination-over';
    wctx.drawImage(masks.dim, 0, 0, W, H);
    if (pictures.day) wctx.drawImage(pictures.day, 0, 0, W, H);
    else {
      wctx.fillStyle = '#1B2631';
      wctx.fillRect(0, 0, W, H);
    }
    wctx.restore();
    worldDirty = false;
    baseDirty = true;
  }

  // ---- state from globe.js ----------------------------------------------------------
  let sat = null;
  let track = null; // { lats, lons (unwrapped), dts, split, minLon, maxLon }
  let ring = null; // footprint: { lats, lons, minLon, maxLon }
  let station = null;
  let pins = [];
  let selectedId = null;
  let hoverId = null;
  let trackColor = BLUE;
  let stationSide = 'right'; // where Calgary's label is: see drawOverlay

  function setTime(ms) {
    wantSun = sunDirectionEcef(ms);
    subsolar = subsolarPoint(ms);
    // the masks are half a degree a pixel: redraw once the Sun has moved a tenth of that
    const moved = !sun || wantSun.x * sun.x + wantSun.y * sun.y + wantSun.z * sun.z < Math.cos(0.05 * DEG);
    if (moved) worldDirty = true;
    overDirty = true;
  }

  /** sat: { latDeg, lonDeg, altKm } now, or null to hide it. */
  function setSatellite(s) {
    sat = s ? { latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.altKm } : null;
    if (sat) {
      const r = footprintRing(sat.latDeg, sat.lonDeg, footprintAngle(sat.altKm));
      const lons = r.map((p) => p.lonDeg);
      ring = { lats: r.map((p) => p.latDeg), lons, minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    } else {
      ring = null;
      track = null;
    }
    overDirty = true;
  }

  /** samples: [{ latDeg, lonDeg, dtMin }] in time order; dtMin < 0 is the past. */
  function setTrack(samples) {
    if (!samples || samples.length < 2) {
      track = null;
      overDirty = true;
      return;
    }
    const lons = unwrapLons(samples.map((s) => s.lonDeg));
    let split = samples.findIndex((s) => s.dtMin >= 0);
    if (split < 0) split = samples.length - 1;
    track = {
      lats: samples.map((s) => s.latDeg),
      lons,
      split,
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
    overDirty = true;
  }

  function setStation(latDeg, lonDeg) {
    station = { latDeg, lonDeg };
    overDirty = true;
  }

  /** The orbit's colour: track, footprint and satellite (team blue by default). */
  function setTrackColor(color) {
    trackColor = color;
    overDirty = true;
  }

  function setPins(list) {
    pins = list.map((p) => ({ id: p.id, latDeg: p.latDeg, lonDeg: p.lonDeg }));
    overDirty = true;
  }

  function setSelected(id) {
    selectedId = id;
    overDirty = true;
  }

  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    overDirty = true;
  }

  // ---- view ------------------------------------------------------------------------
  function changed() {
    view.clamp();
    atWidest = view.k <= view.minK * 1.0001;
    baseDirty = true;
    overDirty = true;
  }

  /** Zoom by `factor` keeping the point under (x, y) where it is. */
  function zoomAt(x, y, factor) {
    const lon = view.lonAt(x);
    const lat = view.latAt(y);
    view.k = clamp(view.k * factor, view.minK, view.maxK);
    view.cLon = lon - (x - view.cx) / view.k;
    view.cLat = lat + (y - view.cy) / view.k;
    flight = null;
    changed();
  }

  function panBy(dx, dy) {
    view.cLon -= dx / view.k;
    view.cLat += dy / view.k;
    flight = null;
    changed();
  }

  /** Move the view's centre to a point, eased unless reduced motion. */
  function flyTo(lonDeg, latDeg, { k = view.k, immediate = false } = {}) {
    const to = { lon: view.cLon + wrapLon(lonDeg - view.cLon), lat: latDeg, k: clamp(k, view.minK, view.maxK) };
    if (immediate || controls.reducedMotion || !visible) {
      flight = null;
      view.cLon = to.lon;
      view.cLat = to.lat;
      view.k = to.k;
      changed();
      return;
    }
    flight = { from: { lon: view.cLon, lat: view.cLat, k: view.k }, to, start: performance.now(), duration: 700 };
  }

  function stepFlight(now) {
    if (!flight) return;
    const f = flight;
    const t = Math.min(1, (now - f.start) / f.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    view.k = f.from.k * Math.pow(f.to.k / f.from.k, e);
    view.cLon = f.from.lon + (f.to.lon - f.from.lon) * e;
    view.cLat = f.from.lat + (f.to.lat - f.from.lat) * e;
    if (t >= 1) flight = null;
    changed();
  }

  /** Is a ground point inside the free frame, `margin` px from its edges? */
  function inFrame(latDeg, lonDeg, margin = 48) {
    const x = view.x(lonDeg);
    const y = view.y(latDeg);
    const i = view.inset;
    // more room on the right, where a marker's label goes
    const right = view.w - i.right - margin - 70 * scale;
    return x >= i.left + margin && x <= right && y >= i.top + margin && y <= view.h - i.bottom - margin;
  }

  /** Bring a ground point into view: the map only moves if it has to. While
   * nearly the whole world fits, it opens the usual way round, 0° in the
   * middle. */
  function flyToGround(latDeg, lonDeg, { immediate = false } = {}) {
    if (!placed) {
      placed = true;
      const span = (view.w - view.inset.left - view.inset.right) / view.k;
      if (span < 300 || !inFrame(latDeg, lonDeg)) flyTo(lonDeg, latDeg, { immediate: true });
      return;
    }
    if (inFrame(latDeg, lonDeg)) return;
    flyTo(lonDeg, latDeg, { immediate });
  }

  function flyToSatellite({ immediate = false } = {}) {
    if (sat) flyToGround(sat.latDeg, sat.lonDeg, { immediate });
  }

  /** Follow mode: keep the satellite at the centre. */
  function follow() {
    if (!sat) return;
    if (flight) {
      flight.to.lon = flight.from.lon + wrapLon(sat.lonDeg - flight.from.lon);
      flight.to.lat = sat.latDeg;
      return;
    }
    if (Math.abs(wrapLon(sat.lonDeg - view.cLon)) * view.k < 0.25 && Math.abs(sat.latDeg - view.cLat) * view.k < 0.25) return;
    view.cLon = sat.lonDeg;
    view.cLat = sat.latDeg;
    changed();
  }

  function zoomBy(factor) {
    const k = clamp(view.k * factor, view.minK, view.maxK);
    if (controls.reducedMotion) {
      zoomAt(view.cx, view.cy, k / view.k);
      return;
    }
    flight = { from: { lon: view.cLon, lat: view.cLat, k: view.k }, to: { lon: view.cLon, lat: view.cLat, k }, start: performance.now(), duration: 260 };
  }

  // ---- pointer, wheel ---------------------------------------------------------------
  const pointers = new Map();
  let pinch = null;
  const local = (e) => {
    const r = over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button > 0) return;
    over.setPointerCapture?.(e.pointerId);
    // a second finger makes this a gesture, never a tap
    controls.dragged = pointers.size > 0;
    const p = local(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, panning: false });
    flight = null;
    pinch = null;
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const q = local(e);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    p.x = q.x;
    p.y = q.y;
    if (!p.panning && Math.hypot(p.x - p.x0, p.y - p.y0) > 4) {
      p.panning = true;
      controls.dragged = true;
      root.classList.add('cg-map-dragging');
    }
    if (pointers.size === 1) {
      if (!p.panning) return;
      panBy(dx, dy);
      onUserMove('pan');
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch && span > 0) {
        panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
        zoomAt(mid.x, mid.y, span / pinch.span);
        onUserMove('zoom');
      }
      pinch = { span, mid };
    }
  }

  function onPointerUp(e) {
    if (!pointers.delete(e.pointerId)) return;
    over.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) root.classList.remove('cg-map-dragging');
  }

  function onWheel(e) {
    if (!wheelZoom && !e.ctrlKey) return;
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * lines * 0.0015));
    onUserMove('zoom');
  }

  function onDoubleClick(e) {
    const p = local(e);
    zoomAt(p.x, p.y, e.shiftKey ? 0.5 : 2);
    onUserMove('zoom');
  }

  over.addEventListener('pointerdown', onPointerDown);
  over.addEventListener('pointermove', onPointerMove);
  over.addEventListener('pointerup', onPointerUp);
  over.addEventListener('pointercancel', onPointerUp);
  over.addEventListener('wheel', onWheel, { passive: false });
  over.addEventListener('dblclick', onDoubleClick);

  const fontsReady = () => {
    overDirty = true;
  };
  document.fonts?.addEventListener?.('loadingdone', fontsReady);
  document.fonts?.ready?.then(fontsReady);

  // ---- drawing -----------------------------------------------------------------------
  const font = (weight, px) => `${weight} ${px * scale}px Jost, system-ui, -apple-system, "Segoe UI", sans-serif`;

  function drawBase() {
    bctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    bctx.fillStyle = BACKGROUND;
    bctx.fillRect(0, 0, view.w, view.h);
    const W = 360 * view.k;
    const H = 180 * view.k;
    const top = view.y(90);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = view.k * ratio < world.width / 360 ? 'high' : 'medium';
    for (const dx of view.copies(-180, 180)) {
      bctx.drawImage(world, view.cx + (-180 - view.cLon) * view.k + dx, top, W, H);
    }
    baseDirty = false;
  }

  /** Stroke a line through points with unwrapped longitudes, in every copy
   * of the world it reaches. */
  function strokeLine(lats, lons, from, to, minLon, maxLon) {
    for (const dx of view.copies(minLon, maxLon, 8)) {
      octx.beginPath();
      for (let i = from; i <= to; i++) {
        const x = view.cx + (lons[i] - view.cLon) * view.k + dx;
        const y = view.y(lats[i]);
        if (i === from) octx.moveTo(x, y);
        else octx.lineTo(x, y);
      }
      octx.stroke();
    }
  }

  function halo(text, x, y) {
    octx.strokeText(text, x, y);
    octx.fillText(text, x, y);
  }

  function drawGrid() {
    const step = gridStep(view.k);
    const i = view.inset;
    const top = Math.max(0, view.y(90));
    const bottom = Math.min(view.h, view.y(-90));
    const px = 1 / ratio;
    octx.lineWidth = px;
    octx.strokeStyle = 'rgba(230, 235, 240, 0.16)';
    octx.beginPath();
    const west = view.lonAt(0);
    const east = view.lonAt(view.w);
    const lons = [];
    for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
      const x = Math.round((view.cx + (lon - view.cLon) * view.k) * ratio) / ratio + px / 2;
      octx.moveTo(x, top);
      octx.lineTo(x, bottom);
      lons.push({ lon, x });
    }
    const lats = [];
    for (let lat = -90 + step; lat < 90; lat += step) {
      const y = Math.round(view.y(lat) * ratio) / ratio + px / 2;
      if (y < top || y > bottom) continue;
      octx.moveTo(0, y);
      octx.lineTo(view.w, y);
      lats.push({ lat, y });
    }
    octx.stroke();

    // labels on the free frame's left and bottom edges
    octx.font = font(400, 13);
    octx.fillStyle = MUTED;
    octx.lineWidth = 3 * scale;
    octx.strokeStyle = 'rgba(5, 7, 10, 0.85)';
    octx.textBaseline = 'alphabetic';
    const gap = 6 * scale;
    const baseY = Math.min(view.h - i.bottom, bottom) - gap;
    const latFloor = baseY - 18 * scale; // keep clear of the longitude labels
    octx.textAlign = 'left';
    // where the world is small (a phone with a sheet open) lines are closer
    // than their labels are long: a label that would touch the last is skipped
    let lastY = Infinity;
    for (const { lat, y } of lats) {
      if (y - gap < i.top + 14 * scale || y - gap > latFloor) continue;
      if (lastY - y < 18 * scale) continue;
      halo(gridLabel(lat, 'lat'), i.left + 8 * scale, y - gap);
      lastY = y;
    }
    let lastRight = -Infinity;
    for (const { lon, x } of lons) {
      const text = gridLabel(lon, 'lon');
      const tw = octx.measureText(text).width;
      if (x + gap < i.left || x + gap + tw > view.w - i.right) continue;
      if (x + gap < lastRight + gap) continue;
      halo(text, x + gap, baseY);
      lastRight = x + gap + tw;
    }
  }

  function square(x, y, size, fill) {
    const h = size / 2;
    octx.fillStyle = BACKGROUND;
    octx.fillRect(x - h, y - h, size, size);
    const o = 1.5 * scale;
    octx.fillStyle = fill;
    octx.fillRect(x - h + o, y - h + o, size - 2 * o, size - 2 * o);
  }

  function diamond(x, y, size, fill) {
    const path = (r) => {
      octx.beginPath();
      octx.moveTo(x, y - r);
      octx.lineTo(x + r, y);
      octx.lineTo(x, y + r);
      octx.lineTo(x - r, y);
      octx.closePath();
    };
    path(size / 2 + 0.5 * scale);
    octx.fillStyle = BACKGROUND;
    octx.fill();
    path(size / 2 - 1.5 * scale);
    octx.fillStyle = fill;
    octx.fill();
  }

  function disc(x, y, size, fill) {
    octx.beginPath();
    octx.arc(x, y, size / 2, 0, 2 * Math.PI);
    octx.fillStyle = BACKGROUND;
    octx.fill();
    octx.beginPath();
    octx.arc(x, y, size / 2 - 1.5 * scale, 0, 2 * Math.PI);
    octx.fillStyle = fill;
    octx.fill();
  }

  function sunMark(x, y, size) {
    octx.strokeStyle = SUN;
    octx.lineWidth = 1.5 * scale;
    octx.beginPath();
    octx.arc(x, y, size * 0.33, 0, 2 * Math.PI);
    octx.stroke();
    octx.fillStyle = SUN;
    octx.beginPath();
    octx.arc(x, y, size * 0.13, 0, 2 * Math.PI);
    octx.fill();
  }

  const pinSize = (id) => (id === selectedId ? 12 : id === hoverId ? 10 : 8) * scale;

  // the red waves from the pins when "Highlight photos" is pressed (ripple.js)
  let rippleStart = null;
  let rippleSeconds = 0;

  function drawRipples() {
    const reach = RIPPLE_RADIUS_PX * scale;
    octx.save();
    octx.strokeStyle = RIPPLE_COLOR;
    for (const p of pins) {
      const y = view.y(p.latDeg);
      for (const x of view.xs(p.lonDeg, reach)) {
        for (let i = 0; i < RIPPLE_WAVES; i++) {
          const w = (rippleSeconds - i * RIPPLE_GAP_S) / RIPPLE_WAVE_S;
          if (w < 0 || w > 1) continue;
          const a = RIPPLE_STRENGTH * Math.min(1, w / 0.18) * (1 - w);
          octx.beginPath();
          octx.arc(x, y, reach * (0.06 + 0.84 * (1 - (1 - w) * (1 - w))), 0, 2 * Math.PI);
          // a wide faint stroke under a thin one: the shader's soft ring, in canvas
          octx.globalAlpha = a * 0.45;
          octx.lineWidth = 6 * scale;
          octx.stroke();
          octx.globalAlpha = a;
          octx.lineWidth = 2 * scale;
          octx.stroke();
        }
      }
    }
    octx.restore();
  }

  function drawOverlay() {
    octx.setTransform(ratio, 0, 0, ratio, 0, 0);
    octx.clearRect(0, 0, view.w, view.h);
    octx.lineJoin = 'round';
    octx.lineCap = 'round';
    drawGrid();

    octx.strokeStyle = trackColor;
    if (ring) {
      octx.lineWidth = 1.5 * scale;
      octx.globalAlpha = 0.5;
      strokeLine(ring.lats, ring.lons, 0, ring.lats.length - 1, ring.minLon, ring.maxLon);
      octx.globalAlpha = 1;
    }
    if (track && sat) {
      octx.lineWidth = 2 * scale;
      octx.globalAlpha = 0.35;
      strokeLine(track.lats, track.lons, 0, track.split, track.minLon, track.maxLon);
      octx.globalAlpha = 1;
      strokeLine(track.lats, track.lons, track.split, track.lats.length - 1, track.minLon, track.maxLon);
    }

    const m = 24 * scale;
    for (const x of view.xs(subsolar.lonDeg, m)) sunMark(x, view.y(subsolar.latDeg), 13 * scale);
    const stationXs = station ? view.xs(station.lonDeg, m) : [];
    for (const x of stationXs) diamond(x, view.y(station.latDeg), 10 * scale, INK);

    if (rippleStart !== null) drawRipples();

    const order = pins.filter((p) => p.id !== selectedId && p.id !== hoverId);
    for (const id of [hoverId, selectedId]) {
      const p = id && pins.find((q) => q.id === id);
      if (p && !order.includes(p)) order.push(p);
    }
    for (const p of order) {
      const fill = p.id === selectedId || p.id === hoverId ? INK : MUTED;
      for (const x of view.xs(p.lonDeg, m)) square(x, view.y(p.latDeg), pinSize(p.id), fill);
    }

    const satXs = sat ? view.xs(sat.lonDeg, m) : [];
    for (const x of satXs) disc(x, view.y(sat.latDeg), 11 * scale, trackColor);

    // labels last, over everything
    octx.font = font(500, 13);
    octx.textAlign = 'left';
    octx.textBaseline = 'middle';
    octx.lineWidth = 3 * scale;
    octx.strokeStyle = 'rgba(5, 7, 10, 0.85)';
    octx.fillStyle = INK;
    for (const x of satXs) halo('CTS-SAT-1', x + 12 * scale, view.y(sat.latDeg));
    if (station) {
      // the satellite's name wins: Calgary's moves aside, or waits, while they overlap
      const h = 16 * scale;
      const reach = 8 * scale;
      const satY = sat ? view.y(sat.latDeg) : 0;
      const satW = octx.measureText('CTS-SAT-1').width;
      const avoid = satXs.flatMap((x) => [
        labelBox('right', { x, y: satY, w: satW, h, gap: 12 * scale }),
        { left: x - reach, top: satY - reach, right: x + reach, bottom: satY + reach },
      ]);
      // and it stays on the map: past the frame's right edge it would be cut off
      const edge = view.w - view.inset.right;
      avoid.push({ left: edge, top: -Infinity, right: Infinity, bottom: Infinity });
      const w = octx.measureText('Calgary').width;
      const y = view.y(station.latDeg);
      stationXs.forEach((x, i) => {
        const label = { x, y, w, h, gap: 11 * scale };
        const side = placeLabel(label, avoid, stationSide);
        if (i === 0) stationSide = side;
        if (side) {
          const box = labelBox(side, label);
          halo('Calgary', box.left, (box.top + box.bottom) / 2);
        }
      });
    }
    overDirty = false;
  }

  /** What is under a canvas point (CSS px)? Same shape as scene.pick. */
  function pick(x, y, radius = 12) {
    if (!visible) return null;
    let best = null;
    let bestD = radius;
    const consider = (latDeg, lonDeg, hit) => {
      const py = view.y(latDeg);
      for (const px of view.xs(lonDeg, radius)) {
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) {
          bestD = d;
          best = { ...hit, x: px, y: py };
        }
      }
    };
    if (station) consider(station.latDeg, station.lonDeg, { type: 'station' });
    consider(subsolar.latDeg, subsolar.lonDeg, { type: 'subsolar' });
    for (const p of pins) consider(p.latDeg, p.lonDeg, { type: 'photo', id: p.id });
    // the satellite wins ties: it is the thing people most often reach for
    if (sat) {
      const py = view.y(sat.latDeg);
      for (const px of view.xs(sat.lonDeg, radius)) {
        if (Math.hypot(px - x, py - y) < radius) best = { type: 'satellite', x: px, y: py };
      }
    }
    return best;
  }

  /** `scale` sizes markers and type with the page (1 = their drawn size);
   * `inset` is how much of each edge the page's panels cover. */
  function resize(w, h, s = 1, inset = null) {
    view.w = Math.max(1, w);
    view.h = Math.max(1, h);
    scale = s;
    if (inset) view.inset = { top: 0, right: 0, bottom: 0, left: 0, ...inset };
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [base, over]) {
      const cw = Math.round(view.w * ratio);
      const ch = Math.round(view.h * ratio);
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
    }
    if (atWidest) view.k = view.minK;
    changed();
  }

  function setVisible(on) {
    visible = on;
    root.hidden = !on;
    if (on) {
      loadTextures();
      baseDirty = true;
      overDirty = true;
    } else {
      flight = null;
    }
  }

  return {
    element: root,
    canvas: over,
    controls,
    view,
    setTime,
    setSatellite,
    setTrack,
    setStation,
    setTrackColor,
    setPins,
    highlightPins() {
      rippleStart = performance.now();
      overDirty = true;
    },
    setSelected,
    setHover,
    flyToGround,
    flyToSatellite,
    follow,
    zoomBy,
    pick,
    resize,
    setVisible,
    get visible() {
      return visible;
    },
    /** Is the view moving to somewhere? */
    get busy() {
      return !!flight;
    },
    /** Draw whatever changed; returns true if anything was drawn. */
    frame(now) {
      if (!visible) return false;
      if (rippleStart !== null) {
        rippleSeconds = Math.max(0, (now - rippleStart) / 1000);
        if (rippleSeconds >= RIPPLE_S) rippleStart = null;
        overDirty = true;
      }
      stepFlight(now);
      sizeWorld();
      const drawWorld = worldDirty;
      if (worldDirty) buildWorld();
      const drawB = baseDirty;
      if (baseDirty) drawBase();
      const drawO = overDirty;
      if (overDirty) drawOverlay();
      return drawWorld || drawB || drawO;
    },
    dispose() {
      disposed = true;
      over.removeEventListener('pointerdown', onPointerDown);
      over.removeEventListener('pointermove', onPointerMove);
      over.removeEventListener('pointerup', onPointerUp);
      over.removeEventListener('pointercancel', onPointerUp);
      over.removeEventListener('wheel', onWheel);
      over.removeEventListener('dblclick', onDoubleClick);
      document.fonts?.removeEventListener?.('loadingdone', fontsReady);
      pictures.night?.close?.();
      world.width = world.height = 0;
      root.remove();
    },
  };
}
