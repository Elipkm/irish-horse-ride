import * as THREE from 'three/webgpu';
import { GAITS } from '../player/gaits';
import type { HorseController } from '../player/horseController';
import { groundWet, overcast, rainAmount, skyDim } from './atmosphere';
import type { Environment } from './environment';
import type { Forest } from './forest';
import { FOREST_CELL, FOREST_CELLS } from './forestPlacement';
import { CELL, GRID, HALF, RIVER_Z0, RIVER_Z1, WATER_LEVEL, riverX, type Heightfield } from './heightfield';
import { DOT, LEAF, PUFF, type Particles } from './particles';

const rnd = (a: number, b: number) => a + (b - a) * Math.random();
const WIND = { x: 0.82, z: 0.57 }; // matches world/wind.ts

/** Colours of the loose stuff, as the fraction of light each reflects. */
const DUST = [0.4, 0.34, 0.25];
const MUD = [0.075, 0.058, 0.04];
const TURF = [0.07, 0.085, 0.035];
const SPRAY = [0.62, 0.65, 0.68];
const BREATH = [0.8, 0.82, 0.86];
const SMOKE = [0.5, 0.52, 0.56];
const LEAVES = [
  [0.3, 0.26, 0.06],
  [0.22, 0.25, 0.05],
  [0.3, 0.17, 0.05],
  [0.16, 0.2, 0.05],
];

interface Swarm {
  x: number;
  y: number;
  z: number;
}

/**
 * Decides when and where particles appear: what the hooves throw up (dust on the dry trail, clods
 * on soft ground, spray in water), the horse's breath in the cool air, leaves drifting down from
 * nearby oaks and birches, and clouds of midges dancing at the water's edge.
 */
export class Effects {
  private sinceHoof = 0;
  private breath = 1;
  private leaf = 0;
  private wasGrounded = true;
  private time = 0;
  /** Chimney tops that smoke (set by the game once the cottages exist). */
  chimneys: THREE.Vector3[] = [];
  private smoke = 0;
  private readonly swarms: Swarm[] = [];
  private readonly light = new THREE.Vector3();
  private readonly glow = new THREE.Vector3();
  private readonly nose = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor(
    private readonly particles: Particles,
    private readonly field: Heightfield,
    private readonly forest: Forest,
    private readonly environment: Environment
  ) {
    // Midges gather over the water's edge: every so often along the river, and all round the lake.
    const { heightAt, waterLevelAt, lakeCentre } = field;
    for (let z = RIVER_Z0 + 70; z < RIVER_Z1 - 120; z += 85) {
      const x = riverX(z) + 3;
      this.swarms.push({ x, y: waterLevelAt(x, z), z });
    }
    for (let a = 0; a < 14; a++) {
      // Walk out from the middle of the lake until the water is only ankle deep.
      const dx = Math.cos((a / 14) * Math.PI * 2);
      const dz = Math.sin((a / 14) * Math.PI * 2);
      let r = 60;
      while (r < 400 && WATER_LEVEL - heightAt(lakeCentre.x + dx * r, lakeCentre.z + dz * r) > 0.15) r += 2;
      this.swarms.push({ x: lakeCentre.x + dx * r, y: WATER_LEVEL, z: lakeCentre.z + dz * r });
    }
  }

  /**
   * Call once per frame, between `particles.update` and `particles.commit`.
   * `nose` is the horse's nostrils in world space.
   */
  update(dt: number, horse: HorseController, root: THREE.Object3D, nose: THREE.Vector3, camera: THREE.Camera) {
    this.time += dt;
    // Particles are not lit by the scene's lights: give them the sky's light by hand.
    this.light.copy(this.environment.horizon).multiplyScalar(skyDim.value * 1.15);
    this.glow.copy(this.environment.sunHorizon).multiplyScalar(skyDim.value);
    this.nose.copy(nose);
    this.forward.set(Math.sin(horse.renderHeading), 0, Math.cos(horse.renderHeading));

    this.hooves(dt, horse, root);
    this.breathe(dt, horse);
    this.leaves(dt, camera);
    this.midges(camera);
    this.chimneySmoke(dt, camera);
  }

  // ------------------------------------------------------------------ turf smoke from the cottages
  private chimneySmoke(dt: number, camera: THREE.Camera) {
    this.smoke -= dt;
    if (this.smoke > 0) return;
    this.smoke = 0.22;
    for (const c of this.chimneys) {
      if (c.distanceToSquared(camera.position) > 260 * 260) continue;
      const gust = 0.7 + 0.5 * Math.random();
      this.spawn(PUFF, SMOKE, c.x, c.y, c.z, WIND.x * gust + rnd(-0.15, 0.15), rnd(0.7, 1.1), WIND.z * gust + rnd(-0.15, 0.15), {
        life: rnd(5, 7),
        size: 0.45,
        endSize: rnd(2.6, 3.8),
        alpha: 0.2,
        drag: 0.12,
      });
    }
  }

