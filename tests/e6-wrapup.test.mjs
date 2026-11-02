// e6-wrapup.test.mjs — the E6 wrap-up (owner decisions, 18/10/2026; DECISIONS.md "E6 wrap-up"): the "apple cider" allow-list entry, frozen
// job inputs with dated owner amendments, the file-1 QA gate (and the owner's pause by "ownerFile1": true), the DESIGNER never writing the
// brief, the QA-DESIGN prompt trim, and the settle script for estimated image rows. Mock provider and stubs only: $0, no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dataJail } from '../src/engine/store/active.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { createMockText, mockPng } from '../src/engine/providers/mock.mjs';
import { createOpenRouterImage, REFERENCE_LINE } from '../src/engine/providers/openrouter.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { buildAgentPrompt } from '../src/engine/prompts.mjs';
import { screenText } from '../src/engine/lib/originality.mjs';
import { readInputs, listAmendments } from '../src/engine/lib/job-inputs.mjs';
import { approvedRef, readStyleRef, styleRefProblems } from '../src/engine/lib/style-ref.mjs';
import { settleImageRows } from '../src/engine/lib/settle-images.mjs';
import { createDryRunScript, JOB_A } from '../fixtures/engine/mock-script.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts'), FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const fixtureBrief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const firstText = (params) => { const c = params.messages[0].content; return Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : String(c); };
const transcriptOf = (dataRoot, id) => fs.readFileSync(path.join(dataRoot, 'jobs', id, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- 1. the allow-list

test('allow-list: the exact phrase "apple cider" is owner-approved; "apple" alone and every other form stay blocked', () => {
  assert.deepEqual(CFG.station.sloganScreen.phraseAllow.apple, ['apple cider']);
  for (const t of ['a mug of hot apple cider with steam', 'Apple-Cider mug, soft outline', 'APPLE CIDER']) assert.equal(screenText(t, CFG.station).result, 'clear', t);
  for (const t of ['an apple on a desk', 'apple pie', 'apple ciders', 'apples cider', 'apple cider beside an apple', 'apple juice']) {
    const r = screenText(t, CFG.station);
    assert.equal(r.result, 'hit', t); assert.ok(r.hits.some((h) => h.phrase === 'apple'), t);
  }
  assert.equal(screenText('cider and cinnamon', CFG.station).result, 'clear');
});

// ---- 2. frozen job inputs and owner amendments (the mock line on the dry-run fixtures)

function boot(t, tag = 'wrap') {
  const r = tempRoot(tag), station = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const base = createDryRunScript({ cfg: station }), inputs = [];
  const script = (ctx, params) => { if (params.messages.length === 1 && ctx.purpose !== 'image_analyze') inputs.push({ agent: ctx.agentKey, text: firstText(params) }); return base(ctx, params); };
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, configDir: CONFIG, overrides: OVERRIDES, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  return { engine, r, inputs, O: engine.orchestrator, jd: (id) => path.join(r.dataRoot, 'jobs', id) };
}

test('frozen inputs: intake snapshots the brief and the spec; an owner amendment reaches DESIGNER and QA DESIGN and is listed in the QA records', async (t) => {
  const { engine, r, inputs, O, jd } = boot(t);
  const c = O.createJob({ briefText: fixtureBrief(JOB_A), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; '));
  const sn = readInputs(r.dataRoot, JOB_A);
  assert.ok(sn.ok && sn.frozen, sn.reason);
  assert.equal(sn.brief, fs.readFileSync(path.join(jd(JOB_A), 'brief.md'), 'utf8'));
  assert.deepEqual(sn.products.map((p) => p.key), [engine.store.getJob(JOB_A).product_key], 'the job\'s own product entry only');
  // the owner amends the queued job: a dated record, never an edit of the snapshot
  const words = 'Owner amendment for the test: every sticker keeps a 3 mm white border.';
  const a = engine.owner.amendJob(JOB_A, { text: words, date: dublinDay(), expectedVersion: engine.store.getJob(JOB_A).version });
  assert.equal(a.file, 'amendments/001-' + dublinDay() + '.md');
  assert.equal(readInputs(r.dataRoot, JOB_A).brief, sn.brief, 'the snapshot is unchanged');
  await O.startJob(JOB_A);
  const job = engine.store.getJob(JOB_A);
  assert.equal(job.state, 'approval', job.reason);
  for (const agent of ['designer', 'qa-design', 'lister', 'qa-listing']) {
    const got = inputs.filter((x) => x.agent === agent);
    assert.ok(got.length, agent + ' ran'); for (const x of got) assert.ok(x.text.includes(words) && x.text.includes('OWNER AMENDMENTS'), agent + ' got the amendment');
  }
  const qaDir = path.join(jd(JOB_A), 'qa'), recs = fs.readdirSync(qaDir).map((f) => readJson(path.join(qaDir, f)));
  assert.ok(recs.length >= 2);
  for (const q of [...recs, readJson(path.join(jd(JOB_A), 'outbox', 'qa-design.json')), ...fs.readdirSync(path.join(jd(JOB_A), 'qa-listing')).map((f) => readJson(path.join(jd(JOB_A), 'qa-listing', f)))]) {
    assert.deepEqual(q.inputs.amendments.map((x) => x.file), [a.file]);
    assert.equal(q.inputs.amendments[0].sha256, a.sha256);
    assert.equal(q.inputs.snapshot.brief, sn.record.brief.sha256);
  }
  // the agents' tools serve brief.md and products.json from the snapshot
  const reads = transcriptOf(r.dataRoot, JOB_A).flatMap((x) => x.toolCalls.filter((u) => u.name === 'fs_read' && /brief\.md$/.test(u.input.path)));
  assert.ok(reads.length, 'an agent read the brief');
  // a second amendment is numbered after the first; the first is never overwritten
  const b = engine.owner.amendJob(JOB_A, { text: 'A second note.', date: dublinDay(), expectedVersion: engine.store.getJob(JOB_A).version });
  assert.equal(b.file, 'amendments/002-' + dublinDay() + '.md');
  assert.deepEqual(listAmendments(r.dataRoot, JOB_A).map((x) => x.file), [a.file, b.file]);
  assert.ok(listAmendments(r.dataRoot, JOB_A)[0].text.includes(words));
});

test('frozen inputs: a direct edit of the snapshot is refused; an edit made around the station blocks the job before its next step', async (t) => {
  const { engine, r, O, jd } = boot(t, 'wrapfz');
  const c = O.createJob({ briefText: fixtureBrief(JOB_A), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; '));
  const inp = path.join(jd(JOB_A), 'inputs');
  const frozen = (e) => e.code === 'FROZEN' && /frozen inputs of job/.test(e.message);
  assert.throws(() => r.J.put(path.join(inp, 'brief.md'), 'edited'), frozen);
  assert.throws(() => r.J.put(path.join(inp, 'products.json'), '{}'), frozen);
  assert.throws(() => r.J.put(path.join(inp, 'SNAPSHOT.json'), '{}'), frozen);
  assert.throws(() => r.J.add(path.join(inp, 'brief.md'), 'x'), frozen);
  assert.throws(() => r.J.put(path.join(inp, 'new-file.md'), 'x'), frozen);
  assert.throws(() => fs.writeFileSync(dataJail(path.join(inp, 'brief.md')), 'x'), frozen);
  assert.throws(() => r.J.remove(inp), frozen);
  assert.throws(() => r.J.move(path.join(inp, 'brief.md'), path.join(jd(JOB_A), 'moved.md')), frozen);
  assert.throws(() => r.J.copy(path.join(jd(JOB_A), 'brief.md'), path.join(inp, 'brief.md')), frozen);
  assert.ok(readInputs(r.dataRoot, JOB_A).ok, 'the snapshot is intact');
  // the top-level brief.md edited in place: the job is blocked before any step runs, nothing is called
  fs.appendFileSync(path.join(jd(JOB_A), 'brief.md'), '\nAn edit after intake.\n');
  const j1 = await O.startJob(JOB_A);
  assert.equal(j1.state, 'blocked'); assert.match(j1.reason, /frozen inputs: .*brief\.md differs from the frozen brief/);
  assert.equal(engine.ledger.rowsForJob(JOB_A).length, 0);
  // the snapshot itself edited outside the station (raw fs, no jail): its check fails closed
  fs.writeFileSync(path.join(jd(JOB_A), 'brief.md'), readInputs(r.dataRoot, JOB_A).brief);
  fs.writeFileSync(path.join(inp, 'brief.md'), 'tampered');
  const rs = O.restartJob(JOB_A, { expectedVersion: engine.store.getJob(JOB_A).version }); await rs.run;
  const j2 = engine.store.getJob(JOB_A);
  assert.equal(j2.state, 'blocked'); assert.match(j2.reason, /frozen inputs: .*inputs\/brief\.md differs from its snapshot/);
  // an ended job may still be archived whole (the frozen folder moved away, never written into)
  const to = r.J.move(inp, path.join(jd(JOB_A), 'rerun-archive-test', 'inputs'));
  assert.ok(fs.existsSync(path.join(to, 'SNAPSHOT.json')));
});

// ---- 3. the file-1 gate (live image client on a fake fetch, the mock text provider; nothing leaves the process)

const FAKE_KEY = 'sk-or-v1-wrapTESTKEY0123456789abcdef0123456789abcdef', LIVE = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', OPENROUTER_API_KEY: FAKE_KEY };
const ID = '2026-10-18--wrap-desk-props', MODEL = 'openai/gpt-5-image-mini';
const BRIEF = ['---', 'id: ' + ID, 'status: verified', 'product_type: pngtuber-prop-pack', '---', '# Niche', 'Cosy desk props for streamers', '', '## Design direction', 'Original cosy desk props, soft outlines, no text.', ''].join('\n');
const pad = (n) => String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });
let PNG = null;
const png = async () => (PNG = PNG || await mockPng({ prompt: 'wrap prop', width: 96, height: 96, transparent: true }));
function fakeFetch() {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, headers: new Headers({}), json: async () => ({ id: 'gen-' + calls.length, model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }], usage: { cost: 0.04 } }) }; };
  f.calls = calls; return f;
}
// DESIGNER draws file 1 alone, then the rest in batches; QA DESIGN approves file 1
function gateScript() {
  return (ctx, params) => {
    if (ctx.purpose === 'image_analyze') return { content: [{ type: 'text', text: 'a cosy prop on a transparent background, no text' }] };
    const input = firstText(params), turn = turnOf(params);
    if (ctx.agentKey === 'designer' && /RUN MODE: FIRST FILE ONLY/.test(input)) {
      const set = Number(/set-v(\d+)\/raw\/01-/.exec(input)[1]);
      if (turn === 0) return { content: [tool('g' + set, 'image_generate', { path: 'set-v' + set + '/raw/01-steaming-mug.png', prompt: 'a mug of hot apple cider with steam, soft outline', transparent: true })] };
      if (turn === 1) return { content: [tool('w' + set, 'fs_write', { path: 'set-v' + set + '/design.md', content: '# Plan\n01 steaming mug\nSelf-check: original; no trademarks; no named style; no real person.\n' })] };
      return { content: [{ type: 'text', text: 'file 1 drawn' }] };
    }
    if (ctx.agentKey === 'designer' && /RUN MODE: REST OF SET/.test(input)) {
      const m = /files (\d\d)–(\d\d) of/.exec(input), set = Number(/Write set-v(\d+):/.exec(input)[1]);
      if (turn === 0) return { content: range(+m[1], +m[2]).map((n) => tool('g' + set + '-' + n, 'image_generate', { path: 'set-v' + set + '/raw/' + pad(n) + '-prop-' + n + '.png', prompt: 'desk prop ' + n + ', soft outline', transparent: true })) };
      if (turn === 1) return { content: [tool('w' + set + m[1], 'fs_write', { path: 'set-v' + set + '/design.md', content: '# Plan\n01 approved style reference\n' })] };
      return { content: [{ type: 'text', text: 'batch drawn' }] };
    }
    if (ctx.agentKey === 'qa-design' && /RUN MODE: FILE 1 CHECK/.test(input)) {
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      const file = /"file": "([^"]+)"/.exec(input)[1];
      return { content: [tool('v', 'submit_verdict', { record: { stage: 'file1', listingId: ctx.jobId, file, verdict: 'approved', checks: { originality: 'pass', usable: 'pass', styleReference: 'pass' }, reasons: [] } })] };
    }
    return { content: [{ type: 'text', text: 'nothing scripted' }] };
  };
}
function gateEngine(t, tag) {
  const r = tempRoot(tag), fetchImpl = fakeFetch(), image = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log: r.log, fetchImpl });
  const providers = { mode: 'live', text: createMockText({ script: gateScript() }), image, web: Object.assign(async () => ({ text: '', usd: 0 }), { plan: () => ({ maxUses: 1, extraUsd: 0 }), settings: {} }) };
  // the job stops when DESIGNER is done (the set review is not part of these tests)
  const hooks = { onStep: ({ job, step, phase, result }) => { if (step === 'designer' && phase === 'end' && result && result.next === 'prep') engine.orchestrator.stopJob(job.id, { expectedVersion: engine.store.getJob(job.id).version }); } };
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, providers, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan, hooks });
  engine.sleep = async () => {};
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const addJob = (data = {}) => { engine.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'Wrap desk props', product_key: 'pngtuber-prop-pack', state: 'queued', step: 'designer', data: { createdBy: 'test', ...data } }); r.J.put(path.join(r.dataRoot, 'jobs', ID, 'brief.md'), BRIEF); };
  return { engine, r, fetchImpl, addJob, jd: path.join(r.dataRoot, 'jobs', ID) };
}

