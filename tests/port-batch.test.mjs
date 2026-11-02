// port-batch.test.mjs — the engine side of the port batch before E6 (17/10/2026), on the mock provider ($0, no keys), each test
// in its own temp data root with the dry-run fixtures. Covers: the price fill keyed to the job (the legacy price-hook bug: another
// job's unreviewed listing in the outbox); QA pass numbers from the job's counter, never the count of files in qa/; the owner's run
// modes (QA-only after QA's loop limit, with the owner's overrides as context and the Designer not run; listing-only on the design
// sign-off, refusing to overwrite; the package step on the owner's word); owner overrides only of QA judgement verdicts (never the
// originality check, never while the originality screen is a hit), per file, append-only, version-checked, shown on the job; the
// owner set approval at the pass limit as the design sign-off; the recolour step refusing an unapproved source and doing nothing on a
// re-run; the deterministic listing text fix with its record; and the pinned upscaler: refused when its pin does not match, and its
// child process killed by the E-STOP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempRoot, until } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { checkPin, runPinned } from '../src/engine/lib/esrgan.mjs';
import { designSignOff } from '../src/engine/lib/owner-approval.mjs';
import { createDryRunScript, JOB_A } from '../fixtures/engine/mock-script.mjs';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const brief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OTHER = '2026-10-14--fixture-older-unreviewed-listing';

