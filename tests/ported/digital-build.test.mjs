// PORTED from Virtual-workers/station/tests/digital-build.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 a7a34eafffc228050fa4b42cf8c20273cda19d6432975fac7061070e3e389759.
//   change: imports point at src/engine/lib
//   change: job folders are jobs/<id>/ with outbox/ inside (were work/<id>/ and outbox/<id>/); manifest and record paths say jobs/<id>/
//   change: each temp room is the data root of a data jail (the ported writers write through it); where tests hold several rooms at once,
//           the room's jail is made active again before each call that writes (use(r))
//   change: the build test also checks the build's temp folder set-v1/.tmp-build-<pid>/ is gone after a build (the engine build's own temp)
//   change: not ported, so dropped: the test 'run-line (digital): builds and measures at the DESIGNER pause, ...' (run-line.mjs runLine is
//           not in the engine) and, in the owner set approval test, the dry runListingOnly step (run-line.mjs runListingOnly); the rest of
//           that test is kept
//   change: package-digital is the engine's adapted step: cost is passed in (the job's ledger rows) and cost.json is that object as written,
//           not a sum over a ledger time window; the package is jobs/<id>/package/ (was approval-queue/<id>/), an earlier package is moved to
//           jobs/<id>/package-replaced-<sha12>/; the owner-decided refusal reads approvalStatus (was the tracker); overrides in MANIFEST.json
//           also carry sha256, stage, date and decidedBy
// Everything else is the source unchanged.
// digital-build.test.mjs — packaged digital products (owner go 2026-10-16): the station's zip writer/reader, the clean-up step, the build
// (clean-up, upscale, padding, zip, preview, build record; idempotent), the package gate for a zip + preview (Etsy limits, contents vs spec,
// every file station-built, cleaned up and upscaled with Real-ESRGAN), the AI disclosure, the owner price point in the price fill, and the
// digital line runner's build/fill pauses. Synthetic images in temp folders; a test double stands in for Real-ESRGAN (no GPU, no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config, sha256File } from '../../src/engine/lib/common.mjs';
import { writeZip, readZip, crc32 } from '../../src/engine/lib/zip.mjs';
import { measureBuffer, measureFile } from '../../src/engine/lib/digital-files.mjs';
import { cleanAlpha, nearWhiteFills, buildDigitalSet, buildStatus, zipNameFor } from '../../src/engine/lib/digital-build.mjs';
import { prepareDigitalSet, runDigitalDesignHook } from '../../src/engine/lib/digital-prep.mjs';
import { fillDigitalPrices, digitalPricing } from '../../src/engine/lib/digital-prices.mjs';
import { fileLimitProblems } from '../../src/engine/lib/digital-gate.mjs';
import { checkPackage } from '../../src/engine/lib/gates.mjs';
import { composeSetApproval, designSignOff, APPROVAL_FILE, composeListingApproval, checkOwnerListingApproval, LISTING_APPROVAL_FILE } from '../../src/engine/lib/owner-approval.mjs';
import { fixListing, usSpelling, chainFixRecord } from '../../src/engine/lib/listing-fix.mjs';
import { packageDigital } from '../../src/engine/lib/package-digital.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';

const ID = '2026-10-16--test-prop-pack';
const PACK = { key: 'prop-pack', digital: true, kind: 'asset-pack', licence: 'commercial-content', transparent: true, aspectRatio: '1:1',
  deliverables: { package: { kind: 'zip', preview: true }, prep: { cleanup: true, upscale: 'realesrgan' }, files: [1, 2, 3].map((n) => ({ format: 'png', widthPx: 200, heightPx: 200, purpose: 'prop ' + n })) } };
const cfgApproved = () => {
  const c = { ...structuredClone(config), productType: 'digital' };
  c.digital.listingNoticeStatus = 'owner-approved 2026-10-16 (test)';
  for (const l of Object.values(c.digital.licences)) l.status = 'owner-approved 2026-10-16 (test)';
  for (const a of Object.values(c.digital.assetRegister.assets)) { a.commercialUse = true; a.status = 'owner-confirmed 2026-10-16 (test)'; }
  c.digital.build.preview = { ...c.digital.build.preview, widthPx: 300, heightPx: 200 };
  return c;
};
// stands in for Real-ESRGAN: a plain resize that reports the method the product requires
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });

// a 64x64 transparent prop: a solid disc, faint haze, a 2x2 speck; colour under clear pixels is junk the clean-up must zero
function rawProp(seed = 0) {
  const W = 64, H = 64, d = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r2 = (x - 30) ** 2 + (y - 34) ** 2;
    if (r2 <= 18 * 18) { d[i] = 180 + seed; d[i + 1] = 90; d[i + 2] = 60; d[i + 3] = r2 > 17 * 17 ? 250 : 255; }
    else { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = (x + y) % 9 === 0 ? 5 : 0; }
  }
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) { const i = (y * W + x) * 4; d[i + 3] = 255; }
  return sharp(d, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
const brief = (priceLines = ['owner price: EUR 7.00–12.00 (recorded by owner, 2026-10-16)', 'owner price point: EUR 9.00 (recorded by owner, 2026-10-16)']) => ['---', 'id: ' + ID, 'status: verified', 'product_type: prop-pack', 'audience_segment: streamers', '---', '# Niche', 'Desk props', '',
  '## Price range', 'EUR 1.13–13.90 = USD 1.27–15.56 (https://www.etsy.com/listing/101)', ...priceLines, '', '## Design direction', 'Original cosy desk props, no text.', ''].join('\n');

async function setRoom({ cfg = cfgApproved(), priceLines } = {}) {
  const dir = tempDir('dbuild-'), jail = createJail({ dataRoot: dir, extraRoots: [] }); useJail(jail);
  const w = path.join(dir, 'jobs', ID), sd = path.join(w, 'set-v1'), raw = path.join(sd, 'raw');
  fs.mkdirSync(raw, { recursive: true }); fs.mkdirSync(path.join(w, 'qa'), { recursive: true }); fs.mkdirSync(path.join(w, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(w, 'brief.md'), brief(priceLines));
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(raw, '0' + n + '-prop.png'), await rawProp(n));
  fs.writeFileSync(path.join(sd, 'design.md'), 'Prompts: original cosy desk props, flat style, no text. Self-check: original, no trademarks, no named style, no real person.');
  return { dir, w, sd, raw, cfg, jail };
}
// make a room's data jail the active one again (tests that hold several rooms at once)
const use = (r) => useJail(r.jail);
// the whole line after the build: measure, QA DESIGN approval, LISTER draft, price fill, QA LISTING approval
function approveAndList(r, { listing = (l) => l } = {}) {
  use(r);
  const prep = prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK] }); assert.equal(prep.ok, true, prep.reason);
  const out = path.join(r.w, 'outbox'), rec = { stage: 'design', listingId: ID, pass: 1, verdict: 'approved', designFile: 'jobs/' + ID + '/set-v1/deliverables.json', manifestSha256: fs.readFileSync(path.join(r.sd, 'deliverables.sha256'), 'utf8').trim(),
    checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', complete: 'pass', usable: 'pass', matchesSpec: 'pass', worthThePrice: 'pass', licence: 'pass' },
    worthThePrice: { verdict: 'pass', reason: 'Three matching props for the price of two singles.' }, reasons: [], reviewer: 'QA DESIGN' };
  fs.writeFileSync(path.join(r.w, 'qa', 'design-pass1.json'), JSON.stringify(rec)); fs.writeFileSync(path.join(out, 'qa-design.json'), JSON.stringify(rec));
  const d = r.cfg.digital;
  fs.writeFileSync(path.join(out, 'listing.json'), JSON.stringify(listing({ listingId: ID, productKey: 'prop-pack', designFile: rec.designFile, title: 'Cozy Desk Props PNGTuber Pack Digital Download', tags: ['pngtuber props', 'vtuber assets'],
    description: 'A zip of three transparent PNG desk props, 200x200 px.\n\n' + d.listingNotice + '\n\n' + d.licences['commercial-content'].listingText + '\n\n' + d.aiDisclosure.text, altText: 'Three desk props', ownerTodo: ['confirm price'] })));
  const f = fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [PACK] }); assert.equal(f.ok, true, f.reason);
  fs.writeFileSync(path.join(out, 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: ID, pass: 1, verdict: 'approved', designFile: rec.designFile, checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', matchesFiles: 'pass', limits: 'pass' }, reasons: [], reviewer: 'QA LISTING' }));
  return { out, L: JSON.parse(fs.readFileSync(path.join(out, 'listing.json'), 'utf8')) };
}
const gate = (r) => checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg: r.cfg, products: [PACK] }).reasons;
const done = (r) => fs.rmSync(r.dir, { recursive: true, force: true });

