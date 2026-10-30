"""Tests for serve.py. From the repo root:

    .venv\\Scripts\\python.exe -m unittest tests.test_serve -v

Each test starts its own server on a free port against a throwaway copy of a
minimal site, so the real site/data is never touched.
"""
from __future__ import annotations

import http.client
import json
import os
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import serve  # noqa: E402

ID_A = "2026-09-17-071148z"
ID_B = "2026-09-20-023700z"
SECRET = b"TOPSECRET outside the site root"
VALID = {"by": "Tester", "changes": {"title": "A title"}}

SITE_FILES = {
    "index.html": b"<!doctype html><title>Gallery</title>",
    "assets/app.js": b"console.log('app');",
    "assets/mod.mjs": b"export const x = 1;",
    "assets/style.css": b"body { margin: 0 }",
    "assets/icon.svg": b"<svg xmlns='http://www.w3.org/2000/svg'/>",
    "images/a.jpg": b"\xff\xd8\xff\xe0 not really a jpeg",
    "images/b.webp": b"RIFF\x00\x00\x00\x00WEBP",
    "images/c.png": b"\x89PNG\r\n\x1a\n",
    "images/thumbs/a.jpg": b"\xff\xd8\xff\xe0 thumb",
    "globe/index.html": b"<!doctype html><title>Globe</title>",
    "globe/vendor/lib.js": b"var lib = 1;",
    "data/tle.json": b"[]",
    "data/annotations.json": b"{}",
    ".hidden": b"hidden file",
    "unknown.xyz": b"???",
}


def build_site(base: Path) -> Path:
    """A minimal site in base/site, plus base/secret.txt just outside it."""
    site = base / "site"
    for name, content in SITE_FILES.items():
        path = site / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    images = {"generated_at": "2026-10-29T10:30:00Z",
              "images": [{"id": ID_A, "title": "17 Sep 2026, 07:11 UTC"},
                         {"id": ID_B, "title": "20 Sep 2026, 02:37 UTC"}]}
    (site / "data" / "images.json").write_text(json.dumps(images, indent=1), encoding="utf-8")
    (base / "secret.txt").write_bytes(SECRET)
    return site


