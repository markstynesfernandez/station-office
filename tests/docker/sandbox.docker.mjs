// R2a.1 (owner, 26/10/2026): the check sandbox (lib/checks.mjs) proved against REAL Docker, in the built check image
// station-check-replydesk:fc3eeeed826a3b0a. npm run test:docker only: npm test never runs this file (its name matches none of node --test's
// default patterns). Nothing is pulled or built and no model is called; a missing Docker or image FAILS the run (it is not skipped).
// Each proof runs its own container through the engine's runner (lib/proc.mjs) and reads the container's own view (a probe script in the
// mounted worktree) and, where it says so, docker inspect of the running container.
//   1 an outbound network attempt from inside the container fails (--network none: only lo, connect and DNS fail)
//   2 the root filesystem is read-only: a write outside the tmpfs fails with EROFS; /tmp is writable
//   3 it runs as a non-root user: id -u is not 0
//   4 the hard timeout kills a hanging test inside a job: the container is gone afterwards and the job blocks with the timeout reason
//   5 a worktree holding .env, .env.* or *.db is refused before docker starts (no docker call at all)
//   5b a clean .env.example (the stock commented localhost default) is checked and the check runs (owner, 26/10/2026)
//   5c an .env.example holding a real secret pattern (a planted fake sk_live_ key) is refused, naming the file and kind, never the value
//   6 no host environment variable reaches the container (a canary set on the host is absent inside)
//   7 only the job's worktree is mounted: one bind mount at /work, read-only; nothing else from the host is visible
//   8 the CPU, memory and pids limits are applied (docker inspect, and the container's own cgroup files)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { engineOn } from '../helpers/r1.mjs';
import { G, tempBase, fixtureClone } from '../helpers/r2.mjs';
import { APP_ROOT } from '../../src/engine/store/jail.mjs';
import { run as procRun } from '../../src/engine/lib/proc.mjs';
import { createChecks, imageTag } from '../../src/engine/lib/checks.mjs';

const IMAGE = 'station-check-replydesk:fc3eeeed826a3b0a';
const REPLYDESK = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'products', 'replydesk.json'), 'utf8'));
const docker = (...args) => procRun('docker', args, { timeoutMs: 60000 });
// the product with one check: the probe script in the worktree
const probeProduct = { ...REPLYDESK, runChecks: { test: ['python', 'probe.py'] } };
// the last JSON line the probe printed
const probeOut = (r) => JSON.parse(r.output.split('\n').filter((l) => l.startsWith('{')).pop() || 'null');

before(async () => {
  const v = await docker('version', '--format', '{{.Server.Version}}');
  assert.equal(v.code, 0, 'Docker must answer for npm run test:docker: ' + v.output);
  const i = await docker('image', 'inspect', '--format', '{{.Id}}', IMAGE);
  assert.equal(i.code, 0, IMAGE + ' must be built (npm run check-image -- replydesk --apply): ' + i.output);
});

