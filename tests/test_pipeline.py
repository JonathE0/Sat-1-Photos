"""Tests for the picture pipeline's core rules, on synthetic data.

    .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""

import hashlib
import io
import random
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import polars as pl
from PIL import Image

from cts1_gallery import build, capture, picam
from cts1_gallery import reassemble as R
from cts1_gallery.reassemble import Chunks, Evidence, _assemble, _assemble_picam, _picam_groups


def picam_file(jpeg: bytes, *, truncate_lines: int | None = None, skip: tuple[int, int] | None = None) -> bytes:
    """A PiCAM file holding `jpeg`, as the camera writes it. `skip` = (n, m):
    after line n-1 the file jumps to line m, as a capture cut short can."""
    lines = [jpeg[i : i + 28].ljust(28, b"\0") for i in range(0, len(jpeg), 28)]
    total = len(lines)
    out = [picam.HEADER]
    numbers = list(range(total))
    if skip:
        numbers = numbers[: skip[0]] + numbers[skip[1] :]
    if truncate_lines is not None:
        numbers = numbers[:truncate_lines]
    for n in numbers:
        out.append(f"@{n:04X}{total:04X}{lines[n].hex().upper()}\r\n".encode())
    if truncate_lines is None and skip is None:
        out.append(f"@FACE{total:04X}{'00' * 28}\r\n".encode())
    return b"".join(out)


def packets(data: bytes, size: int = 195) -> list[tuple[int, bytes]]:
    return [(o, data[o : o + size]) for o in range(0, len(data), size)]


def fake_jpeg(n_bytes: int, seed: int) -> bytes:
    rng = random.Random(seed)
    return b"\xff\xd8\xff\xdb" + bytes(rng.randrange(256) for _ in range(n_bytes - 4))


class DarkFrames(unittest.TestCase):
    @staticmethod
    def frame(spots=(), base=0, missing_rows=0):
        a = np.full((480, 640, 3), base, np.uint8)
        a[:missing_rows] = build._GRAY  # parts that never arrived
        for y, x in spots:
            a[y : y + 4, x : x + 4] = 230
        return Image.fromarray(a)

    def test_black_noise_and_a_lone_sun_are_dark(self):
        self.assertTrue(build._is_dark(self.frame()))
        self.assertTrue(build._is_dark(self.frame(base=14)))
        self.assertTrue(build._is_dark(self.frame([(400, 200)])))
        self.assertTrue(build._is_dark(self.frame([(400, 200)], missing_rows=300)))

    def test_city_lights_and_daylight_are_not(self):
        self.assertFalse(build._is_dark(self.frame([(100, 100), (300, 420)])))
        self.assertFalse(build._is_dark(self.frame(base=120)))
        self.assertFalse(build._is_dark(self.frame(missing_rows=470)))  # too little arrived to tell


class PicamFormat(unittest.TestCase):
    def test_sizes_round_trip(self):
        f = picam_file(fake_jpeg(28 * 50, 1))
        self.assertEqual(picam.line_total_for_size(len(f)), 50)
        self.assertEqual(picam.file_size_for(50), len(f))
        self.assertIsNone(picam.line_total_for_size(len(f) - 3))

    def test_chunk_fits_only_its_own_file(self):
        a = picam_file(fake_jpeg(28 * 50, 1))
        b = picam_file(fake_jpeg(28 * 60, 2))
        for offset, data in packets(a):
            self.assertTrue(picam.chunk_fits(offset, data, 50))
            self.assertFalse(picam.chunk_fits(offset, data, 60))
        self.assertFalse(picam.chunk_fits(67, a[0:195], 50))  # right bytes, wrong offset

    def test_decode_complete_and_partial(self):
        jpeg = fake_jpeg(28 * 40, 3)
        f = picam_file(jpeg)
        d = picam.decode(f, 40)
        self.assertTrue(d.complete)
        self.assertEqual(bytes(d.jpeg), jpeg)
        present = bytearray([1]) * len(f)
        start = len(picam.HEADER) + 10 * picam.LINE_LEN + 20  # inside line 10's hex
        present[start] = 0
        d = picam.decode(f, 40, present)
        self.assertNotIn(10, d.lines)
        self.assertEqual(d.first_missing(), 10)

    def test_truncated_on_board(self):
        f = picam_file(fake_jpeg(28 * 40, 4), truncate_lines=15)
        d = picam.decode(f, 40)
        self.assertTrue(d.truncated_on_board)
        self.assertEqual(d.stored_lines, 15)
        self.assertEqual(len(d.lines), 15)

    def test_header_repair_and_cut_at_gap(self):
        header = b"\xff\xd8" + bytes(range(60)) + b"\xff\xda\x00\x02"  # 66-byte "JPEG header"
        body = fake_jpeg(28 * 30, 5)[4:]
        jpeg = (header + body)[: 28 * 30]
        f = picam_file(jpeg)
        present = bytearray([1]) * len(f)
        line1 = len(picam.HEADER) + 1 * picam.LINE_LEN  # line 1 is inside the header
        line20 = len(picam.HEADER) + 20 * picam.LINE_LEN
        present[line1 + 30] = 0
        present[line20 + 30] = 0
        d = picam.decode(f, 30, present)
        shown, repaired = picam.displayable(d, header)
        self.assertTrue(repaired)
        self.assertEqual(shown, jpeg[: 20 * 28])  # header restored, cut at line 20
        wrong = bytes(len(header))  # a header that disagrees with what arrived
        self.assertEqual(picam.displayable(d, wrong), (None, False))


class Reassembly(unittest.TestCase):
    def test_picam_from_shuffled_packets_of_two_files(self):
        t0 = datetime(2026, 9, 1, tzinfo=UTC)
        a = picam_file(fake_jpeg(28 * 50, 6))
        b = picam_file(fake_jpeg(28 * 70, 7))
        pk = [(o, d, 0) for o, d in packets(a)] * 2 + [(o, d, 1) for o, d in packets(b)]
        random.Random(8).shuffle(pk)
        chunks = Chunks(
            [t0 + timedelta(seconds=i) for i in range(len(pk))],
            [o for o, _, _ in pk],
            [d for _, d, _ in pk],
        )
        groups = _picam_groups(chunks)
        self.assertEqual(sorted(groups), [50, 70])
        out = _assemble(Evidence("camera/a.img"), "picam", len(a), sorted(groups[50]), chunks)
        self.assertTrue(out.have.all())
        self.assertEqual(out.data, a)

    def test_majority_vote_beats_a_stray_copy(self):
        t0 = datetime(2026, 9, 1, tzinfo=UTC)
        good = bytes(range(100))
        bad = bytes(100)
        chunks = Chunks([t0, t0 + timedelta(seconds=1), t0 + timedelta(seconds=2)], [0, 0, 0], [good, bad, good])
        out = _assemble(Evidence("ADCS/x.bmp"), "adcs", 100, [0, 1, 2], chunks)
        self.assertEqual(out.data, good)
        self.assertEqual(out.conflicts, 99)  # byte 0 agrees by chance

    def test_a_short_last_packet_without_a_line_header_is_kept(self):
        # 40 lines: the file is 2758 bytes, so its last packet holds 28 bytes
        # from inside the trailer line, with no "@SSSSTTTT" header to place it.
        t0 = datetime(2026, 9, 1, tzinfo=UTC)
        a = picam_file(fake_jpeg(28 * 40, 9))
        self.assertLess(len(a) % 195, picam.LINE_LEN)
        pk = packets(a) * 2
        random.Random(10).shuffle(pk)
        chunks = Chunks([t0 + timedelta(seconds=i) for i in range(len(pk))], [o for o, _ in pk], [d for _, d in pk])
        e = Evidence("camera/a.img", size=len(a), starts=[t0])
        groups = _picam_groups(chunks)
        claimed = {i for g in groups.values() for i in g}
        out = _assemble_picam({e.path: e}, groups, chunks, [(t0, e.path)], claimed)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].have.all())
        self.assertEqual(out[0].data, a)


T0 = datetime(2026, 11, 3, 18, tzinfo=UTC)


def write_tables(base: Path, *, packets=(), logs=(), replies=(), beacons=()) -> tuple[Path, Path]:
    """Tiny stand-ins for the two pipeline tables. packets: (time, offset,
    bytes); logs and replies: (time, text); beacons: (time, clock reading,
    uptime s, sync source)."""
    rows = [("BULK_FILE_DOWNLINK", t, True, o, d.hex(), None, None, None, None) for t, o, d in packets]
    rows += [("LOG_MESSAGE", t, True, None, None, text, None, None, None) for t, text in logs]
    rows += [("BEACON_BASIC", t, True, None, None, None, int(sat.timestamp() * 1000), up, src) for t, sat, up, src in beacons]
    names = ["packet_type", "received_at", "csp_crc_valid", "bulk_file_offset", "bulk_data_hex", "log_message"]
    names += ["unix_epoch_time_ms", "uptime_sec", "last_time_sync_source"]
    schema = {
        "packet_type": pl.String, "received_at": pl.Datetime("us", "UTC"), "csp_crc_valid": pl.Boolean,
        "bulk_file_offset": pl.Int64, "bulk_data_hex": pl.String, "log_message": pl.String,
        "unix_epoch_time_ms": pl.Int64, "uptime_sec": pl.Float64, "last_time_sync_source": pl.String,
    }
    decoded = base / "everything_decoded.parquet"
    pl.DataFrame(rows, schema=schema, orient="row").select(names).sort("received_at").write_parquet(decoded)
    responses = base / "reassembled_tcmd_responses.parquet"
    pl.DataFrame(
        sorted(replies, reverse=True),  # the pipeline writes this table newest first
        schema={"first_received_at": pl.Datetime("us", "UTC"), "tcmd_response_text": pl.String},
        orient="row",
    ).write_parquet(responses)
    return decoded, responses


def descriptor(path: str, data: bytes) -> str:
    return (
        f'{{"action":"bulk_downlink_start_blob","file":"{path}","file_size":{len(data)},'
        f'"sha256":"{hashlib.sha256(data).hexdigest().upper()}"}}'
    )


def download(data: bytes, start: datetime, *, bad: dict | None = None) -> list:
    """Every packet of `data`, one a second from `start`; `bad` maps a packet
    number to a few corrupted bytes."""
    out = []
    for k, (o, d) in enumerate(packets(data)):
        if bad and k in bad:
            d = bytes(b ^ 0xFF if j < bad[k] else b for j, b in enumerate(d))
        out.append((start + timedelta(seconds=k + 1), o, d))
    return out


class EndToEnd(unittest.TestCase):
    """reassemble() on small synthetic tables."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        header = fake_jpeg(1429, 20)  # the JPEG header every capture shares
        self.a = picam_file((header + fake_jpeg(28 * 342, 21))[: 28 * 342])
        self.b = picam_file((header + fake_jpeg(28 * 342, 22))[: 28 * 342])

    def run_tables(self, **tables) -> dict:
        r = R.reassemble(*write_tables(self.base, **tables))
        return {a.path: a for a in r.files}

    def test_two_named_captures_with_one_line_total_two_hours_apart(self):
        pa, pb = "camera/2026-11-03_180000Z.img", "camera/2026-11-03_181000Z.img"
        tb = T0 + timedelta(hours=2)
        files = self.run_tables(
            packets=download(self.a, T0) + download(self.b, tb),
            replies=[(T0, descriptor(pa, self.a)), (tb, descriptor(pb, self.b))],
        )
        self.assertTrue(files[pa].verified and files[pb].verified, files)
        self.assertEqual((files[pa].data, files[pb].data), (self.a, self.b))

    def test_a_capture_without_a_descriptor_does_not_join_a_named_one(self):
        pa = "camera/2026-11-03_180000Z.img"
        files = self.run_tables(
            packets=download(self.a, T0) + download(self.b, T0 + timedelta(days=10)),
            replies=[(T0, descriptor(pa, self.a))],
        )
        self.assertTrue(files[pa].verified)
        unnamed = [a for p, a in files.items() if p != pa]
        self.assertEqual(len(unnamed), 1)
        self.assertTrue(unnamed[0].unnamed)
        self.assertEqual(unnamed[0].data, self.b)

    def test_a_repeated_download_with_a_few_bad_bytes_stays_one_file(self):
        pa = "camera/2026-11-03_180000Z.img"
        t2 = T0 + timedelta(hours=3)
        files = self.run_tables(
            packets=download(self.a, T0) + download(self.a, t2, bad={30: 3}) + download(self.a, t2 + timedelta(hours=1)),
            replies=[(T0, descriptor(pa, self.a)), (t2, descriptor(pa, self.a))],
        )
        self.assertEqual(list(files), [pa])
        self.assertTrue(files[pa].verified)

    def test_a_recapture_under_the_same_name_is_two_pictures(self):
        path = "camera/2026-11-03.img"
        small = picam_file(fake_jpeg(28 * 93, 23))
        for later, gap in ((small, timedelta(days=5)), (self.b, timedelta(days=5))):  # other / same line total
            with self.subTest(lines=picam.line_total_for_size(len(later))):
                t2 = T0 + gap
                files = self.run_tables(
                    packets=download(self.a, T0) + download(later, t2),
                    replies=[(T0, descriptor(path, self.a)), (t2, descriptor(path, later))],
                )
                self.assertEqual(sorted(files), ["camera/2026-11-03.earlier-1.img", path])
                self.assertTrue(all(f.verified for f in files.values()))
                self.assertEqual(files[path].data, later)

    def test_a_slashed_path_is_the_same_file(self):
        bmp = bytes(range(256)) * 4
        t = T0
        logs = [(t, "Blob (bulk_downlink_start_blob) args_str: '/ADCS/img_x.bmp;0;0'")]
        logs.append((t + timedelta(seconds=30), f"Bulk downlink complete. {len(bmp)} bytes (6 packets) downlinked. File: /ADCS/img_x.bmp"))
        files = self.run_tables(packets=download(bmp, t), logs=logs)
        self.assertIn("ADCS/img_x.bmp", files)
        self.assertEqual(files["ADCS/img_x.bmp"].data, bmp)

    def test_a_refused_download_says_why(self):
        path = "camera/2026-07-15-T17-49-30Z.img"
        logs = [(T0, f"1789000000000+0000000001_E Blob (bulk_downlink_start_blob) args_str: '{path};0;0'")]
        replies = [(T0 + timedelta(seconds=2),
                    f"Running bulk_downlink_start_blob: '{path};0;0' failed in checking file size/hash. Error: -2.")]
        evidence = R.gather_evidence(*write_tables(self.base, logs=logs, replies=replies))
        e = evidence[path]
        self.assertEqual((len(e.starts), len(e.refused)), (1, 1))
        self.assertIn("no such file on board", build._never_received_reason(e))
        e.refused = [(T0, "bulk_downlink_start_fixed()", 3)]
        self.assertIn("empty on board", build._never_received_reason(e))
        self.assertIn("no packets", build._never_received_reason(Evidence(path, starts=[T0])))

    def test_the_attitude_camera_file_list_dates_a_frame(self):
        line = '1788936873000+0004136511_E [S:ADCS:INFO]: {"index":31,"type":"BMP_IMG","counter":1,"size":%d,"datetime":"%s","crc16":"0x5608"}'
        when = datetime(2026, 9, 9, 8, 7, 12, tzinfo=UTC)
        for size, stamp, expected in [
            (1000, "2026-09-09 07:05:24", datetime(2026, 9, 9, 7, 5, 24, tzinfo=UTC)),
            (1000, "2000-01-01 00:46:16", None),  # the ADCS clock was never set
            (1000, "2025-06-02 03:57:48", None),  # a stale clock
            (999, "2026-09-09 07:05:24", None),  # another file with that CRC
        ]:
            with self.subTest(size=size, stamp=stamp):
                logs = [(when, line % (size, stamp)),
                        (when, "Bulk downlink complete. 1000 bytes (6 packets) downlinked. File: ADCS/img_5608.bmp")]
                evidence = R.gather_evidence(*write_tables(self.base, logs=logs))
                self.assertEqual(evidence["ADCS/img_5608.bmp"].adcs_listed_at, expected)


