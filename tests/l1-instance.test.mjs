// l1-instance.test.mjs — L1: the live and dev instances (src/engine/instance.mjs). Dev never goes live and never touches the
// live checkout's data; live starts only from the clean live worktree on branch live and logs its commit; the two never
// share a data root (INSTANCE.json stamp) or a port; the live providers build only on the live instance; the e-stop works
// on a live data root as on dev. Spawned servers run on temp data roots and the mock provider; no key is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInstance, instanceName, resolvePort, resolveDataRoot, stampDataRoot, readStamp, liveInstanceProblem, PORTS, STAMP_FILE, InstanceError } from '../src/engine/instance.mjs';
import { createJail } from '../src/engine/store/jail.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createProviders } from '../src/engine/providers/index.mjs';
import { createOpenRouterImage } from '../src/engine/providers/openrouter.mjs';
import { git, gitState } from '../scripts/git-state.mjs';
import { testCounts } from '../scripts/record-tests.mjs';
import { tempRoot, until, sleep, tempDir } from './helpers/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = (o = {}) => ({ commit: 'a'.repeat(40), branch: 'live', dirty: [], ...o });
const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof InstanceError, String(e && e.stack)); return e.code; } };
function layout() {
  const base = tempDir('station-l1-');
  const dev = path.join(base, 'office-agents'), live = path.join(base, 'office-agents-live');
  for (const d of [dev, live, path.join(dev, 'data'), path.join(live, 'data')]) fs.mkdirSync(d, { recursive: true });
  return { base, dev, live, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) {} } };
}
// a child's environment: no Station or key variable from this shell; the test sets what it needs
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STATION_|ANTHROPIC_|OPENROUTER_|OPENAI_)/i.test(k))), ...extra });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('instance name: unset is dev; only live and dev are accepted', () => {
  assert.equal(instanceName({}), 'dev');
  assert.equal(instanceName({ STATION_INSTANCE: '' }), 'dev');
  assert.equal(instanceName({ STATION_INSTANCE: 'live' }), 'live');
  assert.equal(codeOf(() => instanceName({ STATION_INSTANCE: 'LIVE' })), 'INSTANCE_UNKNOWN');
  assert.equal(codeOf(() => instanceName({ STATION_INSTANCE: 'prod' })), 'INSTANCE_UNKNOWN');
});

test('ports and data roots: live 8790, dev 8792 by default; ./data is the checkout\'s own', () => {
  assert.deepEqual(PORTS, { live: 8790, dev: 8792 });
  assert.equal(resolvePort({}, 'live'), 8790); assert.equal(resolvePort({}, 'dev'), 8792); assert.equal(resolvePort({ STATION_PORT: '9000' }, 'dev'), 9000);
  assert.equal(resolveDataRoot({}, ROOT), path.join(ROOT, 'data'));
  assert.equal(resolveDataRoot({ STATION_DATA_ROOT: 'data' }, '/x/live'), path.resolve('/x/live', 'data'));
  // the jail resolves a relative data root against the checkout, not the working directory
  const t = tempRoot('l1-jail');
  try { const J = createJail({ dataRoot: path.relative(ROOT, t.dataRoot), extraRoots: [] }); assert.equal(J.dataRoot.toLowerCase(), t.dataRoot.toLowerCase()); } finally { t.cleanup(); }
});

test('dev refuses STATION_PROVIDER=live, the live checkout\'s data, a data backup and port 8790', () => {
  const L = layout();
  try {
    const dev = (o) => () => checkInstance({ name: 'dev', env: {}, port: 8792, dataRoot: path.join(L.dev, 'data'), appRoot: L.dev, liveRoot: L.live, ...o });
    assert.equal(codeOf(dev({})), 'ok');
    assert.equal(codeOf(dev({ env: { STATION_PROVIDER: 'live' } })), 'DEV_LIVE_PROVIDER');
    assert.equal(codeOf(dev({ env: { STATION_PROVIDER: 'mock' } })), 'ok');
    assert.equal(codeOf(dev({ dataRoot: path.join(L.live, 'data') })), 'DEV_LIVE_DATA');
    assert.equal(codeOf(dev({ dataRoot: path.join(L.live, 'data', 'jobs') })), 'DEV_LIVE_DATA');
    assert.equal(codeOf(dev({ dataRoot: L.live })), 'DEV_LIVE_DATA');
    assert.equal(codeOf(dev({ dataRoot: L.base })), 'DEV_LIVE_DATA', 'a root that contains the live checkout');
    assert.equal(codeOf(dev({ dataRoot: path.join(L.base, 'office-agents-data-backup-L1') })), 'DEV_BACKUP_DATA');
    assert.equal(codeOf(dev({ port: 8790 })), 'PORT');
    assert.equal(codeOf(dev({ port: null })), 'ok', 'a script with no server');
  } finally { L.cleanup(); }
});

