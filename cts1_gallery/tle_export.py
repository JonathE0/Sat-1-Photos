"""Export the TLE history as the JSON the site's globe propagates from.

Each row of the TLE history table holds one set of mean elements. The
browser propagates with satellite.js, which reads standard two-line element
sets, so `write_tle_json` turns every row back into a proper 69-column line
pair (with checksums) and writes them, oldest first, as

    [{"epoch": "2026-05-08T11:09:01.450Z", "line1": "1 69015U ...",
      "line2": "2 69015 ..."}, ...]

Before anything is written, every line pair is parsed with sgp4's
`Satrec.twoline2rv` and propagated against a `Satrec` initialised directly
from the row's elements; a pair more than 1 km off raises instead of
shipping a bad orbit.

Columns 64-68 of line 2 (revolution number at epoch) aren't in the table,
so they are reconstructed: the first orbit is propagated back to launch and
ascending-node crossings are counted forward from there, TLE to TLE, with
the launch segment as revolution 0. That reproduces Space-Track's own
element sets digit for digit (e.g. rev 2702 at 2026-10-27 22:38:42 UTC).

    python -m cts1_gallery.tle_export      # writes site/data/tle.json
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import polars as pl
from sgp4.api import WGS72, Satrec, jday

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PARQUET = ROOT / "data" / "cache" / "tle_history.parquet"
DEFAULT_OUT = ROOT / "site" / "data" / "tle.json"

# Falcon 9 lifted off with the CAS500-2 rideshare at 06:59 UTC (SatNOGS DB).
LAUNCH_UTC = datetime(2026, 5, 3, 6, 59, tzinfo=timezone.utc)

_SGP4_EPOCH0 = datetime(1949, 12, 31, tzinfo=timezone.utc)  # sgp4init's day 0
_XPDOTP = 1440.0 / (2.0 * math.pi)  # rev/day per rad/min
_TWO_PI = 2.0 * math.pi
_MAX_ROUNDTRIP_KM = 1.0
_DUPLICATE_WINDOW = timedelta(seconds=1)
_NODE_EPSILON = timedelta(seconds=1)


def checksum(line: str) -> int:
    """TLE checksum of the first 68 columns: the sum of the digits, with
    each minus sign counting 1, modulo 10."""
    return sum(int(c) if c.isdigit() else c == "-" for c in line[:68]) % 10


def _with_checksum(body: str) -> str:
    if len(body) != 68:
        raise ValueError(f"TLE line body is {len(body)} columns, not 68: {body!r}")
    return body + str(checksum(body))


def _epoch_field(t: datetime) -> str:
    """YYDDD.DDDDDDDD: two-digit year, then day of year (Jan 1 = 1)."""
    year_start = datetime(t.year, 1, 1, tzinfo=timezone.utc)
    day = (t - year_start) / timedelta(days=1) + 1.0
    return f"{t.year % 100:02d}{day:012.8f}"


def _ndot_field(x: float) -> str:
    """Line 1 cols 34-43: mean motion derivative / 2, as ' .NNNNNNNN'."""
    digits = f"{abs(x):.8f}"
    if not digits.startswith("0."):
        raise ValueError(f"mean_motion_dot out of TLE range: {x}")
    sign = "-" if x < 0 and digits != "0.00000000" else " "
    return sign + digits[1:]


def _exp_field(x: float) -> str:
    """The 8-column '±NNNNN±E' form, meaning ±0.NNNNN x 10^±E."""
    if x == 0 or not math.isfinite(x):
        return " 00000-0"
    exp = math.floor(math.log10(abs(x))) + 1
    mantissa = round(abs(x) / 10.0**exp * 1e5)
    if mantissa >= 100_000:  # rounded up to 1.00000
        mantissa //= 10
        exp += 1
    if exp < -9:
        return " 00000-0"
    if exp > 9:
        raise ValueError(f"value out of TLE range: {x}")
    sign = "-" if x < 0 else " "
    return f"{sign}{mantissa:05d}{'-' if exp < 0 else '+'}{abs(exp)}"


def _angle_field(deg: float) -> str:
    """An angle in [0, 360) as 8 columns with 4 decimals."""
    text = f"{deg % 360.0:8.4f}"
    return "  0.0000" if text == "360.0000" else text


def _eccentricity_field(e: float) -> str:
    """Seven digits with the leading '0.' implied."""
    text = f"{e:.7f}"
    if not 0.0 <= e < 1.0 or not text.startswith("0."):
        raise ValueError(f"eccentricity out of range: {e}")
    return text[2:]


def format_tle(row: dict[str, Any], revnum: int = 0, elset: int = 999) -> tuple[str, str]:
    """Line 1 and line 2 of the TLE for one row of the history table."""
    satnum = int(row["norad_id"])
    if not 0 < satnum <= 99_999:
        raise ValueError(f"catalog number {satnum} needs Alpha-5, which isn't supported")
    intl = (row.get("intl_designator") or "").strip()[:8]
    line1 = (
        f"1 {satnum:05d}U {intl:<8} {_epoch_field(row['epoch'])} "
        f"{_ndot_field(row['mean_motion_dot'])} {_exp_field(0.0)} "
        f"{_exp_field(row['bstar'])} 0 {elset % 10_000:>4d}"
    )
    line2 = (
        f"2 {satnum:05d} {_angle_field(row['inclination'])} "
        f"{_angle_field(row['raan'])} {_eccentricity_field(row['eccentricity'])} "
        f"{_angle_field(row['arg_perigee'])} {_angle_field(row['mean_anomaly'])} "
        f"{row['mean_motion']:11.8f}{revnum % 100_000:5d}"
    )
    return _with_checksum(line1), _with_checksum(line2)


def satrec_from_elements(row: dict[str, Any]) -> Satrec:
    """A Satrec initialised straight from the row's elements (no TLE text)."""
    deg = math.pi / 180.0
    sat = Satrec()
    sat.sgp4init(
        WGS72,
        "i",
        int(row["norad_id"]),
        (row["epoch"] - _SGP4_EPOCH0) / timedelta(days=1),
        row["bstar"],
        row["mean_motion_dot"] / (_XPDOTP * 1440.0),
        0.0,
        row["eccentricity"],
        row["arg_perigee"] * deg,
        row["inclination"] * deg,
        row["mean_anomaly"] * deg,
        row["mean_motion"] / _XPDOTP,
        row["raan"] * deg,
    )
    return sat


