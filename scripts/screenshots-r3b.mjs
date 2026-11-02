// screenshots-r3b.mjs — R3b captures: every area baked (Research, Design and Office rooms, the lounge, the atrium). The
// overview, Research, lounge and atrium in light and dark, the Design room in light mode after its brightening; each
// area's brightness against its procedural version (?scene=procedural) and the light-mode Design room against the
// other rooms; fps rows (each view moving and at full quality, and the overview with all 8 agents walking); the asset
// sizes and the build times. Legacy fixtures view (mock data), as R2, R3 and R3a.
//   node scripts/screenshots-r3b.mjs                                              -> headless (a quick look)
//   node scripts/screenshots-r3b.mjs --headed --channel chromium --expect-gpu intel -> the budget run: Playwright's
//        Chromium, headed, checked to be on the Intel iGPU (Windows sends chrome.exe to the RTX; see DECISIONS)
//   --only 01,05  -> just those views (file name prefixes; 'fps' for the walking rows)
//   --engine      -> the engine view (mock provider, a throwaway data root in the temp folder) instead of the legacy
//                    fixtures view: since TREND-SCOUT's desk (17/10/2026) only the engine layout matches every baked area
// Starts its own Station server on a random port (fixtures, mock data) and opens only that page. Playwright launches the
// browser with a fresh temporary profile (no persistent context). Every file goes through outJail() (screenshots/
// only): screenshots/r3b/ (procedural reference captures for the brightness check in screenshots/r3b/ref/).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createOfficeServer, ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { launch, outJail, settle, W, H } from './screenshots.mjs';
import { computeLayout, FLOOR, WALL_H } from '../src/web/scene/layout.js';
import { BAKED_ROOMS } from '../src/web/scene/bakedlook.js';
import { sizesOf, BUDGET_BYTES } from './build-office.mjs';

