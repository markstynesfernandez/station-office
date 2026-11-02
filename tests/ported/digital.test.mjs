// PORTED from Virtual-workers/station/tests/digital.test.mjs at 16/10/2026 19:58 Irish time (re-ported: it changed after 19:42), source sha256 ba99e6da16a43c4f6ccd5d32622004e652c08503b66b4a8734ff9737fd8487a4.
//   change: imports point at src/engine/lib
//   change: job folders are jobs/<id>/ with outbox/ inside
//   change: each temp room is the data root of a data jail (the ported writers write through it)
// digital.test.mjs — the digital line (productType "digital", owner 2026-10-16): the digital price floor, file measurement, the deliverable-set
// manifest, the package gate (Etsy file limits, exact deliverables, licence, asset register, worth-the-price, digital floor), the price fill,
// the design hook, and the demand-evidence rule for briefs. Synthetic files in temp folders; no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config, sha256File } from '../../src/engine/lib/common.mjs';
import { digitalFloor, variantLadder, variantsOf, shippingFor, etsyFees } from '../../src/engine/lib/etsy-fees.mjs';
import { formatOf, imageSize, measureFile } from '../../src/engine/lib/digital-files.mjs';
import { prepareDigitalSet, pendingSet, runDigitalDesignHook } from '../../src/engine/lib/digital-prep.mjs';
import { fillDigitalPrices } from '../../src/engine/lib/digital-prices.mjs';
import { checkPackage } from '../../src/engine/lib/gates.mjs';
import { demandEvidenceProblems, keywordSourceProblems, ownerPrice } from '../../src/engine/lib/demand-evidence.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';

const ID = '2026-10-16--test-bingo-set';
const PRODUCT = { key: 'bingo-set', digital: true, kind: 'printable', licence: 'personal-use', transparent: true,
  deliverables: { files: [{ format: 'png', widthPx: 300, heightPx: 400, purpose: 'card 1' }, { format: 'png', widthPx: 300, heightPx: 400, purpose: 'card 2' }, { format: 'jpg', widthPx: 200, heightPx: 100, purpose: 'cover' }] } };
// the real config with the owner's sign-offs a passing package needs (the real ones are DRAFT/UNCONFIRMED on purpose)
const cfgApproved = () => {
  const c = { ...structuredClone(config), productType: 'digital' };
  c.digital.listingNoticeStatus = 'owner-approved 2026-10-16 (test)';
  for (const l of Object.values(c.digital.licences)) l.status = 'owner-approved 2026-10-16 (test)';
  for (const a of Object.values(c.digital.assetRegister.assets)) { a.commercialUse = true; a.status = 'owner-confirmed 2026-10-16 (test)'; }
  return c;
};
const AI = config.digital.aiDisclosure.text;

const evidence = (o = {}) => ['## Demand evidence', 'search phrase: christmas bingo printable', 'checked: ' + (o.checked || '2026-10-16'), 'search URL: https://www.etsy.com/search?q=christmas+bingo+printable',
  'competitor count: ' + (o.count || '8,460'), 'saturation: ' + (o.sat || 'medium — 8,460 results, top five 300-9,000 reviews, two Bestsellers'),
  '| # | listing (short title) | shop | price | reviews | bestseller | URL |', '|---|---|---|---|---|---|---|',
  ...[1, 2, 3, 4, 5].slice(0, o.rows || 5).map((n) => '| ' + n + ' | Bingo set ' + n + ' | Shop' + n + ' | ' + (o.price || 'USD 7.50') + ' | ' + (o.reviews || '1,234') + ' | ' + (o.badge || (n < 3 ? 'yes' : 'no')) + ' | ' + (o.url || 'https://www.etsy.com/listing/10' + n) + ' |'), ''].join('\n');
const brief = (o = {}) => ['---', 'id: ' + ID, 'status: verified', 'product_type: bingo-set', 'audience_segment: party hosts', '---', '# Niche', 'Bingo cards', '', evidence(o), '## Price range', 'USD ' + (o.lo || '7.50') + '–' + (o.hi || '9.99') + ' (https://www.etsy.com/listing/101)', '', '## Design direction', 'Original winter icons in a flat style.', ''].join('\n');