test('zip: round trip, same files give the same bytes, CRC and names are checked, entries are measured', async () => {
  const png = await rawProp(), z = writeZip([{ name: '01-a.png', data: png }, { name: '02-b.txt', data: Buffer.from('hello hello hello hello') }]);
  assert.deepEqual(writeZip([{ name: '01-a.png', data: png }, { name: '02-b.txt', data: Buffer.from('hello hello hello hello') }]), z, 'deterministic');
  const r = readZip(z); assert.equal(r.ok, true, r.problems.join()); assert.deepEqual(r.entries.map((e) => e.name), ['01-a.png', '02-b.txt']); assert.equal(r.entries[1].method, 8, 'text deflates');
  assert.deepEqual(r.entries[0].data, png); assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const rnd = crypto.randomBytes(400), zr = writeZip([{ name: 'r.bin', data: rnd }]); assert.equal(readZip(zr).entries[0].method, 0, 'random bytes are stored');
  const bad = Buffer.from(zr); bad[30 + 5 + 100] ^= 0xff; assert.match(readZip(bad).problems.join(), /CRC check failed/);
  assert.throws(() => writeZip([{ name: '../x.png', data: png }]), /not allowed/); assert.throws(() => writeZip([{ name: 'a.png', data: png }, { name: 'A.png', data: png }]), /duplicate/);
  assert.match(readZip(Buffer.from('not a zip at all, sorry')).problems.join(), /not a zip archive/);
  // a hand-made zip with a folder path is refused by the reader
  const nm = Buffer.from('sub/x.png'), body = zlib.deflateRawSync(png), lh = Buffer.alloc(30), ch = Buffer.alloc(46), end = Buffer.alloc(22);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(png), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(png.length, 22); lh.writeUInt16LE(nm.length, 26);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(png), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(png.length, 24); ch.writeUInt16LE(nm.length, 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + body.length, 16);
  assert.match(readZip(Buffer.concat([lh, nm, body, ch, nm, end])).problems.join(), /no folders or paths/);
  const m = measureBuffer('pack.zip', z); assert.equal(m.format, 'zip'); assert.deepEqual(m.entries.map((e) => [e.name, e.format, e.widthPx]), [['01-a.png', 'png', 64], ['02-b.txt', 'unknown', null]]);
  // the gate: only png/jpg inside, never a font
  const withFont = measureBuffer('pack.zip', writeZip([{ name: '01-a.png', data: png }, { name: 'font.ttf', data: Buffer.from([0, 1, 0, 0, 9, 9]) }]));
  const g = fileLimitProblems([withFont]).join(' | '); assert.match(g, /font\.ttf is a font file/); assert.doesNotMatch(g, /not a format the station can build/);
  assert.match(fileLimitProblems([m]).join(' | '), /02-b\.txt is unknown: a zip may hold only png or jpg images/);
});

test('clean-up: faint haze cleared, near-solid made solid, a tiny speck removed, colour under clear zeroed, trimmed to the artwork', async () => {
  const { data, info } = await sharp(await rawProp()).raw().toBuffer({ resolveWithObject: true });
  const r = cleanAlpha(data, info.width, info.height, config.digital.build.cleanup);
  assert.ok(r.facts.clearedFaintPx > 100, 'haze'); assert.ok(r.facts.solidifiedPx > 0, 'edge'); assert.equal(r.facts.specksRemoved, 1); assert.equal(r.facts.speckPxRemoved, 4); assert.equal(r.facts.partsKept, 1);
  assert.deepEqual(r.bbox, { left: 12, top: 16, width: 37, height: 37 });
  for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) assert.equal(data[i] + data[i + 1] + data[i + 2], 0); else assert.ok(data[i + 3] === 255 || data[i + 3] >= 12); }
  const blank = Buffer.alloc(4 * 16); assert.equal(cleanAlpha(blank, 4, 4).bbox, null);
});

// a 240x240 handle/ring prop like the mug's (owner exception 2026-10-16): dark outline, cream fill, dark inner outline, and the hole painted
// OPAQUE off-white (the mug's 254,249,237) with a one-pixel anti-aliased blend into the outline; a pale highlight line on the cream fill.
// patch: an extra near-white blob inside the cream fill (not bordered by outline), which the clean-up keeps and the gate must flag.
// hole: the colour painted in the hole. grey: a grey-white blob (226,226,230) in the cream fill instead of the patch (a near-white fill
// under the palette rule, owner 2026-10-17, too dark for the enclosed-background test).
const OUTLINE = [88, 48, 24], CREAM = [255, 237, 193], HOLE = [254, 249, 237], GREY = [226, 226, 230];
function ringRaw({ patch = false, hole = HOLE, grey = false } = {}) {
  const W = 240, H = 240, d = Buffer.alloc(W * H * 4), put = (i, c, a = 255) => { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = Math.hypot(x - 120, y - 120), blob = Math.hypot(x - 120, y - 54) < 12;
    if (r > 90) put(i, [255, 255, 255], 0);
    else if (r > 82) put(i, OUTLINE);
    else if (r > 50) put(i, patch && blob ? HOLE : grey && blob ? GREY : (Math.abs(x - 120) < 30 && y === 186 ? [254, 253, 240] : CREAM));
    else if (r > 40) put(i, OUTLINE);
    else if (r > 39) put(i, OUTLINE.map((c, k) => Math.round((c + hole[k]) / 2)), 254);
    else put(i, hole, 254);
  }
  return { d, W, H, png: () => sharp(d, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() };
}

test('clean-up: an opaque off-white hole inside a handle/ring is made transparent, its edge unmixed into the outline; the fill, outline and a highlight line are kept', () => {
  const { d, W, H } = ringRaw(), at = (x, y) => [...d.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  const r = cleanAlpha(d, W, H, config.digital.build.cleanup), e = r.facts.enclosed;
  assert.equal(e.cleared.length, 1, JSON.stringify(e)); assert.deepEqual(e.kept, []);
  assert.deepEqual(e.cleared[0].meanRgb, HOLE); assert.ok(e.cleared[0].outlineShare >= 0.5); assert.deepEqual(e.cleared[0].outlineRgb, OUTLINE);
  assert.equal(at(120, 120)[3], 0, 'hole centre transparent'); assert.equal(at(120 + 30, 120)[3], 0, 'hole edge transparent');
  // the half-and-half edge pixel: about half alpha, in the outline colour (no pale halo)
  const edge = [...Array(W * H).keys()].map((i) => [i % W, Math.floor(i / W)]).filter(([x, y]) => { const q = Math.hypot(x - 120, y - 120); return q > 39 && q <= 40; }).map(([x, y]) => at(x, y));
  assert.ok(edge.length > 0 && edge.every((p) => p[3] > 90 && p[3] < 165 && Math.abs(p[0] - OUTLINE[0]) <= 3), JSON.stringify(edge.slice(0, 3)));
  assert.deepEqual(at(120, 120 + 60), [...CREAM, 255], 'cream fill kept'); assert.deepEqual(at(120, 120 + 45), [...OUTLINE, 255], 'inner outline kept'); assert.equal(at(120, 186)[3], 255, 'highlight line kept');
  assert.deepEqual(r.bbox, { left: 30, top: 30, width: 181, height: 181 });
  // a white patch inside the cream fill is not bordered by outline: kept and reported, never cleared
  const p = ringRaw({ patch: true }), rp = cleanAlpha(p.d, p.W, p.H, config.digital.build.cleanup);
  assert.equal(rp.facts.enclosed.cleared.length, 1); assert.equal(rp.facts.enclosed.kept.length, 1); assert.ok(rp.facts.enclosed.kept[0].outlineShare < 0.5);
  assert.equal(p.d[(54 * p.W + 120) * 4 + 3], 255, 'patch kept');
  // enclosed: false skips the step
  const off = ringRaw(); assert.equal(cleanAlpha(off.d, off.W, off.H, { ...config.digital.build.cleanup, enclosed: false }).facts.enclosed, undefined); assert.equal(off.d[(120 * off.W + 120) * 4 + 3], 255);
});

test('build and gate: the ring builds with its hole see-through and passes; a set with an enclosed near-white patch left is flagged; an old build record without the check fails', async () => {
  const r = await setRoom();
  try {
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(r.raw, '0' + n + '-prop.png'), await ringRaw().png());
    const b = await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
    assert.equal(b.ok, true, b.reason); const enc = b.record.files[0].cleanup.enclosed;
    assert.equal(enc.cleared.length, 1); assert.deepEqual(enc.remainingAfterBuild, []); assert.equal(enc.threshold.minLum, 240); assert.equal(b.record.settings.version, 5);
    assert.equal(enc.removed.nonBackgroundPx, 0); assert.ok(enc.removed.px > 4000); assert.deepEqual(b.record.files[0].cleanup.palette.nearWhiteFills, [], 'the 1-px highlight line is not a fill');
    const { data, info } = await sharp(path.join(r.sd, 'build', '01-prop.png')).raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[(100 * info.width + 100) * 4 + 3], 0, 'the built file is see-through in the middle of the ring');
    approveAndList(r); assert.deepEqual(gate(r), []);
  } finally { done(r); }
  const left = await setRoom();
  try {
    fs.writeFileSync(path.join(left.raw, '02-prop.png'), await ringRaw({ patch: true }).png());
    const b = await buildDigitalSet({ roomDir: left.dir, id: ID, n: 1, cfg: left.cfg, products: [PACK], upscaler: fakeEsrgan });
    assert.equal(b.ok, true, b.reason); assert.equal(b.record.files[1].cleanup.enclosed.remainingAfterBuild.length, 1); assert.match(b.record.warnings.join(' '), /02-prop\.png: 1 enclosed background-like region/);
    approveAndList(left); assert.match(gate(left).join(' | '), /station build: 02-prop\.png: 1 enclosed region\(s\) of background-like pixels/);
  } finally { done(left); }
  const old = await setRoom();
  try {
    await buildDigitalSet({ roomDir: old.dir, id: ID, n: 1, cfg: old.cfg, products: [PACK], upscaler: fakeEsrgan });
    // a build record from before the check (BUILD_VERSION 2) has no enclosed record: the gate asks for a rebuild
    const bf = path.join(old.sd, 'build.json'), rec = JSON.parse(fs.readFileSync(bf, 'utf8'));
    for (const f of rec.files) delete f.cleanup.enclosed; fs.writeFileSync(bf, JSON.stringify(rec));
    approveAndList(old); assert.match(gate(old).join(' | '), /01-prop\.png: no enclosed-transparency check in the build record/);
  } finally { done(old); }
});

