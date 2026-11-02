// r1-company.test.mjs — R1 (owner, R1 prompt 23/10/2026; RESTRUCTURE.md §1, §2, §3.1, §8 R1): the seven-floor company in the engine.
//   1 the config: products x departments, seven floors (display order only), 19 agents in their departments, all not hired yet; the
//     Etsy department, its agents and OVERSEER archived; COMPLIANCE and the execs report to the owner; models and thinking as decided
//   2 a not-hired agent cannot run or spend; an archived one cannot run (outside the mock archive sandbox); neither can be changed
//   3 the Etsy archive: no start on its lines, its routines cannot be armed; the COO's routine is seeded disabled and cannot be armed
//   4 the spend guard per product and department: monthly budgets, the day cap, the department job cap, the agents' run caps, from
//     config (proposals marked); Opus refused until a verified price from Anthropic's official page is added
//   5 the policy: an unknown action is forbidden; a change to the file is logged once per changed action at the next start
//   6 records key on product and department: moving a department to another floor changes no record
//   7 the Owner's office in the snapshot: floors, products (Finance, MRR not connected), requests, the policy and its log
// Mock provider only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, removeTempDir, CAPS, PRICING } from './helpers/engine.mjs';
import { configCopy, promptsCopy, hire, engineOn, reopen, CONFIG, PROMPTS, readJson } from './helpers/r1.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { company, FLOORS, STATION, HQ } from '../src/engine/building.mjs';
import { createGuard, CapError, GuardRefusal, OFFICIAL_PRICING } from '../src/engine/guard.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { createHalt } from '../src/engine/halt.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { PolicyRefusal, policyLog } from '../src/engine/policy.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { createBuildingView } from '../src/web/ui/building.js';
import { PRODUCT_TABLES } from '../src/engine/store/db.mjs';
import { dublinDay } from '../src/engine/time.mjs';

const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const C = company(REAL);
const NEW_AGENTS = { hq: ['ceo', 'cto', 'coo', 'compliance'], 'security-data': ['security', 'analyst'], engineering: ['tech-lead', 'developer', 'reviewer', 'tester'], 'product-design': ['product-manager', 'ux-designer'], 'sales-marketing': ['lead-researcher', 'lead-checker', 'outreach-writer', 'content-writer'], 'customer-success': ['onboarding-guide', 'support-drafter', 'retention-analyst'] };
// R2 (owner's go, 25/10/2026): the engineering line's six are hired; R3 (30/10/2026): the CEO and the COO; the other 11 stay not hired
// until their phase
const R2_HIRED = ['cto', 'security', 'tech-lead', 'developer', 'reviewer', 'tester'], R3_HIRED = ['ceo', 'coo'], HIRED = [...R2_HIRED, ...R3_HIRED];
const NOT_HIRED = Object.values(NEW_AGENTS).flat().filter((k) => !HIRED.includes(k));
const ETSY_AGENTS = ['demand-researcher', 'evidence-checker', 'trend-scout', 'designer', 'qa-design', 'lister', 'qa-listing', 'rejects-desk'];

// ---- 1. the config

test('1: seven floors top to bottom (6 Penthouse HQ … 1 Customer Success, G the Etsy archive); departments report to the owner, the CEO or the CTO as planned', () => {
  assert.deepEqual(C.floors().map((d) => [d.floor, d.id, d.reportsTo, d.status]), [['6', 'hq', 'owner', 'active'], ['5', 'security-data', 'cto', 'active'], ['4', 'engineering', 'cto', 'active'], ['3', 'product-design', 'ceo', 'active'], ['2', 'sales-marketing', 'ceo', 'active'], ['1', 'customer-success', 'ceo', 'active'], ['G', 'etsy', 'owner', 'archived']]);
  assert.deepEqual(FLOORS, ['6', '5', '4', '3', '2', '1', 'G']);
  assert.deepEqual(C.list.map((p) => [p.id, p.status]).sort(), [['emty-inbox', 'active'], ['etsy-shop', 'archived'], ['replydesk', 'active'], ['station', 'active']]);
  assert.equal(C.department('etsy').product, 'etsy-shop'); assert.deepEqual(C.department('etsy').lines.sort(), ['genre-scout', 'research', 'room1-digital']);
  // the templates are never loaded
  assert.ok(fs.existsSync(path.join(CONFIG, 'products', '_template.json'))); assert.ok(!C.list.some((p) => /template/.test(p.id)));
});

