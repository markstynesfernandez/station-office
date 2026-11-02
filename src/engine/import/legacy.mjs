// legacy.mjs — the one-time, idempotent import of the legacy station build (ENGINE-PLAN.md §7.1, §7.3, §8).
//   npm run import-legacy -- --from <legacy folder>
//
// Source side: READ ONLY. Files are opened with readFileSync / readdirSync / statSync through src.abs(), which refuses
// anything outside <from>/station-workspace and every secret or VCS path by name (.secrets/, .env, provider keys,
// .git/). The roster is read for its agentId -> name pairs only and is not copied. The "Not imported" list (§7.1) is
// never copied. Nothing is ever written to the source, and the data root may not overlap it.
//
// Data side: every write goes through the engine's data jail (dataJail and its helpers):
//   1. take the engine lock (no engine may run on the data root during an import)
//   2. back up the current data/ to data/.backups/<stamp>/ (backup.mjs, §7.3)
//   3. build data/.import-staging-<stamp>/legacy/ from the source, keyed on source ids, starting from what is already
//      imported: new keys are added, changed keys are upserted (before and after are logged), keys the source no longer
//      has are kept (imported history is never dropped) and reported
//   4. verify the staging folder: every file's sha256 against what was read, row counts, the ledger USD total
//   5. if nothing differs from data/legacy/ and the database, discard the staging folder: nothing changes
//      otherwise swap it in for data/legacy/, upsert the legacy jobs, tracker rows and (disabled) routines in one
//      transaction, and write data/import/IMPORT.json (paths, sizes, sha256, row counts)
//   6. write the run report (reconciliation with workings) to data/import/runs/<stamp>.json and .md
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createJail, realResolve, defaultLegacyRoot, APP_ROOT } from '../store/jail.mjs';
import { openStore } from '../store/db.mjs';
import { company } from '../building.mjs';
import { takeLock } from '../engine.mjs';
import { loadConfig } from '../config.mjs';
import { building, DEFAULT_BUSINESS } from '../business.mjs';
import { dublinDay } from '../time.mjs';
import { backupData } from './backup.mjs';
import { readTracker, isListingId, nameKey } from '../../lib/legacy-readers/index.mjs';

export class ImportError extends Error { constructor(msg) { super(msg); this.code = 'IMPORT'; } }

export const DEFAULT_FROM = defaultLegacyRoot();
export const SECRET_RE = /(^|[\\/])\.secrets([\\/]|$)|(^|[\\/])\.env($|[.\\/])|provider-keys[^\\/]*$|(^|[\\/])\.git([\\/]|$)/i;
// §7.1 "Not imported": never copied (the roster is read for its id -> name pairs only)
export const NOT_IMPORTED = [
  '.checkpoints/ (StarNet internal git stores)', 'agent.save.json and agent.roster.json (agents come from the prompt sources)',
  'hooks, triggers, budget.json and line-spend.json (replaced by config and the engine ledger)', 'step-test sessions and verdict packets',
  'starnet.recovery-owner.json.generations', 'workspace-quarantine', 'StarNet logs (left where they are)', '.secrets/, .env and provider keys (never read)'
];
export const NOT_IMPORTED_RE = /(^|[\\/])(\.checkpoints|agent\.save[^\\/]*|agent\.roster[^\\/]*|hooks\.json|triggers\.json|budget\.json|line-spend\.json|steptest\.sessions\.json|[^\\/]*verdict-packets?[^\\/]*|starnet\.recovery-owner\.json\.generations|workspace-quarantine|logs)([\\/]|$)/i;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nano = (usd) => Math.round(Number(usd) * 1e9);   // exact for the source's at most 9 decimal places
const usdOf = (n) => n / 1e9;
const fmt = (n) => '$' + usdOf(n).toFixed(7);
const LID = /(?:^|[\\/])(\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*)(?=[\\/]|$)/g;
const titleFromId = (id) => id.slice(12).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const firstLine = (t) => (String(t || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] || '');
const isoMs = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, '');

// ---------------------------------------------------------------- the source (read only)
export function openSource(from) {
  const root = realResolve(path.resolve(from));
  const SW = path.join(root, 'station-workspace');
  if (!fs.existsSync(path.join(SW, 'starnet'))) throw new ImportError('not a legacy station build (no station-workspace/starnet): ' + root);
  const reads = new Map(), refused = new Set(), skipped = new Set();
  function abs(rel) {
    const f = path.resolve(SW, rel);
    if (!(f === SW || f.startsWith(SW + path.sep))) throw new ImportError('refusing to read outside the source: ' + rel);
    if (SECRET_RE.test(path.relative(SW, f))) throw new ImportError('refusing to read a secret or VCS path: ' + rel);
    return f;
  }
  const relOf = (f) => path.relative(SW, f).split(path.sep).join('/');
  return {
    root, label: 'station-workspace', abs,
    exists: (rel) => fs.existsSync(abs(rel)),
    stat: (rel) => fs.statSync(abs(rel)),
    read(rel) {
      const f = abs(rel), buf = fs.readFileSync(f), st = fs.statSync(f), sha = sha256(buf);
      reads.set(relOf(f), { path: 'station-workspace/' + relOf(f), bytes: buf.length, sha256: sha, mtimeMs: Math.round(st.mtimeMs) });
      return { buf, sha, mtimeMs: Math.round(st.mtimeMs) };
    },
    // the roster: agentId -> name only (not imported, not copied)
    rosterNames() { const f = abs('starnet/agent.roster.json'); if (!fs.existsSync(f)) return {}; const r = JSON.parse(fs.readFileSync(f, 'utf8')); return Object.fromEntries((r.agents || []).map((a) => [a.agentId || a.id, a.name])); },
    // every file under rel (secrets refused by name, the not-imported list skipped), sorted
    files(rel) {
      const out = [], base = abs(rel);
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const f = path.join(d, e.name), r = relOf(f);
          if (SECRET_RE.test(r)) { refused.add(r + (e.isDirectory() ? '/' : '')); continue; }
          if (NOT_IMPORTED_RE.test(r)) { skipped.add(r + (e.isDirectory() ? '/' : '')); continue; }
          if (e.isDirectory()) walk(f); else if (e.isFile()) out.push(r);
        }
      };
      walk(base);
      return out;
    },
    dirs: (rel) => { const d = abs(rel); return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !SECRET_RE.test(e.name)).map((e) => e.name).sort() : []; },
    reads: () => [...reads.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    refused: () => [...refused].sort(), skipped: () => [...skipped].sort()
  };
}

