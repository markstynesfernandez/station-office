// r1-locked.test.mjs — R1 (owner, R1 prompt 23/10/2026; RESTRUCTURE.md §3.2): a negative test for every locked rule. Each rule is in code
// (src/engine/locked.mjs), not config: a config that tries to loosen it stops the engine at start, naming the rule and the file, and the
// action itself is refused when it is attempted, whoever asks.
//   owner-only-approver     only the owner's page session decides a request
//   ceo-recommends-only     the CEO reads and writes memos; it decides, changes, sends and files nothing
//   coo-pause-only          the COO pauses a line, never resumes one, never changes a cap or budget
//   compliance-independent  COMPLIANCE reports to the owner; no agent overrides or skips its verdict
//   no-merge-deploy-push    no agent merges, deploys or pushes (git.push.branch forbidden)
//   secrets-refused         .env, *.db, .venv, keys refused by path; secret content withheld or refused
//   legal-forbidden         personal-data scraping, fake reviews and accounts, misleading claims, direct sends
//   outbound-needs-owner    anything leaving the building waits for the owner's decision
//   owner-never-lowered     an override never lowers owner to auto
// Mock provider only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { configCopy, promptsCopy, hire, engineOn, reopen, serve, CONFIG, PROMPTS, readJson } from './helpers/r1.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { LockedRefusal, LOCKED_FORBIDDEN, OUTBOUND, FORBIDDEN_TOOL_WORDS, RULES, CEO_FOLDER, COO_FOLDER } from '../src/engine/locked.mjs';
import { TOOL_ACTIONS, PolicyRefusal } from '../src/engine/policy.mjs';
import { createToolbox, FORBIDDEN_TOOL_RE, TOOL_NAMES } from '../src/engine/tools/index.mjs';
import { runAgent } from '../src/engine/runtime.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { createDryRunScript, JOB_A } from '../fixtures/engine/mock-script.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const brief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
const isLocked = (rule) => (e) => e instanceof LockedRefusal && e.rule === rule;
const level = (action, lv) => ({ 'autonomy.json': (o) => { if (lv === undefined) delete o.levels[action]; else o.levels[action] = lv; } });

// a config with `edits` must stop the engine with the locked rule and the file named; nothing is opened on the data root
function refusesStart(t, edits, rule, file, { prompts = [] } = {}) {
  const r = tempRoot('r1cfg'); t.after(r.cleanup);
  const dir = configCopy(r.base, edits), pd = prompts.length ? promptsCopy(r.base, prompts) : PROMPTS;
  assert.throws(() => createEngine({ J: r.J, log: r.log, configDir: dir, promptsDir: pd, startScheduler: false }), (e) => {
    assert.equal(e.code, 'BUILDING', e.message);
    assert.ok(e.message.includes('locked rule ' + rule + ' (' + RULES[rule] + ')'), 'names the rule: ' + e.message);
    assert.ok(e.message.includes(file), 'names the file ' + file + ': ' + e.message);
    return true;
  });
  assert.ok(!fs.existsSync(path.join(r.dataRoot, 'station.db')), 'refused before the store opened');
  assert.ok(!fs.existsSync(path.join(r.dataRoot, '.lock')), 'the lock was released');
}
const ACTORS = [{ kind: 'agent', key: 'ceo' }, { kind: 'agent', key: 'cto' }, { kind: 'agent', key: 'coo' }, { kind: 'agent', key: 'developer' }, { kind: 'engine' }];
// a request the engine files (an owner-level action), to have something to decide
const fileMerge = (engine, payload = 'diff --git a/x b/x') => engine.requests.file({ action: 'git.merge', productId: 'replydesk', departmentId: 'engineering', summary: 'merge dev/test into main', payload, actor: { kind: 'engine' }, security: { verdict: 'approve', by: 'security' } });

