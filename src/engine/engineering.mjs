// engineering.mjs — R2 (RESTRUCTURE.md §2.2, §5, §8 R2): Engineering and the CTO on a product's code (ReplyDesk first). A line of its own,
// beside the frozen Etsy orchestrator (which hands these jobs over, orchestrator.mjs engJob). Every move is written to SQLite before its event.
//   issues      the owner writes an issue and approves it, on the page (until R4); an edited issue is no longer approved (lib/eng-records.mjs)
//   triage      the CTO (eng-triage line) orders the owner-approved issues into backlog/dev-queue.json; the file is checked when it is
//               written, so the CTO cannot assign an issue the owner has not approved
//   a job       one approved, CTO-assigned issue -> data/products/<id>/eng/<job-id>/ (job id eng-<issue-id>):
//                 worktree       the engine fetches the mirror (repo.fetch) and adds repo/ on dev/<job-id> from main (lib/repo.mjs)
//                 tech-lead      TECH-LEAD writes spec.md (checked on write: sections, AC1..ACn, size)
//                 cto-review     the CTO's architecture verdict, only when the spec says size: large (revise -> TECH-LEAD, at most 2)
//                 developer      DEVELOPER changes repo/ (fs_write, fs_edit), may run_check, writes notes.md
//                 checks         the engine runs every product check in Docker (--network none; lib/checks.mjs): checks/pass-N.json + logs
//                 diff           the engine stages the worktree: diff.patch, files.json and the gates (lib/eng-gates.mjs): gates.json
//                 tester         TESTER: pass / fail per check and per acceptance criterion
//                 reviewer       REVIEWER: approve / revise / refuse against the spec
//                 security       SECURITY: approve / revise / refuse, and a dependency verdict when the diff changes a dependency file
//                 commit         the diff SECURITY saw (same sha256), the secret gate again (a hit refuses the commit), then the commit on
//                                dev/<job-id> (code.commit); the worktree is removed, the branch stays in the mirror
//                 merge-request  a git.merge request in the Owner's office (spec, diff, checks, verdicts, the pull command), plus
//                                dependency.add (with SECURITY's dependency verdict) and ci.change when the diff needs them; the job waits
//                                in "approval". The owner pulls dev/<job-id> from the mirror and merges, pushes and deploys by hand
//               a TESTER fail, a REVIEWER or SECURITY revise sends the job back to DEVELOPER with the findings, at most reworkMax (2) times in
//               all, then the job blocks; a REVIEWER or SECURITY refuse ends it rejected and no merge request is filed
// R3: the same start, stop, resume, archive and running-jobs limit run the executives' jobs (the COO's report, the CEO's memo); execs.mjs
// registers their runner (addRunner) and gets this module's kit (setJob, block, stopFrom, agentWait, mockOnLive).
// The spend guard, the e-stop, the policy and the locked rules sit in front of every model call and tool call as on every line (runtime.mjs);
// the job cap is the product's engineering cap (USD 3.00 for ReplyDesk, owner R0.3). The engine never pushes (lib/repo.mjs).
// R2c: the owner's controls (the Engineering panel, POST /api/eng/*). Writing and deciding an issue, the triage, a start and the decision
// on a finished job need the owner's page session (actor); a script, an agent or the engine is refused (LOCKED). The decision on a merge
// request has three answers (ownerDecide): approve (the branch is ready: the pull command), rework with the owner's notes (back to
// DEVELOPER on the same branch, inside what is left of the job cap) or reject with a reason. An approval holds only while the branch is at
// the commit and the diff the request was filed for (approvalState); a later change voids it (the R1 rule: payload sha256).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runAgent, effectiveAgent } from './runtime.mjs';
import { createChecks } from './lib/checks.mjs';
import { fetchMirror, addWorktree, stagedDiff, commitWorktree, removeWorktree, showAtMain, branchHead, pullCommand, branchOf, JOB_ID_RE } from './lib/repo.mjs';
import { imageTag } from './lib/checks.mjs';
import { gateDiff } from './lib/eng-gates.mjs';
import { composeIssue, readIssue, readDecisions, issueState, listIssues, devQueueProblems, readQueue, checkSpec, issueFile, decisionsFile, queueFile, ISSUE_ID_RE } from './lib/eng-records.mjs';
import { secretContentHits } from './lib/secrets.mjs';
import { foreignDataHits } from './business.mjs';
import { dublinDay } from './time.mjs';
import { EXEC_KINDS } from './lib/exec-inputs.mjs';

export const ENG_KINDS = ['engineering', 'eng-triage'];
// R3: the side lines this module runs: its own two, and the executives' (execs.mjs registers their runner with addRunner)
export const SIDE_KINDS = [...ENG_KINDS, ...EXEC_KINDS];
export const ENG_LINE = 'engineering', TRIAGE_LINE = 'eng-triage';
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const r6 = (n) => Math.round((n || 0) * 1e6) / 1e6;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const refuse = (msg, code = 'ENGINEERING') => Object.assign(new Error(msg), { code });
const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

