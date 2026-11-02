// scene/towerplan.js — R7a (owner, 29/10/2026): the seven floors of the 3D office. Pure data, no Three.js (tests/r7a-floors.test.mjs).
//   towerFloors   the floor stack from the company model (snapshot.company.floors), top floor first. A floor is display order only:
//                 records stay keyed on product_id and department_id, and a floor's design is keyed on its department id, so moving a
//                 department to another floor (its config's `floor`) moves its design with it. The ground floor (G) is the lobby.
//   floorPeople   who is on a floor: a hired agent sits at its desk (live status from the snapshot's agents); a not-hired agent gets
//                 an empty desk with its "not hired yet (Rn)" tag; an archived agent is shown only in the lobby (the trophy cabinet,
//                 or the retired wall for one retired into another agent, OVERSEER)
//   planFloor     one floor's plan for the renderer (office.js, kit.js): palette, walls, props, desks and who sits there, screens
//   screenContent what a screen says: only data the snapshot has; an honest empty state where there is none ("no leads yet")
// Coordinates: the isometric camera looks from +x/+z, so the two back walls stand on the slab's -x edge (the 'x' wall, facing +x)
// and -z edge (the 'z' wall, facing +z); the front edges are open (a cutaway). yaw 0 faces -z, PI/2 faces -x, -PI/2 faces +x.
import { money } from '../ui/format.js';

export const SLAB = { x0: -12, x1: 12, z0: -7.5, z1: 7.5 };
export const T_WALL_H = 2.7, T_WALL_T = 0.18;
export const levelOf = (f) => { const s = String(f == null ? '' : f).toUpperCase(); return s === 'G' ? 0 : /^\d+$/.test(s) ? Number(s) : -1; };

