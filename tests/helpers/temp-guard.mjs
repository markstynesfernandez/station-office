// helpers/temp-guard.mjs — R2a.1 (owner, 26/10/2026): the test run's global setup (npm test and npm run test:record pass it with
// --test-global-setup). The run gets its own temp folder, station-tests-XXXXXX in the system temp folder, and every test process inherits
// it as TEMP / TMP / TMPDIR, so everything a test puts in a temp folder lands there. After the last test the folder must be empty, and
// no .tmp-from-* folder may be left in the repo (tests/e6-c-fixtools.test.mjs makes one): anything left is listed, removed so it cannot
// pile up, and the run fails (exit code 1) whatever the test counts say. Nothing outside the run's own folder is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_TMP = /^\.tmp-from-/;
let runDir = null;

export async function globalSetup() {
  runDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'station-tests-')));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = runDir;
}

export async function globalTeardown() {
  if (!runDir) return;
  const left = [...fs.readdirSync(runDir).map((n) => path.join(runDir, n)), ...fs.readdirSync(APP_ROOT).filter((n) => REPO_TMP.test(n)).map((n) => path.join(APP_ROOT, n))];
  for (const p of left) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* reported below */ } }
  const stuck = left.filter((p) => fs.existsSync(p));
  try { fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (_) { /* reported below */ }
  if (!left.length) return;
  const byPrefix = new Map();
  for (const p of left) { const k = path.basename(p).replace(/[A-Za-z0-9]{6}$/, '*'); byPrefix.set(k, (byPrefix.get(k) || 0) + 1); }
  console.error('\nTEMP CHECK FAILED: ' + left.length + ' temp folder(s) left behind by the tests (removed now' + (stuck.length ? '; ' + stuck.length + ' could not be removed: ' + stuck.join(', ') : '') + '):');
  for (const [k, n] of [...byPrefix.entries()].sort()) console.error('  ' + k + '  x' + n);
  process.exitCode = 1;
}
