#!/usr/bin/env python3
"""Fit the main camera's lens and pointing to its real pictures.

    python scripts/fit_picam.py

Prints the numbers behind docs/picam-calibration.md and site/globe/shotcamera.js.
A one-off, so it needs numpy, scipy and pillow (the last two aren't in
requirements.txt) and node on the path, which gives it the satellite's
velocity from the page's own site/globe/astro.js.

Two independent fits:
- the limb: from orbit it is a small circle on the sky, so the three frames
  with a horizon give the focal length and how far off nadir they looked;
- ground tie points: places read off the frames by eye against the NASA maps
  give each frame's rotation. The tie points are below, so they can be checked.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
D = np.pi / 180
RE = 6371.0
FOCAL = 680.0  # what shotcamera.js uses

# (latitude, longitude, x in the frame, y in the frame)
TIES = {
    "2026-10-22-150759z": [  # the New Jersey shore: the only clear daylight coast with a known time
        (38.93, -74.96, 10, 35),  # Cape May
        (40.46, -74.00, 221, 183),  # Sandy Hook
        (39.95, -75.16, 186, 30),  # Philadelphia
        (40.50, -74.20, 240, 160),  # Raritan Bay
    ],
    "2026-10-22-154408z": [  # Singapore and Johor at night
        (1.416, 103.767, 362, 362),  # Singapore
        (1.097, 104.017, 412, 315),  # Batam
        (0.917, 104.516, 433, 235),  # Bintan
        (2.066, 103.317, 275, 450),  # Kluang
        (2.436, 103.846, 195, 375),  # Mersing
        (3.764, 103.315, 40, 460),  # Kuantan
    ],
}
# frame, which side the sky is on
LIMBS = {"2026-08-06": "left", "2026-08-26": "right", "2026-08-28": "right"}

NODE = """
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const site = process.argv[1];
const astro = await import(pathToFileURL(site + '/globe/astro.js').href);
const tles = JSON.parse(readFileSync(site + '/data/tle.json', 'utf8'));
const orbit = new astro.Orbit(Array.isArray(tles) ? tles : tles.tles);
const out = {};
for (const it of JSON.parse(readFileSync(site + '/data/images.json', 'utf8')).images) {
  if (!it.captured_at) continue;
  const s = orbit.stateAt(Date.parse(it.captured_at));
  out[it.id] = { lat: s.latDeg, lon: s.lonDeg, alt: s.altKm, vel: s.velocity, gmst: s.gmst };
}
console.log(JSON.stringify(out));
"""


def states() -> dict:
    run = subprocess.run(["node", "--input-type=module", "-e", NODE, str(SITE)], capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


def up(lat: float, lon: float) -> np.ndarray:
    return np.array([np.cos(lat * D) * np.cos(lon * D), np.cos(lat * D) * np.sin(lon * D), np.sin(lat * D)])


def frame_axes(st: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Along the track, right of it and nadir, Earth-fixed."""
    z = -up(st["lat"], st["lon"])
    c, s = np.cos(st["gmst"]), np.sin(st["gmst"])
    v = np.array([c * st["vel"]["x"] + s * st["vel"]["y"], -s * st["vel"]["x"] + c * st["vel"]["y"], st["vel"]["z"]])
    x = v - (v @ z) * z
    x /= np.linalg.norm(x)
    return x, np.cross(z, x), z


def fit_limb(name: str, sky: str, atmosphere_km: float = 25.0, alt_km: float = 500.0) -> tuple[float, float, float]:
    """(focal length, degrees off nadir, rms pixels) for a frame with a horizon."""
    grey = np.asarray(Image.open(SITE / "images" / f"{name}.jpg").convert("L")).astype(float)
    pts = []
    for y in range(8, 470, 4):
        row = np.convolve(grey[y], np.ones(3) / 3, "same")
        step = row[:-6] - row[6:] if sky == "right" else row[6:] - row[:-6]
        hits = np.where(step > 40)[0]
        if len(hits):
            x = (hits.max() if sky == "right" else hits.min()) + 3
            if 4 < x < 635:
                pts.append((x, y))
    p = np.array(pts, float)
    rho = np.arcsin((RE + atmosphere_km) / (RE + alt_km))

    def res(q: np.ndarray) -> np.ndarray:
        f, az, el = q
        n = np.array([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)])
        d = np.c_[(p[:, 0] - 320) / f, (p[:, 1] - 240) / f, np.ones(len(p))]
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        return (np.arccos(np.clip(d @ n, -1, 1)) - rho) * f

    best = None
    for az in np.radians(np.arange(0, 360, 30)):
        for el in np.radians([20, 40, 60]):
            r = least_squares(res, [FOCAL, az, el], bounds=([450, -10, -2], [1000, 10, 2]), loss="soft_l1", f_scale=2.0)
            if best is None or r.cost < best.cost:
                best = r
    f, az, el = best.x
    return f, 90 - el / D, float(np.sqrt(np.mean(res(best.x) ** 2)))


