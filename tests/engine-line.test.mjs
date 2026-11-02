// engine-line.test.mjs — the agent runtime and the Room 1 line on the mock provider ($0, no keys), each test in its own
// temp data root with the dry-run fixtures (fixtures/engine/). Covers: the full line with one QA-DESIGN rework into the
// approval queue; the originality hard fail; an exhausted listing loop going to REJECTS-DESK (owner Q4); the e-stop
// mid-call (no further provider call, no further ledger row, job stopped); a cap refusing the first call (job blocked,
// nothing called); the tool jail; the QA record check; and that no agent can be given a messaging or shell tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { TOOL_NAMES, FORBIDDEN_TOOL_RE, toolDefs, validateVerdict } from '../src/engine/tools/index.mjs';
import { PLANNED_TOOLS } from '../src/engine/policy.mjs';
import { createDryRunScript, JOB_A, JOB_B } from '../fixtures/engine/mock-script.mjs';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const CONFIG = path.join(APP_ROOT, 'config'), PROMPTS = path.join(APP_ROOT, 'prompts');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const brief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
const lastResults = (params) => { const last = params.messages[params.messages.length - 1]; return Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : []; };

// one engine on a temp root; wrap(base) may replace the scripted replies; configDir may be a patched copy
function lineEngine(t, { wrap = (s) => s, configDir = CONFIG, tag = 'line' } = {}) {
  const r = tempRoot(tag);
  const station = loadConfig({ configDir, promptsDir: PROMPTS, overrides: OVERRIDES }).station;
  const script = wrap(createDryRunScript({ cfg: station }));
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, configDir, overrides: OVERRIDES, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  const run = async (id) => { const c = engine.orchestrator.createJob({ briefText: brief(id), by: 'test' }); assert.ok(c.ok, 'intake: ' + (c.reasons || []).join('; ')); await engine.orchestrator.startJob(id); return engine.store.getJob(id); };
  return { engine, r, run, jobDir: (id) => path.join(r.dataRoot, 'jobs', id) };
}

test('full line: one QA-DESIGN rework, package gate, approval queue; every cost row is the $0 mock', async (t) => {
  const { engine, run, jobDir } = lineEngine(t);
  const job = await run(JOB_A);
  assert.equal(job.state, 'approval', job.reason);
  assert.equal(job.loops.design, 1);
  const d = jobDir(JOB_A);
  assert.equal(readJson(path.join(d, 'qa', 'design-pass1.json')).verdict, 'revise');
  assert.equal(readJson(path.join(d, 'qa', 'design-pass2.json')).verdict, 'approved');
  assert.ok(fs.existsSync(path.join(d, 'set-v1')) && fs.existsSync(path.join(d, 'set-v2')));
  const m = readJson(path.join(d, 'package', 'MANIFEST.json'));
  assert.equal(m.gates.packageGate, 'pass');
  assert.equal(m.qa.design.pass, 2);
  assert.equal(m.files.length, 5);
  assert.equal(m.provider, 'mock');
  for (const f of m.files) assert.ok(fs.existsSync(path.join(d, 'package', f.name)), f.name);
  const cost = readJson(path.join(d, 'package', 'cost.json'));
  assert.equal(cost.mock, true);
  assert.equal(cost.totalUsd, 0);
  assert.equal(cost.rows, engine.ledger.rowsForJob(JOB_A).length);
  assert.ok(cost.rows > 0);
  assert.ok(engine.ledger.rows().every((x) => x.provider === 'mock' && x.usd === 0));
  assert.equal(engine.store.getApproval(JOB_A).status, 'pending');
  // every run recorded its exact prompt's sha256
  for (const r of engine.store.runsOf({ limit: 100 })) assert.match(r.prompt_sha256 || '', /^[0-9a-f]{64}$/);
});

