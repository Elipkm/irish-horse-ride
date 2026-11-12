import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, cross, dot, float, length, normalize, positionGeometry, positionWorld, saturate, smoothstep, texture, uniform, uv, varying, vec2, vec3 } from 'three/tsl';
import { noiseTexture, overcast } from './atmosphere';
import type { Environment } from './environment';
import type { Forest } from './forest';
import { mulberry32 } from './noise';
import { windTime } from './wind';

/** Shafts further from the camera than this are not drawn. */
const RANGE = 130;

/**
 * Light shafts ("god rays") slanting down between the trees.
 *
 * Each shaft is one long, soft, glowing strip that starts beside a tree crown and runs along the
 * sun's direction to the ground, turned about its own axis to face the camera. They are brightest
 * when you look towards the sun, shimmer slowly as the mist drifts through them, and vanish under
 * a closed sky. Not a screen effect: no extra render pass, one draw call for the whole valley.
 */
export class GodRays {
  readonly mesh: THREE.Mesh;

  constructor(forest: Forest, environment: Environment) {
    const sun = environment.sunDirection;
    const p = forest.planting;
    const rand = mulberry32(31337);
    const across = new THREE.Vector3(-sun.z, 0, sun.x).normalize(); // level, at right angles to the light
    const starts: number[] = [];
    const shapes: number[] = [];
    for (let t = 0; t < p.count; t++) {
      const pick = rand();
      const side = rand() < 0.5 ? -1 : 1;
      const offset = 0.75 + 0.5 * rand();
      const high = 0.62 + 0.25 * rand();
      const wide = 1.1 + 1.6 * rand();
      const seed = rand();
      const size = forest.speciesSize[p.species[t]];
      if (!size.tree || pick > 0.17) continue;
      // The gap beside the crown where light gets through, then down the light's path to the ground.
      const drop = size.height * p.scale[t] * high;
      const lengthToGround = Math.min(48, drop / Math.max(0.2, sun.y));
      const x = p.x[t] + across.x * side * offset * size.radius * p.scale[t];
      const z = p.z[t] + across.z * side * offset * size.radius * p.scale[t];
      starts.push(x + sun.x * 2, p.y[t] + drop + sun.y * 2, z + sun.z * 2, lengthToGround + 2);
      shapes.push(wide, seed);
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('rayStart', new THREE.InstancedBufferAttribute(new Float32Array(starts), 4));
    geometry.setAttribute('rayShape', new THREE.InstancedBufferAttribute(new Float32Array(shapes), 2));
    geometry.instanceCount = shapes.length / 2;

    const start = attribute('rayStart', 'vec4');
    const shape = attribute('rayShape', 'vec2');
    const axis = vec3(uniform(sun)).negate();
    const middle = start.xyz.add(axis.mul(start.w.mul(0.5)));
    const shown = float(1).sub(smoothstep(RANGE * 0.75, RANGE, length(cameraPosition.sub(middle))));
    const centre = start.xyz.add(axis.mul(positionGeometry.y.mul(start.w)));
    const sideways = normalize(cross(axis, cameraPosition.sub(centre)));
    // Wider towards the ground, as light spreads in mist.
    const width = shape.x.mul(positionGeometry.y.mul(0.6).add(0.7)).mul(shown);

    const u = uv().x.mul(2).sub(1);
    const v = uv().y;
    const profile = float(1).sub(u.mul(u)).pow(2).mul(smoothstep(0.0, 0.18, v)).mul(float(1).sub(smoothstep(0.7, 1.0, v)));
    const shimmer = texture(noiseTexture, vec2(uv().x.mul(0.22).add(shape.y.mul(7)), v.mul(0.04).add(shape.y.mul(3)).add(windTime.mul(0.006)))).b;
    const toPixel = positionWorld.sub(cameraPosition);
    const distance = length(toPixel);
    // Light scatters forwards: shafts glow when the sun is ahead and all but vanish with it behind you.
    const forward = saturate(dot(toPixel.div(distance), vec3(uniform(sun))).mul(0.5).add(0.5));
    const glow = forward.mul(forward).mul(0.85).add(0.15);
    const near = smoothstep(3, 14, distance); // never a bright sheet right in front of the lens

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    material.positionNode = centre.add(sideways.mul(positionGeometry.x.mul(width)));
    material.colorNode = vec3(uniform(environment.sunHorizon)).mul(0.24);
    material.opacityNode = profile
      .mul(shimmer.mul(0.9).add(0.35))
      .mul(glow)
      .mul(near)
      .mul(varying(shown))
      .mul(float(1).sub(overcast))
      .mul(0.3);
    material.fog = false;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
  }

  get count() {
    return (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
  }
}
