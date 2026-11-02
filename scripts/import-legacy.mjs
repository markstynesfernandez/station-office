// import-legacy.mjs — npm run import-legacy -- --from <path-to-the-legacy-build> [--data <data root>]
// The one-time, idempotent legacy import (ENGINE-PLAN.md §7.1). All the work, every read of the source and every write
// (through the data jail) is in src/engine/import/legacy.mjs; this is the command line only. Run it with no engine on
// the data root (the engine lock refuses otherwise). Exit 0 on success (also when nothing changed), 1 on a refusal.
import path from 'node:path';
import { runImport, DEFAULT_FROM } from '../src/engine/import/legacy.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const from = path.resolve(arg('--from') || DEFAULT_FROM);
const dataRoot = arg('--data') ? path.resolve(arg('--data')) : undefined;
const log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'import-legacy' });

runImport({ from, dataRoot, log }).then((r) => {
  const L = r.reconciliation.ledger;
  console.log('\nimport-legacy ' + r.stamp + ': ' + r.result);
  console.log('ledger: source ' + (L.sourceRows - L.unreadableSourceRows) + ' rows $' + L.sourceUsd.toFixed(7) + ' | imported ' + L.importedRows + ' rows $' + L.importedUsd.toFixed(7) + ' | match: ' + (L.match ? 'yes' : 'NO'));
  console.log('disagreements flagged on jobs: ' + r.warnings.length + ' | backup: ' + r.backup);
  console.log('report: ' + path.join(r.dataRoot, 'import', 'runs', r.stamp + '.md'));
  if (!L.match) process.exitCode = 1;
}).catch((e) => { console.error('import-legacy refused: ' + e.message); log.error('import refused', { error: e.message, code: e.code || null }); process.exitCode = 1; });
