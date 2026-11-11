// Seeded 2D simplex noise plus fractal helpers. Deterministic: the same seed always gives the same valley.

export type Noise2D = (x: number, y: number) => number;

/** Small seeded random number generator: returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
// 12 gradient directions, stored flat as x,y pairs.
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);

/** Simplex noise in roughly [-1, 1]. */
export function createNoise2D(seed: number): Noise2D {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return (x, y) => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) {
      const g = (perm[ii + perm[jj]] % 12) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) {
      const g = (perm[ii + i1 + perm[jj + j1]] % 12) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) {
      const g = (perm[ii + 1 + perm[jj + 1]] % 12) * 2;
      a *= a;
      n += a * a * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n;
  };
}

/** Fractal Brownian motion: summed octaves, result roughly in [-1, 1]. */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    // Offset each octave so their zero-crossings do not line up at the origin.
    sum += amp * noise(x * f + o * 17.31, y * f - o * 9.17);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1]: sharp crests, good for rocky outcrops. */
export function ridged(noise: Noise2D, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(noise(x * f + o * 31.7, y * f + o * 12.9));
    sum += amp * r * r;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
