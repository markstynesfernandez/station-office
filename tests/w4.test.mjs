// w4.test.mjs — W4 (owner, 21/10/2026), after the winter job's W3 report (set-v5 ended with 11 of 12 files and the job drew a fresh set-v6):
//   1 carry-over is mechanical: before DESIGNER runs a redraw pass the station copies every carried file into the new set (same bytes);
//     only the files QA DESIGN lists in "redraw" (plus any a build warning names) are drawn; a file it calls borderline is carried. A
//     carried file lost during the run is copied again by the station.
//   2 a set that fails the build short of files goes back to the SAME set: DESIGNER draws only the missing files, with QA DESIGN's
//     findings for them; never a fresh whole set
//   3 a QA-only run on an older set checks the verdict's redraw ids against the set it reviews, not the newest set
//   4 Approve / Reject set-vN only for a built set the approval would be accepted on; otherwise one line says why
//   5 the job panel's Designs show every file of the newest built set
// Every provider is a stub (a mock text script, a fake-fetch OpenRouter client, a fake upscaler): no network, no real key, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createMockText, mockPng } from '../src/engine/providers/mock.mjs';
import { createOpenRouterImage } from '../src/engine/providers/openrouter.mjs';
import { setDecisionState } from '../src/engine/lib/set-decision.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { dublinDay } from '../src/engine/time.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const LIVE = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', OPENROUTER_API_KEY: 'sk-or-v1-w4TESTKEY0123456789abcdef0123456789abcdef0', ANTHROPIC_API_KEY: 'sk-ant-api03-w4TESTKEY0123456789abcdef0123456789abcdef' };
const MODEL = 'openai/gpt-5-image-mini';
const ID = '2026-10-21--w4-winter-props';
const BRIEF = ['---', 'id: ' + ID, 'status: verified', 'product_type: pngtuber-prop-pack', '---', '# Niche', 'Cosy winter desk props for streamers', '', '## Design direction', 'Original cosy winter desk props, soft outlines, no text.', ''].join('\n');
const pad = (n) => String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rawOf = (d, n) => (fs.existsSync(path.join(d, 'set-v' + n, 'raw')) ? fs.readdirSync(path.join(d, 'set-v' + n, 'raw')).sort() : []);
const setsOf = (d) => fs.readdirSync(d).filter((f) => /^set-v\d+$/.test(f)).sort();
const capLog = (base) => { const lines = []; const put = (lvl) => (msg, data) => { lines.push({ lvl, msg, data: data || {} }); base[lvl](msg, data); }; return { ...base, lines, info: put('info'), warn: put('warn'), error: put('error') }; };
const CHECKS = (fail = []) => Object.fromEntries(['originality', 'trademarks', 'etsyPolicy', 'briefFit', 'complete', 'usable', 'matchesSpec', 'worthThePrice', 'licence'].map((k) => [k, fail.includes(k) ? 'fail' : 'pass']));
const approve = (dir, set) => ({ verdict: 'approved', manifestSha256: fs.readFileSync(path.join(dir, 'set-v' + set, 'deliverables.sha256'), 'utf8').trim(), checks: CHECKS(), worthThePrice: { verdict: 'pass', reason: 'a full, clean set' }, reasons: [] });

let PNG = null;
const png = async () => (PNG = PNG || await mockPng({ prompt: 'w4 prop', width: 1200, height: 1200, transparent: true }));
const okImage = (n) => ({ status: 200, json: { id: 'gen-' + n, model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }], usage: { cost: 0.04 } } });
function fakeFetch() {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const r = okImage(calls.length); return { ok: true, status: r.status, headers: new Headers(), json: async () => r.json }; };
  f.calls = calls; return f;
}

