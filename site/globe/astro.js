/**
 * Sun, Earth-rotation and orbit maths for the globe.
 *
 * Nothing here touches the DOM or three.js, so fixtures/verify.mjs can
 * check it under Node. Frames: "ECI" is SGP4's TEME frame; "ECEF" is that
 * frame turned by Greenwich mean sidereal time (IAU-82, which is what SGP4
 * assumes). Angles are radians unless a name ends in Deg; times are Unix
 * milliseconds.
 */
import {
  eciToEcf,
  eciToGeodetic,
  geodeticToEcf,
  gstime,
  sgp4,
  twoline2satrec,
} from './vendor/satellite.es.js';

export const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;

/** Mean Earth radius: one unit of the globe. */
export const EARTH_RADIUS_KM = 6371.0;
const AU_KM = 149_597_870.7;

/** Falcon 9 lift-off with the CAS500-2 rideshare (SatNOGS DB). */
export const LAUNCH_MS = Date.UTC(2026, 4, 3, 6, 59);

/** University of Calgary ground station. */
export const CALGARY = Object.freeze({ name: 'Calgary', latDeg: 51.0777, lonDeg: -114.13, heightKm: 1.1 });

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Angle wrapped into [-pi, pi). */
export function wrapPi(a) {
  const t = (a + Math.PI) % TWO_PI;
  return (t < 0 ? t + TWO_PI : t) - Math.PI;
}

export function julianDate(ms) {
  return ms / MS_PER_DAY + 2440587.5;
}

/** Greenwich mean sidereal time, radians. */
export function gmst(ms) {
  return gstime(julianDate(ms));
}

/** Rotate an ECI vector into ECEF at sidereal angle `theta`. */
export function eciToEcef(v, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
}

/**
 * The Sun, from the Astronomical Almanac's low-precision formulae (good to
 * about 0.01 degrees between 1950 and 2050). `x, y, z` is the unit vector
 * from Earth's centre in ECI (equator and equinox of date).
 */
export function sunPosition(ms) {
  const n = julianDate(ms) - 2451545.0; // days from J2000.0
  const meanLongitude = (280.46 + 0.9856474 * n) * DEG;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;
  const lambda =
    meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  const x = Math.cos(lambda);
  const y = Math.cos(obliquity) * Math.sin(lambda);
  const z = Math.sin(obliquity) * Math.sin(lambda);
  const au = 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2 * meanAnomaly);
  return { x, y, z, distanceKm: au * AU_KM, ra: Math.atan2(y, x), dec: Math.asin(z) };
}

/** Unit vector toward the Sun in ECEF. */
export function sunDirectionEcef(ms) {
  return eciToEcef(sunPosition(ms), gmst(ms));
}

/** Where the Sun is overhead. */
export function subsolarPoint(ms) {
  const sun = sunPosition(ms);
  return { latDeg: sun.dec / DEG, lonDeg: wrapPi(sun.ra - gmst(ms)) / DEG };
}

/** Unit ellipsoid normal ("up") at a geodetic latitude/longitude, ECEF. */
export function upVector(latDeg, lonDeg) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
}

/** The Sun's elevation above the horizon at a place on the ground, degrees. */
export function sunElevationDeg(latDeg, lonDeg, ms, sunEcef = sunDirectionEcef(ms)) {
  const up = upVector(latDeg, lonDeg);
  return Math.asin(clamp(up.x * sunEcef.x + up.y * sunEcef.y + up.z * sunEcef.z, -1, 1)) / DEG;
}

/** 'day' (Sun up), 'twilight' (down to -6 degrees) or 'night'. */
export function groundLight(sunElevation) {
  if (sunElevation > 0) return 'day';
  return sunElevation > -6 ? 'twilight' : 'night';
}

/**
 * Within this many degrees of Earth's limb the Sun counts as on the limb
 * (refraction ~1.1 degrees plus the Sun's 0.27-degree radius): the satellite
 * is at the terminator. The gallery build (cts1_gallery/orbit.py) uses the
 * same model, and the globe must agree with it.
 */
export const LIMB_BAND_DEG = 1.5;

/**
 * The Sun's angle above Earth's limb as seen from a satellite at ECI
 * position `r` (km), in degrees; negative when the Sun is behind the Earth.
 * `sun` is from sunPosition. Mirrors orbit.py `_sun_above_limb`.
 */
export function sunAboveLimbDeg(r, sun) {
  const d = Math.hypot(r.x, r.y, r.z);
  const fromNadir = Math.acos(clamp(-(r.x * sun.x + r.y * sun.y + r.z * sun.z) / d, -1, 1));
  return (fromNadir - Math.asin(Math.min(1, EARTH_RADIUS_KM / d))) / DEG;
}

