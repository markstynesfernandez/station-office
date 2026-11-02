// ui/floors.js — B0 (owner, 21/10/2026): the Station is one building; each business is a floor, and the shared services (Finance,
// Compliance, OVERSEER) and the lounge are floor 0. Pure (tests/b0.test.mjs): what one floor of the engine snapshot shows, and every
// floor's totals for the whole-building view. A snapshot without a building (the legacy and fixtures views) is shown as it is.

// R7a (owner, 29/10/2026): with the company model in the snapshot (the engine view), the building is the seven-floor stack instead
// (scene/towerplan.js): 6 Penthouse HQ down to G, the lobby. Floors are display order only (a string: 'G', '1'..'6'); a job or routine
// shows on the floor of the department whose line it runs, an archived product's history on that department's floor (G), anything
// else on the penthouse (station-wide). B0's two floors remain for a snapshot without the company model.
import { towerFloors, planFloor, levelOf } from '../scene/towerplan.js';

const tower = (snap) => towerFloors(snap);
export const isTower = (snap) => tower(snap).length > 0;
export const floorsOf = (snap) => { const t = tower(snap); if (t.length) return t.map((f) => ({ ...f, shared: false, empty: false, lounge: f.design === 'lobby' })); return snap && snap.building && Array.isArray(snap.building.floors) ? snap.building.floors : []; };
// the floor's spoken name: "Ground floor" for G
export const floorWord = (f) => (String(f) === 'G' ? 'Ground floor' : 'Floor ' + f);
// the floor to open: the remembered one if it still exists, else the first business floor, else floor 0
export function pickFloor(snap, want) {
  const t = tower(snap);
  if (t.length) { const w = want == null ? null : String(want).toUpperCase(); return t.some((f) => f.floor === w) ? w : t[0].floor; }   // R7a: else the top floor
  const fl = floorsOf(snap); if (!fl.length) return null;
  if (want != null && fl.some((f) => f.floor === Number(want))) return Number(want);
  const biz = fl.find((f) => !f.shared); return (biz || fl[0]).floor;
}

// one floor's view of the snapshot: its departments and agents (the 3D office and the labels), its jobs, routines and calendar entries
// (the task list, the board, the calendar), and its spend (the top bar); the services sit on the shared floor. floorView tells the
// office which floor it draws and whether the lounge is on it.
export function floorSnapshot(snap, floor) {
  if (isTower(snap)) return towerSnapshot(snap, floor);
  const fl = floorsOf(snap).find((f) => f.floor === floor); if (!fl) return snap;
  const on = (x) => x && x.floor === floor;
  const jobs = (snap.jobs || []).filter(on), ids = new Set(jobs.map((j) => j.id));
  const routines = (snap.routines || []).filter(on), rids = new Set(routines.map((r) => r.id));
  const keep = (list) => (list || []).filter((id) => ids.has(id));
  const board = snap.board ? { columns: snap.board.columns.map((c) => ({ ...c, jobIds: keep(c.jobIds) })), lanes: Object.fromEntries(Object.entries(snap.board.lanes || {}).map(([k, v]) => [k, keep(v)])) } : snap.board;
  const biz = ((snap.spend && snap.spend.byBusiness) || []).find((b) => b.id === fl.id) || null;
  return {
    ...snap,
    departments: (snap.departments || []).filter(on),
    agents: (snap.agents || []).filter(on),
    services: fl.shared ? snap.services : [],
    jobs, board, routines,
    events: (snap.events || []).filter((e) => (e.jobId ? ids.has(e.jobId) : e.routineId ? rids.has(e.routineId) : true)),
    floorView: { floor: fl.floor, id: fl.id, name: fl.name, shared: !!fl.shared, lounge: !!fl.lounge, empty: !!fl.empty, spend: biz }
  };
}

