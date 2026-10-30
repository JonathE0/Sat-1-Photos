"""The PiCAM ASCII image format CTS-SAT-1 stores camera captures in.

A capture is written to the satellite's filesystem as text:

    START_CAM:\\n
    @SSSSTTTT<56 hex chars>\\r\\n      one line per 28 bytes of JPEG
    ...
    @FACETTTT<56 hex chars>\\r\\n      camera telemetry trailer

`SSSS` is the line's sequence number and `TTTT` the total number of JPEG
lines, both 4 hex digits. Every line is the same 67 bytes, so line `n`
always starts at byte `11 + 67 * n`: any fragment of the file is
self-locating, and only a line's 56 hex characters carry information.
`chunk_fits` uses that to reject a downlinked chunk that landed in the wrong
file's time window -- its line headers sit at the wrong offsets or name a
different line total.

A capture can be cut short on board, in which case the file holds fewer
lines than `TTTT` announces and has no trailer. Such a file can also skip
forward: camera/2026-10-22_150759Z.img holds lines 0-249, then 500 onward.
Only the lines before the skip are in sequence, and only they are shown.

The JPEGs have no restart markers, so a decoder can't resynchronise after a
gap: a partly received image is shown up to its first missing line. Their
header (quantisation and Huffman tables, frame and scan headers) is the same
for every capture, so missing header lines can be restored exactly from a
complete capture (`header_template`).
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

HEADER = b"START_CAM:\n"
LINE_LEN = 67  # "@" + 4 + 4 + 56 hex + "\r\n"
DATA_PER_LINE = 28
_PAYLOAD = slice(9, 9 + 2 * DATA_PER_LINE)  # within a line
_HEX4 = re.compile(rb"[0-9A-F]{4}")


def line_total_for_size(file_size: int) -> int | None:
    """The `TTTT` a complete, well-formed PiCAM file of `file_size` bytes
    carries: header, `TTTT` JPEG lines, one trailer line.
    """
    body = file_size - len(HEADER)
    if body <= LINE_LEN or body % LINE_LEN:
        return None
    return body // LINE_LEN - 1


def file_size_for(line_total: int) -> int:
    return len(HEADER) + (line_total + 1) * LINE_LEN


def chunk_fits(offset: int, data: bytes, line_total: int) -> bool:
    """Whether a chunk at `offset` is consistent with a PiCAM file whose
    lines total `line_total`: every complete line header inside it must sit
    where line `n` belongs and name `line_total`, and either FACE or a line
    from `n` up (a capture cut short on board can skip forward, see the
    module docstring, but never back).

    A chunk containing no complete header (only possible for a very short
    one) can't be checked and passes.
    """
    end = offset + len(data)
    if offset < len(HEADER):
        overlap = data[: len(HEADER) - offset]
        if HEADER[offset : offset + len(overlap)] != overlap:
            return False
    first = max(0, -(-(offset - len(HEADER)) // LINE_LEN))
    total_hex = f"{line_total:04X}".encode()
    n = first
    while (start := len(HEADER) + n * LINE_LEN) + 9 <= end:
        i = start - offset
        head = data[i : i + 9]
        seq = head[1:5]
        if head[:1] != b"@" or head[5:9] != total_hex:
            return False
        if seq != b"FACE" and not (_HEX4.fullmatch(seq) and n <= int(seq, 16) < line_total):
            return False
        n += 1
    return True


@dataclass(slots=True)
class DecodedPicam:
    jpeg: bytearray  # line_total * 28 bytes, zeros where a line is missing
    line_total: int
    lines: set[int] = field(default_factory=set)  # line numbers received
    stored_lines: int = 0  # lines the on-board file actually holds
    trailer_hex: str | None = None
    # A capture cut short on board that skips forward: the first position
    # whose framing names a later line, and that line.
    in_sequence: int | None = None
    skips_to: int | None = None

    @property
    def complete(self) -> bool:
        return len(self.lines) == self.line_total

    @property
    def truncated_on_board(self) -> bool:
        return self.stored_lines < self.line_total

    def first_missing(self, from_byte: int = 0) -> int | None:
        """The first missing line whose bytes reach past `from_byte`."""
        start = from_byte // DATA_PER_LINE
        return next((n for n in range(start, self.line_total) if n not in self.lines), None)


def decode(data: bytes, line_total: int, present: bytes | bytearray | None = None) -> DecodedPicam:
    """Pull the JPEG lines out of (possibly incomplete) PiCAM file bytes.

    `present` is an optional per-byte mask of which bytes were received; a
    line counts when all 56 of its hex characters arrived (its framing is
    predictable, so it doesn't need to have) and, where its framing did
    arrive, the framing names this line.
    """
    out = DecodedPicam(bytearray(line_total * DATA_PER_LINE), line_total)
    out.stored_lines = min(line_total, max(0, (len(data) - len(HEADER)) // LINE_LEN))
    for n in range(line_total + 1):
        start = len(HEADER) + n * LINE_LEN
        payload = slice(start + _PAYLOAD.start, start + _PAYLOAD.stop)
        if payload.stop > len(data):
            break
        if present is not None and not all(present[payload]):
            continue
        frame = data[start : start + 9]
        expected = (b"@FACE" if n == line_total else f"@{n:04X}".encode()) + f"{line_total:04X}".encode()
        if (present is None or all(present[start : start + 9])) and frame != expected:
            seq = frame[1:5]
            if out.in_sequence is None and frame[5:9] == expected[5:9] and _HEX4.fullmatch(seq) and int(seq, 16) > n:
                out.in_sequence, out.skips_to = n, int(seq, 16)
            continue
        try:
            chunk = bytes.fromhex(data[payload].decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            continue
        if n == line_total:
            out.trailer_hex = chunk.hex().upper()
        else:
            out.jpeg[n * DATA_PER_LINE : (n + 1) * DATA_PER_LINE] = chunk
            out.lines.add(n)
    return out


def header_length(jpeg: bytes) -> int | None:
    """Bytes up to the end of the JPEG's scan header (SOS segment)."""
    sos = jpeg.find(b"\xff\xda")
    if sos < 0 or sos + 4 > len(jpeg):
        return None
    return sos + 2 + int.from_bytes(jpeg[sos + 2 : sos + 4], "big")


def header_template(complete_jpegs: list[bytes]) -> bytes | None:
    """The JPEG header most complete captures share, for repairing others."""
    headers = Counter(j[:n] for j in complete_jpegs if (n := header_length(j)))
    return headers.most_common(1)[0][0] if headers else None


def displayable(decoded: DecodedPicam, template: bytes | None) -> tuple[bytes | None, bool]:
    """JPEG bytes a browser can show, and whether the header was repaired.

    A complete capture is returned as is. Otherwise missing header lines
    are filled in from `template` (only if every header byte that did
    arrive agrees with it) and the stream is cut at the first missing line
    after the header -- decoders render what precedes it.
    """
    jpeg = bytes(decoded.jpeg)
    if decoded.complete:
        return jpeg, False
    repaired = False
    head_len = len(template) if template else header_length(jpeg) or 0
    missing_head = [n for n in range(-(-head_len // DATA_PER_LINE)) if n not in decoded.lines]
    if missing_head:
        if template is None:
            return None, False
        for n in decoded.lines:
            lo, hi = n * DATA_PER_LINE, min((n + 1) * DATA_PER_LINE, len(template))
            if lo < hi and jpeg[lo:hi] != template[lo:hi]:
                return None, False  # a different header: don't guess
        buf = bytearray(jpeg)
        buf[: len(template)] = template
        jpeg, repaired = bytes(buf), True
    gap = decoded.first_missing(from_byte=head_len)
    if gap is not None:
        jpeg = jpeg[: max(gap * DATA_PER_LINE, head_len)]
    if len(jpeg) <= head_len:
        return None, repaired
    return jpeg, repaired