def _propagate(sat: Satrec, t: datetime) -> tuple[tuple[float, ...], tuple[float, ...]]:
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
    err, r, v = sat.sgp4(jd, fr)
    if err:
        raise ValueError(f"SGP4 error {err} for satellite {sat.satnum} at {t:%Y-%m-%d %H:%M:%S}")
    return r, v


def _node_phase(sat: Satrec, t: datetime) -> float:
    """Fraction of a revolution since the last ascending node, in [0, 1),
    from the argument of latitude of the osculating state at `t`."""
    (x, y, z), (vx, vy, vz) = _propagate(sat, t)
    hx, hy = y * vz - z * vy, z * vx - x * vz
    node_x, node_y = -hy, hx  # z-axis cross angular momentum
    cos_u = (node_x * x + node_y * y) / (math.hypot(node_x, node_y) * math.hypot(x, y, z))
    u = math.acos(max(-1.0, min(1.0, cos_u)))
    if z < 0:
        u = _TWO_PI - u
    return u / _TWO_PI


def _nodal_rate(sat: Satrec) -> float:
    """Revolutions per minute measured node to node (mean motion plus the
    J2 drift of the argument of perigee)."""
    return (sat.mdot + sat.argpdot) / _TWO_PI


def _node_crossings(phase_a: float, phase_b: float, revs_between: float) -> int:
    """Ascending-node crossings between two instants, given each one's
    phase past its last node and an estimate of the revolutions between."""
    return round(phase_a + revs_between - phase_b)


def revolution_numbers(sats: list[Satrec], epochs: list[datetime]) -> list[int]:
    """Revolution number at each epoch: the ascending-node crossings since
    `LAUNCH_UTC`, so the launch segment is revolution 0.

    Space-Track places most epochs exactly on an ascending node and gives
    the number of the revolution ending there, so the count is taken a
    moment before each epoch rather than leaving it to rounding noise.
    """
    revs: list[int] = []
    if not sats:
        return revs
    phases = [_node_phase(sat, t - _NODE_EPSILON) for sat, t in zip(sats, epochs)]
    launch_phase = _node_phase(sats[0], LAUNCH_UTC)
    minutes = (epochs[0] - _NODE_EPSILON - LAUNCH_UTC) / timedelta(minutes=1)
    revs.append(_node_crossings(launch_phase, phases[0], _nodal_rate(sats[0]) * minutes))
    for i in range(1, len(sats)):
        rate = 0.5 * (_nodal_rate(sats[i - 1]) + _nodal_rate(sats[i]))
        minutes = (epochs[i] - epochs[i - 1]) / timedelta(minutes=1)
        revs.append(revs[-1] + _node_crossings(phases[i - 1], phases[i], rate * minutes))
    return revs


