// The gallery: a filter row and a justified mosaic of thumbnails.

import { h, mono, joined, announce } from './dom.js';
import {
  CAMERAS, cameraShort, statusWord, latLon, toDate, utcShort, plural,
} from './format.js';
import {
  applyFilters, filtersToQuery, hasFilters, readFilters, FILTER_KEYS,
} from './data.js';
import { justifyRows, mosaicSettings, layoutRatio } from './layout.js';
import { createFilterForm } from './filters.js';

const EAGER_TILES = 8;

// Pictures left out of the grid unless their switch is on (dark=1, missing=1).
const TUCKED = [
  { key: 'dark', is: (p) => p.dark, one: 'dark frame', what: 'nothing but black, sensor noise or the Sun as a single dot' },
  { key: 'missing', is: (p) => p.mostlyMissing, one: 'mostly missing picture', what: 'less than a fifth of the picture can be shown' },
];
const THUMB_WIDTH = 480; // cts1_gallery/build.py THUMB_WIDTH

function gridAlt(p) {
  const camera = CAMERAS[p.camera]?.alt || 'Camera';
  if (p.place || p.computedPlace) return `${camera} image over ${p.place || p.computedPlace}`;
  if (p.position) return `${camera} image over ${latLon(p.position.lat, p.position.lon)}`;
  return `${camera} image, position unknown`;
}

function timeText(p) {
  const d = toDate(p.capturedAt);
  if (d) return mono(utcShort(d));
  if (p.captureDate) return [mono(p.captureDate), ', time unknown'];
  return 'time unknown';
}

const isWhole = (p) => p && p.camera === 'picam' && (p.status === 'verified' || p.status === 'complete');

// Whole PiCAM frames with some detail in them. File size is a cheap stand-in
// for detail: black night frames compress to almost nothing, so the smallest
// 40% of frames are passed over.
export function detailTest(photos) {
  const sizes = photos.filter(isWhole).map((p) => p.raw.file_size).filter(Number.isFinite).sort((a, b) => a - b);
  const floor = sizes.length ? sizes[Math.floor(sizes.length * 0.4)] : 0;
  return (p) => isWhole(p) && (!Number.isFinite(p.raw.file_size) || p.raw.file_size >= floor);
}

// Big tiles go to pairs of detailed frames.
export function featureTest(shown) {
  const good = detailTest(shown);
  return (start) => good(shown[start]) && good(shown[start + 1]);
}

