/**
 * The landing's scroll story: the Earth alone, the camera swinging to where
 * CTS-SAT-1 is right now, then the satellite, its orbit and the pictures'
 * pins, handed over to the visitor. See docs/design-direction.md section 3.
 *
 *   import { mountJourney } from './explore/journey.js';
 *   const journey = mountJourney(container, {
 *     photos,                       // mergeAll() output from assets/data.js
 *     tleUrl: 'data/tle.json',
 *     onOpenPhoto(id) {},           // a pin, a card, the panel's latest picture
 *     onOpenCatalogue() {},         // "See the pictures", "See all n pictures"
 *   });
 *   journey.setPhotos(photos); journey.hide(); journey.show(); journey.getState();
 *   journey.openCredits(navButton); journey.live(); journey.playIntroAgain();
 *
 * The page needs an import map for "three" (site/explore/satellite.js uses
 * the bare specifier); this module imports the same file by path.
 *
 * Scroll, always: the container gets a section 300svh + 100dvh tall with a
 * sticky stage, so the stage is held for 300svh and progress p runs 0..1
 * over it. Native scroll only; nothing plays on a timer. The camera follows
 * p through a light damped lerp (none under reduced motion). Nothing is
 * rendered after the section: the page ends with the story.
 *   0    - 0.12  beat 1, the Earth facing Calgary, h1 block, "Scroll to learn more"
 *   0.14 - 0.60  the swing (the only travelling camera move)
 *   0.52 - 0.74  beat 2, the live sentence
 *   0.62 - 0.68  satellite and orbit fade in (scrubbed)
 *   0.74 -       beat 3, the instruction (until the first drag or click)
 *   0.80 -       pins, time, zoom, "See all n pictures"; drag enabled
 *   1, at rest   the end locks: the section collapses to one screen, the
 *                wheel over the globe zooms, "Play the intro again" undoes it;
 *                remembered for the browser session (sessionStorage)
 * Under prefers-reduced-motion the page opens locked at the end, with the
 * h1 block and the live sentence in the sky.
 *
 * Frames (as site/globe/scene.js): three.js y-up, ECI (x, y, z) drawn at
 * (x, z, -y), 1 unit = the mean Earth radius; the Earth turns by GMST, the
 * satellite and its orbit live in the inertial frame.
 */
import * as THREE from '../globe/vendor/three.module.min.js';
import {
  CALGARY,
  DEG,
  EARTH_RADIUS_KM,
  LAUNCH_MS,
  Orbit,
  findPasses,
  gmst as gmstAt,
  makeObserver,
  satelliteLight,
  sunElevationDeg,
  sunPosition,
} from '../globe/astro.js';
import { createScreenLine } from './journey-line.js';
import {
  calgaryTime,
  drawStillEarth,
  duration,
  fallbackEarth,
  fallbackSatellite,
  fmtLat,
  fmtLatShort,
  fmtLon,
  fmtLonShort,
  isSquare,
  launchDate,
  photoTime,
  placeOf,
  statusLine,
  utcShort,
} from './journey-parts.js';
import { regionAt } from './journey-region.js';

const MODULE_BASE = new URL('./', import.meta.url);
const SITE_ROOT = new URL('../', import.meta.url);

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const SPEEDS = [1, 60, 600];
const STATE_VERSION = 2;

/** Scroll points (fractions of the hold). */
const P = {
  h1Out: 0.12,
  swingStart: 0.14,
  swingEnd: 0.6,
  beat2In: 0.52,
  satIn: 0.62,
  satFull: 0.68,
  beat2Out: 0.74,
  ui: 0.8,
};

/** The end view: this far behind the satellite, the height solved so the limb sits under the text. */
const CHASE_BEHIND_KM = 1400;
/**
 * Headings tried for the end view, radians off the track, best first. Straight
 * behind, the camera sits in the orbit's plane and the 3U shows only its end;
 * the side is picked so the track stays clear of the text (chooseYaw).
 */
const YAW_CANDIDATES = [-0.52, -0.36, -0.7, -0.22, -0.9, 0.52, 0.36, 0.7, 0.22, 0.9];
/** Close up, the camera levels out to this pitch so the limb sits behind the satellite. */
const CLOSE_PITCH = 18 * DEG;
/** Long swings rise this much (times the beat 1 distance) at their middle so they don't whip. */
const SWING_LIFT = 0.6;
const SCROLL_LAG_S = 0.12;
const ZOOM_LAG_S = 0.14;
const BLEND_MS = 600;
/** Breathing room between the text column and the track, CSS px. */
const TEXT_MARGIN = 48;

const SPACE = '#05070A';
const BLUE = '#3C9DF5';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

let uid = 0;

const ICON_MINUS = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

