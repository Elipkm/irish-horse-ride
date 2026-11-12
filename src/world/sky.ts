import * as THREE from 'three/webgpu';
import { cameraPosition, dot, float, length, mix, normalize, positionWorld, pow, saturate, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import { CLOUD_HEIGHT, cloudCover, noiseTexture, overcast, skyDim } from './atmosphere';
import type { Environment } from './environment';
import { WATER_LEVEL } from './heightfield';
import { windTime } from './wind';

const RADIUS = 6200;

/**
 * A layer of drifting cloud in front of the sky image: one big flat disc high above the valley that
 * moves along with the camera. Its pattern is the same one that shades the ground (atmosphere.ts),
 * so a cloud shadow on the hillside has its cloud overhead. In rain the layer closes into a grey lid.
 */
export class CloudLayer {
  readonly mesh: THREE.Mesh;

  constructor(environment: Environment) {
    const wp = positionWorld;
    const cover = cloudCover(wp.xz);
    // Wisps: a finer pattern eats into the edges so clouds are not smooth blobs.
    const wisp = texture(noiseTexture, wp.xz.div(310).add(vec2(windTime.mul(0.012), 0))).b;
    const density = saturate(cover.mul(mix(float(0.55), float(1.25), wisp)).mul(mix(float(1), float(1.5), overcast)));

    const ray = wp.sub(cameraPosition);
    const dir = normalize(ray);
    // Fade into the haze well before the disc's edge.
    const horizonFade = smoothstep(0.07, 0.24, dir.y).mul(float(1).sub(smoothstep(RADIUS * 0.62, RADIUS * 0.97, length(ray.xz))));
    const towardsSun = pow(saturate(dot(dir, uniform(environment.sunDirection))), 3);

    const horizon = vec3(uniform(environment.horizon));
    const sunHorizon = vec3(uniform(environment.sunHorizon));
    const lit = mix(horizon.mul(1.15), sunHorizon.mul(1.5), towardsSun); // thin cloud glows towards the sun
    const shaded = horizon.mul(mix(float(0.62), float(0.5), overcast)); // thick cloud is grey underneath
    const colour = mix(lit, shaded, smoothstep(0.35, 1.0, density).mul(mix(float(0.75), float(1), overcast))).mul(skyDim);

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    material.colorNode = colour;
    material.opacityNode = density.mul(horizonFade).mul(mix(float(0.8), float(0.96), overcast));
    material.fog = false;

    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 48).rotateX(-Math.PI / 2), material);
    this.mesh.position.y = WATER_LEVEL + CLOUD_HEIGHT;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10; // first of the see-through things: everything else is in front of the sky
  }

  update(camera: THREE.Camera) {
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }
}
