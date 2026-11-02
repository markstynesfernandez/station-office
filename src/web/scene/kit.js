// scene/kit.js — R7a: the shared kit of procedural props every floor is assembled from (desk, standing desk, executive desk, chair,
// monitor, wall screen, whiteboard, glass partition, plant, couch, armchair, server rack, shelf, reception desk, display cabinet,
// tables, phone booth, lift, skyline...). Each prop adds flat-coloured geometry to a few buckets, merged once per floor, so a whole
// floor costs a handful of draw calls whatever it holds:
//   solid     vertex colours, lit (M.static)          glass   vertex colours, see-through (one material)
//   em        vertex colours, unlit (LEDs, lit windows, lamp bulbs)
//   wood/tile the floor (the oak or concrete texture, planar UVs), tinted per floor by the material colour
// The colours come from the floor's palette (towerplan.js FLOOR_PALETTES); the layout from the floor's plan (towerplan.js planFloor).
// Furniture yaw as in layout.js: yaw 0 faces -z (a person at a desk sits on its +z side, facing -z), -PI/2 faces +x.
// Nothing here carries text: the screens and plates are canvas textures drawn by boards.js.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from './textures.js';
import { SLAB, T_WALL_H, T_WALL_T } from './towerplan.js';

export const KIT_FLOOR = 0.46;                       // top of the slab (layout.js FLOOR)
const F = KIT_FLOOR, PT = F + 0.02;                // PT: the top of the floor, where furniture stands
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r = 0.04) => new RoundedBoxGeometry(w, h, d, 1, Math.min(r, Math.min(w, h, d) / 2));
const cyl = (r0, r1, h, n = 12) => new THREE.CylinderGeometry(r0, r1, h, n);
const mat4 = (x, y, z, ry = 0, rx = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
const col = (c) => new THREE.Color(c);
export const shade = (c, k) => '#' + col(c).multiplyScalar(k).getHexString();
export const mixc = (a, b, t) => '#' + col(a).lerp(col(b), t).getHexString();
// a point in a prop's own frame: lx across, ly up from the floor, lz forward (local -z is its front)
const local = (o, lx, ly, lz, extra = 0, rx = 0, rz = 0) => { const c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0); return mat4(o.x + lx * c + lz * s, PT + ly, o.z - lx * s + lz * c, (o.yaw || 0) + extra, rx, rz); };

function prep(geo, m, color, uv) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (m) g.applyMatrix4(m);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(uv && k === 'uv')) g.deleteAttribute(k);
  if (color) { const c = col(color), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
  geo.dispose(); return g;
}
function bucket({ uv = false, color = true } = {}) {
  const parts = [];
  return { add(geo, m, c) { parts.push(prep(geo, m, color ? c : null, uv)); }, merge() { if (!parts.length) return null; const g = mergeGeometries(parts); for (const p of parts) p.dispose(); parts.length = 0; return g; }, get size() { return parts.length; } };
}
function planarUV(g, scale) { const p = g.attributes.position, uv = new Float32Array(p.count * 2); for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / scale; uv[i * 2 + 1] = -p.getZ(i) / scale; } g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return g; }
export function createBuckets() {
  const B = { solid: bucket(), glass: bucket(), em: bucket(), wood: bucket({ uv: true, color: false }), tile: bucket({ uv: true, color: false }) };
  B.merge = () => Object.fromEntries(['solid', 'glass', 'em', 'wood', 'tile'].map((k) => [k, B[k].merge()]));
  return B;
}

// ---- the shell: slab, floor, the two back walls (solid or glass with mullions), the open front edges
export function shell(B, plan, c) {
  const { x0, x1, z0, z1 } = SLAB, w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  B.solid.add(box(w, F - 0.02, d), mat4(cx, (F - 0.02) / 2, cz), c.slabEdge);
  B.solid.add(box(w + 0.1, 0.06, d + 0.1), mat4(cx, 0.03, cz), c.slabFoot);
  const fl = planarUV(prep(box(w, 0.04, d), mat4(cx, F, cz), null, true), 2.4);   // planar UVs at the oak's scale
  if (c.floorKind === 'oak') B.wood.add(fl, null); else if (c.floorKind === 'concrete' || c.floorKind === 'stone') B.tile.add(fl, null); else B.solid.add(fl, null, c.floor);
  for (const axis of ['x', 'z']) {
    const glass = plan.walls[axis] === 'glass', len = axis === 'x' ? d : w;
    const at = (u, y, v, ww, hh, dd) => (axis === 'x' ? { geo: box(dd, hh, ww), m: mat4(x0 + v, y, u) } : { geo: box(ww, hh, dd), m: mat4(u, y, z0 + v) });
    const mid = axis === 'x' ? cz : cx, lo = axis === 'x' ? z0 : x0;
    if (!glass) {
      const p = at(mid, F + T_WALL_H / 2, T_WALL_T / 2, len, T_WALL_H, T_WALL_T); B.solid.add(p.geo, p.m, c.wall);
      const cap = at(mid, F + T_WALL_H + 0.03, T_WALL_T / 2, len, 0.06, T_WALL_T + 0.02); B.solid.add(cap.geo, cap.m, c.wallCap);
      const bb = at(mid, F + 0.06, T_WALL_T + 0.01, len, 0.12, 0.03); B.solid.add(bb.geo, bb.m, c.baseboard);
    } else {
      const p = at(mid, F + T_WALL_H / 2, T_WALL_T / 2, len, T_WALL_H, 0.04); B.glass.add(p.geo, p.m, c.glass);
      for (let u = 0; u <= len + 1e-6; u += len / 9) { const m = at(lo + u, F + T_WALL_H / 2, T_WALL_T / 2, 0.07, T_WALL_H, 0.1); B.solid.add(m.geo, m.m, c.glassFrame); }
      for (const y of [F + 0.04, F + T_WALL_H]) { const r = at(mid, y, T_WALL_T / 2, len, 0.08, 0.12); B.solid.add(r.geo, r.m, c.glassFrame); }
    }
  }
  // the corner post where the back walls meet
  B.solid.add(box(T_WALL_T + 0.02, T_WALL_H + 0.06, T_WALL_T + 0.02), mat4(x0 + T_WALL_T / 2, F + (T_WALL_H + 0.06) / 2, z0 + T_WALL_T / 2), plan.walls.x === 'glass' ? c.glassFrame : c.wallCap);
  if (plan.terrace) {   // the penthouse's roof-terrace edge: a low glass balustrade with a brass top rail on the open sides
    for (const [ax, ay, bx, by] of [[x0, z1 - 0.1, x1, z1 - 0.1], [x1 - 0.1, z0, x1 - 0.1, z1]]) glassRun(B, { x0: ax, z0: ay, x1: bx, z1: by, h: 0.95, rail: c.brass }, c);
  }
}

