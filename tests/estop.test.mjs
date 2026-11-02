// estop.test.mjs — the e-stop (ENGINE-PLAN.md §5.5) and engine restart safety (§1.1): the button/API path, the HALT
// file, the CLI, persistence across a restart, the typed resume; plus the engine lock, restart-mid-run recovery, the
// event sequence across restarts and the scheduler's fire rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine/engine.mjs';
import { createHalt, RESUME_WORD } from '../src/engine/halt.mjs';
import { createBus } from '../src/engine/bus.mjs';
import { fireDecision, missedFires, validSchedule } from '../src/engine/scheduler.mjs';
import { tempRoot, until } from './helpers/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineOn = (t, o = {}) => createEngine({ archiveSandbox: true, J: t.J, log: t.log, mockDelayMs: 0, ...o });

test('button/API press: an in-flight call is aborted, the guard refuses new calls, the state survives a restart', async () => {
  const t = tempRoot('halt');
  try {
    let e = engineOn(t, { mockDelayMs: 2000 });
    const inflight = e.providers.text.create({ model: 'm', messages: [] }, { signal: e.halt.signal });
    e.halt.press({ by: 'test', reason: 'unit test' });
    await assert.rejects(inflight, /e-stop/);
    assert.throws(() => e.guard.reserve({ provider: 'mock', model: 'x', kind: 'text', runId: 'r', jobId: null }), (err) => err.code === 'HALT');
    assert.ok(fs.existsSync(path.join(t.dataRoot, 'HALT')) && JSON.parse(fs.readFileSync(path.join(t.dataRoot, 'halt.json'), 'utf8')).halted);
    e.close();
    e = engineOn(t);
    assert.equal(e.halt.isHalted(), true, 'still halted after a restart');
    assert.equal(e.scheduler.started, false, 'the scheduler does not run while halted');
    assert.throws(() => e.halt.resume({ by: 'test', confirm: 'yes' }), (err) => err.code === 'CONFIRM');
    e.halt.resume({ by: 'test', confirm: RESUME_WORD });
    assert.equal(e.halt.isHalted(), false); assert.ok(!fs.existsSync(path.join(t.dataRoot, 'HALT')));
    assert.ok(!e.halt.signal.aborted, 'a fresh signal after resume');
    e.close();
  } finally { t.cleanup(); }
});

test('HALT file: creating data/HALT by hand halts at once and aborts an in-flight call within the poll', async () => {
  const t = tempRoot('halt');
  try {
    const e = engineOn(t, { mockDelayMs: 4000 });
    const events = []; e.bus.subscribe((ev) => events.push(ev.type));
    const inflight = e.providers.text.create({ model: 'm', messages: [] }, { signal: e.halt.signal });
    fs.writeFileSync(path.join(t.dataRoot, 'HALT'), 'by hand\n');
    assert.equal(e.halt.isHalted(), true, 'checked before every call');
    await assert.rejects(inflight);
    await until(() => events.includes('halt.on'));
    e.close();
  } finally { t.cleanup(); }
});

test('CLI e-stop: npm run estop presses, --off releases; a running engine follows both', async () => {
  const t = tempRoot('halt');
  try {
    const e = engineOn(t);
    const env = { ...process.env, STATION_DATA_ROOT: t.dataRoot };
    const on = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'estop.mjs'), '--reason', 'cli test'], { env, encoding: 'utf8' });
    assert.equal(on.status, 0, on.stderr); assert.match(on.stdout, /E-STOP ON/);
    await until(() => e.halt.state.halted);
    assert.equal(e.halt.signal.aborted, true);
    const off = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'estop.mjs'), '--off'], { env, encoding: 'utf8' });
    assert.equal(off.status, 0, off.stderr);
    await until(() => !e.halt.state.halted);
    assert.equal(e.halt.isHalted(), false);
    e.close();
  } finally { t.cleanup(); }
});

