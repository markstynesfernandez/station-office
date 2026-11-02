// e6-c0.test.mjs — E6 step c0 (17/10/2026): the OpenRouter image client, vision pricing, the style-reference first-file run,
// the owner's price floor (D1), thinking off for every agent (D2) and the forced tool choice finding (D3). Every test is
// stubbed: the image client gets a fake fetch, the text provider is the mock or a stub, nothing reaches the network and no
// real key is read (a fake key is planted to prove it never leaks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { useJail } from '../src/engine/store/active.mjs';
import { createMockText, mockPng } from '../src/engine/providers/mock.mjs';
import { createOpenRouterImage, classifyError, ImageProviderError, TRANSPARENT_LINE, REFERENCE_LINE } from '../src/engine/providers/openrouter.mjs';
import { createProviders } from '../src/engine/providers/index.mjs';
import { createAnthropicText, makeRedactor } from '../src/engine/providers/anthropic.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { textCost } from '../src/engine/guard.mjs';
import { visionTokens, visionSettings } from '../src/engine/lib/vision.mjs';
import { processFile } from '../src/engine/lib/digital-build.mjs';
import { briefPriceCheck, variantLadder, ownerFloor, marginAfterFees } from '../src/engine/lib/etsy-fees.mjs';
import { checkBrief } from '../src/engine/lib/brief-check.mjs';
import { checkScoutBrief } from '../src/engine/lib/scout-brief.mjs';
import { digitalListingChecks } from '../src/engine/lib/digital-gate.mjs';
import { urlsIn } from '../src/engine/lib/web-sources.mjs';
import { genreBrief, GENRES } from '../fixtures/engine/scout-script.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const PACK = CFG.products.find((p) => p.key === 'pngtuber-prop-pack');
const FAKE_KEY = 'sk-or-v1-c0TESTKEY0123456789abcdef0123456789abcdef';
const LIVE = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', OPENROUTER_API_KEY: FAKE_KEY };
const MODEL = 'openai/gpt-5-image-mini';
const ID = '2026-10-17--c0-desk-props';
const BRIEF = ['---', 'id: ' + ID, 'status: verified', 'product_type: pngtuber-prop-pack', '---', '# Niche', 'Cosy desk props for streamers', '', '## Design direction', 'Original cosy desk props, soft outlines, no text.', ''].join('\n');
const pad = (n) => String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

let PNG = null;
const png = async () => (PNG = PNG || await mockPng({ prompt: 'c0 prop', width: 96, height: 96, transparent: true }));
const okImage = (o = {}) => ({ status: 200, json: { id: 'gen-' + (o.n ?? 1), model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + (o.png || PNG).toString('base64') } }] } }], ...(o.cost === null ? {} : { usage: { cost: o.cost ?? 0.04, prompt_tokens: 20, completion_tokens: 1000 } }) } });
// a fake fetch: reply(n, body) -> { status, json, headers } or an Error to throw; every call recorded (url, headers, parsed body)
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, headers: init.headers, body });
    const r = await reply(calls.length, body);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(r.headers || {}), json: async () => r.json };
  };
  f.calls = calls; return f;
}
const capLog = () => { const lines = []; const put = (lvl) => (msg, data) => lines.push(lvl + ' ' + msg + ' ' + JSON.stringify(data || {})); return { lines, info: put('info'), warn: put('warn'), error: put('error'), written() {}, redact: (s) => s }; };

// ---- the client on its own

