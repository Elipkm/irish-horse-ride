# Irish Horse Riding Game for iPad (Web/PWA) — Plan for Coding Agent

## 1. Goal
A personal, single-player, 3D horse riding game for iPad set in **Ireland**: misty green valleys, ancient forest, stone walls, lakes, overcast soft light. Visual target: **realistic, cinematic, "photoreal-leaning"** within the limits of mobile Safari. No App Store; it only needs to run on the owner's iPad.

## 2. Tech Stack (decided: web)
- Three.js + TypeScript + Vite.
- Renderer: **WebGPU (Three.js WebGPURenderer)** where Safari supports it, automatic **WebGL2 fallback**.
- Delivered as an installable **PWA** (hosted free on GitHub Pages / Netlify / Cloudflare Pages; Safari → Share → Add to Home Screen). Offline via service worker.
- Do NOT switch stacks without asking the owner.

## 3. Performance & Memory Budget (mobile Safari)
- Target 60 fps, minimum 30 fps, landscape, touch only. Cap pixel ratio at 2 (consider 1.5 on heavy scenes).
- Keep total GPU memory well under ~1 GB (Safari kills heavy tabs). Textures: 1K default, 2K only for hero assets (horse, ground close-up). Use KTX2/Basis compression.
- < 200k triangles on screen, < 150 draw calls. Heavy use of instancing, LOD and impostors.
- Stream assets by zone; show a loading screen; dispose unused resources.
- Built-in quality manager: auto-lowers shadow res, grass density, view distance, post effects when fps drops. Manual Low/Medium/High in settings.

## 3b. World Scope (decided)
Build **one small, highly polished valley (about 1–2 km across)** first: valley floor, river/lake, forest edge, a few Irish landmarks, distant mountains as backdrop. Do not build a large open world. Expand only after the valley looks great and holds the fps target on the owner's iPad. Favor hand-placed landmarks and composed views over sheer size.

## 4. Gameplay (MVP)
1. Free ride through an open Irish landscape on a realistic horse.
2. Touch controls: left joystick steers; right buttons for Walk / Trot / Canter / Gallop and Jump; drag right half to orbit camera (auto-recenter).
3. Gaits with smooth blending, inertia, speed-matched animation and hoof sounds.
4. Third-person follow camera, smoothed, collision-aware (no clipping into trees/terrain).
5. Relaxing goals, no fail state: follow a trail to waypoints (ruined abbey, stone circle, lake, cliff view), optional collectibles. Photo mode (hide HUD, save screenshot).
6. Optional stamina: gallop drains, walk recovers.

## 5. Scenery & Visual Direction (Ireland)
**Look:** soft overcast, low sun breaking through cloud, mist in valleys, saturated greens, wet ground, golden-hour variant.
- **Terrain:** large procedural + hand-tuned heightmap: rolling hills, a wide valley, river and lake, boggy patches, rocky outcrops, a distant mountain range. Splat-mapped PBR materials (grass, mud, rock, gravel path, moss) with detail normal maps and triplanar rock. Chunked with LOD.
- **Forest:** native Irish trees (oak, birch, hazel, Scots pine, gorse bushes, ferns, moss-covered rocks). GPU-instanced meshes + billboard impostors for distance, fallen logs, undergrowth.
- **Grass & flowers:** dense instanced grass with wind shader near player, fading to texture far away; wildflowers, heather, bracken.
- **Irish landmarks:** dry-stone walls dividing fields, gates, a ruined abbey/castle, round tower, stone circle, old stone bridge, small cottages with smoke, sheep herds, crows.
- **Sky & weather:** physically-based sky (sun/sky scattering), layered volumetric-style clouds, light rain option, rolling fog, **god rays** through trees.
- **Lighting:** directional sun + image-based lighting (HDRI), baked ambient occlusion where possible, cascaded shadows only near player. Bake lighting into lightmaps/vertex AO for static objects.
- **Water:** shader with reflections (planar or SSR-lite), flow, shoreline foam, horse splash particles.
- **Post-processing (toggle):** filmic tone mapping (ACES/AgX), subtle bloom, depth of field in photo mode, color grading, light vignette, atmospheric fog/height fog, optional TAA.
- **Particles:** hoof dust/mud, breath mist in cold air, falling leaves, midges/butterflies, rain.
- **Time of day:** dawn → midday → golden hour → dusk (phase 3).

