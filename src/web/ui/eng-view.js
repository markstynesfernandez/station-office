// ui/eng-view.js — R2c: the Engineering panel's HTML (pure: tests/r2c-controls.test.mjs renders it in Node). Everything that comes from an
// issue, a spec, an agent, a check log or a diff is text: it goes through esc() and is never markup, so a diff holding <script> shows as
// the characters it is. The panel's clicks are wired in ui/engpanel.js; the server checks every action again (owner only).
import { esc, money, dateTime } from './format.js';

const usd = (n) => money(n);
const STATE = { draft: 'draft: waiting for your approval', approved: 'approved by you', stale: 'edited after approval: approve again', rejected: 'rejected', withdrawn: 'withdrawn' };
const JOB_STATE = { queued: 'queued', running: 'running', approval: 'waiting for you', approved: 'approved: ready to pull', blocked: 'blocked', stopped: 'stopped', incomplete: 'incomplete', rejected: 'rejected by an agent', rejected_by_owner: 'rejected by you', archived: 'archived', done: 'done' };
const tone = (s) => (['approved', 'done'].includes(s) ? 'ok' : ['blocked', 'rejected', 'rejected_by_owner'].includes(s) ? 'err' : ['approval', 'draft', 'stale', 'stopped', 'incomplete'].includes(s) ? 'warn' : '');
const tag = (text, t = '') => '<span class="tag' + (t ? ' tag-' + t : '') + '">' + esc(text) + '</span>';
const btn = (label, attrs, cls = '') => '<button class="btn btn-mini' + (cls ? ' ' + cls : '') + '" ' + attrs + '>' + esc(label) + '</button>';
const data = (o) => Object.entries(o).map(([k, v]) => 'data-' + k + '="' + esc(v) + '"').join(' ');
const when = (ms) => (ms ? dateTime(ms) : '');
const verdictTone = (v) => (v === 'pass' || v === 'approve' ? 'ok' : v === 'refuse' || v === 'fail' ? 'err' : 'warn');

