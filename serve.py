#!/usr/bin/env python3
"""Serve the gallery in site/ and store members' edits through a small JSON API.

    python serve.py [--host 127.0.0.1] [--port 8000] [--site site] [--edit-key KEY] [--read-only]
                    [--allow-host NAME ...]

The edit key can also come from the GALLERY_EDIT_KEY environment variable.
With open edits (no key), edits are only accepted for requests addressed to
localhost, an IP address or a name given with --allow-host.
docs/DATA.md is the contract for site/data/annotations.json and the API:

    GET  /api/annotations        the whole annotations object
    GET  /api/health             {"ok": true, "edits": "open" | "key" | "off"}
    POST /api/annotations/<id>   {"by": "Name", "key": "...", "changes": {...}, "base": {...}}

Standard library only.
"""
from __future__ import annotations

import argparse
import contextlib
import email.utils
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 64 * 1024        # largest POST body accepted, in bytes
MAX_DRAIN = 1024 * 1024     # bodies up to this size are read and dropped so the client sees the 413
HISTORY_LIMIT = 200         # newest history entries kept per photo
MAX_TEXT = 2000             # title, notes, place
MAX_BY = 80
MAX_LIST = 50               # people, tags
MAX_NAME = 60               # one person or tag
REPLACE_ATTEMPTS = 8        # os.replace retries when Windows reports the file busy
RETRY_DELAY = 0.05          # seconds before the first retry; doubles up to 0.5

FIELDS = ("title", "notes", "people", "tags", "captured_at", "lat", "lon", "place")
BODY_KEYS = ("by", "key", "changes", "base")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".geojson": "application/geo+json",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".ktx2": "image/ktx2",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}

# Removed from every text field: C0/C1 controls (except tab and newline, which
# multi-line notes keep), bidi embedding/override/isolate characters, and lone
# surrogates (which could not be written out as UTF-8).
_CONTROL = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩\ud800-\udfff]")
_LINE_BREAKS = re.compile("[\t\n  ]")
_ANNOTATION_ROUTE = re.compile(r"^/api/annotations/([^/]+)$")
# Names Windows maps to devices, with or without an extension ("con", "nul.txt").
_WIN_DEVICE = re.compile(r"^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$",
                         re.IGNORECASE)


class ApiError(Exception):
    """An error answered as JSON {"error": message}."""

    def __init__(self, status: int, message: str, close: bool = False):
        super().__init__(message)
        self.status = status
        self.message = message
        self.close = close  # the request body was not read, so the connection can't be reused


class StoreError(Exception):
    """annotations.json could not be read or written; nothing was changed."""


class Conflict(Exception):
    """Someone else changed a field since the editor loaded it; nothing was changed."""

    def __init__(self, field: str, record: dict):
        super().__init__(field)
        self.field = field
        self.record = record


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def blank_record() -> dict:
    return {"title": None, "notes": None, "people": [], "tags": [], "captured_at": None,
            "lat": None, "lon": None, "place": None,
            "updated_at": None, "updated_by": None, "history": []}


# ---------------------------------------------------------------- validation

def clean_text(value: str, multiline: bool = False) -> str:
    """Strip control characters and surrounding whitespace.

    Single-line fields turn tabs and line breaks into spaces; multi-line ones
    keep tabs and newlines (normalised to \\n).
    """
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if multiline:
        value = value.replace(" ", "\n").replace(" ", "\n")
    else:
        value = _LINE_BREAKS.sub(" ", value)
    return _CONTROL.sub("", value).strip()


def _text(field: str, value, multiline: bool = False):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ApiError(400, f"{field} must be a string or null")
    value = clean_text(value, multiline)
    if len(value) > MAX_TEXT:
        raise ApiError(400, f"{field} must be at most {MAX_TEXT} characters")
    return value or None  # an empty string clears the field