const jsonl = (buf) => {
  const rows = [], bad = [];
  String(buf).split(/\r?\n/).forEach((l, i) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch (e) { bad.push(i + 1); } });
  return { rows, bad };
};

// ---------------------------------------------------------------- read everything the import needs from the source
export function readSource(src, cfg) {
  const out = { files: [], rows: {}, counts: {}, notes: [], digitalProducts: (cfg.products || []).filter((p) => p.digital).map((p) => p.key) };
  const fileRec = (rel, to) => { const r = src.read(rel); out.files.push({ from: rel, to, buf: r.buf, sha256: r.sha, bytes: r.buf.length, mtimeMs: r.mtimeMs }); return r; };

  // agents: legacy agentId -> roster name -> engine agent key (letters and digits compared, DECISIONS.md 10/D4)
  const names = src.rosterNames();
  // R1: the legacy history is the Etsy shop's, so a legacy name maps to an archived agent, never to a not-hired one (the new DESIGNER is ux-designer)
  const keyOfName = Object.fromEntries(Object.values(cfg.agents).filter((a) => a.status !== 'not-hired').map((a) => [nameKey(a.name), a.key]));
  const agentMap = Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name, agentKey: keyOfName[nameKey(name)] || null }]));
  const agentOf = (id) => agentMap[id] || { name: null, agentKey: null };
  out.agents = agentMap;

  // ---- runs (summaries; deliveryPrompt and deliveryText dropped, tool names only)
  const runsSrc = src.exists('starnet/runs.jsonl') ? src.read('starnet/runs.jsonl') : { buf: Buffer.from('') };
  const rp = jsonl(runsSrc.buf); if (rp.bad.length) out.notes.push('runs.jsonl: unreadable lines ' + rp.bad.join(', ') + ' (not imported)');
  out.counts.runs = { sourceRows: rp.rows.length + rp.bad.length, readable: rp.rows.length, unreadable: rp.bad.length };
  const knownIds = new Set();
  for (const sub of ['room1-etsy/work', 'room1-etsy/outbox', 'rejected', 'approval-queue']) for (const d of src.dirs(sub)) if (isListingId(d)) knownIds.add(d);
  const attribute = (r) => {
    const ids = new Set();
    for (const a of r.artifacts || []) for (const m of String(a.path || '').matchAll(LID)) if (knownIds.has(m[1])) ids.add(m[1]);
    if (ids.size === 1) return { jobId: [...ids][0], attribution: 'artifact path' };
    if (ids.size > 1) return { jobId: null, attribution: 'ambiguous: artifacts name ' + [...ids].join(', ') };
    const t = [r.title, r.sessionTitle].join(' ');
    for (const m of t.matchAll(/\b(\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*)\b/g)) if (knownIds.has(m[1])) ids.add(m[1]);
    if (ids.size === 1) return { jobId: [...ids][0], attribution: 'run title' };
    if (ids.size > 1) return { jobId: null, attribution: 'ambiguous: title names ' + [...ids].join(', ') };
    return { jobId: null, attribution: 'unattributed legacy' };
  };
  const runOf = {};
  out.rows.runs = rp.rows.map((r) => {
    const a = agentOf(r.agentId), at = attribute(r);
    const row = { runId: r.runId, parentRunId: r.parentRunId || null, source: 'legacy', legacyAgentId: r.agentId, agentKey: a.agentKey, agentName: a.name, provider: r.provider || null, model: r.model || null, reasoningEffort: r.reasoningEffort || null, reason: r.reason || null, turns: r.turns ?? null, tokens: r.tokens ?? null, usd: r.usd ?? 0, unmetered: !!r.unmetered, title: String(r.title || '').slice(0, 300), surface: r.surface || null, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null, durationMs: r.durationMs ?? null, ts: r.ts ?? null, artifacts: r.artifacts || [], toolsOk: r.toolsOk ?? null, tools: [...new Set((r.toolTrace || []).map((t) => t.name).filter(Boolean))], failureStage: r.failureStage || null, failureCode: r.failureCode || null, lineId: r.lineId || null, dockId: r.dockId || null, cronJobId: r.cronJobId || null, stepTest: !!r.stepTest, jobId: at.jobId, attribution: at.attribution };
    runOf[r.runId] = row; return row;
  });

  // ---- ledger (every row kept exactly as to money: usd is copied, never rounded)
  const ledSrc = src.exists('starnet/ledger.jsonl') ? src.read('starnet/ledger.jsonl') : { buf: Buffer.from('') };
  const lp = jsonl(ledSrc.buf); if (lp.bad.length) out.notes.push('ledger.jsonl: unreadable lines ' + lp.bad.join(', ') + ' (not imported; the total below excludes them)');
  let srcNano = 0; for (const r of lp.rows) srcNano += nano(r.usd);
  out.counts.ledger = { sourceRows: lp.rows.length + lp.bad.length, readable: lp.rows.length, unreadable: lp.bad.length, sourceNano: srcNano, runIds: new Set(lp.rows.map((r) => r.runId)).size };
  out.rows.ledger = lp.rows.map((r) => {
    const a = agentOf(r.agentId), run = runOf[r.runId];
    return { entryId: r.entryId, ts: r.ts, usd: r.usd, source: 'legacy', kind: 'text', provider: run ? run.provider : null, model: r.model || null, tokens: r.tokens ?? null, turns: r.turns ?? null, unmetered: !!r.unmetered, runId: r.runId || null, legacyAgentId: r.agentId, agentKey: a.agentKey, agentName: a.name, jobId: run ? run.jobId : null, attribution: run ? run.attribution : 'run not in runs.jsonl', imageCost: 'unknown (not in the legacy ledger)' };
  });

  // ---- tracker
  let tracker = [];
  if (src.exists('tracker/listings.csv')) { const t = fileRec('tracker/listings.csv', 'tracker/listings.csv'); tracker = readTracker(src.abs('tracker/listings.csv')); void t; }
  out.tracker = tracker;
  out.counts.tracker = { sourceRows: tracker.length, byStatus: tracker.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] || 0) + 1 }), {}) };

  // ---- job folders, the approval queue, rejected/, and the aborted-trigger incident
  const jobDirs = {}; const incidents = [];
  const SRC_DIRS = [['room1-etsy/work', 'work'], ['room1-etsy/outbox', 'outbox'], ['rejected', 'rejected'], ['approval-queue', 'package']];
  out.counts.folders = {};
  for (const [sub, as] of SRC_DIRS) {
    const c = { folders: 0, files: 0, bytes: 0 };
    for (const d of src.dirs(sub)) {
      if (!isListingId(d)) {
        if (sub === 'room1-etsy/work' && d.startsWith('_aborted-trigger')) {
          const files = src.files(sub + '/' + d); const note = src.exists(sub + '/' + d + '/NOTE.md') ? firstLine(fs.readFileSync(src.abs(sub + '/' + d + '/NOTE.md'), 'utf8')) : null;
          for (const f of files) fileRec(f, 'incidents/' + d + '/' + f.slice(sub.length + d.length + 2));
          incidents.push({ id: d, from: 'station-workspace/' + sub + '/' + d + '/', to: 'legacy/incidents/' + d + '/', files: files.length, note });
        } else out.notes.push(sub + '/' + d + ': not a listing id, not imported');
        continue;
      }
      c.folders++;
      (jobDirs[d] ||= {})[as] = { from: sub + '/' + d };
      for (const f of src.files(sub + '/' + d)) { const r = fileRec(f, 'jobs/' + d + '/' + as + '/' + f.slice(sub.length + d.length + 2)); c.files++; c.bytes += r.buf.length; }
    }
    out.counts.folders[sub] = c;
  }
  out.counts.incidents = incidents.length;
  out.incidents = incidents;
  out.jobDirs = jobDirs;

  // ---- research lab (briefs, drafts, scouting, rejected, products.json)
  const lab = src.files('research-lab');
  for (const f of lab) fileRec(f, 'research/' + f.slice('research-lab/'.length));
  const labCount = (p) => lab.filter((f) => f.startsWith('research-lab/' + p + '/') && f.endsWith('.md')).length;
  out.counts.research = { files: lab.length, briefs: labCount('briefs'), drafts: labCount('drafts'), scouting: lab.filter((f) => f.startsWith('research-lab/scouting/')).length, rejected: labCount('rejected'), productsJson: lab.includes('research-lab/products.json') };
  for (const f of ['room1-etsy/products.json', 'room1-etsy/fx.json']) if (src.exists(f)) fileRec(f, 'room1-etsy/' + path.basename(f));

  // ---- notebooks (read-only history for the memory-core viewer; never fed back to agents, owner Q9)
  out.counts.notebooks = { files: 0, records: 0, byAgent: {} };
  for (const e of fs.readdirSync(src.abs('starnet'), { withFileTypes: true }).filter((x) => x.isFile() && /^[A-Za-z0-9_-]+\.notebook\.json$/.test(x.name)).map((x) => x.name).sort()) {
    const r = fileRec('starnet/' + e, 'notebooks/' + e); let n = 0;
    try { const j = JSON.parse(r.buf.toString('utf8')); n = Array.isArray(j) ? j.length : 0; } catch (_) { out.notes.push(e + ': unreadable JSON (copied as is, 0 records counted)'); }
    out.counts.notebooks.files++; out.counts.notebooks.records += n; out.counts.notebooks.byAgent[e.replace(/\.notebook\.json$/, '')] = n;
  }

  // ---- routines (cron.jobs.json): imported DISABLED
  out.routines = [];
  if (src.exists('starnet/cron.jobs.json')) {
    const r = fileRec('starnet/cron.jobs.json', 'routines/cron.jobs.json');
    const jobs = (JSON.parse(r.buf.toString('utf8')).jobs || []);
    for (const j of jobs) { const a = agentOf(j.agentId); out.routines.push({ id: 'legacy-' + j.id, name: j.name + ' (legacy, disabled)', target: 'legacy:agent:' + (a.agentKey || j.agentId), input: String(j.prompt || ''), schedule: (j.schedule && j.schedule.expr) || String(j.scheduleDisplay || '').replace(/^cron\s+/, ''), max_runs_per_day: 1, sourceEnabled: !!j.enabled }); }
  }
  out.counts.routines = { sourceRows: out.routines.length, enabledInSource: out.routines.filter((r) => r.sourceEnabled).length };

  // ---- archive (owner Q10): transcripts and task briefs, read-only
  const tx = src.files('starnet/transcript-history-v2'); let txRows = 0;
  for (const f of tx) { const r = fileRec(f, 'archive/transcripts/' + path.basename(f)); if (f.endsWith('.jsonl')) txRows += String(r.buf).split(/\r?\n/).filter((l) => l.trim()).length; }
  out.counts.transcripts = { files: tx.length, rows: txRows };
  if (src.exists('starnet/task-briefs.json')) { const r = fileRec('starnet/task-briefs.json', 'archive/task-briefs.json'); let n = 0; try { const j = JSON.parse(r.buf.toString('utf8')); n = Array.isArray(j.briefs) ? j.briefs.length : Array.isArray(j) ? j.length : 0; } catch (_) { out.notes.push('task-briefs.json: unreadable JSON'); } out.counts.taskBriefs = { briefs: n }; }

  // refusals and skips seen while walking, plus a names-only look at the two top folders (nothing in them is opened)
  for (const top of ['', 'starnet']) for (const e of fs.readdirSync(path.join(src.abs(''), top), { withFileTypes: true })) {
    const r = (top ? top + '/' : '') + e.name + (e.isDirectory() ? '/' : '');
    if (SECRET_RE.test(r.replace(/\/$/, ''))) out.refusedTop = [...(out.refusedTop || []), r];
    else if (NOT_IMPORTED_RE.test(r.replace(/\/$/, ''))) out.skippedTop = [...(out.skippedTop || []), r];
  }
  out.refused = [...new Set([...src.refused(), ...(out.refusedTop || [])])].sort(); out.skipped = [...new Set([...src.skipped(), ...(out.skippedTop || [])])].sort();
  delete out.refusedTop; delete out.skippedTop;
  return out;
}