// ---- palettes: one per floor design, light and dark. Colour roles are the kit's (kit.js).
const base = {
  light: { wall: '#f4f1ec', wallCap: '#d7d0c5', baseboard: '#ddd5c9', floor: '#cfc3b2', floorKind: 'oak', rug: '#6b6762', rugBorder: '#55524e', top: '#d9ae7c', metal: '#2e2f33', chair: '#45464c', fabric: '#8d8a86', cushion: '#a19d97', wood: '#b88a5e', accent: '#d9b26f', accent2: '#6f93d8', glass: '#cfe3ee', glassFrame: '#3a3d42', screenFrame: '#26272b', rack: '#2b2d33', led: '#79d98f', ledB: '#f0c35a', pot: '#d9cdbb', leaf: '#7aa872', leaf2: '#5f9a5c', paper: '#fbfaf6', stone: '#e3ddd3', brass: '#b8955a', slabEdge: '#d8d0c3', slabFoot: '#c4baab', screenBg: '#172033', screenFg: '#eef2f8', screenDim: '#93a0b8', boardBg: '#fbfaf7', boardFg: '#2b2a28', lamp: '#fff3dc' },
  dark: { wall: '#3c3d42', wallCap: '#18181b', baseboard: '#232427', floor: '#8e7a66', floorKind: 'oak', rug: '#4a4a4e', rugBorder: '#36363a', top: '#c99769', metal: '#141518', chair: '#3a3b40', fabric: '#55545b', cushion: '#64636a', wood: '#8a623f', accent: '#ffb15f', accent2: '#7f9cf5', glass: '#9ab7c9', glassFrame: '#101114', screenFrame: '#0e0f12', rack: '#18191d', led: '#5fe08a', ledB: '#ffcc66', pot: '#4b4844', leaf: '#5f9a63', leaf2: '#4f8a56', paper: '#d9d4ca', stone: '#4a4743', brass: '#c9a462', slabEdge: '#1d1d20', slabFoot: '#151517', screenBg: '#0d1220', screenFg: '#eef2f8', screenDim: '#93a0b8', boardBg: '#e8e4dc', boardFg: '#1f1e1c', lamp: '#ffd89c' }
};
const tone = (light, dark) => ({ light: { ...base.light, ...light }, dark: { ...base.dark, ...dark } });
export const FLOOR_PALETTES = {
  // 6: darker premium: walnut, charcoal, brass; cream leather
  penthouse: tone({ wall: '#d9d3ca', wallCap: '#3b3734', floor: '#7f6a5c', top: '#5a3f2c', wood: '#6b4a33', metal: '#2a2624', chair: '#2f2b29', fabric: '#d8ccb8', cushion: '#e4dac8', accent: '#b8955a', rug: '#3b3633', rugBorder: '#2a2624', glass: '#c7dbe6', skyA: '#c8d3dc', skyB: '#a9b8c6', skyWin: '#e9eef2', background: ['#e6edf3', '#c4d0db'] },
    { wall: '#2b2a2c', wallCap: '#0f0f10', floor: '#4e4038', top: '#4a3324', wood: '#55392a', metal: '#0f0f10', chair: '#1f1d1c', fabric: '#b6a68e', cushion: '#c4b59c', accent: '#d4ad66', rug: '#262322', rugBorder: '#171615', glass: '#5d7486', skyA: '#1a2230', skyB: '#141a26', skyWin: '#ffcf7a', background: ['#1c2536', '#090c13'] }),
  // 5: a dark room in both themes: server racks with status lights, wall dashboards
  security: tone({ wall: '#3a4150', wallCap: '#1d222b', baseboard: '#232833', floor: '#4a5160', floorKind: 'flat', top: '#596273', metal: '#1c2029', chair: '#2a2f3a', fabric: '#4b5363', rug: '#2b313d', rugBorder: '#20252f', accent: '#38c2d6', accent2: '#38c2d6', pot: '#3a404c', slabEdge: '#3a4150', slabFoot: '#2a2f3a', background: ['#dfe2e7', '#babfc8'] },
    { wall: '#1b1f27', wallCap: '#0b0d11', baseboard: '#11141a', floor: '#22262f', floorKind: 'flat', top: '#2f3542', metal: '#0b0d11', chair: '#1d2129', fabric: '#2b313c', rug: '#161a21', rugBorder: '#0f1217', accent: '#38c2d6', accent2: '#38c2d6', pot: '#22262e', background: ['#181b21', '#07080a'] }),
  // 4: neutral grey and blue; polished concrete
  engineering: tone({ wall: '#e9ecef', wallCap: '#b7bec7', baseboard: '#c9d0d8', floor: '#c4c8cc', floorKind: 'concrete', top: '#e8eaee', metal: '#4b5563', chair: '#3d5a80', fabric: '#5b7aa6', cushion: '#6f8db8', accent: '#3d7bd9', accent2: '#5b9bd5', rug: '#56657a', rugBorder: '#465468', wood: '#9aa3ad' },
    { wall: '#2e3440', wallCap: '#14171c', baseboard: '#1f232b', floor: '#4f5359', floorKind: 'concrete', top: '#3b4250', metal: '#14171c', chair: '#2c4466', fabric: '#3b5378', cushion: '#46608a', accent: '#5b9bf0', accent2: '#5b9bd5', rug: '#2c3646', rugBorder: '#222a37', wood: '#596270' }),
  // 3: bright: white, light oak, pastel accents; sticky notes and mood boards
  product: tone({ wall: '#ffffff', wallCap: '#e3e0da', baseboard: '#ece8e1', floor: '#efe6d6', top: '#f4f1ea', metal: '#c9c6c0', chair: '#f0b94c', fabric: '#f3d27a', cushion: '#f6dd95', accent: '#ef7f8f', accent2: '#58b8b0', rug: '#e9c6b8', rugBorder: '#d9ae9d', wood: '#d8b88e' },
    { wall: '#3f3e45', wallCap: '#1c1b20', floor: '#7d7262', top: '#d9d4ca', metal: '#55545b', chair: '#c9963a', fabric: '#b8964e', cushion: '#c6a660', accent: '#e06f80', accent2: '#4aa39b', rug: '#5c4a45', rugBorder: '#45383a', wood: '#a3855f' }),
  // 2: bullpen: grey-blue carpet, coral and teal accents
  sales: tone({ wall: '#f3f0ea', floor: '#8f99a6', floorKind: 'carpet', top: '#e9e4da', metal: '#3a3d44', chair: '#2f8f8a', fabric: '#e07a5f', cushion: '#e8957e', accent: '#e07a5f', accent2: '#2f8f8a', rug: '#2f8f8a', rugBorder: '#257470' },
    { wall: '#36383e', floor: '#3b424c', floorKind: 'carpet', top: '#4a4d55', metal: '#141518', chair: '#256f6b', fabric: '#b8614b', cushion: '#c47360', accent: '#ef8a6d', accent2: '#3aa59f', rug: '#1f5a57', rugBorder: '#184744' }),
  // 1: warm: terracotta, sand, sage; couches
  success: tone({ wall: '#f6ece0', wallCap: '#d8c2a8', baseboard: '#e3cfb7', floor: '#c4977a', top: '#e8d5bc', metal: '#5a4636', chair: '#b5653f', fabric: '#c9724b', cushion: '#d88a64', accent: '#c9724b', accent2: '#8aa77e', rug: '#a65a3c', rugBorder: '#8a4a31', wood: '#a8713f' },
    { wall: '#45372f', wallCap: '#1f1814', baseboard: '#2c231e', floor: '#6b5040', top: '#6b5442', metal: '#1f1814', chair: '#8f4c2f', fabric: '#9c5638', cushion: '#ab6545', accent: '#e08a5c', accent2: '#7d9b72', rug: '#5e3424', rugBorder: '#4a281b', wood: '#7a5130' }),
  // G: stone, brass and greenery; reception, the lounge, the trophy cabinet
  lobby: tone({ wall: '#efe9df', wallCap: '#b8a98f', baseboard: '#d6cbb8', floor: '#e2dbd0', floorKind: 'stone', top: '#d9cfbf', metal: '#2f3034', chair: '#3f5e4d', fabric: '#4f6f5c', cushion: '#5f8070', accent: '#b8955a', rug: '#3f5e4d', rugBorder: '#2f4a3b', wood: '#7a5a3c' },
    { wall: '#37352f', wallCap: '#14130f', baseboard: '#24221d', floor: '#5a564f', floorKind: 'stone', top: '#4d473e', metal: '#121214', chair: '#2f4a3b', fabric: '#3b5a49', cushion: '#46685a', accent: '#d4ad66', rug: '#26392f', rugBorder: '#1b2a22', wood: '#5d4430' }),
  generic: tone({}, {})
};

// ---- the designs, keyed on the department id; G is always the lobby. title: the short name the floor menu and the lift show.
export const DESIGNS = {
  hq: { key: 'penthouse', title: 'Penthouse HQ', palette: 'penthouse' },
  'security-data': { key: 'security', title: 'Security & Data', palette: 'security' },
  engineering: { key: 'engineering', title: 'Engineering', palette: 'engineering' },
  'product-design': { key: 'product', title: 'Product & Design', palette: 'product' },
  'sales-marketing': { key: 'sales', title: 'Sales & Marketing', palette: 'sales' },
  'customer-success': { key: 'success', title: 'Customer Success', palette: 'success' }
};
const LOBBY = { key: 'lobby', title: 'Lobby', palette: 'lobby' };
export function designOf(floor, deptIds) {
  if (String(floor).toUpperCase() === 'G') return LOBBY;
  for (const id of deptIds) if (DESIGNS[id]) return DESIGNS[id];
  return { key: 'generic', title: null, palette: 'generic' };
}

// ---- the stack: company.floors (one entry per department) grouped by floor, top floor first
export function towerFloors(snap) {
  const c = snap && snap.company; if (!c || !Array.isArray(c.floors) || !c.floors.length) return [];
  const by = new Map();
  for (const d of c.floors) { const k = String(d.floor).toUpperCase(); if (!by.has(k)) by.set(k, []); by.get(k).push(d); }
  return [...by.entries()].map(([floor, depts]) => {
    const d = designOf(floor, depts.map((x) => x.id));
    return { floor, level: levelOf(floor), id: depts[0].id, design: d.key, palette: d.palette, name: d.title || depts[0].name, departments: depts.map((x) => ({ key: x.id, name: x.name, status: x.status })), archived: depts.every((x) => x.status === 'archived') };
  }).sort((a, b) => b.level - a.level);
}

