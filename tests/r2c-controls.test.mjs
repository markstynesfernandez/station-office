// R2c tests (owner, 28/10/2026): the owner's controls for the engineering line, through the page's own HTTP routes (same origin, the action
// token, JSON, an idempotency key) on an engine with the owner's page session. Mock provider only ($0, or a test price where a test needs a
// spend), a throwaway data root, the fixture clone standing in for the owner's ReplyDesk clone and a fake Docker (helpers/r2.mjs). Nothing
// pushes anywhere; the real Docker run is npm run test:docker (R2a.1) and the R2c dry run.
//   1 every new route refuses a caller without the owner's page session (no token, another origin, a script engine's server, another
//     address), and the engine refuses an agent, the engine or a script for each control
//   2 triage and start need the spend confirmation (estimate, cap, budget left); without it nothing is created
//   3 Stop works mid-step: the model call in flight is aborted, every stage and run is closed, nothing half-written is left, and the job
//     resumes cleanly to its merge request
//   4 a rework stays inside the job cap and goes back to DEVELOPER with the owner's notes; one that would pass the cap blocks with the cap
//     reason, and a job with nothing left is refused before it starts
//   5 the diff view (and every output on the job view) escapes HTML and JS
//   6 an approval is invalidated by a later diff change: the branch moved after approval (6), a change while it waits (6b), a rework
//     after approval (6c)
//   7 the pull command shown matches the branch: it is the engine's command and it fetches the branch at the committed sha
//   8 the page: the panel, its entry from the building view (G) and the Floors menu (F), the three buttons, the spend dialog's estimate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { engineOn, serve, configCopy } from './helpers/r1.mjs';
import { G, tempBase, fixtureClone, fakeDocker } from './helpers/r2.mjs';
import { until } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { mirrorDir, branchOf, pullCommand } from '../src/engine/lib/repo.mjs';
import { issueFromForm } from '../src/engine/lib/eng-records.mjs';
import { diffHtml, jobHtml, panelHtml, pullHtml } from '../src/web/ui/eng-view.js';
import { spendHtml } from '../src/web/ui/controls.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const text = (t) => ({ type: 'text', text: t });
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const SPEC = ['# Spec: add() takes numbers given as text', '', '## Problem', 'add("2", "3") joins the text.', '', '## Scope', 'app.py add() and its tests.', '', '## Out of scope', 'Anything else.', '', '## Acceptance criteria', 'AC1: add(2, 3) returns 5.', 'AC2: add("2", "3") returns 5.', '', '## Test plan', 'tests/test_add.py; run the test check.', '', '## Files likely touched', 'app.py, tests/test_add.py', '', '## Risk notes', 'None known.', '', 'size: small', ''].join('\n');
const PRICED = (o) => { o.pricing.mock.models['*'] = { inPerM: 1, outPerM: 5, perImage: 0, perCall: 0, source: 'R2c test price (not a real price)' }; };

// the mock agents: the CTO's queue (every approved issue), TECH-LEAD's spec, DEVELOPER's change (extra: more files), and three approvals
function script(state) {
  return async (ctx, params) => {
    const t = turnOf(params), k = ctx.agentKey;
    if (t === 0) state.inputs.push({ agent: k, step: ctx.step, pass: ctx.pass, input: String(params.messages[0].content) });
    if (k === 'cto') { const q = { product: 'replydesk', queue: state.queue().map((id, i) => ({ issue: id, order: i + 1, size: 'small', note: 'in the order written' })), notes: 'test queue' }; return { content: [[tool('q', 'fs_write', { path: 'dev-queue.json', content: JSON.stringify(q) })], [text('Queue written.')]][Math.min(t, 1)] }; }
    if (k === 'tech-lead') return { content: [[tool('s', 'fs_write', { path: 'spec.md', content: SPEC })], [text('Spec written.')]][Math.min(t, 1)] };
    if (k === 'developer') {
      const p = ctx.pass, testFile = 'from app import add\n\n\ndef test_text():\n    assert add("2", "3") == 5  # pass ' + p + '\n';
      const steps = p === 1
        ? [[tool('e1', 'fs_edit', { path: 'repo/app.py', old_string: '    return a + b', new_string: '    return int(a) + int(b)' }), tool('e2', 'fs_write', { path: 'repo/tests/test_add.py', content: testFile }), ...Object.entries(state.extra).map(([f, c], i) => tool('x' + i, 'fs_write', { path: 'repo/' + f, content: c }))], [tool('n1', 'fs_write', { path: 'notes.md', content: '# Notes\nadd() adds numbers given as text.\n' })], [text('Done.')]]
        : [[tool('r' + p, 'fs_write', { path: 'repo/tests/test_add.py', content: testFile })], [tool('rn' + p, 'fs_write', { path: 'notes.md', content: '# Notes\nRework: answered the owner\'s notes.\n' })], [text('Reworked.')]];
      return { content: steps[Math.min(t, steps.length - 1)] };
    }
    if (k === 'tester') return { content: [[tool('t', 'submit_verdict', { record: { kind: 'test', verdict: 'pass', checks: { test: 'pass' }, criteria: { AC1: 'pass', AC2: 'pass' }, findings: [] } })], [text('Tested.')]][Math.min(t, 1)] };
    if (k === 'reviewer' || k === 'security') return { content: [[tool('v', 'submit_verdict', { record: { kind: k === 'reviewer' ? 'review' : 'security', verdict: 'approve', findings: [], summary: state.summary || 'fine' } })], [text('Done.')]][Math.min(t, 1)] };
    return { content: [text('nothing scripted for ' + k)] };
  };
}

