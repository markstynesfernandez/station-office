// lib/settle-images.mjs — settles ESTIMATED image rows from OpenRouter's own record of each generation (E6 wrap-up, owner 18/10/2026).
// OpenRouter's generation lookup (docs read 18/10/2026: https://openrouter.ai/docs/api-reference/get-a-generation):
//   GET https://openrouter.ai/api/v1/generation?id=<gen-...>   Authorization: Bearer <key>   ->   { data: { id, model, total_cost, ... } }
// `total_cost` is the generation's cost in USD. The lookup is a read of a record, not a generation: it makes no image and no model call.
// An image row is estimated when the call failed without a cost report and was charged at the USD 0.08 reservation. It can be settled only
// when the row carries the generation id OpenRouter returned; a call that failed before any response has none, and stays estimated (the
// owner checks it against OpenRouter's activity by hand). Rows for failed Anthropic calls stay estimated: nothing here touches them.
// The ledger is never edited: a settled row gets ONE correction row (entryId "settle-<entryId>", correctionOf, the difference in usd,
// settledUsd = total_cost), so running it twice writes nothing new. Without `apply` nothing is written (the plan only).
import { lookupGeneration } from '../providers/openrouter.mjs';
const r6 = (n) => Math.round(n * 1e6) / 1e6;
export const settleId = (entryId) => 'settle-' + entryId;

// the estimated OpenRouter image rows not yet corrected
export function estimatedImageRows(rows) {
  const corrected = new Set(rows.filter((r) => r.correctionOf).map((r) => r.correctionOf));
  return rows.filter((r) => r.kind === 'image' && r.provider === 'openrouter' && r.estimated && !r.correctionOf && !corrected.has(r.entryId));
}

// -> { checked, settled: [...], unsettled: [{ entryId, jobId, reason }], rows: [correction rows written or planned], totalDeltaUsd }
export async function settleImageRows({ engineCfg, ledger, fetchImpl = globalThis.fetch, key, apply = false, log = null, timeoutMs = 15000 }) {
  const todo = estimatedImageRows(ledger.rows()), settled = [], unsettled = [], out = [];
  for (const r of todo) {
    const base = { entryId: r.entryId, jobId: r.jobId, usd: r.usd };
    if (!r.generationId) { unsettled.push({ ...base, reason: 'no generation id on the row (the call failed before OpenRouter returned one): check it against OpenRouter\'s activity by hand' }); continue; }
    if (!/^gen-[0-9A-Za-z-]+$/.test(r.generationId) || r.generationId.length > 128) { unsettled.push({ ...base, reason: 'the generation id is not in OpenRouter\'s form' }); continue; }
    if (!key) { unsettled.push({ ...base, reason: 'no OPENROUTER_API_KEY in this process' }); continue; }
    let res;
    try { res = await lookupGeneration({ engineCfg, id: r.generationId, key, fetchImpl, timeoutMs }); }
    catch (e) { unsettled.push({ ...base, reason: 'lookup failed: ' + (e && e.name === 'TimeoutError' ? 'timeout' : 'network error') }); continue; }
    if (!res.ok) { unsettled.push({ ...base, reason: 'lookup answered HTTP ' + res.status + (res.status === 404 ? ' (no such generation yet)' : '') }); continue; }
    const d = res.data, cost = d && d.total_cost;
    if (!d || d.id !== r.generationId || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) { unsettled.push({ ...base, reason: 'the lookup gave no total_cost for this generation' }); continue; }
    const row = { entryId: settleId(r.entryId), correctionOf: r.entryId, correctsTs: r.ts, jobId: r.jobId ?? null, runId: r.runId, agentKey: r.agentKey, line: r.line, provider: 'openrouter', model: r.model, kind: 'image', count: 0,
      usd: r6(cost - r.usd), settledUsd: r6(cost), estimated: false, generationId: r.generationId, priceSource: 'provider (OpenRouter GET /api/v1/generation total_cost)',
      note: 'settles the estimated row ' + r.entryId + ' (charged at USD ' + r.usd.toFixed(6) + ') to OpenRouter\'s total_cost USD ' + cost.toFixed(6) + ': ' + r.usd.toFixed(6) + ' + (' + r6(cost - r.usd).toFixed(6) + ') = ' + cost.toFixed(6) };
    out.push(apply ? ledger.append(row) : row);
    settled.push({ ...base, settledUsd: r6(cost), deltaUsd: row.usd });
    if (log) log.info(apply ? 'estimated image row settled' : 'estimated image row would be settled', { entryId: r.entryId, jobId: r.jobId, generationId: r.generationId, usd: r.usd, settledUsd: r6(cost) });
  }
  return { checked: todo.length, applied: !!apply, settled, unsettled, rows: out, totalDeltaUsd: r6(settled.reduce((s, x) => s + x.deltaUsd, 0)) };
}
