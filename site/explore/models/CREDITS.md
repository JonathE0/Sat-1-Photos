# Satellite model

`frontiersat.glb` is FrontierSat's outside, from CalgaryToSpace's own CAD of the
satellite: the V11 frame assembly, from the team's Pack and Go of its latest frame
design. It replaced a NASA stand-in (IceCube, a 3U) on 2026-11-04.

| | |
|---|---|
| Source | `V11 Frame Assembly.SLDASM`, the meshes SolidWorks stores in the file |
| Kept | the frame and walls, the five solar panels and their cells, the sun sensors (CubeSpace CubeSense) and coarse sun sensors, the magnetometer (CubeSpace CubeMag, stowed), the UHF antenna (ISISPACE, stowed), the GNSS antenna and the camera |
| Left out | everything inside (the boards of the main stack, the MPI's body, the burn-wire board), connectors, fasteners, and the boom, which is still stowed in orbit (the CAD has it part-way out) |
| Size | 111,486 triangles, 2,132,460 bytes, sha256 `427568842d8db40350b90867fe6bbb9da3225a28aab15f45c0d526a4ad15476b` |
| Credit line to show | Satellite model: CalgaryToSpace's own CAD of FrontierSat (the V11 frame), outside only and simplified for the web, with the sun sensors, magnetometer and UHF antenna as their makers' CAD draws them (CubeSpace, ISISPACE) |

The SolidWorks files, and the scripts that turn them into this file, stay off GitHub:
only this mesh is published. Colours are named by what each part is made of, so
`../satellite.js` gives them its space materials; they aren't the CAD's own appearances.

## How it was made

1. Read the tessellations SolidWorks stores in the assembly (no SolidWorks needed),
   placed each part by the assembly's own transforms, and grouped them by what they are
   (structure, solar panels, sun sensors, ...).
2. Turned it into the frame below: the file's +X (the nadir wall, where the camera looks)
   became -Y, its long axis stays Z with the MPI's face at +Z, and the body's centre
   (the box of the frame and panels, 110.6 x 108.1 x 340.5 mm) became the origin.
3. Simplified it by merging vertices within 0.6 to 2 mm of each other that share about
   the same normal, from 660,619 triangles to 111,486, with 16-bit indices and 8-bit
   normals (`KHR_mesh_quantization`). No textures.

Node names say what each group is; `satellite.js` leaves the ones naming an antenna,
the boom or a deployable out of the click box and the highlight outline.

## Frame used by `../satellite.js`

- origin at the centre of mass (for this model, the centre of the body)
- +Z is the long (3U) axis
- -Y is the nadir face (the face that looks at the Earth)
- 1 unit = 1 metre
