import * as THREE from 'three/webgpu';
import { groundWet, overcast, rainAmount, skyDim } from './atmosphere';
import type { Environment } from './environment';
import { windStrength } from './wind';

export const WEATHERS = ['Misty sun', 'Rain'] as const;

const KEY = 'horse.weather';
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (from: number, to: number, perSecond: number, dt: number) => from + Math.min(Math.max(to - from, -perSecond * dt), perSecond * dt);

/**
 * The weather: misty sun (the default mood) or light rain. Changing it is gradual: the cloud closes
 * over, the light goes grey and flat, the mist thickens, the wind picks up, then the rain starts and
 * the ground slowly gets wet. Everything that reacts reads the shared values in atmosphere.ts.
 */
export class Weather {
  /** Index into WEATHERS. */
  index = 0;
  /** 0 = fully misty sun, 1 = fully rain; moves towards the chosen weather. */
  private blend = 0;
  private readonly sunIntensity: number;
  private readonly baseFog: number;
  private readonly mistFog: number;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly environment: Environment
  ) {
    this.sunIntensity = environment.sun.intensity;
    this.baseFog = environment.fog.baseDensity.value;
    this.mistFog = environment.fog.mistDensity.value;
    try {
      if (localStorage.getItem(KEY) === '1') this.index = 1;
    } catch {
      // Storage can be unavailable (private mode): start with the default weather.
    }
    // Start in the saved weather outright rather than drifting into it.
    this.blend = this.index;
    groundWet.value = this.index;
    this.apply(0);
  }

  get name() {
    return WEATHERS[this.index];
  }

  next() {
    this.index = (this.index + 1) % WEATHERS.length;
    try {
      localStorage.setItem(KEY, String(this.index));
    } catch {
      // Not fatal: the choice just will not persist.
    }
  }

  update(dt: number) {
    this.blend = approach(this.blend, this.index, 1 / 9, dt); // about nine seconds to change over
    this.apply(dt);
  }

  private apply(dt: number) {
    const b = this.blend;
    const closing = Math.min(1, b * 1.6); // the sky closes first…
    const falling = Math.max(0, b * 2.2 - 1.2); // …the rain follows
    overcast.value = closing;
    rainAmount.value = falling;
    skyDim.value = lerp(1, 0.6, closing);
    windStrength.value = lerp(1, 1.7, b);
    // Soaks in about 15 s of rain, dries over a couple of minutes.
    groundWet.value = approach(groundWet.value, falling > 0.3 ? 1 : 0, falling > 0.3 ? 1 / 15 : 1 / 120, dt);

    const { sun, fog } = this.environment;
    sun.intensity = this.sunIntensity * lerp(1, 0.12, closing);
    fog.baseDensity.value = this.baseFog * lerp(1, 3.2, b);
    fog.mistDensity.value = this.mistFog * lerp(1, 1.5, b);
    this.scene.backgroundIntensity = skyDim.value;
    this.scene.environmentIntensity = lerp(1, 0.7, closing);
  }
}
