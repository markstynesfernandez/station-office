// PORTED from Virtual-workers/station/tests/owner-approval.test.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment), source sha256 9640cf0269e163fd09e0e8fd04e75f6f89500fa026138ca2f7bf54bf974bf9ee.
//   change: imports point at src/engine/lib; config is the engine's (config/station.config.json, productType 'digital')
//   change: job folders are jobs/<id>/ with outbox/ inside (were work/<id>/ and outbox/<id>/); the expected designFile and record paths say jobs/<id>/
//   change: each temp room is the data root of a data jail
// Everything else is the source unchanged.
// owner-approval.test.mjs — the owner's approval of a whole digital set after QA DESIGN's pass limit (OWNER exception to the station freeze,
// 2026-10-17): every file's final status, refusals, the record tied to the set's bytes, and the package gate taking it in place of a 4th
// QA DESIGN pass while originality stays a hard check. Temp folders; no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, sha256 } from '../../src/engine/lib/common.mjs';
import { composeSetApproval, checkOwnerSetApproval, overridesOf, APPROVAL_FILE } from '../../src/engine/lib/owner-approval.mjs';
import { checkPackage } from '../../src/engine/lib/gates.mjs';
import { createJail } from '../../src/engine/store/jail.mjs';
import { useJail } from '../../src/engine/store/active.mjs';
import { tempDir } from '../helpers/engine.mjs';

const ID = '2026-10-16--test-owner-approval', cfg = { ...structuredClone(config), productType: 'digital' };
const CANDLE = 'The banded shading and the edge near the rim are acceptable cel shading for this set.';
const WORDS = 'Record my owner approval of the whole set. That approval is the sign-off for the package gate in place of a 4th QA pass; originality stays a hard check and must still be clear.';

