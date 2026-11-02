// ui/sidepanel.js — the slide-in panel for a desk (agent: role, model, recent jobs, outputs, costs, latest design) or a
// job. Model, provider and role come from the roster; the system prompt is never sent to the page, and a prompt-like
// role is shown as a short label (ui/role.js; R2).
// E5 (engine mode): the desk panel sets on/off duty, tier and effort (from the lists in config/engine.json; applies at
// the next run, no restart); the job panel offers Stop, Restart, Archive, Re-run listing and, in the approval queue,
// Approve, Reject (reason required) and Mark published (date + Etsy URL). Prompts and caps are never editable here.
import { esc, money, price, when, duration, statusLabel, jobStatusLabel, statusPill, synthTag, legacyTag } from './format.js';
import { PALETTE } from '../config/palette.js';
import { roleLabel } from './role.js';
import { evidenceBanner } from './evidence.js';

export function createSidePanel({ root, onOpenJob, onOpenAgent, onClose = () => {}, getNow = () => Date.now(), getSnap = () => null, ctl = null }) {
  const body = root.querySelector('#sidepanel-body');
  let current = null, seq = 0;   // seq: only the newest request renders (refreshes can resolve out of order)
  function close() { root.classList.add('hidden'); current = null; seq++; onClose(); }   // seq++: a refresh in flight must not reopen it
  function open(html, keepScroll = false) { const y = root.scrollTop; body.innerHTML = html; root.classList.remove('hidden'); body.querySelector('.close')?.addEventListener('click', close); body.querySelectorAll('[data-job]').forEach((el) => el.addEventListener('click', () => onOpenJob(el.dataset.job))); body.querySelectorAll('[data-agent]').forEach((el) => el.addEventListener('click', () => onOpenAgent(el.dataset.agent))); root.scrollTop = keepScroll ? y : 0; }
  const live = () => { const s = getSnap(); return !!(ctl && s && s.controls && s.controls.live); };
  const halted = () => { const s = getSnap(); return !!(s && s.engine && s.engine.halted); };

  // ---- desk controls (agent): on/off duty, tier, effort
  function agentControls(a) {
    const s = getSnap(); if (!live() || !s) return '';
    const tiers = s.controls.tiers.map((t) => '<option value="' + esc(t.key) + '"' + (t.key === a.tier ? ' selected' : '') + '>' + esc(t.key + ' · ' + t.model) + '</option>').join('');
    const efforts = s.controls.effortLevels.map((e) => '<option' + (e === a.effort ? ' selected' : '') + '>' + esc(e) + '</option>').join('');
    return '<h4>Desk controls</h4><div class="ctlbox" data-agent-ctl>'
      + '<label class="switch"><input type="checkbox" data-duty' + (a.enabled ? ' checked' : '') + '><span class="track"></span><span>' + (a.enabled ? 'on duty' : 'off duty') + '</span></label>'
      + '<div class="ctlrow"><label>Tier<select data-tier>' + tiers + '</select></label><label>Effort<select data-effort>' + efforts + '</select></label></div>'
      + '<div class="ctlrow end"><span class="srcnote">applies at the next run · no restart · off duty: its steps wait and its routines skip</span><button class="btn btn-primary" data-save-agent disabled>Save</button></div>'
      + '<div class="srcnote">tiers and effort levels from config/engine.json · prompts are edited as files only · caps in config only</div></div>';
  }
  function wireAgent(a) {
    const box = body.querySelector('[data-agent-ctl]'); if (!box) return;
    const duty = box.querySelector('[data-duty]'), tier = box.querySelector('[data-tier]'), effort = box.querySelector('[data-effort]'), save = box.querySelector('[data-save-agent]');
    const dirty = () => { save.disabled = duty.checked === a.enabled && tier.value === a.tier && effort.value === a.effort; duty.parentElement.querySelector('span:last-child').textContent = duty.checked ? 'on duty' : 'off duty'; };
    [duty, tier, effort].forEach((el) => el.addEventListener('change', dirty));
    save.addEventListener('click', async () => {
      const patch = {}; if (duty.checked !== a.enabled) patch.enabled = duty.checked; if (tier.value !== a.tier) patch.tier = tier.value; if (effort.value !== a.effort) patch.effort = effort.value;
      save.disabled = true;
      const send = patch.enabled === true ? (p, b, o) => ctl.spendAct('agent-on-duty', p, b, o) : (p, b, o) => ctl.act(p, b, o);
      const r = await send('/api/agents/update', { agentKey: a.id, expectedVersion: a.version, ...patch }, { ok: (x) => a.name + ': ' + (x.enabled ? 'on duty' : 'off duty') + ' · ' + x.tier + ' · effort ' + x.effort + ' (from the next run)' + (x.started && x.started.length ? '; ' + x.started.length + ' waiting job(s) started' : '') });
      if (r && still('agent', a.id)) showAgent(a.id, true); else if (!r) dirty();
    });
  }

  // ---- job controls
  function jobControls(j) {
    const c = j.controls || {}; if (!live() || !Object.values(c).some(Boolean)) return '';
    const b = (k, label, cls = '', title = '') => '<button class="btn ' + cls + '" data-jobact="' + k + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
    const appr = [c.approve && b('approve', 'Approve', 'btn-ok', 'records approved and the time; nothing is sent anywhere'), c.reject && b('reject', 'Reject…', 'btn-danger', 'a reason is required'), c.publish && b('publish', 'Mark published…', 'btn-primary', 'the date and the Etsy listing URL you published by hand')].filter(Boolean).join('');
    const job = [c.stop && b('stop', '■ Stop job', 'btn-danger', 'aborts this job\'s call in flight; nothing else stops'), c.restart && b('restart', '↻ Resume', 'btn-primary', 'runs on from the step it stopped at, within the caps (confirm the spend first)'), c.rerunListing && b('rerun', 'Re-run listing…', '', 'LISTER again on the QA-approved design'), c.archive && b('archive', 'Archive…', '', 'files move to rerun-archive-*, never deleted')].filter(Boolean).join('');
    return (appr ? '<div class="ctlbox approvalbox"><div class="ctlhead">Approval queue · your decision</div>' + evidenceBanner(j.evidenceLevel, { ownerSetsPrice: j.ownerSetsPrice === true }) + '<div class="btnrow">' + appr + '</div>'
      + (j.queue ? '<div class="pkg"><span class="m">package</span> <span class="mono" title="' + esc(j.queue.folderAbs || '') + '">data/' + esc(j.queue.folder) + '</span> <button class="btn btn-mini" data-copy="' + esc(j.queue.folderAbs || j.queue.folder) + '">copy path</button></div>' : '')
      + '<div class="srcnote">Approve sends nothing anywhere: the package folder is what you upload to Etsy by hand.</div></div>' : '')
      + (job ? '<div class="ctlbox"><div class="ctlhead">Job controls</div><div class="btnrow">' + job + '</div>' + (halted() ? '<div class="srcnote">E-STOP is on: Resume and Re-run listing are refused until you resume the engine.</div>' : '') + '</div>' : '')
      + steerBox(j);
  }
  // L2: steering a job from its panel: the owner's decision on file 1 (ownerFile1), an owner amendment, the set approved or rejected in the
  // owner's words. Region fixes stay on the command line for now (the command is shown)
  function steerBox(j) {
    const c = j.controls || {}; if (!live()) return '';
    const b = (k, label, cls = '', title = '') => '<button class="btn ' + cls + '" data-jobact="' + k + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
    const f1 = c.file1 && j.file1Review ? '<div class="ctlbox file1box"><div class="ctlhead">File 1 of set-v' + esc(c.file1.set) + ' · your decision (ownerFile1)</div>'
      + (j.file1Review.images.length ? '<div class="design">' + j.file1Review.images.map((im) => '<img src="' + esc(im.url) + '" alt="' + esc(im.file) + '" title="' + esc(im.file) + '">').join('') + '</div>' : '<div class="muted">no review images in set-v' + esc(c.file1.set) + '/review/</div>')
      + '<div class="btnrow">' + b('file1-approve', 'Approve file 1…', 'btn-ok', 'records your approval of file 1 as the style reference; then Resume draws the rest of the set') + b('file1-reject', 'Reject file 1…', 'btn-danger', 'file 1 is drawn again with your reason') + '</div>'
      + '<div class="srcnote">QA DESIGN passed it; the job waits for you. Resume after deciding (the spend is confirmed then).</div></div>' : '';
    const owner = [c.amend && b('amend', 'Amend brief…', '', 'a dated owner amendment: the frozen brief stays as it is; every agent reads the amendment from its next run'),
      c.setDecision && b('set-approve', 'Approve set-v' + c.setDecision.set + '…', 'btn-ok', 'your approval of the whole set in your words (needs your decision on every file first; originality and build warnings are never overridden)'),
      c.setDecision && b('set-reject', 'Reject set-v' + c.setDecision.set + '…', 'btn-danger', 'the job ends rejected with your words; nothing is deleted')].filter(Boolean).join('');
    // W4: the set buttons appear only when the approval would be accepted; otherwise one line says why
    const why = c.setDecisionNote ? '<div class="srcnote" data-set-note>' + esc(c.setDecisionNote) + '</div>' : '';
    const fix = c.fixTools ? '<div class="srcnote">Region fixes stay on the command line for now (stop the server first: one engine per data root): <span class="mono">npm run owner -- edit-set ' + esc(j.id) + ' --from &lt;plan.json&gt;</span>, then <span class="mono">npm run owner -- rebuild ' + esc(j.id) + ' --from &lt;args.json&gt;</span> (set-v' + esc(c.fixTools.set) + ').</div>' : '';
    return f1 + (owner || fix || why ? '<div class="ctlbox"><div class="ctlhead">Owner steering</div>' + (owner ? '<div class="btnrow">' + owner + '</div>' : '') + why + fix + '</div>' : '');
  }
  // L2: the live status of a job: stage, agent at work, spend so far against its cap, its last 5 events (re-rendered on every event)
  function liveBox(j, now) {
    const L = j.liveStatus; if (!L || !(L.running || j.next || (L.events && L.events.length))) return '';
    const pct = L.capUsd ? Math.min(100, Math.round(100 * (L.spendUsd || 0) / L.capUsd)) : 0;
    return '<div class="ctlbox livebox"><div class="ctlhead">' + (L.running ? '● Live' : j.next ? 'Next in the queue' : 'Latest') + ' · ' + esc(L.stage || '') + (L.agent ? ' · ' + esc(L.agent) : '') + '</div>'
      + '<div class="spendbar" title="spend so far against the job cap"><i style="width:' + pct + '%"></i></div><div class="srcnote">USD ' + Number(L.spendUsd || 0).toFixed(4) + ' of the job cap USD ' + Number(L.capUsd || 0).toFixed(2) + (j.next ? ' · ' + esc(j.statusReason || '') : '') + '</div>'
      + (L.events && L.events.length ? '<div class="events">' + L.events.slice().reverse().map((e) => '<div class="ev" title="' + esc(when(e.at, now) + ' · ' + e.text) + '"><span class="m">' + esc(new Date(e.at).toLocaleTimeString('en-IE', { hour12: false })) + '</span> ' + esc(e.text) + '</div>').join('') + '</div>' : '') + '</div>';
  }
  function wireJob(j) {
    body.querySelectorAll('[data-copy]').forEach((el) => el.addEventListener('click', async () => { try { await navigator.clipboard.writeText(el.dataset.copy); ctl.toast('Package path copied', 'ok'); } catch (_) { ctl.toast(el.dataset.copy, 'ok'); } }));
    body.querySelectorAll('[data-jobact]').forEach((el) => el.addEventListener('click', async () => { el.disabled = true; try { await jobAction(j, el.dataset.jobact); } finally { el.disabled = false; } }));
  }
  const still = (kind, id) => current && current.kind === kind && current.id === id;   // not reopened once closed
  async function jobAction(j, k) { if (await runJobAction(ctl, j, k) && still('job', j.id)) showJob(j.id, true); }
  const dot = (status) => '<i style="background:' + (PALETTE.status[status] || '#999') + '"></i>';
  const imgs = (list) => (list && list.length ? '<div class="design">' + list.slice(-2).map((im) => '<img src="' + esc(im.url) + '" alt="' + esc(im.file) + '" title="' + esc(im.file) + '">').join('') + '</div>' : '');
  // W4: every file of the newest built set, each thumbnail with its file name
  const designGrid = (ds) => (ds && ds.images.length ? '<h4>Designs · set-v' + esc(ds.set) + ' (' + ds.images.length + ' file' + (ds.images.length === 1 ? '' : 's') + ')</h4><div class="designgrid">'
    + ds.images.map((im) => '<figure><img src="' + esc(im.url) + '" alt="' + esc(im.name) + '" title="' + esc(im.file) + '" loading="lazy"><figcaption class="mono">' + esc(im.name) + '</figcaption></figure>').join('') + '</div>' : '');
  const warnBox = (list) => (list && list.length ? '<div class="warnbox">' + list.map((w) => '<div>⚠ ' + esc(w) + '</div>').join('') + '</div>' : '');
  // a legacy job: where each part came from in the legacy station, imported as it was (read only)
  // the owner's decisions on this job (src/engine/owner.mjs): each override of a QA verdict with its file, pass, date and reason
  const ownerBox = (o) => (o && (o.overrides.length || o.setApproval || o.listingApproval || o.fixes.length) ? '<h4>Owner decisions</h4>'
    + o.overrides.map((x) => '<div class="row"><span><span class="tag tag-warn">owner override</span> <span class="mono">' + esc(x.file) + '</span> · ' + esc(x.stage) + (x.qaPass != null ? ' pass ' + esc(x.qaPass) : '') + ' · ' + esc(x.date) + '<br><span class="muted" style="font-size:11px">QA: ' + esc(x.qaSaid) + '</span><br><span style="font-size:11px">Owner: ' + esc(x.ownerReason) + '</span></span></div>').join('')
    + o.fixes.map((x) => '<div class="row"><span><span class="tag">deterministic fix</span> <span class="mono">' + esc(x.file) + '</span> · ' + esc(x.date) + '<br><span class="muted" style="font-size:11px">' + esc(x.fix) + '</span></span></div>').join('')
    + (o.setApproval ? '<div class="srcnote">owner set approval of set-v' + esc(o.setApproval.set) + ' (' + esc(o.setApproval.date) + '): ' + esc(Object.entries(o.setApproval.counts || {}).map(([k, v]) => v + ' ' + k).join(', ')) + '</div>' : '')
    + (o.listingApproval ? '<div class="srcnote">owner listing approval (' + esc(o.listingApproval.date) + '): ' + esc(o.listingApproval.reason) + '</div>' : '') : '');
  const legacyBox = (j, now) => (j.legacy ? '<div class="legbox"><b>Legacy record</b> · imported ' + esc(when(Date.parse(j.legacy.importedAt), now)) + ', read only' + Object.entries(j.legacy.sources || {}).map(([k, v]) => '<br><span class="m">' + esc(k) + '</span> ' + esc(v)).join('') + (j.legacy.trackerStatus ? '<br><span class="m">tracker</span> ' + esc(j.legacy.trackerStatus) : '') + '<br><span class="muted">' + j.legacy.runs + ' legacy run' + (j.legacy.runs === 1 ? '' : 's') + ' attributed · data/' + esc(j.folder) + '</span></div>' : '');
  const synthBox = (o) => (o && o.synthetic ? '<div class="synthbox"><b>synthetic test state</b> · ' + esc(o.syntheticWhat || '') + '<br><span class="muted">fixtures/synthetic/overlay.json, not real data</span></div>' : '');

  async function showAgent(id, keep = false) {
    current = { kind: 'agent', id }; const mine = ++seq;
    const r = await fetch('/api/office/agents/' + encodeURIComponent(id)); if (!r.ok) return;
    const a = await r.json(); const now = getNow();
    if (mine !== seq) return;
    const jobsHtml = (a.jobs || []).length ? a.jobs.map((j) => '<div class="row" data-job="' + esc(j.id) + '" style="cursor:pointer"><span class="ell"><b title="' + esc(j.title) + '">' + esc(j.title) + '</b>' + synthTag(j) + '<br><span class="m">' + esc(j.id) + '</span></span><span class="m">' + (j.progress != null ? j.progress + '%' : statusPill(j)) + '<br>' + money(j.costUsd) + '</span></div>').join('') : '<div class="muted">No jobs recorded for this agent.</div>';
    const runsHtml = (a.runs || []).length ? a.runs.map((r) => '<div class="row"><span class="ell" title="' + esc(r.title) + '">' + esc(r.title) + (r.failureCode ? ' <span class="tag tag-err">' + esc(r.failureCode) + '</span>' : r.reason !== 'done' ? ' <span class="tag">' + esc(r.reason) + '</span>' : '') + synthTag(r) + '</span><span class="m">' + esc(when(r.at, now)) + ' · ' + money(r.usd) + '</span></div>').join('') : '<div class="muted">No finished runs in runs.jsonl.</div>';
    const overseer = a.overseer ? '<h4>Daily report</h4>' + (a.overseer.report ? '<div class="quote">' + esc(a.overseer.report.text) + '</div><div class="srcnote">overseer/reports/' + esc(a.overseer.report.file) + ' · ' + esc(when(a.overseer.report.at, now)) + '</div>' : '<div class="quote">No report yet</div><div class="srcnote">overseer/reports/ is empty</div>') : '';
    open('<div class="sp">'
      + '<div class="sp-head"><div class="ell"><h2>' + esc(a.name) + synthTag(a) + '</h2><div class="sp-sub">' + esc(a.deptName || '') + (a.gear.length ? ' · gear: ' + esc(a.gear.join(', ')) : '') + '</div></div><span class="close btn-icon" title="close (Esc)">×</span></div>'
      + '<div class="sp-status">' + dot(a.status) + esc(a.statusText || statusLabel[a.status]) + '</div>'
      + synthBox(a) + warnBox(a.warnings)
      + '<dl class="kv"><dt>role</dt><dd class="role" title="' + esc(roleLabel(a.role, { dept: a.deptName, name: a.name })) + '">' + esc(roleLabel(a.role, { dept: a.deptName, name: a.name }) || '—') + '</dd>'
      + '<dt>model</dt><dd>' + esc(a.model || '—') + ' <span class="muted">(' + esc(a.modelSource) + ')</span></dd><dt>provider</dt><dd>' + esc(a.provider || '—') + (a.tier ? ' <span class="muted">· tier ' + esc(a.tier) + ' in station.config.json</span>' : '') + '</dd>'
      + '<dt>current job</dt><dd>' + (a.currentJob ? '<a data-job="' + esc(a.currentJob.id) + '" class="lnk">' + esc(a.currentJob.id) + '</a> · ' + esc(a.currentJob.stageLabel) + (a.currentJob.pass ? ' pass ' + a.currentJob.pass : '') : '—') + '</dd>'
      + '<dt>today</dt><dd>' + money(a.spendToday.usd) + ' · ' + a.spendToday.runs + ' runs <span class="muted">(' + esc(a.spendToday.label) + ', ledger)</span></dd>'
      + '<dt>last run</dt><dd>' + (a.lastRun ? esc(a.lastRun.reason) + ' · ' + esc(when(a.lastRun.at, now)) : '—') + '</dd>'
      + '<dt>runs on record</dt><dd>' + a.runsTotal + '</dd></dl>'
      + agentControls(a)
      + (a.lastOutput ? '<h4>Last output</h4><div class="quote">' + esc(a.lastOutput.text) + '</div><div class="srcnote">' + (a.lastOutput.jobId ? esc(a.lastOutput.jobId) + ' · ' : '') + esc(when(a.lastOutput.at, now)) + '</div>' : '')
      + (a.latestImage ? '<h4>Latest design</h4>' + imgs([a.latestImage]) + '<div class="srcnote">' + esc(a.latestImage.jobId) + ' / ' + esc(a.latestImage.file) + ' (thumbnail)</div>' : '')
      + overseer
      + '<h4>Recent jobs</h4>' + jobsHtml
      + '<h4>Recent runs</h4>' + runsHtml
      + '</div>', keep);
    wireAgent(a);
  }

  async function showJob(id, keep = false) {
    current = { kind: 'job', id }; const mine = ++seq;
    const r = await fetch('/api/office/jobs/' + encodeURIComponent(id)); if (!r.ok) return;
    const j = await r.json(); const now = getNow();
    if (mine !== seq) return;
    const hops = j.hops.length ? j.hops.map((h) => '<div class="hop"><span class="i">' + (h.i + 1) + '</span><span><b data-agent="' + esc(h.agentId) + '" class="lnk">' + esc(h.agentName) + '</b> · ' + esc(h.stage || '') + (h.pass != null ? ' pass ' + h.pass : h.run ? ' · run ' + h.run : '') + (h.verdict ? ' · <span class="tag ' + (h.verdict === 'approved' ? 'tag-ok' : 'tag-warn') + '">' + esc(h.verdict) + '</span>' : '') + (h.live ? ' <span class="tag tag-ok">live</span>' : '') + '</span><span class="m">' + (h.live ? '…' : money(h.usd) + ' · ' + duration(h.ms)) + '</span>' + (h.output ? '<span class="o">' + esc(h.output) + '</span>' : '') + '</div>').join('') : '<div class="muted">No line hops recorded (not started on the line).</div>';
    const qa = (list, label) => (list && list.length ? '<h4>' + label + '</h4>' + list.map((p) => '<div class="row"><span>pass ' + p.pass + ' <span class="tag ' + (p.verdict === 'approved' ? 'tag-ok' : 'tag-warn') + '">' + esc(p.verdict || '?') + '</span><br><span class="muted" style="font-size:11px">' + esc((p.reasons || []).join(' · ')) + '</span></span></div>').join('') : '');
    const active = j.progress != null;
    open('<div class="sp">'
      + '<div class="sp-head"><div class="ell"><h2 class="ell" title="' + esc(j.title) + '">' + esc(j.title) + synthTag(j) + legacyTag(j) + '</h2><div class="sp-sub mono">' + esc(j.id) + '</div></div><span class="close btn-icon" title="close (Esc)">×</span></div>'
      + '<div class="sp-status">' + (active ? esc(j.stageLabel) + ' · ' + esc(jobStatusLabel[j.status] || j.status) + ' · ' + j.progress + '%' : statusPill(j) + (j.lane ? '' : ' <span class="muted">' + esc(j.stageLabel) + '</span>')) + (j.flag === 'error' ? ' <span class="tag tag-err">error</span>' : '') + '</div>'
      + (j.statusReason ? '<div class="quote" style="margin-top:6px">' + esc(j.statusReason) + '</div>' : '')
      + liveBox(j, now)
      + jobControls(j)
      + (j.qaPassedGateFailed ? '<div class="srcnote">both QA stages approved; the deterministic package gate blocked it (tracker status_reason)</div>' : '')
      + synthBox(j) + warnBox(j.warnings) + legacyBox(j, now)
      + '<dl class="kv"><dt>agent</dt><dd>' + (j.agentId ? '<a data-agent="' + esc(j.agentId) + '" class="lnk">' + esc(j.agentName) + '</a>' : '—') + ' · ' + esc(j.dept || '—') + '</dd>'
      + '<dt>slogan</dt><dd>' + esc(j.slogan || '—') + '</dd><dt>cost</dt><dd>' + money(j.costUsd) + ' <span class="muted">(' + (j.costSource || (j.queue ? 'approval-queue cost' : j.hops.length ? 'line session total' : 'tracker')) + ')</span></dd>'
      + '<dt>started</dt><dd>' + esc(when(j.startedAt, now)) + '</dd><dt>stage changed</dt><dd>' + esc(when(j.stageChangedAt, now)) + '</dd>' + (j.elapsedMs != null ? '<dt>elapsed</dt><dd>' + duration(j.elapsedMs) + '</dd>' : '') + (j.endedAt ? '<dt>ended</dt><dd>' + esc(when(j.endedAt, now)) + '</dd>' : '')
      + (j.priceRange ? '<dt>brief price</dt><dd>' + price('USD ' + j.priceRange.min + (j.priceRange.max !== j.priceRange.min ? ' – ' + j.priceRange.max : '')) + '</dd>' : '')
      + (j.listing ? '<dt>listing</dt><dd>' + esc(j.listing.title) + ' · ' + j.listing.tags + ' tags · ' + price('EUR ' + (j.listing.priceEur ?? '—')) + '</dd>' : '')
      + (j.queue ? '<dt>approval</dt><dd>' + esc(j.queue.status) + ' · ' + esc(j.queue.folder) + (j.queue.files != null ? ' · ' + j.queue.files + ' files' : '') + '</dd>' : '')
      + (j.tracker ? '<dt>tracker</dt><dd>' + esc(j.tracker.status) + (j.tracker.etsy_listing_url ? ' · ' + esc(j.tracker.etsy_listing_url) : '') + '</dd>' : '')
      + '</dl>'
      + ownerBox(j.owner)
      + designGrid(j.designSet)
      + '<h4>Line hops</h4>' + hops
      + qa(j.qaDesign, 'QA design') + qa(j.qaListing, 'QA listing')
      + (j.files.length ? '<h4>Files (' + j.files.length + ')</h4><div class="files">' + j.files.slice(0, 30).map((f) => '<div title="' + esc(f) + '">' + esc(f) + '</div>').join('') + (j.files.length > 30 ? '<div>…</div>' : '') + '</div>' : '')
      + '</div>', keep);
    wireJob(j);
  }
  // re-render whatever is open (after a snapshot change), keeping the scroll position
  function refresh() { if (!current || root.classList.contains('hidden') || (ctl && ctl.isDialogOpen()) || body.querySelector('[data-save-agent]:not([disabled])')) return; if (current.kind === 'job') showJob(current.id, true); else showAgent(current.id, true); }
  return { showAgent, showJob, close, refresh, isOpen: () => !root.classList.contains('hidden'), current: () => current };
}

