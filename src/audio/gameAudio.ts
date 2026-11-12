import { rainAmount } from '../world/atmosphere';
import { windStrength } from '../world/wind';

// All sound is made in code (Web Audio): no sound files, so nothing to license or download.
// Layers: wind, rain, a stream near water, birdsong, hoofbeats on four surfaces, the horse's
// breathing, and a slow generative tune in the manner of a tin whistle over a drone.

export type HoofKind = 'water' | 'wood' | 'mud' | 'trail' | 'grass';
export const SOUND_MODES = ['On', 'No music', 'Off'] as const;

const KEY = 'horse.sound';
const rnd = (a: number, b: number) => a + (b - a) * Math.random();
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** D dorian, in Hz: a drone on D, and a whistle tune picked from these. */
const D2 = 73.42;
const SCALE = [293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25, 587.33, 659.25];

export class GameAudio {
  /** Index into SOUND_MODES. */
  mode = 0;
  /** What the listener hears, set by the game each frame. */
  nearRiver = 0;
  nearLake = 0;
  speed01 = 0;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private delay!: DelayNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rain!: GainNode;
  private river!: GainNode;
  private lake!: GainNode;
  private time = 0;
  private birdIn = 3;
  private noteIn = 6;
  private phrase = 0;
  private lastBreath = 0;

  constructor() {
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (saved >= 0 && saved < SOUND_MODES.length) this.mode = saved;
    } catch {
      // No storage: default mode.
    }
    // iOS only lets sound start from a touch; try on every kind of gesture until it runs.
    const unlock = () => {
      this.start();
      if (this.ctx?.state === 'running') for (const t of ['pointerup', 'touchend', 'click', 'keydown']) window.removeEventListener(t, unlock, true);
    };
    for (const t of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(t, unlock, true);
    // Silent while the tab or app is in the background.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  get name() {
    return SOUND_MODES[this.mode];
  }

  next() {
    this.mode = (this.mode + 1) % SOUND_MODES.length;
    try {
      localStorage.setItem(KEY, String(this.mode));
    } catch {
      // Not fatal.
    }
    this.applyMode();
  }