def _names(field: str, value) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, f"{field} must be a list of strings")
    if len(value) > MAX_LIST:
        raise ApiError(400, f"{field} can have at most {MAX_LIST} entries")
    out, seen = [], set()
    for item in value:
        if not isinstance(item, str):
            raise ApiError(400, f"{field} entries must be strings")
        item = clean_text(item)
        if not 1 <= len(item) <= MAX_NAME:
            raise ApiError(400, f"{field} entries must be 1-{MAX_NAME} characters")
        folded = item.casefold()
        if folded not in seen:  # de-duplicate case-insensitively, keeping the first spelling
            seen.add(folded)
            out.append(item)
    return out


def _timestamp(field: str, value):
    if value is None:
        return None
    problem = f"{field} must be an ISO 8601 UTC timestamp such as 2026-09-17T07:11:48Z, or null"
    if not isinstance(value, str) or len(value) > 64:
        raise ApiError(400, problem)
    text = value.strip()
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        raise ApiError(400, problem) from None
    if moment.tzinfo is None or moment.utcoffset() != timedelta(0):
        raise ApiError(400, problem)
    return moment.replace(tzinfo=None, microsecond=0).isoformat() + "Z"


def _coordinate(limit: int):
    def check(field: str, value):
        if value is None:
            return None
        # bool is an int in Python; NaN and Infinity are refused by the JSON parser.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not -limit <= value <= limit:
            raise ApiError(400, f"{field} must be a number from -{limit} to {limit}, or null")
        return float(value)
    return check


VALIDATORS = {
    "title": _text,
    "notes": partial(_text, multiline=True),
    "place": _text,
    "people": _names,
    "tags": _names,
    "captured_at": _timestamp,
    "lat": _coordinate(90),
    "lon": _coordinate(180),
}


def _no_constants(name: str):
    raise ValueError(f"{name} is not valid JSON")


def parse_json(body: bytes):
    try:
        return json.loads(body.decode("utf-8-sig"), parse_constant=_no_constants)
    except (ValueError, RecursionError):  # includes JSONDecodeError and UnicodeDecodeError
        raise ApiError(400, "body must be valid JSON") from None


def validate_edit(payload: dict) -> tuple[str, dict, dict | None]:
    """Check a POST body ({by, key?, changes, base?}); return (by, cleaned
    changes, cleaned base or None).

    `base` holds, for fields in `changes`, the values the editor started
    from; they are cleaned like the new values so they compare like for like
    with what is stored.
    """
    unknown = sorted(str(k) for k in payload if k not in BODY_KEYS)
    if unknown:
        raise ApiError(400, f"unknown field: {clean_text(unknown[0])[:60]}")
    by = payload.get("by")
    by = clean_text(by) if isinstance(by, str) else ""
    if not 1 <= len(by) <= MAX_BY:
        raise ApiError(400, f"by is required: your name, 1-{MAX_BY} characters")
    changes = payload.get("changes")
    if not isinstance(changes, dict):
        raise ApiError(400, "changes must be an object")
    cleaned = {}
    for field, value in changes.items():
        check = VALIDATORS.get(field)
        if check is None:
            raise ApiError(400, f"unknown field: {clean_text(str(field))[:60]}")
        cleaned[field] = check(field, value)
    if "base" not in payload:
        return by, cleaned, None
    base = payload["base"]
    if not isinstance(base, dict) or not set(base) <= set(changes):
        raise ApiError(400, "base must be an object holding only fields that are in changes")
    return by, cleaned, {field: VALIDATORS[field](field, value) for field, value in base.items()}


# ------------------------------------------------------------------- storage

def _retry_busy(action):
    """Run action, retrying while Windows says the file is in use (antivirus, a reader, git)."""
    delay = RETRY_DELAY
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            return action()
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.5)


def _stamp(st: os.stat_result) -> tuple:
    return (st.st_mtime_ns, st.st_size, st.st_ino)


