# Irish Horse Ride (iPad web game)

Personal single-player horse riding game for iPad, delivered as an installable web app (PWA).
Three.js + TypeScript + Vite. WebGPU where the browser supports it, automatic WebGL2 fallback.

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
`60 fps | WebGPU | draw calls 3 | tris 15 | geo 3 tex 2 | build 2026-11-10 18:47Z`

- `WebGPU` / `WebGL2`: the render backend actually in use on this device.
- `geo` / `tex`: geometries and textures currently held on the GPU.
- `heap … MB` appears only in Chromium browsers; Safari does not expose JS memory.
- Add `?webgl` to the URL to force the WebGL2 path, to compare fps between the two backends.

## Docs
- `docs/horse_game_plan.md` – full plan and milestones
- `AGENTS.md` – rules for the coding agent
- `ASSETS.md` – asset sources and licenses
