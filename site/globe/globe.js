/**
 * CTS-SAT-1 orbit globe.
 *
 *   import { mountGlobe } from './globe/globe.js';
 *   const globe = mountGlobe(element, { photoId: '2026-09-17-071148z' });
 *   globe.setTime('2026-10-22T15:07:59Z');
 *   globe.focusPhoto('2026-10-22-150759z');
 *   globe.destroy();
 *
 * The element needs a size; the globe fills it. Data paths default to the
 * site layout (../data/*.json next to this folder).
 */
import { annotationUrls, applyAnnotations, launchTime, toPhotos } from './adapter.js';
import * as astro from './astro.js';
import { createScene, DEFAULT_DISTANCE } from './scene.js';

const MODULE_BASE = new URL('./', import.meta.url);
const SITE_ROOT = new URL('../', import.meta.url);
const SPEEDS = [1, 60, 600, 3600];
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const LOCAL_ZONE = 'America/Edmonton';
const PASS_COUNT = 4;
const PASS_MASK_DEG = 10;

const pad = (n) => String(n).padStart(2, '0');
const MINUS = '−';
const signed = (x, digits = 0) => (x < 0 ? MINUS : '') + Math.abs(x).toFixed(digits);

function utcDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function utcTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function isoUtc(ms) {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const localFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});
function localTime(ms, seconds = true) {
  const parts = {};
  for (const p of localFormat.formatToParts(ms)) parts[p.type] = p.value;
  return { time: `${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ''}`, zone: parts.timeZoneName };
}
const localDay = new Intl.DateTimeFormat('en-GB', { timeZone: LOCAL_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / MIN_MS));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${pad(min % 60)} min`;
}

function fmtOffset(ms) {
  const min = Math.round(Math.abs(ms) / MIN_MS);
  const sign = ms < 0 && min > 0 ? MINUS : '+';
  return `${sign}${Math.floor(min / 60)} h ${pad(min % 60)} m`;
}

function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

const ICONS = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10.2 6z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 1.8h2.4v8.4H2.6zM7 1.8h2.4v8.4H7z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3"/></svg>',
};

const TEMPLATE = `
  <div class="cg-stage">
    <canvas class="cg-canvas" tabindex="0" role="img"
      aria-label="Globe showing CTS-SAT-1, its orbit, the ground station and photo locations"></canvas>
    <div class="cg-labels" aria-hidden="true"></div>
    <div class="cg-tip" hidden></div>
  </div>

  <div class="cg-col cg-col-left">
    <header class="cg-head">
      <a class="cg-back" data-ref="back" hidden>← Gallery</a>
      <h1 class="cg-title">CTS-SAT-1 <span>FrontierSat</span></h1>
      <p class="cg-sub mono">NORAD 69015</p>
      <p class="cg-fine cg-credit">Earth: NASA Earth Observatory · Orbits: Space-Track.org · Places © <a
        href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a></p>
      <p class="cg-note" data-ref="note" hidden></p>
    </header>
    <section class="cg-panel" data-panel="sat" aria-label="Satellite">
      <div class="cg-panel-head">
        <h2>Satellite</h2>
        <button type="button" class="cg-btn cg-btn-small" data-ref="follow" aria-pressed="false"
          title="Keep the camera on the satellite (F)">Follow</button>
      </div>
      <dl class="cg-readouts">
        <div><dt>Latitude</dt><dd class="mono" data-ref="lat">—</dd></div>
        <div><dt>Longitude</dt><dd class="mono" data-ref="lon">—</dd></div>
        <div><dt>Altitude</dt><dd class="mono" data-ref="alt">—</dd></div>
        <div><dt>Speed</dt><dd class="mono" data-ref="speed">—</dd></div>
        <div><dt>Satellite</dt><dd data-ref="illum">—</dd></div>
        <div><dt>Ground below</dt><dd data-ref="ground">—</dd></div>
        <div><dt>Orbit</dt><dd class="mono" data-ref="orbit"
          title="Revolution number: ascending-node crossings since launch">—</dd></div>
      </dl>
      <p class="cg-fine" data-ref="tle"></p>
    </section>
    <p class="cg-fine cg-keys">Space play/pause · N now · ← → 1 min, with Shift 1 h · F follow</p>
  </div>

  <div class="cg-col cg-col-right">
    <section class="cg-panel" data-panel="passes" aria-label="Passes over Calgary">
      <div class="cg-panel-head">
        <h2>Passes over Calgary</h2>
        <span class="cg-fine">above ${PASS_MASK_DEG}°, UTC</span>
      </div>
      <p class="cg-status" data-ref="gs"></p>
      <div class="cg-pass-cols cg-fine" aria-hidden="true"><span>Rise</span><span>Max</span><span>Set</span><span>Max el</span></div>
      <ol class="cg-list cg-passes" data-ref="passes"></ol>
    </section>
    <section class="cg-panel cg-panel-photos" data-panel="photos" aria-label="Photos">
      <div class="cg-panel-head">
        <h2>Photos</h2>
        <span class="cg-fine" data-ref="photoCount"></span>
      </div>
      <ul class="cg-list cg-photos" data-ref="photos"></ul>
    </section>
  </div>

  <section class="cg-card" data-ref="card" hidden aria-live="polite" aria-label="Selected photo">
    <a class="cg-card-thumb" data-ref="cardThumbLink"><img data-ref="cardImg" alt="" decoding="async"><span>No preview</span></a>
    <div class="cg-card-head">
      <h3 class="cg-card-title" data-ref="cardTitle"></h3>
      <p class="mono" data-ref="cardTime"></p>
    </div>
    <div class="cg-card-body">
      <p class="mono" data-ref="cardPos"></p>
      <p data-ref="cardPlace"></p>
      <div class="cg-card-foot">
        <p data-ref="cardLight"></p>
        <a class="cg-card-link" data-ref="cardLink">Open photo</a>
      </div>
    </div>
    <button type="button" class="cg-icon-btn cg-card-close" data-ref="cardClose" aria-label="Close">${ICONS.close}</button>
  </section>

  <div class="cg-dock" data-ref="dock">
  <nav class="cg-tabs" aria-label="Panels">
    <button type="button" data-tab="sat" aria-pressed="false">Satellite</button>
    <button type="button" data-tab="passes" aria-pressed="false">Passes</button>
    <button type="button" data-tab="photos" aria-pressed="false">Photos</button>
    <button type="button" data-ref="share2" class="cg-share">Copy link</button>
  </nav>

  <div class="cg-clock" role="group" aria-label="Clock">
    <div class="cg-time">
      <div class="cg-utc mono" aria-live="off"><span data-ref="date">—</span> <span data-ref="hms"></span> <span class="cg-unit">UTC</span></div>
      <div class="cg-local cg-fine mono" data-ref="local"></div>
    </div>
    <div class="cg-transport">
      <button type="button" class="cg-btn cg-icon-btn" data-ref="play" aria-label="Pause">${ICONS.pause}</button>
      <div class="cg-speeds" role="group" aria-label="Speed" data-ref="speeds">
        ${SPEEDS.map((s) => `<button type="button" class="cg-btn" data-speed="${s}" aria-pressed="false">${s}×</button>`).join('')}
      </div>
      <button type="button" class="cg-btn cg-speed-cycle" data-ref="speedCycle" aria-label="Speed">1×</button>
      <button type="button" class="cg-btn" data-ref="now" aria-pressed="false" title="Live: now at 1× (N)">Now</button>
    </div>
    <div class="cg-scrub">
      <div class="cg-ticks" data-ref="ticks" aria-hidden="true"></div>
      <input type="range" data-ref="scrub" min="-1440" max="1440" step="1" value="0"
        aria-label="Time, up to a day either side of the focus time">
      <div class="cg-scrub-labels cg-fine mono" aria-hidden="true">
        <span>${MINUS}1 d</span><span data-ref="offset">+0 h 00 m</span><span>+1 d</span>
      </div>
    </div>
    <button type="button" class="cg-btn cg-share" data-ref="share">Copy link</button>
  </div>
  </div>
