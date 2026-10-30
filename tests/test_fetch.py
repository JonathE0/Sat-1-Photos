"""Tests for the incremental parquet sync, against an in-memory "server".

    .venv\\Scripts\\python.exe -m unittest tests.test_fetch -v
"""

import hashlib
import http.client
import io
import json
import tempfile
import unittest
import urllib.error
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq

from cts1_gallery import fetch, net
from cts1_gallery.fetch import Table, sync_table

SPEC = Table(("received_at", "packet_type", "bulk_data_hex"), time_column="received_at")
T0 = datetime(2026, 9, 1, tzinfo=UTC)


class FakeRemote:
    """A parquet file served by byte ranges, like net.RemoteFile."""

    def __init__(self, data: bytes, etag: str) -> None:
        self.url = "memory://table.parquet"
        self.data, self.etag, self.size = data, etag, len(data)
        self.requests = self.bytes_fetched = 0

    def read(self, start: int, end: int) -> bytes:
        self.requests += 1
        self.bytes_fetched += end - start
        return self.data[start:end]


def _noise(text: str, n: int) -> str:
    """Incompressible filler, so byte counts mean something."""
    out, k = "", 0
    while len(out) < n:
        out += hashlib.sha256(f"{text}/{k}".encode()).hexdigest()
        k += 1
    return out[:n]


def table(seconds: list[int], tag: str = "x", unit: str = "us") -> pa.Table:
    return pa.table(
        {
            "received_at": pa.array([T0 + timedelta(seconds=s) for s in seconds], pa.timestamp(unit, tz="UTC")),
            "packet_type": [f"T{s % 3}" for s in seconds],
            "bulk_data_hex": [_noise(f"{tag}{s}", 120) for s in seconds],
            "sources": [_noise(f"src{s}", 240) for s in seconds],  # big and never fetched
        }
    )


def parquet_bytes(t: pa.Table) -> bytes:
    buf = io.BytesIO()
    pq.write_table(t, buf, row_group_size=100)
    return buf.getvalue()


def data_fetched(remote: "FakeRemote") -> int:
    """Bytes fetched beyond the tail (footer) read every changed sync makes."""
    footer = int.from_bytes(remote.data[-8:-4], "little") + 8
    tail = max(footer, min(remote.size, fetch._PYARROW_TAIL))
    return remote.bytes_fetched - tail - 8


