// execs.mjs — R3 (RESTRUCTURE.md §2.1, §3.2, §8 R3): the penthouse executives at work. Two one-agent lines on the Station itself (product
// station, department hq), run by the engineering module's side-line runner (engineering.mjs addRunner: start, stop, resume, archive and
// the running-jobs limit are the same as the CTO's triage):
//   coo-report   the COO's daily operations report: the engine writes reports/metrics-<day>.json (lib/exec-inputs.mjs cooMetrics), then
//                the COO writes reports/<day>.md (checked on write: lib/exec-records.mjs reportProblems; every USD figure from the metrics).
//                It may pause a line with line_pause, and only for a breach the metrics list, on one of that breach's lines (the locked
//                rule coo-pause-only: it never resumes a line and never changes a cap or budget; the owner resumes it on the page)
//   ceo-memo     the CEO's weekly priorities memo: the engine writes memos/inputs-<YYYY-Www>.json (ceoInputs: counts and summaries, no
//                request text, ticket, customer record or named contact), then the CEO writes memos/<YYYY-Www>.md (parseMemo: priorities
//                per active product, proposals P1..Pn with options, recommendation and cost). A proposal is a document in the Owner's
//                office, never a request: the owner marks it taken, declined or later (markProposal; a note, not an approval of anything)
// Who starts one: the owner on the page (behind the spend confirmation) or the routine the owner armed (routines are seeded disabled). The
// locked rules hold in code whatever this file does: the CEO's tools are fs_read, fs_list, fs_write in its memos folder only, the COO's
// add line_pause (locked.mjs, runtime.mjs), and every call goes through the spend guard, the e-stop and the policy (runtime.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, effectiveAgent } from './runtime.mjs';
import { dublinDay } from './time.mjs';
import { cooMetrics, ceoInputs, EXEC_KINDS, REPORTS_DIR, MEMOS_DIR } from './lib/exec-inputs.mjs';
import { reportProblems, parseMemo, isoWeek, marksFile, latestMarks, MARKS } from './lib/exec-records.mjs';
import { secretContentHits } from './lib/secrets.mjs';
import { PolicyRefusal } from './policy.mjs';
import { LockedRefusal } from './locked.mjs';

export const EXECS = {
  coo: { agent: 'coo', line: 'coo-report', kind: 'exec-report', dir: REPORTS_DIR, title: 'COO daily operations report' },
  ceo: { agent: 'ceo', line: 'ceo-memo', kind: 'exec-memo', dir: MEMOS_DIR, title: 'CEO weekly memo' }
};
const refuse = (msg, code = 'EXEC') => Object.assign(new Error(msg), { code });
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const clip = (t, n) => (t == null ? null : t.length > n ? t.slice(0, n) + '\n… [' + (t.length - n) + ' more characters in the file]' : t);

