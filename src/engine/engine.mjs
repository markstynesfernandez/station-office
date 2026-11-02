// engine.mjs — assembles one engine (ENGINE-PLAN.md §1.1): jail, lock, store, ledger, bus, e-stop, spend guard,
// scheduler, providers, and (E3) the agent runtime and the line orchestrator. One engine per data root: data/.lock
// holds the pid; a second engine on the same root refuses to start. Restart is safe: state is written before its
// event; on start, in-flight runs become `interrupted`, calls that were in flight are charged at their reserved
// maximum, and each interrupted job goes back to the start of its step at most `resumeOnRestart` times, then `blocked`.
// R1 (RESTRUCTURE.md §1, §3): the seven-floor company. Every record carries product_id and department_id (building.mjs resolves them;
// a post-B0 root is refused until npm run migrate:products); the autonomy policy (policy.mjs) and the locked rules (locked.mjs) are
// checked when the config loads and on every action (actions.mjs); the requests queue is the Owner's office (requests.mjs); the policy
// file's changes are logged at every start. The Etsy department is archived: no start on its lines, no armed routine, no run of its
// agents, except in an archive sandbox (archiveSandbox: the mock provider only; the dry runs, the demo and the Etsy regression tests,
// $0), which a live provider refuses.
import fs from 'node:fs';
import path from 'node:path';
import { createJail, APP_ROOT } from './store/jail.mjs';
import { openStore } from './store/db.mjs';
import { createLedger } from './ledger.mjs';
import { createBus } from './bus.mjs';
import { createHalt } from './halt.mjs';
import { createGuard } from './guard.mjs';
import { createScheduler } from './scheduler.mjs';
import { createProviders } from './providers/index.mjs';
import { loadConfig, demoMarkers } from './config.mjs';
import { useJail } from './store/active.mjs';
import { createOwnerActions } from './owner.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createSpendDesk } from './spend.mjs';
import { effectiveAgent } from './runtime.mjs';
import { validSchedule } from './scheduler.mjs';
import { withScouting, scoutedTerms } from './lib/scouting.mjs';
import { building } from './business.mjs';
import { company } from './building.mjs';
import { createPolicy, recordPolicyChanges } from './policy.mjs';
import { createRequests } from './requests.mjs';
import { createActions } from './actions.mjs';
import { createEngineering, SIDE_KINDS } from './engineering.mjs';
import { createExecs } from './execs.mjs';

export class LockError extends Error { constructor(msg) { super(msg); this.code = 'LOCKED'; } }
export class DemoConfigError extends Error { constructor(msg) { super(msg); this.code = 'DEMO_CONFIG'; } }
export class MigrationNeeded extends Error { constructor(msg) { super(msg); this.code = 'MIGRATE'; } }
export class ArchivedError extends Error { constructor(msg) { super(msg); this.code = 'ARCHIVED'; } }
const sameOrInside = (a, b) => { const n = (p) => (process.platform === 'win32' ? p.toLowerCase() : p); const x = n(a), y = n(b); return x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep); };

// DEMO values (demo/station-patch.json, demo/products.json) are for the demo engine only (scripts/demo.mjs passes
// demo: true on its own root, data-demo/). A real engine refuses to start with any of them in its config, and a demo
// engine refuses the station's data root.
export function checkDemoConfig(cfg, { demo, dataRoot }) {
  const marks = demoMarkers(cfg);
  if (!demo && marks.length) throw new DemoConfigError('refusing to start: DEMO values are in the config (' + marks.slice(0, 6).join(', ') + (marks.length > 6 ? ', …' : '') + '); they apply only to the demo engine (npm run demo)');
  if (demo) for (const r of [path.join(APP_ROOT, 'data'), process.env.STATION_DATA_ROOT].filter(Boolean)) if (sameOrInside(dataRoot, path.resolve(r)) || sameOrInside(path.resolve(r), dataRoot)) throw new DemoConfigError('refusing to start a demo engine on the station data root (' + dataRoot + ')');
  return marks;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function takeLock(J, log) {
  const f = path.join(J.dataRoot, '.lock');
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (cur.pid && cur.pid !== process.pid && alive(cur.pid)) throw new LockError('another engine (pid ' + cur.pid + ', started ' + new Date(cur.startedAt).toISOString() + ') holds ' + f);
    if (cur.pid && cur.pid !== process.pid) log && log.warn('stale engine lock replaced', { stalePid: cur.pid });
  } catch (e) { if (e.code === 'LOCKED') throw e; /* no lock or unreadable: take it */ }
  J.put(f, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n', { fsync: true });
  return () => { try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.pid === process.pid) J.remove(f); } catch (_) { /* gone */ } };
}

