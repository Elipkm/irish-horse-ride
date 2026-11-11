import * as THREE from 'three/webgpu';
import { BlobShadow } from './blobShadow';
import { TOP_SPEED, blendGait, newGaitBlend } from './gaits';

export interface HorseMotion {
  /** Forward speed in m/s. */
  speed: number;
  /** Turn rate in rad/s (so the legs also step when turning on the spot). */
  turnRate: number;
  steer: number;
  grounded: boolean;
  heightAboveGround: number;
}

const LEG_LENGTH = 0.99;
const saturate = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (from: number, to: number, rate: number, dt: number) => to + (from - to) * Math.exp(-rate * dt);

interface Leg {
  upper: THREE.Group;
  lower: THREE.Group;
  hind: boolean;
  upperRest: number;
  lowerRest: number;
}

/**
 * Stand-in horse built from simple shapes in code, about 1.55 m at the withers. Its legs follow the
 * real footfall order of each gait at the speed the horse is actually moving. It exists so riding
 * could be built before the realistic model existed; now it is only the fallback if that model
 * (public/models/horse.glb, see gltfHorse.ts) fails to load.
 */
export class ProceduralHorse {
  /** Position and rotation are set by the controller. Local +z is the nose, +x the horse's left. */
  readonly root = new THREE.Group();
  /** Add `shadow.mesh` to the scene separately. */
  readonly shadow = new BlobShadow();

  private readonly body = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly tail = new THREE.Group();
  private readonly legs: Leg[] = [];
  private readonly gait = newGaitBlend();
  private phase = 0;
  private time = 0;
  private moving = 0;
  private airborne = 0;

