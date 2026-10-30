// Country outlines for the place search and the "over now" line, from
// Natural Earth's 1:110m Admin 0 Countries (public domain):
//
//   node scripts/make_countries.mjs <ne_110m_admin_0_countries.geojson> [site/explore/countries-110m.json]
//
// The GeoJSON comes from https://github.com/nvkelso/natural-earth-vector
// (geojson/ne_110m_admin_0_countries.geojson). This keeps each country's
// names, Natural Earth's label point (used as its middle), a bounding box
// and its rings as flat [lon, lat, lon, lat, ...] arrays at 0.01 degrees.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output = 'site/explore/countries-110m.json'] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/make_countries.mjs <ne_110m_admin_0_countries.geojson> [out.json]');
  process.exit(2);
}

const round = (v) => Math.round(v * 100) / 100;
const usable = (v) => typeof v === 'string' && v.trim() && v !== '-99' && v !== '-1';

const geo = JSON.parse(readFileSync(input, 'utf8'));
const countries = [];
for (const f of geo.features) {
  const p = f.properties;
  // the plainer of the English and long names: "Russia", "United States", "Laos"
  const plain = [p.NAME_EN, p.NAME_LONG].filter(usable).sort((a, b) => a.length - b.length)[0];
  const name = plain || [p.NAME, p.ADMIN].find(usable);
  if (!name || !f.geometry) continue;
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const flat = [];
      for (const [lon, lat] of ring) {
        const x = round(lon);
        const y = round(lat);
        if (flat.length && flat[flat.length - 2] === x && flat[flat.length - 1] === y) continue;
        flat.push(x, y);
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
      if (flat.length >= 6) rings.push(flat);
    }
  }
  const also = new Set(
    [p.NAME, p.ADMIN, p.NAME_EN, p.FORMAL_EN, p.NAME_SORT, p.ABBREV, p.ISO_A3_EH, p.ADM0_A3, p.ISO_A2_EH, p.GEOUNIT, p.SOVEREIGNT]
      .filter(usable)
      .map((v) => v.trim())
      .filter((v) => v !== name),
  );
  countries.push({
    name,
    also: [...also],
    middle: [round(p.LABEL_X), round(p.LABEL_Y)],
    bbox: [w, s, e, n],
    rings,
  });
}
countries.sort((a, b) => a.name.localeCompare(b.name));

const out = {
  source: 'Natural Earth 1:110m Admin 0 Countries (naturalearthdata.com), public domain',
  countries,
};
writeFileSync(output, `${JSON.stringify(out)}\n`);
const points = countries.reduce((sum, c) => sum + c.rings.reduce((t, r) => t + r.length / 2, 0), 0);
console.log(`${countries.length} countries, ${points} points -> ${output}`);