test('clean-up: the removed-area check counts opaque pixels made clear that were not background-coloured in the generated file; near-white fills are found', () => {
  const ok = ringRaw(), r = cleanAlpha(ok.d, ok.W, ok.H, config.digital.build.cleanup).facts.enclosed.removed;
  assert.equal(r.nonBackgroundPx, 0); assert.ok(r.px > 4000); assert.deepEqual(r.background, { minLum: 240, maxChroma: 24 });
  // a clean-up whose colour test was loosened (maxChroma 70) clears a cream hole: the palette's background test (channels within 24) counts it
  const CREAMY = [255, 245, 215], c = ringRaw({ hole: CREAMY }), loose = { ...config.digital.build.cleanup, enclosed: { ...config.digital.build.cleanup.enclosed, maxChroma: 70 } };
  const rc = cleanAlpha(c.d, c.W, c.H, loose).facts.enclosed; assert.equal(rc.cleared.length, 1); assert.ok(rc.removed.nonBackgroundPx > 4000, JSON.stringify(rc.removed));
  // near-white fills: the grey-white blob (and a white patch), never the cream fill or the 1-px highlight line
  const g = ringRaw({ grey: true }); cleanAlpha(g.d, g.W, g.H, config.digital.build.cleanup);
  const nw = nearWhiteFills(g.d, g.W, g.H, config.digital.build.cleanup.palette); assert.equal(nw.length, 1, JSON.stringify(nw)); assert.deepEqual(nw[0].meanRgb, GREY);
  const p = ringRaw({ patch: true }); assert.equal(nearWhiteFills(p.d, p.W, p.H, config.digital.build.cleanup.palette).length, 2, 'before the clean-up: the hole and the patch');
  cleanAlpha(p.d, p.W, p.H, config.digital.build.cleanup); assert.equal(nearWhiteFills(p.d, p.W, p.H, config.digital.build.cleanup.palette).length, 1, 'after: the patch');
  assert.deepEqual(config.digital.build.cleanup.palette.products, ['pngtuber-prop-pack']);
});

test('gate: the palette rule fails a near-white fill for the products it lists only; a clean-up that removed drawing fails every pack; old records ask for a rebuild', async () => {
  const build = async (r, files) => { for (const [n, png] of files) fs.writeFileSync(path.join(r.raw, '0' + n + '-prop.png'), await png); const b = await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan }); assert.equal(b.ok, true, b.reason); return b; };
  const ruled = () => { const c = cfgApproved(); c.digital.build.cleanup.palette.products = ['prop-pack']; return c; };
  const grey = await setRoom({ cfg: ruled() });
  try {
    const b = await build(grey, [[1, ringRaw({ grey: true }).png()]]); assert.match(b.record.warnings.join(' '), /01-prop\.png: 1 near-white fill/);
    approveAndList(grey); assert.match(gate(grey).join(' | '), /station build: 01-prop\.png: 1 near-white fill\(s\), pure white or grey-white .*palette rule/);
    // an old record without the near-white check
    const bf = path.join(grey.sd, 'build.json'), rec = JSON.parse(fs.readFileSync(bf, 'utf8')); for (const f of rec.files) delete f.cleanup.palette; fs.writeFileSync(bf, JSON.stringify(rec));
    approveAndList(grey); assert.match(gate(grey).join(' | '), /01-prop\.png: no near-white fill check in the build record/);
  } finally { done(grey); }
  const unruled = await setRoom();   // the live config lists only pngtuber-prop-pack: this test pack is not under the rule
  try { await build(unruled, [[1, ringRaw({ grey: true }).png()]]); approveAndList(unruled); assert.doesNotMatch(gate(unruled).join(' | '), /near-white/); } finally { done(unruled); }
  const loose = await setRoom({ cfg: (() => { const c = cfgApproved(); c.digital.build.cleanup.enclosed.maxChroma = 70; return c; })() });
  try {
    const b = await build(loose, [[1, ringRaw({ hole: [255, 245, 215] }).png()]]); assert.match(b.record.warnings.join(' '), /01-prop\.png: the clean-up made \d+ px transparent that were not background-coloured/);
    approveAndList(loose); assert.match(gate(loose).join(' | '), /01-prop\.png: the clean-up made \d+ px transparent that were not background-coloured in the generated file/);
    const bf = path.join(loose.sd, 'build.json'), rec = JSON.parse(fs.readFileSync(bf, 'utf8')); for (const f of rec.files) delete f.cleanup.enclosed.removed; fs.writeFileSync(bf, JSON.stringify(rec));
    approveAndList(loose); assert.match(gate(loose).join(' | '), /01-prop\.png: no removed-area check in the build record/);
  } finally { done(loose); }
});

