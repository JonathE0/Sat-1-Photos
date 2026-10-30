// Checks for the globe's maths and data adapter. Plain Node, no packages:
//
//   node site/globe/fixtures/verify.mjs
//
// Reference values in sgp4_reference.json come from Python sgp4
// (make_reference.py), so the satellite checks compare two independent
// SGP4 implementations and coordinate conversions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAnnotations, launchTime, toIsoUtc, toPhotos } from '../adapter.js';
import * as astro from '../astro.js';

const read = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const tles = read('../../data/tle.json');
const ref = read('./sgp4_reference.json');
const sample = read('./images.sample.json');

let failures = 0;
let passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
  if (ok) passed += 1;
  else failures += 1;
}

/** Great-circle distance between two points on a 6371 km sphere. */
function surfaceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- Sun ----------------------------------------------------------------------
{
  const ss = astro.subsolarPoint(Date.UTC(2026, 5, 21, 12));
  check(
    'subsolar point at 2026-06-21T12:00Z is about +23.4 deg lat, 0 deg lon (+-2 deg)',
    Math.abs(ss.latDeg - 23.4) <= 2 && Math.abs(ss.lonDeg) <= 2,
    `lat ${ss.latDeg.toFixed(3)}, lon ${ss.lonDeg.toFixed(3)}`,
  );
  // tighter: solstice declination 23.436 deg; equation of time -1.7 min puts it ~0.43 deg east
  check(
    '  ...and within 0.05 deg of 23.436 N, 0.1 deg of 0.43 E',
    Math.abs(ss.latDeg - 23.436) < 0.05 && Math.abs(ss.lonDeg - 0.43) < 0.1,
  );
  const eq = astro.subsolarPoint(Date.UTC(2026, 2, 20, 14, 46));
  check('Sun on the equator at the March 2026 equinox (20 Mar 14:46Z)', Math.abs(eq.latDeg) < 0.02, `dec ${eq.latDeg.toFixed(4)}`);
  const dec = astro.subsolarPoint(Date.UTC(2026, 11, 21, 20, 50));
  check('Sun at -23.44 deg at the December 2026 solstice', Math.abs(dec.latDeg + 23.436) < 0.02, `dec ${dec.latDeg.toFixed(4)}`);
  const sun = astro.sunPosition(Date.UTC(2027, 0, 3, 3));
  check('Earth-Sun distance at perihelion (3 Jan 2027) is 0.9833 AU', Math.abs(sun.distanceKm / 149597870.7 - 0.98333) < 0.0002);
  // the Sun is up at Calgary at local noon in June and down at midnight
  check('Sun high over Calgary at 2026-06-21 19:30Z', astro.sunElevationDeg(51.0777, -114.13, Date.UTC(2026, 5, 21, 19, 30)) > 60);
  check('Sun down at Calgary at 2026-10-29 07:00Z', astro.sunElevationDeg(51.0777, -114.13, Date.UTC(2026, 9, 29, 7)) < -30);
}

// ---- TLE selection --------------------------------------------------------------
const orbit = new astro.Orbit(tles);
{
  const it = orbit.items;
  const i = Math.floor(it.length / 2);
  check('TLEs load', it.length === tles.length, `${it.length} TLEs`);
  check('before the first epoch -> first TLE', orbit.indexAt(it[0].epochMs - 86_400_000) === 0);
  check('at an epoch -> that TLE', orbit.indexAt(it[i].epochMs) === i);
  check('between epochs -> the earlier TLE', orbit.indexAt(it[i + 1].epochMs - 1) === i);
  check('after the last epoch -> last TLE', orbit.indexAt(it[it.length - 1].epochMs + 30 * 86_400_000) === it.length - 1);
}

// ---- satellite vs Python sgp4 ----------------------------------------------------
for (const r of ref.tle_epochs) {
  const index = orbit.items.findIndex((t) => t.epochMs === Date.parse(r.tle_epoch));
  const s = orbit.stateAt(Date.parse(r.time), index);
  const d = surfaceKm(s.latDeg, s.lonDeg, r.lat, r.lon);
  const dAlt = Math.abs(s.altKm - r.alt_km);
  check(
    `sub-point at ${r.time} (TLE ${r.tle_epoch.slice(0, 16)}) matches Python sgp4 within 2 km`,
    index >= 0 && d < 2 && dAlt < 2,
    `${(d * 1000).toFixed(1)} m apart, altitude ${(dAlt * 1000).toFixed(1)} m`,
  );
}
for (const r of ref.photos) {
  const t = Date.parse(r.time);
  const s = orbit.stateAt(t);
  const d = surfaceKm(s.latDeg, s.lonDeg, r.lat, r.lon);
  check(
    `photo ${r.id}: sub-point at capture matches Python within 2 km`,
    d < 2 && Math.abs(s.altKm - r.alt_km) < 2 && s.tleEpochMs === Date.parse(r.tle_epoch),
    `${(d * 1000).toFixed(1)} m, TLE ${new Date(s.tleEpochMs).toISOString().slice(0, 16)}`,
  );
}

