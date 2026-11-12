import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/heightfield';

const MAX_PITCH = 1.35;
const damp = (from: number, to: number, rate: number, dt: number) => to + (from - to) * Math.exp(-rate * dt);

/**
 * Third-person camera behind the horse. It swings round gently in turns, widens the view a little
 * at speed, and keeps a clear line to the horse over the terrain: when a slope would get in the way
 * it first rises, and only moves closer if rising is not enough. Looking around (`look`) is added
 * on top and drifts back behind the horse once the finger is lifted.
 * Trees do not block it: leaves close to the lens dissolve instead (world/forest.ts), and trunks are
 * thin enough to look past. Buildings count as terrain for this check; low field walls do not.
 */
export class FollowCamera {
  /** Far = high overview of the horse in the valley. */
  far = false;
  /** True while a finger is down looking around: stops the view drifting back. */
  held = false;
  /** Photo mode: the view stays where it was dragged instead of drifting back behind the horse. */
  photo = false;
  /** Tall built things (abbey walls, tower, cottages) the camera must see over rather than through. */
  structures: { topAt(x: number, z: number): number } | null = null;

  private yaw = 0;
  private pitch = 0;
  private idle = 0;
  private heading = 0;
  private distance = 6.5;
  private basePitch = 0.2;
  private rush = 0;
  private lift = 0; // extra pitch added to see over terrain
  private pull = 1; // distance factor (< 1 when even the steepest view is blocked)
  private first = true;
  private readonly target = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: Heightfield
  ) {}

  /** Look around by a drag of this many pixels. */
  look(dx: number, dy: number) {
    this.yaw -= dx * 0.006;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, this.photo ? -0.25 : -0.5, 1.0);
    this.idle = 0;
  }

  update(dt: number, horse: THREE.Vector3, horseHeading: number, speed01: number) {
    const ease = (rate: number) => (this.first ? 1 : 1 - Math.exp(-dt * rate));
    this.heading += (horseHeading - this.heading) * ease(2.5);
    this.distance += ((this.far ? 17 : 6.5) - this.distance) * ease(3);
    this.basePitch += ((this.far ? 0.5 : 0.2) - this.basePitch) * ease(3);
    this.rush += (speed01 - this.rush) * ease(1.5);

    if (this.held || this.photo) {
      this.idle = 0;
    } else {
      this.idle += dt;
      if (this.idle > 1.5) {
        const decay = Math.exp(-dt * 2.5);
        this.yaw *= decay;
        this.pitch *= decay;
      }
    }

    const a = this.heading + this.yaw;
    const wanted = THREE.MathUtils.clamp(this.basePitch + this.pitch, -0.25, MAX_PITCH);
    this.target.set(horse.x, horse.y + 1.7, horse.z);

    // Smallest rise that clears the terrain; failing that, the steepest view from closer in.
    let lift = 0;
    let pull = 1;
    while (wanted + lift < MAX_PITCH && !this.clear(a, wanted + lift, this.distance)) lift += 0.05;
    if (wanted + lift >= MAX_PITCH) {
      lift = MAX_PITCH - wanted;
      while (pull > 0.3 && !this.clear(a, MAX_PITCH, this.distance * pull)) pull *= 0.85;
    }
    // Get out of the way quickly, settle back slowly.
    this.lift = this.first ? lift : damp(this.lift, lift, lift > this.lift ? 12 : 1.5, dt);
    this.pull = this.first ? pull : damp(this.pull, pull, pull < this.pull ? 12 : 1.5, dt);
    this.first = false;

    const p = wanted + this.lift;
    const d = this.distance * this.pull;
    const cam = this.camera.position;
    cam.set(this.target.x - Math.sin(a) * Math.cos(p) * d, this.target.y + Math.sin(p) * d, this.target.z - Math.cos(a) * Math.cos(p) * d);
    // Last resort while the rise catches up; also keeps the lens above the water.
    cam.y = Math.max(cam.y, this.field.heightAt(cam.x, cam.z) + 0.5, this.field.waterLevelAt(cam.x, cam.z) + 0.4);
    this.camera.lookAt(this.target);

    const fov = 58 + 9 * this.rush;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  /** Is the straight line from the horse to a camera at this angle and distance above the ground all the way? */
  private clear(angle: number, pitch: number, distance: number) {
    const sx = -Math.sin(angle) * Math.cos(pitch) * distance;
    const sy = Math.sin(pitch) * distance;
    const sz = -Math.cos(angle) * Math.cos(pitch) * distance;
    const STEPS = 9;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const x = this.target.x + sx * t;
      const z = this.target.z + sz * t;
      const ground = Math.max(this.field.heightAt(x, z), this.structures?.topAt(x, z) ?? -Infinity);
      if (this.target.y + sy * t < ground + 0.3 + 0.5 * t) return false; // more clearance nearer the camera
    }
    return true;
  }
}