test('build: clean-up, upscale, padding, ONE zip of the spec files as the only download, the preview in listing/, a full record; idempotent; rebuilt when a raw file changes', async () => {
  const r = await setRoom();
  try {
    const b = await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
    assert.equal(b.ok, true, b.reason); assert.equal(b.action, 'built');
    assert.ok(!fs.readdirSync(r.sd).some((x) => /^\.tmp-build-/.test(x)), 'the build\'s temp folder is gone');
    const fd = path.join(r.sd, 'files'); assert.deepEqual(fs.readdirSync(fd), [zipNameFor(ID)], 'the download is exactly the one zip'); assert.equal(zipNameFor(ID), 'test-prop-pack.zip');
    const z = measureFile(path.join(fd, zipNameFor(ID))); assert.deepEqual(z.entries.map((e) => [e.name, e.format, e.widthPx, e.heightPx]), [1, 2, 3].map((n) => ['0' + n + '-prop.png', 'png', 200, 200]));
    const pv = measureFile(path.join(r.sd, 'listing', 'preview.jpg')); assert.deepEqual([pv.format, pv.widthPx, pv.heightPx], ['jpg', 300, 200]);
    assert.equal(b.record.preview.path, 'listing/preview.jpg'); assert.equal(b.record.preview.sha256, pv.sha256);
    // padding: the artwork's longer side fills 100 - 2 x 6 per cent of the canvas, centred
    const rec = b.record.files[0]; assert.deepEqual(rec.upscale.contentPx, [176, 176]); assert.deepEqual([rec.padding.leftPx, rec.padding.topPx], [12, 12]); assert.equal(rec.cleanup.specksRemoved, 1); assert.equal(rec.upscale.method, 'realesrgan');
    const { data, info } = await sharp(path.join(r.sd, 'build', '01-prop.png')).raw().toBuffer({ resolveWithObject: true });
    let x0 = 999, x1 = -1; for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3]) { const x = i % info.width; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    assert.ok(x0 >= 11 && x0 <= 13 && x1 >= 186 && x1 <= 188, 'centred with even padding: ' + x0 + '..' + x1);
    assert.equal(b.record.zip.sha256, z.sha256); assert.deepEqual(b.record.zip.entries, ['01-prop.png', '02-prop.png', '03-prop.png']);
    // idempotent: nothing rebuilt, same bytes
    const again = await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: () => { throw new Error('must not rebuild'); } });
    assert.equal(again.action, 'unchanged'); assert.equal(measureFile(path.join(fd, zipNameFor(ID))).sha256, z.sha256);
    // a changed raw file makes the build stale, and the rebuild replaces it
    fs.writeFileSync(path.join(r.raw, '02-prop.png'), await rawProp(40));
    assert.match(buildStatus({ roomDir: r.dir, id: ID, n: 1, product: PACK, cfg: r.cfg }).reason, /raw files or build settings changed/);
    const re = await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan }); assert.equal(re.action, 'built'); assert.notEqual(re.record.zip.sha256, z.sha256);
  } finally { done(r); }
});

test('build: refuses raw files without transparency, the wrong number of files, and non-PNG names', async () => {
  const r = await setRoom();
  try {
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(path.join(r.raw, '02-prop.png'));
    assert.match((await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan })).reason, /02-prop\.png has no alpha channel/);
    fs.unlinkSync(path.join(r.raw, '02-prop.png'));
    assert.match((await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan })).reason, /raw\/ has 2 file\(s\), the product spec lists 3/);
    fs.writeFileSync(path.join(r.raw, '02 Prop.jpg'), 'x');
    assert.match((await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan })).reason, /plain lowercase PNG names/);
  } finally { done(r); }
});

test('prep and hook: a packaged set is measured only once the station build is current; QA DESIGN is blocked before', async () => {
  const r = await setRoom();
  try {
    assert.match(prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK] }).reason, /station build of set-v1 is not current.*build-digital-set\.mjs/);
    const hook = runDigitalDesignHook({ payload: { hook_event_name: 'pre_llm_call', extra: { agent_id: 'qa' } }, roomDir: r.dir, qaDesignAgentId: 'qa', cfg: r.cfg, prepare: (o) => prepareDigitalSet({ ...o, products: [PACK] }) });
    assert.equal(hook.decision, 'block'); assert.match(hook.reason, /not current/);
    await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
    const p = prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK] });
    assert.equal(p.ok, true, p.reason); assert.equal(p.manifest.count, 1); assert.equal(p.manifest.build.files.length, 3); assert.equal(p.manifest.files.find((f) => f.format === 'zip').entries.length, 3);
  } finally { done(r); }
});

// owner exception 2026-10-17: the 12-file pack zipped at 28 MB, over Etsy's 20 MB, and QA DESIGN wrote "no build warnings"
test('optimise: lossless always; palette only when the zip is over the threshold and not under the PSNR floor; files, record and zip agree; 2000-style size kept', async () => {
  const withOpt = (o) => { const c = cfgApproved(); c.digital.build.optimise = { ...c.digital.build.optimise, ...o }; return c; };
  const zipEntries = (r) => readZip(fs.readFileSync(path.join(r.sd, 'files', zipNameFor(ID)))).entries;
  const agree = (r, b) => { for (const f of b.record.files) { const disk = fs.readFileSync(path.join(r.sd, 'build', f.name)); assert.equal(f.output.sha256, crypto.createHash('sha256').update(disk).digest('hex'), f.name + ' record vs build/'); assert.equal(f.output.bytes, disk.length); }
    const z = zipEntries(r); assert.deepEqual(z.map((e) => crypto.createHash('sha256').update(e.data).digest('hex')), b.record.files.map((f) => f.output.sha256), 'zip entries are the recorded files'); };
  const under = await setRoom();   // the live threshold (19 MB): a small set stays lossless
  const pal = await setRoom({ cfg: withOpt({ paletteIfZipOverBytes: 1 }) });
  const floor = await setRoom({ cfg: withOpt({ paletteIfZipOverBytes: 1, minPsnrDb: 1000 }) });
  try {
    use(under); const b0 = await buildDigitalSet({ roomDir: under.dir, id: ID, n: 1, cfg: under.cfg, products: [PACK], upscaler: fakeEsrgan }); assert.equal(b0.ok, true, b0.reason);
    assert.equal(b0.record.optimise.palette, false); assert.equal(b0.record.optimise.lossless, true); assert.ok(b0.record.files.every((f) => f.optimise.method === 'lossless')); agree(under, b0);
    use(pal); const b1 = await buildDigitalSet({ roomDir: pal.dir, id: ID, n: 1, cfg: pal.cfg, products: [PACK], upscaler: fakeEsrgan }); assert.equal(b1.ok, true, b1.reason);
    assert.equal(b1.record.optimise.palette, true); assert.equal(b1.record.optimise.zipBytes, b1.record.zip.bytes);
    for (const f of b1.record.files) { assert.equal(f.optimise.method, 'palette'); assert.ok(f.optimise.psnrDb >= 40, f.name + ' ' + f.optimise.psnrDb); assert.ok(f.optimise.losslessBytes > 0); }
    for (const e of zipEntries(pal)) { const m = await sharp(e.data).metadata(); assert.deepEqual([m.width, m.height, m.hasAlpha], [200, 200, true], 'pixel size and transparency kept'); }
    agree(pal, b1);
    use(floor); const b2 = await buildDigitalSet({ roomDir: floor.dir, id: ID, n: 1, cfg: floor.cfg, products: [PACK], upscaler: fakeEsrgan }); assert.equal(b2.ok, true, b2.reason);
    assert.ok(b2.record.files.every((f) => f.optimise.method === 'lossless' && f.optimise.paletteRejected), 'under the PSNR floor the lossless file is kept');
    assert.match(b2.record.warnings.join(' | '), /01-prop\.png: the palette version is .* dB \(under 1000 dB\); the lossless file is kept/); agree(floor, b2);
    // the optimise settings are part of the build key: changing them makes the build stale
    assert.match(buildStatus({ roomDir: under.dir, id: ID, n: 1, product: PACK, cfg: withOpt({ paletteIfZipOverBytes: 5 }) }).reason, /build settings changed/);
  } finally { done(under); done(pal); done(floor); }
});

