// r1-routines.test.mjs — R1.1 (owner, R1 follow-up 24/10/2026): how the routines of a data root shaped like live after B0 behave once
// npm run migrate:products has run (tests/helpers/post-b0-fixture.mjs: the weekly genre scout, 2 legacy routines and "Weekday research",
// the last ENABLED as the worst case). On the archived Etsy lines:
//   - R7a.2 (owner, 29/10/2026): an enabled routine on an archived line is disabled when the engine starts (logged: a warning and a
//     routine.changed event), never armed and never fired; a firing anyway skips before any job, reservation or ledger row, and nothing can
//     enable one again. (Before R7a.2 it stayed armed and every firing skipped with "archived".)
//   - with every Etsy routine enabled (the worst case beyond live), every one is disabled at start; none starts a job or spends
//   - the COO's report routine is seeded disabled and cannot be armed while the COO is not hired
// Mock only, $0.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRoot } from './helpers/engine.mjs';
import { buildPostB0Root } from './helpers/post-b0-fixture.mjs';
import { CONFIG, PROMPTS } from './helpers/r1.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { openStore } from '../src/engine/store/db.mjs';
import { migrateProducts } from '../src/engine/lib/migrate-products.mjs';

const REAL = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
const NOW = () => Date.parse('2026-10-23T08:00:00Z');   // a Friday, 09:00 Dublin: the weekday research routine's own hour
const ETSY_LINES = ['research', 'genre-scout', 'room1-digital'];

function migrated(t, tag, { enableAll = false } = {}) {
  const r = tempRoot(tag); t.after(() => r.cleanup());
  buildPostB0Root({ J: r.J, log: r.log });
  if (enableAll) { const s = openStore({ J: r.J, log: null }); s.db.exec('UPDATE routines SET enabled = 1'); s.close(); }
  const m = migrateProducts({ J: r.J, cfg: REAL, log: null, apply: true, now: NOW });
  assert.equal(m.applied, true); assert.deepEqual(m.unmapped, []);
  return r;
}
// the engine as live starts it (the scheduler on), and every routine fired once; what each firing did, and what was spent
async function fireAll(r) {
  const e = createEngine({ J: r.J, log: r.log, clock: NOW, resume: false });
  try {
    const before = { jobs: e.store.listJobs().length, ledger: e.ledger.totals.rows, usd: e.ledger.spent.day('2026-10-23') };
    const armed = e.scheduler.armed().sort();
    const out = {};
    for (const rt of e.store.listRoutines()) {
      const res = await e.scheduler.fire(rt);
      out[rt.id] = { target: rt.target, product: rt.product_id + '/' + rt.department_id, enabled: !!rt.enabled, armed: armed.includes(rt.id), result: res.skipped ? 'skipped: ' + res.skipped : res.error ? 'error: ' + res.error : 'STARTED ' + JSON.stringify(res) };
    }
    const after = { jobs: e.store.listJobs().length, ledger: e.ledger.totals.rows, usd: e.ledger.spent.day('2026-10-23') };
    return { e, armed, out, before, after };
  } catch (err) { e.close(); throw err; }
}

test('after migrate:products on a live-shaped root: the enabled "Weekday research" is disabled at start and logged, nothing is armed, no job, no reservation, no spend', async (t) => {
  const r = migrated(t, 'r1rt');
  const { e, armed, out, before, after } = await fireAll(r);
  try {
    assert.deepEqual(armed, [], 'R7a.2: the one enabled before R1 is disabled at start, so nothing is armed');
    assert.deepEqual(e.disabledAtStart, ['rt_fix_weekday-research']);
    assert.equal(out['rt_fix_weekday-research'].enabled, false);
    assert.equal(out['rt_fix_weekday-research'].product, 'etsy-shop/etsy');
    for (const id of ['rt_fix_weekday-research', 'rt_seed_weekly-genre-scout', 'legacy-r0', 'legacy-r1', 'rt_seed_coo-daily-report']) assert.equal(out[id].result, 'skipped: routine is disabled', id);
    const ev = e.bus.recent(200).filter((x) => x.type === 'routine.changed' && x.data.routineId === 'rt_fix_weekday-research');
    assert.equal(ev.length, 1); assert.equal(ev[0].data.what, 'disabled at start: the research line is archived'); assert.equal(ev[0].departmentId, 'etsy');
    assert.equal(out['rt_seed_coo-daily-report'].product, 'station/hq');
    assert.deepEqual(after, before, 'no job, no ledger row, no spend');
    assert.equal(e.guard.reservations().length, 0, 'no reservation'); assert.equal(e.guard.status().inFlight, 0);
    // nothing can enable an Etsy routine again
    for (const id of ['rt_fix_weekday-research', 'rt_seed_weekly-genre-scout']) { const x = e.store.getRoutine(id); assert.throws(() => e.routines.enable(id, true, { expectedVersion: x.version }), (err) => err.code === 'ARCHIVED' && /cannot be armed: archived/.test(err.message), id); }
    // R3: the COO and the CEO are hired: their routines can be armed by the owner, and both stay disabled until then
    for (const id of ['rt_seed_coo-daily-report', 'rt_seed_ceo-weekly-memo']) assert.equal(e.store.getRoutine(id).enabled, false, id);
  } finally { e.close(); }
});

