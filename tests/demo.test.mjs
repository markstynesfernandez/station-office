// demo.test.mjs — demo mode (scripts/demo.mjs): it refuses to start with real API keys in the environment (in-process and
// as `node scripts/demo.mjs`), runs on the mock provider only, writes only inside its own root (never data/ or the
// legacy build), and plays the scripted day through the real engine: the research batch verifies the brief, job B ends
// blocked at prep by the originality gate after one retry, job A reaches the approval queue after one QA-DESIGN rework.
// Every engine run here is on a temp root at zero pacing; nothing touches office-agents/data-demo or data.
import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemo, DEMO_PORT, demoRefusals, createDemoJail, createDemoClock, loadPacing, ZERO_PACING, DemoRefused } from '../scripts/demo.mjs';
import { JailError } from '../src/engine/store/jail.mjs';
import { tempDir } from './helpers/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = 'sk-ant-api03-FAKE-test-value-0000000000';
function temp(t) { const base = tempDir('station-demo-'); t.after(() => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) { /* left in temp */ } }); return { base, dataRoot: path.join(base, 'data-demo'), logDir: path.join(base, 'logs') }; }
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|OPENROUTER|OPENAI)_/.test(k) && k !== 'STATION_PROVIDER'));

test('demo mode refuses to start if real API keys are present in the environment', async (t) => {
  const r = temp(t);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    await assert.rejects(startDemo({ port: 0, ...r, quiet: true, env: { ...cleanEnv(), [k]: FAKE } }), (e) => e instanceof DemoRefused && e.message.includes(k) && /real API keys/.test(e.message) && !e.message.includes(FAKE), k);
  }
  assert.ok(!fs.existsSync(r.dataRoot), 'nothing was created: the refusal comes before the jail, the wipe and the engine');
  assert.ok(!fs.existsSync(r.logDir), 'no log written');
  // a blank variable is not a key; tool tokens that are not provider keys are not refused
  assert.deepEqual(demoRefusals({ ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '   ', CLAUDE_CODE_MESSAGING_TOKEN: 'x'.repeat(20), GITHUB_TOKEN: 'y'.repeat(20) }), []);
});

test('npm run demo (node scripts/demo.mjs) exits at once with keys in the environment, naming the variable, never the value', () => {
  const env = { ...cleanEnv(), OPENROUTER_API_KEY: FAKE, STATION_DEMO_PORT: '0' };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 2, 'exit code 2 (refused); stderr: ' + r.stderr);
  assert.match(r.stderr, /demo did not start: real API keys are present in the environment \(OPENROUTER_API_KEY\)/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE), 'the key value is never printed');
  assert.doesNotMatch(r.stdout, /Station demo: http/, 'it never listened');
  assert.ok(Date.now() - t0 < 30000);
});

test('demo port: 8793 by default (8791 is taken on this machine); never 8787 or an instance\'s port (live 8790, dev 8792)', async (t) => {
  assert.equal(DEMO_PORT, 8793);
  const r = temp(t);
  for (const [port, re] of [[8787, /legacy system port/], [8790, /the live instance's port/], [8792, /the dev instance's port/]]) {
    await assert.rejects(startDemo({ port, ...r, quiet: true, env: cleanEnv() }), (e) => e instanceof DemoRefused && re.test(e.message), String(port));
  }
  assert.ok(!fs.existsSync(r.dataRoot), 'refused before the jail, the wipe and the engine');
});

test('demo mode runs on the mock provider only', async (t) => {
  const r = temp(t);
  await assert.rejects(startDemo({ port: 0, ...r, quiet: true, env: { ...cleanEnv(), STATION_PROVIDER: 'live' } }), /mock provider only/);
  assert.ok(!fs.existsSync(r.dataRoot));
});

test('the demo jail: only its own root and logs; never data/ or the legacy build; a root overlapping data/ is refused', (t) => {
  const r = temp(t);
  const J = createDemoJail({ dataRoot: r.dataRoot, logDir: r.logDir, env: cleanEnv() });
  assert.ok(J.dataJail(path.join(r.dataRoot, 'jobs', 'x', 'brief.md')).startsWith(r.dataRoot));
  for (const bad of [path.join(ROOT, 'data', 'x.json'), path.join(ROOT, 'data', 'ledger', 'ledger.jsonl'), path.resolve(ROOT, '..', 'Virtual-workers', 'station-workspace', 'x'), path.join(ROOT, 'config', 'engine.json'), path.join(ROOT, 'data-demo-other', 'x')]) assert.throws(() => J.dataJail(bad), JailError, bad);
  // the demo wipes its root, so it may never be (or contain, or sit inside) the station data root
  for (const bad of [path.join(ROOT, 'data'), path.join(ROOT, 'data', 'demo'), ROOT]) assert.throws(() => createDemoJail({ dataRoot: bad, logDir: r.logDir, env: cleanEnv() }), DemoRefused, bad);
  assert.throws(() => createDemoJail({ dataRoot: path.join(r.base, 'x'), logDir: r.logDir, env: { ...cleanEnv(), STATION_DATA_ROOT: r.base } }), DemoRefused, 'STATION_DATA_ROOT');
  // the CLI's root is office-agents/data-demo, which .gitignore keeps out of the repository
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^data-demo\/$/m);
});