// ---------------------------------------------------------------- legacy jobs (the board and panel records)
// Sources are imported as they are. Where the tracker and rejected/ disagree, the job's state follows the tracker row
// (the imported status record) and the disagreement is a warning on the job: nothing is resolved or merged.
export function legacyJobs(S) {
  const trackerOf = Object.fromEntries(S.tracker.map((r) => [r.listing_id, r]));
  const ids = [...new Set([...Object.keys(S.jobDirs), ...S.tracker.map((r) => r.listing_id)])].filter(isListingId).sort();
  const filesOf = (id, as) => S.files.filter((f) => f.to.startsWith('jobs/' + id + '/' + as + '/'));
  const text = (id, as, name) => { const f = S.files.find((x) => x.to === 'jobs/' + id + '/' + as + '/' + name); return f ? f.buf.toString('utf8') : null; };
  const mt = (id, as, name) => { const f = S.files.find((x) => x.to === 'jobs/' + id + '/' + as + '/' + name); return f ? f.mtimeMs : null; };
  const runsFor = (id) => S.rows.runs.filter((r) => r.jobId === id);
  return ids.map((id) => {
    const dirs = S.jobDirs[id] || {}, tr = trackerOf[id] || null;
    const rej = dirs.rejected ? { line: firstLine(text(id, 'rejected', 'REJECTED.md')), at: mt(id, 'rejected', 'REJECTED.md') } : null;
    const brief = text(id, 'work', 'brief.md') || text(id, 'rejected', 'brief.md') || text(id, 'package', 'brief.md') || '';
    const product = (tr && tr.product_key) || ((/^product_type:\s*(\S+)/m.exec(brief) || [])[1]) || null;
    const all = [...filesOf(id, 'work'), ...filesOf(id, 'outbox'), ...filesOf(id, 'rejected'), ...filesOf(id, 'package')].map((f) => f.mtimeMs);
    const runs = runsFor(id);
    const first = Math.min(...[...all, ...runs.map((r) => r.startedAt).filter(Boolean)].filter(Number.isFinite));
    const warnings = [];
    let state, reason, endedAt = null, lane;
    if (tr) {
      state = tr.status; reason = tr.status_reason || null;
      endedAt = isoMs(tr.published_at) || isoMs(tr.owner_decision_at) || isoMs(tr.updated_at);
      if (rej && tr.status !== 'rejected_by_owner') warnings.push('tracker says "' + tr.status + '" (' + (tr.status_reason || 'no reason') + ', updated ' + (tr.updated_at || '?') + '); rejected/ also holds this job (REJECTED.md: "' + rej.line + '", ' + new Date(rej.at).toISOString() + '). Both are imported as they are; the disagreement is not resolved.');
    } else if (rej) { state = 'rejected'; reason = rej.line || 'moved to rejected/'; endedAt = rej.at; }
    else if (dirs.package) { state = 'parked'; reason = 'in the legacy approval queue with no tracker row'; warnings.push('approval-queue/ holds this job but the tracker has no row for it'); }
    else { state = 'legacy-open'; reason = 'legacy job, not finished in the legacy station (imported as it stood)'; }
    lane = { blocked: 'blocked', rejected: 'rejected', rejected_by_owner: 'rejected', parked: 'parked' }[state] || null;
    const stage = lane || (['approved', 'published', 'retired'].includes(state) ? 'done' : state === 'packaged' ? 'approval-queue' : dirs.outbox ? 'qa-listing' : filesOf(id, 'work').some((f) => /design-v\d+\.(png|svg|md)$|set-v\d+\//.test(f.to)) ? 'design' : 'brief');
    const finite = all.filter(Number.isFinite), lastChange = endedAt || (finite.length ? Math.max(...finite) : null) || (Number.isFinite(first) ? first : 0);
    const usdNano = S.rows.ledger.filter((r) => r.jobId === id).reduce((s, r) => s + nano(r.usd), 0);
    // the legacy room: the tracker's own when it names one of the two (etsy-digital, etsy-pod); with no tracker row, a
    // digital product (config/products.json) is etsy-digital and anything else the archived POD line
    const room = tr && /^etsy-(digital|pod)$/.test(tr.room || '') ? tr.room : (S.digitalProducts || []).includes(product) ? 'etsy-digital' : 'etsy-pod';
    return {
      id, line: 'legacy:room1-etsy', title: titleFromId(id), product_key: product, state, reason,
      created_at: Number.isFinite(first) ? first : lastChange, updated_at: lastChange, started_at: Number.isFinite(first) ? first : null, ended_at: endedAt,
      data: { legacy: { system: 'legacy station', room, folder: 'legacy/jobs/' + id + '/', sources: Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, 'station-workspace/' + v.from + '/'])), tracker: tr ? { status: tr.status, status_reason: tr.status_reason || null, updated_at: tr.updated_at || null, cost_usd: tr.cost_usd || null, qa_design: tr.qa_design || null, qa_listing: tr.qa_listing || null } : null, rejected: rej ? { firstLine: rej.line, at: rej.at } : null, stage, lane, warnings, runs: runs.map((r) => r.runId), ledgerUsd: usdOf(usdNano), niche: (/^# Niche\s*\n([^\n]+)/m.exec(brief) || [])[1] || (tr && tr.niche) || null } }
    };
  });
}

// ---------------------------------------------------------------- keyed merge with what is already imported
function readCurrentRows(file) { if (!fs.existsSync(file)) return []; return jsonl(fs.readFileSync(file)).rows; }
export function mergeRows(current, incoming, key) {
  const out = [], seen = new Set(), inMap = new Map(incoming.map((r) => [r[key], r]));
  const diff = { added: [], changed: [], keptNotInSource: [] };
  for (const r of current) {
    const k = r[key]; seen.add(k);
    if (!inMap.has(k)) { out.push(r); diff.keptNotInSource.push(k); continue; }
    const n = inMap.get(k);
    if (JSON.stringify(n) !== JSON.stringify(r)) { diff.changed.push({ key: k, before: r, after: n }); out.push(n); } else out.push(r);
  }
  for (const r of incoming) if (!seen.has(r[key])) { out.push(r); diff.added.push(r[key]); seen.add(r[key]); }
  return { rows: out, diff };
}

function treeShas(dir) {
  const out = {};
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(f, r); else out[r] = { sha256: sha256(fs.readFileSync(f)), bytes: fs.statSync(f).size }; } };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------- the run
export async function runImport({ from = DEFAULT_FROM, dataRoot, configDir, promptsDir, log, now = Date.now(), J = null } = {}) {
  const src = openSource(from);
  J = J || createJail(dataRoot ? { dataRoot } : {});
  const over = (a, b) => { const n = (p) => (process.platform === 'win32' ? p.toLowerCase() : p); const x = n(a), y = n(b); return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); };
  if (over(J.dataRoot, src.root)) throw new ImportError('the data root and the source overlap: ' + J.dataRoot + ' / ' + src.root);
  const stamp = stampOf(now);
  const unlock = takeLock(J, log);
  let store = null;
  try {
    store = openStore({ J, log });
    const cfg = loadConfig({ configDir: configDir || path.join(APP_ROOT, 'config'), promptsDir: promptsDir || path.join(APP_ROOT, 'prompts') });
    // B0 (owner, 21/10/2026): the legacy history is the Etsy shop's: an imported job or routine belongs to its line's business, else etsy-shop
    const B = building(cfg); store.setBusinessResolver((rec) => (rec && (rec.business_id || rec.businessId)) || (rec && rec.line && B.ofLine(rec.line)) || DEFAULT_BUSINESS);
    // R1: and to product etsy-shop, department etsy (the archive), through the same resolver the engine uses
    const C = company(cfg); store.setProductResolver((rec) => C.resolve({ businessId: DEFAULT_BUSINESS, ...rec }));
    // 1. the backup, before anything changes
    const backup = backupData({ J, store, stamp, log });

    // 2. read the source
    const S = readSource(src, cfg);
    const jobs = legacyJobs(S);
    const engineIds = jobs.filter((j) => { const c = store.getJob(j.id); return c && !c.legacy; }).map((j) => j.id);
    if (engineIds.length) throw new ImportError('legacy ids clash with engine jobs (nothing imported): ' + engineIds.join(', '));

    // 3. stage: start from what is imported, merge by source id
    const LEG = path.join(J.dataRoot, 'legacy');
    const STAGE = path.join(J.dataRoot, '.import-staging-' + stamp);
    const SL = path.join(STAGE, 'legacy');
    const ledgerM = mergeRows(readCurrentRows(path.join(LEG, 'ledger.jsonl')), S.rows.ledger, 'entryId');
    const runsM = mergeRows(readCurrentRows(path.join(LEG, 'runs.jsonl')), S.rows.runs, 'runId');
    const current = treeShas(LEG);
    const expected = {};
    for (const f of S.files) { J.put(path.join(SL, f.to), f.buf); expected[f.to] = { sha256: f.sha256, bytes: f.bytes }; }
    const keptFiles = [];
    for (const [r, v] of Object.entries(current)) if (!(r in expected) && !['ledger.jsonl', 'runs.jsonl', 'agents.json', 'jobs.json'].includes(r)) { J.copy(path.join(LEG, r), path.join(SL, r)); expected[r] = v; keptFiles.push(r); }
    const putRows = (name, rows) => { const buf = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); J.put(path.join(SL, name), buf); expected[name] = { sha256: sha256(buf), bytes: buf.length }; };
    putRows('ledger.jsonl', ledgerM.rows); putRows('runs.jsonl', runsM.rows);
    const agentsBuf = Buffer.from(JSON.stringify({ note: 'legacy agentId -> roster name -> engine agent key (the roster itself is not imported)', agents: S.agents }, null, 2) + '\n');
    J.put(path.join(SL, 'agents.json'), agentsBuf); expected['agents.json'] = { sha256: sha256(agentsBuf), bytes: agentsBuf.length };
    const jobsBuf = Buffer.from(JSON.stringify({ note: 'the legacy jobs as imported into the store (state follows the tracker row where there is one; disagreements are warnings, not resolved)', jobs: jobs.map((j) => ({ id: j.id, state: j.state, stage: j.data.legacy.stage, warnings: j.data.legacy.warnings.length })) }, null, 2) + '\n');
    J.put(path.join(SL, 'jobs.json'), jobsBuf); expected['jobs.json'] = { sha256: sha256(jobsBuf), bytes: jobsBuf.length };

    // 4. verify the staging folder
    const staged = treeShas(SL), problems = [];
    for (const [r, v] of Object.entries(expected)) { if (!staged[r]) problems.push('missing in staging: ' + r); else if (staged[r].sha256 !== v.sha256) problems.push('sha256 mismatch in staging: ' + r); }
    for (const r of Object.keys(staged)) { if (!(r in expected)) problems.push('unexpected file in staging: ' + r); if (SECRET_RE.test(r)) problems.push('secret-like path in staging: ' + r); }
    const stagedLedger = readCurrentRows(path.join(SL, 'ledger.jsonl'));
    const stagedNano = stagedLedger.reduce((s, r) => s + nano(r.usd), 0);
    const fromSource = new Set(S.rows.ledger.map((r) => r.entryId));
    const sourcePartNano = stagedLedger.filter((r) => fromSource.has(r.entryId)).reduce((s, r) => s + nano(r.usd), 0);
    if (sourcePartNano !== S.counts.ledger.sourceNano) problems.push('ledger total of the source rows in staging ' + fmt(sourcePartNano) + ' differs from the source ' + fmt(S.counts.ledger.sourceNano));
    if (stagedLedger.filter((r) => fromSource.has(r.entryId)).length !== S.counts.ledger.readable) problems.push('ledger row count in staging differs from the source');
    if (new Set(stagedLedger.map((r) => r.entryId)).size !== stagedLedger.length) problems.push('duplicate ledger entryIds in staging');
    if (problems.length) { J.remove(STAGE); throw new ImportError('staging failed verification (nothing changed; staging removed): ' + problems.slice(0, 10).join('; ')); }

    // 5. what differs from the current import (files) and the store (rows)
    const fileDiff = { added: [], changed: [], keptNotInSource: keptFiles };
    for (const [r, v] of Object.entries(staged)) { if (!current[r]) fileDiff.added.push(r); else if (current[r].sha256 !== v.sha256) fileDiff.changed.push(r); }
    const removed = Object.keys(current).filter((r) => !staged[r]);
    const dbPlan = { jobs: jobs.map((j) => ({ id: j.id, op: dryOp(store, 'job', j) })), tracker: S.tracker.map((r) => ({ id: r.listing_id, op: dryOp(store, 'tracker', r) })), routines: S.routines.map((r) => ({ id: r.id, op: dryOp(store, 'routine', r) })) };
    const dbChanges = [...dbPlan.jobs, ...dbPlan.tracker, ...dbPlan.routines].filter((x) => x.op !== 'same').length;
    const changed = fileDiff.added.length + fileDiff.changed.length + removed.length + dbChanges > 0;

    const upserts = [];
    let swapped = false;
    if (!changed) J.remove(STAGE);
    else {
      // swap the folder in, then the rows in one transaction; on a failure the old folder goes back
      const OLD = path.join(J.dataRoot, '.import-old-' + stamp);
      if (fs.existsSync(LEG)) J.move(LEG, path.join(OLD, 'legacy'));
      J.move(SL, LEG); swapped = true;
      try {
        store.tx(() => {
          for (const j of jobs) { const r = store.upsertLegacyJob(j); upserts.push({ table: 'jobs', id: j.id, ...r }); }
          for (const t of S.tracker) { const r = store.upsertLegacyTracker(t.listing_id, t); upserts.push({ table: 'tracker', id: t.listing_id, ...r }); }
          for (const rt of S.routines) { const r = store.upsertLegacyRoutine(rt); upserts.push({ table: 'routines', id: rt.id, ...r }); }
        });
      } catch (e) {
        J.move(LEG, path.join(STAGE, 'failed-legacy')); if (fs.existsSync(path.join(OLD, 'legacy'))) J.move(path.join(OLD, 'legacy'), LEG);
        throw new ImportError('database upsert failed; the previous data/legacy/ is back in place: ' + e.message);
      }
      J.remove(OLD); J.remove(STAGE);
    }
    for (const u of upserts.filter((x) => x.op === 'updated')) log.info('legacy upsert', { table: u.table, id: u.id, before: u.before, after: u.after });
    for (const c of [...ledgerM.diff.changed, ...runsM.diff.changed]) log.info('legacy row upsert', { key: c.key, before: c.before, after: c.after });

    // 6. IMPORT.json (only when something changed) and the run report
    const ledgerRows = readCurrentRows(path.join(LEG, 'ledger.jsonl'));
    const recon = reconcile(S, ledgerRows, readCurrentRows(path.join(LEG, 'runs.jsonl')), jobs, store);
    const importJson = {
      importedAt: new Date(now).toISOString(), stamp, source: { root: src.root, read: src.reads(), refusedByName: S.refused, notImported: NOT_IMPORTED, skippedOnTheWay: S.skipped },
      target: { folder: 'data/legacy/', files: Object.entries(treeShas(LEG)).map(([p, v]) => ({ path: 'legacy/' + p, ...v })).sort((a, b) => (a.path < b.path ? -1 : 1)) },
      counts: S.counts, ledger: { rows: ledgerRows.length, usd: usdOf(ledgerRows.reduce((s, r) => s + nano(r.usd), 0)) }, incidents: S.incidents, notes: S.notes, backup: backup.dir
    };
    if (changed) J.put(path.join(J.dataRoot, 'import', 'IMPORT.json'), JSON.stringify(importJson, null, 2) + '\n');
    const report = {
      stamp, at: new Date(now).toISOString(), source: src.root, dataRoot: J.dataRoot, backup: backup.dir, changed,
      result: changed ? 'imported: ' + ledgerM.diff.added.length + ' ledger rows and ' + runsM.diff.added.length + ' runs added, ' + (ledgerM.diff.changed.length + runsM.diff.changed.length) + ' rows upserted, ' + (fileDiff.added.length) + ' files added, ' + fileDiff.changed.length + ' files changed, ' + dbChanges + ' store rows inserted or updated'
        : 'nothing changed: 0 rows added, 0 rows upserted, 0 files added or changed, 0 store rows inserted or updated; data/legacy/, IMPORT.json and the store are as they were',
      rows: { ledger: ledgerM.diff.added.length ? { added: ledgerM.diff.added.length, changed: ledgerM.diff.changed.length, keptNotInSource: ledgerM.diff.keptNotInSource.length } : { added: 0, changed: ledgerM.diff.changed.length, keptNotInSource: ledgerM.diff.keptNotInSource.length }, runs: { added: runsM.diff.added.length, changed: runsM.diff.changed.length, keptNotInSource: runsM.diff.keptNotInSource.length } },
      files: { added: fileDiff.added.length, changed: fileDiff.changed, keptNotInSource: fileDiff.keptNotInSource, removed },
      store: { planned: { jobs: tally(dbPlan.jobs), tracker: tally(dbPlan.tracker), routines: tally(dbPlan.routines) }, after: store.legacyCounts() },
      reconciliation: recon, warnings: jobs.filter((j) => j.data.legacy.warnings.length).map((j) => ({ id: j.id, warnings: j.data.legacy.warnings })), incidents: S.incidents, refusedByName: S.refused, skipped: S.skipped, notes: S.notes,
      importJson: changed ? 'data/import/IMPORT.json written' : 'data/import/IMPORT.json not touched'
    };
    J.put(path.join(J.dataRoot, 'import', 'runs', stamp + '.json'), JSON.stringify(report, null, 2) + '\n');
    J.put(path.join(J.dataRoot, 'import', 'runs', stamp + '.md'), reportMd(report));
    log.info('import done', { stamp, changed, result: report.result, swapped });
    return report;
  } finally { if (store) store.close(); unlock(); }
}

