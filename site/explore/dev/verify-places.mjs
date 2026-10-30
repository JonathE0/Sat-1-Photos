// Checks for what's under a point and for place search (journey-region.js).
//   node site/explore/dev/verify-places.mjs
import { readFileSync } from 'node:fs';
import { Orbit } from '../../globe/astro.js';
import { findRegionPasses } from '../../globe/regionpasses.js';
import * as region from '../journey-region.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
}
const table = (name, list, got) => {
  const wrong = list.filter(([...a]) => got(...a.slice(0, -1)) !== a[a.length - 1]);
  check(name, !wrong.length, wrong.map((a) => `${a.slice(0, -1).join(',')}: ${got(...a.slice(0, -1))}, not ${a[a.length - 1]}`).join('; '));
};

// before the outlines load, placeAt is the coarse name, so callers can show something
check('before the outlines load: the coarse name', region.placeAt(35.4, 133.5) === region.regionAt(35.4, 133.5));
check('outlines load', region.setCountries(read('../countries-110m.json')));

// ---- #14: the same name as the Orbit page, and coasts the coarse outlines miss -------------
table('coasts and islands the outlines cut close', [
  [33.65, 130.13, 'Japan'], [35.4, 133.5, 'Japan'], [12.3, -1.5, 'Burkina Faso'], [51.05, -114.07, 'Canada'],
  [-33.87, 151.21, 'Australia'], [64.15, -21.94, 'Iceland'], [-41.29, 174.78, 'New Zealand'], [18.2, -66.5, 'Puerto Rico'],
], region.placeAt);
table('real water off a coast stays water', [
  [40.37, -72.91, 'the North Atlantic Ocean'], [42.5, -70, 'the North Atlantic Ocean'], [43, 35, 'the Black Sea'],
  [26, -90, 'the Gulf of Mexico'], [56, 3, 'the North Sea'], [0, -150, 'the North Pacific Ocean'], [31.18, -126.1, 'the North Pacific Ocean'],
  [-46.81, 72, 'the Indian Ocean'], [21.7, 115.96, 'the South China Sea'], [14.11, 110, 'the South China Sea'],
], region.placeAt);
table('small places the outlines leave out', [
  [1.35, 103.82, 'Singapore'], [35.9, 14.4, 'Malta'], [32.3, -64.8, 'Bermuda'], [22.3, 114.17, 'Hong Kong'],
], region.placeAt);
table('and their neighbours are still their neighbours', [
  [1.9, 103.6, 'Malaysia'], [23.2, 113.3, 'China'], [41.9, 12.6, 'Italy'],
], region.placeAt);
check('Hawaii is in the United States', region.placeAt(19.6, -155.5) === 'United States');
check('regionAt is unchanged', region.regionAt(51.05, -114.07) === 'North America');
table('names read properly in a sentence', [
  ['United States', 'the United States'], ['The Gambia', 'the Gambia'], ['Canada', 'Canada'], ['the North Sea', 'the North Sea'],
], region.placeInSentence);

// ---- pictures: agrees with the place names the pipeline got from OpenStreetMap -----------------
{
  const { images } = read('../../data/images.json');
  const named = images.filter((i) => i.position?.place && Number.isFinite(i.position.lat));
  const disagree = [];
  const water = /Ocean|Sea|Gulf|Bay/;
  for (const i of named) {
    const here = String(region.placeAt(i.position.lat, i.position.lon));
    const there = i.position.place;
    // on land the country must match; at sea OpenStreetMap is coarser ("North Pacific
    // Ocean" for the South China Sea), so it only has to be water on both sides
    const same = water.test(there) ? water.test(here) : there.toLowerCase().includes(here.toLowerCase());
    if (!same) disagree.push(`${there}: ${here}`);
  }
  check(`picture places agree with OpenStreetMap (${named.length - disagree.length} of ${named.length})`, !disagree.length, disagree.join('; '));
}

// ---- #13: search --------------------------------------------------------------------------------
const first = (q) => region.findPlaces(q)[0]?.label;
table('search finds them', [
  ['Alberta', 'Alberta'], ['alberta', 'Alberta'], ['Albert', 'Alberta'], ['Singapore', 'Singapore'], ['Malta', 'Malta'], ['Bermuda', 'Bermuda'],
  ['Hong Kong', 'Hong Kong'], ['hongkong', 'Hong Kong'], ['British Columbia', 'British Columbia'], ['Ontario', 'Ontario'],
  ['Texas', 'Texas'], ['Algeria', 'Algeria'], ['alg', 'Algeria'],
], first);
table('typos are still forgiven', [
  ['jpan', 'Japan'], ['austrailia', 'Australia'], ['mediteranean', 'Mediterranean Sea'], ['albrta', 'Alberta'], ['singapor', 'Singapore'],
  ['germny', 'Germany'], ['argentia', 'Argentina'],
], first);
check('"Alberta" doesn\'t bring up Algeria at all', !region.findPlaces('Alberta').some((p) => p.label === 'Algeria'));
const avoids = (q, not) => !region.findPlaces(q).some((p) => p.label === not);
check('short names don\'t drag in others', avoids('Malta', 'Alberta') && avoids('Oman', 'Manitoba') && avoids('Mont', 'Ontario'));
check('nothing for nonsense', region.findPlaces('qqq').length === 0 && region.findPlaces('xyzzy').length === 0);
check('codes only when typed in full', first('AB') === 'Alberta' && first('a')?.length > 0);

