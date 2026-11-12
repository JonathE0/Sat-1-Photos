"""Main-camera pictures read on past their gaps.

The camera's JPEGs are baseline and have no restart markers, so a decoder that meets a gap
can't find its place again: picam.displayable() shows a picture down to its first missing
line. `piece_together` reads on past each gap, for build.py.

Every line of a capture names itself, so where each received byte sits in the JPEG is
known. What a gap loses is the decoder's place in the bit stream, the place in the
picture the blocks after it belong, and their level. For each piece after a gap:

1. The step. The picture is a stream of variable-length codes, MCU after MCU (16x16
   pixels: four Y blocks, Cb, Cr), with nothing marking where one starts. Decoding is
   tried from every bit of the piece's first SEARCH_BYTES bytes. A wrong start soon meets
   a code that can't occur, or falls into step with the real stream (such codes
   resynchronise), so the tries end on one chain of MCUs; `_find_step` says from which
   MCU that chain is surely the picture's, and `_grow_back` adds the MCUs before it that
   join up with it.
2. The place. A piece that runs to the end of the picture is placed by counting its MCUs
   back from the end. A long piece shows its own row breaks, where neighbouring MCUs
   don't join up: they give the column it starts in, and the bytes of its gap give the
   row, since a gap weighs about what the MCUs above and below it do. A short piece is
   placed by its seam, how well its top and left edges continue what is drawn already,
   and only where the gap is short enough that every place it could be can be tried.
3. The level. Each block's average (its DC) is coded as a change from the block before, so
   after a gap the level is lost: one unknown each for Y, Cb and Cr, the same over the
   whole piece. It's set so the piece meets the picture above it smoothly.

Nothing is drawn on a guess. A piece that touches nothing drawn already can't be levelled
and isn't shown, nor one whose clues don't single out a place (on a flat or dark frame
every place fits), nor anything past a gap unless the picture's own start arrived. The
thresholds below were set on the camera's whole captures with lines knocked out, so that
no MCU was drawn out of place in some 200,000 placed; they leave pieces out rather than
risk one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image

from . import picam

# The step
SEARCH_BYTES = 160  # where after a gap the step is looked for
STEP_WINDOW = 384  # bits at a piece's start sure to hold a real MCU boundary (99% of MCUs are under 300)
MIN_TRIES = 32  # tries that must end on a chain for it to be considered
GROW_BACK = 48  # MCUs before the sure ones looked at for more that join up
JOIN_FLOOR, JOIN_MAX = 4.0, 12.0  # levels: an MCU joins its neighbour within twice the neighbour's own detail, between these
MIN_PIECE = 4  # MCUs a piece needs to be worth placing
# The place
MIN_MCU_BYTES = 3  # no MCU codes in fewer: bounds how many a gap can hold
GAP_LOW, GAP_HIGH = 0.45, 2.2  # a gap weighs within these times what the MCUs around it say it should,
SMALL_GAP, SMALL_GAP_HIGH = 12, 4.5  # or up to this many times for a gap of only a few MCUs
ROW_BREAK = 4.0  # levels a piece's joins must jump by where its rows break,
NEXT_BREAK = 0.5  # with no other column's joins within this share of that
ROW_NEAR, ROW_CLEAR = 1.4, 1.9  # its row: the gap within this factor of what's expected there, and beyond that for every other row
MIN_PAIRS = 4  # MCUs of a piece that must touch the picture drawn already
CLEAR_FIT = 0.7  # by the seam: the chosen place's misfit at most this times any other's,
TEXTURE = 1.5  # which must misfit by this many levels (on a flat seam every place fits)
# The level: a piece takes its brightness from its seam if the seam misfits by no more than
# this many levels times the square root of the MCUs touching. A long seam averages a busy
# picture out; one a few MCUs long can sit on a single cloud's edge and be far off.
LONG_SEAM = 6  # MCUs touching from which a seam counts as long
SEAM_ROUGH, SHORT_SEAM_ROUGH = 2.5, 1.5

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


def _find_step(dec: _Decoder, bits: _Bits) -> list[tuple[list[int], int, bool]]:
    """The ways a piece past a gap may be read: (MCU start bits, the MCU it is in step from,
    whether that is sure). One sure reading, or the unsure ones, or none.

    Decoding is tried from every bit of the piece's first SEARCH_BYTES bytes. Tries that
    survive to the end of the piece mostly end on one chain of MCUs; that chain is the
    picture's from some MCU on, but its first MCUs may be a wrong start still falling into
    step (the many tries begun inside the MCU the gap cut through can agree with each
    other before they agree with the picture). A try begun on a real MCU boundary never
    leaves the real stream, and one lies within any stretch of bits longer than an MCU. So
    a chain is the real stream from the MCU by which every surviving try begun in the
    piece's first STEP_WINDOW bits has joined it: that reading is sure.

    A short piece can end before its tries agree. Then each chain enough tries end on is
    an unsure reading, in step (if it is the real one) from where its own first tries have
    joined; `piece_together` keeps one only if the picture itself confirms it.
    """
    starts = range(min(bits.n, SEARCH_BYTES * 8))
    nxt: dict[int, int] = {}
    fate: dict[int, str] = {}
    for b in starts:
        p = b
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
            p = q

    end_of: dict[int, int] = {}

    def last(p):
        walked = []
        while p in nxt and p not in end_of:
            walked.append(p)
            p = nxt[p]
        e = end_of.get(p, p)
        for x in walked:
            end_of[x] = e
        return e

    ends: dict[int, list[int]] = {}
    survivors = []
    for b in starts:
        e = last(b)
        if fate.get(e) == "end":
            ends.setdefault(e, []).append(b)
            survivors.append(b)
    groups = sorted((g for g in ends.values() if len(g) >= MIN_TRIES), key=len, reverse=True)
    if not groups:
        return []

    def chain_from(p):
        chain = []
        while p in nxt:
            chain.append(p)
            p = nxt[p]
        return chain

    def joined_by(chain, tries, window):
        """The MCU of the chain by which each of `tries` begun in the first `window` bits has joined it."""
        at = {p: i for i, p in enumerate(chain)}
        latest = 0
        for b in tries:
            if b >= window:
                break
            p = b
            while p not in at and p in nxt:
                p = nxt[p]
            latest = max(latest, at.get(p, len(chain)))  # never joins: no MCU of the chain is sure
        return latest

    def in_step_from(chain, tries):
        i = joined_by(chain, tries, STEP_WINDOW)
        # the window must be longer than the MCUs hereabouts, or it might hold no real boundary
        sizes = np.diff(chain[i : i + 34])
        if len(sizes) and 3 * int(sizes.max()) > 2 * STEP_WINDOW:
            i = joined_by(chain, tries, 3 * int(sizes.max()) // 2)
        return i

    chain = chain_from(groups[0][0])
    i = in_step_from(chain, survivors)
    if i < len(chain):
        return [(chain, i, True)]
    readings = []
    for g in groups:
        chain = chain_from(g[0])
        i = in_step_from(chain, g)
        if i < len(chain):
            readings.append((chain, i, False))
    return readings


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
        self.bits = np.zeros(dec.count)  # how many bits each drawn MCU took
        self.planes = [np.full((dec.rows * 8 * c["v"], dec.cols * 8 * c["h"]), 128.0) for c in dec.comps]

    def put(self, piece: int, first: int, mcus, offsets, sizes):
        self.bits[first : first + len(mcus)] = sizes
        for k, planes in enumerate(mcus):
            row, col = divmod(first + k, self.dec.cols)
            for ci, plane in enumerate(planes):
                hh, ww = plane.shape
                self.planes[ci][row * hh : row * hh + hh, col * ww : col * ww + ww] = plane + offsets[ci] + 128
            self.owner[first + k] = piece

    def seams(self, first: int, mcus, ci: int):
        """Pixels either side of where a piece placed at `first` meets the picture drawn
        already, for component ci: (expected, piece, MCUs touching). `piece` is its top row
        under each drawn MCU above its first row, and its first MCU's left column beside a
        drawn MCU, without its offset. `expected` is what the drawn picture leads one to
        expect there: its own edge pixel, carried on by the mean of the step it was making
        and the step the piece makes next (a slope across the seam is no misfit)."""
        dec, plane = self.dec, self.planes[ci]
        expected, piece = [], []
        for k in range(min(len(mcus), dec.cols)):
            idx = first + k
            above = idx - dec.cols
            if above < 0 or self.owner[above] < 0:
                continue
            m = mcus[k][ci]
            hh, ww = m.shape
            row, col = divmod(idx, dec.cols)
            at = slice(col * ww, col * ww + ww)
            edge, before = plane[row * hh - 1, at], plane[row * hh - 2, at]
            expected.append(edge + ((edge - before) + (m[1] - m[0])) / 2)
            piece.append(m[0] + 128)
        if first % dec.cols and self.owner[first - 1] >= 0:
            m = mcus[0][ci]
            hh, ww = m.shape
            row, col = divmod(first, dec.cols)
            at = slice(row * hh, row * hh + hh)
            edge, before = plane[at, col * ww - 1], plane[at, col * ww - 2]
            expected.append(edge + ((edge - before) + (m[:, 1] - m[:, 0])) / 2)
            piece.append(m[:, 0] + 128)
        if not expected:
            return None, None, 0
        return np.concatenate(expected), np.concatenate(piece), len(expected)

    def gap_bytes(self, start: int, first: int, sizes: np.ndarray, usual: float) -> float:
        """The bytes MCUs `start` up to `first` would take if a piece of MCU `sizes` (bits)
        begins at `first`: each as the MCUs right above and below it do (a picture is about
        as busy from one row to the next), or `usual` bits where neither is known."""
        cols = self.dec.cols
        g = np.arange(start, first)
        up = g - cols
        up_known = (up >= 0) & (self.owner[np.maximum(up, 0)] >= 0)
        down = g + cols - first
        down_known = (down >= 0) & (down < len(sizes))
        above = self.bits[np.maximum(up, 0)]
        below = sizes[np.clip(down, 0, len(sizes) - 1)]
        both = up_known & down_known
        bits = np.where(both, (above + below) / 2, np.where(up_known, above, np.where(down_known, below, usual)))
        return float(bits.sum()) / 8

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


def _start_column(dec: _Decoder, mcus) -> int | None:
    """The column a piece's first MCU sits in, from where its rows break, or None when that
    doesn't show: a short piece, or one whose row ends join up as well as its insides."""
    n, cols = len(mcus), dec.cols
    if n < 2 * cols + 1:  # two row breaks at least, whichever column it starts in
        return None
    # How badly each MCU joins the next (Y): its right column against the next one's left,
    # beyond the step between neighbouring columns just inside the two. A coastline or a
    # cloud's edge steps as much inside a block as across a join; a row break doesn't.
    jump = np.empty(n - 1)
    for k in range(n - 1):
        left, right = mcus[k][0], mcus[k + 1][0]
        across = np.mean(np.abs(left[:, -1] - right[:, 0]))
        inside = max(np.mean(np.abs(left[:, -1] - left[:, -2])), np.mean(np.abs(right[:, 0] - right[:, 1])))
        jump[k] = across - inside
    at = np.arange(n - 1)
    breaks = np.array([np.median(jump[(at + c) % cols == cols - 1]) for c in range(cols)])
    column = int(np.argmax(breaks))
    if breaks[column] < ROW_BREAK or float(np.delete(breaks, column).max()) > NEXT_BREAK * breaks[column]:
        return None
    return column