  constructor() {
    const coat = new THREE.MeshStandardNodeMaterial({ color: 0x3a2012, roughness: 0.6 }); // bay
    const points = new THREE.MeshStandardNodeMaterial({ color: 0x17110d, roughness: 0.7 }); // black mane, tail, lower legs
    const hoof = new THREE.MeshStandardNodeMaterial({ color: 0x0c0a09, roughness: 0.45 });

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    this.root.add(this.body);
    add(this.body, new THREE.CapsuleGeometry(0.31, 0.9, 6, 14).rotateX(Math.PI / 2), coat, 0, 1.22, -0.02).scale.set(0.92, 1, 1);
    add(this.body, new THREE.SphereGeometry(0.33, 14, 10), coat, 0, 1.2, 0.48).scale.set(0.9, 1.05, 1); // chest
    add(this.body, new THREE.SphereGeometry(0.36, 14, 10), coat, 0, 1.26, -0.5).scale.set(0.95, 1, 1.05); // haunches

    // Neck pivots at the shoulder; +y of the group runs along the neck towards the head.
    this.neck.position.set(0, 1.36, 0.6);
    this.body.add(this.neck);
    add(this.neck, new THREE.CylinderGeometry(0.12, 0.23, 0.85, 12), coat, 0, 0.4, 0).scale.set(0.7, 1, 1);
    add(this.neck, new THREE.BoxGeometry(0.05, 0.8, 0.12), points, 0, 0.42, -0.17); // mane

    this.head.position.set(0, 0.84, 0);
    this.neck.add(this.head);
    add(this.head, new THREE.CylinderGeometry(0.075, 0.125, 0.58, 10), coat, 0, 0.2, 0).scale.set(0.8, 1, 1);
    const ear = new THREE.ConeGeometry(0.035, 0.12, 6).rotateX(-Math.PI / 2);
    add(this.head, ear, coat, 0.07, -0.02, -0.15);
    add(this.head, ear, coat, -0.07, -0.02, -0.15);

    this.tail.position.set(0, 1.36, -0.84);
    this.body.add(this.tail);
    add(this.tail, new THREE.CylinderGeometry(0.075, 0.03, 0.85, 8), points, 0, -0.42, 0);

    const upperFore = new THREE.CylinderGeometry(0.085, 0.055, 0.5, 8);
    const upperHind = new THREE.CylinderGeometry(0.11, 0.06, 0.5, 8);
    const cannon = new THREE.CylinderGeometry(0.045, 0.04, 0.42, 8);
    const hoofGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.08, 8);
    // Order matches gaits.ts: left hind, left fore, right hind, right fore.
    for (const [side, hind] of [[1, true], [1, false], [-1, true], [-1, false]] as const) {
      const upper = new THREE.Group();
      upper.position.set(side * (hind ? 0.19 : 0.17), hind ? 0.985 : 0.99, hind ? -0.52 : 0.47);
      this.body.add(upper);
      add(upper, hind ? upperHind : upperFore, coat, 0, -0.25, 0);
      const lower = new THREE.Group();
      lower.position.set(0, -0.5, 0);
      upper.add(lower);
      add(lower, cannon, points, 0, -0.21, 0);
      add(lower, hoofGeo, hoof, 0, -0.455, 0);
      // Hind legs rest slightly angled, as a real hock does.
      this.legs.push({ upper, lower, hind, upperRest: hind ? 0.22 : 0, lowerRest: hind ? -0.3 : 0 });
    }
  }

  /** Call once per rendered frame, after the controller has posed `root`. */
  update(dt: number, m: HorseMotion) {
    this.time += dt;
    const fast = saturate(m.speed / TOP_SPEED);
    // Stepping on the spot while turning counts as slow walking.
    const animSpeed = Math.max(m.speed, Math.abs(m.turnRate) * 0.5);
    const g = blendGait(animSpeed, this.gait);
    this.phase = (this.phase + (animSpeed * dt) / g.stride) % 1;
    this.moving = damp(this.moving, saturate(animSpeed / 0.6), 8, dt);
    this.airborne = damp(this.airborne, m.grounded ? 0 : 1, 10, dt);

    // Swing angle that makes each hoof travel as far as the body moves while it is on the ground.
    const swing = Math.min(0.72, Math.asin(Math.min(0.95, (g.stride * g.duty) / 2 / LEG_LENGTH)));
    const flex = 0.45 + 0.75 * fast;
    this.legs.forEach((leg, i) => {
      const p = (this.phase + g.offsets[i]) % 1;
      let angle: number;
      let lift = 0;
      if (p < g.duty) {
        angle = -swing + 2 * swing * (p / g.duty); // on the ground: hoof moves back under the body
      } else {
        const s = (p - g.duty) / (1 - g.duty);
        angle = swing - 2 * swing * (s * s * (3 - 2 * s)); // in the air: reaches forward again
        lift = Math.sin(Math.PI * s);
      }
      const groundUpper = leg.upperRest + this.moving * (angle - lift * flex * (leg.hind ? 0.25 : 0.3));
      const groundLower = leg.lowerRest + this.moving * lift * flex * (leg.hind ? -1.1 : 1.3);
      // Jump: forelegs tucked up, hind legs trailing.
      const airUpper = leg.hind ? 0.75 : -0.95;
      const airLower = leg.hind ? -0.5 : 1.7;
      leg.upper.rotation.x = lerp(groundUpper, airUpper, this.airborne);
      leg.lower.rotation.x = lerp(groundLower, airLower, this.airborne);
    });

    const cycle = this.phase * Math.PI * 2;
    const breathe = 0.004 * Math.sin(this.time * 1.4);
    this.body.position.y = this.moving * (g.bob2 * Math.sin(cycle * 2) + g.bob1 * Math.sin(cycle)) + breathe;
    this.body.rotation.x = this.moving * g.rock * Math.sin(cycle + 1.2);

    const nod = this.moving * (0.05 * Math.sin(cycle * 2 + 0.6) * (1 - fast) + 0.07 * Math.sin(cycle + 0.4) * fast);
    this.neck.rotation.x = 0.8 + 0.2 * fast + nod + (1 - this.moving) * 0.03 * Math.sin(this.time * 0.6);
    this.neck.rotation.z = -m.steer * 0.2; // looks into the turn
    this.head.rotation.x = 1.15 - 0.12 * fast - nod * 0.5;
    this.tail.rotation.x = 0.3 + 0.55 * fast + 0.04 * Math.sin(cycle * 2);
    this.tail.rotation.z = 0.07 * Math.sin(this.time * 1.7) + m.steer * 0.12;

    this.shadow.follow(this.root, m.heightAboveGround);
  }
}
