// migrate-businesses.mjs — B0 (owner, 21/10/2026): npm run migrate:businesses. Backfills business_id on a data root from before B0
// (lib/migrate-businesses.mjs has the mapping and the rules). Run it in the checkout whose data root it migrates, with the server stopped
// (it holds the engine lock; while the server runs it refuses).
//   npm run migrate:businesses                 the dry run: what would be set, per table and business, and anything it cannot map
//   npm run migrate:businesses -- --apply      a full backup to data/.backups/businesses-<stamp>/ first, then the change; a second
//                                              run changes nothing
// STATION_DATA_ROOT names another data root (e.g. a scratch copy). No model is called; $0.
import path from 'node:path';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { migrateBusinesses } from '../src/engine/lib/migrate-businesses.mjs';

const apply = process.argv.includes('--apply');
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'migrate-businesses', jail: J });
try {
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
  const r = migrateBusinesses({ J, cfg, log, apply });
  console.log(JSON.stringify({ ...r, note: r.note || (r.applied ? 'applied: business_id set (backup in ' + r.backup.dir + ')' : r.nothingToDo ? 'nothing to change' : 'dry run: nothing written; add --apply to write (a backup is taken first)') }, null, 1));
} catch (e) {
  console.error('migrate:businesses refused: ' + e.message + (e.code === 'LOCKED' ? ' (stop the server on this data root first)' : ''));
  process.exitCode = 1;
}
