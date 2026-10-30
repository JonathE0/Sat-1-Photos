"""Reassemble the image files CTS-SAT-1 has downlinked, from bulk packets.

A file comes down as BULK_FILE_DOWNLINK packets, each carrying a byte offset
and up to ~195 bytes, but no file name or id. Which packets belong to which
file is worked out per file type:

* PiCAM images (camera/*.img) are self-locating text: every 67-byte line
  names its own number and the image's line total (see picam.py), so a packet
  can be checked against a file regardless of when it arrived. Packets are
  grouped by line total; two images that share a total are told apart by
  their bytes and by when their packets arrived. Groups that match no known
  file become "unnamed" images, so a picture whose name never reached the
  ground still shows up.
* Other images (the ADCS camera's BMPs) are attributed by time. A download
  runs from a start event until the next file's start; start events come
  from the descriptor the satellite sends ahead of a download and from its
  log ("Blob (bulk_downlink_start_blob) args_str: '<file>;...'"), and the
  log's "Bulk downlink complete ... File: <file>" line closes one.

Repeated and overlapping downloads give several copies of most bytes; each
byte takes the value most copies agree on, and the result is checked against
the sha256 the satellite reported, when it reported one.
"""

from __future__ import annotations

import hashlib
import json
import re
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import NamedTuple

import numpy as np
import polars as pl

from . import picam

IMAGE_RE = re.compile(r"(?i)^(camera|adcs)/[^\s'\";]+\.(img|bmp|jpe?g|png)$")

_ACTION_RE = re.compile(r'"action"\s*:\s*"([^"]+)"')
_FILE_RE = re.compile(r'"file"\s*:\s*"([^"]+)"')
_SIZE_RE = re.compile(r'"file_size"\s*:\s*(\d+)')
_SHA_RE = re.compile(r'"sha256"\s*:\s*"([0-9A-Fa-f]{64})"')
_LISTING_RE = re.compile(r'"/((?:camera|ADCS)/[^"]+)"\s*:\s*(\d+)')
# "<sync epoch ms>+<ms since sync>_<sync source>": G GNSS, T telecommand, E EPS clock
_LOG_TIME_RE = re.compile(r"^(\d{12,13})\+(\d+)_(\w)")
_LOG_START_RE = re.compile(r"bulk_downlink_start_blob\) args_str: '([^;']+)")
_LOG_DONE_RE = re.compile(r"Bulk downlink complete\. (\d+) bytes \((\d+) packets\) downlinked\. File: (\S+)")
_LOG_OPENED_RE = re.compile(r"Opened image file: (\S+)")
# The blob's reply when it turns a download down (the request was logged
# as a start all the same): -2 from the size/hash check is "no such file".
_REFUSED_RE = re.compile(
    r"Running bulk_downlink_start_blob: '([^;']+);[^']*' failed in "
    r"(checking file size/hash|bulk_downlink_start_fixed\(\))\. Error: (-?\d+)\."
)
# One entry of the attitude camera's file list, logged as JSON.
_ADCS_ENTRY_RE = re.compile(r'\{[^{}]*"type"\s*:\s*"BMP_IMG"[^{}]*\}')
_ADCS_NAME_RE = re.compile(r"(?i)^ADCS/img_([0-9a-f]{1,4})\.bmp$")
# A camera_capture command's record in a downlinked .run file: ts_done (the
# 13 digits before ',"tcmd"'; the key itself can be split off by a packet
# boundary), how long the capture took, and the file it wrote.
_RUN_CAPTURE_RE = re.compile(rb'(\d{13}),"tcmd":"camera_capture","duration_ms":(\d+),"return":0,"args":"([^",]+)')
_HEADER_RE = re.compile(rb"@(?:[0-9A-F]{4}|FACE)([0-9A-F]{4})")
_NOT_DOWNLOADS = ("analyze_mpi_data", "get_file_map")

# How far a time-attributed download may run past its start event (or
# before its completion event) when no other file's start bounds it.
_MAX_DOWNLOAD = timedelta(hours=3)
_SLACK = timedelta(minutes=2)
# The first and last packets of a download, which name a PiCAM file's line
# total, arrive within this long of its start or completion event.
_FIRST_PACKETS = timedelta(minutes=3)
# A download window grows along packets arriving at most this far apart...
_BURST_GAP = timedelta(minutes=10)
# ...by at most this much on each side.
_BURST_MAX = timedelta(hours=1)
# Two PiCAM images with the same line total are split where their packets
# are more than this far apart...
_PICAM_GAP = timedelta(days=3)
# ...or where they disagree on more than this share of the bytes they
# overlap (one capture's copies differ by a stray bad byte; two captures
# differ on ~77% of the bytes past the header they share).
_DISAGREE = 0.1


