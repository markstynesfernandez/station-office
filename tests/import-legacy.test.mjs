// import-legacy.test.mjs — the legacy import (ENGINE-PLAN.md §7.1, §7.3, §8) on a synthetic legacy tree in a temp folder:
// the source is never written (byte-identical before and after, no new files), secrets are refused by name and never
// copied, the not-imported list is skipped, the ledger total and row counts reconcile, tracker/rejected disagreements
// become warnings (not resolved), routines arrive disabled, a second run changes nothing, a delta is picked up by key,
// a backup is taken before every run, and an import refuses to run while an engine holds the data root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createJail } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { runImport, openSource, ImportError } from '../src/engine/import/legacy.mjs';
import { openStore } from '../src/engine/store/db.mjs';
import { createEngine, LockError } from '../src/engine/engine.mjs';
import { tempDir } from './helpers/engine.mjs';

const A = '2026-10-14--alpha-tee', B = '2026-10-14--beta-tee', C = '2026-10-14--gamma-tee', D = '2026-10-16--delta-pack';
const SECRET = 'sk-or-v1-FAKE-never-copied-0000';
const HEADER = 'listing_id,room,niche,product_key,brief_date,design_file,print_files,qa_design,qa_listing,status,status_reason,packaged_at,cost_usd,owner_decision_at,published_at,etsy_listing_url,sales_units_total,sales_revenue_total,sales_currency,sales_updated_at,updated_at';
const trow = (id, status, reason, updated) => [id, 'room1-etsy', '"Alpha niche, with a comma."', 'tee-front', '2026-10-14', '', '', 'approved', 'approved', status, '"' + reason + '"', '', '', '', '', '', '', '', '', '', updated].join(',');

