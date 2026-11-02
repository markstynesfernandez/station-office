// model.test.mjs — the readers and the snapshot derivation, run against fixtures/station-root (a read-only snapshot of
// the real StarNet files, `npm run snapshot-fixtures`) with and without the synthetic overlay. node --test.
// Expectations are computed from the fixture files where possible, so a fresh snapshot does not break the tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTracker, STATUSES, COLUMNS, readLedger, isListingId, briefUsdRange, activeAgents, rosterList, nameKey, idsForNames } from '../src/lib/legacy-readers/index.mjs';
import { readStation } from '../src/server/sources/files.mjs';
import { buildSnapshot, cronNext, cronWords, dmy } from '../src/server/model.mjs';
import { roleLabel } from '../src/web/ui/role.js';
import { createOfficeServer } from '../src/server/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures', 'station-root');
const SN = path.join(FIX, 'station-workspace', 'starnet');
const quiet = { info() {}, warn() {}, error(m, d) { throw new Error(m + ' ' + JSON.stringify(d)); }, read() {}, written() {}, counts: {} };
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'SNAPSHOT.json'), 'utf8'));
const NOW = META.takenAtMs;
const roster = JSON.parse(fs.readFileSync(path.join(SN, 'agent.roster.json'), 'utf8'));
const withOverlay = () => createOfficeServer({ fixtures: true, log: quiet, snapshotTtlMs: 0 }).snapshot(true).snap;
const realOnly = () => createOfficeServer({ fixtures: true, synthetic: false, log: quiet, snapshotTtlMs: 0 }).snapshot(true).snap;

test('fixtures are a read-only snapshot of the real files, with prompts removed', () => {
  assert.ok(fs.existsSync(path.join(SN, 'agent.roster.json')), 'run `npm run snapshot-fixtures`');
  assert.equal(META.source, 'Virtual-workers');
  assert.ok(META.files > 50 && META.thumbnails > 0);
  assert.ok(roster.agents.length >= 8);
  for (const a of roster.agents) assert.ok(!('system' in a), a.name + ' still has its system prompt in the fixture');
  const runs = fs.readFileSync(path.join(SN, 'runs.jsonl'), 'utf8');
  assert.ok(!runs.includes('"deliveryPrompt"'));
  assert.ok(!fs.existsSync(path.join(SN, '.secrets')), 'secrets are never copied');
});

test('copied readers: tracker header, statuses, ledger rows, listing-id grammar, brief price range, name keys', () => {
  const rows = readTracker(path.join(FIX, 'station-workspace', 'tracker', 'listings.csv'));
  assert.ok(rows.length >= 5); for (const r of rows) { assert.ok(STATUSES.includes(r.status), r.status); assert.deepEqual(Object.keys(r), COLUMNS); }
  const ledger = readLedger(path.join(SN, 'ledger.jsonl'));
  assert.ok(ledger.length > 20); assert.ok(ledger.every((r) => typeof r.usd === 'number' && typeof r.tsMs === 'number'));
  assert.ok(isListingId('2026-10-14--funny-bbq-dad-tee-r6')); assert.ok(!isListingId('../x')); assert.ok(!isListingId('2026-10-14--Bad_Slug'));
  assert.deepEqual(briefUsdRange('## Price range\nUSD 24.99 – USD 29.99.\n## Next'), { min: 24.99, max: 29.99 });
  assert.equal(briefUsdRange('## Price range\nUNKNOWN (USD 20 quoted)'), null);
  assert.equal(nameKey('QA LISTING'), nameKey('QA-LISTING'));
  assert.deepEqual(idsForNames(['qa design'], { 'openclaw-6': 'QA-DESIGN', 'openclaw-3': 'DESIGNER' }), ['openclaw-6']);
});

test('BRIDGE (hero) is hidden; the 8 active agents each have a desk and a department', () => {
  const s = realOnly();
  assert.equal(s.agents.length, activeAgents(rosterList(roster)).length);
  assert.equal(s.agents.length, 8);
  assert.ok(!s.agents.some((a) => a.name === 'BRIDGE' || a.id === 'agent'));
  for (const a of s.agents) { assert.ok(a.desk, a.name + ' desk'); assert.ok(a.dept, a.name + ' dept'); }
});

