// w2.test.mjs — W2 (owner, 20/10/2026), after the winter job's W1 report:
//   1 a DESIGNER pass after a QA DESIGN revise redraws only the files the verdict names (and any a build warning names); the rest are
//     copied into the new set byte for byte; the build and QA DESIGN still cover every file. L3 (owner, 21/10/2026): the files are the
//     record's "redraw" ids, and a revise without them blocks the job (the whole-set redraw is gone; tests/l3.test.mjs has the refusal)
//   2 a Resume after a run failed mid-pass carries on the same set from the first file not yet done
//   3 a dropped connection (no HTTP response) is retried like a 429/5xx, logged per attempt; after the last retry the run ends and the
//     job is blocked (never handed back to the agent); 400 and 401 are never retried
//   4 such a call's ledger row is estimated at its reserved maximum with the reason "no response (connection failed)"; the owner
//     settles it with npm run settle:failed (appended correction rows only, dry run by default)
//   6 Mark published takes Etsy's country links and stores the plain listing URL
// Every provider is a stub (a mock text script, the mock or a fake-fetch OpenRouter client, a fake Anthropic client, a fake upscaler):
// no network, no real key, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createMockText, mockPng } from '../src/engine/providers/mock.mjs';
import { createOpenRouterImage } from '../src/engine/providers/openrouter.mjs';
import { createAnthropicText, normaliseError, makeRedactor } from '../src/engine/providers/anthropic.mjs';
import { connectionFailure, isConnectionError, NO_RESPONSE } from '../src/engine/providers/connection.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { settleFailedRows, failedCallRows, LEGACY_NOTES } from '../src/engine/lib/settle-failed.mjs';
import { etsyListingUrl } from '../src/engine/orchestrator.mjs';
import { dublinDay } from '../src/engine/time.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const FAKE_OR = 'sk-or-v1-w2TESTKEY0123456789abcdef0123456789abcdef0', FAKE_ANT = 'sk-ant-api03-w2TESTKEY0123456789abcdef0123456789abcdef';
const LIVE = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', OPENROUTER_API_KEY: FAKE_OR, ANTHROPIC_API_KEY: FAKE_ANT };
const MODEL = 'openai/gpt-5-image-mini', SONNET = 'claude-sonnet-5-5';
const ID = '2026-10-20--w2-winter-props';
const BRIEF = ['---', 'id: ' + ID, 'status: verified', 'product_type: pngtuber-prop-pack', '---', '# Niche', 'Cosy winter desk props for streamers', '', '## Design direction', 'Original cosy winter desk props, soft outlines, no text.', ''].join('\n');
const pad = (n) => String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rawOf = (d, n) => (fs.existsSync(path.join(d, 'set-v' + n, 'raw')) ? fs.readdirSync(path.join(d, 'set-v' + n, 'raw')).sort() : []);
const setsOf = (d) => fs.readdirSync(d).filter((f) => /^set-v\d+$/.test(f)).sort();
const netError = (msg = 'Connection error.') => Object.assign(new Error(msg), { code: 'NETWORK', retryable: true });
const capLog = (base) => { const lines = []; const put = (lvl) => (msg, data) => { lines.push({ lvl, msg, data: data || {} }); base[lvl](msg, data); }; return { ...base, lines, info: put('info'), warn: put('warn'), error: put('error') }; };

let PNG = null;
const png = async () => (PNG = PNG || await mockPng({ prompt: 'w2 prop', width: 1200, height: 1200, transparent: true }));
const okImage = (n) => ({ status: 200, json: { id: 'gen-' + n, model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }], usage: { cost: 0.04 } } });
// a fake fetch: reply(n, body) -> { status, json } | an Error to throw | { status, bodyError } (the body read fails)
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    const r = await reply(calls.length, body);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(r.headers || {}), json: async () => { if (r.bodyError) throw r.bodyError; return r.json; } };
  };
  f.calls = calls; return f;
}

// an engine on the live-shaped stubs: OpenRouter with a fake fetch, a text provider (the mock script, or a fake Anthropic client)
function liveEngine(t, { reply = (n) => okImage(n), script = null, client = null, hooks = {}, tag = 'w2' } = {}) {
  const r = tempRoot(tag), fetchImpl = fakeFetch(reply), log = capLog(r.log);
  const image = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log, fetchImpl });
  let engine = null;
  const text = client ? createAnthropicText({ engineCfg: CFG.engine, env: LIVE, log, client }) : createMockText({ script: (ctx, params) => script(ctx, params, engine) });
  const providers = { mode: 'live', text, image, web: Object.assign(async () => ({ text: '', usd: 0 }), { plan: () => ({ maxUses: 1, extraUsd: 0 }), settings: {} }) };
  engine = createEngine({ archiveSandbox: true, J: r.J, log, providers, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan, hooks });
  engine.sleep = async () => {};
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const addJob = (id = ID, step = 'designer', data = {}) => { engine.store.insertJob({ id, line: 'room1-digital', kind: 'line', title: 'W2 winter props', product_key: 'pngtuber-prop-pack', state: 'queued', step, data: { createdBy: 'test', ...data } }); r.J.put(path.join(r.dataRoot, 'jobs', id, 'brief.md'), BRIEF); return engine.store.getJob(id); };
  return { engine, r, log, fetchImpl, addJob, jobDir: (id = ID) => path.join(r.dataRoot, 'jobs', id) };
}

