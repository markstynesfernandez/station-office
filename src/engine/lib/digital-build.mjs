// PORTED from Virtual-workers/station/scripts/lib/digital-build.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 20:04; the build itself is now ported), source sha256 c8085338fc5c2e08d3e61d78ce4ae29fe1e5d3f56238fa89d2082f2f36c6ecc4.
//   OWNER DECISION 17/10/2026: the whole build is ported (it was read side only): clean-up with the enclosed-background step and edge unmix,
//     the removed-area and near-white fill checks, the post-build re-check, Real-ESRGAN (alpha separately), padding, PNG optimisation for
//     Etsy's 20 MB (lossless, then palette if the zip is still over), ONE deterministic zip and the listing preview. BUILD_VERSION 5, as in the source
//   change: the upscaler is passed in by the engine (esrgan.mjs esrganUpscaler: the pinned binary as a child process, killed by the E-STOP); without one, Lanczos with a warning the package gate refuses
//   change: file writes go through the engine's data jail (dataJail from ../store/active.mjs); temp files in set-vN/.tmp-build-<pid>/, not the OS temp
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   change: builtBy names the engine module
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// digital-build.mjs (lib) — builds a PACKAGED digital product's deliverables from the Designer's raw files, with no model (owner go 2026-10-16).
// For a product whose spec has deliverables.package (products.json), the Designer writes its generated images to work/<id>/set-vN/raw/ and
// the station makes what the buyer gets:
//   1. clean-up (each raw PNG, at the generator's size): background painted opaque inside a closed shape (a handle hole) made transparent,
//      faint alpha haze and fringe cleared, near-solid alpha made solid, separate tiny opaque specks removed, colour under clear pixels
//      zeroed, trimmed to the artwork (config.digital.build.cleanup); every opaque pixel the enclosed step removed is checked against the
//      generated file's own colour (background-coloured = light and near-grey, cleanup.palette), near-white fills are recorded (the palette
//      rule, owner 2026-10-17), and the finished file is re-checked for enclosed background left behind;
//   2. upscale: the trimmed artwork is enlarged with local Real-ESRGAN, alpha upscaled separately (lib/esrgan.mjs, the step parked with the
//      POD line), to fill the product's canvas less config.digital.build.paddingPct on each side; faint alpha left by resampling cleared again;
//   3. padding: centred on a transparent canvas of the spec's exact pixel size, so every file in the pack sits the same way;
//   4. package: ONE zip of the processed files (lib/zip.mjs, deterministic) in files/: the buyer's only download (owner, 2026-10-16);
//      a preview image (a grid of every file, no text) in set-vN/listing/ (config.digital.build.preview.dir): a listing photo, never a download.
// Everything it did is recorded in set-vN/build.json, per file (input and output sha256, clean-up counts, upscale method, scale, padding,
// warnings); digital-prep copies it into the manifest and the package gate checks every delivered file against it (the listing's AI
// disclosure says the files were cleaned up). Idempotent: when the raw files and settings are unchanged and every output is still on disk
// as recorded, nothing is rebuilt. Not run inside a StarNet hook (those stop after 5 s): run-line calls it between DESIGNER and QA DESIGN,
// and scripts/build-digital-set.mjs runs it by hand. Injectable upscaler so tests need no GPU.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config as defaultConfig, sha256, productsFile } from './common.mjs';
import { esrganCfg } from './esrgan.mjs';
import { dataJail } from '../store/active.mjs';
import { writeZip, SAFE_NAME } from './zip.mjs';

export const BUILD_VERSION = 5;   // bump when the processing changes, so earlier builds are redone (3: enclosed background made transparent; 4: removed-area and near-white fill checks; 5: PNG optimisation for Etsy's 20 MB)
const setDirOf = (roomDir, id, n) => path.join(roomDir, 'jobs', id, 'set-v' + n);
export const zipNameFor = (id) => String(id).replace(/^\d{4}-\d{2}-\d{2}--/, '') + '.zip';
// where the listing preview lives: set-vN/<preview.dir>/<preview.name>, outside files/ (it is a listing photo, not a download)
export const previewDirOf = (cfg = defaultConfig) => ((cfg.digital.build.preview || {}).dir || 'listing');
export const isPackaged = (product) => !!(product && product.deliverables && product.deliverables.package && product.deliverables.package.kind === 'zip');
// the digital-download notice a listing states word for word: the product's own (products.json listingNotice, it names the files) or the config default
export function noticeFor(product, cfg = defaultConfig) {
  const own = product && product.listingNotice, d = cfg.digital || {};
  return own && own.text ? { text: own.text, status: own.status || '', where: 'products.json ' + product.key + '.listingNotice' } : { text: d.listingNotice, status: d.listingNoticeStatus || '', where: 'config.digital.listingNotice' };
}

