// requests.mjs — R1 (RESTRUCTURE.md §3.1 item 4, §3.2 rule 1): the Owner's office queue on the penthouse. B0's approvals (one row per Etsy
// job) are generalised into requests: one row per owner-approval action, any product, any department. Agents (through the engine) file
// them; only the owner decides one, and every decision is logged.
//   file(…)        an agent's or the engine's request for an action at level owner (actions.mjs files it when an action needs the owner).
//                  It records the product, department, job, action, a one-line summary, the payload's sha256 (the exact text or diff
//                  approved; the payload itself in data/requests/<id>/payload.txt), COMPLIANCE's verdict where required (an outbound
//                  draft needs a pass: a revise or refuse never becomes a request, whoever files it; locked rule compliance-independent)
//                  and SECURITY's verdict for a merge request. The CEO files none: its proposals are documents (ceo-recommends-only).
//   decide(…)      the owner's decision: approved or rejected, with the owner's words. Locked rule owner-only-approver: the actor must be
//                  the owner's page session (the per-launch token the server registers; same-origin and the idempotency key are the
//                  server's checks, as E5); an agent, the engine, a script run or a caller without that session is refused. Each decision
//                  is written to the row (versioned: a stale page is refused), appended to data/requests/decisions.jsonl (fsync), logged
//                  and emitted (request.decided).
//   approvalFor(…) the executor's check: an approved request for this action and job whose payload sha256 still matches. A payload that
//                  changed after the approval no longer matches: the request is voided and the executor refuses.
// No model is called here and nothing leaves the building: approving records the owner's decision; the action itself is the owner's or
// the engine's own executor's (never an agent's), in a later phase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LockedRefusal, COMPLIANCE_GATED, CEO } from './locked.mjs';
import { VersionConflict } from './store/db.mjs';

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'void', 'executed'];
export const DECISIONS_LOG = path.join('requests', 'decisions.jsonl');
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch (_) { return null; } };
const refuse = (msg, code = 'REQUEST') => Object.assign(new Error(msg), { code });
const who = (actor) => (actor && actor.kind === 'agent' ? 'agent ' + actor.key : actor && actor.kind ? actor.kind + (actor.key ? ' ' + actor.key : '') : 'an unnamed caller');

