// index.mjs — the Station server. Serves the page, three.js from node_modules (jailed), and JSON for the office.
// Legacy view (createOfficeServer): a read-only read of the legacy build's files (the fixtures snapshot, or
// STATION_LEGACY_ROOT); nothing runs from it. Every write goes through the data jail (src/engine/store/jail.mjs). It
// makes no HTTP call to the legacy system and never sends a secret to the page. Secrets come from .env or the shell.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeLogger } from './log.mjs';
import { readStation, resolveImage } from './sources/files.mjs';
import { buildSnapshot } from './model.mjs';
import { applySynthetic, readOverlay } from './sources/synthetic.mjs';
import { loadEnv, readJsonSafe } from '../lib/legacy-readers/common.mjs';
import { outboundOwner } from '../engine/business.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const WEB = path.join(ROOT, 'src', 'web');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const FIXTURES = path.join(FIXTURES_DIR, 'station-root');
export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
export const LEGACY_PORT = 8787;

// ---- shared HTTP helpers (also used by the engine server)
export const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
export const sendJson = (res, obj, code = 200) => send(res, code, JSON.stringify(obj));
export const sendFile = (res, file) => {
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, buf) => { if (err) return send(res, 404, 'not found', 'text/plain'); send(res, 200, buf, MIME[ext] || 'application/octet-stream', { 'Cache-Control': ext === '.png' ? 'public, max-age=60' : 'no-store' }); });
};
export const jailed = (base, rel) => { const f = path.resolve(base, '.' + rel); return f.startsWith(base + path.sep) || f === base ? f : null; };
// static page + three.js (build/ and examples/jsm/ only); returns true when it answered
export function serveStatic(res, p) {
  if (p.startsWith('/vendor/three/')) { const rel = p.slice('/vendor/three'.length); if (!/^\/(build|examples\/jsm)\//.test(rel)) { send(res, 404, 'not found', 'text/plain'); return true; } const f = jailed(THREE_DIR, rel); f ? sendFile(res, f) : send(res, 404, 'not found', 'text/plain'); return true; }
  const rel = p === '/' ? '/index.html' : p;
  const f = jailed(WEB, rel);
  if (!f) { send(res, 404, 'not found', 'text/plain'); return true; }
  sendFile(res, f); return true;
}

export function createOfficeServer({ stationRoot, fixtures = false, synthetic = true, log, snapshotTtlMs = 2000 } = {}) {
  const root = fixtures || !stationRoot ? FIXTURES : stationRoot;
  const mode = fixtures || !stationRoot ? 'fixtures' : 'files';
  const hostLabel = 'Node ' + process.version + ' · ' + os.platform() + ' ' + os.release() + ' (station host)';
  let cache = { at: 0, snap: null, raw: null };
  // Fixtures mode: "now" is the snapshot's own time (fixtures/SNAPSHOT.json) so the mock is reproducible, and the
  // hand-written synthetic overlay adds the states the real snapshot lacks. Neither ever applies to a live root.
  const snapMeta = mode === 'fixtures' ? (readJsonSafe(path.join(FIXTURES_DIR, 'SNAPSHOT.json')).v || null) : null;
  const useSynthetic = mode === 'fixtures' && synthetic !== false && process.env.STATION_SYNTHETIC !== 'off';
  function snapshot(force = false) {
    const wall = Date.now();
    if (!force && cache.snap && wall - cache.at < snapshotTtlMs) return cache;
    const now = snapMeta && snapMeta.takenAtMs ? snapMeta.takenAtMs : wall;
    const raw = readStation(root, log);
    raw.mode = mode; raw.rootLabel = mode === 'fixtures' ? 'fixtures/station-root' : path.basename(root);
    raw.snapshotAt = snapMeta ? snapMeta.takenAtMs : null;
    if (useSynthetic) applySynthetic(raw, readOverlay(path.join(FIXTURES_DIR, 'synthetic', 'overlay.json'), log), { now });
    const snap = buildSnapshot(raw, { now, host: { label: hostLabel } });
    cache = { at: wall, snap, raw };
    return cache;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'the legacy view is read-only', 'text/plain');
    try {
      if (p === '/api/office/health') return sendJson(res, { ok: true, mode, view: 'legacy', root: mode === 'fixtures' ? 'fixtures/station-root' : path.basename(root), snapshotAt: snapMeta ? snapMeta.takenAt : null, syntheticOverlay: useSynthetic, logs: log.counts, uptimeS: Math.round(process.uptime()) });
      if (p === '/api/office/snapshot') { const { snap } = snapshot(url.searchParams.has('fresh')); return sendJson(res, snap); }
      if (p === '/api/office/ledger') { const { raw, snap } = snapshot(); const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100); const names = Object.fromEntries(snap.agents.map((a) => [a.id, a.name])); const rows = [...raw.ledger].sort((a, b) => b.tsMs - a.tsMs).slice(0, limit).map((r) => ({ at: r.tsMs, agent: names[r.agentId] || r.agentId, runId: r.runId, model: r.model, tokens: r.tokens, usd: r.usd, turns: r.turns })); return sendJson(res, { total: raw.ledger.length, rows, source: 'legacy/ledger.jsonl' }); }
      let m;
      if ((m = /^\/api\/office\/jobs\/([^/]+)$/.exec(p))) { const { snap } = snapshot(); const job = snap.jobs.find((j) => j.id === m[1]); return job ? sendJson(res, job) : sendJson(res, { error: 'no such job' }, 404); }
      if ((m = /^\/api\/office\/agents\/([^/]+)$/.exec(p))) { const { snap, raw } = snapshot(); const a = snap.agents.find((x) => x.id === m[1]); if (!a) return sendJson(res, { error: 'no such agent' }, 404); const runs = raw.runs.filter((r) => r.agentId === a.id).sort((x, y) => (y.endedAt || y.ts || 0) - (x.endedAt || x.ts || 0)).slice(0, 12).map((r) => ({ at: r.endedAt || r.ts, title: (r.title || '').slice(0, 90), reason: r.reason, usd: r.usd, tokens: r.tokens, durationMs: r.durationMs, failureCode: r.failureCode || null, synthetic: !!r.synthetic, syntheticWhat: r.syntheticWhat || null })); const jobs = a.recentJobs.map((id) => snap.jobs.find((j) => j.id === id)).filter(Boolean); return sendJson(res, { ...a, runs, jobs }); }
      if ((m = /^\/api\/office\/image\/(work|queue|rejected)\/([^/]+)\/([^/]+)$/.exec(p))) { const { raw } = snapshot(); const f = resolveImage(raw.paths, m[1], m[2], m[3]); if (!f) return send(res, 404, 'no such image', 'text/plain'); log.read(f); return sendFile(res, f); }
      if (p.startsWith('/api/')) return sendJson(res, { error: 'unknown office route' }, 404);
      return serveStatic(res, p);
    } catch (e) {
      log.error('request failed', { path: p, error: String(e && e.stack || e) });
      return sendJson(res, { error: 'server error', detail: String(e && e.message || e) }, 500);
    }
  });
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
  return { server, snapshot, mode, root };
}

