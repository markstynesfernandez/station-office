// snapshot-fixtures.mjs — takes a READ-ONLY snapshot of the real StarNet build into office-agents/fixtures/station-root/
// so the mock runs on real shapes and real values (review round 1). Usage:
//   npm run snapshot-fixtures                       (source: ../Virtual-workers, or STATION_LEGACY_ROOT)
//   node scripts/snapshot-fixtures.mjs --from <path-to-Virtual-workers>
// Rules it enforces on itself:
//  - the source is only ever read (readFileSync / readdirSync / statSync); nothing is written there, ever
//  - every write goes through jail(), which refuses any path outside office-agents/fixtures/
//  - secrets are never opened: .secrets/, .env, provider-keys*.json and .git/ are refused by name before any read
//  - prompts are not copied: the roster's `system` field and runs' `deliveryPrompt` are dropped, the save is trimmed
//  - images are copied only as downscaled PNG thumbnails (sharp, max 384 px), under their original names
//  - file and folder mtimes are carried over (the readers use them for dates)
// Idempotent: it builds fixtures/station-root.staging/, then swaps it in for fixtures/station-root/ and rewrites
// fixtures/SNAPSHOT.json. fixtures/synthetic/ (the hand-written test-state overlay) is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../src/server/log.mjs';
import { loadEnv, isListingId } from '../src/lib/legacy-readers/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const OUT_ROOT = path.resolve(ROOT, 'fixtures');
const STAGE = 'station-root.staging', FINAL = 'station-root';
const THUMB_PX = 384;
const FORBIDDEN_SOURCE = /(^|[\\/])\.secrets([\\/]|$)|(^|[\\/])\.env(\.|$)|provider-keys[^\\/]*$|(^|[\\/])\.git([\\/]|$)/i;

// ---- the only way this script writes: a path inside office-agents/fixtures/ (never fixtures/ itself or fixtures/synthetic/)
export function jail(rel) {
  const f = path.resolve(OUT_ROOT, rel);
  if (!f.startsWith(OUT_ROOT + path.sep)) throw new Error('refusing to write outside fixtures/: ' + rel);
  if (f === path.join(OUT_ROOT, 'synthetic') || f.startsWith(path.join(OUT_ROOT, 'synthetic') + path.sep)) throw new Error('refusing to write into fixtures/synthetic/: ' + rel);
  return f;
}
// ---- the only way this script reads: a path inside the source root that is not a secret
export function sourcePath(srcRoot, rel) {
  const f = path.resolve(srcRoot, rel);
  if (!(f === srcRoot || f.startsWith(srcRoot + path.sep))) throw new Error('refusing to read outside the source root: ' + rel);
  if (FORBIDDEN_SOURCE.test(path.relative(srcRoot, f))) throw new Error('refusing to read a secret or VCS path: ' + rel);
  return f;
}

function resolveSource(argv) {
  const i = argv.indexOf('--from');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  loadEnv(path.join(ROOT, '.env'));
  if (process.env.STATION_LEGACY_ROOT) return path.resolve(process.env.STATION_LEGACY_ROOT);
  return path.resolve(ROOT, '..', 'Virtual-workers');
}

