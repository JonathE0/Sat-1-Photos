"""Keep a local, column-trimmed mirror of the ground-station pipeline's tables.

The source is the CalgaryToSpace processing pipeline's public web UI
(https://frontiersat.mooo.com). It re-processes every SatNOGS observation of
the satellite about every 15 minutes -- demodulating the audio itself, so it
holds packets SatNOGS DB never decoded -- and serves each output table as a
parquet file at /raw-export/<table>.parquet. That makes it both the most
complete source and the cheapest one to pull from.

The big table (`everything_decoded`, ~100 MB) is never downloaded whole, and
only the ten of its ~150 columns the build reads are fetched (the packets,
logs and the beacons' clock readings). Changing that list makes the next sync
an exact one that fetches every row group's kept columns once. Each sync
starts by reading the remote file's footer (its parquet metadata) with an HTTP
range request, then reconciles one of two ways:

* **By time range** (routine runs). The table is sorted by receive time, so
  the footer gives every row group's time span and row count. A span whose
  count matches the local copy is taken as unchanged; only row groups whose
  counts differ are fetched, and their spans' local rows replaced. New
  downlinks only touch the last row group, and when the pipeline backfills
  older observations -- shifting every later row group's boundaries -- only
  the spans that actually gained rows are fetched. Row groups that share a
  boundary timestamp are reconciled as one span.
* **By fingerprint** (the first sync, and once a day). Every row group is
  fingerprinted from its metadata (row count, and each kept column's
  compressed size, value count and min/max), and any group whose fingerprint
  isn't cached is fetched. This catches upstream changes that keep row counts
  the same, such as a re-decoded packet.

Either way nearby column chunks share a request, several requests run at
once, and the result is the same local table the builder reads. A run where
nothing changed costs one tiny request per table (the ETag check).
"""

from __future__ import annotations

import bisect
import hashlib
import io
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .net import RangeNotSupported, RemoteChanged, RemoteFile, download

DASHBOARD = "https://frontiersat.mooo.com"


@dataclass(frozen=True)
class Table:
    columns: tuple[str, ...] | None  # None = every column
    time_column: str | None = None  # the column the remote table is sorted by


TABLES: dict[str, Table] = {
    "everything_decoded": Table(
        (
            "packet_type",
            "received_at",
            "csp_crc_valid",
            "bulk_file_offset",
            "bulk_data_hex",
            "log_message",
            # The beacons' clock readings, for capture.SatelliteClock.
            "received_at_source",
            "unix_epoch_time_ms",
            "uptime_sec",
            "last_time_sync_source",
        ),
        time_column="received_at",
    ),
    "reassembled_tcmd_responses": Table(("first_received_at", "tcmd_response_text")),
    "tle_history": Table(None),
}

EXACT_EVERY = timedelta(days=1)  # how often to re-check every row group exactly
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# Fetch two column chunks in one request if they're this close: a balance
# between bytes of unused columns pulled in and requests made of a small
# team-run server.
_MERGE_GAP = 128 * 1024
_PYARROW_TAIL = 64 * 1024
_WORKERS = 4  # concurrent requests: gentle on the team's server
_ATTEMPTS = 3  # restarts when the server replaces a file mid-sync


