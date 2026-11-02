// lib/checks.mjs — R2 (RESTRUCTURE.md §5.4; owner, R0.3): a product's checks (`run_check` and the line's checks step), in Docker only.
//   - the check name maps to a fixed argv in config/products/<id>.json runChecks (ReplyDesk: test -> python -m pytest -q, as its CI runs
//     it; lint once ruff is merged); an optional test filter is one path (or path::name) with no option, no "..", nothing else
//   - each check runs in a container: --network none, the worktree mounted READ-ONLY at /work and no other host path, a read-only root
//     with a tmpfs /tmp, every capability dropped, no new privileges, a pid, memory and CPU limit, and no environment from the Station
//     (only HOME=/tmp and the switches that stop caches being written); the image is the product's check image (below). R2a.1 (owner,
//     26/10/2026): it runs as nobody (--user 65534:65534), not root, so the image and its lock are unchanged
//   - R2a.1 (owner, 26/10/2026): a worktree holding a secret file by name (lib/secrets.mjs: .env, .env.*, *.db, keys, .venv/, ...) is
//     refused before Docker starts, so nothing is mounted. The one exception is a file named exactly .env.example (ReplyDesk tracks one):
//     it is scanned for secret content on every check (R1's patterns; a connection string to localhost, the stock default, is allowed)
//     and refused, naming the file and the kind, never the value, if it holds one. The worktree's own .git file (its link) is not a secret
//   - a timeout (runtime.checkTimeoutMs, proposed 300 s) or the E-STOP / the owner's Stop kills it: the docker client is killed and the
//     container is stopped by name (docker kill), so nothing keeps running; a check that timed out blocks the job (engineering.mjs)
//   - output capped at 200 KB (lib/proc.mjs)
//   - no Docker (not installed, not running): the check is refused with the reason; there is no best-effort fallback on the host
// The check image (station-check-<product>:<sha>): built by the engine on the owner's command (npm run check-image -- <product>) from the
// product's requirements file at main in the mirror, on the product's checkImage.base. ReplyDesk's requirements.txt gives version ranges
// and has no lockfile, so the build records `pip freeze` (what it resolved) next to the image; the tag is the sha256 of the Dockerfile
// and the requirements, so a changed requirements file needs a new image (a dependency.add the owner approves first). A job uses the
// image for main's requirements; a check refuses to run when that image has not been built yet.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run as procRun, ProcError } from './proc.mjs';
import { secretPathHit, secretContentHits } from './secrets.mjs';

export const CHECK_NAMES = ['test', 'lint', 'typecheck', 'format'];
export const FILTER_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}(::[A-Za-z0-9_\[\]-]{1,100})?$/;
export const DEFAULT_TIMEOUT_MS = 300000;
export const CHECK_USER = '65534:65534';   // nobody:nogroup in the Debian-based image
export const ENV_EXAMPLE = '.env.example';
const LOCAL_CONN_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"]+@(?:localhost|127\.0\.0\.1|\[::1\])(?![A-Za-z0-9.-])/gi;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export class CheckRefusal extends Error { constructor(msg, code = 'CHECK') { super(msg); this.code = code; } }

// the secret files in a worktree -> ['<kind> (<path>)' | '<path> holds <kinds>'] ([] when none); links are named, never followed
export function worktreeSecrets(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (!rel && e.name === '.git' && e.isFile()) continue;
      if (e.name === ENV_EXAMPLE && e.isFile()) {
        const hits = secretContentHits(fs.readFileSync(path.join(abs, e.name), 'utf8').replace(LOCAL_CONN_RE, ''));
        if (hits.length) out.push(r + ' holds ' + hits.join(', '));
        continue;
      }
      const hit = secretPathHit(r);
      if (hit) { out.push(hit); continue; }
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
    }
  };
  walk(dir, '');
  return out;
}