function room({ passes = 3, lastVerdict = 'revise', originality = 'clear', review = (r) => r, manifest = (m) => m } = {}) {
  const dir = tempDir('ownerappr-'), w = path.join(dir, 'jobs', ID), sd = path.join(w, 'set-v4'), raw = path.join(sd, 'raw');
  useJail(createJail({ dataRoot: dir, extraRoots: [] })); fs.mkdirSync(raw, { recursive: true }); fs.mkdirSync(path.join(w, 'qa'));
  fs.writeFileSync(path.join(w, 'brief.md'), '---\nid: ' + ID + '\n---\n# Niche\nProps.\n');
  for (let i = 1; i <= passes; i++) fs.writeFileSync(path.join(w, 'qa', 'design-pass' + i + '.json'), JSON.stringify({ stage: 'design', pass: i, verdict: i === passes ? lastVerdict : 'revise', designFile: 'jobs/' + ID + '/set-v4/deliverables.json' }));
  const bytes = { '01-mug.png': 'mug', '02-plant.png': 'plant', '08-candle.png': 'candle', '12-cat.png': 'cat after the outline and the cushion recolour' };
  for (const [f, b] of Object.entries(bytes)) fs.writeFileSync(path.join(raw, f), b);
  const design = '# Design\nCosy desk props.\n';
  fs.writeFileSync(path.join(sd, 'design.md'), design);
  fs.writeFileSync(path.join(sd, 'originality.json'), JSON.stringify({ result: originality, designNotesSha256: sha256(design), hits: originality === 'clear' ? [] : [{ field: 'brief.md', term: 'x' }] }));
  fs.writeFileSync(path.join(sd, 'deliverables.json'), JSON.stringify(manifest({ files: [], limitProblems: [], buildWarnings: [], build: { zip: { name: 'x.zip', bytes: 8263122, sha256: 'z' } } })));
  fs.writeFileSync(path.join(sd, 'edits.json'), JSON.stringify({ edits: [{ op: 'outline', file: 'raw/12-cat.png', original: { sha256: sha256('cat original') }, output: { sha256: sha256(bytes['12-cat.png']) }, then: [{ op: 'recolour' }] }] }));
  const rec = review({ listingId: ID, set: 4, decidedBy: 'owner', date: '2026-10-17', reviewOf: { qaRecord: 'qa/design-pass2.json' },
    setApproval: { decidedBy: 'owner', date: '2026-10-17', afterQaPass: 'qa/design-pass3.json', words: WORDS, worthThePrice: { qaVerdict: 'fail', owner: 'the owner sets the price' } },
    files: [
      { name: '01-mug.png', rawSha256: sha256('mug'), decision: 'approved' },
      { name: '02-plant.png', rawSha256: sha256('plant'), decision: 'accept', overridesQa: true, qaPass: 3, qaSaid: 'borderline: stem ends', reason: 'ACCEPT as an owner override.' },
      { name: '08-candle.png', rawSha256: sha256('candle'), decision: 'accept', overridesQa: true, qaSaid: 'minor: jar outline slightly greyer', reason: 'a greyer outline on the glass jar is intended',
        laterOverrides: [{ qaPass: 3, qaSaid: 'usable: hard vertical tone break in the jar rim', reason: CANDLE }] },
      { name: '12-cat.png', rawSha256: sha256('cat original'), decision: 'fix', fix: 'outline as 07, then the cushion to 11\'s sage' }] });
  fs.writeFileSync(path.join(w, 'owner-review.json'), JSON.stringify(rec));
  return { dir, w, sd, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const compose = (r, o = {}) => composeSetApproval({ roomDir: r.dir, id: ID, n: 4, cfg, ...o });
const write = (r) => { const c = compose(r); assert.ok(c.ok, JSON.stringify(c.reasons)); fs.writeFileSync(path.join(r.w, APPROVAL_FILE), JSON.stringify(c.record, null, 1) + '\n'); return c.record; };
const check = (r) => checkOwnerSetApproval({ id: ID, roomDir: r.dir, cfg });

test('owner set approval: each file gets its final status (QA pass, owner override with every overruled finding and reason, deterministic fix); deterministic', () => {
  const r = room();
  try {
    const c = compose(r); assert.ok(c.ok, JSON.stringify(c.reasons));
    const by = Object.fromEntries(c.record.files.map((f) => [f.name, f]));
    assert.equal(by['01-mug.png'].status, 'qa-pass');
    assert.equal(by['02-plant.png'].status, 'owner-override'); assert.deepEqual(by['02-plant.png'].overrides, [{ qaPass: 3, qaSaid: 'borderline: stem ends', reason: 'ACCEPT as an owner override.' }]);
    assert.deepEqual(by['08-candle.png'].overrides.map((o) => [o.qaPass, o.reason]), [[2, 'a greyer outline on the glass jar is intended'], [3, CANDLE]], 'both overruled findings, the owner\'s words');
    assert.equal(by['12-cat.png'].status, 'deterministic-fix'); assert.deepEqual(by['12-cat.png'].ops, ['outline', 'recolour']);
    assert.deepEqual(c.record.counts, { 'qa-pass': 1, 'owner-override': 2, 'deterministic-fix': 1 });
    assert.equal(c.record.afterQaPass.pass, 3); assert.equal(c.record.ownerWords, WORDS); assert.equal(c.record.originality.result, 'clear');
    assert.match(c.record.inPlaceOf, /QA DESIGN pass 4/);
    assert.equal(JSON.stringify(compose(r).record), JSON.stringify(c.record), 'no timestamps: a re-compose gives the same record');
    write(r); assert.deepEqual(check(r), { designFile: 'jobs/' + ID + '/set-v4/deliverables.json', problems: [] });
    assert.equal(checkOwnerSetApproval({ id: ID, roomDir: room().dir, cfg }), null, 'no record: null (the gate keeps its QA path)');
    assert.deepEqual(overridesOf({ decision: 'approved' }, 2), []);
  } finally { r.done(); }
});

test('owner set approval refused: originality not clear or stale, before the pass limit, after a QA approval, limit problems, a file without a decision, an override without a reason, a fix without its edit, no setApproval, the POD line', () => {
  const cases = [
    [{ originality: 'hit' }, {}, /originality is not clear/],
    [{ passes: 2 }, {}, /only at the pass limit: 2 of 3/],
    [{ lastVerdict: 'approved' }, {}, /approved the set: no owner set approval is needed/],
    [{ manifest: (m) => ({ ...m, limitProblems: ['a file over 20 MB'] }) }, {}, /limit problems: a file over 20 MB/],
    [{ manifest: (m) => ({ ...m, buildWarnings: ['zip over 19 MB'] }) }, {}, /build warnings/],
    [{ review: (x) => ({ ...x, files: x.files.filter((f) => f.name !== '01-mug.png') }) }, {}, /01-mug.png: no owner decision/],
    [{ review: (x) => ({ ...x, files: x.files.map((f) => (f.name === '02-plant.png' ? { ...f, reason: '' } : f)) }) }, {}, /needs the QA finding and the owner's reason/],
    [{ review: (x) => ({ ...x, files: x.files.map((f) => (f.name === '01-mug.png' ? { ...f, decision: 'fix' } : f)) }) }, {}, /01-mug.png: the owner decided "fix" but .* no edit/],
    [{ review: (x) => ({ ...x, files: x.files.map((f) => (f.name === '12-cat.png' ? { ...f, rawSha256: sha256('another file') } : f)) }) }, {}, /started from a file other than the one the owner decided on/],
    [{ review: (x) => ({ ...x, setApproval: undefined }) }, {}, /no setApproval/],
    [{ review: (x) => ({ ...x, setApproval: { ...x.setApproval, afterQaPass: 'qa/design-pass2.json' } }) }, {}, /not the last QA pass/],
    [{}, { cfg: { ...cfg, productType: 'pod' } }, /digital-line exception/],
  ];
  for (const [ro, co, re] of cases) { const r = room(ro); try { const c = compose(r, co); assert.equal(c.ok, false, re.source); assert.match(c.reasons.join(' | '), re); } finally { r.done(); } }
  const r = room(); fs.writeFileSync(path.join(r.sd, 'design.md'), '# Design\nedited after the screen\n');
  try { assert.match(compose(r).reasons.join(), /older design.md/); } finally { r.done(); }
});

test('owner set approval is tied to the bytes: a changed file, a new QA pass, an edited review or a rewritten manifest makes it stale', () => {
  const edits = [
    (r) => fs.writeFileSync(path.join(r.sd, 'raw', '01-mug.png'), 'mug, redrawn'),
    (r) => fs.writeFileSync(path.join(r.w, 'qa', 'design-pass4.json'), JSON.stringify({ verdict: 'approved' })),
    (r) => { const f = path.join(r.w, 'owner-review.json'), v = JSON.parse(fs.readFileSync(f, 'utf8')); v.note = 'edited'; fs.writeFileSync(f, JSON.stringify(v)); },
    (r) => { const f = path.join(r.sd, 'deliverables.json'), v = JSON.parse(fs.readFileSync(f, 'utf8')); v.files = [{ name: 'other.zip' }]; fs.writeFileSync(f, JSON.stringify(v)); },
  ];
  for (const edit of edits) {
    const r = room();
    try { write(r); edit(r); const g = check(r); assert.equal(g.designFile, null); assert.ok(g.problems.length, 'stale'); } finally { r.done(); }
  }
});

test('package gate: a valid owner set approval replaces the QA DESIGN sign-off (no qa-design.json reasons), a stale one blocks, originality still blocks', () => {
  const qaReasons = (g) => g.reasons.filter((x) => /qa-design\.json|latest design QA pass/.test(x));
  const r = room();
  try {
    const before = checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg });
    assert.ok(qaReasons(before).length, 'without the approval the QA DESIGN sign-off is required'); assert.equal(before.ownerSetApproval, undefined);
    write(r);
    const g = checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg });
    assert.deepEqual(qaReasons(g), [], 'the owner approval stands in for QA DESIGN');
    assert.equal(g.designFile, 'jobs/' + ID + '/set-v4/deliverables.json'); assert.deepEqual(g.ownerSetApproval, { file: 'jobs/' + ID + '/' + APPROVAL_FILE, ok: true });
    assert.ok(g.reasons.some((x) => /qa-listing\.json/.test(x)) && g.reasons.some((x) => /listing\.json/.test(x)), 'the listing checks still run');
    assert.equal(g.ok, false, 'never a package from the approval alone');
    // a stale approval blocks with its own reason
    fs.writeFileSync(path.join(r.sd, 'raw', '01-mug.png'), 'mug, redrawn');
    const s = checkPackage({ id: ID, roomDir: r.dir, blocklist: [], cfg });
    assert.ok(s.reasons.some((x) => /^owner set approval: 01-mug.png: changed since the owner decided/.test(x))); assert.equal(s.designFile, null);
    assert.equal(s.ownerSetApproval.ok, false);
  } finally { r.done(); }
  // originality: the gate's own check fires as well as the approval's
  const o = room();
  try {
    write(o); const f = path.join(o.sd, 'originality.json'), v = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...v, result: 'hit', hits: [{ field: 'brief.md', term: 'chanel', category: 'brands', kind: 'term' }] }));
    const g = checkPackage({ id: ID, roomDir: o.dir, blocklist: [], cfg });
    assert.ok(g.reasons.some((x) => /^owner set approval: originality is not clear/.test(x)));
  } finally { o.done(); }
  // QA's own approval keeps precedence: an approved qa-design.json is read, the owner record is not consulted
  const q = room({ lastVerdict: 'approved' });
  try {
    fs.mkdirSync(path.join(q.dir, 'jobs', ID, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(q.dir, 'jobs', ID, 'outbox', 'qa-design.json'), JSON.stringify({ stage: 'design', verdict: 'approved', listingId: ID, designFile: 'jobs/' + ID + '/set-v4/deliverables.json', checks: {} }));
    fs.writeFileSync(path.join(q.w, APPROVAL_FILE), '{"kind":"owner-set-approval"}');
    assert.equal(checkPackage({ id: ID, roomDir: q.dir, blocklist: [], cfg }).ownerSetApproval, undefined);
  } finally { q.done(); }
});