def _joins(edge: np.ndarray, sure_edge: np.ndarray, sure_inside: np.ndarray) -> bool:
    """Whether a block's edge continues a sure block's: within twice the step the sure block
    itself makes one pixel in (a wrongly read block is noise at some other level)."""
    across = float(np.mean(np.abs(edge - sure_edge)))
    inside = float(np.mean(np.abs(sure_edge - sure_inside)))
    return across <= min(JOIN_MAX, max(JOIN_FLOOR, 2 * inside))


def _whole(dec: _Decoder, mcu) -> bool:
    """Whether an MCU's own 8x8 blocks join each other (Y): a wrong start often reads only
    the first of them wrongly, and the rest in step."""
    y = mcu[0]
    for k in range(8, y.shape[1], 8):  # each join between blocks side by side
        if not (_joins(y[:, k - 1], y[:, k], y[:, k + 1]) and _joins(y[:, k], y[:, k - 1], y[:, k - 2])):
            return False
    for k in range(8, y.shape[0], 8):  # and one above the other
        if not (_joins(y[k - 1], y[k], y[k + 1]) and _joins(y[k], y[k - 1], y[k - 2])):
            return False
    return True


def _grow_back(dec: _Decoder, mcus: list, sure: int) -> int:
    """The first MCU of `mcus` to keep. Those from `sure` on are in step; the ones before
    are either the picture's too (the step had been found, just not yet proven) or a wrong
    start, which is noise at least in part. Going back one at a time, an MCU is kept while
    its blocks join each other, and it joins the MCU to its right (unless a row break lies
    between them) and the one a row below, in brightness and colour, as far as those are
    there to check."""
    cols = dec.cols
    column = _start_column(dec, mcus[sure:])
    first = sure
    while first > 0:
        k = first - 1
        if not _whole(dec, mcus[k]):
            break
        checked = False
        ends_row = column is not None and (column - (sure - k)) % cols == cols - 1
        if not ends_row:
            if not all(_joins(mcus[k][ci][:, -1], mcus[k + 1][ci][:, 0], mcus[k + 1][ci][:, 1]) for ci in range(3)):
                break
            checked = True
        if k + cols < len(mcus):
            if not all(_joins(mcus[k][ci][-1], mcus[k + cols][ci][0], mcus[k + cols][ci][1]) for ci in range(3)):
                break
            checked = True
        if not checked:
            break
        first = k
    # The last MCU of a wrong start ends where a real one does, and can hold real blocks after
    # a wrong first one that happens to be smooth: nothing shows it. So the earliest MCU grown
    # to is left out.
    return min(first + 1, sure)


