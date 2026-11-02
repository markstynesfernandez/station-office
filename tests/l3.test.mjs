// l3.test.mjs — L3 (owner, 20–21/10/2026). Mock provider and stubs only: no network, no key, $0.
//   1 parallel lines: at most 1 running job per line and 2 in total (runtime.maxRunningJobs); a start on a busy line waits as next for
//     that line, one beyond the total waits as next; every spend check counts every running and queued job (the daily and line caps,
//     the Console estimate, the per-run / per-job / per-day reservations, the OpenRouter key's day); the E-STOP stops every job, Stop job
//     only its own; the spend dialog shows the other job; a routine starts alongside another line's job, waits as next on its own line,
//     and is skipped when the caps would not hold; the office seats an agent with a step in any running job at its desk
//   2 QA-DESIGN names the files: the "redraw" ids, checked against the set, refused once (tools); the line-level runs are in w2.test.mjs
//   3 scripts never start the scheduler: every script opens the engine through script-engine.mjs; a maintenance script starts no job,
//     a line script only its own; no routine fires, not even after an e-stop release
//   4 research tune (the first routine run on live, 21/10/2026): OPENED / NOT REACHABLE only for a URL the run fetched (refused on
//     write), at most 6 fetches a run for EVIDENCE-CHECKER, the keyword rule across the whole list, product fit (a draft for another
//     product is not written), a price in a title goes in the price cell; the prompts within their caps, the IP-rule lines word for word
//   L3.1 the research line's job cap, USD 1.00 (owner, 21/10/2026): the research routine starts beside a design job open at 6.00 (7.00 since W4); a second
//     design job waits as next; the guard refuses a research job's spend past 1.00
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, until, sleep, CAPS, PRICING } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { createHalt } from '../src/engine/halt.mjs';
import { createGuard, CapError } from '../src/engine/guard.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { buildAgentPrompt } from '../src/engine/prompts.mjs';
import { spendHtml } from '../src/web/ui/controls.js';
import { redrawIds, ToolError, createToolbox } from '../src/engine/tools/index.mjs';
import { validateScoutBrief, evidenceCheckProblems, NOT_REOPENED } from '../src/engine/lib/scout-brief.mjs';
import { createDryRunScript, JOB_A, JOB_B } from '../fixtures/engine/mock-script.mjs';
import { createScoutScript, researchBrief, researchQuery, listingUrl } from '../fixtures/engine/scout-script.mjs';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine'), CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const briefText = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
const DAY = dublinDay();
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const gate = () => { let open; const p = new Promise((res) => { open = res; }); return { p, open }; };

// ---- 1. parallel lines

