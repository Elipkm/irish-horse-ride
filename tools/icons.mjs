// Draws the app icon and the iPad launch image from code (no outside artwork) and writes them to public/.
// Run with: npm run icons
import sharp from 'sharp';

/** Misty green hills under a pale sun, with a horseshoe. `w` x `h` pixels; `mark` scales the horseshoe. */
function scene(w, h, mark, rounded) {
  const cx = w / 2;
  const cy = h * 0.46;
  const r = Math.min(w, h) * 0.2 * mark;
  const stroke = r * 0.34;
  // Horseshoe: an arc open at the bottom, with nail dots along it.
  const a0 = (-55 * Math.PI) / 180 + Math.PI; // left end (below the centre line)
  const pt = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const [sx, sy] = pt(125);
  const [ex, ey] = pt(55);
  const nails = [160, 195, 230, 270, 310, 345, 20].map((d) => pt(d));
  void a0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b9c9c2"/><stop offset="0.62" stop-color="#e6ebdd"/><stop offset="1" stop-color="#dfe8d2"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff8dc" stop-opacity="1"/><stop offset="1" stop-color="#fff8dc" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d8f78"/><stop offset="1" stop-color="#8fae94"/></linearGradient>
    <linearGradient id="mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f7a4a"/><stop offset="1" stop-color="#2f5f3b"/></linearGradient>
    <linearGradient id="near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a5a33"/><stop offset="1" stop-color="#1b3d25"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)" ${rounded ? '' : ''}/>
  <circle cx="${w * 0.7}" cy="${h * 0.36}" r="${Math.min(w, h) * 0.42}" fill="url(#sun)"/>
  <path d="M0 ${h * 0.66} C ${w * 0.2} ${h * 0.5}, ${w * 0.35} ${h * 0.58}, ${w * 0.55} ${h * 0.52} S ${w * 0.9} ${h * 0.48}, ${w} ${h * 0.58} V ${h} H0 Z" fill="url(#far)"/>
  <path d="M0 ${h * 0.76} C ${w * 0.25} ${h * 0.62}, ${w * 0.5} ${h * 0.74}, ${w * 0.75} ${h * 0.66} S ${w * 0.95} ${h * 0.68}, ${w} ${h * 0.7} V ${h} H0 Z" fill="url(#mid)"/>
  <path d="M0 ${h * 0.88} C ${w * 0.3} ${h * 0.78}, ${w * 0.6} ${h * 0.9}, ${w} ${h * 0.8} V ${h} H0 Z" fill="url(#near)"/>
  <path d="M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}" fill="none" stroke="#2b2622" stroke-width="${stroke}" stroke-linecap="round"/>
  <path d="M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}" fill="none" stroke="#c9ccd0" stroke-width="${stroke * 0.5}" stroke-linecap="round"/>
  ${nails.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${stroke * 0.13}" fill="#2b2622"/>`).join('\n  ')}
</svg>`;
}

const png = (svg, file, size) => sharp(Buffer.from(svg)).resize(size[0], size[1]).png().toFile(`public/${file}`);

await png(scene(1024, 1024, 1, false), 'icon-512.png', [512, 512]);
await png(scene(1024, 1024, 1, false), 'icon-180.png', [180, 180]);
// iPad launch images (10th generation, 820 x 1180 points at 2x), shown while the home-screen app starts.
await png(scene(2360, 1640, 1.5, false), 'splash-landscape.png', [2360, 1640]);
await png(scene(1640, 2360, 1.5, false), 'splash-portrait.png', [1640, 2360]);
console.log('icons written to public/');