function dryOp(store, kind, x) {
  if (kind === 'job') { const c = store.getJob(x.id); if (!c) return 'insert'; const cur = store.db.prepare('SELECT * FROM jobs WHERE id = ?').get(x.id); const want = { line: x.line, kind: 'legacy', title: x.title || null, product_key: x.product_key || null, state: x.state, reason: x.reason || null, created_at: x.created_at, updated_at: x.updated_at, started_at: x.started_at ?? null, ended_at: x.ended_at ?? null, data: JSON.stringify(x.data || {}) }; return Object.keys(want).every((k) => cur[k] === want[k]) ? 'same' : 'update'; }
  if (kind === 'tracker') { const r = store.db.prepare('SELECT row FROM tracker WHERE listing_id = ?').get(x.listing_id); return !r ? 'insert' : r.row === JSON.stringify(x) ? 'same' : 'update'; }
  const r = store.getRoutine(x.id); if (!r) return 'insert';
  return r.name === x.name && r.target === x.target && r.input === (x.input || '') && r.schedule === x.schedule && r.max_runs_per_day === (x.max_runs_per_day ?? 1) ? 'same' : 'update';
}
const tally = (list) => list.reduce((o, x) => ({ ...o, [x.op]: (o[x.op] || 0) + 1 }), {});