test('live refuses no git state, the wrong checkout or branch, a dirty tree, another port and data outside its checkout', () => {
  const L = layout();
  try {
    const live = (o) => () => checkInstance({ name: 'live', env: { STATION_PROVIDER: 'live' }, port: 8790, dataRoot: path.join(L.live, 'data'), appRoot: L.live, liveRoot: L.live, git: GIT(), ...o });
    assert.equal(codeOf(live({})), 'ok');
    assert.equal(live({})().commit, 'a'.repeat(40), 'the commit it runs');
    assert.equal(codeOf(live({ git: null })), 'LIVE_NO_GIT');
    assert.equal(codeOf(live({ appRoot: L.dev, dataRoot: path.join(L.dev, 'data') })), 'LIVE_WRONG_CHECKOUT', 'the dev checkout set to live');
    assert.equal(codeOf(live({ git: GIT({ branch: 'main' }) })), 'LIVE_WRONG_BRANCH');
    assert.equal(codeOf(live({ git: GIT({ branch: null }) })), 'LIVE_WRONG_BRANCH', 'a detached HEAD');
    assert.equal(codeOf(live({ git: GIT({ dirty: ['src/engine/guard.mjs'] }) })), 'LIVE_DIRTY');
    assert.equal(codeOf(live({ git: GIT({ commit: '' }) })), 'LIVE_NO_COMMIT');
    assert.equal(codeOf(live({ port: 8792 })), 'PORT');
    assert.equal(codeOf(live({ dataRoot: path.join(L.dev, 'data') })), 'LIVE_DATA_OUTSIDE');
  } finally { L.cleanup(); }
});

test('a data root is stamped with its instance on the first start; the other instance refuses it', () => {
  const L = layout();
  try {
    const shared = path.join(L.base, 'shared');
    const J = createJail({ dataRoot: shared, extraRoots: [] });
    assert.equal(stampDataRoot(J, { name: 'live', appRoot: L.live, commit: 'a'.repeat(40) }), true);
    assert.equal(stampDataRoot(J, { name: 'dev', appRoot: L.dev, commit: null }), false, 'written once, never replaced');
    assert.equal(readStamp(shared).instance, 'live');
    assert.equal(codeOf(() => checkInstance({ name: 'dev', env: {}, port: 8792, dataRoot: shared, appRoot: L.dev, liveRoot: L.live })), 'SHARED_DATA');
    // a dev-stamped root inside the live checkout: refused by live
    const JL = createJail({ dataRoot: path.join(L.live, 'data'), extraRoots: [] });
    stampDataRoot(JL, { name: 'dev', appRoot: L.dev, commit: null });
    assert.equal(codeOf(() => checkInstance({ name: 'live', env: {}, port: 8790, dataRoot: path.join(L.live, 'data'), appRoot: L.live, liveRoot: L.live, git: GIT() })), 'SHARED_DATA');
  } finally { L.cleanup(); }
});

test('the live providers build only on the live instance (no key is ever in the message)', () => {
  const KEY = 'sk-ant-test-0123456789abcdef', OR = 'sk-or-v1-l1TESTKEY0123456789abcdef';
  assert.match(liveInstanceProblem({}), /live instance/); assert.equal(liveInstanceProblem({ STATION_INSTANCE: 'live' }), null);
  for (const inst of [undefined, 'dev', 'LIVE']) {
    const env = { STATION_PROVIDER: 'live', ANTHROPIC_API_KEY: KEY, OPENROUTER_API_KEY: OR, ...(inst ? { STATION_INSTANCE: inst } : {}) };
    assert.throws(() => createProviders({ mode: 'live', env, client: {} }), (e) => e.code === 'NOT_LIVE_INSTANCE' && !e.message.includes(KEY), String(inst));
    assert.throws(() => createOpenRouterImage({ env }), (e) => e.code === 'NOT_LIVE_INSTANCE' && e.hardStop && !e.message.includes(OR), String(inst));
  }
});

