import * as THREE from 'three/webgpu';

/** A faint tall column of light over the place being sought, so it can be seen from across the valley. */
export class Beacon {
  readonly mesh: THREE.Mesh;

  constructor() {
    const material = new THREE.MeshBasicNodeMaterial({
      color: 0xfff1c8,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.4, 90, 16, 1, true), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /** Stands the column on (x, y, z), or hides it for `null`. */
  place(at: { x: number; y: number; z: number } | null) {
    this.mesh.visible = at !== null;
    if (at) this.mesh.position.set(at.x, at.y + 45, at.z);
  }
}
