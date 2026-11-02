// check-image.mjs — R2a.1 (owner, 26/10/2026; lib/checks.mjs): the product's check image, the container its checks run in. $0: no model.
//   REPLYDESK_REPO=<clone> npm run check-image -- <product>            the plan: the base image, the requirements file at main (its path,
//        sha256 and size), the Dockerfile and the image tag; whether Docker answers and the image is already built; the lock file. It
//        fetches main from the owner's clone (<product>.localRepoEnv) into the Station's own mirror (the clone is only read). Nothing is
//        pulled or built.
//   REPLYDESK_REPO=<clone> npm run check-image -- <product> --apply    builds it: docker pulls the base image and pip downloads the
//        requirements (the network, once); pip freeze is recorded beside it (data/products/<id>/check-image/<sha>/). Refused unless
//        config/products/<id>.json checkImage.base is pinned by digest (@sha256:…).
// The lock (owner, 26/10/2026): config/products/<id>.json checkImage.lock names the owner's record of the installed packages (a pip freeze,
// e.g. config/products/replydesk.lock.txt) and its sha256. The plan checks the file still has that sha256; a build compares the image's
// pip freeze with it and WARNS when a package was added, removed or installed at another version (the requirements give ranges, not
// pins). The script never writes the lock: changing it is the owner's, in a commit.
// The clone's path comes from the shell only (owner, 26/10/2026: never written to an .env); this script does not read .env.
// The engine lock refuses while the server is running (stop it first). Run it in the checkout whose data it builds for.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecks, dockerfileFor, imageTag } from '../src/engine/lib/checks.mjs';
import { fetchMirror, showAtMain } from '../src/engine/lib/repo.mjs';

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const PINNED_RE = /@sha256:[0-9a-f]{64}$/;

// a pip freeze -> Map(normalised name -> { line, spec }); the name is compared as pip does (case, "_" and "." alike), the rest of the
// line (==version, @ url) exactly; comments and blank lines dropped
export function freezeLines(text) {
  const out = new Map();
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/.exec(l); if (!m) continue;
    out.set(m[1].toLowerCase().replace(/[._-]+/g, '-'), { line: l, spec: m[2].trim() });
  }
  return out;
}
// the image's freeze against the lock -> { same, added: [line], removed: [line], changed: [{ lock, now }] }
export function compareFreeze(lockText, freezeText) {
  const a = freezeLines(lockText), b = freezeLines(freezeText), added = [], removed = [], changed = [];
  for (const [k, x] of b) { if (!a.has(k)) added.push(x.line); else if (a.get(k).spec !== x.spec) changed.push({ lock: a.get(k).line, now: x.line }); }
  for (const [k, x] of a) if (!b.has(k)) removed.push(x.line);
  return { same: !added.length && !removed.length && !changed.length, added, removed, changed };
}
// the lock as configured -> null (none) | { file, sha256Recorded, sha256Now, ok, text }
export function readLock(product, configProductsDir) {
  const lk = (product.checkImage || {}).lock; if (!lk || !lk.file) return null;
  const f = path.join(configProductsDir, lk.file), text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  const now = text == null ? null : sha256(text);
  return { file: path.join('config', 'products', lk.file).split(path.sep).join('/'), sha256Recorded: lk.sha256 || null, sha256Now: now, ok: text != null && now === lk.sha256, text };
}

// the plan -> { product, base, pinned, requirements: { path, sha256, bytes }, mirrorHead, tag, dockerfile, docker, built, lock }
export async function checkImagePlan({ J, product, env = process.env, checks = createChecks(), lock = null }) {
  const ci = product.checkImage || {}, file = ci.requirements || 'requirements.txt';
  const m = await fetchMirror({ J, product, env });
  const req = await showAtMain({ J, productId: product.id, file });
  if (req == null) throw new Error(product.name + ' has no ' + file + ' at main (' + m.head.slice(0, 10) + ')');
  const tag = imageTag(product, req), docker = await checks.docker();
  return { product: product.id, base: ci.base || null, pinned: PINNED_RE.test(ci.base || ''), requirements: { path: file, sha256: sha256(req), bytes: Buffer.byteLength(req) }, mirrorHead: m.head, source: m.source + ' ' + m.ref,
    tag, dockerfile: dockerfileFor(product), docker: docker.ok ? 'Docker ' + docker.version : docker.reason, built: docker.ok ? !!(await checks.imageExists(tag)) : null,
    lock: lock ? { file: lock.file, sha256Recorded: lock.sha256Recorded, sha256Now: lock.sha256Now, ok: lock.ok } : null, requirementsText: req };
}