// an engine on live-shaped stubs; stopAt stops the job when that step starts
function liveEngine(t, { script, tag, stopAt = null }) {
  const r = tempRoot(tag), fetchImpl = fakeFetch(), log = capLog(r.log);
  const image = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log, fetchImpl });
  let engine = null;
  const text = createMockText({ script: (ctx, params) => script(ctx, params, engine) });
  const providers = { mode: 'live', text, image, web: Object.assign(async () => ({ text: '', usd: 0 }), { plan: () => ({ maxUses: 1, extraUsd: 0 }), settings: {} }) };
  const hooks = { onStep: ({ job, step, phase }) => { if (stopAt && stopAt() === step && phase === 'start') engine.orchestrator.stopJob(job.id, { expectedVersion: engine.store.getJob(job.id).version }); } };
  engine = createEngine({ archiveSandbox: true, J: r.J, log, providers, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan, hooks });
  engine.sleep = async () => {};
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  engine.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'W4 winter props', product_key: 'pngtuber-prop-pack', state: 'queued', step: 'designer', data: { createdBy: 'test' } });
  r.J.put(path.join(r.dataRoot, 'jobs', ID, 'brief.md'), BRIEF);
  return { engine, r, log, fetchImpl, d: path.join(r.dataRoot, 'jobs', ID) };
}

// DESIGNER and QA DESIGN scripted for the style-reference line. draw(info) -> the file numbers this designer batch really draws (default:
// every file its input names); qa(pass, { input, set }) -> the design record
function lineScript({ d, qa, draw = null, seen }) {
  let qaPass = 0;
  return (ctx, params) => {
    if (ctx.purpose === 'image_analyze') return { content: [{ type: 'text', text: 'a cosy prop on a transparent background, no text' }] };
    const input = String(params.messages[0].content), turn = turnOf(params);
    if (ctx.agentKey === 'designer' && /RUN MODE: FIRST FILE ONLY/.test(input)) {
      const set = Number(/set-v(\d+)\/raw\/01-/.exec(input)[1]);
      if (turn === 0) return { content: [tool('g' + set, 'image_generate', { path: 'set-v' + set + '/raw/01-steaming-mug.png', prompt: 'a steaming mug, soft outline', transparent: true })] };
      if (turn === 1) return { content: [tool('w' + set, 'fs_write', { path: 'set-v' + set + '/design.md', content: '# Plan\n\n### 01-steaming-mug\nprompt: a steaming mug, soft outline\n' })] };
      return { content: [{ type: 'text', text: 'file 1 drawn' }] };
    }
    if (ctx.agentKey === 'designer' && /RUN MODE: (REST OF SET|REDRAW FLAGGED FILES|DRAW MISSING FILES)/.test(input)) {
      const set = Number(/Write set-v(\d+):/.exec(input)[1]), head = /files ([\d, –]+) of \d+\]/.exec(input)[1];
      const files = head.includes('–') ? range(...head.split('–').map(Number)) : head.split(',').map((x) => Number(x.trim()));
      const mode = /RUN MODE: ([A-Z ]+) —/.exec(input)[1];
      if (turn === 0) seen.designer.push({ input, set, files, mode, rawAtStart: rawOf(d(), set) });
      const drawn = draw ? draw({ set, files, mode, turn }) : files;
      if (turn === 0) return { content: drawn.map((n) => tool('g' + set + '-' + n, 'image_generate', { path: 'set-v' + set + '/raw/' + pad(n) + '-prop-' + n + '.png', prompt: 'winter desk prop ' + n + ', soft outline', transparent: true })) };
      if (turn === 1) {
        const f = path.join(d(), 'set-v' + set, 'design.md'), was = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Plan\n';
        return { content: [tool('w' + set + '-' + files[0], 'fs_write', { path: 'set-v' + set + '/design.md', content: was.replace(/\n*$/, '\n\n') + files.map((n) => '### ' + pad(n) + '-prop-' + n + '\nprompt: winter desk prop ' + n + ', soft outline (set-v' + set + ')').join('\n\n') + '\n' })] };
      }
      return { content: [{ type: 'text', text: 'batch drawn' }] };
    }
    if (ctx.agentKey === 'qa-design' && /RUN MODE: FILE 1 CHECK/.test(input)) {
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      const file = /"file": "([^"]+)"/.exec(input)[1];
      return { content: [tool('v1', 'submit_verdict', { record: { stage: 'file1', listingId: ctx.jobId, file, verdict: 'approved', checks: { originality: 'pass', usable: 'pass', styleReference: 'pass' }, reasons: [] } })] };
    }
    if (ctx.agentKey === 'qa-design') {
      if (turn > 0) { seen.qaReplies.push(...lastResults(params)); return { content: [{ type: 'text', text: 'verdict recorded' }] }; }
      qaPass++; seen.qa.push(input);
      const set = Number(/DESIGN: work\/[^/]+\/set-v(\d+)\/deliverables\.json/.exec(input)[1]);
      return { content: [tool('d' + qaPass, 'submit_verdict', { record: { stage: 'design', listingId: ctx.jobId, designFile: 'jobs/' + ctx.jobId + '/set-v' + set + '/deliverables.json', ...qa(qaPass, { input, set }) } })] };
    }
    return { content: [{ type: 'text', text: 'nothing scripted' }] };
  };
}
// QA DESIGN pass 1 on the winter pattern: one required redraw (03), two files only borderline (02 and 09)
const WINTER_REVISE = (redraw) => ({ verdict: 'revise', checks: CHECKS(['briefFit', 'usable']), worthThePrice: { verdict: 'fail', reason: 'the scarf still reads as a blanket' }, redraw,
  reasons: ['briefFit 03-prop-3.png: still reads as a folded throw blanket; redraw as a narrow scarf', 'briefFit 09-prop-9.png: the two socks differ slightly in cuff height. Borderline, not required for redraw.', 'usable 02-prop-2.png: a slightly uneven stripe. Minor and borderline; not named as a required fix.', 'Redraw list: 03-prop-3.png only.'] });