test('prep: the manifest QA DESIGN reads states the Etsy limit problems of the REAL files and the build warnings up front', async () => {
  const small = cfgApproved(); small.digital.etsyFileLimits = { ...small.digital.etsyFileLimits, maxFileBytes: 100 };
  const r = await setRoom({ cfg: small }), ok = await setRoom();
  try {
    use(r); await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
    const p = prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK] }); assert.equal(p.ok, true, p.reason);
    const zipBytes = fs.statSync(path.join(r.sd, 'files', zipNameFor(ID))).size;
    assert.equal(p.manifest.files[0].bytes, zipBytes, 'measured from the zip on disk');
    assert.match(p.manifest.limitProblems.join(' | '), /test-prop-pack\.zip is .* MB: Etsy allows at most 20 MB per file \(enforced as 100 bytes\)/);
    assert.deepEqual(p.manifest.limitProblems, fileLimitProblems(p.manifest.files, r.cfg), 'the same answer as the package gate');
    assert.match(p.manifest.buildWarnings.join(' | '), /over Etsy's 20 MB per file/);
    const written = JSON.parse(fs.readFileSync(path.join(r.sd, 'deliverables.json'), 'utf8')); assert.deepEqual(Object.keys(written).slice(0, 5), ['listingId', 'set', 'productKey', 'limitProblems', 'buildWarnings']);
    use(ok); await buildDigitalSet({ roomDir: ok.dir, id: ID, n: 1, cfg: ok.cfg, products: [PACK], upscaler: fakeEsrgan });
    const q = prepareDigitalSet({ roomDir: ok.dir, id: ID, n: 1, cfg: ok.cfg, products: [PACK] }); assert.deepEqual(q.manifest.limitProblems, []);
    assert.deepEqual(q.manifest.buildWarnings, q.manifest.build.warnings, 'every build warning is copied up'); assert.doesNotMatch(q.manifest.buildWarnings.join(' | '), /MB/);
  } finally { done(r); done(ok); }
});

test('gate: a built, approved, owner-signed prop pack passes, listed at the owner price point EUR 9.00 with the zip contents stated', async () => {
  const r = await setRoom();
  try {
    await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
    const { L } = approveAndList(r);
    assert.deepEqual(gate(r), []);
    assert.deepEqual(L.variantPricesEur, [{ variant: 'Digital download', priceEur: 9 }]); assert.equal(L.listingPriceEur, 9); assert.deepEqual([L.priceSuggestion.min, L.priceSuggestion.max], [7, 12]);
    assert.equal(L.licence, 'commercial-content'); assert.equal(L.deliverables.length, 1, 'the listing delivers the zip only');
    assert.deepEqual(L.deliverables.find((f) => f.format === 'zip').contents.map((c) => [c.name, c.widthPx]), [['01-prop.png', 200], ['02-prop.png', 200], ['03-prop.png', 200]]);
  } finally { done(r); }
});

test('gate: a Lanczos fallback, a swapped zip, a preview in files/, a changed listing preview, a missing AI line, and the real blocking licence each fail the pack', async () => {
  const lanczos = await setRoom();
  try {
    await buildDigitalSet({ roomDir: lanczos.dir, id: ID, n: 1, cfg: lanczos.cfg, products: [PACK], upscaler: async (i, w, h) => ({ ...(await fakeEsrgan(i, w, h)), facts: { method: 'lanczos3' } }) });
    approveAndList(lanczos); assert.match(gate(lanczos).join(' | '), /01-prop\.png: upscaled with lanczos3, not realesrgan/);
  } finally { done(lanczos); }
  const swapped = await setRoom();
  try {
    await buildDigitalSet({ roomDir: swapped.dir, id: ID, n: 1, cfg: swapped.cfg, products: [PACK], upscaler: fakeEsrgan });
    const zf = path.join(swapped.sd, 'files', zipNameFor(ID)), ents = readZip(fs.readFileSync(zf)).entries;
    fs.writeFileSync(zf, writeZip(ents.map((e, i) => ({ name: e.name, data: i === 0 ? ents[1].data : e.data }))));
    assert.match(prepareDigitalSet({ roomDir: swapped.dir, id: ID, n: 1, cfg: swapped.cfg, products: [PACK] }).reason, /differs from build\.json/);
  } finally { done(swapped); }
  const nopv = await setRoom();
  try {
    await buildDigitalSet({ roomDir: nopv.dir, id: ID, n: 1, cfg: nopv.cfg, products: [PACK], upscaler: fakeEsrgan });
    // a preview put into files/ is a second download: refused (owner, 2026-10-16: the download is exactly the one zip)
    fs.copyFileSync(path.join(nopv.sd, 'listing', 'preview.jpg'), path.join(nopv.sd, 'files', 'preview.jpg'));
    approveAndList(nopv);
    assert.match(gate(nopv).join(' | '), /the download is exactly the one zip, but files\/ also holds preview\.jpg/);
  } finally { done(nopv); }
  const pvchg = await setRoom();
  try {
    await buildDigitalSet({ roomDir: pvchg.dir, id: ID, n: 1, cfg: pvchg.cfg, products: [PACK], upscaler: fakeEsrgan });
    approveAndList(pvchg); fs.writeFileSync(path.join(pvchg.sd, 'listing', 'preview.jpg'), 'not the built preview');
    assert.match(gate(pvchg).join(' | '), /the listing preview listing\/preview\.jpg is missing or is not the one the station built/);
  } finally { done(pvchg); }
  const noai = await setRoom();
  try {
    await buildDigitalSet({ roomDir: noai.dir, id: ID, n: 1, cfg: noai.cfg, products: [PACK], upscaler: fakeEsrgan });
    approveAndList(noai, { listing: (l) => ({ ...l, description: l.description.replace(noai.cfg.digital.aiDisclosure.text, 'Made with AI.') }) });
    assert.match(gate(noai).join(' | '), /lacks the AI disclosure, word for word/);
  } finally { done(noai); }
  const real = await setRoom({ cfg: (() => { const c = { ...structuredClone(config), productType: 'digital' }; c.digital.build.preview = { ...c.digital.build.preview, widthPx: 300, heightPx: 200 }; return c; })() });
  try {
    await buildDigitalSet({ roomDir: real.dir, id: ID, n: 1, cfg: real.cfg, products: [PACK], upscaler: fakeEsrgan });
    // the live config (owner, 2026-10-16): licence approved and image model confirmed; a product without its own notice (the prop pack has one,
    // owner-approved: style-ref.test.mjs) falls back to the config default notice, which is still DRAFT and blocks
    approveAndList(real); const g2 = gate(real);
    assert.equal(g2.length, 1, g2.join(' | ')); assert.match(g2[0], /notice wording is not owner-approved/);
  } finally { done(real); }
});

test('gate: a style-reference product passes only with the owner-approved file 1 in its build', async () => {
  const SR = { ...PACK, styleReference: { ownerOk: true } }, g = (r) => checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg: r.cfg, products: [SR] }).reasons;
  const rec = (r, sha) => fs.writeFileSync(path.join(r.w, 'style-ref.json'), JSON.stringify({ listingId: ID, decisions: [{ set: 1, name: '01-prop.png', file: 'jobs/' + ID + '/set-v1/raw/01-prop.png', sha256: sha, status: 'approved', decidedBy: 'owner', date: '2026-10-16' }] }));
  const r = await setRoom();
  try {
    await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [SR], upscaler: fakeEsrgan });
    approveAndList(r);
    assert.match(g(r).join(' | '), /style reference: no style reference decision/);
    rec(r, crypto.createHash('sha256').update(fs.readFileSync(path.join(r.raw, '01-prop.png'))).digest('hex')); assert.deepEqual(g(r), []);
    rec(r, 'f'.repeat(64)); assert.match(g(r).join(' | '), /style reference: .*differs from the file the owner approved/);
  } finally { done(r); }
});

