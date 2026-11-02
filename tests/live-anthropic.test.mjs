// live-anthropic.test.mjs — E6 step a0: the live Anthropic text provider (providers/anthropic.mjs) and the guarded call
// (runtime.mjs guardedTextCall). The SDK client is a stub: no network, and the key is a fake one. Checks: settle math
// from the usage (plain, cache read, cache write, just under and just over 100,000 prompt tokens); a refused reservation
// and the e-stop make no SDK call; the provider refuses without STATION_PROVIDER=live, in demo mode, without a key and
// for a model not in config; 401 fails fast, 429 and 5xx retry within the configured count, each attempt reserved
// again; nothing is added to the request; the key appears in no log line, error, ledger row or event.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { tempRoot } from './helpers/engine.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { createGuard, CapError, GuardRefusal } from '../src/engine/guard.mjs';
import { createBus } from '../src/engine/bus.mjs';
import { createProviders } from '../src/engine/providers/index.mjs';
import { ImageProviderError } from '../src/engine/providers/openrouter.mjs';
import { createAnthropicText, LiveProviderError, allowedModels, makeRedactor } from '../src/engine/providers/anthropic.mjs';
import { guardedTextCall, backoffDelay, RunStopped } from '../src/engine/runtime.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

const ENGINE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'engine.json'), 'utf8'));
const FAKE_KEY = 'sk-ant-api03-FAKE-test-key-0123456789abcdefghijklmnopqrstuvwxyz-NOTREAL';
const LIVE_ENV = { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', ANTHROPIC_API_KEY: FAKE_KEY };
const NOON = Date.parse('2026-10-17T11:00:00Z');
const usd = (n) => Math.round(n * 1e6) / 1e6;

// a stub of the SDK client: replies (or errors) in order; every request is recorded
function stubClient(replies = []) {
  const seen = [];
  return {
    seen,
    messages: {
      create: async (body, opts) => {
        seen.push({ body: structuredClone(body), opts: { timeout: opts && opts.timeout } });
        const r = replies.length > 1 ? replies.shift() : replies[0];
        if (r instanceof Error) throw r;
        const msg = { id: 'msg_stub' + seen.length, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...(r || {}) };
        Object.defineProperty(msg, '_request_id', { value: 'req_stub' + seen.length, enumerable: false });
        return msg;
      }
    }
  };
}
const headers = (o = {}) => new Headers({ 'request-id': 'req_err1', ...o });
const apiError = (status, type, message, h = {}) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, headers(h));

// a logger that keeps every line it is given (like makeLogger, but in memory and without the env-key redaction, so a
// leak by the provider itself would show)
function memLog() { const lines = []; const w = (level) => (msg, data) => lines.push(JSON.stringify({ level, msg, data })); return { lines, info: w('info'), warn: w('warn'), error: w('error'), read: w('read'), written: w('write') }; }

