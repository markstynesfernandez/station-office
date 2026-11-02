// ui/controls.js — the page's write path (E5, ENGINE-PLAN.md §6) and its dialogs. Every write goes to the server with
// the per-launch action token (from /api/session), JSON, an idempotency key and, for an existing record, the version the
// page loaded (expectedVersion, set by the caller). The idempotency key comes from the intent, not the click: the same
// record, version and action (or the same create form) gives the same key, so a double click is one write. A stale tab
// gets the server's "changed since you loaded it" message, and the snapshot is reloaded. Nothing here keeps a secret
// beyond this page load.
import { esc } from './format.js';

const NONCE = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
// a key for one intent: the parts that make two clicks "the same request"
export const intentKey = (...parts) => { const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|'); return 'k' + NONCE + '-' + fnv(s) + fnv(s + '#'); };

export function createControls({ root, toastRoot, onRefresh = () => {} }) {
  let session = null;
  async function getSession() { if (!session) session = await (await fetch('/api/session')).json(); return session; }

  // ---- toasts: success fades; a refusal stays until it is closed
  function toast(msg, kind = 'ok', { stay = kind !== 'ok' } = {}) {
    const el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.innerHTML = '<span class="toast-ico">' + (kind === 'ok' ? '✓' : kind === 'stale' ? '↻' : '!') + '</span><span class="toast-msg">' + esc(msg) + '</span><button class="toast-x" title="close">×</button>';
    el.querySelector('.toast-x').addEventListener('click', () => el.remove());
    toastRoot.appendChild(el);
    while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
    if (!stay) setTimeout(() => el.remove(), 5000);
    return el;
  }

  // ---- one write; resolves the result, or null when it was refused (the refusal is shown)
  async function act(pathname, body, { key, ok = null, quiet = false } = {}) {
    const s = await getSession();
    const k = key || intentKey(pathname, body);
    let r, j;
    try {
      r = await fetch(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-station-action': s.actionToken, 'x-idempotency-key': k }, body: JSON.stringify(body || {}) });
      j = await r.json().catch(() => ({}));
    } catch (e) { toast('Not sent: the station server did not answer (' + e.message + ')', 'err'); return null; }
    if (r.ok) { if (ok && !quiet) toast(typeof ok === 'function' ? ok(j.result) : ok, 'ok'); onRefresh(); return j.result ?? {}; }
    if (r.status === 409) { toast(j.error || 'Not saved: this changed since you loaded it.', 'stale'); onRefresh(true); return null; }
    if (r.status === 403 && /token/.test(j.error || '')) session = null;
    toast((r.status === 423 ? '' : 'Not done: ') + (j.error || 'HTTP ' + r.status), 'err');
    return null;
  }

  // ---- a modal dialog: fields -> values, or null when cancelled. typed: the confirm button waits for that exact word.
  let open = null;
  // readonly: a field shown but not edited (L2 fix: the owner brief id); onInput(form): called on every edit, to update such a field
  function dialog({ title, intro = '', fields = [], confirm = 'OK', danger = false, typed = null, note = '', onInput = null }) {
    close(null);
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'dlg-wrap';
      const f = (x) => {
        const id = 'dlg-' + x.name, req = x.required ? ' required' : '';
        const lab = '<label for="' + id + '">' + esc(x.label) + (x.required ? ' <span class="req">required</span>' : '') + '</label>';
        if (x.type === 'textarea') return lab + '<textarea id="' + id + '" name="' + x.name + '" rows="' + (x.rows || 3) + '" placeholder="' + esc(x.placeholder || '') + '"' + req + '>' + esc(x.value || '') + '</textarea>' + (x.hint ? '<div class="hint">' + esc(x.hint) + '</div>' : '');
        if (x.type === 'select') return lab + '<select id="' + id + '" name="' + x.name + '">' + x.options.map((o) => '<option value="' + esc(o.value) + '"' + (String(o.value) === String(x.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select>' + (x.hint ? '<div class="hint">' + esc(x.hint) + '</div>' : '');
        return lab + '<input id="' + id + '" name="' + x.name + '" type="' + (x.type || 'text') + '" value="' + esc(x.value ?? '') + '" placeholder="' + esc(x.placeholder || '') + '"' + (x.min != null ? ' min="' + x.min + '"' : '') + (x.max != null ? ' max="' + x.max + '"' : '') + (x.step != null ? ' step="' + x.step + '"' : '') + req + (x.readonly ? ' readonly tabindex="-1" class="dlg-readonly"' : '') + ' autocomplete="off">' + (x.hint ? '<div class="hint">' + esc(x.hint) + '</div>' : '');
      };
      wrap.innerHTML = '<form class="dlg' + (danger ? ' dlg-danger' : '') + '" novalidate><h3>' + esc(title) + '</h3>' + (intro ? '<div class="dlg-intro">' + intro + '</div>' : '')
        + fields.map(f).join('')
        + (typed ? '<label for="dlg-typed">Type <b>' + esc(typed) + '</b> to confirm</label><input id="dlg-typed" name="__typed" autocomplete="off" spellcheck="false">' : '')
        + '<div class="dlg-err hidden"></div>' + (note ? '<div class="dlg-note">' + note + '</div>' : '')
        + '<div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-ok' + (typed ? ' disabled' : '') + '>' + esc(confirm) + '</button></div></form>';
      const form = wrap.querySelector('form'), okBtn = wrap.querySelector('[data-ok]'), err = wrap.querySelector('.dlg-err');
      const finish = (v) => { wrap.remove(); if (open && open.wrap === wrap) open = null; resolve(v); };
      open = { wrap, finish };
      if (onInput) { form.addEventListener('input', () => onInput(form)); onInput(form); }
      if (typed) { const t = wrap.querySelector('#dlg-typed'); t.addEventListener('input', () => { okBtn.disabled = t.value.trim() !== typed; }); }
      wrap.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) finish(null); });
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const vals = {};
        for (const x of fields) { const el = form.elements[x.name]; vals[x.name] = el.value; if (x.required && !String(el.value).trim()) { err.textContent = x.label + ' is required.'; err.classList.remove('hidden'); el.focus(); return; } }
        if (typed && form.elements.__typed.value.trim() !== typed) return;
        finish(vals);
      });
      root.appendChild(wrap);
      const first = wrap.querySelector('textarea, input, select'); if (first) first.focus(); else okBtn.focus();
    });
  }
  function close(v) { if (open) open.finish(v); }

  // ---- L2: the spend confirmation. Every action that can spend asks the server for a quote (the line, the models, the job cap, today's
  // spend against the daily cap, the Console's monthly limit if configured; "mock: $0" on the mock) and shows it; Confirm returns the
  // server's single-use token, which the action must carry (the server refuses without it). Resolves { token } (null when nothing would
  // spend), or null when cancelled or refused.
  async function confirmSpend(action, params, { extra = '' } = {}) {
    const s = await getSession();
    let r, j;
    try { r = await fetch('/api/spend/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-station-action': s.actionToken, 'x-idempotency-key': intentKey('quote', action, params, Date.now()) }, body: JSON.stringify({ action, params }) }); j = await r.json().catch(() => ({})); }
    catch (e) { toast('Not sent: the station server did not answer (' + e.message + ')', 'err'); return null; }
    if (!r.ok) { if (r.status === 403 && /token/.test(j.error || '')) session = null; toast('Not done: ' + (j.error || 'HTTP ' + r.status), 'err'); return null; }
    const q = j.result || {};
    if (!q.needed) return { token: null };
    const ok = await dialog({ title: (q.refusals.length ? 'Cannot start: ' : 'Confirm spend: ') + q.label, intro: spendHtml(q) + extra, confirm: q.refusals.length ? 'Close' : (q.mock ? 'Confirm (mock: $0)' : 'Confirm'), danger: !q.mock && !q.refusals.length });
    if (!ok || q.refusals.length) return null;
    return { token: q.token };
  }
  // the action with its confirm token: the confirm step first, then the write
  async function spendAct(action, pathname, body, opts = {}) {
    const c = await confirmSpend(action, body, opts);
    if (!c) return null;
    return act(pathname, c.token ? { ...body, confirmToken: c.token } : body, opts);
  }
  return { act, dialog, toast, confirmSpend, spendAct, isDialogOpen: () => !!open, closeDialog: () => close(null), session: getSession };
}

