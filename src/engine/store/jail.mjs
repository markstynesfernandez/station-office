// jail.mjs — the ONE place the station is allowed to write files (ENGINE-PLAN.md §8, write-guard v2).
//
// createJail() returns `dataJail(path)`, which resolves a path (through the real path of its nearest existing ancestor,
// so symlinks, junctions and 8.3 short names are expanded) and refuses anything that is not inside one of the allowed
// roots: STATION_DATA_ROOT (default ./data, relative to the checkout), office-agents/logs and office-agents/.cache. It ALWAYS refuses
// the legacy StarNet build (STATION_LEGACY_ROOT, default ../Virtual-workers) and any path with a `Virtual-workers` or
// `station-workspace` segment, even if someone points the data root inside it. Device and UNC paths are refused.
//
// The write helpers below (put, add, makeDir, move, copy, remove) all go through dataJail(); every other module writes
// through them or passes its path through dataJail( in the same expression. tests/write-guard.test.mjs enforces this.
//
// Frozen job inputs (owner, 18/10/2026; lib/job-inputs.mjs): once <data root>/jobs/<id>/inputs/SNAPSHOT.json exists, every write into
// that inputs/ folder (or to the folder itself) is refused (code FROZEN). Only move() may take a frozen folder as its SOURCE, so an
// ended job can still be archived whole (rerun-archive-*); nothing can be written into it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);
const FORBIDDEN_SEGMENT = /(^|[\\/])(virtual-workers|station-workspace)([\\/]|$)/i;
const DEVICE_PATH = /^(\\\\|\/\/)/;   // \\?\C:\..., \\.\pipe\..., \\server\share and //server/share

export class JailError extends Error { constructor(msg, code = 'JAIL') { super(msg); this.code = code; } }

// Resolve `p` to an absolute path with every existing component's real path (junctions, symlinks and short names
// expanded). Components that do not exist yet are appended as written (they cannot be links).
export function realResolve(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try { const real = fs.realpathSync.native(cur); return rest.length ? path.join(real, ...rest.reverse()) : real; }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest.reverse());
      rest.push(path.basename(cur)); cur = parent;
    }
  }
}

const inside = (child, root) => { const c = norm(child), r = norm(root); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };

export function defaultLegacyRoot() { return path.resolve(APP_ROOT, '..', 'Virtual-workers'); }