test('1: all 19 active-company agents are in their departments, each with its phase (R2: the engineering six hired; R3: the CEO and the COO; the rest not hired yet); the Etsy agents are archived and OVERSEER is retired into the COO', () => {
  const all = Object.values(NEW_AGENTS).flat();
  assert.equal(all.length, 19);
  for (const [d, keys] of Object.entries(NEW_AGENTS)) { assert.deepEqual(C.department(d).agents.filter((k) => keys.includes(k)), keys, d); for (const k of keys) assert.equal(C.deptOfAgent(k), d, k); }
  for (const k of all) { const a = REAL.agents[k], hired = HIRED.includes(k); assert.equal(a.status, hired ? 'active' : 'not-hired', k); assert.match(a.phase, /^R[2-6]$/, k); assert.equal(a.enabled, hired, k); if (hired) assert.equal(a.phase, R2_HIRED.includes(k) ? 'R2' : 'R3', k); }
  assert.deepEqual(Object.fromEntries(all.map((k) => [k, REAL.agents[k].phase])), { ceo: 'R3', cto: 'R2', coo: 'R3', compliance: 'R5', security: 'R2', analyst: 'R6', 'tech-lead': 'R2', developer: 'R2', reviewer: 'R2', tester: 'R2', 'product-manager': 'R4', 'ux-designer': 'R4', 'lead-researcher': 'R5', 'lead-checker': 'R5', 'outreach-writer': 'R5', 'content-writer': 'R5', 'onboarding-guide': 'R6', 'support-drafter': 'R6', 'retention-analyst': 'R6' });
  for (const k of ETSY_AGENTS) { assert.equal(REAL.agents[k].status, 'archived', k); assert.equal(C.deptOfAgent(k), 'etsy', k); }
  assert.deepEqual([REAL.agents.overseer.status, REAL.agents.overseer.retired, REAL.agents.overseer.retiredInto, C.deptOfAgent('overseer')], ['archived', true, 'coo', 'hq']);
  assert.equal(REAL.agents['ux-designer'].name, 'UX-DESIGNER'); assert.equal(REAL.agents.designer.status, 'archived', 'the Etsy DESIGNER keeps its id');
  for (const k of ['ceo', 'cto', 'coo', 'compliance']) assert.equal(REAL.agents[k].reportsTo, 'owner', k);
  // models and thinking (owner, R0.2 and R0.3): Sonnet for the execs, DEVELOPER, REVIEWER, SECURITY, COMPLIANCE, TECH-LEAD, PRODUCT-MANAGER and both writers
  const strong = ['ceo', 'cto', 'coo', 'compliance', 'security', 'developer', 'reviewer', 'tech-lead', 'product-manager', 'outreach-writer', 'content-writer'];
  for (const k of all) assert.equal(REAL.agents[k].tier, strong.includes(k) ? 'strong' : 'cheap', k);
  for (const k of all) assert.equal(REAL.agents[k].thinking, ['developer', 'reviewer', 'compliance'].includes(k) ? 'default' : 'off', k);
  // proposals are marked as proposals
  for (const k of all) assert.deepEqual(REAL.agents[k].proposals, ['limits'], k);
  assert.deepEqual([REAL.agents.ceo.limits.runCapUsd, REAL.agents.cto.limits.runCapUsd, REAL.agents.coo.limits.runCapUsd, REAL.agents.compliance.limits.runCapUsd], [0.5, 0.3, 0.2, 0.1]);
});