// ---- revolution number -----------------------------------------------------------
{
  const official = [
    '1 69015U 26100AM  26300.94355283  .00002867  00000-0  12339-3 0  9994',
    '2 69015  97.3833 196.6398 0006319 307.5969  52.4694 15.23410631 27023',
  ];
  const mine = tles.find((t) => t.line1.slice(18, 32) === official[0].slice(18, 32));
  if (mine) {
    check('exported TLE equals Space-Track element set 26300.94355283', mine.line1 === official[0] && mine.line2 === official[1]);
  } else {
    console.log('skip  Space-Track comparison: epoch 26300.94355283 not in tle.json');
  }
  const epoch = Date.parse(ref.space_track_rev.epoch);
  const rev = ref.space_track_rev.rev_at_epoch;
  check(
    `orbit number is ${rev} just before the ${ref.space_track_rev.epoch.slice(0, 16)} node and ${rev + 1} after`,
    orbit.revolutionAt(epoch - 1000) === rev && orbit.revolutionAt(epoch + 60_000) === rev + 1,
    `${orbit.revolutionAt(epoch - 1000)} / ${orbit.revolutionAt(epoch + 60_000)}`,
  );
  const period = orbit.periodMinutes(epoch) * 60_000;
  check('orbit number advances by one per orbit', orbit.revolutionAt(epoch + 10.5 * period) === rev + 11);
  check('orbit number in the first days is small', orbit.revolutionAt(Date.UTC(2026, 4, 3, 9)) === 1);
}

// ---- passes over Calgary vs brute force ----------------------------------------------
{
  const observer = astro.makeObserver(astro.CALGARY);
  const want = ref.passes.list;
  const got = astro.findPasses(orbit, observer, Date.parse(ref.passes.from), {
    count: want.length + 1,
    minElevationDeg: ref.passes.mask_deg,
    maxDays: ref.passes.hours / 24,
  });
  check(`finds the same ${want.length} passes above ${ref.passes.mask_deg} deg in 24 h`, got.length === want.length, `${got.length} found`);
  want.forEach((w, k) => {
    const g = got[k];
    if (!g) return;
    const dRise = (g.riseMs - Date.parse(w.rise)) / 1000;
    const dSet = (g.setMs - Date.parse(w.set)) / 1000;
    const dMax = Math.abs(g.maxElevationDeg - w.max_el);
    check(
      `pass ${w.rise.slice(11, 19)}: rise/set within 2 s, max elevation within 0.05 deg`,
      Math.abs(dRise) <= 2 && Math.abs(dSet) <= 2 && dMax < 0.05 && Math.abs(g.maxMs - Date.parse(w.max)) < 5000,
      `rise ${dRise.toFixed(2)} s, set ${dSet.toFixed(2)} s, max ${g.maxElevationDeg.toFixed(2)} deg`,
    );
  });
}

// ---- satellite light vs the sample's precomputed flags ----------------------------------
for (const img of sample.images.filter((i) => i.position)) {
  const t = Date.parse(img.captured_at);
  const s = orbit.stateAt(t);
  const light = astro.satelliteLight(s.eci, astro.sunPosition(t));
  const sunEl = astro.sunElevationDeg(img.position.lat, img.position.lon, t);
  check(
    `photo ${img.id}: light flags agree with the Python fixture`,
    light === img.position.satellite_light &&
      (light !== 'shadow') === img.position.satellite_sunlit &&
      sunEl > 0 === img.position.ground_sunlit &&
      Math.abs(sunEl - img.position.sun_elevation_deg) < 0.1,
    `ground sun ${sunEl.toFixed(1)} deg, satellite ${light}`,
  );
}

// ---- satellite light vs the real build (cts1_gallery/orbit.py), not just the fixture ----
{
  let images = [];
  try {
    images = read('../../data/images.json').images || [];
  } catch {
    console.log('skip  real build comparison: site/data/images.json not found');
  }
  for (const img of images) {
    const pos = img.position;
    if (!img.captured_at || !pos || !Number.isFinite(pos.sun_above_limb_deg)) continue;
    const t = Date.parse(img.captured_at);
    const s = orbit.stateAt(t);
    const sun = astro.sunPosition(t);
    const above = astro.sunAboveLimbDeg(s.eci, sun);
    const light = astro.satelliteLight(s.eci, sun);
    // The build rounds to 0.1 deg; skip the label test right at the band's edge.
    const edge = Math.abs(Math.abs(above) - astro.LIMB_BAND_DEG) < 0.1;
    check(
      `build photo ${img.id}: sun above the limb and light match the gallery`,
      Math.abs(above - pos.sun_above_limb_deg) < 0.15 && (edge || light === pos.satellite_light),
      `${above.toFixed(2)} deg vs ${pos.sun_above_limb_deg}, ${light} vs ${pos.satellite_light}`,
    );
  }
}

// ---- small geometry helpers ------------------------------------------------------------
check('footprint radius at 498 km is 21.96 deg', Math.abs(astro.footprintAngle(498) / astro.DEG - 21.96) < 0.02);
check('compass points', astro.compassPoint(0) === 'N' && astro.compassPoint(355) === 'N' && astro.compassPoint(22.5) === 'NNE' && astro.compassPoint(200) === 'SSW');

