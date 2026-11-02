// screenshots-r3a.mjs — R3a captures: the baked Design and Office rooms (now the default scene) in light and dark, the
// overview in both themes, side-by-sides against Redesign R2's room captures, the rooms' brightness against the
// procedural rooms (?scene=procedural), fps rows and the asset sizes. Legacy fixtures view (mock data), as R2 and R3.
//   node scripts/screenshots-r3a.mjs                                              -> headless (a quick look)
//   node scripts/screenshots-r3a.mjs --headed --channel chromium --expect-gpu intel -> the budget run: Playwright's
//        Chromium, headed, checked to be on the Intel iGPU (Windows sends chrome.exe to the RTX; see DECISIONS)
// Starts its own Station server on a random port (fixtures, mock data) and opens only that page. Playwright launches the
// browser with a fresh temporary profile (no persistent context). Every file goes through outJail() (screenshots/
// only): screenshots/r3a/ (procedural reference captures for the brightness check in screenshots/r3a/ref/).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createOfficeServer, ROOT } from '../src/server/index.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { launch, outJail, settle, W, H } from './screenshots.mjs';
import { computeLayout, FLOOR, WALL_H } from '../src/web/scene/layout.js';
const BAKED_ROOMS = ['design', 'office'];   // R3a's two rooms (since R3b every area is baked: scripts/screenshots-r3b.mjs)
import { sizesOf, BUDGET_BYTES } from './build-office.mjs';

const argv = process.argv.slice(2), headed = argv.includes('--headed');
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const outDir = 'r3a', benchMs = Number(arg('--bench-ms', 3000)), only = arg('--only', null);
const want = (name) => !only || only.split(',').some((p) => name.startsWith(p));
fs.mkdirSync(outJail(path.join(outDir, 'ref')), { recursive: true });
const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-r3a' });
const { server } = createOfficeServer({ fixtures: true, log });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
console.log('station server for R3a captures:', base, '(legacy fixtures view)');
const channel = arg('--channel', null), expectGpu = arg('--expect-gpu', null);
const { browser, label: browserLabel, gl } = await launch({ headed, channel });
const problems = [], fpsRows = [], brightness = [];
if (expectGpu && !String(gl).toLowerCase().includes(expectGpu.toLowerCase())) problems.push('GL renderer is ' + gl + ', expected ' + expectGpu + ': fps rows are not the budget figure');

// cameras: R2's room captures (scripts/screenshots.mjs --set r2: focus the room, aimed a little behind its centre)
const room = (key, zoom) => async (page) => { await page.evaluate(([k, z]) => { const o = window.__office.office, a = o.anchors.depts[k]; window.__office.focusDept(k, z); o.focus({ x: a.x - 0.9, z: a.z - 0.9 }, z); }, [key, zoom]); };
const CAM = { overview: null, design: room('design', 2.3), office: room('office', 1.8) };

// the rooms' outlines on screen: the convex hull of each room's box (floor to wall top) projected by the page camera
function hull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const inPoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
async function roomPolys(page) {
  const snap = await page.evaluate(() => window.__office.snapshot());
  const L = computeLayout(snap.departments.map((d) => ({ key: d.key, agents: d.agents.slice() })), snap.services);
  const boxes = Object.fromEntries(BAKED_ROOMS.map((k) => { const r = L.rooms.find((x) => x.key === k); const c = []; for (const x of [r.x0, r.x1]) for (const y of [FLOOR, FLOOR + WALL_H]) for (const z of [r.z0, r.z1]) c.push({ x, y, z }); return [k, c]; }));
  const proj = await page.evaluate((bx) => { const o = window.__office.office, rc = document.querySelector('#scene').getBoundingClientRect(); return Object.fromEntries(Object.entries(bx).map(([k, c]) => [k, c.map((v) => { const p = o.project(v); return { x: p.x + rc.left, y: p.y + rc.top }; })])); }, boxes);
  return Object.fromEntries(Object.entries(proj).map(([k, pts]) => [k, hull(pts)]));
}
// mean brightness (Rec. 709 luma of the sRGB pixels, 0-255) inside each room's outline, clipped to the canvas
async function meanLuma(png, polys) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = {};
  for (const [k, poly] of Object.entries(polys)) {
    const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(info.width - 1, Math.ceil(Math.max(...xs))), y0 = Math.max(46, Math.floor(Math.min(...ys))), y1 = Math.min(info.height - 30, Math.ceil(Math.max(...ys)));
    let s = 0, n = 0;
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) if (inPoly(x, y, poly)) { const i = (y * info.width + x) * 3; s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; n++; }
    out[k] = n ? +(s / n).toFixed(1) : null;
  }
  return out;
}

