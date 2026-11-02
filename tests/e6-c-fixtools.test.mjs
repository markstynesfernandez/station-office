// e6-c-fixtools.test.mjs — the owner fix tools and the post-fix approval rule (owner decisions, 18/10/2026; DECISIONS.md "E6 step c: owner
// fix tools, post-fix approval rule"): the region edit (fill with a sampled colour, recolour to a sampled colour, clear), the $0 rebuild
// and check, the post-fix rule's conditions (a)-(d), the owner script's --from, the live --listing-only / --qa-only arguments.
// Station code only: no model, no network, a fake upscaler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { useJail } from '../src/engine/store/active.mjs';
import { mockPng } from '../src/engine/providers/mock.mjs';
import { recordDecision } from '../src/engine/lib/style-ref.mjs';
import { selectRegion, applyRegionEdits, sampleAround, sampleBox } from '../src/engine/lib/region-edit.mjs';
import { nearWhiteFills, enclosedBackgroundRegions, ENCLOSED_DEFAULTS } from '../src/engine/lib/digital-build.mjs';
import { designSignOff } from '../src/engine/lib/owner-approval.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const ID = '2026-10-17--cozy-autumn-desk-props';
const OWNER = fs.readFileSync(path.join(APP_ROOT, 'fixtures', 'engine', 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
const NAMES = ['01-small-pumpkin', '02-book-stack', '03-cider-mug', '04-beeswax-candle', '05-maple-leaf-scatter', '06-knitted-throw', '07-brass-lantern', '08-cinnamon-jar', '09-acorn-pinecone', '10-teapot', '11-ghost-plush', '12-desk-lamp'].map((n) => n + '.png');
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });

// a 96x96 RGBA canvas
function canvas(W = 96, H = 96) {
  const d = Buffer.alloc(W * H * 4);
  const rect = (x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const i = (yy * W + xx) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3] ?? 255; } };
  return { d, W, H, rect, at: (x, y) => [...d.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)] };
}
// the teapot's two findings in miniature: an enclosed near-white highlight A (24x24) inside a cream-orange body, and a near-white
// steam B (30x20, its soft edge at alpha 90) clear of the body
function teapot() {
  const c = canvas();
  c.rect(10, 34, 60, 56, [214, 150, 96]);
  c.rect(28, 50, 24, 24, [250, 248, 245]);
  c.rect(59, 3, 32, 22, [246, 244, 240, 90]); c.rect(60, 4, 30, 20, [250, 248, 244]);
  return c;
}
const png = (c) => sharp(c.d, { raw: { width: c.W, height: c.H, channels: 4 } }).png().toBuffer();
const BOX_A = [28, 50, 24, 24], BOX_B = [60, 4, 30, 20];

