import * as THREE from 'three/webgpu';
import { FollowCamera } from './camera/followCamera';
import { QUALITY_LEVELS, loadQualityIndex, saveQualityIndex } from './engine/quality';
import { createRenderer } from './engine/renderer';
import { Keyboard } from './input/keyboard';
import { TouchControls } from './input/touchControls';
import { TOP_SPEED } from './player/gaits';
import { GltfHorse } from './player/gltfHorse';
import { HorseController } from './player/horseController';
import { ProceduralHorse } from './player/proceduralHorse';
import { hud } from './ui/hud';
import { createMountains } from './world/backdrop';
import { Effects } from './world/effects';
import { loadEnvironment } from './world/environment';
import { Forest } from './world/forest';
import { GodRays } from './world/godRays';
import { Grass } from './world/grass';
import { Crows } from './world/crows';
import { planLandmarks, TOWER } from './world/landmarkPlan';
import { Landmarks } from './world/landmarks';
import { SheepFlocks } from './world/sheep';
import { generateHeightfield } from './world/heightfield';
import { Particles } from './world/particles';
import { Rain } from './world/rain';
import { CloudLayer } from './world/sky';
import { Terrain } from './world/terrain';
import { Water } from './world/water';
import { Weather } from './world/weather';
import { windTime } from './world/wind';
import { GROUND_LAYERS, type GroundTextures } from './world/terrainMaterial';

