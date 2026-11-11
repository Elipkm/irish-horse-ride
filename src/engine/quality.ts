// Manual quality levels (plan §3). Automatic scaling on fps drops comes with the M9 quality manager.
//
// pixelRatio:   render resolution relative to CSS pixels (capped by the device's own ratio).
// terrainRange: radius in metres of full terrain detail around the camera.
// grassTufts:   grass tufts in each of the three grass rings (5 triangles per tuft).
// treeRange:    trees nearer than this many metres are full models; beyond it, flat pictures (impostors).

export const QUALITY_LEVELS = [
  { name: 'Low', pixelRatio: 1, terrainRange: 80, grassTufts: 2000, treeRange: 28 },
  { name: 'Medium', pixelRatio: 1.5, terrainRange: 100, grassTufts: 3600, treeRange: 38 },
  { name: 'High', pixelRatio: 2, terrainRange: 130, grassTufts: 4200, treeRange: 45 },
] as const;
export type Quality = (typeof QUALITY_LEVELS)[number];

const KEY = 'horse.quality';

export function loadQualityIndex(): number {
  try {
    const i = Number(localStorage.getItem(KEY));
    if (Number.isInteger(i) && i >= 0 && i < QUALITY_LEVELS.length && localStorage.getItem(KEY) !== null) return i;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return 1;
}

export function saveQualityIndex(i: number) {
  try {
    localStorage.setItem(KEY, String(i));
  } catch {
    // Not fatal: the choice just will not persist.
  }
}