class LogStamp(NamedTuple):
    """One log line's time: its own stamp, by the satellite's clock, the
    clock session it belongs to (the sync epoch in the stamp, None if it has
    no stamp) and that session's sync source letter, and when the ground
    heard the line."""

    stamp: datetime
    session: int | None
    source: str
    received_at: datetime


@dataclass(slots=True)
class Evidence:
    """Everything the satellite said about one file."""

    path: str
    size: int | None = None
    sha256: set[str] = field(default_factory=set)
    starts: list[datetime] = field(default_factory=list)
    ends: list[datetime] = field(default_factory=list)
    # "Opened image file" log lines, written as the capture starts.
    opens: list[LogStamp] = field(default_factory=list)
    # The camera_capture command's own record (a .run file downlinked in bulk
    # packets): when the capture started, by the satellite's clock.
    recorded_at: datetime | None = None
    # The capture time the attitude camera's file list gives (the ADCS clock).
    adcs_listed_at: datetime | None = None
    # Download requests the satellite turned down: (when, stage, error code).
    refused: list[tuple[datetime, str, int]] = field(default_factory=list)
    # File descriptors, oldest first: (when, file_size, sha256).
    descriptors: list[tuple[datetime, int | None, str | None]] = field(default_factory=list)

    @property
    def opened_at(self) -> datetime | None:
        """When the camera log says the capture started: the earliest
        "Opened image file" line's stamp, but never later than the ground
        heard the line (the satellite's clock often runs fast)."""
        return min((min(o.stamp, o.received_at) for o in self.opens), default=None)

    @property
    def kind(self) -> str:
        if self.path.lower().endswith(".img"):
            return "picam"
        return "adcs" if self.path.lower().startswith("adcs/") else "other"

    @property
    def times(self) -> list[datetime]:
        return sorted(self.starts + self.ends)


@dataclass(slots=True)
class Assembled:
    """One file, put back together as far as the packets allow."""

    path: str
    kind: str
    size: int
    data: bytes
    have: np.ndarray  # bool per byte: did any packet carry it
    packets: int
    conflicts: int  # bytes that arrived with disagreeing values
    first_rx: datetime
    last_rx: datetime
    evidence: Evidence
    unnamed: bool = False
    line_total: int | None = None  # PiCAM: the lines the capture announces

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    @property
    def verified(self) -> bool:
        return bool(self.have.all()) and self.sha256 in self.evidence.sha256

    @property
    def coverage(self) -> float:
        return float(self.have.mean()) if self.size else 0.0


@dataclass(slots=True)
class Chunks:
    """The CRC-valid bulk packets, as parallel arrays sorted by arrival."""

    times: list[datetime]
    offsets: list[int]
    datas: list[bytes]

    @classmethod
    def load(cls, everything_decoded: Path) -> Chunks:
        df = (
            pl.scan_parquet(everything_decoded)
            .filter((pl.col("packet_type") == "BULK_FILE_DOWNLINK") & pl.col("csp_crc_valid"))
            .select("received_at", "bulk_file_offset", "bulk_data_hex")
            .drop_nulls()
            .sort("received_at")
            .collect()
        )
        return cls(
            df["received_at"].to_list(),
            df["bulk_file_offset"].to_list(),
            [bytes.fromhex(h) for h in df["bulk_data_hex"].to_list()],
        )

    def between(self, start: datetime, end: datetime) -> range:
        return range(bisect_left(self.times, start), bisect_right(self.times, end))


