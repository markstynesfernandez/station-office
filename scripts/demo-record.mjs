// demo-record.mjs — npm run demo:record: runs the demo once (scripts/demo.mjs: mock provider, $0, no keys, data-demo/)
// in headed Google Chrome at 1600x1000 and records it with Playwright's own video capture to
// screenshots/demo/station-demo.webm, plus four stills in screenshots/demo/: the overview mid-run, a desk close-up, the
// board at the end and the approval queue. The recorded page is the presenter view (camera tour, captions, money
// hidden); the stills come from a second, unrecorded page with the camera tour off. Opens no URL but the demo's own.
// Every file it writes goes through outJail() (office-agents/screenshots/ only).
//   npm run demo:record                     1x, headed Chrome
//   node scripts/demo-record.mjs --speed 4  quicker take (same day, 4x)
//   node scripts/demo-record.mjs --headless headless Chromium (no window)
// MP4: made only with a pinned, licence-checked converter. The one candidate is the ffmpeg build Playwright pins
// (playwright-core/browsers.json, LGPL-2.1); it is probed for an MP4 muxer and H.264 or MPEG-4 encoder. A converter
// found on PATH is never used: it is neither pinned nor licence-checked in this project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startDemo, assertDemoEnv } from './demo.mjs';
import { outJail, launch, settle, W, H } from './screenshots.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const speed = Number(arg('--speed', '1'));
const headed = !argv.includes('--headless');
const OUT = 'demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[demo:record]', ...a);

// the ffmpeg build Playwright pins, if it is installed (never one from PATH)
function pinnedFfmpeg() {
  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve('playwright-core/package.json'));
  const pw = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const rev = (JSON.parse(fs.readFileSync(path.join(pkgDir, 'browsers.json'), 'utf8')).browsers.find((b) => b.name === 'ffmpeg') || {}).revision;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright'));
  const exe = path.join(base, 'ffmpeg-' + rev, process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux');
  if (!rev || !fs.existsSync(exe)) return { exe: null, why: 'Playwright\'s pinned ffmpeg (build ' + rev + ') is not installed' };
  const lic = fs.readdirSync(path.dirname(exe)).find((f) => /^COPYING/i.test(f)) || null;
  const run = (args) => spawnSync(exe, ['-hide_banner', ...args], { encoding: 'utf8', timeout: 15000 }).stdout || '';
  const muxMp4 = /^\s*E\s+mp4\b/m.test(run(['-muxers'])), enc = run(['-encoders']), h264 = /\b(libx264|libopenh264|h264_mf|mpeg4)\b/.test(enc);
  return { exe, rev, playwright: pw.version, licence: lic, canMp4: muxMp4 && h264, encoders: (enc.match(/^\s*V\S*\s+(\S+)/gm) || []).map((l) => l.trim().split(/\s+/)[1]), muxMp4 };
}

