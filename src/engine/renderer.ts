import * as THREE from 'three/webgpu';

export type Backend = 'WebGPU' | 'WebGL2';

/**
 * WebGPU where the browser really provides it, otherwise WebGL2.
 * Add `?webgl` to the URL to force the WebGL2 path (for A/B fps checks on the iPad).
 */
export async function createRenderer(): Promise<{ renderer: THREE.WebGPURenderer; backend: Backend }> {
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