async function png(file, w, h) { await sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toFile(file); }
async function jpg(file, w, h) { await sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 120, b: 30 } } }).jpeg().toFile(file); }

// a complete digital room: brief, set-v1 (3 files + design.md), prepared manifest, approved QA records, listing filled by the price script
async function room({ mutateFiles, design = 'Prompt: flat winter icons, no text. Self-check: original, no trademarks, no named style, no real person.', cfg = cfgApproved(), briefOpts = {}, qa = (r) => r, listing = (l) => l, fill = true } = {}) {
  const dir = tempDir('dig-'); useJail(createJail({ dataRoot: dir, extraRoots: [], legacyRoots: [] })); const w = path.join(dir, 'jobs', ID), sd = path.join(w, 'set-v1'), fd = path.join(sd, 'files'), out = path.join(dir, 'jobs', ID, 'outbox');
  fs.mkdirSync(fd, { recursive: true }); fs.mkdirSync(path.join(w, 'qa'), { recursive: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(w, 'brief.md'), brief(briefOpts));
  await png(path.join(fd, '01-card.png'), 300, 400); await png(path.join(fd, '02-card.png'), 300, 400); await jpg(path.join(fd, '03-cover.jpg'), 200, 100);
  if (mutateFiles) await mutateFiles(fd);
  fs.writeFileSync(path.join(sd, 'design.md'), design);
  const prep = prepareDigitalSet({ roomDir: dir, id: ID, n: 1, cfg });
  const rec = qa({ stage: 'design', listingId: ID, pass: 1, verdict: 'approved', designFile: 'jobs/' + ID + '/set-v1/deliverables.json', manifestSha256: fs.readFileSync(path.join(sd, 'deliverables.sha256'), 'utf8').trim(),
    checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', complete: 'pass', usable: 'pass', matchesSpec: 'pass', worthThePrice: 'pass', licence: 'pass' },
    worthThePrice: { verdict: 'pass', reason: 'Two cards and a cover at the top-five price level, cleaner layout.' }, reasons: [], reviewer: 'QA DESIGN' });
  fs.writeFileSync(path.join(w, 'qa', 'design-pass1.json'), JSON.stringify(rec)); fs.writeFileSync(path.join(out, 'qa-design.json'), JSON.stringify(rec));
  const d = cfg.digital;
  fs.writeFileSync(path.join(out, 'listing.json'), JSON.stringify(listing({ listingId: ID, productKey: 'bingo-set', designFile: 'jobs/' + ID + '/set-v1/deliverables.json', title: 'Winter Bingo Cards Printable Digital Download', tags: ['winter bingo', 'party game printable'],
    description: 'Two bingo cards and a cover, PNG and JPG.\n\n' + d.listingNotice + '\n\n' + d.licences['personal-use'].listingText + '\n\n' + AI, altText: 'Two winter bingo cards', ownerTodo: ['confirm price'] })));
  if (fill) { const r = fillDigitalPrices({ id: ID, roomDir: dir, cfg, products: [PRODUCT] }); assert.equal(r.ok, true, r.reason); }
  fs.writeFileSync(path.join(out, 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: ID, pass: 1, verdict: 'approved', designFile: 'jobs/' + ID + '/set-v1/deliverables.json', checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', matchesFiles: 'pass', limits: 'pass' }, reasons: [], reviewer: 'QA LISTING' }));
  return { dir, prep, cfg, out, sd, fd };
}
const gate = (r, extra = {}) => checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg: r.cfg, products: [PRODUCT], ...extra }).reasons;
const done = (r) => fs.rmSync(r.dir, { recursive: true, force: true });

test('config: productType is digital; POD sections are archived; digital limits come from Etsy Help with a date', () => {
  assert.equal(config.productType, process.env.STATION_PRODUCT_TYPE || 'digital');
  const lim = config.digital.etsyFileLimits;
  assert.equal(lim.maxFiles, 5); assert.equal(lim.maxFileBytes, 20000000); assert.match(lim.source, /help\.etsy\.com/); assert.match(lim.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(config.digital.delivery, 'automatic download');
  // owner, 2026-10-16: the commercial-content wording is approved for the prop pack; the two older drafts stay unapproved
  for (const [k, l] of Object.entries(config.digital.licences)) { (k === 'commercial-content' ? assert.match : assert.doesNotMatch)(l.status, /^owner-(approved|confirmed)/i, k); assert.match(l.listingText, /^License:/, 'US spelling'); assert.doesNotMatch(l.listingText, new RegExp(config.digital.forbiddenClaims.pattern, 'i'), k); }
  const gen = config.digital.assetRegister.assets['generator:openai/gpt-5-image-mini'];
  assert.equal(gen.commercialUse, true); assert.match(gen.status, /^owner-confirmed 2026-10-16/); assert.match(gen.terms, /Customer owns all Output; OpenAI assigns all its right, title and interest, if any, in Output\./); assert.match(gen.ownerTodo, /OpenRouter/);
  assert.match(config.digital.licences['commercial-content'].listingText, /livestreams, videos, VTuber\/PNGTuber models, overlays, thumbnails and games, with no credit required\. You may not resell, share or redistribute the files, alone or in a bundle; use them on merchandise or print-on-demand products; or claim them as your own work\.$/);
  assert.equal(config.digital.aiDisclosure.text, 'Created by the seller using AI image generation tools. Each file is selected, cleaned up and quality-checked by the seller before listing.');
  assert.match(config.digital.listingNoticeStatus, /^DRAFT/);
  assert.ok(config.digital.formats.allowed.includes('zip') && !config.digital.formats.notYet.zip, 'zip delivery is built (owner go 2026-10-16)');
});

test('files: format from the bytes, pixel size from the headers (PNG and JPEG), fonts recognised', async () => {
  const dir = tempDir('df-');
  await png(path.join(dir, 'a.png'), 123, 45); await jpg(path.join(dir, 'b.jpg'), 640, 480);
  assert.deepEqual(imageSize(fs.readFileSync(path.join(dir, 'a.png'))), { widthPx: 123, heightPx: 45 });
  const m = measureFile(path.join(dir, 'b.jpg')); assert.equal(m.format, 'jpg'); assert.equal(m.widthPx, 640); assert.equal(m.heightPx, 480);
  assert.equal(formatOf(Buffer.from([0, 1, 0, 0, 0, 0])), 'ttf'); assert.equal(formatOf(Buffer.from('OTTO....')), 'otf'); assert.equal(formatOf(Buffer.from('wOF2....')), 'woff2'); assert.equal(formatOf(Buffer.from('%PDF-1.7')), 'pdf');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prep: the manifest, its sha256 and the originality record are written once (idempotent); a missing design.md blocks QA DESIGN via the hook', async () => {
  const r = await room({ fill: false });
  try {
    assert.equal(r.prep.ok, true); assert.equal(r.prep.manifest.count, 3); assert.deepEqual(r.prep.manifest.assets, ['generator:openai/gpt-5-image-mini']);
    const before = fs.readFileSync(path.join(r.sd, 'deliverables.json'), 'utf8');
    assert.equal(prepareDigitalSet({ roomDir: r.dir, id: ID, n: 1, cfg: r.cfg }).ok, true); assert.equal(fs.readFileSync(path.join(r.sd, 'deliverables.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(r.sd, 'deliverables.sha256'), 'utf8').trim(), sha256File(path.join(r.sd, 'deliverables.json')));
    // a new set without design.md: the hook blocks QA DESIGN
    const s2 = path.join(r.dir, 'jobs', ID, 'set-v2', 'files'); fs.mkdirSync(s2, { recursive: true }); await png(path.join(s2, 'x.png'), 10, 10);
    assert.deepEqual(pendingSet(r.dir), { id: ID, n: 2 });
    const res = runDigitalDesignHook({ payload: { hook_event_name: 'pre_llm_call', extra: { agent_id: 'qa' } }, roomDir: r.dir, qaDesignAgentId: 'qa', cfg: r.cfg });
    assert.equal(res.decision, 'block'); assert.match(res.reason, /design\.md is missing/);
    assert.equal(runDigitalDesignHook({ payload: { hook_event_name: 'pre_llm_call', extra: { agent_id: 'lister' } }, roomDir: r.dir, qaDesignAgentId: 'qa', cfg: r.cfg }), null, 'other agents: no opinion');
  } finally { done(r); }
});

test('gate: a complete, approved, owner-signed unpackaged set passes all but the clean-up claim; the price fill is idempotent', async () => {
  const r = await room();
  try {
    // the owner's AI disclosure says every file is cleaned up: true only for a product the station builds (digital-build.test.mjs has the passing package)
    const g = gate(r); assert.equal(g.length, 1, g.join(' | ')); assert.match(g[0], /AI disclosure says each file is cleaned up, but product "bingo-set" has no station clean-up step/);
    const L = JSON.parse(fs.readFileSync(path.join(r.out, 'listing.json'), 'utf8'));
    assert.equal(L.delivery, 'automatic download'); assert.equal(L.licence, 'personal-use'); assert.equal(L.deliverables.length, 3); assert.deepEqual(L.deliverables[2], { name: '03-cover.jpg', format: 'jpg', widthPx: 200, heightPx: 100 });
    assert.equal(L.variantPricesEur[0].priceEur, Math.round(9.99 * config.fx.usdToEur * 100) / 100); assert.ok(L.marginEstimate.minMarginEur > 5);
    assert.equal(fillDigitalPrices({ id: ID, roomDir: r.dir, cfg: r.cfg, products: [PRODUCT] }).changed, false);
  } finally { done(r); }
});

test('gate: the real DRAFT notice and the unapproved personal-use licence block; the owner-confirmed image generator does not', async () => {
  const r = await room({ cfg: { ...structuredClone(config), productType: 'digital' } });
  try { const g = gate(r).join(' | '); assert.match(g, /notice wording is not owner-approved/); assert.match(g, /licence "personal-use" wording is not owner-approved/); assert.doesNotMatch(g, /generator:openai\/gpt-5-image-mini/); } finally { done(r); }
});

test('gate: Etsy limits: more than 5 files, a file over the size limit, a font file, an unbuildable format each fail', async () => {
  const many = await room({ mutateFiles: async (fd) => { for (const n of [4, 5, 6]) await png(path.join(fd, '0' + n + '-x.png'), 10, 10); } });
  try { assert.match(gate(many).join(' | '), /6 files: Etsy allows at most 5/); } finally { done(many); }
  const big = await room();
  try { big.cfg.digital.etsyFileLimits.maxFileBytes = 500; assert.match(gate(big).join(' | '), /Etsy allows at most 20 MB per file/); } finally { done(big); }
  const font = await room({ mutateFiles: async (fd) => fs.writeFileSync(path.join(fd, '04-font.ttf'), Buffer.from([0, 1, 0, 0, 1, 2, 3])) });
  try { assert.match(gate(font).join(' | '), /font file \(ttf\): font files are never delivered/); } finally { done(font); }
  const pdf = await room({ mutateFiles: async (fd) => fs.writeFileSync(path.join(fd, '04-sheet.pdf'), '%PDF-1.7 test') });
  try { assert.match(gate(pdf).join(' | '), /not a format the station can build and measure/); } finally { done(pdf); }
});

test('gate: the set must match the product spec exactly, and the files must be the ones QA approved', async () => {
  const wrong = await room({ mutateFiles: async (fd) => { fs.unlinkSync(path.join(fd, '03-cover.jpg')); await jpg(path.join(fd, '03-cover.jpg'), 201, 100); } });
  try { const g = gate(wrong).join(' | '); assert.match(g, /missing a file the product spec lists: jpg 200x100 px/); assert.match(g, /does not list: jpg 201x100 px/); } finally { done(wrong); }
  const changed = await room();
  try { await png(path.join(changed.fd, '01-card.png'), 300, 401); assert.match(gate(changed).join(' | '), /have changed since the manifest was written/); } finally { done(changed); }
  const other = await room({ qa: (q) => ({ ...q, manifestSha256: 'abc' }) });
  try { assert.match(gate(other).join(' | '), /did not review this exact set/); } finally { done(other); }
});

test('gate: QA DESIGN must pass complete, usable, matchesSpec, licence and worth-the-price, with a written reason', async () => {
  const r = await room({ qa: (q) => { const { worthThePrice, ...rest } = q; return { ...rest, checks: { ...q.checks, usable: undefined } }; } });
  try { const g = gate(r).join(' | '); assert.match(g, /check "usable" is missing/); assert.match(g, /worthThePrice needs verdict "pass" and a written reason/); } finally { done(r); }
});

test('gate: originality of the prompts, and assets outside the register, block the package', async () => {
  const r = await room({ design: 'Prompt: a mouse mascot like Mickey Mouse, no text.' });
  try { assert.match(gate(r).join(' | '), /originality: design\.md: "Mickey Mouse"/i); } finally { done(r); }
  const a = await room({ mutateFiles: async (fd) => fs.writeFileSync(path.join(path.dirname(fd), 'assets.json'), JSON.stringify({ assets: ['stock:some-texture-pack'] })) });
  try { assert.match(gate(a).join(' | '), /asset "stock:some-texture-pack" is not in config\.digital\.assetRegister/); } finally { done(a); }
});

test('gate: the listing must state the files exactly, carry the notice and license word for word, and make no link, shipping or physical claim', async () => {
  const r = await room();
  try {
    const lf = path.join(r.out, 'listing.json'), L = JSON.parse(fs.readFileSync(lf, 'utf8'));
    fs.writeFileSync(lf, JSON.stringify({ ...L, deliverables: L.deliverables.slice(0, 2), description: 'Two cards. Ships fast. Get them at https://example.com\n\n' + AI }));
    const g = gate(r).join(' | ');
    assert.match(g, /do not match the approved set exactly/); assert.match(g, /lacks the digital-download notice/); assert.match(g, /lacks the license terms|lacks the licence terms/); assert.match(g, /contains a link/); assert.match(g, /shipping or physical-item claim/);
  } finally { done(r); }
});

test('demand evidence: a complete section passes; every missing or UNKNOWN item fails the brief', () => {
  const today = new Date('2026-10-16T12:00:00Z');
  const ok = demandEvidenceProblems(brief(), { today }); assert.equal(ok.ok, true, ok.problems.join('; ')); assert.equal(ok.evidence.count, 8460); assert.equal(ok.evidence.rows.length, 5); assert.equal(ok.evidence.saturation.verdict, 'medium');
  assert.match(demandEvidenceProblems('# Niche\nx', { today }).problems.join(), /no "## Demand evidence" section/);
  assert.match(demandEvidenceProblems(brief({ count: 'UNKNOWN' }), { today }).problems.join(), /UNKNOWN/);
  assert.match(demandEvidenceProblems(brief({ rows: 4 }), { today }).problems.join(), /4 row\(s\), needs 5/);
  assert.match(demandEvidenceProblems(brief({ badge: 'maybe' }), { today }).problems.join(), /bestseller must be yes or no/);
  assert.match(demandEvidenceProblems(brief({ reviews: 'lots' }), { today }).problems.join(), /review count must be digits/);
  assert.match(demandEvidenceProblems(brief({ url: 'https://example.com/listing/1' }), { today }).problems.join(), /etsy\.com\/listing/);
  assert.match(demandEvidenceProblems(brief({ sat: 'medium' }), { today }).problems.join(), /saturation must be/);
  assert.match(demandEvidenceProblems(brief({ checked: '2026-08-01' }), { today }).problems.join(), /days old/);
  assert.match(demandEvidenceProblems(brief({ price: '4.99' }), { today }).problems.join(), /currency code and a number/);
});

test('demand evidence: owner-recorded evidence (marker line, notes column) is accepted with the same required items; the owner price line is parsed', () => {
  const today = new Date('2026-10-16T12:00:00Z');
  const owned = brief().replace('## Demand evidence\n', '## Demand evidence\nrecorded by owner, 2026-10-16\n').replace(/(listing\/10\d) \|$/gm, '$1 | ad; rating 5.0 |');
  const ok = demandEvidenceProblems(owned, { today }); assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.equal(ok.evidence.recordedBy, 'owner'); assert.equal(ok.evidence.recordedOn, '2026-10-16'); assert.equal(ok.evidence.rows[0].notes, 'ad; rating 5.0');
  assert.equal(demandEvidenceProblems(brief(), { today }).evidence.recordedBy, 'researcher');
  assert.match(demandEvidenceProblems(owned.replace('recorded by owner, 2026-10-16', 'recorded by owner'), { today }).problems.join(), /owner marker must read/);
  assert.match(demandEvidenceProblems(owned.replace('https://www.etsy.com/listing/101 |', 'TO ADD (owner) |'), { today }).problems.join(), /row 1: URL/);
  const withPrice = (line) => brief().replace('## Price range\n', '## Price range\n' + line + '\n');
  assert.deepEqual(ownerPrice(withPrice('owner price: EUR 7.00–12.00 (recorded by owner, 2026-10-16)')), { currency: 'EUR', min: 7, max: 12, date: '2026-10-16', point: null, pointDate: null });
  const both = 'owner price: EUR 7.00–12.00 (recorded by owner, 2026-10-16)\nowner price point: EUR 9.00 (recorded by owner, 2026-10-16)';
  assert.deepEqual(ownerPrice(withPrice(both)), { currency: 'EUR', min: 7, max: 12, date: '2026-10-16', point: 9, pointDate: '2026-10-16' });
  assert.match(ownerPrice(withPrice(both.replace('EUR 9.00', 'EUR 13.90'))).problem, /outside the owner price/);
  assert.match(ownerPrice(withPrice(both.replace('EUR 9.00 (recorded by owner, 2026-10-16)', 'EUR 9'))).problem, /owner price point must read/);
  // Etsy's capped result count is a lower bound
  const capped = demandEvidenceProblems(owned.replace('competitor count: 8,460', 'competitor count: 1,000+ items'), { today });
  assert.equal(capped.ok, true, capped.problems.join('; ')); assert.equal(capped.evidence.count, 1000); assert.equal(capped.evidence.countIsLowerBound, true);
  assert.match(demandEvidenceProblems(owned.replace('competitor count: 8,460', 'competitor count: lots'), { today }).problems.join(), /competitor count missing or not a number/);
  assert.equal(ownerPrice(brief()), null);
  assert.match(ownerPrice(withPrice('owner price: about EUR 7')).problem, /must read/);
  assert.match(ownerPrice(withPrice('owner price: EUR 12–7 (recorded by owner, 2026-10-16)')).problem, /above its maximum/);
});

test('keywords: at least 5 sourced phrases (owner Etsy search, or a URL/file listed under ## Sources); unsourced or uncited ones do not count', () => {
  const SRC = '## Sources\n- https://example.org/kw/bingo — keyword volume\n- station-workspace/research-lab/scouting/scout.md — third-party figures\n';
  const kw = (lines) => brief() + '## Keywords\n' + lines.join('\n') + '\n\n' + SRC;
  const five = ['- bingo printable — recorded by owner, 2026-10-16: Etsy search, 1,000+ items', '- party bingo – recorded by owner, 2026-10-16', '- winter bingo — https://example.org/kw/bingo',
    '- holiday bingo — station-workspace/research-lab/scouting/scout.md (third-party).', '- bingo cards — recorded by owner, 2026-10-16'];
  const ok = keywordSourceProblems(kw(five)); assert.equal(ok.ok, true, ok.problems.join('; ')); assert.equal(ok.sourced, 5); assert.equal(ok.keywords[1].phrase, 'party bingo');
  // plus an unsourced extra: still passes (the Evidence Checker removes it), counted as unsourced
  const extra = keywordSourceProblems(kw([...five, '- bingo game'])); assert.equal(extra.ok, true); assert.equal(extra.keywords.length, 6); assert.equal(extra.sourced, 5);
  // four sourced fails; a bare list, an undated owner line, and a URL or file not listed under ## Sources do not count
  assert.match(keywordSourceProblems(kw(five.slice(0, 4))).problems.join(), /4 of 4 keyword\(s\) sourced, needs at least 5/);
  assert.match(keywordSourceProblems(kw(['- a', '- b', '- c', '- d', '- e', '- f'])).problems.join(), /0 of 6/);
  for (const bad of ['- bingo cards — recorded by owner', '- bingo cards — https://example.org/other', '- bingo cards — station-workspace/other.md', '- bingo cards (recorded by owner, 2026-10-16)'])
    assert.match(keywordSourceProblems(kw([...five.slice(0, 4), bad])).problems.join(), /4 of 5/, bad);
  assert.match(keywordSourceProblems(brief()).problems.join(), /no "## Keywords" section/);
});
