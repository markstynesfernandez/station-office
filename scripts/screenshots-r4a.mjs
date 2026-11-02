// screenshots-r4a.mjs — R4a captures: the warm Office room prototype and the quality tiers. The same harness and method
// as R3b (screenshots-r3b.mjs: Playwright, a fresh page per view, the page's own bench, the throttled-bench retry), the
// R3b cameras (the overview; a room focused a little behind its centre, the Office at R3a's zoom 1.8), engine view.
//   node scripts/screenshots-r4a.mjs --set before --headed --channel chromium --expect-gpu intel
//        -> docs/screens/r4a/before.png (the R3b scene as committed; run before the R4a changes) + the R3b fps rows
//   node scripts/screenshots-r4a.mjs --set default --headed --channel chromium --expect-gpu intel
//        -> after-default.png and after-phone-390.png, the default tier's fps rows on the Intel iGPU (the budget run)
//   node scripts/screenshots-r4a.mjs --set high --headed --channel chrome
//        -> after-high.png, the high tier's fps rows on whatever GPU headed Chrome gets (the RTX here; see DECISIONS)
//   --bench-ms N (default 3000), --only office,overview,walk,phone
// Starts its own Station server on a random port: the engine view on the mock provider with a throwaway data root in
// the OS temp folder (only the engine layout matches every baked area since TREND-SCOUT's desk). Opens only that page.
// Every file goes through shotJail(): the four review captures into docs/screens/r4a/, everything else (extra views,
// fps and size JSON) into screenshots/r4a/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { launch, settle, W, H } from './screenshots.mjs';
import { sizesOf, BUDGET_BYTES, ASSET_DIR } from './build-office.mjs';

const DOCS = path.resolve(ROOT, 'docs', 'screens', 'r4a'), SHOTS = path.resolve(ROOT, 'screenshots', 'r4a');
// the only way this script writes: a path inside docs/screens/r4a/ or screenshots/r4a/
export function shotJail(p, root = SHOTS) { const f = path.resolve(root, p); if (root !== DOCS && root !== SHOTS) throw new Error('unknown capture root'); if (f !== root && !f.startsWith(root + path.sep)) throw new Error('refusing to write outside ' + path.relative(ROOT, root) + ': ' + p); return f; }

const argv = process.argv.slice(2), headed = argv.includes('--headed');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const set = arg('--set', 'default'), benchMs = Number(arg('--bench-ms', 3000)), only = arg('--only', null);
if (!['before', 'default', 'high'].includes(set)) throw new Error('--set before | default | high');
const want = (name) => !only || only.split(',').includes(name);
if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('R4a captures run on the mock provider only');
fs.mkdirSync(shotJail('.', DOCS), { recursive: true }); fs.mkdirSync(shotJail('.'), { recursive: true });
const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r4a' });