// ---- who is on a floor
export function floorPeople(snap, floor) {
  const c = (snap && snap.company) || { floors: [] }, key = String(floor).toUpperCase();
  const live = Object.fromEntries(((snap && snap.agents) || []).map((a) => [a.id, a]));
  const here = c.floors.filter((d) => String(d.floor).toUpperCase() === key);
  const desks = [], cabinet = [], retired = [];
  for (const d of here) for (const a of d.agents || []) {
    if (a.status === 'archived') continue;
    const hired = a.status === 'active', l = live[a.id];
    desks.push({ agentId: a.id, name: a.name, deptId: d.id, state: hired ? 'hired' : 'not-hired', label: a.label, phase: a.phase || null, drawn: hired && !!l, work: hired ? (l ? l.status : 'idle') : null });
  }
  if (key === 'G') for (const d of c.floors) for (const a of d.agents || []) {
    if (a.status !== 'archived') continue;
    const l = live[a.id];
    (a.retiredInto ? retired : cabinet).push({ agentId: a.id, name: a.name, deptId: d.id, label: a.label, color: (l && l.color) || null, product: d.product || null });
  }
  return { desks, cabinet, retired };
}

// ---- the plans. Helpers: a rug, a desk slot, a screen on a back wall or on its own stand
const rug = (x0, z0, x1, z1, role = 'rug') => ({ kind: 'rug', x0, z0, x1, z1, role });
const slot = (x, z, yaw = 0, kind = 'desk', role = null) => ({ x, z, yaw, kind, role });
const onX = (id, kind, u, y, w, h, style = 'screen') => ({ id, kind, x: SLAB.x0 + T_WALL_T + 0.06, y, z: u, yaw: -Math.PI / 2, w, h, style, wall: 'x' });
const onZ = (id, kind, u, y, w, h, style = 'screen') => ({ id, kind, x: u, y, z: SLAB.z0 + T_WALL_T + 0.06, yaw: Math.PI, w, h, style, wall: 'z' });
const stand = (id, kind, x, z, yaw, y, w, h) => ({ id, kind, x, y, z, yaw, w, h, style: 'screen', stand: true });
const LIFT = { kind: 'lift', x: SLAB.x0 + T_WALL_T, z: 5.6 };
const plants = (list) => list.map(([x, z, tall]) => ({ kind: 'plant', x, z, tall: !!tall }));
const ring = (cx, cz, r, n, a0 = Math.PI / 4) => Array.from({ length: n }, (_, i) => { const a = a0 + i * 2 * Math.PI / n; return { kind: 'chair', x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r, yaw: a }; });
// a screen's yaw is the furniture's: its face looks along local -z (onX: -PI/2 faces +x; onZ: PI faces +z); y is its centre's height
// above the floor

