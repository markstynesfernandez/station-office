// output-contract.test.mjs — E6 b1 on the mock provider: the output contract (an agent that ends its turn with required
// outputs missing is nudged, at most twice, with tool_choice any and exactly fs_write or report_blocked on offer (E6 b2); still missing -> the job ends
// incomplete; a partial set of drafts continues with the shortfall recorded) and the job transcripts
// (data/jobs/<id>/transcript.jsonl, every line key-redacted, never in logs/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { MAX_NUDGES } from '../src/engine/runtime.mjs';
import { scoutRunExitCode } from '../src/engine/lib/scouting.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { createScoutScript } from '../fixtures/engine/scout-script.mjs';

const DRAFTS_TURN = 5;   // the fixture scout's turn that writes the genre drafts (products, searches, fetches, one more search, notes)
const NUDGE = /^\[STATION: required outputs missing/;
const FAKE_KEY = 'sk-ant-api03-FAKEKEYfakekeyFAKEKEY0123456789';
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const nudged = (params) => { const l = params.messages[params.messages.length - 1]; return l.role === 'user' && typeof l.content === 'string' && NUDGE.test(l.content); };

// the fixture scout, except at the drafts turn: `skip` (end the turn with text instead), or `keep` (write only the first n drafts);
// a nudged turn gets the fixture's drafts (`obey`) or text again
function scripted({ skip = true, obey = true, keep = null, replyText = 'done for today' } = {}) {
  const base = createScoutScript({ bad: false });
  const calls = { 'trend-scout': 0, 'evidence-checker': 0 }, toolChoices = [];
  const script = (ctx, params) => {
    calls[ctx.agentKey] = (calls[ctx.agentKey] || 0) + 1;
    if (ctx.agentKey !== 'trend-scout') return base(ctx, params);
    if (params.tool_choice) toolChoices.push(params.tool_choice);
    const atDrafts = (p) => base(ctx, { ...p, messages: p.messages.slice(0, 1 + 2 * DRAFTS_TURN) });
    if (nudged(params)) return obey ? atDrafts(params) : { content: [{ type: 'text', text: replyText }] };
    if (turnOf(params) === DRAFTS_TURN) {
      if (keep != null) { const r = atDrafts(params); return { content: r.content.slice(0, keep) }; }
      if (skip) return { content: [{ type: 'text', text: replyText }] };
    }
    return base(ctx, params);
  };
  script.web = base.web;
  return { script, calls, toolChoices };
}
function boot(t, script) {
  const r = tempRoot('contract');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r };
}
async function scout(e) {
  const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' });
  await e.orchestrator.startJob(c.id);
  return e.store.getJob(c.id);
}
const transcriptOf = (e, job) => fs.readFileSync(path.join(e.J.dataRoot, 'jobs', job.id, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean);

test('(a) the scout ends its turn with no drafts -> one nudge (tool_choice any; fs_write or report_blocked) -> it writes them -> the job completes', async (t) => {
  const s = scripted({ skip: true, obey: true });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.equal(scoutRunExitCode(job), 0);
  // E6 b2 (owner D2): the nudge offers exactly fs_write or report_blocked (tool_choice any; the engine refuses any other tool)
  assert.deepEqual(s.toolChoices, [{ type: 'any' }]);
  assert.equal(fs.readdirSync(path.join(e.J.dataRoot, 'research', 'briefs')).length, 4);
  const lines = transcriptOf(e, job).map((l) => JSON.parse(l));
  const n = lines.filter((l) => l.nudge);
  assert.equal(n.length, 1);
  assert.match(n[0].message, /4 of 4 genre drafts \(scout-drafts\/\d{4}-\d{2}-\d{2}\/<id>\.md\)/);
  assert.match(n[0].message, /call fs_write \(one call per missing file\) if you can produce them with evidence, or call report_blocked with the reason you cannot/);
  assert.deepEqual(n[0].offered, ['fs_write', 'report_blocked']);
  assert.equal(lines.filter((l) => l.afterNudge === 1 && l.toolCalls.filter((c) => c.name === 'fs_write').length === 4).length, 1);
  // the nudge is one more model call through the guard: every scout turn has a ledger row
  const runs = e.store.runsOf({ agentKey: 'trend-scout', limit: 5 });
  assert.equal(e.ledger.rows().filter((r) => r.agentKey === 'trend-scout' && r.kind === 'text').length, runs[0].turns);
});

test('(b) the scout ignores both nudges -> the job ends incomplete ("missing outputs: ..."), exit 1, no downstream calls, never "done" on the page', async (t) => {
  const s = scripted({ skip: true, obey: false });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'incomplete');
  assert.match(job.reason, /^missing outputs: 4 of 4 genre drafts/);
  assert.equal(scoutRunExitCode(job), 1);
  assert.equal(s.toolChoices.length, MAX_NUDGES);
  assert.equal(s.calls['evidence-checker'], 0, 'EVIDENCE-CHECKER must not be called');
  assert.equal(job.step, 'trend-scout');
  assert.ok(!(job.data.scouting), 'scout-notes did not run');
  const snap = buildEngineSnapshot(e).jobs.find((j) => j.id === job.id);
  assert.equal(snap.status, 'incomplete'); assert.equal(snap.lane, 'blocked'); assert.notEqual(snap.status, 'done');
  const runs = e.store.runsOf({ agentKey: 'trend-scout', limit: 1 });
  assert.equal(runs[0].status, 'incomplete');
});

