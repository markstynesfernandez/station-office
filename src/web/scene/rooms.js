// scene/rooms.js — the static part of the office (Redesign R1), built from the floor plan in layout.js. Everything is
// procedural geometry with flat vertex colours, merged into a few meshes so the whole static office costs a handful of
// draw calls:
//   statics   one vertex-coloured mesh per room (and one each for the atrium, the lounge and the closet)
//   wood      the room and lounge floors (the shared oak texture, planar UVs; R3a)       tile   the atrium slab (tiles texture)
//   decals    framed pictures, the mood board and the whiteboard (one atlas texture)
//   emissive  LED strips, lamp bulbs, closet LEDs (unlit, so they read as light in dark mode)
//   glow      additive soft quads: LED washes on walls and floors, lamp pools (dark mode only)
// Book spines, notes and pictures carry no text or real titles; the pictures are seeded abstract compositions.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLOOR, WALL_H, WALL_T, CORE_R, wallJoined, areaOf } from './layout.js';
import { rng, ATLAS, atlasUV, GLOW_UV } from './textures.js';
import { FLOOR_OAK } from './bakedlook.js';

const BOOKS = ['#7b2d26', '#2f4858', '#3d5a40', '#8c6d46', '#5b5f97', '#b5533c', '#d9b26f', '#e8e1d4', '#3b3b3b', '#6b4e71', '#9a8f7a', '#2e5e6e', '#a3473a', '#c9c1b1'];
const BINDERS = ['#1f3b5c', '#3a3a3c', '#8c2f2f', '#4a6a8a', '#e3ddd2', '#2f5d50'];
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r = 0.04) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) / 2));
const cyl = (r0, r1, h, n = 12) => new THREE.CylinderGeometry(r0, r1, h, n);
export const mat4 = (x, y, z, ry = 0, rx = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
const col = (c) => new THREE.Color(c);
export const mix = (a, b, t) => col(a).lerp(col(b), t);

// a geometry ready to merge: transformed, non-indexed, with the attributes the bucket wants
function prep(geo, m, { color = null, uv = false } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (m) g.applyMatrix4(m);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(uv && k === 'uv')) g.deleteAttribute(k);
  if (color) { const c = col(color), n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
  geo.dispose(); return g;
}
function bucket(opts) {
  const parts = [];
  return { parts, add(geo, m, color) { parts.push(prep(geo, m, { ...opts, color: opts.color ? color : null })); }, merge() { if (!parts.length) return null; const g = mergeGeometries(parts); for (const p of parts) p.dispose(); parts.length = 0; return g; } };
}
// planar UVs from world x/z (floors)
function planarUV(g, scale) { const p = g.attributes.position, uv = new Float32Array(p.count * 2); for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / scale; uv[i * 2 + 1] = -p.getZ(i) / scale; } g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return g; }
function regionUV(g, [u0, v0, u1, v1]) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0)); return g; }

// placement on a back wall: 'z' wall (plane z = at, faces +z) or 'x' wall (plane x = at, faces +x); u runs along the
// wall, v is the distance out from the wall's inner face
const onWall = (axis, at, u, y, v) => (axis === 'z' ? mat4(u, y, at + WALL_T + v, 0) : mat4(at + WALL_T + v, y, u, Math.PI / 2));
// placement in a furniture item's own frame (it faces local -z; yaw as in layout.js)
const local = (o, lx, ly, lz, extra = 0, rx = 0, rz = 0) => { const c = Math.cos(o.yaw || 0), s = Math.sin(o.yaw || 0); return mat4(o.x + lx * c + lz * s, ly, o.z - lx * s + lz * c, (o.yaw || 0) + extra, rx, rz); };

