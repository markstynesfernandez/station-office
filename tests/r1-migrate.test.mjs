// r1-migrate.test.mjs — R1 (owner, R1 prompt 23/10/2026; RESTRUCTURE.md §1.4, §8 R1): npm run migrate:products on a data root shaped like
// live after B0 (32 jobs, 47 runs, 4 routines, 1 approval, 509 ledger rows, 1,148 events; tests/helpers/post-b0-fixture.mjs):
//   - the engine refuses the root until it is migrated (MIGRATE, with the command)
//   - the dry run (the default) maps every record (0 unmapped) and writes nothing
//   - --apply backs up first, sets product and department on every record in one transaction, logs every change; the engine then
//     starts and reads every old row with its product; the ledger and the events are never rewritten
//   - a second run changes nothing and takes no backup (idempotent)
//   - interrupted mid-run (an error inside the transaction, or the process killed), nothing is half-written and a rerun completes
//   - refused: a pre-B0 root (run migrate:businesses first), anything unmapped, an engine holding the lock
// Mock only, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempRoot } from './helpers/engine.mjs';
import { buildPostB0Root, SHAPE } from './helpers/post-b0-fixture.mjs';
import { CONFIG, PROMPTS } from './helpers/r1.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { openStore, PRODUCT_TABLES, BUSINESS_TABLES } from '../src/engine/store/db.mjs';
import { migrateProducts } from '../src/engine/lib/migrate-products.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const NOW = () => Date.parse('2026-10-23T18:00:00Z');
const caplog = () => { const lines = []; const put = (lvl) => (msg, data) => lines.push({ lvl, msg, data: data || {} }); return { lines, info: put('info'), warn: put('warn'), error: put('error') }; };
function liveShaped(t, tag) { const r = tempRoot(tag); t.after(() => r.cleanup()); buildPostB0Root({ J: r.J, log: r.log }); return r; }
// what the database holds, table by table (the schema too), through the engine's own store
function dump(r) {
  const s = openStore({ J: r.J, log: null });
  try { return JSON.stringify({ schema: s.db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all(), rows: BUSINESS_TABLES.map((t) => s.db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all()) }); } finally { s.close(); }
}
const counts = (r) => { const s = openStore({ J: r.J, log: null }); try { return Object.fromEntries(PRODUCT_TABLES.map((t) => [t, s.db.prepare('SELECT COUNT(*) n FROM ' + t).get().n])); } finally { s.close(); } };
const backups = (r) => (fs.existsSync(path.join(r.dataRoot, '.backups')) ? fs.readdirSync(path.join(r.dataRoot, '.backups')).sort() : []);
const read = (r, rel) => fs.readFileSync(path.join(r.dataRoot, rel), 'utf8');
const EXPECT = { jobs: { 'etsy-shop/etsy': 32 }, runs: { 'etsy-shop/etsy': 47 }, routines: { 'etsy-shop/etsy': 4 }, approvals: { 'etsy-shop/etsy': 1 }, ledger_mirror: { 'etsy-shop/etsy': 508, 'station/hq': 1 } };

