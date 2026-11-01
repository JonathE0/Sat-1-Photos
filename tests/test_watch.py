"""Tests for the watchlist: pass finding against geometry built from the
orbit itself, and the feeds read from saved responses (no network).

    .venv\\Scripts\\python.exe -m unittest tests.test_watch -v
"""

import json
import math
import tempfile
import unittest
import urllib.error
from datetime import UTC, datetime, timedelta
from email.message import Message
from pathlib import Path

import numpy as np
import polars as pl

from cts1_gallery import watch
from cts1_gallery.orbit import Orbit, sun_elevation
from cts1_gallery.watch import Event, Params

FIXTURES = Path(__file__).with_name("fixtures") / "watch"
NOW = datetime(2026, 10, 30, 5, 0, tzinfo=UTC)
# CTS-SAT-1's elements of 27 Oct 2026, 22:38 UTC (Space-Track, via tle_history).
TLE = {
    "norad_id": 69015, "epoch": datetime(2026, 10, 27, 22, 38, 42, 964512, tzinfo=UTC),
    "inclination": 97.38330078125, "raan": 196.63980102539062, "eccentricity": 0.0006318999803625047,
    "arg_perigee": 307.5968933105469, "mean_anomaly": 52.469398498535156, "mean_motion": 15.23410631,
    "mean_motion_dot": 2.867e-05, "bstar": 0.00012339,
}
R = 6371.0


def write_tle(directory: Path) -> Path:
    path = directory / "tle_history.parquet"
    pl.DataFrame([TLE]).write_parquet(path)
    return path


def unit(lat, lon):
    phi, lam = math.radians(lat), math.radians(lon)
    return np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])


def latlon(v):
    return math.degrees(math.asin(v[2])), math.degrees(math.atan2(v[1], v[0]))


def still(lat, lon, category="wildfire"):
    return Event(id="test", title="Test", category=category, sources=[], fixes=[(NOW - timedelta(days=1), lat, lon)],
                 updated_at=NOW)