// the engine's runner, recorded; on a docker run, the running container is inspected (docker inspect) until it answers
function watched() {
  const calls = [], seen = { name: null, inspect: null, watch: null };
  const runner = async (program, args, opts) => {
    calls.push({ program, args });
    if (program === 'docker' && args[0] === 'run') {
      seen.name = args[args.indexOf('--name') + 1];
      seen.watch = (async () => { for (let i = 0; i < 150 && !seen.inspect; i++) { const r = await docker('inspect', seen.name); if (r.code === 0) seen.inspect = JSON.parse(r.stdout)[0]; else await sleep(100); } })();
    }
    return procRun(program, args, opts);
  };
  return { calls, seen, runs: () => calls.filter((c) => c.args[0] === 'run'), checks: (o = {}) => createChecks({ runner, ...o }) };
}
// a worktree: a temp folder with the probe script (and any other files)
function worktree(t, files = {}) {
  const dir = path.join(tempBase(t, 'docker'), 'repo');
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}
// a probe: its body, then the result printed as one JSON line, then a pause so the running container can be inspected
const probe = (body, pause = 4) => ['import json, os, socket, time', 'out = {}', body, 'print(json.dumps(out))', 'time.sleep(' + pause + ')', ''].join('\n');
async function runProbe(t, body, { files = {}, pause = 4 } = {}) {
  const w = watched(), dir = worktree(t, { 'probe.py': probe(body, pause), ...files });
  const r = await w.checks().runCheck({ product: probeProduct, name: 'test', worktree: dir, image: IMAGE });
  await w.seen.watch;
  return { r, out: probeOut(r), inspect: w.seen.inspect, w, dir };
}
const gone = async (name) => { for (let i = 0; i < 100; i++) { const r = await docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}'); if (r.code === 0 && !r.stdout.trim()) return true; await sleep(200); } return false; };

test('1: an outbound network attempt from inside the container fails (--network none: only lo; connect and DNS fail)', async (t) => {
  const { r, out, inspect } = await runProbe(t, [
    "out['interfaces'] = sorted(os.listdir('/sys/class/net'))",
    "for host, port in [('1.1.1.1', 53), ('8.8.8.8', 443)]:",
    '    try:',
    '        socket.create_connection((host, port), timeout=5); out[host] = "connected"',
    '    except OSError as e:',
    "        out[host] = 'errno %s %s' % (e.errno, e.strerror)",
    'try:',
    "    socket.getaddrinfo('pypi.org', 443); out['dns'] = 'resolved'",
    'except OSError as e:',
    "    out['dns'] = 'failed'"].join('\n'));
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(out, { interfaces: ['lo'], '1.1.1.1': 'errno 101 Network is unreachable', '8.8.8.8': 'errno 101 Network is unreachable', dns: 'failed' });
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
});

test('2: the root filesystem is read-only: a write outside the tmpfs fails (EROFS), the worktree too; /tmp is writable', async (t) => {
  const { r, out, inspect } = await runProbe(t, [
    "for p in ['/var/tmp/probe', '/usr/local/probe', '/etc/probe', '/work/probe', '/tmp/probe']:",
    '    try:',
    "        open(p, 'w').write('x'); out[p] = 'written'",
    '    except OSError as e:',
    '        out[p] = e.strerror'].join('\n'));
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(out, { '/var/tmp/probe': 'Read-only file system', '/usr/local/probe': 'Read-only file system', '/etc/probe': 'Read-only file system', '/work/probe': 'Read-only file system', '/tmp/probe': 'written' });
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(Object.keys(inspect.HostConfig.Tmpfs || {}), ['/tmp']);
});

test('3: it runs as a non-root user: id -u is not 0', async (t) => {
  const { r, out, inspect } = await runProbe(t, "out['uid'], out['euid'], out['gid'] = os.getuid(), os.geteuid(), os.getgid()");
  assert.equal(r.exitCode, 0, r.output);
  assert.notEqual(out.uid, 0, 'id -u is not 0');
  assert.notEqual(out.euid, 0, 'the effective uid is not 0');
  assert.notEqual(out.gid, 0, 'the group is not root');
  assert.equal(inspect.Config.User, out.uid + ':' + out.gid, 'docker run --user (the image is unchanged)');
});

test('4: a hanging test in a job: the hard timeout kills it, the container is gone afterwards, the job blocks with the timeout reason', async (t) => {
  // the fixture clone's main gets ReplyDesk's requirements (as the image has them, so the job picks this image) and a test that hangs
  const req = (await docker('run', '--rm', '--network', 'none', '--user', '65534:65534', IMAGE, 'cat', '/deps/requirements.txt')).stdout;
  assert.equal(imageTag(REPLYDESK, req), IMAGE, 'the job will pick the built image');
  const clone = fixtureClone(tempBase(t, 'docker-r2b'));
  fs.writeFileSync(path.join(clone, 'requirements.txt'), req);
  fs.writeFileSync(path.join(clone, 'conftest.py'), '');
  fs.writeFileSync(path.join(clone, 'tests', 'test_hang.py'), 'import time\n\n\ndef test_hang():\n    time.sleep(3600)\n');
  G(clone, 'add', '-A'); G(clone, 'commit', '-q', '-m', 'a test that hangs'); G(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // the mock agents: the CTO's queue, TECH-LEAD's spec, DEVELOPER's notes (no change); the checks step runs the real container
  const state = { issueId: null };
  const tool = (id, name, input) => ({ type: 'tool_use', id: 'tu_' + id, name, input });
  const text = (x) => ({ type: 'text', text: x });
  const SPEC = ['# Spec: a test that hangs', '', '## Problem', 'tests/test_hang.py never ends.', '', '## Scope', 'The checks only.', '', '## Out of scope', 'Anything else.', '', '## Acceptance criteria', 'AC1: the test check ends.', '', '## Test plan', 'Run the test check.', '', '## Files likely touched', 'None.', '', '## Risk notes', 'None known.', '', 'size: small', ''].join('\n');
  const script = async (ctx, params) => {
    const turn = params.messages.filter((m) => m.role === 'assistant').length, k = ctx.agentKey;
    const steps = k === 'cto' ? [[tool('q', 'fs_write', { path: 'dev-queue.json', content: JSON.stringify({ product: 'replydesk', queue: [{ issue: state.issueId, order: 1, size: 'small' }] }) })], [text('Queue written.')]]
      : k === 'tech-lead' ? [[tool('s', 'fs_write', { path: 'spec.md', content: SPEC })], [text('Spec written.')]]
        : k === 'developer' ? [[tool('n', 'fs_write', { path: 'notes.md', content: '# Notes\nNo change; the checks step runs the tests.\n' })], [text('Done.')]]
          : [[text('nothing scripted for ' + k)]];
    return { content: steps[Math.min(turn, steps.length - 1)] };
  };
  const w = watched();
  const { engine } = engineOn(t, { tag: 'docker', script, engineering: { checks: w.checks({ timeoutMs: 8000 }), env: { REPLYDESK_REPO: clone } } });
  const tok = crypto.randomBytes(16).toString('hex'); engine.requests.registerOwnerSession(tok);
  const owner = { kind: 'owner', session: tok }, E = engine.engineering;
  state.issueId = E.writeIssue({ productId: 'replydesk', title: 'A test that hangs', problem: 'tests/test_hang.py sleeps for an hour; the checks must not wait for it.' }, { actor: owner }).issueId;
  await E.decideIssue({ productId: 'replydesk', issueId: state.issueId, decision: 'approve', words: 'Prove the timeout.' }, { actor: owner });
  const tr = E.startTriage({ productId: 'replydesk' }, { actor: owner }); await tr.promise;
  assert.equal(engine.store.getJob(tr.jobId).state, 'done', engine.store.getJob(tr.jobId).reason);
  const t0 = Date.now(), s = E.startIssue({ productId: 'replydesk', issueId: state.issueId }, { actor: owner });
  await s.promise;
  const job = engine.store.getJob(s.jobId);
  assert.ok(Date.now() - t0 < 90000, 'the job ended near the timeout, it did not wait for the test');
  assert.equal(job.data.image, IMAGE);
  assert.deepEqual([job.state, job.step], ['blocked', 'checks'], job.reason);
  assert.match(job.reason, /^check "test" timed out after 8 s and was killed/);
  assert.equal(E.isActive(s.jobId), false, 'nothing is left running on the line');
  // the container really ran the test, was killed by name, and is gone
  assert.equal(w.runs().length, 1, 'one container: the checks step');
  assert.ok(w.seen.inspect && w.seen.inspect.State.Running, 'the container was running');
  assert.ok(w.calls.some((c) => c.args[0] === 'kill' && c.args[1] === w.seen.name), 'docker kill by the container\'s name');
  assert.ok(await gone(w.seen.name), 'the container is gone afterwards');
  const pass = JSON.parse(fs.readFileSync(path.join(engine.J.dataRoot, 'products', 'replydesk', 'eng', s.jobId, 'checks', 'pass-1.json'), 'utf8'));
  assert.deepEqual(pass.results.map((x) => [x.check, x.timedOut, x.passed]), [['test', true, false]]);
});

test('5: a worktree holding .env, .env.* or *.db is refused before docker starts (no docker call at all)', async (t) => {
  for (const [rel, kind] of [['.env', '.env file'], ['config/.env.local', '.env file'], ['instance/app.db', 'database file'], ['reviews.sqlite3', 'database file']]) {
    const w = watched(), dir = worktree(t, { 'probe.py': probe('', 0), [rel]: 'X=1\n' });
    await assert.rejects(w.checks().runCheck({ product: probeProduct, name: 'test', worktree: dir, image: IMAGE }),
      (e) => e.code === 'SECRETS' && e.message.includes(kind + ' (' + rel + ')') && /before Docker starts/.test(e.message), rel);
    assert.deepEqual(w.calls, [], rel + ': not one docker call');
  }
});

test('5b: a clean .env.example (the stock commented localhost default) is checked and the check runs', async (t) => {
  const example = ['# Copy to .env and fill in', 'ANTHROPIC_API_KEY=', 'SECRET_KEY=change-me', '# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/replydesk', 'STRIPE_SECRET_KEY=', ''].join('\n');
  const { r, out } = await runProbe(t, "out['seen'] = os.path.exists('/work/.env.example')", { files: { '.env.example': example }, pause: 0 });
  assert.equal(r.exitCode, 0, r.output);
  assert.deepEqual(out, { seen: true });
});

test('5c: an .env.example holding a real secret pattern (a planted fake sk_live_ key) is refused, naming the file and kind, never the value', async (t) => {
  const fake = 'sk_live_' + 'Fa1Ke'.repeat(6);
  const w = watched(), dir = worktree(t, { 'probe.py': probe('', 0), '.env.example': 'STRIPE_SECRET_KEY=' + fake + '\n' });
  await assert.rejects(w.checks().runCheck({ product: probeProduct, name: 'test', worktree: dir, image: IMAGE }),
    (e) => e.code === 'SECRETS' && /\.env\.example holds Stripe key/.test(e.message) && !e.message.includes(fake) && !e.message.includes('Fa1Ke'));
  assert.deepEqual(w.calls, [], 'not one docker call');
});

test('6: no host environment variable reaches the container (a canary set on the host is absent inside)', async (t) => {
  const name = 'STATION_CANARY_' + crypto.randomBytes(4).toString('hex').toUpperCase(), value = 'canary-' + crypto.randomBytes(8).toString('hex');
  process.env[name] = value;
  t.after(() => { delete process.env[name]; });
  const { r, out } = await runProbe(t, "out['env'] = dict(os.environ)", { pause: 0 });
  assert.equal(r.exitCode, 0, r.output);
  assert.ok(!(name in out.env), 'the canary\'s name is absent');
  assert.ok(!Object.values(out.env).includes(value) && !r.output.includes(value), 'the canary\'s value is absent');
  // what is there: the image's own variables, the five the runner sets, and HOSTNAME (Docker's); nothing else
  const img = JSON.parse((await docker('image', 'inspect', '--format', '{{json .Config.Env}}', IMAGE)).stdout).map((e) => e.split('=')[0]);
  const allowed = new Set([...img, 'HOME', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_ADDOPTS', 'RUFF_NO_CACHE', 'CI', 'HOSTNAME']);
  assert.deepEqual(Object.keys(out.env).filter((k) => !allowed.has(k)), []);
  assert.equal(out.env.HOME, '/tmp');
});

test('7: only the job\'s worktree is mounted: one bind mount at /work, read-only; nothing else from the host is visible', async (t) => {
  const { r, out, inspect, dir } = await runProbe(t, [
    "mi = [l.split(' ') for l in open('/proc/self/mountinfo').read().splitlines()]",
    "out['mounts'] = sorted(m[4] for m in mi if not m[4].startswith(('/proc', '/sys', '/dev')))",
    "out['etc'] = sorted(m[3] for m in mi if m[4].startswith('/etc/'))",
    "out['work'] = sorted(os.listdir('/work'))",
    "out['mnt'] = os.listdir('/mnt')",
    "out['visible'] = [p for p in ['/var/run/docker.sock', '/run/docker.sock', '/mnt/host', '/host_mnt', '/run/desktop', '/mnt/c', '/c'] if os.path.exists(p)]"].join('\n'), { files: { 'marker.txt': 'the worktree\n' } });
  assert.equal(r.exitCode, 0, r.output);
  // docker inspect: exactly one mount, the worktree, read-only, at /work
  assert.equal(inspect.Mounts.length, 1, JSON.stringify(inspect.Mounts));
  assert.deepEqual([inspect.Mounts[0].Type, inspect.Mounts[0].Destination, inspect.Mounts[0].RW], ['bind', '/work', false]);
  assert.ok(inspect.Mounts[0].Source.replace(/\\/g, '/').toLowerCase().endsWith(path.relative(path.dirname(path.dirname(dir)), dir).replace(/\\/g, '/').toLowerCase()), inspect.Mounts[0].Source);
  // the container's own view: the image's root, the tmpfs, the worktree, and Docker's per-container /etc files; nothing else
  assert.deepEqual(out.mounts, ['/', '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/tmp', '/work']);
  for (const e of out.etc) assert.match(e, new RegExp('^/data/docker/containers/' + inspect.Id + '/(hostname|hosts|resolv\\.conf)$'), 'Docker\'s own file for this container');
  assert.deepEqual(out.work, ['marker.txt', 'probe.py']);
  assert.deepEqual([out.mnt, out.visible], [[], []]);
});

test('8: the CPU, memory and pids limits are applied (docker inspect, and the container\'s own cgroup)', async (t) => {
  const { r, out, inspect } = await runProbe(t, "for f in ['cpu.max', 'memory.max', 'pids.max']:\n    out[f] = open('/sys/fs/cgroup/' + f).read().strip()");
  assert.equal(r.exitCode, 0, r.output);
  const h = inspect.HostConfig;
  assert.deepEqual([h.NanoCpus, h.Memory, h.PidsLimit], [2e9, 2 * 1024 ** 3, 256]);
  assert.deepEqual([h.CapDrop, h.SecurityOpt], [['ALL'], ['no-new-privileges']]);
  assert.deepEqual(out, { 'cpu.max': '200000 100000', 'memory.max': String(2 * 1024 ** 3), 'pids.max': '256' });
});
