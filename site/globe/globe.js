/**
 * FrontierSat orbit globe.
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
import { loadCountries, placeAt, placeInSentence } from '../explore/journey-region.js';
import { annotationUrls, applyAnnotations, comparePhotos, launchTime, toPhotos, whenKnown } from './adapter.js';
import * as astro from './astro.js';
import { createColorWheel } from './colorwheel.js';
import { createMap } from './map2d.js';
import { createPlaceSearch } from './placesearch.js';
import { fmtKm } from './regionpasses.js';
import { createShotPanel } from './shotpanel.js';
import { rovingList } from './rovinglist.js';
import { grouped, plural } from '../assets/format.js';
import { CALGARY_TIME_ZONE, CALGARY_ZONE_NAME } from '../assets/calgary-clock.js';
import { auroraNote } from './aurora.js';
import { createPicturePins } from './picturepins.js';
import { createScene, DEFAULT_DISTANCE } from './scene.js';
import { createTimePicker, FAR_DAYS, offBy } from './timepick.js';

const MODULE_BASE = new URL('./', import.meta.url);
const SITE_ROOT = new URL('../', import.meta.url);
const SPEEDS = [1, 60, 600, 3600];
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const PASS_COUNT = 4;
const PASS_PEAK_DEG = 5;
const PANELS_KEY = 'cts-globe-panels';
const HEAD_KEY = 'cts-globe-head';

const pad = (n) => String(n).padStart(2, '0');
const MINUS = '−';

// Short months as the picture titles write them (adapter.js timeTitle), not Intl's "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 24, 2026", or "Oct 24" without the year. */
function utcDay(ms, year = true) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ''}`;
}
function utcTime(ms, seconds = true) {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
}
/** "Oct 24, 2026, 17:37 UTC" */
const utcWhen = (ms) => `${utcDay(ms)}, ${utcTime(ms, false)} UTC`;
function isoUtc(ms) {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const localFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: CALGARY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function localTime(ms, seconds = true) {
  const parts = {};
  for (const p of localFormat.formatToParts(ms)) parts[p.type] = p.value;
  return { time: `${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ''}`, zone: CALGARY_ZONE_NAME };
}
const localDay = new Intl.DateTimeFormat('en-US', { timeZone: CALGARY_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });

const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

/** "Daylight, sun 43° up", "Night, sun 12° below the horizon" (with `below`: "Daylight below, …"). */
function fmtGround(sunEl, below = '') {
  const light = astro.groundLight(sunEl);
  const word = light === 'day' ? 'Daylight' : light === 'twilight' ? 'Twilight' : 'Night';
  const sun = Math.round(Math.abs(sunEl));
  return `${word}${below}, sun ${sun}° ${sunEl >= 0 ? 'up' : 'below the horizon'}`;
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / MIN_MS));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "11m 31s", cut to the second rather than rounded, as SatWatch prints it. */
function fmtPassLength(ms) {
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
}

function fmtOffset(ms, exact = false) {
  // to the second when stopped, where the step buttons can land on one
  const secs = exact ? Math.round(Math.abs(ms) / 1000) : Math.round(Math.abs(ms) / MIN_MS) * 60;
  const sign = ms < 0 && secs > 0 ? MINUS : '+';
  const min = Math.floor(secs / 60);
  const whole = `${min < 60 ? '' : `${Math.floor(min / 60)} h `}${min % 60} min`;
  if (!(secs % 60)) return `${sign}${whole}`;
  return min ? `${sign}${whole} ${secs % 60} s` : `${sign}${secs} s`;
}

/** How far a step button goes at a speed: a second at 1×, so a minute at 60×. */
function stepWords(speed) {
  const [n, unit] = speed < 60 ? [speed, 'second'] : speed < 3600 ? [speed / 60, 'minute'] : [speed / 3600, 'hour'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** How far the orbital elements are from the time shown: "2 days old", "3 hours later". */
function fmtAge(ms) {
  const hours = Math.abs(ms) / 3_600_000;
  const n = hours < 24 ? Math.max(1, Math.round(hours)) : Math.round(hours / 24);
  return `${n} ${hours < 24 ? 'hour' : 'day'}${n === 1 ? '' : 's'} ${ms < 0 ? 'later' : 'old'}`;
}

function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** view=<lat>,<lon>,<distance> from a link: the camera's ground point and distance. */
function parseView(text) {
  const [lat, lon, distance] = String(text || '').split(',').map(Number);
  if (![lat, lon, distance].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, distance };
}

const ICONS = {
  eye: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path class="cg-previews-slash" d="M4 16L16 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  play:'<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10.2 6z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 1.8h2.4v8.4H2.6zM7 1.8h2.4v8.4H7z" fill="currentColor"/></svg>',
  stepBack:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 1.8h1.6v8.4H2.2zM10 1.8v8.4L4.6 6z" fill="currentColor"/></svg>',
  stepForward:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M8.2 1.8h1.6v8.4H8.2zM2 1.8v8.4L7.4 6z" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3"/></svg>',
  chevron:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.25L6 7.75l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  calendar:
    '<svg class="cg-time-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2.75h9v7.75h-9zM1.5 5.25h9M4 1v2.75M8 1v2.75" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  // the phone's tab bar, as on Explore (explore/journey.js); Passes: a pass over the horizon
  stats: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4 16.5V10M10 16.5V4M16 16.5v-9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  passes: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M2 15.5h16M4 15.5a6 6 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="9.5" r="1.9" fill="currentColor"/></svg>',
  pictures: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 13l4-4 3 3 2.5-2.5L17 14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  // Copy link, as an icon in the Globe / Map row on a phone: two links of a chain, then a tick once copied
  link: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M8.5 11.5l3-3M7.2 9.3L5.4 11.1a2.6 2.6 0 0 0 3.7 3.7l1.8-1.8M12.8 10.7l1.8-1.8a2.6 2.6 0 0 0-3.7-3.7L9.1 7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  copied: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

/** Steps for the zoom buttons and the + and − keys: the map's scale, the globe's height above the ground. */
const ZOOM_STEP = { map: 2, globe: 1.6 };

const TEMPLATE = `
  <div class="cg-stage">
    <canvas class="cg-canvas" tabindex="0" role="img"
      aria-label="Globe showing FrontierSat, its orbit, the ground station and where the pictures were taken"></canvas>
    <div class="cg-pins" data-ref="pinLayer" aria-hidden="true"></div>
    <div class="cg-labels" aria-hidden="true"></div>
    <div class="cg-tip" hidden></div>
    <div class="cg-peek" data-ref="peek" hidden></div>
    <p class="cg-toast" data-ref="toast" role="status"></p>
  </div>

  <div class="cg-views">
    <div class="cg-views-main" data-ref="viewsMain">
      <div class="cg-seg cg-seg-view" role="group" aria-label="View. Arrow keys move between them." data-ref="views">
        <button type="button" data-view="globe" aria-pressed="true" title="Globe (M)">Globe</button>
        <button type="button" data-view="map" aria-pressed="false" title="Map (M)">Map</button>
      </div>
      <button type="button" class="cg-btn cg-icon-btn cg-share cg-head-share" data-ref="share2"
        aria-label="Copy a link to this view" title="Copy link">${ICONS.link}</button>
    </div>
    <div class="cg-views-side" data-ref="viewsSide">
      <button type="button" class="cg-btn cg-aurora-btn" data-ref="auroraBtn" aria-pressed="true"
        title="Show or hide NOAA’s aurora forecast (A)">Aurora</button>
      <button type="button" class="cg-btn cg-previews-btn" data-ref="previewsBtn" hidden
        title="Show or hide the pictures on the globe and the map">${ICONS.eye}<span data-ref="previewsText">Hide photo previews</span></button>
    </div>
  </div>
  <div class="cg-seg cg-seg-zoom" role="group" aria-label="Zoom. Arrow keys move between them." data-ref="zoom">
    <button type="button" data-ref="zoomOut" aria-label="Zoom out" title="Zoom out (−)">−</button>
    <button type="button" data-ref="zoomIn" aria-label="Zoom in" title="Zoom in (+)">+</button>
  </div>

  <div class="cg-col cg-col-left">
    <header class="cg-head">
      <a class="cg-back" data-ref="back" hidden>All pictures</a>
      <h1 class="cg-title"><button type="button" class="cg-fold" data-ref="headFold" aria-expanded="true"
        title="Show or hide where it is">FrontierSat${ICONS.chevron}</button></h1>
      <div data-ref="headBody">
        <p class="cg-over" data-ref="over" hidden></p>
        <p class="cg-fine cg-sub">NORAD 69015.</p>
        <p class="cg-fine cg-credit">Earth imagery: NASA. Orbits: Space-Track.org. Places © <a
          href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.
          Borders: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>.
          Aurora: <a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noopener">NOAA SWPC</a>.</p>
        <p class="cg-fine cg-credit" data-ref="auroraNote" hidden></p>
        <p class="cg-fine cg-note" data-ref="note" hidden></p>
      </div>
    </header>
    <section class="cg-panel" data-panel="sat" data-ref="satPanel" aria-label="Stats">
      <div class="cg-panel-head">
        <h2><button type="button" class="cg-fold" data-ref="fold" aria-expanded="true">Stats${ICONS.chevron}</button></h2>
        <button type="button" class="cg-btn" data-ref="follow" aria-pressed="false"
          title="Keep the camera on the satellite (F)">Follow</button>
      </div>
      <div class="cg-fold-body">
      <p class="cg-fine cg-at" data-ref="at" hidden></p>
      <dl class="cg-readouts">
        <div><dt>Latitude</dt><dd data-ref="lat">—</dd></div>
        <div><dt>Longitude</dt><dd data-ref="lon">—</dd></div>
        <div><dt>Altitude</dt><dd data-ref="alt">—</dd></div>
        <div><dt>Speed</dt><dd data-ref="speed">—</dd></div>
        <div class="cg-wide"><dt>Sunlight</dt><dd data-ref="illum">—</dd></div>
        <div class="cg-wide"><dt>Below</dt><dd data-ref="ground">—</dd></div>
        <div class="cg-wide"><dt>Orbits so far</dt><dd data-ref="orbit"
          title="Times it has crossed the equator northbound since launch">—</dd></div>
      </dl>
      <p class="cg-fine cg-tle" data-ref="tle"></p>
      </div>
    </section>
    <details class="cg-keys" data-ref="keys">
      <summary>Keys</summary>
      <dl>
        <div><dt><kbd>Space</kbd></dt><dd>Pause or play</dd></div>
        <div><dt><kbd>N</kbd></dt><dd>Back to now</dd></div>
        <div><dt><kbd>,</kbd> <kbd>.</kbd></dt><dd>One step back or forward, by the speed</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>One minute (with Shift, one hour)</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move along a list or a row of buttons</dd></div>
        <div><dt><kbd>F</kbd></dt><dd>Follow the satellite</dd></div>
        <div><dt><kbd>T</kbd></dt><dd>Go to a date and time</dd></div>
        <div><dt><kbd>M</kbd></dt><dd>Switch between globe and map</dd></div>
        <div><dt><kbd>A</kbd></dt><dd>Show or hide the aurora (on the globe)</dd></div>
        <div><dt><kbd>+</kbd> <kbd>−</kbd></dt><dd>Zoom</dd></div>
        <div><dt><kbd>P</kbd></dt><dd>Show or hide the panels</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close the picture, this list or a dialog</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>Show or hide this list</dd></div>
      </dl>
    </details>
  </div>

  <div class="cg-col cg-col-right">
    <section class="cg-panel" data-panel="passes" data-ref="passesPanel" aria-label="Passes over Calgary">
      <div class="cg-panel-head">
        <h2 data-ref="passesTitle" tabindex="-1">Passes over Calgary</h2>
        <button type="button" class="cg-textbtn cg-change-place" data-ref="changePlace"
          aria-label="Change place: passes over another country or sea">Change place</button>
        <button type="button" class="cg-fold cg-fold-side" data-ref="passesFold" aria-expanded="true" aria-label="Show or hide the passes" disabled>${ICONS.chevron}</button>
      </div>
      <div data-ref="placeSlot"></div>
      <div class="cg-calgary-passes" data-ref="calgaryPasses">
        <p class="cg-fine cg-passes-note cg-fold-body">Seen from the RAO ground station, horizon to horizon, for passes reaching ${PASS_PEAK_DEG}°. Times are Calgary time.</p>
        <p class="cg-status" data-ref="gs"></p>
        <ol class="cg-list cg-passes cg-fold-body" data-ref="passes" role="list" aria-label="Next passes over Calgary. Arrow keys move between them."></ol>
      </div>
    </section>
    <section class="cg-panel cg-panel-photos" data-panel="photos" data-ref="photosPanel" aria-label="Pictures">
      <div class="cg-panel-head">
        <h2 data-ref="photosTitle">Pictures</h2>
        <span class="cg-fine cg-photo-count" data-ref="photoCount"></span>
        <button type="button" class="cg-fold cg-fold-side" data-ref="photosFold" aria-expanded="true" aria-label="Show or hide the pictures" disabled>${ICONS.chevron}</button>
      </div>
      <div class="cg-vf cg-fold-body" data-ref="vfSlot" hidden></div>
      <button type="button" class="cg-btn cg-highlight cg-fold-body" data-ref="highlight" hidden>Highlight photos taken by FrontierSat</button>
      <p class="cg-fine cg-tucked cg-fold-body" data-ref="tucked" hidden><span data-ref="tuckedText"></span>
        <button type="button" class="cg-textbtn" data-ref="tuckedBtn">Show them</button></p>
      <ul class="cg-list cg-photos cg-fold-body" data-ref="photos" role="list" aria-label="Pictures. Arrow keys move between them."></ul>
    </section>
  </div>

  <section class="cg-card" data-ref="card" hidden aria-live="polite" aria-label="Selected picture">
    <a class="cg-card-thumb" data-ref="cardThumbLink"><img data-ref="cardImg" alt="" decoding="async"><span>No preview</span></a>
    <div class="cg-card-head">
      <h3 class="cg-card-title" data-ref="cardTitle"></h3>
      <p data-ref="cardTime"></p>
    </div>
    <div class="cg-card-body">
      <p class="cg-card-pos" data-ref="cardPos"></p>
      <p data-ref="cardLight"></p>
      <a class="cg-card-link" data-ref="cardLink">Open picture</a>
    </div>
    <button type="button" class="cg-icon-btn cg-card-close" data-ref="cardClose" aria-label="Close">${ICONS.close}</button>
  </section>

  <div class="cg-dock" data-ref="dock">
  <nav class="cg-tabs" aria-label="Panels">
    <button type="button" class="cg-tab" data-tab="sat" aria-pressed="false">${ICONS.stats}<span>Stats</span></button>
    <button type="button" class="cg-tab" data-tab="passes" aria-pressed="false">${ICONS.passes}<span>Passes</span></button>
    <button type="button" class="cg-tab" data-tab="photos" aria-pressed="false">${ICONS.pictures}<span>Pictures</span></button>
  </nav>

  <div class="cg-clock" role="group" aria-label="Clock">
    <button type="button" class="cg-time" data-ref="timeBtn" aria-haspopup="dialog" aria-expanded="false"
      title="Go to a date and time (T)">
      <span class="cg-vh">Go to a time. Showing </span>
      <span class="cg-utc"><span data-ref="utc" aria-live="off">—</span><span class="cg-utc-year"
        data-ref="utcYear"></span>, <span class="cg-utc-tail"><span
        data-ref="utcTime" aria-live="off"></span>${ICONS.calendar}</span></span>
      <span class="cg-fine" data-ref="local"></span>
    </button>
    <div class="cg-transport">
      <div class="cg-steps">
        <button type="button" class="cg-btn cg-icon-btn cg-step" data-ref="stepBack" aria-label="Back 1 second">${ICONS.stepBack}</button>
        <button type="button" class="cg-btn cg-icon-btn" data-ref="play" aria-label="Pause">${ICONS.pause}</button>
        <button type="button" class="cg-btn cg-icon-btn cg-step" data-ref="stepForward" aria-label="Forward 1 second">${ICONS.stepForward}</button>
      </div>
      <div class="cg-speeds" role="group" aria-label="Speed. Arrow keys move between them." data-ref="speeds">
        ${SPEEDS.map((s) => `<button type="button" class="cg-btn" data-speed="${s}" aria-pressed="false">${s}×</button>`).join('')}
      </div>
      <button type="button" class="cg-btn cg-speed-cycle" data-ref="speedCycle" aria-label="Speed">1×</button>
      <button type="button" class="cg-btn cg-now" data-ref="now" aria-disabled="true" title="Showing now">Now</button>
    </div>
    <div class="cg-scrub">
      <div class="cg-ticks" data-ref="ticks" aria-hidden="true"></div>
      <input type="range" data-ref="scrub" min="-1440" max="1440" step="1" value="0"
        aria-label="Time, up to a day either side of the focus time">
      <div class="cg-scrub-labels cg-fine" aria-hidden="true">
        <span><span class="cg-scrub-long" data-ref="scrubEarly">A day earlier</span><span class="cg-scrub-short"
          data-ref="scrubEarlyShort">−1 day</span></span><span
          data-ref="offset">Now</span><span><span class="cg-scrub-long" data-ref="scrubLate">A day later</span><span
          class="cg-scrub-short" data-ref="scrubLateShort">+1 day</span></span>
      </div>
    </div>
    <button type="button" class="cg-btn cg-panels-btn" data-ref="panels" aria-expanded="true"
      title="Show or hide the side panels (P)">Hide panels</button>
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
    setAurora: nothing,
    auroraStatus: null,
    setPinsDrawn: nothing,
    pinsOnScreen: () => new Map(),
    marks: () => [],
    setViewCentre: nothing,
    satelliteScreen: () => null,
    setTrackColor: nothing,
    setTime: nothing,
    setTrack: nothing,
    setSatellite: nothing,
    setSubsolar: nothing,
    setCoverage: nothing,
    setPins: nothing,
    highlightPins: nothing,
    setSelected: nothing,
    setHover: nothing,
    flyToGround: nothing,
    flyToSatellite: nothing,
    viewPoint: () => null,
    follow: nothing,
    pick: () => null,
    resize: nothing,
    frame: () => false,
    zoomBy: nothing,
    zoomRoom: { in: false, out: false },
    dispose: nothing,
  };
}

