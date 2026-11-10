import * as THREE from 'three/webgpu';
import { HALF, WATER_LEVEL, type Heightfield } from './heightfield';
import { createNoise2D, fbm } from './noise';

/**
 * Distant mountain range: one low-poly ring around the valley, far enough that fog reduces it to
 * layered silhouettes. Scenery only: nothing here is rideable.
 */
export function createMountains(): THREE.Mesh {
  const noise = createNoise2D(77);
  const SEGMENTS = 128;
  // radius, base height, how much of the ridge noise applies
  const RINGS: ReadonlyArray<readonly [number, number, number]> = [
    [HALF * 0.9, -40, 0],
    [1500, 60, 0.25],
    [2100, 190, 0.7],
    [2700, 330, 1],
    [3400, 180, 0.6],
    [4300, -20, 0],
  ];
  const positions = new Float32Array(SEGMENTS * RINGS.length * 3);
  for (let s = 0; s < SEGMENTS; s++) {
    const a = (s / SEGMENTS) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    // Sample noise on a circle so the range closes seamlessly.
    const ridge = 0.5 + 0.5 * fbm(noise, cx * 2.2 + 5, cz * 2.2, 4);
    const rough = fbm(noise, cx * 9, cz * 9 + 3, 3);
    RINGS.forEach(([radius, base, amount], r) => {
      const k = (r * SEGMENTS + s) * 3;
      const wobble = 1 + 0.06 * rough * amount;
      positions[k] = cx * radius * wobble;
      positions[k + 1] = base + amount * (260 * ridge + 70 * rough);
      positions[k + 2] = cz * radius * wobble;
    });
  }
  const indices: number[] = [];
  for (let r = 0; r < RINGS.length - 1; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = r * SEGMENTS + s;
      const b = r * SEGMENTS + ((s + 1) % SEGMENTS);
      const c = a + SEGMENTS;
      const d = b + SEGMENTS;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x4a5a3c, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * Placeholder lake surface: a flat, dark, glossy sheet that mirrors the sky through image-based
 * lighting. The real water shader (reflections, flow, shoreline foam) is milestone 6.
 */
export function createLakePlaceholder(field: Heightfield): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(520, 680).rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x10181a, roughness: 0.06, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(field.lakeCentre.x, WATER_LEVEL, field.lakeCentre.z);
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}