// every floor's totals: jobs by state, routines on, agents, spend today and this month against the budget
export function buildingTotals(snap) {
  if (isTower(snap)) return towerTotals(snap);
  const byBiz = Object.fromEntries((((snap && snap.spend) || {}).byBusiness || []).map((b) => [b.id, b]));
  return floorsOf(snap).map((fl) => {
    const jobs = (snap.jobs || []).filter((j) => j.floor === fl.floor && j.kind !== 'legacy' && j.status !== 'archived');
    const n = (pred) => jobs.filter(pred).length, sp = byBiz[fl.id] || null;
    return {
      floor: fl.floor, id: fl.id, name: fl.name, shared: !!fl.shared, empty: !!fl.empty, lounge: !!fl.lounge,
      departments: (snap.departments || []).filter((d) => d.floor === fl.floor).map((d) => d.name),
      agents: (snap.agents || []).filter((a) => a.floor === fl.floor).length, lines: fl.lines || [],
      jobs: { running: n((j) => j.status === 'in_progress'), waiting: n((j) => j.status === 'backlog' || j.status === 'waiting'), blocked: n((j) => j.lane === 'blocked'), done: n((j) => j.status === 'done') },
      routinesOn: (snap.routines || []).filter((r) => r.floor === fl.floor && r.enabled).length,
      todayUsd: sp ? sp.todayUsd : 0, monthUsd: sp ? sp.monthUsd : 0, budgetUsd: sp ? sp.budgetUsd : null, month: sp ? sp.month : null
    };
  });
}

// the floors menu (the Floors button, F): every floor, top floor first like a lift, with its departments to jump to. A snapshot without
// a building (the legacy and fixtures views) is one unnamed floor holding every department.
export function floorMenu(snap) {
  const depts = (floor) => ((snap && snap.departments) || []).filter((d) => floor == null || d.floor === floor).map((d) => ({ key: d.key, name: d.name }));
  const t = tower(snap);
  if (t.length) return t.map((f) => ({ floor: f.floor, name: f.name, shared: false, empty: false, departments: f.departments.map((d) => ({ key: d.key, name: d.name })) }));
  const fl = floorsOf(snap);
  if (!fl.length) return [{ floor: null, name: 'This office', shared: false, empty: false, departments: depts(null) }];
  return fl.slice().sort((a, b) => b.floor - a.floor).map((f) => ({ floor: f.floor, name: f.shared ? 'Shared services' : f.name, shared: !!f.shared, empty: !!f.empty, departments: depts(f.floor) }));
}

// ---- R7a: the seven-floor stack
// which department a job or routine belongs to: the one whose line it runs; an archived product's history goes to that product's
// archived department (the Etsy archive, G); anything else is station-wide (the penthouse, HQ)
function deptIndex(snap) {
  const floors = (snap.company && snap.company.floors) || [], byLine = {}, byProduct = {};
  for (const d of floors) { for (const l of d.lines || []) byLine[typeof l === 'string' ? l : l.id] = d; if (d.product) byProduct[d.product] = d; }
  const hq = floors.find((d) => d.id === 'hq') || null;
  const of = (line, biz) => byLine[line] || (biz && byProduct[biz]) || hq;
  return { floors, of };
}
const lineOfRoutine = (r) => r.line || (/^line:(.+)$/.exec(r.target || '') || [])[1] || null;

