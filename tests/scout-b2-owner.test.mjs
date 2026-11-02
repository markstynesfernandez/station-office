// scout-b2-owner.test.mjs — the owner's decisions after E6 b2a (17/10/2026; DECISIONS.md "E6 step b2: owner decisions,
// part 2"), on the MOCK provider:
//   2 the approval card shows the brief's evidence level ("indicative") prominently
//   3 report_blocked after a partial set: >= 1 valid draft -> the shortfall and its reason are recorded and the line
//     continues; 0 drafts -> incomplete, exit 1 (tests/scout-b2.test.mjs)
//   4 refused short names (under 3 characters) go to an internal owner-review list, never onto the blocklist
//   5 transcript retention follows the briefs: a transcript cited by an open brief is never deleted
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createToolbox } from '../src/engine/tools/index.mjs';
import { addToBlocklist, readBlocklist, readShortNames, shortNamesFile, scoutRunExitCode } from '../src/engine/lib/scouting.mjs';
import { cleanupTranscripts, RetentionRefusal, TRANSCRIPT_KEEP_DAYS } from '../src/engine/lib/transcript-retention.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { evidenceBanner } from '../src/web/ui/evidence.js';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { createScoutScript, FIXTURE_GAMES } from '../fixtures/engine/scout-script.mjs';

const DRAFTS_TURN = 5;
const DAY_MS = 86400000;
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
function boot(t, script = createScoutScript({ bad: false })) {
  const r = tempRoot('b2o');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} r.cleanup(); });
  return { e, r };
}
async function scout(e) { const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' }); await e.orchestrator.startJob(c.id); return e.store.getJob(c.id); }
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);

test('decision 3: 2 valid drafts then report_blocked -> the shortfall and its reason are recorded, the line continues with the 2 drafts (exit 0, no nudge)', async (t) => {
  const reason = 'only two genres had desk-props search results with prices';
  const base = createScoutScript({ bad: false }), calls = { 'trend-scout': 0, 'evidence-checker': 0 }, choices = [];
  const script = (ctx, params) => {
    calls[ctx.agentKey] = (calls[ctx.agentKey] || 0) + 1;
    if (ctx.agentKey === 'trend-scout' && params.tool_choice) choices.push(params.tool_choice);
    if (ctx.agentKey === 'trend-scout' && turnOf(params) === DRAFTS_TURN) {
      const drafts = base(ctx, params).content.slice(0, 2);
      return { content: [...drafts, { type: 'tool_use', id: 'tu_rb', name: 'report_blocked', input: { reason } }] };
    }
    if (ctx.agentKey === 'trend-scout' && turnOf(params) > DRAFTS_TURN) return { content: [{ type: 'text', text: 'must not be called' }] };
    return base(ctx, params);
  };
  script.web = base.web;
  const { e } = boot(t, script);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.equal(scoutRunExitCode(job), 0);
  assert.equal(job.data.shortfalls.length, 1);
  const sf = job.data.shortfalls[0];
  assert.deepEqual({ step: sf.step, agent: sf.agent, have: sf.have, want: sf.want, reason: sf.reason }, { step: 'trend-scout', agent: 'trend-scout', have: 2, want: 4, reason });
  assert.ok(!job.data.reportedBlocked, 'not an incomplete job');
  assert.deepEqual(choices, [], 'no nudge'); assert.equal(calls['trend-scout'], DRAFTS_TURN + 1, 'no model call after report_blocked');
  assert.ok(calls['evidence-checker'] > 0, 'the line continued');
  assert.equal(fs.readdirSync(research(e, 'briefs')).length, 2);
  const stage = e.store.stagesOf(job.id).find((s) => s.step === 'trend-scout');
  assert.match(JSON.stringify(stage), /TREND-SCOUT shortfall: 2 of 4 outputs \(reported blocked: only two genres had desk-props search results with prices\)/);
});

test('decision 4: a refused short name goes to the internal owner-review list, never onto the blocklist; no duplicates; not readable by other agents', async (t) => {
  const r = tempRoot('b2o-short'); t.after(() => r.cleanup());
  const rdir = path.join(r.J.dataRoot, 'research'); fs.mkdirSync(rdir, { recursive: true });
  const terms = [{ term: 'Ib', kind: 'game' }, { term: 'TBD', kind: 'studio' }, { term: 'Real Studio', kind: 'studio' }];
  addToBlocklist(r.J, rdir, terms, { day: '2026-10-17', jobId: 'j1' });
  addToBlocklist(r.J, rdir, terms, { day: '2026-10-18', jobId: 'j2' });
  assert.deepEqual(readBlocklist(rdir).terms.map((x) => x.term), ['Real Studio']);
  assert.deepEqual(readShortNames(rdir).entries, [{ term: 'Ib', kind: 'game', day: '2026-10-17', jobId: 'j1' }], 'only the short name, once (TBD is a placeholder, not a short name)');
  assert.ok(shortNamesFile(rdir).split(path.sep).includes('scouting'), 'inside scouting/ (internal)');
  // in a scout run: a 2-letter related name in the notes lands on the review list; EVIDENCE-CHECKER cannot read it
  const games = FIXTURE_GAMES.map((g, i) => (i === 0 ? { ...g, alsoBlock: [...g.alsoBlock, 'Ox'] } : g));
  const { e } = boot(t, createScoutScript({ bad: false, games }));
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.ok(job.data.scouting.refusedNotNames.some((x) => x.kind === 'related' && x.reason === 'under 3 characters'));
  assert.ok(readShortNames(research(e)).entries.some((x) => x.term === 'Ox' && x.jobId === job.id));
  assert.ok(!readBlocklist(research(e)).terms.some((x) => x.term === 'Ox'));
  const box = createToolbox({ J: e.J, folder: research(e), agent: e.cfg.agents['evidence-checker'], job: { id: job.id }, cfg: { ...e.cfg }, guard: e.guard, providers: e.providers, run: { runId: 'r' }, halt: e.halt, log: e.log, bus: e.bus, line: 'genre-scout' });
  await assert.rejects(box.call('fs_read', { path: 'scouting/short-names-review.json' }), /internal to TREND-SCOUT/);
});

