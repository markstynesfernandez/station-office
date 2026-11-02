// lib/region-edit.mjs — the owner's region edits of a raw file (owner decision, 18/10/2026; DECISIONS.md "E6 step c: owner fix tools,
// post-fix approval rule"). Deterministic, $0, no model; applied through the edit-set step (prop-edit.mjs op "region", edits.json record).
// A region is selected exactly as the station's build check finds it, then one action is applied:
//   select  { kind: "enclosed", box }    an enclosed background-like region (digital-build.mjs enclosedBackgroundRegions), the one at box
//           { kind: "near-white", box }  a near-white fill (the palette rule's test, nearWhiteFills), the one at box; with spread: true
//                                         (the default for recolour) also the connected light, low-colour pixels around it down to alpha 1
//                                         (the soft edge of a painted shape), so no white rim is left
//   action  "fill"      every selected pixel (and, within featherPx, any lighter neighbour) takes the sampled colour; alpha unchanged
//           "recolour"  every selected pixel moves to the sampled colour, keeping its own light and shade (each channel = sample +
//                       the pixel's luminance - the region's mean luminance); alpha unchanged, so the shape stays the same
//           "clear"     every selected pixel is made fully transparent (alpha 0, colour 0)
//   sample  { around: true, ringPx }     the median colour of the opaque pixels within ringPx outside the region (e.g. the lid around a
//                                         highlight)
//           { file, box }                 the median colour of the opaque pixels (alpha >= 200) inside box of another raw file of the set
//                                         (e.g. the steam of the cider mug); its sha256 is recorded
// Selection is always made on the file as it was before the edit, for every region first, then the actions run. Pure on RGBA buffers.
import { enclosedBackgroundRegions, ENCLOSED_DEFAULTS, PALETTE_DEFAULTS } from './digital-build.mjs';

const lumOf = (d, i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
const chromaOf = (d, i) => Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const med = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.floor(s.length / 2)] : null; };
const nb4 = (i, W, n) => { const x = i % W, o = []; if (x > 0) o.push(i - 1); if (x < W - 1) o.push(i + 1); if (i >= W) o.push(i - W); if (i < n - W) o.push(i + W); return o; };
const sameBox = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && a.every((v, k) => v === b[k]);
export const SPREAD = { minLum: 150, maxChroma: 40 };

// the near-white fills with their members (the same test as digital-build.mjs nearWhiteFills)
function nearWhiteWithMembers(data, W, H, palette) {
  const o = { ...PALETTE_DEFAULTS, ...palette }, n = W * H, lab = new Uint8Array(n), out = [];
  const nw = (i) => data[i * 4 + 3] >= 128 && lumOf(data, i) >= o.nearWhiteMinLum && chromaOf(data, i) <= o.maxChroma;
  for (let s = 0; s < n; s++) {
    if (lab[s] || !nw(s)) continue;
    const members = [s]; lab[s] = 1; let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let k = 0; k < members.length; k++) { const i = members[k], x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const j of nb4(i, W, n)) if (!lab[j] && nw(j)) { lab[j] = 1; members.push(j); } }
    const px = members.length, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (px >= o.minRegionPx && px / Math.max(bw, bh) >= o.minWidthPx) out.push({ members, px, box: [x0, y0, bw, bh] });
  }
  return out;
}

// -> { members: Int32Array-like array, px, box } or { problem }
export function selectRegion(data, W, H, select, { enclosed = {}, palette = {}, spread } = {}) {
  if (!select || !Array.isArray(select.box) || select.box.length !== 4) return { problem: 'select needs a box [x, y, w, h]' };
  let found;
  if (select.kind === 'enclosed') found = enclosedBackgroundRegions(Buffer.from(data), W, H, { ...ENCLOSED_DEFAULTS, ...enclosed }).find((r) => sameBox(r.box, select.box));
  else if (select.kind === 'near-white') found = nearWhiteWithMembers(data, W, H, palette).find((r) => sameBox(r.box, select.box));
  else return { problem: 'select.kind must be "enclosed" or "near-white"' };
  if (!found) return { problem: 'no ' + select.kind + ' region at box ' + select.box.join(',') + ' (the build check finds it there on this file)' };
  let members = found.members;
  if (spread) {
    const n = W * H, inR = new Uint8Array(n), s = { ...SPREAD, ...(spread === true ? {} : spread) }, out = [...members];
    for (const i of members) inR[i] = 1;
    for (let k = 0; k < out.length; k++) for (const j of nb4(out[k], W, n)) if (!inR[j] && data[j * 4 + 3] > 0 && lumOf(data, j) >= s.minLum && chromaOf(data, j) <= s.maxChroma) { inR[j] = 1; out.push(j); }
    members = out;
  }
  return { members, px: found.px, selectedPx: members.length, box: found.box };
}

// the median colour of opaque pixels: around a region (ringPx outside it) or inside a box of another image
export function sampleAround(data, W, H, members, { ringPx = 6, minAlpha = 250 } = {}) {
  const n = W * H, d = new Int16Array(n).fill(-1), q = [...members], c = [[], [], []];
  for (const i of members) d[i] = 0;
  for (let k = 0; k < q.length; k++) { const i = q[k]; if (d[i] >= ringPx) continue; for (const j of nb4(i, W, n)) if (d[j] < 0) { d[j] = d[i] + 1; q.push(j); if (data[j * 4 + 3] >= minAlpha) for (let ch = 0; ch < 3; ch++) c[ch].push(data[j * 4 + ch]); } }
  return c[0].length ? { rgb: c.map(med), px: c[0].length } : null;
}
export function sampleBox(data, W, H, box, { minAlpha = 200 } = {}) {
  const [x0, y0, bw, bh] = box, c = [[], [], []];
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + bh); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + bw); x++) { const i = y * W + x; if (data[i * 4 + 3] >= minAlpha) for (let ch = 0; ch < 3; ch++) c[ch].push(data[i * 4 + ch]); }
  return c[0].length ? { rgb: c.map(med), px: c[0].length } : null;
}

