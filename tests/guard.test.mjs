// guard.test.mjs — the spend guard and the ledger (ENGINE-PLAN.md §5.1, §1.2): reservation before every call,
// refusal at each cap, no overshoot with calls in flight, fail-closed on unknown prices / an unreadable ledger / the
// e-stop, Europe/Dublin days, and the restart mid-run charge. Uses test prices (the mock's are $0).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLedger } from '../src/engine/ledger.mjs';
import { createGuard, CapError, GuardRefusal, textCost, textMax } from '../src/engine/guard.mjs';
import { createBus } from '../src/engine/bus.mjs';
import { tempRoot, CAPS, PRICING } from './helpers/engine.mjs';

const NOON = Date.parse('2026-10-16T11:00:00Z');   // 12:00 in Dublin (IST)
function setup({ caps = CAPS, pricing = PRICING, halted = false, clock = () => NOON, t = tempRoot('guard') } = {}) {
  const bus = createBus({ J: t.J, log: t.log });
  const events = []; bus.subscribe((e) => events.push(e));
  const ledger = createLedger({ J: t.J, log: t.log });
  const halt = { isHalted: () => halted };
  const guard = createGuard({ J: t.J, ledger, halt, caps, pricing, log: t.log, bus, clock });
  return { t, bus, events, ledger, guard };
}
const call = (o = {}) => ({ provider: 'test', model: 'cheap-model', kind: 'text', runId: 'run-1', jobId: '2026-10-16--job', agentKey: 'designer', line: 'room1-digital', inputTokens: 10000, maxOutputTokens: 8000, ...o });

test('text cost: priced from usage; the reservation is the worst case (dearest input rate + full output)', () => {
  const p = { inPerM: 2, outPerM: 10 };
  assert.equal(textCost(p, { input_tokens: 1e6, output_tokens: 1e5 }), 3);
  assert.equal(textCost(p, { cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }), 2.5 + 0.2);
  assert.equal(textMax(p, 10000, 8000), (10000 * 2.5 + 8000 * 10) / 1e6);
});

test('reserve -> settle: a pending record exists only during the call; the ledger row carries jobId, fsynced JSONL', () => {
  const { t, guard, ledger, events } = setup();
  try {
    const res = guard.reserve(call());
    assert.equal(res.maxUsd, textMax(PRICING.test.models['cheap-model'], 10000, 8000));
    assert.equal(fs.readdirSync(path.join(t.dataRoot, 'ledger', 'pending')).length, 1);
    const row = guard.settle(res, { usage: { input_tokens: 9000, output_tokens: 1000 } });
    assert.equal(row.usd, (9000 * 1 + 1000 * 5) / 1e6); assert.equal(row.jobId, '2026-10-16--job'); assert.equal(row.kind, 'text');
    assert.equal(fs.readdirSync(path.join(t.dataRoot, 'ledger', 'pending')).length, 0);
    const lines = fs.readFileSync(path.join(t.dataRoot, 'ledger', 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).entryId, row.entryId);
    assert.equal(ledger.spent.job('2026-10-16--job'), row.usd);
    assert.ok(events.some((e) => e.type === 'spend.row'));
    assert.throws(() => guard.settle(res, { usd: 1 }), /already settled/);
  } finally { t.cleanup(); }
});

test('release: a call that never reached the provider charges nothing', () => {
  const { t, guard, ledger } = setup();
  try { const r = guard.reserve(call()); guard.release(r, 'network down'); assert.equal(ledger.totals.rows, 0); assert.equal(guard.reservations().length, 0); } finally { t.cleanup(); }
});

