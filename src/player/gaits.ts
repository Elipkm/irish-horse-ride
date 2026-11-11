/** Leg order used everywhere: left hind, left fore, right hind, right fore. */
export type LegOffsets = [number, number, number, number];

export interface Gait {
  name: string;
  /** Cruising speed in m/s. */
  speed: number;
  /**
   * Ground covered by one full stride cycle, in metres. Speed / stride = strides per second.
   * Speeds and strides are matched to the horse model's animation clips (measured by
   * tools/horse_export.py) so the hooves do not slide over the ground.
   */
  stride: number;
  /** Fraction of the cycle each hoof spends on the ground. */
  duty: number;
  /** Body bounce in metres: twice per stride (walk, trot) and once per stride (canter, gallop). */
  bob2: number;
  bob1: number;
  /** Fore-aft rocking of the body in radians (canter, gallop). */
  rock: number;
  /** When each hoof lands within the cycle (0..1); this is what makes each gait look like itself. */
  offsets: Readonly<LegOffsets>;
}

export const GAITS: readonly Gait[] = [
  { name: 'Halt', speed: 0, stride: 1.33, duty: 0.64, bob2: 0, bob1: 0, rock: 0, offsets: [0, 0.25, 0.5, 0.75] },
  // Four-beat walk: LH, LF, RH, RF.
  { name: 'Walk', speed: 1.4, stride: 1.33, duty: 0.62, bob2: 0.012, bob1: 0, rock: 0.004, offsets: [0, 0.25, 0.5, 0.75] },
  // Two-beat trot: diagonal pairs together.
  { name: 'Trot', speed: 3.0, stride: 1.95, duty: 0.45, bob2: 0.04, bob1: 0, rock: 0.005, offsets: [0, 0.5, 0.5, 1] },
  // Three-beat canter (right lead): LH, then RH + LF, then RF.
  { name: 'Canter', speed: 5.0, stride: 2.6, duty: 0.4, bob2: 0, bob1: 0.05, rock: 0.05, offsets: [0, 0.3, 0.3, 0.6] },
  // Four-beat gallop: LH, RH, LF, RF.
  { name: 'Gallop', speed: 11, stride: 4.6, duty: 0.3, bob2: 0, bob1: 0.045, rock: 0.06, offsets: [0, 0.4, 0.1, 0.5] },
];

export const TOP_SPEED = GAITS[GAITS.length - 1].speed;

export interface GaitBlend {
  stride: number;
  duty: number;
  bob2: number;
  bob1: number;
  rock: number;
  offsets: LegOffsets;
}

export const newGaitBlend = (): GaitBlend => ({ stride: 1.7, duty: 0.64, bob2: 0, bob1: 0, rock: 0, offsets: [0, 0.25, 0.5, 0.75] });

/** Gait parameters for any speed, blended between the two neighbouring gaits so transitions never snap. */
export function blendGait(speed: number, out: GaitBlend): GaitBlend {
  let i = 0;
  while (i < GAITS.length - 2 && speed > GAITS[i + 1].speed) i++;
  const a = GAITS[i];
  const b = GAITS[i + 1];
  const t = Math.min(1, Math.max(0, (speed - a.speed) / (b.speed - a.speed)));
  const mix = (x: number, y: number) => x + (y - x) * t;
  out.stride = mix(a.stride, b.stride);
  out.duty = mix(a.duty, b.duty);
  out.bob2 = mix(a.bob2, b.bob2);
  out.bob1 = mix(a.bob1, b.bob1);
  out.rock = mix(a.rock, b.rock);
  for (let k = 0; k < 4; k++) out.offsets[k] = mix(a.offsets[k], b.offsets[k]);
  return out;
}
