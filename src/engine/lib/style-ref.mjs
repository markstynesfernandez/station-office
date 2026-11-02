// PORTED from Virtual-workers/station/scripts/lib/style-ref.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 19:42), source sha256 dc6fcc0aa19e9e5447f3ca38f2e787e3d6c6602acbddb884d525a8bac3d0b9f3.
//   5th moment: the whole library: the cleaned version of file 1 (writeCleanedVersion, cleanedVersionOf, fileOneVersion), per-version decisions (recordDecision), approvedRef refusing a raw reference when a cleaned version exists, ensureStyleRefInSet, makeReviewImages, styleRefProblems
//   change: file writes go through the engine's data jail (dataJail from ../store/active.mjs)
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   change: the review build's temp folder is inside the set folder (set-vN/.tmp-styleref-<pid>/), not the OS temp
//   change: the record notes name the engine modules
//   change (owner, 18/10/2026, DECISIONS.md "E6 wrap-up", the file-1 gate): a QA DESIGN pass on file 1 is an approval of its own
//           (decidedBy "qa-design", with the qaPass of jobs/<id>/qa/file1-pass<k>.json); approvedRef, and so the package gate, accept it
//           only while that QA record on disk says approved for the same set and the same sha256. The owner may still decide on top of it
//           (the latest decision counts). A job whose brief or routine sets ownerFile1: true keeps the owner's pause (orchestrator).
//   NOT ported: the first-file run mode itself (run-line --first-file) and the reference image sent to the image model; the engine builds its own
//   (E6 c0, 17/10/2026: orchestrator.mjs styleRefDesigner, tools/index.mjs image_generate) on this library's records
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// style-ref.mjs (lib) — the owner-approved STYLE REFERENCE of a packaged digital set (owner go 2026-10-16). For a product whose spec has
// styleReference.ownerOk (products.json), file 1 is generated ALONE first (run-line --first-file) and the run stops before QA DESIGN. The station
// builds that one file as it would be delivered (clean-up, Real-ESRGAN, padding: lib/digital-build.mjs) and flattens it onto a light and a dark
// background for the owner (set-vN/review/). The owner's decision is recorded by scripts/style-ref.mjs in work/<id>/style-ref.json, against the
// sha256 of the exact file decided on (the raw file, or its cleaned version below). Only after an approval does the rest of the set run (run-line --after-style-ok): the Designer passes that file to
// the image model as reference_image (local StarNet patch, patches/starnet-image-style-reference.patch), and the station copies the approved bytes
// into every later set's raw/ as file 1. The package gate refuses a set whose file 1 is not the approved one. No model here.
// CLEANED VERSION (owner, 2026-10-17): when the clean-up makes an enclosed area of file 1 transparent (a handle hole painted in), the cleaned
// file at the generator's size is a version of file 1 of its own: set-vN/cleaned/<name>, with its own sha256 and record (<base>.cleaned.json).
// The review images show it, the owner decides on it (a decision on the raw file stays attached to the raw file), and it, never the raw file,
// is the style reference and the file 1 copied into later sets.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config as defaultConfig, sha256 } from './common.mjs';
import { SAFE_NAME } from './zip.mjs';
import { processFile, defaultUpscaler, cleanAlpha } from './digital-build.mjs';
import { dataJail } from '../store/active.mjs';

export const usesStyleRef = (product) => !!(product && product.styleReference && product.styleReference.ownerOk === true);
export const recordFile = (roomDir, id) => path.join(roomDir, 'jobs', id, 'style-ref.json');
export const FIRST_NAME = /^01-[a-z0-9][a-z0-9-]*\.png$/;
const setDir = (roomDir, id, n) => path.join(roomDir, 'jobs', id, 'set-v' + n);
const rawNames = (rd) => (fs.existsSync(rd) ? fs.readdirSync(rd, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : []);

// { ok, record, current }: current = the latest decision ({ set, name, file, sha256, status: approved|rejected, decidedBy, date, reason? }) or null
export function readStyleRef(roomDir, id) {
  const f = recordFile(roomDir, id); if (!fs.existsSync(f)) return { ok: true, record: null, current: null };
  let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { ok: false, reason: 'jobs/' + id + '/style-ref.json is not valid JSON' }; }
  const ds = Array.isArray(rec.decisions) ? rec.decisions : [];
  return { ok: true, record: rec, current: ds.length ? ds[ds.length - 1] : null };
}

