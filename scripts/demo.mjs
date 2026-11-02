// demo.mjs — demo mode (npm run demo): the real engine on the MOCK provider (zero model spend, no key is ever read or
// loaded) on its own data root, office-agents/data-demo/, which is wiped and rebuilt on every start and every restart.
// It never reads or writes data/ (the station's own root) or the legacy build: every write goes through a jail whose
// only roots are data-demo/ and logs/, and a demo root that overlaps the station data root is refused. .env is not read.
//
// The scripted day (demo/script.mjs, timing in demo/pacing.json, about 3 minutes at 1x) runs through the real engine,
// orchestrator, spend guard, ledger and event bus, so the office page reacts over SSE exactly as it will live:
//   research line   DEMAND-RESEARCHER drafts a brief, EVIDENCE-CHECKER verifies it, the station's brief check passes it
//   Room 1 line     job B (an earlier verified brief) runs first: DESIGNER names a protected character, the prep
//                   originality screen trips, the line sends it back once, it trips again and the job ends blocked at
//                   prep with the reason (the real line's routing; owner 16/10/2026, no routing change for the demo)
//                   job A (the brief just verified) straight after: DESIGNER makes the 5-file set, QA-DESIGN sends it
//                   back once then approves, LISTER, QA-LISTING approves, the package gate passes, approval queue
// One job per line at a time (owner Q12) is unchanged: B and the research batch run side by side on different lines.
// Controls (page keys, sent as same-origin, token-checked POSTs): Space pause/resume, 1/2/4 speed, R restart.
//   npm run demo                  -> http://127.0.0.1:8793 (STATION_DEMO_PORT; 8791 is taken on this machine by another program); the day starts when a page connects
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJail, realResolve, APP_ROOT } from '../src/engine/store/jail.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { send, sendJson, LEGACY_PORT } from '../src/server/index.mjs';
import { makeLogger, SECRET_ENV } from '../src/server/log.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { createProviders } from '../src/engine/providers/index.mjs';
import { PORTS } from '../src/engine/instance.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { TERMINAL } from '../src/engine/orchestrator.mjs';
import { createDemoScript } from '../demo/script.mjs';

export const DEMO_DIR = path.join(APP_ROOT, 'demo');
export const DEMO_ROOT = path.join(APP_ROOT, 'data-demo');
export const DEMO_PORT = 8793;
export const DEMO_LABEL = 'DEMO · simulated data';
const BY = 'demo director (as the owner\'s Start click)';

export class DemoRefused extends Error { constructor(msg) { super(msg); this.code = 'DEMO_REFUSED'; } }
export class DemoAborted extends Error { constructor(msg = 'demo restarted') { super(msg); this.code = 'DEMO_ABORTED'; } }