// --apply: build it (refused unless the base is pinned by digest), then the image's pip freeze against the lock
export async function buildCheckImage({ J, product, env = process.env, checks = createChecks(), lock = null }) {
  const plan = await checkImagePlan({ J, product, env, checks, lock });
  if (!plan.pinned) throw new Error('refused: config/products/' + product.id + '.json checkImage.base (' + plan.base + ') is not pinned by digest (@sha256:...): the owner pins it first');
  const b = await checks.buildImage({ J, product, requirementsText: plan.requirementsText });
  const ff = path.join(b.dir, 'freeze.txt'), freeze = b.freeze != null ? b.freeze : fs.existsSync(ff) ? fs.readFileSync(ff, 'utf8') : null;
  const lockCheck = !lock ? { status: 'no lock', note: 'config/products/' + product.id + '.json checkImage.lock is not set' }
    : !lock.ok ? { status: 'lock unreadable or changed', note: lock.file + (lock.sha256Now ? ' has sha256 ' + lock.sha256Now + ', the config records ' + lock.sha256Recorded : ' is missing') }
      : freeze == null ? { status: 'no freeze', note: 'the image\'s pip freeze could not be read' }
        : (() => { const c = compareFreeze(lock.text, freeze); return { status: c.same ? 'same' : 'differs', ...c }; })();
  return { ...plan, built: true, newlyBuilt: b.built, dir: b.dir, freezeSha256: freeze == null ? null : sha256(freeze), lockCheck, freezeText: freeze };
}

// the warnings a plan or a build gives about the lock (empty: none)
export function lockWarnings(r) {
  const w = [];
  if (r.lock && !r.lock.ok) w.push('WARNING: the lock ' + r.lock.file + ' does not match the sha256 recorded in the product config (' + (r.lock.sha256Now || 'file missing') + ' vs ' + r.lock.sha256Recorded + ')');
  const c = r.lockCheck;
  if (c && c.status === 'differs') {
    w.push('WARNING: this build installed different packages from the lock ' + r.lock.file + ':');
    for (const x of c.changed) w.push('  changed: ' + x.lock + ' -> ' + x.now);
    for (const x of c.added) w.push('  added:   ' + x);
    for (const x of c.removed) w.push('  removed: ' + x);
    w.push('  The checks now run on these versions. Update the lock (a commit) only if the owner accepts them.');
  }
  return w;
}

async function main() {
  const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
  const { createJail, APP_ROOT } = await import('../src/engine/store/jail.mjs');
  const { makeLogger } = await import('../src/server/log.mjs');
  const productId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null, apply = process.argv.includes('--apply');
  if (!productId) { console.error('usage: <REPO_ENV>=<clone> npm run check-image -- <product> [--apply]'); process.exit(2); }
  const J = createJail(), log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'check-image', jail: J });
  let engine;
  try { engine = openScriptEngine({ J, log, purpose: 'check-image' }); }
  catch (e) { console.error('the engine did not start: ' + e.message + (e.code === 'LOCKED' ? ' (stop the server first)' : '')); process.exit(1); }
  try {
    const product = engine.company.product(productId); if (!product) throw new Error('no such product: ' + productId);
    const checks = createChecks({ log }), lock = readLock(product, path.join(APP_ROOT, 'config', 'products'));
    const r = apply ? await buildCheckImage({ J, product, checks, lock }) : await checkImagePlan({ J, product, checks, lock });
    delete r.requirementsText; delete r.freezeText;
    const warnings = lockWarnings(r);
    console.log(JSON.stringify({ ...r, warnings, note: apply ? 'built: ' + r.tag + ' (pip freeze in ' + path.relative(APP_ROOT, r.dir) + ')' : 'plan only: nothing pulled or built; add --apply to build (the base must be pinned by digest first)' }, null, 1));
    for (const w of warnings) console.error(w);
    log.info('check-image', { product: productId, apply, tag: r.tag, lock: r.lockCheck ? r.lockCheck.status : r.lock ? (r.lock.ok ? 'ok' : 'mismatch') : 'none', warnings: warnings.length });
  } catch (e) { console.error('check-image refused: ' + e.message); process.exitCode = 1; }
  finally { engine.close(); }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-image.mjs') main();