## 6. Assets (the hardest part — plan carefully)
- **Horse:** realistic, rigged, animated glTF (idle, walk, trot, canter, gallop, jump, head/tail secondary motion). Check CC0/CC-BY options on Sketchfab, Fab, Quaternius; a paid model is acceptable if the owner agrees. Add procedural head bob, mane/tail sway, rider IK if possible.
- **Rider:** simple realistic or silhouette-style figure attached to saddle (can be MVP-omitted).
- **Environment:** photogrammetry/scan packs (Fab/Megascans, Poly Haven CC0 for textures + HDRIs, ambientCG CC0, Quaternius). Convert and optimize to GLB with Draco/meshopt + KTX2; decimate to mobile budgets.
- **Audio:** hoof steps per gait/surface, wind, birds, stream, ambient Irish-style soft music (CC0/licensed), rain. Start audio on first tap (iOS rule).
- Maintain `ASSETS.md` with source and license for every asset. Ask owner before any paid asset.

## 7. Architecture
```
/src
  main.ts           // bootstrap, game loop
  engine/           // renderer (WebGPU/WebGL2), quality manager, resize, loader
  world/            // terrain, splat materials, forest, grass, water, sky, weather, landmarks
  player/           // horse controller, gaits, animation, IK
  camera/           // follow camera, photo mode
  input/            // touch joystick, buttons
  ui/               // HUD, menus (HTML/CSS overlay)
  audio/            // sound manager
  game/             // objectives, state, save
/public             // GLB/KTX2 assets, manifest, icons, service worker
```
- Fixed-timestep update, variable render. Terrain height sampling + simple gravity/jump physics (no heavy physics engine for MVP); simple collision for trees/walls via colliders.
- Save settings/progress in localStorage.

## 8. iPad / Safari Specifics
- Viewport meta with `viewport-fit=cover`; PWA manifest `display: fullscreen`, landscape.
- Disable scroll/zoom/bounce: `touch-action: none`, `overscroll-behavior: none`.
- Unlock audio on first tap; pause on visibility change; safe-area insets for HUD.
- Watch memory and thermal throttling; test on a **real iPad** frequently and log fps/memory.

## 9. Milestones (each one must run and be installable)
1. **M1 Skeleton:** Vite+TS+Three, WebGPU w/ WebGL2 fallback, sky + ground, fps/memory overlay, deployed PWA on iPad.
2. **M2 Terrain & light:** one 1–2 km valley heightmap, splat materials, HDRI lighting, fog, tone mapping.
3. **M3 Horse:** model, animations, desktop keyboard controls, terrain-following.
4. **M4 Touch controls & camera.**
5. **M5 Forest & grass:** instancing, LOD, impostors, wind.
6. **M6 Water, sky, weather, god rays, particles.**
7. **M7 Irish landmarks:** stone walls, abbey, bridge, sheep, cottages.
8. **M8 Audio + HUD + waypoints + photo mode + save.**
9. **M9 Polish:** post-processing toggle, quality auto-scaling, memory/perf pass, icon/splash, time of day.

## 10. Acceptance Criteria
- Installs from Safari to home screen, fullscreen, offline-capable.
- ≥ 30 fps (target 60) during gallop through forest and valley on the owner's iPad; stable for 20 minutes with no memory growth.
- Controls comfortable with two thumbs; no accidental scroll/zoom.
- Visually: misty layered valleys, believable forest density, wet-looking terrain, moving grass, reflective water, soft cinematic light.

## 11. Working Rules for the Agent
- Deliver one milestone at a time, commit after each, keep the app runnable.
- Profile on the real iPad before and after every visual feature; never exceed the budgets in §3 without telling the owner.
- Provide README: dev, build, deploy, install on iPad.
- Ask before changing the stack, buying assets, or adding services/accounts.
- Prefer robust and measurable over clever; add fallbacks for every advanced effect.

## 12. Open Questions for the Owner
- Which iPad model (chip) and iPadOS version? (Sets the quality ceiling.)
- Budget for paid assets (horse model, scenery packs)?
- Preferred time of day / weather as the default mood?
