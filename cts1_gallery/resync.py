"""Main-camera pictures read on past their gaps.

The camera's JPEGs are baseline and have no restart markers, so a decoder that meets a gap
can't find its place again: picam.displayable() shows a picture down to its first missing
line. `piece_together` reads on past each gap, for build.py.

Every line of a capture names itself, so where each received byte sits in the JPEG is
known. What a gap loses is the decoder's place in the bit stream. After a gap:

1. The step. The picture is a stream of variable-length codes, block after block, with
   nothing marking where a block starts. Decoding is tried from every bit of the first
   SEARCH_BYTES bytes after the gap. A wrong start soon meets a code that can't occur, or
   falls into step with the real stream (such codes resynchronise), so nearly every try
   ends on the same chain of blocks: that chain is the picture. Its first SKIP_MCUS blocks
   are left out, in case they're still out of step.
2. The place. A piece that runs to the end of the picture is placed by counting its blocks
   back from the end. Any other goes where its top and left edges best continue what is
   drawn already, and only if that place fits clearly better than every other.
3. The level. Each block's average (its DC) is coded as a change from the block before, so
   after a gap the level is lost: one unknown each for Y, Cb and Cr, the same over the
   whole piece. It's set so the piece meets the picture above it smoothly.

A piece that touches nothing drawn already can't be placed or levelled, so it isn't shown;
nor is anything past a gap unless the picture's own start arrived.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image

from . import picam

SEARCH_BYTES = 160  # where after a gap the step is looked for
SKIP_MCUS = 2  # blocks left out where a piece starts, in case they're still out of step
MIN_HITS = 4  # tries that must share a block before it counts as in step
MIN_TRIES = 32  # tries that must end on the chosen chain,
CLEAR_STEP = 2  # and how many times the tries of the next chain
MIN_PIECE = 4  # blocks a piece needs to be worth placing
MIN_PAIRS = 3  # blocks of a piece that must touch the picture drawn already
CLEAR_FIT = 0.7  # the best place's misfit at most this times the next best's
MIN_MCU_BYTES = 3  # no block (six 8x8 blocks) codes in fewer: bounds how many a gap can hold

_ZIGZAG = np.array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44,
    51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63])
_IDCT = np.array([[(math.sqrt(0.5) if u == 0 else 1.0) * math.cos((2 * x + 1) * u * math.pi / 16) / 2
                   for x in range(8)] for u in range(8)])


class _Bad(Exception):
    """A code that can't occur here: not the picture's stream, or not in step with it."""


class _End(Exception):
    """The piece's bytes ran out."""


@dataclass(slots=True)
class Pieced:
    image: Image.Image  # RGB, the frame's size, flat grey (128) where nothing is known
    shown: float  # share of the picture's blocks drawn
    pieces: int  # pieces drawn past a gap
    left_out: int  # pieces past a gap that couldn't be placed and levelled


# -- the JPEG's tables ---------------------------------------------------------


def _huffman(counts: list[int], symbols: list[int]) -> list:
    """16-bit lookahead -> (symbol, code length), None where no code begins."""
    table: list = [None] * 65536
    code = k = 0
    for length in range(1, 17):
        for _ in range(counts[length - 1]):
            lo, hi = code << (16 - length), (code + 1) << (16 - length)
            table[lo:hi] = [(symbols[k], length)] * (hi - lo)
            k += 1
            code += 1
        code <<= 1
    return table


