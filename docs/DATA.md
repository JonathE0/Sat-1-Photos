# Data files

The site is static: everything it shows comes from four JSON files in
`site/data/`, plus member edits served by `serve.py`.

| File | Written by | Committed |
|---|---|---|
| `site/data/images.json` | `python -m cts1_gallery update` | yes |
| `site/data/tle.json` | `python -m cts1_gallery update` | yes |
| `site/data/annotations.json` | `serve.py`, when members save edits | yes |
| `site/data/watchlist.json` | `python -m cts1_gallery watch` | no: each publish run writes it |
| `site/images/*.jpg` (main camera), `site/images/*.png` (attitude camera), `site/images/thumbs/*.jpg` | `python -m cts1_gallery update` | yes |

## `images.json`

```jsonc
{
  "generated_at": "2026-10-29T10:30:00Z",  // when the picture list last changed (a run with nothing new keeps it)
  "satellite": {
    "name": "CTS-SAT-1",
    "alias": "FrontierSat",
    "norad_id": 69015,
    "launched_at": "2026-05-03T06:59:00Z"
  },
  "images": [
    {
      "id": "2026-09-17-071148z",           // URL-safe, unique, stable across rebuilds (two names
                                             // that slug alike: the later-downlinked one gets a suffix)
      "file": "camera/2026-09-17_071148Z.img", // path on the satellite; a file name the camera reused
                                             // for a new capture keeps it for the newest, and earlier
                                             // ones become "camera/<name>.earlier-1.img", ...
      "camera": "picam",                     // "picam" (main camera) or "adcs" (attitude camera)
      "title": "17 Sep 2026, 07:11 UTC",     // default title; members can override
      "src": "images/2026-09-17-071148z.jpg",       // relative to site/; .jpg for picam, .png for adcs
      "thumb": "images/thumbs/2026-09-17-071148z.jpg",
      "width": 640,
      "height": 480,

      "status": "verified",       // verified | complete | partial | truncated
      "status_note": "Bit-exact: matches the sha256 the satellite sent.",
      "completeness": 1.0,        // share of the picture that can be shown, 0..1
      "dark": false,              // nothing to see: nearly black with at most one bright spot
                                  // (empty frame, sensor noise, the Sun as a dot); the gallery
                                  // tucks these away. Night frames with city lights are false.
      "unnamed": false,           // true when the file's name never reached the ground
      "file_size": 42087,         // bytes of the on-board file
      "sha256": "…",              // of the reassembled file
      "sha256_expected": "…",     // from the satellite, or null; if it reported several for this
                                  // path, the one that matches, else one of them

      "captured_at": "2026-09-17T07:11:05Z", // UTC to the second, or null when unknown
      "capture_date": "2026-09-17",           // UTC date, or null
      "capture_basis": "filename",            // filename | capture log | capture record | ADCS file list
                                              // | capture reply | date only | unknown
      "satellite_clock": { "correction_s": -42.2 }, // see below; null when captured_at isn't
                                                     // a reading of an on-board clock

      "downlink": {
        "first": "2026-09-17T08:25:41Z",
        "last": "2026-09-20T02:37:00Z",
        "packets": 985
      },

      "position": {               // null when captured_at is null
        "lat": 51.05,
        "lon": -114.07,
        "alt_km": 498.1,
        "place": "Alberta, Canada", // OpenStreetMap name, else a rough sea or ocean name (or
                                    // "Antarctica"); null between 63 and 79 S, where the rough
                                    // map can't tell ice from sea, or before an online lookup
        "ground_sunlit": true,    // sun above the horizon at the point below
        "sun_elevation_deg": 23.4,
        "satellite_sunlit": true, // satellite outside Earth's shadow
        "satellite_light": "sunlit", // sunlit | terminator (sun on Earth's limb) | shadow
        "sun_above_limb_deg": 12.3,  // seen from the satellite; negative = behind Earth
        "tle_epoch": "2026-09-16T21:44:00Z",
        "basis": "SGP4 from the most recent TLE before capture"
      }
    }
  ],
  "skipped": [                    // image files that can't be shown, and why
    { "file": "camera/2026-07-04_cam.img",
      "reason": "the capture failed on board: the file holds no picture" },
    { "file": "camera/2026-10-23.img",
      "reason": "the satellite refused the download: no such file on board" }
  ]
}
```

