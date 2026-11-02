// PORTED from Virtual-workers/station/tests/prop-edit.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 2e007798ad31d0901788c711399a6cbaae2a0d3d8e5789b3e23de7d7e0d74f8c.
//   change: imports point at src/engine/lib
//   change: each set folder made by setDir is the data root of a data jail (prop-edit writes raw/, raw-original/ and edits.json through it)
// Everything else is the source unchanged.
// prop-edit.test.mjs — owner-authorised deterministic edits of raw files (OWNER exception to the station freeze, 2026-10-17): the recolour that
// makes file 11 from file 1, the outline fix for 07/12, and the edit plan that applies them (originals kept, record written, idempotent).
// Synthetic images in temp folders; no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { recolourByRoles, normaliseOutline, silhouetteOutline, readPlan, applyEditPlan } from '../../src/engine/lib/prop-edit.mjs';
import { sha256 } from '../../src/engine/lib/common.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';

const W = 48, C = 24;
const OUTLINE = [96, 54, 37], CREAM = [249, 222, 175], BAND = [226, 146, 98], STEAM = [252, 231, 187], TAN = [188, 131, 90];
const at = (d, x, y) => [...d.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
const put = (d, x, y, rgb, a = 255) => { const i = (y * W + x) * 4; d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = a; };
const mix = (a, b, s) => a.map((v, c) => Math.round(s * v + (1 - s) * b[c]));
// a "mug": a cream disc with a band and a 5 px outline ring, one ring of 50/50 outline-cream pixels inside the line, and a cream "steam" blob
// with a tan outline at the top-left, on clear pixels
function mug() {
  const d = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - C, y - C);
    if (r < 13) put(d, x, y, y >= 26 && y <= 29 ? BAND : CREAM);
    else if (r < 14) put(d, x, y, mix(OUTLINE, CREAM, 0.5));
    else if (r < 19) put(d, x, y, OUTLINE);
  }
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) put(d, x, y, x === 0 || y === 0 || x === 5 || y === 5 ? TAN : STEAM);
  return d;
}
const SPEC = {
  roles: [
    { name: 'body', from: [[255, 253, 238], [249, 222, 175], [225, 184, 142]], to: [[228, 236, 206], [160, 186, 142], [128, 147, 108]] },
    { name: 'band', from: [[226, 146, 98], [198, 111, 72]], to: [[250, 223, 176], [225, 184, 142]], box: [0, 24, W, 8] },
  ],
  fixed: [{ name: 'outline', rgb: OUTLINE }],
  keep: [{ name: 'steam', seeds: [[2, 2]], minLum: 165, grow: { rgb: TAN, maxDist: 40 } }],
  maxResidual: 20,
};

test('recolour: body and band take their new colours, outline, alpha, clear pixels and the kept steam do not change, an edge blend stays a blend', () => {
  const d = mug(), before = Buffer.from(d), r = recolourByRoles(d, W, W, SPEC);
  assert.deepEqual(at(d, C, C - 5), [160, 186, 142, 255], 'body main -> the sage main');
  assert.deepEqual(at(d, C, 27), [250, 223, 176, 255], 'band -> cream');
  assert.deepEqual(at(d, C, C - 16), [...OUTLINE, 255], 'outline kept');
  assert.deepEqual(at(d, 2, 2), [...STEAM, 255], 'steam fill kept (a cream the body role would otherwise change)');
  assert.deepEqual(at(d, 0, 3), [...TAN, 255], 'steam outline kept');
  assert.deepEqual(at(d, W - 1, W - 1), [0, 0, 0, 0], 'clear pixels untouched');
  for (let i = 3; i < d.length; i += 4) assert.equal(d[i], before[i], 'alpha never changes');
  const edge = at(d, C + 13, C), want = mix(OUTLINE, [160, 186, 142], 0.5);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(edge[c] - want[c]) <= 2, 'the 50/50 outline-cream edge becomes 50/50 outline-sage: ' + edge + ' vs ' + want);
  assert.equal(r.counts.unexplained, 0);
  assert.ok(r.keep.seeds.every((s) => s.ok));
  // the band role applies only inside its box: the same colour outside it is not band
  const e = mug(); put(e, C, 8, BAND); recolourByRoles(e, W, W, SPEC);
  assert.notDeepEqual(at(e, C, 8).slice(0, 3), [250, 223, 176], 'band colour outside the band box is not turned cream');
  // deterministic
  const a = mug(), b = mug(); recolourByRoles(a, W, W, SPEC); recolourByRoles(b, W, W, SPEC); assert.ok(a.equals(b));
  assert.throws(() => recolourByRoles(mug(), W, W, { roles: [{ name: 'x', from: [[1, 2, 3], [4, 5, 6]], to: [[1, 2, 3]] }] }), /same number/);
});