// ---------------------------------------------------------------- reconciliation: counts and the ledger total, with workings
export function reconcile(S, ledgerRows, runRows, jobs, store) {
  const src = new Set(S.rows.ledger.map((r) => r.entryId));
  const imp = ledgerRows.filter((r) => src.has(r.entryId));
  const by = (rows, f) => { const o = {}; for (const r of rows) { const k = f(r) ?? '(none)'; o[k] = (o[k] || 0) + nano(r.usd); } return Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, { usd: usdOf(v), nano: v }])); };
  const sum = (o) => Object.values(o).reduce((s, v) => s + v.nano, 0);
  const total = imp.reduce((s, r) => s + nano(r.usd), 0);
  const groups = { byDublinDay: by(imp, (r) => dublinDay(r.ts)), byModel: by(imp, (r) => r.model), byAgent: by(imp, (r) => r.agentName || r.legacyAgentId), byAttribution: by(imp, (r) => (r.jobId ? 'job ' + r.jobId : r.attribution)) };
  const checks = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, sum(g) === total]));
  const counts = {
    'starnet/ledger.jsonl': { source: S.counts.ledger.readable, imported: imp.length, match: S.counts.ledger.readable === imp.length },
    'starnet/runs.jsonl': { source: S.counts.runs.readable, imported: runRows.filter((r) => S.rows.runs.some((x) => x.runId === r.runId)).length },
    'tracker/listings.csv': { source: S.counts.tracker.sourceRows, imported: store.legacyCounts().tracker, byStatus: S.counts.tracker.byStatus },
    'starnet/*.notebook.json': { source: S.counts.notebooks.records, files: S.counts.notebooks.files, byAgent: S.counts.notebooks.byAgent },
    'starnet/cron.jobs.json': { source: S.counts.routines.sourceRows, imported: store.legacyCounts().routines, enabledAfterImport: store.legacyCounts().routinesEnabled },
    'starnet/transcript-history-v2/': { sourceRows: S.counts.transcripts.rows, files: S.counts.transcripts.files },
    'starnet/task-briefs.json': { briefs: S.counts.taskBriefs ? S.counts.taskBriefs.briefs : 0 },
    'job folders': S.counts.folders, 'research-lab/': S.counts.research, incidents: S.counts.incidents,
    'legacy jobs in the store': { distinctIds: jobs.length, imported: store.legacyCounts().jobs, byState: jobs.reduce((o, j) => ({ ...o, [j.state]: (o[j.state] || 0) + 1 }), {}) }
  };
  for (const k of Object.keys(counts)) if (counts[k] && typeof counts[k] === 'object' && 'source' in counts[k] && 'imported' in counts[k]) counts[k].match = counts[k].source === counts[k].imported;
  const attributed = imp.filter((r) => r.jobId);
  return {
    ledger: {
      sourceRows: S.counts.ledger.sourceRows, unreadableSourceRows: S.counts.ledger.unreadable, importedRows: imp.length, sourceUsd: usdOf(S.counts.ledger.sourceNano), importedUsd: usdOf(total), match: S.counts.ledger.sourceNano === total && S.counts.ledger.readable === imp.length,
      method: 'every usd value is summed as an integer number of nano-dollars (usd x 1e9, rounded), so the sums are exact; the source sum is taken from the bytes read from starnet/ledger.jsonl, the imported sum from data/legacy/ledger.jsonl after the swap',
      workings: groups, groupSumsEqualTotal: checks,
      attribution: { attributedRows: attributed.length, attributedUsd: usdOf(attributed.reduce((s, r) => s + nano(r.usd), 0)), unattributedRows: imp.length - attributed.length, unattributedUsd: usdOf(total - attributed.reduce((s, r) => s + nano(r.usd), 0)), rule: 'a row takes the jobId of its run; a run is attributed only on explicit evidence: an artifact path or the run title naming one known legacy job id; otherwise jobId null ("unattributed legacy"). No time-window matching.' },
      imageCost: 'not in the legacy ledger rows; unknown'
    },
    counts
  };
}