test('the fixture is shaped like live after B0: 32 jobs, 47 runs, 4 routines, 1 approval, 509 ledger rows, 1,148 events in 6 files; business_id on every record; no product columns', (t) => {
  const r = liveShaped(t, 'r1fix');
  assert.deepEqual(counts(r), { jobs: 32, runs: 47, routines: 4, approvals: 1, ledger_mirror: 509 });
  const s = openStore({ J: r.J, log: null });
  try { assert.deepEqual(s.businessGaps(), { missingColumn: [], nullRows: {} }); assert.deepEqual(s.productGaps().missingColumn, PRODUCT_TABLES); assert.equal(s.hasProductColumns(), false); assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'requests'").get().n, 0); } finally { s.close(); }
  assert.equal(read(r, 'ledger/ledger.jsonl').trim().split('\n').length, SHAPE.ledger);
  const ev = fs.readdirSync(path.join(r.dataRoot, 'events'));
  assert.equal(ev.length, SHAPE.eventFiles); assert.equal(ev.reduce((n, f) => n + read(r, 'events/' + f).trim().split('\n').length, 0), SHAPE.events);
});

test('migrate:products on the live-shaped root: the engine refuses it first; the dry run maps every record (0 unmapped) and writes nothing; apply backs up, sets every record, logs each; the engine then starts; a second run changes nothing', (t) => {
  const r = liveShaped(t, 'r1mig');
  assert.throws(() => createEngine({ J: r.J, log: r.log, startScheduler: false }), (e) => e.code === 'MIGRATE' && /jobs: no product_id\/department_id columns/.test(e.message) && /npm run migrate:products/.test(e.message));
  const before = dump(r), dbBytes = fs.readFileSync(path.join(r.dataRoot, 'station.db')), ledgerBefore = read(r, 'ledger/ledger.jsonl'), eventsBefore = fs.readdirSync(path.join(r.dataRoot, 'events')).map((f) => read(r, 'events/' + f)).join('');
  // the dry run
  const L1 = caplog(), dry = migrateProducts({ J: r.J, cfg: REAL, log: L1, now: NOW });
  assert.deepEqual([dry.applied, dry.nothingToDo, dry.backup, dry.unmapped], [false, false, null, []]);
  assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, dry.tables[t2].toSet])), EXPECT);
  assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, [dry.tables[t2].rows, dry.tables[t2].columns, dry.tables[t2].toSetRows]])), { jobs: [32, 'missing', 32], runs: [47, 'missing', 47], routines: [4, 'missing', 4], approvals: [1, 'missing', 1], ledger_mirror: [509, 'missing', 509] });
  assert.deepEqual(dry.logs.ledger, { file: 'ledger/ledger.jsonl', rows: 509, withProduct: 0, resolved: { 'etsy-shop/etsy': 508, 'station/hq': 1 }, unreadable: 0, rewritten: false });
  assert.deepEqual([dry.logs.events.files, dry.logs.events.rows, dry.logs.events.resolved], [6, 1148, { 'etsy-shop/etsy': 1050, 'station/hq': 98 }]);
  assert.equal(L1.lines.filter((x) => x.msg === 'product would be set').length, 32 + 47 + 4 + 1 + 509);
  assert.equal(dump(r), before, 'the dry run wrote nothing (no column, no requests table, no value)');
  assert.ok(fs.readFileSync(path.join(r.dataRoot, 'station.db')).equals(dbBytes), 'station.db is byte for byte the same'); assert.deepEqual(backups(r), []);
  // apply
  const L2 = caplog(), done = migrateProducts({ J: r.J, cfg: REAL, log: L2, apply: true, now: NOW });
  assert.deepEqual([done.applied, done.backup.dir], [true, '.backups/products-20261023T180000Z']);
  for (const f of ['station.db', 'BACKUP.json', 'ledger/ledger.jsonl']) assert.ok(fs.existsSync(path.join(r.dataRoot, '.backups', 'products-20261023T180000Z', f)), f);
  assert.equal(L2.lines.filter((x) => x.msg === 'product set').length, 593); assert.equal(L2.lines.filter((x) => x.msg === 'column added').length, 10);
  assert.ok(L2.lines.some((x) => x.msg === 'product set' && x.data.table === 'ledger_mirror' && x.data.id === 'led_smoke' && x.data.product === 'station' && x.data.department === 'hq'));
  assert.equal(read(r, 'ledger/ledger.jsonl'), ledgerBefore, 'the ledger is never rewritten');
  assert.equal(fs.readdirSync(path.join(r.dataRoot, 'events')).map((f) => read(r, 'events/' + f)).join(''), eventsBefore, 'the events are never rewritten');
  assert.deepEqual(counts(r), { jobs: 32, runs: 47, routines: 4, approvals: 1, ledger_mirror: 509 }, 'nothing added or deleted');
  // a second run changes nothing and takes no second backup
  const again = migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true, now: () => NOW() + 60000 });
  assert.deepEqual([again.applied, again.nothingToDo, again.backup, again.unmapped], [false, true, null, []]);
  assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, [again.tables[t2].already, again.tables[t2].toSetRows]])), { jobs: [32, 0], runs: [47, 0], routines: [4, 0], approvals: [1, 0], ledger_mirror: [509, 0] });
  assert.deepEqual(backups(r), ['products-20261023T180000Z']);
  // the engine starts and reads every old row with its product; spend totals per product are the ledger's
  const e = createEngine({ J: r.J, log: r.log, startScheduler: false, resume: false });
  try {
    assert.deepEqual(e.store.productGaps(), { missingColumn: [], nullRows: {} }); assert.equal(e.store.hasProductColumns(), true);
    const by = (t2) => e.store.db.prepare('SELECT product_id || \'/\' || department_id k, COUNT(*) n FROM ' + t2 + ' GROUP BY k').all().reduce((o, x) => ({ ...o, [x.k]: x.n }), {});
    // the first R1 start also seeds the COO's report routine (station/hq), disabled like every seed
    assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, by(t2)])), { ...EXPECT, routines: { 'etsy-shop/etsy': 4, 'station/hq': 2 } });
    assert.equal(e.store.getRoutine('rt_seed_coo-daily-report').enabled, false);
    assert.equal(e.ledger.totals.rows, 509); assert.equal(e.requests.list().length, 0, 'the requests table exists and is empty');
    const month = (p) => Object.entries(e.ledger.totals.byProductMonth).filter(([k]) => k.startsWith(p + '|')).reduce((s, [, v]) => s + v, 0);
    assert.equal(Math.round(month('etsy-shop') * 1e6) / 1e6, 0.0503); assert.equal(month('station'), 0.000005);
    assert.equal(e.store.getJob('2026-10-10--legacy-0').department_id, 'etsy');
  } finally { e.close(); }
});