test('model, provider and role come from the roster; the system prompt never reaches the snapshot', () => {
  const s = realOnly();
  for (const a of s.agents) {
    const r = roster.agents.find((x) => x.agentId === a.id);
    assert.equal(a.model, r.model, a.name + ' model'); assert.equal(a.provider, r.provider, a.name + ' provider');
    // R2: a prompt-like roster role ("You are ...", or over 80 characters) is replaced by a short label
    assert.equal(a.role, roleLabel(r.role, { dept: a.deptName, name: a.name })); assert.equal(a.modelSource, 'agent.roster.json');
    assert.ok(!/^\s*you are/i.test(a.role) && a.role.length <= 80 && !a.role.includes(String(r.role).slice(0, 40)), a.name + ' role is a short label, not prompt text: ' + a.role);
    assert.ok(!('purpose' in a));
  }
  // even if a roster still carried its prompt, nothing of it is copied into the snapshot
  const raw = readStation(FIX, quiet);
  raw.roster = { ...raw.roster, agents: raw.roster.agents.map((a) => ({ ...a, system: 'SYSTEM-PROMPT-CANARY ' + a.name })) };
  assert.ok(!JSON.stringify(buildSnapshot(raw, { now: NOW })).includes('SYSTEM-PROMPT-CANARY'));
});

test('departments come from the save rooms + desk props and agree with floorRooms', () => {
  const s = realOnly();
  const byName = Object.fromEntries(s.departments.map((d) => [d.name, d.agents.map((id) => s.agents.find((a) => a.id === id).name).sort()]));
  assert.deepEqual(byName, { RESEARCH: ['DEMAND-RESEARCHER', 'EVIDENCE-CHECKER'], DESIGN: ['DESIGNER', 'QA-DESIGN'], OFFICE: ['LISTER', 'QA-LISTING', 'REJECTS-DESK', 'STATION-OVERSEER'] });
  assert.ok(!s.departments.some((d) => d.name === 'HAB-32'), 'the bay room is skipped (decision 3)');
  assert.ok(!s.warnings.some((w) => /floorRooms/.test(w)), 'no save/floorRooms disagreement: ' + s.warnings.join(' | '));
  for (const d of s.departments) { assert.equal(d.metrics.length, 2); assert.ok(d.metrics.every((m) => m.source)); }
});

test('a floorRooms disagreement produces a warning badge, not a silent choice (decision 4)', () => {
  const raw = readStation(FIX, quiet);
  raw.config = JSON.parse(JSON.stringify(raw.config)); raw.config.floorRooms.DESIGN.desks.push('lister');
  const s = buildSnapshot(raw, { now: NOW });
  assert.ok(s.warnings.some((w) => /LISTER: save puts the desk in OFFICE, floorRooms says DESIGN/.test(w)), s.warnings.join(' | '));
  assert.equal(s.departments.find((d) => d.name === 'OFFICE').warnings.length, 1);
});

test('board: columns follow the routing plan; every job sits in exactly one column or lane', () => {
  for (const s of [realOnly(), withOverlay()]) {
    assert.deepEqual(s.board.columns.map((c) => c.key), ['brief', 'design', 'qa-design', 'listing', 'qa-listing', 'approval-queue', 'done']);
    assert.deepEqual(s.stages.map((x) => x.agentName), ['DESIGNER', 'QA-DESIGN', 'LISTER', 'QA-LISTING']);
    const total = s.board.columns.reduce((n, c) => n + c.jobIds.length, 0) + s.board.lanes.blocked.length + s.board.lanes.rejected.length;
    assert.equal(total, s.jobs.length);
    assert.ok(s.board.lanes.rejected.length >= 1, 'the real snapshot has rejected jobs');
  }
});