def roundtrip_error_km(line1: str, line2: str, row: dict[str, Any]) -> float:
    """Largest position difference between the parsed TLE and the elements
    it was made from, at the epoch and one day either side."""
    parsed = Satrec.twoline2rv(line1, line2, WGS72)
    direct = satrec_from_elements(row)
    worst = 0.0
    for days in (0.0, -1.0, 1.0):
        t = row["epoch"] + timedelta(days=days)
        a, _ = _propagate(parsed, t)
        b, _ = _propagate(direct, t)
        worst = max(worst, math.dist(a, b))
    return worst


def load_rows(tle_parquet: Path) -> list[dict[str, Any]]:
    """Rows of the TLE history sorted by epoch, with re-publications of the
    same element set (epochs under a second apart) collapsed to the last."""
    df = pl.read_parquet(tle_parquet).drop_nulls(
        ["epoch", "inclination", "raan", "eccentricity", "arg_perigee", "mean_anomaly", "mean_motion"]
    )
    rows: list[dict[str, Any]] = []
    for row in df.sort("epoch").iter_rows(named=True):
        row["epoch"] = row["epoch"].astimezone(timezone.utc)
        row["mean_motion_dot"] = row.get("mean_motion_dot") or 0.0
        row["bstar"] = row.get("bstar") or 0.0
        if rows and row["epoch"] - rows[-1]["epoch"] < _DUPLICATE_WINDOW:
            rows[-1] = row
        else:
            rows.append(row)
    return rows


def _iso_utc(t: datetime) -> str:
    return f"{t:%Y-%m-%dT%H:%M:%S}.{t.microsecond // 1000:03d}Z"


def build_entries(rows: list[dict[str, Any]]) -> tuple[list[dict[str, str]], float]:
    """The JSON entries for `rows`, plus the worst round-trip error in km.
    Raises ValueError if any line pair fails the round-trip check."""
    sats = [satrec_from_elements(row) for row in rows]
    revs = revolution_numbers(sats, [row["epoch"] for row in rows])
    entries: list[dict[str, str]] = []
    worst = 0.0
    for row, rev in zip(rows, revs):
        line1, line2 = format_tle(row, rev)
        error = roundtrip_error_km(line1, line2, row)
        if error > _MAX_ROUNDTRIP_KM:
            raise ValueError(
                f"TLE for epoch {row['epoch']} is {error:.3f} km off its elements:\n{line1}\n{line2}"
            )
        worst = max(worst, error)
        entries.append({"epoch": _iso_utc(row["epoch"]), "line1": line1, "line2": line2})
    return entries, worst


def _write_entries(entries: list[dict[str, str]], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = "[\n" + ",\n".join(json.dumps(e) for e in entries) + "\n]\n"
    part = out_path.with_name(out_path.name + ".part")
    part.write_text(text, encoding="utf-8", newline="\n")
    part.replace(out_path)


def write_tle_json(tle_parquet: Path, out_path: Path) -> int:
    """Write the TLE history in `tle_parquet` to `out_path` as a JSON array
    of {"epoch", "line1", "line2"}, oldest first. Returns the TLE count."""
    entries, _ = build_entries(load_rows(Path(tle_parquet)))
    _write_entries(entries, Path(out_path))
    return len(entries)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="python -m cts1_gallery.tle_export", description="Write the globe's TLE JSON."
    )
    parser.add_argument("--parquet", type=Path, default=DEFAULT_PARQUET, help="TLE history table")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="JSON file to write")
    args = parser.parse_args(argv)

    entries, worst = build_entries(load_rows(args.parquet))
    _write_entries(entries, args.out)
    print(f"wrote {len(entries)} TLEs to {args.out} (worst round-trip error {worst * 1000:.1f} m)")


if __name__ == "__main__":
    main()
