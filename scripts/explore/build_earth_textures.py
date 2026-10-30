"""Build the Explore-page Earth textures from the NASA originals.

usage: python -I build_textures.py <earth-src dir> <output dir> [month=200410] [parts=day,lights,clouds,relief]

Inputs (all NASA, public domain):
  world.topo.bathy.<month>.3x21600x10800.jpg  Blue Marble NG, topography + bathymetry
  world.<month>.3x21600x10800.jpg             Blue Marble NG base map (real water colour)
  BlackMarble_2016_3km.jpg                    Black Marble 2016 colour, 13500 x 6750
  cloud_combined_8192.tif                     Blue Marble clouds, 8192 x 4096
  gebco_08_rev_elev_5400x2700.jpg             BMNG topography (GEBCO_08 elevation), 5400 x 2700
"""
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
MONTH = sys.argv[3] if len(sys.argv) > 3 else "200410"
PARTS = set((sys.argv[4] if len(sys.argv) > 4 else "day,lights,clouds,relief").split(","))
OUT.mkdir(parents=True, exist_ok=True)
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def report(path, img):
    log(f"{path.name}: {img.size} {path.stat().st_size / 1e6:.2f} MB")


def save_jpeg(img, name, quality):
    path = OUT / name
    img.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    report(path, img)


def save_webp(img, name, quality):
    path = OUT / name
    img.save(path, "WEBP", quality=quality, method=6)
    report(path, img)


def save_png(img, name):
    path = OUT / name
    img.save(path, "PNG", optimize=True)
    report(path, img)


def build_day_and_water():
    log(f"Blue Marble NG {MONTH}")
    tb_img = Image.open(SRC / f"world.topo.bathy.{MONTH}.3x21600x10800.jpg").convert("RGB")
    base_img = Image.open(SRC / f"world.{MONTH}.3x21600x10800.jpg").convert("RGB")
    W, H = tb_img.size
    assert base_img.size == (W, H)

    FILL = np.array([2, 5, 20], np.float32)  # BMNG's open-ocean fill colour
    BATHY_KEEP = 0.2  # how much of the synthetic bathymetry shading survives

    day_full = np.empty((H, W, 3), np.uint8)
    water_full = np.empty((H, W), np.uint8)
    STRIP = 540
    for y0 in range(0, H, STRIP):
        y1 = min(H, y0 + STRIP)
        tb = np.asarray(tb_img.crop((0, y0, W, y1))).astype(np.float32)
        base = np.asarray(base_img.crop((0, y0, W, y1))).astype(np.float32)
        # Water, from how the two BMNG versions differ. In topo.bathy the sea is
        # replaced by GEBCO bathymetry shading (much bluer than the base map),
        # open ocean in the base map is a flat fill colour, lakes without
        # bathymetry are near-black, and clear shallow water is turquoise.
        ocean_fill = np.max(np.abs(base - FILL), axis=-1) <= 3
        blue_gain = ((tb[..., 2] - base[..., 2]) > 12) & ((tb[..., 2] - tb[..., 0]) > 20)
        dark = (base.max(-1) < 14) & (base[..., 2] >= base[..., 0])
        turq = ((base[..., 2] - base[..., 0]) > 18) & ((base[..., 1] - base[..., 0]) > 10) & (base.max(-1) < 200)
        water = ocean_fill | blue_gain | dark | turq
        water_full[y0:y1] = water * 255

        # Sea colour: the base map's own water colour where MODIS saw something
        # (shallow banks, sediment plumes), otherwise the dark open-ocean colour
        # with a trace of the bathymetry, so shelves don't glow map-blue.
        synth = FILL * (1 - BATHY_KEEP) + tb * BATHY_KEEP
        real = smoothstep(14.0, 40.0, base.max(-1))[..., None]
        sea = synth * (1 - real) + base * real
        out = np.where(water[..., None], sea, tb)
        day_full[y0:y1] = np.clip(out + 0.5, 0, 255).astype(np.uint8)
    log("classified + composited")
    del tb_img, base_img

    day = Image.fromarray(day_full)
    del day_full
    for size in (8192, 4096, 2048, 1024):
        im = day.resize((size, size // 2), Image.LANCZOS, reducing_gap=3.0)
        save_webp(im, f"earth-day-{size}.webp", 84 if size > 1024 else 80)
    del day

    # Water mask: close small holes and drop specks, then area-average down
    # so coastlines are anti-aliased.
    water = Image.fromarray(water_full)
    del water_full
    water = water.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    water = water.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    log("mask cleaned")
    for size in (8192, 4096, 2048):
        save_png(water.resize((size, size // 2), Image.BOX), f"earth-water-{size}.png")


def build_lights():
    log("Black Marble 2016")
    night = np.asarray(Image.open(SRC / "BlackMarble_2016_3km.jpg").convert("RGB")).astype(np.float32)
    # City light is warm to white; the moonlit-land backdrop of the colour
    # composite is blue-violet. R + G - B keeps the first and drops the second.
    m = night[..., 0] + night[..., 1] - night[..., 2]
    lights = np.clip((m - 12.0) * (255.0 / 243.0), 0, 255)
    img = Image.fromarray((lights + 0.5).astype(np.uint8))
    for size in (8192, 4096, 2048, 1024):
        save_jpeg(img.resize((size, size // 2), Image.LANCZOS), f"earth-lights-{size}.jpg", 85 if size > 1024 else 82)


def build_clouds():
    log("clouds")
    clouds = np.asarray(Image.open(SRC / "cloud_combined_8192.tif").convert("L")).astype(np.float32).copy()
    # The composite does not wrap at the antimeridian (different passes meet
    # there). Pull both edges to a common value and spread the correction over
    # a band either side, so the seam doesn't show as a straight line.
    B = 96
    delta = clouds[:, 0] - clouds[:, -1]
    delta = np.convolve(np.pad(delta, 2, mode="edge"), np.ones(5, np.float32) / 5, mode="valid")
    for d in range(B):
        t = d / B
        w = 0.5 * (1.0 - t * t * (3.0 - 2.0 * t))
        clouds[:, d] -= delta * w
        clouds[:, -1 - d] += delta * w
    # The ground shows through faintly (grey 20-40); cut it.
    c = np.clip((clouds - 32.0) * (255.0 / 223.0), 0, 255)
    img = Image.fromarray((c + 0.5).astype(np.uint8))
    for size in (8192, 4096, 2048, 1024):
        im = img if size == 8192 else img.resize((size, size // 2), Image.LANCZOS)
        save_jpeg(im, f"earth-clouds-{size}.jpg", 82)


def build_relief():
    log("relief")
    elev = Image.open(SRC / "gebco_08_rev_elev_5400x2700.jpg").convert("L")
    save_jpeg(elev.resize((4096, 2048), Image.LANCZOS), "earth-relief-4096.jpg", 88)


if "day" in PARTS:
    build_day_and_water()
if "lights" in PARTS:
    build_lights()
if "clouds" in PARTS:
    build_clouds()
if "relief" in PARTS:
    build_relief()
log("done")
