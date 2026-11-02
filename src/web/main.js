// main.js — wires the scene, the labels and the panels together. Engine view: live over SSE (/api/events, no polling
// while connected). E5: the page's controls (task box, scheduler, approval queue, desk and job controls, E-STOP) write
// through ui/controls.js: the per-launch action token, an idempotency key and the version the page loaded.
// Legacy view: read-only, polled. The scene renders on demand; labels re-layout only when the camera, data or size change.
// Presenter view (P; on by default in demo mode, ?presenter=0|1, ?tour=0 keeps the camera still): camera tour, captions,
// money hidden. Demo mode (scripts/demo.mjs): a permanent "DEMO · simulated data" badge; Space, 1/2/4 and R drive the demo.
import { createOffice } from './scene/office.js';
import { createLabels } from './ui/labels.js';
import { createTaskPanel } from './ui/taskpanel.js';
import { createSidePanel } from './ui/sidepanel.js';
import { createBoard } from './ui/board.js';
import { createCalendar } from './ui/calendar.js';
import { createLedgerView } from './ui/ledger.js';
import { createPresenter } from './ui/presenter.js';
import { esc, money, dateTime, hhmm, setMoneyHidden, isMoneyHidden, hasMoney, scrubMoney } from './ui/format.js';
import { PALETTE } from './config/palette.js';
import { createControls } from './ui/controls.js';
import { createEtsyPanel } from './ui/etsy.js';
import { QUALITY_KEY } from './scene/quality.js';
import { floorsOf, pickFloor, floorSnapshot, floorWord } from './ui/floors.js';
import { levelOf } from './scene/towerplan.js';
import { createBuildingView } from './ui/building.js';
import { createEngPanel } from './ui/engpanel.js';
import { createFloorMenu } from './ui/floormenu.js';

const q = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } } };
let theme = q.get('theme') || store.get('office-theme') || 'light';
document.body.dataset.theme = theme;
// R4a: rendering quality: ?quality= for this page only, else the remembered choice, else auto (from the GPU)
const qualityParam = ['auto', 'default', 'high'].includes(q.get('quality')) ? q.get('quality') : null;
let qualityChoice = qualityParam || (['auto', 'default', 'high'].includes(store.get(QUALITY_KEY)) ? store.get(QUALITY_KEY) : 'auto');