function setup({ halted = false, replies, caps = ENGINE.caps, env = LIVE_ENV } = {}) {
  const t = tempRoot('live');
  const log = memLog();
  const bus = createBus({ J: t.J, log });
  const events = []; bus.subscribe((e) => events.push(e));
  const ledger = createLedger({ J: t.J, log });
  const ctl = new AbortController();
  const halt = { isHalted: () => halted, signal: ctl.signal };
  const guard = createGuard({ J: t.J, ledger, halt, caps, pricing: ENGINE.pricing, log, bus, clock: () => NOON });
  const client = stubClient(replies);
  const providers = createProviders({ mode: 'live', engineCfg: ENGINE, env, halt, log, client });
  const sleeps = [];
  const call = (o = {}) => guardedTextCall({ guard, halt, providers, log, retry: ENGINE.live, sleep: async (ms) => { sleeps.push(ms); }, params: { model: 'claude-haiku-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], ...(o.params || {}) },
    call: { provider: 'anthropic', model: (o.params && o.params.model) || 'claude-haiku-5-5', kind: 'text', runId: 'run-live', jobId: 'job-live', agentKey: 'lister', line: 'room1-digital', inputTokens: 30, maxOutputTokens: 32, ...(o.call || {}) }, ...(o.extra || {}) });
  return { t, log, bus, events, ledger, guard, client, providers, halt, ctl, sleeps, call };
}
const ledgerText = (s) => (fs.existsSync(s.ledger.file) ? fs.readFileSync(s.ledger.file, 'utf8') : '');

test('config: the live provider allows the two tier models only, and live settings are set', () => {
  assert.deepEqual(allowedModels(ENGINE).sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.ok(ENGINE.live.timeoutMs > 0 && ENGINE.live.retries >= 0 && ENGINE.live.backoffMs > 0 && ENGINE.live.backoffMaxMs >= ENGINE.live.backoffMs);
  assert.equal(ENGINE.provider, 'mock', 'the engine default stays mock');
});

test('settle math from the response usage: plain, cache read, cache write, just under and just over 100,000 prompt tokens', async () => {
  const cases = [
    ['plain', { input_tokens: 1000, output_tokens: 500 }, (1000 * 0.1 + 500 * 0.5) / 1e6, 'standard'],
    ['cache read', { input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 10 }, (100 * 0.1 + 2000 * 0.01 + 10 * 0.5) / 1e6, 'standard'],
    ['cache write', { input_tokens: 100, cache_creation_input_tokens: 4000, output_tokens: 10 }, (100 * 0.1 + 4000 * 0.125 + 10 * 0.5) / 1e6, 'standard'],
    ['just under (100,000)', { input_tokens: 60000, cache_read_input_tokens: 40000, output_tokens: 100 }, (60000 * 0.1 + 40000 * 0.01 + 100 * 0.5) / 1e6, 'standard'],
    ['just over (100,002)', { input_tokens: 99000, cache_read_input_tokens: 1002, output_tokens: 10 }, (99000 * 0.5 + 1002 * 0.05 + 10 * 2.5) / 1e6, 'long-prompt'],
    ['just over, no cache (100,002)', { input_tokens: 100002, output_tokens: 100 }, (100002 * 0.5 + 100 * 2.5) / 1e6, 'long-prompt']
  ];
  const s = setup({ replies: cases.map(([, u]) => ({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...u } })) });
  try {
    for (const [name, u, expected, tier] of cases) {
      const { row, resp, attempts } = await s.call({ call: { runId: 'run-' + name } });
      assert.equal(attempts, 1);
      assert.equal(row.usd, usd(expected), name);
      assert.equal(row.priceTier, tier, name);
      assert.deepEqual(row.tokens, { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }, name);
      assert.equal(row.requestId, resp.request_id); assert.match(row.requestId, /^req_stub\d+$/);
      assert.equal(row.messageId, resp.id);
      assert.deepEqual([row.provider, row.model, row.kind, row.runId, row.jobId, row.agentKey, row.line, row.estimated], ['anthropic', 'claude-haiku-5-5', 'text', 'run-' + name, 'job-live', 'lister', 'room1-digital', false], name);
    }
    // Sonnet: its own prices, no prompt-size tier
    const s2 = setup({ replies: [{ usage: { input_tokens: 150000, output_tokens: 1000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 } }] });
    try { const { row } = await s2.call({ params: { model: 'claude-sonnet-5-5' }, call: { inputTokens: 210000 } }); assert.equal(row.usd, usd((150000 * 2 + 10000 * 2.5 + 50000 * 0.1 + 1000 * 10) / 1e6)); } finally { s2.t.cleanup(); }
    assert.equal(s.ledger.rows().length, cases.length, 'one ledger row per call');
    assert.equal(s.guard.reservations().length, 0, 'no reservation left open');
  } finally { s.t.cleanup(); }
});

test('a refused reservation makes no SDK call', async () => {
  const s = setup();
  try {
    await assert.rejects(s.call({ call: { runCapUsd: 0.000001 } }), (e) => e instanceof CapError && e.cap === 'perRun');
    await assert.rejects(s.call({ call: { model: 'claude-opus-5-5' }, params: { model: 'claude-opus-5-5' } }), (e) => e instanceof GuardRefusal && e.code === 'PRICE');
    assert.equal(s.client.seen.length, 0); assert.equal(s.providers.text.calls, 0);
    assert.equal(s.ledger.rows().length, 0);
  } finally { s.t.cleanup(); }
});

test('the e-stop makes no SDK call: the guard refuses, and the provider itself refuses too', async () => {
  const s = setup({ halted: true });
  try {
    await assert.rejects(s.call(), (e) => e instanceof GuardRefusal && e.code === 'HALT');
    await assert.rejects(s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [] }), (e) => e instanceof LiveProviderError && e.code === 'HALT');
    assert.equal(s.client.seen.length, 0);
    assert.equal(s.ledger.rows().length, 0);
  } finally { s.t.cleanup(); }
});

