// PORTED from Virtual-workers/station/scripts/lib/prop-edit.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, new in the source on 17/10/2026), source sha256 5fac53df089a61d5e514e27a06e2ffc81b494f5834dc0797c6c733d108ccc1bd.
//   change: file writes go through the engine's data jail (dataJail from ../store/active.mjs)
//   change: the edits.json note names the engine module
//   the engine's step (src/engine/owner.mjs editSet) refuses a plan whose recolour source is not an approved file
//   change (owner, 18/10/2026, DECISIONS.md "E6 step c: owner fix tools, post-fix approval rule"): a third op, "region" (lib/region-edit.mjs):
//           a region the build check finds (an enclosed background-like region or a near-white fill, by its box) is filled with a sampled
//           colour, recoloured to one (shape and alpha kept) or cleared; every region quotes the build-check finding it fixes ("addresses");
//           a sampled colour may be lightened or darkened first (sample.adjust; owner amendment, 18/10/2026)
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// prop-edit.mjs (lib) — owner-authorised DETERMINISTIC edits of a digital set's raw files, no model (OWNER exception to the station freeze,
// 2026-10-17: set-v4 of the PNGTuber desk props). Two edits, pure on an RGBA buffer (alpha is never changed), applied by
// scripts/edit-prop.mjs from the set's edit plan (set-vN/edit-plan.json) and recorded (set-vN/edits.json):
//   recolour   a file made from ANOTHER file's exact pixels and alpha (11 = file 1 in other colours): every pixel is fitted as one FIXED colour
//              (outline, coffee: kept), one colour ROLE (a ramp of source colours, e.g. the cream body from highlight to shade, optionally only
//              inside a box), or, when that fit is poor, a blend of a role colour with a fixed colour or another role (anti-aliased edges).
//              The role part moves to the same place on the role's target ramp; the fixed part and the fit's residual are kept. KEEP regions
//              (flood-filled from seed points, e.g. the steam and its own outline) are not touched. A pixel no fit explains within
//              maxResidual is left as it is and counted.
//   outline    a file's outline brought to another file's outline colour (07/12: the red-brown line to file 1's dark brown). Both colours are
//              MEASURED (silhouetteOutline). Pixels near the source outline colour move by (target - source); the anti-aliased pixels between
//              the line and a fill move by their outline share, fitted against the local fill colour. Fills, and the generator's thin
//              near-black edge pixels (file 1 has them too), are left alone.
//   then       (owner, 2026-10-17, after QA DESIGN pass 3: 12's olive cushion to 11's sage) an outline edit may carry recolour steps
//              ("then": [{ op: "recolour", spec, why }]) applied in order to the outline's result, in memory, on the SAME file, so a re-run
//              still starts from the Designer's original and gives the same bytes. No source file: the roles move this file's own colours.
// The build then treats the edited file like any other raw file; the Designer's originals stay in set-vN/raw-original/.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { sha256 } from './common.mjs';
import { dataJail } from '../store/active.mjs';
import { config as defaultConfig } from './common.mjs';
import { selectRegion, sampleAround, sampleBox, applyRegionEdits, adjustColour } from './region-edit.mjs';
const regionOpts = () => { const c = ((defaultConfig.digital || {}).build || {}).cleanup || {}; return { enclosed: c.enclosed || {}, palette: c.palette || {} }; };

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const nb4 = (i, W, n, f) => { const x = i % W; if (x > 0) f(i - 1); if (x < W - 1) f(i + 1); if (i >= W) f(i - W); if (i < n - W) f(i + W); };

