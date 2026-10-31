// The catalogue: one large picture with its facts, or two or four side by
// side to compare, over a browse dock (how many at a time, Newer and Older,
// the filters, and a filmstrip of every picture to jump around).
// Styling follows docs/design-direction.md §4.
//
// Everything it shows lives in the URL query, so a link opens the same view:
//   #/pictures?id=<id>                        one picture
//   #/pictures?id=<b>&compare=<a>,<b>         two side by side; id is the active cell
//   #/pictures?id=<a>&compare=<a>,,,          four, three cells still empty
//   ...&camera=picam&month=2026-09&q=clouds   the filters (FILTER_KEYS in data.js)
//   ...&dark=1                                dark frames shown in the strip too
//   ...&missing=1                             mostly missing pictures (under a fifth) too
//   ...&from=globe                            opened from the globe: offer the way back
// Every step uses history.replaceState, so Back leaves the catalogue instead
// of walking back through each picture that was looked at.
//
// Dark frames (images.json "dark": black, noise, or the Sun as a lone dot)
// and mostly missing pictures (less than a fifth can be shown) are left out
// of the strip and the stepping until their switch after the count brings
// them in. A link straight to one still opens it, with its switch on.
//
// With no id in the URL it opens on the newest picture that isn't dark and
// is at least half there; the strip still starts with the newest.

import { h, append, announce, copyText } from './dom.js';
import { CAMERAS, clock, monthDayYear, grouped, latLon, percent, plural, toDate } from './format.js';
import { applyFilters, FILTER_KEYS, readFilters } from './data.js';
import { createFilterForm, describeFilters } from './filters.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const SIZES = [[1, 'One'], [2, 'Two'], [4, 'Four']];
// The filters proper: dark and missing are switches, not filters.
const SWITCHES = ['dark', 'missing'];
const NARROWING = FILTER_KEYS.filter((key) => !SWITCHES.includes(key));
const MAX_CELLS = 4;
const EAGER_THUMBS = 16;
const DAY_MS = 24 * 3600 * 1000;

/* Words for one picture */

export const isDark = (p) => Boolean(p && (p.dark === true || (p.raw && p.raw.dark === true)));

// Less than a fifth of the picture can be shown. data.js sets p.mostlyMissing
// (on main); until that lands here, the same rule from completeness.
export const isMostlyMissing = (p) => Boolean(p && (typeof p.mostlyMissing === 'boolean'
  ? p.mostlyMissing
  : Number(p.raw?.completeness) < 0.2));

const DARK_WHY = 'nothing but black, sensor noise or the Sun as a single dot';
const MISSING_WHY = 'less than a fifth of the picture can be shown';

// Keeps a date, a time or a range on one line: lines break only between them.
function nobr(text) {
  return h('span', { class: 'cat-nobr' }, text);
}

// "Oct 24, 2026, 17:37:32 UTC" with the date and the time each kept whole.
function utcParts(d, seconds = false) {
  return [nobr(monthDayYear(d)), ', ', nobr(`${clock(d, seconds)} UTC`)];
}

function sameTime(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return toDate(a)?.getTime() === toDate(b)?.getTime();
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// A member who moved the capture time without giving a position leaves the
// computed position in place, but it belongs to the old time (as in detail.js).
function positionIsStale(p) {
  return !p.positionRecomputed
    && Boolean(p.edited.captured_at && !p.edited.position && !sameTime(p.capturedAt, p.raw.captured_at));
}

function placeName(p) {
  if (p.place) return p.place;
  if (positionIsStale(p)) return '';
  return p.computedPlace || '';
}

function dayOf(p) {
  const d = toDate(p.capturedAt);
  if (d) return d;
  return p.captureDate ? toDate(`${p.captureDate}T00:00:00Z`) : null;
}

function dateText(p) {
  const d = dayOf(p);
  return d ? monthDayYear(d) : 'Date unknown';
}

// The largest line: a member's title, else the place, else the date, else
// the build's own title ("Attitude camera, frame 1c89").
export function headline(p) {
  if (p.title !== p.defaultTitle) return p.title;
  return placeName(p) || (dayOf(p) ? dateText(p) : p.defaultTitle || p.id);
}

// "Oct 25, 2026, 00:54 UTC", "Oct 24, 2026, time unknown" or "Time unknown".
export function whenShort(p) {
  const d = toDate(p.capturedAt);
  if (d) return `${monthDayYear(d)}, ${clock(d)} UTC`;
  const day = dayOf(p);
  return day ? `${monthDayYear(day)}, time unknown` : 'Time unknown';
}

// For labels that are read aloud: the headline and the time, without saying a
// date twice when the date is all the headline has.
function nameAndWhen(p) {
  const name = headline(p);
  const when = whenShort(p);
  return when.startsWith(name) ? when : `${name}, ${when}`;
}

let calgaryFormat = null;

// "18:54 MDT on Oct 24 in Calgary" (the date only when it differs from UTC's),
// as nodes with the time and the date each kept on one line.
function calgaryLine(d) {
  try {
    calgaryFormat ||= new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Edmonton',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    const parts = {};
    for (const part of calgaryFormat.formatToParts(d)) parts[part.type] = part.value;
    const otherDay = `${parts.month} ${parts.day}, ${parts.year}` !== monthDayYear(d);
    return [
      nobr(`${parts.hour}:${parts.minute} ${parts.timeZoneName}`),
      otherDay ? [' on ', nobr(`${parts.month} ${parts.day}`)] : '',
      ' in Calgary',
    ];
  } catch {
    return null;
  }
}

function agoText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

function checksumMatches(p) {
  const a = p.raw?.sha256;
  const b = p.raw?.sha256_expected;
  return typeof a === 'string' && typeof b === 'string' && a && a.toLowerCase() === b.toLowerCase();
}

// Numbers from the build's status note: "lines 0–499 of the 1210 … and 367 of those arrived".
function noteNumbers(p) {
  const note = String(p.raw?.status_note || '');
  const lines = /lines\s+(\d+)\s*[–-]\s*(\d+)\s+of\s+(?:the\s+)?(\d+)/i.exec(note);
  const arrived = /(\d[\d,]*)\s+of\s+those\s+arrived/i.exec(note);
  return {
    lines: lines ? { from: Number(lines[1]), to: Number(lines[2]), of: Number(lines[3]) } : null,
    arrived: arrived ? Number(arrived[1].replace(/,/g, '')) : null,
  };
}

// Part of the file is still missing: a partial picture, or one the satellite
// cut short whose saved lines haven't all come down.
function linesMissing(p) {
  if (p.status === 'partial') return true;
  if (p.status !== 'truncated' || checksumMatches(p)) return false;
  const { lines, arrived } = noteNumbers(p);
  if (lines && arrived != null) return arrived < lines.to - lines.from + 1;
  return Boolean(p.raw?.sha256_expected);
}

// "last packet 1 h ago" while a picture with lines missing is still arriving.
function stillComing(p) {
  if (!linesMissing(p)) return null;
  const last = toDate(p.raw?.downlink?.last);
  const since = last ? Date.now() - last.getTime() : Infinity;
  return since >= 0 && since < DAY_MS ? `Still coming down: last packet ${agoText(since)} ago.` : null;
}

// The status in a few words, for labels, cells and announcements.
// A main-camera picture's completeness is how much of it can be shown, not
// how much arrived: its JPEG can't be decoded past the first gap.
export function statusShort(p) {
  const pct = percent(p.raw?.completeness);
  if (p.status === 'partial') {
    if (p.camera === 'picam') return pct ? `partly missing: only the top ${pct} is shown` : 'partly missing';
    return pct ? `partly missing: about ${pct} came down` : 'partly missing';
  }
  if (p.status === 'truncated') {
    return linesMissing(p) && pct ? `cut short on board, and only the top ${pct} is shown` : 'cut short on board';
  }
  if (p.status === 'verified') return 'checked';
  if (p.status === 'complete') return 'complete, unchecked';
  return p.status ? String(p.status) : 'status unknown';
}

// The status sentence under the time, only for a picture that is not
// checked and whole (design direction §4, "States and copy"), as nodes.
function statusLine(p) {
  const raw = p.raw || {};
  const pct = percent(raw.completeness);
  const coming = stillComing(p);
  let text = null;
  if (p.status === 'partial') {
    const never = coming ? 'hasn’t come down yet' : 'never came down';
    if (p.camera === 'picam') {
      text = [`Part of this picture ${never}. Nothing below the first gap can be read`,
        pct ? [', so only the top ', nobr(pct), ' is shown.'] : '.'];
    } else {
      text = [`Grey bands are rows that ${coming ? 'haven’t come down yet' : 'never came down'}.`,
        pct ? [` About ${pct} of it ${coming ? 'has so far' : 'did'}.`] : ''];
    }
  } else if (p.status === 'truncated') {
    const { lines, arrived } = noteNumbers(p);
    const saved = lines
      ? ['saved lines ', nobr(`${lines.from}–${lines.to}`), ` of ${lines.of}`]
      : ['saved only the top part of the frame'];
    if (!linesMissing(p)) {
      text = ['The satellite stopped this capture early: it ', saved, checksumMatches(p) ? ', and all of that came down.' : '.'];
    } else {
      const sofar = lines && arrived != null
        ? `${grouped(arrived)} of those have come down so far`
        : 'Not all of those have come down yet';
      const gap = Number(raw.completeness) < 0.25 ? 'a gap near the top' : 'a gap';
      text = ['The satellite stopped this capture early and ', saved, `. ${sofar}, but ${gap} means `,
        pct ? ['only the top ', nobr(pct), ' can be shown.'] : 'only part of it can be shown.'];
    }
  } else if (p.status === 'complete') {
    text = ['Complete, but there’s no checksum to check it against.'];
  }
  if (coming) text = text ? [text, ' ', coming] : [coming];
  return text;
}

// The first picture to show when the URL names none: the newest that isn't
// dark and is at least half there. Grey slabs are for the strip, not the stage.
function isWorthOpening(p) {
  const c = Number(p.raw?.completeness);
  return !isDark(p) && (!Number.isFinite(c) || c >= 0.5);
}

function altText(p) {
  const camera = CAMERAS[p.camera]?.alt || 'Camera';
  const where = placeName(p) || (p.position && !positionIsStale(p) ? latLon(p.position.lat, p.position.lon, 1) : '');
  const parts = [];
  if (p.title !== p.defaultTitle) parts.push(`${p.title}.`);
  parts.push(`${camera} image${where ? ` over ${where}` : ''}, ${whenShort(p)}.`);
  if (p.status === 'partial') parts.push('Parts of the image never came down and are flat grey.');
  if (p.status === 'truncated') parts.push('Only the top of the frame exists.');
  return parts.join(' ');
}

function thumbLabel(p) {
  const parts = [];
  if (p.title !== p.defaultTitle) parts.push(p.title);
  const where = placeName(p);
  if (where) parts.push(where);
  parts.push(whenShort(p), p.camera === 'adcs' ? 'attitude camera' : 'main camera', statusShort(p));
  if (isDark(p)) parts.push('dark frame');
  return parts.join(', ');
}

const BASIS = {
  filename: 'From the file name',
  'capture log': 'From the camera’s capture log',
  'capture record': 'From the capture command’s own record',
  'ADCS file list': 'From the attitude camera’s file list',
  'capture reply': 'From the satellite’s reply to the capture command',
};

function cameraName(camera) {
  if (camera === 'picam') return 'Main camera';
  if (camera === 'adcs') return 'Attitude camera';
  return camera ? String(camera) : 'Unknown camera';
}

function monthKey(p) {
  return p.month || 'unknown';
}

function monthText(key, newestYear) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  if (!m) return 'No date';
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return m[1] === newestYear ? name : `${name} ${m[1]}`;
}