export const DECIDERS = ['owner', 'qa-design'];
// a "qa-design" decision stands only on its QA record: qa/file1-pass<k>.json approved, for that set and those exact bytes
export function qaFileOneProblem(roomDir, id, d) {
  const k = Number(d && d.qaPass), f = path.join(roomDir, 'jobs', id, 'qa', 'file1-pass' + k + '.json');
  if (!Number.isInteger(k) || k < 1) return 'a QA DESIGN approval of file 1 must name its qaPass';
  let q; try { q = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return 'qa/file1-pass' + k + '.json is missing or not valid JSON'; }
  if (q.verdict !== 'approved') return 'qa/file1-pass' + k + '.json is not an approval (' + q.verdict + ')';
  if (q.set !== d.set || !q.decides || q.decides.sha256 !== d.sha256) return 'qa/file1-pass' + k + '.json approved another file 1 (set or sha256 differs)';
  return null;
}

// the approved reference, checked against the bytes on disk: { ok, ref } or { ok: false, reason }
export function approvedRef(roomDir, id) {
  const r = readStyleRef(roomDir, id); if (!r.ok) return r;
  if (r.current && r.current.status === 'approved' && r.current.decidedBy === 'qa-design') { const qp = qaFileOneProblem(roomDir, id, r.current); if (qp) return { ok: false, reason: 'the QA DESIGN approval of file 1 does not stand: ' + qp }; }
  if (!r.current) return { ok: false, reason: 'no style reference decision for ' + id + ': run node scripts/run-line.mjs ' + id + ' --first-file, then the owner decides (node scripts/style-ref.mjs ' + id + ' --approve | --reject "reason")' };
  if (r.current.status !== 'approved' || !DECIDERS.includes(r.current.decidedBy)) return { ok: false, reason: 'the latest style reference decision is "' + r.current.status + '"' + (r.current.reason ? ' (' + r.current.reason + ')' : '') + ': run --first-file again for a new file 1' };
  const f = path.join(roomDir, r.current.file);
  if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== r.current.sha256) return { ok: false, reason: r.current.file + ' is missing or differs from the file the owner approved (style-ref.json sha256)' };
  if ((r.current.version || 'raw') === 'raw' && fs.existsSync(cleanedPaths(roomDir, id, r.current.set, r.current.name).file)) return { ok: false, reason: 'file 1 of set-v' + r.current.set + ' has a cleaned version (jobs/' + id + '/set-v' + r.current.set + '/cleaned/' + r.current.name + '): the raw file is never the style reference; the owner decides on the cleaned version (node scripts/style-ref.mjs ' + id + ' --approve | --reject "reason")' };
  return { ok: true, ref: r.current };
}

const cleanedPaths = (roomDir, id, n, name) => { const d = path.join(setDir(roomDir, id, n), 'cleaned'); return { dir: d, file: path.join(d, name), record: path.join(d, name.replace(/\.png$/i, '') + '.cleaned.json'), rel: 'jobs/' + id + '/set-v' + n + '/cleaned/' + name }; };

// the cleaned version of a set's raw file 1, checked against its record and the raw file: { ok, cleaned: { file, sha256 } | null } or { ok: false, reason }
export function cleanedVersionOf(roomDir, id, n, name, rawSha256) {
  const c = cleanedPaths(roomDir, id, n, name);
  if (!fs.existsSync(c.file) && !fs.existsSync(c.record)) return { ok: true, cleaned: null };
  let rec; try { rec = JSON.parse(fs.readFileSync(c.record, 'utf8')); } catch (_) { rec = null; }
  if (!rec || !fs.existsSync(c.file)) return { ok: false, reason: 'set-v' + n + '/cleaned/ holds ' + name + ' without its record (or the reverse): rewrite it with the review images' };
  if (!rec.raw || rec.raw.sha256 !== rawSha256) return { ok: false, reason: 'set-v' + n + '/cleaned/' + name + ' was made from a different raw file: rewrite it with the review images' };
  const sh = sha256(fs.readFileSync(c.file));
  if (!rec.cleaned || rec.cleaned.sha256 !== sh) return { ok: false, reason: 'set-v' + n + '/cleaned/' + name + ' differs from its record (sha256)' };
  return { ok: true, cleaned: { file: c.rel, sha256: sh } };
}

