/**
 * The one place that knows the gallery's data formats (docs/DATA.md).
 * Everything else in the globe works on the plain photo objects returned
 * by toPhotos:
 *
 *   { id, title, capturedAtUTC, lat, lon, thumb, href,
 *     captureDate, captureBasis, place, camera, status }
 *
 * capturedAtUTC is an ISO-8601 UTC string or null; lat/lon are numbers or
 * null (null means "work it out from the TLE and the capture time").
 * thumb and href are absolute URLs, or null.
 */

/**
 * How much is known of when a picture was taken: 'time', 'date' (only the
 * day) or 'none' (not even that: some attitude-camera frames carry no date).
 */
export function whenKnown(p) {
  const hasTime = p.ms !== undefined ? p.ms !== null : !!p.capturedAtUTC;
  return hasTime ? 'time' : p.captureDate ? 'date' : 'none';
}

/** Newest first: those with a time, then those with only a date, then the rest. */
export function comparePhotos(a, b) {
  const order = { time: 0, date: 1, none: 2 };
  const ka = whenKnown(a);
  const kb = whenKnown(b);
  if (ka !== kb) return order[ka] - order[kb];
  if (ka === 'time') return (b.ms ?? Date.parse(b.capturedAtUTC)) - (a.ms ?? Date.parse(a.capturedAtUTC));
  if (ka === 'date') return b.captureDate.localeCompare(a.captureDate);
  return 0;
}

/** Records in an images.json payload: { images: [...] } or a bare array. */
function records(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const key of ['images', 'photos', 'items']) {
      if (Array.isArray(json[key])) return json[key];
    }
  }
  return [];
}

function pick(obj, paths) {
  for (const path of paths) {
    let v = obj;
    for (const key of path.split('.')) {
      v = v == null ? undefined : v[key];
    }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ISO UTC string for a timestamp in any common shape, or null. A string
 * without a zone is read as UTC. */
export function toIsoUtc(v) {
  if (v === null || v === undefined || v === '') return null;
  let ms;
  if (typeof v === 'number') {
    ms = v < 1e11 ? v * 1000 : v; // seconds or milliseconds
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null; // date-only is not a time
    const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
    ms = Date.parse(zoned.replace(' ', 'T'));
  } else {
    return null;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : null;
}

function resolveUrl(path, base) {
  if (typeof path !== 'string' || !path) return null;
  try {
    return new URL(path, base).href;
  } catch {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The build's default title for a capture (build.py _title):
 * "17 Sep 2026, 07:11 UTC", or "17 Sep 2026" for a date alone. */
function timeTitle(iso, withTime = true) {
  const d = new Date(iso);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return day;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${day}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

function slug(text) {
  return String(text)
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Photos from an images.json payload.
 * @param {object|Array} json
 * @param {{ base?: string|URL }} [opts] base: the site root that `src`,
 *   `thumb` and the gallery's photo routes are relative to.
 */
export function toPhotos(json, { base = 'http://localhost/' } = {}) {
  const out = [];
  const seen = new Set();
  records(json).forEach((rec, i) => {
    if (!rec || typeof rec !== 'object') return;
    const file = pick(rec, ['file', 'path', 'filename', 'name']);
    let id = pick(rec, ['id', 'slug', 'key']);
    id = id !== null ? String(id) : file ? slug(file) : `photo-${i + 1}`;
    if (seen.has(id)) return;
    seen.add(id);

    const rawTime = pick(rec, [
      'captured_at',
      'captured_at_utc',
      'capturedAt',
      'capturedAtUTC',
      'capture.utc',
      'capture.time',
      'capture_time',
      'capture_time_utc',
      'timestamp',
      'time',
    ]);
    const capturedAtUTC = toIsoUtc(rawTime);
    const position = rec.position && typeof rec.position === 'object' ? rec.position : null;
    let lat = toNumber(pick(rec, ['position.lat', 'location.lat', 'lat', 'latitude', 'capture.lat']));
    let lon = toNumber(
      pick(rec, ['position.lon', 'location.lon', 'location.lng', 'lon', 'lng', 'longitude', 'capture.lon']),
    );
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      lat = null;
      lon = null;
    }
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
    let captureDate = pick(rec, ['capture_date', 'captured_date', 'date', 'capture.date']);
    if (capturedAtUTC) captureDate = isDate(captureDate) ? captureDate.slice(0, 10) : capturedAtUTC.slice(0, 10);
    else if (isDate(captureDate)) captureDate = captureDate.slice(0, 10);
    else captureDate = isDate(rawTime) ? rawTime.slice(0, 10) : null;

    const title = pick(rec, ['title', 'caption', 'name']) ?? file ?? id;
    const explicitHref = pick(rec, ['href', 'url', 'page', 'permalink']);
    out.push({
      id,
      title: String(title),
      capturedAtUTC,
      lat,
      lon,
      thumb: resolveUrl(pick(rec, ['thumb', 'thumbnail', 'thumb_url', 'src', 'image']), base),
      href: resolveUrl(explicitHref ?? `#/photo/${encodeURIComponent(id)}`, base),
      captureDate,
      captureBasis: pick(rec, ['capture_basis', 'capture.basis']),
      place: lat !== null ? pick(rec, ['position.place', 'location.place', 'location.name', 'place']) : null,
      camera: pick(rec, ['camera']),
      status: pick(rec, ['status']),
      // what the data's position was computed for; a later edit to the
      // capture time makes it stale (see applyAnnotations)
      positionTime: position && lat !== null ? capturedAtUTC : null,
    });
  });
  return out;
}

/**
 * Apply member edits (GET /api/annotations, or data/annotations.json: an
 * object keyed by photo id) to photos from toPhotos. Non-null `title`,
 * `captured_at`, `lat`, `lon` and `place` override the build's values; a
 * changed capture time without a new lat/lon drops the old position (and
 * place) so the globe recomputes it.
 */
export function applyAnnotations(photos, annotations) {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return photos;
  return photos.map((p) => {
    const a = annotations[p.id];
    if (!a || typeof a !== 'object') return p;
    const next = { ...p };
    const when = toIsoUtc(a.captured_at);
    if (when) {
      // A title that is just the build's time for the picture follows the
      // corrected time, as on the gallery page (data.js).
      const fromTime = p.capturedAtUTC
        ? p.title === timeTitle(p.capturedAtUTC)
        : p.captureDate && p.title === timeTitle(p.captureDate, false);
      if (fromTime && when !== p.capturedAtUTC) next.title = timeTitle(when);
      next.capturedAtUTC = when;
      next.captureDate = when.slice(0, 10);
    }
    if (typeof a.title === 'string' && a.title.trim()) next.title = a.title.trim();
    const lat = toNumber(a.lat);
    const lon = toNumber(a.lon);
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      next.lat = lat;
      next.lon = lon;
      next.place = null;
      next.positionTime = next.capturedAtUTC;
    } else if (when && when !== p.positionTime) {
      next.lat = null;
      next.lon = null;
      next.place = null;
      next.positionTime = null;
    }
    if (typeof a.place === 'string' && a.place.trim()) next.place = a.place.trim();
    return next;
  });
}

/** Launch time from images.json's `satellite` block, or null. */
export function launchTime(json) {
  const iso = toIsoUtc(json && !Array.isArray(json) ? pick(json, ['satellite.launched_at']) : null);
  return iso ? Date.parse(iso) : null;
}

/** URLs to try, in order, for member edits. */
export function annotationUrls(base) {
  return [resolveUrl('api/annotations', base), resolveUrl('data/annotations.json', base)].filter(Boolean);
}
