import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  cos,
  dot,
  exp2,
  faceDirection,
  float,
  fract,
  length,
  mix,
  positionGeometry,
  saturate,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { WATER_LEVEL, type Heightfield } from './heightfield';
import { mulberry32 } from './noise';
import { grassShade, mapUv } from './terrainMaterial';
import { windAt } from './wind';

const BLADES = 5; // per tuft, one triangle each
const LAYERS = 3;
/** Side of the innermost square of grass, in metres. Each further layer doubles it. */
const BASE_SIZE = 16;

/**
 * Grass around the camera, in one draw call and with no per-frame CPU work.
 *
 * Every instance is a tuft of a few blades. Tufts live in three nested squares (16, 32 and 64 m)
 * that slide along with the camera: a tuft that leaves one side of its square reappears on the
 * opposite side, at a position that is fixed in the world, so the grass never swims. The inner
 * square is dense with fine blades; the outer ones are sparser with broader blades, and beyond
 * them the ground texture carries on alone. The vertex shader reads the terrain maps, so grass
 * stands on the ground and stays off the trail, mud, rock and water, and is short under trees.
 */
export class Grass {
  readonly mesh: THREE.Mesh;
  private readonly camXZ = uniform(new THREE.Vector2());
  private readonly forward = uniform(new THREE.Vector2(0, 1));
  private readonly dir = new THREE.Vector3();