test('OpenRouter client: one request per image, the allowed model only, transparency asked and measured, cost and generation id returned', async () => {
  await png();
  const log = capLog(), fetchImpl = fakeFetch(() => okImage({ n: 7, cost: 0.0412 }));
  const c = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log, fetchImpl });
  const out = await c.generate({ model: MODEL, prompt: 'a steaming mug, soft outline', transparent: true, aspectRatio: '1:1' });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, headers, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(headers.Authorization, 'Bearer ' + FAKE_KEY);
  assert.deepEqual(Object.keys(body).sort(), ['image_config', 'messages', 'modalities', 'model']);
  assert.equal(body.model, MODEL); assert.deepEqual(body.modalities, ['image', 'text']); assert.deepEqual(body.image_config, { aspect_ratio: '1:1' });
  assert.equal(body.messages[0].content, 'a steaming mug, soft outline' + TRANSPARENT_LINE);
  assert.deepEqual({ usd: out.usd, priceSource: out.priceSource, generationId: out.generationId, size: out.size, transparent: out.alpha.transparent }, { usd: 0.0412, priceSource: 'provider', generationId: 'gen-7', size: '96x96', transparent: true });
  assert.ok(out.files[0].equals(PNG));
  // a reference goes as an image_url part, named a style reference only
  const ref = Buffer.from(PNG);
  await c.generate({ model: MODEL, prompt: 'a desk lamp', transparent: true, reference: { buffer: ref, mime: 'image/png', name: '01-steaming-mug.png' } });
  const parts = fetchImpl.calls[1].body.messages[0].content;
  assert.equal(parts[0].type, 'text'); assert.ok(parts[0].text.endsWith(REFERENCE_LINE));
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + ref.toString('base64') } });
  // refused before any call: another model, a string boolean, the e-stop
  await assert.rejects(c.generate({ model: 'google/gemini-3.1-flash-image', prompt: 'x', transparent: true }), (e) => e.code === 'MODEL');
  await assert.rejects(c.generate({ model: MODEL, prompt: 'x', transparent: 'true' }), (e) => e.code === 'BAD_PARAMS');
  const halted = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, halt: { isHalted: () => true }, fetchImpl });
  await assert.rejects(halted.generate({ model: MODEL, prompt: 'x', transparent: true }), (e) => e.code === 'HALT');
  assert.equal(fetchImpl.calls.length, 2);
  // live only, never demo, never without the key; providers fall back to a refusing stub without the key
  assert.throws(() => createOpenRouterImage({ engineCfg: CFG.engine, env: { OPENROUTER_API_KEY: FAKE_KEY } }), (e) => e.code === 'NOT_LIVE');
  assert.throws(() => createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, demo: true }), (e) => e.code === 'DEMO');
  assert.throws(() => createOpenRouterImage({ engineCfg: CFG.engine, env: { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live' } }), (e) => e.code === 'NO_KEY');
  assert.ok(log.lines.every((l) => !l.includes(FAKE_KEY)));
});

test('OpenRouter errors are sorted: credits and the key\'s daily limit stop the job, moderation is a refusal, 429/5xx retry; all key-free', () => {
  const red = makeRedactor([FAKE_KEY]);
  const err = (code, message, metadata) => ({ error: { code, message, ...(metadata ? { metadata } : {}) } });
  const cases = [
    [401, err(401, 'No auth credentials ' + FAKE_KEY), 'AUTH', 'hardStop'],
    [402, err(402, 'Insufficient credits'), 'CREDITS', 'hardStop'],
    [402, err(402, 'busy', { limit_source: 'openrouter_in_flight_budget' }), 'IN_FLIGHT', 'retryable'],
    [403, err(403, 'Key limit exceeded: daily limit reached for key ' + FAKE_KEY), 'KEY_LIMIT', 'hardStop'],
    [403, err(403, 'Input flagged', { reasons: ['violence'], flagged_input: 'a steaming mug' }), 'MODERATION', 'refusal'],
    [400, err(400, 'Your request was rejected by the safety system'), 'CONTENT_POLICY', 'refusal'],
    [400, err(400, 'messages: invalid'), 'HTTP_400', 'hardStop'],
    [404, err(404, 'No endpoints found'), 'MODEL_GONE', 'hardStop'],
    [408, err(408, 'timeout'), 'HTTP_408', 'retryable'],
    [429, err(429, 'Rate limited'), 'HTTP_429', 'retryable'],
    [502, err(502, 'upstream down'), 'HTTP_502', 'retryable'],
    [503, err(503, 'no provider'), 'HTTP_503', 'retryable']
  ];
  for (const [status, json, code, kind] of cases) {
    const e = classifyError(status, json, red);
    assert.ok(e instanceof ImageProviderError);
    assert.equal(e.code, code, status + ' ' + json.error.message);
    assert.equal(!!e[kind], true, code + ' is ' + kind);
    assert.equal(['hardStop', 'refusal', 'retryable'].filter((k) => e[k]).length, 1, code + ' is exactly one kind');
    assert.ok(!e.message.includes(FAKE_KEY), code + ' message is key-free');
  }
  assert.match(classifyError(403, err(403, 'Key limit exceeded'), red).message, /key's own limit \(the owner's USD 2 a day\)/);
});

test('a 200 without an image is a content refusal carrying its reported cost; a hosted URL is never downloaded', async () => {
  await png();
  const replies = [
    { status: 200, json: { id: 'gen-r', choices: [{ finish_reason: 'content_filter', message: { content: 'I can\'t draw that.' } }], usage: { cost: 0.002 } } },
    { status: 200, json: { id: 'gen-u', choices: [{ message: { images: [{ image_url: { url: 'https://cdn.example.com/x.png' } }] } }], usage: { cost: 0.03 } } },
    { status: 200, json: { id: 'gen-e', error: { code: 502, message: 'provider failed' } } }
  ];
  const fetchImpl = fakeFetch((n) => replies[n - 1]);
  const c = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, fetchImpl });
  await assert.rejects(c.generate({ model: MODEL, prompt: 'x', transparent: true }), (e) => e.refusal && e.code === 'NO_IMAGE' && e.usd === 0.002 && e.generationId === 'gen-r' && /content filter/.test(e.message));
  await assert.rejects(c.generate({ model: MODEL, prompt: 'x', transparent: true }), (e) => e.hardStop && e.code === 'BAD_RESPONSE' && e.usd === 0.03);
  await assert.rejects(c.generate({ model: MODEL, prompt: 'x', transparent: true }), (e) => e.retryable && e.code === 'HTTP_502');
  assert.equal(fetchImpl.calls.length, 3);
});

