// engine-server.test.mjs — the engine-mode server on a temp data root and the mock provider: write actions need the
// page's own origin, the per-launch action token and JSON; the token goes to same-origin requests only; the event
// stream replays what a reconnecting page missed; nothing the page receives carries a prompt, key or token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';

async function boot(t) {
  const r = tempRoot('server');
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  const { server, closeAll, token } = createEngineServer({ engine, log: r.log });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port, host = '127.0.0.1:' + port;
  t.after(async () => { closeAll(); await new Promise((res) => server.close(res)); engine.close(); r.cleanup(); });
  const req = (method, p, { headers = {}, body = null } = {}) => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: method === 'POST' && !('x-idempotency-key' in headers) ? { 'x-idempotency-key': crypto.randomUUID(), ...headers } : headers }, (s) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) {} res({ status: s.statusCode, text, json }); }); });
    q.on('error', rej); if (body != null) q.write(body); q.end();
  });
  return { engine, token, host, port, req, origin: 'http://' + host };
}

test('POST actions need the same origin, the action token and JSON', async (t) => {
  const { engine, token, req, origin } = await boot(t);
  const body = JSON.stringify({ reason: 'test' });
  const json = { 'content-type': 'application/json' };
  assert.equal((await req('POST', '/api/engine/halt', { headers: { ...json, 'x-station-action': token }, body })).status, 403, 'no Origin');
  assert.equal((await req('POST', '/api/engine/halt', { headers: { ...json, origin: 'http://evil.example', 'x-station-action': token }, body })).status, 403, 'other origin');
  assert.equal((await req('POST', '/api/engine/halt', { headers: { ...json, origin, 'x-station-action': 'stale' }, body })).status, 403, 'bad token');
  assert.equal((await req('POST', '/api/engine/halt', { headers: { ...json, origin }, body })).status, 403, 'no token');
  assert.equal((await req('POST', '/api/engine/halt', { headers: { 'content-type': 'text/plain', origin, 'x-station-action': token }, body })).status, 415, 'not JSON');
  assert.equal((await req('POST', '/api/engine/nope', { headers: { ...json, origin, 'x-station-action': token }, body })).status, 404);
  assert.equal(engine.halt.isHalted(), false, 'nothing refused above changed the engine');
  const ok = await req('POST', '/api/engine/halt', { headers: { ...json, origin, 'x-station-action': token }, body });
  assert.equal(ok.status, 200); assert.equal(engine.halt.isHalted(), true);
  const wrong = await req('POST', '/api/engine/resume', { headers: { ...json, origin, 'x-station-action': token }, body: JSON.stringify({ confirm: 'yes', expectedVersion: engine.halt.state.at }) });
  assert.equal(wrong.status, 400); assert.equal(engine.halt.isHalted(), true);
  const resumed = await req('POST', '/api/engine/resume', { headers: { ...json, origin, 'x-station-action': token }, body: JSON.stringify({ confirm: 'RESUME', expectedVersion: engine.halt.state.at }) });
  assert.equal(resumed.status, 200); assert.equal(engine.halt.isHalted(), false);
  assert.equal((await req('PUT', '/api/engine/halt', { headers: { ...json, origin, 'x-station-action': token }, body })).status, 405);
});

test('the action token goes to same-origin requests only, and the snapshot carries no token, key or prompt', async (t) => {
  const { token, req } = await boot(t);
  assert.equal((await req('GET', '/api/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const s = await req('GET', '/api/session', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(s.status, 200); assert.equal(s.json.actionToken, token); assert.equal(s.json.resumeWord, 'RESUME');
  const snap = await req('GET', '/api/office/snapshot?fresh');
  assert.equal(snap.status, 200);
  assert.equal(snap.json.engine.state !== undefined, true);
  assert.ok(!snap.text.includes(token), 'no action token in the snapshot');
  assert.doesNotMatch(snap.text, /STANDING ORDERS|sk-ant-|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/);
  const health = await req('GET', '/api/office/health');
  assert.equal(health.json.provider, 'mock');
});

test('the event stream replays what a reconnecting page missed (Last-Event-ID)', async (t) => {
  const { engine, port } = await boot(t);
  engine.halt.press({ by: 'test', reason: 'replay' });
  engine.halt.resume({ by: 'test', confirm: 'RESUME' });
  const all = engine.bus.since(0); assert.ok(all.length >= 3);
  const from = all[0].seq;
  const text = await new Promise((res, rej) => {
    let buf = '';
    const q = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { 'last-event-id': String(from) } }, (s) => {
      assert.equal(s.headers['content-type'], 'text/event-stream; charset=utf-8');
      s.on('data', (c) => { buf += c; if ((buf.match(/^id: /gm) || []).length >= all.length - 1) { q.destroy(); res(buf); } });
    });
    q.on('error', (e) => (buf ? res(buf) : rej(e)));
    setTimeout(() => { q.destroy(); res(buf); }, 3000);
    q.end();
  });
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, all.filter((e) => e.seq > from).map((e) => e.seq));
  assert.match(text, /event: halt\.on/); assert.match(text, /event: halt\.off/);
});

test('every event type the engine emits is one the page listens for', async () => {
  const fs = await import('node:fs');
  const { EVENT_TYPES } = await import('../src/engine/bus.mjs');
  const page = fs.readFileSync(new URL('../src/web/main.js', import.meta.url), 'utf8');
  const listened = JSON.parse('[' + /for \(const t of \[([^\]]+)\]\) live\.addEventListener/.exec(page)[1].replace(/'/g, '"') + ']');
  const quiet = new Set(['engine.start']);   // the page reloads its snapshot on connect instead
  for (const t of EVENT_TYPES) if (!quiet.has(t)) assert.ok(listened.includes(t), 'page does not listen for ' + t);
});