// the outline colour of a drawing: median RGB of opaque, dark, coloured pixels between inner and ring px from a fully clear pixel (the
// silhouette line, without its anti-aliased outer edge)
export function silhouetteOutline(data, W, H, { inner = 3, ring = 7, minLum = 25, maxLum = 140, minChroma = 12 } = {}) {
  const n = W * H, d = new Int16Array(n).fill(-1), q = [];
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] === 0) { d[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) { const i = q[k]; if (d[i] >= ring) continue; nb4(i, W, n, (j) => { if (d[j] < 0) { d[j] = d[i] + 1; q.push(j); } }); }
  const ch = [[], [], []];
  for (let i = 0; i < n; i++) {
    if (d[i] < inner || data[i * 4 + 3] < 255) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], l = lum(r, g, b);
    if (l < minLum || l > maxLum || Math.max(r, g, b) - Math.min(r, g, b) < minChroma) continue;
    ch[0].push(r); ch[1].push(g); ch[2].push(b);
  }
  if (!ch[0].length) return null;
  return { rgb: ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]), px: ch[0].length };
}

// pixels connected (4-neighbours) to any seed [x, y] whose luminance is within [minLum, maxLum], grown by dilate px, then (grow) on into
// connected pixels within grow.maxDist of grow.rgb (e.g. the steam's own outline colour). Returns { mask, px, seeds }.
export function floodMask(data, W, H, regions = []) {
  const n = W * H, mask = new Uint8Array(n), seeds = [];
  for (const rg of regions) {
    const lo = rg.minLum ?? 0, hi = rg.maxLum ?? 255, ok = (i) => data[i * 4 + 3] >= 128 && lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= lo && lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) <= hi;
    const reg = new Uint8Array(n), q = [];
    for (const [x, y] of rg.seeds || []) { const s = y * W + x; const good = x >= 0 && y >= 0 && x < W && y < H && ok(s); seeds.push({ region: rg.name, at: [x, y], ok: good }); if (good && !reg[s]) { reg[s] = 1; q.push(s); } }
    for (let k = 0; k < q.length; k++) nb4(q[k], W, n, (j) => { if (!reg[j] && ok(j)) { reg[j] = 1; q.push(j); } });
    let front = q;
    for (let r = 0; r < (rg.dilate || 0); r++) { const next = []; for (const i of front) nb4(i, W, n, (j) => { if (!reg[j]) { reg[j] = 1; next.push(j); } }); front = next; }
    if (rg.grow) {
      const near = (j) => data[j * 4 + 3] > 0 && dist([data[j * 4], data[j * 4 + 1], data[j * 4 + 2]], rg.grow.rgb) <= rg.grow.maxDist, g = [];
      for (let i = 0; i < n; i++) if (reg[i]) g.push(i);
      for (let k = 0; k < g.length; k++) nb4(g[k], W, n, (j) => { if (!reg[j] && near(j)) { reg[j] = 1; g.push(j); } });
    }
    for (let i = 0; i < n; i++) if (reg[i]) mask[i] = 1;
  }
  let px = 0; for (let i = 0; i < n; i++) px += mask[i];
  return { mask, px, seeds };
}

// a role's ramp as samples with their position t (0..1 along the polyline) for blend fits; and the exact projection for a pure fit
const sampleRamp = (pts, per = 16) => {
  const out = [];
  for (let s = 0; s < pts.length - 1; s++) for (let k = 0; k < per; k++) { const u = k / per; out.push({ seg: s, u, c: [0, 1, 2].map((c) => pts[s][c] + u * (pts[s + 1][c] - pts[s][c])) }); }
  out.push({ seg: pts.length - 2, u: 1, c: pts[pts.length - 1].slice() });
  return out;
};
const along = (pts, seg, u) => [0, 1, 2].map((c) => pts[seg][c] + u * (pts[seg + 1][c] - pts[seg][c]));
function projectRamp(p, pts) {
  let best = null;
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], d = [0, 1, 2].map((c) => pts[s + 1][c] - a[c]), dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const u = dd ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / dd)) : 0, q = along(pts, s, u), e = dist(p, q);
    if (!best || e < best.e) best = { seg: s, u, q, e };
  }
  return best;
}
// p ~ s*c + (1-s)*k: the share s of c, and the residual
function blendFit(p, c, k) {
  const d = [0, 1, 2].map((i) => c[i] - k[i]), dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2; if (!dd) return null;
  const s = Math.max(0, Math.min(1, ((p[0] - k[0]) * d[0] + (p[1] - k[1]) * d[1] + (p[2] - k[2]) * d[2]) / dd));
  return { s, q: [0, 1, 2].map((i) => k[i] + s * d[i]) };
}