test('migrate:products is safe to restart: an error mid-transaction leaves nothing half-written, and a rerun completes; then nothing is left to do', (t) => {
  const r = liveShaped(t, 'r1midrun');
  const before = dump(r);
  assert.throws(() => migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true, now: NOW, fault: { afterUpdates: 300, action: () => { throw new Error('simulated crash after 300 of 593 updates'); } } }), /simulated crash/);
  assert.equal(dump(r), before, 'rolled back: no column, no requests table, no value');
  assert.deepEqual(backups(r), ['products-20261023T180000Z'], 'the backup was taken first');
  assert.ok(!fs.existsSync(path.join(r.dataRoot, '.lock')), 'the lock was released');
  const re = migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true, now: () => NOW() + 1000 });
  assert.equal(re.applied, true); assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, re.tables[t2].toSet])), EXPECT);
  assert.equal(migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true }).nothingToDo, true);
});

test('migrate:products is safe to restart after the process is killed mid-transaction: SQLite rolls it back, the stale lock is replaced, a rerun completes', (t) => {
  const r = liveShaped(t, 'r1killed');
  const before = dump(r);
  const child = path.join(r.base, 'kill-mid-migration.mjs'), url = (p) => pathToFileURL(path.join(APP_ROOT, p)).href;
  fs.writeFileSync(child, [
    "const { createJail } = await import(" + JSON.stringify(url('src/engine/store/jail.mjs')) + ");",
    "const { loadConfig } = await import(" + JSON.stringify(url('src/engine/config.mjs')) + ");",
    "const { migrateProducts } = await import(" + JSON.stringify(url('src/engine/lib/migrate-products.mjs')) + ");",
    "const J = createJail({ dataRoot: process.env.FIX_ROOT, extraRoots: [] });",
    "const cfg = loadConfig({ configDir: " + JSON.stringify(CONFIG) + ", promptsDir: " + JSON.stringify(PROMPTS) + " });",
    "migrateProducts({ J, cfg, log: null, apply: true, fault: { afterUpdates: 400, action: () => process.exit(9) } });",
    "console.log('not reached');"
  ].join('\n'));
  const k = spawnSync(process.execPath, [child], { env: { ...process.env, FIX_ROOT: r.dataRoot, STATION_INSTANCE: 'dev', STATION_PROVIDER: 'mock' }, encoding: 'utf8' });
  assert.equal(k.status, 9, k.stderr); assert.ok(!k.stdout.includes('not reached'));
  assert.ok(fs.existsSync(path.join(r.dataRoot, '.lock')), 'the killed process left its lock');
  assert.equal(dump(r), before, 'nothing of the killed transaction is visible');
  const re = migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true, now: () => NOW() + 2000 });
  assert.equal(re.applied, true); assert.deepEqual(Object.fromEntries(PRODUCT_TABLES.map((t2) => [t2, re.tables[t2].toSet])), EXPECT);
  assert.equal(backups(r).length, 2, 'one backup from the killed run, one from the rerun');
  assert.equal(migrateProducts({ J: r.J, cfg: REAL, log: caplog(), apply: true }).nothingToDo, true);
  const e = createEngine({ J: r.J, log: r.log, startScheduler: false, resume: false }); e.close();
});