def _place(dec: _Decoder, canvas: _Canvas, mcus, places, exact: bool, weigh: dict | None = None,
           seen: dict | None = None) -> tuple[int | None, str]:
    """The MCU a piece starts at, or None, and how that was decided. `places` are the starts
    its gap's bytes allow; `exact` when there's one, counted back from the picture's end.
    `weigh` gives, for every start the gap could have at all, its bytes over the bytes
    expected of it there."""
    misfit, loose, touching = {}, {}, {}  # by place: where enough of the piece touches the picture, and where any does
    for f in places:
        drawn, piece, pairs = canvas.seams(f, mcus, 0)
        touching[f] = pairs
        if pairs:
            loose[f] = _misfit(drawn, piece)[0]
        if pairs >= MIN_PAIRS:
            misfit[f] = loose[f]
    column = _start_column(dec, mcus)
    if seen is not None:
        seen.update(misfit=dict(misfit), column=column, places=list(places), touching=touching)
    # too rough a seam for its length says little about the piece's brightness (and a wrong
    # reading fits nowhere)
    misfit = {f: m for f, m in misfit.items()
              if m <= (SEAM_ROUGH if touching[f] >= LONG_SEAM else SHORT_SEAM_ROUGH) * math.sqrt(touching[f])}
    if exact:
        f = places[0]
        if f not in misfit:
            return None, "the end of the picture, but it touches nothing drawn to take its brightness from"
        if column is not None and f % dec.cols != column:
            return None, "the end of the picture, but its row breaks disagree"
        return f, "counted back from the end"
    if not misfit:
        return None, "nowhere does it meet the picture drawn closely enough to take its brightness from"

    if column is not None:
        # Its row breaks give the column; the row is the one that makes its gap weigh what the
        # MCUs around the gap say it should. A seam can't choose between rows: only the first
        # of them touches anything drawn, and a piece fits one row too high nearly as well as
        # where it belongs.
        off = {f: abs(math.log(w)) for f, w in (weigh or {}).items() if f % dec.cols == column and w > 0}
        if not off:
            return None, "its row breaks give a column its gap has no room for"
        best = min(off, key=off.get)
        if off[best] > math.log(ROW_NEAR) or any(v < math.log(ROW_CLEAR) for f, v in off.items() if f != best):
            return None, "its row breaks give a column, but the gap's bytes don't single out a row"
        if best not in misfit:
            return None, "its row breaks and its gap give a place, but there it touches nothing drawn to take its brightness from"
        return best, "its row breaks and the bytes of its gap"
    # By the seam alone. The place it belongs must be among those tried: one the gap allows
    # where it would touch nothing could be it, with another fitting well by chance.
    if any(f not in loose for f in places):
        return None, "the gap could reach past where it would touch anything drawn"
    best = min(misfit, key=misfit.get)
    others = [m for f, m in loose.items() if f != best]
    if not others:
        return best, "the one place its gap allows"
    if min(others) >= TEXTURE and misfit[best] <= CLEAR_FIT * min(others):
        return best, "its seam"
    return None, "no place fits clearly better than the rest"