test('the demo clock pauses, changes speed and aborts every wait at once', async () => {
  const c = createDemoClock({ speed: 1, tickMs: 10 });
  try {
    let done = false; const w = c.wait(200).then(() => { done = true; });
    c.pause(); await new Promise((r) => setTimeout(r, 300)); assert.equal(done, false, 'paused: no progress');
    c.setSpeed(4); c.resume(); await new Promise((r) => setTimeout(r, 150)); assert.equal(done, true, '4x: 200 ms of demo time in about 50 ms'); await w;
    c.pause(); const z = c.wait(0); let zd = false; z.then(() => { zd = true; }, () => {}); await new Promise((r) => setTimeout(r, 50)); assert.equal(zd, false, 'even a zero wait holds while paused');
    const later = c.wait(10000); c.abort(); await assert.rejects(later, /restarted/); await assert.rejects(z, /restarted/); await assert.rejects(c.wait(1), /restarted/);
  } finally { c.stop(); }
  const p = loadPacing();
  assert.deepEqual(p.speeds, [1, 2, 4]); assert.equal(p.stageHoldMs, 3000);
});

async function get(url, p) { const r = await fetch(url + p); return { status: r.status, json: await r.json().catch(() => null) }; }
function post(url, p, { token, body = {}, origin = url } = {}) {
  const u = new URL(url + p);
  return new Promise((res, rej) => {
    const q = http.request({ host: u.hostname, port: u.port, method: 'POST', path: u.pathname, headers: { 'content-type': 'application/json', 'x-idempotency-key': 'demo-test-' + crypto.randomUUID(), ...(origin ? { origin } : {}), ...(token ? { 'x-station-action': token } : {}) } }, (s) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) {} res({ status: s.statusCode, json }); }); });
    q.on('error', rej); q.end(JSON.stringify(body));
  });
}