class Truncated(unittest.TestCase):
    def test_a_forward_skip_on_board_still_fits(self):
        f = picam_file(fake_jpeg(28 * 30, 11), skip=(10, 20))
        for offset, data in packets(f):
            self.assertTrue(picam.chunk_fits(offset, data, 30), offset)
        a = picam_file(fake_jpeg(28 * 50, 1))
        self.assertFalse(picam.chunk_fits(67, a[0:195], 50))  # right bytes, wrong offset

    def test_a_bit_exact_truncated_capture_is_still_truncated(self):
        im = Image.effect_noise((96, 64), 60).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        jpeg = buf.getvalue()
        total = -(-len(jpeg) // 28)
        f = picam_file(jpeg, skip=(60, total - 5))  # lines 0-59, then the last five
        e = Evidence("camera/x.img", size=len(f), sha256={hashlib.sha256(f).hexdigest()})
        t = datetime(2026, 10, 22, tzinfo=UTC)
        a = R.Assembled(e.path, "picam", len(f), f, np.ones(len(f), dtype=bool), 1, 0, t, t, e, line_total=total)
        self.assertTrue(a.verified)
        r = build._render_picam(a, None)
        self.assertEqual(r.status, "truncated")
        self.assertIn("lines 0–59", r.note)
        self.assertIn(f"skips to line {total - 5}", r.note)
        self.assertIn("bit-exact", r.note)
        self.assertAlmostEqual(r.completeness, 60 / total)


class Ids(unittest.TestCase):
    def test_clashing_slugs_get_distinct_ids_and_the_first_keeps_its_own(self):
        t = datetime(2026, 10, 24, tzinfo=UTC)
        files = [SimpleNamespace(path="camera/2026-10-24-cam.img", first_rx=t + timedelta(hours=1)),
                 SimpleNamespace(path="camera/2026-10-24_cam.img", first_rx=t)]
        ids = build._unique_ids(files)
        self.assertEqual(ids["camera/2026-10-24_cam.img"], "2026-10-24-cam")
        self.assertNotEqual(ids["camera/2026-10-24-cam.img"], "2026-10-24-cam")
        self.assertTrue(ids["camera/2026-10-24-cam.img"].startswith("2026-10-24-cam-"))


def heard(stamp: datetime, rx: datetime, session: int = 1) -> R.LogStamp:
    return R.LogStamp(stamp, session, "E", rx)


class CaptureTimes(unittest.TestCase):
    def test_filename_styles(self):
        cases = {
            "camera/2026-09-17_071148Z.img": datetime(2026, 9, 17, 7, 11, 48, tzinfo=UTC),
            "camera/2026-10-25005433z.img": datetime(2026, 10, 25, 0, 54, 33, tzinfo=UTC),
            "camera/2026-07-15-T17-49-30Z.img": datetime(2026, 7, 15, 17, 49, 30, tzinfo=UTC),
            # 'L' names are UTC too: read as Calgary time this capture would
            # come an hour after its own download began.
            "camera/2026-10-24_173732L.img": datetime(2026, 10, 24, 17, 37, 32, tzinfo=UTC),
        }
        for name, expected in cases.items():
            self.assertEqual(capture.from_name(name)[0], expected, name)
        t, day = capture.from_name("camera/2026-08-08.img")
        self.assertIsNone(t)
        self.assertEqual(str(day), "2026-08-08")

    def test_a_time_after_the_first_packet_is_passed_over(self):
        first_rx = datetime(2026, 10, 24, 22, 37, 41, tzinfo=UTC)
        out = capture.assign([("camera/2026-10-24_233732Z.img", None, first_rx)], [])
        self.assertEqual(out["camera/2026-10-24_233732Z.img"].basis, "date only")

    def test_a_dated_capture_does_not_lend_its_reply(self):
        reply = datetime(2026, 8, 27, 18, 48, 27, tzinfo=UTC)
        files = [
            ("camera/2026-08-27.img", reply + timedelta(seconds=3), reply + timedelta(hours=2)),
            ("camera/2026-08-28.img", None, reply + timedelta(hours=21)),
        ]
        out = capture.assign(files, [reply])
        self.assertEqual(out["camera/2026-08-27.img"][2], "capture log")
        self.assertEqual(out["camera/2026-08-28.img"][2], "date only")

    def test_a_log_line_is_never_later_than_the_ground_heard_it(self):
        rx = datetime(2026, 7, 23, 21, 40, 15, tzinfo=UTC)
        fast = rx + timedelta(seconds=40)
        line = f"{int(fast.timestamp() * 1000)}+0000000000_E Opened image file: camera/x.img"
        self.assertEqual(R._log_time(line, rx), rx)
        earlier = rx - timedelta(hours=2)  # a stored line, written before it was sent
        line = f"{int(earlier.timestamp() * 1000)}+0000000000_E Opened image file: camera/x.img"
        self.assertEqual(R._log_time(line, rx), earlier)

    def test_the_satellite_clock_is_corrected_per_session(self):
        rx = datetime(2026, 7, 23, 21, 40, 15, tzinfo=UTC)
        session = int((rx - timedelta(hours=3)).timestamp() * 1000)
        clock = capture.SatelliteClock([capture._Session(session, rx.timestamp(), "E", 36.6, 200)], 3.4)
        first_rx = rx + timedelta(minutes=30)
        # Stamped 40 s fast, in a session that runs 36.6 s fast.
        c = capture.Clues("camera/2026-07-23.img", first_rx, [heard(rx + timedelta(seconds=40), rx, session)])
        got = capture.assign([c], [], clock)[c.path]
        self.assertEqual((got.basis, got.on_board_clock, got.correction_s), ("capture log", True, -36.6))
        self.assertEqual(got.at, rx + timedelta(seconds=3.4))
        # Without a measured session, the line still can't postdate its receipt.
        c = capture.Clues("camera/2026-07-23.img", first_rx, [heard(rx + timedelta(seconds=40), rx, session + 1)])
        got = capture.assign([c], [], clock)[c.path]
        self.assertEqual(got.at, rx + timedelta(seconds=3.4))
        self.assertEqual(got.correction_s, -36.6)
        # A filename time in that session is corrected too; one outside every session is left alone.
        named = capture.Clues("camera/2026-07-23_204000Z.img", first_rx)
        got = capture.assign([named], [], clock)[named.path]
        self.assertEqual((got.at.second, got.at.microsecond, got.correction_s), (23, 400000, -36.6))
        far = capture.Clues("camera/2026-07-25_204000Z.img", first_rx + timedelta(days=3))
        got = capture.assign([far], [], clock)[far.path]
        self.assertEqual((got.at, got.on_board_clock, got.correction_s), (datetime(2026, 7, 25, 20, 40, tzinfo=UTC), True, None))

    def test_beacons_measure_the_clock(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        t = datetime(2026, 9, 17, 6, tzinfo=UTC)
        beacons = []
        for k in range(30):  # a 42 s fast EPS-synced clock; receive stamps 3.4 s early
            rx = t + timedelta(minutes=k)
            beacons.append((rx, rx + timedelta(seconds=45.4), 1000.0 + 60 * k, "EPS_RTC"))
        for k in range(30):  # GNSS-synced a day later: the receive stamps' own bias
            rx = t + timedelta(days=1, minutes=k)
            beacons.append((rx, rx + timedelta(seconds=3.4), 90000.0 + 60 * k, "GNSS_UART"))
        for k in range(5):  # a resync a day before: a different clock
            rx = t - timedelta(days=1, minutes=k)
            beacons.append((rx, rx + timedelta(seconds=10), 50.0 + 60 * k, "EPS_RTC"))
        decoded, _ = write_tables(Path(tmp.name), beacons=beacons)
        clock = capture.SatelliteClock.load(decoded)
        self.assertAlmostEqual(clock.ahead(t + timedelta(minutes=15, seconds=42)), 42.0, places=1)
        self.assertEqual(clock.ahead(t + timedelta(days=1, minutes=10)), 0.0)  # synced
        self.assertIsNone(clock.ahead(t - timedelta(hours=12)))  # between two clocks, far from both

    def test_a_capture_record_dates_a_capture(self):
        payload = b'ne":1780295260546,"tcmd":"camera_capture","duration_ms":8262,"return":0,"args":"camera/2026-06-01_capture.img,d"}'
        m = R._RUN_CAPTURE_RE.search(payload)
        started = datetime.fromtimestamp((int(m.group(1)) - int(m.group(2))) / 1000, UTC)
        self.assertEqual(started, datetime(2026, 6, 1, 6, 27, 32, 284000, tzinfo=UTC))
        self.assertEqual(m.group(3), b"camera/2026-06-01_capture.img")
        reply = started + timedelta(minutes=5)
        c = capture.Clues("camera/2026-06-01_capture.img", started + timedelta(days=2), recorded_at=started)
        other = capture.Clues("camera/2026-06-01_other.img", started + timedelta(days=2, hours=1))
        out = capture.assign([c, other], [reply])
        self.assertEqual((out[c.path].basis, out[c.path].at), ("capture record", started))
        self.assertEqual(out[other.path].basis, "date only")  # the reply was this capture's


if __name__ == "__main__":
    unittest.main()
