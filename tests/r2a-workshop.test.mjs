// R2a tests (RESTRUCTURE.md §5.1, §5.2, §5.4; owner, R0.3): the engineering workshop, with no agent and no model. The Station's own
// mirror of a product's clone, a worktree on dev/<job-id>, the staged diff and the commit, the git and docker runner, the Docker check
// runner, and the hard timeout on every git process. Real git runs on a fixture clone in a temp folder (helpers/r2.mjs); Docker is a fake
// runner, so no container runs and no image is pulled or built.
//   1 the runner: git and docker only, never a shell, no argument with a line break; stdin is closed, so a git reading stdin ends at once
//   2 a git that really hangs is killed at its timeout: lib/proc.mjs TIMEOUT, and lib/repo.mjs turns it into GitTimeout ("git timeout")
//   3 every git process the engine starts goes through lib/repo.mjs git(), the allowlist (no push, remote, config) and the timeout
//   4 the mirror takes only the clone's origin/main, never another branch or a tag, and never writes to the clone
//   5 a worktree on dev/<job-id> only; the staged diff; the commit on that branch by the Station; the worktree removed, the branch kept
//   6 the check runner: the product's fixed argv in Docker with no network, the worktree read-only, nothing from the Station's environment;
//     no Docker or no image refuses (no fallback on the host); a check that times out is killed by container name
//   7 npm run check-image: the plan (requirements path and sha256 at main, the tag), nothing built; --apply only on a digest-pinned base
//   8 the lock: checked against its recorded sha256; a build that installs other versions warns; no .env read, the lock never written
//   9 a worktree holding a secret file (.env, .env.*, *.db, keys, .venv/, a .git folder) is refused before Docker starts; .env.example
//     only while it holds no secret pattern (owner, 26/10/2026); the worktree's own .git file is not a secret. The real container: npm run
//     test:docker (tests/docker/sandbox.docker.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { G, tempBase, fixtureClone, cloneState, fakeDocker, hangingPipe, hangOn } from './helpers/r2.mjs';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { run as procRun, PROGRAMS } from '../src/engine/lib/proc.mjs';
import { git, refGuard, GIT_ALLOWED, GIT_TIMEOUT_MS, GIT_FETCH_TIMEOUT_MS, GitTimeout, fetchMirror, addWorktree, stagedDiff, commitWorktree, removeWorktree, branchHead, showAtMain, mirrorDir, branchOf, pullCommand } from '../src/engine/lib/repo.mjs';
import { checkArgv, imageTag, worktreeSecrets } from '../src/engine/lib/checks.mjs';

const PRODUCT = { id: 'replydesk', name: 'ReplyDesk', localRepoEnv: 'REPLYDESK_REPO', repoSource: { ref: 'refs/remotes/origin/main' }, runChecks: { test: ['python', '-m', 'pytest', '-q'] }, checkImage: { base: 'python:3.12-slim', requirements: 'requirements.txt' } };
const JOB = 'eng-2026-10-26--fix-the-add-helper';
function workshop(t) {
  const base = tempBase(t, 'r2a');
  const clone = fixtureClone(base), J = createJail({ dataRoot: path.join(base, 'data') });
  return { base, clone, J, env: { REPLYDESK_REPO: clone }, dir: path.join(base, 'data', 'products', 'replydesk', 'eng', JOB, 'repo') };
}

