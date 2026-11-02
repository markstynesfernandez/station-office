// b0.test.mjs — B0 (owner, 21/10/2026): the Station is one building that runs several businesses; each business is a floor.
//   1 a business is a config object (config/businesses/<id>.json); the template is never loaded; a bad business stops the engine
//   2 every job, run, routine, approval, ledger row and event carries business_id; npm run migrate:businesses backfills an older data
//     root (dry run by default, a backup first, idempotent, every change logged, refused while an engine holds the lock)
//   3 the spend guards gain a business level (its monthly budget, its own day cap); the lowest limit wins; the dialog shows it
//   4 an agent's file tools are jailed to its business's data: another business's dataDir is never reachable
//   6 the building's floors: floor 0 (shared services and the lounge), floor 1 (etsy-shop, no lounge), an empty floor for a business
//     with no lines; what each floor shows and the whole-building totals
//   7 building rules: outbound only when a business allows it; another company's data never enters the Station
// R1 (owner, 23/10/2026): config/businesses/ is retired. B0's view (cfg.businesses, the shared floor) is derived from config/products and
// config/departments (building.mjs compatBuilding); these tests keep what B0 guarantees on top of that: business_id still on every record,
// the jail per data area, the floors the page draws until R7, the building rules. The guard's business level is the product level now.
// Mock provider only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRoot, PRICING, CAPS } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { openStore, BUSINESS_TABLES } from '../src/engine/store/db.mjs';
import { createLedger } from '../src/engine/ledger.mjs';
import { createGuard, CapError } from '../src/engine/guard.mjs';
import { createHalt } from '../src/engine/halt.mjs';
import { createToolbox } from '../src/engine/tools/index.mjs';
import { building, validateBusinesses, readBusinesses, businessDataArea, inBusinessArea, outboundOwner, foreignDataHits, SHARED, DEFAULT_BUSINESS } from '../src/engine/business.mjs';
import { migrateBusinesses } from '../src/engine/lib/migrate-businesses.mjs';
import { migrateProducts } from '../src/engine/lib/migrate-products.mjs';
import { withDefaults } from '../src/engine/business.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { floorSnapshot, buildingTotals, pickFloor } from '../src/web/ui/floors.js';
import { spendHtml } from '../src/web/ui/controls.js';
import { computeLayout, bakedRoomSpec } from '../src/web/scene/layout.js';
import { dublinDay } from '../src/engine/time.mjs';
import { createDryRunScript, JOB_A } from '../fixtures/engine/mock-script.mjs';

const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts'), FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const brief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());