// the product a listing's brief names (work/<id>/brief.md product_type), from the digital products.json
export function productFor(roomDir, id, products = null) {
  const bf = path.join(roomDir, 'jobs', id, 'brief.md');
  const key = fs.existsSync(bf) ? ((/^product_type:\s*(\S+)/m.exec(fs.readFileSync(bf, 'utf8')) || [])[1] || null) : null;
  let list = products; if (!list) { try { list = JSON.parse(fs.readFileSync(productsFile('digital'), 'utf8')).products; } catch (_) { list = []; } }
  return { key, product: list.find((x) => x.key === key) || null };
}

// ENCLOSED BACKGROUND (owner exception 2026-10-16: the mug's handle hole came out opaque off-white). The image model sometimes paints the
// background INSIDE a closed shape (a handle, a loop) instead of leaving it transparent. A region is background-like when its pixels are
// opaque (alpha >= 128), light (luminance >= minLum) and nearly grey (max - min channel <= maxChroma); it counts when it is solid (area >=
// minRegionPx and average width, area / longer side, >= minWidthPx, so thin highlight lines do not) and ENCLOSED (no clear pixel and no image
// edge within ringPx of it). outlineShare = the share of the opaque pixels in that ring that are outline-dark (luminance <= outlineMaxLum).
// Thresholds are at the generator's size (config.digital.build.cleanup.enclosed); scale applies them to an enlarged image. Pure.
export const ENCLOSED_DEFAULTS = { minLum: 240, maxChroma: 24, minRegionPx: 400, minWidthPx: 12, ringPx: 4, outlineMaxLum: 110, minOutlineShare: 0.5, fringePx: 3, fringeMaxDist: 40 };
// PALETTE RULE (owner, 2026-10-17, the products in config.digital.build.cleanup.palette.products): no pure-white or grey-white fills; a fill's
// colour channels differ by more than maxChroma. Background-coloured (what the clean-up may remove) = luminance >= backgroundMinLum and
// channels within maxChroma; a near-white fill = luminance >= nearWhiteMinLum and channels within maxChroma, solid as above. The generated file
// carries no background colour of its own (its clear pixels are black), so the colour of the removed pixels is the test.
export const PALETTE_DEFAULTS = { products: [], maxChroma: 24, backgroundMinLum: 240, nearWhiteMinLum: 200, minRegionPx: 400, minWidthPx: 12 };
const lumAt = (d, i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
const chromaAt = (d, i) => Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
export function enclosedBackgroundRegions(data, W, H, opts = {}, scale = 1) {
  const o = { ...ENCLOSED_DEFAULTS, ...opts }, n = W * H, minPx = o.minRegionPx * scale * scale, minWidth = o.minWidthPx * scale, ringPx = Math.max(1, Math.round(o.ringPx * scale));
  const bgLike = (i) => { const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]; return data[i * 4 + 3] >= 128 && lumAt(data, i) >= o.minLum && Math.max(r, g, b) - Math.min(r, g, b) <= o.maxChroma; };
  const atEdge = (i) => { const x = i % W; return x === 0 || x === W - 1 || i < W || i >= n - W; };
  const nb = (i, f) => { const x = i % W; if (x > 0) f(i - 1); if (x < W - 1) f(i + 1); if (i >= W) f(i - W); if (i < n - W) f(i + W); };
  const lab = new Int32Array(n), ring = new Int32Array(n), regions = [];
  for (let s = 0; s < n; s++) {
    if (lab[s] || !bgLike(s)) continue;
    const id = s + 1, members = [s]; lab[s] = id;
    for (let k = 0; k < members.length; k++) nb(members[k], (j) => { if (!lab[j] && bgLike(j)) { lab[j] = id; members.push(j); } });
    let x0 = W, y0 = H, x1 = -1, y1 = -1, sr = 0, sg = 0, sb = 0, edge = false;
    for (const i of members) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; if (atEdge(i)) edge = true; }
    const px = members.length, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (px < minPx || px / Math.max(bw, bh) < minWidth || edge) continue;
    // the ring of pixels within ringPx outside the region: any clear pixel or image edge = not enclosed
    let frontier = members, clear = 0, opaque = 0, dark = 0; const oc = [0, 0, 0];
    for (let layer = 0; layer < ringPx && !edge; layer++) {
      const next = [];
      for (const i of frontier) nb(i, (j) => { if (lab[j] === id || ring[j] === id) return; ring[j] = id; next.push(j); if (atEdge(j)) edge = true;
        if (data[j * 4 + 3] < 128) clear++; else { opaque++; if (lumAt(data, j) <= o.outlineMaxLum) { dark++; oc[0] += data[j * 4]; oc[1] += data[j * 4 + 1]; oc[2] += data[j * 4 + 2]; } } });
      frontier = next;
    }
    if (edge || clear) continue;
    regions.push({ members, px, box: [x0, y0, bw, bh], meanRgb: [sr, sg, sb].map((v) => Math.round(v / px)), outlineShare: opaque ? Number((dark / opaque).toFixed(3)) : 0, outlineRgb: dark ? oc.map((v) => Math.round(v / dark)) : null });
  }
  return regions;
}