test('1: the runner starts only git and docker, never through a shell, refuses a line break in an argument, and closes stdin', async () => {
  assert.deepEqual(PROGRAMS, ['git', 'docker']);
  await assert.rejects(procRun('cmd', ['/c', 'echo']), (e) => e.code === 'PROGRAM');
  await assert.rejects(procRun('powershell', ['-c', 'echo']), (e) => e.code === 'PROGRAM');
  await assert.rejects(procRun('git', ['log', 'a\nb']), (e) => e.code === 'ARGS');
  await assert.rejects(procRun('git', ['log', 'a\0b']), (e) => e.code === 'ARGS');
  // a git that reads stdin gets EOF at once: hash-object --stdin hashes the empty input (it waited until the timeout before R2a)
  const t0 = Date.now(), r = await procRun('git', ['hash-object', '--stdin'], { timeoutMs: 10000 });
  assert.deepEqual([r.code, r.stdout.trim()], [0, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391']);
  assert.ok(Date.now() - t0 < 5000, 'it did not wait for input');
});

test('2: a git that really hangs is killed at its timeout: the runner reports TIMEOUT and lib/repo.mjs throws GitTimeout ("git timeout")', async (t) => {
  const pipe = await hangingPipe(t);
  let t0 = Date.now();
  await assert.rejects(procRun('git', ['hash-object', pipe.path], { timeoutMs: 1500 }), (e) => e.code === 'TIMEOUT' && /git timed out after 2 s and was killed/.test(e.message));
  assert.ok(Date.now() - t0 < 10000, 'killed near its timeout, not left to run');
  assert.ok(pipe.connected, 'the git process really reached the pipe (it was hanging, not failing to start)');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(pipe.closed, 'the process is gone: its end of the pipe closed when it was killed');
  // through lib/repo.mjs: an allowlisted subcommand that hangs -> GitTimeout with the subcommand and "git timeout"
  const pipe2 = await hangingPipe(t);
  t0 = Date.now();
  await assert.rejects(git(['status'], { runner: hangOn('status', pipe2), timeoutMs: 1500 }), (e) => e instanceof GitTimeout && e.code === 'GIT_TIMEOUT' && e.subcommand === 'status' && /^git timeout: git status did not finish in 2 s and was killed$/.test(e.message));
  assert.ok(Date.now() - t0 < 10000);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(pipe2.closed, 'killed');
  // the default timeouts (proposals): 120 s for a git call, 300 s for the fetch from the owner's clone
  assert.deepEqual([GIT_TIMEOUT_MS, GIT_FETCH_TIMEOUT_MS], [120000, 300000]);
});

test('3: every git process the engine starts goes through lib/repo.mjs git(): the allowlist (no push, remote or config) and the timeout', async () => {
  for (const sub of ['push', 'remote', 'config', 'clone', 'pull', 'submodule', 'credential', 'daemon']) await assert.rejects(git([sub, 'origin']), (e) => e.code === 'REPO' && /never pushes/.test(e.message), sub);
  assert.ok(!GIT_ALLOWED.some((s) => ['push', 'remote', 'config', 'clone', 'pull', 'send-pack', 'credential'].includes(s)));
  // the source: one call into the runner, inside git(); every exported function reaches git only through git(), each with the timeout options
  const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'engine', 'lib', 'repo.mjs'), 'utf8');
  assert.equal((src.match(/\brun\(|\(runner \|\| run\)\(/g) || []).length, 1, 'one place starts git');
  assert.match(src, /catch \(e\) \{ if \(e && e\.code === 'TIMEOUT'\) throw new GitTimeout\(sub, ms\); throw e; \}/);
  for (const call of src.match(/await git\(\[[^\n]*?\], \{[^\n]*?\}\)/g)) assert.ok(/runner|\.\.\.t\b/.test(call), 'a git call without the timeout options: ' + call.slice(0, 90));
  // only lib/proc.mjs and lib/repo.mjs name git as a program in src/engine (the engineering line calls lib/repo.mjs)
  const engineSrc = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? engineSrc(path.join(d, e.name)) : e.name.endsWith('.mjs') ? [path.join(d, e.name)] : []));
  for (const f of engineSrc(path.join(APP_ROOT, 'src'))) { const rel = path.relative(APP_ROOT, f).split(path.sep).join('/'); if (['src/engine/lib/proc.mjs', 'src/engine/lib/repo.mjs'].includes(rel)) continue; assert.ok(!/\brun\(\s*'git'|procRun\(\s*'git'/.test(fs.readFileSync(f, 'utf8')), rel + ' starts git itself'); }
});

test('4: the mirror takes only the clone\'s origin/main (never another branch or a tag) and never writes to the clone', async (t) => {
  const { clone, J, env } = workshop(t);
  G(clone, 'tag', 'v1');
  const before = cloneState(clone);
  await assert.rejects(fetchMirror({ J, product: PRODUCT, env: {} }), /REPLYDESK_REPO is not set/);
  await assert.rejects(fetchMirror({ J, product: PRODUCT, env: { REPLYDESK_REPO: path.join(clone, 'tests') } }), /is not a git clone/);
  const m = await fetchMirror({ J, product: PRODUCT, env });
  const mirror = mirrorDir(J.dataRoot, 'replydesk');
  assert.equal(m.head, G(clone, 'rev-parse', 'refs/remotes/origin/main'));
  assert.deepEqual(G(mirror, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/main'], 'main only: no outreach branch, no tag');
  assert.equal(G(mirror, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(await showAtMain({ J, productId: 'replydesk', file: 'requirements.txt' }), 'pytest>=8\n');
  assert.equal(await showAtMain({ J, productId: 'replydesk', file: 'prospects.txt' }), null, 'the outreach branch\'s file is not in the mirror');
  // a new commit on the clone's origin/main arrives on the next fetch
  fs.writeFileSync(path.join(clone, 'README.md'), '# fixture\n'); G(clone, 'add', '-A'); G(clone, 'commit', '-q', '-m', 'readme'); G(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const before2 = cloneState(clone);
  assert.equal((await fetchMirror({ J, product: PRODUCT, env })).head, G(clone, 'rev-parse', 'HEAD'));
  assert.deepEqual(cloneState(clone), before2, 'the fetch read the clone and wrote nothing to it');
  assert.notDeepEqual(before, before2);
});

test('5: a worktree on dev/<job-id> only; the staged diff; the commit on that branch by the Station; the worktree removed, the branch kept', async (t) => {
  const { clone, J, env, dir } = workshop(t);
  const before = cloneState(clone);
  await assert.rejects(addWorktree({ J, productId: 'replydesk', jobId: JOB, dir }), /no mirror yet/);
  await fetchMirror({ J, product: PRODUCT, env });
  assert.equal(refGuard('dev/' + JOB, JOB), 'dev/' + JOB);
  assert.equal(refGuard('refs/heads/dev/' + JOB, JOB), 'dev/' + JOB);
  for (const ref of ['main', 'refs/heads/main', 'dev/eng-other-job', 'refs/heads/dev/' + JOB + '2', 'dev/' + JOB + '/x']) assert.throws(() => refGuard(ref, JOB), /writes only dev\/eng-2026-10-26--fix-the-add-helper/, ref);
  assert.throws(() => refGuard('dev/x', 'not-an-eng-job'), /not an engineering job id/);
  const w = await addWorktree({ J, productId: 'replydesk', jobId: JOB, dir });
  assert.deepEqual([w.branch, w.created, G(dir, 'symbolic-ref', '--short', 'HEAD')], ['dev/' + JOB, true, 'dev/' + JOB]);
  assert.equal(w.baseSha, G(clone, 'rev-parse', 'HEAD'));
  // a resumed job keeps its worktree
  assert.equal((await addWorktree({ J, productId: 'replydesk', jobId: JOB, dir })).created, false);
  fs.writeFileSync(path.join(dir, 'app.py'), 'def add(a, b):\n    return int(a) + int(b)\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_add.py'), 'from app import add\n\n\ndef test_text():\n    assert add("2", "3") == 5\n');
  const d = await stagedDiff({ dir, jobId: JOB, baseSha: w.baseSha });
  assert.deepEqual(d.files.map((f) => f.status + ' ' + f.path).sort(), ['A tests/test_add.py', 'M app.py']);
  assert.match(d.patch, /^\+    return int\(a\) \+ int\(b\)$/m);
  await assert.rejects(stagedDiff({ dir, jobId: 'eng-2026-10-26--another-job', baseSha: w.baseSha }), /writes only dev\/eng-2026-10-26--another-job/, 'the worktree must be on the job\'s own branch');
  const sha = await commitWorktree({ dir, jobId: JOB, message: JOB + ': fix the add helper\n\nIssue x (approved by the owner).' });
  const mirror = mirrorDir(J.dataRoot, 'replydesk');
  assert.equal(await branchHead({ J, productId: 'replydesk', jobId: JOB }), sha);
  assert.equal(G(mirror, 'log', '-1', '--format=%an <%ae>|%P|%s', sha), 'Station engineering line <station@localhost>|' + w.baseSha + '|' + JOB + ': fix the add helper');
  assert.equal(G(mirror, 'rev-parse', 'main'), w.baseSha, 'main is untouched');
  await removeWorktree({ J, productId: 'replydesk', dir });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await branchHead({ J, productId: 'replydesk', jobId: JOB }), sha, 'the branch stays in the mirror for the owner to pull');
  assert.equal(pullCommand({ dataRoot: J.dataRoot, productId: 'replydesk', jobId: JOB }), 'git fetch "' + mirror.replace(/\\/g, '/') + '" dev/' + JOB + ':dev/' + JOB);
  assert.deepEqual(cloneState(clone), before, 'the owner\'s clone is untouched: no branch, no commit, no file');
});

test('6: the check runner: the product\'s argv in Docker, no network, read-only worktree, no Station environment; no Docker or no image refuses; a timeout kills the container', async (t) => {
  const { base } = workshop(t);
  const wt = path.join(base, 'worktree'); fs.mkdirSync(wt);   // a clean worktree (base holds the fixture clone and its .git)
  const p = { ...PRODUCT, runChecks: { test: ['python', '-m', 'pytest', '-q'], lint: ['ruff', 'check', '.'] } };
  assert.deepEqual(checkArgv(p, 'test', 'tests/test_a.py::test_one'), ['python', '-m', 'pytest', '-q', 'tests/test_a.py::test_one']);
  for (const bad of ['-k x', '--co', '../secret.py', 'a b', 'tests/x.py;rm', 'x\ny']) assert.throws(() => checkArgv(p, 'test', bad), /the filter must be/, JSON.stringify(bad));
  assert.throws(() => checkArgv(p, 'lint', 'app.py'), /for the test check only/);
  assert.throws(() => checkArgv({ ...p, runChecks: { test: p.runChecks.test } }, 'typecheck'), /has no "typecheck" check/);
  assert.throws(() => checkArgv(p, 'shell'), /no such check/);
  const image = imageTag(p, 'pytest>=8\n');
  assert.match(image, /^station-check-replydesk:[0-9a-f]{16}$/);
  assert.notEqual(imageTag(p, 'pytest>=8\nruff>=0.6\n'), image, 'a changed requirements file needs a new image');
  const d = fakeDocker();
  const r = await d.checks.runCheck({ product: p, name: 'test', filter: 'tests/test_add.py', worktree: wt, image });
  assert.deepEqual([r.passed, r.exitCode, r.argv.slice(-1)[0]], [true, 0, 'tests/test_add.py']);
  const a = d.runs()[0].args, s = a.join(' ');
  for (const must of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 256', '--memory 2g', '--rm', '--user 65534:65534']) assert.ok(s.includes(must), must);
  assert.ok(a.includes('type=bind,source=' + path.resolve(wt) + ',target=/work,readonly'), 'only the worktree, read-only');
  assert.equal(a.filter((x) => x === '--mount' || x === '-v' || x === '--volume').length, 1, 'no other host path');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--env'), ['HOME=/tmp', 'PYTHONDONTWRITEBYTECODE=1', 'PYTEST_ADDOPTS=-p no:cacheprovider', 'RUFF_NO_CACHE=true', 'CI=1'], 'nothing from the Station\'s environment');
  assert.deepEqual(a.slice(a.indexOf(image)), [image, 'python', '-m', 'pytest', '-q', 'tests/test_add.py']);
  // no Docker / no image: refused with the reason, nothing runs on the host
  const nd = fakeDocker({ installed: false });
  await assert.rejects(nd.checks.runCheck({ product: p, name: 'test', worktree: wt, image }), (e) => e.code === 'NO_DOCKER' && /Docker is not installed .*no fallback on the host/.test(e.message));
  const ni = fakeDocker({ imageBuilt: false });
  await assert.rejects(ni.checks.runCheck({ product: p, name: 'test', worktree: wt, image }), (e) => e.code === 'NO_IMAGE' && /has not been built/.test(e.message));
  await assert.rejects(d.checks.runCheck({ product: p, name: 'test', worktree: wt, image: null }), (e) => e.code === 'NO_IMAGE');
  assert.equal(nd.runs().length + ni.runs().length, 0);
  // a check that times out: the container is stopped by its name (killing the docker client does not stop it)
  const to = fakeDocker({ timeout: true });
  const tr = await to.checks.runCheck({ product: p, name: 'test', worktree: wt, image });
  assert.deepEqual([tr.passed, tr.timedOut, tr.exitCode], [false, true, null]);
  const name = to.runs()[0].args[to.runs()[0].args.indexOf('--name') + 1];
  assert.deepEqual(to.kills().map((k) => k.args), [['kill', name]]);
});

test('7: npm run check-image: the plan reads the requirements at main (path, sha256) and builds nothing; --apply is refused until the base is pinned by digest', async (t) => {
  const { checkImagePlan, buildCheckImage, PINNED_RE } = await import('../scripts/check-image.mjs');
  const { clone, J, env } = workshop(t);
  const before = cloneState(clone), req = G(clone, 'show', 'refs/remotes/origin/main:requirements.txt') + '\n';
  const d = fakeDocker({ imageBuilt: false });
  const plan = await checkImagePlan({ J, product: PRODUCT, env, checks: d.checks });
  assert.deepEqual(plan.requirements, { path: 'requirements.txt', sha256: crypto.createHash('sha256').update(req).digest('hex'), bytes: Buffer.byteLength(req) });
  assert.deepEqual([plan.base, plan.pinned, plan.built, plan.tag, plan.mirrorHead], ['python:3.12-slim', false, false, imageTag(PRODUCT, req), G(clone, 'rev-parse', 'HEAD')]);
  assert.match(plan.dockerfile, /^FROM python:3\.12-slim$/m);
  assert.deepEqual(d.calls.map((c) => c.args[0]), ['version', 'image'], 'the plan asks Docker only whether it answers and the image exists: no pull, no build, no run');
  await assert.rejects(buildCheckImage({ J, product: PRODUCT, env, checks: d.checks }), /refused: .*checkImage\.base \(python:3\.12-slim\) is not pinned by digest/);
  assert.ok(!d.calls.some((c) => c.args[0] === 'build'), 'nothing built');
  // pinned: it builds on exactly that base and records the freeze beside the image
  const pinned = { ...PRODUCT, checkImage: { ...PRODUCT.checkImage, base: 'python:3.12-slim@sha256:' + 'a'.repeat(64) } };
  assert.ok(PINNED_RE.test(pinned.checkImage.base));
  const b = await buildCheckImage({ J, product: pinned, env, checks: d.checks });
  const build = d.calls.find((c) => c.args[0] === 'build').args;
  assert.ok(build.includes('--pull') && build.includes(b.tag));
  assert.match(fs.readFileSync(path.join(b.dir, 'Dockerfile'), 'utf8'), new RegExp('^FROM python:3\.12-slim@sha256:a{64}$', 'm'));
  assert.equal(fs.readFileSync(path.join(b.dir, 'requirements.txt'), 'utf8'), req);
  assert.ok(fs.existsSync(path.join(b.dir, 'freeze.txt')) && fs.existsSync(path.join(b.dir, 'image.json')));
  assert.deepEqual(cloneState(clone), before, 'the owner\'s clone is only read');
});

test('8: the lock: check-image checks the lock file against its recorded sha256 and warns when a build installs different packages; it never reads .env or writes the lock', async (t) => {
  const { compareFreeze, readLock, buildCheckImage, lockWarnings } = await import('../scripts/check-image.mjs');
  // the comparison: names normalised (case, "_" and "."), every difference named
  const c = compareFreeze('Flask==3.1.0\nrequests==2.32.3\npytest==8.4.2\n# a comment\n', 'flask==3.1.2\nrequests==2.32.3\nPytest==8.4.2\nblinker==1.9.0\n');
  assert.deepEqual([c.same, c.changed, c.added, c.removed], [false, [{ lock: 'Flask==3.1.0', now: 'flask==3.1.2' }], ['blinker==1.9.0'], []]);
  assert.equal(compareFreeze('a==1\nzope.interface==7\n', 'zope_interface==7\na==1\n').same, true);
  // the lock file against the sha256 the product config records
  const { clone, J, env, base } = workshop(t);
  const dir = path.join(base, 'config-products'); fs.mkdirSync(dir);
  const lockText = 'pytest==8.4.2\nflask==3.1.0\n', sha = crypto.createHash('sha256').update(lockText).digest('hex');
  fs.writeFileSync(path.join(dir, 'replydesk.lock.txt'), lockText);
  const pinned = { ...PRODUCT, checkImage: { ...PRODUCT.checkImage, base: 'python:3.12-slim@sha256:' + 'a'.repeat(64), lock: { file: 'replydesk.lock.txt', sha256: sha } } };
  const lock = readLock(pinned, dir);
  assert.deepEqual([lock.ok, lock.sha256Now, lock.file], [true, sha, 'config/products/replydesk.lock.txt']);
  assert.equal(readLock({ ...pinned, checkImage: { ...pinned.checkImage, lock: { file: 'replydesk.lock.txt', sha256: '0'.repeat(64) } } }, dir).ok, false, 'an edited lock no longer matches its recorded sha256');
  assert.equal(readLock(PRODUCT, dir), null, 'no lock configured');
  // a build that installs what the lock says: no warning; one that installs another version: a warning naming it
  const same = await buildCheckImage({ J, product: pinned, env, checks: fakeDocker({ imageBuilt: false, freeze: 'flask==3.1.0\npytest==8.4.2\n' }).checks, lock });
  assert.deepEqual([same.lockCheck.status, lockWarnings(same)], ['same', []]);
  const other = await buildCheckImage({ J, product: pinned, env, checks: fakeDocker({ imageBuilt: false, freeze: 'flask==3.1.2\npytest==8.4.2\n' }).checks, lock });
  assert.equal(other.lockCheck.status, 'differs');
  const w = lockWarnings(other);
  assert.match(w[0], /^WARNING: this build installed different packages from the lock config\/products\/replydesk\.lock\.txt:$/);
  assert.ok(w.includes('  changed: flask==3.1.0 -> flask==3.1.2'));
  // the lock file itself is untouched by a build; the script reads no .env and writes nothing under config/
  assert.equal(fs.readFileSync(path.join(dir, 'replydesk.lock.txt'), 'utf8'), lockText);
  const src = fs.readFileSync(path.join(APP_ROOT, 'scripts', 'check-image.mjs'), 'utf8');
  assert.ok(!/loadEnv|['"]\.env['"]/.test(src), 'check-image does not read .env');
  assert.ok(!/writeFileSync|J\.put\(/.test(src), 'check-image writes nothing itself (the build writes only its data folder)');
  assert.ok(clone);
});

test('9: a worktree holding a secret file is refused before Docker starts; .env.example only while it holds no secret; the worktree\'s .git file is not a secret', async (t) => {
  const { base } = workshop(t);
  let n = 0;
  const wt = (files) => { const dir = path.join(base, 'wt-' + n++); for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); } return dir; };
  const clean = { 'app.py': 'x = 1\n', 'tests/test_app.py': 'def test_x():\n    pass\n' };
  // the clean cases: nothing found; the check goes to Docker
  const example = '# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/replydesk\nANTHROPIC_API_KEY=\nSECRET_KEY=change-me\n';
  for (const files of [clean, { ...clean, '.git': 'gitdir: C:/somewhere/repo.git/worktrees/x\n' }, { ...clean, '.env.example': example }, { ...clean, 'config/.env.example': 'DATABASE_URL=postgresql://u:p@127.0.0.1/db\n' }]) {
    const dir = wt(files);
    assert.deepEqual(worktreeSecrets(dir), [], Object.keys(files).join(', '));
    const d = fakeDocker();
    assert.equal((await d.checks.runCheck({ product: PRODUCT, name: 'test', worktree: dir, image: imageTag(PRODUCT, 'pytest>=8\n') })).passed, true);
    assert.equal(d.runs().length, 1);
  }
  // refused by name: .env, .env.*, *.db and the other secret files; a .git folder; a folder below is walked
  for (const [rel, want] of [['.env', '.env file (.env)'], ['.env.local', '.env file (.env.local)'], ['deploy/.env.production', '.env file (deploy/.env.production)'], ['instance/app.db', 'database file (instance/app.db)'], ['data.sqlite3', 'database file (data.sqlite3)'], ['certs/server.key', 'private key or certificate store (certs/server.key)'], ['.venv/bin/python', 'Python virtual environment (.venv)'], ['.git/config', 'git internals (.git)'], ['vendor/lib/.git', 'git internals (vendor/lib/.git)']]) {
    const dir = wt({ ...clean, [rel]: 'x\n' });
    assert.deepEqual(worktreeSecrets(dir), [want], rel);
    for (const opts of [{}, { installed: false }]) {   // before Docker: the same refusal with or without Docker, and not one docker call
      const d = fakeDocker(opts);
      await assert.rejects(d.checks.runCheck({ product: PRODUCT, name: 'test', worktree: dir, image: 'station-check-replydesk:0123456789abcdef' }), (e) => e.code === 'SECRETS' && e.message.startsWith('refused before Docker starts: the worktree holds ' + want));
      assert.deepEqual(d.calls, [], rel);
    }
  }
  // .env.example with a real secret pattern: refused, the file and the kind named, never the value
  for (const [line, kind] of [['STRIPE_SECRET_KEY=sk_live_' + 'Fa1Ke'.repeat(6), 'Stripe key'], ['RENDER_API_KEY=rnd_' + 'Fa1Ke'.repeat(6), 'Render API key'], ['ANTHROPIC_API_KEY=sk-ant-' + 'fake0'.repeat(6), 'Anthropic API key, OpenRouter or OpenAI-style API key'], ['GOOGLE_KEY=AIza' + 'F'.repeat(35), 'Google API key'],
    ['GH=ghp_' + 'F'.repeat(36), 'GitHub token'], ['-----BEGIN RSA PRIVATE KEY-----', 'private key block'], ['DATABASE_URL=postgresql://admin:hunter22@db.example.com:5432/x', 'connection string with a password']]) {
    const dir = wt({ ...clean, '.env.example': '# example\n' + line + '\n' });
    const found = worktreeSecrets(dir);
    assert.deepEqual(found, ['.env.example holds ' + kind], line.slice(0, 20));
    const d = fakeDocker();
    await assert.rejects(d.checks.runCheck({ product: PRODUCT, name: 'test', worktree: dir, image: 'station-check-replydesk:0123456789abcdef' }), (e) => e.code === 'SECRETS' && e.message.includes('.env.example holds ' + kind) && !e.message.includes(line.split('=').pop()));
    assert.deepEqual(d.calls, []);
  }
});
