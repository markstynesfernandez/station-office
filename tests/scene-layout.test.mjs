// scene-layout.test.mjs — the Redesign R1 floor plan (src/web/scene/layout.js, pure data): rooms, desks, lounge seats,
// the desk <-> lounge walking paths and the cutaway rule (no back wall hides a desk, a seat, the core or the closet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, pathLength, pointAt, dist, FLOOR, WALL_T, CORE_R } from '../src/web/scene/layout.js';

const DEPTS = [
  { key: 'research', agents: ['r1', 'r2'] },
  { key: 'design', agents: ['d1', 'd2'] },
  { key: 'office', agents: ['o1', 'o2', 'o3', 'o4'] }
];
const SERVICES = ['anthropic', 'openrouter', 'realesrgan', 'etsy', 'mock'].map((id) => ({ id }));
const L = computeLayout(DEPTS, SERVICES);
const inRect = (p, r, m = 0) => p.x > r.x0 - m && p.x < r.x1 + m && p.z > r.z0 - m && p.z < r.z1 + m;

// the isometric camera direction (yaw 45, pitch 35), as in office.js
const PITCH = 35 * Math.PI / 180, YAW = 45 * Math.PI / 180;
const CAM = { x: Math.cos(PITCH) * Math.sin(YAW), y: Math.sin(PITCH), z: Math.cos(PITCH) * Math.cos(YAW) };
// is the point hidden from the camera by any wall?
function hiddenBy(p) {
  for (const w of L.walls) {
    const plane = w.at + WALL_T;   // the wall's inner face
    const along = w.axis === 'x' ? 'z' : 'x', across = w.axis;
    const t = (plane - p[across]) / CAM[across];
    if (t <= 1e-6) continue;                                          // the wall is behind the point
    const q = { x: p.x + CAM.x * t, y: p.y + CAM.y * t, z: p.z + CAM.z * t };
    if (q[along] > w.from && q[along] < w.to && q.y < FLOOR + w.h) return w;
  }
  return null;
}

test('three rooms round the atrium, a lounge and a closet, with the core at the origin', () => {
  assert.deepEqual(L.rooms.map((r) => [r.key, r.slot, r.desks.length]), [['research', 'back', 2], ['design', 'right', 2], ['office', 'left', 4]]);
  assert.equal(L.closet.cabinets.length, 5);
  assert.deepEqual(L.core, { x: 0, z: 0 });
  for (const r of L.rooms) {
    for (const d of r.desks) assert.ok(inRect({ x: d.x, z: d.z }, r), d.agentId + ' desk inside its room');
    assert.ok(r.clusters.length === r.rows, 'one rug per desk row');
    for (const o of [...L.rooms.filter((x) => x !== r), L.lounge, L.closet]) assert.ok(r.x1 <= o.x0 || o.x1 <= r.x0 || r.z1 <= o.z0 || o.z1 <= r.z0, r.key + ' does not overlap');
    assert.ok(Math.hypot(r.cx, r.cz) > CORE_R + 3, 'room clear of the core');
  }
  assert.deepEqual(computeLayout(DEPTS, SERVICES), L, 'deterministic');
});

test('every agent has its own lounge seat and a path there that avoids rooms, desks, chairs, the core and furniture', () => {
  const seats = Object.values(L.paths).map((p) => p.seat);
  assert.equal(new Set(seats).size, 8); assert.ok(seats.every((s) => s != null));
  const desks = L.rooms.flatMap((r) => r.desks);
  for (const r of L.rooms) for (const d of r.desks) {
    const pts = L.paths[d.agentId].toLounge, len = pathLength(pts);
    assert.ok(len > 5 && len < 60, d.agentId + ' path length ' + len.toFixed(1));
    assert.ok(dist(pts[0], d.chair) < 1e-9, 'starts at the chair');
    const seat = L.lounge.seats[L.paths[d.agentId].seat];
    assert.ok(dist(pts[pts.length - 1], seat) < 1e-9, 'ends on the seat');
    const lastLeg = pathLength(pts.slice(-2));
    for (let s = 0; s <= len; s += 0.05) {
      const p = pointAt(pts, s), where = d.agentId + ' at ' + s.toFixed(2);
      assert.ok(Math.hypot(p.x, p.z) > CORE_R + 0.25, where + ': clear of the core');
      assert.ok(inRect(p, L.base, -0.3), where + ': on the slab');
      assert.ok(!inRect(p, L.closet, 0.2), where + ': not through the closet');
      for (const o of L.rooms) if (o !== r) assert.ok(!inRect(p, o, 0.1), where + ': not through ' + o.key);
      for (const pl of L.plants) assert.ok(dist(p, pl) > 0.6, where + ': clear of the plant at ' + pl.x.toFixed(1) + ',' + pl.z.toFixed(1));
      for (const q of L.props) assert.ok(!inRect(p, q.rect, 0.25), where + ': clear of the ' + q.kind + ' at ' + q.x.toFixed(1) + ',' + q.z.toFixed(1));
      if (inRect(p, r)) assert.ok(p.x > r.x0 + WALL_T + 0.3 && p.z > r.z0 + WALL_T + 0.3, where + ': clear of its walls');
      for (const o of desks) {
        assert.ok(!(Math.abs(p.x - o.x) < 1.05 + 0.2 && Math.abs(p.z - o.z) < 0.48 + 0.2), where + ': not through the desk of ' + o.agentId);
        if (o.lshape) assert.ok(!(p.x > o.x + 0.45 - 0.2 && p.x < o.x + 1.05 + 0.2 && p.z > o.z + 0.47 && p.z < o.z + 1.4 + 0.2), where + ': not through the L return of ' + o.agentId);
        if (o !== d) assert.ok(dist(p, o.chair) > 0.5, where + ': not through the chair of ' + o.agentId);
      }
      if (s < len - lastLeg - 1e-6) {   // the last step (approach -> seat) sits down on the sofa
        const f = L.lounge.furniture, t = f.table;
        assert.ok(!(Math.abs(p.x - t.x) < t.w / 2 + 0.2 && Math.abs(p.z - t.z) < t.d / 2 + 0.2), where + ': not through the coffee table');
        assert.ok(!(Math.abs(p.x - f.sofaA.x) < f.sofaA.len / 2 + 0.1 && Math.abs(p.z - f.sofaA.z) < 0.55), where + ': not through sofa A');
        assert.ok(!(Math.abs(p.z - f.sofaB.z) < f.sofaB.len / 2 + 0.1 && Math.abs(p.x - f.sofaB.x) < 0.55), where + ': not through sofa B');
        for (const c of [f.chair1, f.chair2]) assert.ok(dist(p, c) > 0.6, where + ': not through an armchair');
      }
    }
  }
});