// ---- through the toolbox, the guard and the ledger (one agent run on a job, live image client with a fake fetch)

function liveEngine(t, { reply, script, text = null, hooks = {}, tag = 'c0' } = {}) {
  const r = tempRoot(tag), fetchImpl = fakeFetch(reply || (() => okImage()));
  const image = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log: r.log, fetchImpl });
  let engine = null;
  const textProvider = text || createMockText({ script: (ctx, params) => script(ctx, params, engine) });
  const providers = { mode: 'live', text: textProvider, image, web: Object.assign(async () => ({ text: '', usd: 0 }), { plan: () => ({ maxUses: 1, extraUsd: 0 }), settings: {} }) };
  engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, providers, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan, hooks });
  engine.sleep = async () => {};
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const addJob = (id = ID, brief = BRIEF, step = 'designer', data = {}) => { engine.store.insertJob({ id, line: 'room1-digital', kind: 'line', title: 'C0 desk props', product_key: 'pngtuber-prop-pack', state: 'queued', step, data: { createdBy: 'test', ...data } }); r.J.put(path.join(r.dataRoot, 'jobs', id, 'brief.md'), brief); return engine.store.getJob(id); };
  const keyFree = () => { for (const f of [...walk(r.logs), ...walk(r.dataRoot)].filter((x) => /\.(jsonl?|log|md|txt)$/.test(x))) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE_KEY), 'the key is in ' + path.relative(r.base, f)); };
  return { engine, r, fetchImpl, addJob, keyFree, jobDir: (id = ID) => path.join(r.dataRoot, 'jobs', id) };
}
const designerRun = (engine, job, input = 'test run') => runAgent(engine, { agentKey: 'designer', job, step: 'designer', pass: 1, folder: path.join(engine.J.dataRoot, 'jobs', job.id), folderLabel: 'the job folder', input, line: 'room1-digital' });

