import * as THREE from 'three/webgpu';
import { fogTint, gradeTint, tod } from './atmosphere';
import type { Environment } from './environment';

// The sky is one fixed photograph, so the sun cannot travel across it. The time of day changes the
// mood instead: how bright the light is, its colour, the colour of the mist, and (with the post
// effects on) a colour grade over the whole picture.

export const TIMES = ['Day', 'Golden hour', 'Dusk', 'Dawn'] as const;

interface Preset {
  /** Brightness of sky, mist and reflections. */
  dim: number;
  sunMul: number;
  sun: [number, number, number];
  mist: [number, number, number];
  grade: [number, number, number];
  exposure: number;
}

const PRESETS: Preset[] = [
  { dim: 1, sunMul: 1, sun: [1, 1, 1], mist: [1, 1, 1], grade: [1, 1, 1], exposure: 1 },
  { dim: 0.9, sunMul: 1.35, sun: [1, 0.7, 0.4], mist: [1.2, 0.92, 0.65], grade: [1.14, 0.97, 0.78], exposure: 1.05 },
  { dim: 0.5, sunMul: 0.3, sun: [1, 0.5, 0.45], mist: [0.95, 0.72, 0.85], grade: [0.86, 0.86, 1.1], exposure: 0.9 },
  { dim: 0.78, sunMul: 0.7, sun: [1, 0.78, 0.68], mist: [1.05, 0.9, 0.98], grade: [1.06, 0.95, 1.06], exposure: 0.95 },
];

const KEY = 'horse.time';
const BASE_EXPOSURE = 0.5;

/** Moves smoothly from one mood to the next (about six seconds). */
export class TimeOfDay {
  index = 0;
  private readonly now = { ...PRESETS[0], sun: [...PRESETS[0].sun], mist: [...PRESETS[0].mist], grade: [...PRESETS[0].grade] } as Preset;
  private readonly sunBase: THREE.Color;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly environment: Environment
  ) {
    this.sunBase = environment.sun.color.clone();
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (Number.isInteger(saved) && saved >= 0 && saved < TIMES.length) this.index = saved;
    } catch {
      // Default time.
    }
    this.update(100); // start in the saved mood outright
  }

  get name() {
    return TIMES[this.index];
  }

  next() {
    this.index = (this.index + 1) % TIMES.length;
    try {
      localStorage.setItem(KEY, String(this.index));
    } catch {
      // Not fatal.
    }
  }

  update(dt: number) {
    const to = PRESETS[this.index];
    const k = 1 - Math.exp(-dt / 2);
    const n = this.now;
    const ease = (a: number, b: number) => a + (b - a) * k;
    n.dim = ease(n.dim, to.dim);
    n.sunMul = ease(n.sunMul, to.sunMul);
    n.exposure = ease(n.exposure, to.exposure);
    for (let i = 0; i < 3; i++) {
      n.sun[i] = ease(n.sun[i], to.sun[i]);
      n.mist[i] = ease(n.mist[i], to.mist[i]);
      n.grade[i] = ease(n.grade[i], to.grade[i]);
    }
    tod.dim = n.dim;
    tod.sunMul = n.sunMul;
    fogTint.value.setRGB(n.mist[0], n.mist[1], n.mist[2]);
    gradeTint.value.setRGB(n.grade[0], n.grade[1], n.grade[2]);
    this.environment.sun.color.setRGB(this.sunBase.r * n.sun[0], this.sunBase.g * n.sun[1], this.sunBase.b * n.sun[2]);
    this.renderer.toneMappingExposure = BASE_EXPOSURE * n.exposure;
  }
}