test('cutaway: no back wall hides a desk, a chair, a lounge seat, the core or a server cabinet', () => {
  const pts = [];
  for (const r of L.rooms) for (const d of r.desks) pts.push({ what: d.agentId + ' monitor', x: d.x, y: FLOOR + 1.5, z: d.z - 0.24 }, { what: d.agentId + ' desk front', x: d.x, y: FLOOR + 0.76, z: d.z + 0.45 }, { what: d.agentId + ' chair', x: d.chair.x, y: FLOOR + 0.5, z: d.chair.z });
  for (const [i, s] of L.lounge.seats.entries()) pts.push({ what: 'seat ' + i, x: s.x, y: FLOOR + 0.5, z: s.z });
  for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) pts.push({ what: 'core plinth ' + a, x: Math.cos(a * Math.PI / 4) * (CORE_R - 0.2), y: FLOOR + 0.3, z: Math.sin(a * Math.PI / 4) * (CORE_R - 0.2) });
  for (const c of L.closet.cabinets) pts.push({ what: 'cabinet ' + c.id, x: c.x + 0.4, y: FLOOR + 1.0, z: c.z }, { what: 'cabinet light ' + c.id, x: c.x + 0.3, y: FLOOR + 2.08, z: c.z + 0.22 });
  for (const q of L.props) pts.push({ what: q.kind + ' at ' + q.x.toFixed(1) + ',' + q.z.toFixed(1), x: q.x, y: FLOOR + 0.7, z: q.z });
  for (const p of pts) { const w = hiddenBy(p); assert.equal(w, null, p.what + ' hidden by the ' + (w && w.owner) + ' wall'); }
});

test('lounge: every seat lies on its cushion (hips and knees), at cushion height, facing the coffee table', () => {
  const t = L.lounge.furniture.table;
  assert.equal(L.lounge.seats.length, 8);
  for (const [i, s] of L.lounge.seats.entries()) {
    const c = s.cushion, fwd = { x: -Math.sin(s.yaw), z: -Math.cos(s.yaw) }, side = { x: -fwd.z, z: fwd.x };
    // the hips (centre and both sides, 0.17 out) and the knees (0.42 forward) are on the cushion, 0.05 in from its edges
    for (const [f, l, what] of [[0, 0, 'hips'], [0, -0.17, 'left hip'], [0, 0.17, 'right hip'], [0.36, -0.1, 'left knee'], [0.36, 0.1, 'right knee']]) {
      const p = { x: s.x + fwd.x * f + side.x * l, z: s.z + fwd.z * f + side.z * l };
      assert.ok(p.x > c.x0 + 0.05 && p.x < c.x1 - 0.05 && p.z > c.z0 + 0.05 && p.z < c.z1 - 0.05, 'seat ' + i + ' ' + what + ' (' + p.x.toFixed(2) + ',' + p.z.toFixed(2) + ') inside cushion ' + JSON.stringify(c));
    }
    assert.ok(c.top > FLOOR + 0.4 && c.top < FLOOR + 0.5, 'seat ' + i + ' cushion height');
    const toT = { x: t.x - s.x, z: t.z - s.z }, n = Math.hypot(toT.x, toT.z);
    assert.ok((fwd.x * toT.x + fwd.z * toT.z) / n > 0.45, 'seat ' + i + ' faces the coffee table');
    assert.ok(dist(s.approach, s) > 0.8 && !(Math.abs(s.approach.x - t.x) < t.w / 2 + 0.2 && Math.abs(s.approach.z - t.z) < t.d / 2 + 0.2), 'seat ' + i + ' approach is in front of the seat, off the table');
  }
  // no two seated people overlap
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) assert.ok(dist(L.lounge.seats[i], L.lounge.seats[j]) > 0.75, 'seats ' + i + ' and ' + j + ' apart');
});

test('a department without agents and a fourth department are handled', () => {
  const L2 = computeLayout([{ key: 'research', agents: [] }, { key: 'design', agents: ['a'] }, { key: 'office', agents: ['b'] }, { key: 'extra', agents: ['c'] }], [{ id: 'mock' }]);
  assert.equal(L2.rooms.length, 3); assert.deepEqual(L2.dropped, ['extra']);
  assert.equal(L2.rooms[0].desks.length, 0); assert.ok(L2.paths.a.toLounge.length > 3);
});