const office = createOffice({ canvas: $('#scene'), theme, onPick: handlePick, options: { ao: q.get('ao') !== '0', animate: q.get('anim') !== '0', msaa: q.get('msaa') !== '0', msaaSamples: Number(q.get('msaa')) || 4, aoQuality: q.get('aoq') ? Object.fromEntries(['samples', 'pdSamples', 'rings'].map((k, i) => [k, Number(q.get('aoq').split(',')[i])])) : null, scene: q.get('scene') === 'procedural' ? 'procedural' : 'baked', quality: qualityChoice, glow: q.get('glow') !== '0', bakedAO: q.get('bakedao') !== '0' } });   // R3a: baked rooms by default; ?scene=procedural draws every room procedurally
const ctl = createControls({ root: $('#dialogs'), toastRoot: $('#toasts'), onRefresh: (fresh) => { load(!!fresh).catch(() => {}); } });
const labels = createLabels({ container: $('#labels'), office, onDept: focusDept, onHub: openLedger });
const sidepanel = createSidePanel({ root: $('#sidepanel'), onOpenJob: openJob, onOpenAgent: openAgent, onClose: () => { office.setSelected(null); labelsDirty = true; }, getNow: () => (snap ? snap.generatedAt : Date.now()), getSnap: () => snap, ctl });
const taskpanel = createTaskPanel({ root: $('#taskpanel'), onOpenJob: openJob, ctl, onNewIssue: () => { closeOverlays(); engPanel.newIssue().catch(() => {}); syncPause(); } });
const board = createBoard({ root: $('#board'), onOpenJob: openJob, ctl });
const calendar = createCalendar({ root: $('#calendar'), onOpenJob: openJob, ctl });
const ledger = createLedgerView({ root: $('#ledger') });
// B0 (owner, 21/10/2026): the building's floors. The page shows one floor at a time (its office, task list, routines, board, calendar
// and spend); the whole-building view lists every floor's totals. ?floor=N for this page only, else the remembered floor
// R1: the penthouse's Owner's office in the building view: the owner decides a request (approve or reject, with their words) and resumes a
// paused line; the server checks the page session again (only the owner decides)
const building = createBuildingView({ root: $('#building'), onFloor: (n) => setFloor(n), onEng: (jobId) => openEng(jobId),
  onDecide: async (r, decision) => {
    // R2c: a merge request's rework is the Engineering panel's (the owner's notes, then the spend confirmation)
    if (decision === 'rework') { closeOverlays(); engPanel.rework(r.jobId); syncPause(); return; }
    const ok = decision === 'approve';
    const v = await ctl.dialog({ title: (ok ? 'Approve' : 'Reject') + ' this request', intro: '<b>' + esc(r.summary) + '</b><br><span class="mono">' + esc(r.action) + ' · ' + esc(r.productId) + ' · ' + esc(r.departmentId) + '</span><br><br>' + (ok ? 'Records your approval of this exact payload (sha256 ' + esc(String(r.payloadSha256).slice(0, 12)) + '…); if the payload changes, the approval no longer matches. Nothing is sent from here.' : 'Records your rejection; nothing runs.'), fields: [{ name: 'words', label: 'Your words (logged with the decision)', type: 'textarea', required: true, rows: 3 }], confirm: ok ? 'Approve' : 'Reject', danger: !ok });
    if (v) await ctl.act('/api/requests/decide', { id: r.id, decision, words: v.words.trim(), expectedVersion: r.version }, { ok: (ok ? 'Approved: ' : 'Rejected: ') + r.summary });
  },
  // R3: the executives: a report or memo now (the spend confirmation first), and the owner's mark on a proposal (a note, approving nothing)
  onExec: async (what, d) => {
    if (what === 'run') { await ctl.spendAct(d.action, d.action === 'coo-report' ? '/api/exec/coo-report' : '/api/exec/ceo-memo', {}, { ok: d.action === 'coo-report' ? 'The COO report has started' : 'The CEO memo has started' }); return; }
    const v = await ctl.dialog({ title: 'Mark ' + d.proposal + ' as ' + d.mark, intro: 'A note on the CEO\'s proposal for the next memo. It approves, starts or changes nothing.', fields: [{ name: 'words', label: 'Your words (optional)', type: 'textarea', rows: 2 }], confirm: 'Mark it ' + d.mark });
    if (v) await ctl.act('/api/exec/proposal-mark', { week: d.week, proposal: d.proposal, mark: d.mark, words: String(v.words || '').trim() }, { ok: d.proposal + ' marked ' + d.mark });
  },
  onResume: async (line) => {
    const v = await ctl.dialog({ title: 'Resume the ' + line + ' line', intro: 'The line starts jobs again from now on.', fields: [{ name: 'words', label: 'Your words (logged)', type: 'textarea', required: true, rows: 2 }], confirm: 'Resume' });
    if (v) await ctl.act('/api/lines/resume', { line, words: v.words.trim() }, { ok: 'Resumed: ' + line });
  } });
// the Floors button (F): every floor and its departments; a department goes to its floor and flies the camera there
const floorMenu = createFloorMenu({ button: $('#floor-btn'), root: $('#floor-menu'), onFloor: (n) => setFloor(n), onDept: (key) => focusDept(key), onEng: () => openEng() });
// R2c: the Engineering panel (owner only): from the building view (G), the Floors menu (F) and a merge request in the Owner's office
const engPanel = createEngPanel({ root: $('#eng'), ctl });
let floorChoice = q.get('floor') != null ? q.get('floor') : store.get('office-floor'), curFloor = null, view = null;
// E7a: the own-shop Etsy connection (top-bar button; the API Terms' notice is in the footer)
const etsyPanel = createEtsyPanel({ ctl, button: $('#etsy-btn') });
etsyPanel.refresh().catch(() => {});
const presenter = createPresenter({ office, root: $('#caption') });
presenter.setTour(q.get('tour') !== '0');
let presenterOn = q.get('presenter') === '1' ? true : q.get('presenter') === '0' ? false : null;   // null: decided by the first snapshot
let snap = null, ready = false, labelsDirty = true, perfOn = q.get('fps') === '1';

