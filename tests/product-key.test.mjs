// product-key.test.mjs — the product key is data, never prose (owner, 17/10/2026; DECISIONS.md "E6 step b2: product key
// as data"), on the MOCK provider:
//   - an unknown key ends the job incomplete ("unknown product key: <key>") at USD 0 with zero model calls, exit 1
//   - a missing key defaults to the line config's key (pngtuber-prop-pack), never to anything in prompt wording; with no
//     config default either, the job ends incomplete the same way
//   - the scout run input carries "product_key: <key>"; the routine seed carries productKey; no prompt describes a product
//     as its key
//   - the mock scout reads the key from the run input (the live input path), so its drafts carry whatever key is given
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { scoutRunExitCode } from '../src/engine/lib/scouting.mjs';
import { validateScoutBrief } from '../src/engine/lib/scout-brief.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createScoutScript, genreBrief, GENRES } from '../fixtures/engine/scout-script.mjs';

const CONFIG_KEY = 'pngtuber-prop-pack';
function boot(t) {
  const r = tempRoot('pkey'), seen = [];
  const base = createScoutScript({ bad: false });
  const script = (ctx, params) => { seen.push({ agent: ctx.agentKey, input: String(params.messages[0].content) }); return base(ctx, params); };
  script.web = base.web;
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, seen };
}
async function run(e, opts = {}) { const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test', ...opts }); await e.orchestrator.startJob(c.id); return e.store.getJob(c.id); }
const zero = (e, seen) => { assert.equal(seen.length, 0, 'no model call'); assert.equal(e.ledger.rows().length, 0, 'no ledger row'); assert.equal(e.guard.reservations().length, 0, 'nothing reserved'); };

test('an unknown product key ends the job incomplete at USD 0 with zero model calls (exit 1), before any step', async (t) => {
  const { e, seen } = boot(t);
  for (const key of ['desk-props-pack', 'DESK-PROPS-01', 'the desk-props pack']) {
    const job = await run(e, { productKey: key });
    assert.equal(job.state, 'incomplete'); assert.equal(job.reason, 'unknown product key: ' + key);
    assert.equal(scoutRunExitCode(job), 1);
    assert.deepEqual(e.store.stagesOf(job.id), [], 'no step ran (not even scout-retention)');
    assert.equal(e.ledger.spent.job(job.id), 0);
  }
  zero(e, seen);
  assert.equal(e.store.runsOf({ agentKey: 'trend-scout', limit: 5 }).length, 0);
});

test('a missing product key defaults to the line config\'s key only; with no config default the job ends incomplete at USD 0', async (t) => {
  const { e, seen } = boot(t);
  assert.equal(e.cfg.lines['genre-scout'].productKey, CONFIG_KEY); assert.equal(e.cfg.lines['genre-scout'].requiresProductKey, true);
  const job = await run(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.equal(job.product_key, CONFIG_KEY); assert.equal(job.data.productKeySource, 'line config');
  const scoutIn = seen.find((s) => s.agent === 'trend-scout').input;
  assert.match(scoutIn, /^product_key: pngtuber-prop-pack$/m, 'the key reaches TREND-SCOUT as one data line');
  // without a config default (and without a given key) nothing else supplies one: the job ends before any call
  const { e: e2, seen: seen2 } = boot(t);
  delete e2.cfg.lines['genre-scout'].productKey;
  const j2 = await run(e2);
  assert.equal(j2.state, 'incomplete'); assert.equal(j2.reason, 'unknown product key: (none)');
  zero(e2, seen2);
  const j3 = await run(e2, { productKey: null });
  assert.equal(j3.reason, 'unknown product key: (none)');
});

test('the routine seed carries productKey as data; the routine input names no product', async (t) => {
  const { e, seen } = boot(t);
  const seed = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'routines.json'), 'utf8')).routines.find((r) => r.id === 'rt_seed_weekly-genre-scout');
  assert.equal(seed.productKey, CONFIG_KEY);
  assert.doesNotMatch(seed.input, /desk.?props|pngtuber|prop pack|product key [a-z]/i, 'the input text never names a product or key');
  const job = await e.runRoutine(e.store.getRoutine(seed.id));
  assert.equal(job.state, 'research-done', job.reason);
  assert.equal(job.product_key, CONFIG_KEY); assert.equal(job.data.productKeySource, 'given');
  assert.match(seen.find((s) => s.agent === 'trend-scout').input, /^product_key: pngtuber-prop-pack$/m);
});

test('no prompt or skill describes a product as its key; TREND-SCOUT step 1 uses the injected product_key', () => {
  const dirs = ['agents', 'skills'].map((d) => path.join(APP_ROOT, 'prompts', d));
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    const t = fs.readFileSync(path.join(d, f), 'utf8');
    assert.doesNotMatch(t, /desk-?props pack|desk props pack|DESK-PROPS-01/i, f);
  }
  const p = fs.readFileSync(path.join(APP_ROOT, 'prompts', 'agents', 'trend-scout.md'), 'utf8');
  assert.match(p, /^1\. Your run input has a line `product_key: <key>`; the station has already checked that key against `products\.json`\./m);
  assert.doesNotMatch(p, /routine prompt names|NO PRODUCT|pngtuber/i, 'no product named or described in the orders');
  const role = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'agents', 'trend-scout.json'), 'utf8')).role;
  assert.doesNotMatch(role, /desk.?props/i);
});

test('the mock scout takes the key from the run input (the live input path): a different valid key flows into every draft; a mismatched draft is refused on write', async (t) => {
  const { e } = boot(t);
  const clone = { ...e.cfg.products.find((p) => p.key === CONFIG_KEY), key: 'fixture-clone-pack' };
  e.cfg.products.push(clone);
  const job = await run(e, { productKey: 'fixture-clone-pack' });
  assert.equal(job.state, 'research-done', job.reason);
  const dir = path.join(e.J.dataRoot, 'research', 'briefs'), files = fs.readdirSync(dir);
  assert.equal(files.length, 4);
  for (const f of files) assert.match(fs.readFileSync(path.join(dir, f), 'utf8'), /^product_type: fixture-clone-pack$/m, f);
  const v = validateScoutBrief(genreBrief('2026-10-17', GENRES[0], { productKey: 'other-pack' }), { day: '2026-10-17', agent: true, productKey: CONFIG_KEY });
  assert.equal(v.ok, false); assert.match(v.problems.join('; '), /product_type must be this run's product_key, pngtuber-prop-pack \(got other-pack\)/);
});