test('1: a bad building stops the engine with the reason: an agent in two departments or none, a floor used twice, a product dataDir outside products/<id>/', (t) => {
  const bad = (edits, re) => { const r = tempRoot('r1bld'); t.after(r.cleanup); const dir = configCopy(r.base, edits); assert.throws(() => createEngine({ J: r.J, log: r.log, configDir: dir, startScheduler: false }), (e) => e.code === 'BUILDING' && re.test(e.message), String(re)); };
  bad({ 'departments/engineering.json': (o) => { o.agents.push('ceo'); } }, /agent ceo is in both department (engineering and department hq|hq and department engineering)/);
  bad({ 'departments/engineering.json': (o) => { o.agents = o.agents.filter((k) => k !== 'tester'); } }, /agent tester is in no department/);
  bad({ 'departments/product-design.json': (o) => { o.floor = '4'; } }, /floor 4 is already engineering's/);
  bad({ 'products/replydesk.json': (o) => { o.dataDir = 'jobs/'; } }, /dataDir must be products\/replydesk\//);
  bad({ 'products/replydesk.json': (o) => { o.dataDir = '.'; } }, /dataDir "\." is the archived Etsy layout only/);
  bad({ 'agents/tester.json': (o) => { o.status = 'hired'; } }, /status must be one of active, not-hired, archived/);
  bad({ 'agents/analyst.json': hire() }, /analyst\.json: the tool metrics_read is not built yet, so the agent cannot be hired/);   // R2 built code_search and run_check, R3 line_pause; metrics_read is R6's
});

// ---- 2. not hired, archived

test('2: a not-hired agent cannot run or spend (nothing recorded, USD 0), and the page cannot put it on duty; an archived agent cannot run outside the sandbox', async (t) => {
  const { engine, r } = engineOn(t, { tag: 'r1nothired' });
  for (const k of NOT_HIRED) {
    await assert.rejects(runAgent(engine, { agentKey: k, folder: path.join(r.dataRoot, 'products', 'replydesk'), input: 'x' }), (e) => e.code === 'NOT_HIRED' && /is not hired yet \(R[2-6]\)/.test(e.message), k);
    assert.throws(() => engine.updateAgent(k, { enabled: true }, { expectedVersion: 0 }), (e) => e.code === 'NOT_HIRED', k);
  }
  for (const k of [...ETSY_AGENTS, 'overseer']) {
    await assert.rejects(runAgent(engine, { agentKey: k, folder: path.join(r.dataRoot, 'jobs', 'x'), input: 'x' }), (e) => e.code === 'ARCHIVED', k);
    assert.throws(() => engine.updateAgent(k, { enabled: false }, { expectedVersion: 0 }), (e) => e.code === 'ARCHIVED', k);
  }
  assert.equal(engine.store.runsOf({ limit: 100 }).length, 0); assert.equal(engine.ledger.totals.rows, 0); assert.equal(engine.guard.reservations().length, 0);
  // the snapshot does not draw a not-hired agent (no desk until its phase); it lists it in the company view
  const s = buildEngineSnapshot(engine);
  assert.ok(!s.agents.some((a) => a.id === 'compliance')); assert.ok(s.agents.some((a) => a.id === 'ceo') && s.agents.some((a) => a.id === 'coo'), 'R3: the CEO and the COO at their desks');
  assert.equal(s.agents.length, 17, 'R7a: the 8 archived Etsy agents and OVERSEER (the lobby), the six hired in R2 and the two in R3 (at their desks)');
  const hq = s.company.floors.find((f) => f.id === 'hq');
  assert.deepEqual(hq.agents.map((a) => [a.id, a.label]), [['ceo', 'active'], ['cto', 'active'], ['coo', 'active'], ['compliance', 'not hired yet (R5)'], ['overseer', 'retired into COO']]);
});

// ---- 3. the Etsy archive

test('3: the Etsy lines refuse every start with "archived" (intake, research, a queued job, a restart); their routines cannot be armed and skip; the archive sandbox needs the mock provider', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1archive' });
  const c = engine.orchestrator.createJob({ briefText: '---\nid: 2026-10-23--x\nstatus: verified\n---\n', by: 'test' });
  assert.equal(c.ok, false); assert.equal(c.code, 'ARCHIVED'); assert.match(c.reasons[0], /^archived: the room1-digital line is in the Etsy archive/);
  assert.throws(() => engine.orchestrator.createResearchJob({ by: 'test' }), (e) => e.code === 'ARCHIVED');
  assert.throws(() => engine.orchestrator.startResearch('woodland niches', { by: 'test' }), (e) => e.code === 'ARCHIVED');
  // a job queued on an archived line (history from before R1) does not start
  engine.store.insertJob({ id: '2026-10-21--old', line: 'room1-digital', kind: 'line', state: 'queued', step: 'design' });
  assert.throws(() => engine.orchestrator.startJob('2026-10-21--old'), (e) => e.code === 'ARCHIVED');
  // the seeded routines, all disabled: the genre scout (archived line) cannot be armed; R3: the COO's report and the CEO's memo (hired)
  // can, behind the spend confirmation (tests/r3-execs.test.mjs)
  const rs = Object.fromEntries(engine.store.listRoutines().map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(rs).sort(), ['rt_seed_ceo-weekly-memo', 'rt_seed_coo-daily-report', 'rt_seed_weekly-genre-scout']);
  for (const x of Object.values(rs)) assert.equal(x.enabled, false, x.id);
  const gs = rs['rt_seed_weekly-genre-scout'];
  assert.throws(() => engine.routines.enable(gs.id, true, { expectedVersion: gs.version }), (e) => e.code === 'ARCHIVED' && /cannot be armed/.test(e.message));
  for (const id of ['rt_seed_coo-daily-report', 'rt_seed_ceo-weekly-memo']) assert.deepEqual([rs[id].product_id, rs[id].department_id], [STATION, HQ], id);
  assert.match((await engine.runRoutine(gs)).skipped, /^archived/);
  assert.equal(engine.store.listJobs().filter((j) => j.id !== '2026-10-21--old').length, 0, 'nothing was created');
  // the spend dialog refuses the archived line's routine too
  assert.throws(() => engine.spend.gate('routine-arm', { id: gs.id }), /target cannot run|confirm first/);
});

test('3: the archive sandbox runs only on the mock provider', (t) => {
  const r = tempRoot('r1sandbox'); t.after(r.cleanup);
  const prev = { p: process.env.STATION_PROVIDER, i: process.env.STATION_INSTANCE };
  process.env.STATION_PROVIDER = 'live'; process.env.STATION_INSTANCE = 'live';
  try { assert.throws(() => createEngine({ J: r.J, log: r.log, archiveSandbox: true, startScheduler: false }), (e) => e.code === 'ARCHIVED' || /live/.test(e.message)); }
  finally { if (prev.p === undefined) delete process.env.STATION_PROVIDER; else process.env.STATION_PROVIDER = prev.p; if (prev.i === undefined) delete process.env.STATION_INSTANCE; else process.env.STATION_INSTANCE = prev.i; }
  // R2a.1: the refused start closed what it had opened (the store, the e-stop watcher): its folder can be removed at once
  assert.ok(removeTempDir(r.base), 'a refused start holds no file in its data root');
});

// ---- 4. the spend guard

const guardFor = (t, { products, agentRunCap = () => null, caps = { ...CAPS, perRunUsd: 5, perJobUsd: 5, perDayUsd: 100, perLineDayUsd: { default: 100 } } }) => {
  const r = tempRoot('r1guard'); const P = Object.fromEntries(products.map((p) => [p.id, p]));
  const pdOf = (x) => ({ productId: x.productId || x.line || 'station', departmentId: x.departmentId || 'engineering' });
  const ledger = createLedger({ J: r.J, log: r.log, productOf: pdOf }), halt = createHalt({ J: r.J, log: r.log });
  t.after(() => { halt.close(); r.cleanup(); });
  const guard = createGuard({ J: r.J, ledger, halt, caps, pricing: PRICING, log: r.log, products: { get: (id) => P[id] || null, resolve: pdOf, jobCap: (p, d) => (P[p] && P[p].jobCapUsdByDepartment ? P[p].jobCapUsdByDepartment[d] ?? null : null), agentRunCap } });
  const call = (o) => { const res = guard.reserve({ provider: 'test', model: 'cheap-model', kind: 'text', inputTokens: 10000, maxOutputTokens: 10000, ...o }); guard.settle(res, { usage: { input_tokens: 10000, output_tokens: 10000 } }); return res; };   // USD 0.06 each
  return { guard, ledger, call };
};

test('4: the guard: a product\'s monthly budget and day cap, its department\'s job cap and an agent\'s run cap each refuse the call that would pass them; the lowest limit wins', (t) => {
  const { ledger, call } = guardFor(t, { products: [{ id: 'replydesk', monthlyBudgetUsd: 0.2, dailyCapUsd: null, jobCapUsdByDepartment: { engineering: 0.13 } }, { id: 'emty-inbox', monthlyBudgetUsd: 50, dailyCapUsd: 0.13, jobCapUsdByDepartment: {} }], agentRunCap: (k) => (k === 'ceo' ? 0.1 : null) });
  call({ runId: 'a1', jobId: 'j1', productId: 'replydesk', departmentId: 'engineering' }); call({ runId: 'a2', jobId: 'j1', productId: 'replydesk', departmentId: 'engineering' });
  assert.throws(() => call({ runId: 'a3', jobId: 'j1', productId: 'replydesk', departmentId: 'engineering' }), (e) => e instanceof CapError && e.cap === 'perJob[engineering@replydesk]' && e.limit === 0.13);
  call({ runId: 'b1', jobId: 'j2', productId: 'replydesk', departmentId: 'engineering' });
  assert.throws(() => call({ runId: 'b2', jobId: 'j3', productId: 'replydesk', departmentId: 'engineering' }), (e) => e.cap === 'productMonth[replydesk]' && e.limit === 0.2);
  call({ runId: 'c1', jobId: 'k1', productId: 'emty-inbox', departmentId: 'engineering' }); call({ runId: 'c2', jobId: 'k2', productId: 'emty-inbox', departmentId: 'engineering' });
  assert.throws(() => call({ runId: 'c3', jobId: 'k3', productId: 'emty-inbox', departmentId: 'engineering' }), (e) => e.cap === 'productDay[emty-inbox]' && e.limit === 0.13);
  call({ runId: 'm1', agentKey: 'ceo', productId: 'station', departmentId: 'hq' });
  assert.throws(() => call({ runId: 'm1', agentKey: 'ceo', productId: 'station', departmentId: 'hq' }), (e) => e.cap === 'perRun[ceo]' && e.limit === 0.1);
  assert.deepEqual([ledger.rows()[0].productId, ledger.rows()[0].departmentId], ['replydesk', 'engineering']);
  assert.equal(ledger.spent.productMonth('replydesk', dublinDay().slice(0, 7)), 0.18);
});

test('4: budgets and caps come from config: ReplyDesk USD 80 a month (owner, R2 deploy prep, 28/10/2026; USD 60 at R0.3) and USD 3.00 per engineering job (owner, R0.3); the rest marked as proposals; the station\'s day cap stays the outer limit', (t) => {
  const p = (id) => C.product(id);
  assert.deepEqual([p('replydesk').monthlyBudgetUsd, p('replydesk').jobCapUsdByDepartment.engineering, p('emty-inbox').monthlyBudgetUsd, p('station').monthlyBudgetUsd, p('etsy-shop').monthlyBudgetUsd], [80, 3, 40, 20, 200]);
  assert.ok(!p('replydesk').proposals.includes('monthlyBudgetUsd') && !p('replydesk').proposals.includes('jobCapUsdByDepartment.engineering'), 'decided by the owner');
  assert.ok(p('replydesk').decided.monthlyBudgetUsd.startsWith('owner, R2 deploy prep (28/10/2026): USD 80'));
  assert.ok(p('replydesk').decided['jobCapUsdByDepartment.engineering'].startsWith('owner, R0.3'));
  assert.ok(p('emty-inbox').proposals.includes('monthlyBudgetUsd') && p('station').proposals.includes('monthlyBudgetUsd'), 'proposals');
  for (const d of ['security-data', 'product-design', 'sales-marketing', 'customer-success']) { assert.equal(p('replydesk').jobCapUsdByDepartment[d], 0.5); assert.ok(p('replydesk').proposals.includes('jobCapUsdByDepartment.' + d)); }
  // R1.1: an HQ exec run (the CEO's memo, the COO's report) USD 0.50 per job, a proposal, in place of the station's USD 7.00
  assert.equal(p('station').jobCapUsdByDepartment.hq, 0.5); assert.ok(p('station').proposals.includes('jobCapUsdByDepartment.hq'));
  assert.equal(REAL.engine.caps.perDayUsd, 10, 'the day cap is unchanged in R1');
  // the engine wires them into the guard: an engineering job on ReplyDesk is capped at 3.00, below the station's 7.00
  const { engine } = engineOn(t, { tag: 'r1caps' });
  engine.store.insertJob({ id: '2026-10-23--eng', line: 'research', kind: 'line', state: 'queued', product_id: 'replydesk', department_id: 'engineering' });
  const res = engine.guard.reserve({ provider: 'mock', model: 'm', kind: 'text', runId: 'r1', jobId: '2026-10-23--eng', inputTokens: 10, maxOutputTokens: 10 });
  assert.deepEqual([res.productId, res.departmentId], ['replydesk', 'engineering']); engine.guard.release(res, 'test');
});

test('4: Claude Opus 5.5 is refused: it has no price, and a price that does not cite Anthropic\'s official pricing page with who verified it counts as none', (t) => {
  assert.equal(REAL.engine.pricing.anthropic.models['claude-opus-5-5'], undefined, 'no Opus price in config (the owner adds one from the official page)');
  const r = tempRoot('r1opus'); const ledger = createLedger({ J: r.J, log: r.log }), halt = createHalt({ J: r.J, log: r.log }); t.after(() => { halt.close(); r.cleanup(); });
  const g = (pricing) => createGuard({ J: r.J, ledger, halt, caps: REAL.engine.caps, pricing, log: r.log });
  const opus = { provider: 'anthropic', model: 'claude-opus-5-5', kind: 'text', runId: 'r', inputTokens: 10, maxOutputTokens: 10 };
  assert.throws(() => g(REAL.engine.pricing).reserve(opus), (e) => e instanceof GuardRefusal && e.code === 'PRICE' && /no price in config\/engine\.json for anthropic claude-opus-5-5/.test(e.message));
  const withOpus = (entry) => ({ ...REAL.engine.pricing, anthropic: { models: { ...REAL.engine.pricing.anthropic.models, 'claude-opus-5-5': entry } } });
  assert.throws(() => g(withOpus({ inPerM: 1, outPerM: 1 })).reserve(opus), (e) => e.code === 'PRICE' && /no verified price/.test(e.message), 'no source');
  assert.throws(() => g(withOpus({ inPerM: 1, outPerM: 1, source: 'https://example.com/pricing', verified: 'someone' })).reserve(opus), (e) => e.code === 'PRICE', 'another source');
  assert.throws(() => g(withOpus({ inPerM: 1, outPerM: 1, source: OFFICIAL_PRICING })).reserve(opus), (e) => e.code === 'PRICE', 'not verified');
  // the verified Haiku and Sonnet prices still pass
  const ok = g(REAL.engine.pricing).reserve({ ...opus, model: 'claude-haiku-5-5' }); assert.ok(ok.maxUsd > 0);
});

// ---- 5. the policy

test('5: an action not in config/autonomy.json is forbidden (fail closed), and a forbidden tool refuses the run before any reservation', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1unknown' });
  await assert.rejects(engine.actions.perform({ action: 'made.up.action', actor: { kind: 'engine' }, productId: 'replydesk', execute: () => assert.fail('ran') }), (e) => e instanceof PolicyRefusal && /not in config\/autonomy\.json, so it is forbidden/.test(e.message));
  assert.equal(engine.policy.level('made.up.action'), 'forbidden');
  // a product that forbids drafts: a hired agent on that product is refused before any call (nothing reserved, USD 0)
  const r0 = tempRoot('r1forbidtool'); t.after(r0.cleanup);
  const dir = configCopy(r0.base, { 'products/replydesk.json': (o) => { o.policy = { 'draft.write': 'forbidden' }; }, 'agents/product-manager.json': hire() }), pd = promptsCopy(r0.base, ['product-manager']);
  const { engine: e2, r } = engineOn(t, { tag: 'r1forbidrun', configDir: dir, promptsDir: pd });
  e2.store.insertJob({ id: '2026-10-23--pm', line: 'research', kind: 'line', state: 'queued', product_id: 'replydesk', department_id: 'product-design' });
  const folder = path.join(r.dataRoot, 'products', 'replydesk', 'pm'); fs.mkdirSync(folder, { recursive: true });
  await assert.rejects(runAgent(e2, { agentKey: 'product-manager', job: e2.store.getJob('2026-10-23--pm'), folder, input: 'roadmap' }), (e) => e instanceof PolicyRefusal && /tool fs_write \(draft\.write\) is forbidden for replydesk/.test(e.message));
  assert.equal(e2.ledger.totals.rows, 0); assert.equal(e2.store.runsOf({ agentKey: 'product-manager' }).length, 0);
});

