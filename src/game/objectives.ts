export interface Waypoint {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Ride within this many metres to have found it. */
  radius: number;
}

/**
 * The relaxing goals: places to find in the valley, in any order. No timer and no failing. The
 * pointer shows one place at a time; it stays on that one until it is found (or the rider taps to
 * pick another), so it does not flicker between places as the horse moves.
 */
export class Objectives {
  readonly visited = new Set<string>();
  current: Waypoint | null = null;

  constructor(
    readonly waypoints: Waypoint[],
    saved: string[]
  ) {
    for (const id of saved) if (waypoints.some((w) => w.id === id)) this.visited.add(id);
  }

  get done() {
    return this.visited.size === this.waypoints.length;
  }

  /** Picks the nearest place not yet found, if none is picked. */
  ensureTarget(x: number, z: number) {
    if (this.current && !this.visited.has(this.current.id)) return;
    this.current = null;
    let best = Infinity;
    for (const w of this.waypoints) {
      if (this.visited.has(w.id)) continue;
      const d = Math.hypot(w.x - x, w.z - z);
      if (d < best) {
        best = d;
        this.current = w;
      }
    }
  }

  /** Switches the pointer to the next place not yet found. */
  cycle() {
    const open = this.waypoints.filter((w) => !this.visited.has(w.id));
    if (open.length === 0) return;
    const i = this.current ? open.indexOf(this.current) : -1;
    this.current = open[(i + 1) % open.length];
  }

  /** Any place within reach is found, not just the pointed-at one. Returns what was newly found. */
  update(x: number, z: number): Waypoint | null {
    for (const w of this.waypoints) {
      if (!this.visited.has(w.id) && Math.hypot(w.x - x, w.z - z) <= w.radius) {
        this.visited.add(w.id);
        return w;
      }
    }
    return null;
  }

  reset() {
    this.visited.clear();
    this.current = null;
  }
}