function handlePick(hit) {
  floorMenu.hide();   // a click on the office closes the floors menu
  if (!hit) return;
  if (hit.kind === 'agent') openAgent(hit.id);
  else if (hit.kind === 'hub') openLedger();
  else if (hit.kind === 'dept') focusDept(hit.id);
  // R7a: the Engineering floor's checks screen and board open the Engineering panel; the requests screen the Owner's office (the
  // building view); the lobby's trophy cabinet the read-only own-shop panel (E7a)
  else if (hit.kind === 'eng') openEng();
  else if (hit.kind === 'requests') openBuilding();
  else if (hit.kind === 'trophy') etsyPanel.open().catch(() => {});
}
// open a desk: select it, open the panel, and pan so the desk sits in the visible area left of the panel
function openAgent(id, zoom) {
  closeOverlays();
  const d = office.anchors.desks[id]; if (!d) return;
  office.setSelected(id); labelsDirty = true;
  sidepanel.showAgent(id);
  const panelW = $('#sidepanel').offsetWidth || 400, W = office.size.x, H = office.size.y;
  office.focus({ x: d.x, z: d.z + 0.4 }, zoom || Math.max(office.view.wantZoom, 2.0), { x: Math.max(160, (W - panelW) / 2), y: H / 2 + 70 });
}
function openJob(id) { office.setSelected(null); labelsDirty = true; sidepanel.showJob(id); }
function focusDept(key, zoom = 1.7) { const a = office.anchors.depts[key]; if (a) office.focus(a, zoom); taskpanel.setDept(key); }
// the 3D scene is paused (no renders, no animation) while an overlay covers the stage
function syncPause() { office.setPaused(board.isOpen() || calendar.isOpen() || ledger.isOpen() || building.isOpen() || engPanel.isOpen()); }
function closeOverlays() { floorMenu.hide(); board.hide(); calendar.hide(); ledger.hide(); building.hide(); engPanel.hide(); syncPause(); }
function openEng(jobId = null) { closeOverlays(); engPanel.open(jobId); syncPause(); }
function openLedger() { closeOverlays(); ledger.render(snap); ledger.show(); syncPause(); }
function openBoard() { closeOverlays(); board.render(view || snap); board.show(); syncPause(); }
function openCalendar() { closeOverlays(); calendar.render(view || snap); calendar.show(); syncPause(); }
function openBuilding() { closeOverlays(); building.render(snap, curFloor); building.show(); syncPause(); renderFloors(snap); }
// B0: switch floor: the page shows that floor's office, task list, routines and spend (the snapshot is not fetched again)
function setFloor(n) {
  floorChoice = String(n); if (!q.has('floor')) store.set('office-floor', floorChoice);
  closeOverlays(); if (sidepanel.isOpen()) sidepanel.close();
  if (snap) { applyView(); office.resetView(); }
}
function applyView() {
  curFloor = pickFloor(snap, floorChoice);
  view = curFloor == null ? snap : floorSnapshot(snap, curFloor);
  office.setData(view); labels.build(view); taskpanel.setSnapshot(view); renderTopbar(snap); renderFloors(snap);
  if (board.isOpen()) board.render(view); if (calendar.isOpen()) calendar.render(view); if (building.isOpen()) building.render(snap, curFloor); if (engPanel.isOpen()) engPanel.refresh();
  labelsDirty = true;
}
// the floor switcher (top bar): Building, then each floor from the bottom up; the stage caption names the floor shown. R7a: the
// seven-floor stack shows G and 1-6, the floor's name on the current tab only (the others in their tooltips)
function renderFloors(s) {
  const fl = floorsOf(s), el = $('#floors'), cap = $('#floor-caption');
  floorMenu.setData(s, curFloor);
  el.classList.toggle('hidden', !fl.length); cap.classList.toggle('hidden', !fl.length || building.isOpen());
  if (!fl.length) return;
  const btn = (k, label, sel, title) => '<button role="tab" data-fl="' + k + '" aria-selected="' + (sel ? 'true' : 'false') + '" title="' + esc(title) + '">' + label + '</button>';
  const stack = fl.some((f) => f.design), up = fl.slice().sort((a, b) => levelOf(a.floor) - levelOf(b.floor));
  el.innerHTML = btn('all', 'Building', building.isOpen(), 'the whole building: every floor\'s totals (G)') + up.map((f) => btn(f.floor, '<span class="fl-n">' + f.floor + '</span>' + (stack && f.floor !== curFloor ? '' : esc(f.shared ? 'Shared' : f.name)), !building.isOpen() && f.floor === curFloor, floorWord(f.floor) + ': ' + f.name + (f.shared ? ' (Finance, Compliance, OVERSEER and the lounge)' : '') + (f.empty ? ' · no lines yet' : '') + ' ([ and ] change floor)')).join('');
  el.querySelectorAll('[data-fl]').forEach((b) => b.addEventListener('click', () => (b.dataset.fl === 'all' ? openBuilding() : setFloor(b.dataset.fl))));
  const cur = fl.find((f) => f.floor === curFloor);
  if (cur) cap.innerHTML = '<b>' + floorWord(cur.floor) + '</b> · ' + esc(cur.name) + (cur.shared ? '<span class="muted">shared services · lounge</span>' : '') + (cur.empty ? '<span class="muted">empty floor: no lines yet</span>' : '');
}
function stepFloor(d) { const fl = floorsOf(snap).map((f) => f.floor).sort((a, b) => levelOf(a) - levelOf(b)), i = fl.indexOf(curFloor); if (i >= 0 && fl[i + d] != null) setFloor(fl[i + d]); }   // like a lift: [ down, ] up
function setTheme(t) { theme = t; document.body.dataset.theme = t; store.set('office-theme', t); office.setTheme(t); labelsDirty = true; }

