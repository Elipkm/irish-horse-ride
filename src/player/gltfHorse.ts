import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BlobShadow } from './blobShadow';
import { GAITS } from './gaits';
import type { HorseMotion } from './proceduralHorse';

const GAIT_CLIPS = ['walk', 'trot', 'canter', 'gallop'] as const; // match GAITS[1..4]
/** Small idle movements, and the bones each is allowed to move (the rest of the body stays put). */
const FIDGETS: Record<string, RegExp> = {
  headShake: /neck|head|skull|ear|jaw|nose|eye|mane/,
  headTossUp: /neck|head|skull|ear|jaw|nose|eye|mane/,
  headTossDown: /neck|head|skull|ear|jaw|nose|eye|mane/,
  tailLeft: /tail/,
  tailRight: /tail/,
  tailUp: /tail/,
};
/** Point in the gallop cycle where all four legs are gathered off the ground: used as the jump pose. */
const JUMP_PHASE = 0.85;

const saturate = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const damp = (from: number, to: number, rate: number, dt: number) => to + (from - to) * Math.exp(-rate * dt);

/**
 * The realistic horse (public/models/horse.glb, built by tools/horse_export.py). Plays the gait
 * clip that matches the horse's actual speed, timed so each stride covers the ground it should,
 * cross-fades between gaits, holds a gathered pose in the air, and fidgets a little when standing.
 */
export class GltfHorse {
  /** Position and rotation are set by the controller. Local +z is the nose. */
  readonly root = new THREE.Group();
  /** Add `shadow.mesh` to the scene separately. */
  readonly shadow = new BlobShadow();

  private nose: THREE.Object3D | null = null;
  private readonly mixer: THREE.AnimationMixer;
  private readonly gaits: THREE.AnimationAction[];
  private readonly fidgets: THREE.AnimationAction[];
  private readonly weights = [0, 0, 0, 0];
  private phase = 0;
  private airborne = 0;
  private nextFidget = 4;

  static async load(url: string) {
    return new GltfHorse(await new GLTFLoader().loadAsync(url));
  }

  private constructor(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }) {
    this.root.add(gltf.scene);
    gltf.scene.traverse((o) => {
      // The animated body reaches outside the bounds of its rest pose; it is always on screen anyway.
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.frustumCulled = false;
      // The source coat texture is a vivid chestnut red; tint it towards a darker bay brown.
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (material.name === 'coat') material.color.setRGB(0.62, 0.52, 0.46);
    });

    // The bone nearest the nostrils, for the breath: a nose or jaw bone if there is one, else the head.
    for (const pattern of [/nose|nostril|muzzle/i, /jaw/i, /head|skull/i]) {
      gltf.scene.traverse((o) => {
        if (!this.nose && (o as THREE.Bone).isBone && pattern.test(o.name)) this.nose = o;
      });
    }

    this.mixer = new THREE.AnimationMixer(gltf.scene);
    const clip = (name: string) => {
      const c = gltf.animations.find((a) => a.name === name);
      if (!c) throw new Error(`horse.glb has no "${name}" animation`);
      return c;
    };
    this.gaits = GAIT_CLIPS.map((name) => {
      const action = this.mixer.clipAction(clip(name));
      action.setEffectiveTimeScale(0); // time is set by hand each frame, from distance travelled
      action.setEffectiveWeight(0);
      action.play();
      return action;
    });
    this.fidgets = Object.entries(FIDGETS).map(([name, bones]) => {
      const c = clip(name);
      c.tracks = c.tracks.filter((t) => bones.test(t.name));
      const action = this.mixer.clipAction(c);
      action.setLoop(THREE.LoopOnce, 1);
      return action;
    });
  }

  /** World position of the nostrils (valid after `update`). */
  nosePosition(out: THREE.Vector3) {
    if (this.nose) return this.nose.getWorldPosition(out);
    return this.root.localToWorld(out.set(0, 1.55, 1.2));
  }

  /** Call once per rendered frame, after the controller has posed `root`. */
  update(dt: number, m: HorseMotion) {
    // Stepping on the spot while turning counts as slow walking.
    const speed = Math.max(m.speed, Math.abs(m.turnRate) * 0.5);
    this.airborne = damp(this.airborne, m.grounded ? 0 : 1, 10, dt);

    // Which gait clips show: standing pose below a slow walk, then each gait around its own speed.
    // The cross-fade is kept to the middle of each speed gap so two gaits rarely show at once.
    let stride = GAITS[1].stride;
    this.weights.fill(0);
    if (speed <= GAITS[1].speed) {
      this.weights[0] = smoothstep(0.05, 0.5, speed);
    } else {
      let i = 1;
      while (i < GAITS.length - 2 && speed > GAITS[i + 1].speed) i++;
      const t = smoothstep(0.3, 0.7, (speed - GAITS[i].speed) / (GAITS[i + 1].speed - GAITS[i].speed));
      this.weights[i - 1] = 1 - t;
      this.weights[i] = t;
      stride = GAITS[i].stride + (GAITS[i + 1].stride - GAITS[i].stride) * t;
    }

    if (this.airborne > 0.5) {
      // In the air: ease the cycle to the gathered pose and hold it.
      const d = ((JUMP_PHASE - this.phase + 1.5) % 1) - 0.5;
      this.phase = (this.phase + d * Math.min(1, dt * 10) + 1) % 1;
    } else {
      this.phase = (this.phase + (speed * dt) / stride) % 1;
    }
    this.gaits.forEach((action, i) => {
      const w = i === 3 ? this.weights[i] + (1 - this.weights[i]) * this.airborne : this.weights[i] * (1 - this.airborne);
      action.setEffectiveWeight(w);
      action.time = this.phase * action.getClip().duration;
    });

    // Standing still: now and then shake the head or flick the tail.
    if (speed < 0.05 && m.grounded) {
      this.nextFidget -= dt;
      if (this.nextFidget <= 0) {
        this.nextFidget = 4 + Math.random() * 6;
        const action = this.fidgets[Math.floor(Math.random() * this.fidgets.length)];
        action.reset().fadeIn(0.25).play();
        action.clampWhenFinished = false;
      }
    } else {
      this.nextFidget = Math.max(this.nextFidget, 2);
      for (const action of this.fidgets) if (action.isRunning()) action.fadeOut(0.2);
    }

    this.mixer.update(dt);
    this.shadow.follow(this.root, m.heightAboveGround);
  }
}
