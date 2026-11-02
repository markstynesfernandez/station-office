// ui/board.js — jobs by stage, using the line's stage names (the column subtitle names the agent that owns the stage), plus the
// rejected and blocked lanes. Active jobs show progress; lane jobs show a status pill and the status reason.
// R2: the Rejected lane is collapsed by default to its count and the 3 most recent jobs, with "show all".
// E5 (engine mode): cards carry their job's controls: Approve / Reject in the approval queue, Stop on a running job,
// Restart / Archive on a blocked or stopped one (the same actions and dialogs as the job panel).
import { esc, money, duration, when, statusPill, synthTag, legacyTag } from './format.js';
import { PALETTE } from '../config/palette.js';
import { runJobAction } from './sidepanel.js';

export function createBoard({ root, onOpenJob, ctl = null }) {
  const body = root.querySelector('#board-body');
  const REJECTED_SHOWN = 3;
  const showAll = { rejected: false, legacy: false };
  let lastSnap = null;
  function card(j, agents, now) {
    const a = agents.find((x) => x.id === j.agentId);
    const head = (j.progress != null ? '<span class="pct">' + j.progress + '%</span>' : statusPill(j)) + legacyTag(j);
    return '<div class="card' + (j.lane ? ' card-' + j.lane : '') + '" data-id="' + esc(j.id) + '"><div class="top">' + head + synthTag(j) + (j.warnings && j.warnings.length ? '<span class="warn-dot" title="' + esc(j.warnings.join('\n')) + '">⚠</span>' : '') + '</div>'
      + '<div class="t" title="' + esc(j.title + (j.niche ? '\n' + j.niche : '')) + '">' + esc(j.title) + '</div><div class="id">' + esc(j.id) + '</div>'
      + (j.statusReason ? '<div class="r" title="' + esc(j.statusReason) + '">' + esc(j.statusReason) + '</div>' : '')
      + '<div class="agent"><i style="background:' + (a ? (PALETTE.status[a.status] || '#999') : '#bbb') + '"></i>' + esc(j.agentName || '—') + (j.costUsd != null ? ' · ' + money(j.costUsd) : '') + (j.progress != null && j.elapsedMs != null ? ' · ' + duration(j.elapsedMs) : '') + '</div>'
      + '<div class="when">' + esc(when(j.stageChangedAt, now)) + '</div>' + acts(j) + '</div>';
  }
  const ACTS = [['approve', 'Approve', 'btn-ok'], ['reject', 'Reject…', 'btn-danger'], ['publish', 'Published…', ''], ['stop', '■ Stop', 'btn-danger'], ['restart', '↻ Restart', 'btn-primary'], ['archive', 'Archive…', '']];
  const acts = (j) => { const c = j.controls || {}; if (!ctl || !lastSnap || !lastSnap.controls || !lastSnap.controls.live) return ''; const b = ACTS.filter(([k]) => c[k]); return b.length ? '<div class="card-acts">' + b.map(([k, l, cls]) => '<button class="btn btn-mini ' + cls + '" data-cardact="' + k + '">' + l + '</button>').join('') + '</div>' : ''; };
  function render(snap) {
    lastSnap = snap;
    const now = snap.generatedAt || Date.now();
    const byId = Object.fromEntries(snap.jobs.map((j) => [j.id, j]));
    const cols = snap.board.columns.map((c) => '<div class="col"><h3>' + esc(c.label) + '<b>' + c.jobIds.length + '</b></h3><div class="sub">' + esc(c.dock ? c.agentName + ' · ' + c.dock : c.agentName || '') + '</div>' + (c.jobIds.map((id) => card(byId[id], snap.agents, now)).join('') || '<div class="empty">empty</div>') + '</div>').join('');
    const recent = (id) => { const j = byId[id] || {}, v = j.stageChangedAt || j.updatedAt || j.startedAt || 0; return typeof v === 'number' ? v : Date.parse(v) || 0; };
    const lane = (key, label, sub, ids, limit = null) => {
      const sorted = limit ? ids.slice().sort((a, b) => recent(b) - recent(a)) : ids;
      const all = limit && showAll[key];
      const shown = limit && !all ? sorted.slice(0, limit) : sorted;
      const more = limit && ids.length > limit ? '<button class="ctl chip lane-more" data-more="' + key + '">' + (all ? 'show the ' + limit + ' most recent' : 'show all ' + ids.length) + '</button>' : '';
      return '<div class="col lane ' + key + '"><h3>' + label + '<b>' + ids.length + '</b>' + more + '</h3><div class="sub">' + sub + (limit && !all && ids.length > limit ? ' · the ' + limit + ' most recent' : '') + '</div><div class="lane-cards">' + (shown.map((id) => card(byId[id], snap.agents, now)).join('') || '<div class="empty">none</div>') + '</div></div>';
    };
    body.innerHTML = '<div class="board">' + cols + '</div><div class="lanes">'
      + lane('blocked', 'blocked', 'blocked or stopped, with the reason · incl. QA passed, gate failed', snap.board.lanes.blocked)
      + lane('rejected', 'rejected', 'REJECTS-DESK · rejected/ · rejected_by_owner', snap.board.lanes.rejected, REJECTED_SHOWN)
      + (snap.board.lanes.parked ? lane('parked', 'parked', 'kept, not publishing (owner Q11): not in the approval queue', snap.board.lanes.parked) : '')
      + (snap.board.lanes.legacy && snap.board.lanes.legacy.length ? lane('legacy', 'legacy', 'imported from the legacy station, read only · never in progress here', snap.board.lanes.legacy, REJECTED_SHOWN) : '') + '</div>';
    body.querySelectorAll('.card').forEach((el) => el.addEventListener('click', () => onOpenJob(el.dataset.id)));
    body.querySelectorAll('[data-cardact]').forEach((el) => el.addEventListener('click', async (e) => { e.stopPropagation(); const j = byId[el.closest('.card').dataset.id]; el.disabled = true; try { await runJobAction(ctl, j, el.dataset.cardact); } finally { el.disabled = false; } }));
    body.querySelectorAll('[data-more]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); showAll[el.dataset.more] = !showAll[el.dataset.more]; render(lastSnap); }));
  }
  return { render, show: () => root.classList.remove('hidden'), hide: () => root.classList.add('hidden'), isOpen: () => !root.classList.contains('hidden') };
}
