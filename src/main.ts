import * as THREE from 'three/webgpu';
import { GameAudio } from './audio/gameAudio';
import { FollowCamera } from './camera/followCamera';
import { QUALITY_LEVELS, loadQualityIndex, saveQualityIndex } from './engine/quality';
import { createRenderer } from './engine/renderer';
import { Keyboard } from './input/keyboard';
import { TouchControls } from './input/touchControls';
import { TOP_SPEED } from './player/gaits';
import { GltfHorse } from './player/gltfHorse';
import { HorseController } from './player/horseController';
import { ProceduralHorse } from './player/proceduralHorse';
import { Objectives, type Waypoint } from './game/objectives';
import { loadSave, writeSave } from './game/save';
import { hud } from './ui/hud';
import { Beacon } from './world/beacon';
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
import { RIVER_HALF_WIDTH, RIVER_Z0, RIVER_Z1, generateHeightfield, riverX, valleyAxis } from './world/heightfield';
import { Particles } from './world/particles';
import { Rain } from './world/rain';
import { CloudLayer } from './world/sky';
import { Terrain } from './world/terrain';
import { Water } from './world/water';
import { Weather } from './world/weather';
import { windTime } from './world/wind';
import { GROUND_LAYERS, type GroundTextures } from './world/terrainMaterial';

