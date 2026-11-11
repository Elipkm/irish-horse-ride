import { GAITS } from '../player/gaits';

export interface TouchHandlers {
  onGait(index: number): void;
  onJump(): void;
  /** Finger (or mouse) dragged by this many pixels while looking around. */
  onLook(dx: number, dy: number): void;
  /** True while a finger is held down to look around. */
  onLookHeld(held: boolean): void;
}

const STICK_RADIUS = 56; // how far the thumb can push the knob, in pixels
const DEAD_ZONE = 0.12;
const STICK_ZONE = 0.45; // touches starting in the left 45 % of the screen steer

/**
 * Two-thumb controls for the iPad. Left thumb: a joystick that appears wherever the thumb lands and
 * steers. Right thumb: pace buttons and Jump. A drag anywhere else looks around (with a mouse, any drag).
 * Each finger is tracked separately, so steering, looking and tapping buttons all work at once.
 */
export class TouchControls {
  /** Steering from the joystick: 1 = full left, -1 = full right. */
  steer = 0;

  private stickPointer: number | null = null;
  private lookPointer: number | null = null;
  private originX = 0;
  private originY = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly stick = document.getElementById('stick')!;
  private readonly knob = document.getElementById('knob')!;
  private readonly gaitButtons: HTMLButtonElement[] = [];

  constructor(surface: HTMLElement, handlers: TouchHandlers) {
    // Pace buttons, fastest at the top so the thumb rests near Walk and Stop.
    const stack = document.getElementById('gaits')!;
    GAITS.forEach((gait, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = index === 0 ? 'Stop' : gait.name;
      this.press(b, () => handlers.onGait(index));
      this.gaitButtons[index] = b;
      stack.prepend(b);
    });
    this.press(document.getElementById('btn-jump')!, handlers.onJump);

    surface.addEventListener('pointerdown', (e) => {
      const steering = e.pointerType !== 'mouse' && e.clientX < window.innerWidth * STICK_ZONE;
      if (steering && this.stickPointer === null) {
        this.stickPointer = e.pointerId;
        // Keep the whole joystick on screen even when the thumb lands near an edge.
        const margin = STICK_RADIUS + 14;
        this.originX = Math.min(Math.max(e.clientX, margin), window.innerWidth - margin);
        this.originY = Math.min(Math.max(e.clientY, margin), window.innerHeight - margin);
        this.stick.style.left = `${this.originX}px`;
        this.stick.style.top = `${this.originY}px`;
        this.stick.classList.add('active');
        this.moveStick(e.clientX, e.clientY);
      } else if (!steering && this.lookPointer === null) {
        this.lookPointer = e.pointerId;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        handlers.onLookHeld(true);
      } else {
        return;
      }
      surface.setPointerCapture(e.pointerId);
    });

    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) {
        this.moveStick(e.clientX, e.clientY);
      } else if (e.pointerId === this.lookPointer) {
        handlers.onLook(e.clientX - this.lastX, e.clientY - this.lastY);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });

    const release = (e: PointerEvent) => {
      if (e.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.steer = 0;
        this.knob.style.transform = '';
        this.stick.classList.remove('active');
        this.stick.style.left = this.stick.style.top = ''; // back to its resting corner
      } else if (e.pointerId === this.lookPointer) {
        this.lookPointer = null;
        handlers.onLookHeld(false);
      }
    };
    surface.addEventListener('pointerup', release);
    surface.addEventListener('pointercancel', release);

    // Safari: no pinch zoom, no rubber-band scrolling, no long-press menu, no double-tap zoom.
    for (const type of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick']) {
      document.addEventListener(type, (e) => e.preventDefault());
    }
    document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Highlights the pace the horse has been asked for. */
  showGait(index: number) {
    this.gaitButtons.forEach((b, i) => b.classList.toggle('active', i === index));
  }

  /** Buttons react when the finger lands, not when it lifts. */
  private press(button: HTMLElement, action: () => void) {
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      action();
    });
  }

  private moveStick(x: number, y: number) {
    let dx = x - this.originX;
    let dy = y - this.originY;
    const reach = Math.hypot(dx, dy);
    if (reach > STICK_RADIUS) {
      dx *= STICK_RADIUS / reach;
      dy *= STICK_RADIUS / reach;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Only left/right steers. A small dead zone, then a gentle curve so small corrections stay small.
    const push = dx / STICK_RADIUS;
    const amount = Math.max(0, (Math.abs(push) - DEAD_ZONE) / (1 - DEAD_ZONE));
    this.steer = -Math.sign(push) * amount ** 1.4;
  }
}