const whole = (name) => region.getPlace(region.findPlaces(name)[0].id);
for (const [name, inside, outside] of [
  ['Alberta', [[51.05, -114.07], [53.55, -113.5], [56.7, -111.4], [49.7, -112.8]], [[49.28, -123.12], [50.45, -104.6], [47.66, -117.42], [61, -115]]],
  ['British Columbia', [[49.28, -123.12], [53.9, -122.75], [58.8, -122.7]], [[51.05, -114.07], [47.6, -122.33]]],
  ['Saskatchewan', [[50.45, -104.6], [52.13, -106.67]], [[51.05, -114.07], [49.9, -97.14]]],
  ['Manitoba', [[49.9, -97.14], [58.77, -94.17]], [[50.45, -104.6], [48.38, -89.25]]],
  ['Ontario', [[43.65, -79.38], [45.42, -75.7], [48.38, -89.25]], [[45.5, -73.57], [49.9, -97.14], [40.71, -74]]],
  ['Quebec', [[45.5, -73.57], [46.81, -71.21], [53.8, -76]], [[43.65, -79.38], [47.56, -52.71]]],
  ['Nova Scotia', [[44.65, -63.58]], [[45.96, -66.64]]],
  ['New Brunswick', [[45.96, -66.64]], [[44.65, -63.58]]],
  ['Newfoundland and Labrador', [[47.56, -52.71], [53.3, -60.4]], [[44.65, -63.58]]],
  ['Yukon', [[60.72, -135.05]], [[62.45, -114.37]]],
  ['Northwest Territories', [[62.45, -114.37]], [[63.75, -68.52], [60.72, -135.05]]],
  ['Nunavut', [[63.75, -68.52], [69.1, -105.05]], [[62.45, -114.37]]],
  ['Alaska', [[61.22, -149.9], [64.84, -147.72]], [[60.72, -135.05]]],
  ['California', [[34.05, -118.24], [37.77, -122.42]], [[36.17, -115.14], [45.5, -122.67]]],
  ['Texas', [[29.76, -95.37], [32.78, -96.8], [31.76, -106.45]], [[35.47, -97.52], [29.95, -90.07]]],
  ['Florida', [[25.76, -80.19], [28.54, -81.38], [30.44, -84.28]], [[33.75, -84.39]]],
  ['New York', [[40.71, -74], [42.65, -73.75], [42.89, -78.88]], [[39.95, -75.16], [45.5, -73.57]]],
  ['Singapore', [[1.35, 103.82]], [[3.14, 101.69]]],
  ['Bermuda', [[32.3, -64.78]], [[25.76, -80.19]]],
]) {
  const p = whole(name);
  const wrong = [...inside.filter(([a, b]) => !p.contains(a, b)).map((x) => `${x} should be in`), ...outside.filter(([a, b]) => p.contains(a, b)).map((x) => `${x} should be out`)];
  const [w, s, e, n] = p.bbox;
  const boxed = w < e && s < n && p.middle[0] >= w && p.middle[0] <= e && p.middle[1] >= s && p.middle[1] <= n;
  check(`${name}: where it is and isn't`, !wrong.length && boxed && p.contains(p.middle[1], p.middle[0]), wrong.join('; '));
}

// the Orbit page's "passes over" search works on the new places too
{
  const orbit = new Orbit(read('../../data/tle.json'));
  const from = Date.UTC(2026, 9, 26, 12);
  for (const name of ['Alberta', 'Nunavut', 'Texas', 'Singapore', 'Malta', 'Bermuda', 'Hong Kong']) {
    const p = whole(name);
    const passes = findRegionPasses(orbit, p, from);
    const inside = passes.every((x) => {
      const s = orbit.stateAt(x.startMs + 2000);
      return p.contains(s.latDeg, s.lonDeg);
    });
    check(`passes over ${name}: found, and it is inside the place as each begins`, passes.length > 0 && inside, `${passes.length} in the search window`);
  }
}

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`);
process.exit(failed ? 1 : 0);