// a glass partition along a segment (x0,z0)-(x1,z1): one pane, a frame top and bottom, posts at the ends
export function glassRun(B, s, c) {
  const h = s.h || T_WALL_H, dx = s.x1 - s.x0, dz = s.z1 - s.z0, len = Math.hypot(dx, dz), yaw = Math.atan2(-dz, dx), mx = (s.x0 + s.x1) / 2, mz = (s.z0 + s.z1) / 2;
  if (len < 0.05) return;
  B.glass.add(box(len, h, 0.04), mat4(mx, F + h / 2, mz, yaw), c.glass);
  for (const y of [F + 0.03, F + h]) B.solid.add(box(len, 0.05, 0.07), mat4(mx, y, mz, yaw), s.rail && y > F + 0.1 ? s.rail : c.glassFrame);
  for (const t of [0, 1]) B.solid.add(box(0.06, h, 0.08), mat4(s.x0 + dx * t, F + h / 2, s.z0 + dz * t, yaw), c.glassFrame);
}

// ---- desks: one seat (towerplan.js seatFrame): the desk, its monitor and keyboard, the chair (a standing desk has none). The live
// screen face, the status light and the person are the renderer's; an empty (not-hired) desk gets a dark screen and a tent card
export function seat(B, s, c) {
  const o = { x: s.x, z: s.z, yaw: s.yaw || 0 }, std = s.kind === 'standing', exec = s.kind === 'exec';
  const top = std ? 1.05 : exec ? 0.75 : 0.73;
  if (std) {
    B.solid.add(rbox(1.9, 0.05, 0.85, 0.02), local(o, 0, top, 0), c.top);
    for (const sx of [-0.78, 0.78]) { B.solid.add(box(0.09, top - 0.04, 0.09), local(o, sx, (top - 0.04) / 2, 0), c.metal); B.solid.add(box(0.08, 0.04, 0.7), local(o, sx, 0.02, 0), c.metal); }
    B.solid.add(box(1.5, 0.08, 0.05), local(o, 0, top - 0.12, -0.3), c.metal);
    B.solid.add(rbox(0.5, 0.03, 0.4, 0.01), local(o, 0, 0.015, 0.75), c.rugBorder);   // an anti-fatigue mat
  } else if (exec) {
    B.solid.add(rbox(2.4, 0.07, 1.1, 0.02), local(o, 0, top, 0), c.top);
    for (const sx of [-1.1, 1.1]) B.solid.add(box(0.12, top - 0.035, 1.0), local(o, sx, (top - 0.035) / 2, 0), c.wood);
    B.solid.add(box(2.1, 0.45, 0.04), local(o, 0, top - 0.3, -0.45), c.wood);
  } else {
    B.solid.add(rbox(2.1, 0.06, 0.95, 0.025), local(o, 0, top, 0), c.top);
    for (const [sx, sz] of [[-0.98, -0.38], [-0.98, 0.38], [0.98, -0.38]]) B.solid.add(box(0.05, top - 0.03, 0.05), local(o, sx, (top - 0.03) / 2, sz), c.metal);
    B.solid.add(box(0.42, top - 0.04, 0.8), local(o, 0.78, (top - 0.04) / 2, 0), c.wood);   // drawer pedestal
    B.solid.add(box(1.9, 0.04, 0.05), local(o, 0, top - 0.06, -0.38), c.metal);
  }
  const on = top + 0.03;
  monitorFrame(B, o, on, c);
  B.solid.add(rbox(0.56, 0.025, 0.18, 0.01), local(o, -0.05, on + 0.012, 0.14), c.paper);
  if (!std) chair(B, { x: o.x + Math.sin(o.yaw) * (s.state === 'not-hired' ? 0.7 : 0.98), z: o.z + Math.cos(o.yaw) * (s.state === 'not-hired' ? 0.7 : 0.98), yaw: o.yaw }, c, { exec });
  if (s.state === 'not-hired') {
    B.solid.add(box(1.2, 0.73, 0.01), local(o, 0, on + 0.72, -0.24 + 0.031, 0.35), '#15171b');   // the screen, off
    B.solid.add(box(0.36, 0.16, 0.012), local(o, 0.55, on + 0.08, 0.2, 0.2, 0.35), c.paper); B.solid.add(box(0.36, 0.16, 0.012), local(o, 0.55, on + 0.08, 0.26, 0.2, -0.35), c.paper);   // a tent card
  }
}
export const MON_YAW = 20 * Math.PI / 180;
function monitorFrame(B, o, on, c) {
  const m = { x: o.x + (-0.24) * Math.sin(o.yaw), z: o.z + (-0.24) * Math.cos(o.yaw), yaw: o.yaw + MON_YAW };
  B.solid.add(rbox(0.46, 0.04, 0.26, 0.02), local(m, 0, on + 0.02, 0), c.screenFrame);
  B.solid.add(box(0.12, 0.34, 0.1), local(m, 0, on + 0.19, 0), c.screenFrame);
  B.solid.add(rbox(1.3, 0.82, 0.05, 0.03), local(m, 0, on + 0.72, 0), c.screenFrame);
}
// where a seat's live screen face sits (the renderer's own mesh, status glow or canvas text)
export function monitorFace(s) {
  const top = s.kind === 'standing' ? 1.05 : s.kind === 'exec' ? 0.75 : 0.73, on = top + 0.03, yaw = (s.yaw || 0) + MON_YAW;
  const mx = s.x - 0.24 * Math.sin(s.yaw || 0), mz = s.z - 0.24 * Math.cos(s.yaw || 0);
  return { x: mx + Math.sin(yaw) * 0.031, y: PT + on + 0.72, z: mz + Math.cos(yaw) * 0.031, yaw };   // the plane faces +z rotated by yaw
}