const argv = process.argv.slice(2), headed = argv.includes('--headed');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const outDir = arg('--out', 'r3b'), benchMs = Number(arg('--bench-ms', 3000)), only = arg('--only', null);
const want = (name) => !only || only.split(',').some((p) => name.startsWith(p));
fs.mkdirSync(outJail(path.join(outDir, 'ref')), { recursive: true });
const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r3b' });
const engineView = argv.includes('--engine'), modeLabel = engineView ? 'engine view (mock provider, empty temp data root)' : 'legacy fixtures view (mock data)';
let server, closeEngine = () => {};
if (engineView) {
  if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('R3b captures run on the mock provider only');
  const os = await import('node:os');
  const { createJail } = await import('../src/engine/store/jail.mjs');
  const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
  const { createEngineServer } = await import('../src/server/engine-server.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'station-r3b-engine-'));
  const J = createJail({ dataRoot: path.join(tmp, 'data'), extraRoots: [path.join(ROOT, 'logs')] });
  const engine = openScriptEngine({ archiveSandbox: true, J, log: makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r3b-engine', jail: J }), purpose: 'screenshots-r3b', startsJobs: true });
  if (engine.providers.mode !== 'mock') { engine.close(); throw new Error('the engine did not start on the mock provider'); }
  const es = createEngineServer({ engine, log });
  server = es.server;
  closeEngine = () => { es.closeAll(); engine.close(); console.log('engine data root left in the OS temp folder: ' + tmp); };   // nothing is deleted outside a jail (write-guard)
} else ({ server } = createOfficeServer({ fixtures: true, log }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
console.log('station server for R3b captures:', base, '(' + modeLabel + ')');
const channel = arg('--channel', null), expectGpu = arg('--expect-gpu', null);
const { browser, label: browserLabel, gl } = await launch({ headed, channel });
const problems = [], fpsRows = [], brightness = [], designCheck = [];
if (expectGpu && !String(gl).toLowerCase().includes(expectGpu.toLowerCase())) problems.push('GL renderer is ' + gl + ', expected ' + expectGpu + ': fps rows are not the budget figure');

// cameras: R2's room captures (focus the room, aimed a little behind its centre); the lounge and the atrium likewise
const room = (key, zoom) => async (page) => { await page.evaluate(([k, z]) => { const o = window.__office.office, a = o.anchors.depts[k]; window.__office.focusDept(k, z); o.focus({ x: a.x - 0.9, z: a.z - 0.9 }, z); }, [key, zoom]); };
const at = (zoom, pick) => async (page) => { await page.evaluate(([z, p]) => { const o = window.__office.office, a = p === 'lounge' ? o.anchors.lounge : { x: 0, z: 0 }; o.focus({ x: a.x - 0.6, z: a.z - 0.6 }, z); }, [zoom, pick]); };
const CAM = { overview: null, research: room('research', 1.9), design: room('design', 2.3), lounge: at(1.9, 'lounge'), atrium: at(1.55, 'atrium') };

// the areas' outlines on screen: the convex hull of each area's box projected by the page camera (rooms: floor to wall
// top; the lounge: floor to 1.4 up; the atrium: its central square round the core, floor to 1 up)
function hull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const inPoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
async function areaPolys(page) {
  const snap = await page.evaluate(() => window.__office.snapshot());
  const L = computeLayout(snap.departments.map((d) => ({ key: d.key, agents: d.agents.slice() })), snap.services);
  const boxOf = (k) => (k === 'lounge' ? [L.lounge, 1.4] : k === 'atrium' ? [L.atrium, 1.0] : [L.rooms.find((x) => x.key === k), WALL_H]);
  const boxes = Object.fromEntries(BAKED_ROOMS.map((k) => { const [r, h] = boxOf(k), c = []; for (const x of [r.x0, r.x1]) for (const y of [FLOOR, FLOOR + h]) for (const z of [r.z0, r.z1]) c.push({ x, y, z }); return [k, c]; }));
  const proj = await page.evaluate((bx) => { const o = window.__office.office, rc = document.querySelector('#scene').getBoundingClientRect(); return Object.fromEntries(Object.entries(bx).map(([k, c]) => [k, c.map((v) => { const p = o.project(v); return { x: p.x + rc.left, y: p.y + rc.top }; })])); }, boxes);
  return Object.fromEntries(Object.entries(proj).map(([k, pts]) => [k, hull(pts)]));
}
// mean brightness (Rec. 709 luma of the sRGB pixels, 0-255) inside each area's outline, clipped to the canvas
async function meanLuma(png, polys) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = {};
  for (const [k, poly] of Object.entries(polys)) {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(info.width - 1, Math.ceil(Math.max(...xs))), y0 = Math.max(46, Math.floor(Math.min(...ys))), y1 = Math.min(info.height - 30, Math.ceil(Math.max(...ys)));
    let s = 0, n = 0;
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) if (inPoly(x, y, poly)) { const i = (y * info.width + x) * 3; s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; n++; }
    out[k] = n > 200 ? +(s / n).toFixed(1) : null;
  }
  return out;
}
// a bench while the headed window was covered is throttled to about one frame a second (p95 ~1000 ms): not a reading.
// Such a run is repeated (up to four tries) and the retries are recorded with the row.
async function bench(page, move) {
  for (let tries = 1; ; tries++) {
    const r = await page.evaluate(([ms, mv]) => window.__office.bench(ms, { move: mv }), [benchMs, move]);
    if (r.p95FrameMs < 500 || tries >= 4) { if (tries > 1) r.retries = tries - 1; if (r.p95FrameMs >= 500) r.throttled = true; return r; }
    console.log('  (throttled: the window was covered; trying again)'); await page.waitForTimeout(1500);
  }
}
const openPage = async (url, tag) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push(tag + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(tag + ' console.error: ' + m.text()); if (m.type() === 'warning' && /baked/.test(m.text())) problems.push(tag + ' console.warn: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
  await page.waitForFunction(() => { const b = window.__office.baked(); return !b.want || b.loaded || b.failed; }, null, { timeout: 30000 });
  return page;
};

// one view: fresh page load (animation off), the camera, a screenshot (saved unless file is null), brightness, fps
async function shoot({ file, query, cam, fps = true, note = '' }) {
  const page = await openPage(base + '/?anim=0&' + query, file || query);
  try {
    await settle(page);
    if (cam) await cam(page);
    await settle(page); await page.waitForTimeout(250);
    const b = await page.evaluate(() => window.__office.baked());
    const procedural = query.includes('scene=procedural');
    if (!procedural && JSON.stringify([...b.rooms].sort()) !== JSON.stringify([...BAKED_ROOMS].sort())) problems.push((file || query) + ': baked areas ' + JSON.stringify(b));
    if (procedural && b.want) problems.push(query + ': ?scene=procedural still wants the bake');
    const png = await page.screenshot({ type: 'png' });
    if (file) { fs.writeFileSync(outJail(path.join(outDir, file)), png); console.log('wrote', path.join(outDir, file)); log.written(path.join(outDir, file)); }
    const luma = await meanLuma(png, await areaPolys(page));
    if (fps) {
      const moving = await bench(page, true);
      const full = await bench(page, false);
      const post = await page.evaluate(() => window.__office.stats().post);
      if (post !== 'fused' && !/procedural/.test(query)) problems.push(file + ': post-processing ' + post + ' (the OfficeOutputPass fallback path)');
      fpsRows.push({ view: file || query, query, moving, full, glow: b.glow, post, note });
      console.log('  fps', String(file || query).padEnd(30), 'moving', String(moving.fps).padStart(6), '| full quality', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms |', full.calls + ' calls,', full.tris + ' tris');
    }
    return { png, luma };
  } finally { await page.close(); }
}

// every agent walking (animation on): all 8 snapped to their desks, then all set idle on the page, so all 8 walk to the
// lounge at once (display only; nothing is written). The bench runs while they walk.
async function walkRow(theme, scene) {
  const page = await openPage(base + '/?theme=' + theme + (scene ? '&scene=' + scene : ''), 'walk ' + theme);
  try {
    await settle(page); await page.waitForTimeout(500);
    const started = await page.evaluate(() => {
      const o = window.__office.office, s0 = structuredClone(window.__office.snapshot());
      o.setAnimate(false); for (const a of s0.agents) a.status = 'working'; o.setData(s0);
      o.setAnimate(true); const s1 = structuredClone(s0); for (const a of s1.agents) a.status = 'idle'; o.setData(s1);
      const ppl = o.people();
      return { agents: s1.agents.length, walking: ppl.filter((p) => p.place === 'walking').length, seatless: ppl.filter((p) => p.seat == null).map((p) => p.agentId) };
    });
    const full = await bench(page, false);
    const walkingAtEnd = await page.evaluate(() => window.__office.stats().walking);
    // the lounge has 8 seats; an idle agent without a seat stays at its desk (layout.js), so 9 agents walk 8 (genre scout, 17/10/2026)
    if (started.walking !== started.agents - started.seatless.length) problems.push('walk ' + theme + ': only ' + started.walking + ' of ' + (started.agents - started.seatless.length) + ' seated agents walking at the start');
    fpsRows.push({ view: 'walk (overview, ' + theme + ', ' + (scene || 'baked') + ', all ' + started.agents + ' agents desk to lounge)', moving: full, full, walkingAtStart: started.walking, walkingAtEnd, stayAtDesk: started.seatless, note: 'animation on' + (started.seatless.length ? '; no lounge seat (stays at the desk): ' + started.seatless.join(', ') : '') });
    console.log('  fps walk', theme, scene || 'baked', '(' + started.walking + ' walking at the start, ' + walkingAtEnd + ' at the end)', 'full quality', String(full.fps).padStart(6));
  } finally { await page.close(); }
}

const VIEWS = [
  ['01-overview-light.png', 'theme=light', 'overview'], ['02-overview-dark.png', 'theme=dark', 'overview'],
  ['03-research-light.png', 'theme=light', 'research'], ['04-research-dark.png', 'theme=dark', 'research'],
  ['05-lounge-light.png', 'theme=light', 'lounge'], ['06-lounge-dark.png', 'theme=dark', 'lounge'],
  ['07-atrium-light.png', 'theme=light', 'atrium'], ['08-atrium-dark.png', 'theme=dark', 'atrium'],
  ['09-design-light.png', 'theme=light', 'design']
];

try {
  for (const [file, query, cam] of VIEWS) {
    if (!want(file)) continue;
    const baked = await shoot({ file, query, cam: CAM[cam], note: 'baked (default)' });
    const proc = await shoot({ file: 'ref/' + file.replace('.png', '-procedural.png'), query: query + '&scene=procedural', cam: CAM[cam], fps: cam === 'overview', note: 'procedural (?scene=procedural), for comparison' });
    const theme = query.includes('dark') ? 'dark' : 'light';
    for (const k of cam === 'overview' ? BAKED_ROOMS : [cam]) if (baked.luma[k] != null && proc.luma[k] != null) brightness.push({ view: file, area: k, theme, baked: baked.luma[k], procedural: proc.luma[k], ratio: +(baked.luma[k] / proc.luma[k]).toFixed(3) });
    // the owner's light-mode Design check (R3b): its brightness against the other rooms', same camera (the overview)
    if (cam === 'overview') {
      const others = ['research', 'office'].map((k) => baked.luma[k]), mean = others.reduce((s, x) => s + x, 0) / others.length;
      designCheck.push({ view: file, theme, design: baked.luma.design, research: baked.luma.research, office: baked.luma.office, designVsOthers: +(baked.luma.design / mean).toFixed(3), designVsResearch: +(baked.luma.design / baked.luma.research).toFixed(3), designVsOffice: +(baked.luma.design / baked.luma.office).toFixed(3) });
    }
  }
  if (want('fps')) for (const [t, s] of [['dark', null], ['light', null], ['dark', 'procedural']]) await walkRow(t, s);
  for (const b of brightness) if (b.theme === 'dark' && b.ratio < 1) problems.push('dark ' + b.view + ' ' + b.area + ': the baked area is darker than the procedural one (' + b.baked + ' < ' + b.procedural + ')');
  // owner, 17/10/2026: in light mode every baked area stays within 10% of its procedural version's brightness
  for (const b of brightness) if (b.theme === 'light' && Math.abs(1 - b.ratio) > 0.1) problems.push('light ' + b.view + ' ' + b.area + ': baked ' + b.baked + ' vs procedural ' + b.procedural + ' (x' + b.ratio + '), outside the 10% target');
  for (const d of designCheck) if (d.theme === 'light' && Math.abs(1 - d.designVsOthers) > 0.1) problems.push('light-mode Design room ' + d.designVsOthers + ' x the other rooms (target within about 10%)');
  for (const r of fpsRows) if (r.full.throttled || r.moving.throttled) problems.push('fps ' + r.view + ': throttled (window covered) after four tries: no reading');
  for (const r of fpsRows) if (!/procedural/.test(r.query || r.view) && r.full.fps < 60) problems.push('fps ' + r.view + ': full quality ' + r.full.fps + ' < 60');
  const sizes = sizesOf();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'web', 'assets', 'office', 'manifest.json'), 'utf8'));
  const perUnit = Object.fromEntries(Object.entries(manifest.units).map(([u, x]) => [u, { rooms: x.rooms, atlas: x.atlas, bytes: sizes.files.filter((f) => f.file.startsWith(u + '.') || f.file.startsWith('lightmap-' + u + '-')).reduce((s, f) => s + f.bytes, 0) }]));
  fs.writeFileSync(outJail(path.join(outDir, 'asset-sizes.json')), JSON.stringify({ ...sizes, units: perUnit, textures: sizes.files.filter((f) => f.file.startsWith('textures/')).reduce((s, f) => s + f.bytes, 0), areas: Object.keys(manifest.rooms), budgetUsed: +(sizes.total.bytes / BUDGET_BYTES).toFixed(3) }, null, 2) + '\n');
  fs.writeFileSync(outJail(path.join(outDir, 'build.json')), JSON.stringify({ build: manifest.build, units: Object.fromEntries(Object.entries(manifest.units).map(([u, x]) => [u, x.build])) }, null, 2) + '\n');
  fs.writeFileSync(outJail(path.join(outDir, 'brightness.json')), JSON.stringify({ at: new Date().toISOString(), method: 'mean Rec. 709 luma (0-255) of the screenshot pixels inside each area\'s projected outline (rooms: floor to wall top; lounge: floor to 1.4 up; atrium: the central square round the core, floor to 1 up), baked vs ?scene=procedural, same camera', lightTarget: 'every baked area within 10% of its procedural version in light mode (owner, 17/10/2026)', designLightCheck: { target: 'the light-mode Design room within about 10% of the other rooms (owner, R3b); overview camera, baked', rows: designCheck }, rows: brightness }, null, 2) + '\n');
  const summary = { at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode: modeLabel, views: fpsRows, problems };
  fs.writeFileSync(outJail(path.join(outDir, headed ? 'fps-headed.json' : 'fps.json')), JSON.stringify(summary, null, 2) + '\n');
  console.table(brightness); console.table(designCheck);
  console.log('problems:', problems.length ? problems : 'none');
} finally { await browser.close(); server.close(); closeEngine(); }