// DESIGNER and QA DESIGN scripted for the style-reference line. qaDesign(pass, { input, set, dir }) -> the design record for that pass;
// onDesigner(info) may throw (a failure mid-batch). Every designer batch draws the files its input names and appends their sections
// to design.md (read from disk, so a later batch keeps the earlier ones).
function lineScript({ dir, qaDesign = null, onDesigner = null, seen = { designer: [], qa: [] }, extra = [] } = {}) {
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
    if (ctx.agentKey === 'designer' && /RUN MODE: (REST OF SET|REDRAW FLAGGED FILES)/.test(input)) {
      const set = Number(/Write set-v(\d+):/.exec(input)[1]), head = /files ([\d, –]+) of \d+\]/.exec(input)[1];
      const files = head.includes('–') ? range(...head.split('–').map(Number)) : head.split(',').map((x) => Number(x.trim()));
      if (turn === 0) seen.designer.push({ input, set, files });
      if (onDesigner) onDesigner({ input, set, files, turn });
      if (turn === 0) return { content: [...files, ...extra].map((n) => tool('g' + set + '-' + n, 'image_generate', { path: 'set-v' + set + '/raw/' + pad(n) + '-prop-' + n + '.png', prompt: 'winter desk prop ' + n + ', soft outline, pass ' + seen.designer.length, transparent: true })) };
      if (turn === 1) {
        const f = path.join(dir(), 'set-v' + set, 'design.md'), was = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Plan\n';
        return { content: [tool('w' + set + '-' + files[0], 'fs_write', { path: 'set-v' + set + '/design.md', content: was.replace(/\n*$/, '\n\n') + files.map((n) => '### ' + pad(n) + '-prop-' + n + '\nprompt: winter desk prop ' + n + ', soft outline (set-v' + set + ')').join('\n\n') + '\n' })] };
      }
      return { content: [{ type: 'text', text: 'batch drawn' }] };
    }
    if (ctx.agentKey === 'qa-design' && /RUN MODE: FILE 1 CHECK/.test(input)) {
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      const file = /"file": "([^"]+)"/.exec(input)[1];
      return { content: [tool('v1', 'submit_verdict', { record: { stage: 'file1', listingId: ctx.jobId, file, verdict: 'approved', checks: { originality: 'pass', usable: 'pass', styleReference: 'pass' }, reasons: [] } })] };
    }
    if (ctx.agentKey === 'qa-design' && qaDesign) {
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      qaPass++; seen.qa.push(input);
      const set = Number(/DESIGN: work\/[^/]+\/set-v(\d+)\/deliverables\.json/.exec(input)[1]);
      return { content: [tool('d' + qaPass, 'submit_verdict', { record: { stage: 'design', listingId: ctx.jobId, designFile: 'jobs/' + ctx.jobId + '/set-v' + set + '/deliverables.json', ...qaDesign(qaPass, { input, set, dir: dir() }) } })] };
    }
    return { content: [{ type: 'text', text: 'nothing scripted' }] };
  };
}
const CHECKS = (fail = []) => Object.fromEntries(['originality', 'trademarks', 'etsyPolicy', 'briefFit', 'complete', 'usable', 'matchesSpec', 'worthThePrice', 'licence'].map((k) => [k, fail.includes(k) ? 'fail' : 'pass']));
const approve = (dir, set) => ({ verdict: 'approved', manifestSha256: fs.readFileSync(path.join(dir, 'set-v' + set, 'deliverables.sha256'), 'utf8').trim(), checks: CHECKS(), worthThePrice: { verdict: 'pass', reason: 'a full, clean set for the price' }, reasons: [] });

// ---- 1. redraw only what QA flagged

