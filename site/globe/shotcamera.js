/**
 * Where CTS-SAT-1's main camera (the picam) looks: the geometry behind the
 * "Preview picture" frames, fitted to its real pictures. The numbers and how
 * they were found are in docs/picam-calibration.md.
 *
 * Nothing here touches the DOM or three.js, so fixtures/verify.mjs checks it
 * under Node. The frame is the globe's: a sphere of mean Earth radius, with
 * the ground maps' latitudes and longitudes on it, so the camera stands above
 * the geodetic point SGP4 gives and the picture's centre lands on that point
 * of the map. Vectors are Earth-fixed unless a name says otherwise, in Earth
 * radii, with x through the prime meridian and z through the north pole.
 */
import { DEG, EARTH_RADIUS_KM, eciToEcef, upVector } from './astro.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const unit = (a) => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

/** The lens and sensor: focal length fitted to coastlines, city lights and the limb. */
export const PICAM = Object.freeze({
  width: 640,
  height: 480,
  focalPx: 680,
});

/** Field of view across the frame's diagonal, width and height, degrees. */
export const fieldOfView = (cam = PICAM) => ({
  diagonalDeg: (2 * Math.atan(Math.hypot(cam.width, cam.height) / 2 / cam.focalPx)) / DEG,
  widthDeg: (2 * Math.atan(cam.width / 2 / cam.focalPx)) / DEG,
  heightDeg: (2 * Math.atan(cam.height / 2 / cam.focalPx)) / DEG,
});

/**
 * How the camera sits relative to the satellite's path. Straight down, with
 * the right of the picture along the direction of travel. `pitchDeg` tips the
 * view forward along the track and `rollDeg` to the right of it; `yawDeg`
 * turns the picture clockwise as it is looked at. The real frames scatter
 * around this by up to POINTING_SPREAD_DEG.
 */
export const NOMINAL_POINTING = Object.freeze({ pitchDeg: 0, rollDeg: 0, yawDeg: 0 });

/** How far the October frames sat from NOMINAL_POINTING, which the panel says. */
export const POINTING_SPREAD_DEG = 12;
/** How far off straight down the August frames with a horizon were. */
export const POINTING_WORST_DEG = 62;

/**
 * The camera for a state from astro.Orbit.stateAt. `right`, `down` and `bore`
 * are the picture's axes, unit vectors; `position` is in Earth radii.
 */
export function cameraAt(state, pointing = NOMINAL_POINTING, cam = PICAM) {
  const { pitchDeg = 0, rollDeg = 0, yawDeg = 0 } = pointing;
  const up = upVector(state.latDeg, state.lonDeg);
  const position = scale(up, 1 + state.altKm / EARTH_RADIUS_KM);
  const nadir = scale(up, -1);
  // the direction of travel, in the plane of the local horizon
  const v = eciToEcef(state.velocity, state.gmst);
  const forward = unit(add(v, scale(nadir, -dot(v, nadir))));
  const rightOfTrack = cross(nadir, forward);
  const bore = unit(add(add(nadir, scale(forward, Math.tan(pitchDeg * DEG))), scale(rightOfTrack, Math.tan(rollDeg * DEG))));
  const along = unit(add(forward, scale(bore, -dot(forward, bore))));
  const across = cross(bore, along);
  const c = Math.cos(yawDeg * DEG);
  const s = Math.sin(yawDeg * DEG);
  return {
    position,
    right: add(scale(along, c), scale(across, s)),
    down: add(scale(along, -s), scale(across, c)),
    bore,
    forward,
    rightOfTrack,
    nadir,
    cam,
  };
}

/** The ground point a pixel sees: { latDeg, lonDeg, rangeKm }, or null for sky. */
export function groundAtPixel(camera, u, v) {
  const { position: p, right, down, bore, cam } = camera;
  const x = (u - cam.width / 2) / cam.focalPx;
  const y = (v - cam.height / 2) / cam.focalPx;
  const d = unit(add(add(scale(right, x), scale(down, y)), bore));
  const b = dot(p, d);
  const disc = b * b - (dot(p, p) - 1);
  if (disc < 0 || b > 0) return null;
  const t = -b - Math.sqrt(disc);
  const g = add(p, scale(d, t));
  return { latDeg: Math.asin(g.z) / DEG, lonDeg: Math.atan2(g.y, g.x) / DEG, rangeKm: t * EARTH_RADIUS_KM };
}

/** The pixel that sees a ground point: { u, v, visible }, or null behind the camera. */
export function pixelOfGround(camera, latDeg, lonDeg) {
  const { position: p, right, down, bore, cam } = camera;
  const g = upVector(latDeg, lonDeg);
  const d = add(g, scale(p, -1));
  const z = dot(d, bore);
  if (z <= 0) return null;
  const u = cam.width / 2 + (cam.focalPx * dot(d, right)) / z;
  const v = cam.height / 2 + (cam.focalPx * dot(d, down)) / z;
  // the far side of the Earth is hidden by the near side
  const facing = dot(g, d) < 0;
  return { u, v, visible: facing && u >= 0 && u <= cam.width && v >= 0 && v <= cam.height };
}

/**
 * How much ground the frame covers near its centre: { widthKm, heightKm },
 * measured along the picture's axes through the centre. Null when the frame
 * runs off the Earth.
 */
export function footprintKm(camera) {
  const { cam } = camera;
  const span = (u0, v0, u1, v1) => {
    const a = groundAtPixel(camera, u0, v0);
    const b = groundAtPixel(camera, u1, v1);
    if (!a || !b) return null;
    const ua = upVector(a.latDeg, a.lonDeg);
    const ub = upVector(b.latDeg, b.lonDeg);
    return Math.acos(Math.min(1, dot(ua, ub))) * EARTH_RADIUS_KM;
  };
  const widthKm = span(0, cam.height / 2, cam.width, cam.height / 2);
  const heightKm = span(cam.width / 2, 0, cam.width / 2, cam.height);
  return widthKm === null || heightKm === null ? null : { widthKm, heightKm };
}

/** An Earth-fixed vector as three.js draws it in the inertial scene (see earth.js). */
export function toScene(v, gmstAngle) {
  const c = Math.cos(gmstAngle);
  const s = Math.sin(gmstAngle);
  return { x: c * v.x - s * v.y, y: v.z, z: -(s * v.x + c * v.y) };
}

/**
 * The satellite's own boom in the frame: it shows in nearly every sunlit
 * picture, running in from the left edge. Pixel outline traced from the frames
 * of 27 Aug, 6 Oct and 24 Oct, where it is a thin dark line over the ground.
 */
export const BOOM_OUTLINE = Object.freeze([
  [0, 366], [60, 366], [120, 365], [174, 365], [174, 367], [120, 369], [60, 372], [0, 376],
]);
