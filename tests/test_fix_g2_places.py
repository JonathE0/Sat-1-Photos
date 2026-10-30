"""Regression tests for the sea/ocean fallback in cts1_gallery.places.

    .venv\\Scripts\\python.exe -m unittest tests.test_fix_g2_places -v
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cts1_gallery import places

N_PAC, S_PAC = "North Pacific Ocean", "South Pacific Ocean"
N_ATL, S_ATL = "North Atlantic Ocean", "South Atlantic Ocean"
INDIAN = "Indian Ocean"

PROBES = [  # (what, lat, lon, expected)
    # Points the old map named wrongly or vaguely.
    ("Eastern Mediterranean, S of Crete", 34.0, 25.0, "Mediterranean Sea"),
    ("Black Sea", 43.0, 34.0, "Black Sea"),
    ("Sea of Azov", 46.0, 36.5, "Black Sea"),
    ("Caspian Sea", 42.0, 50.5, "Caspian Sea"),
    ("Persian Gulf", 27.0, 51.0, "Persian Gulf"),
    ("Northern Red Sea", 26.5, 35.0, "Red Sea"),
    ("Central Baltic, E of 20 E", 57.5, 20.5, "Baltic Sea"),
    ("Gulf of Bothnia", 62.5, 20.0, "Baltic Sea"),
    ("Gulf of Finland", 59.8, 25.0, "Baltic Sea"),
    ("Central Baltic, W of 20 E", 57.0, 19.0, "Baltic Sea"),  # was North Atlantic: not wrong, but vague
    ("White Sea", 65.0, 37.0, "White Sea"),
    ("Gulf of Oman, off Jask", 25.4, 57.5, INDIAN),
    ("Pacific off Guatemala", 12.0, -92.0, N_PAC),
    ("Pacific off southern Mexico", 14.0, -99.0, N_PAC),
    ("Caribbean off Panama", 9.6, -81.0, N_ATL),
    ("Caribbean off Colombia", 9.6, -76.5, N_ATL),
    ("South China Sea", 14.0, 113.0, N_PAC),
    ("Gulf of Thailand", 10.0, 102.0, N_PAC),
    ("Great Australian Bight", -36.0, 130.0, INDIAN),
    ("Indian Ocean S of Lombok", -9.5, 116.5, INDIAN),
    ("Timor Sea S of Timor", -9.8, 125.8, INDIAN),
    ("Ross Ice Shelf (cached point)", -81.25, -156.38, "Antarctica"),
    ("Antarctic plateau", -85.0, 40.0, "Antarctica"),
    ("East Antarctic coast", -66.0, 110.0, None),
    ("Ross Sea", -74.0, 180.0, None),
    # Neighbouring waters, pinning each boundary from the other side.
    ("Bay of Biscay", 45.5, -4.5, N_ATL),
    ("Gulf of Lion", 42.5, 4.5, "Mediterranean Sea"),
    ("Alboran Sea", 36.0, -3.5, "Mediterranean Sea"),
    ("North Sea", 56.0, 3.0, N_ATL),
    ("Bay of Campeche", 19.6, -95.6, N_ATL),
    ("Gulf of Honduras", 16.0, -87.0, N_ATL),
    ("Gulf of Panama", 8.5, -79.5, N_PAC),
    ("Gulf of California", 27.0, -111.0, N_PAC),
    ("Arabian Sea", 15.0, 65.0, INDIAN),
    ("Gulf of Aden", 12.5, 48.0, INDIAN),
    ("Bay of Bengal", 15.0, 88.0, INDIAN),
    ("Andaman Sea", 11.0, 96.0, INDIAN),
    ("Strait of Malacca", 4.0, 100.0, INDIAN),
    ("Indian Ocean SW of Sumatra", -4.0, 101.0, INDIAN),
    ("Timor Sea", -11.0, 127.0, INDIAN),
    ("Bass Strait", -39.5, 146.0, INDIAN),
    ("Coral Sea", -16.0, 146.5, S_PAC),
    ("Tasman Sea", -38.0, 160.0, S_PAC),
    ("Sea of Japan", 40.0, 135.0, N_PAC),
    ("Gulf of Alaska", 55.0, -145.0, N_PAC),
    ("Gulf of Guinea", 0.0, 3.0, S_ATL),
    ("Drake Passage", -58.0, -65.0, S_ATL),
    ("Southern Ocean at 61 S", -61.0, 100.0, "Southern Ocean"),
    ("Barents Sea", 72.0, 40.0, "Arctic Ocean"),
]


class Ocean(unittest.TestCase):
    def test_probe_points(self):
        for what, lat, lon, expected in PROBES:
            with self.subTest(what, lat=lat, lon=lon):
                self.assertEqual(places.ocean(lat, lon), expected)


class PlacesCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "places.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_legacy_ocean_entries_are_renamed_on_read_and_the_cache_is_left_alone(self):
        text = json.dumps({"34.00,25.00": "North Pacific Ocean", "-81.25,-156.38": "Southern Ocean",
                           "40.84,21.70": "Epirus and Western Macedonia, Greece"}, indent=1, sort_keys=True)
        self.file.write_text(text)
        p = places.Places(self.file, online=False)
        self.assertEqual(p.name(34.0, 25.0), "Mediterranean Sea")
        self.assertEqual(p.name(-81.25, -156.38), "Antarctica")
        self.assertEqual(p.name(40.84, 21.70), "Epirus and Western Macedonia, Greece")
        p.save()
        self.assertEqual(self.file.read_text(), text)

    def test_cached_no_land_is_named_by_the_current_map(self):
        self.file.write_text(json.dumps({"43.00,34.00": None, "-70.00,100.00": None}))
        p = places.Places(self.file, online=False)
        self.assertEqual(p.name(43.0, 34.0), "Black Sea")
        self.assertIsNone(p.name(-70.0, 100.0))

    def test_only_nominatims_answer_is_cached(self):
        p = places.Places(self.file)
        with mock.patch.object(p, "_lookup", return_value=None) as lookup:
            self.assertEqual(p.name(27.0, 51.0), "Persian Gulf")
            self.assertEqual(p.name(27.0, 51.0), "Persian Gulf")
        lookup.assert_called_once()
        p.save()
        self.assertEqual(json.loads(self.file.read_text()), {"27.00,51.00": None})

    def test_land_answer_is_cached_and_returned(self):
        p = places.Places(self.file)
        with mock.patch.object(p, "_lookup", return_value="Cherkasy Oblast, Ukraine"):
            self.assertEqual(p.name(48.92, 30.60), "Cherkasy Oblast, Ukraine")
        p.save()
        self.assertEqual(json.loads(self.file.read_text()), {"48.92,30.60": "Cherkasy Oblast, Ukraine"})

    def test_failed_lookup_is_not_cached(self):
        p = places.Places(self.file)
        with mock.patch.object(p, "_lookup", side_effect=OSError("offline")):
            self.assertIsNone(p.name(27.0, 51.0))
        p.save()
        self.assertFalse(self.file.exists())

    def test_offline_unknown_point_has_no_name(self):
        p = places.Places(self.file, online=False)
        self.assertIsNone(p.name(43.0, 34.0))


if __name__ == "__main__":
    unittest.main()