// an optional change to a sampled colour (owner amendment, 18/10/2026: a painted highlight keeps its lightness):
//   { lighten: f } / { darken: f }        blend f (0..1) of the way to white / to black
//   { lighten: "max-under-near-white" }   the lightest blend towards white that still passes the palette rule's near-white test (a colour is
//                                          near-white when its luminance >= nearWhiteMinLum AND its channels differ by <= maxChroma): the
//                                          channel spread stays just above maxChroma; a colour that is already too grey is kept just
//                                          under nearWhiteMinLum instead
// -> { rgb, adjust, blend } or { problem }
const lum3 = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], chroma3 = (c) => Math.max(...c) - Math.min(...c);
export function adjustColour(rgb, adjust, palette = {}) {
  if (!adjust) return { rgb, adjust: null, blend: 0 };
  const o = { ...PALETTE_DEFAULTS, ...palette }, toward = (c, t, end) => c.map((v) => clamp(v + t * (end - v)));
  const isNearWhite = (c) => lum3(c) >= o.nearWhiteMinLum && chroma3(c) <= o.maxChroma;
  if (adjust.darken != null) { const t = Number(adjust.darken); if (!(t >= 0 && t <= 1)) return { problem: 'darken must be between 0 and 1' }; return { rgb: toward(rgb, t, 0), adjust, blend: t }; }
  if (adjust.lighten === 'max-under-near-white') {
    if (isNearWhite(rgb)) return { problem: 'the sampled colour ' + rgb.join(',') + ' is already near-white: nothing lighter passes the rule' };
    let best = rgb, bt = 0;
    for (let k = 1; k <= 1000; k++) { const t = k / 1000, c = toward(rgb, t, 255); if (isNearWhite(c)) break; best = c; bt = t; }
    return { rgb: best, adjust, blend: bt };
  }
  if (adjust.lighten != null) { const t = Number(adjust.lighten); if (!(t >= 0 && t <= 1)) return { problem: 'lighten must be between 0 and 1 or "max-under-near-white"' }; return { rgb: toward(rgb, t, 255), adjust, blend: t }; }
  return { problem: 'adjust must be { lighten } or { darken }' };
}

// regions: [{ label, select, action, sample, featherPx }]; samples: { [label]: { rgb } } already resolved. In place on data.
export function applyRegionEdits(data, W, H, regions, samples, opts = {}) {
  const sel = regions.map((r) => ({ r, s: selectRegion(data, W, H, r.select, { ...opts, spread: r.action === 'recolour' ? (r.spread ?? true) : r.spread }) }));
  const bad = sel.filter((x) => x.s.problem).map((x) => x.r.label + ': ' + x.s.problem);
  if (bad.length) return { ok: false, reason: bad.join('; ') };
  const n = W * H, facts = [], done = new Uint8Array(n);
  for (const { r, s } of sel) {
    const sm = samples[r.label], f = { label: r.label, action: r.action, select: r.select, foundPx: s.px, selectedPx: s.selectedPx, changedPx: 0 };
    if (r.action === 'clear') { for (const i of s.members) { if (done[i]) continue; done[i] = 1; data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 0; f.changedPx++; } }
    else if (!sm || !sm.rgb) return { ok: false, reason: r.label + ': ' + r.action + ' needs a sampled colour' };
    else if (r.action === 'fill') {
      const t = sm.rgb, tl = 0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2], inR = new Uint8Array(n);
      for (const i of s.members) inR[i] = 1;
      const feather = Number.isInteger(r.featherPx) ? r.featherPx : 3, d = new Int16Array(n).fill(-1), q = [...s.members];
      for (const i of s.members) d[i] = 0;
      for (let k = 0; k < q.length; k++) { const i = q[k]; if (d[i] >= feather) continue; for (const j of nb4(i, W, n)) if (d[j] < 0) { d[j] = d[i] + 1; q.push(j); } }
      for (const i of q) {
        if (done[i] || data[i * 4 + 3] === 0) continue;
        if (!inR[i] && lumOf(data, i) <= tl) continue;   // the feather only takes pixels lighter than the sample (the highlight's soft edge)
        done[i] = 1; for (let c = 0; c < 3; c++) data[i * 4 + c] = clamp(t[c]); f.changedPx++;
      }
      f.featherPx = feather;
    } else if (r.action === 'recolour') {
      const t = sm.rgb; let sum = 0; for (const i of s.members) sum += lumOf(data, i); const mean = sum / s.members.length;
      const before = s.members.map((i) => lumOf(data, i));
      s.members.forEach((i, k) => { if (done[i]) return; done[i] = 1; const off = before[k] - mean; for (let c = 0; c < 3; c++) data[i * 4 + c] = clamp(t[c] + off); f.changedPx++; });
      f.meanLumBefore = Math.round(mean * 10) / 10;
    } else return { ok: false, reason: r.label + ': action must be fill, recolour or clear' };
    f.sample = sm ? { ...sm } : null;
    facts.push(f);
  }
  return { ok: true, facts };
}