// ---- refusals, checked before anything is created, read or bound
// the engine's secret names plus any other provider key or token name (values are never printed, only names)
const KEY_NAME_RE = /^(ANTHROPIC|OPENROUTER|OPENAI)_[A-Z0-9_]*(KEY|TOKEN)$/;
export function demoRefusals(env = process.env) {
  const out = [];
  const keys = Object.keys(env).filter((k) => (SECRET_ENV.includes(k) || KEY_NAME_RE.test(k)) && String(env[k] || '').trim()).sort();
  if (keys.length) out.push('real API keys are present in the environment (' + keys.join(', ') + '): demo mode runs on the mock provider and never starts with keys loaded; unset them in this shell and run it again');
  if (env.STATION_PROVIDER && env.STATION_PROVIDER !== 'mock') out.push('STATION_PROVIDER is "' + env.STATION_PROVIDER + '": demo mode runs on the mock provider only');
  return out;
}
export function assertDemoEnv(env = process.env) { const r = demoRefusals(env); if (r.length) throw new DemoRefused(r.join('; ')); }

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, root) => { const c = norm(child), r = norm(root); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

// the demo's jail: data-demo/ and the log folder only. The station data root (office-agents/data, or STATION_DATA_ROOT)
// is never a root, and a demo root that overlaps it (either way round) is refused, because the demo wipes its root.
export function createDemoJail({ dataRoot = DEMO_ROOT, logDir = path.join(APP_ROOT, 'logs'), env = process.env } = {}) {
  const want = realResolve(path.resolve(dataRoot));
  for (const r of [path.join(APP_ROOT, 'data'), env.STATION_DATA_ROOT].filter(Boolean).map((x) => realResolve(path.resolve(x)))) {
    if (inside(want, r) || inside(r, want)) throw new DemoRefused('the demo data root ' + want + ' overlaps the station data root ' + r + '; the demo wipes its root, so it must be a folder of its own');
  }
  return createJail({ dataRoot, extraRoots: [logDir] });
}

// wipe data-demo/ (everything inside it, through the jail), unless another live process holds its engine lock
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function wipeDemoRoot(J, log) {
  try { const cur = JSON.parse(fs.readFileSync(path.join(J.dataRoot, '.lock'), 'utf8')); if (cur.pid && cur.pid !== process.pid && alive(cur.pid)) throw new DemoRefused('another demo (pid ' + cur.pid + ') is running on ' + J.dataRoot); }
  catch (e) { if (e.code === 'DEMO_REFUSED') throw e; /* no lock: nothing running */ }
  const names = fs.readdirSync(J.dataRoot);
  for (const n of names) {
    const f = path.join(J.dataRoot, n);
    for (let i = 0; ; i++) { try { J.remove(f); break; } catch (e) { if (i >= 5 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(e.code)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } }
  }
  log.info('demo data root wiped', { dataRoot: J.dataRoot, entries: names.length });
}

// ---- pacing (demo/pacing.json): every number is a wait in ms at 1x
export const ZERO_PACING = { speeds: [1, 2, 4], defaultSpeed: 1, startHoldMs: 0, textTurnMs: { default: 0 }, imageMs: 0, imageAnalyzeMs: 0, webMs: 0, stageHoldMs: 0, endHoldMs: 0 };
export function loadPacing(file = path.join(DEMO_DIR, 'pacing.json')) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8')), bad = [];
  for (const k of ['startHoldMs', 'imageMs', 'imageAnalyzeMs', 'webMs', 'stageHoldMs', 'endHoldMs']) if (!(Number.isFinite(p[k]) && p[k] >= 0)) bad.push(k);
  if (!p.textTurnMs || !Object.values(p.textTurnMs).every((v) => Number.isFinite(v) && v >= 0) || !Number.isFinite(p.textTurnMs.default)) bad.push('textTurnMs');
  if (!Array.isArray(p.speeds) || !p.speeds.length || !p.speeds.every((s) => s > 0) || !p.speeds.includes(p.defaultSpeed)) bad.push('speeds/defaultSpeed');
  if (bad.length) throw new Error(path.basename(file) + ': bad or missing ' + bad.join(', '));
  return p;
}

// ---- the demo clock: waits that pause, change speed and abort together (a restart rejects every wait at once)
export function createDemoClock({ speed = 1, tickMs = 40 } = {}) {
  let paused = false, aborted = null, rate = speed, demoMs = 0, last = Date.now();
  const waits = new Set();
  const timer = setInterval(() => {
    const now = Date.now(), dt = now - last; last = now;
    if (paused || aborted) return;
    const adv = dt * rate; demoMs += adv;
    for (const w of [...waits]) { w.left -= adv; if (w.left <= 0) w.done(); }
  }, tickMs);
  timer.unref();
  function wait(ms, signal) {
    if (aborted) return Promise.reject(aborted);
    if (signal && signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
    if (!(ms > 0) && !paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => w.fail(signal.reason || new Error('aborted'));
      const off = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      const w = { left: ms > 0 ? ms : 0, done: () => { waits.delete(w); off(); resolve(); }, fail: (e) => { waits.delete(w); off(); reject(e); } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waits.add(w);
    });
  }
  return {
    wait,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    setSpeed: (s) => { rate = s; },
    abort: (e = new DemoAborted()) => { aborted = e; clearInterval(timer); for (const w of [...waits]) w.fail(e); },
    stop: () => clearInterval(timer),
    get paused() { return paused; }, get speed() { return rate; }, get demoMs() { return demoMs; }, get aborted() { return !!aborted; }
  };
}

// the mock providers with a paced wait in front of each call (text turn, image, web); still mode "mock", $0, no key
export function pacedProviders({ script, clock, pacing, log }) {
  const base = createProviders({ mode: 'mock', script, delayMs: 0, log });
  const turnMs = (ctx = {}) => (ctx.purpose === 'image_analyze' ? pacing.imageAnalyzeMs : (pacing.textTurnMs[ctx.agentKey] ?? pacing.textTurnMs.default));
  return {
    mode: base.mode,
    text: { id: base.text.id, get calls() { return base.text.calls; }, async create(params, opts = {}) { await clock.wait(turnMs(opts.ctx), opts.signal); return base.text.create(params, opts); } },
    image: { id: base.image.id, get calls() { return base.image.calls; }, async generate(args) { await clock.wait(pacing.imageMs, args.signal); return base.image.generate(args); } },
    web: async (name, args, opts = {}) => { await clock.wait(pacing.webMs, opts.signal); return base.web(name, args, opts); }
  };
}

// ---- one run of the scripted day on a freshly wiped root
function bootRun({ J, log, pacing, speed, generation, onPhase }) {
  wipeDemoRoot(J, log);
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DEMO_DIR, f), 'utf8'));
  const overrides = { productsFile: readJson('products.json'), stationSet: readJson('station-patch.json').set };
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts'), overrides });
  const day = dublinDay();
  const brief = (f) => fs.readFileSync(path.join(DEMO_DIR, 'briefs', f), 'utf8').replace(/\r\n/g, '\n').replace(/\{\{TODAY\}\}/g, day);
  const jobA = day + '--demo-mushroom-stickers', jobB = day + '--demo-astronaut-cat-stickers';
  const draft = brief('mushroom-stickers.md'), briefB = brief('astronaut-cat-stickers.md');
  const clock = createDemoClock({ speed });
  const script = createDemoScript({ cfg: cfg.station, draft, jobA, jobB });
  // each stage stays on screen for at least stageHoldMs (the presenter's 3-second hold); hooks never change a job
  const hooks = { onStep: async ({ phase }) => { if (phase === 'end') await clock.wait(pacing.stageHoldMs); } };
  const engine = openScriptEngine({ archiveSandbox: true, J, log, providers: pacedProviders({ script, clock, pacing, log }), overrides, hooks, demo: true, purpose: 'demo', startsJobs: true });
  const run = { generation, engine, clock, jobA, jobB, researchId: null, started: false, phase: 'waiting', startedAt: null, finishedAt: null, error: null, result: null, played: null };
  const setPhase = (p) => { run.phase = p; onPhase && onPhase(run); };
  const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function play() {
    const O = engine.orchestrator;
    setPhase('running'); run.startedAt = Date.now();
    log.info('demo day started', { generation, jobA, jobB, speed: clock.speed });
    await clock.wait(pacing.startHoldMs);
    // job B first: an owner brief (E7a.1: a legacy Etsy-format brief no longer starts a job), so its originality trip comes early in the day
    const b = O.createJob({ briefText: briefB, by: BY, idempotencyKey: 'demo-' + generation + '-B' });
    if (!b.ok) throw new Error('job B intake refused: ' + b.reasons.join('; '));
    const pB = O.startJob(jobB);
    // the research batch on its own line at the same time
    const r = O.createResearchJob({ input: 'Run your standing orders for this batch: one candidate brief (DEMO, simulated data).', by: BY });
    run.researchId = r.id;
    await O.startJob(r.id);
    const rj = engine.store.getJob(r.id);
    const verified = path.join(J.dataRoot, 'research', 'briefs', jobA + '.md');
    if (rj.state !== 'research-done' || !fs.existsSync(verified)) throw new Error('the research batch verified no brief: ' + rj.state + ' · ' + rj.reason);
    // job A straight after B: one job per line (Q12), so it waits in the queue while B is still on the line
    const a = O.createJob({ briefText: fs.readFileSync(verified, 'utf8'), by: BY, idempotencyKey: 'demo-' + generation + '-A' });
    if (!a.ok) throw new Error('job A intake refused: ' + a.reasons.join('; '));
    O.startJob(jobA);
    await pB;
    while (!TERMINAL.includes(engine.store.getJob(jobA).state)) { if (clock.aborted) throw new DemoAborted(); await realWait(100); }
    await clock.wait(pacing.endHoldMs);
    const job = (id) => { const j = engine.store.getJob(id); return { state: j.state, step: j.step, reason: j.reason, loops: j.loops }; };
    run.result = { jobs: { [r.id]: job(r.id), [jobB]: job(jobB), [jobA]: job(jobA) }, ledger: { rows: engine.ledger.totals.rows, usd: engine.ledger.totals.usd, allMock: engine.ledger.rows().every((x) => x.provider === 'mock') }, textCalls: engine.providers.text.calls, imageCalls: engine.providers.image.calls, demoMs: Math.round(clock.demoMs), wallMs: Date.now() - run.startedAt };
    run.finishedAt = Date.now(); setPhase('done');
    log.info('demo day complete', run.result);
    return run.result;
  }
  run.start = () => {
    if (run.started) return run.played; run.started = true;
    run.played = play().catch((e) => { if (e instanceof DemoAborted || clock.aborted) return { aborted: true }; run.error = e.message; setPhase('failed'); log.error('demo day failed', { error: String(e && e.stack || e) }); return { error: e.message }; });
    return run.played;
  };
  return run;
}