test('the live provider refuses to start without STATION_PROVIDER=live, in demo mode, or without a key; unknown modes stay locked', () => {
  const client = stubClient();
  for (const env of [{ ANTHROPIC_API_KEY: FAKE_KEY }, { STATION_PROVIDER: 'mock', ANTHROPIC_API_KEY: FAKE_KEY }, { STATION_PROVIDER: 'LIVE', ANTHROPIC_API_KEY: FAKE_KEY }]) {
    assert.throws(() => createProviders({ mode: 'live', engineCfg: ENGINE, env, client }), (e) => e.code === 'NOT_LIVE' && !e.message.includes(FAKE_KEY));
  }
  assert.throws(() => createProviders({ mode: 'live', engineCfg: ENGINE, env: LIVE_ENV, demo: true, client }), (e) => e.code === 'DEMO');
  assert.throws(() => createProviders({ mode: 'live', engineCfg: ENGINE, env: { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live' }, client }), (e) => e.code === 'NO_KEY' && /ANTHROPIC_API_KEY is not set/.test(e.message));
  assert.throws(() => createProviders({ mode: 'live', engineCfg: ENGINE, env: { STATION_PROVIDER: 'live', STATION_INSTANCE: 'live', ANTHROPIC_API_KEY: '  ' }, client }), (e) => e.code === 'NO_KEY');
  assert.throws(() => createProviders({ mode: 'openrouter', engineCfg: ENGINE, env: LIVE_ENV, client }), (e) => e.code === 'LOCKED');
  assert.equal(client.seen.length, 0);
  // the mock reads no key and is unchanged
  assert.equal(createProviders({ mode: 'mock' }).mode, 'mock');
});

test('a model not in config/engine.json is rejected before any network call', async () => {
  const s = setup();
  try {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5', '']) {
      await assert.rejects(s.providers.text.create({ model, max_tokens: 32, messages: [{ role: 'user', content: 'x' }] }), (e) => e instanceof LiveProviderError && e.code === 'MODEL');
    }
    assert.equal(s.client.seen.length, 0);
  } finally { s.t.cleanup(); }
});

test('401 fails fast with a clear, key-free message; the reservation is released and nothing is charged', async () => {
  const s = setup({ replies: [apiError(401, 'authentication_error', 'invalid x-api-key ' + FAKE_KEY)] });
  try {
    await assert.rejects(s.call(), (e) => {
      assert.ok(e instanceof LiveProviderError); assert.equal(e.status, 401); assert.equal(e.retryable, false); assert.equal(e.requestId, 'req_err1');
      assert.match(e.message, /401 authentication_error/); assert.match(e.message, /ANTHROPIC_API_KEY/);
      assert.ok(!e.message.includes(FAKE_KEY));
      return true;
    });
    assert.equal(s.client.seen.length, 1, 'no retry on 401');
    assert.deepEqual(s.sleeps, []);
    assert.equal(s.ledger.rows().length, 0); assert.equal(s.guard.reservations().length, 0);
    for (const st of [400, 403]) {
      const s2 = setup({ replies: [apiError(st, st === 400 ? 'invalid_request_error' : 'permission_error', 'nope')] });
      try { await assert.rejects(s2.call(), (e) => e.status === st && e.retryable === false); assert.equal(s2.client.seen.length, 1, st + ' is not retried'); } finally { s2.t.cleanup(); }
    }
  } finally { s.t.cleanup(); }
});

test('429 then success: retried with backoff, every attempt reserved again, one ledger row', async () => {
  const s = setup({ replies: [apiError(429, 'rate_limit_error', 'slow down'), apiError(529, 'overloaded_error', 'busy'), { usage: { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }] });
  let reserves = 0; const reserve = s.guard.reserve; s.guard.reserve = (c) => { reserves++; return reserve(c); };
  try {
    const { attempts, row, resp } = await s.call();
    assert.equal(attempts, 3); assert.equal(reserves, 3); assert.equal(s.client.seen.length, 3);
    assert.deepEqual(s.sleeps, [backoffDelay(ENGINE.live, 0), backoffDelay(ENGINE.live, 1)]);
    assert.deepEqual(s.sleeps, [ENGINE.live.backoffMs, ENGINE.live.backoffMs * 2]);
    assert.equal(resp.content[0].text, 'ready');
    assert.equal(s.ledger.rows().length, 1); assert.equal(row.usd, usd((20 * 0.1 + 2 * 0.5) / 1e6));
    assert.equal(s.guard.reservations().length, 0);
    // a server retry-after is used, within the cap
    assert.equal(backoffDelay(ENGINE.live, 0, 5000), 5000); assert.equal(backoffDelay(ENGINE.live, 0, 10 ** 9), ENGINE.live.backoffMaxMs);
  } finally { s.t.cleanup(); }
  const ra = setup({ replies: [apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }), {}] });
  try { await ra.call(); assert.deepEqual(ra.sleeps, [3000]); } finally { ra.t.cleanup(); }
});

test('smoke-live refuses to run unless its own environment says live (no engine started, nothing read)', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|OPENROUTER|OPENAI)_/.test(k) && k !== 'STATION_PROVIDER'));
  for (const extra of [{}, { STATION_PROVIDER: 'mock' }]) {
    const r = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'smoke-live.mjs')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /smoke-live refused/);
  }
});