test('the locked table: every locked action is in config/autonomy.json at forbidden, every outbound action is owner or forbidden, and no tool reaches either', () => {
  const lv = readJson(path.join(CONFIG, 'autonomy.json')).levels;
  for (const a of Object.keys(LOCKED_FORBIDDEN)) assert.equal(lv[a], 'forbidden', a);
  for (const a of OUTBOUND) assert.ok(['owner', 'forbidden'].includes(lv[a]), a);
  assert.equal(lv['git.push.branch'], 'forbidden');
  for (const act of Object.values(TOOL_ACTIONS)) { assert.ok(!LOCKED_FORBIDDEN[act], act); assert.ok(!OUTBOUND.includes(act), act); assert.equal(lv[act], 'auto', act + ' is the only kind of action a tool performs today'); }
  // the real config holds
  assert.doesNotThrow(() => loadConfig({ configDir: CONFIG, promptsDir: PROMPTS }));
});

// ---- owner-only-approver

test('owner-only-approver (config): request.decide.agent loosened or missing stops the engine, naming the rule and the file', (t) => {
  refusesStart(t, level('request.decide.agent', 'auto'), 'owner-only-approver', 'config/autonomy.json');
  refusesStart(t, level('request.decide.agent', 'owner'), 'owner-only-approver', 'config/autonomy.json');
  refusesStart(t, level('request.decide.agent', undefined), 'owner-only-approver', 'config/autonomy.json');
  refusesStart(t, { 'products/replydesk.json': (o) => { o.policy = { 'request.decide.agent': 'owner' }; } }, 'owner-only-approver', 'config/products/replydesk.json');
});

test('owner-only-approver (runtime): an agent, the engine, a caller without the page session or a script run cannot decide a request; the page can, and the decision is logged', async (t) => {
  const { engine, r } = engineOn(t, { tag: 'r1decide' });
  const req = fileMerge(engine);
  const tries = [...ACTORS, { kind: 'owner' }, { kind: 'owner', session: 'f'.repeat(48) }, { kind: 'script' }, null];
  for (const actor of tries) assert.throws(() => engine.requests.decide(req.id, { decision: 'approve', words: 'yes', expectedVersion: req.version, actor }), isLocked('owner-only-approver'), JSON.stringify(actor));
  for (const actor of [...ACTORS, { kind: 'owner' }]) await assert.rejects(engine.actions.perform({ action: 'request.decide.agent', actor, productId: 'replydesk' }), isLocked('owner-only-approver'));
  assert.equal(engine.requests.get(req.id).status, 'pending', 'still pending');
  assert.ok(!fs.existsSync(path.join(r.dataRoot, 'requests', 'decisions.jsonl')), 'no decision written');
  // the page: same origin, the per-launch token, JSON, an idempotency key; the owner's words are required
  const page = await serve(t, engine, r.log);
  assert.equal((await page.post('/api/requests/decide', { id: req.id, decision: 'approve', words: 'yes', expectedVersion: req.version }, { token: null })).status, 403, 'no token');
  assert.equal((await page.post('/api/requests/decide', { id: req.id, decision: 'approve', words: 'yes', expectedVersion: req.version }, { origin: 'http://evil.example' })).status, 403, 'another origin');
  assert.equal((await page.post('/api/requests/decide', { id: req.id, decision: 'approve', words: '', expectedVersion: req.version })).status, 400, 'no words');
  assert.equal((await page.post('/api/requests/decide', { id: req.id, decision: 'approve', words: 'yes', expectedVersion: req.version + 5 })).status, 409, 'a stale page');
  const ok = await page.post('/api/requests/decide', { id: req.id, decision: 'approve', words: 'Approved: merge it after the tests pass.', expectedVersion: req.version });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.result.status, 'approved');
  const log = fs.readFileSync(path.join(r.dataRoot, 'requests', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.requestId, x.decision, x.words, x.by, x.payloadSha256]), [[req.id, 'approved', 'Approved: merge it after the tests pass.', 'owner (office)', req.payload_sha256]]);
  assert.ok(page.es && engine.bus.recent(50).some((e) => e.type === 'request.decided' && e.data.requestId === req.id));
  // a script run has no owner session and decides nothing
  page.es.dispose(); engine.close();
  const s = openScriptEngine({ J: r.J, log: r.log, purpose: 'r1 test' });
  try {
    assert.throws(() => s.requests.registerOwnerSession('a'.repeat(48)), isLocked('owner-only-approver'));
    const req2 = fileMerge(s, 'another diff');
    assert.throws(() => s.requests.decide(req2.id, { decision: 'approve', words: 'yes', expectedVersion: req2.version, actor: { kind: 'owner', session: page.token } }), isLocked('owner-only-approver'));
  } finally { s.close(); }
});