class ImageIndex:
    """The ids in images.json, re-read whenever the file changes."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._stamp = None
        self._ids: frozenset = frozenset()

    def ids(self) -> frozenset:
        try:
            stamp = _stamp(os.stat(self.path))
        except OSError:
            return frozenset()
        with self._lock:
            if stamp != self._stamp:
                try:
                    data = json.loads(_retry_busy(self.path.read_bytes).decode("utf-8-sig"))
                    ids = frozenset(img["id"] for img in data["images"]
                                    if isinstance(img, dict) and isinstance(img.get("id"), str))
                except (OSError, ValueError, KeyError, TypeError):
                    # Probably caught mid-rewrite: keep the previous ids and look again next time.
                    return self._ids
                self._ids, self._stamp = ids, stamp
            return self._ids


class AnnotationStore:
    """site/data/annotations.json: read on demand, written atomically under a lock."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self._data: dict | None = None
        self._stamp = None
        self._body: bytes | None = None  # compact JSON of _data, for GET /api/annotations

    def _load(self) -> dict:
        """The current object (call with the lock held). Re-reads the file if it changed on disk."""
        try:
            stamp = _stamp(os.stat(self.path))
        except FileNotFoundError:
            self._data, self._stamp, self._body = None, None, None
            return {}
        except OSError as exc:
            raise StoreError("annotations.json could not be read; no edits were saved") from exc
        if self._data is not None and stamp == self._stamp:
            return self._data
        try:
            text = _retry_busy(self.path.read_bytes).decode("utf-8-sig")
            data = json.loads(text) if text.strip() else {}
        except (OSError, ValueError) as exc:
            raise StoreError("annotations.json is unreadable or not valid JSON; "
                             "fix or restore it (no edits were saved)") from exc
        if not isinstance(data, dict):
            raise StoreError("annotations.json must hold a JSON object; fix or restore it")
        self._data, self._stamp, self._body = data, stamp, None
        return data

    def snapshot(self) -> bytes:
        """The whole object as compact JSON."""
        with self.lock:
            data = self._load()
            if self._data is None:  # no file yet
                return b"{}"
            if self._body is None:
                self._body = json.dumps(data, ensure_ascii=False, sort_keys=True,
                                        separators=(",", ":")).encode("utf-8", "backslashreplace")
            return self._body

    def apply(self, image_id: str, by: str, changes: dict, base: dict | None = None) -> dict:
        """Apply the fields that differ from the stored record; return the record.

        With `base` (the values the editor started from), a field someone
        else has changed since -- to anything but this same new value --
        raises Conflict and nothing is written.
        """
        with self.lock:
            data = self._load()
            current = data.get(image_id)
            if current is not None and not isinstance(current, dict):
                raise StoreError(f"the stored record for {image_id} is not an object; fix annotations.json")
            # Copy-on-write: the cached object is never changed in place, so a
            # failed save leaves both the file and the cache as they were.
            record = blank_record()
            record.update(current or {})
            if base:
                stale = [f for f, b in base.items() if record.get(f) != b and record.get(f) != changes[f]]
                if stale:
                    raise Conflict(stale[0], record)
            diff = {}
            for field, new in changes.items():
                old = record.get(field)
                if old != new:
                    diff[field] = [old, new]
                    record[field] = new
            if not diff:
                return record
            now = utc_now()
            history = record.get("history")
            history = list(history) if isinstance(history, list) else []
            history.append({"at": now, "by": by, "changes": diff})
            record["history"] = history[-HISTORY_LIMIT:]
            record["updated_at"] = now
            record["updated_by"] = by
            updated = dict(data)
            updated[image_id] = record
            self._save(updated)
            return record

    def _save(self, data: dict) -> None:
        """Write via a temp file and os.replace (call with the lock held)."""
        # Pretty-printed with sorted keys so the committed file diffs cleanly.
        text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        payload = text.encode("utf-8", "backslashreplace")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".annotations-", suffix=".tmp", dir=self.path.parent)
        except OSError as exc:
            raise StoreError("could not save annotations.json; no edits were saved") from exc
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(payload)
                out.flush()
                os.fsync(out.fileno())
            if os.name != "nt":  # mkstemp makes the file private; keep the old file's mode
                with contextlib.suppress(OSError):
                    os.chmod(tmp, stat.S_IMODE(os.stat(self.path).st_mode))
            _retry_busy(lambda: os.replace(tmp, self.path))
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise StoreError("could not save annotations.json (is another program holding it open?); "
                             "no edits were saved, try again") from exc
        try:
            stamp = _stamp(os.stat(self.path))
        except OSError:
            stamp = None  # re-read on the next request
        self._data, self._stamp, self._body = data, stamp, None


