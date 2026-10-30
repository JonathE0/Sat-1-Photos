/**
 * The "Preview picture" dialog: the simulated frame from shotpreview.js at
 * its natural size or smaller, the time, the place under the camera, the Sun,
 * and plainly what the frame assumes.
 *
 *   const panel = createShotPanel({ getOrbit: () => orbit });
 *   root.append(panel.element);
 *   panel.open({ ms, context: 'At its nearest to the middle of Japan.' });
 *
 * A native modal dialog: it holds the focus, Esc closes it and the focus goes
 * back to whatever opened it.
 */
import { DEG, groundLight, sunElevationDeg } from './astro.js';
import { loadCountries, placeAt } from '../explore/journey-region.js';
import { cameraAt, footprintKm, POINTING_SPREAD_DEG, POINTING_WORST_DEG } from './shotcamera.js';
import { calgaryWhen, elementsNote } from './timepick.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "22 Oct 2026, 15:07:59 UTC" */
function utcWhen(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

/** "Daylight below, sun 34° up" */
function fmtSun(el) {
  const light = groundLight(el);
  const word = light === 'day' ? 'Daylight' : light === 'twilight' ? 'Twilight' : 'Night';
  return `${word} below, sun ${Math.round(Math.abs(el))}° ${el >= 0 ? 'up' : 'below the horizon'}`;
}

/** The ground that a degree of tilt moves the picture by at this height, roughly. */
const tiltKm = (deg, altKm) => Math.round((altKm * Math.tan(deg * DEG)) / 10) * 10;

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3"/></svg>';

let uid = 0;

/** @param {{ getOrbit: () => object|null }} o  getOrbit gives the astro.Orbit, or null while loading */
export function createShotPanel({ getOrbit }) {
  const n = ++uid;
  const dialog = document.createElement('dialog');
  dialog.className = 'cg-shot';
  dialog.setAttribute('aria-labelledby', `cg-shot-title-${n}`);
  dialog.innerHTML = `
    <div class="cg-shot-inner">
      <div class="cg-shot-head">
        <h2 class="cg-shot-title" id="cg-shot-title-${n}">Preview picture</h2>
        <button type="button" class="cg-icon-btn cg-shot-close" aria-label="Close">${CLOSE_ICON}</button>
      </div>
      <div class="cg-shot-body">
        <div class="cg-shot-picture">
          <div class="cg-shot-frame"><p class="cg-shot-status" aria-live="polite"></p></div>
          <div class="cg-shot-sky" role="group" aria-label="Sky">
            <button type="button" class="cg-btn" data-sky="clear" aria-pressed="true">Clear sky</button>
            <button type="button" class="cg-btn" data-sky="cloudy" aria-pressed="false">With sample clouds</button>
          </div>
        </div>
        <div class="cg-shot-facts">
          <p class="cg-shot-context" hidden></p>
          <dl class="cg-shot-list">
            <div><dt>Time</dt><dd data-shot="calgary"></dd><dd class="cg-shot-sub" data-shot="utc"></dd></div>
            <div><dt>Under the camera</dt><dd data-shot="place"></dd><dd class="cg-shot-sub" data-shot="where"></dd></div>
            <div><dt>Sun</dt><dd data-shot="sun"></dd></div>
            <div data-shot="coverRow"><dt>The frame covers</dt><dd data-shot="cover"></dd></div>
          </dl>
          <div class="cg-shot-notes">
            <p>Simulated, not a photograph: NASA's maps of the ground and its city lights, lit for this moment.</p>
            <p data-shot="skyNote"></p>
            <p data-shot="pointing"></p>
            <p data-shot="boom" hidden>The thin line at lower left is the satellite's own boom, which is in its sunlit pictures.</p>
            <p class="cg-shot-far" data-shot="far" hidden></p>
          </div>
        </div>
      </div>
    </div>
  `;
  const $ = (s) => dialog.querySelector(s);
  const f = (name) => $(`[data-shot="${name}"]`);
  const frame = $('.cg-shot-frame');
  const status = $('.cg-shot-status');
  const skyButtons = [...dialog.querySelectorAll('[data-sky]')];

  let token = 0; // the latest request; older renders are dropped when they land
  let shots = null;
  let sky = 'clear';
  let title = '';

  function setSky(next) {
    sky = next;
    for (const b of skyButtons) b.setAttribute('aria-pressed', String(b.dataset.sky === sky));
    f('skyNote').textContent = sky === 'clear'
      ? 'Clear sky, because clouds can\'t be forecast. Most of its real pictures have some.'
      : 'The clouds are from one sample day of NASA\'s cloud map, not a forecast.';
    if (!shots) return;
    const canvas = shots[sky];
    canvas.className = 'cg-shot-canvas';
    canvas.setAttribute('role', 'img');
    labelFrame();
    frame.replaceChildren(canvas, status);
  }

  function labelFrame() {
    shots?.[sky].setAttribute('aria-label', `${title}, ${sky === 'clear' ? 'clear sky' : 'with sample clouds'}.`);
  }

  function paintFacts(ms, state, context) {
    const context_ = $('.cg-shot-context');
    context_.hidden = !context;
    context_.textContent = context || '';
    f('calgary').textContent = calgaryWhen(ms);
    f('utc').textContent = utcWhen(ms);
    const paintPlace = () => {
      const place = placeAt(state.latDeg, state.lonDeg);
      f('place').textContent = place ? `Over ${place}` : 'Not over a named place';
      title = `Simulated picture from CTS-SAT-1${place ? ` over ${place}` : ''}, ${utcWhen(ms)}`;
      labelFrame();
    };
    paintPlace();
    loadCountries().then(() => {
      if (mineIs(ms)) paintPlace();
    });
    f('where').textContent = `${fmtLat(state.latDeg)}, ${fmtLon(state.lonDeg)}, ${Math.round(state.altKm)} km up`;
    f('sun').textContent = fmtSun(sunElevationDeg(state.latDeg, state.lonDeg, ms));
    const cover = footprintKm(cameraAt(state));
    f('coverRow').hidden = !cover;
    if (cover) f('cover').textContent = `About ${Math.round(cover.widthKm / 10) * 10} by ${Math.round(cover.heightKm / 10) * 10} km`;
    f('pointing').textContent =
      'Assumes the camera looks straight down, with the right of the picture along the direction of travel. ' +
      `Approximate: in its October pictures the camera's pointing varied by up to ${POINTING_SPREAD_DEG}°, ` +
      `about ${tiltKm(POINTING_SPREAD_DEG, state.altKm)} km on the ground, ` +
      `and in August by up to ${POINTING_WORST_DEG}°, with the horizon in view. Sun glare isn't drawn.`;
    const note = elementsNote(ms, getOrbit());
    const far = f('far');
    far.hidden = note.level !== 'far';
    far.textContent = note.level === 'far' ? note.text : '';
  }

  let shownMs = null;
  const mineIs = (ms) => dialog.open && shownMs === ms;

  /** Show the frame for a moment. `context` is one line saying why this moment. */
  async function open({ ms, context = '' }) {
    const orbit = getOrbit();
    const state = orbit?.stateAt(ms);
    if (!state) return;
    const mine = ++token;
    shownMs = ms;
    shots = null;
    sky = 'clear';
    frame.replaceChildren(status);
    status.textContent = 'Drawing the frame.';
    status.hidden = false;
    setSky('clear');
    paintFacts(ms, state, context);
    f('boom').hidden = true;
    if (!dialog.open) dialog.showModal();
    try {
      const { renderShot } = await import('./shotpreview.js');
      const shot = await renderShot({ ms, orbit });
      if (mine !== token || !dialog.open) return;
      shots = shot;
      status.hidden = true;
      status.textContent = '';
      f('boom').hidden = !shot.boom;
      setSky(sky);
    } catch (err) {
      if (mine !== token) return;
      console.warn('Preview picture failed', err);
      status.textContent = 'This browser couldn\'t draw the frame: it needs WebGL. The details alongside still hold.';
    }
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  // the page's own shortcuts stay out of it while it is open; Esc still closes it
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('close', () => {
    // browsers deliver this a frame late: by then it may have been opened again
    if (dialog.open) return;
    token += 1;
    shots = null;
  });
  // a press on the backdrop lands on the dialog itself; the content is all inside .cg-shot-inner
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target === dialog) close();
  });
  $('.cg-shot-close').addEventListener('click', close);
  for (const b of skyButtons) b.addEventListener('click', () => setSky(b.dataset.sky));

  return {
    element: dialog,
    open,
    close,
    get isOpen() {
      return dialog.open;
    },
    destroy() {
      close();
      dialog.remove();
    },
  };
}