test('file-1 gate: a routine job continues without a pause once QA DESIGN passes file 1; that pass is file 1\'s approval at the package gate', async (t) => {
  await png();
  const { engine, r, fetchImpl, addJob, jd } = gateEngine(t, 'gate');
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'prep', 'went on to prep: no owner pause');
  assert.ok(!job.data.waitingFor);
  assert.equal(fetchImpl.calls.length, 12, 'file 1, then files 02-12');
  const sr = readStyleRef(r.dataRoot, ID).current;
  assert.deepEqual([sr.status, sr.decidedBy, sr.qaPass, sr.set], ['approved', 'qa-design', 1, 1]);
  assert.equal(readJson(path.join(jd, 'qa', 'file1-pass1.json')).decides.sha256, sr.sha256);
  const approved = fs.readFileSync(path.join(r.dataRoot, sr.file));
  for (const c of fetchImpl.calls.slice(1)) { const parts = c.body.messages[0].content; assert.ok(parts[0].text.endsWith(REFERENCE_LINE)); assert.equal(parts[1].image_url.url, 'data:image/png;base64,' + approved.toString('base64')); }
  // the package gate's style-reference check: the QA pass stands as the approval, for the approved bytes only
  const product = CFG.products.find((p) => p.key === 'pngtuber-prop-pack');
  assert.ok(approvedRef(r.dataRoot, ID).ok);
  assert.deepEqual(styleRefProblems({ roomDir: r.dataRoot, id: ID, product, build: { inputs: [{ name: sr.name, sha256: sr.sha256 }] } }), []);
  assert.match(styleRefProblems({ roomDir: r.dataRoot, id: ID, product, build: { inputs: [{ name: sr.name, sha256: 'f'.repeat(64) }] } })[0], /not the file the owner approved/);
  // the QA record behind it changed to a revise: the approval no longer stands, and the gate refuses
  const qf = path.join(jd, 'qa', 'file1-pass1.json'), q = readJson(qf);
  fs.writeFileSync(qf, JSON.stringify({ ...q, verdict: 'revise' }));
  assert.match(styleRefProblems({ roomDir: r.dataRoot, id: ID, product, build: { inputs: [{ name: sr.name, sha256: sr.sha256 }] } })[0], /QA DESIGN approval of file 1 does not stand/);
  fs.writeFileSync(qf, JSON.stringify(q));
  // the owner may still decide on top of it: an owner approval stands as before
  const v = engine.store.getJob(ID).version;
  engine.owner.styleRefDecision(ID, { set: 1, status: 'approved', date: dublinDay(), expectedVersion: v });
  assert.equal(readStyleRef(r.dataRoot, ID).current.decidedBy, 'owner');
  assert.deepEqual(styleRefProblems({ roomDir: r.dataRoot, id: ID, product, build: { inputs: [{ name: sr.name, sha256: sr.sha256 }] } }), []);
  // the job's inputs were frozen at its first run (a job inserted without intake)
  assert.ok(readInputs(r.dataRoot, ID).frozen);
});

