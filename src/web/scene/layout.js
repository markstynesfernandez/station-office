// scene/layout.js — the office floor plan (Redesign R1, tightened in R2). Pure data, no Three.js, so it can be
// unit-tested in Node. One floor slab seen from the isometric camera (which looks from +x/+z): three department rooms
// and a lounge sit in the four corners round a central atrium with the memory core; a small server closet sits in the
// back gap between the two back rooms, its cabinets in a row facing the core. Every room is a cutaway: two back walls
// (on its -x and -z sides), an open front, no ceiling. Rooms in the same column share a width and rooms in the same row
// share a depth, so the outer back walls run in one line along the slab.
// R2: the atrium is about 40% smaller (the band between the rows 6.8 -> 4.3 deep, the gap between the columns
// 9.3 -> 5.4 wide), the core plinth and its walking ring shrink to fit, and the left-over floor holds props (printer,
// water cooler, benches, a meeting table, an easel) listed here so the path test can check the walkers miss them.
// Idle agents walk desk -> lounge seat along precomputed waypoint paths (no pathfinding, no physics): inside the room
// to its exit, then straight to the lounge gate when that line is clear, otherwise round a ring of points about the
// core; into the lounge through one of its two gaps, and the last step sits down on a cushion.

export const DESK_DX = 3.8, DESK_DZ = 3.5;     // desk pitch (x across a row, z between rows)
export const FLOOR = 0.46;                       // floor height (top of the slab)
export const WALL_H = 2.7, WALL_T = 0.18;        // back-wall height and thickness
export const AZ = 2.15;                          // half-depth of the atrium band between the back and front rows (R1 3.4)
export const GAP = 5.4;                          // width of the atrium gap between the left and right columns (R1 9.3)
export const RING_R = 1.95;                      // walking ring about the memory core (R1 3.3)
export const CORE_R = 1.5;                       // core plinth radius; the ring stays outside it (R1 2.5)
// seats (rooms.js builds the furniture from these; local z: + towards the back rest, a seat faces local -z)
export const SOFA = { len: 3.3, depth: 0.92, arm: 0.17, cushions: 3, cushionD: 0.68, cushionZ: -0.06, top: FLOOR + 0.455 };
export const ARMCHAIR = { w: 0.9, cushionW: 0.66, cushionD: 0.66, cushionZ: -0.05, top: FLOOR + 0.45 };
export const HIP_Z = 0.04;                       // a seated person's hips: local z on the cushion (knees reach ~0.42 forward)
export const SLOT_KINDS = ['research', 'design', 'office'];   // room styles; any other key is furnished as an office
const SLOTS = ['back', 'right', 'left'];         // department order from the server -> corner (the lounge takes the front)
const PAD = {                                     // room padding round the desk block: left (-x wall), back (-z wall), right, front
  research: { left: 3.4, back: 2.4, right: 1.6, front: 2.8 },   // left: the reading nook
  design: { left: 2.2, back: 2.4, right: 1.6, front: 2.8 },
  office: { left: 2.0, back: 2.4, right: 1.6, front: 2.8 }
};
export const LOUNGE = { w: 7.6, d: 7.6 };
// server closet at the back of the gap, against the open right side of the back-left room: a low partition on its
// left, the cabinets in a row along z facing +x (towards the core), far enough from the right room's wall that it
// hides none of them
// R3b: the closet is always long enough for five cabinets (slots), so the engine view (five services) and the legacy
// fixtures view (four) have the same closet and share one baked atrium; the cabinets themselves stay real-time
const CLOSET = { pitch: 0.8, margin: 0.3, w: 1.5, inset: 0.1, slots: 5 };

const kindOf = (key) => (SLOT_KINDS.includes(key) ? key : 'office');

