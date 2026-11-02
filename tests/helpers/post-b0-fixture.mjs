// helpers/post-b0-fixture.mjs — R1: a synthetic data root shaped like live after B0 (DECISIONS.md "B0: Measured"; live's
// logs/migrate-businesses-2026-10-21.log): 32 jobs, 47 runs, 4 routines, 1 approval, 509 ledger rows (508 etsy-shop, 1 shared: the
// station-level smoke call), 1,148 events in 6 daily files (1,050 Etsy, 98 station-wide). Every SQLite record carries business_id (B0) and
// none carries product_id or department_id; there is no requests table; older ledger rows and events have no businessId (written before
// B0), the newer ones do. No real data: ids, agents and amounts are made up in the live shape. Mock only.
import path from 'node:path';
import { openStore, PRODUCT_TABLES } from '../../src/engine/store/db.mjs';

export const SHAPE = { jobs: 32, runs: 47, routines: 4, approvals: 1, ledger: 509, events: 1148, eventFiles: 6, etsyEvents: 1050, stationEvents: 98, etsyLedger: 508, stationLedger: 1 };
const DAYS = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
const AGENTS = ['demand-researcher', 'evidence-checker', 'trend-scout', 'designer', 'qa-design', 'lister', 'qa-listing', 'rejects-desk'];
const B0_AT = Date.parse('2026-10-21T15:10:00Z');   // rows after this were written by the B0 engine (they carry businessId)

