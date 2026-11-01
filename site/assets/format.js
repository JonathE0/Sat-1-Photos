// Formatting for times, places, sizes and labels. Everything shown as UTC is
// built by hand so it reads the same in every browser and locale.
import { CALGARY_TIME_ZONE, CALGARY_ZONE_NAME } from './calgary-clock.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');

export function toDate(value) {
  if (value == null || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

// "Sep 17, 2026"
export function monthDayYear(d) {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// "07:11" or "07:11:48"
export function clock(d, seconds = false) {
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${hm}:${p2(d.getUTCSeconds())}` : hm;
}

// "Sep 17, 2026, 07:11:48 UTC"
export function utcLong(d, seconds = true) {
  return `${monthDayYear(d)}, ${clock(d, seconds)} UTC`;
}

// "2026-09-17"
export function isoDay(d) {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

// "Sep 17, 2026, 07:11 UTC"
export function utcShort(d) {
  return utcLong(d, false);
}

// "2026-09-17 07:11:48", the format the edit form shows and accepts.
export function inputTime(d) {
  return `${isoDay(d)} ${clock(d, true)}`;
}

// "2026-09-17T07:11:48Z", the format stored in the data files.
export function isoUTC(d) {
  return `${isoDay(d)}T${clock(d, true)}Z`;
}

// Reads a UTC time typed by a person: "2026-09-17 07:11", "2026-09-17 07:11:48",
// "2026-09-17T07:11:48Z" or the same with " UTC". Returns a Date or null.
export function parseUtcInput(text) {
  const m = String(text).trim().match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(?:Z|UTC|\+00:?00)?$/i,
  );
  if (!m) return null;
  const [, y, mo, da, hh, mi, ss = '0'] = m;
  const parts = [y, mo, da, hh, mi, ss].map(Number);
  const t = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const d = new Date(t);
  // Reject dates that rolled over, such as 31 Sep.
  if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() !== parts[1] - 1 || d.getUTCDate() !== parts[2]
    || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
  return d;
}

let calgaryFormat = null;

// "Sep 17, 2026, 01:11:48 ABT", the same moment on Calgary's clocks.
export function calgary(d) {
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
    return `${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute}:${parts.second} ${CALGARY_ZONE_NAME}`;
  } catch {
    return null;
  }
}

// "51.05° N, 114.07° W"
export function latLon(lat, lon, digits = 2) {
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

// "27 400": a narrow space between the thousands. Across much of Europe a comma
// in a number is its decimal point, so "27,400" reads as 27.4; a space reads the
// same everywhere.
export function grouped(n, digits = 0) {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, ' ');
}

export function bytes(n) {
  if (!Number.isFinite(n)) return null;
  const exact = `${grouped(Math.round(n))} bytes`;
  if (n < 1024) return exact;
  return `${(n / 1024).toFixed(1)} KB (${exact})`;
}

export function shortHash(hash) {
  if (typeof hash !== 'string' || hash.length < 20) return hash || '';
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${grouped(n)} ${n === 1 ? one : many}`;
}

// "Sep 2026" for the month key "2026-09".
export function monthLabel(key) {
  if (key === 'unknown') return 'Date unknown';
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  if (!m) return key || '';
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export const CAMERAS = {
  picam: { short: 'PiCAM', long: 'PiCAM, the main camera', alt: 'PiCAM' },
  adcs: { short: 'ADCS', long: 'ADCS camera, for attitude sensing', alt: 'ADCS camera' },
};

export function cameraShort(camera) {
  return CAMERAS[camera]?.short || (camera ? String(camera) : 'unknown camera');
}

export function cameraLong(camera) {
  return CAMERAS[camera]?.long || (camera ? String(camera) : 'Unknown camera');
}

// The four statuses, in the order the filter lists them.
export const STATUSES = [
  ['verified', 'verified'],
  ['complete', 'complete'],
  ['partial', 'partial'],
  ['truncated', 'cut short on board'],
];

const STATUS_WORDS = Object.fromEntries(STATUSES);

export function statusWord(status) {
  return STATUS_WORDS[status] || (status ? String(status) : 'unknown');
}

const BASIS = {
  filename: 'time from the filename',
  'capture log': 'time from the capture log',
  'capture record': 'time from the capture command’s own record',
  'ADCS file list': 'time from the attitude camera’s file list',
  'capture reply': 'time from the capture reply',
  'date only': 'date only, time unknown',
  unknown: 'time unknown',
};

export function basisText(basis) {
  return BASIS[basis] || (basis ? `time from the ${basis}` : null);
}

// Lower-case text without accents, for searching.
export function fold(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function percent(share) {
  if (!Number.isFinite(share)) return null;
  const pct = share * 100;
  if (pct > 99 && pct < 100) return '99%';
  if (pct > 0 && pct < 1) return '1%';
  return `${Math.round(pct)}%`;
}
