import * as THREE from 'three/webgpu';
import { attribute, cos, float, length, mix, positionGeometry, sin, smoothstep, uniform, varying, vec2, vec3 } from 'three/tsl';

/** Soft round puff (dust, spray, breath). */
export const PUFF = 0;
/** Small solid dot (water drops, clods of earth, midges). */
export const DOT = 1;
/** Narrow solid oval that tumbles (falling leaves). */
export const LEAF = 2;

export interface ParticleSpawn {
  shape: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds until it is gone. */
  life: number;
  /** Diameter in metres at birth and at death. */
  size: number;
  endSize?: number;
  /** Colour as it should appear (linear, already lit). */
  r: number;
  g: number;
  b: number;
  /** Peak opacity; fades in over the first tenth of its life and out over the rest. */
  alpha: number;
  /** Downward acceleration in m/s². */
  gravity?: number;
  /** Fraction of speed lost per second. */
  drag?: number;
  /** Tumble speed in rad/s (leaves). */
  spin?: number;
  /** Sideways flutter in m/s (leaves). */
  flutter?: number;
  /** Dies when it falls below this height. */
  floor?: number;
}

const STRIDE = 21; // numbers kept per particle on the CPU

/**
 * Every small loose thing in the air: dust and clods from the hooves, spray, the horse's breath,
 * falling leaves, midges. Up to a few hundred camera-facing dots moved on the CPU and drawn in one
 * call. Colours are given ready-lit by whoever spawns them; fog still applies.
 */
export class Particles {
  readonly mesh: THREE.Mesh;
  /** Particles alive (plus any drawn for this frame only). */
  count = 0;

  private readonly state: Float32Array;
  private readonly a: Float32Array; // x, y, z, size
  private readonly b: Float32Array; // r, g, b, opacity
  private readonly c: Float32Array; // turn, shape
  private readonly attrA: THREE.InstancedBufferAttribute;
  private readonly attrB: THREE.InstancedBufferAttribute;
  private readonly attrC: THREE.InstancedBufferAttribute;
  private readonly right = uniform(new THREE.Vector3(1, 0, 0));
  private readonly up = uniform(new THREE.Vector3(0, 1, 0));
  private live = 0;
  private time = 0;

  constructor(private readonly capacity = 640) {
    this.state = new Float32Array(capacity * STRIDE);
    this.a = new Float32Array(capacity * 4);
    this.b = new Float32Array(capacity * 4);
    this.c = new Float32Array(capacity * 2);
    this.attrA = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrB = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrC = new THREE.InstancedBufferAttribute(this.c, 2).setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('pA', this.attrA);
    geometry.setAttribute('pB', this.attrB);
    geometry.setAttribute('pC', this.attrC);
    geometry.instanceCount = 0;

    const A = attribute('pA', 'vec4');
    const B = attribute('pB', 'vec4');
    const C = attribute('pC', 'vec2');
    const leaf = smoothstep(1.5, 1.6, C.y);
    const solid = smoothstep(0.5, 0.6, C.y);
    // Leaves are narrow and turn in the plane of the screen.
    const corner = positionGeometry.xy.mul(vec2(mix(float(1), float(0.5), leaf), 1));
    const co = cos(C.x);
    const si = sin(C.x);
    const turned = vec2(corner.x.mul(co).sub(corner.y.mul(si)), corner.x.mul(si).add(corner.y.mul(co))).mul(A.w);
    const fromCentre = length(positionGeometry.xy.mul(2)); // 0 in the middle, 1 at the rim (in the untouched square)
    const soft = float(1).sub(smoothstep(0.0, 1.0, fromCentre));
    const hard = float(1).sub(smoothstep(0.8, 1.0, fromCentre));

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.positionNode = A.xyz.add(vec3(this.right).mul(turned.x)).add(vec3(this.up).mul(turned.y));
    material.colorNode = varying(B.rgb);
    material.opacityNode = mix(soft.mul(soft), hard, varying(solid)).mul(varying(B.a));

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3;
  }

  spawn(s: ParticleSpawn) {
    if (this.live >= this.capacity) return;
    const k = this.live++ * STRIDE;
    const st = this.state;
    st[k] = s.x;
    st[k + 1] = s.y;
    st[k + 2] = s.z;
    st[k + 3] = s.vx;
    st[k + 4] = s.vy;
    st[k + 5] = s.vz;
    st[k + 6] = 0; // age
    st[k + 7] = s.life;
    st[k + 8] = s.size;
    st[k + 9] = s.endSize ?? s.size;
    st[k + 10] = s.gravity ?? 0;
    st[k + 11] = s.drag ?? 0;
    st[k + 12] = s.spin ?? 0;
    st[k + 13] = s.flutter ?? 0;
    st[k + 14] = s.floor ?? -1e9;
    st[k + 15] = Math.random() * 6.283; // phase of turn and flutter
    st[k + 16] = s.r;
    st[k + 17] = s.g;
    st[k + 18] = s.b;
    st[k + 19] = s.alpha;
    st[k + 20] = s.shape;
  }

  /** Moves everything on and drops what has died. Call once per frame, before any `draw` calls. */
  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const { state: st, a, b, c } = this;
    for (let i = this.live - 1; i >= 0; i--) {
      const k = i * STRIDE;
      st[k + 6] += dt;
      const flutter = st[k + 13] * Math.sin(this.time * 2.3 + st[k + 15]);
      st[k + 4] -= st[k + 10] * dt;
      const keep = Math.max(0, 1 - st[k + 11] * dt);
      st[k + 3] *= keep;
      st[k + 4] *= keep;
      st[k + 5] *= keep;
      st[k] += (st[k + 3] + flutter) * dt;
      st[k + 1] += st[k + 4] * dt;
      st[k + 2] += (st[k + 5] + flutter * 0.6) * dt;
      if (st[k + 6] >= st[k + 7] || st[k + 1] < st[k + 14]) {
        // Dead: the last live particle takes its place.
        const last = --this.live;
        if (last !== i) st.copyWithin(k, last * STRIDE, (last + 1) * STRIDE);
      }
    }
    for (let i = 0; i < this.live; i++) {
      const k = i * STRIDE;
      const age = st[k + 6] / st[k + 7];
      a[i * 4] = st[k];
      a[i * 4 + 1] = st[k + 1];
      a[i * 4 + 2] = st[k + 2];
      a[i * 4 + 3] = st[k + 8] + (st[k + 9] - st[k + 8]) * age;
      b[i * 4] = st[k + 16];
      b[i * 4 + 1] = st[k + 17];
      b[i * 4 + 2] = st[k + 18];
      b[i * 4 + 3] = st[k + 19] * Math.min(1, age * 10) * Math.min(1, (1 - age) * 1.6); // quick in, slow out
      c[i * 2] = st[k + 15] + st[k + 12] * st[k + 6];
      c[i * 2 + 1] = st[k + 20];
    }
    this.count = this.live;
    camera.matrixWorld.extractBasis(this.right.value, this.up.value, scratch);
  }

  /** Draws one more dot for this frame only (for things whose position is worked out afresh each frame). */
  draw(x: number, y: number, z: number, size: number, r: number, g: number, b: number, alpha: number, shape = DOT) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.a.set([x, y, z, size], i * 4);
    this.b.set([r, g, b, alpha], i * 4);
    this.c.set([0, shape], i * 2);
  }

  /** Sends this frame's particles to the GPU. Call after `update` and any `draw` calls. */
  commit() {
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    this.attrA.needsUpdate = true;
    this.attrB.needsUpdate = true;
    this.attrC.needsUpdate = true;
  }
}

const scratch = new THREE.Vector3();