function fakeLegacy(base) {
  const root = path.join(base, 'Legacy-build'), SW = path.join(root, 'station-workspace');
  const w = (rel, text) => { const f = path.join(SW, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const ledger = [
    { runId: 'r1', agentId: 'oc-3', turns: 1, usd: 0.0000038, tokens: 22, model: 'anthropic/claude-haiku-5.5', unmetered: false, ts: Date.parse('2026-10-14T10:00:00Z'), entryId: 'e1' },
    { runId: 'r1', agentId: 'oc-3', turns: 2, usd: 0.1234567, tokens: 900, model: 'anthropic/claude-haiku-5.5', unmetered: false, ts: Date.parse('2026-10-14T10:01:00Z'), entryId: 'e2' },
    { runId: 'r2', agentId: 'oc-6', turns: 3, usd: 0.0456789, tokens: 500, model: 'claude-sonnet-5-5', unmetered: false, ts: Date.parse('2026-10-15T23:30:00Z'), entryId: 'e3' },
    { runId: 'r9', agentId: 'agent', turns: 1, usd: 0.3, tokens: 50, model: 'claude-sonnet-5-5', unmetered: false, ts: Date.parse('2026-10-16T09:00:00Z'), entryId: 'e4' }
  ];
  w('starnet/ledger.jsonl', ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const runs = [
    { runId: 'r1', agentId: 'oc-3', provider: 'openrouter', reason: 'done', turns: 3, tokens: 922, usd: 0.1234605, title: 'design ' + A, deliveryPrompt: 'SECRET PROMPT TEXT', deliveryText: 'out', artifacts: [{ kind: 'image', path: 'work/' + A + '/design-v1.png' }], toolTrace: [{ name: 'fs_read' }, { name: 'image_generate' }], startedAt: Date.parse('2026-10-14T09:59:00Z'), endedAt: Date.parse('2026-10-14T10:01:00Z'), ts: 1 },
    { runId: 'r2', agentId: 'oc-6', provider: 'anthropic', reason: 'done', turns: 3, tokens: 500, usd: 0.0456789, title: 'qa design for ' + B, deliveryPrompt: 'x', artifacts: [], toolTrace: [], startedAt: 1, endedAt: 2, ts: 2 }
  ];
  w('starnet/runs.jsonl', runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  w('starnet/agent.roster.json', JSON.stringify({ agents: [{ agentId: 'oc-3', name: 'DESIGNER', system: 'PROMPT' }, { agentId: 'oc-6', name: 'QA-DESIGN', system: 'PROMPT' }] }));
  w('starnet/agent.save.json', '{"doc":{}}');
  w('starnet/cron.jobs.json', JSON.stringify({ version: 1, jobs: [{ id: 'c1', name: 'Research weekly', prompt: 'do research', schedule: { kind: 'cron', expr: '0 9 * * 1' }, agentId: 'oc-3', enabled: true }] }));
  w('starnet/oc-3.notebook.json', JSON.stringify([{ id: 'n1', kind: 'fact', body: 'a fact', lastUsedAt: 5, useCount: 2 }, { id: 'n2', kind: 'fact', body: 'b', lastUsedAt: 6, useCount: 1 }]));
  w('starnet/task-briefs.json', JSON.stringify({ briefs: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
  w('starnet/transcript-history-v2/manifest.json', '{"version":2}');
  w('starnet/transcript-history-v2/segment-000001.jsonl', '{"a":1}\n{"a":2}\n');
  w('starnet/.secrets/provider-keys.json', JSON.stringify({ openrouter: SECRET }));
  w('starnet/.checkpoints/blob', 'checkpoint');
  w('starnet/hooks.json', '{}'); w('starnet/budget.json', '{}'); w('starnet/line-spend.json', '{}'); w('starnet/steptest.sessions.json', '{}');
  w('.env', 'OPENROUTER_API_KEY=' + SECRET);
  w('tracker/listings.csv', [HEADER, trow(A, 'blocked', 'gate failed', '2026-10-15T10:00:00.000Z'), trow(B, 'rejected_by_owner', 'owner said no', '2026-10-15T16:00:00.000Z'), trow(C, 'parked', 'parked: not publishing', '2026-10-16T17:00:00.000Z')].join('\n') + '\n');
  w('room1-etsy/work/' + A + '/brief.md', '# Niche\nAlpha niche\nproduct_type: tee-front\n'); w('room1-etsy/work/' + A + '/design-v1.png', 'PNGDATA');
  w('room1-etsy/work/' + A + '/qa/design-pass1.json', JSON.stringify({ verdict: 'revise', reasons: ['too plain'] }));
  w('room1-etsy/work/' + D + '/brief.md', '# Niche\nDelta\nproduct_type: pack\n'); w('room1-etsy/work/' + D + '/set-v1/raw/01.png', 'PNG');
  w('room1-etsy/work/_aborted-trigger-20261015/NOTE.md', 'Unintended run, archived.\n');
  w('room1-etsy/outbox/' + B + '/listing.json', '{"title":"Beta"}');
  w('rejected/' + A + '/REJECTED.md', '# Rejected\npre-originality-gate brief, archived 2026-10-16\n');
  w('rejected/' + B + '/REJECTED.md', '# Rejected\nOwner design review\n');
  w('rejected/' + C + '/REJECTED.md', '# Rejected\npre-originality-gate brief, archived 2026-10-16\n');
  w('approval-queue/' + C + '/MANIFEST.json', '{"costUsd":2.38}'); w('approval-queue/' + C + '/PARKED.md', 'parked\n');
  w('research-lab/briefs/' + D + '.md', 'brief'); w('research-lab/drafts/2026-10-14/x.md', 'draft'); w('research-lab/products.json', '{}');
  w('research-lab/.git/config', '[core]');
  w('logs/starnet.log', 'log');
  w('workspace-quarantine/q.txt', 'q');
  return { root, SW, ledger };
}

const hashTree = (dir) => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const s = fs.statSync(f); out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + s.mtimeMs; } } }; walk(dir); return out; };

function setup(t) {
  const base = tempDir('station-import-');
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) { /* temp */ } });
  const L = fakeLegacy(base);
  const dataRoot = path.join(base, 'data'), logs = path.join(base, 'logs');
  const J = createJail({ dataRoot, extraRoots: [logs], legacyRoots: [L.root] });
  const log = makeLogger({ dir: logs, name: 'test', quiet: true, jail: J });
  return { base, L, J, log, dataRoot };
}

