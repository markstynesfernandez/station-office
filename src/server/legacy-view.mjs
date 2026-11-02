// legacy-view.mjs — the imported legacy station (data/legacy/, written only by npm run import-legacy) as the office
// shows it: legacy jobs on the board and in the job panel, the legacy notebooks in the memory-core viewer, and the
// legacy ledger next to the engine's. READ ONLY. The legacy rows are history: they never reach the spend guard, the
// caps or an agent's prompt (owner Q9). Cached per import (the mtime of data/import/IMPORT.json).
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch (_) { return []; } };
// the engine's column for a legacy agent's runs (by the mapped engine agent key)
const COLUMN_OF_AGENT = { 'demand-researcher': 'brief', 'evidence-checker': 'brief', designer: 'design', 'qa-design': 'qa-design', lister: 'listing', 'qa-listing': 'qa-listing', 'rejects-desk': 'rejected', overseer: null };

function listFiles(dir, base = dir, out = [], max = 400) {
  if (!fs.existsSync(dir) || out.length >= max) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(f, base, out, max); else out.push(path.relative(base, f).replace(/\\/g, '/'));
    if (out.length >= max) break;
  }
  return out;
}

export function loadLegacy(dataRoot) {
  const dir = path.join(dataRoot, 'legacy'), imp = path.join(dataRoot, 'import', 'IMPORT.json');
  let stamp = null; try { stamp = fs.statSync(imp).mtimeMs; } catch (_) { return null; }
  const hit = cache.get(dataRoot); if (hit && hit.stamp === stamp) return hit.data;
  const agents = (readJson(path.join(dir, 'agents.json')) || {}).agents || {};
  const runs = readJsonl(path.join(dir, 'runs.jsonl')), ledger = readJsonl(path.join(dir, 'ledger.jsonl'));
  const notebooks = [];
  const nbDir = path.join(dir, 'notebooks');
  if (fs.existsSync(nbDir)) for (const f of fs.readdirSync(nbDir).filter((n) => n.endsWith('.notebook.json')).sort()) {
    const id = f.replace(/\.notebook\.json$/, ''), list = readJson(path.join(nbDir, f));
    notebooks.push({ legacyAgentId: id, agent: (agents[id] && agents[id].name) || id, agentKey: agents[id] ? agents[id].agentKey : null, records: Array.isArray(list) ? list : [] });
  }
  const meta = readJson(imp) || {};
  const data = { dir, stamp, agents, runs, ledger, notebooks, importedAt: meta.importedAt || null, runsByJob: runs.reduce((o, r) => { if (r.jobId) (o[r.jobId] ||= []).push(r); return o; }, {}), ledgerUsd: ledger.reduce((s, r) => s + Math.round((Number(r.usd) || 0) * 1e9), 0) / 1e9 };
  cache.set(dataRoot, { stamp, data });
  return data;
}

