// lib/repo.mjs — R2 (RESTRUCTURE.md §5.1, §5.2, §5.6): the product repo as the Station holds it. Mechanical, no model, no network.
//   mirror     data/products/<id>/repo.git: a bare repository the engine fetches into (repo.fetch, auto) from the owner's local clone (the
//              product's localRepoEnv, e.g. REPLYDESK_REPO). Only ONE ref is fetched, the clone's origin/main (repoSource.ref), stored as
//              main: no other branch (ReplyDesk's outreach/* branches hold prospects' personal data, REPLYDESK.md) and no tag. Fetching
//              reads the clone; nothing is ever written to it. Agents never touch the mirror (no agent folder contains it).
//   worktree   for each engineering job the engine runs `git worktree add <job folder>/repo -b dev/<job-id> main`; the job's agents read
//              and write only there (tools/index.mjs); the engine refuses any ref other than dev/<job-id> (refGuard) and removes the
//              worktree once the job's commit is made (the branch stays in the mirror for the owner to pull)
//   diff       `git add -A` then the staged diff against the commit the branch started from (job data baseSha): diff.patch, the changed
//              paths and their status, for TESTER, REVIEWER, SECURITY and the gates (lib/eng-gates.mjs)
//   commit     on dev/<job-id> only, with hooks off (--no-verify and an empty hooks path) and the Station as author
// The engine never pushes (owner, R0.3: git.push.branch forbidden, locked rule no-merge-deploy-push): git subcommands are an allowlist
// (GIT_ALLOWED) without push, remote, config or any network subcommand but the one local fetch; the owner pulls dev/<job-id> from the
// mirror into their own clone, then pushes, opens the PR, merges and deploys by hand.
import fs from 'node:fs';
import path from 'node:path';
import { run, ProcError } from './proc.mjs';

export const GIT_ALLOWED = ['init', 'fetch', 'worktree', 'add', 'diff', 'commit', 'rev-parse', 'symbolic-ref', 'show', 'status', 'merge-base', 'cat-file', 'for-each-ref'];
export const JOB_ID_RE = /^eng-[a-z0-9][a-z0-9-]{2,90}$/;
export const DEFAULT_SOURCE_REF = 'refs/remotes/origin/main';
const MAIN = 'refs/heads/main';

export class RepoRefusal extends Error { constructor(msg) { super(msg); this.code = 'REPO'; } }
// R2a (owner, 26/10/2026): every git process has a hard timeout; on it the process is killed (lib/proc.mjs) and this is thrown, so the
// caller blocks the job with "git timeout" instead of stalling. The fetch from the owner's clone gets longer (a first fetch copies the
// whole history); both figures are proposals. runner/timeoutMs in every export below are for tests (a git that hangs).
export const GIT_TIMEOUT_MS = 120000, GIT_FETCH_TIMEOUT_MS = 300000;
export class GitTimeout extends Error { constructor(sub, ms) { super('git timeout: git ' + sub + ' did not finish in ' + Math.round(ms / 1000) + ' s and was killed'); this.code = 'GIT_TIMEOUT'; this.subcommand = sub; } }

export const mirrorDir = (dataRoot, productId) => path.join(dataRoot, 'products', productId, 'repo.git');
export const branchOf = (jobId) => 'dev/' + jobId;
const noHooks = (dataRoot, productId) => path.join(dataRoot, 'products', productId, '.no-hooks');

