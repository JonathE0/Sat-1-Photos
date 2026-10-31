/**
 * The landing's scroll story: the Earth alone, the camera swinging to where
 * CTS-SAT-1 is right now, then the satellite, its orbit and the pictures'
 * pins, handed over to the visitor. See docs/design-direction.md section 3.
 *
 *   import { mountJourney } from './explore/journey.js';
 *   const journey = mountJourney(container, {
 *     photos,                       // mergeAll() output from assets/data.js
 *     tleUrl: 'data/tle.json',
 *     onOpenPhoto(id) {},           // the preview's picture; on a phone, a pin or a card
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
 * over it. Native scroll only; nothing plays on a timer. The camera and the
 * beats follow p through a critically damped spring (about 0.4 s); under
 * reduced motion through a 30 ms exponential with no momentum. Nothing is
 * rendered after the section: the page ends with the story. Every fresh
 * mount starts at beat 1, whatever the motion setting.
 *   0    - 0.12  beat 1, the Earth facing Calgary, h1 block, "Scroll to learn more"
 *   0.14 - 0.60  the swing (the only travelling camera move)
 *   0.58 - 0.74  beat 2, the live sentence, once the swing has cleared the sky for it
 *   0.62 - 0.68  satellite and orbit fade in (scrubbed)
 *   0.74 -       the h1 block again, with the live sentence and how to use it
 *   0.80 -       pins, time, zoom, "See all n pictures"; drag enabled
 *   1, at rest   the end locks: the section collapses to one screen, the
 *                wheel over the globe zooms, "Play the intro again" undoes it.
 *                The lock lasts for the life of the page (hide/show keep it;
 *                initialState can restore it), and for the tab: coming back
 *                from another page opens at the end. A reload or a new tab
 *                starts over.
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
import { grouped } from '../assets/format.js';
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
  isNearlyWhole,
  isSquare,
  launchDate,
  photoTime,
  placeOf,
  rowsWithData,
  statusLine,
  utcShort,
} from './journey-parts.js';
import { loadCountries, placeAt, placeInSentence } from './journey-region.js';

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
  // the camera has almost arrived by here; on a long swing the Earth can still be
  // behind the words at 0.56
  beat2In: 0.58,
  satIn: 0.62,
  satFull: 0.68,
  beat2Out: 0.74,
  ui: 0.8,
};

/** The end view: this far behind the satellite, the height solved so the limb sits under the text. */
const CHASE_BEHIND_KM = 1400;
/**
 * The end view's heading, radians off the track. Straight behind, the camera
 * sits in the orbit's plane and the 3U shows only its end; this side sends
 * the coming track off toward the text column on the left (the composition
 * the user chose). The text is see-through, so the line runs behind it and
 * only the letters themselves cover it.
 */
