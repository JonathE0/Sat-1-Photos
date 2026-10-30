// The filter form shared by the gallery and the catalogue: camera, status,
// month, member and tag menus and a search box. The caller owns the filter
// values (readFilters in data.js) and decides what a change does: the form
// only reports each change through onChange(key, value), including every
// keystroke in the search box.

import { h } from './dom.js';
import { cameraShort, monthLabel, statusWord, STATUSES } from './format.js';
import { filterOptions } from './data.js';

const CAMERA_ORDER = ['picam', 'adcs'];

// The same words as the picture's facts, not the pipeline's.
const CAMERA_WORDS = { picam: 'Main camera', adcs: 'Attitude camera' };
const STATUS_WORDS = {
  verified: 'Checked',
  complete: 'Complete, unchecked',
  partial: 'Partly missing',
  truncated: 'Cut short on board',
};

export const cameraLabel = (camera) => CAMERA_WORDS[camera] || cameraShort(camera);
export const statusLabel = (status) => STATUS_WORDS[status] || statusWord(status);

export function createFilterForm({
  onChange,
  idPrefix = 'filter',
  className = 'filters',
  label = 'Filter pictures',
}) {
  let photos = [];

  const form = h('form', {
    class: className,
    role: 'search',
    'aria-label': label,
    onsubmit: (e) => e.preventDefault(),
  });

  const selects = {};
  const fields = {};

  const makeSelect = (key, text) => {
    const id = `${idPrefix}-${key}`;
    const select = h('select', { id, name: key });
    select.addEventListener('change', () => onChange(key, select.value));
    selects[key] = select;
    fields[key] = h('div', { class: 'filter' },
      h('label', { class: 'filter-label', for: id }, text),
      select);
    return fields[key];
  };

  const search = h('input', {
    type: 'search',
    id: `${idPrefix}-q`,
    name: 'q',
    placeholder: 'Titles, notes, tags, people, files',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  search.addEventListener('input', () => onChange('q', search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      search.value = '';
      onChange('q', '');
    }
  });
  fields.q = h('div', { class: 'search' },
    h('label', { class: 'filter-label', for: `${idPrefix}-q` }, 'Search'),
    search);

  form.append(
    makeSelect('camera', 'Camera'),
    makeSelect('status', 'Status'),
    makeSelect('month', 'Month'),
    makeSelect('member', 'Member'),
    makeSelect('tag', 'Tag'),
    fields.q,
  );

  function fillSelect(select, entries, current) {
    const values = entries.map(([value]) => value);
    if (current && !values.some((v) => v.toLowerCase() === current.toLowerCase())) {
      entries = [...entries, [current, `${current} (no pictures)`]];
    }
    select.replaceChildren(...entries.map(([value, text]) => h('option', { value }, text)));
    const match = entries.find(([value]) => value.toLowerCase() === (current || '').toLowerCase());
    select.value = match ? match[0] : '';
  }

  // Rebuilds the menus from the pictures and shows the given filter values.
  function sync(filters) {
    const options = filterOptions(photos);
    const cameras = [...options.cameras].sort((a, b) => {
      const ia = CAMERA_ORDER.indexOf(a); const ib = CAMERA_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    fillSelect(selects.camera, [['', 'All'], ...cameras.map((c) => [c, cameraLabel(c)])], filters.camera);
    const statusOrder = STATUSES.map(([s]) => s);
    const statuses = [...options.statuses].sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
    fillSelect(selects.status, [['', 'All'], ...statuses.map((s) => [s, statusLabel(s)])], filters.status);
    fillSelect(selects.month, [['', 'All'], ...options.months.map((m) => [m, monthLabel(m)])], filters.month);

    // Member and Tag stay out of sight until someone has named a person or
    // tagged a picture (or a link asks for one).
    const hasMembers = Boolean(options.members.length || filters.member);
    fillSelect(selects.member, [['', 'Anyone'], ...options.members.map((m) => [m, m])], filters.member);
    fields.member.hidden = !hasMembers;

    const hasTags = Boolean(options.tags.length || filters.tag);
    fillSelect(selects.tag, [['', 'Any'], ...options.tags.map((t) => [t, t])], filters.tag);
    fields.tag.hidden = !hasTags;

    if (document.activeElement !== search) search.value = filters.q;
  }

  // Marks the menus and the search box that hold a value.
  function markActive(filters) {
    for (const [key, select] of Object.entries(selects)) select.classList.toggle('is-set', Boolean(filters[key]));
    search.classList.toggle('is-set', Boolean(String(filters.q || '').trim()));
  }

  return {
    form,
    search,
    selects,
    fields,
    setPhotos(list) { photos = Array.isArray(list) ? list : []; },
    sync,
    markActive,
  };
}

// The active filters in words, for a summary line: "Main camera, Sep 2026, tagged clouds".
export function describeFilters(filters) {
  const words = [];
  if (filters.camera) words.push(cameraLabel(filters.camera));
  if (filters.status) words.push(statusLabel(filters.status).toLowerCase());
  if (filters.month) words.push(monthLabel(filters.month));
  if (filters.member) words.push(`with ${filters.member}`);
  if (filters.tag) words.push(`tagged ${filters.tag}`);
  const q = String(filters.q || '').trim();
  if (q) words.push(`matching “${q}”`);
  return words.join(', ');
}
