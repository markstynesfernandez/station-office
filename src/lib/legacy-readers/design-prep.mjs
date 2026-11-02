// design-prep.mjs — which design files exist for a job.
// Source: Virtual-workers/station/scripts/lib/design-prep.mjs (owner-written). Copied: latestIllustration.
// NOT copied: pendingDesign, prepareDesign, runDesignHook (they compose files and run print-check).
import fs from 'node:fs';
import path from 'node:path';

export function latestIllustration(roomDir, id) {
  const dir = path.join(roomDir, 'work', id); if (!fs.existsSync(dir)) return 0;
  return Math.max(0, ...fs.readdirSync(dir).map((f) => /^illustration-v(\d+)\.png$/.exec(f)).filter(Boolean).map((m) => Number(m[1])));
}

// Office addition (same pattern): the newest composed design, work/<id>/design-vN.png, or 0 when there is none.
export function latestDesign(roomDir, id) {
  const dir = path.join(roomDir, 'work', id); if (!fs.existsSync(dir)) return 0;
  return Math.max(0, ...fs.readdirSync(dir).map((f) => /^design-v(\d+)\.png$/.exec(f)).filter(Boolean).map((m) => Number(m[1])));
}