// in-flight work at the last stop: runs -> interrupted, open stages -> interrupted, jobs -> resume once or blocked
export function recover({ store, bus, log, resumeOnRestart = 1 }) {
  const out = { runs: 0, jobs: [] };
  store.tx(() => {
    for (const r of store.runningRuns()) { store.finishRun(r.run_id, { status: 'interrupted', endReason: 'engine stopped mid-run', usd: r.usd, tokensIn: r.tokens_in, tokensOut: r.tokens_out, turns: r.turns }); out.runs++; }
    for (const s of store.openStages()) store.closeStage(s.id, 'interrupted', 'engine stopped mid-step');
    for (const j of store.listJobs({ states: ['running'] })) {
      if ((j.resumes || 0) < resumeOnRestart) { store.updateJob(j.id, { state: 'queued', resumes: (j.resumes || 0) + 1, reason: 'interrupted by an engine restart; resumes at the start of ' + j.step }); out.jobs.push({ id: j.id, action: 'resume', step: j.step }); }
      else { store.updateJob(j.id, { state: 'blocked', reason: 'interrupted by an engine restart again (resumeOnRestart ' + resumeOnRestart + ' used); restart it by hand', ended_at: Date.now() }); out.jobs.push({ id: j.id, action: 'blocked', step: j.step }); }
    }
  });
  if (out.runs || out.jobs.length) { log.warn('recovered after an unclean stop', out); bus.emit('engine.recovered', { data: out }); }
  return out;
}