const usd = (n, d = 2) => 'USD ' + Number(n || 0).toFixed(d);
// pure (tests/l2-steer.test.mjs): the dialog body of a spend quote
export function spendHtml(q) {
  const row = (k, v) => '<div class="spend-row"><span class="m">' + esc(k) + '</span><span>' + v + '</span></div>';
  const dy = q.day || {}, ln = dy.line || {}, c = q.console || {}, jb = q.job || {}, rt = q.routine;
  // L2.1: arming a routine spends nothing now; its worst case per firing, per day and per week instead of this job's figures
  if (rt) return '<div class="spendbox">'
    + (q.mock ? '<div class="spend-mock"><b>mock: $0</b> · no model is called and nothing is charged</div>' : '<div class="spend-live"><b>LIVE</b> · each firing makes real model and image calls, charged to the station\'s accounts</div>')
    + '<div class="spend-what">' + esc(q.what || '') + '</div>'
    + row('schedule', esc(rt.scheduleWords) + ' <span class="mono">(' + esc(rt.schedule) + ')</span> · at most ' + rt.maxRunsPerDay + ' a day')
    + row('line', esc(q.lineLabel || q.line) + ' <span class="mono">(' + esc(q.line) + ')</span>')
    + row('models', (q.agents || []).map((a) => esc(a.name) + ': <span class="mono">' + esc(a.model || '?') + '</span> · ' + esc(a.effort || '')).join('<br>') + (q.imageModel ? '<br>images: <span class="mono">' + esc(q.imageModel) + '</span>' : ''))
    + row('per-run cap', rt.perRunCapUsd != null ? usd(rt.perRunCapUsd) : 'none set: the job cap ' + usd(rt.jobCapUsd) + ' applies')
    + row('worst case', usd(rt.worstPerFiringUsd) + ' a firing · ' + usd(rt.worstPerDayUsd) + ' a day (' + rt.firingsPerDayMax + ' firing' + (rt.firingsPerDayMax === 1 ? '' : 's') + ') · ' + usd(rt.worstPerWeekUsd) + ' a week (' + rt.firingsPerWeek + ' firings in the next 7 days)')
    + row('daily cap', usd(rt.dailyCapUsd) + ' for the station; today ' + usd(dy.spentUsd, 4) + ' spent' + (rt.overDailyCap ? ' <span class="tag tag-warn">its day could reach the cap: the scheduler skips firings once the cap is reached</span>' : ''))
    + row('Console', c.configured ? usd(c.leftUsd) + ' left of the monthly limit ' + usd(c.limitUsd) + ' <span class="muted">(' + esc(c.note) + ')</span>' : 'monthly limit not configured')
    + (q.refusals && q.refusals.length ? '<div class="spend-refused">' + q.refusals.map((x) => '<div>✕ ' + esc(x) + '</div>').join('') + '</div>' : '')
    + '</div>';
  return '<div class="spendbox">'
    + (q.mock ? '<div class="spend-mock"><b>mock: $0</b> · no model is called and nothing is charged</div>' : '<div class="spend-live"><b>LIVE</b> · real model and image calls, charged to the station\'s accounts</div>')
    + '<div class="spend-what">' + esc(q.what || '') + '</div>'
    + row('line', esc(q.lineLabel || q.line) + ' <span class="mono">(' + esc(q.line) + ')</span>')
    + row('models', (q.agents || []).map((a) => esc(a.name) + ': <span class="mono">' + esc(a.model || '?') + '</span> · ' + esc(a.effort || '') + (a.onDuty ? '' : ' <span class="tag tag-warn">off duty</span>')).join('<br>') + (q.imageModel ? '<br>images: <span class="mono">' + esc(q.imageModel) + '</span>' : ''))
    // R2c: the plan's estimate for this start (config/lines/<id>.json estimateUsd), beside the cap that limits it
    + (q.estimate ? row('estimate', 'about ' + usd(q.estimate.usd) + (q.mock ? ' on the live provider (mock: $0 here)' : '') + (q.estimate.note ? ' <span class="muted">(' + esc(q.estimate.note) + ')</span>' : '')) : '')
    + row('job cap', usd(jb.capUsd) + (jb.spentUsd ? ' · spent so far ' + usd(jb.spentUsd, 4) : '') + ' · this up to ' + usd(jb.headroomUsd) + ' · one agent run at most ' + usd(jb.perRunUsd))
    + row('today', usd(dy.spentUsd, 4) + ' spent + open jobs up to ' + usd(dy.openJobsUsd) + ' + this up to ' + usd(jb.headroomUsd) + ' = ' + usd(dy.worstUsd) + ' of the daily cap ' + usd(dy.capUsd) + ' <span class="muted">(' + esc(dy.date || '') + ', Dublin)</span>')
    + (ln.capUsd ? row('line today', usd(ln.worstUsd) + ' worst case of ' + usd(ln.capUsd)) : '')
    // B0, R1: the product (its department and floor), spent this month against its budget (marked when the budget is a proposal), and its
    // own day cap when it sets one
    + (q.product ? row('product', esc(q.product.name) + ' <span class="muted">(' + esc(q.product.departmentName || q.product.department || '') + ', floor ' + esc(q.product.floor) + ')</span> · this month ' + usd(q.product.monthSpentUsd, 4) + ' of the budget ' + usd(q.product.budgetUsd) + (q.product.budgetProposal ? ' <span class="tag">proposal</span>' : '') + ' · left ' + usd(q.product.budgetUsd - q.product.monthSpentUsd) + ' · worst case ' + usd(q.product.monthWorstUsd) + (q.product.dayCapUsd != null ? ' · its day cap ' + usd(q.product.dayCapUsd) : '') + ' <span class="muted">(' + esc(q.product.month) + ', Dublin)</span>') : '')
    + row('Console', c.configured ? usd(c.leftUsd) + ' left of the monthly limit ' + usd(c.limitUsd) + (c.worstUsd != null ? ' · this month ' + usd(c.usedUsd) + ' + open jobs up to ' + usd(c.openJobsUsd) + ' + this up to ' + usd(jb.headroomUsd) + ' = ' + usd(c.worstUsd) : '') + ' <span class="muted">(' + esc(c.note) + ')</span>' : 'monthly limit not configured <span class="muted">(' + esc(c.note || '') + '; Anthropic rows this month ' + usd(c.usedUsd, 4) + ')</span>')
    + (q.openrouterDailyUsd != null && q.imageModel ? row('OpenRouter', 'key limit ' + usd(q.openrouterDailyUsd) + ' a day (outside the engine)' + (q.openrouter ? ' · every job today ' + usd(q.openrouter.usedTodayUsd, 4) + ' <span class="muted">(' + esc(q.openrouter.note) + ')</span>' : '')) : '')
    // L3: the other open jobs (two lines run side by side): line, spend so far, worst case still open
    + ((q.otherJobs || []).length ? row(q.otherJobs.length === 1 ? 'other job' : 'other jobs', q.otherJobs.map((o) => '<span class="mono">' + esc(o.id) + '</span> · ' + esc(o.lineLabel || o.line) + ' · ' + esc(o.state) + (o.step ? ' at ' + esc(o.step) : '') + ' · spent ' + usd(o.spentUsd, 4) + ' · worst case still open ' + usd(o.worstUsd)).join('<br>')) : '')
    + row('queue', q.queue && q.queue.startsAsNext ? 'waits as <b>next</b>' + (q.queue.nextFor === 'line' ? ' for its line: the ' + esc(q.lineLabel || q.line) + ' line runs one job at a time' : ': ' + esc(q.queue.running.join(', ')) + ' running (at most ' + q.queue.maxRunning + ' at a time)') : 'starts now')
    + (q.refusals && q.refusals.length ? '<div class="spend-refused">' + q.refusals.map((x) => '<div>✕ ' + esc(x) + '</div>').join('') + '</div>' : '')
    + '</div>';
}
