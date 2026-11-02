// lib/migrate-businesses.mjs — B0 (owner, 21/10/2026): npm run migrate:businesses. Every job, run, routine, approval, ledger row and event
// carries business_id; this backfills a data root from before B0 with the business each record belongs to (today: "etsy-shop").
//   dry run (the default)  reads only: what would be set, per table and business, and anything it cannot map; nothing is written
//   apply                  takes a full backup first (data/.backups/<stamp>/, the database by SQLite's VACUUM INTO), then in one
//                          transaction adds the business_id column where it is missing and sets every empty one; every change is
//                          logged (table, id, business); a second run finds nothing to do and writes nothing (no backup either)
// It holds the engine lock the whole time, so it refuses while the server (or any engine) runs on that data root.
// The ledger (ledger/ledger.jsonl) and the event log (events/*.jsonl) are append-only records and are never rewritten: their rows
// written before B0 are counted here with the business they resolve to (their job's, line's or agent's), which is how the engine
// reads them. The ledger's SQLite mirror (ledger_mirror) is backfilled like the other tables.
// Mapping: a job by its line's business (a legacy job: etsy-shop, the legacy history being the Etsy shop's); a run by its job, else
// its agent's business (the shared floor's agents: "shared"); a routine by its target line (legacy: etsy-shop); an approval by its
// job; a ledger mirror row by its job, line or agent (an own-shop Etsy call: the business that owns the Etsy connection), else
// "shared" (a station-wide call). Anything else is reported as unmapped and
// apply refuses (fail closed).
import fs from 'node:fs';
import path from 'node:path';
import { openStore, BUSINESS_TABLES } from '../store/db.mjs';
import { takeLock } from '../engine.mjs';
import { building, DEFAULT_BUSINESS, SHARED } from '../business.mjs';
import { backupData } from '../import/backup.mjs';

const KEY = { jobs: 'id', runs: 'run_id', routines: 'id', approvals: 'job_id', ledger_mirror: 'entry_id' };
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const lineOfTarget = (t) => (/^line:(.+)$/.exec(String(t || '')) || [])[1] || null;
const tally = (o, k) => { o[k] = (o[k] || 0) + 1; };

// the plan, from the database and the append-only logs; pure reads
function planOf({ J, store, cfg }) {
  const B = building(cfg), db = store.db, gaps = store.businessGaps(), hasCol = (t) => !gaps.missingColumn.includes(t);
  const all = (t) => db.prepare('SELECT * FROM ' + t).all();
  const jobBiz = new Map(), plan = {}, unmapped = [];
  const take = (t, rows, mapFn) => {
    const p = { rows: rows.length, column: hasCol(t) ? 'present' : 'missing', already: 0, set: {}, changes: [] };
    for (const r of rows) {
      if (hasCol(t) && r.business_id) { p.already++; continue; }
      const b = mapFn(r);
      if (!b) { unmapped.push({ table: t, id: r[KEY[t]], why: mapFn.why ? mapFn.why(r) : 'no business found' }); continue; }
      tally(p.set, b); p.changes.push({ id: r[KEY[t]], business: b });
    }
    plan[t] = p;
  };
  const jobs = all('jobs');
  for (const j of jobs) jobBiz.set(j.id, (hasCol('jobs') && j.business_id) || B.ofLine(j.line) || (j.legacy ? DEFAULT_BUSINESS : null));
  const ofJob = (r) => jobBiz.get(r.id); ofJob.why = (r) => 'line ' + r.line + ' belongs to no business (and the job is not a legacy job)';
  take('jobs', jobs, ofJob);
  const ofRun = (r) => (r.job_id ? jobBiz.get(r.job_id) : null) || B.ofAgent(r.agent_key); ofRun.why = (r) => (r.job_id ? 'job ' + r.job_id + ' has no business' : 'agent ' + r.agent_key + ' belongs to no business');
  take('runs', all('runs'), ofRun);
  const ofRoutine = (r) => B.ofLine(lineOfTarget(r.target)) || (r.legacy ? DEFAULT_BUSINESS : null); ofRoutine.why = (r) => 'target ' + r.target + ' is not a line of any business';
  take('routines', all('routines'), ofRoutine);
  const ofApproval = (r) => jobBiz.get(r.job_id); ofApproval.why = (r) => 'job ' + r.job_id + ' has no business';
  take('approvals', all('approvals'), ofApproval);
  const ofMirror = (r) => B.resolve({ jobId: r.job_id, line: r.line, agentKey: r.agent_key, kind: r.kind }, (id) => jobBiz.get(id) || null);
  take('ledger_mirror', all('ledger_mirror'), ofMirror);
  // the append-only logs: counted, never rewritten
  const logs = {};
  const lf = path.join(J.dataRoot, 'ledger', 'ledger.jsonl');
  const ledger = { file: 'ledger/ledger.jsonl', rows: 0, withBusiness: 0, resolved: {}, unreadable: 0, rewritten: false };
  if (fs.existsSync(lf)) for (const line of fs.readFileSync(lf, 'utf8').split('\n')) {
    if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch (_) { ledger.unreadable++; continue; }
    ledger.rows++; if (r.businessId) ledger.withBusiness++; else tally(ledger.resolved, B.resolve(r, (id) => jobBiz.get(id) || null));
  }
  logs.ledger = ledger;
  const ed = path.join(J.dataRoot, 'events'), events = { dir: 'events/', files: 0, rows: 0, withBusiness: 0, resolved: {}, unreadable: 0, rewritten: false };
  if (fs.existsSync(ed)) for (const n of fs.readdirSync(ed).filter((x) => x.endsWith('.jsonl')).sort()) {
    events.files++;
    for (const line of fs.readFileSync(path.join(ed, n), 'utf8').split('\n')) {
      if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch (_) { events.unreadable++; continue; }
      events.rows++; if (e.businessId) events.withBusiness++; else tally(events.resolved, B.resolve({ jobId: e.jobId, agentKey: e.agentKey }, (id) => jobBiz.get(id) || null));
    }
  }
  logs.events = events;
  const toChange = BUSINESS_TABLES.reduce((s, t) => s + plan[t].changes.length, 0);
  return { gaps, plan, logs, unmapped, toChange, nothingToDo: !gaps.missingColumn.length && toChange === 0 };
}

