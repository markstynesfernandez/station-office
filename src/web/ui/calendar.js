// ui/calendar.js — week/month calendar (W/M). One entry per job, on the day of its latest stage change, with a stage
// chip; clicking it opens the job. Routines come only from cron.jobs.json: enabled ones are projected forward; paused ones
// (enabled:false) are listed as "paused · waits for my OK" and appear on the grid only, ghosted, when the owner turns on
// "show where paused routines would run".
// E5 (engine mode): the routine list is the scheduler. "New routine" (or a click on a day) creates one, always
// disabled; Enable is the approval (a confirmation says what will run, when and within which caps); Edit leaves it
// disabled again; Delete asks first. Imported legacy routines are read only. Caps are set in config only.
import { esc, hhmm, when, ymd, dmy, MONTHS, DOW } from './format.js';
import { PALETTE } from '../config/palette.js';

export function createCalendar({ root, onOpenJob, ctl = null }) {
  const body = root.querySelector('#calendar-body');
  const state = { mode: 'month', cursor: null, dept: null, routines: true, ghosts: false, done: true, q: '', snap: null, popover: null };
  const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; };
  const doneKinds = new Set(['done', 'rejected', 'blocked']);

  function eventsFor(dateStr) {
    const s = state.snap; if (!s) return [];
    let evs = s.events.filter((e) => e.date === dateStr);
    if (state.ghosts) for (const r of s.routines) for (const t of r.ghostRuns || []) if (ymd(new Date(t)) === dateStr) evs.push({ date: dateStr, at: t, kind: 'ghost', routineId: r.id, title: r.name, dept: r.dept, agent: r.agentName });
    return evs
      .filter((e) => !state.dept || e.dept === state.dept)
      .filter((e) => state.routines || !(e.kind === 'routine' || e.kind === 'routine-run' || e.kind === 'ghost'))
      .filter((e) => state.done || !(e.kind === 'job' && doneKinds.has(e.stage)))
      .filter((e) => !state.q || (e.title + ' ' + (e.jobId || '') + ' ' + (e.agent || '')).toLowerCase().includes(state.q.toLowerCase()))
      .sort((a, b) => a.at - b.at);
  }
  const chip = (e) => (e.kind === 'job' ? '<span class="stage stage-' + esc(e.stage) + '">' + esc(e.stageLabel) + '</span>' : e.kind === 'ghost' ? '<span class="stage stage-ghost">paused</span>' : e.kind === 'routine-run' ? '<span class="stage">ran</span>' : '<span class="stage">↻</span>');
  const evHtml = (e) => '<div class="ev ev-' + esc(e.kind) + (e.kind === 'job' ? ' ev-stage-' + esc(e.stage) : '') + '" title="' + esc(e.title + (e.jobId ? '\n' + e.jobId : '') + '\n' + (e.stageLabel || e.kind) + (e.agent ? ' · ' + e.agent : '') + ' · ' + hhmm(e.at) + (e.reason ? '\n' + e.reason : '') + (e.kind === 'ghost' ? '\npaused routine: would run here once enabled (waits for my OK)' : '') + (e.synthetic ? '\nsynthetic test state' : '')) + '"' + (e.jobId ? ' data-job="' + esc(e.jobId) + '"' : '') + '>' + chip(e) + (e.synthetic ? '<span class="syn">syn</span>' : '') + '<span class="t">' + esc(e.title) + '</span></div>';

  function render(snap) {
    if (snap) state.snap = snap; const s = state.snap; if (!s) return;
    const nowMs = s.generatedAt || Date.now(), today = ymd(new Date(nowMs));
    if (!state.cursor) state.cursor = new Date(nowMs);
    const c = state.cursor;
    let gridHtml = '', title = '';
    if (state.mode === 'month') {
      const first = new Date(c.getFullYear(), c.getMonth(), 1), start = startOfWeek(first);
      title = MONTHS[c.getMonth()] + ' ' + c.getFullYear();
      const cells = [];
      for (let i = 0; i < 42; i++) { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const ds = ymd(d); const evs = eventsFor(ds); cells.push('<div class="day' + (d.getMonth() !== c.getMonth() ? ' other' : '') + (ds === today ? ' today' : '') + '" data-date="' + ds + '"><div class="d"><span>' + d.getDate() + '</span>' + (evs.length > 3 ? '<span class="n">' + evs.length + '</span>' : '') + '</div>' + evs.slice(0, 3).map(evHtml).join('') + (evs.length > 3 ? '<div class="more">+' + (evs.length - 3) + ' more</div>' : '') + '</div>'); }
      gridHtml = '<div class="cal-dows">' + DOW.map((d) => '<div>' + d + '</div>').join('') + '</div><div class="cal-grid">' + cells.join('') + '</div>';
    } else {
      const start = startOfWeek(c), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      title = dmy(start.getTime()) + ' – ' + dmy(end.getTime());
      const cells = [];
      for (let i = 0; i < 7; i++) { const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const ds = ymd(d); const evs = eventsFor(ds); cells.push('<div class="day' + (ds === today ? ' today' : '') + '" data-date="' + ds + '"><div class="d"><span>' + DOW[i] + ' ' + dmy(d.getTime()).slice(0, 5) + '</span><span class="n">' + (evs.length || '') + '</span></div>' + evs.map(evHtml).join('') + '</div>'); }
      gridHtml = '<div class="week">' + cells.join('') + '</div>';
    }
    const chips = s.departments.map((d) => '<button class="ctl chip ' + (state.dept === d.key ? 'chip-on' : '') + '" data-dept="' + esc(d.key) + '" style="border-color:' + (PALETTE.departments[d.key] || '#ccc') + '">' + esc(d.name) + '</button>').join('');
    const paused = s.routines.filter((r) => !r.enabled), enabled = s.routines.filter((r) => r.enabled);
    const live = !!(ctl && s.controls && s.controls.live);
    const rbtns = (r) => (!live ? '' : r.legacy ? '<div class="m"><span class="badge badge-muted">legacy · read only</span></div>' : '<div class="rbtns">' + (r.enabled ? '<button class="btn btn-mini" data-rt="disable" data-id="' + esc(r.id) + '">Disable</button>' : '<button class="btn btn-mini btn-ok" data-rt="enable" data-id="' + esc(r.id) + '"' + (r.runnable ? '' : ' disabled') + '>Enable…</button>') + '<button class="btn btn-mini" data-rt="edit" data-id="' + esc(r.id) + '">Edit…</button><button class="btn btn-mini btn-danger" data-rt="delete" data-id="' + esc(r.id) + '">Delete…</button></div>');
    const routineHtml = (r) => '<div class="routine' + (r.enabled ? '' : ' paused') + '" data-routine="' + esc(r.id) + '"><div class="n" title="' + esc(r.name) + '">' + (r.live ? '● ' : '↻ ') + esc(r.name) + '</div>'
      + '<div class="m">' + esc(r.scheduleWords) + ' · ' + esc(r.agentName) + '</div>'
      + (r.enabled ? '<div class="m">next: ' + (r.nextRun ? esc(when(r.nextRun, nowMs)) + (r.nextRunIsProjection ? ' · projected from the cron expression' : '') : '—') + '</div><div class="m"><span class="badge badge-on">enabled</span></div>'
        : '<div class="m"><span class="badge badge-warn">paused · waits for my OK</span></div><div class="m">not scheduled: it will not run until it is enabled</div>')
      + (r.lastRunAt ? '<div class="m">last run ' + esc(when(r.lastRunAt, nowMs)) + (r.lastStatus ? ' · ' + esc(r.lastStatus) : '') + '</div>' : '<div class="m">never run</div>') + rbtns(r) + '</div>';
    const side = '<aside class="cal-side"><h3>Routines (' + s.routines.length + ')' + (live ? '<button class="btn btn-mini btn-primary" data-rt="new">+ New routine</button>' : '') + '</h3>'
      + (live ? '<div class="srcnote" style="margin:0 0 8px">created disabled · <b>Enable = your approval</b>, then it runs unattended within the caps</div>' : '')
      + (s.routines.length ? enabled.map(routineHtml).join('') + paused.map(routineHtml).join('') : '<div class="muted">No routines yet.</div>')
      + (paused.length ? '<label class="ghost-toggle"><input type="checkbox" data-ghosts ' + (state.ghosts ? 'checked' : '') + '> show where paused routines would run</label>' : '')
      + '<div class="srcnote">source: ' + esc((s.routines[0] && s.routines[0].source) || 'routines') + ' · "waits for my OK" = enabled:false</div></aside>';
    body.innerHTML = '<div class="cal-wrap">' + side
      + '<div class="cal-main"><div class="cal-tools"><h2>' + esc(title) + '</h2>'
      + '<span class="grp"><button class="ctl" data-nav="-1" title="previous">‹</button><button class="ctl" data-nav="0" title="today (T)">Today</button><button class="ctl" data-nav="1" title="next">›</button></span>'
      + '<span class="grp"><button class="ctl chip ' + (state.mode === 'week' ? 'chip-on' : '') + '" data-mode="week" title="W">Week</button><button class="ctl chip ' + (state.mode === 'month' ? 'chip-on' : '') + '" data-mode="month" title="M">Month</button></span>'
      + '<span class="grp">' + chips + '</span><span class="grp"><button class="ctl chip ' + (state.routines ? 'chip-on' : '') + '" data-toggle="routines">routines</button><button class="ctl chip ' + (state.done ? 'chip-on' : '') + '" data-toggle="done">finished</button></span>'
      + '<input class="ctl" type="search" placeholder="search jobs, agents…" value="' + esc(state.q) + '"></div>'
      + gridHtml + '<div class="cal-foot muted">one entry per job, on the day of its latest stage change · ' + (live ? 'click a day to create a weekly routine on that weekday (created disabled)' : 'the legacy view is read only') + ' · Esc to close</div></div></div>';
    body.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { const n = Number(b.dataset.nav); if (n === 0) state.cursor = new Date(nowMs); else if (state.mode === 'month') state.cursor = new Date(c.getFullYear(), c.getMonth() + n, 1); else state.cursor = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 7 * n); render(); }));
    body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; render(); }));
    body.querySelectorAll('[data-dept]').forEach((b) => b.addEventListener('click', () => { state.dept = state.dept === b.dataset.dept ? null : b.dataset.dept; render(); }));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => { state[b.dataset.toggle] = !state[b.dataset.toggle]; render(); }));
    body.querySelector('[data-ghosts]')?.addEventListener('change', (e) => { state.ghosts = e.target.checked; render(); });
    const search = body.querySelector('input[type=search]'); search.addEventListener('input', () => { state.q = search.value; const pos = search.selectionStart; render(); const s2 = body.querySelector('input[type=search]'); s2.focus(); s2.setSelectionRange(pos, pos); });
    body.querySelectorAll('.ev[data-job]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); onOpenJob(el.dataset.job); }));
    body.querySelectorAll('.day').forEach((el) => el.addEventListener('click', () => { if (live) routineDialog(null, el.dataset.date); }));
    body.querySelectorAll('[data-rt]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); routineAction(el.dataset.rt, el.dataset.id); }));
  }

  // ---- the scheduler (engine mode)
  const PRESETS = [['0 9 * * 1-5', 'weekdays at 09:00'], ['0 9 * * *', 'every day at 09:00'], ['0 7 * * 1', 'Mondays at 07:00'], ['30 13 * * *', 'every day at 13:30']];
  async function routineDialog(r, dateStr) {
    const s = state.snap, c = s.controls;
    let schedule = r ? r.schedule : '0 9 * * 1-5';
    if (!r && dateStr) { const d = new Date(dateStr + 'T12:00:00'); schedule = '0 9 * * ' + d.getDay(); }
    const v = await ctl.dialog({
      title: r ? 'Edit routine' : 'New routine',
      intro: r ? 'Saving leaves it <b>disabled</b>: enable it again to approve the change.' : 'Created <b>disabled</b>. Nothing runs until you enable it; enabling is your approval.',
      fields: [
        { name: 'name', label: 'Name', required: true, value: r ? r.name : '', placeholder: 'e.g. Weekday research batch' },
        { name: 'target', label: 'Runs', type: 'select', value: r ? r.target : (c.routineTargets[0] || {}).id, options: c.routineTargets.map((t) => ({ value: t.id, label: t.label })) },
        { name: 'schedule', label: 'Schedule (cron, Europe/Dublin)', required: true, value: schedule, placeholder: '0 9 * * 1-5', hint: 'minute hour day month weekday · e.g. ' + PRESETS.map((p) => p[0] + ' = ' + p[1]).join(' · ') },
        { name: 'input', label: 'Instructions for the run (optional)', type: 'textarea', rows: 2, value: r ? r.input || '' : '', placeholder: 'research line: what to look into this batch' },
        { name: 'maxRunsPerDay', label: 'Max runs a day', type: 'number', min: 1, max: 24, step: 1, value: r ? r.maxRunsPerDay : 1 },
        { name: 'perRunCapUsd', label: 'Per-run cap, USD (optional)', type: 'number', min: 0.01, max: c.perRunCapUsd, step: 0.01, value: r && r.perRunCapUsd != null ? r.perRunCapUsd : '', hint: 'at most the engine cap of ' + c.perRunCapUsd.toFixed(2) + ' (caps are raised in config only)' }
      ],
      confirm: r ? 'Save (stays disabled)' : 'Create (disabled)'
    });
    if (!v) return;
    const body = { name: v.name.trim(), target: v.target, schedule: v.schedule.trim(), input: v.input, maxRunsPerDay: Number(v.maxRunsPerDay || 1), perRunCapUsd: v.perRunCapUsd === '' ? null : Number(v.perRunCapUsd) };
    if (r) await ctl.act('/api/routines/update', { id: r.id, expectedVersion: r.version, ...body }, { ok: 'Routine saved, disabled: ' + body.name });
    else await ctl.act('/api/routines/create', body, { ok: 'Routine created, disabled: ' + body.name });
  }
  async function routineAction(k, id) {
    if (k === 'new') return routineDialog(null);
    const s = state.snap, r = s.routines.find((x) => x.id === id); if (!r) return;
    if (k === 'edit') return routineDialog(r);
    if (k === 'disable') return ctl.act('/api/routines/enable', { id, enabled: false, expectedVersion: r.version }, { ok: 'Disabled: ' + r.name });
    if (k === 'delete') { const ok = await ctl.dialog({ title: 'Delete this routine?', intro: '<b>' + esc(r.name) + '</b><br>' + esc(r.scheduleWords) + '<br><br>Jobs it already started are kept.', confirm: 'Delete', danger: true }); if (ok) await ctl.act('/api/routines/delete', { id, expectedVersion: r.version }, { ok: 'Deleted: ' + r.name }); return; }
    if (k === 'enable') {
      // L2.1 (owner, 19/10/2026): arming goes through the spend confirmation (schedule, line, models, per-run cap, the daily cap, the worst
      // case per firing and per week); the server refuses to arm without its token. Disarming needs none.
      const next = (r.ghostRuns || [])[0];
      const extra = '<div class="dlg-note"><b>Arming is your approval.</b> From then on it runs unattended' + (next ? ' (first run ' + esc(when(next, s.generatedAt)) + ')' : '') + '. It skips (and logs why) while the e-stop is on, a cap is reached, its last run is still going or its agent is off duty.</div>';
      await ctl.spendAct('routine-arm', '/api/routines/enable', { id, enabled: true, expectedVersion: r.version }, { ok: 'Armed: ' + r.name, extra });
    }
  }
  function closePopover() { if (state.popover) { state.popover.remove(); state.popover = null; } }
  function toggleMode(m) { state.mode = m; render(); }
  function today() { state.cursor = new Date(state.snap ? state.snap.generatedAt : Date.now()); render(); }
  return { routineDialog, routineAction, render, show: () => { root.classList.remove('hidden'); render(); }, hide: () => { closePopover(); root.classList.add('hidden'); }, isOpen: () => !root.classList.contains('hidden'), toggleMode, today, closePopover, hasPopover: () => !!state.popover, setGhosts: (v) => { state.ghosts = v; render(); } };
}