// ---- 1. carry-over is mechanical

test('1: only the required redraw (03) is drawn; the borderline 02 and 09 and every other file are in the new set, copied by the station, before DESIGNER runs', async (t) => {
  await png();
  const seen = { designer: [], qa: [], qaReplies: [] };
  let stop = null;
  const env = liveEngine(t, { tag: 'w4carry', stopAt: () => stop, script: lineScript({ d: () => env.d, seen, qa: (pass, { set }) => { if (pass === 1) return WINTER_REVISE(['03-prop-3']); stop = 'lister'; return approve(env.d, set); } }) });
  const { engine, fetchImpl, d } = env;
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'lister');
  assert.deepEqual(setsOf(d), ['set-v1', 'set-v2', 'set-v3']);
  assert.equal(fetchImpl.calls.length, 12 + 1, 'file 03 only after the review');
  const rework = seen.designer.filter((x) => x.set === 3);
  assert.equal(rework.length, 1); assert.deepEqual(rework[0].files, [3]); assert.equal(rework[0].mode, 'REDRAW FLAGGED FILES');
  // the carried files were in set-v3/raw/ before DESIGNER's first turn: the station copied them, not DESIGNER
  assert.deepEqual(rework[0].rawAtStart, [2, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => pad(n) + '-prop-' + n + '.png'));
  for (const n of [2, 9, 4, 12]) assert.equal(sha(path.join(d, 'set-v3', 'raw', pad(n) + '-prop-' + n + '.png')), sha(path.join(d, 'set-v2', 'raw', pad(n) + '-prop-' + n + '.png')), 'file ' + pad(n) + ' carried byte for byte');
  const rw = JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'rework.json'), 'utf8'));
  assert.deepEqual(rw.redraw.map((x) => x.n), [3], 'borderline files are not on the redraw list');
  assert.ok(rw.carried.some((c) => c.name === '02-prop-2.png') && rw.carried.some((c) => c.name === '09-prop-9.png'));
  assert.deepEqual(rawOf(d, 3), ['01-steaming-mug.png', ...range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png')]);
  // QA DESIGN is told that borderline files stay out of "redraw"
  assert.match(seen.qa[0], /Name only the files that MUST be redrawn: a file you call borderline or acceptable stays out of "redraw" and is carried unchanged\./);
});

test('1: a carried file lost while DESIGNER redraws is copied again by the station (same bytes); the set is whole and no new set is started', async (t) => {
  await png();
  const seen = { designer: [], qa: [], qaReplies: [] };
  let stop = null;
  const env = liveEngine(t, { tag: 'w4lost', stopAt: () => stop,
    script: lineScript({ d: () => env.d, seen, qa: (pass, { set }) => { if (pass === 1) return WINTER_REVISE(['03-prop-3']); stop = 'lister'; return approve(env.d, set); },
      draw: ({ set, files, turn }) => { if (set === 3 && turn === 0) fs.rmSync(path.join(env.d, 'set-v3', 'raw', '09-prop-9.png')); return files; } }) });
  const { engine, fetchImpl, log, d } = env;
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'lister');
  assert.deepEqual(setsOf(d), ['set-v1', 'set-v2', 'set-v3']);
  assert.equal(fetchImpl.calls.length, 12 + 1);
  assert.equal(sha(path.join(d, 'set-v3', 'raw', '09-prop-9.png')), sha(path.join(d, 'set-v2', 'raw', '09-prop-9.png')));
  assert.ok(log.lines.some((x) => x.msg === 'carried file copied again by the station' && x.data.file === '09-prop-9.png'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'build.json'), 'utf8')).files.length, 12);
});

