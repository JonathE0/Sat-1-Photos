"""Reference values for verify.mjs, computed independently with Python sgp4.

    .venv/Scripts/python site/globe/fixtures/make_reference.py [--fill-sample]

Writes sgp4_reference.json next to this file: sub-satellite points at two
TLE epochs (and a few hours after them), at each sample photo's capture
time, and a 24-hour brute-force (1 s) pass list over Calgary. With
--fill-sample it also fills the `position` blocks of images.sample.json the
way the gallery build does, so the sample data is realistic.

Conventions match the globe: SGP4 (WGS-72) in TEME, rotated to Earth-fixed
by IAU-82 GMST, then WGS-84 geodetic coordinates; the TLE used at a time is
the latest one with an epoch at or before it (else the first).
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sgp4.api import WGS72, Satrec, jday

HERE = Path(__file__).resolve().parent
SITE = HERE.parent.parent
TLE_JSON = SITE / "data" / "tle.json"
SAMPLE = HERE / "images.sample.json"
OUT = HERE / "sgp4_reference.json"

CALGARY = (51.0777, -114.13, 1.1)  # lat, lon (deg), height (km)
PASS_MASK_DEG = 10.0
LIMB_BAND_DEG = 1.5  # the terminator band of cts1_gallery/orbit.py and astro.js
WGS84_A = 6378.137
WGS84_B = 6356.7523142
WGS84_E2 = 1 - (WGS84_B / WGS84_A) ** 2
DEG = math.pi / 180


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def julian(t: datetime) -> tuple[float, float]:
    return jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)


def gmst(jd: float, fr: float) -> float:
    """IAU-82 Greenwich mean sidereal time (Vallado), radians."""
    tut1 = (jd + fr - 2451545.0) / 36525.0
    sec = -6.2e-6 * tut1**3 + 0.093104 * tut1**2 + (876600.0 * 3600 + 8640184.812866) * tut1 + 67310.54841
    return math.radians((sec / 240.0) % 360.0)


def teme_to_ecef(r, theta):
    c, s = math.cos(theta), math.sin(theta)
    return (c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2])


def ecef_to_geodetic(x, y, z):
    """WGS-84 latitude/longitude (deg) and height (km), Bowring iteration."""
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - WGS84_E2))
    for _ in range(10):
        n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - WGS84_E2 * n / (n + h)))
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    h = p / math.cos(lat) - n
    return math.degrees(lat), math.degrees(lon), h


def geodetic_to_ecef(lat_deg, lon_deg, h_km):
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    return (
        (n + h_km) * math.cos(lat) * math.cos(lon),
        (n + h_km) * math.cos(lat) * math.sin(lon),
        (n * (1 - WGS84_E2) + h_km) * math.sin(lat),
    )


def sun_eci(t: datetime):
    """Unit vector and distance (km): Astronomical Almanac low-precision Sun."""
    jd, fr = julian(t)
    n = jd + fr - 2451545.0
    L = math.radians(280.46 + 0.9856474 * n)
    g = math.radians(357.528 + 0.9856003 * n)
    lam = L + math.radians(1.915 * math.sin(g) + 0.02 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    au = 1.00014 - 0.01671 * math.cos(g) - 0.00014 * math.cos(2 * g)
    return (math.cos(lam), math.cos(eps) * math.sin(lam), math.sin(eps) * math.sin(lam)), au * 149597870.7


class History:
    def __init__(self, entries):
        self.epochs = [parse_iso(e["epoch"]) for e in entries]
        self.sats = [Satrec.twoline2rv(e["line1"], e["line2"], WGS72) for e in entries]

    def index_at(self, t: datetime) -> int:
        return max(0, bisect.bisect_right(self.epochs, t) - 1)

    def teme(self, t: datetime, index: int | None = None):
        i = self.index_at(t) if index is None else index
        jd, fr = julian(t)
        err, r, v = self.sats[i].sgp4(jd, fr)
        if err:
            raise RuntimeError(f"SGP4 error {err} at {t}")
        return r, v, gmst(jd, fr), i

    def subpoint(self, t: datetime, index: int | None = None) -> dict:
        r, v, theta, i = self.teme(t, index)
        lat, lon, h = ecef_to_geodetic(*teme_to_ecef(r, theta))
        return {
            "time": iso(t),
            "tle_epoch": iso(self.epochs[i]),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "alt_km": round(h, 4),
            "speed_km_s": round(math.sqrt(sum(c * c for c in v)), 5),
        }

    def elevation(self, t: datetime, station_ecef, station_lat, station_lon) -> float:
        r, _, theta, _ = self.teme(t)
        x, y, z = teme_to_ecef(r, theta)
        rx, ry, rz = x - station_ecef[0], y - station_ecef[1], z - station_ecef[2]
        sl, cl = math.sin(station_lat), math.cos(station_lat)
        so, co = math.sin(station_lon), math.cos(station_lon)
        up = cl * co * rx + cl * so * ry + sl * rz
        return math.degrees(math.asin(up / math.sqrt(rx * rx + ry * ry + rz * rz)))


def sunlit_flags(hist: History, t: datetime, lat: float, lon: float):
    """(ground_sunlit, sun_elevation_deg, satellite_light, sun_above_limb_deg)
    at time t, by the gallery build's model (cts1_gallery/orbit.py): the
    Sun's angle above Earth's limb as seen from the satellite, with a
    +-1.5 degree terminator band."""
    s, _dist = sun_eci(t)
    r, _, theta, _ = hist.teme(t)
    s_ecef = teme_to_ecef(s, theta)
    up = (math.cos(math.radians(lat)) * math.cos(math.radians(lon)),
          math.cos(math.radians(lat)) * math.sin(math.radians(lon)),
          math.sin(math.radians(lat)))
    sun_el = math.degrees(math.asin(sum(a * b for a, b in zip(up, s_ecef))))
    d = math.sqrt(sum(c * c for c in r))
    from_nadir = math.degrees(math.acos(max(-1.0, min(1.0, -sum(s[k] * r[k] for k in range(3)) / d))))
    above = from_nadir - math.degrees(math.asin(min(1.0, 6371.0 / d)))
    light = "sunlit" if above > LIMB_BAND_DEG else "shadow" if above < -LIMB_BAND_DEG else "terminator"
    return sun_el > 0, round(sun_el, 1), light, round(above, 1)


def passes(hist: History, start: datetime, hours: int) -> list[dict]:
    lat, lon, h = CALGARY
    station = geodetic_to_ecef(lat, lon, h)
    slat, slon = math.radians(lat), math.radians(lon)
    out, current = [], None
    for s in range(hours * 3600 + 1):
        t = start + timedelta(seconds=s)
        el = hist.elevation(t, station, slat, slon)
        if el >= PASS_MASK_DEG:
            if current is None:
                current = {"rise": iso(t), "max": iso(t), "max_el": el, "set": None}
            elif el > current["max_el"]:
                current["max"], current["max_el"] = iso(t), el
        elif current is not None:
            current["set"] = iso(t - timedelta(seconds=1))
            current["max_el"] = round(current["max_el"], 3)
            out.append(current)
            current = None
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fill-sample", action="store_true", help="fill positions in images.sample.json")
    args = ap.parse_args()

    entries = json.loads(TLE_JSON.read_text(encoding="utf-8"))
    hist = History(entries)
    sample = json.loads(SAMPLE.read_text(encoding="utf-8"))

    epochs = []
    for i in (0, len(entries) - 1):
        t0 = hist.epochs[i]
        epochs.append(hist.subpoint(t0, i))
        epochs.append(hist.subpoint(t0 + timedelta(hours=3), i))

    photos = []
    for img in sample["images"]:
        if not img.get("captured_at"):
            continue
        t = parse_iso(img["captured_at"])
        ref = hist.subpoint(t)
        ref["id"] = img["id"]
        photos.append(ref)
        if args.fill_sample:
            ground, sun_el, light, above = sunlit_flags(hist, t, ref["lat"], ref["lon"])
            img["position"] = {
                "lat": round(ref["lat"], 4),
                "lon": round(ref["lon"], 4),
                "alt_km": round(ref["alt_km"], 1),
                "ground_sunlit": ground,
                "sun_elevation_deg": sun_el,
                "satellite_sunlit": light != "shadow",
                "satellite_light": light,
                "sun_above_limb_deg": above,
                "tle_epoch": ref["tle_epoch"][:19] + "Z",
                "basis": "SGP4 from the most recent TLE before capture",
            }

    pass_start = datetime(2026, 10, 29, tzinfo=timezone.utc)
    reference = {
        "about": "Python sgp4 reference values for verify.mjs; regenerate with make_reference.py.",
        "tle_epochs": epochs,
        "photos": photos,
        "passes": {
            "station": {"lat": CALGARY[0], "lon": CALGARY[1], "height_km": CALGARY[2]},
            "mask_deg": PASS_MASK_DEG,
            "from": iso(pass_start),
            "hours": 24,
            "list": passes(hist, pass_start, 24),
        },
        "space_track_rev": {
            "epoch": iso(hist.epochs[-1]),
            "rev_at_epoch": int(entries[-1]["line2"][63:68]),
        },
    }
    OUT.write_text(json.dumps(reference, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}: {len(epochs)} epoch points, {len(photos)} photos, "
          f"{len(reference['passes']['list'])} passes")
    if args.fill_sample:
        SAMPLE.write_text(json.dumps(sample, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"filled positions in {SAMPLE.name}")


if __name__ == "__main__":
    main()