test('import: source untouched, secrets refused by name, not-imported skipped, counts and the ledger total reconcile', async (t) => {
  const { L, J, log, dataRoot } = setup(t);
  const before = hashTree(L.root);
  const r = await runImport({ from: L.root, J, log });
  assert.deepEqual(hashTree(L.root), before, 'the source tree is byte-identical (contents and mtimes), with no new files');
  assert.equal(r.changed, true);
  // reconciliation: 4 rows, exact total, every breakdown sums to it
  const Lr = r.reconciliation.ledger, total = L.ledger.reduce((s, x) => s + Math.round(x.usd * 1e9), 0) / 1e9;
  assert.equal(Lr.sourceRows, 4); assert.equal(Lr.importedRows, 4); assert.equal(Lr.importedUsd, total); assert.equal(Lr.sourceUsd, total); assert.equal(Lr.match, true);
  assert.deepEqual(Object.values(Lr.groupSumsEqualTotal), [true, true, true, true]);
  assert.equal(Lr.attribution.attributedRows, 3, 'r1 by artifact path (2 rows), r2 by title (1 row)'); assert.equal(Lr.attribution.unattributedRows, 1, 'r9 is not in runs.jsonl');
  const rows = fs.readFileSync(path.join(dataRoot, 'legacy', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((x) => x.source === 'legacy'));
  assert.deepEqual(rows.map((x) => [x.entryId, x.agentKey, x.jobId]), [['e1', 'designer', A], ['e2', 'designer', A], ['e3', 'qa-design', B], ['e4', null, null]]);
  assert.equal(rows[1].usd, 0.1234567, 'usd copied exactly');
  const runs = fs.readFileSync(path.join(dataRoot, 'legacy', 'runs.jsonl'), 'utf8');
  assert.ok(!/SECRET PROMPT TEXT|deliveryPrompt|deliveryText/.test(runs), 'prompts and delivery text are dropped'); assert.match(runs, /"tools":\["fs_read","image_generate"\]/);
  // secrets and the not-imported list: refused or skipped by name, never copied
  const copied = Object.keys(hashTree(path.join(dataRoot, 'legacy'))).join('\n');
  for (const bad of [/\.secrets/, /provider-keys/, /\.env/, /\.git/, /\.checkpoints/, /hooks\.json/, /budget\.json/, /line-spend/, /steptest/, /agent\.save/, /agent\.roster/, /quarantine/, /starnet\.log/]) assert.ok(!bad.test(copied), 'not copied: ' + bad);
  const all = fs.readdirSync(dataRoot, { recursive: true }).filter((f) => fs.statSync(path.join(dataRoot, f)).isFile()).map((f) => fs.readFileSync(path.join(dataRoot, f)));
  assert.ok(!all.some((b) => b.includes(SECRET)), 'the secret value is nowhere in the data root');
  assert.ok(r.refusedByName.includes('starnet/.secrets/') && r.refusedByName.includes('research-lab/.git/'), JSON.stringify(r.refusedByName));
  assert.ok(r.skipped.includes('starnet/.checkpoints/'));
  assert.throws(() => openSource(L.root).read('.env'), /secret/); assert.throws(() => openSource(L.root).read('starnet/.secrets/provider-keys.json'), /secret/); assert.throws(() => openSource(L.root).read('../x'), /outside/);
  // IMPORT.json: paths, sizes, sha256, counts
  const imp = JSON.parse(fs.readFileSync(path.join(dataRoot, 'import', 'IMPORT.json'), 'utf8'));
  const led = imp.source.read.find((x) => x.path === 'station-workspace/starnet/ledger.jsonl');
  assert.equal(led.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(L.SW, 'starnet', 'ledger.jsonl'))).digest('hex'));
  assert.equal(led.bytes, fs.statSync(path.join(L.SW, 'starnet', 'ledger.jsonl')).size);
  assert.ok(imp.target.files.some((f) => f.path === 'legacy/jobs/' + A + '/work/design-v1.png' && f.sha256 && f.bytes === 7));
  assert.equal(imp.counts.tracker.sourceRows, 3); assert.equal(imp.counts.notebooks.records, 2); assert.equal(imp.counts.transcripts.rows, 2); assert.equal(imp.counts.taskBriefs.briefs, 3);
  assert.equal(imp.incidents[0].id, '_aborted-trigger-20261015');
  // the store: legacy jobs tagged; disagreements are warnings, not resolved; routines disabled
  const store = openStore({ J }); t.after(() => store.close());
  const ja = store.getJob(A), jb = store.getJob(B), jc = store.getJob(C), jd = store.getJob(D);
  assert.equal(ja.legacy, true); assert.equal(ja.kind, 'legacy'); assert.equal(ja.state, 'blocked', 'the tracker row, as it is');
  assert.equal(ja.data.legacy.warnings.length, 1); assert.match(ja.data.legacy.warnings[0], /tracker says "blocked".*rejected\/ also holds this job.*not resolved/);
  assert.equal(jb.state, 'rejected_by_owner'); assert.equal(jb.data.legacy.warnings.length, 0, 'tracker and rejected/ agree');
  assert.equal(jc.state, 'parked'); assert.equal(jc.data.legacy.lane, 'parked'); assert.equal(jc.data.legacy.warnings.length, 1, 'parked, but rejected/ also holds it');
  assert.ok(!store.getApproval(C), 'parked legacy is not in the approval queue (Q11)');
  assert.equal(jd.state, 'legacy-open'); assert.equal(jd.data.legacy.stage, 'design');
  assert.equal(store.getTracker(A).status, 'blocked'); assert.equal(store.getTracker(A).legacy, true);
  const rt = store.getRoutine('legacy-c1'); assert.equal(rt.enabled, false, 'enabled in the source, disabled here'); assert.equal(rt.legacy, true); assert.equal(rt.schedule, '0 9 * * 1');
  assert.deepEqual(store.legacyCounts(), { jobs: 4, tracker: 3, routines: 1, routinesEnabled: 0 });
  // a backup was taken first; nothing is left in staging
  const backups = fs.readdirSync(path.join(dataRoot, '.backups')); assert.equal(backups.length, 1);
  assert.ok(fs.existsSync(path.join(dataRoot, '.backups', backups[0], 'BACKUP.json')));
  assert.ok(!fs.readdirSync(dataRoot).some((n) => n.startsWith('.import-')), 'no staging or old folder left');
});

