import * as THREE from 'three/webgpu';
import { attribute, cameraViewMatrix, cos, float, fract, mix, positionGeometry, sin, varying, vec3 } from 'three/tsl';
import { cloudShade } from './atmosphere';
import { CELL, GRID, HALF, valleyAxis, type Heightfield } from './heightfield';
import type { Colliders } from './landmarkPlan';
import { mulberry32 } from './noise';

/** Flocks, as [offset east of the valley centre line, z]: open pasture on the valley floor. */
const FLOCKS: ReadonlyArray<readonly [number, number]> = [
  [-75, -150],
  [85, -265],
  [70, -20],
  [-85, -385],
  [95, -500],
  [-250, 300],
];
const PER_FLOCK = 11;
const ROAM = 20; // how far a sheep strays from the middle of its flock, in metres
const SHY = 9; // a horse nearer than this sends it running
const WALK = 0.55;
const RUN = 4.2;

interface Sheep {
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** Seconds until it next decides what to do. */
  wait: number;
  grazing: boolean;
  fleeing: boolean;
  homeX: number;
  homeZ: number;
  targetX: number;
  targetZ: number;
  size: number;
  stride: number;
  headDown: number;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Flocks of blackface sheep on the pastures: grazing, ambling a few steps now and then, and
 * trotting off when the horse comes close. Simple shapes, all drawn in one call; legs and the
 * grazing head are moved in the vertex shader, each sheep's position on the CPU.
 */
export class SheepFlocks {
  readonly mesh: THREE.Mesh;
  readonly count: number;

  private readonly sheep: Sheep[] = [];
  private readonly a: Float32Array; // x, y, z, heading
  private readonly b: Float32Array; // size, stride phase, head down, walking
  private readonly attrA: THREE.InstancedBufferAttribute;
  private readonly attrB: THREE.InstancedBufferAttribute;

  constructor(
    private readonly field: Heightfield,
    private readonly colliders: Colliders
  ) {
    const rand = mulberry32(8282);
    for (const [offset, z0] of FLOCKS) {
      const x0 = valleyAxis(z0) + offset;
      for (let i = 0, tries = 0; i < PER_FLOCK && tries < 200; tries++) {
        const r = ROAM * Math.sqrt(rand());
        const a = rand() * Math.PI * 2;
        const x = x0 + Math.cos(a) * r;
        const z = z0 + Math.sin(a) * r;
        if (!this.pasture(x, z)) continue;
        i++;
        this.sheep.push({
          x,
          z,
          heading: rand() * Math.PI * 2,
          speed: 0,
          wait: rand() * 8,
          grazing: rand() < 0.7,
          fleeing: false,
          homeX: x0,
          homeZ: z0,
          targetX: x,
          targetZ: z,
          size: 0.74 + 0.16 * rand(),
          stride: rand() * 6,
          headDown: 0,
        });
      }
    }
    this.count = this.sheep.length;
    this.a = new Float32Array(this.count * 4);
    this.b = new Float32Array(this.count * 4);
    this.attrA = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrB = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage);

    const geometry = this.buildGeometry();
    geometry.setAttribute('sheepA', this.attrA);
    geometry.setAttribute('sheepB', this.attrB);
    geometry.instanceCount = this.count;