// one floor of the stack: its departments (hired and not-hired agents), the hired agents at their desks, the jobs and routines of its
// departments' lines, and the plan the 3D office draws (planFloor)
export function towerSnapshot(snap, floor) {
  const fl = tower(snap).find((f) => f.floor === String(floor).toUpperCase()); if (!fl) return snap;
  const ix = deptIndex(snap), mine = new Set(fl.departments.map((d) => d.key)), here = ix.floors.filter((d) => mine.has(d.id));
  const active = new Set(here.flatMap((d) => (d.agents || []).filter((a) => a.status === 'active').map((a) => a.id)));
  const onFloor = (line, biz) => { const d = ix.of(line, biz); return !!d && mine.has(d.id); };
  const jobs = (snap.jobs || []).filter((j) => onFloor(j.line, j.businessId)), ids = new Set(jobs.map((j) => j.id));
  const routines = (snap.routines || []).filter((r) => onFloor(lineOfRoutine(r), r.businessId)), rids = new Set(routines.map((r) => r.id));
  const keep = (list) => (list || []).filter((id) => ids.has(id));
  const board = snap.board ? { columns: snap.board.columns.map((c) => ({ ...c, jobIds: keep(c.jobIds) })), lanes: Object.fromEntries(Object.entries(snap.board.lanes || {}).map(([k, v]) => [k, keep(v)])) } : snap.board;
  const plan = planFloor(snap, fl.floor), live = jobs.filter((j) => j.kind !== 'legacy' && j.status !== 'archived');
  const departments = here.map((d) => {
    const ag = d.agents || [], n = (st) => ag.filter((a) => a.status === st).length, dj = live.filter((j) => { const x = ix.of(j.line, j.businessId); return x && x.id === d.id; });
    const metrics = d.status === 'archived'
      ? [{ label: 'archived agents', value: (plan.cabinet || []).length, source: 'config/departments/' + d.id + '.json' }, { label: 'product', value: ((snap.company.products || []).find((p) => p.id === d.product) || {}).name || d.product || '—', source: 'config/products' }]
      : [{ label: 'hired', value: n('active'), source: 'config/agents' }, { label: 'not hired yet', value: n('not-hired'), source: 'config/agents' }];
    return { id: d.id, key: d.id, name: d.name, floor: fl.floor, agents: ag.filter((a) => a.status === 'active').map((a) => a.id), agentCount: n('active'), countLabel: d.status === 'archived' ? 'archived' : null, metrics, warnings: [], counts: { doing: dj.filter((j) => j.status === 'in_progress').length, next: dj.filter((j) => j.status === 'backlog' || j.status === 'waiting').length, done: dj.filter((j) => j.status === 'done').length } };
  });
  return {
    ...snap,
    departments, agents: (snap.agents || []).filter((a) => active.has(a.id)),
    services: plan.services ? snap.services : [],
    jobs, board, routines,
    events: (snap.events || []).filter((e) => (e.jobId ? ids.has(e.jobId) : e.routineId ? rids.has(e.routineId) : true)),
    vacancies: plan.seats.filter((s) => s.state === 'not-hired').map((s) => ({ id: s.agentId, name: s.name, label: s.label })),
    plan,
    floorView: { floor: fl.floor, id: fl.id, name: fl.name, shared: false, lounge: fl.design === 'lobby', empty: false, spend: null, tower: true, design: fl.design }
  };
}

// every floor of the stack for the whole-building view (the lift): who works there, its jobs, routines on
export function towerTotals(snap) {
  const ix = deptIndex(snap), archived = ix.floors.flatMap((d) => (d.agents || []).filter((a) => a.status === 'archived'));   // shown in the lobby
  return tower(snap).map((f) => {
    const mine = new Set(f.departments.map((d) => d.key)), here = ix.floors.filter((d) => mine.has(d.id)), ag = here.flatMap((d) => d.agents || []);
    const onFloor = (line, biz) => { const d = ix.of(line, biz); return !!d && mine.has(d.id); };
    const jobs = (snap.jobs || []).filter((j) => onFloor(j.line, j.businessId) && j.kind !== 'legacy' && j.status !== 'archived');
    const n = (pred) => jobs.filter(pred).length;
    return {
      floor: f.floor, level: levelOf(f.floor), id: f.id, name: f.name, design: f.design, palette: f.palette, archived: f.archived, shared: false, empty: false, lounge: f.design === 'lobby',
      departments: f.departments.map((d) => d.name), lines: here.flatMap((d) => (d.lines || []).map((l) => (typeof l === 'string' ? l : l.id))),
      agents: ag.filter((a) => a.status === 'active').length, notHired: ag.filter((a) => a.status === 'not-hired').length,
      trophy: f.floor === 'G' ? archived.filter((a) => !a.retiredInto).length : 0, retired: f.floor === 'G' ? archived.filter((a) => a.retiredInto).map((a) => a.name) : [],
      jobs: { running: n((j) => j.status === 'in_progress'), waiting: n((j) => j.status === 'backlog' || j.status === 'waiting'), blocked: n((j) => j.lane === 'blocked'), done: n((j) => j.status === 'done') },
      routinesOn: (snap.routines || []).filter((r) => r.enabled && onFloor(lineOfRoutine(r), r.businessId)).length,
      todayUsd: 0, monthUsd: 0, budgetUsd: null, month: null
    };
  });
}
