/**
 * "Passes over another place" for the orbit page: type a country, sea or
 * continent, pick it from a short list, and see the next three times
 * CTS-SAT-1's ground track crosses it after the time showing, with the best
 * chance of a picture marked and why. It lives in the Passes panel; globe.js
 * swaps the Calgary list for it while a place is chosen.
 *
 *   const search = createPlaceSearch({ getOrbit, getTime, onJump, onPlace });
 *   panel.append(search.element);
 *   search.tick(ms);   // a few times a second, from the page's clock
 */
import { findPlaces, getPlace, loadCountries } from '../explore/journey-region.js';
import { FAR_DAYS } from './timepick.js';
import { bestPass, findRegionPassesAsync, fmtKm, SEARCH_DAYS } from './regionpasses.js';

const DAY_MS = 86_400_000;
const LOCAL_ZONE = 'America/Edmonton';
const SHOWN = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

const localDay = new Intl.DateTimeFormat('en-GB', { timeZone: LOCAL_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
// en-US for the zone: en-GB names Calgary's "GMT-6" rather than "MDT"
const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

/** "Fri 31 Oct, 18:36 MDT" */
function calgary(ms) {
  const p = {};
  for (const part of localClock.formatToParts(ms)) p[part.type] = part.value;
  return `${localDay.format(ms).replace(',', '')}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "1 Nov, 00:36 UTC" */
function utc(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "45 s", "4 min", "1 h 12 min" */
function span(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "Daylight, sun 34° up", "Night, sun 66° below the horizon" */
function light(p) {
  const word = p.light === 'day' ? 'Daylight' : p.light === 'twilight' ? 'Twilight' : 'Night';
  const sun = Math.round(Math.abs(p.sunElevationDeg));
  return `${word} below, sun ${sun}° ${p.sunElevationDeg >= 0 ? 'up' : 'below the horizon'}`;
}

let uid = 0;

/**
 * @param {object} o
 * @param {() => object|null} o.getOrbit   the astro.Orbit, or null while loading
 * @param {() => number} o.getTime         the time showing, ms
 * @param {(pass: object) => void} o.onJump        show this pass
 * @param {(place: object|null) => void} o.onPlace a place was chosen, or cleared
 */
export function createPlaceSearch({ getOrbit, getTime, onJump, onPlace = () => {} }) {
  const n = ++uid;
  const root = document.createElement('div');
  root.className = 'cg-place';
  root.innerHTML = `
    <label class="cg-fine cg-place-label" for="cg-place-input-${n}">Passes over another country or sea</label>
    <div class="cg-place-field">
      <input id="cg-place-input-${n}" class="cg-place-input" type="text" role="combobox" autocomplete="off"
        spellcheck="false" aria-autocomplete="list" aria-expanded="false" aria-controls="cg-place-list-${n}"
        placeholder="Japan, Peru, the North Sea">
      <button type="button" class="cg-place-clear" hidden>Calgary</button>
    </div>
    <ul class="cg-place-list" id="cg-place-list-${n}" role="listbox" aria-label="Places" hidden></ul>
    <p class="cg-place-status" aria-live="polite"></p>
    <div class="cg-place-results" hidden>
      <p class="cg-fine cg-place-note"></p>
      <ol class="cg-list cg-passes cg-place-passes"></ol>
      <p class="cg-fine cg-place-later" hidden></p>
      <ol class="cg-list cg-passes cg-place-passes cg-place-best-list" hidden></ol>
      <p class="cg-place-reason"></p>
      <p class="cg-fine cg-place-accuracy" hidden></p>
      <button type="button" class="cg-btn cg-place-again" hidden></button>
    </div>
  `;
  const $ = (s) => root.querySelector(s);
  const input = $('.cg-place-input');
  const list = $('.cg-place-list');
  const clear = $('.cg-place-clear');
  const status = $('.cg-place-status');
  const results = $('.cg-place-results');
  const again = $('.cg-place-again');

  let suggestions = [];
  let active = -1;
  let place = null;
  let found = null; // { fromMs, passes, best }
  let pending = null; // a place chosen before the orbit loaded
  let ac = null;

  loadCountries().then(() => {
    if (document.activeElement === input && input.value) suggest();
  });

  // ---- the suggestion list --------------------------------------------------------
  function showList(open) {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
  }

  function paintList() {
    list.replaceChildren();
    suggestions.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `cg-place-${n}-${i}`;
      li.className = 'cg-place-option';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = s.label;
      const kind = document.createElement('span');
      kind.className = 'cg-fine';
      kind.textContent = s.kind === 'country' ? 'Country' : s.kind === 'sea' ? 'Sea' : 'Region';
      li.append(kind);
      // keep the focus in the box while a pointer picks
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(s));
      list.append(li);
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `cg-place-${n}-${active}`);
    else input.removeAttribute('aria-activedescendant');
    showList(suggestions.length > 0);
  }

  function suggest() {
    suggestions = findPlaces(input.value, 6);
    active = -1;
    paintList();
    if (input.value.trim() && !suggestions.length) status.textContent = 'No country, sea or region by that name.';
    else if (!place) status.textContent = '';
  }

  input.addEventListener('input', suggest);
  input.addEventListener('focus', () => {
    if (input.value && !place) suggest();
  });
  input.addEventListener('blur', () => setTimeout(() => showList(false), 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) suggest();
      if (!suggestions.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + suggestions.length) % suggestions.length;
      paintList();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const pick = suggestions[active] || (input.value.trim() ? findPlaces(input.value, 1)[0] : null);
      if (pick) choose(pick);
      else if (input.value.trim()) status.textContent = 'No country, sea or region by that name.';
    } else if (e.key === 'Escape') {
      if (!list.hidden) showList(false);
      else if (place) reset();
      else return;
    } else {
      return;
    }
    e.preventDefault();
  });

  clear.addEventListener('click', () => {
    reset();
    input.focus();
  });

  // ---- results ----------------------------------------------------------------------
  function reset() {
    ac?.abort();
    place = null;
    found = null;
    pending = null;
    input.value = '';
    suggestions = [];
    showList(false);
    results.hidden = true;
    clear.hidden = true;
    status.textContent = '';
    root.classList.remove('cg-place-on');
    onPlace(null);
  }

  function choose(s) {
    place = getPlace(s.id);
    input.value = s.label;
    showList(false);
    clear.hidden = false;
    clear.setAttribute('aria-label', 'Back to the passes over Calgary');
    root.classList.add('cg-place-on');
    onPlace(place);
    search();
  }

  async function search() {
    if (!place) return;
    ac?.abort();
    const orbit = getOrbit();
    if (!orbit) {
      pending = place;
      status.textContent = 'Loading the orbit…';
      return;
    }
    pending = null;
    const mine = new AbortController();
    ac = mine;
    const fromMs = getTime();
    const target = place;
    results.hidden = true;
    status.textContent = `Looking for passes over ${target.name}…`;
    try {
      const passes = await findRegionPassesAsync(orbit, target, fromMs, {
        signal: mine.signal, count: 12, enough: SHOWN, enoughDays: 7,
      });
      if (mine.signal.aborted || target !== place) return;
      found = { fromMs, passes, best: bestPass(passes), place: target };
      paintResults();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Place passes failed', err);
        status.textContent = 'Couldn’t work out the passes.';
      }
    }
  }

  function passButton(p, isBest) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cg-pass cg-place-pass';
    const row = document.createElement('span');
    row.className = 'cg-pass-row';
    const when = document.createElement('span');
    when.textContent = calgary(p.closestMs);
    row.append(when);
    if (isBest) {
      const tag = document.createElement('span');
      tag.className = 'cg-best';
      tag.textContent = 'Best';
      row.append(tag);
    }
    const sub1 = document.createElement('span');
    sub1.className = 'cg-fine';
    sub1.textContent = `${utc(p.closestMs)}. ${span(p.durationS)} over ${found.place.label}${p.inProgress ? ', under way now' : ''}.`;
    const sub2 = document.createElement('span');
    sub2.className = 'cg-fine';
    sub2.textContent = `${fmtKm(p.closestKm)} from the middle. ${light(p)}.`;
    b.append(row, sub1, sub2);
    b.setAttribute('aria-label', `${isBest ? 'Best for a picture. ' : ''}${calgary(p.closestMs)}, ${utc(p.closestMs)}. ` +
      `${span(p.durationS)} over ${found.place.label}. ${sub2.textContent} Show this pass.`);
    b.addEventListener('click', () => {
      for (const other of root.querySelectorAll('.cg-place-pass')) other.removeAttribute('aria-current');
      b.setAttribute('aria-current', 'true');
      onJump(p);
    });
    li.append(b);
    return li;
  }

  function paintResults() {
    const { passes, best, fromMs } = found;
    const shown = passes.slice(0, SHOWN);
    const olShown = $('.cg-place-passes');
    const olBest = $('.cg-place-best-list');
    const later = $('.cg-place-later');
    olShown.replaceChildren(...shown.map((p, i) => passButton(p, best?.index === i)));
    const bestLater = best && best.index >= SHOWN ? passes[best.index] : null;
    olBest.replaceChildren(...(bestLater ? [passButton(bestLater, true)] : []));
    olBest.hidden = later.hidden = !bestLater;
    if (bestLater) later.textContent = `Best of the next ${passes.length} passes`;
    $('.cg-place-note').textContent =
      `Crossings after ${utc(fromMs)}, each at its nearest to the middle. Times in Calgary.`;
    $('.cg-place-reason').textContent = best ? `Best for a picture: ${best.reason}` : '';
    const orbit = getOrbit();
    const last = Math.max(...[...shown, bestLater].filter(Boolean).map((p) => p.closestMs), 0);
    const far = orbit && last - orbit.lastEpochMs > FAR_DAYS * DAY_MS;
    const accuracy = $('.cg-place-accuracy');
    accuracy.hidden = !far;
    accuracy.textContent = far
      ? 'Passes more than a week past the newest orbital elements are forecasts: their times could be a minute or more out.'
      : '';
    if (!passes.length) {
      status.textContent =
        `No passes over ${found.place.name} in the next ${SEARCH_DAYS} days. Very small places can slip between the outlines, which are coarse.`;
      results.hidden = true;
    } else {
      const days = Math.max(1, Math.ceil((shown[shown.length - 1].closestMs - fromMs) / DAY_MS));
      status.textContent = `${shown.length === 1 ? 'One pass' : `${shown.length} passes`} over ${found.place.name} ` +
        `in the next ${days === 1 ? 'day' : `${days} days`}.`;
      results.hidden = false;
    }
    again.hidden = true;
  }

  again.addEventListener('click', () => search());

  return {
    element: root,
    get place() {
      return place;
    },
    /** From the page's clock: offer to look again once the time has moved
     * away from the one the passes were found for. */
    tick(ms) {
      if (pending && getOrbit()) search();
      if (!found || results.hidden) return;
      const near = found.passes.some((p) => ms >= p.startMs - 600_000 && ms <= p.endMs + 600_000);
      const moved = Math.abs(ms - found.fromMs) > 30 * 60_000 && !near;
      if (moved === again.hidden) again.hidden = !moved;
      const text = `Look again from ${utc(ms)}`;
      if (moved && again.textContent !== text) again.textContent = text;
    },
    reset,
    destroy() {
      ac?.abort();
      root.remove();
    },
  };
}
