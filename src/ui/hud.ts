/** HTML overlay: stats line, loading screen and the settings buttons. (Riding controls: input/touchControls.ts.) */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