export function createExecs(engine, { now = () => Date.now() } = {}) {
  const { store, bus, log, cfg, J, halt, ledger } = engine, C = engine.company, E = engine.engineering;
  const dirOf = (k) => path.join(J.dataRoot, EXECS[k].dir);
  const owner = (actor) => !!(engine.requests && engine.requests.isOwner(actor));
  const kindOf = (job) => Object.keys(EXECS).find((k) => EXECS[k].kind === job.kind) || null;
  const activeProducts = () => C.list.filter((p) => p.status === 'active').map((p) => p.name);

  // ---- why an exec job cannot start now -> problems[] (empty: it can)
  function startProblems(k) {
    const x = EXECS[k]; if (!x) return ['no such executive report: ' + k];
    const out = [], st = C.agentStatus(x.agent), name = (cfg.agents[x.agent] || {}).name || x.agent;
    if (st !== 'active') out.push(name + ' is ' + (st === 'not-hired' ? 'not hired yet' : st));
    else if (!effectiveAgent(engine, x.agent).enabled) out.push(name + ' is off duty');
    if (!cfg.lines[x.line]) out.push('no ' + x.line + ' line in config/lines');
    const hold = engine.lineHold ? engine.lineHold(x.line) : null; if (hold) out.push(hold);
    const open = store.listJobs({ states: ['queued', 'running'] }).find((j) => j.kind === x.kind);
    if (open) out.push(name + '\'s job ' + open.id + ' is already ' + open.state);
    return out;
  }

  // ---- a start: the owner on the page, or a routine (actor engine); a script starts none unless it starts jobs
  function start(k, { by = 'owner (office)', routineId = null } = {}, { actor } = {}) {
    const x = EXECS[k]; if (!x) throw refuse('no such executive report: ' + k, 'BAD_REQUEST');
    if (!(owner(actor) || (actor && actor.kind === 'engine' && routineId))) throw refuse('the ' + x.title + ' is started by the owner on the page, or by the routine the owner armed', 'LOCKED');
    if (halt.isHalted()) throw refuse('e-stop is on', 'HALTED');
    if (engine.scriptRun && !engine.scriptRun.startsJobs) throw refuse('no job starts from this script (' + engine.scriptRun.purpose + ')', 'SCRIPT');
    const probs = startProblems(k); if (probs.length) throw refuse('the ' + x.title + ' cannot start: ' + probs.join('; '), /not hired/.test(probs[0]) ? 'NOT_HIRED' : 'BAD_REQUEST');
    const day = dublinDay(now()), period = k === 'coo' ? day : isoWeek(day);
    // the record's name: <day> or <week>; a second run in the same period writes <period>-2, -3 … (an earlier record is never overwritten)
    let name = period, n = 2; while (fs.existsSync(path.join(dirOf(k), name + '.md')) || store.getJob(x.line + '-' + name)) name = period + '-' + n++;
    const id = x.line + '-' + name;
    store.insertJob({ id, line: x.line, kind: x.kind, title: x.title + ' · ' + name, state: 'queued', step: cfg.lines[x.line].start, product_id: 'station', department_id: C.deptOfAgent(x.agent) || 'hq', data: { exec: k, period, name, createdBy: by, routineId } });
    bus.emit('job.created', { jobId: id, data: { line: x.line, title: x.title, by } });
    log.info('exec job created', { id, exec: k, by });
    if (engine.scriptRun) engine.scriptRun.own.add(id);
    return { jobId: id, name, promise: E.start(id) };
  }

  // ---- the run (engineering.mjs calls it with its kit: setJob, block, stopFrom, agentWait, mockOnLive)
  async function run(id, signal, kit) {
    let job = kit.setJob(id, { state: 'running', started_at: store.getJob(id).started_at || now(), reason: null, data: { next: false } }, 'job.stage', { step: store.getJob(id).step });
    const k = kindOf(job); if (!k) return kit.block(job, 'not an executive job: ' + job.kind);
    const x = EXECS[k], L = cfg.lines[x.line], dir = dirOf(k), name = job.data.name;
    // 1. the engine's inputs (no model, no cost)
    const inStep = L.start, inDef = L.steps[inStep] || {};
    const sid = store.tx(() => { const s = store.openStage(id, inStep, 1); store.updateJob(id, { step: inStep }); return s; });
    bus.emit('job.stage', { jobId: id, data: { step: inStep, pass: 1, kind: 'mechanical' } });
    let inputs, inputsRel;
    try {
      inputs = k === 'coo' ? cooMetrics(engine, { now: now() }) : ceoInputs(engine, { now: now() });
      const text = JSON.stringify(inputs, null, 2) + '\n', sh = secretContentHits(text);
      if (sh.length) { store.closeStage(sid, 'blocked', 'the inputs hold what looks like a secret'); return kit.block(store.getJob(id), 'refused by a locked rule (secrets-refused): the ' + (k === 'coo' ? 'metrics' : 'inputs') + ' hold what looks like a secret (' + sh.join(', ') + '); nothing was given to ' + cfg.agents[x.agent].name); }
      inputsRel = (k === 'coo' ? 'metrics-' : 'inputs-') + name + '.json';
      J.put(path.join(dir, inputsRel), text);
    } catch (e) { store.closeStage(sid, 'blocked', e.message); return kit.block(store.getJob(id), 'the inputs could not be gathered: ' + e.message); }
    store.closeStage(sid, 'done', inputsRel + (k === 'coo' ? ': ' + inputs.breaches.length + ' breach(es)' : ''));
    store.updateJob(id, { data: { inputs: inputsRel, ...(k === 'coo' ? { breaches: inputs.breaches.map((b) => ({ id: b.id, kind: b.kind, lines: b.lines, text: b.text })) } : {}) } });
    // 2. the agent
    const step = inDef.next, def = L.steps[step] || {};
    job = store.updateJob(id, { step });
    const wait = kit.agentWait(job, def.agent); if (wait) return wait;
    if (kit.mockOnLive(id)) return kit.setJob(id, { state: 'stopped', reason: 'stopped before ' + step + ': the job has live spend and this engine runs the mock provider', ended_at: now() }, 'job.stopped');
    const file = name + '.md', abs = path.join(dir, file), before = fs.existsSync(abs) ? fs.statSync(abs).mtimeMs : 0;
    const sid2 = store.tx(() => store.openStage(id, step, 1));
    bus.emit('job.stage', { jobId: id, agentKey: def.agent, data: { step, pass: 1, kind: 'agent' } });
    const pauses = [];
    const validators = k === 'coo'
      ? { [file]: (t) => reportProblems(t, { day: inputs.day, metrics: inputs }) }
      : { [file]: (t) => parseMemo(t, { week: inputs.week, products: activeProducts() }).problems };
    const input = k === 'coo'
      ? ['Daily operations report for ' + inputs.day + '. The engine wrote today\'s metrics to ' + inputsRel + ' (read it first; it is the only source of figures).',
        'Write ' + file + ' with fs_write. The first line is "# Operations report ' + inputs.day + '", then the sections ## Summary, ## Spend and caps, ## Routines, ## Blocked and stuck jobs, ## Requests and policy, ## Refusals, ## Pauses. Copy every USD figure from the metrics; never compute, round differently or estimate one.',
        inputs.breaches.length ? 'BREACHES in the metrics: ' + inputs.breaches.map((b) => b.id + ' (' + b.kind + ': ' + b.text + '; lines ' + b.lines.join(', ') + ')').join('; ') + '. You may pause a line for one of them with line_pause (line, breach id, reason); say so under ## Pauses. The owner resumes it.' : 'There is no breach in the metrics: you cannot pause any line today.',
        'For each blocked or stuck job, write a short diagnosis from its reason and a proposed next step for the owner (resume, archive, or what to check). Requests are listed by count and id only.'].join('\n')
      : ['Weekly priorities memo for ' + inputs.week + '. The engine wrote this week\'s inputs to ' + inputsRel + ' (read it first; it is your only source).',
        'Write ' + file + ' with fs_write. The first line is "# CEO memo ' + inputs.week + '", then ## Priorities with a "### <product>" block for each active product (' + activeProducts().join(', ') + '), then ## Proposals with "### P1: <title>" blocks, each with "Options:" (at least two "- " lines), "Recommendation: …" and "Cost: …". You may add ## Notes.',
        'A proposal is a document for the owner, never a request: you decide nothing, approve nothing and change no policy, budget or cap. If there is nothing worth proposing, write "No proposal this week." under ## Proposals.',
        inputs.proposalMarks.length ? 'The owner has already answered earlier proposals (proposalMarks in the inputs): do not propose again what the owner declined unless something has changed, and say what changed.' : ''].filter(Boolean).join('\n');
    const exec = k === 'coo' ? { writeAction: 'report.write', pauseLine: ({ line, breach, reason }) => pauseFor(id, inputs, pauses, { line, breach, reason }) } : { writeAction: 'memo.write' };
    const contract = { tool: 'fs_write', partialOk: false, hint: 'Write ' + file + ' with fs_write (it is checked when written).', check: () => (fs.existsSync(abs) && fs.statSync(abs).mtimeMs > before ? { want: 1, have: 1, missing: [] } : { want: 1, have: 0, missing: [file] }) };
    const r = await runAgent(engine, { agentKey: def.agent, job: store.getJob(id), step, pass: 1, folder: dir, folderLabel: k === 'coo' ? 'the COO\'s reports folder (products/station/reports: metrics-<day>.json from the engine, your reports <day>.md)' : 'the CEO\'s memos folder (products/station/memos: inputs-<week>.json from the engine, your memos <week>.md, proposal-marks.jsonl: the owner\'s marks)', input, line: job.line, runCapUsd: null, stopSignal: signal, contract, exec, validators, writes: [file] });
    const stop = kit.stopFrom(r, cfg.agents[def.agent].name);
    store.closeStage(sid2, stop ? (stop.stopped ? 'stopped' : stop.incomplete ? 'incomplete' : 'blocked') : 'done', stop ? stop.stopped || stop.blocked || stop.incomplete : file + ' written');
    if (pauses.length) store.updateJob(id, { data: { pauses } });
    if (stop) { if (stop.stopped) return kit.setJob(id, { state: 'stopped', reason: stop.stopped, ended_at: now() }, 'job.stopped'); return kit.block(store.getJob(id), stop.blocked || stop.incomplete, { state: stop.incomplete ? 'incomplete' : 'blocked' }); }
    // the record as written, checked once more (it was checked on write; a file changed outside the run is caught here)
    const text = readText(abs) || '';
    if (k === 'coo') {
      const probs = reportProblems(text, { day: inputs.day, metrics: inputs }); if (probs.length) return kit.block(store.getJob(id), file + ' does not hold: ' + probs.join('; '));
      bus.emit('exec.report', { jobId: id, agentKey: 'coo', data: { day: inputs.day, file: EXECS.coo.dir + '/' + file, breaches: inputs.breaches.length, pauses: pauses.length } });
      return kit.setJob(id, { state: 'done', reason: 'report ' + file + ' written; ' + inputs.breaches.length + ' breach(es), ' + pauses.length + ' line(s) paused', ended_at: now(), data: { report: file, costUsd: ledger.spent.job(id) } }, 'job.stage', { step: 'done' });
    }
    const m = parseMemo(text, { week: inputs.week, products: activeProducts() }); if (!m.ok) return kit.block(store.getJob(id), file + ' does not hold: ' + m.problems.join('; '));
    bus.emit('exec.memo', { jobId: id, agentKey: 'ceo', data: { week: inputs.week, file: EXECS.ceo.dir + '/' + file, proposals: m.proposals.length } });
    return kit.setJob(id, { state: 'done', reason: 'memo ' + file + ' written; ' + m.proposals.length + ' proposal(s) for the owner (documents, not requests)', ended_at: now(), data: { memo: file, proposals: m.proposals.map((p) => p.id), costUsd: ledger.spent.job(id) } }, 'job.stage', { step: 'done' });
  }

  // ---- the COO's line_pause: only for a breach the day's metrics list, only one of that breach's lines; the pause itself is actions.mjs's
  // (the locked rule coo-pause-only and the policy are checked there again)
  function pauseFor(jobId, metrics, pauses, { line, breach, reason }) {
    const b = (metrics.breaches || []).find((x) => x.id === String(breach || '').trim());
    if (!b) throw refuse('line_pause refused: "' + breach + '" is not a breach in ' + 'metrics-' + metrics.day + '.json (' + ((metrics.breaches || []).map((x) => x.id).join(', ') || 'there is none today') + '); a line is paused only on a budget or error breach', 'TOOL');
    if (!b.lines.includes(line)) throw refuse('line_pause refused: breach ' + b.id + ' (' + b.text + ') covers the lines ' + b.lines.join(', ') + ', not ' + line, 'TOOL');
    if (engine.actions.paused(line)) throw refuse('line_pause: the ' + line + ' line is already paused', 'TOOL');
    const why = String(reason || '').trim(); if (why.length < 10) throw refuse('line_pause needs a reason of at least 10 characters (what the breach is, in your words)', 'TOOL');
    try { engine.actions.pauseLine(line, { actor: { kind: 'agent', key: 'coo' }, reason: why.slice(0, 400) + ' (breach ' + b.id + ': ' + b.text + '; job ' + jobId + ')' }); }
    catch (e) { if (e instanceof PolicyRefusal || e instanceof LockedRefusal) throw e; throw refuse('line_pause refused: ' + e.message, 'TOOL'); }
    pauses.push({ line, breach: b.id, at: new Date(now()).toISOString() });
    return 'paused the ' + line + ' line (breach ' + b.id + '). It stays paused until the owner resumes it on the page. Say so under ## Pauses.';
  }

  // ---- the owner's mark on a proposal: taken, declined or later, with optional words (a note: it approves or starts nothing)
  function markProposal({ week, proposal, mark, words = '' } = {}, { actor } = {}) {
    if (!owner(actor)) throw refuse('marking a proposal is the owner\'s, on the page', 'LOCKED');
    const w = String(week || ''), p = String(proposal || ''), mk = String(mark || ''), note = String(words || '').trim();
    if (!/^\d{4}-W\d{2}(-\d+)?$/.test(w)) throw refuse('week must be a memo name such as 2026-W44', 'BAD_REQUEST');
    if (!MARKS.includes(mk)) throw refuse('mark must be one of ' + MARKS.join(', '), 'BAD_REQUEST');
    if (note.length > 500) throw refuse('your words: at most 500 characters', 'BAD_REQUEST');
    const text = readText(path.join(dirOf('ceo'), w + '.md')); if (text == null) throw refuse('no memo ' + w, 'BAD_REQUEST');
    const pr = parseMemo(text, {}).proposals.find((x) => x.id === p); if (!pr) throw refuse('memo ' + w + ' has no proposal ' + p, 'BAD_REQUEST');
    const rec = { at: new Date(now()).toISOString(), week: w, proposal: p, title: pr.title, mark: mk, words: note || null, by: 'owner (office)', note: 'a note on a document: it approves, starts or changes nothing' };
    J.add(marksFile(dirOf('ceo')), JSON.stringify(rec) + '\n', { fsync: true });
    log.info('proposal marked by the owner', { week: w, proposal: p, mark: mk });
    bus.emit('proposal.marked', { data: { week: w, proposal: p, mark: mk } });
    return rec;
  }

  // ---- the Owner's office: the latest report and memo (capped), the proposals with the owner's marks, the recent jobs
  function view({ maxChars = 16000 } = {}) {
    const list = (k, re) => { const d = dirOf(k); return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => re.test(n)).map((n) => n.slice(0, -3)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : []; };
    const who = (k) => { const a = cfg.agents[EXECS[k].agent] || {}, st = a.status || null; return { agent: EXECS[k].agent, name: a.name || k, status: st, onDuty: st === 'active' ? effectiveAgent(engine, EXECS[k].agent).enabled : false, canStart: startProblems(k), estimateUsd: ((cfg.lines[EXECS[k].line] || {}).estimateUsd || {}).job ?? null, routine: (store.listRoutines().find((r) => r.target === 'agent:' + EXECS[k].agent) || null) }; };
    const days = list('coo', /^\d{4}-\d{2}-\d{2}(-\d+)?\.md$/), weeks = list('ceo', /^\d{4}-W\d{2}(-\d+)?\.md$/);
    const lastDay = days[days.length - 1] || null, lastWeek = weeks[weeks.length - 1] || null;
    const metrics = lastDay ? readJson(path.join(dirOf('coo'), 'metrics-' + lastDay + '.json')) : null;
    const memoText = lastWeek ? readText(path.join(dirOf('ceo'), lastWeek + '.md')) : null, marks = latestMarks(dirOf('ceo'));
    const proposals = memoText ? parseMemo(memoText, {}).proposals.map((p) => ({ ...p, mark: marks[lastWeek + '/' + p.id] || null })) : [];
    const jobs = store.listJobs().filter((j) => EXEC_KINDS.includes(j.kind)).slice(0, 10).map((j) => ({ id: j.id, kind: j.kind, title: j.title, state: j.state, step: j.step, reason: j.reason, version: j.version, costUsd: ledger.spent.job(j.id), updatedAt: j.updated_at, running: E.isActive(j.id) }));
    const rv = (r) => (r ? { id: r.id, name: r.name, enabled: !!r.enabled, schedule: r.schedule, lastFireAt: r.last_fire_at || null, lastStatus: r.last_status || null, version: r.version } : null);
    const coo = who('coo'), ceo = who('ceo');
    return {
      coo: { ...coo, routine: rv(coo.routine), latest: lastDay ? { day: lastDay, text: clip(readText(path.join(dirOf('coo'), lastDay + '.md')), maxChars), breaches: metrics ? metrics.breaches : [], paused: metrics ? metrics.paused : [] } : null, days: days.slice(-14) },
      ceo: { ...ceo, routine: rv(ceo.routine), latest: lastWeek ? { week: lastWeek, text: clip(memoText, maxChars), proposals } : null, weeks: weeks.slice(-12) },
      jobs
    };
  }
  // one record (an older report or memo) for the Owner's office
  function record(k, name) {
    const re = k === 'coo' ? /^\d{4}-\d{2}-\d{2}(-\d+)?$/ : /^\d{4}-W\d{2}(-\d+)?$/;
    if (!EXECS[k] || !re.test(String(name || ''))) return null;
    const text = readText(path.join(dirOf(k), name + '.md')); if (text == null) return null;
    const marks = latestMarks(dirOf('ceo'));
    return { kind: k, name, text: clip(text, 40000), ...(k === 'ceo' ? { proposals: parseMemo(text, {}).proposals.map((p) => ({ ...p, mark: marks[name + '/' + p.id] || null })) } : {}) };
  }

  for (const k of Object.keys(EXECS)) E.addRunner(EXECS[k].kind, run);
  return { start, startProblems, markProposal, view, record, kinds: EXECS, lineOf: (k) => (EXECS[k] ? EXECS[k].line : null) };
}