  // ------------------------------------------------------------------ hooves
  private hooves(dt: number, horse: HorseController, root: THREE.Object3D) {
    const landed = horse.grounded && !this.wasGrounded;
    this.wasGrounded = horse.grounded;
    if (!horse.grounded) return;

    // One kick per hoofbeat: four to a stride.
    this.sinceHoof += horse.speed * dt;
    const beat = this.gaitStride(horse.speed) / 4;
    let kicks = 0;
    while (this.sinceHoof >= beat) {
      this.sinceHoof -= beat;
      kicks++;
    }
    if (landed) kicks += 5;
    if (kicks === 0) return;

    const { x, z } = root.position;
    const surface = this.surfaceAt(x, z);
    const pace = Math.min(1, horse.speed / GAITS[3].speed); // 0 standing … 1 at a canter and above
    const f = this.forward;
    for (let n = 0; n < kicks; n++) {
      // Somewhere under the body, left or right.
      const back = rnd(-0.9, 0.7);
      const side = (Math.random() < 0.5 ? -1 : 1) * rnd(0.12, 0.3);
      const px = x + f.x * back + f.z * side;
      const pz = z + f.z * back - f.x * side;
      const ground = this.field.heightAt(px, pz);
      const carry = horse.speed * 0.25; // thrown stuff keeps a little of the horse's speed

      if (horse.waterDepth > 0.04) {
        const level = this.field.waterLevelAt(px, pz);
        const drops = 2 + Math.round(4 * pace);
        for (let i = 0; i < drops; i++) {
          this.spawn(DOT, SPRAY, px, level + 0.03, pz, f.x * carry + rnd(-1.2, 1.2), rnd(1.2, 2.2 + 2.2 * pace), f.z * carry + rnd(-1.2, 1.2), {
            life: rnd(0.45, 0.8),
            size: rnd(0.025, 0.06),
            alpha: 0.75,
            gravity: 9.8,
            floor: level,
          });
        }
        this.spawn(PUFF, SPRAY, px, level + 0.1, pz, f.x * carry + rnd(-0.4, 0.4), rnd(0.5, 1.2), f.z * carry + rnd(-0.4, 0.4), {
          life: rnd(0.4, 0.7),
          size: 0.25,
          endSize: rnd(0.7, 1.1) * (0.6 + 0.6 * pace),
          alpha: 0.22,
          gravity: 2,
        });
      } else if (surface === 'mud' || surface === 'grass') {
        // Soft ground: clods fly up behind, more of them the faster the horse goes. A walk throws nothing.
        if (horse.speed < 2.2 && !landed) continue;
        const clods = surface === 'mud' ? 2 + Math.round(2 * pace) : Math.random() < pace ? 2 : 0;
        for (let i = 0; i < clods; i++) {
          this.spawn(DOT, surface === 'mud' ? MUD : TURF, px, ground + 0.05, pz, -f.x * rnd(0.3, 1.6) + rnd(-0.7, 0.7), rnd(1.0, 1.6 + 2.2 * pace), -f.z * rnd(0.3, 1.6) + rnd(-0.7, 0.7), {
            life: rnd(0.5, 0.9),
            size: rnd(0.025, 0.055),
            alpha: 0.95,
            gravity: 9.8,
            floor: ground,
          });
        }
      } else if (Math.random() < 0.35 + 0.65 * pace) {
        // Dry trail: a low puff of dust that hangs and drifts off on the wind.
        this.spawn(PUFF, DUST, px, ground + 0.12, pz, WIND.x * 0.5 + rnd(-0.3, 0.3), rnd(0.15, 0.5), WIND.z * 0.5 + rnd(-0.3, 0.3), {
          life: rnd(0.9, 1.6),
          size: 0.25,
          endSize: rnd(0.8, 1.4) * (0.5 + 0.5 * pace),
          alpha: 0.14 + 0.14 * pace,
          drag: 0.8,
        });
      }
    }
  }

  private gaitStride(speed: number) {
    let i = 1;
    while (i < GAITS.length - 1 && speed > (GAITS[i].speed + GAITS[i + 1].speed) / 2) i++;
    return GAITS[i].stride;
  }

  /** What the horse is standing on, from the terrain's ground-cover map. Rain turns the trail to mud. */
  private surfaceAt(x: number, z: number): 'mud' | 'trail' | 'grass' {
    const i = Math.min(GRID - 1, Math.max(0, Math.round((x + HALF) / CELL)));
    const j = Math.min(GRID - 1, Math.max(0, Math.round((z + HALF) / CELL)));
    const k = (j * GRID + i) * 4;
    if (this.field.control[k + 1] > 110) return 'mud';
    if (this.field.control[k] > 185) return groundWet.value > 0.5 ? 'mud' : 'trail';
    return 'grass';
  }