// services in the top bar (R2): a small glyph and a short name, then the status dot. The glyphs are plain generic
// shapes drawn here (a spark, a route, an upscale arrow, a shop bag, a dashed ring), not anyone's logo.
const SVC_NAME = { anthropic: 'Anthropic', openrouter: 'OpenRouter', realesrgan: 'ESRGAN', etsy: 'Etsy', mock: 'Mock' };
const SVC_GLYPH = {
  anthropic: '<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>',
  openrouter: '<path d="M2 4h7.5a2.5 2.5 0 0 1 0 5h-3a2.5 2.5 0 0 0 0 5H14"/><path d="M11.8 11.6L14 14l-2.2 2.4"/>',
  realesrgan: '<rect x="2" y="8" width="6" height="6" rx="1"/><path d="M7 9l6-6M9 3h4v4"/>',
  etsy: '<path d="M3 5.5h10l-1 8.5H4z"/><path d="M5.8 5.5a2.2 2.2 0 0 1 4.4 0"/>',
  mock: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2"/>'
};
const svcGlyph = (id) => '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="' + (PALETTE.services[id] || '#999') + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (SVC_GLYPH[id] || '<circle cx="8" cy="8" r="5"/>') + '</svg>';
function renderTopbar(s) {
  $('#station-name').textContent = s.station.name;
  // services: glyph + short name + status dot, details in the tooltip (they are also on the services rack)
  $('#services').innerHTML = s.services.map((sv) => '<span class="svc" title="' + esc(sv.label + ' — ' + sv.status + (sv.reason ? '\nwhy: ' + sv.reason : '') + '\n' + sv.detail + '\nsource: ' + sv.source) + '">' + svcGlyph(sv.id) + '<span class="svc-name">' + esc(SVC_NAME[sv.id] || sv.label) + '</span><i style="background:' + (PALETTE.serviceStatus[sv.status] || PALETTE.serviceStatus.unknown) + '"></i></span>').join('');
  // engine status badge; the runtime line (engine, Node, host) lives in its tooltip
  const badge = $('#source-badge');
  const eng = s.engine || { state: 'legacy', label: 'legacy view' };
  badge.textContent = eng.label;
  badge.className = 'badge ' + (eng.state === 'halted' ? 'badge-halt' : eng.state === 'running' ? 'badge-on' : eng.state === 'legacy' ? 'badge-muted' : 'badge-off');
  badge.title = (eng.detail ? eng.detail + '\n' : '') + s.station.runtime + '\n' + (s.station.host || '') + '\nread from: ' + (s.source.root || '');
  // L1: which Station this is. LIVE owns the real data; DEV is the build checkout's scratch data on the mock provider
  const ib = $('#instance-badge'), inst = s.instance;
  ib.classList.toggle('hidden', !inst);
  if (inst) {
    ib.textContent = inst.name === 'live' ? 'LIVE · real data' : 'DEV · scratch data';
    ib.className = 'badge ' + (inst.name === 'live' ? 'badge-live' : 'badge-dev');
    ib.title = (inst.name === 'live' ? 'The live Station: the real data, the live provider when its .env says so.' : 'The dev Station: scratch data on the mock provider. Nothing here is the station\'s real data or spend.') + (inst.commit ? '\ncommit ' + inst.commit : '');
  }
  let mock = $('#mock-badge');
  if (s.source.mode === 'fixtures') { if (!mock) { mock = document.createElement('span'); mock.id = 'mock-badge'; mock.className = 'badge badge-muted'; badge.after(mock); } mock.textContent = 'mock · snapshot ' + (s.source.snapshotAt ? dateTime(s.source.snapshotAt) : '—'); mock.title = 'fixtures/station-root: a read-only snapshot of the legacy build files (npm run snapshot-fixtures)'; }
  else if (mock) mock.remove();
  const syn = $('#synthetic-badge'); const items = s.source.synthetic || [];
  syn.classList.toggle('hidden', !items.length); syn.title = 'Synthetic test states (fixtures/synthetic/overlay.json, not real data):\n• ' + items.join('\n• ');
  // spend: calendar day, from the ledger, against the caps (live in engine mode: a meter, and a warning chip from 80%)
  const sp = s.spend.today, cap = s.spend.caps && s.spend.caps.perDay, cs = s.spend.capStatus || [];
  const day = cs.find((c) => c.cap === 'perDay'), worst = cs.filter((c) => c.level !== 'ok').sort((a, b) => b.pct - a.pct)[0];
  // B0: on a business floor the top bar leads with that business's spend (today, this month against its budget), then the station's
  const fs = view && view.floorView && view.floorView.spend && !view.floorView.shared ? view.floorView.spend : null;
  $('#spend-today').innerHTML = (fs ? 'Floor ' + fs.floor + ' today <b>' + money(fs.todayUsd) + '</b> · month ' + money(fs.monthUsd) + (fs.budgetUsd ? ' / ' + money(fs.budgetUsd) : '') + ' · station ' : 'Today <b>') + money(sp.usd) + (fs ? '' : '</b>') + (cap ? ' / ' + money(cap) + ' cap' : '') + (day ? '<span class="meter meter-' + day.level + '"><i style="width:' + Math.min(100, day.pct) + '%"></i></span>' : '') + ' · ' + sp.runs + ' runs';
  $('#spend-today').title = sp.label + ' · source: ' + sp.source + (s.spend.caps ? ' · caps: ' + s.spend.caps.source : '') + (cs.length ? '\n' + cs.map((c) => c.label + ': ' + money(c.used) + ' of ' + money(c.limit) + ' (' + c.pct + '%)').join('\n') : '') + (s.spend.reservedNow ? '\nreserved for calls in flight: ' + money(s.spend.reservedNow) : '');
  const cw = $('#cap-warn');
  cw.classList.toggle('hidden', !worst);
  if (worst) { cw.textContent = (worst.level === 'hit' ? 'CAP REACHED · ' : 'cap ' + Math.floor(worst.pct) + '% · ') + worst.label; cw.className = 'badge ' + (worst.level === 'hit' ? 'badge-halt' : 'badge-warn'); cw.title = worst.label + ' ' + money(worst.used) + ' of ' + money(worst.limit) + (worst.level === 'hit' ? ': new calls on this cap are refused' : ': warning from 80%'); }
  const w = $('#warnings'); const msgs = [...(s.warnings || []), ...(s.errors || []).map((e) => 'read error: ' + e.what + ' (' + e.error + ')')];
  if (msgs.length) { w.innerHTML = '<b>⚠ ' + msgs.length + ' notice' + (msgs.length > 1 ? 's' : '') + '</b><br>' + msgs.slice(0, 4).map(esc).join('<br>'); w.classList.remove('hidden'); } else w.classList.add('hidden');
}