// one engine; qaAlwaysRevise makes QA DESIGN send every line pass back (the job reaches QA's loop limit and is rejected); a QA-only
// run is reviewed normally (the fixture approves a pass > 1). inputs records the first message each agent run was started with.
// designSendBacks: a patched copy of the config whose line sends a design back that many times (the real line: 2, three reviews)
function boot(t, { qaAlwaysRevise = false, designSendBacks = null } = {}) {
  const r = tempRoot('port');
  let configDir = path.join(APP_ROOT, 'config');
  if (designSendBacks != null) {
    configDir = path.join(r.base, 'config'); fs.cpSync(path.join(APP_ROOT, 'config'), configDir, { recursive: true });
    const lf = path.join(configDir, 'lines', 'room1-digital.json'), L = readJson(lf); L.steps['qa-design'].onRevise.max = designSendBacks; fs.writeFileSync(lf, JSON.stringify(L, null, 2));
  }
  const station = loadConfig({ configDir, promptsDir: path.join(APP_ROOT, 'prompts'), overrides: OVERRIDES }).station;
  const base = createDryRunScript({ cfg: station }), inputs = [];
  const script = (ctx, params) => {
    const c = params.messages[0].content, first = Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : String(c);
    if (params.messages.length === 1 && ctx.purpose !== 'image_analyze') inputs.push({ agent: ctx.agentKey, text: first });
    const qaOnly = first.includes('RUN MODE: QA ONLY');
    return base(qaAlwaysRevise && ctx.agentKey === 'qa-design' && !qaOnly ? { ...ctx, pass: 1 } : ctx, params);
  };
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, configDir, overrides: OVERRIDES, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const O = engine.orchestrator, jd = (id) => path.join(r.dataRoot, 'jobs', id);
  const run = async (id) => { const c = O.createJob({ briefText: brief(id), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; ')); await O.startJob(id); return engine.store.getJob(id); };
  const ver = (id) => engine.store.getJob(id).version;
  return { engine, r, O, jd, run, ver, inputs };
}
const runsOf = (engine, id, agent) => engine.store.runsOf({ jobId: id, limit: 200 }).filter((x) => x.agent_key === agent).length;

test('price fill is keyed to the job: another job\'s newer, unreviewed listing is never filled or read (the legacy hook bug)', async (t) => {
  const { engine, r, jd, run } = boot(t);
  // the legacy shape of the bug: an older job whose listing.json is newer than its qa-listing.json, with a design file a fill would fail on
  const L = { listingId: OTHER, productKey: 'none', designFile: 'jobs/' + OTHER + '/design-v1.png', title: 'old listing' };
  r.J.put(path.join(jd(OTHER), 'outbox', 'qa-listing.json'), JSON.stringify({ stage: 'listing', listingId: OTHER, verdict: 'revise' }));
  r.J.put(path.join(jd(OTHER), 'outbox', 'listing.json'), JSON.stringify(L));
  const t0 = Date.now() / 1000; fs.utimesSync(path.join(jd(OTHER), 'outbox', 'qa-listing.json'), t0 - 3600, t0 - 3600);
  const before = fs.readdirSync(path.join(jd(OTHER), 'outbox')).map((f) => f + ':' + sha(fs.readFileSync(path.join(jd(OTHER), 'outbox', f))));
  const job = await run(JOB_A);
  assert.equal(job.state, 'approval', job.reason);
  assert.ok(readJson(path.join(jd(JOB_A), 'outbox', 'listing.json')).listingPriceEur > 0, 'this job\'s listing was filled');
  assert.deepEqual(fs.readdirSync(path.join(jd(OTHER), 'outbox')).map((f) => f + ':' + sha(fs.readFileSync(path.join(jd(OTHER), 'outbox', f)))), before, 'the other job is untouched');
  assert.equal(engine.store.stagesOf(JOB_A).find((s) => s.step === 'price-fill').status, 'done');
});

test('QA pass numbers come from the job\'s own counter: a stray record in qa/ is never overwritten or counted as a pass', async (t) => {
  const { r, jd, run, engine } = boot(t);
  const stray = path.join(jd(JOB_A), 'qa', 'design-pass1.json');
  r.J.put(stray, '{"stray":true}\n');
  const job = await run(JOB_A);
  assert.equal(job.state, 'approval', job.reason);
  assert.equal(fs.readFileSync(stray, 'utf8'), '{"stray":true}\n', 'the stray file is kept as it was');
  assert.equal(readJson(path.join(jd(JOB_A), 'qa', 'design-pass2.json')).verdict, 'revise');
  assert.equal(readJson(path.join(jd(JOB_A), 'qa', 'design-pass3.json')).verdict, 'approved');
  assert.equal(engine.store.getJob(JOB_A).data.qaPasses.design, 3);
});

test('owner run modes: QA-only after the loop limit (overrides as context, no Designer), listing-only on the sign-off, then the package step', async (t) => {
  const { engine, r, O, jd, run, ver, inputs } = boot(t, { qaAlwaysRevise: true, designSendBacks: 1 });
  const job = await run(JOB_A);
  assert.equal(job.state, 'rejected', 'two QA DESIGN revises on a line with one send-back: Rejects Desk');
  assert.equal(job.data.qaPasses.design, 2);
  // an owner override on set-v2 (QA judgement only), tied to the file's bytes
  const sd = path.join(jd(JOB_A), 'set-v2');
  for (const f of fs.readdirSync(path.join(sd, 'files'))) r.J.copy(path.join(sd, 'files', f), path.join(sd, 'raw', f));
  const name = fs.readdirSync(path.join(sd, 'raw'))[2];
  engine.owner.recordFileDecision(JOB_A, { set: 2, name, decision: 'keep', qaPass: 2, qaSaid: 'the outline is cut off at the right edge', reason: 'the margin is fine at 100%', date: dublinDay(), expectedVersion: ver(JOB_A) });
  // refusals: no cap, a cap over the per-job cap, a stale version
  assert.throws(() => O.qaOnly(JOB_A, { set: 2, expectedVersion: ver(JOB_A) }), /spend cap is required/);
  assert.throws(() => O.qaOnly(JOB_A, { set: 2, maxUsd: 50, expectedVersion: ver(JOB_A) }), /over the per-job cap/);
  assert.throws(() => O.qaOnly(JOB_A, { set: 2, maxUsd: 0.5, expectedVersion: ver(JOB_A) - 1 }), (e) => e.code === 'STALE');
  const designers = runsOf(engine, JOB_A, 'designer');
  const q = O.qaOnly(JOB_A, { set: 2, maxUsd: 0.5, expectedVersion: ver(JOB_A) });
  assert.deepEqual(q.overrides, [name]);
  await q.run;
  let j = engine.store.getJob(JOB_A);
  assert.equal(j.state, 'stopped'); assert.match(j.reason, /^QA-only run finished: QA DESIGN pass 3 approved/);
  assert.equal(runsOf(engine, JOB_A, 'designer'), designers, 'the Designer is not run');
  assert.equal(runsOf(engine, JOB_A, 'lister'), 0, 'nothing listed');
  const qaIn = inputs.filter((x) => x.agent === 'qa-design').pop().text;
  assert.match(qaIn, /RUN MODE: QA ONLY/); assert.match(qaIn, new RegExp(name.replace(/\./g, '\\.') + ': KEEP\\. Earlier QA finding: "the outline is cut off at the right edge"\\. Owner: "the margin is fine at 100%"'));
  assert.equal(readJson(path.join(jd(JOB_A), 'qa', 'design-pass3.json')).verdict, 'approved');
  assert.throws(() => O.qaOnly(JOB_A, { set: 2, maxUsd: 0.5, expectedVersion: ver(JOB_A) }), /could never be packaged/, 'a pass past the limit is refused before it is paid for');
  // listing-only on QA's approval
  const lo = O.listingOnly(JOB_A, { maxUsd: 0.5, expectedVersion: ver(JOB_A) });
  assert.equal(lo.signOff, 'qa-design');
  await lo.run;
  j = engine.store.getJob(JOB_A);
  assert.equal(j.state, 'stopped'); assert.match(j.reason, /^listing-only run finished: QA LISTING pass 1 approved/);
  assert.match(inputs.filter((x) => x.agent === 'lister').pop().text, /RUN MODE: LISTING ONLY/);
  assert.ok(!fs.existsSync(path.join(jd(JOB_A), 'package')), 'listing-only never packages');
  assert.throws(() => O.listingOnly(JOB_A, { maxUsd: 0.5, expectedVersion: ver(JOB_A) }), /already exists: nothing is overwritten/);
  // the package step on the owner's word
  const p = O.packageJob(JOB_A, { expectedVersion: ver(JOB_A) });
  await p.run;
  assert.equal(engine.store.getJob(JOB_A).state, 'approval');
  assert.equal(engine.store.getApproval(JOB_A).status, 'pending');
  // the job panel shows the override with its file, pass, date, reason and owner
  const s = engine.owner.summary(JOB_A);
  assert.deepEqual(s.overrides.map((o) => [o.file, o.stage, o.qaPass, o.ownerReason, o.decidedBy, o.date]), [[name, 'QA DESIGN', 2, 'the margin is fine at 100%', 'owner', dublinDay()]]);
});

test('owner overrides: QA judgement only, never the originality screen; append-only, version-checked; the set approval at the pass limit', async (t) => {
  const { engine, r, jd, run, ver } = boot(t, { qaAlwaysRevise: true });
  await run(JOB_A);
  const sd = path.join(jd(JOB_A), 'set-v3'), names = fs.readdirSync(path.join(sd, 'files')).sort();
  for (const f of names) r.J.copy(path.join(sd, 'files', f), path.join(sd, 'raw', f));
  const W = engine.owner, base = { set: 3, qaPass: 3, qaSaid: 'QA said this', reason: 'the owner\'s reason', date: dublinDay() };
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', check: 'originality', expectedVersion: ver(JOB_A) }), /hard fail and is never overridden/);
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', check: 'trademarks', expectedVersion: ver(JOB_A) }), /never overridden/);
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', qaAgent: 'qa-listing', expectedVersion: ver(JOB_A) }), /owner listing approval/);
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', qaAgent: 'overseer', expectedVersion: ver(JOB_A) }), /only to a QA judgement verdict/);
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', reason: ' ', expectedVersion: ver(JOB_A) }), /reason is required/);
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', expectedVersion: ver(JOB_A) - 1 }), (e) => e.code === 'STALE');
  // while the set's originality screen is a hit, no override is taken
  const ogf = path.join(sd, 'originality.json'), og = fs.readFileSync(ogf, 'utf8');
  r.J.put(ogf, JSON.stringify({ ...JSON.parse(og), result: 'hit' }));
  assert.throws(() => W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', expectedVersion: ver(JOB_A) }), /originality screen is not clear/);
  r.J.put(ogf, og);
  assert.ok(!fs.existsSync(path.join(jd(JOB_A), 'owner-decisions.jsonl')), 'nothing recorded by a refusal');
  // a set approval before every file has a decision is refused
  W.recordFileDecision(JOB_A, { ...base, name: names[0], decision: 'keep', expectedVersion: ver(JOB_A) });
  assert.throws(() => W.approveSet(JOB_A, { set: 3, words: 'approve the set', expectedVersion: ver(JOB_A) }), /no owner decision in owner-review\.json/);
  const log1 = fs.readFileSync(path.join(jd(JOB_A), 'owner-decisions.jsonl'), 'utf8');
  for (const n of names.slice(1)) W.recordFileDecision(JOB_A, { set: 3, name: n, decision: 'approved', date: dublinDay(), expectedVersion: ver(JOB_A) });
  const log2 = fs.readFileSync(path.join(jd(JOB_A), 'owner-decisions.jsonl'), 'utf8');
  assert.ok(log2.startsWith(log1), 'append-only: earlier lines unchanged'); assert.equal(log2.trim().split('\n').length, names.length);
  const a = W.approveSet(JOB_A, { set: 3, words: 'Record my approval of the whole set in place of a 4th QA pass; originality stays hard.', expectedVersion: ver(JOB_A) });
  assert.deepEqual(a.counts, { 'qa-pass': names.length - 1, 'owner-override': 1, 'deterministic-fix': 0 });
  const so = designSignOff({ id: JOB_A, roomDir: r.dataRoot, cfg: engine.cfg.station });
  assert.equal(so.source, 'owner-set-approval'); assert.equal(so.designFile, 'jobs/' + JOB_A + '/set-v3/deliverables.json');
  // the approval is tied to the bytes: a changed raw file makes it stale
  const f0 = path.join(sd, 'raw', names[1]); r.J.put(f0, Buffer.concat([fs.readFileSync(f0), Buffer.from([0])]));
  assert.equal(designSignOff({ id: JOB_A, roomDir: r.dataRoot, cfg: engine.cfg.station }).ok, false);
  // the recolour / outline step starts only from an approved file
  const plan = { authorisedBy: 'owner', date: dublinDay(), edits: [{ op: 'recolour', file: names[4], source: names[1], why: 'a colourway', spec: { roles: [{ name: 'body', from: [[200, 60, 40], [120, 30, 20]], to: [[160, 185, 140], [90, 110, 80]] }], fixed: [] } }] };
  await assert.rejects(() => W.editSet(JOB_A, { set: 3, plan, expectedVersion: ver(JOB_A) }), /is not an approved file/);
  assert.ok(!fs.existsSync(path.join(sd, 'edit-plan.json')), 'a refused plan is not written');
  const ok = { ...plan, edits: [{ ...plan.edits[0], source: names[2] }] };
  const e1 = await W.editSet(JOB_A, { set: 3, plan: ok, expectedVersion: ver(JOB_A) });
  assert.equal(e1.record, 'written');
  const rec = readJson(path.join(sd, 'edits.json'));
  assert.equal(rec.edits[0].source.sha256, sha(fs.readFileSync(path.join(sd, 'raw', names[2]))));
  assert.ok(fs.existsSync(path.join(sd, 'raw-original', names[4])), 'the Designer\'s original is kept');
  const e2 = await W.editSet(JOB_A, { set: 3, plan: ok, expectedVersion: ver(JOB_A) });
  assert.deepEqual([e2.record, e2.actions[0].action], ['unchanged', 'unchanged'], 'a re-run with the same inputs writes nothing');
});

test('the deterministic listing text fix: the owner\'s US word list on the public fields, originals kept, one record, a re-run changes nothing', async (t) => {
  const { engine, r, jd, run, ver } = boot(t);
  await run(JOB_A);
  const lf = path.join(jd(JOB_A), 'outbox', 'listing.json'), L = readJson(lf);
  r.J.put(lf, JSON.stringify({ ...L, title: L.title.replace('Cozy', 'Cosy'), description: L.description + ' A colourway for every planner.' }, null, 2) + '\n');
  r.J.put(path.join(jd(JOB_A), 'outbox', 'listing.md'), '# Listing\n\n## Title\n\n' + L.title.replace('Cozy', 'Cosy') + '\n\n## Description\n\nIn colour.\n');
  engine.store.updateJob(JOB_A, { state: 'stopped' });
  const a = engine.owner.fixListingText(JOB_A, { ownerWords: 'Market: US English. Apply the deterministic text fix.', expectedVersion: ver(JOB_A) });
  assert.equal(a.changes, 4);
  const now = readJson(lf);
  assert.ok(now.title.includes('Cozy') && !/\bCosy\b/.test(now.title) && now.description.includes('colorway'));
  assert.equal(now.listingId, JOB_A, 'ids and paths untouched');
  const rec = readJson(path.join(jd(JOB_A), 'listing-fixes.json'));
  assert.equal(rec.model, 'none (deterministic)'); assert.equal(rec.rounds.length, 1); assert.equal(rec.after['listing.json'], sha(fs.readFileSync(lf)));
  assert.ok(fs.existsSync(path.join(jd(JOB_A), rec.backup, 'listing.json')), 'the originals are kept');
  const b = engine.owner.fixListingText(JOB_A, { ownerWords: 'again', expectedVersion: ver(JOB_A) });
  assert.equal(b.action, 'unchanged');
});

test('the pinned upscaler: refused when its pin does not match; its child process is killed by the E-STOP', async (t) => {
  const r = tempRoot('esrgan');
  t.after(() => r.cleanup());
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} });
  const pin = engine.cfg.engine.upscale;
  assert.match(checkPin({ ...pin, binary: 'C:/Windows/System32/cmd.exe' }).reason, /must live under office-agents\/tools/);
  assert.match(checkPin({ ...pin, sha256: '0'.repeat(64) }).reason || '', /differs from its pinned sha256|not installed/);
  assert.match(checkPin({ binary: pin.binary }).reason, /no pinned Real-ESRGAN binary/);
  // a long-running child (node itself stands in for the binary), started like the upscaler, killed when the owner presses E-STOP
  const cwd = path.join(r.dataRoot, 'jobs', 'x'); r.J.makeDir(cwd);
  const t0 = Date.now(), p = runPinned(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, signal: engine.halt.signal });
  setTimeout(() => engine.halt.press({ by: 'test', reason: 'kill the upscaler' }), 300);
  await assert.rejects(p, (e) => e.code === 'STOPPED');
  assert.ok(Date.now() - t0 < 5000, 'killed at once');
  await assert.rejects(() => runPinned(process.execPath, ['-e', '1'], { cwd, signal: engine.halt.signal }), (e) => e.code === 'STOPPED', 'nothing starts while the e-stop is on');
  await until(() => true);
});

test('market US English: the gate\'s spelling check fails every word of the owner\'s US list, "colourway" included', async () => {
  const { listingSpellingProblems } = await import('../src/engine/lib/spelling.mjs');
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') }).station;
  const bad = listingSpellingProblems({ title: 'Cosy Desk Props', description: 'A second colourway; warm colour.', altText: 'cosy mug', tags: ['cosy desk'] }, cfg);
  for (const w of ['cosy', 'colourway', 'colour']) assert.ok(bad.some((x) => x.includes('"' + w + '"')), w + ': ' + bad.join(' | '));
  assert.deepEqual(listingSpellingProblems({ title: 'Cozy Desk Props', description: 'A second colorway; warm color.', altText: 'cozy mug', tags: ['cozy desk'] }, cfg), []);
});