def fetch_all(cache_dir: Path, *, log=print) -> dict[str, Path]:
    """Bring every table in `TABLES` up to date under `cache_dir`, returning
    the local parquet path of each.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    return {key: sync_table(key, spec, cache_dir, log=log) for key, spec in TABLES.items()}


def sync_table(key: str, spec: Table, cache_dir: Path, *, log=print, open_remote=RemoteFile, url: str | None = None) -> Path:
    url = url or f"{DASHBOARD}/raw-export/{key}.parquet"
    out = cache_dir / f"{key}.parquet"
    for _attempt in range(_ATTEMPTS):
        try:
            return _sync(open_remote(url), key, spec, cache_dir, out, log)
        except RemoteChanged:
            log(f"  {key}: replaced on the server mid-sync, starting over")
        except RangeNotSupported:
            break
    log(f"  {key}: falling back to a full download")
    return _full_download(url, key, spec, cache_dir, out, log)


def _sync(remote, key: str, spec: Table, cache_dir: Path, out: Path, log) -> Path:
    state_path = cache_dir / f"{key}.sync.json"
    state = _read_json(state_path)
    if out.exists() and remote.etag and state.get("etag") == remote.etag:
        log(f"  {key}: unchanged")
        return out

    src = _RangeFile(remote)
    tail = remote.read(remote.size - 8, remote.size)
    if tail[4:] != b"PAR1":
        msg = f"{remote.url} is not a parquet file"
        raise ValueError(msg)
    footer_start = remote.size - 8 - int.from_bytes(tail[:4], "little")
    # pyarrow reads the last 64 KiB speculatively, so fetch at least that much.
    tail_start = max(0, min(footer_start, remote.size - _PYARROW_TAIL))
    src.add(tail_start, remote.read(tail_start, remote.size))

    pf = pq.ParquetFile(src, pre_buffer=False)
    md = pf.metadata
    names = pf.schema_arrow.names
    keep = [n for n in (spec.columns or names) if n in names]
    if spec.columns and len(keep) != len(spec.columns):
        msg = f"{key}: the remote table lacks columns {sorted(set(spec.columns) - set(names))}"
        raise ValueError(msg)
    schema = pa.schema([pf.schema_arrow.field(n) for n in keep])
    leaves = _leaves(md, set(keep))

    now = datetime.now(UTC)
    exact_due = now - _parse_time(state.get("exact_at")) >= EXACT_EVERY
    fast = (
        spec.time_column is not None
        and md.num_row_groups > 1
        and out.exists()
        and state.get("columns") == keep
        and not exact_due
    )
    result = _sync_by_time(pf, src, keep, schema, leaves, spec.time_column, out) if fast else None
    mode = "by time range"
    if result is None:
        result = _sync_by_fingerprint(pf, src, keep, schema, leaves, cache_dir / "rowgroups" / key, out)
        mode = "exactly"
        state["exact_at"] = now.isoformat(timespec="seconds")

    state.update({"etag": remote.etag, "size": remote.size, "columns": keep, "synced_at": now.isoformat(timespec="seconds")})
    _write_json(state_path, state)
    log(
        f"  {key}: synced {mode}, {result}/{md.num_row_groups} row groups fetched, "
        f"{remote.bytes_fetched / 1e6:.2f} MB in {remote.requests} requests "
        f"(whole file {remote.size / 1e6:.1f} MB)"
    )
    return out


def _sync_by_time(pf, src, keep, schema, leaves, time_column, out) -> int | None:
    """Reconcile `out` with the remote table span by span; returns the number
    of row groups fetched, or None if this can't be done safely (missing
    statistics, or a result that doesn't add up), in which case the caller
    syncs by fingerprint instead.
    """
    md = pf.metadata
    t_leaf = next((i for i in range(md.num_columns) if md.schema.column(i).path == time_column), None)
    if t_leaf is None:
        return None
    spans = []
    for i in range(md.num_row_groups):
        stats = md.row_group(i).column(t_leaf).statistics
        if stats is None or not stats.has_min_max or stats.null_count:
            return None
        spans.append((_micros(stats.min), _micros(stats.max), md.row_group(i).num_rows))

    local = pq.read_table(out)
    if local.schema != schema:
        return None
    col = local.column(time_column)
    if pa.types.is_timestamp(col.type):  # spans are in µs (_micros); match them whatever the column's unit
        col = col.cast(pa.timestamp("us", tz=col.type.tz), safe=False)
    times = col.cast(pa.int64()).to_numpy(zero_copy_only=False)
    if len(times) and (np.diff(times) < 0).any():
        return None  # the local copy isn't sorted: rebuild it exactly

    # Row groups whose time spans touch (a timestamp repeated across a
    # boundary) share local rows that can't be told apart, so they are
    # checked, and if need be fetched, together.
    groups = []  # [lo, hi, rows, member row groups]
    for i, (lo, hi, n) in enumerate(spans):
        if groups and lo <= groups[-1][1]:
            g = groups[-1]
            g[1], g[2] = max(g[1], hi), g[2] + n
            g[3].append(i)
        else:
            groups.append([lo, hi, n, [i]])
    changed, keep_mask = [], np.zeros(len(times), dtype=bool)
    for lo, hi, n, members in groups:
        a, b = np.searchsorted(times, lo, "left"), np.searchsorted(times, hi, "right")
        if b - a == n:
            keep_mask[a:b] = True
        else:
            changed.extend(members)
    if changed:
        spans_to_fetch = sorted(_chunk_span(md.row_group(i).column(j)) for i in changed for j in leaves)
        src.prefetch(_merge(spans_to_fetch))
    fetched = [pf.read_row_group(i, columns=keep) for i in changed]
    for i in changed:  # a changed span's local rows are replaced wholesale
        lo, hi, _n = spans[i]
        keep_mask[np.searchsorted(times, lo, "left") : np.searchsorted(times, hi, "right")] = False

    merged = pa.concat_tables([local.filter(pa.array(keep_mask))] + [t.cast(schema) for t in fetched])
    merged = merged.take(pc.sort_indices(merged, sort_keys=[(time_column, "ascending")]))
    if merged.num_rows != md.num_rows:
        return None
    _write_table(merged, out)
    return len(changed)


def _sync_by_fingerprint(pf, src, keep, schema, leaves, rg_dir: Path, out: Path) -> int:
    md = pf.metadata
    prefix = str(schema)
    sigs = [_fingerprint(md.row_group(i), leaves, prefix) for i in range(md.num_row_groups)]
    rg_dir.mkdir(parents=True, exist_ok=True)
    missing = [i for i, sig in enumerate(sigs) if not (rg_dir / f"{sig}.parquet").exists()]
    if missing:
        spans = sorted(_chunk_span(md.row_group(i).column(j)) for i in missing for j in leaves)
        src.prefetch(_merge(spans))
        for i in missing:
            _write_table(pf.read_row_group(i, columns=keep), rg_dir / f"{sigs[i]}.parquet")
    _stitch([rg_dir / f"{sig}.parquet" for sig in sigs], schema, out)
    current = {f"{sig}.parquet" for sig in sigs}
    for stale in rg_dir.glob("*.parquet"):
        if stale.name not in current:
            stale.unlink(missing_ok=True)
    return len(missing)


def _leaves(md: pq.FileMetaData, keep: set[str]) -> list[int]:
    return [i for i in range(md.num_columns) if md.schema.column(i).path.split(".")[0] in keep]


def _micros(value) -> int:
    """A parquet timestamp statistic as microseconds since the epoch, exactly
    (no float round trip: rows sit on span boundaries to the microsecond).
    """
    if isinstance(value, datetime):
        value = value if value.tzinfo else value.replace(tzinfo=UTC)
        return (value - _EPOCH) // timedelta(microseconds=1)
    return int(value)


def _parse_time(text: str | None) -> datetime:
    try:
        return datetime.fromisoformat(text) if text else datetime.min.replace(tzinfo=UTC)
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)


def _fingerprint(rg: pq.RowGroupMetaData, leaves: list[int], prefix: str) -> str:
    h = hashlib.sha256(prefix.encode())
    h.update(str(rg.num_rows).encode())
    for j in leaves:
        col = rg.column(j)
        stats = col.statistics
        summary = None
        if stats is not None:
            summary = (stats.null_count, str(stats.min), str(stats.max)) if stats.has_min_max else stats.null_count
        h.update(repr((col.path_in_schema, col.total_compressed_size, col.num_values, summary)).encode())
    return h.hexdigest()[:32]


def _chunk_span(col: pq.ColumnChunkMetaData) -> tuple[int, int]:
    start = col.data_page_offset
    if col.has_dictionary_page and col.dictionary_page_offset and col.dictionary_page_offset < start:
        start = col.dictionary_page_offset
    return start, start + col.total_compressed_size


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start - merged[-1][1] <= _MERGE_GAP:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


class _RangeFile(io.RawIOBase):
    """A seekable, read-only view of a `RemoteFile` for pyarrow.

    Reads come out of ranges fetched ahead of time with `prefetch`, so
    pyarrow's many small reads don't each become a request; anything not
    prefetched is fetched on demand.
    """

    def __init__(self, remote: RemoteFile) -> None:
        self.remote = remote
        self._pos = 0
        self._starts: list[int] = []
        self._blocks: list[bytes] = []

    def add(self, start: int, data: bytes) -> None:
        i = bisect.bisect(self._starts, start)
        self._starts.insert(i, start)
        self._blocks.insert(i, data)

    def prefetch(self, spans: list[tuple[int, int]]) -> None:
        with ThreadPoolExecutor(_WORKERS) as pool:
            for (start, _end), data in zip(spans, pool.map(lambda s: self.remote.read(*s), spans)):
                self.add(start, data)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self.remote.size}[whence]
        self._pos = base + offset
        return self._pos

    def readinto(self, buf) -> int:
        n = min(len(buf), self.remote.size - self._pos)
        if n <= 0:
            return 0
        buf[:n] = self._slice(self._pos, self._pos + n)
        self._pos += n
        return n

    def _slice(self, start: int, end: int) -> bytes:
        i = bisect.bisect_right(self._starts, start) - 1
        if i >= 0:
            block_start, block = self._starts[i], self._blocks[i]
            if end <= block_start + len(block):
                return block[start - block_start : end - block_start]
        data = self.remote.read(start, end)
        self.add(start, data)
        return data


def _stitch(parts: list[Path], schema: pa.Schema, out: Path) -> None:
    tmp = out.with_name(out.name + ".tmp")
    with pq.ParquetWriter(tmp, schema, compression="zstd") as writer:
        for part in parts:
            writer.write_table(pq.read_table(part, schema=schema))
    _replace(tmp, out)


def _full_download(url, key, spec: Table, cache_dir, out, log) -> Path:
    full = cache_dir / f"{key}.full.parquet"
    download(url, full)
    names = pq.read_schema(full).names
    _write_table(pq.read_table(full, columns=[n for n in (spec.columns or names) if n in names]), out)
    full.unlink(missing_ok=True)
    full.with_name(full.name + ".etag").unlink(missing_ok=True)
    (cache_dir / f"{key}.sync.json").unlink(missing_ok=True)
    log(f"  {key}: downloaded whole")
    return out


def _write_table(table: pa.Table, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    pq.write_table(table, tmp, compression="zstd")
    _replace(tmp, dest)


def _replace(src: Path, dest: Path) -> None:
    # Windows refuses to replace a file another process has open (e.g. the
    # site builder reading it); that never lasts long.
    for attempt in range(20):
        try:
            os.replace(src, dest)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.5)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    _replace(tmp, path)