// ---- ceo-recommends-only

test('ceo-recommends-only (config): an extra tool, a folder outside the memos, writes outside it, another reporting line, or policy.change.agent loosened stops the engine', (t) => {
  const F = 'config/agents/ceo.json';
  refusesStart(t, { 'agents/ceo.json': (o) => { o.tools.push('web_search'); } }, 'ceo-recommends-only', F);
  refusesStart(t, { 'agents/ceo.json': (o) => { o.tools.push('submit_verdict'); } }, 'ceo-recommends-only', F);
  refusesStart(t, { 'agents/ceo.json': (o) => { o.folder = 'products/station'; } }, 'ceo-recommends-only', F);
  refusesStart(t, { 'agents/ceo.json': (o) => { o.writes = ['../reports/*.md']; } }, 'ceo-recommends-only', F);
  refusesStart(t, { 'agents/ceo.json': (o) => { o.reportsTo = 'coo'; } }, 'ceo-recommends-only', F);
  refusesStart(t, level('policy.change.agent', 'auto'), 'ceo-recommends-only', 'config/autonomy.json');
  // hiring the CEO does not loosen it either
  refusesStart(t, { 'agents/ceo.json': (o) => { hire(['fs_read', 'fs_list', 'fs_write', 'web_fetch'])(o); } }, 'ceo-recommends-only', F, { prompts: ['ceo'] });
});

test('ceo-recommends-only (runtime): the CEO cannot decide a request, file one, change policy, a budget or a cap, send, merge, pause or assign; it runs only in its memos folder', async (t) => {
  const { engine, r } = engineOn(t, { tag: 'r1ceo' });
  const ceo = { kind: 'agent', key: 'ceo' };
  for (const action of ['policy.change.agent', 'cap.change.agent', 'budget.change.agent', 'email.send.prospect', 'email.send.agent', 'git.merge', 'deploy', 'price.set', 'public.post', 'line.pause', 'issue.assign', 'roadmap.approve']) {
    await assert.rejects(engine.actions.perform({ action, actor: ceo, productId: 'replydesk', departmentId: 'engineering', payload: 'x', execute: () => assert.fail('executed ' + action) }), (e) => e instanceof LockedRefusal, action);
  }
  assert.throws(() => engine.requests.file({ action: 'git.merge', productId: 'replydesk', departmentId: 'engineering', summary: 'please merge', payload: 'x', actor: ceo }), isLocked('ceo-recommends-only'));
  const req = fileMerge(engine);
  assert.throws(() => engine.requests.decide(req.id, { decision: 'approve', words: 'as the CEO', expectedVersion: req.version, actor: ceo }), isLocked('owner-only-approver'));
  assert.throws(() => engine.actions.pauseLine('research', { actor: ceo, reason: 'the CEO thinks so' }), isLocked('ceo-recommends-only'));
  // R3: the CEO is hired; a run outside its memos folder is refused before anything is recorded or spent
  await assert.rejects(runAgent(engine, { agentKey: 'ceo', folder: path.join(r.dataRoot, 'products', 'replydesk'), input: 'memo' }), isLocked('ceo-recommends-only'));
  assert.equal(engine.store.runsOf({ agentKey: 'ceo' }).length, 0); assert.equal(engine.ledger.totals.rows, 0);
  assert.equal(engine.requests.get(req.id).status, 'pending');
});

test('ceo-recommends-only (runtime, CEO hired in a test copy): a run outside the memos folder is refused before anything is recorded', async (t) => {
  const r0 = tempRoot('r1ceohire'); t.after(r0.cleanup);
  const dir = configCopy(r0.base, { 'agents/ceo.json': hire() }), pd = promptsCopy(r0.base, ['ceo']);
  const { engine, r } = engineOn(t, { tag: 'r1ceohired', configDir: dir, promptsDir: pd });
  for (const folder of [path.join(r.dataRoot, 'products', 'station'), path.join(r.dataRoot, 'products', 'replydesk'), path.join(r.dataRoot, COO_FOLDER)]) {
    await assert.rejects(runAgent(engine, { agentKey: 'ceo', folder, input: 'memo' }), isLocked('ceo-recommends-only'), folder);
  }
  assert.equal(engine.store.runsOf({ agentKey: 'ceo' }).length, 0);
});