def http_request(port: int, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    """Send one request with the path exactly as given; return (status, headers, body)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def http_post(port: int, image_id: str, payload=None, raw: bytes | None = None, headers: dict | None = None):
    body = raw if raw is not None else json.dumps(payload).encode("utf-8")
    all_headers = {"Content-Type": "application/json", **(headers or {})}
    status, _, data = http_request(port, "POST", f"/api/annotations/{image_id}", body, all_headers)
    return status, (json.loads(data) if data else None)


class ServerTestCase(unittest.TestCase):
    """Starts serve.py in a thread for each test, against a fresh temporary site."""

    edit_key: str | None = None
    read_only = False

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.site = build_site(self.base)
        self.annotations = self.site / "data" / "annotations.json"
        self.logs: list[str] = []
        self.server = serve.make_server(self.site, "127.0.0.1", 0, edit_key=self.edit_key,
                                        read_only=self.read_only, log=self.logs.append)
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                  daemon=True)
        thread.start()
        # Cleanups run last-in first-out: stop the loop, close the socket, wait, remove the files.
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, headers=None):
        return http_request(self.port, method, path, body, headers)

    def get_json(self, path):
        status, headers, body = self.request("GET", path)
        self.assertEqual(headers["content-type"], "application/json")
        return status, json.loads(body)

    def post(self, image_id, payload=None, raw=None, headers=None):
        return http_post(self.port, image_id, payload, raw, headers)

    def stored(self) -> dict:
        return json.loads(self.annotations.read_text(encoding="utf-8"))

    def assertNoTempFiles(self):
        self.assertEqual(sorted(p.name for p in self.annotations.parent.iterdir() if p.name.startswith(".")), [])


class StaticFileTests(ServerTestCase):
    def test_files_are_served_with_the_right_content_type(self):
        cases = [
            ("/", "text/html", "index.html"),
            ("/index.html", "text/html", "index.html"),
            ("/assets/app.js", "text/javascript", "assets/app.js"),
            ("/assets/mod.mjs", "text/javascript", "assets/mod.mjs"),
            ("/assets/style.css", "text/css", "assets/style.css"),
            ("/assets/icon.svg", "image/svg+xml", "assets/icon.svg"),
            ("/data/annotations.json", "application/json", "data/annotations.json"),
            ("/data/tle.json", "application/json", "data/tle.json"),
            ("/images/a.jpg", "image/jpeg", "images/a.jpg"),
            ("/images/b.webp", "image/webp", "images/b.webp"),
            ("/images/c.png", "image/png", "images/c.png"),
            ("/images/thumbs/a.jpg", "image/jpeg", "images/thumbs/a.jpg"),
            ("/globe/", "text/html", "globe/index.html"),
            ("/unknown.xyz", "application/octet-stream", "unknown.xyz"),
        ]
        for path, content_type, name in cases:
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-type"].split(";")[0], content_type)
                self.assertEqual(body, SITE_FILES[name])
                self.assertEqual(int(headers["content-length"]), len(body))
                self.assertIn("last-modified", headers)

    def test_cache_control(self):
        # Pictures are rebuilt in place as more of them arrives, and vendor
        # files have unversioned names: everything revalidates.
        no_cache = ["/", "/index.html", "/data/images.json", "/data/annotations.json", "/assets/app.js",
                    "/images/a.jpg", "/images/thumbs/a.jpg", "/globe/vendor/lib.js"]
        for path in no_cache:
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[1]["cache-control"], "no-cache")
        self.assertEqual(self.request("GET", "/api/annotations")[1]["cache-control"], "no-store")

    def test_a_rebuilt_picture_is_fetched_again(self):
        status, headers, _ = self.request("GET", "/images/a.jpg")
        since = {"If-Modified-Since": headers["last-modified"]}
        self.assertEqual(self.request("GET", "/images/a.jpg", headers=since)[0], 304)
        path = self.site / "images" / "a.jpg"
        path.write_bytes(b"\xff\xd8 rebuilt")
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        status, _, body = self.request("GET", "/images/a.jpg", headers=since)
        self.assertEqual((status, body), (200, b"\xff\xd8 rebuilt"))

    @unittest.skipUnless(os.name == "nt", "8.3 short names are a Windows feature")
    def test_dotfile_short_names_are_404(self):
        import ctypes

        (self.site / ".git").mkdir()
        (self.site / ".git" / "config").write_bytes(b"secret")
        checked = 0
        for long_path, suffix in [(self.site / ".hidden", ""), (self.site / ".git", "/config")]:
            buf = ctypes.create_unicode_buffer(1024)
            if not ctypes.windll.kernel32.GetShortPathNameW(str(long_path), buf, 1024):
                continue
            alias = Path(buf.value).name
            if alias == long_path.name:
                continue  # no 8.3 name on this volume
            checked += 1
            with self.subTest(alias=alias):
                self.assertEqual(self.request("GET", "/" + alias + suffix)[0], 404)
        if not checked:
            self.skipTest("8.3 name generation is off on this volume")

    def test_security_headers_on_every_response(self):
        responses = [self.request("GET", "/"), self.request("GET", "/missing.html"),
                     self.request("GET", "/api/health"), self.request("GET", "/api/missing"),
                     self.request("HEAD", "/images/a.jpg"), self.request("GET", "/globe")]
        responses.append(http_request(self.port, "POST", "/api/annotations/nope", b"{}"))
        for status, headers, _ in responses:
            with self.subTest(status=status):
                self.assertEqual(headers.get("x-content-type-options"), "nosniff")
                self.assertEqual(headers.get("referrer-policy"), "same-origin")

    def test_directories_never_list(self):
        for path in ["/images/", "/images/thumbs/", "/assets/", "/data/"]:
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertNotIn(b".jpg", body)
                self.assertNotIn(b".json", body)

    def test_directory_without_slash_redirects(self):
        status, headers, _ = self.request("GET", "/globe")
        self.assertEqual((status, headers["location"]), (301, "/globe/"))
        status, headers, _ = self.request("GET", "/globe?view=orbit")
        self.assertEqual((status, headers["location"]), (301, "/globe/?view=orbit"))

    def test_missing_hidden_and_odd_paths_are_404(self):
        for path in ["/missing.html", "/.hidden", "/%2ehidden", "/index.html/", "/data/.annotations-x.tmp",
                     "/images/missing.jpg", "/a%2ab", "/a%3fb", "/a%22b", "/a%3cb%3e", "/a%7cb", "/%e2%80%ae",
                     "/" + "x" * 3000]:
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_odd_request_targets(self):
        # Unparseable target (http.client won't send one, so use a raw socket): refused, no crash.
        with socket.create_connection(("127.0.0.1", self.port), timeout=15) as sock:
            sock.sendall(b"GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            reply = b""
            while chunk := sock.recv(65536):
                reply += chunk
        self.assertTrue(reply.startswith(b"HTTP/1.1 404 "), reply[:80])
        status, _, body = self.request("GET", f"http://127.0.0.1:{self.port}/index.html")  # absolute form
        self.assertEqual((status, body), (200, SITE_FILES["index.html"]))
        self.assertEqual(self.request("GET", "/")[0], 200)  # and the server is still fine

    def test_head_and_conditional_get(self):
        status, headers, body = self.request("HEAD", "/index.html")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(int(headers["content-length"]), len(SITE_FILES["index.html"]))
        status, headers, body = self.request("GET", "/index.html",
                                             headers={"If-Modified-Since": headers["last-modified"]})
        self.assertEqual((status, body), (304, b""))

    def test_post_to_a_static_path_is_refused(self):
        status, body = http_post(self.port, "x/../../index.html", VALID)
        self.assertEqual(status, 404)
        status, headers, body = self.request("POST", "/index.html", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "not found"})


class TraversalTests(ServerTestCase):
    ATTEMPTS = [
        "/../secret.txt",
        "/../../secret.txt",
        "/%2e%2e/secret.txt",
        "/%2E%2E/secret.txt",
        "/.%2e/secret.txt",
        "/..%2fsecret.txt",
        "/%2e%2e%2fsecret.txt",
        "/..%5csecret.txt",
        "/%2e%2e%5csecret.txt",
        "/..\\secret.txt",
        "/images\\..\\..\\secret.txt",
        "/%5c..%5csecret.txt",
        "/images/..%2f..%2fsecret.txt",
        "/images/%2e%2e/%2e%2e/secret.txt",
        "/images/thumbs/../../../secret.txt",
        "/%252e%252e/secret.txt",
        "/..%c0%afsecret.txt",
        "/..%20/secret.txt",
        "/...%2fsecret.txt",
        "/%00",
        "/index.html%00.txt",
        "/con",
        "/NUL",
        "/aux.txt",
        "/images/com1.jpg",
        "/C:/Windows/win.ini",
        "/C:%5cWindows%5cwin.ini",
        "/c%3a/windows/win.ini",
        "/index.html::$DATA",
        "/index.html.",
    ]

    def test_traversal_attempts_are_rejected(self):
        absolute = (self.base / "secret.txt").resolve().as_posix()
        extra = ["/" + urllib.parse.quote(absolute, safe="/:"),
                 "/" + urllib.parse.quote(absolute.replace("/", "\\"), safe=":")]
        for path in self.ATTEMPTS + extra:
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertIn(status, (400, 404))
                self.assertNotIn(SECRET, body)

    def test_resolver_refuses_them_outright(self):
        root = Path(os.path.realpath(self.site))
        self.assertEqual(serve.resolve_static(root, "/images/a.jpg"), root / "images" / "a.jpg")
        self.assertEqual(serve.resolve_static(root, "/"), root)
        for path in self.ATTEMPTS:
            with self.subTest(path=path):
                target = serve.resolve_static(root, path)
                if path == "/%252e%252e/secret.txt":
                    # Decoded once, this is a harmless (missing) file name inside the root.
                    self.assertEqual(target, root / "%2e%2e" / "secret.txt")
                else:
                    self.assertIsNone(target)


class ApiTests(ServerTestCase):
    def test_health(self):
        self.assertEqual(self.get_json("/api/health"), (200, {"ok": True, "edits": "open"}))

    def test_get_annotations(self):
        self.assertEqual(self.get_json("/api/annotations"), (200, {}))
        record = {"title": "Kept", "history": []}
        self.annotations.write_text(json.dumps({ID_B: record}), encoding="utf-8")
        self.assertEqual(self.get_json("/api/annotations"), (200, {ID_B: record}))
        status, headers, body = self.request("HEAD", "/api/annotations")
        self.assertEqual((status, body), (200, b""))

    def test_unknown_api_routes_are_404(self):
        for path in ["/api", "/api/", "/api/annotations/", f"/api/annotations/{ID_A}", "/api/other"]:
            with self.subTest(path=path):
                self.assertEqual(self.get_json(path), (404, {"error": "not found"}))

    def test_valid_post_saves_the_record_and_a_history_entry(self):
        changes = {"title": "Clouds over Hudson Bay", "notes": "First image after the fix.\nSecond line.",
                   "people": ["Jordan K."], "tags": ["clouds", "arctic"],
                   "captured_at": "2026-09-17T07:11:48Z", "lat": 58.5, "lon": -85, "place": "Hudson Bay"}
        # A key sent to a server that has none is simply ignored.
        status, record = self.post(ID_A, {"by": "Jordan K.", "key": "unused", "changes": changes})
        self.assertEqual(status, 200, record)
        self.assertEqual({k: record[k] for k in changes}, {**changes, "lon": -85.0})
        self.assertRegex(record["updated_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(record["updated_by"], "Jordan K.")
        self.assertEqual(record["history"], [{
            "at": record["updated_at"], "by": "Jordan K.",
            "changes": {"title": [None, "Clouds over Hudson Bay"],
                        "notes": [None, "First image after the fix.\nSecond line."],
                        "people": [[], ["Jordan K."]], "tags": [[], ["clouds", "arctic"]],
                        "captured_at": [None, "2026-09-17T07:11:48Z"],
                        "lat": [None, 58.5], "lon": [None, -85.0], "place": [None, "Hudson Bay"]}}])
        # On disk: pretty-printed with sorted keys, and the same as the API returns.
        text = self.annotations.read_text(encoding="utf-8")
        self.assertEqual(json.loads(text), {ID_A: record})
        self.assertEqual(text, json.dumps({ID_A: record}, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
        self.assertNotIn("unused", text)
        self.assertEqual(self.get_json("/api/annotations"), (200, {ID_A: record}))
        self.assertNoTempFiles()

    def test_only_changed_fields_are_applied(self):
        self.post(ID_A, {"by": "Ann", "changes": {"title": "One", "tags": ["x"]}})
        status, record = self.post(ID_A, {"by": "Ben", "changes": {"title": "One", "tags": ["x"], "notes": "New"}})
        self.assertEqual(status, 200)
        self.assertEqual(record["history"][-1]["changes"], {"notes": [None, "New"]})
        self.assertEqual(record["updated_by"], "Ben")

        before = self.annotations.read_bytes()
        status, record = self.post(ID_A, {"by": "Cat", "changes": {"title": "One", "notes": "New"}})
        self.assertEqual(status, 200)
        self.assertEqual((len(record["history"]), record["updated_by"]), (2, "Ben"))
        self.assertEqual(self.annotations.read_bytes(), before)  # nothing changed, nothing written

        status, record = self.post(ID_A, {"by": "Cat", "changes": {"title": None, "tags": []}})
        self.assertEqual(record["history"][-1]["changes"], {"title": ["One", None], "tags": [["x"], []]})
        self.assertEqual((record["title"], record["tags"], record["notes"]), (None, [], "New"))

        # A no-op edit of a photo without a record doesn't create one.
        status, record = self.post(ID_B, {"by": "Cat", "changes": {"title": None, "people": []}})
        self.assertEqual((status, record["history"]), (200, []))
        self.assertNotIn(ID_B, self.stored())

    def test_values_are_cleaned_and_normalised(self):
        status, record = self.post(ID_A, {"by": "  Jordan\x00 K.  ", "changes": {
            "title": "  Clouds\nover\tHudson Bay\x07 ",
            "notes": "line one\r\nline two\x1b[0m\u202e",
            "place": "",
            "people": ["Jordan K.", "jordan k.", " Sam\x07 "],
            "tags": ["  Clouds ", "clouds", "Arctic", "CLOUDS", "arctic "],
            "captured_at": "2026-09-17T07:11:48.987654+00:00",
            "lat": 51, "lon": -114.07}})
        self.assertEqual(status, 200, record)
        self.assertEqual(record["updated_by"], "Jordan K.")
        self.assertEqual(record["title"], "Clouds over Hudson Bay")
        self.assertEqual(record["notes"], "line one\nline two[0m")
        self.assertIsNone(record["place"])
        self.assertEqual(record["people"], ["Jordan K.", "Sam"])
        self.assertEqual(record["tags"], ["Clouds", "Arctic"])
        self.assertEqual(record["captured_at"], "2026-09-17T07:11:48Z")
        self.assertEqual((record["lat"], record["lon"]), (51.0, -114.07))
        for given, expected in [("2026-09-17 08:00:00z", "2026-09-17T08:00:00Z"),
                                ("2026-09-17T09:30Z", "2026-09-17T09:30:00Z"),
                                ("2026-09-17T10:00:00.5-00:00", "2026-09-17T10:00:00Z"),
                                (None, None)]:
            with self.subTest(captured_at=given):
                status, record = self.post(ID_A, {"by": "T", "changes": {"captured_at": given}})
                self.assertEqual((status, record["captured_at"]), (200, expected))
        status, record = self.post(ID_A, {"by": "T", "changes": {"lat": -90, "lon": 180}})
        self.assertEqual((status, record["lat"], record["lon"]), (200, -90.0, 180.0))
        status, record = self.post(ID_A, {"by": "x" * 80, "changes": {"title": "t" * 2000,
                                                                      "tags": ["y" * 60] + [f"t{i}" for i in range(49)]}})
        self.assertEqual((status, len(record["title"]), len(record["tags"])), (200, 2000, 50))

    BAD_BODIES = [
        ("not JSON", b"{oops"),
        ("a JSON array", b"[1, 2]"),
        ("a JSON string", b'"hello"'),
        ("NaN", b'{"by": "T", "changes": {"lat": NaN}}'),
        ("Infinity", b'{"by": "T", "changes": {"lon": -Infinity}}'),
        ("invalid UTF-8", b'{"by": "\xff\xfe", "changes": {}}'),
        ("empty", b""),
        ("lone surrogate in a field name", b'{"by":"x","changes":{"\\ud800":1}}'),
        ("lone surrogate in a top-level key", b'{"\\udc00":1,"by":"x","changes":{}}'),
    ]
    BAD_PAYLOADS = [
        ("by missing", {"changes": {"title": "x"}}),
        ("by empty", {"by": "", "changes": {"title": "x"}}),
        ("by blank", {"by": "  \t ", "changes": {"title": "x"}}),
        ("by only control characters", {"by": "\x00\x07", "changes": {"title": "x"}}),
        ("by too long", {"by": "x" * 81, "changes": {"title": "x"}}),
        ("by not a string", {"by": 7, "changes": {"title": "x"}}),
        ("changes missing", {"by": "T"}),
        ("changes not an object", {"by": "T", "changes": [["title", "x"]]}),
        ("unknown field", {"by": "T", "changes": {"colour": "red"}}),
        ("unknown top-level field", {"by": "T", "changes": {}, "admin": True}),
        ("history is not editable", {"by": "T", "changes": {"history": []}}),
        ("updated_by is not editable", {"by": "T", "changes": {"updated_by": "x"}}),
        ("title not a string", {"by": "T", "changes": {"title": 5}}),
        ("title too long", {"by": "T", "changes": {"title": "x" * 2001}}),
        ("notes too long", {"by": "T", "changes": {"notes": "x" * 2001}}),
        ("notes a list", {"by": "T", "changes": {"notes": ["x"]}}),
        ("place too long", {"by": "T", "changes": {"place": "x" * 2001}}),
        ("place an object", {"by": "T", "changes": {"place": {"name": "x"}}}),
        ("people not a list", {"by": "T", "changes": {"people": "Jordan"}}),
        ("people too many", {"by": "T", "changes": {"people": [f"p{i}" for i in range(51)]}}),
        ("people empty entry", {"by": "T", "changes": {"people": [""]}}),
        ("people blank entry", {"by": "T", "changes": {"people": ["   "]}}),
        ("people entry too long", {"by": "T", "changes": {"people": ["x" * 61]}}),
        ("people entry not a string", {"by": "T", "changes": {"people": [None]}}),
        ("tags not a list", {"by": "T", "changes": {"tags": {"a": 1}}}),
        ("tags too many", {"by": "T", "changes": {"tags": [f"t{i}" for i in range(51)]}}),
        ("tag too long", {"by": "T", "changes": {"tags": ["y" * 61]}}),
        ("tag a number", {"by": "T", "changes": {"tags": [3]}}),
        ("captured_at free text", {"by": "T", "changes": {"captured_at": "yesterday"}}),
        ("captured_at without a zone", {"by": "T", "changes": {"captured_at": "2026-09-17T07:11:48"}}),
        ("captured_at not UTC", {"by": "T", "changes": {"captured_at": "2026-09-17T07:11:48+02:00"}}),
        ("captured_at a date only", {"by": "T", "changes": {"captured_at": "2026-09-17"}}),
        ("captured_at impossible", {"by": "T", "changes": {"captured_at": "2026-02-30T00:00:00Z"}}),
        ("captured_at a number", {"by": "T", "changes": {"captured_at": 1789636308}}),
        ("lat above 90", {"by": "T", "changes": {"lat": 90.5}}),
        ("lat below -90", {"by": "T", "changes": {"lat": -91}}),
        ("lon above 180", {"by": "T", "changes": {"lon": 180.01}}),
        ("lon below -180", {"by": "T", "changes": {"lon": -181}}),
        ("lat a string", {"by": "T", "changes": {"lat": "51"}}),
        ("lon a boolean", {"by": "T", "changes": {"lon": True}}),
        ("lat huge", {"by": "T", "changes": {"lat": 10 ** 400}}),
        ("one bad field spoils the rest", {"by": "T", "changes": {"title": "fine", "lat": 100}}),
        ("base not an object", {"by": "T", "changes": {"title": "x"}, "base": ["title"]}),
        ("base for a field not being changed", {"by": "T", "changes": {"title": "x"}, "base": {"notes": None}}),
        ("base value invalid", {"by": "T", "changes": {"lat": 1}, "base": {"lat": "north"}}),
    ]

    def test_each_validation_error_is_a_400(self):
        self.post(ID_A, {"by": "Ann", "changes": {"title": "Saved"}})
        before = self.annotations.read_bytes()
        cases = [(name, raw) for name, raw in self.BAD_BODIES]
        cases += [(name, json.dumps(payload).encode("utf-8")) for name, payload in self.BAD_PAYLOADS]
        for name, raw in cases:
            with self.subTest(name):
                status, body = self.post(ID_A, raw=raw)
                self.assertEqual(status, 400, body)
                self.assertEqual(list(body), ["error"])
                self.assertIsInstance(body["error"], str)
        self.assertEqual(self.annotations.read_bytes(), before)  # nothing was lost or changed

    def test_body_size_limit(self):
        raw = json.dumps(VALID).encode("utf-8")
        exactly = raw + b" " * (serve.MAX_BODY - len(raw))
        self.assertEqual(self.post(ID_A, raw=exactly)[0], 200)
        status, body = self.post(ID_A, raw=exactly + b" ")
        self.assertEqual(status, 413)
        self.assertIn("error", body)
        # A huge declared length is refused without reading it.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.putrequest("POST", f"/api/annotations/{ID_A}")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(50 * 1024 * 1024))
            conn.endheaders()
            resp = conn.getresponse()
            self.assertEqual((resp.status, "error" in json.loads(resp.read())), (413, True))
        finally:
            conn.close()

    def test_missing_content_length_is_a_400(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.putrequest("POST", f"/api/annotations/{ID_A}")
            conn.putheader("Content-Type", "application/json")
            conn.endheaders()
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            self.assertIn("error", json.loads(resp.read()))
        finally:
            conn.close()

    def test_unknown_id_is_a_404(self):
        for image_id in ["2020-01-01-000000z", "nope", "..%2f..%2fsecret", "%2e%2e"]:
            with self.subTest(image_id=image_id):
                self.assertEqual(self.post(image_id, VALID), (404, {"error": "unknown image id"}))
        self.assertEqual(self.stored(), {})

    def test_history_keeps_the_newest_200(self):
        old = [{"at": "2026-10-01T00:00:00Z", "by": f"user{i}", "changes": {"notes": [None, f"n{i}"]}}
               for i in range(200)]
        seeded = {**serve.blank_record(), "notes": "n199", "history": old, "extra": "kept"}
        self.annotations.write_text(json.dumps({ID_A: seeded}), encoding="utf-8")
        status, record = self.post(ID_A, {"by": "Newest", "changes": {"notes": "n200"}})
        self.assertEqual(status, 200)
        self.assertEqual(len(record["history"]), 200)
        self.assertEqual(record["history"][0]["by"], "user1")
        self.assertEqual(record["history"][-1]["changes"], {"notes": ["n199", "n200"]})
        self.assertEqual(self.stored()[ID_A]["extra"], "kept")  # fields this server doesn't know survive

    def test_images_json_is_reread_when_it_changes(self):
        new_id = "2026-10-01-000000z"
        self.assertEqual(self.post(new_id, VALID)[0], 404)
        images_path = self.site / "data" / "images.json"
        images = json.loads(images_path.read_text(encoding="utf-8"))
        images["images"] = [{"id": new_id}, {"id": ID_A}]  # new_id added, ID_B gone
        tmp = images_path.with_name("images.json.tmp")
        tmp.write_text(json.dumps(images), encoding="utf-8")
        os.replace(tmp, images_path)  # the way the pipeline rewrites it
        st = os.stat(images_path)
        os.utime(images_path, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))  # make sure the mtime moves
        self.assertEqual(self.post(new_id, VALID)[0], 200)
        self.assertEqual(self.post(ID_B, VALID)[0], 404)

    def test_cross_site_browser_posts_are_refused(self):
        for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                        {"Origin": "http://evil.example"}, {"Origin": "null"}, {"Origin": "http://["},
                        {"Origin": "http://127.0.0.1.evil.example"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.post(ID_A, VALID, headers=headers)[0], 403)
        self.assertEqual(self.stored(), {})
        for headers in ({"Sec-Fetch-Site": "same-origin"}, {"Origin": f"http://127.0.0.1:{self.port}"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.post(ID_A, VALID, headers=headers)[0], 200)

    def test_open_edits_refuse_a_rebound_host_name(self):
        # A page whose DNS name was rebound to 127.0.0.1 is same-origin to the browser.
        rebound = {"Host": f"attacker.example:{self.port}", "Origin": f"http://attacker.example:{self.port}",
                   "Sec-Fetch-Site": "same-origin"}
        status, body = self.post(ID_A, VALID, headers=rebound)
        self.assertEqual(status, 403, body)
        self.assertEqual(self.stored(), {})
        for host in (f"localhost:{self.port}", f"[::1]:{self.port}", f"127.0.0.1:{self.port}", "LOCALHOST"):
            with self.subTest(host=host):
                self.assertEqual(self.post(ID_A, VALID, headers={"Host": host})[0], 200)

    def test_a_named_host_can_be_allowed(self):
        server = serve.make_server(self.site, "127.0.0.1", 0, log=self.logs.append, allow_hosts=("LabPC.lan.",))
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertEqual(http_post(port, ID_A, VALID, headers={"Host": f"labpc.lan:{port}"})[0], 200)
        self.assertEqual(http_post(port, ID_A, VALID, headers={"Host": f"other.lan:{port}"})[0], 403)

    def test_a_stale_edit_is_refused_not_lost(self):
        status, record = self.post(ID_A, {"by": "Ann", "changes": {"tags": ["clouds"]}, "base": {"tags": []}})
        self.assertEqual((status, record["tags"]), (200, ["clouds"]))
        status, body = self.post(ID_A, {"by": "Ben", "changes": {"tags": ["coastline"]}, "base": {"tags": []}})
        self.assertEqual(status, 409, body)
        self.assertIn("Ann", body["error"])
        self.assertEqual(body["record"]["tags"], ["clouds"])
        self.assertEqual(self.stored()[ID_A]["tags"], ["clouds"])
        # Values are compared cleaned: '' is the stored null title.
        self.assertEqual(self.post(ID_A, {"by": "Ben", "changes": {"title": "T"}, "base": {"title": ""}})[0], 200)
        # A stale base for a field nobody else touched is no conflict...
        self.assertEqual(self.post(ID_A, {"by": "Cat", "changes": {"notes": "n"}, "base": {"notes": None}})[0], 200)
        # ...nor is sending the value someone else already stored.
        status, _ = self.post(ID_A, {"by": "Dan", "changes": {"tags": ["clouds"]}, "base": {"tags": []}})
        self.assertEqual(status, 200)
        # Without a base, the last write wins, as before.
        self.assertEqual(self.post(ID_A, {"by": "Eve", "changes": {"tags": ["x"]}})[0], 200)


class StorageTests(ServerTestCase):
    def test_concurrent_posts_do_not_corrupt_the_file(self):
        workers, per_worker = 8, 12
        failures = []

        def work(n):
            for i in range(per_worker):
                image_id = (ID_A, ID_B)[(n + i) % 2]
                status, body = self.post(image_id, {"by": f"user{n}",
                                                    "changes": {"notes": f"note {n}-{i}", "tags": [f"t{n}"]}})
                if status != 200:
                    failures.append((status, body))

        threads = [threading.Thread(target=work, args=(n,)) for n in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(failures, [])

        text = self.annotations.read_text(encoding="utf-8")
        data = json.loads(text)
        self.assertEqual(text, json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
        sent = sorted(f"note {n}-{i}" for n in range(workers) for i in range(per_worker))
        recorded = sorted(entry["changes"]["notes"][1] for record in data.values() for entry in record["history"])
        self.assertEqual(recorded, sent)  # every edit saved exactly once: none lost, none doubled
        for record in data.values():  # and each photo's history is one unbroken chain
            previous = None
            for entry in record["history"]:
                self.assertEqual(entry["changes"]["notes"][0], previous)
                previous = entry["changes"]["notes"][1]
            self.assertEqual(record["notes"], previous)
        self.assertEqual(self.get_json("/api/annotations"), (200, data))
        self.assertNoTempFiles()

    def test_a_corrupt_file_is_never_overwritten(self):
        for broken in (b'{"2026-09-17-071148z": {"title": "kept"', b"[]", b'{"2026-09-17-071148z": 5}'):
            with self.subTest(broken=broken):
                self.annotations.write_bytes(broken)
                status, body = self.post(ID_A, VALID)
                self.assertEqual(status, 500)
                self.assertIn("error", body)
                self.assertEqual(self.annotations.read_bytes(), broken)
        self.annotations.write_bytes(b"[]")
        self.assertEqual(self.request("GET", "/api/annotations")[0], 500)
        self.assertNoTempFiles()

    def test_a_missing_file_is_created_on_the_first_edit(self):
        self.annotations.unlink()
        self.assertEqual(self.get_json("/api/annotations"), (200, {}))
        self.assertEqual(self.post(ID_A, VALID)[0], 200)
        self.assertEqual(self.stored()[ID_A]["title"], "A title")

    def test_replace_is_retried_while_windows_reports_the_file_busy(self):
        real_replace = os.replace
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) <= 2:
                raise PermissionError(13, "The process cannot access the file")
            return real_replace(src, dst)

        with mock.patch.object(serve, "RETRY_DELAY", 0.001), mock.patch.object(serve.os, "replace", flaky):
            status, record = self.post(ID_A, VALID)
        self.assertEqual((status, len(calls)), (200, 3))
        self.assertEqual(self.stored(), {ID_A: record})
        self.assertNoTempFiles()

    def test_a_failed_save_keeps_the_old_data(self):
        self.post(ID_A, {"by": "Ann", "changes": {"title": "Saved"}})
        before = self.annotations.read_bytes()

        def busy(src, dst):
            raise PermissionError(13, "The process cannot access the file")

        with mock.patch.object(serve, "RETRY_DELAY", 0.001), mock.patch.object(serve.os, "replace", busy):
            status, body = self.post(ID_A, {"by": "Ben", "changes": {"title": "Lost"}})
        self.assertEqual(status, 500)
        self.assertIn("error", body)
        self.assertEqual(self.annotations.read_bytes(), before)
        self.assertNoTempFiles()
        self.assertEqual(self.get_json("/api/annotations")[1][ID_A]["title"], "Saved")  # cache not poisoned
        status, record = self.post(ID_A, {"by": "Ben", "changes": {"title": "Second try"}})
        self.assertEqual((status, len(record["history"])), (200, 2))
        self.assertEqual(record["history"][-1]["changes"], {"title": ["Saved", "Second try"]})


KEY = "s3cret-Key"


class EditKeyTests(ServerTestCase):
    edit_key = KEY

    def test_health_reports_key(self):
        self.assertEqual(self.get_json("/api/health"), (200, {"ok": True, "edits": "key"}))

    def test_a_foreign_host_with_the_key_is_fine(self):
        # Key mode needs the key anyway, so reverse proxies keep working.
        headers = {"Host": "gallery.example.org"}
        self.assertEqual(self.post(ID_A, {**VALID, "key": KEY}, headers=headers)[0], 200)

    def test_the_key_is_required(self):
        for key in (None, "", "wrong", KEY.lower(), KEY[:-1], KEY + " ", 12345, [KEY]):
            with self.subTest(key=key):
                payload = dict(VALID) if key is None else {**VALID, "key": key}
                self.assertEqual(self.post(ID_A, payload), (403, {"error": "edit key required"}))
        # Checked before anything else, so it can't be used to probe ids or fields.
        self.assertEqual(self.post("no-such-id", VALID), (403, {"error": "edit key required"}))
        self.assertEqual(self.post(ID_A, {"by": "", "changes": {"lat": 500}}), (403, {"error": "edit key required"}))
        self.assertEqual(self.stored(), {})

        status, record = self.post(ID_A, {**VALID, "key": KEY})
        self.assertEqual((status, record["title"]), (200, "A title"))
        self.assertNotIn(KEY, self.annotations.read_text(encoding="utf-8"))
        self.assertNotIn("key", record)

    def test_log_has_one_short_line_per_request_and_no_secrets(self):
        self.logs.clear()
        self.request("GET", "/index.html")
        self.request("GET", "/missing.png")
        self.post(ID_A, {"by": "Jordan", "key": KEY, "changes": {"notes": "private words"}})
        self.post(ID_A, {"by": "Jordan", "key": "not-the-key", "changes": {"notes": "more words"}})
        self.request("GET", f"/api/annotations?key={KEY}")
        self.assertEqual(len(self.logs), 5, self.logs)
        joined = "\n".join(self.logs)
        for secret in (KEY, "not-the-key", "private words", "more words"):
            self.assertNotIn(secret, joined)
        self.assertIn(f"POST /api/annotations/{ID_A} 200", self.logs[2])
        self.assertIn(f"POST /api/annotations/{ID_A} 403", self.logs[3])
        self.assertTrue(all(len(line) < 200 and "\n" not in line for line in self.logs))


class ReadOnlyTests(ServerTestCase):
    read_only = True
    edit_key = KEY  # read-only wins over a key

    def test_editing_is_off(self):
        self.assertEqual(self.get_json("/api/health"), (200, {"ok": True, "edits": "off"}))
        self.assertEqual(self.post(ID_A, {**VALID, "key": KEY}), (403, {"error": "editing is turned off"}))
        self.assertEqual(self.post(ID_A, VALID), (403, {"error": "editing is turned off"}))
        self.assertEqual(self.annotations.read_bytes(), b"{}")
        self.assertEqual(self.get_json("/api/annotations"), (200, {}))
        self.assertEqual(self.request("GET", "/")[0], 200)


class CommandLineTests(unittest.TestCase):
    """Runs serve.py as a program, the way people start it."""

    def start(self, *args, env_key=None):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        site = build_site(Path(tmp.name))
        env = {k: v for k, v in os.environ.items() if k != "GALLERY_EDIT_KEY"}
        if env_key:
            env["GALLERY_EDIT_KEY"] = env_key
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), "--port", "0", "--site", str(site), *args],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        lines: queue.Queue = queue.Queue()
        reader = threading.Thread(target=lambda: [lines.put(line) for line in proc.stdout], daemon=True)
        reader.start()
        self.output: list[str] = []
        self.addCleanup(self.stop, proc, reader, lines)
        deadline = time.monotonic() + 20
        while not any("Ctrl+C" in line for line in self.output):
            try:
                self.output.append(lines.get(timeout=max(0.1, deadline - time.monotonic())))
            except queue.Empty:
                self.fail(f"serve.py did not start: {self.output}")
        match = re.search(r"http://127\.0\.0\.1:(\d+)/", "".join(self.output))
        self.assertIsNotNone(match, self.output)
        return int(match.group(1)), "".join(self.output)

    def stop(self, proc, reader, lines):
        port = None
        match = re.search(r"http://127\.0\.0\.1:(\d+)/", "".join(self.output))
        if match:
            port = int(match.group(1))
        proc.terminate()
        try:
            proc.wait(15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(15)
        reader.join(5)
        proc.stdout.close()
        while not lines.empty():
            self.output.append(lines.get())
        if port:  # nothing may be left listening
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=2).close()

    def test_default_is_open(self):
        port, text = self.start()
        self.assertIn("Edits: open", text)
        status, _, body = http_request(port, "GET", "/api/health")
        self.assertEqual((status, json.loads(body)), (200, {"ok": True, "edits": "open"}))

    def test_key_from_the_environment(self):
        port, text = self.start(env_key="env-key-123")
        self.assertIn("key-protected", text)
        status, _, body = http_request(port, "GET", "/api/health")
        self.assertEqual(json.loads(body), {"ok": True, "edits": "key"})
        self.assertEqual(http_post(port, ID_A, VALID)[0], 403)
        self.assertEqual(http_post(port, ID_A, {**VALID, "key": "env-key-123"})[0], 200)
        self.assertEqual(http_request(port, "GET", "/")[0], 200)
        self.doCleanups()  # stop the server and collect everything it printed
        self.assertTrue(any("POST /api/annotations/" in line for line in self.output), self.output)
        self.assertNotIn("env-key-123", "".join(self.output))

    def test_bad_port_or_site_fails_cleanly(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            site = build_site(Path(tmp))
            with mock.patch("sys.stderr"):
                self.assertEqual(serve.main(["--port", "70000", "--site", str(site)]), 1)
                with self.assertRaises(SystemExit):
                    serve.main(["--site", str(Path(tmp) / "no-such-folder")])
                with self.assertRaises(SystemExit):  # a blank key must not open editing to everyone
                    serve.main(["--edit-key", "   ", "--site", str(site)])

    def test_spaces_round_the_key_are_dropped(self):
        # cmd.exe keeps the space in `set GALLERY_EDIT_KEY=env-key-123 `; the form trims what members type.
        port, text = self.start(env_key="  env-key-123 ")
        self.assertIn("key-protected", text)
        self.assertEqual(http_post(port, ID_A, {**VALID, "key": "env-key-123"})[0], 200)

    def test_read_only_flag(self):
        port, text = self.start("--read-only", "--edit-key", "cli-key")
        self.assertIn("Edits: off", text)
        status, _, body = http_request(port, "GET", "/api/health")
        self.assertEqual(json.loads(body), {"ok": True, "edits": "off"})
        self.assertEqual(http_post(port, ID_A, {**VALID, "key": "cli-key"}),
                         (403, {"error": "editing is turned off"}))


if __name__ == "__main__":
    unittest.main()
