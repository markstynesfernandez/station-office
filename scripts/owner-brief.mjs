// owner-brief.mjs — save an OWNER BRIEF (owner decision 5, 17/10/2026; lib/owner-brief.mjs) to data/research/briefs/<id>.md. The
// brief is checked exactly as intake checks it (orchestrator saveOwnerBrief -> checkBriefAll: the owner brief format, a digital
// product, the originality screen of the whole brief, the scouting blocklist, the image policy, the owner bounds against the
// floor); a refused brief writes nothing. No model, no network, no cost. Saving the same text again changes nothing. A job is
// started only by the owner (npm run line:live -- --brief <id>, or the page): never by this script or a routine.
//   npm run owner-brief -- --file <path to the brief .md>            check and save
//   npm run owner-brief -- --file <path to the brief .md> --check    check only, write nothing
// Needs the engine lock (stop the server first, or it refuses).
import fs from 'node:fs';
import path from 'node:path';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { isOwnerBrief, checkOwnerBrief } from '../src/engine/lib/owner-brief.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? String(process.argv[i + 1] || '') : null; };
const FILE = arg('--file'), CHECK = process.argv.includes('--check');
if (!FILE) { console.error('usage: npm run owner-brief -- --file <brief.md> [--check]'); process.exit(2); }
let text; try { text = fs.readFileSync(path.resolve(FILE), 'utf8'); } catch (e) { console.error('owner-brief: cannot read ' + FILE + ': ' + e.message); process.exit(2); }
if (!isOwnerBrief(text)) { console.error('owner-brief refused: not an owner brief (front matter "origin: owner")'); process.exit(1); }

const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'owner-brief', jail: J });
let engine;
try { engine = openScriptEngine({ J, log, purpose: 'owner-brief' }); }
catch (e) { console.error('owner-brief: the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (the Station server holds the engine lock: stop it first)' : '')); process.exit(1); }
try {
  if (CHECK) {
    const c = checkOwnerBrief(text, { products: engine.cfg.products, cfg: engine.cfg.station });
    console.log(JSON.stringify({ check: true, ok: c.ok, reasons: c.reasons, product: c.key, evidenceLevel: c.evidence ? c.evidence.level : null, price: c.price || null }, null, 1));
    if (!c.ok) process.exitCode = 1;
  } else {
    const r = engine.orchestrator.saveOwnerBrief({ text, by: 'owner (scripts/owner-brief.mjs)' });
    console.log(JSON.stringify(r, null, 1));
    if (!r.ok) process.exitCode = 1;
  }
} catch (e) { console.error('owner-brief failed: ' + e.message); process.exitCode = 1; }
finally { engine.close(); }
