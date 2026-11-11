// One picture in words, and its detail block, built once for both places that show it:
// Pictures (catalogue.js) and the picture's own page (detail.js). Same labels, same
// order, same buttons:
//
//   the time, Calgary first and UTC second      whenBlock(p)
//   what is wrong with it, if anything          statusBlock(p)
//   Show on the globe, Download, Copy link      createPhotoActions(...)
//   Where, Light, Camera, Came down, Status, People, Tags      photoFacts(p, ...)
//   a closed "Technical details"                technicalDetails(p)
//   Notes, when there are some                  photoNotes(p, ...)
//
// Each fact is said once in plain words. The data's own terms (sha256, the time to the
// second and where it was read from, the orbit model and its epoch, the status note from
// images.json, the cameras' code names) are only inside Technical details.
// Styles: style.css, "Photo details".

import { h, announce, copyText } from './dom.js';
import { CALGARY_TIME_ZONE, CALGARY_ZONE_NAME } from './calgary-clock.js';
import { CAMERAS, bytes, clock, latLon, monthDayYear, percent, plural, toDate, utcLong } from './format.js';

/* The kinds Pictures tucks away */

export const isDark = (p) => Boolean(p && (p.dark === true || (p.raw && p.raw.dark === true)));

// Less than a fifth of the picture can be shown (data.js sets p.mostlyMissing).
export const isMostlyMissing = (p) => Boolean(p && (typeof p.mostlyMissing === 'boolean'
  ? p.mostlyMissing
  : Number(p.raw?.completeness) < 0.2));

/* Small pieces */

// Keeps a date, a time or a range on one line: lines break only between them.
export function nobr(text) {
  return h('span', { class: 'nobr' }, text);
}

export function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function code(text, attrs = null) {
  return h('code', { class: 'pi-code', ...attrs }, text);
}

