// PORTED from Virtual-workers/station/tests/style-ref.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 c5fc4f1c4bf14ce19f049d327364f1fbe4b248f69f1ac6d1bb9ec1f37b19243d.
//   change: imports point at src/engine/lib; ROOT is not imported (it was only used by the StarNet image rig)
//   change: job folders are jobs/<id>/ (were work/<id>/); recorded paths 'jobs/<id>/...'
//   change: each temp room is the realpath of a fresh temp folder and the data root of a data jail, activated per room (the library writes through it)
//   change: makeReviewImages builds in set-vN/.tmp-styleref-<pid>/, not the OS temp: the first-file test also checks that folder is gone afterwards
//   change: not ported (no StarNet in the engine): the style-reference patch check and the two image_generate tests (starnet-patch.mjs, StarNet's image.js)
//   change: not ported (run-line.mjs and the first-file run mode are not ported): 'run-line --first-file: only file 1 ...' and
//           'run-line --first-file after a rejection ...', with the fakeLine/roster/plan/afterDesigner/base helpers they used
//   change: the cleaned-version test: the run-line --after-style-ok step is replaced by its library call, ensureStyleRefInSet on set-v2 (the
//           cleaned bytes are copied in as file 1, the approved reference is the cleaned file, never the raw one); the assertions on the Designer's
//           run text (STYLE REFERENCE: ...) are dropped with run-line
//   change: the product's own download notice test moves in from tests/ported/listing-notice.test.mjs (deleted)
// Everything else is the source unchanged.
// style-ref.test.mjs — the owner-approved style reference (owner go 2026-10-16): the first-file review images, the owner's decision
// record, the copy of the approved file 1 into later sets, and the prop pack's own owner-approved download notice. Synthetic images in temp
// folders; a test double stands in for Real-ESRGAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config, loadProductList, sha256 } from '../../src/engine/lib/common.mjs';
import { firstFileOf, recordDecision, approvedRef, readStyleRef, ensureStyleRefInSet, styleRefProblems, makeReviewImages } from '../../src/engine/lib/style-ref.mjs';
import { noticeFor } from '../../src/engine/lib/digital-build.mjs';
import { digitalListingChecks } from '../../src/engine/lib/digital-gate.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';

const ID = '2026-10-16--test-style-ref';
const PACK = { key: 'prop-pack', digital: true, kind: 'asset-pack', licence: 'commercial-content', transparent: true, aspectRatio: '1:1', styleReference: { ownerOk: true },
  deliverables: { package: { kind: 'zip', preview: true }, prep: { cleanup: true, upscale: 'realesrgan' }, files: [1, 2, 3].map((n) => ({ format: 'png', widthPx: 200, heightPx: 200, purpose: 'prop ' + n })) } };
const cfg = { ...structuredClone(config), productType: 'digital' };
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });
// a 64x64 transparent prop: a solid disc on clear pixels
const prop = (seed = 0) => { const W = 64, d = Buffer.alloc(W * W * 4); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if ((x - 32) ** 2 + (y - 32) ** 2 <= 400) { d[i] = 180 + seed; d[i + 1] = 90; d[i + 2] = 60; d[i + 3] = 255; } } return sharp(d, { raw: { width: W, height: W, channels: 4 } }).png().toBuffer(); };
const brief = () => ['---', 'id: ' + ID, 'status: verified', 'product_type: prop-pack', '---', '# Niche', 'Desk props', '', '## Design direction', 'Original cosy desk props, no text.', ''].join('\n');
// PORT: a temp room is the data root of its own data jail
const tmp = (p) => { const dir = tempDir(p); useJail(createJail({ dataRoot: dir, extraRoots: [] })); return dir; };
async function room({ files = ['01-steaming-mug.png'], n = 1 } = {}) {
  const dir = tmp('sref-'), w = path.join(dir, 'jobs', ID), raw = path.join(w, 'set-v' + n, 'raw');
  fs.mkdirSync(raw, { recursive: true }); fs.writeFileSync(path.join(w, 'brief.md'), brief());
  for (const [i, f] of files.entries()) fs.writeFileSync(path.join(raw, f), await prop(i));
  fs.writeFileSync(path.join(w, 'set-v' + n, 'design.md'), 'Plan: 3 cosy desk props, one style, warm palette. File 1 prompt: a steaming mug, clean outlines, no text.');
  return { dir, w };
}
const done = (r) => fs.rmSync(r.dir, { recursive: true, force: true });
const writeSet = async (dir, n, files) => { const raw = path.join(dir, 'jobs', ID, 'set-v' + n, 'raw'); fs.mkdirSync(raw, { recursive: true }); for (const [i, f] of files.entries()) fs.writeFileSync(path.join(raw, f), await prop(i + n)); fs.writeFileSync(path.join(dir, 'jobs', ID, 'set-v' + n, 'design.md'), 'Plan for 3 props; file 1 a steaming mug. No text.'); };
const noTmpLeft = (setDir) => assert.deepEqual(fs.readdirSync(setDir).filter((f) => f.startsWith('.tmp-styleref-')), [], 'the review build folder is removed');

