// The gallery: a filter row and a justified mosaic of thumbnails.

import { h, mono, joined, announce } from './dom.js';
import {
  CAMERAS, cameraShort, statusWord, STATUSES, monthLabel, latLon, toDate, utcShort, plural,
} from './format.js';
import {
  applyFilters, filterOptions, filtersToQuery, hasFilters, readFilters, FILTER_KEYS,
} from './data.js';
import { justifyRows, mosaicSettings, layoutRatio } from './layout.js';

const EAGER_TILES = 8;

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

  /* Filter row */

  const form = h('form', {
    class: 'filters',
    role: 'search',
    'aria-label': 'Filter pictures',
    hidden: true,
    onsubmit: (e) => e.preventDefault(),
  });

  const selects = {};
  const makeSelect = (key, label) => {
    const select = h('select', { id: `filter-${key}`, name: key });
    select.addEventListener('change', () => setFilter(key, select.value));
    selects[key] = select;
    return h('div', { class: 'filter' },
      h('label', { class: 'filter-label', for: `filter-${key}` }, label),
      select);
  };

  const search = h('input', {
    type: 'search',
    id: 'filter-q',
    name: 'q',
    placeholder: 'Titles, notes, tags, people, files',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  search.addEventListener('input', () => setFilter('q', search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      search.value = '';
      setFilter('q', '');
    }
  });

  const summary = h('p', { class: 'filter-summary' });

  form.append(
    makeSelect('camera', 'Camera'),
    makeSelect('status', 'Status'),
    makeSelect('month', 'Month'),
    makeSelect('member', 'Member'),
    makeSelect('tag', 'Tag'),
    h('div', { class: 'search' },
      h('label', { class: 'filter-label', for: 'filter-q' }, 'Search'),
      search),
    summary,
  );

  /* Mosaic */

  const notice = h('div', { class: 'notice', role: 'status' }, 'Loading pictures…');
  const list = h('ul', { class: 'mosaic', 'aria-label': 'Pictures, newest first' });
  const wrap = h('div', { class: 'mosaic-wrap' }, list);
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

  function fillSelect(select, entries, current) {
    const values = entries.map(([value]) => value);
    if (current && !values.some((v) => v.toLowerCase() === current.toLowerCase())) {
      entries = [...entries, [current, `${current} (no pictures)`]];
    }
    select.replaceChildren(...entries.map(([value, label]) => h('option', { value }, label)));
    const match = entries.find(([value]) => value.toLowerCase() === (current || '').toLowerCase());
    select.value = match ? match[0] : '';
  }

  function syncControls() {
    const options = filterOptions(photos);
    const cameraOrder = ['picam', 'adcs'];
    const cameras = [...options.cameras].sort((a, b) => {
      const ia = cameraOrder.indexOf(a); const ib = cameraOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    fillSelect(selects.camera, [['', 'All'], ...cameras.map((c) => [c, cameraShort(c)])], filters.camera);
    const statusOrder = STATUSES.map(([s]) => s);
    const statuses = [...options.statuses].sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
    fillSelect(selects.status, [['', 'All'], ...statuses.map((s) => [s, statusWord(s)])], filters.status);
    fillSelect(selects.month, [['', 'All'], ...options.months.map((m) => [m, monthLabel(m)])], filters.month);

    const memberEntries = options.members.length || filters.member
      ? [['', 'Anyone'], ...options.members.map((m) => [m, m])]
      : [['', 'No names yet']];
    fillSelect(selects.member, memberEntries, filters.member);
    selects.member.disabled = !options.members.length && !filters.member;

    const tagEntries = options.tags.length || filters.tag
      ? [['', 'Any'], ...options.tags.map((t) => [t, t])]
      : [['', 'No tags yet']];
    fillSelect(selects.tag, tagEntries, filters.tag);
    selects.tag.disabled = !options.tags.length && !filters.tag;

    if (document.activeElement !== search) search.value = filters.q;
  }

  function markActive() {
    for (const [key, select] of Object.entries(selects)) select.classList.toggle('is-set', Boolean(filters[key]));
    search.classList.toggle('is-set', Boolean(filters.q.trim()));
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
    if (!photos.length) {
      showNotice(['No pictures yet. The list is empty until the first image has been reassembled.']);
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
        frag.append(li);
      }
    });
    list.replaceChildren(frag);
  }

  return {
    // New or changed data: rebuild the options and the tiles.
    setData(nextPhotos) {
      photos = nextPhotos;
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