Status values:

- `verified`: every byte received, and the file's sha256 matches the one
  the satellite reported.
- `complete`: the whole picture was received, but the file can't be
  hash-checked (no hash reported, or a few non-image bytes missing).
- `partial`: some of the picture never arrived. Main-camera JPEGs can't be
  decoded past a gap, so they are shown down to the first missing line and
  grey below it; attitude-camera BMPs show grey bands where rows are missing.
- `truncated`: the satellite stored only part of the frame (the capture was
  cut short on board), so the top of the image is all there is. Such a record
  can still match `sha256_expected`: the check is against the shortened file
  the satellite actually holds, and the status note says so.

Capture times. `filename`, `capture log` and `capture record` are readings
of the satellite's own clock (a file name is the time the capture command
was scheduled for), and `ADCS file list` of the attitude camera's. That clock
has run up to a couple of minutes fast when it was last set from the EPS
board's clock. Where the data shows how far off it was (log stamps and
beacon clock readings against when the ground heard them), `captured_at` is
corrected, and `satellite_clock.correction_s` gives the seconds added
(negative when the clock was fast, 0 when it was found right). When nothing
covers that moment, `correction_s` is null and the time is as read: it may be
a minute or so off. `capture reply` is the ground's own receive time.
Positions, light and place names follow `captured_at`.

Images are ordered newest capture first; images without a capture time sort
by their downlink time.

## `tle.json`

An array of `{ "epoch", "line1", "line2" }` (two-line elements, oldest
first), used by the orbit globe.

## `watchlist.json`

Things happening on Earth worth photographing, and CTS-SAT-1's coming passes
over each in the right light. Shown by `site/watchlist/`. Plain scheduled
code (`cts1_gallery/watch.py`), no AI in the loop:

```
python -m cts1_gallery watch               # fetch the feeds (at most hourly) and rebuild
python -m cts1_gallery watch --offline     # rebuild from the cached feed answers
python -m cts1_gallery watch --max-km 300  # a different "close enough" (default 400)
```

The publish workflow runs it after `update`, so passes use the newest TLE.
The file isn't committed: every run writes it into `site/` before the Pages
upload, and a copy is kept in `data/cache/watch/` (with the feed answers)
for the next run to compare against.

**Sources**, all free and keyless, each credited on the page:

| Feed | What it gives | Terms |
|---|---|---|
| [NASA EONET](https://eonet.gsfc.nasa.gov/) v3, open events of the last 30 days | wildfires, storms (with 6-hourly tracks), volcanoes, dust and haze, sea and lake ice, floods, snow, water colour, man-made | NASA; no licence or limit stated, "for visualization and general information purposes". Each event links the agency it came from (JTWC, NHC, US National Ice Center, IRWIN, ...). |
| [GDACS](https://www.gdacs.org/) map feeds, `TC`, `FL`, `VO`, `WF` | tropical cyclones (track and forecast positions), floods, volcanoes, wildfires worldwide | UN and European Commission; RSS marked public domain, EC content CC BY 4.0 with credit. No limit stated. Answers 404 for a type with nothing current. |
| [NOAA SWPC](https://www.swpc.noaa.gov/) 3-day Kp forecast and OVATION nowcast | geomagnetic activity, for aurora | US government, public domain; no endorsement implied. Polled no faster than the data changes. |

Each feed is fetched at most every 55 minutes (the workflow runs every 30)
and its answer cached. A feed that fails, or answers in a shape the parser
doesn't know, keeps its last good answer: its events stay on the list and
the file says how old they are. Only a missing `tle_history.parquet` stops
the run (exit code 2), and the workflow then republishes the last list.

**What's left out**: earthquakes, droughts and heat waves (not visible from
orbit); prescribed burns, and wildfires under 2,000 hectares (20 km²);
storms with no report for 48 hours. GDACS fire areas within 75 km of each
other are one entry. A cyclone in both EONET and GDACS is one entry with
EONET's name and both links.

**Passes**: the gallery's own SGP4 (`orbit.Orbit`, newest TLE), sampled
every 20 s from the start of the current hour (so runs within an hour write
the same file) for `window` (3 days), each pass refined to well under a
second. A pass counts when the point directly below the satellite comes
within `max_km` of the event and the light is right:

- daylight events: the sun at least 5° up at the event;
- aurora: the ground below at least 12° past sunset, while NOAA's forecast
  Kp is at least 4, with the satellite over the auroral oval (magnetic
  latitude, from a tilted dipole, between `66.5 - 2.04 Kp` degrees and 12°
  poleward of that: NOAA's rule of thumb for the oval's edge).

`max_km` is a guess: the camera's footprint isn't documented. A 62° lens
(the Raspberry Pi camera's) would see about 300 km either side of straight
down from 500 km up; 400 km allows for some pointing.

Storms move: their position at a pass is taken along GDACS's forecast track
where there is one, else carried on along the great circle of their last
day, for at most 24 h past the last report or forecast point. Passes later
than that are dropped. Other events stay at their last reported position
(icebergs drift a few km a day).

Accuracy: SGP4 from a TLE a day or two old is good to a few seconds;
older elements drift, by tens of seconds after a few days and a minute or
more after a week (more when solar activity raises drag).

```jsonc
{
  "generated_at": "2026-10-30T05:04:50Z",    // when the content last changed (a run with nothing new keeps it)
  "window": { "from": "2026-10-30T05:00:00Z", "to": "2026-11-02T05:00:00Z" },
  "max_km": 400.0,
  "rules": { "day_sun_min_deg": 5.0, "dark_sun_max_deg": -12.0, "min_fire_ha": 2000.0, "aurora_kp": 4.0 },
  "tle_epoch": "2026-10-27T22:38:42Z",       // the newest TLE, used for every pass
  "sources": [
    { "id": "gdacs", "name": "GDACS", "url": "https://www.gdacs.org/",
      "status": "ok",                         // ok | stale (fetch failed; last good answer used) | down (nothing to show)
      "fetched_at": "2026-10-30T05:04:17Z",   // when that answer was fetched; null when down
      "error": null,                          // why the last fetch failed, e.g. "HTTP 503"
      "events": 7 }                           // events from this feed, before merging
  ],
  "aurora": {                                 // null when SWPC has never answered
    "threshold_kp": 4.0,
    "max_kp": 5.0, "max_kp_at": "2026-10-31T00:00:00Z",  // highest Kp forecast in the window (3-hour slot start)
    "ovation": { "forecast_at": "2026-10-30T06:09:00Z", "north_max_pct": 14, "south_max_pct": 13 }
  },
  "events": [                                 // by next pass (closest_at), then those with none, by title
    {
      "id": "eonet-eonet_25728",              // feed-qualified, stable while the feed lists it
      "title": "Super Typhoon In-fa",
      "category": "storm",                    // storm wildfire volcano flood dust ice water snow manmade aurora
      "light": "day",                         // day | dark (aurora): the light a pass needs
      "where": null,                          // place name when the feed's title lacks one (GDACS fires
                                              // and floods: OpenStreetMap), else null
      "size": "Winds up to 241 km/h",         // or "69,233 hectares burnt in 3 areas", "About 168 km²"
      "alert": "Green",                       // GDACS alert level (Green | Orange | Red) or null
      "lat": 17.8, "lon": 147.8,              // last reported position; null for aurora
      "moving": true,                         // storms with a track: positions at passes are projected
      "track": [ { "at": "2026-10-29T18:00:00Z", "lat": 17.1, "lon": 148.6 } ],    // recent reports (≤ 8)
      "forecast": [ { "at": "2026-10-30T12:00:00Z", "lat": 18.6, "lon": 146.5 } ], // GDACS forecast points
      "reported_at": "2026-10-30T00:00:00Z",  // the last reported (not forecast) position
      "started_at": "2026-10-25T06:00:00Z",
      "updated_at": "2026-10-30T01:52:06Z",   // the feed's last change (aurora: OVATION's observation time)
      "sources": [ { "name": "NASA EONET", "url": "…" }, { "name": "GDACS", "url": "…" } ],
      "next_at": "2026-10-31T00:49:53Z",      // earliest pass in the window (the page drops passes already over)
      "opportunities": [                      // best first (quality), at most 12
        {
          "closest_at": "2026-10-31T00:49:53Z",
          "closest_at_calgary": "2026-10-30T18:49:53-06:00",
          "calgary_zone": "MDT",              // per the IANA tz database (Alberta stays at UTC-6 from 1 Nov 2026)
          "window": { "from": "…", "to": "…" },  // while the point below is within max_km of the event
          "distance_km": 184,                 // event to the point below the satellite, at closest; null for aurora
          "off_nadir_deg": 19.6,              // how far off straight down the event is then; null for aurora
          "target": { "lat": 21.27, "lon": 143.2,  // where the event was taken to be (aurora: the point below)
                      "projected_h": 24.8,    // hours after the last report, for moving events
                      "basis": "forecast" },  // reported | forecast | extrapolated, for moving events; else null
          "satellite": { "lat": 22.6, "lon": 141.4, "alt_km": 503, "light": "sunlit" },  // sunlit | terminator | shadow
          "sun_elevation_deg": 41.2,          // at the target
          "light": "day",                     // day (sun ≥ 15°) | low sun | twilight | night (below -12°)
          "tle_epoch": "2026-10-27T22:38:42Z",
          "tle_age_days": 3.1,                // by the time of the pass
          "accuracy": "fair",                 // good (< 2 days) | fair (< 5) | rough
          "quality": 0.62,                    // 0..1: closeness × light × accuracy (aurora: Kp instead of closeness)
          "kp": 5.0,                          // aurora only: Kp forecast for then
          "magnetic_latitude_deg": 63.2,      // aurora only
          "ground_track": [[20.1, 141.9], …]  // the point below, every 30 s for ±4 min (aurora: across the oval)
        }
      ]
    }
  ]
}
```

## Member edits: `annotations.json` and the API

`serve.py` serves `site/` and stores edits in `site/data/annotations.json`:

```jsonc
{
  "2026-09-17-071148z": {
    "title": "Clouds over Hudson Bay",
    "notes": "First image after the camera baud-rate fix.",
    "people": ["Jordan K."],      // members tagged on the photo
    "tags": ["clouds", "arctic"],
    "captured_at": null,          // set only to override the computed value
    "lat": null, "lon": null,     // likewise
    "place": "Hudson Bay",
    "updated_at": "2026-10-29T10:41:00Z",
    "updated_by": "Jordan K.",
    "history": [
      { "at": "2026-10-29T10:41:00Z", "by": "Jordan K.",
        "changes": { "title": [null, "Clouds over Hudson Bay"] } }
    ]
  }
}
```

API (same origin as the site):

- `GET /api/annotations` returns the whole object above.
- `POST /api/annotations/<id>` with
  `{ "by": "Name", "key": "<edit key, if the server sets one>", "changes": { ... }, "base": { ... } }`
  applies the changes and returns the updated record. Allowed fields:
  `title`, `notes`, `place` (strings, at most 2000 chars); `people`, `tags`
  (lists of short strings); `captured_at` (ISO UTC or null); `lat`, `lon`
  (numbers or null). `by` is required.
- `base` is optional: for fields in `changes`, the values the editor started
  from. If someone else has changed one of them since (to anything but the
  same new value), nothing is saved and the answer is
  `409 { "error": "...", "record": { the stored record } }`. Without `base`,
  the last write wins.
- With open edits (no edit key), `serve.py` only accepts edits addressed to
  `localhost`, an IP address or a name given with `--allow-host`, so a page
  whose name was rebound to the server can't use them.
- On a static host with no `serve.py`, the site reads
  `data/annotations.json` and edits are disabled.
