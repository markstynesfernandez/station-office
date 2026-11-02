// instance.mjs — L1: which Station this process is, and the guards that keep the two apart (DECISIONS.md "L1").
//   live  the always-on Station in its own git worktree (..\office-agents-live, branch `live`): owns the real data/, port
//         8790, the live provider; starts only from a clean working tree and logs the commit it runs.
//   dev   the checkout Claude Code builds in (office-agents/): mock provider only, its own scratch data/, port 8792.
// STATION_INSTANCE picks one (unset = dev, so a forgotten setting never goes live). STATION_DATA_ROOT (default ./data,
// relative to the checkout) is the data root. Every data root is stamped with its instance (INSTANCE.json) on the first
// start; the other instance refuses a stamped root, so the two can never share one. Pure: no shell, no git here. The git
// state (commit, branch, uncommitted tracked files) comes from the launcher (scripts/start.mjs, scripts/git-state.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, realResolve } from './store/jail.mjs';

export const INSTANCES = ['live', 'dev'];
export const PORTS = { live: 8790, dev: 8792 };
export const LIVE_BRANCH = 'live';
export const STAMP_FILE = 'INSTANCE.json';
// the L1 data backups (..\office-agents-data-backup-<tag>): copies of live data, never a dev data root
const BACKUP_DIR = /(^|[\\/])office-agents-data-backup-[^\\/]*([\\/]|$)/i;

export class InstanceError extends Error { constructor(msg, code = 'INSTANCE') { super(msg); this.code = code; } }

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, root) => { const c = norm(child), r = norm(root); return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
const overlap = (a, b) => inside(a, b) || inside(b, a);

export function instanceName(env = process.env) {
  const v = env.STATION_INSTANCE;
  if (v == null || v === '') return 'dev';
  if (!INSTANCES.includes(v)) throw new InstanceError('STATION_INSTANCE must be live or dev (it is "' + v + '")', 'INSTANCE_UNKNOWN');
  return v;
}
export const defaultPort = (name) => PORTS[name] || PORTS.dev;
export const resolvePort = (env = process.env, name = instanceName(env)) => Number(env.STATION_PORT || defaultPort(name));
export const resolveDataRoot = (env = process.env, appRoot = APP_ROOT) => path.resolve(appRoot, env.STATION_DATA_ROOT || 'data');
// the live checkout: STATION_LIVE_ROOT, else the sibling folder office-agents-live (for the live checkout itself, its own root)
export const resolveLiveRoot = (env = process.env, appRoot = APP_ROOT) => path.resolve(appRoot, env.STATION_LIVE_ROOT || path.join('..', 'office-agents-live'));

export function readStamp(dataRoot) { try { return JSON.parse(fs.readFileSync(path.join(dataRoot, STAMP_FILE), 'utf8')); } catch (_) { return null; } }

// -> { name, port, dataRoot, appRoot, liveRoot, commit, branch } or throws InstanceError. `port` null skips the port rule
// (a script with no server); `git` is { commit, branch, dirty: [paths] } from scripts/git-state.mjs, required for live.
export function checkInstance({ name, env = process.env, port = null, dataRoot, appRoot = APP_ROOT, liveRoot = resolveLiveRoot(env, appRoot), git = null }) {
  if (!INSTANCES.includes(name)) throw new InstanceError('unknown instance "' + name + '"', 'INSTANCE_UNKNOWN');
  const dr = realResolve(dataRoot), ar = realResolve(appRoot), lr = realResolve(liveRoot);
  if (name === 'dev') {
    if (env.STATION_PROVIDER === 'live') throw new InstanceError('the dev instance runs on the mock provider only: STATION_PROVIDER=live is refused (the live Station runs from ' + lr + ')', 'DEV_LIVE_PROVIDER');
    if (overlap(dr, lr)) throw new InstanceError('the dev instance refuses the live checkout\'s data (' + dr + ' and ' + lr + ' overlap): dev keeps its own scratch data', 'DEV_LIVE_DATA');
    if (BACKUP_DIR.test(dr)) throw new InstanceError('the dev instance refuses a data backup as its data root (' + dr + ')', 'DEV_BACKUP_DATA');
    if (port != null && port === PORTS.live) throw new InstanceError('port ' + PORTS.live + ' is the live instance\'s: the dev instance uses ' + PORTS.dev, 'PORT');
  } else {
    if (!git) throw new InstanceError('the live instance starts only through npm start (scripts/start.mjs), which checks the working tree and records the commit', 'LIVE_NO_GIT');
    if (norm(ar) !== norm(lr)) throw new InstanceError('the live instance runs only from the live checkout (' + lr + '), not from ' + ar, 'LIVE_WRONG_CHECKOUT');
    if (git.branch !== LIVE_BRANCH) throw new InstanceError('the live instance runs only the "' + LIVE_BRANCH + '" branch (this checkout is on "' + (git.branch || 'a detached HEAD') + '")', 'LIVE_WRONG_BRANCH');
    if (git.dirty && git.dirty.length) throw new InstanceError('the live instance refuses to start with uncommitted changes to tracked files (' + git.dirty.slice(0, 5).join(', ') + (git.dirty.length > 5 ? ', …' : '') + '): deploy a commit instead', 'LIVE_DIRTY');
    if (!/^[0-9a-f]{40}$/.test(String(git.commit || ''))) throw new InstanceError('the live instance could not read its commit', 'LIVE_NO_COMMIT');
    if (port != null && port !== PORTS.live) throw new InstanceError('the live instance listens on ' + PORTS.live + ' only (STATION_PORT is ' + port + ')', 'PORT');
    if (!inside(dr, ar)) throw new InstanceError('the live instance keeps its data inside its own checkout (' + ar + '), not at ' + dr, 'LIVE_DATA_OUTSIDE');
  }
  const stamp = readStamp(dr);
  if (stamp && stamp.instance !== name) throw new InstanceError('this data root belongs to the ' + stamp.instance + ' instance (' + path.join(dr, STAMP_FILE) + '): the ' + name + ' instance refuses it', 'SHARED_DATA');
  return { name, port, dataRoot: dr, appRoot: ar, liveRoot: lr, commit: git ? git.commit || null : null, branch: git ? git.branch || null : null };
}

// written once, on the first start (the engine lock is held); later starts only read it (checkInstance)
export function stampDataRoot(J, inst, now = Date.now()) {
  const f = path.join(J.dataRoot, STAMP_FILE);
  if (fs.existsSync(f)) return false;
  J.put(f, JSON.stringify({ instance: inst.name, firstStartedAt: new Date(now).toISOString(), appRoot: inst.appRoot, commit: inst.commit }, null, 1) + '\n', { fsync: true });
  return true;
}

// the live providers (providers/anthropic.mjs, providers/openrouter.mjs) build only on the live instance
export function liveInstanceProblem(env = process.env) {
  return env.STATION_INSTANCE === 'live' ? null : 'the live provider runs only on the live instance (STATION_INSTANCE=live); this process is the ' + (env.STATION_INSTANCE || 'dev (unset)') + ' instance';
}