export function buildPostB0Root({ J, log }) {
  const store = openStore({ J, log }), db = store.db, ins = (sql, ...a) => db.prepare(sql).run(...a);
  const t0 = Date.parse('2026-10-16T09:00:00Z'), at = (i, n) => t0 + Math.floor((i / n) * (B0_AT + 3600000 - t0));
  // 32 jobs: 21 imported legacy jobs, 6 on the line, 4 research batches, 1 genre-scout batch (all etsy-shop)
  const jobs = [];
  for (let i = 0; i < 21; i++) jobs.push({ id: '2026-10-' + String(10 + (i % 6)).padStart(2, '0') + '--legacy-' + i, line: 'room1-etsy', kind: 'legacy', legacy: 1 });
  for (let i = 0; i < 6; i++) jobs.push({ id: DAYS[i] + '--desk-props-' + i, line: 'room1-digital', kind: 'line', legacy: 0 });
  for (let i = 0; i < 4; i++) jobs.push({ id: DAYS[i + 1] + '--research-' + (i + 1), line: 'research', kind: 'research', legacy: 0 });
  jobs.push({ id: '2026-10-17--genre-scout-1', line: 'genre-scout', kind: 'research', legacy: 0 });
  jobs.forEach((j, i) => ins('INSERT INTO jobs (id, line, kind, state, created_at, updated_at, legacy, business_id) VALUES (?,?,?,?,?,?,?,?)', j.id, j.line, j.kind, j.legacy ? 'parked' : 'done', at(i, 32), at(i, 32), j.legacy, 'etsy-shop'));
  const engineJobs = jobs.filter((j) => !j.legacy);
  // 47 runs on the 11 engine jobs (etsy-shop)
  for (let i = 0; i < 47; i++) ins('INSERT INTO runs (run_id, job_id, agent_key, status, started_at, business_id) VALUES (?,?,?,?,?,?)', 'run_fix_' + i, engineJobs[i % engineJobs.length].id, AGENTS[i % AGENTS.length], 'done', at(i, 47), 'etsy-shop');
  // 4 routines, as live's (logs/migrate-businesses-2026-10-21.log): the seeded genre scout (disabled), 2 imported legacy routines (disabled)
  // and the weekday research routine made on the page (L3.1), here ENABLED, the worst case (live's state is not read from here) (etsy-shop)
  ins("INSERT INTO routines (id, name, target, schedule, created_at, updated_at, legacy, business_id) VALUES ('rt_seed_weekly-genre-scout', 'Weekly genre scout', 'line:genre-scout', '0 9 * * 1', ?, ?, 0, 'etsy-shop')", t0, t0);
  for (let i = 0; i < 2; i++) ins('INSERT INTO routines (id, name, target, schedule, created_at, updated_at, legacy, business_id) VALUES (?,?,?,?,?,?,1,?)', 'legacy-r' + i, 'legacy routine ' + i + ' (legacy, disabled)', 'legacy:agent:' + AGENTS[i], '0 8 * * *', t0, t0, 'etsy-shop');
  ins("INSERT INTO routines (id, name, target, input, schedule, enabled, max_runs_per_day, per_run_cap_usd, created_at, updated_at, legacy, business_id) VALUES ('rt_fix_weekday-research', 'Weekday research', 'line:research', 'sticker niches', '0 9 * * 1-5', 1, 1, 0.5, ?, ?, 0, 'etsy-shop')", t0, t0);
  // 1 approval: the line job in the old queue (etsy-shop)
  ins("INSERT INTO approvals (job_id, status, queued_at, business_id) VALUES (?, 'pending', ?, 'etsy-shop')", engineJobs[0].id, at(5, 32));
  // 509 ledger rows: 503 on engine jobs, 5 own-shop Etsy calls (USD 0), 1 station-wide smoke call (shared)
  const rows = [];
  for (let i = 0; i < 503; i++) { const j = engineJobs[i % engineJobs.length]; rows.push({ entryId: 'led_' + i, ts: at(i, 509), jobId: j.id, runId: 'run_fix_' + (i % 47), agentKey: AGENTS[i % AGENTS.length], line: j.line, provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', count: 1, usd: 0.0001, estimated: false }); }
  for (let i = 0; i < 5; i++) rows.push({ entryId: 'led_etsy_' + i, ts: at(503 + i, 509), jobId: null, runId: null, agentKey: null, line: null, provider: 'etsy', model: 'own-shop', kind: 'etsy', count: 1, usd: 0, estimated: false });
  rows.push({ entryId: 'led_smoke', ts: t0 + 1000, jobId: null, runId: null, agentKey: null, line: null, provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'text', count: 1, usd: 0.000005, estimated: false });
  for (const r of rows) { if (r.ts > B0_AT) r.businessId = r.entryId === 'led_smoke' ? 'shared' : 'etsy-shop'; ins('INSERT INTO ledger_mirror (entry_id, ts, job_id, run_id, agent_key, line, provider, model, kind, usd, row, business_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', r.entryId, r.ts, r.jobId, r.runId, r.agentKey, r.line, r.provider, r.model, r.kind, r.usd, JSON.stringify(r), r.entryId === 'led_smoke' ? 'shared' : 'etsy-shop'); }
  // B0's schema exactly: no product columns, no requests table
  for (const t of PRODUCT_TABLES) { db.exec('ALTER TABLE ' + t + ' DROP COLUMN product_id'); db.exec('ALTER TABLE ' + t + ' DROP COLUMN department_id'); }
  db.exec('DROP TABLE requests');
  store.close();
  J.put(path.join(J.dataRoot, 'ledger', 'ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // 1,148 events over 6 days: 1,050 on Etsy jobs or agents, 98 station-wide (engine starts, e-stop, recoveries)
  const byDay = Object.fromEntries(DAYS.map((d) => [d, []]));
  let seq = 0;
  for (let i = 0; i < SHAPE.events; i++) {
    const ts = at(i, SHAPE.events), day = DAYS[Math.min(5, Math.floor((i / SHAPE.events) * 6))];
    const e = { seq: ++seq, ts, type: 'run.end', jobId: null, agentKey: null, data: {} };
    if (i < SHAPE.etsyEvents) { if (i % 3 === 0) { e.type = 'agent.updated'; e.agentKey = AGENTS[i % AGENTS.length]; } else { e.type = 'job.stage'; e.jobId = engineJobs[i % engineJobs.length].id; } }
    else e.type = ['engine.start', 'halt.on', 'halt.off', 'engine.recovered'][i % 4];
    if (ts > B0_AT) e.businessId = i < SHAPE.etsyEvents ? 'etsy-shop' : 'shared';
    byDay[day].push(e);
  }
  for (const d of DAYS) J.put(path.join(J.dataRoot, 'events', d + '.jsonl'), byDay[d].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { jobs, rows };
}
