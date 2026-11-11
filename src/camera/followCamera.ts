import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/heightfield';

/**
 * Simple third-person camera behind the horse: swings round gently in turns, never dips below the
 * ground, widens the view a little at speed. Drag to look around; it drifts back behind the horse.
 * Milestone 4 replaces this with the full touch camera (obstacle avoidance comes with the forest).
 */
export class FollowCamera {
  /** Far = high overview of the horse in the valley. */
  far = false;

  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private idle = 0;
  private lastX = 0;
  private lastY = 0;
  private heading = 0;
  private distance = 6.5;
  private basePitch = 0.2;
  private rush = 0;
  private first = true;
  private readonly target = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: Heightfield,
    dom: HTMLElement
  ) {
    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.lastY) * 0.004, -0.5, 1.0);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.idle = 0;
    });
    const end = () => (this.dragging = false);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
  }

  update(dt: number, horse: THREE.Vector3, horseHeading: number, speed01: number) {
    const ease = (rate: number) => (this.first ? 1 : 1 - Math.exp(-dt * rate));
    this.heading += (horseHeading - this.heading) * ease(2.5);
    this.distance += ((this.far ? 17 : 6.5) - this.distance) * ease(3);
    this.basePitch += ((this.far ? 0.5 : 0.2) - this.basePitch) * ease(3);
    this.rush += (speed01 - this.rush) * ease(1.5);
    this.first = false;

    if (!this.dragging) {
      this.idle += dt;
      if (this.idle > 1.5) {
        const decay = Math.exp(-dt * 2.5);
        this.yaw *= decay;
        this.pitch *= decay;
      }
    }

    const a = this.heading + this.yaw;
    const p = THREE.MathUtils.clamp(this.basePitch + this.pitch, -0.25, 1.3);
    this.target.set(horse.x, horse.y + 1.7, horse.z);
    const cam = this.camera.position;
    cam.set(
      this.target.x - Math.sin(a) * Math.cos(p) * this.distance,
      this.target.y + Math.sin(p) * this.distance,
      this.target.z - Math.cos(a) * Math.cos(p) * this.distance
    );
    cam.y = Math.max(cam.y, this.field.heightAt(cam.x, cam.z) + 0.7);
    this.camera.lookAt(this.target);

    const fov = 58 + 9 * this.rush;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
