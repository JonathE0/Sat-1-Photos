/**
 * Where the Moon is, for the sky (the Moon itself) and the Earth (moonlight).
 *
 * Mean orbital elements plus the largest perturbations (evection, variation,
 * yearly and parallactic equations, ...), after Paul Schlyter's "How to
 * compute planetary positions". Checked against JPL Horizons over Oct-Dec
 * 2026: within 0.07 degrees (typically 0.03), distance within 0.25%.
 * Geocentric, referred to the equator and equinox of date, the same frame as
 * site/globe/astro.js sunPosition (and, to well under a degree, SGP4's TEME).
 * Times are Unix milliseconds.
 */
const DEG = Math.PI / 180;
/** The elements' distance unit: Earth's equatorial radius, km. */
const EQUATORIAL_RADIUS_KM = 6378.14;

const rev = (x) => ((x % 360) + 360) % 360;

/**
 * @param {number} ms
 * @returns {{x: number, y: number, z: number, distanceKm: number, ra: number, dec: number}}
 *   x, y, z: unit vector from Earth's centre in ECI; ra, dec in radians
 */
export function moonPosition(ms) {
  const d = ms / 86_400_000 + 2440587.5 - 2451543.5; // days from 2000 Jan 0.0
  const N = rev(125.1228 - 0.0529538083 * d) * DEG; // ascending node
  const i = 5.1454 * DEG;
  const w = rev(318.0634 + 0.1643573223 * d) * DEG; // argument of perigee
  const a = 60.2666;
  const e = 0.0549;
  const M = rev(115.3654 + 13.0649929509 * d) * DEG; // mean anomaly

  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 4; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  let r = Math.hypot(xv, yv);

  const cvw = Math.cos(v + w);
  const svw = Math.sin(v + w);
  const xh = r * (Math.cos(N) * cvw - Math.sin(N) * svw * Math.cos(i));
  const yh = r * (Math.sin(N) * cvw + Math.cos(N) * svw * Math.cos(i));
  const zh = r * svw * Math.sin(i);
  let lon = Math.atan2(yh, xh);
  let lat = Math.atan2(zh, Math.hypot(xh, yh));

  // perturbations by the Sun
  const Ms = rev(356.047 + 0.9856002585 * d) * DEG;
  const Ls = Ms + (282.9404 + 4.70935e-5 * d) * DEG;
  const Lm = M + w + N;
  const D = Lm - Ls; // mean elongation
  const F = Lm - N; // argument of latitude
  const s = Math.sin;
  lon += DEG * (
    -1.274 * s(M - 2 * D) + 0.658 * s(2 * D) - 0.186 * s(Ms) - 0.059 * s(2 * M - 2 * D) -
    0.057 * s(M - 2 * D + Ms) + 0.053 * s(M + 2 * D) + 0.046 * s(2 * D - Ms) + 0.041 * s(M - Ms) -
    0.035 * s(D) - 0.031 * s(M + Ms) - 0.015 * s(2 * F - 2 * D) + 0.011 * s(M - 4 * D));
  lat += DEG * (
    -0.173 * s(F - 2 * D) - 0.055 * s(M - F - 2 * D) - 0.046 * s(M + F - 2 * D) +
    0.033 * s(F + 2 * D) + 0.017 * s(2 * M + F));
  r += -0.58 * Math.cos(M - 2 * D) - 0.46 * Math.cos(2 * D);

  // ecliptic -> equator of date
  const eps = (23.4393 - 3.563e-7 * d) * DEG;
  const xe = Math.cos(lat) * Math.cos(lon);
  const ye = Math.cos(lat) * Math.sin(lon);
  const ze = Math.sin(lat);
  const x = xe;
  const y = ye * Math.cos(eps) - ze * Math.sin(eps);
  const z = ye * Math.sin(eps) + ze * Math.cos(eps);
  return { x, y, z, distanceKm: r * EQUATORIAL_RADIUS_KM, ra: Math.atan2(y, x), dec: Math.asin(z) };
}

/** Fraction of the Moon's disc that is lit, from the Sun's ECI direction (any length). */
export function moonIlluminated(moon, sunEci) {
  const s = Math.hypot(sunEci.x, sunEci.y, sunEci.z) || 1;
  return (1 - (moon.x * sunEci.x + moon.y * sunEci.y + moon.z * sunEci.z) / s) / 2;
}