  private applyMode() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.mode === 2 ? 0 : 1, t, 0.15);
    this.music.gain.setTargetAtTime(this.mode === 0 ? 0.55 : 0, t, 0.4);
  }

  private start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    void ctx.resume();

    const limiter = ctx.createDynamicsCompressor();
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(limiter);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.connect(this.master);

    // Two seconds of noise, looped for every wash of sound (wind, rain, water).
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.97 * b0 + 0.03 * white; // brownish: soft low rumble
      data[i] = white * 0.5 + b0 * 12;
    }
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    for (let i = 0; i < data.length; i++) data[i] /= peak;

    const loop = (type: BiquadFilterType, freq: number, q: number, out: AudioNode) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.loopStart = rnd(0, 0.5);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(out);
      src.start();
      return { f, g };
    };
    const w = loop('bandpass', 380, 0.6, this.sfx);
    this.wind = w.g;
    this.windFilter = w.f;
    this.rain = loop('highpass', 1800, 0.5, this.sfx).g;
    const river = loop('bandpass', 1100, 0.7, this.sfx);
    this.river = river.g;
    this.lake = loop('lowpass', 500, 0.5, this.sfx).g;

    // Echo for the tune, softened so it sounds like a valley.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = 0.42;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1800;
    this.delay.connect(damp).connect(feedback).connect(this.delay);
    damp.connect(this.music);

    // Drone: D and A, a fifth apart, breathing very slowly.
    for (const [hz, level] of [[D2, 0.05], [D2 * 1.5, 0.035], [D2 * 2, 0.02]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = level;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rnd(0.03, 0.08);
      const depth = ctx.createGain();
      depth.gain.value = level * 0.6;
      lfo.connect(depth).connect(g.gain);
      o.connect(g).connect(this.music);
      o.start();
      lfo.start();
    }
    this.applyMode();
  }

  /** Per frame. Wind and rain follow the weather; water follows how close the horse is. */
  update(dt: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.mode === 2) return;
    this.time += dt;
    const t = ctx.currentTime;
    const gust = 0.75 + 0.25 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.91 + 1);
    const w = windStrength.value;
    this.wind.gain.setTargetAtTime((0.05 + 0.04 * w + 0.12 * this.speed01) * gust * (0.7 + 0.3 * w), t, 0.3);
    this.windFilter.frequency.setTargetAtTime(300 + 350 * this.speed01 + 120 * w, t, 0.4);
    this.rain.gain.setTargetAtTime(rainAmount.value * 0.07, t, 0.5);
    this.river.gain.setTargetAtTime(clamp01(this.nearRiver) ** 2 * 0.22, t, 0.3);
    this.lake.gain.setTargetAtTime(clamp01(this.nearLake) ** 2 * 0.12, t, 0.3);

    // Birds, fewer in rain.
    this.birdIn -= dt;
    if (this.birdIn <= 0) {
      this.birdIn = rnd(1.5, 6) * (1 + 2.5 * rainAmount.value);
      this.bird();
    }
    // The tune: a phrase of a few notes, then a long rest.
    this.noteIn -= dt;
    if (this.noteIn <= 0 && this.mode === 0) {
      if (this.phrase <= 0) this.phrase = Math.floor(rnd(3, 7));
      this.whistle();
      this.phrase--;
      this.noteIn = this.phrase > 0 ? rnd(0.7, 1.6) : rnd(16, 30); // notes close together, then a long rest
    }
  }

  private whistle() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const hz = SCALE[Math.floor(Math.random() * SCALE.length)];
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vd = ctx.createGain();
    vd.gain.value = hz * 0.006;
    vib.connect(vd).connect(o.frequency);
    const g = ctx.createGain();
    const len = rnd(1.4, 2.6);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    o.connect(g);
    g.connect(this.music);
    g.connect(this.delay);
    o.start(t);
    vib.start(t);
    o.stop(t + len + 0.1);
    vib.stop(t + len + 0.1);
  }

  private bird() {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.02;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.9, 0.9);
    pan.connect(this.sfx);
    const base = rnd(2200, 4800);
    const level = rnd(0.012, 0.035);
    const kind = Math.random();
    const notes = kind < 0.5 ? Math.floor(rnd(2, 5)) : Math.floor(rnd(5, 10));
    const gap = kind < 0.5 ? rnd(0.12, 0.2) : rnd(0.05, 0.08);
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * gap;
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = base * (1 + (kind < 0.5 ? i * 0.04 : (i % 2) * 0.2));
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * rnd(0.75, 1.35), t + gap * 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0005, t + gap * 0.9);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + gap);
    }
  }

  /** One hoofbeat. `speed` in m/s. */
  hoof(kind: HoofKind, speed: number, landing: boolean) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.mode === 2) return;
    const t = ctx.currentTime;
    const power = (landing ? 1.6 : 0.45 + 0.55 * clamp01(speed / 9)) * rnd(0.85, 1.1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rnd(-0.12, 0.12);
    pan.connect(this.sfx);
    const burst = (type: BiquadFilterType, hz: number, q: number, level: number, length: number, delay = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz * rnd(0.9, 1.1);
      f.Q.value = q;
      const g = ctx.createGain();
      const s = t + delay;
      g.gain.setValueAtTime(level * power, s);
      g.gain.exponentialRampToValueAtTime(0.001, s + length);
      src.connect(f).connect(g).connect(pan);
      src.start(s, rnd(0, 1.5));
      src.stop(s + length + 0.02);
    };
    const thump = (hz: number, level: number, length: number) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(hz * 1.4, t);
      o.frequency.exponentialRampToValueAtTime(hz, t + 0.04);
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * power, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + length);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + length + 0.02);
    };
    switch (kind) {
      case 'grass':
        burst('bandpass', 420, 0.9, 0.9, 0.09);
        thump(85, 0.55, 0.12);
        break;
      case 'mud':
        burst('bandpass', 260, 0.7, 1.2, 0.16);
        burst('lowpass', 700, 0.5, 0.5, 0.1, 0.03);
        thump(70, 0.5, 0.14);
        break;
      case 'trail':
        burst('bandpass', 1900, 1.2, 0.5, 0.05);
        burst('bandpass', 750, 1, 0.8, 0.08, 0.008);
        thump(95, 0.5, 0.1);
        break;
      case 'wood':
        thump(150, 0.9, 0.16);
        burst('bandpass', 1300, 2, 0.5, 0.05);
        break;
      case 'water':
        burst('bandpass', 1100, 0.6, 1.1, 0.28);
        burst('highpass', 3000, 0.5, 0.35, 0.18, 0.02);
        thump(110, 0.25, 0.1);
        break;
    }
    // A breath in time with the stride when working hard.
    if (speed > 4 && t - this.lastBreath > 0.33) {
      this.lastBreath = t;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 650;
      f.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.1 * clamp01((speed - 4) / 6), t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      src.connect(f).connect(g).connect(this.sfx);
      src.start(t, rnd(0, 1.5));
      src.stop(t + 0.35);
    }
  }
}