test('the retry count is respected: retries N means N + 1 attempts at most; 0 means one; a refused re-reservation stops it', async () => {
  for (const retries of [0, 1, 2]) {
    const s = setup({ replies: [apiError(429, 'rate_limit_error', 'slow down')] });
    try {
      await assert.rejects(s.call({ extra: { retry: { ...ENGINE.live, retries } } }), (e) => e.status === 429 && e.retryable === true);
      assert.equal(s.client.seen.length, retries + 1, 'retries ' + retries);
      assert.equal(s.sleeps.length, retries);
      assert.equal(s.ledger.rows().length, 0); assert.equal(s.guard.reservations().length, 0);
    } finally { s.t.cleanup(); }
  }
  // network errors retry too (charged at the reservation, marked estimated: the request may have been processed)
  const n = setup({ replies: [new Anthropic.APIConnectionError({ message: 'socket hang up' }), {}] });
  try {
    const { attempts } = await n.call();
    assert.equal(attempts, 2);
    const rows = n.ledger.rows(); assert.equal(rows.length, 2); assert.equal(rows[0].estimated, true); assert.equal(rows[1].estimated, false);
  } finally { n.t.cleanup(); }
  // the e-stop during the wait: the next reservation is refused, no further call
  const h = setup({ replies: [apiError(503, 'api_error', 'down')] });
  let halted = false; h.halt.isHalted = () => halted;
  try {
    await assert.rejects(guardedTextCall({ guard: h.guard, halt: h.halt, providers: h.providers, retry: ENGINE.live, sleep: async () => { halted = true; }, params: { model: 'claude-haiku-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'x' }] }, call: { provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', runId: 'r', jobId: null, inputTokens: 10, maxOutputTokens: 32 } }), (e) => e.code === 'HALT');
    assert.equal(h.client.seen.length, 1);
  } finally { h.t.cleanup(); }
});

test('nothing is added to the request: no tools, no caching, no system prompt; client tools pass through; server tools are refused; effort maps', async () => {
  const s = setup({ replies: [{}] });
  try {
    await s.call();
    const b = s.client.seen[0].body;
    assert.deepEqual(Object.keys(b).sort(), ['max_tokens', 'messages', 'model']);
    assert.equal(s.client.seen[0].opts.timeout, ENGINE.live.timeoutMs);
    const tool = { name: 'fs_read', description: 'read a file', input_schema: { type: 'object', properties: {} } };
    await s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'x' }], tools: [tool] }, { ctx: { effort: 'low' } });
    assert.deepEqual(s.client.seen[1].body.tools, [tool]); assert.deepEqual(s.client.seen[1].body.output_config, { effort: 'low' });
    await s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'x' }] }, { ctx: { effort: 'max' } });
    assert.equal(s.client.seen[2].body.output_config, undefined, 'an effort not in config is not sent');
    for (const t of [{ type: 'web_search_20260209', name: 'web_search' }, { type: 'mcp_toolset', mcp_server_name: 'x' }]) {
      await assert.rejects(s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [], tools: [t] }), (e) => e.code === 'TOOLS');
    }
    await assert.rejects(s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [], mcp_servers: [{ type: 'url', url: 'x', name: 'x' }] }), (e) => e.code === 'TOOLS');
    assert.equal(s.client.seen.length, 3);
    // the web tools go only through createWithWebTool (b0, tests/live-web.test.mjs); without OPENROUTER_API_KEY images refuse without a call (c0)
    await assert.rejects(s.providers.text.create({ model: 'claude-haiku-5-5', max_tokens: 32, messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }), (e) => e.code === 'TOOLS');
    await assert.rejects(s.providers.image.generate({ model: 'openai/gpt-5-image-mini', prompt: 'x' }), (e) => e instanceof ImageProviderError && e.code === 'NO_KEY' && e.hardStop === true);
    assert.equal(s.providers.image.calls, 0);
  } finally { s.t.cleanup(); }
});

