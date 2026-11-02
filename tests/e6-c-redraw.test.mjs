// e6-c-redraw.test.mjs — the owner decisions of 18/10/2026 (DECISIONS.md "E6 step c: redraw-only mode, cleanup pass, mock guard"):
//   1 the mock provider never runs an agent on a job with live spend (every run mode that runs one, a restart, any other start)
//   3 the strict deterministic clean-up ($0) and the redraw-only mode: a new set from the earlier set's passing files, the approved
//     file 1, the station's cleaned files and DESIGNER's redraw of the named files only, with file 1 as the reference
//   4 the redraw is the next design loop: a QA DESIGN revise after it goes to the Rejects Desk; no loop is added
// Live-shaped providers are stubs (a mock text script, a fake OpenRouter fetch, a fake upscaler): no network, no key, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createMockText, mockPng } from '../src/engine/providers/mock.mjs';
import { createOpenRouterImage } from '../src/engine/providers/openrouter.mjs';
import { recordDecision } from '../src/engine/lib/style-ref.mjs';
import { strictCleanData, strictCleanFile, STRICT_DEFAULTS } from '../src/engine/lib/strict-cleanup.mjs';
import { useJail } from '../src/engine/store/active.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const CFG = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const FAKE_KEY = 'sk-or-v1-redrawTESTKEY0123456789abcdef0123456789abcd', LIVE = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', OPENROUTER_API_KEY: FAKE_KEY }, MODEL = 'openai/gpt-5-image-mini';
const ID = '2026-10-17--cozy-autumn-desk-props';
const OWNER = fs.readFileSync(path.join(APP_ROOT, 'fixtures', 'engine', 'owner-brief.md'), 'utf8').replace(/\r\n/g, '\n');
const NAMES = ['01-small-pumpkin', '02-book-stack', '03-cider-mug', '04-beeswax-candle', '05-maple-leaf-scatter', '06-knitted-throw', '07-brass-lantern', '08-cinnamon-jar', '09-acorn-pinecone', '10-teapot', '11-ghost-plush', '12-desk-lamp'].map((n) => n + '.png');
const pad = (n) => String(n).padStart(2, '0');
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
const fakeEsrgan = async (input, w, h) => ({ data: await sharp(input).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer(), facts: { method: 'realesrgan', model: 'test-double' }, warnings: [] });

// ---- 3: the strict clean-up, on pixels

// a W x H RGBA canvas; rect(x, y, w, h, [r, g, b, a])
function canvas(W, H) {
  const d = new Uint8Array(W * H * 4);
  const rect = (x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const i = (yy * W + xx) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3]; } };
  return { d, rect, alphaAt: (x, y) => d[(y * W + x) * 4 + 3] };
}

test('strict clean-up: disconnected faint, small and pale regions go; the drawing, its attached glow and a second real part stay', () => {
  const W = 200, H = 200, c = canvas(W, H);
  c.rect(20, 20, 60, 60, [200, 110, 50, 255]);       // the main part: 3,600 solid px
  c.rect(80, 30, 6, 40, [250, 220, 150, 60]);        // a faint glow ATTACHED to it: part of the drawing, kept
  c.rect(120, 120, 30, 30, [120, 80, 40, 255]);      // a second real part (an acorn beside the pinecone): 900 solid px, kept
  c.rect(20, 150, 40, 10, [240, 230, 200, 40]);      // a faint disconnected fragment (glow piece, smudge): removed "faint"
  c.rect(170, 20, 7, 7, [90, 60, 40, 255]);          // a solid speck of 49 px: removed "small"
  c.rect(100, 170, 20, 10, [250, 250, 248, 230]);    // a pale near-white smudge, 200 solid px (< 10% of the main part): removed "pale"
  c.rect(190, 190, 3, 3, [10, 10, 10, 5]);           // alpha under the floor: cleared first
  const r = strictCleanData(c.d, W, H);
  assert.equal(r.flooredPx, 9);
  assert.deepEqual(r.removed.map((x) => [x.why, x.px]).sort(), [['faint', 400], ['pale', 200], ['small', 49]]);
  assert.equal(r.removedPx, 649); assert.equal(r.partsKept, 2); assert.equal(r.mainSolidPx, 3600);
  for (const [x, y] of [[30, 155], [173, 23], [110, 175], [191, 191]]) assert.equal(c.alphaAt(x, y), 0, 'removed at ' + x + ',' + y);
  for (const [x, y] of [[50, 50], [82, 40], [135, 135]]) assert.ok(c.alphaAt(x, y) > 0, 'kept at ' + x + ',' + y);
  assert.deepEqual(r.opts, STRICT_DEFAULTS);
  // a clean drawing is left as it is
  const k = canvas(50, 50); k.rect(10, 10, 30, 30, [1, 2, 3, 255]);
  assert.deepEqual([strictCleanData(k.d, 50, 50).removedPx, strictCleanData(k.d, 50, 50).flooredPx], [0, 0]);
});

