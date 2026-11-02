// deploy-live.mjs — L1: moves the live Station (..\office-agents-live, branch `live`) to a tested commit. Run from the dev
// checkout. No model is called; git runs without a shell.
//   npm run deploy:live -- [--to <commit>] [--no-start] [--force] [--by <name>] [--plan]
//   npm run deploy:live -- --rollback [--no-start] [--force] [--by <name>] [--plan]
// Refuses (nothing changes, no log row):
//   - the live engine reports a job in progress or a call in flight (or holds its lock without answering), unless --force,
//     and --force only with the live e-stop ON (cd ..\office-agents-live; npm run estop);
//   - a target commit whose full suite has not passed on dev (a passing, clean row in logs/test-passes.jsonl, written by
//     npm run test:record); --rollback is exempt (it returns to a commit that already ran live);
//   - uncommitted changes to tracked files in the live worktree.
// Then: stops the live server (<live data>/SHUTDOWN; the server stops cleanly within a few seconds), moves the live branch
// to the target (git checkout -B live <commit>), runs npm ci only if package-lock.json changed, starts the server
// (scripts/start-live.ps1 in its own window) and checks /api/office/health: instance live, the target commit. Every
// attempt past the refusals appends a row to <live data>/deploys.jsonl: from, to, time, who, result.
// --rollback returns to the commit the last successful deploy to the current live commit came from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { readHaltState } from '../src/engine/halt.mjs';
import { PORTS, LIVE_BRANCH, resolveLiveRoot } from '../src/engine/instance.mjs';
import { git as runGit } from './git-state.mjs';
import { PASSES_FILE } from './record-tests.mjs';

export const DEPLOY_LOG = 'deploys.jsonl';
export class DeployError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const short = (c) => String(c || '').slice(0, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };

// a passing, clean full-suite run of this commit on dev
export const testedOn = (passes, commit) => passes.find((r) => r.commit === commit && r.clean === true && r.exitCode === 0 && r.fail === 0 && !r.cancelled && r.pass > 0) || null;

// the commit a rollback returns to: where the last successful deploy to `current` came from
export function rollbackTarget(deploys, current) {
  const last = [...deploys].reverse().find((r) => r.ok && r.action === 'deploy' && r.to === current);
  return last ? last.from : null;
}