test('1: after a QA DESIGN revise only the named files (and a build-warning file) are redrawn; the rest are copied byte for byte; the build and QA cover all 12', async (t) => {
  await png();
  const seen = { designer: [], qa: [] };
  let stopAt = null;
  const env = liveEngine(t, { tag: 'w2flag', hooks: { onStep: ({ job, step, phase }) => { if (stopAt && step === stopAt && phase === 'start') engine.orchestrator.stopJob(job.id, { expectedVersion: engine.store.getJob(job.id).version }); } },
    script: lineScript({ dir: () => env.jobDir(), seen, extra: [], qaDesign: (pass, { set, dir }) => {
      if (pass === 1) {
        // a build warning on file 07 of the reviewed set (the station's near-white fill check), named by no reason
        const mf = path.join(dir, 'set-v' + set, 'deliverables.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        fs.writeFileSync(mf, JSON.stringify({ ...m, buildWarnings: ['07-prop-7.png: 1 near-white fill(s), pure white or grey-white (generator px 1,1,2,2)'] }, null, 2));
        return { verdict: 'revise', checks: CHECKS(['usable', 'briefFit']), worthThePrice: { verdict: 'fail', reason: 'two props are rough' }, redraw: ['03-prop-3', '10-prop-10.png'],
          reasons: ['usable 03-prop-3.png: a stray mark on the left edge', 'briefFit 10-prop-10: reads as the wrong object; also 01-steaming-mug.png stripe is rust, not cranberry', 'the outline weight drifts a little across the set', 'Checked and fine: files 02, 04, 05 and 12 at 2000x2000, as of 2026-10-19'] };
      }
      stopAt = 'lister';
      return approve(dir, set);
    } }) });
  const { engine, fetchImpl, addJob, jobDir } = env, d = jobDir();
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'lister');
  assert.deepEqual(setsOf(d), ['set-v1', 'set-v2', 'set-v3'], 'file 1 in set-v1, the set in set-v2, the rework in set-v3');
  // pass 1: file 1 + files 02-12 in two batches = 12 images; pass 2: files 03, 07, 10 only, in one batch
  assert.equal(fetchImpl.calls.length, 12 + 3);
  const pass2 = seen.designer.filter((x) => x.set === 3);
  assert.equal(pass2.length, 1); assert.deepEqual(pass2[0].files, [3, 7, 10]);
  const inp = pass2[0].input;
  assert.match(inp, /^\[RUN MODE: REDRAW FLAGGED FILES — batch 1 of 1: files 03, 07, 10 of 12\] STYLE REFERENCE: work\/2026-10-20--w2-winter-props\/set-v1\/raw\/01-steaming-mug\.png/);
  assert.match(inp, /QA DESIGN \(pass 1\) asked for a revise of set-v2\. set-v3\/raw\/ already holds every file it did not flag, copied unchanged from set-v2 \(02-prop-2\.png, 04-prop-4\.png, 05-prop-5\.png, 06-prop-6\.png, 08-prop-8\.png, 09-prop-9\.png, 11-prop-11\.png, 12-prop-12\.png\)/);
  assert.match(inp, /- 03 \(was 03-prop-3\.png\)\. QA DESIGN: usable 03-prop-3\.png: a stray mark on the left edge\n/);
  assert.match(inp, /- 07 \(was 07-prop-7\.png\)\. Build warning: 07-prop-7\.png: 1 near-white fill/);
  assert.match(inp, /- 10 \(was 10-prop-10\.png\)\. QA DESIGN: briefFit 10-prop-10: reads as the wrong object/);
  assert.match(inp, /QA DESIGN's reasons that name no file \(apply them to the files you draw\): the outline weight drifts a little across the set \| Checked and fine/);
  assert.match(inp, /QA DESIGN also named file 01: it is the approved style reference and is never redrawn here/);
  // the carried files are the same bytes; the redrawn ones are new; prep added file 1 and built all 12
  for (const n of [2, 4, 5, 6, 8, 9, 11, 12]) assert.equal(sha(path.join(d, 'set-v3', 'raw', pad(n) + '-prop-' + n + '.png')), sha(path.join(d, 'set-v2', 'raw', pad(n) + '-prop-' + n + '.png')), 'file ' + pad(n) + ' carried unchanged');
  assert.deepEqual(rawOf(d, 3), ['01-steaming-mug.png', ...range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png')]);
  const rw = JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'rework.json'), 'utf8'));
  assert.deepEqual([rw.set, rw.from, rw.qaPass, rw.redraw.map((x) => x.n), rw.carried.length, rw.file1Named], [3, 2, 1, [3, 7, 10], 8, true]);
  assert.deepEqual(rw.redraw[1].buildWarnings.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'build.json'), 'utf8')).files.length, 12, 'the new set is built whole');
  assert.ok(fs.existsSync(path.join(d, 'set-v3', 'deliverables.json')));
  const md = fs.readFileSync(path.join(d, 'set-v3', 'design.md'), 'utf8');
  assert.match(md, /^## Station plan/m); assert.match(md, /### 05-prop-5\nprompt: winter desk prop 5, soft outline \(set-v2\)/, 'carried prompts kept'); assert.match(md, /### 03-prop-3\nprompt: winter desk prop 3, soft outline \(set-v3\)/);
  // QA DESIGN reviews the whole new set and is told how it was made; every review is told to name the files to redraw
  assert.match(seen.qa[0], /\[STATION\] On revise, list each file to redraw in the record's "redraw" field by its file id \(NN-subject, without \.png; this set: 02-prop-2 to 12-prop-12; 01 is the style reference and is never redrawn\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'qa', 'design-pass1.json'), 'utf8')).redraw, ['03-prop-3', '10-prop-10'], 'the ids as recorded (.png dropped)');
  assert.match(seen.qa[1], /\[STATION — set-v3 reworks set-v2 after QA DESIGN pass 1\] Redrawn for your findings: 03, 07, 10\. Carried unchanged \(copied byte for byte, same sha256\) from set-v2: 02-prop-2\.png, .*12-prop-12\.png\. Review EVERY file of the set as usual\./);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'qa', 'design-pass2.json'), 'utf8')).verdict, 'approved');
  assert.equal(engine.store.getJob(ID).data.designSet.status, 'drawn');
  assert.equal(engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image' && !x.correctionOf).length, 15);
});

test('1 (L3): a revise that names no file 02-12 (only file 01 in its reasons, no "redraw" ids) no longer redraws the whole set: the job blocks', async (t) => {
  await png();
  const seen = { designer: [], qa: [] };
  const env = liveEngine(t, { tag: 'w2whole',
    script: lineScript({ dir: () => env.jobDir(), seen, qaDesign: () => ({ verdict: 'revise', checks: CHECKS(['briefFit']), worthThePrice: { verdict: 'fail', reason: 'too dark overall' }, reasons: ['briefFit 01-steaming-mug.png: the palette is too dark for the brief', 'the set as a whole is too dark'] }) }) });
  const { engine, fetchImpl, addJob, jobDir } = env;
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'blocked', job.reason); assert.equal(job.step, 'qa-design');
  assert.match(job.reason, /^QA DESIGN pass 1 asked for a revise without naming the files to redraw \(/);
  assert.equal(fetchImpl.calls.length, 12, 'nothing drawn after the review');
  assert.equal(seen.designer.filter((x) => x.set === 3).length, 0);
  assert.ok(!fs.existsSync(path.join(jobDir(), 'set-v3')));
  assert.equal((engine.store.getJob(ID).loops || {}).design || 0, 0, 'no design loop used');
});

