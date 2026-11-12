import * as THREE from 'three/webgpu';
import { createNoise2D, fbm, ridged } from './noise';

// The valley: a 2048 m square heightfield sampled every 2 m. The rideable valley floor is
// roughly 1.5 km long; the outer ~250 m on every side are the enclosing hills.
export const WORLD_SIZE = 2048;
export const HALF = WORLD_SIZE / 2;
export const CELL = 2;
export const GRID = WORLD_SIZE / CELL + 1; // 1025 samples per side
export const WATER_LEVEL = 8;
/** Smallest quadtree node, in metres and in cells. Used by the terrain LOD. */
export const LEAF_SIZE = 64;
export const LEAF_CELLS = LEAF_SIZE / CELL;
export const LOD_LEVELS = Math.log2(WORLD_SIZE / LEAF_SIZE) + 1; // 6: 64 m … 2048 m

const SEED = 1847;
const HILL_HEIGHT = 250;
const LAKE = { z: 380, rx: 150, rz: 230 };

/** Hand-placed spots, as [offset east of the valley centre line, z]. Later milestones build on these. */
const SITE_OFFSETS = {
  abbeyKnoll: [-205, -265],
  stoneCircleHill: [235, -150],
  riverFord: [42, -482],
} as const;

/** Trail loop around the valley, as [offset east of the valley centre line, z]. */
const TRAIL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-170, -620],
  [-215, -420],
  [-205, -265], // abbey knoll
  [-150, -60],
  [-205, 160],
  [-190, 380], // west lake shore
  [-150, 590],
  [0, 672], // south shore
  [160, 595],
  [212, 400], // east shore, slightly raised: lake view
  [240, 150],
  [235, -150], // stone circle hill
  [150, -380],
  [42, -482], // river ford (bridge site)
  [-90, -610],
];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** x of the valley centre line at a given z: a gentle S-curve. */
export const valleyAxis = (z: number) => 120 * Math.sin(z / 420) + 60 * Math.sin(z / 170 + 1.3);
/** x of the river at a given z: meanders inside the valley floor. */
export const riverX = (z: number) => valleyAxis(z) + 38 * Math.sin(z / 95) + 14 * Math.sin(z / 41 + 2);
/** 1 where the river exists (north slopes down to the lake), fading to 0 at both ends. */
const riverFade = (z: number) => smoothstep(-860, -780, z) * (1 - smoothstep(120, 190, z));
/**
 * The river's water runs from a spring at the foot of the valley head (RIVER_Z0) down to the lake;
 * its long profile is stored every RIVER_STEP metres. (Above the spring the channel is a dry gully.)
 */
export const RIVER_Z0 = -610;
export const RIVER_Z1 = 190;
export const RIVER_STEP = 2;
/** Water depth in the middle of the river channel, in metres. */
const RIVER_DEPTH = 0.6;
/** Beyond this distance from the river's centre line there is no river water. */
export const RIVER_HALF_WIDTH = 13;

