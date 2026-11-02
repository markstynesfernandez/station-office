// ledger.mjs — the money record (ENGINE-PLAN.md §1.2): data/ledger/ledger.jsonl, append-only, one row per paid call,
// every row keyed by jobId. Each append is fsynced before the next model call. Rows are never edited: a correction is
// a new row with `correctionOf`. On start the running totals the spend guard needs are rebuilt from the file; SQLite
// holds a mirror for queries, and the JSONL wins if they disagree. An unreadable ledger is reported as not ok, and
// the guard then refuses every call (fail closed).
// Corrections (E6 wrap-up, 18/10/2026; lib/settle-images.mjs): a row with `correctionOf` (an earlier row's entryId, never itself a
// correction) carries the DIFFERENCE in usd, which may be negative (an estimate settled lower), so long as the corrected row's net
// (its usd plus all its corrections) stays at or above 0. It counts on the corrected row's Dublin day (`correctsTs`), adds no image or
// web count, and is the only way a figure changes: no row is ever edited.
// B0 (owner, 21/10/2026): a new row carries businessId (the business it was spent for; the shared floor is "shared"). A row written
// before B0 has none and is never rewritten (append-only): its business is resolved when the ledger loads (its job's, line's or
// agent's business: businessOf), for the business totals (byBusinessDay, byBusinessMonth: the Dublin month).
// R1 (RESTRUCTURE.md §1.3): a new row also carries productId and departmentId; a row written before R1 has none and is never rewritten:
// its product is resolved when the ledger loads (productOf), for the product totals the guard checks (byProductDay, byProductMonth).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dublinDay } from './time.mjs';
import { APP_ROOT } from './store/jail.mjs';

// etsy (E7a): one row per Etsy Open API call, USD 0 (the API has no charge), for the audit trail; never a token in a row
export const KINDS = ['text', 'image', 'web', 'etsy'];
const r6 = (n) => Math.round(n * 1e6) / 1e6;

export function emptyTotals() { return { byDay: {}, byJob: {}, byRun: {}, byAgentDay: {}, byLineDay: {}, byBusinessDay: {}, byBusinessMonth: {}, byProductDay: {}, byProductMonth: {}, imagesByDay: {}, webByDay: {}, rows: 0, usd: 0 }; }

export function addToTotals(t, r, businessId = r.businessId || null, productId = r.productId || null) {
  const day = dublinDay(r.correctionOf ? (r.correctsTs || r.ts) : r.ts), add = (o, k, v) => { o[k] = r6((o[k] || 0) + v); };
  add(t.byDay, day, r.usd);
  if (r.jobId) add(t.byJob, r.jobId, r.usd);
  if (r.runId) add(t.byRun, r.runId, r.usd);
  if (r.agentKey) add(t.byAgentDay, r.agentKey + '|' + day, r.usd);
  if (r.line) add(t.byLineDay, r.line + '|' + day, r.usd);
  if (businessId) { add(t.byBusinessDay, businessId + '|' + day, r.usd); add(t.byBusinessMonth, businessId + '|' + day.slice(0, 7), r.usd); }
  if (productId) { add(t.byProductDay, productId + '|' + day, r.usd); add(t.byProductMonth, productId + '|' + day.slice(0, 7), r.usd); }
  if (r.kind === 'image' && !r.correctionOf) add(t.imagesByDay, day, r.count || 1);
  if (r.kind === 'web' && !r.correctionOf) add(t.webByDay, day, r.count || 1);
  t.rows++; t.usd = r6(t.usd + r.usd);
  return t;
}

// validate one row before it is written: refuse anything that could poison the totals
export function checkRow(r) {
  const bad = [];
  if (typeof r.usd !== 'number' || !Number.isFinite(r.usd) || (r.usd < 0 && r.correctionOf == null)) bad.push('usd must be a finite number >= 0 (only a correction row may be negative)');
  if (!KINDS.includes(r.kind)) bad.push('kind must be one of ' + KINDS.join(', '));
  if (!r.provider) bad.push('provider is required');
  if (!r.model) bad.push('model is required');
  if (!('jobId' in r)) bad.push('jobId is required (null for calls outside a job)');
  if (r.correctionOf != null && typeof r.correctionOf !== 'string') bad.push('correctionOf must be an entryId');
  return bad;
}

