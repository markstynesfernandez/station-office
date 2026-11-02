// blocklist-hygiene.mjs — the owner's one-off scouting blocklist cleanup (E6 b2, owner D4, 17/10/2026; DECISIONS.md
// "E6 step b2: owner decisions"). The engine adds only name-like strings since b2; this removes entries an earlier run
// added that are not names (b1 added the placeholder "UNKNOWN — needs owner check", which then matched every brief that
// used the same placeholder). The engine itself never removes a name: this script is the owner's order, run by hand.
//   node scripts/blocklist-hygiene.mjs                       report only (writes nothing)
//   node scripts/blocklist-hygiene.mjs --apply               remove the entries that are not name-like (logged)
//   node scripts/blocklist-hygiene.mjs --check-day 2026-10-17   also run the customer-facing check on that day's files
//   node scripts/blocklist-hygiene.mjs --backfill            E6 b3 (owner, 17/10/2026): report what the backfill would do
//   node scripts/blocklist-hygiene.mjs --backfill --apply    move a pre-b3 shared notes file into the job that wrote it
//                                                            (from the job transcripts) and put the names of EVERY notes
//                                                            file in data/ on the blocklist (scouting.mjs backfillScouting)
// - Takes the engine lock like any engine process (refuses while the Station server runs: stop it first, by hand).
// - Every write goes through the data jail; each removal is logged (logs/blocklist-hygiene-<day>.log). Idempotent: a second
//   --apply finds nothing. Only entries failing the same rule the engine now applies on add (scouting.mjs notNameReason)
//   are removed; real names are never touched.
// - The customer-facing check reads the day's files outside scouting/ (briefs/, rejected/, drafts/, scout-drafts/) and
//   reports scouted names by kind only.
import fs from 'node:fs';
import path from 'node:path';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { blocklistPlaceholders, customerFacingCheck, readBlocklist, backfillScouting, SCOUT_DIR } from '../src/engine/lib/scouting.mjs';

const argv = process.argv.slice(2), apply = argv.includes('--apply'), backfill = argv.includes('--backfill');
const di = argv.indexOf('--check-day'), checkDay = di >= 0 ? argv[di + 1] : null;
if (checkDay != null && !/^\d{4}-\d{2}-\d{2}$/.test(checkDay)) { console.error('--check-day needs YYYY-MM-DD'); process.exit(2); }
if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') { console.error('blocklist-hygiene runs on the mock provider only (it makes no model call)'); process.exit(2); }

const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'blocklist-hygiene', jail: J });
let engine;
try { engine = openScriptEngine({ J, log, purpose: 'blocklist hygiene' }); }
catch (e) { console.error('the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (the Station server holds the engine lock: stop it first)' : '')); process.exit(1); }
try {
  const rdir = path.join(J.dataRoot, 'research');
  const before = readBlocklist(rdir).terms.length;
  const bad = blocklistPlaceholders(J, rdir, { apply });
  for (const b of bad) log.warn(apply ? 'scouting blocklist: removed an entry that is not a name (owner D4)' : 'scouting blocklist: entry that is not a name (report only)', b);
  const after = readBlocklist(rdir).terms.length;
  const out = { apply, blocklist: { file: 'research/' + SCOUT_DIR + '/blocklist.json (internal)', before, after, notNames: bad } };
  // E6 b3: the backfill (internal report: it names the terms added and refused; for the owner only)
  if (backfill) {
    const b = backfillScouting(J, rdir, { jobsDir: path.join(J.dataRoot, 'jobs'), apply, log });
    log.info(apply ? 'scouting backfill applied (E6 b3)' : 'scouting backfill (report only)', { migrated: b.migrated.length, unmatched: b.unmatched.length, files: b.files.length, added: b.added, refused: b.refused });
    out.backfill = b;
    out.blocklist.after = readBlocklist(rdir).terms.length;
  }
  if (checkDay) {
    const dirs = ['briefs', 'rejected', 'drafts/' + checkDay, 'scout-drafts/' + checkDay].map((d) => path.join(rdir, ...d.split('/')));
    const files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith(checkDay + '--') && /\.(md|json|txt)$/.test(f)).map((f) => path.join(d, f)) : []));
    out.customerFacingCheck = customerFacingCheck(rdir, files, engine.cfg.station);
  }
  console.log(JSON.stringify(out, null, 1));
} catch (e) { console.error('blocklist-hygiene failed: ' + (e.message || e)); process.exitCode = 1; }
finally { engine.close(); }