// M8: sound (all made in code), places to find with a pointer and a column of light, stamina,
// photo mode, and a save that remembers where you were and what you have found.

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

  // ---- M8: sound, places to find, saved progress.
  const audio = new GameAudio();
  const bridge = plan.bridge;
  const bridgeCos = Math.cos(bridge.rot);
  const bridgeSin = Math.sin(bridge.rot);
  effects.onHoof = (kind, speed, landing) => audio.hoof(kind, speed, landing);
  effects.onBridge = (x, z) => {
    const dx = x - bridge.x;
    const dz = z - bridge.z;
    return Math.abs(dx * bridgeCos + dz * bridgeSin) <= bridge.halfLength && Math.abs(-dx * bridgeSin + dz * bridgeCos) <= bridge.halfWidth;
  };

  const waypoints: Waypoint[] = [
    { id: 'abbey', name: 'Ruined abbey', x: plan.abbey.x, z: plan.abbey.z, radius: 30 },
    { id: 'bridge', name: 'Old stone bridge', x: bridge.x, z: bridge.z, radius: 16 },
    { id: 'stones', name: 'Stone circle', x: field.sites.stoneCircleHill.x, z: field.sites.stoneCircleHill.z, radius: 16 },
    { id: 'cottage', name: 'Cottage by the lake', x: plan.cottages[2].x, z: plan.cottages[2].z, radius: 18 },
    { id: 'eastshore', name: 'Lake view', x: valleyAxis(400) + 212, z: 400, radius: 22 },
    { id: 'southshore', name: 'South shore', x: valleyAxis(672), z: 672, radius: 22 },
  ];
  const saved = loadSave();
  const objectives = new Objectives(waypoints, saved?.visited ?? []);
  const beacon = new Beacon();
  scene.add(beacon.mesh);
  const savedDistance = saved?.distance ?? 0;
  let photos = saved?.photos ?? 0;
  if (saved) horse.placeAt(saved.x, saved.z, saved.heading);
  const save = () => {
    writeSave({
      visited: [...objectives.visited],
      x: horseModel.root.position.x,
      z: horseModel.root.position.z,
      heading: horse.renderHeading,
      distance: savedDistance + horse.distance,
      photos,
    });
  };
  document.addEventListener('visibilitychange', () => document.hidden && save());
  window.addEventListener('pagehide', save);
  let saveIn = 5;

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
  hud.button('btn-sound', () => `Sound: ${audio.name}`, () => audio.next());
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

  // ---- Photo mode: HUD hidden, horse halted, camera free to drag round; the shutter saves a picture.
  let photoMode = false;
  let photoGait = 0;
  let capture = false;
  const setPhoto = (on: boolean) => {
    if (on === photoMode) return;
    photoMode = on;
    document.body.classList.toggle('photo', on);
    follow.photo = on;
    if (on) {
      photoGait = horse.gaitIndex;
      horse.setAutopilot(false);
      refreshAuto();
      setGait(0);
    } else {
      setGait(photoGait);
    }
  };
  const shutter = () => {
    capture = true;
  };
  const deliver = async (blob: Blob | null) => {
    if (!blob) return hud.toast('Could not take the photo');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const file = new File([blob], `irish-ride-${stamp}.jpg`, { type: 'image/jpeg' });
    photos++;
    save();
    // On the iPad the share sheet offers "Save Image"; elsewhere the file downloads.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Irish Horse Ride' });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return; // the rider closed the sheet
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    hud.toast('Photo saved to your downloads');
  };
  hud.button('btn-photo', () => 'Photo', () => setPhoto(true));
  document.getElementById('btn-shutter')!.addEventListener('click', shutter);
  document.getElementById('btn-photo-close')!.addEventListener('click', () => setPhoto(false));

  let objectiveIn = 0;
  hud.onObjectiveTap(() => {
    if (objectives.done) {
      if (confirm('Start the journey again? The places you have found are forgotten.')) objectives.reset();
    } else {
      objectives.cycle();
    }
    objectiveIn = 0;
  });

  const keys = new Keyboard();
  const click = (id: string) => () => document.getElementById(id)!.click();
  const gaitKey = (index: () => number) => () => setGait(index());
  keys.onPress(['KeyW', 'ArrowUp'], gaitKey(() => horse.gaitIndex + 1));
  keys.onPress(['KeyS', 'ArrowDown'], gaitKey(() => horse.gaitIndex - 1));
  ['KeyX', 'Digit1', 'Digit2', 'Digit3', 'Digit4'].forEach((code, i) => keys.onPress([code], gaitKey(() => i)));
  keys.onPress(['Space'], () => (photoMode ? shutter() : horse.jump()));
  keys.onPress(['Enter'], () => photoMode && shutter());
  keys.onPress(['KeyM'], click('btn-sound'));
  keys.onPress(['KeyC'], () => setPhoto(!photoMode));
  keys.onPress(['Escape'], () => photoMode && setPhoto(false));
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
  Object.assign(window, { __game: { renderer, scene, camera, terrain, field, environment, horse, horseModel, follow, touch, grass, forest, water, clouds, godRays, rain, particles, effects, weather, plan, landmarks, sheep, crows, audio, objectives, beacon } });

  let waterIn = 0;
  let wasExhausted = false;
  let shownStamina = -1;
  const look = new THREE.Vector3();
  /** 0..1: how close the nearest river bank / lake shore is (1 = at the water). */
  const waterNear = (x: number, z: number) => {
    let river = 0;
    if (z > RIVER_Z0 && z < RIVER_Z1) river = Math.max(0, (50 - Math.max(0, Math.abs(x - riverX(z)) - RIVER_HALF_WIDTH * 0.5)) / 50);
    let lake = 0;
    for (let a = 0; a < 8 && lake < 1; a++) {
      const dx = Math.cos((a / 8) * Math.PI * 2);
      const dz = Math.sin((a / 8) * Math.PI * 2);
      for (const r of [0, 10, 22, 40, 65]) {
        const sx = x + dx * r;
        const sz = z + dz * r;
        const inRiver = sz > RIVER_Z0 && sz < RIVER_Z1 - 30 && Math.abs(sx - riverX(sz)) < RIVER_HALF_WIDTH + 6;
        if (!inRiver && field.waterLevelAt(sx, sz) - field.heightAt(sx, sz) > 0.1) {
          lake = Math.max(lake, 1 - r / 80);
          break;
        }
      }
    }
    return { river, lake };
  };

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
    const steer = photoMode ? 0 : keys.steer() || touch.steer;
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

    // ---- M8 per frame: sound, places to find, stamina, saving.
    audio.speed01 = horse.speed / TOP_SPEED;
    waterIn -= dt;
    if (waterIn <= 0) {
      waterIn = 0.25;
      const w = waterNear(horseModel.root.position.x, horseModel.root.position.z);
      audio.nearRiver = w.river;
      audio.nearLake = w.lake;
    }
    audio.update(dt);

    const found = objectives.update(horseModel.root.position.x, horseModel.root.position.z);
    if (found) {
      hud.toast(
        objectives.done ? `Found: ${found.name}. You have found every place in the valley!` : `Found: ${found.name} (${objectives.visited.size} of ${waypoints.length})`,
        5000
      );
      save();
      objectiveIn = 0;
    }
    objectiveIn -= dt;
    if (objectiveIn <= 0) {
      objectiveIn = 0.1;
      objectives.ensureTarget(horseModel.root.position.x, horseModel.root.position.z);
      const target = objectives.current;
      if (target) {
        const dx = target.x - horseModel.root.position.x;
        const dz = target.z - horseModel.root.position.z;
        camera.getWorldDirection(look);
        // Angle from straight ahead (screen up), clockwise: right of the view is (-look.z, look.x).
        const bearing = Math.atan2(dx * -look.z + dz * look.x, dx * look.x + dz * look.z);
        const d = Math.hypot(dx, dz);
        const dist = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
        hud.setObjective(target.name, `${dist} · ${objectives.visited.size} of ${waypoints.length} found · tap for another`, (bearing * 180) / Math.PI);
        beacon.place({ x: target.x, y: field.heightAt(target.x, target.z), z: target.z });
      } else {
        hud.setObjective('All places found', 'Tap to start again', 0);
        beacon.place(null);
      }
    }
    if (horse.exhausted !== wasExhausted) {
      wasExhausted = horse.exhausted;
      if (wasExhausted) hud.toast('Your horse is out of breath: walk for a while to let it recover');
    }
    const staminaShown = Math.round(horse.stamina * 50);
    if (staminaShown !== shownStamina) {
      shownStamina = staminaShown;
      hud.setStamina(horse.stamina, horse.exhausted);
    }
    saveIn -= dt;
    if (saveIn <= 0) {
      saveIn = 5;
      save();
    }

    renderer.render(scene, camera);
    if (capture) {
      // Taken straight after the draw, while the picture is still on the canvas.
      capture = false;
      hud.flash();
      renderer.domElement.toBlob((blob) => void deliver(blob), 'image/jpeg', 0.92);
    }

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