// a unified diff, read only: one line each, coloured by its first character; every character escaped
export function diffHtml(patch, { maxLines = 6000 } = {}) {
  const lines = String(patch || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return '<div class="muted">no diff</div>';
  const cls = (l) => (l.startsWith('diff --git') ? 'dl-file' : l.startsWith('@@') ? 'dl-hunk' : l.startsWith('+++') || l.startsWith('---') || /^(index|new file|deleted file|similarity|rename|old mode|new mode|GIT binary patch)/.test(l) ? 'dl-meta' : l.startsWith('+') ? 'dl-add' : l.startsWith('-') ? 'dl-del' : 'dl-ctx');
  const shown = lines.slice(0, maxLines);
  return '<pre class="eng-diff">' + shown.map((l) => '<span class="dl ' + cls(l) + '">' + esc(l) + '</span>').join('\n') + '</pre>'
    + (lines.length > maxLines ? '<div class="muted">… ' + (lines.length - maxLines) + ' more lines in diff.patch in the job folder</div>' : '');
}
// a text output (issue, spec, notes, a check log), read only
export const textHtml = (t) => (t == null || t === '' ? '<div class="muted">none yet</div>' : '<pre class="eng-text">' + esc(t) + '</pre>');
// the command the owner runs in their own clone (the engine never pushes): exactly the engine's pull command, then the checkout
export function pullHtml(d) {
  return '<div class="eng-pull"><div class="muted">In your ReplyDesk checkout (the branch comes from the Station\'s mirror; nothing was pushed):</div>'
    + '<pre class="eng-cmd" data-pull>' + esc(d.pull) + '</pre>'
    + '<div class="fl-stats">' + btn('Copy the pull command', data({ 'eng-copy': d.pull })) + '<span class="muted">then <span class="mono">git checkout ' + esc(d.branch) + '</span> to read it; merge, push and deploy are yours, by hand</span></div></div>';
}

// ---- the line: the product's summary, its issues and its jobs
export function panelHtml(v) {
  if (!v || !v.products) return '<div class="muted">loading…</div>';
  const agents = (v.agents || []).map((a) => esc(a.name) + ' <span class="mono muted">' + esc(a.model || '?') + '</span>' + (a.status !== 'active' ? tag(a.status || 'not hired', 'warn') : a.onDuty ? '' : tag('off duty', 'warn'))).join(' · ');
  return (v.halted ? '<div class="bldg-total eng-halt">E-STOP is on: nothing starts until you resume (top bar).</div>' : '')
    + v.products.map((p) => productHtml(p, v)).join('')
    + '<h3 class="eng-h">The line\'s agents</h3><div class="bldg-total muted">' + agents + '</div>';
}
function productHtml(p, v) {
  const b = p.budget || {}, ln = p.line || {};
  const approved = p.issues.filter((i) => i.state === 'approved');
  return '<div class="bldg-floor eng-sum" style="cursor:default"><span class="fl-num">' + (ln.state === 'running' ? '▶' : '·') + '</span><span>'
    + '<span class="fl-name">' + esc(p.name) + '</span> ' + tag('engineering line ' + (ln.state || 'idle'), ln.state === 'running' ? 'ok' : '') + (ln.hold ? tag(ln.hold, 'warn') : '') + (v.mock ? tag('mock provider: $0', '') : tag('LIVE provider', 'warn'))
    + '<div class="fl-stats"><span><span class="m">this month</span> ' + usd(b.spentUsd) + ' of ' + usd(b.budgetUsd) + ' budget · left ' + usd(b.leftUsd) + '</span><span><span class="m">job cap</span> ' + usd(p.jobCapUsd) + ' a job</span>'
    + '<span><span class="m">repo</span> ' + (p.repoEnvSet ? esc(p.repo || p.id) : '<b>' + esc(p.repoEnv) + ' is not set</b>') + '</span><span><span class="m">checks</span> ' + esc(p.runChecks.join(', ') || 'none') + ' (Docker, no network)</span>'
    + ((ln.waitingForYou || []).length ? '<span><span class="m">waiting for you</span> ' + ln.waitingForYou.length + '</span>' : '') + '</div></span></div>'
    + '<h3 class="eng-h">Issues <span class="eng-acts">' + btn('New issue…', data({ 'eng-new': p.id }), 'btn-ok') + btn('CTO triage…', data({ 'eng-triage': p.id }) + (approved.length ? '' : ' disabled title="approve an issue first"')) + '</span></h3>'
    + '<div class="muted eng-help">Write an issue (free), approve it (free), let the CTO order the approved issues (a paid run, with its confirmation), then start the job (a paid run, with its confirmation). TECH-LEAD writes the spec as the job\'s first step.</div>'
    + (p.issues.length ? p.issues.slice().reverse().map((i) => issueHtml(p, i)).join('') : '<div class="muted">No issue yet.</div>')
    + '<h3 class="eng-h">Jobs</h3>' + (p.jobs.length ? p.jobs.map((j) => jobRow(j)).join('') : '<div class="muted">No job yet.</div>');
}
function issueHtml(p, i) {
  const t = i.triage, acts = [];
  if (i.state === 'draft' || i.state === 'stale') acts.push(btn('Approve…', data({ 'eng-issue': i.id, decision: 'approve', product: p.id }), 'btn-ok'), btn('Reject…', data({ 'eng-issue': i.id, decision: 'reject', product: p.id }), 'btn-danger'));
  if (i.state === 'approved') {
    if (!(i.startProblems || []).length) acts.push(btn('Start…', data({ 'eng-start': i.id, product: p.id }), 'btn-primary'));
    acts.push(btn('Withdraw…', data({ 'eng-issue': i.id, decision: 'withdraw', product: p.id })));
  }
  return '<div class="bldg-floor eng-issue" style="cursor:default"><span class="fl-num" style="font-size:11px">' + (t ? '#' + esc(t.order) : '–') + '</span><span>'
    + '<span class="fl-name">' + esc(i.title) + '</span> ' + tag(STATE[i.state] || i.state, tone(i.state)) + (i.model !== 'default' ? tag('model ' + i.model, 'warn') : '')
    + '<div class="muted" style="font-size:11px"><span class="mono">' + esc(i.id) + '</span>' + (i.words ? ' · your words: “' + esc(i.words) + '”' : '') + '</div>'
    + (t ? '<div style="font-size:11.5px">CTO triage: <b>#' + esc(t.order) + '</b> · size ' + esc(t.size) + (t.note ? ' · ' + esc(t.note) : '') + '</div>' : i.state === 'approved' ? '<div class="muted" style="font-size:11.5px">not triaged yet: run the CTO triage</div>' : '')
    + ((i.startProblems || []).length ? '<div class="eng-why">' + i.startProblems.map((x) => '<div>✕ ' + esc(x) + '</div>').join('') + '</div>' : '')
    + (acts.length ? '<div class="fl-stats">' + acts.join('') + '</div>' : '') + '</span></div>';
}
function jobRow(j) {
  const live = j.running || j.state === 'running' || j.state === 'queued';
  return '<div class="bldg-floor eng-job" style="cursor:default"><span class="fl-num" style="font-size:11px">' + (j.kind === 'eng-triage' ? 'CTO' : 'job') + '</span><span>'
    + '<span class="fl-name">' + esc(j.title || j.id) + '</span> ' + tag(JOB_STATE[j.state] || j.state, tone(j.state)) + (j.step ? ' <span class="muted">at ' + esc(j.step) + '</span>' : '')
    + '<div class="muted" style="font-size:11px"><span class="mono">' + esc(j.id) + '</span>' + (j.branch ? ' · <span class="mono">' + esc(j.branch) + '</span>' : '') + ' · ' + usd(j.costUsd) + (j.capUsd != null ? ' of ' + usd(j.capUsd) + ' cap' : '') + (j.reason ? ' · ' + esc(j.reason) : '') + '</div>'
    + '<div class="fl-stats">' + btn('Open', data({ 'eng-job': j.id })) + (live ? btn('Stop…', data({ 'eng-stop': j.id, version: j.version }), 'btn-danger') : '') + '</div></span></div>';
}

// ---- one job: its steps, outputs, checks, diff, verdicts, cost against the cap, and the owner's decision
export function jobHtml(d) {
  if (!d || !d.job) return '<div class="muted">loading…</div>';
  const j = d.job, eng = j.kind === 'engineering', live = j.running || j.state === 'running' || j.state === 'queued';
  const cap = d.capUsd != null ? d.capUsd : j.capUsd, cost = d.costUsd != null ? d.costUsd : j.costUsd, pct = cap ? Math.min(100, Math.round((cost || 0) / cap * 100)) : 0;
  const acts = [];
  if (live) acts.push(btn('Stop…', data({ 'eng-stop': j.id, version: j.version }), 'btn-danger'));
  if (['stopped', 'blocked', 'incomplete'].includes(j.state) && !j.running && !(eng && d.canRework)) acts.push(btn('Resume…', data({ 'eng-resume': j.id, version: j.version })));
  if (!live && !['approval', 'archived'].includes(j.state)) acts.push(btn('Archive…', data({ 'eng-archive': j.id, version: j.version })));
  return '<div class="eng-back">' + btn('← all of the line', 'data-eng-back') + '</div>'
    + '<div class="bldg-floor" style="cursor:default"><span class="fl-num" style="font-size:11px">' + (eng ? 'job' : 'CTO') + '</span><span>'
    + '<span class="fl-name">' + esc(j.title || j.id) + '</span> ' + tag(JOB_STATE[j.state] || j.state, tone(j.state)) + (j.step ? ' <span class="muted">at ' + esc(j.step) + '</span>' : '')
    + '<div class="muted" style="font-size:11px"><span class="mono">' + esc(j.id) + '</span>' + (d.branch ? ' · branch <span class="mono">' + esc(d.branch) + '</span>' : '') + (j.issueId ? ' · issue <span class="mono">' + esc(j.issueId) + '</span>' : '') + '</div>'
    + (j.reason ? '<div style="font-size:12px">' + esc(j.reason) + '</div>' : '')
    + '<div class="fl-stats"><span><span class="m">cost so far</span> ' + usd(cost) + (cap != null ? ' of the ' + usd(cap) + ' cap <span class="meter meter-' + (pct >= 100 ? 'hit' : pct >= 80 ? 'warn' : 'ok') + '"><i style="width:' + pct + '%"></i></span>' : '') + '</span>' + acts.join('') + '</div></span></div>'
    + (eng ? decisionHtml(d) : '')
    + section('Steps', stepsHtml(d.steps || []), true)
    + (eng ? section('Checks (pytest in the sandbox: Docker, no network)', checksHtml(d.checks), true)
      + section('Verdicts', verdictsHtml(d.verdicts || []), true)
      + section('Diff (read only)' + (d.files && d.files.files ? ' · ' + d.files.files.length + ' file' + (d.files.files.length === 1 ? '' : 's') : ''), diffHtml(d.diff), true)
      + section('Spec (TECH-LEAD)', textHtml(d.spec), false) + section('Notes (DEVELOPER)', textHtml(d.notes), false) + section('Issue', textHtml(d.issue), false)
      + ((d.otherRequests || []).length ? section('Other requests from this diff', d.otherRequests.map((r) => '<div>' + tag(r.action) + ' ' + esc(r.summary) + ' ' + tag(r.status, tone(r.status === 'pending' ? 'approval' : r.status)) + '</div>').join(''), true) : '')
      + ((d.decisions || []).length ? section('Your decisions on this job', d.decisions.map((x) => '<div><span class="mono">' + esc(String(x.at || '').slice(0, 16).replace('T', ' ')) + '</span> ' + tag(x.decision) + ' ' + esc(x.words || '') + (x.commit ? ' <span class="muted mono">' + esc(String(x.commit).slice(0, 10)) + '</span>' : '') + '</div>').join(''), true) : '')
      : section('The CTO\'s queue', textHtml(d.triage && d.triage.queue ? JSON.stringify(d.triage.queue, null, 2) : null), true));
}
const section = (title, body, open) => '<details class="eng-sec"' + (open ? ' open' : '') + '><summary>' + esc(title) + '</summary>' + body + '</details>';

function decisionHtml(d) {
  const j = d.job, m = d.merge, a = d.approval;
  if (j.state === 'approval' && m && m.status === 'pending') {
    return '<div class="eng-decide"><b>Waiting for you: merge request <span class="mono">' + esc(m.id) + '</span></b> · payload <span class="mono">' + esc(String(m.payloadSha256 || '').slice(0, 12)) + '</span>'
      + (a && !a.holds ? '<div class="eng-why">✕ ' + esc(a.why) + '</div>' : '')
      + '<div class="muted" style="font-size:12px">Approve marks ' + esc(d.branch) + ' ready and shows the pull command. Rework sends your notes to DEVELOPER on the same branch, inside the job cap. Reject ends the job. A diff change after approval voids it.</div>'
      + '<div class="fl-stats">' + btn('Approve…', data({ 'eng-decide': j.id, decision: 'approve', version: j.version }), 'btn-ok') + btn('Rework with notes…', data({ 'eng-decide': j.id, decision: 'rework', version: j.version })) + btn('Reject…', data({ 'eng-decide': j.id, decision: 'reject', version: j.version }), 'btn-danger') + '</div></div>';
  }
  if (j.state === 'approved') {
    return '<div class="eng-decide eng-ready">' + (d.ready ? '<b>Approved: ' + esc(d.branch) + ' is ready to pull</b>' + (m && m.words ? ' · your words: “' + esc(m.words) + '”' : '') + pullHtml(d) : '<b>Approved, but not ready</b><div class="eng-why">✕ ' + esc((a && a.why) || 'the approval could not be checked') + '</div>')
      + (d.canRework ? '<div class="fl-stats">' + btn('Rework with notes…', data({ 'eng-decide': j.id, decision: 'rework', version: j.version })) + '<span class="muted">a rework voids this approval</span></div>' : '') + '</div>';
  }
  if (j.state === 'blocked' && d.canRework) return '<div class="eng-decide"><b>Your approval was voided</b><div class="fl-stats">' + btn('Rework with notes…', data({ 'eng-decide': j.id, decision: 'rework', version: j.version })) + '</div></div>';
  return '';
}
function stepsHtml(steps) {
  if (!steps.length) return '<div class="muted">no step yet</div>';
  return '<table class="eng-steps"><tr><th>step</th><th>pass</th><th>who</th><th>status</th><th>outcome</th><th>ended</th></tr>' + steps.map((s) => '<tr><td class="mono">' + esc(s.step) + '</td><td>' + esc(s.pass) + '</td><td>' + esc(s.agentName || 'engine') + '</td><td>' + tag(s.status, s.status === 'done' ? 'ok' : s.status === 'running' ? '' : 'warn') + '</td><td>' + esc(s.note || '') + '</td><td class="muted">' + esc(when(s.endedAt)) + '</td></tr>').join('') + '</table>';
}
function checksHtml(c) {
  if (!c || !c.results) return '<div class="muted">no checks yet</div>';
  return '<div class="muted" style="font-size:11.5px">pass ' + esc(c.pass) + ' · image <span class="mono">' + esc(c.image || '') + '</span> · ' + esc(String(c.at || '').slice(0, 16).replace('T', ' ')) + '</div>'
    + c.results.map((r) => '<div>' + tag(r.passed ? 'passed' : r.timedOut ? 'timed out' : 'failed', r.passed ? 'ok' : 'err') + ' <b>' + esc(r.check) + '</b> <span class="mono muted">' + esc((r.argv || []).join(' ')) + '</span> · exit ' + esc(r.exitCode) + ' · ' + esc(Math.round((r.durationMs || 0) / 100) / 10) + ' s</div>').join('')
    + (c.logs || []).map((l) => section('log: ' + l.check, textHtml(l.log), false)).join('');
}
function verdictsHtml(vs) {
  if (!vs.length) return '<div class="muted">no verdict yet</div>';
  return vs.map((v) => '<div class="eng-verdict"><b>' + esc(v.agent || v.step) + '</b> ' + tag(v.verdict, verdictTone(v.verdict)) + (v.dependencyVerdict ? ' ' + tag('dependencies: ' + v.dependencyVerdict, verdictTone(v.dependencyVerdict)) : '') + ' <span class="muted">pass ' + esc(v.pass) + '</span>'
    + (v.summary ? '<div>' + esc(v.summary) + '</div>' : '')
    + (v.checks ? '<div class="muted">checks: ' + Object.entries(v.checks).map(([k, x]) => esc(k) + ' ' + esc(x)).join(', ') + (v.criteria ? ' · criteria: ' + Object.entries(v.criteria).map(([k, x]) => esc(k) + ' ' + esc(x)).join(', ') : '') + '</div>' : '')
    + ((v.findings || []).length ? '<ol class="eng-find">' + v.findings.map((f) => '<li>' + (f.file ? '<span class="mono">' + esc(f.file + (f.line ? ':' + f.line : '')) + '</span> ' : '') + (f.severity ? tag(f.severity, f.severity === 'blocker' ? 'err' : 'warn') + ' ' : '') + esc(f.text) + '</li>').join('') + '</ol>' : '') + '</div>').join('');
}
