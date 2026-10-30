"""Where the satellite was at a given moment, and what the light was like.

Positions come from SGP4 with the TLE published most recently before that
moment (Space-Track, via the ground pipeline's `tle_history` table) -- the
same choice the team's own pipeline makes. For TLEs a day or so old that is
good to a few km along-track: plenty to say what the camera was over, not
enough to geolocate a pixel.

Frames: SGP4 gives TEME coordinates; rotating by Greenwich sidereal time
gives Earth-fixed ones (polar motion and the small TEME/true-of-date
difference are ignored -- well under a km).
"""

from __future__ import annotations

import math
from bisect import bisect_right
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import polars as pl
from sgp4.api import WGS72, Satrec, jday
from sgp4.propagation import gstime

_EARTH_RADIUS_KM = 6378.137
_EARTH_MEAN_RADIUS_KM = 6371.0
_WGS84_F = 1 / 298.257223563
_WGS84_E2 = _WGS84_F * (2 - _WGS84_F)
_SGP4_EPOCH0 = datetime(1949, 12, 31, tzinfo=UTC)
_DEG = math.pi / 180
# The sun counts as up when its centre is above -0.833°, the usual allowance
# for refraction and the solar disc.
_SUNRISE_ELEVATION = -0.833
# Seen from orbit, sunlight grazing the limb is refracted by up to ~1.1° and
# the sun's disc is 0.27° in radius: within this band of Earth's limb the
# satellite is at the terminator -- partly lit, often with glare in frame.
_LIMB_BAND_DEG = 1.5


@dataclass(slots=True, frozen=True)
class State:
    lat: float
    lon: float
    alt_km: float
    sun_elevation_deg: float  # at the point directly below
    sun_above_limb_deg: float  # seen from the satellite; negative = behind Earth
    tle_epoch: datetime

    @property
    def ground_sunlit(self) -> bool:
        return self.sun_elevation_deg > _SUNRISE_ELEVATION

    @property
    def satellite_light(self) -> str:
        """"sunlit", "terminator" (the sun on Earth's limb) or "shadow"."""
        if self.sun_above_limb_deg > _LIMB_BAND_DEG:
            return "sunlit"
        return "shadow" if self.sun_above_limb_deg < -_LIMB_BAND_DEG else "terminator"

    @property
    def satellite_sunlit(self) -> bool:
        return self.satellite_light != "shadow"


class Orbit:
    def __init__(self, tle_history: Path) -> None:
        df = pl.read_parquet(tle_history).sort("epoch")
        self._epochs: list[datetime] = df["epoch"].to_list()
        self._sats = [_satrec(row) for row in df.iter_rows(named=True)]
        if not self._sats:
            msg = f"no TLEs in {tle_history}"
            raise ValueError(msg)

    def state(self, t: datetime) -> State:
        k = max(bisect_right(self._epochs, t) - 1, 0)  # latest TLE at or before t
        sat, epoch = self._sats[k], self._epochs[k]
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
        err, r, _v = sat.sgp4(jd, fr)
        if err:
            msg = f"SGP4 error {err} at {t.isoformat()}"
            raise ValueError(msg)
        gmst = gstime(jd + fr)
        x, y, z = _rotate_z(r, -gmst)
        lat, lon, alt = _geodetic(x, y, z)
        sun = _sun_direction(jd + fr)
        sun_ecef = _rotate_z(sun, -gmst)
        up = (math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat))
        elevation = math.degrees(math.asin(max(-1.0, min(1.0, _dot(up, sun_ecef)))))
        return State(
            lat=math.degrees(lat),
            lon=math.degrees(lon),
            alt_km=alt,
            sun_elevation_deg=elevation,
            sun_above_limb_deg=_sun_above_limb(r, sun),
            tle_epoch=epoch,
        )


def sun_elevation(t: datetime, lat: float, lon: float) -> float:
    """Degrees the sun's centre stands above the horizon at a point on the
    ground (no refraction), by the same sun model as `Orbit.state`."""
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
    sun = _rotate_z(_sun_direction(jd + fr), -gstime(jd + fr))
    phi, lam = lat * _DEG, lon * _DEG
    up = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))
    return math.degrees(math.asin(max(-1.0, min(1.0, _dot(up, sun)))))


def _satrec(row: dict) -> Satrec:
    sat = Satrec()
    sat.sgp4init(
        WGS72,
        "i",
        int(row["norad_id"]),
        (row["epoch"] - _SGP4_EPOCH0).total_seconds() / 86400,
        row["bstar"],
        row["mean_motion_dot"] * 2 * math.pi / 1440**2,
        0.0,
        row["eccentricity"],
        row["arg_perigee"] * _DEG,
        row["inclination"] * _DEG,
        row["mean_anomaly"] * _DEG,
        row["mean_motion"] * 2 * math.pi / 1440,
        row["raan"] * _DEG,
    )
    return sat


def _rotate_z(v, angle: float) -> tuple[float, float, float]:
    c, s = math.cos(angle), math.sin(angle)
    return (c * v[0] - s * v[1], s * v[0] + c * v[1], v[2])


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _geodetic(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Earth-fixed km to WGS84 latitude/longitude (radians) and height (km)."""
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - _WGS84_E2))
    alt = 0.0
    for _ in range(6):
        n = _EARTH_RADIUS_KM / math.sqrt(1 - _WGS84_E2 * math.sin(lat) ** 2)
        alt = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - _WGS84_E2 * n / (n + alt)))
    return lat, lon, alt


def _sun_direction(jd: float) -> tuple[float, float, float]:
    """Unit vector to the sun in the equatorial frame of date (the
    Astronomical Almanac's low-precision formula, good to ~0.01°)."""
    n = jd - 2451545.0
    mean_lon = math.radians((280.460 + 0.9856474 * n) % 360)
    anomaly = math.radians((357.528 + 0.9856003 * n) % 360)
    ecl_lon = mean_lon + math.radians(1.915) * math.sin(anomaly) + math.radians(0.020) * math.sin(2 * anomaly)
    obliquity = math.radians(23.439 - 0.0000004 * n)
    return (
        math.cos(ecl_lon),
        math.cos(obliquity) * math.sin(ecl_lon),
        math.sin(obliquity) * math.sin(ecl_lon),
    )


def _sun_above_limb(r, sun) -> float:
    """Degrees between the sun and Earth's limb as seen from the satellite:
    the sun's angle from straight down, minus the angular radius of the
    Earth's disc. Negative when the sun is behind the Earth.
    """
    distance = math.sqrt(_dot(r, r))
    nadir = (-r[0] / distance, -r[1] / distance, -r[2] / distance)
    from_nadir = math.degrees(math.acos(max(-1.0, min(1.0, _dot(nadir, sun)))))
    limb = math.degrees(math.asin(min(1.0, _EARTH_MEAN_RADIUS_KM / distance)))
    return from_nadir - limb
