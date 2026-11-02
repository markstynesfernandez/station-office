// estop.mjs — the e-stop from a terminal (ENGINE-PLAN.md §5.5). Works when the page is frozen or the server is hung:
// it writes data/HALT and data/halt.json directly (through the data jail). A running engine polls them every second,
// aborts every in-flight call and refuses new ones. The state survives a restart.
//   npm run estop                       press
//   npm run estop -- --reason "text"    press, with a reason
//   npm run estop -- --off              release (stopped jobs are NOT resumed; restart each one)
//   npm run estop -- --status           show the state
import path from 'node:path';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { writeHaltFiles, readHaltState } from '../src/engine/halt.mjs';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { makeLogger } from '../src/server/log.mjs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
loadEnv(path.join(APP_ROOT, '.env'));
const J = createJail();
const log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'estop', quiet: true });
if (argv.includes('--status')) { console.log(JSON.stringify(readHaltState(J.dataRoot), null, 1)); }
else if (argv.includes('--off')) { const r = writeHaltFiles(J, { halted: false, by: 'cli' }); log.warn('E-STOP OFF from the CLI', r); console.log('e-stop released at ' + new Date(r.at).toISOString() + '. Stopped jobs are not resumed: restart each one.'); }
else { const r = writeHaltFiles(J, { halted: true, by: 'cli', reason: arg('--reason') || '' }); log.warn('E-STOP ON from the CLI', r); console.log('E-STOP ON at ' + new Date(r.at).toISOString() + ' (' + path.join(J.dataRoot, 'HALT') + '). A running engine aborts every call within a second.'); }