export function createEngine({ dataRoot, configDir = path.join(APP_ROOT, 'config'), promptsDir = path.join(APP_ROOT, 'prompts'), log, providers = null, script = null, mockDelayMs = 0, clock = Date.now, startScheduler = true, resume = true, hooks = {}, overrides = null, J = null, demo = false, upscaler = null, limitJobs = false, scriptRun = null, archiveSandbox = false, instance = null, engineering = {} } = {}) {
  J = J || createJail({ dataRoot });
  const unlock = takeLock(J, log);
  useJail(J);   // the ported station modules write through this engine's jail
  // R2a.1: what a start that fails part way has opened (the store, the e-stop watcher) is closed again, so it holds no file
  const opened = [];
  try {
    const cfg = loadConfig({ configDir, promptsDir, overrides });
    checkDemoConfig(cfg, { demo, dataRoot: J.dataRoot });
    // genre-trend scouting (DECISIONS.md): every originality screen reads the station config through this getter, so the
    // scouting blocklist (data/research/scouting/blocklist.json, engine-written) applies the moment a title is recorded
    const baseStation = cfg.station, researchDir = path.join(J.dataRoot, 'research');
    Object.defineProperty(cfg, 'station', { enumerable: true, get: () => withScouting(baseStation, scoutedTerms(researchDir)) });
    if (overrides) log.warn('config overrides in use (dry run and demo only)', { products: overrides.productsFile ? overrides.productsFile.products.map((p) => p.key) : null, stationSet: overrides.stationSet ? Object.keys(overrides.stationSet) : null });
    const store = openStore({ J, log }); opened.push(() => store.close());
    // B0 (owner, 21/10/2026): every job, run, routine, approval, ledger row and event carries business_id. A data root from before
    // B0 is refused until npm run migrate:businesses -- --apply has backfilled it (fail closed: no record without its business)
    const gaps = store.businessGaps();
    if (gaps.missingColumn.length || Object.keys(gaps.nullRows).length) { store.close(); throw new MigrationNeeded('this data root has records without a business (' + [...gaps.missingColumn.map((t) => t + ': no business_id column'), ...Object.entries(gaps.nullRows).map(([t, n]) => t + ': ' + n + ' row(s) without business_id')].join('; ') + '): stop here and run npm run migrate:businesses (a dry run), then npm run migrate:businesses -- --apply'); }
    // R1 (owner, 23/10/2026): every record carries product_id and department_id. A post-B0 data root is refused until npm run
    // migrate:products -- --apply has backfilled it (fail closed: no record without its product and department)
    const pg = store.productGaps();
    if (pg.missingColumn.length || Object.keys(pg.nullRows).length) { store.close(); throw new MigrationNeeded('this data root has records without a product and department (' + [...pg.missingColumn.map((t) => t + ': no product_id/department_id columns'), ...Object.entries(pg.nullRows).map(([t, n]) => t + ': ' + n + ' row(s) without them')].join('; ') + '): stop here and run npm run migrate:products (a dry run), then npm run migrate:products -- --apply'); }
    const B = building(cfg), jobBusiness = (id) => { const j = store.getJob(id); return j ? (j.business_id || B.ofLine(j.line)) : null; };
    const businessOf = (rec) => B.resolve(rec, jobBusiness);
    store.setBusinessResolver(businessOf);
    const C = company(cfg), jobProduct = (id) => { const j = store.getJob(id); if (!j) return null; if (j.product_id && j.department_id) return { productId: j.product_id, departmentId: j.department_id }; return C.resolve({ line: j.line, businessId: j.business_id || (j.legacy ? 'etsy-shop' : null) }); };
    const productOf = (rec) => C.resolve(rec, jobProduct);
    store.setProductResolver(productOf);
    const ledger = createLedger({ J, store, log, businessOf, productOf });
    const bus = createBus({ J, log, businessOf, productOf });
    const policy = createPolicy({ levels: cfg.policy.levels, sha256: cfg.policy.sha256, products: cfg.company.products });
    const halt = createHalt({ J, bus, log }); opened.push(() => halt.close());
    const guard = createGuard({ J, ledger, halt, caps: cfg.engine.caps, pricing: cfg.engine.pricing, log, bus, clock, outerLimits: cfg.engine.outerLimits || {}, products: { get: C.product, resolve: productOf, businessOf, jobCap: (p, d) => { const x = C.product(p); return x && x.jobCapUsdByDepartment ? x.jobCapUsdByDepartment[d] ?? null : null; }, agentRunCap: (k) => { const a = cfg.agents[k]; return a && a.limits && a.limits.runCapUsd > 0 ? a.limits.runCapUsd : null; } } });
    const recovered = guard.recoverPending();
    const rec = recover({ store, bus, log, resumeOnRestart: cfg.engine.runtime.resumeOnRestart });
    const prov = providers || createProviders({ mode: process.env.STATION_PROVIDER || cfg.engine.provider, script, delayMs: mockDelayMs, log, engineCfg: cfg.engine, halt, demo });
    // the archive sandbox runs the archived Etsy line on the mock provider only ($0): an engine that builds a live provider refuses it
    // (a test that injects its own fake providers is its own sandbox)
    if (archiveSandbox && !providers && prov.mode !== 'mock') { halt.close(); store.close(); throw new ArchivedError('the archive sandbox runs on the mock provider only: the archived Etsy line never runs live'); }
    const engine = { J, cfg, store, ledger, bus, halt, guard, providers: prov, log, clock, upscaler, recovered: { charged: recovered, ...rec }, building: B, businessOf, jobBusiness, company: C, productOf, jobProduct, policy, archiveSandbox: !!archiveSandbox, instance: instance || null };
    engine.requests = createRequests(engine);   // the Owner's office queue (only the owner's page session decides)
    engine.actions = createActions(engine);     // every action: the locked rules, then the policy, then a request or the action
    // R1: why a line cannot start now (archived, or paused by the COO or the owner), or null
    engine.lineHold = (line) => { if (C.lineArchived(line) && !engine.archiveSandbox) return 'archived: the ' + line + ' line is in the Etsy archive (Etsy production stopped, owner 22/10/2026); nothing starts on it'; const p = engine.actions.paused(line); return p ? 'paused by ' + p.by + ': ' + p.reason + ' (the owner resumes it on the page)' : null; };
    // L3 (owner, 21/10/2026): an engine opened by a script (script-engine.mjs): no scheduler, no routine, no resumed job; a maintenance
    // script starts no job at all, any other only the jobs it starts itself (scriptRun.own)
    if (scriptRun) { engine.scriptRun = { purpose: String(scriptRun.purpose || 'script'), startsJobs: scriptRun.startsJobs === true, own: new Set() }; startScheduler = false; resume = false; log.info('engine opened by a script: scheduler and routines off', { purpose: engine.scriptRun.purpose, startsJobs: engine.scriptRun.startsJobs }); }
    // L2: an instance started by npm start (limitJobs) runs at most runtime.maxRunningJobs jobs at once, across every line; others queue as next
    engine.maxRunningJobs = limitJobs ? (cfg.engine.runtime.maxRunningJobs ?? 1) : null;
    engine.orchestrator = createOrchestrator(engine, { hooks });
    // R2: the engineering line (issues, the CTO's triage, engineering jobs on a product's code); engineering = { checks, env } in tests
    engine.engineering = createEngineering(engine, { hooks, ...engineering });
    // R3: the penthouse executives (the COO's daily report, the CEO's weekly memo), run by the engineering module's side-line runner
    engine.execs = createExecs(engine, { now: clock });
    engine.spend = createSpendDesk(engine);   // L2: the spend confirmation in front of every page action that can spend
    // E6 b3: a scout job that restart recovery ended (blocked) still puts its notes' names on the scouting blocklist
    for (const j of rec.jobs.filter((x) => x.action === 'blocked')) engine.orchestrator.blocklistOnEnd(j.id);
    engine.owner = createOwnerActions(engine);   // the owner's decisions and owner-started mechanical steps (port batch 17/10/2026)
    // a routine fires a line (verified briefs, up to its daily limit) or a research batch; created disabled, enabled by the owner only
    engine.runRoutine = async (routine) => {
      if (engine.scriptRun) throw new Error('no routine runs in an engine opened by a script (' + engine.scriptRun.purpose + ')');
      const cap = routine.per_run_cap_usd ?? null;
      const rl = /^line:(.+)$/.exec(routine.target), rline = rl && cfg.lines[rl[1]];
      // R1: an archived or paused line's routine skips
      if (rline) { const h = engine.lineHold(rline.id); if (h) return { skipped: h }; }
      // the product key is data (owner, 17/10/2026): a shipped routine carries it in config/routines.json (productKey);
      // any other routine uses the line's config default; the orchestrator checks it against products.json at start
      const seed = (cfg.routines || []).find((s) => s.id === routine.id);
      // L3 (owner, 20/10/2026): a firing starts alongside another line's job within the job limits (on its own line it waits as next),
      // and only when the day caps and the Console estimate hold with every open job's worst case counted (spend.startCheck)
      const fits = (line) => { const c = engine.spend.startCheck({ line, headroomUsd: (cfg.engine.caps.perJobUsdByLine || {})[line] ?? cfg.engine.caps.perJobUsd }); return c.refusals.length ? 'the start would not fit: ' + c.refusals.join('; ') : null; };
      // R3: an agent routine is an executive's standing report (the COO's daily report, the CEO's weekly memo): it skips while its agent is
      // not hired, off duty or its line paused, or when the start would not fit the caps
      const ra = /^agent:(.+)$/.exec(routine.target || '');
      if (ra) {
        const X = engine.execs, k = X && Object.keys(X.kinds).find((x) => X.kinds[x].agent === ra[1]);
        if (!k) return { skipped: ((cfg.agents[ra[1]] || {}).name || ra[1]) + ' has no standing report' };
        const no = X.startProblems(k); if (no.length) return { skipped: no.join('; ') };
        const f = engine.spend.startCheck({ line: X.lineOf(k), headroomUsd: engine.spend.jobCapOf(X.lineOf(k)) }); if (f.refusals.length) return { skipped: 'the start would not fit: ' + f.refusals.join('; ') };
        return X.start(k, { by: 'routine ' + routine.id, routineId: routine.id }, { actor: { kind: 'engine' } }).promise;
      }
      if (rline) { const no = fits(rline.id); if (no) return { skipped: no }; }
      if (rline && rline.kind === 'research') { const r = engine.orchestrator.createResearchJob({ line: rline.id, input: routine.input || undefined, by: 'routine ' + routine.id, ...(seed && seed.productKey !== undefined ? { productKey: seed.productKey } : {}) }); store.updateJob(r.id, { data: { routineId: routine.id, ...(cap != null ? { runCapUsd: cap } : {}) } }); return engine.orchestrator.startJob(r.id); }
      if (routine.target === 'line:room1-digital') {
        // the oldest verified brief that has no job yet (owner Q13: once the owner enables a line routine); never a legacy one (E7a.1)
        const b = engine.orchestrator.verifiedBriefs().find((x) => x.status === 'verified' && x.id && !x.jobId && !x.legacy);
        if (!b) return { skipped: 'no verified brief is waiting' };
        // ownerFile1 (owner, 18/10/2026): a shipped routine may keep the owner's pause after QA DESIGN passes file 1
        const c = engine.orchestrator.createJob({ briefText: fs.readFileSync(path.join(J.dataRoot, 'research', 'briefs', b.file), 'utf8'), by: 'routine ' + routine.id, ownerFile1: !!(seed && seed.ownerFile1 === true) });
        if (!c.ok) return { skipped: 'brief ' + b.file + ' refused at intake: ' + c.reasons.join('; ') };
        store.updateJob(c.id, { data: { routineId: routine.id, ...(cap != null ? { runCapUsd: cap } : {}) } });
        return engine.orchestrator.startJob(c.id);
      }
      throw new Error('routine target not supported: ' + routine.target);
    };
    // routines the page may create (ENGINE-PLAN.md §5.4); an off-duty first agent makes its line's routines skip
    engine.routineTargets = Object.values(cfg.lines).filter((l) => !SIDE_KINDS.includes(l.kind)).map((l) => ({ id: 'line:' + l.id, label: l.kind === 'research' ? (l.routineLabel || l.label + ' batch') + ' (' + l.id + ' line)' : 'Next verified brief (' + l.id + ' line)', firstAgent: firstAgentOf(l) }));
    // R1, R3: a routine may run an executive's standing report (the COO's daily report, the CEO's weekly memo; both seeded disabled)
    if (cfg.agents.coo) engine.routineTargets.push({ id: 'agent:coo', label: 'COO daily operations report', firstAgent: 'coo', agent: true, line: 'coo-report' });
    if (cfg.agents.ceo) engine.routineTargets.push({ id: 'agent:ceo', label: 'CEO weekly memo', firstAgent: 'ceo', agent: true, line: 'ceo-memo' });
    const routineHold = (routine) => {
      const t = engine.routineTargets.find((x) => x.id === routine.target); if (!t || !t.firstAgent) return null;
      return effectiveAgent(engine, t.firstAgent).enabled ? null : ((cfg.agents[t.firstAgent] || {}).name || t.firstAgent) + ' is off duty';
    };
    engine.scheduler = createScheduler({ store, halt, ledger, caps: cfg.engine.caps, bus, log, clock, hold: routineHold, locked: engine.scriptRun ? 'script: ' + engine.scriptRun.purpose : null, run: (routine) => (engine.runRoutine ? engine.runRoutine(routine) : Promise.reject(new Error('no routine runner'))) });
    // R7a.2 (owner, 29/10/2026): an enabled routine on an archived line (or of an archived department) is disabled at start, logged, and
    // never armed or fired; a script's engine changes no routine, and the archive sandbox archives nothing
    if (!engine.scriptRun) engine.disabledAtStart = disableArchivedRoutines(engine);
    if (startScheduler) engine.scheduler.start();
    engine.routines = routineAdmin(engine);
    engine.seededRoutines = seedRoutines(engine);
    engine.updateAgent = (key, patch, opts) => updateAgent(engine, key, patch, opts);
    // jobs interrupted by the last stop resume at the start of their step, once (resumeOnRestart)
    if (resume && !halt.isHalted()) for (const j of rec.jobs.filter((x) => x.action === 'resume')) { try { engine.orchestrator.startJob(j.id); } catch (e) { log.warn('interrupted job not resumed', { id: j.id, error: e.message }); } }
    bus.emit('engine.start', { data: { pid: process.pid, provider: prov.mode, dataRoot: J.dataRoot, ledgerOk: ledger.state.ok, halted: halt.isHalted() } });
    // R1: the autonomy policy's changes since the last start, one row per changed action (data/policy/autonomy-log.jsonl)
    recordPolicyChanges({ J, store, policy, commit: instance ? instance.commit || null : null, instance: instance ? instance.name || null : null, log, bus });
    log.info('engine started', { dataRoot: J.dataRoot, provider: prov.mode, store: store.backend, ledgerRows: ledger.totals.rows, halted: halt.isHalted() });
    engine.close = () => { try { engine.scheduler.stop(); } catch (_) {} try { engine.engineering.close(); } catch (_) {} halt.close(); store.close(); useJail(null); unlock(); log.info('engine closed'); };
    return engine;
  } catch (e) { for (const close of opened.reverse()) { try { close(); } catch (_) { /* already closed on the refusal's own path */ } } unlock(); throw e; }
}