// ---- coo-pause-only

test('coo-pause-only (config): an extra tool, another folder, or cap.change.agent / budget.change.agent loosened stops the engine', (t) => {
  refusesStart(t, { 'agents/coo.json': (o) => { o.tools.push('web_search'); } }, 'coo-pause-only', 'config/agents/coo.json');
  refusesStart(t, { 'agents/coo.json': (o) => { o.folder = 'products/replydesk'; } }, 'coo-pause-only', 'config/agents/coo.json');
  refusesStart(t, level('cap.change.agent', 'owner'), 'coo-pause-only', 'config/autonomy.json');
  refusesStart(t, level('budget.change.agent', 'auto'), 'coo-pause-only', 'config/autonomy.json');
  refusesStart(t, { 'products/station.json': (o) => { o.policy = { 'cap.change.agent': 'auto' }; } }, 'coo-pause-only', 'config/products/station.json');
});

test('coo-pause-only (runtime): a hired COO pauses a line and nothing starts on it; it cannot resume it or change a cap or budget; the owner resumes it on the page', async (t) => {
  const r0 = tempRoot('r1coohire'); t.after(r0.cleanup);
  const dir = configCopy(r0.base, { 'agents/coo.json': hire(['fs_read', 'fs_write']) }), pd = promptsCopy(r0.base, ['coo']);
  const station = loadConfig({ configDir: dir, promptsDir: pd, overrides: OVERRIDES }).station;
  const { engine, r } = engineOn(t, { tag: 'r1coo', configDir: dir, promptsDir: pd, sandbox: true, overrides: OVERRIDES, script: createDryRunScript({ cfg: station }) });
  const coo = { kind: 'agent', key: 'coo' }, caps = JSON.stringify(engine.cfg.engine.caps), budgets = JSON.stringify(engine.cfg.company.products.map((p) => [p.id, p.monthlyBudgetUsd, p.jobCapUsdByDepartment]));
  const p = engine.actions.pauseLine('room1-digital', { actor: coo, reason: 'budget breach: test' });
  assert.deepEqual([p.paused.by, p.paused.reason], ['coo', 'budget breach: test']);
  assert.match(engine.lineHold('room1-digital'), /^paused by coo: budget breach: test/);
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'test' });
  assert.equal(c.ok, false); assert.match(c.reasons[0], /^paused by coo/);
  // the COO cannot resume, and no agent changes a cap, a budget or the policy
  assert.throws(() => engine.actions.resumeLine('room1-digital', { actor: coo, words: 'resume' }), isLocked('coo-pause-only'));
  for (const action of ['cap.change.agent', 'budget.change.agent', 'policy.change.agent', 'line.resume', 'git.merge']) await assert.rejects(engine.actions.perform({ action, actor: coo, productId: 'station', payload: 'x', execute: () => assert.fail('executed ' + action) }), (e) => e instanceof LockedRefusal, action);
  assert.throws(() => engine.actions.pauseLine('research', { actor: { kind: 'agent', key: 'cto' }, reason: 'x' }), (e) => e instanceof PolicyRefusal && /only the COO pauses a line/.test(e.message));
  assert.equal(JSON.stringify(engine.cfg.engine.caps), caps, 'the caps are unchanged'); assert.equal(JSON.stringify(engine.cfg.company.products.map((x) => [x.id, x.monthlyBudgetUsd, x.jobCapUsdByDepartment])), budgets, 'the budgets are unchanged');
  // the owner, on the page, resumes it (words required)
  const page = await serve(t, engine, r.log);
  assert.equal((await page.post('/api/lines/resume', { line: 'room1-digital', words: 'ok' }, { token: null })).status, 403);
  const res = await page.post('/api/lines/resume', { line: 'room1-digital', words: 'Resolved: resume the line.' });
  assert.equal(res.status, 200, res.text); assert.equal(engine.lineHold('room1-digital'), null);
  assert.ok(engine.bus.recent(80).some((e) => e.type === 'line.paused') && engine.bus.recent(80).some((e) => e.type === 'line.resumed'));
});