test('5: the policy file\'s changes are logged at start: every action once on the first start, nothing when it is unchanged, one row per changed action after an edit', (t) => {
  const r = tempRoot('r1policylog'); t.after(r.cleanup);
  const e1 = createEngine({ J: r.J, log: r.log, startScheduler: false, instance: { name: 'dev', commit: 'a'.repeat(40) } }); e1.close();
  const first = policyLog(r.dataRoot);
  assert.equal(first.length, Object.keys(REAL.policy.levels).length); assert.ok(first.every((x) => x.first && x.old === null && x.commit === 'a'.repeat(40) && x.instance === 'dev'));
  const e2 = createEngine({ J: r.J, log: r.log, startScheduler: false }); e2.close();
  assert.equal(policyLog(r.dataRoot).length, first.length, 'unchanged: nothing logged');
  const dir = configCopy(r.base, { 'autonomy.json': (o) => { o.levels['draft.write'] = 'owner'; o.levels['backlog.write'] = 'forbidden'; o.$comment += ' (edited)'; } });
  const e3 = createEngine({ J: r.J, log: r.log, configDir: dir, startScheduler: false, instance: { name: 'dev', commit: 'b'.repeat(40) } });
  try { assert.ok(e3.bus.recent(20).some((e) => e.type === 'policy.changed' && e.data.rows === 2)); } finally { e3.close(); }
  const rows = policyLog(r.dataRoot).slice(first.length);
  assert.deepEqual(rows.map((x) => [x.action, x.old, x.new, x.first, x.commit]), [['backlog.write', 'auto', 'forbidden', false, 'b'.repeat(40)], ['draft.write', 'auto', 'owner', false, 'b'.repeat(40)]]);
  const e4 = createEngine({ J: r.J, log: r.log, configDir: dir, startScheduler: false }); e4.close();
  assert.equal(policyLog(r.dataRoot).length, first.length + 2, 'logged once');
});

