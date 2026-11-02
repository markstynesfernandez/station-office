// lib/migrate-products.mjs — R1 (owner, R0.3 and the R1 prompt; RESTRUCTURE.md §1.4): npm run migrate:products. Every job, run, routine,
// approval and ledger mirror row carries product_id and department_id; this backfills a post-B0 data root (live runs B0 since 21/10/2026)
// from each record's business_id:
//   etsy-shop -> product etsy-shop, department etsy (the archived trophy room on G)
//   shared    -> product station, department hq (OVERSEER's history stays under agent overseer, department hq)
// anything else is unmapped, and apply refuses (fail closed). No floor number is written to any record.
//   dry run (the default)  reads only: what would be set, per table and product/department, and anything it cannot map; nothing is written
//                          (the requests table is not created either: the store creates it only once the columns exist)
//   apply                  takes a full backup first (data/.backups/products-<stamp>/, the database by SQLite's VACUUM INTO, nothing
//                          deleted), then in ONE transaction adds the two columns where missing, creates the requests table and sets every
//                          empty value; every change is logged (table, id, product, department); afterwards nothing may be left without a
//                          product. A second run finds nothing to do and writes nothing (no backup either). Interrupted mid-run (an error,
//                          or the process killed), the transaction is rolled back by SQLite and a rerun starts clean: safe to restart.
// A pre-B0 root (no business_id, or rows without one) is refused with the reason: run npm run migrate:businesses first.
// It holds the engine lock the whole time, so it refuses while the server (or any engine) runs on that data root.
// The ledger (ledger/ledger.jsonl) and the event log (events/*.jsonl) are append-only and are never rewritten: their rows are counted here
// with the product they resolve to, which is how the engine reads them.
import fs from 'node:fs';
import path from 'node:path';
import { openStore, PRODUCT_TABLES, PRODUCT_COLUMNS, TABLE_KEYS, REQUESTS_SCHEMA } from '../store/db.mjs';
import { takeLock } from '../engine.mjs';
import { company } from '../building.mjs';
import { backupData } from '../import/backup.mjs';

const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const tally = (o, k) => { o[k] = (o[k] || 0) + 1; };
const pair = (r) => r.productId + '/' + r.departmentId;

export class PreB0Root extends Error { constructor(msg) { super(msg); this.code = 'PRE_B0'; } }

// the plan, from the database and the append-only logs; pure reads
function planOf({ J, store, cfg }) {
  const C = company(cfg), db = store.db, gaps = store.productGaps();
  const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
  const has = (t) => PRODUCT_COLUMNS.every((c) => cols(t).includes(c));
  const plan = {}, unmapped = [], jobPd = new Map();
  for (const t of PRODUCT_TABLES) {
    const rows = db.prepare('SELECT * FROM ' + t).all(), p = { rows: rows.length, columns: has(t) ? 'present' : 'missing', already: 0, set: {}, changes: [] };
    for (const r of rows) {
      if (has(t) && r.product_id && r.department_id) { p.already++; if (t === 'jobs') jobPd.set(r.id, { productId: r.product_id, departmentId: r.department_id }); continue; }
      const m = C.fromBusiness(r.business_id);
      if (!m) { unmapped.push({ table: t, id: r[TABLE_KEYS[t]], why: 'business_id "' + r.business_id + '" maps to no product and department' }); continue; }
      tally(p.set, pair(m)); p.changes.push({ id: r[TABLE_KEYS[t]], ...m });
      if (t === 'jobs') jobPd.set(r.id, m);
    }
    plan[t] = p;
  }
  // the append-only logs: counted with the product they resolve to, never rewritten
  const jobOf = (id) => jobPd.get(id) || null, logs = {};
  const lf = path.join(J.dataRoot, 'ledger', 'ledger.jsonl'), ledger = { file: 'ledger/ledger.jsonl', rows: 0, withProduct: 0, resolved: {}, unreadable: 0, rewritten: false };
  if (fs.existsSync(lf)) for (const line of fs.readFileSync(lf, 'utf8').split('\n')) {
    if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch (_) { ledger.unreadable++; continue; }
    ledger.rows++; if (r.productId && r.departmentId) ledger.withProduct++; else tally(ledger.resolved, pair(C.resolve(r, jobOf)));
  }
  logs.ledger = ledger;
  const ed = path.join(J.dataRoot, 'events'), events = { dir: 'events/', files: 0, rows: 0, withProduct: 0, resolved: {}, unreadable: 0, rewritten: false };
  if (fs.existsSync(ed)) for (const n of fs.readdirSync(ed).filter((x) => x.endsWith('.jsonl')).sort()) {
    events.files++;
    for (const line of fs.readFileSync(path.join(ed, n), 'utf8').split('\n')) {
      if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch (_) { events.unreadable++; continue; }
      events.rows++; if (e.productId && e.departmentId) events.withProduct++; else tally(events.resolved, pair(C.resolve({ jobId: e.jobId, agentKey: e.agentKey, businessId: e.businessId }, jobOf)));
    }
  }
  logs.events = events;
  const toChange = PRODUCT_TABLES.reduce((s, t) => s + plan[t].changes.length, 0);
  return { gaps, plan, logs, unmapped, toChange, nothingToDo: !gaps.missingColumn.length && toChange === 0 };
}

