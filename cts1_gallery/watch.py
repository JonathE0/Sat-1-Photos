"""The watchlist: things happening on Earth worth photographing from orbit,
and when CTS-SAT-1 next passes over each in the right light. Writes
`site/data/watchlist.json` (format in docs/DATA.md).

Plain scheduled code, no AI in the loop. Events come from free public feeds
that need no key:

- NASA EONET: open natural events (wildfires, storms, volcanoes, dust and
  haze, sea and lake ice, floods, ...), each with the agency it came from.
- GDACS, the UN and European Commission's disaster alerts: tropical
  cyclones, floods, volcanoes and the larger wildfires, worldwide.
- NOAA SWPC: the 3-day Kp forecast and the OVATION aurora nowcast.

Each feed is fetched at most once per `REFRESH` and its last good answer is
kept in the cache, so a feed that is down leaves its events as they were,
marked with their age, and never fails the run. Earthquakes, droughts and
heat waves are left out: they can't be seen from orbit.

Passes come from the gallery's own SGP4 orbit (`orbit.Orbit`, the newest
TLE). A pass counts when the point below the satellite comes within
`MAX_KM` of the event in the right light: the sun at least `DAY_SUN_MIN`
up for daylight events, at least 12° below the horizon for aurora. The
camera's footprint isn't documented, so `MAX_KM` is a guess (a 62° lens,
like the Raspberry Pi camera's, would see about 300 km either side of
straight down from 500 km up).
"""

from __future__ import annotations

import json
import math
import re
import urllib.error
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from .net import get_json
from .orbit import Orbit, sun_elevation

MAX_KM = 400.0  # "close enough": distance from the point below the satellite
DAYS = 3.0  # how far ahead to look; TLEs older than a few days are rough anyway
REFRESH = timedelta(minutes=55)  # each feed at most hourly (the publish runs every 30 min)
MIN_FIRE_HA = 2000.0  # 20 km², about 5,000 acres: smaller fires are a few pixels at most
AURORA_KP = 4.0  # NOAA's "active" level; Kp 5 is a minor geomagnetic storm
DAY_SUN_MIN = 5.0  # degrees above the horizon, at the event
DARK_SUN_MAX = -12.0  # nautical twilight's end: dark enough for aurora
PROJECT_HOURS = 24.0  # moving events are carried on past their last fix or forecast point this far, and no further
MAX_OPPORTUNITIES = 12  # per event, the best ones

_STEP_S = 20.0  # track sampling; passes are then refined to well under a second
_R_KM = 6371.0
_GROUND_KM_S = 7.2  # how fast the point below a 500 km orbit moves
_CALGARY = timezone(timedelta(hours=-6), "ABT")  # Alberta Time: UTC-6 all year, as in site/assets/calgary-clock.js
# The geomagnetic (dipole) north pole, IGRF 2025. Magnetic latitude from a
# tilted dipole is good to a few degrees: enough to say "over the oval".
_POLE_LAT, _POLE_LON = 80.8, -72.6


@dataclass(frozen=True, slots=True)
class Feed:
    key: str
    name: str
    home: str  # for the credit
    parts: dict[str, str]  # part -> URL; a feed is fetched, cached and judged as a whole


EONET = Feed(
    "eonet", "NASA EONET", "https://eonet.gsfc.nasa.gov/",
    {"events": "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30"},
)
GDACS = Feed(
    "gdacs", "GDACS", "https://www.gdacs.org/",
    {t: f"https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype={t}" for t in ("TC", "FL", "VO", "WF")},
)
SWPC = Feed(
    "swpc", "NOAA SWPC", "https://www.swpc.noaa.gov/",
    {
        "kp": "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
        "ovation": "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
    },
)
FEEDS = (EONET, GDACS, SWPC)


@dataclass(slots=True)
class Loaded:
    feed: Feed
    parts: dict | None  # the responses, or None when there has never been a good one
    fetched_at: datetime | None
    status: str  # "ok" | "stale" (an older answer, the feed failed) | "down" (nothing to show)
    error: str | None = None


@dataclass(slots=True)
class Params:
    max_km: float = MAX_KM
    days: float = DAYS
    min_fire_ha: float = MIN_FIRE_HA
    aurora_kp: float = AURORA_KP


@dataclass(slots=True)
class Event:
    id: str
    title: str
    category: str  # storm wildfire volcano flood dust ice water snow manmade aurora
    sources: list[dict]
    # (time, lat, lon), oldest first: reported positions, then any forecast
    # ones (a cyclone's, from GDACS). [] for aurora.
    fixes: list[tuple[datetime, float, float]]
    updated_at: datetime | None
    where: str | None = None
    size: str | None = None
    alert: str | None = None  # GDACS: Green | Orange | Red
    started_at: datetime | None = None
    hemisphere: int = 0  # aurora: +1 north, -1 south
    area_ha: float | None = None  # wildfires
    areas: int = 1  # neighbouring fire areas folded into this entry
    reported_at: datetime | None = None  # the last reported (not forecast) position; default the last fix

    def __post_init__(self) -> None:
        if self.reported_at is None and self.fixes:
            self.reported_at = self.fixes[-1][0]

    @property
    def light(self) -> str:
        return "dark" if self.category == "aurora" else "day"


