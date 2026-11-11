/** Desktop keyboard: held keys for steering, one-shot handlers for everything else. */
export class Keyboard {
  private readonly down = new Set<string>();
  private readonly handlers = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); // no page scrolling
      this.down.add(e.code);
      if (!e.repeat) this.handlers.get(e.code)?.();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  /** Runs `handler` once each time any of the given keys goes down. */
  onPress(codes: string[], handler: () => void) {
    for (const code of codes) this.handlers.set(code, handler);
  }

  /** 1 = left, -1 = right, 0 = straight. */
  steer() {
    const left = this.down.has('KeyA') || this.down.has('ArrowLeft');
    const right = this.down.has('KeyD') || this.down.has('ArrowRight');
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
}
