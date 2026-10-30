# Satellite model

`cubesat-3u.glb` is a **stand-in** for CTS-SAT-1. It is NASA's model of
**IceCube** (also written ICECube; "Earth-1"), a 3U CubeSat built by NASA Goddard
that flew in 2017 with an 883 GHz cloud-ice radiometer. It is not CTS-SAT-1. It is
used because it is a realistic 3U with body-mounted solar cells, until the team's own
CAD model is found. It has no UHF antennas and no boom.

| | |
|---|---|
| Title | CubeSat – ICECube |
| Author / credit | NASA/Christopher R. Meaney (NASA Goddard Space Flight Center) |
| Source page | https://science.nasa.gov/3d-resources/cubesat-icecube |
| File used | https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/cubesat---icecube/CubeSat%20-%20ICECube.glb (309,684 bytes, sha256 `7ad1a4be4beb2c1b62b6fc48a9538db6c914d871099681745e188deb1925f31a`). It is byte-identical to `3D Models/CubeSat - ICECube/CubeSat - ICECube.glb` in https://github.com/nasa/NASA-3D-Resources (commit 3fc74df, 2025-03-20). |
| Licence | Public domain (U.S. Government work). From the NASA 3D Resources README: "These assets are free and without copyright." NASA's media guidelines (https://www.nasa.gov/nasa-brand-center/images-and-media/) say NASA images, audio, video and 3D models "generally are not subject to copyright in the United States", that "NASA should be acknowledged as the source of the material", and that NASA does not endorse any product, service or activity. The model has no NASA insignia or logotype on it. |
| Credit line to show | 3D model: NASA/Christopher R. Meaney (CubeSat – ICECube, NASA 3D Resources), modified. |

## What was changed

Converted with glTF-Transform 4.1.1 (Node), from a script kept outside the site:

1. Decoded the Draco mesh compression.
2. Removed a hidden part: a flat 9 x 2 cm label (2,414 triangles, material
   `Default`) that sat at the centre of the body, inside the box.
3. Re-framed to the site convention (below): rotated +90° about X (the source's long
   axis +Y becomes +Z; the instrument face, source +Z, becomes the nadir face -Y),
   then centred on the body.
4. Rescaled to metres. The body cross-section (2 source units) became 0.100 m. The
   source is about 20 % too long for its width, so the long axis was scaled on its
   own to the real 3U length of 0.3405 m (factor 0.828 relative to the cross-section).
   This also gives the solar cells their real 2:1 shape.
5. Materials: the 21 source materials (all flat, roughness 0.81, no metal) were mapped
   to 11 named PBR materials for a lit-by-the-Sun look: `solar-cell` (dark blue, glossy),
   `solar-cell-interconnect`, `solar-panel-pcb`, `aluminium`, `aluminium-anodised-dark`,
   `black-anodised`, `gold-kapton`, `silver-foil`, `white-paint`, `yellow-label`,
   `instrument-aperture`. The 7 tile shades the source used on the cells were kept as a
   vertex colour on the one `solar-cell` material.
6. Merged primitives by material (one mesh, 11 draw calls), welded vertices, and
   compressed with `EXT_meshopt_compression` + `KHR_mesh_quantization` (14-bit
   positions, 8-bit normals). No textures.

Result: 352,248 bytes (sha256 `97b5f39c3f61b61dee69243ff2da2919726217d1476d95d7f153bb5d4e3cd596`),
55,704 triangles, bounds 11.7 x 10.6 x 34.3 cm (x includes the cells standing proud
of the frame).

## Frame used by `../satellite.js`

- origin at the centre of mass (for this model, the centre of the body)
- +Z is the long (3U) axis
- -Y is the nadir face (the face that looks at the Earth)
- 1 unit = 1 metre

## Swapping in the CTS-SAT-1 CAD model

Export the CAD to glTF/GLB, then shrink it, for example:

    npx @gltf-transform/cli@4.1.1 optimize cts-sat-1-raw.glb cts-sat-1.glb --compress meshopt --texture-compress webp --texture-size 1024

and either replace `cubesat-3u.glb` or pass the new URL:

    createSatellite({ modelUrl: new URL('./models/cts-sat-1.glb', import.meta.url).href,
                      rotation: [0, 0, 0],      // degrees, XYZ, to reach the frame above
                      metresPerUnit: 'auto',    // guesses mm / cm / m
                      centre: 'origin' })       // or 'bbox' if the CAD origin is at a corner

Name the materials after what they are (for example "solar cell", "aluminium rail",
"kapton") and `satellite.js` gives them the same space look. Parts whose node names
contain `antenna`, `boom`, `whip`, `tape spring` or `deployable` are left out of the
click box and the highlight outline. Then update this file with the new credits.