test('gate: the image model terms: "unique", "exclusive", "one of a kind" or "hand-drawn" anywhere in the listing fails; the fill adds the OpenRouter to-do', async () => {
  for (const [field, text] of [['title', 'Unique Cozy Desk Props'], ['description', 'Exclusive props, one of a kind.'], ['altText', 'hand-drawn desk props'], ['tags', 'one-of-a-kind props']]) {
    const r = await setRoom();
    try {
      await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [PACK], upscaler: fakeEsrgan });
      const { L } = approveAndList(r, { listing: (l) => (field === 'tags' ? { ...l, tags: [...l.tags, text] } : field === 'description' ? { ...l, description: text + '\n\n' + l.description } : { ...l, [field]: text }) });
      assert.match(gate(r).join(' | '), new RegExp(field + ' says .*never claims the files are unique, exclusive, one of a kind or hand-drawn'), field);
      assert.ok(L.ownerTodo.includes(r.cfg.digital.assetRegister.assets['generator:openai/gpt-5-image-mini'].ownerTodo), 'OpenRouter to-do on the listing');
    } finally { done(r); }
  }
});

// DROPPED (not ported): the test 'run-line (digital): builds and measures at the DESIGNER pause, fills at the LISTER pause, stops before QA
// DESIGN when the build fails' needs run-line.mjs runLine, which the engine does not port (its orchestrator runs the line).

// OWNER exception 2026-10-17: after QA DESIGN's pass limit the owner's set approval is the design sign-off for the listing stage (price fill,
// run-line --listing-only) and for the minimal digital package step (approval-queue/<id>/: zip, listing, MANIFEST.json, cost.json)
// 160 px files: the 64 px test props are enlarged under 4x, so the build has no warnings (an owner set approval refuses build warnings)
const SHARP = { ...PACK, deliverables: { ...PACK.deliverables, files: PACK.deliverables.files.map((x) => ({ ...x, widthPx: 160, heightPx: 160 })) } };
const gateSharp = (r) => checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg: r.cfg, products: [SHARP] }).reasons;
async function ownerApprovedRoom() {
  const r = await setRoom();
  await buildDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [SHARP], upscaler: fakeEsrgan });
  const prep = prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg, products: [SHARP] }); assert.equal(prep.ok, true, prep.reason);
  const designFile = 'jobs/' + ID + '/set-v1/deliverables.json';
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(r.w, 'qa', 'design-pass' + n + '.json'), JSON.stringify({ stage: 'design', listingId: ID, pass: n, verdict: 'revise', designFile, checks: {}, reasons: ['usable: 02 shading'] }));
  const raw = (n) => sha256File(path.join(r.raw, '0' + n + '-prop.png'));
  fs.writeFileSync(path.join(r.w, 'owner-review.json'), JSON.stringify({ listingId: ID, set: 1, decidedBy: 'owner', date: '2026-10-17', reviewOf: { qaRecord: 'qa/design-pass3.json' },
    setApproval: { decidedBy: 'owner', date: '2026-10-17', afterQaPass: 'qa/design-pass3.json', words: 'Record my owner approval of the whole set in place of a 4th QA pass.', worthThePrice: { owner: 'I will set the price myself.' } },
    files: [{ name: '01-prop.png', rawSha256: raw(1), decision: 'approved' }, { name: '02-prop.png', rawSha256: raw(2), decision: 'accept', overridesQa: true, qaPass: 3, qaSaid: 'usable: 02 shading', reason: 'acceptable cel shading for this set' }, { name: '03-prop.png', rawSha256: raw(3), decision: 'approved' }] }));
  const c = composeSetApproval({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg }); assert.ok(c.ok, JSON.stringify(c.reasons));
  fs.writeFileSync(path.join(r.w, APPROVAL_FILE), JSON.stringify(c.record, null, 1) + '\n');
  return { ...r, designFile, out: path.join(r.w, 'outbox') };
}
const lister = (r) => {
  const d = r.cfg.digital;
  fs.writeFileSync(path.join(r.out, 'listing.json'), JSON.stringify({ listingId: ID, productKey: 'prop-pack', designFile: r.designFile, title: 'Cozy Desk Props PNGTuber Pack Digital Download', tags: ['pngtuber props', 'vtuber assets'],
    description: 'A zip of three transparent PNG desk props, 160x160 px.\n\n' + d.listingNotice + '\n\n' + d.licences['commercial-content'].listingText + '\n\n' + d.aiDisclosure.text, altText: 'Three desk props', ownerTodo: ['confirm price'] }));
  fs.writeFileSync(path.join(r.out, 'listing.md'), '# Cozy Desk Props\n');
};
const qaListing = (r) => fs.writeFileSync(path.join(r.out, 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: ID, pass: 1, verdict: 'approved', designFile: r.designFile, checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', matchesFiles: 'pass', limits: 'pass' }, reasons: [], reviewer: 'QA LISTING' }));

test('owner set approval as the listing stage\'s design sign-off: the dry listing-only run names it, the price fill accepts it (a stale one is refused), the package gate passes', async () => {
  const r = await ownerApprovedRoom();
  try {
    assert.equal(fs.existsSync(path.join(r.out, 'qa-design.json')), false, 'QA DESIGN never approved this set');
    assert.deepEqual(designSignOff({ id: ID, roomDir: r.dir, cfg: r.cfg }), { ok: true, source: 'owner-set-approval', file: 'jobs/' + ID + '/' + APPROVAL_FILE, designFile: r.designFile, reasons: [] });
    // DROPPED (not ported): the dry runListingOnly step (run-line.mjs runListingOnly is not in the engine): its sign-off source and the
    // "DESIGN SIGN-OFF: work/.../owner-set-approval.json" and "STAGE_DONE: OWNER SET APPROVAL" lines of its request text
    lister(r);
    const f = fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [SHARP] }); assert.equal(f.ok, true, f.reason);
    const L = JSON.parse(fs.readFileSync(path.join(r.out, 'listing.json'), 'utf8'));
    assert.deepEqual(L.variantPricesEur, [{ variant: 'Digital download', priceEur: 9 }], 'proposed from the owner\'s price rules'); assert.ok(L.ownerTodo.includes('confirm price'));
    qaListing(r); assert.deepEqual(gateSharp(r), []);
    // stale: the owner review edited after the record was written -> the fill refuses, the gate blocks
    const rf = path.join(r.w, 'owner-review.json'); fs.writeFileSync(rf, fs.readFileSync(rf, 'utf8').replace('acceptable cel shading', 'acceptable shading'));
    const s = fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [SHARP] }); assert.equal(s.ok, false); assert.match(s.reason, /no approved deliverable set to list: .*owner set approval: owner-set-approval.json is stale/);
    assert.ok(gateSharp(r).some((x) => /^owner set approval: .*stale/.test(x)));
  } finally { done(r); }
});