# -- feeds ---------------------------------------------------------------------


def load_feed(feed: Feed, cache_dir: Path, now: datetime, *, online: bool = True,
              get: Callable[[str], object] = get_json, log=print) -> Loaded:
    """The feed's responses: from the cache while they're fresh, else fetched.
    A failed or malformed fetch falls back to the last good answer."""
    path = cache_dir / f"{feed.key}.json"
    cached = _read_cache(path)
    if cached and (not online or now - cached[1] < REFRESH):
        stale = now - cached[1] >= REFRESH and not online
        return Loaded(feed, cached[0], cached[1], "stale" if stale else "ok", "not fetched (offline)" if stale else None)
    if not online:
        return Loaded(feed, None, None, "down", "not fetched (offline)")
    try:
        parts = _fetch_parts(feed, get)
        _parse_feed(feed.key, parts, now, Params())  # a reply in the wrong shape is a failure, not news
    except Exception as e:  # noqa: BLE001 -- any failure keeps the last good answer
        error = _describe(e)
        log(f"  {feed.name}: {error}" + ("; keeping the last good answer" if cached else ""))
        if cached:
            return Loaded(feed, cached[0], cached[1], "stale", error)
        return Loaded(feed, None, None, "down", error)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"fetched_at": _iso(now), "parts": parts}), encoding="utf-8")
    tmp.replace(path)
    return Loaded(feed, parts, now, "ok")


def _fetch_parts(feed: Feed, get) -> dict:
    parts, missing = {}, 0
    for name, url in feed.parts.items():
        try:
            parts[name] = get(url)
        except urllib.error.HTTPError as e:
            # GDACS answers 404 for an event type with nothing current (no
            # volcano alerts, say). Every type at once would be a moved API.
            if feed is not GDACS or e.code != 404:
                raise
            parts[name] = {"type": "FeatureCollection", "features": []}
            missing += 1
    if missing == len(feed.parts):
        msg = "every event list answered 404"
        raise ValueError(msg)
    return parts