test('file-1 gate: "ownerFile1": true keeps the manual pause (from the job, the brief\'s front matter, or the routine)', async (t) => {
  await png();
  const { engine, r, fetchImpl, addJob } = gateEngine(t, 'gate1');
  addJob({ ownerFile1: true });
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'queued', job.reason); assert.equal(job.data.waitingFor, 'owner-style-ref');
  assert.equal(fetchImpl.calls.length, 1, 'file 1 only');
  assert.equal(readStyleRef(r.dataRoot, ID).current, null, 'no approval recorded: the owner decides');
  assert.equal(approvedRef(r.dataRoot, ID).ok, false);
  // the owner brief's front matter and the routine both set it at intake
  const ob = fs.readFileSync(path.join(FIX, 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
  const withFlag = ob.replace('id: 2026-10-17--cozy-autumn-desk-props', 'id: 2026-10-18--cozy-autumn-owner-file1').replace('date: 2026-10-17', 'date: 2026-10-18').replace('origin: owner\n', 'origin: owner\nownerFile1: true\n');
  const c1 = engine.orchestrator.createJob({ briefText: withFlag, by: 'test' }); assert.ok(c1.ok, (c1.reasons || []).join('; '));
  assert.equal(engine.store.getJob(c1.id).data.ownerFile1, true);
  const plain = ob.replace('id: 2026-10-17--cozy-autumn-desk-props', 'id: 2026-10-18--cozy-autumn-plain').replace('date: 2026-10-17', 'date: 2026-10-18');
  const c2 = engine.orchestrator.createJob({ briefText: plain, by: 'test' }); assert.ok(c2.ok, (c2.reasons || []).join('; '));
  assert.equal(engine.store.getJob(c2.id).data.ownerFile1, false);
  const c3 = engine.orchestrator.createJob({ briefText: plain.replace('2026-10-18--cozy-autumn-plain', '2026-10-18--cozy-autumn-routine'), by: 'routine test', ownerFile1: true }); assert.ok(c3.ok);
  assert.equal(engine.store.getJob(c3.id).data.ownerFile1, true);
});

// ---- 4. DESIGNER never writes the brief or outside its set folder

test('DESIGNER: its orders no longer copy the brief; on the mock it writes only inside its set folders, and a brief write is refused', async (t) => {
  const de = buildAgentPrompt(CFG.agents.designer, { promptsDir: PROMPTS }).text;
  assert.doesNotMatch(de, /Write the brief, unchanged/);
  assert.doesNotMatch(de, /Designer writes it on pass 1/);
  assert.match(de, /Never copy, rewrite or write the brief, and never write any file outside your own set folder `work\/<id>\/set-v<N>\/`/);
  // the whole mock line: every DESIGNER write is set-v<N>/...
  const { r, O } = boot(t, 'wrapde');
  assert.ok(O.createJob({ briefText: fixtureBrief(JOB_A), by: 'test' }).ok);
  await O.startJob(JOB_A);
  const writes = transcriptOf(r.dataRoot, JOB_A).filter((x) => x.agent === 'designer').flatMap((x) => x.toolCalls.filter((u) => u.name === 'fs_write' || u.name === 'image_generate').map((u) => u.input.path));
  assert.ok(writes.length);
  for (const p of writes) assert.match(p.replace(/^work\/[^/]+\//, ''), /^set-v\d+\//, p);
  // a DESIGNER that tries anyway: the role guard refuses it, and the frozen brief is unchanged
  const r2 = tempRoot('wrapde2');
  const engine = createEngine({ archiveSandbox: true, J: r2.J, log: r2.log, configDir: CONFIG, overrides: OVERRIDES, startScheduler: false, script: (ctx, params) => (turnOf(params) === 0 ? { content: [tool('b', 'fs_write', { path: 'brief.md', content: 'copied' }), tool('c', 'fs_write', { path: 'inputs/brief.md', content: 'copied' })] } : { content: [{ type: 'text', text: 'done' }] }) });
  t.after(() => { try { engine.close(); } catch (_) {} r2.cleanup(); });
  assert.ok(engine.orchestrator.createJob({ briefText: fixtureBrief(JOB_A), by: 'test' }).ok);
  const before = readInputs(r2.dataRoot, JOB_A).brief;
  await runAgent(engine, { agentKey: 'designer', job: engine.store.getJob(JOB_A), step: 'designer', pass: 1, folder: path.join(r2.dataRoot, 'jobs', JOB_A), folderLabel: 'the job folder', input: 'test', line: 'room1-digital' });
  const res = transcriptOf(r2.dataRoot, JOB_A)[0].toolResults;
  assert.equal(res.length, 2); assert.ok(res[0].is_error && /your role may not write brief\.md/.test(res[0].content), res[0].content);
  assert.ok(res[1].is_error && /refusing to write into the frozen inputs/.test(res[1].content), res[1].content);
  assert.equal(readInputs(r2.dataRoot, JOB_A).brief, before);
  assert.equal(fs.readFileSync(path.join(r2.dataRoot, 'jobs', JOB_A, 'brief.md'), 'utf8'), before);
});

// ---- 5. the QA-DESIGN prompt trim

test('QA-DESIGN: at most 10,500 characters (owner target); the owner\'s originality wording, the IP lines and the spec checks are all still there', () => {
  assert.equal(CFG.station.promptBudgetChars.targets['qa-design'], 10500);
  const qa = buildAgentPrompt(CFG.agents['qa-design'], { promptsDir: PROMPTS, budgets: CFG.station.promptBudgetChars });
  assert.ok(qa.chars <= 10500, 'qa-design is ' + qa.chars + ' chars');
  const rules = fs.readFileSync(path.join(PROMPTS, 'skills', 'originality-rules.md'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(qa.text.includes(rules), 'ORIGINALITY RULES word for word');
  for (const re of [/ORIGINALITY HARD FAIL if `originality\.json` is missing or its `result` is "hit"/, /judge every file and design\.md against ORIGINALITY RULES/, /nothing a buyer would need a third party's permission to use/,
    /No real person's name or likeness/, /Everything inside a file must be ours to sell: only the image generator and the bundled fonts/,
    /complete: every file the brief lists is there, by subject \(the spec sets only the format\)/, /matchesSpec: `deliverables\.json` matches the spec's format exactly \(count, format, pixel size per file; never subjects\)/,
    /OWNER AMENDMENTS/, /"manifestSha256"/, /VERDICT: revise/]) assert.match(qa.text, re);
});

// ---- 6. settling estimated image rows from OpenRouter's generation lookup

test('settle-images: an estimated image row with a generation id gets one correction row from total_cost; no id, Anthropic rows and reruns write nothing', async (t) => {
  const r = tempRoot('settle'), engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: CONFIG, overrides: OVERRIDES, startScheduler: false, script: () => ({ content: [{ type: 'text', text: 'x' }] }) });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const L = engine.ledger, ts = Date.parse('2026-10-18T10:00:00Z');
  const base = { ts, jobId: 'j1', runId: 'run1', agentKey: 'designer', line: 'room1-digital', provider: 'openrouter', model: MODEL, kind: 'image', count: 1, usd: 0.08, estimated: true, priceSource: 'config/engine.json' };
  const withId = L.append({ ...base, entryId: 'e-with', generationId: 'gen-abc123' }), noId = L.append({ ...base, entryId: 'e-none' });
  L.append({ ...base, entryId: 'e-text', provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'text', usd: 0.0234 });
  const calls = [], fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization, method: init.method }); return { ok: true, status: 200, json: async () => ({ data: { id: 'gen-abc123', model: MODEL, total_cost: 0.0412 } }) }; };
  const plan = await settleImageRows({ engineCfg: CFG.engine, ledger: L, fetchImpl, key: FAKE_KEY });
  assert.equal(plan.applied, false); assert.equal(plan.checked, 2); assert.equal(L.rows().length, 3, 'the plan writes nothing');
  assert.deepEqual(calls, [{ url: CFG.engine.image.generationEndpoint + '?id=gen-abc123', auth: 'Bearer ' + FAKE_KEY, method: 'GET' }]);
  assert.deepEqual(plan.unsettled.map((x) => x.entryId), ['e-none']); assert.match(plan.unsettled[0].reason, /no generation id/);
  const day = L.spent.day(dublinDay(ts)), job = L.spent.job('j1'), imgs = L.totals.imagesByDay[dublinDay(ts)];
  const done = await settleImageRows({ engineCfg: CFG.engine, ledger: L, fetchImpl, key: FAKE_KEY, apply: true });
  const corr = done.rows[0];
  assert.deepEqual([corr.entryId, corr.correctionOf, corr.usd, corr.settledUsd, corr.count, corr.estimated], ['settle-e-with', withId.entryId, -0.0388, 0.0412, 0, false]);
  assert.equal(L.rows().length, 4); assert.equal(L.rows().find((x) => x.entryId === 'e-with').usd, 0.08, 'history unchanged');
  assert.equal(L.spent.job('j1'), Math.round((job - 0.0388) * 1e6) / 1e6); assert.equal(L.spent.day(dublinDay(ts)), Math.round((day - 0.0388) * 1e6) / 1e6);
  assert.equal(L.totals.imagesByDay[dublinDay(ts)], imgs, 'a correction is not another image');
  // a second run: nothing left to settle with an id, nothing new written
  const again = await settleImageRows({ engineCfg: CFG.engine, ledger: L, fetchImpl, key: FAKE_KEY, apply: true });
  assert.equal(again.rows.length, 0); assert.equal(L.rows().length, 4);
  // the ledger reloads with the correction (the JSONL wins), and refuses bad corrections
  assert.equal(L.reload().ok, true); assert.equal(L.spent.job('j1'), Math.round((job - 0.0388) * 1e6) / 1e6);
  assert.throws(() => L.append({ ...base, entryId: 'neg', usd: -0.01, estimated: false }), /only a correction row may be negative/);
  assert.throws(() => L.append({ ...base, entryId: 'c2', usd: -0.05, correctionOf: 'e-with', estimated: false }), /below 0/);
  assert.throws(() => L.append({ ...base, entryId: 'c3', usd: 0.01, correctionOf: 'settle-e-with', estimated: false }), /never another correction/);
  assert.throws(() => L.append({ ...base, entryId: 'c4', usd: 0.01, correctionOf: 'nope', estimated: false }), /not an earlier row/);
  assert.ok(noId && L.rows().find((x) => x.entryId === 'e-text').estimated !== false);
  // a lookup without the key, or a 404, settles nothing
  L.append({ ...base, entryId: 'e-later', generationId: 'gen-later1' });
  assert.match((await settleImageRows({ engineCfg: CFG.engine, ledger: L, fetchImpl, key: null })).unsettled.find((x) => x.entryId === 'e-later').reason, /no OPENROUTER_API_KEY/);
  const nf = await settleImageRows({ engineCfg: CFG.engine, ledger: L, key: FAKE_KEY, apply: true, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.match(nf.unsettled.find((x) => x.entryId === 'e-later').reason, /HTTP 404/); assert.equal(nf.rows.length, 0);
});