class _Decoder:
    def __init__(self, header: bytes):
        quant, tables, comps = {}, {}, []
        self.size = None
        i = 2
        while i + 4 <= len(header):
            if header[i] != 0xFF:
                raise ValueError("not a JPEG header")
            marker = header[i + 1]
            n = int.from_bytes(header[i + 2 : i + 4], "big")
            body = header[i + 4 : i + 2 + n]
            if marker == 0xDB:  # quantisation tables
                j = 0
                while j < len(body):
                    if body[j] >> 4:
                        raise ValueError("16-bit quantisation")
                    quant[body[j] & 15] = np.array(list(body[j + 1 : j + 65]), dtype=np.float64)
                    j += 65
            elif marker == 0xC4:  # Huffman tables
                j = 0
                while j < len(body):
                    counts = list(body[j + 1 : j + 17])
                    tables[(body[j] >> 4, body[j] & 15)] = _huffman(counts, list(body[j + 17 : j + 17 + sum(counts)]))
                    j += 17 + sum(counts)
            elif marker == 0xC0:  # baseline frame
                self.size = (int.from_bytes(body[3:5], "big"), int.from_bytes(body[1:3], "big"))
                for k in range(body[5]):
                    cid, hv, tq = body[6 + 3 * k : 9 + 3 * k]
                    comps.append({"id": cid, "h": hv >> 4, "v": hv & 15, "q": tq})
            elif marker == 0xDA:  # scan
                for k in range(body[0]):
                    c = next(c for c in comps if c["id"] == body[1 + 2 * k])
                    c["dc"], c["ac"] = body[2 + 2 * k] >> 4, body[2 + 2 * k] & 15
                break
            elif marker in (0xC1, 0xC2, 0xC3, 0xDD):
                raise ValueError("not a baseline JPEG without restarts")
            i += 2 + n
        if self.size is None or len(comps) != 3 or any("dc" not in c for c in comps):
            raise ValueError("no baseline frame and scan")
        self.comps = comps
        self.quant = [quant[c["q"]] for c in comps]
        self.order = [(ci, tables[(0, c["dc"])], tables[(1, c["ac"])])
                      for ci, c in enumerate(comps) for _ in range(c["h"] * c["v"])]
        hmax, vmax = max(c["h"] for c in comps), max(c["v"] for c in comps)
        self.scale = [(hmax // c["h"], vmax // c["v"]) for c in comps]  # subsampling per component
        self.mcu_w, self.mcu_h = 8 * hmax, 8 * vmax
        self.cols = -(-self.size[0] // self.mcu_w)
        self.rows = -(-self.size[1] // self.mcu_h)
        self.count = self.cols * self.rows

    def mcu(self, bits: _Bits, p: int, coefficients: bool = False):
        """One MCU from bit p: (next bit, [(component, dc change, coefficients or None)])."""
        out = []
        for ci, dc_table, ac_table in self.order:
            s, n = _code(dc_table, bits, p)
            p += n
            if s > 11:
                raise _Bad
            diff = _extend(bits.take(p, s), s) if s else 0
            p += s
            coef = np.zeros(64) if coefficients else None
            k = 1
            while k < 64:
                rs, n = _code(ac_table, bits, p)
                p += n
                run, s = rs >> 4, rs & 15
                if s == 0:
                    if run == 15:
                        k += 16
                        continue
                    if run == 0:
                        break
                    raise _Bad
                k += run
                if k > 63 or s > 10:
                    raise _Bad
                v = _extend(bits.take(p, s), s)
                p += s
                if coefficients:
                    coef[k] = v
                k += 1
            if k > 64:
                raise _Bad
            out.append((ci, diff, coef))
        return p, out


class _Bits:
    def __init__(self, data: bytes):
        self.n = len(data) * 8
        padded = data + bytes(4)
        self.window = [int.from_bytes(padded[i : i + 4], "big") for i in range(len(data) + 1)]

    def peek16(self, p: int) -> int:
        if p >= self.n:
            raise _End
        return (self.window[p >> 3] >> (16 - (p & 7))) & 0xFFFF

    def take(self, p: int, s: int) -> int:
        if p + s > self.n:
            raise _End
        return (self.window[p >> 3] >> (32 - (p & 7) - s)) & ((1 << s) - 1)


def _code(table, bits: _Bits, p: int):
    entry = table[bits.peek16(p)]
    if entry is None:
        raise _Bad
    if p + entry[1] > bits.n:
        raise _End  # a code running off the end: the bytes stop mid-code
    return entry


def _extend(v: int, s: int) -> int:
    return v - (1 << s) + 1 if v < (1 << (s - 1)) else v


def _unstuff(raw: bytes) -> tuple[bytes, bool]:
    """The entropy-coded bytes with FF00 back to FF, up to any marker; and whether that
    marker is the picture's end (EOI)."""
    out = bytearray()
    i = 0
    while i < len(raw):
        b = raw[i]
        if b != 0xFF:
            out.append(b)
            i += 1
            continue
        if i + 1 >= len(raw):
            break  # an FF whose next byte didn't arrive
        if raw[i + 1] == 0x00:
            out.append(0xFF)
            i += 2
            continue
        return bytes(out), raw[i + 1] == 0xD9
    return bytes(out), False


# -- finding the step ----------------------------------------------------------


def _chain_from_start(dec: _Decoder, bits: _Bits) -> list[int]:
    """MCU start bits of a piece that begins the scan: in step from bit 0."""
    path, p = [], 0
    while True:
        try:
            q, _ = dec.mcu(bits, p)
        except (_Bad, _End):
            return path
        path.append(p)
        p = q


def _find_step(dec: _Decoder, bits: _Bits) -> list[int] | None:
    """MCU start bits of the chain most tries from the first SEARCH_BYTES end on, or None."""
    starts = range(min(bits.n, SEARCH_BYTES * 8))
    nxt: dict[int, int] = {}
    fate: dict[int, str] = {}
    hits: dict[int, int] = {}
    for b in starts:
        p, walked = b, []
        while p not in nxt and p not in fate:
            try:
                q, _ = dec.mcu(bits, p)
            except _Bad:
                fate[p] = "bad"
                break
            except _End:
                fate[p] = "end"
                break
            nxt[p] = q
            walked.append(p)
            p = q
        for x in walked:
            hits[x] = hits.get(x, 0) + 1
        for _ in range(64):  # on down the chain it joined, as far as the step is looked for
            if p not in nxt:
                break
            hits[p] = hits.get(p, 0) + 1
            p = nxt[p]

    def last(p):
        while p in nxt:
            p = nxt[p]
        return p

    ends: dict[int, list[int]] = {}
    for b in starts:
        e = last(b)
        if fate.get(e) == "end":
            ends.setdefault(e, []).append(b)
    if not ends:
        return None
    ranked = sorted(ends.values(), key=len, reverse=True)
    tries = ranked[0]
    # tries near a short piece's end join nothing, so the test is against the next chain, not all tries
    if len(tries) < MIN_TRIES or (len(ranked) > 1 and len(tries) < CLEAR_STEP * len(ranked[1])):
        return None
    p = tries[0]
    while p in nxt and hits.get(p, 0) < MIN_HITS:
        p = nxt[p]
    path = []
    while p in nxt:
        path.append(p)
        p = nxt[p]
    return path[SKIP_MCUS:]


# -- pixels --------------------------------------------------------------------


def _decode_piece(dec: _Decoder, bits: _Bits, path: list[int]) -> list[list[np.ndarray]]:
    """Each MCU as one array per component (8v x 8h pixels), level-shifted by the piece's
    unknown DC: add each component's offset and 128 to get pixel values."""
    level = [0.0] * len(dec.comps)
    out = []
    for p in path:
        _, blocks = dec.mcu(bits, p, coefficients=True)
        planes = [np.zeros((8 * c["v"], 8 * c["h"])) for c in dec.comps]
        seen = [0] * len(dec.comps)
        for ci, diff, coef in blocks:
            level[ci] += diff
            c = dec.comps[ci]
            q = dec.quant[ci]
            f = np.zeros(64)
            f[_ZIGZAG] = coef * q
            f[0] = level[ci] * q[0]
            by, bx = divmod(seen[ci], c["h"])
            seen[ci] += 1
            planes[ci][8 * by : 8 * by + 8, 8 * bx : 8 * bx + 8] = _IDCT.T @ f.reshape(8, 8) @ _IDCT
        out.append(planes)
    return out


class _Canvas:
    def __init__(self, dec: _Decoder):
        self.dec = dec
        self.owner = np.full(dec.count, -1)
        self.planes = [np.full((dec.rows * 8 * c["v"], dec.cols * 8 * c["h"]), 128.0) for c in dec.comps]

    def put(self, piece: int, first: int, mcus, offsets):
        for k, planes in enumerate(mcus):
            row, col = divmod(first + k, self.dec.cols)
            for ci, plane in enumerate(planes):
                hh, ww = plane.shape
                self.planes[ci][row * hh : row * hh + hh, col * ww : col * ww + ww] = plane + offsets[ci] + 128
            self.owner[first + k] = piece

    def seams(self, first: int, mcus, ci: int):
        """Pixels either side of where a piece placed at `first` meets the picture drawn
        already: (drawn, piece) rows above its first row and the column left of its first
        MCU, for component ci; the piece's pixels without its offset."""
        dec, plane = self.dec, self.planes[ci]
        drawn, piece = [], []
        for k in range(min(len(mcus), dec.cols)):
            idx = first + k
            above = idx - dec.cols
            if above < 0 or self.owner[above] < 0:
                continue
            m = mcus[k][ci]
            hh, ww = m.shape
            row, col = divmod(idx, dec.cols)
            drawn.append(plane[row * hh - 1, col * ww : col * ww + ww])
            piece.append(m[0] + 128)
        if first % dec.cols and self.owner[first - 1] >= 0:
            m = mcus[0][ci]
            hh, ww = m.shape
            row, col = divmod(first, dec.cols)
            drawn.append(plane[row * hh : row * hh + hh, col * ww - 1])
            piece.append(m[:, 0] + 128)
        if not drawn:
            return None, None, 0
        return np.concatenate(drawn), np.concatenate(piece), len(drawn)

    def image(self) -> Image.Image:
        dec = self.dec
        h, w = dec.rows * dec.mcu_h, dec.cols * dec.mcu_w
        full = []
        for ci, plane in enumerate(self.planes):
            if plane.shape != (h, w):
                plane = np.asarray(Image.fromarray(plane.astype(np.float32), mode="F").resize((w, h), Image.BILINEAR))
            full.append(plane)
        y, cb, cr = full
        rgb = np.stack([y + 1.402 * (cr - 128),
                        y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128),
                        y + 1.772 * (cb - 128)], axis=-1)
        rgb = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
        known = np.kron((self.owner >= 0).reshape(dec.rows, dec.cols), np.ones((dec.mcu_h, dec.mcu_w), bool))
        rgb[~known] = 128
        return Image.fromarray(rgb[: dec.size[1], : dec.size[0]])


def _misfit(drawn: np.ndarray, piece: np.ndarray) -> tuple[float, float]:
    """How badly a piece's edge continues the picture beside it once levelled, and the level."""
    d = drawn - piece
    level = float(np.median(d))
    return float(np.mean(np.abs(d - level))), level


# -- the whole -----------------------------------------------------------------


def piece_together(jpeg: bytes, received: np.ndarray, template: bytes | None) -> Pieced | None:
    """The picture with what came down past its gaps placed in it, or None when nothing past
    the first gap can be (or the JPEG isn't the camera's kind).

    `jpeg` is the capture's JPEG with zeros where lines are missing (picam.DecodedPicam.jpeg)
    and `received` a bool per byte of it. `template` is the camera's standard header,
    used where the capture's own didn't all arrive.
    """
    received = np.asarray(received, dtype=bool).copy()
    head_len = len(template) if template else picam.header_length(jpeg)
    if not head_len:
        return None
    jpeg = bytearray(jpeg)
    if template:
        jpeg[:head_len] = template
        received[:head_len] = True
    try:
        dec = _Decoder(bytes(jpeg[:head_len]))
    except (ValueError, KeyError, StopIteration, IndexError):
        return None

    # runs of received bytes in the scan
    scan = received[head_len:]
    edges = np.flatnonzero(np.diff(np.concatenate([[0], scan.astype(np.int8), [0]])))
    runs = [(head_len + a, head_len + b) for a, b in zip(edges[::2], edges[1::2], strict=True)]
    if not runs or runs[0][0] != head_len:
        return None  # the picture's start didn't arrive: nothing to place anything against

    canvas = _Canvas(dec)
    first_data, _ = _unstuff(bytes(jpeg[runs[0][0] : runs[0][1]]))
    first_bits = _Bits(first_data)
    start = _decode_piece(dec, first_bits, _chain_from_start(dec, first_bits))
    if not start:
        return None
    canvas.put(0, 0, start, [0.0] * 3)
    end_mcu, end_byte = len(start), runs[0][1]
    pieces = left_out = 0

    for a, b in runs[1:]:
        data, eoi = _unstuff(bytes(jpeg[a:b]))
        bits = _Bits(data)
        path = _find_step(dec, bits) if len(data) >= 8 else None
        if not path or len(path) < MIN_PIECE:
            left_out += 1
            continue
        mcus = _decode_piece(dec, bits, path)
        if eoi:
            places = [dec.count - len(mcus)]
            if places[0] < end_mcu:
                left_out += 1
                continue
        else:
            # no gap holds more MCUs than its bytes could code, nor fewer than none
            gap = (a + path[0] // 8) - end_byte
            most = end_mcu + gap // MIN_MCU_BYTES + SKIP_MCUS + 1
            places = range(end_mcu, min(most, dec.count - len(mcus)) + 1)
        fits = []
        for f in places:
            drawn, piece, pairs = canvas.seams(f, mcus, 0)
            if pairs >= MIN_PAIRS:
                fits.append((_misfit(drawn, piece)[0], f))
        fits.sort()
        if not fits or (not eoi and len(fits) > 1 and fits[0][0] > CLEAR_FIT * fits[1][0]):
            left_out += 1
            continue
        first = fits[0][1]
        offsets = []
        for ci in range(len(dec.comps)):
            drawn, piece, _ = canvas.seams(first, mcus, ci)
            offsets.append(_misfit(drawn, piece)[1])
        pieces += 1
        canvas.put(pieces, first, mcus, offsets)
        end_mcu, end_byte = first + len(mcus), b

    if not pieces:
        return None
    return Pieced(canvas.image(), float((canvas.owner >= 0).mean()), pieces, left_out)