// one view: fresh page load (animation off), the camera, a screenshot (saved unless file is null), room brightness, fps
async function shoot({ file, query, cam, fps = true, note = '' }) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push((file || query) + ' pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push((file || query) + ' console.error: ' + m.text()); });
  try {
    await page.goto(base + '/?anim=0&' + query, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
    await page.waitForFunction(() => { const b = window.__office.baked(); return !b.want || b.loaded || b.failed; }, null, { timeout: 30000 });
    await settle(page);
    if (cam) await cam(page);
    await settle(page); await page.waitForTimeout(250);
    const b = await page.evaluate(() => window.__office.baked());
    const procedural = query.includes('scene=procedural');
    if (!procedural && !BAKED_ROOMS.every((k) => b.rooms.includes(k))) problems.push((file || query) + ': baked rooms ' + JSON.stringify(b));
    if (procedural && b.want) problems.push(query + ': ?scene=procedural still wants the bake');
    const png = await page.screenshot({ type: 'png' });
    if (file) { fs.writeFileSync(outJail(path.join(outDir, file)), png); console.log('wrote', path.join(outDir, file)); log.written(path.join(outDir, file)); }
    const luma = await meanLuma(png, await roomPolys(page));
    let row = null;
    if (fps) {
      const moving = await page.evaluate((ms) => window.__office.bench(ms, { move: true }), benchMs);
      const full = await page.evaluate((ms) => window.__office.bench(ms, { move: false }), benchMs);
      row = { view: file || query, query, moving, full, glow: b.glow, note };
      fpsRows.push(row);
      console.log('  fps', String(file || query).padEnd(30), 'moving', String(moving.fps).padStart(6), '| full quality', String(full.fps).padStart(6), '| avg', full.avgFrameMs + ' ms p95', full.p95FrameMs + ' ms |', full.calls + ' calls');
    }
    return { png, luma, row };
  } finally { await page.close(); }
}

// people walking (animation on): every idle agent set to working on the page (display only; nothing is written)
async function walkRow(theme, scene) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.goto(base + '/?theme=' + theme + (scene ? '&scene=' + scene : ''), { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
    await page.waitForFunction(() => { const b = window.__office.baked(); return !b.want || b.loaded || b.failed; }, null, { timeout: 30000 });
    await settle(page); await page.waitForTimeout(500);
    const n = await page.evaluate(() => { const s = structuredClone(window.__office.snapshot()); let k = 0; for (const a of s.agents) if (a.status === 'idle') { a.status = 'working'; k++; } window.__office.office.setData(s); return k; });
    const full = await page.evaluate((ms) => window.__office.bench(ms, { move: false }), benchMs);
    const walking = await page.evaluate(() => window.__office.stats().walking);
    fpsRows.push({ view: 'walk (overview, ' + theme + ', ' + (scene || 'baked') + ', ' + n + ' agents sent lounge to desk)', moving: full, full, walkingAtEnd: walking, note: 'animation on' });
    console.log('  fps walk', theme, scene || 'baked', '(' + n + ' sent, ' + walking + ' still walking at the end)'.padEnd(10), 'full quality', String(full.fps).padStart(6));
  } finally { await page.close(); }
}

const VIEWS = [
  ['01-overview-light.png', 'theme=light', 'overview'], ['02-overview-dark.png', 'theme=dark', 'overview'],
  ['03-design-light.png', 'theme=light', 'design'], ['04-design-dark.png', 'theme=dark', 'design'],
  ['05-office-light.png', 'theme=light', 'office'], ['06-office-dark.png', 'theme=dark', 'office']
];
const label = (t, w) => Buffer.from('<svg width="' + w + '" height="34"><rect width="100%" height="100%" fill="rgba(0,0,0,0.55)"/><text x="12" y="23" font-size="18" font-family="Segoe UI, Arial" fill="#fff">' + t + '</text></svg>');
async function sideBySide(out, a, la, b, lb) {
  const half = async (f) => sharp(f).resize(W / 2, H / 2).png().toBuffer();
  await sharp({ create: { width: W, height: H / 2, channels: 3, background: '#000' } }).composite([{ input: await half(a), left: 0, top: 0 }, { input: await half(b), left: W / 2, top: 0 }, { input: label(la, W / 2), left: 0, top: 0 }, { input: label(lb, W / 2), left: W / 2, top: 0 }]).png().toFile(outJail(path.join(outDir, out)));
  console.log('wrote', path.join(outDir, out));
}

try {
  for (const [file, query, cam] of VIEWS) {
    if (!want(file)) continue;
    const baked = await shoot({ file, query, cam: CAM[cam], note: 'baked (default)' });
    // the same view drawn procedurally (?scene=procedural): the brightness reference, and the light-mode side-by-sides
    const refFile = 'ref/' + file.replace('.png', '-procedural.png');
    const proc = await shoot({ file: refFile, query: query + '&scene=procedural', cam: CAM[cam], fps: cam === 'overview', note: 'procedural (?scene=procedural), for comparison' });
    const rooms = cam === 'overview' ? BAKED_ROOMS : [cam];
    for (const k of rooms) brightness.push({ view: file, room: k, theme: query.includes('dark') ? 'dark' : 'light', baked: baked.luma[k], procedural: proc.luma[k], ratio: +(baked.luma[k] / proc.luma[k]).toFixed(3) });
  }
  // side by side against Redesign R2 (its room captures were dark mode, legacy fixtures view, the same cameras)
  const r2 = (f) => path.join(ROOT, 'screenshots', 'redesign-r2', f), mine = (f) => outJail(path.join(outDir, f));
  for (const [out, r2f, f, k] of [['side-by-side-design-r2.png', '04-design-room.png', '04-design-dark.png', 'Design'], ['side-by-side-office-r2.png', '05-office-room.png', '06-office-dark.png', 'Office']]) {
    if (!fs.existsSync(r2(r2f))) { problems.push('no R2 capture ' + r2f + ' for the side-by-side'); continue; }
    if (fs.existsSync(mine(f))) await sideBySide(out, r2(r2f), 'Redesign R2 (procedural) · ' + k + ' · dark', mine(f), 'R3a (baked) · ' + k + ' · dark');
  }
  // light mode: R2 has no light room capture, so the procedural room as it is today (?scene=procedural)
  for (const [out, f, k] of [['side-by-side-design-light.png', '03-design-light.png', 'Design'], ['side-by-side-office-light.png', '05-office-light.png', 'Office']]) {
    const ref = mine('ref/' + f.replace('.png', '-procedural.png'));
    if (fs.existsSync(ref) && fs.existsSync(mine(f))) await sideBySide(out, ref, 'procedural (?scene=procedural) · ' + k + ' · light', mine(f), 'R3a (baked) · ' + k + ' · light');
  }
  if (want('fps')) for (const [t, s] of [['dark', null], ['light', null], ['dark', 'procedural']]) await walkRow(t, s);
  for (const b of brightness) if (b.theme === 'dark' && b.ratio < 1) problems.push('dark ' + b.view + ' ' + b.room + ': the baked room is darker than the procedural one (' + b.baked + ' < ' + b.procedural + ')');
  for (const r of fpsRows) if (!/procedural/.test(r.query || r.view) && r.full.fps < 60) problems.push('fps ' + r.view + ': full quality ' + r.full.fps + ' < 60');
  const sizes = sizesOf();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'web', 'assets', 'office', 'manifest.json'), 'utf8'));
  fs.writeFileSync(outJail(path.join(outDir, 'asset-sizes.json')), JSON.stringify({ ...sizes, rooms: Object.keys(manifest.rooms), budgetUsed: +(sizes.total.bytes / BUDGET_BYTES).toFixed(3), note2: 'phase 1 of 2: Design and Office baked; Research, lounge and atrium still to come in phase 2 under the same 10 MB total' }, null, 2) + '\n');
  fs.writeFileSync(outJail(path.join(outDir, 'build.json')), JSON.stringify(manifest.build, null, 2) + '\n');
  fs.writeFileSync(outJail(path.join(outDir, 'brightness.json')), JSON.stringify({ at: new Date().toISOString(), method: 'mean Rec. 709 luma (0-255) of the screenshot pixels inside each room\'s projected outline (floor to wall top), baked vs ?scene=procedural, same camera', rows: brightness }, null, 2) + '\n');
  const summary = { at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs, mode: 'legacy fixtures view (mock data)', views: fpsRows, problems };
  fs.writeFileSync(outJail(path.join(outDir, headed ? 'fps-headed.json' : 'fps.json')), JSON.stringify(summary, null, 2) + '\n');
  console.table(brightness);
  console.log('problems:', problems.length ? problems : 'none');
} finally { await browser.close(); server.close(); }