// Roots are created (data root only) and pinned to their real paths at creation time.
export function createJail({ dataRoot = process.env.STATION_DATA_ROOT || path.join(APP_ROOT, 'data'), extraRoots = [path.join(APP_ROOT, 'logs'), path.join(APP_ROOT, '.cache')], legacyRoots = [defaultLegacyRoot(), process.env.STATION_LEGACY_ROOT].filter(Boolean) } = {}) {
  const raw = path.resolve(APP_ROOT, dataRoot);   // L1: a relative STATION_DATA_ROOT (default ./data) is the checkout's
  if (DEVICE_PATH.test(String(dataRoot))) throw new JailError('data root must be a local drive path: ' + dataRoot);
  const legacy = legacyRoots.map((r) => realResolve(r));
  const check = (r) => {
    if (FORBIDDEN_SEGMENT.test(r)) throw new JailError('refusing a root inside the legacy build: ' + r);
    for (const l of legacy) if (inside(r, l) || inside(l, r)) throw new JailError('data root and the legacy root overlap: ' + r + ' / ' + l);
  };
  check(realResolve(raw));
  fs.mkdirSync(raw, { recursive: true });
  const roots = [raw, ...extraRoots.map((r) => path.resolve(r))].map((r) => realResolve(r));
  roots.forEach(check);

  // allowRoot: a root folder itself is only valid as the parent of something being created (mkdir), never as a target
  function dataJail(p, { allowRoot = false, frozenOk = false } = {}) {
    if (typeof p !== 'string' || !p) throw new JailError('no path');
    if (DEVICE_PATH.test(p) || /^[a-z]:[^\\/]/i.test(p)) throw new JailError('refusing a device, UNC or drive-relative path: ' + p);
    if (p.includes('\0')) throw new JailError('refusing a path with a NUL byte');
    const abs = path.isAbsolute(p) ? p : path.resolve(raw, p);
    const real = realResolve(abs);
    if (FORBIDDEN_SEGMENT.test(real) || FORBIDDEN_SEGMENT.test(abs)) throw new JailError('refusing to write into the legacy build: ' + p);
    for (const l of legacy) if (inside(real, l)) throw new JailError('refusing to write into the legacy build: ' + p);
    if (!roots.some((r) => inside(real, r) && (allowRoot || norm(real) !== norm(r)))) throw new JailError('refusing to write outside the data root: ' + p);
    if (!frozenOk) { const fz = frozenInputsOf(real); if (fz) throw new JailError('refusing to write into the frozen inputs of job ' + fz + ' (jobs/' + fz + '/inputs/ is the snapshot taken at job start): record an owner amendment instead', 'FROZEN'); }
    return real;
  }
  // the job id when `real` is inside (or is) a frozen jobs/<id>/inputs/ folder of the data root, else null
  const jobsRoot = path.join(roots[0], 'jobs');
  function frozenInputsOf(real) {
    if (!inside(real, jobsRoot)) return null;
    const parts = path.relative(jobsRoot, real).split(path.sep);
    if (parts.length < 2 || norm(parts[1]) !== 'inputs' || !parts[0] || parts[0] === '..') return null;
    return fs.existsSync(path.join(jobsRoot, parts[0], 'inputs', 'SNAPSHOT.json')) ? parts[0] : null;
  }

  // ---- jailed write helpers (the only fs write calls in src/engine and src/server besides log.mjs)
  const makeDir = (p) => fs.mkdirSync(dataJail(p), { recursive: true });
  // atomic replace: write a temp file next to the target, fsync it, rename over the target
  function put(p, data, { fsync = false } = {}) {
    const f = dataJail(p); fs.mkdirSync(dataJail(path.dirname(f), { allowRoot: true }), { recursive: true });
    const tmp = dataJail(f + '.tmp-' + process.pid + '-' + Date.now().toString(36));
    const fd = fs.openSync(dataJail(tmp), 'w');
    try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data); if (fsync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(dataJail(tmp), dataJail(f));
    return f;
  }
  // append one line (or buffer); fsync when it is a money or audit record
  function add(p, text, { fsync = false } = {}) {
    const f = dataJail(p); fs.mkdirSync(dataJail(path.dirname(f), { allowRoot: true }), { recursive: true });
    const fd = fs.openSync(dataJail(f), 'a');
    try { fs.writeSync(fd, text); if (fsync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return f;
  }
  // a frozen inputs/ folder may be moved away whole (archiving an ended job), never a file out of it
  const move = (a, b) => {
    const to = dataJail(b), from = dataJail(a, { frozenOk: true }), fz = frozenInputsOf(from);
    if (fz && norm(from) !== norm(path.join(jobsRoot, fz, 'inputs'))) throw new JailError('refusing to move a file out of the frozen inputs of job ' + fz + ': ' + a, 'FROZEN');
    fs.mkdirSync(dataJail(path.dirname(to), { allowRoot: true }), { recursive: true }); fs.renameSync(dataJail(a, { frozenOk: true }), to); return to;
  };
  const copy = (from, to) => { const t = dataJail(to); fs.mkdirSync(dataJail(path.dirname(t), { allowRoot: true }), { recursive: true }); fs.copyFileSync(from, dataJail(t)); return t; };
  // remove is for the engine's own temp and staging folders; job artefacts are moved to archive folders, never removed
  const remove = (p) => fs.rmSync(dataJail(p), { recursive: true, force: true });
  const putIfChanged = (p, text) => { const f = dataJail(p); try { if (fs.readFileSync(f, 'utf8') === text) return false; } catch (_) { /* new file */ } put(f, text); return true; };

  return { dataRoot: roots[0], roots, legacyRoots: legacy, dataJail, makeDir, put, add, move, copy, remove, putIfChanged };
}