test('git state: the commit, the branch and uncommitted tracked files (untracked files do not count)', () => {
  const base = tempDir('station-l1-git-');
  try {
    git(base, ['init', '-q', '-b', 'live']);
    fs.writeFileSync(path.join(base, 'a.txt'), 'one\n');
    git(base, ['add', 'a.txt']); git(base, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one']);
    const s = gitState(base);
    assert.match(s.commit, /^[0-9a-f]{40}$/); assert.equal(s.branch, 'live'); assert.deepEqual(s.dirty, []);
    fs.writeFileSync(path.join(base, 'untracked.txt'), 'x\n');
    assert.deepEqual(gitState(base).dirty, [], 'untracked');
    fs.writeFileSync(path.join(base, 'a.txt'), 'two\n');
    assert.deepEqual(gitState(base).dirty, ['a.txt']);
    git(base, ['checkout', '-q', '--detach']);
    assert.equal(gitState(base).branch, null);
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('test:record reads the summary of the spec and tap reporters', () => {
  assert.deepEqual(testCounts('ℹ tests 409\nℹ suites 0\nℹ pass 409\nℹ fail 0\nℹ cancelled 0\n'), { tests: 409, suites: 0, pass: 409, fail: 0, cancelled: 0 });
  assert.deepEqual(testCounts('# tests 3\n# pass 2\n# fail 1\n'), { tests: 3, pass: 2, fail: 1 });
});

test('npm start refuses: the dev checkout as live, live without the launcher, and dev with STATION_PROVIDER=live', () => {
  const t = tempRoot('l1-refuse');
  try {
    const run = (file, extra) => spawnSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, env: cleanEnv({ STATION_DATA_ROOT: t.dataRoot, STATION_PORT: '8790', STATION_PROVIDER: 'mock', ...extra }), encoding: 'utf8', timeout: 30000 });
    const a = run('scripts/start.mjs', { STATION_INSTANCE: 'live' });
    assert.equal(a.status, 2, a.stderr); assert.match(a.stderr, /runs only from the live checkout/);
    const b = run('src/server/index.mjs', { STATION_INSTANCE: 'live' });
    assert.equal(b.status, 2, b.stderr); assert.match(b.stderr, /starts only through npm start/);
    const c = run('scripts/start.mjs', { STATION_INSTANCE: 'dev', STATION_PORT: '8792', STATION_PROVIDER: 'live' });
    assert.equal(c.status, 2, c.stderr); assert.match(c.stderr, /mock provider only/);
    const d = run('scripts/start.mjs', { STATION_INSTANCE: 'dev' });
    assert.equal(d.status, 2, d.stderr); assert.match(d.stderr, /port 8790 is the live instance's/);
    assert.ok(!fs.existsSync(path.join(t.dataRoot, 'station.db')), 'nothing was opened');
  } finally { t.cleanup(); }
});

test('dev server: a fresh scratch root stamped dev, instance and commit on the health route, a clean stop on SHUTDOWN', async () => {
  const t = tempRoot('l1-dev');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.mjs')], { cwd: ROOT, env: cleanEnv({ STATION_INSTANCE: 'dev', STATION_PORT: String(port), STATION_DATA_ROOT: t.dataRoot, STATION_PROVIDER: 'mock' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', (c) => res(c)));
  try {
    const base = 'http://127.0.0.1:' + port;
    const h = await until(async () => { try { const r = await fetch(base + '/api/office/health'); return r.ok ? r.json() : null; } catch (_) { return null; } }, { timeout: 20000, every: 100 });
    assert.equal(h.instance, 'dev'); assert.equal(h.commit, gitState(ROOT).commit); assert.equal(h.provider, 'mock'); assert.equal(h.jobsRunning, 0);
    const snap = await (await fetch(base + '/api/office/snapshot')).json();
    assert.deepEqual(snap.instance, { name: 'dev', commit: h.commit });
    assert.equal(readStamp(t.dataRoot).instance, 'dev');
    assert.deepEqual(snap.jobs.filter((j) => !j.legacy), [], 'a fresh store: no jobs');
    assert.ok(snap.routines.every((r) => !r.enabled), 'seeded routines are disabled');
    fs.writeFileSync(path.join(t.dataRoot, 'SHUTDOWN'), 'test\n');
    const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
    assert.equal(code, 0, out);
    assert.ok(!fs.existsSync(path.join(t.dataRoot, 'SHUTDOWN')), 'the request is consumed');
    assert.ok(!fs.existsSync(path.join(t.dataRoot, '.lock')), 'the engine lock is released');
    assert.equal(readStamp(t.dataRoot).instance, 'dev');
  } finally { if (child.exitCode == null) child.kill(); await exited; t.cleanup(); }
});

test('the e-stop on a live data root works exactly as on dev: the CLI presses and releases, the engine follows', async () => {
  const t = tempRoot('l1-halt');
  try {
    stampDataRoot(t.J, { name: 'live', appRoot: ROOT, commit: null });
    const e = createEngine({ archiveSandbox: true, J: t.J, log: t.log, startScheduler: false });
    try {
      const env = cleanEnv({ STATION_INSTANCE: 'live', STATION_DATA_ROOT: t.dataRoot });
      const on = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'estop.mjs'), '--reason', 'l1 test'], { env, encoding: 'utf8' });
      assert.equal(on.status, 0, on.stderr); assert.ok(fs.existsSync(path.join(t.dataRoot, 'HALT')));
      await until(() => e.halt.state.halted); assert.equal(e.halt.signal.aborted, true);
      const off = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'estop.mjs'), '--off'], { env, encoding: 'utf8' });
      assert.equal(off.status, 0, off.stderr);
      await until(() => !e.halt.state.halted); assert.equal(e.halt.isHalted(), false);
      assert.equal(readStamp(t.dataRoot).instance, 'live', 'the stamp is untouched');
      assert.ok(fs.existsSync(path.join(t.dataRoot, STAMP_FILE)));
    } finally { e.close(); }
  } finally { t.cleanup(); }
});
