import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import { mulberry32 } from './noise';
import { windTime } from './wind';

type Vec2Node = ReturnType<typeof vec2>;

// Values shared by everything the weather touches. world/weather.ts drives them; the ground, the
// water, the sky, the rain and the light shafts read them.

/** 0 = dry, 1 = steady light rain. */
export const rainAmount = uniform(0);
/** How wet the ground is, 0..1. Lags behind the rain: soaks in seconds, dries in minutes. */
export const groundWet = uniform(0);
/** 0 = broken cloud with sun between, 1 = closed grey sky. */
export const overcast = uniform(0);
/** Brightness of sky, fog and reflections relative to the clear default. */
export const skyDim = uniform(1);

/** Time of day (world/timeOfDay.ts): multipliers the weather applies on top of its own values. */
export const tod = { dim: 1, sunMul: 1 };
/** Colour the fog takes on at golden hour, dusk and dawn (white = unchanged). */
export const fogTint = uniform(new THREE.Color(1, 1, 1));
/** Colour grade applied to the whole picture by the post effects (white = unchanged). */
export const gradeTint = uniform(new THREE.Color(1, 1, 1));

/** Height of the cloud layer above the lake, in metres. */
export const CLOUD_HEIGHT = 700;
/** Horizontal offset from a spot on the ground to the cloud that shades it. Set once the sun's direction is known. */
export const cloudShadowShift = uniform(new THREE.Vector2());

const SIZE = 256;

/**
 * One small repeating noise picture used all over: water ripples, foam, clouds, light shafts.
 * R, G = slope of a ripple surface (0.5 = level) · B = soft cloudy noise · A = a second, unrelated one.
 * Built from waves that fit the square a whole number of times, so it repeats without a seam.
 */
function createNoiseTexture(): THREE.DataTexture {
  const rand = mulberry32(90210);
  const cosT = new Float32Array(SIZE);
  const sinT = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    cosT[i] = Math.cos((i / SIZE) * Math.PI * 2);
    sinT[i] = Math.sin((i / SIZE) * Math.PI * 2);
  }
  /** Sum of waves; returns height and its two slopes per pixel. `sharp` keeps more of the fine waves. */
  const field = (octaves: number, sharp: number) => {
    const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];
    for (let o = 0; o < octaves; o++) {
      for (let w = 0; w < 7; w++) {
        const k = 2 ** o * (1 + rand());
        const a = rand() * Math.PI * 2;
        const kx = Math.round(k * Math.cos(a));
        const ky = Math.round(k * Math.sin(a));
        if (kx === 0 && ky === 0) continue;
        waves.push({ kx, ky, amp: Math.hypot(kx, ky) ** -sharp, phase: Math.floor(rand() * SIZE) });
      }
    }
    const h = new Float32Array(SIZE * SIZE);
    const dx = new Float32Array(SIZE * SIZE);
    const dy = new Float32Array(SIZE * SIZE);
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        let sh = 0;
        let sx = 0;
        let sy = 0;
        for (const w of waves) {
          const t = (((w.kx * i + w.ky * j + w.phase) % SIZE) + SIZE) % SIZE;
          sh += w.amp * cosT[t];
          sx -= w.amp * w.kx * sinT[t];
          sy -= w.amp * w.ky * sinT[t];
        }
        h[j * SIZE + i] = sh;
        dx[j * SIZE + i] = sx;
        dy[j * SIZE + i] = sy;
      }
    }
    return { h, dx, dy };
  };
  const to01 = (v: Float32Array) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return (x: number) => (x - lo) / (hi - lo);
  };
  const ripple = field(5, 1.25);
  const cloudA = field(5, 1.1);
  const cloudB = field(5, 0.9);
  let steepest = 0;
  for (let k = 0; k < SIZE * SIZE; k++) steepest = Math.max(steepest, Math.abs(ripple.dx[k]), Math.abs(ripple.dy[k]));
  const a01 = to01(cloudA.h);
  const b01 = to01(cloudB.h);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let k = 0; k < SIZE * SIZE; k++) {
    data[k * 4] = Math.round(255 * (0.5 + (0.5 * ripple.dx[k]) / steepest));
    data[k * 4 + 1] = Math.round(255 * (0.5 + (0.5 * ripple.dy[k]) / steepest));
    data[k * 4 + 2] = Math.round(255 * a01(cloudA.h[k]));
    data[k * 4 + 3] = Math.round(255 * b01(cloudB.h[k]));
  }
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export const noiseTexture = createNoiseTexture();

/**
 * How much cloud is overhead at a point of the cloud layer (world x, z), 0..1. Clouds drift with
 * the wind. The sky draws this and the ground is shaded by it, so shadows match the clouds above.
 */
export function cloudCover(xz: Vec2Node) {
  const p = xz.sub(vec2(0.82, 0.57).mul(windTime.mul(7))); // 7 m/s, the way the wind blows
  const broad = texture(noiseTexture, p.div(2600)).level(0).b;
  const fine = texture(noiseTexture, vec2(p.y, p.x.negate()).div(890).add(0.37)).level(0).a;
  const n = broad.mul(0.62).add(fine.mul(0.38));
  const edge = mix(float(0.5), float(0.16), overcast);
  return smoothstep(edge, edge.add(0.24), n);
}

/** Brightness of the ground at world (x, z) under the drifting clouds: sunny patches and cloud shadows. */
export function cloudShade(xz: Vec2Node) {
  const patchy = mix(float(1.08), float(0.74), cloudCover(xz.add(cloudShadowShift)));
  return mix(patchy, float(0.86), overcast);
}
