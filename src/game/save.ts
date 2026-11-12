/** Progress that survives closing the app: places found, where the horse stands, distance ridden, photos taken. */
export interface SaveData {
  visited: string[];
  x: number;
  z: number;
  heading: number;
  /** Metres ridden in all. */
  distance: number;
  photos: number;
}

const KEY = 'horse.save';

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SaveData>;
    return {
      visited: Array.isArray(d.visited) ? d.visited.filter((v) => typeof v === 'string') : [],
      x: Number(d.x),
      z: Number(d.z),
      heading: Number(d.heading),
      distance: Number(d.distance) || 0,
      photos: Number(d.photos) || 0,
    };
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable (private mode): the game still plays, it just will not remember.
  }
}
