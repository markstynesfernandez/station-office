// l1-deploy.test.mjs — L1: scripts/deploy-live.mjs on a temp repository with a real `live` worktree (git, no shell). The
// server, its health route, npm ci and the test record are stand-ins. Refuses while busy (and --force only with the
// e-stop on), refuses an untested commit or a dirty live tree; checks health and the commit after the start; npm ci only
// when package-lock.json changed; --rollback returns to where the last deploy came from; every attempt is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployLive, testedOn, rollbackTarget } from '../scripts/deploy-live.mjs';
import { git } from '../scripts/git-state.mjs';
import { tempDir } from './helpers/engine.mjs';

const C = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const head = (d) => git(d, ['rev-parse', 'HEAD']).trim();
function repo() {
  const base = tempDir('station-l1-deploy-');
  const dev = path.join(base, 'dev'), live = path.join(base, 'live');
  fs.mkdirSync(dev);
  git(dev, ['init', '-q', '-b', 'main']);
  const commit = (files, msg) => { for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dev, f), v); git(dev, ['add', '.']); git(dev, [...C, 'commit', '-q', '-m', msg]); return head(dev); };
  const A = commit({ 'package-lock.json': '{"v":1}\n', 'app.txt': 'A\n' }, 'A');
  const B = commit({ 'app.txt': 'B\n' }, 'B');
  const Cm = commit({ 'package-lock.json': '{"v":2}\n' }, 'C');
  git(dev, ['worktree', 'add', '-q', '-b', 'live', live, A]);
  return { base, dev, live, A, B, C: Cm, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) {} } };
}
const pass = (commit, o = {}) => ({ commit, clean: true, exitCode: 0, pass: 10, fail: 0, cancelled: 0, ...o });
// srv: the stand-in live server. up: answering; busy/halted: what it reports; reportCommit: the commit it reports (default: the worktree's)
function fakeOps(r, { passes = [], srv = {}, lock = null, haltFile = false } = {}) {
  const s = { up: false, jobsRunning: 0, inFlight: 0, halted: false, reportCommit: null, ...srv };
  const calls = { stop: 0, start: 0, npmCi: 0 }, deploys = [];
  const ops = {
    paths: { devRoot: r.dev, liveRoot: r.live }, git: (cwd, args) => git(cwd, args), say: () => {}, now: () => Date.UTC(2026, 9, 18, 12),
    health: async () => (s.up ? { ok: true, instance: 'live', commit: s.reportCommit || head(r.live), jobsRunning: s.jobsRunning, inFlight: s.inFlight, halted: s.halted } : null),
    lockHolder: () => lock, haltState: () => ({ halted: haltFile }),
    readTestPasses: () => passes, readDeploys: () => deploys, appendDeploy: (row) => deploys.push(row),
    stop: async () => { calls.stop++; s.up = false; }, start: async () => { calls.start++; s.up = true; s.jobsRunning = 0; s.inFlight = 0; }, npmCi: async () => { calls.npmCi++; }
  };
  return { ops, calls, deploys, s };
}
const FAST = { healthTimeoutMs: 200, healthEveryMs: 10 };
const refusal = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };

test('refuses while the live engine is busy; --force only with the live e-stop on', async () => {
  const r = repo();
  try {
    const busy = fakeOps(r, { passes: [pass(r.B)], srv: { up: true, jobsRunning: 1 } });
    await refusal(deployLive({ to: r.B, ...FAST }, busy.ops), 'BUSY');
    await refusal(deployLive({ to: r.B, force: true, ...FAST }, busy.ops), 'NEED_ESTOP');
    assert.equal(head(r.live), r.A, 'nothing moved'); assert.equal(busy.calls.stop, 0); assert.deepEqual(busy.deploys, [], 'a refusal writes no row');
    const inflight = fakeOps(r, { passes: [pass(r.B)], srv: { up: true, inFlight: 2 } });
    await refusal(deployLive({ to: r.B, ...FAST }, inflight.ops), 'BUSY');
    // a live engine lock held by a running process that does not answer counts as busy; with the e-stop file on, --force goes ahead
    const silent = fakeOps(r, { passes: [pass(r.B)], lock: { pid: 123, alive: true } });
    await refusal(deployLive({ to: r.B, ...FAST }, silent.ops), 'BUSY');
    await refusal(deployLive({ to: r.B, force: true, ...FAST }, silent.ops), 'NEED_ESTOP');
    // e-stop on: --force stops the server, deploys and logs it as forced
    const halted = fakeOps(r, { passes: [pass(r.B)], srv: { up: true, jobsRunning: 1, halted: true } });
    const out = await deployLive({ to: r.B, force: true, by: 'owner', ...FAST }, halted.ops);
    assert.equal(out.ok, true); assert.equal(head(r.live), r.B); assert.equal(halted.calls.stop, 1); assert.equal(halted.calls.start, 1);
    assert.equal(halted.deploys.length, 1); assert.equal(halted.deploys[0].forced, true); assert.equal(halted.deploys[0].by, 'owner');
    // not busy: no --force needed
    const idle = fakeOps(r, { passes: [pass(r.A)], srv: { up: true } });
    const back = await deployLive({ to: r.A, ...FAST }, idle.ops);
    assert.equal(back.row.forced, false); assert.equal(idle.calls.stop, 1); assert.equal(head(r.live), r.A);
  } finally { r.cleanup(); }
});