test('strict clean-up of a file: the record names what was removed; the same input again writes nothing', async (t) => {
  const r = tempRoot('strict'); t.after(r.cleanup); useJail(r.J);
  const c = canvas(120, 120); c.rect(20, 20, 60, 60, [200, 110, 50, 255]); c.rect(90, 100, 25, 10, [240, 230, 200, 40]);
  const input = path.join(r.dataRoot, 'in.png'), output = path.join(r.dataRoot, 'out.png');
  fs.writeFileSync(input, await sharp(Buffer.from(c.d), { raw: { width: 120, height: 120, channels: 4 } }).png().toBuffer());
  const a = await strictCleanFile({ input, output });
  assert.deepEqual([a.action, a.removedPx, a.regionsRemoved, a.removed[0].why], ['written', 250, 1, 'faint']);
  assert.notEqual(a.input.sha256, a.output.sha256);
  assert.equal((await strictCleanFile({ input, output })).action, 'unchanged');
});

// ---- 1: the mock guard

test('decision 1: the mock never runs an agent on a job with live spend: run modes and restart refused, any other start stopped; package and mock-only jobs unaffected', async (t) => {
  const r = tempRoot('guard'); t.after(r.cleanup);
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan });
  t.after(() => e.close());
  assert.equal(e.providers.mode, 'mock');
  const add = (id, provider, state = 'stopped') => {
    e.store.insertJob({ id, line: 'room1-digital', kind: 'line', title: id, product_key: 'pngtuber-prop-pack', state, step: 'designer', data: { createdBy: 'test' } });
    r.J.put(path.join(r.dataRoot, 'jobs', id, 'brief.md'), OWNER.replace(/^id: .*$/m, 'id: ' + id));
    e.ledger.append({ jobId: id, kind: 'text', provider, model: 'claude-sonnet-5-5', usd: 0.01, agentKey: 'designer' });
  };
  add('2026-10-18--live-job', 'anthropic'); add('2026-10-18--mock-job', 'mock');
  const v = (id) => e.store.getJob(id).version, L = '2026-10-18--live-job', M = '2026-10-18--mock-job';
  const refused = (fn, what) => assert.throws(fn, (x) => x.code === 'MOCK_ON_LIVE' && new RegExp('^' + what + ' refused: job ' + L + ' has live spend and this engine runs the mock provider').test(x.message), what);
  refused(() => e.orchestrator.qaOnly(L, { set: 1, maxUsd: 0.5, expectedVersion: v(L) }), 'a QA-only run');
  refused(() => e.orchestrator.listingOnly(L, { maxUsd: 0.5, expectedVersion: v(L) }), 'a listing-only run');
  refused(() => e.orchestrator.redrawOnly(L, { expectedVersion: v(L) }), 'a redraw-only run');
  refused(() => e.orchestrator.restartJob(L, { expectedVersion: v(L) }), 'a restart');
  // the package step runs no agent: not refused by the guard (the package gate then blocks it for its own reason: no approved set)
  const pk = e.orchestrator.packageJob(L, { expectedVersion: v(L) }); await pk.run;
  assert.equal(e.store.getJob(L).state, 'blocked'); assert.doesNotMatch(e.store.getJob(L).reason, /mock provider/);
  // a mock-only job meets the run modes' own checks, never the guard
  assert.throws(() => e.orchestrator.qaOnly(M, { set: 1, maxUsd: 0.5, expectedVersion: v(M) }), (x) => x.code !== 'MOCK_ON_LIVE' && /set-v1 does not exist/.test(x.message));
  // any other start (a server resume, a routine): stopped before its first agent step, nothing called
  e.store.updateJob(L, { state: 'queued', step: 'designer' });
  const rows = e.ledger.rowsForJob(L).length, j = await e.orchestrator.startJob(L);
  assert.equal(j.state, 'stopped'); assert.match(j.reason, /^stopped before designer: the job has live spend and this engine runs the mock provider/);
  assert.equal(e.ledger.rowsForJob(L).length, rows, 'no call made');
  // the owner script's own mode list routes qa-only through the same guard
  assert.match(fs.readFileSync(path.join(APP_ROOT, 'scripts', 'owner.mjs'), 'utf8'), /'qa-only': 'qaOnly'/);
});