// npm start (scripts/start.mjs): the engine. --legacy / --fixtures: the read-only legacy view. Run directly, this file
// starts the dev instance only (the live one needs the launcher's git check).
export async function startFromEnv({ argv = process.argv.slice(2), git = null } = {}) {
  loadEnv(path.join(ROOT, '.env'));
  if (!argv.includes('--legacy') && !argv.includes('--fixtures')) return startEngine({ git });
  const fixtures = argv.includes('--fixtures') || !process.env.STATION_LEGACY_ROOT;
  const { resolvePort } = await import('../engine/instance.mjs');
  const port = resolvePort(process.env);
  if (port === LEGACY_PORT) { console.error('refusing to listen on ' + LEGACY_PORT + ': that is the legacy system port'); process.exit(2); }
  const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'station' });
  const stationRoot = process.env.STATION_LEGACY_ROOT ? path.resolve(process.env.STATION_LEGACY_ROOT) : null;
  if (stationRoot && !fixtures && !fs.existsSync(path.join(stationRoot, 'station-workspace'))) { log.error('STATION_LEGACY_ROOT has no station-workspace/: ' + stationRoot); process.exit(2); }
  const { server, mode, root } = createOfficeServer({ stationRoot, fixtures, log });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') { log.error('port ' + port + ' is already in use (is another station running?)'); process.exit(3); } log.error('server error', { error: String(e) }); process.exit(1); });
  server.listen(port, '127.0.0.1', () => { log.info('station legacy view listening', { url: 'http://127.0.0.1:' + port, mode, root: mode === 'fixtures' ? 'fixtures/station-root' : root }); console.log('station (legacy view): http://127.0.0.1:' + port + '  (' + mode + ', read-only)'); });
  const stop = () => { log.info('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startFromEnv();

// ---- engine mode: one engine on STATION_DATA_ROOT, served on 127.0.0.1 only
// L1: the instance (live | dev, src/engine/instance.mjs) is checked before anything opens; `git` comes from the launcher
// (scripts/start.mjs), and the live instance refuses to start without it. <data root>/SHUTDOWN (written by
// scripts/deploy-live.mjs) asks this server to stop cleanly; it is polled every second.
export const SHUTDOWN_FILE = 'SHUTDOWN';
export async function startEngine({ git = null } = {}) {
  const { instanceName, resolvePort, resolveDataRoot, checkInstance, stampDataRoot } = await import('../engine/instance.mjs');
  let inst;
  try { const name = instanceName(process.env); inst = checkInstance({ name, env: process.env, port: resolvePort(process.env, name), dataRoot: resolveDataRoot(process.env, ROOT), appRoot: ROOT, git }); }
  catch (e) { console.error('station refused to start: ' + e.message); process.exit(2); }
  const port = inst.port;
  if (port === LEGACY_PORT) { console.error('refusing to listen on ' + LEGACY_PORT + ': that is the legacy system port'); process.exit(2); }
  const { createJail } = await import('../engine/store/jail.mjs');
  const { createEngine } = await import('../engine/engine.mjs');
  const { createEngineServer } = await import('./engine-server.mjs');
  const J = createJail({ dataRoot: inst.dataRoot });
  const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'station', jail: J });
  log.info('station instance', { instance: inst.name, commit: inst.commit, branch: inst.branch, dataRoot: inst.dataRoot, port });
  const shutdownFile = path.join(J.dataRoot, SHUTDOWN_FILE);
  if (fs.existsSync(shutdownFile)) { log.warn('a stale shutdown request was removed at start'); J.remove(shutdownFile); }
  let engine;
  try { engine = createEngine({ J, log, limitJobs: true, instance: { name: inst.name, commit: inst.commit } }); } catch (e) { log.error('engine did not start', { error: e.message, code: e.code || null }); console.error('engine did not start: ' + e.message); process.exit(2); }
  engine.instance = { name: inst.name, commit: inst.commit, branch: inst.branch, port };
  if (stampDataRoot(J, inst)) log.info('data root stamped for the ' + inst.name + ' instance', { dataRoot: J.dataRoot });
  // E7a: the own-shop Etsy connection. Live: the real client (keys from .env by name; without them Etsy stays unavailable,
  // the Station still starts). Dev: the mock Etsy only (the real client refuses to build off the live instance)
  // B0 (owner, 21/10/2026): an outbound action needs a business that lists it in allowedOutbound (and the owner's click each time)
  let etsy;
  const etsyOwner = outboundOwner(engine.cfg, 'etsy:read-own-shop');
  try {
    if (!etsyOwner) throw new Error('no product allows etsy.read-own-shop (config/products allowedActions; DECISIONS.md "R1")');
    if (inst.name === 'live') { const { createEtsyClient } = await import('../engine/providers/etsy.mjs'); etsy = createEtsyClient({ engineCfg: engine.cfg.engine, J, ledger: engine.ledger, log, businessId: etsyOwner }); }
    else { const { createMockEtsyClient } = await import('../engine/providers/etsy-mock.mjs'); etsy = createMockEtsyClient({ engineCfg: engine.cfg.engine, J, ledger: engine.ledger, log, businessId: etsyOwner }); }
    log.info('etsy: ' + etsy.mode + ' client ready', { connected: etsy.status().connected });
  } catch (e) { etsy = { unavailable: e.message }; log.warn('etsy: unavailable', { code: e.code || null, error: e.message }); }
  const { server, closeAll } = createEngineServer({ engine, log, etsy });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') { log.error('port ' + port + ' is already in use (is another station running?)'); engine.close(); process.exit(3); } log.error('server error', { error: String(e) }); process.exit(1); });
  server.listen(port, '127.0.0.1', () => { log.info('station engine listening', { url: 'http://127.0.0.1:' + port, instance: inst.name, commit: inst.commit, dataRoot: J.dataRoot, provider: engine.providers.mode }); console.log('station engine (' + inst.name + (inst.commit ? ' ' + inst.commit.slice(0, 7) : '') + '): http://127.0.0.1:' + port + '  (provider ' + engine.providers.mode + ', data ' + J.dataRoot + ')'); });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; log.info('shutting down'); closeAll(); server.close(() => { engine.close(); process.exit(0); }); setTimeout(() => { engine.close(); process.exit(0); }, 1500).unref(); };
  const poll = setInterval(() => { if (!stopping && fs.existsSync(shutdownFile)) { log.warn('shutdown requested (' + SHUTDOWN_FILE + ' file)'); J.remove(shutdownFile); stop(); } }, 1000); poll.unref();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return { server, engine };
}