// clean-up: every enclosed background-like region bordered mostly by outline (outlineShare >= minOutlineShare) is made transparent, and the
// anti-aliased edge between it and the outline (a blend of the two colours, within fringePx) is unmixed into the outline colour with partial
// alpha, so no pale halo is left. Regions under minOutlineShare (e.g. a white patch inside a coloured fill) are kept and reported. In place.
export function clearEnclosedBackground(data, W, H, opts = {}) {
  const o = { ...ENCLOSED_DEFAULTS, ...opts }, n = W * H, cleared = [], kept = [], pub = ({ members, ...r }) => r;
  let fringeAdjustedPx = 0;
  for (const r of enclosedBackgroundRegions(data, W, H, o)) {
    if (r.outlineShare < o.minOutlineShare || !r.outlineRgb) { kept.push(pub(r)); continue; }
    const inR = new Uint8Array(n); for (const i of r.members) { inR[i] = 1; data[i * 4 + 3] = 0; }
    const hc = r.meanRgb, ol = r.outlineRgb, d = [0, 1, 2].map((c) => hc[c] - ol[c]), dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    let frontier = r.members;
    for (let layer = 0; layer < o.fringePx; layer++) {
      const next = [];
      for (const i of frontier) { const x = i % W; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < n - W ? i + W : -1]) {
        if (j < 0 || inR[j]) continue; inR[j] = 2; next.push(j);
        const a = data[j * 4 + 3]; if (!a || !dd) continue;
        const p = [data[j * 4], data[j * 4 + 1], data[j * 4 + 2]], t = Math.min(1, ((p[0] - ol[0]) * d[0] + (p[1] - ol[1]) * d[1] + (p[2] - ol[2]) * d[2]) / dd);
        if (t <= 0.02 || Math.hypot(...[0, 1, 2].map((c) => p[c] - (ol[c] + t * d[c]))) > o.fringeMaxDist) continue;
        fringeAdjustedPx++;
        if (t >= 0.98) { data[j * 4 + 3] = 0; continue; }
        data[j * 4 + 3] = Math.round(a * (1 - t)); for (let c = 0; c < 3; c++) data[j * 4 + c] = Math.max(0, Math.min(255, Math.round((p[c] - t * hc[c]) / (1 - t))));
      } }
      frontier = next;
    }
    cleared.push(pub(r));
  }
  return { cleared, kept, fringeAdjustedPx };
}

// near-white fills (the palette rule): solid 4-connected regions of opaque pixels with luminance >= nearWhiteMinLum and channels within
// maxChroma, anywhere in the artwork. Thin highlight lines are not solid. Pure.
export function nearWhiteFills(data, W, H, palette = {}) {
  const o = { ...PALETTE_DEFAULTS, ...palette }, n = W * H, lab = new Uint8Array(n), out = [];
  const nw = (i) => data[i * 4 + 3] >= 128 && lumAt(data, i) >= o.nearWhiteMinLum && chromaAt(data, i) <= o.maxChroma;
  for (let s = 0; s < n; s++) {
    if (lab[s] || !nw(s)) continue;
    const members = [s]; lab[s] = 1; let x0 = W, y0 = H, x1 = -1, y1 = -1; const sum = [0, 0, 0];
    for (let k = 0; k < members.length; k++) {
      const i = members[k], x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (let c = 0; c < 3; c++) sum[c] += data[i * 4 + c];
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < n - W ? i + W : -1]) if (j >= 0 && !lab[j] && nw(j)) { lab[j] = 1; members.push(j); }
    }
    const px = members.length, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (px >= o.minRegionPx && px / Math.max(bw, bh) >= o.minWidthPx) out.push({ px, box: [x0, y0, bw, bh], meanRgb: sum.map((v) => Math.round(v / px)) });
  }
  return out;
}