test('first file: exactly one 01- PNG; review images = file 1 built as delivered, flattened on white and dark; idempotent', async () => {
  const r = await room();
  try {
    const ff = firstFileOf(r.dir, ID, 1); assert.equal(ff.ok, true, ff.reason); assert.equal(ff.file, 'jobs/' + ID + '/set-v1/raw/01-steaming-mug.png');
    const rv = await makeReviewImages({ roomDir: r.dir, id: ID, n: 1, name: ff.name, product: PACK, cfg, upscaler: fakeEsrgan });
    assert.equal(rv.ok, true, rv.reason); assert.deepEqual([rv.built.widthPx, rv.built.heightPx], [200, 200]); assert.equal(rv.upscale.method, 'realesrgan');
    for (const [label, rgb] of [['white', [255, 255, 255]], ['dark', [0x1e, 0x1e, 0x24]]]) {
      const f = path.join(r.dir, rv.review[label].file), m = await sharp(f).metadata(); assert.equal(m.hasAlpha, false, label + ' is flattened'); assert.deepEqual([m.width, m.height], [200, 200]);
      const px = await sharp(f).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer(); assert.deepEqual([...px], rgb, label + ' background');
    }
    assert.ok(!fs.existsSync(path.join(r.w, 'set-v1', 'files')), 'review images are not deliverables');
    noTmpLeft(path.join(r.w, 'set-v1'));
    const again = await makeReviewImages({ roomDir: r.dir, id: ID, n: 1, name: ff.name, product: PACK, cfg, upscaler: fakeEsrgan }); assert.equal(again.review.white.action, 'unchanged');
    noTmpLeft(path.join(r.w, 'set-v1'));
  } finally { done(r); }
  const two = await room({ files: ['01-mug.png', '02-lamp.png'] }); try { assert.match(firstFileOf(two.dir, ID, 1).reason, /has 2 file\(s\)/); } finally { done(two); }
  const bad = await room({ files: ['mug.png'] }); try { assert.match(firstFileOf(bad.dir, ID, 1).reason, /starting 01-/); } finally { done(bad); }
});

test('owner decision: recorded against the file sha256, history kept; a changed file loses the approval; a set holds one decision', async () => {
  const r = await room();
  try {
    assert.match(approvedRef(r.dir, ID).reason, /no style reference decision/);
    assert.match(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'rejected', date: '2026-10-16' }).reason, /needs a reason/);
    const a = recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-16' }); assert.equal(a.action, 'recorded');
    assert.equal(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-16' }).action, 'unchanged');
    assert.match(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'rejected', reason: 'too dark', date: '2026-10-16' }).reason, /already has a decision/);
    const ok = approvedRef(r.dir, ID); assert.equal(ok.ok, true); assert.equal(ok.ref.decidedBy, 'owner'); assert.equal(ok.ref.sha256, sha256(fs.readFileSync(path.join(r.w, 'set-v1', 'raw', '01-steaming-mug.png'))));
    const f = path.join(r.w, 'set-v1', 'raw', '01-steaming-mug.png'), keep = fs.readFileSync(f); fs.writeFileSync(f, await prop(50));
    assert.match(approvedRef(r.dir, ID).reason, /differs from the file the owner approved/); fs.writeFileSync(f, keep);
    assert.equal(readStyleRef(r.dir, ID).record.decisions.length, 1);
  } finally { done(r); }
});

