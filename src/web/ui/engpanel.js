// ui/engpanel.js — R2c: the Engineering panel (an overlay, from the whole-building view G, the Floors menu F and the Owner's office). It
// reads GET /api/eng/view and /api/eng/job/<id> with the owner's page session, and every click goes through ctl (controls.js): the action
// token, an idempotency key, the job version the page loaded, and for anything that can spend (triage, start, resume, rework) the spend
// confirmation first. The HTML is ui/eng-view.js (escaped text only). The server and the engine check every action again: owner only.
import { esc } from './format.js';
import { panelHtml, jobHtml } from './eng-view.js';

export function createEngPanel({ root, ctl }) {
  const body = root.querySelector('#eng-body');
  let view = null, jobId = null, detail = null, seq = 0;
  const get = async (p) => { const s = await ctl.session(); const r = await fetch(p, { headers: { 'x-station-action': s.actionToken }, cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; };
  async function refresh() {
    if (!isOpen()) return;
    const my = ++seq;
    try {
      const v = await get('/api/eng/view'), d = jobId ? await get('/api/eng/job/' + encodeURIComponent(jobId)) : null;
      if (my !== seq) return;
      view = v; detail = d; render();
    } catch (e) { if (my === seq) body.innerHTML = '<div class="bldg-total eng-why">Not loaded: ' + esc(e.message) + '</div>'; }
  }
  function render() { body.innerHTML = jobId ? jobHtml(detail) : panelHtml(view); }
  const product = () => (view && view.products && view.products[0]) || null;
  const words = async (title, intro, label, { danger = false, confirm = 'OK', rows = 3, hint = '' } = {}) => { const v = await ctl.dialog({ title, intro, fields: [{ name: 'w', label, type: 'textarea', required: true, rows, hint }], confirm, danger }); return v ? v.w.trim() : null; };

  async function newIssue(pid) {
    const models = [...new Set(((view && view.agents) || []).map((a) => a.model).filter(Boolean))].join(', ');
    const v = await ctl.dialog({ title: 'New issue · ' + ((product() || {}).name || pid), intro: 'Saving an issue costs nothing. You approve it next; the CTO orders approved issues; Start is the paid step.',
      fields: [{ name: 'title', label: 'Title', required: true, placeholder: 'e.g. The reply preview cuts off long reviews' },
        { name: 'happens', label: 'What happens', type: 'textarea', required: true, rows: 3 },
        { name: 'should', label: 'What should happen', type: 'textarea', required: true, rows: 3 },
        { name: 'where', label: 'Where', placeholder: 'page, file or flow, e.g. app.py /reply' },
        { name: 'acceptance', label: 'Acceptance criteria (one per line)', type: 'textarea', rows: 3, hint: 'TECH-LEAD turns these into AC1, AC2 … in the spec' },
        { name: 'model', label: 'Model', type: 'select', value: 'default', options: [{ value: 'default', label: 'Default: the line\'s configured models (' + (models || 'Sonnet') + ')' }, { value: 'opus', label: 'Opus: refused until it is priced from Anthropic\'s official page' }] }],
      confirm: 'Save the issue' });
    if (!v) return;
    await ctl.act('/api/eng/issue', { productId: pid, title: v.title.trim(), happens: v.happens, should: v.should, where: v.where, acceptance: v.acceptance, model: v.model }, { ok: (r) => 'Issue saved: ' + (r && r.issueId) });
  }
  async function issueDecision(pid, id, decision) {
    const label = { approve: 'Approve', reject: 'Reject', withdraw: 'Withdraw' }[decision];
    const w = await words(label + ' this issue', '<span class="mono">' + esc(id) + '</span><br>' + (decision === 'approve' ? 'Approves the issue as it reads now; an edit later needs your approval again. Nothing runs yet.' : 'Nothing runs.'), 'Your words (logged with the decision)', { danger: decision !== 'approve', confirm: label });
    if (w) await ctl.act('/api/eng/issue-decide', { productId: pid, issueId: id, decision, words: w }, { ok: label + 'd: ' + id });
  }
  async function stop(id, version) {
    const ok = await ctl.dialog({ title: 'Stop this job', intro: '<span class="mono">' + esc(id) + '</span><br>The running step is stopped now: a model call in flight is aborted, a check container is killed. Nothing half-written is kept; you can resume or archive the job afterwards.', confirm: 'Stop', danger: true });
    if (ok) await ctl.act('/api/eng/stop', { jobId: id, expectedVersion: version }, { ok: 'Stopping ' + id });
  }
  async function decide(id, decision, version) {
    if (decision === 'rework') {
      const w = await words('Rework with notes', '<span class="mono">' + esc(id) + '</span><br>DEVELOPER gets your notes on the same branch; then the checks, TESTER, REVIEWER and SECURITY again and a new merge request. It runs inside what is left of the job cap; the next step shows the spend.', 'Your notes for DEVELOPER (logged)', { rows: 4, confirm: 'Next: the spend' });
      if (w) await ctl.spendAct('eng-rework', '/api/eng/decide', { jobId: id, decision, words: w, expectedVersion: version }, { ok: 'Rework started: ' + id });
      return;
    }
    const approve = decision === 'approve';
    const w = await words(approve ? 'Approve this merge request' : 'Reject this merge request', '<span class="mono">' + esc(id) + '</span><br>' + (approve ? 'Marks the branch ready and shows the pull command. The engine never merges or pushes: you pull, merge, push and deploy by hand. The branch and the diff are checked again first.' : 'The job ends rejected by you; the branch stays in the Station\'s mirror.'), approve ? 'Your words (logged)' : 'Your reason (logged)', { danger: !approve, confirm: approve ? 'Approve' : 'Reject' });
    if (w) await ctl.act('/api/eng/decide', { jobId: id, decision, words: w, expectedVersion: version }, { ok: approve ? 'Approved: the pull command is in the job' : 'Rejected: ' + id });
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); ctl.toast('Pull command copied'); }
    catch (_) { const el = body.querySelector('[data-pull]'); if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } ctl.toast('Selected: copy it with Ctrl+C'); }
  }
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const d = b.dataset, v = d.version == null ? null : Number(d.version);
    if (d.engNew) newIssue(d.engNew);
    else if (d.engTriage) ctl.spendAct('eng-triage', '/api/eng/triage', { productId: d.engTriage }, { ok: 'CTO triage started' });
    else if (d.engIssue) issueDecision(d.product, d.engIssue, d.decision);
    else if (d.engStart) ctl.spendAct('eng-start', '/api/eng/start', { productId: d.product, issueId: d.engStart }, { ok: (r) => 'Started: ' + (r && r.jobId) });
    else if (d.engJob) open(d.engJob);
    else if (b.hasAttribute('data-eng-back')) open(null);
    else if (d.engStop) stop(d.engStop, v);
    else if (d.engResume) ctl.spendAct('restart', '/api/eng/resume', { jobId: d.engResume, expectedVersion: v }, { ok: 'Resumed: ' + d.engResume });
    else if (d.engArchive) ctl.dialog({ title: 'Archive this job', intro: 'Its worktree is removed; the branch and the job folder stay.', confirm: 'Archive' }).then((ok) => ok && ctl.act('/api/eng/archive', { jobId: d.engArchive, expectedVersion: v }, { ok: 'Archived: ' + d.engArchive }));
    else if (d.engDecide) decide(d.engDecide, d.decision, v);
    else if (d.engCopy) copy(d.engCopy);
  });
  function open(id = null) { jobId = id; detail = null; root.classList.remove('hidden'); render(); refresh(); }
  function isOpen() { return !root.classList.contains('hidden'); }
  // R7a.2: the right-hand panel's New issue (on Engineering): the panel, then its issue form for the product (the first, as the panel's own)
  async function newIssueForm() { open(null); await refresh(); const p = product(); if (p) await newIssue(p.id); else ctl.toast('No engineering product to file an issue for.', 'err'); }
  return { open, refresh, newIssue: newIssueForm, rework: (id) => { open(id); return get('/api/eng/job/' + encodeURIComponent(id)).then((d) => decide(id, 'rework', d.job.version)).catch(() => {}); }, show: () => open(jobId), hide: () => root.classList.add('hidden'), isOpen, current: () => jobId };
}