export function reportMd(r) {
  const L = r.reconciliation.ledger, C = r.reconciliation.counts;
  const tbl = (o) => Object.entries(o).map(([k, v]) => '| ' + k + ' | $' + v.usd.toFixed(7) + ' |').join('\n');
  const lines = [
    '# Legacy import ' + r.stamp, '', '- **Result:** ' + r.result, '- **Source:** ' + r.source + ' (read only)', '- **Data root:** ' + r.dataRoot, '- **Backup:** ' + r.backup, '- ' + r.importJson, '',
    '## Ledger reconciliation', '', '| | rows | USD |', '|---|---|---|',
    '| source `starnet/ledger.jsonl` | ' + (L.sourceRows - L.unreadableSourceRows) + (L.unreadableSourceRows ? ' (+' + L.unreadableSourceRows + ' unreadable)' : '') + ' | $' + L.sourceUsd.toFixed(7) + ' |',
    '| imported `data/legacy/ledger.jsonl` | ' + L.importedRows + ' | $' + L.importedUsd.toFixed(7) + ' |', '', '**Match: ' + (L.match ? 'yes' : 'NO') + '.** ' + L.method + '.', '',
    '### By Dublin day', '', '| day | USD |', '|---|---|', tbl(L.workings.byDublinDay), '', '### By model', '', '| model | USD |', '|---|---|', tbl(L.workings.byModel), '',
    '### By agent', '', '| agent | USD |', '|---|---|', tbl(L.workings.byAgent), '', '### By attribution', '', '| job or attribution | USD |', '|---|---|', tbl(L.workings.byAttribution), '',
    'Each breakdown sums to the total: ' + Object.entries(L.groupSumsEqualTotal).map(([k, v]) => k + ' ' + (v ? 'yes' : 'NO')).join(', ') + '. Attributed: ' + L.attribution.attributedRows + ' rows, $' + L.attribution.attributedUsd.toFixed(7) + '; unattributed: ' + L.attribution.unattributedRows + ' rows, $' + L.attribution.unattributedUsd.toFixed(7) + '. ' + L.attribution.rule + ' Image cost: ' + L.imageCost + '.', '',
    '## Row counts', '', '```json', JSON.stringify(C, null, 2), '```', '',
    '## Disagreements (warnings on the job, not resolved)', '', ...(r.warnings.length ? r.warnings.map((w) => '- `' + w.id + '`: ' + w.warnings.join(' ')) : ['- none']), '',
    '## Changes this run', '', '```json', JSON.stringify({ rows: r.rows, files: { added: r.files.added, changed: r.files.changed.length, keptNotInSource: r.files.keptNotInSource.length, removed: r.files.removed.length }, store: r.store }, null, 2), '```', '',
    '## Refused by name (never opened)', '', ...(r.refusedByName.length ? r.refusedByName.map((x) => '- ' + x) : ['- none']), '', '## Skipped (not-imported list)', '', ...(r.skipped.length ? r.skipped.map((x) => '- ' + x) : ['- none']), ''
  ];
  return lines.join('\n') + '\n';
}