function ensureStylesheet() {
  for (const name of ['globe.css', 'map2d.css', 'timepick.css', 'colorwheel.css', 'placesearch.css', 'shotpanel.css', '../explore/viewfinder.css']) {
    const href = new URL(name, MODULE_BASE).href;
    const present = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href);
    if (present) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.cgGlobe = '';
    document.head.appendChild(link);
  }
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
 * @param {boolean} [options.hashState]  read and write #t=<iso>&photo=<id>&mode=map (standalone page)
 * @param {'globe'|'map'} [options.view]  start on the 3D globe (default) or the flat map
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
    view: 'globe',
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

  // one Tab stop each, with the arrow keys inside: see rovinglist.js
  const passesList = rovingList(el.passes);
  const photosList = rovingList(el.photos);
  const speedsRow = rovingList(el.speeds, { axis: 'horizontal' });
  const viewsRow = rovingList(el.views, { axis: 'horizontal' });
  rovingList(el.zoom, { axis: 'horizontal' });

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
    panels: true,
    view: 'globe', // or 'map'
    userMovedCamera: false,
  };
  let orbit = null;
  let photos = [];
  let launchMs = astro.LAUNCH_MS;
  let loaded = false;
  let photosFailed = false;
  let pendingFocus = null;
  let destroyed = false;
  const ac = new AbortController();
  const cleanups = [];
  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };

  // ---- scene -----------------------------------------------------------------
  // the aurora and the picture previews; an embed keeps to the picture it's showing
  const full = opts.ui !== 'compact';
  // Only ?motion=reduced stills the page (the camera's glides, the views' easing, the aurora's
  // shimmer, the viewfinder), as on Explore: the site keeps its motion whatever the system asks.
  const stillMotion = new URLSearchParams(location.search).get('motion') === 'reduced';
  root.classList.toggle('cg-still', stillMotion);
  // the visitor's choices, shared with Explore
  const remembered = (key) => ({
    get() {
      try {
        return localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    },
    set(hidden) {
      try {
        if (hidden) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
      } catch { /* no storage: it's only remembered until the page closes */ }
    },
  });
  const auroraHidden = remembered('cts-aurora-hidden');
  const previewsHiddenChoice = remembered('cts-previews-hidden');
  let auroraOn = full && !auroraHidden.get();
  let scene;
  try {
    scene = createScene(canvas, root.querySelector('.cg-labels'), {
      textureBase: opts.textureBase,
      preferSmallTextures: Math.min(container.clientWidth || 1024, window.innerWidth) < 700,
      reducedMotion: stillMotion,
      wheelZoom: opts.wheelZoom,
      aurora: full,
      auroraOn,
      auroraStill: stillMotion,
      onUserMove(kind) {
        state.userMovedCamera = true;
        sheetViewMoved = true;
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
    root.classList.add('cg-nogl-on');
  }
  scene.setStation(astro.CALGARY.latDeg, astro.CALGARY.lonDeg);
  // the pictures as little pictures, over the globe and the map
  const picturePins = full ? createPicturePins(el.pinLayer) : null;
  let previewsHidden = Boolean(picturePins) && previewsHiddenChoice.get();

  /** Hidden, the views draw their small squares in their place, which still take a click. As on Explore. */
  function setPreviewsHidden(hidden) {
    previewsHidden = hidden;
    previewsHiddenChoice.set(hidden);
    for (const v of [scene, map]) v.setPinsDrawn(hidden);
    el.pinLayer.hidden = hidden;
    el.previewsBtn.classList.toggle('is-hidden', hidden);
    el.previewsText.textContent = hidden ? 'Show photo previews' : 'Hide photo previews';
  }

  // The flat map shares the stage, under the labels and tooltip. It needs
  // only canvas 2D, so without WebGL the page opens on it.
  const map = createMap(root.querySelector('.cg-stage'), {
    textureBase: opts.textureBase,
    preferSmallTextures: Math.min(container.clientWidth || 1024, window.innerWidth) < 700,
    reducedMotion: stillMotion,
    wheelZoom: opts.wheelZoom,
    onUserMove(kind) {
      state.userMovedCamera = true;
      sheetViewMoved = true;
      if (kind === 'pan' && state.follow) setFollow(false);
      hideTip();
    },
  });
  canvas.after(map.element);
  map.setStation(astro.CALGARY.latDeg, astro.CALGARY.lonDeg);
  const onMap = () => state.view === 'map';
  if (picturePins) {
    setPreviewsHidden(previewsHidden);
    el.previewsBtn.hidden = false;
  }

  // The orbit's colour: team blue unless this visitor has picked another.
  function paintOrbit(hex) {
    scene.setTrackColor(hex);
    map.setTrackColor(hex);
    root.style.setProperty('--cg-orbit', hex);
  }
  const wheel = createColorWheel({ onChange: paintOrbit });
  el.share2.before(wheel.button); // Globe / Map, the colour, then Copy link (a phone's icon)
  root.appendChild(wheel.element);
  paintOrbit(wheel.colour);

  // Camera moves go to both views, so switching shows the same place.
  function flyToGround(latDeg, lonDeg, o) {
    scene.flyToGround(latDeg, lonDeg, o);
    map.flyToGround(latDeg, lonDeg, o);
  }
  function flyToSatellite(o) {
    scene.flyToSatellite(o);
    map.flyToSatellite(o);
  }

  const head = root.querySelector('.cg-head');
  const tabsRow = root.querySelector('.cg-tabs');
  let uiScale = 1;
  /** Room the page keeps above the corners for its own nav (--cg-top, px). */
  const pageTop = () => parseFloat(getComputedStyle(root).getPropertyValue('--cg-top')) || 0;
  // Stats folds to its heading where a selected picture’s card needs
  // the room; its heading opens it again (until the card changes).
  let satFull = 0; // its height unfolded
  let satFoldedByUser = null;
  function setSatFold(folded) {
    el.satPanel.toggleAttribute('data-folded', folded);
    el.fold.setAttribute('aria-expanded', String(!folded));
  }
  listen(el.fold, 'click', () => {
    satFoldedByUser = el.fold.getAttribute('aria-expanded') === 'true';
    setSatFold(satFoldedByUser);
  });

  // Red waves from every picture's pin for a couple of seconds (ripple.js).
  listen(el.highlight, 'click', () => {
    closeSheet(); // on a phone the pictures' sheet would cover half of them
    scene.highlightPins();
    map.highlightPins();
  });

  // The header folds to the name, with the choice kept for the next visit.
  function setHeadFold(folded) {
    el.headBody.hidden = folded;
    el.headFold.setAttribute('aria-expanded', String(!folded));
  }
  try {
    setHeadFold(localStorage.getItem(HEAD_KEY) === 'folded');
  } catch {
    // storage blocked: start with it open
  }
  listen(el.headFold, 'click', () => {
    const folded = !el.headBody.hidden;
    setHeadFold(folded);
    try {
      localStorage.setItem(HEAD_KEY, folded ? 'folded' : 'open');
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
    layout();
    resizeMap();
  });

  // The right column holds Passes and Pictures, with the viewfinder in Pictures. Where they
  // don't both fit, one folds to its heading (Passes keeps its next-pass line), Pictures first.
  // Where Pictures is still too tall on its own (a laptop), the viewfinder's picture gives way,
  // down to two fifths of its height, so the list keeps about three rows; past that the
  // viewfinder goes, and the picture's card shows the picture instead.
  let rightOpen = 'photos'; // which stays open when they don't fit
  let passesFull = 0;
  let vfFull = 0; // the viewfinder's height, and its picture's, with nothing given way
  let picFull = 0;
  let viewfinder = null;
  let finderPhotos = [];
  function fitRightColumn(h, narrow) {
    const passesFolded = el.passesPanel.hasAttribute('data-folded');
    const photosFolded = el.photosPanel.hasAttribute('data-folded');
    if (!passesFolded) passesFull = el.passesPanel.scrollHeight;
    if (!photosFolded && !narrow && !el.vfSlot.hidden) {
      // measured whole (only the end of this shows), as its caption may have changed since
      el.vfSlot.classList.remove('cg-vf-away');
      el.vfSlot.style.removeProperty('--vf-pic-h');
      if (el.vfSlot.getClientRects().length) {
        vfFull = el.vfSlot.offsetHeight;
        picFull = el.vfSlot.querySelector('.vf-pic')?.offsetHeight || 0;
      }
    }
    const gap = 12 * uiScale;
    // the heading, Highlight, the line about the dark frames and three rows of the list
    const listMin = 288 * uiScale + (el.tucked.hidden ? 0 : el.tucked.offsetHeight + 4 * uiScale);
    const vfRoom = el.vfSlot.hidden ? 0 : vfFull + gap;
    const room = h - pageTop() - 112 * uiScale; // globe.css .cg-col-right's max-height
    const both = narrow || passesFull + gap + listMin + vfRoom <= room;
    for (const [panel, fold, open] of [
      [el.passesPanel, el.passesFold, both || rightOpen === 'passes'],
      [el.photosPanel, el.photosFold, both || rightOpen === 'photos'],
    ]) {
      panel.toggleAttribute('data-folded', !open);
      fold.setAttribute('aria-expanded', String(open));
      fold.disabled = both;
    }
    root.classList.toggle('cg-right-accordion', !both);
    // (not yet measured, it gives nothing: vfObserver brings it back here once it has a size)
    const cut = !both && rightOpen === 'photos' && vfRoom && vfFull
      ? Math.max(0, listMin + vfRoom - (room - el.passesPanel.offsetHeight - gap))
      : 0;
    const away = cut > 0.6 * picFull;
    const picCut = away ? 0 : cut;
    el.vfSlot.classList.toggle('cg-vf-away', away);
    if (picCut) el.vfSlot.style.setProperty('--vf-pic-h', `${(picFull - picCut).toFixed(1)}px`);
    else el.vfSlot.style.removeProperty('--vf-pic-h');
    root.style.setProperty('--cg-photos-min', `${(listMin + (away ? 0 : vfRoom - picCut)).toFixed(1)}px`);
  }

  const layout = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    // A big monitor keeps narrow corner panels and a dominant globe. Type and
    // spacing grow only gently with the width (values 16 to 18px, reached at
    // about 1800px wide), and the columns hold about 11% of the width, never
    // less than their 1440 × 900 widths at that type size, so rows don't wrap
    // more than they do there. Where the side panels would crowd the globe
    // (narrow, short or a phone in landscape), they fold into the bottom
    // bar's tabs instead of shrinking.
    uiScale = Math.min(1.125, Math.max(1, (0.0055 * w + 8) / 16));
    const narrow = w < 1180 || h < 680;
    root.style.setProperty('--cg-s', uiScale.toFixed(3));
    root.style.setProperty('--cg-left-w', `${Math.max(280 * uiScale, 0.11 * w).toFixed(1)}px`);
    root.style.setProperty('--cg-right-w', `${Math.max(300 * uiScale, 0.117 * w).toFixed(1)}px`);
    root.classList.toggle('cg-narrow', narrow);
    root.style.setProperty('--cg-head-h', `${head.offsetHeight}px`);
    root.style.setProperty('--cg-dock-h', `${el.dock.offsetHeight}px`);
    // The bar's height with its clock showing: the zoom and the buttons beside it rest on that,
    // and move by transform to keep above a sheet (placeFloats), so opening one shifts nothing.
    if (el.timeBtn.getClientRects().length) root.style.setProperty('--cg-dock-rest-h', `${el.dock.offsetHeight}px`);
    // the tabs' row at the foot of the bar, which a phone's sheet stands on, over the clock
    const dockBox = el.dock.getBoundingClientRect();
    root.style.setProperty('--cg-tabs-h', `${Math.round(dockBox.bottom - tabsRow.getBoundingClientRect().top)}px`);
    // the Globe / Map row: on a phone the title and "Over …" keep to the left of it
    root.style.setProperty('--cg-views-w', `${el.viewsMain.offsetWidth}px`);
    fitScrub();
    const cardSpace = el.card.hidden ? 0 : el.card.offsetHeight + 12 * uiScale;
    root.style.setProperty('--cg-card-space', `${cardSpace}px`);
    el.fold.disabled = narrow; // a tab's sheet shows it whole
    fitRightColumn(h, narrow);
    syncViewfinder();
    if (narrow) {
      setSatFold(false);
      return;
    }
    if (!el.satPanel.hasAttribute('data-folded')) satFull = el.satPanel.offsetHeight;
    // the left column's room (globe.css .cg-col-left max-height) against what it holds
    const room = h - pageTop() - 112 * uiScale - cardSpace;
    const need = head.offsetHeight + 12 * uiScale + satFull;
    setSatFold(satFoldedByUser ?? (!el.card.hidden && need > room));
  };

  /** The time slider's reach either side of the focus time, in minutes: a day where the slider is
   * long, 90 minutes (about an orbit) where it's short, as on a phone, so a drag moves the time
   * about a minute a pixel rather than a quarter of an hour, and the satellite doesn't leap. */
  let scrubMin = 1440;
  function fitScrub() {
    const width = el.scrub.offsetWidth;
    if (!width) return; // not laid out: it keeps its reach
    const next = width < 480 ? 90 : 1440;
    if (next === scrubMin) return;
    scrubMin = next;
    const day = next === 1440;
    el.scrub.min = String(-next);
    el.scrub.max = String(next);
    el.scrub.setAttribute('aria-label', `Time, up to ${day ? 'a day' : '90 minutes'} either side of the focus time`);
    el.scrubEarly.textContent = day ? 'A day earlier' : '−90 min';
    el.scrubLate.textContent = day ? 'A day later' : '+90 min';
    el.scrubEarlyShort.textContent = day ? '−1 day' : '−90 min';
    el.scrubLateShort.textContent = day ? '+1 day' : '+90 min';
    if (Math.abs(state.ms - state.focusMs) > next * MIN_MS) state.focusMs = state.ms;
    // the ticks and the handle follow at the next paint (the resize observer and the clock)
  }

  /** The map's free frame: the stage less what the columns, the header (narrow)
   * and the clock bar cover. Its grid labels sit inside it and it centres there. */
  let freeStage = null; // in the tabbed layout: { left, top, right, bottom }, stage px
  let sheetViewMoved = false;
  let typing = false; // a phone's keyboard is up for the place search: see setTyping
  let floats = { x: 0, y: 0 }; // where placeFloats has moved the zoom and the buttons beside it
  const colLeft = root.querySelector('.cg-col-left');
  const colRight = root.querySelector('.cg-col-right');
  const clock = root.querySelector('.cg-clock');
  function resizeMap() {
    const r = root.getBoundingClientRect();
    const gap = 16 * uiScale;
    const inset = { top: 0, right: 0, bottom: 0, left: 0 };
    freeStage = null;
    if (opts.ui === 'compact') {
      inset.bottom = r.bottom - clock.getBoundingClientRect().top + gap;
    } else if (root.classList.contains('cg-narrow')) {
      // while a phone's keyboard is up for the place search its sheet stands over the stage:
      // the views stay as they were until it goes
      if (typing) return;
      // what the header, a picture's card, the bottom bar and an open sheet leave
      const dock = el.dock.getBoundingClientRect();
      const free = { left: 0, top: head.getBoundingClientRect().bottom - r.top, right: r.width, bottom: dock.top - r.top };
      if (el.card.getClientRects().length) free.top = Math.max(free.top, el.card.getBoundingClientRect().bottom - r.top);
      const sheet = state.tab ? root.querySelector(`[data-panel="${state.tab}"]`)?.getBoundingClientRect() : null;
      const side = sheet?.width && sheet.left - r.left > 1;
      if (sheet?.width) {
        if (side) free.right = sheet.left - r.left;
        else free.bottom = sheet.top - r.top;
      }
      freeStage = free;
      inset.top = free.top + 8;
      inset.bottom = r.height - free.bottom;
      inset.right = r.width - free.right;
      placeFloats(r, dock, sheet?.width ? sheet : null, side);
      // the zoom and the buttons beside it stand at the frame's lower right: the longitudes along
      // its foot stop short of them (globe.css: the zoom 12px in, the others 64px)
      const sideW = el.viewsSide.offsetWidth;
      inset.labelRight = sideW ? 64 + sideW + 8 : 64;
    } else {
      placeFloats(r, null, null, false);
      inset.top = pageTop(); // the map starts under the site nav, which sits on Space
      inset.bottom = r.bottom - clock.getBoundingClientRect().top + gap;
      if (state.panels) {
        inset.left = colLeft.getBoundingClientRect().right - r.left + gap;
        inset.right = r.right - colRight.getBoundingClientRect().left + gap;
      }
      // the zoom stands at the frame's lower right: the longitudes along the foot stop short of it
      if (opts.ui !== 'compact') inset.labelRight = el.zoom.offsetWidth + gap;
    }
    map.resize(root.clientWidth || 800, root.clientHeight || 600, uiScale, inset);
    // the globe centres in the same space
    if (freeStage) scene.setViewCentre((freeStage.left + freeStage.right) / 2, (freeStage.top + freeStage.bottom) / 2);
    else scene.setViewCentre();
  }

  /**
   * On a phone the zoom, Aurora and the eye rest just above the bar, as it is with its clock
   * showing (--cg-dock-rest-h, globe.css). A sheet along the bottom lifts them to just above
   * it, where they can still be tapped; one at the side moves them to its left. They move by
   * transform (eased in globe.css), so the page's layout doesn't shift under the visitor.
   */
  function placeFloats(r, dock, sheet, side) {
    let x = 0;
    let y = 0;
    if (dock) {
      const rest = parseFloat(root.style.getPropertyValue('--cg-dock-rest-h')) || dock.height;
      const restFoot = r.bottom - rest; // where they stand on: the top of the bar with its clock
      y = (sheet && !side ? sheet.top : dock.top) - restFoot;
      if (sheet && side) x = sheet.left - r.right;
    }
    if (x === floats.x && y === floats.y) return;
    floats = { x, y };
    root.style.setProperty('--cg-float-x', `${Math.round(x)}px`);
    root.style.setProperty('--cg-float-y', `${Math.round(y)}px`);
  }

  /** While a sheet is open the stage is a small window: keep the satellite in
   * it, unless the visitor has moved the view themselves since opening it. */
  function keepSatelliteInView() {
    if (!state.tab || !freeStage || state.follow || sheetViewMoved || !satState) return;
    if (onMap()) {
      if (!map.busy) map.flyToSatellite();
      return;
    }
    if (scene.busy) return;
    const s = scene.satelliteScreen();
    const m = 32;
    const inside = s && s.x >= freeStage.left + m && s.x <= freeStage.right - m && s.y >= freeStage.top + m && s.y <= freeStage.bottom - m;
    if (!inside) scene.flyToSatellite();
  }

  const resizeObserver = new ResizeObserver(() => {
    layout();
    scene.resize(root.clientWidth, root.clientHeight, uiScale);
    resizeMap();
    paintTicks();
  });
  resizeObserver.observe(root);
  resizeObserver.observe(el.dock);
  resizeObserver.observe(el.card);
  resizeObserver.observe(head);
  resizeObserver.observe(el.satPanel);
  resizeObserver.observe(el.viewsMain); // its width sets the room for the title on a phone
  // a sheet's height follows its content: the views only need to re-centre
  const sheetObserver = new ResizeObserver(() => resizeMap());
  for (const panel of root.querySelectorAll('[data-panel]')) sheetObserver.observe(panel);
  // the viewfinder comes into view, or its caption takes one line or two: the list keeps its rows
  const vfObserver = new ResizeObserver(() => layout());
  vfObserver.observe(el.vfSlot);
  // the zoom has come to rest above a sheet, or back: the pictures keep out from under it
  listen(el.zoom, 'transitionend', () => placePins());
  layout();
  scene.resize(root.clientWidth || 800, root.clientHeight || 600, uiScale);
  resizeMap();

  if (opts.backHref) {
    el.back.href = opts.backHref;
    el.back.hidden = false;
  }

  // ---- clock -----------------------------------------------------------------
  let lastFrame = performance.now();
  let lastScene = 0;
  let lastUi = 0; // the clock and the zoom, ten times a second
  let lastReadouts = 0; // the stats, "Over …" and the next pass, four times a second
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
    if (fly) flyToSatellite();
    writeHash();
  }

  function jumpTo(ms, { keepPlaying = false } = {}) {
    state.ms = ms;
    state.live = false;
    if (!keepPlaying) state.playing = false;
    if (Math.abs(ms - state.focusMs) > scrubMin * MIN_MS) state.focusMs = ms;
    paintTransport();
    paintTicks();
    markDirty();
    pushScene(); // so camera moves that follow see the new Earth rotation
  }

  function step(deltaMs) {
    jumpTo(state.ms + deltaMs, { keepPlaying: state.playing });
    writeHash();
  }

  /** The fine adjustment: one second of the clock times the speed, from a whole second, and it stops there. */
  function stepBySpeed(dir) {
    jumpTo(Math.floor(state.ms / 1000) * 1000 + dir * state.speed * 1000);
    writeHash();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - lastFrame, 250);
    lastFrame = now;
    if (state.playing) {
      state.ms = state.live ? Date.now() : state.ms + dt * state.speed;
      if (Math.abs(state.ms - state.focusMs) > scrubMin * MIN_MS) {
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
    // only the view on screen draws
    if (onMap()) {
      if (state.follow) map.follow();
      if (map.frame(now)) placePins();
    } else {
      if (state.follow) scene.follow();
      if (scene.frame(now)) placePins();
    }
    if (uiDirty || now - lastUi >= 100) {
      paintClock();
      paintZoom(); // the wheel and a pinch move it too
      if (uiDirty || now - lastReadouts >= 250) {
        paintReadouts();
        paintAurora();
        lastReadouts = now;
      }
      lastUi = now;
      uiDirty = false;
    }
  }

  /** The button, and the line that says what's being shown. Only the globe has an aurora: on the
   * map the button stays, dimmed, and says so. */
  function paintAurora() {
    const status = scene.auroraStatus;
    const shown = Boolean(status) && !onMap();
    el.auroraBtn.hidden = !status;
    el.auroraBtn.setAttribute('aria-pressed', String(auroraOn));
    const off = String(onMap());
    if (el.auroraBtn.getAttribute('aria-disabled') !== off) {
      el.auroraBtn.setAttribute('aria-disabled', off);
      el.auroraBtn.title = onMap() ? 'The aurora shows on the globe only' : 'Show or hide NOAA’s aurora forecast (A)';
    }
    const note = shown && auroraOn ? auroraNote(status, state.ms) : null;
    el.auroraNote.hidden = !note;
    if (note && el.auroraNote.textContent !== note) el.auroraNote.textContent = note;
  }

  function setAuroraOn(on) {
    auroraOn = on;
    auroraHidden.set(!on);
    scene.setAurora(on);
    paintAurora();
  }

  // ---- scene state -----------------------------------------------------------
  let satState = null;
  let trackKey = null;
  let mapTrackKey = null;

  /** The map's ground track: about one orbit back and two ahead. */
  function pushMapTrack(force) {
    const ms = state.ms;
    const key = satState.index;
    if (!force && mapTrackKey && mapTrackKey.index === key && Math.abs(ms - mapTrackKey.ms) <= 10_000) return;
    const stepMs = 30_000;
    const n = Math.ceil((orbit.periodMinutes(ms) * MIN_MS) / stepMs);
    const samples = [];
    for (let i = -n; i <= 2 * n; i++) {
      const t = ms + i * stepMs;
      if (t < launchMs) continue;
      const s = orbit.stateAt(t, key);
      if (s) samples.push({ latDeg: s.latDeg, lonDeg: s.lonDeg, dtMin: (t - ms) / MIN_MS });
    }
    map.setTrack(samples);
    mapTrackKey = { index: key, ms };
  }

  function pushScene(forceTrack = false) {
    const ms = state.ms;
    const theta = astro.gmst(ms);
    const sun = astro.sunPosition(ms);
    scene.setTime(theta, sun, ms);
    map.setTime(ms);
    const ss = astro.subsolarPoint(ms);
    scene.setSubsolar(ss.latDeg, ss.lonDeg);

    satState = orbit && ms >= launchMs ? orbit.stateAt(ms) : null;
    scene.setSatellite(satState);
    map.setSatellite(satState);
    if (!satState) {
      scene.setCoverage(null);
      mapTrackKey = null;
      return;
    }
    if (onMap()) pushMapTrack(forceTrack);
    else mapTrackKey = null; // computed afresh when the map shows
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
      // none before lift-off, nor one already under way then
      passes.list = astro.findPasses(orbit, observer, Math.max(state.ms, launchMs), { count: PASS_COUNT, minElevationDeg: 0, minPeakDeg: PASS_PEAK_DEG })
        .filter((p) => p.riseMs >= launchMs);
      paintPasses();
      uiDirty = true;
    }, wait);
  }

  function paintPasses() {
    passesList.repaint(buildPasses);
  }

  function buildPasses() {
    const ol = el.passes;
    ol.replaceChildren();
    const list = passes.list || [];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'cg-empty';
      li.textContent = orbit
        ? 'No passes that high in the next few days.'
        : loaded
          ? 'Orbit data unavailable.'
          : 'Loading…';
      ol.appendChild(li);
      return;
    }
    let day = '';
    for (const p of list) {
      // grouped by Calgary day: "Friday, October 30"
      if (localDay.format(p.riseMs) !== day) {
        day = localDay.format(p.riseMs);
        const h = document.createElement('li');
        h.className = 'cg-pass-day cg-fine';
        h.textContent = day;
        ol.appendChild(h);
      }
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cg-pass';
      const row = document.createElement('span');
      row.className = 'cg-pass-row';
      const when = document.createElement('span');
      when.textContent = `${localTime(p.riseMs, false).time}–${localTime(p.setMs, false).time}`;
      const high = document.createElement('span');
      high.textContent = `${p.maxElevationDeg.toFixed(1)}° high`;
      row.append(when, high);
      const sub = document.createElement('span');
      sub.className = 'cg-fine';
      sub.textContent = `${fmtPassLength(p.setMs - p.riseMs)}, from ${astro.compassPoint(p.riseAzimuthDeg)} to ${astro.compassPoint(p.setAzimuthDeg)}`;
      b.append(row, sub);
      b.title = `Show this pass. Rises ${utcTime(p.riseMs, false)} UTC, ${utcDay(p.riseMs, false)}`;
      b.addEventListener('click', () => {
        closeSheet();
        jumpTo(p.maxMs);
        flyToGround(astro.CALGARY.latDeg, astro.CALGARY.lonDeg, { distance: 2.6 });
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
    photos.sort(comparePhotos);
    pinsKey = null;
    pushPins();
    paintPhotoList();
    paintTicks();
  }

  // Dark frames and mostly missing ones (under a fifth shown) stay out of the list, the pins and
  // the ticks until asked for, as on Pictures; a picture that's chosen always shows.
  let showTucked = false;
  const tucked = (p) => p.dark || p.mostlyMissing;
  const listed = () => photos.filter((p) => showTucked || !tucked(p) || p.id === state.selectedId);

  /** The pins on both views, when the pictures they stand for change. */
  let pinsKey = null;
  function pushPins() {
    const placed = listed().filter((p) => p.placed);
    const key = placed.map((p) => p.id).join(',');
    if (key !== pinsKey) {
      pinsKey = key;
      for (const v of [scene, map]) v.setPins(placed.map((p) => ({ id: p.id, latDeg: p.lat, lonDeg: p.lon })));
      picturePins?.setPins(placed.map((p) => ({ id: p.id, thumb: safeHref(p.thumb), dark: p.dark, square: p.square })));
    }
    for (const v of [scene, map]) v.setSelected(state.selectedId);
    picturePins?.setSelected(state.selectedId);
  }

  function setShowTucked(on) {
    showTucked = on;
    pushPins();
    paintPhotoList();
    paintTicks();
    placePins(); // the button keeps the focus and its place, with new words
  }
  listen(el.tuckedBtn, 'click', () => setShowTucked(!showTucked));

  /** The thumbnails follow the view on screen, and the preview over one follows its pin. */
  function placePins() {
    if (!picturePins) return;
    const view = onMap() ? map : scene;
    const points = view.pinsOnScreen();
    // In the tabbed layout (phones) a pile is one pin with its count, and a pin keeps inside
    // the stage's free frame, off the names and marks of FrontierSat and Calgary, and out
    // from under the buttons over the stage (picturepins.js).
    if (root.classList.contains('cg-narrow')) {
      const r = root.getBoundingClientRect();
      const over = [el.zoom, el.viewsSide, wheel.button]
        .filter((b) => b.getClientRects().length)
        .map((b) => {
          const box = b.getBoundingClientRect();
          return { left: box.left - r.left, top: box.top - r.top, right: box.right - r.left, bottom: box.bottom - r.top };
        });
      picturePins.place(points, uiScale, { compact: true, bounds: freeStage, avoid: [...view.marks(), ...over] });
    } else {
      picturePins.place(points, uiScale);
    }
    if (peek.id) {
      const s = points.get(peek.id);
      if (s) placePeek(s);
      else hidePeek();
    }
  }

  // ---- the viewfinder, in the Pictures panel (explore/viewfinder.js) ---------------
  async function loadViewfinder(images, annotations) {
    if (!full || !images?.length) return;
    try {
      const [{ createViewfinder }, { mergeAll }] = await Promise.all([import('../explore/viewfinder.js'), import('../assets/data.js')]);
      if (destroyed) return;
      finderPhotos = mergeAll(images, annotations);
      el.vfSlot.hidden = !finderPhotos.length;
      viewfinder = createViewfinder(el.vfSlot, {
        photos: finderPhotos,
        siteRoot: opts.siteRoot,
        photoHref: (id) => safeHref(findPhoto(id)?.href) || '',
        reducedMotion: stillMotion,
        firstMs: 300, // no story to wait for, as on Explore: the empty frame shouldn't linger
      });
      if (state.selectedId) showInViewfinder(state.selectedId);
      layout();
    } catch (err) {
      console.warn('Globe: no viewfinder', err); // the list and the picture's card still show them
      el.vfSlot.hidden = true;
    }
  }

  function showInViewfinder(id) {
    const photo = finderPhotos.find((p) => p.id === id);
    if (photo) viewfinder?.show(photo);
  }

  /** It only rotates while it can be seen. The picture's card then needn't show the picture too. */
  function syncViewfinder() {
    const seen = !el.vfSlot.hidden && el.vfSlot.getClientRects().length > 0;
    root.classList.toggle('cg-has-vf', seen);
    if (seen) viewfinder?.start();
    else viewfinder?.stop();
  }

  // ---- the preview over a picture's pin -------------------------------------------
  const peek = { id: null, key: '', timer: 0 };

  function peekItem(p, big) {
    const item = document.createElement(big ? 'span' : 'button');
    item.className = big ? 'cg-peek-item cg-peek-one' : 'cg-peek-item';
    if (!big) {
      item.type = 'button';
      item.addEventListener('click', () => {
        hidePeek();
        closeSheet();
        focusPhoto(p.id);
      });
    }
    const url = safeHref(big ? p.src || p.thumb : p.thumb);
    if (url && !p.dark && !previewsHidden) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', () => { img.hidden = true; }); // the place and time still say what it is
      img.src = url;
      if (p.square) img.classList.add('is-square');
      item.appendChild(img);
    }
    const place = document.createElement('span');
    place.className = 'cg-peek-place';
    place.textContent = photoName(p);
    const time = document.createElement('span');
    time.className = 'cg-peek-time cg-fine';
    time.textContent = utcWhen(p.ms);
    item.append(place, time);
    return item;
  }

  function showPeek(hit) {
    clearTimeout(peek.timer);
    const ids = picturePins && !previewsHidden ? picturePins.pileOf(hit.id) : [hit.id];
    const key = ids.join(',');
    if (peek.key !== key) {
      peek.key = key;
      const list = ids.map(findPhoto).filter(Boolean);
      el.peek.replaceChildren(...list.map((p) => peekItem(p, list.length === 1)));
      el.peek.classList.toggle('is-list', list.length > 1);
    }
    peek.id = hit.id;
    el.peek.hidden = false;
    placePeek(hit);
    requestAnimationFrame(() => el.peek.classList.add('is-on'));
  }

  /** Above the pin if there's room, else under it. */
  function placePeek(s) {
    const w = el.peek.offsetWidth;
    const h = el.peek.offsetHeight;
    const gap = 22 * uiScale;
    const x = astro.clamp(s.x - w / 2, 8, Math.max(8, root.clientWidth - w - 8));
    let y = s.y - h - gap;
    if (y < pageTop() + 8) y = s.y + gap;
    el.peek.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hidePeek(delay = 0) {
    clearTimeout(peek.timer);
    const go = () => {
      peek.id = null;
      peek.key = '';
      el.peek.classList.remove('is-on');
      el.peek.hidden = true;
    };
    if (delay) peek.timer = setTimeout(go, delay);
    else go();
  }
  // a pile's list takes the pointer, so it can be reached across the gap (a finger lifted off it,
  // or scrolling it, leaves it there: see onPointerUp)
  listen(el.peek, 'pointerenter', () => clearTimeout(peek.timer));
  listen(el.peek, 'pointerleave', (e) => {
    if (e.pointerType === 'mouse') hidePeek(160);
  });

  /** A picture's name for the list and card: its place, else its title,
   * else (when the title is just the time) the day it was taken. */
  function photoName(p) {
    if (p.placed && p.place) return String(p.place);
    return p.ms !== null && p.title === utcWhen(p.ms) ? utcDay(p.ms) : p.title;
  }

  function paintPhotoList() {
    photosList.repaint(buildPhotoList);
  }

  function buildPhotoList() {
    const ul = el.photos;
    ul.replaceChildren();
    const list = listed();
    const placed = list.filter((p) => p.placed).length;
    // "29 pictures, 20 shown on the globe", and how many dark or mostly missing ones that leaves out
    el.photoCount.textContent = list.length ? `${plural(list.length, 'picture')}, ${grouped(placed)} shown on the globe` : '';
    el.highlight.hidden = !placed;
    const nTucked = photos.filter(tucked).length;
    el.tucked.hidden = !nTucked;
    if (nTucked) {
      const what = plural(nTucked, 'dark or mostly missing frame');
      // the one chosen shows whatever the switch says, so it isn't counted as left out
      const out = plural(photos.length - list.length, 'dark or mostly missing frame');
      el.tuckedText.textContent = showTucked ? `Including ${what}.` : `${out} left out.`;
      el.tuckedBtn.textContent = showTucked ? 'Hide them' : 'Show them';
      el.tuckedBtn.setAttribute('aria-label', showTucked ? `Hide the ${what}` : `Show the ${out}`);
    }
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'cg-empty';
      li.textContent = !loaded ? 'Loading…' : photosFailed ? 'The pictures couldn’t load. Reload the page to try again.' : 'No pictures yet.';
      ul.appendChild(li);
      return;
    }
    const counts = { date: 0, none: 0 };
    for (const p of list) if (whenKnown(p) !== 'time') counts[whenKnown(p)]++;
    const groupTitle = {
      date: `${counts.date} not on the globe: time unknown`,
      none: `${counts.none} not on the globe: date unknown`,
    };
    let group = 'time';
    for (const p of list) {
      const known = whenKnown(p);
      if (known !== group) {
        group = known;
        const h = document.createElement('li');
        h.className = 'cg-list-sub cg-fine';
        h.textContent = groupTitle[known];
        ul.appendChild(h);
      }
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cg-photo';
      b.dataset.id = p.id;
      if (p.id === state.selectedId) b.setAttribute('aria-current', 'true');
      const thumb = document.createElement('span');
      thumb.className = 'cg-photo-thumb';
      const src = safeHref(p.thumb);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => img.remove());
        thumb.appendChild(img);
      }
      const t = document.createElement('span');
      t.className = 'cg-photo-title';
      t.textContent = photoName(p);
      const m = document.createElement('span');
      m.className = 'cg-photo-meta cg-fine';
      m.textContent = p.ms !== null ? utcWhen(p.ms) : known === 'date' ? 'Time unknown' : 'Date unknown';
      b.append(thumb, t, m);
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
    const reach = scrubMin * MIN_MS; // the slider's reach either side
    const start = state.focusMs - reach;
    for (const p of listed()) {
      if (!p.placed || p.ms < start || p.ms > start + 2 * reach) continue;
      const tick = document.createElement('span');
      tick.className = p.id === state.selectedId ? 'cg-tick cg-tick-on' : 'cg-tick';
      tick.style.left = `${((p.ms - start) / (2 * reach)) * 100}%`;
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
    pushPins(); // a dark frame shows while it's the one chosen
    rightOpen = 'photos'; // where the picture goes up
    showInViewfinder(p.id);
    if (p.ms !== null) {
      state.focusMs = p.ms;
      jumpTo(p.ms);
      pushScene(true);
      if (p.placed && fly) {
        setFollow(false);
        flyToGround(p.lat, p.lon, { immediate });
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
    pushPins();
    paintCard();
    paintPhotoList();
    paintTicks();
    writeHash();
  }

  function paintCard() {
    const p = state.selectedId ? findPhoto(state.selectedId) : null;
    if (el.card.hidden === !!p) satFoldedByUser = null; // the card comes or goes: fold to fit again
    el.card.hidden = !p;
    root.classList.toggle('cg-has-card', !!p);
    if (p) paintCardBody(p);
    layout(); // fold Stats to fit at once, not when the resize observer next runs
  }

  function paintCardBody(p) {
    el.cardTitle.textContent = photoName(p);
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
    if (p.ms === null) {
      el.cardTime.textContent = p.captureDate ? `${utcDay(Date.parse(p.captureDate))}, time unknown` : 'Date unknown';
      el.cardPos.textContent = 'Not on the globe';
      el.cardLight.textContent = '';
      return;
    }
    el.cardTime.textContent = utcWhen(p.ms);
    if (!p.placed) {
      el.cardPos.textContent = 'Position unavailable';
      el.cardLight.textContent = '';
      return;
    }
    const s = orbit ? orbit.stateAt(p.ms) : null;
    el.cardPos.textContent = `${fmtLat(p.lat)}, ${fmtLon(p.lon)}${s ? `, ${Math.round(s.altKm)} km up` : ''}`;
    el.cardLight.textContent = fmtGround(astro.sunElevationDeg(p.lat, p.lon, p.ms), ' below');
  }

  listen(el.cardImg, 'error', () => {
    el.cardImg.hidden = true;
    el.cardThumbLink.classList.add('cg-no-thumb');
  });
  listen(el.cardImg, 'load', () => {
    el.cardThumbLink.classList.remove('cg-no-thumb');
  });
  listen(el.cardClose, 'click', clearSelection);

  // Opening the picture keeps the way back to this exact view: its page gets
  // our link state as #/photo/<id>?globe=<state>, and so does this page's own
  // URL, for the browser's Back button.
  function linkBack(e) {
    const p = state.selectedId ? findPhoto(state.selectedId) : null;
    const href = p ? safeHref(p.href) : null;
    if (!href || !/#\/photo\/[^?]*$/.test(href)) return;
    e.currentTarget.href = `${href}?globe=${encodeURIComponent(stateParams({ view: true }))}`;
    if (e.type === 'click') writeHash({ view: true });
  }
  for (const a of [el.cardLink, el.cardThumbLink]) {
    for (const type of ['pointerdown', 'focus', 'click']) listen(a, type, linkBack);
  }

  // ---- readouts --------------------------------------------------------------
  const shown = new Map();
  function put(node, text) {
    if (shown.get(node) !== text) {
      node.textContent = text;
      shown.set(node, text);
    }
  }

  function paintClock() {
    // "Nov 5" ", 2026" ", 08:06:58 UTC": the line never wraps, and the narrowest phones
    // leave the year out (globe.css) so it fits beside the speed and Now
    put(el.utc, utcDay(state.ms, false));
    put(el.utcYear, `, ${new Date(state.ms).getUTCFullYear()}`);
    put(el.utcTime, `${utcTime(state.ms)} UTC`);
    const local = localTime(state.ms, false);
    put(el.local, `${local.time} ${local.zone}`); // "23:19 Calgary time"
    const offset = Math.round((state.ms - state.focusMs) / MIN_MS);
    if (document.activeElement !== el.scrub && String(offset) !== el.scrub.value) el.scrub.value = String(offset);
    put(el.offset, state.live ? 'Now' : fmtOffset(state.ms - state.focusMs, !state.playing));
  }

  function paintReadouts() {
    const s = satState;
    const dash = '—';
    // Stats, as on Explore; away from now, a line says what time they're for
    const at = state.live ? null : `At ${localTime(state.ms, false).time} in Calgary`;
    el.at.hidden = !at;
    put(el.at, at || '');
    const label = at ? `Stats. ${at}` : 'Stats';
    if (shown.get(el.satPanel) !== label) {
      el.satPanel.setAttribute('aria-label', label);
      shown.set(el.satPanel, label);
    }
    keepSatelliteInView();
    // roughly what it is over: a country, else a sea or continent
    const over = s ? placeAt(s.latDeg, s.lonDeg) : null;
    el.over.hidden = !over;
    put(el.over, over ? `Over ${placeInSentence(over)}` : '');
    placeSearch.tick(state.ms);
    if (!s) {
      for (const k of ['lat', 'lon', 'alt', 'speed', 'illum', 'ground', 'orbit']) put(el[k], dash);
      put(
        el.tle,
        !orbit
          ? loaded
            ? 'Orbit data unavailable.'
            : 'Loading the orbit…'
          : state.ms < launchMs
            ? `Not launched yet. Lift-off was ${utcDay(launchMs)}, ${utcTime(launchMs, false)} UTC.`
            : 'No position for this time: the orbit calculation failed.',
      );
      el.tle.classList.remove('cg-warn');
      put(el.gs, '');
      return;
    }
    put(el.lat, fmtLat(s.latDeg));
    put(el.lon, fmtLon(s.lonDeg));
    put(el.alt, `${Math.round(s.altKm)} km`);
    put(el.speed, `${s.speedKmS.toFixed(2)} km/s`);
    const sun = astro.sunPosition(state.ms);
    const light = astro.satelliteLight(s.eci, sun); // the gallery's model, so the two agree
    put(el.illum, light === 'sunlit' ? 'In sunlight' : light === 'shadow' ? 'In the Earth’s shadow' : 'At the edge of the Earth’s shadow');
    el.illum.dataset.state = light;
    put(el.ground, fmtGround(astro.sunElevationDeg(s.latDeg, s.lonDeg, state.ms)));
    const rev = orbit.revolutionAt(state.ms);
    put(el.orbit, rev === null ? dash : grouped(rev));
    const age = state.ms - s.tleEpochMs;
    const stale = Math.abs(age) > FAR_DAYS * DAY_MS;
    put(
      el.tle,
      `Worked out from its orbit as published ${utcDay(s.tleEpochMs, false)}, ${utcTime(s.tleEpochMs, false)} UTC ` +
        `(${fmtAge(age)})${stale ? `, so the position may be off by ${offBy(age / DAY_MS)}` : ''}.`,
    );
    el.tle.classList.toggle('cg-warn', stale);

    const look = s.look || astro.lookAngles(observer, s.ecef);
    if (look.elevationDeg > 0) {
      put(el.gs, `In view ${state.live ? 'now' : 'at this time'}, ${look.elevationDeg.toFixed(0)}° up in the ${astro.compassPoint(look.azimuthDeg)}`);
      el.gs.dataset.state = 'up';
    } else {
      const next = (passes.list || []).find((p) => p.riseMs > state.ms);
      const wait = next ? fmtDuration(next.riseMs - state.ms) : '';
      put(el.gs, next ? (state.live ? `Next pass in ${wait}` : `Next pass ${wait} later`) : 'Below the horizon');
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
    const stepSize = stepWords(state.speed);
    el.stepBack.setAttribute('aria-label', `Back ${stepSize}`);
    el.stepBack.title = `Back ${stepSize} (,)`;
    el.stepForward.setAttribute('aria-label', `Forward ${stepSize}`);
    el.stepForward.title = `Forward ${stepSize} (.)`;
    speedsRow.sync();
    // an action, as on Explore: quiet while it's already now, a button once the clock leaves it
    el.now.setAttribute('aria-disabled', String(state.live));
    el.now.title = state.live ? 'Showing now' : 'Back to now, at 1× (N)';
    root.classList.toggle('cg-live', state.live);
  }

  /** The zoom buttons, dimmed at their limits, for whichever view shows. */
  function paintZoom() {
    const room = (onMap() ? map : scene).zoomRoom;
    for (const [b, ok] of [[el.zoomIn, room.in], [el.zoomOut, room.out]]) {
      const off = String(!ok);
      if (b.getAttribute('aria-disabled') !== off) b.setAttribute('aria-disabled', off);
    }
  }

  function zoomView(dir) {
    const view = onMap() ? 'map' : 'globe';
    const room = (view === 'map' ? map : scene).zoomRoom;
    if (!(dir > 0 ? room.in : room.out)) return;
    const f = dir > 0 ? ZOOM_STEP[view] : 1 / ZOOM_STEP[view];
    if (view === 'map') map.zoomBy(f);
    else scene.zoomBy(f);
    hideTip();
    paintZoom();
  }

  // a short line under the view's buttons, for a key that can't do its job here
  let toastTimer = 0;
  function toast(text) {
    clearTimeout(toastTimer);
    el.toast.textContent = text;
    toastTimer = setTimeout(() => {
      el.toast.textContent = '';
    }, 4000);
  }
  const AURORA_GLOBE_ONLY = 'The aurora shows on the globe only. Switch to Globe (M) to see it.';

  function setFollow(on) {
    const changed = on !== state.follow;
    state.follow = on;
    el.follow.setAttribute('aria-pressed', String(on));
    if (on) flyToSatellite();
    if (changed) writeHash();
  }

  function setTab(tab) {
    state.tab = state.tab === tab ? null : tab;
    root.dataset.tab = state.tab || '';
    for (const b of root.querySelectorAll('[data-tab]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
    }
    sheetViewMoved = false;
    layout(); // the bottom bar changes height with a sheet open
    resizeMap();
    if (picker.isOpen && (sheetAlongBottom() || clockAway())) picker.close({ restoreFocus: false });
  }

  /** On a phone the clock bar makes way while a sheet is open (globe.css: hidden under it). */
  const clockAway = () => !el.timeBtn.getClientRects().length || getComputedStyle(clock).visibility === 'hidden';

  // where they don't both fit, opening one folds the other
  const swapRightColumn = () => {
    rightOpen = rightOpen === 'photos' ? 'passes' : 'photos';
    layout();
  };
  for (const [title, fold] of [[el.passesTitle, el.passesFold], [el.photosTitle, el.photosFold]]) {
    listen(fold, 'click', swapRightColumn);
    listen(title, 'click', () => {
      if (!fold.disabled) swapRightColumn();
    });
  }

  /** It wants the same space as the time picker: one at a time. A sheet at the
   * side leaves room for both. */
  function sheetAlongBottom() {
    const sheet = state.tab ? root.querySelector(`[data-panel="${state.tab}"]`)?.getBoundingClientRect() : null;
    return !!sheet?.width && sheet.left - root.getBoundingClientRect().left <= 1;
  }

  /** Side panels on wide screens; hidden leaves the globe, photo card and clock. */
  function setPanels(on) {
    state.panels = on;
    root.classList.toggle('cg-panels-off', !on);
    el.panels.textContent = on ? 'Hide panels' : 'Show panels';
    el.panels.setAttribute('aria-expanded', String(on));
    try {
      localStorage.setItem(PANELS_KEY, on ? 'shown' : 'hidden');
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
    syncViewfinder();
    resizeMap();
  }

  /** The 3D globe or the flat map. Time, speed, selection and follow carry
   * over; each view keeps its own camera. */
  function setView(view, { write = true } = {}) {
    const next = view === 'map' ? 'map' : 'globe';
    const changed = next !== state.view;
    state.view = next;
    root.classList.toggle('cg-mode-map', next === 'map');
    for (const b of el.views.querySelectorAll('[data-view]')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === next));
    }
    viewsRow.sync();
    map.setVisible(next === 'map');
    paintAurora(); // dimmed on the map
    paintZoom(); // each view has its own limits
    hideTip();
    if (changed) {
      markDirty();
      pushScene(true);
      if (next === 'globe') scene.frame(performance.now(), true);
      placePins();
    }
    if (write) writeHash();
  }

  const picker = createTimePicker({
    launchMs: astro.LAUNCH_MS,
    getOrbit: () => orbit,
    onPick(ms) {
      state.focusMs = ms;
      jumpTo(ms);
      pushScene(true);
      if (!state.follow) flyToSatellite();
      writeHash();
    },
    onPreview: (ms) => shotPanel.open({ ms }),
  });
  root.appendChild(picker.element);

  // What the camera would see at a moment, from the place search and the time picker.
  const shotPanel = createShotPanel({ getOrbit: () => orbit });
  root.appendChild(shotPanel.element);

  // Passes over another place: while one is chosen its passes stand in for
  // Calgary's in the Passes panel.
  const placeSearch = createPlaceSearch({
    getOrbit: () => orbit,
    getTime: () => Math.max(state.ms, launchMs), // passes from lift-off at the earliest
    isLive: () => state.live,
    onPreview(p, place) {
      shotPanel.open({
        ms: p.closestMs,
        context: `This pass at its nearest to the middle of ${placeInSentence(place.name)}, ${fmtKm(p.closestKm)} from it.`,
      });
    },
    onJump(p) {
      closeSheet();
      jumpTo(p.closestMs);
      pushScene(true);
      setFollow(false);
      flyToGround(p.latDeg, p.lonDeg);
      writeHash();
    },
    onPlace(place, moveFocus) {
      const title = place ? `Passes over ${placeInSentence(place.name)}` : 'Passes over Calgary'; // "the North Sea"
      el.passesTitle.textContent = title;
      el.passesPanel.setAttribute('aria-label', title);
      el.calgaryPasses.hidden = !!place;
      if (moveFocus) el.passesTitle.focus();
      writeHash(); // a link keeps the place
    },
  });
  placeSearch.element.classList.add('cg-fold-body');
  el.placeSlot.replaceWith(placeSearch.element);
  loadCountries();

  // Typing a place on a phone: its keyboard would cover the box and the suggestions under it.
  // While the box has the focus its sheet stands from under the header to the top of the
  // keyboard (globe.css .cg-typing; visualViewport says where that is), scrolled to the box.
  const placeBox = placeSearch.element.querySelector('.cg-place-input');
  const touchQuery = window.matchMedia('(pointer: coarse)');
  const vv = window.visualViewport;
  function followKeyboard() {
    const bottom = root.getBoundingClientRect().bottom;
    const kb = vv ? Math.max(0, bottom - (vv.offsetTop + vv.height)) : 0;
    root.style.setProperty('--cg-kb', `${Math.round(kb)}px`);
    el.passesPanel.scrollTop = Math.max(0, placeSearch.element.offsetTop - 8);
  }
  function setTyping(on) {
    if (on === typing) return;
    typing = on;
    root.classList.toggle('cg-typing', on);
    for (const type of ['resize', 'scroll']) {
      if (on) vv?.addEventListener(type, followKeyboard);
      else vv?.removeEventListener(type, followKeyboard);
    }
    if (on) followKeyboard();
    else {
      root.style.removeProperty('--cg-kb');
      resizeMap(); // the sheet is back in its place: the views fit what it leaves
    }
  }
  const typingHere = () => touchQuery.matches && root.classList.contains('cg-narrow');
  listen(placeBox, 'focus', () => setTyping(typingHere()));
  listen(placeBox, 'blur', () => setTyping(false));
  cleanups.push(() => {
    for (const type of ['resize', 'scroll']) vv?.removeEventListener(type, followKeyboard);
  });

  /** On narrow screens, put the sheet away so the globe shows what was picked. */
  function closeSheet() {
    if (state.tab && root.classList.contains('cg-narrow')) setTab(state.tab);
  }

  // ---- controls --------------------------------------------------------------
  listen(el.play, 'click', () => setPlaying(!state.playing));
  listen(el.stepBack, 'click', () => stepBySpeed(-1));
  listen(el.stepForward, 'click', () => stepBySpeed(1));
  listen(el.now, 'click', () => {
    if (!state.live) goLive();
  });
  for (const b of el.speeds.querySelectorAll('[data-speed]')) {
    listen(b, 'click', () => setSpeed(Number(b.dataset.speed)));
  }
  listen(el.speedCycle, 'click', () => setSpeed(SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]));
  listen(el.follow, 'click', () => setFollow(!state.follow));
  listen(el.auroraBtn, 'click', () => {
    if (onMap()) toast(AURORA_GLOBE_ONLY);
    else setAuroraOn(!auroraOn);
  });
  listen(el.previewsBtn, 'click', () => {
    setPreviewsHidden(!previewsHidden);
    hidePeek();
  });
  listen(el.panels, 'click', () => setPanels(!state.panels));
  // it opens at the foot of a column that may be full: bring it into view
  listen(el.keys, 'toggle', () => {
    if (el.keys.open) el.keys.scrollIntoView({ block: 'nearest', behavior: stillMotion ? 'auto' : 'smooth' });
  });
  for (const b of el.views.querySelectorAll('[data-view]')) listen(b, 'click', () => setView(b.dataset.view));
  listen(el.zoomIn, 'click', () => zoomView(1));
  listen(el.zoomOut, 'click', () => zoomView(-1));

  /** "Change place" in the Passes heading: the search for another country or sea, opened and ready. */
  listen(el.changePlace, 'click', () => {
    if (root.classList.contains('cg-narrow')) {
      if (state.tab !== 'passes') setTab('passes');
    } else {
      if (!state.panels) setPanels(true);
      if (el.passesPanel.hasAttribute('data-folded')) {
        rightOpen = 'passes';
        layout();
      }
    }
    placeSearch.focus();
    // (the box's focus event does this too, but not while the page itself lacks the focus)
    if (document.activeElement === placeBox) setTyping(typingHere());
  });

  /** The Keys list, from its own line or the ? key. */
  function setKeysOpen(open) {
    const had = el.keys.contains(document.activeElement);
    el.keys.open = open;
    if (open) el.keys.querySelector('summary').focus({ preventScroll: true });
    // on a narrow screen the list only shows while open: the focus goes back to the view
    else if (had && !el.keys.getClientRects().length) (onMap() ? map.canvas : canvas).focus({ preventScroll: true });
  }
  listen(el.timeBtn, 'click', () => {
    if (!picker.isOpen && sheetAlongBottom()) closeSheet();
    picker.toggle(state.ms, el.timeBtn);
  });
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
    if (button === el.share2) {
      // the icon in the Globe / Map row: a tick, and the words in the line under the buttons
      button.innerHTML = ok ? ICONS.copied : ICONS.link;
      toast(ok ? 'Link copied' : 'Copy failed');
      setTimeout(() => {
        if (!destroyed) button.innerHTML = ICONS.link;
      }, 1600);
      return;
    }
    const before = 'Copy link';
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      if (!destroyed) button.textContent = before;
    }, 1600);
  }
  listen(el.share, 'click', () => copyLink(el.share));
  listen(el.share2, 'click', () => copyLink(el.share2));

  // pins: hover and click, the same on the globe and the map
  function hideTip() {
    tip.hidden = true;
    if (peek.id) hidePeek(el.peek.classList.contains('is-list') ? 160 : 0);
    for (const v of [scene, map]) v.setHover(null);
    canvas.style.cursor = '';
    map.canvas.style.cursor = '';
  }
  const surfaces = [
    [canvas, scene],
    [map.canvas, map],
  ];
  for (const [surface, view] of surfaces) {
    listen(surface, 'pointermove', (e) => onPointerMove(e, surface, view));
    // (a finger leaves as it lifts: a pile's list it has just opened stays)
    listen(surface, 'pointerleave', (e) => {
      if (e.pointerType === 'mouse') hideTip();
    });
    listen(surface, 'pointerup', (e) => onPointerUp(e, surface, view));
  }
  function onPointerMove(e, surface, view) {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const r = surface.getBoundingClientRect();
    const hit = view.pick(e.clientX - r.left, e.clientY - r.top, pinReach(12));
    if (!hit) {
      if (!tip.hidden || peek.id || surface.style.cursor) hideTip();
      return;
    }
    view.setHover(hit.type === 'photo' ? hit.id : null);
    if (hit.type === 'photo') {
      tip.hidden = true;
      if (full) {
        showPeek(hit);
        surface.style.cursor = 'pointer';
        return;
      }
      const p = findPhoto(hit.id);
      // "Antarctica, Oct 25, 00:54 UTC"
      tip.textContent = p ? `${p.place ? `${p.place}, ` : ''}${utcDay(p.ms, false)}, ${utcTime(p.ms, false)} UTC` : '';
    } else if (hit.type === 'satellite') {
      if (peek.id) hidePeek();
      tip.textContent = state.follow ? 'FrontierSat' : 'Click to follow FrontierSat';
    } else if (hit.type === 'station') {
      tip.textContent = 'University of Calgary ground station, Rothney Observatory (RAO)';
    } else {
      tip.textContent = 'The Sun is overhead here';
    }
    surface.style.cursor = hit.type === 'photo' || hit.type === 'satellite' ? 'pointer' : '';
    tip.hidden = false;
    tip.style.transform = `translate(${Math.round(hit.x)}px, ${Math.round(hit.y)}px)`;
  }
  /** How near the pointer counts as on a mark: a thumbnail is bigger than a small square. */
  const pinReach = (px) => (picturePins && !previewsHidden ? px + 8 : px) * uiScale;
  function onPointerUp(e, surface, view) {
    if (view.controls.dragged) return;
    const r = surface.getBoundingClientRect();
    const hit = view.pick(e.clientX - r.left, e.clientY - r.top, pinReach(e.pointerType === 'mouse' ? 12 : 22));
    // A tap on a pile (a pin with its count) lists the pictures in it to pick from, as a pointer
    // resting on it does; a click opens the newest, with the list already showing.
    if (hit?.type === 'photo' && e.pointerType !== 'mouse' && full && !previewsHidden && picturePins.pileOf(hit.id).length > 1) {
      closeSheet();
      showPeek(hit);
      return;
    }
    if (peek.id) hidePeek();
    if (hit?.type === 'photo') {
      closeSheet();
      focusPhoto(hit.id);
    } else if (hit?.type === 'satellite') {
      setFollow(true);
    }
  }

  // keyboard
  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (t && (t.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT')) return;
    if (tag === 'INPUT' && t.type !== 'range') return;
    if (tag === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // the scrubber's own keys
    if ((tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') && (e.key === ' ' || e.key === 'Enter')) return;
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
      case 't':
      case 'T':
        if (!picker.isOpen) {
          if (sheetAlongBottom() || clockAway()) closeSheet();
          picker.open(state.ms, el.timeBtn);
        }
        break;
      case 'm':
      case 'M':
        if (opts.ui === 'compact') return;
        setView(onMap() ? 'globe' : 'map');
        break;
      case 'a':
      case 'A':
        // never a key that does nothing without a word
        if (!scene.auroraStatus) {
          if (!full) return;
          toast('The aurora isn’t available in this browser.');
        } else if (onMap()) toast(AURORA_GLOBE_ONLY);
        else setAuroraOn(!auroraOn);
        break;
      case '+':
      case '=':
        zoomView(1);
        break;
      case '-':
      case '_':
      case '−':
        zoomView(-1);
        break;
      case '?':
        // only where the list can show: the full UI, with a keyboard
        if (opts.ui === 'compact') return;
        setKeysOpen(!el.keys.open);
        break;
      case 'p':
      case 'P':
        // only where the button shows: the side-panel layout of the full UI
        if (opts.ui === 'compact' || root.classList.contains('cg-narrow')) return;
        setPanels(!state.panels);
        break;
      case ',':
        stepBySpeed(-1);
        break;
      case '.':
        stepBySpeed(1);
        break;
      case 'ArrowLeft':
        step(-(e.shiftKey ? 60 : 1) * MIN_MS);
        break;
      case 'ArrowRight':
        step((e.shiftKey ? 60 : 1) * MIN_MS);
        break;
      case 'Escape':
        if (el.keys.open) setKeysOpen(false);
        else if (state.selectedId) clearSelection();
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
    return {
      t: p.get('t'), photo: p.get('photo'), view: parseView(p.get('view')), map: parseView(p.get('map')),
      mode: p.get('mode'), follow: p.get('follow') === '1', place: p.get('place'),
    };
  }

  /** #t=<iso>&photo=<id>&mode=map&follow=1&place=<id> (another place's passes), and with `view`
   * the camera on screen (not while following: the satellite sets it): the globe's as
   * &view=<lat>,<lon>,<distance>, the map's as &map=<lat>,<lon>,<zoom, times the widest>. */
  function stateParams({ view = false } = {}) {
    const p = new URLSearchParams();
    if (!state.live) p.set('t', isoUtc(state.ms));
    if (state.selectedId) p.set('photo', state.selectedId);
    if (onMap()) p.set('mode', 'map');
    if (state.follow) p.set('follow', '1');
    if (placeSearch.place) p.set('place', placeSearch.place.id);
    const v = view && !state.follow ? (onMap() ? map : scene).viewPoint() : null;
    if (v) p.set(onMap() ? 'map' : 'view', `${v.latDeg.toFixed(2)},${v.lonDeg.toFixed(2)},${(onMap() ? v.zoom : v.distance).toFixed(2)}`);
    return p.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',');
  }

  // Routine updates leave the camera out: it moves without telling us, so a
  // stale view would win over the photo on a reload.
  function writeHash({ view = false } = {}) {
    if (!opts.hashState || destroyed) return;
    const url = new URL(location.href);
    url.searchParams.delete('photo');
    const params = stateParams({ view });
    url.hash = params ? `#${params}` : '';
    const next = url.href.replace(/#$/, '');
    if (next !== location.href) history.replaceState(history.state, '', next);
  }

  function shareUrl() {
    const url = new URL('index.html', MODULE_BASE);
    const params = stateParams({ view: true });
    return params ? `${url.href}#${params}` : url.href;
  }

  /** Put the camera back where a link's view had it (at the current time): the globe's
   * (view=), the map's (map=, its third number the zoom). */
  function applyView(v, m = null) {
    if (!v && !(m?.distance > 0)) return;
    state.userMovedCamera = true;
    setFollow(false);
    if (v) flyToGround(v.lat, v.lon, { distance: v.distance, immediate: true });
    if (m?.distance > 0) map.flyToGround(m.lat, m.lon, { zoom: m.distance, immediate: true });
  }

  /** The passes over the place a link names, or Calgary's. */
  function applyPlace(id) {
    if (id) placeSearch.choosePlace(id);
    else if (placeSearch.place) placeSearch.reset();
  }

  function applyHash() {
    const h = hashParams();
    setView(h.mode === 'map' ? 'map' : 'globe', { write: false });
    if (h.photo && h.photo !== state.selectedId) focusPhoto(h.photo, { immediate: false });
    if (h.t) {
      const ms = Date.parse(h.t);
      if (Number.isFinite(ms)) {
        state.focusMs = ms;
        jumpTo(ms);
      }
    }
    applyView(h.view, h.map);
    if (h.follow !== state.follow) setFollow(h.follow);
    applyPlace(h.place);
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
        // made-up pictures only when asked for (?sample, working on the page without a build)
        if (err.status !== 404 || !new URLSearchParams(location.search).has('sample')) {
          console.warn('Globe: photo data unavailable', err);
          note('Picture data unavailable.');
          photosFailed = true;
          return [];
        }
        json = await fetchJson(opts.sampleUrl);
        sample = true;
        note('Sample data.', 'site/data/images.json was not found, so the globe shows sample pictures.');
      }
    }
    launchMs = launchTime(json) ?? astro.LAUNCH_MS;
    let list = toPhotos(json, { base: opts.siteRoot });
    let annotations = null;
    if (!sample) {
      for (const url of annotationUrls(opts.siteRoot)) {
        try {
          annotations = await fetchJson(url);
          list = applyAnnotations(list, annotations);
          break;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
        }
      }
      loadViewfinder(Array.isArray(json) ? json : json.images, annotations);
    }
    return list;
  }

  // ---- start -------------------------------------------------------------------
  if (opts.ui !== 'compact') {
    let panels = null;
    try {
      panels = localStorage.getItem(PANELS_KEY);
    } catch {
      // storage blocked: start with the panels shown
    }
    if (panels === 'hidden') setPanels(false);
  }
  const noGl = root.classList.contains('cg-nogl-on');
  setView(hashParams().mode === 'map' || opts.view === 'map' || noGl ? 'map' : 'globe', { write: false });
  paintTransport();
  paintPhotoList();
  paintPasses();
  pushScene(true);
  flyToGround(astro.CALGARY.latDeg, astro.CALGARY.lonDeg, { distance: DEFAULT_DISTANCE, immediate: true });

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
  applyView(hash.view, hash.map);
  applyPlace(hash.place);
  raf = requestAnimationFrame(frame);

  Promise.all([loadOrbit(), loadPhotos()])
    .then(([, list]) => {
      if (destroyed) return;
      photos = list;
      loaded = true;
      placePhotos();
      trackKey = null;
      pushScene(true);
      picker.refresh();
      paintPasses();
      // a link with a camera view keeps it rather than flying to the photo
      const wanted = pendingFocus || (startPhoto ? { id: startPhoto, fly: !hash.view && !hash.map && !hash.follow, immediate: true } : null);
      pendingFocus = null;
      const focused = wanted ? focusPhoto(wanted.id, { fly: wanted.fly, immediate: wanted.immediate }) : false;
      if (wanted && !focused) {
        const msg = `Picture “${wanted.id}” not found.`;
        note(el.note.hidden ? msg : `${el.note.textContent} ${msg}`, el.note.title);
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
      if (!onPhoto && !state.userMovedCamera) flyToSatellite({ immediate: true });
      applyView(hash.view, hash.map); // again, now the Earth is turned to the final time
      if (hash.follow) {
        flyToSatellite({ immediate: true });
        setFollow(true);
      }
      markDirty();
    })
    .catch((err) => {
      if (err.name === 'AbortError' || destroyed) return;
      console.error('Globe: failed to load data', err);
      loaded = true;
      note('Could not load the data.');
      photosFailed = true;
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
      sheetObserver.disconnect();
      vfObserver.disconnect();
      for (const off of cleanups) off();
      scene.dispose();
      map.dispose();
      picker.destroy();
      wheel.destroy();
      placeSearch.destroy();
      shotPanel.destroy();
      root.remove();
    },
  };
}
