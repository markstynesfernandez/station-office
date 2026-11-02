// actions.mjs — R1 (RESTRUCTURE.md §3): the one path an action takes before anything happens. Every engine-executed action, and every
// tool call through the runtime, goes through perform():
//   1. the locked rules (locked.mjs assertActor): a locked action is refused whoever asks, the CEO only reads and writes memos, the COO
//      only pauses lines and writes its report, only the owner resumes a line
//   2. the policy (policy.mjs): an action not in config/autonomy.json is forbidden; the product's stricter override applies
//   3. forbidden: refused, logged (action.refused), and the job blocks with the reason
//      auto: done
//      owner: an approved request whose payload still matches lets it run once (then the request is marked executed); none yet: a
//      request is filed in the Owner's office and the job waits; a payload changed after approval voids that approval, the executor
//      refuses it, and a new request is filed
// Lines (COO, locked rule coo-pause-only): pauseLine() is the COO's only engine action (and the owner's); a paused line starts nothing
// and its routines skip until the owner resumes it (resumeLine: the owner's page session only). No function here, or anywhere in the
// engine, changes a cap, a budget or the policy: those are config files the owner edits.
import { assertActor, LockedRefusal, COO } from './locked.mjs';
import { PolicyRefusal } from './policy.mjs';

const who = (actor) => (actor && actor.kind === 'agent' ? 'agent ' + actor.key : actor && actor.kind ? actor.kind : 'an unnamed caller');

