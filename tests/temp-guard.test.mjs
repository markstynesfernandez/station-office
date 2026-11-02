// R2a.1 (owner, 26/10/2026): the run-level temp check (tests/helpers/temp-guard.mjs). A run whose tests leave a temp folder behind fails
// (exit code 1, the folders listed and removed); a clean run passes; npm test, npm run test:record and npm run test:docker run with the
// check, and npm test never picks up the real-Docker proofs (tests/docker/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './helpers/engine.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';

const GUARD = path.join(APP_ROOT, 'tests', 'helpers', 'temp-guard.mjs');
// a small test run in its own folder, with the guard
function runWithGuard(dir, body) {
  fs.writeFileSync(path.join(dir, 'probe.test.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\n" + body + '\n');
  // a run of its own, not a nested one: without NODE_TEST_CONTEXT, which makes node --test skip its files inside a test
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const r = spawnSync(process.execPath, ['--test', '--test-global-setup=' + GUARD, 'probe.test.mjs'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('a run that leaves a temp folder behind fails with the folder listed; it is removed; a clean run passes', (t) => {
  const dir = tempDir('station-guardprobe-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const leak = runWithGuard(dir, "test('leaks', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'station-leaky-')); fs.mkdtempSync(path.join(os.tmpdir(), 'station-leaky-')); });");
  assert.equal(leak.code, 1, leak.out);
  assert.match(leak.out, /ℹ pass 1/, 'the test itself passed');
  assert.match(leak.out, /TEMP CHECK FAILED: 2 temp folder\(s\) left behind by the tests \(removed now\):\n {2}station-leaky-\* {2}x2/);
  const clean = runWithGuard(dir, "test('cleans up', (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'station-tidy-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); });");
  assert.equal(clean.code, 0, clean.out);
  assert.ok(!/TEMP CHECK FAILED/.test(clean.out));
  // the probe runs' own temp folders (station-tests-*) are gone: nothing is left in this test's temp folder by them
  assert.deepEqual(fs.readdirSync(dir).sort(), ['probe.test.mjs']);
});

test('npm test and npm run test:record run with the temp check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test --test-global-setup=tests/helpers/temp-guard.mjs');
  assert.match(fs.readFileSync(path.join(APP_ROOT, 'scripts', 'record-tests.mjs'), 'utf8'), /'--test-global-setup=tests\/helpers\/temp-guard\.mjs'/);
});

test('npm run test:docker runs the real-Docker proofs with the temp check; npm test never picks them up', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:docker'], 'node --test --test-global-setup=tests/helpers/temp-guard.mjs tests/docker/*.docker.mjs');
  // node --test's default patterns (no file given): *.test.*, *-test.*, *_test.*, test-*.*, test.*, and anything under a test/ folder
  const picked = (rel) => /(^|\/)(test\/.*|[^/]*[.\-_]test\.[cm]?js|test-[^/]*\.[cm]?js|test\.[cm]?js)$/.test(rel);
  assert.equal(picked('tests/r2a-workshop.test.mjs'), true, 'the pattern is right');
  const files = fs.readdirSync(path.join(APP_ROOT, 'tests', 'docker'));
  assert.ok(files.includes('sandbox.docker.mjs'));
  for (const f of files) assert.equal(picked('tests/docker/' + f), false, f + ' would run in npm test');
});
