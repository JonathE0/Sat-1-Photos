// Mission ops, on Pictures: the files the satellite still holds that haven't all come down
// yet, from images.json's still_on_board (cts1_gallery/build.py), the latest first. For each,
// what arrived and what's missing: the main camera's missing lines (its packets of the
// picture) and, for any file, the missing byte ranges, offsets in the file on board. A
// dropdown beside Filters; on a phone, a sheet. Copy list gives the same as plain text, for
// a downlink request.
import { h, announce, copyText, mono } from './dom.js';
import { grouped, plural, toDate } from './format.js';
import { calgaryStamp } from './photo-info.js';

/** Ranges written out on the page; Copy list has every one the data holds. */
const SHOWN_RANGES = 4;

/** Every file with something left on board, as {id, title, file, camera, s, last, reason}. */
export function opsEntries(data) {
  const out = [];
  const add = (rec, extra) => {
    const s = rec?.still_on_board;
    if (!s || !Array.isArray(s.bytes) || s.bytes[0] >= s.bytes[1]) return;
    const last = toDate(s.last_packet) || toDate(rec.downlink?.last) || toDate(s.last_try);
    out.push({ file: rec.file, s, last, ...extra });
  };
  for (const rec of Array.isArray(data?.images) ? data.images : []) {
    add(rec, { id: rec.id, title: rec.title, camera: rec.camera });
  }
  for (const rec of Array.isArray(data?.skipped) ? data.skipped : []) {
    if (typeof rec?.file !== 'string') continue;
    add(rec, { id: null, title: null, camera: /^adcs\//i.test(rec.file) ? 'adcs' : 'picam', reason: rec.reason });
  }
  out.sort((a, b) => (b.last?.getTime() || 0) - (a.last?.getTime() || 0));
  return out;
}

const lineRange = ([a, b]) => (a === b ? `${a}` : `${a}–${b}`);
const byteRange = ([a, b]) => (b - a === 1 ? `${grouped(a)}` : `${grouped(a)}–${grouped(b - 1)}`);
const plainLine = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`);
const plainByte = ([a, b]) => `${a}-${b - 1}`;

function rangesText(ranges, count, fmt) {
  const shown = ranges.slice(0, SHOWN_RANGES).map(fmt).join(', ');
  const more = (count || ranges.length) - Math.min(ranges.length, SHOWN_RANGES);
  return more > 0 ? `${shown} and ${plural(more, 'more range')}` : shown;
}

const fileName = (path) => path.split('/').pop();

function entryEl(e, photoHref) {
  const { s } = e;
  const [got, size] = s.bytes;
  const lines = Array.isArray(s.lines) ? s.lines : null;
  const name = e.id
    ? h('a', { class: 'cat-ops-name', href: photoHref(e.id) }, e.title || e.id)
    : h('span', { class: 'cat-ops-name' }, fileName(e.file));
  const share = Math.floor((got / size) * 100);
  const arrived = lines
    ? [`${grouped(lines[0])} of ${plural(lines[1], 'line')} arrived (${share}%)`,
      lines[1] < lines[2] ? `, the file on board holds ${grouped(lines[1])} of the ${grouped(lines[2])} the camera announced` : '']
    : [`${grouped(got)} of ${grouped(size)} bytes arrived (${share}%)`];
  const missing = lines && Array.isArray(s.line_ranges) && s.line_ranges.length
    ? `Missing lines ${rangesText(s.line_ranges, s.line_range_count, lineRange)}`
    : `Missing bytes ${rangesText(s.byte_ranges || [], s.byte_range_count, byteRange)}`;
  const when = got === 0
    ? (e.last ? `Asked for ${calgaryStamp(e.last)}; nothing came down` : 'Asked for; nothing came down')
    : (e.last ? `Last packet ${calgaryStamp(e.last)}` : '');
  return h('li', { class: 'cat-ops-item' },
    h('p', { class: 'cat-ops-head-line' }, name, e.camera === 'adcs' ? h('span', { class: 'cat-ops-tag' }, 'Attitude camera') : null),
    h('p', { class: 'cat-ops-file' }, mono(e.file)),
    h('p', null, ...arrived),
    h('p', { class: 'cat-ops-missing' }, missing),
    e.reason ? h('p', { class: 'cat-ops-note' }, `Not shown on the site yet: ${e.reason}.`) : null,
    when ? h('p', { class: 'cat-ops-note' }, when) : null);
}

/** The same list as text: one file a line, every range the data holds. */
function asText(entries) {
  const rows = entries.map((e) => {
    const { s } = e;
    const parts = [e.file];
    if (Array.isArray(s.lines) && s.line_ranges?.length) {
      parts.push(`missing lines ${s.line_ranges.map(plainLine).join(', ')}${(s.line_range_count || 0) > s.line_ranges.length ? ' (and more)' : ''}`);
    }
    parts.push(`missing bytes ${(s.byte_ranges || []).map(plainByte).join(', ')}${(s.byte_range_count || 0) > (s.byte_ranges || []).length ? ' (and more)' : ''}`);
    parts.push(`${s.bytes[0]} of ${s.bytes[1]} bytes received`);
    if (e.last) parts.push(`last ${e.last.toISOString().replace('.000', '')}`);
    return parts.join('; ');
  });
  return `FrontierSat: files still on the satellite (${entries.length})\n${rows.join('\n')}\n`;
}

/**
 * The dropdown: { toggle, panel, setData(data), close() }. The toggle hides itself while
 * there's nothing on the list. `sheet` is the media query under which it's a sheet.
 */
export function createOpsPanel({ photoHref, sheet }) {
  const title = h('h2', { class: 'cat-ops-title', id: 'cat-ops-title', tabindex: '-1' }, 'Mission ops: still on the satellite');
  const closeBtn = h('button', { type: 'button', class: 'cat-text-btn cat-ops-close' }, 'Close');
  const intro = h('p', { class: 'cat-ops-intro' });
  const copyBtn = h('button', { type: 'button', class: 'cat-text-btn' }, 'Copy list');
  const list = h('ol', { class: 'cat-ops-list' });
  const panel = h('section', { class: 'cat-ops', id: 'cat-ops', hidden: true, 'aria-labelledby': 'cat-ops-title' },
    h('div', { class: 'cat-ops-top' }, title, closeBtn),
    intro,
    h('div', { class: 'cat-ops-tools' }, copyBtn),
    list);
  const count = h('span', { class: 'cat-ops-count' });
  const toggle = h('button', {
    type: 'button', class: 'cat-text-btn cat-ops-toggle', 'aria-expanded': 'false', 'aria-controls': 'cat-ops', hidden: true,
  }, 'Mission ops', count);
  let entries = [];

  function place() {
    // a dropdown opens up from the controls, over the picture, as tall as the room above them
    if (sheet.matches) {
      panel.style.maxHeight = '';
      return;
    }
    const nav = document.querySelector('.site-nav, nav')?.getBoundingClientRect().bottom || 0;
    panel.style.maxHeight = `${Math.max(200, Math.floor(toggle.getBoundingClientRect().top - nav - 16))}px`;
  }

  function setOpen(open, { focus = true } = {}) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      place();
      if (focus) title.focus({ preventScroll: true });
    } else if (focus && panel.contains(document.activeElement)) {
      toggle.focus({ preventScroll: true });
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  closeBtn.addEventListener('click', () => setOpen(false));
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(asText(entries));
    copyBtn.textContent = ok ? 'Copied' : 'Couldn’t copy';
    announce(ok ? 'The list is copied.' : 'The list couldn’t be copied.');
    setTimeout(() => { copyBtn.textContent = 'Copy list'; }, 2000);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setOpen(false);
  });
  // a click anywhere else puts it away
  document.addEventListener('click', (e) => {
    if (panel.hidden || !(e.target instanceof Node)) return;
    if (panel.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false, { focus: false });
  });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });

  return {
    toggle,
    panel,
    setData(data) {
      entries = opsEntries(data);
      toggle.hidden = entries.length === 0;
      count.textContent = entries.length ? ` (${entries.length})` : ''; // the button is a flex box: a plain space is dropped
      const lines = entries.reduce((n, e) => n + (Array.isArray(e.s.lines) ? e.s.lines[1] - e.s.lines[0] : 0), 0);
      intro.textContent = `${plural(entries.length, 'file')} the satellite holds that haven’t all come down`
        + (lines ? `, ${plural(lines, 'line')} of pictures among them` : '')
        + '. Latest first. Lines are the main camera’s packets of a picture; byte ranges are offsets in the file on board.';
      list.replaceChildren(...entries.map((e) => entryEl(e, photoHref)));
      if (!entries.length) setOpen(false, { focus: false });
    },
    close() { setOpen(false, { focus: false }); },
  };
}