test('worst case beyond live: every Etsy routine enabled before the migration; each is disabled at start, none is armed, none starts a job or spends', async (t) => {
  const r = migrated(t, 'r1rtall', { enableAll: true });
  const { e, armed, out, before, after } = await fireAll(r);
  try {
    assert.deepEqual(armed, []);
    assert.deepEqual(e.disabledAtStart.slice().sort(), ['legacy-r0', 'legacy-r1', 'rt_fix_weekday-research', 'rt_seed_weekly-genre-scout']);
    for (const [id, o] of Object.entries(out)) {
      assert.doesNotMatch(o.result, /^STARTED/, id);
      const line = (/^line:(.+)$/.exec(o.target) || [])[1];
      if (ETSY_LINES.includes(line) || o.product === 'etsy-shop/etsy') assert.equal(o.result, 'skipped: routine is disabled', id);
    }
    assert.equal(out['rt_seed_coo-daily-report'].result, 'skipped: routine is disabled');
    assert.deepEqual(after, before, 'no job, no ledger row, no spend');
  } finally { e.close(); }
});

test('R7a.2: disabling at start is idempotent and touches only archived routines; a script engine and the archive sandbox change none', async (t) => {
  const r = migrated(t, 'r1rtstart');
  const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
  const se = openScriptEngine({ J: r.J, log: r.log, purpose: 'r7a2-test' });
  try { assert.equal(se.disabledAtStart, undefined); assert.equal(se.store.getRoutine('rt_fix_weekday-research').enabled, true, 'a script engine changes no routine'); } finally { se.close(); }
  // a routine that is held but not archived (the COO's report, seeded by the first open, forced on here): it stays enabled
  { const s = openStore({ J: r.J, log: null }); s.db.exec("UPDATE routines SET enabled = 1 WHERE id = 'rt_seed_coo-daily-report'"); s.close(); }
  const sb = createEngine({ J: r.J, log: r.log, clock: NOW, resume: false, archiveSandbox: true, startScheduler: false });
  try { assert.deepEqual(sb.disabledAtStart, []); assert.equal(sb.store.getRoutine('rt_fix_weekday-research').enabled, true, 'the archive sandbox archives nothing'); } finally { sb.close(); }
  const e1 = createEngine({ J: r.J, log: r.log, clock: NOW, resume: false });
  try {
    assert.deepEqual(e1.disabledAtStart, ['rt_fix_weekday-research']);
    assert.equal(e1.store.getRoutine('rt_fix_weekday-research').enabled, false);
    assert.equal(e1.store.getRoutine('rt_seed_coo-daily-report').enabled, true, 'not archived: left as it is');
    assert.ok(!e1.scheduler.armed().includes('rt_fix_weekday-research'));
  } finally { e1.close(); }
  const e2 = createEngine({ J: r.J, log: r.log, clock: NOW, resume: false });
  try {
    assert.deepEqual(e2.disabledAtStart, [], 'the second start finds nothing to disable');
    assert.equal(e2.bus.recent(200).filter((x) => x.type === 'routine.changed').length, 0);
  } finally { e2.close(); }
  const warned = fs.readdirSync(r.logs).filter((n) => n.endsWith('.log') || n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(r.logs, n), 'utf8')).join('\n');
  assert.equal((warned.match(/routine disabled at start: archived/g) || []).length, 1, 'logged once, at the first start');
});