// departments: [{ key, agents: [agentId, ...] }] (desk order); services: [{ id }]
// B0 (owner, 21/10/2026): opts.lounge false draws a business floor: the lounge has moved to floor 0 (the shared floor), so its corner is
// open floor with no furniture and no seats, and every agent stays at its desk (no paths)
export function computeLayout(departments, services = [], { lounge: withLounge = true } = {}) {
  const depts = departments.slice(0, 3);             // three corners; extra departments are not drawn (flagged in the result)
  const rooms = depts.map((d, i) => {
    const kind = kindOf(d.key), n = d.agents.length, cols = Math.min(2, Math.max(1, n)), rows = Math.max(1, Math.ceil(n / cols)), p = PAD[kind];
    return { key: d.key, kind, slot: SLOTS[i], agents: d.agents.slice(), cols, rows, pad: p,
      w: p.left + 2.1 + (cols - 1) * DESK_DX + p.right, d: p.back + (rows - 1) * DESK_DZ + p.front };
  });
  const bySlot = (s) => rooms.find((r) => r.slot === s);
  const back = bySlot('back'), right = bySlot('right'), left = bySlot('left');
  const closetLen = Math.max(2.6, WALL_T + Math.max(services.length, CLOSET.slots) * CLOSET.pitch + 2 * CLOSET.margin);
  // shared column widths and row depths
  const leftW = Math.max(back ? back.w : 0, left ? left.w : 0, 8);
  const rightW = Math.max(right ? right.w : 0, LOUNGE.w);
  const backD = Math.max(back ? back.d : 0, right ? right.d : 0, closetLen + 0.4, 5);
  const frontD = Math.max(left ? left.d : 0, LOUNGE.d);
  // x: [left column][gap (the closet at its back)][right column]; z: [back row][atrium band][front row]
  const xL1 = 0, xL0 = xL1 - leftW;
  const xR0 = xL1 + GAP, xR1 = xR0 + rightW;
  const zB1 = -AZ, zB0 = zB1 - backD, zF0 = AZ, zF1 = zF0 + frontD;
  const closet = { x0: xL1 + CLOSET.inset, x1: xL1 + CLOSET.inset + CLOSET.w };
  const coreX = (xL1 + xR0) / 2;
  const sx = -coreX;                                   // shift so the core sits at the origin
  const rect = (x0, x1, z0, z1) => ({ x0: x0 + sx, x1: x1 + sx, z0, z1, cx: (x0 + x1) / 2 + sx, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 });
  const place = { back: rect(xL0, xL1, zB0, zB1), right: rect(xR0, xR1, zB0, zB1), left: rect(xL0, xL1, zF0, zF1) };
  for (const r of rooms) Object.assign(r, place[r.slot], { exit: r.slot === 'left' ? '+x' : '+z' });
  Object.assign(closet, rect(closet.x0, closet.x1, zB0, zB0 + closetLen));
  const lounge = rect(xR0, xR1, zF0, zF1);
  const base = rect(xL0, xR1, zB0, zF1);
  const core = { x: 0, z: 0 };
  const atrium = { x0: xL1 + sx, x1: xR0 + sx, z0: -AZ, z1: AZ };

  // desks: rows from the back wall, columns from the left wall; the first desk of each row is L-shaped
  for (const r of rooms) {
    r.desks = r.agents.map((id, i) => {
      const col = i % r.cols, row = Math.floor(i / r.cols);
      const x = r.x0 + r.pad.left + 1.05 + col * DESK_DX, z = r.z0 + r.pad.back + row * DESK_DZ;
      return { agentId: id, x, z, col, row, lshape: col === 0, chair: { x, z: z + 0.98 }, lane: { x, z: z + 1.7 } };
    });
    // one rug per desk cluster (a row of desks)
    r.clusters = [];
    for (let row = 0; row < r.rows; row++) {
      const ds = r.desks.filter((d) => d.row === row); if (!ds.length) continue;
      r.clusters.push({ x0: Math.min(...ds.map((d) => d.x)) - 1.55, x1: Math.max(...ds.map((d) => d.x)) + 1.55, z0: ds[0].z - 0.95, z1: ds[0].z + 1.55 });
    }
    r.aisleX = r.cols > 1 ? (r.desks[0].x + r.desks[1].x) / 2 : r.x0 + r.pad.left - 0.5;
    r.corner = { x: r.x0 + WALL_T + 0.55, z: r.z0 + WALL_T + 0.55 };   // card anchor: the back corner, on the wall top
  }

  // services: one cabinet per service against the closet's partition, facing +x (yaw -PI/2)
  closet.cabinets = services.map((s, i) => ({ id: s.id, x: closet.x0 + WALL_T + 0.45, z: closet.z0 + WALL_T + CLOSET.margin + CLOSET.pitch / 2 + i * CLOSET.pitch, yaw: -Math.PI / 2 }));

  // lounge: an L of two three-seat sofas on its back sides (facing the camera), two armchairs at the front, a coffee table
  // in the middle; two gaps (gates) at its left and right corners. yaw: 0 faces -z, PI faces +z, -PI/2 faces +x, PI/2 faces -x.
  const lc = { x: lounge.cx, z: lounge.cz }, L = (lx, lz) => ({ x: lc.x + lx, z: lc.z + lz });
  lounge.furniture = !withLounge ? null : {
    sofaA: { ...L(0.3, -2.55), len: SOFA.len, yaw: Math.PI },     // along the back (-z) side, facing +z
    sofaB: { ...L(-2.55, 0.3), len: SOFA.len, yaw: -Math.PI / 2 },// along the left (-x) side, facing +x
    chair1: { ...L(2.75, 0.55), yaw: Math.PI / 2 },               // front right, facing -x
    chair2: { ...L(0.55, 2.75), yaw: 0 },                         // front left, facing -z
    table: { ...L(0.35, 0.35), w: 1.5, d: 1.1 },
    lamp: L(-2.75, -2.75), plants: [L(3.25, 3.25), L(-3.3, 1.9), L(4.15, -3.6)], rug: { x0: lc.x - 3.4, x1: lc.x + 3.4, z0: lc.z - 3.4, z1: lc.z + 3.4 }
  };
  const gates = !withLounge ? {} : { right: { at: L(3.05, -1.45), out: { x: lc.x + 3.05, z: lounge.z0 - 0.7 } }, left: { at: L(-1.45, 3.05), out: { x: lounge.x0 - 0.7, z: lc.z + 3.05 } } };
  // seats sit on the cushion centres (hips at HIP_Z), facing the way the furniture faces. cushion: the seat's top
  // rectangle in world x/z (every piece is turned by a multiple of 90 degrees) and its height
  const seats = [], F = lounge.furniture;
  const seat = (o, lx, cw, cd, cz, top, gate) => {
    const a = onFrame(o, lx - cw / 2, cz - cd / 2), b = onFrame(o, lx + cw / 2, cz + cd / 2);
    const cushion = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z), top };
    seats.push({ ...onFrame(o, lx, HIP_Z), yaw: o.yaw, approach: onFrame(o, lx, -1.0), gate, cushion });
  };
  const cw = (SOFA.len - 2 * SOFA.arm) / SOFA.cushions;
  if (F) for (const o of [F.sofaA, F.sofaB]) for (let i = 0; i < SOFA.cushions; i++) seat(o, -SOFA.len / 2 + SOFA.arm + cw * (i + 0.5), cw - 0.03, SOFA.cushionD, SOFA.cushionZ, SOFA.top, o === F.sofaA ? 'right' : 'left');
  if (F) seat(F.chair1, 0, ARMCHAIR.cushionW, ARMCHAIR.cushionD, ARMCHAIR.cushionZ, ARMCHAIR.top, 'right');
  if (F) seat(F.chair2, 0, ARMCHAIR.cushionW, ARMCHAIR.cushionD, ARMCHAIR.cushionZ, ARMCHAIR.top, 'left');
  lounge.seats = seats; lounge.gates = gates; lounge.open = !withLounge;

  // plants and props come before the paths, so a straight line to the lounge can be checked against them
  const plants = [], props = [];
  for (const r of rooms) {
    if (r.kind === 'research') plants.push({ x: r.x1 - 0.65, z: r.z0 + 0.75, kind: 'tall' }, { x: r.x0 + 0.75, z: r.z1 - 0.7, kind: 'tall' });
    else if (r.kind === 'design') plants.push({ x: r.x1 - 0.7, z: r.z0 + 0.95, kind: 'tall' }, { x: r.x0 + 0.75, z: r.z1 - 0.7, kind: 'small' });
    else plants.push({ x: r.x0 + 0.75, z: r.z1 - 0.7, kind: 'tall' }, { x: r.x1 - 0.7, z: r.z0 + 0.95, kind: 'small' });
  }
  for (const p of F ? F.plants : []) plants.push({ ...p, kind: 'tall' });
  // a prop: kind, centre, yaw (as above), footprint w x d in its own frame; rect: the footprint in world x/z
  const prop = (kind, x, z, yaw, w, d) => { const q = Math.abs(Math.sin(yaw)) > 0.9, hw = (q ? d : w) / 2, hd = (q ? w : d) / 2; props.push({ kind, x, z, yaw, w, d, rect: { x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd } }); };
  {
    // the back gap right of the closet: only its left ~2 units are seen (the right room's left wall hides the rest
    // from the camera), so the printer and the water cooler stand there, against the atrium's back wall
    const gx0 = closet.x1, zb = base.z0 + WALL_T;
    prop('printer', gx0 + 0.9, zb + 0.36, Math.PI, 0.9, 0.62);
    prop('cooler', gx0 + 1.65, zb + 0.26, Math.PI, 0.42, 0.42);
    // benches: against the atrium's left wall, by the core, at the slab's right edge and its front edge
    prop('bench', base.x0 + WALL_T + 0.32, 0, -Math.PI / 2, 1.7, 0.46);
    prop('bench', -GAP / 2 - 0.95, 1.05, -Math.PI / 2, 1.7, 0.46);
    prop('bench', GAP / 2 + 1.25, -1.5, Math.PI, 1.7, 0.46);
    prop('bench', base.x1 - 0.75, -0.2, Math.PI / 2, 1.7, 0.46);
    prop('bench', 0, base.z1 - 0.5, 0, 1.7, 0.46);
    plants.push({ x: base.x0 + 0.62, z: -1.7, kind: 'tall' }, { x: base.x0 + 0.6, z: 1.65, kind: 'small' }, { x: gx0 + 0.35, z: closet.z1 - 0.5, kind: 'small' });
    const office = rooms.find((r) => r.kind === 'office'), design = rooms.find((r) => r.kind === 'design');
    const row0 = office ? office.desks.filter((d) => d.row === 0) : [];
    if (row0.length) { const d1 = row0[row0.length - 1]; prop('meeting', (d1.x + 1.05 + office.x1) / 2, office.z0 + 1.45, 0, 2.0, 1.0); }
    if (design) prop('easel', design.x1 - 0.95, design.z1 - 0.95, -Math.PI * 0.75, 0.8, 0.8);
  }

  // the walking ring about the core
  const RING_N = 16, ring = Array.from({ length: RING_N }, (_, i) => ({ x: Math.cos((i / RING_N) * Math.PI * 2) * RING_R, z: Math.sin((i / RING_N) * Math.PI * 2) * RING_R }));
  const nearest = (p) => ring.reduce((b, q, i) => (dist(p, q) < dist(p, ring[b]) ? i : b), 0);
  function ringWalk(i, j) {
    const out = [ring[i]]; if (i === j) return out;
    const fwd = (j - i + RING_N) % RING_N, step = fwd <= RING_N / 2 ? 1 : -1;
    for (let k = i; k !== j;) { k = (k + step + RING_N) % RING_N; out.push(ring[k]); }
    return out;
  }

  // paths: agent k (department order, then desk order) gets lounge seat k; agents beyond the seat count stay at their desk
  const paths = {};
  const inR = (p, q, m) => p.x > q.x0 - m && p.x < q.x1 + m && p.z > q.z0 - m && p.z < q.z1 + m;
  // a straight line is clear when it keeps off the core, the closet, the lounge, every room but its own, props and plants
  const lineClear = (a, b, own) => {
    const n = Math.max(1, Math.ceil(dist(a, b) / 0.1));
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n };
      if (Math.hypot(p.x, p.z) < CORE_R + 0.6 || inR(p, closet, 0.3) || inR(p, lounge, 0.2)) return false;
      if (rooms.some((r) => r !== own && inR(p, r, 0.2)) || props.some((q) => inR(p, q.rect, 0.35)) || plants.some((q) => dist(p, q) < 0.75)) return false;
    }
    return true;
  };
  let k = 0;
  for (const r of rooms) for (const d of r.desks) {
    const seatIx = k < seats.length ? k : null; k++;
    if (seatIx == null) { paths[d.agentId] = { seat: null, toLounge: null }; continue; }
    const s = seats[seatIx], g = gates[s.gate];
    const pts = [d.chair, d.lane];
    if (r.exit === '+z') {
      const front = d.row === r.rows - 1;
      if (!front) pts.push({ x: r.aisleX, z: d.lane.z });
      const ex = front ? d.x : r.aisleX;
      pts.push({ x: ex, z: r.z1 + 0.8 });
    } else pts.push({ x: r.x1 + 0.8, z: d.lane.z });
    const exit = pts[pts.length - 1];
    if (!lineClear(exit, g.out, r)) pts.push(...ringWalk(nearest(exit), nearest(g.out)));
    pts.push(g.out, g.at, s.approach, { x: s.x, z: s.z });
    paths[d.agentId] = { seat: seatIx, toLounge: dedupe(pts) };
  }

  // walls: { axis: 'x' (a wall in the plane x = at, running along z) | 'z', at, from, to, h, owner }. Each room has two
  // back walls; the atrium's outer edge is walled too (behind the closet and between the two left-hand rooms), so the
  // back of the slab reads as one building. The closet has a full back wall and a low partition on its left.
  const walls = [];
  for (const r of rooms) walls.push({ axis: 'x', at: r.x0, from: r.z0, to: r.z1, h: WALL_H, owner: r.key }, { axis: 'z', at: r.z0, from: r.x0, to: r.x1, h: WALL_H, owner: r.key });
  const backRoom = rooms.find((r) => r.slot === 'back'), rightRoom = rooms.find((r) => r.slot === 'right');
  walls.push({ axis: 'z', at: base.z0, from: backRoom ? backRoom.x1 : base.x0, to: rightRoom ? rightRoom.x0 : base.x1, h: WALL_H, owner: 'atrium' });
  walls.push({ axis: 'x', at: base.x0, from: backRoom ? backRoom.z1 : base.z0, to: AZ, h: WALL_H, owner: 'atrium' });
  walls.push({ axis: 'x', at: closet.x0, from: closet.z0, to: closet.z1, h: 1.1, owner: 'closet' });

  return { rooms, closet, lounge, base, core, atrium, ring, paths, walls, plants, props, dropped: departments.slice(3).map((d) => d.key) };
}