export interface Heightfield {
  /** Heights in metres, row-major [z][x], GRID × GRID. Identical to what the GPU samples. */
  heights: Float32Array;
  /** Terrain height at any world position (bilinear, clamped to the map). */
  heightAt(x: number, z: number): number;
  /**
   * Height of the water surface at a world position: the river's surface near the river, the lake
   * level everywhere else. There is water where this is above heightAt().
   */
  waterLevelAt(x: number, z: number): number;
  /** River surface height every RIVER_STEP metres from RIVER_Z0 to RIVER_Z1 (never below the lake level). */
  riverSurface: Float32Array;
  /** Per quadtree level (0 = 64 m leaves): min and max height of every node, for culling. */
  nodeMin: Float32Array[];
  nodeMax: Float32Array[];
  heightTexture: THREE.DataTexture;
  /** RG = world normal x,z · B = baked ambient occlusion · A = 1 − tree shade (written by the forest). */
  normalAoTexture: THREE.DataTexture;
  /** The bytes behind normalAoTexture and controlTexture (4 per grid point), for placing things on the CPU. */
  normalAo: Uint8Array;
  control: Uint8Array;
  /** R = trail distance field · G = mud/wet · B = moss/heath · A = large-scale colour variation. */
  controlTexture: THREE.DataTexture;
  /** Closed riding trail on the terrain surface. */
  trail: THREE.CatmullRomCurve3;
  sites: Record<keyof typeof SITE_OFFSETS, THREE.Vector3>;
  lakeCentre: THREE.Vector3;
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function generateHeightfield(onProgress: (fraction: number) => void): Promise<Heightfield> {
  const noise = createNoise2D(SEED);
  const noiseB = createNoise2D(SEED + 101);
  const N = GRID;
  const heights = new Float32Array(N * N);
  const lakeX = valleyAxis(LAKE.z);

  // Lake outline: an ellipse with a wobbly edge. 1 = shoreline, <1 = in the water.
  const lakeE = (x: number, z: number) => {
    const ex = (x - lakeX) / LAKE.rx;
    const ez = (z - LAKE.z) / LAKE.rz;
    const e = Math.sqrt(ex * ex + ez * ez);
    return e > 2 ? e : e + 0.1 * noise(x / 70, z / 70);
  };

  // Gentle rounded bumps for the landmark sites.
  const knolls = (Object.values(SITE_OFFSETS).slice(0, 2) as ReadonlyArray<readonly [number, number]>).map(
    ([off, z], i) => ({ x: valleyAxis(z) + off, z, r: i === 0 ? 75 : 95, h: i === 0 ? 7 : 12 })
  );

  const baseHeight = (x: number, z: number) => {
    const d = Math.abs(x - valleyAxis(z));
    // U-shaped glacial valley: flat floor, steepening sides, rounded tops.
    const side = smoothstep(140, 880, d);
    const capN = smoothstep(600, 1000, -z); // closed, high valley head to the north
    const capS = smoothstep(640, 1000, z); // lower hills beyond the lake to the south
    const hill = 1 - (1 - side) * (1 - 0.88 * capN) * (1 - 0.36 * capS);

    let h = 14 - z * 0.008 + HILL_HEIGHT * hill;

    // Keep the river corridor and lake basin smooth so water can sit and flow in them.
    const dr = Math.abs(x - riverX(z));
    const rf = riverFade(z);
    const e = lakeE(x, z);
    const calm = Math.min(mix(1, smoothstep(4, 45, dr), rf), smoothstep(0.9, 1.5, e));

    h += 55 * (0.1 + 0.9 * hill) * fbm(noise, x / 700, z / 700, 3);
    h += 14 * (0.12 + 0.88 * hill) * fbm(noise, x / 180 + 40, z / 180, 4);
    h += 1.7 * calm * fbm(noiseB, x / 90, z / 90, 3); // rolling pasture
    h += 0.22 * calm * noiseB(x / 13, z / 13);
    if (hill > 0.04) h += 34 * hill * hill * (ridged(noiseB, x / 150, z / 150, 4) - 0.45); // rocky shoulders

    for (const k of knolls) {
      const q = Math.hypot(x - k.x, z - k.z) / k.r;
      if (q < 1) h += k.h * (1 - smoothstep(0.25, 1, q));
    }

    // River channel.
    if (rf > 0) h -= 1.7 * rf * Math.exp(-(dr * dr) / 30);

    // Lake basin: bowl below the water line, gentle beach above it.
    if (e < 1.4) {
      const bowl = e < 1 ? WATER_LEVEL - 0.3 - 6.5 * (1 - e * e) : WATER_LEVEL - 0.3 + (e - 1) * 9;
      h = mix(h, bowl, 1 - smoothstep(1.0, 1.4, e));
    }
    return h;
  };

  for (let j = 0; j < N; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < N; i++) heights[j * N + i] = baseHeight(-HALF + i * CELL, z);
    if (j % 48 === 0) {
      onProgress((0.7 * j) / N);
      await nextTick();
    }
  }