test('package-digital: one package folder (zip, listing, MANIFEST with sha256, gates, owner approvals and overrides, licence and notice, cost by job); idempotent; blocked or refused otherwise', async () => {
  const r = await ownerApprovedRoom();
  try {
    lister(r); assert.equal(fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [SHARP] }).ok, true); qaListing(r);
    // the engine passes the job's own cost in (its ledger rows by jobId), in place of the source's ledger time window
    const cost = { jobId: ID, totalUsd: 0.215, rows: 3 };
    const pk = (o = {}) => packageDigital({ id: ID, roomDir: r.dir, blocklist: [], cost, cfg: r.cfg, products: [SHARP], ...o });
    const dest = path.join(r.w, 'package');
    const dry = pk(); assert.equal(dry.action, 'dry', JSON.stringify(dry.reasons)); assert.equal(fs.existsSync(dest), false, 'a dry run writes nothing');
    const p1 = pk({ apply: true }); assert.equal(p1.action, 'packaged', JSON.stringify(p1.reasons));
    const zipName = JSON.parse(fs.readFileSync(path.join(r.sd, 'deliverables.json'), 'utf8')).files[0].name;
    assert.deepEqual(fs.readdirSync(dest).sort(), ['MANIFEST.json', 'cost.json', 'listing.json', 'listing.md', zipName].sort());
    const M = JSON.parse(fs.readFileSync(path.join(dest, 'MANIFEST.json'), 'utf8')), C = JSON.parse(fs.readFileSync(path.join(dest, 'cost.json'), 'utf8'));
    for (const fl of M.files) assert.equal(sha256File(path.join(dest, fl.name)), fl.sha256, fl.name);
    assert.equal(sha256File(path.join(dest, zipName)), sha256File(path.join(r.sd, 'files', zipName)), 'the zip byte for byte');
    assert.deepEqual(M.zipEntries.map((e) => e.name), ['01-prop.png', '02-prop.png', '03-prop.png']);
    assert.equal(M.gates.designSignOff.source, 'owner-set-approval'); assert.match(M.gates.designSignOff.inPlaceOf, /QA DESIGN pass 4/); assert.equal(M.gates.qaListing.verdict, 'approved'); assert.equal(M.gates.originality.set, 'clear');
    assert.deepEqual(M.ownerApprovals.setApproval.counts, { 'qa-pass': 2, 'owner-override': 1, 'deterministic-fix': 0 });
    assert.deepEqual(M.overrides, [{ file: '02-prop.png', sha256: sha256File(path.join(r.raw, '02-prop.png')), stage: 'QA DESIGN', qaPass: 3, qaSaid: 'usable: 02 shading', ownerReason: 'acceptable cel shading for this set', date: '2026-10-17', decidedBy: 'owner' }]);
    assert.equal(M.licence.text, r.cfg.digital.licences['commercial-content'].listingText); assert.equal(M.notice.text, r.cfg.digital.listingNotice);
    assert.equal(M.price.final, false); assert.equal(M.price.listingPriceEur, 9);
    assert.deepEqual(C, cost, 'cost.json is the job\'s cost as passed in'); assert.equal(M.costUsd, 0.215);
    // idempotent: nothing rewritten
    const mt = fs.statSync(path.join(dest, 'MANIFEST.json')).mtimeMs; assert.equal(pk({ apply: true }).action, 'unchanged'); assert.equal(fs.statSync(path.join(dest, 'MANIFEST.json')).mtimeMs, mt);
    assert.ok(!fs.readdirSync(r.w).some((x) => /staging/.test(x)), 'no staging folder left');
    // a changed listing re-packages (the earlier package moved aside, never deleted); an owner decision is never repackaged over; the POD line is refused
    const oldSha = sha256File(path.join(dest, 'MANIFEST.json'));
    fs.writeFileSync(path.join(r.out, 'listing.md'), '# Cozy Desk Props, edited\n'); assert.equal(pk({ apply: true }).action, 'repackaged');
    assert.equal(sha256File(path.join(r.w, 'package-replaced-' + oldSha.slice(0, 12), 'MANIFEST.json')), oldSha, 'the earlier package is kept in package-replaced-<sha12>/');
    assert.match(pk({ apply: true, approvalStatus: 'approved' }).reasons.join(), /the owner has decided "approved"/);
    // PORT DIFF: the source refuses a POD config up front ('package-digital is for the digital line (productType is "pod")', action
    // 'refused'); the engine's adapted packageDigital has no productType check, so the POD config reaches the package gate and is 'blocked'
    // by the gate's own reasons (here the owner set approval's "digital-line exception" and "no licence key"). Not packaged either way;
    // the legacy assertion /digital line/ is dropped, and only "not packaged" is checked here.
    assert.equal(pk({ cfg: { ...r.cfg, productType: 'pod' } }).ok, false);
    // the gate fails (QA LISTING sent it back): blocked, nothing changed
    fs.writeFileSync(path.join(r.out, 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: ID, verdict: 'revise', designFile: r.designFile, checks: {} }));
    const before = fs.readFileSync(path.join(dest, 'MANIFEST.json'), 'utf8'), b = pk({ apply: true });
    assert.equal(b.action, 'blocked'); assert.ok(b.reasons.length); assert.equal(fs.readFileSync(path.join(dest, 'MANIFEST.json'), 'utf8'), before);
  } finally { done(r); }
});

