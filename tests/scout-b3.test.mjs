// scout-b3.test.mjs — E6 step b3 (owner, 17/10/2026; DECISIONS.md "E6 step b3"), on the MOCK provider with the FIXTURE
// scouting data (invented names only):
//   1 the names in a scout job's notes go on the blocklist whenever the job ends, whatever the outcome (done, research-done,
//     incomplete, report_blocked, failed, cap hit, E-STOP, the owner's Stop, crash on restart recovery), once per job,
//     idempotent, through the name-like filter
//   2 the owner's backfill moves a pre-b3 shared notes file into the job that wrote it (from the transcripts) and passes
//     every notes file in data/ through the same step
//   3 notes are never overwritten: one file per job (scouting/<day>/<jobId>/notes.json), readers read every job's
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, until } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createToolbox } from '../src/engine/tools/index.mjs';
import { CapError } from '../src/engine/guard.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { readBlocklist, readShortNames, readDayNotes, notesFile, legacyNotesFile, backfillScouting, REPLACED_NOTES_RE } from '../src/engine/lib/scouting.mjs';
import { createScoutScript, FIXTURE_GAMES } from '../fixtures/engine/scout-script.mjs';

const NOTES_TURN = 4, DRAFTS_TURN = 5;   // the FIXTURE scout writes its notes on turn 4 and its drafts on turn 5
const turnOf = (params) => params.messages.filter((m) => m.role === 'assistant').length;
const namesOf = (games) => games.flatMap((g) => [g.game, g.studio, ...g.alsoBlock]);
const ALL = namesOf(FIXTURE_GAMES);
// a second, different set of INVENTED titles (an earlier attempt, another job on the same day)
const OTHER_GAMES = [
  { game: 'Hollowmere Saga', studio: 'Brindle Forge', kind: 'aaa', genre: 'misty gothic', alsoBlock: ['Lady Corvane'] },
  { game: 'Starwake Drift', studio: 'Quillon Labs', kind: 'aaa', genre: 'retro space', alsoBlock: [] },
  { game: 'Mossbottom Inn', studio: 'Pebblecart', kind: 'indie', genre: 'cosy tavern', alsoBlock: [] },
  { game: 'Gloamroot', studio: 'Two Lantern Folk', kind: 'indie', genre: 'forest survival', alsoBlock: [] }
];
const notesJson = (day, games) => JSON.stringify({ day, entries: games.map((g) => ({ ...g, tags: [], evidence: [{ url: 'https://trends.example.com/fixture', signal: 'FIXTURE' }], date: day })) }, null, 1);