// ---- adapter --------------------------------------------------------------------------
{
  const base = 'http://example.test/site/';
  const photos = toPhotos(sample, { base });
  const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
  check('sample: 9 photos', photos.length === 9);
  check('an L-suffixed capture is read as 17:37:32 UTC', byId['2026-10-24-173732l']?.capturedAtUTC === '2026-10-24T17:37:32Z');
  check(
    'date-only and unknown captures have no time',
    ['2026-09-23', '2026-07-20', 'adcs-img-5608'].every((id) => byId[id] && byId[id].capturedAtUTC === null),
  );
  check('date-only capture keeps its date', byId['2026-09-23'].captureDate === '2026-09-23');
  const p = byId['2026-09-17-071148z'];
  check('position.lat/lon are read', p.lat === 65.5818 && p.lon === -111.0383, `${p.lat}, ${p.lon}`);
  check('thumb resolves against the site root', p.thumb === `${base}images/thumbs/2026-09-17-071148z.jpg`);
  check('href is the gallery route', p.href === `${base}#/photo/2026-09-17-071148z`);
  check('launch time read from satellite.launched_at', launchTime(sample) === Date.UTC(2026, 4, 3, 6, 59));

  const variants = toPhotos([
    { name: 'camera/2026-09-17_071148Z.img', captured_at_utc: '2026-09-17 07:11:48', location: { lat: 1.5, lon: -2 }, src: 'a.jpg' },
    { id: 'b', capture: { utc: '2026-10-11T08:20:30+00:00' }, thumbnail: '/t/b.jpg' },
    { id: 'c', capture_time: 1760170830 },
    { id: 'd', captured_at: '2026-09-23' },
    { id: 'e', capturedAt: '2026-10-22T09:07:59-06:00', lat: 95, lon: 0 },
  ], { base });
  const v = Object.fromEntries(variants.map((x) => [x.id, x]));
  check('variant: id from file name, zone-less time read as UTC, location.lat/lon',
    v['2026-09-17-071148z']?.capturedAtUTC === '2026-09-17T07:11:48Z' && v['2026-09-17-071148z'].lat === 1.5 && v['2026-09-17-071148z'].lon === -2);
  check('variant: src used as thumb when there is no thumb', v['2026-09-17-071148z']?.thumb === `${base}a.jpg`);
  check('variant: capture.utc with offset', v.b?.capturedAtUTC === '2026-10-11T08:20:30Z' && v.b.thumb === 'http://example.test/t/b.jpg');
  check('variant: epoch seconds', v.c?.capturedAtUTC === '2025-10-11T08:20:30Z');
  check('variant: a bare date is not a capture time', v.d?.capturedAtUTC === null && v.d.captureDate === '2026-09-23');
  check('variant: offset converted, out-of-range latitude dropped', v.e?.capturedAtUTC === '2026-10-22T15:07:59Z' && v.e.lat === null);
  check('{ photos: [...] } and bare arrays both work', toPhotos({ photos: [{ id: 'x' }] }).length === 1 && toPhotos([{ id: 'y' }]).length === 1);
  const placed = toPhotos({ images: [{ id: 'f', captured_at: '2026-10-25T00:54:33Z', position: { lat: -81.2548, lon: -156.3836, place: 'Southern Ocean' } }] }, { base })[0];
  check('position.place is read', placed.place === 'Southern Ocean' && placed.lat === -81.2548);
  const moved = applyAnnotations([placed], { f: { captured_at: '2026-10-25T01:00:00Z' } })[0];
  check('annotation: a new capture time drops the stale place too', moved.place === null && moved.lat === null);
  check('annotation: place override', applyAnnotations([placed], { f: { place: 'Ross Sea' } })[0].place === 'Ross Sea');
  check('toIsoUtc rejects junk', toIsoUtc('yesterday') === null && toIsoUtc(null) === null);

  const edited = applyAnnotations(photos, {
    '2026-09-17-071148z': { title: 'Clouds over Hudson Bay', captured_at: null, lat: null, lon: null },
    '2026-10-11-082030z': { captured_at: '2026-10-11T08:21:00Z' },
    '2026-10-22-150759z': { lat: 10, lon: 20 },
    'not-a-photo': { title: 'ignored' },
  });
  const e = Object.fromEntries(edited.map((x) => [x.id, x]));
  check('annotation: title override', e['2026-09-17-071148z'].title === 'Clouds over Hudson Bay' && e['2026-09-17-071148z'].lat === 65.5818);
  check('annotation: new capture time drops the stale position', e['2026-10-11-082030z'].capturedAtUTC === '2026-10-11T08:21:00Z' && e['2026-10-11-082030z'].lat === null);
  check('annotation: lat/lon override', e['2026-10-22-150759z'].lat === 10 && e['2026-10-22-150759z'].lon === 20);
  check('annotation: untouched photos unchanged', e['2026-10-25005433z'] === byId['2026-10-25005433z']);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