async function load(fresh = false) {
  const r = await fetch('/api/office/snapshot' + (fresh || q.has('fresh') ? '?fresh' : ''));
  snap = await r.json();
  if (presenterOn == null) setPresenter(!!snap.demo, false);
  renderEstop(snap); renderDemo(snap);
  if (snap.source.mode === 'engine' && !live) connectLive();
  applyView();
  sidepanel.refresh();
  presenter.onSnapshot(snap);
  labelsDirty = true; ready = true;
}

// ---- presenter view: tour + captions + money hidden (amounts print "—"; the DOM scrub below catches any left in text)
function setPresenter(v, rerender = true) {
  presenterOn = !!v; setMoneyHidden(presenterOn); presenter.setOn(presenterOn);
  if (!rerender || !snap) return;
  applyView(); if (ledger.isOpen()) ledger.render(snap);
  const cur = sidepanel.isOpen() && sidepanel.current(); if (cur) (cur.kind === 'job' ? sidepanel.showJob(cur.id) : sidepanel.showAgent(cur.id));
  scrubSoon();
}
let scrubQueued = false;
function scrubSoon() { if (scrubQueued || !isMoneyHidden()) return; scrubQueued = true; requestAnimationFrame(() => { scrubQueued = false; scrub($('#app')); }); }
function scrub(root) {
  if (!isMoneyHidden()) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (hasMoney(n.nodeValue)) n.nodeValue = scrubMoney(n.nodeValue);
  for (const el of root.querySelectorAll('[title]')) { const t = el.getAttribute('title'); if (hasMoney(t)) el.setAttribute('title', scrubMoney(t)); }
}
new MutationObserver(scrubSoon).observe($('#app'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });

// ---- demo mode: badge, pause/speed chip, keys (POSTs with the action token, like the e-stop)
function renderDemo(s) {
  const dm = s.demo;
  $('#demo-badge').classList.toggle('hidden', !dm); $('#demo-ctl').classList.toggle('hidden', !dm);
  $('#hint-demo').classList.toggle('hidden', !dm); $('#hint-reset').classList.toggle('hidden', !!dm);
  if (!dm) return;
  $('#demo-ctl').textContent = dm.phase === 'done' ? '■ done · R again' : dm.phase === 'restarting' ? '… restarting' : dm.paused ? '❚❚ paused' : '▶ ' + dm.speed + 'x';
  presenter.setStatus(dm.paused ? 'paused · Space resumes' : dm.speed !== 1 ? dm.speed + 'x' : '');
}
async function demoControl(body) {
  if (!snap || !snap.demo) return;
  const res = await ctl.act('/api/demo/control', body, { key: 'demo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), quiet: true }); if (res) { snap.demo = res; renderDemo(snap); }
}
async function demoRestart() {
  if (!snap || !snap.demo) return;
  try {
    const res = await ctl.act('/api/demo/restart', {}, { key: 'demo-restart-' + Date.now().toString(36), quiet: true }); if (!res) return;
    const j = { result: res };
    presenter.say('Restarting the demo: data-demo/ is wiped and the day starts again', true); $('#demo-ctl').textContent = '… restarting';
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const st = await fetch('/api/demo/state').then((r) => r.json()).catch(() => null);
      if (st && st.generation > j.result.from && st.phase !== 'restarting') break;
    }
    location.reload();
  } catch (e) { presenter.say('Restart refused: ' + e.message, true); }
}
$('#demo-ctl').addEventListener('click', (e) => { e.currentTarget.blur(); demoControl({ action: 'toggle' }); });   // blur: Space must not click it again

function togglePerf(v) { perfOn = v == null ? !perfOn : v; $('#perf').classList.toggle('hidden', !perfOn); }
let lastPerf = 0;
function renderPerf() {
  const s = office.getStats();
  $('#perf').innerHTML = '<b>' + s.fps + '</b> fps <span class="muted">rendered/s</span><br>' + (s.frameMs ? s.frameMs.toFixed(1) + ' ms' : '—') + ' <span class="muted">frame</span> · ' + s.cpuMs.toFixed(1) + ' ms <span class="muted">cpu</span><br>' + s.calls + ' <span class="muted">calls</span> · ' + (s.tris / 1000).toFixed(1) + 'k <span class="muted">tris</span><br><span class="muted">' + s.mode + ' · dpr ' + s.dpr + ' · AO ' + s.ao + '</span>';
}

// keyboard: B board, C calendar, T today, arrows pan, +/- zoom, R reset, D dark, F floors, Shift+F fps, W/M calendar mode, Esc close,
// P presenter view; demo mode: Space pause/resume, 1/2/4 speed, R restart (instead of reset; the ⌂ button still resets)
window.addEventListener('keydown', (e) => {
  if (ctl.isDialogOpen()) return;   // a dialog takes the keys (Esc closes it)
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (snap && snap.demo && (k === ' ' || k === '1' || k === '2' || k === '4' || k === 'r' || k === 'R')) {
    if (k === ' ') demoControl({ action: 'toggle' }); else if (k === 'r' || k === 'R') demoRestart(); else demoControl({ action: 'speed', speed: Number(k) });
    e.preventDefault(); return;
  }
  if (k === 'p' || k === 'P') { setPresenter(!presenterOn); e.preventDefault(); return; }
  if (k === 'Escape' && floorMenu.isOpen()) floorMenu.hide();
  else if (k === 'Escape') { if (calendar.hasPopover()) calendar.closePopover(); else if (sidepanel.isOpen()) sidepanel.close(); else { closeOverlays(); if (snap) renderFloors(snap); } }
  else if (k === 'g' || k === 'G') { if (building.isOpen()) { building.hide(); syncPause(); renderFloors(snap); } else if (floorsOf(snap).length) openBuilding(); }
  else if (k === '[') stepFloor(-1); else if (k === ']') stepFloor(1);
  else if (k === 'b' || k === 'B') { if (board.isOpen()) { board.hide(); syncPause(); } else openBoard(); }
  else if (k === 'c' || k === 'C') { if (calendar.isOpen()) { calendar.hide(); syncPause(); } else openCalendar(); }
  else if (k === 't' || k === 'T') { if (!calendar.isOpen()) openCalendar(); calendar.today(); }
  else if ((k === 'w' || k === 'W') && calendar.isOpen()) calendar.toggleMode('week');
  else if ((k === 'm' || k === 'M') && calendar.isOpen()) calendar.toggleMode('month');
  else if (k === 'ArrowLeft') office.pan(60, 0); else if (k === 'ArrowRight') office.pan(-60, 0); else if (k === 'ArrowUp') office.pan(0, 60); else if (k === 'ArrowDown') office.pan(0, -60);
  else if (k === '+' || k === '=') office.zoomBy(1.2); else if (k === '-' || k === '_') office.zoomBy(1 / 1.2);
  else if (k === 'r' || k === 'R') office.resetView();
  else if (k === 'd' || k === 'D') setTheme(theme === 'dark' ? 'light' : 'dark');
  else if ((k === 'f' || k === 'F') && e.shiftKey) togglePerf();
  else if (k === 'f' || k === 'F') { if (floorMenu.isOpen()) floorMenu.hide(); else { closeOverlays(); if (snap) renderFloors(snap); floorMenu.show(); } }
  else return;
  e.preventDefault();
});
$('#zoom-in').addEventListener('click', () => office.zoomBy(1.2)); $('#zoom-out').addEventListener('click', () => office.zoomBy(1 / 1.2)); $('#reset-view').addEventListener('click', () => office.resetView());
$('#theme-toggle').addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
// R4a: the Quality control (Auto shows which tier it picked); the choice is remembered in this browser
function showQuality() {
  const sel = $('#quality'), r = office.quality;
  sel.value = qualityChoice; sel.options[0].textContent = 'Auto · ' + r.tier;
  sel.title = 'Rendering quality: ' + r.tier + (r.auto ? ' (auto: ' + r.reason + ')' : ' (chosen)') + '. Default: fastest, no post-processing. High: sharper lightmaps, anti-aliasing, soft glow.';
}
$('#quality').addEventListener('change', (e) => { qualityChoice = e.target.value; if (!qualityParam) store.set(QUALITY_KEY, qualityChoice); office.setQuality(qualityChoice); showQuality(); labelsDirty = true; });
showQuality();
window.addEventListener('resize', () => { office.resize(); labelsDirty = true; });

// clock (24h) + the on-demand loop: rAF is cheap when nothing changed (no render, no layout)
const clock = () => { $('#clock').textContent = hhmm(Date.now()); };
clock(); setInterval(clock, 10000);
function loop(now) {
  const r = office.tick();
  if (r.cameraChanged || labelsDirty) { labels.update(); labelsDirty = false; }
  if (perfOn && now - lastPerf > 250) { lastPerf = now; renderPerf(); }
  requestAnimationFrame(loop);
}
togglePerf(perfOn);
load().then(() => requestAnimationFrame(loop)).catch((e) => { console.error(e); $('#source-badge').textContent = 'snapshot failed: ' + e.message; });
setInterval(() => { if (!document.hidden && !liveOk) load().catch(() => {}); }, 15000);   // polling only without a live stream

// ---- live: every engine event refreshes the snapshot (debounced); a reconnect replays what was missed
let live = null, liveOk = false, pending = null, lastSeq = 0;
function connectLive() {
  live = new EventSource('/api/events');
  live.onopen = () => { liveOk = true; };
  live.onerror = () => { liveOk = false; };
  const onEv = (e) => { lastSeq = Number(e.lastEventId) || lastSeq; try { presenter.onEvent(JSON.parse(e.data)); } catch (_) { /* not JSON */ } if (pending) return; pending = setTimeout(() => { pending = null; load().catch(() => {}); }, 120); };
  for (const t of ['job.created', 'job.stage', 'job.blocked', 'job.queued-for-approval', 'job.decided', 'owner.action', 'job.stopped', 'job.rejected', 'run.start', 'run.tool', 'run.end', 'spend.row', 'cap.warn', 'cap.hit', 'routine.fire', 'routine.skip', 'halt.on', 'halt.off', 'agent.updated', 'engine.recovered', 'routine.changed', 'action.done', 'action.refused', 'policy.changed', 'request.filed', 'request.decided', 'request.void', 'line.paused', 'line.resumed', 'issue.written', 'issue.decided', 'eng.checks', 'exec.report', 'exec.memo', 'proposal.marked']) live.addEventListener(t, onEv);
}
// the e-stop (ENGINE-PLAN.md §5.5): one click and a confirmation stops everything; resuming is a second, explicit action
// with the typed word, against the e-stop state the page loaded (a stale page is refused)
function renderEstop(s) {
  const b = $('#estop'), eng = s.engine || {};
  if (s.source.mode !== 'engine') { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.textContent = eng.halted ? 'RESUME…' : 'E-STOP';
  b.classList.toggle('btn-estop-on', !!eng.halted);
  b.title = eng.halted ? 'E-stop is ON (' + (eng.haltedBy || '') + '). Resuming needs a typed confirmation; stopped jobs are not restarted.' : 'E-stop: abort every model and image call now and stop the scheduler';
}
$('#estop').addEventListener('click', async () => {
  if (!snap || !snap.engine) return;
  if (snap.engine.halted) {
    const word = (await ctl.session()).resumeWord || 'RESUME', ver = snap.controls ? snap.controls.haltVersion : 0;
    const v = await ctl.dialog({ title: 'Resume the engine?', intro: 'The E-STOP has been on since ' + esc(dateTime(snap.engine.haltedAt || ver)) + (snap.engine.haltedBy ? ' (' + esc(snap.engine.haltedBy) + ')' : '') + '.<br><br>Resuming lets new calls start and routines fire again. <b>Stopped jobs stay stopped</b>: restart each one yourself.', typed: word, confirm: 'Resume' });
    if (v) await ctl.act('/api/engine/resume', { confirm: word, expectedVersion: ver }, { ok: 'Engine resumed. Stopped jobs were not restarted.' });
  } else {
    const inflight = snap.engine.inFlight || 0, running = (snap.jobs || []).filter((j) => j.status === 'in_progress').length;
    const v = await ctl.dialog({ title: 'E-STOP', intro: 'Abort every model and image call now (' + inflight + ' in flight), stop the scheduler and stop ' + running + ' running job' + (running === 1 ? '' : 's') + '. New calls are refused until you resume, even after a restart.', confirm: 'E-STOP now', danger: true });
    if (v) await ctl.act('/api/engine/halt', { reason: 'office button' }, { key: 'halt-' + Date.now().toString(36), ok: 'E-STOP is on: every call is refused until you resume.' });
  }
});

// test hooks for the screenshot script (read-only helpers)
window.__office = {
  ready: () => ready, reload: () => load(true), ctl, taskpanel, sidepanel, board, presenter, setPresenter, presenterOn: () => presenterOn, closePanel: () => { if (sidepanel.isOpen()) sidepanel.close(); }, office, openBoard, openCalendar, openLedger, closeOverlays, setTheme, openAgent, showJob: openJob, focusDept, calendar, snapshot: () => snap, view: () => view, setFloor, floor: () => curFloor, openBuilding, openEng, engPanel,
  setAnimate: (v) => office.setAnimate(v), bench: (ms, opts) => office.bench(ms, opts), stats: () => office.getStats(), togglePerf, settled: () => { const v = office.view, b = office.bakedState(); return (!b.want || b.loaded || !!b.failed) && v.target.distanceTo(v.wantTarget) < 0.002 && Math.abs(v.zoom - v.wantZoom) < 0.0005; }, baked: () => office.bakedState()
};