# -- the whole -----------------------------------------------------------------


def piece_together(jpeg: bytes, received: np.ndarray, template: bytes | None, trace: list | None = None) -> Pieced | None:
    """The picture with what came down past its gaps placed in it, or None when nothing past
    the first gap can be (or the JPEG isn't the camera's kind).

    `jpeg` is the capture's JPEG with zeros where lines are missing (picam.DecodedPicam.jpeg)
    and `received` a bool per byte of it. `template` is the camera's standard header,
    used where the capture's own didn't all arrive. `trace`, if given, gets one entry per
    run of bytes past the first gap: where it starts, the bits its MCUs start at, the MCU
    it was placed at (None if left out), why, and whether its step was sure.
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
    start_path = _chain_from_start(dec, first_bits)
    start = _decode_piece(dec, first_bits, start_path)
    if not start:
        return None
    start_end = dec.mcu(first_bits, start_path[-1])[0]
    canvas.put(0, 0, start, [0.0] * 3, np.diff(start_path + [start_end]))
    # where the drawn picture ends: its next MCU, and the byte that MCU began at
    end_mcu, end_byte = len(start), runs[0][1] - (first_bits.n - start_end) / 8
    pieces = left_out = 0

    def note(a, path, first, why, sure=True, seen=None):
        if trace is not None:
            trace.append({"byte": a, "bits": list(path), "mcus": len(path), "first": first, "why": why, "sure": sure,
                          **(seen or {})})

    for a, b in runs[1:]:
        data, eoi = _unstuff(bytes(jpeg[a:b]))
        bits = _Bits(data)
        placed, tried = [], []
        why = "too short to find its step"
        for chain, i, sure in _find_step(dec, bits) if len(data) >= 8 else []:
            if sure:
                back = max(0, i - GROW_BACK)
                mcus = _decode_piece(dec, bits, chain[back:])
                keep = _grow_back(dec, mcus, i - back)
                mcus, path = mcus[keep:], chain[back + keep :]
            else:
                path = chain[i:]
                mcus = _decode_piece(dec, bits, path)
            if len(path) < MIN_PIECE:
                why = "too few blocks"
                continue
            # a piece that ends the picture ends on its last bits; then its place is counted back from there
            path_end = dec.mcu(bits, path[-1])[0]
            sizes = np.diff(path + [path_end])
            last = eoi and bits.n - path_end < 8
            if eoi and not last:
                why = "it reaches the end of the picture out of step"
                continue
            gap_seen, weigh = {}, None
            if last:
                places = [dec.count - len(mcus)]
            else:
                # The gap's bytes say how many MCUs it holds: none codes in under MIN_MCU_BYTES, and
                # together they weigh about what the MCUs above and below them do.
                gap = (a + path[0] / 8) - end_byte
                most = min(end_mcu + int(gap // MIN_MCU_BYTES) + 1, dec.count - len(mcus))
                usual = float(sizes[: dec.cols].mean())
                expected = {f: canvas.gap_bytes(end_mcu, f, sizes, usual) for f in range(end_mcu + 1, most + 1)}
                weigh = {f: gap / e for f, e in expected.items() if e > 0}
                places = [f for f, w in weigh.items()
                          if GAP_LOW <= w <= (GAP_HIGH if f - end_mcu >= SMALL_GAP else SMALL_GAP_HIGH)]
                gap_seen = {"gap": gap, "expected": expected}
            seen = {"end_mcu": end_mcu, **gap_seen} if trace is not None else None
            if last and places[0] < end_mcu:
                first, why = None, "more blocks than the rest of the picture has room for"
            else:
                first, why = _place(dec, canvas, mcus, places, last, weigh, seen)
            if first is not None:
                placed.append((first, mcus, path, why, sure, seen, sizes, (bits.n - path_end) / 8))
            elif trace is not None:
                tried.append((min(seen.get("misfit", {}).values(), default=1e9), path, why, sure, seen))
        if len(placed) != 1:
            left_out += 1
            if placed:
                note(a, [], None, "more than one reading of it fits")
            elif tried:  # the reading that came closest
                _, path, why, sure, seen = min(tried, key=lambda t: t[0])
                note(a, path, None, why, sure, seen)
            else:
                note(a, [], None, why)
            continue
        first, mcus, path, why, sure, seen, sizes, tail = placed[0]
        note(a, path, first, why, sure, seen)
        offsets = []
        for ci in range(len(dec.comps)):
            drawn, piece, _ = canvas.seams(first, mcus, ci)
            offsets.append(_misfit(drawn, piece)[1])
        pieces += 1
        canvas.put(pieces, first, mcus, offsets, sizes)
        end_mcu, end_byte = first + len(mcus), b - tail

    if not pieces:
        return None
    return Pieced(canvas.image(), float((canvas.owner >= 0).mean()), pieces, left_out)