// OWNER exception 2026-10-17: QA LISTING's only finding was UK spelling for the US market -> the owner's deterministic text fix (no model) and
// the owner's listing approval in place of a further QA LISTING pass, tied to the listing's bytes; the gate's own listing checks still run
test('listing text fix: US spelling on title, description and alt text only (the id, paths and tags untouched), whole words, idempotent; the reviewer note rebuilt from the set approval record', () => {
  const L = { listingId: '2026-10-16--x-cosy-r2', designFile: 'work/2026-10-16--x-cosy-r2/set-v4/deliverables.json', title: 'Cosy Props', tags: ['cosy-ish'],
    description: 'A cosy set: two colour variants, a second colourway. Colours stay.', altText: 'cosy props', ownerTodo: ['cosy todo'] };
  const md = '# Listing draft: 2026-10-16--x-cosy-r2\n\nDesign: work/2026-10-16--x-cosy-r2/set-v4/deliverables.json\n\n## Title (10 characters)\nCosy Props\n\n## Tags (1)\ncosy-ish\n\n## Description\n\nA cosy set: two colour variants, a second colourway.\n\n## Alt text (main preview)\ncosy props\n\n## Notes for the reviewer\n- The owner-set approval records file 03 and 08 as owner overrides and 07, 11, 12 as deterministic fixes. The listing does not describe those internal records.\n';
  const sa = { files: [['01', 'qa-pass'], ['02', 'owner-override'], ['03', 'owner-override'], ['07', 'deterministic-fix'], ['08', 'owner-override'], ['11', 'deterministic-fix'], ['12', 'deterministic-fix']].map(([n, status]) => ({ name: n + '-x.png', status })) };
  const r = fixListing({ listing: L, md, setApproval: sa });
  assert.equal(r.listing.title, 'Cozy Props'); assert.equal(r.listing.altText, 'cozy props');
  assert.equal(r.listing.description, 'A cozy set: two color variants, a second colorway. Colours stay.', '"Colours" is not on the owner\'s list: the gate\'s own spelling check catches what is left');
  assert.equal(r.listing.listingId, L.listingId); assert.equal(r.listing.designFile, L.designFile); assert.deepEqual(r.listing.tags, L.tags); assert.deepEqual(r.listing.ownerTodo, L.ownerTodo);
  assert.match(r.md, /^# Listing draft: 2026-10-16--x-cosy-r2\n\nDesign: work\/2026-10-16--x-cosy-r2\//); assert.match(r.md, /## Tags \(1\)\ncosy-ish\n/);
  assert.match(r.md, /## Title \(10 characters\)\nCozy Props\n/); assert.match(r.md, /A cozy set: two color variants, a second colorway\./); assert.match(r.md, /## Alt text \(main preview\)\ncozy props\n/);
  assert.match(r.md, /- The owner-set approval records files 02, 03 and 08 as owner overrides and 07, 11 and 12 as deterministic fixes\./);
  assert.equal(r.changes.length, 11); assert.deepEqual(usSpelling('colourway colour').changes, [{ from: 'colourway', to: 'colorway', count: 1 }, { from: 'colour', to: 'color', count: 1 }]);
  const again = fixListing({ listing: r.listing, md: r.md, setApproval: sa }); assert.deepEqual(again.changes, []); assert.equal(again.md, r.md);
});

// OWNER decision at approval 2026-10-17: listing.md's "Owner to-do" rebuilt from listing.json ownerTodo; the fix record keeps every round
test('listing text fix: the Owner to-do section in listing.md is rebuilt from listing.json (nothing else touched, idempotent); a second round chains onto the fix record only from its "after"', () => {
  const L = { listingId: '2026-10-16--x-cosy-r2', title: 'Cozy', ownerTodo: ['confirm price', 'choose the category (subject to your judgement)', 'skim the terms before the first publish'] };
  const md = '# Listing draft\n\n## Title (5 characters)\nCozy\n\n## Owner to-do\n- confirm price\n- choose the category (subject to your judgement)\n\n## Notes for the reviewer\n- n\n';
  const r = fixListing({ listing: L, md });
  assert.equal(r.md, md.replace('judgement)\n\n', 'judgement)\n- skim the terms before the first publish\n\n')); assert.deepEqual(r.listing, L);
  assert.deepEqual(r.changes, [{ file: 'listing.md', where: 'Owner to-do', from: L.ownerTodo.slice(0, 2), to: L.ownerTodo, added: [L.ownerTodo[2]], removed: [], count: 1 }]);
  assert.deepEqual(fixListing({ listing: L, md: r.md }).changes, []);
  // the section is left alone when it holds anything but "- " lines; a final section keeps one closing newline
  const odd = md.replace('- confirm price\n', 'free text\n'); assert.equal(fixListing({ listing: L, md: odd }).md, odd);
  assert.equal(fixListing({ listing: L, md: '## Owner to-do\n- confirm price' }).md, '## Owner to-do\n' + L.ownerTodo.map((x) => '- ' + x).join('\n') + '\n');
  // the record: round 1 (the old single-round shape) + round 2 -> one record, first "before" and backup, latest "after", all changes and words
  const s = (j, m) => ({ 'listing.json': j, 'listing.md': m }), base = { kind: 'listing-text-fix', listingId: L.listingId, decidedBy: 'owner', model: 'none (deterministic)' };
  const prev = { ...base, date: '2026-10-17', ownerWords: 'w1', before: s('a', 'b'), after: s('c', 'd'), backup: 'derived/b1', changes: [{ where: 'title' }] };
  const round = { base, date: '2026-10-17', ownerWords: 'w2', before: s('c', 'd'), after: s('c', 'e'), backup: 'derived/b2', changes: r.changes };
  const c = chainFixRecord(prev, round); assert.equal(c.ok, true);
  assert.deepEqual([c.record.before, c.record.after, c.record.backup, c.record.ownerWords, c.record.changes.length, c.record.rounds.length], [s('a', 'b'), s('c', 'e'), 'derived/b1', ['w1', 'w2'], 2, 2]);
  assert.deepEqual(c.record.rounds[0], { date: '2026-10-17', ownerWords: 'w1', before: s('a', 'b'), after: s('c', 'd'), backup: 'derived/b1', changes: [{ where: 'title' }] });
  assert.equal(chainFixRecord(c.record, { ...round, before: s('c', 'e'), after: s('c', 'f'), ownerWords: 'w3' }).record.rounds.length, 3);
  assert.match(chainFixRecord(prev, { ...round, before: s('c', 'x') }).reason, /changed after the last fix/);
  assert.match(chainFixRecord({ ...prev, listingId: 'other' }, round).reason, /is for other/);
  assert.deepEqual(chainFixRecord(null, round).record.ownerWords, ['w2']);
});

test('owner listing approval in place of QA LISTING\'s: tied to the listing bytes and QA\'s record, the gate\'s listing checks still run, stale after any change, recorded in MANIFEST.json', async () => {
  const r = await ownerApprovedRoom(), jf = path.join(r.out, 'listing.json'), mf = path.join(r.out, 'listing.md');
  const REASON = 'the only finding was US spelling, fixed deterministically and re-checked by the gate', approve = () => composeListingApproval({ roomDir: r.dir, id: ID, reason: REASON, date: '2026-10-17', cfg: r.cfg });
  const write = (c) => fs.writeFileSync(path.join(r.w, LISTING_APPROVAL_FILE), JSON.stringify(c.record, null, 1) + '\n');
  try {
    lister(r); const L0 = JSON.parse(fs.readFileSync(jf, 'utf8')); L0.title = 'Cosy Desk Props PNGTuber Pack Digital Download'; L0.description = 'A cosy zip in one colour. ' + L0.description; fs.writeFileSync(jf, JSON.stringify(L0));
    assert.equal(fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [SHARP] }).ok, true);
    const qaRevise = (pass) => fs.writeFileSync(path.join(r.out, 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: ID, pass, verdict: 'revise', designFile: r.designFile, checks: { originality: 'pass', limits: 'fail' }, reasons: ['limits: UK spelling \'Cosy\' in the title'] }));
    qaRevise(1);
    assert.ok(gateSharp(r).includes('qa-listing.json verdict is "revise"'));
    // QA's approval is never overruled when QA approved cleanly; a reason is required
    assert.match(composeListingApproval({ roomDir: r.dir, id: ID, reason: '', date: '2026-10-17', cfg: r.cfg }).reasons.join(), /reason is missing/);
    // an approval of the UK-spelt listing replaces QA's verdict, but the gate's own spelling check still blocks
    write(approve()); let g = gateSharp(r);
    assert.ok(!g.some((x) => /qa-listing\.json/.test(x)), g.join()); assert.ok(g.some((x) => /UK spelling "cosy" in title/.test(x)) && g.some((x) => /UK spelling "colour" in description/.test(x)), g.join());
    // the deterministic fix changes the listing: the earlier approval is stale
    const fx = fixListing({ listing: JSON.parse(fs.readFileSync(jf, 'utf8')), md: fs.readFileSync(mf, 'utf8') });
    fs.writeFileSync(jf, JSON.stringify(fx.listing, null, 2) + '\n'); fs.writeFileSync(mf, fx.md);
    fs.writeFileSync(path.join(r.w, 'listing-fixes.json'), JSON.stringify({ kind: 'listing-text-fix', listingId: ID, after: { 'listing.json': sha256File(jf), 'listing.md': sha256File(mf) }, changes: fx.changes }));
    assert.ok(gateSharp(r).some((x) => /^owner listing approval: owner-listing-approval\.json is stale: .*listing/.test(x)), gateSharp(r).join());
    // re-approved on the fixed listing: the gate passes
    const c = approve(); assert.ok(c.ok, JSON.stringify(c.reasons)); write(c); assert.deepEqual(gateSharp(r), []);
    assert.deepEqual(checkOwnerListingApproval({ id: ID, roomDir: r.dir, cfg: r.cfg }), { problems: [] });
    assert.equal(c.record.overrulesQa.verdict, 'revise'); assert.deepEqual(c.record.overrulesQa.failedChecks, ['limits']); assert.equal(c.record.designSignOff.source, 'owner-set-approval'); assert.equal(c.record.fixes.changes, 3);
    // packaged with the override and the fix recorded
    const cost = { jobId: ID, totalUsd: 0.01, rows: 1 };
    const p1 = packageDigital({ id: ID, roomDir: r.dir, blocklist: [], cost, cfg: r.cfg, products: [SHARP], apply: true });
    assert.equal(p1.action, 'packaged', JSON.stringify(p1.reasons));
    const M = JSON.parse(fs.readFileSync(path.join(r.w, 'package', 'MANIFEST.json'), 'utf8'));
    assert.equal(M.gates.qaListing.verdict, 'revise'); assert.equal(M.gates.qaListing.ownerOverride.ownerReason, REASON); assert.deepEqual(M.gates.qaListing.ownerOverride.listingSha256, c.record.listing);
    assert.equal(M.gates.listingTextFix.changes.length, 3); assert.equal(M.price.final, false);
    assert.deepEqual(M.overrides.at(-1), { file: 'listing (listing.json, listing.md)', sha256: c.record.listing, stage: 'QA LISTING', qaPass: 1, qaSaid: 'revise: limits: UK spelling \'Cosy\' in the title', ownerReason: REASON, date: '2026-10-17', decidedBy: 'owner' });
    // any later change to the listing (here outside the fix) is refused; a new QA LISTING record makes it stale too
    fs.appendFileSync(mf, '\nedited\n'); assert.match(gateSharp(r).join(), /owner listing approval: the listing changed after the deterministic fix/);
    fs.writeFileSync(mf, fx.md); assert.deepEqual(gateSharp(r), []);
    qaRevise(2); assert.match(gateSharp(r).join(), /owner listing approval: owner-listing-approval\.json is stale: .*overrulesQa/);
  } finally { done(r); }
});
