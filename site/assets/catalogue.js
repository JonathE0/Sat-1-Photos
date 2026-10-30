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
//   ...&from=globe                            opened from the globe: offer the way back
// Every step uses history.replaceState, so Back leaves the catalogue instead
// of walking back through each picture that was looked at.
//
// Dark frames (images.json "dark": black, nothing to see) are left out of the
// strip and the stepping until the control at the end of the strip brings
// them in. A link straight to one still opens it, with them brought in.

import { h, append, announce, copyText } from './dom.js';
import { CAMERAS, clock, dayMonthYear, latLon, percent, plural, toDate } from './format.js';
import { applyFilters, FILTER_KEYS, hasFilters, readFilters } from './data.js';
import { createFilterForm, describeFilters } from './filters.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const SIZES = [[1, 'One'], [2, 'Two'], [4, 'Four']];
const MAX_CELLS = 4;
const EAGER_THUMBS = 16;
const DAY_MS = 24 * 3600 * 1000;

/* Words for one picture */

export const isDark = (p) => Boolean(p && p.raw && p.raw.dark === true);

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
  return Boolean(p.edited.captured_at && !p.edited.position && !sameTime(p.capturedAt, p.raw.captured_at));
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
  return d ? dayMonthYear(d) : 'Date unknown';
}

// The largest line: a member's title, else the place, else the date, else
// the build's own title ("Attitude camera, frame 1c89").
function headline(p) {
  if (p.title !== p.defaultTitle) return p.title;
  return placeName(p) || (dayOf(p) ? dateText(p) : p.defaultTitle || p.id);
}

// "25 Oct 2026, 00:54 UTC", "24 Oct 2026, time unknown" or "Time unknown".
function whenShort(p) {
  const d = toDate(p.capturedAt);
  if (d) return `${dayMonthYear(d)}, ${clock(d)} UTC`;
  const day = dayOf(p);
  return day ? `${dayMonthYear(day)}, time unknown` : 'Time unknown';
}

let calgaryFormat = null;

// "18:54 MDT on 24 Oct in Calgary" (the date only when it differs from UTC's).
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
    const otherDay = `${parts.day} ${parts.month} ${parts.year}` !== dayMonthYear(d);
    return `${parts.hour}:${parts.minute} ${parts.timeZoneName}${otherDay ? ` on ${parts.day} ${parts.month}` : ''} in Calgary`;
  } catch {
    return null;
  }
}

function agoText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

// The status in a few words, for labels and announcements: "partial: 70% came down".
// A main-camera picture's completeness is how much of it can be shown, not
// how much arrived: its JPEG can't be decoded past the first gap.
export function statusShort(p) {
  if (p.status === 'partial') {
    const pct = percent(p.raw?.completeness);
    if (p.camera === 'picam') return pct ? `partial: about ${pct} can be shown` : 'partial: shown down to the first gap';
    return pct ? `partial: about ${pct} came down` : 'partial: some of it never came down';
  }
  if (p.status === 'truncated') return 'cut short on board';
  if (p.status === 'verified') return 'verified';
  if (p.status === 'complete') return 'complete, no checksum';
  return p.status ? String(p.status) : 'status unknown';
}

// The status sentence under the time, only for a picture that is not
// checked and whole (design direction §4, "States and copy").
function statusLine(p) {
  const raw = p.raw || {};
  const pct = percent(raw.completeness);
  if (p.status === 'partial') {
    const last = toDate(raw.downlink?.last);
    const since = last ? Date.now() - last.getTime() : Infinity;
    if (since >= 0 && since < DAY_MS) {
      return `Still coming down: ${pct || 'part'} so far. Last packet ${agoText(since)} ago.`;
    }
    if (p.camera === 'picam') {
      return pct
        ? `Part of this picture never came down, and the camera’s JPEG can’t be read past the first gap: about ${pct} of it can be shown.`
        : 'Part of this picture never came down, and the camera’s JPEG can’t be read past the first gap.';
    }
    return pct ? `Grey bands are rows that never came down. About ${pct} of it did.` : 'Grey bands are rows that never came down.';
  }
  if (p.status === 'truncated') {
    const m = /lines\s+(\d+)\s*[–-]\s*(\d+)\s+of\s+(?:the\s+)?(\d+)/i.exec(String(raw.status_note || ''));
    const whole = checksumMatches(p);
    if (m) {
      return `The satellite stopped this capture early: it saved lines ${m[1]}–${m[2]} of ${m[3]}${whole ? ', and all of that came down' : ''}.`;
    }
    return 'The satellite stopped this capture early and saved only the top part of the frame.';
  }
  if (p.status === 'complete') return 'Complete, but there’s no checksum to check it against.';
  return null;
}

