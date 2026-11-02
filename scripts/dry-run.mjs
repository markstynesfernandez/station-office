// dry-run.mjs — the E3 dry run (DECISIONS.md, E3): the engine on the MOCK provider ($0, no keys read), on its own data
// root (office-agents/dry-run/e3/), with the FIXTURE product and config patch from fixtures/engine/. Two jobs:
//   A  a 5-file digital brief through every stage, with one QA-DESIGN rework and the package gate, into the approval queue
//   B  a brief whose design trips the originality gate: it must end blocked or rejected, with the reason
// The office page is open the whole time (live over SSE) and a screenshot is taken at each stage of job A, then of the
// board, the job panel and job B (screenshots/e3/). Re-running starts from an empty dry-run root (the old one is moved
// to dry-run/e3-previous/). Never opens any URL but its own page.
//   npm run dry-run              screenshots on
//   node scripts/dry-run.mjs --no-shots
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJail, APP_ROOT } from '../src/engine/store/jail.mjs';
import { openScriptEngine } from '../src/engine/script-engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { makeLogger } from '../src/server/log.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { createDryRunScript, JOB_A, JOB_B } from '../fixtures/engine/mock-script.mjs';
import { outJail, launch, settle, W, H } from './screenshots.mjs';

const argv = process.argv.slice(2);
const shots = !argv.includes('--no-shots');
const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const DRY = path.join(APP_ROOT, 'dry-run');

export async function dryRun({ shots: takeShots = shots, quiet = false } = {}) {
  if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('the dry run uses the mock provider only');
  // fresh root: the previous dry run is kept once, as dry-run/e3-previous/
  const P = createJail({ dataRoot: DRY, extraRoots: [] });
  if (fs.existsSync(path.join(DRY, 'e3-previous'))) P.remove(path.join(DRY, 'e3-previous'));
  if (fs.existsSync(path.join(DRY, 'e3'))) P.move(path.join(DRY, 'e3'), path.join(DRY, 'e3-previous'));
  const J = createJail({ dataRoot: path.join(DRY, 'e3') });
  const log = makeLogger({ dir: path.join(APP_ROOT, 'logs'), name: 'dry-run', jail: J, quiet });
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const overrides = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };

  // the screenshot browser (its own page only)
  let page = null, browser = null, base = null, shotList = [];
  const outDir = 'e3';
  if (takeShots) fs.mkdirSync(outJail(outDir), { recursive: true });
  async function capture(name, act) {
    if (!page) return;
    const seq = engine.bus.seq;
    await page.evaluate(() => window.__office.reload());
    await page.waitForFunction((s) => { const x = window.__office.snapshot(); return x && x.engine && x.engine.seq >= s; }, seq, { timeout: 15000 });
    if (act) await act(page);
    if (!(await page.evaluate(() => document.querySelector('#board') && !document.querySelector('#board').classList.contains('hidden')))) await settle(page);
    await page.waitForTimeout(250);
    const f = path.join(outDir, name);
    fs.writeFileSync(outJail(f), await page.screenshot({ type: 'png' }));
    shotList.push(f); log.written(outJail(f)); if (!quiet) console.log('  screenshot', f);
  }
  const overview = async (pg) => { await pg.evaluate(() => { window.__office.closeOverlays(); window.__office.closePanel(); window.__office.office.resetView(); }); };
  // the board pauses the office render, so the camera settles first and the board opens after
  const board = async (pg) => { await overview(pg); await settle(pg); await pg.evaluate(() => window.__office.openBoard()); };
  const focus = (dept, zoom = 2.0) => async (pg) => { await overview(pg); await pg.evaluate(([d, z]) => window.__office.focusDept(d, z), [dept, zoom]); };

  // stage hooks: the line waits for each screenshot, so every picture shows the job at that exact stage
  const STAGE_SHOTS = { designer: 'design', 'qa-design': 'qa-design', lister: 'listing', 'qa-listing': 'qa-listing' };
  const hooks = {
    onRunStart: async ({ job, step, pass }) => { if (!job || job.id !== JOB_A || !STAGE_SHOTS[step]) return; const n = { designer: [2, 4], 'qa-design': [3, 5], lister: [6], 'qa-listing': [7] }[step][pass - 1]; await capture(String(n).padStart(2, '0') + '-' + STAGE_SHOTS[step] + '-pass' + pass + '-working.png', focus(step.startsWith('qa-l') || step === 'lister' ? 'office' : 'design', 2.2)); },
    onStep: async ({ job, step, phase }) => { if (job.id === JOB_A && step === 'package-gate' && phase === 'end') await capture('08-package-gate-passed.png', board); }
  };
  // the scripted agents write the listing text from the effective (patched) station config
  const script = createDryRunScript({ cfg: loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts'), overrides }).station });
  const engine = openScriptEngine({ archiveSandbox: true, J, log, script, overrides, hooks, purpose: 'dry-run', startsJobs: true });
  const { server, closeAll } = createEngineServer({ engine, log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  if (takeShots) {
    ({ browser } = await launch({}));
    page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => log.error('page error', { error: e.message }));
    await page.goto(base + '/?anim=0&theme=light', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
  }
  const result = { dataRoot: J.dataRoot, jobs: {} };
  try {
    const brief = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());
    // ---- job A
    const a = engine.orchestrator.createJob({ briefText: brief(JOB_A), by: 'dry run (as the owner\'s Start click)', idempotencyKey: 'dry-run-e3-A' });
    if (!a.ok) throw new Error('job A intake refused: ' + a.reasons.join('; '));
    await capture('01-brief-queued.png', overview);
    await engine.orchestrator.startJob(JOB_A);
    await capture('09-approval-queue.png', board);
    await capture('10-job-panel.png', async (pg) => { await overview(pg); await pg.evaluate((id) => window.__office.showJob(id), JOB_A); await pg.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 }); await pg.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete), null, { timeout: 15000 }); });
    // ---- job B
    const b = engine.orchestrator.createJob({ briefText: brief(JOB_B), by: 'dry run (as the owner\'s Start click)', idempotencyKey: 'dry-run-e3-B' });
    if (!b.ok) throw new Error('job B intake refused: ' + b.reasons.join('; '));
    await engine.orchestrator.startJob(JOB_B);
    await capture('11-originality-trip-blocked.png', board);
    await capture('12-originality-trip-panel.png', async (pg) => { await overview(pg); await pg.evaluate((id) => window.__office.showJob(id), JOB_B); await pg.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 }); });
    await capture('13-overview-after.png', overview);
    for (const id of [JOB_A, JOB_B]) { const j = engine.store.getJob(id); result.jobs[id] = { state: j.state, reason: j.reason, step: j.step, loops: j.loops, hops: j.hops, folder: path.join(J.dataRoot, 'jobs', id), costUsd: engine.ledger.spent.job(id) }; }
    result.ledger = { rows: engine.ledger.totals.rows, usd: engine.ledger.totals.usd, allMock: engine.ledger.rows().every((r) => r.provider === 'mock') };
    result.textCalls = engine.providers.text.calls; result.imageCalls = engine.providers.image.calls;
    result.screenshots = shotList;
    return result;
  } finally {
    if (browser) await browser.close();
    closeAll(); await new Promise((r) => server.close(r)); engine.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dryRun().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => { console.error('dry run failed:', e.stack || e.message); process.exitCode = 1; });
}