/** 'sunlit', 'terminator' (the Sun on Earth's limb) or 'shadow', as the gallery reports it. */
export function satelliteLight(r, sun) {
  const above = sunAboveLimbDeg(r, sun);
  if (above > LIMB_BAND_DEG) return 'sunlit';
  return above < -LIMB_BAND_DEG ? 'shadow' : 'terminator';
}

/** Central angle (radians) from the sub-satellite point to the edge of
 * the area that sees the satellite above `maskDeg` elevation. */
export function footprintAngle(altKm, maskDeg = 0) {
  const mask = maskDeg * DEG;
  const ratio = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(0, altKm))) * Math.cos(mask);
  return Math.acos(clamp(ratio, -1, 1)) - mask;
}

/** An observer with its ECEF position and rotation cached. */
export function makeObserver({ name = '', latDeg, lonDeg, heightKm = 0 }) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return {
    name,
    latDeg,
    lonDeg,
    heightKm,
    ecf: geodeticToEcf({ latitude: lat, longitude: lon, height: heightKm }),
    sLat: Math.sin(lat),
    cLat: Math.cos(lat),
    sLon: Math.sin(lon),
    cLon: Math.cos(lon),
  };
}

/** Elevation, azimuth (from north, clockwise) and range of an ECEF point. */
export function lookAngles(observer, ecf) {
  const o = observer;
  const rx = ecf.x - o.ecf.x;
  const ry = ecf.y - o.ecf.y;
  const rz = ecf.z - o.ecf.z;
  const south = o.sLat * o.cLon * rx + o.sLat * o.sLon * ry - o.cLat * rz;
  const east = -o.sLon * rx + o.cLon * ry;
  const up = o.cLat * o.cLon * rx + o.cLat * o.sLon * ry + o.sLat * rz;
  const rangeKm = Math.hypot(south, east, up);
  const az = Math.atan2(east, -south) / DEG;
  return {
    elevationDeg: Math.asin(up / rangeKm) / DEG,
    azimuthDeg: az < 0 ? az + 360 : az,
    rangeKm,
  };
}

/** Fraction of a revolution since the last ascending node, from the
 * argument of latitude of a position/velocity pair. */
function nodePhase(r, v) {
  const hx = r.y * v.z - r.z * v.y;
  const hy = r.z * v.x - r.x * v.z;
  const nx = -hy; // node vector: z-axis cross angular momentum
  const ny = hx;
  const cosU =
    (nx * r.x + ny * r.y) / (Math.hypot(nx, ny) * Math.hypot(r.x, r.y, r.z));
  let u = Math.acos(clamp(cosU, -1, 1));
  if (r.z < 0) u = TWO_PI - u;
  return u / TWO_PI;
}

/**
 * The TLE history, propagated with SGP4. At any time the TLE used is the
 * latest one with an epoch at or before that time, or the first one for
 * times before the history starts.
 */
export class Orbit {
  /** @param {{epoch: string, line1: string, line2: string}[]} tles */
  constructor(tles) {
    this.items = (Array.isArray(tles) ? tles : [])
      .filter((t) => t && typeof t.line1 === 'string' && typeof t.line2 === 'string')
      .map((t) => ({
        epochMs: Date.parse(t.epoch),
        line1: t.line1,
        line2: t.line2,
        rev: parseInt(t.line2.slice(63, 68), 10) || 0,
        satrec: null,
      }))
      .filter((t) => Number.isFinite(t.epochMs))
      .sort((a, b) => a.epochMs - b.epochMs);
    if (!this.items.length) throw new Error('No usable TLEs');
  }

  get firstEpochMs() {
    return this.items[0].epochMs;
  }

  get lastEpochMs() {
    return this.items[this.items.length - 1].epochMs;
  }

  /** Index of the TLE in force at `ms`. */
  indexAt(ms) {
    const items = this.items;
    if (!(ms >= items[0].epochMs)) return 0;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].epochMs <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  satrec(index) {
    const item = this.items[index];
    if (!item.satrec) {
      item.satrec = twoline2satrec(item.line1, item.line2);
      item.satrecEpochMs = (item.satrec.jdsatepoch - 2440587.5) * MS_PER_DAY;
    }
    return item.satrec;
  }

  /** Orbital period of the TLE in force at `ms`, minutes. */
  periodMinutes(ms) {
    return TWO_PI / this.satrec(this.indexAt(ms)).no;
  }

  /** ECI position (km) and velocity (km/s) at `ms`, or null if SGP4 fails. */
  eciAt(ms, index = this.indexAt(ms)) {
    const rec = this.satrec(index);
    const pv = sgp4(rec, (ms - this.items[index].satrecEpochMs) / MS_PER_MIN);
    if (!pv || !pv.position || rec.error) return null;
    return { r: pv.position, v: pv.velocity, index };
  }