test('import twice: the second run adds 0 rows and changes nothing; a later delta is picked up by key', async (t) => {
  const { L, J, log, dataRoot } = setup(t);
  await runImport({ from: L.root, J, log, now: Date.parse('2026-10-16T20:00:00Z') });
  const legacyBefore = hashTree(path.join(dataRoot, 'legacy')), importBefore = fs.readFileSync(path.join(dataRoot, 'import', 'IMPORT.json'));
  const store0 = openStore({ J }); const versions = store0.listJobs().map((j) => j.id + ':' + j.version + ':' + j.updated_at).join(); store0.close();
  const r2 = await runImport({ from: L.root, J, log, now: Date.parse('2026-10-16T20:05:00Z') });
  assert.equal(r2.changed, false); assert.match(r2.result, /^nothing changed: 0 rows added/);
  assert.deepEqual(r2.rows, { ledger: { added: 0, changed: 0, keptNotInSource: 0 }, runs: { added: 0, changed: 0, keptNotInSource: 0 } });
  assert.equal(r2.files.added, 0); assert.deepEqual(r2.files.changed, []); assert.deepEqual(r2.files.removed, []);
  assert.deepEqual(r2.store.planned, { jobs: { same: 4 }, tracker: { same: 3 }, routines: { same: 1 } });
  assert.deepEqual(hashTree(path.join(dataRoot, 'legacy')), legacyBefore, 'data/legacy/ untouched (contents and mtimes)');
  assert.ok(fs.readFileSync(path.join(dataRoot, 'import', 'IMPORT.json')).equals(importBefore), 'IMPORT.json untouched');
  const store1 = openStore({ J }); assert.equal(store1.listJobs().map((j) => j.id + ':' + j.version + ':' + j.updated_at).join(), versions, 'no job row touched'); store1.close();
  assert.equal(r2.reconciliation.ledger.match, true);
  assert.equal(fs.readdirSync(path.join(dataRoot, '.backups')).length, 2, 'a backup before every run');
  assert.match(fs.readFileSync(path.join(dataRoot, 'import', 'runs', r2.stamp + '.md'), 'utf8'), /\*\*Result:\*\* nothing changed: 0 rows added/);
  // delta: one new ledger row, one tracker row changed in place
  fs.appendFileSync(path.join(L.SW, 'starnet', 'ledger.jsonl'), JSON.stringify({ runId: 'r2', agentId: 'oc-6', turns: 1, usd: 0.01, tokens: 9, model: 'claude-sonnet-5-5', unmetered: false, ts: Date.parse('2026-10-16T21:00:00Z'), entryId: 'e5' }) + '\n');
  const csv = fs.readFileSync(path.join(L.SW, 'tracker', 'listings.csv'), 'utf8').replace('"gate failed"', '"gate failed again"');
  fs.writeFileSync(path.join(L.SW, 'tracker', 'listings.csv'), csv);
  const r3 = await runImport({ from: L.root, J, log, now: Date.parse('2026-10-16T20:10:00Z') });
  assert.equal(r3.changed, true); assert.equal(r3.rows.ledger.added, 1); assert.equal(r3.rows.ledger.changed, 0); assert.equal(r3.reconciliation.ledger.importedRows, 5); assert.equal(r3.reconciliation.ledger.match, true);
  assert.deepEqual(r3.store.planned.tracker, { same: 2, update: 1 });
  const store2 = openStore({ J }); assert.equal(store2.getTracker(A).status_reason, 'gate failed again'); store2.close();
});