// pure: clean an RGBA raw buffer in place. Returns the counts and the artwork's bounding box (null when nothing is left).
// enclosed: the enclosed-background thresholds (ENCLOSED_DEFAULTS), or false to skip that step. palette: what counts as background-coloured
// for the removed-area check (PALETTE_DEFAULTS; without it, the enclosed thresholds).
export function cleanAlpha(data, W, H, { alphaFloor = 12, alphaSolid = 244, speckMaxPx = 48, enclosed = {}, palette = null } = {}) {
  const n = W * H; let clearedFaintPx = 0, solidifiedPx = 0;
  // enclosed background first, so its unmixed edge goes through the alpha floor and the solid threshold below
  const a0 = enclosed === false ? null : Uint8Array.from({ length: n }, (_, i) => data[i * 4 + 3]);
  const enc = enclosed === false ? null : clearEnclosedBackground(data, W, H, enclosed);
  if (enc) {
    // removed-area check (owner, 2026-10-17): every pixel opaque in the generated file that the step made fully clear must have been
    // background-coloured there (its colour is still in data: the step changes only alpha of what it clears). Partly cleared edge pixels
    // (the unmixed fringe) are not counted; a fully cleared pixel of another colour is allowed only right on the edge of removed background
    // (a 4-neighbour of it: the one-pixel anti-aliased blend), so an area of drawing removed still counts.
    const eo = { ...ENCLOSED_DEFAULTS, ...enclosed }, bg = palette ? { minLum: palette.backgroundMinLum ?? PALETTE_DEFAULTS.backgroundMinLum, maxChroma: palette.maxChroma ?? PALETTE_DEFAULTS.maxChroma } : { minLum: eo.minLum, maxChroma: eo.maxChroma };
    const kind = new Uint8Array(n);   // 1 = removed background-coloured, 2 = removed other colour
    for (let i = 0; i < n; i++) if (a0[i] >= 128 && data[i * 4 + 3] === 0) kind[i] = lumAt(data, i) >= bg.minLum && chromaAt(data, i) <= bg.maxChroma ? 1 : 2;
    let px = 0, edgePx = 0, bad = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < n; i++) {
      if (!kind[i]) continue; px++; if (kind[i] === 1) continue;
      const x = i % W, y = (i - x) / W;
      if ((x > 0 && kind[i - 1] === 1) || (x < W - 1 && kind[i + 1] === 1) || (i >= W && kind[i - W] === 1) || (i < n - W && kind[i + W] === 1)) { edgePx++; continue; }
      bad++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    enc.removed = { background: bg, px, edgePx, nonBackgroundPx: bad, nonBackgroundBox: bad ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
  }
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a > 0 && a < alphaFloor) { data[i * 4 + 3] = 0; clearedFaintPx++; }
    else if (a >= alphaSolid && a < 255) { data[i * 4 + 3] = 255; solidifiedPx++; }
  }
  // separate opaque specks: 8-connected components of non-clear pixels, removed when speckMaxPx or smaller
  const label = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let specksRemoved = 0, speckPxRemoved = 0, partsKept = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || data[s * 4 + 3] === 0) continue;
    let top = 0, size = 0; stack[top++] = s; label[s] = s;
    const members = [];
    while (top) {
      const i = stack[--top]; size++; if (size <= speckMaxPx + 1) members.push(i);
      const x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy)) continue;
          const j = yy * W + xx; if (label[j] === -1 && data[j * 4 + 3] !== 0) { label[j] = s; stack[top++] = j; } } }
    }
    if (size <= speckMaxPx) { for (const i of members) data[i * 4 + 3] = 0; specksRemoved++; speckPxRemoved += size; } else partsKept++;
  }
  // colour under fully clear pixels zeroed; bounding box of what is left
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] === 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; continue; }
    const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bbox = x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  return { bbox, facts: { clearedFaintPx, solidifiedPx, specksRemoved, speckPxRemoved, partsKept, ...(enc ? { enclosed: enc } : {}) } };
}

// the default upscaler: Real-ESRGAN (alpha separately) when configured and installed, else Lanczos with a warning the gate refuses
export async function defaultUpscaler(input, outW, outH, { cfg = defaultConfig, log = null } = {}) {
  const c = esrganCfg(cfg);
  const data = await sharp(input).ensureAlpha().resize(outW, outH, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).raw().toBuffer();
  return { data, facts: { method: 'lanczos3' }, warnings: [c.method === 'realesrgan' ? 'Real-ESRGAN is configured but this build was not given the engine\'s pinned upscaler (config/engine.json upscale): Lanczos used' : 'upscale method is "' + c.method + '", not realesrgan'] };
}

