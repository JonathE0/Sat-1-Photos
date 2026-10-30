# The main camera, fitted to its pictures

What the Orbit page's "Preview picture" assumes about the picam, and how far to trust it. The values
live in [`site/globe/shotcamera.js`](../site/globe/shotcamera.js) and
[`site/globe/shotpreview.js`](../site/globe/shotpreview.js). `python scripts/fit_picam.py` reproduces
the lens and pointing numbers.

## The result

| What | Value | How sure |
| --- | --- | --- |
| Focal length | 680 px | 640 to 693 px across the methods below |
| Field of view | 60.9° diagonal, 50.4° by 38.9° | about ±2° |
| Ground covered, straight down from 500 km | about 475 by 355 km, 0.74 km a pixel | follows from the above |
| Rotation | The right of the picture is the direction of travel | within 1° on both fitted frames |
| Mirror flip | None | a mirrored frame fits 6 to 9 times worse (about 80 px against 9 to 12 px) |
| Pointing assumed | Straight down | **Varies, see below** |

The preview's caveat says the pointing varies by up to 12° in October and 62° in August.

## What the team says

From the public [CTS-SAT-1 wiki](https://github.com/CalgaryToSpace/CTS-SAT-1-Wiki/wiki/Camera): a
SkyFox piCAM Flight Model, 640 × 480 JPEG, fixed focus, with a 60° diagonal field of view. They work
out 710 ± 20 m a pixel from 500 km. The fit below agrees to within a few percent.

The wiki doesn't say which face the camera is on or where it points. It names a "Boom/Nadir face" and
says the camera's main job is to watch the boom deploy. That fits the thin line in the lower left of
nearly every sunlit frame, drawn in the preview from the frames of 27 Aug, 6 Oct and 24 Oct.

## The fits

**Lens, from the limb.** From orbit the Earth's edge is a small circle on the sky, about 68° from
nadir. Three frames with a horizon give the focal length and their tilt, with no map involved. It
assumes 500 km up and a visible edge 25 km above the ground, which moves the focal length by about
20 px per 25 km.

| Frame | Focal length | Diagonal | Off nadir | Residual |
| --- | --- | --- | --- | --- |
| 6 Aug | 678 px | 61.1° | 62° | 0.28 px |
| 26 Aug | 640 px | 64.0° | 60° | 0.29 px |
| 28 Aug | 648 px | 63.4° | 57° | 0.32 px |

**Pointing, from places on the ground.** Tie points read by eye between the frames and the NASA maps,
with the satellite's position from SGP4 at `captured_at`. Pitch is forward along the track, roll is to
the right of it, and yaw turns the picture clockwise.

| Frame | Tie points | Free focal length | Pitch | Roll | Yaw | Off nadir | Residual |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 22 Oct 15:07, New Jersey shore (truncated) | 4 | 686 px | +10.5° | −5.0° | +1.0° | 11.6° | 9.1 px |
| 22 Oct 15:44, Singapore at night (verified) | 6 | 673 px | +1.0° | −0.6° | −0.9° | 1.1° | 12.4 px |

The New Jersey frame is cut short on board and isn't "verified", but it is the only clear daylight coast
with a known time. Its upper rows came down whole, and only those were used.

**Checked by eye, not fitted:**

- 24 Oct 17:37, Alberta (verified): straight down with the same rotation puts the Rockies along the top
  of the frame, where the real picture has them. Too much cloud for a numeric fit: the best score was
  only 0.10.

**Tried, no usable fit:**

- 4 Sep, Ukraine at night (verified): straight down would put Kyiv in frame, and the real picture
  doesn't have it, so this frame pointed elsewhere. Its lights are too sparse to say where (best score
  0.32, with no clear winner).
- 27 Aug (verified), 25 Oct and 30 Oct (cut short): open sea and cloud, with nothing to tie to.

## What this means

- **In October the camera looks close to straight down**, and the rotation holds to about 1° on both
  an ascending and a descending pass. So the satellite seems to hold its attitude relative to its path,
  not to north. North's position in the picture therefore changes with the direction of travel.
- **The pointing still moves.** The two October frames are 36 minutes apart and differ by about 11°.
  A timing error is an unlikely cause: the 9.5° of it along the track would take about 12 s, both
  frames have nearly the same clock correction, and the 4° across the track can't come from timing at
  all.
- **In August it was far off nadir**, 57° to 62°, with the horizon in view. Anything planned from this
  preview assumes the October behaviour continues. Only two frames back it up, so the assumed pointing
  is not a measured average: it is plain straight-down, and the caveat gives the spread.

At 500 km, 12° is about 110 km on the ground, or roughly 150 px in the frame. A place near the edge
of the preview could fall outside the real picture.

## Colour

Gains and veil fitted to four colours from real frames: land and sea from New Jersey, sea and cloud
from 27 Aug. The camera exposes for the bright end of the scene, so the brightest 5% of the frame set the
gain, capped at the 6.2 seen on the New Jersey frame. Saturation is then set by hand to 0.7: a fit that
also took in Alberta's ground wanted 0.12, which turned land and sea the same pale blue and lost the
coast. The result is within about 16 levels out of 255 on those four, but about 25 off on Alberta's
ground, which comes out browner and less blue than the real frame.

This is a look, not a measurement: a few colours can't pin down a camera's response. Night is left alone,
because the city lights in `earth.js` already match the night frames. Real exposures vary more than
this, and the 6 Oct frame's pink desert is one this model wouldn't reproduce.

## What isn't simulated

- **Clouds.** They can't be forecast, so the default is a clear sky. The other view uses one sample day
  of NASA's cloud map and is labelled so.
- **Sun glare.** About six of the real frames are washed out by it, and the preview doesn't predict that.
- **Ground detail.** The maps are about 5 km a texel at best (10 km at the usual 4096 size) against the
  camera's 0.74 km a pixel, so the preview is softer than a real frame.
- **The Earth's shape.** It is a sphere here, with the camera over the right geodetic point, so the
  centre of the picture is right. Anything else is good to a few kilometres.
- **Position error.** Passes far past the newest orbital elements can be tens of kilometres out, and
  the panel says so when they are.
