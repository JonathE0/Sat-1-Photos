"""The site's files and a fingerprint of each (site/files.json), for its service worker.

GitHub Pages gives every file a new date and ETag on every publish, and the site publishes
about hourly, so a returning browser downloaded everything again, textures and all
(about 12 MB on a big screen). site/sw.js keeps each file listed here until its fingerprint
changes. Pages (*.html) and the data the site refreshes (data/*.json) aren't listed: they
always come from the network. Run by the publish workflow just before the upload:

    python -m cts1_gallery files
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

#: Folders no page loads from (tests, development pages).
SKIP_DIRS = {"dev", "fixtures"}
SKIP_SUFFIXES = {".html", ".md", ".mjs", ".py"}
#: The list itself, and the worker that reads it.
SKIP_FILES = {"files.json", "sw.js"}


def fingerprint(data: bytes) -> str:
    """The first 16 hex digits of the SHA-256, as sw.js works it out."""
    return hashlib.sha256(data).hexdigest()[:16]


def listed(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in SKIP_DIRS or p.startswith(".") for p in parts[:-1]) or parts[-1].startswith("."):
        return False
    if rel in SKIP_FILES or Path(rel).suffix in SKIP_SUFFIXES:
        return False
    return not (parts[0] == "data" and rel.endswith(".json"))


def write_manifest(site: Path) -> Path:
    files = {}
    for path in sorted(site.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(site).as_posix()
        if listed(rel):
            files[rel] = fingerprint(path.read_bytes())
    out = site / "files.json"
    out.write_text(json.dumps({"version": 1, "files": files}, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    return out