// L3 (owner, 21/10/2026): QA DESIGN scripted per review; first(turn, rec, params) answers the first set review, the second approves
function namingScript(env, seen, first) {
  const base = lineScript({ dir: () => env.jobDir(), seen });
  let reviews = 0;
  return (ctx, params) => {
    const input = String(params.messages[0].content);
    if (ctx.agentKey !== 'qa-design' || /RUN MODE: FILE 1 CHECK/.test(input)) return base(ctx, params);
    const turn = turnOf(params), set = Number(/DESIGN: work\/[^/]+\/set-v(\d+)\/deliverables\.json/.exec(input)[1]);
    if (turn === 0) { reviews++; seen.qa.push(input); }
    const rec = (extra) => ({ record: { stage: 'design', listingId: ctx.jobId, designFile: 'jobs/' + ctx.jobId + '/set-v' + set + '/deliverables.json', ...extra } });
    if (reviews === 1) return first(turn, rec, params);
    return turn === 0 ? { content: [tool('ok' + set, 'submit_verdict', rec(approve(env.jobDir(), set)))] } : { content: [{ type: 'text', text: 'verdict recorded' }] };
  };
}
const REVISE5 = { verdict: 'revise', checks: CHECKS(['usable']), worthThePrice: { verdict: 'fail', reason: 'one prop is rough' }, reasons: ['usable 05-prop-5.png: the handle is cut off at the right edge'] };

test('1 (L3): a revise without file ids is refused back to QA DESIGN once with the reason; named then, only those files are redrawn', async (t) => {
  await png();
  const seen = { designer: [], qa: [] }, replies = [];
  let stopAt = null, qa = null;
  const env = liveEngine(t, { tag: 'w2once', hooks: { onStep: ({ job, step, phase }) => { if (step === 'qa-design' && phase === 'end' && job.loops.design === 1) stopAt = 'lister'; if (stopAt && step === stopAt && phase === 'start') engine.orchestrator.stopJob(job.id, { expectedVersion: engine.store.getJob(job.id).version }); } },
    script: (ctx, params) => (qa = qa || namingScript(env, seen, (turn, rec, p) => {
      if (turn === 0) return { content: [tool('n1', 'submit_verdict', rec(REVISE5))] };
      if (turn === 1) { replies.push(...lastResults(p)); return { content: [tool('n2', 'submit_verdict', rec({ ...REVISE5, redraw: ['05-prop-5'] }))] }; }
      return { content: [{ type: 'text', text: 'verdict recorded' }] };
    }))(ctx, params) });
  const { engine, fetchImpl, addJob, jobDir } = env, d = jobDir();
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'lister');
  assert.equal(replies.length, 1); assert.equal(replies[0].is_error, true);
  assert.match(String(replies[0].content), /^QA record refused \(this happens once\): no "redraw" field: a revise names the files to redraw in "redraw": a list of file ids \(NN-subject, e\.g\. 10-wooden-sled\) from set-v2\. The file ids of set-v2 you may name: 02-prop-2, 03-prop-3, .*12-prop-12\. Call submit_verdict again/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'qa', 'design-pass1.json'), 'utf8')).redraw, ['05-prop-5']);
  assert.equal(fetchImpl.calls.length, 12 + 1, 'file 05 only');
  assert.deepEqual(seen.designer.filter((x) => x.set === 3).map((x) => x.files), [[5]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'rework.json'), 'utf8')).redraw.map((x) => x.n), [5]);
});

test('1 (L3): a revise that names a file not in the set, and again after the refusal, blocks the job with the reason; nothing is redrawn', async (t) => {
  await png();
  const seen = { designer: [], qa: [] };
  let qa = null;
  const env = liveEngine(t, { tag: 'w2bad',
    script: (ctx, params) => (qa = qa || namingScript(env, seen, (turn, rec) => (turn < 2 ? { content: [tool('b' + turn, 'submit_verdict', rec({ ...REVISE5, redraw: [turn ? '98-wooden-sled' : '99-nope'] }))] } : { content: [{ type: 'text', text: 'verdict recorded' }] })))(ctx, params) });
  const { engine, fetchImpl, addJob, jobDir } = env;
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'blocked'); assert.equal(job.step, 'qa-design');
  assert.match(job.reason, /^QA DESIGN pass 1 asked for a revise without naming the files to redraw \(not a file of set-v2: "98-wooden-sled" \(a revise names the files to redraw in "redraw": .*\)\): nothing is redrawn; the owner decides/);
  const rec = JSON.parse(fs.readFileSync(path.join(jobDir(), 'qa', 'design-pass1.json'), 'utf8'));
  assert.deepEqual([rec.verdict, rec.redraw, rec.redrawGiven], ['revise', [], ['98-wooden-sled']]);
  assert.equal(fetchImpl.calls.length, 12); assert.ok(!fs.existsSync(path.join(jobDir(), 'set-v3')));
});

// ---- 2. Resume carries on the set in progress

