import * as THREE from 'three/webgpu';
import { mulberry32 } from './noise';

const SIZE = 512;
/** Courses of stone from top to bottom of the picture. */
const ROWS = 10;

/**
 * Paints a square of rubble masonry: rows of rough stones with dark joints, a little lichen and
 * moss. Returns the colour picture and a matching bump (normal) map. It repeats without a seam,
 * and is what every wall in the valley is built of, from the field walls to the abbey.
 */
export function createMasonryTextures(): { colour: THREE.DataTexture; normal: THREE.DataTexture } {
  const rand = mulberry32(1169);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#1d1b18';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const rowHeight = SIZE / ROWS;
  const stone = (x: number, y: number, w: number, h: number) => {
    const light = 30 + 22 * rand();
    ctx.fillStyle = `hsl(${(28 + 30 * rand()).toFixed(0)} ${(4 + 9 * rand()).toFixed(0)}% ${light.toFixed(0)}%)`;
    const r = 5 + 6 * rand();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
    // Weathering: a paler patch off-centre.
    ctx.fillStyle = `hsl(40 8% ${(light + 9).toFixed(0)}% / 0.5)`;
    ctx.beginPath();
    ctx.ellipse(x + w * (0.3 + 0.4 * rand()), y + h * (0.3 + 0.3 * rand()), w * 0.3, h * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  for (let row = 0; row < ROWS; row++) {
    const y = row * rowHeight;
    let x = -rand() * 80;
    const start = x;
    while (x < SIZE + start) {
      let w = 44 + 70 * rand();
      if (SIZE + start - (x + w) < 34) w = SIZE + start - x; // no slivers at the end of a row
      const inset = 2 + 2 * rand();
      const top = y + inset + 3 * rand();
      const h = rowHeight - 2 * inset - 2 * rand();
      // Drawn again one picture-width along, so stones that cross the edge match up.
      stone(x + inset, top, w - 2 * inset, h);
      stone(x + inset + SIZE, top, w - 2 * inset, h);
      x += w;
    }
  }
  const blot = (count: number, colour: () => string, size: number) => {
    for (let i = 0; i < count; i++) {
      const x = rand() * SIZE;
      const y = rand() * SIZE;
      ctx.fillStyle = colour();
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        ctx.arc(x + (rand() - 0.5) * size * 2, y + (rand() - 0.5) * size * 2, size * (0.4 + rand()), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  blot(60, () => `hsl(${(55 + 20 * rand()).toFixed(0)} 14% 62% / 0.35)`, 5); // pale lichen
  blot(14, () => `hsl(38 55% 45% / 0.35)`, 3); // orange lichen
  blot(26, () => `hsl(95 30% 22% / 0.4)`, 7); // moss

  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const colourData = new Uint8Array(px.buffer.slice(0));

  // Bump map from brightness: joints are dark, so they read as recessed.
  const height = new Float32Array(SIZE * SIZE);
  for (let k = 0; k < SIZE * SIZE; k++) height[k] = (px[k * 4] + px[k * 4 + 1] + px[k * 4 + 2]) / 765;
  const wrap = (v: number) => (v + SIZE) % SIZE;
  const soft = new Float32Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += height[wrap(j + dj) * SIZE + wrap(i + di)];
      soft[j * SIZE + i] = Math.min(0.42, sum / 9); // stones are flat-faced: only the joints have depth
    }
  }
  const normalData = new Uint8Array(SIZE * SIZE * 4);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const dx = (soft[j * SIZE + wrap(i + 1)] - soft[j * SIZE + wrap(i - 1)]) * 6;
      const dy = (soft[wrap(j + 1) * SIZE + i] - soft[wrap(j - 1) * SIZE + i]) * 6;
      const k = (j * SIZE + i) * 4;
      normalData[k] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - dx * 0.5)));
      normalData[k + 1] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + dy * 0.5))); // picture rows run downwards
      normalData[k + 2] = 255;
      normalData[k + 3] = 255;
    }
  }

  const make = (data: Uint8Array<ArrayBuffer>, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = colorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { colour: make(colourData, THREE.SRGBColorSpace), normal: make(normalData, THREE.NoColorSpace) };
}
