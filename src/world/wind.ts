import { cos, dot, sin, uniform, vec2 } from 'three/tsl';

type Vec2Node = ReturnType<typeof vec2>;

/** Seconds of wind animation; advanced once per frame by the game loop. */
export const windTime = uniform(0);
/** 0 = still air, 1 = the default light breeze. */
export const windStrength = uniform(1);

const DIR = vec2(0.82, 0.57); // the breeze blows up the valley, slightly across it

/**
 * Horizontal push of the wind at a world position (x, z), roughly within [-1, 1] per axis.
 * Slow gusts roll downwind as broad waves; a faster, smaller ripple rides on top. Built from
 * sines only, so it is cheap enough to run for every grass blade and leaf vertex.
 */
export function windAt(xz: Vec2Node) {
  const along = dot(xz, DIR);
  const gust = sin(along.mul(0.045).sub(windTime.mul(0.7))).mul(0.5).add(0.5); // 0..1, ~140 m waves
  const swell = sin(along.mul(0.31).sub(windTime.mul(1.9)).add(xz.x.mul(0.07))); // ~20 m waves
  const ripple = vec2(sin(xz.y.mul(1.3).add(windTime.mul(2.7))), cos(xz.x.mul(1.1).sub(windTime.mul(2.3))));
  return DIR.mul(gust.mul(0.55).add(0.2).add(swell.mul(0.25)))
    .add(ripple.mul(0.18))
    .mul(windStrength);
}