  // ------------------------------------------------------------------ breath
  private breathe(dt: number, horse: HorseController) {
    // Resting: a slow breath now and then. Working: one with every stride.
    const period = horse.speed < 0.3 ? 3.2 : Math.max(0.45, Math.min(2.2, this.gaitStride(horse.speed) / horse.speed));
    this.breath -= dt / period;
    if (this.breath > 0) return;
    this.breath = 1;
    const f = this.forward;
    const strength = 0.55 + 0.45 * Math.min(1, horse.speed / GAITS[3].speed);
    for (let i = 0; i < 3; i++) {
      this.spawn(PUFF, BREATH, this.nose.x, this.nose.y, this.nose.z, f.x * (horse.speed + rnd(0.5, 1.1)) + rnd(-0.15, 0.15), rnd(-0.45, -0.1), f.z * (horse.speed + rnd(0.5, 1.1)) + rnd(-0.15, 0.15), {
        life: rnd(0.7, 1.2),
        size: 0.09,
        endSize: rnd(0.35, 0.6),
        // Plainer to see in the damp, cold air of a rainy spell.
        alpha: (0.07 + 0.07 * rainAmount.value) * strength,
        drag: 2.2,
        gravity: -0.25,
      });
    }
  }

  // ------------------------------------------------------------------ falling leaves
  private leaves(dt: number, camera: THREE.Camera) {
    this.leaf -= dt;
    if (this.leaf > 0) return;
    this.leaf = rnd(0.25, 0.6) / (0.6 + 0.8 * rainAmount.value + 0.4); // a few more come down in wind and rain
    const p = this.forest.planting;
    const cell = (v: number) => Math.min(FOREST_CELLS - 1, Math.max(0, Math.floor((v + HALF) / FOREST_CELL)));
    for (let attempt = 0; attempt < 6; attempt++) {
      const k = cell(camera.position.z + rnd(-40, 40)) * FOREST_CELLS + cell(camera.position.x + rnd(-40, 40));
      const n = p.cellStart[k + 1] - p.cellStart[k];
      if (n === 0) continue;
      const t = p.cellStart[k] + Math.floor(Math.random() * n);
      if (p.species[t] > 1) continue; // oak and birch shed leaves; pine and gorse do not
      if (Math.hypot(p.x[t] - camera.position.x, p.z[t] - camera.position.z) > 45) continue;
      const size = this.forest.speciesSize[p.species[t]];
      const reach = size.radius * p.scale[t] * 0.8;
      const colour = LEAVES[Math.floor(Math.random() * LEAVES.length)];
      this.spawn(LEAF, colour, p.x[t] + rnd(-reach, reach), p.y[t] + size.height * p.scale[t] * rnd(0.45, 0.85), p.z[t] + rnd(-reach, reach), WIND.x * rnd(0.3, 1.1), rnd(-0.9, -0.5), WIND.z * rnd(0.3, 1.1), {
        life: 14,
        size: rnd(0.07, 0.11),
        alpha: 1,
        spin: rnd(-4, 4),
        flutter: rnd(0.4, 1.0),
        floor: p.y[t] - 0.5,
      });
      return;
    }
  }

  // ------------------------------------------------------------------ midges
  private midges(camera: THREE.Camera) {
    const out = 1 - overcast.value; // they dance in the sun and are gone in the rain
    if (out < 0.05) return;
    const g = this.glow;
    const t = this.time;
    for (let s = 0; s < this.swarms.length; s++) {
      const swarm = this.swarms[s];
      const away = Math.hypot(swarm.x - camera.position.x, swarm.z - camera.position.z);
      if (away > 45) continue;
      const fade = Math.min(1, (45 - away) / 12) * out;
      for (let i = 0; i < 34; i++) {
        const a = i * 2.399 + s;
        // Each midge loops on its own small path inside a column about 2 m wide.
        const x = swarm.x + Math.sin(t * (1.1 + (i % 7) * 0.23) + a) * 0.9 + Math.sin(t * 5.3 + a * 3) * 0.12;
        const y = swarm.y + 1.5 + Math.sin(t * (0.9 + (i % 5) * 0.31) + a * 1.7) * 0.7 + Math.sin(t * 6.1 + a) * 0.08;
        const z = swarm.z + Math.cos(t * (1.3 + (i % 6) * 0.19) + a * 1.3) * 0.9 + Math.cos(t * 4.7 + a * 2) * 0.12;
        this.particles.draw(x, y, z, 0.022, g.x * 0.55, g.y * 0.55, g.z * 0.55, 0.8 * fade, DOT);
      }
    }
  }

  private spawn(
    shape: number,
    albedo: number[],
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    rest: { life: number; size: number; endSize?: number; alpha: number; gravity?: number; drag?: number; spin?: number; flutter?: number; floor?: number }
  ) {
    const l = this.light;
    this.particles.spawn({ shape, x, y, z, vx, vy, vz, r: albedo[0] * l.x, g: albedo[1] * l.y, b: albedo[2] * l.z, ...rest });
  }
}