// ---- 3 and 4: redraw-only on the live line (stubs)

function fakeFetch(png) {
  const calls = [];
  const f = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 'gen-' + calls.length, model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] } }], usage: { cost: 0.04 } }) }; };
  f.calls = calls; return f;
}
// a 96x96 prop with a faint disconnected fragment below it (what the strict clean-up removes)
async function propWithFragment(prompt) {
  const { data, info } = await sharp(await mockPng({ prompt, width: 96, height: 96, transparent: true })).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 90; y < 94; y++) for (let x = 10; x < 40; x++) { const i = (y * 96 + x) * 4; if (data[i + 3] === 0) { data[i] = 240; data[i + 1] = 230; data[i + 2] = 200; data[i + 3] = 40; } }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function redrawEngine(t, script) {
  const r = tempRoot('redraw'), png = await mockPng({ prompt: 'redrawn prop', width: 96, height: 96, transparent: true }), fetchImpl = fakeFetch(png);
  let engine = null;
  const image = createOpenRouterImage({ engineCfg: CFG.engine, env: LIVE, log: r.log, fetchImpl });
  const providers = { mode: 'live', text: createMockText({ script: (ctx, params) => script(ctx, params, engine) }), image, web: Object.assign(async () => ({ text: '', usd: 0 }), { plan: () => ({ maxUses: 1, extraUsd: 0 }), settings: {} }) };
  engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, providers, configDir: CONFIG, promptsDir: PROMPTS, startScheduler: false, upscaler: fakeEsrgan });
  engine.sleep = async () => {};
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  // the job as the live run left it: file 1 approved (set-v1), the full set-v2 built, QA DESIGN pass 1 revise, stopped at designer (loop 1 used)
  const d = path.join(r.dataRoot, 'jobs', ID), put = (rel, buf) => r.J.put(path.join(d, rel), buf);
  engine.store.insertJob({ id: ID, line: 'room1-digital', kind: 'line', title: 'cozy autumn', product_key: 'pngtuber-prop-pack', state: 'stopped', step: 'designer', data: { createdBy: 'test' } });
  engine.store.updateJob(ID, { loops: { design: 1 }, data: { qaPasses: { design: 1 } } });
  put('brief.md', OWNER);
  const p1 = await mockPng({ prompt: 'pumpkin', width: 96, height: 96, transparent: true });
  put('set-v1/raw/01-small-pumpkin.png', p1); put('set-v1/design.md', '# Plan\n01 small pumpkin\n');
  useJail(r.J); assert.equal(recordDecision({ roomDir: r.dataRoot, id: ID, status: 'approved', date: '2026-10-18', n: 1 }).ok, true);
  for (const [i, n] of NAMES.entries()) {
    const buf = i === 0 ? p1 : [1, 3, 8].includes(i) ? await propWithFragment(n) : await mockPng({ prompt: n, width: 96, height: 96, transparent: true });
    put('set-v2/raw/' + n, buf); put('set-v2/build/' + n, buf);
  }
  // DESIGNER's set-v2 notes carry the stale spec note of set-v1 (the bug of 18/10/2026): the redraw must not carry it into the new set
  put('set-v2/design.md', '# Design plan, set-v2\n\nNotes:\n- Spec mismatch (flagged in set-v1): products.json files 11-12 are "colour variant of props 1-10".\n\n## Prompts\n' + NAMES.map((n) => '### ' + n.replace('.png', '') + '\nPrompt for ' + n.replace('.png', '') + ', soft outline.').join('\n\n') + '\n\n## Originality self-check\n- original; no trademarks; no named style; no real person.\n');
  put('qa/design-pass1.json', JSON.stringify({ stage: 'design', listingId: ID, pass: 1, verdict: 'revise', checks: {}, reasons: ['usable 08-cinnamon-jar: opaque grey-white body'] }) + '\n');
  engine.ledger.append({ jobId: ID, kind: 'text', provider: 'anthropic', model: 'claude-sonnet-5-5', usd: 2.0, agentKey: 'designer' });
  return { engine, r, d, fetchImpl, png };
}
const PLAN = { from: 2, clean: [2, 4, 9], redraw: [{ file: 7, finding: 'usable 07-brass-lantern: a speckled glyph-like mark in the flame; regenerate it' }, { file: 8, finding: 'usable 08-cinnamon-jar: opaque grey-white body; clearly cream ceramic or clear glass' }, { file: 10, finding: 'usable 10-teapot: a soft grey-beige ground shadow under the base; remove it' }] };