function checksumMatches(p) {
  const a = p.raw?.sha256;
  const b = p.raw?.sha256_expected;
  return typeof a === 'string' && typeof b === 'string' && a && a.toLowerCase() === b.toLowerCase();
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
  let showDark = false;
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
    return { el, pick, image, empty, place, time, status, remove, cap };
  }

  const cells = Array.from({ length: MAX_CELLS }, (_, i) => makeCell(i));
  const compareEl = h('div', { class: 'cat-compare', hidden: true }, cells.map((c) => c.el));
  const viewer = h('div', { class: 'cat-viewer' }, frame, compareEl);

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

  const count = h('p', { class: 'cat-count' });
  const filterToggle = h('button', {
    type: 'button', class: 'cat-text-btn cat-filter-toggle', 'aria-expanded': 'false', 'aria-controls': 'cat-filters',
  }, 'Filters');
  filterToggle.addEventListener('click', () => setFiltersOpen(filterUi.form.hidden));
  const dockEnd = h('div', { class: 'cat-dock-end' }, count, filterToggle);
  const dockRow = h('div', { class: 'cat-dock-row' }, modes, steps, dockEnd);

  const filterUi = createFilterForm({
    onChange: (key, value) => setFilter(key, value),
    idPrefix: 'cat-filter',
    className: 'filters cat-filters',
  });
  filterUi.form.id = 'cat-filters';
  filterUi.form.hidden = true;

  const strip = h('ol', { class: 'cat-strip', 'aria-label': 'Pictures, newest first' });
  const stripNote = h('p', { class: 'cat-strip-note', hidden: true });
  const darkText = h('span', { class: 'cat-dark-text' });
  const darkBtn = h('button', { type: 'button', class: 'cat-text-btn cat-dark-toggle' });
  darkBtn.addEventListener('click', () => toggleDark());
  const darkItem = h('li', { class: 'cat-strip-end' }, darkText, darkBtn);
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
  const actions = h('div', { class: 'cat-actions' },
    globeLink, globeOff, compareBtn, download, copyBtn, detailsLink);
  const emptyNote = h('p', { class: 'cat-empty-note', hidden: true });
  const info = h('div', { class: 'cat-info' }, title, when, status, emptyNote, facts, notes, actions, globeWhy);

  const grid = h('div', { class: 'cat-grid' }, viewer, dock, info);
  const notice = h('div', { class: 'cat-notice', role: 'status', hidden: true });
  const loadingText = h('p', { class: 'vh', role: 'status' }, 'Loading pictures…');
  const inner = h('div', { class: 'cat-in' }, backRow, missing, notice, grid, loadingText);
  const el = h('div', { class: 'cat', 'data-size': '1', 'data-state': 'loading' }, inner);
  root.append(el);
  drawLoading();

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
    for (const key of FILTER_KEYS) {
      const value = String(filters[key] || '').trim();
      if (value) params.set(key, value);
    }
    if (showDark) params.set('dark', '1');
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
    filters = readFilters(params);
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
    // A link straight to a dark frame opens it, with dark frames brought in.
    showDark = params.get('dark') === '1'
      || isDark(byId.get(currentId))
      || slots.some((s) => isDark(byId.get(s)));
  }

  /* Filters and dark frames */

  function setFiltersOpen(open) {
    filterUi.form.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
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
    const refocus = dock.contains(before) && !filterUi.form.contains(before);
    filters = readFilters(new URLSearchParams());
    filterUi.sync(filters);
    render();
    writeUrl();
    if (refocus && !isVisible(before)) filterToggle.focus({ preventScroll: true });
    announce(summaryText());
  }

  function summaryText() {
    if (!hasFilters(filters)) return plural(photos.length, 'picture');
    return `${shown.length} of ${plural(photos.length, 'picture')} shown: ${describeFilters(filters)}`;
  }

  function clearButton() {
    return h('button', { type: 'button', class: 'cat-text-btn', onclick: clearFilters }, 'Clear filters');
  }

  function toggleDark() {
    showDark = !showDark;
    keepFocus(() => render());
    writeUrl();
    // The strip was rebuilt around the button: keep focus on it.
    if (isVisible(darkBtn)) darkBtn.focus({ preventScroll: true });
    const n = matched.filter(isDark).length;
    announce(showDark ? `${plural(n, 'dark frame')} brought into the strip.` : `${plural(n, 'dark frame')} hidden.`);
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
    matched = applyFilters(photos, filters);
    shown = showDark ? matched : matched.filter((p) => !isDark(p));
    // With nothing to show, the viewer keeps the last picture.
    if (size === 1 && shown.length && !shown.some((p) => p.id === currentId)) currentId = nearestShown(currentId);
    if (size === 1 && !byId.has(currentId)) currentId = shown[0]?.id || photos[0]?.id || null;
    filterUi.markActive(filters);
    backRow.hidden = !canGoBack();
    el.classList.toggle('has-back', canGoBack());
    missing.hidden = !missingId;
    if (missingId) {
      missing.textContent = `There is no picture with the id “${missingId}”; it may have been renamed when the list was rebuilt. Showing ${size > 1 ? 'the others' : 'the newest'} instead.`;
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
  }

  function renderDock() {
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.size) === size));
    }
    const n = FILTER_KEYS.filter((key) => String(filters[key] || '').trim()).length;
    filterToggle.textContent = n ? `Filters (${n})` : 'Filters';
    count.replaceChildren(hasFilters(filters)
      ? `${shown.length} of ${plural(photos.length, 'picture')}`
      : plural(photos.length, 'picture'));
    if (hasFilters(filters)) count.append(clearButton());
  }

  function renderView() {
    el.dataset.size = String(size);
    const single = size === 1;
    frame.hidden = !single;
    compareEl.hidden = single;
    compareEl.dataset.size = String(size);
    if (single) updateSingle();
    else updateCompare();
    markStrip();
  }

  function setStep(button, target, word) {
    button.setAttribute('aria-disabled', String(!target));
    const label = `${word} picture`;
    button.setAttribute('aria-label', target ? `${label}: ${headline(target)}, ${whenShort(target)}` : `${label}: none`);
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
      cell.el.classList.toggle('is-active', isActive);
      cell.el.classList.toggle('is-empty', !p);
      cell.pick.setAttribute('aria-pressed', String(isActive));
      cell.remove.hidden = !p;
      cell.image.hidden = !p;
      cell.empty.hidden = Boolean(p);
      cell.place.hidden = !p;
      cell.time.hidden = !p;
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
      cell.pick.setAttribute('aria-label', `Cell ${i + 1}: ${headline(p)}, ${whenShort(p)}`);
      cell.place.textContent = headline(p);
      cell.time.textContent = whenShort(p);
      const word = p.status === 'verified' ? '' : capitalize(statusShort(p));
      cell.status.textContent = word;
      cell.status.hidden = !word;
      cell.remove.setAttribute('aria-label', `Remove ${headline(p)}, ${whenShort(p)}, from cell ${i + 1}`);
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
    if (d) {
      whenUtc.textContent = `${dayMonthYear(d)}, ${clock(d)} UTC`;
      whenLocal.textContent = calgaryLine(d) || '';
      whenLocal.hidden = !whenLocal.textContent;
    } else {
      whenUtc.textContent = p.captureDate ? 'Time of day unknown' : 'Date and time unknown';
      whenLocal.textContent = '';
      whenLocal.hidden = true;
    }
    const line = statusLine(p);
    status.textContent = line || '';
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
    detailsName.textContent = ` for ${headline(p)}, ${whenShort(p)}`;
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
      return [`${dayMonthYear(d)}, ${clock(d, true)} UTC`, second];
    }
    if (p.captureDate) return [dateText(p), 'Only the date is known'];
    return ['Not known', 'Neither the file name nor the logs give a time'];
  }

  function whereValue(p) {
    const pos = p.position;
    if (pos && !positionIsStale(p)) {
      const alt = Number.isFinite(pos.alt_km) ? `, ${Math.round(pos.alt_km)} km up` : '';
      return [`${latLon(pos.lat, pos.lon)}${alt}`, p.edited.position ? `Set by ${p.edited.position}` : 'Worked out from orbital elements'];
    }
    if (positionIsStale(p)) return ['Not worked out for the corrected time', 'The globe works it out from the corrected time'];
    if (p.capturedAt) return ['Not known', 'No orbital elements cover this time'];
    if (p.captureDate) return ['Not known', 'Only the date of this picture is known, so it isn’t on the globe.'];
    return ['Not known', 'There is no time to work it out from'];
  }

  function lightValue(p) {
    const pos = p.raw.position;
    if (!pos || typeof pos !== 'object' || p.edited.position || positionIsStale(p)) return null;
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
    const short = (d) => dayMonthYear(d).replace(/ \d{4}$/, '');
    let range = '';
    if (first && last && short(first) === short(last)) range = `${short(first)}, ${clock(first)} to ${clock(last)} UTC`;
    else if (first && last) range = `${short(first)} ${clock(first)} to ${short(last)} ${clock(last)} UTC`;
    else if (first || last) range = `${short(first || last)}, ${clock(first || last)} UTC`;
    const packets = Number.isFinite(dl.packets) ? plural(dl.packets, 'packet') : '';
    const value = [packets, range].filter(Boolean).join(', ');
    return value ? [value] : null;
  }

  function checkValue(p) {
    if (checksumMatches(p)) {
      return ['Matches the satellite’s checksum', p.status === 'truncated' ? 'For the shortened file it saved' : null];
    }
    if (p.raw.sha256_expected) {
      return p.status === 'partial'
        ? ['Can’t match the satellite’s checksum', 'Part of the file never came down']
        : ['Doesn’t match the satellite’s checksum'];
    }
    return ['No checksum from the satellite'];
  }

  function fileValue(p) {
    if (!p.raw.file) return null;
    const size = Number.isFinite(p.raw.file_size) ? `, ${Math.max(1, Math.round(p.raw.file_size / 1024))} KB` : '';
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
    }));
    button.addEventListener('click', () => onThumb(p.id));
    thumbs.set(p.id, button);
    return button;
  }

  // What to say when nothing is shown: maybe only dark frames match.
  function noMatchContent() {
    const darkN = matched.filter(isDark).length;
    if (!darkN || showDark) return ['No pictures match these filters. ', clearButton()];
    const show = h('button', { type: 'button', class: 'cat-text-btn', onclick: () => toggleDark() }, 'Show them');
    return [darkN === 1 ? 'Only a dark frame matches these filters. ' : `Only ${darkN} dark frames match these filters. `,
      show, ' ', clearButton()];
  }

  function renderStrip() {
    const none = !shown.length;
    strip.hidden = none;
    stripNote.hidden = !none;
    if (none) {
      stripNote.replaceChildren();
      append(stripNote, noMatchContent());
      strip.replaceChildren();
      stripKey = '';
      return;
    }
    const darkN = matched.filter(isDark).length;
    if (darkN) {
      darkText.textContent = `${plural(darkN, 'dark frame')} ${showDark ? 'shown.' : 'hidden.'}`;
      darkBtn.textContent = showDark ? 'Hide them' : 'Show them';
      darkBtn.setAttribute('aria-label', `${showDark ? 'Hide' : 'Show'} the ${plural(darkN, 'dark frame')}`);
    }
    const key = `${shown.map((p) => p.id).join('\n')}|${darkN ? 'dark' : ''}`;
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
    strip.replaceChildren(...items, ...(darkN ? [darkItem] : []));
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
