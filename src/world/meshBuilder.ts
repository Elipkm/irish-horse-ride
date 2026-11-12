import * as THREE from 'three/webgpu';

/** Colour to paint a surface (linear r, g, b) and how much of the stone texture shows through it (0..1). */
export type Paint = readonly [number, number, number, number];

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * Collects many small shapes into one mesh, so a whole set of buildings costs one draw call.
 * Every vertex carries a `paint` (colour + amount of stone texture) and a `kind`
 * (0 = built masonry, 1 = natural rock).
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly paints: number[] = [];
  private readonly kinds: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();

  get triangles() {
    return this.positions.length / 9;
  }

  /** Adds a ready-made geometry, moved by `matrix`. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, paint: Paint, kind = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    this.normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < pos.count; i++) {
      this.v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      this.n.fromBufferAttribute(nor, i).applyMatrix3(this.normalMatrix).normalize();
      this.push(this.v, this.n, paint, kind);
    }
    if (g !== geometry) g.dispose();
  }

  /** A box of the given size, centred at `centre` in the space of `matrix`, optionally turned about its own vertical axis. */
  box(matrix: THREE.Matrix4, centre: [number, number, number], size: [number, number, number], paint: Paint, turn = 0, kind = 0) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...centre), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn), new THREE.Vector3(...size));
    this.add(UNIT_BOX, m.premultiply(matrix), paint, kind);
  }

  /** A flat four-cornered face, made to face the way `outward` points whatever order the corners come in. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, outward: THREE.Vector3, paint: Paint, kind = 0) {
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const order = normal.dot(outward) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    if (normal.dot(outward) < 0) normal.negate();
    for (const p of order) this.push(p, normal, paint, kind);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('paint', new THREE.Float32BufferAttribute(this.paints, 4));
    geometry.setAttribute('kind', new THREE.Float32BufferAttribute(this.kinds, 1));
    return geometry;
  }

  private push(p: THREE.Vector3, n: THREE.Vector3, paint: Paint, kind: number) {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.paints.push(paint[0], paint[1], paint[2], paint[3]);
    this.kinds.push(kind);
  }
}

/** Matrix that puts local x along (cos rot, sin rot) on the ground, local y up, at a world position. */
export function placementMatrix(x: number, y: number, z: number, rot: number): THREE.Matrix4 {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(c, 0, s), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-s, 0, c)).setPosition(x, y, z);
}
