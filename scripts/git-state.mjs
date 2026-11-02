// git-state.mjs — L1: a checkout's git state for the instance guards (src/engine/instance.mjs) and the live deploy: the
// commit, the branch and the tracked files with uncommitted changes. git runs without a shell (execFileSync).
import { execFileSync } from 'node:child_process';

export class GitError extends Error { constructor(msg) { super(msg); this.code = 'GIT'; } }

// one git command in `cwd`; returns stdout as written (callers trim). allowFail: null instead of throwing
export function git(cwd, args, { allowFail = false } = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { if (allowFail) return null; throw new GitError('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + String(e.stderr || e.message).trim()); }
}

// tracked files with uncommitted changes (staged or not); untracked and ignored files do not count
export const dirtyTracked = (cwd) => git(cwd, ['status', '--porcelain', '--untracked-files=no']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));

export function gitState(cwd) {
  const commit = git(cwd, ['rev-parse', 'HEAD']).trim();
  const branch = (git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }) || '').trim() || null;
  return { commit, branch, dirty: dirtyTracked(cwd) };
}