const LAYOUTS = {
  // 6: glass walls and the city below; the Owner's office (the requests screen), the executive suite, COMPLIANCE in its own glass room,
  // the boardroom with the Finance screen, a lounge corner and the roof-terrace rail
  penthouse: () => ({
    walls: { x: 'glass', z: 'glass' }, skyline: true, terrace: true,
    slots: [slot(-2.8, -5.0, 0, 'exec', 'ceo'), slot(1.0, -5.0, 0, 'exec', 'cto'), slot(4.8, -5.0, 0, 'exec', 'coo'), slot(9.9, -4.8, 0, 'desk', 'compliance')],
    props: [
      rug(-11.4, -7.0, -6.0, -2.2), { kind: 'glass', x0: -5.6, z0: -7.32, x1: -5.6, z1: -1.8 }, { kind: 'glass', x0: -11.82, z0: -1.8, x1: -9.0, z1: -1.8 }, { kind: 'glass', x0: -7.6, z0: -1.8, x1: -5.6, z1: -1.8 },
      { kind: 'execDesk', x: -8.7, z: -5.0, yaw: 0 }, { kind: 'chair', x: -9.3, z: -6.5, yaw: Math.PI }, { kind: 'chair', x: -8.1, z: -6.5, yaw: Math.PI },
      { kind: 'shelf', x: -6.4, z: -7.0, yaw: Math.PI, w: 1.2, h: 1.9 }, ...plants([[-11.2, -2.4, 1]]),
      rug(-5.0, -7.0, 6.6, -3.0), { kind: 'glass', x0: -0.9, z0: -7.32, x1: -0.9, z1: -3.6, h: 1.5 }, { kind: 'glass', x0: 2.9, z0: -7.32, x1: 2.9, z1: -3.6, h: 1.5 }, ...plants([[-4.9, -6.9], [6.5, -6.9]]),
      { kind: 'glass', x0: 7.4, z0: -7.32, x1: 7.4, z1: -2.0 }, { kind: 'glass', x0: 7.4, z0: -2.0, x1: 8.2, z1: -2.0 }, { kind: 'glass', x0: 9.6, z0: -2.0, x1: 11.9, z1: -2.0 },
      rug(7.8, -7.0, 11.6, -2.4, 'rugAccent'), ...plants([[11.3, -6.9, 1]]),
      rug(-10.6, 0.8, -1.4, 5.8), { kind: 'table', x: -6.0, z: 3.4, yaw: 0, w: 5.6, d: 1.8 },
      ...[-8.0, -6.6, -5.2, -3.9].flatMap((x) => [{ kind: 'chair', x, z: 2.15, yaw: Math.PI, exec: true }, { kind: 'chair', x, z: 4.65, yaw: 0, exec: true }]),
      { kind: 'chair', x: -9.5, z: 3.4, yaw: -Math.PI / 2, exec: true }, { kind: 'chair', x: -2.5, z: 3.4, yaw: Math.PI / 2, exec: true },
      rug(1.8, 1.6, 8.6, 7.0), { kind: 'couch', x: 5.2, z: 6.3, yaw: 0, len: 3.0 }, { kind: 'armchair', x: 2.8, z: 4.0, yaw: -Math.PI / 2 }, { kind: 'armchair', x: 7.6, z: 4.0, yaw: Math.PI / 2 },
      { kind: 'coffeeTable', x: 5.2, z: 4.1, w: 1.8, d: 1.0 }, ...plants([[1.6, 7.0, 1], [8.8, 7.0, 1]]), { kind: 'counter', x: 10.6, z: 3.2, yaw: Math.PI / 2, w: 2.8 }, { kind: 'floorLamp', x: 9.4, z: 1.0 },
      LIFT
    ],
    // R3: the CEO's memo board on the far side of the boardroom table, facing it and the room (the latest memo's proposals and the owner's
    // marks)
    screens: [stand('requests', 'requests', -11.2, -4.4, -Math.PI / 2, 1.45, 2.4, 1.4), stand('finance', 'finance', -11.2, 2.0, -Math.PI / 2, 1.5, 3.2, 1.8), stand('memo', 'memo', -6.0, 0.9, Math.PI, 1.5, 3.0, 1.6), { id: 'compliance-sign', kind: 'compliance-sign', x: 10.8, y: 2.0, z: -1.98, yaw: Math.PI, w: 2.2, h: 0.46, style: 'glass-sign' }],
    hub: 'finance'
  }),
  // 5: a dark room: the server room behind glass (two rows of racks with status lights, the services on the first row), the wall
  // dashboards, the SECURITY and ANALYST desks, a glass data room, lockers
  security: () => ({
    walls: { x: 'solid', z: 'solid' }, dark: true,
    slots: [slot(-2.2, -3.8, 0, 'desk', 'security'), slot(2.0, -3.8, 0, 'desk', 'analyst')],
    racks: [...[-6.6, -5.75, -4.9, -4.05, -3.2, -2.35, -1.5].map((z) => ({ x: -11.2, z, yaw: -Math.PI / 2 })), ...[-6.6, -5.75, -4.9, -4.05, -3.2, -2.35, -1.5].map((z) => ({ x: -8.4, z, yaw: -Math.PI / 2 }))],
    props: [
      { kind: 'glass', x0: -6.4, z0: -7.32, x1: -6.4, z1: -0.6 }, { kind: 'glass', x0: -11.82, z0: -0.6, x1: -9.6, z1: -0.6 }, { kind: 'glass', x0: -8.2, z0: -0.6, x1: -6.4, z1: -0.6 },
      { kind: 'floorLed', x0: -9.93, z0: -7.0, x1: -9.87, z1: -1.0 }, { kind: 'floorLed', x0: -7.23, z0: -7.0, x1: -7.17, z1: -1.0 }, { kind: 'cableTray', x0: -11.6, z0: -7.1, x1: -6.6, z1: -6.8 },
      rug(-4.6, -5.6, 4.4, -1.6), { kind: 'floorLed', x0: -4.6, z0: -1.33, x1: 4.4, z1: -1.27 },
      { kind: 'glass', x0: 3.0, z0: 1.2, x1: 9.0, z1: 1.2 }, { kind: 'glass', x0: 9.0, z0: 1.2, x1: 9.0, z1: 5.8 }, { kind: 'glass', x0: 3.0, z0: 5.8, x1: 9.0, z1: 5.8 }, { kind: 'glass', x0: 3.0, z0: 1.2, x1: 3.0, z1: 2.8 }, { kind: 'glass', x0: 3.0, z0: 4.2, x1: 3.0, z1: 5.8 },
      { kind: 'table', x: 6.0, z: 3.5, yaw: 0, w: 2.4, d: 1.2 }, { kind: 'chair', x: 5.4, z: 2.4, yaw: Math.PI }, { kind: 'chair', x: 6.6, z: 2.4, yaw: Math.PI }, { kind: 'chair', x: 5.4, z: 4.6, yaw: 0 }, { kind: 'chair', x: 6.6, z: 4.6, yaw: 0 },
      { kind: 'lockers', x: -11.5, z: 2.0, yaw: -Math.PI / 2, n: 6 }, { kind: 'shelf', x: 10.4, z: -6.9, yaw: Math.PI, w: 2.0, h: 1.9, binders: true }, ...plants([[11.2, 7.0], [-2.0, 6.8]]),
      rug(-8.8, 3.2, -2.4, 7.0), { kind: 'armchair', x: -6.8, z: 6.0, yaw: 0 }, { kind: 'armchair', x: -4.6, z: 6.0, yaw: 0 }, { kind: 'coffeeTable', x: -5.7, z: 4.6, w: 1.4, d: 0.8 }, { kind: 'armchair', x: -8.0, z: 4.4, yaw: -Math.PI / 2 }, LIFT
    ],
    screens: [onZ('services', 'services', -3.6, 1.5, 3.4, 1.9), onZ('engine', 'engine', 0.2, 1.5, 3.4, 1.9), onZ('policy', 'policy', 4.0, 1.5, 3.4, 1.9), onZ('metrics', 'metrics', 8.4, 1.5, 3.6, 1.9)],
    services: true
  }),
  // 4: open plan, neutral grey and blue: the dev pod of standing desks, the kanban board, the checks screen, the test bench, a lounge,
  // a meeting table
  engineering: () => ({
    walls: { x: 'solid', z: 'solid' },
    slots: [slot(-8.4, -4.6, 0, 'standing', 'tech-lead'), slot(-4.6, -4.6, 0, 'standing', 'developer'), slot(-8.4, -1.0, 0, 'standing', 'reviewer'), slot(-4.6, -1.0, 0, 'standing', 'tester')],
    props: [
      rug(-10.8, -6.2, -2.4, 0.9), { kind: 'workbench', x: 8.4, z: -6.4, yaw: 0, w: 3.6 }, { kind: 'stool', x: 7.6, z: -5.3 }, { kind: 'stool', x: 9.2, z: -5.3 },
      { kind: 'planter', x: 11.3, z: -1.6, yaw: Math.PI / 2, len: 3.0 }, { kind: 'planter', x: -7.0, z: 2.0, yaw: 0, len: 7.0 }, rug(2.6, -4.0, 8.0, -0.4), { kind: 'pingpong', x: 5.3, z: -2.2, yaw: 0 },
      rug(-10.4, 3.0, -3.6, 7.0), { kind: 'couch', x: -6.6, z: 6.3, yaw: 0, len: 2.8 }, { kind: 'armchair', x: -9.0, z: 4.6, yaw: -Math.PI / 2 }, { kind: 'coffeeTable', x: -6.6, z: 4.5, w: 1.6, d: 0.8 },
      rug(3.2, 1.4, 8.4, 6.4), { kind: 'roundTable', x: 5.8, z: 3.9, r: 0.9 }, ...ring(5.8, 3.9, 1.5, 4),
      ...plants([[-11.2, -6.9, 1], [-1.6, -6.9], [11.2, 6.9, 1], [0.8, 6.8], [11.2, 0.6]]), LIFT
    ],
    screens: [onZ('kanban', 'kanban', 2.2, 1.45, 6.0, 2.0, 'board'), onX('checks', 'checks', -2.8, 1.5, 3.0, 1.7)],
    eng: 'checks'
  }),
  // 3: bright: the sticky-note wall, mood boards, the roadmap board over the two desks, the big table, an easel, beanbags
  product: () => ({
    walls: { x: 'solid', z: 'solid' },
    slots: [slot(3.2, -4.0, 0, 'desk', 'product-manager'), slot(7.2, -4.0, 0, 'desk', 'ux-designer')],
    props: [
      { kind: 'stickies', x: SLAB.x0 + T_WALL_T + 0.03, z: -3.0, yaw: -Math.PI / 2, w: 7.0, h: 1.8, y: 1.35 },
      ...[-8.4, -5.4, -2.4].map((u) => ({ kind: 'moodboard', x: u, z: SLAB.z0 + T_WALL_T + 0.03, yaw: Math.PI, w: 2.6, h: 1.5, y: 1.5, seed: Math.round(-u * 10) })),
      rug(1.6, -5.8, 9.0, -2.2, 'rugAccent'),
      rug(-8.4, -0.4, 0.4, 4.8), { kind: 'table', x: -4.0, z: 2.2, yaw: 0, w: 5.2, d: 2.2, papers: true },
      ...[-5.8, -4.0, -2.2].flatMap((x) => [{ kind: 'chair', x, z: 0.85, yaw: Math.PI }, { kind: 'chair', x, z: 3.55, yaw: 0 }]), { kind: 'chair', x: -7.2, z: 2.2, yaw: -Math.PI / 2 }, { kind: 'chair', x: -0.8, z: 2.2, yaw: Math.PI / 2 },
      { kind: 'easel', x: -9.6, z: 2.4, yaw: -Math.PI / 3 }, { kind: 'planter', x: 11.3, z: -0.6, yaw: Math.PI / 2, len: 2.6 },
      rug(3.0, 3.4, 9.8, 7.0), { kind: 'couch', x: 6.4, z: 6.3, yaw: 0, len: 2.6 }, { kind: 'beanbag', x: 4.0, z: 4.8 }, { kind: 'beanbag', x: 8.8, z: 4.8 }, { kind: 'coffeeTable', x: 6.4, z: 4.6, w: 1.4, d: 0.8 },
      ...plants([[-11.2, 1.6, 1], [11.2, -6.9, 1], [11.2, 6.9], [0.8, 6.9], [-0.6, -6.9]]), LIFT
    ],
    screens: [onZ('roadmap', 'roadmap', 5.2, 1.45, 4.2, 1.9, 'board')]
  }),
  // 2: the bullpen (four desks), the leaderboard, the pipeline board, two phone booths, a standing bar table, a lounge
  sales: () => ({
    walls: { x: 'solid', z: 'solid' },
    slots: [slot(-7.4, -4.6, 0, 'desk', 'lead-researcher'), slot(-3.4, -4.6, 0, 'desk', 'lead-checker'), slot(-7.4, -1.0, 0, 'desk', 'outreach-writer'), slot(-3.4, -1.0, 0, 'desk', 'content-writer')],
    props: [
      rug(-10.0, -6.2, -0.8, 1.0), { kind: 'booth', x: 7.8, z: -6.3, yaw: Math.PI }, { kind: 'booth', x: 9.9, z: -6.3, yaw: Math.PI },
      { kind: 'table', x: 4.2, z: 2.4, yaw: 0, w: 2.4, d: 1.0, h: 1.05 }, { kind: 'stool', x: 3.4, z: 3.3 }, { kind: 'stool', x: 5.0, z: 3.3 }, { kind: 'stool', x: 3.4, z: 1.5 }, { kind: 'stool', x: 5.0, z: 1.5 },
      rug(-9.0, 3.0, -2.6, 7.0), { kind: 'couch', x: -5.8, z: 6.3, yaw: 0, len: 2.8 }, { kind: 'armchair', x: -8.2, z: 4.6, yaw: -Math.PI / 2 }, { kind: 'coffeeTable', x: -5.8, z: 4.6, w: 1.6, d: 0.8 },
      { kind: 'planter', x: 11.3, z: 1.8, yaw: Math.PI / 2, len: 2.6 }, { kind: 'planter', x: 4.4, z: -1.4, yaw: Math.PI / 2, len: 3.0 },
      ...plants([[-11.2, -6.9, 1], [-0.4, -6.9], [11.2, 6.9, 1], [1.2, 6.9], [11.2, -2.6]]), LIFT
    ],
    screens: [onZ('leaderboard', 'leaderboard', 2.8, 1.45, 4.4, 2.0), onX('pipeline', 'pipeline', 1.0, 1.4, 3.4, 1.7, 'board')]
  }),
  // 1: warm: the three desks, the support-queue screen, the onboarding board, two lounge groups of couches, a tea point
  success: () => ({
    walls: { x: 'solid', z: 'solid' },
    slots: [slot(-8.2, -4.6, 0, 'desk', 'onboarding-guide'), slot(-4.4, -4.6, 0, 'desk', 'support-drafter'), slot(-0.6, -4.6, 0, 'desk', 'retention-analyst')],
    props: [
      rug(-10.6, -6.2, 1.8, -2.4),
      rug(-9.4, 0.4, -1.8, 6.8, 'rugAccent'), { kind: 'couch', x: -5.6, z: 5.7, yaw: 0, len: 3.0 }, { kind: 'couch', x: -5.6, z: 1.5, yaw: Math.PI, len: 3.0 }, { kind: 'coffeeTable', x: -5.6, z: 3.6, w: 1.8, d: 0.9 }, { kind: 'floorLamp', x: -8.6, z: 6.2 },
      rug(1.8, 2.0, 9.4, 7.0), { kind: 'couch', x: 5.6, z: 6.3, yaw: 0, len: 2.8 }, { kind: 'armchair', x: 3.2, z: 4.3, yaw: -Math.PI / 2 }, { kind: 'armchair', x: 8.0, z: 4.3, yaw: Math.PI / 2 }, { kind: 'coffeeTable', x: 5.6, z: 4.3, w: 1.6, d: 0.9 },
      { kind: 'floorLamp', x: 9.0, z: 6.6 }, { kind: 'counter', x: 10.8, z: -1.2, yaw: Math.PI / 2, w: 2.6 }, { kind: 'shelf', x: 10.2, z: -6.9, yaw: Math.PI, w: 2.2, h: 1.6 },
      ...plants([[-11.2, -6.9, 1], [2.6, -6.9], [11.2, 6.9, 1], [0.6, 6.9], [-11.0, -0.4]]), LIFT
    ],
    screens: [onZ('support', 'support', 5.6, 1.45, 4.4, 2.0), onX('onboarding', 'onboarding', -1.0, 1.4, 3.2, 1.7, 'board')]
  }),
  // G: the lobby: the station's sign over reception, the trophy cabinet of the archived Etsy agents (TheStationShopFinds), OVERSEER's
  // portrait (retired; R7a.2: on the back wall over the pool, apart from the cabinet), the directory by the lift, a pool, the lounge
  lobby: () => ({
    walls: { x: 'solid', z: 'solid' }, lobby: true,
    slots: [],
    props: [
      rug(-4.6, -6.2, 2.6, -1.4, 'rugAccent'), { kind: 'reception', x: -1.0, z: -3.8, yaw: Math.PI }, { kind: 'chair', x: -1.0, z: -5.2, yaw: Math.PI },
      { kind: 'cabinet', x: SLAB.x0 + T_WALL_T + 0.36, z: -3.2, yaw: -Math.PI / 2, w: 6.0, h: 2.25 },
      { kind: 'bench', x: -3.0, z: 0.9, yaw: 0, len: 2.4 }, { kind: 'bench', x: 1.0, z: 0.9, yaw: 0, len: 2.4 },
      { kind: 'pool', x: 6.6, z: -4.2, w: 4.2, d: 2.0 },
      rug(1.2, 2.0, 11.4, 7.0), { kind: 'couch', x: 5.8, z: 6.3, yaw: 0, len: 3.2 }, { kind: 'couch', x: 10.4, z: 4.4, yaw: Math.PI / 2, len: 2.8 }, { kind: 'armchair', x: 2.6, z: 3.6, yaw: -Math.PI / 2 }, { kind: 'armchair', x: 2.6, z: 5.4, yaw: -Math.PI / 2 },
      { kind: 'coffeeTable', x: 6.0, z: 4.3, w: 2.0, d: 1.1 }, { kind: 'floorLamp', x: 11.2, z: 6.8 },
      ...plants([[-6.0, -6.9, 1], [3.6, -6.9, 1], [11.2, -6.9, 1], [11.2, 1.6, 1], [0.8, 6.9, 1], [-9.6, 6.9]]), LIFT
    ],
    screens: [onZ('sign', 'sign', -1.0, 1.75, 5.4, 0.8, 'sign'), { id: 'trophy', kind: 'trophy', x: SLAB.x0 + T_WALL_T + 0.04, y: 2.45, z: -3.2, yaw: -Math.PI / 2, w: 5.0, h: 0.3, style: 'plate' }, onZ('retired', 'retired', 5.4, 1.45, 1.3, 1.6, 'portrait'), onX('directory', 'directory', 3.0, 1.4, 1.8, 2.0)],
    trophy: true
  }),
  generic: () => ({ walls: { x: 'solid', z: 'solid' }, slots: [], props: [LIFT], screens: [] })
};