test('2: a mock failure mid-batch blocks the job; Resume carries on the same set and generates only the remaining files', async (t) => {
  const r = tempRoot('w2resume');
  let failOnce = true, stopAtPrep = false;
  const seen = { designer: [], qa: [] }, d = path.join(r.dataRoot, 'jobs', ID);
  const script = lineScript({ dir: () => d, seen, onDesigner: ({ set, files, turn }) => {
    // batch 1 of set-v2 (files 02-07): the first reply draws 02-04 only, then the connection drops
    if (failOnce && set === 2 && files[0] === 2 && turn === 1) { failOnce = false; throw netError(); }
  } });
  const firstBatch = script;
  const wrapped = (ctx, params) => {
    const input = String(params.messages[0].content);
    if (failOnce && ctx.agentKey === 'designer' && /REST OF SET — batch 1 of 2: files 02–07/.test(input) && turnOf(params) === 0) { seen.designer.push({ input, set: 2, files: range(2, 7) }); return { content: [2, 3, 4].map((n) => tool('g' + n, 'image_generate', { path: 'set-v2/raw/' + pad(n) + '-prop-' + n + '.png', prompt: 'winter desk prop ' + n + ', soft outline', transparent: true })) }; }
    return firstBatch(ctx, params);
  };
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: wrapped, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan,
    hooks: { onStep: ({ job, step, phase, result }) => { if (stopAtPrep && step === 'designer' && phase === 'end' && result && result.next === 'prep') engine.orchestrator.stopJob(job.id, { expectedVersion: engine.store.getJob(job.id).version }); } } });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  assert.equal(engine.providers.mode, 'mock');
  engine.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'W2 winter props', product_key: 'pngtuber-prop-pack', state: 'queued', step: 'designer', data: { createdBy: 'test' } });
  r.J.put(path.join(d, 'brief.md'), BRIEF);
  let job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'blocked'); assert.equal(job.step, 'designer'); assert.match(job.reason, /^DESIGNER run failed: Connection error\./);
  assert.deepEqual(rawOf(d, 2), ['02-prop-2.png', '03-prop-3.png', '04-prop-4.png']);
  assert.deepEqual([job.data.designSet.set, job.data.designSet.mode, job.data.designSet.status], [2, 'rest', 'drawing']);
  const before = Object.fromEntries([2, 3, 4].map((n) => [n, sha(path.join(d, 'set-v2', 'raw', pad(n) + '-prop-' + n + '.png'))]));
  const imagesBefore = engine.providers.image.calls;
  assert.equal(imagesBefore, 1 + 3, 'file 1 and 02-04');
  // the failed call: estimated at its reservation (USD 0 on the mock) with the no-response reason
  const failed = engine.ledger.rowsForJob(ID).filter((x) => x.estimated);
  assert.equal(failed.length, 1); assert.equal(failed[0].reason, NO_RESPONSE);
  // Resume: the same set-v2, files 05-12 only (two batches: 05-10, 11-12); 02-04 kept as they were
  stopAtPrep = true;
  const rs = engine.orchestrator.restartJob(ID, { expectedVersion: job.version });
  job = await rs.run;
  assert.equal(job.state, 'stopped', job.reason); assert.equal(job.step, 'prep');
  assert.deepEqual(setsOf(d), ['set-v1', 'set-v2'], 'no new set was started');
  assert.equal(engine.providers.image.calls - imagesBefore, 8, 'only the 8 remaining files were generated');
  const after = seen.designer.slice(1);
  assert.deepEqual(after.map((x) => x.files), [range(5, 10), range(11, 12)]);
  assert.match(after[0].input, /^\[RUN MODE: REST OF SET — batch 1 of 2: files 05–10 of 12\]/);
  assert.match(after[0].input, /RESUMED: set-v2\/raw\/ already holds file\(s\) 02, 03, 04 of this set from the run that stopped: keep them, never draw them again\./);
  assert.deepEqual(rawOf(d, 2), range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png'));
  for (const n of [2, 3, 4]) assert.equal(sha(path.join(d, 'set-v2', 'raw', pad(n) + '-prop-' + n + '.png')), before[n], 'file ' + pad(n) + ' kept');
  assert.equal(engine.store.getJob(ID).data.designSet.status, 'drawn');
});

// ---- 3. dropped connections

test('3: the Anthropic provider sorts a dropped connection as retryable (SDK class, a raw socket error, a timeout); 400 and 401 are final', () => {
  const redact = makeRedactor([FAKE_ANT]);
  const cases = [
    [new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'NETWORK', true],
    [new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }), 'TIMEOUT', true],
    [Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), 'NETWORK', true],
    [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) }), 'NETWORK', true],
    [Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers()), 'HTTP_400', false],
    [Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'x', new Headers()), 'HTTP_401', false],
    [new Error('something else'), 'UNKNOWN', false]
  ];
  for (const [e, code, retry] of cases) {
    const n = normaliseError(e, redact);
    assert.equal(n.code, code, e.message); assert.equal(n.retryable, retry, e.message);
    assert.equal(isConnectionError(n), ['NETWORK', 'TIMEOUT'].includes(code));
  }
  assert.equal(connectionFailure(Object.assign(new Error('x'), { status: 502 })), false, 'an HTTP status is never a connection failure');
});

// a fake Anthropic SDK client: reply(n, body) -> a message, or an error to throw
const fakeClient = (reply) => { const calls = []; return { calls, messages: { create: async (body) => { calls.push(body); const r = await reply(calls.length, body); if (r instanceof Error) throw r; return { id: 'msg_' + calls.length, type: 'message', role: 'assistant', model: body.model, content: r.content, stop_reason: r.stop_reason || 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }, _request_id: 'req_' + calls.length }; } } }; };
const designerRun = (engine, job) => runAgent(engine, { agentKey: 'designer', job, step: 'designer', pass: 1, folder: path.join(engine.J.dataRoot, 'jobs', job.id), folderLabel: 'the job folder', input: 'test run', line: 'room1-digital' });
const textRows = (engine) => engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'text');

