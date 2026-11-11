import * as THREE from 'three/webgpu';
import { mulberry32 } from './noise';

export type FoliageKind = 'oak' | 'birch' | 'pine' | 'gorse';

const SIZE = 512;

/**
 * Paints a spray of leaves (or needles) on a transparent square: the picture every leaf card of a
 * tree shows. Drawn in code so the game needs no leaf image files; seen from riding distance a
 * card reads as a clump of foliage rather than as individual leaves.
 */
export function createFoliageTexture(kind: FoliageKind): THREE.DataTexture {
  const rand = mulberry32({ oak: 11, birch: 23, pine: 37, gorse: 53 }[kind]);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const mid = SIZE / 2;
  /** Random point in a disc, denser towards the middle so the card's edge is ragged. */
  const spot = (radius: number) => {
    const r = radius * Math.pow(rand(), 0.7);
    const a = rand() * Math.PI * 2;
    return [mid + r * Math.cos(a), mid + r * Math.sin(a), a] as const;
  };
  const hsl = (h: number, s: number, l: number) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;

  if (kind === 'oak' || kind === 'birch') {
    const oak = kind === 'oak';
    // A few twigs first, then leaves from dark (inside the clump) to light (catching the sky).
    ctx.strokeStyle = oak ? '#2a2318' : '#3a342c';
    ctx.lineWidth = oak ? 3 : 2;
    for (let i = 0; i < (oak ? 12 : 16); i++) {
      const [x, y] = spot(mid * 0.8);
      ctx.beginPath();
      ctx.moveTo(mid + (rand() - 0.5) * 60, mid + (rand() - 0.5) * 60);
      ctx.quadraticCurveTo((mid + x) / 2 + (rand() - 0.5) * 80, (mid + y) / 2 + (rand() - 0.5) * 80, x, y);
      ctx.stroke();
    }
    const count = oak ? 1000 : 1500;
    for (let i = 0; i < count; i++) {
      const light = i / count;
      const [x, y, a] = spot(mid * (oak ? 0.93 : 0.9));
      const len = (oak ? 12 : 7) * (0.7 + 0.6 * rand());
      const wide = len * (oak ? 0.5 : 0.62);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + (rand() - 0.5) * 2.4);
      ctx.fillStyle = oak
        ? hsl(84 + 18 * rand(), 34 + 12 * rand(), 9 + 13 * light + 4 * rand())
        : hsl(76 + 16 * rand(), 40 + 12 * rand(), 13 + 15 * light + 5 * rand());
      ctx.beginPath();
      if (oak) {
        // Lobed outline: a long ellipse with two rounder ones across it.
        ctx.ellipse(0, 0, len, wide * 0.6, 0, 0, Math.PI * 2);
        ctx.ellipse(-len * 0.3, 0, len * 0.28, wide, 0, 0, Math.PI * 2);
        ctx.ellipse(len * 0.3, 0, len * 0.26, wide * 0.9, 0, 0, Math.PI * 2);
      } else {
        // Small pointed leaf.
        ctx.moveTo(-len, 0);
        ctx.quadraticCurveTo(-len * 0.2, -wide, len, 0);
        ctx.quadraticCurveTo(-len * 0.2, wide, -len, 0);
      }
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-len * 0.9, 0);
      ctx.lineTo(len * 0.9, 0);
      ctx.stroke();
      ctx.restore();
    }
  } else if (kind === 'pine') {
    // Tufts of needles fanning out from short shoots.
    ctx.lineCap = 'round';
    for (let i = 0; i < 300; i++) {
      const light = i / 300;
      const [x, y, a] = spot(mid * 0.86);
      const fan = a + (rand() - 0.5) * 1.5;
      for (let n = 0; n < 30; n++) {
        const na = fan + (rand() - 0.5) * 2.6;
        const len = 13 + 13 * rand();
        ctx.strokeStyle = hsl(120 + 30 * rand(), 22 + 12 * rand(), 7 + 12 * light + 5 * rand());
        ctx.lineWidth = 1.5 + rand();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(na) * len, y + Math.sin(na) * len);
        ctx.stroke();
      }
    }
  } else {
    // Gorse: a dense mass of dark spines, dotted with yellow flowers.
    ctx.lineCap = 'round';
    for (let i = 0; i < 6000; i++) {
      const light = i / 6000;
      const [x, y] = spot(mid * 0.95);
      const a = rand() * Math.PI * 2;
      const len = 6 + 9 * rand();
      ctx.strokeStyle = hsl(92 + 26 * rand(), 28 + 14 * rand(), 7 + 12 * light + 4 * rand());
      ctx.lineWidth = 2 + rand();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    for (let i = 0; i < 420; i++) {
      const [x, y] = spot(mid * 0.9);
      ctx.fillStyle = hsl(47 + 8 * rand(), 85, 42 + 12 * rand());
      ctx.beginPath();
      ctx.arc(x, y, 2 + 2 * rand(), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Give the see-through pixels the foliage's average colour: when the picture is shrunk for
  // distant views, edges then blend towards green rather than towards black.
  const image = ctx.getImageData(0, 0, SIZE, SIZE);
  const px = image.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 200) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
      n++;
    }
  }
  n = Math.max(1, n);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) {
      px[i] = r / n;
      px[i + 1] = g / n;
      px[i + 2] = b / n;
      px[i + 3] = 0;
    }
  }

  const texture = new THREE.DataTexture(new Uint8Array(px.buffer), SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
