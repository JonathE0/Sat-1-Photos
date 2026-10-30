# CTS-SAT-1 picture archive

Every picture CTS-SAT-1 (FrontierSat, NORAD 69015) has sent down since its
launch on 3 May 2026, rebuilt from the radio packets, with where and when each
was taken, an orbit globe, and room for team members to add what they know.

CTS-SAT-1 is Calgary To Space's first student-built satellite, a 3U CubeSat
from the University of Calgary. Its packets are heard by the SatNOGS network
of amateur ground stations and decoded by the team's ground-station pipeline;
this project takes it from there.

## Quick start (Windows)

Needs Python 3.11 or newer (check with `python --version`). Ubuntu 22.04's
`python3` (3.10) and the macOS Command Line Tools `python3` (3.9) are too old.

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m cts1_gallery update     # sync packets, rebuild pictures and site data
.venv\Scripts\python.exe serve.py                   # then open http://127.0.0.1:8000
```

On macOS/Linux create the venv with a 3.11+ interpreter, e.g.
`python3.12 -m venv .venv`, and use `.venv/bin/python` instead.

`update` is incremental and safe to repeat: with nothing new it finishes in
about two seconds. It does not take the scheduler's lock, though, so once the
task below is installed, run `.venv\Scripts\python.exe scripts\scheduled_update.py`
by hand instead; it takes the lock and logs to `data/logs/update.log`. To
have Windows run it every 30 minutes, with no AI or person in the loop:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
```

See [docs/SCHEDULING.md](docs/SCHEDULING.md) for intervals, logs, removal, and
cron/systemd equivalents.

## Tests

```powershell
.venv\Scripts\python.exe -m unittest -v          # pipeline, sync and server tests
node site/globe/fixtures/verify.mjs              # globe orbit/astro checks against Python sgp4
```

The globe's reference values are regenerated with
`site/globe/fixtures/make_reference.py`.

## What's on the site

- **Opening screen**: the title over a starfield, one picture that stays
  still (`heroPicture` in `site/config.js`) and a slideshow of the most
  detailed main-camera frames, each sliding in from the side, panning slowly
  and fading out. With the system's reduced-motion setting on, the slideshow
  crossfades instead. It can be paused, and pauses while hovered or focused.
- **Pictures**: every downlinked image, newest first, filterable by camera,
  status, month, member and tag.
- **Each picture**:
  - when it was taken (UTC and Calgary time), and what that time rests on
  - where the satellite was, and whether the ground below and the satellite
    were in sunlight
  - how and when the picture came down, and whether it matches the
    satellite's own checksum
- **Orbit** (`site/globe/`): a 3D globe with real day/night lighting and
  Earth rotation, the satellite's live position and track, a pin for every
  picture with a known capture time (date-only pictures are listed but not
  placed), and the next passes over Calgary.
- **Member edits**: when the site runs under `serve.py`, members can retitle a
  picture, add notes, a place, tags and their name, or correct its time and
  position. Edits are kept in `site/data/annotations.json` with a full history.

## How the pictures are rebuilt

Files come down as bulk-downlink packets of up to ~195 bytes, each tagged with
a byte offset but not with a file name. `cts1_gallery`:

1. **Syncs** the team pipeline's decoded-packet tables from
   [frontiersat.mooo.com](https://frontiersat.mooo.com). It range-requests
   only the parquet row groups and columns that changed, so a routine sync
   moves about 2 MB, not 100 MB. See [`fetch.py`](cts1_gallery/fetch.py).
2. **Finds every image file**, from the descriptors the satellite sends
   before a download, its own log lines ("download started", "download
   complete", "opened image file"), its directory listings, and the packet
   contents themselves. A picture whose name never reached the ground still
   turns up.
3. **Attributes packets to files** (see [`reassemble.py`](cts1_gallery/reassemble.py)):
   - Main-camera (PiCAM) files are hex text in 67-byte lines that each name
     their own line number and the picture's line total. That makes any
     packet self-locating ([`picam.py`](cts1_gallery/picam.py)), however
     downloads overlap.
   - Attitude-camera BMPs are attributed by download windows.
4. **Votes byte by byte** across every copy received, then checks the result
   against the sha256 the satellite reported.
5. **Renders**:
   - A complete JPEG is used exactly as sent.
   - A partial main-camera JPEG is shown down to its first missing line,
     since its JPEGs have no restart markers.
   - Missing BMP rows show as grey.
   - A header that never arrived is restored from the header every complete
     capture shares, but only where the bytes that did arrive agree with it.

Each picture gets a status:

| Status | Meaning |
|---|---|
| `verified` | bit-exact; matches the satellite's checksum |
| `complete` | the whole picture arrived, but the file can't be hash-checked |
| `partial` | part of the picture never arrived |
| `truncated` | the capture was cut short on board (the shortened file can still be bit-exact) |

**Capture time** comes from the file name when it carries one, else the
camera's log line, the capture command's own record, the attitude camera's
file list, or the capture command's reply; otherwise only the date is known,
and members can fill in the rest. Most of these are readings of the
satellite's clock, which has run up to a couple of minutes fast; they are
corrected by how far off it was, measured from its log stamps and beacons
against when the ground heard them ([`capture.py`](cts1_gallery/capture.py)).

**Position** is propagated with SGP4 from the most recent TLE before the
capture. **Place names** come from OpenStreetMap's Nominatim: one cached
lookup per position, sending coordinates only.

The data files are described in [docs/DATA.md](docs/DATA.md).

## Layout

```
cts1_gallery/        the update tool: fetch, reassemble, capture times, orbit, build
scripts/             scheduled_update.py and the Task Scheduler installer
serve.py             web server for the site and the member-edit API
site/                the website (static; images and data are generated and committed)
  data/              images.json, tle.json, annotations.json
  images/            rendered pictures and thumbnails
  globe/             the orbit globe
docs/                DATA.md (file formats), SCHEDULING.md
.github/workflows/   publish.yml: scheduled update and GitHub Pages deploy
data/                local cache and logs (not committed)
```

## Publishing

`site/` is a plain static site, so it can be published as is. On a static
host, member edits are read-only.

On GitHub, [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
does it for you. Every 30 minutes, and on every push to `main`, it runs the
same `update` as the local schedule, commits any new pictures and site data
back to the repository, and publishes `site/` to GitHub Pages. To turn it on,
set Settings > Pages > Source to "GitHub Actions". The data cache is kept
between runs with `actions/cache`, so a routine run fetches about 1 MB.
GitHub may pause scheduled workflows in a repository with no activity for
60 days; the Actions tab has a button to turn it back on.

With that workflow running, turn the local schedule off
(`scripts\install-schedule.ps1 -Uninstall`) and `git pull` before committing:
both would otherwise rewrite the same generated files. Set `repoUrl` in
`site/config.js` to the repository's URL so public visitors get a "Suggest a
correction" link that opens a GitHub issue. Elsewhere, a static copy is only
as current as its last push, so set `refreshMinutes` to match (0 if it isn't
refreshed on a schedule; the footer then makes no promise).

To accept edits, run `serve.py` on a machine the team can reach, listening on
the network and with an edit key:

```powershell
.venv\Scripts\python.exe serve.py --host 0.0.0.0 --port 8000 --edit-key <key>
```

(or set `GALLERY_EDIT_KEY` instead of `--edit-key`). The default host,
127.0.0.1, accepts connections only from the same machine; keep it when a
reverse proxy on that machine provides HTTPS, which you need if the server is
public. Windows may ask to let Python through the firewall. With open edits
(no key), `serve.py` only accepts edits addressed to `localhost` or an IP
address; add `--allow-host NAME` to use another name, or set an edit key.

## Credits

- Packets, decoding and on-board formats: the
  [CalgaryToSpace](https://github.com/CalgaryToSpace) team's ground-station
  pipeline and flight software.
- Reception: the [SatNOGS](https://satnogs.org) network, run by the Libre
  Space Foundation, and its volunteer station operators.
- Orbital elements: Space-Track.org, via the team pipeline.
- Place names: © OpenStreetMap contributors, via Nominatim.
- Globe imagery: NASA Blue Marble and Black Marble (see `site/globe/textures/`).
- Logo and CubeSat icon (`site/assets/`): CalgaryToSpace, from
  [calgarytospace.ca](https://www.calgarytospace.ca/).

## Licence

The code is under the MIT licence; see [LICENSE](LICENSE). The sources above
keep their own terms.