test('image_generate: a string "true" is an error back to the agent (one turn, no call); reserve 0.08 then settle to the reported cost, or estimated at 0.08 when none is reported', async (t) => {
  await png();
  const { engine, fetchImpl, addJob, keyFree } = liveEngine(t, { reply: (n) => okImage({ n, cost: n === 1 ? 0.0412 : null }), script: (ctx, params) => {
    const turn = turnOf(params);
    if (turn === 0) return { content: [tool('s', 'image_generate', { path: 'set-v1/files/a.png', prompt: 'a mug', transparent: 'true' })] };
    if (turn === 1) { assert.match(lastResults(params)[0].content, /transparent must be a JSON boolean \(true or false without quotes\), not the string "true"/); assert.equal(lastResults(params)[0].is_error, true); return { content: [tool('a', 'image_generate', { path: 'set-v1/files/a.png', prompt: 'a mug', transparent: true })] }; }
    if (turn === 2) return { content: [tool('b', 'image_generate', { path: 'set-v1/files/b.png', prompt: 'a lamp', transparent: true })] };
    return { content: [{ type: 'text', text: 'done' }] };
  } });
  const job = addJob();
  const reserved = []; const orig = engine.guard.reserve; engine.guard.reserve = (c) => { const res = orig(c); if (c.kind === 'image') reserved.push(res.maxUsd); return res; };
  const run = await designerRun(engine, job);
  assert.equal(run.status, 'done', run.endReason);
  assert.equal(run.turns, 4, 'the refused call took one turn');
  assert.equal(fetchImpl.calls.length, 2, 'the string boolean never reached the provider');
  assert.deepEqual(reserved, [0.08, 0.08], 'USD 0.08 reserved before each image');
  const rows = engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => ({ provider: x.provider, model: x.model, usd: x.usd, estimated: x.estimated, generationId: x.generationId, size: x.size, jobId: x.jobId, reservedUsd: x.reservedUsd })), [
    { provider: 'openrouter', model: MODEL, usd: 0.0412, estimated: false, generationId: 'gen-1', size: '96x96', jobId: ID, reservedUsd: 0.08 },
    { provider: 'openrouter', model: MODEL, usd: 0.08, estimated: true, generationId: 'gen-2', size: '96x96', jobId: ID, reservedUsd: 0.08 }]);
  assert.equal(rows[1].priceSource, 'reserved maximum (no cost reported)');
  assert.equal(engine.guard.reservations().length, 0);
  keyFree();
});

test('429 and 5xx retry with a new reservation each; an HTTP error is never billed', async (t) => {
  await png();
  const { engine, fetchImpl, addJob } = liveEngine(t, { reply: (n) => (n === 1 ? { status: 429, json: { error: { code: 429, message: 'slow down' } }, headers: { 'retry-after': '0' } } : n === 2 ? { status: 503, json: { error: { code: 503, message: 'busy' } } } : okImage({ n })), script: (ctx, params) => (turnOf(params) === 0 ? { content: [tool('a', 'image_generate', { path: 'set-v1/files/a.png', prompt: 'a mug', transparent: true })] } : { content: [{ type: 'text', text: 'done' }] }) });
  const reserved = []; const orig = engine.guard.reserve; engine.guard.reserve = (c) => { const res = orig(c); if (c.kind === 'image') reserved.push(res.id); return res; };
  const run = await designerRun(engine, addJob());
  assert.equal(run.status, 'done', run.endReason);
  assert.equal(fetchImpl.calls.length, 3); assert.equal(new Set(reserved).size, 3, 'every attempt reserved again');
  const rows = engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image');
  assert.equal(rows.length, 1); assert.equal(rows[0].generationId, 'gen-3');
});

test('E-STOP: no image call is made once the e-stop is on', async (t) => {
  await png();
  const { engine, fetchImpl, addJob } = liveEngine(t, { script: (ctx, params, e) => { e.halt.press({ by: 'test', reason: 'c0' }); return { content: [tool('a', 'image_generate', { path: 'set-v1/files/a.png', prompt: 'a mug', transparent: true })] }; } });
  const run = await designerRun(engine, addJob());
  assert.equal(run.status, 'stopped');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image').length, 0);
});

// ---- the style-reference set through the line