// the webm's duration, read by the same pinned ffmpeg (it prints "Duration: hh:mm:ss.cc" for the input)
function durationOf(exe, file) {
  if (!exe) return null;
  const r = spawnSync(exe, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 30000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec((r.stderr || '') + (r.stdout || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

async function main() {
  assertDemoEnv(process.env);
  fs.mkdirSync(outJail(OUT), { recursive: true });
  const tmpVideo = path.join(OUT, '.video-tmp');
  fs.rmSync(outJail(tmpVideo), { recursive: true, force: true });
  const demo = await startDemo({ port: 0, startWhen: 'page' });
  const problems = [], stills = [];
  let browser = null;
  try {
    // headed: the installed Google Chrome; --headless: Chromium (screenshots.mjs picks and reports the GL renderer)
    ({ browser } = headed ? await launch({ headed: true }) : await launch({}));
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: outJail(tmpVideo), size: { width: W, height: H } } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
    const t0 = Date.now();
    await page.goto(demo.url + '/?theme=light', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
    if (speed !== 1) demo.control({ action: 'speed', speed });
    log('recording', demo.url, 'at', speed + 'x', headed ? '(headed)' : '(headless)');

    // stills: a second page (not recorded), presenter view with the camera tour off, so each still shows the view asked for
    async function still(name, act) {
      const c = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      try {
        const p = await c.newPage();
        p.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message));
        await p.goto(demo.url + '/?theme=light&tour=0', { waitUntil: 'load', timeout: 60000 });
        await p.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
        await settle(p); await act(p);
        if (!(await p.evaluate(() => !document.querySelector('#board').classList.contains('hidden')))) await settle(p);
        await p.waitForTimeout(400);
        const f = path.join(OUT, name);
        fs.writeFileSync(outJail(f), await p.screenshot({ type: 'png' }));
        stills.push('screenshots/' + f.replace(/\\/g, '/')); log('still', f);
      } finally { await c.close(); }
    }
    const engineNow = () => demo.current() && demo.current().engine;
    const working = () => { const e = engineNow(); return e ? e.store.runsOf({ limit: 50 }).filter((r) => r.status === 'running') : []; };
    async function until(fn, label, ms = 600000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting for ' + label); await sleep(150); } }

    // 1) overview mid-run: job B in DESIGN and the research batch in RESEARCH at the same time
    await until(() => { const w = working(); return w.some((r) => r.agent_key === 'designer') && w.some((r) => ['demand-researcher', 'evidence-checker'].includes(r.agent_key)); }, 'design and research working together');
    await sleep(1200 / speed);
    await still('01-overview-mid-run.png', async (p) => { await p.evaluate(() => { window.__office.closeOverlays(); window.__office.office.resetView(); }); });
    // 2) desk close-up: DESIGNER drawing job A's set (monitor text readable)
    const jobA = () => demo.current().jobA;
    await until(() => working().some((r) => r.agent_key === 'designer' && r.job_id === jobA()) && fs.existsSync(path.join(demo.dataRoot, 'jobs', jobA(), 'set-v1', 'files')) && fs.readdirSync(path.join(demo.dataRoot, 'jobs', jobA(), 'set-v1', 'files')).length >= 3, 'DESIGNER on job A');
    await still('02-desk-close-up.png', async (p) => { await p.evaluate(() => { const o = window.__office.office, d = o.anchors.desks.designer; o.setSelected('designer'); o.focus({ x: d.x, z: d.z + 0.3 }, 2.7); }); });
    // the day ends (job A in the approval queue, job B blocked), then the board and the approval queue
    await until(() => ['done', 'failed'].includes(demo.state().phase), 'the end of the demo day', 900000);
    if (demo.state().phase === 'failed') problems.push('demo failed: ' + demo.state().error);
    await still('03-board-end.png', async (p) => { await p.evaluate(() => { window.__office.closeOverlays(); window.__office.office.resetView(); }); await settle(p); await p.evaluate(() => window.__office.openBoard()); });
    await still('04-approval-queue.png', async (p) => { await p.evaluate((id) => { window.__office.closeOverlays(); window.__office.office.resetView(); window.__office.showJob(id); }, jobA()); await p.waitForSelector('#sidepanel:not(.hidden) .sp-head', { timeout: 15000 }); await p.waitForFunction(() => [...document.querySelectorAll('#sidepanel img')].every((i) => i.complete), null, { timeout: 15000 }); });
    // the recorded page closes on the board, the calendar (the day's jobs) and the approval queue
    await sleep(2500);
    await page.evaluate(() => window.__office.openBoard()); await sleep(5000);
    await page.evaluate(() => window.__office.openCalendar()); await sleep(4000);
    await page.evaluate((id) => { window.__office.closeOverlays(); window.__office.showJob(id); }, jobA()); await sleep(4500);
    const video = page.video();
    await ctx.close();
    const wallS = (Date.now() - t0) / 1000;
    const webm = path.join(OUT, 'station-demo.webm');
    await video.saveAs(outJail(webm));
    fs.rmSync(outJail(tmpVideo), { recursive: true, force: true });
    const ff = pinnedFfmpeg();
    const durS = durationOf(ff.exe, outJail(webm));
    let mp4 = null, mp4Note;
    if (ff.exe && ff.canMp4) {
      const f = path.join(OUT, 'station-demo.mp4');
      const r = spawnSync(ff.exe, ['-hide_banner', '-y', '-i', outJail(webm), '-c:v', ff.encoders.includes('libx264') ? 'libx264' : 'mpeg4', '-pix_fmt', 'yuv420p', outJail(f)], { encoding: 'utf8', timeout: 600000 });
      if (r.status === 0) { mp4 = 'screenshots/' + f.replace(/\\/g, '/'); mp4Note = 'made with Playwright\'s pinned ffmpeg build ' + ff.rev; } else mp4Note = 'conversion failed: ' + String(r.stderr || '').split('\n').slice(-3).join(' ');
    } else mp4Note = ff.exe ? 'not made: the only pinned, licence-checked converter is Playwright\'s ffmpeg build ' + ff.rev + ' (playwright ' + ff.playwright + ', ' + (ff.licence || 'licence file missing') + '), and it has no MP4 muxer or H.264/MPEG-4 encoder (video encoders: ' + ff.encoders.join(', ') + '). No converter from PATH is used.' : 'not made: ' + ff.why;
    const result = { webm: 'screenshots/' + webm.replace(/\\/g, '/'), bytes: fs.statSync(outJail(webm)).size, durationS: durS, wallClockS: Math.round(wallS * 10) / 10, speed, headed, mp4, mp4Note, stills, demo: demo.current() && demo.current().result, problems };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await demo.close();
  }
}

main().catch((e) => { console.error('demo:record failed: ' + (e.stack || e.message)); process.exitCode = 1; });
