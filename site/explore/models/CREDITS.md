# Satellite model

`frontiersat.glb` (and `frontiersat-lite.glb`, the same built coarser for phones) is
FrontierSat's outside, from CalgaryToSpace's own CAD of the satellite: the V11 frame assembly, from the team's Pack and Go of its latest frame
design. It replaced a NASA stand-in (IceCube, a 3U) on 2026-11-04, and since 2026-11-12 shows
the UHF antenna's tapes and the magnetometer's arm deployed, and the boom rolled up in its mount.

| | |
|---|---|
| Source | `V11 Frame Assembly.SLDASM`, the meshes SolidWorks stores in the file |
| Kept | everything that shows from outside: the frame and walls, the five solar panels and their cells, the sun sensors (CubeSpace CubeSense) and coarse sun sensors, the magnetometer (CubeSpace CubeMag Deployable), the UHF antenna (ISISPACE), the GNSS antenna, the camera, the screws, nuts, studs and standoffs, the deployment switches and the connectors on the outside |
| Deployed | the CAD has both deployables stowed; the team's published Fusion model, which uses the makers' deployed CAD, is the reference, measured in its viewer. The CubeMag is split into its base (left on the nadir face) and its arm (the outer board and the sensor block), and the arm turns 90 degrees about its hinge pin to stand 82 mm out of the face. The antenna's four tapes are drawn in, 200 x 3 x 0.2 mm and curved across like a tape measure, each from a C-shaped hinge channel (47 x 6 x 4 mm) at the plate's edge, 20 mm off the centre, in a pinwheel. The boom is drawn rolled up in its mount behind the nadir face's window, as it still is in orbit (the CAD's boom part only has it out): a roll 25 mm across and 35 mm long with a basket weave in its surface, after the Fusion model's stowed boom |
| Left out | everything inside (the boards of the main stack, the MPI's body, the burn-wire board and its parts, the connectors on the backs of the panels) |
| Size | `frontiersat.glb` 305,016 triangles, 4,969,724 bytes, sha256 `aa51ec888f1bcc7147b48c9253e338cc142941ea715824239c1e6ebaf12ad4b3`; `frontiersat-lite.glb` 177,381 triangles, 2,762,200 bytes, sha256 `c69c766c5f039d9777620e99271769c47c20254076eb37c47a175f2a25928341` |
| The team's published model | "V10 Frame Assembly hollow" in Autodesk Fusion, shown as "FrontierSat Interactive 3D Model" on the team's CTS-SAT-1 page, https://www.calgarytospace.ca/cts-sat-1 (Autodesk's viewer: https://margosupplies.autodesk360.com/g/shares/SH28cd1QT2badd0ea72b56f92ba95deae868, checked 2026-11-16). The deployables above were measured in it; the site's Credits and About page link to the team's page |
| Credit line to show | Satellite model: CalgaryToSpace's own CAD of FrontierSat (the V11 frame), outside only and simplified for the web, with the sun sensors, magnetometer and UHF antenna as their makers' CAD draws them (CubeSpace, ISISPACE), the antenna's four tapes and the magnetometer's arm shown deployed and the boom rolled up in its mount |

The SolidWorks files, and the scripts that turn them into these files, stay off GitHub:
only these meshes are published. Each part's colour is its appearance in the team's Fusion
model (the anodised blue of the coarse sun sensors, the black boards and dark cells of the
panels, the dark grey GNSS radome, steel screws, the CubeMag's blue board), so no part looks
unlike the rest.

Since 2026-11-16 each material says what it is made of, so the model looks like hardware rather
than CAD (the meshes are unchanged): satin aluminium (mostly metal), steel screws, glossy
clear-coated solder mask on the boards (`KHR_materials_clearcoat`), solar cells as deep navy
under smooth cover glass with their coating's blue-violet sheen (clearcoat and
`KHR_materials_iridescence`), alodine-gold on the camera mount, satin black anodising, matte
plastics and the boom's matte printed carbon fibre. `../satellite.js` gives these parts the
sunlit Earth below and black space above to reflect, and keeps its own material table for a
swapped-in model whose materials are left at glTF's defaults.

## How it was made

1. Read the tessellations SolidWorks stores in the assembly (no SolidWorks needed),
   placed each part by the assembly's own transforms, and grouped them by what they are
   (structure, solar panels, sun sensors, ...).
2. Turned it into the frame below: the file's +X (the nadir wall, where the camera looks)
   became -Y, its long axis stays Z with the MPI's face at +Z, and the body's centre
   (the box of the frame and panels, 110.6 x 108.1 x 340.5 mm) became the origin.
3. Simplified it by merging vertices within 0.5 mm of each other (1.2 mm for the phone
   build) that share about the same normal, the same for every part, from 1,057,034
   triangles; the thin drawn parts (the tapes, their hinges, the boom's roll) are kept as
   drawn. Positions are 16-bit integers with a scale on each node, indices 16-bit where they
   fit, normals 8-bit (`KHR_mesh_quantization`). No textures.

Node names say what each group is; `satellite.js` leaves the ones naming an antenna,
the boom or a deployable out of the click box and the highlight outline.

## Frame used by `../satellite.js`

- origin at the centre of mass (for this model, the centre of the body)
- +Z is the long (3U) axis
- -Y is the nadir face (the face that looks at the Earth)
- 1 unit = 1 metre