// config/routines.json: routines the station ships with, inserted once per data root and ALWAYS disabled (enabling is the
// owner's approval, ENGINE-PLAN.md §5.4). A seed the owner deletes stays deleted (meta seeded:<id>); never re-enabled here.
export function seedRoutines(engine) {
  const { cfg, store, log } = engine, out = [];
  for (const s of cfg.routines || []) {
    const key = 'seeded:' + s.id;
    if (store.meta.get(key) || store.getRoutine(s.id)) { if (!store.meta.get(key)) store.meta.set(key, Date.now()); continue; }
    if (!engine.routineTargets.some((t) => t.id === s.target) || !validSchedule(s.schedule)) { log.warn('seed routine skipped: bad target or schedule', { id: s.id, target: s.target }); continue; }
    store.tx(() => { store.insertRoutine({ id: s.id, name: s.name, target: s.target, input: s.input || '', schedule: s.schedule, max_runs_per_day: s.maxRunsPerDay ?? 1, per_run_cap_usd: s.perRunCapUsd ?? null }); store.meta.set(key, Date.now()); });
    log.info('seed routine created (disabled)', { id: s.id, name: s.name, target: s.target }); out.push(s.id);
  }
  return out;
}

const firstAgentOf = (l) => { let step = l.start, seen = 0; while (step && seen++ < 20) { const d = l.steps[step]; if (!d) return null; if (d.kind === 'agent') return d.agent; step = d.next; } return null; };