test('(c) a partial set of drafts (2 of 4) -> nudged twice, then the line continues with the shortfall recorded', async (t) => {
  const s = scripted({ keep: 2, obey: false });
  const { e } = boot(t, s.script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.equal(s.toolChoices.length, MAX_NUDGES);
  assert.equal(job.data.shortfalls.length, 1);
  assert.deepEqual({ ...job.data.shortfalls[0], missing: undefined }, { step: 'trend-scout', agent: 'trend-scout', have: 2, want: 4, missing: undefined });
  assert.ok(s.calls['evidence-checker'] > 0);
  assert.equal(fs.readdirSync(path.join(e.J.dataRoot, 'research', 'briefs')).length, 2);
});

test('(d) every transcript line is key-redacted and the transcript stays inside data/ (never logs/)', async (t) => {
  const s = scripted({ skip: true, obey: true, replyText: 'notes written; key ' + FAKE_KEY + ' x-api-key: ' + FAKE_KEY });
  const { e, r } = boot(t, s.script);
  const job = await scout(e);
  const file = path.join(e.J.dataRoot, 'jobs', job.id, 'transcript.jsonl');
  assert.ok(fs.existsSync(file));
  assert.ok(path.relative(e.J.dataRoot, file).split(path.sep)[0] === 'jobs');
  const lines = transcriptOf(e, job);
  assert.ok(lines.length >= 8);
  for (const l of lines) { assert.doesNotMatch(l, /sk-ant-/); assert.ok(!l.includes(FAKE_KEY)); JSON.parse(l); }
  assert.ok(lines.some((l) => l.includes('<redacted>')));
  for (const l of lines.map((x) => JSON.parse(x)).filter((x) => x.toolResults)) for (const tr of l.toolResults) assert.ok(tr.content.length <= 2000);
  const logs = fs.existsSync(r.logs) ? fs.readdirSync(r.logs) : [];
  assert.ok(!logs.some((f) => /transcript/.test(f)));
  for (const f of logs) assert.ok(!fs.readFileSync(path.join(r.logs, f), 'utf8').includes(FAKE_KEY));
  const agentKeys = new Set(lines.map((x) => JSON.parse(x).agent));
  assert.deepEqual([...agentKeys].sort(), ['evidence-checker', 'trend-scout']);
});
