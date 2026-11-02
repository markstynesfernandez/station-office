// db.mjs — the job store: SQLite through Node's built-in node:sqlite (ENGINE-PLAN.md §1.2; backend chosen by test at
// E2, see DECISIONS.md "E2 store backend"). One file, data/station.db, opened through the data jail. WAL journal,
// synchronous=FULL, every multi-row change in one transaction, so a stage change and its job row stay consistent across
// a crash. Records the owner can change from the page carry a `version` for stale-tab protection (expectedVersion).
// B0 (owner, 21/10/2026): jobs, runs, routines, approvals and the ledger mirror carry business_id. A new data root gets the column
// in its tables; an existing one gets it from npm run migrate:businesses (the engine refuses to start until then: businessGaps).
// The engine sets the resolver (setBusinessResolver) and every insert fills business_id through it.
// R1 (RESTRUCTURE.md §1.3, §1.4, §3): the same tables carry product_id and department_id (a new data root has them from the start; an
// existing one gets them from npm run migrate:products, and the engine refuses to start until then: productGaps). business_id is kept
// and still filled (B0's view: etsy-shop or shared) so a rollback to B0 reads its data. The requests table is the Owner's office queue:
// one row per owner-approval action, any product, any department (requests.mjs); it is created once the product columns exist, so a
// migrate:products dry run writes nothing. The old approvals table stays for the Etsy history.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BACKEND = 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, line TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'line', title TEXT, product_key TEXT,
  state TEXT NOT NULL, step TEXT, reason TEXT, loops TEXT NOT NULL DEFAULT '{}', hops INTEGER NOT NULL DEFAULT 0,
  resumes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1, legacy INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', business_id TEXT, product_id TEXT, department_id TEXT);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, step TEXT NOT NULL, pass INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT, run_id TEXT);
CREATE INDEX IF NOT EXISTS stages_job ON stages(job_id);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, job_id TEXT, agent_key TEXT NOT NULL, step TEXT, pass INTEGER, model TEXT, provider TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, prompt_sha256 TEXT, end_reason TEXT, error TEXT, tools TEXT NOT NULL DEFAULT '[]', business_id TEXT, product_id TEXT, department_id TEXT);
CREATE INDEX IF NOT EXISTS runs_job ON runs(job_id);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, target TEXT NOT NULL, input TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, max_runs_per_day INTEGER NOT NULL DEFAULT 1, per_run_cap_usd REAL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_fire_at INTEGER, last_status TEXT, version INTEGER NOT NULL DEFAULT 1, legacy INTEGER NOT NULL DEFAULT 0, business_id TEXT, product_id TEXT, department_id TEXT);
CREATE TABLE IF NOT EXISTS approvals (
  job_id TEXT PRIMARY KEY, status TEXT NOT NULL, queued_at INTEGER NOT NULL, decided_at INTEGER, reason TEXT,
  published_at INTEGER, etsy_url TEXT, version INTEGER NOT NULL DEFAULT 1, business_id TEXT, product_id TEXT, department_id TEXT);