// ---- 6. records key on product and department

test('6: a job, its runs, routines and ledger rows carry product and department, never a floor; moving a department to another floor changes no record', (t) => {
  const r = tempRoot('r1floor'); t.after(r.cleanup);
  const e1 = createEngine({ J: r.J, log: r.log, startScheduler: false });
  e1.store.insertJob({ id: '2026-10-23--cs', line: 'research', kind: 'line', state: 'queued', product_id: 'replydesk', department_id: 'customer-success' });
  e1.ledger.append({ jobId: '2026-10-23--cs', runId: null, agentKey: null, line: null, provider: 'mock', model: 'm', kind: 'text', usd: 0 });
  const cols = (t2) => e1.store.db.prepare('PRAGMA table_info(' + t2 + ')').all().map((c) => c.name);
  for (const t2 of PRODUCT_TABLES) { assert.ok(cols(t2).includes('product_id') && cols(t2).includes('department_id'), t2); assert.ok(!cols(t2).some((c) => /floor/.test(c)), t2 + ' has no floor column'); }
  const dump = (s) => JSON.stringify(PRODUCT_TABLES.map((t2) => s.db.prepare('SELECT * FROM ' + t2 + ' ORDER BY 1').all()));
  const before = dump(e1.store), ledgerBefore = fs.readFileSync(path.join(r.dataRoot, 'ledger', 'ledger.jsonl'), 'utf8');
  assert.ok(!/"floor"/.test(ledgerBefore));
  e1.close();
  // Customer Success and the Etsy archive swap floors (display only)
  const dir = configCopy(r.base, { 'departments/customer-success.json': (o) => { o.floor = 'G'; }, 'departments/etsy.json': (o) => { o.floor = '1'; } });
  const e2 = createEngine({ J: r.J, log: r.log, configDir: dir, startScheduler: false });
  try {
    assert.equal(dump(e2.store), before, 'no record changed'); assert.equal(fs.readFileSync(path.join(r.dataRoot, 'ledger', 'ledger.jsonl'), 'utf8'), ledgerBefore);
    assert.deepEqual(e2.company.floors().map((d) => d.id).slice(-2), ['etsy', 'customer-success']);
    assert.deepEqual([e2.store.getJob('2026-10-23--cs').product_id, e2.store.getJob('2026-10-23--cs').department_id], ['replydesk', 'customer-success']);
  } finally { e2.close(); }
});

