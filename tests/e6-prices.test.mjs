// e6-prices.test.mjs — the owner's E6 prices and caps (DECISIONS.md "E6 readiness: owner decisions", 17/10/2026), priced
// by the spend guard from config/engine.json: Haiku's long-prompt tier (a prompt over 100,000 tokens, cache reads and
// writes included, pays the higher prices for the whole request), the cache prices, the web search fee, the image
// reservation settled to the cost OpenRouter reports, and the scout run's USD 0.50 cap. Nothing is called: the
// providers are the mock or a stub, and no key is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { createGuard, CapError, textCost, textMax, priceTier } from '../src/engine/guard.mjs';
import { createBus } from '../src/engine/bus.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createToolbox } from '../src/engine/tools/index.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createScoutScript } from '../fixtures/engine/scout-script.mjs';

const CONFIG = path.join(APP_ROOT, 'config');
const ENGINE = JSON.parse(fs.readFileSync(path.join(CONFIG, 'engine.json'), 'utf8'));
const { pricing: PRICING, caps: CAPS } = ENGINE;
const HAIKU = PRICING.anthropic.models['claude-haiku-5-5'], SONNET = PRICING.anthropic.models['claude-sonnet-5-5'];
const usd = (n) => Math.round(n * 1e6) / 1e6;
const NOON = Date.parse('2026-10-17T11:00:00Z');