// M7: the valley is lived in: field walls and gates, a ruined abbey and round tower, a stone circle,
// a bridge, cottages with smoking chimneys, sheep and crows.

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
  const FILES = GROUND_LAYERS.length * 2 + 4;
  const progress = () => hud.setLoading('Loading valley…', 0.05 + 0.45 * (filesDone / FILES) + 0.5 * terrainDone);
  const fileLoaded = () => {
    filesDone++;
    progress();
  };
  const loadBark = async (file: string) => {
    const t = await new THREE.TextureLoader().loadAsync(`./textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    fileLoaded();
    return t;
  };
  const [ground, environment, field, horseModel, barkOak, barkPine] = await Promise.all([
    loadGroundTextures(Math.min(4, renderer.getMaxAnisotropy()), fileLoaded),
    loadEnvironment(scene, './env/sky.hdr').then((e) => (fileLoaded(), e)),
    generateHeightfield((f) => {
      terrainDone = f;
      progress();
    }),
    // If the horse file cannot be loaded, ride the simple code-built horse rather than nothing.
    GltfHorse.load('./models/horse.glb')
      .catch((err) => (console.warn('horse.glb failed to load, using the stand-in horse', err), new ProceduralHorse()))
      .then((h) => (fileLoaded(), h)),
    loadBark('bark_oak_col.webp'),
    loadBark('bark_pine_col.webp'),
  ]);

  // Where the landmarks stand is settled first, so the trees keep clear of them. The plan also
  // makes the bridge deck part of the ground the horse stands on.
  const plan = planLandmarks(field);

  // The forest goes next: it writes the shade under the trees into a terrain map.
  const forest = new Forest(renderer, field, { oak: barkOak, pine: barkPine }, environment.sunDirection, plan);
  forest.setNearRange(QUALITY_LEVELS[qualityIndex].treeRange);
  scene.add(forest.group);

  const terrain = new Terrain(field, ground);
  terrain.setLodRange(QUALITY_LEVELS[qualityIndex].terrainRange);
  scene.add(terrain.mesh, createMountains());

  const water = new Water(field, environment, QUALITY_LEVELS[qualityIndex]);
  const clouds = new CloudLayer(environment);
  const godRays = new GodRays(forest, environment);
  godRays.mesh.visible = QUALITY_LEVELS[qualityIndex].lightShafts;
  const rain = new Rain(environment, QUALITY_LEVELS[qualityIndex].rainDrops);
  const particles = new Particles();
  const effects = new Effects(particles, field, forest, environment);
  const weather = new Weather(scene, environment);
  scene.add(water.mesh, clouds.mesh, godRays.mesh, rain.mesh, particles.mesh);

  const grass = new Grass(field, ground.grass.mean, QUALITY_LEVELS[qualityIndex].grassTufts);
  scene.add(grass.mesh);

  const landmarks = new Landmarks(field, plan, ground.rock.col);
  const sheep = new SheepFlocks(field, plan.colliders);
  const crows = new Crows(new THREE.Vector3(plan.tower.x, plan.tower.y + TOWER.height, plan.tower.z));
  scene.add(landmarks.mesh, sheep.mesh, crows.mesh);
  effects.chimneys = landmarks.chimneys;

  const horse = new HorseController(field);
  // Solid things: tree trunks, and everything built (low field walls can be jumped).
  horse.obstacles = {
    pushOut(p, radius, clearance) {
      const tree = forest.pushOut(p, radius);
      return plan.colliders.pushOut(p, radius, clearance) || tree;
    },
  };
  scene.add(horseModel.root, horseModel.shadow.mesh);
  const follow = new FollowCamera(camera, field);
  follow.structures = plan.colliders;

  const setGait = (index: number) => {
    horse.setGait(index);
    touch.showGait(horse.gaitIndex);
  };
  const touch = new TouchControls(renderer.domElement, {
    onGait: setGait,
    onJump: () => horse.jump(),
    onLook: (dx, dy) => follow.look(dx, dy),
    onLookHeld: (held) => (follow.held = held),
  });
  touch.showGait(horse.gaitIndex);

  const refreshAuto = hud.button('btn-auto', () => `Auto-ride: ${horse.autopilot ? 'On' : 'Off'}`, () => {
    horse.setAutopilot(!horse.autopilot);
    if (horse.autopilot && horse.gaitIndex === 0) setGait(1); // set off at a walk rather than standing there
  });
  hud.button('btn-view', () => `View: ${follow.far ? 'Far' : 'Near'}`, () => (follow.far = !follow.far));
  hud.button('btn-weather', () => `Weather: ${weather.name}`, () => weather.next());
  hud.button('btn-quality', () => `Quality: ${QUALITY_LEVELS[qualityIndex].name}`, () => {
    qualityIndex = (qualityIndex + 1) % QUALITY_LEVELS.length;
    saveQualityIndex(qualityIndex);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LEVELS[qualityIndex].pixelRatio));
    terrain.setLodRange(QUALITY_LEVELS[qualityIndex].terrainRange);
    grass.setDensity(QUALITY_LEVELS[qualityIndex].grassTufts);
    forest.setNearRange(QUALITY_LEVELS[qualityIndex].treeRange);
    water.setQuality(QUALITY_LEVELS[qualityIndex]);
    godRays.mesh.visible = QUALITY_LEVELS[qualityIndex].lightShafts;
    rain.setDrops(QUALITY_LEVELS[qualityIndex].rainDrops);
  });

  const keys = new Keyboard();
  const click = (id: string) => () => document.getElementById(id)!.click();
  const gaitKey = (index: () => number) => () => setGait(index());
  keys.onPress(['KeyW', 'ArrowUp'], gaitKey(() => horse.gaitIndex + 1));
  keys.onPress(['KeyS', 'ArrowDown'], gaitKey(() => horse.gaitIndex - 1));
  ['KeyX', 'Digit1', 'Digit2', 'Digit3', 'Digit4'].forEach((code, i) => keys.onPress([code], gaitKey(() => i)));
  keys.onPress(['Space'], () => horse.jump());
  keys.onPress(['KeyT'], click('btn-auto'));
  keys.onPress(['KeyV'], click('btn-view'));
  keys.onPress(['KeyQ'], click('btn-quality'));
  keys.onPress(['KeyP'], click('btn-weather'));
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
  Object.assign(window, { __game: { renderer, scene, camera, terrain, field, environment, horse, horseModel, follow, touch, grass, forest, water, clouds, godRays, rain, particles, effects, weather, plan, landmarks, sheep, crows } });

  let last = performance.now();
  let simTime = 0;
  let frames = 0;
  let acc = 0;
  let slowest = 0;
  let firstFrame = true;
  const nose = new THREE.Vector3();
  renderer.setAnimationLoop((now: number) => {
    // The first callback's timestamp can predate `last`, and a hidden tab produces huge gaps: clamp both ways.
    const frameMs = Math.max(0, now - last);
    const dt = Math.min(0.1, frameMs / 1000);
    last = now;

    // Taking the reins: any steering (keys or joystick) switches the auto-ride off.
    const steer = keys.steer() || touch.steer;
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

    windTime.value += dt;
    weather.update(dt);
    terrain.update(camera);
    grass.update(camera);
    forest.update(camera);
    clouds.update(camera);
    rain.update();
    sheep.update(dt, horseModel.root.position);
    particles.update(dt, camera);
    effects.update(dt, horse, horseModel.root, horseModel.nosePosition(nose), camera);
    particles.commit();
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
