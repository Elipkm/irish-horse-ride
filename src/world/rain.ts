import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, cross, float, fract, length, normalize, positionGeometry, smoothstep, uniform, uv, varying, vec3 } from 'three/tsl';
import { rainAmount, skyDim } from './atmosphere';
import type { Environment } from './environment';
import { mulberry32 } from './noise';
import { windTime } from './wind';

/** The rain falls inside a box of this size (metres) that travels with the camera. */
const BOX = new THREE.Vector3(26, 16, 26);
/** Fall velocity in m/s: light rain, pushed along by the wind. */
const FALL = new THREE.Vector3(1.9, -8.5, 1.3);
const STREAK = 0.5; // length of one streak in metres

/**
 * Light rain: thin streaks around the camera, in one draw call with no per-frame CPU work.
 * Each drop has a fixed place in a box that repeats through the world; as the camera moves or the
 * drop falls out of the box it comes back in on the opposite side, so the rain never runs out.
 */
export class Rain {
  readonly mesh: THREE.Mesh;

  constructor(environment: Environment, drops: number) {
    const seed = attribute('drop', 'vec4');
    const box = vec3(uniform(BOX));
    const fall = vec3(uniform(FALL));
    // Nearer drops would streak across the whole screen: keep the box centred a little ahead.
    const centre = cameraPosition;
    const fallen = seed.xyz.mul(box).add(fall.mul(windTime.mul(seed.w.mul(0.3).add(0.85))));
    const drop = centre.add(fract(fallen.sub(centre).div(box).add(0.5)).sub(0.5).mul(box));
    const along = normalize(fall);
    const sideways = normalize(cross(along, cameraPosition.sub(drop)));
    const distance = length(drop.sub(cameraPosition));
    const width = distance.mul(0.0011).add(0.004); // about a pixel wide whatever the distance
    const position = drop.add(along.mul(positionGeometry.y.mul(STREAK))).add(sideways.mul(positionGeometry.x.mul(width)));
    // Fade at the edge of the box and right at the lens.
    const visible = float(1).sub(smoothstep(0.38, 0.5, length(drop.sub(centre).div(box)))).mul(smoothstep(0.6, 2.5, distance));

    const v = uv().y;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.positionNode = position;
    material.colorNode = vec3(uniform(environment.horizon)).mul(skyDim).mul(1.25);
    material.opacityNode = varying(visible).mul(v.mul(float(1).sub(v)).mul(4)).mul(rainAmount).mul(0.34);
    material.fog = false;

    this.mesh = new THREE.Mesh(this.buildGeometry(drops), material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  setDrops(drops: number) {
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry(drops);
  }

  /** Call once per frame: the streaks are not drawn at all in dry weather. */
  update() {
    this.mesh.visible = rainAmount.value > 0.01;
  }

  private buildGeometry(drops: number) {
    const rand = mulberry32(606);
    const seeds = new Float32Array(drops * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('drop', new THREE.InstancedBufferAttribute(seeds, 4));
    geometry.instanceCount = drops;
    return geometry;
  }
}
