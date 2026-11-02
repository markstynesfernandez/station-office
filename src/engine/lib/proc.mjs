// lib/proc.mjs — R2 (RESTRUCTURE.md §5.2, §5.4; owner, R0.3): the engine's one runner for git and Docker. Like the pinned upscaler
// (lib/esrgan.mjs), this is a module tests/write-guard.test.mjs allows to start a process, and it has ONE execFile call site:
//   - only the programs in PROGRAMS (git, docker), by name from PATH; never a shell (execFile, shell off), so no shell metacharacter
//     reaches anything: an argument is passed as it is, and one holding a NUL or a line break is refused before anything starts
//   - a minimal environment: PATH, the Windows system folders, a temp folder and (Docker only) the user profile, so the CLI finds its
//     context. No key, no token and no Station variable is passed on (git also gets no global or system config: no credential helper,
//     no hooks of the owner's, no prompt)
//   - stdin is closed as the child starts (R2a, 26/10/2026), so no program can sit waiting for input that never comes
//   - a timeout (the caller's; the process is killed) and the caller's AbortSignal (the E-STOP and the owner's Stop) kill it at once;
//     a container is stopped by name through onKill (lib/checks.mjs) because killing the docker client does not stop the container
//   - the output is kept up to maxOutputBytes (the rest is dropped and marked), never streamed to an agent unbounded
// Nothing here pushes: the engine has no push, merge or deploy code path (locked rule no-merge-deploy-push); lib/repo.mjs refuses a push,
// a remote, or any ref other than dev/<job-id> before it gets here.
import { execFile } from 'node:child_process';
import path from 'node:path';

export const PROGRAMS = ['git', 'docker'];
export const DEFAULT_OUTPUT_BYTES = 200 * 1024;
const BAD_ARG = /[\0\r\n]/;

export class ProcError extends Error { constructor(msg, extra = {}) { super(msg); this.code = extra.code || 'PROC'; Object.assign(this, extra); } }

// the environment a child gets: nothing from the Station's own environment beyond what the program needs to start
export function minimalEnv(program, { home = null } = {}) {
  const sys = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const tmp = process.env.TEMP || process.env.TMP || (process.platform === 'win32' ? path.join(sys, 'Temp') : '/tmp');
  const env = { PATH: process.env.PATH || process.env.Path || '', TEMP: tmp, TMP: tmp };
  if (process.platform === 'win32') Object.assign(env, { SystemRoot: sys, windir: sys });
  if (program === 'git') Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: home ? path.join(home, 'gitconfig-empty') : (process.platform === 'win32' ? 'NUL' : '/dev/null'), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });
  if (program === 'docker') { for (const k of ['USERPROFILE', 'HOME', 'ProgramData', 'ProgramFiles', 'LOCALAPPDATA', 'APPDATA', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (process.env[k]) env[k] = process.env[k]; env.DOCKER_CLI_HINTS = 'false'; }
  return env;
}

// one run -> { code, stdout, stderr, output (stdout + stderr, capped), capped, timedOut, killed, durationMs }. A non-zero exit is a result,
// not an error (the caller decides); a program that cannot start, a refused argument, a kill or a timeout throws ProcError
export function run(program, args, { cwd = undefined, timeoutMs = 120000, signal = null, maxOutputBytes = DEFAULT_OUTPUT_BYTES, input = null, onKill = null, envHome = null } = {}) {
  if (!PROGRAMS.includes(program)) return Promise.reject(new ProcError('refused: the engine runs only ' + PROGRAMS.join(' and ') + ', not ' + program, { code: 'PROGRAM' }));
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || BAD_ARG.test(a))) return Promise.reject(new ProcError('refused: every argument must be text without a NUL or a line break', { code: 'ARGS' }));
  if (signal && signal.aborted) return Promise.reject(new ProcError(program + ' not started: ' + ((signal.reason && signal.reason.message) || 'stopped'), { code: 'STOPPED' }));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    const opts = { cwd, env: minimalEnv(program, { home: envHome }), windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 25, encoding: 'utf8', shell: false, signal: signal || undefined };
    try {
      child = execFile(program, args, opts, (err, stdout = '', stderr = '') => {
        const durationMs = Date.now() - t0, all = String(stdout) + (stderr ? (stdout ? '\n' : '') + String(stderr) : '');
        const capped = Buffer.byteLength(all) > maxOutputBytes, output = capped ? Buffer.from(all).subarray(0, maxOutputBytes).toString('utf8') + '\n[output capped at ' + maxOutputBytes + ' bytes by the Station]' : all;
        const aborted = err && (err.name === 'AbortError' || (signal && signal.aborted));
        const timedOut = !!(err && err.killed && !aborted && durationMs >= timeoutMs - 50);
        if (aborted || timedOut) { if (onKill) Promise.resolve().then(onKill).catch(() => {}); return reject(new ProcError(program + (timedOut ? ' timed out after ' + Math.round(timeoutMs / 1000) + ' s and was killed' : ' killed: ' + ((signal && signal.reason && signal.reason.message) || 'stopped')), { code: timedOut ? 'TIMEOUT' : 'STOPPED', output, durationMs })); }
        if (err && typeof err.code !== 'number') return reject(new ProcError(program + ' could not run: ' + (err.code || err.message), { code: err.code === 'ENOENT' ? 'NOT_FOUND' : 'START', output, durationMs }));
        resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr), output, capped, timedOut: false, killed: false, durationMs });
      });
    } catch (e) { return reject(new ProcError(program + ' could not run: ' + e.message, { code: 'START' })); }
    // stdin is always closed (with the input, or empty): a child that reads stdin gets EOF at once instead of waiting until the timeout
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input != null ? String(input) : undefined); }
  });
}
