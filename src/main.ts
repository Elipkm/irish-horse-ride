import * as THREE from 'three/webgpu';
import { FollowCamera } from './camera/followCamera';
import { QUALITY_LEVELS, loadQualityIndex, saveQualityIndex } from './engine/quality';
import { createRenderer } from './engine/renderer';
import { Keyboard } from './input/keyboard';
import { GAITS, TOP_SPEED } from './player/gaits';
import { HorseController } from './player/horseController';
import { ProceduralHorse } from './player/proceduralHorse';
import { hud } from './ui/hud';
import { createLakePlaceholder, createMountains } from './world/backdrop';
import { loadEnvironment } from './world/environment';
import { generateHeightfield } from './world/heightfield';
import { Terrain } from './world/terrain';
import { GROUND_LAYERS, type GroundTextures } from './world/terrainMaterial';

// M3: ride a horse through the valley (keyboard on desktop; on-screen buttons and autopilot for the iPad).

const STEP = 1 / 60; // fixed time step of the riding simulation

async function loadGroundTextures(anisotropy: number, onLoaded: () => void): Promise<GroundTextures> {
  const loader = new THREE.TextureLoader();
  const load = async (file: string, colorSpace: THREE.ColorSpace) => {
    const t = await loader.loadAsync(`./textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = colorSpace;
    t.anisotropy = anisotropy;
    onLoaded();
    return t;
  };
  // Average colour of an albedo image, for the far-distance look of each ground layer.
  const meanColor = (image: CanvasImageSource) => {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
    const n = (px.length / 4) * 255;
    return new THREE.Color().setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
  };
  const entries = await Promise.all(
    GROUND_LAYERS.map(async (name) => {
      const col = await load(`${name}_col.webp`, THREE.SRGBColorSpace);
      const nr = await load(`${name}_nr.jpg`, THREE.NoColorSpace);
      return [name, { col, nr, mean: meanColor(col.image as CanvasImageSource) }] as const;
    })
  );
  return Object.fromEntries(entries) as GroundTextures;
}

async function start() {
  hud.setLoading('Starting renderer…', 0.02);
  const { renderer, backend } = await createRenderer();
  let qualityIndex = loadQualityIndex();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LEVELS[qualityIndex].pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // ACES keeps the greens saturated under the grey sky; AgX looked washed out in this scene.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.4, 7000);

  // Load files and build the valley side by side; the bar tracks both.
  let filesDone = 0;
  let terrainDone = 0;
  const FILES = GROUND_LAYERS.length * 2 + 1;
  const progress = () => hud.setLoading('Loading valley…', 0.05 + 0.45 * (filesDone / FILES) + 0.5 * terrainDone);
  const fileLoaded = () => {
    filesDone++;
    progress();
  };
  const [ground, environment, field] = await Promise.all([
    loadGroundTextures(Math.min(4, renderer.getMaxAnisotropy()), fileLoaded),
    loadEnvironment(scene, './env/sky.hdr').then((e) => (fileLoaded(), e)),
    generateHeightfield((f) => {
      terrainDone = f;
      progress();
    }),
  ]);

  const terrain = new Terrain(field, ground);
  terrain.setLodRange(QUALITY_LEVELS[qualityIndex].terrainRange);
  scene.add(terrain.mesh, createMountains(), createLakePlaceholder(field));

  const horse = new HorseController(field);
  const horseModel = new ProceduralHorse();
  scene.add(horseModel.root, horseModel.shadow);
  const follow = new FollowCamera(camera, field, renderer.domElement);

  const refreshGait = hud.button('btn-gait', () => `Gait: ${horse.gait.name}`, () => horse.setGait((horse.gaitIndex + 1) % GAITS.length));
  hud.button('btn-jump', () => 'Jump', () => horse.jump());
  const refreshAuto = hud.button('btn-auto', () => `Steering: ${horse.autopilot ? 'Auto' : 'Manual'}`, () => horse.setAutopilot(!horse.autopilot));
  hud.button('btn-view', () => `View: ${follow.far ? 'Far' : 'Near'}`, () => (follow.far = !follow.far));
  hud.button('btn-quality', () => `Quality: ${QUALITY_LEVELS[qualityIndex].name}`, () => {
    qualityIndex = (qualityIndex + 1) % QUALITY_LEVELS.length;
    saveQualityIndex(qualityIndex);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LEVELS[qualityIndex].pixelRatio));
    terrain.setLodRange(QUALITY_LEVELS[qualityIndex].terrainRange);
  });

  const keys = new Keyboard();
  const click = (id: string) => () => document.getElementById(id)!.click();
  const gaitKey = (index: () => number) => () => {
    horse.setGait(index());
    refreshGait();
  };
  keys.onPress(['KeyW', 'ArrowUp'], gaitKey(() => horse.gaitIndex + 1));
  keys.onPress(['KeyS', 'ArrowDown'], gaitKey(() => horse.gaitIndex - 1));
  ['KeyX', 'Digit1', 'Digit2', 'Digit3', 'Digit4'].forEach((code, i) => keys.onPress([code], gaitKey(() => i)));
  keys.onPress(['Space'], () => horse.jump());
  keys.onPress(['KeyT'], click('btn-auto'));
  keys.onPress(['KeyV'], click('btn-view'));
  keys.onPress(['KeyQ'], click('btn-quality'));
  keys.onPress(['KeyR'], () => horse.returnToTrail());

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // JS heap is only reported by Chromium; Safari has no equivalent, so there we show GPU object counts only.
  const heapMB = () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? ` | heap ${Math.round(m.usedJSHeapSize / 1048576)} MB` : '';
  };

  // Debug handle for development and automated checks; not used by the game itself.
  Object.assign(window, { __game: { renderer, scene, camera, terrain, field, environment, horse, horseModel, follow } });

  let last = performance.now();
  let simTime = 0;
  let frames = 0;
  let acc = 0;
  let slowest = 0;
  let firstFrame = true;
  renderer.setAnimationLoop((now: number) => {
    // The first callback's timestamp can predate `last`, and a hidden tab produces huge gaps: clamp both ways.
    const frameMs = Math.max(0, now - last);
    const dt = Math.min(0.1, frameMs / 1000);
    last = now;

    // Taking the reins: any steering key switches the autopilot off.
    const steer = keys.steer();
    if (steer !== 0 && horse.autopilot) {
      horse.setAutopilot(false);
      refreshAuto();
    }
    horse.steerInput = steer;

    // Simulate in fixed steps, then draw the horse between the last two steps.
    simTime += dt;
    while (simTime >= STEP) {
      horse.step(STEP);
      simTime -= STEP;
    }
    horse.applyPose(simTime / STEP, horseModel.root);
    horseModel.update(dt, horse);
    follow.update(dt, horseModel.root.position, horse.renderHeading, horse.speed / TOP_SPEED);

    terrain.update(camera);
    renderer.render(scene, camera);

    if (firstFrame) {
      firstFrame = false;
      hud.hideLoading();
      return;
    }
    frames++;
    acc += frameMs / 1000;
    slowest = Math.max(slowest, frameMs);
    if (acc >= 0.5) {
      const { render, memory } = renderer.info;
      hud.setStats(
        `${Math.round(frames / acc)} fps (worst ${Math.round(slowest)} ms) | ${horse.speed.toFixed(1)} m/s | ${backend} | calls ${render.drawCalls}` +
          ` | tris ${Math.round(render.triangles / 1000)}k | geo ${memory.geometries} tex ${memory.textures}${heapMB()} | build ${__BUILD__}`
      );
      frames = 0;
      acc = 0;
      slowest = 0;
    }
  });
}

start().catch((err) => {
  console.error(err);
  hud.showError(`Could not start: ${err instanceof Error ? err.message : String(err)}`);
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // A new deploy installs a new service worker in the background. When it takes over a page that
  // was already controlled by the old one, reload once so the new build shows on this launch.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  }
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