// the version of file 1 the owner decides on: the cleaned version when there is one, else the raw file
export function fileOneVersion(roomDir, id, n) {
  const ff = firstFileOf(roomDir, id, n); if (!ff.ok) return ff;
  const cv = cleanedVersionOf(roomDir, id, n, ff.name, ff.sha256); if (!cv.ok) return cv;
  return cv.cleaned ? { ok: true, version: 'cleaned', name: ff.name, file: cv.cleaned.file, sha256: cv.cleaned.sha256, raw: { file: ff.file, sha256: ff.sha256 } } : { ok: true, version: 'raw', name: ff.name, file: ff.file, sha256: ff.sha256 };
}

// file 1 cleaned at the generator's size (the build's clean-up, no trim, no upscale). Written to set-vN/cleaned/ only when the clean-up made an
// enclosed area transparent; otherwise the raw file is file 1's only version. Idempotent.
export async function writeCleanedVersion({ roomDir, id, n, name, cfg = defaultConfig, log = null }) {
  const rawRel = 'jobs/' + id + '/set-v' + n + '/raw/' + name, rawBuf = fs.readFileSync(path.join(roomDir, rawRel)), c = cleanedPaths(roomDir, id, n, name);
  const { data, info } = await sharp(rawBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cl = cleanAlpha(data, info.width, info.height, cfg.digital.build.cleanup), enc = cl.facts.enclosed;
  if (!enc || !enc.cleared.length) {
    if (fs.existsSync(c.file) && log) log.warn('set-v' + n + '/cleaned/' + name + ' exists but the clean-up no longer clears an enclosed area: left as it is', { id });
    return { ok: true, version: 'raw', action: 'none' };
  }
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  fs.mkdirSync(dataJail(c.dir), { recursive: true });
  const action = writeIfDifferent(c.file, buf), { enclosed: _e, ...facts } = cl.facts;
  writeIfDifferent(c.record, Buffer.from(JSON.stringify({ listingId: id, set: n, name, version: 'cleaned', note: 'file 1 after the station clean-up at the generator\'s size (an enclosed area made transparent): a version of file 1 of its own; the owner decides on it and it is the style reference. Written by src/engine/lib/style-ref.mjs',
    raw: { file: rawRel, sha256: sha256(rawBuf) }, cleaned: { file: c.rel, sha256: sha256(buf), widthPx: info.width, heightPx: info.height }, cleanup: { ...facts, enclosed: enc }, settings: cfg.digital.build.cleanup }, null, 1) + '\n'));
  if (log) log.info('cleaned version of file 1 ' + action, { id, set: n, file: c.rel, cleared: enc.cleared.length, removedPx: enc.removed && enc.removed.px });
  return { ok: true, version: 'cleaned', action, file: c.rel, sha256: sha256(buf) };
}

// the single raw file a first-file run leaves in set-vN/raw/
export function firstFileOf(roomDir, id, n) {
  const sd = setDir(roomDir, id, n), names = rawNames(path.join(sd, 'raw'));
  if (names.length !== 1) return { ok: false, reason: 'jobs/' + id + '/set-v' + n + '/raw/ has ' + names.length + ' file(s); a first-file run makes exactly one' + (names.length ? ' (' + names.join(', ') + ')' : '') };
  const name = names[0];
  if (!FIRST_NAME.test(name) || !SAFE_NAME.test(name)) return { ok: false, reason: 'file 1 must be a plain lowercase PNG name starting 01- (e.g. 01-steaming-mug.png): ' + name };
  if (fs.existsSync(path.join(sd, 'files')) || fs.existsSync(path.join(sd, 'build.json'))) return { ok: false, reason: 'set-v' + n + ' already has files/ or build.json: a first-file set holds raw/ and design.md only' };
  return { ok: true, name, file: 'jobs/' + id + '/set-v' + n + '/raw/' + name, sha256: sha256(fs.readFileSync(path.join(sd, 'raw', name))) };
}

const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) throw new Error('not a #rrggbb colour: ' + h); return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) }; };
const writeIfDifferent = (file, buf) => { if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return 'unchanged'; fs.writeFileSync(dataJail(file), buf); return 'written'; };

