import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uniform, uv } from 'three/tsl';

const saturate = (x: number) => Math.min(1, Math.max(0, x));

/** Soft dark patch on the ground under the horse: cheap grounding; there are no real-time shadows (trees shade the ground with a baked map, see world/forest.ts). */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  private readonly strength = uniform(0.6);

  constructor() {
    const material = new THREE.MeshBasicNodeMaterial({
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // Darkest in the middle, fading to nothing at the edge of the quad.
    material.opacityNode = this.strength.mul(float(1).sub(smoothstep(0.25, 1, length(uv().sub(0.5)).mul(2))));
    material.fog = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.9).rotateX(-Math.PI / 2), material);
    this.mesh.renderOrder = 1;
  }

  /** Lies on the ground below the horse and fades as the horse leaves the ground. */
  follow(horse: THREE.Object3D, heightAboveGround: number) {
    this.mesh.position.set(horse.position.x, horse.position.y - heightAboveGround + 0.05, horse.position.z);
    this.mesh.rotation.copy(horse.rotation);
    this.strength.value = 0.6 * (1 - 0.6 * saturate(heightAboveGround / 1.5));
  }
}