export function createActions(engine) {
  const { store, bus, log } = engine;
  // a job a line is running keeps its own state (the line records the outcome); R2: the engineering line's jobs too
  const running = (id) => !!((engine.orchestrator && engine.orchestrator.isActive(id)) || (engine.engineering && engine.engineering.isActive(id)));

  function refused(e, { action, actor, jobId }) {
    log.warn('action refused', { action, by: who(actor), jobId, rule: e.rule || null, error: e.message });
    try { bus.emit('action.refused', { jobId: jobId || null, agentKey: actor && actor.kind === 'agent' ? actor.key : null, data: { action, by: who(actor), rule: e.rule || null, error: e.message } }); } catch (_) { /* bus closed */ }
    if (jobId) { const j = store.getJob(jobId); if (j && !['blocked', 'archived', 'done'].includes(j.state) && !running(jobId)) store.updateJob(jobId, { state: 'blocked', reason: e.message, ended_at: Date.now() }); }
    throw e;
  }

  // -> { done: true, result } | { waiting: true, requestId, stale? }; throws LockedRefusal / PolicyRefusal when refused
  async function perform({ action, actor, productId = null, departmentId = null, jobId = null, summary = '', payload = '', compliance = null, security = null, execute = null }) {
    const ctx = { action, actor, jobId };
    try { assertActor(action, actor); } catch (e) { return refused(e, ctx); }
    const pd = engine.company.resolve({ productId, departmentId, jobId, agentKey: actor && actor.kind === 'agent' ? actor.key : null }, engine.jobProduct);
    if (!engine.policy.known(action)) return refused(new PolicyRefusal('refused: ' + action + ' is not in config/autonomy.json, so it is forbidden (fail closed)', { action, level: 'forbidden' }), ctx);
    const level = engine.policy.level(action, pd.productId);
    if (level === 'forbidden') return refused(new PolicyRefusal('refused: ' + action + ' is forbidden by the autonomy policy' + (engine.policy.levels[action] !== 'forbidden' ? ' (the ' + pd.productId + ' override)' : ''), { action, level }), ctx);
    const run = async () => ({ done: true, result: execute ? await execute() : null });
    if (level === 'auto') return run();
    // owner: the owner acting on the page is the approval itself
    if (actor && actor.kind === 'owner') { if (!engine.requests.isOwner(actor)) return refused(new LockedRefusal('owner-only-approver', action + ' needs the owner, and this caller has no owner session'), ctx); return run(); }
    const a = engine.requests.approvalFor({ action, jobId, productId: pd.productId, payload });
    if (a.status === 'approved') { const out = await run(); engine.requests.markExecuted(a.request.id); log.info('owner-approved action executed', { action, requestId: a.request.id, jobId }); return out; }
    if (a.status === 'pending') return wait(a.request, jobId);
    let stale = false;
    if (a.status === 'mismatch') { engine.requests.void(a.request.id, 'the payload changed after it was filed or approved (sha256 no longer matches)'); stale = true; }
    const r = engine.requests.file({ action, productId: pd.productId, departmentId: pd.departmentId, jobId, summary: summary || action + (jobId ? ' for ' + jobId : ''), payload, actor, compliance, security });
    return wait(r, jobId, stale);
  }
  function wait(r, jobId, stale = false) {
    if (jobId) { const j = store.getJob(jobId); if (j && !running(jobId)) store.updateJob(jobId, { state: 'queued', reason: 'waiting for the owner: request ' + r.id + ' (' + r.action + ')' + (stale ? '; the earlier approval no longer matched the payload' : ''), data: { waitingFor: 'owner', requestId: r.id, autoStart: false } }); }
    return { waiting: true, requestId: r.id, ...(stale ? { stale: true } : {}) };
  }

  // ---- lines: pause (the COO or the owner), resume (the owner only)
  const key = (line) => 'line:paused:' + line;
  const paused = (line) => store.meta.get(key(line)) || null;
  function pauseLine(line, { actor, reason } = {}) {
    if (!engine.cfg.lines[line]) throw new Error('no such line: ' + line);
    const ctx = { action: 'line.pause', actor, jobId: null };
    if (!actor || !['owner', 'agent'].includes(actor.kind)) return refused(new PolicyRefusal('a line is paused by the COO or the owner (' + who(actor) + ' cannot)', { action: 'line.pause' }), ctx);
    if (actor.kind === 'owner' && !engine.requests.isOwner(actor)) return refused(new LockedRefusal('owner-only-approver', 'pausing as the owner needs the owner\'s page session'), ctx);
    if (actor.kind === 'agent') {
      try { assertActor('line.pause', actor); } catch (e) { return refused(e, ctx); }
      if (actor.key !== COO) return refused(new PolicyRefusal('only the COO pauses a line (' + who(actor) + ' asked)', { action: 'line.pause' }), ctx);
      const st = engine.company.agentStatus(COO); if (st !== 'active') return refused(new PolicyRefusal('the COO is ' + st + ' (not hired yet): it cannot pause a line', { action: 'line.pause' }), ctx);
      if (engine.policy.level('line.pause') !== 'auto') return refused(new PolicyRefusal('line.pause is "' + engine.policy.level('line.pause') + '" in config/autonomy.json', { action: 'line.pause' }), ctx);
    }
    const r = String(reason || '').trim(); if (!r) throw new Error('a pause needs its reason (the breach)');
    const rec = { by: actor.kind === 'owner' ? 'owner (office)' : actor.key, reason: r.slice(0, 500), at: Date.now() };
    store.meta.set(key(line), rec);
    log.warn('line paused', { line, ...rec });
    bus.emit('line.paused', { agentKey: actor.kind === 'agent' ? actor.key : null, data: { line, ...rec } });
    return { line, paused: rec };
  }
  function resumeLine(line, { actor, words } = {}) {
    if (!engine.cfg.lines[line]) throw new Error('no such line: ' + line);
    const ctx = { action: 'line.resume', actor, jobId: null };
    try { assertActor('line.resume', actor); } catch (e) { return refused(e, ctx); }
    if (!engine.requests.isOwner(actor)) return refused(new LockedRefusal('owner-only-approver', 'only the owner resumes a line, on the page'), ctx);
    const was = paused(line); if (!was) return { line, paused: null, note: 'the line was not paused' };
    const w = String(words || '').trim(); if (!w) throw new Error('the owner\'s words are required to resume a line');
    store.meta.set(key(line), null);
    log.info('line resumed by the owner', { line, words: w.slice(0, 200), was });
    bus.emit('line.resumed', { data: { line, words: w.slice(0, 500), was } });
    return { line, resumed: true, was };
  }
  return { perform, pauseLine, resumeLine, paused };
}