// recolour: spec = { roles: [{ name, from: [[r,g,b]...], to: [[r,g,b]...], box?: [x, y, w, h] }], fixed: [{ name, rgb }],
//   keep: [{ name, seeds, minLum, maxLum, dilate, grow }], maxResidual, pureOk, blendMargin }. A role with a box applies only inside it
//   (the band: its colours are close to the outline's blends with the body elsewhere).
// In place. Returns the counts (per role and fixed colour, kept, unexplained) and the keep seeds as found.
export function recolourByRoles(data, W, H, spec) {
  const n = W * H, maxRes = spec.maxResidual ?? 20, roles = spec.roles || [], fixed = spec.fixed || [];
  for (const r of roles) if (!Array.isArray(r.from) || r.from.length < 2 || !Array.isArray(r.to) || r.to.length !== r.from.length) throw new Error('role ' + r.name + ': from and to need the same number (2 or more) of colours');
  const samples = roles.map((r) => sampleRamp(r.from)), keep = floodMask(data, W, H, spec.keep || []);
  const cache = new Map(), counts = { kept: 0, transparent: 0, unexplained: 0, roles: Object.fromEntries(roles.map((r) => [r.name, 0])), fixed: Object.fromEntries(fixed.map((f) => [f.name, 0])), blends: 0 };
  // the best fit: its error, the fitted colour q, the mapped colour (make) and what it was. Ties keep the first found (fixed, pure role, blend)
  // A pure fit (one fixed colour or one role) within pureOk is taken as it is; a blend is taken only when it beats the best pure fit by
  // blendMargin (otherwise the drawing's small noise reads as blends and the new colours come out speckled).
  const pureOk = spec.pureOk ?? 12, margin = spec.blendMargin ?? 6;
  const inBox = (r, x, y) => !r.box || (x >= r.box[0] && y >= r.box[1] && x < r.box[0] + r.box[2] && y < r.box[1] + r.box[3]);
  const fit = (p, on) => {
    let best = null; const consider = (q, make, label) => { const e = dist(p, q); if (!best || e < best.e - 1e-9) best = { e, q, make, label }; };
    for (const f of fixed) consider(f.rgb, () => f.rgb, { fixed: f.name });
    roles.forEach((r, ri) => { if (!on[ri]) return; const pr = projectRamp(p, r.from); consider(pr.q, () => along(r.to, pr.seg, pr.u), { role: r.name }); });
    if (best.e <= pureOk) return best;
    const pure = best; best = null;
    // blends: a role colour with a fixed colour, or with another role's colour (the edge between two fills)
    roles.forEach((r, ri) => {
      if (!on[ri]) return;
      for (const sm of samples[ri]) {
        for (const f of fixed) { const b = blendFit(p, sm.c, f.rgb); if (!b || b.s <= 0.02 || b.s >= 0.98) continue; consider(b.q, () => { const t = along(r.to, sm.seg, sm.u); return [0, 1, 2].map((c) => f.rgb[c] + b.s * (t[c] - f.rgb[c])); }, { role: r.name, blend: f.name }); }
        roles.forEach((r2, rj) => { if (rj <= ri || !on[rj]) return; for (const sm2 of samples[rj]) { const b = blendFit(p, sm.c, sm2.c); if (!b || b.s <= 0.02 || b.s >= 0.98) continue;
          consider(b.q, () => { const t = along(r.to, sm.seg, sm.u), t2 = along(r2.to, sm2.seg, sm2.u); return [0, 1, 2].map((c) => t2[c] + b.s * (t[c] - t2[c])); }, { role: r.name, blend: r2.name }); } });
      }
    });
    return best && best.e < pure.e - margin ? best : pure;
  };
  for (let i = 0; i < n; i++) {
    const o = i * 4; if (data[o + 3] === 0) { counts.transparent++; continue; }
    if (keep.mask[i]) { counts.kept++; continue; }
    const x = i % W, y = (i - x) / W, on = roles.map((r) => inBox(r, x, y)), mask = on.reduce((m, v, k) => m | (v ? 1 << k : 0), 0);
    const key = ((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]) * 256 + mask;
    let res = cache.get(key);
    if (!res) {
      const p = [data[o], data[o + 1], data[o + 2]], b = fit(p, on);
      if (!b || b.e > maxRes) res = { out: null, label: null };
      // the fit's residual (the drawing's small variations) is carried over onto the mapped colour
      else { const m = b.make(); res = { out: [0, 1, 2].map((c) => clamp(m[c] + p[c] - b.q[c])), label: b.label }; }
      cache.set(key, res);
    }
    if (!res.out) { counts.unexplained++; continue; }
    if (res.label.fixed) { counts.fixed[res.label.fixed]++; continue; }
    counts.roles[res.label.role]++; if (res.label.blend) counts.blends++;
    data[o] = res.out[0]; data[o + 1] = res.out[1]; data[o + 2] = res.out[2];
  }
  return { counts, keep: { px: keep.px, seeds: keep.seeds }, maxResidual: maxRes };
}