// an engine with the engineering line, its page server (the owner's session) and the steps the page takes
async function station(t, { configDir, mockDelayMs = 0, hooks = {}, extra = {} } = {}) {
  const state = { inputs: [], extra, issues: [], queue: () => state.issues };
  const d = fakeDocker(), clone = fixtureClone(tempBase(t, 'r2c'));
  const { engine, r } = engineOn(t, { tag: 'r2c', script: script(state), mockDelayMs, ...(configDir ? { configDir } : {}), engineering: { checks: d.checks, env: { REPLYDESK_REPO: clone }, hooks } });
  const h = await serve(t, engine, r.log), E = engine.engineering;
  const ok = async (p, body) => { const x = await h.post(p, body); assert.equal(x.status, 200, p + ': ' + x.text); return x.json.result; };
  const quote = async (action, params) => { const x = await h.post('/api/spend/quote', { action, params }); assert.equal(x.status, 200, x.text); return x.json.result; };
  const get = (p, token = h.token) => h.raw('GET', p, { headers: token ? { 'x-station-action': token } : {} });
  const job = (id) => engine.store.getJob(id);
  const settled = (id, states) => until(() => !E.isActive(id) && states.includes(job(id).state), { timeout: 30000 });
  async function issue(title = 'add() should add numbers given as text') {
    const w = await ok('/api/eng/issue', { productId: 'replydesk', title, happens: 'add("2", "3") returns "23".', should: 'It returns 5.', where: 'app.py add()', acceptance: 'add("2", "3") is 5' });
    await ok('/api/eng/issue-decide', { productId: 'replydesk', issueId: w.issueId, decision: 'approve', words: 'Go ahead.' });
    state.issues.push(w.issueId);
    return w.issueId;
  }
  async function triage() { const q = await quote('eng-triage', { productId: 'replydesk' }); const r2 = await ok('/api/eng/triage', { productId: 'replydesk', confirmToken: q.token }); await settled(r2.jobId, ['done', 'blocked']); assert.equal(job(r2.jobId).state, 'done', job(r2.jobId).reason); return r2.jobId; }
  async function start(issueId) { const q = await quote('eng-start', { productId: 'replydesk', issueId }); const s = await ok('/api/eng/start', { productId: 'replydesk', issueId, confirmToken: q.token }); return s.jobId; }
  async function toApproval() { const id = await issue(); await triage(); const jobId = await start(id); await settled(jobId, ['approval', 'blocked', 'stopped', 'rejected', 'incomplete']); assert.equal(job(jobId).state, 'approval', job(jobId).reason); return { issueId: id, jobId }; }
  const detail = async (id) => { const x = await get('/api/eng/job/' + id); assert.equal(x.status, 200, x.text); return x.json; };
  return { engine, r, E, h, d, clone, state, ok, quote, get, job, settled, issue, triage, start, toApproval, detail, dataRoot: r.dataRoot };
}
const merges = (engine, jobId) => engine.requests.list({ limit: 50 }).filter((x) => x.job_id === jobId && x.action === 'git.merge');