test('import: a digital legacy job is labelled with the digital room, not etsy-pod; a re-run changes nothing', async (t) => {
  const { L, J, log } = setup(t);
  // E: a tracker row in the digital room; F: no tracker row, a brief for a digital product (config/products.json)
  const E = '2026-10-16--echo-props', F = '2026-10-16--foxtrot-props';
  const w = (rel, text) => { const f = path.join(L.SW, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const csv = fs.readFileSync(path.join(L.SW, 'tracker', 'listings.csv'), 'utf8').replace(/\n?$/, '\n');
  w('tracker/listings.csv', csv + [E, 'etsy-digital', '"Echo props"', 'pngtuber-prop-pack', '2026-10-16', '', '', 'approved', 'approved', 'published', '"live"', '', '', '', '', '', '', '', '', '', '2026-10-17T10:00:00.000Z'].join(',') + '\n');
  w('room1-etsy/work/' + E + '/brief.md', '# Niche\nEcho\nproduct_type: pngtuber-prop-pack\n');
  w('room1-etsy/work/' + F + '/brief.md', '# Niche\nFoxtrot\nproduct_type: pngtuber-prop-pack\n');
  await runImport({ from: L.root, J, log, now: Date.parse('2026-10-17T12:00:00Z') });
  const store = openStore({ J });
  const room = (id) => store.getJob(id).data.legacy.room;
  assert.equal(room(E), 'etsy-digital', 'the tracker row says etsy-digital');
  assert.equal(room(F), 'etsy-digital', 'no tracker row: a digital product key');
  assert.equal(room(A), 'etsy-pod', 'a tee (the tracker room is neither of the two): the archived POD line');
  assert.equal(room(D), 'etsy-pod', 'a product that is not a digital product type');
  store.close();
  const r2 = await runImport({ from: L.root, J, log, now: Date.parse('2026-10-17T12:05:00Z') });
  assert.equal(r2.changed, false); assert.deepEqual(r2.store.planned.jobs, { same: 6 });
});

test('import refuses while an engine holds the data root, and refuses a source that overlaps the data root', async (t) => {
  const { L, J, log, base } = setup(t);
  // an engine in another live process (the parent of this test process) holds the lock
  J.put(path.join(J.dataRoot, '.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }) + '\n');
  await assert.rejects(runImport({ from: L.root, J, log }), LockError);
  assert.ok(!fs.existsSync(path.join(J.dataRoot, '.backups')), 'refused before the backup');
  J.remove(path.join(J.dataRoot, '.lock'));
  const engine = createEngine({ archiveSandbox: true, J, log, startScheduler: false }); engine.close();
  await assert.rejects(runImport({ from: path.join(base, 'nothing-here'), J, log }), ImportError);
  const inner = path.join(L.root, 'data');
  assert.throws(() => createJail({ dataRoot: inner, extraRoots: [], legacyRoots: [L.root] }), /overlap/);
});

test('after an import the engine shows the legacy jobs, lanes and memory, and legacy spend never reaches its caps', async (t) => {
  const { L, J, log } = setup(t);
  await runImport({ from: L.root, J, log });
  const { buildEngineSnapshot } = await import('../src/server/engine-model.mjs');
  const engine = createEngine({ archiveSandbox: true, J, log, startScheduler: false });
  t.after(() => engine.close());
  const s = buildEngineSnapshot(engine);
  // E5 item 0b: every legacy job is in the Legacy lane only, never in a stage column or the engine's lanes
  assert.deepEqual(Object.fromEntries(Object.entries(s.board.lanes).map(([k, v]) => [k, v.length])), { blocked: 0, rejected: 0, parked: 0, legacy: s.jobs.filter((j) => j.kind === 'legacy').length });
  assert.ok(s.board.lanes.legacy.length >= 4);
  for (const c of s.board.columns) assert.deepEqual(c.jobIds.filter((id) => s.jobs.find((j) => j.id === id).kind === 'legacy'), [], 'no legacy job in the ' + c.key + ' column');
  const D0 = s.jobs.find((j) => j.id === D); assert.ok(s.board.lanes.legacy.includes(D0.id), 'the unfinished legacy job is in the Legacy lane, not a stage column');
  const a = s.jobs.find((j) => j.id === A);
  assert.equal(a.kind, 'legacy'); assert.equal(a.lane, 'blocked'); assert.equal(a.warnings.length, 1); assert.equal(a.hops.length, 1); assert.equal(a.hops[0].agentId, 'designer');
  assert.equal(a.costUsd, 0.1234605); assert.ok(a.images.some((i) => i.file === 'work/design-v1.png')); assert.equal(a.qaDesign[0].verdict, 'revise');
  assert.equal(s.jobs.find((j) => j.id === D).status, 'legacy');
  // the memory core: legacy notebooks, read only; the engine ledger stays empty and legacy spend is separate
  assert.equal(s.hub.notebooks.entries, 2); assert.equal(s.hub.notebooks.legacy, true); assert.equal(s.hub.legacyLedger.rows, 4);
  assert.equal(s.hub.ledger.rows, 0); assert.equal(engine.ledger.totals.rows, 0); assert.equal(s.spend.today.usd, 0); assert.equal(engine.guard.status().spentToday, 0);
  assert.ok(s.spend.legacy.usd > 0.46 && /not counted in the engine caps/.test(s.spend.legacy.note));
  assert.equal(s.routines.find((r) => r.id === 'legacy-c1').enabled, false);
  for (const d of s.departments) assert.deepEqual(d.counts, { doing: 0, next: 0, done: 0 }, 'legacy history is not counted as current work');
});
