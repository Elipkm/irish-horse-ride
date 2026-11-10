import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/heightfield';

export const PACES = [
  { name: 'Canter', speed: 6.5 },
  { name: 'Gallop', speed: 12.5 },
  { name: 'Stop', speed: 0 },
  { name: 'Walk', speed: 1.7 },
  { name: 'Trot', speed: 3.8 },
] as const;

const EYE_HEIGHT = 2.4; // rider's eye level above the ground

/**
 * Milestone 2 stand-in for the horse: carries the camera around the trail at riding speeds so the
 * valley can be judged (and fps measured) on the iPad. Drag to look around; the view recentres
 * by itself. Replaced by the real horse controller and follow camera in M3/M4.
 */
export class TourCamera {
  paceIndex = 0;
  birdView = false;

  private u = 0;
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private idle = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly length: number;
  private readonly pos = new THREE.Vector3();
  private readonly ahead = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private first = true;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: Heightfield,
    dom: HTMLElement
  ) {
    field.trail.arcLengthDivisions = 3000;
    this.length = field.trail.getLength();

    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - this.lastY) * 0.004, -0.9, 0.7);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.idle = 0;
    });
    const end = () => (this.dragging = false);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
  }

  get pace() {
    return PACES[this.paceIndex];
  }

  nextPace() {
    this.paceIndex = (this.paceIndex + 1) % PACES.length;
  }

  update(dt: number) {
    this.u = (this.u + (this.pace.speed * dt) / this.length) % 1;
    const { trail, heightAt } = this.field;

    trail.getPointAt(this.u, this.pos);
    const lookAhead = this.birdView ? 140 : 18;
    trail.getPointAt((this.u + lookAhead / this.length) % 1, this.ahead);

    if (this.birdView) {
      const back = this.pos.clone().sub(this.ahead).setY(0).normalize();
      this.eye.copy(this.pos).addScaledVector(back, 90);
      this.eye.y = Math.max(heightAt(this.eye.x, this.eye.z) + 25, this.pos.y + 75);
      this.target.copy(this.ahead);
    } else {
      this.eye.set(this.pos.x, heightAt(this.pos.x, this.pos.z) + EYE_HEIGHT, this.pos.z);
      this.target.set(this.ahead.x, heightAt(this.ahead.x, this.ahead.z) + EYE_HEIGHT - 0.5, this.ahead.z);
    }

    // Ease position and aim so trail kinks and view switches never snap.
    const k = this.first ? 1 : 1 - Math.exp(-dt * (this.birdView ? 2.5 : 8));
    this.camera.position.lerp(this.eye, k);
    this.smoothTarget.lerp(this.target, this.first ? 1 : 1 - Math.exp(-dt * 3));
    this.first = false;
    this.camera.lookAt(this.smoothTarget);

    // Look-around offset from dragging; drifts back to straight ahead after a short pause.
    if (!this.dragging) {
      this.idle += dt;
      if (this.idle > 1.5) {
        const decay = Math.exp(-dt * 2.5);
        this.yaw *= decay;
        this.pitch *= decay;
      }
    }
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.y += this.yaw;
    this.euler.x = THREE.MathUtils.clamp(this.euler.x + this.pitch, -1.45, 1.45);
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.updateMatrixWorld();
  }
}