// the dry-run lines on the mock, as an instance started by npm start (limitJobs: runtime.maxRunningJobs); hold(agent) keeps that agent's
// next model call waiting until release(agent), so two jobs are provably running at the same moment
function bootLines(t, { tag = 'l3', mockDelayMs = 0, limitJobs = true } = {}) {
  const r = tempRoot(tag), gates = {};
  const station = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const base = createDryRunScript({ cfg: station });
  const script = async (ctx, params) => { const g = gates[ctx.agentKey]; if (g) await g.p; return base(ctx, params); };
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, overrides: OVERRIDES, startScheduler: false, mockDelayMs, limitJobs });
  for (const id of [JOB_A, JOB_B]) r.J.put(path.join(r.dataRoot, 'research', 'briefs', id + '.md'), briefText(id));
  t.after(() => { for (const g of Object.values(gates)) g.open(); try { engine.close(); } catch (_) {} r.cleanup(); });
  const hold = (k) => (gates[k] = gate()), release = (k) => { const g = gates[k]; delete gates[k]; if (g) g.open(); };
  const job = (id) => engine.store.getJob(id);
  const startDesign = (id = JOB_A) => { const c = engine.orchestrator.createJob({ briefText: briefText(id), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; ')); return engine.orchestrator.startJob(id); };
  const startResearch = (line = 'research') => { const c = engine.orchestrator.createResearchJob({ line, by: 'test' }); return { id: c.id, run: engine.orchestrator.startJob(c.id) }; };
  const ended = (id) => until(() => { const j = job(id); return j && !engine.orchestrator.isActive(id) && j.state !== 'running' && !(j.state === 'queued' && j.data.autoStart) && j; }, { timeout: 30000 });
  return { engine, r, hold, release, job, startDesign, startResearch, ended };
}

test('1: a research job and a design job run at the same time; a second design job waits as next for its line; a third job beyond the total waits; both start by themselves', async (t) => {
  const { engine, hold, release, job, startDesign, startResearch, ended } = bootLines(t, { tag: 'l3par' });
  assert.equal(REAL.engine.runtime.maxRunningJobs, 2); assert.equal(engine.maxRunningJobs, 2);
  for (const l of Object.values(REAL.lines)) assert.equal(l.maxConcurrentJobs, 1, l.id + ': one job at a time on a line');
  hold('designer'); hold('demand-researcher');
  const pA = startDesign(JOB_A), R = startResearch();
  await until(() => engine.store.runningRuns().length === 2);
  assert.deepEqual([job(JOB_A).state, job(R.id).state], ['running', 'running']);
  assert.deepEqual(engine.orchestrator.active().sort(), [JOB_A, R.id].sort());
  // a second design job: its line is busy -> next for that line
  const cB = engine.orchestrator.createJob({ briefText: briefText(JOB_B), by: 'test' }); assert.ok(cB.ok);
  assert.equal(engine.orchestrator.startJob(JOB_B), null);
  assert.equal(job(JOB_B).state, 'queued'); assert.equal(job(JOB_B).data.nextFor, 'line');
  assert.match(job(JOB_B).reason, /^next: waiting for 2026-10-16--dry-run-mushroom-stickers \(one job at a time on the room1-digital line\)$/);
  // a third job on a free line, beyond the total of 2 -> next as before
  const S = startResearch('genre-scout');
  assert.equal(await S.run, null);
  assert.equal(job(S.id).data.nextFor, 'total'); assert.match(job(S.id).reason, /\(at most 2 jobs running at a time\)$/);
  // the office: an agent with a step in either running job sits at its desk; the lounge is for the others
  const snap = buildEngineSnapshot(engine), ag = (k) => snap.agents.find((a) => a.id === k);
  for (const k of ['designer', 'demand-researcher']) assert.deepEqual([ag(k).onStep, ag(k).place, ag(k).status], [true, 'desk', 'working'], k);
  for (const k of ['lister', 'qa-design', 'evidence-checker', 'trend-scout']) assert.deepEqual([ag(k).onStep, ag(k).place], [false, 'lounge'], k);
  assert.deepEqual(ag('designer').stepJobs, [JOB_A]); assert.deepEqual(ag('demand-researcher').currentJobs, [R.id]);
  assert.deepEqual(snap.jobLimit.running.sort(), [JOB_A, R.id].sort()); assert.deepEqual(snap.jobLimit.next.sort(), [JOB_B, S.id].sort());
  assert.deepEqual(snap.jobLimit.perLine, { 'ceo-memo': 1, 'coo-report': 1, 'eng-triage': 1, engineering: 1, 'genre-scout': 1, research: 1, 'room1-digital': 1 });
  // the research job ends: the genre-scout job takes the free place (JOB_B still waits for its own line)
  release('demand-researcher'); await R.run;
  await until(() => job(S.id).state !== 'queued');
  assert.equal(job(JOB_B).state, 'queued', 'the design line is still busy');
  release('designer'); await pA;
  await ended(JOB_B); await ended(S.id);
  assert.notEqual(job(JOB_B).state, 'queued'); assert.equal(job(JOB_B).data.next, false);
  assert.ok(engine.ledger.rows().every((x) => x.provider === 'mock' && x.usd === 0), 'mock: $0');
});

test('1: the daily cap refuses a start when the open jobs\' worst cases together would exceed it; the line cap and the Console estimate count them too; the dialog shows the other job', async (t) => {
  const { engine, hold, release, job, startDesign, ended } = bootLines(t, { tag: 'l3cap' });
  hold('designer');
  const pA = startDesign(JOB_A);
  await until(() => engine.store.runningRuns().length === 1);
  // the real caps: a research job (USD 1.00, L3.1) fits beside the open design job, 0 spent + 7 open + 1 this = 8 <= 10 (W4: the job cap is USD 7.00)
  const qr = engine.spend.quote('research', { text: 'woodland niches' });
  assert.deepEqual([qr.refusals, qr.day.openJobsUsd, qr.day.worstUsd], [[], 7, 8]); assert.ok(qr.token);
  // two 7.00 worst cases (the research line at the job cap, as before L3.1): 0 spent + 7 open + 7 this = 14 > 10
  engine.cfg.engine.caps.perJobUsdByLine = { ...engine.cfg.engine.caps.perJobUsdByLine, research: 7 };
  const q0 = engine.spend.quote('research', { text: 'woodland niches' });
  assert.equal(q0.token, null);
  assert.match(q0.refusals.join(' | '), /the daily cap would be exceeded: spent today USD 0\.00 \+ open jobs up to USD 7\.00 \+ this up to USD 7\.00 = USD 14\.00, over USD 10\.00/);
  assert.throws(() => engine.spend.gate('research', { text: 'woodland niches', confirmToken: 'x' }), (e) => e.code === 'CONFIRM_REQUIRED');
  // a day cap that fits two jobs: the research job starts alongside (another line), and the dialog shows the running job
  engine.cfg.engine.caps.perDayUsd = 14;
  const q = engine.spend.quote('research', { text: 'woodland niches' });
  assert.deepEqual(q.refusals, []); assert.ok(q.token);
  assert.deepEqual([q.queue.startsAsNext, q.queue.nextFor, q.day.openJobsUsd, q.day.worstUsd], [false, null, 7, 14]);
  assert.deepEqual(q.otherJobs, [{ id: JOB_A, line: 'room1-digital', lineLabel: 'Room 1 · digital', state: 'running', step: 'designer', spentUsd: 0, capUsd: 7, worstUsd: 7 }]);
  const html = spendHtml(q);
  assert.match(html, /<span class="m">other job<\/span><span><span class="mono">2026-10-16--dry-run-mushroom-stickers<\/span> · Room 1 · digital · running at designer · spent USD 0\.0000 · worst case still open USD 7\.00<\/span>/);
  assert.match(html, /this month USD 0\.00 \+ open jobs up to USD 7\.00 \+ this up to USD 7\.00 = USD 14\.00/);
  // the same line: the line's day cap counts the open job too; within it, the start waits as next for its line
  const q1 = engine.spend.assess('start-line', { file: JOB_B + '.md' });
  assert.match(q1.refusals.join(' | '), /the room1-digital line's daily cap would be exceeded: USD 14\.00 worst case, over USD 10\.00/);
  engine.cfg.engine.caps.perLineDayUsd = { default: 14 };
  const q2 = engine.spend.assess('start-line', { file: JOB_B + '.md' });
  assert.deepEqual(q2.refusals, []); assert.deepEqual([q2.queue.startsAsNext, q2.queue.nextFor], [true, 'line']);
  assert.match(spendHtml(q2), /waits as <b>next<\/b> for its line: the Room 1 · digital line runs one job at a time/);
  // the Console's monthly estimate: this month + every open job's worst case + this one
  engine.cfg.engine.outerLimits = { ...engine.cfg.engine.outerLimits, anthropicConsoleMonthlyUsd: 13 };
  const q3 = engine.spend.assess('research', { text: 'woodland niches' });
  assert.deepEqual([q3.console.usedUsd, q3.console.openJobsUsd, q3.console.worstUsd, q3.console.leftAfterWorstUsd], [0, 7, 14, -1]);
  assert.match(q3.refusals.join(' | '), /the Anthropic Console's monthly limit could be passed \(estimate from the station ledger\): this month USD 0\.00 \+ open jobs up to USD 7\.00 \+ this up to USD 7\.00 = USD 14\.00, over USD 13\.00/);
  // the token taken before the limit changed is refused at the gate with the reason
  assert.throws(() => engine.spend.gate('research', { text: 'woodland niches', confirmToken: q.token }), (e) => e.code === 'DAY_CAP' && /Console's monthly limit/.test(e.message));
  release('designer'); await pA; await ended(JOB_A);
  assert.equal(job(JOB_A).state === 'running', false);
});

test('1: two jobs reserving at the same moment never overshoot a cap and are never counted twice (per run, per job, per day)', async (t) => {
  const r = tempRoot('l3guard'), ledger = createLedger({ J: r.J, log: r.log }), halt = createHalt({ J: r.J, log: r.log });
  t.after(() => { halt.close(); r.cleanup(); });
  const guard = createGuard({ J: r.J, ledger, halt, caps: { ...CAPS, perRunUsd: 5, perJobUsd: 0.7, perDayUsd: 1 }, pricing: PRICING, log: r.log });
  // one call: 10,000 tokens in at USD 1/M + 10,000 out at USD 5/M = USD 0.06 reserved, settled at the same
  let peak = 0, refused = { perDay: 0, perJob: 0 }, made = 0;
  async function worker(jobId) {
    for (let i = 0; i < 25; i++) {
      let res;
      try { res = guard.reserve({ provider: 'test', model: 'cheap-model', kind: 'text', runId: jobId + '-' + i, jobId, line: jobId === 'A' ? 'room1-digital' : 'research', inputTokens: 10000, maxOutputTokens: 10000 }); }
      catch (e) { assert.ok(e instanceof CapError, String(e)); refused[e.cap] = (refused[e.cap] || 0) + 1; await sleep(1); continue; }
      const st = guard.status(); peak = Math.max(peak, st.spentToday + st.reservedNow);
      await sleep(Math.floor(Math.random() * 4));
      guard.settle(res, { usage: { input_tokens: 10000, output_tokens: 10000 } }); made++;
    }
  }
  await Promise.all([worker('A'), worker('B'), worker('A')]);
  const day = dublinDay();
  assert.ok(peak <= 1 + 1e-9, 'spent + reserved never above the day cap: ' + peak);
  assert.ok(ledger.spent.day(day) <= 1 + 1e-9 && ledger.spent.job('A') <= 0.7 + 1e-9 && ledger.spent.job('B') <= 0.7 + 1e-9);
  assert.ok(refused.perDay + refused.perJob > 0, 'the caps refused the calls that would pass them');
  assert.equal(guard.status().reservedNow, 0); assert.equal(guard.reservations().length, 0);
  assert.equal(r6(ledger.rows().reduce((s, x) => s + x.usd, 0)), r6(ledger.spent.day(day)), 'every call counted once');
  assert.equal(r6(ledger.spent.job('A') + ledger.spent.job('B')), r6(ledger.spent.day(day)));
  assert.equal(ledger.rows().length, made);
});

test('1: the OpenRouter key\'s USD 2/day is counted across every job: their image rows of the day plus the reservations in flight', (t) => {
  const r = tempRoot('l3or'), ledger = createLedger({ J: r.J, log: r.log }), halt = createHalt({ J: r.J, log: r.log });
  t.after(() => { halt.close(); r.cleanup(); });
  assert.equal(REAL.engine.outerLimits.openrouterDailyUsd, 2, 'the owner\'s limit is unchanged');
  const pricing = { ...PRICING, openrouter: { models: { img: { perImage: 0.08 } } } };
  const guard = createGuard({ J: r.J, ledger, halt, caps: { ...CAPS, perRunUsd: 5, perJobUsd: 5, perDayUsd: 10 }, pricing, log: r.log, outerLimits: { openrouterDailyUsd: 0.2 } });
  const img = (jobId) => guard.reserve({ provider: 'openrouter', model: 'img', kind: 'image', count: 1, runId: 'r-' + jobId + Math.random(), jobId, line: 'room1-digital' });
  const a1 = img('A'), b1 = img('B');   // 0.16 in flight, two jobs
  assert.throws(() => img('A'), (e) => e instanceof CapError && e.cap === 'openrouterDay' && /0\.20 reached \(spent 0\.16, next call up to 0\.08\)/.test(e.message));
  guard.settle(a1, { usd: 0.05 });       // 0.05 spent + 0.08 in flight
  assert.throws(() => img('B'), (e) => e.cap === 'openrouterDay');
  guard.settle(b1, { usd: 0.05 });
  const a2 = img('A'); guard.release(a2, 'test');
  assert.deepEqual([guard.openrouterDay().usedUsd, guard.openrouterDay().reservedUsd, guard.openrouterDay().limitUsd], [0.1, 0, 0.2]);
  // a text call is not counted against the key's day
  guard.release(guard.reserve({ provider: 'test', model: 'cheap-model', kind: 'text', runId: 't', jobId: 'A', inputTokens: 10, maxOutputTokens: 10 }), 'test');
});

test('1: the E-STOP stops every running job; Stop job stops only its own', async (t) => {
  const { engine, job, startDesign, startResearch } = bootLines(t, { tag: 'l3stop', mockDelayMs: 4000 });
  const pA = startDesign(JOB_A), R1 = startResearch();
  await until(() => engine.store.runningRuns().length === 2, { timeout: 10000 });
  engine.orchestrator.stopJob(R1.id, { expectedVersion: job(R1.id).version });
  await R1.run;
  assert.equal(job(R1.id).state, 'stopped'); assert.match(job(R1.id).reason, /stopped by the owner/);
  assert.equal(job(JOB_A).state, 'running', 'the other job runs on'); assert.ok(engine.orchestrator.isActive(JOB_A));
  // another research job alongside, then the E-STOP: both stop
  const R2 = startResearch();
  await until(() => engine.store.runningRuns().length === 2, { timeout: 10000 });
  engine.halt.press({ by: 'test', reason: 'L3' });
  await Promise.all([pA, R2.run]);
  for (const id of [JOB_A, R2.id]) { assert.equal(job(id).state, 'stopped', id); assert.match(job(id).reason, /e-stop/, id); }
  assert.equal(engine.orchestrator.active().length, 0);
  assert.equal(engine.store.runningRuns().length, 0);
});

test('1: routines: a firing starts alongside another line\'s job, waits as next on its own line, and is skipped when the caps would not hold', async (t) => {
  const { engine, hold, release, job, startDesign, ended } = bootLines(t, { tag: 'l3rt' });
  const mk = (id) => { engine.store.insertRoutine({ id, name: id, target: 'line:research', input: '', schedule: '0 9 * * *', max_runs_per_day: 5, per_run_cap_usd: null }); return engine.store.setRoutineEnabled(id, true, { expectedVersion: engine.store.getRoutine(id).version }); };
  const researchJobs = () => engine.store.listJobs().filter((j) => j.line === 'research');
  hold('designer');
  const pA = startDesign(JOB_A);
  await until(() => engine.store.runningRuns().length === 1);
  // a firing whose worst case would not fit next to the open design job is skipped with the reason; nothing is created (the research
  // line at the job cap, as before L3.1: 7 + 7 = 14 > 10; at the real USD 1.00 it starts: the L3.1 test below)
  engine.cfg.engine.caps.perJobUsdByLine = { ...engine.cfg.engine.caps.perJobUsdByLine, research: 7 };
  const skip = await engine.scheduler.fire(mk('rt_real'));
  assert.match(skip.skipped, /^the start would not fit: the daily cap would be exceeded: spent today USD 0\.00 \+ open jobs up to USD 7\.00 \+ this up to USD 7\.00 = USD 14\.00, over USD 10\.00/);
  assert.equal(researchJobs().length, 0); assert.match(engine.store.getRoutine('rt_real').last_status, /^skipped: the start would not fit/);
  // caps that hold two jobs: the firing starts alongside the design job
  engine.cfg.engine.caps.perDayUsd = 100; engine.cfg.engine.caps.perLineDayUsd = { default: 100 };
  hold('demand-researcher');
  const f1 = engine.scheduler.fire(mk('rt_a'));
  await until(() => engine.store.runningRuns().length === 2);
  const [r1] = researchJobs();
  assert.deepEqual([job(JOB_A).state, r1.state, r1.data.routineId], ['running', 'running', 'rt_a']);
  // another research routine while that one runs: it waits as next for the research line
  await engine.scheduler.fire(mk('rt_b'));
  const r2 = researchJobs().find((j) => j.id !== r1.id);
  assert.equal(r2.state, 'queued'); assert.equal(r2.data.nextFor, 'line'); assert.match(r2.reason, /one job at a time on the research line/);
  release('demand-researcher'); await f1;
  await ended(r2.id);
  assert.notEqual(job(r2.id).state, 'queued', 'started by itself when the first research job ended');
  release('designer'); await pA;
});

// ---- L3.1 (owner, 21/10/2026): the research line's job cap, USD 1.00 (caps.perJobUsdByLine.research)

test('L3.1: the real caps: a design job open at its worst case (7.00, W4) and the research routine fires: the research job starts (8.00 of 10.00); a second design job waits as next for its line, and the dialog refuses one (15.00)', async (t) => {
  const { engine, hold, release, job, startDesign, ended } = bootLines(t, { tag: 'l31' });
  const C = engine.cfg.engine.caps;
  assert.deepEqual([C.perJobUsd, C.perDayUsd, C.perJobUsdByLine.research, C.perJobUsdByLine['genre-scout']], [7, 10, 1, 0.5], 'the real caps, unchanged by this test');
  engine.store.insertRoutine({ id: 'rt_wk', name: 'weekday research', target: 'line:research', input: '', schedule: '0 9 * * 1-5', max_runs_per_day: 1, per_run_cap_usd: null });
  const rt = engine.store.setRoutineEnabled('rt_wk', true, { expectedVersion: engine.store.getRoutine('rt_wk').version });
  hold('designer'); hold('demand-researcher');
  const pA = startDesign(JOB_A);
  await until(() => engine.store.runningRuns().length === 1);
  const before = engine.spend.startCheck({ line: 'research', headroomUsd: 1 });
  assert.deepEqual([before.committed, before.worst, before.refusals], [7, 8, []]);
  const f = engine.scheduler.fire(rt);
  await until(() => engine.store.runningRuns().length === 2);
  const [r1] = engine.store.listJobs().filter((j) => j.line === 'research');
  assert.deepEqual([job(JOB_A).state, r1.state, r1.data.routineId], ['running', 'running', 'rt_wk'], 'started, not skipped');
  assert.doesNotMatch(engine.store.getRoutine('rt_wk').last_status || '', /^skipped/);
  // a second design job: the spend dialog refuses it (7 + 1 open + 7 = 15.00 over the 10.00 day cap; the line's day cap 14.00 too)
  const q = engine.spend.assess('start-line', { file: JOB_B + '.md' });
  assert.match(q.refusals.join(' | '), /the daily cap would be exceeded: spent today USD 0\.00 \+ open jobs up to USD 8\.00 \+ this up to USD 7\.00 = USD 15\.00, over USD 10\.00/);
  // started on the engine's own path, it still waits as next for its line (one job at a time on a line), not beside the open one
  const c = engine.orchestrator.createJob({ briefText: briefText(JOB_B), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; '));
  await engine.orchestrator.startJob(JOB_B);
  assert.deepEqual([job(JOB_B).state, job(JOB_B).data.nextFor], ['queued', 'line']);
  release('demand-researcher'); await f; await ended(r1.id);
  release('designer'); await pA; await ended(JOB_A); await ended(JOB_B);
});

test('L3.1: a research job is refused any spend past USD 1.00 (the guard: perJob[research]); a design job beside it keeps the USD 7.00 cap (W4)', (t) => {
  const r = tempRoot('l31guard'), ledger = createLedger({ J: r.J, log: r.log }), halt = createHalt({ J: r.J, log: r.log });
  t.after(() => { halt.close(); r.cleanup(); });
  const guard = createGuard({ J: r.J, ledger, halt, caps: REAL.engine.caps, pricing: PRICING, log: r.log });
  // one call: 10,000 tokens in at USD 1/M + 10,000 out at USD 5/M = USD 0.06, each in its own run (the per-run cap is not the limit)
  const call = (jobId, line, i) => { const res = guard.reserve({ provider: 'test', model: 'cheap-model', kind: 'text', runId: jobId + '-' + i, jobId, line, inputTokens: 10000, maxOutputTokens: 10000 }); guard.settle(res, { usage: { input_tokens: 10000, output_tokens: 10000 } }); };
  let n = 0, refusal = null;
  for (; n < 30; n++) { try { call('R', 'research', n); } catch (e) { refusal = e; break; } }
  assert.ok(refusal instanceof CapError, String(refusal));
  assert.deepEqual([refusal.cap, refusal.limit, n, r6(ledger.spent.job('R'))], ['perJob[research]', 1, 16, 0.96]);
  assert.match(refusal.message, /^cap: perJob\[research\] 1\.00 reached \(spent 0\.96, next call up to 0\.06\)/);
  assert.ok(ledger.spent.job('R') <= 1 + 1e-9);
  for (let i = 0; i < 20; i++) call('D', 'room1-digital', i);
  assert.equal(r6(ledger.spent.job('D')), 1.2, 'the design job passes 1.00: its cap is perJob 7.00');
});

// ---- 2. QA-DESIGN names the files (the line-level runs: tests/w2.test.mjs)

test('2: a revise names the files to redraw as file ids from the set; none, an unknown id or file 01 is refused (once), with the reason', async (t) => {
  const files = { set: 4, ids: ['01-steaming-mug', ...Array.from({ length: 11 }, (_, i) => String(i + 2).padStart(2, '0') + '-prop-' + (i + 2))], redrawable: Array.from({ length: 11 }, (_, i) => String(i + 2).padStart(2, '0') + '-prop-' + (i + 2)) };
  assert.deepEqual(redrawIds(['10-prop-10', '03-prop-3.png', 'set-v4/raw/07-prop-7.png', '10-prop-10'], files), { ids: ['03-prop-3', '07-prop-7', '10-prop-10'] });
  assert.match(redrawIds(undefined, files).problem, /^no "redraw" field: a revise names the files to redraw in "redraw": a list of file ids \(NN-subject, e\.g\. 10-wooden-sled\) from set-v4$/);
  assert.match(redrawIds([], files).problem, /^no file id in "redraw"/);
  assert.match(redrawIds(['10-wooden-sled'], files).problem, /^not a file of set-v4: "10-wooden-sled"/);
  assert.match(redrawIds(['01-steaming-mug'], files).problem, /^01-steaming-mug is the approved style reference and is never redrawn here: name only files 02–12$/);
  // through submit_verdict: refused once with the reason, then recorded with redrawProblem (the orchestrator blocks the job)
  const r = tempRoot('l3verdict');
  t.after(() => r.cleanup());
  const id = '2026-10-21--l3-props', folder = path.join(r.dataRoot, 'jobs', id);
  r.J.put(path.join(folder, 'set-v4', 'deliverables.sha256'), 'x\n');
  for (const n of files.ids) r.J.put(path.join(folder, 'set-v4', 'raw', n + '.png'), 'png');
  let verdict = null;
  const box = createToolbox({ J: r.J, folder, agent: { key: 'qa-design', name: 'QA-DESIGN', tools: ['submit_verdict'], limits: {}, verdict: 'design' }, job: { id, kind: 'line', data: {} }, cfg: { ...REAL, engine: REAL.engine }, guard: null, providers: { mode: 'mock' }, run: { runId: 'r' }, halt: { isHalted: () => false }, log: r.log, bus: { emit() {} }, verdictFiles: files, onVerdict: (v) => { verdict = v; } });
  const rec = (extra) => ({ record: { stage: 'design', listingId: id, verdict: 'revise', designFile: 'set-v4/deliverables.json', checks: { usable: 'fail' }, reasons: ['10-prop-10: the runners are cut off'], ...extra } });
  {
    // latestSet reads the set folders: set-v4 is the newest
    await assert.rejects(box.call('submit_verdict', rec({})), (e) => e instanceof ToolError && /^QA record refused \(this happens once\): no "redraw" field/.test(e.message) && /The file ids of set-v4 you may name: 02-prop-2, .*12-prop-12\./.test(e.message));
    assert.equal(verdict, null);
    const out = await box.call('submit_verdict', rec({ redraw: ['99-nope'] }));
    assert.match(out, /^verdict recorded: revise/);
    assert.deepEqual([verdict.redraw, verdict.redrawGiven], [[], ['99-nope']]); assert.match(verdict.redrawProblem, /^not a file of set-v4: "99-nope"/);
  }
});

// ---- 3. maintenance scripts never start the scheduler

test('3: every script that opens the engine goes through script-engine.mjs; none calls createEngine itself', () => {
  const dir = path.join(APP_ROOT, 'scripts'), opened = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(s, /\bcreateEngine\s*\(/, f + ' opens the engine without the script lock');
    assert.doesNotMatch(s, /from '\.\.\/src\/engine\/engine\.mjs'/, f);
    if (/openScriptEngine\(/.test(s)) opened.push(f);
  }
  for (const f of ['settle-failed.mjs', 'settle-images.mjs', 'owner.mjs', 'owner-brief.mjs', 'line-live.mjs', 'scout-live.mjs', 'smoke-live.mjs', 'blocklist-hygiene.mjs', 'dry-run.mjs', 'dry-run-scout.mjs', 'demo.mjs']) assert.ok(opened.includes(f), f);
  // the maintenance scripts start no job at all
  for (const f of ['settle-failed.mjs', 'settle-images.mjs', 'owner-brief.mjs', 'smoke-live.mjs', 'blocklist-hygiene.mjs']) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /startsJobs: true/, f);
});

test('3: a maintenance script\'s engine: no scheduler (not even after an e-stop release), no routine, no resumed job, no job start', async (t) => {
  const r = tempRoot('l3maint');
  t.after(() => r.cleanup());
  // a job left running by a stopped Station and an enabled routine on the data root
  const e0 = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false, resume: false });
  e0.store.insertJob({ id: '2026-10-21--research-1', line: 'research', kind: 'research', title: 'Research batch 1', state: 'running', step: 'demand-researcher', data: { day: DAY, input: 'x', createdBy: 'test' } });
  e0.store.insertRoutine({ id: 'rt_x', name: 'research', target: 'line:research', input: '', schedule: '* * * * *', max_runs_per_day: 5, per_run_cap_usd: null });
  e0.store.setRoutineEnabled('rt_x', true, { expectedVersion: e0.store.getRoutine('rt_x').version });
  e0.close();
  const e = openScriptEngine({ archiveSandbox: true, J: r.J, log: r.log, purpose: 'settle:failed', startScheduler: true, resume: true });   // a caller cannot turn them back on
  t.after(() => { try { e.close(); } catch (_) {} });
  assert.deepEqual(e.scriptRun && [e.scriptRun.purpose, e.scriptRun.startsJobs], ['settle:failed', false]);
  assert.equal(e.scheduler.started, false); assert.match(e.scheduler.locked, /^script: settle:failed$/);
  e.scheduler.start(); assert.equal(e.scheduler.started, false); assert.deepEqual(e.scheduler.armed(), []);
  e.halt.press({ by: 'test' }); e.halt.resume({ by: 'test', confirm: 'RESUME' });
  assert.equal(e.scheduler.started, false, 'an e-stop release does not start it');
  assert.match((await e.scheduler.fire(e.store.getRoutine('rt_x'))).skipped, /the scheduler is locked/);
  await assert.rejects(e.runRoutine(e.store.getRoutine('rt_x')), /no routine runs in an engine opened by a script/);
  // the interrupted job is marked for the Station's next start, never started here
  const j = e.store.getJob('2026-10-21--research-1');
  assert.equal(j.state, 'queued'); assert.match(j.reason, /^interrupted by an engine restart/); assert.equal(e.orchestrator.isActive(j.id), false);
  assert.throws(() => e.orchestrator.startJob(j.id), (x) => x.code === 'SCRIPT' && /no job starts from this script \(settle:failed\)/.test(x.message));
  assert.throws(() => e.orchestrator.startResearch('woodland niches'), (x) => x.code === 'SCRIPT');
  await sleep(50); assert.equal(e.store.runningRuns().length, 0); assert.equal(e.ledger.rows().length, 0);
});

test('3: a line script starts only its own job: a queued "next" job it did not start stays queued when its job ends', async (t) => {
  const r = tempRoot('l3own');
  t.after(() => r.cleanup());
  const station = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const e = openScriptEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createDryRunScript({ cfg: station }), overrides: OVERRIDES, purpose: 'line:live', startsJobs: true });
  t.after(() => { try { e.close(); } catch (_) {} });
  // a research job the Station had queued as next (not this script's)
  const other = e.orchestrator.createResearchJob({ by: 'station' }).id;
  e.store.updateJob(other, { reason: 'next: waiting', data: { autoStart: true, next: true, queuedAt: Date.now() - 1000 } });
  r.J.put(path.join(r.dataRoot, 'research', 'briefs', JOB_A + '.md'), briefText(JOB_A));
  const c = e.orchestrator.createJob({ briefText: briefText(JOB_A), by: 'test' }); assert.ok(c.ok);
  const done = await e.orchestrator.startJob(JOB_A);
  assert.notEqual(done.state, 'queued');
  await sleep(100);
  assert.equal(e.store.getJob(other).state, 'queued', 'not started by the script'); assert.equal(e.orchestrator.isActive(other), false);
  assert.equal(e.scheduler.started, false);
});

// ---- 4. research tune (the first routine run on live, 21/10/2026)

const LOFI = { slug: 'lofi-study', genre: 'lofi study', segment: 'students who stream study sessions', props: 'a desk lamp, a stack of notebooks, a mug of tea, a cassette player, a potted fern and a sleeping cat bed', palette: 'dusty rose, cream and teal', price: 9 };
const FILE = DAY + '--genre-lofi-study-desk-props.md';
// the research line on the mock: DEMAND-RESEARCHER searches once and writes `draft`; EVIDENCE-CHECKER runs `checker` (or the fixture's)
function bootResearch(t, draft, { checker = null } = {}) {
  const r = tempRoot('l3res'), base = createScoutScript(), results = { dr: [], ec: [] };
  const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };
  const script = (ctx, params) => {
    const n = params.messages.filter((m) => m.role === 'assistant').length;
    if (ctx.agentKey === 'demand-researcher') {
      results.dr.push(...lastResults(params));
      return n === 0 ? { content: [{ type: 'tool_use', id: 'tu_s', name: 'web_search', input: { query: researchQuery(LOFI) } }] }
        : n === 1 ? { content: [{ type: 'tool_use', id: 'tu_d', name: 'fs_write', input: { path: 'drafts/' + DAY + '/' + FILE, content: draft } }] } : { content: [{ type: 'text', text: 'done' }] };
    }
    if (ctx.agentKey === 'evidence-checker' && checker) { results.ec.push(...lastResults(params)); return checker(n, params); }
    return base(ctx, params);
  };
  script.web = base.web;
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r, results };
}
const runResearch = async (e) => { const c = e.orchestrator.createResearchJob({ by: 'test' }); await e.orchestrator.startJob(c.id); return e.store.getJob(c.id); };
const tu = (id, name, input) => ({ content: [{ type: 'tool_use', id: 'tu_' + id, name, input }] });
const withCheck = (draft, lines) => draft.replace(/^status: candidate$/m, 'status: verified').replace(/\s*$/, '\n\n## Evidence check\n' + lines.join('\n') + '\nVerdict: VERIFIED — the cited results show the product and its prices\n');

test('4: EVIDENCE-CHECKER: a source marked NOT REACHABLE or OPENED that the run did not fetch is refused on write with the reason; after it fetched the URL the same write goes through', async (t) => {
  const u1 = listingUrl(LOFI.slug, 1), draft = researchBrief(DAY, LOFI);
  const others = [2, 3, 4, 5].map((i) => '- ' + listingUrl(LOFI.slug, i) + ': ' + NOT_REOPENED + ', supports claim: YES');
  const bad = withCheck(draft, ['- ' + u1 + ': NOT REACHABLE in this run, supports claim: PARTLY', ...others]);
  const good = withCheck(draft, ['- ' + u1 + ': OPENED, supports claim: YES', ...others]);
  const path1 = 'drafts/' + DAY + '/' + FILE;
  const { e, results } = bootResearch(t, draft, { checker: (n) => [tu('w1', 'fs_write', { path: path1, content: bad }), tu('f1', 'web_fetch', { url: u1 }), tu('w2', 'fs_write', { path: path1, content: bad }), tu('w3', 'fs_write', { path: path1, content: good }), { content: [{ type: 'text', text: 'checked' }] }][Math.min(n, 4)] });
  const j = await runResearch(e);
  const w1 = results.ec.find((x) => x.tool_use_id === 'tu_w1'), f1 = results.ec.find((x) => x.tool_use_id === 'tu_f1'), w2 = results.ec.find((x) => x.tool_use_id === 'tu_w2'), w3 = results.ec.find((x) => x.tool_use_id === 'tu_w3');
  assert.equal(w1.is_error, true);
  assert.match(String(w1.content), new RegExp('was NOT written\\. Evidence check: ' + u1.replace(/[.]/g, '\\.') + ' is marked NOT REACHABLE, but this run did not fetch it\\. Mark a source OPENED or NOT REACHABLE only after you fetched it in this run'));
  assert.match(String(w1.content), /write "not re-opened; URL and price checked by the station against this job's search results"/);
  assert.ok(!f1.is_error, String(f1.content));
  assert.ok(!w2.is_error && !w3.is_error, 'tried in this run: NOT REACHABLE and OPENED are both accepted for it');
  assert.equal(j.state, 'research-done', j.reason); assert.match(j.reason, /lofi-study-desk-props\.md: verified -> briefs\//);
  // the pure rule: "not re-opened" is no claim; "OPENED / NOT REACHABLE" (the 21/10 draft's template copy) is
  assert.deepEqual(evidenceCheckProblems(withCheck(draft, others), new Set()), []);
  assert.match(evidenceCheckProblems(withCheck(draft, ['- ' + u1 + ': OPENED / NOT REACHABLE — see note, supports claim: PARTLY']), new Set()).join(), /is marked OPENED \/ NOT REACHABLE, but this run did not fetch it/);
});

test('4: EVIDENCE-CHECKER fetches at most 6 URLs a run (engine-enforced, inside its 15 web calls), and only URLs this job\'s searches returned', async (t) => {
  const cfgEc = REAL.agents['evidence-checker'];
  assert.deepEqual([cfgEc.limits.maxWebFetches, cfgEc.limits.maxWebCalls], [6, 15]); assert.ok(cfgEc.tools.includes('web_fetch'));
  const u1 = listingUrl(LOFI.slug, 1);
  const { e, results } = bootResearch(t, researchBrief(DAY, LOFI), { checker: (n) => (n === 0 ? { content: Array.from({ length: 7 }, (_, i) => ({ type: 'tool_use', id: 'tu_f' + i, name: 'web_fetch', input: { url: u1 } })) } : n === 1 ? tu('g', 'web_fetch', { url: 'https://example.org/made-up' }) : { content: [{ type: 'text', text: 'done' }] }) });
  await runResearch(e);
  const f = (i) => results.ec.find((x) => x.tool_use_id === 'tu_f' + i);
  for (let i = 0; i < 6; i++) assert.ok(!f(i).is_error, 'fetch ' + (i + 1));
  assert.equal(f(6).is_error, true); assert.match(String(f(6).content), /^web_fetch limit for this run reached \(6 fetches, enforced by the engine\): for every other source write "not re-opened; URL and price checked by the station against this job's search results"$/);
  assert.match(String(results.ec.find((x) => x.tool_use_id === 'tu_g').content), /was not returned by any web search in this job/);
});

test('4: the keyword rule is across the whole Keywords list (at least 3 distinct cited results), not 3 per keyword; the orders say it that way', () => {
  const b = researchBrief(DAY, LOFI), kw = (lines) => b.replace(/## Keywords\n[\s\S]*?\n\n/, '## Keywords\n' + lines.join('\n') + '\n\n');
  const u = (i) => listingUrl(LOFI.slug, i);
  // five keywords, one cited result each, three distinct across the list: passes
  const ok = kw(['- lofi desk props — ' + u(1), '- pngtuber props — ' + u(2), '- stream desk props png — ' + u(3), '- vtuber desk assets — ' + u(1), '- lofi stream overlay — ' + u(2)]);
  assert.deepEqual(validateScoutBrief(ok, { day: DAY, agent: true, origin: 'research' }).problems, []);
  // two distinct across the list: refused, by the list
  const two = kw(['- lofi desk props — ' + u(1), '- pngtuber props — ' + u(2), '- stream desk props png — ' + u(1), '- vtuber desk assets — ' + u(2), '- lofi stream overlay — ' + u(1)]);
  assert.match(validateScoutBrief(two, { day: DAY, agent: true, origin: 'research' }).problems.join(' | '), /Keywords: supported by 2 distinct cited result\(s\), needs at least 3/);
  const ec = buildAgentPrompt(REAL.agents['evidence-checker'], { promptsDir: PROMPTS, budgets: REAL.station.promptBudgetChars }).text;
  assert.match(ec, /the Keywords list as a whole cites at least 3 distinct results \(the station rule: across the whole list, not 3 per keyword; each keyword needs one cited result\)/);
  assert.doesNotMatch(ec, /the keywords and the price range each rest on at least 3 cited results/);
});

test('4: product fit: a draft whose evidence is for a different product is not written (no brief); the orders say where the evidence comes from', async (t) => {
  const b = researchBrief(DAY, LOFI);
  assert.deepEqual(validateScoutBrief(b, { day: DAY, agent: true, origin: 'research' }).problems, [], 'the fixture brief says product fit: same product');
  const fit = (s) => b.replace(/^product fit: .*$/m, s);
  const missing = validateScoutBrief(fit(''), { day: DAY, agent: true, origin: 'research' }).problems.join(' | ');
  assert.match(missing, /Demand evidence: "product fit: same product — <how the cited results sell or discuss that product>" missing: the demand evidence must be for pngtuber-prop-pack itself \(what that entry delivers and who buys it\), from non-Etsy places that sell or discuss that product; with evidence only for a different product, write no brief \(report_blocked\)/);
  assert.match(validateScoutBrief(fit('product fit: different product — planner sticker sets'), { day: DAY, agent: true, origin: 'research' }).problems.join(' | '), /product fit "different product — planner sticker sets": the demand evidence must be for pngtuber-prop-pack itself/);
  // the 21/10 draft's own admission in its Risks
  const admits = b.replace(/## Risks\n.*\n/, '## Risks\n- Price and demand evidence is for sticker sets for planner apps, not PNGTuber/VTuber desk props; the buyer segment does not match the product.\n');
  assert.match(validateScoutBrief(admits, { day: DAY, agent: true, origin: 'research' }).problems.join(' | '), /the brief says its evidence is for another product \("does not match the product"\)/);
  // intake and brief-check of older briefs are unchanged (agent writes only)
  assert.equal(validateScoutBrief(fit(''), { day: DAY, origin: 'research' }).problems.some((p) => /product fit/.test(p)), false);
  // on the mock line: DEMAND-RESEARCHER writes the mismatched draft; it is refused and never written; no brief comes out
  const { e, results, r } = bootResearch(t, fit('product fit: different product — planner sticker sets'));
  const j = await runResearch(e);
  const w = results.dr.find((x) => x.tool_use_id === 'tu_d');
  assert.equal(w.is_error, true); assert.match(String(w.content), /^brief schema: drafts\/.*was NOT written/);
  assert.equal(fs.existsSync(path.join(r.dataRoot, 'research', 'drafts', DAY, FILE)), false);
  assert.equal(fs.existsSync(path.join(r.dataRoot, 'research', 'briefs', FILE)), false);
  assert.equal(j.state, 'research-done'); assert.match(j.reason, /^no drafts for /);
  const dr = buildAgentPrompt(REAL.agents['demand-researcher'], { promptsDir: PROMPTS, budgets: REAL.station.promptBudgetChars }).text;
  assert.match(dr, /PRODUCT FIT: the demand evidence must be for the product in products\.json itself \(what that entry delivers and who buys it\), found in non-Etsy places that sell or discuss that product: other marketplaces and creator shops for digital stream assets, editorial roundups, and community discussion of streaming setups\. With evidence only for a different product, write no brief/);
  const ec = buildAgentPrompt(REAL.agents['evidence-checker'], { promptsDir: PROMPTS, budgets: REAL.station.promptBudgetChars }).text;
  assert.match(ec, /evidence for a different product: REJECTED, naming the mismatch/);
});

test('4: a row whose title cell shows a price never says "no price": refused on an agent\'s write; the format says where the price goes', () => {
  const b = researchBrief(DAY, LOFI);
  const row4 = b.replace(/^\| 4 \| [^|]+\| [^|]+\|/m, '| 4 | Best desk props of 2026 (article; shows some packs at USD 1.99) | no price |');
  assert.match(validateScoutBrief(row4, { day: DAY, agent: true, origin: 'research' }).problems.join(' | '), /Demand evidence row 4: the title shows a price, so the price cell may not say "no price": put the price there as shown/);
  assert.match(validateScoutBrief(b.replace(/^\| 5 \| [^|]+\| [^|]+\|/m, '| 5 | Stream prop packs (tag page; packs from about $3 to 17) | no price |'), { day: DAY, agent: true, origin: 'research' }).problems.join(' | '), /row 5: the title shows a price/);
  assert.equal(validateScoutBrief(row4, { day: DAY, origin: 'research' }).problems.some((p) => /title shows a price/.test(p)), false, 'not at intake');
  const fmt = fs.readFileSync(path.join(PROMPTS, 'skills', 'scout-brief-format.md'), 'utf8');
  assert.match(fmt, /`no price` only when the result shows none \(an article or a discussion\)\. A price the result shows goes in the price cell, never only in the title\./);
  const ec = buildAgentPrompt(REAL.agents['evidence-checker'], { promptsDir: PROMPTS, budgets: REAL.station.promptBudgetChars }).text;
  assert.match(ec, /A row whose title shows a price but whose price cell says `no price`: REJECTED/);
});

test('4: the prompts stay within their caps; the IP-rule lines word for word; QA-DESIGN within its 10,500 target and asks for "redraw"', () => {
  const budgets = REAL.station.promptBudgetChars, P = Object.fromEntries(['trend-scout', 'demand-researcher', 'evidence-checker', 'qa-design'].map((k) => [k, buildAgentPrompt(REAL.agents[k], { promptsDir: PROMPTS, budgets })]));
  assert.ok(P['demand-researcher'].chars <= 16000 && P['trend-scout'].chars <= 16000, 'the 16,000-char clamp');
  assert.ok(P['evidence-checker'].chars <= 14000);
  assert.ok(P['qa-design'].chars <= budgets.targets['qa-design'], 'qa-design ' + P['qa-design'].chars);
  assert.match(P['qa-design'].text, /"redraw": \["revise only: each file id to redraw, e\.g\. 10-wooden-sled"\]/);
  const dr = fs.readFileSync(path.join(PROMPTS, 'agents', 'demand-researcher.md'), 'utf8');
  assert.ok(dr.includes('   - Design direction = ORIGINAL concepts in plain words: no reference to protected IP (brands, logos, characters, franchises, teams, celebrities, lyrics, quotes, well-known slogans, a named artist\'s style, or "inspired by" a product or listing). A brief that fails this is rejected by a station script.'));
  const ec = P['evidence-checker'].text;
  assert.match(ec, /At most 15 web calls per run in total, at most 6 of them web_fetch \(the engine enforces both\)/);
  assert.match(ec, /<status> is OPENED or NOT REACHABLE ONLY for a URL you fetched with web_fetch in this run; for every other source write `not re-opened; URL and price checked by the station against this job's search results`/);
});