// a wall end is joined when another wall continues it or meets it there (otherwise it is a dollhouse cut, capped)
export function wallJoined(walls, w, e) {
  return walls.some((o) => o !== w && ((o.axis === w.axis && Math.abs(o.at - w.at) < 1e-6 && (Math.abs(o.from - e) < 1e-6 || Math.abs(o.to - e) < 1e-6)) || (o.axis !== w.axis && Math.abs(o.at - e) < 1e-6 && o.from - 1e-6 <= w.at && w.at <= o.to + 1e-6)));
}

// which baked area a floor point belongs to (R3b): a department room's key, 'lounge', or 'atrium' (the rest of the slab,
// the closet included)
export function areaOf(L, p) {
  const r = L.rooms.find((q) => p.x > q.x0 && p.x < q.x1 && p.z > q.z0 && p.z < q.z1); if (r) return r.key;
  const g = L.lounge; return p.x > g.x0 && p.x < g.x1 && p.z > g.z0 && p.z < g.z1 ? 'lounge' : 'atrium';
}
// where a baked area's own frame sits on the floor plan: a room and the lounge at their back-left corner, the atrium at
// the slab's (it covers the whole slab, under the rooms too)
export function bakedOrigin(L, key) {
  const r = L.rooms.find((x) => x.key === key), o = r || (key === 'lounge' ? L.lounge : key === 'atrium' ? L.base : null);
  return o ? { x: o.x0, z: o.z0 } : null;
}