test('the scripted day through the real engine: research verifies, B blocked by originality at prep, A in the approval queue', async (t) => {
  const r = temp(t);
  const d = await startDemo({ port: 0, ...r, pacing: ZERO_PACING, quiet: true, startWhen: 'now', env: cleanEnv() });
  t.after(() => d.close());
  const res = await d.played();
  const events = d.current().engine.bus.since(0);   // the bus's replay ring holds the whole day
  assert.equal(events[0].type, 'engine.start', 'the ring starts at the engine start (nothing dropped)');
  const { jobA, jobB, researchId } = d.current();
  assert.equal(res.jobs[researchId].state, 'research-done');
  assert.match(res.jobs[researchId].reason, /verified -> briefs\//);
  assert.equal(res.jobs[jobB].state, 'blocked');
  assert.equal(res.jobs[jobB].step, 'prep');
  assert.match(res.jobs[jobB].reason, /^prep failed again after one retry: ORIGINALITY HARD FAIL in set-v2\/design\.md: .*"garfield"/);
  assert.equal(res.jobs[jobA].state, 'approval');
  assert.deepEqual(res.jobs[jobA].loops, { design: 1 }, 'one QA-DESIGN rework');
  assert.deepEqual(res.ledger, { rows: res.ledger.rows, usd: 0, allMock: true }); assert.ok(res.ledger.rows > 40);
  // every agent of the day ran, and the order is B first, then A straight after (one job per line)
  const starts = events.filter((e) => e.type === 'run.start');
  for (const k of ['demand-researcher', 'evidence-checker', 'designer', 'qa-design', 'lister', 'qa-listing']) assert.ok(starts.some((e) => e.agentKey === k), k + ' ran');
  const firstA = events.findIndex((e) => e.type === 'run.start' && e.jobId === jobA), endB = events.findIndex((e) => e.type === 'job.blocked' && e.jobId === jobB);
  assert.ok(endB >= 0 && firstA > endB, 'job A starts on the line after job B has ended');
  assert.ok(events.some((e) => e.type === 'run.tool' && e.data.refused === 'originality'), 'the image prompt naming the character was refused');
  const qa = JSON.parse(fs.readFileSync(path.join(r.dataRoot, 'jobs', jobA, 'qa', 'design-pass1.json'), 'utf8'));
  assert.equal(qa.verdict, 'revise'); assert.match(qa.reasons[0], /^file 3/);
  const mf = JSON.parse(fs.readFileSync(path.join(r.dataRoot, 'jobs', jobA, 'package', 'MANIFEST.json'), 'utf8'));
  assert.equal(mf.provider, 'mock'); assert.equal(mf.costUsd, 0); assert.equal(mf.files.length, 5);
  // the page's snapshot carries the demo state (the badge) and the stage notes the captions read
  const s = await get(d.url, '/api/office/snapshot?fresh');
  assert.equal(s.json.demo.label, 'DEMO · simulated data'); assert.equal(s.json.demo.phase, 'done'); assert.equal(s.json.engine.provider, 'mock');
  const b = s.json.jobs.find((j) => j.id === jobB); assert.equal(b.lastStage.step, 'prep'); assert.match(b.lastStage.note, /garfield/);
  assert.equal(s.json.jobs.find((j) => j.id === jobA).productFiles, 5);
});

test('demo controls are token-checked POSTs; restart wipes the root and plays the day again', async (t) => {
  const r = temp(t);
  const d = await startDemo({ port: 0, ...r, pacing: ZERO_PACING, quiet: true, startWhen: 'page', env: cleanEnv() });
  t.after(() => d.close());
  assert.equal(d.state().phase, 'waiting', 'the day waits for a page');
  assert.equal((await post(d.url, '/api/demo/control', { body: { action: 'pause' } })).status, 403, 'no token');
  assert.equal((await post(d.url, '/api/demo/control', { token: 'stale', body: { action: 'pause' } })).status, 403, 'stale token');
  const session = await fetch(d.url + '/api/session', { headers: { 'sec-fetch-site': 'same-origin' } }).then((x) => x.json());
  assert.equal((await post(d.url, '/api/demo/control', { token: session.actionToken, origin: 'http://evil.example', body: { action: 'pause' } })).status, 403, 'other origin');
  const sp = await post(d.url, '/api/demo/control', { token: session.actionToken, body: { action: 'speed', speed: 3 } });
  assert.equal(sp.status, 400); assert.match(sp.json.error, /speed must be one of 1, 2, 4/);
  const ok = await post(d.url, '/api/demo/control', { token: session.actionToken, body: { action: 'speed', speed: 4 } });
  assert.equal(ok.status, 200); assert.equal(ok.json.result.speed, 4);
  await d.played();
  assert.equal(d.state().phase, 'done');
  fs.writeFileSync(path.join(r.dataRoot, 'marker.txt'), 'old run');
  const gen = d.state().generation;
  const rs = await post(d.url, '/api/demo/restart', { token: session.actionToken });
  assert.equal(rs.status, 200); assert.equal(rs.json.result.restarting, true);
  for (let i = 0; i < 200 && !(d.state().generation > gen && d.state().phase !== 'restarting'); i++) await new Promise((x) => setTimeout(x, 25));
  assert.equal(d.state().generation, gen + 1);
  assert.ok(!fs.existsSync(path.join(r.dataRoot, 'marker.txt')), 'the root was wiped');
  assert.equal(d.state().speed, 4, 'the speed carries over');
  assert.equal((await post(d.url, '/api/demo/control', { token: session.actionToken, body: { action: 'pause' } })).status, 403, 'the old token died with the old engine');
  const res = await d.played();
  assert.equal(res.jobs[d.current().jobA].state, 'approval');
});

test('demo values are applied only by scripts/demo.mjs to the demo engine; a real engine refuses to start with any of them', async (t) => {
  const { createEngine, DemoConfigError } = await import('../src/engine/engine.mjs');
  const { demoMarkers, loadConfig } = await import('../src/engine/config.mjs');
  const { tempRoot } = await import('./helpers/engine.mjs');
  const readDemo = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', f), 'utf8'));
  const overrides = { productsFile: readDemo('products.json'), stationSet: readDemo('station-patch.json').set };
  // statically: only scripts/demo.mjs names the demo patch, reads demo/products.json or passes demo: true
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const code = ['src', 'scripts', 'demo'].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.(mjs|js)$/.test(f));
  for (const f of code) {
    const r = path.relative(ROOT, f).replace(/\\/g, '/'), src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
    if (r === 'scripts/demo.mjs') { assert.match(src, /readJson\('station-patch\.json'\)/); assert.match(src, /demo: true/); continue; }
    assert.ok(!/station-patch/.test(src), r + ' names the demo patch');
    assert.ok(!/DEMO_DIR|['"]demo['"]\s*,\s*['"]products\.json|demo[\\/]products\.json/.test(src), r + ' reads the demo products');
    assert.ok(!/\bdemo\s*:\s*true\b/.test(src), r + ' starts a demo engine');
  }
  // the real config carries no demo value; the demo files are all caught
  const real = loadConfig({ configDir: path.join(ROOT, 'config'), promptsDir: path.join(ROOT, 'prompts') });
  assert.deepEqual(demoMarkers(real), []);
  const withDemo = loadConfig({ configDir: path.join(ROOT, 'config'), promptsDir: path.join(ROOT, 'prompts'), overrides });
  const marks = demoMarkers(withDemo);
  for (const k of ['station.digital.listingNoticeStatus', 'station.digital.licences.personal-use.status', 'station.digital.aiDisclosure.text']) assert.ok(marks.includes(k), k);
  assert.ok(marks.some((m) => /demo-sticker-pack-5/.test(m)), 'the demo product');
  // at runtime: a real engine (no demo flag) refuses the demo overrides, and refuses a config folder holding any demo value
  const a = tempRoot('demo-guard'); t.after(a.cleanup);
  assert.throws(() => createEngine({ archiveSandbox: true, J: a.J, log: a.log, overrides, startScheduler: false }), (e) => e instanceof DemoConfigError && /DEMO values are in the config/.test(e.message));
  assert.ok(!fs.existsSync(path.join(a.dataRoot, 'station.db')), 'refused before the store opened');
  assert.ok(!fs.existsSync(path.join(a.dataRoot, '.lock')), 'the lock was released');
  const cfgDir = path.join(a.base, 'config'); fs.cpSync(path.join(ROOT, 'config'), cfgDir, { recursive: true });
  const st = JSON.parse(fs.readFileSync(path.join(cfgDir, 'station.config.json'), 'utf8')); st.digital.listingNoticeStatus = readDemo('station-patch.json').set['digital.listingNoticeStatus'];
  fs.writeFileSync(path.join(cfgDir, 'station.config.json'), JSON.stringify(st));
  assert.throws(() => createEngine({ archiveSandbox: true, J: a.J, log: a.log, configDir: cfgDir, startScheduler: false }), DemoConfigError, 'a DEMO value copied into the real config');
  const pr = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'archive', 'etsy', 'products.json'), 'utf8')); pr.products.push(readDemo('products.json').products[0]);
  fs.cpSync(path.join(ROOT, 'config', 'station.config.json'), path.join(cfgDir, 'station.config.json')); fs.writeFileSync(path.join(cfgDir, 'archive', 'etsy', 'products.json'), JSON.stringify(pr));
  assert.throws(() => createEngine({ archiveSandbox: true, J: a.J, log: a.log, configDir: cfgDir, startScheduler: false }), DemoConfigError, 'the demo product copied into the real products');
  // the demo flag never opens the station's data root
  const { checkDemoConfig } = await import('../src/engine/engine.mjs');
  assert.throws(() => checkDemoConfig(withDemo, { demo: true, dataRoot: path.join(ROOT, 'data') }), /station data root/);
  assert.throws(() => checkDemoConfig(withDemo, { demo: true, dataRoot: path.join(ROOT, 'data', 'x') }), /station data root/);
  assert.deepEqual(checkDemoConfig(withDemo, { demo: true, dataRoot: path.join(a.base, 'data-demo') }), marks);
  // and the plain engine still starts on the real config
  const e = createEngine({ archiveSandbox: true, J: a.J, log: a.log, startScheduler: false }); e.close();
});