export function chair(B, o, c, { exec = false } = {}) {
  const fab = exec ? c.fabric : c.chair;
  for (let i = 0; i < 5; i++) B.solid.add(box(0.05, 0.035, 0.3), local(o, 0, 0.04, 0, (i * Math.PI * 2) / 5).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.15)), c.metal);
  B.solid.add(cyl(0.035, 0.035, 0.36, 8), local(o, 0, 0.24, 0), c.metal);
  B.solid.add(rbox(0.54, 0.09, 0.52, 0.035), local(o, 0, 0.45, 0), fab);
  B.solid.add(rbox(0.52, exec ? 0.82 : 0.62, 0.08, 0.035), local(o, 0, exec ? 0.95 : 0.86, 0.25), fab);
  for (const sx of [-0.28, 0.28]) { B.solid.add(rbox(0.05, 0.05, 0.3, 0.02), local(o, sx, 0.64, 0.02), c.metal); B.solid.add(box(0.04, 0.17, 0.04), local(o, sx, 0.55, 0.06), c.metal); }
}
export function stool(B, o, c) { B.solid.add(cyl(0.2, 0.2, 0.06, 14), local(o, 0, 0.74, 0), c.fabric); B.solid.add(cyl(0.03, 0.03, 0.72, 8), local(o, 0, 0.37, 0), c.metal); B.solid.add(cyl(0.2, 0.22, 0.03, 14), local(o, 0, 0.015, 0), c.metal); B.solid.add(new THREE.TorusGeometry(0.16, 0.012, 6, 16).rotateX(Math.PI / 2), local(o, 0, 0.3, 0), c.metal); }