test('coo-pause-only (runtime): the COO cannot pause while it is not hired yet (a test copy with the COO not hired: R3 hired it)', (t) => {
  const r0 = tempRoot('r1coonothired'); t.after(r0.cleanup);
  const dir = configCopy(r0.base, { 'agents/coo.json': (o) => { o.status = 'not-hired'; o.enabled = false; } });
  const { engine } = engineOn(t, { tag: 'r1coonot', configDir: dir });
  assert.throws(() => engine.actions.pauseLine('research', { actor: { kind: 'agent', key: 'coo' }, reason: 'x' }), (e) => e instanceof PolicyRefusal && /COO is not-hired \(not hired yet\)/.test(e.message));
  assert.equal(engine.lineHold('research') && /^paused/.test(engine.lineHold('research')), false);
});

// ---- compliance-independent

test('compliance-independent (config): COMPLIANCE reporting to anyone but the owner, sitting in a department under the CEO, or compliance.override.agent loosened stops the engine', (t) => {
  refusesStart(t, { 'agents/compliance.json': (o) => { o.reportsTo = 'ceo'; } }, 'compliance-independent', 'config/agents/compliance.json');
  refusesStart(t, {
    'departments/hq.json': (o) => { o.agents = o.agents.filter((k) => k !== 'compliance'); },
    'departments/sales-marketing.json': (o) => { o.agents.push('compliance'); }
  }, 'compliance-independent', 'which reports to "ceo"');
  refusesStart(t, level('compliance.override.agent', 'owner'), 'compliance-independent', 'config/autonomy.json');
});

test('compliance-independent (runtime): an outbound draft reaches the owner only with COMPLIANCE\'s pass; no agent, the CEO included, files around a revise or refuse or overrides it', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1compliance' });
  const base = { action: 'email.send.prospect', productId: 'replydesk', departmentId: 'sales-marketing', summary: 'first contact: an Irish dental practice', payload: 'Dear practice manager, …' };
  for (const [actor, compliance] of [[{ kind: 'agent', key: 'outreach-writer' }, { verdict: 'revise', by: 'compliance' }], [{ kind: 'agent', key: 'outreach-writer' }, { verdict: 'refuse', by: 'compliance' }], [{ kind: 'engine' }, null], [{ kind: 'agent', key: 'outreach-writer' }, { verdict: 'pass', by: 'ceo' }], [{ kind: 'agent', key: 'cto' }, { verdict: 'pass', by: 'outreach-writer' }]]) {
    assert.throws(() => engine.requests.file({ ...base, actor, compliance }), isLocked('compliance-independent'), JSON.stringify([actor, compliance]));
  }
  assert.throws(() => engine.requests.file({ ...base, actor: { kind: 'agent', key: 'ceo' }, compliance: { verdict: 'revise', by: 'compliance' } }), (e) => e instanceof LockedRefusal);
  await assert.rejects(engine.actions.perform({ ...base, actor: { kind: 'agent', key: 'outreach-writer' }, compliance: { verdict: 'refuse', by: 'compliance' }, execute: () => assert.fail('sent') }), isLocked('compliance-independent'));
  for (const actor of ACTORS) await assert.rejects(engine.actions.perform({ action: 'compliance.override.agent', actor, productId: 'replydesk' }), (e) => e instanceof LockedRefusal);
  assert.equal(engine.requests.list().length, 0, 'nothing reached the owner');
  // with COMPLIANCE's pass the draft becomes a request (still the owner's to decide)
  const ok = engine.requests.file({ ...base, actor: { kind: 'agent', key: 'outreach-writer' }, compliance: { verdict: 'pass', by: 'compliance' } });
  assert.deepEqual([ok.status, ok.compliance.verdict], ['pending', 'pass']);
});

// ---- no-merge-deploy-push

test('no-merge-deploy-push (config): git.push.branch, git.merge.agent or deploy.agent loosened or missing, a product override, or an agent tool named for it stops the engine', (t) => {
  refusesStart(t, level('git.push.branch', 'owner'), 'no-merge-deploy-push', 'config/autonomy.json');
  refusesStart(t, level('git.push.branch', 'auto'), 'no-merge-deploy-push', 'config/autonomy.json');
  refusesStart(t, level('git.merge.agent', 'owner'), 'no-merge-deploy-push', 'config/autonomy.json');
  refusesStart(t, level('deploy.agent', undefined), 'no-merge-deploy-push', 'config/autonomy.json');
  refusesStart(t, { 'products/replydesk.json': (o) => { o.policy = { 'git.push.branch': 'auto' }; } }, 'no-merge-deploy-push', 'config/products/replydesk.json');
  refusesStart(t, { 'agents/developer.json': (o) => { o.tools.push('git_push'); } }, 'no-merge-deploy-push', 'config/agents/developer.json');
  refusesStart(t, { 'agents/tech-lead.json': (o) => { o.tools.push('deploy_site'); } }, 'no-merge-deploy-push', 'config/agents/tech-lead.json');
});