# ------------------------------------------------------------- static files

def resolve_static(root: Path, url_path: str) -> Path | None:
    """Map a URL path (still percent-encoded) to a path inside root, or None if it is refused.

    Refused: bad UTF-8, control characters, backslashes, "." or ".." segments
    and other dotfiles (also when a short name or link resolves to one),
    drive letters and stream names (":"), Windows device names, segments
    ending in a dot or space, and anything that resolves (through links)
    outside root.
    """
    try:
        decoded = urllib.parse.unquote(url_path, errors="strict")
    except UnicodeDecodeError:
        return None
    if "\\" in decoded or any(ord(ch) < 32 or ord(ch) == 127 for ch in decoded):
        return None
    parts = [part for part in decoded.split("/") if part]
    for part in parts:
        if part.startswith(".") or part.endswith((".", " ")) or ":" in part or _WIN_DEVICE.match(part):
            return None
    try:
        target = Path(os.path.realpath(root.joinpath(*parts)))
    except (OSError, ValueError):
        return None
    if target != root and root not in target.parents:
        return None
    # Check the names it resolved to as well: on NTFS an 8.3 alias (ENV~1 for
    # .env, GIT~1 for .git) or a link can lead to a dotfile.
    if any(part.startswith(".") or part.endswith((".", " ")) for part in target.relative_to(root).parts):
        return None
    return target


def cache_control(relative: str) -> str:
    """Cache-Control for a file, by its path relative to the site root.

    Everything revalidates: build.py rewrites images/<id>.* and their thumbs
    in place when more of a picture arrives, and vendor files keep
    unversioned names. An unchanged file costs a 304 (Last-Modified /
    If-Modified-Since)."""
    return "no-cache"


# -------------------------------------------------------------------- server

