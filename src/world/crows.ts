import * as THREE from 'three/webgpu';
import { attribute, cos, positionGeometry, sin, vec3 } from 'three/tsl';
import { mulberry32 } from './noise';
import { windTime } from './wind';

/**
 * A few crows wheeling round a high point (the abbey's tower). Each is a body and two flapping
 * wings, flying a tilted circle of its own; all of it is worked out in the vertex shader, so the
 * birds cost one small draw call and no per-frame work.
 */
export class Crows {
  readonly mesh: THREE.Mesh;

  constructor(centre: THREE.Vector3, count = 9) {
    const rand = mulberry32(1313);
    const orbit = new Float32Array(count * 4); // radius, height above the centre, speed (rad/s, signed), phase
    for (let i = 0; i < count; i++) {
      const radius = 6 + rand() * 30;
      orbit.set([radius, -3 + rand() * 12, ((rand() < 0.5 ? -1 : 1) * (5.5 + rand() * 2.5)) / radius, rand() * 6.283], i * 4);
    }
    // Nose towards +z. `flap` is 1 at the wing tips.
    const positions = [0, 0, 0.28, -0.07, 0, -0.05, 0.07, 0, -0.05, 0, 0, -0.34, 0.07, 0, -0.05, -0.07, 0, -0.05];
    const flap = [0, 0, 0, 0, 0, 0];
    for (const side of [-1, 1]) {
      positions.push(side * 0.05, 0, 0.16, side * 0.05, 0, -0.1, side * 0.52, 0, -0.04);
      flap.push(0, 0, 1);
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('flap', new THREE.Float32BufferAttribute(flap, 1));
    geometry.setAttribute('orbit', new THREE.InstancedBufferAttribute(orbit, 4));
    geometry.instanceCount = count;

    const o = attribute('orbit', 'vec4');
    const angle = o.w.add(windTime.mul(o.z));
    // Long glides with bursts of flapping.
    const beat = sin(windTime.mul(9).add(o.w.mul(5))).mul(sin(windTime.mul(0.7).add(o.w)).mul(0.5).add(0.6).clamp(0.15, 1));
    const p = positionGeometry;
    const wing = attribute('flap', 'float');
    const local = vec3(p.x.mul(wing.mul(beat.abs().mul(-0.25)).add(1)), wing.mul(beat).mul(0.3), p.z);
    // Fly along the circle's tangent: forward is (-sin, cos) × direction of travel.
    const dir = o.z.sign();
    const fx = sin(angle).negate().mul(dir);
    const fz = cos(angle).mul(dir);
    const world = vec3(local.x.mul(fz).add(local.z.mul(fx)), local.y, local.z.mul(fz).sub(local.x.mul(fx)));
    const bob = sin(windTime.mul(0.4).add(o.w.mul(3))).mul(1.5);

    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, color: 0x050506 });
    material.positionNode = vec3(centre.x, centre.y, centre.z).add(vec3(cos(angle).mul(o.x), o.y.add(bob), sin(angle).mul(o.x))).add(world.mul(1.5));

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }
}