test('originality: a protected name refuses the image call and blocks the job at prep with the reason', async (t) => {
  const { engine, run, jobDir } = lineEngine(t);
  const job = await run(JOB_B);
  assert.equal(job.state, 'blocked');
  assert.match(job.reason, /ORIGINALITY HARD FAIL/);
  assert.match(job.reason, /garfield/i);
  assert.equal(job.step, 'prep');
  // the refused prompt never reached the image provider: 5 images per set, 2 sets, no 00-idea.png
  assert.equal(engine.providers.image.calls, 10);
  for (const n of [1, 2]) assert.equal(fs.existsSync(path.join(jobDir(JOB_B), 'set-v' + n, 'files', '00-idea.png')), false);
  assert.equal(fs.existsSync(path.join(jobDir(JOB_B), 'package')), false);
  assert.equal(engine.store.runsOf({ agentKey: 'qa-design', limit: 10 }).length, 0);
});

test('an exhausted listing loop goes to REJECTS-DESK (owner Q4)', async (t) => {
  const revise = (ctx, params) => ({ content: [tool('kr' + ctx.pass, 'submit_verdict', { record: { stage: 'listing', listingId: ctx.jobId, pass: ctx.pass, verdict: 'revise', checks: { originality: 'pass', briefFit: 'fail' }, reasons: ['title does not match the brief'], reviewer: 'QA LISTING' } })] });
  const { engine, run, jobDir } = lineEngine(t, { wrap: (base) => async (ctx, params) => (ctx.agentKey === 'qa-listing' && ctx.purpose !== 'image_analyze' && turnOf(params) === 1 ? revise(ctx, params) : base(ctx, params)) });
  const job = await run(JOB_A);
  assert.equal(job.state, 'rejected', job.reason);
  assert.match(job.reason, /REJECTS-DESK/);
  const d = jobDir(JOB_A);
  assert.equal(readJson(path.join(d, 'qa-listing', 'pass1.json')).verdict, 'revise');
  assert.equal(readJson(path.join(d, 'qa-listing', 'pass2.json')).verdict, 'revise');
  assert.ok(fs.existsSync(path.join(d, 'REJECTED.md')));
  assert.equal(engine.store.runsOf({ agentKey: 'lister', limit: 10 }).length, 2);
  assert.equal(engine.store.runsOf({ agentKey: 'rejects-desk', limit: 10 }).length, 1);
  assert.equal(fs.existsSync(path.join(d, 'package')), false);
  assert.equal(job.loops.listing, 1);
});

test('e-stop mid-call: the call is aborted, no further provider call or ledger row, the job is stopped', async (t) => {
  const { engine, run } = lineEngine(t);
  const base = engine.providers.text;
  let at = null;
  engine.providers.text = {
    id: 'mock', get calls() { return base.calls; },
    async create(params, opts) {
      if (opts.ctx.agentKey === 'lister' && !at) { at = { calls: base.calls, images: engine.providers.image.calls, rows: engine.ledger.totals.rows }; engine.halt.press({ by: 'test', reason: 'mid-run' }); }
      return base.create(params, opts);   // the signal is aborted: the mock throws as an in-flight call would
    }
  };
  const job = await run(JOB_A);
  assert.ok(at, 'the lister call happened');
  assert.equal(job.state, 'stopped', job.reason);
  assert.match(job.reason, /e-stop/);
  assert.equal(base.calls, at.calls, 'no provider call after the press');
  assert.equal(engine.providers.image.calls, at.images);
  const after = engine.ledger.rows().slice(at.rows);
  assert.ok(after.length <= 1, 'at most the aborted call itself is charged');
  for (const x of after) { assert.equal(x.estimated, true); assert.match(x.note || '', /e-stop/); }
  assert.equal(engine.store.runsOf({ agentKey: 'qa-listing', limit: 10 }).length, 0);
  const lister = engine.store.runsOf({ agentKey: 'lister', limit: 10 });
  assert.equal(lister.length, 1); assert.equal(lister[0].status, 'stopped');
  // a halted engine refuses new work until the typed resume
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_B), by: 'test' });
  assert.ok(c.ok);
  assert.throws(() => engine.orchestrator.startJob(JOB_B), /e-stop is on/);
  assert.throws(() => engine.halt.resume({ by: 'test', confirm: 'resume please' }));
  engine.halt.resume({ by: 'test', confirm: 'RESUME' });
  assert.equal(engine.halt.isHalted(), false);
});