function boot(t, script = createScoutScript({ bad: false }), root = null) {
  const r = root || tempRoot('b3');
  const e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script, startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} if (!root) r.cleanup(); });
  return { e, r };
}
async function scout(e) { const c = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' }); await e.orchestrator.startJob(c.id); return e.store.getJob(c.id); }
const research = (e, ...p) => path.join(e.J.dataRoot, 'research', ...p);
const listed = (e) => new Set(readBlocklist(research(e)).terms.map((x) => x.term.toLowerCase()));
const missing = (e, names = ALL) => { const have = listed(e); return names.filter((n) => !have.has(n.toLowerCase())); };
// the FIXTURE scout up to its notes, then `after` from the drafts turn on (the outcome under test)
function scoutThen(after) {
  const base = createScoutScript({ bad: false });
  const script = (ctx, params) => (ctx.agentKey === 'trend-scout' && turnOf(params) >= DRAFTS_TURN ? after(ctx, params) : base(ctx, params));
  script.web = base.web;
  return script;
}
const passLines = (r, id) => fs.readdirSync(r.logs).map((f) => fs.readFileSync(path.join(r.logs, f), 'utf8')).join('\n').split('\n').filter((l) => l.includes('scouting blocklist pass') && l.includes(id));
function endedWithNames(e, r, job, { state, reason }) {
  assert.equal(job.state, state, job.reason);
  if (reason) assert.match(job.reason, reason);
  assert.ok(fs.existsSync(notesFile(research(e), job.data.day, job.id)), 'the job wrote its notes');
  assert.deepEqual(missing(e), [], 'every name in the notes is on the blocklist');
  assert.match(job.data.scoutBlocklist.when, new RegExp('^job end \\(' + state + '\\)$'), 'added when the job ended');
  assert.equal(job.data.scoutBlocklist.added, ALL.length);
  assert.equal(passLines(r, job.id).length, 1, 'one pass for the job');
  assert.ok(!JSON.stringify(job).toLowerCase().includes(FIXTURE_GAMES[0].game.toLowerCase()), 'the job record carries no name');
}

// ---- 1. names are added on every outcome
test('outcome done: TREND-SCOUT finishes normally but its notes fail validation (scout-notes blocks) -> its names are still added', async (t) => {
  const { e, r } = boot(t, createScoutScript({ bad: false, games: FIXTURE_GAMES.slice(0, 3) }));
  const job = await scout(e);
  assert.equal(e.store.stagesOf(job.id).find((s) => s.step === 'trend-scout').status, 'done');
  assert.equal(job.state, 'blocked'); assert.match(job.reason, /scouting notes refused: needs exactly 2 indie entries/);
  assert.deepEqual(missing(e, namesOf(FIXTURE_GAMES.slice(0, 3))), [], 'fail closed: names from notes that failed validation');
  assert.match(job.data.scoutBlocklist.when, /^job end \(blocked\)$/);
  assert.equal(job.data.scoutBlocklist.notesProblems, 1);
  assert.equal(passLines(r, job.id).length, 1);
});

test('outcome research-done: added at scout-notes (before the screen), and the job end does not pass the same notes again', async (t) => {
  const { e, r } = boot(t);
  const job = await scout(e);
  assert.equal(job.state, 'research-done', job.reason);
  assert.deepEqual(missing(e), []);
  assert.equal(job.data.scoutBlocklist.when, 'scout-notes');
  assert.equal(job.data.scoutBlocklist.added, ALL.length);
  assert.equal(job.data.scouting.added, ALL.length);
  assert.equal(passLines(r, job.id).length, 1, 'once per job');
});

test('outcome incomplete: notes written, then neither drafts nor report_blocked after both nudges -> names added', async (t) => {
  const { e, r } = boot(t, scoutThen(() => ({ content: [{ type: 'text', text: 'done with the notes' }] })));
  endedWithNames(e, r, await scout(e), { state: 'incomplete', reason: /missing outputs/ });
});

test('outcome report_blocked (the rerun 4 case): notes written, then report_blocked -> names added', async (t) => {
  const reason = 'Demand evidence fails the brief floor: every search result is priced below it.';
  const { e, r } = boot(t, scoutThen(() => ({ content: [{ type: 'tool_use', id: 'tu_rb', name: 'report_blocked', input: { reason } }] })));
  const job = await scout(e);
  endedWithNames(e, r, job, { state: 'incomplete', reason: /TREND-SCOUT reported blocked/ });
  assert.equal(job.data.reportedBlocked.reason, reason);
  assert.ok(!e.store.stagesOf(job.id).some((s) => s.step === 'scout-notes'), 'scout-notes never ran');
});

test('outcome failed: the provider fails after the notes -> names added', async (t) => {
  const { e, r } = boot(t, scoutThen(() => { throw new Error('FIXTURE provider failure'); }));
  endedWithNames(e, r, await scout(e), { state: 'blocked', reason: /TREND-SCOUT run failed: FIXTURE provider failure/ });
});

test('outcome cap hit: the guard refuses the next call after the notes -> names added', async (t) => {
  const { e, r } = boot(t);
  const reserve = e.guard.reserve;
  e.guard.reserve = (call) => {
    const j = call.jobId && e.store.getJob(call.jobId);
    if (j && fs.existsSync(notesFile(research(e), j.data.day, j.id))) throw new CapError({ cap: 'perJob[genre-scout]', limit: 0.5, spent: 0.5, next: 0.01 });
    return reserve(call);
  };
  const job = await scout(e);
  endedWithNames(e, r, job, { state: 'blocked', reason: /^cap: perJob\[genre-scout\]/ });
  assert.equal(e.store.runsOf({ agentKey: 'trend-scout', limit: 1 })[0].status, 'cap');
});

test('outcome E-STOP: pressed after the notes -> the job stops and its names are added', async (t) => {
  let eng = null;
  const { e, r } = boot(t, scoutThen(() => { eng.halt.press({ by: 'test', reason: 'b3 test' }); return { content: [{ type: 'text', text: 'pressed' }] }; }));
  eng = e;
  const job = await scout(e);
  endedWithNames(e, r, job, { state: 'stopped', reason: /e-stop/ });
  assert.ok(e.halt.isHalted());
});

test('outcome the owner\'s Stop: stopped mid-run after the notes -> names added', async (t) => {
  let eng = null;
  const { e, r } = boot(t, scoutThen((ctx) => { const j = eng.store.getJob(ctx.jobId); eng.orchestrator.stopJob(j.id, { expectedVersion: j.version, by: 'test' }); return { content: [{ type: 'text', text: 'stopping' }] }; }));
  eng = e;
  endedWithNames(e, r, await scout(e), { state: 'stopped', reason: /stopped by the owner/ });
});

test('outcome crash on restart recovery: a job interrupted again after its notes is blocked at engine start -> names added', async (t) => {
  const r = tempRoot('b3-recover'); t.after(() => r.cleanup());
  let e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript({ bad: false }), startScheduler: false });
  const id = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' }).id, day = e.store.getJob(id).data.day;
  e.J.put(notesFile(research(e), day, id), notesJson(day, FIXTURE_GAMES));
  e.store.updateJob(id, { state: 'running', step: 'trend-scout', resumes: 1 });   // its one resume already used
  e.close();
  e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript({ bad: false }), startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} });
  const job = e.store.getJob(id);
  assert.equal(job.state, 'blocked'); assert.match(job.reason, /restart it by hand/);
  assert.deepEqual(missing(e), []);
  assert.equal(job.data.scoutBlocklist.when, 'job end (blocked)');
});