// seats beyond a design's slots (a department grew): rows of desks across the front of the floor
function extraSlots(n, used) {
  const out = [];
  for (let i = 0; out.length < n && i < 40; i++) { const s = slot(-8 + (i % 5) * 4.0, 1.4 + Math.floor(i / 5) * 3.0, 0, 'desk'); if (!used.some((u) => Math.abs(u.x - s.x) < 2.4 && Math.abs(u.z - s.z) < 2.4)) out.push(s); }
  return out;
}

// a desk's parts in world space: the chair, where the person sits or stands, the monitor, the status light, the label anchor
export function seatFrame(s) {
  const c = Math.cos(s.yaw || 0), sn = Math.sin(s.yaw || 0), at = (lx, lz) => ({ x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c });
  const stand = s.kind === 'standing';
  return { chair: stand ? null : at(0, 0.98), person: stand ? at(0, 0.62) : at(0, 0.83), monitor: at(0, -0.24), light: at(0.9, 0.34), stand, topY: stand ? 1.05 : s.kind === 'exec' ? 0.75 : 0.73 };
}

export function planFloor(snap, floor) {
  const fl = towerFloors(snap).find((f) => f.floor === String(floor).toUpperCase()); if (!fl) return null;
  const L = (LAYOUTS[fl.design] || LAYOUTS.generic)(), people = floorPeople(snap, fl.floor);
  // seats: an agent with a slot of its own (role) takes it; the rest fill the free slots in order, then extra desks
  const free = L.slots.filter((s) => !s.role || !people.desks.some((d) => d.agentId === s.role));
  const seats = [];
  for (const d of people.desks) {
    let s = L.slots.find((x) => x.role === d.agentId);
    if (!s) s = free.shift();
    if (!s) s = extraSlots(1, [...L.slots, ...seats])[0];
    seats.push({ ...s, ...d, frame: seatFrame(s) });
  }
  const screens = L.screens.map((sc) => ({ ...sc, content: screenContent(sc.kind, snap, { floor: fl, people }) }));
  screens.push({ id: 'lift', kind: 'lift', x: SLAB.x0 + T_WALL_T + 0.06, y: 2.43, z: LIFT.z, yaw: -Math.PI / 2, w: 0.9, h: 0.3, style: 'lift', content: screenContent('lift', snap, { floor: fl }) });
  // the trophy cabinet: a figurine per archived agent (four to a shelf) with a name plate in front of each
  const cab = L.trophy ? L.props.find((p) => p.kind === 'cabinet') : null, figurines = [];
  if (cab) {
    const per = 4, tiers = [1.58, 1.0, 0.42], at = (lx, lz) => ({ x: cab.x + lx * Math.cos(cab.yaw) + lz * Math.sin(cab.yaw), z: cab.z - lx * Math.sin(cab.yaw) + lz * Math.cos(cab.yaw) });
    people.cabinet.slice(0, per * tiers.length).forEach((a, i) => { const t = Math.floor(i / per), k = i % per, p = at(-cab.w / 2 + (k + 0.5) * cab.w / per, 0.06); figurines.push({ agentId: a.agentId, name: a.name, color: a.color, x: p.x, y: tiers[t] + 0.015, z: p.z, yaw: cab.yaw }); });
    for (let t = 0; t * per < Math.min(people.cabinet.length, per * tiers.length); t++) {
      const p = at(0, -0.2);
      screens.push({ id: 'names-' + t, kind: 'names', x: p.x, y: tiers[t] + 0.075, z: p.z, yaw: cab.yaw, w: cab.w - 0.2, h: 0.11, style: 'strip', content: { names: people.cabinet.slice(t * per, t * per + per).map((a) => a.name), slots: per } });
    }
  }
  return {
    floor: fl.floor, level: fl.level, id: fl.id, design: fl.design, palette: fl.palette, name: fl.name, departments: fl.departments, archived: fl.archived,
    slab: SLAB, walls: L.walls, skyline: !!L.skyline, terrace: !!L.terrace, dark: !!L.dark,
    props: L.props, racks: L.racks || [], owner: L.owner || null, seats, screens, figurines, cabinet: L.trophy ? people.cabinet : [], retired: L.trophy ? people.retired : [],
    services: !!L.services, hub: L.hub || null, eng: L.eng || null, trophy: !!L.trophy
  };
}