CREATE TABLE IF NOT EXISTS tracker (listing_id TEXT PRIMARY KEY, row TEXT NOT NULL, updated_at INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agents_state (agent_key TEXT PRIMARY KEY, enabled INTEGER, tier TEXT, effort TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_mirror (entry_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, job_id TEXT, run_id TEXT, agent_key TEXT, line TEXT, provider TEXT, model TEXT, kind TEXT, usd REAL NOT NULL, row TEXT NOT NULL, business_id TEXT, product_id TEXT, department_id TEXT);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

// B0: the tables that carry business_id (npm run migrate:businesses adds the column to an older data root and fills it)
export const BUSINESS_TABLES = ['jobs', 'runs', 'routines', 'approvals', 'ledger_mirror'];
// R1: the tables that carry product_id and department_id (npm run migrate:products adds them to a post-B0 data root and fills them)
export const PRODUCT_TABLES = ['jobs', 'runs', 'routines', 'approvals', 'ledger_mirror'];
export const PRODUCT_COLUMNS = ['product_id', 'department_id'];
export const TABLE_KEYS = { jobs: 'id', runs: 'run_id', routines: 'id', approvals: 'job_id', ledger_mirror: 'entry_id' };
// R1: the Owner's office queue (requests.mjs). payload_sha256 is the exact text or diff the owner approves; the payload itself is a file
// under data/requests/<id>/. Every decision is also appended to data/requests/decisions.jsonl (fsync).
export const REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, department_id TEXT NOT NULL, job_id TEXT, action TEXT NOT NULL, summary TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, payload_file TEXT, filed_by TEXT NOT NULL, filed_at INTEGER NOT NULL, compliance TEXT, security TEXT,
  status TEXT NOT NULL, decided_at INTEGER, decided_by TEXT, decision_words TEXT, executed_at INTEGER, version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
`;

export class VersionConflict extends Error { constructor(what, have, want) { super(what + ' changed since you loaded it (version ' + have + ', you had ' + want + ')'); this.code = 'STALE'; this.have = have; } }

const lineOfTarget = (t) => (/^line:(.+)$/.exec(String(t || '')) || [])[1] || null;
const agentOfTarget = (t) => (/^agent:(.+)$/.exec(String(t || '')) || [])[1] || null;   // R1: a routine that runs one agent (the COO's report)
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };
const jobOut = (r) => r && ({ ...r, loops: parse(r.loops, {}), data: parse(r.data, {}), legacy: !!r.legacy });

export function openStore({ J, file = 'station.db', log }) {
  const f = J.dataJail(path.join(J.dataRoot, file));
  const db = new DatabaseSync(J.dataJail(f));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // port batch 17/10/2026: what the owner published (final title, final price, SKU), as the legacy approval record holds it
  if (!db.prepare('PRAGMA table_info(approvals)').all().some((c) => c.name === 'published')) db.exec('ALTER TABLE approvals ADD COLUMN published TEXT');
  const q = (sql) => db.prepare(sql);
  let depth = 0;
  // one transaction; nested calls join the outer one
  function tx(fn) {
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE'); depth++;
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
    finally { depth--; }
  }
  const now = () => Date.now();
  // B0: which tables have business_id (all of them on a new or migrated root); the resolver the engine sets: (rec) -> business id
  const hasBiz = Object.fromEntries(BUSINESS_TABLES.map((t) => [t, db.prepare('PRAGMA table_info(' + t + ')').all().some((c) => c.name === 'business_id')]));
  let bizOf = (rec) => (rec && (rec.business_id || rec.businessId)) || null;
  const biz = (t, rec) => (hasBiz[t] ? bizOf(rec) : undefined);
  // R1: product and department, filled through the resolver the engine sets: (rec) -> { productId, departmentId }
  const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
  const hasProd = Object.fromEntries(PRODUCT_TABLES.map((t) => [t, PRODUCT_COLUMNS.every((c) => cols(t).includes(c))]));
  if (PRODUCT_TABLES.every((t) => hasProd[t])) db.exec(REQUESTS_SCHEMA);
  let prodOf = (rec) => ({ productId: (rec && (rec.product_id || rec.productId)) || null, departmentId: (rec && (rec.department_id || rec.departmentId)) || null });
  // both columns on one row, only where still empty (an explicit value on insert wins)
  const stampProd = (t, key, rec) => { if (!hasProd[t]) return; const r = prodOf(rec) || {}; q('UPDATE ' + t + ' SET product_id = COALESCE(product_id, ?), department_id = COALESCE(department_id, ?) WHERE ' + TABLE_KEYS[t] + ' = ?').run(r.productId || null, r.departmentId || null, key); };
  const apOut = (r) => (r ? { ...r, published: parse(r.published, null) } : r);

  const store = {
    file: f, backend: BACKEND, db, tx,
    close() { try { db.close(); } catch (_) { /* closed */ } },
    setBusinessResolver(fn) { bizOf = fn; },
    setProductResolver(fn) { prodOf = fn; },
    hasProductColumns: () => PRODUCT_TABLES.every((t) => PRODUCT_COLUMNS.every((c) => cols(t).includes(c))),
    // R1: what a post-B0 data root still lacks: { missingColumn: [table], nullRows: { table: n } } (both empty once migrated)
    productGaps() {
      const missingColumn = PRODUCT_TABLES.filter((t) => !PRODUCT_COLUMNS.every((c) => cols(t).includes(c))), nullRows = {};
      for (const t of PRODUCT_TABLES) if (!missingColumn.includes(t)) { const n = q('SELECT COUNT(*) n FROM ' + t + ' WHERE product_id IS NULL OR department_id IS NULL').get().n; if (n) nullRows[t] = n; }
      return { missingColumn, nullRows };
    },
    // B0: what an older data root still lacks: { missingColumn: [table], nullRows: { table: n } } (both empty once migrated)
    businessGaps() {
      const col = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().some((c) => c.name === 'business_id');   // read again: a migration may have added it
      const missingColumn = BUSINESS_TABLES.filter((t) => !col(t)), nullRows = {};
      for (const t of BUSINESS_TABLES) if (!missingColumn.includes(t)) { const n = q('SELECT COUNT(*) n FROM ' + t + ' WHERE business_id IS NULL').get().n; if (n) nullRows[t] = n; }
      return { missingColumn, nullRows };
    },
    meta: { get: (k) => { const r = q('SELECT v FROM meta WHERE k = ?').get(k); return r ? parse(r.v, null) : null; }, set: (k, v) => q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)) },

    // ---- jobs
    getJob: (id) => jobOut(q('SELECT * FROM jobs WHERE id = ?').get(id)),
    listJobs: ({ states } = {}) => (states ? q('SELECT * FROM jobs WHERE state IN (' + states.map(() => '?').join(',') + ') ORDER BY updated_at DESC').all(...states) : q('SELECT * FROM jobs ORDER BY updated_at DESC').all()).map(jobOut),
    insertJob(j) { return tx(() => {
      const t = now();
      q('INSERT INTO jobs (id, line, kind, title, product_key, state, step, reason, loops, hops, created_at, updated_at, data, legacy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(j.id, j.line, j.kind || 'line', j.title || null, j.product_key || null, j.state || 'queued', j.step || null, j.reason || null, JSON.stringify(j.loops || {}), j.hops || 0, t, t, JSON.stringify(j.data || {}), j.legacy ? 1 : 0);
      if (hasBiz.jobs) q('UPDATE jobs SET business_id = ? WHERE id = ?').run(biz('jobs', { line: j.line, business_id: j.business_id }), j.id);
      stampProd('jobs', j.id, { line: j.line, productId: j.product_id || j.productId || null, departmentId: j.department_id || j.departmentId || null });
      return store.getJob(j.id);
    }); },
    // patch a job; with expectedVersion the update is refused when the row moved on (stale tab)
    updateJob(id, patch, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.getJob(id); if (!cur) throw new Error('no such job: ' + id);
        if (expectedVersion != null && cur.version !== expectedVersion) throw new VersionConflict('job ' + id, cur.version, expectedVersion);
        const next = { ...cur, ...patch, loops: { ...cur.loops, ...(patch.loops || {}) }, data: { ...cur.data, ...(patch.data || {}) } };
        q('UPDATE jobs SET title=?, product_key=?, state=?, step=?, reason=?, loops=?, hops=?, resumes=?, started_at=?, ended_at=?, data=?, updated_at=?, version=version+1 WHERE id=?')
          .run(next.title, next.product_key, next.state, next.step, next.reason, JSON.stringify(next.loops), next.hops, next.resumes, next.started_at ?? null, next.ended_at ?? null, JSON.stringify(next.data), now(), id);
        return store.getJob(id);
      });
    },

    // ---- stages (one row per step entered; the board's history)
    openStage: (jobId, step, pass = 1, runId = null) => Number(q('INSERT INTO stages (job_id, step, pass, status, started_at, run_id) VALUES (?,?,?,?,?,?)').run(jobId, step, pass, 'running', now(), runId).lastInsertRowid),
    closeStage: (id, status, reason = null) => q('UPDATE stages SET status=?, ended_at=?, reason=? WHERE id=?').run(status, now(), reason, id),
    stagesOf: (jobId) => q('SELECT * FROM stages WHERE job_id = ? ORDER BY id').all(jobId),
    openStages: () => q("SELECT * FROM stages WHERE status = 'running'").all(),

    // ---- runs
    insertRun: (r) => tx(() => { q('INSERT INTO runs (run_id, job_id, agent_key, step, pass, model, provider, status, started_at, prompt_sha256) VALUES (?,?,?,?,?,?,?,?,?,?)').run(r.runId, r.jobId || null, r.agentKey, r.step || null, r.pass || null, r.model || null, r.provider || null, 'running', now(), r.promptSha256 || null); if (hasBiz.runs) q('UPDATE runs SET business_id = ? WHERE run_id = ?').run(biz('runs', { jobId: r.jobId || null, agentKey: r.agentKey, businessId: r.businessId }), r.runId); stampProd('runs', r.runId, { jobId: r.jobId || null, agentKey: r.agentKey, productId: r.productId || null, departmentId: r.departmentId || null }); }),
    finishRun: (runId, f) => q('UPDATE runs SET status=?, ended_at=?, usd=?, tokens_in=?, tokens_out=?, turns=?, end_reason=?, error=?, tools=? WHERE run_id=?').run(f.status, now(), f.usd || 0, f.tokensIn || 0, f.tokensOut || 0, f.turns || 0, f.endReason || null, f.error || null, JSON.stringify(f.tools || []), runId),
    getRun: (runId) => q('SELECT * FROM runs WHERE run_id = ?').get(runId),
    runsOf: ({ jobId, agentKey, limit = 50 } = {}) => (jobId ? q('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?').all(jobId, limit) : agentKey ? q('SELECT * FROM runs WHERE agent_key = ? ORDER BY started_at DESC LIMIT ?').all(agentKey, limit) : q('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit)).map((r) => ({ ...r, tools: parse(r.tools, []) })),
    runningRuns: () => q("SELECT * FROM runs WHERE status = 'running'").all(),

    // ---- approvals (the only human gate)
    // a row superseded by a listing re-run (E5) goes back to pending when the re-run is packaged; a decided row is kept
    queueApproval: (jobId) => { const r = q("INSERT INTO approvals (job_id, status, queued_at) VALUES (?, 'pending', ?) ON CONFLICT(job_id) DO UPDATE SET status = 'pending', queued_at = excluded.queued_at, decided_at = NULL, reason = NULL, version = approvals.version + 1 WHERE approvals.status = 'superseded'").run(jobId, now()); if (hasBiz.approvals) q('UPDATE approvals SET business_id = ? WHERE job_id = ? AND business_id IS NULL').run(biz('approvals', { jobId }), jobId); stampProd('approvals', jobId, { jobId }); return r; },
    getApproval: (jobId) => apOut(q('SELECT * FROM approvals WHERE job_id = ?').get(jobId)),
    listApprovals: () => q('SELECT * FROM approvals ORDER BY queued_at DESC').all().map(apOut),
    decideApproval(jobId, patch, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.getApproval(jobId); if (!cur) throw new Error('not in the approval queue: ' + jobId);
        if (expectedVersion != null && cur.version !== expectedVersion) throw new VersionConflict('approval ' + jobId, cur.version, expectedVersion);
        const n = { ...cur, ...patch };
        q('UPDATE approvals SET status=?, decided_at=?, reason=?, published_at=?, etsy_url=?, published=?, version=version+1 WHERE job_id=?').run(n.status, n.decided_at ?? null, n.reason ?? null, n.published_at ?? null, n.etsy_url ?? null, n.published == null ? null : (typeof n.published === 'string' ? n.published : JSON.stringify(n.published)), jobId);
        return store.getApproval(jobId);
      });
    },

    // ---- tracker (the listing record, same columns as the legacy listings.csv)
    upsertTracker: (id, row, { legacy = false } = {}) => q('INSERT INTO tracker (listing_id, row, updated_at, legacy) VALUES (?,?,?,?) ON CONFLICT(listing_id) DO UPDATE SET row = excluded.row, updated_at = excluded.updated_at').run(id, JSON.stringify(row), now(), legacy ? 1 : 0),
    getTracker: (id) => { const r = q('SELECT * FROM tracker WHERE listing_id = ?').get(id); return r ? { ...parse(r.row, {}), legacy: !!r.legacy } : null; },
    listTracker: () => q('SELECT * FROM tracker ORDER BY updated_at DESC').all().map((r) => ({ ...parse(r.row, {}), legacy: !!r.legacy })),

    // ---- routines
    listRoutines: () => q('SELECT * FROM routines ORDER BY name').all().map((r) => ({ ...r, enabled: !!r.enabled, legacy: !!r.legacy })),
    getRoutine: (id) => { const r = q('SELECT * FROM routines WHERE id = ?').get(id); return r ? { ...r, enabled: !!r.enabled, legacy: !!r.legacy } : null; },
    // routines are always created disabled (ENGINE-PLAN.md §5.4); enabling is a separate, versioned action
    insertRoutine: (r) => tx(() => { const t = now(); q('INSERT INTO routines (id, name, target, input, schedule, enabled, max_runs_per_day, per_run_cap_usd, created_at, updated_at, legacy) VALUES (?,?,?,?,?,0,?,?,?,?,?)').run(r.id, r.name, r.target, r.input || '', r.schedule, r.max_runs_per_day ?? 1, r.per_run_cap_usd ?? null, t, t, r.legacy ? 1 : 0); if (hasBiz.routines) q('UPDATE routines SET business_id = ? WHERE id = ?').run(biz('routines', { line: lineOfTarget(r.target), business_id: r.business_id }), r.id); stampProd('routines', r.id, { line: lineOfTarget(r.target), agentKey: agentOfTarget(r.target) }); return store.getRoutine(r.id); }),
    setRoutineEnabled(id, enabled, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id);
        if (expectedVersion != null && cur.version !== expectedVersion) throw new VersionConflict('routine ' + id, cur.version, expectedVersion);
        q('UPDATE routines SET enabled=?, updated_at=?, version=version+1 WHERE id=?').run(enabled ? 1 : 0, now(), id); return store.getRoutine(id);
      });
    },
    // E5: the owner edits a routine from the page. An edit always leaves it disabled: enabling is the approval, so a
    // changed routine needs a new one. A fire's bookkeeping (markRoutineFire) does not change the version.
    updateRoutine(id, patch, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id);
        if (expectedVersion != null && cur.version !== expectedVersion) throw new VersionConflict('routine ' + id, cur.version, expectedVersion);
        const n = { ...cur, ...patch };
        q('UPDATE routines SET name=?, target=?, input=?, schedule=?, max_runs_per_day=?, per_run_cap_usd=?, enabled=0, updated_at=?, version=version+1 WHERE id=?').run(n.name, n.target, n.input || '', n.schedule, n.max_runs_per_day ?? 1, n.per_run_cap_usd ?? null, now(), id);
        return store.getRoutine(id);
      });
    },
    deleteRoutine(id, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.getRoutine(id); if (!cur) throw new Error('no such routine: ' + id);
        if (expectedVersion != null && cur.version !== expectedVersion) throw new VersionConflict('routine ' + id, cur.version, expectedVersion);
        q('DELETE FROM routines WHERE id = ?').run(id); return cur;
      });
    },
    markRoutineFire: (id, status) => q('UPDATE routines SET last_fire_at=?, last_status=? WHERE id=?').run(now(), status, id),

    // ---- agents' on/off, tier and effort overlay (config files are the base)
    agentState: (key) => q('SELECT * FROM agents_state WHERE agent_key = ?').get(key) || null,
    setAgentState(key, patch, { expectedVersion } = {}) {
      return tx(() => {
        const cur = store.agentState(key);
        if (expectedVersion != null && (cur ? cur.version : 0) !== expectedVersion) throw new VersionConflict('agent ' + key, cur ? cur.version : 0, expectedVersion);
        const n = { enabled: cur ? cur.enabled : null, tier: cur ? cur.tier : null, effort: cur ? cur.effort : null, ...patch };
        q('INSERT INTO agents_state (agent_key, enabled, tier, effort, updated_at, version) VALUES (?,?,?,?,?,1) ON CONFLICT(agent_key) DO UPDATE SET enabled=excluded.enabled, tier=excluded.tier, effort=excluded.effort, updated_at=excluded.updated_at, version=agents_state.version+1')
          .run(key, n.enabled == null ? null : (n.enabled ? 1 : 0), n.tier, n.effort, now());
        return store.agentState(key);
      });
    },

    // ---- ledger mirror (the JSONL file is the record; this is for queries and is rebuilt from it)
    mirrorLedger: (r) => tx(() => { const x = q('INSERT OR IGNORE INTO ledger_mirror (entry_id, ts, job_id, run_id, agent_key, line, provider, model, kind, usd, row) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(r.entryId, r.ts, r.jobId || null, r.runId || null, r.agentKey || null, r.line || null, r.provider || null, r.model || null, r.kind || null, r.usd, JSON.stringify(r)); if (hasBiz.ledger_mirror && x.changes) q('UPDATE ledger_mirror SET business_id = ? WHERE entry_id = ?').run(biz('ledger_mirror', r), r.entryId); if (x.changes) stampProd('ledger_mirror', r.entryId, r); return x; }),
    ledgerMirrorCount: () => q('SELECT COUNT(*) n FROM ledger_mirror').get().n,

    // ---- legacy import (E4, src/engine/import/legacy.mjs): rows keyed on their source ids. Each upsert returns
    // { op: 'inserted' | 'updated' | 'same' } and, for an update, the before and after values (the import logs them).
    // A legacy row never replaces an engine row, and a legacy routine is never enabled here.
    upsertLegacyJob(j) {
      const cur = q('SELECT * FROM jobs WHERE id = ?').get(j.id);
      const vals = { line: j.line, kind: 'legacy', title: j.title || null, product_key: j.product_key || null, state: j.state, reason: j.reason || null, created_at: j.created_at, updated_at: j.updated_at, started_at: j.started_at ?? null, ended_at: j.ended_at ?? null, data: JSON.stringify(j.data || {}) };
      if (!cur) {
        q('INSERT INTO jobs (id, line, kind, title, product_key, state, step, reason, loops, hops, created_at, updated_at, started_at, ended_at, data, legacy) VALUES (?,?,?,?,?,?,NULL,?,\'{}\',0,?,?,?,?,?,1)')
          .run(j.id, vals.line, vals.kind, vals.title, vals.product_key, vals.state, vals.reason, vals.created_at, vals.updated_at, vals.started_at, vals.ended_at, vals.data);
        if (hasBiz.jobs) q('UPDATE jobs SET business_id = ? WHERE id = ?').run(biz('jobs', { line: j.line }), j.id);
        stampProd('jobs', j.id, { line: j.line, businessId: 'etsy-shop' });
        return { op: 'inserted' };
      }
      if (!cur.legacy) throw new Error('job ' + j.id + ' is an engine job; a legacy row may not replace it');
      const before = Object.fromEntries(Object.keys(vals).map((k) => [k, cur[k]]));
      if (Object.keys(vals).every((k) => before[k] === vals[k])) return { op: 'same' };
      q('UPDATE jobs SET line=?, kind=?, title=?, product_key=?, state=?, reason=?, created_at=?, updated_at=?, started_at=?, ended_at=?, data=?, version=version+1 WHERE id=?')
        .run(vals.line, vals.kind, vals.title, vals.product_key, vals.state, vals.reason, vals.created_at, vals.updated_at, vals.started_at, vals.ended_at, vals.data, j.id);
      return { op: 'updated', before, after: vals };
    },
    upsertLegacyTracker(id, row) {
      const cur = q('SELECT * FROM tracker WHERE listing_id = ?').get(id), text = JSON.stringify(row);
      if (!cur) { q('INSERT INTO tracker (listing_id, row, updated_at, legacy) VALUES (?,?,?,1)').run(id, text, now()); return { op: 'inserted' }; }
      if (!cur.legacy) throw new Error('tracker row ' + id + ' belongs to the engine; a legacy row may not replace it');
      if (cur.row === text) return { op: 'same' };
      q('UPDATE tracker SET row = ?, updated_at = ? WHERE listing_id = ?').run(text, now(), id);
      return { op: 'updated', before: parse(cur.row, {}), after: row };
    },
    upsertLegacyRoutine(r) {
      const cur = store.getRoutine(r.id);
      const vals = { name: r.name, target: r.target, input: r.input || '', schedule: r.schedule, max_runs_per_day: r.max_runs_per_day ?? 1 };
      if (!cur) { const t = now(); q('INSERT INTO routines (id, name, target, input, schedule, enabled, max_runs_per_day, created_at, updated_at, legacy) VALUES (?,?,?,?,?,0,?,?,?,1)').run(r.id, vals.name, vals.target, vals.input, vals.schedule, vals.max_runs_per_day, t, t); if (hasBiz.routines) q('UPDATE routines SET business_id = ? WHERE id = ?').run(biz('routines', { line: lineOfTarget(vals.target) }), r.id); stampProd('routines', r.id, { line: lineOfTarget(vals.target), businessId: 'etsy-shop' }); return { op: 'inserted' }; }
      if (!cur.legacy) throw new Error('routine ' + r.id + ' belongs to the engine; a legacy row may not replace it');
      const before = Object.fromEntries(Object.keys(vals).map((k) => [k, cur[k]]));
      if (Object.keys(vals).every((k) => before[k] === vals[k])) return { op: 'same' };
      q('UPDATE routines SET name=?, target=?, input=?, schedule=?, max_runs_per_day=?, updated_at=?, version=version+1 WHERE id=?').run(vals.name, vals.target, vals.input, vals.schedule, vals.max_runs_per_day, now(), r.id);
      return { op: 'updated', before, after: vals };
    },
    legacyCounts: () => ({ jobs: q('SELECT COUNT(*) n FROM jobs WHERE legacy = 1').get().n, tracker: q('SELECT COUNT(*) n FROM tracker WHERE legacy = 1').get().n, routines: q('SELECT COUNT(*) n FROM routines WHERE legacy = 1').get().n, routinesEnabled: q('SELECT COUNT(*) n FROM routines WHERE legacy = 1 AND enabled = 1').get().n }),

    // ---- idempotency keys for page actions (a double click creates one job)
    idem: { get: (k) => { const r = q('SELECT result FROM idempotency WHERE key = ?').get(k); return r ? parse(r.result, null) : null; }, put: (k, v) => q('INSERT OR IGNORE INTO idempotency (key, result, created_at) VALUES (?,?,?)').run(k, JSON.stringify(v), now()) }
  };
  if (log) log.info('store open', { file: f, backend: BACKEND, sqlite: db.prepare('select sqlite_version() v').get().v });
  return store;
}