test('restart recovery that resumes: the earlier attempt\'s notes are passed first and moved aside, never overwritten', async (t) => {
  const r = tempRoot('b3-resume'); t.after(() => r.cleanup());
  let e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript({ bad: false }), startScheduler: false });
  const id = e.orchestrator.createResearchJob({ line: 'genre-scout', by: 'test' }).id, day = e.store.getJob(id).data.day;
  const earlier = notesJson(day, OTHER_GAMES);
  e.J.put(notesFile(research(e), day, id), earlier);
  e.store.updateJob(id, { state: 'running', step: 'trend-scout' });   // interrupted mid-step, resumes once
  e.close();
  e = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: createScoutScript({ bad: false }), startScheduler: false });
  t.after(() => { try { e.close(); } catch (_) {} });
  const job = await until(() => { const j = e.store.getJob(id); return ['research-done', 'blocked', 'incomplete', 'stopped'].includes(j.state) && !e.orchestrator.isActive(id) ? j : null; });
  assert.equal(job.state, 'research-done', job.reason);
  assert.deepEqual(missing(e, [...namesOf(OTHER_GAMES), ...ALL]), [], 'both attempts\' names');
  const dir = path.dirname(notesFile(research(e), day, id)), aside = fs.readdirSync(dir).filter((f) => REPLACED_NOTES_RE.test(f));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), earlier, 'the earlier attempt\'s notes kept byte for byte');
  assert.deepEqual(readDayNotes(research(e), day).map((n) => path.basename(n.file)).sort(), ['notes.json', aside[0]].sort(), 'readers see both');
});

// ---- idempotent
test('idempotent: the job-end pass again and the backfill over the same data add nothing and rewrite nothing', async (t) => {
  const { e } = boot(t, scoutThen(() => ({ content: [{ type: 'tool_use', id: 'tu_rb', name: 'report_blocked', input: { reason: 'FIXTURE: no evidence for any draft' } }] })));
  const job = await scout(e), bl = path.join(research(e), 'scouting', 'blocklist.json'), bytes = fs.readFileSync(bl);
  const again = e.orchestrator.blocklistOnEnd(job.id);
  assert.equal(again.notesSha256, job.data.scoutBlocklist.notesSha256, 'the marker: same notes, no second pass');
  assert.equal(e.store.getJob(job.id).data.scoutBlocklist.at, job.data.scoutBlocklist.at);
  const b = backfillScouting(e.J, research(e), { jobsDir: path.join(e.J.dataRoot, 'jobs'), apply: true });
  assert.equal(b.added, 0); assert.deepEqual(b.migrated, []);
  assert.deepEqual(fs.readFileSync(bl), bytes, 'blocklist byte for byte unchanged');
});