test('conflicting sources are shown, not silently resolved: owner decision beats rejected/, a newer rejected/ beats a stale blocked', () => {
  const s = realOnly();
  for (const j of s.jobs) {
    const tr = j.tracker;
    if (tr && ['approved', 'published', 'retired'].includes(tr.status)) assert.equal(j.status, 'done', j.id);
    if (tr && tr.status === 'rejected_by_owner') assert.equal(j.lane, 'rejected', j.id);
    if (j.warnings.some((w) => /tracker still says blocked/.test(w))) assert.equal(j.lane, 'rejected', j.id);
  }
  const conflicted = s.jobs.filter((j) => j.warnings.length);
  if (conflicted.length) assert.ok(s.warnings.some((w) => /sources that disagree/.test(w)));
});

test('synthetic overlay: working, error, waiting and blocked states exist only with the overlay, and are tagged', () => {
  const real = realOnly(), s = withOverlay();
  assert.ok(real.agents.every((a) => !a.synthetic)); assert.ok(real.jobs.every((j) => !j.synthetic)); assert.deepEqual(real.source.synthetic, []);
  const st = Object.fromEntries(s.agents.map((a) => [a.name, a]));
  assert.equal(st.DESIGNER.status, 'working'); assert.ok(st.DESIGNER.synthetic); assert.deepEqual(st.DESIGNER.services, ['anthropic', 'openrouter']);
  assert.equal(st['EVIDENCE-CHECKER'].status, 'error'); assert.ok(st['EVIDENCE-CHECKER'].synthetic);
  assert.equal(st['QA-LISTING'].status, 'waiting'); assert.ok(st['QA-LISTING'].synthetic);
  for (const name of ['LISTER', 'REJECTS-DESK', 'QA-DESIGN', 'DEMAND-RESEARCHER', 'STATION-OVERSEER']) assert.equal(st[name].status, real.agents.find((a) => a.name === name).status, name + ' keeps its real status');
  const blocked = s.board.lanes.blocked.map((id) => s.jobs.find((j) => j.id === id));
  assert.ok(blocked.some((j) => j.synthetic && j.qaPassedGateFailed && j.statusReason), 'D7 shape: QA passed, gate failed, with status_reason');
  assert.equal(s.source.synthetic.length, 4);
  // the overlay never touches the real records it sits beside
  for (const j of real.jobs) { const o = s.jobs.find((x) => x.id === j.id); assert.equal(o.status, j.status, j.id); }
});

test('STATION-OVERSEER shows "No report yet" when overseer/reports/ is empty (decision 8)', () => {
  const reports = path.join(FIX, 'station-workspace', 'overseer', 'reports');
  const empty = !fs.existsSync(reports) || !fs.readdirSync(reports).filter((f) => !f.startsWith('.')).length;
  const o = realOnly().agents.find((a) => a.name === 'STATION-OVERSEER').overseer;
  if (empty) { assert.equal(o.note, 'No report yet'); assert.equal(o.report, null); } else assert.ok(o.report);
});

test('hub = station memory (all notebook records, "last recalled by" from the newest lastUsedAt); spend is a labelled calendar day', () => {
  const s = realOnly();
  const books = fs.readdirSync(SN).filter((f) => /\.notebook\.json$/.test(f)).map((f) => [f.replace('.notebook.json', ''), JSON.parse(fs.readFileSync(path.join(SN, f), 'utf8'))]).filter(([, l]) => Array.isArray(l));
  assert.equal(s.hub.notebooks.entries, books.reduce((n, [, l]) => n + l.length, 0));
  const newest = books.flatMap(([id, l]) => l.map((n) => ({ id, at: n.lastUsedAt || 0 }))).sort((a, b) => b.at - a.at)[0];
  if (newest && newest.at) { assert.equal(s.hub.notebooks.lastRecalledBy, roster.agents.find((a) => a.agentId === newest.id)?.name || newest.id); assert.equal(s.hub.notebooks.lastRecalledAt, newest.at); }
  const ledger = readLedger(path.join(SN, 'ledger.jsonl'));
  assert.equal(s.hub.ledger.rows, ledger.length);
  const d = new Date(NOW), dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = ledger.filter((r) => r.tsMs >= dayStart && r.tsMs <= NOW);
  assert.equal(s.spend.today.runs, today.length); assert.ok(Math.abs(s.spend.today.usd - today.reduce((t, r) => t + r.usd, 0)) < 1e-6);
  assert.equal(s.spend.today.label, 'calendar day ' + dmy(dayStart) + ' (local)'); assert.match(s.spend.today.label, /^calendar day \d{2}\/\d{2}\/\d{4} \(local\)$/);
  assert.equal(s.spend.trailing24h, null); assert.equal(s.spend.last7days.length, 7);
});