// ops: { paths: { devRoot, liveRoot }, git(cwd, args), health(), lockHolder(), haltState(), readTestPasses(), readDeploys(),
//        appendDeploy(row), stop(), start(), npmCi(cwd), now(), say(text) }
export async function deployLive(opts = {}, ops) {
  const { to = 'HEAD', rollback = false, force = false, noStart = false, plan = false, healthTimeoutMs = 60000, healthEveryMs = 1000 } = opts;
  const by = opts.by || os.userInfo().username;
  const { devRoot, liveRoot } = ops.paths, say = ops.say || (() => {});
  const g = (cwd, args) => ops.git(cwd, args).trim();

  const current = g(liveRoot, ['rev-parse', 'HEAD']);
  let target;
  if (rollback) { target = rollbackTarget(ops.readDeploys(), current); if (!target) throw new DeployError('NO_ROLLBACK', 'the deploy log has no successful deploy to ' + short(current) + ': nothing to roll back to'); }
  else target = g(devRoot, ['rev-parse', '--verify', to + '^{commit}']);
  if (target === current) { say('live is already at ' + short(target) + ': nothing to do'); return { ok: true, noop: true, from: current, to: target }; }

  const dirty = ops.git(liveRoot, ['status', '--porcelain', '--untracked-files=no']).split(/\r?\n/).filter(Boolean);
  if (dirty.length) throw new DeployError('LIVE_DIRTY', 'the live worktree has uncommitted changes to tracked files (' + dirty.slice(0, 5).map((l) => l.slice(3)).join(', ') + '): nothing deployed');

  // busy: what the running engine reports; a lock held by a live process that does not answer counts as busy
  const h = await ops.health(), lock = ops.lockHolder();
  if (h && h.instance && h.instance !== 'live') throw new DeployError('NOT_LIVE', 'port ' + PORTS.live + ' answers as the ' + h.instance + ' instance, not live: nothing deployed');
  const running = !!h || !!(lock && lock.alive);
  const busy = h ? (Number(h.jobsRunning) > 0 || Number(h.inFlight) > 0) : !!(lock && lock.alive);
  const halted = h ? !!h.halted : !!ops.haltState().halted;
  const busyText = h ? (h.jobsRunning || 0) + ' job(s) running, ' + (h.inFlight || 0) + ' call(s) in flight' : 'its engine lock is held (pid ' + (lock && lock.pid) + ') but the server does not answer';
  if (busy && !force) throw new DeployError('BUSY', 'the live engine is busy (' + busyText + '): wait for it to finish, or press the live e-stop (cd ..\\office-agents-live; npm run estop) and pass --force');
  if (busy && !halted) throw new DeployError('NEED_ESTOP', 'the live engine is busy (' + busyText + '): --force needs the live e-stop ON first (cd ..\\office-agents-live; npm run estop)');

  if (!rollback && !testedOn(ops.readTestPasses(), target)) throw new DeployError('UNTESTED', 'no passing full-suite run of ' + short(target) + ' is recorded on dev (logs/test-passes.jsonl): check it out clean and run npm run test:record first');

  const npmCi = g(devRoot, ['diff', '--name-only', current, target, '--', 'package-lock.json']) !== '';
  const row = { at: new Date(ops.now ? ops.now() : Date.now()).toISOString(), action: rollback ? 'rollback' : 'deploy', from: current, to: target, by, forced: !!(force && busy), npmCi, stopped: false, started: false, health: null, ok: false };
  if (plan) { say('plan: ' + row.action + ' ' + short(current) + ' -> ' + short(target) + (npmCi ? ', npm ci' : ', no npm ci') + (running ? ', stop the running server' : ', no server running') + (noStart ? ', no start' : ', start and check health')); return { ok: true, plan: true, row }; }

  try {
    if (running) { say('stopping the live server'); await ops.stop(); row.stopped = true; }
    say('moving ' + LIVE_BRANCH + ' to ' + short(target));
    ops.git(liveRoot, ['checkout', '-B', LIVE_BRANCH, target]);
    const now = g(liveRoot, ['rev-parse', 'HEAD']);
    if (now !== target) throw new DeployError('MOVE', 'the live worktree is at ' + short(now) + ' after the checkout, not ' + short(target));
    if (npmCi) { say('package-lock.json changed: npm ci'); await ops.npmCi(liveRoot); }
    if (noStart) row.health = 'not started (--no-start)';
    else {
      say('starting the live server'); await ops.start(); row.started = true;
      const t0 = Date.now(); let last = null;
      for (;;) {
        last = await ops.health();
        if (last && last.ok && last.instance === 'live' && last.commit === target) { row.health = 'ok: instance live, commit ' + short(target); break; }
        if (last && last.ok && last.instance == null && last.commit == null) { row.health = 'ok: this version reports no instance or commit (before L1)'; break; }
        if (Date.now() - t0 > healthTimeoutMs) throw new DeployError('HEALTH', 'the live server did not report healthy at ' + short(target) + ' within ' + Math.round(healthTimeoutMs / 1000) + ' s (last: ' + (last ? 'instance ' + last.instance + ', commit ' + short(last.commit) : 'no answer') + '): roll back with npm run deploy:live -- --rollback');
        await sleep(healthEveryMs);
      }
    }
    row.ok = true;
  } catch (e) { row.error = e.message; row.code = e.code || null; ops.appendDeploy(row); throw e; }
  ops.appendDeploy(row);
  say(row.action + ' done: ' + short(current) + ' -> ' + short(target) + ' (' + row.health + ')');
  return { ok: true, row };
}