def gather_evidence(everything_decoded: Path, tcmd_responses: Path) -> dict[str, Evidence]:
    """Every file the satellite mentioned, with what it said about each."""
    files: dict[str, Evidence] = {}

    def ev(path: str) -> Evidence:
        path = _canonical(path)
        return files.setdefault(path, Evidence(path))

    responses = pl.read_parquet(tcmd_responses, columns=["first_received_at", "tcmd_response_text"])
    # Oldest first, so that a later descriptor of a file overrides an earlier one.
    for at, text in responses.drop_nulls().sort("first_received_at").iter_rows():
        for path, size in _LISTING_RE.findall(text):
            e = ev(path)
            e.size = e.size or int(size) or None
        if m := _REFUSED_RE.search(text):
            ev(m.group(1)).refused.append((at, m.group(2), int(m.group(3))))
            continue
        file = _FILE_RE.search(text)
        if not file:
            continue
        e = ev(file.group(1))
        size = _SIZE_RE.search(text)
        sha = _SHA_RE.search(text)
        if size:
            e.size = int(size.group(1))
        if sha:
            e.sha256.add(sha.group(1).lower())
        if size or sha:
            e.descriptors.append((at, int(size.group(1)) if size else None, sha.group(1).lower() if sha else None))
        # Any file descriptor precedes a download of that file, except the
        # replies that only mention files (analyses, directory maps).
        action = _ACTION_RE.search(text)
        if not (action and action.group(1).startswith(_NOT_DOWNLOADS)):
            e.starts.append(at)

    logs = (
        pl.scan_parquet(everything_decoded)
        .filter(pl.col("packet_type") == "LOG_MESSAGE")
        .select("received_at", "log_message")
        .drop_nulls()
        .collect()
    )
    adcs_listed: dict[tuple[int, int], set[datetime]] = defaultdict(set)
    for at, text in logs.iter_rows():
        if "args_str" not in text and "File: " not in text and "image file" not in text and "BMP_IMG" not in text:
            continue
        when = _log_time(text, at)
        if m := _LOG_START_RE.search(text):
            ev(m.group(1)).starts.append(when)
        elif m := _LOG_DONE_RE.search(text):
            e = ev(m.group(3))
            e.ends.append(when)
            e.size = e.size or int(m.group(1))
        elif m := _LOG_OPENED_RE.search(text):
            ev(m.group(1)).opens.append(_log_stamp(text, at))
        else:
            for entry in _ADCS_ENTRY_RE.findall(text):
                if listed := _adcs_entry(entry, when):
                    adcs_listed[listed[:2]].add(listed[2])
    for e in files.values():
        e.starts = sorted(set(e.starts))
        e.ends = sorted(set(e.ends))
        # The attitude camera names a frame after its CRC-16, and lists each
        # file's CRC, size and the time it was saved.
        m = _ADCS_NAME_RE.match(e.path)
        if m and e.size and len(times := adcs_listed.get((int(m.group(1), 16), e.size), ())) == 1:
            e.adcs_listed_at = next(iter(times))
    return files


def _canonical(path: str) -> str:
    """LittleFS takes '/ADCS/x' and 'ADCS/x' for the same file, and operators
    type both: listings, descriptors and logs must share one name."""
    return re.sub(r"^(?:\./|/)+", "", path)


def _log_time(text: str, received_at: datetime) -> datetime:
    """A log line's own timestamp ("<sync epoch ms>+<ms since sync>_"), which
    is the satellite's clock; falls back to when the ground received it. The
    clock often runs fast (synced from the EPS board's clock, "_E", it has
    been 15-50 s ahead), and a line can't be written after the ground heard
    it, so never later than that.
    """
    stamp = _log_stamp(text, received_at)
    return min(stamp.stamp, received_at)


def _log_stamp(text: str, received_at: datetime) -> LogStamp:
    if m := _LOG_TIME_RE.match(text):
        t = datetime.fromtimestamp((int(m.group(1)) + int(m.group(2))) / 1000, UTC)
        if abs(t - received_at) < timedelta(hours=12):
            return LogStamp(t, int(m.group(1)), m.group(3), received_at)
    return LogStamp(received_at, None, "", received_at)


