// scene/looks.js — the people's looks (R2), pure so the tests can check them. Skin tones, hair colours and trousers are
// picked per agent from its id. The shirt is the agent's colour unless that colour lies in the skin-tone range or is
// too close to another agent's shirt (E5 item 0c): then the next free colour from SHIRTS, a set of non-skin colours, is
// used. Only the shirt changes; the desk, monitor and label keep the agent's own colour.
export const SKIN = ['#f3d5bf', '#e8bf9c', '#d29e78', '#b07a55', '#8c5a3c', '#6a432d'];
export const HAIR = ['#2a2420', '#4b3426', '#6e4a2f', '#a57a4c', '#d3b07c', '#1d1d21', '#8f8a84', '#7c3b22'];
export const TROUSERS = ['#3a3f4b', '#4c4f57', '#2e3440', '#5a5248', '#3f4a42', '#6b6f78'];
// shirt colours well away from every skin tone (blues, greens, purples, a red, a teal, a mustard); checked by the test
export const SHIRTS = ['#4f7cc4', '#3f9a6b', '#8a5cc0', '#c4454f', '#2f9aa6', '#5b6ee0', '#7aa83a', '#b04f9a', '#c9a227', '#3d5a80'];

export const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const rgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// hue (degrees), saturation and value (0..1)
export function hsv(hex) {
  const c = rgb(hex); if (!c) return null;
  const [r, g, b] = c.map((x) => x / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}
// skin-tone range: the orange-to-brown hues (0–50°) at low to middling saturation. Every SKIN entry lies inside it
// (hue 21–26°, saturation 0.21–0.58); a saturated yellow, a pink or any blue or green lies outside.
export function isSkinTone(hex) {
  const c = hsv(hex); if (!c) return false;
  return c.h <= 50 && c.s >= 0.1 && c.s <= 0.65 && c.v >= 0.2;
}
// distance between two colours, a simple weighted RGB measure (0..~765)
export function colourDistance(a, b) {
  const x = rgb(a), y = rgb(b); if (!x || !y) return Infinity;
  const rm = (x[0] + y[0]) / 2, dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
export const MIN_SHIRT_DISTANCE = 90;
const skinClear = (hex) => !isSkinTone(hex) && SKIN.every((s) => colourDistance(hex, s) >= MIN_SHIRT_DISTANCE);

// agents in desk order: [{ id, color }] -> { id: '#rrggbb' }, every shirt off the skin range and distinct
export function shirtColours(agents) {
  const used = [], out = {};
  const free = (hex) => skinClear(hex) && used.every((u) => colourDistance(hex, u) >= MIN_SHIRT_DISTANCE);
  for (const a of agents) {
    const own = rgb(a.color) ? '#' + String(a.color).replace('#', '').toLowerCase() : null;
    let pick = own && free(own) ? own : null;
    if (!pick) { const start = hash(String(a.id) + ':shirt') % SHIRTS.length; for (let k = 0; k < SHIRTS.length && !pick; k++) { const c = SHIRTS[(start + k) % SHIRTS.length]; if (free(c)) pick = c; } }
    if (!pick) pick = SHIRTS[hash(String(a.id)) % SHIRTS.length];   // more agents than free colours: reuse, never a skin tone
    used.push(pick); out[a.id] = pick;
  }
  return out;
}