// a cushion: an orange disc, a 50/50 ring, a 5 px red-brown outline
const RED_BROWN = [76, 34, 12], ORANGE = [232, 120, 64];
function cushion(line = RED_BROWN, fill = ORANGE) {
  const d = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const r = Math.hypot(x - C, y - C); if (r < 13) put(d, x, y, fill); else if (r < 14) put(d, x, y, mix(line, fill, 0.5)); else if (r < 19) put(d, x, y, line); }
  return d;
}

test('outline: measured on the silhouette; the line takes the target colour, fills stay, the anti-aliased edge moves by its outline share', () => {
  const like = cushion([106, 63, 44], CREAM), d = cushion(), before = Buffer.from(d);
  const to = silhouetteOutline(like, W, W), from = silhouetteOutline(d, W, W);
  assert.deepEqual(to.rgb, [106, 63, 44]); assert.deepEqual(from.rgb, RED_BROWN);
  const r = normaliseOutline(d, W, W, { from: from.rgb, to: to.rgb });
  assert.deepEqual(at(d, C, C - 16), [106, 63, 44, 255], 'line -> target');
  assert.deepEqual(at(d, C, C), [...ORANGE, 255], 'fill untouched');
  const e = at(d, C + 13, C), want = mix([106, 63, 44], ORANGE, 0.5);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(e[c] - want[c]) <= 2, 'edge moved by half the shift: ' + e + ' vs ' + want);
  for (let i = 3; i < d.length; i += 4) assert.equal(d[i], before[i], 'alpha never changes');
  assert.ok(r.corePx > 0 && r.edgePx > 0);
  assert.equal(silhouetteOutline(Buffer.alloc(W * W * 4), W, W), null, 'nothing to measure on a blank image');
});

const png = (d) => sharp(d, { raw: { width: W, height: W, channels: 4 } }).png().toBuffer();
async function setDir(plan) {
  const sd = tempDir('propedit-'), raw = path.join(sd, 'raw'); fs.mkdirSync(raw); useJail(createJail({ dataRoot: sd, extraRoots: [] }));
  fs.writeFileSync(path.join(raw, '01-mug.png'), await png(mug()));
  fs.writeFileSync(path.join(raw, '07-cat.png'), await png(cushion()));
  fs.writeFileSync(path.join(raw, '11-mug-alt.png'), await png(cushion([10, 10, 10], [200, 200, 200])));   // the Designer's redraw, replaced
  fs.writeFileSync(path.join(sd, 'edit-plan.json'), JSON.stringify(plan));
  return sd;
}
const PLAN = { listingId: '2026-10-16--test-props', set: 1, authorisedBy: 'owner', date: '2026-10-17', edits: [
  { op: 'recolour', file: '11-mug-alt.png', source: '01-mug.png', spec: SPEC, why: 'test' }, { op: 'outline', file: '07-cat.png', like: '01-mug.png', why: 'test' }] };