function code(text) {
  return h('code', { class: 'cat-code' }, text);
}

function isVisible(node) {
  return Boolean(node && node.isConnected && node.getClientRects().length);
}

/* The catalogue */

// onQueryChange(query): the query after every change (also written to the URL).
// onBack(): go back to the globe; the control shows only with from=globe.
// globeHref(photo): where "Show on the globe" goes.
export function createCatalogue(root, {
  onQueryChange = () => {},
  onBack = null,
  route = '#/pictures',
  globeHref = (p) => `globe/index.html?photo=${encodeURIComponent(p.id)}`,
} = {}) {
  let photos = [];
  let byId = new Map();
  let filters = readFilters(new URLSearchParams());
  let matched = []; // the pictures the filters let through
  let shown = []; // the same without dark frames, unless they are brought in
  // Tucked away unless switched on: dark frames, and pictures mostly missing.
  const show = { dark: false, missing: false };
  let ready = false;
  let pending = null; // params from show() before the data arrived
  let currentId = null; // one-picture view; in compare, the last picture placed or stepped
  let size = 1; // pictures at a time: 1, 2 or 4
  let slots = []; // compare cells: an id or null each
  let active = 0; // the cell the filmstrip and the arrow keys change
  let from = ''; // "globe" when opened from the globe
  let missingId = null;
  let stripKey = '';
  let announceTimer = 0;
  const thumbs = new Map();

  /* The way back */

  const backBtn = h('button', { type: 'button', class: 'cat-back' }, 'Back to the globe');
  backBtn.addEventListener('click', () => goBack());
  const backRow = h('div', { class: 'cat-back-row', hidden: true }, backBtn);
  const missing = h('p', { class: 'cat-missing', role: 'status', hidden: true });

  /* Viewer: one picture */

  const img = h('img', { class: 'cat-img', alt: '', decoding: 'async', fetchpriority: 'high' });
  const failText = h('p', { class: 'cat-fail-text' }, 'This picture didn’t load.');
  const retry = h('button', { type: 'button', class: 'cat-text-btn' }, 'Try again');
  const fail = h('div', { class: 'cat-fail', hidden: true }, failText, retry);
  const frame = h('div', { class: 'cat-frame' }, img, fail);
  img.addEventListener('error', () => {
    if (!img.getAttribute('src')) return;
    frame.classList.add('is-failed');
    fail.hidden = false;
  });
  img.addEventListener('load', () => {
    frame.classList.remove('is-failed');
    fail.hidden = true;
  });
  retry.addEventListener('click', () => {
    const src = img.getAttribute('src');
    fail.hidden = true;
    frame.classList.remove('is-failed');
    img.removeAttribute('src');
    if (src) img.src = src;
  });

  // Swipe sideways on the picture to step (touch and pen only).
  let swipe = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  frame.addEventListener('pointerup', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1, 'swipe');
  });
  frame.addEventListener('pointercancel', () => { swipe = null; });

  /* Viewer: compare cells, four kept and as many shown as asked for */

  function makeCell(i) {
    const image = h('img', { alt: '', decoding: 'async' });
    const empty = h('span', { class: 'cat-cell-empty' }, 'Pick a picture from the strip below.');
    const pick = h('button', { type: 'button', class: 'cat-cell-pick', 'aria-pressed': 'false' }, image, empty);
    const place = h('h2', { class: 'cat-cell-place', id: `cat-cell-${i}` });
    const time = h('span', { class: 'cat-cell-time' });
    const status = h('span', { class: 'cat-cell-status' });
    const remove = h('button', { type: 'button', class: 'cat-text-btn cat-cell-remove' }, 'Remove');
    const cap = h('div', { class: 'cat-cell-cap' }, place, time, status, remove);
    const el = h('section', { class: 'cat-cell', 'aria-label': `Cell ${i + 1}` }, pick, cap);
    pick.addEventListener('click', () => { if (active !== i) setActive(i, true); });
    remove.addEventListener('click', () => removeCell(i));
    const cell = { el, pick, image, empty, place, time, status, remove, cap, failed: null };
    image.addEventListener('error', () => {
      cell.failed = image.getAttribute('src');
      if (cell.failed && size > 1) updateCompare();
    });
    return cell;
  }

  const cells = Array.from({ length: MAX_CELLS }, (_, i) => makeCell(i));
  const compareEl = h('div', { class: 'cat-compare', hidden: true }, cells.map((c) => c.el));
  const noneNote = h('p', { class: 'cat-none', hidden: true });
  const viewer = h('div', { class: 'cat-viewer' }, frame, compareEl, noneNote);

  /* Dock: how many, Newer and Older, filters, the strip */

  const modeButtons = SIZES.map(([n, word]) => {
    const button = h('button', { type: 'button', class: 'cat-seg-btn', 'aria-pressed': 'false', 'data-size': String(n) }, word);
    button.addEventListener('click', () => setSize(n, { user: true }));
    return button;
  });
  const modes = h('div', { class: 'cat-modes', role: 'group', 'aria-labelledby': 'cat-show-label' },
    h('span', { class: 'cat-small', id: 'cat-show-label' }, 'Show'),
    h('span', { class: 'cat-seg' }, modeButtons));

  const newerBtn = h('button', { type: 'button', class: 'cat-text-btn', 'data-step': 'newer' }, 'Newer');
  const olderBtn = h('button', { type: 'button', class: 'cat-text-btn', 'data-step': 'older' }, 'Older');
  newerBtn.addEventListener('click', () => { if (newerBtn.getAttribute('aria-disabled') !== 'true') step(-1, 'button'); });
  olderBtn.addEventListener('click', () => { if (olderBtn.getAttribute('aria-disabled') !== 'true') step(1, 'button'); });
  const steps = h('div', { class: 'cat-steps' }, newerBtn, olderBtn);

  // In Small, after the count, one line each (they stack):
  //   "21 pictures."
  //   "7 dark frames hidden: nothing but black, … Show them"
  //   "2 mostly missing pictures hidden: less than a fifth … Show them"
  // so the numbers agree with the strip and what is tucked away is a click
  // away at any width.
  const countText = h('span', { class: 'cat-count-text' });
  const clearBtn = h('button', { type: 'button', class: 'cat-inline-btn', hidden: true }, 'Clear filters');
  clearBtn.addEventListener('click', () => clearFilters());
  const makeSwitch = (kind) => {
    const text = h('span', { class: 'cat-switch-text' });
    const btn = h('button', { type: 'button', class: 'cat-inline-btn', 'data-switch': kind });
    btn.addEventListener('click', () => toggleSwitch(kind));
    const line = h('span', { class: 'cat-count-line cat-switch-line', hidden: true }, text, ' ', btn);
    return { text, btn, line };
  };
  const switches = { dark: makeSwitch('dark'), missing: makeSwitch('missing') };
  const count = h('div', { class: 'cat-count' },
    h('span', { class: 'cat-count-line' }, countText, ' ', clearBtn),
    switches.dark.line,
    switches.missing.line);
  const filterToggle = h('button', {
    type: 'button', class: 'cat-text-btn cat-filter-toggle', 'aria-expanded': 'false', 'aria-controls': 'cat-filters',
  }, 'Filters');
  filterToggle.addEventListener('click', () => setFiltersOpen(filterUi.form.hidden));
  // Controls on one row (Filters at its right), the count and the switches
  // on their own full-width row under it, one line each.
  const dockEnd = h('div', { class: 'cat-dock-end' }, count);
  const dockRow = h('div', { class: 'cat-dock-row' }, modes, steps, filterToggle, dockEnd);

  const filterUi = createFilterForm({
    onChange: (key, value) => setFilter(key, value),
    idPrefix: 'cat-filter',
    className: 'filters cat-filters',
  });
  filterUi.form.id = 'cat-filters';
  filterUi.form.hidden = true;

  const strip = h('ol', { class: 'cat-strip', 'aria-label': 'Pictures, newest first' });
  const stripNote = h('p', { class: 'cat-strip-note', hidden: true });
  const dock = h('div', { class: 'cat-dock' }, dockRow, filterUi.form, strip, stripNote);

  /* Info column */

  const title = h('h1', { class: 'cat-title', id: 'cat-title', tabindex: '-1' });
  const whenUtc = h('span', { class: 'cat-line' });
  const whenLocal = h('span', { class: 'cat-line' });
  const when = h('p', { class: 'cat-when' }, whenUtc, whenLocal);
  const status = h('p', { class: 'cat-status', hidden: true });
  const facts = h('dl', { class: 'cat-facts' });
  const notesText = h('p', { class: 'cat-notes-text' });
  const notesBy = h('p', { class: 'cat-small cat-muted', hidden: true });
  const notes = h('section', { class: 'cat-notes', 'aria-labelledby': 'cat-notes-heading' },
    h('h2', { class: 'cat-notes-heading', id: 'cat-notes-heading' }, 'Notes'), notesText, notesBy);

  const globeLink = h('a', { class: 'cat-primary' }, 'Show on the globe');
  const globeOff = h('button', {
    type: 'button', class: 'cat-primary', 'aria-disabled': 'true', 'aria-describedby': 'cat-globe-why', hidden: true,
  }, 'Show on the globe');
  // The Where fact already says this on screen; here it describes the button.
  const globeWhy = h('p', { class: 'vh', id: 'cat-globe-why' },
    'Only the date of this picture is known, so it isn’t on the globe.');
  const compareBtn = h('button', { type: 'button', class: 'cat-text-btn' }, 'Compare');
  compareBtn.addEventListener('click', () => setSize(2, { user: true }));
  const download = h('a', { class: 'cat-text-btn' }, 'Download');
  const copyBtn = h('button', { type: 'button', class: 'cat-text-btn' }, 'Copy link');
  let copyTimer = 0;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(location.href);
    copyBtn.textContent = ok ? 'Link copied' : 'Copy failed';
    announce(ok ? 'Link copied' : 'Could not copy the link');
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
  });
  const detailsName = h('span', { class: 'vh' });
  const detailsLink = h('a', { class: 'cat-text-btn' }, 'All details', detailsName);
  // The one primary on its own line, then one row of text buttons.
  const actions = h('div', { class: 'cat-actions' },
    h('div', { class: 'cat-actions-primary' }, globeLink, globeOff),
    h('div', { class: 'cat-actions-row' }, compareBtn, download, copyBtn, detailsLink));
  const emptyNote = h('p', { class: 'cat-empty-note', hidden: true });
  // The actions before the facts, so they're on screen on a laptop however long the facts are.
  const info = h('div', { class: 'cat-info' }, title, when, status, emptyNote, actions, facts, notes, globeWhy);

  const grid = h('div', { class: 'cat-grid' }, viewer, dock, info);
  const notice = h('div', { class: 'cat-notice', role: 'status', hidden: true });
  const loadingText = h('p', { class: 'vh', role: 'status' }, 'Loading pictures…');
  const inner = h('div', { class: 'cat-in' }, backRow, missing, notice, grid, loadingText);
  const el = h('div', { class: 'cat', 'data-size': '1', 'data-state': 'loading' }, inner);
  root.append(el);
  drawLoading();

  // The stage is as tall as fits above the dock, whatever the dock holds
  // (filters open, a count that wraps, a contact sheet on a big screen), and
  // compare cells are sized from the stage's width: both measured here.
  // Measured after every render too, so it never waits for a paint.
  function measure() {
    if (!isVisible(el)) return;
    const dockH = `${Math.ceil(dock.getBoundingClientRect().height)}px`;
    const stageW = `${Math.floor(viewer.getBoundingClientRect().width)}px`;
    if (el.style.getPropertyValue('--dock-h') !== dockH) el.style.setProperty('--dock-h', dockH);
    if (el.style.getPropertyValue('--stage-w') !== stageW) el.style.setProperty('--stage-w', stageW);
  }
  const sizer = new ResizeObserver(() => measure());
  sizer.observe(dock);
  sizer.observe(viewer);
  window.addEventListener('resize', () => measure());

  /* Loading: the layout at its real size, values as flat bars */

  function drawLoading() {
    title.replaceChildren(h('span', { class: 'cat-ghost', style: 'width: 70%' }));
    whenUtc.replaceChildren(h('span', { class: 'cat-ghost', style: 'width: 55%' }));
    whenLocal.replaceChildren(h('span', { class: 'cat-ghost', style: 'width: 40%' }));
    const widths = [80, 70, 90, 55, 85, 60, 75];
    facts.replaceChildren(...['Taken', 'Where', 'Light', 'Camera', 'Came down', 'Check', 'File'].flatMap((label, i) => [
      h('dt', null, label), h('dd', null, h('span', { class: 'cat-ghost', style: `width: ${widths[i]}%` })),
    ]));
    notes.hidden = true;
    actions.hidden = true;
    strip.replaceChildren(...Array.from({ length: 14 }, () => h('li', { class: 'cat-strip-item' },
      h('span', { class: 'cat-month' }), h('span', { class: 'cat-thumb-ghost' }))));
  }

  /* URL */

  function queryString() {
    const params = new URLSearchParams();
    const id = size > 1 ? slots[active] : currentId;
    if (id) params.set('id', id);
    if (size > 1) params.set('compare', slots.map((s) => s || '').join(','));
    for (const key of NARROWING) {
      const value = String(filters[key] || '').trim();
      if (value) params.set(key, value);
    }
    if (show.dark) params.set('dark', '1');
    if (show.missing) params.set('missing', '1');
    if (from) params.set('from', from);
    // Commas between ids read better than %2C, and URLSearchParams reads both.
    return params.toString().replace(/%2C/gi, ',');
  }

  function writeUrl() {
    const query = queryString();
    // Built on the full current URL, so a page with a <base> stays put.
    const url = new URL(location.href);
    url.hash = query ? `${route}?${query}` : route;
    history.replaceState(history.state, '', url);
    onQueryChange(query);
  }

  function readFrom(params) {
    from = (params.get('from') || '').trim() === 'globe' ? 'globe' : '';
  }

  function applyParams(params) {
    // The dark and missing switches are the catalogue's own (show), not filters.
    filters = { ...readFilters(params), dark: '', missing: '' };
    readFrom(params);
    const id = (params.get('id') || '').trim();
    missingId = id && !byId.has(id) ? id : null;
    const compare = params.get('compare');
    if (compare != null && compare.trim() !== '') {
      const seen = new Set();
      const ids = compare.split(',').map((s) => s.trim()).map((s) => {
        if (!s || !byId.has(s) || seen.has(s)) return null;
        seen.add(s);
        return s;
      });
      size = ids.length > 2 ? 4 : 2;
      slots = ids.slice(0, size);
      while (slots.length < size) slots.push(null);
      // The active cell: the one holding id, else the first empty one.
      const empty = slots.indexOf(null);
      if (id && slots.includes(id)) active = slots.indexOf(id);
      else active = empty >= 0 ? empty : 0;
      currentId = byId.has(id) ? id : (slots.find(Boolean) || null);
    } else {
      size = 1;
      slots = [];
      active = 0;
      currentId = byId.has(id) ? id : null;
    }
    // A link straight to a tucked-away picture opens it, with its kind shown.
    const named = [currentId, ...slots].filter(Boolean).map((s) => byId.get(s));
    show.dark = params.get('dark') === '1' || named.some(isDark);
    show.missing = params.get('missing') === '1' || named.some(isMostlyMissing);
  }

  // Left out of the strip and the stepping until its switch is on.
  function isTucked(p) {
    return (!show.dark && isDark(p)) || (!show.missing && isMostlyMissing(p));
  }

  function narrowed() {
    return NARROWING.some((key) => String(filters[key] || '').trim());
  }

  /* Filters and dark frames */

  // While the filters are open the stage gives up their row's height, so
  // the strip stays on screen (measure() picks up the taller dock).
  function setFiltersOpen(open) {
    filterUi.form.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
    measure();
  }

  function setFilter(key, value) {
    filters = { ...filters, [key]: value };
    keepFocus(() => render());
    writeUrl();
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => announce(summaryText()), 500);
  }

  function clearFilters() {
    const before = document.activeElement;
    const refocus = noneNote.contains(before) || (dock.contains(before) && !filterUi.form.contains(before));
    filters = { ...readFilters(new URLSearchParams()), dark: '', missing: '' };
    filterUi.sync(filters);
    render();
    writeUrl();
    if (refocus && !isVisible(before)) filterToggle.focus({ preventScroll: true });
    announce(summaryText());
  }

  function summaryText() {
    if (!narrowed()) return plural(shown.length, 'picture');
    return `${shown.length} of ${plural(totalCount(), 'picture')} shown: ${describeFilters(filters)}`;
  }

  // Every picture the strip could hold with no filters set.
  function totalCount() {
    return photos.filter((p) => !isTucked(p)).length;
  }

  function clearButton() {
    return h('button', { type: 'button', class: 'cat-text-btn', onclick: clearFilters }, 'Clear filters');
  }

  const SWITCH_WORDS = {
    dark: { test: isDark, one: 'dark frame', many: 'dark frames' },
    missing: { test: isMostlyMissing, one: 'mostly missing picture', many: 'mostly missing pictures' },
  };

  function toggleSwitch(kind, on = !show[kind]) {
    show[kind] = on;
    keepFocus(() => render());
    writeUrl();
    // From the no-match note, whose button goes away: on to the one in the dock.
    const btn = switches[kind].btn;
    if (!isVisible(document.activeElement) && isVisible(btn)) btn.focus({ preventScroll: true });
    const words = SWITCH_WORDS[kind];
    const n = matched.filter(words.test).length;
    announce(`${plural(n, words.one, words.many)} ${on ? 'brought into the strip' : 'hidden'}.`);
  }

  // People and tags in the facts filter the strip to their pictures; the
  // picture shown has them, so it stays.
  function filterButtons(items, key) {
    const out = [];
    items.forEach((item, k) => {
      if (k) out.push(', ');
      out.push(h('button', {
        type: 'button',
        class: 'cat-inline-btn',
        'aria-label': key === 'tag' ? `${item}: show only pictures tagged ${item}` : `${item}: show only pictures with ${item}`,
        onclick: () => {
          setFilter(key, item);
          filterUi.sync(filters);
        },
      }, item));
    });
    return out;
  }

  // A picture that is no longer shown (filtered out, or a dark frame now
  // hidden) gives way to its nearest shown neighbour, else the newest.
  function nearestShown(id) {
    const visible = new Set(shown.map((p) => p.id));
    const i = matched.findIndex((p) => p.id === id);
    if (i >= 0) {
      for (let d = 1; d < matched.length; d++) {
        for (const j of [i + d, i - d]) if (matched[j] && visible.has(matched[j].id)) return matched[j].id;
      }
    }
    return shown[0]?.id || null;
  }

  /* Picking and stepping */

  // The picture the arrow keys and the filmstrip start from.
  function anchorId() {
    return size > 1 ? (slots[active] || currentId) : currentId;
  }

  function takenElsewhere(id) {
    if (size === 1) return false;
    const at = slots.indexOf(id);
    return at >= 0 && at !== active;
  }

  function step(delta, via) {
    if (!shown.length) return;
    const i = shown.findIndex((p) => p.id === anchorId());
    let j = i < 0 ? (delta > 0 ? 0 : shown.length - 1) : i + delta;
    while (j >= 0 && j < shown.length && takenElsewhere(shown[j].id)) j += delta;
    if (j < 0 || j >= shown.length) {
      if (via === 'key' || via === 'button') announce(delta < 0 ? 'This is the newest picture.' : 'This is the oldest picture.');
      return;
    }
    choose(shown[j].id, via);
  }

  function jump(end, via) {
    if (!shown.length) return;
    const delta = end === 'first' ? 1 : -1;
    let j = end === 'first' ? 0 : shown.length - 1;
    while (j >= 0 && j < shown.length && takenElsewhere(shown[j].id)) j += delta;
    if (j < 0 || j >= shown.length) return;
    choose(shown[j].id, via);
  }

  function choose(id, via) {
    if (size > 1) stepCell(id, via);
    else selectSingle(id, via);
  }

  function thumbHasFocus() {
    const a = document.activeElement;
    return Boolean(a && a.classList && a.classList.contains('cat-thumb') && strip.contains(a));
  }

  function afterPick(via) {
    const focusThumb = thumbHasFocus();
    const id = anchorId();
    revealThumb(id, true);
    if (focusThumb) thumbs.get(id)?.focus({ preventScroll: true });
    if (via !== 'click') {
      const p = byId.get(id);
      const i = shown.findIndex((x) => x.id === id);
      const where = placeName(p);
      const lead = size > 1 ? `Cell ${active + 1}` : `${i + 1} of ${shown.length}`;
      announce(`${lead}: ${where ? `${where}, ` : ''}${whenShort(p)}, ${statusShort(p)}.`);
    }
  }

  function selectSingle(id, via) {
    if (id === currentId) return;
    currentId = id;
    missingId = null;
    missing.hidden = true;
    writeUrl();
    keepFocus(() => {
      updateSingle();
      markStrip();
    });
    afterPick(via);
  }

  // Arrow keys in compare: the active cell steps to another picture.
  function stepCell(id, via) {
    if (slots[active] === id) return;
    slots[active] = id;
    currentId = id;
    writeUrl();
    keepFocus(() => {
      updateCompare();
      markStrip();
    });
    afterPick(via);
  }

  // A thumbnail picked in compare fills the active cell, and the mark moves
  // on to the next empty cell, if there is one.
  function placeInCell(id) {
    const p = byId.get(id);
    const at = slots.indexOf(id);
    if (at >= 0) {
      if (at !== active) setActive(at, false);
      announce(`Already in cell ${at + 1}. That cell is active.`);
      return;
    }
    const target = active;
    slots[target] = id;
    currentId = id;
    const empty = slots.indexOf(null);
    if (empty >= 0) active = empty;
    writeUrl();
    keepFocus(() => {
      updateCompare();
      markStrip();
    });
    announce(`Cell ${target + 1}: ${placeName(p) ? `${placeName(p)}, ` : ''}${whenShort(p)}.${empty >= 0 ? ` Cell ${empty + 1} is next.` : ''}`);
  }

  function setActive(i, user) {
    active = i;
    if (slots[i]) currentId = slots[i];
    writeUrl();
    keepFocus(() => {
      updateCompare();
      markStrip();
    });
    if (slots[i]) revealThumb(slots[i], true);
    if (user) {
      announce(slots[i] ? `Cell ${i + 1} active.` : `Cell ${i + 1} active. It is empty: pick a picture from the strip.`);
    }
  }

  function removeCell(i) {
    slots[i] = null;
    active = i;
    writeUrl();
    updateCompare();
    markStrip();
    // The Remove button went with the picture: focus stays on the cell.
    cells[i].pick.focus({ preventScroll: true });
    announce(`Cell ${i + 1} is empty. Pick a picture from the strip to fill it.`);
  }

  function setSize(n, { user = false } = {}) {
    if (n === size || !ready) return;
    const before = document.activeElement;
    if (n === 1) {
      currentId = slots[active] || currentId || slots.find(Boolean) || null;
      size = 1;
      slots = [];
      active = 0;
    } else if (size === 1) {
      const start = currentId && byId.has(currentId) ? currentId : (shown[0]?.id || null);
      currentId = start;
      slots = [start, ...Array(n - 1).fill(null)];
      size = n;
      active = start ? 1 : 0;
    } else {
      // Between two and four: keep what is placed, and the active one.
      if (n > size) {
        slots = [...slots, ...Array(n - size).fill(null)];
      } else {
        const keep = slots[active];
        const kept = slots.filter(Boolean).slice(0, n);
        if (keep && !kept.includes(keep)) kept[n - 1] = keep;
        slots = [...kept, ...Array(n - kept.length).fill(null)];
      }
      size = n;
      const empty = slots.indexOf(null);
      if (empty >= 0) active = empty;
      else active = Math.max(0, slots.indexOf(currentId));
    }
    render();
    writeUrl();
    // Focus that was in a part now hidden goes to the picture's heading.
    if (before && el.contains(before) && !isVisible(before)) focusFallback();
    revealThumb(anchorId(), false);
    if (user) {
      announce(n === 1 ? 'Showing one picture.' : `Comparing ${n} pictures. Cell ${active + 1} is active: pick a picture from the strip, or use the arrow keys.`);
    }
  }

  function goBack() {
    if (typeof onBack === 'function') onBack();
  }

  function canGoBack() {
    return from === 'globe' && typeof onBack === 'function';
  }

  /* Rendering */

  function focusFallback() {
    const target = size > 1 ? cells[active]?.pick : title;
    if (isVisible(target)) target.focus({ preventScroll: true });
  }

  // Runs fn; if the element that had focus went away or was hidden, focus
  // moves to the picture's heading (or the active cell) instead of the page.
  function keepFocus(fn) {
    const before = document.activeElement;
    const inside = before && before !== document.body && el.contains(before);
    fn();
    if (!inside || isVisible(before)) return;
    focusFallback();
  }

  function showNotice(content) {
    notice.replaceChildren();
    append(notice, content);
    notice.hidden = false;
    grid.hidden = true;
  }

  function render() {
    if (!ready) return;
    el.dataset.state = 'ready';
    loadingText.hidden = true;
    // data.js leaves dark frames (and, on main, mostly missing ones) out
    // unless asked; the catalogue asks, and makes its own split so it can
    // count them.
    matched = applyFilters(photos, { ...filters, dark: '1', missing: '1' });
    shown = matched.filter((p) => !isTucked(p));
    if (size === 1) {
      if (!byId.has(currentId)) {
        // No picture named: the newest that is worth opening.
        currentId = (shown.find(isWorthOpening) || shown[0])?.id || null;
      } else if (shown.length && !shown.some((p) => p.id === currentId)) {
        currentId = nearestShown(currentId);
      }
      // With nothing shown at all the stage says so (renderView); this
      // picture comes back when the filters are cleared.
    }
    filterUi.markActive(filters);
    backRow.hidden = !canGoBack();
    el.classList.toggle('has-back', canGoBack());
    missing.hidden = !missingId;
    if (missingId) {
      missing.textContent = `There is no picture with the id “${missingId}”; it may have been renamed when the list was rebuilt. Showing ${size > 1 ? 'the others' : 'another picture'} instead.`;
    }
    if (!photos.length) {
      showNotice(['No pictures yet. The list is empty until the first image has been reassembled.']);
      return;
    }
    notice.hidden = true;
    grid.hidden = false;
    renderDock();
    renderStrip();
    renderView();
    measure();
  }

  function renderDock() {
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.size) === size));
    }
    const n = NARROWING.filter((key) => String(filters[key] || '').trim()).length;
    filterToggle.textContent = n ? `Filters (${n})` : 'Filters';
    // Counted from what the strip holds, so the numbers agree with it.
    const isNarrowed = narrowed();
    countText.textContent = isNarrowed
      ? `${shown.length} of ${plural(totalCount(), 'picture')}.`
      : `${plural(shown.length, 'picture')}.`;
    clearBtn.hidden = !isNarrowed || (size === 1 && !shown.length); // the stage offers it then
    // One line per kind that the filters let through; the reason only when
    // no filter is set, to keep the dock short.
    for (const [kind, why] of [['dark', DARK_WHY], ['missing', MISSING_WHY]]) {
      const { text, btn, line } = switches[kind];
      const words = SWITCH_WORDS[kind];
      const n = matched.filter(words.test).length;
      line.hidden = !n;
      if (!n) continue;
      const what = plural(n, words.one, words.many);
      const tail = isNarrowed ? '.' : `: ${why}.`;
      text.textContent = show[kind] ? `Showing ${what}${tail}` : `${what} hidden${tail}`;
      btn.textContent = show[kind] ? 'Hide them' : 'Show them';
      btn.setAttribute('aria-label', `${show[kind] ? 'Hide' : 'Show'} the ${what}`);
    }
  }

  function renderView() {
    el.dataset.size = String(size);
    const single = size === 1;
    const none = single && !shown.length;
    frame.hidden = !single || none;
    compareEl.hidden = single;
    compareEl.dataset.size = String(size);
    noneNote.hidden = !none;
    info.hidden = none;
    if (none) {
      noneNote.replaceChildren();
      append(noneNote, noMatchContent());
      return;
    }
    if (single) updateSingle();
    else updateCompare();
    markStrip();
  }

  function setStep(button, target, word) {
    button.setAttribute('aria-disabled', String(!target));
    const label = `${word} picture`;
    button.setAttribute('aria-label', target ? `${label}: ${nameAndWhen(target)}` : `${label}: none`);
  }

  function updateSteps() {
    const i = shown.findIndex((x) => x.id === anchorId());
    let newer = null;
    let older = null;
    for (let j = i - 1; j >= 0 && i >= 0; j--) if (!takenElsewhere(shown[j].id)) { newer = shown[j]; break; }
    for (let j = i + 1; j < shown.length && i >= 0; j++) if (!takenElsewhere(shown[j].id)) { older = shown[j]; break; }
    if (i < 0 && shown.length) older = shown.find((p) => !takenElsewhere(p.id)) || null;
    setStep(newerBtn, newer, 'Newer');
    setStep(olderBtn, older, 'Older');
    return { newer, older };
  }

  function preload(...list) {
    for (const p of list) {
      if (!p) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = p.src;
    }
  }

  function updateSingle() {
    const p = byId.get(currentId);
    if (!p) return;
    if (img.getAttribute('src') !== p.src) {
      fail.hidden = true;
      frame.classList.remove('is-failed');
      img.src = p.src;
    }
    img.width = p.width;
    img.height = p.height;
    img.alt = altText(p);
    frame.dataset.ratio = p.width === p.height ? 'square' : 'wide';
    fillInfo(p);
    const { newer, older } = updateSteps();
    preload(newer, older);
  }

  function updateCompare() {
    cells.forEach((cell, i) => {
      cell.el.hidden = i >= size;
      if (i >= size) return;
      const p = slots[i] ? byId.get(slots[i]) : null;
      const isActive = i === active;
      if (cell.failed && cell.failed !== p?.src) cell.failed = null;
      const failed = Boolean(p && cell.failed);
      cell.el.classList.toggle('is-active', isActive);
      cell.el.classList.toggle('is-empty', !p || failed);
      cell.pick.setAttribute('aria-pressed', String(isActive));
      cell.remove.hidden = !p;
      cell.image.hidden = !p || failed;
      cell.empty.hidden = Boolean(p) && !failed;
      cell.empty.textContent = failed ? 'This picture didn’t load.' : 'Pick a picture from the strip below.';
      cell.place.hidden = !p;
      cell.time.hidden = !p;
      // The cell is sized in CSS from the picture's own size and the stage:
      // never past 1x, an empty cell as a main-camera frame.
      cell.pick.style.setProperty('--nat-w', `${p ? p.width : 640}px`);
      cell.pick.style.setProperty('--ratio', String(p ? p.width / p.height : 4 / 3));
      if (!p) {
        cell.image.removeAttribute('src');
        cell.pick.setAttribute('aria-label', `Cell ${i + 1}, empty${isActive ? '' : ': make it the one the strip fills'}`);
        cell.status.hidden = true;
        return;
      }
      if (cell.image.getAttribute('src') !== p.src) cell.image.src = p.src;
      cell.image.width = p.width;
      cell.image.height = p.height;
      cell.image.alt = altText(p);
      cell.pick.setAttribute('aria-label', `Cell ${i + 1}: ${nameAndWhen(p)}`);
      cell.place.textContent = headline(p);
      cell.place.title = headline(p);
      cell.time.textContent = whenShort(p);
      const word = p.status === 'verified' ? '' : capitalize(statusShort(p));
      cell.status.textContent = word;
      cell.status.hidden = !word;
      cell.remove.setAttribute('aria-label', `Remove ${nameAndWhen(p)}, from cell ${i + 1}`);
    });
    const p = slots[active] ? byId.get(slots[active]) : null;
    if (p) fillInfo(p);
    else fillEmptyInfo();
    updateSteps();
  }

  /* Info column */

  function fillInfo(p) {
    emptyNote.hidden = true;
    for (const part of [when, facts, notes, actions]) part.hidden = false;
    title.textContent = headline(p);
    const d = toDate(p.capturedAt);
    whenUtc.replaceChildren();
    whenLocal.replaceChildren();
    if (d) {
      append(whenUtc, utcParts(d));
      const local = calgaryLine(d);
      if (local) append(whenLocal, local);
      whenLocal.hidden = !local;
    } else {
      whenUtc.textContent = p.captureDate ? 'Time of day unknown' : 'Date and time unknown';
      whenLocal.hidden = true;
    }
    const line = statusLine(p);
    status.replaceChildren();
    if (line) append(status, line);
    status.hidden = !line;
    facts.replaceChildren(...factRows(p));
    notesText.textContent = p.notes || 'No notes yet.';
    notesText.classList.toggle('cat-muted', !p.notes);
    notesBy.textContent = p.notes && p.edited.notes ? `Written by ${p.edited.notes}` : '';
    notesBy.hidden = !notesBy.textContent;

    const onGlobe = Boolean(p.capturedAt);
    globeLink.hidden = !onGlobe;
    globeOff.hidden = onGlobe;
    globeWhy.hidden = onGlobe;
    if (onGlobe) globeLink.href = globeHref(p);
    compareBtn.hidden = size > 1;
    download.href = p.src;
    const fileName = String(p.src || '').split('/').pop() || `${p.id}.jpg`;
    download.setAttribute('download', `cts-sat-1-${fileName}`);
    detailsLink.href = `#/photo/${encodeURIComponent(p.id)}`;
    detailsName.textContent = ` for ${nameAndWhen(p)}`;
  }

  function fillEmptyInfo() {
    title.textContent = `Cell ${active + 1} is empty`;
    for (const part of [when, status, facts, notes, actions, globeWhy]) part.hidden = true;
    emptyNote.hidden = false;
    emptyNote.textContent = 'Pick a picture from the strip below to put it here. Its facts show in this column.';
  }

  function factRows(p) {
    const rows = [
      ['Taken', takenValue(p)],
      ['Where', whereValue(p)],
    ];
    const light = lightValue(p);
    if (light) rows.push(['Light', light]);
    rows.push(['Camera', [`${cameraName(p.camera)}, ${p.width} × ${p.height}`]]);
    const down = downValue(p);
    if (down) rows.push(['Came down', down]);
    rows.push(['Check', checkValue(p)]);
    const file = fileValue(p);
    if (file) rows.push(['File', file]);
    const hash = hashValue(p);
    if (hash) rows.push(['sha256', hash]);
    if (p.people.length) rows.push(['People', [filterButtons(p.people, 'member')]]);
    if (p.tags.length) rows.push(['Tags', [filterButtons(p.tags, 'tag')]]);
    return rows.flatMap(([label, [value, second]]) => [
      h('dt', null, label),
      h('dd', null, h('span', { class: 'cat-value' }, value), second ? h('span', { class: 'cat-second' }, second) : null),
    ]);
  }

  function takenValue(p) {
    const d = toDate(p.capturedAt);
    if (d) {
      const second = p.edited.captured_at
        ? `Corrected by ${p.edited.captured_at}`
        : (BASIS[p.raw.capture_basis] || (p.raw.capture_basis ? `From the ${p.raw.capture_basis}` : null));
      return [utcParts(d, true), second];
    }
    if (p.captureDate) return [nobr(dateText(p)), 'Only the date is known'];
    return ['Not known', 'Neither the file name nor the logs give a time'];
  }

  function whereValue(p) {
    const pos = p.position;
    if (pos && !positionIsStale(p)) {
      const [lat, lon] = latLon(pos.lat, pos.lon).split(', ');
      const alt = Number.isFinite(pos.alt_km) ? [', ', nobr(`${Math.round(pos.alt_km)} km up`)] : '';
      return [[nobr(lat), ', ', nobr(lon), alt], p.edited.position ? `Set by ${p.edited.position}` : 'Worked out from orbital elements'];
    }
    if (positionIsStale(p)) return ['Not worked out for the corrected time', 'The globe works it out from the corrected time'];
    if (p.capturedAt) return ['Not known', 'No orbital elements cover this time'];
    if (p.captureDate) return ['Not known', 'Only the date of this picture is known, so it isn’t on the globe.'];
    return ['Not known', 'There is no time to work it out from'];
  }

  function lightValue(p) {
    if (!p.positionRecomputed && (p.edited.position || positionIsStale(p))) return null;
    const pos = p.positionRecomputed ? p.position : p.raw.position;
    if (!pos || typeof pos !== 'object') return null;
    const parts = [];
    if (typeof pos.ground_sunlit === 'boolean') {
      const e = pos.sun_elevation_deg;
      const sun = Number.isFinite(e) ? `, sun ${Math.abs(e).toFixed(0)}° ${e >= 0 ? 'up' : 'down'}` : '';
      parts.push(`${pos.ground_sunlit ? 'Daylight below' : 'Night below'}${sun}`);
    }
    const sat = {
      sunlit: 'satellite in sunlight',
      shadow: 'satellite in the Earth’s shadow',
      terminator: 'satellite at the edge of the Earth’s shadow',
    }[pos.satellite_light] || (typeof pos.satellite_sunlit === 'boolean'
      ? (pos.satellite_sunlit ? 'satellite in sunlight' : 'satellite in the Earth’s shadow') : null);
    if (sat) parts.push(sat);
    return parts.length ? [parts.join('; ')] : null;
  }

  function downValue(p) {
    const dl = p.raw.downlink && typeof p.raw.downlink === 'object' ? p.raw.downlink : null;
    if (!dl) return null;
    const first = toDate(dl.first);
    const last = toDate(dl.last);
    const short = (d) => monthDayYear(d).replace(/, \d{4}$/, '');
    // Lines break only at " to " and after commas, never inside a date.
    let range = null;
    if (first && last && short(first) === short(last)) {
      range = [nobr(short(first)), ', ', nobr(clock(first)), ' to ', nobr(`${clock(last)} UTC`)];
    } else if (first && last) {
      range = [nobr(`${short(first)} ${clock(first)}`), ' to ', nobr(`${short(last)} ${clock(last)} UTC`)];
    } else if (first || last) {
      range = [nobr(short(first || last)), ', ', nobr(`${clock(first || last)} UTC`)];
    }
    const packets = Number.isFinite(dl.packets) ? nobr(plural(dl.packets, 'packet')) : null;
    if (!packets && !range) return null;
    return [[packets, packets && range ? ', ' : '', range]];
  }

  function checkValue(p) {
    if (checksumMatches(p)) {
      return ['Matches the satellite’s checksum', p.status === 'truncated' ? 'For the shortened file it saved' : null];
    }
    // Lines still missing: the file can't be checked, which isn't the same as wrong.
    if (linesMissing(p)) return ['Can’t check yet', 'Part of the file hasn’t come down.'];
    if (p.raw.sha256_expected) return ['Doesn’t match the satellite’s checksum'];
    return ['No checksum from the satellite'];
  }

  function fileValue(p) {
    if (!p.raw.file) return null;
    const size = Number.isFinite(p.raw.file_size)
      ? [', ', nobr(`${Math.max(1, Math.round(p.raw.file_size / 1024))} KB`)] : '';
    return [[code(p.raw.file), size]];
  }

  function hashValue(p) {
    const hash = p.raw.sha256;
    if (typeof hash !== 'string' || !hash) return null;
    const copy = h('button', { type: 'button', class: 'cat-inline-btn', 'aria-label': 'Copy the full sha256' }, 'Copy');
    copy.addEventListener('click', async () => {
      const ok = await copyText(hash);
      copy.textContent = ok ? 'Copied' : 'Copy failed';
      announce(ok ? 'sha256 copied' : 'Could not copy the sha256');
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });
    return [[h('code', { class: 'cat-code', title: hash }, `${hash.slice(0, 12)}…`), ' ', copy]];
  }

  /* Filmstrip */

  function onThumb(id) {
    if (size > 1) placeInCell(id);
    else selectSingle(id, 'click');
  }

  function thumbFor(p, index) {
    let button = thumbs.get(p.id);
    if (button) return button;
    button = h('button', {
      type: 'button',
      class: 'cat-thumb',
      'data-id': p.id,
      tabindex: '-1',
    },
    h('img', {
      src: p.thumb,
      alt: '',
      width: p.width,
      height: p.height,
      loading: index < EAGER_THUMBS ? 'eager' : 'lazy',
      decoding: 'async',
      onerror: () => button.classList.add('is-failed'),
    }));
    button.addEventListener('click', () => onThumb(p.id));
    thumbs.set(p.id, button);
    return button;
  }

  // What to say when nothing is shown: maybe only tucked-away pictures match.
  function noMatchContent() {
    const tucked = matched.filter(isTucked);
    if (!tucked.length) return ['No pictures match these filters. ', clearButton()];
    const kinds = ['dark', 'missing'].filter((kind) => !show[kind] && tucked.some(SWITCH_WORDS[kind].test));
    const what = kinds.map((kind) => {
      const words = SWITCH_WORDS[kind];
      return plural(tucked.filter(words.test).length, words.one, words.many);
    }).join(' and ');
    const verb = kinds.length === 1 && tucked.filter(SWITCH_WORDS[kinds[0]].test).length === 1 ? 'matches' : 'match';
    const showAll = h('button', {
      type: 'button',
      class: 'cat-text-btn',
      onclick: () => { for (const kind of kinds) toggleSwitch(kind, true); },
    }, 'Show them');
    return [`Only ${what} ${verb} these filters. `, showAll, ' ', clearButton()];
  }

  function renderStrip() {
    const none = !shown.length;
    strip.hidden = none;
    // With one picture the stage says it; comparing, the cells keep their pictures.
    stripNote.hidden = !none || size === 1;
    if (none) {
      stripNote.replaceChildren();
      if (size > 1) append(stripNote, noMatchContent());
      strip.replaceChildren();
      stripKey = '';
      return;
    }
    const key = shown.map((p) => p.id).join('\n');
    if (key === stripKey) return;
    stripKey = key;
    const newestYear = (shown.find((p) => /^\d{4}/.test(p.month)) || {}).month?.slice(0, 4) || '';
    let lastMonth = null;
    const items = shown.map((p, i) => {
      // Undated frames sit where they came down, without a label of their own.
      const m = monthKey(p);
      const label = m !== 'unknown' && m !== lastMonth ? monthText(m, newestYear) : '';
      if (m !== 'unknown') lastMonth = m;
      return h('li', { class: 'cat-strip-item' },
        h('span', { class: 'cat-month', 'aria-hidden': 'true' }, label),
        thumbFor(p, i));
    });
    strip.replaceChildren(...items);
  }

  function markStrip() {
    let focusId = anchorId();
    if (!shown.some((p) => p.id === focusId)) focusId = shown[0]?.id;
    for (const p of shown) {
      const button = thumbs.get(p.id);
      if (!button) continue;
      const cell = size > 1 ? slots.indexOf(p.id) : -1;
      if (size > 1) {
        button.removeAttribute('aria-current');
        button.setAttribute('aria-pressed', String(cell >= 0));
      } else {
        button.removeAttribute('aria-pressed');
        if (p.id === currentId) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
      // In compare, the active cell's picture keeps the full bar; the others
      // in cells get it at 40%.
      button.classList.toggle('is-target', size > 1 && cell >= 0 && cell === active);
      button.tabIndex = p.id === focusId ? 0 : -1;
      button.setAttribute('aria-label', `${thumbLabel(p)}${cell >= 0 ? `. In cell ${cell + 1}` : ''}`);
    }
  }

  // Scrolls the strip (never the page) so a thumbnail is in view.
  function revealThumb(id, smooth) {
    const button = id && thumbs.get(id);
    if (!button || !button.isConnected || !isVisible(strip)) return;
    const item = button.parentElement;
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    const view0 = strip.scrollLeft;
    const view1 = view0 + strip.clientWidth;
    const margin = Math.min(48, strip.clientWidth / 6);
    if (left >= view0 + margin && right <= view1 - margin) return;
    const target = left - (strip.clientWidth - item.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, target), behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
  }

  // A mouse wheel over the strip moves along it; at either end the page takes over.
  strip.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const room = strip.scrollWidth - strip.clientWidth;
    if (room <= 0) return;
    const line = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 32 : 1;
    const next = Math.min(room, Math.max(0, strip.scrollLeft + e.deltaY * line));
    if (next === strip.scrollLeft) return;
    strip.scrollLeft = next;
    e.preventDefault();
  }, { passive: false });

  /* Keyboard */

  function onKey(e) {
    if (!ready || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !isVisible(el)) return;
    const target = e.target instanceof Element ? e.target : null;

    if (e.key === 'Escape' && !filterUi.form.hidden && target
      && (filterUi.form.contains(target) || target === filterToggle)) {
      e.preventDefault();
      setFiltersOpen(false);
      filterToggle.focus({ preventScroll: true });
      return;
    }
    if (target && target.closest('input, textarea, select, [contenteditable], .name-ctl')) return;
    if (e.shiftKey) return;
    const inside = !target || target === document.body || el.contains(target) || target.id === 'main';

    switch (e.key) {
      case 'ArrowLeft':
        step(-1, 'key');
        break;
      case 'ArrowRight':
        step(1, 'key');
        break;
      case 'Home':
        if (!inside) return;
        jump('first', 'key');
        break;
      case 'End':
        if (!inside) return;
        jump('last', 'key');
        break;
      case 'Escape':
        if (size > 1) setSize(1, { user: true });
        else if (canGoBack()) goBack();
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  document.addEventListener('keydown', onKey);

  return {
    // New or changed data: rebuilds the menus and the strip.
    setData(nextPhotos) {
      photos = Array.isArray(nextPhotos) ? nextPhotos : [];
      byId = new Map(photos.map((p) => [p.id, p]));
      ready = true;
      thumbs.clear();
      stripKey = '';
      filterUi.setPhotos(photos);
      if (pending) {
        applyParams(pending);
        pending = null;
      } else {
        if (currentId && !byId.has(currentId)) currentId = null;
        slots = slots.map((id) => (id && byId.has(id) ? id : null));
      }
      filterUi.sync(filters);
      render();
      revealThumb(anchorId(), false);
    },

    showError(content) {
      ready = false;
      el.dataset.state = 'error';
      loadingText.hidden = true;
      backRow.hidden = !canGoBack();
      setFiltersOpen(false);
      missing.hidden = true;
      showNotice(content);
    },

    // Something on the pictures changed in place (corrected.js).
    refresh() {
      if (ready) render();
    },

    // Arriving from another page: focus on the picture's heading, if it's showing.
    focusTitle() {
      if (!isVisible(title)) return false;
      title.focus({ preventScroll: true });
      return true;
    },

    // Called when the route is shown, with the query from the URL.
    show(params) {
      if (!ready) {
        pending = params;
        // The way back works before the pictures arrive.
        readFrom(params);
        backRow.hidden = !canGoBack();
        el.classList.toggle('has-back', canGoBack());
        return;
      }
      applyParams(params);
      filterUi.sync(filters);
      render();
      revealThumb(anchorId(), false);
    },

    // Back from a picture's page: show that picture and put focus on its
    // "All details" link, where the member left from.
    focusTile(id) {
      if (!ready || !byId.has(id)) return false;
      if (size > 1) {
        const at = slots.indexOf(id);
        if (at < 0) return false;
        active = at;
        currentId = id;
        updateCompare();
        markStrip();
      } else {
        if (!shown.some((p) => p.id === id)) return false;
        currentId = id;
        updateSingle();
        markStrip();
      }
      writeUrl();
      revealThumb(id, false);
      detailsLink.focus({ preventScroll: true });
      const box = detailsLink.getBoundingClientRect();
      if (box.top < 0 || box.bottom > window.innerHeight) detailsLink.scrollIntoView({ block: 'center' });
      return true;
    },
  };
}