export function dockerfileFor(product) {
  const ci = product.checkImage || {};
  if (!ci.base || !/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/.test(ci.base)) throw new CheckRefusal('config/products/' + product.id + '.json checkImage.base must name a base image (e.g. python:3.12-slim)');
  return ['# written by the Station (lib/checks.mjs) for ' + product.id + '; built only on the owner\'s command', 'FROM ' + ci.base, 'WORKDIR /deps', 'COPY requirements.txt /deps/requirements.txt',
    'RUN pip install --no-cache-dir --disable-pip-version-check -r /deps/requirements.txt && pip freeze > /deps/freeze.txt', 'WORKDIR /work', ''].join('\n');
}
// the image a product's checks use for these requirements
export function imageTag(product, requirementsText) { return 'station-check-' + product.id + ':' + sha(dockerfileFor(product) + '\n--\n' + String(requirementsText).replace(/\r\n/g, '\n')).slice(0, 16); }

// argv for a check: the product's fixed argv, plus the filter for test only -> argv[]
export function checkArgv(product, name, filter = null) {
  const rc = product.runChecks || {};
  if (!CHECK_NAMES.includes(name)) throw new CheckRefusal('no such check: ' + name + ' (a check is one of ' + CHECK_NAMES.join(', ') + ')');
  if (!Array.isArray(rc[name]) || !rc[name].length) throw new CheckRefusal(product.id + ' has no "' + name + '" check (config/products/' + product.id + '.json runChecks: ' + (Object.keys(rc).join(', ') || 'none') + ')');
  const argv = rc[name].map(String);
  if (filter == null || filter === '') return argv;
  if (name !== 'test') throw new CheckRefusal('a filter is for the test check only');
  if (typeof filter !== 'string' || !FILTER_RE.test(filter)) throw new CheckRefusal('the filter must be one test path, optionally ::name (letters, digits, _ . / - only, no option, no ".."): ' + JSON.stringify(String(filter).slice(0, 60)));
  return [...argv, filter];
}