function lineEngine(t, { tag = 'b0', configDir = CONFIG } = {}) {
  const r = tempRoot(tag);
  const station = loadConfig({ configDir, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createDryRunScript({ cfg: station }), configDir, overrides: OVERRIDES, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  return { engine, r };
}

// ---- 1. the business config

test('1 (R1): etsy-shop is B0\'s business, derived from the archived Etsy department and product (floor 1 on the page until R7, its lines, agents and rooms, budget USD 200); config/businesses/ is retired; OVERSEER and the not-hired agents are on the shared floor', () => {
  assert.ok(!fs.existsSync(path.join(CONFIG, 'businesses')), 'config/businesses/ is retired');
  assert.deepEqual(REAL.businesses.map((b) => b.id), ['etsy-shop'], 'one archived department with a product');
  const b = REAL.businesses[0];
  assert.deepEqual([b.name, b.floor, b.monthlyBudgetUsd, b.dailyCapUsd, b.dataDir, b.ownerApprovalRequired], ['TheStationShopFinds', 1, 200, null, '.', true]);
  assert.deepEqual(b.lines.sort(), ['genre-scout', 'research', 'room1-digital'], 'the Etsy lines are etsy-shop\'s');
  assert.deepEqual(REAL.office.shared.lines.sort(), ['ceo-memo', 'coo-report', 'eng-triage', 'engineering'], 'R2: the engineering lines are B0\'s shared floor\'s; R3: the executives\' lines too');
  assert.deepEqual(b.departments, ['research', 'design', 'office']);
  assert.deepEqual(b.allowedOutbound, ['etsy:read-own-shop']);
  const B = building(REAL);
  assert.equal(B.ofAgent('overseer'), SHARED); assert.equal(B.ofAgent('designer'), 'etsy-shop'); assert.equal(B.ofLine('room1-digital'), 'etsy-shop');
  assert.deepEqual(REAL.office.shared.departments, ['finance', 'compliance', 'overseer']);
  assert.equal(B.ofAgent('ceo'), SHARED, 'a not-hired HQ agent is B0\'s shared floor'); assert.equal(B.ofAgent('developer'), SHARED);
  assert.deepEqual(B.floors().map((f) => [f.floor, f.id]), [[0, SHARED], [1, 'etsy-shop']]);
  assert.deepEqual(readBusinesses(CONFIG), [], 'nothing is read from config/businesses');
});

test('1: a bad business is refused with the reason (and the engine does not start)', (t) => {
  const v = (patch, extra = []) => validateBusinesses({ businesses: [{ ...REAL.businesses[0], file: 'etsy-shop.json', ...patch }, ...extra], engine: REAL.engine, lines: REAL.lines, agents: REAL.agents, office: REAL.office }).join(' | ');
  assert.equal(v({}), '');
  assert.match(v({ dailyCapUsd: 11 }), /dailyCapUsd must be a positive number at most the station's day cap \(USD 10\.00\)/);
  assert.match(v({ ownerApprovalRequired: false }), /ownerApprovalRequired cannot be false \(building rule/);
  assert.match(v({ allowedOutbound: ['email:send'] }), /allowedOutbound "email:send" is not an outbound action the Station knows/);
  assert.match(v({ lines: ['research'] }), /line room1-digital belongs to no business/);
  assert.match(v({ agents: ['designer'] }), /line research uses agent demand-researcher, which the business does not list/);
  assert.match(v({}, [{ id: 'b2', file: 'b2.json', name: 'B2', floor: 1, departments: ['design'], lines: [], agents: [], monthlyBudgetUsd: 5, dataDir: 'elsewhere/' }]), /floor 1 is taken.*department design belongs to both business etsy-shop and business b2.*dataDir must be businesses\/b2\//);
  assert.match(v({}, [{ id: 'b2', file: 'b2.json', name: 'B2', floor: 2, departments: [], lines: [], agents: [], monthlyBudgetUsd: 5, dataDir: '.' }]), /only one business may keep today's layout/);
  // R1: the engine refuses a config whose building does not hold (here the Etsy department on a floor that does not exist)
  const r = tempRoot('b0badcfg'); t.after(() => r.cleanup());
  const dir = path.join(r.base, 'config'); fs.cpSync(CONFIG, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'departments', 'etsy.json'), JSON.stringify({ ...readJson(path.join(CONFIG, 'departments', 'etsy.json')), floor: '0' }));
  assert.throws(() => createEngine({ archiveSandbox: true, J: r.J, log: r.log, configDir: dir, startScheduler: false }), /the building does not hold: config\/departments\/etsy.json: floor must be one of 6, 5, 4, 3, 2, 1, G/);
});

// ---- 2. business_id on every record

test('2: a job on the line: its job, runs, approval, ledger rows and events carry etsy-shop; the seeded routine too; station-wide events are "shared"', async (t) => {
  const { engine, r } = lineEngine(t, { tag: 'b0ids' });
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; '));
  const job = await engine.orchestrator.startJob(JOB_A);
  assert.equal(job.state, 'approval', job.reason);
  const db = engine.store.db, col = (t2) => db.prepare('SELECT business_id b, COUNT(*) n FROM ' + t2 + ' GROUP BY business_id').all().map((x) => ({ ...x }));
  assert.deepEqual(col('jobs'), [{ b: 'etsy-shop', n: 1 }]);
  assert.ok(col('runs').every((x) => x.b === 'etsy-shop') && col('runs')[0].n > 3);
  assert.deepEqual(col('approvals'), [{ b: 'etsy-shop', n: 1 }]);
  assert.deepEqual(col('routines'), [{ b: 'etsy-shop', n: 1 }, { b: 'shared', n: 2 }], 'the seeded genre-scout routine (Etsy), the COO\'s report (HQ, R1) and the CEO\'s memo (HQ, R3)');
  // R1: and product_id + department_id on every record
  const pd = (t2) => db.prepare('SELECT product_id p, department_id d, COUNT(*) n FROM ' + t2 + ' GROUP BY product_id, department_id').all().map((x) => ({ ...x }));
  assert.deepEqual(pd('jobs'), [{ p: 'etsy-shop', d: 'etsy', n: 1 }]); assert.deepEqual(pd('approvals'), [{ p: 'etsy-shop', d: 'etsy', n: 1 }]);
  assert.deepEqual(pd('routines'), [{ p: 'etsy-shop', d: 'etsy', n: 1 }, { p: 'station', d: 'hq', n: 2 }], 'R3: the COO\'s report and the CEO\'s memo');
  assert.ok(pd('runs').every((x) => x.p === 'etsy-shop' && x.d === 'etsy')); assert.ok(pd('ledger_mirror').every((x) => x.p === 'etsy-shop' && x.d === 'etsy'));
  assert.ok(engine.ledger.rowsForJob(JOB_A).every((x) => x.businessId === 'etsy-shop'));
  assert.ok(col('ledger_mirror').every((x) => x.b === 'etsy-shop'));
  const evs = fs.readdirSync(path.join(r.dataRoot, 'events')).flatMap((f) => fs.readFileSync(path.join(r.dataRoot, 'events', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  assert.ok(evs.length > 10 && evs.every((e) => typeof e.businessId === 'string'));
  assert.ok(evs.filter((e) => e.jobId === JOB_A).every((e) => e.businessId === 'etsy-shop'));
  assert.equal(evs.find((e) => e.type === 'engine.start').businessId, SHARED);
  assert.ok(evs.every((e) => typeof e.productId === 'string' && typeof e.departmentId === 'string'));
  assert.deepEqual([evs.find((e) => e.type === 'engine.start').productId, evs.find((e) => e.type === 'engine.start').departmentId], ['station', 'hq']);
  assert.deepEqual(engine.store.businessGaps(), { missingColumn: [], nullRows: {} });
  assert.deepEqual(engine.store.productGaps(), { missingColumn: [], nullRows: {} });
});

// a data root written before B0: the tables without business_id, a ledger and events without businessId
function preB0Root(t, tag) {
  const r = tempRoot(tag); t.after(() => r.cleanup());
  const store = openStore({ J: r.J, log: r.log });
  const now = Date.now(), ins = (sql, ...a) => store.db.prepare(sql).run(...a);
  ins("INSERT INTO jobs (id, line, kind, state, created_at, updated_at) VALUES ('2026-10-19--a', 'room1-digital', 'line', 'approval', ?, ?)", now, now);
  ins("INSERT INTO jobs (id, line, kind, state, created_at, updated_at) VALUES ('2026-10-20--r', 'research', 'research', 'research-done', ?, ?)", now, now);
  ins("INSERT INTO jobs (id, line, kind, state, created_at, updated_at, legacy) VALUES ('2026-10-01--old', 'room1-etsy', 'legacy', 'parked', ?, ?, 1)", now, now);
  ins("INSERT INTO runs (run_id, job_id, agent_key, status, started_at) VALUES ('run_a', '2026-10-19--a', 'designer', 'done', ?)", now);
  ins("INSERT INTO runs (run_id, job_id, agent_key, status, started_at) VALUES ('run_o', NULL, 'overseer', 'done', ?)", now);
  ins("INSERT INTO routines (id, name, target, schedule, created_at, updated_at) VALUES ('rt_1', 'scout', 'line:genre-scout', '0 9 * * 1', ?, ?)", now, now);
  ins("INSERT INTO approvals (job_id, status, queued_at) VALUES ('2026-10-19--a', 'pending', ?)", now);
  const rows = [{ entryId: 'l1', ts: now, jobId: '2026-10-19--a', runId: 'run_a', agentKey: 'designer', line: 'room1-digital', provider: 'mock', model: 'm', kind: 'text', usd: 0 }, { entryId: 'l2', ts: now, jobId: null, runId: null, agentKey: null, line: null, provider: 'etsy-mock', model: 'shop', kind: 'etsy', usd: 0 }, { entryId: 'l3', ts: now, jobId: null, runId: null, agentKey: null, line: null, provider: 'mock', model: 'smoke', kind: 'text', usd: 0 }];
  for (const x of rows) store.mirrorLedger(x);
  for (const t2 of BUSINESS_TABLES) { store.db.exec('ALTER TABLE ' + t2 + ' DROP COLUMN business_id'); store.db.exec('ALTER TABLE ' + t2 + ' DROP COLUMN product_id'); store.db.exec('ALTER TABLE ' + t2 + ' DROP COLUMN department_id'); }
  store.db.exec('DROP TABLE requests');
  store.close();
  r.J.put(path.join(r.dataRoot, 'ledger', 'ledger.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  r.J.put(path.join(r.dataRoot, 'events', '2026-10-20.jsonl'), JSON.stringify({ seq: 1, ts: now, type: 'job.created', jobId: '2026-10-19--a', agentKey: null, data: {} }) + '\n' + JSON.stringify({ seq: 2, ts: now, type: 'engine.start', jobId: null, agentKey: null, data: {} }) + '\n');
  return r;
}
const caplog = () => { const lines = []; const put = (lvl) => (msg, data) => lines.push({ lvl, msg, data: data || {} }); return { lines, info: put('info'), warn: put('warn'), error: put('error') }; };
const sha = (f) => fs.existsSync(f) ? fs.readFileSync(f).toString('base64').length + ':' + fs.statSync(f).size : null;

test('2: migrate:businesses: the engine refuses an older root; the dry run writes nothing; apply backs up first, sets every record, logs each; a second run changes nothing; the logs are never rewritten', (t) => {
  const r = preB0Root(t, 'b0mig');
  assert.throws(() => createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false }), (e) => e.code === 'MIGRATE' && /jobs: no business_id column/.test(e.message) && /npm run migrate:businesses/.test(e.message));
  const dbf = path.join(r.dataRoot, 'station.db'), before = fs.readFileSync(dbf), ledgerBefore = fs.readFileSync(path.join(r.dataRoot, 'ledger', 'ledger.jsonl'), 'utf8');
  // the dry run
  const L1 = caplog(), dry = migrateBusinesses({ J: r.J, cfg: REAL, log: L1, now: () => Date.parse('2026-10-21T13:00:00Z') });
  assert.equal(dry.applied, false); assert.equal(dry.backup, null); assert.deepEqual(dry.unmapped, []);
  assert.deepEqual(dry.tables.jobs, { rows: 3, column: 'missing', already: 0, toSet: { 'etsy-shop': 3 }, toSetRows: 3 }, 'the legacy job too');
  assert.deepEqual(dry.tables.runs.toSet, { 'etsy-shop': 1, shared: 1 }, 'OVERSEER\'s run is the shared floor\'s');
  assert.deepEqual([dry.tables.routines.toSet, dry.tables.approvals.toSet, dry.tables.ledger_mirror.toSet], [{ 'etsy-shop': 1 }, { 'etsy-shop': 1 }, { 'etsy-shop': 2, shared: 1 }], 'the own-shop Etsy call is etsy-shop\'s; a station-wide call is the shared floor\'s');
  assert.deepEqual(dry.logs.ledger, { file: 'ledger/ledger.jsonl', rows: 3, withBusiness: 0, resolved: { 'etsy-shop': 2, shared: 1 }, unreadable: 0, rewritten: false });
  assert.deepEqual([dry.logs.events.rows, dry.logs.events.resolved], [2, { 'etsy-shop': 1, shared: 1 }]);
  assert.equal(L1.lines.filter((x) => x.msg === 'business_id would be set').length, 3 + 2 + 1 + 1 + 3);
  assert.ok(fs.readFileSync(dbf).equals(before), 'the dry run wrote nothing'); assert.ok(!fs.existsSync(path.join(r.dataRoot, '.backups')));
  // apply
  const L2 = caplog(), done = migrateBusinesses({ J: r.J, cfg: REAL, log: L2, apply: true, now: () => Date.parse('2026-10-21T13:00:00Z') });
  assert.equal(done.applied, true); assert.equal(done.backup.dir, '.backups/businesses-20261021T130000Z');
  assert.ok(fs.existsSync(path.join(r.dataRoot, '.backups', 'businesses-20261021T130000Z', 'station.db')) && fs.existsSync(path.join(r.dataRoot, '.backups', 'businesses-20261021T130000Z', 'BACKUP.json')));
  assert.equal(L2.lines.filter((x) => x.msg === 'business_id set').length, 10); assert.equal(L2.lines.filter((x) => x.msg === 'business_id column added').length, 5);
  assert.equal(fs.readFileSync(path.join(r.dataRoot, 'ledger', 'ledger.jsonl'), 'utf8'), ledgerBefore, 'the ledger is never rewritten');
  // a second run changes nothing (and takes no second backup)
  const again = migrateBusinesses({ J: r.J, cfg: REAL, log: caplog(), apply: true });
  assert.deepEqual([again.applied, again.nothingToDo, again.backup], [false, true, null]);
  assert.equal(fs.readdirSync(path.join(r.dataRoot, '.backups')).length, 1);
  // R1: the root is post-B0 now, and the engine asks for migrate:products; once applied it starts and reads the old rows
  assert.throws(() => createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false }), (e2) => e2.code === 'MIGRATE' && /npm run migrate:products/.test(e2.message));
  assert.equal(migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true, now: () => Date.parse('2026-10-23T13:00:00Z') }).applied, true);
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false, resume: false });
  try {
    assert.equal(e.store.getJob('2026-10-01--old').business_id, 'etsy-shop');
    assert.equal(e.store.getRun('run_o').business_id, SHARED);
    assert.equal(e.ledger.spent.businessMonth('etsy-shop', dublinDay().slice(0, 7)), 0);
    assert.deepEqual(e.store.businessGaps(), { missingColumn: [], nullRows: {} });
    assert.deepEqual([e.store.getJob('2026-10-01--old').product_id, e.store.getRun('run_o').department_id], ['etsy-shop', 'hq'], 'OVERSEER\'s history stays in HQ');
  } finally { e.close(); }
});

test('2: migrate:businesses refuses while an engine holds the lock, and refuses to apply when a record cannot be mapped (nothing written)', (t) => {
  const r = preB0Root(t, 'b0lock');
  // an engine (another live process) holds the lock on this data root
  r.J.put(path.join(r.dataRoot, '.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }) + '\n');
  assert.throws(() => migrateBusinesses({ J: r.J, cfg: REAL, log: caplog(), apply: true }), (e) => e.code === 'LOCKED');
  fs.rmSync(path.join(r.dataRoot, '.lock'));
  const s = openStore({ J: r.J, log: r.log }); s.db.prepare("INSERT INTO jobs (id, line, kind, state, created_at, updated_at) VALUES ('2026-10-21--x', 'no-such-line', 'line', 'blocked', 1, 1)").run(); s.close();
  const dry = migrateBusinesses({ J: r.J, cfg: REAL, log: caplog() });
  assert.deepEqual(dry.unmapped, [{ table: 'jobs', id: '2026-10-21--x', why: 'line no-such-line belongs to no business (and the job is not a legacy job)' }]);
  assert.throws(() => migrateBusinesses({ J: r.J, cfg: REAL, log: caplog(), apply: true }), /refused: 1 record\(s\) could not be mapped to a business .*nothing was written/);
  assert.ok(!fs.existsSync(path.join(r.dataRoot, '.backups')));
});

test('2: npm run migrate:businesses is a dry run by default and writes only with --apply', (t) => {
  const r = preB0Root(t, 'b0script');
  const env = { ...process.env, STATION_DATA_ROOT: r.dataRoot, STATION_PROVIDER: 'mock', STATION_INSTANCE: 'dev' };
  const go = (...a) => spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'migrate-businesses.mjs'), ...a], { env, encoding: 'utf8', cwd: APP_ROOT });
  const out = (s) => { const a = s.search(/^\{$/m), b = s.lastIndexOf('\n}'); return JSON.parse(s.slice(a, b + 2)); };
  const dry = go(); assert.equal(dry.status, 0, dry.stderr);
  const p = out(dry.stdout); assert.equal(p.applied, false); assert.match(p.note, /^dry run: nothing written/);
  const app = go('--apply'); assert.equal(app.status, 0, app.stderr); assert.equal(out(app.stdout).applied, true);
  const two = go('--apply'); assert.equal(two.status, 0, two.stderr); assert.equal(out(two.stdout).note, 'nothing to change');
});

// ---- 3. the business level of the spend guards

test('3 (R1): the guard refuses a call past the product\'s monthly budget, or its own day cap (lower than the station\'s); a product without a budget record has the station\'s caps', (t) => {
  const pdOf = (x) => (x.line === 'room1-digital' ? { productId: 'etsy-shop', departmentId: 'etsy' } : { productId: 'station', departmentId: 'hq' });
  const r = tempRoot('b0guard'); const ledger = createLedger({ J: r.J, log: r.log, businessOf: (x) => x.businessId || (x.line === 'room1-digital' ? 'etsy-shop' : SHARED), productOf: pdOf }), halt = createHalt({ J: r.J, log: r.log });
  t.after(() => { halt.close(); r.cleanup(); });
  const biz = { 'etsy-shop': { id: 'etsy-shop', monthlyBudgetUsd: 0.2, dailyCapUsd: null } };
  const guard = createGuard({ J: r.J, ledger, halt, caps: { ...CAPS, perRunUsd: 5, perJobUsd: 5 }, pricing: PRICING, log: r.log, products: { get: (id) => biz[id] || null, resolve: pdOf } });
  const call = (i, line = 'room1-digital') => { const res = guard.reserve({ provider: 'test', model: 'cheap-model', kind: 'text', runId: 'r' + i, jobId: 'j' + i, line, inputTokens: 10000, maxOutputTokens: 10000 }); guard.settle(res, { usage: { input_tokens: 10000, output_tokens: 10000 } }); return res; };
  for (let i = 0; i < 3; i++) call(i);   // 3 x USD 0.06
  assert.throws(() => call(9), (e) => e instanceof CapError && e.cap === 'productMonth[etsy-shop]' && e.limit === 0.2);
  assert.deepEqual([ledger.rows()[0].businessId, ledger.rows()[0].productId, ledger.rows()[0].departmentId], ['etsy-shop', 'etsy-shop', 'etsy']);
  for (let i = 10; i < 14; i++) call(i, 'other');   // the station product here has no budget record: station caps only
  assert.equal(ledger.spent.productMonth('station', dublinDay().slice(0, 7)), 0.24); assert.equal(ledger.spent.businessMonth(SHARED, dublinDay().slice(0, 7)), 0.24);
  biz['etsy-shop'] = { id: 'etsy-shop', monthlyBudgetUsd: 100, dailyCapUsd: 0.25 };
  call(20);
  assert.throws(() => call(21), (e) => e.cap === 'productDay[etsy-shop]' && e.limit === 0.25);
});

test('3 (R1): the spend dialog shows the product (this month against its budget) and refuses a start past it', (t) => {
  const { engine } = lineEngine(t, { tag: 'b0quote' });
  const q = engine.spend.quote('research', { text: 'woodland niches' });
  assert.deepEqual([q.product.id, q.product.name, q.product.department, q.product.floor, q.product.budgetUsd, q.product.monthSpentUsd], ['etsy-shop', 'TheStationShopFinds', 'etsy', 'G', 200, 0]);
  assert.match(spendHtml(q), /<span class="m">product<\/span><span>TheStationShopFinds <span class="muted">\(Lobby: Etsy archive, floor G\)<\/span> · this month USD 0\.0000 of the budget USD 200\.00/);
  engine.company.product('etsy-shop').monthlyBudgetUsd = 0.5;
  const q2 = engine.spend.quote('research', { text: 'woodland niches' });
  assert.equal(q2.token, null); assert.match(q2.refusals.join(' | '), /TheStationShopFinds's monthly budget would be exceeded: this month USD 0\.00 \+ its open jobs up to USD 0\.00 \+ this up to USD 1\.00 = USD 1\.00, over USD 0\.50/);
});

// ---- 4. the data jail per business

test('4: an agent of one business cannot read or write another business\'s dataDir (the folder itself, or a path in it)', async (t) => {
  const r = tempRoot('b0jail'); t.after(() => r.cleanup());
  // R1: B0's second business is only a data area now (no config/businesses); a product's data (products/<id>/) is outside the Etsy area too
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false }), B = building(e.cfg);
  t.after(() => e.close());
  const etsyArea = businessDataArea(r.dataRoot, B.get('etsy-shop')), secondArea = businessDataArea(r.dataRoot, withDefaults({ id: 'second-shop', dataDir: 'businesses/second-shop/' }));
  assert.ok(!inBusinessArea(path.join(r.dataRoot, 'products', 'replydesk', 'x'), etsyArea), 'the Etsy archive never reaches a product\'s data');
  assert.ok(inBusinessArea(path.join(r.dataRoot, 'jobs', 'x'), etsyArea)); assert.ok(!inBusinessArea(path.join(r.dataRoot, 'businesses', 'second-shop', 'jobs'), etsyArea));
  assert.ok(inBusinessArea(path.join(r.dataRoot, 'businesses', 'second-shop', 'x'), secondArea)); assert.ok(!inBusinessArea(path.join(r.dataRoot, 'jobs', 'x'), secondArea));
  const etsyJob = path.join(r.dataRoot, 'jobs', '2026-10-21--etsy'), secondJob = path.join(r.dataRoot, 'businesses', 'second-shop', 'jobs', '2026-10-21--s');
  for (const d of [etsyJob, secondJob]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'brief.md'), 'secret of ' + path.basename(d)); }
  const agent = { ...e.cfg.agents.designer, tools: ['fs_read', 'fs_list', 'fs_write'], writes: ['notes.md'] };
  const box = (folder, area) => createToolbox({ J: e.J, folder, agent, job: null, cfg: { ...e.cfg }, guard: e.guard, providers: e.providers, run: { runId: 'run_j' }, halt: e.halt, log: r.log, bus: e.bus, line: null, businessArea: area });
  // each business inside its own data: works
  assert.match(await box(etsyJob, etsyArea).call('fs_read', { path: 'brief.md' }), /secret of 2026-10-21--etsy/);
  assert.match(await box(secondJob, secondArea).call('fs_read', { path: 'brief.md' }), /secret of 2026-10-21--s/);
  // a run whose folder lies in another business's data is refused before any tool runs
  assert.throws(() => box(secondJob, etsyArea), /the run's folder is outside its business's data/);
  assert.throws(() => box(etsyJob, secondArea), /the run's folder is outside its business's data/);
  // a link inside a business's folder into another business's data is refused on read and on write
  const link = path.join(etsyJob, 'peek');
  try { fs.symlinkSync(secondJob, link, 'junction'); } catch (_) { return; }   // no link rights on this machine: covered above
  await assert.rejects(box(etsyJob, etsyArea).call('fs_read', { path: 'peek/brief.md' }), /outside your (folder|business's data)/);
  await assert.rejects(box(etsyJob, etsyArea).call('fs_write', { path: 'peek/notes.md', content: 'x' }), /outside your (folder|business's data)|may not write/);
  assert.ok(!fs.existsSync(path.join(secondJob, 'notes.md')));
});

// ---- 6. the floors

test('6: the building\'s floors in the snapshot (B0\'s page until R7; R7a: drawn only for a snapshot without the company model): floor 0 (Finance, Compliance, OVERSEER, the lounge), floor 1 (etsy-shop, its jobs, no lounge); the totals', async (t) => {
  const r = tempRoot('b0floors'); t.after(() => r.cleanup());
  const station = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createDryRunScript({ cfg: station }), overrides: OVERRIDES, startScheduler: false });
  t.after(() => engine.close());
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'test' }); assert.ok(c.ok); await engine.orchestrator.startJob(JOB_A);
  const s = { ...buildEngineSnapshot(engine), company: null };   // R7a: with the company model the page draws the seven floors (r7a-floors.test.mjs)
  assert.deepEqual(s.building.floors.map((f) => [f.floor, f.id, f.name, f.lounge, f.empty]), [[0, SHARED, 'Shared services', true, false], [1, 'etsy-shop', 'TheStationShopFinds', false, false]]);
  assert.equal(pickFloor(s, null), 1, 'the first business floor by default'); assert.equal(pickFloor(s, '0'), 0); assert.equal(pickFloor(s, '7'), 1);
  const f0 = floorSnapshot(s, 0), f1 = floorSnapshot(s, 1);
  assert.deepEqual(f0.departments.map((d) => d.key), ['finance', 'compliance', 'overseer']); assert.deepEqual(f0.agents.map((a) => a.id), ['overseer']);
  assert.deepEqual([f0.floorView.lounge, f0.jobs.length, f0.services.length > 0], [true, 0, true]);
  assert.deepEqual(f1.departments.map((d) => d.key), ['research', 'design', 'office']);
  assert.equal(f1.agents.length, 8); assert.ok(!f1.agents.some((a) => a.id === 'overseer'));
  assert.deepEqual([f1.floorView.lounge, f1.jobs.map((j) => j.id), f1.services.length, f1.floorView.spend.budgetUsd], [false, [JOB_A], 0, 200]);
  assert.ok(f1.board.columns.some((col) => col.jobIds.includes(JOB_A)) || Object.values(f1.board.lanes).some((x) => x.includes(JOB_A)) || s.jobs.find((j) => j.id === JOB_A).stage === 'approval-queue');
  assert.deepEqual(f1.routines.map((x) => x.businessId), ['etsy-shop']);
  const tot = buildingTotals(s);
  assert.deepEqual(tot.map((x) => [x.floor, x.agents, x.jobs.waiting + x.jobs.running + x.jobs.done + x.jobs.blocked, x.budgetUsd]), [[0, 1, 0, null], [1, 8, 1, 200]]);
  // the 3D layout: the shared floor has the lounge and its seats; a business floor's lounge corner is open floor, nobody walks
  const L0 = computeLayout(f0.departments.map((d) => ({ key: d.key, agents: d.agents })), f0.services, { lounge: true });
  const L1 = computeLayout(f1.departments.map((d) => ({ key: d.key, agents: d.agents })), f1.services, { lounge: false });
  assert.equal(L0.lounge.seats.length, 8); assert.equal(L0.paths.overseer.seat, 0);
  assert.deepEqual([L1.lounge.seats.length, L1.lounge.furniture, Object.values(L1.paths).every((p) => p.seat === null)], [0, null, true]);
  assert.deepEqual(bakedRoomSpec(L1, 'lounge'), { key: 'lounge', kind: 'lounge', w: Math.round(L1.lounge.w * 1e4) / 1e4, d: Math.round(L1.lounge.d * 1e4) / 1e4, floor: 0.46, open: true, seats: [], plants: [] });
  const empty = computeLayout([], [], { lounge: false }); assert.deepEqual([empty.rooms.length, empty.lounge.seats.length], [0, 0]);
  // the page: a floor switcher, the floor's own view, the whole-building view
  const main = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'main.js'), 'utf8'), html = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="floors"/); assert.match(html, /id="building" class="overlay hidden"/);
  assert.match(main, /view = curFloor == null \? snap : floorSnapshot\(snap, curFloor\)/); assert.match(main, /office\.setData\(view\); labels\.build\(view\); taskpanel\.setSnapshot\(view\)/);
});

