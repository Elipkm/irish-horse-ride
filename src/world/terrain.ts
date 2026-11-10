import * as THREE from 'three/webgpu';
import { HALF, LEAF_CELLS, LEAF_SIZE, LOD_LEVELS, WORLD_SIZE, type Heightfield } from './heightfield';
import { createTerrainMaterial, type GroundTextures, type TerrainMaterial } from './terrainMaterial';

const MAX_NODES = 512;

/**
 * Terrain renderer: one 32×32-cell grid patch, drawn once per visible quadtree node in a single
 * instanced draw call (continuous distance-dependent LOD). Node selection and frustum culling run
 * on the CPU each frame; heights are read from the height texture in the vertex shader.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  /** Nodes drawn in the last update. */
  nodeCount = 0;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly nodeAttr: THREE.InstancedBufferAttribute;
  private readonly nodes = new Float32Array(MAX_NODES * 3);
  private readonly terrainMaterial: TerrainMaterial;
  private readonly ranges = new Float32Array(LOD_LEVELS);
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private camX = 0;
  private camZ = 0;

  constructor(
    private readonly field: Heightfield,
    ground: GroundTextures
  ) {
    const verts = LEAF_CELLS + 1;
    const positions = new Float32Array(verts * verts * 3);
    const normals = new Float32Array(verts * verts * 3);
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const k = (j * verts + i) * 3;
        positions[k] = i; // integer grid index; the vertex shader scales it by the node size
        positions[k + 2] = j;
        normals[k + 1] = 1;
      }
    }
    const indices = new Uint16Array(LEAF_CELLS * LEAF_CELLS * 6);
    let n = 0;
    for (let j = 0; j < LEAF_CELLS; j++) {
      for (let i = 0; i < LEAF_CELLS; i++) {
        const a = j * verts + i;
        const b = a + verts;
        indices[n++] = a;
        indices[n++] = b;
        indices[n++] = a + 1;
        indices[n++] = a + 1;
        indices[n++] = b;
        indices[n++] = b + 1;
      }
    }

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodes, 3);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('nodeData', this.nodeAttr);
    this.geometry.instanceCount = 0;

    this.terrainMaterial = createTerrainMaterial(field, ground);
    this.mesh = new THREE.Mesh(this.geometry, this.terrainMaterial.material);
    this.mesh.frustumCulled = false; // culled per node below
    this.mesh.matrixAutoUpdate = false;
    this.setLodRange(100);
  }

  /** Radius (m) of full 2 m detail around the camera. Triangle count grows with its square. */
  setLodRange(metres: number) {
    this.terrainMaterial.lodRange.value = metres;
    for (let l = 0; l < LOD_LEVELS; l++) this.ranges[l] = metres * 2 ** l;
  }

  get triangles() {
    return this.nodeCount * LEAF_CELLS * LEAF_CELLS * 2;
  }

  update(camera: THREE.PerspectiveCamera) {
    this.camX = camera.position.x;
    this.camZ = camera.position.z;
    this.terrainMaterial.cameraXZ.set(this.camX, this.camZ);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen, camera.coordinateSystem);

    this.nodeCount = 0;
    const top = LOD_LEVELS - 1;
    if (!this.select(top, 0, 0)) this.add(top, 0, 0);

    this.geometry.instanceCount = this.nodeCount;
    this.nodeAttr.needsUpdate = true;
  }

  /** True when the square [x0, x0+size] × [z0, z0+size] touches the circle of `radius` around the camera. */
  private inRange(x0: number, z0: number, size: number, radius: number) {
    const dx = Math.max(x0 - this.camX, 0, this.camX - (x0 + size));
    const dz = Math.max(z0 - this.camZ, 0, this.camZ - (z0 + size));
    return dx * dx + dz * dz <= radius * radius;
  }

  private visible(level: number, i: number, j: number, x0: number, z0: number, size: number) {
    const k = j * ((WORLD_SIZE / LEAF_SIZE) >> level) + i;
    this.box.min.set(x0, this.field.nodeMin[level][k], z0);
    this.box.max.set(x0 + size, this.field.nodeMax[level][k], z0 + size);
    return this.frustum.intersectsBox(this.box);
  }

  /**
   * Quadtree descent. Returns false when the node is outside this level's range, which tells the
   * parent to draw that quarter itself.
   */
  private select(level: number, i: number, j: number): boolean {
    const size = LEAF_SIZE << level;
    const x0 = -HALF + i * size;
    const z0 = -HALF + j * size;
    if (!this.inRange(x0, z0, size, this.ranges[level])) return false;
    if (!this.visible(level, i, j, x0, z0, size)) return true; // off screen: handled, nothing to draw

    if (level === 0 || !this.inRange(x0, z0, size, this.ranges[level - 1])) {
      this.push(x0, z0, size);
      return true;
    }
    for (let c = 0; c < 4; c++) {
      const ci = i * 2 + (c & 1);
      const cj = j * 2 + (c >> 1);
      if (!this.select(level - 1, ci, cj)) this.add(level - 1, ci, cj);
    }
    return true;
  }

  private add(level: number, i: number, j: number) {
    const size = LEAF_SIZE << level;
    const x0 = -HALF + i * size;
    const z0 = -HALF + j * size;
    if (this.visible(level, i, j, x0, z0, size)) this.push(x0, z0, size);
  }

  private push(x0: number, z0: number, size: number) {
    if (this.nodeCount >= MAX_NODES) return;
    const k = this.nodeCount++ * 3;
    this.nodes[k] = x0;
    this.nodes[k + 1] = z0;
    this.nodes[k + 2] = size;
  }
}
