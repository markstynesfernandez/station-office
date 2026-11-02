// sources/files.mjs — reads a StarNet build from disk (station/config + station-workspace/...) into one raw object.
// READ-ONLY: fs.readFileSync / readdirSync / statSync only. Never writes, never calls the network. Every path read is
// logged through log.read(); every failure through log.error() and recorded in raw.errors so the page can show it.
// The same code serves fixtures/station-root (Phase 1) and the live Virtual-workers folder (Phase 2): only `root` changes.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, stationPaths, isListingId, readLedger, readTracker, rosterList, activeAgents, designPasses, listingPasses, latestDesign, latestIllustration } from '../../lib/legacy-readers/index.mjs';

const exists = (f) => { try { return fs.existsSync(f); } catch (_) { return false; } };
const listDirs = (d) => (exists(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const listFiles = (d) => (exists(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return null; } };

export function readStation(root, log) {
  const raw = { root, readAt: Date.now(), sources: [], errors: [] };
  const note = (file) => { raw.sources.push(file); log.read(file); };
  const fail = (what, err) => { raw.errors.push({ what, error: String(err && err.message || err) }); log.error('read failed: ' + what, { error: String(err && err.message || err) }); };
  const json = (file, what = file) => { note(file); const r = readJsonSafe(file); if (!r.ok) { if (r.err !== 'missing') fail(what, r.err); return null; } return r.v; };
  const text = (file) => { note(file); try { return fs.readFileSync(file, 'utf8'); } catch (e) { fail(file, e); return null; } };

  // config + paths
  const cfgFile = path.join(root, 'station', 'config', 'station.config.json');
  raw.config = json(cfgFile, 'station.config.json') || {};
  const P = raw.config.paths ? stationPaths(root, raw.config) : stationPaths(root, null);
  raw.paths = P;

  // StarNet data root
  raw.roster = json(path.join(P.starnetData, 'agent.roster.json'));
  raw.save = json(path.join(P.starnetData, 'agent.save.json'));
  raw.plan = json(path.join(P.starnetData, 'routing.plan.json'));
  raw.budget = json(path.join(P.starnetData, 'budget.json'));
  raw.lineSpend = json(path.join(P.starnetData, 'line-spend.json'));
  raw.cron = json(path.join(P.starnetData, 'cron.jobs.json'));
  raw.sessions = json(path.join(P.starnetData, 'steptest.sessions.json')) || [];
  raw.triggers = json(path.join(P.starnetData, 'triggers.json'));
  raw.hooks = json(path.join(P.starnetData, 'hooks.json'));
  raw.toolsets = json(path.join(P.starnetData, 'toolsets.json'));
  raw.diagErrors = json(path.join(P.starnetData, 'diag.errors.json')) || [];
  note(P.ledger); try { raw.ledger = readLedger(P.ledger); } catch (e) { fail('ledger.jsonl', e); raw.ledger = []; }
  const runsFile = path.join(P.starnetData, 'runs.jsonl');
  raw.runs = [];
  if (exists(runsFile)) { note(runsFile); for (const line of fs.readFileSync(runsFile, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; try { raw.runs.push(JSON.parse(line)); } catch (_) { /* torn line */ } } }
  // in-flight marker files (one per live run); shape treated as opaque: { runId, agentId?, startedAt? }
  const pendDir = path.join(P.starnetData, '.spend-pending');
  raw.spendPending = listFiles(pendDir).map((n) => ({ file: n, ...(json(path.join(pendDir, n)) || {}) }));
  // notebooks: <agentId>.notebook.json
  raw.notebooks = {};
  for (const n of listFiles(P.starnetData)) { const m = /^(.+)\.notebook\.json$/.exec(n); if (!m) continue; const v = json(path.join(P.starnetData, n)); if (Array.isArray(v)) raw.notebooks[m[1]] = v; }

  // tracker
  note(P.tracker); try { raw.tracker = readTracker(P.tracker); } catch (e) { fail('tracker/listings.csv', e); raw.tracker = []; }

  // research lab: drafts/<date>/*.md (candidate), briefs/*.md (verified), rejected/*.md
  const lab = P.researchLab;
  raw.research = { drafts: [], briefs: [], rejected: [] };
  for (const d of listDirs(path.join(lab, 'drafts'))) for (const f of listFiles(path.join(lab, 'drafts', d))) if (f.endsWith('.md')) { const file = path.join(lab, 'drafts', d, f); raw.research.drafts.push({ id: f.slice(0, -3), file, text: text(file), mtime: mtime(file), day: d }); }
  for (const f of listFiles(P.briefs)) if (f.endsWith('.md')) { const file = path.join(P.briefs, f); raw.research.briefs.push({ id: f.slice(0, -3), file, text: text(file), mtime: mtime(file) }); }
  for (const f of listFiles(path.join(lab, 'rejected'))) if (f.endsWith('.md')) { const file = path.join(lab, 'rejected', f); raw.research.rejected.push({ id: f.slice(0, -3), file, mtime: mtime(file) }); }

  // room 1 work + outbox
  raw.work = {};
  for (const id of listDirs(P.room1Work)) {
    if (!isListingId(id)) continue;
    const dir = path.join(P.room1Work, id); note(dir);
    const files = listFiles(dir);
    const rec = { id, dir, files, mtime: mtime(dir), brief: null, rejected: null, designPasses: [], listingPasses: [], designs: [], illustrations: [], slogan: null };
    if (files.includes('brief.md')) rec.brief = text(path.join(dir, 'brief.md'));
    if (files.includes('REJECTED.md')) rec.rejected = { text: text(path.join(dir, 'REJECTED.md')), mtime: mtime(path.join(dir, 'REJECTED.md')) };
    try { rec.designPasses = designPasses(dir).map((p) => ({ n: p.n, file: p.file, rec: p.rec.ok ? p.rec.v : null, mtime: mtime(p.file) })); } catch (e) { fail('qa passes ' + id, e); }
    try { rec.listingPasses = listingPasses(dir).map((p) => ({ n: p.n, file: p.file, rec: p.rec.ok ? p.rec.v : null, mtime: mtime(p.file) })); } catch (e) { fail('qa-listing passes ' + id, e); }
    for (const f of files) { const m = /^design-v(\d+)\.png$/.exec(f); if (m) rec.designs.push({ n: Number(m[1]), file: f, mtime: mtime(path.join(dir, f)) }); }
    for (const f of files) { const m = /^illustration-v(\d+)\.png$/.exec(f); if (m) rec.illustrations.push({ n: Number(m[1]), file: f, mtime: mtime(path.join(dir, f)) }); }
    rec.designs.sort((a, b) => a.n - b.n); rec.illustrations.sort((a, b) => a.n - b.n);
    rec.latestDesign = latestDesign(P.room1, id); rec.latestIllustration = latestIllustration(P.room1, id);
    const sf = files.filter((f) => /^design-v\d+\.slogan\.json$/.test(f)).sort().pop();
    if (sf) { const s = json(path.join(dir, sf)); rec.slogan = s && (s.slogan || s.picked || null); }
    raw.work[id] = rec;
  }
  raw.outbox = {};
  for (const id of listDirs(P.room1Outbox)) {
    if (!isListingId(id)) continue;
    const dir = path.join(P.room1Outbox, id);
    raw.outbox[id] = { id, dir, listing: json(path.join(dir, 'listing.json')), qaDesign: json(path.join(dir, 'qa-design.json')), qaListing: json(path.join(dir, 'qa-listing.json')), mtime: mtime(dir) };
  }
  // approval queue + rejected packages
  raw.queue = {};
  for (const id of listDirs(P.approvalQueue)) { if (!isListingId(id)) continue; const dir = path.join(P.approvalQueue, id); raw.queue[id] = { id, dir, manifest: json(path.join(dir, 'MANIFEST.json')), cost: json(path.join(dir, 'cost.json')), files: listFiles(dir), mtime: mtime(dir) }; }
  raw.rejectedPkgs = {};
  for (const id of listDirs(P.rejected)) { if (!isListingId(id)) continue; const dir = path.join(P.rejected, id); const rf = path.join(dir, 'REJECTED.md'); raw.rejectedPkgs[id] = { id, dir, manifest: json(path.join(dir, 'MANIFEST.json')), rejected: exists(rf) ? text(rf) : null, mtime: mtime(rf) || mtime(dir) }; }

  // overseer reports (decision 8: "No report yet" when empty)
  const repDir = path.join(P.overseer, 'reports');
  raw.overseerReports = listFiles(repDir).filter((f) => !f.startsWith('.')).map((f) => ({ file: f, mtime: mtime(path.join(repDir, f)) })).sort((a, b) => b.mtime - a.mtime);
  if (raw.overseerReports.length) { const f = path.join(repDir, raw.overseerReports[0].file); raw.overseerReports[0].text = (text(f) || '').slice(0, 4000); }
  note(repDir);

  raw.activeAgentIds = activeAgents(rosterList(raw.roster || [])).map((a) => a.agentId);
  log.info('station read', { root, sources: raw.sources.length, errors: raw.errors.length, agents: raw.activeAgentIds.length, work: Object.keys(raw.work).length, sessions: raw.sessions.length });
  return raw;
}

// Resolve an image request to a file inside the station (jailed: listing id grammar + a fixed file-name grammar).
export function resolveImage(paths, where, id, file) {
  if (!isListingId(id) || !/^(design|illustration)-v\d+\.png$|^design-original\.png$/.test(file)) return null;
  const base = where === 'queue' ? paths.approvalQueue : where === 'rejected' ? paths.rejected : paths.room1Work;
  const f = path.join(base, id, file);
  return exists(f) ? f : null;
}
