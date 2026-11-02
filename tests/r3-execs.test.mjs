// R3 tests (RESTRUCTURE.md §2.1, §3.2, §8 R3): the penthouse executives. Mock provider only ($0), the real config and prompts (a copy with
// edits where a test needs a breach), a throwaway data root. Nothing leaves the building.
//   1 the config: the CEO and the COO hired (Sonnet, their fixed tools and folders), their two lines on HQ, both routines seeded disabled
//   2 the COO's report: the engine's metrics, the report checked on write (a USD figure not in the metrics is NOT written), the job done;
//     with no breach the COO cannot pause anything
//   3 the COO pauses a line on a mock breach (only that breach's line, only with its id), nothing starts on it; it cannot resume it or
//     change a cap or a budget; the owner resumes it on the page
//   4 the CEO's memo: its inputs carry no request text, payload or named contact; a memo without options, recommendation or cost is NOT
//     written; every other tool, path or write is refused; its proposals appear in the Owner's office and are no request
//   5 the owner's marks on a proposal (taken, declined, later): the owner's page session only, a note that decides nothing; the next
//     memo's inputs carry them
//   6 routines and the page: arming the COO's routine needs the spend confirmation, a firing writes the report; an off-duty CEO's routine
//     skips; a run from the Owner's office needs the confirm token; the snapshot, the building view and the memo board show them
//   7 the records (pure): the ISO week, the report check, the memo parser, the USD figures
//   8 a script's engine starts no executive job
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { until } from './helpers/engine.mjs';
import { engineOn, serve, configCopy, CONFIG, PROMPTS } from './helpers/r1.mjs';
import { tempRoot } from './helpers/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { LockedRefusal, CEO_TOOLS, COO_TOOLS, CEO_FOLDER, COO_FOLDER } from '../src/engine/locked.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { createBuildingView } from '../src/web/ui/building.js';
import { screenContent } from '../src/web/scene/towerplan.js';
import { isoWeek, reportProblems, parseMemo, usdFigures, moneyIn, REPORT_SECTIONS } from '../src/engine/lib/exec-records.mjs';
import { dublinDay } from '../src/engine/time.mjs';

const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });

// ---- the mock executives (one script; `opts` choose what each run does). env.dataRoot is set once the engine is open
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const text = (t) => ({ type: 'text', text: t });
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const lastResults = (params) => { const m = params.messages[params.messages.length - 1]; return Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result').map((b) => ({ id: b.tool_use_id, error: !!b.is_error, text: String(b.content) })) : []; };
export const report = (day, { spend = 'Spend today USD 0.00 of the day cap USD 10.00.', pauses = 'None.' } = {}) => ['# Operations report ' + day, '## Summary', 'Nothing needs the owner today.', '## Spend and caps', spend, '## Routines', 'None armed.', '## Blocked and stuck jobs', 'None.', '## Requests and policy', 'One request waits.', '## Refusals', 'None in the last 24 hours. COMPLIANCE is not hired yet.', '## Pauses', pauses].join('\n') + '\n';
export const memo = (week, { proposal = true } = {}) => ['# CEO memo ' + week, '## Priorities', '### The Station', 'Keep the running cost low.', '### ReplyDesk', 'File the first engineering issue.', '### emty-inbox', 'Nothing this week.', '## Proposals',
  ...(proposal ? ['### P1: Arm the COO\'s daily report', 'Options:', '- Arm it at 08:00 Dublin', '- Leave it off and run it by hand', 'Recommendation: arm it; the report is the cheapest way to see a breach early.', 'Cost: about USD 0.49 a week (the plan\'s estimate)'] : ['No proposal this week.'])].join('\n') + '\n';
function execScript(env, opts = {}) {
  const seen = env.seen = [];
  return async (ctx, params) => {
    const t = turnOf(params), k = ctx.agentKey, job = ctx.job || { data: {} };
    for (const r of lastResults(params)) seen.push({ agent: k, turn: t, ...r });
    const name = job.data.name, dayOf = () => JSON.parse(fs.readFileSync(path.join(env.dataRoot, COO_FOLDER, job.data.inputs), 'utf8')).day;
    if (k === 'coo') {
      const steps = opts.coo ? opts.coo({ name, day: dayOf, env }) : [[tool('m', 'fs_read', { path: job.data.inputs })], [tool('w', 'fs_write', { path: name + '.md', content: report(dayOf()) })], [text('Done.')]];
      return { content: steps[Math.min(t, steps.length - 1)] };
    }
    if (k === 'ceo') {
      const steps = opts.ceo ? opts.ceo({ name, env }) : [[tool('i', 'fs_read', { path: job.data.inputs })], [tool('w', 'fs_write', { path: name + '.md', content: memo(job.data.period) })], [text('Done.')]];
      return { content: steps[Math.min(t, steps.length - 1)] };
    }
    return { content: [text('nothing to do')] };
  };
}
async function station(t, { configDir = CONFIG, opts = {}, tag = 'r3' } = {}) {
  const env = {};
  const { engine, r } = engineOn(t, { tag, configDir, script: execScript(env, opts) });
  env.dataRoot = r.dataRoot;
  const h = await serve(t, engine, r.log), owner = { kind: 'owner', session: h.token };
  const quote = async (action, params = {}) => { const x = await h.post('/api/spend/quote', { action, params }); assert.equal(x.status, 200, x.text); return x.json.result; };
  const settled = (id) => until(() => !engine.engineering.isActive(id) && ['done', 'blocked', 'incomplete', 'stopped'].includes(engine.store.getJob(id).state), { timeout: 30000 });
  const run = async (k) => { const s = engine.execs.start(k, {}, { actor: owner }); await s.promise; await settled(s.jobId); return engine.store.getJob(s.jobId); };
  return { engine, r, h, owner, env, quote, settled, run };
}
const isLocked = (rule) => (e) => e instanceof LockedRefusal && e.rule === rule;

// ---- 1. the config

test('1: the CEO and the COO are hired on Sonnet with their fixed tools and folders; their lines run on HQ for the Station; both routines are seeded disabled', (t) => {
  const A = REAL.agents;
  assert.deepEqual([A.ceo.status, A.ceo.hired, A.ceo.tier, A.ceo.effort, A.ceo.thinking, A.ceo.enabled], ['active', 'R3', 'strong', 'medium', 'off', true]);
  assert.deepEqual([A.coo.status, A.coo.hired, A.coo.tier, A.coo.effort, A.coo.thinking, A.coo.enabled], ['active', 'R3', 'strong', 'low', 'off', true]);
  assert.deepEqual(A.ceo.tools, CEO_TOOLS); assert.equal(A.ceo.folder, CEO_FOLDER);
  assert.deepEqual(A.coo.tools, COO_TOOLS); assert.equal(A.coo.folder, COO_FOLDER);
  assert.deepEqual([A.ceo.limits.runCapUsd, A.coo.limits.runCapUsd, A.ceo.limits.maxOutputTokens, A.coo.limits.maxOutputTokens], [0.5, 0.2, 8000, 4000]);
  assert.ok(fs.existsSync(path.join(PROMPTS, 'agents', 'ceo.md')) && fs.existsSync(path.join(PROMPTS, 'agents', 'coo.md')));
  assert.equal(A.compliance.status, 'not-hired', 'COMPLIANCE is hired in R5');
  for (const [id, agent, kind] of [['coo-report', 'coo', 'exec-report'], ['ceo-memo', 'ceo', 'exec-memo']]) {
    const L = REAL.lines[id];
    assert.deepEqual([L.kind, L.products, Object.values(L.steps).filter((s) => s.kind === 'agent').map((s) => s.agent)], [kind, ['station'], [agent]], id);
  }
  assert.deepEqual(REAL.company.departments.find((d) => d.id === 'hq').lines, ['coo-report', 'ceo-memo']);
  assert.deepEqual([REAL.lines['coo-report'].estimateUsd.job, REAL.lines['ceo-memo'].estimateUsd.job], [0.07, 0.21], 'the plan\'s estimates (RESTRUCTURE.md §8 R3)');
  const seeds = Object.fromEntries(REAL.routines.map((x) => [x.id, x]));
  assert.deepEqual([seeds['rt_seed_coo-daily-report'].target, seeds['rt_seed_ceo-weekly-memo'].target, seeds['rt_seed_ceo-weekly-memo'].schedule], ['agent:coo', 'agent:ceo', '0 9 * * 1']);
  const { engine } = engineOn(t, { tag: 'r3cfg' });
  for (const id of ['rt_seed_coo-daily-report', 'rt_seed_ceo-weekly-memo']) assert.equal(engine.store.getRoutine(id).enabled, false, id);
  const targets = engine.routineTargets.map((x) => x.id);
  assert.ok(targets.includes('agent:coo') && targets.includes('agent:ceo')); assert.ok(!targets.includes('line:coo-report') && !targets.includes('line:ceo-memo'), 'the exec lines run only as their agents\' reports');
});

// ---- 2. the COO's report

test('2: the COO\'s report: the engine writes the metrics, a report with an invented USD figure is not written, the checked report is; with no breach nothing can be paused', async (t) => {
  const S = await station(t, { tag: 'r3coo', opts: { coo: ({ name, day }) => [
    [tool('m', 'fs_read', { path: 'metrics-' + name + '.json' }), tool('p', 'line_pause', { line: 'engineering', breach: 'B1', reason: 'just to see what happens' })],
    [tool('w1', 'fs_write', { path: name + '.md', content: report(day(), { spend: 'Spend today USD 12.34.' }) }), tool('w2', 'fs_write', { path: 'other.md', content: '# x' }), tool('w3', 'fs_write', { path: 'metrics-' + name + '.json', content: '{}' })],
    [tool('w4', 'fs_write', { path: name + '.md', content: report(day()) })],
    [text('Done.')]] } });
  const j = await S.run('coo'), day = dublinDay(), dir = path.join(S.r.dataRoot, COO_FOLDER);
  assert.equal(j.state, 'done', j.reason); assert.match(j.reason, /^report \d{4}-\d{2}-\d{2}\.md written; 0 breach\(es\), 0 line\(s\) paused/);
  assert.deepEqual([j.line, j.kind, j.product_id, j.department_id], ['coo-report', 'exec-report', 'station', 'hq']);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'metrics-' + day + '.json'), 'utf8'));
  for (const k of ['spend', 'caps', 'routines', 'jobs', 'requests', 'policy', 'refusals', 'paused', 'breaches']) assert.ok(k in m, k);
  assert.deepEqual(m.breaches, []); assert.equal(m.spend.dayCapUsd, 10);
  assert.ok(fs.readFileSync(path.join(dir, day + '.md'), 'utf8').startsWith('# Operations report ' + day));
  const err = (id) => S.env.seen.find((x) => x.id === 'tu_' + id) || {};
  assert.ok(err('p').error && /not a breach in metrics-.*there is none today/.test(err('p').text), err('p').text);
  assert.ok(err('w1').error && /USD figures are not in metrics-.*USD 12\.34/.test(err('w1').text), err('w1').text);
  assert.ok(err('w2').error && /your role may not write other\.md/.test(err('w2').text));
  assert.ok(err('w3').error && /only \.md|may not write/.test(err('w3').text), 'the COO never writes the metrics');
  assert.ok(!fs.existsSync(path.join(dir, 'other.md')));
  assert.equal(S.engine.lineHold('engineering'), null, 'nothing was paused');
  const ev = S.engine.bus.recent(200).find((e) => e.type === 'exec.report'); assert.ok(ev && ev.data.day === day);
  const runs = S.engine.store.runsOf({ agentKey: 'coo' }); assert.equal(runs.length, 1); assert.equal(runs[0].status, 'done');
});