    const A = attribute('sheepA', 'vec4');
    const B = attribute('sheepB', 'vec4');
    const part = attribute('part', 'vec3'); // x: leg (+1 / -1 for the two diagonal pairs, 0 = not a leg) · y: 1 = dark · z: head weight
    const p = positionGeometry;
    // Legs swing from the hip; the head (and a little of the neck) goes down to graze.
    const hip = float(0.42);
    const swing = sin(B.y.add(part.x.mul(Math.PI / 2))).mul(part.x.abs()).mul(B.w).mul(hip.sub(p.y).max(0)).mul(0.75);
    const graze = part.z.mul(B.z);
    const local = vec3(p.x, p.y.sub(graze.mul(0.52)), p.z.add(swing).add(graze.mul(0.12))).mul(B.x);
    const c = cos(A.w);
    const s = sin(A.w);
    // Heading 0 faces +z and grows turning left, like the horse.
    const turn = (v: ReturnType<typeof vec3>) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));

    const wool = vec3(0.4, 0.375, 0.32).mul(fract(B.x.mul(37.7)).mul(0.25).add(0.85));
    const material = new THREE.MeshStandardNodeMaterial();
    material.positionNode = A.xyz.add(turn(local));
    material.colorNode = varying(mix(wool, vec3(0.03, 0.028, 0.026), part.y).mul(cloudShade(A.xz)));
    material.normalNode = cameraViewMatrix.transformDirection(varying(turn(attribute('normal', 'vec3'))));
    material.roughness = 1;
    material.metalness = 0;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.write();
  }

  /** `horse` is the horse's position. Flocks far from it stand still and cost nothing. */
  update(dt: number, horse: THREE.Vector3) {
    for (const s of this.sheep) {
      if (Math.abs(s.homeX - horse.x) + Math.abs(s.homeZ - horse.z) > 160) continue;
      const dx = s.x - horse.x;
      const dz = s.z - horse.z;
      const away = Math.hypot(dx, dz);

      if (away < SHY) {
        s.fleeing = true;
        s.grazing = false;
      } else if (s.fleeing && away > SHY * 2) {
        s.fleeing = false;
        s.wait = 1 + Math.random() * 3;
        s.targetX = s.x;
        s.targetZ = s.z;
      }

      let wantSpeed = 0;
      let wantHeading = s.heading;
      if (s.fleeing) {
        wantSpeed = RUN;
        wantHeading = Math.atan2(dx, dz); // straight away from the horse
      } else {
        s.wait -= dt;
        if (s.wait <= 0) {
          // Either settle to graze or pick a spot a few steps off, never far from the flock.
          s.grazing = Math.random() < 0.6;
          s.wait = 3 + Math.random() * 9;
          if (!s.grazing) {
            const r = ROAM * Math.sqrt(Math.random());
            const a = Math.random() * Math.PI * 2;
            s.targetX = s.homeX + Math.cos(a) * r;
            s.targetZ = s.homeZ + Math.sin(a) * r;
          }
        }
        const tx = s.targetX - s.x;
        const tz = s.targetZ - s.z;
        if (!s.grazing && Math.hypot(tx, tz) > 0.6) {
          wantSpeed = WALK;
          wantHeading = Math.atan2(tx, tz);
        }
      }

      s.heading += wrapAngle(wantHeading - s.heading) * Math.min(1, dt * (s.fleeing ? 6 : 2.5));
      s.speed += (wantSpeed - s.speed) * Math.min(1, dt * 4);
      if (s.speed > 0.02) {
        const nx = s.x + Math.sin(s.heading) * s.speed * dt;
        const nz = s.z + Math.cos(s.heading) * s.speed * dt;
        if (this.dry(nx, nz)) {
          s.x = nx;
          s.z = nz;
          this.colliders.pushOut(s, 0.4);
        } else {
          s.heading += Math.PI * 0.6; // water ahead: turn aside
          s.targetX = s.x;
          s.targetZ = s.z;
        }
        s.stride += (s.speed * dt * 2 * Math.PI) / (0.55 + 0.12 * s.speed); // longer strides when running
      }
      const down = !s.fleeing && s.grazing && s.speed < 0.1 ? 1 : 0;
      s.headDown += (down - s.headDown) * Math.min(1, dt * 2.5);
    }
    this.write();
  }

  private write() {
    this.sheep.forEach((s, i) => {
      this.a.set([s.x, this.field.heightAt(s.x, s.z), s.z, s.heading], i * 4);
      this.b.set([s.size, s.stride, s.headDown, Math.min(1, s.speed / WALK)], i * 4);
    });
    this.attrA.needsUpdate = true;
    this.attrB.needsUpdate = true;
  }

  private dry(x: number, z: number) {
    return this.field.heightAt(x, z) > this.field.waterLevelAt(x, z) + 0.15;
  }

  /** Open, fairly level grass: not in the water, on the trail, under trees or inside a wall. */
  private pasture(x: number, z: number) {
    if (!this.dry(x, z) || this.colliders.near(x, z, 0.8)) return false;
    const i = Math.min(GRID - 1, Math.max(0, Math.round((x + HALF) / CELL)));
    const j = Math.min(GRID - 1, Math.max(0, Math.round((z + HALF) / CELL)));
    const k = (j * GRID + i) * 4;
    return this.field.control[k] < 60 && this.field.control[k + 1] < 90 && this.field.normalAo[k + 3] > 215;
  }

  private buildGeometry() {
    const positions: number[] = [];
    const normals: number[] = [];
    const parts: number[] = [];
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const add = (source: THREE.BufferGeometry, matrix: THREE.Matrix4, part: (y: number, z: number) => [number, number, number]) => {
      const g = source.index ? source.toNonIndexed() : source;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        positions.push(v.x, v.y, v.z);
        normals.push(n.x, n.y, n.z);
        parts.push(...part(v.y, v.z));
      }
    };
    const place = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt), new THREE.Vector3(sx, sy, sz));
    const ball = new THREE.SphereGeometry(1, 7, 5);
    const box = new THREE.BoxGeometry(1, 1, 1);
    // Woolly body; the front of it counts a little towards the head so the neck follows when grazing.
    add(ball, place(0, 0.66, 0, 0.3, 0.29, 0.52), (_y, z) => [0, 0, Math.max(0, (z - 0.3) * 1.6)]);
    // Neck and head (dark), nose forward (+z).
    add(box, place(0, 0.84, 0.5, 0.15, 0.2, 0.26, -0.7), () => [0, 1, 0.75]);
    add(box, place(0, 0.94, 0.68, 0.16, 0.17, 0.3, 0.25), () => [0, 1, 1]);
    // Legs: the diagonal pairs move together.
    for (const [x, z, pair] of [[-0.15, 0.3, 1], [0.15, 0.3, -1], [-0.15, -0.32, -1], [0.15, -0.32, 1]]) {
      add(box, place(x, 0.22, z, 0.075, 0.46, 0.075), () => [pair, 1, 0]);
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('part', new THREE.Float32BufferAttribute(parts, 3));
    return geometry;
  }
}