test('3/4: a dropped Anthropic connection is retried with a new reservation and logged each time; failed attempts are estimated with the no-response reason', async (t) => {
  const client = fakeClient((n) => (n <= 2 ? new Anthropic.APIConnectionError({ message: 'Connection error.' }) : { content: [{ type: 'text', text: 'done' }] }));
  const { engine, log, addJob } = liveEngine(t, { tag: 'w2ant', client });
  const run = await designerRun(engine, addJob());
  assert.equal(run.status, 'done', run.endReason);
  assert.equal(client.calls.length, 3, 'two retries (live.retries 2), then it went through');
  assert.equal(log.lines.filter((x) => x.msg === 'provider call failed; retrying with a new reservation').length, 2);
  assert.equal(log.lines.filter((x) => x.msg === 'anthropic call failed' && x.data.code === 'NETWORK').length, 2);
  const rows = textRows(engine);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => [x.estimated, x.reason || null, x.usd === x.reservedUsd]), [[true, NO_RESPONSE, true], [true, NO_RESPONSE, true], [false, null, false]]);
  assert.equal(rows[2].requestId, 'req_3');
});

test('3: after the last retry the run ends (the job is blocked); 400 and 401 are never retried', async (t) => {
  for (const [label, err, calls] of [['dropped', () => new Anthropic.APIConnectionError({ message: 'Connection error.' }), 3], ['400', () => Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'bad', new Headers()), 1], ['401', () => Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'x', new Headers()), 1]]) {
    const client = fakeClient(() => err());
    const { engine, log, addJob } = liveEngine(t, { tag: 'w2last' + label, client });
    addJob();
    const job = await engine.orchestrator.startJob(ID);
    assert.equal(client.calls.length, calls, label);
    assert.equal(job.state, 'blocked', label); assert.match(job.reason, /^DESIGNER run failed: /);
    assert.equal(log.lines.some((x) => x.msg === 'provider call failed after the last retry'), label === 'dropped', label);
    const rows = textRows(engine);
    if (label === 'dropped') assert.deepEqual(rows.map((x) => x.reason), [NO_RESPONSE, NO_RESPONSE, NO_RESPONSE]);
    else assert.equal(rows.length, 0, label + ': an HTTP error is released, never billed');
  }
});

test('3: a dropped connection inside image_analyze ends the run after its last retry; it is never handed back to DESIGNER (the W1 waste)', async (t) => {
  await png();
  const isAnalyze = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
  let turns = 0;
  const client = fakeClient((n, body) => {
    if (isAnalyze(body)) return new Anthropic.APIConnectionError({ message: 'Connection error.' });
    turns++;
    return turns === 1 ? { content: [{ type: 'tool_use', id: 'tu_a', name: 'image_analyze', input: { path: 'set-v1/raw/01-a.png', question: 'clean edges?' } }], stop_reason: 'tool_use' } : { content: [{ type: 'text', text: 'carried on' }] };
  });
  const { engine, log, addJob, jobDir } = liveEngine(t, { tag: 'w2tool', client });
  const job = addJob();
  fs.mkdirSync(path.join(jobDir(), 'set-v1', 'raw'), { recursive: true }); fs.writeFileSync(path.join(jobDir(), 'set-v1', 'raw', '01-a.png'), PNG);
  const run = await designerRun(engine, job);
  assert.equal(run.status, 'failed'); assert.match(run.error, /connection failed/);
  assert.equal(turns, 1, 'no further DESIGNER turn after the dead connection');
  assert.equal(client.calls.filter(isAnalyze).length, 3);
  assert.ok(log.lines.some((x) => x.msg === 'connection failed after the last retry: the run ends' && x.data.tool === 'image_analyze'));
});

test('3/4: OpenRouter: a dropped connection (before or during the body) is retried, then ends the run; failed attempts are estimated with the no-response reason; 400 and 401 are never retried', async (t) => {
  await png();
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  const draw = (ctx, params) => (turnOf(params) === 0 ? { content: [tool('a', 'image_generate', { path: 'set-v1/files/a.png', prompt: 'a winter mug', transparent: true })] } : { content: [{ type: 'text', text: 'done' }] });
  // reset, then a body cut off mid-read, then an image
  const a = liveEngine(t, { tag: 'w2or1', script: draw, reply: (n) => (n === 1 ? reset() : n === 2 ? { status: 200, bodyError: Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }) } : okImage(n)) });
  const run = await designerRun(a.engine, a.addJob());
  assert.equal(run.status, 'done', run.endReason); assert.equal(a.fetchImpl.calls.length, 3);
  const rows = a.engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image');
  assert.deepEqual(rows.map((x) => [x.usd, x.estimated, x.reason || null]), [[0.08, true, NO_RESPONSE], [0.08, true, NO_RESPONSE], [0.04, false, null]]);
  assert.equal(a.log.lines.filter((x) => x.msg === 'image call failed; retrying with a new reservation').length, 2);
  // always dropped: three attempts, then the run ends (not a tool error back to DESIGNER)
  let turns = 0;
  const b = liveEngine(t, { tag: 'w2or2', script: (ctx, params) => { turns++; return draw(ctx, params); }, reply: () => reset() });
  const rb = await designerRun(b.engine, b.addJob());
  assert.equal(rb.status, 'failed'); assert.equal(b.fetchImpl.calls.length, 3); assert.equal(turns, 1);
  assert.ok(b.log.lines.some((x) => x.msg === 'image call failed after the last retry'));
  // 400 (not a content refusal) and 401: one call, nothing billed, the job's image stop
  for (const status of [400, 401]) {
    const c = liveEngine(t, { tag: 'w2or' + status, script: draw, reply: () => ({ status, json: { error: { code: status, message: 'nope' } } }) });
    const rc = await designerRun(c.engine, c.addJob());
    assert.equal(c.fetchImpl.calls.length, 1, String(status)); assert.equal(rc.status, 'refused', String(status));
    assert.equal(c.engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image').length, 0);
  }
});

// ---- 4. settle the failed-call rows