test('migrate:products refuses a pre-B0 root (with the reason), an unmapped record, and an engine holding the lock; nothing is written', (t) => {
  // pre-B0: no business_id
  const p = liveShaped(t, 'r1preb0');
  const s = openStore({ J: p.J, log: null }); for (const t2 of BUSINESS_TABLES) s.db.exec('ALTER TABLE ' + t2 + ' DROP COLUMN business_id'); s.close();
  const before = dump(p);
  for (const apply of [false, true]) assert.throws(() => migrateProducts({ J: p.J, cfg: REAL, log: caplog(), apply }), (e) => e.code === 'PRE_B0' && /from before B0 \(jobs: no business_id column/.test(e.message) && /run npm run migrate:businesses first/.test(e.message) && /nothing was written/.test(e.message));
  assert.equal(dump(p), before); assert.deepEqual(backups(p), []);
  // a record that maps to no product
  const u = liveShaped(t, 'r1unmapped');
  const s2 = openStore({ J: u.J, log: null }); s2.db.prepare("UPDATE jobs SET business_id = 'second-shop' WHERE id = '2026-10-16--desk-props-0'").run(); s2.close();
  const dry = migrateProducts({ J: u.J, cfg: REAL, log: caplog() });
  assert.deepEqual(dry.unmapped, [{ table: 'jobs', id: '2026-10-16--desk-props-0', why: 'business_id "second-shop" maps to no product and department' }]);
  const ub = dump(u);
  assert.throws(() => migrateProducts({ J: u.J, cfg: REAL, log: caplog(), apply: true }), /refused: 1 record\(s\) could not be mapped to a product and department .*nothing was written/);
  assert.equal(dump(u), ub); assert.deepEqual(backups(u), []);
  // an engine (another live process) holds the lock
  const l = liveShaped(t, 'r1locked');
  l.J.put(path.join(l.dataRoot, '.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }) + '\n');
  assert.throws(() => migrateProducts({ J: l.J, cfg: REAL, log: caplog(), apply: true }), (e) => e.code === 'LOCKED');
  assert.deepEqual(backups(l), []);
});

test('npm run migrate:products: a dry run by default (0 unmapped), writes only with --apply, then nothing to change; every change in logs/migrate-products-<date>.log', (t) => {
  const r = liveShaped(t, 'r1script');
  const env = { ...process.env, STATION_DATA_ROOT: r.dataRoot, STATION_PROVIDER: 'mock', STATION_INSTANCE: 'dev' };
  const go = (...a) => spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'migrate-products.mjs'), ...a], { env, encoding: 'utf8', cwd: APP_ROOT });
  const out = (s) => { const a = s.search(/^\{$/m), b = s.lastIndexOf('\n}'); return JSON.parse(s.slice(a, b + 2)); };
  const dry = go(); assert.equal(dry.status, 0, dry.stderr);
  const p = out(dry.stdout); assert.deepEqual([p.applied, p.unmappedCount], [false, 0]); assert.match(p.note, /^dry run: nothing written; 0 unmapped/);
  const app = go('--apply'); assert.equal(app.status, 0, app.stderr); assert.equal(out(app.stdout).applied, true);
  const two = go('--apply'); assert.equal(two.status, 0, two.stderr); assert.equal(out(two.stdout).note, 'nothing to change');
  const logs = path.join(APP_ROOT, 'logs'), f = fs.readdirSync(logs).filter((x) => /^migrate-products-\d{4}-\d{2}-\d{2}\.log$/.test(x)).sort().pop();
  assert.ok(f, 'logs/migrate-products-<date>.log');
  const mine = fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter((l) => l.includes(r.dataRoot.replace(/\\/g, '\\\\')) || l.includes('led_smoke'));
  assert.ok(mine.some((l) => /"msg":"product set"/.test(l) && /led_smoke/.test(l)), 'each change is logged');
});