test('decision 5: a transcript cited by an open brief is never deleted; once every citing brief is closed it may go after 90 days', async (t) => {
  const { e } = boot(t);
  const sj = await scout(e);
  assert.equal(sj.state, 'research-done', sj.reason);
  const tfile = path.join(e.J.dataRoot, 'jobs', sj.id, 'transcript.jsonl');
  const briefs = fs.readdirSync(research(e, 'briefs')).sort();
  assert.equal(briefs.length, 4);
  // 4 verified briefs not yet taken in: open. An explicit cleanup of this transcript is refused; a sweep keeps it
  assert.throws(() => cleanupTranscripts({ J: e.J, store: e.store, only: sj.id, apply: true }), (x) => x instanceof RetentionRefusal && /cited by 4 open brief\(s\)/.test(x.message));
  let r = cleanupTranscripts({ J: e.J, store: e.store, apply: true, now: Date.now() + 400 * DAY_MS }).find((x) => x.jobId === sj.id);
  assert.equal(r.decision, 'keep'); assert.ok(fs.existsSync(tfile));
  // one brief becomes a job (queued: still open); the other three are rejected (closed)
  const first = briefs[0], ok = e.orchestrator.createJob({ briefText: fs.readFileSync(research(e, 'briefs', first), 'utf8'), by: 'test' });
  assert.equal(ok.ok, true, (ok.reasons || []).join('; '));
  fs.mkdirSync(research(e, 'rejected'), { recursive: true });
  for (const f of briefs.slice(1)) fs.renameSync(research(e, 'briefs', f), research(e, 'rejected', f));
  r = cleanupTranscripts({ J: e.J, store: e.store, apply: true, now: Date.now() + 400 * DAY_MS }).find((x) => x.jobId === sj.id);
  assert.equal(r.decision, 'keep'); assert.match(r.reason, /cited by 1 open brief\(s\): \S+ \(queued\)/); assert.ok(fs.existsSync(tfile));
  assert.throws(() => cleanupTranscripts({ J: e.J, store: e.store, only: sj.id }), RetentionRefusal);
  // the job is archived: every citing brief is closed; within 90 days it is kept, after that it may go
  const id = first.replace(/\.md$/, ''), at = Date.now();
  e.store.updateJob(id, { state: 'archived', ended_at: at, data: { archivedAt: at } });
  r = cleanupTranscripts({ J: e.J, store: e.store, apply: true, now: at + 10 * DAY_MS }).find((x) => x.jobId === sj.id);
  assert.equal(r.decision, 'keep'); assert.match(r.reason, /all briefs closed; 10 of 90 days/); assert.ok(fs.existsSync(tfile));
  r = cleanupTranscripts({ J: e.J, store: e.store, apply: true, now: at + (TRANSCRIPT_KEEP_DAYS + 1) * DAY_MS }).find((x) => x.jobId === sj.id);
  assert.equal(r.decision, 'delete'); assert.equal(r.citedBy.length, 4); assert.ok(!fs.existsSync(tfile), 'deleted after 90 days');
});

test('decision 2: the approval card shows the brief\'s evidence level; "indicative" prominently', async (t) => {
  const { e } = boot(t);
  await scout(e);
  const f = fs.readdirSync(research(e, 'briefs'))[0];
  const c = e.orchestrator.createJob({ briefText: fs.readFileSync(research(e, 'briefs', f), 'utf8'), by: 'test' });
  assert.equal(c.ok, true, (c.reasons || []).join('; '));
  const snap = buildEngineSnapshot(e).jobs.find((j) => j.id === c.id);
  assert.equal(snap.evidenceLevel, 'indicative');
  const html = evidenceBanner(snap.evidenceLevel);
  assert.match(html, /class="evidence-banner evidence-indicative"/); assert.match(html, /<strong>Evidence: INDICATIVE<\/strong>/); assert.match(html, /competitor count not measured/);
  assert.equal(evidenceBanner(null), '');
  // the panel puts it in the approval box, under its heading, above the decision buttons
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'ui', 'sidepanel.js'), 'utf8');
  assert.match(src, /Approval queue · your decision<\/div>' \+ evidenceBanner\(j\.evidenceLevel, \{ ownerSetsPrice: j\.ownerSetsPrice === true \}\) \+ '<div class="btnrow">/);
  // E7a (owner, 19/10/2026): non-Etsy evidence, and "owner sets price" when no cited result showed a price
  assert.match(html, /non-Etsy web search results only/); assert.match(html, /no Etsy data/); assert.doesNotMatch(html, /OWNER SETS PRICE/);
  assert.equal(snap.ownerSetsPrice, false);
  assert.match(evidenceBanner('indicative', { ownerSetsPrice: true }), /<strong>Price: OWNER SETS PRICE<\/strong>/);
  assert.match(fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'styles.css'), 'utf8'), /\.evidence-indicative \{/);
});