// DESIGNER and QA-DESIGN scripted for the first-file run and the rest of the set
function lineScript({ file1 = ['approved'], refuseFirst = false } = {}) {
  let qa = 0;
  return (ctx, params) => {
    if (ctx.purpose === 'image_analyze') return { content: [{ type: 'text', text: 'a cosy prop on a transparent background, no text' }] };
    const input = String(params.messages[0].content), turn = turnOf(params);
    if (ctx.agentKey === 'designer' && /RUN MODE: FIRST FILE ONLY/.test(input)) {
      const set = Number(/set-v(\d+)\/raw\/01-/.exec(input)[1]);
      if (turn === 0) return { content: [tool('g' + set, 'image_generate', { path: 'set-v' + set + '/raw/01-steaming-mug.png', prompt: 'a steaming mug, soft outline', transparent: true })] };
      if (turn === 1 && lastResults(params).some((x) => x.is_error)) return { content: [{ type: 'text', text: 'BLOCKED: the image model refused file 1.' }] };
      if (turn === 1) return { content: [tool('w' + set, 'fs_write', { path: 'set-v' + set + '/design.md', content: '# Plan\n01 steaming mug\nSelf-check: original; no trademarks; no named style; no real person.\n' })] };
      return { content: [{ type: 'text', text: 'file 1 drawn' }] };
    }
    if (ctx.agentKey === 'designer' && /RUN MODE: REST OF SET/.test(input)) {
      const m = /files (\d\d)–(\d\d) of/.exec(input), set = Number(/Write set-v(\d+):/.exec(input)[1]), ref = /STYLE REFERENCE: (\S+)/.exec(input)[1];
      if (turn === 0) return { content: range(+m[1], +m[2]).map((n, i) => tool('g' + set + '-' + n, 'image_generate', { path: 'set-v' + set + '/raw/' + pad(n) + '-prop-' + n + '.png', prompt: 'desk prop ' + n + ', soft outline', transparent: true, ...(i === 0 ? { reference_image: ref } : {}) })) };
      if (turn === 1) return { content: [tool('w' + set + m[1], 'fs_write', { path: 'set-v' + set + '/design.md', content: '# Plan\n01 owner-approved style reference\n' })] };
      return { content: [{ type: 'text', text: 'batch drawn' }] };
    }
    if (ctx.agentKey === 'qa-design' && /RUN MODE: FILE 1 CHECK/.test(input)) {
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      const v = file1[Math.min(qa++, file1.length - 1)], file = /"file": "([^"]+)"/.exec(input)[1];
      return { content: [tool('v' + qa, 'submit_verdict', { record: { stage: 'file1', listingId: ctx.jobId, file, verdict: v, checks: { originality: 'pass', usable: v === 'approved' ? 'pass' : 'fail', styleReference: 'pass' }, reasons: v === 'approved' ? [] : ['the outline is too thin for a stream overlay'] } })] };
    }
    return { content: [{ type: 'text', text: 'nothing scripted' }] };
  };
}

