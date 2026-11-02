// cost.mjs — real spend from StarNet's ledger.jsonl (one line per finished run: { runId, agentId, turns, usd,
// tokens, ts, model, ... }). Never estimates.
// Source: Virtual-workers/station/scripts/lib/cost.mjs (owner-written). Copied: readLedger, rosterNames, idsForNames,
// costInWindow. Change from the source: paths are passed in (ledgerFile / rosterFile) instead of coming from the
// station's config module, so the same code runs on fixtures and on the live workspace.
import fs from 'node:fs';

const tsMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

export function readLedger(ledgerFile) {
  if (!ledgerFile || !fs.existsSync(ledgerFile)) return [];
  const rows = [];
  for (const line of fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r.usd === 'number') rows.push({ ...r, tsMs: tsMs(r.ts) }); } catch (_) { /* skip torn line */ }
  }
  return rows;
}

// agentId -> name from StarNet's server-side roster mirror (agent.roster.json)
export function rosterNames(rosterFile) {
  if (!rosterFile || !fs.existsSync(rosterFile)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    return Object.fromEntries((j.agents || []).map((a) => [a.agentId, a.name]));
  } catch (_) { return {}; }
}

// StarNet turns spaces in imported names into hyphens ("QA LISTING" -> "QA-LISTING"), so compare on letters and digits only.
export const nameKey = (n) => String(n).toUpperCase().replace(/[^A-Z0-9]/g, '');
export function idsForNames(names, roster) {
  const want = new Set(names.map(nameKey));
  return Object.entries(roster || {}).filter(([, n]) => want.has(nameKey(n))).map(([id]) => id);
}

// Sum ledger rows for `agentIds` with ts in [startMs, endMs]. Returns the total and one workings line per run.
export function costInWindow({ agentIds, startMs, endMs, ledger = [], names = {} }) {
  const ids = new Set(agentIds);
  const rows = ledger.filter((r) => ids.has(r.agentId) && r.tsMs >= startMs && r.tsMs <= endMs).sort((a, b) => a.tsMs - b.tsMs);
  const total = rows.reduce((s, r) => s + r.usd, 0);
  return {
    totalUsd: Number(total.toFixed(6)),
    runs: rows.length,
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    workings: rows.map((r) => ({ at: new Date(r.tsMs).toISOString(), agent: names[r.agentId] || r.agentId, runId: r.runId, model: r.model || null, tokens: r.tokens ?? null, usd: r.usd })),
    sum: rows.map((r) => r.usd.toFixed(6)).join(' + ') + ' = ' + total.toFixed(6)
  };
}