test('no-merge-deploy-push (runtime): a push, an agent merge or an agent deploy is refused for every caller, the owner included; no tool can be named for it', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1push' });
  const token = 'b'.repeat(48); engine.requests.registerOwnerSession(token);
  for (const action of ['git.push.branch', 'git.merge.agent', 'deploy.agent']) for (const actor of [...ACTORS, { kind: 'owner', session: token }]) {
    await assert.rejects(engine.actions.perform({ action, actor, productId: 'replydesk', departmentId: 'engineering', payload: 'x', execute: () => assert.fail('executed ' + action) }), isLocked('no-merge-deploy-push'), action + ' ' + JSON.stringify(actor));
  }
  for (const n of ['git_push', 'push_branch', 'git_merge', 'merge_pr', 'deploy', 'deploy_site', 'npm_install', 'publish_post']) assert.ok(FORBIDDEN_TOOL_WORDS.test(n) || FORBIDDEN_TOOL_RE.test(n), n);
  assert.ok(!TOOL_NAMES.some((n) => FORBIDDEN_TOOL_WORDS.test(n)), 'no built tool is named for it');
});

// ---- secrets-refused

test('secrets-refused (config): secrets.read loosened stops the engine', (t) => {
  refusesStart(t, level('secrets.read', 'auto'), 'secrets-refused', 'config/autonomy.json');
  refusesStart(t, { 'departments/engineering.json': (o) => { o.policy = { 'secrets.read': 'owner' }; } }, 'secrets-refused', 'config/departments/engineering.json');
});

test('secrets-refused (runtime): .env, *.db, .venv, key and credential files and .git are refused by path; secret content is withheld on read and refused on write', async (t) => {
  const { engine, r } = engineOn(t, { tag: 'r1secrets' });
  const folder = path.join(r.dataRoot, 'products', 'replydesk', 'scratch'); fs.mkdirSync(path.join(folder, '.venv'), { recursive: true }); fs.mkdirSync(path.join(folder, '.git'), { recursive: true }); fs.mkdirSync(path.join(folder, 'secrets'), { recursive: true });
  const files = ['.env', '.env.local', 'replydesk.db', 'station.db-wal', '.venv/pyvenv.cfg', 'server.pem', 'deploy.key', 'id_rsa', 'id_ed25519.pub', '.npmrc', 'credentials.json', 'secrets/token.txt', '.git/config'];
  for (const f of files) fs.writeFileSync(path.join(folder, f), 'x');
  const key = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(6);
  fs.writeFileSync(path.join(folder, 'notes.md'), 'the Station key is ' + key + '\n');
  const agent = { key: 'tester', name: 'TESTER', tools: ['fs_read', 'fs_list', 'fs_write'], writes: ['*.md', '*.txt'] };
  const box = createToolbox({ J: engine.J, folder, agent, job: null, cfg: { ...engine.cfg }, guard: engine.guard, providers: engine.providers, run: { runId: 'run_s' }, halt: engine.halt, log: r.log, bus: engine.bus, line: null });
  for (const f of files) await assert.rejects(box.call('fs_read', { path: f }), isLocked('secrets-refused'), f);
  for (const f of ['.env', 'notes.db', '.venv/x.txt', 'secrets/a.md', '.git/HEAD.txt']) await assert.rejects(box.call('fs_write', { path: f, content: 'x' }), isLocked('secrets-refused'), f);
  const read = await box.call('fs_read', { path: 'notes.md' });
  assert.match(read, /^\[withheld by the Station: notes\.md holds what looks like a secret \(Anthropic API key/); assert.ok(!read.includes(key), 'the key never reaches the agent');
  for (const content of ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc', 'DATABASE_URL=postgres://app:hunter2@db.example:5432/prod', 'token ghp_' + 'a'.repeat(36), 'key ' + key]) {
    await assert.rejects(box.call('fs_write', { path: 'draft.md', content }), /refused by a locked rule \(secrets-refused\): draft\.md was NOT written/);
  }
  assert.ok(!fs.existsSync(path.join(folder, 'draft.md')));
  assert.ok(!fs.readFileSync(path.join(r.logs, fs.readdirSync(r.logs)[0]), 'utf8').includes(key), 'the key is not in the log either');
});

test('secrets-refused (runtime, in a run): an agent that reads .env ends its run refused and its job blocks with the rule', async (t) => {
  const station = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS, overrides: OVERRIDES }).station, base = createDryRunScript({ cfg: station });
  const script = async (ctx, params) => (ctx.agentKey === 'designer' && params.messages.filter((m) => m.role === 'assistant').length === 0 ? { content: [{ type: 'tool_use', id: 'tu_env', name: 'fs_read', input: { path: '.env' } }] } : base(ctx, params));
  const { engine } = engineOn(t, { tag: 'r1secretrun', sandbox: true, overrides: OVERRIDES, script });
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'test' }); assert.ok(c.ok, (c.reasons || []).join('; '));
  await engine.orchestrator.startJob(JOB_A);
  const job = engine.store.getJob(JOB_A), run = engine.store.runsOf({ agentKey: 'designer' })[0];
  assert.equal(job.state, 'blocked'); assert.match(job.reason, /refused by a locked rule \(secrets-refused/);
  assert.equal(run.status, 'refused');
  assert.ok(engine.bus.recent(400).some((e) => e.type === 'action.refused' && e.data.rule === 'secrets-refused'));
});