function sameTime(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return toDate(a)?.getTime() === toDate(b)?.getTime();
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/* Calgary's clock (assets/calgary-clock.js) */

let calgaryFormat = null;

function calgaryParts(d) {
  try {
    calgaryFormat ||= new Intl.DateTimeFormat('en-US', {
      timeZone: CALGARY_TIME_ZONE,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = {};
    for (const part of calgaryFormat.formatToParts(d)) parts[part.type] = part.value;
    return parts;
  } catch {
    return null;
  }
}

// "Oct 29, 2026", the day on Calgary's clocks
export function calgaryDay(d) {
  const c = calgaryParts(d);
  return c ? `${c.month} ${c.day}, ${c.year}` : monthDayYear(d);
}

// "Oct 29, 2026, 20:45 Calgary time"
export function calgaryStamp(d, seconds = false) {
  const c = calgaryParts(d);
  if (!c) return utcLong(d, seconds);
  return `${c.month} ${c.day}, ${c.year}, ${c.hour}:${c.minute}${seconds ? `:${c.second}` : ''} ${CALGARY_ZONE_NAME}`;
}

// "Oct 30, 2026, 02:45 UTC"
function utcNodes(d, seconds = false) {
  return [nobr(monthDayYear(d)), ', ', nobr(`${clock(d, seconds)} UTC`)];
}

// "20:45 on Oct 29 in Calgary": the sentence already says where, so no zone name.
function calgaryAt(d) {
  const c = calgaryParts(d);
  if (!c) return null;
  return [nobr(`${c.hour}:${c.minute}`), ' on ', nobr(`${c.month} ${c.day}`), ' in Calgary'];
}

// "Oct 29, 2026, 20:45:44 Calgary time (Oct 30, 2026, 02:45:44 UTC)", for one line of text.
export function bothTimes(d, seconds = true) {
  return `${calgaryStamp(d, seconds)} (${utcLong(d, seconds)})`;
}

// A span of time on one clock: "Oct 29, 22:48 to 23:43 Calgary time",
// "Oct 29, 22:48 to Oct 30, 17:43 Calgary time".
function rangeNodes(first, last, zone, partsOf) {
  const a = first ? partsOf(first) : null;
  const b = last ? partsOf(last) : null;
  if (a && b && a.day === b.day) return [nobr(a.day), ', ', nobr(a.time), ' to ', nobr(`${b.time} ${zone}`)];
  if (a && b) return [nobr(`${a.day}, ${a.time}`), ' to ', nobr(`${b.day}, ${b.time} ${zone}`)];
  const one = a || b;
  return one ? [nobr(one.day), ', ', nobr(`${one.time} ${zone}`)] : null;
}

function calgaryShort(d) {
  const c = calgaryParts(d);
  return c ? { day: `${c.month} ${c.day}`, time: `${c.hour}:${c.minute}` } : utcShort(d);
}

function utcShort(d) {
  return { day: monthDayYear(d).replace(/, \d{4}$/, ''), time: clock(d) };
}

/* Place and time */

// A member who moved the capture time without giving a position leaves the
// computed position in place, but it belongs to the old time.
export function positionIsStale(p) {
  return !p.positionRecomputed
    && Boolean(p.edited.captured_at && !p.edited.position && !sameTime(p.capturedAt, p.raw.captured_at));
}

export function placeName(p) {
  if (p.place) return p.place;
  if (positionIsStale(p)) return '';
  return p.computedPlace || '';
}

// The day it was taken: on Calgary's clocks when the time is known, else the
// day the data gives (a file name's date).
function dayText(p) {
  const d = toDate(p.capturedAt);
  if (d) return calgaryDay(d);
  const day = p.captureDate ? toDate(`${p.captureDate}T00:00:00Z`) : null;
  return day ? monthDayYear(day) : '';
}

// The largest line: a member's title, else the place, else the date, else
// the build's own title.
export function headline(p) {
  if (p.title !== p.defaultTitle) return p.title;
  return placeName(p) || dayText(p) || p.defaultTitle || p.id;
}

// For labels and announcements: "Oct 29, 2026, 20:45 Calgary time",
// "Oct 24, 2026, time unknown" or "Time unknown".
export function whenShort(p) {
  const d = toDate(p.capturedAt);
  if (d) return calgaryStamp(d);
  const day = dayText(p);
  return day ? `${day}, time unknown` : 'Time unknown';
}

// The headline and the time, without saying a date twice when the date is all the headline has.
export function nameAndWhen(p) {
  const name = headline(p);
  const when = whenShort(p);
  return when.startsWith(name) ? when : `${name}, ${when}`;
}

// The alt text of the picture itself.
export function photoAlt(p) {
  const camera = capitalize(CAMERAS[p.camera]?.alt || 'camera');
  const where = placeName(p) || (p.position && !positionIsStale(p) ? latLon(p.position.lat, p.position.lon, 1) : '');
  const parts = [];
  if (p.title !== p.defaultTitle) parts.push(`${p.title}.`);
  const when = whenShort(p);
  parts.push(`${camera} image from FrontierSat${where ? ` over ${where}` : ''}, ${when === 'Time unknown' ? 'time unknown' : when}.`);
  if (p.status === 'partial') parts.push('Parts of the image never came down and are flat grey.');
  if (p.status === 'truncated') parts.push('Only the top of the frame exists.');
  return parts.join(' ');
}

/* Status */

export function checksumMatches(p) {
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

// Part of the file is still missing: a partly missing picture, or one the
// satellite cut short whose saved part hasn't all come down.
export function linesMissing(p) {
  if (p.status === 'partial') return true;
  if (p.status !== 'truncated' || checksumMatches(p)) return false;
  const { lines, arrived } = noteNumbers(p);
  if (lines && arrived != null) return arrived < lines.to - lines.from + 1;
  return Boolean(p.raw?.sha256_expected);
}

function agoText(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

const DAY_MS = 24 * 3600 * 1000;

// "Still coming down: last packet 1 h ago." while a picture with parts missing is still arriving.
function stillComing(p) {
  if (!linesMissing(p)) return null;
  const last = toDate(p.raw?.downlink?.last);
  const since = last ? Date.now() - last.getTime() : Infinity;
  return since >= 0 && since < DAY_MS ? `Still coming down: last packet ${agoText(since)} ago.` : null;
}

// How much of a picture with parts missing is shown, as "18%": the share of its rows
// the build found data in (build.py _shown_share). Null when it says nothing (all of
// it, none, or unknown), and the words fall back to a plain sentence.
function shownPercent(p) {
  const share = Number(p.raw?.completeness);
  return share > 0 && share < 1 ? percent(share) : null;
}

// The status in a few words (thumbnails, compare cells, announcements). A main-camera
// picture's share is how much of it can be shown, not how much arrived: its JPEG
// can't be read past the first gap.
export function statusShort(p) {
  const pct = shownPercent(p);
  if (p.status === 'partial') {
    if (p.camera === 'picam') return pct ? `partly missing: only the top ${pct} is shown` : 'partly missing';
    return pct ? `partly missing: about ${pct} came down` : 'partly missing';
  }
  if (p.status === 'truncated') {
    return linesMissing(p) && pct ? `cut short on board, and only the top ${pct} is shown` : 'cut short on board';
  }
  if (p.status === 'verified') return 'checked';
  if (p.status === 'complete') return 'complete, not checked';
  return p.status ? String(p.status) : 'status unknown';
}

// What is wrong with a picture, in a sentence, for any picture that isn't
// checked and whole; null for the rest.
function statusSentence(p) {
  const pct = shownPercent(p);
  const coming = stillComing(p);
  let text = null;
  if (p.status === 'partial') {
    const never = coming ? 'hasn’t come down yet' : 'never came down';
    if (p.camera === 'picam') {
      text = pct
        ? [`Part of this picture ${never}. Nothing below the first gap can be read, so only the top `, nobr(pct), ' is shown.']
        : [`Part of this picture ${never}.`];
    } else {
      text = [`Grey bands are rows that ${never}.`,
        pct ? [` About ${pct} of it ${coming ? 'has so far' : 'did'}.`] : ''];
    }
  } else if (p.status === 'truncated') {
    const early = 'The satellite stopped this capture early and saved only the top part of the frame.';
    if (!linesMissing(p)) {
      text = [early, checksumMatches(p) ? ' All of that came down.' : ''];
    } else {
      const gap = Number(p.raw?.completeness) < 0.25 ? 'a gap near the top' : 'a gap';
      text = [early, ` Not all of that has come down yet, and ${gap} means `,
        pct ? ['only the top ', nobr(pct), ' can be shown.'] : 'only part of it can be shown.'];
    }
  } else if (p.status === 'complete') {
    text = ['The whole picture arrived, but it can’t be checked against the satellite’s own fingerprint of the file.'];
  }
  if (coming) text = text ? [text, ' ', coming] : [coming];
  return text;
}

// The status row's second line: what the check against the satellite found.
function checkSentence(p) {
  if (checksumMatches(p)) {
    return p.status === 'truncated'
      ? 'Every byte it saved arrived and matches the satellite’s own fingerprint of that shortened file.'
      : 'Every byte arrived and matches the satellite’s own fingerprint of the file.';
  }
  if (linesMissing(p)) return 'It can’t be checked against the satellite’s fingerprint of the file while part of it is missing.';
  if (p.raw?.sha256_expected) return 'It doesn’t match the satellite’s own fingerprint of the file, so a few bytes outside the picture may be missing.';
  return 'The satellite sent no fingerprint of the file to check it against.';
}

/* The header: the time and the status sentence */

// "20:45 on Oct 29 in Calgary" over "Oct 30, 2026, 02:45 UTC", and who corrected it. The
// facts below don't say the time again; to the second, it is in Technical details.
export function whenBlock(p) {
  const d = toDate(p.capturedAt);
  const el = h('p', { class: 'pi-when' });
  const line = (content, local = false) => el.append(h('span', { class: `pi-when-line${local ? ' pi-when-local' : ''}` }, content));
  if (d) {
    const local = calgaryAt(d);
    if (local) line(local, true);
    line(utcNodes(d));
    if (p.edited.captured_at) line(`Corrected by ${p.edited.captured_at}`);
  } else if (p.captureDate) {
    // the day, unless it is already the picture's name
    const day = dayText(p);
    const named = !day || day === headline(p);
    if (!named) line(day, true);
    line('Time unknown: only the date is known', named);
  } else {
    line('Date unknown', true);
    line('Neither the file name nor the satellite’s records give a time');
  }
  return el;
}

export function statusBlock(p) {
  const text = statusSentence(p);
  return text ? h('p', { class: 'pi-status' }, text) : null;
}

// Who named it, when a member did: "Title by Jordan K.", "Place named by Jordan K."
export function creditLine(p) {
  let text = '';
  if (p.title !== p.defaultTitle && p.edited.title) text = `Title by ${p.edited.title}`;
  else if (p.place && headline(p) === p.place && p.edited.place) text = `Place named by ${p.edited.place}`;
  return text ? h('p', { class: 'pi-credit' }, text) : null;
}

/* The actions: Show on the globe (primary), then Download and Copy link */

// copyUrl(p): the address Copy link copies. The returned set(p, { globeHref })
// fills the same buttons for another picture, so focus stays on them.
export function createPhotoActions({ idPrefix, copyUrl = () => location.href }) {
  const whyId = `${idPrefix}-globe-why`;
  const globeLink = h('a', { class: 'btn btn-primary' }, 'Show on the globe');
  const globeOff = h('button', {
    type: 'button', class: 'btn btn-primary', 'aria-disabled': 'true', 'aria-describedby': whyId, hidden: true,
  }, 'Show on the globe');
  // under the buttons, in small words, when the globe button is greyed
  const globeWhy = h('span', { class: 'pi-why', id: whyId, hidden: true }, 'Without a time, it can’t be shown on the globe.');
  const download = h('a', { class: 'btn btn-secondary' }, 'Download');
  const copy = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Copy link');
  const el = h('div', { class: 'pi-actions' }, globeLink, globeOff, globeWhy, download, copy);
  let current = null;
  let timer = 0;
  copy.addEventListener('click', async () => {
    if (!current) return;
    const ok = await copyText(copyUrl(current));
    copy.textContent = ok ? 'Link copied' : 'Copy failed';
    announce(ok ? 'Link copied' : 'Could not copy the link');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
  });
  return {
    el,
    set(p, { globeHref }) {
      current = p;
      const onGlobe = Boolean(p.capturedAt);
      globeLink.hidden = !onGlobe;
      globeOff.hidden = onGlobe;
      globeWhy.hidden = onGlobe;
      if (onGlobe) globeLink.href = globeHref(p);
      download.href = p.src;
      const fileName = String(p.src || '').split('/').pop() || `${p.id}.jpg`;
      download.setAttribute('download', `frontiersat-${fileName}`);
      download.setAttribute('aria-label', `Download the picture, ${nameAndWhen(p)}`);
    },
  };
}

/* The facts */

// Where a capture time comes from (images.json capture_basis), for Technical details.
const BASIS = {
  filename: 'From the file name',
  'capture log': 'From the camera’s capture log',
  'capture record': 'From the capture command’s own record',
  'ADCS file list': 'From the attitude camera’s list of files',
  'capture reply': 'From the satellite’s reply to the capture command',
};

function whereValue(p) {
  const pos = p.position;
  if (pos && !positionIsStale(p)) {
    const [lat, lon] = latLon(pos.lat, pos.lon).split(', ');
    const alt = Number.isFinite(pos.alt_km) ? [', ', nobr(`${Math.round(pos.alt_km)} km up`)] : '';
    const out = [[nobr(lat), ', ', nobr(lon), alt]];
    if (p.computedPlace && p.computedPlace !== headline(p)) out.push(`Below the satellite: ${p.computedPlace}`);
    if (p.edited.position) {
      out.push(`Set by ${p.edited.position}`);
    } else if (p.positionRecomputed) {
      out.push('Position estimated from the satellite’s published orbit, for the corrected time');
    } else {
      const epoch = toDate(p.raw.position?.tle_epoch);
      out.push(`Position estimated from the satellite’s published orbit${epoch ? ` (${monthDayYear(epoch).replace(/, \d{4}$/, '')}, ${clock(epoch)} UTC)` : ''}`);
    }
    return out;
  }
  if (positionIsStale(p)) return ['Not worked out for the corrected time', 'The globe works it out from the corrected time.'];
  if (p.capturedAt) return ['Position unknown', 'No published orbit covers this time.'];
  return ['Position unknown', 'There is no time to work it out from.'];
}

function lightValue(p) {
  if (!p.positionRecomputed && (p.edited.position || positionIsStale(p))) return null;
  const pos = p.positionRecomputed ? p.position : p.raw.position;
  if (!isObject(pos)) return null;
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

function cameraValue(p) {
  const name = CAMERAS[p.camera]?.short || (p.camera ? String(p.camera) : 'Unknown camera');
  const out = [`${name}, ${p.width} × ${p.height} pixels`];
  if (p.camera === 'adcs') out.push('It helps the satellite tell which way it faces');
  return out;
}

function downValue(p) {
  const dl = isObject(p.raw.downlink) ? p.raw.downlink : null;
  if (!dl) return null;
  const first = toDate(dl.first);
  const last = toDate(dl.last);
  const packets = Number.isFinite(dl.packets) ? nobr(plural(dl.packets, 'packet')) : null;
  const local = rangeNodes(first, last, CALGARY_ZONE_NAME, calgaryShort);
  const utc = rangeNodes(first, last, 'UTC', utcShort);
  if (!packets && !local) return null;
  return [[packets, packets && local ? ', ' : '', local], utc];
}

function statusValue(p) {
  return [capitalize(statusShort(p)), checkSentence(p)];
}

// listLink(item, key): a person or tag, as a link or a button ('member' or 'tag').
// The time isn't a row of its own: it is under the picture's name (whenBlock).
export function photoFacts(p, { listLink }) {
  const rows = [
    ['Where', whereValue(p)],
  ];
  const light = lightValue(p);
  if (light) rows.push(['Light', light]);
  rows.push(['Camera', cameraValue(p)]);
  const down = downValue(p);
  if (down) rows.push(['Came down', down]);
  rows.push(['Status', statusValue(p)]);
  const list = (items, key) => items.flatMap((item, i) => (i ? [', ', listLink(item, key)] : [listLink(item, key)]));
  if (p.people.length) rows.push(['People', [list(p.people, 'member'), p.edited.people ? `Added by ${p.edited.people}` : null]]);
  if (p.tags.length) rows.push(['Tags', [list(p.tags, 'tag'), p.edited.tags ? `Added by ${p.edited.tags}` : null]]);
  return h('dl', { class: 'pi-facts' }, rows.flatMap(([label, [value, ...more]]) => [
    h('dt', null, label),
    h('dd', null,
      h('span', { class: 'pi-value' }, value),
      more.filter(Boolean).map((line) => h('span', { class: 'pi-second' }, line))),
  ]));
}

/* Technical details: the data's own words, closed until asked for */

// How far off the on-board clock a capture time was read from was (satellite_clock in docs/DATA.md).
function clockText(info) {
  if (!isObject(info)) return null;
  const c = info.correction_s;
  if (!Number.isFinite(c)) return 'Read off an on-board clock that nothing in the data can check: it may be a minute or so off.';
  if (c === 0) return 'The satellite’s clock was checked and was right.';
  const s = Math.abs(c);
  return `The satellite’s clock was ${s.toFixed(s < 10 ? 1 : 0)} s ${c < 0 ? 'fast' : 'slow'}; the time is corrected for that.`;
}

function hashValue(p) {
  const raw = p.raw;
  const hash = typeof raw.sha256 === 'string' ? raw.sha256 : '';
  if (!hash) return null;
  const copy = h('button', { type: 'button', class: 'pi-inline-btn pi-copy', 'aria-label': 'Copy the full sha256' }, 'Copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(hash);
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    announce(ok ? 'sha256 copied' : 'Could not copy the sha256');
    window.setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });
  // Whether it matches is the Status row's to say; here only a different hash the satellite sent.
  const expected = typeof raw.sha256_expected === 'string' ? raw.sha256_expected : '';
  const second = expected && expected.toLowerCase() !== hash.toLowerCase()
    ? ['The satellite sent ', code(`${expected.slice(0, 12)}…`, { title: expected })]
    : null;
  return [[code(`${hash.slice(0, 12)}…`, { title: hash }), ' ', copy], second];
}

// The capture time to the second, on the satellite's clock (UTC), and where it was read from.
function timeFromValue(p) {
  const raw = p.raw;
  const d = toDate(p.capturedAt);
  if (!raw.capture_basis && !d) return null;
  const basis = BASIS[raw.capture_basis];
  const original = toDate(raw.captured_at);
  const out = [raw.capture_basis ? code(String(raw.capture_basis)) : 'Not recorded'];
  if (d && p.edited.captured_at && original && !sameTime(original, d)) {
    out.push(`Corrected to ${utcLong(d, true)}`);
    out.push(`First worked out as ${utcLong(original, true)}${basis ? `, ${basis[0].toLowerCase()}${basis.slice(1)}` : ''}`);
  } else if (d) {
    out.push(basis ? `${basis}: ${utcLong(d, true)}` : utcLong(d, true));
  }
  out.push(clockText(raw.satellite_clock));
  return out;
}

export function technicalDetails(p, { open = false } = {}) {
  const raw = p.raw;
  const rows = [['Picture ID', [code(p.id)]]];
  const cam = CAMERAS[p.camera];
  if (cam?.code) rows.push(['Camera', [cam.code, p.camera === 'adcs' ? 'The camera of the attitude determination and control system' : null]]);
  if (raw.file) rows.push(['File', [code(raw.file), bytes(raw.file_size)]]);
  const hash = hashValue(p);
  if (hash) rows.push(['sha256', hash]);
  // a note with Python's None in it ("line None did not arrive") is a build slip: left out
  const note = typeof raw.status_note === 'string' && !/\bNone\b/.test(raw.status_note) ? raw.status_note : null;
  rows.push(['Data status', [code(String(p.status || 'unknown')), note]]);
  const timeFrom = timeFromValue(p);
  if (timeFrom) rows.push(['Time from', timeFrom]);
  if (isObject(raw.position) && raw.position.basis) {
    const epoch = toDate(raw.position.tle_epoch);
    rows.push(['Position from', [String(raw.position.basis), epoch ? `TLE epoch ${utcLong(epoch, false)}` : null]]);
  }
  return h('details', { class: 'pi-tech', open },
    h('summary', null, 'Technical details'),
    h('dl', { class: 'pi-facts pi-tech-list' }, rows.flatMap(([label, [value, ...more]]) => [
      h('dt', null, label),
      h('dd', null,
        h('span', { class: 'pi-value' }, value),
        more.filter(Boolean).map((line) => h('span', { class: 'pi-second' }, line))),
    ])));
}

/* Notes */

// level: the heading's level (3 on Pictures, under its page heading; 2 on a picture's page).
// Null when there are none: no heading over an empty section.
export function photoNotes(p, { level = 2, idPrefix }) {
  if (!p.notes) return null;
  const id = `${idPrefix}-notes-heading`;
  return h('section', { class: 'pi-notes', 'aria-labelledby': id },
    h(`h${level}`, { class: 'pi-notes-heading', id }, 'Notes'),
    h('p', { class: 'pi-notes-text' }, p.notes),
    p.edited.notes ? h('p', { class: 'pi-second' }, `Written by ${p.edited.notes}`) : null);
}