// the winter job's 16 failed calls as the live ledger holds them (before W2: no reason, the runtime's note), plus its other rows
const WINTER = '2026-10-19--cozy-winter-desk-props-for-pngtuber-and-vtuber', NOTE = LEGACY_NOTES[0];
function winterLedger(L) {
  const ts = Date.parse('2026-10-19T11:19:00Z'), row = (usd, i, agent = 'designer') => ({ entryId: 'w1-fail-' + i, ts: ts + i, jobId: WINTER, runId: 'run_' + agent, agentKey: agent, line: 'room1-digital', provider: 'anthropic', model: SONNET, kind: 'text', count: 1, tokens: null, usd, priceSource: 'config/engine.json', estimated: true, reservedUsd: usd, note: NOTE });
  const failed = [row(0.030543, 0, 'qa-design'), ...range(1, 12).map((i) => row(0.022443, i)), ...[13, 14, 15].map((i) => row(0.108223, i))];
  for (const r of failed) L.append(r);
  L.append({ entryId: 'w1-rest', ts, jobId: WINTER, runId: 'run_x', agentKey: 'designer', line: 'room1-digital', provider: 'anthropic', model: SONNET, kind: 'text', count: 1, usd: 4.358348, estimated: false });
  return failed;
}

test('4: settle:failed: list, dry run, apply (appended correction rows with who, when and the amount), never twice; the winter job\'s 16 rows to USD 0', (t) => {
  const r = tempRoot('w2settle'), log = capLog(r.log), engine = createEngine({ archiveSandbox: true, J: r.J, log, configDir: CONFIG, startScheduler: false, script: () => ({ content: [{ type: 'text', text: 'x' }] }) });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const L = engine.ledger, failed = winterLedger(L), ts = Date.parse('2026-10-20T09:00:00Z');
  // not failed-call rows: an image row with a generation id (settle:images), an e-stop abort, a settled call; one new-style row elsewhere
  L.append({ entryId: 'img-gen', ts, jobId: WINTER, runId: 'r', provider: 'openrouter', model: MODEL, kind: 'image', count: 1, usd: 0.08, estimated: true, generationId: 'gen-1', note: LEGACY_NOTES[2] });
  L.append({ entryId: 'estop', ts, jobId: WINTER, runId: 'r', provider: 'anthropic', model: SONNET, kind: 'text', count: 1, usd: 0.05, estimated: true, note: 'aborted by the e-stop mid-call; charged at the reserved maximum' });
  L.append({ entryId: 'other-new', ts, jobId: 'other-job', runId: 'r', provider: 'anthropic', model: SONNET, kind: 'text', count: 1, usd: 0.04, estimated: true, reason: NO_RESPONSE, note: NOTE });
  assert.equal(L.spent.job(WINTER), r6(4.982876 + 0.08 + 0.05));
  const fileBefore = fs.readFileSync(L.file, 'utf8'), n0 = L.rows().length;
  // the list: every failed-call row of every job
  const list = settleFailedRows({ ledger: L });
  assert.equal(list.listOnly, true); assert.deepEqual(list.settled.map((x) => x.entryId), [...failed.map((x) => x.entryId), 'other-new']);
  assert.match(list.settled[0].reason, /^legacy \(before W2: call failed without a usage report/);
  // the dry run: the plan, nothing written
  const plan = settleFailedRows({ ledger: L, jobId: WINTER, usd: 0, by: 'owner (Mark)', log, now: () => ts });
  assert.equal(plan.applied, false); assert.equal(plan.selected, 16); assert.equal(plan.totalDeltaUsd, -0.624528);
  assert.deepEqual(plan.jobs[WINTER], { rows: 16, deltaUsd: -0.624528, spentNowUsd: 5.112876, spentAfterUsd: 4.488348 });
  assert.equal(L.rows().length, n0); assert.equal(fs.readFileSync(L.file, 'utf8'), fileBefore, 'a dry run writes nothing');
  // refusals: --apply without rows named, without --usd, without --by; an amount above the charge is skipped
  assert.throws(() => settleFailedRows({ ledger: L, usd: 0, by: 'owner', apply: true }), /name the rows to settle/);
  assert.throws(() => settleFailedRows({ ledger: L, jobId: WINTER, by: 'owner', apply: true }), /--apply needs --usd/);
  assert.throws(() => settleFailedRows({ ledger: L, jobId: WINTER, usd: 0, apply: true }), /--by is required/);
  assert.throws(() => settleFailedRows({ ledger: L, jobId: WINTER, usd: -1, by: 'owner' }), /--usd must be an amount/);
  const high = settleFailedRows({ ledger: L, entryIds: ['w1-fail-1'], usd: 0.5, by: 'owner' });
  assert.equal(high.rows.length, 0); assert.match(high.skipped[0].reason, /above the row's charge/);
  // apply: one appended correction row per failed row; the originals untouched
  const done = settleFailedRows({ ledger: L, jobId: WINTER, usd: 0, by: 'owner (Mark)', apply: true, log, now: () => ts });
  assert.equal(done.applied, true); assert.equal(done.rows.length, 16);
  const c = done.rows[0];
  assert.deepEqual([c.entryId, c.correctionOf, c.usd, c.settledUsd, c.count, c.estimated, c.settledBy, c.settledAt, c.jobId], ['settle-w1-fail-0', 'w1-fail-0', -0.030543, 0, 0, false, 'owner (Mark)', new Date(ts).toISOString(), WINTER]);
  assert.match(c.note, /settles the failed-call row w1-fail-0 .* to USD 0\.000000, checked by owner \(Mark\) against the Anthropic Console on 2026-10-20: 0\.030543 \+ \(-0\.030543\) = 0\.000000/);
  assert.ok(fs.readFileSync(L.file, 'utf8').startsWith(fileBefore), 'rows are only appended');
  assert.equal(L.spent.job(WINTER), r6(4.358348 + 0.08 + 0.05));
  assert.equal(log.lines.filter((x) => x.msg === 'failed-call row settled' && x.data.by === 'owner (Mark)' && x.data.at === new Date(ts).toISOString() && x.data.settledUsd === 0).length, 16);
  // never twice; the reload keeps the corrections (the JSONL wins)
  const again = settleFailedRows({ ledger: L, jobId: WINTER, usd: 0, by: 'owner', apply: true });
  assert.equal(again.rows.length, 0); assert.equal(again.skipped.length, 16); assert.match(again.skipped[0].reason, /already settled/);
  assert.equal(L.reload().ok, true); assert.equal(L.spent.job(WINTER), r6(4.358348 + 0.08 + 0.05));
  // one row at another amount, by entry
  const one = settleFailedRows({ ledger: L, entryIds: ['other-new'], usd: 0.012345, by: 'owner', source: 'the Console usage page', apply: true });
  assert.deepEqual([one.rows[0].usd, one.rows[0].settledUsd, one.rows[0].priceSource], [-0.027655, 0.012345, 'owner: checked against the Console usage page']);
  assert.deepEqual(failedCallRows(L.rows()), []);
});

test('4: npm run settle:failed is a dry run by default and writes only with --apply', (t) => {
  const r = tempRoot('w2script');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: CONFIG, startScheduler: false, script: () => ({ content: [{ type: 'text', text: 'x' }] }) });
  winterLedger(e.ledger); const file = e.ledger.file; e.close();
  t.after(() => r.cleanup());
  const env = { ...process.env, STATION_DATA_ROOT: r.dataRoot, STATION_PROVIDER: 'mock', STATION_INSTANCE: 'dev' };
  const go = (...args) => spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'settle-failed.mjs'), ...args], { env, encoding: 'utf8', cwd: APP_ROOT });
  const before = fs.readFileSync(file, 'utf8'), out = (s) => { const a = s.search(/^\{$/m), b = s.indexOf('\n}', a); return JSON.parse(s.slice(a, b + 2)); };   // the JSON among the log lines
  const dry = go('--job', WINTER, '--usd', '0', '--by', 'owner');
  assert.equal(dry.status, 0, dry.stderr); const p = out(dry.stdout);
  assert.deepEqual([p.applied, p.selected, p.totalDeltaUsd], [false, 16, -0.624528]); assert.match(p.note, /^plan only \(dry run\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const app = go('--job', WINTER, '--usd', '0', '--by', 'owner', '--apply');
  assert.equal(app.status, 0, app.stderr); assert.equal(out(app.stdout).applied, true);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 17 + 16);
  const bad = go('--usd', '0', '--by', 'owner', '--apply');
  assert.equal(bad.status, 1); assert.match(bad.stderr, /settle-failed refused: name the rows to settle/);
});

