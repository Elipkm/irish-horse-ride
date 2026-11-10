import * as THREE from 'three/webgpu';

// M1 skeleton: sky + ground + fps/memory overlay. Replace/extend per docs/horse_game_plan.md.
const hud = document.getElementById('hud')!;

type Backend = 'WebGPU' | 'WebGL2';

/**
 * WebGPU where the browser really provides it, otherwise WebGL2.
 * Add `?webgl` to the URL to force the WebGL2 path (for A/B fps checks on the iPad).
 */
async function createRenderer(): Promise<{ renderer: THREE.WebGPURenderer; backend: Backend }> {
  const make = async (forceWebGL: boolean) => {
    const r = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', forceWebGL });
    await r.init();
    return r;
  };

  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  let wantWebGPU = false;
  if (!forceWebGL && 'gpu' in navigator) {
    try {
      wantWebGPU = (await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter()) !== null;
    } catch {
      wantWebGPU = false;
    }
  }

  if (wantWebGPU) {
    try {
      const renderer = await make(false);
      const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
      return { renderer, backend: isWebGPU ? 'WebGPU' : 'WebGL2' };
    } catch (err) {
      console.warn('WebGPU init failed, falling back to WebGL2', err);
    }
  }
  return { renderer: await make(true), backend: 'WebGL2' };
}

async function start() {
  const { renderer, backend } = await createRenderer();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb4c4);
  scene.fog = new THREE.Fog(0xaebfca, 40, 400);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 3, 8);

  scene.add(new THREE.HemisphereLight(0xdfe9f0, 0x35502f, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.position.set(30, 40, 20);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x3f6b2f, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Placeholder "horse" marker so movement is visible later.
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 2.4), new THREE.MeshStandardMaterial({ color: 0x6b4a2f }));
  marker.position.y = 0.8;
  scene.add(marker);

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

  let last = performance.now();
  let frames = 0;
  let acc = 0;
  renderer.setAnimationLoop((now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    marker.rotation.y += dt * 0.3;
    camera.lookAt(marker.position);
    renderer.render(scene, camera);

    frames++;
    acc += dt;
    if (acc >= 0.5) {
      const { render, memory } = renderer.info;
      hud.textContent =
        `${Math.round(frames / acc)} fps | ${backend} | draw calls ${render.drawCalls} | tris ${Math.round(render.triangles)}` +
        ` | geo ${memory.geometries} tex ${memory.textures}${heapMB()} | build ${__BUILD__}`;
      frames = 0;
      acc = 0;
    }
  });
}

start().catch((err) => {
  console.error(err);
  hud.textContent = `Could not start renderer: ${err instanceof Error ? err.message : String(err)}`;
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
