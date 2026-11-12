import * as THREE from 'three/webgpu';
import { attribute, cameraViewMatrix, dot, float, mix, normalize, positionWorld, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import { cloudShade, groundWet, noiseTexture } from './atmosphere';
import type { Heightfield } from './heightfield';
import { ABBEY, COTTAGE, TOWER, WALL_HEIGHT, type LandmarkPlan, type Placement } from './landmarkPlan';
import { MeshBuilder, placementMatrix, type Paint } from './meshBuilder';
import { mulberry32 } from './noise';
import { createMasonryTextures } from './stoneTextures';
import { mapUv } from './terrainMaterial';

const STONE: Paint = [0.82, 0.8, 0.76, 1];
const DARK: Paint = [0.012, 0.012, 0.014, 0];
const WHITEWASH: Paint = [0.74, 0.72, 0.66, 0.12];
const THATCH: Paint = [0.3, 0.25, 0.14, 0];
const WOOD: Paint = [0.16, 0.13, 0.09, 0];
const ROCK: Paint = [1.15, 1.15, 1.1, 1];
const DOORS: Paint[] = [
  [0.35, 0.05, 0.04, 0],
  [0.05, 0.2, 0.1, 0],
  [0.06, 0.12, 0.3, 0],
];
/** Buildings reach this far below the ground they stand on, so no gap shows on a slope. */
const FOUNDATION = 2.5;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A pointed (lancet) opening: straight sides, then two curves meeting at the top. */
function lancet(centre: number, sill: number, width: number, height: number): THREE.Path {
  const a = centre - width / 2;
  const b = centre + width / 2;
  const spring = sill + height;
  const path = new THREE.Path();
  path.moveTo(a, sill);
  path.lineTo(b, sill);
  path.lineTo(b, spring);
  path.quadraticCurveTo(b, spring + width * 0.9, centre, spring + width * 1.3);
  path.quadraticCurveTo(a, spring + width * 0.9, a, spring);
  path.lineTo(a, sill);
  return path;
}

/**
 * One stretch of ruined wall seen from the side: `top(u)` gives its broken height, `doors` are cut
 * up from the ground, `windows` are holes. Returned lying in the x-y plane, `thick` deep in z.
 */
function ruinWall(length: number, thick: number, top: (u: number) => number, doors: { from: number; to: number; height: number }[], windows: THREE.Path[]) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -FOUNDATION);
  for (const d of doors) {
    const mid = (d.from + d.to) / 2;
    const rise = (d.to - d.from) * 0.55;
    shape.lineTo(d.from, -FOUNDATION);
    shape.lineTo(d.from, d.height);
    shape.quadraticCurveTo(d.from, d.height + rise * 0.7, mid, d.height + rise);
    shape.quadraticCurveTo(d.to, d.height + rise * 0.7, d.to, d.height);
    shape.lineTo(d.to, -FOUNDATION);
  }
  shape.lineTo(length, -FOUNDATION);
  // The top, in blocks about a stone wide, from the far end back to the start.
  const blocks = Math.max(1, Math.round(length / 0.65));
  for (let k = blocks - 1; k >= 0; k--) {
    const h = top(((k + 0.5) / blocks) * length);
    shape.lineTo(((k + 1) / blocks) * length, h);
    shape.lineTo((k / blocks) * length, h);
  }
  shape.closePath();
  shape.holes.push(...windows);
  return new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 5 });
}