def _stderr_log(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def split_url(raw: str) -> urllib.parse.SplitResult:
    """urlsplit that never raises; an unparseable target gets a path no file or route matches."""
    try:
        return urllib.parse.urlsplit(raw or "")
    except ValueError:  # e.g. "http://[" (bad IPv6 literal)
        return urllib.parse.SplitResult("", "", "\x00", "", "")


def _printable(text: str, limit: int = 200) -> str:
    """Escape control characters (no terminal tricks in the log) and cap the length."""
    if len(text) > limit:
        text = text[:limit] + "..."
    return "".join(ch if 32 <= ord(ch) < 127 or ord(ch) > 159 else f"\\x{ord(ch):02x}" for ch in text)


class Gallery:
    """What the request handlers share: the site root, edit settings and the two data files."""

    def __init__(self, site, edit_key: str | None = None, read_only: bool = False, log=None, allow_hosts=()):
        self.root = Path(os.path.realpath(site))
        self.edit_key = edit_key or None
        self.read_only = read_only
        self.allow_hosts = frozenset(h.strip().lower().rstrip(".") for h in allow_hosts if h.strip())
        self.images = ImageIndex(self.root / "data" / "images.json")
        self.store = AnnotationStore(self.root / "data" / "annotations.json")
        self.log = log or _stderr_log
        self._key_digest = hashlib.sha256(self.edit_key.encode("utf-8")).digest() if self.edit_key else None

    @property
    def mode(self) -> str:
        if self.read_only:
            return "off"
        return "key" if self.edit_key else "open"

    def key_ok(self, supplied) -> bool:
        if self._key_digest is None:
            return True
        if not isinstance(supplied, str):
            return False
        # Hash both sides so the comparison is constant-time even for the length.
        digest = hashlib.sha256(supplied.encode("utf-8", "surrogatepass")).digest()
        return hmac.compare_digest(digest, self._key_digest)

    def host_ok(self, header) -> bool:
        """With open edits, refuse a Host this server doesn't answer to: a page
        whose name was rebound to this machine (DNS rebinding) counts as same-origin."""
        if self.mode != "open" or header is None:
            return True  # key mode needs the key anyway; no Host = not a browser
        try:
            name = (urllib.parse.urlsplit("//" + header.strip()).hostname or "").rstrip(".")
        except ValueError:
            return False
        if name == "localhost" or name.endswith(".localhost") or name in self.allow_hosts:
            return True
        if name == socket.gethostname().lower():
            return True
        try:
            ipaddress.ip_address(name)
        except ValueError:
            return False
        return True


class GalleryHandler(SimpleHTTPRequestHandler):
    server_version = "GalleryServer"
    sys_version = ""
    protocol_version = "HTTP/1.1"  # keep-alive; every response carries a Content-Length
    timeout = 30                   # seconds an idle or slow connection may hold a thread
    _cache = None                  # Cache-Control for the response being built

    # --- plumbing

    def version_string(self):
        return self.server_version  # no Python version in the Server header

    def handle_one_request(self):
        self._cache = None
        self.path = ""  # so a malformed request on a kept-alive connection isn't logged as the previous one
        super().handle_one_request()

    def end_headers(self):
        self.send_header("Cache-Control", self._cache or "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # One short line per request: no query string, body or key.
        path = split_url(getattr(self, "path", None)).path or "-"
        status = code.value if isinstance(code, HTTPStatus) else code
        self.server.gallery.log(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.address_string()} "
                                f"{_printable(self.command or '-', 16)} {_printable(path)} {status}")

    def log_error(self, format, *args):
        pass  # the request line logged by log_request is enough

    def log_message(self, format, *args):
        self.server.gallery.log(_printable(format % args, 500))

    def _send_json(self, status: int, obj, head: bool = False, close: bool = False) -> None:
        # backslashreplace: a lone surrogate (from a hand-edited file) becomes a
        # valid \udXXX escape instead of a crash.
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8", "backslashreplace")
        self._send_json_bytes(status, body, head, close)

    def _send_json_bytes(self, status: int, body: bytes, head: bool = False, close: bool = False) -> None:
        self._cache = "no-store"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            self.send_header("Connection", "close")  # also sets close_connection
        self.end_headers()
        if not head:
            self.wfile.write(body)

    # --- GET and HEAD

    def do_GET(self):
        self._get(head=False)

    def do_HEAD(self):
        self._get(head=True)

    def _get(self, head: bool) -> None:
        path = split_url(self.path).path
        if path == "/api" or path.startswith("/api/"):
            gallery = self.server.gallery
            if path == "/api/annotations":
                try:
                    body = gallery.store.snapshot()
                except StoreError as exc:
                    gallery.log(f"error: {exc}")
                    self._send_json(500, {"error": str(exc)}, head)
                    return
                self._send_json_bytes(200, body, head)
            elif path == "/api/health":
                self._send_json(200, {"ok": True, "edits": gallery.mode}, head)
            else:
                self._send_json(404, {"error": "not found"}, head)
            return
        f = self.send_head()
        if f:
            try:
                if not head:
                    self.copyfile(f, self.wfile)
            finally:
                f.close()

    def translate_path(self, path):
        # Not used by send_head below; kept safe in case a base-class method calls it.
        target = resolve_static(self.server.gallery.root, split_url(path).path)
        return str(target) if target is not None else ""

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")  # never list directories
        return None

    def guess_type(self, path):
        return CONTENT_TYPES.get(os.path.splitext(str(path))[1].lower(), "application/octet-stream")

    def send_head(self):
        """Send the headers for a static file and return it open, or answer and return None."""
        root = self.server.gallery.root
        url = split_url(self.path)
        target = resolve_static(root, url.path)
        if target is not None and target.is_dir():
            if not url.path.endswith("/"):
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", url.path + "/" + ("?" + url.query if url.query else ""))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            target = resolve_static(root, url.path + "index.html")  # index.html or 404, never a listing
        elif url.path.endswith("/"):
            target = None  # "/index.html/" is not a directory
        if target is None or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None
        try:
            f = open(target, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None
        try:
            fs = os.fstat(f.fileno())
            if "If-Modified-Since" in self.headers and "If-None-Match" not in self.headers:
                try:
                    since = email.utils.parsedate_to_datetime(self.headers["If-Modified-Since"])
                except (TypeError, IndexError, OverflowError, ValueError):
                    since = None
                if since is not None:
                    if since.tzinfo is None:
                        since = since.replace(tzinfo=timezone.utc)
                    modified = datetime.fromtimestamp(fs.st_mtime, timezone.utc).replace(microsecond=0)
                    if modified <= since:
                        self._cache = cache_control(target.relative_to(root).as_posix())
                        self.send_response(HTTPStatus.NOT_MODIFIED)
                        self.end_headers()
                        f.close()
                        return None
            self._cache = cache_control(target.relative_to(root).as_posix())
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", self.guess_type(target))
            self.send_header("Content-Length", str(fs.st_size))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            return f
        except BaseException:
            f.close()
            raise

    # --- POST

    def do_POST(self):
        gallery = self.server.gallery
        try:
            body = self._read_body()
            match = _ANNOTATION_ROUTE.match(split_url(self.path).path)
            if not match:
                raise ApiError(404, "not found")
            if gallery.read_only:
                raise ApiError(403, "editing is turned off")
            if self._cross_site():
                raise ApiError(403, "cross-site requests are not allowed")
            if not gallery.host_ok(self.headers.get("Host")):
                raise ApiError(403, "unexpected Host header; open edits accept localhost or an IP address "
                                    "(use --allow-host NAME, or an edit key)")
            payload = parse_json(body)
            if not isinstance(payload, dict):
                raise ApiError(400, "body must be a JSON object")
            if not gallery.key_ok(payload.get("key")):
                raise ApiError(403, "edit key required")
            image_id = urllib.parse.unquote(match.group(1))
            if image_id not in gallery.images.ids():
                raise ApiError(404, "unknown image id")
            by, changes, base = validate_edit(payload)
            record = gallery.store.apply(image_id, by, changes, base)
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message}, close=exc.close)
            return
        except Conflict as exc:
            who = exc.record.get("updated_by") or "someone else"
            self._send_json(409, {"error": f"the {exc.field} was changed by {who} since you opened this "
                                           "picture; check it and save again", "record": exc.record})
            return
        except StoreError as exc:
            gallery.log(f"error: {exc}" + (f" ({exc.__cause__!r})" if exc.__cause__ else ""))
            self._send_json(500, {"error": str(exc)})
            return
        self._send_json(200, record)

    def _read_body(self) -> bytes:
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            raise ApiError(400, "send the body with a Content-Length (chunked bodies are not supported)",
                           close=True)
        raw = (self.headers.get("Content-Length") or "").strip()
        if not (raw.isascii() and raw.isdigit()):
            raise ApiError(400, "Content-Length required", close=True)
        length = int(raw)
        if length > MAX_BODY:
            if length <= MAX_DRAIN:
                self._discard(length)  # so the client reads the 413 instead of a reset connection
            raise ApiError(413, f"body too large (limit {MAX_BODY // 1024} KB)", close=True)
        body = self.rfile.read(length)
        if len(body) != length:
            raise ApiError(400, "incomplete body", close=True)
        return body

    def _discard(self, length: int) -> None:
        with contextlib.suppress(OSError):
            while length > 0:
                chunk = self.rfile.read(min(length, 65536))
                if not chunk:
                    break
                length -= len(chunk)

    def _cross_site(self) -> bool:
        """True for a browser request sent by a page from another origin (CSRF)."""
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None:
            return site.strip().lower() not in ("same-origin", "none")
        origin = self.headers.get("Origin")
        if origin is None:
            return False  # not from a browser page (curl, scripts, tests)
        host = (self.headers.get("Host") or "").strip().lower()
        return split_url(origin.strip()).netloc.lower() != host


class GalleryServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR would let a second server bind the same port and
    # silently take requests; elsewhere it only allows a quick restart.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address: tuple, gallery: Gallery):
        self.gallery = gallery
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, partial(GalleryHandler, directory=str(gallery.root)))

    def server_bind(self):
        # HTTPServer.server_bind does a reverse DNS lookup (getfqdn) that can
        # stall for seconds on Windows; the name is never used.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # the browser went away mid-response (e.g. a cancelled image load)
        super().handle_error(request, client_address)


def make_server(site, host: str = "127.0.0.1", port: int = 8000, edit_key: str | None = None,
                read_only: bool = False, log=None, allow_hosts=()) -> GalleryServer:
    """Build (and bind) a server; call serve_forever() on it, and shutdown()/server_close() to stop."""
    return GalleryServer((host, port), Gallery(site, edit_key, read_only, log, allow_hosts))


def _display_url(host: str, port: int) -> str:
    if host in ("", "0.0.0.0", "::"):
        host = "localhost"
    if ":" in host:
        host = f"[{host}]"
    return f"http://{host}:{port}/"


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Serve the gallery site and store members' edits.")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on (default 127.0.0.1; 0.0.0.0 for the whole LAN)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000; 0 picks a free one)")
    parser.add_argument("--site", default=None, help="folder to serve (default: site/ next to serve.py)")
    parser.add_argument("--edit-key", default=None,
                        help="key members must send to save edits (or set GALLERY_EDIT_KEY)")
    parser.add_argument("--read-only", action="store_true", help="turn editing off")
    parser.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                        help="with open edits, also accept this host name (e.g. a LAN name or a reverse proxy's domain)")
    args = parser.parse_args(argv)

    site = Path(args.site) if args.site else here / "site"
    if not site.is_dir():
        parser.error(f"site folder not found: {site}")
    # The form trims what members type, so a key with spaces round it could never be entered.
    raw_key = args.edit_key if args.edit_key is not None else os.environ.get("GALLERY_EDIT_KEY")
    key = (raw_key or "").strip()
    if raw_key and not key:
        parser.error("the edit key is blank (only spaces); set a real key or leave it unset")
    try:
        server = make_server(site, args.host, args.port, key or None, args.read_only, allow_hosts=args.allow_host)
    except (OSError, OverflowError) as exc:  # port in use, bad address, port out of range
        print(f"Could not listen on {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1

    gallery = server.gallery
    host, port = server.server_address[:2]
    print(f"Serving {gallery.root} at {_display_url(args.host, port)}", flush=True)
    if host in ("", "0.0.0.0", "::"):
        print("Listening on every network interface.", flush=True)
    if gallery.mode == "off":
        print("Edits: off (read-only).", flush=True)
    elif gallery.mode == "key":
        print("Edits: key-protected (saving needs the edit key).", flush=True)
    else:
        print("Edits: open (anyone who can reach this server can edit).", flush=True)
        if not (host.startswith("127.") or host in ("::1", "localhost")):
            print("Warning: this address may be reachable by others; consider --edit-key or GALLERY_EDIT_KEY.",
                  flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
