// write-guard.test.mjs — write-guard v2 (ENGINE-PLAN.md §8). Fails if any code could write outside the data jail,
// write into the legacy build (Virtual-workers/, station-workspace/), call the legacy system over HTTP, reach an
// outbound host outside the provider modules, or ship a messaging library or tool. Static scan of src/, scripts/, demo/ and
// tests/, plus unit checks of dataJail() against traversal, links, junctions, case, drives, device paths and 8.3 names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJail, realResolve, JailError } from '../src/engine/store/jail.mjs';
import { tempDir } from './helpers/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'scripts', 'tests', 'demo'];
const CODE_RE = /\.(mjs|js|cjs|ts|html)$/;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
const files = SCAN_DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : [])).filter((f) => CODE_RE.test(f));
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const read = (f) => stripComments(fs.readFileSync(f, 'utf8'));
const code = files.filter((f) => !rel(f).startsWith('tests/'));

// Every filesystem write API, sharp's toFile, Playwright's screenshot-to-path and SQLite opening a file.
export const FS_WRITE_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|rm|rmdirSync|rmdir|renameSync|rename|copyFileSync|copyFile|cpSync|cp|unlinkSync|unlink|createWriteStream|truncateSync|truncate|chmodSync|symlinkSync|symlink|linkSync|utimesSync|utimes|futimesSync|openSync|writeSync|fsyncSync|toFile|DatabaseSync|Database)\s*\(|screenshot\s*\(\s*\{[^}]*\bpath\s*:/g;
// The jail module itself, and the two scripts that write outside the data root through their own jails.
const JAIL_MODULE = 'src/engine/store/jail.mjs';
const OWN_JAILS = { 'scripts/snapshot-fixtures.mjs': 'jail(', 'scripts/screenshots.mjs': 'outJail(', 'scripts/dry-run.mjs': 'outJail(', 'scripts/demo-record.mjs': 'outJail(', 'scripts/screenshots-e5.mjs': 'outJail(', 'scripts/screenshots-r3a.mjs': 'outJail(', 'scripts/screenshots-r3b.mjs': 'outJail(', 'scripts/screenshots-r4a.mjs': 'shotJail(', 'scripts/screenshots-b0.mjs': 'shotJail(', 'scripts/screenshots-r7.mjs': 'shotJail(', 'scripts/build-office.mjs': 'assetJail(' };
const WRITE_ONE = new RegExp(FS_WRITE_RE.source);
const LEGACY_NAME_RE = /Virtual-workers|station-workspace|STATION_LEGACY_ROOT|legacyRoot/;

test('every write in src/ and scripts/ goes through dataJail( (or a script\'s own jail) in the same expression', () => {
  assert.ok(code.length > 15, 'scan found files');
  const offences = [];
  for (const f of code) {
    const r = rel(f); if (r === JAIL_MODULE) continue;
    const src = read(f);
    for (const line of src.split('\n')) for (const m of line.matchAll(FS_WRITE_RE)) {
      const guard = OWN_JAILS[r] || 'dataJail(';
      if (!line.includes(guard)) offences.push(r + ': ' + m[0] + ' without ' + guard + ' -> ' + line.trim().slice(0, 140));
    }
  }
  assert.deepEqual(offences, []);
});

test('no write call anywhere (src, scripts, tests) names the legacy build', () => {
  const offences = [];
  for (const f of files) {
    const r = rel(f); if (r === JAIL_MODULE) continue;
    for (const line of read(f).split('\n')) if (WRITE_ONE.test(line) && LEGACY_NAME_RE.test(line)) offences.push(r + ': ' + line.trim().slice(0, 140));
  }
  assert.deepEqual(offences, []);
});

test('only the allow-listed modules name the legacy root at all (readers, never writers into it)', () => {
  // the legacy view (read-only), the fixtures snapshot (reads legacy, writes fixtures/), the screenshot script (starts
  // the legacy view), the jail (to refuse it), port-drift (read-only hashing) and the importer (E4)
  const allowed = new Set([JAIL_MODULE, 'src/server/index.mjs', 'scripts/snapshot-fixtures.mjs', 'scripts/screenshots.mjs', 'scripts/port-drift.mjs', 'src/engine/paths.mjs']);
  for (const f of code) { const r = rel(f); if (allowed.has(r) || r.startsWith('src/engine/import/')) continue; assert.ok(!/Virtual-workers|STATION_LEGACY_ROOT/.test(read(f)), r + ' names the legacy root'); }
});

test('no HTTP to the legacy system: no 8787, no legacy token header, no /api/ URL on another host or port', () => {
  for (const f of code) {
    const r = rel(f), src = read(f);
    assert.ok(!/x-starnet-token|SKYNET_API_TOKEN|STATION_OFFICE_STARNET/i.test(src), r + ' names a legacy token');
    assert.ok(!/['"`]https?:\/\/[^'"`]*:8787/.test(src), r + ' names the legacy port in a URL');
    assert.ok(!/['"`]https?:\/\/[^'"`\s]+\/api\//.test(src), r + ' calls an /api/ route on another origin');
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'server', 'starnet-api.mjs')), 'the legacy live-read client is deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'write-adapter')), 'the disabled write adapter is deleted');
});

test('outbound hosts: only the provider modules name an external host', () => {
  // URL literals allowed outside providers: loopback (our own server), the URL-parsing base, the SVG namespace
  // R1: the guard compares a price's cited source with Anthropic's official pricing page (guard.mjs OFFICIAL_PRICING); nothing fetches it
  const harmless = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)|^http:\/\/www\.w3\.org\/2000\/svg$|^https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/pricing$/;
  // E7a: the mock Etsy names etsy.com URLs as FIXTURE data only (the authorize page it checks, a shop and listing URLs); it
  // never fetches. The real Etsy client takes its hosts from config/engine.json etsy (https etsy.com URLs, checked there)
  const PROVIDER_HOSTS = { 'src/engine/providers/openrouter.mjs': /^https:\/\/openrouter\.ai\//, 'src/engine/providers/anthropic.mjs': /^https:\/\/api\.anthropic\.com$/, 'src/engine/providers/etsy-mock.mjs': /^https:\/\/www\.etsy\.com\/(oauth\/connect|shop\/|listing\/)/ };
  for (const f of code) {
    const r = rel(f);
    for (const m of read(f).matchAll(/['"`](https?:\/\/[^'"`\s)]+)/g)) {
      const u = m[1]; if (harmless.test(u)) continue;
      assert.ok(PROVIDER_HOSTS[r] && PROVIDER_HOSTS[r].test(u), r + ' names an outbound host outside a provider module: ' + u);
    }
  }
  // fetch() with a non-relative URL only in the provider modules (the page and the server fetch their own origin)
  for (const f of code) { const r = rel(f); if (PROVIDER_HOSTS[r]) continue; assert.ok(!/fetch\s*\(\s*['"`]https?:/.test(read(f)), r + ' fetches an absolute URL'); }
});

test('no messaging: no mail, chat or SMS library in package.json, no messaging import anywhere', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  const DENY = /mail|smtp|sendgrid|mailgun|postmark|twilio|vonage|nexmo|plivo|slack|discord|telegra|whatsapp|signal|matrix-|irc|pusher|socket\.io|firebase|onesignal|web-push|apn|fcm|sms|messagebird|teams|mattermost|zulip|rocket\.chat/i;
  for (const d of deps) assert.ok(!DENY.test(d), 'messaging dependency: ' + d);
  for (const f of code) assert.ok(!/from\s+['"](nodemailer|twilio|@slack\/|discord\.js|telegraf|node-telegram-bot-api|@sendgrid\/|web-push)/.test(read(f)), rel(f) + ' imports a messaging library');
});

// owner decision 17/10/2026: Real-ESRGAN may run as a local child process, from ONE module only, pinned, without a shell, killable
const UPSCALER_MODULE = 'src/engine/lib/esrgan.mjs';
// R2 (owner, R0.3: checks in Docker; the engine's own git mirror): git and docker run from ONE more module, lib/proc.mjs, the same way
const PROC_MODULE = 'src/engine/lib/proc.mjs';
test('the git and docker runner (R2) runs execFile without a shell, hidden, killable, with a minimal environment, from one call site', () => {
  const pr = read(path.join(ROOT, PROC_MODULE));
  assert.match(pr, /import \{ execFile \} from 'node:child_process'/);
  assert.ok(!/execSync|spawnSync|\bspawn\s*\(|(?<!\.)\bexec\s*\(|shell\s*:\s*true/.test(pr), 'only execFile, never a shell');
  assert.equal((pr.match(/execFile\(/g) || []).length, 1, 'one call site');
  for (const must of ['shell: false', 'windowsHide: true', 'signal: signal || undefined', "export const PROGRAMS = ['git', 'docker']", 'env: minimalEnv(program']) assert.ok(pr.includes(must), PROC_MODULE + ' lacks ' + must);
});
test('no shelling out anywhere in src/ except the pinned upscaler module (and the R2 git/docker runner), which runs execFile without a shell, hidden and killable', () => {
  for (const f of code.filter((x) => rel(x).startsWith('src/') && rel(x) !== UPSCALER_MODULE && rel(x) !== PROC_MODULE)) assert.ok(!/child_process|execSync|spawnSync|\bspawn\s*\(|\bexecFile\s*\(/.test(read(f)), rel(f) + ' shells out');
  const u = read(path.join(ROOT, UPSCALER_MODULE));
  assert.match(u, /import \{ execFile \} from 'node:child_process'/);
  assert.ok(!/execSync|spawnSync|\bspawn\s*\(|(?<!\.)\bexec\s*\(|shell\s*:\s*true/.test(u), 'only execFile, never a shell');
  assert.equal((u.match(/execFile\(/g) || []).length, 1, 'one call site');
  for (const must of ['signal: signal || undefined', 'windowsHide: true', 'cwd: dataJail(cwd)', 'checkPin(pin)', 'env,']) assert.ok(u.includes(must), UPSCALER_MODULE + ' lacks ' + must);
});

test('the page only ever talks to its own origin', () => {
  for (const f of files.filter((x) => rel(x).startsWith('src/web/'))) {
    const src = read(f);
    for (const m of src.matchAll(/fetch\s*\(\s*(['"`])([^'"`]*)\1/g)) assert.ok(m[2].startsWith('/api/'), rel(f) + ' fetches ' + m[2]);
    assert.ok(!/new\s+WebSocket|XMLHttpRequest|navigator\.sendBeacon/.test(src), rel(f) + ' opens another channel');
  }
});

// ---------------------------------------------------------------- dataJail unit checks
function tempJail() {
  const base = tempDir('station-jail-');
  const data = path.join(base, 'data'), logs = path.join(base, 'logs'), legacy = path.join(base, 'Legacy-build');
  fs.mkdirSync(logs); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'keep.txt'), 'legacy');
  const J = createJail({ dataRoot: data, extraRoots: [logs], legacyRoots: [legacy] });
  return { base, data, logs, legacy, J, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('dataJail: inside the data root and logs is allowed; the roots themselves are not write targets', () => {
  const t = tempJail();
  try {
    assert.equal(t.J.dataJail(path.join(t.data, 'jobs', 'x', 'brief.md')), path.join(t.data, 'jobs', 'x', 'brief.md'));
    assert.equal(t.J.dataJail('jobs/x/brief.md'), path.join(t.data, 'jobs', 'x', 'brief.md'), 'relative paths resolve inside the data root');
    assert.ok(t.J.dataJail(path.join(t.logs, 'a.log')).startsWith(t.logs));
    assert.throws(() => t.J.dataJail(t.data), JailError);
    t.J.put('jobs/x/a.json', '{}'); assert.equal(fs.readFileSync(path.join(t.data, 'jobs', 'x', 'a.json'), 'utf8'), '{}');
    t.J.add('ledger/l.jsonl', 'a\n', { fsync: true }); t.J.add('ledger/l.jsonl', 'b\n'); assert.equal(fs.readFileSync(path.join(t.data, 'ledger', 'l.jsonl'), 'utf8'), 'a\nb\n');
  } finally { t.done(); }
});

test('dataJail: traversal, other roots, other drives, device and UNC paths are refused', () => {
  const t = tempJail();
  try {
    for (const bad of ['../x', '../../x', 'jobs/../../x', path.join(t.base, 'x'), path.join(t.legacy, 'keep.txt'), path.join(t.data, '..', 'Legacy-build', 'y'),
      '\\\\?\\' + path.join(t.data, 'x'), '\\\\.\\' + path.join(t.data, 'x'), '\\\\server\\share\\x', '//server/share/x', 'C:relative.txt', os.homedir(), path.join(ROOT, 'src', 'x.mjs')]) {
      assert.throws(() => t.J.dataJail(bad), JailError, bad);
    }
    if (process.platform === 'win32') {
      const other = /^c:/i.test(t.data) ? 'D:\\station\\x' : 'C:\\station\\x';
      assert.throws(() => t.J.dataJail(other), JailError, 'other drive');
      // mixed case of the data root is the same folder on Windows: allowed; mixed case of the legacy root: refused
      assert.ok(t.J.dataJail(t.data.toUpperCase() + '\\jobs\\y').toLowerCase().startsWith(t.data.toLowerCase()));
      assert.throws(() => t.J.dataJail(t.legacy.toUpperCase() + '\\z'), JailError, 'legacy root in another case');
    }
  } finally { t.done(); }
});

test('dataJail: any Virtual-workers or station-workspace segment is refused, whatever the configured roots', () => {
  const t = tempJail();
  try {
    for (const bad of [path.join(t.data, 'Virtual-workers', 'x'), path.join(t.data, 'jobs', 'station-workspace', 'x'), path.join(t.data, 'VIRTUAL-WORKERS', 'x'), path.resolve(ROOT, '..', 'Virtual-workers', 'station-workspace', 'starnet', 'x.json')]) assert.throws(() => t.J.dataJail(bad), JailError, bad);
  } finally { t.done(); }
});

test('dataJail: a symlink or junction inside the data root that points outside is refused', (tt) => {
  const t = tempJail();
  try {
    fs.mkdirSync(t.data, { recursive: true });
    const link = path.join(t.data, 'escape');
    try { fs.symlinkSync(t.legacy, link, 'junction'); } catch (e) { tt.skip('cannot create a junction here: ' + e.code); return; }
    assert.throws(() => t.J.dataJail(path.join(link, 'keep.txt')), JailError, 'junction to the legacy root');
    assert.throws(() => t.J.put(path.join(link, 'new.txt'), 'x'), JailError);
    assert.equal(fs.readFileSync(path.join(t.legacy, 'keep.txt'), 'utf8'), 'legacy', 'legacy file untouched');
    const out = path.join(t.base, 'outside'); fs.mkdirSync(out);
    const link2 = path.join(t.data, 'out2'); fs.symlinkSync(out, link2, 'junction');
    assert.throws(() => t.J.dataJail(path.join(link2, 'a.txt')), JailError, 'junction to an unrelated folder');
  } finally { t.done(); }
});

test('dataJail: 8.3 short names are expanded before the check', (tt) => {
  if (process.platform !== 'win32') { tt.skip('Windows only'); return; }
  const t = tempJail();
  try {
    let short = '';
    try { short = execFileSync('cmd.exe', ['/d', '/s', '/c', '"for %I in ("' + t.legacy + '") do @echo %~sI"'], { encoding: 'utf8', windowsVerbatimArguments: true }).trim(); } catch (_) { /* no 8.3 support */ }
    if (!short || short.toLowerCase() === t.legacy.toLowerCase()) { tt.skip('8.3 names are disabled on this volume'); return; }
    assert.equal(realResolve(short).toLowerCase(), t.legacy.toLowerCase());
    assert.throws(() => t.J.dataJail(path.join(short, 'keep.txt')), JailError, 'short name of the legacy root');
  } finally { t.done(); }
});

test('createJail refuses a data root that overlaps the legacy root, in either direction', () => {
  const base = tempDir('station-jail-');
  try {
    const legacy = path.join(base, 'legacy'); fs.mkdirSync(legacy);
    assert.throws(() => createJail({ dataRoot: path.join(legacy, 'data'), extraRoots: [], legacyRoots: [legacy] }), /overlap/);
    assert.throws(() => createJail({ dataRoot: base, extraRoots: [], legacyRoots: [legacy] }), /overlap/);
    assert.throws(() => createJail({ dataRoot: path.resolve(ROOT, '..', 'Virtual-workers', 'data'), extraRoots: [] }), JailError);
    assert.ok(!fs.existsSync(path.join(legacy, 'data')), 'nothing was created inside the legacy root');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('snapshot-fixtures: writes are jailed to office-agents/fixtures/, reads refuse secrets and paths outside the source', async () => {
  const { jail, sourcePath, OUT_ROOT } = await import('../scripts/snapshot-fixtures.mjs');
  assert.equal(OUT_ROOT, path.join(ROOT, 'fixtures'));
  assert.ok(jail('station-root/x.json').startsWith(path.join(ROOT, 'fixtures') + path.sep));
  for (const bad of ['../package.json', '..', '.', '../../Virtual-workers/station-workspace/x', path.resolve(ROOT, '..', 'Virtual-workers', 'station-workspace', 'x'), 'synthetic/overlay.json', 'synthetic']) assert.throws(() => jail(bad), /refusing/, bad);
  const src = path.resolve(ROOT, '..', 'Virtual-workers');
  assert.equal(sourcePath(src, 'station-workspace/starnet/ledger.jsonl'), path.join(src, 'station-workspace', 'starnet', 'ledger.jsonl'));
  for (const bad of ['../office-agents/.env', '.env', 'station-workspace/starnet/.secrets/provider-keys.json', 'starnet/provider-keys.json', 'station-workspace/research-lab/.git/config']) assert.throws(() => sourcePath(src, bad), /refusing/, bad);
});

test('import-legacy: writes only through the data jail; reads refuse secrets, VCS folders and paths outside the source', async () => {
  // statically: no direct fs write call in the importer, only the jail's helpers (J.put, J.copy, J.move, J.remove,
  // J.makeDir) or a path passed through dataJail( on the same line
  for (const f of code.filter((x) => rel(x).startsWith('src/engine/import/') || rel(x) === 'scripts/import-legacy.mjs')) {
    for (const line of read(f).split('\n')) for (const m of line.matchAll(FS_WRITE_RE)) assert.ok(line.includes('dataJail('), rel(f) + ': ' + m[0] + ' without dataJail(');
  }
  const { openSource, SECRET_RE } = await import('../src/engine/import/legacy.mjs');
  for (const bad of ['.secrets', 'starnet/.secrets/provider-keys.json', '.env', '.env.local', 'research-lab/.git/config', 'provider-keys.json']) assert.ok(SECRET_RE.test(bad), bad);
  const base = tempDir('station-src-');
  try {
    const sw = path.join(base, 'station-workspace', 'starnet');
    fs.mkdirSync(sw, { recursive: true });
    const src = openSource(base);
    for (const bad of ['../x', '../../package.json', '.env', 'starnet/.secrets/provider-keys.json', 'research-lab/.git/config']) assert.throws(() => src.abs(bad), /refusing/, bad);
    assert.equal(src.abs('starnet/ledger.jsonl'), path.join(base, 'station-workspace', 'starnet', 'ledger.jsonl'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('screenshots: writes are jailed to office-agents/screenshots/', async () => {
  const { outJail, SHOTS_ROOT } = await import('../scripts/screenshots.mjs');
  assert.equal(SHOTS_ROOT, path.join(ROOT, 'screenshots'));
  assert.ok(outJail('e1/01.png').startsWith(SHOTS_ROOT + path.sep));
  for (const bad of ['../x.png', '..', '../../Virtual-workers/x.png', path.join(ROOT, 'data', 'x.png')]) assert.throws(() => outJail(bad), /refusing/, bad);
});

test('the legacy view server answers only GET/HEAD and serves only three.js build files', async () => {
  const { createOfficeServer } = await import('../src/server/index.mjs');
  const { makeLogger } = await import('../src/server/log.mjs');
  const dir = path.join(ROOT, 'logs', 'test-' + process.pid);
  const log = makeLogger({ dir, name: 'test', quiet: true });
  const { server } = createOfficeServer({ fixtures: true, log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) { const r = await fetch(base + '/api/office/snapshot', { method }); assert.equal(r.status, 405, method); }
    const r = await fetch(base + '/api/office/health'); assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.view, 'legacy');
    const v = await fetch(base + '/vendor/three/package.json'); assert.equal(v.status, 404, 'only build/ and examples/jsm/ of three are served');
    const t = await fetch(base + '/../package.json'); assert.notEqual(t.status, 200);
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the synthetic overlay can never be applied to a live (non-fixtures) read', async () => {
  const { applySynthetic } = await import('../src/server/sources/synthetic.mjs');
  assert.throws(() => applySynthetic({ mode: 'files', sessions: [], runs: [], spendPending: [], queue: {}, tracker: [] }, { items: [] }, { now: 0 }), /fixtures mock only/);
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.mjs'), 'utf8');
  assert.match(idx, /const useSynthetic = mode === 'fixtures' &&/);
});
