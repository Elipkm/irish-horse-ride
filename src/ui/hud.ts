/** HTML overlay: stats line, loading screen and the settings buttons. (Riding controls: input/touchControls.ts.) */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer = 0;

export const hud = {
  setStats(text: string) {
    el('hud').textContent = text;
  },

  setLoading(label: string, fraction: number) {
    el('loading-label').textContent = label;
    el('loading-bar').style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  },

  hideLoading() {
    el('loading').remove();
    el('controls').hidden = false;
    el('ride').hidden = false;
    el('objective').hidden = false;
    el('stamina').hidden = false;
  },

  /** Objective pointer: place name, detail line, and the arrow's angle in degrees (0 = straight ahead). */
  setObjective(name: string, detail: string, bearingDeg: number) {
    el('obj-name').textContent = name;
    el('obj-dist').textContent = detail;
    el('compass').style.transform = `rotate(${bearingDeg.toFixed(1)}deg)`;
  },

  onObjectiveTap(action: () => void) {
    el('objective').addEventListener('click', action);
  },

  setStamina(fraction: number, tired: boolean) {
    el('stamina-bar').style.width = `${Math.round(fraction * 100)}%`;
    el('stamina').classList.toggle('tired', tired);
  },

  /** A short message in the upper middle of the screen. */
  toast(text: string, ms = 3500) {
    const t = el('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
  },

  flash() {
    const f = el('flash');
    f.classList.remove('go');
    void f.offsetWidth; // restart the animation
    f.classList.add('go');
  },

  showError(message: string) {
    document.getElementById('loading')?.remove();
    el('hud').textContent = message;
  },

  /** Wires a button: `label()` is re-read after every press. Returns a function that re-reads it on demand. */
  button(id: string, label: () => string, onPress: () => void) {
    const b = el<HTMLButtonElement>(id);
    const refresh = () => (b.textContent = label());
    b.addEventListener('click', () => {
      onPress();
      refresh();
    });
    refresh();
    return refresh;
  },
};
