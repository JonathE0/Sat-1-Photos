"""Start the GitHub workflow that updates and publishes the site, once (Task Scheduler).

GitHub's own hourly schedule starts hours late or not at all, so this PC asks for the run.
Only writes a file, never prints (under pythonw.exe sys.stdout/sys.stderr are None):
data/logs/publish.log. Exit code: gh's, or 1 if it could not start. See docs/SCHEDULING.md.
"""

import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOG_DIR = REPO / "data" / "logs"
LOG_FILE = LOG_DIR / "publish.log"
LOG_MAX_BYTES = 1024 * 1024
GITHUB_REPO = "JonathE0/Sat-1-Photos"
WORKFLOW = "publish.yml"
TIMEOUT_S = 120


def gh_path() -> str:
    # A task can start with an older PATH than a new shell has.
    return shutil.which("gh") or r"C:\Program Files\GitHub CLI\gh.exe"


def start_workflow() -> tuple[int, str]:
    """Ask GitHub for a run on main; gh's exit code and what it said."""
    cmd = [gh_path(), "workflow", "run", WORKFLOW, "--repo", GITHUB_REPO, "--ref", "main"]
    # pythonw has no console, so without CREATE_NO_WINDOW gh.exe would open one.
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" and sys.stdout is None else 0
    try:
        done = subprocess.run(cmd, cwd=REPO, env={**os.environ, "GH_PROMPT_DISABLED": "1"},
                              creationflags=flags, stdin=subprocess.DEVNULL, capture_output=True,
                              encoding="utf-8", errors="replace", timeout=TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, f"could not run gh: {e}"
    return done.returncode, " ".join((done.stdout + done.stderr).split())


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if LOG_FILE.exists() and LOG_FILE.stat().st_size >= LOG_MAX_BYTES:
        os.replace(LOG_FILE, LOG_DIR / "publish.log.1")
    code, said = start_workflow()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{stamp} exit code {code}: {said}\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