// -> { dataRoot, applied, nothingToDo, tables: {...}, logs: {...}, unmapped: [...], backup }
export function migrateBusinesses({ J, cfg, log, apply = false, now = Date.now }) {
  if (!fs.existsSync(path.join(J.dataRoot, 'station.db'))) return { dataRoot: J.dataRoot, applied: false, nothingToDo: true, note: 'no station.db in this data root: nothing to migrate', tables: {}, logs: {}, unmapped: [], backup: null };
  const unlock = takeLock(J, log);   // LOCKED while the server (or any engine) runs on this data root
  let store = null;
  try {
    store = openStore({ J, log });
    const p = planOf({ J, store, cfg });
    const tables = Object.fromEntries(BUSINESS_TABLES.map((t) => { const x = p.plan[t]; return [t, { rows: x.rows, column: x.column, already: x.already, toSet: x.set, toSetRows: x.changes.length }]; }));
    const out = { dataRoot: J.dataRoot, applied: false, nothingToDo: p.nothingToDo, tables, logs: p.logs, unmapped: p.unmapped, backup: null, businesses: building(cfg).list.map((b) => b.id), shared: SHARED };
    for (const t of BUSINESS_TABLES) for (const c of p.plan[t].changes) log && log.info(apply ? 'business_id set' : 'business_id would be set', { table: t, id: c.id, business: c.business });
    if (!apply || p.nothingToDo) { log && log.info(apply ? 'migrate:businesses: nothing to change' : 'migrate:businesses: dry run (nothing written)', { toChange: p.toChange, unmapped: p.unmapped.length }); return out; }
    if (p.unmapped.length) throw new Error('refused: ' + p.unmapped.length + ' record(s) could not be mapped to a business (first: ' + p.unmapped.slice(0, 3).map((u) => u.table + ' ' + u.id + ': ' + u.why).join('; ') + '); nothing was written');
    // 1. the backup, before anything changes
    const backup = backupData({ J, store, stamp: 'businesses-' + stampOf(now()), log, note: 'taken before npm run migrate:businesses -- --apply (B0); never deleted automatically' });
    out.backup = { dir: path.relative(J.dataRoot, backup.dir).split(path.sep).join('/'), items: backup.items.length };
    // 2. the columns and the values, in one transaction
    store.tx(() => {
      for (const t of p.gaps.missingColumn) { store.db.exec('ALTER TABLE ' + t + ' ADD COLUMN business_id TEXT'); log && log.info('business_id column added', { table: t }); }
      for (const t of BUSINESS_TABLES) {
        const st = store.db.prepare('UPDATE ' + t + ' SET business_id = ? WHERE ' + KEY[t] + ' = ? AND business_id IS NULL');
        for (const c of p.plan[t].changes) st.run(c.business, c.id);
      }
      store.meta.set('businesses:migrated', { at: new Date(now()).toISOString(), set: Object.fromEntries(BUSINESS_TABLES.map((t) => [t, p.plan[t].set])), backup: out.backup.dir });
    });
    const after = store.businessGaps();
    if (after.missingColumn.length || Object.keys(after.nullRows).length) throw new Error('after the migration some records still have no business: ' + JSON.stringify(after));
    out.applied = true;
    log && log.info('migrate:businesses applied', { tables: Object.fromEntries(BUSINESS_TABLES.map((t) => [t, p.plan[t].changes.length])), backup: out.backup.dir });
    return out;
  } finally { if (store) store.close(); unlock(); }
}