test('1: every new route refuses a caller without the owner\'s page session; the engine refuses an agent, the engine or a script', async (t) => {
  const S = await station(t);
  const routes = { '/api/eng/issue': { productId: 'replydesk', title: 'A title here', happens: 'something happens here', should: 'x', where: 'y' }, '/api/eng/issue-decide': { productId: 'replydesk', issueId: '2026-01-01--x', decision: 'approve', words: 'ok' }, '/api/eng/triage': { productId: 'replydesk' }, '/api/eng/start': { productId: 'replydesk', issueId: '2026-01-01--x' }, '/api/eng/stop': { jobId: 'eng-x' }, '/api/eng/resume': { jobId: 'eng-x' }, '/api/eng/archive': { jobId: 'eng-x' }, '/api/eng/decide': { jobId: 'eng-x', decision: 'approve', words: 'ok' } };
  for (const [p, body] of Object.entries(routes)) {
    assert.equal((await S.h.post(p, body, { token: null })).status, 403, p + ' without the action token');
    assert.equal((await S.h.post(p, body, { token: 'f'.repeat(48) })).status, 403, p + ' with a wrong token');
    assert.equal((await S.h.post(p, body, { origin: 'http://evil.example' })).status, 403, p + ' from another origin');
  }
  for (const p of ['/api/eng/view', '/api/eng/job/eng-x']) { assert.equal((await S.get(p, null)).status, 403, p + ' without the token'); assert.equal((await S.get(p, 'f'.repeat(48))).status, 403, p + ' with a wrong token'); }
  assert.equal((await S.get('/api/eng/view')).status, 200, 'the owner\'s page reads the panel');
  // another address: the routes answer the loopback address only (a request forwarded from elsewhere)
  const fake = (method, url, headers = {}) => { const res = { status: 0, body: '' }; const req = { method, url, headers: { host: '127.0.0.1:1', ...headers }, socket: { remoteAddress: '192.168.1.20' }, on() {} }; return S.h.es.handler(req, { writeHead: (c) => { res.status = c; }, end: (b) => { res.body = String(b); } }).then(() => res); };
  assert.equal((await fake('GET', '/api/eng/view', { 'x-station-action': S.h.token })).status, 403);
  const fr = await fake('POST', '/api/eng/stop', { origin: 'http://127.0.0.1:1', 'x-station-action': S.h.token, 'content-type': 'application/json', 'x-idempotency-key': 'abcdefgh1' });
  assert.equal(fr.status, 403); assert.match(fr.body, /localhost only/);
  // a server on a script engine has no owner session: with its own token every control is refused (LOCKED), before any spend gate
  S.engine.close();
  const se = createEngine({ J: S.r.J, log: S.r.log, startScheduler: false, scriptRun: { purpose: 'r2c test script', startsJobs: true } });
  t.after(() => { try { se.close(); } catch (_) { /* closed */ } });
  const sh = await serve(t, se, S.r.log);
  for (const [p, body] of Object.entries(routes)) { const x = await sh.post(p, body); assert.equal(x.status, 403, p + ' on a script engine: ' + x.text); assert.equal(x.json.code, 'LOCKED', p); }
  assert.equal((await sh.raw('GET', '/api/eng/view', { headers: { 'x-station-action': sh.token } })).status, 403, 'a script engine\'s server has no owner session to read with');
  // the engine: every control needs the owner's registered session
  const E = se.engineering, actors = [{ kind: 'agent', key: 'cto' }, { kind: 'engine' }, { kind: 'owner', session: 'f'.repeat(32) }, undefined];
  for (const actor of actors) {
    assert.throws(() => E.startTriage({ productId: 'replydesk' }, { actor }), (e) => e.code === 'LOCKED', 'triage: ' + JSON.stringify(actor));
    assert.throws(() => E.startIssue({ productId: 'replydesk', issueId: '2026-01-01--x' }, { actor }), (e) => e.code === 'LOCKED', 'start: ' + JSON.stringify(actor));
    await assert.rejects(E.ownerDecide({ jobId: 'eng-x', decision: 'approve', words: 'ok' }, { actor }), (e) => e.code === 'LOCKED', 'decide: ' + JSON.stringify(actor));
    assert.throws(() => E.writeIssue({ productId: 'replydesk', title: 'A title here', problem: 'something happens here, twenty chars' }, { actor }), (e) => e.code === 'LOCKED');
  }
});