test('a cap refuses the first call before it is made: job blocked, nothing called, nothing charged', async (t) => {
  // a patched copy of config/ in the temp folder: priced mock and a tiny per-job cap (the real config is untouched)
  const tmp = tempRoot('caps'); t.after(tmp.cleanup);
  const dir = path.join(tmp.base, 'config'); fs.cpSync(CONFIG, dir, { recursive: true });
  const e = readJson(path.join(dir, 'engine.json'));
  e.pricing.mock.models['*'] = { inPerM: 10, outPerM: 50, perImage: 0.5, perCall: 0.1, source: 'test' };
  e.caps.perJobUsd = 0.01;
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify(e));
  const { engine, run } = lineEngine(t, { configDir: dir, tag: 'cap' });
  const job = await run(JOB_A);
  assert.equal(job.state, 'blocked');
  assert.match(job.reason, /^cap: perJob/);
  assert.equal(engine.providers.text.calls, 0);
  assert.equal(engine.providers.image.calls, 0);
  assert.equal(engine.ledger.totals.rows, 0);
  assert.equal(engine.store.runsOf({ agentKey: 'designer', limit: 5 })[0].status, 'cap');
});

test('tool jail: an agent cannot read or write outside its job folder, through .., drives, links or role limits', async (t) => {
  const bad = [
    ['fs_write', { path: '../escape.md', content: 'x' }],
    ['fs_write', { path: 'set-v1/../../escape.md', content: 'x' }],
    ['fs_write', { path: 'C:/Windows/Temp/escape.md', content: 'x' }],
    ['fs_write', { path: '/escape.md', content: 'x' }],
    ['fs_read', { path: '../../ledger/ledger.jsonl' }],
    ['fs_read', { path: 'set-v9/secret.txt' }],
    ['fs_write', { path: 'set-v9/design.md', content: 'x' }],
    ['fs_write', { path: 'outbox/listing.json', content: '{}' }],
    ['fs_write', { path: 'set-v1/files/a.png', content: 'x' }],
    ['image_generate', { path: '../a.png', prompt: 'a red circle', transparent: true }],
    ['web_fetch', { url: 'https://example.com' }],
    ['send_email', { to: 'x' }]
  ];
  let seen = null;
  const { engine, r, jobDir } = lineEngine(t, { tag: 'jail', wrap: (base) => async (ctx, params) => {
    if (ctx.agentKey !== 'designer') return base(ctx, params);
    if (turnOf(params) === 0) return { content: bad.map(([n, i], k) => tool('b' + k, n, i)) };
    if (!seen) seen = lastResults(params);
    return { content: [{ type: 'text', text: 'done' }] };
  } });
  // a junction inside the job folder that points outside the data root
  const outside = path.join(r.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const c = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'test' }); assert.ok(c.ok);
  fs.symlinkSync(outside, path.join(jobDir(JOB_A), 'set-v9'), 'junction');
  await engine.orchestrator.startJob(JOB_A);
  assert.ok(seen, 'the designer saw its tool results');
  assert.equal(seen.length, bad.length);
  seen.forEach((res, k) => assert.equal(res.is_error, true, bad[k][0] + ' ' + JSON.stringify(bad[k][1]) + ' was allowed: ' + res.content));
  assert.match(seen[5].content, /outside your folder/);
  assert.match(seen[7].content, /may not write/);
  assert.match(seen[11].content, /not available/);
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
  assert.equal(fs.existsSync(path.join(r.dataRoot, 'jobs', 'escape.md')), false);
  assert.equal(fs.existsSync(path.join(r.dataRoot, 'escape.md')), false);
  assert.equal(engine.providers.image.calls, 0);
});

