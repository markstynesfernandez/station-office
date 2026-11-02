// record-tests.mjs — npm run test:record (L1): runs the full suite (node --test) on a clean working tree and appends the
// result to logs/test-passes.jsonl (commit, counts, time, who). scripts/deploy-live.mjs deploys only a commit with a row
// here that passed (fail 0) on a clean tree. Refuses to run with uncommitted changes to tracked files: commit first, so
// the result belongs to a commit. Writes: logs/ only (its own jail).
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { gitState } from './git-state.mjs';

export const PASSES_FILE = path.join(APP_ROOT, 'logs', 'test-passes.jsonl');

// the summary lines of the spec or tap reporter: "ℹ tests 409" / "# pass 409"
export function testCounts(text) {
  const out = {};
  for (const m of String(text).matchAll(/^(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) out[m[1]] = Number(m[2]);
  return out;
}

async function main() {
  const before = gitState(APP_ROOT);
  if (before.dirty.length) { console.error('test:record refused: uncommitted changes to tracked files (' + before.dirty.slice(0, 5).join(', ') + '): commit first'); process.exit(2); }
  const t0 = Date.now();
  let text = '';
  const code = await new Promise((resolve) => {
    // R2a.1: the same temp check as npm test (tests/helpers/temp-guard.mjs): a temp folder left behind fails the run
    const p = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-global-setup=tests/helpers/temp-guard.mjs'], { cwd: APP_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', resolve);
  });
  const after = gitState(APP_ROOT), c = testCounts(text);
  const row = { at: new Date().toISOString(), commit: before.commit, branch: before.branch, exitCode: code, tests: c.tests ?? null, pass: c.pass ?? 0, fail: c.fail ?? null, cancelled: c.cancelled ?? 0, durationMs: Date.now() - t0, clean: !after.dirty.length && after.commit === before.commit, node: process.version, by: os.userInfo().username };
  if (row.fail == null) row.fail = code === 0 ? 0 : 1;
  const J = createJail({ dataRoot: path.dirname(PASSES_FILE), extraRoots: [] });
  J.add(PASSES_FILE, JSON.stringify(row) + '\n', { fsync: true });
  const passed = code === 0 && row.fail === 0 && row.cancelled === 0 && row.pass > 0 && row.clean;
  console.log('\ntest:record ' + (passed ? 'PASSED' : 'NOT PASSED') + ': ' + row.commit.slice(0, 7) + ' · ' + row.pass + '/' + row.tests + ' pass, ' + row.fail + ' fail' + (row.clean ? '' : ' · the tree changed during the run') + ' -> ' + path.relative(APP_ROOT, PASSES_FILE));
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(APP_ROOT, 'scripts', 'record-tests.mjs')) main();