test('decision 3: prepare-redraw at $0: file 1, set-v2\'s passing files byte for byte, the cleaned files with before/after review images; idempotent; a new plan moves the old set aside', async (t) => {
  const { engine, d, fetchImpl } = await redrawEngine(t, () => ({ content: [{ type: 'text', text: 'nothing scripted' }] }));
  const O = engine.orchestrator, v = () => engine.store.getJob(ID).version;
  // refused plans
  await assert.rejects(O.prepareRedraw(ID, { ...PLAN, clean: [2, 7], expectedVersion: v() }), /file 07 is named twice/);
  await assert.rejects(O.prepareRedraw(ID, { ...PLAN, clean: [1], expectedVersion: v() }), /file 1 is not one of 02–12/);
  await assert.rejects(O.prepareRedraw(ID, { ...PLAN, redraw: [{ file: 7, finding: '' }], expectedVersion: v() }), /file 07 needs QA DESIGN's finding/);
  // under the e-stop too: station code, no model
  engine.halt.press({ by: 'test', reason: 'e-stop on' }); assert.equal(engine.halt.isHalted(), true);
  const p = await O.prepareRedraw(ID, { ...PLAN, expectedVersion: v() });
  assert.equal(p.action, 'prepared'); assert.equal(p.set, 3);
  const raw = fs.readdirSync(path.join(d, 'set-v3', 'raw')).sort();
  assert.deepEqual(raw, NAMES.filter((n) => !/^(07|08|10)-/.test(n)));
  for (const n of ['03-cider-mug.png', '05-maple-leaf-scatter.png', '11-ghost-plush.png', '12-desk-lamp.png']) assert.ok(fs.readFileSync(path.join(d, 'set-v3', 'raw', n)).equals(fs.readFileSync(path.join(d, 'set-v2', 'raw', n))), n + ' reused byte for byte');
  assert.ok(fs.readFileSync(path.join(d, 'set-v3', 'raw', '01-small-pumpkin.png')).equals(fs.readFileSync(path.join(d, 'set-v1', 'raw', '01-small-pumpkin.png'))), 'file 1 is the approved one');
  const cu = JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'cleanup.json'), 'utf8'));
  assert.deepEqual(cu.files.map((f) => f.name), ['02-book-stack.png', '04-beeswax-candle.png', '09-acorn-pinecone.png']);
  for (const f of cu.files) {
    assert.ok(f.removedPx >= 120 && f.removed.some((x) => x.why === 'faint'), f.name + ': the faint fragment removed (' + f.removedPx + ' px)');
    for (const k of ['before', 'after']) for (const bg of ['white', 'dark']) assert.ok(fs.existsSync(path.join(engine.J.dataRoot, f.review[k][bg].file)), f.name + ' ' + k + ' on ' + bg);
  }
  const plan = JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'redraw.json'), 'utf8'));
  assert.equal(plan.status, 'prepared'); assert.deepEqual(plan.plan.redraw.map((r) => [r.n, r.was]), [[7, '07-brass-lantern.png'], [8, '08-cinnamon-jar.png'], [10, '10-teapot.png']]);
  assert.equal(plan.plan.redraw[1].item, 'A jar of cinnamon sticks.');
  // design.md from the current spec and brief: the station plan and the kept files' prompts, never set-v2's notes
  const md = fs.readFileSync(path.join(d, 'set-v3', 'design.md'), 'utf8');
  assert.doesNotMatch(md, /colour variant|Spec mismatch/);
  assert.match(md, /^## Station plan \(written by the station from the current products\.json and brief\.md/m); assert.match(md, /^- 08: A jar of cinnamon sticks\. \(png 2000x2000\)$/m);
  assert.match(md, /### 03-cider-mug\nPrompt for 03-cider-mug, soft outline\./); assert.match(md, /### 02-book-stack\nPrompt for 02-book-stack/, 'a cleaned file keeps its prompt');
  assert.doesNotMatch(md, /### 07-brass-lantern/, 'a file to redraw has no carried prompt');
  assert.equal(fetchImpl.calls.length, 0); assert.equal(engine.ledger.rowsForJob(ID).length, 1, 'no paid call');
  // the same plan again: unchanged; another plan (09 moved to the redraw list): the prepared set moves aside, set-v3 again
  assert.equal((await O.prepareRedraw(ID, { ...PLAN, expectedVersion: v() })).action, 'unchanged');
  const p2 = await O.prepareRedraw(ID, { from: 2, clean: [2, 4], redraw: [...PLAN.redraw, { file: 9, finding: 'usable 09-acorn-pinecone: a pale smudge below the bottom edge' }], expectedVersion: v() });
  assert.equal(p2.set, 3); assert.ok(!fs.existsSync(path.join(d, 'set-v3', 'raw', '09-acorn-pinecone.png')));
  assert.equal(fs.readdirSync(d).filter((f) => /^redraw-replaced-/.test(f)).length, 1, 'the earlier prepared set kept, moved aside');
});

test('decisions 3-4: redraw-only draws the named files only (file 1 as reference), then prep and one QA DESIGN pass as design loop 2; a revise goes to the Rejects Desk', async (t) => {
  const seen = { designer: '', qa: '' };
  const { engine, d, fetchImpl } = await redrawEngine(t, (ctx, params) => {
    if (ctx.purpose === 'image_analyze') return { content: [{ type: 'text', text: 'a cosy prop, transparent, no text' }] };
    const input = String(params.messages[0].content), turn = turnOf(params);
    if (ctx.agentKey === 'designer' && /RUN MODE: REDRAW ONLY/.test(input)) {
      seen.designer = input;
      if (turn === 0) return { content: [7, 8, 10, 9].map((n) => tool('g' + n, 'image_generate', { path: 'set-v3/raw/' + pad(n) + '-' + { 7: 'brass-lantern', 8: 'cinnamon-jar', 10: 'teapot', 9: 'acorn-pinecone' }[n] + '.png', prompt: 'prop ' + n + ', soft outline', transparent: true })) };
      if (turn === 1) { const res = lastResults(params); assert.match(res[3].content, /\[RUN MODE: REDRAW ONLY\] draw files 07, 08, 10 only/); return { content: [tool('w', 'fs_write', { path: 'set-v3/design.md', content: '# Plan\n' + NAMES.map((n) => n.replace('.png', '')).join('\n') + '\nSelf-check: original; no trademarks; no named style; no real person.\n' })] }; }
      return { content: [{ type: 'text', text: 'files 07, 08 and 10 redrawn' }] };
    }
    if (ctx.agentKey === 'qa-design') {
      seen.qa = input;
      if (turn > 0) return { content: [{ type: 'text', text: 'verdict recorded' }] };
      return { content: [tool('v', 'submit_verdict', { record: { stage: 'design', listingId: ID, verdict: 'revise', designFile: 'jobs/' + ID + '/set-v3/deliverables.json', checks: { originality: 'pass', trademarks: 'pass', etsyPolicy: 'pass', briefFit: 'pass', complete: 'pass', usable: 'fail', matchesSpec: 'pass', worthThePrice: 'fail', licence: 'pass' }, worthThePrice: { verdict: 'fail', reason: 'one file still rough' }, reasons: ['usable 07-brass-lantern: still a mark in the flame'] } })] };
    }
    if (ctx.agentKey === 'rejects-desk') return { content: [{ type: 'text', text: 'recorded' }] };
    return { content: [{ type: 'text', text: 'nothing scripted' }] };
  });
  const O = engine.orchestrator, v = () => engine.store.getJob(ID).version;
  await O.prepareRedraw(ID, { ...PLAN, expectedVersion: v() });
  const r = O.redrawOnly(ID, { expectedVersion: v() });
  assert.deepEqual([r.set, r.files, r.designLoop], [3, [7, 8, 10], 2]);
  const job = await r.run;
  // DESIGNER: told the files, their brief items and QA's findings; 3 images, each with file 1; file 09 (cleaned, in the range, not named) refused, no call
  assert.match(seen.designer, /files 07, 08, 10 of 12\] STYLE REFERENCE: work\/2026-10-17--cozy-autumn-desk-props\/set-v1\/raw\/01-small-pumpkin\.png/);
  assert.match(seen.designer, /- 08 \(was 08-cinnamon-jar\.png\): the brief's item: "A jar of cinnamon sticks\."\. QA DESIGN's finding to fix: usable 08-cinnamon-jar: opaque grey-white body/);
  assert.match(seen.designer, /STATION PLAN for design\.md \(from the CURRENT products\.json and brief\.md\)/);
  // DESIGNER wrote design.md without the plan: prep put the station plan back before the set was screened
  assert.match(fs.readFileSync(path.join(d, 'set-v3', 'design.md'), 'utf8'), /^## Station plan \(written by the station/m);
  assert.equal(fetchImpl.calls.length, 3);
  for (const c of fetchImpl.calls) assert.equal(c.body.messages[0].content[1].type, 'image_url', 'file 1 sent as the reference');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'set-v3', 'redraw.json'), 'utf8')).status, 'drawn');
  // prep built the whole set (the brief-match check passes); QA DESIGN was told what is reused, cleaned and redrawn
  assert.ok(fs.existsSync(path.join(d, 'set-v3', 'deliverables.json')));
  assert.match(seen.qa, /\[STATION — redraw-only set-v3, design loop 2\] 01 is the owner-approved style reference\. Reused unchanged \(byte for byte\) from set-v2: 03-cider-mug\.png, 05-maple-leaf-scatter\.png, 06-knitted-throw\.png, 11-ghost-plush\.png, 12-desk-lamp\.png\. Cleaned by the station .*: 02-book-stack\.png, 04-beeswax-candle\.png, 09-acorn-pinecone\.png\. Redrawn by DESIGNER for your earlier findings: 07 \(was 07-brass-lantern\.png\), 08 \(was 08-cinnamon-jar\.png\), 10 \(was 10-teapot\.png\)/);
  // the revise is past the loop limit: the Rejects Desk, no third design pass
  assert.equal(job.state, 'rejected', job.reason); assert.equal(job.loops.design, 2);
  assert.ok(fs.existsSync(path.join(d, 'qa', 'design-pass2.json')));
  assert.equal(fs.readdirSync(d).filter((f) => /^set-v\d+$/.test(f)).length, 3, 'no new set drawn after the revise');
  assert.throws(() => O.redrawOnly(ID, { expectedVersion: v() }), /not a prepared redraw set|no design loop left/);
});
