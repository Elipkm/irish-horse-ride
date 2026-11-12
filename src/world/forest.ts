import * as THREE from 'three/webgpu';
import {
  atan2,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  dot,
  faceDirection,
  float,
  floor,
  length,
  mix,
  normalize,
  positionGeometry,
  positionView,
  round,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { cloudShade } from './atmosphere';
import { createFoliageTexture } from './foliageTextures';
import { FOREST_CELL, FOREST_CELLS, SPECIES, plantForest, type Planting } from './forestPlacement';
import { CELL, GRID, HALF, type Heightfield } from './heightfield';
import { buildTree, type TreeModel } from './treeModels';
import { windAt, windStrength, windTime } from './wind';

type Vec3Node = ReturnType<typeof vec3>;
type FloatNode = ReturnType<typeof float>;

/** Each tree is photographed from this many directions for its distant stand-in. */
const ANGLES = 8;
/** Size in pixels of one such picture. */
const FRAME = 256;
/** Most full-detail trees of one species drawn at once. */
const MAX_NEAR = 320;

export interface BarkTextures {
  oak: THREE.Texture;
  pine: THREE.Texture;
}

interface SpeciesDraw {
  model: TreeModel;
  /** World size covered by one impostor picture of an unscaled tree. */
  frameWidth: number;
  frameHeight: number;
  /** Per full-detail tree: a = x, y, z, turn · b = scale, tone. */
  a: Float32Array;
  b: Float32Array;
  attrA: THREE.InstancedBufferAttribute;
  attrB: THREE.InstancedBufferAttribute;
  meshes: THREE.Mesh[];
  count: number;
}

/** Slight colour difference from tree to tree: 0 = cooler and darker, 1 = warmer and lighter. */
const toneOf = (t: FloatNode) => mix(vec3(0.84, 0.9, 0.82), vec3(1.14, 1.08, 0.9), t);

/**
 * All trees and bushes of the valley.
 *
 * Near the camera a tree is a real model (trunk, branches, leaf cards) that sways in the wind,
 * drawn with GPU instancing: one draw call per species for the wood and one for the leaves.
 * Beyond `nearRange` it is an impostor: a single upright rectangle showing a picture of the tree
 * taken from the nearest of eight directions. The pictures store colour and surface direction
 * rather than finished lighting, so impostors are lit and fogged exactly like the real models.
 * Every impostor in the valley goes out in one draw call.
 */
export class Forest {
  readonly group = new THREE.Group();
  readonly planting: Planting;
  /** Per species (index as in the planting): unscaled height and crown radius in metres; `tree` is false for bushes. */
  readonly speciesSize: { height: number; radius: number; tree: boolean }[];
  /** Triangles of full-detail trees drawn in the last update. */
  nearTriangles = 0;
  nearTrees = 0;

  private readonly draws: SpeciesDraw[];
  private readonly nearRange = uniform(40);
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  constructor(renderer: THREE.WebGPURenderer, field: Heightfield, bark: BarkTextures, sunDirection: THREE.Vector3) {
    this.planting = plantForest(field);
    const models = SPECIES.map((kind) => buildTree(kind));
    this.speciesSize = models.map((m) => ({ height: m.height, radius: m.radius, tree: m.trunkRadius > 0 }));
    const leafTextures = models.map((m) => createFoliageTexture(m.kind));

    // ---------------------------------------------------------------- colours shared by models and pictures
    const woodColour = (model: TreeModel): Vec3Node => {
      const rooted = smoothstep(-0.2, 1.3, positionGeometry.y).mul(0.45).add(0.55); // darker where the trunk meets the ground
      if (model.kind === 'pine') return texture(bark.pine, uv()).rgb.mul(vec3(1.15, 0.9, 0.74)).mul(rooted);
      const oak = texture(bark.oak, uv()).rgb;
      if (model.kind === 'birch') {
        // No birch bark scan: turn the oak bark into pale bark with dark cracks.
        const luma = dot(oak, vec3(0.3, 0.6, 0.1));
        return mix(vec3(0.06, 0.055, 0.05), vec3(0.74, 0.72, 0.68), smoothstep(0.02, 0.13, luma)).mul(rooted);
      }
      return oak.mul(vec3(0.95, 0.9, 0.8)).mul(rooted);
    };
    const leafSample = (i: number) => texture(leafTextures[i], uv());
    const leafShade = attribute('leaf', 'vec2').y;

    // ---------------------------------------------------------------- full-detail trees
    this.draws = models.map((model, i) => {
      const a = new Float32Array(MAX_NEAR * 4);
      const b = new Float32Array(MAX_NEAR * 2);
      const attrA = new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage);
      const attrB = new THREE.InstancedBufferAttribute(b, 2).setUsage(THREE.DynamicDrawUsage);

      const A = attribute('treeA', 'vec4');
      const B = attribute('treeB', 'vec2');
      const c = cos(A.w);
      const s = sin(A.w);
      const turn = (v: Vec3Node) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
      // The whole tree leans with the wind, most at the top; leaves also tremble on their own.
      const lean = positionGeometry.y.div(model.height).max(0).pow(2).mul(model.height * 0.014);
      const bend = windAt(A.xz).mul(lean);
      const standing = A.xyz.add(turn(positionGeometry).mul(B.x)).add(vec3(bend.x, 0, bend.y));
      const phase = attribute('leaf', 'vec2').x.mul(Math.PI * 2).add(A.x);
      const tremble = vec3(
        sin(windTime.mul(2.1).add(phase)),
        sin(windTime.mul(1.7).add(phase.mul(1.7))).mul(0.6),
        cos(windTime.mul(2.4).add(phase.mul(1.3)))
      ).mul(windStrength.mul(0.045));
      const normalView = cameraViewMatrix.transformDirection(varying(turn(attribute('normal', 'vec3'))));
      const tone = varying(toneOf(B.y).mul(cloudShade(A.xz)));

      const instanced = (source: THREE.BufferGeometry) => {
        const g = new THREE.InstancedBufferGeometry();
        g.setIndex(source.index);
        for (const [name, attr] of Object.entries(source.attributes)) g.setAttribute(name, attr);
        g.setAttribute('treeA', attrA);
        g.setAttribute('treeB', attrB);
        g.instanceCount = 0;
        return g;
      };
      const meshes: THREE.Mesh[] = [];
      const addMesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
        const mesh = new THREE.Mesh(instanced(geometry), material);
        mesh.frustumCulled = false; // trees are chosen per frame in update()
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        meshes.push(mesh);
        this.group.add(mesh);
      };

      if (model.wood) {
        const wood = new THREE.MeshStandardNodeMaterial();
        wood.positionNode = standing;
        wood.colorNode = woodColour(model).mul(tone);
        wood.normalNode = normalView;
        wood.roughness = 0.9;
        wood.metalness = 0;
        addMesh(model.wood, wood);
      }
      const leaves = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.3 });
      leaves.positionNode = standing.add(tremble);
      leaves.colorNode = leafSample(i).rgb.mul(leafShade).mul(tone);
      // Leaves right in front of the camera dissolve, so riding under a crown does not blind the view.
      leaves.opacityNode = leafSample(i).a.mul(smoothstep(1.2, 2.6, positionView.z.negate()));
      leaves.normalNode = normalView.mul(faceDirection); // cancels three's flip on back faces
      leaves.roughness = 1; // no sheen: at a glancing angle it turned crowns pale
      leaves.metalness = 0;
      addMesh(model.leaves, leaves);

      return { model, frameWidth: model.radius * 2 * 1.05, frameHeight: model.height * 1.03, a, b, attrA, attrB, meshes, count: 0 };
    });

    // ---------------------------------------------------------------- impostor pictures
    const rows = models.length;
    const bake = (pass: 'colour' | 'normal') => {
      const scene = new THREE.Scene();
      const materials: THREE.Material[] = [];
      this.draws.forEach((draw, row) => {
        const { model } = draw;
        const wood = new THREE.MeshBasicNodeMaterial();
        const leaves = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.3 });
        if (pass === 'colour') {
          wood.colorNode = woodColour(model);
          leaves.colorNode = leafSample(row).rgb.mul(leafShade);
        } else {
          wood.colorNode = leaves.colorNode = normalize(attribute('normal', 'vec3')).mul(0.5).add(0.5);
        }
        leaves.opacityNode = leafSample(row).a;
        wood.fog = leaves.fog = false;
        materials.push(wood, leaves);
        // One copy per direction, each turned to show that side and squeezed into a 1 × 1 cell.
        for (let k = 0; k < ANGLES; k++) {
          const cell = new THREE.Group();
          cell.position.set(k + 0.5, row, 0);
          cell.scale.set(1 / draw.frameWidth, 1 / draw.frameHeight, 1 / draw.frameWidth);
          const spun = new THREE.Group();
          spun.rotation.y = (-k * Math.PI * 2) / ANGLES;
          if (model.wood) spun.add(new THREE.Mesh(model.wood, wood));
          spun.add(new THREE.Mesh(model.leaves, leaves));
          cell.add(spun);
          scene.add(cell);
        }
      });
      const target = new THREE.RenderTarget(ANGLES * FRAME, rows * FRAME, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      const camera = new THREE.OrthographicCamera(0, ANGLES, rows, 0, 0.1, 20);
      camera.position.set(0, 0, 10);
      // Transparent surroundings in a foliage-like colour, so shrunken pictures do not get dark rims.
      renderer.setClearColor(pass === 'colour' ? new THREE.Color(0.03, 0.06, 0.015) : new THREE.Color(0.5, 0.85, 0.5), 0);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      for (const m of materials) m.dispose();
      return target.texture;
    };
    const colourAtlas = bake('colour');
    const normalAtlas = bake('normal');
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1); // back to the default; the game itself always draws the sky

    // ---------------------------------------------------------------- impostors: every plant, one draw call
    {
      const p = this.planting;
      const a = new Float32Array(p.count * 4);
      const b = new Float32Array(p.count * 4);
      for (let i = 0; i < p.count; i++) {
        const draw = this.draws[p.species[i]];
        a.set([p.x[i], p.y[i], p.z[i], p.turn[i]], i * 4);
        b.set([draw.frameWidth * p.scale[i], draw.frameHeight * p.scale[i], p.species[i], p.tone[i]], i * 4);
      }
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      geometry.setAttribute('impA', new THREE.InstancedBufferAttribute(a, 4));
      geometry.setAttribute('impB', new THREE.InstancedBufferAttribute(b, 4));
      geometry.instanceCount = p.count;

      const A = attribute('impA', 'vec4');
      const B = attribute('impB', 'vec4');
      const toCamera = cameraPosition.xz.sub(A.xz);
      const shown = step(this.nearRange, length(toCamera)); // 0 where the real model stands in
      const facing = atan2(toCamera.x, toCamera.y); // compass direction from the tree to the camera
      const corner = positionGeometry;
      const right = vec3(cos(facing), 0, sin(facing).negate());
      const position = A.xyz
        .add(right.mul(corner.x.mul(B.x).mul(shown)))
        .add(vec3(0, corner.y.mul(B.y).mul(shown), 0));
      // Which of the eight pictures: the direction we look from, measured in the tree's own turn.
      const picture = round(facing.sub(A.w).div((Math.PI * 2) / ANGLES));
      const column = picture.sub(floor(picture.div(ANGLES)).mul(ANGLES));
      // Row 0 was drawn at the bottom of the sheet; a rendered texture has v = 0 at its top.
      const atlasUv = varying(
        vec2(column.add(0.5).add(corner.x.mul(0.985)).div(ANGLES), float(1).sub(B.z.add(corner.y.mul(0.99)).div(rows)))
      );
      const c = varying(cos(A.w));
      const s = varying(sin(A.w));
      const n = texture(normalAtlas, atlasUv).rgb.mul(2).sub(1);
      const normalWorld = normalize(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.z.mul(c).sub(n.x.mul(s))));
      const colour = texture(colourAtlas, atlasUv);

      const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.4 });
      material.positionNode = position;
      material.colorNode = colour.rgb.mul(varying(toneOf(B.w).mul(cloudShade(A.xz))));
      material.opacityNode = colour.a;
      material.normalNode = cameraViewMatrix.transformDirection(normalWorld).mul(faceDirection);
      material.roughness = 1;
      material.metalness = 0;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }

    this.bakeShade(field, sunDirection);
  }

  get count() {
    return this.planting.count;
  }

  /** Trees nearer than this (metres) are drawn as full models. */
  setNearRange(metres: number) {
    this.nearRange.value = metres;
  }

  update(camera: THREE.PerspectiveCamera) {
    const p = this.planting;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const range = this.nearRange.value;
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen, camera.coordinateSystem);
    for (const d of this.draws) d.count = 0;

    const cell = (v: number) => Math.min(FOREST_CELLS - 1, Math.max(0, Math.floor((v + HALF) / FOREST_CELL)));
    for (let j = cell(cz - range); j <= cell(cz + range); j++) {
      for (let i = cell(cx - range); i <= cell(cx + range); i++) {
        const k = j * FOREST_CELLS + i;
        for (let t = p.cellStart[k]; t < p.cellStart[k + 1]; t++) {
          const dx = p.x[t] - cx;
          const dz = p.z[t] - cz;
          if (dx * dx + dz * dz >= range * range) continue; // the impostor shader uses the same test
          const d = this.draws[p.species[t]];
          if (d.count >= MAX_NEAR) continue;
          const scale = p.scale[t];
          this.sphere.center.set(p.x[t], p.y[t] + d.model.height * 0.5 * scale, p.z[t]);
          this.sphere.radius = Math.max(d.model.height * 0.55, d.model.radius) * scale * 1.1;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
          d.a.set([p.x[t], p.y[t], p.z[t], p.turn[t]], d.count * 4);
          d.b.set([scale, p.tone[t]], d.count * 2);
          d.count++;
        }
      }
    }

    this.nearTriangles = 0;
    this.nearTrees = 0;
    for (const d of this.draws) {
      for (const mesh of d.meshes) {
        (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = d.count;
        mesh.visible = d.count > 0;
      }
      d.attrA.needsUpdate = true;
      d.attrB.needsUpdate = true;
      this.nearTriangles += d.count * d.model.triangles;
      this.nearTrees += d.count;
    }
  }

  /**
   * Keeps a circle of `radius` at `p` out of tree trunks: moves `p` sideways out of any trunk it
   * overlaps. Returns true if it had to. Bushes are not obstacles.
   */
  pushOut(p: { x: number; z: number }, radius: number): boolean {
    const pl = this.planting;
    const cell = (v: number) => Math.min(FOREST_CELLS - 1, Math.max(0, Math.floor((v + HALF) / FOREST_CELL)));
    let hit = false;
    for (let j = cell(p.z - 3); j <= cell(p.z + 3); j++) {
      for (let i = cell(p.x - 3); i <= cell(p.x + 3); i++) {
        const k = j * FOREST_CELLS + i;
        for (let t = pl.cellStart[k]; t < pl.cellStart[k + 1]; t++) {
          const trunk = this.draws[pl.species[t]].model.trunkRadius;
          if (trunk === 0) continue;
          const reach = trunk * pl.scale[t] + radius;
          const dx = p.x - pl.x[t];
          const dz = p.z - pl.z[t];
          const d = Math.hypot(dx, dz);
          if (d >= reach || d < 1e-4) continue;
          p.x += (dx / d) * (reach - d);
          p.z += (dz / d) * (reach - d);
          hit = true;
        }
      }
    }
    return hit;
  }

  /**
   * Darkens the ground under every crown. There are no real-time shadows yet, so this soft, fixed
   * shade (stored in a spare channel of a terrain map) is what seats the trees on the ground; the
   * terrain and the grass both read it.
   */
  private bakeShade(field: Heightfield, sunDirection: THREE.Vector3) {
    const p = this.planting;
    const light = new Float32Array(GRID * GRID).fill(1);
    const flat = Math.hypot(sunDirection.x, sunDirection.z) || 1;
    for (let t = 0; t < p.count; t++) {
      const { model } = this.draws[p.species[t]];
      const bush = model.trunkRadius === 0;
      const r = model.radius * p.scale[t] * (bush ? 1.2 : 0.95);
      // Shade falls a little way off, on the side away from the sun.
      const away = bush ? 0.3 : Math.min(4, model.height * p.scale[t] * 0.25);
      const x = p.x[t] - (sunDirection.x / flat) * away;
      const z = p.z[t] - (sunDirection.z / flat) * away;
      const depth = bush ? 0.45 : 0.6;
      const reach = Math.ceil(r / CELL);
      const ci = Math.round((x + HALF) / CELL);
      const cj = Math.round((z + HALF) / CELL);
      for (let j = Math.max(0, cj - reach); j <= Math.min(GRID - 1, cj + reach); j++) {
        for (let i = Math.max(0, ci - reach); i <= Math.min(GRID - 1, ci + reach); i++) {
          const q = Math.hypot(-HALF + i * CELL - x, -HALF + j * CELL - z) / r;
          if (q >= 1) continue;
          const f = Math.min(1, (1 - q) / 0.65);
          light[j * GRID + i] *= 1 - depth * f * f * (3 - 2 * f);
        }
      }
    }
    for (let k = 0; k < GRID * GRID; k++) field.normalAo[k * 4 + 3] = Math.round(255 * Math.max(0.12, light[k]));
    field.normalAoTexture.needsUpdate = true;
  }
}