// ---- legal-forbidden

test('legal-forbidden (config): personal-data scraping, fake reviews or accounts, misleading claims or an agent sending directly, loosened anywhere, stops the engine', (t) => {
  for (const a of ['personal-data.scrape', 'review.fake', 'account.fake', 'claim.misleading', 'email.send.agent']) refusesStart(t, level(a, 'owner'), 'legal-forbidden', 'config/autonomy.json');
  refusesStart(t, { 'products/emty-inbox.json': (o) => { o.policy = { 'personal-data.scrape': 'auto' }; } }, 'legal-forbidden', 'config/products/emty-inbox.json');
  refusesStart(t, { 'agents/lead-researcher.json': (o) => { o.policy = { 'claim.misleading': 'owner' }; } }, 'legal-forbidden', 'config/agents/lead-researcher.json');
  refusesStart(t, { 'agents/lead-researcher.json': (o) => { o.tools.push('scrape_profiles'); } }, 'no-merge-deploy-push', 'config/agents/lead-researcher.json');
});

test('legal-forbidden (runtime): each is refused for every caller; no tool can scrape, post reviews, create accounts or send', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1legal' });
  const token = 'c'.repeat(48); engine.requests.registerOwnerSession(token);
  for (const action of ['personal-data.scrape', 'review.fake', 'account.fake', 'claim.misleading', 'email.send.agent']) for (const actor of [...ACTORS, { kind: 'agent', key: 'lead-researcher' }, { kind: 'owner', session: token }]) {
    await assert.rejects(engine.actions.perform({ action, actor, productId: 'replydesk', departmentId: 'sales-marketing', payload: 'x', execute: () => assert.fail('executed ' + action) }), isLocked('legal-forbidden'), action);
  }
  for (const n of ['scrape_profiles', 'create_account', 'register_user', 'post_review', 'publish_testimonial', 'send_email', 'email_lead']) assert.ok(FORBIDDEN_TOOL_WORDS.test(n) || FORBIDDEN_TOOL_RE.test(n), n);
  assert.equal(engine.requests.list().length, 0);
});

// ---- outbound-needs-owner

test('outbound-needs-owner (config): any outbound action set to auto, in the file or in a product override, stops the engine', (t) => {
  for (const a of OUTBOUND) refusesStart(t, level(a, 'auto'), 'outbound-needs-owner', 'config/autonomy.json');
  refusesStart(t, { 'products/replydesk.json': (o) => { o.policy = { 'support.reply.send': 'auto' }; } }, 'outbound-needs-owner', 'config/products/replydesk.json');
});

