# Scheduled updates

Windows Task Scheduler keeps the gallery current by running plain Python every
N minutes (30 by default). There is no AI in the loop: the task starts
`scripts/scheduled_update.py`, which runs `python -m cts1_gallery update` once,
records the result and exits.

When the site is published on GitHub Pages, the repository's own workflow,
`.github/workflows/publish.yml`, runs the same update on GitHub's servers
every 30 minutes and publishes the result; see "Publishing" in the README.
Use one schedule or the other, not both.

## What one run does

1. An incremental sync of the ground-station pipeline's parquet tables.
2. Reassembling images that are new or changed, then rebuilding the site data.

The source is the CalgaryToSpace processing pipeline's public web UI
(frontiersat.mooo.com), which re-processes every SatNOGS observation of the
satellite about every 15 minutes and publishes its tables as parquet. It is the
most complete source (it demodulates observation audio itself, so it has
packets SatNOGS DB never decoded) and the cheapest to pull: the sync reads each
file's footer (about 0.8 MB for the big table), then range-requests only the
row groups whose row counts changed and only the columns the gallery uses.
Once a day it instead checks every row group exactly. Measured on this data:

| Run | Transferred | Time |
|---|---|---|
| Nothing new upstream (same ETag) | one tiny request per table | ~2 s |
| New version upstream, with or without new downlinks | ~1.2 MB: the 0.8 MB footer and the last row group; plus ~0.4 MB for the telecommand table if it changed | a few s |
| Upstream backfilled older observations | the above, plus 0.2-0.7 MB for each row group that gained rows | a few s |
| Once a day: exact check of every row group | ~20-25 MB in ~125-150 requests. Upstream reorders rows that share a timestamp from one version to the next, which changes most row groups' fingerprints, so nearly all of them are fetched again | ~15 s |
| First run on a new machine, or the first after the kept columns change | ~20-25 MB instead of the full ~105 MB | ~15-20 s |

Around that command, `scheduled_update.py`:

- runs it from the repo root with the `.venv` Python and `PYTHONUTF8=1`;
- skips the run if the previous one has not finished (see "Overlapping runs");
- kills it if it takes longer than 55 minutes;
- writes its output to `data/logs/update.log` and a summary to `data/logs/last_run.json`;
- exits with the update's exit code, 124 after a timeout, or 1 if it could not start it.

It never prints, so it works under `pythonw.exe`, which has no console window.

## Install, change, run now, uninstall

The project venv has to exist first (Python 3.11 or newer):

    python -m venv .venv
    .venv\Scripts\python.exe -m pip install -r requirements.txt

Then, from the repo root (no admin rights needed):

    powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 [-IntervalMinutes 30] [-RunNow] [-Uninstall]

- Install: run it with no options for a 30-minute interval. The first run is a
  minute later.
- Change the interval: run it again with, say, `-IntervalMinutes 15` (1 to 1440).
  Re-running replaces the task. The pipeline republishes about every 15
  minutes, so shorter intervals gain nothing. Then set `refreshMinutes` in
  `site/config.js` to the same number; the site footer shows it.
- Run now: add `-RunNow` to start a run straight after registering; the
  schedule then continues one interval later.
- Uninstall: `-Uninstall`.

The task is called "CTS-SAT-1 Gallery Update" (`-TaskName` changes it). It runs
`.venv\Scripts\pythonw.exe scripts\scheduled_update.py` as you, only while you
are logged on, and stores no password. It never starts a second copy while one
is running, starts a missed run as soon as it can, runs on battery, and is
stopped by Task Scheduler after 1 hour (the script's own 55-minute timeout
normally comes first).

To start the installed task by hand, or check on it:

    Start-ScheduledTask -TaskName "CTS-SAT-1 Gallery Update"
    Get-ScheduledTask -TaskName "CTS-SAT-1 Gallery Update" | Get-ScheduledTaskInfo

or open Task Scheduler (`taskschd.msc`).

## Running once by hand

    .venv\Scripts\python.exe -m cts1_gallery update

This prints to the console and writes nothing to `data/logs`. It also does not
take the lock, so don't start it while a scheduled run may be going. To do
exactly what the task does (lock, logs, timeout), run
`.venv\Scripts\python.exe scripts\scheduled_update.py` instead.

## Logs