// ---- the owner's changes from the office (E5). Each takes the record's expectedVersion; a stale tab is refused.
function routineAdmin(engine) {
  const { store, cfg, bus, log, scheduler } = engine;
  const caps = cfg.engine.caps;
  function clean(b, cur = {}) {
    const r = {
      name: b.name != null ? String(b.name).trim() : cur.name, target: b.target != null ? String(b.target) : cur.target, input: b.input != null ? String(b.input).replace(/\r\n/g, '\n').trim() : (cur.input || ''),
      schedule: b.schedule != null ? String(b.schedule).trim().replace(/\s+/g, ' ') : cur.schedule,
      max_runs_per_day: b.maxRunsPerDay != null ? Number(b.maxRunsPerDay) : (cur.max_runs_per_day ?? 1),
      per_run_cap_usd: b.perRunCapUsd !== undefined ? (b.perRunCapUsd === null || b.perRunCapUsd === '' ? null : Number(b.perRunCapUsd)) : (cur.per_run_cap_usd ?? null)
    };
    const bad = [];
    if (!r.name || r.name.length > 80) bad.push('a name of 1 to 80 characters');
    if (!engine.routineTargets.some((t) => t.id === r.target)) bad.push('a target the engine can run (' + engine.routineTargets.map((t) => t.id).join(', ') + ')');
    if (r.input.length > 2000) bad.push('an input under 2,000 characters');
    if (!validSchedule(r.schedule)) bad.push('a 5-field cron schedule (Europe/Dublin), e.g. "0 9 * * 1-5"');
    if (!Number.isInteger(r.max_runs_per_day) || r.max_runs_per_day < 1 || r.max_runs_per_day > 24) bad.push('max runs a day between 1 and 24');
    if (r.per_run_cap_usd != null && !(r.per_run_cap_usd > 0 && r.per_run_cap_usd <= caps.perRunUsd)) bad.push('a per-run cap above 0 and at most the engine cap of ' + caps.perRunUsd.toFixed(2) + ' (caps are raised in config only)');
    if (bad.length) throw new Error('the routine needs ' + bad.join('; '));
    return r;
  }
  const emit = (id, what, r) => { bus.emit('routine.changed', { data: { routineId: id, what, name: r ? r.name : null, enabled: r ? r.enabled : false } }); log.info('routine ' + what, { id, name: r && r.name }); };
  const needVersion = (v) => { if (v == null || !Number.isInteger(v)) throw new Error('expectedVersion is required'); };
  const notLegacy = (r) => { if (r.legacy) throw new Error('an imported legacy routine is read only (a re-import would bring it back)'); };
  const named = (r, fn) => { try { return fn(); } catch (e) { if (e.code === 'STALE') e.message = e.message.replace('routine ' + r.id, 'the routine "' + r.name + '"'); throw e; } };
  return {
    // created disabled, always (ENGINE-PLAN.md §5.4)
    create(b) {
      const r = clean(b), id = 'rt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      const out = store.insertRoutine({ id, ...r });
      emit(id, 'created', out); return out;
    },
    update(id, b, { expectedVersion } = {}) {
      needVersion(expectedVersion);
      const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id); notLegacy(cur);
      const out = named(cur, () => store.updateRoutine(id, clean(b, cur), { expectedVersion }));
      scheduler.refresh(id); emit(id, 'edited (left disabled: enable it again to approve the change)', out); return out;
    },
    // enabling is the only approval; a legacy or unsupported routine cannot be enabled
    enable(id, enabled, { expectedVersion } = {}) {
      needVersion(expectedVersion);
      const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id);
      if (enabled) { notLegacy(cur); if (!engine.routineTargets.some((t) => t.id === cur.target)) throw new Error('this routine\'s target cannot run: ' + cur.target); const hold = routineArmHold(engine, cur.target); if (hold) throw Object.assign(new Error('this routine cannot be armed: ' + hold), { code: 'ARCHIVED' }); }
      const out = named(cur, () => store.setRoutineEnabled(id, !!enabled, { expectedVersion }));
      scheduler.refresh(id); emit(id, enabled ? 'enabled' : 'disabled', out); return out;
    },
    remove(id, { expectedVersion } = {}) {
      needVersion(expectedVersion);
      const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id); notLegacy(cur);
      named(cur, () => store.deleteRoutine(id, { expectedVersion }));
      scheduler.refresh(id); emit(id, 'deleted', null); return { id, deleted: true };
    }
  };
}