// ---- the real operations
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function realOps({ liveRoot, devRoot = APP_ROOT, port = PORTS.live, say = console.log }) {
  const liveData = path.join(liveRoot, 'data');
  const J = createJail({ dataRoot: liveData, extraRoots: [] });
  const url = 'http://127.0.0.1:' + port + '/api/office/health';
  const health = async () => { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch (_) { return null; } };
  const lockHolder = () => { try { const l = JSON.parse(fs.readFileSync(path.join(liveData, '.lock'), 'utf8')); return { pid: l.pid, alive: !!l.pid && alive(l.pid) }; } catch (_) { return null; } };
  // the live server's environment: nothing from this shell's Station or key variables; start-live.ps1 sets the instance,
  // port and data root, and the keys and provider come from the live checkout's own .env
  const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STATION_|ANTHROPIC_|OPENROUTER_|OPENAI_)/i.test(k)));
  return {
    paths: { devRoot, liveRoot }, say,
    git: (cwd, args) => runGit(cwd, args),
    health, lockHolder, haltState: () => readHaltState(liveData),
    readTestPasses: () => jsonl(PASSES_FILE), readDeploys: () => jsonl(path.join(liveData, DEPLOY_LOG)),
    appendDeploy: (row) => J.add(path.join(liveData, DEPLOY_LOG), JSON.stringify(row) + '\n', { fsync: true }),
    async stop() {
      const f = path.join(liveData, 'SHUTDOWN');
      J.put(f, 'shutdown requested by deploy-live at ' + new Date().toISOString() + '\n');
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) { await sleep(500); const l = lockHolder(); if (!(await health()) && !(l && l.alive)) return; }
      if (fs.existsSync(f)) J.remove(f);   // no surprise stop later
      throw new DeployError('STOP', 'the live server did not stop within 30 s (a server from before L1 does not read the SHUTDOWN file): stop it by hand (Ctrl+C in its window) and deploy again');
    },
    async start() {
      const ps1 = path.join(liveRoot, 'scripts', 'start-live.ps1');
      const [cmd, args] = fs.existsSync(ps1) ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]] : [process.execPath, [path.join(liveRoot, 'src', 'server', 'index.mjs')]];
      const env = fs.existsSync(ps1) ? childEnv() : { ...childEnv(), STATION_INSTANCE: 'live', STATION_PORT: String(PORTS.live), STATION_DATA_ROOT: liveData };
      spawn(cmd, args, { cwd: liveRoot, env, detached: true, stdio: 'ignore' }).unref();
    },
    async npmCi(cwd) {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
      if (r.status !== 0) throw new DeployError('NPM_CI', 'npm ci failed in ' + cwd + ' (exit ' + r.status + ')');
    }
  };
}

async function main() {
  const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const liveRoot = resolveLiveRoot(process.env, APP_ROOT);
  if (!fs.existsSync(path.join(liveRoot, '.git'))) { console.error('deploy-live: no live worktree at ' + liveRoot); process.exit(2); }
  if (path.resolve(liveRoot).toLowerCase() === path.resolve(APP_ROOT).toLowerCase()) { console.error('deploy-live: run it from the dev checkout, not the live one'); process.exit(2); }
  try {
    const out = await deployLive({ to: arg('--to') || 'HEAD', rollback: argv.includes('--rollback'), force: argv.includes('--force'), noStart: argv.includes('--no-start'), plan: argv.includes('--plan'), by: arg('--by') }, realOps({ liveRoot }));
    if (out.row) console.log(JSON.stringify(out.row, null, 1));
  } catch (e) { console.error('deploy-live ' + (e.code ? e.code + ': ' : '') + e.message); process.exit(e.code === 'HEALTH' || e.code === 'STOP' || e.code === 'NPM_CI' || e.code === 'MOVE' ? 1 : 2); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(APP_ROOT, 'scripts', 'deploy-live.mjs')) main();
