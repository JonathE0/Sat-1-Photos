// Checks for the globe's maths and data adapter. Plain Node, no packages:
//
//   node site/globe/fixtures/verify.mjs
//
// Reference values in sgp4_reference.json come from Python sgp4
// (make_reference.py), so the satellite checks compare two independent
// SGP4 implementations and coordinate conversions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAnnotations, comparePhotos, launchTime, toIsoUtc, toPhotos, whenKnown } from '../adapter.js';
import { bytes, calgary, grouped, monthDayYear, plural, utcLong } from '../../assets/format.js';
import { calgaryTime, launchDate, utcLong as exploreLong, utcShort as exploreShort } from '../../explore/journey-parts.js';
import * as astro from '../astro.js';
import { auroraNote, parseForecast, turnSince } from '../aurora.js';
import * as wheel from '../colorwheel.js';
import { labelBox, placeLabel } from '../labels.js';
import * as map2d from '../map2d.js';
import * as region from '../../explore/journey-region.js';
import * as rp from '../regionpasses.js';
import * as shot from '../shotcamera.js';
import { calgaryWhen, elementsNote, FAR_DAYS, parseUtcInput, utcInputs, VERY_FAR_DAYS } from '../timepick.js';

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

// ---- 2D map (map2d.js) -------------------------------------------------------------------
{
  const D = astro.DEG;
  /** Angle between two ground points, radians. */
  const between = (lat1, lon1, lat2, lon2) => surfaceKm(lat1, lon1, lat2, lon2) / 6371;

  // projection: 1440 x 900 with the clock bar's 96 px at the bottom
  const view = new map2d.MapView();
  Object.assign(view, { w: 1440, h: 900, inset: { top: 0, right: 0, bottom: 96, left: 0 } });
  view.k = view.minK;
  view.clamp();
  check(
    'map: widest zoom puts the poles on the frame edges and 0 deg in the middle',
    Math.abs(view.y(90)) < 1e-9 && Math.abs(view.y(-90) - 804) < 1e-9 && Math.abs(view.x(0) - 720) < 1e-9,
    `k ${view.k.toFixed(3)} px/deg`,
  );
  check('map: x runs evenly from 180 W to 180 E', Math.abs(view.x(179.999) - view.x(-180) - 359.999 * view.k) < 1e-6);
  view.cLon = -100;
  view.k *= 3;
  view.cLat = 40;
  view.clamp();
  let worst = 0;
  for (let i = 0; i < 48; i++) {
    const t = Date.UTC(2026, 9, 20) + i * 37 * 60_000;
    const s = orbit.stateAt(t);
    const x = view.x(s.lonDeg);
    const y = view.y(s.latDeg);
    worst = Math.max(worst, surfaceKm(view.latAt(y), map2d.wrapLon(view.lonAt(x)), s.latDeg, s.lonDeg));
  }
  check('map: satellite positions go to the map and back within 1 m', worst < 0.001, `${(worst * 1000).toFixed(6)} m`);
  const xs = view.xs(-100, 0);
  check('map: a point at the centre is drawn once when zoomed in', xs.length === 1 && Math.abs(xs[0] - view.cx) < 1e-9);
  const wide = new map2d.MapView();
  Object.assign(wide, { w: 3440, h: 600 });
  wide.k = 4;
  check('map: a canvas wider than the world draws a point in every copy', wide.xs(0, 0).length === 3, `${wide.xs(0, 0).length} copies`);

  // the track crosses the antimeridian as one line
  const t0 = Date.UTC(2026, 9, 25);
  const period = orbit.periodMinutes(t0);
  const samples = [];
  for (let m = -period; m <= 2 * period; m += 0.5) samples.push(orbit.stateAt(t0 + m * 60_000));
  const lons = map2d.unwrapLons(samples.map((s) => s.lonDeg));
  let jump = 0;
  let same = true;
  for (let i = 0; i < lons.length; i++) {
    if (i) jump = Math.max(jump, Math.abs(lons[i] - lons[i - 1]));
    if (Math.abs(map2d.wrapLon(lons[i]) - map2d.wrapLon(samples[i].lonDeg)) > 1e-9) same = false;
  }
  const spanDeg = Math.abs(lons[lons.length - 1] - lons[0]);
  check(
    'map: three orbits of track unwrap with no jumps, the same places, across the antimeridian',
    jump < 30 && same && spanDeg > 720,
    `largest step ${jump.toFixed(2)} deg, ${spanDeg.toFixed(0)} deg of longitude`,
  );

  // terminator: the map's Sun angle is astro's, and the masks put day and night in the right cells
  let elevErr = 0;
  for (let i = 0; i < 200; i++) {
    const lat = -89 + ((i * 47) % 179);
    const lon = -180 + ((i * 113) % 360);
    const t = astro.LAUNCH_MS + i * 13.7 * 3_600_000;
    const mapEl = Math.asin(map2d.sunCosine(lat, lon, astro.sunDirectionEcef(t))) / D;
    elevErr = Math.max(elevErr, Math.abs(mapEl - astro.sunElevationDeg(lat, lon, t)));
  }
  check('map: Sun elevation from the map equals astro.sunElevationDeg', elevErr < 1e-9, `max ${elevErr.toExponential(1)} deg`);
  check(
    'map: day picture fully shown 2 deg up, gone 6 deg down (as the globe shader)',
    map2d.dayWeight(Math.sin(2.01 * D)) > 0.999 && map2d.dayWeight(Math.sin(-6.04 * D)) < 0.001,
  );
  const cols = 720;
  const rows = 360;
  const dim = new Uint8ClampedArray(cols * rows * 4);
  const day = new Uint8ClampedArray(cols * rows * 4);
  for (const t of [Date.UTC(2026, 5, 21, 12), Date.UTC(2026, 9, 29, 18, 30), Date.UTC(2026, 11, 21, 3)]) {
    const sun = astro.sunDirectionEcef(t);
    map2d.shadeMasks(sun, dim, day, cols, rows);
    let wrong = 0;
    let edgeOff = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const { latDeg, lonDeg } = map2d.maskCell(i, j, cols, rows);
        const el = astro.sunElevationDeg(latDeg, lonDeg, t);
        const a = day[(j * cols + i) * 4 + 3];
        if ((el > 2.1 && a !== 255) || (el < -6.1 && a !== 0)) wrong++;
        // where day turns to night along a row, astro must put the Sun in the twilight band
        if (i && (a >= 128) !== (day[(j * cols + i - 1) * 4 + 3] >= 128) && (el < -6.6 || el > 2.6)) edgeOff++;
      }
    }
    const ss = astro.subsolarPoint(t);
    const at = (lat, lon) => {
      const i = Math.floor(((map2d.wrapLon(lon) + 180) / 360) * cols);
      const j = Math.min(rows - 1, Math.floor(((90 - lat) / 180) * rows));
      return { day: day[(j * cols + i) * 4 + 3], dim: dim[(j * cols + i) * 4 + 3] };
    };
    const noon = at(ss.latDeg, ss.lonDeg);
    const midnight = at(-ss.latDeg, ss.lonDeg + 180);
    check(
      `map: day/night masks for ${new Date(t).toISOString().slice(0, 16)} match astro in all ${cols * rows} cells`,
      wrong === 0 && edgeOff === 0 && noon.day === 255 && noon.dim === 0 && midnight.day === 0,
      `${wrong} cells wrong, ${edgeOff} terminator cells off, subsolar day ${noon.day}, antisolar day ${midnight.day}`,
    );
  }

  // footprint: every point of the ring is the footprint radius from the sub-point
  for (const [lat, lon, alt] of [[51, -114, 510], [80, 170, 520], [-79, -179, 500], [0, 179.5, 498]]) {
    const angle = astro.footprintAngle(alt);
    const ring = map2d.footprintRing(lat, lon, angle);
    let err = 0;
    for (const p of ring) err = Math.max(err, Math.abs(between(lat, lon, p.latDeg, p.lonDeg) - angle));
    const turn = Math.abs(ring[ring.length - 1].lonDeg - ring[0].lonDeg);
    const polar = Math.abs(lat) + angle / D > 90;
    check(
      `map: footprint at ${lat}, ${lon} is a ${(angle / D).toFixed(2)} deg circle${polar ? ' round the pole' : ''}`,
      err < 1e-6 && (polar ? Math.abs(turn - 360) < 1e-6 : turn < 1e-6),
      `max error ${(err / D).toExponential(1)} deg, ends ${turn.toFixed(1)} deg from its start`,
    );
  }
  check(
    'map: grid labels',
    map2d.gridLabel(30, 'lat') === '30° N' && map2d.gridLabel(-60, 'lat') === '60° S' && map2d.gridLabel(0, 'lat') === '0°' &&
      map2d.gridLabel(-120, 'lon') === '120° W' && map2d.gridLabel(180, 'lon') === '180°' && map2d.gridLabel(390, 'lon') === '30° E',
  );
  check('map: grid every 30 deg at the widest zoom, finer closer in', map2d.gridStep(5.5) === 30 && map2d.gridStep(3.7) === 30 && map2d.gridStep(20) === 10);
}

