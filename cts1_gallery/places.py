"""A human name for the point under the satellite: "Saskatchewan, Canada",
"Mediterranean Sea".

Land names come from OpenStreetMap's Nominatim reverse geocoder, at most one
request a second (its usage policy) and cached on disk, so each position is
looked up once ever. Nominatim has nothing to say about open sea, so those
points get a sea or ocean name from a coarse map instead -- good enough for
"what was it over", and members can correct any of it. Only Nominatim's
answer is cached (null where it found no land); the coarse map is applied on
every read, so improving it also corrects pictures looked up before.
"""

from __future__ import annotations

import json
import time
import urllib.parse
from pathlib import Path

from .net import get_json

_URL = "https://nominatim.openstreetmap.org/reverse"
_MIN_INTERVAL = 1.1  # seconds between requests

# Older versions cached ocean()'s answer where Nominatim found no land. Those
# are read as "no land", so the current ocean() names them.
_LEGACY_OCEANS = frozenset({"Southern Ocean", "Arctic Ocean", "Indian Ocean", "North Atlantic Ocean",
                            "South Atlantic Ocean", "North Pacific Ocean", "South Pacific Ocean"})


class Places:
    def __init__(self, cache_file: Path, *, online: bool = True) -> None:
        self.cache_file = cache_file
        self.online = online
        try:
            self._cache: dict[str, str | None] = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            self._cache = {}
        self._last = 0.0
        self._dirty = False

    def name(self, lat: float, lon: float) -> str | None:
        key = f"{lat:.2f},{lon:.2f}"
        if key in self._cache:
            land = self._cache[key]
        elif not self.online:
            return None
        else:
            try:
                land = self._lookup(lat, lon)
            except Exception:  # noqa: BLE001 -- a missing place name is fine
                return None
            self._cache[key] = land  # None: Nominatim found no land here
            self._dirty = True
        if land is None or land in _LEGACY_OCEANS:
            return ocean(lat, lon)
        return land

    def save(self) -> None:
        if self._dirty:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            self.cache_file.write_text(json.dumps(self._cache, indent=1, sort_keys=True))
            self._dirty = False

    def _lookup(self, lat: float, lon: float) -> str | None:
        wait = self._last + _MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        query = urllib.parse.urlencode(
            {"format": "jsonv2", "lat": f"{lat:.4f}", "lon": f"{lon:.4f}", "zoom": 5, "accept-language": "en"}
        )
        result = get_json(f"{_URL}?{query}")
        if not isinstance(result, dict) or "error" in result:
            return None
        address = result.get("address") or {}
        parts = [address.get("state") or address.get("region") or address.get("province"), address.get("country")]
        parts = [p for p in parts if p]
        return ", ".join(dict.fromkeys(parts)) or result.get("name") or None


# Seas the ocean rules below would misname: (name, lat from, lat to, lon from,
# lon to). First match wins, and land inside a box never gets this far.
_SEAS = (
    ("Black Sea", 40.5, 47.5, 27.0, 42.0),  # before the Mediterranean, whose box overlaps it
    ("Caspian Sea", 36.0, 47.5, 46.5, 55.0),
    ("Persian Gulf", 23.5, 30.5, 47.5, 56.6),
    ("Red Sea", 12.5, 30.0, 32.0, 43.5),
    ("Mediterranean Sea", 30.0, 41.0, -5.5, 36.5),
    ("Mediterranean Sea", 41.0, 46.0, 0.0, 36.5),  # from 0 E, so the Bay of Biscay stays Atlantic
    ("Baltic Sea", 53.5, 60.0, 12.0, 30.5),
    ("Baltic Sea", 60.0, 66.0, 16.5, 30.5),  # Gulf of Bothnia, east of Norway's coast
    ("White Sea", 63.5, 66.0, 32.0, 44.5),
    ("South China Sea", 3.0, 6.1, 102.0, 117.0),  # from the Malay Peninsula's east coast
    ("South China Sea", 6.1, 8.3, 104.8, 117.0),  # from 104.8 E, so the Gulf of Thailand stays out
    ("South China Sea", 8.3, 9.5, 104.8, 118.0),  # up Palawan's spine, so the Sulu Sea stays out
    ("South China Sea", 9.5, 10.5, 104.8, 119.0),
    ("South China Sea", 10.5, 12.5, 104.8, 120.0),
    ("South China Sea", 12.5, 22.0, 104.8, 120.8),  # west of Mindoro and Luzon
    ("South China Sea", 22.0, 23.5, 104.8, 117.0),  # up to the coast of China, short of the Taiwan Strait
)


def ocean(lat: float, lon: float) -> str | None:
    """Which sea or ocean a point is in, roughly (only used where there's no
    land). None between 63 and 79 S, where Antarctica's coast is and nothing
    here can tell ice from sea."""
    if lat <= -79:
        return "Antarctica"  # south of every ice-shelf front
    if lat < -63:
        return None
    if lat <= -60:
        return "Southern Ocean"
    if lat >= 66:
        return "Arctic Ocean"
    for name, lat0, lat1, lon0, lon1 in _SEAS:
        if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
            return name
    if ((20 <= lon <= 99 and lat < 30)
            or (99 < lon <= 115 and (lat < 0 or lon < 99 + (10.5 - lat) / 2))  # west of the Malay Peninsula
            or (115 < lon <= 142 and lat < -9)  # south of the Lesser Sunda Islands
            or (115 < lon <= 147 and lat < -30)):
        return "Indian Ocean"
    if 9 <= lat < 17.5 and -100 <= lon <= -70:  # Central America and Colombia's Caribbean coast
        return "North Pacific Ocean" if lon < -82.5 - (lat - 8) else "North Atlantic Ocean"
    if -100 <= lon <= 20 and lat > 10:
        return "North Atlantic Ocean"
    if -70 <= lon <= 20 and lat <= 10:
        return "South Atlantic Ocean"
    return "North Pacific Ocean" if lat > 0 else "South Pacific Ocean"