// outline: from = the file's outline colour, to = the target outline colour (both measured by silhouetteOutline unless given).
// core: pixels within coreDist of from move by (to - from), keeping their small variations; alpha is kept. The generator's near-black
// edge pixels along the line are left as they are (file 1 has them too). Edge: non-core pixels within reach px of the core, fitted as a
// blend of from and the local fill colour (the median of the far-from-outline pixels within window px, not next to the core), move by their
// outline share s: p + s*(to - from), when the fit is within maxResidual; otherwise they are left and counted.
export function normaliseOutline(data, W, H, { from, to, coreDist = 34, reach = 3, window = 4, maxResidual = 22, fillMinDist = 60 } = {}) {
  const n = W * H, core = new Uint8Array(n);
  let corePx = 0, edgePx = 0, edgeUnfit = 0;
  for (let i = 0; i < n; i++) { const o = i * 4; if (data[o + 3] === 0) continue; if (dist([data[o], data[o + 1], data[o + 2]], from) <= coreDist) { core[i] = 1; corePx++; } }
  // distance (in px) from the core, up to reach
  const dCore = new Int8Array(n).fill(-1), q = [];
  for (let i = 0; i < n; i++) if (core[i]) { dCore[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) { const i = q[k]; if (dCore[i] >= reach) continue; nb4(i, W, n, (j) => { if (dCore[j] < 0) { dCore[j] = dCore[i] + 1; q.push(j); } }); }
  const out = Buffer.from(data), shift = [0, 1, 2].map((c) => to[c] - from[c]);
  for (let i = 0; i < n; i++) {
    const o = i * 4; if (data[o + 3] === 0) continue;
    if (core[i]) { for (let c = 0; c < 3; c++) out[o + c] = clamp(data[o + c] + shift[c]); continue; }
    if (dCore[i] < 1) continue;
    // the local fill: median of pixels in the window that are neither core nor next to it, and far from the outline colour
    const x = i % W, y = (i - x) / W, ch = [[], [], []];
    for (let yy = Math.max(0, y - window); yy <= Math.min(H - 1, y + window); yy++) for (let xx = Math.max(0, x - window); xx <= Math.min(W - 1, x + window); xx++) {
      const j = yy * W + xx, oj = j * 4; if (data[oj + 3] < 250 || core[j] || (dCore[j] >= 0 && dCore[j] <= 1)) continue;
      const pj = [data[oj], data[oj + 1], data[oj + 2]]; if (dist(pj, from) < fillMinDist) continue; for (let c = 0; c < 3; c++) ch[c].push(pj[c]);
    }
    const p = [data[o], data[o + 1], data[o + 2]];
    if (!ch[0].length) { edgeUnfit++; continue; }
    const fill = ch.map((a) => a.sort((u, v) => u - v)[a.length >> 1]), b = blendFit(p, from, fill);
    if (!b || b.s <= 0.02 || dist(p, b.q) > maxResidual) { edgeUnfit++; continue; }
    for (let c = 0; c < 3; c++) out[o + c] = clamp(data[o + c] + b.s * shift[c]); edgePx++;
  }
  out.copy(data);
  return { from, to, corePx, edgePx, edgeUnfit, settings: { coreDist, reach, window, maxResidual, fillMinDist } };
}

// ---- applying a set's edit plan to its raw files ----
// set-vN/edit-plan.json { listingId, set, authorisedBy, date, edits: [{ op: "recolour", file, source, spec, why } | { op: "outline", file, like, settings?, why, then?: [{ op: "recolour", spec, why }] }] }
// For each edit the Designer's file is kept once in set-vN/raw-original/<file> (never overwritten). An outline edit reads raw-original (so a
// re-run gives the same bytes) and the like file in raw/; a recolour reads its source in raw/. Neither source may itself be edited by the
// plan. raw/<file> is written only when the bytes differ; the record (set-vN/edits.json) names every input and output by sha256. dry: nothing is written.
const writeAtomic = (file, buf) => { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(dataJail(tmp), buf); fs.renameSync(dataJail(tmp), dataJail(file)); };
const rgbaOf = async (buf) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, W: info.width, H: info.height }; };
const SAFE_PNG = /^[a-z0-9][a-z0-9._-]*\.png$/;