// one raw file -> one finished file of exactly W x H. Returns the per-file record (or { ok: false, reason }).
export async function processFile({ input, output, widthPx: T_W, heightPx: T_H, cfg = defaultConfig, upscaler = defaultUpscaler, tmpDir, log = null }) {
  const b = cfg.digital.build, name = path.basename(input), inBuf = fs.readFileSync(input), meta = await sharp(inBuf).metadata();
  if (meta.format !== 'png') return { ok: false, reason: name + ' is ' + meta.format + ', not PNG: the Designer must save transparent PNGs' };
  if (!meta.hasAlpha) return { ok: false, reason: name + ' has no alpha channel: the generator did not draw a transparent background' };
  const { data, info } = await sharp(inBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), W = info.width, H = info.height;
  let clear0 = 0; for (let i = 3; i < data.length; i += 4) if (data[i] === 0) clear0++;
  if (!clear0) return { ok: false, reason: name + ' has no fully clear pixels: the background is not transparent' };
  const cl = cleanAlpha(data, W, H, b.cleanup);
  if (!cl.bbox) return { ok: false, reason: name + ' is blank after clean-up' };
  // near-white fills of the cleaned artwork at the generator's size (the palette rule; the package gate applies it to palette.products)
  const pal = b.cleanup.palette ? { ...PALETTE_DEFAULTS, ...b.cleanup.palette } : null, nearWhite = pal ? nearWhiteFills(data, W, H, pal) : null;
  const { left, top, width: bw, height: bh } = cl.bbox, pad = b.paddingPct / 100;
  const innerW = Math.round(T_W * (1 - 2 * pad)), innerH = Math.round(T_H * (1 - 2 * pad)), s = Math.min(innerW / bw, innerH / bh);
  const outW = Math.max(1, Math.round(bw * s)), outH = Math.max(1, Math.round(bh * s));
  const trimmed = path.join(tmpDir, 'trim-' + name);
  await sharp(data, { raw: { width: W, height: H, channels: 4 } }).extract({ left, top, width: bw, height: bh }).png({ compressionLevel: 1 }).toFile(dataJail(trimmed));
  const up = await upscaler(trimmed, outW, outH, { cfg, log });
  const ud = Buffer.from(up.data); let postClearedPx = 0;
  for (let i = 0; i < outW * outH; i++) { const a = ud[i * 4 + 3]; if (a > 0 && a < b.cleanup.alphaFloor) { ud[i * 4 + 3] = 0; postClearedPx++; } if (ud[i * 4 + 3] === 0) { ud[i * 4] = 0; ud[i * 4 + 1] = 0; ud[i * 4 + 2] = 0; } }
  const padLeft = Math.floor((T_W - outW) / 2), padTop = Math.floor((T_H - outH) / 2);
  const outBuf = await sharp({ create: { width: T_W, height: T_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: ud, raw: { width: outW, height: outH, channels: 4 }, left: padLeft, top: padTop }]).png({ compressionLevel: 9, adaptiveFiltering: !!(b.optimise && b.optimise.lossless) }).toBuffer();
  fs.writeFileSync(dataJail(output), outBuf);
  const warnings = [...(up.warnings || [])];
  if (s > (b.maxUpscaleWarn || 4)) warnings.push(name + ': the artwork is enlarged ' + s.toFixed(2) + 'x (over ' + (b.maxUpscaleWarn || 4) + 'x): check it is not soft');
  // the finished artwork re-checked for enclosed background-like regions of ANY outline share (the package gate refuses a file that has one)
  const encOpts = b.cleanup.enclosed === false ? null : { ...ENCLOSED_DEFAULTS, ...(b.cleanup.enclosed || {}) }, { enclosed: enc, ...cf } = cl.facts;
  const remaining = encOpts ? enclosedBackgroundRegions(ud, outW, outH, encOpts, s).map(({ members, ...r }) => r) : null;
  if (remaining && remaining.length) warnings.push(name + ': ' + remaining.length + ' enclosed background-like region(s) left after the clean-up (content px ' + remaining.map((r) => r.box.join(',')).join('; ') + '): a hole that is not see-through?');
  if (enc && enc.removed.nonBackgroundPx) warnings.push(name + ': the clean-up made ' + enc.removed.nonBackgroundPx + ' px transparent that were not background-coloured in the generated file (box ' + enc.removed.nonBackgroundBox.join(',') + '): part of the drawing removed?');
  if (nearWhite && nearWhite.length) warnings.push(name + ': ' + nearWhite.length + ' near-white fill(s), pure white or grey-white (generator px ' + nearWhite.map((r) => r.box.join(',')).join('; ') + ')');
  const { products: _p, ...palThreshold } = pal || {};
  return { ok: true, record: { name, input: { sha256: sha256(inBuf), widthPx: W, heightPx: H },
    cleanup: { ...cf, trimmedPx: [bw, bh], trimBox: cl.bbox, postUpscaleClearedPx: postClearedPx, ...(encOpts ? { enclosed: { threshold: encOpts, ...enc, remainingAfterBuild: remaining } } : {}),
      ...(pal ? { palette: { threshold: palThreshold, nearWhiteFills: nearWhite } } : {}) },
    upscale: { ...up.facts, scale: Number(s.toFixed(3)), contentPx: [outW, outH] },
    padding: { pct: b.paddingPct, leftPx: padLeft, topPx: padTop },
    output: { sha256: sha256(outBuf), widthPx: T_W, heightPx: T_H, bytes: outBuf.length }, warnings } };
}

