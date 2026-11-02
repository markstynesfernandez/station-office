// settle-failed.mjs — W2 (owner, 20/10/2026; lib/settle-failed.mjs): settles the ledger's rows for calls that ended with NO HTTP response
// (charged at their reserved maximum, marked estimated) once the owner has checked them in the Anthropic Console (or OpenRouter's
// activity page for an image). $0: no call to any provider. The ledger is never edited: each settled row gets one appended correction
// row with who, when and the amount; a row is never settled twice.
//   npm run settle:failed                                                    list every failed-call row not yet settled
//   npm run settle:failed -- --job <job id> --usd 0 --by "<name>"            the plan: what would be written (dry run, nothing written)
//   npm run settle:failed -- --job <job id> --usd 0 --by "<name>" --apply    write the correction rows
//   --entry <entryId>[,<entryId>...] instead of (or with) --job picks single rows, e.g. one call the Console shows at another amount:
//   npm run settle:failed -- --entry <entryId> --usd 0.012345 --by "<name>" --apply
//   --source "<what was checked>" overrides the default (the Anthropic Console; OpenRouter's activity page for an image row)
// The engine lock refuses while the server is running (stop it first). Run it in the checkout whose ledger it settles.
import path from 'node:path';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { settleFailedRows } from '../src/engine/lib/settle-failed.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? String(process.argv[i + 1] ?? '') : null; };
const apply = process.argv.includes('--apply'), entries = arg('--entry');
loadEnv(path.join(APP_ROOT, '.env'));   // fills only what the shell has not set; no value is printed
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'settle-failed', jail: J });
let engine;
try { engine = openScriptEngine({ J, log, purpose: 'settle:failed' }); }
catch (e) { console.error('the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (stop the server first)' : '')); process.exit(1); }
try {
  if (!engine.ledger.state.ok) throw new Error('the ledger is not ok: ' + engine.ledger.state.error);
  const r = settleFailedRows({ ledger: engine.ledger, jobId: arg('--job') || null, entryIds: entries ? entries.split(',').map((s) => s.trim()).filter(Boolean) : null, usd: arg('--usd'), by: arg('--by'), source: arg('--source'), apply, log });
  console.log(JSON.stringify({ ledger: engine.ledger.label, applied: r.applied, selected: r.selected, settled: r.settled, skipped: r.skipped, totalDeltaUsd: r.totalDeltaUsd, jobs: r.jobs,
    note: r.listOnly ? 'list only: add --job <id> (or --entry <ids>), --usd <amount> and --by "<name>" for a plan' : r.applied ? 'correction rows appended to the ledger' : 'plan only (dry run): nothing written; add --apply to append the correction rows' }, null, 1));
} catch (e) { console.error('settle-failed refused: ' + e.message); process.exitCode = 1; }
finally { engine.close(); }