// file 1 built as it would be delivered (spec file 1's size), then flattened onto each review background. Writes set-vN/review/, and
// set-vN/cleaned/ when the clean-up makes a cleaned version (the review then shows that version: the one the owner decides on).
export async function makeReviewImages({ roomDir, id, n, name, product, cfg = defaultConfig, upscaler = defaultUpscaler, log = null }) {
  const sd = setDir(roomDir, id, n), rv = path.join(sd, 'review'), spec = product.deliverables.files[0], bgs = cfg.digital.styleReference.review.backgrounds;
  fs.mkdirSync(dataJail(rv), { recursive: true });
  await writeCleanedVersion({ roomDir, id, n, name, cfg, log });
  const v = fileOneVersion(roomDir, id, n); if (!v.ok) return { ok: false, reason: v.reason };
  const tmpDir = path.join(sd, '.tmp-styleref-' + process.pid), built = path.join(tmpDir, name);
  fs.mkdirSync(dataJail(tmpDir), { recursive: true });
  let r;
  try { r = await processFile({ input: path.join(roomDir, v.file), output: built, widthPx: spec.widthPx, heightPx: spec.heightPx, cfg, upscaler, tmpDir, log }); if (r.ok) r.buf = fs.readFileSync(built); }
  finally { fs.rmSync(dataJail(tmpDir), { recursive: true, force: true }); }
  if (!r.ok) return { ok: false, reason: r.reason };
  const raw = await sharp(path.join(sd, 'raw', name)).metadata(), base = name.replace(/\.png$/i, ''), review = {};
  for (const [label, hex] of Object.entries(bgs)) {
    const out = await sharp(r.buf).flatten({ background: hexRgb(hex) }).png({ compressionLevel: 9 }).toBuffer(), file = path.join(rv, base + '-on-' + label + '.png');
    review[label] = { file: 'jobs/' + id + '/set-v' + n + '/review/' + path.basename(file), background: hex, action: writeIfDifferent(file, out) };
  }
  const decides = { version: v.version, file: v.file, sha256: v.sha256 };
  const facts = { decides, raw: { widthPx: raw.width, heightPx: raw.height }, built: r.record.output, cleanup: r.record.cleanup, upscale: r.record.upscale, warnings: r.record.warnings };
  writeIfDifferent(path.join(rv, base + '.review.json'), Buffer.from(JSON.stringify({ listingId: id, set: n, name, note: 'owner review images: file 1 (the version in "decides") built as it would be delivered, flattened; not deliverables', ...facts, review }, null, 1) + '\n'));
  return { ok: true, review, ...facts };
}

