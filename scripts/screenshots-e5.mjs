// screenshots-e5.mjs — the E5 captures (the live office's controls) at 1600x1000, headed Chrome by default.
//   node scripts/screenshots-e5.mjs [--headless] [--out e5]
// Every state shown is a real engine state: the engine runs on the MOCK provider ($0, no keys) on its own fresh data
// root in the OS temp folder (never data/), with the dry-run FIXTURE briefs waiting in research/briefs/. Two set-up jobs
// are started through the server's own write path; everything else is done by clicking the page's controls. Nothing is
// set on the page only. Then the overview's fps (light and dark) is measured on the station's own data root (engine
// mode, as `npm start` runs it) and written to screenshots/<out>/fps-headed.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launch, outJail, settle, makeViewer, W, H } from './screenshots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

async function main() {
  if (process.env.STATION_PROVIDER && process.env.STATION_PROVIDER !== 'mock') throw new Error('E5 captures run on the mock provider only');
  const headed = !process.argv.includes('--headless'), outDir = String(arg('--out', 'e5'));
  fs.mkdirSync(outJail(outDir), { recursive: true });
  const { createJail } = await import('../src/engine/store/jail.mjs');
  const { openScriptEngine } = await import('../src/engine/script-engine.mjs');
  const { createEngineServer } = await import('../src/server/engine-server.mjs');
  const { loadConfig } = await import('../src/engine/config.mjs');
  const { makeLogger } = await import('../src/server/log.mjs');
  const { dublinDay } = await import('../src/engine/time.mjs');
  const { createDryRunScript, JOB_A, JOB_B } = await import('../fixtures/engine/mock-script.mjs');

  // ---- the capture engine: a fresh root under the OS temp folder, the FIXTURE products and briefs, the mock provider
  const base = path.join(os.tmpdir(), 'station-e5-capture');
  const J = createJail({ dataRoot: path.join(base, 'data'), extraRoots: [path.join(ROOT, 'logs')] });
  for (const n of fs.readdirSync(J.dataRoot)) J.remove(path.join(J.dataRoot, n));   // a fresh root each run (through the jail)
  const log = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-e5', jail: J, quiet: true });
  const FIX = path.join(ROOT, 'fixtures', 'engine'), rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const overrides = { productsFile: rj(path.join(FIX, 'products.json')), stationSet: rj(path.join(FIX, 'station-config-patch.json')).set };
  const station = loadConfig({ configDir: path.join(ROOT, 'config'), promptsDir: path.join(ROOT, 'prompts'), overrides }).station;
  const engine = openScriptEngine({ archiveSandbox: true, J, log, script: createDryRunScript({ cfg: station }), overrides, mockDelayMs: 220, purpose: 'screenshots-e5', startsJobs: true });
  if (engine.providers.mode !== 'mock') throw new Error('not on the mock provider');
  for (const id of [JOB_A, JOB_B]) J.put(path.join(J.dataRoot, 'research', 'briefs', id + '.md'), fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay()));
  const es = createEngineServer({ engine, log });
  await new Promise((r) => es.server.listen(0, '127.0.0.1', r));
  const port = es.server.address().port, url = 'http://127.0.0.1:' + port;
  console.log('capture engine:', url, '(data root ' + J.dataRoot + ', mock provider)');
  // set-up writes through the same server path the page uses
  const post = (p, body) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'content-type': 'application/json', origin: url, 'x-station-action': es.token, 'x-idempotency-key': 'setup-' + crypto.randomUUID() } }, (s) => { const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => res({ status: s.statusCode, json: JSON.parse(Buffer.concat(b).toString('utf8') || '{}') })); }); q.on('error', rej); q.end(JSON.stringify(body)); });
  const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };
  const job = (id) => engine.store.getJob(id);

  const { browser, label: browserLabel, gl } = await launch({ headed });
  const problems = [], files = [], fpsRows = [];
  let staleStep = false;   // the stale-tab step expects one 409, which the browser logs as a failed resource
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !(staleStep && /status of 409/.test(m.text()))) problems.push('console.error: ' + m.text()); });
  // leftover notices from an earlier step are closed with their own × button before a shot that is not about them
  const clearToasts = async (p = page) => { for (const b of await p.$$('.toast-x')) await b.click().catch(() => {}); };
  const shot = async (name, p = page, { keepToasts = false } = {}) => { if (!keepToasts) await clearToasts(p); await p.waitForTimeout(350); const f = path.join(outDir, name); fs.writeFileSync(outJail(f), await p.screenshot({ type: 'png' })); files.push(f); console.log('wrote', f); };
  const open = async (p, theme = 'light') => { await p.goto(url + '/?anim=0&theme=' + theme, { waitUntil: 'load', timeout: 60000 }); await p.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 }); await settle(p); };
  const fresh = (p = page) => p.evaluate(() => window.__office.reload());
  try {
    // set-up: job B through the line (the originality gate blocks it) and one enabled research routine
    // L2: a start goes through the spend confirmation (its token) as the page does
    const qb = await post('/api/spend/quote', { action: 'start-line', params: { file: JOB_B + '.md' } });
    let r = await post('/api/tasks/brief', { file: JOB_B + '.md', confirmToken: qb.json.result.token }); if (r.status !== 200) throw new Error('setup B: ' + JSON.stringify(r.json));
    await until(() => job(JOB_B) && job(JOB_B).state === 'blocked');
    r = await post('/api/routines/create', { name: 'Weekday research batch', target: 'line:research', input: 'cosy seasonal sticker niches', schedule: '0 9 * * 1-5' });
    const qr = await post('/api/spend/quote', { action: 'routine-arm', params: { id: r.json.result.id } });   // L2.1: arming is confirmed too
    await post('/api/routines/enable', { id: r.json.result.id, enabled: true, expectedVersion: r.json.result.version, confirmToken: qr.json.result.token });

    await open(page);
    // 01 task box: Research this
    await page.fill('#task-research', 'Woodland and mushroom sticker niches with steady autumn demand; avoid anything that names a brand or a character');
    await shot('01-task-box-research.png');
    // 02 task box: Start line on brief (job A's verified brief), then start it from the page
    await page.click('.tp-tabs [data-tab="brief"]');
    await shot('02-task-box-brief.png');
    await page.click('[data-go="brief"]');
    await until(() => job(JOB_A) && job(JOB_A).state === 'approval', 90000);
    await fresh();
    // 03 task box: Re-run listing (job A's design is QA-approved)
    await page.click('.tp-tabs [data-tab="rerun"]');
    await shot('03-task-box-rerun.png');

    // 04-06 scheduler: create (disabled) and enable
    await page.keyboard.press('c'); await page.waitForSelector('#calendar:not(.hidden) .cal-side');
    await page.click('[data-rt="new"]');
    await page.fill('#dlg-name', 'Morning line: next verified brief');
    await page.selectOption('#dlg-target', 'line:room1-digital');
    await page.fill('#dlg-schedule', '30 8 * * 1-5');
    await page.fill('#dlg-perRunCapUsd', '0.5');
    await shot('04-scheduler-create.png');
    await page.click('.dlg [data-ok]');
    await page.waitForSelector('.routine.paused [data-rt="enable"]');
    await page.waitForTimeout(300);
    await page.click('.routine.paused [data-rt="enable"]');
    await page.waitForSelector('.dlg');
    await shot('05-scheduler-enable.png');
    await clearToasts();
    await page.click('.dlg [data-ok]');
    await page.waitForFunction(() => window.__office.snapshot().routines.filter((x) => x.enabled).length === 2);
    await shot('06-scheduler-enabled.png', page, { keepToasts: true });
    await page.keyboard.press('Escape');

    // 07 approval queue on the board (Approve / Reject on the card; Restart / Archive on the blocked job)
    await page.keyboard.press('b'); await page.waitForSelector('#board:not(.hidden) [data-cardact="approve"]');
    await shot('07-approval-queue-board.png');
    await page.keyboard.press('Escape');
    // 08 the job panel's approval box; 09 the reject-with-reason dialog (cancelled: the job stays in the queue)
    await page.evaluate((id) => window.__office.showJob(id), JOB_A);
    await page.waitForSelector('#sidepanel [data-jobact="approve"]');
    await shot('08-approval-queue-panel.png');
    await page.click('#sidepanel [data-jobact="reject"]');
    await page.fill('#dlg-reason', 'The palette is too close to a well-known toy brand; redraw in muted greens.');
    await shot('09-reject-dialog.png');
    await page.click('.dlg [data-cancel]');
    await page.evaluate(() => window.__office.closePanel());

    // 10 desk panel controls: DESIGNER effort low -> medium, saved (applies at the next run)
    await page.evaluate(() => window.__office.openAgent('designer', 2.4));
    await page.waitForSelector('#sidepanel [data-agent-ctl]');
    await page.selectOption('#sidepanel [data-effort]', 'medium');
    await clearToasts();
    await page.click('#sidepanel [data-save-agent]');
    await page.waitForFunction(() => window.__office.snapshot().agents.find((a) => a.id === 'designer').effort === 'medium');
    await settle(page);
    await shot('10-desk-panel-controls.png', page, { keepToasts: true });
    await page.evaluate(() => window.__office.closePanel());

    // 11-12 job panel: re-run job A's listing from the task box, Stop it while LISTER works, then Restart
    await page.click('.tp-tabs [data-tab="rerun"]');
    await page.click('[data-go="rerun"]'); await page.waitForSelector('.dlg'); await page.click('.dlg [data-ok]');
    await until(() => engine.orchestrator.isActive(JOB_A) && engine.store.runsOf({ jobId: JOB_A }).some((x) => x.status === 'running' && x.agent_key === 'lister'));
    await fresh();
    await page.evaluate((id) => window.__office.showJob(id), JOB_A);
    await page.waitForSelector('#sidepanel [data-jobact="stop"]');
    await shot('11-job-panel-stop.png');
    await page.click('#sidepanel [data-jobact="stop"]'); await page.waitForSelector('.dlg'); await page.click('.dlg [data-ok]');
    await until(() => job(JOB_A).state === 'stopped');
    await fresh();
    await page.waitForSelector('#sidepanel [data-jobact="restart"]');
    await shot('12-job-panel-restart.png');
    await page.click('#sidepanel [data-jobact="restart"]');
    await until(() => ['running', 'queued'].includes(job(JOB_A).state));

    // 13-14 E-STOP on (stops job A again), and the typed resume confirmation
    await until(() => engine.orchestrator.isActive(JOB_A));
    await clearToasts();
    await page.click('#estop'); await page.waitForSelector('.dlg'); await page.click('.dlg [data-ok]');
    await until(() => engine.halt.isHalted() && job(JOB_A).state === 'stopped');
    await fresh(); await settle(page);
    await page.waitForSelector('#sidepanel [data-jobact="restart"]');   // the job panel shows the job the E-STOP stopped
    await shot('13-estop-on.png', page, { keepToasts: true });
    await page.click('#estop'); await page.waitForSelector('.dlg #dlg-typed');
    await page.fill('#dlg-typed', 'RESUME');
    await shot('14-estop-resume-confirm.png');
    await page.click('.dlg [data-ok]');
    await until(() => !engine.halt.isHalted());

    // 15 the stale-tab refusal: tab A opens a routine's editor; tab B (another page) disables that routine; tab A saves
    await fresh(); await page.waitForTimeout(400);
    await page.keyboard.press('c'); await page.waitForSelector('#calendar:not(.hidden) .cal-side');
    const rid = await page.evaluate(() => window.__office.snapshot().routines.find((x) => x.enabled && x.name === 'Weekday research batch').id);
    await page.click('.routine[data-routine="' + rid + '"] [data-rt="edit"]'); await page.waitForSelector('.dlg');
    const pageB = await browser.newPage({ viewport: { width: W, height: H } });
    await open(pageB);
    await pageB.keyboard.press('c'); await pageB.waitForSelector('#calendar:not(.hidden) .cal-side');
    await pageB.click('.routine[data-routine="' + rid + '"] [data-rt="disable"]');
    await until(() => engine.store.getRoutine(rid).enabled === false);
    await pageB.close();
    staleStep = true;
    await page.fill('#dlg-name', 'Weekday research batch (8 a.m.)');
    await clearToasts();
    await page.click('.dlg [data-ok]');
    await page.waitForSelector('.toast-stale');
    await shot('15-stale-tab-refused.png', page, { keepToasts: true });
    if (engine.store.getRoutine(rid).name !== 'Weekday research batch') problems.push('the stale save changed the routine');
    await page.close();

    // fps: the overview on the station's own data root (engine mode, mock provider), light and dark
    const sJ = createJail(), slog = makeLogger({ dir: path.join(ROOT, 'logs'), name: 'screenshots-e5-station', jail: sJ, quiet: true });
    const sEngine = openScriptEngine({ archiveSandbox: true, J: sJ, log: slog, purpose: 'screenshots-e5', startsJobs: true });
    if (sEngine.providers.mode !== 'mock') throw new Error('station engine not on the mock provider');
    const sEs = createEngineServer({ engine: sEngine, log: slog });
    await new Promise((r) => sEs.server.listen(0, '127.0.0.1', r));
    try {
      const view = makeViewer({ browser, base: 'http://127.0.0.1:' + sEs.server.address().port, outDir, log: slog, problems, fpsRows, benchMs: 3000 });
      files.push(await view('16-overview-light.png', 'theme=light', null, 'engine mode, station data root'));
      files.push(await view('17-overview-dark.png', 'theme=dark', null, 'engine mode, station data root'));
    } finally { sEs.closeAll(); sEs.server.close(); sEngine.close(); }
    fs.writeFileSync(outJail(path.join(outDir, headed ? 'fps-headed.json' : 'fps.json')), JSON.stringify({ at: new Date().toISOString(), browser: browserLabel, gl, viewport: W + 'x' + H, benchMs: 3000, views: fpsRows }, null, 2) + '\n');
    console.log('\nfps (overview, engine mode):'); for (const v of fpsRows) console.log('  ' + v.view.padEnd(24) + ' moving ' + v.moving.fps + ' · full quality ' + v.full.fps + ' · avg/p95 ' + v.full.avgFrameMs + '/' + v.full.p95FrameMs + ' ms');
    const rows = engine.ledger.rows();
    console.log('\ncapture engine ledger: ' + rows.length + ' rows, all mock $0: ' + rows.every((x) => x.provider === 'mock' && x.usd === 0));
    console.log('\nScreenshots:\n' + files.join('\n'));
    if (problems.length) { console.error('\nPage problems:\n' + problems.join('\n')); process.exitCode = 1; }
  } catch (e) {
    console.error('E5 capture failed:', e.stack || e.message); if (problems.length) console.error(problems.join('\n')); process.exitCode = 1;
    try { await page.screenshot({ path: outJail(path.join(outDir, '_failed.png')) }); } catch (_) {}
  } finally {
    await browser.close(); es.closeAll(); es.server.close(); engine.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