// opts.skipRooms (R3a): department keys whose rooms are drawn elsewhere (the baked rooms): their walls, floors,
// furniture, decals and the props inside them are left out; their open-edge floor LEDs and washes stay (real-time glow).
// R3b: also 'lounge' and 'atrium'. A baked atrium leaves out the slab, its floor, the core plinth, the atrium walls and
// what hangs on them, its props and the closet's floor, partition and cable tray; the slab's edge LEDs, the core's
// floor glow and the closet's LEDs (status colours) stay real-time.
// Floors: one oak texture for the whole office at the baked rooms' scale (bakedlook.js FLOOR_OAK).
export function buildRooms(L, p, accents, opts = {}) {
  const skipKeys = opts.skipRooms || [], skips = L.rooms.filter((r) => skipKeys.includes(r.key));
  const skipAtrium = skipKeys.includes('atrium'), skipLounge = skipKeys.includes('lounge');
  const out = { statics: [], wood: null, tile: null, decals: null, emissive: null, glow: null };
  const wood = bucket({ uv: true }), tile = bucket({ uv: true }), decals = bucket({ uv: true }), em = bucket({ color: true }), glow = bucket({ uv: true, color: true });
  const ledC = p.led, glowC = col(p.ledGlowColour).multiplyScalar(p.ledGlow);
  const r0 = rng(101);
  // a wall end is open (a dollhouse cut, edged in the cap colour) unless another wall continues it or meets it there
  const joined = (w, e) => wallJoined(L.walls, w, e);

  // ---- glow helpers (additive quads, dark mode)
  function wash(m, w, h, strength = 1) { const g = regionUV(new THREE.PlaneGeometry(w, h), GLOW_UV.wash); glow.add(g, m, glowC.clone().multiplyScalar(strength)); }
  function pool(x, y, z, rad, strength = 1, c = glowC) { const g = regionUV(new THREE.PlaneGeometry(rad * 2, rad * 2).rotateX(-Math.PI / 2), GLOW_UV.pool); glow.add(g, mat4(x, y, z), col(c).multiplyScalar(strength)); }
  // a floor-edge LED: an emissive line on the edge face and a wash on the floor below/outside it. side: '+x' or '+z'
  function edgeLED(side, at, from, to, y, washY, width = 1.1, strength = 0.8) {
    const len = to - from, mid = (from + to) / 2;
    if (side === '+z') { em.add(box(len, 0.018, 0.012), mat4(mid, y, at + 0.006), ledC); wash(mat4(mid, washY, at + width / 2, 0, -Math.PI / 2), len, width, strength); }
    else { em.add(box(0.012, 0.018, len), mat4(at + 0.006, y, mid), ledC); wash(mat4(at + width / 2, washY, mid, Math.PI / 2, -Math.PI / 2), len, width, strength); }
  }

  // ---- shared furniture pieces (S: the static bucket of the room they stand in)
  function wallShelf(S, axis, at, u, len, y, seed) {
    const r = rng(seed);
    S.add(box(len, 0.04, 0.26), onWall(axis, at, u, y, 0.13), p.shelf);
    em.add(box(len - 0.08, 0.012, 0.014), onWall(axis, at, u, y - 0.026, 0.235), ledC);
    wash(onWall(axis, at, u, y - 0.03 - 0.55, 0.012), len + 0.2, 1.1, 1.3);
    // objects: a few upright books, a small box and a little pot
    let cu = u - len / 2 + 0.12;
    const nb = 4 + Math.floor(r() * 4);
    for (let i = 0; i < nb; i++) { const w = 0.035 + r() * 0.035, h = 0.18 + r() * 0.1; S.add(box(w, h, 0.18), onWall(axis, at, cu + w / 2, y + 0.02 + h / 2, 0.14), BOOKS[Math.floor(r() * BOOKS.length)]); cu += w + 0.004; }
    S.add(box(0.22, 0.12, 0.16), onWall(axis, at, u + len * 0.12, y + 0.08, 0.13), p.shelfObject);
    trailing(S, axis, at, u + len / 2 - 0.2, y + 0.02, 0.14, r);
  }
  // a trailing plant in a small pot on a shelf: a leafy crown and strands of leaves hanging over the front edge
  function trailing(S, axis, at, u, y, v, r) {
    S.add(cyl(0.075, 0.058, 0.13, 10), onWall(axis, at, u, y + 0.065, v), p.potSmall);
    S.add(new THREE.IcosahedronGeometry(0.11, 0), onWall(axis, at, u, y + 0.17, v), p.leafSmall);
    for (const [du, n] of [[-0.07, 4], [0.05, 6], [0.11, 3]]) for (let i = 0; i < n; i++) {
      const g = new THREE.IcosahedronGeometry(0.045 + r() * 0.02, 0);
      S.add(g, onWall(axis, at, u + du + (r() - 0.5) * 0.04, y + 0.1 - i * 0.075, v + 0.1 + Math.min(i, 2) * 0.012), i % 2 ? p.leafSmall : p.leafTrail);
    }
  }
  // a wall clock (face, rim, twelve ticks, two hands; it shows no particular time), built in the wall's own frame
  function clock(S, axis, at, u, y) {
    const m = onWall(axis, at, u, y, 0);
    S.add(cyl(0.21, 0.21, 0.04, 24).rotateX(Math.PI / 2).translate(0, 0, 0.02), m, p.clockRim);
    S.add(cyl(0.185, 0.185, 0.008, 24).rotateX(Math.PI / 2).translate(0, 0, 0.042), m, p.clockFace);
    for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6; S.add(box(0.012, k % 3 ? 0.025 : 0.045, 0.004).rotateZ(-a).translate(Math.sin(a) * 0.155, Math.cos(a) * 0.155, 0.047), m, p.clockRim); }
    S.add(box(0.016, 0.11, 0.006).translate(0, 0.045, 0).rotateZ(-2.1).translate(0, 0, 0.05), m, p.clockRim);
    S.add(box(0.011, 0.15, 0.006).translate(0, 0.065, 0).rotateZ(-0.5).translate(0, 0, 0.054), m, p.clockRim);
  }
  // ---- props (positions and footprints from layout.js; each faces local -z, turned by its yaw)
  function bench(S, o) {
    for (let i = 0; i < 3; i++) S.add(box(1.7, 0.05, 0.13), local(o, 0, FLOOR + 0.45, -0.15 + i * 0.15), p.woodSolid);
    for (const sx of [-0.68, 0.68]) { S.add(box(0.05, 0.42, 0.4), local(o, sx, FLOOR + 0.22, 0), p.metal); }
    S.add(box(1.36, 0.035, 0.035), local(o, 0, FLOOR + 0.12, 0), p.metal);
  }
  function printer(S, o) {
    S.add(rbox(0.9, 0.62, 0.62, 0.04), local(o, 0, FLOOR + 0.33, 0), p.printer);          // body on its cabinet
    S.add(rbox(0.86, 0.34, 0.6, 0.04), local(o, 0, FLOOR + 0.81, 0.01), p.printerTop);     // scanner unit
    S.add(box(0.62, 0.03, 0.42), local(o, 0, FLOOR + 1.0, 0.02), p.printerLid);
    S.add(box(0.5, 0.02, 0.26), local(o, 0.04, FLOOR + 0.67, -0.2), p.paper);              // output tray with paper
    S.add(box(0.2, 0.09, 0.012), local(o, 0.25, FLOOR + 0.9, -0.31, 0, -0.4), p.metal);    // control panel
    for (let i = 0; i < 2; i++) S.add(box(0.8, 0.006, 0.004), local(o, 0, FLOOR + 0.22 + i * 0.2, -0.312), p.seam);
    em.add(box(0.03, 0.02, 0.01), local(o, 0.32, FLOOR + 0.93, -0.33), p.rackLedA);
  }
  function cooler(S, o) {
    S.add(rbox(0.38, 0.95, 0.38, 0.04), local(o, 0, FLOOR + 0.475, 0), p.cooler);
    S.add(box(0.2, 0.12, 0.04), local(o, 0, FLOOR + 0.78, -0.2), p.metal);                 // tap recess
    S.add(box(0.24, 0.02, 0.12), local(o, 0, FLOOR + 0.5, -0.19), p.metal);                // drip tray
    S.add(cyl(0.15, 0.15, 0.36, 14), local(o, 0, FLOOR + 1.16, 0), p.water);               // the bottle
    S.add(cyl(0.06, 0.15, 0.08, 14), local(o, 0, FLOOR + 1.38, 0), p.water);
    S.add(cyl(0.05, 0.05, 0.03, 10), local(o, 0.32, FLOOR + 0.02, -0.05), p.shelfObject);   // cup bin beside it
    S.add(cyl(0.045, 0.035, 0.22, 10), local(o, 0.32, FLOOR + 0.13, -0.05), p.label);
  }
  function meeting(S, o) {
    S.add(cyl(0.5, 0.5, 0.04, 28), local(o, 0, FLOOR + 0.74, 0), p.woodSolid);
    S.add(cyl(0.035, 0.035, 0.7, 8), local(o, 0, FLOOR + 0.37, 0), p.metal);
    S.add(cyl(0.26, 0.28, 0.025, 16), local(o, 0, FLOOR + 0.013, 0), p.metal);
    for (const sx of [-0.8, 0.8]) {   // two stools
      S.add(cyl(0.19, 0.19, 0.05, 16), local(o, sx, FLOOR + 0.48, 0.05), p.leather);
      S.add(cyl(0.025, 0.025, 0.45, 8), local(o, sx, FLOOR + 0.23, 0.05), p.metal);
      S.add(cyl(0.16, 0.17, 0.02, 14), local(o, sx, FLOOR + 0.01, 0.05), p.metal);
    }
    S.add(box(0.3, 0.012, 0.22), local(o, -0.12, FLOOR + 0.766, 0.05, 0.3), p.label);      // a few papers and a mug
    S.add(cyl(0.04, 0.035, 0.09, 10), local(o, 0.2, FLOOR + 0.805, -0.1), p.mug);
  }
  function easel(S, o) {
    for (const sx of [-0.28, 0.28]) S.add(box(0.035, 1.6, 0.035), local(o, sx, FLOOR + 0.8, 0, 0, -0.08, sx > 0 ? -0.1 : 0.1), p.woodSolid);
    S.add(box(0.035, 1.5, 0.035), local(o, 0, FLOOR + 0.75, 0.32, 0, 0.35), p.woodSolid);
    S.add(box(0.7, 0.035, 0.08), local(o, 0, FLOOR + 0.62, -0.06), p.woodSolid);
    S.add(box(0.7, 0.55, 0.03), local(o, 0, FLOOR + 0.93, -0.03, 0, -0.08), p.mat);
    decals.add(regionUV(new THREE.PlaneGeometry(0.64, 0.49), atlasUV(ATLAS.art[3])), local(o, 0, FLOOR + 0.93, -0.05, Math.PI, 0.08));
  }
  function frame(S, axis, at, u, y, w, h, region) {
    S.add(box(w, h, 0.04), onWall(axis, at, u, y, 0.02), p.frame);
    S.add(box(w - 0.07, h - 0.07, 0.004), onWall(axis, at, u, y, 0.042), p.mat);
    decals.add(regionUV(new THREE.PlaneGeometry(w - 0.24, h - 0.24), atlasUV(region)), onWall(axis, at, u, y, 0.046));
  }
  function bookcase(S, axis, at, u0, u1, seed) {
    const r = rng(seed), D = 0.38, Hc = 2.3, len = u1 - u0, um = (u0 + u1) / 2, y0 = FLOOR + 0.02;
    S.add(box(len, Hc, 0.03), onWall(axis, at, um, y0 + Hc / 2, 0.015), p.shelfBack);
    S.add(box(len, 0.08, D), onWall(axis, at, um, y0 + 0.04, D / 2), p.shelf);
    S.add(box(len, 0.05, D), onWall(axis, at, um, y0 + Hc - 0.025, D / 2), p.shelf);
    const bays = Math.max(1, Math.round(len / 1.05)), bw = len / bays;
    for (let b = 0; b <= bays; b++) S.add(box(0.04, Hc, D), onWall(axis, at, u0 + b * bw, y0 + Hc / 2, D / 2), p.shelf);
    const levels = 5, lh = (Hc - 0.13) / levels;
    for (let k = 1; k < levels; k++) {
      const y = y0 + 0.08 + k * lh;
      S.add(box(len, 0.03, D), onWall(axis, at, um, y, D / 2), p.shelf);
    }
    for (let k = 0; k < levels; k++) {
      const base = y0 + 0.08 + k * lh + 0.015, maxH = lh - 0.06;
      if (k > 0) { em.add(box(len - 0.06, 0.01, 0.012), onWall(axis, at, um, base + lh - 0.035, D - 0.03), ledC); wash(onWall(axis, at, um, base + lh / 2, 0.034), len, lh, 0.9); }
      for (let b = 0; b < bays; b++) {
        let cu = u0 + b * bw + 0.04; const end = u0 + (b + 1) * bw - 0.04;
        while (cu < end - 0.04) {
          const roll = r();
          if (roll < 0.05) { cu += 0.08 + r() * 0.14; continue; }                       // a gap
          if (roll < 0.11 && end - cu > 0.3) {                                            // a stack lying flat
            const n = 2 + Math.floor(r() * 3);
            for (let i = 0; i < n; i++) S.add(box(0.26 - i * 0.015, 0.045, 0.21), onWall(axis, at, cu + 0.14, base + 0.0225 + i * 0.047, D - 0.13), BOOKS[Math.floor(r() * BOOKS.length)]);
            cu += 0.32; continue;
          }
          if (roll < 0.3) {                                                               // a run of binders with label patches
            const c = BINDERS[Math.floor(r() * BINDERS.length)], n = 2 + Math.floor(r() * 3);
            for (let i = 0; i < n && cu < end - 0.08; i++) { const w = 0.075, h = Math.min(maxH, 0.32); S.add(box(w, h, 0.27), onWall(axis, at, cu + w / 2, base + h / 2, D - 0.135), c); S.add(box(0.045, 0.06, 0.004), onWall(axis, at, cu + w / 2, base + h * 0.3, D + 0.001), p.label); cu += w + 0.004; }
            continue;
          }
          const w = 0.03 + r() * 0.045, h = Math.min(maxH, 0.2 + r() * 0.15), d = 0.19 + r() * 0.08;
          S.add(box(w, h, d), onWall(axis, at, cu + w / 2, base + h / 2, D - d / 2), BOOKS[Math.floor(r() * BOOKS.length)]);
          cu += w + 0.003;
        }
      }
    }
  }
  function armchair(S, o, fabric) {
    S.add(rbox(0.9, 0.24, 0.85, 0.05), local(o, 0, FLOOR + 0.2, 0), fabric);
    S.add(rbox(0.66, 0.14, 0.66, 0.05), local(o, 0, FLOOR + 0.38, -0.05), fabric);
    S.add(rbox(0.9, 0.55, 0.18, 0.06), local(o, 0, FLOOR + 0.55, 0.34), fabric);
    for (const sx of [-1, 1]) S.add(rbox(0.14, 0.42, 0.8, 0.05), local(o, sx * 0.39, FLOOR + 0.42, 0.02), fabric);
    for (const [lx, lz] of [[-0.36, -0.34], [0.36, -0.34], [-0.36, 0.34], [0.36, 0.34]]) S.add(cyl(0.025, 0.02, 0.1, 6), local(o, lx, FLOOR + 0.05, lz), p.metal);
  }
  function sofa(S, o, len, fabric) {
    S.add(rbox(len, 0.24, 0.92, 0.05), local(o, 0, FLOOR + 0.2, 0), p.sofaBase);
    const n = 3, cw = (len - 0.34) / n;
    for (let i = 0; i < n; i++) S.add(rbox(cw - 0.03, 0.15, 0.68, 0.05), local(o, -len / 2 + 0.17 + cw * (i + 0.5), FLOOR + 0.38, -0.06), fabric);
    S.add(rbox(len - 0.3, 0.5, 0.2, 0.06), local(o, 0, FLOOR + 0.58, 0.34), fabric);
    for (const sx of [-1, 1]) S.add(rbox(0.17, 0.44, 0.92, 0.05), local(o, sx * (len / 2 - 0.085), FLOOR + 0.42, 0), fabric);
    for (const [lx, lz] of [[-len / 2 + 0.1, -0.36], [len / 2 - 0.1, -0.36], [-len / 2 + 0.1, 0.36], [len / 2 - 0.1, 0.36]]) S.add(cyl(0.025, 0.02, 0.1, 6), local(o, lx, FLOOR + 0.05, lz), p.metal);
  }
  // an arc floor lamp: base at (x, z), shade reaching towards (tx, tz)
  function floorLamp(S, x, z, tx, tz) {
    const yaw = Math.atan2(-(tx - x), -(tz - z)), o = { x, z, yaw };
    S.add(cyl(0.17, 0.19, 0.04, 16), mat4(x, FLOOR + 0.02, z), p.metal);
    S.add(cyl(0.02, 0.02, 1.7, 8), mat4(x, FLOOR + 0.87, z), p.metal);
    S.add(box(0.03, 0.03, 0.75), local(o, 0, FLOOR + 1.78, -0.33, 0, 0.25), p.metal);
    S.add(new THREE.ConeGeometry(0.2, 0.22, 16, 1, true), local(o, 0, FLOOR + 1.62, -0.68), p.lampShade);
    em.add(new THREE.SphereGeometry(0.075, 10, 8), local(o, 0, FLOOR + 1.55, -0.68), p.bulb);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    pool(x - 0.68 * s, FLOOR + 0.03, z - 0.68 * c, 1.1, 0.9, p.lampGlow);
  }
  function rug(S, x0, x1, z0, z1, c, border) {
    S.add(box(x1 - x0, 0.012, z1 - z0), mat4((x0 + x1) / 2, FLOOR + 0.026, (z0 + z1) / 2), border);
    S.add(box(x1 - x0 - 0.24, 0.006, z1 - z0 - 0.24), mat4((x0 + x1) / 2, FLOOR + 0.034, (z0 + z1) / 2), c);
  }
  function cabinet(S, axis, at, u, w, h, color) {   // tall filing cabinet / locker with two doors
    S.add(box(w, h, 0.5), onWall(axis, at, u, FLOOR + h / 2 + 0.02, 0.27), color);
    S.add(box(0.01, h - 0.08, 0.004), onWall(axis, at, u, FLOOR + h / 2 + 0.02, 0.522), p.seam);
    for (const k of [-1, 1]) S.add(box(0.02, 0.16, 0.02), onWall(axis, at, u + k * 0.06, FLOOR + h * 0.55, 0.53), p.metal);
    for (let i = 1; i < 4; i++) S.add(box(w - 0.06, 0.006, 0.004), onWall(axis, at, u, FLOOR + 0.02 + (h * i) / 4, 0.522), p.seam);
  }
  function credenza(S, axis, at, u, len, seed) {
    S.add(box(len, 0.62, 0.45), onWall(axis, at, u, FLOOR + 0.35, 0.24), p.credenza);
    S.add(box(len + 0.04, 0.04, 0.48), onWall(axis, at, u, FLOOR + 0.68, 0.24), p.woodSolid);
    const n = Math.max(2, Math.round(len / 0.6));
    for (let i = 1; i < n; i++) S.add(box(0.008, 0.54, 0.004), onWall(axis, at, u - len / 2 + (len * i) / n, FLOOR + 0.35, 0.466), p.seam);
    const r = rng(seed);
    S.add(box(0.3, 0.06, 0.22), onWall(axis, at, u - len * 0.25, FLOOR + 0.73, 0.22), BOOKS[Math.floor(r() * BOOKS.length)]);
    S.add(box(0.27, 0.05, 0.2), onWall(axis, at, u - len * 0.25, FLOOR + 0.785, 0.22), BOOKS[Math.floor(r() * BOOKS.length)]);
    S.add(cyl(0.09, 0.07, 0.2, 10), onWall(axis, at, u + len * 0.28, FLOOR + 0.8, 0.22), p.potSmall);
    S.add(new THREE.IcosahedronGeometry(0.16, 0), onWall(axis, at, u + len * 0.28, FLOOR + 1.0, 0.22), p.leafSmall);
  }

  // ---- the slab and the atrium (one static mesh)
  const A = bucket({ color: true }), b = L.base;
  edgeLED('+z', b.z1, b.x0, b.x1, FLOOR - 0.06, 0.012, 1.6, 1.0);
  edgeLED('+x', b.x1, b.z0, b.z1, FLOOR - 0.06, 0.012, 1.6, 1.0);
  pool(0, FLOOR + 0.01, 0, CORE_R + 0.55, 0.7, p.hubCore);
  if (!skipAtrium) {
    A.add(box(b.w, FLOOR - 0.005, b.d), mat4(b.cx, (FLOOR - 0.005) / 2, b.cz), p.slabEdge);
    A.add(box(b.w + 0.06, 0.05, b.d + 0.06), mat4(b.cx, 0.025, b.cz), p.slabFoot);
    tile.add(planarUV(new THREE.PlaneGeometry(b.w, b.d).rotateX(-Math.PI / 2).translate(b.cx, FLOOR, b.cz), 6.4));
    // core plinth (octagon), pedestal and an inlay ring on the floor; R2: the plaza disc and the glow pool are about half
    // the R1 radius
    A.add(cyl(CORE_R - 0.1, CORE_R, 0.32, 8), mat4(0, FLOOR + 0.16, 0, Math.PI / 8), p.plinthEdge);
    A.add(cyl(CORE_R - 0.35, CORE_R - 0.27, 0.12, 8), mat4(0, FLOOR + 0.38, 0, Math.PI / 8), p.plinth);
    A.add(cyl(0.46, 0.6, 0.5, 6), mat4(0, FLOOR + 0.66, 0), p.plinthEdge);
    A.add(new THREE.CircleGeometry(CORE_R + 0.75, 48).rotateX(-Math.PI / 2), mat4(0, FLOOR + 0.002, 0), p.plaza);
    A.add(new THREE.RingGeometry(CORE_R + 0.2, CORE_R + 0.27, 48).rotateX(-Math.PI / 2), mat4(0, FLOOR + 0.004, 0), p.inlay);
    em.add(new THREE.RingGeometry(CORE_R - 0.02, CORE_R + 0.02, 8, 1, Math.PI / 8).rotateX(-Math.PI / 2), mat4(0, FLOOR + 0.322, 0), ledC);
    // atrium walls (outer back edge between the rooms), with caps and baseboards, and what hangs on them
    for (const w of L.walls) if (w.owner === 'atrium') wallRun(A, w, p.wall);
    const printerP = L.props.find((q) => q.kind === 'printer'), coolerP = L.props.find((q) => q.kind === 'cooler');
    if (printerP) { frame(A, 'z', b.z0, printerP.x, FLOOR + 2.08, 0.72, 0.5, ATLAS.art[4]); wallShelf(A, 'z', b.z0, printerP.x, 1.0, FLOOR + 1.36, 67); }
    if (coolerP) clock(A, 'z', b.z0, coolerP.x + 0.05, FLOOR + 2.05);
    const leftW = L.walls.find((w) => w.owner === 'atrium' && w.axis === 'x');
    if (leftW) { const um = (leftW.from + leftW.to) / 2; frame(A, 'x', leftW.at, um - 0.25, FLOOR + 1.6, 1.1, 0.75, ATLAS.art[5]); clock(A, 'x', leftW.at, um + 0.95, FLOOR + 1.95); }
  }
  // props go into the atrium mesh wherever they stand (the meeting table and the easel are in rooms); a baked area's are
  // in its glTF
  for (const q of L.props) if (!skipKeys.includes(areaOf(L, q))) ({ bench, printer, cooler, meeting, easel })[q.kind](A, q);
  out.statics.push({ key: 'atrium', geo: A.merge() });

  function wallRun(S, w, wallColour) {
    const len = w.to - w.from, mid = (w.from + w.to) / 2, h = w.h;
    for (const e of [w.from, w.to]) if (!joined(w, e)) {
      const z = e === w.from ? e + 0.02 : e - 0.02;
      if (w.axis === 'x') S.add(box(WALL_T + 0.04, h, 0.04), mat4(w.at + WALL_T / 2, FLOOR + h / 2, z), p.wallCap);
      else S.add(box(0.04, h, WALL_T + 0.04), mat4(z, FLOOR + h / 2, w.at + WALL_T / 2), p.wallCap);
    }
    if (w.axis === 'x') {
      S.add(box(WALL_T, h, len), mat4(w.at + WALL_T / 2, FLOOR + h / 2, mid), wallColour);
      S.add(box(WALL_T + 0.04, 0.05, len), mat4(w.at + WALL_T / 2, FLOOR + h + 0.025, mid), p.wallCap);
      S.add(box(0.03, 0.1, len), mat4(w.at + WALL_T + 0.015, FLOOR + 0.05, mid), p.baseboard);
    } else {
      S.add(box(len, h, WALL_T), mat4(mid, FLOOR + h / 2, w.at + WALL_T / 2), wallColour);
      S.add(box(len, 0.05, WALL_T + 0.04), mat4(mid, FLOOR + h + 0.025, w.at + WALL_T / 2), p.wallCap);
      S.add(box(len, 0.1, 0.03), mat4(mid, FLOOR + 0.05, w.at + WALL_T + 0.015), p.baseboard);
    }
  }

  // ---- department rooms
  for (const r of L.rooms) {
    // LED along the room's open floor edges inside the slab (the slab's own edge has its LED)
    if (r.z1 < b.z1 - 0.01) edgeLED('+z', r.z1, r.x0, r.x1, FLOOR + 0.01, FLOOR + 0.004, 0.7, 0.5);
    if (r.x1 < b.x1 - 0.01) edgeLED('+x', r.x1, r.z0, r.z1, FLOOR + 0.01, FLOOR + 0.004, 0.7, 0.5);
    if (skips.includes(r)) continue;
    const S = bucket({ color: true }), accent = accents[r.key] || accents.default;
    const wallC = mix(p.wall, accent, p.wallTint);
    wood.add(planarUV(box(r.w, 0.02, r.d).translate(r.cx, FLOOR + 0.01, r.cz), FLOOR_OAK.tile));
    for (const w of L.walls) if (w.owner === r.key) wallRun(S, w, wallC);
    for (const c of r.clusters) rug(S, c.x0, c.x1, c.z0, c.z1, p.rug, p.rugBorder);
    const zA = r.z0, xA = r.x0;                     // wall 'z' at zA (back right on screen), wall 'x' at xA (back left)
    const deskU0 = r.desks.length ? Math.min(...r.desks.map((d) => d.x)) - 1.05 : r.x0 + r.pad.left, deskU1 = r.desks.length ? Math.max(...r.desks.map((d) => d.x)) + 1.05 : r.x1 - r.pad.right;
    if (r.kind === 'research') {
      bookcase(S, 'z', zA, r.x0 + 0.35, r.x1 - 1.2, 31 + r.w * 10);
      // reading nook on the left wall: armchair, arc lamp, side table, a picture and a lit shelf
      const chair = { x: r.x0 + 1.25, z: r.z0 + 2.75, yaw: -Math.PI * 0.62 };
      armchair(S, chair, p.leather);
      floorLamp(S, r.x0 + 0.55, r.z0 + 1.55, chair.x, chair.z);
      S.add(cyl(0.24, 0.24, 0.03, 16), mat4(r.x0 + 2.25, FLOOR + 0.55, r.z0 + 3.55), p.woodSolid); S.add(cyl(0.03, 0.03, 0.54, 8), mat4(r.x0 + 2.25, FLOOR + 0.27, r.z0 + 3.55), p.metal);
      S.add(box(0.22, 0.05, 0.16), mat4(r.x0 + 2.25, FLOOR + 0.59, r.z0 + 3.55, 0.4), BOOKS[1]);
      frame(S, 'x', xA, r.z0 + 2.9, FLOOR + 1.75, 0.95, 1.2, ATLAS.art[0]);
      wallShelf(S, 'x', xA, r.z0 + 1.35, 1.2, FLOOR + 1.55, 41);
    } else if (r.kind === 'design') {
      // mood board over the desks, a gallery of framed pictures and a credenza on the left wall
      const bw = Math.min(4.2, deskU1 - deskU0 - 0.4), bh = 1.55, bu = (deskU0 + deskU1) / 2;
      S.add(box(bw + 0.1, bh + 0.1, 0.05), onWall('z', zA, bu, FLOOR + 1.72, 0.025), p.woodSolid);
      decals.add(regionUV(new THREE.PlaneGeometry(bw, bh), atlasUV(ATLAS.board)), onWall('z', zA, bu, FLOOR + 1.72, 0.052));
      wallShelf(S, 'z', zA, r.x0 + 1.1, 1.3, FLOOR + 1.6, 43);
      credenza(S, 'x', xA, r.z0 + 2.6, 2.2, 47);
      frame(S, 'x', xA, r.z0 + 1.85, FLOOR + 1.85, 0.85, 1.05, ATLAS.art[1]);
      frame(S, 'x', xA, r.z0 + 3.0, FLOOR + 1.95, 0.7, 0.7, ATLAS.art[2]);
      frame(S, 'x', xA, r.z0 + 3.0, FLOOR + 1.3, 0.7, 0.42, ATLAS.art[3]);
      if (r.z1 - r.z0 > 4.6) frame(S, 'x', xA, r.z0 + 4.1, FLOOR + 1.7, 0.6, 0.85, ATLAS.art[4]);
    } else {
      // office: lockers on the left wall, a whiteboard and lit shelves on the back wall, a picture
      cabinet(S, 'x', xA, r.z0 + 1.05, 0.9, 1.9, p.locker);
      cabinet(S, 'x', xA, r.z0 + 1.98, 0.9, 1.9, p.locker);
      const wbw = Math.min(3.0, deskU1 - deskU0 - 1.6), wbu = (deskU0 + deskU1) / 2 - 0.6;
      S.add(box(wbw + 0.08, 1.38, 0.04), onWall('z', zA, wbu, FLOOR + 1.62, 0.02), p.whiteboardFrame);
      decals.add(regionUV(new THREE.PlaneGeometry(wbw, 1.3), atlasUV(ATLAS.white)), onWall('z', zA, wbu, FLOOR + 1.62, 0.042));
      S.add(box(wbw * 0.6, 0.04, 0.08), onWall('z', zA, wbu, FLOOR + 0.92, 0.06), p.whiteboardFrame);
      wallShelf(S, 'z', zA, wbu + wbw / 2 + 1.0, 1.3, FLOOR + 1.45, 53);
      wallShelf(S, 'z', zA, wbu + wbw / 2 + 1.0, 1.3, FLOOR + 2.05, 59);
      if (r.z1 - r.z0 > 6) { frame(S, 'x', xA, r.z0 + 4.4, FLOOR + 1.7, 0.9, 1.15, ATLAS.art[5]); wallShelf(S, 'x', xA, r.z0 + 6.6, 1.4, FLOOR + 1.6, 61); }
    }
    out.statics.push({ key: r.key, geo: S.merge() });
  }

  // ---- lounge: wood floor, rug, two sofas, two armchairs, coffee table, arc lamp
  if (!skipLounge) {
    const S = bucket({ color: true }), lg = L.lounge, f = lg.furniture;
    wood.add(planarUV(box(lg.w, 0.02, lg.d).translate(lg.cx, FLOOR + 0.01, lg.cz), FLOOR_OAK.tile));
    // B0: on a business floor the lounge corner is open floor (the lounge is on floor 0)
    if (f) {
    rug(S, f.rug.x0, f.rug.x1, f.rug.z0, f.rug.z1, p.loungeRug, p.loungeRugBorder);
    sofa(S, f.sofaA, f.sofaA.len, p.sofa); sofa(S, f.sofaB, f.sofaB.len, p.sofa);
    armchair(S, f.chair1, p.leather); armchair(S, f.chair2, p.leather);
    const t = f.table;
    S.add(rbox(t.w, 0.05, t.d, 0.02), mat4(t.x, FLOOR + 0.42, t.z), p.woodSolid);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) S.add(box(0.04, 0.4, 0.04), mat4(t.x + sx * (t.w / 2 - 0.08), FLOOR + 0.2, t.z + sz * (t.d / 2 - 0.08)), p.metal);
    S.add(box(0.34, 0.05, 0.26), mat4(t.x - 0.3, FLOOR + 0.47, t.z + 0.1, 0.3), BOOKS[4]); S.add(box(0.3, 0.04, 0.22), mat4(t.x - 0.3, FLOOR + 0.515, t.z + 0.1, 0.2), BOOKS[7]);
    S.add(cyl(0.1, 0.08, 0.16, 10), mat4(t.x + 0.35, FLOOR + 0.525, t.z - 0.15), p.potSmall); S.add(new THREE.IcosahedronGeometry(0.15, 0), mat4(t.x + 0.35, FLOOR + 0.7, t.z - 0.15), p.leafSmall);
    floorLamp(S, f.lamp.x, f.lamp.z, f.table.x, f.table.z);
    }
    out.statics.push({ key: 'lounge', geo: S.merge() });
  }

  // ---- server closet: dark floor, a low partition on its left, a cable tray over the cabinets, LEDs (cabinets are
  // instanced: status). R2: the cabinets stand in a row along z and face +x, towards the core.
  {
    const S = bucket({ color: true }), c = L.closet, cx = c.x0 + WALL_T + 0.45;
    if (!skipAtrium) {
      S.add(box(c.w - 0.1, 0.012, c.d - WALL_T - 0.05), mat4(c.cx + 0.05, FLOOR + 0.006, c.cz + WALL_T / 2), p.closetFloor);
      wallRun(S, L.walls.find((w) => w.owner === 'closet'), p.closetWall);
      S.add(box(0.3, 0.06, c.d - WALL_T - 0.3), mat4(cx - 0.05, FLOOR + 2.35, c.cz + WALL_T / 2), p.metal);   // cable tray
      for (let k = 0; k < 4; k++) S.add(box(0.025, 0.4, 0.025), mat4(cx - 0.05, FLOOR + 2.55, c.z0 + WALL_T + 0.3 + k * (c.d - WALL_T - 0.6) / 3), p.metal);
    }
    em.add(box(0.012, 0.012, c.d - WALL_T - 0.4), mat4(cx + 0.12, FLOOR + 2.31, c.cz + WALL_T / 2), p.closetLED);
    for (const cab of c.cabinets) pool(cab.x + 0.75, FLOOR + 0.02, cab.z, 0.55, 0.45, p.closetLED);
    // a block of tiny LEDs on each cabinet front (they do not blink: the scene renders on demand)
    for (const cab of c.cabinets) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) em.add(box(0.01, 0.02, 0.035), mat4(cab.x + 0.405, FLOOR + 0.55 + i * 0.12, cab.z + 0.2 - j * 0.07), r0() < 0.7 ? p.rackLedA : p.rackLedB);
    out.statics.push({ key: 'closet', geo: S.merge() });
  }

  out.wood = wood.merge(); out.tile = tile.merge(); out.decals = decals.merge(); out.emissive = em.merge(); out.glow = glow.merge();
  return out;
}