/** A rough boulder or standing stone, `w` × `h` × `d`, standing on y = 0. */
function boulder(w: number, h: number, d: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position');
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    // Squarer than a ball, then knocked about a bit. The same corner always moves the same way, so faces stay joined.
    const lump = 1 + 0.16 * Math.sin(p.x * 5.1 + seed) * Math.sin(p.y * 4.3 + seed * 1.7) + 0.1 * Math.sin(p.z * 6.7 + seed * 2.3);
    const square = (v: number) => Math.sign(v) * Math.abs(v) ** 0.55;
    pos.setXYZ(i, (square(p.x) * lump * w) / 2, (square(p.y) * 0.5 + 0.5) * h * (1 + 0.1 * Math.sin(p.x * 3 + seed)), (square(p.z) * lump * d) / 2);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Everything built by people in the valley, as one mesh and one draw call: field walls with gate
 * pillars and gates, the ruined abbey with its round tower, high cross and graves, the stone
 * circle, the bridge and the cottages. Where things stand comes from the plan (landmarkPlan.ts);
 * this file gives them their shape and their stone.
 */
export class Landmarks {
  readonly mesh: THREE.Mesh;
  readonly triangles: number;
  /** Tops of the cottage chimneys, for the smoke. */
  readonly chimneys: THREE.Vector3[] = [];

  constructor(field: Heightfield, plan: LandmarkPlan, rock: THREE.Texture) {
    const b = new MeshBuilder();
    const rand = mulberry32(1014);
    this.buildWalls(b, plan, rand);
    this.buildAbbey(b, plan, rand);
    this.buildTower(b, plan.tower);
    this.buildCross(b, plan, field, rand);
    plan.stones.forEach((s, i) => {
      const m = placementMatrix(s.x, s.y - 0.25, s.z, s.rot);
      if (s.lying) m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 0.45, 0));
      b.add(boulder(1.0 + 0.5 * rand(), s.height + 0.3, 0.45 + 0.25 * rand(), i * 7.3), m, ROCK, 1);
    });
    this.buildBridge(b, plan);
    plan.cottages.forEach((c, i) => this.buildCottage(b, c, DOORS[i % DOORS.length]));
    this.triangles = b.triangles;

    // ------------------------------------------------------------ the stone
    const { colour, normal } = createMasonryTextures();
    const wp = positionWorld;
    const n = normalize(attribute('normal', 'vec3'));
    const paint = attribute('paint', 'vec4');
    const kind = attribute('kind', 'float');
    const top = smoothstep(0.55, 0.8, n.y);
    // Walls are papered from the side, along whichever way they run; tops from above.
    const along = normalize(vec2(n.z.negate(), n.x).add(vec2(1e-4, 0)));
    const sideUv = vec2(dot(wp.xz, along), wp.y);
    const built = mix(texture(colour, sideUv.div(2.4)).rgb, texture(colour, wp.xz.div(2.4)).rgb, top);
    const natural = mix(texture(rock, sideUv.div(3.2)).rgb, texture(rock, wp.xz.div(3.2)).rgb, top);
    const stone = mix(built.mul(2.2), natural.mul(1.6), kind);
    const speckle = texture(noiseTexture, sideUv.div(1.7)).b.mul(0.3).add(0.85); // keeps plain paint from looking flat
    // Damp and green where the stone meets the ground, moss on the tops.
    const aboveGround = wp.y.sub(texture(field.heightTexture, mapUv(wp.xz)).level(0).r);
    const foot = float(1).sub(smoothstep(0.05, 0.9, aboveGround));
    const mossy = smoothstep(0.45, 0.7, texture(noiseTexture, wp.xz.div(3.1)).a).mul(top).mul(0.6).add(foot.mul(0.3)).mul(paint.a);
    const base = paint.rgb.mul(mix(vec3(1, 1, 1), stone, paint.a)).mul(speckle);
    const weathered = mix(base, base.mul(vec3(0.55, 0.7, 0.35)), mossy)
      .mul(mix(float(1), float(0.62), foot))
      .mul(mix(float(1), float(0.72), groundWet))
      .mul(cloudShade(wp.xz));

    const bump = texture(normal, sideUv.div(2.4)).rg.mul(2).sub(1).mul(paint.a).mul(float(1).sub(kind)).mul(float(1).sub(top));
    const bumped = normalize(n.add(vec3(along.x, 0, along.y).mul(bump.x).add(vec3(0, 1, 0).mul(bump.y)).mul(0.9)));

    const material = new THREE.MeshStandardNodeMaterial();
    material.colorNode = weathered;
    material.normalNode = cameraViewMatrix.transformDirection(bumped);
    material.roughnessNode = mix(float(0.93), float(0.55), groundWet.mul(0.7));
    material.metalness = 0;

    this.mesh = new THREE.Mesh(b.build(), material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false; // spread over the whole valley
  }

  // ------------------------------------------------------------------ field walls
  private buildWalls(b: MeshBuilder, plan: LandmarkPlan, rand: () => number) {
    const up = V(0, 1, 0);
    for (const piece of plan.walls) {
      const pts = piece.points;
      const ring = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)];
        const c = pts[Math.min(pts.length - 1, i + 1)];
        const dir = V(c.x - a.x, 0, c.z - a.z).normalize();
        const side = V(-dir.z, 0, dir.x);
        const h = WALL_HEIGHT + (rand() - 0.5) * 0.14;
        const centre = V(p.x, p.y, p.z);
        return {
          dir,
          side,
          bl: centre.clone().addScaledVector(side, 0.37).setY(p.y - 0.35),
          br: centre.clone().addScaledVector(side, -0.37).setY(p.y - 0.35),
          tl: centre.clone().addScaledVector(side, 0.22).setY(p.y + h),
          tr: centre.clone().addScaledVector(side, -0.22).setY(p.y + h),
        };
      });
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const c = ring[i + 1];
        b.quad(a.bl, c.bl, c.tl, a.tl, a.side, STONE);
        b.quad(a.br, c.br, c.tr, a.tr, a.side.clone().negate(), STONE);
        b.quad(a.tl, c.tl, c.tr, a.tr, up, STONE);
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      b.quad(first.bl, first.br, first.tr, first.tl, first.dir.clone().negate(), STONE);
      b.quad(last.bl, last.br, last.tr, last.tl, last.dir, STONE);

      // Gate pillars where the wall opens for the trail; the gate hangs on one of the pair, swung wide open.
      const pillar = (p: { x: number; y: number; z: number }, dir: THREE.Vector3, gate: boolean) => {
        const rot = Math.atan2(dir.z, dir.x);
        const m = placementMatrix(p.x + dir.x * 0.3, p.y, p.z + dir.z * 0.3, rot);
        b.box(m, [0, 0.45, 0], [0.7, 1.9, 0.7], STONE);
        b.box(m, [0, 1.47, 0], [0.86, 0.14, 0.86], STONE);
        if (!gate) return;
        const g = placementMatrix(p.x + dir.x * 0.3, p.y, p.z + dir.z * 0.3, rot + 1.75);
        for (let bar = 0; bar < 5; bar++) b.box(g, [1.85, 0.32 + bar * 0.2, 0], [2.9, 0.07, 0.045], WOOD);
        for (const x of [0.45, 1.85, 3.25]) b.box(g, [x, 0.7, 0], [0.09, 1.0, 0.06], WOOD);
      };
      if (piece.pillarAtStart) pillar(pts[0], first.dir.clone().negate(), false);
      if (piece.pillarAtEnd) pillar(pts[pts.length - 1], last.dir, true);
    }
  }

  // ------------------------------------------------------------------ abbey
  private buildAbbey(b: MeshBuilder, plan: LandmarkPlan, rand: () => number) {
    const { abbey } = plan;
    const { length: L, width: W, thick: T, wallHeight: H, gableHeight: G } = ABBEY;
    const M = placementMatrix(abbey.x, abbey.y, abbey.z, abbey.rot);
    const bite = () => (rand() < 0.2 ? 0.5 + rand() * 1.1 : rand() * 0.45); // missing stones along a wall top
    const alongX = (x: number, z: number) => M.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0, z));
    // A wall running across the nave: its length along local z, its thickness towards -x.
    const acrossZ = (x: number) => M.clone().multiply(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(0, 1, 0), V(-1, 0, 0)).setPosition(x, 0, -W / 2));

    const near = -abbey.side * (W / 2 - T / 2); // the long wall that faces the trail
    // Near wall: whole, with a doorway and four windows.
    b.add(
      ruinWall(L, T, () => H - bite(), [{ from: 15.5, to: 17.5, height: 2.5 }], [3, 7.5, 12, 21].map((u) => lancet(u, 1.8, 0.9, 2.4))),
      alongX(-L / 2, near - T / 2),
      STONE
    );
    // Far wall: fallen in over the middle, stepping down to the gap from both sides.
    b.add(ruinWall(9, T, (u) => Math.min(H - bite(), 1.0 + (9 - u) * 1.3), [], [lancet(2.5, 1.8, 0.9, 2.4)]), alongX(-L / 2, -near - T / 2), STONE);
    b.add(ruinWall(10.5, T, (u) => Math.min(H - bite(), 1.0 + u * 1.3), [], [5.5, 8.5].map((u) => lancet(u, 1.8, 0.9, 2.4))), alongX(1.5, -near - T / 2), STONE);
    // Gables: the west one with the great door and a small light above, its point broken off; the east one with the tall window.
    const gable = (u: number) => H + (G - H) * (1 - Math.abs(u - W / 2) / (W / 2));
    b.add(
      ruinWall(W, T, (u) => Math.min(gable(u), 10.4) - bite() * 0.5, [{ from: W / 2 - 1.2, to: W / 2 + 1.2, height: 3.1 }], [lancet(W / 2, 6, 0.8, 1.4)]),
      acrossZ(-L / 2 + T),
      STONE
    );
    b.add(ruinWall(W, T, (u) => gable(u) - bite() * 0.4, [], [lancet(W / 2, 2, 2.4, 3.6)]), acrossZ(L / 2), STONE);

    // Fallen stone lying in the gap of the far wall.
    for (let i = 0; i < 7; i++) {
      const m = M.clone().multiply(new THREE.Matrix4().makeRotationY(rand() * 6).setPosition(-3 + rand() * 4.5, -0.15, -near + (rand() - 0.5) * 2.4));
      b.add(boulder(0.5 + rand() * 0.6, 0.35 + rand() * 0.4, 0.4 + rand() * 0.5, i * 3.1 + 50), m, STONE, 1);
    }
  }

  private buildTower(b: MeshBuilder, tower: Placement) {
    const { radius: R, height: Ht } = TOWER;
    const rTop = R * 0.78;
    const M = placementMatrix(tower.x, tower.y - 1, tower.z, tower.rot);
    b.add(new THREE.CylinderGeometry(rTop, R, Ht, 18, 1, true), M.clone().multiply(new THREE.Matrix4().makeTranslation(0, Ht / 2, 0)), STONE);
    b.add(new THREE.ConeGeometry(rTop + 0.18, 3.6, 18), M.clone().multiply(new THREE.Matrix4().makeTranslation(0, Ht + 1.8, 0)), STONE);
    const radiusAt = (y: number) => R + (rTop - R) * (y / Ht);
    // Openings: dark panels set on the wall. The door is high off the ground, as on the real towers.
    const opening = (angle: number, y: number, w: number, h: number) => {
      const m = M.clone().multiply(new THREE.Matrix4().makeRotationY(angle));
      b.box(m, [radiusAt(y) - 0.08, y, 0], [0.2, h, w], DARK);
    };
    opening(0, 4.6, 0.8, 1.7);
    opening(2.2, 10, 0.4, 0.9);
    opening(4.1, 16, 0.4, 0.9);
    for (let k = 0; k < 4; k++) opening((k * Math.PI) / 2 + 0.4, Ht - 2.6, 0.5, 1.1);
  }

  private buildCross(b: MeshBuilder, plan: LandmarkPlan, field: Heightfield, rand: () => number) {
    const { cross, abbey } = plan;
    const M = placementMatrix(cross.x, cross.y - 0.15, cross.z, cross.rot);
    b.box(M, [0, 0.3, 0], [1.3, 0.6, 1.0], ROCK, 0, 1);
    b.box(M, [0, 2.2, 0], [0.46, 3.3, 0.3], ROCK, 0, 1);
    b.box(M, [0, 3.05, 0], [1.5, 0.42, 0.3], ROCK, 0, 1);
    b.box(M, [0, 3.95, 0], [0.56, 0.2, 0.36], ROCK, 0, 1);
    b.add(new THREE.TorusGeometry(0.62, 0.1, 6, 16), M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 3.05, 0)), ROCK, 1);
    // A few leaning gravestones between the cross and the abbey.
    for (let i = 0; i < 8; i++) {
      const lx = -ABBEY.length / 2 + 1 + rand() * 12;
      const lz = -abbey.side * (ABBEY.width / 2 + 2.5 + rand() * 4.5);
      const x = abbey.x + lx * Math.cos(abbey.rot) - lz * Math.sin(abbey.rot);
      const z = abbey.z + lx * Math.sin(abbey.rot) + lz * Math.cos(abbey.rot);
      const m = placementMatrix(x, field.heightAt(x, z) - 0.2, z, abbey.rot + Math.PI / 2 + (rand() - 0.5) * 0.5);
      m.multiply(new THREE.Matrix4().makeRotationX((rand() - 0.5) * 0.3));
      b.box(m, [0, 0.5, 0], [0.55 + rand() * 0.2, 1.0 + rand() * 0.35, 0.13], ROCK, 0, 1);
    }
  }

  // ------------------------------------------------------------------ bridge
  private buildBridge(b: MeshBuilder, plan: LandmarkPlan) {
    const br = plan.bridge;
    const { halfLength: HL, halfWidth: HW } = br;
    const M = placementMatrix(br.x, 0, br.z, br.rot); // heights below are absolute
    const span = 4.8; // half the arch's width
    const low = br.bed - 1.2;
    const spring = br.water + 0.15;
    const crown = br.deckAt(0) - 0.6;
    const ARC = 12;
    const arch = (k: number) => {
      const a = Math.PI - (k / ARC) * Math.PI;
      return { s: span * Math.cos(a), y: spring + (crown - spring) * Math.sin(a) };
    };

    // The two faces: wall from the river bed up to the parapet top, with the arch cut out.
    const side = new THREE.Shape();
    side.moveTo(-HL, low);
    side.lineTo(-span, low);
    for (let k = 0; k <= ARC; k++) side.lineTo(arch(k).s, arch(k).y);
    side.lineTo(span, low);
    side.lineTo(HL, low);
    for (let s = HL; s >= -HL; s -= 1) side.lineTo(s, br.deckAt(s) + 0.85);
    side.closePath();
    const face = new THREE.ExtrudeGeometry(side, { depth: 0.4, bevelEnabled: false });
    b.add(face, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, HW - 0.4)), STONE);
    b.add(face, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -HW)), STONE);

    const at = (s: number, y: number, l: number) => V(s, y, l).applyMatrix4(M);
    const facing = (x: number, y: number, z: number) => V(x, y, z).transformDirection(M);
    const w = HW - 0.4;
    // Road surface.
    for (let s = -HL; s < HL; s += 1) {
      b.quad(at(s, br.deckAt(s), -w), at(s + 1, br.deckAt(s + 1), -w), at(s + 1, br.deckAt(s + 1), w), at(s, br.deckAt(s), w), facing(0, 1, 0), STONE);
    }
    // Underside of the arch and the two piers it springs from.
    for (let k = 0; k < ARC; k++) {
      const p = arch(k);
      const q = arch(k + 1);
      b.quad(at(p.s, p.y, -w), at(q.s, q.y, -w), at(q.s, q.y, w), at(p.s, p.y, w), facing(-(p.s + q.s) / 2, spring - (p.y + q.y) / 2 - 0.5, 0), STONE);
    }
    for (const e of [-1, 1]) b.quad(at(e * span, low, -w), at(e * span, spring, -w), at(e * span, spring, w), at(e * span, low, w), facing(-e, 0, 0), STONE);
  }

  // ------------------------------------------------------------------ cottage
  private buildCottage(b: MeshBuilder, c: Placement, door: Paint) {
    const { length: L, width: W, wallHeight: H } = COTTAGE;
    const M = placementMatrix(c.x, c.y, c.z, c.rot);
    b.box(M, [0, (H - FOUNDATION) / 2, 0], [L, H + FOUNDATION, W], WHITEWASH);
    // Gable ends and the thatch over them: two prisms, the roof one a little bigger so it overhangs the eaves.
    const prism = (width: number, height: number, length: number, y: number, paint: Paint) => {
      const tri = new THREE.Shape();
      tri.moveTo(-width / 2, 0);
      tri.lineTo(width / 2, 0);
      tri.lineTo(0, height);
      tri.closePath();
      const m = M.clone().multiply(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(0, 1, 0), V(-1, 0, 0)).setPosition(length / 2, y, 0));
      b.add(new THREE.ExtrudeGeometry(tri, { depth: length, bevelEnabled: false }), m, paint);
    };
    prism(W, 2.3, L, H, WHITEWASH);
    prism(W + 1.0, 2.75, L - 0.04, H - 0.22, THATCH);
    // Chimney on the ridge at one end.
    b.box(M, [L / 2 - 0.6, H + 2.5, 0], [0.75, 1.5, 0.65], STONE);
    this.chimneys.push(V(L / 2 - 0.6, H + 3.3, 0).applyMatrix4(M));
    // Front (local -z, towards the trail): door and two windows; one window at the back.
    const front = -W / 2 - 0.02;
    b.box(M, [0.9, 0.95, front], [1.0, 1.9, 0.1], door);
    for (const x of [-2.6, 3.0]) {
      b.box(M, [x, 1.45, front], [0.9, 0.85, 0.08], [0.7, 0.68, 0.62, 0]);
      b.box(M, [x, 1.45, front - 0.02], [0.7, 0.65, 0.08], DARK);
    }
    b.box(M, [-1.5, 1.45, W / 2 + 0.02], [0.7, 0.65, 0.08], DARK);
  }
}