test('region edit: fill with the colour around a region, recolour to a sampled colour (alpha and shape kept, soft edge included), clear', () => {
  const c = teapot(), opts = { enclosed: ENCLOSED_DEFAULTS };
  assert.deepEqual(enclosedBackgroundRegions(Buffer.from(c.d), 96, 96, ENCLOSED_DEFAULTS).map((r) => r.box), [BOX_A]);
  assert.deepEqual(nearWhiteFills(c.d, 96, 96, {}).map((r) => r.box).sort(), [BOX_B, BOX_A].sort());
  const A = selectRegion(c.d, 96, 96, { kind: 'enclosed', box: BOX_A }, opts), B = selectRegion(c.d, 96, 96, { kind: 'near-white', box: BOX_B }, { spread: true });
  assert.equal(A.selectedPx, 576); assert.equal(B.px, 600); assert.equal(B.selectedPx, 704, 'the soft edge (alpha 90) is part of the steam');
  assert.match(selectRegion(c.d, 96, 96, { kind: 'enclosed', box: [0, 0, 5, 5] }, opts).problem, /no enclosed region at box 0,0,5,5/);
  const around = sampleAround(c.d, 96, 96, A.members);
  assert.deepEqual(around.rgb, [214, 150, 96], 'the body around the highlight');
  const mug = canvas(); mug.rect(10, 10, 20, 20, [242, 224, 192]);
  assert.deepEqual(sampleBox(mug.d, 96, 96, [5, 5, 30, 30]).rgb, [242, 224, 192]);
  const r = applyRegionEdits(c.d, 96, 96, [{ label: 'A', select: { kind: 'enclosed', box: BOX_A }, action: 'fill' }, { label: 'B', select: { kind: 'near-white', box: BOX_B }, action: 'recolour' }],
    { A: around, B: { rgb: [242, 224, 192] } }, opts);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(c.at(40, 60), [214, 150, 96, 255], 'A filled with the body colour');
  assert.deepEqual(c.at(70, 10).slice(3), [255]); assert.deepEqual(c.at(59, 3)[3], 90, 'alpha unchanged');
  const px = c.at(70, 10); assert.ok(Math.max(...px.slice(0, 3)) - Math.min(...px.slice(0, 3)) > 24, 'the steam passes the palette rule now: ' + px.slice(0, 3));
  assert.deepEqual(r.facts.map((f) => [f.label, f.action, f.changedPx]), [['A', 'fill', 576], ['B', 'recolour', 704]]);
  assert.deepEqual(nearWhiteFills(c.d, 96, 96, {}), [], 'no near-white fill left');
  assert.deepEqual(enclosedBackgroundRegions(Buffer.from(c.d), 96, 96, ENCLOSED_DEFAULTS), [], 'no enclosed region left');
  // clear: alpha 0, colour 0
  const k = teapot(), rc = applyRegionEdits(k.d, 96, 96, [{ label: 'A', select: { kind: 'enclosed', box: BOX_A }, action: 'clear' }], {}, opts);
  assert.equal(rc.ok, true); assert.deepEqual(k.at(40, 60), [0, 0, 0, 0]);
  assert.match(applyRegionEdits(teapot().d, 96, 96, [{ label: 'A', select: { kind: 'enclosed', box: BOX_A }, action: 'fill' }], {}, opts).reason, /A: fill needs a sampled colour/);
});

test('owner amendment: a sampled colour lightened to just under the near-white rule keeps a soft highlight; lighten/darken by a fraction', async () => {
  const { adjustColour } = await import('../src/engine/lib/region-edit.mjs');
  const a = adjustColour([214, 150, 96], { lighten: 'max-under-near-white' });
  assert.deepEqual(a.rgb, [246, 233, 221]); assert.equal(a.blend, 0.789);
  assert.equal(Math.max(...a.rgb) - Math.min(...a.rgb), 25, 'the channel spread is just above the rule\'s 24');
  const next = [214, 150, 96].map((v) => Math.round(v + 0.79 * (255 - v)));
  assert.ok(Math.max(...next) - Math.min(...next) <= 24, 'one step lighter would be near-white: ' + next);
  assert.deepEqual(adjustColour([200, 100, 50], { lighten: 0.5 }).rgb, [228, 178, 153]); assert.deepEqual(adjustColour([200, 100, 50], { darken: 0.5 }).rgb, [100, 50, 25]);
  assert.match(adjustColour([250, 248, 245], { lighten: 'max-under-near-white' }).problem, /already near-white/);
  assert.match(adjustColour([1, 2, 3], { lighten: 2 }).problem, /between 0 and 1/);
  // region A recoloured to that colour: a soft highlight stays (lighter than the body, its own shading kept), and the rule passes
  const c = teapot(); for (let x = 28; x < 52; x++) for (let y = 50; y < 74; y++) { const i = (y * 96 + x) * 4, v = x < 40 ? 252 : 246; c.d[i] = v; c.d[i + 1] = v - 3; c.d[i + 2] = v - 8; }
  const opts = { enclosed: ENCLOSED_DEFAULTS }, A = selectRegion(c.d, 96, 96, { kind: 'enclosed', box: BOX_A }, opts), around = sampleAround(c.d, 96, 96, A.members);
  const r = applyRegionEdits(c.d, 96, 96, [{ label: 'A', select: { kind: 'enclosed', box: BOX_A }, action: 'recolour', spread: false }], { A: { rgb: adjustColour(around.rgb, { lighten: 'max-under-near-white' }).rgb } }, opts);
  assert.equal(r.ok, true, r.reason); assert.equal(r.facts[0].changedPx, 576, 'only the highlight (spread off: the body is not touched)');
  assert.deepEqual(c.at(15, 40), [214, 150, 96, 255], 'the body is unchanged');
  const l = c.at(30, 60), d2 = c.at(45, 60);
  assert.ok(l[0] > d2[0], 'the highlight keeps its own light and shade'); assert.ok(l[1] > 150 && d2[1] > 150, 'lighter than the body');
  assert.deepEqual(nearWhiteFills(c.d, 96, 96, {}).filter((f) => f.box.join() === BOX_A.join()), [], 'not a near-white fill');
  assert.deepEqual(enclosedBackgroundRegions(Buffer.from(c.d), 96, 96, ENCLOSED_DEFAULTS), [], 'not an enclosed background-like region');
});

