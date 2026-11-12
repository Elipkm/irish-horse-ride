import { CELL, GRID, HALF, LEAF_SIZE, WATER_LEVEL, WORLD_SIZE, valleyAxis, type Heightfield } from './heightfield';
import type { LandmarkPlan } from './landmarkPlan';
import { createNoise2D, fbm, mulberry32 } from './noise';

export const SPECIES = ['oak', 'birch', 'pine', 'gorse'] as const;
export type Species = (typeof SPECIES)[number];

/** Trees are grouped in the same 64 m squares as the terrain's finest nodes. */
export const FOREST_CELL = LEAF_SIZE;
export const FOREST_CELLS = WORLD_SIZE / FOREST_CELL;

export interface Planting {
  count: number;
  /** Per plant, ordered by 64 m square. */
  species: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  scale: Float32Array;
  /** Turn about the vertical axis, radians. */
  turn: Float32Array;
  /** Random 0..1, for colour variation. */
  tone: Float32Array;
  /** Plants of square k (= row * FOREST_CELLS + column) are cellStart[k] .. cellStart[k + 1] - 1. */
  cellStart: Uint32Array;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Decides where every tree and bush stands. Woods clothe the lower valley sides and form a few
 * copses on the floor; birch gathers at wood edges and on damp ground, Scots pine takes over
 * higher up, gorse dots the open heath. The trail, the river, the lake shore, steep rock, the
 * landmark sites and the field walls are kept clear. Same result on every run.
 */
export function plantForest(field: Heightfield, landmarks: LandmarkPlan): Planting {
  const noise = createNoise2D(9001);
  const rand = mulberry32(4242);
  const { heightAt, control, normalAo, sites } = field;

  const at = (x: number, z: number) => {
    const i = Math.min(GRID - 1, Math.max(0, Math.round((x + HALF) / CELL)));
    const j = Math.min(GRID - 1, Math.max(0, Math.round((z + HALF) / CELL)));
    const k = (j * GRID + i) * 4;
    const nx = normalAo[k] / 127.5 - 1;
    const nz = normalAo[k + 1] / 127.5 - 1;
    return {
      path: control[k] / 255, // 1 on the trail centre line, 0 from 8 m away
      mud: control[k + 1] / 255,
      heath: control[k + 2] / 255,
      flatness: Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)), // 1 = level ground
    };
  };
  const clearings: [x: number, z: number, radius: number][] = [
    [sites.abbeyKnoll.x, sites.abbeyKnoll.z, 55],
    [sites.stoneCircleHill.x, sites.stoneCircleHill.z, 60],
    [sites.riverFord.x, sites.riverFord.z, 30],
    ...landmarks.clearings,
  ];
  /** 0 inside a landmark clearing, rising to 1 a little way outside it. */
  const open = (x: number, z: number) => {
    let f = 1;
    for (const [cx, cz, r] of clearings) f = Math.min(f, smoothstep(r, r * 1.5, Math.hypot(x - cx, z - cz)));
    return f;
  };

  const found: { s: number; x: number; y: number; z: number; scale: number }[] = [];
  const limit = HALF - 6;

  // ---- Trees: one candidate per 5 m square.
  const STEP = 5;
  for (let gz = -limit; gz < limit; gz += STEP) {
    for (let gx = -limit; gx < limit; gx += STEP) {
      const x = gx + rand() * STEP;
      const z = gz + rand() * STEP;
      const roll = rand();
      const pick = rand();
      const size = rand();

      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 0.8) continue;
      const g = at(x, z);
      if (g.path > 0.3 || g.mud > 0.45 || g.flatness < 0.82) continue;

      const rise = h - (14 - z * 0.008); // height above the valley floor
      const hillside = smoothstep(4, 22, rise) * (1 - smoothstep(75, 135, rise));
      const woods = fbm(noise, x / 240, z / 240, 3) + 0.42 * hillside - 0.2;
      const scattered = smoothstep(60, 140, rise) * 0.012; // lone pines on the open hill
      const density = (0.42 * smoothstep(0.0, 0.3, woods) + scattered) * open(x, z);
      if (roll > density) continue;

      // Species: pine with height; birch at the ragged edge of a wood and on damp ground; else oak.
      const pine = 0.06 + 0.85 * smoothstep(45, 115, rise);
      const birch = 0.22 + 0.4 * (1 - smoothstep(0.05, 0.4, woods)) + 0.3 * smoothstep(0.15, 0.4, g.mud);
      const s = pick < pine ? 2 : (pick - pine) / (1 - pine) < birch ? 1 : 0;
      if (landmarks.colliders.near(x, z, 1.8)) continue; // not on top of a field wall
      found.push({ s, x, y: h, z, scale: 0.72 + 0.56 * size * size + (s === 0 ? 0.12 * size : 0) });
    }
  }

  // ---- Gorse: clumps on heathy ground outside the woods.
  const BUSH_STEP = 4;
  for (let gz = -limit; gz < limit; gz += BUSH_STEP) {
    for (let gx = -limit; gx < limit; gx += BUSH_STEP) {
      const x = gx + rand() * BUSH_STEP;
      const z = gz + rand() * BUSH_STEP;
      const roll = rand();
      const size = rand();

      const h = heightAt(x, z);
      if (h < WATER_LEVEL + 0.6) continue;
      const g = at(x, z);
      if (g.path > 0.42 || g.mud > 0.4 || g.flatness < 0.74) continue;
      const clump = smoothstep(0.1, 0.5, fbm(noise, x / 45 + 300, z / 45, 2));
      const density = 0.3 * clump * smoothstep(0.4, 0.75, g.heath) * open(x, z);
      if (roll > density || landmarks.colliders.near(x, z, 1.2)) continue;
      found.push({ s: 3, x, y: h, z, scale: 0.7 + 0.8 * size });
    }
  }

  // ---- Order by 64 m square (counting sort).
  const cellOf = (p: { x: number; z: number }) =>
    Math.min(FOREST_CELLS - 1, Math.floor((p.z + HALF) / FOREST_CELL)) * FOREST_CELLS + Math.min(FOREST_CELLS - 1, Math.floor((p.x + HALF) / FOREST_CELL));
  const cellStart = new Uint32Array(FOREST_CELLS * FOREST_CELLS + 1);
  for (const p of found) cellStart[cellOf(p) + 1]++;
  for (let k = 0; k < FOREST_CELLS * FOREST_CELLS; k++) cellStart[k + 1] += cellStart[k];
  const next = cellStart.slice(0, -1);

  const count = found.length;
  const out: Planting = {
    count,
    species: new Uint8Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    scale: new Float32Array(count),
    turn: new Float32Array(count),
    tone: new Float32Array(count),
    cellStart,
  };
  for (const p of found) {
    const i = next[cellOf(p)]++;
    out.species[i] = p.s;
    out.x[i] = p.x;
    out.y[i] = p.y;
    out.z[i] = p.z;
    out.scale[i] = p.scale;
    out.turn[i] = rand() * Math.PI * 2;
    out.tone[i] = rand();
  }
  return out;
}