// every job has ended (an aborted wait fails its run at once, so the line finishes quickly)
async function waitIdle(engine, ms) { const t0 = Date.now(); while (engine.orchestrator.active().length) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 50)); } return true; }

// ---- the demo server: one listening port; the page, SSE and actions come from the current run's engine server
export async function startDemo({ port = Number(process.env.STATION_DEMO_PORT || DEMO_PORT), dataRoot = DEMO_ROOT, logDir = path.join(APP_ROOT, 'logs'), pacing = null, env = process.env, quiet = false, startWhen = 'page' } = {}) {
  assertDemoEnv(env);
  if (port === LEGACY_PORT) throw new DemoRefused('refusing to listen on ' + LEGACY_PORT + ': that is the legacy system port');
  // L1: never on an instance's port (live 8790, dev 8792), so the demo can run beside both
  for (const [name, p] of Object.entries(PORTS)) if (port === p) throw new DemoRefused('refusing to listen on ' + p + ': that is the ' + name + ' instance\'s port');
  pacing = pacing || loadPacing();
  const J = createDemoJail({ dataRoot, logDir, env });
  const log = makeLogger({ dir: logDir, name: 'demo', jail: J, quiet });
  log.info('demo mode: mock provider only, no keys loaded, .env not read', { dataRoot: J.dataRoot, port });
  let run = null, es = null, generation = 0, speed = pacing.defaultSpeed, restarting = null;

  const publicState = () => ({
    on: true, label: DEMO_LABEL, generation, phase: restarting ? 'restarting' : run ? run.phase : 'starting', paused: !!(run && run.clock.paused), speed, speeds: pacing.speeds,
    demoMs: run ? Math.round(run.clock.demoMs) : 0, startedAt: run ? run.startedAt : null, finishedAt: run ? run.finishedAt : null, error: run ? run.error : null,
    jobs: run ? { research: run.researchId, a: run.jobA, b: run.jobB } : null
  });
  function control(body) {
    const act = String(body.action || '');
    if (!run) throw new Error('the demo is restarting');
    if (act === 'pause' || (act === 'toggle' && !run.clock.paused)) run.clock.pause();
    else if (act === 'resume' || act === 'toggle') run.clock.resume();
    else if (act === 'speed') { const s = Number(body.speed); if (!pacing.speeds.includes(s)) throw new Error('speed must be one of ' + pacing.speeds.join(', ')); speed = s; run.clock.setSpeed(s); }
    else throw new Error('unknown demo action: ' + act);
    log.info('demo control', { action: act, paused: run.clock.paused, speed });
    return publicState();
  }
  const ext = {
    actions: {
      'POST /api/demo/control': (body) => control(body),
      'POST /api/demo/restart': () => { restart().catch((e) => log.error('demo restart failed', { error: String(e && e.stack || e) })); return { restarting: true, from: generation }; }
    },
    snapshotExtra: () => ({ demo: publicState() })
  };
  function boot() {
    generation++;
    run = bootRun({ J, log, pacing, speed, generation });
    es = createEngineServer({ engine: run.engine, log, ext });
    if (startWhen === 'now') run.start();
  }
  async function shutRun(reason) {
    if (!run) return;
    const r = run; run = null;
    const cur = es; es = null;
    r.clock.abort(new DemoAborted(reason));
    if (!(await waitIdle(r.engine, 15000))) log.warn('demo jobs still active at close', { active: r.engine.orchestrator.active() });
    if (r.played) await r.played;
    cur.dispose(); r.engine.close();
  }
  function restart() {
    if (restarting) return restarting;
    restarting = (async () => { log.info('demo restart', { from: generation }); await shutRun('demo restarted (R)'); boot(); })().finally(() => { restarting = null; });
    return restarting;
  }

  boot();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && p === '/api/demo/state') return sendJson(res, publicState());
    if (!es || restarting) return send(res, 503, 'the demo is restarting', 'text/plain', { 'Retry-After': '1' });
    // the day starts when the first page connects to the live stream (so nobody misses the start)
    if (req.method === 'GET' && p === '/api/events' && !run.started) setImmediate(() => run && run.start());
    return es.handler(req, res);
  });
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  log.info('demo listening', { url, dataRoot: J.dataRoot, startWhen });
  async function close() { await (restarting || Promise.resolve()); await shutRun('demo closed'); await new Promise((r) => server.close(r)); log.info('demo closed'); }
  return { server, url, log, dataRoot: J.dataRoot, state: publicState, control, restart, close, current: () => run, played: () => (run ? run.start() : Promise.resolve(null)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo().then((d) => {
    console.log('\nStation demo: ' + d.url + '  (' + DEMO_LABEL + '; mock provider, $0, data in ' + d.dataRoot + ')');
    console.log('Open it in a browser: the scripted day starts when the page connects. Keys: Space pause, 1/2/4 speed, R restart, P presenter view.\n');
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; d.close().then(() => process.exit(0), () => process.exit(1)); setTimeout(() => process.exit(0), 20000).unref(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch((e) => { console.error('demo did not start: ' + e.message); process.exitCode = 2; });
}
