"""Build the Explore-page sky data from the originals.

usage: python -I scripts/build_sky.py <sky-src dir> site/explore/sky

  ybsc5.gz           Yale Bright Star Catalogue, 5th revised ed. (ASCII, CDS V/50 format)
  lroc_color_2k.jpg  NASA SVS CGI Moon Kit colour map (2048 x 1024)

stars.bin: little-endian records of 8 bytes, brightest first:
  int16 x, y, z   unit vector * 32767, J2000 equator and equinox, positions
                  moved by proper motion to epoch 2026.0
  uint8 mag       round((V + 2) * 20)
  uint8 bv        round((B-V + 0.5) * 100), 255 = unknown
"""
import gzip
import math
import struct
import sys
from pathlib import Path

from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
MAG_LIMIT = 6.0
EPOCH = 2026.0


def field(line, a, b):
    """Bytes a..b (1-based, inclusive) as a stripped string."""
    return line[a - 1:b].strip()


stars = []
with gzip.open(SRC / "ybsc5.gz", "rt", encoding="latin-1") as f:
    for line in f:
        line = line.rstrip("\n").ljust(197)
        if not field(line, 76, 77) or not field(line, 103, 107):
            continue  # removed objects (novae, galaxies) have no position or V
        hr = int(field(line, 1, 4))
        v = float(field(line, 103, 107))
        if v > MAG_LIMIT:
            continue
        ra = (int(field(line, 76, 77)) + int(field(line, 78, 79)) / 60 + float(field(line, 80, 83)) / 3600) * 15
        dec = int(field(line, 85, 86)) + int(field(line, 87, 88)) / 60 + int(field(line, 89, 90)) / 3600
        if field(line, 84, 84) == "-":
            dec = -dec
        pm_ra = float(field(line, 149, 154) or 0)  # arcsec/yr, already * cos(dec)
        pm_de = float(field(line, 155, 160) or 0)
        bv_s = field(line, 110, 114)
        bv = float(bv_s) if bv_s else None
        name = field(line, 5, 14)
        dt = EPOCH - 2000.0
        dec_e = dec + pm_de * dt / 3600
        ra_e = ra + pm_ra * dt / 3600 / max(math.cos(math.radians(dec)), 1e-6)
        stars.append((v, hr, name, ra_e, dec_e, bv))

stars.sort(key=lambda s: s[0])
buf = bytearray()
for v, hr, name, ra, dec, bv in stars:
    a, d = math.radians(ra), math.radians(dec)
    x, y, z = math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)
    q = lambda c: max(-32767, min(32767, round(c * 32767)))
    m = max(0, min(255, round((v + 2) * 20)))
    b = 255 if bv is None else max(0, min(254, round((bv + 0.5) * 100)))
    buf += struct.pack("<hhhBB", q(x), q(y), q(z), m, b)
(OUT / "stars.bin").write_bytes(buf)
print(f"stars.bin: {len(stars)} stars to V {MAG_LIMIT}, {len(buf)} bytes,"
      f" gzip {len(gzip.compress(bytes(buf), 9))} bytes")
for limit in (4.0, 5.0, 5.5, 6.0):
    print(f"  V <= {limit}: {sum(1 for s in stars if s[0] <= limit)}")
print("brightest:", [(s[2] or f"HR {s[1]}", s[0]) for s in stars[:8]])

moon = Image.open(SRC / "lroc_color_2k.jpg").convert("RGB")
for w in (2048, 1024):
    im = moon if moon.width == w else moon.resize((w, w // 2), Image.LANCZOS)
    p = OUT / f"moon-{w}.jpg"
    im.save(p, "JPEG", quality=85, optimize=True, progressive=True)
    print(f"{p.name}: {im.size} {p.stat().st_size} bytes")
