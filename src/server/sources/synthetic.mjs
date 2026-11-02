// sources/synthetic.mjs — applies fixtures/synthetic/overlay.json on top of a FIXTURES read (never a live one).
// The overlay holds the desk and job states the real snapshot does not contain (working, error, waiting, blocked),
// each record tagged synthetic:true so the model and the page can label it. Pure apart from reading the overlay file.
import fs from 'node:fs';
import { COLUMNS } from '../../lib/legacy-readers/index.mjs';

// '@-16m' -> epoch ms 16 minutes before `now`; '@iso-16m' -> the same as an ISO string. Anything else is left as is.
export function resolveTimes(v, now) {
  if (typeof v === 'string') { const m = /^@(iso)?([+-]\d+)m$/.exec(v); if (!m) return v; const t = now + Number(m[2]) * 60000; return m[1] ? new Date(t).toISOString() : t; }
  if (Array.isArray(v)) return v.map((x) => resolveTimes(x, now));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveTimes(x, now)]));
  return v;
}

export function readOverlay(file, log) {
  if (!fs.existsSync(file)) return null;
  log.read(file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log.error('synthetic overlay unreadable', { file, error: e.message }); return null; }
}

export function applySynthetic(raw, overlay, { now }) {
  if (raw.mode !== 'fixtures') throw new Error('the synthetic overlay is for the fixtures mock only, never a live root');
  if (!overlay || !Array.isArray(overlay.items)) return raw;
  const tag = (o, what) => ({ ...o, synthetic: true, syntheticWhat: what });
  raw.synthetic = [];
  for (const item of overlay.items) {
    const it = resolveTimes(item, now), what = it.what;
    raw.synthetic.push(what);
    for (const s of it.sessions || []) raw.sessions.push(tag(s, what));
    for (const r of it.runs || []) raw.runs.push(tag(r, what));
    for (const p of it.spendPending || []) raw.spendPending.push(tag(p, what));
    for (const q of it.queue || []) raw.queue[q.id] = tag({ dir: null, files: [], ...q }, what);
    for (const t of it.tracker || []) raw.tracker.push(tag(Object.fromEntries(COLUMNS.map((c) => [c, t[c] == null ? '' : String(t[c])])), what));
  }
  return raw;
}
