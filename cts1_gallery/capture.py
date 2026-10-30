"""When each picture was taken, and what that answer rests on.

In order of preference:

1. A time in the file name. Captures are named by the time the capture
   command was scheduled for, in a few styles ("2026-09-17_071148Z.img",
   "2026-10-25005433z.img", "2026-07-15-T17-49-30Z.img"), and one with an
   'L' suffix ("2026-10-24_173732L.img"), which is also UTC: read as Calgary
   time it would come after its own downlink began.
2. The camera's own log line, "Opened image file: <file>", written as the
   capture starts.
3. The camera_capture command's own record (a .run file that came down in
   bulk packets): when the command finished, less how long it took.
4. The attitude camera's file list, which gives the time each frame was
   saved, by the attitude camera's own clock.
5. The reply to the capture telecommand ("Successfully captured image"),
   matched to the first image downlinked after it, within two days.
6. The date in the file name, with the time unknown.

1-3 are readings of the satellite's clock, which is often wrong: synced from
the EPS board's real-time clock it has run as much as 2.5 minutes fast, and
every second is 7.6 km of ground track. `SatelliteClock` works out how far
off it was from what the satellite sent down at the time (its log stamps and
beacon clock readings against when the ground heard them), and such times are
corrected by that. A reading nothing covers is kept as read and marked
uncorrected. A capture can't come after its own file started coming down, so
a time that would is passed over for the next source.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import NamedTuple

import numpy as np
import polars as pl

_NAME_RE = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})"  # date
    r"(?:[_-]?T?(\d{2})-?(\d{2})-?(\d{2})([ZzLl]))?"  # optional time + zone letter
)
_REPLY_WINDOW = timedelta(days=2)
_SAME_CAPTURE = timedelta(minutes=10)  # a log line and a reply this close describe one capture

# Log stamps end in the clock's sync source: G GNSS, T a ground telecommand,
# E the EPS board's real-time clock. Beacons spell it out.
_LOG_STAMP = r"^(\d{12,13})\+(\d+)_(\w)"
_SYNCED_LOG = frozenset("GT")
_SYNCED_BEACON = frozenset({"GNSS_UART", "TELECOMMAND_ABSOLUTE"})
_MIN_LINES = 10  # log lines a clock session needs before its offset is trusted
_SESSION_REACH = timedelta(hours=3)  # how far past its last line a session is assumed to last
_NEAR = timedelta(hours=3)  # beacons this close to a reading say how far off the clock was
_ONE_SIDE = timedelta(minutes=30)  # ...or this close, when only one side is in the same clock segment
_JUMP_S = 2.0  # a change in (clock - uptime) this big is a resync or a reboot
_SMALL_S = 3.0  # offsets under this are within the scatter of the ground's receive stamps


class Capture(NamedTuple):
    at: datetime | None
    day: date | None
    basis: str
    # Whether `at` comes from a reading of an on-board clock, and if so the
    # seconds added to correct it (negative when the clock ran fast, 0 when
    # it was found right; None when nothing could check it).
    on_board_clock: bool = False
    correction_s: float | None = None


@dataclass(slots=True)
class Clues:
    """What the data says about when one file was captured."""

    path: str
    first_rx: datetime  # when its first packet arrived
    opens: list = field(default_factory=list)  # "Opened image file" lines (reassemble.LogStamp)
    recorded_at: datetime | None = None  # the capture command's record, by the satellite's clock
    adcs_listed_at: datetime | None = None  # the attitude camera's file list, by its clock


def from_name(path: str) -> tuple[datetime | None, date | None]:
    """The capture time (if the name has one) and date (if it has one).
    Every time-bearing name is UTC, whatever its zone letter."""
    m = _NAME_RE.search(path.rsplit("/", 1)[-1])
    if not m:
        return None, None
    y, mo, d, hh, mm, ss, _zone = m.groups()
    try:
        day = date(int(y), int(mo), int(d))
    except ValueError:
        return None, None
    if hh is None:
        return None, day
    try:
        t = datetime(int(y), int(mo), int(d), int(hh), int(mm), int(ss), tzinfo=UTC)
    except ValueError:
        return None, day
    return t, t.date()


def capture_replies(tcmd_responses: Path) -> list[datetime]:
    """When "Successfully captured image" replies were heard, oldest first."""
    df = pl.read_parquet(tcmd_responses, columns=["first_received_at", "tcmd_response_text"])
    hits = df.filter(pl.col("tcmd_response_text").str.contains("Successfully captured image"))
    return sorted(set(hits["first_received_at"].drop_nulls().to_list()))


# -- the satellite's clock ------------------------------------------------------


class _Session(NamedTuple):
    epoch: int  # the sync epoch in the stamps, ms
    last: float  # the last line's stamp, s
    source: str
    ahead: float  # how far the clock ran ahead, s
    lines: int


class SatelliteClock:
    """How far the satellite's clock was off true time, at a reading of it.

    Two kinds of evidence:

    * Log lines are stamped "<sync epoch>+<ms since sync>_<source>". Every
      sync starts a session, and within one the clock's error barely moves,
      so each session's error is the median of (stamp - ground receipt).
    * Beacons carry the clock's reading, the uptime counter and the sync
      source. A stretch of beacons over which (clock - uptime) holds steady is
      one unbroken clock; the error near a moment is the median of
      (reading - ground receipt) over that stretch. (These columns are only
      in the cache once the sync keeps them.)

    The ground's receive stamps are themselves early by a few seconds; that
    bias is measured on lines and beacons whose clock was set from GNSS or
    a telecommand, and taken off. A clock synced that way counts as right.
    """

    def __init__(self, sessions: list[_Session], bias_s: float, beacons: dict | None = None) -> None:
        self.bias_s = bias_s
        self._sessions = sorted(sessions)
        self._epochs = [s.epoch for s in self._sessions]
        self._by_epoch = {s.epoch: s for s in self._sessions}
        self._beacons = beacons

    @classmethod
    def empty(cls) -> SatelliteClock:
        return cls([], 0.0)

    @classmethod
    def load(cls, everything_decoded: Path) -> SatelliteClock:
        lf = pl.scan_parquet(everything_decoded)
        columns = set(lf.collect_schema().names())
        stamps = (
            lf.filter(pl.col("packet_type") == "LOG_MESSAGE")
            .select("received_at", pl.col("log_message").str.extract_groups(_LOG_STAMP).alias("m"))
            .select(
                pl.col("m").struct.field("1").cast(pl.Int64).alias("epoch"),
                (pl.col("m").struct.field("1").cast(pl.Int64) + pl.col("m").struct.field("2").cast(pl.Int64)).alias("sat"),
                pl.col("m").struct.field("3").alias("source"),
                pl.col("received_at").dt.epoch("ms").alias("rx"),
            )
            .drop_nulls()
            .with_columns(lead=(pl.col("sat") - pl.col("rx")) / 1000)
            .filter(pl.col("lead").abs() < 12 * 3600)
            .collect()
        )
        synced = stamps.filter(pl.col("source").is_in(list(_SYNCED_LOG)))["lead"]
        bias = float(synced.median()) if len(synced) else 0.0
        per = stamps.group_by("epoch").agg(
            pl.col("sat").max().alias("last"),
            pl.col("source").mode().first().alias("source"),
            pl.col("lead").median().alias("lead"),
            pl.len().alias("lines"),
        )
        sessions = [
            _Session(epoch, last / 1000, source, lead - bias, lines)
            for epoch, last, source, lead, lines in per.select("epoch", "last", "source", "lead", "lines").iter_rows()
        ]
        beacons = None
        if {"unix_epoch_time_ms", "uptime_sec", "last_time_sync_source"} <= columns:
            beacons = cls._load_beacons(lf, columns, bias)
        return cls(sessions, bias, beacons)

    @staticmethod
    def _load_beacons(lf: pl.LazyFrame, columns: set[str], log_bias: float) -> dict | None:
        rx_source = pl.col("received_at_source").cast(pl.String) if "received_at_source" in columns else pl.lit("")
        df = (
            lf.filter(pl.col("packet_type").cast(pl.String).str.starts_with("BEACON") & pl.col("csp_crc_valid"))
            .select(
                (pl.col("unix_epoch_time_ms") / 1000).alias("sat"),
                pl.col("uptime_sec").alias("uptime"),
                pl.col("last_time_sync_source").alias("source"),
                (pl.col("received_at").dt.epoch("ms") / 1000).alias("rx"),
                rx_source.fill_null("").alias("via"),
            )
            .drop_nulls()
            .with_columns(lead=pl.col("sat") - pl.col("rx"))
            .filter(pl.col("lead").abs() < 3600)
            .sort("sat")
            .collect()
        )
        if df.is_empty():
            return None
        # Receive stamps are biased differently by how they were made.
        bias = {
            via: float(lead)
            for via, lead in df.filter(pl.col("source").is_in(list(_SYNCED_BEACON)))
            .group_by("via")
            .agg(pl.col("lead").median())
            .iter_rows()
        }
        sat = df["sat"].to_numpy()
        boot = sat - df["uptime"].to_numpy()
        source = df["source"].to_list()
        breaks = np.r_[
            True,
            (np.abs(np.diff(boot)) > _JUMP_S)
            | (np.diff(df["uptime"].to_numpy()) < 0)
            | (np.array(source[1:], dtype=object) != np.array(source[:-1], dtype=object)),
        ]
        ahead = df["lead"].to_numpy() - np.array([bias.get(v, log_bias) for v in df["via"].to_list()])
        return {"sat": sat, "segment": np.cumsum(breaks), "source": source, "ahead": ahead}

    def ahead(self, t: datetime, *, session: int | None = None) -> float | None:
        """Seconds the clock ran ahead of true time when it read `t` (negative
        when behind; 0 when it was right), or None when nothing tells.
        `session` is the sync epoch of the log line `t` came from, if any."""
        s = t.timestamp()
        if session is None and self._beacons is not None and (v := self._beacon_ahead(s)) is not None:
            return v
        if session is not None:
            found = self._by_epoch.get(session)
        else:
            k = bisect_right(self._epochs, s * 1000) - 1
            found = self._sessions[k] if k >= 0 else None
            if found is not None and s > found.last + _SESSION_REACH.total_seconds():
                found = None
        if found is None or found.lines < _MIN_LINES:
            return None
        return self._settle(found.ahead, found.source in _SYNCED_LOG)

    def _beacon_ahead(self, s: float) -> float | None:
        b = self._beacons
        sat, segment = b["sat"], b["segment"]
        k = bisect_left(sat, s)
        near, one = _NEAR.total_seconds(), _ONE_SIDE.total_seconds()
        before = k - 1 if k > 0 and s - sat[k - 1] <= near else None
        after = k if k < len(sat) and sat[k] - s <= near else None
        if before is not None and after is not None and segment[before] == segment[after]:
            seg = segment[before]
        elif before is not None and s - sat[before] <= one:
            seg = segment[before]
        elif after is not None and sat[after] - s <= one:
            seg = segment[after]
        else:
            return None
        pick = (segment == seg) & (np.abs(sat - s) <= near)
        first = int(np.argmax(pick))
        return self._settle(float(np.median(b["ahead"][pick])), b["source"][first] in _SYNCED_BEACON)

    @staticmethod
    def _settle(ahead: float, synced: bool) -> float:
        return 0.0 if synced or abs(ahead) < _SMALL_S else round(ahead, 1)


# -- assigning times ------------------------------------------------------------


def assign(files: list, replies: list[datetime], clock: SatelliteClock | None = None) -> dict[str, Capture]:
    """Capture time, date and basis for each file.

    `files` holds a `Clues` per file (or, the older form, a tuple of path,
    the time the camera log says it opened the file, and the first time any
    of its packets arrived). Each capture reply is used at most once, for
    the earliest-downlinked file it can explain.
    """
    clock = clock or SatelliteClock.empty()
    out: dict[str, Capture] = {}
    unused = list(replies)

    def consume(t: datetime) -> None:
        # The reply to a capture that is already dated mustn't date another.
        unused[:] = [r for r in unused if abs(r - t) > _SAME_CAPTURE]

    def plausible(t: datetime, day: date | None, first_rx: datetime) -> bool:
        return t <= first_rx and (day is None or abs(t.date() - day) <= timedelta(days=1))

    clues = [f if isinstance(f, Clues) else _from_tuple(f) for f in files]
    for c in sorted(clues, key=lambda c: c.first_rx):
        named, day = from_name(c.path)
        if named is not None:
            t, fix = _corrected(clock, named)
            if t <= c.first_rx:
                consume(t)
                out[c.path] = Capture(t, t.date(), "filename", True, fix)
                continue
        opened = _from_log(clock, c.opens)
        if opened is not None and plausible(opened[0], day, c.first_rx):
            consume(opened[0])
            out[c.path] = Capture(opened[0], opened[0].date(), "capture log", *opened[1:])
            continue
        if c.recorded_at is not None:
            t, fix = _corrected(clock, c.recorded_at)
            if plausible(t, day, c.first_rx):
                consume(t)
                out[c.path] = Capture(t, t.date(), "capture record", True, fix)
                continue
        if c.adcs_listed_at is not None and plausible(c.adcs_listed_at, day, c.first_rx):
            # The attitude camera keeps its own clock, synced now and then
            # from the satellite's; nothing here measures it.
            consume(c.adcs_listed_at)
            out[c.path] = Capture(c.adcs_listed_at, c.adcs_listed_at.date(), "ADCS file list", True)
            continue
        reply = _matching_reply(unused, c.first_rx, day)
        if reply is not None:
            unused.remove(reply)
            out[c.path] = Capture(reply, reply.date(), "capture reply")
            continue
        out[c.path] = Capture(None, day, "date only" if day else "unknown")
    return out


def _from_tuple(f: tuple) -> Clues:
    path, opened_at, first_rx = f
    # A bare time is taken as already settled: no stamp, nothing to correct.
    opens = [_Heard(opened_at, None, "", opened_at)] if opened_at is not None else []
    return Clues(path, first_rx, opens)


class _Heard(NamedTuple):  # the shape of reassemble.LogStamp
    stamp: datetime
    session: int | None
    source: str
    received_at: datetime


def _corrected(clock: SatelliteClock, t: datetime, session: int | None = None) -> tuple[datetime, float | None]:
    """A reading of the satellite's clock as a true time, and the seconds
    added to get it (None when nothing covers that reading)."""
    ahead = clock.ahead(t, session=session)
    if ahead is None:
        return t, None
    return t - timedelta(seconds=ahead), (-ahead or 0.0)


def _from_log(clock: SatelliteClock, opens: list) -> tuple[datetime, bool, float | None] | None:
    """The earliest "Opened image file" line, as a true time. The line can't
    have been written after the ground heard it (its receive stamp, plus how
    early those stamps run), whatever the satellite's clock said."""
    found = []
    for o in opens:
        if o.session is None:  # no stamp: the time is the ground's own
            found.append((o.stamp, False, None))
            continue
        t, fix = _corrected(clock, o.stamp, o.session)
        latest = o.received_at + timedelta(seconds=clock.bias_s)
        if t > latest:
            t, fix = latest, round((latest - o.stamp).total_seconds(), 1)
        found.append((t, True, fix))
    return min(found, key=lambda f: f[0], default=None)


def _matching_reply(replies: list[datetime], first_rx: datetime, day: date | None) -> datetime | None:
    candidates = [
        r
        for r in replies
        if first_rx - _REPLY_WINDOW <= r <= first_rx and (day is None or abs(r.date() - day) <= timedelta(days=1))
    ]
    return candidates[-1] if candidates else None