test('later sets: the approved file 1 is copied in byte for byte; a Designer-drawn file 1 is refused; the package gate checks the build input', async () => {
  const r = await room();
  try {
    recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-16' });
    assert.match(ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 1 }).reason, /not newer/);
    const raw2 = path.join(r.w, 'set-v2', 'raw'); fs.mkdirSync(raw2, { recursive: true });
    for (const [i, f] of ['02-lamp.png', '03-plant.png'].entries()) fs.writeFileSync(path.join(raw2, f), await prop(i + 5));
    assert.equal(ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 2 }).action, 'copied');
    assert.ok(fs.readFileSync(path.join(raw2, '01-steaming-mug.png')).equals(fs.readFileSync(path.join(r.w, 'set-v1', 'raw', '01-steaming-mug.png'))));
    assert.equal(ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 2 }).action, 'present');
    fs.writeFileSync(path.join(raw2, '01-other.png'), await prop(7)); assert.match(ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 2 }).reason, /another file 1/); fs.unlinkSync(path.join(raw2, '01-other.png'));
    fs.writeFileSync(path.join(raw2, '01-steaming-mug.png'), await prop(7)); assert.match(ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 2 }).reason, /must not draw file 1/);
    const ref = approvedRef(r.dir, ID).ref;
    assert.deepEqual(styleRefProblems({ roomDir: r.dir, id: ID, product: PACK, build: { inputs: [{ name: ref.name, sha256: ref.sha256 }] } }), []);
    assert.match(styleRefProblems({ roomDir: r.dir, id: ID, product: PACK, build: { inputs: [{ name: ref.name, sha256: 'x' }] } })[0], /not the file the owner approved/);
    assert.match(styleRefProblems({ roomDir: r.dir, id: ID, product: PACK, build: { inputs: [] } })[0], /must be the owner-approved style reference/);
    assert.deepEqual(styleRefProblems({ roomDir: r.dir, id: ID, product: { ...PACK, styleReference: undefined }, build: null }), []);
  } finally { done(r); }
});

// a 96x96 handle-like prop (owner, 2026-10-17): a dark-brown ring whose hole is painted OPAQUE off-white, as the mug's was
const holeProp = () => { const W = 96, d = Buffer.alloc(W * W * 4); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, r = Math.hypot(x - 48, y - 48); if (r <= 14) { d[i] = 254; d[i + 1] = 249; d[i + 2] = 237; d[i + 3] = 254; } else if (r <= 40) { d[i] = 88; d[i + 1] = 48; d[i + 2] = 24; d[i + 3] = 255; } } return sharp(d, { raw: { width: W, height: W, channels: 4 } }).png().toBuffer(); };
const alphaAt = async (f, x, y) => (await sharp(f).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())[3];

