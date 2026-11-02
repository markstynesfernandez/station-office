// lib/exec-inputs.mjs — R3 (RESTRUCTURE.md §2.1, §2.2, §8 R3): what the engine writes for the executives before their runs. The COO and the
// CEO read only their own folders (locked rules coo-pause-only, ceo-recommends-only), so the engine gathers what they may see into one file
// there, from its own records; neither agent reaches the ledger, the store or another folder.
//   cooMetrics  products/station/reports/metrics-<day>.json: spend per product, department and line against the caps and budgets, routines
//               health, blocked and stuck jobs, open requests (counts and ids, never their text), the policy's changes, the refusals of
//               the last 24 hours, the paused lines, and the breaches: the only grounds on which the COO may pause a line (line_pause names
//               one; tools/index.mjs checks it)
//   ceoInputs   products/station/memos/inputs-<YYYY-Www>.json: Finance per product, the COO's reports of the week, Engineering in counts
//               and issue titles, the roadmap / pipeline / ANALYST slots (empty until R4, R5, R6), request counts, the owner's marks on
//               earlier proposals and the last memo. Never a request's text or payload, a support ticket, a customer record or an outreach
//               draft (the CEO gets counts and summaries from those departments, so no personal data reaches the memo)
// Proposals in both: the stuck-job threshold (stuckAfterHours 6) and the error breach (3 jobs blocked on a line in 24 hours).
import fs from 'node:fs';
import path from 'node:path';
import { dublinDay } from '../time.mjs';
import { policyLog } from '../policy.mjs';
import { listIssues } from './eng-records.mjs';
import { isoWeek, latestMarks } from './exec-records.mjs';

export const STUCK_AFTER_HOURS = 6, ERROR_BREACH_JOBS = 3;
export const EXEC_KINDS = ['exec-report', 'exec-memo'];
export const REPORTS_DIR = 'products/station/reports', MEMOS_DIR = 'products/station/memos';
const r6 = (n) => Math.round((n || 0) * 1e6) / 1e6;
const DAY_MS = 86400000;
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const clip = (t, n) => (t == null ? null : t.length > n ? t.slice(0, n) + '\n… [' + (t.length - n) + ' more characters]' : t);

// the events of the last 24 hours of one type (data/events/<day>.jsonl, today's and yesterday's files)
function recentEvents(dataRoot, type, now) {
  const out = [], since = now - DAY_MS;
  for (const day of [...new Set([dublinDay(now - DAY_MS), dublinDay(now)])]) {
    const t = readText(path.join(dataRoot, 'events', day + '.jsonl')); if (!t) continue;
    for (const l of t.split('\n')) { if (!l) continue; let e; try { e = JSON.parse(l); } catch (_) { continue; } if (e.type === type && e.ts >= since) out.push(e); }
  }
  return out;
}
// the lines a breach of a product may pause: its active lines, never an archived one or an executive line
const pausable = (cfg, C, pid) => Object.values(cfg.lines).filter((l) => !EXEC_KINDS.includes(l.kind) && !C.lineArchived(l.id) && (l.products || []).includes(pid)).map((l) => l.id);

