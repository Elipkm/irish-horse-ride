/**
 * Watches the frame rate and moves the quality level down when the game cannot keep up, and back up
 * when there is plenty to spare. Measures in windows of a few seconds so one hitch changes nothing.
 * If going up brings the slowdown straight back, that level becomes the ceiling for this session.
 */
export class AutoQuality {
  enabled = true;

  private frames = 0;
  private time = 0;
  private settle = 6; // seconds to ignore after start-up or a change
  private good = 0; // consecutive fast windows
  private ceiling: number;
  private lastUp = -Infinity;
  private clock = 0;

  constructor(
    private readonly top: number,
    private level: number,
    private readonly apply: (level: number) => void
  ) {
    this.ceiling = top;
  }

  setLevel(level: number) {
    this.level = level;
    this.settle = 4;
    this.frames = this.time = this.good = 0;
  }

  /** Call every frame with the frame time in seconds. */
  update(dt: number) {
    this.clock += dt;
    if (!this.enabled || document.hidden) return;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    this.frames++;
    this.time += dt;
    if (this.time < 3) return;
    const fps = this.frames / this.time;
    this.frames = this.time = 0;

    if (fps < 40 && this.level > 0) {
      // Dropped soon after climbing: that level is too much for this device.
      if (this.clock - this.lastUp < 40) this.ceiling = Math.min(this.ceiling, this.level - 1);
      this.change(this.level - 1);
    } else if (fps > 56 && this.level < this.ceiling) {
      if (++this.good >= 3) {
        this.lastUp = this.clock;
        this.change(this.level + 1);
      }
    } else {
      this.good = 0;
    }
  }

  private change(level: number) {
    this.level = level;
    this.good = 0;
    this.settle = 4; // let the new level settle before judging it
    this.apply(level);
  }
}