class PassGeometry(unittest.TestCase):
    """Targets placed on, beside and far from the satellite's own ground
    track, at moments picked from that track."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.orbit = Orbit(write_tle(Path(cls.tmp.name)))
        cls.track = watch.sample(cls.orbit, NOW, NOW + timedelta(hours=12))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def moment(self, sun_test) -> datetime:
        """A time off the sample grid when the ground below is lit as asked."""
        i = next(i for i in range(200, len(self.track.s)) if sun_test(self.track.sun[i]))
        return NOW + timedelta(seconds=float(self.track.s[i]) + 7.3)

    def below(self, t):
        st = self.orbit.state(t)
        return st.lat, st.lon

    def beside(self, t, km):
        """The point `km` to the side of the ground track at t."""
        p = unit(*self.below(t))
        ahead = unit(*self.below(t + timedelta(seconds=1))) - unit(*self.below(t - timedelta(seconds=1)))
        side = np.cross(p, ahead)
        side /= np.linalg.norm(side)
        a = km / R
        return latlon(p * math.cos(a) + side * math.sin(a))

    def nearest(self, ops, t):
        return min(ops, key=lambda o: abs(watch._time(o["closest_at"]) - t))

    def test_a_point_under_the_track_is_passed_over_at_that_moment(self):
        t = self.moment(lambda sun: sun > 30)
        ops = watch.find_passes(self.orbit, self.track, still(*self.below(t)), 400)
        o = self.nearest(ops, t)
        self.assertLess(abs(watch._time(o["closest_at"]) - t), timedelta(seconds=1))
        self.assertLessEqual(o["distance_km"], 1)
        self.assertLess(o["off_nadir_deg"], 0.5)
        # Inside 400 km for as long as the ground point takes to cover 800 km.
        a, b = unit(*self.below(t - timedelta(seconds=5))), unit(*self.below(t + timedelta(seconds=5)))
        speed = R * math.acos(float(a @ b)) / 10
        window = watch._time(o["window"]["to"]) - watch._time(o["window"]["from"])
        self.assertAlmostEqual(window.total_seconds(), 800 / speed, delta=3)
        self.assertEqual(o["light"], "day")
        self.assertEqual(o["satellite"]["light"], "sunlit")
        self.assertEqual(o["accuracy"], "fair")  # these elements are 2 to 3 days old by then

    def test_a_point_to_the_side_is_passed_at_that_distance(self):
        t = self.moment(lambda sun: sun > 30)
        o = self.nearest(watch.find_passes(self.orbit, self.track, still(*self.beside(t, 250)), 400), t)
        self.assertLess(abs(watch._time(o["closest_at"]) - t), timedelta(seconds=2))
        self.assertAlmostEqual(o["distance_km"], 250, delta=3)
        # From ~500 km up, 250 km aside is about 26° off straight down
        # (a little less than on a flat Earth, which the curve tilts away).
        h = o["satellite"]["alt_km"]
        self.assertLess(o["off_nadir_deg"], math.degrees(math.atan(250 / h)))
        self.assertGreater(o["off_nadir_deg"], math.degrees(math.atan(250 / h)) - 2)

    def test_a_point_too_far_aside_has_no_pass_then(self):
        t = self.moment(lambda sun: sun > 30)
        ops = watch.find_passes(self.orbit, self.track, still(*self.beside(t, 600)), 400)
        self.assertFalse([o for o in ops if abs(watch._time(o["closest_at"]) - t) < timedelta(minutes=10)])
        wider = watch.find_passes(self.orbit, self.track, still(*self.beside(t, 600)), 700)
        self.assertAlmostEqual(self.nearest(wider, t)["distance_km"], 600, delta=5)

    def test_a_pass_in_the_dark_is_left_out_for_a_daylight_event(self):
        t = self.moment(lambda sun: sun < -20)
        target = self.below(t)
        self.assertLess(sun_elevation(t, *target), -19)
        ops = watch.find_passes(self.orbit, self.track, still(*target), 400)
        self.assertFalse([o for o in ops if abs(watch._time(o["closest_at"]) - t) < timedelta(minutes=10)])
        for o in ops:  # whatever passes it does keep are lit
            self.assertGreaterEqual(o["sun_elevation_deg"], watch.DAY_SUN_MIN)

    def test_an_iceberg_stays_at_its_last_reported_position(self):
        t = self.moment(lambda sun: sun > 30)
        lat, lon = self.below(t)
        berg = Event(id="b", title="Iceberg", category="ice", sources=[], updated_at=NOW,
                     fixes=[(NOW - timedelta(days=14), lat + 0.5, lon), (NOW - timedelta(days=7), lat, lon)])
        o = self.nearest(watch.find_passes(self.orbit, self.track, berg, 400), t)
        self.assertLessEqual(o["distance_km"], 1)
        self.assertIsNone(o["target"]["basis"])

    def test_passes_are_ranked_best_first(self):
        t = self.moment(lambda sun: sun > 30)
        ops = watch.find_passes(self.orbit, self.track, still(*self.beside(t, 100), category="ice"), 400)
        self.assertEqual([o["quality"] for o in ops], sorted((o["quality"] for o in ops), reverse=True))

    def test_aurora_counts_dark_oval_crossings_while_kp_is_high(self):
        kp = [(NOW + timedelta(hours=h), 6.0 if 3 <= h < 9 else 2.0, "predicted") for h in range(0, 12, 3)]
        north = Event(id="a", title="Northern lights", category="aurora", sources=[], fixes=[], updated_at=NOW, hemisphere=1)
        ops = watch.find_aurora_passes(self.orbit, self.track, north, kp, 4.0)
        self.assertTrue(ops)
        for o in ops:
            t = watch._time(o["closest_at"])
            self.assertTrue(NOW + timedelta(hours=3) <= t < NOW + timedelta(hours=9))
            self.assertEqual(o["kp"], 6.0)
            self.assertLessEqual(o["sun_elevation_deg"], watch.DARK_SUN_MAX)
            self.assertGreaterEqual(o["magnetic_latitude_deg"], watch.oval_edge(6.0) - 0.5)
            self.assertGreater(o["target"]["lat"], 30)


class Motion(unittest.TestCase):
    def place(self, fixes, *hours):
        s = np.array([h * 3600.0 for h in hours])  # seconds after NOW
        return [latlon(v) for v in watch._target(fixes, watch._path(fixes), NOW, s)]

    def test_a_storm_is_carried_along_its_recent_track_then_held(self):
        t1 = NOW - timedelta(hours=1)
        fixes = [(t1 - timedelta(hours=24), 0.0, 140.0), (t1 - timedelta(hours=12), 0.0, 142.5), (t1, 0.0, 145.0)]
        (lat0, lon0), (lat1, lon1), (lat2, lon2) = self.place(fixes, 0, 11, 100)
        self.assertAlmostEqual(lon0, 145.0 + 5 / 24, places=3)  # an hour after the last fix, at 5° a day
        self.assertAlmostEqual(lon1, 145.0 + 5 * 12 / 24, places=3)
        self.assertAlmostEqual(lon2, 145.0 + 5 * watch.PROJECT_HOURS / 24, places=3)  # held after PROJECT_HOURS
        self.assertTrue(all(abs(x) < 1e-6 for x in (lat0, lat1, lat2)))

    def test_a_forecast_track_is_followed_between_its_points(self):
        # Reported moving east, forecast to turn north.
        fixes = [(NOW - timedelta(hours=12), 10.0, 130.0), (NOW, 10.0, 132.0),
                 (NOW + timedelta(hours=12), 12.0, 132.0), (NOW + timedelta(hours=24), 14.0, 132.0)]
        (lat_a, lon_a), (lat_b, lon_b) = self.place(fixes, 6, 18)
        self.assertAlmostEqual(lon_a, 132.0, places=2)
        self.assertAlmostEqual(lat_a, 11.0, places=2)
        self.assertAlmostEqual(lat_b, 13.0, places=2)
        # and before the first fix it's where it was first reported
        ((lat_c, lon_c),) = self.place(fixes, -20)
        self.assertEqual((round(lat_c, 6), round(lon_c, 6)), (10.0, 130.0))

    def test_no_passes_long_after_a_storms_last_known_position(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        orbit = Orbit(write_tle(Path(tmp.name)))
        track = watch.sample(orbit, NOW, NOW + timedelta(days=3))
        t1 = NOW - timedelta(hours=1)
        storm = Event(id="s", title="Storm", category="storm", sources=[], updated_at=t1,
                      fixes=[(t1 - timedelta(hours=24), -20.0, 60.0), (t1, -20.5, 59.0)])
        ops = watch.find_passes(orbit, track, storm, 2000)  # wide enough to catch a pass every few orbits
        self.assertTrue(ops)
        for o in ops:
            self.assertLessEqual(watch._time(o["closest_at"]), t1 + timedelta(hours=watch.PROJECT_HOURS))
            self.assertEqual(o["target"]["basis"], "extrapolated")

    def test_a_single_fix_doesnt_move(self):
        self.assertIsNone(watch._path([(NOW, 10.0, 20.0)]))
        self.assertIsNone(watch._path([(NOW - timedelta(days=1), 10.0, 20.0), (NOW, 10.0, 20.0)]))


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeFeeds:
    """Answers each feed URL from the saved responses; `down` lists feed
    keys whose URLs fail, `broken` ones that answer in the wrong shape."""

    def __init__(self, down=(), broken=()):
        self.down, self.broken, self.calls = set(down), set(broken), []
        self.files = {
            watch.EONET.parts["events"]: "eonet.json",
            watch.GDACS.parts["TC"]: "gdacs_TC.json",
            watch.GDACS.parts["FL"]: "gdacs_FL.json",
            watch.GDACS.parts["VO"]: None,  # nothing current: GDACS answers 404
            watch.GDACS.parts["WF"]: "gdacs_WF.json",
            watch.SWPC.parts["kp"]: "kp.json",
            watch.SWPC.parts["ovation"]: "ovation.json",
        }

    def __call__(self, url):
        self.calls.append(url)
        key = next(f.key for f in watch.FEEDS if url in f.parts.values())
        if key in self.down:
            raise urllib.error.URLError("timed out")
        if key in self.broken:
            return {"message": "Service temporarily unavailable"}
        name = self.files[url]
        if name is None:
            raise urllib.error.HTTPError(url, 404, "Not Found", Message(), None)
        return fixture(name)


class NoPlaces:
    def name(self, lat, lon):
        return None

    def save(self):
        pass


def quiet(*_args):
    pass


class Feeds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cache, self.out = root / "watch", root / "site" / "watchlist.json"
        self.tle = write_tle(root)
        self.orbit = Orbit(self.tle)

    def tearDown(self):
        self.tmp.cleanup()

    def load(self, get, now=NOW):
        return [watch.load_feed(f, self.cache, now, get=get, log=quiet) for f in watch.FEEDS]

    def run_watch(self, get, now=NOW):
        code = watch.run(self.cache, self.out, self.tle, log=quiet, now=now, get=get, places=NoPlaces())
        self.assertEqual(code, 0)
        return json.loads(self.out.read_text(encoding="utf-8"))

    def test_events_from_the_saved_responses(self):
        payload = watch.build_watchlist(self.load(FakeFeeds()), self.orbit, NOW)
        by_title = {e["title"]: e for e in payload["events"]}
        # EONET and GDACS both list In-fa: one entry with both links and EONET's track.
        self.assertIn("Super Typhoon In-fa", by_title)
        self.assertNotIn("Tropical cyclone In-fa", by_title)
        infa = by_title["Super Typhoon In-fa"]
        self.assertEqual({"NASA EONET", "GDACS"}, {s["name"] for s in infa["sources"]} & {"NASA EONET", "GDACS"})
        self.assertTrue(infa["moving"])
        self.assertEqual(infa["size"], "Winds up to 241 km/h")
        self.assertTrue(infa["forecast"])  # GDACS's forecast positions, followed for its passes
        self.assertEqual({o["target"]["basis"] for o in infa["opportunities"]} - {"forecast"}, set())
        # Left out: a storm with no fix for days, a prescribed burn, fires under the size limit.
        self.assertNotIn("Tropical Storm Olana", by_title)
        self.assertFalse([t for t in by_title if t.startswith(("Prescribed", "Wildfire South Tank"))])
        self.assertNotIn("Forest fires in Niger", by_title)
        # GDACS's three neighbouring Malawi fire areas are one entry.
        malawi = [e for e in payload["events"] if e["title"] == "Forest fires in Malawi"]
        self.assertEqual(len(malawi), 1)
        self.assertIn("in 3 areas", malawi[0]["size"])
        self.assertEqual(len([e for e in payload["events"] if e["category"] == "flood"]), 1)
        self.assertIn("Iceberg B52", by_title)
        # Kp 5 is forecast in the window, over the list's Kp 4.
        self.assertEqual(payload["aurora"]["max_kp"], 5.0)
        self.assertEqual({"Northern lights", "Southern lights"}, {e["title"] for e in payload["events"] if e["category"] == "aurora"})

        self.assertEqual(payload["window"], {"from": "2026-10-30T05:00:00Z", "to": "2026-11-02T05:00:00Z"})
        self.assertEqual([s["status"] for s in payload["sources"]], ["ok", "ok", "ok"])
        nexts = [e["next_at"] for e in payload["events"] if e["next_at"]]
        self.assertEqual(nexts, sorted(nexts))
        for e in payload["events"]:
            ops = e["opportunities"]
            self.assertEqual([o["quality"] for o in ops], sorted((o["quality"] for o in ops), reverse=True))
            for o in ops:
                if e["light"] == "day":
                    self.assertLessEqual(o["distance_km"], 400)
                    self.assertGreaterEqual(o["sun_elevation_deg"], watch.DAY_SUN_MIN)
                else:
                    self.assertLessEqual(o["sun_elevation_deg"], watch.DARK_SUN_MAX)
                self.assertTrue(o["closest_at_calgary"].endswith("-06:00"))  # Alberta Time, all year
                self.assertEqual(o["calgary_zone"], "ABT")

    def test_a_feed_that_is_down_keeps_its_last_good_answer(self):
        first = self.run_watch(FakeFeeds())
        gdacs_titles = {e["title"] for e in first["events"] if any(s["name"] == "GDACS" for s in e["sources"])}
        later = NOW + timedelta(hours=2)
        payload = self.run_watch(FakeFeeds(down={"gdacs"}), now=later)
        status = {s["id"]: s for s in payload["sources"]}
        self.assertEqual(status["gdacs"]["status"], "stale")
        self.assertEqual(status["gdacs"]["fetched_at"], "2026-10-30T05:00:00Z")
        self.assertIn("couldn't connect", status["gdacs"]["error"])
        self.assertEqual((status["eonet"]["status"], status["eonet"]["fetched_at"]), ("ok", "2026-10-30T07:00:00Z"))
        titles = {e["title"] for e in payload["events"]}
        self.assertLessEqual(gdacs_titles, titles)  # still listed, from the cached answer

    def test_a_feed_down_with_nothing_cached_leaves_only_its_events_out(self):
        payload = self.run_watch(FakeFeeds(down={"gdacs"}))
        status = {s["id"]: s for s in payload["sources"]}
        self.assertEqual(status["gdacs"]["status"], "down")
        self.assertIsNone(status["gdacs"]["fetched_at"])
        self.assertEqual(status["gdacs"]["events"], 0)
        titles = {e["title"] for e in payload["events"]}
        self.assertNotIn("Forest fires in Malawi", titles)
        self.assertIn("Super Typhoon In-fa", titles)  # from EONET alone now
        self.assertIn("Northern lights", titles)

    def test_every_feed_down_still_writes_a_list(self):
        payload = self.run_watch(FakeFeeds(down={"eonet", "gdacs", "swpc"}))
        self.assertEqual(payload["events"], [])
        self.assertIsNone(payload["aurora"])
        self.assertEqual({s["status"] for s in payload["sources"]}, {"down"})

    def test_an_answer_in_the_wrong_shape_doesnt_replace_the_good_one(self):
        self.load(FakeFeeds())
        before = (self.cache / "eonet.json").read_bytes()
        loaded = self.load(FakeFeeds(broken={"eonet"}), now=NOW + timedelta(hours=2))
        self.assertEqual(loaded[0].status, "stale")
        self.assertIn("KeyError", loaded[0].error)
        self.assertEqual((self.cache / "eonet.json").read_bytes(), before)

    def test_feeds_are_fetched_at_most_hourly(self):
        get = FakeFeeds()
        self.load(get)
        self.assertEqual(len(get.calls), 7)
        self.load(get, now=NOW + timedelta(minutes=30))
        self.assertEqual(len(get.calls), 7)
        self.load(get, now=NOW + timedelta(minutes=60))
        self.assertEqual(len(get.calls), 14)

    def test_offline_uses_the_cache_however_old(self):
        self.load(FakeFeeds())
        loaded = [watch.load_feed(f, self.cache, NOW + timedelta(days=2), online=False, log=quiet) for f in watch.FEEDS]
        self.assertEqual([x.status for x in loaded], ["stale"] * 3)
        self.assertTrue(all(x.parts for x in loaded))

    def test_a_run_within_the_hour_writes_the_same_file(self):
        self.run_watch(FakeFeeds())
        first = self.out.read_bytes()
        self.run_watch(FakeFeeds(), now=NOW + timedelta(minutes=20))
        self.assertEqual(self.out.read_bytes(), first)
        self.assertEqual((self.cache / "watchlist.json").read_bytes(), first)

    def test_no_orbit_no_list(self):
        code = watch.run(self.cache, self.out, self.tle.with_name("missing.parquet"), log=quiet, now=NOW,
                         get=FakeFeeds(), places=NoPlaces())
        self.assertEqual(code, 2)
        self.assertFalse(self.out.exists())


class Parsing(unittest.TestCase):
    def test_gdacs_cyclone_track_comes_from_its_labelled_circles(self):
        events = watch.gdacs_events({"TC": fixture("gdacs_TC.json")}, NOW, Params())
        (infa,) = events
        self.assertEqual(infa.title, "Tropical cyclone In-fa")
        times = [f[0] for f in infa.fixes]
        self.assertEqual(times, sorted(times))
        # Reported up to GDACS's "todate"; the circles after it are the forecast.
        self.assertEqual(infa.reported_at, datetime(2026, 10, 30, 0, 0, tzinfo=UTC))
        self.assertEqual(watch._position(infa.fixes, infa.reported_at), (17.8, 147.8))
        self.assertTrue([t for t in times if t < infa.reported_at])
        self.assertGreater(times[-1], NOW + timedelta(days=2))

    def test_kp_and_ovation(self):
        rows = watch.kp_series(fixture("kp.json"))
        self.assertEqual(rows[0][0], datetime(2026, 10, 23, tzinfo=UTC))
        self.assertEqual(max(r[1] for r in rows), 5.0)
        summary = watch.ovation_summary(fixture("ovation.json"))
        self.assertEqual(summary["forecast_at"], "2026-10-30T06:09:00Z")
        self.assertGreaterEqual(summary["north_max_pct"], 0)
        with self.assertRaises(ValueError):
            watch.kp_series([])

    def test_quiet_aurora_is_noted_not_listed(self):
        kp = [dict(r, kp=min(r["kp"], 3.0)) for r in fixture("kp.json")]
        events, summary, _ = watch.aurora_events({"kp": kp, "ovation": fixture("ovation.json")}, NOW, NOW + timedelta(days=3), Params())
        self.assertEqual(events, [])
        self.assertEqual((summary["max_kp"], summary["threshold_kp"]), (3.0, 4.0))

    def test_sizes_have_no_comma_in_their_numbers(self):
        # a comma is a decimal point across much of Europe
        self.assertEqual(watch._size("wildfire", 12567.0, "ha"), "12 567 hectares burnt")
        self.assertEqual(watch._size("storm", 700, "NM^2"), "About 2 401 km²")
        self.assertEqual(watch._size("wildfire", 900.0, "ha"), "900 hectares burnt")


if __name__ == "__main__":
    unittest.main()