// -> { dataRoot, applied, nothingToDo, tables: {...}, logs: {...}, unmapped: [...], backup }
// fault (tests only): { afterUpdates: n, action() } is called inside the transaction after n row updates (a simulated crash)
export function migrateProducts({ J, cfg, log, apply = false, now = Date.now, fault = null }) {
  if (!fs.existsSync(path.join(J.dataRoot, 'station.db'))) return { dataRoot: J.dataRoot, applied: false, nothingToDo: true, note: 'no station.db in this data root: nothing to migrate', tables: {}, logs: {}, unmapped: [], backup: null };
  const unlock = takeLock(J, log);   // LOCKED while the server (or any engine) runs on this data root
  let store = null;
  try {
    store = openStore({ J, log });
    // post-B0 roots only: every record has its business (npm run migrate:businesses)
    const bg = store.businessGaps();
    if (bg.missingColumn.length || Object.keys(bg.nullRows).length) throw new PreB0Root('refused: this data root is from before B0 (' + [...bg.missingColumn.map((t) => t + ': no business_id column'), ...Object.entries(bg.nullRows).map(([t, n]) => t + ': ' + n + ' row(s) without business_id')].join('; ') + '): run npm run migrate:businesses first (a dry run, then -- --apply), then npm run migrate:products; nothing was written');
    const p = planOf({ J, store, cfg });
    const tables = Object.fromEntries(PRODUCT_TABLES.map((t) => { const x = p.plan[t]; return [t, { rows: x.rows, columns: x.columns, already: x.already, toSet: x.set, toSetRows: x.changes.length }]; }));
    const out = { dataRoot: J.dataRoot, applied: false, nothingToDo: p.nothingToDo, tables, logs: p.logs, unmapped: p.unmapped, backup: null, products: cfg.company.products.map((x) => x.id), departments: cfg.company.departments.map((x) => x.id) };
    for (const t of PRODUCT_TABLES) for (const c of p.plan[t].changes) log && log.info(apply ? 'product set' : 'product would be set', { table: t, id: c.id, product: c.productId, department: c.departmentId });
    for (const u of p.unmapped) log && log.warn('cannot map to a product', u);
    if (!apply || p.nothingToDo) { log && log.info(apply ? 'migrate:products: nothing to change' : 'migrate:products: dry run (nothing written)', { toChange: p.toChange, unmapped: p.unmapped.length }); return out; }
    if (p.unmapped.length) throw new Error('refused: ' + p.unmapped.length + ' record(s) could not be mapped to a product and department (first: ' + p.unmapped.slice(0, 3).map((u) => u.table + ' ' + u.id + ': ' + u.why).join('; ') + '); nothing was written');
    // 1. the backup, before anything changes
    const backup = backupData({ J, store, stamp: 'products-' + stampOf(now()), log, note: 'taken before npm run migrate:products -- --apply (R1); never deleted automatically' });
    out.backup = { dir: path.relative(J.dataRoot, backup.dir).split(path.sep).join('/'), items: backup.items.length };
    // 2. the columns, the requests table and the values, in one transaction
    let n = 0;
    store.tx(() => {
      for (const t of p.gaps.missingColumn) for (const c of PRODUCT_COLUMNS) if (!store.db.prepare('PRAGMA table_info(' + t + ')').all().some((x) => x.name === c)) { store.db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + c + ' TEXT'); log && log.info('column added', { table: t, column: c }); }
      store.db.exec(REQUESTS_SCHEMA);
      for (const t of PRODUCT_TABLES) {
        const st = store.db.prepare('UPDATE ' + t + ' SET product_id = COALESCE(product_id, ?), department_id = COALESCE(department_id, ?) WHERE ' + TABLE_KEYS[t] + ' = ?');
        for (const c of p.plan[t].changes) { st.run(c.productId, c.departmentId, c.id); n++; if (fault && n === fault.afterUpdates) fault.action(); }
      }
      store.meta.set('products:migrated', { at: new Date(now()).toISOString(), set: Object.fromEntries(PRODUCT_TABLES.map((t) => [t, p.plan[t].set])), backup: out.backup.dir });
    });
    const after = store.productGaps();
    if (after.missingColumn.length || Object.keys(after.nullRows).length) throw new Error('after the migration some records still have no product: ' + JSON.stringify(after));
    out.applied = true;
    log && log.info('migrate:products applied', { tables: Object.fromEntries(PRODUCT_TABLES.map((t) => [t, p.plan[t].changes.length])), backup: out.backup.dir });
    return out;
  } finally { if (store) store.close(); unlock(); }
}
