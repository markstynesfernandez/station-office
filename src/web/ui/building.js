// ui/building.js — B0 (owner, 21/10/2026): the whole-building view: one card per floor (the shared floor 0 and each business), with its
// jobs, routines, agents and spend (today, this month against the budget). A business with no lines yet shows as an empty, labelled
// floor. Clicking a card opens that floor. The 3D office is paused while this view covers it (main.js syncPause).
// R1 (owner, 23/10/2026): below the 3D floors (B0's until R7), the penthouse: the Owner's office (the requests queue: only the owner
// decides, with their words, on this page; every decision is logged), Finance per product (a ledger calculation; MRR "not connected"
// until R6), the seven-floor company top to bottom with each agent's status, the autonomy policy (read only: the owner edits
// config/autonomy.json) and any paused line (the owner resumes it here).
// R7a: with the seven-floor stack, the floors are a lift: a section of the building, the penthouse at the top and the lobby at the
// bottom, each floor with who works there (hired, not hired yet; the lobby's archived agents) and its jobs; the lift car marks the floor
// the page shows; a click goes to that floor. Spend per product is in Finance below (the floors have no budget of their own).
import { esc, money } from './format.js';
import { buildingTotals, floorWord } from './floors.js';
import { FLOOR_PALETTES } from '../scene/towerplan.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IE', { timeZone: 'Europe/Dublin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

// R2c: a git.merge request of an engineering job has three buttons (approve, rework with notes, reject) and opens in the Engineering
// panel; the panel itself is one click from the top of this view.
// R3: the executives in the Owner's office: the COO's latest daily report and the CEO's latest memo, each with a button to run it now
// (behind the spend confirmation) and its routine's state; the memo's proposals with the owner's three marks (a note: nothing is approved)
export function createBuildingView({ root, onFloor = () => {}, onDecide = () => {}, onResume = () => {}, onEng = () => {}, onExec = () => {} }) {
  const body = root.querySelector('#building-body');
  let reqs = [];
  function render(snap, cur = null) {
    const rows = buildingTotals(snap).slice().sort((a, b) => (b.level ?? b.floor) - (a.level ?? a.floor));   // top floor first, like a building
    if (rows.some((r) => r.design)) return bind(snap, '<div class="bldg">' + lift(rows, cur) + '<div class="bldg-total muted">Whole building: today ' + money(snap.spend && snap.spend.today ? snap.spend.today.usd : 0) + ' of the station\'s daily cap ' + money(snap.spend && snap.spend.caps ? snap.spend.caps.perDay : 0) + ' · spend per product: Finance, below · station caps stay the outer limit</div>' + company(snap) + '</div>');
    const total = rows.reduce((s, r) => s + (r.todayUsd || 0), 0), month = rows.reduce((s, r) => s + (r.monthUsd || 0), 0);
    bind(snap, '<div class="bldg">' + rows.map((r) => '<button class="bldg-floor" data-floor="' + r.floor + '">'
      + '<span class="fl-num">' + r.floor + '</span><span><span class="fl-name">' + esc(r.name) + '</span>'
      + (r.shared ? ' <span class="tag">shared services' + (r.lounge ? ' · lounge' : '') + '</span>' : '') + (r.empty ? ' <span class="tag tag-warn">empty floor: no lines yet</span>' : '')
      + '<div class="muted" style="font-size:11px">' + esc(r.departments.join(' · ') || 'no departments') + ' · ' + r.agents + ' agent' + (r.agents === 1 ? '' : 's') + (r.lines.length ? ' · lines ' + esc(r.lines.join(', ')) : '') + '</div>'
      + '<div class="fl-stats"><span><span class="m">running</span> ' + r.jobs.running + '</span><span><span class="m">waiting</span> ' + r.jobs.waiting + '</span><span><span class="m">blocked</span> ' + r.jobs.blocked + '</span><span><span class="m">done</span> ' + r.jobs.done + '</span><span><span class="m">routines on</span> ' + r.routinesOn + '</span>'
      + '<span><span class="m">today</span> ' + money(r.todayUsd) + '</span><span><span class="m">this month</span> ' + money(r.monthUsd) + (r.budgetUsd ? ' of ' + money(r.budgetUsd) + ' budget' : '') + '</span></div></span></button>').join('')
      + '<div class="bldg-total muted">Whole building: today ' + money(total) + ' of the station\'s daily cap ' + money(snap.spend && snap.spend.caps ? snap.spend.caps.perDay : 0) + ' · this month ' + money(month) + ' · station caps stay the outer limit</div>'
      + company(snap) + '</div>');
  }
  function bind(snap, html) {
    body.innerHTML = html;
    body.querySelectorAll('[data-floor]').forEach((el) => el.addEventListener('click', () => onFloor(el.dataset.floor)));
    body.querySelectorAll('[data-req]').forEach((el) => el.addEventListener('click', () => { const r = reqs.find((x) => x.id === el.dataset.req); if (r) onDecide(r, el.dataset.decision); }));
    body.querySelectorAll('[data-resume]').forEach((el) => el.addEventListener('click', () => onResume(el.dataset.resume)));
    body.querySelectorAll('[data-eng-open]').forEach((el) => el.addEventListener('click', () => onEng(el.dataset.engOpen || null)));
    body.querySelectorAll('[data-exec-run]').forEach((el) => el.addEventListener('click', () => onExec('run', { action: el.dataset.execRun })));
    body.querySelectorAll('[data-mark]').forEach((el) => el.addEventListener('click', () => onExec('mark', { week: el.dataset.week, proposal: el.dataset.proposal, mark: el.dataset.mark })));
  }

  // R7a: the lift: one slab per floor in the floor's own colours, the car at the floor shown
  function lift(rows, cur) {
    const n = (v, one, many) => v + ' ' + (v === 1 ? one : many);
    return '<div class="lift" role="list" aria-label="the floors, top to bottom">' + rows.map((r) => {
      const pal = (FLOOR_PALETTES[r.palette] || FLOOR_PALETTES.generic).light, here = cur != null && String(cur) === String(r.floor);
      const who = [r.agents ? n(r.agents, 'hired', 'hired') : null, r.notHired ? r.notHired + ' not hired yet' : null, r.trophy ? n(r.trophy, 'archived agent', 'archived agents') + ' in the trophy cabinet' : null, ...(r.retired || []).map((x) => x + ' retired')].filter(Boolean).join(' · ') || 'reception and lounge';
      const jobs = r.jobs.running + r.jobs.waiting + r.jobs.blocked + r.jobs.done;
      return '<button class="lift-floor' + (here ? ' lift-cur' : '') + '" role="listitem" data-floor="' + esc(r.floor) + '" style="--fl-wall:' + pal.wall + ';--fl-floor:' + pal.floor + ';--fl-acc:' + pal.accent + '" title="' + esc(floorWord(r.floor) + ': ' + r.name + ' (click to go there)') + '">'
        + '<span class="lift-car">' + (here ? '▶' : '') + '</span><span class="lift-n">' + esc(r.floor) + '</span>'
        + '<span class="lift-body"><span><span class="fl-name">' + esc(r.name) + '</span>' + (r.archived ? ' <span class="tag tag-warn">archive</span>' : '') + (here ? ' <span class="muted">· you are here</span>' : '') + '</span>'
        + '<span class="lift-meta">' + esc(r.departments.join(' · ')) + ' · ' + esc(who) + '</span>'
        + '<span class="fl-stats"><span><span class="m">running</span> ' + r.jobs.running + '</span><span><span class="m">waiting</span> ' + r.jobs.waiting + '</span><span><span class="m">blocked</span> ' + r.jobs.blocked + '</span><span><span class="m">done</span> ' + r.jobs.done + '</span><span><span class="m">routines on</span> ' + r.routinesOn + '</span>' + (jobs ? '' : '<span class="muted">no jobs yet</span>') + '</span></span>'
        + '<span class="lift-slab"></span></button>';
    }).join('') + '</div>';
  }

  // R1: the penthouse and the company
  function company(snap) {
    const c = snap.company; if (!c) return '';
    const oo = c.ownersOffice || {}; reqs = oo.requests || [];
    const prodName = Object.fromEntries((c.products || []).map((p) => [p.id, p.name]));
    const pending = reqs.filter((r) => r.status === 'pending'), recent = reqs.filter((r) => r.status !== 'pending').slice(0, 8);
    const merge = (r) => r.action === 'git.merge' && !!r.jobId, eng = snap.engineering;
    const verdict = (v, who) => (v ? '<span class="tag' + (v.verdict === 'pass' || v.verdict === 'approve' ? '' : ' tag-warn') + '">' + esc(who) + ': ' + esc(v.verdict) + '</span>' : '');
    const reqRow = (r, live) => '<div class="bldg-floor" style="cursor:default"><span class="fl-num" style="font-size:12px">' + esc(r.status) + '</span><span>'
      + '<span class="fl-name">' + esc(r.summary) + '</span> <span class="tag">' + esc(r.action) + '</span> ' + verdict(r.compliance, 'COMPLIANCE') + ' ' + verdict(r.security, 'SECURITY')
      + '<div class="muted" style="font-size:11px">' + esc(prodName[r.productId] || r.productId) + ' · ' + esc(r.departmentId) + (r.jobId ? ' · job <span class="mono">' + esc(r.jobId) + '</span>' : '') + ' · filed by ' + esc(r.filedBy) + ' ' + esc(when(r.filedAt)) + ' · payload <span class="mono">' + esc(String(r.payloadSha256 || '').slice(0, 12)) + '</span></div>'
      + (r.words ? '<div class="muted" style="font-size:11px">the owner: “' + esc(r.words) + '” ' + esc(when(r.decidedAt)) + '</div>' : '')
      + (live ? '<div class="fl-stats"><button class="btn btn-mini btn-ok" data-req="' + esc(r.id) + '" data-decision="approve">Approve…</button>' + (merge(r) ? '<button class="btn btn-mini" data-req="' + esc(r.id) + '" data-decision="rework">Rework with notes…</button>' : '') + '<button class="btn btn-mini btn-danger" data-req="' + esc(r.id) + '" data-decision="reject">Reject…</button>' + (merge(r) ? '<button class="btn btn-mini" data-eng-open="' + esc(r.jobId) + '">Open in Engineering</button>' : '') + '</div>' : '')
      + '</span></div>';
    const fin = ((snap.spend && snap.spend.byProduct) || []).map((p) => '<div><span class="m">' + esc(p.name) + (p.status === 'archived' ? ' (archived)' : '') + '</span> this month ' + money(p.monthUsd) + ' of ' + money(p.budgetUsd) + (p.budgetProposal ? ' <span class="tag">proposal</span>' : '') + ' · today ' + money(p.todayUsd) + ' · MRR ' + esc(p.mrr) + '</div>').join('');
    const floors = (c.floors || []).map((f) => '<div class="bldg-floor" style="cursor:default"><span class="fl-num">' + esc(f.floor) + '</span><span><span class="fl-name">' + esc(f.name) + '</span>'
      + (f.status === 'archived' ? ' <span class="tag tag-warn">archived</span>' : '') + ' <span class="muted" style="font-size:11px">reports to ' + esc(f.reportsTo) + '</span>'
      + '<div class="muted" style="font-size:11px">' + (f.agents || []).map((a) => esc(a.name) + ' <span class="tag' + (a.status === 'active' ? '' : ' tag-warn') + '">' + esc(a.label) + '</span>').join(' ') + '</div>'
      + ((f.lines || []).length ? '<div class="muted" style="font-size:11px">lines ' + f.lines.map((l) => esc(l.id) + (l.archived ? ' (archived)' : '') + (l.paused ? ' (paused)' : '')).join(', ') + '</div>' : '') + '</span></div>').join('');
    const pol = oo.policy, paused = oo.pausedLines || [];
    return (eng ? '<h3 style="margin:18px 0 6px">Engineering</h3><div class="bldg-total"><button class="btn btn-mini btn-primary" data-eng-open="">Open the Engineering panel</button> <span class="muted">' + esc(eng.products.map((p) => p.name).join(', ')) + ': issues, jobs, the diff and checks, your decisions' + (eng.waitingForYou ? ' · <b>' + eng.waitingForYou + ' waiting for you</b>' : '') + '</span></div>' : '')
      + '<h3 style="margin:18px 0 6px">Penthouse · the Owner\'s office</h3>'
      + '<div class="muted" style="font-size:12px;margin-bottom:6px">Requests: every action that leaves the building, or cannot be undone, waits here for you. Only you decide one, on this page, with your words; each decision is logged. Nothing is sent from here.</div>'
      + (pending.length ? pending.map((r) => reqRow(r, true)).join('') : '<div class="muted">No request is waiting.</div>')
      + (recent.length ? '<div class="muted" style="margin-top:8px;font-size:12px">Decided</div>' + recent.map((r) => reqRow(r, false)).join('') : '')
      + (paused.length ? '<div style="margin-top:8px">' + paused.map((p) => '<div class="bldg-total"><b>' + esc(p.line) + '</b> paused by ' + esc(p.paused.by) + ': ' + esc(p.paused.reason) + ' <button class="btn btn-mini" data-resume="' + esc(p.line) + '">Resume…</button></div>').join('') + '</div>' : '')
      + execs(oo.execs)
      + '<h3 style="margin:18px 0 6px">Finance (from the ledger)</h3><div class="bldg-total">' + (fin || '<span class="muted">no products</span>') + '</div>'
      + (pol ? '<h3 style="margin:18px 0 6px">Autonomy policy</h3><div class="bldg-total muted">' + pol.counts.auto + ' auto · ' + pol.counts.owner + ' owner · ' + pol.counts.forbidden + ' forbidden · <span class="mono">' + esc(String(pol.sha256).slice(0, 12)) + '</span> · ' + esc(pol.source)
        + ((pol.log || []).filter((x) => !x.first).slice(-5).map((x) => '<div>' + esc(x.at.slice(0, 16).replace('T', ' ')) + ' ' + esc(x.action) + ': ' + esc(x.old) + ' → ' + esc(x.new) + '</div>').join('')) + '</div>' : '')
      + '<h3 style="margin:18px 0 6px">The company (floors are display order only)</h3>' + floors;
  }
  // R3: the COO's report and the CEO's memo (text as written, capped by the server), the run buttons, the proposals and their marks
  function execs(x) {
    if (!x) return '';
    const st = (a) => (a.status !== 'active' ? '<span class="tag tag-warn">' + esc(a.status === 'not-hired' ? 'not hired yet' : a.status) + '</span>' : a.onDuty ? '' : '<span class="tag tag-warn">off duty</span>');
    const rt = (r) => (r ? '<span class="muted" style="font-size:11px">routine "' + esc(r.name) + '": ' + (r.enabled ? 'armed, ' + esc(r.schedule) : 'not armed (arm it on the calendar)') + (r.lastStatus ? ' · last ' + esc(r.lastStatus) + ' ' + esc(when(r.lastFireAt)) : '') + '</span>' : '');
    const run = (a, action, label) => '<button class="btn btn-mini btn-primary" data-exec-run="' + action + '"' + (a.canStart && a.canStart.length ? ' disabled title="' + esc(a.canStart.join('; ')) + '"' : '') + '>' + label + '</button>' + (a.estimateUsd != null ? ' <span class="muted" style="font-size:11px">plan estimate ' + money(a.estimateUsd) + '</span>' : '');
    const text = (t) => '<div class="exec-text">' + esc(t) + '</div>';
    const markBtns = (week, p) => ['taken', 'declined', 'later'].map((m) => '<button class="btn btn-mini' + (p.mark && p.mark.mark === m ? ' btn-ok' : '') + '" data-mark="' + m + '" data-week="' + esc(week) + '" data-proposal="' + esc(p.id) + '">' + m + '</button>').join('');
    const prop = (week, p) => '<div class="bldg-floor exec-prop" style="cursor:default"><span class="fl-num" style="font-size:12px">' + esc(p.id) + '</span><span><span class="fl-name">' + esc(p.title) + '</span>'
      + '<div class="muted" style="font-size:11px">' + p.options.map((o) => '· ' + esc(o)).join('<br>') + '</div>'
      + '<div style="font-size:12px"><b>Recommendation</b> ' + esc(p.recommendation) + '</div><div style="font-size:12px"><b>Cost</b> ' + esc(p.cost) + '</div>'
      + '<div class="fl-stats">' + markBtns(week, p) + (p.mark ? '<span class="muted" style="font-size:11px">you: ' + esc(p.mark.mark) + (p.mark.words ? ' “' + esc(p.mark.words) + '”' : '') + ' ' + esc(String(p.mark.at || '').slice(0, 10)) + '</span>' : '') + '</div></span></div>';
    const c = x.coo, m = x.ceo, last = c.latest, memo = m.latest;
    return '<h3 style="margin:18px 0 6px">COO · daily operations report ' + st(c) + '</h3>'
      + '<div class="bldg-total">' + run(c, 'coo-report', 'Run the report now…') + ' ' + rt(c.routine) + '</div>'
      + (last ? '<div class="muted" style="font-size:12px;margin:4px 0">' + esc(last.day) + (last.breaches && last.breaches.length ? ' · ' + last.breaches.length + ' breach(es): ' + esc(last.breaches.map((b) => b.id + ' ' + b.text).join('; ')) : ' · no breach') + '</div>' + text(last.text) : '<div class="muted">No report yet.</div>')
      + '<h3 style="margin:18px 0 6px">CEO · weekly memo and proposals ' + st(m) + '</h3>'
      + '<div class="bldg-total">' + run(m, 'ceo-memo', 'Write the memo now…') + ' ' + rt(m.routine) + '</div>'
      + '<div class="muted" style="font-size:12px;margin:4px 0">The CEO recommends only. A proposal is a document: mark it taken, declined or later; that is a note for the next memo, and it approves, starts or changes nothing.</div>'
      + (memo ? (memo.proposals.length ? memo.proposals.map((p) => prop(memo.week, p)).join('') : '<div class="muted">No proposal this week.</div>') + '<details style="margin-top:6px"><summary class="muted" style="font-size:12px;cursor:pointer">The memo, ' + esc(memo.week) + '</summary>' + text(memo.text) + '</details>' : '<div class="muted">No memo yet.</div>');
  }
  return { render, show: () => root.classList.remove('hidden'), hide: () => root.classList.add('hidden'), isOpen: () => !root.classList.contains('hidden') };
}