test('engine lock: a second engine on the same data root refuses to start', () => {
  const t = tempRoot('lock');
  try {
    const e = engineOn(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import { createEngine } from './src/engine/engine.mjs'; import { createJail } from './src/engine/store/jail.mjs'; try { createEngine({ archiveSandbox: true, J: createJail({ dataRoot: process.argv[1], extraRoots: [] }), log: { info() {}, warn() {}, error() {} } }); console.log('started'); } catch (e) { console.log(e.code); }", t.dataRoot], { cwd: ROOT, encoding: 'utf8' });
    assert.match(child.stdout, /LOCKED/);
    e.close();
    assert.ok(!fs.existsSync(path.join(t.dataRoot, '.lock')), 'lock released on close');
  } finally { t.cleanup(); }
});

test('restart mid-run: runs become interrupted; the job resumes once at the start of its step, then is blocked', () => {
  const t = tempRoot('recover');
  try {
    let e = engineOn(t);
    e.store.insertJob({ id: '2026-10-16--mid', line: 'room1-digital', state: 'running', step: 'designer' });
    e.store.openStage('2026-10-16--mid', 'designer', 1, 'run-x');
    e.store.insertRun({ runId: 'run-x', jobId: '2026-10-16--mid', agentKey: 'designer', step: 'designer', pass: 1 });
    e.close();
    e = engineOn(t, { resume: false });   // resume: false shows the recovered state before the job is started again
    assert.equal(e.store.getRun('run-x').status, 'interrupted');
    let j = e.store.getJob('2026-10-16--mid'); assert.equal(j.state, 'queued'); assert.equal(j.resumes, 1); assert.match(j.reason, /resumes at the start of designer/);
    assert.equal(e.store.stagesOf(j.id)[0].status, 'interrupted');
    e.store.updateJob(j.id, { state: 'running' }); e.close();
    e = engineOn(t, { resume: false });
    j = e.store.getJob('2026-10-16--mid'); assert.equal(j.state, 'blocked'); assert.match(j.reason, /restart it by hand/);
    e.close();
  } finally { t.cleanup(); }
});

test('events: sequence numbers carry on across restarts; replay returns what a reconnecting page missed', () => {
  const t = tempRoot('bus');
  try {
    let b = createBus({ J: t.J, log: t.log });
    b.emit('job.created', { jobId: 'a' }); b.emit('job.stage', { jobId: 'a' });
    const s = b.seq;
    b = createBus({ J: t.J, log: t.log });
    const ev = b.emit('job.stage', { jobId: 'a' });
    assert.equal(ev.seq, s + 1);
    assert.deepEqual(b.since(s).map((e) => e.seq), [s + 1]);
    assert.throws(() => b.emit('message.send'), /unknown event type/);
  } finally { t.cleanup(); }
});

test('scheduler: fire rules (disabled, e-stop, day cap, runs per day, overlap), DST-safe schedules, missed fires not replayed', () => {
  const base = { enabled: true, max_runs_per_day: 1 };
  const ok = { routine: base, halted: false, spentToday: 0, perDayUsd: 10, firesToday: 0, running: false };
  assert.deepEqual(fireDecision(ok), { ok: true });
  assert.match(fireDecision({ ...ok, routine: { ...base, enabled: false } }).reason, /disabled/);
  assert.match(fireDecision({ ...ok, halted: true }).reason, /e-stop/);
  assert.match(fireDecision({ ...ok, spentToday: 10 }).reason, /day cap/);
  assert.match(fireDecision({ ...ok, firesToday: 1 }).reason, /maxRunsPerDay/);
  assert.match(fireDecision({ ...ok, running: true }).reason, /not finished/);
  assert.ok(validSchedule('0 9 * * 1')); assert.ok(!validSchedule('every day')); assert.ok(!validSchedule('0 9 * *'));
  // 09:00 Dublin daily, last fired 3 days ago: 3 missed (they are logged and skipped, never replayed)
  const last = Date.parse('2026-10-13T08:00:00Z'), now = Date.parse('2026-10-16T08:30:00Z');
  assert.equal(missedFires('0 9 * * *', last, now), 3);
  // across the clocks going back (25/10/2026): still one fire per day
  assert.equal(missedFires('0 9 * * *', Date.parse('2026-10-24T08:00:00Z'), Date.parse('2026-10-26T09:30:00Z')), 2);
});

test('routines are created disabled; only enabled ones are armed', () => {
  const t = tempRoot('sched');
  try {
    const e = engineOn(t);
    const r = e.store.insertRoutine({ id: 'r1', name: 'research batch', target: 'line:research', schedule: '0 9 * * 1' });
    assert.equal(r.enabled, false);
    e.scheduler.refresh('r1'); assert.deepEqual(e.scheduler.armed(), []);
    e.store.setRoutineEnabled('r1', true, { expectedVersion: r.version }); e.scheduler.refresh('r1');
    assert.deepEqual(e.scheduler.armed(), ['r1']);
    e.halt.press({ by: 'test' }); assert.deepEqual(e.scheduler.armed(), [], 'e-stop disarms every routine');
    e.close();
  } finally { t.cleanup(); }
});