// premultiplied RGBA PSNR (dB) and largest channel error of b against a (same size): how far a palette version is from the lossless file
export async function pngDifference(a, b) {
  const [x, y] = await Promise.all([a, b].map((buf) => sharp(buf).ensureAlpha().raw().toBuffer()));
  if (x.length !== y.length) return { psnrDb: 0, maxErr: 255 };
  let se = 0, mx = 0;
  for (let i = 0; i < x.length; i += 4) for (let c = 0; c < 4; c++) {
    const d = c < 3 ? Math.abs(x[i + c] * x[i + 3] - y[i + c] * y[i + 3]) / 255 : Math.abs(x[i + 3] - y[i + 3]);
    se += d * d; if (d > mx) mx = d;
  }
  const mse = se / x.length;
  return { psnrDb: mse === 0 ? Infinity : Number((10 * Math.log10(255 * 255 / mse)).toFixed(2)), maxErr: Math.round(mx) };
}

// Etsy's 20 MB per file (owner exception 2026-10-17): the files are already lossless-optimised; when the zip is still over
// optimise.paletteIfZipOverBytes, each file is palette-reduced (libimagequant) unless that drops it below optimise.minPsnrDb.
// Rewrites build/<name> and its record (output sha256 and bytes) so the zip, the record and the files stay one set.
export async function optimiseForZip(records, bufs, bd, cfg = defaultConfig) {
  const o = cfg.digital.build.optimise, warnings = [];
  const losslessZip = writeZip(records.map((r, i) => ({ name: r.name, data: bufs[i] }))).length;
  const facts = { lossless: !!(o && o.lossless), zipLosslessBytes: losslessZip, palette: false };
  for (const r of records) r.optimise = { method: facts.lossless ? 'lossless' : 'none', bytes: r.output.bytes };
  if (!o || !(o.paletteIfZipOverBytes > 0) || losslessZip <= o.paletteIfZipOverBytes) return { bufs, facts, warnings };
  facts.palette = true; facts.paletteIfZipOverBytes = o.paletteIfZipOverBytes;
  const out = [];
  for (const [i, r] of records.entries()) {
    const p = o.palette || {}, pq = await sharp(bufs[i]).png({ palette: true, quality: p.quality ?? 100, colours: p.colours ?? 256, dither: p.dither ?? 1.0, effort: p.effort ?? 10, compressionLevel: 9 }).toBuffer();
    const d = await pngDifference(bufs[i], pq), m = await sharp(pq).metadata();
    if (m.width !== r.output.widthPx || m.height !== r.output.heightPx || !m.hasAlpha) { warnings.push(r.name + ': the palette version changed the size or lost alpha; the lossless file is kept'); out.push(bufs[i]); continue; }
    if (d.psnrDb < (o.minPsnrDb ?? 40)) { r.optimise = { ...r.optimise, paletteRejected: d }; warnings.push(r.name + ': the palette version is ' + d.psnrDb + ' dB (under ' + (o.minPsnrDb ?? 40) + ' dB); the lossless file is kept'); out.push(bufs[i]); continue; }
    fs.writeFileSync(dataJail(path.join(bd, r.name)), pq);
    r.optimise = { method: 'palette', losslessBytes: bufs[i].length, bytes: pq.length, ...d };
    r.output = { ...r.output, sha256: sha256(pq), bytes: pq.length };
    out.push(pq);
  }
  return { bufs: out, facts, warnings };
}

