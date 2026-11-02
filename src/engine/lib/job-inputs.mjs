// lib/job-inputs.mjs — FROZEN JOB INPUTS (owner, 18/10/2026; DECISIONS.md "E6 wrap-up"). The bug it fixes: on the first full live line
// the owner's amendment to brief item 4 was written into the running job's brief.md, and products.json changed under the job (the stale
// colour-variant spec), so QA DESIGN judged a set against inputs the DESIGNER never saw. Now:
//   freezeInputs   at job start the station snapshots the brief and the job's product spec into jobs/<id>/inputs/ (brief.md,
//                  products.json, then SNAPSHOT.json with both sha256). Once SNAPSHOT.json exists the folder is frozen: the data jail
//                  refuses every write into it (store/jail.mjs), so editing a running job's snapshot is refused
//   checkInputs    the snapshot against its SNAPSHOT.json (a file changed outside the station fails closed before any agent step)
//   addAmendment   an owner amendment is a separate dated record, jobs/<id>/amendments/NNN-<YYYY-MM-DD>.md, created once and never
//                  overwritten; agents read every amendment alongside the snapshot, and the QA records list them (amendmentRefs)
// Agents read only the snapshot: fs_read of brief.md and products.json is served from inputs/ (tools/index.mjs), and the orchestrator's
// own reads of the brief and the spec for a job come from it too. Station code only, no model.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './common.mjs';
import { dataJail } from '../store/active.mjs';

export const INPUTS_DIR = 'inputs', SNAPSHOT_FILE = 'SNAPSHOT.json', AMENDMENTS_DIR = 'amendments';
export const AMENDMENT_RE = /^(\d{3})-(\d{4}-\d{2}-\d{2})\.md$/;
const inputsDir = (roomDir, id) => path.join(roomDir, 'jobs', id, INPUTS_DIR);
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

export const isFrozen = (roomDir, id) => fs.existsSync(path.join(inputsDir(roomDir, id), SNAPSHOT_FILE));

// the snapshot of one job: { ok, frozen: false } (none yet) | { ok, frozen: true, brief, productsFile, products, record } | { ok: false, reason }
export function readInputs(roomDir, id) {
  const d = inputsDir(roomDir, id), rec = readJson(path.join(d, SNAPSHOT_FILE));
  if (!rec) return fs.existsSync(path.join(d, SNAPSHOT_FILE)) ? { ok: false, reason: 'jobs/' + id + '/inputs/SNAPSHOT.json is not valid JSON' } : { ok: true, frozen: false };
  const brief = readText(path.join(d, 'brief.md')), pf = readText(path.join(d, 'products.json'));
  if (brief === null || pf === null) return { ok: false, reason: 'jobs/' + id + '/inputs/ is missing ' + (brief === null ? 'brief.md' : 'products.json') };
  if (sha256(brief) !== rec.brief.sha256) return { ok: false, reason: 'jobs/' + id + '/inputs/brief.md differs from its snapshot (SNAPSHOT.json sha256): the frozen brief was edited; record the change as an owner amendment instead' };
  if (sha256(pf) !== rec.products.sha256) return { ok: false, reason: 'jobs/' + id + '/inputs/products.json differs from its snapshot (SNAPSHOT.json sha256): the frozen spec was edited; record the change as an owner amendment instead' };
  let productsFile; try { productsFile = JSON.parse(pf); } catch (e) { return { ok: false, reason: 'jobs/' + id + '/inputs/products.json is not valid JSON' }; }
  return { ok: true, frozen: true, brief, productsFile, products: productsFile.products || [], record: rec };
}
export const checkInputs = (roomDir, id) => { const r = readInputs(roomDir, id); return r.ok ? { ok: true, frozen: r.frozen } : r; };