def _adcs_entry(entry: str, when: datetime) -> tuple[int, int, datetime] | None:
    """(crc16, size, saved at) from one attitude-camera file-list entry, if
    its time is plausible: an unset (2000) or stale ADCS clock is ignored."""
    try:
        j = json.loads(entry)
        crc, size = int(j["crc16"], 16), int(j["size"])
        saved = datetime.strptime(j["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
    except (ValueError, KeyError, TypeError):
        return None
    if not when - timedelta(days=30) <= saved <= when + timedelta(minutes=5):
        return None
    return crc, size, saved


@dataclass(slots=True)
class Reassembly:
    files: list[Assembled]  # every image file any packets arrived for
    evidence: dict[str, Evidence]  # every image file the satellite mentioned


def reassemble(everything_decoded: Path, tcmd_responses: Path) -> Reassembly:
    """Every image file that any packets were received for."""
    evidence = gather_evidence(everything_decoded, tcmd_responses)
    chunks = Chunks.load(everything_decoded)
    _note_capture_records(evidence, chunks)
    _split_recaptures(evidence)
    images = {p: e for p, e in evidence.items() if IMAGE_RE.match(p)}
    timeline = sorted((t, p) for p, e in evidence.items() for t in e.starts)

    picam_groups = _picam_groups(chunks)
    picam_claimed = {i for group in picam_groups.values() for i in group}
    out = _assemble_picam(images, picam_groups, chunks, timeline, picam_claimed)
    done = {a.path for a in out}
    # Everything else, including a PiCAM file whose packets carry no line
    # structure (a failed capture), is attributed by time.
    rest = {p: e for p, e in images.items() if p not in done}
    out += _assemble_by_time(rest, timeline, chunks, exclude=picam_claimed)
    return Reassembly(out, images)


def _note_capture_records(files: dict[str, Evidence], chunks: Chunks) -> None:
    """When each capture started, from the camera_capture command's own
    record (ts_done less its duration, by the satellite's clock), where the
    .run file holding it came down in bulk packets."""
    for at, data in zip(chunks.times, chunks.datas):
        if b'"camera_capture"' not in data:
            continue
        for m in _RUN_CAPTURE_RE.finditer(data):
            started = datetime.fromtimestamp((int(m.group(1)) - int(m.group(2))) / 1000, UTC)
            e = files.get(_canonical(m.group(3).decode("ascii", "replace")))
            if e is not None and started <= at + timedelta(hours=12) and at - started < timedelta(days=7):
                e.recorded_at = min(filter(None, (e.recorded_at, started)))


def _split_recaptures(files: dict[str, Evidence]) -> None:
    """Split a PiCAM file that was captured again under the same name.

    The camera overwrites the file, so its descriptors change size and
    sha256 partway through its history. Each run of agreeing descriptors is
    one capture: the newest keeps the name, earlier ones become
    "<stem>.earlier-<k>.<ext>" (k = 1 for the oldest), each with its own
    size and hash, and the downloads and log lines of its own time.
    """
    for path, e in list(files.items()):
        if e.kind != "picam":
            continue
        gens: list[list] = []  # [first descriptor time, size, sha256]
        for at, size, sha in e.descriptors:
            g = gens[-1] if gens else None
            if g and (size is None or g[1] in (None, size)) and (sha is None or g[2] in (None, sha)):
                g[1] = size if size is not None else g[1]
                g[2] = sha if sha is not None else g[2]
            else:
                gens.append([at, size, sha])
        if len(gens) < 2:
            continue
        firsts = [g[0] for g in gens]
        bounds = [t - _SLACK for t in firsts[1:]]  # where each later capture's downloads begin

        def download_of(t: datetime) -> int:
            return bisect_right(bounds, t)

        def capture_of(t: datetime) -> int:  # a capture comes before its first descriptor
            return min(bisect_left(firsts, t), len(gens) - 1)

        stem, _dot, ext = path.rpartition(".")
        parts = [
            Evidence(
                path if k == len(gens) - 1 else f"{stem}.earlier-{k + 1}.{ext}",
                size=size if size is not None or k < len(gens) - 1 else e.size,
                sha256={sha} if sha else set(),
            )
            for k, (_first, size, sha) in enumerate(gens)
        ]
        for t in e.starts:
            parts[download_of(t)].starts.append(t)
        for t in e.ends:
            parts[download_of(t)].ends.append(t)
        for r in e.refused:
            parts[download_of(r[0])].refused.append(r)
        for d in e.descriptors:
            parts[download_of(d[0])].descriptors.append(d)
        for o in e.opens:
            parts[capture_of(min(o.stamp, o.received_at))].opens.append(o)
        if e.recorded_at is not None:
            parts[capture_of(e.recorded_at)].recorded_at = e.recorded_at
        for part in parts:
            files[part.path] = part


# -- PiCAM --------------------------------------------------------------------


def _picam_groups(chunks: Chunks) -> dict[int, list[int]]:
    """line total -> indices of packets that are well-formed PiCAM fragments."""
    groups: dict[int, list[int]] = defaultdict(list)
    for i, (offset, data) in enumerate(zip(chunks.offsets, chunks.datas)):
        m = _HEADER_RE.search(data)
        if m is None:
            continue
        total = int(m.group(1), 16)
        if picam.chunk_fits(offset, data, total):
            groups[total].append(i)
    return groups


def _line_total(e: Evidence, chunks: Chunks, timeline: list[tuple[datetime, str]]) -> int | None:
    """The line total a PiCAM file's packets carry.

    Read from the first packets of each of the file's downloads -- a download
    starts at offset 0 within moments of its start event -- and the last
    packets before each completion, rather than derived from the file size:
    a capture cut short on board is smaller than its line total implies.
    """
    votes: Counter[int] = Counter()
    for start, end in _windows(e, timeline, limit=_FIRST_PACKETS):
        for i in chunks.between(start, end):
            m = _HEADER_RE.search(chunks.datas[i])
            if m and (e.size is None or chunks.offsets[i] + len(chunks.datas[i]) <= e.size):
                votes[int(m.group(1), 16)] += 1
    if votes:
        return votes.most_common(1)[0][0]
    return picam.line_total_for_size(e.size) if e.size else None


def _assemble_picam(
    images: dict[str, Evidence],
    groups: dict[int, list[int]],
    chunks: Chunks,
    timeline: list[tuple[datetime, str]],
    claimed: set[int],
) -> list[Assembled]:
    """`claimed` holds the packets already placed in PiCAM files; the short
    last packets this adds to files are added to it too."""
    files_by_total: dict[int, list[Evidence]] = defaultdict(list)
    for e in images.values():
        if e.kind == "picam" and (total := _line_total(e, chunks, timeline)) is not None:
            files_by_total[total].append(e)

    merged: dict[str, tuple[Evidence, int, list[int]]] = {}
    for total, members in sorted(groups.items()):
        candidates = files_by_total.get(total, [])
        # (capture, run of packets): two captures that share a line total are
        # told apart by their bytes, then each capture's packets by time.
        clusters = [
            (c, cluster)
            for c, capture in enumerate(_split_by_content(members, chunks))
            for cluster in _split_by_gap([chunks.times[i] for i in capture], capture)
        ]
        # Nearest file first; a file goes to one capture only (two runs of
        # the same capture may share it).
        pairs = sorted(
            (gap, n, e.path)
            for n, (_c, cluster) in enumerate(clusters)
            for e in candidates
            if (gap := _file_gap(e, chunks.times[cluster[0]], chunks.times[cluster[-1]])) is not None
        )
        by_path = {e.path: e for e in candidates}
        chosen: dict[int, Evidence] = {}
        held: dict[str, int] = {}  # file -> the capture it was given to
        for _gap, n, path in pairs:
            c = clusters[n][0]
            if n not in chosen and held.get(path, c) == c:
                chosen[n], held[path] = by_path[path], c
        for n, (c, cluster) in enumerate(clusters):
            owner = chosen.get(n)
            if owner is None:
                day = chunks.times[cluster[0]].strftime("%Y-%m-%d")
                path, k = f"camera/unnamed_{day}_{total:04x}.img", 1
                while held.get(path, c) != c:  # another capture already holds this name
                    k += 1
                    path = f"camera/unnamed_{day}_{total:04x}_{k}.img"
                owner = merged[path][0] if path in merged else Evidence(path, size=picam.file_size_for(total))
            held[owner.path] = c
            prev = merged.get(owner.path)
            merged[owner.path] = (owner, total, (prev[2] if prev else []) + cluster)

    result = []
    for owner, total, idx in merged.values():
        size = owner.size or picam.file_size_for(total)
        idx = sorted(i for i in idx if chunks.offsets[i] + len(chunks.datas[i]) <= size)
        if not idx:
            continue
        # A file's last packet can be too short to hold a line header (it lies
        # inside the trailer, or past the last header of a capture cut short),
        # so _picam_groups can't place it. Take headerless, unclaimed packets
        # that end exactly at the file's end and arrived during its downloads.
        lo, hi = chunks.times[idx[0]] - _SLACK, chunks.times[idx[-1]] + _BURST_GAP
        tail = {
            j
            for j in chunks.between(lo, hi)
            if j not in claimed
            and chunks.offsets[j] + len(chunks.datas[j]) == size
            and _HEADER_RE.search(chunks.datas[j]) is None
        }
        claimed |= tail
        idx = sorted(set(idx) | tail)
        a = _assemble(owner, "picam", size, idx, chunks, unnamed=owner.path not in images)
        a.line_total = total
        result.append(a)
    return result


def _split_by_content(idx: list[int], chunks: Chunks) -> list[list[int]]:
    """Separate captures that share a line total.

    Packets of one file agree wherever they overlap (but for a rare bad
    byte); two captures agree only on the JPEG header they share. Walk the
    packets in arrival order: a packet stays with the current capture unless
    it contradicts it; then it goes to an earlier capture it agrees with, or
    starts a new one -- taking along the packets of its own download run
    before it, which agreed with the old capture only through that header.
    """
    caps: list[list[int]] = []
    size = max(chunks.offsets[i] + len(chunks.datas[i]) for i in idx)
    arr = {i: np.frombuffer(chunks.datas[i], dtype=np.uint8) for i in idx}

    def blank():
        return np.zeros(size, dtype=np.uint8), np.zeros(size, dtype=bool)

    def add(view, i: int) -> None:
        buf, have = view
        o, d = chunks.offsets[i], arr[i]
        new = ~have[o : o + len(d)]
        buf[o : o + len(d)][new] = d[new]
        have[o : o + len(d)] = True

    def rebuild(members: list[int]):
        view = blank()
        for i in members:
            add(view, i)
        return view

    def fits(view, i: int) -> bool | None:
        """None when the packet shares no bytes with the capture."""
        buf, have = view
        o, d = chunks.offsets[i], arr[i]
        h = have[o : o + len(d)]
        seen = int(h.sum())
        if not seen:
            return None
        return int(np.count_nonzero(buf[o : o + len(d)][h] != d[h])) <= _DISAGREE * seen

    views: list = []
    owner: dict[int, int] = {}
    cur = None
    for n, i in enumerate(idx):
        if cur is not None and fits(views[cur], i) is not False:
            target = cur
        else:
            target = next((c for c in range(len(caps)) if c != cur and fits(views[c], i)), None)
            if target is None:
                caps.append([])
                views.append(blank())
                target = len(caps) - 1
            if cur is not None:
                # The rest of this packet's download run moves with it.
                j = n
                while (
                    j > 0
                    and chunks.times[idx[j]] - chunks.times[idx[j - 1]] <= _BURST_GAP
                    and chunks.offsets[idx[j - 1]] < chunks.offsets[idx[j]]
                    and owner[idx[j - 1]] == cur
                ):
                    j -= 1
                run = set(idx[j:n])
                if run:
                    caps[cur] = [p for p in caps[cur] if p not in run]
                    views[cur] = rebuild(caps[cur])
                    for p in idx[j:n]:
                        caps[target].append(p)
                        owner[p] = target
                    views[target] = rebuild(caps[target])
        caps[target].append(i)
        owner[i] = target
        add(views[target], i)
        cur = target
    return [sorted(c) for c in caps if c] if len(caps) > 1 else [idx]


def _split_by_gap(times: list[datetime], idx: list[int]) -> list[list[int]]:
    clusters: list[list[int]] = []
    last = None
    for t, i in zip(times, idx):
        if last is None or t - last > _PICAM_GAP:
            clusters.append([])
        clusters[-1].append(i)
        last = t
    return clusters


def _file_gap(e: Evidence, first: datetime, last: datetime) -> timedelta | None:
    """How far a file's download events lie from a run of packets; None when
    over 30 days. A file known only from a listing is a last resort."""
    times = e.times or ([e.opened_at] if e.opened_at else [])
    if not times:
        return timedelta(days=36500)
    gap = min(_distance(t, first, last) for t in times)
    return gap if gap <= timedelta(days=30) else None


def _distance(t: datetime, first: datetime, last: datetime) -> timedelta:
    if first <= t <= last:
        return timedelta(0)
    return min(abs(t - first), abs(t - last))


# -- time-attributed (ADCS BMP, anything else) ---------------------------------


def _assemble_by_time(
    images: dict[str, Evidence],
    timeline: list[tuple[datetime, str]],
    chunks: Chunks,
    *,
    exclude: set[int],
) -> list[Assembled]:
    out = []
    for e in images.values():
        if not e.size:
            continue
        others = [t for t, p in timeline if p != e.path]
        idx = sorted(
            {
                i
                for span in _windows(e, timeline)
                for i in chunks.between(*_extend(span, chunks, others))
                if i not in exclude and chunks.offsets[i] + len(chunks.datas[i]) <= e.size
            }
        )
        if idx:
            out.append(_assemble(e, e.kind, e.size, idx, chunks))
    return out


def _extend(span: tuple[datetime, datetime], chunks: Chunks, others: list[datetime]) -> tuple[datetime, datetime]:
    """Grow a download window along the burst of packets it sits in.

    Downloads get repeated or resumed without the ground hearing a new start
    event, so packets keep coming after a window's evidence ends. Follow
    them while they arrive less than `_BURST_GAP` apart, for at most
    `_BURST_MAX`, and never past another file's start event.
    """
    start, end = span
    k = bisect_right(others, end)
    stop = min(end + _BURST_MAX, others[k]) if k < len(others) else end + _BURST_MAX
    j = bisect_right(chunks.times, end)
    while j < len(chunks.times) and chunks.times[j] < stop and chunks.times[j] - end <= _BURST_GAP:
        end = chunks.times[j]
        j += 1
    k = bisect_left(others, start) - 1
    stop = max(start - _BURST_MAX, others[k]) if k >= 0 else start - _BURST_MAX
    j = bisect_left(chunks.times, start) - 1
    while j >= 0 and chunks.times[j] > stop and start - chunks.times[j] <= _BURST_GAP:
        start = chunks.times[j]
        j -= 1
    return start, end


def _windows(
    e: Evidence,
    timeline: list[tuple[datetime, str]],
    *,
    limit: timedelta = _MAX_DOWNLOAD,
) -> list[tuple[datetime, datetime]]:
    """Time spans when `e`'s packets were on the air: from each of its starts
    to the next other file's start, and back from each completion to the
    previous other file's start, each at most `limit` long.
    """
    others = [t for t, p in timeline if p != e.path]

    def prev_other(t: datetime) -> datetime | None:
        k = bisect_left(others, t) - 1
        return others[k] if k >= 0 else None

    def next_other(t: datetime) -> datetime | None:
        k = bisect_right(others, t)
        return others[k] if k < len(others) else None

    spans = []
    for s in e.starts:
        start, end = s - _SLACK, s + limit
        if (p := prev_other(s)) is not None:
            start = max(start, p)
        if (n := next_other(s)) is not None:
            end = min(end, n)
        spans.append((start, end))
    for d in e.ends:
        start, end = d - limit, d + _SLACK
        if (p := prev_other(d)) is not None:
            start = max(start, p)
        if (n := next_other(d)) is not None:
            end = min(end, n)
        spans.append((start, end))
    return spans


# -- assembly ------------------------------------------------------------------


def _assemble(e: Evidence, kind: str, size: int, idx: list[int], chunks: Chunks, *, unnamed: bool = False) -> Assembled:
    """Majority vote per byte over every packet in `idx` (ties go to the
    value seen most recently, which is more often a clean retransmission).
    """
    pos = np.concatenate([np.arange(chunks.offsets[i], chunks.offsets[i] + len(chunks.datas[i])) for i in idx])
    val = np.concatenate([np.frombuffer(chunks.datas[i], dtype=np.uint8) for i in idx]).astype(np.int64)
    order = np.concatenate([np.full(len(chunks.datas[i]), rank) for rank, i in enumerate(idx)])
    key = pos * 256 + val
    uniq, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
    latest = np.zeros(len(uniq), dtype=np.int64)
    np.maximum.at(latest, inverse, order)
    p, v = uniq // 256, uniq % 256
    best = np.lexsort((latest, counts, p))
    is_last = np.r_[p[best][1:] != p[best][:-1], True]
    winners = best[is_last]

    buf = np.zeros(size, dtype=np.uint8)
    have = np.zeros(size, dtype=bool)
    buf[p[winners]] = v[winners]
    have[p[winners]] = True
    conflicts = int(np.count_nonzero(np.bincount(p, minlength=size) > 1))
    return Assembled(
        path=e.path,
        kind=kind,
        size=size,
        data=buf.tobytes(),
        have=have,
        packets=len(idx),
        conflicts=conflicts,
        first_rx=chunks.times[idx[0]],
        last_rx=chunks.times[idx[-1]],
        evidence=e,
        unnamed=unnamed,
    )