// ---- 7. the Owner's office in the snapshot

test('7: the snapshot: the seven floors with their agents, the products (Finance: spend against budget, MRR not connected), the requests queue, the policy and its log', (t) => {
  const { engine } = engineOn(t, { tag: 'r1snap' });
  const req = engine.requests.file({ action: 'dependency.add', productId: 'replydesk', departmentId: 'engineering', summary: 'add ruff as a dev requirement', payload: 'ruff==0.x', actor: { kind: 'engine' } });
  const s = buildEngineSnapshot(engine);
  assert.deepEqual(s.company.floors.map((f) => f.floor), ['6', '5', '4', '3', '2', '1', 'G']);
  assert.deepEqual(s.company.floors.find((f) => f.id === 'etsy').lines.map((l) => [l.id, l.archived]).sort(), [['genre-scout', true], ['research', true], ['room1-digital', true]]);
  assert.equal(s.company.floors.reduce((n, f) => n + f.agents.filter((a) => a.status === 'not-hired').length, 0), 11, 'R3: 19 less the six of R2 and the CEO and COO');
  assert.equal(s.company.floors.reduce((n, f) => n + f.agents.filter((a) => a.status === 'active').length, 0), 8, 'R2: the engineering six; R3: the CEO and the COO');
  assert.deepEqual(s.spend.byProduct.map((p) => [p.id, p.budgetUsd, p.budgetProposal, p.mrr]).sort(), [['emty-inbox', 40, true, 'not connected'], ['etsy-shop', 200, false, 'not connected'], ['replydesk', 80, false, 'not connected'], ['station', 20, true, 'not connected']]);
  const oo = s.company.ownersOffice;
  assert.deepEqual([oo.pending, oo.requests[0].id, oo.requests[0].action, oo.requests[0].status, oo.requests[0].productId], [1, req.id, 'dependency.add', 'pending', 'replydesk']);
  assert.deepEqual(oo.policy.counts, { auto: 25, owner: 15, forbidden: 17 }); assert.ok(oo.policy.log.length > 0); assert.match(oo.policy.source, /the page cannot/);
  assert.deepEqual(oo.pausedLines, []);
  // the page renders the penthouse in the building view: the request with Approve and Reject, Finance, the floors, the policy
  const body = { innerHTML: '', querySelectorAll: () => [] }, root = { querySelector: () => body, classList: { add() {}, remove() {}, contains: () => true } };
  createBuildingView({ root }).render(s);
  for (const x of ['Penthouse · the Owner\'s office', 'add ruff as a dev requirement', 'data-req="' + req.id + '" data-decision="approve"', 'data-decision="reject"', 'Finance (from the ledger)', 'ReplyDesk</span> this month', 'MRR not connected', 'Autonomy policy', 'not hired yet (R4)', 'COO · daily operations report', 'CEO · weekly memo and proposals', 'data-exec-run="coo-report"', 'Lobby: Etsy archive']) assert.ok(body.innerHTML.includes(x), x);
});
