import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  saturate,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { CELL, HALF, LEAF_CELLS, WORLD_SIZE, type Heightfield } from './heightfield';

export const GROUND_LAYERS = ['grass', 'moss', 'mud', 'gravel', 'rock'] as const;
export type GroundLayer = (typeof GROUND_LAYERS)[number];
/**
 * Per layer: `col` = albedo (sRGB), `nr` = normal x,y + roughness (linear), see tools/assets.mjs;
 * `mean` = average albedo colour, used in the distance where the tiling pattern would show.
 */
export type GroundTextures = Record<GroundLayer, { col: THREE.Texture; nr: THREE.Texture; mean: THREE.Color }>;

export interface TerrainMaterial {
  material: THREE.MeshStandardNodeMaterial;
  /** Camera position on the ground plane (x, z); drives level-of-detail morphing. */
  cameraXZ: THREE.Vector2;
  /** Radius in metres of the finest detail ring. Each further ring doubles it. */
  lodRange: { value: number };
}

/** World x,z -> texture coordinate of the heightfield-sized maps (texel centres on grid points). */
const mapUv = (xz: ReturnType<typeof vec2>) => xz.add(HALF + CELL / 2).div(WORLD_SIZE + CELL);

export function createTerrainMaterial(field: Heightfield, ground: GroundTextures): TerrainMaterial {
  const cameraXZ = uniform(new THREE.Vector2());
  const lodRange = uniform(100);

  // ---------------------------------------------------------------- vertex: LOD morph + height
  // Each instance is one quadtree node: nodeData = (origin x, origin z, size). The patch grid has
  // integer vertex indices 0..32. Far from the camera, odd vertices slide onto their even
  // neighbour so a patch turns smoothly into the next coarser level; because the slide depends
  // only on world position, neighbouring patches always agree and no cracks open.
  const nodeData = attribute('nodeData', 'vec3');
  const terrainPosition = Fn(() => {
    const spacing0 = nodeData.z.div(LEAF_CELLS);
    const p = nodeData.xy.add(positionGeometry.xz.mul(spacing0)).toVar();
    let index = positionGeometry.xz;
    let spacing = spacing0;
    for (let step = 0; step < 3; step++) {
      const range = lodRange.mul(spacing).div(CELL);
      const k = saturate(length(p.sub(cameraXZ)).sub(range.mul(0.72)).div(range.mul(0.22)));
      const odd = fract(index.mul(0.5)).mul(2);
      p.subAssign(odd.mul(spacing).mul(k));
      index = floor(index.mul(0.5));
      spacing = spacing.mul(2);
    }
    const h = texture(field.heightTexture, mapUv(p)).level(0).r;
    return vec3(p.x, h, p.y);
  })();

  // ---------------------------------------------------------------- fragment: ground cover
  const wp = positionWorld;
  const uvMap = mapUv(wp.xz);
  const normalAo = texture(field.normalAoTexture, uvMap);
  const control = texture(field.controlTexture, uvMap);

  const nxz = normalAo.rg.mul(2).sub(1);
  const baseNormal = vec3(nxz.x, sqrt(saturate(float(1).sub(dot(nxz, nxz)))), nxz.y);
  const viewDist = length(wp.sub(cameraPosition));
  // ~[-1, 1], roughens every blend edge. Procedural noise has no mipmaps, so it is faded out with
  // distance; otherwise the blend edges shimmer on far slopes.
  const breakup = mx_noise_float(wp.xz.mul(0.23)).mul(float(1).sub(smoothstep(70, 260, viewDist)));

  const sample = (layer: GroundLayer, uv: ReturnType<typeof vec2>) => ({
    col: texture(ground[layer].col, uv).rgb,
    nr: texture(ground[layer].nr, uv).rgb,
  });
  const detail = (nr: ReturnType<typeof vec3>) => nr.rg.mul(2).sub(1);

  const grass = sample('grass', wp.xz.div(3.1));
  const moss = sample('moss', wp.xz.div(4.3));
  const mud = sample('mud', wp.xz.div(2.7));
  const gravel = sample('gravel', wp.xz.div(2.2));
  // Rock sits on steep ground, where a top-down projection would smear: project from the two sides.
  const rockX = sample('rock', wp.zy.div(5));
  const rockZ = sample('rock', wp.xy.div(5));
  const facingX = abs(baseNormal.x).div(abs(baseNormal.x).add(abs(baseNormal.z)).add(1e-4));

  // Grass: second, much larger sample hides tiling in the middle distance; the control map's
  // large-scale channel shifts the green from field to field.
  const grassFar = texture(ground.grass.col, wp.xz.div(29)).rgb;
  const macro = control.a;
  const grassTint = mix(vec3(0.55, 1.0, 0.42), vec3(0.9, 1.06, 0.46), macro);
  const grassShade = grassTint.mul(1.25);
  const mossTint = mix(vec3(0.95, 0.9, 0.7), vec3(0.8, 1.0, 0.6), macro);
  const mudTint = vec3(1.55, 1.38, 1.15); // source scan is near-black; lift to wet peat brown
  const grassCol = mix(grass.col, grassFar, smoothstep(14, 60, viewDist)).mul(grassShade);

  // Blend weights.
  const wMoss = smoothstep(0.3, 0.78, control.b.add(breakup.mul(0.2)));
  const pathField = control.r.add(breakup.mul(0.035));
  const wPath = smoothstep(0.74, 0.82, pathField); // ≈ 3 m wide
  const wVerge = smoothstep(0.58, 0.74, pathField).mul(0.55); // worn, muddy edge
  const wMud = max(smoothstep(0.4, 0.75, control.g.add(breakup.mul(0.18))), wVerge);
  const wRock = float(1).sub(smoothstep(0.76, 0.87, baseNormal.y.add(breakup.mul(0.035))));

  const wet = control.g.mul(float(1).sub(wRock));
  type Rgb = ReturnType<typeof vec3>;
  const layered = (g: Rgb, mo: Rgb, mu: Rgb, gr: Rgb, ro: Rgb) =>
    mix(mix(mix(mix(g, mo.mul(mossTint), wMoss), mu.mul(mudTint), wMud), gr, wPath), ro, wRock);
  const mean = (layer: GroundLayer) => vec3(uniform(ground[layer].mean));
  const nearAlbedo = layered(grassCol, moss.col, mud.col, gravel.col, mix(rockZ.col, rockX.col, facingX));
  // Far away each texture repeats every few pixels and reads as a regular grain. Fade to the same
  // blend built from each layer's average colour instead.
  const farAlbedo = layered(mean('grass').mul(grassShade), mean('moss'), mean('mud'), mean('gravel'), mean('rock'));
  const albedo = mix(nearAlbedo, farAlbedo, smoothstep(90, 380, viewDist).mul(0.9)).mul(mix(1, 0.82, wet));

  const rockRough = mix(rockZ.nr.b, rockX.nr.b, facingX);
  const roughness = mix(
    mix(mix(mix(mix(grass.nr.b, moss.nr.b, wMoss), mud.nr.b, wMud), gravel.nr.b, wPath), rockRough, wRock),
    0.28,
    wet.mul(0.6)
  );

  // Detail normals, added to the baked terrain normal in world space.
  const groundDetail = mix(mix(mix(detail(grass.nr), detail(moss.nr), wMoss), detail(mud.nr), wMud), detail(gravel.nr), wPath);
  const dz = detail(rockZ.nr);
  const dx = detail(rockX.nr);
  const rockDetail = mix(vec3(dz.x, dz.y, 0), vec3(0, dx.y, dx.x), facingX);
  const detailStrength = mix(1.0, 0.12, smoothstep(25, 300, viewDist));
  const worldNormal = normalize(
    baseNormal.add(mix(vec3(groundDetail.x, 0, groundDetail.y), rockDetail, wRock).mul(detailStrength))
  );

  const material = new THREE.MeshStandardNodeMaterial();
  material.positionNode = terrainPosition;
  material.colorNode = albedo;
  material.roughnessNode = roughness;
  material.metalness = 0;
  material.aoNode = normalAo.b;
  material.normalNode = cameraViewMatrix.transformDirection(worldNormal);

  return { material, cameraXZ: cameraXZ.value, lodRange };
}
