// Asset pipeline: `npm run assets`
// 1. Downloads the raw CC0 files listed below into assets-source/ (skipped when already present).
// 2. Writes optimised, game-ready copies into public/.
// Raw files are not committed (see .gitignore); the optimised output in public/ is.
// Every entry here must also be listed in ASSETS.md.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const RAW = 'assets-source/polyhaven';
const TEX_OUT = 'public/textures';
const ENV_OUT = 'public/env';
const GROUND_SIZE = 1024; // plan §3: 1K textures by default
const BARK_SIZE = 512; // trunks are narrow on screen

/** Ground layers: game name -> Poly Haven asset id. */
const LAYERS = {
  grass: 'forrest_ground_01',
  moss: 'rocky_terrain_02',
  mud: 'brown_mud_02',
  gravel: 'gravel_ground_01',
  rock: 'mossy_rock',
};
/** Tree bark: game name -> Poly Haven asset id. */
const BARK = {
  bark_oak: 'bark_brown_02',
  bark_pine: 'pine_bark',
};
const HDRI = 'kloofendal_28d_misty_puresky';

const texUrl = (id, map) => `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}_${map}_1k.jpg`;
const hdriUrl = (id) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${id}_1k.hdr`;

async function download(url, file) {
  if (existsSync(file)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${file}`);
}

const kb = async (file) => `${Math.round((await stat(file)).size / 1024)} kB`;

async function buildLayer(name, id, SIZE, colourOnly = false) {
  const raw = (map) => `${RAW}/${id}_${map}_1k.jpg`;
  for (const map of ['diff', 'nor_gl', 'arm']) await download(texUrl(id, map), raw(map));

  const px = SIZE * SIZE;
  const read = (map) => sharp(raw(map)).resize(SIZE, SIZE).removeAlpha().raw().toBuffer();
  const [diff, nor, arm] = await Promise.all([read('diff'), read('nor_gl'), read('arm')]);

  // <name>_col: albedo with the texture's own ambient occlusion baked in (saves a texture slot).
  // AO is softened (60%) so crevices darken without crushing the colour.
  const col = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) {
    const ao = 0.4 + 0.6 * (arm[i * 3] / 255);
    col[i * 3] = Math.round(diff[i * 3] * ao);
    col[i * 3 + 1] = Math.round(diff[i * 3 + 1] * ao);
    col[i * 3 + 2] = Math.round(diff[i * 3 + 2] * ao);
  }
  const colFile = `${TEX_OUT}/${name}_col.webp`;
  await sharp(col, { raw: { width: SIZE, height: SIZE, channels: 3 } }).webp({ quality: 82 }).toFile(colFile);

  if (colourOnly) {
    console.log(`${name.padEnd(9)} ${id.padEnd(20)} col ${await kb(colFile)}`);
    return;
  }

  // <name>_nr: R,G = tangent-space normal x,y (OpenGL convention), B = roughness.
  // JPEG with 4:4:4 chroma so the three data channels do not bleed into each other.
  const nr = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) {
    nr[i * 3] = nor[i * 3];
    nr[i * 3 + 1] = nor[i * 3 + 1];
    nr[i * 3 + 2] = arm[i * 3 + 1];
  }
  const nrFile = `${TEX_OUT}/${name}_nr.jpg`;
  await sharp(nr, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(nrFile);

  console.log(`${name.padEnd(9)} ${id.padEnd(20)} col ${await kb(colFile)}, nr ${await kb(nrFile)}`);
}

await mkdir(RAW, { recursive: true });
await mkdir(TEX_OUT, { recursive: true });
await mkdir(ENV_OUT, { recursive: true });

for (const [name, id] of Object.entries(LAYERS)) await buildLayer(name, id, GROUND_SIZE);
for (const [name, id] of Object.entries(BARK)) await buildLayer(name, id, BARK_SIZE, true);

const hdrRaw = `${RAW}/${HDRI}_1k.hdr`;
await download(hdriUrl(HDRI), hdrRaw);
await copyFile(hdrRaw, `${ENV_OUT}/sky.hdr`);
console.log(`sky     ${HDRI} ${await kb(`${ENV_OUT}/sky.hdr`)}`);