def _read_cache(path: Path) -> tuple[dict, datetime] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw["parts"], _time(raw["fetched_at"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _describe(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        return f"couldn't connect ({e.reason})"
    return f"{type(e).__name__}: {e}"[:200]


def _parse_feed(key: str, parts: dict, now: datetime, p: Params, places=None) -> list[Event]:
    if key == "eonet":
        return eonet_events(parts["events"], now, p)
    if key == "gdacs":
        return gdacs_events(parts, now, p, places)
    if key == "swpc":
        kp_series(parts["kp"])  # aurora events need the window; this only checks the shape
        ovation_summary(parts["ovation"])
        return []
    raise KeyError(key)


# -- EONET ---------------------------------------------------------------------

_EONET_CATEGORIES = {
    "severeStorms": "storm", "wildfires": "wildfire", "volcanoes": "volcano", "floods": "flood",
    "dustHaze": "dust", "seaLakeIce": "ice", "waterColor": "water", "snow": "snow", "manmade": "manmade",
}
_EONET_SOURCES = {
    "JTWC": "Joint Typhoon Warning Center", "NOAA_NHC": "NOAA National Hurricane Center",
    "NOAA_CPC": "NOAA Climate Prediction Center", "IRWIN": "IRWIN (US wildland fire)",
    "InciWeb": "InciWeb", "CALFIRE": "CAL FIRE", "NATICE": "US National Ice Center",
    "BYU_ICE": "BYU Antarctic iceberg tracking", "SIVolcano": "Smithsonian Global Volcanism Program",
    "AVO": "Alaska Volcano Observatory", "EO": "NASA Earth Observatory", "GDACS": "GDACS",
    "PDC": "Pacific Disaster Center", "ABFIRE": "Alberta Wildfire", "BCWILDFIRE": "BC Wildfire Service",
    "MBFIRE": "Manitoba Wildfire Service", "FloodList": "FloodList", "ReliefWeb": "ReliefWeb",
}
_STORM_FIX_MAX_AGE = timedelta(hours=48)  # a storm with no fix for two days has died out or been lost


def eonet_events(data: dict, now: datetime, p: Params) -> list[Event]:
    events = []
    for e in data["events"]:
        category = next((_EONET_CATEGORIES[c["id"]] for c in e.get("categories", []) if c["id"] in _EONET_CATEGORIES), None)
        if category is None:
            continue
        fixes, magnitudes = [], []
        for g in e.get("geometry") or []:
            point = _point(g)
            if point is None or not g.get("date"):
                continue
            fixes.append((_time(g["date"]), *point))
            magnitudes.append((g.get("magnitudeValue"), g.get("magnitudeUnit")))
        if not fixes:
            continue
        order = sorted(range(len(fixes)), key=lambda i: fixes[i][0])
        fixes = [fixes[i] for i in order]
        value, unit = magnitudes[order[-1]]
        title = " ".join(e["title"].split())
        if category == "wildfire":
            if title.lower().startswith("prescribed fire"):
                continue
            ha = _hectares(value, unit)
            if ha is not None and ha < p.min_fire_ha:
                continue
        if category == "storm" and now - fixes[-1][0] > _STORM_FIX_MAX_AGE:  # EONET's fixes are all reports
            continue
        sources = [{"name": "NASA EONET", "url": f"https://eonet.gsfc.nasa.gov/api/v3/events/{e['id']}"}]
        sources += [{"name": _EONET_SOURCES.get(s["id"], s["id"]), "url": s["url"]} for s in e.get("sources") or [] if s.get("url")]
        events.append(Event(
            id=f"eonet-{e['id']}".lower(), title=title, category=category, sources=sources, fixes=fixes,
            updated_at=fixes[-1][0], size=_size(category, value, unit), started_at=fixes[0][0],
            area_ha=_hectares(value, unit) if category == "wildfire" else None,
        ))
    return events


def _point(g: dict) -> tuple[float, float] | None:
    """(lat, lon) of a GeoJSON point, or a polygon's middle."""
    if g.get("type") == "Point":
        lon, lat = g["coordinates"][:2]
        return float(lat), float(lon)
    if g.get("type") == "Polygon":
        return _middle(g["coordinates"][0])
    return None


def _hectares(value, unit) -> float | None:
    if value is None:
        return None
    unit = (unit or "").lower()
    if unit == "acres":
        return float(value) * 0.404686
    if unit in ("ha", "hectares"):
        return float(value)
    return None


def _grouped(value: float) -> str:
    """A whole number with a narrow space between the thousands: a comma is a
    decimal point across much of Europe, so "2,401" would read as 2.4."""
    return f"{value:,.0f}".replace(",", " ")


def _size(category: str, value, unit) -> str | None:
    if value is None:
        return None
    unit = unit or ""
    if category == "wildfire" and (ha := _hectares(value, unit)) is not None:
        return f"{_grouped(ha)} hectares burnt"
    if unit == "kts":
        return f"Winds of {value:.0f} knots"
    if unit == "NM^2":
        return f"About {_grouped(value * 3.43)} km²"
    return None


# -- GDACS ---------------------------------------------------------------------

_GDACS_CATEGORIES = {"TC": "storm", "FL": "flood", "VO": "volcano", "WF": "wildfire"}
_TRACK_LABEL = re.compile(r"(\d{1,2})/(\d{1,2}) (\d{1,2}):(\d{2}) UTC")


def gdacs_events(parts: dict, now: datetime, p: Params, places=None) -> list[Event]:
    events = []
    for etype, data in parts.items():
        category = _GDACS_CATEGORIES[etype]
        features = data.get("features") or []
        tracks: dict[int, list] = {}
        for f in features:  # a cyclone's positions, past and forecast, as small circles labelled with their time
            props = f.get("properties") or {}
            if str(props.get("Class", "")).startswith("Point_Polygon_Point") and f["geometry"]["type"] == "Polygon":
                t = _track_time(props.get("polygonlabel") or "", props.get("fromdate"))
                if t:
                    tracks.setdefault(props["eventid"], []).append((t, *_middle(f["geometry"]["coordinates"][0])))
        centroids: dict[int, dict] = {}
        for f in features:
            props = f.get("properties") or {}
            if f["geometry"]["type"] != "Point" or str(props.get("iscurrent")).lower() != "true":
                continue
            if props.get("Class") == "Point_Centroid" or props["eventid"] not in centroids:
                centroids[props["eventid"]] = f
        for eventid, f in centroids.items():
            props = f["properties"]
            lon, lat = (float(c) for c in f["geometry"]["coordinates"][:2])
            severity = props.get("severitydata") or {}
            value, unit = severity.get("severity"), (severity.get("severityunit") or "").lower()
            if category == "wildfire" and unit == "ha" and value is not None and value < p.min_fire_ha:
                continue
            updated = _time(props["datemodified"]) if props.get("datemodified") else None
            fix_time = _time(props["todate"]) if props.get("todate") else updated or now
            by_time = {t: (t, a, b) for t, a, b in tracks.get(eventid, [])}
            by_time[fix_time] = (fix_time, lat, lon)  # the centroid wins over the track circle at its time
            fixes = sorted(by_time.values())
            if category == "storm" and now - fix_time > _STORM_FIX_MAX_AGE:
                continue
            if category == "storm":
                title = f"Tropical cyclone {_storm_title(props.get('eventname') or '')}".strip()
                size = f"Winds up to {value:.0f} km/h" if unit == "km/h" and value else None
                where = None  # it moves; the page shows where it will be
            else:
                title = " ".join((props.get("name") or props.get("description") or "").split())
                size = (f"{_grouped(value)} hectares burnt" if category == "wildfire" and unit == "ha" and value
                        else _volcano_size(severity) if category == "volcano" else None)
                where = (places.name(lat, lon) if places else None) or props.get("country") or None
            url = (props.get("url") or {}).get("report") or "https://www.gdacs.org/"
            events.append(Event(
                id=f"gdacs-{etype}-{eventid}".lower(), title=title, category=category,
                sources=[{"name": "GDACS", "url": url}], fixes=fixes, updated_at=updated, where=where,
                size=size, alert=props.get("alertlevel") or None,
                started_at=_time(props["fromdate"]) if props.get("fromdate") else None,
                area_ha=float(value) if category == "wildfire" and unit == "ha" and value else None,
                reported_at=fix_time,
            ))
    return events


def _storm_title(eventname: str) -> str:
    """"IN-FA-26" -> "In-fa"."""
    base = re.sub(r"-\d{2}$", "", eventname.strip())
    return base[:1].upper() + base[1:].lower()


def _volcano_size(severity: dict) -> str | None:
    text = (severity.get("severitytext") or "").strip()
    return text[:1].upper() + text[1:] if text else None


def _track_time(label: str, fromdate: str | None) -> datetime | None:
    m = _TRACK_LABEL.search(label)
    if not m or not fromdate:
        return None
    start = _time(fromdate)
    day, month, hour, minute = (int(x) for x in m.groups())
    try:
        t = datetime(start.year, month, day, hour, minute, tzinfo=UTC)
    except ValueError:
        return None
    return t.replace(year=t.year + 1) if t < start - timedelta(days=1) else t  # a track across New Year


def merge_storms(events: list[Event]) -> list[Event]:
    """One entry per cyclone: EONET and GDACS both list most of them. The
    entry keeps EONET's name, both feeds' links, GDACS's alert and wind, and
    whichever track reaches further (GDACS's carries the forecast)."""
    gdacs = [e for e in events if e.category == "storm" and e.id.startswith("gdacs-")]
    merged: set[str] = set()
    for e in events:
        if e.category != "storm" or not e.id.startswith("eonet-"):
            continue
        for g in gdacs:
            name = g.title.removeprefix("Tropical cyclone ").lower()
            if g.id in merged or not name or not re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", e.title.lower()):
                continue
            if _km(_position(e.fixes, e.reported_at), _position(g.fixes, g.reported_at)) > 1500:
                continue
            e.sources += g.sources
            e.alert, e.size = g.alert, g.size or e.size
            if g.fixes[-1][0] > e.fixes[-1][0]:
                e.fixes = g.fixes
            e.reported_at = max(e.reported_at, g.reported_at)
            e.updated_at = max(t for t in (e.updated_at, g.updated_at) if t)
            merged.add(g.id)
            break
    return [e for e in events if e.id not in merged]


_FIRE_CLUSTER_KM = 75.0  # well inside one picture


def merge_nearby_fires(events: list[Event]) -> list[Event]:
    """Neighbouring fire areas (GDACS lists each burnt patch on its own)
    become one entry, named after the largest."""
    fires = sorted((e for e in events if e.category == "wildfire"), key=lambda e: -(e.area_ha or 0))
    kept: list[Event] = []
    for e in fires:
        into = next((k for k in kept if _km(k.fixes[-1][1:], e.fixes[-1][1:]) < _FIRE_CLUSTER_KM), None)
        if into is None:
            kept.append(e)
            continue
        into.areas += e.areas
        if e.area_ha:
            into.area_ha = (into.area_ha or 0) + e.area_ha
        into.sources += [s for s in e.sources if s not in into.sources]
        into.updated_at = max((t for t in (into.updated_at, e.updated_at) if t), default=None)
        into.started_at = min((t for t in (into.started_at, e.started_at) if t), default=None)
        if into.area_ha:
            into.size = f"{_grouped(into.area_ha)} hectares burnt in {into.areas} areas"
    keep = {id(e) for e in kept}
    return [e for e in events if e.category != "wildfire" or id(e) in keep]


# -- SWPC: aurora --------------------------------------------------------------


def kp_series(data: list) -> list[tuple[datetime, float, str]]:
    """(start of the 3-hour window, Kp, observed | estimated | predicted)."""
    rows = []
    for row in data:
        if isinstance(row, dict):
            rows.append((_time(row["time_tag"]), float(row["kp"]), str(row.get("observed") or "")))
    if not rows:
        msg = "no Kp values in the forecast"
        raise ValueError(msg)
    return sorted(rows)


def ovation_summary(data: dict) -> dict:
    """The nowcast's strongest chance of aurora in each hemisphere, in percent."""
    north = south = 0
    for lon, lat, value in data["coordinates"]:
        if lat > 0:
            north = max(north, value)
        elif lat < 0:
            south = max(south, value)
    return {"forecast_at": _iso(_time(data["Forecast Time"])), "north_max_pct": int(north), "south_max_pct": int(south)}


def aurora_events(parts: dict, start: datetime, end: datetime, p: Params) -> tuple[list[Event], dict, list]:
    kp = [r for r in kp_series(parts["kp"]) if r[0] + timedelta(hours=3) > start and r[0] < end]
    top = max(kp, key=lambda r: r[1]) if kp else None
    summary = {
        "threshold_kp": p.aurora_kp,
        "max_kp": round(top[1], 2) if top else None,
        "max_kp_at": _iso(top[0]) if top else None,
        "ovation": ovation_summary(parts["ovation"]),
    }
    if not top or top[1] < p.aurora_kp:
        return [], summary, kp
    sources = [
        {"name": "NOAA SWPC Kp forecast", "url": "https://www.swpc.noaa.gov/products/planetary-k-index"},
        {"name": "NOAA SWPC aurora forecast", "url": "https://www.swpc.noaa.gov/products/aurora-30-minute-forecast"},
    ]
    issued = _time(parts["ovation"]["Observation Time"])  # the Kp product carries no issue time
    events = [
        Event(id=f"swpc-aurora-{side}", title=title, category="aurora", sources=sources, fixes=[],
              updated_at=issued, where=f"The auroral oval around the {side} magnetic pole",
              size=f"Kp up to {top[1]:.1f} forecast", hemisphere=sign)
        for side, title, sign in (("north", "Northern lights", 1), ("south", "Southern lights", -1))
    ]
    return events, summary, kp


def oval_edge(kp: float) -> float:
    """Magnetic latitude of the auroral oval's equatorward edge for a Kp,
    after NOAA's rule of thumb (66.5° at Kp 0 to 48° at Kp 9)."""
    return 66.5 - 2.04 * kp


# -- the orbit -----------------------------------------------------------------


@dataclass(slots=True)
class Track:
    """The point below the satellite, every `step` seconds."""
    t0: datetime
    s: np.ndarray  # seconds after t0
    lat: np.ndarray
    lon: np.ndarray
    sun: np.ndarray  # sun elevation at that point
    xyz: np.ndarray  # unit vectors


def sample(orbit: Orbit, start: datetime, end: datetime, step: float = _STEP_S) -> Track:
    s = np.arange(0.0, (end - start).total_seconds() + step, step)
    states = [orbit.state(start + timedelta(seconds=float(x))) for x in s]
    lat = np.array([st.lat for st in states])
    lon = np.array([st.lon for st in states])
    return Track(start, s, lat, lon, np.array([st.sun_elevation_deg for st in states]), _unit(lat, lon))


def find_passes(orbit: Orbit, track: Track, event: Event, max_km: float) -> list[dict]:
    """Passes over a point (or moving) event in its light, best first."""
    path = _event_path(event)
    target = _target(event.fixes, path, track.t0, track.s)
    d = _R_KM * np.arccos(np.clip(np.einsum("ij,ij->i", track.xyz, target), -1, 1))
    inner = d[1:-1]
    margin = _STEP_S * _GROUND_KM_S  # a pass can dip under max_km between samples
    minima = np.nonzero((inner <= d[:-2]) & (inner <= d[2:]) & (inner < max_km + margin))[0] + 1

    def distance(s: float) -> float:
        st = orbit.state(track.t0 + timedelta(seconds=s))
        here = _unit(np.array([st.lat]), np.array([st.lon]))[0]
        there = _target(event.fixes, path, track.t0, np.array([s]))[0]
        return _R_KM * math.acos(max(-1.0, min(1.0, float(here @ there))))

    out = []
    for i in minima:
        s_min = _golden(distance, track.s[i - 1], track.s[i + 1])
        d_min = distance(s_min)
        if d_min > max_km:
            continue
        t = track.t0 + timedelta(seconds=s_min)
        if path and t - event.fixes[-1][0] > timedelta(hours=PROJECT_HOURS):
            continue  # nobody knows where it is by then
        lat, lon = _latlon(_target(event.fixes, path, track.t0, np.array([s_min]))[0])
        sun = sun_elevation(t, lat, lon)
        if sun < DAY_SUN_MIN:
            continue
        half = math.sqrt(max_km**2 - d_min**2) / _GROUND_KM_S  # about half the window, on a straight track
        s_in = _edge(distance, s_min, -(half + 30), max_km)
        s_out = _edge(distance, s_min, half + 30, max_km)
        st = orbit.state(t)
        theta = d_min / _R_KM
        off_nadir = math.degrees(math.atan2(_R_KM * math.sin(theta), _R_KM + st.alt_km - _R_KM * math.cos(theta)))
        age = (t - st.tle_epoch).total_seconds() / 86400
        projected = (t - event.reported_at).total_seconds() / 3600 if path else None
        basis = None
        if path:  # the position is a report, on a published forecast track, or carried on past one
            basis = "reported" if t <= event.reported_at else "forecast" if t <= event.fixes[-1][0] else "extrapolated"
        quality = (0.4 + 0.6 * (1 - d_min / max_km)) * _light_quality("day", sun) * _accuracy_quality(age)
        out.append({
            **_when(t, track.t0 + timedelta(seconds=s_in), track.t0 + timedelta(seconds=s_out)),
            "distance_km": round(d_min),
            "off_nadir_deg": round(off_nadir, 1),
            "target": {"lat": round(lat, 2), "lon": round(lon, 2),
                       "projected_h": round(projected, 1) if projected and projected > 1 else None, "basis": basis},
            **_conditions(st, sun, age, quality),
            # 8 minutes of track around the pass, for a map
            "ground_track": [_latlon_of(orbit.state(t + timedelta(seconds=30 * k))) for k in range(-8, 9)],
        })
    return sorted(out, key=lambda o: -o["quality"])[:MAX_OPPORTUNITIES]


def find_aurora_passes(orbit: Orbit, track: Track, event: Event, kp: list, threshold: float) -> list[dict]:
    """Crossings of the auroral oval in darkness while Kp is at the threshold
    or above, best first."""
    kp_now = np.full(track.s.shape, np.nan)
    for start, value, _kind in kp:
        a = (start - track.t0).total_seconds()
        kp_now[(track.s >= a) & (track.s < a + 3 * 3600)] = value
    mlat = event.hemisphere * _magnetic_latitude(track.lat, track.lon)
    edge = oval_edge(np.nan_to_num(kp_now, nan=0.0))
    over = (kp_now >= threshold) & (mlat >= edge) & (mlat <= edge + 12) & (track.sun <= DARK_SUN_MAX)
    out = []
    for i0, i1 in _runs(over):
        mid = (i0 + i1) // 2
        t = track.t0 + timedelta(seconds=float(track.s[mid]))
        st = orbit.state(t)
        age = (t - st.tle_epoch).total_seconds() / 86400
        k = float(kp_now[mid])
        quality = min(1.0, 0.5 + (k - threshold) / 4) * _light_quality("dark", st.sun_elevation_deg) * _accuracy_quality(age)
        lo, hi = max(i0 - 6, 0), min(i1 + 6, len(track.s) - 1)
        out.append({
            **_when(t, track.t0 + timedelta(seconds=float(track.s[i0])), track.t0 + timedelta(seconds=float(track.s[i1]))),
            "distance_km": None,  # it's under the satellite: the oval is wider than the view
            "off_nadir_deg": None,
            "target": {"lat": round(st.lat, 2), "lon": round(st.lon, 2), "projected_h": None, "basis": None},
            **_conditions(st, st.sun_elevation_deg, age, quality),
            "kp": round(k, 2),
            "magnetic_latitude_deg": round(float(mlat[mid]) * event.hemisphere, 1),
            "ground_track": [[round(float(track.lat[j]), 2), round(float(track.lon[j]), 2)] for j in range(lo, hi + 1, 2)],
        })
    return sorted(out, key=lambda o: -o["quality"])[:MAX_OPPORTUNITIES]


def _when(t: datetime, t_in: datetime, t_out: datetime) -> dict:
    local = t.astimezone(_CALGARY)
    return {
        "closest_at": _iso(t),
        "closest_at_calgary": local.replace(microsecond=0).isoformat(),
        "calgary_zone": local.tzname(),
        "window": {"from": _iso(t_in), "to": _iso(t_out)},
    }


def _conditions(st, sun: float, age: float, quality: float) -> dict:
    return {
        "satellite": {"lat": round(st.lat, 2), "lon": round(st.lon, 2), "alt_km": round(st.alt_km),
                      "light": st.satellite_light},
        "sun_elevation_deg": round(sun, 1),
        "light": _light_word(sun),
        "tle_epoch": _iso(st.tle_epoch),
        "tle_age_days": round(age, 1),
        "accuracy": "good" if age < 2 else "fair" if age < 5 else "rough",
        "quality": round(quality, 2),
    }


def _latlon_of(st) -> list[float]:
    return [round(st.lat, 2), round(st.lon, 2)]


def _light_word(sun: float) -> str:
    if sun >= 15:
        return "day"
    if sun >= -0.833:
        return "low sun"
    return "twilight" if sun >= DARK_SUN_MAX else "night"


def _light_quality(kind: str, sun: float) -> float:
    if kind == "day":  # 0.4 at the lowest allowed sun, 1 from 20° up
        return min(1.0, 0.4 + 0.6 * (sun - DAY_SUN_MIN) / (20 - DAY_SUN_MIN))
    return min(1.0, 0.5 + 0.5 * (DARK_SUN_MAX - sun) / 6)  # 0.5 at -12°, 1 from -18° (astronomical night)


def _accuracy_quality(age_days: float) -> float:
    return 1.0 if age_days < 2 else 0.85 if age_days < 5 else 0.6


def _golden(f, a: float, b: float, iterations: int = 24) -> float:
    g = (math.sqrt(5) - 1) / 2
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = f(c), f(d)
    for _ in range(iterations):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = f(d)
    return (a + b) / 2


def _edge(f, inside: float, step: float, limit: float, iterations: int = 12) -> float:
    """Where f rises through `limit`, going from `inside` (under it) in
    steps of `step` seconds. Steps double until one lands outside: near the
    poles the track curves round a target and the window can run long."""
    outside = inside + step
    while f(outside) <= limit:
        if abs(step) > 1800:
            return outside
        inside, step = outside, step * 2
        outside = inside + step
    for _ in range(iterations):
        mid = (inside + outside) / 2
        if f(mid) <= limit:
            inside = mid
        else:
            outside = mid
    return (inside + outside) / 2


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    edges = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.nonzero(edges == 1)[0], np.nonzero(edges == -1)[0] - 1, strict=True))


def _event_path(e: Event) -> _Path | None:
    """Only storms move fast enough to follow. Icebergs, fires and floods
    stay at their last reported position (icebergs drift a few km a day,
    and the page says when that report was)."""
    return _path(e.fixes) if e.category == "storm" else None


@dataclass(frozen=True, slots=True)
class _Path:
    """How a moving event moves: along its fixes (forecast ones included),
    then on along the great circle of its last day or so."""
    times: np.ndarray  # POSIX seconds
    points: np.ndarray  # unit vectors
    ahead: tuple[np.ndarray, float] | None  # (rotation axis, rad/s) past the last fix


def _path(fixes: list) -> _Path | None:
    """None for an event that stays put."""
    if len(fixes) < 2:
        return None
    times = np.array([f[0].timestamp() for f in fixes])
    points = _unit(np.array([f[1] for f in fixes]), np.array([f[2] for f in fixes]))
    if float(np.min(points @ points[-1])) > math.cos(1 / _R_KM):
        return None  # every fix within a km of the last
    t1 = fixes[-1][0]
    earlier = [i for i, f in enumerate(fixes[:-1]) if timedelta(hours=5) <= t1 - f[0] <= timedelta(hours=36)]
    ahead = None
    if earlier:
        i = min(earlier, key=lambda i: abs((t1 - fixes[i][0]) - timedelta(hours=24)))
        axis = np.cross(points[i], points[-1])
        norm = float(np.linalg.norm(axis))
        if norm > 1e-9:
            ahead = (axis / norm, math.atan2(norm, float(points[i] @ points[-1])) / (times[-1] - times[i]))
    return _Path(times, points, ahead)


def _target(fixes: list, path: _Path | None, t0: datetime, s: np.ndarray) -> np.ndarray:
    """Unit vectors of where the event is at t0 + s: where it stays, or
    between its fixes, or carried on past the last for up to PROJECT_HOURS
    and held there (find_passes drops passes that late)."""
    if path is None:
        return np.broadcast_to(_unit(np.array([fixes[-1][1]]), np.array([fixes[-1][2]]))[0], (len(s), 3))
    at = s + t0.timestamp()
    times, points = path.times, path.points
    out = np.empty((len(s), 3))
    out[at <= times[0]] = points[0]
    inside = (at > times[0]) & (at < times[-1])
    j = np.searchsorted(times, at[inside], side="right") - 1
    out[inside] = _turn(points[j], points[j + 1], (at[inside] - times[j]) / (times[j + 1] - times[j]))
    after = at >= times[-1]
    if path.ahead is None:
        out[after] = points[-1]
    else:
        axis, rate = path.ahead
        angle = (rate * np.clip(at[after] - times[-1], 0, PROJECT_HOURS * 3600))[:, None]
        out[after] = points[-1] * np.cos(angle) + np.cross(axis, points[-1]) * np.sin(angle)  # axis ⟂ the point
    return out


def _turn(a: np.ndarray, b: np.ndarray, frac: np.ndarray) -> np.ndarray:
    """The points `frac` of the way along the great circles from a to b."""
    axis = np.cross(a, b)
    norm = np.linalg.norm(axis, axis=1, keepdims=True)
    angle = np.arctan2(norm[:, 0], np.einsum("ij,ij->i", a, b)) * frac
    k = np.divide(axis, norm, out=np.zeros_like(axis), where=norm > 1e-12)
    return a * np.cos(angle)[:, None] + np.cross(k, a) * np.sin(angle)[:, None]


def _position(fixes: list, at: datetime | None) -> tuple[float, float]:
    """(lat, lon) of the last fix at or before `at`."""
    before = [f for f in fixes if at is None or f[0] <= at]
    f = before[-1] if before else fixes[0]
    return f[1], f[2]


def _magnetic_latitude(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    pole = _unit(np.array([_POLE_LAT]), np.array([_POLE_LON]))[0]
    return np.degrees(np.arcsin(np.clip(_unit(lat, lon) @ pole, -1, 1)))


def _unit(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    phi, lam = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)], axis=-1)