  constructor(field: Heightfield, grassMean: THREE.Color, tuftsPerLayer: number) {
    const tuft = attribute('tuft', 'vec4'); // x, y: place in the square (0..1) · z: random · w: layer
    const side = attribute('side', 'vec4'); // x, y: half-width direction (base corners) · z, w: lean (tip)

    // ------------------------------------------------------------ where the tuft stands
    const scale = exp2(tuft.w);
    const size = scale.mul(BASE_SIZE);
    // Centre each square ahead of the camera, so little of it is wasted behind the view.
    const centre = this.camXZ.add(this.forward.mul(size.mul(0.42).add(2)));
    const root = centre.add(fract(tuft.xy.mul(size).sub(centre).div(size).add(0.5)).sub(0.5).mul(size));
    const fade = float(1).sub(smoothstep(0.72, 1.0, length(root.sub(centre)).div(size.mul(0.5))));

    const uvMap = mapUv(root);
    const ground = texture(field.heightTexture, uvMap).level(0).r;
    const normalAo = texture(field.normalAoTexture, uvMap).level(0);
    const control = texture(field.controlTexture, uvMap).level(0);
    const nxz = normalAo.rg.mul(2).sub(1);
    const ny = sqrt(saturate(float(1).sub(dot(nxz, nxz))));
    const treeShade = float(1).sub(normalAo.a);
    const heath = smoothstep(0.3, 0.78, control.b);

    // 1 on open pasture, 0 on the trail, mud, steep rock and in the water.
    const keep = float(1)
      .sub(smoothstep(0.5, 0.7, control.r))
      .mul(float(1).sub(smoothstep(0.35, 0.6, control.g)))
      .mul(smoothstep(0.8, 0.9, ny))
      .mul(smoothstep(WATER_LEVEL + 0.05, WATER_LEVEL + 0.35, ground));
    // Thin the grass out tuft by tuft towards those edges rather than shrinking it evenly.
    const pick = fract(tuft.z.mul(7.31)).mul(0.85);
    const alive = smoothstep(pick, pick.add(0.15), keep);

    // Longer and shorter patches a few metres across, like a grazed field.
    const patch = sin(root.x.mul(0.21).add(sin(root.y.mul(0.13)).mul(2))).mul(sin(root.y.mul(0.17).add(1.3)));
    const height = float(0.15)
      .add(tuft.z.mul(0.13))
      .add(saturate(patch).mul(0.17))
      .mul(mix(1, 0.55, heath))
      .mul(mix(1, 0.6, treeShade))
      .mul(fade)
      .mul(alive);

    // ------------------------------------------------------------ the blade vertex
    const angle = tuft.z.mul(Math.PI * 2);
    const c = cos(angle);
    const s = sin(angle);
    const turn = (v: ReturnType<typeof vec2>) => vec2(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)));

    const dist = length(root.sub(this.camXZ));
    const spread = scale.mul(0.1).add(0.01); // tuft radius
    const width = scale.mul(0.011).mul(dist.mul(0.045).add(1)); // broader far away, or thin blades would shimmer
    const y = positionGeometry.y; // 0 at the base, up to 1 at the tip
    const offset = turn(positionGeometry.xz).mul(spread);
    const sway = windAt(root).mul(0.45);
    const xz = root
      .add(offset)
      .add(turn(side.xy).mul(width))
      .add(turn(side.zw).add(sway.mul(y)).mul(height));
    // Blades away from the tuft's middle follow the slope of the ground.
    const slope = dot(nxz, offset).div(ny.max(0.5)).negate();
    const position = vec3(xz.x, ground.add(slope).sub(0.02).add(y.mul(height)), xz.y);

    // ------------------------------------------------------------ colour
    // Starts from the ground's own grass colour so blades and ground texture read as one surface.
    const base = vec3(uniform(grassMean)).mul(grassShade(control.a));
    const tint = mix(vec3(1, 1, 1), vec3(0.82, 0.78, 0.55), heath).mul(fract(tuft.z.mul(13.7)).mul(0.3).add(0.85));
    const colour = mix(base.mul(0.55), base.mul(vec3(1.5, 1.55, 1.05)), y).mul(tint).mul(mix(1, 0.6, treeShade));

    const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    material.positionNode = position;
    material.colorNode = varying(colour);
    material.roughness = 0.95;
    material.metalness = 0;
    material.aoNode = varying(normalAo.b);
    // Lit like the ground underneath (not like thin upright cards), so a field shades as a whole.
    // three flips normals on back faces; multiplying by faceDirection here cancels that.
    material.normalNode = cameraViewMatrix.transformDirection(varying(vec3(nxz.x, ny, nxz.y))).mul(faceDirection);

    this.mesh = new THREE.Mesh(this.buildGeometry(tuftsPerLayer), material);
    this.mesh.frustumCulled = false; // positioned in the shader
    this.mesh.matrixAutoUpdate = false;
  }

  /** Triangles sent to the GPU each frame. */
  get triangles() {
    return (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount * BLADES;
  }

  setDensity(tuftsPerLayer: number) {
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry(tuftsPerLayer);
  }

  update(camera: THREE.Camera) {
    this.camXZ.value.set(camera.position.x, camera.position.z);
    camera.getWorldDirection(this.dir);
    const len = Math.hypot(this.dir.x, this.dir.z);
    if (len > 1e-3) this.forward.value.set(this.dir.x / len, this.dir.z / len);
  }

  private buildGeometry(tuftsPerLayer: number) {
    const rand = mulberry32(7717);
    const positions = new Float32Array(BLADES * 9);
    const sides = new Float32Array(BLADES * 12);
    for (let b = 0; b < BLADES; b++) {
      // Blades spread evenly round the tuft (golden angle), each facing and leaning its own way.
      const r = Math.sqrt((b + 0.5) / BLADES);
      const a = b * 2.4;
      const rx = r * Math.cos(a);
      const rz = r * Math.sin(a);
      const face = rand() * Math.PI;
      const lean = 0.15 + 0.3 * rand();
      const leanDir = a + (rand() - 0.5) * 2;
      const tall = 0.6 + 0.4 * rand();
      const sx = Math.cos(face);
      const sz = Math.sin(face);
      positions.set([rx, 0, rz, rx, 0, rz, rx, tall, rz], b * 9);
      sides.set([-sx, -sz, 0, 0, sx, sz, 0, 0, 0, 0, lean * Math.cos(leanDir), lean * Math.sin(leanDir)], b * 12);
    }

    // Tufts on a jittered grid: even cover without visible rows.
    const n = Math.max(1, Math.round(Math.sqrt(tuftsPerLayer)));
    const tufts = new Float32Array(LAYERS * n * n * 4);
    let k = 0;
    for (let layer = 0; layer < LAYERS; layer++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          tufts[k++] = (i + rand()) / n;
          tufts[k++] = (j + rand()) / n;
          tufts[k++] = rand();
          tufts[k++] = layer;
        }
      }
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(BLADES * 9), 3)); // unused: lit by the ground normal
    geometry.setAttribute('side', new THREE.BufferAttribute(sides, 4));
    geometry.setAttribute('tuft', new THREE.InstancedBufferAttribute(tufts, 4));
    geometry.instanceCount = LAYERS * n * n;
    return geometry;
  }
}
