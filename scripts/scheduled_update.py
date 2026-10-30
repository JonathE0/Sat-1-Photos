"""Run `python -m cts1_gallery update` once, unattended (Task Scheduler, cron, systemd).

Only writes files, never prints (under pythonw.exe sys.stdout/sys.stderr are None):
data/logs/update.log, data/logs/last_run.json, and the lock file data/update.lock.
Exit code: the update's own, 124 on timeout, 1 if it could not start. See docs/SCHEDULING.md.
"""

import json
import os
import shlex
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl

REPO = Path(__file__).resolve().parent.parent
LOG_DIR = REPO / "data" / "logs"
LOG_FILE = LOG_DIR / "update.log"
LOCK_FILE = REPO / "data" / "update.lock"
TIMEOUT_S = 55 * 60
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 5
TAIL_LINES = 20


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append_log(text: str) -> None:
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(text + "\n")


def take_lock() -> bool:
    """Lock LOCK_FILE until this process exits; False if another run holds it."""
    fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT)  # left open: closing it would unlock
    try:
        if os.name == "nt":
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        os.close(fd)
        return False


def rotate_log() -> None:
    """Once update.log reaches LOG_MAX_BYTES, shift it to .1, .1 to .2, ... up to .5."""
    if not LOG_FILE.exists() or LOG_FILE.stat().st_size < LOG_MAX_BYTES:
        return
    for i in range(LOG_BACKUPS - 1, 0, -1):
        if (older := LOG_DIR / f"update.log.{i}").exists():
            os.replace(older, LOG_DIR / f"update.log.{i + 1}")
    os.replace(LOG_FILE, LOG_DIR / "update.log.1")


def update_command() -> list[str]:
    # Testing only: CTS1_UPDATE_CMD (a shell-style command line) replaces the update command.
    if override := os.environ.get("CTS1_UPDATE_CMD"):
        return shlex.split(override)
    venv = REPO / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return [str(venv) if venv.exists() else sys.executable, "-m", "cts1_gallery", "update"]


def run_update(log) -> int:
    cmd = update_command()
    tail: deque[str] = deque(maxlen=TAIL_LINES)

    def output(line: str) -> None:
        tail.append(line)
        log.write(line + "\n")

    started_at, t0 = utc_now(), time.monotonic()
    log.write(f"==== {started_at} start: {subprocess.list2cmdline(cmd)}\n")
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
    # pythonw has no console, so without CREATE_NO_WINDOW a python.exe child would open one.
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" and sys.stdout is None else 0
    try:
        proc = subprocess.Popen(cmd, cwd=REPO, env=env, creationflags=flags,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    except OSError as e:
        output(f"scheduled_update: could not start {cmd[0]}: {e}")
        code = 1
    else:
        def pump() -> None:
            for line in proc.stdout:
                output(line.rstrip("\n"))

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        timed_out = False
        try:
            code = proc.wait(timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            timed_out, code = True, 124
        reader.join(timeout=10)
        if timed_out:
            output(f"scheduled_update: killed after {TIMEOUT_S // 60} minutes")

    finished_at, duration = utc_now(), round(time.monotonic() - t0, 1)
    log.write(f"==== {finished_at} end: exit code {code}, {duration} s\n")
    summary = {"started_at": started_at, "finished_at": finished_at, "exit_code": code,
               "duration_s": duration, "tail": list(tail)}
    tmp = LOG_DIR / "last_run.json.tmp"
    tmp.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, LOG_DIR / "last_run.json")  # readers never see a half-written file
    return code


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if not take_lock():
        append_log(f"==== {utc_now()} previous run still in progress, skipping")
        return 0
    try:
        rotate_log()
    except OSError as e:  # e.g. update.log is open in a log viewer; retried next run
        append_log(f"==== {utc_now()} could not rotate update.log: {e}")
    with open(LOG_FILE, "a", encoding="utf-8", buffering=1) as log:
        return run_update(log)


if __name__ == "__main__":
    try:
        status = main()
    except Exception:  # pythonw would discard the traceback, so keep it in the log
        append_log(f"==== {utc_now()} scheduled_update failed\n{traceback.format_exc().rstrip()}")
        status = 1
    # Windows crash codes such as 0xC0000005 overflow sys.exit() unless made signed 32-bit.
    sys.exit(status - 2**32 if status >= 2**31 else status)
