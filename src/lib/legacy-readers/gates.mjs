// gates.mjs — the pure read helpers of the station's package gate.
// Source: Virtual-workers/station/scripts/lib/gates.mjs (owner-written). Copied: designPasses, briefUsdRange.
// NOT copied: checkPackage and its fee / contrast / policy imports (not needed by a viewer; the gate's verdict is read
// from the tracker's status and status_reason instead).
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from './common.mjs';

// design QA passes on disk, sorted by pass number
export function designPasses(workDir) {
  const qdir = path.join(workDir, 'qa');
  if (!fs.existsSync(qdir)) return [];
  return fs.readdirSync(qdir).map((n) => /^design-pass(\d+)\.json$/.exec(n)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), file: path.join(qdir, m[0]) })).sort((a, b) => a.n - b.n)
    .map((x) => ({ ...x, rec: readJsonSafe(x.file) }));
}

// listing QA passes on disk (work/<id>/qa-listing/passN.json), same shape as designPasses. Office addition, same pattern.
export function listingPasses(workDir) {
  const qdir = path.join(workDir, 'qa-listing');
  if (!fs.existsSync(qdir)) return [];
  return fs.readdirSync(qdir).map((n) => /^pass(\d+)\.json$/.exec(n)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), file: path.join(qdir, m[0]) })).sort((a, b) => a.n - b.n)
    .map((x) => ({ ...x, rec: readJsonSafe(x.file) }));
}

// first USD range (or single price) in the brief's "## Price range" section; null when there is none
export function briefUsdRange(briefText) {
  const i = String(briefText || '').indexOf('## Price range');
  if (i < 0) return null;
  const j = briefText.indexOf('\n## ', i + 5);
  const sec = briefText.slice(i, j < 0 ? undefined : j);
  if (/^## Price range\s*\n\s*UNKNOWN/i.test(sec)) return null;   // an UNKNOWN price has no range, even if the text quotes a cost
  const m = /USD\s*([\d]+(?:\.\d+)?)\s*(?:[–—-]|to)\s*(?:USD\s*)?([\d]+(?:\.\d+)?)/i.exec(sec) || /USD\s*([\d]+(?:\.\d+)?)/i.exec(sec);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2] !== undefined ? m[2] : m[1]) };
}
