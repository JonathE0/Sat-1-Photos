// The detail view: the picture on slate, an info panel, the edit form and the history.

import { h, mono, joined, announce, store, copyText } from './dom.js';
import {
  CAMERAS, basisText, bytes, calgary, cameraLong, clock, dayMonthYear, inputTime, isoDay, isoUTC,
  latLon, parseUtcInput, percent, plural, shortHash, statusWord, toDate, utcLong,
} from './format.js';
import { memberValues, saveAnnotation } from './data.js';

export const NAME_KEY = 'cts1-gallery:name';
const KEY_KEY = 'cts1-gallery:edit-key';
const HISTORY_SHOWN = 6;
const MAX_TEXT = 2000; // title, notes, place (serve.py's limits)
const MAX_ITEM = 60;   // one person or tag
const MAX_ITEMS = 50;  // people or tags per picture

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

function sub(content, extra = '') {
  return h('span', { class: `sub${extra ? ` ${extra}` : ''}` }, content);
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function truncate(text, n) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function listWords(words) {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// "Jordan K., Priya S." -> ["Jordan K.", "Priya S."], without blanks or repeats.
export function parseList(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text).split(',')) {
    const item = part.trim().replace(/\s+/g, ' ');
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameTime(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return toDate(a)?.getTime() === toDate(b)?.getTime();
}

// Alt text for the large image.
function detailAlt(p) {
  const camera = CAMERAS[p.camera]?.alt || 'Camera';
  const d = toDate(p.capturedAt);
  let when = 'taken at an unknown time';
  if (d) when = `taken ${utcLong(d, false)}`;
  else if (p.captureDate) when = `taken on ${dayMonthYear(toDate(p.captureDate))}`;
  // A computed place belongs to the computed time, not a member's edited one.
  const stale = p.edited.captured_at && !p.edited.position && !sameTime(p.capturedAt, p.raw.captured_at);
  let where = '';
  if (p.place) where = ` over ${p.place}`;
  else if (!stale && p.computedPlace) where = ` over ${p.computedPlace}`;
  else if (!stale && p.position) where = ` over ${latLon(p.position.lat, p.position.lon)}`;
  const parts = [];
  if (p.title !== p.defaultTitle) parts.push(`${p.title}.`);
  parts.push(`${camera} image from CTS-SAT-1, ${when}${where}.`);
  if (p.status === 'partial') parts.push('Parts of the image are missing.');
  if (p.status === 'truncated') parts.push('Only the top of the frame exists.');
  return parts.join(' ');
}

// How far the on-board clock a capture time was read from was off (see
// satellite_clock in docs/DATA.md).
function clockText(clockInfo) {
  if (!isObject(clockInfo)) return null;
  const c = clockInfo.correction_s;
  if (!Number.isFinite(c)) {
    return 'Read off an on-board clock that nothing in the data can check: it may be a minute or so off.';
  }
  if (c === 0) return 'The satellite’s clock was checked and was right.';
  const s = Math.abs(c);
  return `The satellite’s clock was ${s.toFixed(s < 10 ? 1 : 0)} s ${c < 0 ? 'fast' : 'slow'}; corrected for that.`;
}

// The one-line note under a partial picture.
function shotNote(p) {
  if (p.status === 'partial') {
    const pct = percent(p.raw.completeness);
    // A main-camera picture's completeness is how much of it can be shown,
    // not how much arrived: its JPEG can't be decoded past a gap.
    if (p.camera === 'picam') {
      return pct
        ? `Partial: only the part above the first missing line can be shown (${pct} of the file). The camera’s JPEGs can’t be decoded past a gap, so the grey below it is mostly data that did arrive.`
        : 'Partial: only the part above the first missing line can be shown. The camera’s JPEGs can’t be decoded past a gap.';
    }
    return pct
      ? `Partial: ${pct} of this picture came down. The gaps are data that never arrived.`
      : 'Partial: some of this picture never came down. The gaps are data that never arrived.';
  }
  if (p.status === 'truncated') {
    return 'Cut short on board: the satellite stored only the top part of this frame.';
  }
  return null;
}

const EDIT_FIELDS = ['title', 'place', 'notes', 'people', 'tags', 'captured_at', 'lat', 'lon'];

const FIELD_NAMES = {
  title: 'title',
  notes: 'notes',
  place: 'place',
  people: 'people',
  tags: 'tags',
  captured_at: 'capture time',
  lat: 'position',
  lon: 'position',
};

function describeChange(changes) {
  if (!isObject(changes) || !Object.keys(changes).length) return 'made a change';
  const keys = Object.keys(changes);
  const fields = [...new Set(keys.map((k) => FIELD_NAMES[k] || k))];
  if (fields.length > 1) return `edited the ${listWords(fields)}`;
  const field = fields[0];
  const pairOf = (k) => (Array.isArray(changes[k]) && changes[k].length === 2 ? changes[k] : [undefined, changes[k]]);
  if (field === 'position') {
    const afterLat = changes.lat ? pairOf('lat')[1] : undefined;
    const afterLon = changes.lon ? pairOf('lon')[1] : undefined;
    if (keys.every((k) => isEmpty(pairOf(k)[1]))) return 'cleared the position';
    if (Number.isFinite(afterLat) && Number.isFinite(afterLon)) return `set the position to ${latLon(afterLat, afterLon)}`;
    return 'changed the position';
  }
  const [before, after] = pairOf(keys[0]);
  if (isEmpty(after)) return `cleared the ${field}`;
  const verb = isEmpty(before) ? 'set' : 'changed';
  let shown = null;
  if (Array.isArray(after)) shown = truncate(after.join(', '), 70);
  else if (field === 'capture time') shown = toDate(after) ? utcLong(toDate(after)) : null;
  else if (typeof after === 'string' && field !== 'notes') shown = `“${truncate(after, 70)}”`;
  if (field === 'notes') return isEmpty(before) ? 'added notes' : 'changed the notes';
  return shown ? `${verb} the ${field} to ${shown}` : `${verb} the ${field}`;
}

// Opened from the orbit globe: #/photo/<id>?globe=<the globe's link state>
// (t, photo, view). The way back only ever leads to the site's own globe page.
function globeHref() {
  const hash = location.hash;
  const qi = hash.indexOf('?');
  const state = qi < 0 ? null : new URLSearchParams(hash.slice(qi + 1)).get('globe');
  return state && /^[\w.:,=&%+-]+$/.test(state) ? `globe/index.html#${state}` : null;
}

function backToGlobe(href) {
  // Came straight from the globe in this tab: step back, so it returns just as it was left.
  let from = null;
  try { from = new URL(document.referrer); } catch { /* no referrer */ }
  const target = new URL(href, location.href);
  if (history.length > 1 && from && from.origin === target.origin && from.pathname === target.pathname) history.back();
  else location.assign(target.href);
}

// The picture's own address, without the way back to someone's globe view.
function pictureUrl(p) {
  return new URL(`#/photo/${encodeURIComponent(p.id)}`, location.href).href;
}

function globeLink(href, attrs, ...children) {
  return h('a', {
    ...attrs,
    href,
    onclick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      backToGlobe(href);
    },
  }, ...children);
}

export function createDetail(root, ctx) {
  let currentId = null;
  let form = null; // { dirty(), setName(name), focusSave() } for the open edit form

  function stepLink(target, dir) {
    const word = dir === 'prev' ? 'Previous' : 'Next';
    const arrow = h('span', { 'aria-hidden': 'true' }, dir === 'prev' ? '←' : '→');
    const text = h('span', { class: 'step-text' }, word);
    const content = dir === 'prev' ? [arrow, text] : [text, arrow];
    if (!target) return h('span', { class: `step step-${dir} is-off`, 'aria-hidden': 'true' }, content);
    const link = h('a', {
      class: `step step-${dir}`,
      href: `#/photo/${encodeURIComponent(target.id)}`,
      'aria-label': `${word} picture: ${target.title}`,
      'data-step': dir,
    }, content);
    link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      ctx.go(target.id, dir);
    });
    return link;
  }

  function stage(p, prev, next, globe) {
    const note = shotNote(p);
    return h('div', { class: 'stage-wrap' },
      h('div', { class: 'stage' },
        h('figure', { class: 'shot' },
          h('img', {
            src: p.src,
            width: p.width,
            height: p.height,
            alt: detailAlt(p),
            decoding: 'async',
            fetchpriority: 'high',
            style: `max-width: ${p.width}px`, // never past its own size: the frames are small and grainy enlarged
          }),
          note && h('figcaption', { class: 'shot-note' }, note)),
        h('nav', { class: 'stepper', 'aria-label': 'Browse pictures' },
          stepLink(prev, 'prev'),
          globe && globeLink(globe, { class: 'step step-globe' }, 'Back to globe'),
          stepLink(next, 'next'))));
  }

  /* Info rows */

  function capturedValue(p) {
    const raw = p.raw;
    const d = toDate(p.capturedAt);
    if (d) {
      const out = [mono(utcLong(d, true))];
      if (p.edited.captured_at) {
        out.push(sub(`edited by ${p.edited.captured_at}`, 'edited'));
        const original = toDate(raw.captured_at);
        out.push(sub(original
          ? ['Computed: ', mono(utcLong(original, true)), raw.capture_basis ? `, ${basisText(raw.capture_basis)}` : '']
          : 'There was no computed time.', 'small'));
      } else {
        const basis = basisText(raw.capture_basis);
        if (basis) out.push(sub(capitalize(basis)));
        const clockNote = clockText(raw.satellite_clock);
        if (clockNote) out.push(sub(clockNote, 'small'));
      }
      const local = calgary(d);
      if (local) out.push(sub([mono(local), ' in Calgary'], 'small'));
      return out;
    }
    if (p.captureDate) {
      return [mono(dayMonthYear(toDate(p.captureDate))), sub('Date only; the time of day is unknown.')];
    }
    return ['Unknown', sub('Neither the file name nor the logs give a capture time.')];
  }

  function positionValue(p) {
    const pos = p.position;
    if (!pos) {
      if (p.edited.captured_at) {
        return ['Not computed for the edited time', sub('The globe works it out from the edited time: use Show on globe.')];
      }
      return p.capturedAt
        ? ['Not computed', sub('No orbit data covers this time.')]
        : ['Unknown', sub('A position needs a capture time.')];
    }
    const out = [mono(`≈ ${latLon(pos.lat, pos.lon)}`)];
    if (p.edited.position) out.push(sub(`edited by ${p.edited.position}`, 'edited'));
    if (p.computedPlace) out.push(h('span', { class: 'line' }, p.computedPlace));
    if (Number.isFinite(pos.alt_km)) out.push(sub(`Altitude ${Math.round(pos.alt_km)} km`));
    if (typeof pos.ground_sunlit === 'boolean') {
      const e = pos.sun_elevation_deg;
      const sun = Number.isFinite(e) ? ` (sun ${Math.abs(e).toFixed(0)}° ${e >= 0 ? 'above' : 'below'} the horizon)` : '';
      out.push(sub(`Ground below: ${pos.ground_sunlit ? 'daylight' : 'night'}${sun}`));
    }
    const light = {
      sunlit: 'sunlit',
      terminator: 'on the day–night line, with the sun at Earth’s edge',
      shadow: 'in Earth’s shadow',
    }[pos.satellite_light];
    if (light) {
      out.push(sub(`Satellite: ${light}`));
    } else if (typeof pos.satellite_sunlit === 'boolean') {
      out.push(sub(`Satellite: ${pos.satellite_sunlit ? 'sunlit' : 'in Earth’s shadow'}`));
    }
    const computed = isObject(p.raw.position);
    if (computed && p.edited.position) {
      out.push(sub('Altitude and light are from the computed position.', 'small'));
    } else if (computed && p.edited.captured_at) {
      out.push(sub('Computed for the original capture time, not the edited one.', 'small'));
    }
    if (computed && p.raw.position.basis) {
      const epoch = toDate(p.raw.position.tle_epoch);
      out.push(sub(`${capitalize(p.raw.position.basis)}${epoch ? ` (epoch ${utcLong(epoch, false)})` : ''}.`, 'small'));
    }
    return out;
  }

  function downlinkValue(p) {
    const dl = isObject(p.raw.downlink) ? p.raw.downlink : {};
    const first = toDate(dl.first);
    const last = toDate(dl.last);
    const out = [];
    if (first && last && isoDay(first) === isoDay(last)) {
      out.push(mono(`${dayMonthYear(first)}, ${clock(first)}–${clock(last)} UTC`));
    } else if (first && last) {
      out.push(mono([`${dayMonthYear(first)}, ${clock(first)} –`, h('br'), `${dayMonthYear(last)}, ${clock(last)} UTC`]));
    } else if (first || last) {
      out.push(mono(utcLong(first || last, false)));
    } else {
      out.push('Unknown');
    }
    if (Number.isFinite(dl.packets)) out.push(sub(plural(dl.packets, 'packet')));
    return out;
  }

  function fileValue(p) {
    const raw = p.raw;
    const out = [];
    if (raw.file) out.push(mono(raw.file));
    const size = bytes(raw.file_size);
    if (size) out.push(sub(size));
    if (typeof raw.sha256 === 'string' && raw.sha256) {
      const parts = ['sha256 ', h('span', { class: 'mono', title: raw.sha256 }, shortHash(raw.sha256))];
      const expected = typeof raw.sha256_expected === 'string' ? raw.sha256_expected : '';
      if (expected && expected.toLowerCase() === raw.sha256.toLowerCase()) {
        parts.push(p.status === 'verified' ? ', matches satellite' : ', matches the satellite’s hash');
      } else if (expected) {
        parts.push(', the satellite reported ', h('span', { class: 'mono', title: expected }, shortHash(expected)));
      } else {
        parts.push(', no hash from the satellite');
      }
      out.push(sub(parts));
    }
    return out.length ? out : ['Unknown'];
  }

  function statusValue(p) {
    const word = statusWord(p.status);
    const pct = percent(p.raw.completeness);
    const verb = p.camera === 'picam' ? 'shown' : 'received';
    const out = [p.status === 'partial' && pct ? `${word}, ${pct} ${verb}` : word];
    if (typeof p.raw.status_note === 'string' && p.raw.status_note) out.push(sub(p.raw.status_note));
    return out;
  }

  function facts(p) {
    const rows = [
      ['Captured', capturedValue(p)],
      ['Position', positionValue(p)],
      ['Camera', [cameraLong(p.camera), sub(`${p.width} × ${p.height} pixels`)]],
      ['Downlinked', downlinkValue(p)],
      ['File', fileValue(p)],
      ['Status', statusValue(p)],
    ];
    return h('dl', { class: 'facts' }, rows.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, value)]));
  }

  function plainLinks(items, key) {
    return h('span', { class: 'plain-list' }, joined(items.map((item) => h('a', {
      href: `#/?${new URLSearchParams({ [key]: item })}`,
      title: `All pictures with ${item}`,
    }, item)), ', '));
  }

  function membersSection(p) {
    const by = (name) => name && sub(`by ${name}`, 'edited');
    const rows = [];
    if (p.notes) rows.push(['Notes', [h('span', { style: 'white-space: pre-line' }, p.notes), by(p.edited.notes)]]);
    if (p.place) rows.push(['Place', [p.place, by(p.edited.place)]]);
    if (p.people.length) rows.push(['People', [plainLinks(p.people, 'member'), by(p.edited.people)]]);
    if (p.tags.length) rows.push(['Tags', [plainLinks(p.tags, 'tag'), by(p.edited.tags)]]);
    return h('section', { class: 'panel-section', 'aria-labelledby': 'members-heading' },
      h('h2', { id: 'members-heading' }, 'From members'),
      rows.length
        ? h('dl', { class: 'facts facts-flush' }, rows.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, value)]))
        : h('p', { class: 'section-note' }, 'No notes, places, people or tags yet.'));
  }

  function linksRow(p) {
    const items = [];
    if (p.capturedAt) {
      items.push(h('a', { href: `globe/index.html?photo=${encodeURIComponent(p.id)}` }, 'Show on globe'));
    }
    const fileName = String(p.src || '').split('/').pop() || `${p.id}.jpg`;
    items.push(h('a', { href: p.src, download: `cts-sat-1-${fileName}` }, 'Download image'));
    const copy = h('button', { type: 'button', class: 'linkish' }, 'Copy link');
    let timer = 0;
    copy.addEventListener('click', async () => {
      const ok = await copyText(pictureUrl(p));
      copy.textContent = ok ? 'Link copied' : 'Copy failed';
      announce(ok ? 'Link copied' : 'Could not copy the link');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
    });
    items.push(copy);
    return h('p', { class: 'links' }, items);
  }

  function readonlyLine(p) {
    const line = ctx.readOnlyServer()
      ? 'Editing is turned off on this server.'
      : 'Team members add titles, notes and tags on the team’s own copy of this gallery.';
    const repo = String(ctx.config.repoUrl || '').trim().replace(/\/+$/, '');
    let suggest = null;
    if (/^https?:\/\//i.test(repo)) {
      const title = `Correction for ${p.id}`;
      const body = [
        `Picture: ${p.title}`,
        `ID: ${p.id}`,
        `File: ${p.raw.file || ''}`,
        `Link: ${pictureUrl(p)}`,
        '',
        'What should change? (title, notes, place, people, tags, capture time or position)',
        '',
      ].join('\n');
      suggest = h('a', {
        class: 'text-link',
        href: `${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
        target: '_blank',
        rel: 'noopener',
      }, 'Suggest a correction');
    }
    return h('p', { class: 'readonly' }, line, suggest && ' ', suggest);
  }

  /* Edit form */

  function editSection(p, flash) {
    const values = memberValues(p.ann);
    const raw = p.raw;
    const launch = toDate(ctx.satellite()?.launched_at);

    const field = (id, labelText, control, hint, extra = {}) => {
      const hintEl = hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null;
      if (hintEl) control.setAttribute('aria-describedby', `${id}-hint`);
      return {
        el: h('div', { class: 'field', ...extra }, h('label', { for: id }, labelText), control, hintEl),
        hint: hintEl,
      };
    };

    const title = h('input', { id: 'edit-title', value: values.title, placeholder: p.defaultTitle, maxlength: MAX_TEXT });
    const place = h('input', { id: 'edit-place', value: values.place, placeholder: 'For example, Hudson Bay', maxlength: MAX_TEXT });
    const notes = h('textarea', { id: 'edit-notes', rows: 4, maxlength: MAX_TEXT });
    notes.value = values.notes;
    const people = h('input', { id: 'edit-people', value: values.people.join(', '), placeholder: 'For example, Jordan K., Priya S.', autocomplete: 'off' });
    const tags = h('input', { id: 'edit-tags', value: values.tags.join(', '), placeholder: 'For example, clouds, coastline', autocomplete: 'off' });

    const original = toDate(raw.captured_at);
    const time = h('input', {
      id: 'edit-time',
      class: 'mono-input',
      value: values.captured_at ? inputTime(toDate(values.captured_at)) : '',
      placeholder: original ? inputTime(original) : 'YYYY-MM-DD HH:MM:SS',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const computedPos = isObject(raw.position) && Number.isFinite(raw.position.lat) ? raw.position : null;
    const lat = h('input', {
      id: 'edit-lat', class: 'mono-input', inputmode: 'decimal', autocomplete: 'off',
      value: values.lat ?? '', placeholder: computedPos ? computedPos.lat.toFixed(2) : '51.05',
    });
    const lon = h('input', {
      id: 'edit-lon', class: 'mono-input', inputmode: 'decimal', autocomplete: 'off',
      value: values.lon ?? '', placeholder: computedPos ? computedPos.lon.toFixed(2) : '-114.07',
    });

    const name = h('input', { id: 'edit-name', value: store.get(NAME_KEY), autocomplete: 'name', maxlength: 60, required: true, spellcheck: 'false' });
    const key = h('input', { id: 'edit-key', type: 'password', autocomplete: 'off', spellcheck: 'false' });

    const listHint = (input, hintEl, empty, unit) => {
      const update = () => {
        const items = parseList(input.value);
        hintEl.textContent = items.length ? `${plural(items.length, unit)}: ${items.join(' · ')}` : empty;
      };
      input.addEventListener('input', update);
      update();
    };

    const fTitle = field('edit-title', 'Title', title, values.title ? null : 'Leave empty to keep the computed title.');
    const fPlace = field('edit-place', 'Place', place);
    const fNotes = field('edit-notes', 'Notes', notes);
    const fPeople = field('edit-people', 'People', people, ' ');
    const fTags = field('edit-tags', 'Tags', tags, ' ');
    listHint(people, fPeople.hint, 'Separate names with commas.', 'name');
    listHint(tags, fTags.hint, 'Separate tags with commas.', 'tag');

    const timeHint = original
      ? ['Computed: ', mono(utcLong(original, true)), '. Leave empty to keep it.']
      : 'No computed time. Write it as YYYY-MM-DD HH:MM:SS.';
    const fTime = field('edit-time', 'Capture time, UTC', time, timeHint);
    const fLat = field('edit-lat', 'Latitude', lat);
    const fLon = field('edit-lon', 'Longitude', lon);
    const posHint = h('span', { class: 'hint', id: 'edit-pos-hint' },
      computedPos ? ['Computed: ', mono(`≈ ${latLon(computedPos.lat, computedPos.lon)}`), '. Decimal degrees; south and west are negative. Leave both empty to keep it.']
        : 'Decimal degrees; south and west are negative.');
    lat.setAttribute('aria-describedby', 'edit-pos-hint');
    lon.setAttribute('aria-describedby', 'edit-pos-hint');

    const overridden = Boolean(values.captured_at || values.lat != null || values.lon != null);
    const overrides = h('details', { class: 'overrides', open: overridden },
      h('summary', null, 'Correct the time or position'),
      h('div', { class: 'overrides-body' },
        fTime.el,
        h('div', { class: 'pair' }, fLat.el, fLon.el),
        h('div', { class: 'field' }, posHint)));

    const fName = field('edit-name', ['Your name ', h('span', { class: 'req', 'aria-hidden': 'true' }, '(required)')], name, 'Remembered on this device.');
    const fKey = field('edit-key', 'Edit key', key, 'This server asks for a key. Ask the team for it.', { hidden: true });

    const message = h('p', { class: 'form-msg', id: 'edit-msg', role: 'status' });
    const save = h('button', { type: 'submit', class: 'btn' }, 'Save changes');

    const formEl = h('form', { class: 'edit-form', novalidate: true, 'aria-labelledby': 'edit-heading' },
      fTitle.el, fPlace.el, fNotes.el, fPeople.el, fTags.el, overrides, fName.el, fKey.el,
      h('div', { class: 'form-actions' }, save, message));

    const controls = [title, place, notes, people, tags, time, lat, lon, name, key];
    const edits = [title, place, notes, people, tags, time, lat, lon];
    const initial = new Map(edits.map((c) => [c, c.value]));

    const setMessage = (text, kind) => {
      message.textContent = text || '';
      message.className = `form-msg${kind ? ` is-${kind}` : ''}`;
    };
    if (flash) setMessage(flash, 'ok');

    const clearInvalid = () => {
      for (const c of controls) c.removeAttribute('aria-invalid');
    };

    const read = () => {
      const errors = [];
      const next = {
        title: title.value.trim(),
        place: place.value.trim(),
        notes: notes.value.trim(),
        people: parseList(people.value),
        tags: parseList(tags.value),
        captured_at: null,
        lat: null,
        lon: null,
      };
      for (const [input, list, unit] of [[people, next.people, 'name'], [tags, next.tags, 'tag']]) {
        if (list.some((item) => item.length > MAX_ITEM)) errors.push([input, `Keep each ${unit} to ${MAX_ITEM} characters or fewer.`]);
        else if (list.length > MAX_ITEMS) errors.push([input, `A picture can have at most ${MAX_ITEMS} ${unit}s.`]);
      }
      const timeText = time.value.trim();
      if (timeText) {
        const d = parseUtcInput(timeText);
        if (!d) errors.push([time, 'Write the capture time as YYYY-MM-DD HH:MM:SS, in UTC.']);
        else if (launch && d < launch) errors.push([time, `That is before the launch on ${dayMonthYear(launch)}.`]);
        else if (d.getTime() > Date.now() + 36e5) errors.push([time, 'That capture time is in the future.']);
        else next.captured_at = isoUTC(d);
      }
      const latText = lat.value.trim().replace(',', '.');
      const lonText = lon.value.trim().replace(',', '.');
      if (latText || lonText) {
        const la = Number(latText);
        const lo = Number(lonText);
        if (!latText || !lonText) errors.push([latText ? lon : lat, 'Give both latitude and longitude, or leave both empty.']);
        else if (!Number.isFinite(la) || Math.abs(la) > 90) errors.push([lat, 'Latitude is a number from -90 to 90.']);
        else if (!Number.isFinite(lo) || Math.abs(lo) > 180) errors.push([lon, 'Longitude is a number from -180 to 180.']);
        else { next.lat = la; next.lon = lo; }
      }
      return { next, errors };
    };

    const same = (k, a, b) => {
      if (k === 'people' || k === 'tags') return sameList(a, b);
      if (k === 'captured_at') return sameTime(a, b);
      return a === b;
    };

    const changesFrom = (next) => {
      const cur = memberValues(p.ann);
      const changes = {};
      for (const k of EDIT_FIELDS) if (!same(k, next[k], cur[k])) changes[k] = next[k];
      return changes;
    };

    const inputs = { title, place, notes, people, tags, captured_at: time, lat, lon };
    const shown = (k, v) => {
      if (k === 'people' || k === 'tags') return v.join(', ');
      if (k === 'captured_at') return v ? inputTime(toDate(v)) : '';
      return v ?? '';
    };

    // Another member saved this picture after the form was drawn, and changed
    // a field this edit changes too. Take their values into the fields this
    // member left alone, keep what they typed, and say what is stored now.
    const conflict = (latest, changes) => {
      const drawn = memberValues(p.ann);
      const now = memberValues(latest);
      const { next } = read();
      for (const k of EDIT_FIELDS) if (same(k, next[k], drawn[k])) inputs[k].value = shown(k, now[k]);
      p.ann = latest; // a second Save is measured against what is stored now
      const clashed = Object.keys(changes).filter((k) => !same(k, now[k], drawn[k]));
      const fields = [...new Set(clashed.map((k) => FIELD_NAMES[k] || k))];
      const stored = clashed.filter((k) => k !== 'lat' && k !== 'lon').map((k) => {
        const v = now[k];
        const t = Array.isArray(v) ? v.join(', ') : (k === 'captured_at' && v ? utcLong(toDate(v)) : v);
        return `${FIELD_NAMES[k]}: ${t ? `“${truncate(t, 120)}”` : 'empty'}`;
      });
      setMessage(`Not saved: ${latest.updated_by || 'someone'} changed the ${listWords(fields.length ? fields : ['picture'])} `
        + `since you opened this picture. Now stored: ${stored.join('; ') || 'a new position'}. Your text is still in the form: `
        + 'include their changes if you want to keep them, then save again.', 'error');
    };

    let busy = false;
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      clearInvalid();
      const { next, errors } = read();
      const by = name.value.trim();
      if (!by) errors.unshift([name, 'Add your name, so the team can see who made the change.']);
      if (errors.length) {
        for (const [input] of errors) input.setAttribute('aria-invalid', 'true');
        if (errors.some(([input]) => [time, lat, lon].includes(input))) overrides.open = true;
        setMessage(errors[0][1], 'error');
        errors[0][0].focus();
        return;
      }
      store.set(NAME_KEY, by);
      ctx.onName(by);
      const changes = changesFrom(next);
      if (!Object.keys(changes).length) {
        setMessage('Nothing to save: no field has changed.', 'error');
        return;
      }
      const editKey = key.value.trim() || store.get(KEY_KEY);
      // `base`: what each changed field held when this form was drawn, so the
      // server can refuse to overwrite a newer edit by someone else.
      const drawn = memberValues(p.ann);
      const body = { by, changes, base: Object.fromEntries(Object.keys(changes).map((k) => [k, drawn[k]])) };
      if (editKey) body.key = editKey;

      busy = true;
      save.disabled = true;
      save.textContent = 'Saving…';
      setMessage('');
      const result = await saveAnnotation(p.id, body);
      busy = false;
      save.disabled = false;
      save.textContent = 'Save changes';

      if (result.ok) {
        if (key.value.trim()) store.set(KEY_KEY, key.value.trim());
        await ctx.onSaved(p.id, result.record);
        if (currentId === p.id) render(p.id, { flash: 'Saved.', keepScroll: true, focusSave: true });
        announce('Your changes are saved.');
        return;
      }
      if (result.status === 409 && isObject(result.record)) {
        await ctx.onSaved(p.id, result.record); // refreshes the app's copy; this form stays as typed
        if (currentId === p.id) conflict(result.record, changes);
        return;
      }
      // serve.py answers 403 for a missing or wrong key, and also when editing
      // is off, the request came from another site or named an unexpected
      // host; only the first needs the key field.
      if (result.status === 403 && /turned off|read.only|cross.site|host/i.test(result.message || '')) {
        setMessage(`Not saved: ${result.message}.`.replace(/\.\.$/, '.'), 'error');
        return;
      }
      if (result.status === 403) {
        fKey.el.hidden = false;
        if (editKey) store.set(KEY_KEY, '');
        key.setAttribute('aria-invalid', editKey ? 'true' : 'false');
        setMessage(editKey
          ? 'That edit key was not accepted. Check it and save again.'
          : 'This server needs an edit key. Enter it above, then save again.', 'error');
        key.focus();
        return;
      }
      const detailText = result.message || (result.status ? `the server answered ${result.status}` : '');
      setMessage(result.status === 0 ? result.message : `Not saved: ${detailText}.`.replace(/\.\.$/, '.'), 'error');
    });

    form = {
      // Anything typed since the form was drawn, valid or not.
      dirty() {
        return edits.some((c) => c.value.trim() !== initial.get(c).trim());
      },
      setName(value) {
        if (!name.value.trim() || document.activeElement !== name) name.value = value;
      },
      focusSave() {
        save.focus({ preventScroll: true });
      },
    };

    return h('section', { class: 'panel-section', 'aria-labelledby': 'edit-heading' },
      h('h2', { id: 'edit-heading' }, 'Add or correct information'),
      h('p', { class: 'section-note' }, 'Your changes are saved for everyone, with your name, and listed in the history.'),
      formEl);
  }

  /* History */

  function historySection(p) {
    const history = Array.isArray(p.ann.history) ? p.ann.history.filter(isObject) : [];
    if (!history.length) return null;
    const ordered = history
      .map((entry, i) => ({ entry, i, t: toDate(entry.at)?.getTime() ?? 0 }))
      .sort((a, b) => b.t - a.t || b.i - a.i)
      .map((x) => x.entry);
    const item = (entry) => {
      const when = toDate(entry.at);
      return h('li', null,
        h('span', { class: 'who' }, typeof entry.by === 'string' && entry.by.trim() ? entry.by.trim() : 'Someone'),
        ' ',
        describeChange(entry.changes),
        when && h('time', { class: 'when mono', datetime: entry.at }, utcLong(when, false)));
    };
    const list = h('ol', { class: 'history' }, ordered.slice(0, HISTORY_SHOWN).map(item));
    let more = null;
    if (ordered.length > HISTORY_SHOWN) {
      more = h('button', { type: 'button', class: 'linkish history-more' }, `Show all ${ordered.length} changes`);
      more.addEventListener('click', () => {
        const added = ordered.slice(HISTORY_SHOWN).map(item);
        list.append(...added);
        // The button goes away: keep keyboard focus on the first entry it revealed.
        if (document.activeElement === more && added.length) {
          added[0].tabIndex = -1;
          added[0].focus();
        }
        more.remove();
      });
    }
    return h('section', { class: 'panel-section', 'aria-labelledby': 'history-heading' },
      h('h2', { id: 'history-heading' }, 'History'),
      list,
      more);
  }

  /* Whole view */

  function renderMissing(id) {
    document.title = 'Picture not found · CTS-SAT-1';
    root.replaceChildren(h('div', { class: 'notice' },
      h('h1', { class: 'detail-title', id: 'detail-title', tabindex: '-1' }, 'Picture not found'),
      h('p', null, `There is no picture with the id “${id}”. It may have been renamed when the list was rebuilt.`),
      h('p', null, h('a', { class: 'text-link', href: '#/' }, 'See all pictures'))));
  }

  function render(id, { flash = '', keepScroll = false, focusSave = false, focus = null } = {}) {
    currentId = id;
    form = null;
    const p = ctx.getPhoto(id);
    if (!p) {
      renderMissing(id);
      return;
    }
    const { list, index } = ctx.getList(id);
    const prev = index > 0 ? list[index - 1] : null;
    const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;
    document.title = `${p.title} · CTS-SAT-1`;
    const globe = globeHref();

    const scrollY = window.scrollY;
    const panel = h('article', { class: 'panel', 'aria-labelledby': 'detail-title' },
      h('div', { class: 'panel-top' },
        h('span', { class: 'panel-links' },
          globe && globeLink(globe, null, '← Back to the globe'),
          h('a', {
            href: ctx.backHref(),
            onclick: (e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              ctx.close();
            },
          }, globe ? 'All pictures' : '← All pictures')),
        index >= 0 && h('span', { class: 'mono' }, `${index + 1} of ${list.length}`)),
      h('h1', { class: 'detail-title', id: 'detail-title', tabindex: '-1' }, p.title),
      p.edited.title && h('p', { class: 'title-note' }, `Title edited by ${p.edited.title}`),
      facts(p),
      linksRow(p),
      membersSection(p),
      ctx.editable() ? editSection(p, flash) : readonlyLine(p),
      historySection(p));

    root.replaceChildren(h('div', { class: 'detail' }, stage(p, prev, next, globe), panel));

    if (keepScroll) window.scrollTo(0, scrollY);
    const heading = root.querySelector('#detail-title');
    if (focusSave && form) form.focusSave();
    else if (focus === 'prev' || focus === 'next') {
      (root.querySelector(`[data-step="${focus}"]`) || heading)?.focus({ preventScroll: true });
    } else if (focus === 'title' || focus === 'key') heading?.focus({ preventScroll: true });

    for (const n of [prev, next]) {
      if (!n) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = n.src;
    }
  }

  return {
    show(id, options) { render(id, options); },
    isDirty: () => Boolean(form && form.dirty()),
    setName(name) { form?.setName(name); },
    handleKey(e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        const globe = globeHref();
        if (globe) backToGlobe(globe);
        else ctx.close();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const { list, index } = ctx.getList(currentId);
      if (index < 0) return;
      const dest = e.key === 'ArrowLeft' ? list[index - 1] : list[index + 1];
      if (!dest) return;
      e.preventDefault();
      ctx.go(dest.id, 'key');
    },
  };
}