export function createLedger({ J, store = null, log, file = path.join(J.dataRoot, 'ledger', 'ledger.jsonl'), businessOf = null, productOf = null }) {
  // a correction counts for the business of the row it corrects; any other row for its own (or resolved) business
  const bizOf = (r) => { if (!businessOf) return r.businessId || null; if (r.correctionOf) { const o = rows.find((x) => x.entryId === r.correctionOf); if (o) return o.businessId || businessOf(o); } return r.businessId || businessOf(r); };
  // R1: a row's product and department (a correction: the corrected row's), its own fields first, else resolved
  const prodOf = (r) => { const o = r.correctionOf ? rows.find((x) => x.entryId === r.correctionOf) : null, src = o || r; if (src.productId && src.departmentId) return { productId: src.productId, departmentId: src.departmentId }; return productOf ? productOf(src) : { productId: src.productId || null, departmentId: src.departmentId || null }; };
  const f = J.dataJail(file);
  let totals = emptyTotals(), state = { ok: true, error: null }, rows = [];
  const ids = new Set();
  // a correction against the rows so far: -> [problems]
  function correctionProblems(r) {
    if (r.correctionOf == null) return [];
    const orig = rows.find((x) => x.entryId === r.correctionOf);
    if (!orig) return ['correctionOf ' + r.correctionOf + ' is not an earlier row'];
    if (orig.correctionOf != null) return ['a correction corrects an original row, never another correction'];
    const net = r6(rows.filter((x) => x.correctionOf === orig.entryId).reduce((s, x) => s + x.usd, orig.usd) + r.usd);
    return net < 0 ? ['the correction would take row ' + orig.entryId + ' below 0 (net ' + net + ')'] : [];
  }

  function load() {
    totals = emptyTotals(); rows = []; ids.clear();
    if (!fs.existsSync(f)) { state = { ok: true, error: null }; return state; }
    const text = fs.readFileSync(f, 'utf8'), lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch (e) { state = { ok: false, error: 'ledger line ' + (i + 1) + ' is unreadable (' + e.message + '); nothing can be charged until it is fixed by hand' }; log && log.error('ledger unreadable', { file: f, line: i + 1 }); return state; }
      const bad = [...checkRow(r), ...correctionProblems(r)]; if (bad.length) { state = { ok: false, error: 'ledger line ' + (i + 1) + ': ' + bad.join('; ') }; log && log.error('ledger row invalid', { line: i + 1, bad }); return state; }
      rows.push(r); ids.add(r.entryId); addToTotals(totals, r, bizOf(r), prodOf(r).productId);
      if (store) store.mirrorLedger(r);
    }
    state = { ok: true, error: null };
    log && log.info('ledger loaded', { file: f, rows: totals.rows, usd: totals.usd });
    return state;
  }

  // append one row (fsync), then mirror it; returns the stored row
  function append(row) {
    if (!state.ok) throw new Error('ledger is not ok: ' + state.error);
    const r = { entryId: row.entryId || crypto.randomUUID(), ts: row.ts || Date.now(), ...row };
    r.usd = r6(r.usd);
    if (businessOf && !r.businessId) r.businessId = bizOf(r);
    if (productOf && !(r.productId && r.departmentId)) { const p = prodOf(r); r.productId = r.productId || p.productId; r.departmentId = r.departmentId || p.departmentId; }
    if (ids.has(r.entryId)) return rows.find((x) => x.entryId === r.entryId);   // idempotent on entryId
    const bad = [...checkRow(r), ...correctionProblems(r)]; if (bad.length) throw new Error('refusing a ledger row: ' + bad.join('; '));
    J.add(f, JSON.stringify(r) + '\n', { fsync: true });
    rows.push(r); ids.add(r.entryId); addToTotals(totals, r, bizOf(r), prodOf(r).productId);
    if (store) store.mirrorLedger(r);
    log && log.info('ledger row', { entryId: r.entryId, jobId: r.jobId, runId: r.runId, agent: r.agentKey, kind: r.kind, model: r.model, usd: r.usd, estimated: !!r.estimated });
    return r;
  }

  load();
  return {
    file: f, label: path.relative(APP_ROOT, f).split(path.sep).join('/'), append, reload: load,
    get state() { return state; },
    get totals() { return totals; },
    rows: () => rows.slice(),
    rowsForJob: (jobId) => rows.filter((r) => r.jobId === jobId),
    spent: { day: (day) => totals.byDay[day] || 0, job: (id) => totals.byJob[id] || 0, run: (id) => totals.byRun[id] || 0, agentDay: (k, day) => totals.byAgentDay[k + '|' + day] || 0, lineDay: (l, day) => totals.byLineDay[l + '|' + day] || 0, businessDay: (b, day) => totals.byBusinessDay[b + '|' + day] || 0, businessMonth: (b, month) => totals.byBusinessMonth[b + '|' + month] || 0, productDay: (p, day) => totals.byProductDay[p + '|' + day] || 0, productMonth: (p, month) => totals.byProductMonth[p + '|' + month] || 0, imagesDay: (day) => totals.imagesByDay[day] || 0 }
  };
}