test('the key never appears in any log line, error, ledger row or event', async () => {
  const leak = apiError(500, 'api_error', 'upstream echoed headers: x-api-key: ' + FAKE_KEY + ' authorization: Bearer ' + FAKE_KEY);
  const s = setup({ replies: [leak, apiError(401, 'authentication_error', 'bad key ' + FAKE_KEY)] });
  const errors = [];
  try {
    await s.call().catch((e) => errors.push(e));
    const ok = setup({ replies: [{}] });
    try { await ok.call(); assert.ok(!ledgerText(ok).includes(FAKE_KEY)); assert.ok(!ok.log.lines.join('\n').includes(FAKE_KEY)); } finally { ok.t.cleanup(); }
    await createProviders({ mode: 'live', engineCfg: ENGINE, env: LIVE_ENV, log: s.log, client: { messages: { create: async () => { throw new Error('boom ' + FAKE_KEY); } } } }).text.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [] }).catch((e) => errors.push(e));
    await createProviders({ mode: 'live', engineCfg: ENGINE, env: LIVE_ENV, log: s.log, client: { messages: { create: async () => { throw new Anthropic.APIConnectionError({ message: 'fetch failed for key ' + FAKE_KEY }); } } } }).text.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [] }).catch((e) => errors.push(e));
    assert.equal(errors.length, 3);
    const everything = [s.log.lines.join('\n'), ledgerText(s), JSON.stringify(s.events), ...errors.map((e) => e.message + ' ' + String(e.stack) + ' ' + JSON.stringify(e))].join('\n');
    assert.ok(everything.length > 100);
    assert.ok(!everything.includes(FAKE_KEY), 'the fake key leaked');
    assert.ok(!/sk-ant-[A-Za-z0-9]/.test(everything), 'something shaped like a key leaked');
    assert.ok(!JSON.stringify(s.providers).includes(FAKE_KEY) && !Object.values(s.providers.text).some((v) => v === FAKE_KEY), 'the provider object does not expose the key');
    // the redactor on its own
    const r = makeRedactor([FAKE_KEY]);
    assert.equal(r('a ' + FAKE_KEY + ' b'), 'a <redacted> b');
    assert.equal(r('x-api-key: abc123secret'), 'x-api-key: <redacted>');
    assert.equal(r('"authorization":"Bearer abc.def"'), '"authorization":"<redacted>"');
  } finally { s.t.cleanup(); }
});

test('an abort mid-call (the e-stop) is charged at the reservation and stops the run, as on the mock', async () => {
  const s = setup();
  s.client.messages.create = (body, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Anthropic.APIUserAbortError()), { once: true }));
  try {
    const p = guardedTextCall({ guard: s.guard, halt: s.halt, providers: s.providers, retry: ENGINE.live, params: { model: 'claude-haiku-5-5', max_tokens: 32, messages: [{ role: 'user', content: 'x' }] }, call: { provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', runId: 'r', jobId: null, inputTokens: 10, maxOutputTokens: 32 } });
    setTimeout(() => s.ctl.abort(new Error('e-stop')), 5);
    await assert.rejects(p, (e) => e instanceof RunStopped && e.message === 'e-stop');
    const rows = s.ledger.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].estimated, true); assert.equal(rows[0].usd, rows[0].reservedUsd);
  } finally { s.t.cleanup(); }
});

test('the provider module builds the real SDK client without a network call and reads the key only from the env it is given', () => {
  const p = createAnthropicText({ engineCfg: ENGINE, env: LIVE_ENV });
  assert.deepEqual(p.models.sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(p.calls, 0);
  assert.ok(!JSON.stringify(p).includes(FAKE_KEY));
});