// the only ref the engine writes besides the mirror's main: dev/<job-id> for this job
export function refGuard(ref, jobId) {
  if (!JOB_ID_RE.test(String(jobId || ''))) throw new RepoRefusal('not an engineering job id: ' + jobId);
  const want = branchOf(jobId), r = String(ref || '').replace(/^refs\/heads\//, '');
  if (r !== want) throw new RepoRefusal('refused: the engine writes only ' + want + ' for job ' + jobId + ', not ' + ref);
  return want;
}

// one git call: an allowlisted subcommand (the first argument that is not a -c/-C/--git-dir option), never push or remote
// the ONLY place the engine starts git: every call has a timeout (killed, GitTimeout) and goes through the allowlist
export async function git(args, { cwd, gitDir = null, signal = null, timeoutMs = GIT_TIMEOUT_MS, maxOutputBytes = 8 * 1024 * 1024, hooks = null, identity = false, runner = run } = {}) {
  const pre = [...(gitDir ? ['--git-dir=' + gitDir] : []), '-c', 'core.hooksPath=' + (hooks || 'no-hooks'), '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...(identity ? ['-c', 'user.name=Station engineering line', '-c', 'user.email=station@localhost'] : [])];
  const sub = args[0];
  if (!GIT_ALLOWED.includes(sub)) throw new RepoRefusal('refused: git ' + sub + ' is not a subcommand the engine runs (' + GIT_ALLOWED.join(', ') + '); the engine never pushes');
  const ms = timeoutMs ?? GIT_TIMEOUT_MS;
  try { return await (runner || run)('git', [...pre, ...args], { cwd, signal, timeoutMs: ms, maxOutputBytes }); }
  catch (e) { if (e && e.code === 'TIMEOUT') throw new GitTimeout(sub, ms); throw e; }
}
const ok = (r, what) => { if (r.code !== 0) throw new ProcError(what + ' failed (exit ' + r.code + '): ' + r.output.trim().split('\n').slice(-4).join(' | '), { code: 'GIT', output: r.output }); return r.stdout.trim(); };

// the clone the mirror is fetched from: { path, ref } or a refusal with the reason
export function repoSource(product, env = process.env) {
  const name = product.localRepoEnv;
  if (!name) throw new RepoRefusal(product.id + ' has no localRepoEnv in config/products/' + product.id + '.json: the Station has no clone to fetch from');
  const p = env[name];
  if (!p) throw new RepoRefusal(name + ' is not set: point it at the owner\'s local clone of ' + (product.repo || product.id) + ' (the engine only reads it)');
  if (!fs.existsSync(path.join(p, '.git'))) throw new RepoRefusal(name + ' (' + p + ') is not a git clone');
  return { path: path.resolve(p), ref: (product.repoSource && product.repoSource.ref) || DEFAULT_SOURCE_REF };
}

// the mirror: created bare once, then the source ref fetched into main -> { dir, head, source, ref }
export async function fetchMirror({ J, product, signal = null, env = process.env, runner, timeoutMs, fetchTimeoutMs }) {
  const src = repoSource(product, env), dir = mirrorDir(J.dataRoot, product.id), hooks = noHooks(J.dataRoot, product.id), t = { runner, timeoutMs };
  if (!fs.existsSync(path.join(dir, 'HEAD'))) { J.makeDir(dir); ok(await git(['init', '--bare', '-q', '--initial-branch=main', J.dataJail(dir)], { signal, hooks, ...t }), 'git init --bare'); }
  ok(await git(['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', src.path, '+' + src.ref + ':' + MAIN], { gitDir: J.dataJail(dir), signal, hooks, runner, timeoutMs: fetchTimeoutMs ?? GIT_FETCH_TIMEOUT_MS }), 'git fetch from ' + src.path);
  const head = ok(await git(['rev-parse', MAIN], { gitDir: dir, signal, hooks, ...t }), 'git rev-parse main');
  return { dir, head, source: src.path, ref: src.ref };
}

// a file at main in the mirror (e.g. requirements.txt for the check image) -> text, or null when main has no such file
export async function showAtMain({ J, productId, file, signal = null, runner, timeoutMs }) {
  const r = await git(['show', MAIN + ':' + file], { gitDir: mirrorDir(J.dataRoot, productId), signal, hooks: noHooks(J.dataRoot, productId), runner, timeoutMs });
  return r.code === 0 ? r.stdout : null;
}

// the job's worktree on dev/<job-id>, from main (or the existing branch when the job resumes) -> { dir, branch, baseSha, created }
export async function addWorktree({ J, productId, jobId, dir, signal = null, runner, timeoutMs }) {
  const branch = refGuard(branchOf(jobId), jobId), mirror = mirrorDir(J.dataRoot, productId), hooks = noHooks(J.dataRoot, productId), t = { runner, timeoutMs };
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) throw new RepoRefusal('no mirror yet for ' + productId + ': the engine fetches it first');
  if (fs.existsSync(path.join(dir, '.git'))) { const b = ok(await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, signal, hooks, ...t }), 'git symbolic-ref'); refGuard(b, jobId); return { dir, branch, baseSha: null, created: false }; }
  await git(['worktree', 'prune'], { gitDir: mirror, signal, hooks, ...t });
  const exists = (await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { gitDir: mirror, signal, hooks, ...t })).code === 0;
  const baseSha = ok(await git(['rev-parse', MAIN], { gitDir: mirror, signal, hooks, ...t }), 'git rev-parse main');
  J.makeDir(path.dirname(dir));
  ok(await git(exists ? ['worktree', 'add', '--quiet', J.dataJail(dir), branch] : ['worktree', 'add', '--quiet', '-b', branch, J.dataJail(dir), MAIN], { gitDir: mirror, signal, hooks, ...t }), 'git worktree add');
  return { dir, branch, baseSha, created: true, resumed: exists };
}

