// A team member who corrects a picture's time or place leaves the computed
// height and light behind: they belong to the old time and point. Here they are
// worked out again from the orbit, as the Orbit page does, so the catalogue and
// the viewfinder can show them too: for the member's point if they gave one, else
// for the point under the satellite at the corrected time. Only runs if such a
// picture exists; one it can't work out stays as it was.

import { toDate } from './format.js';

const SITE = new URL('../', import.meta.url);

function needsWorkingOut(p) {
  const now = toDate(p.capturedAt);
  if (!now || p.positionRecomputed) return false;
  return Boolean(p.edited.position)
    || Boolean(p.edited.captured_at && now.getTime() !== toDate(p.raw.captured_at)?.getTime());
}

// Fills in the pictures in place. Resolves to true if any changed.
export async function workOutCorrected(photos) {
  const list = photos.filter(needsWorkingOut);
  if (!list.length) return false;
  const [{ Orbit, satelliteLight, sunElevationDeg, sunPosition }, res] = await Promise.all([
    import('../globe/astro.js'),
    fetch(new URL('data/tle.json', SITE).href, { cache: 'no-cache' }),
  ]);
  if (!res.ok) throw new Error(`${res.status} for data/tle.json`);
  const orbit = new Orbit(await res.json());
  let changed = false;
  for (const p of list) {
    const ms = toDate(p.capturedAt).getTime();
    const state = orbit.stateAt(ms);
    if (!state) continue;
    const lat = p.edited.position ? p.position.lat : state.latDeg;
    const lon = p.edited.position ? p.position.lon : state.lonDeg;
    const elevation = sunElevationDeg(lat, lon, ms);
    p.position = {
      lat,
      lon,
      alt_km: state.altKm,
      sun_elevation_deg: elevation,
      ground_sunlit: elevation > 0,
      satellite_light: satelliteLight(state.eci, sunPosition(ms)),
    };
    p.computedPlace = null; // named for the old point
    p.positionRecomputed = true;
    changed = true;
  }
  return changed;
}