export function createGallery(root, { onQueryChange }) {
  let photos = [];
  let filters = readFilters(new URLSearchParams());
  let shown = [];
  let ready = false;
  let structure = '';
  let rendered = false;
  let announceTimer = 0;
  const tiles = new Map();

  /* Filter row (the form itself is shared with the catalogue: filters.js) */

  const filterUi = createFilterForm({ onChange: (key, value) => setFilter(key, value) });
  const { form, search } = filterUi;
  form.hidden = true;

  const summary = h('p', { class: 'filter-summary' });
  form.append(summary);

  /* Mosaic */

  const notice = h('div', { class: 'notice', role: 'status' }, 'Loading pictures…');
  const list = h('ul', { class: 'mosaic', 'aria-label': 'Pictures, newest first' });
  const hiddenNote = h('p', { class: 'hidden-note', hidden: true });
  const wrap = h('div', { class: 'mosaic-wrap' }, list, hiddenNote);
  root.append(form, notice, wrap);

  const observer = new ResizeObserver(() => layout());
  observer.observe(list);

  function setFilter(key, value) {
    filters = { ...filters, [key]: value };
    const query = filtersToQuery(filters);
    history.replaceState(history.state, '', query ? `#/?${query}` : '#/');
    onQueryChange(query);
    render();
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => announce(summaryText()), 500);
  }

  function clearFilters() {
    // The button that was used goes away with the filters: if it had focus,
    // put focus on the search box, just before where it was.
    const active = document.activeElement;
    const refocus = summary.contains(active) || notice.contains(active);
    for (const key of FILTER_KEYS) filters[key] = '';
    history.replaceState(history.state, '', '#/');
    onQueryChange('');
    syncControls();
    render();
    if (refocus) search.focus({ preventScroll: true });
    announce(summaryText());
  }

  function summaryText() {
    if (!hasFilters(filters)) return `${plural(photos.length, 'picture')}`;
    return `${shown.length} of ${plural(photos.length, 'picture')} shown`;
  }

  function syncControls() {
    filterUi.sync(filters);
  }

  function markActive() {
    filterUi.markActive(filters);
  }

  function render() {
    if (!ready) return;
    shown = applyFilters(photos, filters);
    markActive();
    summary.replaceChildren();
    if (hasFilters(filters)) {
      summary.append(
        h('span', null, `${shown.length} of ${photos.length}`),
        h('button', { type: 'button', class: 'linkish', onclick: clearFilters }, 'Clear filters'),
      );
    }
    // Frames with nothing to see, and pictures that are mostly missing, stay
    // out of the grid until asked for.
    const tucked = TUCKED.map((kind) => ({
      ...kind,
      count: applyFilters(photos, { ...filters, [kind.key]: '1' }).filter(kind.is).length,
      toggle: () => setFilter(kind.key, filters[kind.key] ? '' : '1'),
    })).filter((kind) => kind.count);
    hiddenNote.hidden = !tucked.length;
    hiddenNote.replaceChildren(...tucked.map((kind) => h('span', { class: 'hidden-line' },
      filters[kind.key]
        ? `Showing ${plural(kind.count, kind.one)}: ${kind.what}.`
        : `${plural(kind.count, kind.one)} hidden: ${kind.what}.`,
      h('button', { type: 'button', class: 'linkish', onclick: kind.toggle }, filters[kind.key] ? 'Hide them' : 'Show them'))));
    const stillHidden = tucked.filter((kind) => !filters[kind.key]);
    if (!photos.length) {
      showNotice(['No pictures yet. The list is empty until the first image has been reassembled.']);
    } else if (!shown.length && stillHidden.length) {
      showNotice([
        'Only hidden pictures match these filters.',
        h('button', {
          type: 'button',
          class: 'linkish',
          onclick: () => {
            for (const kind of stillHidden) filters[kind.key] = '1';
            setFilter(stillHidden[0].key, '1');
          },
        }, 'Show them'),
      ]);
    } else if (!shown.length) {
      showNotice([
        'No pictures match these filters.',
        h('button', { type: 'button', class: 'linkish', onclick: clearFilters }, 'Clear filters'),
      ]);
    } else {
      notice.hidden = true;
      wrap.hidden = false;
    }
    structure = '';
    rendered = true;
    layout();
  }

  function showNotice(content) {
    notice.replaceChildren(...content);
    notice.hidden = false;
    wrap.hidden = true;
    list.replaceChildren();
  }

  function tileFor(p, index) {
    let li = tiles.get(p.id);
    if (li) return li;
    const ratio = layoutRatio(p.width, p.height);
    const img = h('img', {
      src: p.thumb,
      // Tiles wider than a thumbnail (featured rows) load the full picture
      // rather than stretching the thumbnail; layout() sets `sizes`.
      srcset: p.src !== p.thumb && p.width > THUMB_WIDTH ? `${p.thumb} ${THUMB_WIDTH}w, ${p.src} ${p.width}w` : null,
      width: p.width,
      height: p.height,
      alt: gridAlt(p),
      loading: index < EAGER_TILES ? 'eager' : 'lazy',
      decoding: 'async',
    });
    const caption = h('span', { class: 'cap' },
      h('span', { class: 'cap-title', title: p.title }, p.title),
      h('span', { class: 'cap-meta' },
        joined([timeText(p), cameraShort(p.camera), statusWord(p.status)])));
    const link = h('a', { href: `#/photo/${encodeURIComponent(p.id)}`, 'data-id': p.id },
      h('span', { class: 'frame', style: `aspect-ratio: ${ratio.toFixed(4)}` }, img),
      caption);
    li = h('li', { class: 'tile' }, link);
    tiles.set(p.id, li);
    return li;
  }

  function layout() {
    if (!ready || root.hidden || wrap.hidden || !shown.length) return;
    const width = list.clientWidth;
    if (!width) return;
    const settings = { ...mosaicSettings(width), canFeature: featureTest(shown) };
    const ratios = shown.map((p) => layoutRatio(p.width, p.height));
    const rows = justifyRows(ratios, settings);
    const next = rows.map((r) => `${r.count}${r.ragged ? 'r' : ''}`).join(',');

    if (next === structure) {
      // Same rows as before: only a lone last row needs its size updated.
      for (const row of rows) {
        if (!row.ragged) continue;
        for (let k = 0; k < row.count; k++) {
          const i = row.start + k;
          tiles.get(shown[i].id).style.flex = `0 0 ${(ratios[i] * row.height).toFixed(2)}px`;
        }
      }
      return;
    }
    structure = next;

    const frag = document.createDocumentFragment();
    rows.forEach((row, r) => {
      if (r > 0) frag.append(h('li', { class: 'mosaic-break', 'aria-hidden': 'true' }));
      for (let k = 0; k < row.count; k++) {
        const i = row.start + k;
        const li = tileFor(shown[i], i);
        li.style.flex = row.ragged
          ? `0 0 ${(ratios[i] * row.height).toFixed(2)}px`
          : `${ratios[i].toFixed(4)} 1 0px`;
        li.querySelector('img').sizes = `${Math.ceil(ratios[i] * row.height)}px`;
        frag.append(li);
      }
    });
    list.replaceChildren(frag);
  }

  return {
    // New or changed data: rebuild the options and the tiles.
    setData(nextPhotos) {
      photos = nextPhotos;
      filterUi.setPhotos(photos);
      ready = true;
      tiles.clear();
      form.hidden = !photos.length;
      syncControls();
      rendered = false;
    },

    showError(content) {
      ready = false;
      form.hidden = true;
      showNotice(content);
    },

    // Called when the gallery route is shown, with the query from the URL.
    show(params) {
      const next = readFilters(params);
      const same = FILTER_KEYS.every((key) => next[key] === filters[key].trim());
      filters = next;
      if (!ready) return;
      syncControls();
      if (!same || !rendered) render();
      else {
        markActive();
        layout();
      }
    },

    focusTile(id) {
      const link = list.querySelector(`a[data-id="${CSS.escape(id)}"]`);
      if (!link) return false;
      link.focus({ preventScroll: true });
      const box = link.getBoundingClientRect();
      if (box.top < 0 || box.bottom > window.innerHeight) link.scrollIntoView({ block: 'center' });
      return true;
    },
  };
}