// ---- time picker (timepick.js) --------------------------------------------------------------
{
  check(
    'time picker: reads 24-hour times typed several ways',
    parseUtcInput('2026-10-22', '15:07:59') === Date.UTC(2026, 9, 22, 15, 7, 59) &&
      parseUtcInput('2026-10-22', '15:07') === Date.UTC(2026, 9, 22, 15, 7) &&
      parseUtcInput('2026-10-22', '1507') === Date.UTC(2026, 9, 22, 15, 7) &&
      parseUtcInput('2026-10-22', '150759') === Date.UTC(2026, 9, 22, 15, 7, 59) &&
      parseUtcInput(' 2026-10-22 ', ' 9:05 ') === Date.UTC(2026, 9, 22, 9, 5),
  );
  check(
    'time picker: rejects impossible dates and times',
    [['2026-02-30', '12:00'], ['2026-10-22', '24:00'], ['2026-10-22', '12:60'], ['22/10/2026', '12:00'], ['2026-10-22', ''], ['', '12:00']]
      .every(([d, t]) => Number.isNaN(parseUtcInput(d, t))),
  );
  const v = utcInputs(Date.UTC(2026, 4, 3, 6, 59, 7, 900));
  check('time picker: fills the fields from a time', v.date === '2026-05-03' && v.time === '06:59:07' && parseUtcInput(v.date, v.time) === Date.UTC(2026, 4, 3, 6, 59, 7));
  const last = orbit.lastEpochMs;
  const day = 86_400_000;
  const launch = elementsNote(astro.LAUNCH_MS + day, orbit);
  const inside = elementsNote(orbit.items[10].epochMs + 3_600_000, orbit);
  const soon = elementsNote(last + 3 * day, orbit);
  const far = elementsNote(last + (FAR_DAYS + 1) * day, orbit);
  const veryFar = elementsNote(last + (VERY_FAR_DAYS + 30) * day, orbit);
  check('time picker: on launch day it says the elements are later and the position approximate', launch.level === 'ok' && /first orbital elements/.test(launch.text) && /approximate/.test(launch.text), launch.text);
  check('time picker: inside the history it gives the elements and their age', inside.level === 'ok' && /\(1 hour old\)/.test(inside.text), inside.text);
  check('time picker: 3 days past the newest elements is a forecast, plainly worded', soon.level === 'ok' && /^Forecast/.test(soon.text) && /3 days old/.test(soon.text), soon.text);
  check(`time picker: more than ${FAR_DAYS} days past them it warns of tens of kilometres`, far.level === 'far' && /tens of kilometres/.test(far.text), far.text);
  check(
    `time picker: more than ${VERY_FAR_DAYS} days past them, hundreds of kilometres and a rough guess`,
    veryFar.level === 'far' && /hundreds of kilometres/.test(veryFar.text) && /rough guess/.test(veryFar.text),
    veryFar.text,
  );
}