test('outbound-needs-owner (runtime): a merge waits for the owner (a request, the job waits, nothing runs); approved, it runs once; a payload changed after approval no longer matches', async (t) => {
  const { engine } = engineOn(t, { tag: 'r1outbound' });
  engine.store.insertJob({ id: '2026-10-23--merge-test', line: 'research', kind: 'line', title: 'merge test', state: 'queued', product_id: 'replydesk', department_id: 'engineering' });
  let ran = 0; const execute = () => { ran++; return 'merged'; };
  const ask = (payload) => engine.actions.perform({ action: 'git.merge', actor: { kind: 'engine' }, productId: 'replydesk', departmentId: 'engineering', jobId: '2026-10-23--merge-test', summary: 'merge dev/2026-10-23--merge-test', payload, security: { verdict: 'approve', by: 'security' }, execute });
  const w = await ask('diff v1');
  assert.equal(w.waiting, true); assert.equal(ran, 0);
  const job = engine.store.getJob('2026-10-23--merge-test');
  assert.deepEqual([job.state, job.data.waitingFor, job.data.requestId], ['queued', 'owner', w.requestId]); assert.match(job.reason, /^waiting for the owner: request req_/);
  assert.deepEqual((await ask('diff v1')).requestId, w.requestId, 'asking again waits on the same request'); assert.equal(ran, 0);
  const token = 'd'.repeat(48); engine.requests.registerOwnerSession(token);
  engine.requests.decide(w.requestId, { decision: 'approve', words: 'yes, merge', expectedVersion: engine.requests.get(w.requestId).version, actor: { kind: 'owner', session: token } });
  const done = await ask('diff v1');
  assert.deepEqual([done.done, done.result, ran, engine.requests.get(w.requestId).status], [true, 'merged', 1, 'executed']);
  // a new approval for a new diff; the diff changes after the owner approved it: the executor refuses, the approval is void, a new request waits
  const w2 = await ask('diff v2'); engine.requests.decide(w2.requestId, { decision: 'approve', words: 'ok', expectedVersion: engine.requests.get(w2.requestId).version, actor: { kind: 'owner', session: token } });
  const changed = await ask('diff v2 + one more line');
  assert.deepEqual([changed.waiting, changed.stale, ran], [true, true, 1]);
  assert.equal(engine.requests.get(w2.requestId).status, 'void'); assert.notEqual(changed.requestId, w2.requestId);
  // a rejected request never runs
  engine.requests.decide(changed.requestId, { decision: 'reject', words: 'no', expectedVersion: engine.requests.get(changed.requestId).version, actor: { kind: 'owner', session: token } });
  assert.equal(ran, 1);
});

// ---- owner-never-lowered

test('owner-never-lowered: an override (product, department or agent) that lowers an owner action to auto stops the engine; a stricter one is accepted', (t) => {
  refusesStart(t, { 'products/replydesk.json': (o) => { o.policy = { 'roadmap.approve': 'auto' }; } }, 'owner-never-lowered', 'config/products/replydesk.json');
  refusesStart(t, { 'departments/hq.json': (o) => { o.policy = { 'line.resume': 'auto' }; } }, 'owner-never-lowered', 'config/departments/hq.json');
  refusesStart(t, { 'agents/product-manager.json': (o) => { o.policy = { 'lead.source.add': 'auto' }; } }, 'owner-never-lowered', 'config/agents/product-manager.json');
  refusesStart(t, { 'products/replydesk.json': (o) => { o.ownerApprovalRequired = false; } }, 'owner-never-lowered', 'config/products/replydesk.json');
  // stricter is fine: a product may ask the owner for drafts, or forbid a merge outright
  const r = tempRoot('r1strict'); t.after(r.cleanup);
  const dir = configCopy(r.base, { 'products/replydesk.json': (o) => { o.policy = { 'draft.write': 'owner', 'git.merge': 'forbidden' }; } });
  const e = createEngine({ J: r.J, log: r.log, configDir: dir, startScheduler: false });
  try { assert.deepEqual([e.policy.level('draft.write', 'replydesk'), e.policy.level('draft.write', 'emty-inbox'), e.policy.level('git.merge', 'replydesk')], ['owner', 'auto', 'forbidden']); } finally { e.close(); }
});
