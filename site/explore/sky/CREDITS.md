# Sky data (Explore page)

`scripts/build_sky.py` made `stars.bin` and the Moon maps:
`python -I scripts/build_sky.py <folder of originals> site/explore/sky`.

| File | Made from | What was done |
|---|---|---|
| `stars.bin` (40,640 bytes) | Yale Bright Star Catalogue, 5th Revised Ed. | The 5,080 stars to V 6.0, brightest first. J2000 positions, moved by each star's proper motion to epoch 2026.0, as unit vectors (3 × int16), plus V (uint8, (V+2)×20) and B−V (uint8, (B−V+0.5)×100, 255 = unknown). sky.js precesses them to the date. |
| `moon-2048.jpg`, `moon-1024.jpg` | NASA SVS CGI Moon Kit, LROC colour map (2048 × 1024) | Re-encoded (JPEG 85); the 1024 one resized with Lanczos. |
| `moon.js` | Paul Schlyter, "How to compute planetary positions" | The Moon's position (an algorithm, not data): mean elements plus the largest solar perturbations. |

## Sources

1. **The Bright Star Catalogue, 5th Revised Ed. (Preliminary Version)**: Hoffleit, D. and
   Warren, W. H. Jr. (1991), Astronomical Data Center, NSSDC/ADC (CDS catalogue V/50).
   ASCII distribution from the Smithsonian Astrophysical Observatory's Telescope Data Center:
   http://tdc-www.harvard.edu/catalogs/ybsc5.gz (format: http://tdc-www.harvard.edu/catalogs/ybsc5.readme;
   page: http://tdc-www.harvard.edu/catalogs/bsc5.html). Also at
   https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50.
   Licence: the distributors attach no licence terms. It is a NASA Astronomical Data Center
   compilation, freely redistributed for decades. Cite Hoffleit & Warren (1991).
2. **CGI Moon Kit** (NASA Scientific Visualization Studio, ID 4720), colour map `lroc_color_2k.jpg`
   (2025 version), https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg,
   page https://svs.gsfc.nasa.gov/4720. Visualizer Ernie Wright (USRA), scientist Noah Petro
   (NASA/GSFC); adapted from the LRO LROC WAC Hapke-normalized mosaic (NASA/GSFC/Arizona State
   University). NASA media are not subject to copyright in the United States
   (https://www.nasa.gov/nasa-brand-center/images-and-media/). Credit: "NASA's Scientific
   Visualization Studio".
3. **Moon ephemeris**: Paul Schlyter, "How to compute planetary positions",
   https://stjarnhimlen.se/comp/ppcomp.html (method only; the code in `moon.js` is our own).
   Checked against JPL Horizons (https://ssd.jpl.nasa.gov/horizons/) for Oct–Dec 2026: within
   0.07° (typically 0.03°) and 0.25% in distance.

The Sun's position comes from `site/globe/astro.js` (Astronomical Almanac low-precision formulae),
the same function earth.js's lighting uses.

Downloaded 30 October 2026.