test('routines: only cron.jobs.json; paused ones have no next run and are not projected; ghost runs exist for the toggle', () => {
  const s = realOnly();
  const cron = JSON.parse(fs.readFileSync(path.join(SN, 'cron.jobs.json'), 'utf8')).jobs;
  assert.deepEqual(s.routines.map((r) => r.id).sort(), cron.map((j) => j.id).sort());
  for (const r of s.routines.filter((x) => !x.enabled)) { assert.equal(r.nextRun, null); assert.equal(r.needsOk, true); assert.deepEqual(r.upcoming, []); assert.ok(r.ghostRuns.length > 0); assert.equal(r.scheduleWords, cronWords(r.schedule)); }
  const pausedIds = new Set(s.routines.filter((x) => !x.enabled).map((r) => r.id));
  assert.ok(!s.events.some((e) => e.kind === 'routine' && pausedIds.has(e.routineId)), 'paused routines are not projected onto future days');
  const from = new Date(2026, 9, 16, 10, 0).getTime();   // Fri 16/10/2026 10:00 local
  assert.equal(new Date(cronNext('0 9 * * 1', from)).toString(), new Date(2026, 9, 19, 9, 0).toString());
  assert.equal(new Date(cronNext('0 18 * * *', from)).toString(), new Date(2026, 9, 16, 18, 0).toString());
  assert.equal(new Date(cronNext('30 8 1 * *', from)).toString(), new Date(2026, 10, 1, 8, 30).toString());
  assert.equal(cronNext('bad', from), null);
  assert.equal(cronWords('0 9 * * 1'), 'every Monday at 09:00'); assert.equal(cronWords('0 18 * * *'), 'every day at 18:00'); assert.equal(cronWords('30 8 1 * *'), 'on day 1 of every month at 08:30'); assert.equal(cronWords('0 9 * * 1,3'), 'on Mondays and Wednesdays at 09:00');
});

test('calendar: one entry per job, on the day of its latest stage change, with the stage it reached', () => {
  const s = withOverlay();
  const jobEvents = s.events.filter((e) => e.kind === 'job');
  assert.equal(jobEvents.length, s.jobs.filter((j) => j.stageChangedAt).length);
  assert.equal(new Set(jobEvents.map((e) => e.jobId)).size, jobEvents.length, 'one entry per job');
  for (const e of jobEvents) { const j = s.jobs.find((x) => x.id === e.jobId); assert.equal(e.at, j.stageChangedAt); assert.equal(e.stage, j.lane || j.stage); }
});

test('task statuses partition the jobs (chip counts add up to All); progress % only for active jobs', () => {
  const s = withOverlay();
  const statuses = ['in_progress', 'waiting', 'backlog', 'done', 'blocked', 'rejected'];
  assert.equal(statuses.reduce((n, k) => n + s.jobs.filter((j) => j.status === k).length, 0), s.jobs.length);
  for (const j of s.jobs) { if (j.status === 'in_progress' || j.status === 'waiting') assert.equal(typeof j.progress, 'number', j.id); else assert.equal(j.progress, null, j.id); }
  for (const j of s.jobs.filter((x) => x.lane)) assert.ok(j.statusReason, j.id + ' has a status reason');
});

test('readers tolerate a missing workspace (empty snapshot, errors listed, no throw)', () => {
  const log = { info() {}, warn() {}, error() {}, read() {}, written() {}, counts: {} };
  const raw = readStation(path.join(ROOT, 'fixtures', 'does-not-exist'), log);
  const s = buildSnapshot(raw, { now: NOW });
  assert.equal(s.agents.length, 0); assert.equal(s.jobs.length, 0); assert.ok(Array.isArray(s.board.columns));
});
