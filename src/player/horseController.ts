import * as THREE from 'three/webgpu';
import { HALF, WATER_LEVEL, type Heightfield } from '../world/heightfield';
import { GAITS, TOP_SPEED } from './gaits';

const HALF_BODY = 0.55; // distance from the middle of the horse to its fore and hind hooves
const HALF_WIDTH = 0.2;
const GRAVITY = 9.81;
const JUMP_SPEED = 4.6; // about 1.1 m high, 0.9 s in the air
const MAX_WADE_DEPTH = 1.0; // deeper water than this stops the horse
const EDGE_MARGIN = 40; // keep this far inside the edge of the map

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
}

/**
 * Moves the horse over the terrain: gait speeds with inertia, steering that tightens at low speed,
 * slopes, shallow water, jumping. Runs at a fixed time step; `applyPose` blends the last two steps
 * so the picture stays smooth at any frame rate.
 */
export class HorseController {
  /** Index into GAITS the rider has asked for. */
  gaitIndex = 0;
  /** Steering from the player, -1 (right) .. 1 (left). Ignored while the autopilot rides. */
  steerInput = 0;
  /** When on, the horse follows the trail by itself. */
  autopilot = false;

  speed = 0;
  steer = 0;
  turnRate = 0;
  grounded = true;
  verticalSpeed = 0;
  heightAboveGround = 0;
  /** Heading as shown this frame (after applyPose). 0 faces +z; increases turning left. */
  renderHeading = 0;

