// screenshots-r7.mjs — R7a captures: the seven floors of the 3D office. The same harness as B0 and R4a (screenshots-b0.mjs: Playwright, a
// fresh page per view, the page's own bench, the throttled-bench retry), default quality tier, engine view, animation off.
//   node scripts/screenshots-r7.mjs                        headless (the GPU build of Chromium; SwiftShader if there is no GPU)
//   node scripts/screenshots-r7.mjs --headed --channel chromium --expect-gpu intel     the laptop's iGPU, the budget figure
//        -> screenshots/r7/: every floor (6 Penthouse HQ .. G Lobby) in light and dark, the whole-building view (the lift), the
//           floor menu (F); fps-r7.json with each floor's frame time (moving and at full quality) and the building view's
//   --bench-ms N (default 3000), --only floors,building,menu, --floors 6,4,G (R7a.2: only these floors), --no-bench
// Starts its own Station server on a random port: the mock provider, a throwaway data root in the OS temp folder, the repo's config/
// (read only). Opens only that page. Every file goes through shotJail(): screenshots/r7/ (git-ignored) only. No model call, $0.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { launch, settle, W, H } from './screenshots.mjs';

const SHOTS = path.resolve(ROOT, 'screenshots', 'r7');
// the only way this script writes: a path inside screenshots/r7/, or its own throwaway data root (removed at the end)
let TMP = null;
export function shotJail(p, root = SHOTS) { if (root !== SHOTS && root !== TMP) throw new Error('unknown capture root'); const f = path.resolve(root, p); if (f !== root && !f.startsWith(root + path.sep)) throw new Error('refusing to write outside ' + root + ': ' + p); return f; }

const argv = process.argv.slice(2), headed = argv.includes('--headed'), noBench = argv.includes('--no-bench');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const benchMs = Number(arg('--bench-ms', 3000)), only = arg('--only', null), want = (name) => !only || only.split(',').includes(name);
if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('R7 captures run on the mock provider only');
fs.mkdirSync(shotJail('.'), { recursive: true });
const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r7' });

const { createJail } = await import('../src/engine/store/jail.mjs');
const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
const { createEngineServer } = await import('../src/server/engine-server.mjs');
const tmp = TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'station-r7-engine-'));
const J = createJail({ dataRoot: path.join(tmp, 'data'), extraRoots: [path.join(ROOT, 'logs')] });
const engine = openScriptEngine({ archiveSandbox: true, J, log: makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r7-engine', jail: J }), purpose: 'screenshots-r7', startsJobs: false });
if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
const es = createEngineServer({ engine, log }), server = es.server;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
console.log('station server for R7 captures:', base, '(engine view, mock provider, empty temp data root)');
const channel = arg('--channel', null), expectGpu = arg('--expect-gpu', null);
const { browser, label: browserLabel, gl } = await launch({ headed, channel });
const problems = [], fpsRows = [], files = [];
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
  return page;
}
const shot = async (page, file) => { const png = await page.screenshot({ type: 'png' }); fs.writeFileSync(shotJail(file), png); const rel = path.relative(ROOT, shotJail(file)); files.push(rel); console.log('wrote', rel); log.written(rel); };

const FLOORS = ['6', '5', '4', '3', '2', '1', 'G'].filter((f) => !arg('--floors', null) || arg('--floors', '').toUpperCase().split(',').includes(f));
async function floorView(floor, theme) {
  const name = 'floor ' + floor + ' ' + theme, page = await openPage(base + '/?anim=0&quality=default&theme=' + theme + '&floor=' + floor, name);
  try {
    await settle(page); await page.waitForTimeout(300);
    const t = await page.evaluate(() => ({ floor: window.__office.floor(), tower: window.__office.office.towerState(), stats: window.__office.stats() }));
    if (t.floor !== floor) problems.push(name + ': the page shows floor ' + t.floor);
    await shot(page, 'floor-' + floor + '-' + theme + '.png');
    if (!noBench) {
      const moving = await bench(page, true), full = await bench(page, false);
      fpsRows.push({ view: name, floor, theme, design: t.tower && t.tower.design, moving, full, tier: t.stats.tier, dpr: t.stats.dpr, gpu: t.stats.gpu });
      console.log('  frame', name.padEnd(14), 'moving', String(moving.avgFrameMs).padStart(6) + ' ms (p95 ' + moving.p95FrameMs + ')', '| full', String(full.avgFrameMs).padStart(6) + ' ms (p95 ' + full.p95FrameMs + ') |', full.fps + ' fps |', full.calls + ' calls,', full.tris + ' tris');
    }
  } finally { await page.close(); }
}

try {
  if (want('floors')) for (const th of ['light', 'dark']) for (const f of FLOORS) await floorView(f, th);
  if (want('building')) for (const th of ['light', 'dark']) {
    const page = await openPage(base + '/?anim=0&quality=default&theme=' + th + '&floor=4', 'building ' + th);
    try { await settle(page); await page.evaluate(() => window.__office.openBuilding()); await page.waitForSelector('#building:not(.hidden) .lift', { timeout: 15000 }); await page.waitForTimeout(300); await shot(page, 'building-' + th + '.png');
      // R7a.1: the whole-building view is an overlay (the 3D scene is paused), so bench reports the page's own frame rate
      if (!noBench) { const full = await bench(page, false); fpsRows.push({ view: 'building ' + th, floor: 'building', theme: th, moving: null, full }); console.log('  frame', ('building ' + th).padEnd(14), '| full', String(full.avgFrameMs).padStart(6) + ' ms (p95 ' + full.p95FrameMs + ') |', full.fps + ' fps' + (full.paused ? ' (scene paused, DOM only)' : '')); }
    } finally { await page.close(); }
  }
  if (want('menu')) for (const th of ['light', 'dark']) {
    const page = await openPage(base + '/?anim=0&quality=default&theme=' + th + '&floor=6', 'menu ' + th);
    try { await settle(page); await page.keyboard.press('f'); await page.waitForSelector('#floor-menu:not(.hidden) .fm-floor', { timeout: 15000 }); await page.waitForTimeout(200); await shot(page, 'floormenu-' + th + '.png'); } finally { await page.close(); }
  }
  for (const r of fpsRows) if (r.full.throttled || (r.moving && r.moving.throttled)) problems.push('frame ' + r.view + ': throttled after four tries: no reading');
  for (const r of fpsRows) if (r.full.avgFrameMs > 16.7 || (r.moving && r.moving.avgFrameMs > 16.7)) problems.push('frame ' + r.view + ': ' + (r.moving ? r.moving.avgFrameMs : '-') + ' ms moving / ' + r.full.avgFrameMs + ' ms full > 16.7 ms (60 fps)');
  const summary = { at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode: 'engine view (mock provider, empty temp data root)', views: fpsRows, files, problems };
  fs.writeFileSync(shotJail('fps-r7.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('problems:', problems.length ? problems : 'none');
  if (problems.length) process.exitCode = 1;
} finally { await browser.close(); es.closeAll(); server.close(); engine.close(); try { fs.rmSync(shotJail('.', tmp), { recursive: true, force: true }); } catch (_) { console.log('temp data root left in the OS temp folder: ' + tmp); } }
