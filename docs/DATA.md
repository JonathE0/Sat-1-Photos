# Data files

The site is static: everything it shows comes from three JSON files in
`site/data/`, plus member edits served by `serve.py`.

| File | Written by | Committed |
|---|---|---|
| `site/data/images.json` | `python -m cts1_gallery update` | yes |
| `site/data/tle.json` | `python -m cts1_gallery update` | yes |
| `site/data/annotations.json` | `serve.py`, when members save edits | yes |
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