// ---- orbit colour (colorwheel.js) --------------------------------------------------------------
{
  const space = '#05070A';
  check('colour: WCAG contrast of white on black is 21', Math.abs(wheel.contrast('#FFFFFF', '#000000') - 21) < 1e-9);
  check('colour: the team blue is clear of the night side', wheel.contrast(wheel.TEAM_BLUE, space) > 6.9, wheel.contrast(wheel.TEAM_BLUE, space).toFixed(2));
  let roundTrip = 0;
  for (const hex of [wheel.TEAM_BLUE, '#F2B33D', '#05070A', '#E6EBF0', '#7F3FBF', '#00FF80']) {
    const back = wheel.rgbToHex(wheel.hslToRgb(...Object.values(wheel.rgbToHsl(wheel.hexToRgb(hex)))));
    const a = wheel.hexToRgb(hex);
    const b = wheel.hexToRgb(back);
    roundTrip = Math.max(roundTrip, Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
  }
  check('colour: hex to HSL and back is exact to the unit', roundTrip <= 1, `${roundTrip} at most`);
  let worst = Infinity;
  let worstHue = 0;
  let lightest = 0;
  for (let h = 0; h < 360; h++) {
    for (const l of [0, wheel.LIGHTNESS.min, 60, wheel.LIGHTNESS.max, 100]) {
      const hex = wheel.readableColour(h, l);
      const c = wheel.contrast(hex, space);
      if (c < worst) [worst, worstHue] = [c, h];
      lightest = Math.max(lightest, wheel.rgbToHsl(wheel.hexToRgb(hex)).l);
    }
  }
  check(
    `colour: every hue at every lightness keeps ${wheel.MIN_CONTRAST}:1 on the night side, never white`,
    worst >= wheel.MIN_CONTRAST && lightest < 96,
    `lowest ${worst.toFixed(2)} at hue ${worstHue}, lightest ${lightest.toFixed(0)}%`,
  );
  check(
    'colour: presets are distinct, usable and start with the team blue',
    wheel.PRESETS[0].hex === wheel.TEAM_BLUE && new Set(wheel.PRESETS.map((p) => p.hex)).size === wheel.PRESETS.length &&
      wheel.PRESETS.every((p) => wheel.usable(p.hex)),
    wheel.PRESETS.map((p) => p.hex).join(' '),
  );
  check(
    'colour: a stored value is only used when it is a clear hex colour',
    wheel.usable('#3c9df5') && !wheel.usable('#101010') && !wheel.usable('red') && !wheel.usable('#3C9DF5; x') && !wheel.usable(null),
  );
  check('colour: hue names', wheel.hueName(208) === 'blue' && wheel.hueName(40) === 'amber' && wheel.hueName(359) === 'red' && wheel.hueName(-10) === 'red');
}

// ---- places and passes over them (explore/journey-region.js, regionpasses.js) -------------------
{
  check('places: country outlines load', region.setCountries(read('../../explore/countries-110m.json')));
  const where = [
    [51.05, -114.07, 'Canada'], [35.7, 139.7, 'Japan'], [-29.3, 28.2, 'Lesotho'], [-26.2, 28.0, 'South Africa'],
    [64.8, -147.7, 'United States'], [65, 178, 'Russia'], [-12.05, -77.05, 'Peru'], [0, -150, 'the North Pacific Ocean'],
    [-30, -150, 'the South Pacific Ocean'], [43, 35, 'the Black Sea'], [-75, 0, 'Antarctica'],
  ];
  const wrong = where.filter(([lat, lon, want]) => region.placeAt(lat, lon) !== want);
  check(
    'places: what is under a point (a hole in a country, both sides of the date line, seas)',
    !wrong.length,
    wrong.map(([lat, lon, want]) => `${lat},${lon}: ${region.placeAt(lat, lon)} not ${want}`).join('; '),
  );
  check('places: regionAt still answers the front page as before', region.regionAt(51.05, -114.07) === 'North America');
  const first = (q) => region.findPlaces(q)[0]?.label;
  const typed = { jpan: 'Japan', austrailia: 'Australia', usa: 'United States', russ: 'Russia', 'cote d ivoire': 'Ivory Coast',
    mediteranean: 'Mediterranean Sea', 'north sea': 'North Sea', 'S. Korea': 'South Korea', peru: 'Peru' };
  const misses = Object.entries(typed).filter(([q, want]) => first(q) !== want);
  check('places: search forgives typos and knows other names', !misses.length,
    misses.map(([q, want]) => `"${q}" gave ${first(q)}, not ${want}`).join('; '));
  check('places: nothing for nonsense, no country codes from partial words', region.findPlaces('qqq').length === 0 &&
    region.findPlaces('u')[0]?.label !== 'United States');
  const jp = region.getPlace(region.findPlaces('Japan')[0].id);
  check('places: a country\'s middle lies inside it', jp.contains(jp.middle[1], jp.middle[0]) &&
    region.getPlace(region.findPlaces('Peru')[0].id).contains(-9.2, -75));
  check('places: a sea from the gazetteer has a middle in it and a box round it', (() => {
    const med = region.getPlace(region.findPlaces('Mediterranean')[0].id);
    const [w, s, e, n] = med.bbox;
    return med.contains(med.middle[1], med.middle[0]) && w < 0 && e > 30 && s >= 29 && n <= 47;
  })());
  check('passes: the box test reaches across the date line', rp.nearBox([170, -20, 180, -15], -17, -179, 2) &&
    !rp.nearBox([170, -20, 180, -15], -17, -150, 2));

  const from = Date.UTC(2026, 9, 26, 12);
  const step = 2000;
  for (const name of ['Japan', 'Peru', 'North Sea']) {
    const place = region.getPlace(region.findPlaces(name)[0].id);
    const passes = rp.findRegionPasses(orbit, place, from);
    const inAt = (ms) => {
      const s = orbit.stateAt(ms);
      return place.contains(s.latDeg, s.lonDeg);
    };
    const edgesOk = passes.every((p) => p.inProgress || (!inAt(p.startMs - step) && inAt(p.startMs + step)));
    const exitsOk = passes.every((p) => inAt(p.endMs - step) && !inAt(p.endMs + step));
    const ordered = passes.every((p, i) => i === 0 || p.startMs > passes[i - 1].endMs);
    const sunOk = passes.every((p) => Math.abs(p.sunElevationDeg - astro.sunElevationDeg(p.latDeg, p.lonDeg, p.closestMs)) < 1e-9);
    // the nearest moment found really is the nearest: nothing in the pass comes closer
    let nearestOk = true;
    for (const p of passes) {
      for (let t = p.startMs; t <= p.endMs; t += 1000) {
        const s = orbit.stateAt(t);
        if (rp.surfaceKm(s.latDeg, s.lonDeg, place.middle[1], place.middle[0]) < p.closestKm - 0.5) nearestOk = false;
      }
    }
    check(
      `passes over ${place.label}: 3 found, entries and exits within 2 s, in order, nearest point and sun right`,
      passes.length === 3 && edgesOk && exitsOk && ordered && sunOk && nearestOk,
      passes.map((p) => `${new Date(p.closestMs).toISOString().slice(5, 16)} ${Math.round(p.durationS)} s ${Math.round(p.closestKm)} km`).join(', '),
    );
  }
  const fake = (km, sun) => ({ closestKm: km, sunElevationDeg: sun });
  const pick = (list) => rp.bestPass(list)?.index;
  check(
    'passes: best is daylight first, then closest to the middle',
    pick([fake(50, -20), fake(300, 10), fake(200, 30)]) === 2 && pick([fake(50, -20), fake(80, -5)]) === 0 &&
      pick([fake(900, 5), fake(20, -40)]) === 0 && rp.bestPass([]) === null,
  );
  check('passes: distances read as people would say them', rp.fmtKm(4) === 'under 10 km' && rp.fmtKm(1238) === '1 240 km');
}

// ---- the picam's geometry ---------------------------------------------------------
{
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const ms = Date.parse('2026-10-22T15:07:52Z');
  const state = orbit.stateAt(ms);
  const nadir = shot.cameraAt(state);
  const centre = shot.groundAtPixel(nadir, 320, 240);
  check(
    'picam: pointing straight down, the picture centre is the point under the satellite',
    surfaceKm(centre.latDeg, centre.lonDeg, state.latDeg, state.lonDeg) < 0.01 && Math.abs(centre.rangeKm - state.altKm) < 0.01,
    `${centre.latDeg.toFixed(4)}, ${centre.lonDeg.toFixed(4)}, ${centre.rangeKm.toFixed(1)} km away`,
  );
  const unit = (a) => Math.abs(dot(a, a) - 1) < 1e-9;
  const handed = dot(
    { x: nadir.right.y * nadir.down.z - nadir.right.z * nadir.down.y, y: nadir.right.z * nadir.down.x - nadir.right.x * nadir.down.z, z: nadir.right.x * nadir.down.y - nadir.right.y * nadir.down.x },
    nadir.bore,
  );
  check(
    'picam: the picture\'s axes are square and right-handed, so the frame is not mirrored',
    unit(nadir.right) && unit(nadir.down) && unit(nadir.bore) && Math.abs(dot(nadir.right, nadir.down)) < 1e-9 && Math.abs(handed - 1) < 1e-9,
  );
  check('picam: the right of the picture is the direction of travel', dot(nadir.right, nadir.forward) > 0.9999999);
  // a little later the satellite has moved toward the right of the picture
  const later = shot.pixelOfGround(nadir, orbit.stateAt(ms + 10_000).latDeg, orbit.stateAt(ms + 10_000).lonDeg);
  check(
    'picam: the point under the satellite 10 s later is to the right of the centre, about 100 px',
    later.u > 320 + 80 && later.u < 320 + 120 && Math.abs(later.v - 240) < 15,
    `${later.u.toFixed(0)}, ${later.v.toFixed(0)}`,
  );
  let roundOk = true;
  for (const [u, v] of [[1, 1], [639, 1], [1, 479], [639, 479], [175, 370]]) {
    const g = shot.groundAtPixel(nadir, u, v);
    const p = shot.pixelOfGround(nadir, g.latDeg, g.lonDeg);
    if (Math.hypot(p.u - u, p.v - v) > 1e-6 || !p.visible) roundOk = false;
  }
  check('picam: ground to pixel and back, at the corners', roundOk);
  const fov = shot.fieldOfView();
  check(
    'picam: the lens agrees with the team\'s 60 degree diagonal and the limb fits (60 to 64)',
    fov.diagonalDeg > 60 && fov.diagonalDeg < 64,
    `${fov.diagonalDeg.toFixed(1)} diagonal, ${fov.widthDeg.toFixed(1)} by ${fov.heightDeg.toFixed(1)}`,
  );
  const cover = shot.footprintKm(nadir);
  check(
    'picam: from 500 km the frame covers about 480 by 360 km, 0.74 km a pixel',
    Math.abs(cover.widthKm - 473) < 15 && Math.abs(cover.heightKm - 354) < 15,
    `${cover.widthKm.toFixed(0)} by ${cover.heightKm.toFixed(0)} km`,
  );
  // tipped forward, the centre looks ahead along the track by altitude x tan(pitch)
  const tipped = shot.groundAtPixel(shot.cameraAt(state, { pitchDeg: 10 }), 320, 240);
  const ahead = surfaceKm(tipped.latDeg, tipped.lonDeg, state.latDeg, state.lonDeg);
  check('picam: pitched 10 degrees, the centre is about 88 km ahead', Math.abs(ahead - state.altKm * Math.tan(10 * astro.DEG)) < 2, `${ahead.toFixed(1)} km`);
  const rolled = shot.cameraAt(state, { rollDeg: 5, yawDeg: 90 });
  check(
    'picam: rolling tips the view right of the track, and yaw turns the picture clockwise',
    dot(rolled.bore, rolled.rightOfTrack) > 0.08 && dot(rolled.down, rolled.forward) < -0.99,
  );
  // the limb frames looked 60 degrees off nadir: the sky is in frame
  const edge = shot.cameraAt(state, { pitchDeg: 60 });
  check('picam: tipped 60 degrees forward, the frame holds both sky and ground, as the August frames do',
    shot.groundAtPixel(edge, 640, 240) === null && shot.groundAtPixel(edge, 0, 240) !== null);

  // the real frames: places read off the pictures come back within the fit's error
  const within = (id, ms2, pointing, ties, limit) => {
    const cam = shot.cameraAt(orbit.stateAt(ms2), pointing);
    const errors = ties.map(([lat, lon, u, v]) => {
      const p = shot.pixelOfGround(cam, lat, lon);
      return Math.hypot(p.u - u, p.v - v);
    });
    const worst = Math.max(...errors);
    check(`picam: ${id} lands within ${limit} px of its real picture`, worst < limit, `worst ${worst.toFixed(1)} px`);
  };
  within('the New Jersey shore, 22 Oct, at its fitted pointing', ms, { pitchDeg: 10.5, rollDeg: -5, yawDeg: 1 }, [
    [38.93, -74.96, 10, 35], [40.46, -74.0, 221, 183], [39.95, -75.16, 186, 30], [40.5, -74.2, 240, 160],
  ], 20);
  within('Singapore at night, 22 Oct, straight down', Date.parse('2026-10-22T15:44:01Z'), shot.NOMINAL_POINTING, [
    [1.416, 103.767, 362, 362], [1.097, 104.017, 412, 315], [0.917, 104.516, 433, 235], [2.066, 103.317, 275, 450], [3.764, 103.315, 40, 460],
  ], 40);

  // the frame is drawn in the inertial scene: the prime meridian at GMST 0 is +x, the pole is +y, and x y z stay right-handed
  const a = shot.toScene({ x: 1, y: 0, z: 0 }, 0);
  const b = shot.toScene({ x: 0, y: 1, z: 0 }, 0);
  const pole = shot.toScene({ x: 0, y: 0, z: 1 }, 1.2);
  const turned = shot.toScene({ x: 1, y: 0, z: 0 }, Math.PI / 2);
  check(
    'picam: Earth-fixed to the scene matches earth.js (x, z, -y), turned by GMST',
    a.x === 1 && a.y === 0 && Math.abs(b.z + 1) < 1e-12 && pole.y === 1 && Math.abs(turned.z + 1) < 1e-12,
  );
}

// ---- pictures without a time ---------------------------------------------------------------
{
  check(
    'pictures: a time, only a date and no date are told apart',
    whenKnown({ capturedAtUTC: '2026-10-24T17:37:32Z', captureDate: '2026-10-24' }) === 'time' &&
      whenKnown({ capturedAtUTC: null, captureDate: '2026-10-24' }) === 'date' && whenKnown({ capturedAtUTC: null, captureDate: null }) === 'none' &&
      whenKnown({ ms: null, capturedAtUTC: 'junk', captureDate: null }) === 'none',
  );
  let list = toPhotos(read('../../data/images.json'), { base: 'http://example.test/' });
  list = applyAnnotations(list, read('../../data/annotations.json'));
  list.sort(comparePhotos);
  const kinds = list.map(whenKnown);
  const n = (k) => kinds.filter((x) => x === k).length;
  check(
    'pictures: the three groups add up to all of them, in order, and the undated are their own',
    n('time') + n('date') + n('none') === list.length && kinds.join() === [...kinds].sort((a, b) => ['time', 'date', 'none'].indexOf(a) - ['time', 'date', 'none'].indexOf(b)).join(),
    `${n('time')} with a time, ${n('date')} with only a date, ${n('none')} with neither, of ${list.length}`,
  );
  const times = list.filter((p) => whenKnown(p) === 'time').map((p) => Date.parse(p.capturedAtUTC));
  const dates = list.filter((p) => whenKnown(p) === 'date').map((p) => p.captureDate);
  check('pictures: newest first within each group', times.every((t, i) => !i || t <= times[i - 1]) && dates.every((d, i) => !i || d <= dates[i - 1]));
}

// ---- labels keeping clear of each other (labels.js) --------------------------------------------
{
  const label = (x, y) => ({ x, y, w: 50, h: 16, gap: 12 });
  const boxAt = (x, y) => labelBox('right', { x, y, w: 70, h: 16, gap: 12 });
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  check('labels: on the right when nothing is near', placeLabel(label(300, 100), [boxAt(100, 100)]) === 'right');
  check('labels: moves aside when another sits on it', placeLabel(label(110, 100), [boxAt(100, 100)]) === 'left');
  check('labels: tries below and above when both sides are taken', placeLabel(label(100, 100), [
    { left: 0, top: 90, right: 200, bottom: 110 },
  ]) === 'below');
  check('labels: hides when nothing is clear, and only comes back well clear', placeLabel(label(100, 100), [
    { left: 0, top: 0, right: 300, bottom: 300 },
  ]) === null);

  // the satellite's label drifts past a fixed one with a pixel of jitter, as rounding gives
  let side = 'right';
  let changes = 0;
  let overlaps = 0;
  for (let i = 0; i <= 600; i++) {
    const x = -100 + i * 0.5 + (i % 2 ? 0.8 : -0.8);
    const avoid = [boxAt(x, 104)];
    const next = placeLabel(label(100, 100), avoid, side);
    if (next !== side) changes++;
    side = next;
    if (side && hits(labelBox(side, label(100, 100)), avoid[0])) overlaps++;
  }
  check('labels: a drifting neighbour never overlaps it and it does not flicker', overlaps === 0 && changes <= 4, `${changes} moves, ${overlaps} overlaps`);
}

// ---- the page's first paint (index.html) ---------------------------------------------------------
{
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const line = html.indexOf('class="orbit-loading"');
  const firstSheet = html.indexOf('<link rel="stylesheet"');
  check(
    'page: the loading line is in the HTML ahead of every stylesheet, none of which can hold it back',
    line > head.length && firstSheet > line && !head.includes('<link rel="stylesheet"'),
  );
  check(
    'page: the globe replaces the line, a failed load changes it, and it stays away without JavaScript',
    html.includes(".orbit-loading')?.remove()") && /<script type="module" onerror=/.test(html) &&
      /<noscript><style>\.orbit-loading \{ display: none; \}/.test(head),
  );
}

// ---- numbers: nobody reads a thousands comma as a decimal ------------------------
{
  check('numbers: a narrow space between the thousands', grouped(27400) === '27 400' && grouped(999) === '999' && grouped(1234567) === '1 234 567');
  check('numbers: a decimal is still a point', grouped(1234.56, 1) === '1 234.6');
  check('numbers: bytes and counts read the same', bytes(50462) === '49.3 KB (50 462 bytes)' && plural(1200, 'packet') === '1 200 packets' && plural(1, 'packet') === '1 packet');
  const facts = readFileSync(fileURLToPath(new URL('../../explore/facts.json', import.meta.url)), 'utf8');
  check('numbers: no thousands comma left in the facts', !/\d,\d{3}\b/.test(facts));
}

// ---- dates: month, day, year -------------------------------------------------------
{
  const ms = Date.UTC(2026, 9, 22, 15, 7, 59);
  check('dates: the catalogue writes month, day, year', monthDayYear(new Date(ms)) === 'Oct 22, 2026' && utcLong(new Date(ms)) === 'Oct 22, 2026, 15:07:59 UTC');
  check('dates: Calgary\'s clock too', calgary(new Date(ms)) === 'Oct 22, 2026, 09:07:59 MDT');
  check('dates: Explore too', exploreLong(ms) === 'Oct 22, 2026, 15:07 UTC' && exploreShort(ms) === 'Oct 22, 15:07 UTC' && launchDate === 'May 3, 2026');
  const evening = Date.UTC(2026, 9, 23, 2, 0);
  check('dates: Explore\'s other day for Calgary', calgaryTime(evening).date === 'Oct 22' && calgaryTime(evening).otherDay);
  check('dates: the time picker too', calgaryWhen(ms) === 'Thursday, October 22, 2026, 09:07:59 MDT', calgaryWhen(ms));
  const facts = readFileSync(fileURLToPath(new URL('../../explore/facts.json', import.meta.url)), 'utf8');
  check('dates: none day first in the facts', !/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/.test(facts));
}

// ---- aurora -----------------------------------------------------------------------
{
  const cells = [[10, 65, 50], [359, -90, 100], [0, 0, 0]];
  for (let i = 0; cells.length < 1000; i++) cells.push([i % 360, 10, 0]);
  const parsed = parseForecast({ 'Observation Time': '2026-10-31T17:29:00Z', 'Forecast Time': '2026-10-31T18:23:00Z', coordinates: cells });
  check('aurora: a cell lands by its latitude and longitude', Math.abs(parsed.grid[(65 + 90) * 360 + 10] - 127.5) < 1 && parsed.grid[359] === 255 && parsed.grid[90 * 360] === 0);
  check('aurora: the times and the peak are read', parsed.forecastMs === Date.UTC(2026, 9, 31, 18, 23) && parsed.observedMs === Date.UTC(2026, 9, 31, 17, 29) && parsed.peak === 100);
  let refused = 0;
  for (const junk of [null, {}, { coordinates: [] }, { 'Forecast Time': 'soon', coordinates: cells }]) {
    try {
      parseForecast(junk);
    } catch {
      refused += 1;
    }
  }
  check('aurora: anything else is refused', refused === 4);

  const t = parsed.forecastMs;
  const deg = (a) => (Math.atan2(Math.sin(a), Math.cos(a)) * 180) / Math.PI;
  check('aurora: at the forecast\'s own time the map is not turned', turnSince(t, t) === 0);
  const six = deg(turnSince(t + 6 * 3_600_000, t));
  check('aurora: six hours later it has turned about 90 degrees, the way the Sun went', Math.abs(six - 90) < 15, `${six.toFixed(1)}`);
  const day = deg(turnSince(t + 24 * 3_600_000, t));
  check('aurora: a day later it is back where it was', Math.abs(day) < 3, `${day.toFixed(1)}`);

  const ok = { state: 'ok', forecastMs: t };
  check('aurora: the note says the forecast\'s time and that the shimmer is for show', /18:23 UTC/.test(auroraNote(ok, t)) && /shimmer/.test(auroraNote(ok, t)));
  check('aurora: far from the forecast the note says why there is none', /isn.t shown/.test(auroraNote(ok, t + 7 * 3_600_000)));
  check('aurora: a failed load says so, and loading says nothing', /couldn.t be loaded/.test(auroraNote({ state: 'failed' }, t)) && auroraNote({ state: 'loading' }, t) === null);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