`;

/** Stand-in for the 3D scene when WebGL isn't available. */
function noScene() {
  const nothing = () => {};
  return {
    controls: { dragged: false, reducedMotion: false },
    setStation: nothing,
    setTime: nothing,
    setTrack: nothing,
    setSatellite: nothing,
    setSubsolar: nothing,
    setCoverage: nothing,
    setPins: nothing,
    setSelected: nothing,
    setHover: nothing,
    flyToGround: nothing,
    flyToSatellite: nothing,
    follow: nothing,
    pick: () => null,
    resize: nothing,
    frame: () => false,
    dispose: nothing,
  };
}

function ensureStylesheet() {
  const href = new URL('globe.css', MODULE_BASE).href;
  const present = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href);
  if (present) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.cgGlobe = '';
  document.head.appendChild(link);
}

/**
 * Mount the globe into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {string} [options.photoId]   focus this photo once data is loaded
 * @param {string|number|Date} [options.time]  start at this UTC time (paused) instead of live
 * @param {object|Array} [options.images]  an images.json payload already in hand (skips the fetch)
 * @param {'full'|'compact'} [options.ui]  'compact' keeps only the clock and the photo card
 * @param {boolean} [options.hashState]  read and write #t=<iso>&photo=<id> (standalone page)
 * @param {'global'|'focus'|false} [options.keyboard]  where shortcuts listen
 * @param {boolean} [options.wheelZoom]  wheel zooms; false needs Ctrl+wheel (for embeds in a scrolling page)
 * @param {string} [options.backHref]  show a "Gallery" link to this URL in the header
 * @param {string} [options.dataUrl] [options.tleUrl] [options.sampleUrl] [options.siteRoot] [options.textureBase]
 * @returns {{ setTime(t: string|number|Date, opts?: {play?: boolean}): void,
 *             focusPhoto(id: string, opts?: {fly?: boolean}): boolean,
 *             destroy(): void }}
 */
export function mountGlobe(container, options = {}) {
  const opts = {
    photoId: null,
    time: null,
    images: null,
    ui: 'full',
    hashState: false,
    keyboard: 'focus',
    wheelZoom: true,
    backHref: null,
    dataUrl: new URL('data/images.json', SITE_ROOT).href,
    tleUrl: new URL('data/tle.json', SITE_ROOT).href,
    sampleUrl: new URL('fixtures/images.sample.json', MODULE_BASE).href,
    siteRoot: SITE_ROOT.href,
    textureBase: new URL('textures/', MODULE_BASE).href,
    ...options,
  };

  ensureStylesheet();
  const root = document.createElement('div');
  root.className = 'cg';
  root.dataset.ui = opts.ui === 'compact' ? 'compact' : 'full';
  root.innerHTML = TEMPLATE;
  container.appendChild(root);

  const el = {};
  for (const node of root.querySelectorAll('[data-ref]')) el[node.dataset.ref] = node;
  const canvas = root.querySelector('.cg-canvas');
  const tip = root.querySelector('.cg-tip');

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const observer = astro.makeObserver(astro.CALGARY);

  const state = {
    ms: Date.now(),
    playing: true,
    speed: 1,
    live: true,
    focusMs: Date.now(),
    selectedId: null,
    follow: false,
    tab: null,
    userMovedCamera: false,
  };
  let orbit = null;
  let photos = [];
  let launchMs = astro.LAUNCH_MS;
  let loaded = false;
  let pendingFocus = null;
  let destroyed = false;
  const ac = new AbortController();
  const cleanups = [];
  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };

  // ---- scene -----------------------------------------------------------------
  let scene;
  try {
    scene = createScene(canvas, root.querySelector('.cg-labels'), {
      textureBase: opts.textureBase,
      preferSmallTextures: Math.min(container.clientWidth || 1024, window.innerWidth) < 700,
      reducedMotion: reducedMotionQuery.matches,
      wheelZoom: opts.wheelZoom,
      onUserMove(kind) {
        state.userMovedCamera = true;
        if (kind === 'rotate' && state.follow) setFollow(false);
        hideTip();
      },
    });
  } catch (err) {
    // No WebGL: keep the clock, readouts and lists working without the 3D view.
    console.warn('Globe: 3D view unavailable', err);
    const msg = document.createElement('p');
    msg.className = 'cg-nogl';
    msg.textContent = 'This browser can’t draw the 3D globe (WebGL is unavailable). Everything else on this page still works.';
    root.querySelector('.cg-stage').appendChild(msg);
    canvas.hidden = true;
    scene = noScene();
  }
  scene.setStation(astro.CALGARY.latDeg, astro.CALGARY.lonDeg);

  const head = root.querySelector('.cg-head');
  const layout = () => {
    // Side panels need width and height: a phone in landscape is wide but
    // too short for them, so it gets the bottom bar too.
    root.classList.toggle('cg-narrow', root.clientWidth < 760 || root.clientHeight < 560);
    root.style.setProperty('--cg-head-h', `${head.offsetHeight}px`);
    root.style.setProperty('--cg-dock-h', `${el.dock.offsetHeight}px`);
    root.style.setProperty('--cg-card-space', el.card.hidden ? '0px' : `${el.card.offsetHeight + 12}px`);
  };
  const resizeObserver = new ResizeObserver(() => {
    layout();
    scene.resize(root.clientWidth, root.clientHeight);
    paintTicks();
  });
  resizeObserver.observe(root);
  resizeObserver.observe(el.dock);
  resizeObserver.observe(el.card);
  resizeObserver.observe(head);
  layout();
  scene.resize(root.clientWidth || 800, root.clientHeight || 600);

  if (opts.backHref) {
    el.back.href = opts.backHref;
    el.back.hidden = false;
  }

  listen(reducedMotionQuery, 'change', () => {
    scene.controls.reducedMotion = reducedMotionQuery.matches;
  });

  // ---- clock -----------------------------------------------------------------
  let lastFrame = performance.now();
  let lastScene = 0;
  let lastUi = 0;
  let sceneDirty = true;
  let uiDirty = true;
  let raf = 0;

  function markDirty() {
    sceneDirty = true;
    uiDirty = true;
  }

  function setPlaying(playing) {
    state.playing = playing;
    if (!playing) state.live = false;
    paintTransport();
    if (!playing) writeHash();
  }

  function setSpeed(speed) {
    if (state.live && speed !== 1) state.live = false;
    state.speed = speed;
    paintTransport();
  }

  function goLive({ fly = true } = {}) {
    state.ms = Date.now();
    state.focusMs = state.ms;
    state.speed = 1;
    state.playing = true;
    state.live = true;
    paintTransport();
    paintTicks();
    markDirty();
    pushScene(true);
    if (fly) scene.flyToSatellite();
    writeHash();
  }

  function jumpTo(ms, { keepPlaying = false } = {}) {
    state.ms = ms;
    state.live = false;
    if (!keepPlaying) state.playing = false;
    if (Math.abs(ms - state.focusMs) > DAY_MS) state.focusMs = ms;
    paintTransport();
    paintTicks();
    markDirty();
    pushScene(); // so camera moves that follow see the new Earth rotation
  }

  function step(deltaMs) {
    jumpTo(state.ms + deltaMs, { keepPlaying: state.playing });
    writeHash();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - lastFrame, 250);
    lastFrame = now;
    if (state.playing) {
      state.ms = state.live ? Date.now() : state.ms + dt * state.speed;
      if (Math.abs(state.ms - state.focusMs) > DAY_MS) {
        state.focusMs = state.ms;
        paintTicks();
      }
    }
    // at 1x the satellite crawls a fraction of a pixel per frame: 10 fps is plenty
    const interval = state.playing && state.speed === 1 ? 100 : 0;
    if (sceneDirty || (state.playing && now - lastScene >= interval)) {
      pushScene();
      lastScene = now;
      sceneDirty = false;
    }
    if (state.follow) scene.follow();
    scene.frame(now);
    if (uiDirty || now - lastUi >= 100) {
      paintClock();
      if (uiDirty || now - lastUi >= 250) paintReadouts();
      lastUi = now;
      uiDirty = false;
    }
  }

  // ---- scene state -----------------------------------------------------------
  let satState = null;
  let trackKey = null;

  function pushScene(forceTrack = false) {
    const ms = state.ms;
    const theta = astro.gmst(ms);
    const sun = astro.sunPosition(ms);
    scene.setTime(theta, sun);
    const ss = astro.subsolarPoint(ms);
    scene.setSubsolar(ss.latDeg, ss.lonDeg);

    satState = orbit && ms >= launchMs ? orbit.stateAt(ms) : null;
    scene.setSatellite(satState);
    if (!satState) {
      scene.setCoverage(null);
      return;
    }
    const key = satState.index;
    if (forceTrack || trackKey === null || trackKey.index !== key || Math.abs(ms - trackKey.ms) > 10_000) {
      const period = orbit.periodMinutes(ms);
      const stepMs = 30_000;
      const n = Math.ceil((period * MIN_MS) / stepMs);
      const samples = [];
      for (let i = -n; i <= n; i++) {
        const t = ms + i * stepMs;
        if (t < launchMs) continue;
        const s = orbit.stateAt(t, key);
        if (s) samples.push({ latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.altKm, gmst: s.gmst, dtMin: (t - ms) / MIN_MS });
      }
      scene.setTrack(samples, period);
      trackKey = { index: key, ms };
    }
    const look = astro.lookAngles(observer, satState.ecef);
    satState.look = look;
    scene.setCoverage(
      look.elevationDeg > 0
        ? { latDeg: satState.latDeg, lonDeg: satState.lonDeg, altKm: satState.altKm, angle: astro.footprintAngle(satState.altKm) }
        : null,
    );
    maybeUpdatePasses(ms);
  }

  // ---- passes ----------------------------------------------------------------
  const passes = { list: null, fromMs: 0, timer: 0, lastRun: 0 };

  function maybeUpdatePasses(ms) {
    if (!orbit || passes.timer) return;
    const list = passes.list;
    const stale =
      !list ||
      ms < passes.fromMs - MIN_MS ||
      (list.length ? ms > list[0].setMs : ms > passes.fromMs + DAY_MS) ||
      ms > passes.fromMs + 3 * DAY_MS;
    if (!stale) return;
    const wait = Math.max(0, 300 - (performance.now() - passes.lastRun));
    passes.timer = setTimeout(() => {
      passes.timer = 0;
      if (destroyed) return;
      passes.lastRun = performance.now();
      passes.fromMs = state.ms;
      passes.list = astro.findPasses(orbit, observer, state.ms, { count: PASS_COUNT, minElevationDeg: PASS_MASK_DEG });
      paintPasses();
      uiDirty = true;
    }, wait);
  }

  function paintPasses() {
    const ol = el.passes;
    ol.replaceChildren();
    const list = passes.list || [];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'cg-empty';
      li.textContent = orbit
        ? 'No passes above 10° in the next few days.'
        : loaded
          ? 'Orbit data unavailable.'
          : 'Loading…';
      ol.appendChild(li);
      return;
    }
    for (const p of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cg-pass';
      const rise = localTime(p.riseMs, false);
      const set = localTime(p.setMs, false);
      const row = document.createElement('span');
      row.className = 'cg-pass-row mono';
      for (const text of [utcTime(p.riseMs), utcTime(p.maxMs), utcTime(p.setMs)]) {
        const s = document.createElement('span');
        s.textContent = text;
        row.appendChild(s);
      }
      const elv = document.createElement('span');
      elv.className = 'cg-pass-el';
      elv.textContent = `${Math.round(p.maxElevationDeg)}°`;
      row.appendChild(elv);
      const sub = document.createElement('span');
      sub.className = 'cg-pass-sub cg-fine';
      sub.textContent =
        `${localDay.format(p.riseMs)} · ${rise.time}–${set.time} ${set.zone} · ` +
        `${astro.compassPoint(p.riseAzimuthDeg)} → ${astro.compassPoint(p.setAzimuthDeg)}`;
      b.append(row, sub);
      b.title = `Show this pass (rises ${utcDate(p.riseMs)} ${utcTime(p.riseMs)} UTC)`;
      b.addEventListener('click', () => {
        closeSheet();
        jumpTo(p.maxMs);
        scene.flyToGround(astro.CALGARY.latDeg, astro.CALGARY.lonDeg, { distance: 2.6 });
        setFollow(false);
        writeHash();
      });
      li.appendChild(b);
      ol.appendChild(li);
    }
  }

  // ---- photos ----------------------------------------------------------------
  function placePhotos() {
    for (const p of photos) {
      p.ms = p.capturedAtUTC ? Date.parse(p.capturedAtUTC) : null;
      if (!Number.isFinite(p.ms)) p.ms = null;
      p.computed = false;
      if (p.ms !== null && (p.lat === null || p.lon === null) && orbit) {
        const s = orbit.stateAt(p.ms);
        if (s) {
          p.lat = s.latDeg;
          p.lon = s.lonDeg;
          p.computed = true;
        }
      }
      p.placed = p.ms !== null && p.lat !== null && p.lon !== null;
    }
    // placed photos newest first, then the ones without a time
    photos.sort((a, b) => (b.ms ?? -Infinity) - (a.ms ?? -Infinity));
    scene.setPins(photos.filter((p) => p.placed).map((p) => ({ id: p.id, latDeg: p.lat, lonDeg: p.lon })));
    scene.setSelected(state.selectedId);
    paintPhotoList();
    paintTicks();
  }

  function paintPhotoList() {
    const ul = el.photos;
    ul.replaceChildren();
    el.photoCount.textContent = photos.length ? String(photos.length) : '';
    if (!photos.length) {
      const li = document.createElement('li');
      li.className = 'cg-empty';
      li.textContent = loaded ? 'No photos yet.' : 'Loading…';
      ul.appendChild(li);
      return;
    }
    let unknownHeader = false;
    for (const p of photos) {
      if (p.ms === null && !unknownHeader) {
        unknownHeader = true;
        const h = document.createElement('li');
        h.className = 'cg-list-sub cg-fine';
        h.textContent = 'Time unknown · not placed';
        ul.appendChild(h);
      }
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cg-photo';
      b.dataset.id = p.id;
      if (p.id === state.selectedId) b.setAttribute('aria-current', 'true');
      const t = document.createElement('span');
      t.className = 'cg-photo-title';
      t.textContent = p.title;
      const m = document.createElement('span');
      m.className = 'cg-photo-meta mono';
      m.textContent = p.ms !== null ? `${utcDate(p.ms)} ${utcTime(p.ms)}` : `${p.captureDate || 'date unknown'} · time unknown`;
      b.append(t, m);
      b.addEventListener('click', () => {
        closeSheet();
        focusPhoto(p.id);
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  function paintTicks() {
    const box = el.ticks;
    box.replaceChildren();
    const start = state.focusMs - DAY_MS;
    for (const p of photos) {
      if (!p.placed || p.ms < start || p.ms > start + 2 * DAY_MS) continue;
      const tick = document.createElement('span');
      tick.className = p.id === state.selectedId ? 'cg-tick cg-tick-on' : 'cg-tick';
      tick.style.left = `${((p.ms - start) / (2 * DAY_MS)) * 100}%`;
      box.appendChild(tick);
    }
  }

  function findPhoto(id) {
    return photos.find((p) => p.id === id) || null;
  }

  function focusPhoto(id, { fly = true, immediate = false } = {}) {
    if (!loaded) {
      pendingFocus = { id, fly, immediate };
      return false;
    }
    const p = findPhoto(String(id));
    if (!p) return false;
    state.selectedId = p.id;
    scene.setSelected(p.id);
    if (p.ms !== null) {
      state.focusMs = p.ms;
      jumpTo(p.ms);
      pushScene(true);
      if (p.placed && fly) {
        setFollow(false);
        scene.flyToGround(p.lat, p.lon, { immediate });
      }
    }
    paintCard();
    paintPhotoList();
    paintTicks();
    writeHash();
    return true;
  }

  function clearSelection() {
    state.selectedId = null;
    scene.setSelected(null);
    paintCard();
    paintPhotoList();
    paintTicks();
    writeHash();
  }

  function paintCard() {
    const p = state.selectedId ? findPhoto(state.selectedId) : null;
    el.card.hidden = !p;
    root.classList.toggle('cg-has-card', !!p);
    if (!p) return;
    el.cardTitle.textContent = p.title;
    const href = safeHref(p.href);
    for (const a of [el.cardLink, el.cardThumbLink]) {
      if (href) a.href = href;
      else a.removeAttribute('href');
    }
    el.cardLink.hidden = !href;
    const thumb = safeHref(p.thumb);
    el.cardThumbLink.classList.toggle('cg-no-thumb', !thumb);
    if (thumb) {
      el.cardImg.hidden = false;
      el.cardImg.src = thumb;
    } else {
      el.cardImg.hidden = true;
      el.cardImg.removeAttribute('src');
    }
    el.cardImg.alt = p.title;
    el.cardPlace.textContent = p.placed && p.place ? String(p.place) : '';
    el.cardPlace.hidden = !el.cardPlace.textContent;
    if (p.ms === null) {
      el.cardTime.textContent = p.captureDate ? `${p.captureDate}\ntime unknown` : 'Capture time unknown';
      el.cardPos.textContent = 'Not placed on the globe';
      el.cardLight.textContent = '';
      return;
    }
    el.cardTime.textContent = `${utcDate(p.ms)}\n${utcTime(p.ms)} UTC`;
    if (!p.placed) {
      el.cardPos.textContent = 'Position unavailable';
      el.cardLight.textContent = '';
      return;
    }
    el.cardPos.textContent = `${fmtLat(p.lat)}  ${fmtLon(p.lon)}`;
    const sunEl = astro.sunElevationDeg(p.lat, p.lon, p.ms);
    const light = astro.groundLight(sunEl);
    const word = light === 'day' ? 'Ground sunlit' : light === 'twilight' ? 'Ground in twilight' : 'Ground dark';
    el.cardLight.textContent = `${word} · sun ${signed(sunEl)}°`;
  }

  listen(el.cardImg, 'error', () => {
    el.cardImg.hidden = true;
    el.cardThumbLink.classList.add('cg-no-thumb');
  });
  listen(el.cardImg, 'load', () => {
    el.cardThumbLink.classList.remove('cg-no-thumb');
  });
  listen(el.cardClose, 'click', clearSelection);

  // ---- readouts --------------------------------------------------------------
  const shown = new Map();
  function put(node, text) {
    if (shown.get(node) !== text) {
      node.textContent = text;
      shown.set(node, text);
    }
  }

  function paintClock() {
    put(el.date, utcDate(state.ms));
    put(el.hms, utcTime(state.ms));
    const local = localTime(state.ms);
    put(el.local, `${local.time} ${local.zone} · Calgary`);
    const offset = Math.round((state.ms - state.focusMs) / MIN_MS);
    if (document.activeElement !== el.scrub && String(offset) !== el.scrub.value) el.scrub.value = String(offset);
    put(el.offset, fmtOffset(state.ms - state.focusMs));
  }

  function paintReadouts() {
    const s = satState;
    const dash = '—';
    if (!s) {
      for (const k of ['lat', 'lon', 'alt', 'speed', 'illum', 'ground', 'orbit']) put(el[k], dash);
      put(
        el.tle,
        !orbit
          ? loaded
            ? 'Orbit data unavailable.'
            : 'Loading orbit…'
          : state.ms < launchMs
            ? `Not launched yet: lift-off ${utcDate(launchMs)} ${utcTime(launchMs).slice(0, 5)} UTC.`
            : 'No position: SGP4 failed for this time.',
      );
      put(el.gs, '');
      return;
    }
    put(el.lat, fmtLat(s.latDeg));
    put(el.lon, fmtLon(s.lonDeg));
    put(el.alt, `${s.altKm.toFixed(1)} km`);
    put(el.speed, `${s.speedKmS.toFixed(2)} km/s`);
    const sun = astro.sunPosition(state.ms);
    const light = astro.satelliteLight(s.eci, sun); // the gallery's model, so the two agree
    put(el.illum, light === 'sunlit' ? 'Sunlit' : light === 'shadow' ? 'In Earth’s shadow' : 'At the terminator · sun at Earth’s edge');
    el.illum.dataset.state = light;
    const sunEl = astro.sunElevationDeg(s.latDeg, s.lonDeg, state.ms);
    const ground = astro.groundLight(sunEl);
    put(el.ground, `${ground === 'day' ? 'Day' : ground === 'twilight' ? 'Twilight' : 'Night'} · sun ${signed(sunEl)}°`);
    const rev = orbit.revolutionAt(state.ms);
    put(el.orbit, rev === null ? dash : rev.toLocaleString('en-US'));
    const ageDays = (state.ms - s.tleEpochMs) / DAY_MS;
    const age =
      ageDays < 0
        ? `${Math.abs(ageDays).toFixed(1)} d ahead`
        : `${ageDays.toFixed(1)} d old`;
    put(
      el.tle,
      `TLE ${shortDate.format(s.tleEpochMs)} ${utcTime(s.tleEpochMs).slice(0, 5)} UTC · ${age}` +
        (Math.abs(ageDays) > 7 ? ' · position approximate' : ''),
    );

    const look = s.look || astro.lookAngles(observer, s.ecef);
    if (look.elevationDeg > 0) {
      put(
        el.gs,
        `In view now · el ${look.elevationDeg.toFixed(0)}° · az ${look.azimuthDeg.toFixed(0)}° ${astro.compassPoint(look.azimuthDeg)}`,
      );
      el.gs.dataset.state = 'up';
    } else {
      const next = (passes.list || []).find((p) => p.riseMs > state.ms);
      put(el.gs, next ? `Below the horizon · next pass in ${fmtDuration(next.riseMs - state.ms)}` : 'Below the horizon');
      el.gs.dataset.state = 'down';
    }
  }

  function paintTransport() {
    el.play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.play.title = state.playing ? 'Pause (Space)' : 'Play (Space)';
    for (const b of el.speeds.querySelectorAll('[data-speed]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === state.speed));
    }
    el.speedCycle.textContent = `${state.speed}×`;
    el.speedCycle.setAttribute('aria-label', `Speed ${state.speed} times, tap to change`);
    el.now.setAttribute('aria-pressed', String(state.live));
    root.classList.toggle('cg-live', state.live);
  }

  function setFollow(on) {
    state.follow = on;
    el.follow.setAttribute('aria-pressed', String(on));
    if (on) scene.flyToSatellite();
  }

  function setTab(tab) {
    state.tab = state.tab === tab ? null : tab;
    root.dataset.tab = state.tab || '';
    for (const b of root.querySelectorAll('[data-tab]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
    }
  }

  /** On narrow screens, put the sheet away so the globe shows what was picked. */
  function closeSheet() {
    if (state.tab && root.classList.contains('cg-narrow')) setTab(state.tab);
  }

  // ---- controls --------------------------------------------------------------
  listen(el.play, 'click', () => setPlaying(!state.playing));
  listen(el.now, 'click', () => goLive());
  for (const b of el.speeds.querySelectorAll('[data-speed]')) {
    listen(b, 'click', () => setSpeed(Number(b.dataset.speed)));
  }
  listen(el.speedCycle, 'click', () => setSpeed(SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]));
  listen(el.follow, 'click', () => setFollow(!state.follow));
  for (const b of root.querySelectorAll('[data-tab]')) listen(b, 'click', () => setTab(b.dataset.tab));
  listen(el.scrub, 'input', () => {
    state.ms = state.focusMs + Number(el.scrub.value) * MIN_MS;
    state.live = false;
    paintTransport();
    markDirty();
  });
  listen(el.scrub, 'change', () => writeHash());

  async function copyLink(button) {
    writeHash();
    const url = shareUrl();
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // no async clipboard outside secure contexts: fall back to a selection copy
      const area = document.createElement('textarea');
      area.value = url;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      root.appendChild(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
    }
    const before = 'Copy link';
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      if (!destroyed) button.textContent = before;
    }, 1600);
  }
  listen(el.share, 'click', () => copyLink(el.share));
  listen(el.share2, 'click', () => copyLink(el.share2));

  // pins: hover and click
  function hideTip() {
    tip.hidden = true;
    scene.setHover(null);
    canvas.style.cursor = '';
  }
  listen(canvas, 'pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const r = canvas.getBoundingClientRect();
    const hit = scene.pick(e.clientX - r.left, e.clientY - r.top);
    if (!hit) {
      if (!tip.hidden || canvas.style.cursor) hideTip();
      return;
    }
    scene.setHover(hit.type === 'photo' ? hit.id : null);
    if (hit.type === 'photo') {
      const p = findPhoto(hit.id);
      tip.textContent = p ? `${p.title} · ${utcTime(p.ms)} UTC` : '';
    } else if (hit.type === 'satellite') {
      tip.textContent = state.follow ? 'CTS-SAT-1' : 'CTS-SAT-1 · click to follow';
    } else if (hit.type === 'station') {
      tip.textContent = 'University of Calgary ground station';
    } else {
      tip.textContent = 'Subsolar point: the Sun is overhead here';
    }
    canvas.style.cursor = hit.type === 'photo' || hit.type === 'satellite' ? 'pointer' : '';
    tip.hidden = false;
    tip.style.transform = `translate(${Math.round(hit.x)}px, ${Math.round(hit.y)}px)`;
  });
  listen(canvas, 'pointerleave', hideTip);
  listen(canvas, 'pointerup', (e) => {
    if (scene.controls.dragged) return;
    const r = canvas.getBoundingClientRect();
    const hit = scene.pick(e.clientX - r.left, e.clientY - r.top, e.pointerType === 'mouse' ? 12 : 22);
    if (hit?.type === 'photo') {
      closeSheet();
      focusPhoto(hit.id);
    } else if (hit?.type === 'satellite') {
      setFollow(true);
    }
  });

  // keyboard
  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (t && (t.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT')) return;
    if (tag === 'INPUT' && t.type !== 'range') return;
    if (tag === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // the scrubber's own keys
    if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return;
    switch (e.key) {
      case ' ':
        setPlaying(!state.playing);
        break;
      case 'n':
      case 'N':
        goLive();
        break;
      case 'f':
      case 'F':
        setFollow(!state.follow);
        break;
      case 'ArrowLeft':
        step(-(e.shiftKey ? 60 : 1) * MIN_MS);
        break;
      case 'ArrowRight':
        step((e.shiftKey ? 60 : 1) * MIN_MS);
        break;
      case 'Escape':
        if (state.selectedId) clearSelection();
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  }
  if (opts.keyboard === 'global') listen(window, 'keydown', onKey);
  else if (opts.keyboard) listen(root, 'keydown', onKey);

  // ---- URL state -------------------------------------------------------------
  function hashParams() {
    if (!opts.hashState) return {};
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { t: p.get('t'), photo: p.get('photo') };
  }

  function stateParams() {
    const p = new URLSearchParams();
    if (!state.live) p.set('t', isoUtc(state.ms));
    if (state.selectedId) p.set('photo', state.selectedId);
    return p.toString().replace(/%3A/gi, ':');
  }

  function writeHash() {
    if (!opts.hashState || destroyed) return;
    const url = new URL(location.href);
    url.searchParams.delete('photo');
    const params = stateParams();
    url.hash = params ? `#${params}` : '';
    const next = url.href.replace(/#$/, '');
    if (next !== location.href) history.replaceState(history.state, '', next);
  }

  function shareUrl() {
    const url = new URL('index.html', MODULE_BASE);
    const params = stateParams();
    return params ? `${url.href}#${params}` : url.href;
  }

  function applyHash() {
    const h = hashParams();
    if (h.photo && h.photo !== state.selectedId) focusPhoto(h.photo, { immediate: false });
    if (h.t) {
      const ms = Date.parse(h.t);
      if (Number.isFinite(ms)) {
        state.focusMs = ms;
        jumpTo(ms);
      }
    }
  }
  if (opts.hashState) listen(window, 'hashchange', applyHash);

  // ---- loading -----------------------------------------------------------------
  async function fetchJson(url) {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-cache' });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function note(text, title = '') {
    el.note.hidden = !text;
    el.note.textContent = text;
    el.note.title = title;
  }

  async function loadOrbit() {
    try {
      orbit = new astro.Orbit(await fetchJson(opts.tleUrl));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Globe: no orbit data', err);
      orbit = null;
    }
  }

  async function loadPhotos() {
    let json = opts.images;
    let sample = false;
    if (!json) {
      try {
        json = await fetchJson(opts.dataUrl);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (err.status !== 404) {
          console.warn('Globe: photo data unavailable', err);
          note('Photo data unavailable');
          return [];
        }
        json = await fetchJson(opts.sampleUrl);
        sample = true;
        note('Sample data', 'site/data/images.json was not found, so the globe shows sample photos.');
      }
    }
    launchMs = launchTime(json) ?? astro.LAUNCH_MS;
    let list = toPhotos(json, { base: opts.siteRoot });
    if (!sample) {
      for (const url of annotationUrls(opts.siteRoot)) {
        try {
          list = applyAnnotations(list, await fetchJson(url));
          break;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
        }
      }
    }
    return list;
  }

  // ---- start -------------------------------------------------------------------
  paintTransport();
  paintPhotoList();
  paintPasses();
  pushScene(true);
  scene.flyToGround(astro.CALGARY.latDeg, astro.CALGARY.lonDeg, { distance: DEFAULT_DISTANCE, immediate: true });

  const hash = hashParams();
  const startPhoto = hash.photo || opts.photoId || null;
  const startTime = hash.t || opts.time || null;
  if (startTime !== null) {
    const ms = typeof startTime === 'number' ? startTime : Date.parse(startTime instanceof Date ? startTime.toISOString() : startTime);
    if (Number.isFinite(ms)) {
      state.focusMs = ms;
      jumpTo(ms);
    }
  }
  raf = requestAnimationFrame(frame);

  Promise.all([loadOrbit(), loadPhotos()])
    .then(([, list]) => {
      if (destroyed) return;
      photos = list;
      loaded = true;
      placePhotos();
      trackKey = null;
      pushScene(true);
      paintPasses();
      const wanted = pendingFocus || (startPhoto ? { id: startPhoto, fly: true, immediate: true } : null);
      pendingFocus = null;
      const focused = wanted ? focusPhoto(wanted.id, { fly: wanted.fly, immediate: wanted.immediate }) : false;
      if (wanted && !focused) {
        const msg = `Photo “${wanted.id}” not found`;
        note(el.note.hidden ? msg : `${el.note.textContent} · ${msg}`, el.note.title);
      }
      if (focused && startTime !== null && hash.t) {
        const ms = Date.parse(hash.t);
        if (Number.isFinite(ms)) {
          jumpTo(ms);
          writeHash();
        }
      }
      // nothing placed to look at: start on the satellite
      const onPhoto = focused && findPhoto(wanted.id)?.placed;
      if (!onPhoto && !state.userMovedCamera) scene.flyToSatellite({ immediate: true });
      markDirty();
    })
    .catch((err) => {
      if (err.name === 'AbortError' || destroyed) return;
      console.error('Globe: failed to load data', err);
      loaded = true;
      note('Could not load data');
      paintPhotoList();
    });

  // ---- public API ----------------------------------------------------------------
  return {
    setTime(t, { play = false } = {}) {
      const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
      if (!Number.isFinite(ms)) return;
      state.focusMs = ms;
      jumpTo(ms, { keepPlaying: false });
      if (play) setPlaying(true);
      writeHash();
    },
    focusPhoto(id, { fly = true } = {}) {
      return focusPhoto(id, { fly });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      ac.abort();
      clearTimeout(passes.timer);
      resizeObserver.disconnect();
      for (const off of cleanups) off();
      scene.dispose();
      root.remove();
    },
  };
}