test('style reference: file 1 is redrawn after a QA revise before any other file; then the owner decides; every later image carries file 1', async (t) => {
  await png();
  let stopAtPrep = null;
  const { engine, fetchImpl, addJob, jobDir, keyFree } = liveEngine(t, { script: lineScript({ file1: ['revise', 'approved'] }), hooks: { onStep: ({ job, step, phase, result }) => { if (stopAtPrep && step === 'designer' && phase === 'end' && result && result.next === 'prep') stopAtPrep(job.id); } } });
  addJob(ID, BRIEF, 'designer', { ownerFile1: true });   // the owner's pause on file 1 (owner, 18/10/2026: ownerFile1)
  // phase 1: first file, QA revise, first file again, QA approved -> waiting for the owner
  let job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'queued', job.reason); assert.equal(job.data.waitingFor, 'owner-style-ref');
  assert.match(job.reason, /waiting for the owner: file 1 of set-v2 \(01-steaming-mug\.png\) passed QA DESIGN/);
  assert.equal(job.loops.file1, 1);
  assert.equal(fetchImpl.calls.length, 2, 'two images so far, both file 1');
  for (const c of fetchImpl.calls) assert.equal(typeof c.body.messages[0].content, 'string', 'file 1 is drawn from the prompt alone');
  const d = jobDir();
  for (const n of [1, 2]) assert.deepEqual(fs.readdirSync(path.join(d, 'set-v' + n, 'raw')), ['01-steaming-mug.png']);
  const q1 = JSON.parse(fs.readFileSync(path.join(d, 'qa', 'file1-pass1.json'), 'utf8')), q2 = JSON.parse(fs.readFileSync(path.join(d, 'qa', 'file1-pass2.json'), 'utf8'));
  assert.deepEqual([q1.verdict, q1.set, q2.verdict, q2.set], ['revise', 1, 'approved', 2]);
  assert.ok(fs.existsSync(path.join(d, 'set-v2', 'review', '01-steaming-mug-on-white.png')) && fs.existsSync(path.join(d, 'set-v2', 'review', '01-steaming-mug-on-dark.png')));
  assert.equal(engine.orchestrator.controlsFor(job).restart, false, 'no restart while waiting for the owner');
  // the owner approves file 1 of set-v2, then resumes
  const dec = engine.owner.styleRefDecision(ID, { set: 2, status: 'approved', date: '2026-10-17', expectedVersion: job.version });
  assert.equal(dec.resumable, true);
  job = engine.store.getJob(ID); assert.equal(job.data.waitingFor, null);
  stopAtPrep = (id) => engine.orchestrator.stopJob(id, { expectedVersion: engine.store.getJob(id).version });
  const rs = engine.orchestrator.restartJob(ID, { expectedVersion: job.version });
  await rs.run;
  job = engine.store.getJob(ID);
  assert.equal(job.state, 'stopped'); assert.equal(job.step, 'prep');
  // files 2-12: 11 images in two DESIGNER runs (maxImages 8: batches 02-07 and 08-12), each with the approved file 1
  const approved = fs.readFileSync(path.join(d, 'set-v2', 'raw', '01-steaming-mug.png'));
  const later = fetchImpl.calls.slice(2);
  assert.equal(later.length, 11);
  for (const c of later) {
    const parts = c.body.messages[0].content;
    assert.ok(Array.isArray(parts) && parts[0].text.endsWith(REFERENCE_LINE));
    assert.equal(parts[1].image_url.url, 'data:image/png;base64,' + approved.toString('base64'));
  }
  assert.deepEqual(fs.readdirSync(path.join(d, 'set-v3', 'raw')).sort(), range(2, 12).map((n) => pad(n) + '-prop-' + n + '.png'));
  const designerRuns = engine.store.runsOf({ agentKey: 'designer', limit: 20 });
  assert.equal(designerRuns.length, 4, '2 first-file runs + 2 batches');
  const rows = engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image');
  assert.equal(rows.length, 13);
  assert.equal(rows.filter((x) => x.note === 'style reference 01-steaming-mug.png').length, 11);
  assert.ok(rows.every((x) => x.generationId && x.size === '96x96' && x.usd === 0.04 && !x.estimated));
  keyFree();
});

test('the key\'s daily limit stops the job at the first image (no retry, nothing billed, key-free reason)', async (t) => {
  await png();
  const { engine, fetchImpl, addJob, keyFree } = liveEngine(t, { reply: () => ({ status: 403, json: { error: { code: 403, message: 'Key limit exceeded (daily limit) for ' + FAKE_KEY } } }), script: lineScript() });
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'blocked');
  assert.match(job.reason, /DESIGNER run refused: image provider: OpenRouter 403: refused before any provider ran: the key's own limit/);
  assert.ok(!job.reason.includes(FAKE_KEY));
  assert.equal(fetchImpl.calls.length, 1, 'a hard stop is never retried');
  assert.equal(engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image').length, 0);
  assert.equal(engine.store.runsOf({ agentKey: 'qa-design', limit: 5 }).length, 0);
  keyFree();
});

test('a content refusal of file 1 counts as a failed QA attempt; file 1 is drawn again within the loop limit', async (t) => {
  await png();
  const { engine, fetchImpl, addJob } = liveEngine(t, { reply: (n) => (n === 1 ? { status: 403, json: { error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: 'a steaming mug' } } } } : okImage({ n })), script: lineScript() });
  addJob(ID, BRIEF, 'designer', { ownerFile1: true });
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.data.waitingFor, 'owner-style-ref', job.reason);
  assert.equal(job.loops.file1, 1, 'the refused attempt counted');
  assert.equal(job.data.imageAttempts['01-steaming-mug.png'].length, 1);
  assert.equal(job.data.imageAttempts['01-steaming-mug.png'][0].why, 'MODERATION');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(engine.ledger.rowsForJob(ID).filter((x) => x.kind === 'image').length, 1, 'the refusal was not billed');
  const tl = fs.readFileSync(path.join(engine.J.dataRoot, 'jobs', ID, 'transcript.jsonl'), 'utf8');
  assert.match(tl, /IMAGE REFUSED by the image provider \(OpenRouter 403: the request was flagged by moderation \(violence\)\)\. Nothing was saved\. Failed attempt 1 of 3 for 01-steaming-mug\.png/);
});