// ---- tables, seating
export function table(B, o, c, { w = 2.4, d = 1.2, h = 0.74, papers = false } = {}) {
  B.solid.add(rbox(w, 0.07, d, 0.03), local(o, 0, h, 0), c.top);
  const lx = w / 2 - 0.25, lz = d / 2 - 0.2;
  if (h > 0.9) for (const sx of [-lx, lx]) { B.solid.add(box(0.08, h - 0.04, 0.08), local(o, sx, (h - 0.04) / 2, 0), c.metal); B.solid.add(box(0.06, 0.04, d - 0.2), local(o, sx, 0.02, 0), c.metal); }
  else for (const sx of [-lx, lx]) B.solid.add(box(0.12, h - 0.04, d - 0.3), local(o, sx, (h - 0.04) / 2, 0), c.wood);
  if (papers) { const r = rng(Math.round(o.x * 7 + o.z * 13) + 99); for (let i = 0; i < 9; i++) B.solid.add(box(0.3, 0.006, 0.42), local(o, (r() - 0.5) * (w - 0.6), h + 0.04, (r() - 0.5) * (d - 0.5), r() * 1.2), i % 3 === 0 ? c.accent : i % 3 === 1 ? c.paper : c.accent2); }
}
export function roundTable(B, o, c, { r = 0.9 } = {}) { B.solid.add(cyl(r, r, 0.06, 28), local(o, 0, 0.74, 0), c.top); B.solid.add(cyl(0.06, 0.06, 0.7, 10), local(o, 0, 0.36, 0), c.metal); B.solid.add(cyl(0.4, 0.45, 0.04, 20), local(o, 0, 0.02, 0), c.metal); }
export function coffeeTable(B, o, c, { w = 1.8, d = 0.9 } = {}) { B.solid.add(rbox(w, 0.08, d, 0.03), local(o, 0, 0.42, 0), c.wood); for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.solid.add(box(0.05, 0.38, 0.05), local(o, sx * (w / 2 - 0.12), 0.19, sz * (d / 2 - 0.1)), c.metal); B.solid.add(box(0.36, 0.05, 0.26), local(o, 0.2, 0.485, 0.05, 0.3), c.accent); }
export function couch(B, o, c, { len = 3.2 } = {}) {
  const d = 0.92;
  B.solid.add(rbox(len, 0.3, d, 0.06), local(o, 0, 0.27, 0), c.fabric);
  B.solid.add(rbox(len, 0.62, 0.2, 0.07), local(o, 0, 0.55, d / 2 - 0.1), c.fabric);
  for (const sx of [-1, 1]) B.solid.add(rbox(0.18, 0.5, d, 0.06), local(o, sx * (len / 2 - 0.09), 0.37, 0), c.fabric);
  const n = len > 2.4 ? 3 : 2, cw = (len - 0.36) / n;
  for (let i = 0; i < n; i++) B.solid.add(rbox(cw - 0.03, 0.14, 0.66, 0.05), local(o, -len / 2 + 0.18 + cw * (i + 0.5), 0.48, -0.06), c.cushion);
  for (const sx of [-1, 1]) B.solid.add(box(0.05, 0.12, 0.05), local(o, sx * (len / 2 - 0.15), 0.06, 0.3), c.metal);
}
export function armchair(B, o, c) { B.solid.add(rbox(0.9, 0.3, 0.86, 0.06), local(o, 0, 0.27, 0), c.fabric); B.solid.add(rbox(0.9, 0.6, 0.18, 0.06), local(o, 0, 0.55, 0.36), c.fabric); for (const sx of [-1, 1]) B.solid.add(rbox(0.16, 0.46, 0.86, 0.05), local(o, sx * 0.37, 0.36, 0), c.fabric); B.solid.add(rbox(0.6, 0.13, 0.62, 0.05), local(o, 0, 0.48, -0.05), c.cushion); }
export function bench(B, o, c, { len = 2.4 } = {}) { B.solid.add(rbox(len, 0.08, 0.5, 0.03), local(o, 0, 0.45, 0), c.wood); for (const sx of [-1, 1]) B.solid.add(box(0.06, 0.42, 0.42), local(o, sx * (len / 2 - 0.2), 0.21, 0), c.metal); }
export function counter(B, o, c, { w = 3.0 } = {}) { B.solid.add(box(w, 1.0, 0.6), local(o, 0, 0.5, 0), c.wood); B.solid.add(rbox(w + 0.1, 0.05, 0.7, 0.02), local(o, 0, 1.02, 0), c.stone); for (let i = 0; i < 3; i++) B.solid.add(cyl(0.05, 0.04, 0.16, 10), local(o, -w / 3 + i * 0.4, 1.12, 0), i === 1 ? c.accent : c.paper); }

// ---- greenery and light
export function plant(B, o, c, { tall = false } = {}) {
  const r = rng(Math.round(o.x * 31 + o.z * 17) + 5);
  if (tall) {
    B.solid.add(cyl(0.27, 0.21, 0.5, 14), local(o, 0, 0.25, 0), c.pot);
    B.solid.add(cyl(0.025, 0.03, 1.0, 6), local(o, 0, 0.75, 0), shade(c.leaf2, 0.7));
    for (let i = 0; i < 7; i++) { const a = i * 2.4, rr = 0.18 + (i % 2) * 0.12, g = new THREE.IcosahedronGeometry(0.26 + (i % 3) * 0.04, 0); g.scale(1, 0.7, 1.25); B.solid.add(g, local(o, Math.cos(a) * rr, 0.75 + i * 0.13, Math.sin(a) * rr, i * 1.9 + r()), i % 2 ? c.leaf : c.leaf2); }
  } else {
    B.solid.add(cyl(0.19, 0.15, 0.32, 12), local(o, 0, 0.16, 0), c.pot);
    for (let i = 0; i < 3; i++) B.solid.add(new THREE.IcosahedronGeometry(0.25, 0), local(o, (i - 1) * 0.11, 0.42 + (i % 2) * 0.13, i === 1 ? -0.09 : 0.07, i * 0.7 + r(), i), i % 2 ? c.leaf : c.leaf2);
  }
}
export function floorLamp(B, o, c) { B.solid.add(cyl(0.18, 0.2, 0.03, 16), local(o, 0, 0.015, 0), c.metal); B.solid.add(cyl(0.015, 0.015, 1.5, 6), local(o, 0, 0.77, 0), c.metal); B.solid.add(cyl(0.18, 0.24, 0.3, 16, 1), local(o, 0, 1.55, 0), c.paper); B.em.add(new THREE.SphereGeometry(0.06, 8, 6), local(o, 0, 1.48, 0), c.lamp); }