// ---- 6. Mark published: Etsy's country links

test('6: Mark published takes https://www.etsy.com/<country>/listing/<id>/... and stores https://www.etsy.com/listing/<id>/...', (t) => {
  assert.equal(etsyListingUrl('https://www.etsy.com/ie/listing/1000000999/cosy-winter-desk-props?ref=shop'), 'https://www.etsy.com/listing/1000000999/cosy-winter-desk-props?ref=shop');
  assert.equal(etsyListingUrl('https://www.etsy.com/es/listing/42'), 'https://www.etsy.com/listing/42');
  assert.equal(etsyListingUrl(' https://etsy.com/listing/42/x '), 'https://www.etsy.com/listing/42/x');
  assert.equal(etsyListingUrl('https://www.etsy.com/listing/42'), 'https://www.etsy.com/listing/42');
  for (const bad of ['https://www.etsy.com/irl/listing/42', 'https://www.etsy.com/ie/shop/x', 'http://www.etsy.com/ie/listing/42', 'https://www.etsy.com.evil.example/ie/listing/42', 'https://www.etsy.com/ie/listing/abc']) assert.equal(etsyListingUrl(bad), null, bad);
  const r = tempRoot('w2pub'), engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: CONFIG, startScheduler: false, script: () => ({ content: [{ type: 'text', text: 'x' }] }) });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  engine.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'W2', product_key: 'pngtuber-prop-pack', state: 'approval', step: 'package', data: {} });
  engine.store.queueApproval(ID);
  const O = engine.orchestrator;
  O.decide(ID, { action: 'approve', expectedVersion: engine.store.getApproval(ID).version });
  const pub = { action: 'published', publishedOn: dublinDay(), finalTitle: 'Cosy winter desk props', finalPriceEur: 4.50, sku: 'W2-01' };
  assert.throws(() => O.decide(ID, { ...pub, etsyUrl: 'https://www.etsy.com/irl/listing/42', expectedVersion: engine.store.getApproval(ID).version }), /country link such as https:\/\/www\.etsy\.com\/ie\/listing/);
  const a = O.decide(ID, { ...pub, etsyUrl: 'https://www.etsy.com/ie/listing/1000000999/cosy-winter', expectedVersion: engine.store.getApproval(ID).version });
  assert.equal(a.etsy_url, 'https://www.etsy.com/listing/1000000999/cosy-winter');
  assert.equal(a.published.etsyUrl, 'https://www.etsy.com/listing/1000000999/cosy-winter');
  assert.equal(engine.store.getTracker(ID).etsy_listing_url, 'https://www.etsy.com/listing/1000000999/cosy-winter');
});