test('edit plan: dry run writes nothing; apply keeps the originals once, writes the files and the record; a second apply writes nothing', async () => {
  const sd = await setDir(PLAN), raw = path.join(sd, 'raw'), hash = (f) => sha256(fs.readFileSync(path.join(raw, f)));
  try {
    const h11 = hash('11-mug-alt.png'), h07 = hash('07-cat.png'), h01 = hash('01-mug.png');
    const dry = await applyEditPlan({ sd, dry: true });
    assert.ok(dry.ok); assert.deepEqual(dry.actions.map((a) => a.action), ['would-write', 'would-write']);
    assert.ok(!fs.existsSync(path.join(sd, 'raw-original')) && !fs.existsSync(path.join(sd, 'edits.json')) && hash('11-mug-alt.png') === h11);
    const r1 = await applyEditPlan({ sd });
    assert.ok(r1.ok); assert.deepEqual(r1.actions.map((a) => a.action), ['written', 'written']); assert.equal(r1.recordAction, 'written');
    assert.equal(sha256(fs.readFileSync(path.join(sd, 'raw-original', '11-mug-alt.png'))), h11, 'the Designer\'s 11 kept');
    assert.equal(sha256(fs.readFileSync(path.join(sd, 'raw-original', '07-cat.png'))), h07, 'the Designer\'s 07 kept');
    assert.equal(hash('01-mug.png'), h01, 'the source is never changed');
    const rec = JSON.parse(fs.readFileSync(path.join(sd, 'edits.json'), 'utf8'));
    assert.equal(rec.edits[0].source.sha256, h01); assert.equal(rec.edits[0].output.sha256, hash('11-mug-alt.png')); assert.equal(rec.edits[0].original.sha256, h11);
    assert.deepEqual(rec.edits[1].measured.outlineRgb, RED_BROWN); assert.deepEqual(rec.edits[1].like.outlineRgb, [96, 54, 37]);
    // 11 has file 1's exact alpha (same shape)
    const [a, b] = await Promise.all(['01-mug.png', '11-mug-alt.png'].map((f) => sharp(path.join(raw, f)).ensureAlpha().extractChannel(3).raw().toBuffer()));
    assert.ok(a.equals(b), '11 has file 1\'s alpha');
    const r2 = await applyEditPlan({ sd });
    assert.deepEqual(r2.actions.map((x) => x.action), ['unchanged', 'unchanged']); assert.equal(r2.recordAction, 'unchanged');
    assert.equal(sha256(fs.readFileSync(path.join(sd, 'raw-original', '07-cat.png'))), h07, 'a re-run never overwrites the kept original');
  } finally { fs.rmSync(sd, { recursive: true, force: true }); }
});

// file 12 after QA DESIGN pass 3 (owner, 2026-10-17): outline normalised, THEN the olive cushion recoloured to 11's sage on the same file;
// the cat (a cream fixed colour inside the cushion here) and the new outline stay, alpha stays, a re-run starts from the original again
const OLIVE = [165, 161, 105], SAGE = [160, 186, 142], CAT = [254, 235, 190];
function olive() { const d = cushion(RED_BROWN, OLIVE); for (let y = C - 3; y <= C + 3; y++) for (let x = C - 3; x <= C + 3; x++) put(d, x, y, CAT); return d; }
const THEN_SPEC = { roles: [{ name: 'cushion', from: [[175, 177, 113], OLIVE, [135, 131, 79]], to: [[168, 194, 149], SAGE, [128, 147, 108]] }],
  fixed: [{ name: 'outline', rgb: OUTLINE }, { name: 'cat', rgb: CAT }], maxResidual: 20 };
const THEN_PLAN = { listingId: '2026-10-16--test-props', set: 1, authorisedBy: 'owner', date: '2026-10-17', edits: [
  { op: 'outline', file: '12-cat-alt.png', like: '01-mug.png', why: 'test', then: [{ op: 'recolour', spec: THEN_SPEC, why: 'cushion to sage' }] }] };