const { createJail } = await import('../src/engine/store/jail.mjs');
const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
const { createEngineServer } = await import('../src/server/engine-server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'station-r4a-engine-'));
const J = createJail({ dataRoot: path.join(tmp, 'data'), extraRoots: [path.join(ROOT, 'logs')] });
const engine = openScriptEngine({ archiveSandbox: true, J, log: makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r4a-engine', jail: J }), purpose: 'screenshots-r4a', startsJobs: true });
if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
const es = createEngineServer({ engine, log }), server = es.server;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
console.log('station server for R4a captures:', base, '(engine view, mock provider, empty temp data root) | set', set);
const channel = arg('--channel', null), expectGpu = arg('--expect-gpu', null);
const { browser, label: browserLabel, gl } = await launch({ headed, channel });
const problems = [], fpsRows = [];
if (expectGpu && !String(gl).toLowerCase().includes(expectGpu.toLowerCase())) problems.push('GL renderer is ' + gl + ', expected ' + expectGpu + ': fps rows are not the budget figure');

// the R3b room camera (screenshots-r3b.mjs room()), the Office at R3a's zoom
const room = (key, zoom) => async (page) => { await page.evaluate(([k, z]) => { const o = window.__office.office, a = o.anchors.depts[k]; window.__office.focusDept(k, z); o.focus({ x: a.x - 0.9, z: a.z - 0.9 }, z); }, [key, zoom]); };
const CAM = { office: room('office', 1.8), overview: null };
const tierQuery = set === 'before' ? '' : '&quality=' + set;

async function bench(page, move) {
  for (let tries = 1; ; tries++) {
    const r = await page.evaluate(([ms, mv]) => window.__office.bench(ms, { move: mv }), [benchMs, move]);
    if (r.p95FrameMs < 500 || tries >= 4) { if (tries > 1) r.retries = tries - 1; if (r.p95FrameMs >= 500) r.throttled = true; return r; }
    console.log('  (throttled: the window was covered; trying again)'); await page.waitForTimeout(1500);
  }
}
async function openPage(url, tag, viewport = { width: W, height: H }, dsf = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dsf });
  page.on('pageerror', (e) => problems.push(tag + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(tag + ' console.error: ' + m.text()); if (m.type() === 'warning' && /baked|quality|tier/.test(m.text())) problems.push(tag + ' console.warn: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
  await page.waitForFunction(() => { const b = window.__office.baked(); return !b.want || b.loaded || b.failed; }, null, { timeout: 30000 });
  // the high tier's lightmaps load lazily after the page is up: wait for them before a capture
  await page.waitForFunction(() => { const s = window.__office.stats(); return !s.tier || s.tier !== 'high' || s.highMaps === 'loaded' || s.highMaps === 'failed'; }, null, { timeout: 60000 });
  return page;
}
const tierOf = (page) => page.evaluate(() => { const s = window.__office.stats(); return { tier: s.tier || 'r3b', post: s.post, highMaps: s.highMaps || null, dpr: s.dpr, gpu: s.gpu || null }; });

// one view: fresh page (animation off), camera, screenshot, then fps moving and at full quality
async function shoot({ name, file, root, query, cam, fps = true, viewport, dsf }) {
  const page = await openPage(base + '/?anim=0&' + query + tierQuery, name, viewport, dsf);
  try {
    await settle(page);
    if (cam) await cam(page);
    await settle(page); await page.waitForTimeout(300);
    const b = await page.evaluate(() => window.__office.baked());
    if (!b.rooms.includes('office')) problems.push(name + ': the Office room is not baked ' + JSON.stringify(b));
    const t = await tierOf(page);
    if (set !== 'before' && t.tier !== set) problems.push(name + ': tier ' + t.tier + ', expected ' + set);
    // the page's own context (it asks for high performance): every fps row must come from the expected GPU
    if (expectGpu && t.gpu && !t.gpu.toLowerCase().includes(expectGpu.toLowerCase())) problems.push(name + ': the page rendered on ' + t.gpu + ', expected ' + expectGpu);
    if (set === 'high' && t.highMaps !== 'loaded') problems.push(name + ': high-tier lightmaps ' + t.highMaps);
    if (file) { const png = await page.screenshot({ type: 'png' }); fs.writeFileSync(shotJail(file, root), png); console.log('wrote', path.relative(ROOT, shotJail(file, root))); log.written(path.relative(ROOT, shotJail(file, root))); }
    if (fps) {
      const moving = await bench(page, true), full = await bench(page, false);
      fpsRows.push({ view: name, query: query + tierQuery, moving, full, ...t });
      console.log('  fps', name.padEnd(22), 'moving', String(moving.fps).padStart(6), '| full', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms |', full.calls + ' calls,', full.tris + ' tris |', t.tier, t.post);
    }
  } finally { await page.close(); }
}

// every agent walking desk -> lounge (as R3b's walk rows; display only, nothing is written)
async function walkRow(theme) {
  const page = await openPage(base + '/?theme=' + theme + tierQuery, 'walk ' + theme);
  try {
    await settle(page); await page.waitForTimeout(500);
    const started = await page.evaluate(() => {
      const o = window.__office.office, s0 = structuredClone(window.__office.snapshot());
      o.setAnimate(false); for (const a of s0.agents) a.status = 'working'; o.setData(s0);
      o.setAnimate(true); const s1 = structuredClone(s0); for (const a of s1.agents) a.status = 'idle'; o.setData(s1);
      return { agents: s1.agents.length, walking: o.people().filter((p) => p.place === 'walking').length };
    });
    const full = await bench(page, false), t = await tierOf(page);
    fpsRows.push({ view: 'walk overview ' + theme + ' (all agents desk to lounge)', moving: full, full, walkingAtStart: started.walking, ...t });
    console.log('  fps walk', theme, '(' + started.walking + ' walking)', 'full', String(full.fps).padStart(6), '|', t.tier, t.post);
  } finally { await page.close(); }
}

const docName = { before: 'before.png', default: 'after-default.png', high: 'after-high.png' }[set];
try {
  if (want('office')) {
    await shoot({ name: 'office light', file: docName, root: DOCS, query: 'theme=light', cam: CAM.office });
    await shoot({ name: 'office dark', file: set + '-office-dark.png', query: 'theme=dark', cam: CAM.office });
  }
  if (want('overview')) {
    await shoot({ name: 'overview light', file: set + '-overview-light.png', query: 'theme=light', cam: null });
    await shoot({ name: 'overview dark', file: set + '-overview-dark.png', query: 'theme=dark', cam: null });
  }
  // the phone layout (390 px wide, a phone's pixel ratio), the Office room in view: readability of the agents, their
  // status lights and desk panels
  if (want('phone')) {
    const phone = { viewport: { width: 390, height: 844 }, dsf: 3, fps: false };
    await shoot({ name: 'phone light', file: set === 'default' ? 'after-phone-390.png' : set + '-phone-390.png', root: set === 'default' ? DOCS : SHOTS, query: 'theme=light', cam: CAM.office, ...phone });
    await shoot({ name: 'phone dark', file: set + '-phone-390-dark.png', query: 'theme=dark', cam: CAM.office, ...phone });
  }
  if (want('walk')) for (const t of ['dark', 'light']) await walkRow(t);
  for (const r of fpsRows) if (r.full.throttled || r.moving.throttled) problems.push('fps ' + r.view + ': throttled after four tries: no reading');
  if (set === 'default') for (const r of fpsRows) if (r.full.fps < 60 || r.moving.fps < 60) problems.push('fps ' + r.view + ': ' + r.moving.fps + ' moving / ' + r.full.fps + ' full < 60 (default-tier budget)');
  const sizes = sizesOf(ASSET_DIR, { compress: false });
  const high = sizes.files.filter((f) => f.file.startsWith('high/')), dflt = sizes.files.filter((f) => !f.file.startsWith('high/'));
  const sum = (a) => a.reduce((s, f) => s + f.bytes, 0);
  const sizeRow = { defaultTier: { bytes: sum(dflt), budgetBytes: BUDGET_BYTES, within: sum(dflt) <= BUDGET_BYTES }, highTierExtra: { bytes: sum(high), files: high }, highTierTotal: sum(dflt) + sum(high) };
  if (set === 'default' && !sizeRow.defaultTier.within) problems.push('default-tier download ' + sizeRow.defaultTier.bytes + ' bytes > ' + BUDGET_BYTES);
  const summary = { at: new Date().toISOString(), set, browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode: 'engine view (mock provider, empty temp data root)', views: fpsRows, sizes: sizeRow, problems };
  fs.writeFileSync(shotJail('fps-' + set + '.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('sizes:', JSON.stringify({ default: sizeRow.defaultTier.bytes, highExtra: sizeRow.highTierExtra.bytes }));
  console.log('problems:', problems.length ? problems : 'none');
} finally { await browser.close(); server.close(); es.closeAll(); engine.close(); console.log('engine data root left in the OS temp folder: ' + tmp); }
