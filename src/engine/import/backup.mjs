// backup.mjs — the snapshot taken before every import (ENGINE-PLAN.md §7.3): the current data/ goes to
// data/.backups/<stamp>/. The database is copied by SQLite itself (VACUUM INTO, a consistent copy even with a WAL),
// the ledger, events, import record and the engine's own job and research folders are copied, and the imported legacy
// folder (data/legacy/, never edited in place: each import swaps in a new folder) is hard-linked, falling back to a
// copy where links are not possible. Restoring = swapping the folder back by hand. Snapshots are never deleted here.
// Every write goes through the data jail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_TOP = /^(\.backups|\.import-staging-.*|\.import-old-.*|\.lock|station\.db(-wal|-shm|-journal)?)$/;
const LINK_TOP = new Set(['legacy']);

export function backupData({ J, store, stamp, log, note = 'taken before an import-legacy run (ENGINE-PLAN.md §7.3); never deleted automatically' }) {
  const dir = path.join(J.dataRoot, '.backups', stamp);
  if (fs.existsSync(dir)) throw new Error('backup folder already exists: ' + dir);
  J.makeDir(dir);
  const items = [];
  // the database, through SQLite (consistent with the WAL, nothing half-written)
  if (store && fs.existsSync(store.file)) {
    const target = J.dataJail(path.join(dir, 'station.db'));
    store.db.exec("VACUUM INTO '" + J.dataJail(target).replace(/'/g, "''") + "'");
    items.push({ path: 'station.db', how: 'sqlite VACUUM INTO', files: 1, bytes: fs.statSync(target).size });
  }
  for (const e of fs.existsSync(J.dataRoot) ? fs.readdirSync(J.dataRoot, { withFileTypes: true }) : []) {
    if (SKIP_TOP.test(e.name)) continue;
    const link = LINK_TOP.has(e.name);
    const stat = { path: e.name + (e.isDirectory() ? '/' : ''), how: link ? 'hard link' : 'copy', files: 0, bytes: 0, copiedInstead: 0 };
    const one = (from, to) => {
      if (link) {
        try { fs.linkSync(from, J.dataJail(to)); stat.files++; stat.bytes += fs.statSync(from).size; return; }
        catch (err) { if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(err.code)) throw err; stat.copiedInstead++; }
      }
      J.copy(from, to); stat.files++; stat.bytes += fs.statSync(from).size;
    };
    const walk = (from, to) => {
      if (fs.statSync(from).isDirectory()) { J.makeDir(to); for (const n of fs.readdirSync(from)) walk(path.join(from, n), path.join(to, n)); }
      else one(from, to);
    };
    walk(path.join(J.dataRoot, e.name), path.join(dir, e.name));
    items.push(stat);
  }
  const record = { stamp, takenAt: new Date().toISOString(), dataRoot: J.dataRoot, items, restore: 'stop the engine, then swap this folder\'s contents back into the data root (station.db, ledger/, events/, import/, jobs/, research/, legacy/)', note };
  record.sha256 = crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
  J.put(path.join(dir, 'BACKUP.json'), JSON.stringify(record, null, 2) + '\n');
  log && log.info('backup taken', { dir, items: items.map((i) => i.path + ':' + i.files) });
  return { dir, ...record };
}