// the job and approval actions, shared by the job panel and the board's cards. Each sends the version the page loaded;
// the dialogs ask for what the action needs (a reason, a date and URL) and say what will happen. Resolves true when done.
export async function runJobAction(ctl, j, k) {
  const t = '<b>' + esc(j.title) + '</b><br><span class="mono">' + esc(j.id) + '</span>';
  const qv = j.queue ? j.queue.version : null;
  if (k === 'approve') return !!(await ctl.act('/api/approvals/decide', { jobId: j.id, action: 'approve', expectedVersion: qv }, { ok: 'Approved: ' + j.title + '. Nothing was sent; upload the package by hand.' }));
  if (k === 'reject') {
    const v = await ctl.dialog({ title: 'Reject this package', intro: t + '<br><br>Records <b>rejected_by_owner</b> with your reason in the approvals row and the tracker. Nothing is deleted.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, rows: 3, placeholder: 'e.g. the colours are too close to a known brand' }], confirm: 'Reject', danger: true });
    return !!(v && await ctl.act('/api/approvals/decide', { jobId: j.id, action: 'reject', reason: v.reason.trim(), expectedVersion: qv }, { ok: 'Rejected: ' + j.title }));
  }
  if (k === 'publish') {
    const today = new Date(), iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const v = await ctl.dialog({ title: 'Mark published', intro: t + '<br><br>Records the date and the Etsy listing you published by hand. The station never publishes anything itself.', fields: [{ name: 'publishedOn', label: 'Published on', type: 'date', required: true, value: iso, max: iso }, { name: 'etsyUrl', label: 'Etsy listing URL', type: 'url', required: true, placeholder: 'paste the listing link: etsy.com/listing/…' }, { name: 'finalTitle', label: 'Final title (as on Etsy)', type: 'text', required: true, value: (j.listing && j.listing.title) || '', hint: 'the package is not rebuilt if you changed it on Etsy' }, { name: 'finalPriceEur', label: 'Final price (EUR)', type: 'number', required: true, min: 0.2, step: 0.01, value: (j.listing && j.listing.priceEur) ?? '' }, { name: 'sku', label: 'SKU', type: 'text', required: true, placeholder: 'e.g. DESK-PROPS-01' }], confirm: 'Mark published' });
    return !!(v && await ctl.act('/api/approvals/decide', { jobId: j.id, action: 'published', publishedOn: v.publishedOn, etsyUrl: v.etsyUrl.trim(), finalTitle: v.finalTitle.trim(), finalPriceEur: Number(v.finalPriceEur), sku: v.sku.trim(), expectedVersion: qv }, { ok: 'Marked published: ' + j.title }));
  }
  if (k === 'stop') {
    const v = await ctl.dialog({ title: 'Stop this job?', intro: t + '<br><br>Aborts this job\'s model or image call in flight and stops it at its current step. Other jobs and routines carry on. Restart it later from the same step.', confirm: 'Stop job', danger: true });
    return !!(v && await ctl.act('/api/jobs/stop', { jobId: j.id, expectedVersion: j.version }, { ok: 'Stopping ' + j.title }));
  }
  if (k === 'restart') return !!(await ctl.spendAct('restart', '/api/jobs/restart', { jobId: j.id, expectedVersion: j.version }, { ok: (x) => 'Resumed ' + j.title + ' at ' + x.step + (x.started ? '' : ': next in the queue') }));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  // L2 steering: the owner's decisions from the job panel (each sends the version the page loaded; nothing here spends)
  if (k === 'amend') {
    const v = await ctl.dialog({ title: 'Owner amendment', intro: t + '<br><br>A dated record in <span class="mono">jobs/' + esc(j.id) + '/amendments/</span>. The frozen brief is never edited: every line agent reads the amendment with it from its next run, and it overrules the brief on the point it names.', fields: [{ name: 'text', label: 'Your words', type: 'textarea', required: true, rows: 4, placeholder: 'e.g. item 4 now reads: a beeswax candle with a lit flame, no glow around it' }, { name: 'date', label: 'Date', type: 'date', required: true, value: today(), max: today() }], confirm: 'Record amendment' });
    return !!(v && await ctl.act('/api/owner/amend', { jobId: j.id, text: v.text.trim(), date: v.date, expectedVersion: j.version }, { ok: 'Amendment recorded for ' + j.title }));
  }
  if (k === 'file1-approve' || k === 'file1-reject') {
    const ok = k === 'file1-approve', set = j.controls.file1.set;
    const v = await ctl.dialog({ title: (ok ? 'Approve' : 'Reject') + ' file 1 of set-v' + set, intro: t + '<br><br>' + (ok ? 'File 1 becomes the style reference for the rest of the set.' : 'File 1 is drawn again, with your reason, before any other file.') + ' Then use Resume (the spend is confirmed there).', fields: [{ name: 'reason', label: ok ? 'Your note (optional)' : 'Reason', type: 'textarea', required: !ok, rows: 3, placeholder: ok ? 'e.g. reviewed on white and dark: edges clean' : 'what to change' }], confirm: ok ? 'Approve file 1' : 'Reject file 1', danger: !ok });
    return !!(v && await ctl.act('/api/owner/style-ref', { jobId: j.id, set, status: ok ? 'approved' : 'rejected', reason: v.reason.trim(), date: today(), expectedVersion: j.version }, { ok: 'File 1 ' + (ok ? 'approved' : 'rejected') + ' for ' + j.title + ': Resume to continue' }));
  }
  if (k === 'set-approve' || k === 'set-reject') {
    const ok = k === 'set-approve', sdc = j.controls.setDecision, set = sdc.set, pf = ok && sdc.rule === 'post-fix';
    const v = await ctl.dialog({ title: (ok ? 'Approve' : 'Reject') + ' set-v' + set, intro: t + '<br><br>' + (ok ? 'Your approval of the whole set in your words, after your decision on every file (recorded with the CLI or earlier). Originality and build warnings are never overridden; the server checks the set again.' + (pf ? '<br><br>Post-fix rule: approving records that you reviewed the after previews <span class="mono">' + sdc.reviewedPreviews.map(esc).join(', ') + '</span>.' : '') : 'The job ends rejected with your words, recorded in the decision log. Nothing is deleted; Archive moves the files later.'), fields: [{ name: 'words', label: 'Your words', type: 'textarea', required: true, rows: 3 }], confirm: ok ? 'Approve set' : 'Reject set', danger: !ok });
    return !!(v && await ctl.act(ok ? '/api/owner/set-approval' : '/api/owner/set-rejection', { jobId: j.id, set, words: v.words.trim(), ...(pf ? { rule: 'post-fix', reviewedPreviews: sdc.reviewedPreviews } : {}), date: today(), expectedVersion: j.version }, { ok: 'Set-v' + set + ' ' + (ok ? 'approved' : 'rejected') + ' for ' + j.title }));
  }
  if (k === 'archive') {
    const v = await ctl.dialog({ title: 'Archive this job?', intro: t + '<br><br>The job leaves the board (it stays under the Archived chip). Its files move to <span class="mono">jobs/' + esc(j.id) + '/rerun-archive-*</span>; nothing is deleted. brief.md stays where it is.', confirm: 'Archive' });
    return !!(v && await ctl.act('/api/jobs/archive', { jobId: j.id, expectedVersion: j.version }, { ok: 'Archived ' + j.title }));
  }
  if (k === 'rerun') return !!(await ctl.spendAct('rerun-listing', '/api/tasks/rerun-listing', { jobId: j.id, expectedVersion: j.version }, { ok: 'Listing re-run started for ' + j.title, extra: '<div class="dlg-note">' + t + ': the listing, its QA-LISTING records and the package move to <span class="mono">rerun-archive-*</span> (never deleted).</div>' }));
  return false;
}
