import * as THREE from 'three/webgpu';
import type { FoliageKind } from './foliageTextures';
import { mulberry32 } from './noise';

/** One generation of branches: level 0 is the trunk, level 1 the limbs growing from it, and so on. */
interface Level {
  /** Rings along the branch and sides around it. */
  rings: number;
  sides: number;
  /** How much the branch wanders, and how strongly it bends upwards (negative: droops). */
  gnarl: number;
  lift: number;
  /** Radius at the tip relative to the base. */
  taper: number;
  /** Angle away from the parent branch (radians, ± spread); length and radius relative to the parent. */
  angle: number;
  spread: number;
  length: number;
  radius: number;
  /** Branches higher up the parent are shorter by up to this fraction. */
  shorten: number;
  /** Number of branches of the next level, growing from this fraction of the branch upwards. */
  children: number;
  from: number;
}

interface Spec {
  kind: FoliageKind;
  seed: number;
  trunkLength: number;
  trunkRadius: number;
  levels: Level[];
  /** Leaf cards: on branches of this level and deeper, this many per branch, of this size (m). */
  leafLevel: number;
  leavesPerBranch: number;
  leafSize: number;
  leafScatter: number;
  /** 0 = cards face any way (round crowns), 1 = cards lie flat (layered pine pads). */
  leafFlat: number;
}

const branch = (p: Partial<Level>): Level => ({
  rings: 4, sides: 6, gnarl: 0.05, lift: 0.3, taper: 0.5, angle: 0, spread: 0, length: 1, radius: 1, shorten: 0, children: 0, from: 0.5, ...p,
});

const SPECS: Record<FoliageKind, Spec> = {
  // Broad, low-forking oak: short thick trunk, heavy spreading limbs, dense dark crown.
  oak: {
    kind: 'oak',
    seed: 3,
    trunkLength: 3.3,
    trunkRadius: 0.42,
    levels: [
      branch({ rings: 3, sides: 7, gnarl: 0.07, taper: 0.78, children: 5, from: 0.72 }),
      branch({ rings: 3, sides: 5, gnarl: 0.24, lift: 0.16, taper: 0.4, angle: 0.75, spread: 0.45, length: 1.55, radius: 0.5, children: 3, from: 0.35 }),
      branch({ rings: 2, sides: 3, gnarl: 0.25, lift: 0.12, taper: 0.3, angle: 0.8, spread: 0.3, length: 0.6, radius: 0.5, shorten: 0.3 }),
    ],
    leafLevel: 1,
    leavesPerBranch: 4,
    leafSize: 2.9,
    leafScatter: 0.9,
    leafFlat: 0.15,
  },
  // Slender birch: one pale stem to the top, fine drooping side branches, light open crown.
  birch: {
    kind: 'birch',
    seed: 8,
    trunkLength: 10.5,
    trunkRadius: 0.16,
    levels: [
      branch({ rings: 6, sides: 5, gnarl: 0.035, lift: 0.25, taper: 0.18, children: 12, from: 0.32 }),
      branch({ rings: 3, sides: 3, gnarl: 0.14, lift: -0.06, taper: 0.3, angle: 0.8, spread: 0.25, length: 0.3, radius: 0.42, shorten: 0.65 }),
    ],
    leafLevel: 1,
    leavesPerBranch: 3,
    leafSize: 2.1,
    leafScatter: 0.55,
    leafFlat: 0.1,
  },
  // Scots pine: tall bare trunk, level branches near the top carrying flat pads of needles.
  pine: {
    kind: 'pine',
    seed: 5,
    trunkLength: 13,
    trunkRadius: 0.3,
    levels: [
      branch({ rings: 5, sides: 6, gnarl: 0.03, lift: 0.3, taper: 0.3, children: 10, from: 0.52 }),
      branch({ rings: 3, sides: 3, gnarl: 0.12, lift: 0.1, taper: 0.3, angle: 1.3, spread: 0.2, length: 0.31, radius: 0.36, shorten: 0.55 }),
    ],
    leafLevel: 1,
    leavesPerBranch: 3,
    leafSize: 2.7,
    leafScatter: 0.5,
    leafFlat: 0.75,
  },
  // Gorse bush: no trunk, just a dome of spiny foliage (built separately below).
  gorse: { kind: 'gorse', seed: 2, trunkLength: 0, trunkRadius: 0, levels: [], leafLevel: 0, leavesPerBranch: 16, leafSize: 1.45, leafScatter: 0.75, leafFlat: 0.2 },
};