test('cleaned version: its own file and record; a raw rejection stays on the raw file; the owner decides on the cleaned file, which is the style reference sent and the file 1 of later sets, never the raw one', async () => {
  const r = await room(), rawF = path.join(r.w, 'set-v1', 'raw', '01-steaming-mug.png');
  try {
    fs.writeFileSync(rawF, await holeProp()); const rawBytes = fs.readFileSync(rawF), rawSha = sha256(rawBytes);
    // the owner rejected the raw file before any cleaned version existed (as on 2026-10-16)
    const rej = recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'rejected', reason: 'handle hole not transparent', date: '2026-10-16' });
    assert.equal(rej.decision.version, 'raw'); assert.equal(rej.decision.sha256, rawSha);
    // the review writes the cleaned version and shows it
    const rv = await makeReviewImages({ roomDir: r.dir, id: ID, n: 1, name: '01-steaming-mug.png', product: PACK, cfg, upscaler: fakeEsrgan });
    assert.equal(rv.ok, true, rv.reason); const cleanedRel = 'jobs/' + ID + '/set-v1/cleaned/01-steaming-mug.png', cleanedF = path.join(r.dir, cleanedRel);
    assert.deepEqual([rv.decides.version, rv.decides.file], ['cleaned', cleanedRel]); assert.equal(rv.decides.sha256, sha256(fs.readFileSync(cleanedF)));
    assert.equal(await alphaAt(cleanedF, 48, 48), 0, 'the hole is see-through in the cleaned file'); assert.equal(await alphaAt(rawF, 48, 48), 254, 'the raw file is untouched');
    assert.ok(fs.readFileSync(rawF).equals(rawBytes)); assert.notEqual(rv.decides.sha256, rawSha);
    const crec = JSON.parse(fs.readFileSync(path.join(r.w, 'set-v1', 'cleaned', '01-steaming-mug.cleaned.json'), 'utf8')); assert.equal(crec.raw.sha256, rawSha); assert.equal(crec.cleanup.enclosed.cleared.length, 1);
    assert.equal((await makeReviewImages({ roomDir: r.dir, id: ID, n: 1, name: '01-steaming-mug.png', product: PACK, cfg, upscaler: fakeEsrgan })).review.white.action, 'unchanged', 'idempotent');
    noTmpLeft(path.join(r.w, 'set-v1'));
    assert.match(approvedRef(r.dir, ID).reason, /"rejected" \(handle hole not transparent\)/);
    // the owner approves the cleaned version: a decision of its own; the rejection stays on the raw file
    const a = recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-17' });
    assert.equal(a.action, 'recorded', a.reason); assert.deepEqual([a.decision.version, a.decision.file, a.decision.sha256, a.decision.rawSha256], ['cleaned', cleanedRel, rv.decides.sha256, rawSha]);
    const ds = readStyleRef(r.dir, ID).record.decisions; assert.equal(ds.length, 2); assert.deepEqual([ds[0].version, ds[0].status, ds[0].sha256], ['raw', 'rejected', rawSha]);
    assert.equal(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-17' }).action, 'unchanged');
    assert.match(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'rejected', reason: 'x', date: '2026-10-17' }).reason, /cleaned version\) already has a decision/);
    assert.equal(approvedRef(r.dir, ID).ref.file, cleanedRel);
    // the rest of the set: the cleaned file is the style reference and the file 1 copied into the new set
    // PORT: run-line --after-style-ok is not ported; its station step is ensureStyleRefInSet, called here directly
    await writeSet(r.dir, 2, ['02-lamp.png', '03-plant.png']);
    const cp = ensureStyleRefInSet({ roomDir: r.dir, id: ID, n: 2 }); assert.equal(cp.action, 'copied', cp.reason);
    assert.equal(cp.ref.file, cleanedRel); assert.ok(!cp.ref.file.includes('/raw/01-steaming-mug.png'), 'the raw file is never the reference');
    const raw1 = fs.readFileSync(path.join(r.w, 'set-v2', 'raw', '01-steaming-mug.png'));
    assert.ok(raw1.equals(fs.readFileSync(cleanedF)) && !raw1.equals(rawBytes), 'set-v2 file 1 = the cleaned bytes');
    assert.deepEqual(styleRefProblems({ roomDir: r.dir, id: ID, product: PACK, build: { inputs: [{ name: '01-steaming-mug.png', sha256: rawSha }] } }).length, 1, 'a build of the raw file 1 fails the gate');
    // a raw approval while a cleaned version exists (a record from before 2026-10-17) is never used
    fs.writeFileSync(path.join(r.w, 'style-ref.json'), JSON.stringify({ listingId: ID, decisions: [{ ...ds[0], status: 'approved', reason: undefined }] }));
    assert.match(approvedRef(r.dir, ID).reason, /has a cleaned version .*the raw file is never the style reference/);
    // a cleaned file that no longer matches its record cannot be decided on
    fs.writeFileSync(path.join(r.w, 'style-ref.json'), JSON.stringify({ listingId: ID, decisions: [ds[0]] })); fs.writeFileSync(cleanedF, await prop(8));
    assert.match(recordDecision({ roomDir: r.dir, id: ID, n: 1, status: 'approved', date: '2026-10-17' }).reason, /differs from its record/);
  } finally { done(r); }
  // a file 1 the clean-up does not change has no cleaned version: decided and sent as the raw file
  const plain = await room();
  try { const rv = await makeReviewImages({ roomDir: plain.dir, id: ID, n: 1, name: '01-steaming-mug.png', product: PACK, cfg, upscaler: fakeEsrgan }); assert.equal(rv.decides.version, 'raw'); assert.ok(!fs.existsSync(path.join(plain.w, 'set-v1', 'cleaned'))); }
  finally { done(plain); }
});

test('the prop pack (live products.json): its own owner-approved notice matches the spec and passes the listing check; the config default stays DRAFT', () => {
  const live = loadProductList('digital').find((x) => x.key === 'pngtuber-prop-pack'), nt = noticeFor(live, config), f = live.deliverables.files;
  assert.match(nt.status, /^owner-approved 2026-10-16/); assert.equal(nt.where, 'products.json pngtuber-prop-pack.listingNotice');
  assert.ok(f.every((x) => x.widthPx === f[0].widthPx && x.heightPx === f[0].heightPx && x.format === 'png'));
  assert.ok(nt.text.includes('one ZIP file containing ' + f.length + ' transparent PNG files (' + f[0].widthPx + '×' + f[0].heightPx + ' px)'), 'the notice states the spec');
  assert.equal(live.styleReference.ownerOk, true); assert.match(config.digital.listingNoticeStatus, /^DRAFT/); assert.equal(noticeFor({ key: 'other' }, config).where, 'config.digital.listingNotice');
  const d = config.digital, reasons = [];
  digitalListingChecks({ L: { delivery: d.delivery, licence: live.licence, description: 'Twelve desk props.\n\n' + nt.text + '\n\n' + d.licences[live.licence].listingText + '\n\n' + d.aiDisclosure.text }, workDir: os.tmpdir(), design: { product: live, manifest: null }, reasons, cfg: { ...config, productType: 'digital' } });
  assert.deepEqual(reasons.filter((x) => /notice|licence|license|AI disclosure|shipping/i.test(x)), []);
});