// ---- what each screen says (the content model; boards.js draws it). Rows: { label, value, tone: ok|warn|bad|muted, bar: 0..1 }
const ENG_COLUMNS = [['Queued', (s) => !['running', 'approval', 'blocked', 'stopped', 'done', 'approved'].includes(s)], ['In progress', (s) => s === 'running'], ['Blocked', (s) => s === 'blocked' || s === 'stopped'], ['Waiting for you', (s) => s === 'approval'], ['Done', (s) => s === 'done' || s === 'approved']];
const agentLabel = (snap, id) => { for (const d of ((snap && snap.company) || {}).floors || []) for (const a of d.agents || []) if (a.id === id) return a; return null; };
export function screenContent(kind, snap, { floor = null, people = null } = {}) {
  const s = snap || {}, c = s.company || {}, oo = c.ownersOffice || {};
  switch (kind) {
    case 'requests': {
      const pending = (oo.requests || []).filter((r) => r.status === 'pending');
      return { title: 'Requests waiting', big: String(pending.length), bigLabel: pending.length === 1 ? 'request waits for your decision' : 'requests wait for your decision', rows: pending.slice(0, 3).map((r) => ({ label: r.summary, value: r.action })), empty: pending.length ? null : 'nothing waiting' };
    }
    case 'finance': {
      const prods = (s.spend && s.spend.byProduct) || [];
      return { title: 'Spend this month', rows: prods.map((p) => { const pct = p.budgetUsd ? p.monthUsd / p.budgetUsd : null; return { label: p.name + (p.status === 'archived' ? ' (archived)' : ''), value: money(p.monthUsd) + (p.budgetUsd != null ? ' / ' + money(p.budgetUsd) : ''), bar: pct == null ? null : Math.min(1, pct), tone: pct == null ? 'muted' : pct >= 1 ? 'bad' : pct >= 0.8 ? 'warn' : 'ok' }; }), empty: prods.length ? null : 'no products yet', foot: 'from the ledger · against each product\'s budget' };
    }
    case 'checks': {
      const e = s.engineering; if (!e) return { title: 'Checks', rows: [], empty: 'no engineering line' };
      const cur = e.current || null, last = e.lastChecks || null;
      const rows = [];
      if (cur) rows.push({ label: 'job', value: cur.title }, { label: 'step', value: cur.state === 'running' ? (cur.step || '—') : cur.state, tone: cur.state === 'running' ? 'ok' : 'muted' });
      if (last) { rows.push({ label: 'last sandbox run', value: 'pass ' + (last.pass || '—'), tone: 'muted' }); for (const r of last.results) rows.push({ label: r.check, value: r.passed ? 'passed' : 'failed', tone: r.passed ? 'ok' : 'bad' }); }
      return { title: 'Checks', rows, empty: rows.length ? null : 'no checks run yet', foot: cur ? null : 'no job yet' };
    }
    case 'kanban': {
      const jobs = (s.jobs || []).filter((j) => j.kind === 'engineering' && j.state !== 'archived');
      return { title: 'Engineering board', columns: ENG_COLUMNS.map(([name, f]) => ({ name, cards: jobs.filter((j) => f(j.state)).map((j) => j.title || j.id) })), empty: jobs.length ? null : 'no jobs yet' };
    }
    case 'services': {
      const sv = s.services || [];
      return { title: 'Services', rows: sv.map((x) => ({ label: x.label, value: x.status, tone: x.status === 'configured' ? 'ok' : x.status === 'offline' ? 'bad' : x.status === 'manual' ? 'muted' : 'warn' })), empty: sv.length ? null : 'no services' };
    }
    case 'engine': {
      const e = s.engine || {}, sp = (s.spend && s.spend.today) || null, cap = s.spend && s.spend.caps ? s.spend.caps.perDay : null;
      if (!s.engine) return { title: 'Engine', rows: [], empty: 'no engine' };
      return { title: 'Engine', rows: [{ label: 'state', value: e.halted ? 'E-STOP on' : 'running', tone: e.halted ? 'bad' : 'ok' }, { label: 'provider', value: e.provider || '—' }, { label: 'calls in flight', value: String(e.inFlight || 0) }, { label: 'spend today', value: sp ? money(sp.usd) + (cap ? ' / ' + money(cap) + ' cap' : '') : '—', bar: sp && cap ? Math.min(1, sp.usd / cap) : null, tone: 'ok' }, { label: 'ledger rows', value: String(((s.hub || {}).ledger || {}).rows ?? '—') }] };
    }
    // R3: the CEO's latest memo (its proposals, each with the owner's mark) and the date of the COO's latest report
    case 'memo': {
      const x = oo.execs || null, m = x && x.ceo ? x.ceo.latest : null, rep = x && x.coo ? x.coo.latest : null;
      if (!x) return { title: 'CEO memo', rows: [], empty: 'no executives' };
      const foot = rep ? 'COO report ' + rep.day : (x.coo && x.coo.status !== 'active' ? 'COO not hired yet' : 'no COO report yet');
      if (!m) return { title: 'CEO memo', rows: [], empty: x.ceo && x.ceo.status !== 'active' ? 'CEO not hired yet' : 'no memo yet', foot };
      return { title: 'CEO memo ' + m.week, rows: m.proposals.slice(0, 4).map((p) => ({ label: p.id + ' ' + p.title, value: p.mark ? p.mark.mark : 'open', tone: !p.mark ? 'warn' : p.mark.mark === 'taken' ? 'ok' : 'muted' })), empty: m.proposals.length ? null : 'no proposal this week', foot };
    }
    case 'policy': {
      const p = oo.policy;
      return p ? { title: 'Autonomy policy', rows: [{ label: 'auto', value: String(p.counts.auto) }, { label: 'owner decides', value: String(p.counts.owner), tone: 'warn' }, { label: 'forbidden', value: String(p.counts.forbidden), tone: 'bad' }], foot: 'read only · ' + String(p.sha256 || '').slice(0, 12) } : { title: 'Autonomy policy', rows: [], empty: 'no policy loaded' };
    }
    case 'metrics': { const a = agentLabel(s, 'analyst'); return { title: 'Metrics', rows: [], empty: 'no metrics yet', foot: a && a.status !== 'active' ? 'ANALYST: ' + a.label : 'aggregates only' }; }
    case 'leaderboard': { const a = agentLabel(s, 'lead-researcher'); return { title: 'Leaderboard', rows: [], empty: 'no leads yet', foot: a && a.status !== 'active' ? 'LEAD-RESEARCHER: ' + a.label : null }; }
    case 'support': { const a = agentLabel(s, 'support-drafter'); return { title: 'Support queue', rows: [], empty: 'no tickets yet', foot: a && a.status !== 'active' ? 'SUPPORT-DRAFTER: ' + a.label : null }; }
    case 'pipeline': { const a = agentLabel(s, 'outreach-writer'); return { title: 'Pipeline', rows: [], empty: 'no pipeline yet', foot: a && a.status !== 'active' ? 'OUTREACH-WRITER: ' + a.label : null }; }
    case 'onboarding': { const a = agentLabel(s, 'onboarding-guide'); return { title: 'Onboarding', rows: [], empty: 'no customers yet', foot: a && a.status !== 'active' ? 'ONBOARDING-GUIDE: ' + a.label : null }; }
    case 'directory': return { title: 'Directory', rows: towerFloors(s).map((f) => ({ label: f.floor, value: f.name, tone: floor && f.floor === floor.floor ? 'ok' : null })) };
    case 'roadmap': { const a = agentLabel(s, 'product-manager'); return { title: 'Roadmap', rows: [], empty: 'no roadmap yet', foot: a && a.status !== 'active' ? 'PRODUCT-MANAGER: ' + a.label : null }; }
    case 'sign': return { title: ((s.station || {}).name || 'Station').toUpperCase(), sub: 'Lobby' };
    case 'compliance-sign': { const a = agentLabel(s, 'compliance'); return { title: 'COMPLIANCE', sub: a && a.reportsTo === 'owner' ? 'independent · reports to the owner' : 'independent' }; }
    case 'trophy': {
      const cab = (people || floorPeople(s, 'G')).cabinet, pid = cab.length ? cab[0].product : null, prod = (c.products || []).find((p) => p.id === pid);
      return { title: prod ? prod.name : 'Archive', sub: cab.length + ' archived agent' + (cab.length === 1 ? '' : 's'), names: cab.map((a) => a.name) };
    }
    case 'retired': { const r = (people || floorPeople(s, 'G')).retired[0]; return r ? { title: r.name, sub: r.label } : { title: '', sub: '', empty: 'nobody retired' }; }
    case 'lift': return { title: floor ? floor.floor : '' };
    default: return { title: kind, rows: [], empty: 'no data' };
  }
}