test('file 1 loop exhausted (three QA revises) escalates to REJECTS-DESK; no later file is ever drawn', async (t) => {
  await png();
  const { engine, fetchImpl, addJob } = liveEngine(t, { script: lineScript({ file1: ['revise'] }) });
  addJob();
  const job = await engine.orchestrator.startJob(ID);
  assert.equal(job.state, 'rejected', job.reason);
  assert.equal(job.loops.file1, 3);
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(fetchImpl.calls.every((c) => typeof c.body.messages[0].content === 'string'));
  assert.match(engine.store.getJob(ID).data.escalation, /file 1 \(the style reference\) was not approved by QA DESIGN after 3 attempt/);
});

// ---- vision pricing

test('vision: tokens from the image size (the docs\' table), reserved from the dimensions, settled from the usage', async (t) => {
  const vs = visionSettings(CFG.engine, 'claude-sonnet-5-5');
  assert.deepEqual(vs, { patchPx: 28, maxLongEdgePx: 2576, maxVisualTokens: 4784 });
  for (const [w, h, want] of [[200, 200, 64], [1000, 1000, 1296], [1092, 1092, 1521], [1920, 1080, 2691], [2000, 1500, 3888], [3840, 2160, 4784], [1024, 1024, 1369], [2000, 2000, 4784]]) assert.equal(visionTokens(w, h, vs), want, w + 'x' + h);
  assert.throws(() => visionSettings(CFG.engine, 'claude-opus-5-5'), /no vision limits/);
  // through image_analyze: a stub text provider reports usage; the reservation counts 1369 visual tokens, not the base64 text
  const seen = [];
  const text = { id: 'stub', calls: 0, async create(params, { ctx = {} } = {}) {
    this.calls++; seen.push({ purpose: ctx.purpose, thinking: ctx.thinking, hasImage: JSON.stringify(params.messages).includes('"type":"image"') });
    if (ctx.purpose === 'image_analyze') return { id: 'msg_v', content: [{ type: 'text', text: 'a mug, no text' }], stop_reason: 'end_turn', usage: { input_tokens: 1400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, request_id: 'req_vision' };
    const turn = turnOf(params);
    return turn === 0 ? { id: 'm0', content: [tool('x', 'image_analyze', { path: 'set-v1/files/a.png', question: 'what is this?' })], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, request_id: 'req_0' } : { id: 'm1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, request_id: 'req_1' };
  } };
  const { engine, addJob } = liveEngine(t, { text });
  const job = addJob();
  const big = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 1 } } }).png().toBuffer();
  engine.J.put(path.join(engine.J.dataRoot, 'jobs', ID, 'set-v1', 'files', 'a.png'), big);
  const calls = []; const orig = engine.guard.reserve; engine.guard.reserve = (c) => { calls.push(c); return orig(c); };
  const run = await runAgent(engine, { agentKey: 'qa-design', job, step: 'qa-design', pass: 1, folder: path.join(engine.J.dataRoot, 'jobs', ID), folderLabel: 'x', input: 'look', line: 'room1-digital' });
  assert.equal(run.status, 'done', run.endReason);
  const v = calls[1], b64Tokens = Math.ceil(big.toString('base64').length / 3);
  assert.ok(v.inputTokens >= 1369 && v.inputTokens < 1369 + 40000, 'reserved ' + v.inputTokens);
  assert.ok(v.inputTokens < b64Tokens, 'not the base64 length (' + b64Tokens + ' tokens)');
  const row = engine.ledger.rowsForJob(ID).find((x) => x.requestId === 'req_vision');
  assert.equal(row.tokens.in, 1400);
  assert.equal(row.usd, textCost(CFG.engine.pricing.anthropic.models['claude-sonnet-5-5'], { input_tokens: 1400, output_tokens: 30 }));
  assert.deepEqual(seen.map((s) => s.thinking), ['off', 'off', 'off'], 'every call carries the agent\'s thinking setting');
});