// ---- storage and display
export function shelf(B, o, c, { w = 2.4, h = 1.9, binders = false } = {}) {
  const d = 0.38, r = rng(Math.round(o.x * 13 + o.z * 29) + 3), n = Math.max(3, Math.round(h / 0.42));
  B.solid.add(box(w, h, 0.03), local(o, 0, h / 2, d / 2 - 0.015), shade(c.wood, 0.9));
  for (const sx of [-1, 1]) B.solid.add(box(0.04, h, d), local(o, sx * (w / 2 - 0.02), h / 2, 0), c.wood);
  const BOOK = binders ? ['#1f3b5c', '#3a3a3c', '#8c2f2f', '#4a6a8a', '#e3ddd2', '#2f5d50'] : ['#7b2d26', '#2f4858', '#3d5a40', '#8c6d46', '#5b5f97', '#b5533c', '#d9b26f', '#e8e1d4', '#3b3b3b', '#6b4e71'];
  for (let i = 0; i <= n; i++) {
    const y = (h - 0.04) * (i / n) + 0.02; B.solid.add(box(w - 0.06, 0.03, d - 0.02), local(o, 0, y, 0), c.wood);
    if (i === n) break;
    let x = -w / 2 + 0.08; const sh = (h / n) - 0.08;
    while (x < w / 2 - 0.2) { const bw = binders ? 0.07 : 0.03 + r() * 0.05, bh = sh * (0.6 + r() * 0.35); if (r() < 0.15) { x += 0.12; continue; } B.solid.add(box(bw, bh, d * 0.7), local(o, x + bw / 2, y + 0.015 + bh / 2, 0.02), BOOK[Math.floor(r() * BOOK.length)]); x += bw + 0.008; }
  }
}
export function rack(B, o, c, i = 0) {
  B.solid.add(rbox(0.72, 2.1, 0.86, 0.02), local(o, 0, 1.05, 0), c.rack);
  B.solid.add(box(0.62, 1.9, 0.02), local(o, 0, 1.05, -0.43), shade(c.rack, 1.35));
  const r = rng(i * 7 + 11);
  for (let k = 0; k < 9; k++) { const y = 0.3 + k * 0.19; B.solid.add(box(0.56, 0.14, 0.01), local(o, 0, y, -0.445), shade(c.rack, 0.7)); for (let j = 0; j < 3; j++) if (r() < 0.75) B.em.add(box(0.025, 0.025, 0.01), local(o, -0.22 + j * 0.05, y, -0.452), r() < 0.82 ? c.led : c.ledB); }
  B.em.add(box(0.6, 0.02, 0.01), local(o, 0, 2.02, -0.452), c.accent2);
}
export function cabinet(B, o, c, { w = 6.0, h = 2.2 } = {}) {
  const d = 0.62;
  B.solid.add(box(w, 0.4, d), local(o, 0, 0.2, 0), c.wood);                 // plinth
  B.solid.add(box(w, 0.08, d), local(o, 0, h, 0), c.wood);                   // top
  B.solid.add(box(w, h - 0.4, 0.04), local(o, 0, 0.4 + (h - 0.4) / 2, d / 2 - 0.02), shade(c.wall, 0.82));   // back panel
  for (const y of [0.42, 1.0, 1.58]) B.solid.add(box(w - 0.1, 0.03, d - 0.08), local(o, 0, y, 0), c.glass);
  for (let k = 0; k <= 4; k++) B.solid.add(box(0.05, h - 0.4, 0.05), local(o, -w / 2 + 0.025 + k * (w - 0.05) / 4, 0.4 + (h - 0.4) / 2, -d / 2 + 0.03), c.brass);
  B.glass.add(box(w, h - 0.4, 0.02), local(o, 0, 0.4 + (h - 0.4) / 2, -d / 2 + 0.02), c.glass);
  B.em.add(box(w - 0.2, 0.02, 0.04), local(o, 0, h - 0.05, 0), c.lamp);      // a strip light inside the top
}
// a figurine on a plinth (a trophy: an archived agent, in its colour)
export function figurine(B, o, c, colour, y = 0) {
  B.solid.add(box(0.34, 0.08, 0.3), local(o, 0, y + 0.04, 0), c.brass);
  B.solid.add(cyl(0.09, 0.13, 0.26, 10), local(o, 0, y + 0.21, 0), colour);
  B.solid.add(new THREE.SphereGeometry(0.085, 10, 8), local(o, 0, y + 0.42, 0), colour);
}
export function reception(B, o, c) {
  const w = 4.2;
  B.solid.add(box(w, 1.12, 0.22), local(o, 0, 0.56, -0.7), c.wood);       // the visitors' side, tall
  B.solid.add(rbox(w + 0.2, 0.06, 0.5, 0.02), local(o, 0, 1.15, -0.72), c.stone);
  B.solid.add(box(w, 0.06, 0.8), local(o, 0, 0.74, -0.2), c.top);           // the work surface behind
  for (const sx of [-1, 1]) B.solid.add(box(0.22, 1.12, 1.0), local(o, sx * (w / 2 - 0.11), 0.56, -0.3), c.wood);
  B.em.add(box(w - 0.3, 0.025, 0.02), local(o, 0, 0.08, -0.82), c.accent);
  monitorFrame(B, { x: o.x + Math.sin(o.yaw) * 0.05 + Math.cos(o.yaw) * 0.8, z: o.z + Math.cos(o.yaw) * 0.05 - Math.sin(o.yaw) * 0.8, yaw: o.yaw }, 0.77, c);
}
export function booth(B, o, c) {
  const s = 1.7, h = 2.3;
  B.solid.add(box(s, 0.08, s), local(o, 0, 0.04, 0), c.metal); B.solid.add(box(s, 0.1, s), local(o, 0, h, 0), c.accent2);
  B.solid.add(box(s, h, 0.06), local(o, 0, h / 2, s / 2 - 0.03), c.fabric);   // the back, upholstered
  for (const sx of [-1, 1]) B.glass.add(box(0.03, h - 0.1, s - 0.1), local(o, sx * (s / 2 - 0.02), h / 2, 0), c.glass);
  B.glass.add(box(s - 0.1, h - 0.1, 0.03), local(o, 0, h / 2, -s / 2 + 0.02), c.glass);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.solid.add(box(0.06, h, 0.06), local(o, sx * (s / 2 - 0.03), h / 2, sz * (s / 2 - 0.03)), c.metal);
  B.solid.add(box(1.0, 0.04, 0.4), local(o, 0, 1.0, 0.55), c.top); stool(B, { x: o.x, z: o.z, yaw: o.yaw }, c);
  B.em.add(box(s - 0.3, 0.02, 0.02), local(o, 0, h - 0.06, 0), c.lamp);
}
export function lift(B, o, c) {
  // doors in the 'x' wall at z = o.z, facing +x: a steel surround, two doors, the call buttons
  const x = SLAB.x0 + T_WALL_T, w = 2.0, h = 2.1;
  B.solid.add(box(0.06, h + 0.12, w + 0.36), mat4(x + 0.03, F + (h + 0.12) / 2, o.z), shade(c.metal, 1.6));
  for (const sz of [-1, 1]) B.solid.add(box(0.05, h, w / 2 - 0.02), mat4(x + 0.07, F + h / 2, o.z + sz * (w / 4)), mixc(c.metal, '#b9bec6', 0.55));
  B.solid.add(box(0.04, h, 0.02), mat4(x + 0.1, F + h / 2, o.z), shade(c.metal, 0.8));
  B.solid.add(box(0.04, 0.3, 0.14), mat4(x + 0.07, F + 1.15, o.z + w / 2 + 0.36), shade(c.metal, 1.4));
  B.em.add(cyl(0.025, 0.025, 0.02, 10).rotateZ(Math.PI / 2), mat4(x + 0.1, F + 1.2, o.z + w / 2 + 0.36), c.accent);
}
export function rug(B, r, c) {
  const col1 = r.role === 'rugAccent' ? mixc(c.rug, c.accent, 0.35) : c.rug, w = r.x1 - r.x0, d = r.z1 - r.z0;
  B.solid.add(box(w, 0.02, d), mat4((r.x0 + r.x1) / 2, F + 0.03, (r.z0 + r.z1) / 2), r.role === 'rugAccent' ? mixc(c.rugBorder, c.accent, 0.3) : c.rugBorder);
  B.solid.add(box(w - 0.24, 0.022, d - 0.24), mat4((r.x0 + r.x1) / 2, F + 0.031, (r.z0 + r.z1) / 2), col1);
}
export function floorLed(B, r, c) { B.em.add(box(r.x1 - r.x0, 0.01, r.z1 - r.z0), mat4((r.x0 + r.x1) / 2, F + 0.03, (r.z0 + r.z1) / 2), c.accent2); }
export function cableTray(B, r, c) { B.solid.add(box(r.x1 - r.x0, 0.06, r.z1 - r.z0), mat4((r.x0 + r.x1) / 2, F + 2.4, (r.z0 + r.z1) / 2), shade(c.metal, 1.5)); }
export function easel(B, o, c) { for (const sx of [-0.35, 0.35]) B.solid.add(box(0.04, 1.8, 0.04), local(o, sx, 0.9, 0, 0, -0.18, sx > 0 ? -0.12 : 0.12), c.wood); B.solid.add(box(0.04, 1.7, 0.04), local(o, 0, 0.85, 0.35, 0, 0.3), c.wood); B.solid.add(box(1.0, 0.75, 0.03), local(o, 0, 1.35, -0.12, 0, -0.18), c.paper); for (let i = 0; i < 4; i++) B.solid.add(box(0.18, 0.18, 0.01), local(o, -0.3 + i * 0.2, 1.4 - (i % 2) * 0.2, -0.15, 0, -0.18), [c.accent, c.accent2, '#f0c35a', '#8fc0f2'][i]); }

