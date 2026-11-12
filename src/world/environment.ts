import * as THREE from 'three/webgpu';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { abs, cameraPosition, dot, exp, float, fog, length, mix, positionWorld, pow, saturate, select, uniform } from 'three/tsl';
import { CLOUD_HEIGHT, cloudShadowShift, overcast, skyDim } from './atmosphere';
import { WATER_LEVEL } from './heightfield';

export interface Environment {
  /** Unit vector pointing from the ground towards the sun, measured from the sky image. */
  sunDirection: THREE.Vector3;
  sun: THREE.DirectionalLight;
  /** The sky image (equirectangular, HDR): also what the water reflects. */
  sky: THREE.Texture;
  /** Sky colour just above the horizon, all around and below the sun. Linear, in the sky image's units. */
  horizon: THREE.Vector3;
  sunHorizon: THREE.Vector3;
  fog: {
    /** Fog per metre everywhere. */
    baseDensity: { value: number };
    /** Extra fog per metre at lake level; thins out with height (valley mist). */
    mistDensity: { value: number };
  };
}

/** Measurements taken from the equirectangular sky image so light and fog always match it. */
function analyseSky(tex: THREE.DataTexture) {
  const { data, width, height } = tex.image as unknown as { data: Uint16Array; width: number; height: number };
  const f = THREE.DataUtils.fromHalfFloat;
  const dirOf = (col: number, row: number, out: THREE.Vector3) => {
    // Matches three's equirect lookup: u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5; row 0 is the top.
    const az = ((col + 0.5) / width - 0.5) * Math.PI * 2;
    const el = (0.5 - (row + 0.5) / height) * Math.PI;
    return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  };

  // Sun: brightness-weighted mean direction of the upper hemisphere (weight favours the very brightest pixels).
  const sunDirection = new THREE.Vector3();
  const d = new THREE.Vector3();
  let peak = 0;
  for (let k = 0; k < width * (height / 2) * 4; k += 4) peak = Math.max(peak, f(data[k]) + f(data[k + 1]) + f(data[k + 2]));
  for (let row = 0; row < height / 2; row++) {
    for (let col = 0; col < width; col++) {
      const k = (row * width + col) * 4;
      const rel = (f(data[k]) + f(data[k + 1]) + f(data[k + 2])) / peak;
      if (rel < 0.25) continue;
      dirOf(col, row, d);
      sunDirection.addScaledVector(d, rel ** 4 * Math.hypot(d.x, d.z));
    }
  }
  sunDirection.normalize();
  const sunAz = Math.atan2(sunDirection.z, sunDirection.x);

  // Colours: the sun disc/glow, the horizon all around, and the horizon below the sun.
  const sunColor = new THREE.Vector3();
  const horizon = new THREE.Vector3();
  const sunHorizon = new THREE.Vector3();
  let nSun = 0;
  let nHor = 0;
  let nSunHor = 0;
  for (let row = 0; row < height / 2; row++) {
    const el = (0.5 - (row + 0.5) / height) * 180;
    for (let col = 0; col < width; col++) {
      const k = (row * width + col) * 4;
      const r = f(data[k]);
      const g = f(data[k + 1]);
      const b = f(data[k + 2]);
      if (dirOf(col, row, d).dot(sunDirection) > 0.992) {
        sunColor.x += r;
        sunColor.y += g;
        sunColor.z += b;
        nSun++;
      }
      if (el > 1 && el < 7) {
        horizon.x += r;
        horizon.y += g;
        horizon.z += b;
        nHor++;
        let dAz = Math.abs(((col + 0.5) / width - 0.5) * Math.PI * 2 - sunAz);
        if (dAz > Math.PI) dAz = Math.PI * 2 - dAz;
        if (dAz < 0.45) {
          sunHorizon.x += r;
          sunHorizon.y += g;
          sunHorizon.z += b;
          nSunHor++;
        }
      }
    }
  }
  sunColor.divideScalar(Math.max(1, nSun));
  sunColor.divideScalar(Math.max(sunColor.x, sunColor.y, sunColor.z, 1e-6)); // hue only
  horizon.divideScalar(Math.max(1, nHor));
  sunHorizon.divideScalar(Math.max(1, nSunHor));
  return { sunDirection, sunColor, horizon, sunHorizon };
}

export async function loadEnvironment(scene: THREE.Scene, url: string): Promise<Environment> {
  const sky = await new RGBELoader().loadAsync(url);
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  scene.environment = sky; // image-based lighting for every PBR material

  const { sunDirection, sunColor, horizon, sunHorizon } = analyseSky(sky);

  // The sky image already lights the scene softly; this directional light adds the sun's shaping.
  const sun = new THREE.DirectionalLight(new THREE.Color(sunColor.x, sunColor.y, sunColor.z).lerp(new THREE.Color(1, 0.93, 0.82), 0.5), 3.2);
  sun.position.copy(sunDirection).multiplyScalar(1000);
  scene.add(sun);

  // Fog = thin haze everywhere + mist that pools in the valley (density falls off with height),
  // integrated analytically along the view ray. Its colour follows the sky: brighter towards the sun.
  const baseDensity = uniform(1 / 9000);
  const mistDensity = uniform(1 / 2600);
  const falloff = 1 / 55; // mist halves roughly every 38 m of height
  const ray = positionWorld.sub(cameraPosition);
  const dist = length(ray);
  const dir = ray.div(dist);
  const t = dir.y.mul(dist).mul(falloff);
  const tSafe = select(abs(t).lessThan(1e-3), float(1e-3), t);
  const column = float(1).sub(exp(tSafe.negate())).div(tSafe); // mean mist density along the ray, relative to the camera's height
  const mistAtCamera = mistDensity.mul(exp(cameraPosition.y.sub(WATER_LEVEL).mul(-falloff)));
  const opticalDepth = dist.mul(baseDensity.add(mistAtCamera.mul(column)));
  const amount = float(1).sub(exp(opticalDepth.negate()));
  // Under a closed sky the glow towards the sun goes and everything dims with the sky.
  const towardsSun = pow(saturate(dot(dir, uniform(sunDirection))), 4).mul(overcast.mul(-0.85).add(1));
  const color = mix(uniform(horizon), uniform(sunHorizon), towardsSun).mul(skyDim);
  scene.fogNode = fog(color, amount);

  // A cloud shades the ground some way off, on the side away from the sun.
  const reach = CLOUD_HEIGHT / Math.max(0.15, sunDirection.y);
  cloudShadowShift.value.set(sunDirection.x * reach, sunDirection.z * reach);

  return { sunDirection, sun, sky, horizon, sunHorizon, fog: { baseDensity, mistDensity } };
}