// ---- 3. the COO's pause

test('3: on a mock breach the COO pauses one of its lines (with its id) and nothing starts there; it cannot resume it or change a cap or budget; the owner resumes it on the page', async (t) => {
  const base = tempRoot('r3pausecfg'); t.after(base.cleanup);
  const configDir = configCopy(base.base, { 'products/replydesk.json': (o) => { o.monthlyBudgetUsd = 0.05; } });
  const S = await station(t, { tag: 'r3pause', configDir, opts: { coo: ({ name, day }) => [
    [tool('m', 'fs_read', { path: 'metrics-' + name + '.json' })],
    [tool('p1', 'line_pause', { line: 'engineering', breach: 'B9', reason: 'ReplyDesk is over its monthly budget' }), tool('p2', 'line_pause', { line: 'research', breach: 'B1', reason: 'ReplyDesk is over its monthly budget' }), tool('p3', 'line_pause', { line: 'engineering', breach: 'B1', reason: 'ReplyDesk is over its monthly budget' })],
    [tool('w', 'fs_write', { path: name + '.md', content: report(day(), { spend: 'ReplyDesk spent USD 0.06 of its USD 0.05 budget this month.', pauses: 'Paused engineering for breach B1.' }) })],
    [text('Done.')]] } });
  S.engine.ledger.append({ jobId: null, runId: null, agentKey: null, line: 'engineering', provider: 'mock', model: 'm', kind: 'text', usd: 0.06, productId: 'replydesk', departmentId: 'engineering' });
  const caps = JSON.stringify(S.engine.cfg.engine.caps), budgets = JSON.stringify(S.engine.cfg.company.products.map((p) => [p.id, p.monthlyBudgetUsd]));
  const j = await S.run('coo');
  assert.equal(j.state, 'done', j.reason); assert.match(j.reason, /1 breach\(es\), 1 line\(s\) paused/);
  assert.deepEqual(j.data.breaches.map((b) => [b.id, b.kind, b.lines]), [['B1', 'product-month', ['eng-triage', 'engineering']]]);
  assert.deepEqual(j.data.pauses.map((p) => [p.line, p.breach]), [['engineering', 'B1']]);
  const err = (id) => S.env.seen.find((x) => x.id === 'tu_' + id) || {};
  assert.ok(err('p1').error && /"B9" is not a breach/.test(err('p1').text));
  assert.ok(err('p2').error && /covers the lines eng-triage, engineering, not research/.test(err('p2').text));
  assert.ok(!err('p3').error && /paused the engineering line \(breach B1\)/.test(err('p3').text));
  assert.match(S.engine.lineHold('engineering'), /^paused by coo: ReplyDesk is over its monthly budget \(breach B1: ReplyDesk has spent its monthly budget/);
  assert.equal(S.engine.lineHold('eng-triage'), null, 'only the line the COO named');
  const iss = S.engine.engineering.writeIssue({ productId: 'replydesk', title: 'A test issue for the pause', problem: 'add() joins two numbers given as text instead of adding them.', acceptance: 'add("2", "3") is 5' }, { actor: S.owner });
  await S.engine.engineering.decideIssue({ productId: 'replydesk', issueId: iss.issueId, decision: 'approve', words: 'Approved for the test.' }, { actor: S.owner });
  assert.ok(S.engine.engineering.startProblems('replydesk', iss.issueId).problems.some((x) => /^paused by coo/.test(x)), 'an engineering job cannot start on the paused line');
  // the COO cannot resume it, and no agent changes a cap, a budget or the policy
  const coo = { kind: 'agent', key: 'coo' };
  assert.throws(() => S.engine.actions.resumeLine('engineering', { actor: coo, words: 'resume' }), isLocked('coo-pause-only'));
  for (const action of ['cap.change.agent', 'budget.change.agent', 'policy.change.agent', 'line.resume']) await assert.rejects(S.engine.actions.perform({ action, actor: coo, productId: 'station', payload: 'x', execute: () => assert.fail('executed ' + action) }), (e) => e instanceof LockedRefusal, action);
  assert.equal(JSON.stringify(S.engine.cfg.engine.caps), caps); assert.equal(JSON.stringify(S.engine.cfg.company.products.map((p) => [p.id, p.monthlyBudgetUsd])), budgets);
  // the owner sees it in the Owner's office and resumes it on the page (words required)
  const oo = (await S.h.snapshot()).company.ownersOffice;
  assert.deepEqual(oo.pausedLines.map((x) => [x.line, x.paused.by]), [['engineering', 'coo']]);
  assert.equal(oo.execs.coo.latest.breaches[0].id, 'B1');
  const res = await S.h.post('/api/lines/resume', { line: 'engineering', words: 'Budget raised in config; resume.' });
  assert.equal(res.status, 200, res.text); assert.equal(S.engine.lineHold('engineering'), null);
});

// ---- 4. the CEO's memo

test('4: the CEO\'s memo: its inputs carry no request text, payload or named contact; a memo short of a proposal\'s parts is not written; other tools and paths are refused; the proposals are documents, not requests', async (t) => {
  const S = await station(t, { tag: 'r3ceo', opts: { ceo: ({ name }) => [
    [tool('i', 'fs_read', { path: 'inputs-' + name + '.json' }), tool('x1', 'line_pause', { line: 'engineering', breach: 'B1', reason: 'the CEO would like to pause it' }), tool('x2', 'fs_read', { path: '../reports/x.md' }), tool('x3', 'fs_write', { path: 'notes.md', content: '# notes' })],
    [tool('w1', 'fs_write', { path: name + '.md', content: memo(name).replace(/Recommendation:.*\n/, '').replace(/Cost:.*\n?/, '') })],
    [tool('w2', 'fs_write', { path: name + '.md', content: memo(name) })],
    [text('Done.')]] } });
  const req = S.engine.requests.file({ action: 'git.merge', productId: 'replydesk', departmentId: 'engineering', summary: 'Reply to Jane Doe <jane.doe@example.com> about her refund', payload: 'PAYLOAD-TEXT-NEVER-SHOWN', actor: { kind: 'engine' } });
  const before = S.engine.requests.list().length;
  const j = await S.run('ceo'), week = isoWeek(dublinDay()), dir = path.join(S.r.dataRoot, CEO_FOLDER);
  assert.equal(j.state, 'done', j.reason); assert.match(j.reason, /1 proposal\(s\) for the owner \(documents, not requests\)/);
  assert.deepEqual([j.line, j.kind, j.product_id, j.department_id], ['ceo-memo', 'exec-memo', 'station', 'hq']);
  const inputs = fs.readFileSync(path.join(dir, 'inputs-' + week + '.json'), 'utf8');
  for (const x of ['Jane Doe', 'jane.doe@example.com', 'refund', 'PAYLOAD-TEXT-NEVER-SHOWN']) assert.ok(!inputs.includes(x), 'the CEO\'s inputs never carry ' + x);
  assert.ok(inputs.includes('git.merge · pending'), 'requests as counts only');
  const coo = await S.run('coo'), metrics = fs.readFileSync(path.join(S.r.dataRoot, COO_FOLDER, 'metrics-' + dublinDay() + '.json'), 'utf8');
  assert.equal(coo.state, 'done', coo.reason);
  for (const x of ['Jane Doe', 'jane.doe@example.com', 'PAYLOAD-TEXT-NEVER-SHOWN']) assert.ok(!metrics.includes(x), 'nor the COO\'s metrics: ' + x);
  const err = (id) => S.env.seen.find((x) => x.id === 'tu_' + id) || {};
  assert.ok(err('x1').error && /tool not available to CEO: line_pause/.test(err('x1').text), err('x1').text);
  assert.ok(err('x2').error && /without "\.\."/.test(err('x2').text));
  assert.ok(err('x3').error && /your role may not write notes\.md/.test(err('x3').text));
  assert.ok(err('w1').error && /P1 needs "Recommendation: …"/.test(err('w1').text) && /P1 needs "Cost: …"/.test(err('w1').text), err('w1').text);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.md')), [week + '.md']);
  // the proposals are in the Owner's office; the request the CEO saw is untouched and the CEO filed none
  const v = S.engine.execs.view();
  assert.deepEqual(v.ceo.latest.proposals.map((p) => [p.id, p.title, p.options.length, p.mark]), [['P1', 'Arm the COO\'s daily report', 2, null]]);
  assert.equal(S.engine.requests.get(req.id).status, 'pending'); assert.equal(S.engine.requests.list().length, before);
  assert.throws(() => S.engine.requests.decide(req.id, { decision: 'approve', words: 'as the CEO', expectedVersion: req.version, actor: { kind: 'agent', key: 'ceo' } }), isLocked('owner-only-approver'));
  assert.ok(S.engine.bus.recent(300).some((e) => e.type === 'exec.memo' && e.data.week === week));
});

// ---- 5. the owner's marks

test('5: the owner marks a proposal taken, declined or later on the page (a note that decides nothing); an agent or a script cannot; the next memo\'s inputs carry the mark', async (t) => {
  const S = await station(t, { tag: 'r3marks' });
  const j = await S.run('ceo'), week = j.data.name;
  assert.equal(j.state, 'done', j.reason);
  assert.throws(() => S.engine.execs.markProposal({ week, proposal: 'P1', mark: 'taken' }, { actor: { kind: 'agent', key: 'ceo' } }), (e) => e.code === 'LOCKED');
  assert.throws(() => S.engine.execs.markProposal({ week, proposal: 'P1', mark: 'approve' }, { actor: S.owner }), /mark must be one of taken, declined, later/);
  assert.throws(() => S.engine.execs.markProposal({ week, proposal: 'P2', mark: 'taken' }, { actor: S.owner }), /has no proposal P2/);
  assert.equal((await S.h.post('/api/exec/proposal-mark', { week, proposal: 'P1', mark: 'later' }, { token: null })).status, 403, 'no action token: refused');
  const reqs = S.engine.requests.list().length, routines = JSON.stringify(S.engine.store.listRoutines().map((x) => [x.id, x.enabled]));
  const res = await S.h.post('/api/exec/proposal-mark', { week, proposal: 'P1', mark: 'later', words: 'After the first engineering job.' });
  assert.equal(res.status, 200, res.text); assert.deepEqual([res.json.result.mark, res.json.result.words], ['later', 'After the first engineering job.']);
  assert.equal(S.engine.requests.list().length, reqs, 'no request'); assert.equal(JSON.stringify(S.engine.store.listRoutines().map((x) => [x.id, x.enabled])), routines, 'nothing armed');
  assert.deepEqual(S.engine.execs.view().ceo.latest.proposals[0].mark.mark, 'later');
  // the next memo's inputs carry the owner's mark
  const j2 = await S.run('ceo');
  assert.equal(j2.state, 'done', j2.reason); assert.equal(j2.data.name, week + '-2', 'a second memo in the same week never overwrites the first');
  const inputs = JSON.parse(fs.readFileSync(path.join(S.r.dataRoot, CEO_FOLDER, 'inputs-' + j2.data.name + '.json'), 'utf8'));
  assert.deepEqual(inputs.proposalMarks.map((m) => [m.week, m.proposal, m.mark]), [[week, 'P1', 'later']]);
  assert.equal(inputs.lastMemo.week, week);
});

// ---- 6. routines and the page

test('6: arming the COO\'s routine needs the spend confirmation and a firing writes the report; an off-duty CEO\'s routine skips; a run from the Owner\'s office needs the confirm token; the snapshot, the building view and the memo board show them', async (t) => {
  const S = await station(t, { tag: 'r3page' });
  const rt = S.engine.store.getRoutine('rt_seed_coo-daily-report');
  const q = await S.quote('routine-arm', { id: rt.id });
  assert.deepEqual([q.refusals, q.line, q.routine.jobCapUsd, q.routine.worstPerFiringUsd], [[], 'coo-report', 0.5, 0.5]);
  assert.equal((await S.h.post('/api/routines/enable', { id: rt.id, enabled: true, expectedVersion: rt.version })).status >= 400, true, 'no token: refused');
  const on = await S.h.post('/api/routines/enable', { id: rt.id, enabled: true, expectedVersion: rt.version, confirmToken: q.token });
  assert.equal(on.status, 200, on.text); assert.equal(S.engine.store.getRoutine(rt.id).enabled, true);
  await S.engine.runRoutine(S.engine.store.getRoutine(rt.id));
  const fired = S.engine.store.listJobs().find((j) => j.kind === 'exec-report');
  await S.settled(fired.id); assert.equal(S.engine.store.getJob(fired.id).state, 'done'); assert.equal(fired.data.routineId, rt.id);
  // the CEO off duty: its routine skips with the reason, and nothing starts
  const a = S.engine.store.agentState('ceo');
  S.engine.updateAgent('ceo', { enabled: false }, { expectedVersion: a ? a.version : 0 });
  assert.match((await S.engine.runRoutine(S.engine.store.getRoutine('rt_seed_ceo-weekly-memo'))).skipped, /CEO is off duty/);
  S.engine.updateAgent('ceo', { enabled: true }, { expectedVersion: S.engine.store.agentState('ceo').version });
  // the Owner's office: a run now needs the confirm token
  const no = await S.h.post('/api/exec/ceo-memo', {});
  assert.ok(no.status >= 400 && /confirm first/.test(no.text), no.text);
  const mq = await S.quote('ceo-memo');
  assert.deepEqual([mq.refusals, mq.line, mq.job.capUsd, mq.estimate.usd, mq.mock], [[], 'ceo-memo', 0.5, 0.21, true]);
  const started = await S.h.post('/api/exec/ceo-memo', { confirmToken: mq.token });
  assert.equal(started.status, 200, started.text); await S.settled(started.json.result.jobId);
  assert.equal(S.engine.store.getJob(started.json.result.jobId).state, 'done');
  // one record by name (owner only), and the views
  const week = S.engine.store.getJob(started.json.result.jobId).data.name;
  const rec = await S.h.raw('GET', '/api/exec/ceo/' + week, { headers: { 'x-station-action': S.h.token } });
  assert.equal(rec.status, 200, rec.text); assert.equal(rec.json.proposals[0].id, 'P1');
  assert.equal((await S.h.raw('GET', '/api/exec/ceo/' + week)).status, 403, 'not without the owner\'s session');
  const snap = await S.h.snapshot(), x = snap.company.ownersOffice.execs;
  assert.deepEqual([x.coo.status, x.coo.latest.day, x.ceo.latest.week, x.ceo.routine.enabled, x.coo.routine.enabled], ['active', dublinDay(), week, false, true]);
  const body = { innerHTML: '', querySelectorAll: () => [] }, root = { querySelector: () => body, classList: { add() {}, remove() {}, contains: () => true } };
  createBuildingView({ root }).render(snap);
  for (const s of ['COO · daily operations report', '# Operations report ' + dublinDay(), 'CEO · weekly memo and proposals', 'data-exec-run="ceo-memo"', 'data-mark="taken" data-week="' + week + '" data-proposal="P1"', 'Arm the COO&#39;s daily report']) assert.ok(body.innerHTML.includes(s) || body.innerHTML.includes(s.replace('&#39;', "'")), s);
  const board = screenContent('memo', snap);
  assert.deepEqual([board.title, board.rows[0].value, board.foot], ['CEO memo ' + week, 'open', 'COO report ' + dublinDay()]);
});

// ---- 7. the records (pure)

test('7: the records: the ISO week, the report check (sections, the first line, figures from the metrics only), the memo parser, the USD figures', () => {
  assert.deepEqual(['2026-10-30', '2026-01-01', '2026-12-31', '2027-01-04', '2020-12-31'].map(isoWeek), ['2026-W44', '2026-W01', '2026-W53', '2027-W01', '2020-W53']);
  assert.deepEqual(usdFigures('USD 3.2, $0.5 and 7 USD; not 3.20 EUR'), ['3.20', '0.50', '7.00']);
  const metrics = { spend: { todayUsd: 0.06, products: [{ monthUsd: 1.5, budgetUsd: 80 }] } };
  assert.deepEqual([...moneyIn(metrics)].sort(), ['0.00', '0.06', '1.50', '80.00']);
  assert.deepEqual(reportProblems(report('2026-10-30', { spend: 'USD 0.06 today, USD 1.50 this month of USD 80.00.' }), { day: '2026-10-30', metrics }), []);
  const bad = reportProblems('# Ops\n## Summary\nUSD 9.99', { day: '2026-10-30', metrics });
  assert.ok(bad.some((x) => /first line must be "# Operations report 2026-10-30"/.test(x)));
  for (const s of REPORT_SECTIONS.slice(1)) assert.ok(bad.some((x) => x.includes('"## ' + s + '"')), s);
  assert.ok(bad.some((x) => /USD 9\.99/.test(x)));
  const m = parseMemo(memo('2026-W44'), { week: '2026-W44', products: ['The Station', 'ReplyDesk', 'emty-inbox'] });
  assert.deepEqual([m.ok, m.priorities, m.proposals.map((p) => [p.id, p.options, p.cost])], [true, ['The Station', 'ReplyDesk', 'emty-inbox'], [['P1', ['Arm it at 08:00 Dublin', 'Leave it off and run it by hand'], 'about USD 0.49 a week (the plan\'s estimate)']]]);
  assert.equal(parseMemo(memo('2026-W44', { proposal: false }), { week: '2026-W44', products: ['ReplyDesk'] }).proposals.length, 0, 'no proposal this week is a memo');
  const miss = parseMemo(memo('2026-W44').replace('### ReplyDesk', '### Other').replace('### P1:', '### P2:'), { week: '2026-W44', products: ['ReplyDesk'] });
  assert.ok(miss.problems.some((x) => /"### ReplyDesk" heading/.test(x)) && miss.problems.some((x) => /proposal 1 must be headed "### P1: <title>"/.test(x)), miss.problems.join('; '));
});

// ---- 8. a script's engine

test('8: an engine opened by a script starts no executive job, not even from a routine', (t) => {
  const r = tempRoot('r3script'); t.after(r.cleanup);
  const e = createEngine({ J: r.J, log: r.log, startScheduler: false, scriptRun: { purpose: 'r3 test' } });
  t.after(() => e.close());
  assert.throws(() => e.execs.start('coo', { routineId: 'rt_seed_coo-daily-report' }, { actor: { kind: 'engine' } }), (x) => x.code === 'SCRIPT');
  assert.throws(() => e.execs.start('ceo', {}, { actor: { kind: 'script' } }), (x) => x.code === 'LOCKED');
  assert.equal(e.store.listJobs().length, 0);
});