function setup({ t = tempRoot('e6') } = {}) {
  const bus = createBus({ J: t.J, log: t.log });
  const events = []; bus.subscribe((e) => events.push(e));
  const ledger = createLedger({ J: t.J, log: t.log });
  const guard = createGuard({ J: t.J, ledger, halt: { isHalted: () => false }, caps: CAPS, pricing: PRICING, log: t.log, bus, clock: () => NOON });
  return { t, events, ledger, guard };
}
const call = (o = {}) => ({ provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', runId: 'run-1', jobId: '2026-10-17--job', agentKey: 'lister', line: 'room1-digital', inputTokens: 10000, maxOutputTokens: 8000, ...o });

test('config: the owner\'s prices, caps and image model; every real price names its source and date', () => {
  assert.deepEqual(
    { in: HAIKU.inPerM, out: HAIKU.outPerM, cr: HAIKU.cacheReadPerM, cw: HAIKU.cacheWritePerM },
    { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125 });
  assert.deepEqual(HAIKU.longPrompt, { overTokens: 100000, inPerM: 0.5, outPerM: 2.5, cacheReadPerM: 0.05, cacheWritePerM: 0.625 });
  assert.deepEqual({ in: SONNET.inPerM, out: SONNET.outPerM, cr: SONNET.cacheReadPerM, cw: SONNET.cacheWritePerM, lp: SONNET.longPrompt }, { in: 2, out: 10, cr: 0.1, cw: 2.5, lp: undefined });
  assert.equal(PRICING['anthropic-web'].models.web_search.perCall, 0.01);
  assert.equal(PRICING['anthropic-web'].models.web_fetch.perCall, 0);
  assert.equal(PRICING.openrouter.models['openai/gpt-5-image-mini'].perImage, 0.08);
  assert.deepEqual(ENGINE.image.allowedModels, ['openai/gpt-5-image-mini']);
  assert.equal(ENGINE.image.opaqueModelApproved, false);
  assert.deepEqual({ run: CAPS.perRunUsd, job: CAPS.perJobUsd, day: CAPS.perDayUsd, line: CAPS.perLineDayUsd.default, scout: CAPS.perJobUsdByLine['genre-scout'], research: CAPS.perJobUsdByLine.research }, { run: 2, job: 7, day: 10, line: 10, scout: 0.5, research: 1 });   // W4 (owner, 21/10/2026): USD 7.00 per job (W2, 20/10/2026: 6.00, was 5.00); L3.1 (owner, 21/10/2026): USD 1.00 per research job
  for (const [prov, p] of Object.entries(PRICING)) {
    if (prov === 'mock') continue;
    for (const [model, e] of Object.entries(p.models)) {
      assert.ok(e.source, prov + ' ' + model + ' names its source');
      assert.match(e.verified, /17\/10\/2026/, prov + ' ' + model + ' carries the date it was verified');
      assert.equal(e.confirmBeforeE6, undefined, prov + ' ' + model);
    }
  }
  assert.match(HAIKU.source, /^https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing$/);
});

test('Haiku without cache: up to 100,000 prompt tokens at the standard prices; over it, the long-prompt prices for the whole request', () => {
  assert.equal(priceTier(HAIKU, 100000).tier, 'standard');
  assert.equal(priceTier(HAIKU, 100001).tier, 'long-prompt');
  assert.equal(textCost(HAIKU, { input_tokens: 99999, output_tokens: 2000 }), usd((99999 * 0.1 + 2000 * 0.5) / 1e6));
  assert.equal(textCost(HAIKU, { input_tokens: 100000, output_tokens: 2000 }), usd((100000 * 0.1 + 2000 * 0.5) / 1e6));
  assert.equal(textCost(HAIKU, { input_tokens: 100001, output_tokens: 2000 }), usd((100001 * 0.5 + 2000 * 2.5) / 1e6), 'output at 2.50 too');
});

test('Haiku with cache: reads and writes count toward the 100,000 and are priced at their tier\'s cache prices', () => {
  // just under: 10,000 + 40,000 written + 49,999 read = 99,999
  assert.equal(textCost(HAIKU, { input_tokens: 10000, cache_creation_input_tokens: 40000, cache_read_input_tokens: 49999, output_tokens: 1000 }),
    usd((10000 * 0.1 + 40000 * 0.125 + 49999 * 0.01 + 1000 * 0.5) / 1e6));
  // just over: 10,000 + 40,000 + 50,001 = 100,001, although the uncached input alone is only 10,000
  assert.equal(textCost(HAIKU, { input_tokens: 10000, cache_creation_input_tokens: 40000, cache_read_input_tokens: 50001, output_tokens: 1000 }),
    usd((10000 * 0.5 + 40000 * 0.625 + 50001 * 0.05 + 1000 * 2.5) / 1e6));
  // cache reads alone can push a request over
  assert.equal(textCost(HAIKU, { input_tokens: 1, cache_read_input_tokens: 100000, output_tokens: 0 }), usd((1 * 0.5 + 100000 * 0.05) / 1e6));
  assert.equal(textCost(HAIKU, { input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 0 }), usd(100000 * 0.01 / 1e6));
  // Sonnet has no prompt-size tier in the owner's prices: its cache prices apply at any size
  assert.equal(textCost(SONNET, { input_tokens: 150000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000, output_tokens: 1000 }),
    usd((150000 * 2 + 10000 * 2.5 + 50000 * 0.1 + 1000 * 10) / 1e6));
});

test('reservation: the estimated prompt picks the tier; the dearest input price of that tier (the cache write) plus the full output', () => {
  assert.equal(textMax(HAIKU, 100000, 8000), usd((100000 * 0.125 + 8000 * 0.5) / 1e6));
  assert.equal(textMax(HAIKU, 100001, 8000), usd((100001 * 0.625 + 8000 * 2.5) / 1e6));
  assert.equal(textMax(SONNET, 200000, 8000), usd((200000 * 2.5 + 8000 * 10) / 1e6));
  const { t, guard, ledger } = setup();
  try {
    const a = guard.reserve(call({ inputTokens: 99999 }));
    assert.equal(a.maxUsd, textMax(HAIKU, 99999, 8000));
    const rowA = guard.settle(a, { usage: { input_tokens: 20000, cache_read_input_tokens: 60000, output_tokens: 500 } });
    assert.equal(rowA.priceTier, 'standard'); assert.equal(rowA.usd, usd((20000 * 0.1 + 60000 * 0.01 + 500 * 0.5) / 1e6));
    const b = guard.reserve(call({ runId: 'run-2', inputTokens: 120000 }));
    assert.equal(b.maxUsd, usd((120000 * 0.625 + 8000 * 2.5) / 1e6));
    const rowB = guard.settle(b, { usage: { input_tokens: 30000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 70000, output_tokens: 500 } });
    assert.equal(rowB.priceTier, 'long-prompt'); assert.equal(rowB.usd, usd((30000 * 0.5 + 5000 * 0.625 + 70000 * 0.05 + 500 * 2.5) / 1e6));
    assert.deepEqual(rowB.tokens, { in: 30000, out: 500, cacheRead: 70000, cacheWrite: 5000 });
    assert.equal(ledger.spent.job('2026-10-17--job'), usd(rowA.usd + rowB.usd));
  } finally { t.cleanup(); }
});

test('web: USD 0.01 reserved per search, USD 0 per fetch (their tokens are priced on the text call that carries them)', () => {
  const { t, guard } = setup();
  try {
    const s = guard.reserve(call({ provider: 'anthropic-web', model: 'web_search', kind: 'web' })); assert.equal(s.maxUsd, 0.01); guard.release(s);
    const f = guard.reserve(call({ provider: 'anthropic-web', model: 'web_fetch', kind: 'web' })); assert.equal(f.maxUsd, 0); guard.release(f);
  } finally { t.cleanup(); }
});

test('images: USD 0.08 reserved; settled to the cost OpenRouter reports, or at the reservation marked estimated when none is reported', async (t) => {
  const r = tempRoot('e6-img');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  const ledger = createLedger({ J: e.J, log: r.log });
  const guard = createGuard({ J: e.J, ledger, halt: e.halt, caps: CAPS, pricing: PRICING, log: r.log, bus: e.bus });
  const replies = [{ usd: 0.0612, priceSource: 'provider' }, { priceSource: 'none' }], seen = [];
  const image = { generate: async (p) => { seen.push({ model: p.model, reserved: guard.reservations().map((x) => x.maxUsd) }); return { files: [Buffer.from('stub image')], ...replies.shift() }; } };
  const job = { id: '2026-10-17--e6-image' }, folder = path.join(e.J.dataRoot, 'jobs', job.id); fs.mkdirSync(folder, { recursive: true });
  const box = createToolbox({ J: e.J, folder, agent: e.cfg.agents.designer, job, cfg: { ...e.cfg }, guard, providers: { mode: 'stub', image }, run: { runId: 'run_img' }, halt: e.halt, log: r.log, bus: e.bus, line: 'room1-digital' });
  await box.call('image_generate', { path: 'set-v1/files/01-can.png', prompt: 'a dented watering can, soft sage palette', transparent: true });
  await box.call('image_generate', { path: 'set-v1/files/02-jar.png', prompt: 'a jar of jam, soft sage palette', transparent: true });
  assert.deepEqual(seen, [{ model: 'openai/gpt-5-image-mini', reserved: [0.08] }, { model: 'openai/gpt-5-image-mini', reserved: [0.08] }]);
  const rows = ledger.rows();
  assert.deepEqual(rows.map((x) => [x.provider, x.model, x.usd, x.estimated, x.reservedUsd]), [['openrouter', 'openai/gpt-5-image-mini', 0.0612, false, 0.08], ['openrouter', 'openai/gpt-5-image-mini', 0.08, true, 0.08]]);
  await assert.rejects(box.call('image_generate', { path: 'set-v1/files/03-mug.png', prompt: 'a mug on a desk', transparent: false }), /opaque images need the owner's image-model decision/);
});

test('caps: a genre-scout run (one research job) stops at USD 0.50; a Room 1 job has USD 7.00 (W4, owner 21/10/2026)', () => {
  const { t, guard, ledger, events } = setup();
  try {
    ledger.append({ jobId: 'scout-job', runId: 'old', line: 'genre-scout', provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', usd: 0.48, ts: NOON });
    ledger.append({ jobId: 'room1-job', runId: 'old', line: 'room1-digital', provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', usd: 0.48, ts: NOON });
    const next = call({ inputTokens: 0, maxOutputTokens: 60000 });   // up to 0.03
    assert.throws(() => guard.reserve({ ...next, jobId: 'scout-job', line: 'genre-scout', agentKey: 'trend-scout' }), (e) => e instanceof CapError && e.cap === 'perJob[genre-scout]' && e.limit === 0.5);
    assert.ok(events.some((e) => e.type === 'cap.hit' && e.data.cap === 'perJob[genre-scout]'));
    guard.release(guard.reserve({ ...next, jobId: 'room1-job' }));
    ledger.append({ jobId: 'room1-job', runId: 'old', line: 'room1-digital', provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'text', usd: 4.5, ts: NOON });
    guard.release(guard.reserve({ ...next, jobId: 'room1-job' }));   // 4.98 + 0.03: under USD 7.00 (it was refused at 5.00)
    ledger.append({ jobId: 'room1-job', runId: 'old', line: 'room1-digital', provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'text', usd: 1, ts: NOON });
    guard.release(guard.reserve({ ...next, jobId: 'room1-job' }));   // 5.98 + 0.03: under USD 7.00 (it was refused at 6.00)
    ledger.append({ jobId: 'room1-job', runId: 'old', line: 'room1-digital', provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'text', usd: 1, ts: NOON });
    assert.throws(() => guard.reserve({ ...next, jobId: 'room1-job' }), (e) => e.cap === 'perJob' && e.limit === 7);
  } finally { t.cleanup(); }
});

test('the scout line on a priced mock never spends past USD 0.50 for the run', async (t) => {
  // a patched copy of config/ in the temp folder: the mock priced at 3x Sonnet, so the run would cost about USD 0.70 (the real config is untouched)
  const r = tempRoot('e6-scout');
  const dir = path.join(r.base, 'config'); fs.cpSync(CONFIG, dir, { recursive: true });
  const e6 = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8'));
  e6.pricing.mock.models['*'] = { inPerM: 6, outPerM: 30, perImage: 0, perCall: 0.05, source: 'test' };
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify(e6));
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript(), configDir: dir, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  const hits = []; e.bus.subscribe((x) => { if (x.type === 'cap.hit') hits.push(x.data.cap); });
  const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' });
  await e.orchestrator.startJob(c.id);
  assert.ok(e.ledger.spent.job(c.id) <= 0.5, 'spent ' + e.ledger.spent.job(c.id));
  assert.ok(e.ledger.spent.job(c.id) > 0, 'the run did spend before the cap');
  assert.ok(hits.includes('perJob[genre-scout]'), 'the scout run cap stopped it: ' + hits.join(', '));
  assert.notEqual(e.store.getJob(c.id).state, 'research-done');
});
