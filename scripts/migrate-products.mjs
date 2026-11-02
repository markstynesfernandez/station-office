// migrate-products.mjs — R1 (owner, 23/10/2026): npm run migrate:products. Backfills product_id and department_id on a post-B0 data root
// (lib/migrate-products.mjs has the mapping and the rules). Run it in the checkout whose data root it migrates, with the server stopped
// (it holds the engine lock; while the server runs it refuses). Every change is logged to logs/migrate-products-<date>.log.
//   npm run migrate:products                 the dry run: what would be set, per table, product and department, and anything it cannot map
//   npm run migrate:products -- --apply      a full backup to data/.backups/products-<stamp>/ first, then the change in one transaction;
//                                            refused while anything is unmapped; a second run changes nothing
// A pre-B0 root is refused: run npm run migrate:businesses first. STATION_DATA_ROOT names another data root (e.g. a scratch copy).
// No model is called; $0.
import path from 'node:path';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { migrateProducts } from '../src/engine/lib/migrate-products.mjs';

const apply = process.argv.includes('--apply');
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'migrate-products', jail: J });
try {
  const cfg = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts') });
  const r = migrateProducts({ J, cfg, log, apply });
  const unmapped = (r.unmapped || []).length;
  console.log(JSON.stringify({ ...r, unmappedCount: unmapped, note: r.note || (r.applied ? 'applied: product_id and department_id set (backup in ' + r.backup.dir + ')' : r.nothingToDo ? 'nothing to change' : unmapped ? 'dry run: ' + unmapped + ' record(s) cannot be mapped, so --apply would be refused' : 'dry run: nothing written; 0 unmapped; add --apply to write (a backup is taken first)') }, null, 1));
} catch (e) {
  console.error('migrate:products refused: ' + e.message + (e.code === 'LOCKED' ? ' (stop the server on this data root first)' : ''));
  process.exitCode = 1;
}