// a rejected job at the end of design loop 2: file 1 approved (set-v1), set-v2 built from raw, QA DESIGN pass 1 revise (originality pass)
async function fixJob(t, { originality = 'pass' } = {}) {
  const r = tempRoot('fixtools'); t.after(r.cleanup);
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan }); t.after(() => e.close());
  // the test images are 96 px: the build's "enlarged over 4x" warning would fire on every file; this engine only raises that threshold
  e.cfg.station.digital.build.maxUpscaleWarn = 50;
  useJail(r.J);
  const d = path.join(r.dataRoot, 'jobs', ID), put = (rel, buf) => r.J.put(path.join(d, rel), buf);
  e.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'cozy autumn', product_key: 'pngtuber-prop-pack', state: 'rejected', step: 'rejects-desk', data: { createdBy: 'test' } });
  put('brief.md', OWNER);
  const p1 = await mockPng({ prompt: 'pumpkin', width: 96, height: 96, transparent: true });
  put('set-v1/raw/01-small-pumpkin.png', p1);
  assert.equal(recordDecision({ roomDir: r.dataRoot, id: ID, status: 'approved', date: '2026-10-18', n: 1 }).ok, true);
  const mug = canvas(); mug.rect(20, 20, 50, 60, [214, 150, 96]); mug.rect(30, 4, 6, 14, [242, 224, 192]);
  for (const n of NAMES) put('set-v2/raw/' + n, n.startsWith('01-') ? p1 : n.startsWith('10-') ? await png(teapot()) : n.startsWith('03-') ? await png(mug) : await mockPng({ prompt: n, width: 96, height: 96, transparent: true }));
  put('set-v2/design.md', '# Design plan, set-v2\n\n## Prompts\n' + NAMES.map((n) => '### ' + n.replace('.png', '') + '\nPrompt for ' + n.replace('.png', '') + '.').join('\n\n') + '\n\n## Originality self-check\n- original\n');
  put('qa/design-pass1.json', JSON.stringify({ stage: 'design', listingId: ID, pass: 1, verdict: 'revise', designFile: 'jobs/' + ID + '/set-v2/deliverables.json', checks: { originality, trademarks: 'pass', usable: 'fail' }, reasons: ['usable 10-teapot: build warnings'] }) + '\n');
  return { e, r, d, v: () => e.store.getJob(ID).version };
}
const PLAN = { authorisedBy: 'owner', date: '2026-10-18', edits: [{ file: '10-teapot.png', op: 'region', why: 'owner decisions 1-2, 18/10/2026', regions: [
  { label: 'A', select: { kind: 'enclosed', box: BOX_A }, action: 'recolour', spread: false, sample: { around: true, ringPx: 6, adjust: { lighten: 'max-under-near-white' } }, addresses: 'enclosed background-like region(s) left after the clean-up' },
  { label: 'B', select: { kind: 'near-white', box: BOX_B }, action: 'recolour', sample: { file: '03-cider-mug.png', box: [28, 2, 10, 18] }, addresses: 'near-white fill(s), pure white or grey-white' }] }] };