def _latlon(v: np.ndarray) -> tuple[float, float]:
    return math.degrees(math.asin(max(-1.0, min(1.0, float(v[2]))))), math.degrees(math.atan2(float(v[1]), float(v[0])))


def _middle(ring: list) -> tuple[float, float]:
    """(lat, lon) of the middle of a small polygon ring, safe across 180°."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    v = _unit(np.array([float(p[1]) for p in pts]), np.array([float(p[0]) for p in pts])).mean(axis=0)
    return _latlon(v / np.linalg.norm(v))


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    u = _unit(np.array([a[0], b[0]]), np.array([a[1], b[1]]))
    return _R_KM * math.acos(max(-1.0, min(1.0, float(u[0] @ u[1]))))


# -- the watchlist -------------------------------------------------------------


def build_watchlist(loaded: list[Loaded], orbit: Orbit, now: datetime, p: Params | None = None, places=None) -> dict:
    p = p or Params()
    # From the start of the hour, so runs within the hour write the same file.
    start = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(days=p.days)
    events, aurora, kp, counts = [], None, [], {}
    for item in loaded:
        found: list[Event] = []
        if item.parts is not None:
            if item.feed.key == "swpc":
                found, aurora, kp = aurora_events(item.parts, start, end, p)
            else:
                found = _parse_feed(item.feed.key, item.parts, now, p, places)
        counts[item.feed.key] = len(found)
        events += found
    events = merge_nearby_fires(merge_storms(events))
    track = sample(orbit, start - timedelta(minutes=5), end + timedelta(minutes=5))
    entries = []
    for e in events:
        if e.category == "aurora":
            ops = find_aurora_passes(orbit, track, e, kp, p.aurora_kp)
        else:
            ops = find_passes(orbit, track, e, p.max_km)
        ops = [o for o in ops if _time(o["window"]["to"]) >= start and _time(o["closest_at"]) <= end]
        entries.append(_entry(e, ops))
    entries.sort(key=lambda x: (x["next_at"] is None, x["next_at"] or "", x["title"]))
    newest_tle = orbit.state(start).tle_epoch
    return {
        "generated_at": _iso(now),
        "window": {"from": _iso(start), "to": _iso(end)},
        "max_km": p.max_km,
        "rules": {"day_sun_min_deg": DAY_SUN_MIN, "dark_sun_max_deg": DARK_SUN_MAX,
                  "min_fire_ha": p.min_fire_ha, "aurora_kp": p.aurora_kp},
        "tle_epoch": _iso(newest_tle),
        "sources": [
            {"id": item.feed.key, "name": item.feed.name, "url": item.feed.home, "status": item.status,
             "fetched_at": _iso(item.fetched_at), "error": item.error, "events": counts.get(item.feed.key, 0)}
            for item in loaded
        ],
        "aurora": aurora,
        "events": entries,
    }


def _entry(e: Event, ops: list[dict]) -> dict:
    lat, lon = _position(e.fixes, e.reported_at) if e.fixes else (None, None)
    moving = _event_path(e) is not None

    def points(fixes):
        return [{"at": _iso(t), "lat": round(a, 2), "lon": round(b, 2)} for t, a, b in fixes] if moving else []

    return {
        "id": e.id,
        "title": e.title,
        "category": e.category,
        "light": e.light,
        "where": e.where,
        "size": e.size,
        "alert": e.alert,
        "lat": round(lat, 3) if lat is not None else None,
        "lon": round(lon, 3) if lon is not None else None,
        "moving": moving,
        "track": points([f for f in e.fixes if f[0] <= e.reported_at][-8:]),
        "forecast": points([f for f in e.fixes if f[0] > e.reported_at]),
        "reported_at": _iso(e.reported_at),
        "started_at": _iso(e.started_at),
        "updated_at": _iso(e.updated_at),
        "sources": e.sources,
        "next_at": min((o["closest_at"] for o in ops), default=None),
        "opportunities": ops,
    }


def run(cache_dir: Path, out: Path, tle_history: Path, *, online: bool = True, log=print,
        now: datetime | None = None, get: Callable[[str], object] = get_json, params: Params | None = None,
        places=None) -> int:
    """Refresh the feeds and write the watchlist. Feeds that fail keep their
    last good answer; only a missing orbit stops the run (exit code 2).
    `places` names GDACS's fires and floods (default: Nominatim, cached)."""
    from .places import Places

    now = now or datetime.now(UTC)
    params = params or Params()
    if not tle_history.exists():
        log(f"no orbital elements at {tle_history}; run `python -m cts1_gallery update` first")
        return 2
    loaded = []
    for feed in FEEDS:
        item = load_feed(feed, cache_dir, now, online=online, get=get, log=log)
        age = f", {_age(now - item.fetched_at)} old" if item.fetched_at and item.status != "ok" else ""
        log(f"  {feed.name}: {item.status}{age}")
        loaded.append(item)
    places = places or Places(cache_dir / "places.json", online=online)
    payload = build_watchlist(loaded, Orbit(tle_history), now, params, places)
    places.save()

    copy = cache_dir / "watchlist.json"  # survives in the CI cache; site/data/ doesn't
    old = _read_json(copy) or _read_json(out)
    if old and {**old, "generated_at": None} == {**payload, "generated_at": None}:
        payload["generated_at"] = old["generated_at"]  # nothing new: keep the file byte for byte
    data = json.dumps(payload, indent=1, ensure_ascii=False) + "\n"
    for path in (out, copy):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(data, encoding="utf-8")
        tmp.replace(path)
    with_passes = sum(1 for e in payload["events"] if e["opportunities"])
    log(f"  {len(payload['events'])} events, {with_passes} with a pass in the next {params.days:g} days")
    return 0


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _age(d: timedelta) -> str:
    hours = d.total_seconds() / 3600
    return f"{hours:.0f} h" if hours < 48 else f"{hours / 24:.0f} days"


def _time(value: str) -> datetime:
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t.replace(tzinfo=UTC) if t.tzinfo is None else t.astimezone(UTC)


def _iso(t: datetime | None) -> str | None:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None