export async function snapshot({ from, log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'snapshot-fixtures' }) } = {}) {
  const SRC = path.resolve(from);
  if (!fs.existsSync(path.join(SRC, 'station-workspace', 'starnet'))) throw new Error('not a StarNet build (no station-workspace/starnet): ' + SRC);
  const real = (p) => fs.realpathSync.native(p).toLowerCase();
  if (real(ROOT).startsWith(real(SRC) + path.sep) || real(SRC).startsWith(real(OUT_ROOT))) throw new Error('source and office-agents/fixtures must not overlap');
  const { default: sharp } = await import('sharp');
  const stats = { files: 0, bytes: 0, thumbnails: 0, skipped: [], dirs: [] };
  const stage = (rel) => path.join(STAGE, rel);

  // ---- read helpers (source side: read, list, stat only)
  const rd = (rel) => { const f = sourcePath(SRC, rel); log.read(f); return fs.readFileSync(f); };
  const st = (rel) => { try { return fs.statSync(sourcePath(SRC, rel)); } catch (_) { return null; } };
  const ls = (rel) => { const f = sourcePath(SRC, rel); if (!fs.existsSync(f)) return []; log.read(f); return fs.readdirSync(f, { withFileTypes: true }); };
  // ---- write helpers (fixtures side, every call through jail())
  function put(rel, buf, srcRel) {
    fs.mkdirSync(jail(path.dirname(stage(rel))), { recursive: true });
    fs.writeFileSync(jail(stage(rel)), buf);
    const s = srcRel ? st(srcRel) : null;
    if (s) fs.utimesSync(jail(stage(rel)), s.atime, s.mtime);
    stats.files++; stats.bytes += buf.length; log.written(jail(stage(rel)), { bytes: buf.length });
  }
  const copy = (rel, transform) => { const s = st(rel); if (!s || !s.isFile()) { stats.skipped.push(rel + ' (missing)'); return; } const buf = rd(rel); put(rel, transform ? transform(buf) : buf, rel); };
  const json = (fn) => (buf) => Buffer.from(JSON.stringify(fn(JSON.parse(buf.toString('utf8'))), null, 2) + '\n');
  async function thumb(rel) {
    const buf = rd(rel);
    try { const out = await sharp(buf, { limitInputPixels: 40000 * 40000 }).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer(); put(rel, out, rel); stats.thumbnails++; }
    catch (e) { stats.skipped.push(rel + ' (thumbnail failed: ' + e.message + ')'); log.error('thumbnail failed', { rel, error: e.message }); }
  }
  const keepDir = (rel) => { stats.dirs.push(rel); };

  fs.rmSync(jail(STAGE), { recursive: true, force: true });
  fs.mkdirSync(jail(STAGE), { recursive: true });

  // ---- station config (paths, agents, floorRooms, models; prices are internal and stay internal)
  copy('station/config/station.config.json');

  // ---- StarNet data root
  const SN = 'station-workspace/starnet';
  copy(SN + '/agent.roster.json', json((r) => ({ ...r, agents: (r.agents || []).map(({ system, ...a }) => a) })));
  copy(SN + '/agent.save.json', json((s) => {
    const doc = s.doc || {};
    const trimAgent = (a) => ({ id: a.id, name: a.name, color: a.color, model: a.model, provider: a.provider, role: a.role });
    const agents = Array.isArray(doc.agents) ? doc.agents.map(trimAgent) : Object.fromEntries(Object.entries(doc.agents || {}).map(([k, a]) => [k, trimAgent(a)]));
    const stn = doc.station || {};
    return { version: s.version, agentId: s.agentId, updatedAt: s.updatedAt, savedAt: s.savedAt, doc: { schema: doc.schema, version: doc.version, updatedAt: doc.updatedAt, prov: doc.prov, agents, station: { schema: stn.schema, version: stn.version, meta: stn.meta, rooms: stn.rooms, order: stn.order, props: stn.props } } };
  }));
  for (const f of ['routing.plan.json', 'budget.json', 'line-spend.json', 'cron.jobs.json', 'triggers.json', 'hooks.json', 'toolsets.json', 'diag.errors.json', 'steptest.sessions.json', 'ledger.jsonl']) copy(SN + '/' + f);
  copy(SN + '/runs.jsonl', (buf) => Buffer.from(buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { const { deliveryPrompt, ...r } = JSON.parse(l); return JSON.stringify(r); } catch (_) { return null; } }).filter(Boolean).join('\n') + '\n'));
  for (const e of ls(SN)) if (e.isFile() && /^[A-Za-z0-9_-]+\.notebook\.json$/.test(e.name)) copy(SN + '/' + e.name);
  keepDir(SN + '/.spend-pending');
  for (const e of ls(SN + '/.spend-pending')) if (e.isFile() && e.name.endsWith('.json')) copy(SN + '/.spend-pending/' + e.name);

  // ---- tracker
  copy('station-workspace/tracker/listings.csv');

  // ---- per-job folders: text/JSON metadata copied, images as thumbnails, archives and derived print files skipped
  async function jobTree(base, { subdirs = [] } = {}) {
    keepDir(base);
    for (const d of ls(base)) {
      if (!d.isDirectory() || !isListingId(d.name)) { if (d.isDirectory()) stats.skipped.push(base + '/' + d.name + ' (not a listing id)'); continue; }
      const dir = base + '/' + d.name; keepDir(dir);
      for (const e of ls(dir)) {
        const rel = dir + '/' + e.name;
        if (e.isFile()) { if (/\.(md|json|csv|txt)$/i.test(e.name)) copy(rel); else if (/\.png$/i.test(e.name)) await thumb(rel); else stats.skipped.push(rel); }
        else if (e.isDirectory() && subdirs.includes(e.name)) { keepDir(rel); for (const f of ls(rel)) if (f.isFile() && /\.(json|md)$/i.test(f.name)) copy(rel + '/' + f.name); }
        else if (e.isDirectory()) stats.skipped.push(rel + '/ (folder not needed by the office)');
      }
    }
  }
  await jobTree('station-workspace/room1-etsy/work', { subdirs: ['qa', 'qa-listing', 'derived'] });
  await jobTree('station-workspace/room1-etsy/outbox');
  await jobTree('station-workspace/approval-queue', { subdirs: ['qa-history'] });
  await jobTree('station-workspace/rejected', { subdirs: ['qa-history'] });

  // ---- research lab
  const LAB = 'station-workspace/research-lab';
  keepDir(LAB); copy(LAB + '/products.json');
  for (const sub of ['briefs', 'rejected']) { keepDir(LAB + '/' + sub); for (const e of ls(LAB + '/' + sub)) if (e.isFile() && e.name.endsWith('.md')) copy(LAB + '/' + sub + '/' + e.name); }
  keepDir(LAB + '/drafts');
  for (const d of ls(LAB + '/drafts')) if (d.isDirectory()) { keepDir(LAB + '/drafts/' + d.name); for (const e of ls(LAB + '/drafts/' + d.name)) if (e.isFile() && e.name.endsWith('.md')) copy(LAB + '/drafts/' + d.name + '/' + e.name); }

  // ---- overseer reports (decision 8: an empty folder means "No report yet")
  keepDir('station-workspace/overseer/reports');
  for (const e of ls('station-workspace/overseer/reports')) if (e.isFile() && !e.name.startsWith('.')) copy('station-workspace/overseer/reports/' + e.name);

  // ---- folders: create the empty ones, then carry folder mtimes over (deepest first, after all files are in)
  for (const rel of stats.dirs) fs.mkdirSync(jail(stage(rel)), { recursive: true });
  for (const rel of [...stats.dirs].sort((a, b) => b.length - a.length)) { const s = st(rel); if (s) fs.utimesSync(jail(stage(rel)), s.atime, s.mtime); }

  // ---- swap in, then write the manifest
  fs.rmSync(jail(FINAL), { recursive: true, force: true });
  fs.renameSync(jail(STAGE), jail(FINAL));
  const takenAt = Date.now();
  const manifest = {
    takenAt: new Date(takenAt).toISOString(), takenAtMs: takenAt, source: path.basename(SRC), files: stats.files, bytes: stats.bytes, thumbnails: stats.thumbnails,
    redactions: ['agent.roster.json: `system` (agent prompts) removed from every agent', 'agent.save.json: trimmed to doc.station (meta, rooms, order, props) and doc.agents id/name/color/model/provider/role', 'runs.jsonl: `deliveryPrompt` removed', 'images: PNG thumbnails, max ' + THUMB_PX + ' px, under the original file names'],
    notCopied: ['.secrets/, .env, provider keys, .git/ (refused by name)', 'transcripts, checkpoints, task briefs, verdict packets, backups (*.bak, *.pre-*)', 'work/*/rerun-archive-*/ and derived print PNGs', 'research-lab/scouting, overseer/metrics'],
    skipped: stats.skipped,
    note: 'Read-only snapshot of the real StarNet files for the Station legacy-view mock. Nothing was written to the source. In fixtures mode the server uses takenAtMs as "now" so the views are reproducible.'
  };
  fs.writeFileSync(jail('SNAPSHOT.json'), JSON.stringify(manifest, null, 2) + '\n');
  log.written(jail('SNAPSHOT.json'));
  log.info('snapshot written', { source: path.basename(SRC), files: stats.files, mb: +(stats.bytes / 1048576).toFixed(2), thumbnails: stats.thumbnails, skipped: stats.skipped.length });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = resolveSource(process.argv.slice(2));
  snapshot({ from }).then((m) => { console.log('fixtures/station-root/ <- ' + m.source + ' (read-only): ' + m.files + ' files, ' + m.thumbnails + ' thumbnails, taken ' + m.takenAt); })
    .catch((e) => { console.error('snapshot failed:', e.message); process.exitCode = 1; });
}
