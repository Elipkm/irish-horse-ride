import * as THREE from 'three/webgpu';
import {
  abs,
  asin,
  atan2,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  saturate,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { noiseTexture, rainAmount, skyDim } from './atmosphere';
import type { Environment } from './environment';
import { RIVER_HALF_WIDTH, RIVER_STEP, RIVER_Z0, WATER_LEVEL, riverX, type Heightfield } from './heightfield';
import { mapUv } from './terrainMaterial';
import { windStrength, windTime } from './wind';

type Vec3Node = ReturnType<typeof vec3>;
type FloatNode = ReturnType<typeof float>;

/** Metres per second the river's ripples and foam travel downstream. */
const FLOW_SPEED = 1.1;
/** Reflections look this far for hills, in metres. */
const REFLECTION_REACH = 900;

export interface WaterQuality {
  /** How many points along each reflected ray are tested against the hills (0 = reflect the sky only). */
  reflectionSteps: number;
  /** Also reflect the woods (one more texture read per step). */
  reflectTrees: boolean;
}

/**
 * The lake and the river, in one draw call.
 *
 * The surface is a flat sheet (lake) plus a ribbon that follows the river downhill. Everything
 * else happens per pixel: moving ripples, a reflection of the sky image, and the hills and woods
 * mirrored by walking a few steps along the reflected ray over the terrain's height map (no second
 * render of the scene, which the iPad could not afford). The same height map gives the water's
 * depth, so the shallows are clear, the deep is dark, and foam gathers along the shore and where
 * the river runs steep.
 */
export class Water {
  readonly mesh: THREE.Mesh;

  constructor(
    private readonly field: Heightfield,
    private readonly environment: Environment,
    quality: WaterQuality
  ) {
    this.mesh = new THREE.Mesh(this.buildGeometry(), this.buildMaterial(quality));
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5; // before the other see-through things (shadow blob, light shafts, particles)
  }

  setQuality(quality: WaterQuality) {
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.material = this.buildMaterial(quality);
  }

  private buildGeometry() {
    const { field } = this;
    const positions: number[] = [];
    const wuv: number[] = []; // x, y: ripple coordinates in metres · z: 1 on the river (flows), 0 on the lake
    const wfx: number[] = []; // x: opacity (fades the river's two ends) · y: white water (steep stretches)
    const indices: number[] = [];

    // Lake: one rectangle; the terrain hides whatever lies outside the basin.
    const { x: lx, z: lz } = field.lakeCentre;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = lx + sx * 280;
      const z = lz + sz * 360;
      positions.push(x, WATER_LEVEL, z);
      wuv.push(x, z, 0);
      wfx.push(1, 0);
    }
    indices.push(0, 2, 1, 0, 3, 2);

    // River: a ribbon, level from bank to bank, stepping down with the river's long profile.
    const surface = field.riverSurface;
    let last = surface.length - 1;
    while (last > 0 && surface[last - 1] <= WATER_LEVEL + 0.01) last--; // ends where it meets the lake
    const STRIDE = 2; // one cross-section every 4 m
    const rows = Math.floor(last / STRIDE) + 1;
    let along = 0;
    for (let r = 0; r < rows; r++) {
      const k = r * STRIDE;
      const z = RIVER_Z0 + k * RIVER_STEP;
      const x = riverX(z);
      if (r > 0) {
        const zPrev = z - STRIDE * RIVER_STEP;
        along += Math.hypot(x - riverX(zPrev), z - zPrev);
      }
      const drop = (surface[Math.max(0, k - STRIDE)] - surface[Math.min(last, k + STRIDE)]) / (2 * STRIDE * RIVER_STEP);
      const white = Math.min(1, Math.max(0, (drop - 0.015) / 0.04));
      const fade = Math.min(1, r / 6, (rows - 1 - r) / 5);
      for (const side of [-1, 1]) {
        positions.push(x + side * RIVER_HALF_WIDTH, surface[k], z);
        wuv.push(side * RIVER_HALF_WIDTH, along, 1);
        wfx.push(fade, white);
      }
      if (r > 0) {
        const a = 4 + (r - 1) * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('wuv', new THREE.Float32BufferAttribute(wuv, 3));
    geometry.setAttribute('wfx', new THREE.Float32BufferAttribute(wfx, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  private buildMaterial(quality: WaterQuality) {
    const { field, environment } = this;
    const wuv = attribute('wuv', 'vec3');
    const wfx = attribute('wfx', 'vec2');
    const t = windTime;
    const river = wuv.z;
    const p = vec2(wuv.x, wuv.y.sub(river.mul(t).mul(FLOW_SPEED))); // the river's pattern slides downstream
    const wp = positionWorld;

    // ------------------------------------------------------------ ripples
    // Two layers of the ripple map moving against each other, plus rain dimples.
    const broad = texture(noiseTexture, p.div(11).add(vec2(t.mul(0.011), t.mul(0.007)))).rg.sub(0.5);
    const fine = texture(noiseTexture, vec2(p.y, p.x).div(3.7).add(vec2(t.mul(-0.03), t.mul(0.021)))).gr.sub(0.5);
    const dimples = texture(noiseTexture, p.div(0.9).add(vec2(t.mul(0.9), t.mul(-0.7)))).rg.sub(0.5);
    const calm = mix(float(0.16), float(0.5), river).mul(windStrength.mul(0.5).add(0.5));
    const slope = broad.mul(0.9).add(fine.mul(0.7)).mul(calm).add(dimples.mul(rainAmount.mul(0.5)));
    const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));

    const toEye = cameraPosition.sub(wp);
    const view = normalize(toEye);
    const facing = saturate(dot(normal, view));
    const mirrored = reflect(view.negate(), normal);
    const ray = normalize(vec3(mirrored.x, abs(mirrored.y).add(0.015), mirrored.z));
    // The hills are looked up along a much less ruffled ray: their mirror image wobbles a little
    // but stays in one piece, while the ripples shimmer in the reflected sky.
    const calmNormal = normalize(vec3(slope.x.mul(-0.2), 1, slope.y.mul(-0.2)));
    const calmMirrored = reflect(view.negate(), calmNormal);
    const calmRay = normalize(vec3(calmMirrored.x, abs(calmMirrored.y).add(0.015), calmMirrored.z));

    // ------------------------------------------------------------ what the surface mirrors
    const ambient = vec3(uniform(environment.horizon)).mul(skyDim);
    // The sun itself is thousands of times brighter than the sky; capped, so its glitter does not turn into single white pixels.
    // Same lookup the engine uses for the sky background.
    const skyUv = vec2(atan2(ray.z, ray.x).div(Math.PI * 2).add(0.5), asin(ray.y.clamp(-1, 1)).div(Math.PI).add(0.5));
    let mirror: Vec3Node = texture(environment.sky, skyUv).rgb.min(vec3(24, 24, 24)).mul(skyDim);
    {
      const hillside = ambient.mul(vec3(0.15, 0.2, 0.08));
      const haze = environment.fog.baseDensity as unknown as FloatNode;
      const mist = environment.fog.mistDensity as unknown as FloatNode;
      const steps = quality.reflectionSteps;
      const ratio = steps > 1 ? Math.pow(REFLECTION_REACH / 4, 1 / (steps - 1)) : 1;
      let open: FloatNode = float(1); // how much of the ray is still unblocked
      for (let i = 0; i < steps; i++) {
        const reach = 4 * ratio ** i;
        const q = wp.add(calmRay.mul(reach));
        const uvq = mapUv(q.xz);
        let top: FloatNode = texture(field.heightTexture, uvq).level(0).r;
        // The baked tree shade tells where woods stand; treat them as about 9 m tall.
        if (quality.reflectTrees) top = top.add(float(1).sub(texture(field.normalAoTexture, uvq).level(1).a).mul(9));
        const blocked = smoothstep(0, 0.4 + reach * 0.05, top.sub(q.y));
        const veil = float(1).sub(exp(haze.add(mist.mul(0.6)).mul(-reach * 1.3)));
        mirror = mix(mirror, mix(hillside, ambient, veil), blocked.mul(open));
        open = open.mul(float(1).sub(blocked));
      }
    }

    // A small river mirrors its banks and trees more than open sky, and its surface is broken into
    // lines by the current: darker than the lake, with streaks of light sliding downstream.
    const current = texture(noiseTexture, vec2(p.x.div(2.1), p.y.div(9))).a;
    mirror = mirror.mul(mix(float(1), current.mul(0.45).add(0.2), river));

    // ------------------------------------------------------------ the water itself
    const depth = wp.y.sub(texture(field.heightTexture, mapUv(wp.xz)).level(0).r);
    const deep = saturate(depth.div(1.6));
    const body = mix(vec3(0.085, 0.07, 0.04), vec3(0.016, 0.024, 0.02), deep).mul(ambient); // peaty: brown in the shallows
    const bodyOpacity = float(1).sub(exp(depth.max(0).mul(mix(float(-2.4), float(-1.5), river)))).mul(smoothstep(0.0, 0.05, depth));

    // Foam: a broken line that breathes in and out along the shore, and streaks on steep water.
    const froth = texture(noiseTexture, p.div(2.3).add(vec2(t.mul(0.02), t.mul(-0.015)))).a;
    const lap = sin(t.mul(0.9).add(wp.x.mul(0.21)).add(wp.z.mul(0.17))).mul(0.05);
    const shore = float(1).sub(smoothstep(0.015, lap.add(0.085), depth)).mul(smoothstep(0.0, 0.015, depth));
    const streaks = texture(noiseTexture, vec2(p.x.div(1.6), p.y.div(5.5))).b;
    const foam = saturate(
      smoothstep(0.4, 0.62, froth).mul(shore).mul(0.7).add(smoothstep(0.56, 0.8, streaks.mul(0.65).add(froth.mul(0.35)).add(wfx.y.mul(0.1))).mul(wfx.y).mul(0.75))
    ).mul(0.8);
    const surfaceColour = mix(body, ambient.mul(0.5), foam);
    const surfaceOpacity = bodyOpacity.max(foam);

    // Fresnel: looking down you see into the water, looking along it you see the mirror. Ruffled
    // water never mirrors fully (the river less than the lake), and a film of water at the very
    // edge does not mirror at all, so the shore line stays soft.
    const fresnel = float(0.02)
      .add(pow(float(1).sub(facing), 5).mul(0.98))
      .min(mix(float(0.8), float(0.42), river))
      .mul(float(1).sub(foam))
      .mul(smoothstep(0.0, 0.14, depth));
    const opacity = fresnel.add(float(1).sub(fresnel).mul(surfaceOpacity));
    const colour = mirror.mul(fresnel).add(surfaceColour.mul(float(1).sub(fresnel).mul(surfaceOpacity))).div(opacity.max(1e-3));

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.colorNode = colour;
    material.opacityNode = opacity.mul(wfx.x);
    return material;
  }
}
