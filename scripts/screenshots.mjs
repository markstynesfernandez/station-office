// screenshots.mjs — starts a Station server, opens ITS OWN page in Chromium and captures the review views at 1600x1000,
// then measures the frame rate of each view. Never opens any other URL (never the legacy system's 8787). Each view is a
// fresh page load. Every file it writes goes through outJail() (office-agents/screenshots/ only). Usage:
//   npm run screenshots                                  -> screenshots/e1/*.png, legacy view of the fixtures (headless)
//   node scripts/screenshots.mjs --headed                -> same, in a visible Google Chrome window (fps as you'd see it)
//   node scripts/screenshots.mjs --out e1b --live        -> legacy view of .env STATION_LEGACY_ROOT (read-only)
//   node scripts/screenshots.mjs --set r1 --headed --out redesign-r1   -> the Redesign R1 views (overview light/dark,
//                                                           each room, the lounge, a desk panel, the board) + fps-headed.json
//   node scripts/screenshots.mjs --set r2 --headed --out redesign-r2   -> the Redesign R2 views (overviews, lounge and
//                                                           board in engine mode on the mock provider; rooms, people
//                                                           close-up and desk panel in the legacy fixtures view) + fps
//   --only 01,03                                          -> just those views (by file-name prefix)
// FPS: after each capture the page renders continuously for --bench-ms (default 3000) twice: once with the camera moving
// every frame (the real pan/zoom path; AO is skipped while moving) and once at full quality with AO on (the cost of each
// animation tick or settled frame). At rest the page renders on demand only. Overlay views pause the 3D scene, so their
// number is the page's own frame rate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createOfficeServer, ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { loadEnv } from '../src/lib/legacy-readers/common.mjs';

export const SHOTS_ROOT = path.resolve(ROOT, 'screenshots');
// the only way this script writes: a path inside office-agents/screenshots/
export function outJail(p) { const f = path.resolve(SHOTS_ROOT, p); if (!f.startsWith(SHOTS_ROOT + path.sep)) throw new Error('refusing to write outside screenshots/: ' + p); return f; }
export const W = 1600, H = 1000;