export function readPlan(sd) {
  const f = path.join(sd, 'edit-plan.json'); if (!fs.existsSync(f)) return { ok: false, reason: 'no edit plan: ' + f };
  let plan; try { plan = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, reason: 'edit-plan.json is not valid JSON: ' + e.message }; }
  const edits = Array.isArray(plan.edits) ? plan.edits : [], out = [], targets = new Set(edits.map((e) => e.file));
  if (!edits.length) out.push('the plan has no edits');
  if (!plan.authorisedBy || !/^\d{4}-\d{2}-\d{2}$/.test(String(plan.date || ''))) out.push('the plan needs authorisedBy and a date (YYYY-MM-DD)');
  for (const e of edits) {
    if (!SAFE_PNG.test(String(e.file || ''))) out.push('edit file must be a plain lowercase PNG name: ' + e.file);
    if (e.op === 'recolour') {
      if (!SAFE_PNG.test(String(e.source || ''))) out.push(e.file + ': a recolour needs a source PNG name'); else if (targets.has(e.source)) out.push(e.file + ': its source ' + e.source + ' is itself edited by the plan');
      if (!e.spec || !Array.isArray(e.spec.roles) || !e.spec.roles.length) out.push(e.file + ': a recolour needs spec.roles');
    } else if (e.op === 'outline') {
      if (!SAFE_PNG.test(String(e.like || ''))) out.push(e.file + ': an outline edit needs a like PNG name'); else if (targets.has(e.like)) out.push(e.file + ': its like file ' + e.like + ' is itself edited by the plan');
      if (e.then !== undefined) {
        if (!Array.isArray(e.then) || !e.then.length) out.push(e.file + ': "then" must be a non-empty list of recolour steps');
        else for (const t of e.then) if (!t || t.op !== 'recolour' || !t.spec || !Array.isArray(t.spec.roles) || !t.spec.roles.length) out.push(e.file + ': a "then" step must be a recolour with spec.roles');
      }
    } else if (e.op === 'region') {
      if (!Array.isArray(e.regions) || !e.regions.length) out.push(e.file + ': a region edit needs regions');
      else for (const g of e.regions) {
        const lab = e.file + ' region ' + ((g && g.label) || '?');
        if (!g || !String(g.label || '').trim()) out.push(e.file + ': every region needs a label');
        if (!g || !['fill', 'recolour', 'clear'].includes(g.action)) out.push(lab + ': action must be fill, recolour or clear');
        if (!g || !g.select || !['enclosed', 'near-white'].includes(g.select.kind) || !Array.isArray(g.select.box) || g.select.box.length !== 4) out.push(lab + ': select must be { kind: "enclosed" | "near-white", box: [x, y, w, h] }');
        if (g && g.action !== 'clear') {
          const sm = g.sample;
          if (!sm || !(sm.around === true || (SAFE_PNG.test(String(sm.file || '')) && Array.isArray(sm.box) && sm.box.length === 4))) out.push(lab + ': ' + (g.action || '') + ' needs sample { around: true } or { file, box }');
          else if (sm.file && targets.has(sm.file)) out.push(lab + ': its sample file ' + sm.file + ' is itself edited by the plan');
          if (sm && sm.adjust !== undefined && (typeof sm.adjust !== 'object' || sm.adjust === null || (sm.adjust.lighten === undefined && sm.adjust.darken === undefined))) out.push(lab + ': sample.adjust must be { lighten } or { darken }');
        }
        if (!g || !String(g.addresses || '').trim()) out.push(lab + ': addresses must quote the build-check finding it fixes');
      }
    } else out.push('unknown edit op "' + e.op + '" for ' + e.file);
    if (e.op === 'recolour' && e.then !== undefined) out.push(e.file + ': "then" steps follow an outline edit only');
  }
  if (targets.size !== edits.length) out.push('a file is edited more than once in the plan');
  return out.length ? { ok: false, reason: out.join('; ') } : { ok: true, plan };
}