test('refusal at each cap, with the cap named and the figures in the reason', () => {
  const cases = [
    { name: 'perRun', caps: { ...CAPS, perRunUsd: 0.05 }, c: call({ inputTokens: 0, maxOutputTokens: 20000 }) },
    { name: 'perJob', caps: { ...CAPS, perJobUsd: 0.05 }, c: call({ inputTokens: 0, maxOutputTokens: 20000 }) },
    { name: 'perAgentDay[designer]', caps: { ...CAPS, perAgentDayUsd: { default: 0, designer: 0.05 } }, c: call({ inputTokens: 0, maxOutputTokens: 20000 }) },
    { name: 'perLineDay[room1-digital]', caps: { ...CAPS, perLineDayUsd: { default: 0.05 } }, c: call({ inputTokens: 0, maxOutputTokens: 20000 }) },
    { name: 'perDay', caps: { ...CAPS, perDayUsd: 0.05 }, c: call({ inputTokens: 0, maxOutputTokens: 20000 }) },
    { name: 'imagesPerDay', caps: { ...CAPS, imagesPerDay: 2 }, c: call({ kind: 'image', model: 'img-model', count: 3 }) }
  ];
  for (const k of cases) {
    const { t, guard, events, ledger } = setup({ caps: k.caps });
    try {
      assert.throws(() => guard.reserve(k.c), (e) => e instanceof CapError && e.cap === k.name && /^cap: /.test(e.message), k.name);
      assert.equal(guard.reservations().length, 0, k.name + ': nothing reserved'); assert.equal(ledger.totals.rows, 0);
      assert.ok(events.some((e) => e.type === 'cap.hit' && e.data.cap === k.name), k.name + ': cap.hit event');
    } finally { t.cleanup(); }
  }
});

test('the reason reads like the plan: "cap: perJob 1.00 reached (spent 0.97, next call up to 0.06)"', () => {
  const { t, guard, ledger } = setup();
  try {
    ledger.append({ jobId: '2026-10-16--job', runId: 'old', provider: 'test', model: 'cheap-model', kind: 'text', usd: 0.97, ts: NOON });
    assert.throws(() => guard.reserve(call({ runId: 'run-2', inputTokens: 0, maxOutputTokens: 12000 })), { message: 'cap: perJob 1.00 reached (spent 0.97, next call up to 0.06)' });
  } finally { t.cleanup(); }
});

test('no overshoot: reservations in flight count against the cap before they settle', () => {
  const { t, guard } = setup({ caps: { ...CAPS, perJobUsd: 0.1, perRunUsd: 1 } });
  try {
    const a = guard.reserve(call({ runId: 'r-a', inputTokens: 0, maxOutputTokens: 12000 }));   // 0.06
    assert.throws(() => guard.reserve(call({ runId: 'r-b', inputTokens: 0, maxOutputTokens: 12000 })), (e) => e.cap === 'perJob', 'second 0.06 would pass 0.10');
    guard.settle(a, { usage: { output_tokens: 1000 } });                                          // real cost 0.005
    const b = guard.reserve(call({ runId: 'r-b', inputTokens: 0, maxOutputTokens: 12000 }));
    guard.release(b);
  } finally { t.cleanup(); }
});

test('fail closed: unknown price, missing caps, an unreadable ledger and the e-stop each refuse every call', () => {
  let s = setup();
  try { assert.throws(() => s.guard.reserve(call({ model: 'unpriced' })), (e) => e instanceof GuardRefusal && e.code === 'PRICE'); assert.throws(() => s.guard.reserve(call({ kind: 'web', model: 'cheap-model' })), (e) => e.code === 'PRICE'); } finally { s.t.cleanup(); }
  s = setup({ caps: { ...CAPS, perJobUsd: 0 } });
  try { assert.throws(() => s.guard.reserve(call()), (e) => e.code === 'CAPS'); } finally { s.t.cleanup(); }
  s = setup({ halted: true });
  try { assert.throws(() => s.guard.reserve(call()), (e) => e.code === 'HALT'); } finally { s.t.cleanup(); }
  const t = tempRoot('guard');
  try {
    t.J.put(path.join(t.dataRoot, 'ledger', 'ledger.jsonl'), '{"entryId":"a","ts":1,"jobId":null,"provider":"test","model":"m","kind":"text","usd":0.1}\n{not json\n');
    s = setup({ t });
    assert.equal(s.ledger.state.ok, false);
    assert.throws(() => s.guard.reserve(call()), (e) => e.code === 'LEDGER');
    assert.throws(() => s.ledger.append({ jobId: null, provider: 'test', model: 'm', kind: 'text', usd: 0 }), /not ok/);
  } finally { t.cleanup(); }
});