export function createRequests(engine) {
  const { J, store, bus, log } = engine;
  const sessions = new Set();
  const rowOut = (r) => (r ? { ...r, compliance: parse(r.compliance), security: parse(r.security) } : null);
  const q = (sql) => store.db.prepare(sql);
  const need = () => { if (!store.hasProductColumns()) throw refuse('this data root has not run npm run migrate:products: there is no requests table yet', 'MIGRATE'); };

  // the owner's page session: the engine server registers its per-launch action token; a script run never has one
  function registerOwnerSession(token) {
    if (engine.scriptRun) throw new LockedRefusal('owner-only-approver', 'a script run (' + engine.scriptRun.purpose + ') has no owner session');
    if (!/^[0-9a-f]{32,}$/.test(String(token || ''))) throw refuse('an owner session is the server\'s per-launch token (32 or more hex characters)');
    sessions.add(token);
    return () => sessions.delete(token);
  }
  const isOwner = (actor) => !!(actor && actor.kind === 'owner' && actor.session && sessions.has(actor.session) && !engine.scriptRun);

  const get = (id) => { need(); return rowOut(q('SELECT * FROM requests WHERE id = ?').get(id)); };
  const list = ({ status = null, limit = 200 } = {}) => { if (!store.hasProductColumns()) return []; return (status ? q('SELECT * FROM requests WHERE status = ? ORDER BY filed_at DESC LIMIT ?').all(status, limit) : q('SELECT * FROM requests ORDER BY filed_at DESC LIMIT ?').all(limit)).map(rowOut); };

  function file({ action, productId, departmentId, jobId = null, summary, payload = '', actor, compliance = null, security = null }) {
    need();
    if (!actor || !['agent', 'engine'].includes(actor.kind)) throw refuse('a request is filed by an agent or the engine (' + who(actor) + ' cannot file one)');
    if (actor.kind === 'agent' && actor.key === CEO) throw new LockedRefusal('ceo-recommends-only', 'the CEO\'s proposals are documents in the Owner\'s office, never requests');
    const level = engine.policy.level(action, productId);
    if (level !== 'owner') throw refuse(action + ' is "' + level + '" for ' + productId + ': only an owner-level action becomes a request');
    if (!engine.company.product(productId)) throw refuse('no such product: ' + productId);
    if (!engine.company.department(departmentId)) throw refuse('no such department: ' + departmentId);
    // locked rule compliance-independent: an outbound draft reaches the owner only with COMPLIANCE's pass; nobody files around it
    if (COMPLIANCE_GATED.includes(action) && !(compliance && compliance.verdict === 'pass' && compliance.by === 'compliance')) {
      throw new LockedRefusal('compliance-independent', action + ' needs COMPLIANCE\'s pass before it reaches the owner; ' + (compliance && compliance.verdict ? 'COMPLIANCE said "' + compliance.verdict + '", so the draft goes back through the revise loop' : 'there is no COMPLIANCE verdict') + ' (asked by ' + who(actor) + ')');
    }
    const s = String(summary || '').trim();
    if (!s || s.length > 300) throw refuse('a request needs a one-line summary (1 to 300 characters)');
    const text = String(payload == null ? '' : payload), id = 'req_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex');
    const rel = 'requests/' + id + '/payload.txt';
    J.put(path.join(J.dataRoot, rel), text, { fsync: true });
    store.tx(() => q('INSERT INTO requests (id, product_id, department_id, job_id, action, summary, payload_sha256, payload_file, filed_by, filed_at, compliance, security, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, productId, departmentId, jobId, action, s, sha256(text), rel, who(actor), Date.now(), compliance ? JSON.stringify(compliance) : null, security ? JSON.stringify(security) : null, 'pending'));
    log.info('request filed', { id, action, productId, departmentId, jobId, by: who(actor) });
    bus.emit('request.filed', { jobId, agentKey: actor.kind === 'agent' ? actor.key : null, data: { requestId: id, action, productId, departmentId, summary: s } });
    return get(id);
  }

  // the owner's decision (locked rule owner-only-approver)
  function decide(id, { decision, words, expectedVersion, actor } = {}) {
    need();
    if (!isOwner(actor)) {
      const by = engine.scriptRun ? 'a script run (' + engine.scriptRun.purpose + ')' : actor && actor.kind === 'owner' ? 'a caller without the owner\'s page session' : who(actor);
      log.warn('request decision refused: not the owner', { id, by });
      try { bus.emit('action.refused', { data: { action: 'request.decide', requestId: id, by, rule: 'owner-only-approver' } }); } catch (_) { /* bus closed */ }
      throw new LockedRefusal('owner-only-approver', 'only the owner decides a request, on the page; refused for ' + by);
    }
    if (!['approve', 'reject'].includes(decision)) throw refuse('decision must be approve or reject');
    const w = String(words || '').trim();
    if (!w) throw refuse('the owner\'s words are required with every decision'); if (w.length > 2000) throw refuse('the owner\'s words are over 2,000 characters');
    if (expectedVersion == null || !Number.isInteger(expectedVersion)) throw refuse('expectedVersion is required');
    const out = store.tx(() => {
      const cur = get(id); if (!cur) throw refuse('no such request: ' + id);
      if (cur.version !== expectedVersion) throw new VersionConflict('request ' + id, cur.version, expectedVersion);
      if (cur.status !== 'pending') throw refuse('request ' + id + ' is ' + cur.status + ', not pending');
      const status = decision === 'approve' ? 'approved' : 'rejected', at = Date.now();
      q('UPDATE requests SET status = ?, decided_at = ?, decided_by = ?, decision_words = ?, version = version + 1 WHERE id = ?').run(status, at, 'owner (office)', w, id);
      J.add(path.join(J.dataRoot, DECISIONS_LOG), JSON.stringify({ at: new Date(at).toISOString(), requestId: id, action: cur.action, productId: cur.product_id, departmentId: cur.department_id, jobId: cur.job_id, decision: status, words: w, payloadSha256: cur.payload_sha256, by: 'owner (office)', instance: engine.instance ? engine.instance.name : null }) + '\n', { fsync: true });
      return get(id);
    });
    // a job waiting for this request learns the decision (R2's lines continue from here; in R1 it stays queued for a manual start)
    if (out.job_id) { const j = store.getJob(out.job_id); if (j && j.data && j.data.requestId === id) store.updateJob(j.id, { reason: 'the owner ' + out.status + ' request ' + id + ' (' + out.action + '): ' + w.slice(0, 200), data: { waitingFor: null, requestDecision: out.status } }); }
    log.info('request decided', { id, action: out.action, status: out.status, productId: out.product_id });
    bus.emit('request.decided', { jobId: out.job_id, data: { requestId: id, action: out.action, status: out.status, productId: out.product_id, departmentId: out.department_id } });
    return out;
  }

  // the executor's check -> { status: 'approved' | 'pending' | 'none' | 'mismatch', request }
  function approvalFor({ action, jobId = null, productId, payload = '' }) {
    if (!store.hasProductColumns()) return { status: 'none', request: null };
    const rows = q('SELECT * FROM requests WHERE action = ? AND product_id = ? AND ' + (jobId ? 'job_id = ?' : 'job_id IS NULL') + " AND status IN ('pending', 'approved') ORDER BY filed_at DESC").all(...[action, productId, ...(jobId ? [jobId] : [])]).map(rowOut);
    const want = sha256(String(payload == null ? '' : payload));
    const ok = rows.find((r) => r.status === 'approved' && r.payload_sha256 === want); if (ok) return { status: 'approved', request: ok };
    const stale = rows.find((r) => r.status === 'approved'); if (stale) return { status: 'mismatch', request: stale };
    const pend = rows.find((r) => r.status === 'pending'); if (pend) return { status: pend.payload_sha256 === want ? 'pending' : 'mismatch', request: pend };
    return { status: 'none', request: null };
  }
  function voidRequest(id, reason) {
    need();
    q("UPDATE requests SET status = 'void', decision_words = COALESCE(decision_words, '') || ?, version = version + 1 WHERE id = ? AND status IN ('pending', 'approved')").run((reason ? ' [void: ' + reason + ']' : ' [void]'), id);
    log.warn('request void', { id, reason });
    bus.emit('request.void', { data: { requestId: id, reason } });
    return get(id);
  }
  function markExecuted(id) { need(); q("UPDATE requests SET status = 'executed', executed_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'").run(Date.now(), id); return get(id); }
  // the decision log as written (append-only)
  function decisions(limit = 200) {
    const f = path.join(J.dataRoot, DECISIONS_LOG); if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => parse(l)).filter(Boolean).slice(-limit);
  }
  return { registerOwnerSession, isOwner, file, decide, approvalFor, void: voidRequest, markExecuted, get, list, decisions, payloadSha256: sha256 };
}
