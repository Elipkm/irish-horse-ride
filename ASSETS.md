# Assets

Record every asset here: file, source URL, author, license (CC0 / CC-BY / paid), and any changes made.
Raw downloads go in `assets-source/` (not committed; `npm run assets` re-downloads them); optimized output goes in `public/`.

`npm run assets` (see `tools/assets.mjs`) produces every file under `public/textures/` and `public/env/` from the sources below.

## Ground textures

All from Poly Haven, 1K JPG downloads of the `diff`, `nor_gl` and `arm` maps. Each becomes two 1024 px files:
`<layer>_col.webp` (colour with the scan's ambient occlusion baked in at 60 %) and
`<layer>_nr.jpg` (red/green = normal map x/y, blue = roughness).

| File | Source | Author | License | Notes |
|------|--------|--------|---------|-------|
| `public/textures/grass_col.webp`, `grass_nr.jpg` | https://polyhaven.com/a/forrest_ground_01 | Rob Tuytel | CC0 | Pasture grass. Tinted greener in the shader. |
| `public/textures/moss_col.webp`, `moss_nr.jpg` | https://polyhaven.com/a/rocky_terrain_02 | Amal Kumar | CC0 | Used as moss/heath and boggy ground. |
| `public/textures/mud_col.webp`, `mud_nr.jpg` | https://polyhaven.com/a/brown_mud_02 | Rob Tuytel | CC0 | River bed, lake shore, trail verges. Brightened in the shader. |
| `public/textures/gravel_col.webp`, `gravel_nr.jpg` | https://polyhaven.com/a/gravel_ground_01 | Rob Tuytel | CC0 | The riding trail. |
| `public/textures/rock_col.webp`, `rock_nr.jpg` | https://polyhaven.com/a/mossy_rock | Rob Tuytel | CC0 | Steep slopes and outcrops. |

## Sky / lighting

| File | Source | Author | License | Notes |
|------|--------|--------|---------|-------|
| `public/env/sky.hdr` | https://polyhaven.com/a/kloofendal_28d_misty_puresky | Greg Zaal, Jenelle van Heerden | CC0 | 1K HDR, unmodified copy. Sky background, image-based lighting, and the source the sun direction and fog colours are measured from. |

## App icons

| File | Source | Author | License | Notes |
|------|--------|--------|---------|-------|
| `public/icon-180.png` | Shipped with the initial project skeleton (no external source recorded) | Project owner | Own work | Placeholder home-screen icon; replace in M9 (icon/splash) |
| `public/icon-512.png` | Shipped with the initial project skeleton (no external source recorded) | Project owner | Own work | Placeholder manifest icon; replace in M9 (icon/splash) |

## Horse model

**Open: no model chosen yet.** The horse in the game is a stand-in generated in code
(`src/player/proceduralHorse.ts`, no files, no licence). Candidates looked at on 2026-11-11:

| Candidate | Licence / price | Notes |
|-----------|-----------------|-------|
| "Horse Rigged All Gaits" by fdoss001, https://blendswap.com/blend/28627 | CC0, free | Realistic; walk, trot, canter, gallop; saddle and bridle. No idle or jump. 584 MB Blender file with particle hair and procedural coat: needs Blender to convert, simplify and bake to a GLB. |
| "Realistic Horse with Animations" by Aragon 3D, https://www.fab.com/listings/95db4dc3-2f1b-456d-b3d1-8c924c728633 | Paid, about 85 EUR | Realistic; idle, all gaits, jump and more (20 clips). Listed in Unreal Engine format only, so it would need converting; check the licence allows use outside Unreal. |
| Horse gait clips by Amitesh Nandan (Sketchfab) | CC BY-ND | Realistic, but "no derivatives" forbids the conversion and optimisation the game needs. Not usable. |
| "Horse Rigged (Game Ready)" by abhayexe, https://sketchfab.com/3d-models/horse-riggedgame-ready-bc64f4ff7966474ca9bacd42fa73a754 | CC BY 4.0, free | Only 2.9k triangles: low-poly, not the realistic look the plan asks for. |

## Generated at runtime (no files)

The valley itself (heights, river and lake basins, trail, baked shading and ground-cover maps) and the
distant mountains are generated in code from a fixed seed: `src/world/heightfield.ts`, `src/world/backdrop.ts`.
The stand-in horse and its ground shadow are also built in code: `src/player/proceduralHorse.ts`.

## Dev tools

| Package | Source | License | Notes |
|---------|--------|---------|-------|
| `sharp` (dev dependency) | https://www.npmjs.com/package/sharp | Apache-2.0 | Used only by `npm run assets` to resize and pack textures. Not part of the shipped game. |