def fit_ties(st: dict, ties: list, focal: float | None) -> tuple[np.ndarray, float, float]:
    """Camera axes (columns right, down, boresight), focal length, rms pixels."""
    P = up(st["lat"], st["lon"]) * (RE + st["alt"]) / RE

    def res(q: np.ndarray) -> np.ndarray:
        M = Rotation.from_rotvec(q[:3]).as_matrix()
        f = focal if focal else q[3] * 1000
        out = []
        for lat, lon, u, v in ties:
            c = M.T @ (up(lat, lon) - P)
            out += [320 + f * c[0] / c[2] - u, 240 + f * c[1] / c[2] - v]
        return np.array(out)

    mean = np.mean([up(a, b) for a, b, _, _ in ties], axis=0)
    bore = mean / np.linalg.norm(mean) - P
    bore /= np.linalg.norm(bore)
    ref = np.cross(bore, [0.3, 0.5, 0.8])
    ref /= np.linalg.norm(ref)
    side = np.cross(bore, ref)
    best = None
    for roll in np.radians(np.arange(0, 360, 30)):
        image_up = np.cos(roll) * ref + np.sin(roll) * side
        M0 = np.stack([np.cross(bore, image_up), -image_up, bore], axis=-1)
        q0 = list(Rotation.from_matrix(M0).as_rotvec()) + ([] if focal else [FOCAL / 1000])
        r = least_squares(res, q0)
        # a negative focal length is the same picture turned over: not a camera
        if (focal or r.x[3] > 0) and (best is None or r.cost < best.cost):
            best = r
    M = Rotation.from_rotvec(best.x[:3]).as_matrix()
    e = res(best.x).reshape(-1, 2)
    return M, (focal or best.x[3] * 1000), float(np.sqrt((e**2).sum(axis=1).mean()))


def pointing(st: dict, M: np.ndarray) -> dict:
    """The pose in shotcamera.js's terms: pitch, roll and yaw off straight down."""
    x, y, z = frame_axes(st)
    right, bore = M[:, 0], M[:, 2]
    along = x - (x @ bore) * bore
    along /= np.linalg.norm(along)
    across = np.cross(bore, along)
    return {
        "pitch": np.degrees(np.arctan2(bore @ x, bore @ z)),
        "roll": np.degrees(np.arctan2(bore @ y, bore @ z)),
        "yaw": np.degrees(np.arctan2(right @ across, right @ along)),
        "off_nadir": np.degrees(np.arccos(np.clip(bore @ z, -1, 1))),
    }


def main() -> None:
    print("limb (assuming 500 km up and an edge 25 km above the ground)")
    limb = []
    for name, sky in LIMBS.items():
        f, off, rms = fit_limb(name, sky)
        limb.append(f)
        print(f"  {name}: focal {f:.0f} px, {2 * np.degrees(np.arctan(400 / f)):.1f} deg diagonal, {off:.0f} deg off nadir, rms {rms:.2f} px")
    st = states()
    print("ground tie points")
    for name, ties in TIES.items():
        M_free, f_free, rms_free = fit_ties(st[name], ties, None)
        M, _, rms = fit_ties(st[name], ties, FOCAL)
        p = pointing(st[name], M)
        print(f"  {name}: free focal {f_free:.0f} px (rms {rms_free:.1f} px); at {FOCAL:.0f} px, rms {rms:.1f} px: "
              f"pitch {p['pitch']:+.1f}, roll {p['roll']:+.1f}, yaw {p['yaw']:+.1f}, {p['off_nadir']:.1f} deg off nadir")
        _, _, flipped = fit_ties(st[name], [(a, b, 640 - u, v) for a, b, u, v in ties], FOCAL)
        print(f"    the same tie points on a mirrored frame: rms {flipped:.1f} px")


if __name__ == "__main__":
    main()
