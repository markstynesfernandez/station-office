// scene/textures.js — every texture in the office is drawn here with the 2D canvas API at start-up (Redesign R1).
// No image files. Wood planks and atrium tiles are drawn in light greys and tinted per theme by the material colour.
// The decal atlas holds the Design room's mood board, a whiteboard and the framed pictures: abstract compositions made
// from a seeded random generator (circles, bands, blocks, arcs). They are not copies or imitations of any artwork, and
// there is no text anywhere (book spines, notes and boards carry only shapes and lines).
import * as THREE from 'three';

// small seeded generator (mulberry32) so the office looks the same on every load
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function tex(c, { repeat = false, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
}

// wood planks along u: 8 rows of planks of random length, soft grain, thin seams
export function woodTexture() {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), r = rng(7);
  const rows = 8, h = S / rows;
  for (let row = 0; row < rows; row++) {
    let x = -Math.floor(r() * 300);
    while (x < S) {
      const len = 180 + Math.floor(r() * 260), l = 214 + Math.floor(r() * 30);
      g.fillStyle = 'rgb(' + l + ',' + (l - 3) + ',' + (l - 8) + ')'; g.fillRect(x, row * h, len, h);
      g.globalAlpha = 0.16; g.strokeStyle = '#8a7a66'; g.lineWidth = 1;
      for (let k = 0; k < 5; k++) { const y0 = row * h + 6 + r() * (h - 12), a = 1 + r() * 2.5, f = 0.01 + r() * 0.02; g.beginPath(); for (let px = x; px <= x + len; px += 8) g.lineTo(px, y0 + Math.sin(px * f) * a); g.stroke(); }
      g.globalAlpha = 1; g.fillStyle = 'rgba(70,58,46,0.55)'; g.fillRect(x, row * h, 2, h);
      x += len;
    }
    g.fillStyle = 'rgba(70,58,46,0.6)'; g.fillRect(0, row * h, S, 2);
  }
  // wrap the seams across the edges (repeat)
  return tex(c, { repeat: true });
}

// atrium floor (R2): polished concrete, not the R1 mottled stone. A smooth, faintly clouded pour with a little fine
// aggregate and thin saw-cut joints (two panels per tile of the texture); tinted per theme by the material colour.
export function tileTexture() {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), r = rng(11), n = 2, t = S / n;
  g.fillStyle = 'rgb(238,237,234)'; g.fillRect(0, 0, S, S);
  // broad, very soft clouding (drawn wrapped so the texture tiles without seams)
  for (let k = 0; k < 26; k++) {
    const x = r() * S, y = r() * S, rad = 60 + r() * 150, dark = r() < 0.5, a = 0.025 + r() * 0.03;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      gr.addColorStop(0, dark ? 'rgba(90,86,80,' + a + ')' : 'rgba(255,255,255,' + a + ')'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
  // fine aggregate: tiny specks, barely there
  for (let k = 0; k < 2600; k++) { g.fillStyle = r() < 0.5 ? 'rgba(70,66,60,0.12)' : 'rgba(255,255,255,0.18)'; g.fillRect(r() * S, r() * S, 1 + r(), 1 + r()); }
  // saw-cut joints
  g.fillStyle = 'rgba(96,92,86,0.38)'; for (let k = 0; k < n; k++) { g.fillRect(k * t, 0, 1.5, S); g.fillRect(0, k * t, S, 1.5); }
  return tex(c, { repeat: true });
}

// glow atlas: left half a soft round pool, right half a wall wash (bright at the top edge, fading down, soft sides)
export function glowTexture() {
  const c = canvas(256, 128), g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64); rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.4, 'rgba(255,255,255,0.45)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  const img = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = Math.pow(1 - y / 127, 2.2), e = Math.min(1, Math.min(x, 127 - x) / 22), a = v * e * e;
    const i = (y * 128 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 128, 0);
  const t = tex(c, { srgb: false }); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; return t;
}
export const GLOW_UV = { pool: [0, 0, 0.5, 1], wash: [0.5, 0, 1, 1] };