test('2: triage and start need the spend confirmation (estimate, cap, budget left); without it nothing is created', async (t) => {
  const S = await station(t);
  const id = await S.issue();
  const jobs = () => S.engine.store.listJobs().length;
  // triage: refused without the confirm token; then with the quote's token
  const n0 = jobs();
  const tr = await S.h.post('/api/eng/triage', { productId: 'replydesk' });
  assert.equal(tr.status, 428, tr.text); assert.equal(tr.json.code, 'CONFIRM_REQUIRED'); assert.equal(jobs(), n0, 'no triage job without the confirmation');
  const tq = await S.quote('eng-triage', { productId: 'replydesk' });
  assert.equal(tq.estimate.usd, 0.11); assert.match(tq.estimate.note, /RESTRUCTURE\.md §8 R2/);
  await S.triage();
  // start: the quote shows the plan's estimate, the USD 3 cap and ReplyDesk's month against USD 80
  const q = await S.quote('eng-start', { productId: 'replydesk', issueId: id });
  assert.deepEqual(q.refusals, []); assert.ok(q.token, 'a confirm token');
  assert.equal(q.estimate.usd, 1.36); assert.equal(q.job.capUsd, 3); assert.equal(q.product.budgetUsd, 80); assert.equal(q.product.monthSpentUsd, 0);
  assert.equal(q.mock, true); assert.match(q.mockNote, /mock: \$0/);
  const html = spendHtml(q);
  assert.match(html, /<span class="m">estimate<\/span><span>about USD 1\.36 on the live provider \(mock: \$0 here\)/);
  assert.match(html, /of the budget USD 80\.00 · left USD 80\.00/);
  assert.match(html, /<span class="m">job cap<\/span><span>USD 3\.00/);
  const n1 = jobs();
  for (const [body, why] of [[{ productId: 'replydesk', issueId: id }, 'no token'], [{ productId: 'replydesk', issueId: id, confirmToken: 'x'.repeat(36) }, 'an unknown token']]) {
    const x = await S.h.post('/api/eng/start', body); assert.equal(x.status, 428, why + ': ' + x.text); assert.equal(jobs(), n1, why + ': nothing created');
  }
  // a token is bound to its issue: another issue's start is refused with it
  const other = await S.issue('Second issue for the binding test');
  const x = await S.h.post('/api/eng/start', { productId: 'replydesk', issueId: other, confirmToken: q.token });
  assert.equal(x.status, 428, x.text); assert.match(x.json.error, /different action or different settings/); assert.equal(jobs(), n1);
  // the right token starts it once; the same token again is refused (single use)
  const q2 = await S.quote('eng-start', { productId: 'replydesk', issueId: id });
  const s = await S.ok('/api/eng/start', { productId: 'replydesk', issueId: id, confirmToken: q2.token });
  assert.equal(s.jobId, 'eng-' + id); assert.equal(s.promise, undefined, 'the answer carries no promise');
  const again = await S.h.post('/api/eng/start', { productId: 'replydesk', issueId: id, confirmToken: q2.token });
  assert.equal(again.status, 428);
  await S.settled(s.jobId, ['approval', 'blocked']); assert.equal(S.job(s.jobId).state, 'approval', S.job(s.jobId).reason);
});