export function cooMetrics(engine, { now = Date.now() } = {}) {
  const { cfg, store, ledger, J } = engine, C = engine.company, caps = cfg.engine.caps, day = dublinDay(now), month = day.slice(0, 7);
  const rows = ledger.rows(), dayRows = rows.filter((r) => dublinDay(r.ts) === day), monthRows = rows.filter((r) => dublinDay(r.ts).slice(0, 7) === month);
  const sum = (rs) => r6(rs.reduce((s, r) => s + (Number(r.usd) || 0), 0));
  const products = C.list.map((p) => {
    const todayUsd = r6(ledger.spent.productDay(p.id, day)), monthUsd = r6(ledger.spent.productMonth(p.id, month)), dayCapUsd = p.dailyCapUsd > 0 ? Math.min(p.dailyCapUsd, caps.perDayUsd) : null;
    return { id: p.id, name: p.name, status: p.status, todayUsd, monthUsd, budgetUsd: p.monthlyBudgetUsd, leftUsd: r6(p.monthlyBudgetUsd - monthUsd), dayCapUsd, budgetIsProposal: (p.proposals || []).includes('monthlyBudgetUsd'), jobCapUsdByDepartment: p.jobCapUsdByDepartment || {} };
  });
  const departments = C.departmentList.map((d) => ({ id: d.id, name: d.name, status: d.status, todayUsd: sum(dayRows.filter((r) => r.departmentId === d.id)), monthUsd: sum(monthRows.filter((r) => r.departmentId === d.id)) }));
  const lineCap = (l) => (caps.perLineDayUsd || {})[l] ?? (caps.perLineDayUsd || {}).default ?? 0;
  const lines = Object.values(cfg.lines).map((l) => ({ id: l.id, label: l.label || l.id, archived: C.lineArchived(l.id), todayUsd: r6(ledger.spent.lineDay(l.id, day)), dayCapUsd: lineCap(l.id) || null, paused: engine.actions ? engine.actions.paused(l.id) : null }));
  const routines = store.listRoutines().map((r) => ({ id: r.id, name: r.name, target: r.target, enabled: !!r.enabled, schedule: r.schedule, lastFireAt: r.last_fire_at ? new Date(r.last_fire_at).toISOString() : null, lastStatus: r.last_status || null, legacy: !!r.legacy, healthy: !r.last_status || !/^(failed|skipped)/.test(r.last_status) }));
  // jobs: blocked (ended without finishing), and stuck (running or starting by itself, with no change for STUCK_AFTER_HOURS)
  const jobs = store.listJobs().filter((j) => !j.legacy && j.state !== 'archived');
  const jv = (j) => ({ id: j.id, line: j.line, kind: j.kind, title: j.title || j.id, state: j.state, step: j.step || null, reason: clip(j.reason || '', 300), productId: j.product_id || null, updatedAt: j.updated_at ? new Date(j.updated_at).toISOString() : null, spentUsd: r6(ledger.spent.job(j.id)) });
  const blocked = jobs.filter((j) => ['blocked', 'incomplete', 'stopped'].includes(j.state)).map(jv);
  const stuck = jobs.filter((j) => (j.state === 'running' || (j.state === 'queued' && j.data && j.data.autoStart && !j.data.waitingFor)) && now - (j.updated_at || now) > STUCK_AFTER_HOURS * 3600000).map(jv);
  const waitingForOwner = jobs.filter((j) => j.state === 'approval' || (j.data && j.data.waitingFor === 'owner')).map((j) => ({ id: j.id, line: j.line, state: j.state, requestId: (j.data && j.data.requestId) || null }));
  // requests: counts and ids only (a request's summary or payload never goes into an exec's input)
  const reqs = engine.requests ? engine.requests.list({ limit: 500 }) : [], pend = reqs.filter((r) => r.status === 'pending');
  const byAction = {}; for (const r of pend) byAction[r.action] = (byAction[r.action] || 0) + 1;
  const oldest = pend.slice().sort((a, b) => a.filed_at - b.filed_at)[0] || null;
  const requests = { pending: pend.length, byAction, oldestPending: oldest ? { id: oldest.id, action: oldest.action, productId: oldest.product_id, filedAt: new Date(oldest.filed_at).toISOString() } : null, decidedLast24h: reqs.filter((r) => r.decided_at && now - r.decided_at < DAY_MS).length };
  const policy = { sha256: engine.policy ? engine.policy.sha256 : null, changesLast24h: policyLog(J.dataRoot, 500).filter((x) => !x.first && now - Date.parse(x.at) < DAY_MS).map((x) => ({ at: x.at, action: x.action, old: x.old, new: x.new })) };
  const refused = recentEvents(J.dataRoot, 'action.refused', now);
  const refusals = { last24h: refused.length, items: refused.slice(-20).map((e) => ({ at: new Date(e.ts).toISOString(), action: (e.data || {}).action || null, rule: (e.data || {}).rule || null, by: (e.data || {}).by || e.agentKey || null, jobId: e.jobId || null })), compliance: { refusals: 0, note: 'COMPLIANCE is hired in R5: no outbound draft is reviewed yet' } };
  // the breaches: the only grounds for a pause (line_pause names one of these ids, and only one of its lines)
  const breaches = [];
  const add = (b) => { if (b.lines.length) breaches.push({ id: 'B' + (breaches.length + 1), ...b }); };
  for (const p of products.filter((x) => x.status === 'active')) {
    if (p.monthUsd >= p.budgetUsd - 1e-9) add({ kind: 'product-month', productId: p.id, lines: pausable(cfg, C, p.id), text: p.name + ' has spent its monthly budget', spentUsd: p.monthUsd, limitUsd: p.budgetUsd });
    if (p.dayCapUsd != null && p.todayUsd >= p.dayCapUsd - 1e-9) add({ kind: 'product-day', productId: p.id, lines: pausable(cfg, C, p.id), text: p.name + ' has reached its day cap', spentUsd: p.todayUsd, limitUsd: p.dayCapUsd });
  }
  for (const l of lines.filter((x) => !x.archived && x.dayCapUsd && !EXEC_KINDS.includes((cfg.lines[x.id] || {}).kind))) if (l.todayUsd >= l.dayCapUsd - 1e-9) add({ kind: 'line-day', lines: [l.id], text: 'the ' + l.id + ' line has reached its day cap', spentUsd: l.todayUsd, limitUsd: l.dayCapUsd });
  for (const l of Object.values(cfg.lines).filter((x) => !EXEC_KINDS.includes(x.kind) && !C.lineArchived(x.id))) {
    const n = jobs.filter((j) => j.line === l.id && ['blocked', 'incomplete'].includes(j.state) && now - (j.ended_at || j.updated_at || 0) < DAY_MS).length;
    if (n >= ERROR_BREACH_JOBS) add({ kind: 'errors', lines: [l.id], text: n + ' jobs on the ' + l.id + ' line ended blocked or incomplete in the last 24 hours', jobs: n });
  }
  return {
    day, generatedAt: new Date(now).toISOString(), instance: engine.instance ? engine.instance.name || null : null, provider: engine.providers ? engine.providers.mode : null, halted: engine.halt ? engine.halt.isHalted() : false,
    spend: { todayUsd: r6(ledger.spent.day(day)), dayCapUsd: caps.perDayUsd, month, monthUsd: sum(monthRows), products, departments, lines },
    caps: { perRunUsd: caps.perRunUsd, perJobUsd: caps.perJobUsd, perDayUsd: caps.perDayUsd, note: 'caps and budgets are config files the owner edits; nothing in the Station changes them' },
    routines, jobs: { blocked, stuck, waitingForOwner, open: jobs.filter((j) => !['done', 'approved', 'rejected', 'rejected_by_owner'].includes(j.state)).length, stuckAfterHours: STUCK_AFTER_HOURS },
    requests, policy, refusals, paused: lines.filter((l) => l.paused).map((l) => ({ line: l.id, ...l.paused, at: new Date(l.paused.at).toISOString() })), breaches,
    rules: { pause: 'line_pause only for a breach listed here, and only one of its lines; the owner resumes it', errorBreachJobs: ERROR_BREACH_JOBS }
  };
}