test('the name-like filter still applies: placeholders refused, short names to the review list, on a job that ends incomplete', async (t) => {
  const games = FIXTURE_GAMES.map((g, i) => (i === 0 ? { ...g, studio: 'UNKNOWN — needs owner check', alsoBlock: [...g.alsoBlock, 'Ox'] } : g));
  const base = createScoutScript({ bad: false, games });
  const script = (ctx, params) => (ctx.agentKey === 'trend-scout' && turnOf(params) >= DRAFTS_TURN ? { content: [{ type: 'tool_use', id: 'tu_rb', name: 'report_blocked', input: { reason: 'FIXTURE: no evidence for any draft' } }] } : base(ctx, params));
  script.web = base.web;
  const { e } = boot(t, script);
  const job = await scout(e);
  assert.equal(job.state, 'incomplete');
  const terms = readBlocklist(research(e)).terms.map((x) => x.term);
  assert.ok(!terms.some((x) => /unknown/i.test(x)), 'placeholder refused');
  assert.ok(!terms.includes('Ox'));
  assert.ok(readShortNames(research(e)).entries.some((x) => x.term === 'Ox' && x.jobId === job.id), 'short name on the review list');
  assert.deepEqual(job.data.scoutBlocklist.refused.map((x) => x.reason).sort(), ['a placeholder, not a name', 'under 3 characters']);
});