// R7a.2: the enabled routines on an archived line or of an archived department, disabled before the scheduler arms anything -> their ids
export function disableArchivedRoutines(engine) {
  const { store, company: C, bus, log } = engine, out = [];
  if (engine.archiveSandbox) return out;
  for (const r of store.listRoutines()) {
    if (!r.enabled) continue;
    const l = /^line:(.+)$/.exec(String(r.target || '')), dept = r.department_id ? C.department(r.department_id) : null;
    const why = l && C.lineArchived(l[1]) ? 'the ' + l[1] + ' line is archived' : dept && dept.status === 'archived' ? 'its department (' + dept.id + ') is archived' : null;
    if (!why) continue;
    const d = store.setRoutineEnabled(r.id, false, { expectedVersion: r.version });
    bus.emit('routine.changed', { data: { routineId: r.id, what: 'disabled at start: ' + why, name: r.name, enabled: false, productId: r.product_id || undefined, departmentId: r.department_id || undefined } });
    log.warn('routine disabled at start: archived', { id: r.id, name: r.name, target: r.target, why, version: d.version });
    out.push(r.id);
  }
  return out;
}

// R1: why a routine target cannot be armed: its line is archived or paused, or its agent is not hired yet or archived -> reason or null
export function routineArmHold(engine, target) {
  const l = /^line:(.+)$/.exec(String(target || '')), a = /^agent:(.+)$/.exec(String(target || ''));
  if (l) return engine.lineHold ? engine.lineHold(l[1]) : null;
  if (a) { const st = engine.company.agentStatus(a[1]); return st === 'active' ? null : ((engine.cfg.agents[a[1]] || {}).name || a[1]) + ' is ' + (st === 'not-hired' ? 'not hired yet' : st); }
  return null;
}