// a grid of every finished file on a plain light background, no text
export async function buildPreview(buffers, cfg = defaultConfig) {
  const pv = cfg.digital.build.preview, W = pv.widthPx, H = pv.heightPx, n = buffers.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * W / H))), rows = Math.max(1, Math.ceil(n / cols)), cell = Math.floor(Math.min(W / cols, H / rows));
  const m = Math.round(cell * 0.06), thumb = cell - 2 * m, x0 = Math.floor((W - cols * cell) / 2), y0 = Math.floor((H - rows * cell) / 2), layers = [];
  for (let i = 0; i < n; i++) {
    const t = await sharp(buffers[i]).resize(thumb, thumb, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    layers.push({ input: t, left: x0 + (i % cols) * cell + m, top: y0 + Math.floor(i / cols) * cell + m });
  }
  const hex = /^#?([0-9a-f]{6})$/i.exec(pv.background || '#ffffff')[1], bg = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  return sharp({ create: { width: W, height: H, channels: 3, background: bg } }).composite(layers).jpeg({ quality: pv.quality || 90, chromaSubsampling: '4:4:4' }).toBuffer();
}

// the raw files and the settings that decide the build: same key -> same build
export function buildInputs({ roomDir, id, n, product, cfg = defaultConfig }) {
  const rd = path.join(setDirOf(roomDir, id, n), 'raw');
  const names = fs.existsSync(rd) ? fs.readdirSync(rd, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : [];
  const inputs = names.map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(rd, name))) }));
  const spec = (product.deliverables.files || []).map((f) => ({ format: f.format, widthPx: f.widthPx, heightPx: f.heightPx }));
  const u = esrganCfg(cfg), settings = { version: BUILD_VERSION, cleanup: cfg.digital.build.cleanup, paddingPct: cfg.digital.build.paddingPct, preview: cfg.digital.build.preview,
    upscale: { method: u.method, model: u.model, nativeScale: u.nativeScale, alphaMethod: u.alphaMethod || 'lanczos' }, spec, zipName: zipNameFor(id), prep: product.deliverables.prep || null,
    optimise: cfg.digital.build.optimise || null };
  return { rawDir: rd, inputs, settings, key: sha256(JSON.stringify({ inputs, settings })) };
}

// cheap: is set-vN's build current for its raw files and settings, with every output still on disk as recorded? (hashes, no image work)
export function buildStatus({ roomDir, id, n, product, cfg = defaultConfig }) {
  const sd = setDirOf(roomDir, id, n), bf = path.join(sd, 'build.json');
  if (!fs.existsSync(bf)) return { current: false, reason: 'set-v' + n + ' has not been built (no build.json)' };
  let rec; try { rec = JSON.parse(fs.readFileSync(bf, 'utf8')); } catch (_) { return { current: false, reason: 'build.json is not valid JSON' }; }
  const { key } = buildInputs({ roomDir, id, n, product, cfg });
  if (rec.key !== key) return { current: false, reason: 'the raw files or build settings changed since set-v' + n + ' was built', record: rec };
  const outs = [...(rec.files || []).map((f) => [path.join(sd, 'build', f.name), f.output.sha256]), [path.join(sd, 'files', rec.zip.name), rec.zip.sha256], [path.join(sd, rec.preview.path || path.join('files', rec.preview.name)), rec.preview.sha256]];
  for (const [f, h] of outs) if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== h) return { current: false, reason: path.relative(sd, f).replace(/\\/g, '/') + ' is missing or differs from build.json', record: rec };
  return { current: true, record: rec };
}

const writeAtomic = (file, buf) => { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(dataJail(tmp), buf); fs.renameSync(dataJail(tmp), dataJail(file)); };