  private readonly cur: Pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };
  private readonly prev: Pose = { ...this.cur };
  private jumpQueued = false;
  private trailU = 0;
  private readonly trailLength: number;
  private readonly p = new THREE.Vector3();

  constructor(private readonly field: Heightfield) {
    field.trail.arcLengthDivisions = 3000;
    this.trailLength = field.trail.getLength();
    this.placeOnTrail(0);
  }

  get gait() {
    return GAITS[this.gaitIndex];
  }

  setGait(index: number) {
    this.gaitIndex = Math.min(GAITS.length - 1, Math.max(0, index));
  }

  jump() {
    this.jumpQueued = true;
  }

  setAutopilot(on: boolean) {
    if (on && !this.autopilot) this.trailU = this.nearestTrailU();
    this.autopilot = on;
  }

  /** Puts the horse back on the nearest bit of trail, standing still (for when it gets stuck). */
  returnToTrail() {
    this.placeOnTrail(this.nearestTrailU());
  }

  step(dt: number) {
    Object.assign(this.prev, this.cur);
    const c = this.cur;
    const { heightAt } = this.field;

    // Steering: eased so key taps do not jerk; turning circle widens with speed.
    const steerTarget = this.autopilot ? this.autoSteer() : this.steerInput;
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 6);
    this.turnRate = this.steer * lerp(1.6, 0.55, Math.sqrt(this.speed / TOP_SPEED));
    c.heading += this.turnRate * dt;

    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    let hFore = heightAt(c.x + fx * HALF_BODY, c.z + fz * HALF_BODY);
    let hHind = heightAt(c.x - fx * HALF_BODY, c.z - fz * HALF_BODY);

    if (this.grounded) {
      const grade = (hFore - hHind) / (2 * HALF_BODY);
      let want = this.gait.speed;
      want *= 1 - smoothstep(0.35, 0.8, grade); // too steep to climb at about 39°
      want = Math.min(want, lerp(want, GAITS[1].speed, smoothstep(0.35, 0.7, -grade))); // pick the way down carefully
      const depth = WATER_LEVEL - (hFore + hHind) / 2;
      if (depth > 0.15) want = Math.min(want, lerp(GAITS[3].speed, GAITS[1].speed, smoothstep(0.15, 0.8, depth)));

      // Refuse to walk into deep water or off the map. Looks ahead by the braking distance,
      // so even a gallop pulls up in time.
      const BRAKE = 12;
      const reach = 1.4 + (this.speed * this.speed) / (2 * BRAKE);
      const ax = c.x + fx * reach;
      const az = c.z + fz * reach;
      const limit = HALF - EDGE_MARGIN;
      const aheadDepth = WATER_LEVEL - heightAt(ax, az);
      const blocked = Math.abs(ax) > limit || Math.abs(az) > limit || (aheadDepth > MAX_WADE_DEPTH && aheadDepth > depth);
      if (blocked) want = 0;

      const rate = blocked ? BRAKE : want > this.speed ? 2.4 : 4;
      this.speed += Math.min(Math.max(want - this.speed, -rate * dt), rate * dt);
    }

    c.x += fx * this.speed * dt;
    c.z += fz * this.speed * dt;
    hFore = heightAt(c.x + fx * HALF_BODY, c.z + fz * HALF_BODY);
    hHind = heightAt(c.x - fx * HALF_BODY, c.z - fz * HALF_BODY);
    const ground = (hFore + hHind) / 2;

    if (this.jumpQueued && this.grounded && this.speed > 2.5) {
      this.verticalSpeed = JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpQueued = false;

    if (this.grounded) {
      c.y = ground;
    } else {
      this.verticalSpeed -= GRAVITY * dt;
      c.y += this.verticalSpeed * dt;
      if (c.y <= ground) {
        c.y = ground;
        this.grounded = true;
        this.verticalSpeed = 0;
      }
    }
    this.heightAboveGround = c.y - ground;

    // Body follows the slope under its hooves; in the air it tips with the arc of the jump.
    const lx = fz;
    const lz = -fx;
    const hLeft = heightAt(c.x + lx * HALF_WIDTH, c.z + lz * HALF_WIDTH);
    const hRight = heightAt(c.x - lx * HALF_WIDTH, c.z - lz * HALF_WIDTH);
    const pitchTarget = this.grounded
      ? Math.atan2(hFore - hHind, 2 * HALF_BODY)
      : Math.min(0.35, Math.max(-0.35, this.verticalSpeed * 0.08));
    const rollTarget = Math.atan2(hLeft - hRight, 2 * HALF_WIDTH) * 0.7 - this.steer * this.speed * 0.018; // lean into turns
    const k = 1 - Math.exp(-dt * 8);
    c.pitch += (pitchTarget - c.pitch) * k;
    c.roll += (rollTarget - c.roll) * k;
  }

  /** Writes the pose between the last two steps (alpha 0..1) to the horse's root object. */
  applyPose(alpha: number, object: THREE.Object3D) {
    const a = this.prev;
    const b = this.cur;
    this.renderHeading = lerp(a.heading, b.heading, alpha);
    object.position.set(lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha), lerp(a.z, b.z, alpha));
    // Local +z is the horse's nose; a positive x rotation would tip the nose down.
    object.rotation.set(-lerp(a.pitch, b.pitch, alpha), this.renderHeading, lerp(a.roll, b.roll, alpha), 'YXZ');
  }

  private placeOnTrail(u: number) {
    const { trail } = this.field;
    trail.getPointAt(u, this.p);
    const t = trail.getTangentAt(u);
    const c = this.cur;
    c.x = this.p.x;
    c.z = this.p.z;
    c.y = this.field.heightAt(c.x, c.z);
    c.heading = Math.atan2(t.x, t.z);
    c.pitch = c.roll = 0;
    Object.assign(this.prev, c);
    this.trailU = u;
    this.speed = this.steer = this.verticalSpeed = 0;
    this.grounded = true;
  }

  private nearestTrailU() {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < 600; i++) {
      this.field.trail.getPointAt(i / 600, this.p);
      const d = (this.p.x - this.cur.x) ** 2 + (this.p.z - this.cur.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i / 600;
      }
    }
    return best;
  }

  /** Steers towards a point a little way ahead on the trail. */
  private autoSteer() {
    const c = this.cur;
    const reach = 6 + this.speed * 0.8;
    for (let i = 0; i < 20; i++) {
      this.field.trail.getPointAt(this.trailU, this.p);
      if (Math.hypot(this.p.x - c.x, this.p.z - c.z) > reach) break;
      this.trailU = (this.trailU + 2 / this.trailLength) % 1;
    }
    const error = wrapAngle(Math.atan2(this.p.x - c.x, this.p.z - c.z) - c.heading);
    return Math.min(1, Math.max(-1, error * 2));
  }
}