/** Set for the rest of the browser session once the story has been scrolled to its end. */
const LOCK_KEY = 'cts1-journey-ended';
const sessionGet = (k) => {
  try {
    return window.sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const sessionSet = (k, v) => {
  try {
    if (v === null) window.sessionStorage.removeItem(k);
    else window.sessionStorage.setItem(k, v);
  } catch { /* storage blocked: the lock just isn't remembered */ }
};

function template(id, siteRoot) {
  const logo = new URL('assets/calgarytospace-logo.png', siteRoot).href;
  return `
  <section class="jy" aria-label="CTS-SAT-1 right now">
    <div class="jy-stage">
      <canvas class="jy-canvas" tabindex="-1"
        aria-label="The Earth and CTS-SAT-1. Drag or use the arrow keys to look around; plus and minus zoom."></canvas>
      <canvas class="jy-still" hidden aria-hidden="true"></canvas>
      <div class="jy-marks">
        <button type="button" class="jy-sat" data-ref="sat" hidden
          aria-label="CTS-SAT-1: where it is now and its latest picture"><span class="jy-sat-label" aria-hidden="true">CTS-SAT-1</span></button>
      </div>
      <div class="jy-card" data-ref="card" hidden></div>

      <div class="jy-text">
        <div class="jy-beat jy-b1" data-ref="b1">
          <h1 class="jy-h1"><span class="jy-words">CTS-SAT-1</span></h1>
          <p class="jy-lead jy-intro-lead"><span class="jy-words">Calgary To Space’s first satellite, built by University of Calgary students and in orbit since ${launchDate}.</span></p>
          <p class="jy-lead jy-live-lead"><span class="jy-words" data-ref="liveLead"></span></p>
          <p class="jy-cue" data-ref="cue" tabindex="-1"><span class="jy-words">Scroll to learn more</span> ${ICON_DOWN}</p>
        </div>
        <p class="jy-beat jy-statement jy-b2" data-ref="b2"><span class="jy-words" data-ref="b2t"></span></p>
        <p class="jy-beat jy-statement jy-b3" data-ref="b3"><span class="jy-words" data-ref="b3t"></span></p>
      </div>

      <div class="jy-time" data-ref="time" role="group" aria-label="Time">
        <p class="jy-clock"><span class="jy-clock-main" data-ref="clockMain"></span><span class="jy-clock-sub" data-ref="clockSub"></span></p>
        <div class="jy-speed" role="radiogroup" aria-label="Speed">
          ${SPEEDS.map((s) => `<label><input type="radio" name="jy-speed-${id}" value="${s}"${s === 1 ? ' checked' : ''}><span>${s}×</span></label>`).join('')}
        </div>
        <button type="button" class="jy-btn jy-now" data-ref="now">Now</button>
      </div>

      <div class="jy-corner" data-ref="corner">
        <button type="button" class="jy-textbtn jy-again" data-ref="again">Play the intro again</button>
        <a class="jy-btn jy-all" data-ref="all"></a>
        <div class="jy-zoom" role="group" aria-label="Zoom">
          <button type="button" class="jy-sq" data-ref="zoomOut" aria-label="Zoom out">${ICON_MINUS}</button>
          <button type="button" class="jy-sq" data-ref="zoomIn" aria-label="Zoom in">${ICON_PLUS}</button>
        </div>
      </div>

      <section class="jy-credits" id="jy-credits-${id}" data-ref="credits" hidden role="dialog" aria-modal="false"
        aria-labelledby="jy-credits-title-${id}">
        <div class="jy-panel-head">
          <h2 class="jy-panel-title" id="jy-credits-title-${id}" tabindex="-1">Credits</h2>
          <button type="button" class="jy-textbtn" data-ref="creditsClose">Close</button>
        </div>
        <img class="jy-credits-logo" src="${logo}" width="640" height="204" alt="CalgaryToSpace">
        <p>Earth: NASA Blue Marble, Black Marble and cloud imagery. Orbital elements:
          <a class="jy-link" href="https://www.space-track.org/">Space-Track.org</a>. Packets: the
          <a class="jy-link" href="https://network.satnogs.org/">SatNOGS network</a> and the CalgaryToSpace ground station.
          Place names: © <a class="jy-link" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.</p>
        <p>CubeSat model: NASA IceCube, a 3U like CTS-SAT-1, by NASA/Christopher R. Meaney (NASA 3D Resources,
          public domain); drawn far larger than life.</p>
        <ul class="jy-credits-links">
          <li><a class="jy-link" href="https://www.calgarytospace.ca/">calgarytospace.ca</a></li>
          <li><a class="jy-link" href="https://github.com/CalgaryToSpace">github.com/CalgaryToSpace</a></li>
        </ul>
        <div class="jy-news-slot" data-ref="newsSlot"></div>
      </section>

      <div class="jy-facts-slot" data-ref="factsSlot"></div>

      <aside class="jy-panel" data-ref="panel" hidden aria-labelledby="jy-panel-title-${id}">
        <button type="button" class="jy-grab" data-ref="grab" aria-hidden="true" tabindex="-1"><span></span></button>
        <div class="jy-panel-head">
          <h2 class="jy-panel-title" id="jy-panel-title-${id}" tabindex="-1">CTS-SAT-1</h2>
          <div class="jy-panel-tools">
            <button type="button" class="jy-textbtn" data-ref="follow" aria-pressed="true">Following</button>
            <button type="button" class="jy-textbtn jy-more" data-ref="more" aria-expanded="false">More</button>
            <button type="button" class="jy-textbtn" data-ref="close">Close</button>
          </div>
        </div>
        <p class="jy-small jy-muted" data-ref="aka">Also called FrontierSat.</p>
        <p class="jy-lead jy-over" data-ref="over"></p>
        <div class="jy-panel-body" data-ref="panelBody">
          <p class="jy-panel-zoom"><button type="button" class="jy-textbtn" data-ref="zoomSat">Zoom in on the satellite</button></p>
          <dl class="jy-facts">
            <dt>Altitude</dt><dd data-ref="fAlt"></dd>
            <dt>Speed</dt><dd data-ref="fSpeed"></dd>
            <dt>Position</dt><dd data-ref="fPos"></dd>
            <dt>Sunlight</dt><dd data-ref="fSun"></dd>
            <dt>Next over Calgary</dt><dd data-ref="fPass"></dd>
            <dt>Orbits so far</dt><dd data-ref="fRev"></dd>
          </dl>
          <p class="jy-small jy-muted jy-elements" data-ref="elements"></p>
          <p class="jy-small jy-retry" data-ref="noOrbit" hidden>Couldn’t work out where it is: no orbital elements loaded.
            <button type="button" class="jy-textbtn" data-ref="retry">Try again</button></p>
          <section class="jy-latest" data-ref="latest" hidden>
            <h3 class="jy-latest-title">Latest picture</h3>
            <a class="jy-latest-frame" data-ref="latestFrame"><img data-ref="latestImg" alt="" decoding="async"></a>
            <p class="jy-latest-failed" data-ref="latestFailed" hidden>The picture didn’t load.
              <button type="button" class="jy-textbtn" data-ref="latestRetry">Try again</button></p>
            <p class="jy-latest-place" data-ref="latestPlace"></p>
            <p class="jy-small jy-muted" data-ref="latestTime"></p>
            <p class="jy-small" data-ref="latestStatus"></p>
            <a class="jy-link" data-ref="latestOpen">Open in the catalogue</a>
          </section>
        </div>
      </aside>
    </div>
  </section>`;
}

/**
 * @param {HTMLElement} container
 * @param {object} options
 * @param {object[]} [options.photos]
 * @param {string} [options.tleUrl]
 * @param {'high'|'low'|'phone'|'auto'} [options.quality]  earth.js map size; auto picks
 * @param {(id: string) => void} [options.onOpenPhoto]
 * @param {() => void} [options.onOpenCatalogue]
 * @param {string} [options.siteRoot]  resolves the photos' relative src/thumb paths
 * @param {(id: string) => string} [options.photoHref]  href on pins and links (for new-tab opening)
 * @param {string} [options.catalogueHref]
 * @param {string} [options.textureBase]  passed to earth.js
 * @param {string} [options.modelUrl]  passed to satellite.js
 * @param {object} [options.initialState]  from getState(), e.g. after a reload
 * @param {'full'|'reduced'} [options.motion]  overrides prefers-reduced-motion
 */
export function mountJourney(container, options = {}) {
  const id = ++uid;
  const siteRoot = new URL(options.siteRoot || SITE_ROOT.href, document.baseURI);
  const opts = {
    photos: [],
    tleUrl: new URL('data/tle.json', siteRoot).href,
    quality: 'auto',
    onOpenPhoto: () => {},
    onOpenCatalogue: () => {},
    photoHref: (pid) => new URL(`index.html#/photo/${encodeURIComponent(pid)}`, siteRoot).href,
    catalogueHref: new URL('index.html#/', siteRoot).href,
    textureBase: undefined,
    modelUrl: undefined,
    initialState: null,
    motion: null,
    ...options,
  };

  ensureStylesheet();
  const root = document.createElement('div');
  root.className = 'jy-root';
  root.innerHTML = template(id, siteRoot);
  container.appendChild(root);
  const ref = {};
  for (const node of root.querySelectorAll('[data-ref]')) ref[node.dataset.ref] = node;
  const section = root.querySelector('.jy');
  const stage = root.querySelector('.jy-stage');
  const canvas = root.querySelector('.jy-canvas');
  const still = root.querySelector('.jy-still');
  const marks = root.querySelector('.jy-marks');

  const cleanups = [];
  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
  let motionOverride = opts.motion === 'full' || opts.motion === 'reduced' ? opts.motion : null;
  const reducedMotion = () => (motionOverride ? motionOverride === 'reduced' : motionQuery.matches);

  // ---- state -----------------------------------------------------------------
  const state = {
    mode: 'story', // 'story', or 'still' without WebGL
    shown: true,
    visible: true, // on screen (IntersectionObserver)
    pTarget: 0,
    pSmooth: 0,
    live: true,
    speed: 1,
    simMs: Date.now(),
    follow: true, // camera on the satellite (else orbiting the Earth's centre)
    custom: false, // the visitor moved or zoomed the camera
    yaw: 0,
    pitch: 0,
    dist: 0,
    distTarget: 0,
    theta: 0,
    phi: Math.PI / 2,
    cdist: 3,
    cdistTarget: 3,
    panel: false,
    sheetOpen: false,
    creditsOpen: false,
    selectedId: null,
    hintDismissed: false,
    // the story was scrolled to its end: the section collapses to one screen
    // and the globe stays; "Play the intro again" undoes it
    locked: false,
    wantLock: false, // a restored state that was locked
    lastScrollAt: 0,
    offsetPx: 0, // page scroll relative to the section's top
    sectionPx: 0,
    saved: null, // { progress, offset, height } kept while hidden, or from initialState
  };
  let photos = [];
  let pins = [];
  let latest = null;
  let orbit = null;
  let orbitStatus = 'loading'; // 'loading' | 'ok' | 'failed'
  let destroyed = false;
  let webgl = true;

  // ---- renderer and scene ------------------------------------------------------
  let renderer = null;
  const scene = new THREE.Scene();
  // near 0.005 (about 32 km) at every zoom: the satellite never gets nearer than that, see zoomLimits
  const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 60);
  const scoreCamera = new THREE.PerspectiveCamera(35, 1, 0.005, 60);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
  const ambient = new THREE.AmbientLight(0xffffff, 0.05);
  scene.add(sunLight, sunLight.target, ambient);
  const satHolder = new THREE.Group();
  satHolder.visible = false;
  scene.add(satHolder);
  const orbitLine = createScreenLine(260, { color: BLUE, widthPx: 2 });
  scene.add(orbitLine.mesh);
  orbitLine.setOpacity(0);

  let earth = null;
  let earthReady = false;
  let satellite = null;
  let satMaterials = [];
  let satOpacity = -1;

  // earth.js map sizes: 'high' 8192, 'low' 4096, 'phone' 2048 (it steps down
  // itself when the GPU can't take the size)
  const quality = (() => {
    if (['high', 'low', 'phone'].includes(opts.quality)) return opts.quality;
    const mem = navigator.deviceMemory;
    if (window.innerWidth <= 820 || touchQuery.matches || (mem && mem <= 4)) return 'phone';
    const px = (window.screen?.width || window.innerWidth) * (window.devicePixelRatio || 1);
    return px >= 2560 ? 'high' : 'low';
  })();

  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor(SPACE, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
  } catch (err) {
    console.warn('Journey: WebGL unavailable, showing a still Earth', err);
    webgl = false;
    renderer = null;
    canvas.hidden = true;
  }

  async function loadEarth() {
    let made = null;
    try {
      const mod = await import('./earth.js');
      if (typeof mod.createEarth !== 'function') throw new Error('earth.js has no createEarth');
      made = mod.createEarth(renderer, { quality, ...(opts.textureBase ? { textureBase: opts.textureBase } : {}) });
    } catch (err) {
      console.warn('Journey: earth.js unavailable, using a plain sphere', err);
      made = fallbackEarth();
    }
    if (destroyed) {
      made.dispose();
      return;
    }
    earth = made;
    scene.add(earth.group);
    const reveal = () => {
      if (earthReady || destroyed) return;
      earthReady = true;
      stage.classList.add('jy-earth-ready');
    };
    // fade in once the full maps are uploaded (the upload itself can stall a
    // frame, so not mid-fade); on a very slow line, show the previews anyway
    Promise.resolve(earth.ready).then(reveal, reveal);
    setTimeout(reveal, 10_000);
  }

  async function loadSatellite() {
    let made = null;
    try {
      const mod = await import('./satellite.js');
      made = await mod.createSatellite(opts.modelUrl ? { modelUrl: opts.modelUrl } : {});
    } catch (err) {
      console.warn('Journey: satellite.js unavailable, using a box', err);
      made = fallbackSatellite();
    }
    if (destroyed) {
      made.dispose();
      return;
    }
    satellite = made;
    satHolder.add(satellite.object3d);
    const set = new Set();
    satellite.object3d.traverse((o) => {
      const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of list) if (m.visible !== false && !o.isLineSegments) set.add(m);
    });
    satMaterials = [...set];
    // transparent once, so fading only changes opacity (no shader rebuild mid-scroll)
    for (const m of satMaterials) {
      m.transparent = true;
      m.needsUpdate = true;
    }
    satOpacity = -1;
  }

  if (webgl) {
    loadEarth();
    loadSatellite();
  }

  // ---- orbit data ----------------------------------------------------------------
  const observer = makeObserver(CALGARY);
  async function loadOrbit() {
    orbitStatus = 'loading';
    try {
      const res = await fetch(opts.tleUrl, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status} for ${opts.tleUrl}`);
      orbit = new Orbit(await res.json());
      orbitStatus = 'ok';
      passCache = null;
      trackAt = -Infinity;
      updateSatellite(state.simMs, gmstAt(state.simMs));
      rebuildTrack(state.simMs);
      computeFrame();
      startBlend(); // the swing's end moves from Calgary to the satellite
    } catch (err) {
      if (destroyed) return;
      console.warn('Journey: no orbit data', err);
      orbit = null;
      orbitStatus = 'failed';
    }
    uiDirty = true;
  }

  // ---- the satellite now -------------------------------------------------------------
  const sat = {
    ok: false,
    S: new THREE.Vector3(), // inertial scene position
    U: new THREE.Vector3(), // radial up
    F: new THREE.Vector3(), // direction of travel, horizontal
    R: new THREE.Vector3(), // F x U, to its right
    state: null,
  };
  const Y = new THREE.Vector3(0, 1, 0);
  const ORIGIN = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();

  const eciToScene = (v, out) => out.set(v.x, v.z, -v.y);
  function geoScene(latDeg, lonDeg, r, theta, out) {
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG;
    const c = Math.cos(lat);
    out.set(r * c * Math.cos(lon), r * Math.sin(lat), -r * c * Math.sin(lon));
    // turned with the Earth (as earth.group.rotation.y = theta)
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    return out.set(out.x * cs + out.z * sn, out.y, -out.x * sn + out.z * cs);
  }

  function updateSatellite(ms, theta) {
    const s = orbit && ms >= LAUNCH_MS ? orbit.stateAt(ms) : null;
    sat.state = s;
    if (s) {
      eciToScene(s.eci, sat.S).divideScalar(EARTH_RADIUS_KM);
      sat.U.copy(sat.S).normalize();
      eciToScene(s.velocity, sat.F);
      sat.F.addScaledVector(sat.U, -sat.F.dot(sat.U)).normalize();
      sat.ok = true;
    } else {
      // no orbit yet: aim the story at Calgary, 500 km up, heading east
      geoScene(CALGARY.latDeg, CALGARY.lonDeg, 1 + 500 / EARTH_RADIUS_KM, theta, sat.S);
      sat.U.copy(sat.S).normalize();
      sat.F.crossVectors(Y, sat.U).normalize();
      sat.ok = false;
    }
    sat.R.crossVectors(sat.F, sat.U).normalize();
  }

  // ---- layout and framing ----------------------------------------------------------
  let W = 1;
  let H = 1;
  const frame = {
    narrow: false,
    vfov: 35,
    tanHalf: Math.tan(17.5 * DEG),
    d0: 5.2,
    lens0: { x: 0.7, y: 0.6 },
    lens1: { x: 0.62, y: 0.6 },
    a: 0.15,
    b: CHASE_BEHIND_KM / EARTH_RADIUS_KM,
    yaw: YAW_CANDIDATES[0],
    satPx: 44,
    ui: 1,
    endText: null, // the text column at the end of the story, stage px
    textNow: [], // text on screen now, stage px
  };

  function stageRect() {
    return stage.getBoundingClientRect();
  }

  /** An element's box relative to the stage, or null when it isn't laid out. */
  function boxOf(el, s = stageRect()) {
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top };
  }

  const union = (boxes) => {
    const list = boxes.filter(Boolean);
    if (!list.length) return null;
    return {
      left: Math.min(...list.map((b) => b.left)),
      top: Math.min(...list.map((b) => b.top)),
      right: Math.max(...list.map((b) => b.right)),
      bottom: Math.max(...list.map((b) => b.bottom)),
    };
  };

  /**
   * Height `a` above the satellite (Earth radii) for a camera `b` behind it
   * that sees the limb `delta` radians above the satellite.
   */
  function solveChaseHeight(delta, b, h) {
    const f = (a) => {
      const cx = -b;
      const cy = 1 + h + a;
      const rho = Math.hypot(cx, cy);
      const toCentre = Math.atan2(-cy, -cx);
      const limb = toCentre + Math.asin(Math.min(1, 1 / rho));
      const toSat = Math.atan2(-a, b);
      return limb - toSat - delta;
    };
    let lo = 0.005;
    let hi = 1.5;
    if (f(lo) > 0) return lo;
    if (f(hi) < 0) return hi;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function computeFrame() {
    const narrow = W < 700 || W / H < 0.8;
    frame.narrow = narrow;
    frame.ui = clamp(1 + ((W - 1920) / 1920) * 0.3, 1, 1.2);
    // landscape: 35 degrees tall; portrait: hold 35 degrees across
    const vfov = W >= H ? 35 : (2 * Math.atan(Math.tan(17.5 * DEG) * (H / W))) / DEG;
    frame.vfov = vfov;
    frame.tanHalf = Math.tan((vfov / 2) * DEG);
    const s = stageRect();

    // beat 1: the whole Earth
    let diam;
    if (!narrow) {
      diam = 0.62;
      frame.lens0 = { x: 0.7, y: 0.6 };
    } else {
      diam = (1.2 * W) / H;
      const b1 = boxOf(ref.b1, s);
      const top = (b1 ? b1.bottom / H : 0.4) + 0.02; // the Earth starts under the h1 block
      frame.lens0 = { x: 0.5, y: Math.max(0.7, top + diam / 2) };
    }
    frame.d0 = 1 / Math.sin(Math.atan(diam * frame.tanHalf));

    // the end: behind the satellite, the limb under the text column
    const reduced = reducedMotion();
    frame.endText = reduced ? boxOf(ref.b1, s) : union([boxOf(ref.b2, s), boxOf(ref.b3, s)]);
    let satY = narrow ? 0.64 : 0.6;
    let limbY = narrow ? 0.45 : 0.42;
    if (frame.endText) limbY = Math.max(limbY, frame.endText.bottom / H + 0.03);
    satY = clamp(Math.max(satY, limbY + 0.12), 0, narrow ? 0.8 : 0.86);
    let satX = narrow ? 0.5 : 0.62;
    if (state.panel && !narrow) {
      // keep the satellite clear of the open panel on narrower desktops
      const panel = boxOf(ref.panel, s);
      if (panel) satX = Math.min(satX, Math.max(0.3, (panel.left - 72 * frame.ui) / W));
    }
    frame.lens1 = { x: satX, y: satY };
    const delta = Math.atan(2 * Math.max(0.02, satY - limbY) * frame.tanHalf);
    const h = sat.state ? sat.state.altKm / EARTH_RADIUS_KM : 500 / EARTH_RADIUS_KM;
    frame.a = solveChaseHeight(delta, frame.b, h);
    frame.satPx = (narrow ? 36 : 44) * frame.ui;
    stage.style.setProperty('--jy-ui', String(frame.ui));
    measureText();
    chooseYaw();
  }

  /** Text on screen now: the orbit line fades under it and pins hide under it. */
  function measureText() {
    const s = stageRect();
    frame.textNow = [ref.b1, ref.b2, ref.b3]
      .filter((el) => el.classList.contains('is-on'))
      .map((el) => boxOf(el, s))
      .filter(Boolean)
      .map((b) => ({ left: b.left - 16, top: b.top - 16, right: b.right + 16, bottom: b.bottom + 16 }));
    orbitLine.setMasks(frame.textNow);
  }

  function resize() {
    const w = stage.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || stage.clientHeight || window.innerHeight;
    W = Math.max(1, w);
    H = Math.max(1, h);
    if (renderer) {
      // capped at 2, and at about a 4K frame's worth of pixels
      const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8.3e6 / (W * H)));
      renderer.setPixelRatio(dpr);
      renderer.setSize(W, H, false);
    }
    camera.aspect = W / H;
    scoreCamera.aspect = W / H;
    computeFrame();
    camera.fov = frame.vfov;
    scoreCamera.fov = frame.vfov;
    camera.updateProjectionMatrix();
    root.classList.toggle('jy-narrow', frame.narrow);
    if (!webgl) layoutStill();
    needsFrame = true;
  }

  // ---- camera rigs -------------------------------------------------------------------
  const rig = { P: new THREE.Vector3(), q: new THREE.Quaternion(), lx: 0.5, ly: 0.5 };
  const shown = { P: new THREE.Vector3(0, 0, 5), q: new THREE.Quaternion(), lx: 0.5, ly: 0.5 };
  const scoreRig = { P: new THREE.Vector3(), q: new THREE.Quaternion(), lx: 0.5, ly: 0.5 };
  let blend = null; // { from: {P, q, lx, ly}, t0, dur }
  const mLook = new THREE.Matrix4();
  const heading = new THREE.Vector3();

  function lookQuat(P, T, up, out) {
    mLook.lookAt(P, T, up);
    return out.setFromRotationMatrix(mLook);
  }

  function chaseDefaults() {
    return { yaw: frame.yaw, pitch: Math.atan2(frame.a, frame.b), dist: Math.hypot(frame.a, frame.b) };
  }

  /**
   * How close and how far the camera may be from the satellite. The satellite
   * keeps its exaggerated size from the end view inward, so zooming in makes
   * it grow until it fills three quarters of the height; at that point its
   * nearest corner is still well beyond the 0.005 near plane.
   */
  function zoomLimits() {
    const def = Math.hypot(frame.a, frame.b);
    return { def, min: (def * frame.satPx) / (0.75 * H), max: def * 3 };
  }

  function calgaryDir(theta, out) {
    return geoScene(CALGARY.latDeg, CALGARY.lonDeg, 1, theta, out).normalize();
  }

  /** Behind the satellite (or wherever the visitor turned it), looking at it. */
  function followRig(out, yaw, pitch, dist) {
    const lim = zoomLimits();
    // closer than the end view: level out so the limb sits behind it, and centre it
    const zin = dist < lim.def ? clamp(Math.log(lim.def / dist) / Math.log(lim.def / lim.min), 0, 1) : 0;
    const k = zin * zin * (3 - 2 * zin);
    const p = clamp(pitch + (CLOSE_PITCH - Math.atan2(frame.a, frame.b)) * k, 2 * DEG, 89 * DEG);
    heading.copy(sat.F).multiplyScalar(Math.cos(yaw)).addScaledVector(sat.R, Math.sin(yaw));
    out.P.copy(sat.S)
      .addScaledVector(heading, -Math.cos(p) * dist)
      .addScaledVector(sat.U, Math.sin(p) * dist);
    lookQuat(out.P, sat.S, heading, out.q);
    out.lx = lerp(frame.lens1.x, 0.5, k);
    out.ly = lerp(frame.lens1.y, 0.5, k);
    return out;
  }

  /** Orbiting the Earth's centre. */
  function centreRig(out) {
    const s = Math.sin(state.phi);
    out.P.set(state.cdist * s * Math.sin(state.theta), state.cdist * Math.cos(state.phi), state.cdist * s * Math.cos(state.theta));
    lookQuat(out.P, ORIGIN, Y, out.q);
    out.lx = 0.5;
    out.ly = 0.5;
    return out;
  }

  const endRig = { P: new THREE.Vector3(), q: new THREE.Quaternion(), lx: 0, ly: 0 };
  const startDir = new THREE.Vector3();
  const endDir = new THREE.Vector3();
  const swingAxis = new THREE.Vector3();
  const north0 = new THREE.Vector3();
  const target = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const viewEnd = new THREE.Vector3();
  const upNow = new THREE.Vector3();
  const upEnd = new THREE.Vector3();
  const carriedEnd = new THREE.Vector3();
  let lastRoll = 0;

  /** Unit `v` minus its part along unit `n`, normalised (v is assumed not along n). */
  function perp(v, n, out) {
    out.copy(v).addScaledVector(n, -v.dot(n));
    const l = out.length();
    return l > 1e-9 ? out.divideScalar(l) : out.set(0, 0, 0);
  }

  /** Angle that turns `a` onto `b` about `n` (all unit, a and b perpendicular to n). */
  function signedAngle(a, b, n) {
    return Math.atan2(tmpC.crossVectors(a, b).dot(n), a.dot(b));
  }

  /** Angle of the swing, radians: Calgary to the end view's direction. */
  function swingAngle(theta) {
    const d = chaseDefaults();
    followRig(endRig, d.yaw, d.pitch, d.dist);
    calgaryDir(theta, startDir);
    return Math.acos(clamp(startDir.dot(tmpA.copy(endRig.P).normalize()), -1, 1));
  }

  /**
   * The swing, t in 0..1: from facing Calgary (north up) to behind the
   * satellite (its heading up). The camera's direction from the Earth's
   * centre runs along the shortest great circle; north at Calgary is carried
   * along that arc, so up never comes from the world's axis (no flips near
   * the poles), and whatever turn is left at the end is spread over the
   * whole swing. Long swings rise in the middle so the ground doesn't whip.
   */
  function storyRig(out, t, theta) {
    const e = easeInOut(clamp(t, 0, 1));
    const d = chaseDefaults();
    followRig(endRig, d.yaw, d.pitch, d.dist);
    calgaryDir(theta, startDir);
    const endR = endRig.P.length();
    endDir.copy(endRig.P).divideScalar(endR);
    const omega = Math.acos(clamp(startDir.dot(endDir), -1, 1));
    swingAxis.crossVectors(startDir, endDir);
    if (swingAxis.lengthSq() < 1e-10) swingAxis.crossVectors(Y, startDir); // straight overhead or opposite
    swingAxis.normalize();

    tmpB.copy(startDir).applyAxisAngle(swingAxis, omega * e);
    const lift = SWING_LIFT * frame.d0 * (omega / Math.PI) ** 2 * Math.sin(Math.PI * e);
    out.P.copy(tmpB).multiplyScalar(lerp(frame.d0, endR, e) + lift);
    target.copy(sat.S).multiplyScalar(e);
    viewDir.subVectors(target, out.P).normalize();

    // north at Calgary, carried along the arc
    perp(Y, startDir, north0);
    perp(tmpA.copy(north0).applyAxisAngle(swingAxis, omega * e), viewDir, upNow);
    // the turn still needed at the end of the arc to put the heading up
    viewEnd.subVectors(sat.S, endRig.P).normalize();
    perp(heading, viewEnd, upEnd); // heading was set by followRig(endRig)
    perp(tmpA.copy(north0).applyAxisAngle(swingAxis, omega), viewEnd, carriedEnd);
    let roll = signedAngle(carriedEnd, upEnd, viewEnd);
    // keep turning the same way as last frame near half a turn (no sudden reversal)
    roll = lastRoll + wrapPi(roll - lastRoll);
    if (Math.abs(roll) > 1.25 * Math.PI) roll = wrapPi(roll);
    lastRoll = roll;
    upNow.applyAxisAngle(viewDir, roll * e);
    lookQuat(out.P, target, upNow, out.q);
    out.lx = lerp(frame.lens0.x, frame.lens1.x, e);
    out.ly = lerp(frame.lens0.y, frame.lens1.y, e);
    return out;
  }

  /** Snapshot what is on screen and ease from it to whatever the rig says next. */
  function startBlend(dur = BLEND_MS) {
    // nothing drawn lately (hidden, or not started): there is no view to ease from
    if (reducedMotion() || performance.now() - lastDraw > 250) {
      blend = null;
      return;
    }
    blend = { from: { P: shown.P.clone(), q: shown.q.clone(), lx: shown.lx, ly: shown.ly }, t0: performance.now(), dur };
  }

  function storyProgress() {
    return state.mode === 'story' ? state.pSmooth : 1;
  }

  function computeCamera(now, theta) {
    const p = storyProgress();
    if (p < P.swingEnd) {
      storyRig(rig, (p - P.swingStart) / (P.swingEnd - P.swingStart), theta);
    } else if (state.follow) {
      const d = chaseDefaults();
      if (state.custom) followRig(rig, state.yaw, state.pitch, state.dist);
      else followRig(rig, d.yaw, d.pitch, d.dist);
    } else {
      centreRig(rig);
    }
    if (blend) {
      const k = clamp((now - blend.t0) / blend.dur, 0, 1);
      const e = easeInOut(k);
      const rf = blend.from.P.length();
      const rt = rig.P.length();
      slerpUnit(tmpA.copy(blend.from.P).divideScalar(rf), tmpB.copy(rig.P).divideScalar(rt), e, tmpC);
      shown.P.copy(tmpC).multiplyScalar(lerp(rf, rt, e));
      shown.q.copy(blend.from.q).slerp(rig.q, e);
      shown.lx = lerp(blend.from.lx, rig.lx, e);
      shown.ly = lerp(blend.from.ly, rig.ly, e);
      if (k >= 1) blend = null;
    } else {
      shown.P.copy(rig.P);
      shown.q.copy(rig.q);
      shown.lx = rig.lx;
      shown.ly = rig.ly;
    }
    applyCamera(camera, shown);
  }

  function applyCamera(cam, r) {
    cam.position.copy(r.P);
    cam.quaternion.copy(r.q);
    cam.setViewOffset(W, H, (0.5 - r.lx) * W, (0.5 - r.ly) * H, W, H);
    cam.updateMatrixWorld();
  }

  function slerpUnit(a, b, t, out) {
    const dot = clamp(a.dot(b), -1, 1);
    const omega = Math.acos(dot);
    if (omega < 1e-5) return out.copy(a);
    if (Math.PI - omega < 1e-3) {
      const axis = tmpC.crossVectors(a, Y);
      if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
      axis.normalize();
      return out.copy(a).applyAxisAngle(axis, omega * t);
    }
    const s = Math.sin(omega);
    const ka = Math.sin((1 - t) * omega) / s;
    const kb = Math.sin(t * omega) / s;
    return out.set(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb);
  }

  // ---- the default heading: the track clear of the text -------------------------------
  const v4 = new THREE.Vector4();
  const mScore = new THREE.Matrix4();

  /** How much of the drawn track (and the satellite) falls in the text column plus a margin. */
  function intrusion(yaw, box) {
    const d = chaseDefaults();
    followRig(scoreRig, yaw, d.pitch, d.dist);
    applyCamera(scoreCamera, scoreRig);
    scoreCamera.updateProjectionMatrix();
    mScore.multiplyMatrices(scoreCamera.projectionMatrix, scoreCamera.matrixWorldInverse);
    let score = 0;
    const inside = (x, y, z, w) => {
      v4.set(x, y, z, 1).applyMatrix4(mScore);
      if (v4.w <= 1e-4) return false;
      const sx = (v4.x / v4.w * 0.5 + 0.5) * W;
      const sy = (-v4.y / v4.w * 0.5 + 0.5) * H;
      return sx > box.left && sx < box.right && sy > box.top && sy < box.bottom && v4.z / v4.w < 1;
    };
    for (let i = 0; i < trackN; i++) {
      const x = trackXYZ[i * 3];
      const y = trackXYZ[i * 3 + 1];
      const z = trackXYZ[i * 3 + 2];
      // points behind the Earth aren't drawn
      tmpA.set(x, y, z);
      if (hiddenByEarth(scoreRig.P, tmpA)) continue;
      if (inside(x, y, z)) score += trackW[i];
    }
    if (inside(sat.S.x, sat.S.y, sat.S.z)) score += 20;
    return score;
  }

  function hiddenByEarth(from, p, radius = 0.999) {
    tmpB.subVectors(p, from);
    const len = tmpB.length();
    tmpB.divideScalar(len);
    const b = from.dot(tmpB);
    const h = b * b - (from.lengthSq() - radius * radius);
    if (h <= 0) return false;
    const t = -b - Math.sqrt(h);
    return t > 0 && t < len - 1e-4;
  }

  /**
   * Pick the end view's heading so the track and the satellite keep clear of
   * the text column. Only the default view: once the visitor moves the
   * camera it's theirs. The track's shape relative to the satellite hardly
   * changes along the orbit, so the choice holds; it is checked again when
   * the layout changes and every few seconds.
   */
  function chooseYaw() {
    if (!sat.ok || !trackN || !frame.endText) return;
    const t = frame.endText;
    const m = TEXT_MARGIN;
    const box = { left: t.left - m, top: t.top - m, right: t.right + m, bottom: t.bottom + m };
    const current = intrusion(frame.yaw, box);
    if (current < 1e-6) return;
    let best = frame.yaw;
    let bestScore = current;
    for (const y of YAW_CANDIDATES) {
      const sc = intrusion(y, box);
      if (sc < bestScore - 1e-6) {
        best = y;
        bestScore = sc;
      }
    }
    if (best !== frame.yaw) {
      if (!state.custom && storyProgress() >= P.swingStart) startBlend();
      frame.yaw = best;
    }
  }

  // ---- story progress -----------------------------------------------------------------
  function holdPx() {
    return Math.max(0, section.offsetHeight - stage.offsetHeight);
  }

  function readScroll() {
    if (!state.shown || section.offsetParent === null) return;
    const rect = section.getBoundingClientRect();
    // where the page is relative to the section, for putting it back exactly
    state.offsetPx = -rect.top;
    state.sectionPx = rect.height;
    if (state.mode !== 'story') return;
    if (state.locked) {
      state.pTarget = 1;
      return;
    }
    const hold = holdPx();
    if (hold <= 0) return;
    state.pTarget = clamp(-rect.top / hold, 0, 1);
  }

  /**
   * The end: once the story reaches p = 1 and the scroll has come to rest,
   * the section collapses to the stage's own height, so there is nothing
   * left to scroll and the globe stays. The page is put at the section's
   * top in the same frame, which is exactly where the stage already sits on
   * screen, so nothing jumps. Remembered for the browser session.
   */
  function lock({ landing = false } = {}) {
    if (state.mode !== 'story') return;
    state.locked = true;
    sessionSet(LOCK_KEY, '1');
    if (landing) root.classList.add('jy-instant');
    root.classList.add('jy-locked');
    scrollWindow(sectionTop());
    state.pTarget = 1;
    state.pSmooth = 1;
    readScroll();
    updateBeats();
    uiDirty = true;
    needsFrame = true;
    startTicker();
    if (landing) settleInstant();
  }

  /** Lock once the story is at its end and the page has stopped moving (no finger down). */
  function maybeLock(atRest) {
    if (state.locked || state.mode !== 'story' || !state.shown || state.pTarget < 0.999) return;
    if (pointers.size) return;
    if (!atRest && performance.now() - state.lastScrollAt < 200) return;
    lock();
  }

  /** "Play the intro again": back to the top of the story, which the visitor's scrolling drives. */
  function playAgain() {
    stopTicker();
    closeCredits();
    closePanel();
    hideCard();
    state.locked = false;
    sessionSet(LOCK_KEY, null);
    state.hintDismissed = false;
    state.live = true;
    state.speed = 1;
    state.simMs = Date.now();
    startBlend(); // from the end view to beat 1 without a cut (none under reduced motion)
    resetCamera();
    root.classList.remove('jy-locked');
    scrollWindow(sectionTop());
    state.pTarget = 0;
    state.pSmooth = 0;
    state.lastScrollAt = performance.now();
    readScroll();
    updateBeats();
    uiDirty = true;
    needsFrame = true;
    ref.cue.focus?.({ preventScroll: true });
  }

  function scrollWindow(y, smooth = false) {
    try {
      window.scrollTo({ top: Math.round(y), left: window.scrollX, behavior: smooth ? 'smooth' : 'instant' });
    } catch {
      window.scrollTo(window.scrollX, Math.round(y));
    }
  }

  function sectionTop() {
    return section.getBoundingClientRect().top + window.scrollY;
  }

  /**
   * Scroll the page back to a saved place: the same pixel offset into the
   * section when its height hasn't changed, else the same story progress.
   */
  function scrollToSaved(saved) {
    if (section.offsetParent === null) return false;
    const top = sectionTop();
    let y;
    if (Number.isFinite(saved.offset) && Number.isFinite(saved.height) && Math.abs(saved.height - section.offsetHeight) < 2) {
      y = top + saved.offset;
    } else {
      y = top + (state.mode === 'story' ? clamp(saved.progress ?? 0, 0, 1) * holdPx() : 0);
    }
    scrollWindow(y);
    readScroll();
    if (state.mode === 'story') {
      // the scroll may be clamped at the page's end: trust the saved progress
      state.pTarget = Number.isFinite(saved.progress) && Math.abs(window.scrollY - y) > 2 ? saved.progress : state.pTarget;
      state.pSmooth = state.pTarget;
    }
    return true;
  }

  // ---- beats: classes on thresholds, played in time ------------------------------------
  const beatShown = { b1: null, b2: null, b3: null, ui: null, composed: null };
  function setBeat(el, key, on, past) {
    const value = on ? 'on' : past ? 'past' : 'off';
    if (beatShown[key] === value) return false;
    beatShown[key] = value;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-past', !on && past);
    el.setAttribute('aria-hidden', String(!on));
    // hidden blocks keep their size (the framing measures them) but take no clicks or focus
    el.inert = !on;
    return true;
  }

  function updateBeats() {
    const still = state.mode === 'still';
    const p = still ? 1 : state.pTarget;
    // reduced motion ends on the h1 block with the live sentence (also without WebGL)
    const composed = still || (reducedMotion() && p >= P.beat2Out);
    let changed = false;
    if (beatShown.composed !== composed) {
      beatShown.composed = composed;
      root.classList.toggle('jy-composed', composed);
      changed = true;
    }
    if (composed) {
      changed = setBeat(ref.b1, 'b1', true, false) || changed;
      changed = setBeat(ref.b2, 'b2', false, true) || changed;
      changed = setBeat(ref.b3, 'b3', false, true) || changed;
    } else {
      changed = setBeat(ref.b1, 'b1', p < P.h1Out, true) || changed;
      changed = setBeat(ref.b2, 'b2', p >= P.beat2In && p < P.beat2Out, p >= P.beat2Out) || changed;
      changed = setBeat(ref.b3, 'b3', p >= P.beat2Out && !state.hintDismissed && !reducedMotion(), state.hintDismissed) || changed;
    }
    // "Scroll to learn more" goes as soon as the visitor starts scrolling
    root.classList.toggle('jy-scrolled', still || p > 0.01);
    const ui = still || p >= P.ui;
    if (beatShown.ui !== ui) {
      beatShown.ui = ui;
      root.classList.toggle('jy-ui-on', ui);
      ref.time.inert = !ui || still;
      ref.corner.inert = !ui;
      marks.inert = !ui || still;
      canvas.tabIndex = ui && !still ? 0 : -1;
      if (!ui) hideCard();
      changed = true;
    }
    ref.again.hidden = !state.locked;
    if (changed) measureText();
  }

  function interactive() {
    return beatShown.ui === true && webgl;
  }

  // ---- marks: pins, the satellite button -------------------------------------------------
  const ndc = new THREE.Vector3();

  /** CSS px of a world point on the stage, or null when behind the camera. */
  function toScreen(p) {
    ndc.copy(p).project(camera);
    if (ndc.z > 1 || ndc.z < -1) return null;
    return { x: (ndc.x * 0.5 + 0.5) * W, y: (-ndc.y * 0.5 + 0.5) * H };
  }

  const underText = (x, y) => frame.textNow.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);

  function buildPins() {
    for (const pin of pins) {
      pin.el.remove();
      pin.count.remove();
    }
    pins = [];
    const placed = photos
      .filter((p) => p.capturedAt && Number.isFinite(Date.parse(p.capturedAt)) && p.position
        && Number.isFinite(p.position.lat) && Number.isFinite(p.position.lon))
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    for (const p of placed) {
      const a = document.createElement('a');
      a.className = 'jy-pin';
      a.href = opts.photoHref(p.id);
      a.dataset.id = p.id;
      const place = placeOf(p);
      a.setAttribute('aria-label', `${place ? `${place}, ` : ''}${photoTime(p)}`);
      a.classList.toggle('jy-pin-square', !!isSquare(p));
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = new URL(p.thumb || p.src, siteRoot).href;
      a.appendChild(img);
      const count = document.createElement('span');
      count.className = 'jy-pile-count';
      count.hidden = true;
      count.setAttribute('aria-hidden', 'true');
      marks.insertBefore(count, ref.sat);
      marks.insertBefore(a, count);
      pins.push({ photo: p, el: a, count, x: 0, y: 0, vis: false, pile: null, lat: p.position.lat, lon: p.position.lon });
    }
    paintSelected();
  }

  function paintSelected() {
    for (const pin of pins) pin.el.classList.toggle('is-selected', pin.photo.id === state.selectedId);
  }

  const pinWorld = new THREE.Vector3();
  function updateMarks(theta, satAlpha, satLengthPx) {
    const show = beatShown.ui === true;
    for (const pin of pins) {
      let vis = false;
      if (show) {
        geoScene(pin.lat, pin.lon, 1.0, theta, pinWorld);
        if (!hiddenByEarth(camera.position, pinWorld, 0.998)) {
          const s = toScreen(pinWorld);
          if (s && s.x > -40 && s.x < W + 40 && s.y > -40 && s.y < H + 40 && !underText(s.x, s.y)) {
            pin.x = s.x;
            pin.y = s.y;
            vis = true;
          }
        }
      }
      pin.vis = vis;
      pin.pile = null;
    }
    // piles: pins closer than 28px stack under the newest
    const near = 28 * frame.ui;
    for (let i = 0; i < pins.length; i++) {
      const a = pins[i];
      if (!a.vis || a.pile) continue;
      const members = [a];
      for (let j = i + 1; j < pins.length; j++) {
        const b = pins[j];
        if (b.vis && !b.pile && Math.hypot(a.x - b.x, a.y - b.y) < near) members.push(b);
      }
      if (members.length > 1) {
        members.forEach((m, k) => {
          m.pile = { head: a, index: k, members };
        });
      }
    }
    for (const pin of pins) {
      const pile = pin.pile;
      let x = pin.x;
      let y = pin.y;
      if (pile) {
        x = pile.head.x + pile.index * 3;
        y = pile.head.y - pile.index * 3;
      }
      const key = pin.vis ? `${Math.round(x)},${Math.round(y)},${pile ? pile.index : -1}` : 'off';
      if (pin.key !== key) {
        pin.key = key;
        pin.el.classList.toggle('is-off', !pin.vis);
        if (pin.vis) {
          pin.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
          pin.el.style.zIndex = String(pile ? 100 - pile.index : 100);
          pin.el.classList.toggle('in-pile', !!pile && pile.index > 0);
        }
      }
      const head = pile && pile.index === 0;
      if (head) {
        pin.count.hidden = false;
        pin.count.textContent = `${pile.members.length} pictures`;
        pin.count.style.transform = `translate(${Math.round(pin.x + 24 * frame.ui)}px, ${Math.round(pin.y)}px) translateY(-50%)`;
      } else if (!pin.count.hidden) {
        pin.count.hidden = true;
      }
    }
    // the satellite button: the model plus its label 12px to the right
    const satOn = satAlpha > 0.5 && sat.ok && !hiddenByEarth(camera.position, sat.S);
    const s = satOn ? toScreen(sat.S) : null;
    if (s) {
      ref.sat.hidden = false;
      ref.sat.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
      ref.sat.classList.toggle('is-shown', satAlpha >= 0.999);
      const off = Math.round(Math.max(20 * frame.ui, satLengthPx * 0.42) + 12);
      if (ref.sat.dataset.off !== String(off)) {
        ref.sat.dataset.off = String(off);
        ref.sat.style.setProperty('--jy-sat-off', `${off}px`);
      }
    } else if (!ref.sat.hidden) {
      if (document.activeElement === ref.sat) canvas.focus({ preventScroll: true });
      ref.sat.hidden = true;
    }
    if (card.pin && (!card.pin.vis || !show)) hideCard();
    else if (card.pin) placeCard();
  }

  // ---- the hover card ---------------------------------------------------------------
  const card = { pin: null, key: '', timer: 0, touchArmed: null };

  function cardItem(photo, big) {
    const a = document.createElement('a');
    a.className = big ? 'jy-card-item jy-card-one' : 'jy-card-item';
    a.href = opts.photoHref(photo.id);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = new URL(big ? photo.src || photo.thumb : photo.thumb || photo.src, siteRoot).href;
    if (isSquare(photo)) img.classList.add('is-square');
    const place = document.createElement('span');
    place.className = 'jy-card-place';
    place.textContent = placeOf(photo) || 'Place unknown';
    const time = document.createElement('span');
    time.className = 'jy-card-time';
    time.textContent = photoTime(photo);
    a.append(img, place, time);
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPhoto(photo.id);
    });
    return a;
  }

  function showCard(pin) {
    clearTimeout(card.timer);
    const members = pin.pile ? pin.pile.members : [pin];
    const key = members.map((m) => m.photo.id).join(',');
    if (card.pin !== pin || card.key !== key) {
      ref.card.replaceChildren(...members.map((m) => cardItem(m.photo, members.length === 1)));
      ref.card.classList.toggle('is-list', members.length > 1);
      card.key = key;
    }
    card.pin = pin;
    ref.card.hidden = false;
    placeCard();
    requestAnimationFrame(() => ref.card.classList.add('is-on'));
  }

  function placeCard() {
    const pin = card.pin;
    const el = ref.card;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 16 * frame.ui;
    const x = clamp(pin.x - w / 2, 8, W - w - 8);
    let y = pin.y - h - gap;
    if (y < 8) y = pin.y + gap;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hideCard(delay = 0) {
    clearTimeout(card.timer);
    const go = () => {
      card.pin = null;
      card.touchArmed = null;
      ref.card.classList.remove('is-on');
      ref.card.hidden = true;
    };
    if (delay) card.timer = setTimeout(go, delay);
    else go();
  }

  listen(marks, 'pointerover', (e) => {
    const a = e.target.closest?.('.jy-pin');
    if (!a || e.pointerType !== 'mouse') return;
    const pin = pins.find((p) => p.el === a);
    if (pin) showCard(pin.pile ? pin.pile.head : pin);
  });
  listen(marks, 'pointerout', (e) => {
    const a = e.target.closest?.('.jy-pin');
    if (!a || e.pointerType !== 'mouse') return;
    if (e.relatedTarget && ref.card.contains(e.relatedTarget)) return;
    hideCard(160);
  });
  listen(ref.card, 'pointerenter', () => clearTimeout(card.timer));
  listen(ref.card, 'pointerleave', (e) => {
    if (e.pointerType === 'mouse') hideCard(160);
  });
  listen(marks, 'focusin', (e) => {
    const a = e.target.closest?.('.jy-pin');
    const pin = a && pins.find((p) => p.el === a);
    if (pin) showCard(pin);
  });
  listen(marks, 'focusout', (e) => {
    if (e.relatedTarget && (ref.card.contains(e.relatedTarget) || e.relatedTarget.closest?.('.jy-pin'))) return;
    hideCard(120);
  });
  let lastPointerType = 'mouse';
  listen(root, 'pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse';
  }, { capture: true });
  listen(marks, 'click', (e) => {
    const a = e.target.closest?.('.jy-pin');
    if (!a) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const pin = pins.find((p) => p.el === a);
    if (!pin) return;
    dismissHint();
    const head = pin.pile ? pin.pile.head : pin;
    // a pile, or a first tap: show the card; the card is the link
    if (pin.pile || (lastPointerType !== 'mouse' && card.touchArmed !== head)) {
      showCard(head);
      card.touchArmed = head;
      return;
    }
    openPhoto(pin.photo.id);
  });

  function openPhoto(pid) {
    state.selectedId = pid;
    paintSelected();
    dismissHint();
    opts.onOpenPhoto(pid);
  }

  // ---- the status panel ------------------------------------------------------------------
  function openPanel({ focus = true } = {}) {
    dismissHint();
    closeCredits();
    state.panel = true;
    ref.panel.hidden = false;
    root.classList.add('jy-panel-open');
    requestAnimationFrame(() => ref.panel.classList.add('is-on'));
    uiDirty = true;
    paintPanel(true);
    reframe();
    if (focus) root.querySelector('.jy-panel-title').focus({ preventScroll: true });
  }

  /** The panel opened or closed: ease the satellite clear of it (or back). */
  function reframe() {
    const before = frame.lens1.x;
    computeFrame();
    if (Math.abs(frame.lens1.x - before) > 1e-3) startBlend(400);
  }

  function closePanel({ restoreFocus = false } = {}) {
    if (!state.panel) return;
    state.panel = false;
    state.sheetOpen = false;
    ref.panel.classList.remove('is-on', 'is-open');
    ref.more.setAttribute('aria-expanded', 'false');
    ref.more.textContent = 'More';
    root.classList.remove('jy-panel-open');
    reframe();
    const done = () => {
      if (!state.panel) ref.panel.hidden = true;
    };
    if (reducedMotion()) done();
    else setTimeout(done, 160);
    if (restoreFocus && !ref.sat.hidden) ref.sat.focus({ preventScroll: true });
  }

  function setSheet(open) {
    state.sheetOpen = open;
    ref.panel.classList.toggle('is-open', open);
    ref.more.setAttribute('aria-expanded', String(open));
    ref.more.textContent = open ? 'Less' : 'More';
  }

  /** A click on the satellite: the panel; a double click: fly in close. */
  function satelliteClicked(detail) {
    if (detail >= 2) {
      zoomToSatellite();
      if (!state.panel) openPanel({ focus: false });
      return;
    }
    if (state.panel) closePanel();
    else openPanel();
  }

  listen(ref.sat, 'click', (e) => satelliteClicked(e.detail));
  listen(ref.close, 'click', () => closePanel({ restoreFocus: true }));
  listen(ref.more, 'click', () => setSheet(!state.sheetOpen));
  listen(ref.grab, 'click', () => setSheet(!state.sheetOpen));
  listen(ref.follow, 'click', () => setFollow(!state.follow));
  listen(ref.zoomSat, 'click', () => zoomToSatellite());
  listen(ref.retry, 'click', () => loadOrbit());
  listen(ref.latestImg, 'error', () => {
    ref.latestImg.hidden = true;
    ref.latestFailed.hidden = false;
  });
  listen(ref.latestImg, 'load', () => {
    ref.latestImg.hidden = false;
    ref.latestFailed.hidden = true;
  });
  listen(ref.latestRetry, 'click', () => {
    if (!latest) return;
    ref.latestFailed.hidden = true;
    ref.latestImg.hidden = false;
    const src = new URL(latest.src || latest.thumb, siteRoot).href;
    ref.latestImg.src = `${src}${src.includes('?') ? '&' : '?'}retry=${Date.now()}`;
  });
  for (const a of [ref.latestFrame, ref.latestOpen]) {
    listen(a, 'click', (e) => {
      if (!latest || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPhoto(latest.id);
    });
  }

  // drag the phone sheet's grabber up or down
  let sheetDrag = null;
  listen(ref.grab, 'pointerdown', (e) => {
    sheetDrag = { y: e.clientY, moved: false };
    ref.grab.setPointerCapture?.(e.pointerId);
  });
  listen(ref.grab, 'pointermove', (e) => {
    if (!sheetDrag) return;
    const dy = e.clientY - sheetDrag.y;
    if (Math.abs(dy) > 24 && !sheetDrag.moved) {
      sheetDrag.moved = true;
      setSheet(dy < 0);
    }
  });
  listen(ref.grab, 'pointerup', () => {
    sheetDrag = null;
  });

  function setFollow(on) {
    if (on === state.follow && !(on && state.custom)) return;
    startBlend();
    if (on) {
      state.follow = true;
      state.custom = false;
    } else {
      // from where the camera is now, orbit the Earth's centre
      state.follow = false;
      const P0 = camera.position;
      const r = P0.length();
      state.cdist = state.cdistTarget = clamp(Math.max(r, 2.2), 1.3, 6);
      state.theta = Math.atan2(P0.x, P0.z);
      state.phi = clamp(Math.acos(clamp(P0.y / r, -1, 1)), 0.06, Math.PI - 0.06);
    }
    uiDirty = true;
  }

  // ---- credits: a panel over the globe, opened from the page's nav (openCredits) -------------
  let creditsOpener = null;
  function openCredits(opener = document.activeElement) {
    if (state.creditsOpen) return;
    creditsOpener = opener instanceof HTMLElement ? opener : null;
    closePanel();
    hideCard();
    state.creditsOpen = true;
    ref.credits.hidden = false;
    root.classList.add('jy-credits-open');
    creditsOpener?.setAttribute?.('aria-expanded', 'true');
    requestAnimationFrame(() => ref.credits.classList.add('is-on'));
    ref.credits.querySelector('.jy-panel-title').focus({ preventScroll: true });
  }
  function closeCredits({ restoreFocus = false } = {}) {
    if (!state.creditsOpen) return;
    state.creditsOpen = false;
    ref.credits.classList.remove('is-on');
    ref.credits.hidden = true;
    root.classList.remove('jy-credits-open');
    creditsOpener?.setAttribute?.('aria-expanded', 'false');
    if (restoreFocus && creditsOpener?.isConnected) creditsOpener.focus({ preventScroll: true });
    creditsOpener = null;
  }
  listen(ref.creditsClose, 'click', () => closeCredits({ restoreFocus: true }));
  // a click anywhere outside the panel (except on what opened it) closes it
  listen(document, 'pointerdown', (e) => {
    if (!state.creditsOpen) return;
    if (ref.credits.contains(e.target) || (creditsOpener && creditsOpener.contains(e.target))) return;
    closeCredits();
  }, { capture: true });

  // ---- text ----------------------------------------------------------------------------------
  const shownText = new Map();
  const put = (node, text) => {
    if (shownText.get(node) !== text) {
      node.textContent = text;
      shownText.set(node, text);
    }
  };
  const bar = (node, ch) => {
    if (shownText.get(node) === `bar${ch}`) return;
    node.replaceChildren();
    const s = document.createElement('span');
    s.className = 'jy-bar';
    s.style.width = `${ch}ch`;
    node.appendChild(s);
    shownText.set(node, `bar${ch}`);
  };

  let passCache = null;
  let passTried = 0;
  function nextPass(ms) {
    if (!orbit) return null;
    const c = passCache;
    const stale = !c || ms < c.fromMs - MIN_MS || (c.pass ? ms > c.pass.setMs : ms > c.fromMs + DAY_MS);
    const now = performance.now();
    if (stale && now - passTried > 1500) {
      passTried = now;
      const list = findPasses(orbit, observer, ms, { count: 1, minElevationDeg: 10, maxDays: 2 });
      passCache = { fromMs: ms, pass: list[0] || null };
    }
    return passCache?.pass || null;
  }

  function paintPanel(force = false) {
    if (!state.panel && !force) return;
    const s = sat.state;
    const ms = state.simMs;
    ref.follow.textContent = state.follow ? 'Following' : 'Follow';
    ref.follow.setAttribute('aria-pressed', String(state.follow));
    if (state.live) put(ref.aka, 'Also called FrontierSat.');
    else {
      const off = ms - Date.now();
      put(ref.aka, `At ${calgaryTime(ms).time} in Calgary, ${duration(off)} ${off >= 0 ? 'ahead of' : 'behind'} now`);
    }
    ref.noOrbit.hidden = orbitStatus !== 'failed';
    if (!s) {
      if (orbitStatus === 'failed') {
        put(ref.over, 'Position unavailable');
        for (const k of ['fAlt', 'fSpeed', 'fPos', 'fSun', 'fPass', 'fRev']) put(ref[k], '—');
      } else {
        bar(ref.over, 14);
        bar(ref.fAlt, 6);
        bar(ref.fSpeed, 8);
        bar(ref.fPos, 18);
        bar(ref.fSun, 12);
        bar(ref.fPass, 16);
        bar(ref.fRev, 5);
      }
      put(ref.elements, '');
    } else {
      const place = regionAt(s.latDeg, s.lonDeg);
      put(ref.over, place ? `Over ${place}` : `Over ${fmtLatShort(s.latDeg)}, ${fmtLonShort(s.lonDeg)}`);
      put(ref.fAlt, `${Math.round(s.altKm)} km`);
      put(ref.fSpeed, `${s.speedKmS.toFixed(2)} km/s`);
      put(ref.fPos, `${fmtLat(s.latDeg)}, ${fmtLon(s.lonDeg)}`);
      const light = satelliteLight(s.eci, sunPosition(ms));
      put(ref.fSun, light === 'sunlit' ? 'In sunlight' : light === 'shadow' ? 'In the Earth’s shadow' : 'At the edge of the Earth’s shadow');
      const pass = nextPass(ms);
      if (!pass) put(ref.fPass, 'Not in the next 2 days');
      else if (pass.riseMs <= ms) {
        const end = calgaryTime(pass.setMs);
        put(ref.fPass, `Now, until ${end.time} ${end.zone}`);
      } else {
        const t = calgaryTime(pass.riseMs);
        put(ref.fPass, `${t.time} ${t.zone}, in ${duration(pass.riseMs - ms)}`);
      }
      const rev = orbit.revolutionAt(ms);
      put(ref.fRev, rev === null ? '—' : rev.toLocaleString('en-US'));
      const ageDays = (ms - s.tleEpochMs) / DAY_MS;
      const old = Math.abs(ageDays) > 7;
      ref.elements.classList.toggle('jy-muted', !old);
      put(
        ref.elements,
        old
          ? `These orbital elements are ${Math.round(Math.abs(ageDays))} days ${ageDays >= 0 ? 'old' : 'newer than this time'}, so the position may be off by tens of kilometres.`
          : `Worked out from orbital elements published ${utcShort(s.tleEpochMs)}.`,
      );
    }
    paintLatest();
  }

  function paintLatest() {
    ref.latest.hidden = !latest;
    if (!latest) return;
    if (ref.latest.dataset.id !== latest.id) {
      ref.latest.dataset.id = latest.id;
      const href = opts.photoHref(latest.id);
      ref.latestFrame.href = href;
      ref.latestOpen.href = href;
      const ratio = latest.width && latest.height ? latest.width / latest.height : 4 / 3;
      ref.latestFrame.style.aspectRatio = String(ratio);
      ref.latestImg.hidden = false;
      ref.latestFailed.hidden = true;
      ref.latestImg.src = new URL(latest.src || latest.thumb, siteRoot).href;
      const place = placeOf(latest);
      ref.latestImg.alt = place ? `Picture over ${place}` : 'The latest picture';
      put(ref.latestPlace, place || photoTime(latest));
      put(ref.latestTime, place ? photoTime(latest) : '');
      const status = statusLine(latest);
      put(ref.latestStatus, status);
      ref.latestStatus.hidden = !status;
    }
  }

  function liveSentence() {
    const s = sat.state;
    if (!s) {
      return orbitStatus === 'failed'
        ? 'Its position can’t be worked out right now: the orbital elements didn’t load.'
        : 'Working out where it is right now.';
    }
    const when = state.live ? 'Right now' : `At ${calgaryTime(state.simMs).time} in Calgary`;
    const alt = Math.round(s.altKm);
    const place = regionAt(s.latDeg, s.lonDeg);
    const where = place
      ? `${when} it’s over ${place}, ${alt} km up.`
      : `${when} it’s ${alt} km above ${fmtLatShort(s.latDeg)}, ${fmtLonShort(s.lonDeg)}.`;
    const period = Math.round(orbit.periodMinutes(state.simMs));
    return `${where} It goes round the Earth every ${period} minutes, passing over both poles.`;
  }

  function hintText() {
    // on touch, before the end locks, vertical swipes still scroll the page
    if (!touchQuery.matches) return 'Drag to look around. Click the satellite to see the last picture it sent.';
    return state.locked
      ? 'Drag to look around. Tap the satellite to see the last picture it sent.'
      : 'Drag sideways to look around. Tap the satellite to see the last picture it sent.';
  }

  function atNow() {
    return state.live && state.speed === 1 && state.follow && !state.custom;
  }

  function paintClock() {
    const ms = state.simMs;
    put(ref.clockMain, `${calgaryTime(ms).time} in Calgary`);
    if (state.live) put(ref.clockSub, utcShort(ms));
    else {
      const off = ms - Date.now();
      put(ref.clockSub, Math.abs(off) < MIN_MS ? utcShort(ms) : `${duration(off)} ${off >= 0 ? 'ahead of' : 'behind'} now`);
    }
    const now = atNow();
    ref.now.setAttribute('aria-disabled', String(now));
    ref.now.title = now ? 'Showing now' : 'Live time, 1×, following the satellite';
    for (const input of ref.time.querySelectorAll('input[type="radio"]')) {
      const on = Number(input.value) === state.speed;
      if (input.checked !== on) input.checked = on;
    }
    const lim = zoomLimits();
    const d = state.follow ? (state.custom ? state.distTarget : lim.def) : state.cdistTarget;
    ref.zoomIn.disabled = state.follow ? d <= lim.min * 1.001 : d <= 1.3 * 1.001;
    ref.zoomOut.disabled = state.follow ? d >= lim.max * 0.999 : d >= 6 * 0.999;
  }

  let uiDirty = true;
  let lastSentence = 0;
  let lastPanel = 0;
  function paintText(now) {
    if (uiDirty || now - lastSentence > 1000) {
      const text = liveSentence();
      put(ref.b2t, text);
      put(ref.liveLead, text);
      put(ref.b3t, hintText());
      paintClock();
      lastSentence = now;
    }
    if (state.panel && (uiDirty || now - lastPanel > 250)) {
      paintPanel();
      lastPanel = now;
    }
    uiDirty = false;
  }

  function resetCamera() {
    state.follow = true;
    state.custom = false;
    const lim = zoomLimits();
    state.dist = state.distTarget = lim.def;
  }

  function goNow() {
    state.live = true;
    state.speed = 1;
    state.simMs = Date.now();
    if (!state.follow || state.custom) startBlend();
    resetCamera();
    trackAt = -Infinity;
    uiDirty = true;
  }

  listen(ref.now, 'click', () => {
    if (ref.now.getAttribute('aria-disabled') === 'true') return;
    goNow();
  });
  listen(ref.time, 'change', (e) => {
    const v = Number(e.target.value);
    if (!SPEEDS.includes(v)) return;
    if (v !== 1) state.live = false;
    state.speed = v;
    uiDirty = true;
  });

  listen(ref.all, 'click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    opts.onOpenCatalogue();
  });
  ref.all.href = opts.catalogueHref;
  listen(ref.again, 'click', () => playAgain());

  function dismissHint() {
    if (state.hintDismissed) return;
    state.hintDismissed = true;
    updateBeats();
  }

  // ---- zoom --------------------------------------------------------------------------------
  function ensureCustom() {
    if (state.custom || !state.follow) return;
    const d = chaseDefaults();
    state.yaw = d.yaw;
    state.pitch = d.pitch;
    state.dist = state.distTarget = d.dist;
    state.custom = true;
  }

  /** Zoom by a factor (below 1 is closer), damped, aimed at the satellite (or the Earth when not following). */
  function zoomBy(factor) {
    if (state.follow) {
      ensureCustom();
      const lim = zoomLimits();
      state.distTarget = clamp(state.distTarget * factor, lim.min, lim.max);
    } else {
      state.cdistTarget = clamp(state.cdistTarget * factor, 1.3, 6);
    }
    if (reducedMotion()) {
      state.dist = state.distTarget;
      state.cdist = state.cdistTarget;
    }
    blend = null;
    dismissHint();
    uiDirty = true;
  }

  /** Fly in close to the satellite and keep following it. */
  function zoomToSatellite() {
    if (!state.follow) setFollow(true);
    ensureCustom();
    const lim = zoomLimits();
    state.distTarget = lim.min * 1.35;
    if (reducedMotion()) state.dist = state.distTarget;
    dismissHint();
    uiDirty = true;
  }

  listen(ref.zoomIn, 'click', () => zoomBy(0.7));
  listen(ref.zoomOut, 'click', () => zoomBy(1 / 0.7));

  // ---- input: drag, pinch, wheel, keys --------------------------------------------------
  const pointers = new Map();
  let dragged = false;
  let pinch = null;
  let lastSatTap = 0;

  function rotateBy(dx, dy) {
    if (state.follow) {
      ensureCustom();
      state.yaw -= (dx * Math.PI) / H;
      state.pitch = clamp(state.pitch + (dy * Math.PI * 0.6) / H, 2 * DEG, 89 * DEG);
    } else {
      const k = (2 * frame.tanHalf * Math.max(0.15, state.cdist - 0.95)) / H;
      state.theta -= dx * k;
      state.phi = clamp(state.phi - dy * k, 0.06, Math.PI - 0.06);
    }
    blend = null;
    uiDirty = true;
  }

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  function hitsSatellite(clientX, clientY) {
    if (!satellite || !satHolder.visible) return false;
    const r = canvas.getBoundingClientRect();
    pointerNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
    return raycaster.intersectObjects(satellite.hitObjects || [], true).length > 0;
  }

  const dragClass = (on) => document.documentElement.classList.toggle('jy-dragging', on);
  listen(canvas, 'pointerdown', (e) => {
    if (!interactive()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // a drag that starts on the globe never selects the text it passes over
    if (e.pointerType === 'mouse') e.preventDefault();
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch { /* not an active pointer (e.g. already released): carry on without capture */ }
    dragClass(true);
    dragged = pointers.size > 0;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    pinch = null;
  });
  listen(canvas, 'pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!dragged && Math.hypot(p.x - p.x0, p.y - p.y0) > 4) {
      dragged = true;
      dismissHint();
      hideCard();
    }
    if (!dragged) return;
    if (pointers.size === 1) rotateBy(dx, dy);
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && span > 0) zoomBy(pinch / span);
      pinch = span;
      rotateBy(dx / 2, dy / 2);
    }
  });
  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch { /* never captured */ }
    if (pointers.size < 2) pinch = null;
    if (e.type === 'pointerup' && !dragged && pointers.size === 0) {
      hideCard();
      closeCredits();
      if (hitsSatellite(e.clientX, e.clientY)) {
        // pointer events carry no click count: a second tap soon after is a double click
        const now = performance.now();
        const second = now - lastSatTap < 400;
        lastSatTap = second ? 0 : now;
        satelliteClicked(second ? 2 : 1);
      } else {
        // a click on empty space
        dismissHint();
        if (state.panel) closePanel();
      }
    }
    if (pointers.size === 0) {
      dragged = false;
      dragClass(false);
    }
  };
  listen(canvas, 'pointerup', endPointer);
  listen(canvas, 'pointercancel', endPointer);
  listen(canvas, 'dblclick', (e) => {
    if (interactive() && hitsSatellite(e.clientX, e.clientY)) e.preventDefault();
  });

  /**
   * The wheel. Through the story it scrolls the page. Once the story has
   * ended and locked (nothing left to scroll), the wheel over the globe
   * zooms, both ways, clamped. A gesture keeps doing what it started doing,
   * so the tail of the scroll that reached the end never turns into a zoom.
   * A trackpad pinch (ctrl+wheel) zooms whenever the globe is interactive.
   */
  const wheel = { t: 0, zoom: false };
  listen(stage, 'wheel', (e) => {
    const now = performance.now();
    const fresh = now - wheel.t > 220;
    wheel.t = now;
    const overGlobe = e.target === canvas || (marks.contains(e.target) && e.target !== marks);
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1);
    if (e.ctrlKey) {
      if (interactive() && overGlobe) {
        e.preventDefault();
        zoomBy(Math.exp(dy * 0.01));
      }
      return;
    }
    if (fresh) wheel.zoom = interactive() && overGlobe && state.locked;
    if (!wheel.zoom) return;
    e.preventDefault();
    zoomBy(Math.exp(clamp(dy, -200, 200) * 0.0015));
  }, { passive: false });

  listen(canvas, 'keydown', (e) => {
    if (!interactive() || e.altKey || e.metaKey || e.ctrlKey) return;
    const step = 40;
    switch (e.key) {
      case 'ArrowLeft': rotateBy(step, 0); break;
      case 'ArrowRight': rotateBy(-step, 0); break;
      case 'ArrowUp': rotateBy(0, step); break;
      case 'ArrowDown': rotateBy(0, -step); break;
      case '+': case '=': zoomBy(0.8); break;
      case '-': case '_': zoomBy(1 / 0.8); break;
      default: return;
    }
    dismissHint();
    e.preventDefault();
  });
  listen(root, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.creditsOpen) {
      closeCredits({ restoreFocus: true });
      e.preventDefault();
    } else if (!ref.card.hidden) {
      hideCard();
      e.preventDefault();
    } else if (state.panel) {
      closePanel({ restoreFocus: true });
      e.preventDefault();
    }
  });

  // ---- the frame loop -------------------------------------------------------------------
  let raf = 0;
  let lastNow = performance.now();
  let lastPerf = performance.now();
  let lastDraw = -Infinity;
  let lastYawCheck = 0;
  let needsFrame = true;
  let trackAt = -Infinity;
  let trackSimAt = 0;
  const trackXYZ = new Float32Array(260 * 3);
  const trackW = new Float32Array(260);
  let trackN = 0;

  function rebuildTrack(ms) {
    if (!orbit || !sat.ok) {
      trackN = 0;
      orbitLine.setPoints(trackXYZ, trackW, 0);
      return;
    }
    const periodMs = orbit.periodMinutes(ms) * MIN_MS;
    const n = 120;
    const step = periodMs / (2 * n);
    let k = 0;
    const index = orbit.indexAt(ms);
    for (let i = -n; i <= n; i++) {
      const t = ms + i * step;
      const pv = orbit.eciAt(t, index);
      if (!pv) continue;
      trackXYZ[k * 3] = pv.r.x / EARTH_RADIUS_KM;
      trackXYZ[k * 3 + 1] = pv.r.z / EARTH_RADIUS_KM;
      trackXYZ[k * 3 + 2] = -pv.r.y / EARTH_RADIUS_KM;
      // the coming half at full strength, the half already flown at 35%
      trackW[k] = i >= 0 ? 1 : 0.35;
      k += 1;
    }
    trackN = k;
    orbitLine.setPoints(trackXYZ, trackW, k);
    trackSimAt = ms;
  }

  function setSatOpacity(k) {
    if (Math.abs(k - satOpacity) < 0.002) return;
    satOpacity = k;
    for (const m of satMaterials) m.opacity = k;
    satHolder.visible = k > 0.002;
  }

  const qSat = new THREE.Quaternion();
  const mSat = new THREE.Matrix4();
  const sunDir = new THREE.Vector3();

  function frameLoop(now) {
    raf = requestAnimationFrame(frameLoop);
    const dt = Math.min(0.25, (now - lastNow) / 1000);
    lastNow = now;

    // time
    if (state.live) state.simMs = Date.now();
    else state.simMs += (now - lastPerf) * state.speed;
    lastPerf = now;
    const ms = state.simMs;

    // progress: scroll only, lightly damped (not at all under reduced motion)
    readScroll();
    if (state.mode === 'story') {
      if (reducedMotion()) state.pSmooth = state.pTarget;
      else {
        state.pSmooth += (state.pTarget - state.pSmooth) * (1 - Math.exp(-dt / SCROLL_LAG_S));
        if (Math.abs(state.pTarget - state.pSmooth) < 1e-4) state.pSmooth = state.pTarget;
      }
      // back above the swing's end the story has the camera again
      if (state.pTarget < P.swingEnd && (state.custom || !state.follow)) {
        startBlend();
        resetCamera();
        uiDirty = true;
      }
      maybeLock(false);
    }
    updateBeats();

    // zoom eases toward its target
    if (state.dist > 0 && state.distTarget > 0 && state.dist !== state.distTarget) {
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / ZOOM_LAG_S);
      state.dist *= Math.pow(state.distTarget / state.dist, k);
      if (Math.abs(Math.log(state.dist / state.distTarget)) < 1e-4) state.dist = state.distTarget;
    }
    if (state.cdist !== state.cdistTarget) {
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / ZOOM_LAG_S);
      state.cdist *= Math.pow(state.cdistTarget / state.cdist, k);
      if (Math.abs(Math.log(state.cdist / state.cdistTarget)) < 1e-4) state.cdist = state.cdistTarget;
    }

    const theta = gmstAt(ms);
    updateSatellite(ms, theta);
    paintText(now);

    if (!renderer) return;
    // idle at 1x: 30 frames a second is plenty
    const busy = blend || pointers.size || state.speed !== 1 || needsFrame
      || Math.abs(state.pTarget - state.pSmooth) > 1e-4 || state.dist !== state.distTarget || state.cdist !== state.cdistTarget;
    if (!busy && now - lastDraw < 33) return;
    lastDraw = now;
    needsFrame = false;

    const sun = sunPosition(ms);
    if (earth) earth.setTime(theta, sun, ms);

    // orbit line points (and, now and then, whether the default heading still clears the text)
    if (now - trackAt > (state.speed === 1 ? 250 : 0) || Math.abs(ms - trackSimAt) > 20_000) {
      rebuildTrack(ms);
      trackAt = now;
    }
    if (now - lastYawCheck > 3000) {
      lastYawCheck = now;
      chooseYaw();
    }

    computeCamera(now, theta);
    if (earth) earth.update(dt, camera);

    // satellite: true position, drawn far larger than life, nose along the track, nadir down
    const p = storyProgress();
    const satAlpha = !sat.ok ? 0 : smoothstep(P.satIn, P.satFull, p);
    let lengthPx = frame.satPx;
    if (satellite) {
      satellite.object3d.position.copy(sat.S);
      tmpA.crossVectors(sat.U, sat.F); // x
      mSat.makeBasis(tmpA, sat.U, sat.F);
      qSat.setFromRotationMatrix(mSat);
      satellite.object3d.quaternion.copy(qSat);
      // a fixed size on screen from the end view outward; from there inward it keeps
      // that exaggeration, so zooming in brings it closer like a real object
      const distance = camera.position.distanceTo(sat.S);
      const def = zoomLimits().def;
      const unitsPerPx = (2 * frame.tanHalf * Math.max(distance, def)) / H;
      const length = satellite.bodyBounds ? satellite.bodyBounds.max.z - satellite.bodyBounds.min.z : 0.34;
      satellite.setScale((frame.satPx * unitsPerPx) / Math.max(0.05, length));
      lengthPx = frame.satPx * Math.max(1, def / Math.max(1e-6, distance));
      setSatOpacity(satAlpha);
      // the Sun on it, unless the Earth is in the way; earthshine from below
      sunDir.set(sun.x, sun.z, -sun.y).normalize();
      const s = sat.state;
      const light = s ? satelliteLight(s.eci, sun) : 'sunlit';
      sunLight.intensity = light === 'sunlit' ? 3.2 : light === 'terminator' ? 1.6 : 0;
      sunLight.position.copy(sat.S).addScaledVector(sunDir, 5);
      sunLight.target.position.copy(sat.S);
      // in the Earth's shadow it goes dark, but never so dark it can't be found
      ambient.intensity = light === 'shadow' ? 0.5 : 0.05;
      if (s && satellite.setEarthshine) {
        const ground = sunElevationDeg(s.latDeg, s.lonDeg, ms);
        satellite.setEarthshine(lerp(0.9, 1, smoothstep(-8, 4, ground)));
      }
    }

    orbitLine.setOpacity(satAlpha);
    if (satAlpha > 0.002) orbitLine.update(camera, W, H);

    renderer.render(scene, camera);
    updateMarks(theta, satAlpha, lengthPx);
  }

  function startLoop() {
    if (raf || destroyed) return;
    lastNow = performance.now();
    lastPerf = lastNow;
    raf = requestAnimationFrame(frameLoop);
  }
  function stopLoop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function syncLoop() {
    if (state.shown && state.visible && !document.hidden) startLoop();
    else stopLoop();
  }

  // ---- modes --------------------------------------------------------------------------
  function applyMode() {
    const mode = webgl ? 'story' : 'still';
    state.mode = mode;
    root.dataset.mode = mode;
    root.classList.toggle('jy-reduced', reducedMotion());
    blend = null;
    if (mode === 'still') {
      state.pTarget = 1;
      state.pSmooth = 1;
    }
    for (const key of Object.keys(beatShown)) beatShown[key] = null;
    resize();
    updateBeats();
  }

  // ---- no WebGL: a still Earth behind the same text ------------------------------------
  function layoutStill() {
    still.hidden = false;
    stage.classList.add('jy-earth-ready');
    const size = Math.round(Math.min(W * 0.9, H * 0.62));
    still.style.left = `${Math.round(W * (frame.narrow ? 0.5 : 0.7) - size / 2)}px`;
    still.style.top = `${Math.round(H * (frame.narrow ? 0.72 : 0.6) - size / 2)}px`;
    if (still.dataset.size !== String(size)) {
      still.dataset.size = String(size);
      drawStillEarth(still, size, CALGARY.latDeg, CALGARY.lonDeg);
    }
  }

  // ---- state in and out -------------------------------------------------------------------
  function currentScroll() {
    return { progress: state.mode === 'story' ? state.pTarget : 1, offset: state.offsetPx, height: state.sectionPx };
  }

  function getState() {
    if (!state.saved) readScroll();
    const where = state.saved || currentScroll();
    return {
      v: STATE_VERSION,
      progress: Math.round(where.progress * 1e4) / 1e4,
      scroll: { offset: Math.round(where.offset), height: Math.round(where.height) },
      live: state.live,
      simMs: state.live ? null : Math.round(state.simMs),
      speed: state.speed,
      camera: state.follow
        ? { mode: 'follow', custom: state.custom, yaw: state.yaw, pitch: state.pitch, distance: state.distTarget }
        : { mode: 'earth', theta: state.theta, phi: state.phi, distance: state.cdistTarget },
      panel: state.panel ? (state.sheetOpen ? 'satellite-open' : 'satellite') : null,
      selectedId: state.selectedId,
      hintDismissed: state.hintDismissed,
      locked: state.locked,
    };
  }

  function applyState(s) {
    if (!s || typeof s !== 'object' || (s.v !== STATE_VERSION && s.v !== 1)) return false;
    const num = (x, d) => (Number.isFinite(x) ? x : d);
    if (s.live === false && Number.isFinite(s.simMs)) {
      state.live = false;
      state.simMs = s.simMs;
    } else {
      state.live = true;
      state.simMs = Date.now();
    }
    state.speed = SPEEDS.includes(s.speed) ? s.speed : 1;
    if (state.speed !== 1) state.live = false;
    const c = s.camera || {};
    if (c.mode === 'earth') {
      state.follow = false;
      state.custom = false;
      state.theta = num(c.theta, 0);
      state.phi = clamp(num(c.phi, Math.PI / 2), 0.06, Math.PI - 0.06);
      state.cdist = state.cdistTarget = clamp(num(c.distance, 3), 1.3, 6);
    } else {
      state.follow = true;
      state.custom = !!c.custom;
      state.yaw = num(c.yaw, 0);
      state.pitch = clamp(num(c.pitch, 0.5), 2 * DEG, 89 * DEG);
      state.dist = state.distTarget = clamp(num(c.distance, 0.25), 0.002, 4);
    }
    state.selectedId = typeof s.selectedId === 'string' ? s.selectedId : null;
    state.hintDismissed = !!s.hintDismissed;
    state.wantLock = !!s.locked;
    if (state.locked && s.locked === false) {
      // a state from mid-story: open the story up again
      state.locked = false;
      sessionSet(LOCK_KEY, null);
      root.classList.remove('jy-locked');
      stopTicker();
    }
    state.saved = {
      progress: clamp(num(s.progress, 0), 0, 1),
      offset: num(s.scroll?.offset, NaN),
      height: num(s.scroll?.height, NaN),
    };
    blend = null;
    trackAt = -Infinity;
    uiDirty = true;
    paintSelected();
    if (s.panel === 'satellite' || s.panel === 'satellite-open') {
      openPanel({ focus: false });
      if (s.panel === 'satellite-open') setSheet(true);
    }
    return true;
  }

  /** Put the page back where it was: scroll position and story progress, no replay. */
  function restoreScroll() {
    const saved = state.saved;
    if (!saved) return;
    if (state.locked || state.wantLock) {
      // the end: nothing to scroll, just the globe at the top of the section
      state.wantLock = false;
      state.saved = null;
      lock({ landing: true });
      return;
    }
    // the beats jump straight to where they belong: no entrance played
    root.classList.add('jy-instant');
    scrollToSaved(saved);
    for (const key of Object.keys(beatShown)) beatShown[key] = null;
    updateBeats();
    // once more after layout settles (fonts, the rest of the page rendering)
    requestAnimationFrame(() => {
      if (destroyed) return;
      if (state.saved === saved) {
        scrollToSaved(saved);
        state.saved = null;
      }
      updateBeats();
      settleInstant();
    });
  }

  /** Let transitions run again once the restored frame has been drawn (or soon, in a background tab). */
  function settleInstant() {
    const done = () => root.classList.remove('jy-instant');
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, 150);
  }

  // ---- the facts ticker (site/explore/facts.js, if it is there) ------------------------------
  let ticker = null;
  let tickerLoading = null;
  let newsList = null;

  /** Live numbers for the ticker; they follow 60x and 600x. */
  let liveRev = { at: 0, value: null };
  function live() {
    const s = sat.state;
    const ms = state.simMs;
    if (s && orbit && Math.abs(ms - liveRev.at) > 1000) liveRev = { at: ms, value: orbit.revolutionAt(ms) };
    return {
      speedKmS: s ? s.speedKmS : null,
      altKm: s ? s.altKm : null,
      latDeg: s ? s.latDeg : null,
      lonDeg: s ? s.lonDeg : null,
      placeName: s ? regionAt(s.latDeg, s.lonDeg) : null,
      orbitsSinceLaunch: s ? liveRev.value : null,
      daysInOrbit: ms >= LAUNCH_MS ? (ms - LAUNCH_MS) / DAY_MS : null,
      pictures: photos.length || null,
    };
  }

  function loadTicker() {
    if (tickerLoading) return tickerLoading;
    tickerLoading = (async () => {
      try {
        const mod = await import('./facts.js');
        let data = null;
        try {
          const res = await fetch(new URL('facts.json', MODULE_BASE).href, { cache: 'no-cache' });
          if (res.ok) data = await res.json();
        } catch { /* the module may bring its own */ }
        const href = new URL('facts.css', MODULE_BASE).href;
        if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          document.head.appendChild(link);
        }
        const facts = Array.isArray(data) ? data : data?.facts;
        const news = Array.isArray(data?.news) ? data.news : undefined;
        if (destroyed) return;
        if (typeof mod.createFactTicker === 'function') {
          ticker = mod.createFactTicker(ref.factsSlot, { facts, live, reducedMotion: reducedMotion() });
        }
        if (typeof mod.createNewsList === 'function') newsList = mod.createNewsList(ref.newsSlot, { news });
        if (state.locked && state.shown) ticker?.start?.();
      } catch {
        // no facts module (yet): nothing to show
      }
    })();
    return tickerLoading;
  }

  /** The ticker runs only at the end of the story. */
  function startTicker() {
    if (!webgl) return;
    loadTicker();
    ticker?.start?.();
  }
  function stopTicker() {
    ticker?.stop?.();
  }

  // ---- photos ---------------------------------------------------------------------------
  function setPhotos(list) {
    photos = Array.isArray(list) ? list.filter((p) => p && p.id) : [];
    latest = photos.reduce((best, p) => (!best || (p.sortTime || 0) > (best.sortTime || 0) ? p : best), null);
    ref.latest.dataset.id = '';
    const n = photos.length;
    ref.all.textContent = n ? `See all ${n.toLocaleString('en-US')} pictures` : 'See the pictures';
    if (webgl) buildPins();
    uiDirty = true;
  }

  // ---- wiring ----------------------------------------------------------------------------
  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(stage);
  // the text blocks set where the Earth may go
  const textObserver = new ResizeObserver(() => {
    computeFrame();
    needsFrame = true;
  });
  textObserver.observe(ref.b1);
  textObserver.observe(ref.b2);
  textObserver.observe(ref.b3);
  document.fonts?.ready?.then(() => !destroyed && resize());

  const io = new IntersectionObserver((entries) => {
    state.visible = entries.some((e) => e.isIntersecting);
    syncLoop();
  });
  io.observe(section);
  listen(document, 'visibilitychange', syncLoop);
  listen(window, 'scroll', () => {
    state.lastScrollAt = performance.now();
    readScroll();
  }, { passive: true });
  // where supported, scrollend says the scroll has come to rest (the frame loop also checks)
  listen(window, 'scrollend', () => {
    readScroll();
    maybeLock(true);
  });
  listen(motionQuery, 'change', () => {
    if (!motionOverride) applyMode();
  });
  listen(touchQuery, 'change', () => {
    uiDirty = true;
  });

  // ---- start ------------------------------------------------------------------------------
  loadOrbit();
  setPhotos(opts.photos);
  applyMode();
  resetCamera();
  updateSatellite(state.simMs, gmstAt(state.simMs));
  paintText(performance.now());
  if (opts.initialState && applyState(opts.initialState)) {
    restoreScroll();
  } else if (state.mode === 'story' && (reducedMotion() || sessionGet(LOCK_KEY) === '1')) {
    // reduced motion, or the story already finished in this session: the finished globe
    lock({ landing: true });
  } else {
    readScroll();
    state.pSmooth = state.pTarget;
  }
  loadTicker();
  syncLoop();

  return {
    setPhotos,
    show() {
      if (destroyed || state.shown) return;
      state.shown = true;
      // the clock picks up where it stopped (live time stays live)
      lastPerf = performance.now();
      if (state.live) state.simMs = Date.now();
      resize();
      if (state.saved) restoreScroll();
      if (state.locked) ticker?.start?.();
      syncLoop();
    },
    hide() {
      if (destroyed || !state.shown) return;
      // the last place read while the section was laid out (the page may
      // already have switched view when this is called)
      readScroll();
      state.saved = currentScroll();
      state.shown = false;
      hideCard();
      closeCredits();
      stopTicker();
      syncLoop();
    },
    getState,
    /** Live numbers (speed, altitude, place, orbits, days, pictures), following 60x and 600x. */
    live,
    /** Open the credits panel over the globe; focus returns to `opener` when it closes. */
    openCredits(opener) {
      openCredits(opener || document.activeElement);
    },
    closeCredits() {
      closeCredits({ restoreFocus: true });
    },
    /** The same as "Play the intro again": unlock and go back to the top of the story. */
    playIntroAgain() {
      playAgain();
    },
    /** Restore a getState() object (also accepted as options.initialState). */
    setState(s) {
      if (applyState(s)) {
        computeFrame();
        restoreScroll();
      }
    },
    /** 'full', 'reduced', or null to follow prefers-reduced-motion. */
    setMotion(m) {
      motionOverride = m === 'full' || m === 'reduced' ? m : null;
      applyMode();
      readScroll();
    },
    /** For checking from the console; not an API. */
    get debug() {
      return {
        state, frame, sat, camera, scene, orbitLine, trackN, W, H, quality, earth, satellite, zoomLimits, chooseYaw, swingAngle,
        /** How much of the drawn track falls in the end-state text column plus the margin (0 = clear). */
        trackInText() {
          const t = frame.endText;
          if (!t) return null;
          const m = TEXT_MARGIN;
          return intrusion(frame.yaw, { left: t.left - m, top: t.top - m, right: t.right + m, bottom: t.bottom + m });
        },
        /** The swing sampled at n steps for the current satellite: the largest turn between steps, and so on. */
        swingCheck(n = 200, ms = state.simMs) {
          const theta = gmstAt(ms);
          updateSatellite(ms, theta);
          const r = { P: new THREE.Vector3(), q: new THREE.Quaternion(), lx: 0, ly: 0 };
          let prev = null;
          let maxStep = 0;
          let total = 0;
          let minR = Infinity;
          for (let i = 0; i <= n; i++) {
            storyRig(r, i / n, theta);
            minR = Math.min(minR, r.P.length());
            if (prev) {
              const step = (2 * Math.acos(clamp(Math.abs(prev.dot(r.q)), -1, 1))) / DEG;
              maxStep = Math.max(maxStep, step);
              total += step;
            }
            prev = r.q.clone();
          }
          return {
            swingDeg: +(swingAngle(theta) / DEG).toFixed(1),
            rollDeg: +(lastRoll / DEG).toFixed(1),
            maxStepDeg: +maxStep.toFixed(2),
            meanStepDeg: +(total / n).toFixed(2),
            minCameraRadius: +minR.toFixed(3),
            lat: sat.state ? +sat.state.latDeg.toFixed(1) : null,
          };
        },
      };
    },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      resizeObserver.disconnect();
      textObserver.disconnect();
      io.disconnect();
      clearTimeout(card.timer);
      for (const off of cleanups) off();
      ticker?.dispose?.();
      newsList?.dispose?.();
      document.documentElement.classList.remove('jy-dragging');
      earth?.dispose();
      satellite?.dispose();
      orbitLine.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss?.();
      root.remove();
    },
  };
}

function ensureStylesheet() {
  const href = new URL('journey.css', MODULE_BASE).href;
  const present = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href);
  if (present) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}