// the owner's decision on file 1 of the newest first-file set (its cleaned version when there is one), appended to style-ref.json (history
// kept). One decision per version: a set's cleaned version may be decided after a decision on its raw file (that one stays on the raw file);
// anything else already decided needs a new --first-file run.
export function recordDecision({ roomDir, id, status, reason = '', date, decidedBy = 'owner', n, qaPass = null }) {
  if (!['approved', 'rejected'].includes(status)) return { ok: false, reason: 'status must be approved or rejected' };
  if (!DECIDERS.includes(decidedBy)) return { ok: false, reason: 'decidedBy must be ' + DECIDERS.join(' or ') };
  if (decidedBy === 'qa-design' && status !== 'approved') return { ok: false, reason: 'a QA DESIGN decision on file 1 is recorded only as an approval (a revise draws file 1 again)' };
  if (status === 'rejected' && !String(reason).trim()) return { ok: false, reason: 'a rejection needs a reason (it goes into the next --first-file run)' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, reason: 'date must be YYYY-MM-DD' };
  const v = fileOneVersion(roomDir, id, n); if (!v.ok) return v;
  const r = readStyleRef(roomDir, id); if (!r.ok) return r;
  const decisions = r.record && Array.isArray(r.record.decisions) ? r.record.decisions : [];
  if (decidedBy === 'qa-design') { const qp = qaFileOneProblem(roomDir, id, { set: n, sha256: v.sha256, qaPass }); if (qp) return { ok: false, reason: qp }; }
  // the owner may decide on a file 1 that QA DESIGN approved (approve it as the owner, or reject it): the latest decision counts
  const ownerOnQa = decidedBy === 'owner' && decisions.length && decisions[decisions.length - 1].set === n && decisions[decisions.length - 1].sha256 === v.sha256 && decisions[decisions.length - 1].decidedBy === 'qa-design';
  const same = ownerOnQa ? null : decisions.find((d) => d.set === n && d.sha256 === v.sha256 && (d.decidedBy || 'owner') === decidedBy), other = ownerOnQa ? null : decisions.find((d) => d.set === n && d.sha256 !== v.sha256);
  if (same) return same.status === status ? { ok: true, action: 'unchanged', decision: same } : { ok: false, reason: 'set-v' + n + ' file 1 (' + (same.version || 'raw') + ' version) already has a decision (' + same.status + ' ' + same.date + '): a new file 1 needs a new --first-file run' };
  if (other && !(v.version === 'cleaned' && (other.version || 'raw') === 'raw' && other.sha256 === v.raw.sha256)) return { ok: false, reason: 'set-v' + n + ' already has a decision (' + other.status + ' ' + other.date + ') on another file 1: a new file 1 needs a new --first-file run' };
  const decision = { set: n, version: v.version, name: v.name, file: v.file, sha256: v.sha256, ...(v.raw ? { rawFile: v.raw.file, rawSha256: v.raw.sha256 } : {}), status, decidedBy, ...(decidedBy === 'qa-design' ? { qaPass: Number(qaPass) } : {}), date, ...(status === 'rejected' ? { reason: String(reason).trim() } : {}) };
  const rec = { listingId: id, note: 'decisions on file 1 of this listing (the style reference): the owner\'s, or a QA DESIGN file-1 approval (decidedBy qa-design, owner 18/10/2026); the latest decision counts. Written by src/engine/owner.mjs (styleRefDecision) and the orchestrator (the file-1 gate)', decisions: [...decisions, decision] };
  fs.writeFileSync(dataJail(recordFile(roomDir, id)), JSON.stringify(rec, null, 1) + '\n');
  return { ok: true, action: 'recorded', decision };
}

// before the build of any later set: raw/ must hold the approved file 1 byte for byte. Copies it in when absent (the Designer never draws file 1
// again); refuses a different file under that name or another 01- file.
export function ensureStyleRefInSet({ roomDir, id, n, log = null }) {
  const a = approvedRef(roomDir, id); if (!a.ok) return a;
  if (n <= a.ref.set) return { ok: false, reason: 'set-v' + n + ' is not newer than the approved first-file set (set-v' + a.ref.set + ')' };
  const rd = path.join(setDir(roomDir, id, n), 'raw'), dest = path.join(rd, a.ref.name);
  const others = rawNames(rd).filter((f) => /^01[-_.]/.test(f) && f !== a.ref.name);
  if (others.length) return { ok: false, reason: 'raw/ has another file 1 (' + others.join(', ') + '): file 1 is the owner-approved ' + a.ref.name + ', copied by the station' };
  if (fs.existsSync(dest)) {
    if (sha256(fs.readFileSync(dest)) !== a.ref.sha256) return { ok: false, reason: 'raw/' + a.ref.name + ' is not the owner-approved file (sha256 differs): the Designer must not draw file 1' };
    return { ok: true, action: 'present', ref: a.ref };
  }
  fs.mkdirSync(dataJail(rd), { recursive: true });
  fs.copyFileSync(path.join(roomDir, a.ref.file), dataJail(dest));
  if (log) log.info('style reference copied into set-v' + n + '/raw/', { id, name: a.ref.name, from: a.ref.file });
  return { ok: true, action: 'copied', ref: a.ref };
}

// package gate: a product with a style reference delivers the approved file 1 (the build's inputs carry its raw sha256)
export function styleRefProblems({ roomDir, id, product, build }) {
  if (!usesStyleRef(product)) return [];
  const a = approvedRef(roomDir, id); if (!a.ok) return [a.reason];
  const inp = ((build && build.inputs) || []).find((x) => x.name === a.ref.name);
  if (!inp) return ['the build has no ' + a.ref.name + ': file 1 must be the owner-approved style reference'];
  if (inp.sha256 !== a.ref.sha256) return [a.ref.name + ' in the build is not the file the owner approved (sha256 differs)'];
  return [];
}