test('rebuild and check at $0, the region edit through edit-set (only build-check findings), and the after previews', async (t) => {
  const { e, d, v } = await fixJob(t);
  const b0 = await e.orchestrator.rebuildSet(ID, { set: 2, expectedVersion: v() });
  assert.equal(b0.originality, 'clear'); assert.equal(b0.briefMatch.checked, true); assert.deepEqual(b0.briefMatch.problems, []);
  const w0 = b0.manifest.buildWarnings.filter((x) => x.startsWith('10-teapot.png'));
  assert.ok(w0.some((x) => /enclosed background-like region/.test(x)) && w0.some((x) => /near-white fill/.test(x)), w0.join(' | '));
  assert.deepEqual(b0.previews, [], 'no fix yet: no after previews');
  assert.match(fs.readFileSync(path.join(d, 'set-v2', 'design.md'), 'utf8'), /^## Station plan/m, 'the rebuild writes the current plan');
  // a region that quotes no build warning is refused (only build-check findings)
  await assert.rejects(e.owner.editSet(ID, { set: 2, plan: { ...PLAN, edits: [{ ...PLAN.edits[0], regions: [{ ...PLAN.edits[0].regions[0], addresses: 'the lid looks odd' }] }] }, expectedVersion: v() }), /"the lid looks odd" is not a build-check finding of 10-teapot\.png/);
  const ed = await e.owner.editSet(ID, { set: 2, plan: PLAN, expectedVersion: v() });
  assert.deepEqual(ed.actions, [{ file: 'raw/10-teapot.png', action: 'written' }]);
  const rec = JSON.parse(fs.readFileSync(path.join(d, 'set-v2', 'edits.json'), 'utf8')).edits[0];
  assert.equal(rec.op, 'region'); assert.ok(fs.existsSync(path.join(d, 'set-v2', 'raw-original', '10-teapot.png')), 'the Designer\'s original kept');
  assert.deepEqual(rec.facts.regions.map((x) => [x.label, x.action, x.changedPx, x.sample.rgb]), [['A', 'recolour', 576, [246, 233, 221]], ['B', 'recolour', 704, [242, 224, 192]]]);
  assert.deepEqual([rec.facts.regions[0].sample.sampledRgb, rec.facts.regions[0].sample.blend], [[214, 150, 96], 0.789], 'the lid colour, lightened to just under the near-white rule');
  assert.match(rec.facts.regions[1].sample.from, /^raw\/03-cider-mug\.png box 28,2,10,18$/); assert.match(rec.facts.regions[1].sample.sha256, /^[0-9a-f]{64}$/);
  for (const g of rec.regions) assert.ok(g.addressesWarning.startsWith('10-teapot.png: '), 'the full build warning is recorded');
  // rebuilt: no warnings for file 10 any more; the after previews: on each background and a crop per region, tied to the built bytes
  const b1 = await e.orchestrator.rebuildSet(ID, { set: 2, expectedVersion: v() });
  assert.deepEqual(b1.manifest.buildWarnings.filter((x) => x.startsWith('10-teapot.png')), []);
  assert.equal(b1.previews.length, 1); assert.equal(b1.previews[0].record, 'set-v2/review-after/10-teapot.preview.json');
  assert.deepEqual(b1.previews[0].images.map((x) => path.basename(x)).sort(), ['10-teapot-A-on-dark.png', '10-teapot-A-on-white.png', '10-teapot-B-on-dark.png', '10-teapot-B-on-white.png', '10-teapot-on-dark.png', '10-teapot-on-white.png']);
  for (const f of b1.previews[0].images) assert.ok(fs.existsSync(path.join(e.J.dataRoot, f)), f);
  // the same edit again changes nothing (its warnings are gone, its record still quotes them)
  assert.deepEqual((await e.owner.editSet(ID, { set: 2, plan: PLAN, expectedVersion: v() })).actions, [{ file: 'raw/10-teapot.png', action: 'unchanged' }]);
});

// every file decided, the fix applied and the set rebuilt: what the post-fix rule needs before the owner's approval
async function readyForApproval(t, opts) {
  const j = await fixJob(t, opts), { e, v } = j;
  await e.orchestrator.rebuildSet(ID, { set: 2, expectedVersion: v() });
  await e.owner.editSet(ID, { set: 2, plan: PLAN, expectedVersion: v() });
  const b = await e.orchestrator.rebuildSet(ID, { set: 2, expectedVersion: v() });
  for (const n of NAMES) e.owner.recordFileDecision(ID, n.startsWith('10-') ? { set: 2, name: n, decision: 'fix', fix: 'region A filled with the lid colour, steam B recoloured to the mug steam', date: '2026-10-18', expectedVersion: v() } : { set: 2, name: n, decision: 'approved', reason: 'owner reviewed', date: '2026-10-18', expectedVersion: v() });
  return { ...j, b };
}
const approve = (e, v, extra = {}) => e.owner.approveSet(ID, { set: 2, words: 'I reviewed the after previews of file 10 on white and dark: approved.', worthThePrice: 'a matched 12-prop pack', rule: 'post-fix', reviewedPreviews: ['set-v2/review-after/10-teapot.preview.json'], date: '2026-10-18', expectedVersion: v(), ...extra });

test('decision 3: the post-fix rule lets the owner approve before the pass limit when (a)-(d) hold; the gate accepts it', async (t) => {
  const { e, r, v, b } = await readyForApproval(t);
  assert.deepEqual(b.manifest.buildWarnings, []); assert.deepEqual(b.manifest.limitProblems, []);
  // without the rule: the pass limit (1 of 3 passes on disk)
  assert.throws(() => e.owner.approveSet(ID, { set: 2, words: 'approved', date: '2026-10-18', expectedVersion: v() }), /only at the pass limit: 1 of 3 design passes on disk/);
  const a = approve(e, v);
  assert.equal(a.action, 'set-approval');
  const rec = JSON.parse(fs.readFileSync(path.join(r.dataRoot, 'jobs', ID, 'owner-set-approval.json'), 'utf8'));
  assert.equal(rec.rule, 'post-fix'); assert.match(rec.inPlaceOf, /owner post-fix rule, 18\/10\/2026/);
  assert.deepEqual(rec.counts, { 'qa-pass': 11, 'owner-override': 0, 'deterministic-fix': 1 });
  const so = designSignOff({ id: ID, roomDir: r.dataRoot, cfg: e.cfg.station });
  assert.equal(so.ok, true, so.reasons.join('; ')); assert.equal(so.source, 'owner-set-approval');
});

test('decision 3: each condition refuses on its own: (a) originality, (b) not rebuilt or warnings left, (c) brief match, (d) previews not reviewed or stale; never a non-build fix', async (t) => {
  // (a) originality did not pass on the previous QA pass
  {
    const { e, v } = await readyForApproval(t, { originality: 'fail' });
    assert.throws(() => approve(e, v), /post-fix rule \(a\): originality did not pass on the previous QA DESIGN pass \(qa\/design-pass1\.json: fail\)/);
  }
  // (b) a fix applied but not rebuilt; and build warnings left in the set are never overridden
  {
    const { e, d, v } = await fixJob(t);
    await e.orchestrator.rebuildSet(ID, { set: 2, expectedVersion: v() });
    await e.owner.editSet(ID, { set: 2, plan: PLAN, expectedVersion: v() });
    for (const n of NAMES) e.owner.recordFileDecision(ID, n.startsWith('10-') ? { set: 2, name: n, decision: 'fix', fix: 'regions A and B', date: '2026-10-18', expectedVersion: v() } : { set: 2, name: n, decision: 'approved', date: '2026-10-18', expectedVersion: v() });
    const err = (() => { try { approve(e, v); return ''; } catch (x) { return x.message; } })();
    assert.match(err, /post-fix rule \(b\): set-v2 was not rebuilt after the fix of 10-teapot\.png/); assert.match(err, /the manifest has build warnings: 10-teapot\.png/);
    assert.ok(fs.existsSync(path.join(d, 'set-v2', 'edits.json')));
  }
  // (c) a file that no longer matches the brief
  {
    const { e, d, v } = await readyForApproval(t);
    fs.renameSync(path.join(d, 'set-v2', 'raw', '05-maple-leaf-scatter.png'), path.join(d, 'set-v2', 'raw', '05-pine-wreath.png'));
    assert.throws(() => approve(e, v), /post-fix rule \(c\): file 05-pine-wreath\.png does not match the brief's item 5/);
  }
  // (d) the previews not listed as reviewed, or stale after another build
  {
    const { e, d, v } = await readyForApproval(t);
    assert.throws(() => approve(e, v, { reviewedPreviews: [] }), /post-fix rule \(d\): the owner has not listed the after previews of 10-teapot\.png \(set-v2\/review-after\/10-teapot\.preview\.json\) as reviewed/);
    const pf = path.join(d, 'set-v2', 'review-after', '10-teapot.preview.json'), p = JSON.parse(fs.readFileSync(pf, 'utf8'));
    fs.writeFileSync(pf, JSON.stringify({ ...p, builtSha256: '0'.repeat(64) }));
    assert.throws(() => approve(e, v), /post-fix rule \(d\): the after previews of 10-teapot\.png are for another build/);
  }
  // only build-check findings: a recolour/outline edit (not a region fix of a build warning) never qualifies
  {
    const { e, d, v } = await readyForApproval(t);
    const ef = path.join(d, 'set-v2', 'edits.json'), ed = JSON.parse(fs.readFileSync(ef, 'utf8'));
    ed.edits[0].regions[0].addressesWarning = ''; fs.writeFileSync(ef, JSON.stringify(ed));
    assert.throws(() => approve(e, v), /post-fix rule: 10-teapot\.png is not a region fix of build-check findings only/);
  }
});

test('the owner script takes its JSON from a file (--from); line-live checks the --listing-only / --qa-only arguments before anything starts', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: APP_ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  const r1 = run(['scripts/owner.mjs', 'show', ID, '--from', 'notes.txt']);
  assert.equal(r1.status, 2); assert.match(r1.stderr, /--from needs a \.json file/);
  const tmp = fs.mkdtempSync(path.join(APP_ROOT, '.tmp-from-')), bad = path.join(tmp, 'bad.json'); fs.writeFileSync(bad, '{ not json');
  try { const r2 = run(['scripts/owner.mjs', 'show', ID, '--from', bad]); assert.equal(r2.status, 2); assert.match(r2.stderr, /the args are not valid JSON/); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.match(run(['scripts/owner.mjs']).stderr, /\[json args \| --from <path\.json>\]/);
  assert.match(run(['scripts/owner.mjs']).stderr, /rebuild/);
  const live = { STATION_PROVIDER: 'live' };
  const l1 = run(['scripts/line-live.mjs', '--listing-only', ID], live); assert.equal(l1.status, 2); assert.match(l1.stderr, /need the owner's cap for the run: --max-usd <USD>/);
  const l2 = run(['scripts/line-live.mjs', '--qa-only', ID, '--max-usd', '1'], live); assert.equal(l2.status, 2); assert.match(l2.stderr, /--qa-only needs --set <N>/);
  const l3 = run(['scripts/line-live.mjs', '--listing-only', ID, '--redraw', ID, '--max-usd', '1'], live); assert.equal(l3.status, 2); assert.match(l3.stderr, /give exactly one of/);
});
