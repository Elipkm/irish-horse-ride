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

| File | Source | Author | License | Notes |
|------|--------|--------|---------|-------|
| `public/models/horse.glb` | https://blendswap.com/blend/28627 ("Horse Rigged All Gaits") | fdoss001 | CC0 | Converted with `tools/horse_export.py` (see below). 2.4 MB, about 30k triangles, one 1K coat texture, 80 bones. |

Changes made by `tools/horse_export.py` (Blender 4.2 LTS):
- Kept the horse body and its 80 deform bones; removed saddle, bridle, reins, the control rig, the fur
  particle system and the teeth and gums (half the source polygons, never visible).
- Mane and tail are particle hair in the source, which a GLB cannot hold: rebuilt as 560 skinned ribbons
  that follow the source's combed guide hairs.
- Coat uses the source's ready-made "brown_black" 1K colour texture (tinted darker in `src/player/gltfHorse.ts`);
  hooves, eyes and hair are flat colours.
- Animations baked to clips: `walk`, `trot`, `canter`, `gallop`, plus the idle fidgets `headShake`,
  `headTossUp`, `headTossDown`, `tailLeft`, `tailRight`, `tailUp`. The source has no idle or jump clip:
  standing uses the rest pose, jumping holds the gathered moment of the gallop.

The source `.blend` (613 MB) is not committed and needs a signed-in BlendSwap account to download;
put it in `assets-source/horse/` to re-run the export. The stand-in horse built in code
(`src/player/proceduralHorse.ts`) remains as the fallback if the GLB fails to load.

## Generated at runtime (no files)

The valley itself (heights, river and lake basins, trail, baked shading and ground-cover maps) and the
distant mountains are generated in code from a fixed seed: `src/world/heightfield.ts`, `src/world/backdrop.ts`.
The stand-in horse and its ground shadow are also built in code: `src/player/proceduralHorse.ts`.

## Dev tools

| Package | Source | License | Notes |
|---------|--------|---------|-------|
| Blender 4.2 LTS (not in the repo) | https://www.blender.org/download/lts/4-2/ | GPL | Used only to run `tools/horse_export.py`. A portable copy can live in `assets-source/tools/`. Not part of the shipped game. |
| `sharp` (dev dependency) | https://www.npmjs.com/package/sharp | Apache-2.0 | Used only by `npm run assets` to resize and pack textures. Not part of the shipped game. |
