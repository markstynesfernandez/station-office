// bus.mjs — the in-process event bus (ENGINE-PLAN.md §1.4). Every event gets a sequence number, is appended to
// data/events/<Dublin day>.jsonl (the audit trail), kept in a ring buffer for replay, and fanned out to subscribers
// (the SSE stream). Callers write their state change first and emit after, so an event never describes a change that
// was not stored. Event names are the engine's own.
// B0 (owner, 21/10/2026): every event carries businessId (its job's or agent's business; "shared" for the shared floor and station-wide
// events). Events written before B0 are never rewritten (the audit trail is append-only); a reader resolves them the same way.
// R1: every event also carries productId and departmentId (its job's, else its agent's; the station's HQ for station-wide events); events
// written before R1 are resolved on read, the same way (never rewritten). New types: the policy log, requests and line pauses.
import fs from 'node:fs';
import path from 'node:path';
import { dublinDay } from './time.mjs';

export const EVENT_TYPES = ['job.created', 'job.stage', 'job.blocked', 'job.queued-for-approval', 'job.decided', 'owner.action', 'job.stopped', 'job.rejected',
  'run.start', 'run.tool', 'run.end', 'spend.row', 'cap.warn', 'cap.hit', 'routine.fire', 'routine.skip', 'halt.on', 'halt.off', 'agent.updated', 'engine.start', 'engine.recovered',
  'routine.changed', 'action.done', 'action.refused',
  'policy.changed', 'request.filed', 'request.decided', 'request.void', 'line.paused', 'line.resumed',
  // R2: the engineering line (engineering.mjs): the owner's issues and their decisions, a checks pass
  'issue.written', 'issue.decided', 'eng.checks',
  // R3: the executives (execs.mjs): the COO's report written, the CEO's memo written, the owner's mark on a proposal
  'exec.report', 'exec.memo', 'proposal.marked'];

export function createBus({ J, dir = path.join(J.dataRoot, 'events'), log, ringSize = 1000, businessOf = null, productOf = null }) {
  const ring = [], subs = new Set();
  // carry the sequence on across restarts: the last line of the newest events file
  let seq = 0;
  try {
    const d = J.dataJail(dir);
    if (fs.existsSync(d)) {
      const last = fs.readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().pop();
      if (last) { const lines = fs.readFileSync(path.join(d, last), 'utf8').trim().split('\n'); for (let i = lines.length - 1; i >= 0; i--) { try { seq = JSON.parse(lines[i]).seq || 0; break; } catch (_) { /* torn line */ } } }
    }
  } catch (e) { log && log.warn('event sequence not recovered', { error: e.message }); }

  function emit(type, { jobId = null, agentKey = null, data = {} } = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error('unknown event type: ' + type);
    const pd = productOf ? productOf({ jobId, agentKey, productId: data && data.productId, departmentId: data && data.departmentId }) : null;
    const ev = { seq: ++seq, ts: Date.now(), type, jobId, agentKey, ...(businessOf ? { businessId: businessOf({ jobId, agentKey, businessId: data && data.businessId }) } : {}), ...(pd ? { productId: pd.productId, departmentId: pd.departmentId } : {}), data };
    try { J.add(path.join(dir, dublinDay(ev.ts) + '.jsonl'), JSON.stringify(ev) + '\n'); } catch (e) { log && log.error('event not written', { type, error: e.message }); }
    ring.push(ev); if (ring.length > ringSize) ring.shift();
    for (const fn of subs) { try { fn(ev); } catch (e) { log && log.warn('event subscriber failed', { type, error: e.message }); } }
    return ev;
  }
  return {
    emit,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    // events after `afterSeq` still in the ring (SSE replay on reconnect)
    since: (afterSeq) => ring.filter((e) => e.seq > afterSeq),
    recent: (n = 50) => ring.slice(-n),
    get seq() { return seq; }
  };
}
