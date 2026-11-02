// lib/settle-failed.mjs — W2 (owner, 20/10/2026): the owner settles the ledger's rows for calls that ended with NO HTTP response.
// Such a call (a reset, a timeout, DNS: providers/connection.mjs) may or may not have reached the provider, so the guard charges it at
// its reserved maximum, marked estimated, with the reason "no response (connection failed)": the caps stay safe. The owner checks the
// call in the Anthropic Console (or OpenRouter's activity page for an image) and settles each row to what it really cost: USD 0 when
// the provider has no record of it, or the amount it shows.
// The ledger is never edited: each settled row gets ONE correction row (entryId "settle-<entryId>", correctionOf, the difference in
// usd, settledUsd, settledBy, settledAt), so running it twice writes nothing new, and a row already settled (by this or by
// settle:images) is never settled again. Without `apply` nothing is written (the plan only). Every row settled, or planned, is logged
// with who, when and the amount.
// Rows written before W2 carry no reason: they are known by the note the runtime and the toolbox wrote on them (LEGACY_NOTES), with no
// generation id (an image row with one is settled from OpenRouter's own record: settle:images). The winter job's 16 rows are of this kind.
import { NO_RESPONSE } from '../providers/connection.mjs';
import { settleId } from './settle-images.mjs';

const r6 = (n) => Math.round(n * 1e6) / 1e6;
export const LEGACY_NOTES = ['call failed without a usage report; charged at the reserved maximum', 'web call failed without a usage report; charged at the reserved maximum', 'image call failed without a cost report; charged at the reserved maximum'];
const SOURCE = { anthropic: 'the Anthropic Console', 'anthropic-web': 'the Anthropic Console', openrouter: 'OpenRouter\'s activity page' };

const isFailedCall = (r) => r.estimated && !r.correctionOf && !r.generationId && (r.reason === NO_RESPONSE || (r.reason == null && LEGACY_NOTES.includes(r.note)));
// the failed-call rows not yet corrected
export function failedCallRows(rows) {
  const corrected = new Set(rows.filter((r) => r.correctionOf).map((r) => r.correctionOf));
  return rows.filter((r) => isFailedCall(r) && !corrected.has(r.entryId));
}

// -> { applied, selected, settled: [...], skipped: [{ entryId, reason }], rows: [correction rows written or planned], totalDeltaUsd, jobs }
// jobId / entryIds pick the rows (one of them is required to write); usd is the amount each picked row really cost (0 .. its charge);
// by is who checked; source what they checked (default by provider); usd omitted = the list only
export function settleFailedRows({ ledger, jobId = null, entryIds = null, usd = null, by = null, source = null, apply = false, log = null, now = Date.now }) {
  const rows = ledger.rows(), ids = entryIds && entryIds.length ? new Set(entryIds) : null, skipped = [];
  if (apply && !jobId && !ids) throw new Error('name the rows to settle: --job <job id> or --entry <entryId>[,<entryId>...]');
  const amount = usd == null || usd === '' ? null : Number(usd);
  if (amount != null && !(Number.isFinite(amount) && amount >= 0)) throw new Error('--usd must be an amount in USD, 0 or more (got ' + usd + ')');
  const who = String(by || '').trim();
  if (amount != null && (!who || who.length > 80)) throw new Error('--by is required with --usd: who checked the calls (up to 80 characters)');
  if (apply && amount == null) throw new Error('--apply needs --usd (the amount each call really cost, e.g. 0) and --by');
  if (ids) for (const id of ids) {
    const r = rows.find((x) => x.entryId === id);
    if (!r) skipped.push({ entryId: id, reason: 'no such ledger row' });
    else if (!isFailedCall(r)) skipped.push({ entryId: id, reason: 'not a failed-call row (estimated, no response, no generation id)' });
    else if (rows.some((x) => x.correctionOf === id)) skipped.push({ entryId: id, reason: 'already settled (a correction row exists): never settled twice' });
  }
  const todo = failedCallRows(rows).filter((r) => (!jobId || r.jobId === jobId) && (!ids || ids.has(r.entryId)));
  if (jobId && !ids) for (const r of rows) if (r.jobId === jobId && isFailedCall(r) && rows.some((x) => x.correctionOf === r.entryId)) skipped.push({ entryId: r.entryId, reason: 'already settled (a correction row exists): never settled twice' });
  const at = new Date(now()), iso = at.toISOString(), settled = [], out = [];
  for (const r of todo) {
    const base = { entryId: r.entryId, jobId: r.jobId, at: new Date(r.ts).toISOString(), kind: r.kind, provider: r.provider, model: r.model, agent: r.agentKey || null, runId: r.runId || null, usd: r.usd, reason: r.reason || 'legacy (before W2: ' + r.note + ')' };
    if (amount == null) { settled.push(base); continue; }
    if (amount > r.usd + 1e-9) { skipped.push({ entryId: r.entryId, reason: 'USD ' + amount.toFixed(6) + ' is above the row\'s charge (its reserved maximum, USD ' + r.usd.toFixed(6) + '): check the figure' }); continue; }
    const src = String(source || '').trim() || SOURCE[r.provider] || 'the provider\'s records', delta = r6(amount - r.usd);
    const row = { entryId: settleId(r.entryId), ts: at.getTime(), correctionOf: r.entryId, correctsTs: r.ts, jobId: r.jobId ?? null, runId: r.runId || null, agentKey: r.agentKey || null, line: r.line || null, provider: r.provider, model: r.model, kind: r.kind, count: 0,
      usd: delta, settledUsd: r6(amount), estimated: false, settledBy: who, settledAt: iso, priceSource: 'owner: checked against ' + src, reason: 'settled by ' + who + ' after checking ' + src,
      note: 'settles the failed-call row ' + r.entryId + ' (' + base.reason + '; charged at its reserved maximum, USD ' + r.usd.toFixed(6) + ') to USD ' + amount.toFixed(6) + ', checked by ' + who + ' against ' + src + ' on ' + iso.slice(0, 10) + ': ' + r.usd.toFixed(6) + ' + (' + delta.toFixed(6) + ') = ' + amount.toFixed(6) };
    out.push(apply ? ledger.append(row) : row);
    settled.push({ ...base, settledUsd: r6(amount), deltaUsd: delta });
    if (log) log.info(apply ? 'failed-call row settled' : 'failed-call row would be settled', { entryId: r.entryId, jobId: r.jobId, usd: r.usd, settledUsd: r6(amount), deltaUsd: delta, by: who, at: iso, source: src });
  }
  const totalDeltaUsd = r6(settled.reduce((s, x) => s + (x.deltaUsd || 0), 0));
  // each job's spend before and after (the job cap counts the net)
  const jobs = {};
  for (const s of settled) if (s.jobId) { const j = jobs[s.jobId] || (jobs[s.jobId] = { rows: 0, deltaUsd: 0 }); j.rows++; j.deltaUsd = r6(j.deltaUsd + (s.deltaUsd || 0)); }
  for (const [id, j] of Object.entries(jobs)) { const now0 = r6(ledger.spent.job(id)); Object.assign(j, apply ? { spentBeforeUsd: r6(now0 - j.deltaUsd), spentAfterUsd: now0 } : { spentNowUsd: now0, spentAfterUsd: r6(now0 + j.deltaUsd) }); }
  return { applied: !!apply && amount != null, listOnly: amount == null, selected: todo.length, settled, skipped, rows: out, totalDeltaUsd, jobs };
}