// ---- 7. building rules

test('7: outbound only for a business that lists it; another company\'s data is refused in an agent\'s write and in a brief', async (t) => {
  assert.equal(outboundOwner(REAL, 'etsy:read-own-shop'), 'etsy-shop');
  assert.equal(outboundOwner({ businesses: [{ id: 'x', allowedOutbound: [] }] }, 'etsy:read-own-shop'), null);
  const idx = fs.readFileSync(path.join(APP_ROOT, 'src', 'server', 'index.mjs'), 'utf8');
  assert.match(idx, /if \(!etsyOwner\) throw new Error\('no product allows etsy\.read-own-shop/);
  assert.deepEqual(foreignDataHits('Notes for Example Company guests', REAL), ['example company']);
  assert.deepEqual(foreignDataHits('a cosy winter mug', REAL), []);
  const { engine, r } = lineEngine(t, { tag: 'b0rules' });
  const folder = path.join(r.dataRoot, 'jobs', '2026-10-21--rules'); fs.mkdirSync(folder, { recursive: true });
  const agent = { ...engine.cfg.agents.designer, tools: ['fs_write'], writes: ['notes.md'] };
  const box = createToolbox({ J: engine.J, folder, agent, job: null, cfg: { ...engine.cfg }, guard: engine.guard, providers: engine.providers, run: { runId: 'run_r' }, halt: engine.halt, log: r.log, bus: engine.bus, line: null });
  await assert.rejects(box.call('fs_write', { path: 'notes.md', content: 'guest list from examplecompany.com' }), /refused by a building rule: the text names another company \(examplecompany\)/);
  assert.ok(!fs.existsSync(path.join(folder, 'notes.md')));
  const b = brief(JOB_A).replace('# Niche', '# Niche\nFor Example Company apartments');
  const c = engine.orchestrator.createJob({ briefText: b, by: 'test' });
  assert.equal(c.ok, false); assert.match(c.reasons.join(' | '), /refused by a building rule: the brief names another company \(example company\)/);
  assert.equal(DEFAULT_BUSINESS, 'etsy-shop');
});