// one legacy job (a store row with legacy = 1) in the same shape as an engine job in the snapshot
export function legacyJobView(j, L, { nameOf = {}, deptOf = {} } = {}) {
  const g = (j.data && j.data.legacy) || {};
  const dir = path.join(L.dir, 'jobs', j.id);
  const runs = (L.runsByJob[j.id] || []).slice().sort((a, b) => (a.startedAt || a.ts || 0) - (b.startedAt || b.ts || 0));
  const count = {};
  const hops = runs.map((r, i) => { const k = r.agentKey || r.legacyAgentId; count[k] = (count[k] || 0) + 1; return { i, agentId: k, agentName: r.agentName || nameOf[k] || r.legacyAgentId, stage: COLUMN_OF_AGENT[r.agentKey] || null, pass: null, run: count[k], verdict: null, usd: r.usd, ms: r.durationMs ?? null, output: r.reason && r.reason !== 'done' ? r.reason + (r.failureCode ? ': ' + r.failureCode : '') : null, live: false, at: r.endedAt || r.ts || null, runId: r.runId, legacy: true }; });
  const qa = (sub, re) => (fs.existsSync(path.join(dir, 'work', sub)) ? fs.readdirSync(path.join(dir, 'work', sub)).map((f) => re.exec(f)).filter(Boolean).map((m) => ({ n: Number(m[1]), rec: readJson(path.join(dir, 'work', sub, m[0])) })).sort((a, b) => a.n - b.n).map((p) => ({ pass: p.n, verdict: p.rec && p.rec.verdict, reasons: ((p.rec && p.rec.reasons) || []).slice(0, 3) })) : []);
  const files = listFiles(dir);
  const images = files.filter((f) => /^(work\/(design|illustration)-v\d+\.png|work\/set-v\d+\/raw\/[^/]+\.png|(package|rejected)\/design-original\.png)$/.test(f))
    .map((f) => { const st = fs.statSync(path.join(dir, f)); const v = /-v(\d+)/.exec(f); return { url: '/api/office/image/legacy/' + j.id + '/' + f, file: f, n: v ? Number(v[1]) : 0, at: st.mtimeMs }; });
  const lj = readJson(path.join(dir, 'outbox', 'listing.json'));
  const mf = readJson(path.join(dir, 'package', 'MANIFEST.json'));
  const lane = g.lane || null, stage = g.stage || 'brief';
  const status = lane || (stage === 'done' ? 'done' : 'legacy');
  const last = [...hops].reverse().find((h) => h.agentId && nameOf[h.agentId]);
  const agentId = last ? last.agentId : null;
  const reason = j.reason || (g.rejected && g.rejected.firstLine) || null;
  return {
    id: j.id, title: j.title || j.id, niche: g.niche || null, slogan: null, briefStatus: null, priceRange: null, stage, lane, status, flag: null, statusReason: reason,
    agentId, agentName: agentId ? nameOf[agentId] : null, dept: agentId && deptOf[agentId] ? deptOf[agentId].key : null,
    hops, files: files.map((f) => 'legacy/jobs/' + j.id + '/' + f), images, costUsd: g.ledgerUsd ?? null, costSource: 'legacy ledger rows for this job; image cost not recorded',
    startedAt: j.started_at || j.created_at, updatedAt: j.updated_at, endedAt: j.ended_at || null, stageChangedAt: j.ended_at || j.updated_at || j.created_at, elapsedMs: null, progress: null,
    tracker: g.tracker, queue: mf ? { status: 'parked (legacy approval queue; not pending, owner Q11)', queuedAt: null, version: null, costUsd: typeof mf.costUsd === 'number' ? mf.costUsd : null, files: Array.isArray(mf.files) ? mf.files.length : null, folder: 'legacy/jobs/' + j.id + '/package/' } : null,
    listing: lj ? { title: lj.title, tags: (lj.tags || []).length, priceEur: lj.listingPriceEur ?? null } : null,
    qaDesign: qa('qa', /^design-pass(\d+)\.json$/), qaListing: qa('qa-listing', /^pass(\d+)\.json$/),
    warnings: g.warnings || [], synthetic: false, rejectedBy: j.state === 'rejected_by_owner' ? 'owner' : j.state === 'rejected' ? 'archived' : null,
    line: j.line, kind: 'legacy', state: j.state, step: null, loops: {}, version: j.version, lastStage: null, productFiles: null, folder: 'legacy/jobs/' + j.id + '/',
    legacy: { system: g.system || 'legacy station', room: g.room || null, sources: g.sources || {}, rejected: g.rejected || null, trackerStatus: g.tracker ? g.tracker.status : null, importedAt: L.importedAt, runs: runs.length }
  };
}

// the memory-core viewer: legacy notebook records (read-only history)
export function legacyMemory(L) {
  if (!L) return null;
  const all = L.notebooks.flatMap((n) => n.records.map((r) => ({ agent: n.agent, agentKey: n.agentKey, kind: r.kind || null, body: String(r.body || r.content || '').slice(0, 220), lastUsedAt: r.lastUsedAt || null, useCount: r.useCount ?? null, createdAt: r.createdAt || r.ts || null })));
  const newest = all.filter((r) => r.lastUsedAt).sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] || null;
  return {
    entries: all.length, byAgent: Object.fromEntries(L.notebooks.filter((n) => n.records.length).map((n) => [n.agent, n.records.length])),
    lastRecalledBy: newest ? newest.agent : null, lastRecalledAt: newest ? newest.lastUsedAt : null,
    recent: all.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0)).slice(0, 14),
    source: 'data/legacy/notebooks (imported legacy history, read only; not fed to agents, owner Q9)'
  };
}