export function lockers(B, o, c, { n = 6 } = {}) {
  const w = 0.55, h = 1.9, d = 0.5;
  for (let i = 0; i < n; i++) { const lx = (i - (n - 1) / 2) * w; B.solid.add(box(w - 0.02, h, d), local(o, lx, h / 2, 0), shade(c.metal, 2.4)); B.solid.add(box(w - 0.1, h - 0.12, 0.01), local(o, lx, h / 2, -d / 2 - 0.004), shade(c.metal, 2.0)); B.solid.add(box(0.03, 0.12, 0.02), local(o, lx + w / 2 - 0.1, h / 2 + 0.1, -d / 2 - 0.012), c.brass); }
}
export function planter(B, o, c, { len = 6 } = {}) {
  B.solid.add(box(len, 0.62, 0.5), local(o, 0, 0.31, 0), c.wood);
  const r = rng(Math.round(o.x * 11 + o.z * 3) + 41);
  for (let x = -len / 2 + 0.3; x < len / 2 - 0.2; x += 0.42) { const g = new THREE.IcosahedronGeometry(0.22 + r() * 0.08, 0); g.scale(1, 0.75, 1); B.solid.add(g, local(o, x, 0.75 + r() * 0.1, (r() - 0.5) * 0.15, r() * 3), r() < 0.5 ? c.leaf : c.leaf2); }
}
export function workbench(B, o, c, { w = 3.6 } = {}) {
  table(B, o, c, { w, d: 0.9, h: 0.95 });
  B.solid.add(box(w, 1.0, 0.04), local(o, 0, 1.6, 0.47 - 0.9), shade(c.wall, 0.9));   // a pegboard behind (towards the wall)
  const r = rng(Math.round(o.x * 5) + 9);
  for (let i = 0; i < 6; i++) B.solid.add(box(0.16, 0.012, 0.3), local(o, -w / 2 + 0.4 + i * 0.55, 1.0, -0.1 + (r() - 0.5) * 0.2, (r() - 0.5) * 0.4), i % 2 ? '#1f2329' : '#3a3f47');   // devices under test
  B.solid.add(box(0.5, 0.02, 0.34), local(o, 0.9, 1.0, 0.15), shade(c.metal, 1.8)); B.solid.add(box(0.5, 0.32, 0.02), local(o, 0.9, 1.16, -0.02, 0, -0.3), '#1f2329');   // a laptop
  for (let i = 0; i < 8; i++) B.solid.add(box(0.08, 0.2, 0.03), local(o, -w / 2 + 0.3 + i * 0.4, 1.7 + (i % 2) * 0.25, 0.47 - 0.92), i % 3 ? c.metal : c.accent);
}
export function pingpong(B, o, c) {
  const w = 2.74, d = 1.525;
  B.solid.add(box(w, 0.04, d), local(o, 0, 0.74, 0), '#2f6f5e');
  B.solid.add(box(w, 0.006, 0.03), local(o, 0, 0.763, 0), '#f4f4f0'); B.solid.add(box(0.03, 0.006, d), local(o, 0, 0.763, 0), '#f4f4f0');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.solid.add(box(0.05, 0.72, 0.05), local(o, sx * (w / 2 - 0.2), 0.36, sz * (d / 2 - 0.15)), c.metal);
  B.solid.add(box(0.02, 0.15, d + 0.1), local(o, 0, 0.83, 0), '#e8e8e2');
  B.solid.add(cyl(0.08, 0.08, 0.012, 12), local(o, -0.6, 0.77, 0.3), '#c4454f'); B.solid.add(cyl(0.08, 0.08, 0.012, 12), local(o, 0.7, 0.77, -0.2), '#1f2329');
}
export function beanbag(B, o, c) { const g = new THREE.SphereGeometry(0.42, 12, 8); g.scale(1, 0.62, 1); B.solid.add(g, local(o, 0, 0.26, 0), c.accent); }
export function pool(B, o, c, { w = 4, d = 2 } = {}) {
  B.solid.add(box(w, 0.4, d), local(o, 0, 0.2, 0), c.stone); B.solid.add(box(w - 0.24, 0.02, d - 0.24), local(o, 0, 0.402, 0), '#5f9cc4');
  B.em.add(box(w - 0.3, 0.012, 0.03), local(o, 0, 0.415, d / 2 - 0.16), '#9fd4f0'); B.em.add(box(w - 0.3, 0.012, 0.03), local(o, 0, 0.415, -d / 2 + 0.16), '#9fd4f0');
  for (const sx of [-1, 1]) plant(B, { x: o.x + sx * (w / 2 + 0.35), z: o.z }, c, {});
}