// Headed: the installed Google Chrome. Headless: the full Chromium build on the real GPU, SwiftShader as a fallback.
// channel (R3 spike): one named browser only, e.g. 'chromium' headed (Playwright's Chromium: Windows gives it the default
// GPU, so it can measure the iGPU when a per-app setting sends chrome.exe to another GPU)
export async function launch({ headed = false, channel = null } = {}) {
  // R3b: a headed window that gets covered is not throttled by Chromium itself (Windows may still slow it; the capture
  // scripts retry a throttled bench)
  const NO_THROTTLE = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  const attempts = channel ? [{ label: channel + (headed ? ' (headed)' : ' (headless)'), opts: { headless: !headed, channel, args: ['--window-size=' + W + ',' + (H + 140), ...(headed ? NO_THROTTLE : [])] } }] : headed
    ? [{ label: 'Google Chrome (headed)', opts: { headless: false, channel: 'chrome', args: ['--window-size=' + W + ',' + (H + 140)] } }, { label: 'Chromium (headed)', opts: { headless: false, channel: 'chromium' } }]
    : [{ label: 'chromium + GPU (headless)', opts: { headless: true, channel: 'chromium', args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=default'] } },
       { label: 'headless shell + SwiftShader', opts: { headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl'] } }];
  for (const a of attempts) {
    try {
      const browser = await chromium.launch(a.opts);
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      const gl = await page.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); if (!g) return null; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl (renderer hidden)'; });
      await page.close();
      if (gl) { console.log('browser:', a.label, '| GL renderer:', gl); return { browser, label: a.label, gl }; }
      await browser.close();
    } catch (e) { console.log('launch failed for', a.label + ':', e.message.split('\n')[0]); }
  }
  throw new Error('no WebGL-capable browser');
}

export const settle = async (page) => { await page.waitForFunction(() => window.__office.settled(), null, { timeout: 15000 }); await page.evaluate(() => new Promise((r) => { let i = 0; const f = () => (++i >= 12 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); })); };

// One capture: fresh page load, optional action, screenshot through outJail(), then the fps bench unless fps is off.
export function makeViewer({ browser, base, outDir, log, problems, fpsRows, benchMs = 3000, noShots = false, fps = true }) {
  return async function view(name, query, act, note = '') {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(name + ' console.error: ' + m.text()); });
    try {
      await page.goto(base + '/?anim=0&' + query, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
      await settle(page);
      if (act) await act(page);
      await settle(page); await page.waitForTimeout(250);
      const f = path.join(outDir, name);
      if (!noShots) { const png = await page.screenshot({ type: 'png' }); fs.writeFileSync(outJail(f), png); console.log('wrote', f); log.written(f); }
      if (fps) {
        const moving = await page.evaluate((ms) => window.__office.bench(ms, { move: true }), benchMs);
        const full = moving.paused ? moving : await page.evaluate((ms) => window.__office.bench(ms, { move: false }), benchMs);
        fpsRows.push({ view: name, moving, full, note: moving.paused ? '(3D scene paused behind the overlay; page frame rate)' : note });
        console.log('  fps', name.padEnd(24), 'moving', String(moving.fps).padStart(6), '| full quality', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms |', full.calls + ' calls', moving.paused ? '(scene paused)' : '');
      }
      return f;
    } finally { await page.close(); }
  };
}

// --engine: the real engine on the station data root (data/, or STATION_DATA_ROOT) on the MOCK provider, as `npm start`
// runs it, after the legacy import (E4). Five views into screenshots/<--out, default e4>/; no fps bench.
async function engineMain(arg, headed) {
  if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('engine screenshots run on the mock provider only (STATION_PROVIDER=' + process.env.STATION_PROVIDER + ')');
  const { createJail } = await import('../src/engine/store/jail.mjs');
  const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
  const { createEngineServer } = await import('../src/server/engine-server.mjs');
  const outDir = String(arg('--out', 'e4')).replace(/^screenshots[/\\]/, '');
  fs.mkdirSync(outJail(outDir), { recursive: true });
  const J = createJail();
  const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-engine', jail: J });
  const engine = openScriptEngine({ archiveSandbox: true, J, log, purpose: 'screenshots', startsJobs: true });
  if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
  const { server, closeAll } = createEngineServer({ engine, log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('station engine for screenshots:', base, '(data root ' + J.dataRoot + ', provider ' + engine.providers.mode + ')');
  const { browser } = await launch({ headed });
  const problems = [], files = [];
  const view = makeViewer({ browser, base, outDir, log, problems, fpsRows: [], fps: false });
  const legacyJob = arg('--job', '2026-10-14--outdoors-dad-camping-tee-r5');
  try {
    files.push(await view('01-overview.png', 'theme=light'));
    files.push(await view('02-board.png', 'theme=light', async (page) => { await page.keyboard.press('b'); await page.waitForSelector('#board:not(.hidden) .lanes .lane.parked', { timeout: 15000 }); }));
    files.push(await view('03-calendar-month.png', 'theme=light', async (page) => { await page.evaluate(() => { window.__office.openCalendar(); window.__office.calendar.toggleMode('month'); }); await page.waitForSelector('#calendar .cal-grid', { timeout: 15000 }); }));
    files.push(await view('04-memory-core.png', 'theme=light', async (page) => { await page.evaluate(() => window.__office.openLedger()); await page.waitForSelector('#ledger-body .ledger-grid', { timeout: 15000 }); await page.waitForTimeout(400); }));
    files.push(await view('05-legacy-job-panel.png', 'theme=light', async (page) => {
      await page.evaluate((id) => window.__office.showJob(id), legacyJob);
      await page.waitForSelector('#sidepanel:not(.hidden) .legbox', { timeout: 15000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
    }));
    console.log('\nScreenshots:\n' + files.join('\n'));
    if (problems.length) { console.error('\nPage problems:\n' + problems.join('\n')); process.exitCode = 1; }
  } catch (e) {
    console.error('screenshot run failed:', e.message); if (problems.length) console.error(problems.join('\n')); process.exitCode = 1;
  } finally { await browser.close(); closeAll(); server.close(); engine.close(); }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--engine')) return engineMain(arg, argv.includes('--headed'));
  const live = argv.includes('--live'), headed = argv.includes('--headed'), noShots = argv.includes('--fps-only');
  const outDir = outJail(String(arg('--out', 'e1')).replace(/^screenshots[/\\]/, ''));
  const benchMs = Number(arg('--bench-ms', 3000));
  fs.mkdirSync(outJail(outDir), { recursive: true });
  loadEnv(path.join(ROOT, '.env'));
  const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots' });
  const stationRoot = live && process.env.STATION_LEGACY_ROOT ? path.resolve(process.env.STATION_LEGACY_ROOT) : null;
  const { server, mode } = createOfficeServer({ stationRoot, fixtures: !stationRoot, log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log('station server for screenshots:', base, '(legacy view, ' + mode + ')');
  const { browser, label: browserLabel, gl } = await launch({ headed });
  const problems = [], fpsRows = [];
  const view = makeViewer({ browser, base, outDir, log, problems, fpsRows, benchMs, noShots });
  const files = [];
  const only = arg('--only', null), want = (name) => !only || only.split(',').some((p) => name.startsWith(p));
  // fps while people walk (animation on): every idle agent is set to working on the page (display only), so they all
  // walk from the lounge to their desks during the bench (full quality, camera still)
  async function walkBench(at, where) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push('walk pageerror: ' + e.message));
    try {
      await page.goto(at + '/?theme=dark', { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
      await settle(page); await page.waitForTimeout(500);
      const n = await page.evaluate(() => { const s = structuredClone(window.__office.snapshot()); let k = 0; for (const a of s.agents) if (a.status === 'idle') { a.status = 'working'; k++; } window.__office.office.setData(s); return k; });
      const full = await page.evaluate((ms) => window.__office.bench(ms, { move: false }), benchMs);
      const still = await page.evaluate(() => window.__office.stats().walking);
      fpsRows.push({ view: 'walk (' + where + ', ' + n + ' agents walking lounge to desk)', moving: full, full, note: 'animation on; ' + still + ' still walking at the end of the bench' });
      console.log('  fps walk (' + n + ' walking)'.padEnd(30), 'full quality', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms');
    } finally { await page.close(); }
  }
  // the engine on the mock provider for the R2 engine-mode views (as --engine below)
  async function startEngineSide() {
    if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('engine screenshots run on the mock provider only');
    const { createJail } = await import('../src/engine/store/jail.mjs');
    const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
    const { createEngineServer } = await import('../src/server/engine-server.mjs');
    const J = createJail(), elog = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-engine', jail: J });
    const engine = openScriptEngine({ archiveSandbox: true, J, log: elog, purpose: 'screenshots', startsJobs: true });
    if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
    const es = createEngineServer({ engine, log: elog });
    await new Promise((r) => es.server.listen(0, '127.0.0.1', r));
    const at = 'http://127.0.0.1:' + es.server.address().port;
    console.log('station engine for screenshots:', at, '(data root ' + J.dataRoot + ', provider ' + engine.providers.mode + ')');
    return { base: at, close: () => { es.closeAll(); es.server.close(); engine.close(); } };
  }
  const setR1 = arg('--set', null) === 'r1', setR2 = arg('--set', null) === 'r2';
  let engineSide = null;
  try {
    if (setR2) {
      // Redesign R2. Engine mode (the real engine on the mock provider, as `npm start` runs it; every agent idle, so
      // all of them sit in the lounge): the overviews, the lounge and the board. Legacy fixtures view (with its
      // labelled synthetic states, so some agents are at their desks): the rooms, the people close-up, the desk panel.
      engineSide = await startEngineSide();
      const viewE = makeViewer({ browser, base: engineSide.base, outDir, log, problems, fpsRows, benchMs, noShots });
      const room = (key, zoom) => async (page) => { await page.evaluate(([k, z]) => { const o = window.__office.office, a = o.anchors.depts[k]; window.__office.focusDept(k, z); o.focus({ x: a.x - 0.9, z: a.z - 0.9 }, z); }, [key, zoom]); };
      const R2 = [
        [viewE, '01-overview-light.png', 'theme=light', null, 'engine mode'],
        [viewE, '02-overview-dark.png', 'theme=dark', null, 'engine mode'],
        [view, '03-research-room.png', 'theme=light', room('research', 1.9), 'legacy fixtures view (zoomed)'],
        [view, '04-design-room.png', 'theme=dark', room('design', 2.3), 'legacy fixtures view (zoomed)'],
        [view, '05-office-room.png', 'theme=dark', room('office', 1.8), 'legacy fixtures view (zoomed)'],
        [viewE, '06-lounge-idle.png', 'theme=dark', async (page) => {
          await page.evaluate(() => { const o = window.__office.office; o.focus(o.anchors.lounge, 2.4); });
          const seated = await page.evaluate(() => window.__office.office.people().filter((p) => p.place === 'lounge').length);
          console.log('  lounge: ' + seated + ' agents seated');
        }, 'engine mode (zoomed)'],
        // the Design room close up with the fixtures' own states (the labelled synthetic overlay, tagged on the page).
        // E5 item 0d: no state is faked on the page for a screenshot; only real engine states, the tagged overlay or the demo
        [view, '07-people-closeup.png', 'theme=light', async (page) => {
          await page.evaluate(() => { const o = window.__office.office, d = o.anchors.desks, ids = window.__office.snapshot().agents.filter((x) => x.dept === 'design').map((x) => x.id), p = ids.map((id) => d[id]).filter(Boolean); o.focus({ x: p.reduce((s, q) => s + q.x, 0) / p.length - 0.2, z: p.reduce((s, q) => s + q.z, 0) / p.length + 0.2 }, 3.3); });
        }, 'legacy fixtures view (zoomed; states from the tagged synthetic overlay)'],
        [view, '08-desk-panel.png', 'theme=light', async (page) => {
          const id = await page.evaluate(() => window.__office.snapshot().agents.find((a) => a.name === 'DESIGNER').id);
          await page.evaluate((id) => window.__office.openAgent(id, 2.4), id);
          await page.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 });
          await page.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete), null, { timeout: 15000 });
        }, 'legacy fixtures view'],
        [viewE, '09-board.png', 'theme=light', async (page) => { await page.keyboard.press('b'); await page.waitForSelector('#board:not(.hidden) .lanes', { timeout: 15000 }); }, 'engine mode (scene behind the board overlay)']
      ];
      for (const [v, name, query, act, note] of R2) if (want(name)) files.push(await v(name, query, act, note));
      if (want('walk')) await walkBench(engineSide.base, 'engine mode, overview, dark');
    } else if (setR1) {
      // Redesign R1: rooms and the lounge zoomed in dark mode (the main look); the desk panel and the board in light
      const room = (key, zoom) => async (page) => { await page.evaluate(([k, z]) => { const o = window.__office.office, a = o.anchors.depts[k]; window.__office.focusDept(k, z); o.focus({ x: a.x - 0.9, z: a.z - 0.9 }, z); }, [key, zoom]); };   // aimed a little behind the centre so the back walls are in frame
      const R1 = [
        ['01-overview-light.png', 'theme=light', null, ''],
        ['02-overview-dark.png', 'theme=dark', null, ''],
        ['03-research-room.png', 'theme=dark', room('research', 1.9), '(zoomed)'],
        ['04-design-room.png', 'theme=dark', room('design', 2.3), '(zoomed)'],
        ['05-office-room.png', 'theme=dark', room('office', 1.8), '(zoomed)'],
        ['06-lounge-idle.png', 'theme=dark', async (page) => {
          await page.evaluate(() => { const o = window.__office.office; o.focus(o.anchors.lounge, 2.3); });
          const seated = await page.evaluate(() => window.__office.office.people().filter((p) => p.place === 'lounge').map((p) => p.agentId));
          console.log('  lounge: ' + seated.length + ' agents seated (' + seated.join(', ') + ')');
        }, '(zoomed)'],
        ['07-desk-panel.png', 'theme=light', async (page) => {
          const id = await page.evaluate(() => window.__office.snapshot().agents.find((a) => a.name === 'DESIGNER').id);
          await page.evaluate((id) => window.__office.openAgent(id, 2.4), id);
          await page.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 });
          await page.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete), null, { timeout: 15000 });
        }, ''],
        ['08-board.png', 'theme=light', async (page) => { await page.keyboard.press('b'); await page.waitForSelector('#board:not(.hidden) .lanes', { timeout: 15000 }); }, '(scene behind the board overlay)']
      ];
      for (const [name, query, act, note] of R1) if (want(name)) files.push(await view(name, query, act, note));
      if (want('walk')) await walkBench(base, 'overview, dark');
    } else {
    files.push(await view('01-overview.png', 'theme=light'));
    files.push(await view('02-desk-panel.png', 'theme=light', async (page) => {
      const id = await page.evaluate(() => window.__office.snapshot().agents.find((a) => a.name === 'DESIGNER').id);
      await page.evaluate((id) => window.__office.openAgent(id, 2.4), id);
      await page.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete), null, { timeout: 15000 });
    }));
    files.push(await view('03-calendar.png', 'theme=light', async (page) => {
      await page.evaluate(() => { window.__office.openCalendar(); window.__office.calendar.toggleMode('month'); });
      await page.waitForSelector('#calendar .cal-grid', { timeout: 15000 });
    }, '(scene behind the calendar overlay)'));
    files.push(await view('04-dark-mode.png', 'theme=dark'));
    files.push(await view('05-board.png', 'theme=light', async (page) => {
      await page.keyboard.press('b');
      await page.waitForSelector('#board:not(.hidden) .lanes', { timeout: 15000 });
    }, '(scene behind the board overlay)'));
    files.push(await view('06-overview-zoomed.png', 'theme=light', async (page) => {
      await page.evaluate(() => window.__office.focusDept('office', 3.3));
    }));
    }
    console.log('\nScreenshots:\n' + files.join('\n'));
    const summary = { at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode, views: fpsRows };
    fs.writeFileSync(outJail(path.join(outDir, headed ? 'fps-headed.json' : 'fps.json')), JSON.stringify(summary, null, 2) + '\n');
    console.log('\nAverage fps per view (continuous rendering, ' + benchMs + ' ms each, ' + browserLabel + ', ' + gl + '):');
    console.log('  ' + 'view'.padEnd(24) + 'camera moving'.padStart(14) + 'full quality'.padStart(14) + '  frame avg / p95 (full quality)');
    for (const r of fpsRows) console.log('  ' + r.view.padEnd(24) + (r.moving.fps + ' fps').padStart(14) + (r.full.fps + ' fps').padStart(14) + '  ' + r.full.avgFrameMs + ' / ' + r.full.p95FrameMs + ' ms ' + (r.note || ''));
    if (problems.length) { console.error('\nPage problems:\n' + problems.join('\n')); process.exitCode = 1; }
  } catch (e) {
    console.error('screenshot run failed:', e.message); if (problems.length) console.error(problems.join('\n')); process.exitCode = 1;
  } finally {
    await browser.close(); server.close(); if (engineSide) engineSide.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