// runner: lib/proc.mjs run (tests pass a fake with the same shape)
export function createChecks({ runner = procRun, log = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = 200 * 1024 } = {}) {
  let cached = null;
  async function docker({ fresh = false } = {}) {
    if (cached && !fresh && Date.now() - cached.at < 30000) return cached.v;
    let v;
    try { const r = await runner('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20000 }); v = r.code === 0 && r.stdout.trim() ? { ok: true, version: r.stdout.trim() } : { ok: false, reason: 'Docker is installed but its engine does not answer (is Docker Desktop running?): ' + r.output.trim().split('\n').slice(-1)[0] }; }
    catch (e) { v = { ok: false, reason: e.code === 'NOT_FOUND' ? 'Docker is not installed (no docker on PATH)' : 'Docker did not answer: ' + e.message }; }
    cached = { at: Date.now(), v };
    return v;
  }
  async function needDocker() { const d = await docker(); if (!d.ok) throw new CheckRefusal('checks run only in Docker (owner, R0.3), and ' + d.reason + ': the check is refused (no fallback on the host)', 'NO_DOCKER'); return d; }
  async function imageExists(tag) { const r = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 20000 }); return r.code === 0 ? r.stdout.trim() : null; }

  // one check -> { check, argv, image, exitCode, passed, timedOut, stopped, durationMs, output, capped }
  async function runCheck({ product, name, filter = null, worktree, image, signal = null, timeout = timeoutMs }) {
    const argv = checkArgv(product, name, filter);
    const src = path.resolve(worktree);
    if (!fs.existsSync(src)) throw new CheckRefusal('no worktree at ' + src);
    const secrets = worktreeSecrets(src);
    if (secrets.length) { log && log.warn('check refused: secret files in the worktree', { product: product.id, check: name, found: secrets.slice(0, 10) }); throw new CheckRefusal('refused before Docker starts: the worktree holds ' + secrets.slice(0, 10).join('; ') + (secrets.length > 10 ? ' and ' + (secrets.length - 10) + ' more' : '') + ' (secret files are never mounted into a check; .env.example only while it holds no secret)', 'SECRETS'); }
    await needDocker();
    if (!image) throw new CheckRefusal('no check image is set for this job', 'NO_IMAGE');
    if (!(await imageExists(image))) throw new CheckRefusal('the check image ' + image + ' has not been built: the owner builds it with npm run check-image -- ' + product.id + ' (it downloads the product\'s requirements once)', 'NO_IMAGE');
    if (/[,\0\r\n"]/.test(src)) throw new CheckRefusal('the worktree path cannot be mounted (it holds a comma, a quote or a line break): ' + src);
    const cname = 'station-check-' + crypto.randomBytes(6).toString('hex');
    const args = ['run', '--rm', '--name', cname, '--user', CHECK_USER, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,exec,size=512m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--mount', 'type=bind,source=' + src + ',target=/work,readonly', '--workdir', '/work',
      '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PYTEST_ADDOPTS=-p no:cacheprovider', '--env', 'RUFF_NO_CACHE=true', '--env', 'CI=1', image, ...argv];
    const kill = () => runner('docker', ['kill', cname], { timeoutMs: 20000 }).catch(() => {});
    const t0 = Date.now();
    try {
      const r = await runner('docker', args, { timeoutMs: timeout, signal, maxOutputBytes, onKill: kill });
      log && log.info('check ran', { product: product.id, check: name, filter, exit: r.code, durationMs: r.durationMs, image });
      return { check: name, filter: filter || null, argv, image, exitCode: r.code, passed: r.code === 0, timedOut: false, stopped: false, durationMs: r.durationMs, output: r.output, capped: !!r.capped };
    } catch (e) {
      if (e instanceof ProcError && (e.code === 'TIMEOUT' || e.code === 'STOPPED')) { await kill(); log && log.warn('check killed', { product: product.id, check: name, why: e.code }); return { check: name, filter: filter || null, argv, image, exitCode: null, passed: false, timedOut: e.code === 'TIMEOUT', stopped: e.code === 'STOPPED', timeoutMs: timeout, durationMs: Date.now() - t0, output: (e.output || '') + '\n[' + e.message + ']', capped: false }; }
      throw e;
    }
  }

  // the owner's command: build the product's check image from main's requirements -> { tag, built, freeze }
  async function buildImage({ J, product, requirementsText, signal = null }) {
    await needDocker();
    const tag = imageTag(product, requirementsText), dir = path.join(J.dataRoot, 'products', product.id, 'check-image', tag.split(':')[1]);
    if (await imageExists(tag)) return { tag, built: false, dir, note: 'already built' };
    J.put(path.join(dir, 'Dockerfile'), dockerfileFor(product)); J.put(path.join(dir, 'requirements.txt'), String(requirementsText));
    const b = await runner('docker', ['build', '--quiet', '--pull', '--label', 'station.product=' + product.id, '--label', 'station.requirements.sha256=' + sha(requirementsText), '--tag', tag, J.dataJail(dir)], { timeoutMs: 1800000, signal, maxOutputBytes: 1024 * 1024 });
    if (b.code !== 0) throw new CheckRefusal('docker build failed (exit ' + b.code + '): ' + b.output.trim().split('\n').slice(-6).join(' | '), 'BUILD');
    const f = await runner('docker', ['run', '--rm', '--network', 'none', tag, 'cat', '/deps/freeze.txt'], { timeoutMs: 60000 });
    J.put(path.join(dir, 'freeze.txt'), f.code === 0 ? f.stdout : '(pip freeze could not be read: exit ' + f.code + ')\n');
    J.put(path.join(dir, 'image.json'), JSON.stringify({ tag, product: product.id, base: (product.checkImage || {}).base, requirementsSha256: sha(requirementsText), builtAt: new Date().toISOString(), imageId: await imageExists(tag) }, null, 2) + '\n');
    log && log.info('check image built', { product: product.id, tag });
    return { tag, built: true, dir, freeze: f.code === 0 ? f.stdout : null };
  }
  return { docker, needDocker, imageExists, runCheck, buildImage };
}