// decal atlas (1024x1024): regions in pixels; uv() turns one into [u0, v0, u1, v1]
export const ATLAS = { S: 1024, board: [0, 0, 640, 384], white: [0, 384, 640, 704], art: [[640, 0, 832, 256], [832, 0, 1024, 256], [640, 256, 832, 512], [832, 256, 1024, 512], [640, 512, 832, 768], [832, 512, 1024, 768]] };
export const atlasUV = (reg) => [reg[0] / ATLAS.S, 1 - reg[3] / ATLAS.S, reg[2] / ATLAS.S, 1 - reg[1] / ATLAS.S];
const ART_PALETTES = [['#e9e1d3', '#c2673f', '#2f4858', '#e3b04b', '#8aa39b'], ['#f1ece4', '#5b7065', '#d9a441', '#b5533c', '#2b2d42'], ['#efe9e1', '#7a8fa6', '#d98e73', '#3e4a59', '#c9b37e'], ['#ece6dc', '#9c6644', '#6b9080', '#e0b25c', '#253237']];

function drawArt(g, x, y, w, h, style, r) {
  const pal = ART_PALETTES[Math.floor(r() * ART_PALETTES.length)], pick = () => pal[1 + Math.floor(r() * (pal.length - 1))];
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = pal[0]; g.fillRect(x, y, w, h);
  if (style === 0) {        // overlapping circles and half-discs
    for (let k = 0; k < 5; k++) { g.fillStyle = pick(); g.globalAlpha = 0.85; g.beginPath(); const cx = x + w * (0.2 + r() * 0.6), cy = y + h * (0.2 + r() * 0.6), rr = w * (0.12 + r() * 0.22); if (r() < 0.5) g.arc(cx, cy, rr, 0, Math.PI * 2); else g.arc(cx, cy, rr, Math.PI * (r() < 0.5 ? 0 : 1), Math.PI * (r() < 0.5 ? 1 : 2)); g.fill(); }
  } else if (style === 1) { // horizon bands and a disc
    let yy = y + h * 0.45; g.fillStyle = pick(); g.beginPath(); g.arc(x + w * (0.3 + r() * 0.4), y + h * 0.36, w * 0.18, 0, Math.PI * 2); g.fill();
    while (yy < y + h) { const bh = h * (0.08 + r() * 0.16); g.fillStyle = pick(); g.fillRect(x, yy, w, bh); yy += bh; }
  } else if (style === 2) { // blocks on a grid
    const n = 3 + Math.floor(r() * 2), cw = w / n, ch = h / (n + 1);
    for (let i = 0; i < n; i++) for (let j = 0; j < n + 1; j++) if (r() < 0.55) { g.fillStyle = pick(); g.fillRect(x + i * cw + 3, y + j * ch + 3, cw * (r() < 0.3 ? 2 : 1) - 6, ch - 6); }
  } else {                  // arcs and lines
    g.lineWidth = 6 + r() * 8; g.lineCap = 'round';
    for (let k = 0; k < 6; k++) { g.strokeStyle = pick(); g.beginPath(); g.arc(x + w * r(), y + h * r(), w * (0.2 + r() * 0.5), r() * 6, r() * 6 + 1.5 + r() * 2); g.stroke(); }
  }
  g.globalAlpha = 1; g.restore();
}
function scribble(g, x, y, w, r, color, lw = 3) {   // a wavy line standing in for handwriting (no letters)
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y);
  for (let px = 0; px < w; px += 6) g.lineTo(x + px, y + Math.sin(px * 0.35 + r() * 2) * 3 + (r() - 0.5) * 2);
  g.stroke();
}

