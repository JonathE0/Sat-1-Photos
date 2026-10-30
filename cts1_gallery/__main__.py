"""Command line: `python -m cts1_gallery update` syncs the ground-station
data, reassembles every image and rebuilds the site's data.

    python -m cts1_gallery update             # sync, then rebuild
    python -m cts1_gallery update --offline   # rebuild from the local cache
    python -m cts1_gallery update --force     # re-render every image
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback

if sys.version_info < (3, 11):  # datetime.UTC, below, and the rest of the package need 3.11
    sys.exit(f"cts1_gallery needs Python 3.11 or newer, not {sys.version.split()[0]}")

from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
SITE = ROOT / "site"


def log(message: str) -> None:
    print(f"{datetime.now(UTC):%Y-%m-%d %H:%M:%S}Z {message}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m cts1_gallery")
    sub = parser.add_subparsers(dest="command", required=True)
    update = sub.add_parser("update", help="sync the data, then rebuild images and site data")
    update.add_argument("--offline", action="store_true", help="skip the sync and rebuild from the local cache")
    update.add_argument("--force", action="store_true", help="re-render every image")
    args = parser.parse_args(argv)

    from .build import build
    from .fetch import TABLES, fetch_all

    started = time.perf_counter()
    try:
        if args.offline:
            paths = {key: CACHE / f"{key}.parquet" for key in TABLES}
            missing = [str(p) for p in paths.values() if not p.exists()]
            if missing:
                log(f"no local data yet ({', '.join(missing)}); run without --offline first")
                return 2
        else:
            log("syncing ground-station tables")
            paths = fetch_all(CACHE, log=log)
        log("building")
        build(paths, SITE, CACHE, log=log, force=args.force, online=not args.offline)
    except Exception:  # noqa: BLE001 -- report and exit non-zero for the scheduler
        log("update failed:\n" + traceback.format_exc())
        return 1
    log(f"done in {time.perf_counter() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