// on/off duty, tier and effort: an overlay in SQLite on top of config/agents/<key>.json, read at the start of every run,
// so a change applies at the next run with no restart. Tier and effort only from the lists in config/engine.json.
export function updateAgent(engine, key, patch = {}, { expectedVersion } = {}) {
  const { cfg, store, bus, log } = engine;
  if (!cfg.agents[key]) throw new Error('no such agent: ' + key);
  // R1: a not-hired agent has no desk to change, and an archived one is read only (except in the archive sandbox)
  const st = engine.company ? engine.company.agentStatus(key) : 'active';
  if (st === 'not-hired') throw Object.assign(new Error(cfg.agents[key].name + ' is not hired yet (' + (cfg.agents[key].phase || 'a later phase') + '): nothing to change'), { code: 'NOT_HIRED' });
  if (st === 'archived' && !engine.archiveSandbox) throw Object.assign(new Error(cfg.agents[key].name + ' is archived (' + (cfg.agents[key].retired ? 'retired into ' + cfg.agents[key].retiredInto : 'the Etsy archive') + '): read only'), { code: 'ARCHIVED' });
  if (expectedVersion == null || !Number.isInteger(expectedVersion)) throw new Error('expectedVersion is required');
  const p = {};
  if (patch.enabled !== undefined) { if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false'); p.enabled = patch.enabled; }
  if (patch.tier !== undefined) { if (!cfg.engine.tiers[patch.tier]) throw new Error('tier must be one of ' + Object.keys(cfg.engine.tiers).join(', ')); p.tier = patch.tier; }
  if (patch.effort !== undefined) { const lv = cfg.engine.effortLevels || []; if (!lv.includes(patch.effort)) throw new Error('effort must be one of ' + lv.join(', ')); p.effort = patch.effort; }
  if (!Object.keys(p).length) throw new Error('nothing to change');
  const out = store.setAgentState(key, p, { expectedVersion });
  const eff = effectiveAgent(engine, key);
  bus.emit('agent.updated', { agentKey: key, data: { enabled: eff.enabled, tier: eff.tier, effort: eff.effort, appliesAt: 'next run' } });
  log.info('agent updated', { agent: key, ...p, version: out.version });
  const woke = p.enabled === true ? [...engine.orchestrator.wakeWaiting(key), ...(engine.engineering ? engine.engineering.wakeWaiting(key) : [])] : [];
  return { agentKey: key, version: out.version, enabled: eff.enabled, tier: eff.tier, effort: eff.effort, started: woke };
}
