"""Turn reassembled files into the site: images, thumbnails, images.json.

Re-running is cheap: an image is re-rendered only when its reassembled bytes
change (or the rendering code does), so a scheduled run with nothing new
does no image work at all.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageFile

from . import capture, picam
from .orbit import Orbit
from .places import Places
from .reassemble import Assembled, reassemble

ImageFile.LOAD_TRUNCATED_IMAGES = True

RENDER_VERSION = 3  # bump to re-render every image after changing how
THUMB_WIDTH = 480
SATELLITE = {
    "name": "CTS-SAT-1",
    "alias": "FrontierSat",
    "norad_id": 69015,
    "launched_at": "2026-05-03T06:59:00Z",
}
_GRAY = 128  # palette index used for BMP pixels that never arrived


@dataclass(slots=True)
class Rendered:
    image: bytes  # what the site shows (.jpg or .png)
    ext: str
    status: str
    note: str
    completeness: float
    repaired_header: bool


def build(paths: dict[str, Path], site: Path, cache_dir: Path, *, log=print, force: bool = False, online: bool = True) -> dict:
    t0 = time.perf_counter()
    result = reassemble(paths["everything_decoded"], paths["reassembled_tcmd_responses"])
    log(f"  reassembled {len(result.files)} image files in {time.perf_counter() - t0:.1f}s")

    jpeg_template = picam.header_template(
        [bytes(d.jpeg) for a in result.files if a.kind == "picam" and a.line_total and (d := _decode(a)).complete]
    )
    bmp_template = _bmp_template([a for a in result.files if a.kind == "adcs" and a.verified])

    images_dir = site / "images"
    (images_dir / "thumbs").mkdir(parents=True, exist_ok=True)
    manifest_path = cache_dir / "render_manifest.json"
    manifest = {} if force else _read_json(manifest_path)
    new_manifest: dict[str, dict] = {}

    captures = capture.assign(
        [
            capture.Clues(a.path, a.first_rx, a.evidence.opens, a.evidence.recorded_at, a.evidence.adcs_listed_at)
            for a in result.files
        ],
        capture.capture_replies(paths["reassembled_tcmd_responses"]),
        capture.SatelliteClock.load(paths["everything_decoded"]),
    )
    orbit = Orbit(paths["tle_history"])
    places = Places(cache_dir / "places.json", online=online)

    ids = _unique_ids(result.files)
    records, skipped, rendered_count = [], [], 0
    for a in result.files:
        image_id = ids[a.path]
        key = _render_key(a, jpeg_template, bmp_template)
        cached = manifest.get(image_id)
        if cached and cached.get("key") == key and (site / cached["src"]).exists() and (site / cached["thumb"]).exists():
            info = cached
        else:
            r = _render(a, jpeg_template, bmp_template)
            if r is None:
                skipped.append({"file": a.path, "reason": _unreadable_reason(a)})
                continue
            info = _write_image(image_id, r, images_dir, site)
            info["key"] = key
            rendered_count += 1
        if "dark" not in info:  # rendered before the flag existed
            with Image.open(site / info["src"]) as im:
                info = {**info, "dark": _is_dark(im)}
        new_manifest[image_id] = info

        cap = captures[a.path]
        captured_at, capture_date, basis = cap.at, cap.day, cap.basis
        if captured_at is not None:
            captured_at = captured_at.replace(microsecond=0)  # one instant for position, captured_at and title
        position = None
        if captured_at is not None:
            s = orbit.state(captured_at)
            position = {
                "lat": round(s.lat, 4),
                "lon": round(s.lon, 4),
                "alt_km": round(s.alt_km, 1),
                "place": places.name(s.lat, s.lon),
                "ground_sunlit": s.ground_sunlit,
                "sun_elevation_deg": round(s.sun_elevation_deg, 1),
                "satellite_sunlit": s.satellite_sunlit,
                "satellite_light": s.satellite_light,
                "sun_above_limb_deg": round(s.sun_above_limb_deg, 1),
                "tle_epoch": _iso(s.tle_epoch),
                "basis": "SGP4 from the most recent TLE before capture",
            }
        sha_expected = sorted(a.evidence.sha256)
        if a.sha256 in a.evidence.sha256:  # several reported: the one this file matches
            sha_expected = [a.sha256]
        records.append(
            {
                "id": image_id,
                "file": a.path,
                "camera": "adcs" if a.kind == "adcs" else "picam",
                "title": _title(a, captured_at, capture_date),
                "src": info["src"],
                "thumb": info["thumb"],
                "width": info["width"],
                "height": info["height"],
                "status": info["status"],
                "status_note": info["note"],
                "completeness": info["completeness"],
                "dark": info["dark"],
                "file_size": a.size,
                "sha256": a.sha256,
                "sha256_expected": sha_expected[-1] if sha_expected else None,
                "captured_at": _iso(captured_at),
                "capture_date": capture_date.isoformat() if capture_date else None,
                "capture_basis": basis,
                "satellite_clock": {"correction_s": cap.correction_s} if cap.on_board_clock and captured_at else None,
                "downlink": {"first": _iso(a.first_rx), "last": _iso(a.last_rx), "packets": a.packets},
                "position": position,
                "unnamed": a.unnamed,
            }
        )
    places.save()

    received = {a.path for a in result.files}
    for path, e in sorted(result.evidence.items()):
        if path not in received and (e.starts or e.refused):
            skipped.append({"file": path, "reason": _never_received_reason(e)})

    records.sort(key=_sort_key, reverse=True)
    doc = {
        "generated_at": _iso(datetime.now(UTC)),
        "satellite": SATELLITE,
        "images": records,
        "skipped": skipped,
    }
    images_path = site / "data" / "images.json"
    previous = _read_json(images_path)
    if previous.get("generated_at") and json.loads(json.dumps({**doc, "generated_at": None})) == {**previous, "generated_at": None}:
        doc["generated_at"] = previous["generated_at"]  # nothing changed: keep the file byte-identical
    _write_json(images_path, doc)
    _write_json(manifest_path, new_manifest)
    _prune(images_dir, {r["src"] for r in records} | {r["thumb"] for r in records}, site)

    tle_count = _write_tle(paths["tle_history"], site / "data" / "tle.json", log)
    counts = Counter(r["status"] for r in records)
    log(
        f"  {len(records)} pictures ({', '.join(f'{n} {s}' for s, n in counts.most_common())}), "
        f"{len(skipped)} skipped, {rendered_count} rendered, {tle_count} TLEs, "
        f"{time.perf_counter() - t0:.1f}s"
    )
    return doc


# -- rendering -----------------------------------------------------------------


def _decode(a: Assembled) -> picam.DecodedPicam:
    return picam.decode(a.data, a.line_total, a.have.astype(np.uint8).tobytes())


def _render(a: Assembled, jpeg_template: bytes | None, bmp_template: bytes | None) -> Rendered | None:
    if a.kind == "picam":
        return _render_picam(a, jpeg_template) if a.line_total else None
    return _render_bmp(a, bmp_template)


def _render_picam(a: Assembled, template: bytes | None) -> Rendered | None:
    d = _decode(a)
    jpeg, repaired = picam.displayable(d, template)
    if jpeg is None:
        return None
    # The share of the picture a viewer gets: everything when complete,
    # otherwise the lines before the first gap (the decoder stops there).
    gap = d.first_missing(from_byte=len(template) if template else 0)
    share = 1.0 if gap is None else gap / d.line_total
    if d.truncated_on_board:
        # Checked before `verified`: a shortened file can match the sha256 the
        # satellite sent for it and still hold only part of the picture.
        status = "truncated"
        held = d.in_sequence if d.in_sequence is not None else d.stored_lines
        note = (
            f"The capture was cut short on board: the file holds only lines 0–{max(held - 1, 0)} of the "
            f"{d.line_total} the camera announced"
        )
        if d.skips_to is not None:
            note += f" (then it skips to line {d.skips_to})"
        note += (
            ". This copy is bit-exact: it matches the sha256 the satellite sent."
            if a.verified
            else f", and {len(d.lines)} of those arrived."
        )
    elif a.verified:
        status, note = "verified", "Bit-exact: matches the sha256 the satellite sent."
    elif d.complete:
        status = "complete"
        note = (
            "Every line of the picture arrived, but a few bytes outside it did not, so the file can't be hash-checked."
            if a.evidence.sha256
            else "Every line of the picture arrived. The satellite never sent a hash for this file."
        )
    else:
        status = "partial"
        note = (
            f"{len(d.lines)} of {d.line_total} lines arrived, but line {gap} did not, and the camera's "
            "JPEGs can't be decoded past a gap: the picture is shown down to it."
        )
    if repaired:
        note += " The JPEG header was restored from the camera's standard header, which every complete capture shares."
    if status in ("verified", "complete"):
        return Rendered(jpeg, "jpg", status, note, share, repaired)
    with Image.open(io.BytesIO(jpeg)) as im:
        im.load()
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=92)
    return Rendered(buf.getvalue(), "jpg", status, note, share, repaired)


def _bmp_template(verified: list[Assembled]) -> bytes | None:
    """The header + palette every verified attitude-camera BMP shares."""
    heads = Counter()
    for a in verified:
        offset = int.from_bytes(a.data[10:14], "little")
        if 54 <= offset <= 4096:
            heads[a.data[:offset]] += 1
    return heads.most_common(1)[0][0] if heads else None


def _render_bmp(a: Assembled, template: bytes | None) -> Rendered | None:
    data = np.frombuffer(a.data, dtype=np.uint8).copy()
    have = a.have
    repaired = False
    head_len = len(template) if template else 54
    if not have[:head_len].all():
        if template is None or a.size != _template_size(template, a.size):
            return None
        known = have[:head_len]
        if (data[:head_len][known] != np.frombuffer(template, dtype=np.uint8)[known]).any():
            return None  # a different header: don't guess
        data[:head_len] = np.frombuffer(template, dtype=np.uint8)
        repaired = True
    pixels = have[head_len:]
    data[head_len:][~pixels] = _GRAY
    share = float(pixels.mean()) if len(pixels) else 0.0
    try:
        with Image.open(io.BytesIO(data.tobytes())) as im:
            im.load()
            buf = io.BytesIO()
            im.convert("L").save(buf, "PNG", optimize=True)
    except Exception:  # noqa: BLE001
        return None
    if a.verified:
        status, note = "verified", "Bit-exact: matches the sha256 the satellite sent."
    elif share >= 1.0:
        status, note = "complete", "Every pixel arrived; the file couldn't be hash-checked."
    else:
        status, note = "partial", f"{share:.0%} of the picture arrived; the grey bands never did."
    if repaired:
        note += " The file header was restored from another attitude-camera frame (the format is identical)."
    return Rendered(buf.getvalue(), "png", status, note, share, repaired)


def _template_size(template: bytes, fallback: int) -> int:
    """File size implied by a BMP header (its own size field isn't reliable)."""
    width = int.from_bytes(template[18:22], "little")
    height = abs(int.from_bytes(template[22:26], "little", signed=True))
    bpp = int.from_bytes(template[28:30], "little")
    if not (width and height and bpp):
        return fallback
    row = (width * bpp + 31) // 32 * 4
    return len(template) + row * height


def _unreadable_reason(a: Assembled) -> str:
    if a.kind == "picam" and a.line_total is None:
        return "the capture failed on board: the file holds no picture"
    if not a.have[: picam.LINE_LEN * 20].any():
        return "the start of the file never arrived, and the picture can't be decoded without it"
    return "not enough of the file arrived to show any of the picture"


def _write_image(image_id: str, r: Rendered, images_dir: Path, site: Path) -> dict:
    src = images_dir / f"{image_id}.{r.ext}"
    thumb = images_dir / "thumbs" / f"{image_id}.jpg"
    _write_bytes(src, r.image)
    with Image.open(io.BytesIO(r.image)) as im:
        width, height = im.size
        dark = _is_dark(im)
        t = im.convert("RGB")
        if t.width > THUMB_WIDTH:
            t = t.resize((THUMB_WIDTH, round(t.height * THUMB_WIDTH / t.width)), Image.LANCZOS)
        buf = io.BytesIO()
        t.save(buf, "JPEG", quality=82, optimize=True)
    _write_bytes(thumb, buf.getvalue())
    return {
        "src": src.relative_to(site).as_posix(),
        "thumb": thumb.relative_to(site).as_posix(),
        "width": width,
        "height": height,
        "status": r.status,
        "note": r.note,
        "completeness": round(r.completeness, 4),
        "dark": dark,
    }


def _is_dark(im: Image.Image) -> bool:
    """True for a frame with nothing to see: nearly black, with at most one
    bright spot (an empty frame, flat sensor noise, or the Sun as a lone dot).
    A night frame with city lights has several separate spots and is kept.
    The flat grey of parts that never arrived is left out of the count."""
    rgb = np.asarray(im.convert("RGB"), dtype=np.int16)
    missing = np.abs(rgb - _GRAY).max(axis=2) <= 3
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    seen = lum[~missing]
    if seen.size < 0.05 * lum.size:
        return False  # too little arrived to tell
    floor = float(np.median(seen))
    if floor > 30:
        return False
    ys, xs = np.nonzero((lum > floor + 15) & ~missing)
    cells = {(y // 16, x // 16) for y, x in zip(ys.tolist(), xs.tolist())}
    spots = 0
    while cells:  # count groups of touching 16-pixel cells
        spots += 1
        stack = [cells.pop()]
        while stack:
            cy, cx = stack.pop()
            for n in [(cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]:
                if n in cells:
                    cells.remove(n)
                    stack.append(n)
        if spots > 1:
            return False
    return True


def _render_key(a: Assembled, jpeg_template: bytes | None, bmp_template: bytes | None) -> str:
    h = hashlib.sha256()
    h.update(f"{RENDER_VERSION}|{a.path}|{a.kind}|{a.line_total}|{a.verified}".encode())
    h.update(a.data)
    h.update(np.packbits(a.have).tobytes())
    h.update(jpeg_template or b"")
    h.update(bmp_template or b"")
    return h.hexdigest()


# -- metadata ------------------------------------------------------------------


def slug(path: str) -> str:
    """A stable, URL-safe id: "camera/2026-09-17_071148Z.img" ->
    "2026-09-17-071148z", "ADCS/img_5608.bmp" -> "adcs-img-5608"."""
    stem = path.rsplit(".", 1)[0]
    if stem.lower().startswith("camera/"):
        stem = stem[len("camera/") :]
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def _unique_ids(files: list[Assembled]) -> dict[str, str]:
    """path -> id. Ids must be unique (image file names, manifest keys, routes
    and annotations all use them). On a slug clash the file downlinked first
    keeps the plain slug, so a picture already on the site keeps its link and
    annotations; later ones get a suffix made from their path."""
    ids, used = {}, set()
    for a in sorted(files, key=lambda a: (a.first_rx, a.path)):
        base = image_id = slug(a.path)
        n = 0
        while image_id in used:
            image_id = f"{base}-{hashlib.sha1(f'{a.path}#{n}'.encode()).hexdigest()[:6]}"
            n += 1
        used.add(image_id)
        ids[a.path] = image_id
    return ids


def _never_received_reason(e) -> str:
    """Why no packets of a file came down. The satellite logs a download
    request before checking the file, so a refused request looks like a
    start; its reply says what happened."""
    if e.refused and len(e.refused) >= len(e.starts):  # every request was turned down
        _at, stage, code = max(e.refused)
        if stage.startswith("checking"):
            if code == -2:
                return "the satellite refused the download: no such file on board"
            return f"the satellite refused the download: it couldn't read the file (error {code})"
        if code == 3:
            return "the file is empty on board (0 bytes), so there was nothing to download"
        return f"the satellite couldn't start the download (error {code})"
    return "a download was started, but no packets of it were received"


def _title(a: Assembled, captured_at: datetime | None, capture_date: date | None) -> str:
    if a.kind == "adcs":
        code = a.path.rsplit("_", 1)[-1].rsplit(".", 1)[0]
        return f"Attitude camera, frame {code}"
    if a.unnamed:
        return f"Unnamed capture, received {_day(a.first_rx.date())}"
    if captured_at is not None:
        return f"{_day(captured_at.date())}, {captured_at:%H:%M} UTC"
    if capture_date is not None:
        return _day(capture_date)
    return a.path.rsplit("/", 1)[-1]


def _day(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def _sort_key(record: dict) -> str:
    return record["captured_at"] or (record["capture_date"] and record["capture_date"] + "T00:00:00Z") or record["downlink"]["first"]


def _iso(t: datetime | None) -> str | None:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


# -- files ---------------------------------------------------------------------


def _write_tle(tle_history: Path, out: Path, log) -> int:
    try:
        from .tle_export import write_tle_json
    except ImportError:
        log("  tle.json: skipped (tle_export not available)")
        return 0
    return write_tle_json(tle_history, out)


def _prune(images_dir: Path, keep: set[str], site: Path) -> None:
    for f in list(images_dir.glob("*.*")) + list((images_dir / "thumbs").glob("*.*")):
        if f.relative_to(site).as_posix() not in keep:
            f.unlink(missing_ok=True)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, data) -> None:
    _write_bytes(path, (json.dumps(data, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return  # unchanged: keep the mtime, and git diffs, quiet
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.5)
