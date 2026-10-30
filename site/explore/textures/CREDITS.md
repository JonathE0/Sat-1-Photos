# Earth textures (Explore page)

All maps here are made from NASA imagery. NASA images "generally are not subject to copyright in
the United States"; NASA asks to be acknowledged as the source
(https://www.nasa.gov/nasa-brand-center/images-and-media/). Credit when republishing:
**"NASA Earth Observatory"** (and for the night lights, "NASA Earth Observatory / Suomi NPP VIIRS").

Every file is resized with Pillow (Lanczos, or area-averaging for the water mask) from the
originals below. What else was done to each is listed with it. `build_textures.py` (here) made
them: `python -I build_textures.py <folder of originals> <output folder> 200410`.

| Files | Made from | What was done |
|---|---|---|
| `earth-day-{8192,4096,2048,1024}.webp` | Blue Marble Next Generation with topography and bathymetry, **October 2004** (21600 × 10800), plus the BMNG base map for October 2004 (21600 × 10800) | Land unchanged (no colour, saturation or contrast change). Water: BMNG's synthetic bathymetry shading turns every continental shelf bright map-blue, which is not what the sea looks like from orbit; it is kept at 20% over BMNG's own dark open-ocean colour, and where the base map shows real water colour (shallow banks such as the Bahamas, sediment plumes) that is used instead. WebP quality 84. |
| `earth-water-{8192,4096,2048}.png` | The same two October 2004 BMNG maps | Land/water mask (white = water, lakes included), from where the two versions differ: the sea is bathymetry-shaded in one and flat or real-coloured in the other. 3 × 3 close and open to remove specks, then area-averaged so coasts are anti-aliased. A few very turbid estuaries (e.g. Río de la Plata) read as land. |
| `earth-lights-{8192,4096,2048,1024}.jpg` | Earth at Night (Black Marble) 2016 colour map, 3 km (13500 × 6750) | One channel: R + G − B, offset and rescaled, which keeps the warm-to-white city light and drops the composite's blue-violet moonlit-land backdrop. The shader re-colours it (sodium orange to white). |
| `earth-clouds-{8192,4096,2048,1024}.jpg` | Blue Marble: Clouds, 8192 × 4096 (Visible Earth 57747) | One channel. The faint ground that shows through the composite (grey 20–40) is cut with a black point of 32. The composite does not wrap at the antimeridian; both edges are pulled to a common value over a 96-pixel band so the seam is not a straight line. |
| `earth-relief-4096.jpg` | Blue Marble Next Generation topography (GEBCO_08 elevation), 5400 × 2700 | Resized only. Used as a gentle bump (exaggerated 3×, off over water and near the poles). |

## Sources

1. **Blue Marble: Next Generation w/ Topography and Bathymetry, October 2004**, 21600 × 10800 JPEG.
   NASA Earth Observatory, Reto Stöckli (NASA Goddard Space Flight Center), from Terra/MODIS data.
   https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/october/world.topo.bathy.200410.3x21600x10800.jpg
   Listed at https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/
2. **Blue Marble: Next Generation (base map), October 2004**, 21600 × 10800 JPEG. Same credit.
   https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/october/world.200410.3x21600x10800.jpg
   Listed at https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/
3. **Earth at Night (Black Marble) 2016 Color Maps**, global 13500 × 6750 (3 km) JPEG. NASA Earth
   Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA Goddard
   Space Flight Center.
   https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg
   (also served at https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg)
   Listed at https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
4. **Blue Marble: Clouds** (Visible Earth image 57747), 8192 × 4096 TIFF. NASA Goddard Space Flight
   Center; image by Reto Stöckli, enhancements by Robert Simmon; MODIS data.
   https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif
   Listed at https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/
5. **Blue Marble: Next Generation Topography**, global 5400 × 2700 JPEG
   (`gebco_08_rev_elev_5400x2700.jpg`). NASA Earth Observatory, from the GEBCO_08 grid (General
   Bathymetric Chart of the Oceans).
   https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/topography/gebco_08_rev_elev_5400x2700.jpg
   Listed at https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps/

Downloaded 29–30 October 2026.

## Another month

The day map and water mask are for October. BMNG exists for every month of 2004 (same URLs with
`january` … `december` and `200401` … `200412`); re-running the build for another month replaces
`earth-day-*` and `earth-water-*` only.