test('3: Stop works mid-step: the call in flight is aborted, every stage and run closed, nothing half-written, and the job resumes cleanly', async (t) => {
  let S = null, stopped = null;
  const hooks = { onStep: ({ job, step, phase }) => { if (step === 'developer' && phase === 'start' && !stopped) stopped = new Promise((res) => setTimeout(() => S.h.post('/api/eng/stop', { jobId: job.id }).then(res), 120)); } };
  S = await station(t, { mockDelayMs: 400, hooks });
  const id = await S.issue(); await S.triage();
  const jobId = await S.start(id);
  await S.settled(jobId, ['stopped', 'blocked', 'approval']);
  const stop = await stopped; assert.equal(stop.status, 200, stop.text); assert.equal(stop.json.result.stopping, true);
  const j = S.job(jobId), dir = path.join(S.dataRoot, 'products', 'replydesk', 'eng', jobId);
  assert.deepEqual([j.state, j.step], ['stopped', 'developer'], j.reason); assert.match(j.reason, /stopped by the owner/);
  assert.equal(S.E.isActive(jobId), false);
  const stages = S.engine.store.stagesOf(jobId);
  assert.ok(stages.every((s) => s.status !== 'running'), 'every stage is closed: ' + JSON.stringify(stages.map((s) => [s.step, s.status])));
  assert.equal(stages[stages.length - 1].status, 'stopped');
  const runs = S.engine.store.runsOf({ jobId });
  assert.ok(runs.every((r) => r.ended_at && r.status !== 'running'), 'every run has ended');
  assert.equal(runs.find((r) => r.step === 'developer').status, 'stopped');
  assert.equal(S.state.inputs.filter((x) => x.agent === 'developer').length, 0, 'the developer call was aborted in flight: the mock never answered it');
  // nothing half-written: no notes, no diff, no verdict, no checks, no temp file anywhere in the job folder; no commit, no request
  const all = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'repo' ? [] : all(path.join(d, e.name))) : [path.join(d, e.name)]));
  const files = all(dir).map((f) => path.relative(dir, f).split(path.sep).join('/'));
  assert.deepEqual(files.filter((f) => /\.tmp-/.test(f)), [], 'no temp file');
  for (const f of ['notes.md', 'diff.patch', 'files.json', 'gates.json', 'merge-request.json']) assert.ok(!files.includes(f), f + ' is not written');
  assert.ok(!files.some((f) => f.startsWith('verdicts/') || f.startsWith('checks/')), 'no verdict, no checks');
  assert.equal(G(S.clone, 'status', '--porcelain'), '', 'the owner\'s clone is untouched');
  assert.equal(G(mirrorDir(S.dataRoot, 'replydesk'), 'rev-parse', branchOf(jobId)), j.data.baseSha, 'the branch has no commit');
  assert.equal(merges(S.engine, jobId).length, 0, 'no merge request');
  // the stop is on the record (the job's events)
  assert.ok(S.engine.bus.recent(500).some((e) => e.type === 'job.stopped' && e.jobId === jobId));
  // it resumes (behind the spend confirmation) and ends in its merge request
  const q = await S.quote('restart', { jobId });
  await S.ok('/api/eng/resume', { jobId, confirmToken: q.token, expectedVersion: j.version });
  await S.settled(jobId, ['approval', 'blocked', 'stopped']);
  assert.equal(S.job(jobId).state, 'approval', S.job(jobId).reason);
  assert.equal(merges(S.engine, jobId).length, 1);
});