`data/logs/update.log` holds the output of every run. Each run starts with a
header line (UTC start time and the command) and ends with a footer line (exit
code and duration):

    ==== 2026-10-29T14:00:02+00:00 start: "C:\...\.venv\Scripts\python.exe" -m cts1_gallery update
    ...
    ==== 2026-10-29T14:00:43+00:00 end: exit code 0, 41.2 s

When a run starts and the file is over 5 MB, it is renamed to `update.log.1`
and older files shift up to `update.log.5`; the oldest is dropped. A run's
output is never split across two files.

`data/logs/last_run.json` describes the most recent run:

    {
      "started_at": "2026-10-29T14:00:02+00:00",
      "finished_at": "2026-10-29T14:00:43+00:00",
      "exit_code": 0,
      "duration_s": 41.2,
      "tail": ["...the last 20 lines of output..."]
    }

## Overlapping runs

Each run takes an exclusive, non-blocking lock on `data/update.lock`
(`msvcrt.locking` on Windows, `fcntl.flock` elsewhere) and holds it until it
exits. If the lock is already taken, for example because a slow first sync is
still going when the next interval comes round, the new run writes "previous
run still in progress, skipping" to `update.log` and exits 0. So two updates
never write the data at the same time.

The lock belongs to the running process, not to the file: the operating system
releases it when the process exits or is killed, so a crash cannot leave a
stale lock behind. The empty file stays in place and can be ignored.

Task Scheduler's "do not start a new instance" setting already keeps scheduled
runs apart; the lock also covers `scheduled_update.py` started by hand, from
cron or from systemd.

## Linux and macOS

Run the same script from cron or systemd; the lock works the same way.

crontab (`crontab -e`), every 30 minutes:

    */30 * * * * /path/to/repo/.venv/bin/python /path/to/repo/scripts/scheduled_update.py

On macOS, cron needs Full Disk Access (System Settings > Privacy & Security) if
the repo is under Desktop or Documents.

systemd user units. `~/.config/systemd/user/cts1-gallery-update.service`:

    [Unit]
    Description=CTS-SAT-1 gallery update

    [Service]
    Type=oneshot
    ExecStart=/path/to/repo/.venv/bin/python /path/to/repo/scripts/scheduled_update.py

`~/.config/systemd/user/cts1-gallery-update.timer`:

    [Unit]
    Description=Run the CTS-SAT-1 gallery update every 30 minutes

    [Timer]
    OnCalendar=*:0/30
    Persistent=true

    [Install]
    WantedBy=timers.target

Then:

    systemctl --user daemon-reload
    systemctl --user enable --now cts1-gallery-update.timer
    systemctl --user list-timers         # shows the next run
    loginctl enable-linger "$USER"       # optional: keep running while logged out

`Persistent=true` plays the part of StartWhenAvailable: a run missed while the
machine was off happens soon after it comes back.

## Troubleshooting

- **Task Scheduler shows a non-zero "Last Run Result".** That is the script's
  exit code: the update's own (usually `0x1` for an error), `0x7C` (124) if it
  was killed after 55 minutes, or `0x1` if it could not be started. Read the
  end of `data/logs/update.log`; `tail` in `last_run.json` has the last 20
  lines. `0x41301` only means a run is in progress, `0x41303` that the task has
  not run yet.
- **`0x80070002` (file not found).** The repo or `.venv` moved or was
  recreated. The task stores absolute paths; run the install script again.
- **The first run is slow.** It is a full initial sync rather than an
  incremental one, and it assembles every image. Later runs only fetch what
  changed. You can do the first one by hand before installing the task.
- **The laptop was asleep or off.** Nothing runs then, and the task does not
  wake the machine. Because of StartWhenAvailable, Task Scheduler starts one
  catch-up run soon after it wakes; it does not replay every missed interval.
  The task also only runs while you are logged on.
- **Certificate errors (`CERTIFICATE_VERIFY_FAILED`).** The dashboard's
  certificate chain ends in an expired cross-sign. The ISRG Root YE certificate
  bundled in `cts1_gallery/certs/` is an extra trust anchor that lets
  verification succeed without disabling any checks, so it must stay there.
- **Every run logs "previous run still in progress, skipping".** A run is still
  going or is stuck. The 55-minute timeout should clear it; if it doesn't, look
  for leftover `python.exe` or `pythonw.exe` processes in Task Manager.