// the branch a worktree is on must be the job's own
export async function assertOnBranch({ dir, jobId, signal = null, hooks = null, runner, timeoutMs }) {
  const b = ok(await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, signal, hooks, runner, timeoutMs }), 'git symbolic-ref');
  return refGuard(b, jobId);
}

// stage everything and diff it against the commit the branch started from -> { patch, files: [{ status, path }], stat, sha256Base }
export async function stagedDiff({ dir, jobId, baseSha, signal = null, hooks = null, maxBytes = 4 * 1024 * 1024, runner, timeoutMs }) {
  const t = { runner, timeoutMs };
  await assertOnBranch({ dir, jobId, signal, hooks, ...t });
  ok(await git(['add', '-A'], { cwd: dir, signal, hooks, ...t }), 'git add -A');
  const base = baseSha || 'main';
  const patch = (await git(['diff', '--cached', '--no-color', '--no-ext-diff', '--find-renames', '--binary', base], { cwd: dir, signal, hooks, maxOutputBytes: maxBytes, ...t })).stdout;
  const ns = ok(await git(['diff', '--cached', '--name-status', '--find-renames', '-z', base], { cwd: dir, signal, hooks, ...t }), 'git diff --name-status');
  const parts = ns.split('\0').filter((x) => x !== ''), files = [];
  for (let i = 0; i < parts.length;) { const st = parts[i++]; if (/^[RC]/.test(st)) { files.push({ status: st[0], from: parts[i++], path: parts[i++] }); } else files.push({ status: st[0], path: parts[i++] }); }
  const stat = (await git(['diff', '--cached', '--stat', '--no-color', base], { cwd: dir, signal, hooks, ...t })).stdout.trim();
  return { patch, files, stat };
}

// the commit on dev/<job-id> -> the new commit's sha
export async function commitWorktree({ dir, jobId, message, signal = null, hooks = null, runner, timeoutMs }) {
  const t = { runner, timeoutMs };
  await assertOnBranch({ dir, jobId, signal, hooks, ...t });
  const msg = String(message || '').replace(/[\0\r]/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim();
  if (!msg) throw new RepoRefusal('a commit needs a message');
  // a line break cannot pass as one argument (lib/proc.mjs), so the message goes as one -m per paragraph line
  const ms = msg.split('\n').filter(Boolean).flatMap((l) => ['-m', l]);
  ok(await git(['commit', '--no-verify', '--quiet', ...ms], { cwd: dir, signal, hooks, identity: true, ...t }), 'git commit');
  return ok(await git(['rev-parse', 'HEAD'], { cwd: dir, signal, hooks, ...t }), 'git rev-parse HEAD');
}

// the worktree is removed when the job's commit is made; the branch stays in the mirror (the owner pulls it)
export async function removeWorktree({ J, productId, dir, signal = null, runner, timeoutMs }) {
  const mirror = mirrorDir(J.dataRoot, productId), hooks = noHooks(J.dataRoot, productId), t = { runner, timeoutMs };
  if (!fs.existsSync(dir)) return { removed: false };
  const r = await git(['worktree', 'remove', '--force', J.dataJail(dir)], { gitDir: mirror, signal, hooks, ...t });
  if (r.code !== 0 && fs.existsSync(dir)) { J.remove(dir); await git(['worktree', 'prune'], { gitDir: mirror, signal, hooks, ...t }); }
  return { removed: true };
}

// the branch's commit in the mirror (the merge request's card), or null
export async function branchHead({ J, productId, jobId, signal = null, runner, timeoutMs }) {
  const r = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + refGuard(branchOf(jobId), jobId)], { gitDir: mirrorDir(J.dataRoot, productId), signal, hooks: noHooks(J.dataRoot, productId), runner, timeoutMs });
  return r.code === 0 ? r.stdout.trim() : null;
}

// what the owner runs in their own clone to look at the branch (the engine never pushes): a fetch from the Station's mirror
export function pullCommand({ dataRoot, productId, jobId }) {
  const b = branchOf(jobId), m = mirrorDir(dataRoot, productId).replace(/\\/g, '/');
  return 'git fetch "' + m + '" ' + b + ':' + b;
}
