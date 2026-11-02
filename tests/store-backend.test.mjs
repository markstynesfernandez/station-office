// store-backend.test.mjs — the E2 decision "node:sqlite or better-sqlite3", made by test (DECISIONS.md, E2). The job
// store needs: atomic transactions, rollback on error, durability across a hard crash in the middle of a transaction,
// WAL with a second reader, and no warning noise in the server log. If node:sqlite fails any of these, the fallback is
// better-sqlite3 13.0.3 (MIT, native build). Results are recorded in DECISIONS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openStore, VersionConflict, BACKEND } from '../src/engine/store/db.mjs';
import { tempRoot } from './helpers/engine.mjs';

test('backend is node:sqlite (built into Node, no native dependency)', () => {
  assert.equal(BACKEND, 'node:sqlite');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
});

test('transactions: commit is atomic, an error rolls the whole change back', () => {
  const t = tempRoot('db');
  try {
    const s = openStore({ J: t.J });
    s.insertJob({ id: '2026-10-16--a', line: 'l', state: 'queued' });
    assert.throws(() => s.tx(() => { s.updateJob('2026-10-16--a', { state: 'running', step: 'designer' }); s.openStage('2026-10-16--a', 'designer'); throw new Error('boom'); }), /boom/);
    assert.equal(s.getJob('2026-10-16--a').state, 'queued', 'job row rolled back');
    assert.equal(s.stagesOf('2026-10-16--a').length, 0, 'stage row rolled back');
    s.tx(() => { s.updateJob('2026-10-16--a', { state: 'running', step: 'designer' }); s.openStage('2026-10-16--a', 'designer'); });
    assert.equal(s.getJob('2026-10-16--a').state, 'running'); assert.equal(s.stagesOf('2026-10-16--a').length, 1);
    s.close();
  } finally { t.cleanup(); }
});

test('a hard crash inside a transaction leaves nothing half-written', () => {
  const t = tempRoot('db');
  try {
    const s = openStore({ J: t.J }); s.insertJob({ id: '2026-10-16--b', line: 'l', state: 'queued' }); s.close();
    const file = path.join(t.dataRoot, 'station.db');
    // a child process opens the same file, starts a transaction, writes, and dies without COMMIT
    const child = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode = WAL'); db.exec('BEGIN IMMEDIATE'); db.prepare(\"UPDATE jobs SET state='running' WHERE id='2026-10-16--b'\").run(); db.prepare(\"INSERT INTO stages (job_id, step, status, started_at) VALUES ('2026-10-16--b','designer','running',1)\").run(); process.exit(9);";
    const r = spawnSync(process.execPath, ['-e', child, file], { encoding: 'utf8' });
    assert.equal(r.status, 9, r.stderr);
    const s2 = openStore({ J: t.J });
    assert.equal(s2.getJob('2026-10-16--b').state, 'queued', 'uncommitted update is gone');
    assert.equal(s2.stagesOf('2026-10-16--b').length, 0, 'uncommitted insert is gone');
    s2.close();
  } finally { t.cleanup(); }
});

test('WAL: a second connection reads committed rows while the store is open', () => {
  const t = tempRoot('db');
  try {
    const s = openStore({ J: t.J });
    assert.equal(s.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    s.insertJob({ id: '2026-10-16--c', line: 'l', state: 'queued' });
    const other = new DatabaseSync(path.join(t.dataRoot, 'station.db'), { readOnly: true });
    assert.equal(other.prepare('SELECT state FROM jobs WHERE id = ?').get('2026-10-16--c').state, 'queued');
    other.close(); s.close();
  } finally { t.cleanup(); }
});

test('versions: a stale write is refused (expectedVersion), a fresh one goes through', () => {
  const t = tempRoot('db');
  try {
    const s = openStore({ J: t.J });
    const j = s.insertJob({ id: '2026-10-16--d', line: 'l', state: 'queued' });
    s.updateJob(j.id, { reason: 'first' }, { expectedVersion: j.version });
    assert.throws(() => s.updateJob(j.id, { reason: 'stale tab' }, { expectedVersion: j.version }), (e) => e instanceof VersionConflict && e.code === 'STALE');
    assert.equal(s.getJob(j.id).reason, 'first');
    s.close();
  } finally { t.cleanup(); }
});

test('node:sqlite raises no warning on this Node version (nothing to filter out of the logs)', () => {
  const r = spawnSync(process.execPath, ['-e', "require('node:sqlite'); new (require('node:sqlite').DatabaseSync)(':memory:').exec('select 1')"], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(!/ExperimentalWarning/.test(r.stderr), 'stderr: ' + r.stderr);
});

test('the database file can only be opened through the data jail', () => {
  const src = fs.readFileSync(new URL('../src/engine/store/db.mjs', import.meta.url), 'utf8');
  assert.match(src, /new DatabaseSync\(J\.dataJail\(f\)\)/);
});
