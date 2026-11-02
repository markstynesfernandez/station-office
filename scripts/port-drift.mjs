// port-drift.mjs — read-only check: has any legacy source we ported changed since the port moment? Reads the sha256
// list in PORTED.md, hashes the same files in the legacy build now (STATION_LEGACY_ROOT, default ../Virtual-workers,
// under station/), and prints unchanged / CHANGED / MISSING per file. Reads only: it writes nothing anywhere, runs
// nothing from the legacy build and makes no network call. Safe to run any time.
//   npm run port-drift              report (exit 0)
//   node scripts/port-drift.mjs --strict   exit 1 when anything drifted (for a check before a re-port)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, defaultLegacyRoot } from '../src/engine/store/jail.mjs';

const LINE = /^([0-9a-f]{64}) \*?(\S+)\s*$/;

export function readPorted(file = path.join(APP_ROOT, 'PORTED.md')) {
  const text = fs.readFileSync(file, 'utf8');
  const moment = (/^Port moment: (\S+)/m.exec(text) || [])[1] || null;
  const block = /```sha256\n([\s\S]*?)```/.exec(text.replace(/\r\n/g, '\n'));
  if (!block) throw new Error('PORTED.md has no ```sha256 block');
  const entries = block[1].split('\n').map((l) => LINE.exec(l.trim())).filter(Boolean).map((m) => ({ sha256: m[1], source: m[2] }));
  return { moment, entries };
}

export function drift({ legacyRoot = process.env.STATION_LEGACY_ROOT || defaultLegacyRoot(), ported = readPorted() } = {}) {
  const base = path.join(path.resolve(legacyRoot), 'station');
  const rows = ported.entries.map((e) => {
    const f = path.join(base, ...e.source.split('/'));
    if (!fs.existsSync(f)) return { ...e, status: 'MISSING' };
    const st = fs.statSync(f);
    const now = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return { ...e, status: now === e.sha256 ? 'unchanged' : 'CHANGED', now, mtime: st.mtime.toISOString() };
  });
  return { base, moment: ported.moment, rows, changed: rows.filter((r) => r.status !== 'unchanged') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = drift();
  console.log('port drift: ' + r.base + ' against PORTED.md (port moment ' + r.moment + ')');
  for (const x of r.rows) console.log('  ' + x.status.padEnd(9) + ' ' + x.source + (x.status === 'CHANGED' ? '  (modified ' + x.mtime + ')' : ''));
  console.log(r.changed.length ? r.changed.length + ' of ' + r.rows.length + ' file(s) drifted since the port.' : 'no drift: all ' + r.rows.length + ' files match the port moment.');
  if (r.changed.length && process.argv.includes('--strict')) process.exitCode = 1;
}