test('submit_verdict: the QA record is checked before the engine writes it', (t) => {
  const r = tempRoot('verdict'); t.after(r.cleanup);
  const id = JOB_A, folder = path.join(r.dataRoot, 'jobs', id), job = { id };
  for (const n of [1, 2]) { fs.mkdirSync(path.join(folder, 'set-v' + n), { recursive: true }); fs.writeFileSync(path.join(folder, 'set-v' + n, 'deliverables.sha256'), 'sha-' + n + '\n'); }
  const good = { stage: 'design', listingId: id, verdict: 'approved', designFile: 'work/' + id + '/set-v2/deliverables.json', manifestSha256: 'sha-2', checks: { originality: 'pass' }, worthThePrice: { verdict: 'pass', reason: 'ok' }, reasons: [] };
  const v = validateVerdict(good, { kind: 'design', job, folder });
  assert.equal(v.designFile, 'jobs/' + id + '/set-v2/deliverables.json');
  const refuse = (patch, re) => assert.throws(() => validateVerdict({ ...good, ...patch }, { kind: 'design', job, folder }), re);
  refuse({ stage: 'listing' }, /stage must be "design"/);
  refuse({ listingId: 'other' }, /listingId/);
  refuse({ verdict: 'maybe' }, /verdict must be/);
  refuse({ checks: { originality: 'fail' } }, /any failed check means revise/);
  refuse({ checks: { originality: 'ok' } }, /must be "pass" or "fail"/);
  refuse({ manifestSha256: 'sha-1' }, /manifestSha256/);
  refuse({ designFile: 'work/' + id + '/set-v1/deliverables.json', manifestSha256: 'sha-1' }, /newest set/);
  refuse({ designFile: 'set-v2/design.md' }, /designFile must be the set manifest/);
  refuse({ worthThePrice: { verdict: 'pass', reason: '' } }, /worthThePrice/);
  refuse({ reasons: 'none' }, /reasons must be a list/);
  assert.throws(() => validateVerdict(null, { kind: 'design', job, folder }), /record must be an object/);
  // a revise needs no sha and no worthThePrice
  assert.equal(validateVerdict({ ...good, verdict: 'revise', manifestSha256: undefined, worthThePrice: undefined, checks: { usable: 'fail' }, reasons: ['x'] }, { kind: 'design', job, folder }).verdict, 'revise');
});

test('no agent has, or can be given, a messaging, shell or browser tool', () => {
  const cfg = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
  assert.ok(Object.keys(cfg.agents).length >= 8);
  // R1: a not-hired agent may list a planned tool (built in its phase; policy.mjs PLANNED_TOOLS), never a forbidden one, and cannot run
  for (const a of Object.values(cfg.agents)) {
    for (const n of a.tools) {
      assert.ok(TOOL_NAMES.includes(n) || (a.status === 'not-hired' && PLANNED_TOOLS.includes(n)), a.key + ' has unknown tool ' + n);
      if (n !== 'submit_verdict') assert.doesNotMatch(n, FORBIDDEN_TOOL_RE, a.key + ': ' + n);
    }
    if (a.status !== 'not-hired') assert.doesNotThrow(() => toolDefs(a.tools));
  }
  for (const n of ['send_email', 'slack_post', 'shell_exec', 'browser_click', 'notify_owner', 'mcp_call']) assert.throws(() => toolDefs([n]));
});

test('every agent prompt builds within the owner budget (and target) and carries the originality rules where required', () => {
  const cfg = loadConfig({ configDir: CONFIG, promptsDir: PROMPTS });
  const budgets = cfg.station.promptBudgetChars || {};
  // R1: a not-hired agent gets its prompt when it is hired (building.mjs refuses an active agent without one)
  for (const a of Object.values(cfg.agents).filter((x) => x.status !== 'not-hired')) {
    const files = [path.join(PROMPTS, 'agents', a.key + '.md')];
    for (const f of files) assert.ok(fs.existsSync(f), f);
  }
  return import('../src/engine/prompts.mjs').then(({ buildAgentPrompt, NEEDS_ORIGINALITY }) => {
    for (const a of Object.values(cfg.agents).filter((x) => x.status !== 'not-hired')) {
      const p = buildAgentPrompt(a, { promptsDir: PROMPTS, budgets });
      // the owner's per-agent cap and tighter target (station.config.json promptBudgetChars); agents without one keep the
      // inherited 16,000-char clamp of the legacy build
      const limit = Math.min(budgets[a.key] || 16000, (budgets.targets || {})[a.key] || 16000);
      assert.ok(p.chars <= limit, a.key + ' is ' + p.chars + ' chars, over ' + limit);
      if (NEEDS_ORIGINALITY.includes(a.key)) assert.ok(p.skills.includes('originality-rules'), a.key);
      assert.match(p.sha256, /^[0-9a-f]{64}$/);
    }
  });
});
