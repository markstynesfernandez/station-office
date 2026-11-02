// spend.mjs — L2: the spend confirmation behind every page action that can spend (owner brief, 19/10/2026). Before such an action
// the page asks for a quote (POST /api/spend/quote): the line, the agents and their models, the job cap, today's spend against the
// daily cap (with the worst case of every running and queued job counted), the line's day cap, the Anthropic Console's monthly limit
// if the owner configured it (config/engine.json outerLimits; L3: its worst case with every open job counted, refused when over), the
// other open jobs (L3: line, spend so far, worst case), and on the mock provider "mock: $0". A quote with no refusal carries a
// confirm token: random, single use, bound to the action and its parameters, valid runtime.confirmTtlMs. The action itself is then
// refused, server-side, when the e-stop is on (HALTED), when no valid token came with it (CONFIRM_REQUIRED), or when the daily caps
// would be exceeded at that moment (DAY_CAP). The guard still checks every call as before; this adds a gate in front of the start.
// Caps are read from config only, never changed here. Tokens live in memory: a server restart drops them (the page asks again).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dublinDay } from './time.mjs';
import { effectiveAgent } from './runtime.mjs';
import { nextRuns } from './scheduler.mjs';
import { cronWords } from '../server/model.mjs';

const r6 = (n) => Math.round((n || 0) * 1e6) / 1e6;
const err = (msg, code) => Object.assign(new Error(msg), { code });
const usd = (n) => 'USD ' + Number(n || 0).toFixed(2);

// the parameters each spending action is bound to (the token covers exactly these)
export const SPEND_ACTIONS = {
  'start-line': { label: 'Start line on brief', params: ['file'] },
  research: { label: 'Research this', params: ['text'] },
  restart: { label: 'Resume the job', params: ['jobId'] },
  'rerun-listing': { label: 'Re-run the listing', params: ['jobId'] },
  'qa-only': { label: 'QA-only run', params: ['jobId', 'set', 'maxUsd'] },
  'listing-only': { label: 'Listing-only run', params: ['jobId', 'maxUsd'] },
  'agent-on-duty': { label: 'Put the agent back on duty (its waiting jobs start)', params: ['agentKey'] },
  // L2.1 (owner, 19/10/2026): arming (enabling) a routine; disarming spends nothing and needs no token
  'routine-arm': { label: 'Arm the routine', params: ['id'] },
  // R2: the engineering line: the CTO's triage of a product's approved issues, and an engineering job on one assigned issue
  'eng-triage': { label: 'CTO triage of the approved issues', params: ['productId'] },
  'eng-start': { label: 'Start the engineering line on the issue', params: ['productId', 'issueId'] },
  // R2c: the owner's rework of a finished engineering job (back to DEVELOPER with the owner's notes, inside what is left of its cap)
  'eng-rework': { label: 'Rework: back to DEVELOPER with your notes', params: ['jobId'] },
  // R3: the executives' standing reports, started now from the Owner's office (the routines fire them on their own once armed)
  'coo-report': { label: 'COO daily operations report now', params: [] },
  'ceo-memo': { label: 'CEO weekly memo now', params: [] }
};
const bind = (action, body) => JSON.stringify([action, ...SPEND_ACTIONS[action].params.map((k) => (body[k] == null ? null : String(body[k])))]);