// R3 spike: everything a baked room must match, in the room's own frame (x from its -x wall, z from its -z wall; y is
// world height). The Blender build (scripts/build-office.mjs, R3a) writes this per room into the manifest; the page uses
// a baked room only while the live layout gives the same spec, so the labels, desks and seats still line up.
// R3b: also the lounge (furniture, seats with their cushions, plants) and the atrium (the slab, its floor outside the
// rooms and the lounge, the core plinth, the atrium and closet walls, props and plants), each in its own frame.
export function bakedRoomSpec(L, key = 'design') {
  if (key === 'lounge') return loungeSpec(L);
  if (key === 'atrium') return atriumSpec(L);
  const r = L.rooms.find((x) => x.key === key); if (!r) return null;
  const q = (v) => Math.round(v * 1e4) / 1e4, loc = (p) => ({ x: q(p.x - r.x0), z: q(p.z - r.z0) });
  const inside = (p) => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1;
  return {
    key, kind: r.kind, w: q(r.w), d: q(r.d), floor: FLOOR, wallH: WALL_H, wallT: WALL_T,
    desks: r.desks.map((d) => ({ ...loc(d), lshape: d.lshape, chair: loc(d.chair) })),
    plants: L.plants.filter(inside).map((p) => ({ ...loc(p), kind: p.kind })),
    props: L.props.filter(inside).map((p) => ({ kind: p.kind, ...loc(p), yaw: q(p.yaw) })),
    walls: L.walls.filter((w) => w.owner === key).map((w) => ({ axis: w.axis, at: q(w.at - (w.axis === 'x' ? r.x0 : r.z0)), from: q(w.from - (w.axis === 'x' ? r.z0 : r.x0)), to: q(w.to - (w.axis === 'x' ? r.z0 : r.x0)), h: w.h })),
    openFront: r.z1 < L.base.z1 - 0.01, openRight: r.x1 < L.base.x1 - 0.01
  };
}