// ---- 2. missing files go back to the same set

test('2: a redraw pass where DESIGNER skips a file it was asked to draw: the build fails short, DESIGNER draws only that file into the same set with QA\'s findings; 12 files, no fresh set', async (t) => {
  await png();
  const seen = { designer: [], qa: [], qaReplies: [] };
  let stop = null;
  const env = liveEngine(t, { tag: 'w4missing', stopAt: () => stop,
    script: lineScript({ d: () => env.d, seen, qa: (pass, { set }) => { if (pass === 1) return WINTER_REVISE(['03-prop-3', '09-prop-9']); stop = 'lister'; return approve(env.d, set); },
      // the W3 failure: DESIGNER draws 03, says 09 was carried, and never draws it
      draw: ({ set, files, mode }) => (set === 3 && mode === 'REDRAW FLAGGED FILES' ? files.filter((n) => n !== 9) : files) }) });
  const { engine, fetchImpl, d } = env;
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'lister');
  assert.deepEqual(setsOf(d), ['set-v1', 'set-v2', 'set-v3'], 'no fresh set');
  assert.deepEqual(rawOf(d, 3), ['01-steaming-mug.png', ...range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png')]);
  assert.equal(fetchImpl.calls.length, 12 + 1 + 1, '03, then 09 alone');
  const fill = seen.designer.filter((x) => x.mode === 'DRAW MISSING FILES');
  assert.equal(fill.length, 1); assert.equal(fill[0].set, 3); assert.deepEqual(fill[0].files, [9]);
  assert.match(fill[0].input, /^\[RUN MODE: DRAW MISSING FILES — batch 1 of 1: files 09 of 12\] STYLE REFERENCE: /);
  assert.match(fill[0].input, /- 09 \(was 09-prop-9\.png\)\. QA DESIGN: briefFit 09-prop-9\.png: the two socks differ slightly in cuff height/);
  assert.match(fill[0].input, /\[STATION — set-v3 is not complete\] raw\/ has 11 file\(s\), the product spec lists 12/);
  assert.doesNotMatch(fill[0].input, /Write a corrected set-v4/);
  assert.equal(job.loops.prep, 1, 'the one prep retry was used');
  assert.equal(engine.store.getJob(ID).data.designSet.mode, 'missing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'qa', 'design-pass2.json'), 'utf8')).designFile, 'jobs/' + ID + '/set-v3/deliverables.json');
});

// ---- 3, 4, 5: a QA-only run on an older set; the set buttons; the Designs grid

test('3/4/5: QA-only on set-v2 while set-v3 is newer: redraw ids are checked against set-v2; the set buttons follow the pass limit; Designs show all 12 files', async (t) => {
  await png();
  const seen = { designer: [], qa: [], qaReplies: [] };
  let stop = null;
  const env = liveEngine(t, { tag: 'w4qaonly', stopAt: () => stop,
    script: lineScript({ d: () => env.d, seen, qa: (pass, { set }) => {
      if (pass === 1) { stop = 'lister'; return approve(env.d, set); }
      return WINTER_REVISE(['09-prop-9']);   // 09 is in set-v2, not in set-v3
    } }) });
  const { engine, d, r } = env;
  let job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason);
  // the winter shape: a newer, unbuilt set-v3 with 5 of 12 files, and QA's pass 1 on set-v2 (no outbox approval: the test reviews set-v2)
  fs.rmSync(path.join(d, 'outbox'), { recursive: true, force: true }); fs.rmSync(path.join(d, 'qa', 'design-pass1.json'));
  r.J.put(path.join(d, 'qa', 'design-pass1.json'), JSON.stringify({ stage: 'design', listingId: ID, pass: 1, verdict: 'revise', designFile: 'jobs/' + ID + '/set-v2/deliverables.json', checks: CHECKS(['briefFit']), reasons: ['briefFit 03-prop-3.png: reads as a blanket'], redraw: ['03-prop-3'] }));
  for (const n of [2, 3, 4, 5, 6]) r.J.copy(path.join(d, 'set-v2', 'raw', pad(n) + '-prop-' + n + '.png'), path.join(d, 'set-v3', 'raw', pad(n) + '-gen-' + n + '.png'));
  engine.store.updateJob(ID, { state: 'blocked', step: 'designer', reason: 'DESIGNER run failed: OpenRouter connection failed: fetch failed' });
  // 4: set-v3 is newest and unbuilt; set-v2 (QA pass 1 of 3) cannot be approved yet
  let c = engine.orchestrator.controlsFor(engine.store.getJob(ID));
  assert.equal(c.setDecision, null);
  assert.equal(c.setDecisionNote, 'set-v3 is not built: 5 of 12 files; set-v2: your set approval stands in for QA DESIGN only at the pass limit (1 of 3 passes) or after a post-fix');
  // 3: QA-only on set-v2 names 09-prop-9, a file of set-v2 only: accepted at once (no refusal)
  const q = engine.orchestrator.qaOnly(ID, { set: 2, maxUsd: 1, expectedVersion: engine.store.getJob(ID).version });
  job = await q.run;
  const rec2 = JSON.parse(fs.readFileSync(path.join(d, 'qa', 'design-pass2.json'), 'utf8'));
  assert.deepEqual([rec2.verdict, rec2.redraw, rec2.redrawProblem || null], ['revise', ['09-prop-9'], null]);
  assert.equal(seen.qaReplies.filter((x) => x.is_error).length, 0, 'never refused against set-v3');
  // 4: at the pass limit (a third pass on set-v2) the buttons are offered for set-v2; the newer unbuilt set is still named
  engine.store.updateJob(ID, { state: 'blocked' });
  r.J.put(path.join(d, 'qa', 'design-pass3.json'), JSON.stringify({ ...rec2, pass: 3, redraw: ['03-prop-3'] }));
  c = engine.orchestrator.controlsFor(engine.store.getJob(ID));
  assert.deepEqual(c.setDecision, { set: 2 }); assert.equal(c.setDecisionNote, 'set-v3 is not built: 5 of 12 files');
  // and the owner's set approval is accepted there: every file decided (03 kept over QA's finding), then the set approved
  for (const name of rawOf(d, 2)) {
    const keep = name === '03-prop-3.png';
    engine.owner.recordFileDecision(ID, { set: 2, name, decision: keep ? 'keep' : 'approved', ...(keep ? { qaPass: 3, qaSaid: 'reads as a blanket', check: 'briefFit', reason: 'reads as a folded scarf at desk size' } : {}), date: dublinDay(), expectedVersion: engine.store.getJob(ID).version });
  }
  const sa = engine.owner.approveSet(ID, { set: 2, words: 'the set is ready for the listing', date: dublinDay(), expectedVersion: engine.store.getJob(ID).version });
  assert.equal(sa.set, 2); assert.ok(fs.existsSync(path.join(d, 'owner-set-approval.json')));
  // without the newer set the line is empty; an approved last pass offers nothing
  fs.rmSync(path.join(d, 'set-v3'), { recursive: true });
  assert.deepEqual(setDecisionState({ roomDir: r.dataRoot, id: ID, newest: 2, total: 12 }), { set: 2, ok: true, rule: null, reviewedPreviews: [], note: null });
  r.J.put(path.join(d, 'qa', 'design-pass3.json'), JSON.stringify({ ...rec2, pass: 3, verdict: 'approved' }));
  assert.equal(setDecisionState({ roomDir: r.dataRoot, id: ID, newest: 2, total: 12 }).note, 'QA DESIGN approved set-v2 (pass 3): no set approval is needed');
  // 5: the Designs grid holds every file of the newest built set, with its name
  const sj = buildEngineSnapshot(engine).jobs.find((x) => x.id === ID);
  assert.equal(sj.designSet.set, 2);
  assert.deepEqual(sj.designSet.images.map((i) => i.name), ['01-steaming-mug.png', ...range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png')]);
  const sp = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'ui', 'sidepanel.js'), 'utf8');
  assert.match(sp, /designGrid\(j\.designSet\)/); assert.doesNotMatch(sp, /imgs\(j\.images\)/, 'no longer the last two pictures');
  assert.match(sp, /c\.setDecisionNote/);
});