class Sync(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.version = 0
        self.last = None
        # Scale the request-merging gap to these small files, as 256 KiB is
        # to the real ~100 MB one (so skipped columns stay skipped).
        self._gap = fetch._MERGE_GAP
        fetch._MERGE_GAP = 512

    def tearDown(self):
        fetch._MERGE_GAP = self._gap

    def sync(self, t: pa.Table) -> FakeRemote:
        self.version += 1
        remote = FakeRemote(parquet_bytes(t), f'"v{self.version}"')
        self.last = remote
        sync_table("t", SPEC, self.dir, log=lambda m: None, open_remote=lambda url: remote)
        return remote

    def local(self) -> pa.Table:
        return pq.read_table(self.dir / "t.parquet")

    def expect(self, t: pa.Table) -> None:
        got = self.local()
        want = t.select(list(SPEC.columns))
        self.assertEqual(got.num_rows, want.num_rows)
        self.assertTrue(got.equals(want.cast(got.schema)), "local copy differs from the remote table")

    def age_exact_sync(self) -> None:
        state_path = self.dir / "t.sync.json"
        state = json.loads(state_path.read_text())
        state["exact_at"] = (datetime.now(UTC) - fetch.EXACT_EVERY - timedelta(minutes=1)).isoformat()
        state_path.write_text(json.dumps(state))

    BASE = list(range(0, 4000, 2))  # 2000 rows, 20 row groups

    def test_first_sync_is_exact_and_skips_unused_columns(self):
        t = table(self.BASE)
        remote = self.sync(t)
        self.expect(t)
        self.assertLess(remote.bytes_fetched, remote.size * 0.6)  # "sources" never fetched

    def test_unchanged_file_costs_nothing(self):
        t = table(self.BASE)
        remote = FakeRemote(parquet_bytes(t), '"same"')
        sync_table("t", SPEC, self.dir, log=lambda m: None, open_remote=lambda url: remote)
        before = remote.bytes_fetched
        sync_table("t", SPEC, self.dir, log=lambda m: None, open_remote=lambda url: remote)
        self.assertEqual(remote.bytes_fetched, before)

    def test_appended_rows_fetch_only_the_tail(self):
        self.sync(table(self.BASE))
        t = table(self.BASE + list(range(4000, 4040, 2)))
        remote = self.sync(t)
        self.expect(t)
        self.assertLess(data_fetched(remote), remote.size * 0.06)  # ~1 of 21 row groups' kept columns

    def test_backfill_in_the_middle_fetches_only_that_span(self):
        self.sync(table(self.BASE))
        t = table(sorted(self.BASE + [1301, 1303, 1305]))  # three older packets turn up
        remote = self.sync(t)
        self.expect(t)
        # The insert shifts every later row group's boundaries; only the
        # spans whose row counts changed are fetched, not all of them.
        self.assertLess(data_fetched(remote), remote.size * 0.15)

    def test_removed_rows_disappear(self):
        self.sync(table(self.BASE))
        t = table([s for s in self.BASE if not 1400 <= s < 1420])
        self.sync(t)
        self.expect(t)

    def test_daily_exact_sync_catches_same_count_changes(self):
        base = self.BASE
        self.sync(table(base))
        changed = table(base, tag="y")  # same rows and times, different payload
        self.sync(changed)
        self.assertFalse(self.local().equals(changed.select(list(SPEC.columns)).cast(self.local().schema)))
        self.age_exact_sync()
        self.sync(changed)
        self.expect(changed)

    def test_time_shared_across_a_row_group_boundary_is_not_refetched(self):
        tied = sorted(self.BASE[:100] + [self.BASE[99]] + self.BASE[100:1999])  # rows 99 and 100 share a time
        t = table(tied)
        self.sync(t)
        remote = self.sync(t)  # only the ETag changed
        self.expect(t)
        self.assertEqual(data_fetched(remote), 0)

    def test_millisecond_and_nanosecond_times_fetch_only_the_tail(self):
        for unit in ("ms", "ns"):
            with self.subTest(unit=unit):
                self.sync(table(self.BASE, unit=unit))
                t = table(self.BASE + list(range(4000, 4040, 2)), unit=unit)
                remote = self.sync(t)
                self.expect(t)
                self.assertLess(data_fetched(remote), remote.size * 0.06)


class Retries(unittest.TestCase):
    """net.RemoteFile against a patched urlopen."""

    def respond(self, *steps):
        """Patch urlopen to answer with each step in turn: bytes for a 206, or
        an exception to raise from read()/urlopen."""
        calls = []

        class Response:
            def __init__(self, body, start, end, total):
                self.status, self.body = 206, body
                self.headers = {"Content-Range": f"bytes {start}-{end}/{total}", "ETag": '"v1"'}

            def read(self):
                if isinstance(self.body, BaseException):
                    raise self.body
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def urlopen(req, **_kw):
            start, end = (int(x) for x in req.headers["Range"].split("=")[1].split("-"))
            step = steps[min(len(calls), len(steps) - 1)]
            calls.append((start, end))
            if isinstance(step, urllib.error.HTTPError):
                raise step
            body = step if isinstance(step, BaseException) else DATA[start : end + 1]
            return Response(body, start, end, len(DATA))

        patches = [mock.patch.object(net.urllib.request, "urlopen", urlopen), mock.patch.object(net.time, "sleep")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return calls

    def test_a_body_cut_short_is_retried(self):
        calls = self.respond(b"ok", http.client.IncompleteRead(b""), b"ok")
        remote = net.RemoteFile("https://example.test/t.parquet")
        self.assertEqual(remote.read(10, 20), DATA[10:20])
        self.assertEqual(len(calls), 3)

    def test_a_file_that_shrank_mid_sync_starts_over(self):
        gone = urllib.error.HTTPError("https://example.test/t.parquet", 416, "Range Not Satisfiable", {}, None)
        self.respond(b"ok", gone)
        remote = net.RemoteFile("https://example.test/t.parquet")
        with self.assertRaises(net.RemoteChanged):
            remote.read(10, 20)


DATA = bytes(range(256)) * 4


if __name__ == "__main__":
    unittest.main()