test('ledger rows are validated, never edited; a correction is a new row; appends are idempotent on entryId', () => {
  const { t, ledger } = setup();
  try {
    assert.throws(() => ledger.append({ jobId: null, provider: 'test', model: 'm', kind: 'text', usd: -1 }), /usd/);
    assert.throws(() => ledger.append({ provider: 'test', model: 'm', kind: 'text', usd: 1 }), /jobId/);
    assert.throws(() => ledger.append({ jobId: null, provider: 'test', model: 'm', kind: 'sms', usd: 1 }), /kind/);
    const a = ledger.append({ entryId: 'e1', jobId: 'j', provider: 'test', model: 'm', kind: 'text', usd: 0.2, ts: NOON });
    ledger.append({ entryId: 'e1', jobId: 'j', provider: 'test', model: 'm', kind: 'text', usd: 0.2, ts: NOON });
    ledger.append({ jobId: 'j', provider: 'test', model: 'm', kind: 'text', usd: 0, correctionOf: a.entryId, note: 'example correction', ts: NOON });
    assert.equal(ledger.totals.rows, 2); assert.equal(ledger.spent.job('j'), 0.2);
  } finally { t.cleanup(); }
});

test('days are Europe/Dublin calendar days (23:30 UTC on 16/10 is 17/10 in Dublin)', () => {
  const late = Date.parse('2026-10-16T23:30:00Z');
  const { t, guard, ledger } = setup({ caps: { ...CAPS, perDayUsd: 0.5 }, clock: () => late });
  try {
    ledger.append({ jobId: 'x', provider: 'test', model: 'cheap-model', kind: 'text', usd: 0.45, ts: Date.parse('2026-10-16T22:30:00Z') });   // 23:30 Dublin on 16/10
    const r = guard.reserve(call({ jobId: 'y', runId: 'r', inputTokens: 0, maxOutputTokens: 12000 }));   // 0.06 on 17/10: allowed
    guard.release(r);
    assert.equal(ledger.spent.day('2026-10-16'), 0.45); assert.equal(guard.status().day, '2026-10-17');
  } finally { t.cleanup(); }
});

test('restart mid-run: a call in flight when the process died is charged at its reserved maximum, once', () => {
  const t = tempRoot('guard');
  try {
    const first = setup({ t });
    const res = first.guard.reserve(call({ inputTokens: 1000, maxOutputTokens: 8000 }));
    // the process "dies" here: no settle. A new guard on the same data root recovers it.
    const second = setup({ t });
    const rows = second.guard.recoverPending();
    assert.equal(rows.length, 1); assert.equal(rows[0].usd, res.maxUsd); assert.equal(rows[0].estimated, true); assert.equal(rows[0].priceSource, 'reserved-maximum');
    assert.equal(second.ledger.spent.job('2026-10-16--job'), res.maxUsd);
    const third = setup({ t });
    assert.equal(third.guard.recoverPending().length, 0, 'not charged twice');
    assert.equal(third.ledger.totals.rows, 1, 'totals rebuilt from the JSONL after the restart');
  } finally { t.cleanup(); }
});

test('cap.warn once at 80% of a cap', () => {
  const { t, guard, events } = setup({ caps: { ...CAPS, perJobUsd: 0.1 } });
  try {
    for (let i = 0; i < 3; i++) { const r = guard.reserve(call({ runId: 'w' + i, inputTokens: 0, maxOutputTokens: 1000 })); guard.settle(r, { usd: 0.03 }); }
    assert.equal(events.filter((e) => e.type === 'cap.warn' && e.data.cap === 'perJob').length, 1);
  } finally { t.cleanup(); }
});