// ---- packaging: real alpha only

test('packaging refuses a PNG without real alpha (no alpha channel, or no clear pixel)', async (t) => {
  const r = tempRoot('c0-alpha'); t.after(r.cleanup); useJail(r.J);
  const dir = path.join(r.dataRoot, 'x'); fs.mkdirSync(dir, { recursive: true });
  const opaque = path.join(dir, '01-opaque.png'), solid = path.join(dir, '02-solid.png'), good = path.join(dir, '03-good.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(opaque);
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toFile(solid);
  fs.writeFileSync(good, await mockPng({ prompt: 'good', width: 64, height: 64, transparent: true }));
  const run = (input) => processFile({ input, output: path.join(dir, 'out-' + path.basename(input)), widthPx: 200, heightPx: 200, cfg: CFG.station, upscaler: fakeEsrgan, tmpDir: dir });
  assert.match((await run(opaque)).reason, /has no alpha channel/);
  assert.match((await run(solid)).reason, /has no fully clear pixels: the background is not transparent/);
  assert.equal((await run(good)).ok, true);
});

// ---- D1: the owner floor for pngtuber-prop-pack, USD 3.50, at every check

// ---- D2 / D3: thinking off for every agent; forced tool choice per model

test('D2: thinking is off for every agent in config; sent per model (Haiku disabled, Sonnet between_tools); a model without a setting refuses before the call', async () => {
  // R0.3 (owner, 23/10/2026): thinking "default" for DEVELOPER, REVIEWER and COMPLIANCE (not hired yet); every other agent stays off
  const THINKING_ON = ['developer', 'reviewer', 'compliance'];
  for (const a of Object.values(CFG.agents)) assert.equal(a.thinking, THINKING_ON.includes(a.key) ? 'default' : 'off', a.key);
  const off = CFG.engine.thinking.off;
  for (const tier of ['cheap', 'strong']) assert.ok(off[CFG.engine.tiers[tier].model], tier + ' model has an off setting');
  assert.deepEqual(off['claude-haiku-5-5'], { type: 'disabled' }); assert.deepEqual(off['claude-sonnet-5-5'], { type: 'between_tools' });
  // between_tools needs effort high or below: every effort the page may set is
  assert.deepEqual(CFG.engine.effortLevels, ['low', 'medium', 'high']);
  const seen = [];
  const client = { messages: { create: async (body) => { seen.push(body); return { id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 }, _request_id: 'req' }; } } };
  const text = createAnthropicText({ engineCfg: CFG.engine, env: { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' }, client });
  await text.create({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }, { ctx: { thinking: 'off', effort: 'low' } });
  await text.create({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }, { ctx: { thinking: 'off', effort: 'low' } });
  await text.create({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] }, { ctx: { thinking: 'default' } });
  assert.deepEqual(seen.map((b) => b.thinking), [{ type: 'disabled' }, { type: 'between_tools' }, undefined]);
  const noMap = createAnthropicText({ engineCfg: { ...CFG.engine, thinking: { off: {} } }, env: { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' }, client });
  await assert.rejects(noMap.create({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [] }, { ctx: { thinking: 'off' } }), (e) => e.code === 'CONFIG');
  assert.equal(seen.length, 3, 'no call without a setting');
});

test('D3: forced tool choice only where the skill says it is valid (Haiku 5.5 yes, Sonnet 5.5 no, whatever the thinking)', () => {
  assert.equal(CFG.engine.tiers.cheap.model, 'claude-haiku-5-5'); assert.equal(CFG.engine.tiers.cheap.forcedToolChoice, true);
  assert.equal(CFG.engine.tiers.strong.model, 'claude-sonnet-5-5'); assert.equal(CFG.engine.tiers.strong.forcedToolChoice, false);
  assert.match(CFG.engine.$tiersComment, /a model restriction, not a thinking one/);
  assert.equal(CFG.engine.caps.perRunUsd, 2, 'per-run cap USD 2.00 (owner, 17/10/2026)');
  assert.equal(createProviders({ mode: 'mock' }).image.id, 'mock');
});