  const idx = (i: number, j: number) => Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i));
  const heightAt = (x: number, z: number) => {
    const gx = Math.min(N - 1, Math.max(0, (x + HALF) / CELL));
    const gz = Math.min(N - 1, Math.max(0, (z + HALF) / CELL));
    const i = Math.min(N - 2, Math.floor(gx));
    const j = Math.min(N - 2, Math.floor(gz));
    const fx = gx - i;
    const fz = gz - j;
    const a = heights[j * N + i];
    const b = heights[j * N + i + 1];
    const c = heights[(j + 1) * N + i];
    const d = heights[(j + 1) * N + i + 1];
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };

  // --- River: water must never run uphill. Take the bed's height along the river, smooth it, force
  // it to fall all the way to the lake, and cut the channel down to that line where the ground rises.
  const riverN = (RIVER_Z1 - RIVER_Z0) / RIVER_STEP + 1;
  const riverBed = new Float32Array(riverN);
  const riverSurface = new Float32Array(riverN);
  {
    const raw = new Float32Array(riverN);
    for (let k = 0; k < riverN; k++) {
      const z = RIVER_Z0 + k * RIVER_STEP;
      raw[k] = heightAt(riverX(z), z);
    }
    for (let k = 0; k < riverN; k++) {
      let sum = 0;
      let n = 0;
      for (let o = -4; o <= 4; o++) {
        if (k + o < 0 || k + o >= riverN) continue;
        sum += raw[k + o];
        n++;
      }
      // Low enough that the water stays between its banks, also where the ground flattens out near the lake.
      const z = RIVER_Z0 + k * RIVER_STEP;
      const x = riverX(z);
      const banks = Math.min(heightAt(x - RIVER_HALF_WIDTH, z), heightAt(x + RIVER_HALF_WIDTH, z), heightAt(x - 8, z), heightAt(x + 8, z));
      const smooth = Math.min(raw[k], sum / n, banks - 0.2 - RIVER_DEPTH);
      riverBed[k] = k === 0 ? smooth : Math.min(smooth, riverBed[k - 1] - 0.003 * RIVER_STEP);
      const surface = riverBed[k] + RIVER_DEPTH * smoothstep(RIVER_Z0, RIVER_Z0 + 50, RIVER_Z0 + k * RIVER_STEP);
      riverSurface[k] = Math.max(WATER_LEVEL, k === 0 ? surface : Math.min(surface, riverSurface[k - 1]));
    }
    for (let j = 0; j < N; j++) {
      const z = -HALF + j * CELL;
      if (z < RIVER_Z0 || z > RIVER_Z1) continue;
      const bed = riverBed[Math.round((z - RIVER_Z0) / RIVER_STEP)];
      if (bed + RIVER_DEPTH < WATER_LEVEL) continue; // from here on it is the lake
      const rf = riverFade(z);
      const rx = riverX(z);
      const i0 = Math.max(0, Math.floor((rx - 60 + HALF) / CELL));
      const i1 = Math.min(N - 1, Math.ceil((rx + 60 + HALF) / CELL));
      for (let i = i0; i <= i1; i++) {
        const dr = Math.abs(-HALF + i * CELL - rx);
        // Channel cross-section, then a gentle bank the horse can walk down where the cut is deep.
        const target = bed + 1.7 * Math.max(rf, 0.6) * (1 - Math.exp(-(dr * dr) / 30)) + 0.2 * Math.max(0, dr - 9);
        if (target < heights[j * N + i]) heights[j * N + i] = target;
      }
    }
  }
  const waterLevelAt = (x: number, z: number) => {
    if (z <= RIVER_Z0 || z >= RIVER_Z1 || Math.abs(x - riverX(z)) > RIVER_HALF_WIDTH) return WATER_LEVEL;
    const g = (z - RIVER_Z0) / RIVER_STEP;
    const k = Math.min(riverN - 2, Math.floor(g));
    return riverSurface[k] + (riverSurface[k + 1] - riverSurface[k]) * (g - k);
  };

  // --- Trail: lay the loop on the ground, cut a slight bench into slopes, record a distance field.
  const flatCurve = new THREE.CatmullRomCurve3(
    TRAIL_OFFSETS.map(([off, z]) => new THREE.Vector3(valleyAxis(z) + off, 0, z)),
    true,
    'centripetal'
  );
  const samples = flatCurve.getSpacedPoints(Math.ceil(flatCurve.getLength()));
  samples.pop(); // closed curve: last point repeats the first
  const centre = samples.map((p) => heightAt(p.x, p.z));
  const smoothed = centre.map((_, s) => {
    let sum = 0;
    for (let o = -6; o <= 6; o++) sum += centre[(s + o + centre.length) % centre.length];
    return sum / 13;
  });
  const pathDist = new Float32Array(N * N).fill(1e9);
  samples.forEach((p, s) => {
    const ci = Math.round((p.x + HALF) / CELL);
    const cj = Math.round((p.z + HALF) / CELL);
    for (let j = cj - 5; j <= cj + 5; j++) {
      for (let i = ci - 5; i <= ci + 5; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const dist = Math.hypot(-HALF + i * CELL - p.x, -HALF + j * CELL - p.z);
        const k = j * N + i;
        if (dist < pathDist[k]) pathDist[k] = dist;
        const w = 1 - smoothstep(1.2, 4.2, dist);
        if (w > 0) heights[k] = mix(heights[k], smoothed[s], w * 0.5);
      }
    }
  });
  onProgress(0.74);
  await nextTick();

  // --- The GPU stores heights as 16-bit floats. Round the CPU copy the same way so that
  // heightAt() matches the rendered ground exactly (hooves must not float or sink).
  const half = new Uint16Array(N * N);
  for (let k = 0; k < N * N; k++) {
    half[k] = THREE.DataUtils.toHalfFloat(heights[k]);
    heights[k] = THREE.DataUtils.fromHalfFloat(half[k]);
  }

  // --- Normals and baked ambient occlusion.
  const normalAo = new Uint8Array(N * N * 4);
  const normalY = new Float32Array(N * N);
  const AO_DIRS = 8;
  const AO_RADII = [3, 9, 24]; // in cells: 6 m, 18 m, 48 m
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const h = heights[k];
      const nx = (heights[idx(i - 1, j)] - heights[idx(i + 1, j)]) / (2 * CELL);
      const nz = (heights[idx(i, j - 1)] - heights[idx(i, j + 1)]) / (2 * CELL);
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      normalY[k] = inv;

      // Horizon-based occlusion: how much of the sky do nearby slopes hide?
      let occlusion = 0;
      for (let a = 0; a < AO_DIRS; a++) {
        const ang = (a / AO_DIRS) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dz = Math.sin(ang);
        let maxTan = 0;
        for (const r of AO_RADII) {
          const t = (heights[idx(Math.round(i + dx * r), Math.round(j + dz * r))] - h) / (r * CELL);
          if (t > maxTan) maxTan = t;
        }
        occlusion += maxTan / Math.sqrt(1 + maxTan * maxTan); // sin of the horizon angle
      }
      const ao = Math.max(0, 1 - 1.15 * (occlusion / AO_DIRS));

      normalAo[k * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normalAo[k * 4 + 1] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      normalAo[k * 4 + 2] = Math.round(ao * 255);
      normalAo[k * 4 + 3] = 255;
    }
    if (j % 96 === 0) {
      onProgress(0.74 + (0.13 * j) / N);
      await nextTick();
    }
  }

  // --- Ground-cover control map.
  const control = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const z = -HALF + j * CELL;
    const rf = riverFade(z);
    const rx = riverX(z);
    for (let i = 0; i < N; i++) {
      const x = -HALF + i * CELL;
      const k = j * N + i;
      const h = heights[k];
      const flat = smoothstep(0.955, 0.995, normalY[k]);
      const upland = smoothstep(30, 110, h - (14 - z * 0.008));

      const dr = x - rx;
      const e = lakeE(x, z);
      const riverMud = rf * Math.exp(-(dr * dr) / 55);
      const shoreMud = Math.exp(-((e - 1.03) * (e - 1.03)) / 0.006);
      const bog = flat * (1 - upland) * smoothstep(0.3, 0.62, fbm(noiseB, x / 140 + 9, z / 140, 2));
      const underwater = h < waterLevelAt(x, z) ? 1 : 0;
      const mud = Math.max(riverMud, shoreMud, bog * 0.5, underwater);

      const heath = Math.max(
        bog * 0.75, // boggy ground reads as dark, mossy green rather than bare mud
        smoothstep(0.08, 0.5, upland) * smoothstep(-0.35, 0.45, fbm(noise, x / 170 + 50, z / 170, 3)),
        0.6 * (1 - flat) * smoothstep(0.0, 0.5, noiseB(x / 60, z / 60))
      );

      control[k * 4] = Math.round(255 * Math.max(0, 1 - pathDist[k] / 8));
      control[k * 4 + 1] = Math.round(255 * Math.min(1, mud));
      control[k * 4 + 2] = Math.round(255 * Math.min(1, heath));
      control[k * 4 + 3] = Math.round(255 * (0.5 + 0.5 * fbm(noise, x / 62 - 20, z / 62 + 7, 2)));
    }
    if (j % 96 === 0) {
      onProgress(0.87 + (0.11 * j) / N);
      await nextTick();
    }
  }

  // --- Min/max height per quadtree node (level 0 = 64 m leaves, top level = whole map).
  const nodeMin: Float32Array[] = [];
  const nodeMax: Float32Array[] = [];
  const leaves = WORLD_SIZE / LEAF_SIZE;
  {
    const mn = new Float32Array(leaves * leaves);
    const mx = new Float32Array(leaves * leaves);
    for (let nj = 0; nj < leaves; nj++) {
      for (let ni = 0; ni < leaves; ni++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = nj * LEAF_CELLS; j <= (nj + 1) * LEAF_CELLS; j++) {
          for (let i = ni * LEAF_CELLS; i <= (ni + 1) * LEAF_CELLS; i++) {
            const h = heights[j * N + i];
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        mn[nj * leaves + ni] = lo;
        mx[nj * leaves + ni] = hi;
      }
    }
    nodeMin.push(mn);
    nodeMax.push(mx);
  }
  for (let level = 1; level < LOD_LEVELS; level++) {
    const n = leaves >> level;
    const below = n * 2;
    const mn = new Float32Array(n * n);
    const mx = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * 2 * below + i * 2;
        const b = a + below;
        mn[j * n + i] = Math.min(nodeMin[level - 1][a], nodeMin[level - 1][a + 1], nodeMin[level - 1][b], nodeMin[level - 1][b + 1]);
        mx[j * n + i] = Math.max(nodeMax[level - 1][a], nodeMax[level - 1][a + 1], nodeMax[level - 1][b], nodeMax[level - 1][b + 1]);
      }
    }
    nodeMin.push(mn);
    nodeMax.push(mx);
  }

  // --- Textures.
  const heightTexture = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
  heightTexture.minFilter = heightTexture.magFilter = THREE.LinearFilter;
  heightTexture.needsUpdate = true;

  const dataTexture = (data: Uint8Array<ArrayBuffer>) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  const onGround = (x: number, z: number, lift = 0) => new THREE.Vector3(x, heightAt(x, z) + lift, z);
  const trail = new THREE.CatmullRomCurve3(
    samples.filter((_, s) => s % 6 === 0).map((p) => onGround(p.x, p.z)),
    true,
    'centripetal'
  );
  const sites = Object.fromEntries(
    Object.entries(SITE_OFFSETS).map(([name, [off, z]]) => [name, onGround(valleyAxis(z) + off, z)])
  ) as Heightfield['sites'];

  onProgress(1);
  return {
    heights,
    heightAt,
    waterLevelAt,
    riverSurface,
    nodeMin,
    nodeMax,
    heightTexture,
    normalAoTexture: dataTexture(normalAo),
    controlTexture: dataTexture(control),
    normalAo,
    control,
    trail,
    sites,
    lakeCentre: new THREE.Vector3(lakeX, WATER_LEVEL, LAKE.z),
  };
}