// ---- 3. notes never overwritten
test('two jobs on the same day keep separate notes; scout-notes reads both; a job cannot write another job\'s notes or the day file', async (t) => {
  // the first job of the day scouts OTHER_GAMES, the second the FIXTURE games
  const first = createScoutScript({ bad: false, games: OTHER_GAMES }), later = createScoutScript({ bad: false }), order = [];
  const script = (ctx, params) => { if (ctx.jobId && !order.includes(ctx.jobId)) order.push(ctx.jobId); return (ctx.jobId === order[0] ? first : later)(ctx, params); };
  script.web = first.web;
  const { e } = boot(t, script), e2 = e;
  const j1 = await scout(e);
  assert.equal(j1.state, 'research-done', j1.reason);
  const day = j1.data.day, f1 = notesFile(research(e), day, j1.id), before = fs.readFileSync(f1, 'utf8');
  // the FIXTURE drafts carry fixed names: clear the first run's, so the second run's drafts count as new (its contract)
  fs.rmSync(research(e, 'scout-drafts', day), { recursive: true, force: true });
  const j2 = await scout(e);
  assert.equal(j2.state, 'research-done', j2.reason);
  assert.notEqual(j1.id, j2.id); assert.equal(j2.data.day, day);
  const f2 = notesFile(research(e2), day, j2.id);
  assert.equal(fs.readFileSync(f1, 'utf8'), before, 'the first job\'s notes untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(f2, 'utf8')).entries.map((x) => x.game), FIXTURE_GAMES.map((g) => g.game));
  assert.ok(!fs.existsSync(legacyNotesFile(research(e2), day)), 'no shared day file');
  assert.deepEqual(readDayNotes(research(e2), day).map((n) => n.jobId), [j1.id, j2.id].sort(), 'readers see both jobs');
  assert.equal(j2.data.scouting.otherNotesToday, 1, 'scout-notes read the other job\'s notes too');
  assert.deepEqual(missing(e2, [...namesOf(OTHER_GAMES), ...ALL]), []);
  // the tool: TREND-SCOUT may write only its own job's notes file
  const box = createToolbox({ J: e2.J, folder: research(e2), agent: e2.cfg.agents['trend-scout'], job: j2, cfg: { ...e2.cfg }, guard: e2.guard, providers: e2.providers, run: { runId: 'r' }, halt: e2.halt, log: e2.log, bus: e2.bus, line: 'genre-scout' });
  await assert.rejects(box.call('fs_write', { path: 'scouting/' + day + '/' + j1.id + '/notes.json', content: '{}' }), /this job's own file only/);
  await assert.rejects(box.call('fs_write', { path: 'scouting/' + day + '/notes.json', content: '{}' }), /may not write scouting\/.*notes\.json/, 'the pre-b3 day file: outside the role\'s writes');
  assert.equal(fs.readFileSync(f1, 'utf8'), before);
});

// ---- 2. the backfill
test('backfill: the pre-b3 shared notes file moves into the job that last wrote it (from the transcripts) and its names are added; report only writes nothing', async (t) => {
  const r = tempRoot('b3-backfill'); t.after(() => r.cleanup());
  const J = r.J, rdir = path.join(J.dataRoot, 'research'), jobs = path.join(J.dataRoot, 'jobs'), day = '2026-10-17';
  const early = notesJson(day, OTHER_GAMES), late = notesJson(day, FIXTURE_GAMES);
  // the earlier runs' names are already listed (run 1); run 2 wrote the day file first, run 4 overwrote it
  J.put(path.join(rdir, 'scouting', 'blocklist.json'), JSON.stringify({ terms: namesOf(OTHER_GAMES).map((term) => ({ term, kind: 'game', day, jobId: day + '--genre-scout-1' })) }) + '\n');
  const tline = (at, content) => JSON.stringify({ at, agent: 'trend-scout', toolCalls: [{ name: 'fs_write', input: { path: 'scouting/' + day + '/notes.json', content } }] }) + '\n';
  J.put(path.join(jobs, day + '--genre-scout-2', 'transcript.jsonl'), tline('2026-10-17T12:00:00.000Z', early));
  J.put(path.join(jobs, day + '--genre-scout-4', 'transcript.jsonl'), tline('2026-10-17T16:20:03.000Z', late));
  J.put(legacyNotesFile(rdir, day), late);
  const bl = path.join(rdir, 'scouting', 'blocklist.json'), blBefore = fs.readFileSync(bl);

  const dry = backfillScouting(J, rdir, { jobsDir: jobs });
  assert.deepEqual(dry.migrated, [{ from: 'scouting/' + day + '/notes.json', to: 'scouting/' + day + '/' + day + '--genre-scout-4/notes.json', jobId: day + '--genre-scout-4' }]);
  assert.deepEqual(dry.files.flatMap((f) => f.added.map((a) => a.term)).sort(), ALL.slice().sort(), 'report: run 4\'s names');
  assert.ok(fs.existsSync(legacyNotesFile(rdir, day)), 'report only: not moved');
  assert.deepEqual(fs.readFileSync(bl), blBefore, 'report only: blocklist unchanged');

  const run = backfillScouting(J, rdir, { jobsDir: jobs, apply: true });
  assert.deepEqual(run.migrated, dry.migrated);
  assert.ok(!fs.existsSync(legacyNotesFile(rdir, day)));
  assert.equal(fs.readFileSync(notesFile(rdir, day, day + '--genre-scout-4'), 'utf8'), late, 'moved byte for byte');
  assert.equal(run.added, ALL.length);
  const terms = readBlocklist(rdir).terms;
  for (const n of ALL) assert.equal(terms.find((x) => x.term === n).jobId, day + '--genre-scout-4', n + ' credited to run 4');
  assert.equal(terms.length, namesOf(OTHER_GAMES).length + ALL.length);

  const again = backfillScouting(J, rdir, { jobsDir: jobs, apply: true });
  assert.deepEqual([again.migrated.length, again.added], [0, 0], 'idempotent');
});

test('backfill: a day file no transcript wrote as it stands is left in place and reported, never guessed; its names are still passed', async (t) => {
  const r = tempRoot('b3-backfill2'); t.after(() => r.cleanup());
  const J = r.J, rdir = path.join(J.dataRoot, 'research'), jobs = path.join(J.dataRoot, 'jobs'), day = dublinDay();
  J.put(path.join(jobs, day + '--genre-scout-1', 'transcript.jsonl'), JSON.stringify({ at: '2026-10-17T10:00:00Z', toolCalls: [{ name: 'fs_write', input: { path: 'scouting/' + day + '/notes.json', content: '{"other":1}' } }] }) + '\n');
  J.put(legacyNotesFile(rdir, day), notesJson(day, FIXTURE_GAMES));
  const b = backfillScouting(J, rdir, { jobsDir: jobs, apply: true });
  assert.deepEqual(b.migrated, []);
  assert.match(b.unmatched[0].reason, /differs from the file/);
  assert.ok(fs.existsSync(legacyNotesFile(rdir, day)), 'left where it is');
  assert.equal(b.files[0].jobId, null);
  assert.equal(b.added, ALL.length, 'its names still go on the blocklist (fail closed)');
});