// sticky notes and mood boards: colour only, no writing (a decoration, not data)
export function stickies(B, o, c, { w = 6, h = 1.8, y = 1.45 } = {}) {
  B.solid.add(box(w, h, 0.03), local(o, 0, y, 0), shade(c.wall, 0.94));
  const r = rng(Math.round(o.z * 10) + 77), COL = ['#ffe066', '#ffd166', '#f7a8b8', '#a0e7e5', '#b4f8c8', '#fbe7c6', '#c3b1e1'];
  for (let gx = 0; gx < Math.floor(w / 0.32); gx++) for (let gy = 0; gy < Math.floor(h / 0.32); gy++) { if (r() < 0.32) continue; B.solid.add(box(0.24, 0.24, 0.012), local(o, -w / 2 + 0.2 + gx * 0.32 + (r() - 0.5) * 0.05, y - h / 2 + 0.2 + gy * 0.32 + (r() - 0.5) * 0.05, -0.022, 0, 0, (r() - 0.5) * 0.15), COL[Math.floor(r() * COL.length)]); }
}
export function moodboard(B, o, c, { w = 2.8, h = 1.7, y = 1.6, seed = 1 } = {}) {
  B.solid.add(box(w + 0.08, h + 0.08, 0.04), local(o, 0, y, 0), '#d9cfc1');
  B.solid.add(box(w, h, 0.02), local(o, 0, y, -0.02), '#f3eee6');
  const r = rng(seed + 300), SW = ['#ef7f8f', '#58b8b0', '#f0b94c', '#6f93d8', '#8aa77e', '#c9724b', '#c3b1e1', '#2b2a28'];
  for (let i = 0; i < 7; i++) { const sw = 0.3 + r() * 0.5, sh = 0.3 + r() * 0.45; B.solid.add(box(sw, sh, 0.012), local(o, (r() - 0.5) * (w - sw), y + (r() - 0.5) * (h - sh), -0.035, 0, 0, (r() - 0.5) * 0.2), SW[Math.floor(r() * SW.length)]); }
}

