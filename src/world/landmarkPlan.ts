import { CELL, GRID, HALF, riverX, valleyAxis, type Heightfield } from './heightfield';
import { createNoise2D, mulberry32 } from './noise';

// Where every landmark stands, and what is solid. Worked out from the terrain alone, before the
// forest is planted (trees keep clear of walls and buildings) and before any mesh is built.

/** A thing standing on the ground: local x runs along (cos, sin) of `rot`, local z across it. */
export interface Placement {
  x: number;
  z: number;
  /** Ground height the thing is built up from. */
  y: number;
  rot: number;
}

export interface WallPiece {
  points: { x: number; y: number; z: number }[];
  /** The piece ends at a gap for the trail here: build a gate pillar. */
  pillarAtStart: boolean;
  pillarAtEnd: boolean;
}

export interface BridgeFrame extends Placement {
  /** Half the length along the trail, half the width across it. */
  halfLength: number;
  halfWidth: number;
  /** Height of the road surface at distance s along the bridge (-halfLength..halfLength). */
  deckAt(s: number): number;
  /** Lowest ground under the bridge and the river's level there. */
  bed: number;
  water: number;
}

export interface LandmarkPlan {
  walls: WallPiece[];
  /** `side` is +1 or -1: the side (in local z) of the nave that faces away from the trail. */
  abbey: Placement & { side: number };
  tower: Placement;
  cross: Placement;
  stones: (Placement & { height: number; lying: boolean })[];
  cottages: Placement[];
  bridge: BridgeFrame;
  colliders: Colliders;
  /** Circles to keep free of trees: x, z, radius. */
  clearings: [number, number, number][];
}

// Sizes shared with the mesh builder (world/landmarks.ts).
export const WALL_HEIGHT = 0.95;
export const ABBEY = { length: 24, width: 9, thick: 0.9, wallHeight: 7, gableHeight: 11.5 };
export const TOWER = { radius: 3, height: 26 };
export const COTTAGE = { length: 9, width: 5.2, wallHeight: 2.5 };
export const CIRCLE_RADIUS = 10;

interface Box {
  x: number;
  z: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  /** Height of its top. */
  top: number;
  /** Low enough to jump. */
  low: boolean;
}

const GRID_CELL = 16;
const GRID_CELLS = Math.ceil((HALF * 2) / GRID_CELL);

/** Everything solid that was built: walls, buildings, standing stones. Boxes on a coarse grid. */
export class Colliders {
  private readonly boxes: Box[] = [];
  private readonly cells = new Map<number, number[]>();

  /** A box centred on (x, z), `length` along the direction `rot`, `width` across it. */
  add(x: number, z: number, length: number, width: number, rot: number, top: number, low = false) {
    const box: Box = { x, z, hx: length / 2, hz: width / 2, cos: Math.cos(rot), sin: Math.sin(rot), top, low };
    const index = this.boxes.push(box) - 1;
    const reach = Math.hypot(box.hx, box.hz);
    for (let j = this.cell(z - reach); j <= this.cell(z + reach); j++) {
      for (let i = this.cell(x - reach); i <= this.cell(x + reach); i++) {
        const key = j * GRID_CELLS + i;
        const list = this.cells.get(key);
        if (list) list.push(index);
        else this.cells.set(key, [index]);
      }
    }
  }

  /** Moves a circle at `p` out of anything solid; true if it had to. A horse `clearance` metres off the ground clears low walls. */
  pushOut(p: { x: number; z: number }, radius: number, clearance = 0): boolean {
    let hit = false;
    for (let j = this.cell(p.z - radius); j <= this.cell(p.z + radius); j++) {
      for (let i = this.cell(p.x - radius); i <= this.cell(p.x + radius); i++) {
        const list = this.cells.get(j * GRID_CELLS + i);
        if (!list) continue;
        for (const index of list) {
          const b = this.boxes[index];
          if (b.low && clearance > 0.55) continue;
          const dx = p.x - b.x;
          const dz = p.z - b.z;
          let lx = dx * b.cos + dz * b.sin;
          let lz = -dx * b.sin + dz * b.cos;
          const px = b.hx + radius - Math.abs(lx);
          const pz = b.hz + radius - Math.abs(lz);
          if (px <= 0 || pz <= 0) continue;
          // Out through the nearer face.
          if (px < pz) lx = Math.sign(lx || 1) * (b.hx + radius);
          else lz = Math.sign(lz || 1) * (b.hz + radius);
          p.x = b.x + lx * b.cos - lz * b.sin;
          p.z = b.z + lx * b.sin + lz * b.cos;
          hit = true;
        }
      }
    }
    return hit;
  }