export function ceoInputs(engine, { now = Date.now() } = {}) {
  const { cfg, store, ledger, J } = engine, C = engine.company, day = dublinDay(now), week = isoWeek(day), month = day.slice(0, 7), dataRoot = J.dataRoot;
  const finance = C.list.map((p) => { const monthUsd = r6(ledger.spent.productMonth(p.id, month)); return { id: p.id, name: p.name, status: p.status, monthUsd, budgetUsd: p.monthlyBudgetUsd, leftUsd: r6(p.monthlyBudgetUsd - monthUsd), budgetIsProposal: (p.proposals || []).includes('monthlyBudgetUsd'), mrr: 'not connected (Stripe read-only from R6)' }; });
  // the COO's reports of the last 7 days (its own records, capped)
  const rdir = path.join(dataRoot, REPORTS_DIR);
  const reports = [];
  for (let i = 6; i >= 0; i--) { const d = dublinDay(now - i * DAY_MS); const t = readText(path.join(rdir, d + '.md')); if (t != null) reports.push({ day: d, text: clip(t, 4000) }); }
  // Engineering: per product, issue counts by state and titles; job counts by state (no diff, no code)
  const engLine = cfg.lines.engineering, engineering = (engLine ? engLine.products || [] : []).map((pid) => {
    const p = C.product(pid) || { id: pid, name: pid }, issues = listIssues(dataRoot, pid), js = store.listJobs().filter((j) => j.product_id === pid && ['engineering', 'eng-triage'].includes(j.kind) && j.state !== 'archived');
    const count = (xs, k) => { const o = {}; for (const x of xs) o[x[k]] = (o[x[k]] || 0) + 1; return o; };
    return { productId: pid, name: p.name, issues: { byState: count(issues, 'state'), titles: issues.slice(-20).map((x) => ({ id: x.id, title: x.title, state: x.state })) }, jobs: { byState: count(js, 'state'), waitingForOwner: js.filter((j) => j.state === 'approval').length }, spentThisMonthUsd: r6(ledger.spent.productMonth(pid, month)) };
  });
  const reqs = engine.requests ? engine.requests.list({ limit: 500 }) : [], byKey = {};
  for (const r of reqs) { const k = r.action + ' · ' + r.status; byKey[k] = (byKey[k] || 0) + 1; }
  // the owner's marks on earlier proposals, and the last memo (so the CEO does not propose again what the owner has answered)
  const mdir = path.join(dataRoot, MEMOS_DIR), marks = Object.values(latestMarks(mdir)).map((m) => ({ week: m.week, proposal: m.proposal, title: m.title || null, mark: m.mark, words: m.words || null, at: m.at }));
  // the newest memo written so far (the inputs are written before this run's memo, so it is never this one), a second of the week included
  const memos = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((n) => /^\d{4}-W\d{2}(-\d+)?\.md$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
  const last = memos.length ? { week: memos[memos.length - 1].slice(0, -3), text: clip(readText(path.join(mdir, memos[memos.length - 1])), 6000) } : null;
  const status = (k, phase, what) => { const a = cfg.agents[k] || {}; return a.status === 'active' ? { status: 'active', note: what } : { status: 'none yet', note: (a.name || k) + ' is hired in ' + phase }; };
  return {
    week, day, generatedAt: new Date(now).toISOString(),
    finance: { products: finance, stationTodayUsd: r6(ledger.spent.day(day)), dayCapUsd: cfg.engine.caps.perDayUsd },
    cooReports: reports, engineering,
    roadmaps: status('product-manager', 'R4', 'roadmap drafts'), pipeline: status('lead-researcher', 'R5', 'pipeline counts'), analyst: status('analyst', 'R6', 'aggregates'), customerSuccess: status('support-drafter', 'R6', 'ticket and onboarding counts'),
    requests: { byActionAndStatus: byKey, pending: reqs.filter((r) => r.status === 'pending').length },
    proposalMarks: marks.slice(-30), lastMemo: last,
    activeProducts: C.list.filter((p) => p.status === 'active').map((p) => p.name),
    excluded: 'never here: a request\'s text or payload, support tickets, customer records, outreach drafts or any named contact'
  };
}