test('4: a rework stays inside the job cap with the owner\'s notes; one that would pass the cap blocks with the cap reason; nothing left is refused', async (t) => {
  const cfg = configCopy(tempBase(t, 'r2c-cfg'), { 'engine.json': PRICED });
  const S = await station(t, { configDir: cfg });
  const { jobId } = await S.toApproval();
  const first = merges(S.engine, jobId)[0], spent1 = S.engine.ledger.spent.job(jobId), head1 = S.job(jobId).data.commitSha;
  assert.ok(spent1 > 0 && spent1 < 3, 'the first pass cost something, inside the cap: ' + spent1);
  // the rework: the spend confirmation shows what is left of the cap; without it nothing happens
  const nope = await S.h.post('/api/eng/decide', { jobId, decision: 'rework', words: 'Handle text that is not a number.', expectedVersion: S.job(jobId).version });
  assert.equal(nope.status, 428, nope.text); assert.equal(S.job(jobId).state, 'approval');
  const q = await S.quote('eng-rework', { jobId });
  assert.deepEqual(q.refusals, []); assert.equal(q.estimate.usd, 0.78); assert.ok(Math.abs(q.job.headroomUsd - (3 - spent1)) < 1e-6, 'the headroom is the cap less the spend');
  const r = await S.ok('/api/eng/decide', { jobId, decision: 'rework', words: 'Handle text that is not a number.', expectedVersion: S.job(jobId).version, confirmToken: q.token });
  assert.equal(r.decision, 'rework'); assert.ok(Math.abs(r.leftUsd - (3 - spent1)) < 1e-6);
  await S.settled(jobId, ['approval', 'blocked']);
  const j = S.job(jobId);
  assert.equal(j.state, 'approval', j.reason); assert.equal(j.loops.owner, 1); assert.equal(j.loops.dev || 0, 0, 'the owner\'s rework is not one of the agents\' reworks');
  const dev2 = S.state.inputs.find((x) => x.agent === 'developer' && x.pass === 2);
  assert.ok(dev2 && dev2.input.includes('Handle text that is not a number.') && /REWORK asked by the owner/.test(dev2.input), 'DEVELOPER got the owner\'s notes');
  assert.notEqual(j.data.commitSha, head1, 'a new commit on the branch');
  assert.equal(G(mirrorDir(S.dataRoot, 'replydesk'), 'rev-parse', branchOf(jobId) + '^'), head1, 'on top of the first one');
  const m = merges(S.engine, jobId);
  assert.equal(m.length, 2); assert.equal(m.find((x) => x.id === first.id).status, 'rejected'); assert.match(m.find((x) => x.id === first.id).decision_words, /^Rework: Handle text/);
  assert.equal(m.find((x) => x.id !== first.id).status, 'pending');
  const spent2 = S.engine.ledger.spent.job(jobId); assert.ok(spent2 > spent1 && spent2 <= 3, 'inside the cap: ' + spent2);
  const dec = fs.readFileSync(path.join(S.dataRoot, 'products', 'replydesk', 'eng', jobId, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(dec.map((x) => x.decision), ['rework']); assert.equal(dec[0].words, 'Handle text that is not a number.');
  // the job is nearly at its cap: the rework is accepted (something is left) and blocks at DEVELOPER's first call with the cap reason
  S.engine.ledger.append({ jobId, line: 'engineering', provider: 'mock', model: 'r2c-test-spend', kind: 'text', usd: Math.round((3 - spent2 - 0.0005) * 1e6) / 1e6, note: 'R2c test: spend up to just under the cap' });
  const q2 = await S.quote('eng-rework', { jobId }); assert.deepEqual(q2.refusals, []);
  await S.ok('/api/eng/decide', { jobId, decision: 'rework', words: 'One more change.', expectedVersion: S.job(jobId).version, confirmToken: q2.token });
  await S.settled(jobId, ['approval', 'blocked']);
  const jb = S.job(jobId);
  assert.deepEqual([jb.state, jb.step], ['blocked', 'developer'], jb.reason); assert.match(jb.reason, /cap/i); assert.match(jb.reason, /perJob/);
  assert.ok(S.engine.ledger.spent.job(jobId) <= 3 + 1e-9, 'nothing was spent past the cap');
  assert.equal(G(mirrorDir(S.dataRoot, 'replydesk'), 'rev-parse', branchOf(jobId)), j.data.commitSha, 'no new commit');
  // nothing left: the quote refuses with the cap reason and the engine refuses the rework itself
  S.engine.ledger.append({ jobId, line: 'engineering', provider: 'mock', model: 'r2c-test-spend', kind: 'text', usd: 0.001, note: 'R2c test: the cap reached' });
  const q3 = await S.quote('eng-rework', { jobId }); assert.match(q3.refusals.join(' '), /job cap reached/); assert.equal(q3.token, null);
});

test('5: the diff view and every output on the job view escape HTML and JS', async (t) => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"><svg onload=alert(3)>';
  const S = await station(t, { extra: { 'page.html': '<p>' + evil + '</p>\n' } });
  S.state.summary = 'fine ' + evil;
  const { jobId } = await S.toApproval();
  const d = await S.detail(jobId);
  assert.ok(d.diff.includes('<script>alert(1)</script>'), 'the diff itself holds the raw text');
  const html = jobHtml(d);
  assert.ok(!/<(script|img|svg)\b/i.test(html), 'no live tag in the job view');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&gt;&lt;svg onload=alert(3)&gt;'), 'shown as text');
  const dh = diffHtml('diff --git a/x b/x\n+' + evil + '\n-' + evil + '\n @@ ' + evil);
  assert.ok(!/<(script|img|svg)\b/i.test(dh)); assert.equal((dh.match(/&lt;script&gt;/g) || []).length, 3);
  // every other text on the job view and the panel: issue, spec, notes, verdict findings, check logs, titles, reasons
  const fake = { job: { id: 'eng-x', kind: 'engineering', title: evil, state: 'approval', step: 'merge-request', reason: evil, version: 1, issueId: 'i', capUsd: 3, costUsd: 0 }, issue: evil, spec: evil, notes: evil, diff: '+' + evil, checks: { pass: 1, image: evil, results: [{ check: evil, argv: [evil], passed: false, exitCode: 1, durationMs: 1 }], logs: [{ check: evil, log: evil }] }, verdicts: [{ step: 'reviewer', agent: evil, verdict: 'revise', pass: 1, summary: evil, findings: [{ file: evil, line: 1, severity: 'major', text: evil }] }], steps: [{ step: evil, pass: 1, status: 'done', note: evil, agentName: evil }], decisions: [{ at: evil, decision: evil, words: evil }], otherRequests: [{ action: evil, summary: evil, status: 'pending' }], merge: { id: evil, status: 'pending', payloadSha256: evil }, approval: { holds: false, why: evil }, branch: evil, pull: evil, ready: false, canRework: true };
  for (const out of [jobHtml(fake), jobHtml({ ...fake, job: { ...fake.job, state: 'approved' }, ready: true }), pullHtml(fake), panelHtml({ products: [{ id: 'replydesk', name: evil, repo: evil, repoEnvSet: true, runChecks: [evil], budget: {}, line: { state: 'idle', hold: evil }, issues: [{ id: evil, title: evil, model: evil, state: 'approved', words: evil, triage: { order: 1, size: evil, note: evil }, startProblems: [evil] }], jobs: [{ id: evil, kind: 'engineering', title: evil, state: 'blocked', step: evil, reason: evil, branch: evil, costUsd: 0 }] }], agents: [{ name: evil, model: evil, status: evil }] })]) {
    assert.ok(!/<(script|img|svg)\b/i.test(out), 'no live tag: ' + out.slice(0, 200));
  }
});

test('6: an approval is invalidated by a later diff change: the branch moves after approval, the request is void, nothing to pull', async (t) => {
  const S = await station(t);
  const { jobId } = await S.toApproval();
  const mirror = mirrorDir(S.dataRoot, 'replydesk'), j = S.job(jobId);
  // approve: the branch is ready and the pull command shows
  const a = await S.ok('/api/eng/decide', { jobId, decision: 'approve', words: 'Looks right.', expectedVersion: j.version });
  assert.equal(a.state, 'approved'); assert.equal(a.pull, pullCommand({ dataRoot: S.dataRoot, productId: 'replydesk', jobId }));
  let d = await S.detail(jobId); assert.equal(d.ready, true); assert.equal(d.approval.holds, true); assert.match(jobHtml(d), /data-pull/);
  // the branch moves after the approval (here: back to main): the approval no longer holds, the request is void, the job blocks, no pull
  G(mirror, 'update-ref', 'refs/heads/' + branchOf(jobId), j.data.baseSha);
  d = await S.detail(jobId);
  assert.equal(d.ready, false); assert.equal(d.merge.status, 'void'); assert.equal(d.job.state, 'blocked'); assert.match(d.job.reason, /no longer holds/);
  assert.ok(!/data-pull/.test(jobHtml(d)), 'no pull command is shown'); assert.equal(d.canRework, true);
  assert.ok(d.decisions.some((x) => x.decision === 'approval-void'), 'the void is on the job\'s record');
});

test('6b: a change while the merge request waits: approving is refused and the request voided (the panel and the Owner\'s office)', async (t) => {
  // the diff changes while the request waits
  const S2 = await station(t);
  const { jobId: j2 } = await S2.toApproval();
  fs.appendFileSync(path.join(S2.dataRoot, 'products', 'replydesk', 'eng', j2, 'diff.patch'), '+one more line\n');
  const x = await S2.h.post('/api/eng/decide', { jobId: j2, decision: 'approve', words: 'ok', expectedVersion: S2.job(j2).version });
  assert.equal(x.status, 400, x.text); assert.match(x.json.error, /diff changed after the merge request was filed/);
  assert.equal(merges(S2.engine, j2)[0].status, 'void'); assert.equal(S2.job(j2).state, 'blocked');
  // the same through the Owner's office (the generic decide route), on a second job: the branch moved while the request waits
  const S3 = S2;
  const { jobId: j3 } = await S3.toApproval();
  G(mirrorDir(S3.dataRoot, 'replydesk'), 'update-ref', 'refs/heads/' + branchOf(j3), S3.job(j3).data.baseSha);
  const r3 = merges(S3.engine, j3)[0];
  const y = await S3.h.post('/api/requests/decide', { id: r3.id, decision: 'approve', words: 'ok', expectedVersion: r3.version });
  assert.equal(y.status, 400, y.text); assert.match(y.json.error, /is at .* not at/); assert.equal(merges(S3.engine, j3)[0].status, 'void');
});

test('6c: a rework after approval voids the approval; the next merge request is for a different payload', async (t) => {
  const S4 = await station(t);
  const { jobId: j4 } = await S4.toApproval();
  await S4.ok('/api/eng/decide', { jobId: j4, decision: 'approve', words: 'Yes.', expectedVersion: S4.job(j4).version });
  const before = merges(S4.engine, j4)[0];
  const q = await S4.quote('eng-rework', { jobId: j4 });
  await S4.ok('/api/eng/decide', { jobId: j4, decision: 'rework', words: 'Also cover a negative number.', expectedVersion: S4.job(j4).version, confirmToken: q.token });
  await S4.settled(j4, ['approval', 'blocked']);
  const all = merges(S4.engine, j4);
  assert.equal(all.find((r) => r.id === before.id).status, 'void'); assert.match(all.find((r) => r.id === before.id).decision_words, /rework after approving/);
  const now = all.find((r) => r.id !== before.id); assert.equal(now.status, 'pending'); assert.notEqual(now.payload_sha256, before.payload_sha256);
});

test('7: the pull command shown matches the branch: the engine\'s command, and it fetches the branch at the committed sha', async (t) => {
  const S = await station(t);
  const { jobId } = await S.toApproval();
  await S.ok('/api/eng/decide', { jobId, decision: 'approve', words: 'Ship it to my checkout.', expectedVersion: S.job(jobId).version });
  const d = await S.detail(jobId), want = pullCommand({ dataRoot: S.dataRoot, productId: 'replydesk', jobId });
  assert.equal(d.pull, want); assert.equal(d.branch, 'dev/' + jobId);
  assert.equal(want, 'git fetch "' + mirrorDir(S.dataRoot, 'replydesk').replace(/\\/g, '/') + '" dev/' + jobId + ':dev/' + jobId);
  const shown = /<pre class="eng-cmd" data-pull>([^<]*)<\/pre>/.exec(jobHtml(d))[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(shown, want, 'the page shows exactly the engine\'s command');
  // run it in a clone of the owner's repo (a temp copy): the branch arrives at the committed sha
  const mine = path.join(tempBase(t, 'r2c-pull'), 'checkout');
  G(path.dirname(mine), 'clone', '-q', S.clone, mine);
  const argv = shown.match(/"[^"]+"|\S+/g).map((x) => x.replace(/^"|"$/g, ''));
  assert.deepEqual(argv.slice(0, 2), ['git', 'fetch']);
  G(mine, ...argv.slice(1));
  assert.equal(G(mine, 'rev-parse', 'dev/' + jobId), S.job(jobId).data.commitSha);
});

test('8: the page: the panel, its entries from G and F, the three buttons on a merge request, the issue form', () => {
  const html = read('src/web/index.html'), main = read('src/web/main.js'), bv = read('src/web/ui/building.js'), fm = read('src/web/ui/floormenu.js'), model = read('src/server/engine-model.mjs');
  assert.match(html, /<section id="eng" class="overlay hidden">.*<h2>Engineering<\/h2>.*<div id="eng-body"><\/div><\/section>/);
  assert.match(main, /createFloorMenu\(\{ button: \$\('#floor-btn'\), root: \$\('#floor-menu'\), onFloor: \(n\) => setFloor\(n\), onDept: \(key\) => focusDept\(key\), onEng: \(\) => openEng\(\) \}\)/);
  assert.match(main, /createBuildingView\(\{ root: \$\('#building'\), onFloor: \(n\) => setFloor\(n\), onEng: \(jobId\) => openEng\(jobId\),/);
  assert.match(main, /if \(decision === 'rework'\) \{ closeOverlays\(\); engPanel\.rework\(r\.jobId\);/);
  assert.match(bv, /data-decision="rework">Rework with notes…<\/button>/); assert.match(bv, /Open the Engineering panel/);
  assert.match(fm, /data-eng-open/);
  assert.match(model, /engineering: engine\.engineering && cfg\.lines\.engineering \?/);
  // the issue form's fields become the issue: what happens, what should happen, where; the acceptance criteria as hints
  assert.deepEqual(issueFromForm({ title: 'T', happens: 'it breaks', should: 'it works', where: 'app.py', acceptance: 'AC', model: 'default' }), { title: 'T', problem: 'What happens:\nit breaks\n\nWhat should happen:\nit works\n\nWhere:\napp.py', acceptance: 'AC', model: 'default' });
  const v = { products: [{ id: 'replydesk', name: 'ReplyDesk', repo: 'r', repoEnvSet: true, runChecks: ['test'], budget: { spentUsd: 1, budgetUsd: 80, leftUsd: 79 }, jobCapUsd: 3, line: { state: 'idle', waitingForYou: ['eng-a'] }, issues: [], jobs: [] }], agents: [], mock: true };
  const p = panelHtml(v);
  assert.match(p, /\$1\.00 of \$80\.00 budget · left \$79\.00/); assert.match(p, /<span class="m">job cap<\/span> \$3\.00 a job/); assert.match(p, /engineering line idle/);
});
