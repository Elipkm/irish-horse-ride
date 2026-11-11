# Irish Horse Ride (iPad web game)

Personal single-player horse riding game for iPad, delivered as an installable web app (PWA).
Three.js + TypeScript + Vite. WebGPU where the browser supports it, automatic WebGL2 fallback.

## Status
- **M1 Skeleton** – done: renderer, PWA, deploy.
- **M2 Terrain & light** – done: one 2 km valley (river bed, lake, trail, enclosing hills), five blended
  ground materials, sky-image lighting, valley mist, filmic tone mapping.
- **M3 Horse** – done: realistic rigged horse (CC0) with walk, trot, canter and gallop animations matched
  to its speed, steering, jumping, terrain-following, keyboard controls, follow camera.
- Next: **M4 Touch controls & camera**.

## What you can do right now (M3)
Ride the horse around the valley. It starts at a walk, steering itself along the trail.

Keyboard (desktop):

| Key | Action |
|-----|--------|
| **W** / **↑** | Faster gait: Halt → Walk → Trot → Canter → Gallop |
| **S** / **↓** | Slower gait |
| **X**, **1**, **2**, **3**, **4** | Halt, Walk, Trot, Canter, Gallop directly |
| **A** **D** / **←** **→** | Steer (this also switches automatic steering off) |
| **Space** | Jump (from a trot or faster) |
| **T** | Automatic steering along the trail on/off |
| **R** | Put the horse back on the trail (if it gets stuck) |
| **V** | Camera near / far |
| **Q** | Quality Low / Medium / High (render resolution and terrain detail; remembered) |

On the iPad (no touch steering until M4): leave **Steering: Auto** on and use the **Gait**, **Jump**,
**View** and **Quality** buttons. **Drag** anywhere to look around; the camera drifts back behind the horse.

The horse slows on steep climbs and refuses slopes steeper than about 40°, slows in shallow water,
and stops before water deeper than 1 m and before the edge of the map.

## Run locally
```
npm install
npm run dev        # opens on your LAN; also usable from the iPad on the same Wi-Fi
```

Quick test without deploying: run `npm run dev` and open `http://<laptop-ip>:5173` on the iPad (same Wi-Fi).
Home-screen install and offline mode need HTTPS, so use the deployed site for those.

## Build
```
npm run build      # type-checks, then outputs dist/ (including a generated dist/sw.js)
npm run preview    # serves dist/ on http://localhost:4173
```

## Assets
```
npm run assets     # downloads raw CC0 files into assets-source/ and writes optimised copies to public/
```
Only needed when adding or changing assets: the optimised files in `public/` are committed, the raw
downloads in `assets-source/` are not. Every asset is listed with source and licence in `ASSETS.md`.

The horse is the one asset that script does not build. Its source needs a signed-in download and Blender
(details in `ASSETS.md`); with both in place, re-create `public/models/horse.glb` with:
```
blender -b --disable-autoexec --factory-startup "assets-source/horse/Horse Rigged All Gaits.blend" --python tools/horse_export.py -- public/models/horse.glb
```

## Deploy (GitHub Pages)
Hosting is GitHub Pages, built by GitHub Actions (`.github/workflows/deploy.yml`).

**Every `git push` to `main` rebuilds and redeploys the site** (takes about a minute).
Progress and errors: the repo's **Actions** tab on github.com.

Live URL: **https://elipkm.github.io/irish-horse-ride/**
Repo: https://github.com/Elipkm/irish-horse-ride

One-time setup (already done if the site is live):
1. Create an empty **public** repo on github.com (free plans only serve Pages from public repos).
2. `git remote add origin https://github.com/<github-username>/<repo-name>.git` then `git push -u origin main`.
3. On github.com: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. If the first workflow run failed because step 3 came after the push: **Actions → Deploy to GitHub Pages → Re-run all jobs**.

## Install on iPad
1. Open the live URL in **Safari** (not Chrome) on the iPad.
2. Tap **Share → Add to Home Screen → Add**.
3. Launch it from the home-screen icon: it opens fullscreen in landscape and works offline after the first launch.

### Getting a new version onto the iPad
Close the app (swipe it away) and open it again while online. Page loads go to the network first,
so the newest deploy appears on that launch. The overlay shows `build <date time>` (UTC) so you can
confirm which build is running.

## On-screen overlay
`60 fps (worst 17 ms) | 3.0 m/s | WebGPU | calls 10 | tris 86k | geo 21 tex 23 | build 2026-11-11 05:38Z`

- `fps`: average over the last half second; `worst`: the longest single frame in that time (stutter shows here first).
- `m/s`: the horse's current speed (walk 1.4, trot 3.0, canter 5.0, gallop 11).
- `WebGPU` / `WebGL2`: the render backend actually in use on this device.
- `calls` / `tris`: draw calls and triangles per frame. Plan budget: under 150 calls and 200k triangles.
- `geo` / `tex`: geometries and textures currently held on the GPU.
- `heap … MB` appears only in Chromium browsers; Safari does not expose JS memory.
- Add `?webgl` to the URL to force the WebGL2 path, to compare fps between the two backends.

## Docs
- `docs/horse_game_plan.md` – full plan and milestones
- `AGENTS.md` – rules for the coding agent
- `ASSETS.md` – asset sources and licenses