const q4 = (v) => Math.round(v * 1e4) / 1e4;
const rectIn = (o, r) => ({ x0: q4(r.x0 - o.x0), x1: q4(r.x1 - o.x0), z0: q4(r.z0 - o.z0), z1: q4(r.z1 - o.z0) });
function loungeSpec(L) {
  const g = L.lounge, f = g.furniture, loc = (p) => ({ x: q4(p.x - g.x0), z: q4(p.z - g.z0) });
  // B0: a business floor's lounge corner is open floor (the lounge is on floor 0)
  if (!f) return { key: 'lounge', kind: 'lounge', w: q4(g.w), d: q4(g.d), floor: FLOOR, open: true, seats: [], plants: [] };
  const item = (o, extra = {}) => ({ ...loc(o), yaw: q4(o.yaw || 0), ...extra });
  return {
    key: 'lounge', kind: 'lounge', w: q4(g.w), d: q4(g.d), floor: FLOOR, sofa: { ...SOFA }, armchair: { ...ARMCHAIR },
    furniture: { sofaA: item(f.sofaA, { len: f.sofaA.len }), sofaB: item(f.sofaB, { len: f.sofaB.len }), chair1: item(f.chair1), chair2: item(f.chair2), table: { ...loc(f.table), w: f.table.w, d: f.table.d }, lamp: loc(f.lamp), rug: rectIn(g, f.rug) },
    seats: g.seats.map((s) => ({ ...loc(s), yaw: q4(s.yaw), cushion: { ...rectIn(g, s.cushion), top: q4(s.cushion.top) } })),
    plants: L.plants.filter((p) => areaOf(L, p) === 'lounge').map((p) => ({ ...loc(p), kind: p.kind }))
  };
}
function atriumSpec(L) {
  const b = L.base, loc = (p) => ({ x: q4(p.x - b.x0), z: q4(p.z - b.z0) });
  // the atrium's own floor: the slab minus the rooms and the lounge, as rectangles (a grid on every room edge, cells
  // merged along x); the closet's floor sits on it
  const cut = [...L.rooms, L.lounge];
  const grid = (k0, k1) => [...new Set([b[k0], b[k1], ...cut.flatMap((r) => [r[k0], r[k1]])].map(q4))].sort((a, c) => a - c);
  const xs = grid('x0', 'x1'), zs = grid('z0', 'z1'), floorRects = [];
  for (let j = 0; j + 1 < zs.length; j++) {
    let run = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, z: (zs[j] + zs[j + 1]) / 2 }, free = !cut.some((r) => c.x > r.x0 && c.x < r.x1 && c.z > r.z0 && c.z < r.z1);
      if (free && run) run.x1 = xs[i + 1]; else if (free) run = { x0: xs[i], x1: xs[i + 1], z0: zs[j], z1: zs[j + 1] }; else if (run) { floorRects.push(run); run = null; }
    }
    if (run) floorRects.push(run);
  }
  const mine = L.walls.filter((w) => w.owner === 'atrium' || w.owner === 'closet');
  const wall = (w) => { const o = w.axis === 'x' ? b.x0 : b.z0, a = w.axis === 'x' ? b.z0 : b.x0; return { axis: w.axis, at: q4(w.at - o), from: q4(w.from - a), to: q4(w.to - a), h: w.h, owner: w.owner, open: [!wallJoined(L.walls, w, w.from), !wallJoined(L.walls, w, w.to)] }; };
  return {
    key: 'atrium', kind: 'atrium', w: q4(b.w), d: q4(b.d), floor: FLOOR, wallH: WALL_H, wallT: WALL_T, coreR: CORE_R, core: loc(L.core),
    floorRects: floorRects.map((r) => rectIn(b, r)),
    walls: mine.map(wall),
    // the rooms' walls round the atrium: bake-only occluders (they shade the atrium floor in the day bake)
    occluders: L.walls.filter((w) => !mine.includes(w)).map((w) => { const { open, owner, ...x } = wall(w); return x; }),
    closet: rectIn(b, L.closet),
    props: L.props.filter((p) => areaOf(L, p) === 'atrium').map((p) => ({ kind: p.kind, ...loc(p), yaw: q4(p.yaw) })),
    plants: L.plants.filter((p) => areaOf(L, p) === 'atrium').map((p) => ({ ...loc(p), kind: p.kind }))
  };
}

// a point in a furniture item's own frame (it faces local -z, turned by yaw) in world x/z
export function onFrame(o, lx, lz) { const c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0); return { x: o.x + lx * c + lz * s, z: o.z - lx * s + lz * c }; }

export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function dedupe(pts) { const out = []; for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push({ x: p.x, z: p.z }); return out; }
export function pathLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
// a point at distance s along a polyline, with the heading of that segment (yaw: 0 faces -z)
export function pointAt(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = dist(a, b);
    if (s <= l || i === pts.length - 1) { const t = l ? Math.min(1, Math.max(0, s / l)) : 1; return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) }; }
    s -= l;
  }
  const p = pts[pts.length - 1]; return { x: p.x, z: p.z, yaw: 0 };
}