test('refuses a commit whose full suite has not passed on dev, and a dirty live worktree', async () => {
  const r = repo();
  try {
    for (const passes of [[], [pass(r.A)], [pass(r.B, { fail: 1 })], [pass(r.B, { clean: false })], [pass(r.B, { exitCode: 1 })], [pass(r.B, { pass: 0 })], [pass(r.B, { cancelled: 1 })]]) {
      const f = fakeOps(r, { passes });
      await refusal(deployLive({ to: r.B, ...FAST }, f.ops), 'UNTESTED');
      assert.equal(head(r.live), r.A); assert.deepEqual(f.deploys, []); assert.equal(f.calls.start, 0);
    }
    assert.ok(testedOn([pass(r.A), pass(r.B)], r.B));
    fs.writeFileSync(path.join(r.live, 'app.txt'), 'edited on live\n');
    await refusal(deployLive({ to: r.B, ...FAST }, fakeOps(r, { passes: [pass(r.B)] }).ops), 'LIVE_DIRTY');
    assert.equal(head(r.live), r.A);
  } finally { r.cleanup(); }
});

test('health check: the started server must report instance live and the target commit', async () => {
  const r = repo();
  try {
    const good = fakeOps(r, { passes: [pass(r.B)] });
    const out = await deployLive({ to: r.B, by: 'owner', ...FAST }, good.ops);
    assert.equal(out.row.ok, true); assert.match(out.row.health, /^ok: instance live, commit /);
    assert.deepEqual({ ...good.deploys[0] }, { at: '2026-10-18T12:00:00.000Z', action: 'deploy', from: r.A, to: r.B, by: 'owner', forced: false, npmCi: false, stopped: false, started: true, health: out.row.health, ok: true });
    // the server comes up on the wrong commit: the deploy fails, is logged as failed, and says how to roll back
    const bad = fakeOps(r, { passes: [pass(r.C)], srv: { reportCommit: r.A } });
    await assert.rejects(deployLive({ to: r.C, ...FAST }, bad.ops), (e) => e.code === 'HEALTH' && /--rollback/.test(e.message));
    assert.equal(bad.deploys.length, 1); assert.equal(bad.deploys[0].ok, false); assert.equal(bad.deploys[0].code, 'HEALTH'); assert.equal(bad.deploys[0].started, true);
    // the server never answers
    const dead = fakeOps(r, { passes: [pass(r.A)] }); dead.ops.start = async () => {};
    await assert.rejects(deployLive({ to: r.A, ...FAST }, dead.ops), (e) => e.code === 'HEALTH' && /no answer/.test(e.message));
  } finally { r.cleanup(); }
});

test('npm ci only when package-lock.json changed; --no-start moves the worktree and starts nothing; --plan changes nothing', async () => {
  const r = repo();
  try {
    const p = fakeOps(r, { passes: [pass(r.C)] });
    const plan = await deployLive({ to: r.C, plan: true, ...FAST }, p.ops);
    assert.equal(plan.plan, true); assert.equal(plan.row.npmCi, true); assert.equal(head(r.live), r.A); assert.deepEqual(p.deploys, []);
    const ab = fakeOps(r, { passes: [pass(r.B)] });
    await deployLive({ to: r.B, noStart: true, ...FAST }, ab.ops);
    assert.equal(ab.calls.npmCi, 0); assert.equal(ab.calls.start, 0); assert.equal(head(r.live), r.B); assert.equal(ab.deploys[0].health, 'not started (--no-start)');
    const bc = fakeOps(r, { passes: [pass(r.C)] });
    await deployLive({ to: r.C, noStart: true, ...FAST }, bc.ops);
    assert.equal(bc.calls.npmCi, 1); assert.equal(head(r.live), r.C); assert.equal(git(r.live, ['symbolic-ref', '--short', 'HEAD']).trim(), 'live', 'still on branch live');
    const again = await deployLive({ to: r.C, ...FAST }, fakeOps(r, { passes: [pass(r.C)] }).ops);
    assert.equal(again.noop, true);
  } finally { r.cleanup(); }
});

test('--rollback returns to the commit the last deploy came from, logs it, and needs a deploy to roll back', async () => {
  const r = repo();
  try {
    const f = fakeOps(r, { passes: [pass(r.B), pass(r.C)] });
    await refusal(deployLive({ rollback: true, ...FAST }, f.ops), 'NO_ROLLBACK');
    await deployLive({ to: r.B, ...FAST }, f.ops);
    await deployLive({ to: r.C, ...FAST }, f.ops);
    assert.equal(head(r.live), r.C);
    f.ops.readTestPasses = () => [];   // a rollback does not need a test record: its target already ran live
    const rb = await deployLive({ rollback: true, by: 'owner', ...FAST }, f.ops);
    assert.equal(head(r.live), r.B); assert.equal(rb.row.action, 'rollback'); assert.equal(rb.row.from, r.C); assert.equal(rb.row.to, r.B); assert.equal(rb.row.npmCi, true, 'the lock file differs between C and B');
    const rb2 = await deployLive({ rollback: true, ...FAST }, f.ops);
    assert.equal(head(r.live), r.A, 'a second rollback steps back past the deploy A -> B'); assert.equal(rb2.row.to, r.A);
    await refusal(deployLive({ rollback: true, ...FAST }, f.ops), 'NO_ROLLBACK');
    assert.deepEqual(f.deploys.map((d) => d.action + ':' + d.to.slice(0, 7)), ['deploy:' + r.B.slice(0, 7), 'deploy:' + r.C.slice(0, 7), 'rollback:' + r.B.slice(0, 7), 'rollback:' + r.A.slice(0, 7)]);
    assert.equal(rollbackTarget(f.deploys, r.C), r.B);
  } finally { r.cleanup(); }
});
