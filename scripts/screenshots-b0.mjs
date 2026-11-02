// screenshots-b0.mjs — B0 captures: the building's floors. The same harness and method as R4a (screenshots-r4a.mjs: Playwright, a fresh
// page per view, the page's own bench, the throttled-bench retry), default quality tier, engine view.
//   node scripts/screenshots-b0.mjs --headed --channel chromium --expect-gpu intel
//        -> screenshots/b0/: floor 1 (etsy-shop, baked) and floor 0 (shared services and the lounge, procedural) in light and dark,
//           an empty floor (a capture-only second business on floor 2 with no lines), the whole-building view, the walk to the
//           lounge on floor 0; fps-b0.json with every view's fps (moving and at full quality)
//   --bench-ms N (default 3000), --only floor1,floor0,empty,building,walk
// Starts its own Station server on a random port: the mock provider, a throwaway data root in the OS temp folder, and a temp copy of
// config/ with the capture-only "second-shop" business (floor 2, no lines) so the empty floor can be shown. Opens only that page.
// Every file goes through shotJail(): screenshots/b0/ (git-ignored) only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { launch, settle, W, H } from './screenshots.mjs';

const SHOTS = path.resolve(ROOT, 'screenshots', 'b0');
// the only way this script writes: a path inside screenshots/b0/, or inside its own temp folder (the throwaway data root and config)
let TMP = null;
export function shotJail(p, root = SHOTS) { if (root !== SHOTS && root !== TMP) throw new Error('unknown capture root'); const f = path.resolve(root, p); if (f !== root && !f.startsWith(root + path.sep)) throw new Error('refusing to write outside ' + root + ': ' + p); return f; }

const argv = process.argv.slice(2), headed = argv.includes('--headed');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const benchMs = Number(arg('--bench-ms', 3000)), only = arg('--only', null), want = (name) => !only || only.split(',').includes(name);
if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('B0 captures run on the mock provider only');
fs.mkdirSync(shotJail('.'), { recursive: true });
const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-b0' });