export function createEngineering(engine, { checks = null, env = process.env, hooks = {}, git = {} } = {}) {
  const { store, bus, log, cfg, J, halt, ledger } = engine;
  const C = engine.company, dataRoot = J.dataRoot;
  const checker = checks || createChecks({ log, timeoutMs: (cfg.engine.runtime || {}).checkTimeoutMs ?? 300000 });
  // R2a: every git call's hard timeout (lib/repo.mjs GIT_TIMEOUT_MS / GIT_FETCH_TIMEOUT_MS unless given); runner is for tests (a git that hangs)
  const GIT = { runner: git.runner, timeoutMs: git.timeoutMs, fetchTimeoutMs: git.fetchTimeoutMs };
  const active = new Map();   // job id -> { line, promise }
  const stops = new Map();    // job id -> AbortController
  const reworking = new Set(); // R2c: jobs whose merge request the owner is rejecting for a rework (the job goes back, it does not end)
  const isActive = (id) => active.has(id);
  const runners = {};          // R3: kind -> run(id, signal, kit) for a side line of another module (the executives: execs.mjs)
  const productRoot = (pid) => path.join(dataRoot, 'products', pid);
  const jobDir = (job) => path.join(productRoot(job.product_id || job.data.productId), 'eng', job.id);
  const backlogDir = (pid) => path.join(productRoot(pid), 'backlog');
  const repoOf = (job) => path.join(jobDir(job), 'repo');
  const lineOf = (id) => { const l = cfg.lines[id]; if (!l) throw refuse('no ' + id + ' line in config/lines'); return l; };
  const hooksDir = (pid) => path.join(productRoot(pid), '.no-hooks');
  const callHook = async (name, arg) => { if (!hooks[name]) return; try { await hooks[name](arg); } catch (e) { log.warn('hook failed (ignored)', { hook: name, error: e.message }); } };

  // ---- products the engineering line serves: active, with a repo, served by the line
  function engProduct(pid) {
    const p = C.product(pid); if (!p) throw refuse('no such product: ' + pid);
    if (p.status !== 'active') throw refuse(p.name + ' is ' + p.status + ': the engineering line works on active products only', 'ARCHIVED');
    if (!(lineOf(ENG_LINE).products || []).includes(pid)) throw refuse('the engineering line does not serve ' + pid + ' (config/lines/engineering.json products)');
    if (!p.localRepoEnv) throw refuse(p.name + ' has no repo the Station can fetch (localRepoEnv)');
    return p;
  }
  const owner = (actor) => engine.requests && engine.requests.isOwner(actor);
  const needOwner = (actor, what) => { if (!owner(actor)) throw Object.assign(new Error(what + ' is the owner\'s, on the page (until R4 the owner writes and approves issues directly)'), { code: 'LOCKED' }); };
  const opusRefusal = () => 'per-issue Opus is refused: Opus has no verified price from Anthropic\'s official pricing page in config/engine.json and no tier (owner, R0.3); write the issue with model "default"';
  const opusPriced = () => Object.values(cfg.engine.tiers || {}).some((t) => /opus/i.test(t.model || '') && ((cfg.engine.pricing.anthropic || {}).models || {})[t.model] && cfg.engine.pricing.anthropic.models[t.model].verified);

  // ---- issues (the owner's)
  function writeIssue({ productId, title, problem, acceptance = '', notes = '', model = 'default' } = {}, { actor } = {}) {
    needOwner(actor, 'writing an issue');
    const p = engProduct(productId);
    if (model === 'opus' && !opusPriced()) throw refuse(opusRefusal(), 'OPUS');
    const c = composeIssue({ title, problem, acceptance, notes, model, productId: p.id, day: dublinDay() });
    if (!c.ok) throw refuse('the issue needs: ' + c.problems.join('; '), 'BAD_REQUEST');
    const fd = foreignDataHits(c.text, cfg); if (fd.length) throw refuse('refused by a building rule: the issue names another company (' + fd.join(', ') + '); its data never enters the Station', 'BAD_REQUEST');
    const sh = secretContentHits(c.text); if (sh.length) throw refuse('the issue holds what looks like a secret (' + sh.join(', ') + '): write it without it', 'BAD_REQUEST');
    let id = c.id, n = 2; while (fs.existsSync(issueFile(dataRoot, p.id, id))) id = c.id.slice(0, 60) + '-' + n++;
    const text = id === c.id ? c.text : c.text.replace('id: ' + c.id, 'id: ' + id);
    J.put(issueFile(dataRoot, p.id, id), text);
    log.info('issue written', { productId: p.id, id, by: 'owner (office)' });
    bus.emit('issue.written', { data: { productId: p.id, issueId: id, title: String(title).trim() } });
    return { productId: p.id, issueId: id };
  }
  // approve (the owner's roadmap decision for this issue), reject or withdraw, with the owner's words
  async function decideIssue({ productId, issueId, decision, words } = {}, { actor } = {}) {
    needOwner(actor, 'deciding an issue');
    const p = engProduct(productId), iss = readIssue(dataRoot, p.id, issueId); if (!iss) throw refuse('no such issue: ' + issueId, 'BAD_REQUEST');
    if (!['approve', 'reject', 'withdraw'].includes(decision)) throw refuse('decision must be approve, reject or withdraw', 'BAD_REQUEST');
    const w = String(words || '').trim(); if (!w || w.length > 2000) throw refuse('the owner\'s words (1 to 2,000 characters) go with every decision', 'BAD_REQUEST');
    if (decision === 'approve' && iss.model === 'opus' && !opusPriced()) throw refuse(opusRefusal(), 'OPUS');
    const rec = { at: new Date().toISOString(), issueId, productId: p.id, decision, sha256: iss.sha256, words: w, by: 'owner (office)', instance: engine.instance ? engine.instance.name : null };
    // the owner on the page is the approval itself (actions.mjs: an owner-level action taken by the owner's session)
    await engine.actions.perform({ action: decision === 'approve' ? 'roadmap.approve' : 'backlog.write', actor, productId: p.id, departmentId: 'engineering', summary: decision + ' issue ' + issueId, payload: iss.text, execute: () => J.add(decisionsFile(dataRoot, p.id), JSON.stringify(rec) + '\n', { fsync: true }) });
    log.info('issue decided', { productId: p.id, issueId, decision });
    bus.emit('issue.decided', { data: { productId: p.id, issueId, decision } });
    return { productId: p.id, issueId, state: issueState(iss, readDecisions(dataRoot, p.id)).state };
  }

  // ---- why an issue cannot start now (null: it can), and the job it would be
  function startProblems(productId, issueId) {
    const out = [];
    let p; try { p = engProduct(productId); } catch (e) { return { problems: [e.message] }; }
    const iss = readIssue(dataRoot, p.id, issueId); if (!iss) return { problems: ['no such issue: ' + issueId] };
    const st = issueState(iss, readDecisions(dataRoot, p.id)).state;
    if (st !== 'approved') out.push('the issue is ' + st + ': only an issue the owner approved (as it reads now) can start');
    if (iss.model === 'opus' && !opusPriced()) out.push(opusRefusal());
    const q = readQueue(dataRoot, p.id), inQ = q && Array.isArray(q.queue) ? q.queue.find((x) => x.issue === issueId) : null;
    if (!inQ) out.push('the CTO has not assigned it yet: run the CTO triage first (backlog/dev-queue.json)');
    else if (q && devQueueProblems(JSON.stringify(q), { dataRoot, productId: p.id }).length) out.push('the dev queue no longer holds (an issue in it is not approved as it reads now): run the CTO triage again');
    const hold = engine.lineHold ? engine.lineHold(ENG_LINE) : null; if (hold) out.push(hold);
    const open = store.listJobs().filter((j) => j.kind === 'engineering' && j.data && j.data.issueId === issueId && j.product_id === p.id && !['archived', 'rejected', 'rejected_by_owner'].includes(j.state));
    if (open.length) out.push('job ' + open[0].id + ' is already open on this issue (' + open[0].state + '): resume or archive it');
    if (!env[p.localRepoEnv]) out.push(p.localRepoEnv + ' is not set: the Station has no clone of ' + (p.repo || p.id) + ' to fetch from');
    let id = 'eng-' + issueId, n = 2; while (store.getJob(id)) id = 'eng-' + issueId + '-r' + n++;
    return { problems: out, product: p, issue: iss, jobId: id };
  }

  // ---- triage: one CTO run over the approved issues -> backlog/dev-queue.json
  function startTriage({ productId, by = 'owner (office)' } = {}, { actor } = {}) {
    needOwner(actor, 'starting the CTO triage');
    const p = engProduct(productId);
    if (halt.isHalted()) throw refuse('e-stop is on', 'HALTED');
    const hold = engine.lineHold ? engine.lineHold(TRIAGE_LINE) : null; if (hold) throw refuse(hold, 'PAUSED');
    if (engine.scriptRun && !engine.scriptRun.startsJobs) throw refuse('no job starts from this script (' + engine.scriptRun.purpose + ')', 'SCRIPT');
    const approved = listIssues(dataRoot, p.id).filter((i) => i.state === 'approved');
    if (!approved.length) throw refuse('no issue of ' + p.name + ' is approved: approve one first (the CTO orders only owner-approved issues)', 'BAD_REQUEST');
    const id = 'eng-triage-' + p.id + '-' + stamp();
    store.insertJob({ id, line: TRIAGE_LINE, kind: 'eng-triage', title: 'CTO triage · ' + p.name, state: 'queued', step: lineOf(TRIAGE_LINE).start, product_id: p.id, department_id: C.deptOfAgent('tech-lead') || 'engineering', data: { productId: p.id, createdBy: by, issues: approved.map((i) => i.id) } });
    bus.emit('job.created', { jobId: id, data: { line: TRIAGE_LINE, title: 'CTO triage', by } });
    log.info('triage job created', { id, productId: p.id, issues: approved.length, by });
    if (engine.scriptRun) engine.scriptRun.own.add(id);
    return { jobId: id, promise: start(id) };
  }

  // ---- an engineering job on one approved, assigned issue
  function startIssue({ productId, issueId, by = 'owner (office)' } = {}, { actor } = {}) {
    needOwner(actor, 'starting an engineering job');
    if (halt.isHalted()) throw refuse('e-stop is on', 'HALTED');
    if (engine.scriptRun && !engine.scriptRun.startsJobs) throw refuse('no job starts from this script (' + engine.scriptRun.purpose + ')', 'SCRIPT');
    const s = startProblems(productId, issueId);
    if (s.problems.length) throw refuse('the issue cannot start: ' + s.problems.join('; '), 'BAD_REQUEST');
    const { product: p, issue: iss, jobId: id } = s;
    if (!JOB_ID_RE.test(id)) throw refuse('the job id ' + id + ' is not a valid branch name');
    store.insertJob({ id, line: ENG_LINE, kind: 'engineering', title: iss.title, state: 'queued', step: lineOf(ENG_LINE).start, product_id: p.id, department_id: C.deptOfAgent('developer') || 'engineering', data: { productId: p.id, issueId, issueSha256: iss.sha256, createdBy: by, branch: branchOf(id) } });
    J.put(path.join(jobDir(store.getJob(id)), 'issue.md'), iss.text);
    bus.emit('job.created', { jobId: id, data: { line: ENG_LINE, title: iss.title, issueId, by } });
    log.info('engineering job created', { id, productId: p.id, issueId, by });
    if (engine.scriptRun) engine.scriptRun.own.add(id);
    return { jobId: id, promise: start(id) };
  }

  // ---- start: one job per line; the station's running-jobs limit counts the Etsy orchestrator's jobs too
  function start(id) {
    const job = store.getJob(id); if (!job || !SIDE_KINDS.includes(job.kind)) throw refuse('no such engineering job: ' + id);
    if (job.state !== 'queued') throw refuse('job ' + id + ' is ' + job.state + ', not queued');
    if (halt.isHalted()) throw refuse('e-stop is on', 'HALTED');
    const hold = engine.lineHold ? engine.lineHold(job.line) : null; if (hold) throw refuse(hold, /^archived/.test(hold) ? 'ARCHIVED' : 'PAUSED');
    if (engine.scriptRun && !engine.scriptRun.own.has(id)) throw refuse('no job starts from this script (' + engine.scriptRun.purpose + ') unless it started it', 'SCRIPT');
    if (isActive(id)) return active.get(id).promise;
    const busy = [...active.entries()].find(([, a]) => a.line === job.line), max = engine.maxRunningJobs || null;
    const others = engine.orchestrator && engine.orchestrator.activeCount ? engine.orchestrator.activeCount() : 0;
    const qd = (job.data && job.data.next && job.data.queuedAt) || Date.now();
    if (busy) { store.updateJob(id, { reason: 'next: waiting for ' + busy[0] + ' (one job at a time on the ' + job.line + ' line)', data: { autoStart: true, next: true, nextFor: 'line', queuedAt: qd } }); return null; }
    if (max && active.size + others >= max) { store.updateJob(id, { reason: 'next: at most ' + max + ' job' + (max === 1 ? '' : 's') + ' running at a time', data: { autoStart: true, next: true, nextFor: 'total', queuedAt: qd } }); return null; }
    if (job.data && job.data.next) store.updateJob(id, { data: { next: false, nextFor: null } });
    const ctl = new AbortController(); stops.set(id, ctl);
    const promise = (runners[job.kind] ? runners[job.kind](id, ctl.signal, kit) : EXEC_KINDS.includes(job.kind) ? Promise.resolve(block(job, 'no runner for ' + job.kind + ' in this engine')) : job.kind === 'eng-triage' ? runTriage(id, ctl.signal) : runSteps(id, ctl.signal))
      .catch((e) => { log.error('engineering job crashed', { id, error: String(e && e.stack || e) }); try { block(store.getJob(id), 'engine error: ' + e.message); } catch (_) { /* store gone */ } })
      .finally(() => { stops.delete(id); active.delete(id); startNext(id); });
    active.set(id, { line: job.line, promise });
    return promise;
  }
  function startNext(endedId) {
    if (halt.isHalted()) return;
    const waiting = store.listJobs({ states: ['queued'] }).filter((j) => SIDE_KINDS.includes(j.kind) && j.id !== endedId && j.data && j.data.autoStart && !j.data.waitingFor && !isActive(j.id) && !/^interrupted/.test(j.reason || '')).sort((a, b) => ((a.data.queuedAt || 0) - (b.data.queuedAt || 0)));
    for (const j of waiting) { if ([...active.values()].some((a) => a.line === j.line)) continue; if (engine.scriptRun && !engine.scriptRun.own.has(j.id)) continue; try { start(j.id); } catch (e) { log.warn('next engineering job not started', { jobId: j.id, error: e.message }); } }
    if (engine.orchestrator && engine.orchestrator.startNext) { try { engine.orchestrator.startNext(endedId); } catch (_) { /* nothing waiting */ } }
  }

  // ---- state changes: written first, event after
  function setJob(id, patch, event, data = {}) { const j = store.updateJob(id, patch); if (event) bus.emit(event, { jobId: id, agentKey: data.agentKey || null, data: { state: j.state, step: j.step, reason: j.reason, ...data } }); return j; }
  function block(job, reason, { state = 'blocked' } = {}) { log.warn('engineering job ' + state, { jobId: job.id, step: job.step, reason }); return setJob(job.id, { state, reason, ended_at: Date.now() }, state === 'rejected' ? 'job.rejected' : 'job.blocked', state === 'incomplete' ? { incomplete: true } : {}); }
  const mockOnLive = (id) => !!(engine.providers && engine.providers.mode === 'mock') && ledger.rowsForJob(id).some((r) => r.provider && r.provider !== 'mock');
  const stopFrom = (run, who) => (run.status === 'stopped' ? { stopped: who + ' run stopped: ' + run.endReason } : run.status === 'cap' ? { blocked: run.endReason } : run.status === 'refused' ? { blocked: who + ' run refused: ' + run.endReason } : run.status === 'failed' ? { blocked: who + ' run failed: ' + run.error } : run.status === 'max-turns' ? { blocked: who + ' run hit ' + run.endReason } : run.status === 'incomplete' ? { incomplete: who + ' ' + run.endReason } : null);
  const rel = (job, f) => path.relative(jobDir(job), f).split(path.sep).join('/');
  const kit = { setJob: (...a) => setJob(...a), block: (...a) => block(...a), stopFrom: (...a) => stopFrom(...a), agentWait: (...a) => agentWait(...a), mockOnLive: (...a) => mockOnLive(...a) };
  const agentName = (k) => (cfg.agents[k] || {}).name || k;

  // ---- the triage run
  async function runTriage(id, signal) {
    let job = setJob(id, { state: 'running', started_at: Date.now(), reason: null }, 'job.stage', { step: 'cto-triage' });
    const p = C.product(job.product_id), dir = backlogDir(p.id), qf = queueFile(dataRoot, p.id);
    const def = lineOf(TRIAGE_LINE).steps[job.step] || {};
    const wait = agentWait(job, def.agent); if (wait) return wait;
    if (mockOnLive(id)) return block(job, 'the job has live spend and this engine runs the mock provider');
    const before = fs.existsSync(qf) ? fs.statSync(qf).mtimeMs : 0;
    const approved = listIssues(dataRoot, p.id).filter((i) => i.state === 'approved'), q = readQueue(dataRoot, p.id);
    const openJobs = store.listJobs().filter((j) => j.kind === 'engineering' && j.product_id === p.id && !['archived', 'approved', 'rejected', 'rejected_by_owner'].includes(j.state));
    const input = ['CTO triage for ' + p.name + ' (' + (p.repo || p.id) + '). Order the owner-approved issues into dev-queue.json.', '',
      'OWNER-APPROVED ISSUES (read each in issues/<id>.md):', ...approved.map((i) => '- ' + i.id + ': ' + i.title + (i.model !== 'default' ? ' (model ' + i.model + ')' : '')), '',
      'OPEN ENGINEERING JOBS: ' + (openJobs.length ? openJobs.map((j) => j.data.issueId + ' (' + j.state + ')').join(', ') : 'none'), '',
      'THE CURRENT QUEUE: ' + (q ? JSON.stringify(q.queue || []) : 'none yet'), '',
      'Write dev-queue.json: { "product": "' + p.id + '", "queue": [ { "issue": "<id>", "order": 1, "size": "small" | "large", "note": "why this order, in one line" } ], "notes": "…" }. Only the issues listed above; leave out one that has an open job.'].join('\n');
    const step = job.step, sid = store.tx(() => store.openStage(id, step, 1));
    bus.emit('job.stage', { jobId: id, agentKey: def.agent, data: { step, pass: 1, kind: 'agent' } });
    const contract = { tool: 'fs_write', partialOk: false, hint: 'Write dev-queue.json with fs_write.', check() { const now = fs.existsSync(qf) ? fs.statSync(qf).mtimeMs : 0; return now > before ? { want: 1, have: 1, missing: [] } : { want: 1, have: 0, missing: ['dev-queue.json'] }; } };
    const run = await runAgent(engine, { agentKey: def.agent, job, step, pass: 1, folder: dir, folderLabel: 'the backlog of ' + p.name + ' (issues/, issue-decisions.jsonl, dev-queue.json)', input, line: job.line, runCapUsd: null, stopSignal: signal, contract, eng: { repoRel: 'repo', validators: { 'dev-queue.json': (t) => devQueueProblems(t, { dataRoot, productId: p.id }) } }, writes: def.writes || ['dev-queue.json'] });
    const stop = stopFrom(run, agentName(def.agent));
    store.closeStage(sid, stop ? (stop.stopped ? 'stopped' : stop.incomplete ? 'incomplete' : 'blocked') : 'done', stop ? stop.stopped || stop.blocked || stop.incomplete : 'dev-queue.json written');
    if (stop) { if (stop.stopped) return setJob(id, { state: 'stopped', reason: stop.stopped, ended_at: Date.now() }, 'job.stopped'); return block(store.getJob(id), stop.blocked || stop.incomplete, { state: stop.incomplete ? 'incomplete' : 'blocked' }); }
    const nq = readQueue(dataRoot, p.id);
    return setJob(id, { state: 'done', reason: 'dev queue: ' + ((nq && nq.queue) || []).map((x) => x.order + '. ' + x.issue).join(', '), ended_at: Date.now(), data: { costUsd: ledger.spent.job(id) } }, 'job.stage', { step: 'done' });
  }

  // an off-duty agent's step waits (queued, waitingFor the agent) until the owner puts it back on duty
  function agentWait(job, key) {
    if (effectiveAgent(engine, key).enabled) return null;
    log.info('engineering job waits for an off-duty agent', { jobId: job.id, agent: key });
    return setJob(job.id, { state: 'queued', reason: 'waiting: ' + agentName(key) + ' is off duty', data: { waitingFor: key, autoStart: true } }, 'job.stage', { step: job.step, waiting: key });
  }
  function wakeWaiting(key) {
    if (halt.isHalted()) return [];
    const out = [];
    for (const j of store.listJobs({ states: ['queued'] }).filter((x) => SIDE_KINDS.includes(x.kind) && x.data && x.data.waitingFor === key)) { store.updateJob(j.id, { data: { waitingFor: null } }); try { start(j.id); out.push(j.id); } catch (e) { log.warn('waiting engineering job not started', { jobId: j.id, error: e.message }); } }
    return out;
  }

  // ---- the engineering job: the steps in order, the loops bounded
  async function runSteps(id, signal) {
    let job = setJob(id, { state: 'running', started_at: store.getJob(id).started_at || Date.now(), reason: null, data: { next: false } }, 'job.stage', { step: store.getJob(id).step });
    const L = lineOf(ENG_LINE);
    let step = job.step;
    while (step) {
      job = store.getJob(id);
      if (halt.isHalted()) return setJob(id, { state: 'stopped', step, reason: 'stopped by the e-stop at ' + step, ended_at: Date.now() }, 'job.stopped');
      if (signal.aborted) return setJob(id, { state: 'stopped', step, reason: 'stopped by the owner at ' + step, ended_at: Date.now() }, 'job.stopped');
      const def = L.steps[step]; if (!def) return block(job, 'the engineering line has no step "' + step + '"');
      if (def.kind === 'agent') {
        if (def.when === 'large' && job.data.specSize !== 'large') { step = def.next; store.updateJob(id, { step }); continue; }
        const w = agentWait(store.updateJob(id, { step }), def.agent); if (w) return w;
        if (mockOnLive(id)) return setJob(id, { state: 'stopped', step, reason: 'stopped before ' + step + ': the job has live spend and this engine runs the mock provider', ended_at: Date.now() }, 'job.stopped');
      }
      const pass = passOf(job, step);
      const sid = store.tx(() => { const s = store.openStage(id, step, pass); store.updateJob(id, { step }); return s; });
      bus.emit('job.stage', { jobId: id, agentKey: def.agent || null, data: { step, pass, kind: def.kind } });
      await callHook('onStep', { job: store.getJob(id), step, def, pass, phase: 'start' });
      let r;
      try { r = def.kind === 'agent' ? await agentStep(store.getJob(id), step, def, pass, signal) : await MECH[def.fn](store.getJob(id), def, signal); }
      catch (e) {
        // R2a: a git process that did not finish in its timeout was killed (lib/proc.mjs); the job blocks with "git timeout", never stalls
        if (e && e.code === 'GIT_TIMEOUT') { r = { blocked: 'git timeout in ' + step + ': ' + e.message.replace(/^git timeout: /, '') }; log.error('git timeout', { id, step, subcommand: e.subcommand, error: e.message }); }
        else { r = e && e.code === 'STOPPED' ? { stopped: 'stopped during ' + step + ': ' + e.message } : { blocked: 'engine error in ' + step + ': ' + e.message }; if (!r.stopped) log.error('engineering step crashed', { id, step, error: String(e && e.stack || e) }); }
      }
      store.closeStage(sid, r.blocked ? 'blocked' : r.stopped ? 'stopped' : r.incomplete ? 'incomplete' : r.rejected ? 'rejected' : 'done', r.blocked || r.stopped || r.incomplete || r.rejected || r.note || null);
      job = store.updateJob(id, { data: { costUsd: r6(ledger.spent.job(id)) } });
      await callHook('onStep', { job, step, def, pass, phase: 'end', result: r });
      if (r.stopped) return setJob(id, { state: 'stopped', reason: r.stopped, ended_at: Date.now() }, 'job.stopped');
      if (r.blocked) return block(job, r.blocked);
      if (r.incomplete) return block(job, r.incomplete, { state: 'incomplete' });
      if (r.rejected) return block(job, r.rejected, { state: 'rejected' });
      if (r.approval) return setJob(id, { state: 'approval', step, reason: r.approval, ended_at: Date.now() }, 'job.queued-for-approval', { requests: r.requests });
      step = r.next === undefined ? def.next : r.next;
      if (step) store.updateJob(id, { step });
    }
    return store.getJob(id);
  }
  // the pass of a step: the spec loop for TECH-LEAD and the CTO, the rework loop for DEVELOPER and the reviewers
  // R2c: an owner's rework (loops.owner) is a pass of its own too; it does not count against the agents' rework loop (reworkMax)
  function passOf(job, step) { const l = job.loops || {}; return ['tech-lead', 'cto-review'].includes(step) ? 1 + (l.spec || 0) : ['worktree', 'commit', 'merge-request'].includes(step) ? 1 + (l.owner || 0) : 1 + (l.dev || 0) + (l.owner || 0); }

  // the latest verdict record of a step, or null
  const verdictFile = (job, step, pass) => path.join(jobDir(job), 'verdicts', step + '-pass' + pass + '.json');
  const latestVerdict = (job, step) => { for (let n = passOf(job, step); n >= 1; n--) { const v = readJson(verdictFile(job, step, n)); if (v) return { pass: n, ...v }; } return null; };
  const findingsText = (v) => (v.findings || []).map((f, i) => (i + 1) + '. ' + (f.file ? f.file + (f.line ? ':' + f.line : '') + ' ' : '') + (f.severity ? '[' + f.severity + '] ' : '') + (f.criterion ? '(' + f.criterion + ') ' : '') + f.text).join('\n') || '(no findings given)';
  const checksRecord = (job) => (job.data.checksPass ? readJson(path.join(jobDir(job), 'checks', 'pass-' + job.data.checksPass + '.json')) : null);

  // what each agent step is given, and what it must leave behind
  async function agentStep(job, step, def, pass, signal) {
    const folder = jobDir(job), p = C.product(job.product_id), worktree = repoOf(job), notes = [];
    let input, contract = null, seen = null;
    const verdictContract = (kind) => ({ tool: 'submit_verdict', partialOk: false, hint: 'Record your verdict with submit_verdict (kind "' + kind + '").', check: () => (seen ? { want: 1, have: 1, missing: [] } : { want: 1, have: 0, missing: ['your ' + kind + ' verdict (submit_verdict)'] }) });
    const loopNote = pass > 1 ? '[LOOP — pass ' + pass + ']' : '';
    if (step === 'tech-lead') {
      const cto = job.loops.spec ? latestVerdict(job, 'cto-review') : null;
      input = [loopNote, 'Write the spec for the owner-approved issue in issue.md (' + p.name + ', ' + (p.repo || p.id) + '). The code is in repo/ (read only for you).', '',
        readText(path.join(folder, 'issue.md')) || '', '',
        cto ? 'THE CTO ASKED FOR A REVISE of your spec (architecture review, pass ' + cto.pass + '). Fix every point:\n' + findingsText(cto) : '',
        'Write spec.md with the sections ## Problem, ## Scope, ## Out of scope, ## Acceptance criteria (one testable statement per line, "AC1: …"), ## Test plan, ## Files likely touched, ## Risk notes, and a line "size: small" or "size: large".'].filter((x) => x !== '').join('\n');
      const before = fs.existsSync(path.join(folder, 'spec.md')) ? fs.statSync(path.join(folder, 'spec.md')).mtimeMs : 0;
      contract = { tool: 'fs_write', partialOk: false, hint: 'Write spec.md with fs_write (it is checked when written).', check: () => { const f = path.join(folder, 'spec.md'); return fs.existsSync(f) && fs.statSync(f).mtimeMs > before ? { want: 1, have: 1, missing: [] } : { want: 1, have: 0, missing: ['spec.md'] }; } };
    } else if (step === 'cto-review') {
      input = [loopNote, 'Architecture review of spec.md (size: large) for issue ' + job.data.issueId + ' on ' + p.name + '. Read issue.md, spec.md and the code it touches in repo/. Approve, or revise with findings TECH-LEAD can act on. Record it with submit_verdict, kind "architecture".'].filter(Boolean).join('\n');
      contract = verdictContract('architecture');
    } else if (step === 'developer') {
      const back = job.loops.dev || job.loops.owner ? reworkFrom(job) : null;
      input = [loopNote, 'Implement spec.md in repo/ (branch ' + job.data.branch + ' of ' + (p.repo || p.id) + '). issue.md is the owner\'s issue.',
        'Change only what the spec needs; add or update tests for every acceptance criterion. Use fs_edit for changes to existing files. run_check runs the product\'s checks (' + Object.keys(p.runChecks || {}).join(', ') + ') in a container with no network; you have ' + ((effectiveAgent(engine, 'developer').limits || {}).maxChecks || 0) + ' run_check calls.',
        'Dependencies: you cannot install anything. A change to ' + 'requirements.txt or another dependency file becomes a dependency.add request for the owner, after SECURITY\'s audit; a change under .github/workflows/ becomes a ci.change request.',
        back ? '\n' + back : '', '', 'Before you end, write notes.md: what you changed and why, how you tested it (the checks you ran and their results), and anything left open.'].filter((x) => x !== '').join('\n');
      const nf = path.join(folder, 'notes.md'), before = fs.existsSync(nf) ? fs.statSync(nf).mtimeMs : 0;
      contract = { tool: 'fs_write', partialOk: false, hint: 'Write notes.md with fs_write when the change is done.', check: () => (fs.existsSync(nf) && fs.statSync(nf).mtimeMs > before ? { want: 1, have: 1, missing: [] } : { want: 1, have: 0, missing: ['notes.md (what you changed, how you tested it)'] }) };
    } else if (step === 'tester') {
      const ck = checksRecord(job);
      input = [loopNote, 'Test the change for issue ' + job.data.issueId + '. The engine ran the checks: checks/pass-' + job.data.checksPass + '.json (results) and its logs; diff.patch is the change; spec.md has the acceptance criteria (' + (job.data.criteria || []).join(', ') + ').',
        'Results: ' + (ck ? ck.results.map((x) => x.check + ' ' + (x.passed ? 'passed' : x.timedOut ? 'timed out' : 'FAILED (exit ' + x.exitCode + ')')).join(', ') : 'none'), 'You may run_check again (with a filter) to look closer. Record your verdict with submit_verdict, kind "test": checks (each check: pass/fail), criteria (each AC: pass, fail or not-covered), findings for every fail.'].filter(Boolean).join('\n');
      contract = verdictContract('test');
    } else if (step === 'reviewer') {
      const t = latestVerdict(job, 'tester');
      input = [loopNote, 'Review the change for issue ' + job.data.issueId + ' against spec.md: diff.patch (the whole change), files.json (what changed), repo/ (the code as it now is), notes.md (DEVELOPER\'s notes), checks/ and TESTER\'s verdict (' + (t ? t.verdict : 'none') + ').',
        'Approve, revise (findings DEVELOPER can act on, each with its file and line) or refuse (the change should not be made at all). Record it with submit_verdict, kind "review".'].filter(Boolean).join('\n');
      contract = verdictContract('review');
    } else if (step === 'security') {
      const g = readJson(path.join(folder, 'gates.json')) || {};
      input = [loopNote, 'Security audit of the change for issue ' + job.data.issueId + ' before the owner sees a merge request: diff.patch, files.json, gates.json (the engine\'s gates: secret scan ' + (g.ok ? 'clean' : 'HIT') + '; dependency files changed: ' + ((g.dependencyFiles || []).join(', ') || 'none') + '; workflow files changed: ' + ((g.workflowFiles || []).join(', ') || 'none') + ')' + ((g.dependencyFiles || []).length ? ', deps.patch (the dependency change)' : '') + ', and repo/.',
        'Look for injection, auth and access mistakes, secrets, unsafe deserialisation, SSRF, unsafe file handling, personal data exposure and risky dependencies. Approve, revise (findings with file and line) or refuse. ' + ((g.dependencyFiles || []).length ? 'The diff changes dependency files: give dependencyVerdict (approve, revise or refuse) for them. ' : '') + 'Record it with submit_verdict, kind "security".'].filter(Boolean).join('\n');
      contract = verdictContract('security');
    } else return { blocked: 'no agent step "' + step + '"' };
    notes.push('Product: ' + p.name + ' (' + (p.repo || p.id) + ') · issue ' + job.data.issueId + ' · branch ' + job.data.branch + (job.data.specSize ? ' · size ' + job.data.specSize : '') + '.');
    const eng = {
      repoRel: 'repo',
      validators: step === 'tech-lead' ? { 'spec.md': (t) => checkSpec(t).problems } : {},
      onVerdict: (v) => { seen = v; },
      verdictContext: () => { const ck = checksRecord(store.getJob(job.id)), g = readJson(path.join(folder, 'gates.json')) || {}; return { checks: ck ? ck.results.map((x) => x.check) : [], criteria: store.getJob(job.id).data.criteria || [], dependencyFiles: g.dependencyFiles || [] }; },
      runCheck: async ({ check, filter, runId, n }) => {
        const r = await checker.runCheck({ product: p, name: check, filter, worktree, image: store.getJob(job.id).data.image, signal: AbortSignal.any([halt.signal, signal]) });
        const lf = path.join(folder, 'checks', 'runs', runId + '-' + n + '-' + check + '.log');
        J.put(lf, '# ' + check + (filter ? ' ' + filter : '') + ' · ' + r.argv.join(' ') + ' · image ' + r.image + ' · exit ' + r.exitCode + (r.timedOut ? ' (timed out)' : '') + ' · ' + r.durationMs + ' ms\n' + r.output);
        return { ...r, logRel: rel(job, lf) };
      }
    };
    const run = await runAgent(engine, { agentKey: def.agent, job, step, pass, folder, folderLabel: 'the engineering job folder of ' + job.id + ' (issue.md, spec.md, notes.md, diff.patch, checks/, verdicts/, and repo/: the code)', input, line: job.line, runCapUsd: null, stopSignal: signal, contract, verdictKind: def.verdict || null, eng, writes: def.writes || [], wrapperNotes: notes, hooks: { onRunStart: hooks.onRunStart } });
    const v = run.verdict || seen;
    if (v) J.put(verdictFile(job, step, pass), JSON.stringify({ ...v, step, pass, agent: def.agent, runId: run.runId, at: new Date().toISOString() }, null, 2) + '\n');
    if (run.reportedBlocked && run.status === 'incomplete') return { incomplete: agentName(def.agent) + ' reported blocked: ' + run.reportedBlocked };
    const stop = stopFrom(run, agentName(def.agent)); if (stop) return stop;
    if (step === 'tech-lead') {
      const sc = checkSpec(readText(path.join(folder, 'spec.md')) || '');
      if (!sc.ok) return { blocked: 'spec.md does not hold: ' + sc.problems.join('; ') };
      store.updateJob(job.id, { data: { specSize: sc.size, criteria: sc.criteria } });
      return { next: def.next, note: 'spec written: size ' + sc.size + ', ' + sc.criteria.length + ' acceptance criteria' };
    }
    if (!def.verdict) return { next: def.next, note: agentName(def.agent) + ' done' };
    if (!v) return { blocked: agentName(def.agent) + ' ended without a verdict' };
    return route(store.getJob(job.id), step, def, v);
  }
  // the findings DEVELOPER gets on a rework: from the step that sent it back
  function reworkFrom(job) {
    // R2c: the owner's notes on a rework stay with the job (data.ownerNotes) until its next merge request, whoever sent it back last
    const owner = job.data.ownerNotes ? '[REWORK asked by the owner (' + (job.loops.owner || 1) + ')] The owner sent the merge request back. The branch already holds the earlier change (repo/ is at its last commit). The owner\'s notes, about this change:\n' + job.data.ownerNotes : '';
    const from = job.data.reworkFrom, v = from && from !== 'owner' ? latestVerdict(job, from) : null;
    const agents = v ? '[REWORK ' + job.loops.dev + ' of ' + lineOf(ENG_LINE).reworkMax + '] ' + agentName(lineOf(ENG_LINE).steps[from].agent) + ' said ' + v.verdict + '. Fix every point:\n' + findingsText(v) + (v.summary ? '\nSummary: ' + v.summary : '') : '';
    return [owner, agents].filter(Boolean).join('\n\n');
  }
  // a verdict routes the job: on, back (a bounded loop), or out
  function route(job, step, def, v) {
    const L = lineOf(ENG_LINE), l = job.loops || {};
    if (step === 'cto-review') {
      if (v.verdict === 'approve') return { next: def.next, note: 'the CTO approved the spec' };
      if ((l.spec || 0) >= (L.specReworkMax ?? 2)) return { blocked: 'the CTO asked for a revise of the spec again and the spec loop is used up (' + (L.specReworkMax ?? 2) + '): the owner decides' };
      store.updateJob(job.id, { loops: { spec: (l.spec || 0) + 1 } });
      return { next: 'tech-lead', note: 'the CTO asked for a revise: back to TECH-LEAD' };
    }
    const ok = v.verdict === 'pass' || v.verdict === 'approve';
    if (ok) return { next: def.next, note: agentName(def.agent) + ': ' + v.verdict };
    if (v.verdict === 'refuse') return { rejected: agentName(def.agent) + ' refused the change: ' + (v.summary || (v.findings[0] || {}).text || 'no reason given') + ' (no merge request is filed)' };
    if ((l.dev || 0) >= (L.reworkMax ?? 2)) return { blocked: agentName(def.agent) + ' said ' + v.verdict + ' and the rework loop is used up (' + (L.reworkMax ?? 2) + ' reworks): the owner decides (resume, or archive the job)' };
    store.updateJob(job.id, { loops: { dev: (l.dev || 0) + 1 }, data: { reworkFrom: step } });
    return { next: 'developer', note: agentName(def.agent) + ' said ' + v.verdict + ': back to DEVELOPER (rework ' + ((l.dev || 0) + 1) + ')' };
  }

  // ---- the mechanical steps (no model, no cost)
  const engineActor = { kind: 'engine' };
  const perform = (job, action, summary, execute, payload = '') => engine.actions.perform({ action, actor: engineActor, productId: job.product_id, departmentId: job.department_id, jobId: job.id, summary, payload, execute });
  const MECH = {
    // fetch the mirror, then the job's worktree on dev/<job-id>, and the check image for main's requirements
    async worktree(job, def, signal) {
      const p = C.product(job.product_id);
      // R2c: the owner's rework: the job's own branch again at its last commit (no fetch: the base and the check image stay the job's),
      // then DEVELOPER (the spec stands)
      if (job.data.rework) {
        const w = await perform(job, 'repo.worktree', 'worktree ' + branchOf(job.id) + ' (the owner\'s rework)', () => addWorktree({ J, productId: p.id, jobId: job.id, dir: repoOf(job), signal, ...GIT }));
        store.updateJob(job.id, { data: { worktreeRemoved: false, worktree: rel(job, repoOf(job)) } });
        return { next: 'developer', note: 'the owner\'s rework: worktree ' + (w.result.created ? 'added' : 'kept') + ' on ' + w.result.branch + ' at ' + String(job.data.commitSha || '').slice(0, 10) };
      }
      const f = await perform(job, 'repo.fetch', 'fetch ' + p.id + ' main into the Station\'s mirror', () => fetchMirror({ J, product: p, signal, env, ...GIT }));
      const m = f.result;
      const w = await perform(job, 'repo.worktree', 'worktree ' + branchOf(job.id), () => addWorktree({ J, productId: p.id, jobId: job.id, dir: repoOf(job), signal, ...GIT }));
      const req = await showAtMain({ J, productId: p.id, file: (p.checkImage && p.checkImage.requirements) || 'requirements.txt', signal, ...GIT });
      const image = req != null ? imageTag(p, req) : null;
      store.updateJob(job.id, { data: { mirrorHead: m.head, baseSha: w.result.baseSha || job.data.baseSha || m.head, image, worktree: rel(job, repoOf(job)) } });
      return { next: def.next, note: 'mirror at ' + m.head.slice(0, 10) + ' (' + m.ref + ' of the local clone); worktree ' + (w.result.created ? 'added' : 'kept') + ' on ' + w.result.branch + (image ? '; check image ' + image : '; no requirements file at main') };
    },
    // every product check, in Docker; no Docker or no image refuses (the job blocks with the reason)
    async checks(job, def, signal) {
      const p = C.product(job.product_id), n = (job.data.checksPass || 0) + 1, results = [];
      const out = await perform(job, 'code.check', 'checks pass ' + n, async () => {
        for (const name of Object.keys(p.runChecks || {})) {
          const r = await checker.runCheck({ product: p, name, worktree: repoOf(job), image: job.data.image, signal: AbortSignal.any([halt.signal, signal]) });
          const lf = path.join(jobDir(job), 'checks', 'pass-' + n, name + '.log');
          J.put(lf, '# ' + r.argv.join(' ') + ' · image ' + r.image + ' · exit ' + r.exitCode + (r.timedOut ? ' (timed out)' : '') + ' · ' + r.durationMs + ' ms\n' + r.output);
          results.push({ check: name, argv: r.argv, passed: r.passed, exitCode: r.exitCode, timedOut: r.timedOut, stopped: r.stopped, ...(r.timedOut ? { timeoutMs: r.timeoutMs } : {}), durationMs: r.durationMs, log: rel(job, lf) });
          if (r.stopped || r.timedOut) break;
        }
        return results;
      }).catch((e) => ({ error: e }));
      if (out.error) return out.error.code === 'NO_DOCKER' || out.error.code === 'NO_IMAGE' ? { blocked: out.error.message } : { blocked: 'checks failed to run: ' + out.error.message };
      if (results.some((r) => r.stopped)) return { stopped: 'stopped during the checks' };
      J.put(path.join(jobDir(job), 'checks', 'pass-' + n + '.json'), JSON.stringify({ pass: n, at: new Date().toISOString(), image: job.data.image, results }, null, 2) + '\n');
      // R2a.1 (owner, 26/10/2026): a check that timed out blocks the job with the reason (it is not a result TESTER can judge)
      const to = results.find((r) => r.timedOut);
      if (to) { log.warn('check timed out', { id: job.id, check: to.check, timeoutMs: to.timeoutMs }); return { blocked: 'check "' + to.check + '" timed out after ' + Math.round((to.timeoutMs || to.durationMs) / 1000) + ' s and was killed (its container stopped); the log is ' + to.log + '. Resume to run the checks again, or archive the job' }; }
      store.updateJob(job.id, { data: { checksPass: n, checks: results.map((r) => ({ check: r.check, passed: r.passed })) } });
      bus.emit('eng.checks', { jobId: job.id, data: { pass: n, results: results.map((r) => ({ check: r.check, passed: r.passed, exitCode: r.exitCode })) } });
      return { next: def.next, note: 'checks pass ' + n + ': ' + (results.map((r) => r.check + ' ' + (r.passed ? 'passed' : 'failed')).join(', ') || 'none configured') };
    },
    // stage the worktree: diff.patch, files.json, the gates
    async diff(job, def, signal) {
      const d = await stagedDiff({ dir: repoOf(job), jobId: job.id, baseSha: job.data.baseSha, signal, hooks: hooksDir(job.product_id), ...GIT });
      if (!d.files.length) return { blocked: 'DEVELOPER made no change in repo/: nothing to test, review or commit' };
      const g = gateDiff({ patch: d.patch, files: d.files }), dir = jobDir(job);
      J.put(path.join(dir, 'diff.patch'), d.patch); J.put(path.join(dir, 'files.json'), JSON.stringify({ files: d.files, stat: d.stat }, null, 2) + '\n');
      J.put(path.join(dir, 'gates.json'), JSON.stringify({ ok: g.ok, secrets: g.secrets, dependencyFiles: g.dependencyFiles, workflowFiles: g.workflowFiles, at: new Date().toISOString() }, null, 2) + '\n');
      if (g.depsPatch) J.put(path.join(dir, 'deps.patch'), g.depsPatch);
      store.updateJob(job.id, { data: { diffSha256: sha256(d.patch), changed: d.files.length, gates: { ok: g.ok, secrets: g.secrets.length, dependencyFiles: g.dependencyFiles, workflowFiles: g.workflowFiles } } });
      return { next: def.next, note: d.files.length + ' file(s) changed; secret gate ' + (g.ok ? 'clean' : g.secrets.length + ' hit(s)') + (g.dependencyFiles.length ? '; dependency files: ' + g.dependencyFiles.join(', ') : '') + (g.workflowFiles.length ? '; workflow files: ' + g.workflowFiles.join(', ') : '') };
    },
    // the commit: exactly the diff SECURITY saw, the secret gate again, then dev/<job-id>
    async commit(job, def, signal) {
      const d = await stagedDiff({ dir: repoOf(job), jobId: job.id, baseSha: job.data.baseSha, signal, hooks: hooksDir(job.product_id), ...GIT });
      if (sha256(d.patch) !== job.data.diffSha256) return { blocked: 'the worktree changed after TESTER, REVIEWER and SECURITY saw the diff (sha256 differs): nothing was committed' };
      const g = gateDiff({ patch: d.patch, files: d.files });
      if (!g.ok) { bus.emit('action.refused', { jobId: job.id, data: { action: 'code.commit', rule: 'secrets-refused', what: g.secrets.map((s) => s.path + ': ' + s.kind) } }); return { blocked: 'refused by a locked rule (secrets-refused): the diff holds what looks like a secret (' + g.secrets.map((s) => s.path + ': ' + s.kind).join('; ') + '); nothing was committed' }; }
      // R2c: an owner's rework that changed nothing: the branch stays at its commit (git has nothing to commit)
      if (job.data.commitSha && job.data.committedDiffSha256 === job.data.diffSha256) return { next: def.next, note: 'no change since ' + String(job.data.commitSha).slice(0, 10) + ': nothing new to commit on ' + branchOf(job.id) };
      const iss = readIssue(dataRoot, job.product_id, job.data.issueId), title = (iss ? iss.title : job.title || job.id);
      const msg = job.id + ': ' + title + '\n\nIssue ' + job.data.issueId + ' (approved by the owner). Spec, reviews and checks: the Station\'s job folder eng/' + job.id + '/.\nTESTER ' + ((latestVerdict(job, 'tester') || {}).verdict || '-') + ', REVIEWER ' + ((latestVerdict(job, 'reviewer') || {}).verdict || '-') + ', SECURITY ' + ((latestVerdict(job, 'security') || {}).verdict || '-') + '.';
      const c = await perform(job, 'code.commit', 'commit ' + branchOf(job.id), () => commitWorktree({ dir: repoOf(job), jobId: job.id, message: msg, signal, hooks: hooksDir(job.product_id), ...GIT }));
      store.updateJob(job.id, { data: { commitSha: c.result, committedDiffSha256: job.data.diffSha256 } });
      return { next: def.next, note: 'committed ' + String(c.result).slice(0, 10) + ' on ' + branchOf(job.id) };
    },
    // the merge request (and dependency.add / ci.change when needed) in the Owner's office; the worktree goes, the branch stays
    async mergeRequest(job, def, signal) {
      const dir = jobDir(job), p = C.product(job.product_id), sec = latestVerdict(job, 'security') || {}, gates = readJson(path.join(dir, 'gates.json')) || {};
      const head = await branchHead({ J, productId: p.id, jobId: job.id, signal, ...GIT });
      if (!head || head !== job.data.commitSha) return { blocked: 'the branch ' + branchOf(job.id) + ' is not at the committed ' + String(job.data.commitSha || '').slice(0, 10) + ' in the mirror' };
      const patch = readText(path.join(dir, 'diff.patch')) || '', pull = pullCommand({ dataRoot, productId: p.id, jobId: job.id });
      const security = { verdict: sec.verdict || null, by: 'security', findings: (sec.findings || []).length, dependencyVerdict: sec.dependencyVerdict || null };
      const filed = [];
      const ask = async (action, summary, payload, extra = {}) => { const r = await engine.actions.perform({ action, actor: engineActor, productId: p.id, departmentId: job.department_id, jobId: job.id, summary, payload, security: extra.security || security }); filed.push({ action, requestId: r.requestId || null, done: !!r.done }); return r; };
      await ask('git.merge', 'Merge ' + branchOf(job.id) + ' into main: ' + (job.title || job.data.issueId), mergePayload(job, head, patch));
      if ((gates.dependencyFiles || []).length) await ask('dependency.add', 'Dependency change in ' + branchOf(job.id) + ': ' + gates.dependencyFiles.join(', '), readText(path.join(dir, 'deps.patch')) || '', { security: { verdict: sec.dependencyVerdict || null, by: 'security', findings: (sec.findings || []).length } });
      if ((gates.workflowFiles || []).length) await ask('ci.change', 'CI change in ' + branchOf(job.id) + ': ' + gates.workflowFiles.join(', '), splitFor(patch, gates.workflowFiles));
      J.put(path.join(dir, 'merge-request.json'), JSON.stringify({ jobId: job.id, branch: branchOf(job.id), commit: head, pull, requests: filed, at: new Date().toISOString() }, null, 2) + '\n');
      await removeWorktree({ J, productId: p.id, dir: repoOf(job), signal, ...GIT }).catch((e) => (e.code === 'GIT_TIMEOUT' ? log.error('git timeout', { id: job.id, step: 'merge-request', subcommand: e.subcommand, error: e.message, note: 'the commit and the merge request are made; the worktree is kept' }) : log.warn('worktree not removed (kept)', { jobId: job.id, error: e.message })));
      store.updateJob(job.id, { data: { requests: filed, pull, worktreeRemoved: true, rework: false } });
      return { approval: 'waiting for the owner: merge request ' + (filed[0] && filed[0].requestId) + (filed.length > 1 ? ' (+ ' + filed.slice(1).map((x) => x.action).join(', ') + ')' : '') + '; the engine never pushes: ' + pull, requests: filed };
    }
  };
  // the git.merge request's payload: the commit, the branch, the pull command and the whole diff (its sha256 is what the owner approves)
  const mergePayload = (job, head, patch) => 'commit ' + head + '\nbranch ' + branchOf(job.id) + '\npull: ' + pullCommand({ dataRoot, productId: job.product_id, jobId: job.id }) + '\n\n' + patch;
  const splitFor = (patch, files) => String(patch).split(/^(?=diff --git )/m).filter((x) => files.some((f) => x.startsWith('diff --git a/' + f + ' ') || x.includes(' b/' + f + '\n'))).join('');

  // ---- the owner's decision on a merge request ends the job (approved: the owner merges by hand; rejected: rejected by the owner)
  const unsub = bus.subscribe((ev) => {
    if (ev.type !== 'request.decided' || !ev.jobId || !ev.data || ev.data.action !== 'git.merge') return;
    const j = store.getJob(ev.jobId); if (!j || j.kind !== 'engineering' || j.state !== 'approval') return;
    if (reworking.has(j.id)) return;   // R2c: rejected for the owner's rework: ownerDecide sends the job back to DEVELOPER
    const ok = ev.data.status === 'approved';
    try { setJob(j.id, { state: ok ? 'approved' : 'rejected_by_owner', reason: ok ? 'the owner approved the merge request: pull ' + branchOf(j.id) + ' from the Station\'s mirror and merge, push and deploy by hand (' + (j.data.pull || '') + ')' : 'the owner rejected the merge request', ended_at: Date.now() }, ok ? 'job.decided' : 'job.rejected', { action: 'git.merge', status: ev.data.status }); } catch (e) { log.warn('merge decision not recorded on the job', { jobId: j.id, error: e.message }); }
  });

  // ---- the owner's controls on a job
  function stop(id, { expectedVersion = null } = {}) {
    const j = store.getJob(id); if (!j || !SIDE_KINDS.includes(j.kind)) throw refuse('no such engineering job: ' + id);
    if (expectedVersion != null && j.version !== expectedVersion) throw Object.assign(new Error('job ' + id + ' changed since you loaded it'), { code: 'STALE' });
    const c = stops.get(id);
    if (c) { c.abort(new Error('stopped by the owner')); return { jobId: id, stopping: true }; }
    if (j.state === 'queued') { setJob(id, { state: 'stopped', reason: 'stopped by the owner before it ran', ended_at: Date.now(), data: { autoStart: false, next: false } }, 'job.stopped'); return { jobId: id, stopped: true }; }
    throw refuse('job ' + id + ' is ' + j.state + ': nothing to stop');
  }
  // resume a blocked, stopped or incomplete job at the step it ended on (a rework loop that is used up is not reset)
  function resume(id, { expectedVersion = null, by = 'owner (office)' } = {}) {
    const j = store.getJob(id); if (!j || !SIDE_KINDS.includes(j.kind)) throw refuse('no such engineering job: ' + id);
    if (expectedVersion != null && j.version !== expectedVersion) throw Object.assign(new Error('job ' + id + ' changed since you loaded it'), { code: 'STALE' });
    if (!['blocked', 'stopped', 'incomplete', 'queued'].includes(j.state) || isActive(id)) throw refuse('job ' + id + ' is ' + j.state + ': only a blocked, stopped or incomplete job resumes');
    if (j.kind === 'engineering' && j.data.worktreeRemoved) throw refuse('job ' + id + ' has been committed and its worktree removed: nothing to resume');
    setJob(id, { state: 'queued', reason: 'resumed by ' + by + ' at ' + j.step, ended_at: null, data: { waitingFor: null, autoStart: false } }, 'job.stage', { step: j.step, restart: true });
    const promise = start(id);
    return { jobId: id, step: j.step, started: !!promise };
  }
  // archive an ended job: its worktree is removed (the branch stays in the mirror), its folder kept
  async function archive(id, { expectedVersion = null } = {}) {
    const j = store.getJob(id); if (!j || !SIDE_KINDS.includes(j.kind)) throw refuse('no such engineering job: ' + id);
    if (expectedVersion != null && j.version !== expectedVersion) throw Object.assign(new Error('job ' + id + ' changed since you loaded it'), { code: 'STALE' });
    if (isActive(id) || ['running', 'approval'].includes(j.state)) throw refuse('job ' + id + ' is ' + j.state + ': stop it (or decide its merge request) first');
    if (j.kind === 'engineering' && fs.existsSync(repoOf(j))) await removeWorktree({ J, productId: j.product_id, dir: repoOf(j), ...GIT });
    setJob(id, { state: 'archived', reason: 'archived by the owner' + (j.kind === 'engineering' ? ' (the branch ' + branchOf(id) + ' stays in the mirror)' : ''), data: { autoStart: false, worktreeRemoved: true } }, 'job.stage', { step: 'archived' });
    return { jobId: id, archived: true };
  }

  // ---- R2c: the owner's decision on a finished job's merge request (the Engineering panel and the Owner's office: three buttons)
  const jobCapOf = (j) => { const p = C.product(j.product_id) || {}; return (p.jobCapUsdByDepartment || {})[j.department_id] ?? null; };
  const mergeOf = (j) => { const r = (j.data.requests || []).find((x) => x.action === 'git.merge'); return r && r.requestId ? engine.requests.get(r.requestId) : null; };
  // does the approval (or the pending request) still hold? The branch must be at the commit the request was filed for and the payload
  // (commit, branch, pull command, diff) must have the sha256 the request recorded -> { holds, why, head }
  async function approvalState(j, merge = mergeOf(j)) {
    if (!merge) return { holds: false, why: 'there is no merge request for ' + j.id, head: null };
    const head = await branchHead({ J, productId: j.product_id, jobId: j.id, ...GIT });
    if (!head) return { holds: false, why: 'the branch ' + branchOf(j.id) + ' is gone from the Station\'s mirror', head };
    if (head !== j.data.commitSha) return { holds: false, why: 'the branch ' + branchOf(j.id) + ' is at ' + head.slice(0, 10) + ', not at ' + String(j.data.commitSha || '').slice(0, 10) + ', the commit the merge request was filed for', head };
    if (sha256(mergePayload(j, head, readText(path.join(jobDir(j), 'diff.patch')) || '')) !== merge.payload_sha256) return { holds: false, why: 'the diff changed after the merge request was filed (its sha256 no longer matches)', head };
    return { holds: true, why: null, head };
  }
  // an approval that no longer holds is voided (requests.mjs) and the job blocks with the reason; nothing is ready to pull
  function voidApproval(j, merge, why) {
    engine.requests.void(merge.id, why);
    logDecision(j, { decision: 'approval-void', requestId: merge.id, words: why, by: 'engine' });
    return setJob(j.id, { state: 'blocked', reason: 'your approval of ' + merge.id + ' no longer holds: ' + why + '. Nothing is ready to pull: ask for a rework, or archive the job', ended_at: Date.now(), data: { approvalVoided: merge.id } }, 'job.blocked');
  }
  // every owner decision on a job, next to its records (the request decisions are in data/requests/decisions.jsonl as well)
  function logDecision(j, rec) {
    const row = { at: new Date().toISOString(), jobId: j.id, branch: branchOf(j.id), commit: j.data.commitSha || null, diffSha256: j.data.diffSha256 || null, by: 'owner (office)', ...rec };
    J.add(path.join(jobDir(j), 'decisions.jsonl'), JSON.stringify(row) + '\n', { fsync: true });
    log.info('engineering decision', { jobId: j.id, decision: rec.decision, requestId: rec.requestId || null });
  }
  // decision: approve | rework | reject; words: the owner's words (the reason; the notes for a rework). requestVersion: from the Owner's
  // office (the request row the page loaded); expectedVersion: from the Engineering panel (the job row)
  async function ownerDecide({ jobId, decision, words, expectedVersion = null, requestVersion = null } = {}, { actor } = {}) {
    needOwner(actor, 'deciding a merge request');
    const j = store.getJob(jobId); if (!j || j.kind !== 'engineering') throw refuse('no such engineering job: ' + jobId, 'BAD_REQUEST');
    if (expectedVersion != null && j.version !== expectedVersion) throw Object.assign(new Error('job ' + jobId + ' changed since you loaded it'), { code: 'STALE' });
    if (!['approve', 'rework', 'reject'].includes(decision)) throw refuse('decision must be approve, rework or reject', 'BAD_REQUEST');
    const w = String(words || '').trim(); if (!w || w.length > 2000) throw refuse(decision === 'rework' ? 'your notes for DEVELOPER (1 to 2,000 characters) go with a rework' : 'your words (1 to 2,000 characters) go with every decision', 'BAD_REQUEST');
    if (isActive(jobId)) throw refuse('job ' + jobId + ' is running: stop it first', 'BAD_REQUEST');
    const merge = mergeOf(j);
    if (merge && requestVersion != null && merge.version !== requestVersion) throw Object.assign(new Error('request ' + merge.id + ' changed since you loaded it'), { code: 'STALE' });
    if (decision === 'rework') return rework(j, merge, w, actor);
    if (j.state !== 'approval' || !merge || merge.status !== 'pending') throw refuse('job ' + jobId + ' is ' + j.state + ': there is no merge request waiting for you', 'BAD_REQUEST');
    if (decision === 'approve') {
      const a = await approvalState(j, merge);
      if (!a.holds) { voidApproval(j, merge, a.why); throw refuse('not approved: ' + a.why + '; the request is void and the job blocked', 'STALE_DIFF'); }
    }
    engine.requests.decide(merge.id, { decision: decision === 'approve' ? 'approve' : 'reject', words: w, expectedVersion: merge.version, actor });
    logDecision(j, { decision, requestId: merge.id, words: w });
    const out = store.getJob(jobId);
    return { jobId, decision, state: out.state, pull: decision === 'approve' ? out.data.pull : null, branch: branchOf(jobId) };
  }
  // the owner's rework: back to DEVELOPER on the same branch, inside what is left of the job cap (the guard holds every call to it)
  function rework(j, merge, notes, actor) {
    const ended = j.data.commitSha && j.data.worktreeRemoved && (['approval', 'approved'].includes(j.state) || (j.state === 'blocked' && j.data.approvalVoided));
    if (!ended) throw refuse('job ' + j.id + ' is ' + j.state + ': a rework is for a job that ended in a merge request (waiting for you, approved, or its approval void)', 'BAD_REQUEST');
    if (halt.isHalted()) throw refuse('e-stop is on', 'HALTED');
    const cap = jobCapOf(j), spent = r6(ledger.spent.job(j.id));
    if (cap != null && spent >= cap - 1e-9) throw refuse('the job cap is reached: USD ' + spent.toFixed(2) + ' of USD ' + cap.toFixed(2) + ' spent on ' + j.id + '; a rework cannot run inside it', 'JOB_CAP');
    reworking.add(j.id);
    try {
      if (merge && merge.status === 'pending') engine.requests.decide(merge.id, { decision: 'reject', words: 'Rework: ' + notes, expectedVersion: merge.version, actor });
      else if (merge && merge.status === 'approved') engine.requests.void(merge.id, 'the owner asked for a rework after approving: the diff will change, so the approval no longer holds');
    } finally { reworking.delete(j.id); }
    // the dependency.add and ci.change requests of this diff go too: the diff will change
    for (const x of (j.data.requests || []).filter((r) => r.action !== 'git.merge' && r.requestId)) { const r = engine.requests.get(x.requestId); if (r && ['pending', 'approved'].includes(r.status)) engine.requests.void(r.id, 'the owner asked for a rework of ' + j.id); }
    logDecision(j, { decision: 'rework', requestId: merge ? merge.id : null, words: notes, capUsd: cap, spentUsd: spent });
    setJob(j.id, { state: 'queued', step: 'worktree', reason: 'rework asked by the owner: ' + notes.slice(0, 200), ended_at: null, loops: { owner: (j.loops.owner || 0) + 1 }, data: { rework: true, reworkFrom: 'owner', ownerNotes: notes, requests: [], pull: null, approvalVoided: null, autoStart: false, waitingFor: null, next: false } }, 'job.stage', { step: 'worktree', rework: true });
    const promise = start(j.id);
    return { jobId: j.id, decision: 'rework', started: !!promise, capUsd: cap, spentUsd: spent, leftUsd: cap != null ? r6(cap - spent) : null, promise };
  }

  // ---- the page: issues, the queue, the jobs, each job's card; the CI wall per product (R7 draws it)
  function view() {
    const products = (lineOf(ENG_LINE).products || []).map((pid) => C.product(pid)).filter(Boolean).map((p) => {
      const issues = listIssues(dataRoot, p.id).map((i) => ({ id: i.id, title: i.title, model: i.model, state: i.state, decidedAt: i.decision ? i.decision.at : null, words: i.decision ? i.decision.words : null }));
      const q = readQueue(dataRoot, p.id), qp = q ? devQueueProblems(JSON.stringify(q), { dataRoot, productId: p.id }) : [];
      const jobs = store.listJobs().filter((j) => ENG_KINDS.includes(j.kind) && j.product_id === p.id).slice(0, 30).map(jobView);
      const wall = jobs.filter((j) => j.kind === 'engineering' && j.checks && j.checks.length).slice(0, 10).map((j) => ({ jobId: j.id, title: j.title, at: j.updatedAt, checks: j.checks }));
      // R2c: the panel: each issue's place in the CTO's queue and why it cannot start yet; the month against the budget; the job cap
      for (const i of issues) { const e = q && Array.isArray(q.queue) ? q.queue.find((x) => x.issue === i.id) : null; i.triage = e ? { order: e.order, size: e.size, note: e.note || null } : null; if (i.state === 'approved') { const sp = startProblems(p.id, i.id); i.startProblems = sp.problems; i.jobId = sp.jobId || null; } }
      const month = dublinDay().slice(0, 7), spent = r6(ledger.spent.productMonth(p.id, month)), dept = C.deptOfAgent('developer') || 'engineering';
      const running = jobs.filter((j) => j.running || j.state === 'running');
      return { id: p.id, name: p.name, repo: p.repo || null, repoEnvSet: !!env[p.localRepoEnv], repoEnv: p.localRepoEnv, runChecks: Object.keys(p.runChecks || {}), issues, queue: q ? { queue: q.queue || [], notes: q.notes || null, holds: !qp.length, problems: qp } : null, jobs, ciWall: wall,
        budget: { month, spentUsd: spent, budgetUsd: p.monthlyBudgetUsd ?? null, leftUsd: p.monthlyBudgetUsd != null ? r6(p.monthlyBudgetUsd - spent) : null }, jobCapUsd: (p.jobCapUsdByDepartment || {})[dept] ?? null,
        line: { state: running.length ? 'running' : 'idle', running: running.map((j) => j.id), hold: (engine.lineHold ? engine.lineHold(ENG_LINE) : null) || null, waitingForYou: jobs.filter((j) => j.state === 'approval').map((j) => j.id) } };
    });
    // the line's agents (the engineering and triage lines), with their models: the issue's "default" model is theirs
    const keys = [...new Set([TRIAGE_LINE, ENG_LINE].flatMap((l) => Object.values(lineOf(l).steps).filter((s) => s.kind === 'agent').map((s) => s.agent)))];
    const agents = keys.map((k) => { const a = effectiveAgent(engine, k), t = cfg.engine.tiers[a.tier] || {}; return { key: k, name: agentName(k), status: (cfg.agents[k] || {}).status || null, onDuty: !!a.enabled, model: t.model || null }; });
    return { products, lines: [ENG_LINE, TRIAGE_LINE], agents, opus: opusPriced() ? 'priced' : opusRefusal(), halted: halt.isHalted(), mock: !!(engine.providers && engine.providers.mode === 'mock') };
  }
  // R2c: one job for the panel: the card (issue, spec, notes, diff, checks and their logs, verdicts), every step with its agent and outcome,
  // the cost against the cap, the owner's decisions, and whether an approval still holds (an approval that no longer holds is voided here)
  async function jobDetail(jobId) {
    let j = store.getJob(jobId); if (!j || !ENG_KINDS.includes(j.kind)) return null;
    const L = lineOf(j.line), dir = jobDir(j);
    const steps = store.stagesOf(j.id).map((s) => ({ step: s.step, pass: s.pass, status: s.status, note: s.reason, startedAt: s.started_at, endedAt: s.ended_at, agent: (L.steps[s.step] || {}).agent || null, agentName: (L.steps[s.step] || {}).agent ? agentName(L.steps[s.step].agent) : null, kind: (L.steps[s.step] || {}).kind || null }));
    const runs = store.runsOf({ jobId: j.id, limit: 100 }).map((r) => ({ agent: r.agent_key, step: r.step, pass: r.pass, status: r.status, usd: r.usd, startedAt: r.started_at, endedAt: r.ended_at }));
    const decisionsOf = () => (readText(path.join(dir, 'decisions.jsonl')) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (j.kind !== 'engineering') return { job: jobView(j), steps, runs, decisions: decisionsOf(), triage: { queue: readQueue(dataRoot, j.product_id) } };
    let merge = mergeOf(j), approval = null;
    if (merge && ['pending', 'approved'].includes(merge.status) && ['approval', 'approved'].includes(j.state)) {
      const a = await approvalState(j, merge);
      if (!a.holds && merge.status === 'approved') { j = voidApproval(j, merge, a.why); merge = engine.requests.get(merge.id); }
      approval = { holds: a.holds, why: a.why, head: a.head };
    }
    const others = (j.data.requests || []).filter((x) => x.action !== 'git.merge' && x.requestId).map((x) => engine.requests.get(x.requestId)).filter(Boolean).map((r) => ({ id: r.id, action: r.action, status: r.status, summary: r.summary }));
    const c = card(j.id), verdictsFull = ['cto-review', 'tester', 'reviewer', 'security'].map((s) => { const v = latestVerdict(j, s); return v ? { ...v, step: s, agent: agentName(L.steps[s].agent) } : null; }).filter(Boolean);
    const ready = j.state === 'approved' && !!approval && approval.holds && merge && merge.status === 'approved';
    return { ...c, verdicts: verdictsFull, steps, runs, decisions: decisionsOf(), merge: merge ? { id: merge.id, status: merge.status, version: merge.version, payloadSha256: merge.payload_sha256, words: merge.decision_words || null, decidedAt: merge.decided_at || null } : null, otherRequests: others, approval, ready, pull: c.pull, branch: branchOf(j.id), mirror: path.relative(dataRoot, path.join(productRoot(j.product_id), 'repo.git')).split(path.sep).join('/'), capUsd: jobCapOf(j), costUsd: r6(ledger.spent.job(j.id)), canRework: !!(j.data.commitSha && j.data.worktreeRemoved && !isActive(j.id) && (['approval', 'approved'].includes(j.state) || (j.state === 'blocked' && j.data.approvalVoided))) };
  }
  function jobView(j) {
    const out = { id: j.id, kind: j.kind, title: j.title, state: j.state, step: j.step, reason: j.reason, version: j.version, issueId: j.data.issueId || null, branch: j.data.branch || null, specSize: j.data.specSize || null, loops: j.loops, costUsd: r6(ledger.spent.job(j.id)), capUsd: (C.product(j.product_id) || {}).jobCapUsdByDepartment ? C.product(j.product_id).jobCapUsdByDepartment[j.department_id] || null : null, checks: j.data.checks || null, gates: j.data.gates || null, commit: j.data.commitSha || null, requests: j.data.requests || [], pull: j.data.pull || null, updatedAt: j.updated_at, running: isActive(j.id) };
    if (j.kind === 'engineering') { const dir = jobDir(j); out.verdicts = ['cto-review', 'tester', 'reviewer', 'security'].map((s) => { const v = latestVerdict(j, s); return v ? { step: s, pass: v.pass, verdict: v.verdict, findings: (v.findings || []).length, dependencyVerdict: v.dependencyVerdict || null } : null; }).filter(Boolean); out.hasSpec = fs.existsSync(path.join(dir, 'spec.md')); }
    return out;
  }
  // the merge request's card: spec, diff, test log, verdicts and the pull command (read from the job folder; capped)
  function card(jobId) {
    const j = store.getJob(jobId); if (!j || j.kind !== 'engineering') return null;
    const dir = jobDir(j), cap = (t, n) => (t == null ? null : t.length > n ? t.slice(0, n) + '\n… [' + (t.length - n) + ' more characters in the job folder]' : t);
    const ck = checksRecord(j);
    return { job: jobView(j), issue: cap(readText(path.join(dir, 'issue.md')), 20000), spec: cap(readText(path.join(dir, 'spec.md')), 40000), notes: cap(readText(path.join(dir, 'notes.md')), 20000), diff: cap(readText(path.join(dir, 'diff.patch')), 120000), files: readJson(path.join(dir, 'files.json')), gates: readJson(path.join(dir, 'gates.json')),
      checks: ck ? { ...ck, logs: ck.results.map((r) => ({ check: r.check, log: cap(readText(path.join(dir, r.log)), 30000) })) } : null,
      verdicts: ['cto-review', 'tester', 'reviewer', 'security'].map((s) => latestVerdict(j, s)).filter(Boolean), pull: j.data.pull || pullCommand({ dataRoot, productId: j.product_id, jobId: j.id }), folder: path.relative(dataRoot, dir).split(path.sep).join('/') };
  }
  // the owner's command: build the check image for main's requirements (lib/checks.mjs; downloads the requirements once)
  async function buildCheckImage(productId, { signal = null } = {}) {
    const p = engProduct(productId);
    await fetchMirror({ J, product: p, signal, env, ...GIT });
    const req = await showAtMain({ J, productId: p.id, file: (p.checkImage && p.checkImage.requirements) || 'requirements.txt', signal, ...GIT });
    if (req == null) throw refuse(p.name + ' has no ' + ((p.checkImage && p.checkImage.requirements) || 'requirements.txt') + ' at main');
    return checker.buildImage({ J, product: p, requirementsText: req, signal });
  }

  return { addRunner: (kind, fn) => { if (!EXEC_KINDS.includes(kind)) throw new Error('not a side-line kind: ' + kind); runners[kind] = fn; }, handles: (kind) => SIDE_KINDS.includes(kind), writeIssue, decideIssue, startTriage, startIssue, startProblems, start, stop, resume, archive, ownerDecide, approvalState: (id) => approvalState(store.getJob(id)), wakeWaiting, isActive, active: () => [...active.keys()], activeCount: () => active.size, view, jobView, jobDetail, card, buildCheckImage, checks: checker, close: () => unsub() };
}