// at job start: brief.md and the job's own product entry, then SNAPSHOT.json last (it freezes the folder). Idempotent: an existing intact
// snapshot is kept as it is (never re-frozen from newer files); a broken one is refused.
export function freezeInputs({ J, roomDir, id, briefText, products, productKey, by = 'station', note = null, log = null }) {
  const cur = readInputs(roomDir, id);
  if (!cur.ok) return cur;
  if (cur.frozen) return { ok: true, action: 'kept', record: cur.record };
  const product = (products || []).find((p) => p.key === productKey) || null;
  if (!product) return { ok: false, reason: 'product ' + (productKey || '(none)') + ' is not in products.json: nothing to freeze' };
  const d = inputsDir(roomDir, id), brief = String(briefText || '').replace(/\r\n/g, '\n');
  const pf = JSON.stringify({ $comment: 'FROZEN at job start (owner, 18/10/2026): the product spec this job runs on, from config/products.json. Never edited; an owner change is an amendment (jobs/' + id + '/amendments/).', products: [product] }, null, 2) + '\n';
  J.put(path.join(d, 'brief.md'), brief);
  J.put(path.join(d, 'products.json'), pf);
  const record = { listingId: id, frozenAt: new Date().toISOString(), by, ...(note ? { note } : {}), brief: { file: INPUTS_DIR + '/brief.md', sha256: sha256(brief) }, products: { file: INPUTS_DIR + '/products.json', productKey, sha256: sha256(pf) },
    rule: 'Agents read only these files and the owner amendments in ' + AMENDMENTS_DIR + '/. This folder is frozen: the station refuses any write into it.' };
  J.put(path.join(d, SNAPSHOT_FILE), JSON.stringify(record, null, 1) + '\n');
  if (log) log.info('job inputs frozen', { jobId: id, productKey, brief: record.brief.sha256.slice(0, 12), products: record.products.sha256.slice(0, 12), by });
  return { ok: true, action: 'frozen', record };
}

// the owner amendments, oldest first: [{ file, n, date, sha256, text }]
export function listAmendments(roomDir, id) {
  const d = path.join(roomDir, 'jobs', id, AMENDMENTS_DIR); if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => AMENDMENT_RE.test(f)).sort().map((f) => { const m = AMENDMENT_RE.exec(f), text = fs.readFileSync(path.join(d, f), 'utf8'); return { file: AMENDMENTS_DIR + '/' + f, n: Number(m[1]), date: m[2], sha256: sha256(text), text }; });
}
// what a QA record lists (no text): [{ file, date, sha256 }]
export const amendmentRefs = (roomDir, id) => listAmendments(roomDir, id).map(({ file, date, sha256: s }) => ({ file, date, sha256: s }));

// a new dated amendment, numbered after the last one; created exclusively (never overwrites a record)
export function addAmendment({ roomDir, id, text, date, by = 'owner', log = null }) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, reason: 'an amendment needs its text (the owner\'s words)' };
  if (body.length > 8000) return { ok: false, reason: 'an amendment is at most 8,000 characters' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, reason: 'date must be YYYY-MM-DD' };
  const prev = listAmendments(roomDir, id), n = prev.length ? Math.max(...prev.map((a) => a.n)) + 1 : 1;
  if (n > 999) return { ok: false, reason: 'too many amendments' };
  const name = String(n).padStart(3, '0') + '-' + date + '.md', d = path.join(roomDir, 'jobs', id, AMENDMENTS_DIR), f = path.join(d, name);
  const content = '# Owner amendment ' + String(n).padStart(3, '0') + ' (' + date + ', ' + by + ')\n\n' + body + '\n';
  fs.mkdirSync(dataJail(d), { recursive: true });
  fs.writeFileSync(dataJail(f), content, { flag: 'wx' });
  if (log) log.info('owner amendment recorded', { jobId: id, file: AMENDMENTS_DIR + '/' + name, by });
  return { ok: true, file: AMENDMENTS_DIR + '/' + name, n, date, sha256: sha256(content) };
}

// the note every line agent gets with its input: each amendment in full, after the snapshot
export function amendmentsNote(roomDir, id) {
  const as = listAmendments(roomDir, id); if (!as.length) return '';
  return '\n\nOWNER AMENDMENTS to the frozen brief and product spec (work/' + id + '/' + AMENDMENTS_DIR + '/; read them with brief.md and products.json: where an amendment names a point, it overrules the snapshot and any earlier amendment on that point, nothing else):\n'
    + as.map((a) => '--- ' + a.file + ' (' + a.date + ') ---\n' + a.text.trim()).join('\n');
}
