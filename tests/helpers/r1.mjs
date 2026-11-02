// helpers/r1.mjs — R1 test helpers: a copy of config/ (and prompts/) in a temp folder with edits, an engine on a throwaway data root, and
// the page's HTTP writes (same origin, the per-launch token, JSON, an idempotency key). The real config is never touched. Mock only, $0.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { tempRoot } from './engine.mjs';
import { createEngine } from '../../src/engine/engine.mjs';
import { createEngineServer } from '../../src/server/engine-server.mjs';
import { APP_ROOT } from '../../src/engine/store/jail.mjs';

export const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// a copy of config/ under base with edits: { 'autonomy.json': (o) => …, 'agents/ceo.json': (o) => … } (each edits the parsed JSON in place)
export function configCopy(base, edits = {}) {
  const dir = path.join(base, 'config-' + crypto.randomBytes(3).toString('hex'));
  fs.cpSync(CONFIG, dir, { recursive: true });
  for (const [rel, fn] of Object.entries(edits)) { const f = path.join(dir, rel); const o = fs.existsSync(f) ? readJson(f) : {}; const out = fn(o); fs.writeFileSync(f, JSON.stringify(out === undefined ? o : out, null, 2)); }
  return dir;
}
// a copy of prompts/ with a minimal prompt for each agent hired in a test config
export function promptsCopy(base, keys = []) {
  const dir = path.join(base, 'prompts-' + crypto.randomBytes(3).toString('hex'));
  fs.cpSync(PROMPTS, dir, { recursive: true });
  for (const k of keys) fs.writeFileSync(path.join(dir, 'agents', k + '.md'), '---\nname: ' + k + '\n---\n# SOUL\nA test prompt for ' + k + ' (R1 tests only).\n# ORDERS\nDo nothing.\n');
  return dir;
}
// an agent hired for a test: active, with an output limit, and only the tools that are built today
export const hire = (tools = null) => (o) => { o.status = 'active'; o.enabled = true; o.limits = { ...o.limits, maxOutputTokens: 4000 }; if (tools) o.tools = tools; };

export function engineOn(t, { tag = 'r1', configDir = CONFIG, promptsDir = PROMPTS, sandbox = false, ...opts } = {}) {
  const r = tempRoot(tag);
  const engine = createEngine({ J: r.J, log: r.log, configDir, promptsDir, startScheduler: false, ...(sandbox ? { archiveSandbox: true } : {}), ...opts });
  t.after(() => { try { engine.close(); } catch (_) { /* closed */ } r.cleanup(); });
  return { engine, r };
}
// a new engine on the same data root (the first must be closed)
export const reopen = (r, opts = {}) => createEngine({ J: r.J, log: r.log, startScheduler: false, ...opts });

// the page: the engine server on a free port, and its writes as the page sends them
export async function serve(t, engine, log) {
  const es = createEngineServer({ engine, log });
  await new Promise((res) => es.server.listen(0, '127.0.0.1', res));
  const port = es.server.address().port, origin = 'http://127.0.0.1:' + port;
  t.after(async () => { es.closeAll(); await new Promise((res) => es.server.close(res)); });
  const raw = (method, p, { headers = {}, body = null } = {}) => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ } res({ status: s.statusCode, json, text }); }); });
    q.on('error', rej); if (body != null) q.write(body); q.end();
  });
  const post = (p, body = {}, { key = crypto.randomUUID(), origin: o = origin, token = es.token } = {}) => raw('POST', p, { headers: { 'content-type': 'application/json', ...(o ? { origin: o } : {}), ...(token ? { 'x-station-action': token } : {}), ...(key ? { 'x-idempotency-key': key } : {}) }, body: JSON.stringify(body) });
  const snapshot = async () => (await raw('GET', '/api/office/snapshot?fresh')).json;
  return { es, post, raw, snapshot, token: es.token };
}