export function atlasTexture() {
  const c = canvas(ATLAS.S, ATLAS.S), g = c.getContext('2d'), r = rng(23);
  g.fillStyle = '#ddd'; g.fillRect(0, 0, ATLAS.S, ATLAS.S);
  // mood board: cork, pinned swatch strips, sketch cards, photo-like gradient cards, pins
  { const [x0, y0, x1, y1] = ATLAS.board, w = x1 - x0, h = y1 - y0;
    g.fillStyle = '#c9a77c'; g.fillRect(x0, y0, w, h);
    g.globalAlpha = 0.12; for (let k = 0; k < 1400; k++) { g.fillStyle = r() < 0.5 ? '#6b4f2e' : '#f3dfc0'; g.fillRect(x0 + r() * w, y0 + r() * h, 2, 2); } g.globalAlpha = 1;
    const cards = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 6; col++) if (r() < 0.86) cards.push([x0 + 22 + col * 102 + r() * 14, y0 + 20 + row * 122 + r() * 12]);
    for (const [cx, cy] of cards) {
      const kind = Math.floor(r() * 4), cw = 70 + r() * 18, ch = 84 + r() * 14;
      g.save(); g.translate(cx + cw / 2, cy + ch / 2); g.rotate((r() - 0.5) * 0.12); g.translate(-cw / 2, -ch / 2);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(3, 4, cw, ch);
      g.fillStyle = '#f7f4ee'; g.fillRect(0, 0, cw, ch);
      if (kind === 0) { const pal = ART_PALETTES[Math.floor(r() * 4)]; for (let i = 0; i < 4; i++) { g.fillStyle = pal[1 + i]; g.fillRect(6, 6 + i * (ch - 12) / 4, cw - 12, (ch - 12) / 4 - 3); } }
      else if (kind === 1) { drawArt(g, 6, 6, cw - 12, ch - 26, Math.floor(r() * 4), r); }
      else if (kind === 2) { g.strokeStyle = '#555'; g.lineWidth = 2; for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(cw / 2 + (r() - 0.5) * 20, ch / 2 + (r() - 0.5) * 20, 10 + r() * 22, 8 + r() * 18, r() * 3, 0, 6.3); g.stroke(); } }
      else { const gr = g.createLinearGradient(0, 0, cw, ch); gr.addColorStop(0, ART_PALETTES[Math.floor(r() * 4)][1]); gr.addColorStop(1, ART_PALETTES[Math.floor(r() * 4)][2]); g.fillStyle = gr; g.fillRect(6, 6, cw - 12, ch - 28); }
      g.restore();
      g.fillStyle = ['#d64545', '#3d7dd8', '#e8b53e', '#3fa66b'][Math.floor(r() * 4)]; g.beginPath(); g.arc(cx + 34 + r() * 10, cy + 6, 5, 0, 7); g.fill();
    }
  }
  // whiteboard: boxes joined by lines, sticky notes, scribbles (no text)
  { const [x0, y0, x1, y1] = ATLAS.white, w = x1 - x0, h = y1 - y0;
    g.fillStyle = '#f8f8f6'; g.fillRect(x0, y0, w, h);
    const boxes = [[70, 60], [250, 40], [250, 170], [440, 100]];
    g.strokeStyle = '#3d5a80'; g.lineWidth = 3;
    for (const [bx, by] of boxes) { g.strokeRect(x0 + bx, y0 + by, 120, 70); scribble(g, x0 + bx + 14, y0 + by + 26, 90, r, '#3d5a80', 2.5); scribble(g, x0 + bx + 14, y0 + by + 46, 60, r, '#3d5a80', 2.5); }
    g.strokeStyle = '#c0392b'; g.beginPath(); g.moveTo(x0 + 190, y0 + 95); g.lineTo(x0 + 250, y0 + 75); g.moveTo(x0 + 190, y0 + 95); g.lineTo(x0 + 250, y0 + 205); g.moveTo(x0 + 370, y0 + 75); g.lineTo(x0 + 440, y0 + 135); g.moveTo(x0 + 370, y0 + 205); g.lineTo(x0 + 440, y0 + 135); g.stroke();
    for (let k = 0; k < 7; k++) { const sx = x0 + 40 + k * 82, sy = y0 + 250 + (k % 2) * 14; g.fillStyle = ['#f6d55c', '#f4a7b9', '#9ed9a3', '#9cc9f0'][k % 4]; g.fillRect(sx, sy, 58, 52); scribble(g, sx + 8, sy + 20, 40, r, '#555', 2); scribble(g, sx + 8, sy + 34, 30, r, '#555', 2); }
  }
  // framed pictures: one composition per region, a style each
  ATLAS.art.forEach(([x0, y0, x1, y1], i) => drawArt(g, x0, y0, x1 - x0, y1 - y0, i % 4, r));
  return tex(c);
}