  /** Top of whatever tall thing stands at (x, z), or -Infinity. Used to keep the camera from looking through buildings. */
  topAt(x: number, z: number): number {
    const list = this.cells.get(this.cell(z) * GRID_CELLS + this.cell(x));
    let top = -Infinity;
    if (!list) return top;
    for (const index of list) {
      const b = this.boxes[index];
      if (b.low) continue;
      const dx = x - b.x;
      const dz = z - b.z;
      if (Math.abs(dx * b.cos + dz * b.sin) <= b.hx + 0.3 && Math.abs(-dx * b.sin + dz * b.cos) <= b.hz + 0.3) top = Math.max(top, b.top);
    }
    return top;
  }

  /** Is anything solid within `margin` metres of (x, z)? */
  near(x: number, z: number, margin: number): boolean {
    const probe = { x, z };
    return this.pushOut(probe, margin);
  }

  private cell(v: number) {
    return Math.min(GRID_CELLS - 1, Math.max(0, Math.floor((v + HALF) / GRID_CELL)));
  }
}

export function planLandmarks(field: Heightfield): LandmarkPlan {
  const { heightAt, waterLevelAt, control, normalAo, sites, trail } = field;
  const noise = createNoise2D(5150);
  const rand = mulberry32(1916);
  const colliders = new Colliders();

  const at = (x: number, z: number) => {
    const i = Math.min(GRID - 1, Math.max(0, Math.round((x + HALF) / CELL)));
    const j = Math.min(GRID - 1, Math.max(0, Math.round((z + HALF) / CELL)));
    const k = (j * GRID + i) * 4;
    const nx = normalAo[k] / 127.5 - 1;
    const nz = normalAo[k + 1] / 127.5 - 1;
    return { path: control[k] / 255, flatness: Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)) };
  };
  /** Trail direction (unit, level) at the trail point nearest to (x, z), and that point. */
  const trailNear = (x: number, z: number) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < 1200; i++) {
      const p = trail.getPointAt(i / 1200);
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i / 1200;
      }
    }
    const p = trail.getPointAt(best);
    const t = trail.getTangentAt(best);
    const len = Math.hypot(t.x, t.z) || 1;
    return { x: p.x, z: p.z, tx: t.x / len, tz: t.z / len };
  };
  /** Ground under a footprint: the mean of its middle and four corners. */
  const groundUnder = (x: number, z: number, rot: number, length: number, width: number) => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let sum = heightAt(x, z);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = (a * length) / 2;
      const lz = (b * width) / 2;
      sum += heightAt(x + lx * c - lz * s, z + lx * s + lz * c);
    }
    return sum / 5;
  };
  /** Local (lx, lz) of a placement to world. */
  const toWorld = (p: Placement, lx: number, lz: number) => ({
    x: p.x + lx * Math.cos(p.rot) - lz * Math.sin(p.rot),
    z: p.z + lx * Math.sin(p.rot) + lz * Math.cos(p.rot),
  });

  // ------------------------------------------------------------------ abbey, round tower, high cross
  // The trail runs over the middle of the knoll: the abbey stands beside it, on the side away from the valley floor.
  const abbey = (() => {
    const t = trailNear(sites.abbeyKnoll.x, sites.abbeyKnoll.z);
    const rot = Math.atan2(t.tz, t.tx);
    const away = Math.sign(t.x - valleyAxis(t.z)) || 1;
    // Local z of a placement points along (-sin, cos); pick the nave's side of the trail.
    const side = Math.sign(-Math.sin(rot) * away) || 1;
    const x = t.x - Math.sin(rot) * side * 16;
    const z = t.z + Math.cos(rot) * side * 16;
    return { x, z, rot, y: groundUnder(x, z, rot, ABBEY.length, ABBEY.width), side };
  })();
  {
    const { length: L, width: W, thick: T, wallHeight: H, gableHeight: G } = ABBEY;
    const solid = (lx0: number, lx1: number, lz0: number, lz1: number, top: number) => {
      const c = toWorld(abbey, (lx0 + lx1) / 2, (lz0 + lz1) / 2);
      colliders.add(c.x, c.z, Math.abs(lx1 - lx0), Math.abs(lz1 - lz0), abbey.rot, abbey.y + top);
    };
    // The long wall facing the trail has a doorway; the far one has fallen in over a stretch.
    const near = -abbey.side * (W / 2 - T / 2);
    solid(-L / 2, 3.5, near - T / 2, near + T / 2, H);
    solid(5.5, L / 2, near - T / 2, near + T / 2, H);
    solid(-L / 2, -3, -near - T / 2, -near + T / 2, H);
    solid(1.5, L / 2, -near - T / 2, -near + T / 2, H);
    // Gables: the west one has the great door.
    solid(-L / 2, -L / 2 + T, -W / 2, -1.2, G);
    solid(-L / 2, -L / 2 + T, 1.2, W / 2, G);
    solid(L / 2 - T, L / 2, -W / 2, W / 2, G);
  }
  const tower = (() => {
    const p = toWorld(abbey, -ABBEY.length / 2 - 9, abbey.side * 5); // beyond the west gable, on the far side from the trail
    const placed = { ...p, rot: abbey.rot, y: heightAt(p.x, p.z) };
    colliders.add(p.x, p.z, TOWER.radius * 1.8, TOWER.radius * 1.8, abbey.rot, placed.y + TOWER.height);
    colliders.add(p.x, p.z, TOWER.radius * 1.8, TOWER.radius * 1.8, abbey.rot + Math.PI / 4, placed.y + TOWER.height);
    return placed;
  })();
  const cross = (() => {
    const p = toWorld(abbey, -ABBEY.length / 2 - 5, -abbey.side * 8); // before the west door, near the trail
    colliders.add(p.x, p.z, 1.3, 1.3, abbey.rot, heightAt(p.x, p.z) + 4);
    return { ...p, rot: abbey.rot + Math.PI / 2, y: heightAt(p.x, p.z) };
  })();

  // ------------------------------------------------------------------ stone circle
  // A ring on the hilltop; the trail passes through it, so stones that would stand in the way are left out.
  const stones: LandmarkPlan['stones'] = [];
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2 + 0.2;
    const r = CIRCLE_RADIUS + (rand() - 0.5) * 1.2;
    const x = sites.stoneCircleHill.x + Math.cos(a) * r;
    const z = sites.stoneCircleHill.z + Math.sin(a) * r;
    const height = 1.5 + rand() * 1.1;
    const lying = rand() < 0.14;
    const turn = a + Math.PI / 2 + (rand() - 0.5) * 0.5; // broad face towards the middle
    if (at(x, z).path > 0.45) continue;
    stones.push({ x, z, y: heightAt(x, z), rot: turn, height, lying });
    colliders.add(x, z, lying ? height : 1.0, 0.7, turn, heightAt(x, z) + (lying ? 0.6 : height), lying);
  }

  // ------------------------------------------------------------------ cottages
  const cottages = [sites.cottageNorth, sites.cottageWest, sites.cottageLake].map((site) => {
    // Front door towards the trail.
    const t = trailNear(site.x, site.z);
    let rot = Math.atan2(t.tz, t.tx);
    const frontX = -Math.sin(rot);
    const frontZ = Math.cos(rot);
    if (frontX * (t.x - site.x) + frontZ * (t.z - site.z) > 0) rot += Math.PI; // local -z is the front
    const y = groundUnder(site.x, site.z, rot, COTTAGE.length, COTTAGE.width);
    colliders.add(site.x, site.z, COTTAGE.length, COTTAGE.width, rot, y + COTTAGE.wallHeight + 2.4);
    return { x: site.x, z: site.z, rot, y };
  });

  // ------------------------------------------------------------------ bridge
  // Where the trail meets the river: a hump-backed bridge along the trail. Its deck is registered
  // with the terrain as something to stand on, so the horse simply rides over it.
  const bridge = (() => {
    let t = trailNear(sites.riverFord.x, sites.riverFord.z);
    // Slide along the trail to the river's centre line.
    for (let step = 0; step < 40; step++) {
      const off = t.x - riverX(t.z);
      if (Math.abs(off) < 0.25) break;
      // Which way along the trail brings the river nearer?
      const ahead = Math.abs(t.x + t.tx - riverX(t.z + t.tz));
      const dir = ahead < Math.abs(off) ? 1 : -1;
      t = trailNear(t.x + t.tx * dir * 0.5, t.z + t.tz * dir * 0.5);
    }
    const rot = Math.atan2(t.tz, t.tx);
    const halfLength = 11;
    const halfWidth = 1.9;
    const yA = heightAt(t.x - t.tx * halfLength, t.z - t.tz * halfLength);
    const yB = heightAt(t.x + t.tx * halfLength, t.z + t.tz * halfLength);
    const deckAt = (s: number) => {
      const u = Math.min(1, Math.max(-1, s / halfLength));
      return yA + (yB - yA) * (u * 0.5 + 0.5) + 1.3 * (1 - u * u) ** 2;
    };
    let bed = Infinity;
    for (let s = -halfLength; s <= halfLength; s += 1) {
      for (const l of [-halfWidth, 0, halfWidth]) bed = Math.min(bed, heightAt(t.x + t.tx * s - t.tz * l, t.z + t.tz * s + t.tx * l));
    }
    const frame: BridgeFrame = { x: t.x, z: t.z, y: Math.min(yA, yB), rot, halfLength, halfWidth, deckAt, bed, water: waterLevelAt(t.x, t.z) };
    field.addSurface((x, z) => {
      const dx = x - frame.x;
      const dz = z - frame.z;
      const s = dx * t.tx + dz * t.tz;
      const l = -dx * t.tz + dz * t.tx;
      return Math.abs(s) <= halfLength && Math.abs(l) <= halfWidth ? deckAt(s) : -Infinity;
    });
    // Parapets: solid for the whole length, which also stops anything wading in under the deck.
    for (const side of [-1, 1]) {
      const l = side * (halfWidth - 0.2);
      colliders.add(t.x - t.tz * l, t.z + t.tx * l, halfLength * 2, 0.4, rot, deckAt(0) + 0.9);
    }
    return frame;
  })();

  const clearings: LandmarkPlan['clearings'] = [
    [abbey.x, abbey.z, 26],
    [tower.x, tower.z, 12],
    [sites.stoneCircleHill.x, sites.stoneCircleHill.z, CIRCLE_RADIUS + 10],
    [bridge.x, bridge.z, 18],
    ...cottages.map((c): [number, number, number] => [c.x, c.z, 15]),
  ];
  const inClearing = (x: number, z: number, margin: number) => clearings.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r + margin);

  // ------------------------------------------------------------------ dry-stone walls
  // Walls divide the valley floor into fields: some run from the river out to the foot of the
  // hills, a few run along the valley between them. Each follows the ground, wanders a little,
  // stops at water, steep ground and landmarks, and leaves a gap with gate pillars for the trail.
  const walls: WallPiece[] = [];
  const STEP = 4;
  const good = (x: number, z: number) => {
    if (Math.abs(x) > HALF - 60 || Math.abs(z) > HALF - 60) return false;
    const h = heightAt(x, z);
    if (h < waterLevelAt(x, z) + 0.7 || Math.abs(x - riverX(z)) < 11) return false;
    if (h - (14 - z * 0.008) > 17) return false; // up to the foot of the hills, no further
    return at(x, z).flatness > 0.9 && !inClearing(x, z, 3);
  };
  /** Follows `line(t)` (t in metres) and turns every sound stretch of it into a wall piece. */
  const run = (line: (t: number) => { x: number; z: number }, length: number) => {
    let piece: WallPiece | null = null;
    const close = (forTrail: boolean) => {
      if (piece && piece.points.length >= 3) {
        piece.pillarAtEnd = forTrail;
        walls.push(piece);
      }
      piece = null;
    };
    let afterTrail = false;
    for (let t = 0; t <= length; t += STEP) {
      const { x, z } = line(t);
      const onTrail = at(x, z).path > 0.58;
      if (onTrail || !good(x, z)) {
        close(onTrail);
        afterTrail = onTrail;
        continue;
      }
      if (!piece) piece = { points: [], pillarAtStart: afterTrail, pillarAtEnd: false };
      afterTrail = false;
      piece.points.push({ x, y: heightAt(x, z), z });
    }
    close(false);
  };
  const wander = (t: number, seed: number) => 5 * noise(t / 70 + seed * 13.7, seed * 3.1);
  // Across the valley, on both sides of the river (or of the lake).
  [-560, -440, -335, -195, -70, 55, 250, 400, 530].forEach((z0, n) => {
    for (const side of [-1, 1]) {
      const seed = n * 2 + (side + 1) / 2;
      run((t) => {
        const z = z0 + wander(t, seed);
        return { x: riverX(z0) + side * (12 + t), z };
      }, 250);
    }
  });
  // Along the valley, part of the way.
  [
    [-118, -440, -195],
    [112, -335, -70],
    [-125, -70, 55],
  ].forEach(([offset, zFrom, zTo], n) => {
    run((t) => {
      const z = zFrom + t;
      return { x: valleyAxis(z) + offset + wander(t, 40 + n), z };
    }, zTo - zFrom);
  });
  for (const piece of walls) {
    for (let i = 0; i + 1 < piece.points.length; i++) {
      const a = piece.points[i];
      const b = piece.points[i + 1];
      colliders.add((a.x + b.x) / 2, (a.z + b.z) / 2, Math.hypot(b.x - a.x, b.z - a.z) + 0.3, 0.7, Math.atan2(b.z - a.z, b.x - a.x), Math.max(a.y, b.y) + WALL_HEIGHT, true);
    }
  }

  return { walls, abbey, tower, cross, stones, cottages, bridge, colliders, clearings };
}