export async function buildDigitalSet({ roomDir, id, n, cfg = defaultConfig, products = null, upscaler = defaultUpscaler, log = { info() {}, warn() {}, error() {} } }) {
  const sd = setDirOf(roomDir, id, n), { key: pk, product } = productFor(roomDir, id, products);
  if (!product || product.digital !== true) return { ok: false, reason: 'brief product_type "' + pk + '" is not a digital product in products.json' };
  if (!isPackaged(product)) return { ok: true, action: 'not-packaged', note: 'product "' + pk + '" has no deliverables.package: the Designer writes files/ directly' };
  const st = buildStatus({ roomDir, id, n, product, cfg });
  if (st.current) { log.info('build current: nothing to do', { id, set: n }); return { ok: true, action: 'unchanged', record: st.record }; }
  const bi = buildInputs({ roomDir, id, n, product, cfg }), spec = product.deliverables.files;
  if (!bi.inputs.length) return { ok: false, reason: 'jobs/' + id + '/set-v' + n + '/raw/ has no files: the Designer writes the generated images there' };
  const bad = bi.inputs.filter((f) => !SAFE_NAME.test(f.name) || !/\.png$/i.test(f.name)).map((f) => f.name);
  if (bad.length) return { ok: false, reason: 'raw file names must be plain lowercase PNG names (e.g. 01-mug.png): ' + bad.join(', ') };
  if (bi.inputs.length !== spec.length) return { ok: false, reason: 'raw/ has ' + bi.inputs.length + ' file(s), the product spec lists ' + spec.length };
  // clear what an earlier build of THIS set wrote (only the files its record names), then build into place
  const old = (() => { try { return JSON.parse(fs.readFileSync(path.join(sd, 'build.json'), 'utf8')); } catch (_) { return null; } })();
  if (old) for (const f of [...(old.files || []).map((x) => path.join(sd, 'build', x.name)), old.zip && path.join(sd, 'files', old.zip.name), old.preview && path.join(sd, old.preview.path || path.join('files', old.preview.name))].filter(Boolean)) fs.rmSync(dataJail(f), { force: true });
  fs.rmSync(dataJail(path.join(sd, 'build.json')), { force: true });
  const bd = path.join(sd, 'build'), fd = path.join(sd, 'files'), ld = path.join(sd, previewDirOf(cfg)), tmpDir = path.join(sd, '.tmp-build-' + process.pid);
  for (const d of [tmpDir, bd, fd, ld]) fs.mkdirSync(dataJail(d), { recursive: true });
  const records = [], warnings = [];
  try {
    for (const [i, f] of bi.inputs.entries()) {
      const r = await processFile({ input: path.join(bi.rawDir, f.name), output: path.join(bd, f.name), widthPx: spec[i].widthPx, heightPx: spec[i].heightPx, cfg, upscaler, tmpDir, log });
      if (!r.ok) return { ok: false, reason: r.reason };
      records.push(r.record); warnings.push(...r.record.warnings);
      log.info('built ' + f.name, { scale: r.record.upscale.scale, method: r.record.upscale.method, specksRemoved: r.record.cleanup.specksRemoved, warnings: r.record.warnings });
    }
  } finally { fs.rmSync(dataJail(tmpDir), { recursive: true, force: true }); }
  const opt = await optimiseForZip(records, records.map((r) => fs.readFileSync(path.join(bd, r.name))), bd, cfg), bufs = opt.bufs;
  warnings.push(...opt.warnings);
  if (opt.facts.palette) log.info('zip over ' + (opt.facts.paletteIfZipOverBytes / 1e6) + ' MB after lossless optimisation (' + (opt.facts.zipLosslessBytes / 1e6).toFixed(2) + ' MB): palette-reduced', { files: records.map((r) => ({ name: r.name, method: r.optimise.method, bytes: r.optimise.bytes, psnrDb: r.optimise.psnrDb })) });
  const zip = writeZip(records.map((r, i) => ({ name: r.name, data: bufs[i] }))), zipName = bi.settings.zipName;
  writeAtomic(path.join(fd, zipName), zip);
  const pv = await buildPreview(bufs, cfg), pvc = cfg.digital.build.preview, pvPath = previewDirOf(cfg) + '/' + pvc.name;
  writeAtomic(path.join(ld, pvc.name), pv);
  const lim = cfg.digital.etsyFileLimits;
  for (const [nm, b] of [[zipName, zip]]) if (b.length > lim.maxFileBytes) warnings.push(nm + ' is ' + (b.length / 1e6).toFixed(1) + ' MB: over Etsy\'s ' + lim.maxFileMbAsStated + ' MB per file (the package gate will refuse it)');
  const record = { listingId: id, set: n, productKey: pk, key: bi.key, builtBy: 'engine build step, src/engine/lib/digital-build.mjs (no model)', settings: bi.settings, inputs: bi.inputs, files: records,
    zip: { name: zipName, bytes: zip.length, sha256: sha256(zip), entries: records.map((r) => r.name) }, optimise: { ...opt.facts, zipBytes: zip.length }, preview: { name: pvc.name, path: pvPath, use: 'listing photo only, not a download', bytes: pv.length, sha256: sha256(pv), widthPx: pvc.widthPx, heightPx: pvc.heightPx }, warnings };
  writeAtomic(path.join(sd, 'build.json'), JSON.stringify(record, null, 1) + '\n');
  log.info('set built ' + id + '/set-v' + n, { files: records.length, zipMB: Number((zip.length / 1e6).toFixed(2)), previewKB: Math.round(pv.length / 1e3), warnings });
  return { ok: true, action: 'built', record };
}