export interface TreeModel {
  kind: FoliageKind;
  /** Trunk and branches (position, normal, uv); null for bushes. */
  wood: THREE.BufferGeometry | null;
  /** Leaf cards (position, normal, uv, leaf = sway phase + shade). */
  leaves: THREE.BufferGeometry;
  height: number;
  /** Largest horizontal reach from the trunk. */
  radius: number;
  trunkRadius: number;
  triangles: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Builds one tree of the given species in code. The result is the same on every run. */
export function buildTree(kind: FoliageKind): TreeModel {
  const spec = SPECS[kind];
  const rand = mulberry32(spec.seed);
  const jitter = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(2);

  const wood = { pos: [] as number[], nor: [] as number[], uv: [] as number[], idx: [] as number[] };
  const cards: { centre: THREE.Vector3; size: number }[] = [];

  /** A tapering tube along `points`. */
  const tube = (points: THREE.Vector3[], radii: number[], sides: number) => {
    const first = wood.pos.length / 3;
    const around = Math.max(1, Math.round((2 * Math.PI * radii[0]) / 1.1)); // bark repeats about every 1.1 m
    const normal = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    let along = rand() * 3;
    for (let i = 0; i < points.length; i++) {
      tangent.subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
      // Keep the ring's orientation steady from one ring to the next so the bark does not twist.
      if (i === 0) normal.set(Math.abs(tangent.x) > 0.9 ? 0 : 1, 0, Math.abs(tangent.x) > 0.9 ? 1 : 0);
      normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
      const binormal = new THREE.Vector3().crossVectors(tangent, normal);
      if (i > 0) along += points[i].distanceTo(points[i - 1]);
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const dir = normal.clone().multiplyScalar(Math.cos(a)).addScaledVector(binormal, Math.sin(a));
        wood.pos.push(points[i].x + dir.x * radii[i], points[i].y + dir.y * radii[i], points[i].z + dir.z * radii[i]);
        wood.nor.push(dir.x, dir.y, dir.z);
        wood.uv.push((j / sides) * around, along / 1.1);
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = 0; j < sides; j++) {
        const a = first + i * (sides + 1) + j;
        const b = a + sides + 1;
        wood.idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  };

  const grow = (start: THREE.Vector3, direction: THREE.Vector3, length: number, radius: number, depth: number) => {
    const level = spec.levels[depth];
    const points = [start.clone()];
    const radii = [radius];
    const dir = direction.clone();
    for (let i = 1; i <= level.rings; i++) {
      dir.addScaledVector(jitter(), level.gnarl).addScaledVector(UP, level.lift * 0.3).normalize();
      points.push(points[i - 1].clone().addScaledVector(dir, length / level.rings));
      radii.push(radius * (1 - (1 - level.taper) * (i / level.rings)));
    }
    tube(points, radii, level.sides);

    const at = (t: number) => {
      const f = Math.min(level.rings - 1e-4, t * level.rings);
      const i = Math.floor(f);
      return {
        point: points[i].clone().lerp(points[i + 1], f - i),
        dir: points[i + 1].clone().sub(points[i]).normalize(),
        radius: radii[i] + (radii[i + 1] - radii[i]) * (f - i),
      };
    };

    const next = spec.levels[depth + 1];
    if (next) {
      const turn = rand() * Math.PI * 2;
      for (let c = 0; c < level.children; c++) {
        const t = level.from + (1 - level.from) * ((c + 0.8 * rand()) / level.children);
        const here = at(t);
        // Step round the parent by the golden angle so branches spread evenly.
        const e1 = new THREE.Vector3(1, 0, 0);
        if (Math.abs(here.dir.x) > 0.9) e1.set(0, 0, 1);
        e1.addScaledVector(here.dir, -e1.dot(here.dir)).normalize();
        const e2 = new THREE.Vector3().crossVectors(here.dir, e1);
        const az = turn + c * 2.4 + (rand() - 0.5) * 0.6;
        const tilt = next.angle + (rand() - 0.5) * 2 * next.spread;
        const childDir = here.dir
          .clone()
          .multiplyScalar(Math.cos(tilt))
          .addScaledVector(e1, Math.cos(az) * Math.sin(tilt))
          .addScaledVector(e2, Math.sin(az) * Math.sin(tilt));
        const reach = (t - level.from) / (1 - level.from);
        grow(here.point, childDir, length * next.length * (0.8 + 0.4 * rand()) * (1 - next.shorten * reach), here.radius * next.radius, depth + 1);
      }
    }

    if (depth >= spec.leafLevel) {
      for (let k = 0; k < spec.leavesPerBranch; k++) {
        const t = 0.3 + 0.7 * ((k + rand()) / spec.leavesPerBranch);
        const centre = at(t).point.addScaledVector(jitter(), spec.leafScatter);
        cards.push({ centre, size: spec.leafSize * (0.8 + 0.4 * rand()) });
      }
      cards.push({ centre: points[points.length - 1].clone(), size: spec.leafSize * (0.85 + 0.3 * rand()) });
    } else if (!next || level.children === 0) {
      cards.push({ centre: points[points.length - 1].clone(), size: spec.leafSize });
    }
    // The top of a single-stem tree needs foliage too.
    if (depth === 0 && spec.leafLevel > 0) {
      const top = points[points.length - 1];
      for (let k = 0; k < 3; k++) cards.push({ centre: top.clone().addScaledVector(jitter(), spec.leafScatter * 0.8), size: spec.leafSize * 0.9 });
    }
  };

  if (spec.levels.length > 0) {
    grow(new THREE.Vector3(0, -0.25, 0), UP, spec.trunkLength + 0.25, spec.trunkRadius, 0); // starts just below ground
  } else {
    // Bush: cards scattered through a low dome.
    for (let k = 0; k < spec.leavesPerBranch; k++) {
      const a = k * 2.4;
      const r = spec.leafScatter * Math.sqrt((k + 0.5) / spec.leavesPerBranch);
      cards.push({
        centre: new THREE.Vector3(r * Math.cos(a), 0.45 + 0.55 * rand() * (1 - r / spec.leafScatter) + 0.1 * rand(), r * Math.sin(a)),
        size: spec.leafSize * (0.75 + 0.4 * rand()),
      });
    }
  }

  // ---- Leaf cards. Normals point away from the middle of the crown rather than off each card,
  // so the crown is lit as one rounded mass instead of a pile of flat panels.
  const crown = new THREE.Vector3();
  for (const c of cards) crown.add(c.centre);
  crown.divideScalar(Math.max(1, cards.length));
  let crownReach = 0.01;
  for (const c of cards) crownReach = Math.max(crownReach, c.centre.distanceTo(crown));

  const leaf = { pos: [] as number[], nor: [] as number[], uv: [] as number[], data: [] as number[], idx: [] as number[] };
  for (const card of cards) {
    const facing = jitter().normalize().lerp(UP, spec.leafFlat).normalize();
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(facing.x) > 0.9) u.set(0, 0, 1);
    u.addScaledVector(facing, -u.dot(facing)).normalize().applyAxisAngle(facing, rand() * Math.PI * 2);
    const v = new THREE.Vector3().crossVectors(facing, u);
    const phase = rand();
    const depthInCrown = card.centre.distanceTo(crown) / crownReach;
    const shade = 0.5 + 0.5 * Math.min(1, depthInCrown * 1.15); // darker inside the crown
    const first = leaf.pos.length / 3;
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = card.centre.clone().addScaledVector(u, (cu * card.size) / 2).addScaledVector(v, (cv * card.size) / 2);
      const n = p.clone().sub(crown).divideScalar(crownReach).addScaledVector(UP, 0.35).normalize();
      leaf.pos.push(p.x, p.y, p.z);
      leaf.nor.push(n.x, n.y, n.z);
      leaf.uv.push(cu * 0.5 + 0.5, cv * 0.5 + 0.5);
      leaf.data.push(phase, shade);
    }
    leaf.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  const geometry = (pos: number[], nor: number[], uv: number[], idx: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  };
  const leaves = geometry(leaf.pos, leaf.nor, leaf.uv, leaf.idx);
  leaves.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf.data, 2));

  let height = 0;
  let radius = 0;
  for (const list of [wood.pos, leaf.pos]) {
    for (let i = 0; i < list.length; i += 3) {
      height = Math.max(height, list[i + 1]);
      radius = Math.max(radius, Math.hypot(list[i], list[i + 2]));
    }
  }

  return {
    kind,
    wood: wood.idx.length > 0 ? geometry(wood.pos, wood.nor, wood.uv, wood.idx) : null,
    leaves,
    height,
    radius,
    trunkRadius: spec.trunkRadius,
    triangles: (wood.idx.length + leaf.idx.length) / 3,
  };
}
