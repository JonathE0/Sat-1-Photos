"""HTTP downloads for the pipeline.

frontiersat.mooo.com serves a Let's Encrypt chain that ends in an expired
ISRG Root X2 cross-sign. Clients whose trust store lacks the newer ISRG Root
YE (Python's own store and certifi's, as of late 2026) walk that expired
path and fail verification. Bundling Root YE as an extra trust anchor lets
verification stop at it instead -- no checks are disabled.
"""

from __future__ import annotations

import http.client
import json
import shutil
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import cache
from pathlib import Path

USER_AGENT = "cts1-gallery/0.1 (+https://github.com/CalgaryToSpace)"
_ROOT_YE = Path(__file__).with_name("certs") / "isrg-root-ye.pem"


@cache
def ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=str(_ROOT_YE))
    return ctx


def get_json(url: str, *, timeout: float = 60) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, context=ssl_context(), timeout=timeout) as r:
        return json.load(r)


class RangeNotSupported(Exception):
    """The server answered a range request with something other than 206."""


class RemoteChanged(Exception):
    """The remote file was replaced while it was being read."""


class RemoteFile:
    """One version of a remote file, read with HTTP range requests.

    Every response has to carry the ETag the first one did, so a file the
    server replaces partway through raises `RemoteChanged` instead of
    quietly mixing bytes from two versions. Safe to read from several
    threads at once.
    """

    def __init__(self, url: str, *, timeout: float = 60, retries: int = 5) -> None:
        self.url = url
        self.timeout = timeout
        self.retries = retries
        self.etag: str | None = None
        self.size: int | None = None  # set once the first response says it
        self.requests = 0
        self.bytes_fetched = 0
        self._lock = threading.Lock()
        _data, headers = self._get(0, 1)
        total = (headers.get("Content-Range") or "").rpartition("/")[2]
        if not total.isdigit():
            raise RangeNotSupported(url)
        self.size = int(total)
        self.etag = headers.get("ETag")

    def read(self, start: int, end: int) -> bytes:
        """Bytes `[start, end)` of the file."""
        data, _headers = self._get(start, end)
        if len(data) != end - start:
            msg = f"short read from {self.url}: wanted {end - start} bytes, got {len(data)}"
            raise OSError(msg)
        return data

    def _get(self, start: int, end: int):
        headers = {"User-Agent": USER_AGENT, "Range": f"bytes={start}-{end - 1}"}
        for attempt in range(self.retries + 1):
            try:
                req = urllib.request.Request(self.url, headers=headers)
                with urllib.request.urlopen(
                    req, context=ssl_context(), timeout=self.timeout
                ) as r:
                    if r.status != 206:
                        raise RangeNotSupported(self.url)
                    etag = r.headers.get("ETag")
                    if self.etag and etag and etag != self.etag:
                        raise RemoteChanged(self.url)
                    data = r.read()
                with self._lock:
                    self.requests += 1
                    self.bytes_fetched += len(data)
                return data, r.headers
            except urllib.error.HTTPError as e:
                if e.code == 416 and self.size is not None:  # a range inside the size we opened with: the file shrank
                    raise RemoteChanged(self.url) from e
                if (e.code < 500 and e.code != 429) or attempt == self.retries:
                    raise
                wait = _retry_after(e.headers.get("Retry-After"))
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, ssl.SSLError):
                # HTTPException covers IncompleteRead, a body cut short;
                # ssl.SSLError a TLS stream cut mid-body (urlopen only wraps
                # connect-time errors in URLError).
                if attempt == self.retries:
                    raise
                wait = None
            # 2, 4, 8, 16, 32 s: long enough to outlast the dashboard restarting.
            time.sleep(wait if wait is not None else 2 ** (attempt + 1))
        raise AssertionError("unreachable")


def _retry_after(value: str | None) -> float | None:
    """Seconds to wait from a Retry-After header (seconds form), capped."""
    try:
        return min(float(value), 120.0) if value else None
    except ValueError:
        return None


def download(url: str, dest: Path, *, timeout: float = 120) -> bool:
    """Download `url` to `dest`, skipping the transfer if the server's ETag
    matches the one saved alongside `dest` from the last download.

    Returns True if `dest` was (re)written. Writes go to a `.part` file that
    replaces `dest` only once complete, so an interrupted download never
    leaves a truncated file behind.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    etag_file = dest.with_name(dest.name + ".etag")
    headers = {"User-Agent": USER_AGENT}
    if dest.exists() and etag_file.exists():
        headers["If-None-Match"] = etag_file.read_text().strip()

    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, context=ssl_context(), timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return False
        raise

    with resp:
        total = int(resp.headers.get("Content-Length") or 0)
        part = dest.with_name(dest.name + ".part")
        done = 0
        last_report = 0.0
        with part.open("wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if total and sys.stderr.isatty() and now - last_report > 0.25:
                    last_report = now
                    print(
                        f"\r  {dest.name}: {done / 1e6:6.1f} / {total / 1e6:.1f} MB",
                        end="",
                        file=sys.stderr,
                    )
        if total and sys.stderr.isatty():
            print(file=sys.stderr)
        shutil.move(part, dest)
        if etag := resp.headers.get("ETag"):
            etag_file.write_text(etag)
    return True
