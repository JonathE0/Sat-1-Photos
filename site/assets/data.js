// Loading images.json and member edits, and merging the two (see docs/DATA.md).

import { clock, dayMonthYear, fold, toDate, isoDay } from './format.js';

export const IMAGES_URL = 'data/images.json';
export const API_URL = 'api/annotations';
const HEALTH_URL = 'api/health';
export const STATIC_ANNOTATIONS_URL = 'data/annotations.json';

export class LoadError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind; // "missing" | "http" | "invalid" | "network"
    this.status = status;
  }
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export async function loadImages() {
  let res;
  try {
    res = await fetch(IMAGES_URL, { cache: 'no-cache' });
  } catch {
    throw new LoadError('network');
  }
  if (res.status === 404) throw new LoadError('missing', 404);
  if (!res.ok) throw new LoadError('http', res.status);
  let json;
  try { json = await res.json(); } catch { throw new LoadError('invalid'); }
  if (!isObject(json) || !Array.isArray(json.images)) throw new LoadError('invalid');
  json.images = json.images.filter((img) => isObject(img) && typeof img.id === 'string' && img.id);
  return json;
}

// serve.py started with --read-only still answers the API but refuses edits;
// its health check says so. Any other answer (or none) leaves edits on.
async function editsTurnedOff() {
  try {
    const res = await fetch(HEALTH_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const json = await res.json();
    return isObject(json) && json.edits === 'off';
  } catch {
    return false;
  }
}

// Member edits come from serve.py's API when it is there. On a static host
// they come from the committed data/annotations.json, read-only. Edits are
// enabled only when the API answered.
// Resolves to { annotations, editable, server } where server is true when the
// API answered (even if this server keeps edits turned off).
export async function loadAnnotations() {
  try {
    const res = await fetch(API_URL, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (res.ok) {
      const json = await res.json();
      if (isObject(json)) {
        const off = await editsTurnedOff();
        return { annotations: json, editable: !off, server: true };
      }
    }
  } catch { /* no API here */ }
  try {
    const res = await fetch(STATIC_ANNOTATIONS_URL, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      if (isObject(json)) return { annotations: json, editable: false, server: false };
    }
  } catch { /* no file either */ }
  return { annotations: {}, editable: false, server: false };
}

// Sends one member edit. Resolves to { ok, status, record, message }.
export async function saveAnnotation(id, body) {
  let res;
  try {
    res = await fetch(`${API_URL}/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach the server. Check that serve.py is still running." };
  }
  let payload = null;
  let text = '';
  try {
    text = await res.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) {
    let message = '';
    if (isObject(payload)) message = payload.error || payload.message || payload.detail || '';
    else if (text && text.length < 300 && !/<[a-z!]/i.test(text)) message = text.trim();
    // A 409 (someone else changed the field first) carries the stored record.
    const record = isObject(payload) && isObject(payload.record) ? payload.record : null;
    return { ok: false, status: res.status, message: typeof message === 'string' ? message : '', record };
  }
  let record = payload;
  if (isObject(record) && isObject(record.record)) record = record.record;
  else if (isObject(record) && isObject(record[id]) && !('updated_at' in record)) record = record[id];
  return { ok: true, status: res.status, record: isObject(record) ? record : null };
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function validTime(value) {
  return typeof value === 'string' && value.trim() !== '' && toDate(value) !== null;
}

// The current member values for one picture, cleaned up; used by the edit form.
export function memberValues(ann) {
  const a = isObject(ann) ? ann : {};
  return {
    title: text(a.title) || '',
    notes: text(a.notes) || '',
    place: text(a.place) || '',
    people: list(a.people),
    tags: list(a.tags),
    captured_at: validTime(a.captured_at) ? a.captured_at : null,
    lat: num(a.lat),
    lon: num(a.lon),
  };
}

// Who last changed each field, from the edit history.
function lastEditors(ann) {
  const out = {};
  const history = Array.isArray(ann.history) ? ann.history.filter(isObject) : [];
  const ordered = history
    .map((entry, i) => ({ entry, i, t: toDate(entry.at)?.getTime() ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  for (const { entry } of ordered) {
    if (!isObject(entry.changes)) continue;
    for (const field of Object.keys(entry.changes)) out[field] = text(entry.by) || null;
  }
  return out;
}

const CAMERA_SIZES = { picam: [640, 480], adcs: [512, 512] };

// One picture as the site shows it: computed values with member edits on top.
export function mergePhoto(img, ann) {
  const a = isObject(ann) ? ann : {};
  const editors = lastEditors(a);
  const fallbackEditor = text(a.updated_by) || 'a member';
  const who = (...fields) => {
    for (const f of fields) if (editors[f]) return editors[f];
    return fallbackEditor;
  };

  const values = memberValues(a);
  const lat = values.lat;
  const lon = values.lon;
  const positionOverride = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const timeOverride = values.captured_at;

  const computedPosition = isObject(img.position)
    && Number.isFinite(img.position.lat) && Number.isFinite(img.position.lon) ? img.position : null;

  const capturedAt = timeOverride || (validTime(img.captured_at) ? img.captured_at : null);
  const capturedDate = toDate(capturedAt);
  const captureDate = capturedDate ? isoDay(capturedDate)
    : (typeof img.capture_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(img.capture_date) ? img.capture_date.slice(0, 10) : null);

  const [fallbackW, fallbackH] = CAMERA_SIZES[img.camera] || [640, 480];
  const width = Number.isFinite(img.width) && img.width > 0 ? img.width : fallbackW;
  const height = Number.isFinite(img.height) && img.height > 0 ? img.height : fallbackH;

  // The build titles a picture by its capture time (build.py _title). When a
  // member corrects the time, a title that is just the old time follows it.
  const builtTitle = text(img.title);
  const builtTime = toDate(img.captured_at);
  const builtDay = typeof img.capture_date === 'string' ? toDate(img.capture_date.slice(0, 10)) : null;
  const timeTitle = (d) => `${dayMonthYear(d)}, ${clock(d)} UTC`;
  const titleFromTime = Boolean(builtTitle && (builtTime
    ? builtTitle === timeTitle(builtTime)
    : builtDay && builtTitle === dayMonthYear(builtDay)));
  const timeChanged = Boolean(timeOverride && capturedDate
    && (!builtTime || capturedDate.getTime() !== builtTime.getTime()));
  const defaultTitle = timeChanged && titleFromTime ? timeTitle(capturedDate) : (builtTitle || img.id);
  const title = values.title || defaultTitle;

  const downlinkFirst = toDate(img.downlink?.first);
  const sortTime = capturedDate?.getTime()
    ?? (captureDate ? Date.parse(captureDate) : null)
    ?? downlinkFirst?.getTime()
    ?? 0;

  // A member's lat/lon replaces the computed point; the computed place name
  // belonged to the old point, so it is dropped.
  const position = positionOverride
    ? { ...(computedPosition || {}), lat, lon, place: undefined }
    : computedPosition;
  const computedPlace = position && typeof position.place === 'string' && position.place.trim()
    ? position.place.trim() : null;

  const photo = {
    id: img.id,
    raw: img,
    ann: a,
    title,
    defaultTitle,
    notes: values.notes || null,
    place: values.place || null,
    computedPlace,
    people: values.people,
    tags: values.tags,
    camera: img.camera,
    status: img.status,
    dark: img.dark === true, // nothing to see: black, noise, or the Sun as a lone dot
    mostlyMissing: Number.isFinite(img.completeness) && img.completeness < 0.2, // under a fifth can be shown
    src: img.src || img.thumb,
    thumb: img.thumb || img.src,
    width,
    height,
    capturedAt,
    captureDate,
    month: captureDate ? captureDate.slice(0, 7) : 'unknown',
    position,
    edited: {
      title: values.title ? who('title') : null,
      notes: values.notes ? who('notes') : null,
      place: values.place ? who('place') : null,
      people: values.people.length ? who('people') : null,
      tags: values.tags.length ? who('tags') : null,
      captured_at: timeOverride ? who('captured_at') : null,
      position: positionOverride ? who('lat', 'lon') : null,
    },
    sortTime,
  };
  photo.search = fold([
    title, defaultTitle, photo.notes, photo.place, computedPlace, photo.people.join(' '), photo.tags.join(' '),
    img.file, img.id,
  ].filter(Boolean).join('\n'));
  return photo;
}

export function mergeAll(images, annotations) {
  const anns = isObject(annotations) ? annotations : {};
  const photos = images.map((img) => mergePhoto(img, anns[img.id]));
  // images.json is already newest first. Re-sort only when a member moved a
  // capture time, using the same rule: capture time, else downlink time.
  if (photos.some((p) => p.edited.captured_at)) {
    photos.sort((a, b) => b.sortTime - a.sortTime);
  }
  return photos;
}

/* Filters. They live in the URL, e.g. #/?camera=picam&month=2026-09&q=clouds
   Dark frames are left out unless dark=1, and mostly missing pictures unless
   missing=1; those two switches are not counted as filters. */

export const FILTER_KEYS = ['camera', 'status', 'month', 'member', 'tag', 'q', 'dark', 'missing'];
const NARROWING_KEYS = FILTER_KEYS.filter((key) => key !== 'dark' && key !== 'missing');

export function readFilters(params) {
  const f = {};
  for (const key of FILTER_KEYS) f[key] = (params.get(key) || '').trim();
  return f;
}

export function filtersToQuery(f) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (f[key]) params.set(key, f[key]);
  return params.toString();
}

export function hasFilters(f) {
  return NARROWING_KEYS.some((key) => f[key]);
}

export function applyFilters(photos, f) {
  const terms = fold(f.q).split(/\s+/).filter(Boolean);
  const member = fold(f.member);
  const tag = fold(f.tag);
  return photos.filter((p) => (f.dark || !p.dark)
    && (f.missing || !p.mostlyMissing)
    && (!f.camera || p.camera === f.camera)
    && (!f.status || p.status === f.status)
    && (!f.month || p.month === f.month)
    && (!member || p.people.some((x) => fold(x) === member))
    && (!tag || p.tags.some((x) => fold(x) === tag))
    && terms.every((t) => p.search.includes(t)));
}

function uniqueSorted(values) {
  const seen = new Map();
  for (const v of values) {
    const key = fold(v);
    if (!seen.has(key)) seen.set(key, v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function filterOptions(photos) {
  const months = [...new Set(photos.map((p) => p.month))]
    .sort((a, b) => (a === 'unknown') - (b === 'unknown') || b.localeCompare(a));
  return {
    cameras: [...new Set(photos.map((p) => p.camera).filter(Boolean))],
    statuses: [...new Set(photos.map((p) => p.status).filter(Boolean))],
    months,
    members: uniqueSorted(photos.flatMap((p) => p.people)),
    tags: uniqueSorted(photos.flatMap((p) => p.tags)),
  };
}
