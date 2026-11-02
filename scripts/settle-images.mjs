// settle-images.mjs — settles the ledger's ESTIMATED OpenRouter image rows from OpenRouter's generation lookup (E6 wrap-up, owner
// 18/10/2026; lib/settle-images.mjs). $0: a GET of each generation's record (no image, no model call). The ledger is never edited: each
// settled row gets one correction row. Rows without a generation id (calls that failed before any response) and every Anthropic row stay
// estimated and are listed for the owner to check by hand.
//   npm run settle:images              the plan only: what would be settled, nothing written
//   npm run settle:images -- --apply   write the correction rows
// The engine lock refuses while the server is running (stop it first). OPENROUTER_API_KEY comes from the shell or .env; no value is printed.
import path from 'node:path';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { settleImageRows } from '../src/engine/lib/settle-images.mjs';

const apply = process.argv.includes('--apply');
loadEnv(path.join(APP_ROOT, '.env'));   // fills only what the shell has not set; no value is printed
const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'settle-images', jail: J });
let engine;
try { engine = openScriptEngine({ J, log, purpose: 'settle:images' }); }
catch (e) { console.error('the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (stop the server first)' : '')); process.exit(1); }
try {
  if (!engine.ledger.state.ok) throw new Error('the ledger is not ok: ' + engine.ledger.state.error);
  const r = await settleImageRows({ engineCfg: engine.cfg.engine, ledger: engine.ledger, key: process.env.OPENROUTER_API_KEY || null, apply, log });
  console.log(JSON.stringify({ applied: r.applied, checked: r.checked, settled: r.settled, unsettled: r.unsettled, totalDeltaUsd: r.totalDeltaUsd, note: apply ? 'correction rows written to the ledger' : 'plan only: run with --apply to write the correction rows' }, null, 1));
} catch (e) { console.error('settle-images refused: ' + e.message); process.exitCode = 1; }
finally { engine.close(); }