export async function applyEditPlan({ sd, dry = false, log = { info() {}, warn() {}, error() {} } }) {
  const r = readPlan(sd); if (!r.ok) return r;
  const plan = r.plan, raw = path.join(sd, 'raw'), orig = path.join(sd, 'raw-original'), results = [];
  for (const e of plan.edits) {
    const target = path.join(raw, e.file), keep = path.join(orig, e.file);
    if (!fs.existsSync(keep) && !fs.existsSync(target)) return { ok: false, reason: 'raw/' + e.file + ' is missing' };
    const original = fs.readFileSync(fs.existsSync(keep) ? keep : target);
    let img, facts, extra;
    if (e.op === 'recolour') {
      const sf = path.join(raw, e.source); if (!fs.existsSync(sf)) return { ok: false, reason: 'raw/' + e.source + ' (the recolour source) is missing' };
      const sb = fs.readFileSync(sf); img = await rgbaOf(sb); extra = { source: { file: 'raw/' + e.source, sha256: sha256(sb) } };
      facts = recolourByRoles(img.data, img.W, img.H, e.spec);
    } else if (e.op === 'region') {
      // owner, 18/10/2026: selections and samples are taken on the Designer's original, then every region's action runs
      img = await rgbaOf(original); const samples = {}, o = regionOpts();
      for (const g of e.regions) {
        if (g.action === 'clear') continue;
        if (g.sample.around) {
          const sel = selectRegion(img.data, img.W, img.H, g.select, o); if (sel.problem) return { ok: false, reason: e.file + ' region ' + g.label + ': ' + sel.problem };
          const sm = sampleAround(img.data, img.W, img.H, sel.members, { ringPx: g.sample.ringPx || 6 }); if (!sm) return { ok: false, reason: e.file + ' region ' + g.label + ': no opaque pixels around it to sample' };
          samples[g.label] = { ...sm, from: 'around region ' + g.label + ' in raw-original/' + e.file + ' (ringPx ' + (g.sample.ringPx || 6) + ')' };
        } else {
          const sf = path.join(raw, g.sample.file); if (!fs.existsSync(sf)) return { ok: false, reason: 'raw/' + g.sample.file + ' (the sample of region ' + g.label + ') is missing' };
          const sb = fs.readFileSync(sf), S = await rgbaOf(sb), sm = sampleBox(S.data, S.W, S.H, g.sample.box); if (!sm) return { ok: false, reason: e.file + ' region ' + g.label + ': no opaque pixels in the sample box' };
          samples[g.label] = { ...sm, from: 'raw/' + g.sample.file + ' box ' + g.sample.box.join(','), sha256: sha256(sb) };
        }
      }
      // owner amendment, 18/10/2026: a sampled colour may be lightened or darkened first (e.g. a highlight: as light as the palette rule allows)
      for (const g of e.regions) {
        if (!samples[g.label] || !g.sample.adjust) continue;
        const a = adjustColour(samples[g.label].rgb, g.sample.adjust, o.palette); if (a.problem) return { ok: false, reason: e.file + ' region ' + g.label + ': ' + a.problem };
        samples[g.label] = { ...samples[g.label], sampledRgb: samples[g.label].rgb, rgb: a.rgb, adjust: g.sample.adjust, blend: a.blend };
      }
      const rr = applyRegionEdits(img.data, img.W, img.H, e.regions, samples, o); if (!rr.ok) return { ok: false, reason: e.file + ': ' + rr.reason };
      facts = { regions: rr.facts };
      extra = { regions: e.regions.map((g) => ({ label: g.label, action: g.action, select: g.select, sample: g.sample || null, addresses: g.addresses, ...(g.addressesWarning ? { addressesWarning: g.addressesWarning } : {}) })) };
    } else {
      const lf = path.join(raw, e.like); if (!fs.existsSync(lf)) return { ok: false, reason: 'raw/' + e.like + ' (the outline reference) is missing' };
      const lb = fs.readFileSync(lf), L = await rgbaOf(lb); img = await rgbaOf(original);
      const to = silhouetteOutline(L.data, L.W, L.H), from = silhouetteOutline(img.data, img.W, img.H);
      if (!to || !from) return { ok: false, reason: e.file + ': no outline could be measured on ' + (to ? e.file : e.like) };
      extra = { like: { file: 'raw/' + e.like, sha256: sha256(lb), outlineRgb: to.rgb, outlinePx: to.px }, measured: { outlineRgb: from.rgb, outlinePx: from.px } };
      facts = normaliseOutline(img.data, img.W, img.H, { ...(e.settings || {}), from: from.rgb, to: to.rgb });
      if (e.then) extra.then = e.then.map((t) => { const f = recolourByRoles(img.data, img.W, img.H, t.spec); log.info('then recolour ' + e.file, { counts: f.counts }); return { op: t.op, why: t.why || '', facts: f }; });
    }
    const out = await sharp(img.data, { raw: { width: img.W, height: img.H, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    const changed = !fs.existsSync(target) || !fs.readFileSync(target).equals(out);
    if (!dry) {
      fs.mkdirSync(dataJail(orig), { recursive: true });
      if (!fs.existsSync(keep)) { writeAtomic(keep, original); log.info('kept the Designer\'s original', { file: 'raw-original/' + e.file, sha256: sha256(original) }); }
      if (changed) writeAtomic(target, out);
    }
    const action = dry ? (changed ? 'would-write' : 'unchanged') : (changed ? 'written' : 'unchanged');
    log.info(e.op + ' ' + e.file + ': ' + action, e.op === 'outline' ? { from: extra.measured.outlineRgb, to: extra.like.outlineRgb, corePx: facts.corePx, edgePx: facts.edgePx, edgeUnfit: facts.edgeUnfit } : e.op === 'region' ? { regions: facts.regions.map((x) => x.label + ' ' + x.action + ' ' + x.changedPx + ' px') } : { counts: facts.counts });
    results.push({ action, rec: { op: e.op, file: 'raw/' + e.file, why: e.why || '', original: { file: 'raw-original/' + e.file, sha256: sha256(original) }, ...extra, output: { sha256: sha256(out), widthPx: img.W, heightPx: img.H }, facts } });
  }
  const pf = path.join(sd, 'edit-plan.json'), record = { listingId: plan.listingId, set: plan.set, authorisedBy: plan.authorisedBy, date: plan.date, plan: 'edit-plan.json', planSha256: sha256(fs.readFileSync(pf)),
    note: 'deterministic station edits of raw files, no model: src/engine/lib/prop-edit.mjs. The Designer\'s originals are in raw-original/.', edits: results.map((x) => x.rec) };
  const text = JSON.stringify(record, null, 1) + '\n', rf = path.join(sd, 'edits.json'), same = fs.existsSync(rf) && fs.readFileSync(rf, 'utf8') === text;
  if (!dry && !same) writeAtomic(rf, text);
  return { ok: true, record, actions: results.map((x) => ({ file: x.rec.file, action: x.action })), recordAction: same ? 'unchanged' : dry ? 'would-write' : 'written' };
}