export function createSpendDesk(engine, { ttlMs = null, now = () => Date.now() } = {}) {
  const { cfg, store, ledger, halt, guard } = engine;
  const caps = cfg.engine.caps, ttl = ttlMs ?? (cfg.engine.runtime || {}).confirmTtlMs ?? 600000;
  const tokens = new Map();   // token -> { bound, exp }
  const O = () => engine.orchestrator;
  // the job cap of a line, and (R1) of its product's department when the product sets one (the lowest wins, as the guard checks)
  const jobCapOf = (line) => {
    const base = (caps.perJobUsdByLine || {})[line] ?? caps.perJobUsd, lp = engine.company ? engine.company.ofLine(line) : null, p = lp && lp.productId ? engine.company.product(lp.productId) : null;
    const dc = p && p.jobCapUsdByDepartment ? p.jobCapUsdByDepartment[lp.departmentId] : null;
    return dc > 0 && dc < base ? dc : base;
  };
  // R2c: the plan's estimate for a start (config/lines/<id>.json estimateUsd; not a cap, not measured): { usd, note } or null
  const estimateOf = (line, kind) => { const e = (cfg.lines[line] || {}).estimateUsd; return e && e[kind] != null ? { usd: e[kind], note: e.note || null } : null; };
  const lineDayCapOf = (line) => ((caps.perLineDayUsd || {})[line] ?? (caps.perLineDayUsd || {}).default ?? 0);
  // the worst case still open on a job: its cap less what it has spent
  const remaining = (j) => Math.max(0, jobCapOf(j.line) - ledger.spent.job(j.id));
  // jobs that may still spend today without another click: running, and queued to start by themselves (next, or after a restart)
  const committedJobs = (exceptId) => store.listJobs({ states: ['running', 'queued'] }).filter((j) => j.id !== exceptId && !j.legacy && (j.state === 'running' || O().isActive(j.id) || (engine.engineering && engine.engineering.isActive(j.id)) || (j.data && j.data.autoStart && !j.data.waitingFor)));

  function lineAgents(lineId) {
    const L = cfg.lines[lineId]; if (!L) return [];
    const keys = [...new Set(Object.values(L.steps).filter((s) => s.kind === 'agent').map((s) => s.agent))];
    const mock = engine.providers.mode === 'mock';
    return keys.map((k) => { const a = effectiveAgent(engine, k), t = cfg.engine.tiers[a.tier] || {}; return { agent: k, name: (cfg.agents[k] || {}).name || k, model: (mock ? 'mock (' + t.model + ')' : t.model) || null, effort: a.effort, onDuty: a.enabled, images: !!(a.limits && a.limits.maxImages) }; });
  }

  // what the action would start: { line, jobId, headroomUsd, what, refuse[] } (refuse: reasons it cannot start at all)
  function target(action, body) {
    const p = (k) => (body[k] == null ? '' : String(body[k]));
    if (action === 'start-line') {
      const file = p('file'); if (!/^[A-Za-z0-9._-]+\.md$/.test(file)) throw err('pick a brief', 'BAD_REQUEST');
      if (!fs.existsSync(path.join(engine.J.dataRoot, 'research', 'briefs', file))) throw err('no such brief: ' + file, 'BAD_REQUEST');
      return { line: 'room1-digital', jobId: null, headroomUsd: jobCapOf('room1-digital'), what: 'a new job on the Room 1 line from research/briefs/' + file };
    }
    if (action === 'research') { const text = p('text').trim(); if (text.length < 3) throw err('describe what to research', 'BAD_REQUEST'); return { line: 'research', jobId: null, headroomUsd: jobCapOf('research'), what: 'a new research job: "' + text.slice(0, 120) + (text.length > 120 ? '…' : '') + '"' }; }
    if (action === 'agent-on-duty') {
      const key = p('agentKey'); if (!cfg.agents[key]) throw err('no such agent: ' + key, 'BAD_REQUEST');
      const waiting = store.listJobs({ states: ['queued'] }).filter((j) => j.data && j.data.waitingFor === key);
      if (!waiting.length) return null;
      return { line: waiting[0].line, jobId: null, headroomUsd: r6(waiting.reduce((s, j) => s + remaining(j), 0)), what: waiting.length + ' waiting job(s) start: ' + waiting.map((j) => j.id).join(', '), jobs: waiting.map((j) => j.id) };
    }
    if (action === 'routine-arm') return routineTarget(p('id'));
    // R3: one executive run (the COO's report, the CEO's memo) on its own line, inside the HQ job cap and the agent's run cap
    if (action === 'coo-report' || action === 'ceo-memo') {
      const X = engine.execs; if (!X) throw err('this engine has no executives', 'BAD_REQUEST');
      const k = action === 'coo-report' ? 'coo' : 'ceo', line = X.lineOf(k);
      return { line, jobId: null, headroomUsd: jobCapOf(line), what: k === 'coo' ? 'the COO writes today\'s operations report from the engine\'s metrics (one COO run; it may pause a line on a breach the metrics list)' : 'the CEO writes this week\'s priorities memo and proposals from the engine\'s inputs (one CEO run; proposals are documents, never requests)', refuse: X.startProblems(k), estimate: estimateOf(line, 'job') };
    }
    // R2: the engineering line (engine.engineering): the job cap of the line's product and department; why it cannot start, if it cannot
    if (action === 'eng-triage') { const E = engine.engineering; if (!E) throw err('this engine has no engineering line', 'BAD_REQUEST'); return { line: 'eng-triage', jobId: null, headroomUsd: jobCapOf('eng-triage'), what: 'the CTO orders the approved issues of ' + p('productId') + ' (one CTO run, writes backlog/dev-queue.json)', estimate: estimateOf('eng-triage', 'job') }; }
    if (action === 'eng-start') { const E = engine.engineering; if (!E) throw err('this engine has no engineering line', 'BAD_REQUEST'); const sp = E.startProblems(p('productId'), p('issueId')); return { line: 'engineering', jobId: null, headroomUsd: jobCapOf('engineering'), what: 'job ' + (sp.jobId || '?') + ' on issue ' + p('issueId') + ': TECH-LEAD spec, DEVELOPER, checks in Docker, TESTER, REVIEWER, SECURITY, then a merge request for you (the engine never pushes)', refuse: sp.problems, estimate: estimateOf('engineering', 'job') }; }
    // R2c: the rework runs inside what is left of the job's cap; a job with nothing left is refused here, and the guard holds every call to it
    if (action === 'eng-rework') {
      const j = store.getJob(p('jobId')); if (!j || j.kind !== 'engineering') throw err('no such engineering job: ' + p('jobId'), 'BAD_REQUEST');
      const rest = remaining(j);
      return { line: j.line, jobId: j.id, headroomUsd: r6(rest), what: 'DEVELOPER reworks ' + j.id + ' on ' + ((j.data && j.data.branch) || 'its branch') + ' with your notes, then the checks in Docker, TESTER, REVIEWER and SECURITY again, a new commit and a new merge request; inside what is left of its cap', refuse: rest <= 0 ? ['job cap reached: ' + usd(ledger.spent.job(j.id)) + ' of ' + usd(jobCapOf(j.line)) + ' spent on this job'] : [], estimate: estimateOf('engineering', 'rework') };
    }
    const j = store.getJob(p('jobId')); if (!j) throw err('no such job: ' + p('jobId'), 'BAD_REQUEST');
    const rest = remaining(j), refuse = rest <= 0 ? ['job cap reached: ' + usd(ledger.spent.job(j.id)) + ' of ' + usd(jobCapOf(j.line)) + ' spent on this job'] : [];
    if (action === 'qa-only' || action === 'listing-only') { const m = Number(body.maxUsd); return { line: j.line, jobId: j.id, headroomUsd: r6(Math.min(rest, m > 0 ? m : rest)), what: SPEND_ACTIONS[action].label + ' on ' + j.id + ' within your cap ' + usd(m), refuse }; }
    return { line: j.line, jobId: j.id, headroomUsd: r6(rest), what: (action === 'restart' ? 'job ' + j.id + ' runs on from ' + (j.step || 'its start') : 'LISTER and QA LISTING again on ' + j.id), refuse };
  }

  // L2.1: a routine's worst case. Per firing: its per-run cap, never above the line's job cap (no per-run cap: the job cap). Per day: the
  // firings its schedule has that Dublin day, at most maxRunsPerDay; per week: the next 7 days summed. The scheduler still holds every
  // firing to the daily caps and the e-stop when it fires; arming spends nothing now, so the day caps are shown, not refused on.
  function routineTarget(id) {
    const rt = store.getRoutine(id); if (!rt) throw err('no such routine: ' + id, 'BAD_REQUEST');
    if (rt.legacy) throw err('an imported legacy routine is read only', 'BAD_REQUEST');
    // R3: an agent routine (an executive's standing report) is priced on its executive's line
    const m = /^line:(.+)$/.exec(rt.target || ''), ag = /^agent:(.+)$/.exec(rt.target || ''), at = ag ? (engine.routineTargets || []).find((t) => t.id === rt.target) : null;
    const line = m && cfg.lines[m[1]] ? m[1] : at && at.line && cfg.lines[at.line] ? at.line : null;
    if (!line) throw err('this routine\'s target cannot run: ' + rt.target, 'BAD_REQUEST');
    const jobCap = jobCapOf(line), perFiring = r6(rt.per_run_cap_usd != null ? Math.min(rt.per_run_cap_usd, jobCap) : jobCap);
    const from = now(), until = from + 7 * 86400000, byDay = {};
    for (const at of nextRuns(rt.schedule, 7 * 24 * 60 + 1, new Date(from))) if (at < until) { const d = dublinDay(at); byDay[d] = (byDay[d] || 0) + 1; }
    const perDay = Object.values(byDay).map((n) => Math.min(n, rt.max_runs_per_day || 1)), firingsWeek = perDay.reduce((a, b) => a + b, 0), maxDay = perDay.length ? Math.max(...perDay) : 0;
    return { line, jobId: null, headroomUsd: perFiring, what: 'routine "' + rt.name + '" fires on its own from now on (' + rt.target + ')',
      routine: { id: rt.id, name: rt.name, schedule: rt.schedule, scheduleWords: cronWords(rt.schedule) + ' (Dublin)', maxRunsPerDay: rt.max_runs_per_day, perRunCapUsd: rt.per_run_cap_usd, jobCapUsd: jobCap, worstPerFiringUsd: perFiring, firingsPerDayMax: maxDay, worstPerDayUsd: r6(maxDay * perFiring), firingsPerWeek: firingsWeek, worstPerWeekUsd: r6(firingsWeek * perFiring), dailyCapUsd: caps.perDayUsd, overDailyCap: maxDay * perFiring > caps.perDayUsd + 1e-9 } };
  }

  // L3 (owner, 20/10/2026): two lines may run side by side (runtime.maxRunningJobs 2, one job per line), so every check of a start counts
  // EVERY open job (running, or queued to start by itself) at its worst case (its cap less its spend): the daily cap, the line's day cap
  // and the Anthropic Console's monthly estimate. The same check is used by the spend dialog, the server-side gate and a routine's
  // firing (engine.runRoutine). The guard counts every job's reservations call by call (guard.mjs: per run, per job, per day, the
  // OpenRouter key's day). -> every figure, and the refusals (empty: the start may go ahead)
  function startCheck({ line, headroomUsd, exceptId = null, exceptJobs = [] }) {
    const day = dublinDay(now()), g = guard.status();
    const others = committedJobs(exceptId).filter((j) => !exceptJobs.includes(j.id));
    const committed = r6(others.reduce((s, j) => s + remaining(j), 0)), lineCommitted = r6(others.filter((j) => j.line === line).reduce((s, j) => s + remaining(j), 0));
    const spentToday = r6(g.spentToday), lineSpent = r6(ledger.spent.lineDay(line, day)), lineCap = lineDayCapOf(line);
    const worst = r6(spentToday + committed + headroomUsd), lineWorst = r6(lineSpent + lineCommitted + headroomUsd);
    const ol = cfg.engine.outerLimits || {}, month = day.slice(0, 7), consoleLimit = ol.anthropicConsoleMonthlyUsd > 0 ? ol.anthropicConsoleMonthlyUsd : null;
    const consoleUsed = r6(ledger.rows().filter((r) => String(r.provider || '').startsWith('anthropic') && dublinDay(r.ts).slice(0, 7) === month).reduce((s, r) => s + (Number(r.usd) || 0), 0));
    // the Console estimate's worst case: this month's Anthropic rows + every open job's worst case + this one (an open job's worst case
    // counts in full: its images are not split out, so the estimate errs high)
    const consoleWorst = r6(consoleUsed + committed + headroomUsd);
    // B0 (owner, 21/10/2026), R1: the product level (B0's business level, renamed): its monthly budget (the Dublin month) and, when it sets
    // one, its day cap, with its own open jobs at their worst case; the station's caps above stay the outer limit (the lowest limit wins)
    const C = engine.company, lp = C ? C.ofLine(line) : null, pid = lp ? lp.productId : null, p = pid ? C.product(pid) : null;
    let product = null;
    if (p) {
      const mine = others.filter((j) => (j.product_id || (C.ofLine(j.line) || {}).productId) === pid), bc = r6(mine.reduce((s, j) => s + remaining(j), 0));
      const monthSpent = r6(ledger.spent.productMonth(pid, month)), daySpent = r6(ledger.spent.productDay(pid, day)), dayCap = p.dailyCapUsd > 0 ? Math.min(p.dailyCapUsd, caps.perDayUsd) : null;
      const dept = C.department(lp.departmentId);
      product = { id: pid, name: p.name, status: p.status, department: lp.departmentId, departmentName: dept ? dept.name : null, floor: dept ? dept.floor : null, month, monthSpentUsd: monthSpent, budgetUsd: p.monthlyBudgetUsd, budgetProposal: (p.proposals || []).includes('monthlyBudgetUsd'), openJobsUsd: bc, monthWorstUsd: r6(monthSpent + bc + headroomUsd), dayCapUsd: dayCap, daySpentUsd: daySpent, dayWorstUsd: r6(daySpent + bc + headroomUsd) };
    }
    const refusals = [];
    if (halt.isHalted()) refusals.push('e-stop is on: nothing starts until you resume');
    if (!g.ledgerOk) refusals.push('the ledger is unreadable: every paid call is refused');
    if (worst > caps.perDayUsd + 1e-9) refusals.push('the daily cap would be exceeded: spent today ' + usd(spentToday) + ' + open jobs up to ' + usd(committed) + ' + this up to ' + usd(headroomUsd) + ' = ' + usd(worst) + ', over ' + usd(caps.perDayUsd));
    if (lineCap > 0 && lineWorst > lineCap + 1e-9) refusals.push('the ' + line + ' line\'s daily cap would be exceeded: ' + usd(lineWorst) + ' worst case, over ' + usd(lineCap));
    if (consoleLimit && consoleWorst > consoleLimit + 1e-9) refusals.push('the Anthropic Console\'s monthly limit could be passed (estimate from the station ledger): this month ' + usd(consoleUsed) + ' + open jobs up to ' + usd(committed) + ' + this up to ' + usd(headroomUsd) + ' = ' + usd(consoleWorst) + ', over ' + usd(consoleLimit));
    if (product && product.monthWorstUsd > product.budgetUsd + 1e-9) refusals.push(product.name + '\'s monthly budget would be exceeded: this month ' + usd(product.monthSpentUsd) + ' + its open jobs up to ' + usd(product.openJobsUsd) + ' + this up to ' + usd(headroomUsd) + ' = ' + usd(product.monthWorstUsd) + ', over ' + usd(product.budgetUsd));
    if (product && product.dayCapUsd != null && product.dayWorstUsd > product.dayCapUsd + 1e-9) refusals.push(product.name + '\'s daily cap would be exceeded: ' + usd(product.dayWorstUsd) + ' worst case, over ' + usd(product.dayCapUsd));
    const openJobs = others.map((j) => ({ id: j.id, line: j.line, lineLabel: (cfg.lines[j.line] || {}).label || j.line, state: j.state === 'running' || O().isActive(j.id) || (engine.engineering && engine.engineering.isActive(j.id)) ? 'running' : 'next', step: j.step || null, spentUsd: r6(ledger.spent.job(j.id)), capUsd: jobCapOf(j.line), worstUsd: r6(remaining(j)) }));
    return { day, g, month, product, consoleLimit, consoleUsed, consoleWorst, openJobs, committed, lineCommitted, spentToday, lineSpent, lineCap, worst, lineWorst, refusals };
  }

  // the quote (no token): every figure the dialog shows, and why it cannot go ahead (refusals)
  function assess(action, body) {
    if (!SPEND_ACTIONS[action]) throw err('unknown spending action: ' + action, 'BAD_REQUEST');
    const t = target(action, body || {}); if (!t) return null;
    const mock = engine.providers.mode === 'mock';
    const sc = startCheck({ line: t.line, headroomUsd: t.headroomUsd, exceptId: t.jobId, exceptJobs: t.jobs || [] });
    const { day, month, spentToday, committed, worst, lineSpent, lineWorst, lineCap, consoleUsed, consoleWorst, consoleLimit } = sc;
    // arming a routine spends nothing now: only the e-stop and the ledger refuse it (the firing is checked when it fires)
    const scr = t.routine ? sc.refusals.filter((x) => /^e-stop|^the ledger/.test(x)) : sc.refusals, isStop = (x) => /^e-stop/.test(x);
    const refusals = [...scr.filter(isStop), ...(t.refuse || []), ...scr.filter((x) => !isStop(x))];   // the e-stop first (the gate's HALTED)
    const ol = cfg.engine.outerLimits || {};
    // L3: the queue: a start on a line whose job is running waits as next for that line; one beyond the total waits as next as before
    const runningJobs = store.listJobs({ states: ['running'] }).filter((j) => !j.legacy), running = runningJobs.map((j) => j.id), max = engine.maxRunningJobs || null;
    const lineBusy = runningJobs.some((j) => j.line === t.line && j.id !== t.jobId), totalFull = !!max && running.filter((x) => x !== t.jobId).length >= max;
    const nextFor = t.routine ? null : lineBusy ? 'line' : totalFull ? 'total' : null;
    // the OpenRouter key's day (outside the engine; the guard refuses an image call that would pass it): every job's image rows today
    const orToday = r6(guard.openrouterDay ? guard.openrouterDay().usedUsd : 0);
    return {
      action, label: SPEND_ACTIONS[action].label, what: t.what, line: t.line, lineLabel: (cfg.lines[t.line] || {}).label || t.line, jobId: t.jobId,
      provider: engine.providers.mode, mock, mockNote: mock ? 'mock: $0 (no model is called and nothing is charged)' : null,
      agents: lineAgents(t.line), imageModel: lineAgents(t.line).some((a) => a.images) ? (mock ? 'mock (' + cfg.engine.image.allowedModels.join(', ') + ')' : cfg.engine.image.allowedModels.join(', ')) : null,
      job: { capUsd: jobCapOf(t.line), spentUsd: t.jobId ? r6(ledger.spent.job(t.jobId)) : 0, headroomUsd: t.headroomUsd, perRunUsd: caps.perRunUsd },
      estimate: t.estimate || null,
      day: { date: day, spentUsd: spentToday, openJobsUsd: committed, worstUsd: worst, capUsd: caps.perDayUsd, line: { spentUsd: lineSpent, worstUsd: lineWorst, capUsd: lineCap } },
      console: consoleLimit ? { configured: true, month, limitUsd: consoleLimit, usedUsd: consoleUsed, leftUsd: r6(consoleLimit - consoleUsed), openJobsUsd: committed, worstUsd: consoleWorst, leftAfterWorstUsd: r6(consoleLimit - consoleWorst), note: 'estimate from the station ledger; the Console is the authority' } : { configured: false, month, usedUsd: consoleUsed, note: 'not configured (config/engine.json outerLimits.anthropicConsoleMonthlyUsd)' },
      openrouterDailyUsd: ol.openrouterDailyUsd ?? null, openrouter: ol.openrouterDailyUsd != null ? { limitUsd: ol.openrouterDailyUsd, usedTodayUsd: orToday, note: 'every job\'s image calls today (station ledger); the engine refuses an image call that would pass the key\'s limit' } : null,
      // L3: the other open jobs (running, or next): line, spend so far, worst case still open
      otherJobs: sc.openJobs,
      // R1: the product line (B0: business): the product and its department, its spend this month against its budget (and its day cap)
      product: sc.product,
      queue: { running, maxRunning: max, startsAsNext: !!nextFor, nextFor },
      routine: t.routine || null,
      refusals
    };
  }

  function quote(action, body = {}) {
    const q = assess(action, body);
    if (!q) return { action, label: SPEND_ACTIONS[action].label, needed: false, refusals: [] };
    for (const [k, v] of tokens) if (v.exp < now()) tokens.delete(k);
    if (q.refusals.length) return { ...q, needed: true, token: null };
    const token = crypto.randomBytes(18).toString('hex'), exp = now() + ttl;
    tokens.set(token, { bound: bind(action, body), exp });
    return { ...q, needed: true, token, expiresAt: exp };
  }

  // the server-side gate in front of the action: the e-stop, the confirm token, the day caps now. Consumes the token.
  function gate(action, body = {}) {
    if (halt.isHalted()) throw err('e-stop is on: ' + SPEND_ACTIONS[action].label.toLowerCase() + ' refused until you resume', 'HALTED');
    const q = assess(action, body); if (!q) return null;   // nothing would spend (an agent with no waiting job)
    const tok = String(body.confirmToken || ''), rec = tokens.get(tok);
    if (!tok || !rec) throw err('confirm first: this action can spend, and it needs the confirm step (ask for the spend dialog again)', 'CONFIRM_REQUIRED');
    if (rec.exp < now()) { tokens.delete(tok); throw err('the confirmation has expired: confirm again', 'CONFIRM_REQUIRED'); }
    if (rec.bound !== bind(action, body)) throw err('the confirmation was for a different action or different settings: confirm again', 'CONFIRM_REQUIRED');
    tokens.delete(tok);
    if (q.refusals.length) throw err('refused: ' + q.refusals.join('; '), /e-stop/.test(q.refusals[0]) ? 'HALTED' : 'DAY_CAP');
    return q;
  }
  return { quote, gate, assess, startCheck, jobCapOf, pending: () => tokens.size };
}