const { createJail } = await import('../src/engine/store/jail.mjs');
const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
const { createEngineServer } = await import('../src/server/engine-server.mjs');
const tmp = TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'station-b0-engine-'));
// a temp copy of config/. R1: config/businesses/ is retired (the seven-floor company has no spare floor), so the B0 capture-only second
// business, and its empty floor 2, are no longer drawn; the 'empty' shot is skipped
const configDir = path.join(tmp, 'config');
fs.cpSync(path.join(ROOT, 'config'), shotJail('config', tmp), { recursive: true });
const J = createJail({ dataRoot: path.join(tmp, 'data'), extraRoots: [path.join(ROOT, 'logs')] });
const engine = openScriptEngine({ archiveSandbox: true, J, configDir, log: makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-b0-engine', jail: J }), purpose: 'screenshots-b0', startsJobs: true });
if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
const es = createEngineServer({ engine, log }), server = es.server;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
console.log('station server for B0 captures:', base, '(engine view, mock provider, empty temp data root, temp config with a floor-2 business)');
const channel = arg('--channel', null), expectGpu = arg('--expect-gpu', null);
const { browser, label: browserLabel, gl } = await launch({ headed, channel });
const problems = [], fpsRows = [];
if (expectGpu && !String(gl).toLowerCase().includes(expectGpu.toLowerCase())) problems.push('GL renderer is ' + gl + ', expected ' + expectGpu + ': fps rows are not the budget figure');

async function bench(page, move) {
  for (let tries = 1; ; tries++) {
    const r = await page.evaluate(([ms, mv]) => window.__office.bench(ms, { move: mv }), [benchMs, move]);
    if (r.p95FrameMs < 500 || tries >= 4) { if (tries > 1) r.retries = tries - 1; if (r.p95FrameMs >= 500) r.throttled = true; return r; }
    console.log('  (throttled: the window was covered; trying again)'); await page.waitForTimeout(1500);
  }
}
async function openPage(url, tag) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push(tag + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(tag + ' console.error: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
  await page.waitForFunction(() => { const b = window.__office.baked(); return !b.want || b.loaded || b.failed; }, null, { timeout: 30000 });
  return page;
}
const statsOf = (page) => page.evaluate(() => { const s = window.__office.stats(), b = window.__office.baked(); return { tier: s.tier, post: s.post, dpr: s.dpr, gpu: s.gpu || null, baked: b.rooms || [], floor: window.__office.floor() }; });

// one view: fresh page (animation off), the floor, screenshot, then fps moving and at full quality
async function shoot({ name, floor, theme, file, fps = true, building = false }) {
  const page = await openPage(base + '/?anim=0&quality=default&theme=' + theme + '&floor=' + floor, name);
  try {
    await settle(page);
    if (building) { await page.evaluate(() => window.__office.openBuilding()); await page.waitForTimeout(300); }
    await settle(page); await page.waitForTimeout(300);
    const t = await statsOf(page);
    if (t.floor !== floor) problems.push(name + ': the page shows floor ' + t.floor + ', expected ' + floor);
    if (expectGpu && t.gpu && !t.gpu.toLowerCase().includes(expectGpu.toLowerCase())) problems.push(name + ': the page rendered on ' + t.gpu + ', expected ' + expectGpu);
    const png = await page.screenshot({ type: 'png' }); fs.writeFileSync(shotJail(file), png); console.log('wrote', path.relative(ROOT, shotJail(file))); log.written(path.relative(ROOT, shotJail(file)));
    if (building) {
      // the whole-building view is an HTML overlay; the 3D office is paused under it (no frames drawn)
      const paused = await page.evaluate(() => window.__office.office.isPaused ? window.__office.office.isPaused() : null);
      fpsRows.push({ view: name, note: 'HTML overlay; the 3D scene is paused under it (no 3D frames drawn)', paused, ...t });
      console.log('  fps', name.padEnd(26), 'scene paused under the overlay');
    } else if (fps) {
      const moving = await bench(page, true), full = await bench(page, false);
      fpsRows.push({ view: name, floor, moving, full, ...t });
      console.log('  fps', name.padEnd(26), 'moving', String(moving.fps).padStart(6), '| full', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms |', full.calls + ' calls,', full.tris + ' tris | baked', t.baked.join('+') || 'none');
    }
  } finally { await page.close(); }
}

// floor 0: every agent on it (OVERSEER) walking desk -> lounge
async function walkRow(theme) {
  const page = await openPage(base + '/?quality=default&theme=' + theme + '&floor=0', 'walk ' + theme);
  try {
    await settle(page); await page.waitForTimeout(500);
    const started = await page.evaluate(() => {
      const o = window.__office.office, s0 = structuredClone(window.__office.view());
      o.setAnimate(false); for (const a of s0.agents) a.status = 'working', a.onStep = true; o.setData(s0);
      o.setAnimate(true); const s1 = structuredClone(s0); for (const a of s1.agents) a.status = 'idle', a.onStep = false; o.setData(s1);
      return { agents: s1.agents.length, walking: o.people().filter((p) => p.place === 'walking').length };
    });
    const full = await bench(page, false), t = await statsOf(page);
    fpsRows.push({ view: 'floor 0 walk ' + theme + ' (desk to lounge)', floor: 0, moving: full, full, walkingAtStart: started.walking, ...t });
    console.log('  fps floor 0 walk', theme, '(' + started.walking + ' walking)', 'full', String(full.fps).padStart(6));
  } finally { await page.close(); }
}

try {
  if (want('floor1')) for (const th of ['light', 'dark']) await shoot({ name: 'floor 1 etsy-shop ' + th, floor: 1, theme: th, file: 'floor1-' + th + '.png' });
  if (want('floor0')) for (const th of ['light', 'dark']) await shoot({ name: 'floor 0 shared ' + th, floor: 0, theme: th, file: 'floor0-' + th + '.png' });
  // R1: the B0 'empty' floor 2 shot is retired with config/businesses/ (no capture-only second business)
  if (want('building')) await shoot({ name: 'whole building light', floor: 1, theme: 'light', file: 'building-light.png', building: true });
  if (want('walk')) for (const th of ['dark', 'light']) await walkRow(th);
  for (const r of fpsRows) if (r.full && (r.full.throttled || r.moving.throttled)) problems.push('fps ' + r.view + ': throttled after four tries: no reading');
  for (const r of fpsRows) if (r.full && (r.full.fps < 60 || r.moving.fps < 60)) problems.push('fps ' + r.view + ': ' + r.moving.fps + ' moving / ' + r.full.fps + ' full < 60 (default-tier budget)');
  const summary = { at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode: 'engine view (mock provider, empty temp data root, temp config with a floor-2 business)', views: fpsRows, problems };
  fs.writeFileSync(shotJail('fps-b0.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('problems:', problems.length ? problems : 'none');
} finally { await browser.close(); server.close(); es.closeAll(); engine.close(); console.log('engine data root left in the OS temp folder: ' + tmp); }