// ---- screens: the frame round a screen (the face is a canvas texture, boards.js). style: screen, board (a whiteboard), sign (a stone
// plate with the station's name), glass-sign (on a glass door), plate (a small brass plate), portrait (a framed picture)
export function screenFrame(B, sc, c) {
  const o = { x: sc.x, z: sc.z, yaw: sc.yaw }, y = sc.y, w = sc.w, h = sc.h;
  if (sc.style === 'board') { B.solid.add(box(w + 0.12, h + 0.12, 0.04), local(o, 0, y, 0.02), '#6b7079'); B.solid.add(box(w * 0.6, 0.04, 0.1), local(o, 0, y - h / 2 - 0.06, -0.03), '#9aa0a8'); return; }
  if (sc.style === 'sign') { B.solid.add(box(w + 0.3, h + 0.2, 0.06), local(o, 0, y, 0.03), '#2b2c30'); B.em.add(box(w + 0.2, 0.02, 0.02), local(o, 0, y - h / 2 - 0.12, -0.02), c.accent); return; }
  if (sc.style === 'glass-sign') return;
  if (sc.style === 'plate') { B.solid.add(box(w + 0.06, h + 0.06, 0.03), local(o, 0, y, 0.015), c.brass); return; }
  if (sc.style === 'portrait') { B.solid.add(box(w + 0.16, h + 0.16, 0.05), local(o, 0, y, 0.025), c.brass); return; }
  B.solid.add(rbox(w + 0.12, h + 0.12, 0.06, 0.02), local(o, 0, y, 0.03), c.screenFrame);
  if (sc.stand) {   // a free-standing screen: a back panel and two feet
    B.solid.add(box(w + 0.3, y + h / 2 + 0.2, 0.08), local(o, 0, (y + h / 2 + 0.2) / 2, 0.1), c.wood);
    for (const sx of [-1, 1]) B.solid.add(box(0.12, 0.05, 0.7), local(o, sx * (w / 2 - 0.1), 0.025, 0.1), c.metal);
  }
}
// where a screen's face sits: just in front of its frame, facing local -z
export function screenFace(sc) { const off = 0.012; return { x: sc.x - Math.sin(sc.yaw) * off, y: PT + sc.y, z: sc.z - Math.cos(sc.yaw) * off, ry: sc.yaw + Math.PI }; }

// ---- the penthouse's city skyline beyond its glass walls: blocks of towers (lit windows by night are a canvas texture, boards.js)
export function skyline(B, c) {
  const r = rng(2026);
  for (const axis of ['x', 'z']) {
    let u = (axis === 'x' ? SLAB.z0 : SLAB.x0) - 6, end = (axis === 'x' ? SLAB.z1 : SLAB.x1) - 2;
    while (u < end) {
      const w = 1.4 + r() * 2.6, top = -4.5 + r() * r() * 9, bottom = -14, h = top - bottom, back = 2.5 + r() * 9, tint = r() < 0.5 ? c.skyA : c.skyB;
      const x = axis === 'x' ? SLAB.x0 - back - 1.5 : u + w / 2, z = axis === 'x' ? u + w / 2 : SLAB.z0 - back - 1.5;
      B.solid.add(box(axis === 'x' ? 2 : w, h, axis === 'x' ? w : 2), mat4(x, bottom + h / 2, z), tint);
      // lit windows on the face that looks at the building
      for (let k = 0; k < Math.floor(w * 4); k++) if (r() < 0.6) { const wy = top - 0.4 - r() * 6, wu = (r() - 0.5) * (w - 0.4); B.em.add(box(axis === 'x' ? 0.02 : 0.22, 0.14, axis === 'x' ? 0.22 : 0.02), mat4(axis === 'x' ? x + 1.01 : x + wu, wy, axis === 'x' ? z + wu : z + 1.01), c.skyWin); }
      u += w + 0.15 + r() * 0.6;
    }
  }
}

// one prop from a plan
export function addProp(B, p, c) {
  const o = { x: p.x, z: p.z, yaw: p.yaw || 0 };
  switch (p.kind) {
    case 'rug': return rug(B, p, c);
    case 'glass': return glassRun(B, p, c);
    case 'execDesk': return seat(B, { ...o, kind: 'exec', state: 'owner' }, c);
    case 'chair': return chair(B, o, c, { exec: !!p.exec });
    case 'table': return table(B, o, c, p);
    case 'roundTable': return roundTable(B, o, c, p);
    case 'coffeeTable': return coffeeTable(B, o, c, p);
    case 'couch': return couch(B, o, c, p);
    case 'armchair': return armchair(B, o, c);
    case 'bench': return bench(B, o, c, p);
    case 'counter': return counter(B, o, c, p);
    case 'stool': return stool(B, o, c);
    case 'plant': return plant(B, o, c, p);
    case 'floorLamp': return floorLamp(B, o, c);
    case 'shelf': return shelf(B, o, c, p);
    case 'cabinet': return cabinet(B, o, c, p);
    case 'reception': return reception(B, o, c);
    case 'booth': return booth(B, o, c);
    case 'lift': return lift(B, o, c);
    case 'floorLed': return floorLed(B, p, c);
    case 'cableTray': return cableTray(B, p, c);
    case 'easel': return easel(B, o, c);
    case 'stickies': return stickies(B, o, c, p);
    case 'moodboard': return moodboard(B, o, c, p);
    case 'lockers': return lockers(B, o, c, p);
    case 'planter': return planter(B, o, c, p);
    case 'workbench': return workbench(B, o, c, p);
    case 'beanbag': return beanbag(B, o, c);
    case 'pingpong': return pingpong(B, o, c);
    case 'pool': return pool(B, o, c, p);
    default: return null;
  }
}
export const KIT_PROPS = ['rug', 'glass', 'execDesk', 'chair', 'table', 'roundTable', 'coffeeTable', 'couch', 'armchair', 'bench', 'counter', 'stool', 'plant', 'floorLamp', 'shelf', 'cabinet', 'reception', 'booth', 'lift', 'floorLed', 'cableTray', 'easel', 'stickies', 'moodboard', 'lockers', 'planter', 'workbench', 'beanbag', 'pool', 'pingpong'];
