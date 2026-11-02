// start.mjs — npm start (L1): starts this checkout's Station. The instance (STATION_INSTANCE: live | dev, unset = dev) comes
// from the shell or .env; scripts/start-live.ps1 and scripts/start-dev.ps1 set it with the port and the data root. The git
// state (commit, branch, uncommitted tracked files; scripts/git-state.mjs) goes to the instance check
// (src/engine/instance.mjs): the live instance refuses a dirty working tree and logs the commit it runs.
//   npm start            the engine server
//   npm start -- --legacy | --fixtures   the read-only legacy view, as before
import path from 'node:path';
import { ROOT, startFromEnv } from '../src/server/index.mjs';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';
import { instanceName } from '../src/engine/instance.mjs';
import { gitState } from './git-state.mjs';

loadEnv(path.join(ROOT, '.env'));   // fills only what the shell has not set; no value is printed
let name;
try { name = instanceName(process.env); } catch (e) { console.error('station refused to start: ' + e.message); process.exit(2); }
let git = null;
try { git = gitState(ROOT); }
catch (e) { if (name === 'live') { console.error('station refused to start: ' + e.message); process.exit(2); } }
startFromEnv({ argv: process.argv.slice(2), git });
