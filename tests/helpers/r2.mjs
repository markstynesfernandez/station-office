// helpers/r2.mjs — R2 test fixtures: a git clone in a temp folder standing in for the owner's ReplyDesk clone (REPLYDESK_REPO), a fake
// Docker for lib/checks.mjs (every call recorded, no container runs), and a git process that really hangs (for the timeout tests).
// Real git runs on the fixture only; nothing pushes anywhere. The owner's real clone and the live data are never touched.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createChecks } from '../../src/engine/lib/checks.mjs';
import { ProcError, run as procRun } from '../../src/engine/lib/proc.mjs';
import { tempDir } from './engine.mjs';

// git on the fixture (not through the engine): a fixed identity, no line-ending conversion
export const G = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

// a temp folder removed after the test
export function tempBase(t, tag = 'r2-fixture') {
  const base = tempDir('station-' + tag + '-');
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* left in the temp folder */ } });
  return base;
}

// the fixture clone: main (also as origin/main, the ref the engine fetches) and an outreach branch the mirror must never fetch
export function fixtureClone(base) {
  const dir = path.join(base, 'replydesk-clone');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.py'), 'def add(a, b):\n    return a + b\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_app.py'), 'from app import add\n\n\ndef test_add():\n    assert add(1, 1) == 2\n');
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest>=8\n');
  G(dir, 'init', '-q'); G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'fixture main');
  G(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  G(dir, 'checkout', '-q', '-b', 'outreach/prospects');
  fs.writeFileSync(path.join(dir, 'prospects.txt'), 'Example Business, test@example.com\n');
  G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'outreach data');
  G(dir, 'checkout', '-q', 'main');
  return dir;
}
// everything about the clone that the engine must never change
export const cloneState = (dir) => ({ refs: G(dir, 'for-each-ref', '--format=%(refname) %(objectname)'), status: G(dir, 'status', '--porcelain'), head: G(dir, 'rev-parse', 'HEAD') });

// a fake Docker for lib/checks.mjs: every call recorded, nothing runs. timeout: the run times out (as lib/proc.mjs reports it)
export function fakeDocker({ installed = true, imageBuilt = true, exit = () => 0, timeout = false, freeze = 'pytest==8.4.2\n' } = {}) {
  const calls = [];
  const res = (code, stdout = '') => ({ code, stdout, stderr: '', output: stdout, capped: false, timedOut: false, killed: false, durationMs: 5 });
  const runner = async (program, args) => {
    calls.push({ program, args });
    if (program !== 'docker') throw new Error('the fake runner only plays docker');
    if (!installed) throw new ProcError('docker could not run: ENOENT', { code: 'NOT_FOUND' });
    if (args[0] === 'version') return res(0, '29.8.2\n');
    if (args[0] === 'image') return imageBuilt ? res(0, 'sha256:' + '0'.repeat(64) + '\n') : res(1, 'Error: No such image\n');
    if (args[0] === 'run' && args.includes('/deps/freeze.txt')) return res(0, freeze);   // the build's pip freeze, read back from the image
    if (args[0] === 'run') { if (timeout) throw new ProcError('docker timed out after 1 s and was killed', { code: 'TIMEOUT', output: 'partial output' }); const code = exit(args); return res(code, code === 0 ? '2 passed in 0.01s\n' : '1 failed in 0.01s\n'); }
    if (args[0] === 'kill') return res(0);
    if (args[0] === 'build') return res(0, 'sha256:' + '1'.repeat(64) + '\n');
    return res(1, 'unexpected docker call\n');
  };
  return { calls, runs: () => calls.filter((c) => c.args[0] === 'run'), kills: () => calls.filter((c) => c.args[0] === 'kill'), checks: createChecks({ runner }) };
}

// a git process that really hangs: `git hash-object <pipe>` opens a Windows named pipe (a unix socket path elsewhere) that accepts the
// connection and never sends a byte, so git blocks reading it whatever its stdin is. connected/closed show the process reached the pipe
// and that it was killed (the connection drops when the process dies).
export async function hangingPipe(t) {
  const name = 'station-git-hang-' + crypto.randomBytes(4).toString('hex');
  const where = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
  const state = { path: where, connected: false, closed: false };
  const srv = net.createServer((s) => { state.connected = true; s.on('close', () => { state.closed = true; }); s.on('error', () => {}); });
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(where, res); });
  t.after(() => new Promise((res) => srv.close(() => res())));
  return state;
}
// a git runner (lib/repo.mjs git runner) that runs the real git, but turns the named subcommand into a git that hangs on the pipe;
// the timeout, the kill and the error are lib/proc.mjs's own
export const hangOn = (sub, pipe) => (program, args, opts) => procRun(program, args.includes(sub) ? ['hash-object', pipe.path] : args, opts);
