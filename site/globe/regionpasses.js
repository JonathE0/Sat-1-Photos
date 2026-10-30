/**
 * When CTS-SAT-1's ground track crosses a place: the next few passes after
 * a time, each with how long the point under it stays inside the place, how
 * near the place's middle it comes and whether the ground there is in
 * daylight; and which pass is the best chance of a picture.
 *
 *   const place = getPlace('country:Japan');            // explore/journey-region.js
 *   const passes = findRegionPasses(orbit, place, Date.now());
 *   const best = bestPass(passes);                       // { index, reason }
 *
 * The track is walked a minute at a time, five seconds at a time near the
 * place's box, and each entry and exit is then pinned down to under a
 * second. No DOM, so fixtures/verify.mjs checks it under Node.
 */
import { DEG, EARTH_RADIUS_KM, groundLight, sunElevationDeg } from './astro.js';

const S = 1000;
/** How far ahead to look before saying there is no pass. */
export const SEARCH_DAYS = 30;

const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance between two ground points, km. */
export function surfaceKm(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Is a point inside the box [w, s, e, n] grown by `margin` degrees of arc? */
export function nearBox([w, s, e, n], lat, lon, margin) {
  if (lat < s - margin || lat > n + margin) return false;
  if (e - w >= 359) return true;
  const edgeLat = Math.min(89.9, Math.max(Math.abs(s), Math.abs(n)) + margin);
  const lonMargin = margin / Math.max(0.01, Math.cos(edgeLat * DEG));
  if (lonMargin >= 180) return true;
  return Math.abs(wrap(lon - (w + e) / 2)) <= (e - w) / 2 + lonMargin;
}

/**
 * Walk the ground track from `fromMs`, yielding progress (0 to 1) every few
 * hundred steps, and return up to `count` passes over `place` (from
 * getPlace): [{ startMs, endMs, durationS, closestMs, closestKm, latDeg,
 * lonDeg, altKm, sunElevationDeg, light, inProgress }]. A pass already under
 * way at `fromMs` counts, with inProgress set and its true start. With
 * `enough`, it stops early once it has that many passes and has looked
 * `enoughDays` ahead (the rest are only candidates for the best).
 */
export function* scanPasses(orbit, place, fromMs, {
  count = 3, days = SEARCH_DAYS, enough = count, enoughDays = days, coarseS = 60, fineS = 5, gapS = 120,
} = {}) {
  const passes = [];
  const end = fromMs + days * 86_400 * S;
  const softEnd = fromMs + enoughDays * 86_400 * S;
  const at = (ms) => orbit.stateAt(ms);
  const isIn = (s) => !!s && place.contains(s.latDeg, s.lonDeg);
  const inAt = (ms) => isIn(at(ms));
  const [midLon, midLat] = place.middle;
  const kmAt = (ms) => {
    const s = at(ms);
    return s ? surfaceKm(s.latDeg, s.lonDeg, midLat, midLon) : Infinity;
  };
  // the arc the point under the satellite covers in one coarse step, and a bit
  const margin = (7.7 * coarseS) / (EARTH_RADIUS_KM * DEG) + 1;

  /** The moment between an outside and an inside time where the track crosses the edge. */
  function edge(outMs, inMs) {
    for (let i = 0; i < 10; i++) {
      const mid = (outMs + inMs) / 2;
      if (inAt(mid)) inMs = mid;
      else outMs = mid;
    }
    return (outMs + inMs) / 2;
  }

  /** Nearest approach to the middle within a step either side of `ms`. */
  function nearest(ms) {
    let a = ms - fineS * S;
    let b = ms + fineS * S;
    const k = (Math.sqrt(5) - 1) / 2;
    let x1 = b - k * (b - a);
    let x2 = a + k * (b - a);
    let f1 = kmAt(x1);
    let f2 = kmAt(x2);
    for (let i = 0; i < 16; i++) {
      if (f1 > f2) {
        a = x1;
        [x1, f1] = [x2, f2];
        x2 = a + k * (b - a);
        f2 = kmAt(x2);
      } else {
        b = x2;
        [x2, f2] = [x1, f1];
        x1 = b - k * (b - a);
        f1 = kmAt(x1);
      }
    }
    return (a + b) / 2;
  }

  function finish(open, endMs) {
    const closestMs = nearest(open.closestMs);
    const s = at(closestMs) || at(open.closestMs);
    const sun = sunElevationDeg(s.latDeg, s.lonDeg, closestMs);
    passes.push({
      startMs: open.startMs,
      endMs,
      durationS: (endMs - open.startMs) / S,
      closestMs,
      closestKm: surfaceKm(s.latDeg, s.lonDeg, midLat, midLon),
      latDeg: s.latDeg,
      lonDeg: s.lonDeg,
      altKm: s.altKm,
      sunElevationDeg: sun,
      light: groundLight(sun),
      inProgress: open.inProgress,
    });
  }

  let open = null; // the pass being followed
  let prevMs = null;
  let prevIn = false;
  let steps = 0;
  for (let t = fromMs; t <= end && passes.length < count && !(passes.length >= enough && t > softEnd); ) {
    const s = at(t);
    const near = !!s && (open !== null || nearBox(place.bbox, s.latDeg, s.lonDeg, margin));
    const inside = near && isIn(s);
    if (inside) {
      if (!open) {
        let startMs;
        if (prevMs !== null) startMs = edge(prevMs, t);
        else {
          // already over the place: walk back to where this pass began
          let back = t;
          while (back > t - 2 * 3_600 * S && inAt(back - fineS * S)) back -= fineS * S;
          startMs = edge(back - fineS * S, back);
        }
        open = { startMs, lastInMs: t, outMs: null, closestMs: t, closestKm: Infinity, inProgress: prevMs === null };
      }
      open.lastInMs = t;
      open.outMs = null;
      const km = surfaceKm(s.latDeg, s.lonDeg, midLat, midLon);
      if (km < open.closestKm) {
        open.closestKm = km;
        open.closestMs = t;
      }
    } else if (open) {
      if (prevIn) open.outMs = t;
      // a short dip outside (a bay, a strait) belongs to the same pass
      if (t - open.lastInMs > gapS * S) {
        finish(open, edge(open.outMs ?? t, open.lastInMs));
        open = null;
      }
    }
    prevMs = t;
    prevIn = inside;
    t += (near ? fineS : coarseS) * S;
    if (++steps % 400 === 0) yield (t - fromMs) / (end - fromMs);
  }
  if (open && passes.length < count && passes.length < enough) finish(open, open.lastInMs);
  return passes;
}

/** All at once: for tests and small jobs. */
export function findRegionPasses(orbit, place, fromMs, opts) {
  const run = scanPasses(orbit, place, fromMs, opts);
  for (;;) {
    const r = run.next();
    if (r.done) return r.value;
  }
}

/** In slices of a few milliseconds, so the page keeps drawing while it
 * looks; `signal` (an AbortSignal) stops it. */
export async function findRegionPassesAsync(orbit, place, fromMs, { signal, sliceMs = 10, onProgress, ...opts } = {}) {
  const run = scanPasses(orbit, place, fromMs, opts);
  for (;;) {
    const start = performance.now();
    let r;
    do {
      r = run.next();
      if (r.done) return r.value;
    } while (performance.now() - start < sliceMs);
    onProgress?.(r.value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  }
}

/** "under 10 km", "120 km", "1,240 km" */
export function fmtKm(km) {
  if (km < 10) return 'under 10 km';
  return `${(Math.round(km / 10) * 10).toLocaleString('en-US')} km`;
}

/**
 * The best pass for a picture: in daylight first, then the one passing
 * closest to the place's middle. { index, reason } or null.
 */
export function bestPass(passes) {
  if (!passes.length) return null;
  const closest = (list) => list.reduce((a, b) => (b.closestKm < a.closestKm ? b : a));
  const lit = passes.filter((p) => p.sunElevationDeg > 0);
  const best = closest(lit.length ? lit : passes);
  const index = passes.indexOf(best);
  const km = fmtKm(best.closestKm);
  const sun = `sun ${Math.round(best.sunElevationDeg)}° up`;
  let reason;
  if (!lit.length) {
    reason = `None of these is in daylight, so this is the one closest to the middle, ${km} from it.`;
  } else if (lit.length === 1 && passes.length > 1) {
    reason = `The only one in daylight (${sun}), ${km} from the middle.`;
  } else if (best === closest(passes)) {
    reason = `In daylight (${sun}) and the closest to the middle, ${km} from it.`;
  } else {
    reason = `Of the passes in daylight, the closest to the middle: ${km} from it, ${sun}.`;
  }
  return { index, reason };
}