test('DEMAND-RESEARCHER and EVIDENCE-CHECKER desks show working for the length of each research run, then idle', async (t) => {
  const { buildEngineSnapshot } = await import('../src/server/engine-model.mjs');
  const r = temp(t);
  const d = await startDemo({ port: 0, ...r, pacing: ZERO_PACING, quiet: true, startWhen: 'page', env: cleanEnv() });
  t.after(() => d.close());
  const engine = d.current().engine, seen = [];
  const statusOf = (k) => buildEngineSnapshot(engine).agents.find((a) => a.id === k);
  engine.bus.subscribe((ev) => {
    if (!['demand-researcher', 'evidence-checker'].includes(ev.agentKey) || !['run.start', 'run.end'].includes(ev.type)) return;
    const a = statusOf(ev.agentKey);
    seen.push({ type: ev.type, agent: ev.agentKey, status: a.status, text: a.statusText, job: a.currentJob && a.currentJob.id });
  });
  d.current().start();
  await d.played();
  const starts = seen.filter((s) => s.type === 'run.start'), ends = seen.filter((s) => s.type === 'run.end');
  assert.ok(starts.some((s) => s.agent === 'demand-researcher') && starts.some((s) => s.agent === 'evidence-checker'), 'both research agents ran: ' + JSON.stringify(seen));
  for (const s of starts) { assert.equal(s.status, 'working', s.agent + ' at run.start: ' + JSON.stringify(s)); assert.equal(s.job, d.current().researchId, 'the desk names the research job'); }
  for (const s of ends) assert.notEqual(s.status, 'working', s.agent + ' after run.end');
});