  /** Where the satellite is at `ms`, or null if SGP4 fails. */
  stateAt(ms, index = this.indexAt(ms)) {
    const pv = this.eciAt(ms, index);
    if (!pv) return null;
    const theta = gmst(ms);
    const geo = eciToGeodetic(pv.r, theta);
    return {
      ms,
      index,
      tleEpochMs: this.items[index].epochMs,
      eci: pv.r,
      velocity: pv.v,
      gmst: theta,
      ecef: eciToEcf(pv.r, theta),
      latDeg: geo.latitude / DEG,
      lonDeg: geo.longitude / DEG,
      altKm: geo.height,
      speedKmS: Math.hypot(pv.v.x, pv.v.y, pv.v.z),
    };
  }

  /**
   * Revolution number at `ms`: ascending-node crossings since launch, the
   * convention of the TLE's own revolution field (columns 64-68 of line 2,
   * which counts up to just before the epoch).
   */
  revolutionAt(ms) {
    const index = this.indexAt(ms);
    const rec = this.satrec(index);
    const refMs = this.items[index].satrecEpochMs - 1000;
    const a = this.eciAt(refMs, index);
    const b = this.eciAt(ms, index);
    if (!a || !b) return null;
    const revsPerMinute = (rec.mdot + rec.argpdot) / TWO_PI;
    const crossings = Math.round(
      nodePhase(a.r, a.v) + (revsPerMinute * (ms - refMs)) / MS_PER_MIN - nodePhase(b.r, b.v),
    );
    return this.items[index].rev + crossings;
  }

  /** Elevation of the satellite seen by `observer` (see makeObserver). */
  elevationDeg(observer, ms) {
    const pv = this.eciAt(ms);
    if (!pv) return -90;
    return lookAngles(observer, eciToEcf(pv.r, gmst(ms))).elevationDeg;
  }
}

function maximise(f, a, b, iterations = 28) {
  const k = (Math.sqrt(5) - 1) / 2;
  let x1 = b - k * (b - a);
  let x2 = a + k * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < iterations; i++) {
    if (f1 < f2) {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + k * (b - a);
      f2 = f(x2);
    } else {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - k * (b - a);
      f1 = f(x1);
    }
  }
  return (a + b) / 2;
}

/** Time, stepping from `fromMs` (where f >= level) in direction `dir`, at
 * which f drops below `level`. */
function crossing(f, level, fromMs, dir, stepMs = 15_000, limitMs = 40 * MS_PER_MIN) {
  let inside = fromMs;
  let outside = null;
  for (let t = fromMs + dir * stepMs; Math.abs(t - fromMs) <= limitMs; t += dir * stepMs) {
    if (f(t) < level) {
      outside = t;
      break;
    }
    inside = t;
  }
  if (outside === null) return inside;
  for (let i = 0; i < 14; i++) {
    const mid = (inside + outside) / 2;
    if (f(mid) >= level) inside = mid;
    else outside = mid;
  }
  return (inside + outside) / 2;
}

/**
 * The next `count` passes of the satellite above `minElevationDeg` as seen
 * by `observer`, starting with any pass in progress at `fromMs`. Rise and
 * set are the moments it crosses `minElevationDeg`.
 */
export function findPasses(orbit, observer, fromMs, { count = 4, minElevationDeg = 10, maxDays = 4 } = {}) {
  const el = (ms) => orbit.elevationDeg(observer, ms);
  const azAt = (ms) => {
    const pv = orbit.eciAt(ms);
    return pv ? lookAngles(observer, eciToEcf(pv.r, gmst(ms))).azimuthDeg : 0;
  };
  const step = 30_000;
  const end = fromMs + maxDays * MS_PER_DAY;
  const passes = [];
  let t0 = fromMs - 20 * MS_PER_MIN;
  let e0 = el(t0);
  let t1 = t0 + step;
  let e1 = el(t1);
  for (let t2 = t1 + step; t2 <= end && passes.length < count; t2 += step) {
    const e2 = el(t2);
    if (e1 >= e0 && e1 > e2 && e1 > minElevationDeg - 8) {
      const maxMs = maximise(el, t0, t2);
      const maxElevationDeg = el(maxMs);
      if (maxElevationDeg >= minElevationDeg) {
        const setMs = crossing(el, minElevationDeg, maxMs, +1);
        if (setMs > fromMs) {
          const riseMs = crossing(el, minElevationDeg, maxMs, -1);
          passes.push({
            riseMs,
            maxMs,
            setMs,
            maxElevationDeg,
            riseAzimuthDeg: azAt(riseMs),
            setAzimuthDeg: azAt(setMs),
          });
        }
      }
    }
    t0 = t1;
    e0 = e1;
    t1 = t2;
    e1 = e2;
  }
  return passes;
}

/** Sixteen-point compass name for an azimuth in degrees. */
export function compassPoint(azDeg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}