const CHASE_YAW = 0.52;
/** The satellite's smallest length on screen when zoomed far out, px. */
const SAT_MIN_PX = 12;
/** Room for the tallest fact in the banner, px. */
const FACTS_RESERVE_WIDE_PX = 120;
/** From the satellite's centre to whatever is under it: half its button and a margin, px. */
const SAT_CLEAR_PX = 30;
/** How far the limb sits under the text, and the satellite at least under the limb (fractions of the height). */
const LIMB_UNDER_TEXT = 0.03;
const SAT_UNDER_LIMB = 0.06;
/** journey.css data-fit: what the end view gives up when short of room (see endRoom). */
const FIT_NO_FACTS = 2;
const FIT_MOST = 4;
/** The satellite's light in the Earth's shadow: enough to find it, well under the Sun's 3.2. */
const SAT_SHADOW_AMBIENT = 0.8;
const SAT_SHADOW_FILL = 0.2;
/** Set in this tab once the story has been finished, so coming back doesn't mean scrolling it again. */
const STORY_FINISHED_KEY = 'cts-story-finished';
const storyFinished = {
  get() {
    try {
      return sessionStorage.getItem(STORY_FINISHED_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(on) {
    try {
      if (on) sessionStorage.setItem(STORY_FINISHED_KEY, '1');
      else sessionStorage.removeItem(STORY_FINISHED_KEY);
    } catch { /* no storage: the story just plays again */ }
  },
};
/** A visitor's choice that outlasts the tab: the panel or the facts put away. */
const rememberedChoice = (key) => ({
  get() {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  },
  set(on) {
    try {
      if (on) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch { /* no storage: it's only remembered until the page closes */ }
  },
});
const dockHiddenChoice = rememberedChoice('cts-panel-hidden');
const factsHiddenChoice = rememberedChoice('cts-facts-hidden');
const auroraHiddenChoice = rememberedChoice('cts-aurora-hidden');
const cycleOffChoice = rememberedChoice('cts-cycle-off');
/** Stats' turn when the panel cycles; Pictures' turn is one picture (DWELL_MS in viewfinder.js). */
const CYCLE_STATS_MS = 10000;
/** Screens with room for the picture viewfinder; keep in step with .jy-vf-slot in journey.css. */
const VIEWFINDER_MEDIA = '(min-width: 1360px) and (min-height: 760px) and (min-aspect-ratio: 4/5)';
/** Close up, the camera levels out to this pitch so the limb sits behind the satellite. */
const CLOSE_PITCH = 18 * DEG;
/** Long swings rise this much (times the beat 1 distance) at their middle so they don't whip. */
const SWING_LIFT = 0.6;
/**
 * Scroll smoothing: a critically damped spring toward the scroll position,
 * settling in about 0.4 s (no overshoot, stops when it arrives). Under
 * reduced motion, a plain 30 ms exponential (no velocity): 98% there in 120 ms.
 */
const SCROLL_SPRING = 14;
const SCROLL_LAG_REDUCED_S = 0.03;
const ZOOM_LAG_S = 0.14;
const BLEND_MS = 600;

/** Behind the Earth: true black, with the stars, the Sun and the Moon (sky.js) on it. */
const SKY = '#000000';
/** Where the satellite and its orbit line go out of sight behind the Earth, Earth radii: about 64 km up, in the lit air. */
const OCCLUDER_RADIUS = 1.01;
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
const ICON_REPLAY = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M4.4 2.2v2.6H7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_STATS = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4 16.5V10M10 16.5V4M16 16.5v-9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_PICTURES = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 4.5h14v11H3zM3 13l4-4 3 3 2.5-2.5L17 14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_FACTS = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5M10 6v1.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_CONTROLS = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 6h7M14 6h3M3 14h3M10 14h7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 3.8h4v4.4h-4zM6 11.8h4v4.4H6z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

function template(id, siteRoot) {
  const logo = new URL('assets/calgarytospace-logo.png', siteRoot).href;
  return `
  <section class="jy" aria-label="CTS-SAT-1 right now">
    <div class="jy-stage">
      <!-- This order is the tab order and the reading order: what is on screen, from the top.
           How things stack is z-index in journey.css, not this. resize() swaps the last two when
           the corner row sits above the time row. -->
      <div class="jy-dock">
        <div class="jy-summary" data-ref="summary">
          <p class="jy-summary-text"><span class="jy-summary-name">CTS-SAT-1</span> <span data-ref="summaryWhere"></span></p>
          <div class="jy-summary-tools">
            <div class="jy-tabs" role="group" aria-label="Show in this panel">
              <button type="button" class="jy-tab" data-ref="tabStats" aria-pressed="false" aria-controls="jy-panel-${id}">Stats</button>
              <button type="button" class="jy-tab" data-ref="tabPictures" aria-pressed="false">Pictures</button>
              <button type="button" class="jy-tab jy-cycle" data-ref="cycle" aria-pressed="false" hidden
                title="Take turns showing Stats and Pictures">Cycle</button>
            </div>
            <button type="button" class="jy-tab jy-dock-toggle" data-ref="dockToggle" aria-expanded="true"
              aria-label="Hide this panel"><span data-ref="dockToggleText">Hide</span> ${ICON_DOWN}</button>
          </div>
        </div>
        <div class="jy-vf-slot" data-ref="viewfinderSlot" hidden></div>

      <aside class="jy-panel" id="jy-panel-${id}" data-ref="panel" hidden aria-labelledby="jy-panel-title-${id}">
        <button type="button" class="jy-grab" data-ref="grab" aria-hidden="true" tabindex="-1"><span></span></button>
        <div class="jy-panel-head">
          <h2 class="jy-panel-title" id="jy-panel-title-${id}" tabindex="-1">CTS-SAT-1</h2>
          <div class="jy-panel-tools">
            <button type="button" class="jy-textbtn" data-ref="follow" aria-pressed="true">Following</button>
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
          <p class="jy-small jy-muted jy-aurora-note" data-ref="auroraNote" hidden></p>
          <div class="jy-details-facts" data-ref="detailsFacts"></div>
          <p class="jy-small jy-retry" data-ref="noOrbit" hidden>Couldn\u2019t work out where it is: no orbital elements loaded.
            <button type="button" class="jy-textbtn" data-ref="retry">Try again</button></p>
          <section class="jy-latest" data-ref="latest" hidden>
            <h3 class="jy-latest-title" data-ref="latestTitle">Latest picture</h3>
            <a class="jy-latest-frame" data-ref="latestFrame"><img data-ref="latestImg" alt="" decoding="async"></a>
            <p class="jy-latest-failed" data-ref="latestFailed" hidden>This picture didn\u2019t load.
              <button type="button" class="jy-textbtn" data-ref="latestRetry">Try again</button></p>
            <p class="jy-latest-place" data-ref="latestPlace"></p>
            <p class="jy-small jy-muted" data-ref="latestTime"></p>
            <p class="jy-small" data-ref="latestStatus"></p>
            <a class="jy-link" data-ref="latestOpen">Open in the catalogue</a>
            <a class="jy-link jy-latest-all" data-ref="latestAll"></a>
          </section>
        </div>
      </aside>
      </div>

      <section class="jy-credits" id="jy-credits-${id}" data-ref="credits" hidden role="dialog" aria-modal="false"
        aria-labelledby="jy-credits-title-${id}">
        <div class="jy-panel-head">
          <h2 class="jy-panel-title" id="jy-credits-title-${id}" tabindex="-1">Credits</h2>
          <button type="button" class="jy-textbtn" data-ref="creditsClose">Close</button>
        </div>
        <img class="jy-credits-logo" src="${logo}" width="640" height="204" alt="CalgaryToSpace">
        <ul class="jy-credits-links">
          <li><a class="jy-link" href="https://www.calgarytospace.ca/">calgarytospace.ca</a></li>
          <li><a class="jy-link" href="https://frontiersat.mooo.com/">FrontierSat dashboard</a></li>
          <li><a class="jy-link" href="https://github.com/CalgaryToSpace">github.com/CalgaryToSpace</a></li>
        </ul>
        <p>Website designed by Jonathan Eng and Claude <span aria-hidden="true">\u{1F6F0}️</span></p>
        <p>Thank you to the mission operations team, who do a great job of keeping FrontierSat running and getting its
          pictures down to Earth. None of this would be possible without them.</p>
        <p>That thanks extends to the whole CalgaryToSpace team, whose work designing, building and testing the
          satellite put it in orbit in the first place.</p>
        <p>Earth: NASA Blue Marble, Black Marble and cloud imagery. Orbital elements:
          <a class="jy-link" href="https://www.space-track.org/">Space-Track.org</a>. Packets: the
          <a class="jy-link" href="https://network.satnogs.org/">SatNOGS network</a> and the team's own ground station.
          Place names: © <a class="jy-link" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.
          Aurora: the OVATION forecast from the
          <a class="jy-link" href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast">NOAA Space Weather Prediction Center</a>;
          the shimmer on it is only for show.</p>
        <p>Sky: the <a class="jy-link" href="http://tdc-www.harvard.edu/catalogs/bsc5.html">Yale Bright Star Catalogue</a>
          (Hoffleit and Warren, 1991) and the Moon from NASA's Scientific Visualization Studio
          (<a class="jy-link" href="https://svs.gsfc.nasa.gov/4720">CGI Moon Kit</a>).</p>
        <p>CubeSat model: NASA IceCube, a 3U like CTS-SAT-1, by NASA/Christopher R. Meaney (NASA 3D Resources,
          public domain); drawn far larger than life.</p>
        <div class="jy-news-slot" data-ref="newsSlot"></div>
      </section>

      <div class="jy-text">
        <div class="jy-beat jy-b1" data-ref="b1">
          <h1 class="jy-h1"><span class="jy-words">CTS-SAT-1</span></h1>
          <p class="jy-sub"><span class="jy-words">Interactive picture visualizer</span></p>
          <p class="jy-lead jy-intro-only"><span class="jy-words">Calgary To Space\u2019s first satellite, built by University of Calgary students and in orbit since ${launchDate}.</span></p>
          <p class="jy-cue jy-intro-only" data-ref="cue" tabindex="-1"><span class="jy-words">Scroll to learn more</span> ${ICON_DOWN}</p>
          <p class="jy-lead jy-live-lead jy-end-only"><span class="jy-words" data-ref="liveLead"></span> <span class="jy-words jy-lead-more" data-ref="liveMore"></span></p>
          <p class="jy-tip jy-end-only" data-ref="tip"><span class="jy-words" data-ref="satTip"></span></p>
          <p class="jy-hint jy-end-only" data-ref="hint"><span class="jy-words" data-ref="hintText"></span></p>
        </div>
        <p class="jy-beat jy-statement jy-b2" data-ref="b2"><span class="jy-words" data-ref="b2t"></span></p>
      </div>

      <canvas class="jy-canvas" tabindex="-1"
        aria-label="The Earth and CTS-SAT-1. Drag or use the arrow keys to look around; plus and minus zoom."></canvas>
      <canvas class="jy-still" hidden aria-hidden="true"></canvas>
      <div class="jy-marks"></div>
      <canvas class="jy-over-canvas" aria-hidden="true"></canvas>
      <div class="jy-marks jy-marks-sat" data-ref="satMarks">
        <button type="button" class="jy-sat" data-ref="sat" hidden
          aria-label="CTS-SAT-1: where it is now"><span class="jy-sat-label" aria-hidden="true">CTS-SAT-1</span></button>
      </div>
      <div class="jy-card" data-ref="card" hidden></div>
      <div class="jy-sky-label" data-ref="skyLabel" aria-hidden="true"></div>

      <div class="jy-facts-slot" data-ref="factsSlot"></div>
      <button type="button" class="jy-facts-show" data-ref="factsShow" hidden>Show facts</button>

      <div class="jy-time" data-ref="time" role="group" aria-label="Time">
        <p class="jy-clock"><span class="jy-clock-main" data-ref="clockMain"></span><span class="jy-clock-sub" data-ref="clockSub"></span></p>
        <div class="jy-speed" role="radiogroup" aria-label="Speed">
          ${SPEEDS.map((s) => `<label><input type="radio" name="jy-speed-${id}" value="${s}"${s === 1 ? ' checked' : ''}><span>${s}\u00d7</span></label>`).join('')}
        </div>
        <button type="button" class="jy-btn jy-now" data-ref="now">Now</button>
      </div>

      <div class="jy-corner" data-ref="corner">
        <button type="button" class="jy-textbtn jy-again" data-ref="again">${ICON_REPLAY}<span>Play the intro again</span></button>
        <button type="button" class="jy-textbtn jy-toggle" data-ref="followBar" aria-pressed="true"
          title="Keep the camera on the satellite">Following</button>
        <button type="button" class="jy-textbtn jy-toggle" data-ref="aurora" aria-pressed="true" hidden
          title="Show or hide NOAA's aurora forecast">Aurora</button>
        <a class="jy-btn jy-all" data-ref="all"><span data-ref="allText"></span>${ICON_ARROW}</a>
        <div class="jy-zoom" role="group" aria-label="Zoom">
          <button type="button" class="jy-sq" data-ref="zoomOut" aria-label="Zoom out">${ICON_MINUS}</button>
          <button type="button" class="jy-sq" data-ref="zoomIn" aria-label="Zoom in">${ICON_PLUS}</button>
        </div>
      </div>

      <div class="jy-tabbar" data-ref="tabbar" role="group" aria-label="Explore">
        <button type="button" class="jy-tabbar-item" data-ref="barStats" aria-pressed="false">${ICON_STATS}<span>Stats</span></button>
        <button type="button" class="jy-tabbar-item" data-ref="barPictures" aria-pressed="false">${ICON_PICTURES}<span>Pictures</span></button>
        <button type="button" class="jy-tabbar-item" data-ref="barFacts" aria-pressed="false">${ICON_FACTS}<span>Facts</span></button>
        <button type="button" class="jy-tabbar-item" data-ref="barControls" aria-pressed="false">${ICON_CONTROLS}<span>Controls</span></button>
      </div>
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
  // no entrances on the first frame: the page may already show these words (index.html)
  root.className = 'jy-root jy-instant';
  root.innerHTML = template(id, siteRoot);
  container.appendChild(root);
  const ref = {};
  for (const node of root.querySelectorAll('[data-ref]')) ref[node.dataset.ref] = node;
  const section = root.querySelector('.jy');
  const stage = root.querySelector('.jy-stage');
  const canvas = root.querySelector('.jy-canvas');
  const still = root.querySelector('.jy-still');
  const marks = root.querySelector('.jy-marks'); // the pins; the satellite's button is in ref.satMarks
  const overCanvas = root.querySelector('.jy-over-canvas');

  const cleanups = [];
  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
  const bigQuery = window.matchMedia(VIEWFINDER_MEDIA);
  let motionOverride = opts.motion === 'full' || opts.motion === 'reduced' ? opts.motion : null;
  const reducedMotion = () => (motionOverride ? motionOverride === 'reduced' : motionQuery.matches);
  root.classList.toggle('jy-calm', motionOverride === 'reduced');

  // ---- state -----------------------------------------------------------------
  const state = {
    mode: 'story', // 'story', or 'still' without WebGL
    shown: true,
    visible: true, // on screen (IntersectionObserver)
    pTarget: 0, // the scroll position
    pSmooth: 0, // what the camera and the beats follow
    pVel: 0,
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
    tab: 'stats', // what the details show: 'stats', or 'pictures' where the viewfinder doesn't show
    dockHidden: false, // the whole panel put away
    dockResume: null, // the tab that was open when it was
    factsHidden: false,
    phoneExtra: null, // what's open over a phone's bottom bar, besides the details: 'facts' or 'controls'
    previewId: null, // a picture chosen on the globe, for the preview
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
    holdSeen: 0, // how long the story's scroll was when last read
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
  // Two canvases. The Earth and the sky are drawn under the picture pins; the
  // satellite and its orbit line on a transparent canvas over them, so where
  // they cross a pin they cover it. On that canvas a sphere that only writes
  // depth still hides whatever passes behind the Earth. It reaches up into the
  // atmosphere (earth.js): below the lit band the air is dark, so a line that
  // ran down to the solid ground would look as if it entered the Earth.
  let renderer = null;
  let overRenderer = null;
  const scene = new THREE.Scene();
  const overScene = new THREE.Scene();
  // near 0.005 (about 32 km) at every zoom: the satellite never gets nearer than that, see zoomLimits
  const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 60);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
  const ambient = new THREE.AmbientLight(0xffffff, 0.05);
  const satHolder = new THREE.Group();
  satHolder.visible = false;
  const orbitLine = createScreenLine(260, { color: BLUE, widthPx: 2 });
  orbitLine.setOpacity(0);
  const occluder = new THREE.Mesh(new THREE.SphereGeometry(OCCLUDER_RADIUS, 128, 64), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occluder.renderOrder = -1;
  overScene.add(occluder, sunLight, sunLight.target, ambient, satHolder, orbitLine.mesh);

  let earth = null;
  let earthReady = false;
  let aurora = null;
  let auroraNote = () => null;
  let sky = null;
  let satellite = null;
  let satMaterials = [];
  let satOpacity = -1;
  let satScale = 1; // satellite.setScale's last value, for the pins it covers

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
    renderer.setClearColor(SKY, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
  } catch (err) {
    console.warn('Journey: WebGL unavailable, showing a still Earth', err);
    webgl = false;
    renderer = null;
    canvas.hidden = true;
  }
  if (renderer) {
    try {
      overRenderer = new THREE.WebGLRenderer({ canvas: overCanvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      overRenderer.setClearColor(0x000000, 0);
      overRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      overRenderer.toneMappingExposure = 1;
    } catch (err) {
      // one canvas, as before: the pins then sit over the satellite
      console.warn('Journey: no second canvas, drawing the satellite under the pins', err);
      overRenderer = null;
      occluder.removeFromParent();
      scene.add(...overScene.children);
    }
  }
  if (!overRenderer) overCanvas.hidden = true;

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
      for (const pin of pins) loadPinPicture(pin.el.querySelector('img'));
      loadPlaceNames();
      needsFrame = true;
    };
    // fade in once the full maps are uploaded (the upload itself can stall a
    // frame, so not mid-fade); on a very slow line, show the previews anyway
    Promise.resolve(earth.ready).then(reveal, reveal);
    setTimeout(reveal, 10_000);
    loadAurora();
  }

  // NOAA's forecast, on the Earth (aurora.js). Without it the globe just has no aurora.
  async function loadAurora() {
    try {
      const mod = await import('../globe/aurora.js');
      if (destroyed) return;
      auroraNote = mod.auroraNote;
      aurora = mod.createAurora({
        quality,
        still: motionOverride === 'reduced',
        onStatus: () => {
          needsFrame = true;
          paintAurora();
        },
      });
      aurora.setOn(!auroraHiddenChoice.get());
      earth.group.add(aurora.object);
      paintAurora();
    } catch (err) {
      console.warn('Journey: no aurora', err);
    }
  }

  /** The button, and the line in the details that says what's being shown. */
  function paintAurora() {
    if (!aurora) return;
    ref.aurora.hidden = false;
    ref.aurora.setAttribute('aria-pressed', String(aurora.on));
    const note = aurora.on ? auroraNote(aurora.status, state.simMs) : null;
    ref.auroraNote.hidden = !note;
    if (note) put(ref.auroraNote, note);
  }

  // the sky is decoration: without it the Earth sits on plain black
  async function loadSky() {
    try {
      const mod = await import('./sky.js');
      if (destroyed) return;
      sky = mod.createSky(renderer, { quality });
      scene.add(sky.group);
      needsFrame = true;
      Promise.resolve(sky.ready).then(() => { needsFrame = true; });
    } catch (err) {
      console.warn('Journey: no stars, Sun or Moon', err);
    }
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
    useSatellite(made);
    // on a slow line the first one is a stand-in: the real model takes its place when it comes
    made.late?.then((real) => {
      if (real) useSatellite(real);
    });
  }

  function useSatellite(made) {
    if (destroyed) {
      made.dispose();
      return;
    }
    satellite?.dispose();
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
    loadSky();
    loadSatellite();
  } else {
    loadPlaceNames();
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
    yaw: CHASE_YAW,
    satPx: 44,
    ui: 1,
    endText: null, // the text column at the end of the story, stage px
    textNow: [], // text on screen now, stage px
    covers: [], // controls and panels on screen now, stage px: pins don't show half under them
    pinHalf: { x: 18, y: 14 }, // half a pin, px
    stacked: false, // the corner row sits above the time row
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

  /**
   * Where the satellite can go on the end view, for the words ending at
   * `textBottom`: under the limb, and clear of the controls and the facts banner.
   * On a phone only the bottom bar is always there; the facts and the controls open
   * over the globe when asked for. Elsewhere the banner is a column on the left, which
   * the satellite moves right of when they'd meet. `fits` is false when the words, the
   * satellite and everything kept at this level don't all fit.
   */
  function endRoom(s, narrow, textBottom, fit) {
    const controls = narrow ? boxOf(ref.tabbar, s) : union([boxOf(ref.corner, s), boxOf(ref.time, s)]);
    const floor = controls ? controls.top : H;
    const satMin = textBottom / H + LIMB_UNDER_TEXT + SAT_UNDER_LIMB;
    let satMax = (floor - SAT_CLEAR_PX) / H;
    let satX = narrow ? 0.5 : 0.62;
    let clearOfText = true;
    if (!narrow && fit < FIT_NO_FACTS) {
      const top = floor - 16 - FACTS_RESERVE_WIDE_PX;
      clearOfText = top >= textBottom + 8;
      if (controls) {
        const m = controls.left;
        const right = m + Math.min(34 * parseFloat(getComputedStyle(ref.factsSlot).fontSize), W - 2 * m);
        const beside = right + 40; // the model's half length
        if (beside > satX * W) {
          // room for the model and its label to the banner's right, or else above it
          if (beside + 90 <= W - m) satX = beside / W;
          else satMax = (top - SAT_CLEAR_PX) / H;
        }
      }
    }
    return { fits: clearOfText && satMin <= satMax, satMax, satX };
  }

  /** The facts banner, or the same facts in the details when the end view has no room for it. */
  function placeFacts() {
    const inDetails = !frame.narrow && frame.fit >= FIT_NO_FACTS;
    const home = inDetails ? ref.detailsFacts : ref.factsSlot;
    if (ticker?.element && ticker.element.parentNode !== home) home.append(ticker.element);
    // in the details the facts are out of the way already, with nothing to hide
    ref.factsShow.hidden = !state.factsHidden || inDetails;
  }

  function computeFrame() {
    const narrow = W < 600 || W / H < 0.8 || (W < 700 && W / H < 1.2);
    frame.narrow = narrow;
    root.classList.toggle('jy-narrow', narrow); // what's measured below depends on it
    frame.ui = clamp(1 + ((W - 1920) / 1920) * 0.3, 1, 1.2);
    // landscape: 35 degrees tall; portrait: hold 35 degrees across
    const vfov = W >= H ? 35 : (2 * Math.atan(Math.tan(17.5 * DEG) * (H / W))) / DEG;
    frame.vfov = vfov;
    frame.tanHalf = Math.tan((vfov / 2) * DEG);
    const s = stageRect();

    // The headline block has a beat 1 layout and an end layout; measure both
    // as they will be, whichever is showing, so the framing never jumps when
    // the block changes.
    const composedNow = root.classList.contains('jy-composed');
    root.classList.remove('jy-composed');
    const introBox = boxOf(ref.b1, s);
    root.classList.add('jy-composed');
    // With no viewfinder the end view can be short of room. The satellite comes
    // first: what can go goes, one step at a time, until it fits. Within one window
    // size it only ever gives up more, so nothing flickers as the place name changes.
    const slot = boxOf(ref.viewfinderSlot, s);
    const size = `${W}x${H}`;
    if (frame.fitSize !== size) {
      frame.fitSize = size;
      frame.fit = 0;
    }
    if (slot) frame.fit = 0;
    let endBox;
    let room;
    for (;;) {
      root.dataset.fit = String(frame.fit);
      endBox = boxOf(ref.b1, s);
      if (endBox) {
        // as laid out: the block may be mid-entrance, moved by its transform
        const top = ref.b1.offsetParent.getBoundingClientRect().top - s.top + ref.b1.offsetTop;
        endBox = { ...endBox, top, bottom: top + ref.b1.offsetHeight };
      }
      room = slot ? null : endRoom(s, narrow, endBox ? endBox.bottom : 0, frame.fit);
      if (!room || room.fits || frame.fit >= FIT_MOST) break;
      frame.fit++;
    }
    root.classList.toggle('jy-composed', composedNow);
    placeFacts();

    // beat 1: the whole Earth
    let diam;
    if (!narrow) {
      diam = 0.62;
      frame.lens0 = { x: 0.7, y: 0.6 };
    } else {
      diam = (1.2 * W) / H;
      const top = (introBox ? introBox.bottom / H : 0.4) + 0.02; // the Earth starts under the h1 block
      frame.lens0 = { x: 0.5, y: Math.max(0.7, top + diam / 2) };
    }
    frame.d0 = 1 / Math.sin(Math.atan(diam * frame.tanHalf));

    // the end: behind the satellite, the limb under the headline block (and
    // under the big live sentence, which is still up as the camera arrives,
    // unless that would leave the satellite no room)
    const story = boxOf(ref.b2, s);
    const storyFits = !room || (story && story.bottom / H + LIMB_UNDER_TEXT + SAT_UNDER_LIMB <= room.satMax);
    frame.endText = union([endBox, storyFits ? story : null]);
    let satY = narrow ? 0.64 : 0.6;
    let limbY = narrow ? 0.45 : 0.42;
    if (frame.endText) limbY = Math.max(limbY, frame.endText.bottom / H + LIMB_UNDER_TEXT);
    // ... and under the summary bar, with the picture viewfinder below it on big
    // screens (the bar isn't laid out on a phone, nor the viewfinder off big screens)
    const dock = union([boxOf(ref.summary, s), slot]);
    if (dock) limbY = Math.max(limbY, dock.bottom / H + LIMB_UNDER_TEXT);
    satY = clamp(Math.max(satY, limbY + 0.12), 0, narrow ? 0.8 : 0.86);
    if (room) satY = Math.max(limbY + SAT_UNDER_LIMB, Math.min(satY, room.satMax));
    let satX = room ? room.satX : 0.62;
    if (state.panel && !narrow && !slot) {
      // keep the satellite clear of the details on narrower desktops (with the
      // viewfinder they stay in its place, above the limb, and nothing moves)
      const panel = boxOf(ref.panel, s);
      // room for the model and its label, which runs about 90px to its right
      if (panel) satX = Math.min(satX, Math.max(0.3, (panel.left - 104 * frame.ui) / W));
    }
    frame.lens1 = { x: satX, y: satY };
    const delta = Math.atan(2 * Math.max(0.02, satY - limbY) * frame.tanHalf);
    const h = sat.state ? sat.state.altKm / EARTH_RADIUS_KM : 500 / EARTH_RADIUS_KM;
    frame.a = solveChaseHeight(delta, frame.b, h);
    frame.satPx = (narrow ? 36 : 44) * frame.ui;
    frame.pinHalf = narrow ? { x: 14, y: 11 } : { x: 16 * frame.ui + 2, y: 12 * frame.ui + 2 };
    stage.style.setProperty('--jy-ui', String(frame.ui));
    measureText();
  }

  /**
   * The words on screen now (including a block still fading out), one
   * rectangle per line of text: pins hide under these. The block itself is
   * see-through and takes no pointer, so the globe and the orbit line show,
   * and the globe turns, everywhere but under the letters.
   */
  const leaving = new Map(); // block -> time it started fading out
  function measureText() {
    const s = stageRect();
    const now = performance.now();
    const lines = [];
    for (const el of [ref.b1, ref.b2]) {
      const fading = leaving.has(el) && now - leaving.get(el) < 650;
      if (!el.classList.contains('is-on') && !fading) continue;
      for (const words of el.querySelectorAll('.jy-words')) {
        // skip lines that are laid out but not showing (the dismissed hint, the faded cue)
        if (words.closest('.jy-hint.is-off')) continue;
        if (words.closest('.jy-cue') && root.classList.contains('jy-scrolled')) continue;
        for (const r of words.getClientRects()) {
          if (!r.width || !r.height) continue;
          lines.push({ left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top });
        }
      }
    }
    frame.textBoxes = lines;
    frame.textNow = lines.map((b) => ({ left: b.left - 8, top: b.top - 8, right: b.right + 8, bottom: b.bottom + 8 }));
    // the controls and panels showing now
    const covers = [];
    const cover = (el) => {
      const b = boxOf(el, s);
      if (b && getComputedStyle(el).visibility !== 'hidden') covers.push(b);
    };
    for (const el of [...ref.time.children, ...ref.corner.children, ...ref.factsSlot.children, ...ref.tabbar.children, ref.factsShow, ref.summary]) cover(el);
    // the viewfinder's fade out would still count as showing, so go by what took its place
    if (state.panel) cover(ref.panel);
    else if (state.creditsOpen) cover(ref.credits);
    else if (!state.dockHidden) cover(ref.viewfinderSlot);
    frame.covers = covers;
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
      overRenderer?.setPixelRatio(dpr);
      overRenderer?.setSize(W, H, false);
    }
    camera.aspect = W / H;
    computeFrame();
    camera.fov = frame.vfov;
    camera.updateProjectionMatrix();
    if (!frame.narrow) setPhoneExtra(null);
    // turned on its side, a height the finger left it at no longer means anything
    if (frame.sheetW !== W && !ref.panel.classList.contains('is-dragging')) {
      frame.sheetW = W;
      resetSheetSize();
    }
    // tab order follows the screen: when the corner row sits above the time row it comes first
    const stacked = !frame.narrow && W < 1100;
    if (stacked !== frame.stacked) {
      frame.stacked = stacked;
      if (stacked) ref.corner.after(ref.time);
      else ref.time.after(ref.corner);
    }
    if (!webgl) layoutStill();
    readScroll(); // the story may be a different length now
    needsFrame = true;
  }

  // ---- camera rigs -------------------------------------------------------------------
  const rig = { P: new THREE.Vector3(), q: new THREE.Quaternion(), lx: 0.5, ly: 0.5 };
  const shown = { P: new THREE.Vector3(0, 0, 5), q: new THREE.Quaternion(), lx: 0.5, ly: 0.5 };
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

  // ---- occlusion ------------------------------------------------------------------------
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
    // The story got longer or shorter (a phone turned, a window resized): keep the
    // place in it, not the pixels, which might now be past its end and lock it.
    if (state.holdSeen && Math.abs(hold - state.holdSeen) > 1) {
      state.holdSeen = hold;
      scrollWindow(sectionTop() + state.pTarget * hold);
      state.offsetPx = -section.getBoundingClientRect().top;
      state.lastScrollAt = performance.now();
      return;
    }
    state.holdSeen = hold;
    state.pTarget = clamp(-rect.top / hold, 0, 1);
  }

  /**
   * The end: once the story reaches p = 1 and the scroll has come to rest,
   * the section collapses to the stage's own height, so there is nothing
   * left to scroll and the globe stays. The page is put at the section's
   * top in the same frame, which is exactly where the stage already sits on
   * screen, so nothing jumps. It lasts for the life of the page (hide/show
   * keep it) and for the tab (storyFinished); a reload starts the story over.
   */
  function lock({ landing = false } = {}) {
    if (state.mode !== 'story') return;
    state.locked = true;
    storyFinished.set(true);
    if (landing) root.classList.add('jy-instant');
    root.classList.add('jy-locked');
    scrollWindow(sectionTop());
    state.pTarget = 1;
    state.pSmooth = 1;
    state.pVel = 0;
    readScroll();
    updateBeats();
    uiDirty = true;
    needsFrame = true;
    startTicker();
    if (landing) settleInstant();
  }

  /** Lock once the story is at its end and the page has stopped moving (no finger down). */
  /**
   * One step of the smoothing, exact for any frame length (so the same feel at
   * 30, 60 or 144 frames a second). Critically damped: it never overshoots,
   * reverses as soon as the scroll does, and comes to rest when it arrives.
   */
  function smoothProgress(dt) {
    const target = state.pTarget;
    if (reducedMotion()) {
      state.pSmooth += (target - state.pSmooth) * (1 - Math.exp(-dt / SCROLL_LAG_REDUCED_S));
      state.pVel = 0;
    } else {
      const w = SCROLL_SPRING;
      const d = state.pSmooth - target;
      const e = Math.exp(-w * dt);
      const v = state.pVel;
      state.pSmooth = target + (d + (v + w * d) * dt) * e;
      state.pVel = (v - w * (v + w * d) * dt) * e;
    }
    if (Math.abs(target - state.pSmooth) < 2e-4 && Math.abs(state.pVel) < 2e-3) {
      state.pSmooth = target;
      state.pVel = 0;
    }
  }

  function maybeLock(atRest) {
    if (state.locked || state.mode !== 'story' || !state.shown || state.pTarget < 0.999) return;
    // only once the camera has arrived too
    if (state.pSmooth < 0.999) return;
    if (pointers.size) return;
    if (!atRest && performance.now() - state.lastScrollAt < 200) return;
    lock();
  }

  /**
   * A fresh mount: beat 1, the Earth alone. If the page is already scrolled
   * into the story (a browser restoring the scroll on reload), go back to its
   * top; the visitor's scrolling takes it from there.
   */
  function startAtBeginning() {
    if (state.mode !== 'story') return;
    if (section.offsetParent !== null) {
      const top = sectionTop();
      if (window.scrollY > top + 1) scrollWindow(top);
    }
    state.pTarget = 0;
    readScroll();
    state.pSmooth = state.pTarget;
    state.pVel = 0;
  }

  /** "Play the intro again": back to the top of the story, which the visitor's scrolling drives. */
  function playAgain() {
    stopTicker();
    closeCredits();
    closePanel();
    hideCard();
    state.locked = false;
    storyFinished.set(false);
    state.hintDismissed = false;
    state.live = true;
    state.speed = 1;
    state.simMs = Date.now();
    startBlend(); // from the end view to beat 1 without a cut (none under reduced motion)
    resetCamera();
    root.classList.remove('jy-locked');
    syncViewfinder();
    scrollWindow(sectionTop());
    state.pTarget = 0;
    state.pSmooth = 0;
    state.pVel = 0;
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
      state.pVel = 0;
    }
    return true;
  }

  // ---- beats: classes on thresholds, played in time ------------------------------------
  const beatShown = { b1: null, b2: null, ui: null, composed: null, hint: null };
  function setBeat(el, key, on, past) {
    const value = on ? 'on' : past ? 'past' : 'off';
    if (beatShown[key] === value) return false;
    if (beatShown[key] === 'on' && !on) {
      // keep the line away from it while it fades out
      leaving.set(el, performance.now());
      setTimeout(() => !destroyed && measureText(), 680);
    } else if (on) {
      leaving.delete(el);
    }
    beatShown[key] = value;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-past', !on && past);
    el.setAttribute('aria-hidden', String(!on));
    // hidden blocks keep their size (the framing measures them) but take no clicks or focus
    el.inert = !on;
    return true;
  }

  /**
   * Which text is up follows the smoothed progress, the same value the
   * camera follows, so words and pictures move together. The headline block
   * shows in beat 1 and again at the end (name, subheading, live sentence and,
   * until the first drag or click, how to use it).
   */
  function updateBeats() {
    const still = state.mode === 'still';
    const p = still ? 1 : state.pSmooth;
    const composed = still || p >= P.beat2Out;
    let changed = false;
    if (beatShown.composed !== composed) {
      beatShown.composed = composed;
      root.classList.toggle('jy-composed', composed);
      changed = true;
    }
    if (composed) {
      changed = setBeat(ref.b1, 'b1', true, false) || changed;
      changed = setBeat(ref.b2, 'b2', false, true) || changed;
    } else {
      changed = setBeat(ref.b1, 'b1', p < P.h1Out, true) || changed;
      changed = setBeat(ref.b2, 'b2', p >= P.beat2In && p < P.beat2Out, p >= P.beat2Out) || changed;
    }
    const hint = composed && !still && !state.hintDismissed;
    if (beatShown.hint !== hint) {
      beatShown.hint = hint;
      // hidden, not removed: the block keeps its size, so the framing doesn't move
      ref.hint.classList.toggle('is-off', !hint);
      ref.hint.setAttribute('aria-hidden', String(!hint));
      changed = true;
    }
    // "Scroll to learn more" goes as soon as the visitor starts scrolling
    const scrolled = still || p > 0.01;
    if (root.classList.contains('jy-scrolled') !== scrolled) {
      root.classList.toggle('jy-scrolled', scrolled);
      changed = true; // the cue's line no longer hides pins
    }
    const ui = still || p >= P.ui;
    if (beatShown.ui !== ui) {
      beatShown.ui = ui;
      root.classList.toggle('jy-ui-on', ui);
      ref.time.inert = !ui || still;
      ref.corner.inert = !ui;
      ref.summary.inert = !ui || still;
      marks.inert = !ui || still;
      ref.satMarks.inert = !ui || still;
      canvas.tabIndex = ui && !still ? 0 : -1;
      if (!ui) hideCard();
      changed = true;
    }
    if (ref.again.hidden !== !state.locked) {
      ref.again.hidden = !state.locked;
      ref.tabbar.inert = !state.locked || still;
      changed = true; // the end's controls are up: where pins hide follows them
    }
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
  /** A pin at x, y would be at least partly under a control; `pad` px further out counts too. */
  const underControl = (x, y, pad) => {
    const hx = frame.pinHalf.x + pad;
    const hy = frame.pinHalf.y + pad;
    return frame.covers.some((r) => x + hx > r.left && x - hx < r.right && y + hy > r.top && y - hy < r.bottom);
  };

  /** Pins wait for the Earth: on a slow line their pictures would hold up its textures, and they show only at the end. */
  function loadPinPicture(img) {
    if (!img?.dataset.src) return;
    img.src = img.dataset.src;
    delete img.dataset.src;
  }

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
      // a dark frame has nothing to show at this size: a small dim mark, and its picture in the card
      a.classList.toggle('jy-pin-dark', !!p.dark);
      if (!p.dark) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.dataset.src = new URL(p.thumb || p.src, siteRoot).href;
        img.addEventListener('error', () => { img.hidden = true; }); // an empty pin, not a broken icon
        if (earthReady) loadPinPicture(img);
        a.appendChild(img);
      }
      const count = document.createElement('span');
      count.className = 'jy-pile-count';
      count.hidden = true;
      count.setAttribute('aria-hidden', 'true');
      marks.append(a, count);
      pins.push({ photo: p, el: a, count, x: 0, y: 0, vis: false, pile: null, lat: p.position.lat, lon: p.position.lon });
    }
    paintSelected();
  }

  function paintSelected() {
    for (const pin of pins) pin.el.classList.toggle('is-selected', pin.photo.id === state.selectedId);
  }

  const pinWorld = new THREE.Vector3();
  const corner = new THREE.Vector3();

  /**
   * The satellite's body on screen (stage px), or null. Pins under it take no
   * pointer, so a click there reaches the satellite drawn over them.
   */
  function satelliteRect(satAlpha) {
    if (!overRenderer || !satellite || !satellite.bodyBounds || satAlpha < 0.5 || !sat.ok) return null;
    if (hiddenByEarth(camera.position, sat.S, OCCLUDER_RADIUS)) return null;
    const { min, max } = satellite.bodyBounds;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
        .multiplyScalar(satScale).applyMatrix4(satellite.object3d.matrixWorld);
      const s = toScreen(corner);
      if (!s) return null;
      left = Math.min(left, s.x);
      top = Math.min(top, s.y);
      right = Math.max(right, s.x);
      bottom = Math.max(bottom, s.y);
    }
    return { left, top, right, bottom };
  }

  function updateMarks(theta, satAlpha, satLengthPx) {
    const show = beatShown.ui === true;
    const body = show ? satelliteRect(satAlpha) : null;
    for (const pin of pins) {
      let vis = false;
      if (show) {
        geoScene(pin.lat, pin.lon, 1.0, theta, pinWorld);
        if (!hiddenByEarth(camera.position, pinWorld, 0.998)) {
          const s = toScreen(pinWorld);
          if (s && s.x > -40 && s.x < W + 40 && s.y > -40 && s.y < H + 40 && !underText(s.x, s.y)) {
            // half under a control a pin is neither readable nor tappable. It stays hidden
            // until it's a little way clear, so it can't flicker at the edge as the Earth turns.
            pin.blocked = underControl(s.x, s.y, pin.blocked ? 6 : 0);
            if (!pin.blocked) {
              pin.x = s.x;
              pin.y = s.y;
              vis = true;
            }
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
      const under = !!body && pin.vis && x > body.left && x < body.right && y > body.top && y < body.bottom;
      if (pin.under !== under) {
        pin.under = under;
        pin.el.classList.toggle('is-under', under);
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
    const satOn = satAlpha > 0.5 && sat.ok && !hiddenByEarth(camera.position, sat.S, OCCLUDER_RADIUS);
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
    img.addEventListener('error', () => { img.hidden = true; }); // the place and time still say what it is
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
      previewPhoto(photo.id);
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

  /**
   * Above the pin if there is room, else under it. The top-right dock (the
   * viewfinder or the details) is drawn over the card, so the card stays clear of
   * it: when neither fits, it sits beside the pin, below the dock.
   */
  function placeCard() {
    const pin = card.pin;
    const el = ref.card;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 16 * frame.ui;
    const s = stageRect();
    const below = state.panel ? ref.panel : state.dockHidden ? null : ref.viewfinderSlot;
    const dock = union([boxOf(ref.summary, s), boxOf(below, s)]);
    const clear = (cx, cy) => !dock || cx + w <= dock.left - 8 || cy >= dock.bottom + 8;
    let x = clamp(pin.x - w / 2, 8, W - w - 8);
    let y = pin.y - h - gap;
    if (y < 8 || !clear(x, y)) y = pin.y + gap;
    if (y + h > H - 8 || !clear(x, y)) {
      const top = dock ? dock.bottom + 8 : 8;
      y = clamp(pin.y - h / 2, top, Math.max(top, H - h - 8));
      x = pin.x - w - gap >= 8 ? pin.x - w - gap : pin.x + gap;
      // too tall to fit under the dock: left of it, as far down as it goes
      if (y + h > H - 8) {
        x = dock ? Math.max(8, dock.left - w - 8) : x;
        y = Math.max(8, H - h - 8);
      }
    }
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
    // a pile: the card lists what's in it
    if (pin.pile) {
      showCard(head);
      return;
    }
    previewPhoto(pin.photo.id);
  });

  function openPhoto(pid) {
    state.selectedId = pid;
    paintSelected();
    dismissHint();
    opts.onOpenPhoto(pid);
  }

  /**
   * A pin or a card: the picture goes up in the preview, whole or not, and the visitor stays
   * here (the preview's own picture leads on to the catalogue). Without the viewfinder that's
   * the Pictures tab's dropdown, or on a phone its sheet.
   */
  function previewPhoto(pid) {
    const photo = photos.find((p) => p.id === pid);
    if (!photo) return;
    state.selectedId = pid;
    paintSelected();
    dismissHint();
    state.previewId = pid;
    if (viewfinderHere()) {
      closeCredits();
      setDockHidden(false);
      closePanel();
      viewfinder?.show(photo);
      syncViewfinder();
    } else {
      openPanel({ focus: false, tab: 'pictures' });
    }
  }

  /** What the panel's picture section shows: the one chosen on the globe, else the latest. */
  const pictured = () => (state.previewId && photos.find((p) => p.id === state.previewId)) || latest;

  // ---- the satellite's details: one state, opened by the bar's Stats tab, a phone's bottom
  // bar or the satellite itself -------------------------------------------------------------
  function setExpanded(open) {
    ref.sat.setAttribute('aria-expanded', String(open));
  }

  const viewfinderHere = () => bigQuery.matches && !ref.viewfinderSlot.hidden;

  /** Where the viewfinder shows, Pictures is it and one tab is always chosen; elsewhere they drop down. */
  function paintTabs() {
    const pictures = viewfinderHere() ? !state.panel : state.panel && state.tab === 'pictures';
    ref.tabPictures.setAttribute('aria-pressed', String(pictures));
    ref.tabStats.setAttribute('aria-pressed', String(state.panel && state.tab === 'stats'));
    ref.cycle.hidden = !webgl || !viewfinderHere();
    ref.panel.dataset.tab = state.tab;
    paintPhoneBar();
  }

  // ---- a phone's bottom bar: one thing open above it at a time, and otherwise a clear view ----
  const phoneBarButtons = { stats: 'barStats', pictures: 'barPictures', facts: 'barFacts', controls: 'barControls' };
  const phoneOpen = () => (state.panel ? state.tab : state.phoneExtra);

  function paintPhoneBar() {
    for (const [name, key] of Object.entries(phoneBarButtons)) {
      ref[key].setAttribute('aria-pressed', String(phoneOpen() === name));
    }
    root.classList.toggle('jy-phone-facts', phoneOpen() === 'facts');
    root.classList.toggle('jy-phone-controls', phoneOpen() === 'controls');
  }

  /** The facts or the controls, which aren't part of the details. */
  function setPhoneExtra(name) {
    if (state.phoneExtra === name) return;
    state.phoneExtra = name;
    paintPhoneBar();
    if (state.locked && state.shown) runTicker();
    if (name === 'facts') ticker?.reveal?.();
    measureSettled();
  }

  function choosePhoneBar(name) {
    if (phoneOpen() === name) {
      closePanel();
      setPhoneExtra(null);
    } else if (name === 'stats' || name === 'pictures') {
      state.previewId = null; // the bar means the latest picture
      openPanel({ focus: false, tab: name });
    } else {
      closePanel();
      setPhoneExtra(name);
    }
  }

  for (const [name, key] of Object.entries(phoneBarButtons)) {
    listen(ref[key], 'click', () => choosePhoneBar(name));
  }

  function openPanel({ focus = true, tab = 'stats', byCycle = false } = {}) {
    if (!byCycle) dismissHint();
    closeCredits();
    setDockHidden(false);
    state.phoneExtra = null;
    state.tab = tab;
    state.panel = true;
    resetSheetSize();
    ref.panel.hidden = false;
    root.classList.add('jy-panel-open');
    setExpanded(true);
    paintTabs();
    if (frame.narrow) setSheet(true);
    if (state.locked && state.shown) runTicker();
    requestAnimationFrame(() => ref.panel.classList.add('is-on'));
    uiDirty = true;
    paintPanel(true);
    reframe();
    syncViewfinder();
    measureSettled();
    if (focus) {
      // the bar stays right above the details; a phone's sheet has its own title
      const target = frame.narrow ? ref.panel.querySelector('.jy-panel-title') : ref.tabStats;
      target.focus({ preventScroll: true });
    }
  }

  /** The whole panel put away, down to a button to bring it back; the framing stays as it was. */
  function setDockHidden(hidden) {
    if (state.dockHidden === hidden) return;
    state.dockHidden = hidden;
    root.classList.toggle('jy-dock-hidden', hidden);
    ref.dockToggle.setAttribute('aria-expanded', String(!hidden));
    ref.dockToggle.setAttribute('aria-label', hidden ? 'Show this panel' : 'Hide this panel');
    ref.dockToggleText.textContent = hidden ? 'Show panel' : 'Hide';
    dockHiddenChoice.set(hidden);
    syncViewfinder();
    measureSettled();
  }

  /** The tabs: choose what the panel shows. Where they drop down, the chosen one folds up again. */
  function chooseTab(tab) {
    setCycle(false); // the visitor has chosen: it stays on that one
    if (viewfinderHere()) {
      if (tab === 'pictures') closePanel();
      else if (!state.panel) openPanel({ focus: false });
    } else if (state.panel && state.tab === tab) {
      closePanel();
    } else {
      state.previewId = null; // the tab means the latest picture again
      openPanel({ focus: false, tab });
    }
  }

  listen(ref.tabStats, 'click', () => chooseTab('stats'));
  listen(ref.tabPictures, 'click', () => chooseTab('pictures'));
  listen(ref.dockToggle, 'click', () => {
    if (state.dockHidden) {
      setDockHidden(false);
      // what it was showing when it was put away
      if (state.dockResume) openPanel({ focus: false, tab: state.dockResume });
    } else {
      state.dockResume = state.panel ? state.tab : null;
      closePanel();
      setDockHidden(true);
    }
  });

  /** A panel slides in: where pins hide follows where it lands, not where it starts. */
  function measureSettled() {
    setTimeout(() => !destroyed && measureText(), 280);
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
    state.previewId = null;
    state.sheetOpen = false;
    ref.panel.classList.remove('is-on', 'is-open');
    root.classList.remove('jy-panel-open');
    setExpanded(false);
    paintTabs();
    reframe();
    syncViewfinder();
    const done = () => {
      if (!state.panel) ref.panel.hidden = true;
    };
    if (motionOverride === 'reduced') done();
    else setTimeout(done, 160);
    if (restoreFocus) (frame.narrow ? ref.barStats : ref.tabStats).focus({ preventScroll: true });
  }

  function setSheet(open) {
    state.sheetOpen = open;
    ref.panel.classList.toggle('is-open', open);
    measureText();
  }

  /** A click on the satellite: the panel; a double click: fly in close. */
  function satelliteClicked(detail) {
    setCycle(false);
    if (detail >= 2) {
      zoomToSatellite();
      if (!state.panel) openPanel({ focus: false });
      return;
    }
    if (state.panel && state.tab === 'stats') closePanel();
    else openPanel();
  }

  listen(ref.sat, 'click', (e) => satelliteClicked(e.detail));
  listen(ref.close, 'click', () => closePanel({ restoreFocus: true }));
  listen(ref.follow, 'click', () => setFollow(!state.follow));
  listen(ref.followBar, 'click', () => setFollow(!state.follow));
  listen(ref.zoomSat, 'click', () => zoomToSatellite());
  listen(ref.retry, 'click', () => loadOrbit());
  // no broken icon: the message takes the frame's place, and "Open in the catalogue" stays under it
  listen(ref.latestImg, 'error', () => {
    ref.latestFrame.hidden = true;
    ref.latestFailed.hidden = false;
  });
  listen(ref.latestImg, 'load', () => {
    ref.latestFrame.hidden = false;
    ref.latestFailed.hidden = true;
    // the frame ends where the data did; the picture is anchored to its top (journey.css)
    const pic = pictured();
    if (pic) ref.latestFrame.style.aspectRatio = `${ref.latestImg.naturalWidth} / ${rowsWithData(ref.latestImg, pic)}`;
  });
  listen(ref.latestRetry, 'click', () => {
    const pic = pictured();
    if (!pic) return;
    ref.latestFailed.hidden = true;
    ref.latestFrame.hidden = false;
    const src = new URL(pic.src || pic.thumb, siteRoot).href;
    ref.latestImg.src = `${src}${src.includes('?') ? '&' : '?'}retry=${Date.now()}`;
  });
  for (const a of [ref.latestFrame, ref.latestOpen]) {
    listen(a, 'click', (e) => {
      const pic = pictured();
      if (!pic || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openPhoto(pic.id);
    });
  }

  // The phone sheet's handle: the sheet follows the finger, and on letting go it settles at
  // the nearest of its resting heights, going by where a flick was heading. Below the
  // shortest it folds away; a tap goes between that and open.
  const SHEET_OPEN_SHARE = 0.72; // of the stage, as a new sheet's max-height in journey.css
  const SHEET_FLICK_MS = 160; // a flick counts for where it would have got to in this long
  let sheetDrag = null;

  /** The heights it rests at: the peek (down to its first lines), open, and as tall as it goes. */
  function sheetRests() {
    const box = ref.panel.getBoundingClientRect();
    const firstLines = state.tab === 'pictures' ? ref.latestTitle : ref.over;
    // short of the next line, which would show cut in half
    const peek = Math.round(firstLines.getBoundingClientRect().bottom - box.top + ref.panel.scrollTop + 8);
    const whole = ref.panel.scrollHeight;
    const nav = parseFloat(getComputedStyle(root).getPropertyValue('--jy-nav')) || 0;
    const full = Math.round(Math.min(whole, box.bottom - stageRect().top - nav));
    const open = Math.round(Math.min(full, H * SHEET_OPEN_SHARE));
    return { peek: Math.min(peek, open), open, full };
  }

  function resetSheetSize() {
    ref.panel.style.height = '';
    ref.panel.classList.remove('is-sized', 'is-dragging');
  }

  function restSheet(height) {
    ref.panel.style.height = `${height}px`;
    measureSettled();
  }

  function nearestRest(height, rests) {
    return [rests.peek, rests.open, rests.full].reduce((best, h) => (Math.abs(h - height) < Math.abs(best - height) ? h : best));
  }

  listen(ref.grab, 'pointerdown', (e) => {
    const start = ref.panel.getBoundingClientRect().height;
    const rests = sheetRests();
    sheetDrag = { y0: e.clientY, y: e.clientY, at: e.timeStamp, start, rests, speed: 0, moved: false };
    ref.grab.setPointerCapture?.(e.pointerId);
    // from its natural height to a set one, with nothing to animate yet
    ref.panel.classList.add('is-sized', 'is-dragging');
    ref.panel.style.height = `${start}px`;
  });
  listen(ref.grab, 'pointermove', (e) => {
    const d = sheetDrag;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (Math.abs(dy) > 4) d.moved = true;
    const dt = e.timeStamp - d.at;
    if (dt > 0) d.speed = d.speed * 0.3 + ((e.clientY - d.y) / dt) * 0.7;
    d.y = e.clientY;
    d.at = e.timeStamp;
    if (!d.moved) return;
    // past its full height it gives only a little, and comes back
    let height = d.start - dy;
    if (height > d.rests.full) height = d.rests.full + (height - d.rests.full) * 0.25;
    ref.panel.style.height = `${Math.max(0, height)}px`;
  });
  listen(ref.grab, 'pointerup', (e) => {
    const d = sheetDrag;
    if (!d) return;
    sheetDrag = null;
    ref.panel.classList.remove('is-dragging');
    const now = ref.panel.getBoundingClientRect().height;
    if (!d.moved) {
      restSheet(now > d.rests.peek + 1 ? d.rests.peek : d.rests.open);
      return;
    }
    // a finger that has come to rest isn't flicking
    const aimed = now - (e.timeStamp - d.at > 80 ? 0 : d.speed) * SHEET_FLICK_MS;
    if (aimed < d.rests.peek * 0.7) closePanel();
    else restSheet(nearestRest(aimed, d.rests));
  });
  listen(ref.grab, 'pointercancel', () => {
    const d = sheetDrag;
    if (!d) return;
    sheetDrag = null;
    ref.panel.classList.remove('is-dragging');
    restSheet(nearestRest(ref.panel.getBoundingClientRect().height, d.rests));
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
    syncViewfinder();
    measureSettled();
    ref.credits.querySelector('.jy-panel-title').focus({ preventScroll: true });
  }
  function closeCredits({ restoreFocus = false } = {}) {
    if (!state.creditsOpen) return;
    state.creditsOpen = false;
    ref.credits.classList.remove('is-on');
    ref.credits.hidden = true;
    root.classList.remove('jy-credits-open');
    syncViewfinder();
    measureText();
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
  /** Set a node's text if it differs; true when it changed. */
  const put = (node, text) => {
    if (shownText.get(node) === text) return false;
    node.textContent = text;
    shownText.set(node, text);
    return true;
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
        for (const k of ['fAlt', 'fSpeed', 'fPos', 'fSun', 'fPass', 'fRev']) put(ref[k], '\u2014');
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
      const place = placeNow(s);
      put(ref.over, place ? `Over ${place}` : `Over ${fmtLatShort(s.latDeg)}, ${fmtLonShort(s.lonDeg)}`);
      put(ref.fAlt, `${Math.round(s.altKm)} km`);
      put(ref.fSpeed, `${s.speedKmS.toFixed(2)} km/s`);
      put(ref.fPos, `${fmtLat(s.latDeg)}, ${fmtLon(s.lonDeg)}`);
      const light = satelliteLight(s.eci, sunPosition(ms));
      put(ref.fSun, light === 'sunlit' ? 'In sunlight' : light === 'shadow' ? 'In the Earth\u2019s shadow' : 'At the edge of the Earth\u2019s shadow');
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
      put(ref.fRev, rev === null ? '\u2014' : grouped(rev));
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
    paintAurora();
    paintLatest();
  }

  function paintLatest() {
    // where the viewfinder shows, it already is the preview
    const pic = pictured();
    ref.latest.hidden = !pic || (bigQuery.matches && !ref.viewfinderSlot.hidden);
    if (ref.latest.hidden) return;
    if (ref.latest.dataset.id !== pic.id) {
      ref.latest.dataset.id = pic.id;
      const href = opts.photoHref(pic.id);
      ref.latestFrame.href = href;
      ref.latestOpen.href = href;
      const ratio = pic.width && pic.height ? pic.width / pic.height : 4 / 3;
      ref.latestFrame.style.aspectRatio = String(ratio);
      ref.latestFrame.hidden = false;
      ref.latestFailed.hidden = true;
      ref.latestImg.src = new URL(pic.src || pic.thumb, siteRoot).href;
      const place = placeOf(pic);
      ref.latestImg.alt = place ? `Picture over ${place}` : 'The latest picture';
      ref.latestTitle.textContent = pic === latest ? 'Latest picture' : 'Selected picture';
      put(ref.latestPlace, place || photoTime(pic));
      put(ref.latestTime, place ? photoTime(pic) : '');
      const status = statusLine(pic);
      put(ref.latestStatus, status);
      ref.latestStatus.hidden = !status;
    }
  }

  /**
   * Place names are the Orbit page's (placeAt), from country outlines that load
   * once the Earth is up. Until then the words say it's still working rather than
   * name a continent and correct it a moment later; on a line so slow that the
   * outlines take a long time, the coarse name is better than nothing after 2 s.
   */
  let placeNamesReady = false;
  const placeNamesArrived = () => {
    placeNamesReady = true;
    uiDirty = true;
  };
  const placeNamesWait = setTimeout(placeNamesArrived, 2000);
  function loadPlaceNames() {
    loadCountries().then(() => {
      clearTimeout(placeNamesWait);
      placeNamesArrived();
    });
  }
  /** "the United States", "the North Pacific Ocean", or null where nothing has a name. */
  const placeNow = (s) => placeInSentence(placeAt(s.latDeg, s.lonDeg));

  /** The bar's words after the name: "Currently Over Burkina Faso, Altitude : 501 km". */
  function summaryWhere() {
    const s = sat.state;
    if (!s) return orbitStatus === 'failed' ? 'position unavailable' : '';
    if (!placeNamesReady) return '';
    return `Currently Over ${placeNow(s) || `${fmtLatShort(s.latDeg)}, ${fmtLonShort(s.lonDeg)}`}, Altitude : ${Math.round(s.altKm)} km`;
  }

  /** The live sentence's first half, which stays when the end view is short of room. */
  function liveWhere() {
    const s = sat.state;
    if (!s) {
      return orbitStatus === 'failed'
        ? 'Its position can\u2019t be worked out right now: the orbital elements didn\u2019t load.'
        : 'Working out where it is right now.';
    }
    if (!placeNamesReady) return 'Working out where it is right now.';
    const when = state.live ? 'Right now' : `At ${calgaryTime(state.simMs).time} in Calgary`;
    const alt = Math.round(s.altKm);
    const place = placeNow(s);
    return place
      ? `${when} it\u2019s over ${place}, ${alt} km up.`
      : `${when} it\u2019s ${alt} km above ${fmtLatShort(s.latDeg)}, ${fmtLonShort(s.lonDeg)}.`;
  }

  function liveMore() {
    if (!sat.state || !placeNamesReady) return '';
    const period = Math.round(orbit.periodMinutes(state.simMs));
    return `It completes one orbit of the Earth every ${period} minutes, on a near-polar path.`;
  }

  function hintText() {
    // on touch, before the end locks, vertical swipes still scroll the page
    return touchQuery.matches && !state.locked ? 'Drag sideways to look around.' : 'Drag to look around.';
  }

  // on a big screen the latest picture is already up in the viewfinder, and the satellite opens its details
  /** What to do with the satellite, or why the Earth is still; nothing if there is no satellite to press. */
  function satTipText() {
    if (!webgl) return 'This browser can’t draw the 3D globe, so the Earth here is a still picture.';
    if (orbitStatus === 'failed') return '';
    return `${touchQuery.matches ? 'Tap' : 'Click'} on the satellite to see where it is now!`;
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
    ref.now.title = now ? 'Showing now' : 'Live time, 1\u00d7, following the satellite';
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
      const where = liveWhere();
      const more = liveMore();
      const a = put(ref.b2t, more ? `${where} ${more}` : where);
      const b = put(ref.liveLead, where);
      const c = put(ref.liveMore, more);
      const d = put(ref.hintText, hintText());
      const tip = satTipText();
      const e = put(ref.satTip, tip);
      ref.tip.hidden = !tip;
      // the words moved: where pins hide follows them
      if (a || b || c || d || e) measureText();
      put(ref.summaryWhere, summaryWhere());
      put(ref.followBar, state.follow ? 'Following' : 'Follow');
      ref.followBar.setAttribute('aria-pressed', String(state.follow));
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

  for (const a of [ref.all, ref.latestAll]) {
    listen(a, 'click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      opts.onOpenCatalogue();
    });
    a.href = opts.catalogueHref;
  }
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

  listen(ref.aurora, 'click', () => {
    if (!aurora) return;
    aurora.setOn(!aurora.on);
    auroraHiddenChoice.set(!aurora.on);
    needsFrame = true;
    paintAurora();
  });
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

  // ---- the Sun and the Moon say what they are, under a resting mouse or for a moment after a tap ----
  const skyPoint = new THREE.Vector3();
  let skyPointer = null; // where to look, on the stage
  let skyTapUntil = 0;

  function stagePoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The Sun or the Moon at a point on the stage, unless the Earth is in front of it. */
  function skyBodyAt({ x, y }) {
    if (!sky?.bodies || !interactive()) return null;
    const eye = camera.position;
    for (const body of sky.bodies(camera)) {
      const along = eye.dot(body.dir);
      if (along < 0 && along * along - eye.lengthSq() + OCCLUDER_RADIUS ** 2 > 0) continue;
      const at = toScreen(skyPoint.copy(eye).addScaledVector(body.dir, 10));
      if (!at) continue;
      const radius = (Math.tan(body.angRadius) * H) / (2 * frame.tanHalf);
      if (Math.hypot(x - at.x, y - at.y) <= Math.max(14, radius + 6)) return { name: body.name, x: at.x, y: at.y, radius };
    }
    return null;
  }

  function paintSkyLabel() {
    if (skyTapUntil && performance.now() > skyTapUntil) {
      skyTapUntil = 0;
      skyPointer = null;
    }
    const body = skyPointer && skyBodyAt(skyPointer);
    ref.skyLabel.classList.toggle('is-on', Boolean(body));
    if (!body) return;
    ref.skyLabel.textContent = body.name;
    // beside it, as the satellite's label, and on the other side at the edge of the stage
    const clear = Math.max(10, body.radius + 10);
    const left = body.x + clear + 48 <= W;
    const x = left ? body.x + clear : body.x - clear;
    ref.skyLabel.style.transform = `translate(${Math.round(x)}px, ${Math.round(body.y)}px) translate(${left ? 0 : -100}%, -50%)`;
  }

  listen(canvas, 'pointerleave', () => {
    if (!skyTapUntil) skyPointer = null;
  });

  const dragClass = (on) => document.documentElement.classList.toggle('jy-dragging', on);
  listen(canvas, 'pointerdown', (e) => {
    skyPointer = null;
    skyTapUntil = 0;
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
    if (e.pointerType === 'mouse' && !pointers.size) skyPointer = stagePoint(e);
    const p = pointers.get(e.pointerId);
    if (!p || p.pageSwipe) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!dragged && Math.hypot(p.x - p.x0, p.y - p.y0) > 4) {
      // through the story a finger going up or down is scrolling the page (touch-action:
      // pan-y), and the browser will soon take it over: it never was a drag on the globe
      if (e.pointerType !== 'mouse' && !state.locked && Math.abs(p.y - p.y0) >= Math.abs(p.x - p.x0)) {
        p.pageSwipe = true;
        return;
      }
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
    const pageSwipe = pointers.get(e.pointerId)?.pageSwipe;
    if (!pointers.delete(e.pointerId)) return;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch { /* never captured */ }
    if (pointers.size < 2) pinch = null;
    if (e.type === 'pointerup' && !dragged && !pageSwipe && pointers.size === 0) {
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
        setPhoneExtra(null);
        // no hover on touch: a tap on the Sun or the Moon names it for a moment
        if (e.pointerType !== 'mouse' && skyBodyAt(stagePoint(e))) {
          skyPointer = stagePoint(e);
          skyTapUntil = performance.now() + 2500;
        }
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
    const overGlobe = e.target === canvas || (marks.contains(e.target) && e.target !== marks)
      || (ref.satMarks.contains(e.target) && e.target !== ref.satMarks);
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
    } else if (state.phoneExtra) {
      setPhoneExtra(null);
      e.preventDefault();
    }
  });

  // ---- the frame loop -------------------------------------------------------------------
  let raf = 0;
  let lastNow = performance.now();
  let lastPerf = performance.now();
  let lastDraw = -Infinity;
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

    // progress: the scroll position, smoothed so wheel notches glide (see SCROLL_SPRING)
    readScroll();
    if (state.mode === 'story') {
      smoothProgress(dt);
      // back above the swing's end the story has the camera again
      if (state.pSmooth < P.swingEnd && (state.custom || !state.follow)) {
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
      || Math.abs(state.pTarget - state.pSmooth) > 1e-4 || state.pVel !== 0 || state.dist !== state.distTarget || state.cdist !== state.cdistTarget;
    if (!busy && now - lastDraw < 33) return;
    lastDraw = now;
    needsFrame = false;

    const sun = sunPosition(ms);
    if (sky) sky.setTime(ms, theta);
    if (earth) earth.setTime(theta, sun, ms);

    // orbit line points (and, now and then, whether the default heading still clears the text)
    if (now - trackAt > (state.speed === 1 ? 250 : 0) || Math.abs(ms - trackSimAt) > 20_000) {
      rebuildTrack(ms);
      trackAt = now;
    }

    computeCamera(now, theta);
    if (sky) sky.update(camera);
    if (earth) earth.update(dt, camera);
    aurora?.update(ms, sun, theta, now, camera);

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
      // drawn larger than life by one fixed amount (frame.satPx long at the end view), so
      // zooming either way changes its size like a real object; far out it stops at
      // SAT_MIN_PX, where it would otherwise be lost
      const distance = Math.max(1e-6, camera.position.distanceTo(sat.S));
      lengthPx = Math.max(SAT_MIN_PX * frame.ui, (frame.satPx * zoomLimits().def) / distance);
      const unitsPerPx = (2 * frame.tanHalf * distance) / H;
      const length = satellite.bodyBounds ? satellite.bodyBounds.max.z - satellite.bodyBounds.min.z : 0.34;
      satScale = (lengthPx * unitsPerPx) / Math.max(0.05, length);
      satellite.setScale(satScale);
      setSatOpacity(satAlpha);
      // the Sun on it, unless the Earth is in the way; earthshine from below
      sunDir.set(sun.x, sun.z, -sun.y).normalize();
      const s = sat.state;
      const light = s ? satelliteLight(s.eci, sun) : 'sunlit';
      sunLight.intensity = light === 'sunlit' ? 3.2 : light === 'terminator' ? 1.6 : SAT_SHADOW_FILL;
      sunLight.position.copy(sat.S);
      // in the Earth's shadow there is no Sun to place: a dim light from the viewer's side
      // keeps its shape findable while the line says to click it, plainly dimmer than daylight
      if (light === 'shadow') sunLight.position.add(tmpA.copy(camera.position).sub(sat.S).normalize().multiplyScalar(5));
      else sunLight.position.addScaledVector(sunDir, 5);
      sunLight.target.position.copy(sat.S);
      ambient.intensity = light === 'shadow' ? SAT_SHADOW_AMBIENT : 0.05;
      if (s && satellite.setEarthshine) {
        const ground = sunElevationDeg(s.latDeg, s.lonDeg, ms);
        satellite.setEarthshine(lerp(0.9, 1, smoothstep(-8, 4, ground)));
      }
    }

    orbitLine.setOpacity(satAlpha);
    if (satAlpha > 0.002) orbitLine.update(camera, W, H);

    renderer.render(scene, camera);
    overRenderer?.render(overScene, camera);
    updateMarks(theta, satAlpha, lengthPx);
    paintSkyLabel();
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
      state.pVel = 0;
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
      cycle: cycleOn,
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
    if (typeof s.cycle === 'boolean') setCycle(s.cycle);
    if (state.locked && s.locked === false) {
      // a state from mid-story: open the story up again
      state.locked = false;
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
      placeName: s && placeNamesReady ? placeNow(s) : null,
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
          // the facts slide and fade even when the system prefers reduced
          // motion (the site's choice); ?motion=reduced still keeps them still
          ticker = mod.createFactTicker(ref.factsSlot, {
            facts,
            live,
            reducedMotion: motionOverride === 'reduced',
            onHide: () => {
              setFactsHidden(true);
              ref.factsShow.focus({ preventScroll: true });
            },
          });
          placeFacts();
        }
        if (typeof mod.createNewsList === 'function') newsList = mod.createNewsList(ref.newsSlot, { news });
        if (state.locked && state.shown) runTicker();
      } catch {
        // no facts module (yet): nothing to show
      }
    })();
    return tickerLoading;
  }

  /** Rotating only while it can be seen: put away, it waits (in the details it can't be put away). */
  function runTicker() {
    const away = frame.narrow ? state.phoneExtra !== 'facts' : state.factsHidden && frame.fit < FIT_NO_FACTS;
    if (away) ticker?.stop?.();
    else ticker?.start?.();
  }

  function setFactsHidden(hidden) {
    if (state.factsHidden === hidden) return;
    state.factsHidden = hidden;
    root.classList.toggle('jy-facts-hidden', hidden);
    factsHiddenChoice.set(hidden);
    placeFacts();
    if (state.locked && state.shown) runTicker();
    measureSettled();
  }

  listen(ref.factsShow, 'click', () => {
    setFactsHidden(false);
    ticker?.reveal?.();
    ticker?.hideButton?.focus({ preventScroll: true });
  });

  /** The ticker runs only at the end of the story. */
  function startTicker() {
    if (!webgl) return;
    loadTicker();
    runTicker();
    syncViewfinder();
  }
  function stopTicker() {
    ticker?.stop?.();
    syncViewfinder();
  }

  // ---- the picture viewfinder (site/explore/viewfinder.js, if it is there) --------------------
  let viewfinder = null;
  let viewfinderLoading = null;

  function loadViewfinder() {
    if (viewfinderLoading) return;
    viewfinderLoading = (async () => {
      try {
        const mod = await import('./viewfinder.js');
        const href = new URL('viewfinder.css', MODULE_BASE).href;
        if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) {
          // the styles first, so the frame never shows unstyled
          await new Promise((done) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = link.onerror = done;
            document.head.appendChild(link);
          });
        }
        if (destroyed) return;
        viewfinder = mod.createViewfinder(ref.viewfinderSlot, {
          photos,
          siteRoot: siteRoot.href,
          photoHref: opts.photoHref,
          onOpen: openPhoto,
          // as the facts: it moves even when the system prefers reduced motion
          // (the site's choice); ?motion=reduced still keeps it still
          reducedMotion: motionOverride === 'reduced',
          takeTurn: () => {
            if (cycleOn) openPanel({ focus: false, byCycle: true });
            return cycleOn;
          },
        });
        // a pin clicked while it was still on its way
        if (state.previewId) viewfinder.show(photos.find((p) => p.id === state.previewId));
        syncViewfinder();
      } catch {
        // no viewfinder module (yet): the sky stays empty
      }
    })();
  }

  /** It runs at the end of the story, on big screens, unless the panel is put away or the details or the credits have taken its place. */
  function syncViewfinder() {
    const on = webgl && state.locked && state.shown && !state.panel && !state.creditsOpen && !state.dockHidden && bigQuery.matches;
    if (on) loadViewfinder();
    if (on) viewfinder?.start();
    else viewfinder?.stop();
    syncCycle();
  }

  // ---- Stats and Pictures in turn, where they share a place -------------------------------
  // Pictures' turn ends when the viewfinder asks (takeTurn), so whatever holds its rotation up
  // holds this up too: the pointer on it, a picture chosen on the globe, a hidden tab.
  let cycleOn = !cycleOffChoice.get() && motionOverride !== 'reduced';
  let cycleTimer = 0;
  let cycleHover = false;
  let cycleFocus = false; // keyboard focus, as in the viewfinder: a mouse click doesn't hold it forever

  function setCycle(on, { remember = false } = {}) {
    cycleOn = on;
    ref.cycle.setAttribute('aria-pressed', String(on));
    if (remember) cycleOffChoice.set(!on);
    syncCycle();
  }

  /** Stats' turn: it runs while Stats is up and nobody is reading it. */
  function syncCycle() {
    clearTimeout(cycleTimer);
    const statsUp = state.locked && state.shown && state.panel && state.tab === 'stats' && !state.creditsOpen && !state.dockHidden;
    if (!cycleOn || !statsUp || cycleHover || cycleFocus || document.hidden || !viewfinderHere()) return;
    cycleTimer = setTimeout(() => {
      closePanel();
      viewfinder?.next();
    }, CYCLE_STATS_MS);
  }

  listen(ref.cycle, 'click', () => setCycle(!cycleOn, { remember: true }));
  listen(ref.panel, 'pointerenter', () => {
    cycleHover = true;
    syncCycle();
  });
  listen(ref.panel, 'pointerleave', () => {
    cycleHover = false;
    syncCycle();
  });
  listen(ref.panel, 'focusin', (e) => {
    try {
      cycleFocus = e.target.matches(':focus-visible');
    } catch {
      cycleFocus = true; // older browsers: treat as keyboard focus
    }
    syncCycle();
  });
  listen(ref.panel, 'focusout', (e) => {
    if (e.relatedTarget && ref.panel.contains(e.relatedTarget)) return;
    cycleFocus = false;
    syncCycle();
  });
  listen(document, 'visibilitychange', syncCycle);

  // ---- photos ---------------------------------------------------------------------------
  function setPhotos(list) {
    photos = Array.isArray(list) ? list.filter((p) => p && p.id) : [];
    // the newest nearly whole picture, the one the viewfinder opens on
    const shown = photos.filter(isNearlyWhole);
    latest = (shown.length ? shown : photos).reduce((best, p) => (!best || (p.sortTime || 0) > (best.sortTime || 0) ? p : best), null);
    ref.latest.dataset.id = '';
    const n = photos.length;
    ref.allText.textContent = n ? `See all ${grouped(n)} pictures` : 'See the pictures';
    ref.latestAll.textContent = ref.allText.textContent;
    ref.viewfinderSlot.hidden = !photos.some(isNearlyWhole);
    paintTabs();
    viewfinder?.setPhotos(photos);
    if (webgl) buildPins();
    uiDirty = true;
  }

  // ---- wiring ----------------------------------------------------------------------------
  // as the visitor last left them
  setDockHidden(dockHiddenChoice.get());
  setFactsHidden(factsHiddenChoice.get());
  setCycle(cycleOn);
  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(stage);
  // the text blocks set where the Earth may go
  const textObserver = new ResizeObserver(() => {
    computeFrame();
    needsFrame = true;
  });
  textObserver.observe(ref.b1);
  textObserver.observe(ref.b2);
  textObserver.observe(ref.factsSlot); // the banner fills in after the facts load
  textObserver.observe(ref.viewfinderSlot); // it appears once there are pictures, on big screens
  // the words re-wrap when the real fonts arrive, perhaps much later: fit the end view afresh
  const fontsArrived = () => {
    if (destroyed) return;
    frame.fitSize = '';
    resize();
  };
  document.fonts?.ready?.then(fontsArrived);
  if (document.fonts) listen(document.fonts, 'loadingdone', fontsArrived);

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
  listen(bigQuery, 'change', () => {
    // the Pictures tab's dropdown has no place where the viewfinder is back
    if (viewfinderHere() && state.panel && state.tab === 'pictures') closePanel();
    paintTabs();
    uiDirty = true;
    syncViewfinder();
  });

  // ---- start ------------------------------------------------------------------------------
  loadOrbit();
  setPhotos(opts.photos);
  applyMode();
  resetCamera();
  updateSatellite(state.simMs, gmstAt(state.simMs));
  paintText(performance.now());
  // a reload is the visitor asking to start again, and a new tab has no flag
  if (performance.getEntriesByType?.('navigation')[0]?.type === 'reload') storyFinished.set(false);
  if (opts.initialState && applyState(opts.initialState)) {
    restoreScroll();
  } else if (state.mode === 'story' && storyFinished.get()) {
    // finished earlier in this tab: back at the end, with no story to scroll through again
    lock({ landing: true });
  } else {
    // a fresh page always opens on beat 1, the Earth alone, whatever the motion setting
    startAtBeginning();
  }
  loadTicker();
  syncLoop();
  settleInstant();

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
      if (state.locked) runTicker();
      syncViewfinder();
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
      root.classList.toggle('jy-calm', motionOverride === 'reduced');
      applyMode();
      readScroll();
    },
    /** For checking from the console; not an API. */
    get debug() {
      return {
        state, frame, sat, camera, scene, orbitLine, trackN, W, H, quality, earth, aurora, satellite, sky, zoomLimits, swingAngle,
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
      clearTimeout(cycleTimer);
      for (const off of cleanups) off();
      ticker?.dispose?.();
      newsList?.dispose?.();
      viewfinder?.dispose();
      document.documentElement.classList.remove('jy-dragging');
      aurora?.dispose();
      earth?.dispose();
      satellite?.dispose();
      orbitLine.dispose();
      sky?.dispose();
      occluder.geometry.dispose();
      occluder.material.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss?.();
      overRenderer?.dispose();
      overRenderer?.forceContextLoss?.();
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