test('edit plan "then": the outline edit, then a recolour of the same file\'s cushion to sage; cat, outline and alpha kept; idempotent', async () => {
  const sd = await setDir(THEN_PLAN), raw = path.join(sd, 'raw'), f12 = path.join(raw, '12-cat-alt.png');
  fs.writeFileSync(f12, await png(olive()));
  const rgba = async (f) => sharp(f).ensureAlpha().raw().toBuffer();
  try {
    const h12 = sha256(fs.readFileSync(f12)), alpha0 = (await rgba(f12)).filter((_, i) => i % 4 === 3);
    const r1 = await applyEditPlan({ sd });
    assert.ok(r1.ok, r1.reason); assert.deepEqual(r1.actions.map((a) => a.action), ['written']);
    const d = await rgba(f12);
    assert.deepEqual(at(d, C - 8, C), [...SAGE, 255], 'cushion fill -> sage');
    assert.deepEqual(at(d, C, C), [...CAT, 255], 'the cat is not recoloured');
    assert.deepEqual(at(d, C, C - 16), [...OUTLINE, 255], 'outline -> the like file\'s outline (01-mug), not changed by the recolour');
    assert.ok(d.filter((_, i) => i % 4 === 3).equals(alpha0), 'alpha never changes');
    const e = at(d, C + 13, C), want = mix(OUTLINE, SAGE, 0.5);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(e[c] - want[c]) <= 3, 'the outline-cushion edge becomes outline-sage: ' + e + ' vs ' + want);
    const rec = JSON.parse(fs.readFileSync(path.join(sd, 'edits.json'), 'utf8')).edits[0];
    assert.equal(rec.original.sha256, h12); assert.equal(rec.then.length, 1); assert.equal(rec.then[0].why, 'cushion to sage');
    assert.ok(rec.then[0].facts.counts.roles.cushion > 0); assert.equal(rec.then[0].facts.counts.unexplained, 0);
    assert.equal(rec.output.sha256, sha256(fs.readFileSync(f12)));
    const r2 = await applyEditPlan({ sd });
    assert.deepEqual(r2.actions.map((x) => x.action), ['unchanged'], 'a re-run starts from the original again: same bytes'); assert.equal(r2.recordAction, 'unchanged');
  } finally { fs.rmSync(sd, { recursive: true, force: true }); }
});

test('edit plan "then": refused on a recolour edit, when empty, or when a step is not a recolour with roles', () => {
  const base = THEN_PLAN.edits[0];
  const cases = [
    [[{ ...PLAN.edits[0], then: [{ op: 'recolour', spec: THEN_SPEC }] }], /follow an outline edit only/],
    [[{ ...base, then: [] }], /non-empty list/],
    [[{ ...base, then: [{ op: 'outline' }] }], /must be a recolour/],
    [[{ ...base, then: [{ op: 'recolour', spec: { roles: [] } }] }], /must be a recolour/],
  ];
  for (const [edits, re] of cases) {
    const sd = tempDir('propedit-');
    try { fs.writeFileSync(path.join(sd, 'edit-plan.json'), JSON.stringify({ ...THEN_PLAN, edits })); const r = readPlan(sd); assert.equal(r.ok, false); assert.match(r.reason, re); }
    finally { fs.rmSync(sd, { recursive: true, force: true }); }
  }
});

test('edit plan: refused when a source is itself edited, a file is edited twice, the date is missing or the op is unknown', async () => {
  const cases = [
    [{ ...PLAN, edits: [{ op: 'recolour', file: '11-mug-alt.png', source: '07-cat.png', spec: SPEC }, PLAN.edits[1]] }, /is itself edited/],
    [{ ...PLAN, edits: [PLAN.edits[1], PLAN.edits[1]] }, /more than once/],
    [{ ...PLAN, date: '' }, /date/],
    [{ ...PLAN, edits: [{ op: 'repaint', file: '07-cat.png' }] }, /unknown edit op/],
  ];
  for (const [plan, re] of cases) {
    const sd = await setDir(plan);
    try { const r = readPlan(sd); assert.equal(r.ok, false); assert.match(r.reason, re); const a = await applyEditPlan({ sd }); assert.equal(a.ok, false); assert.ok(!fs.existsSync(path.join(sd, 'raw-original'))); }
    finally { fs.rmSync(sd, { recursive: true, force: true }); }
  }
});
