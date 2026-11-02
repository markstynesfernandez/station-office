// r7a-floors.test.mjs — R7a (owner, 29/10/2026): the seven floors of the 3D office, built from the company model (RESTRUCTURE.md §7).
//   1 the stack: every department on the floor its config gives (display order only); moving a department moves its design and its
//     jobs with it, and no record carries a floor
//   2 who sits where: a hired agent at its desk with its live status, a not-hired agent an empty desk with its tag, an archived agent
//     only in the lobby (the trophy cabinet; OVERSEER on the retired wall)
//   3 the floor menu and the whole-building view (the lift) reach every floor, top floor first
//   4 the screens: only data the snapshot has; the honest empty state where there is none
//   5 the page (Playwright, headless, the engine view on the mock provider): every floor in light and dark with no page error, the
//     right people and tags, the menu and the lift reach every floor, the Etsy button still opens its panel, frame time per floor
//   6 R7a.2 (owner's screenshot review, 29/10/2026): every desk's tag on its own desk (a hired agent's with its working/idle dot), the
//     trophy cabinet's plaque (the product's name, the eight names) and OVERSEER's own plaque, the floor-aware task box, the lift's numbers
// Mock provider, temp data roots, no model call, $0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { buildEngineSnapshot } from '../src/server/engine-model.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { towerFloors, planFloor, floorPeople, screenContent, levelOf, DESIGNS } from '../src/web/scene/towerplan.js';
import { floorMenu, floorSnapshot, pickFloor, buildingTotals, isTower } from '../src/web/ui/floors.js';
import { createBuildingView } from '../src/web/ui/building.js';
import { KIT_PROPS } from '../src/web/scene/kit.js';
import { workDot, trophyCard } from '../src/web/ui/labels.js';
import { floorWork } from '../src/web/ui/taskpanel.js';

const FLOORS = ['6', '5', '4', '3', '2', '1', 'G'];
const ETSY = ['demand-researcher', 'evidence-checker', 'trend-scout', 'designer', 'qa-design', 'lister', 'qa-listing', 'rejects-desk'];
const deptCfg = () => fs.readdirSync(path.join(APP_ROOT, 'config', 'departments')).map((f) => JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config', 'departments', f), 'utf8')));
function engineOn(t, tag) {
  const r = tempRoot(tag), engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  t.after(() => { try { engine.close(); } catch (_) {} r.cleanup(); });
  return engine;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test('1: the stack comes from the company model: each department on its config floor, top floor first; a move changes only the display', (t) => {
  const s = buildEngineSnapshot(engineOn(t, 'r7a1'));
  assert.ok(isTower(s));
  assert.deepEqual(towerFloors(s).map((f) => [f.floor, f.id, f.design, f.name]), [['6', 'hq', 'penthouse', 'Penthouse HQ'], ['5', 'security-data', 'security', 'Security & Data'], ['4', 'engineering', 'engineering', 'Engineering'], ['3', 'product-design', 'product', 'Product & Design'], ['2', 'sales-marketing', 'sales', 'Sales & Marketing'], ['1', 'customer-success', 'success', 'Customer Success'], ['G', 'etsy', 'lobby', 'Lobby']]);
  for (const d of deptCfg()) assert.deepEqual(towerFloors(s).find((f) => f.departments.some((x) => x.key === d.id)).floor, String(d.floor).toUpperCase(), d.id + ' is on its config floor');
  assert.deepEqual(['G', '1', '6', 'x'].map(levelOf), [0, 1, 6, -1]);
  // Engineering moves to floor 2 and Sales & Marketing to 4 (display only): each design, its desks and its jobs go with the department
  const moved = clone(s); for (const d of moved.company.floors) d.floor = d.id === 'engineering' ? '2' : d.id === 'sales-marketing' ? '4' : d.floor;
  moved.jobs = [{ id: 'eng-x', kind: 'engineering', line: 'engineering', state: 'running', status: 'in_progress', title: 'Fix the edit', businessId: null }];
  const two = planFloor(moved, '2'), four = planFloor(moved, '4');
  assert.deepEqual([two.design, two.id, four.design, four.id], ['engineering', 'engineering', 'sales', 'sales-marketing']);
  assert.deepEqual(two.seats.map((x) => x.agentId), ['tech-lead', 'developer', 'reviewer', 'tester']);
  assert.deepEqual([floorSnapshot(moved, '2').jobs.map((j) => j.id), floorSnapshot(moved, '4').jobs.length], [['eng-x'], 0]);
  assert.ok(!JSON.stringify(s.jobs || []).includes('"floor":"4"'), 'no record carries a floor');
  // every design is keyed on a department id that exists; every floor is assembled from the one kit
  for (const id of Object.keys(DESIGNS)) assert.ok(deptCfg().some((d) => d.id === id), id);
  for (const f of FLOORS) for (const p of planFloor(s, f).props) assert.ok(KIT_PROPS.includes(p.kind), 'floor ' + f + ': ' + p.kind + ' is a kit prop');
});

test('2: hired agents at their desks (live status), not-hired agents at empty desks with their tag, archived agents only in the lobby', (t) => {
  const s = buildEngineSnapshot(engineOn(t, 'r7a2'));
  const six = planFloor(s, '6');
  assert.deepEqual(six.seats.map((x) => [x.agentId, x.state, x.label]), [['ceo', 'hired', 'active'], ['cto', 'hired', 'active'], ['coo', 'hired', 'active'], ['compliance', 'not-hired', 'not hired yet (R5)']]);
  assert.deepEqual([six.seats.find((x) => x.agentId === 'cto').work, six.seats.find((x) => x.agentId === 'ceo').work, six.seats.find((x) => x.agentId === 'compliance').work], ['idle', 'idle', null], 'R3: the CEO is hired');
  // COMPLIANCE in its own glass room: its desk is inside the glass on x = 7.4 and z = -2.0
  const comp = six.seats.find((x) => x.agentId === 'compliance');
  assert.ok(comp.x > 7.4 && comp.z < -2.0); assert.ok(six.props.some((p) => p.kind === 'glass' && p.x0 === 7.4 && p.x1 === 7.4));
  const v6 = floorSnapshot(s, '6');
  assert.deepEqual([v6.agents.map((a) => a.id).sort(), v6.vacancies.map((x) => x.id)], [['ceo', 'coo', 'cto'], ['compliance']]);
  assert.deepEqual(planFloor(s, '4').seats.map((x) => [x.agentId, x.state, x.kind]), [['tech-lead', 'hired', 'standing'], ['developer', 'hired', 'standing'], ['reviewer', 'hired', 'standing'], ['tester', 'hired', 'standing']]);
  // the live status: a working agent's seat says so
  const w = clone(s); w.agents.find((a) => a.id === 'developer').status = 'working';
  assert.equal(planFloor(w, '4').seats.find((x) => x.agentId === 'developer').work, 'working');
  for (const [f, ids] of [['5', [['security', 'hired'], ['analyst', 'not-hired']]], ['3', [['product-manager', 'not-hired'], ['ux-designer', 'not-hired']]], ['2', [['lead-researcher', 'not-hired'], ['lead-checker', 'not-hired'], ['outreach-writer', 'not-hired'], ['content-writer', 'not-hired']]], ['1', [['onboarding-guide', 'not-hired'], ['support-drafter', 'not-hired'], ['retention-analyst', 'not-hired']]]]) assert.deepEqual(planFloor(s, f).seats.map((x) => [x.agentId, x.state]), ids, 'floor ' + f);
  // archived: no desk anywhere; the lobby's cabinet holds the eight Etsy agents, OVERSEER hangs on the retired wall
  for (const f of FLOORS) for (const x of planFloor(s, f).seats) assert.notEqual(x.state, 'archived', f);
  const g = planFloor(s, 'G');
  assert.deepEqual([g.seats.length, g.cabinet.map((a) => a.agentId).sort(), g.figurines.length, g.retired.map((a) => [a.agentId, a.label])], [0, [...ETSY].sort(), 8, [['overseer', 'retired into COO']]]);
  assert.deepEqual(floorPeople(s, '6').desks.map((d) => d.agentId), ['ceo', 'cto', 'coo', 'compliance'], 'OVERSEER (archived, HQ) has no desk on the penthouse');
  assert.deepEqual(g.screens.filter((x) => x.kind === 'names').flatMap((x) => x.content.names).length, 8, 'a name plate per figurine');
});

test('3: the floor menu and the lift reach every floor, top floor first', (t) => {
  const s = buildEngineSnapshot(engineOn(t, 'r7a3'));
  assert.deepEqual(floorMenu(s).map((r) => [r.floor, r.name, r.departments.map((d) => d.key)]), [['6', 'Penthouse HQ', ['hq']], ['5', 'Security & Data', ['security-data']], ['4', 'Engineering', ['engineering']], ['3', 'Product & Design', ['product-design']], ['2', 'Sales & Marketing', ['sales-marketing']], ['1', 'Customer Success', ['customer-success']], ['G', 'Lobby', ['etsy']]]);
  assert.deepEqual([pickFloor(s, null), pickFloor(s, 'g'), pickFloor(s, '4'), pickFloor(s, '0'), pickFloor(s, '9')], ['6', 'G', '4', '6', '6'], 'the remembered floor if it exists, else the top floor');
  for (const f of FLOORS) { const v = floorSnapshot(s, f); assert.deepEqual([v.floorView.floor, v.plan.floor, v.floorView.tower], [f, f, true]); }
  const tot = buildingTotals(s);
  assert.deepEqual(tot.map((r) => [r.floor, r.agents, r.notHired, r.trophy, r.retired]), [['6', 3, 1, 0, []], ['5', 1, 1, 0, []], ['4', 4, 0, 0, []], ['3', 0, 2, 0, []], ['2', 0, 4, 0, []], ['1', 0, 3, 0, []], ['G', 0, 0, 8, ['STATION-OVERSEER']]]);
  // the whole-building view is the lift: one button per floor, top floor first, the car at the floor shown
  const body = { innerHTML: '', querySelectorAll: () => [] }, root = { querySelector: () => body, classList: { add() {}, remove() {}, contains: () => true } };
  createBuildingView({ root }).render(s, '4');
  assert.deepEqual([...body.innerHTML.matchAll(/class="lift-floor[^"]*" role="listitem" data-floor="([^"]+)"/g)].map((m) => m[1]), FLOORS);
  assert.match(body.innerHTML, /class="lift-floor lift-cur" role="listitem" data-floor="4"/);
  for (const x of ['8 archived agents in the trophy cabinet', 'STATION-OVERSEER retired', '3 not hired yet', 'Penthouse · the Owner\'s office', 'Finance (from the ledger)']) assert.ok(body.innerHTML.includes(x), x);
  // the page: floors are strings ('G'); the menu, the lift and the tabs pass them as they are; [ and ] step by level like a lift
  const main = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'main.js'), 'utf8'), fm = fs.readFileSync(path.join(APP_ROOT, 'src', 'web', 'ui', 'floormenu.js'), 'utf8');
  assert.match(main, /setFloor\(b\.dataset\.fl\)/); assert.match(main, /sort\(\(a, b\) => levelOf\(a\) - levelOf\(b\)\)/); assert.match(fm, /el\.dataset\.floor === '' \? null : el\.dataset\.floor/);
});

test('4: the screens show only what the snapshot has, and an honest empty state where it has nothing', (t) => {
  const engine = engineOn(t, 'r7a4'), s = buildEngineSnapshot(engine);
  const c = (k, snap = s) => screenContent(k, snap, { floor: towerFloors(snap).find((f) => f.floor === '4') });
  assert.deepEqual(['leaderboard', 'support', 'roadmap', 'metrics', 'pipeline', 'onboarding', 'kanban', 'checks'].map((k) => [k, c(k).empty]), [['leaderboard', 'no leads yet'], ['support', 'no tickets yet'], ['roadmap', 'no roadmap yet'], ['metrics', 'no metrics yet'], ['pipeline', 'no pipeline yet'], ['onboarding', 'no customers yet'], ['kanban', 'no jobs yet'], ['checks', 'no checks run yet']]);
  for (const k of ['leaderboard', 'support', 'roadmap', 'metrics', 'pipeline', 'onboarding']) assert.deepEqual(c(k).rows, [], k + ' has no numbers');
  assert.deepEqual([c('leaderboard').foot, c('support').foot, c('roadmap').foot, c('metrics').foot], ['LEAD-RESEARCHER: not hired yet (R5)', 'SUPPORT-DRAFTER: not hired yet (R6)', 'PRODUCT-MANAGER: not hired yet (R4)', 'ANALYST: not hired yet (R6)']);
  assert.deepEqual([c('requests').big, c('requests').empty], ['0', 'nothing waiting']);
  assert.deepEqual(c('finance').rows.map((r) => r.label).sort(), ['ReplyDesk', 'The Station', 'TheStationShopFinds (archived)', 'emty-inbox']);
  assert.deepEqual(c('directory').rows.map((r) => [r.label, r.tone]), [['6', null], ['5', null], ['4', 'ok'], ['3', null], ['2', null], ['1', null], ['G', null]]);
  assert.deepEqual([c('sign').title, c('trophy').title, c('trophy').sub, c('compliance-sign').sub], ['STATION', 'TheStationShopFinds', '8 archived agents', 'independent · reports to the owner']);
  // with data: a request waiting, an engineering job at a step, the sandbox's last checks
  engine.requests.file({ action: 'dependency.add', productId: 'replydesk', departmentId: 'engineering', summary: 'add ruff', payload: 'ruff', actor: { kind: 'engine' } });
  const d = buildEngineSnapshot(engine);
  d.engineering = { ...d.engineering, current: { jobId: 'eng-1', title: 'Lock approved replies', state: 'running', step: 'tester' }, lastChecks: { jobId: 'eng-1', pass: 2, results: [{ check: 'test', passed: true }, { check: 'lint', passed: false }] } };
  d.jobs = [...(d.jobs || []), { id: 'eng-1', kind: 'engineering', state: 'running', title: 'Lock approved replies' }];
  assert.deepEqual([c('requests', d).big, c('requests', d).empty, c('requests', d).rows[0].label], ['1', null, 'add ruff']);
  assert.deepEqual(c('checks', d).rows.map((r) => [r.label, r.value]), [['job', 'Lock approved replies'], ['step', 'tester'], ['last sandbox run', 'pass 2'], ['test', 'passed'], ['lint', 'failed']]);
  assert.deepEqual([c('kanban', d).empty, c('kanban', d).columns.find((x) => x.name === 'In progress').cards], [null, ['Lock approved replies']]);
  // the server's checks-screen data: none until an engineering job has run its checks
  assert.deepEqual([s.engineering.current, s.engineering.lastChecks], [null, null]);
});

// ---- 5. the page in a real (headless) browser
test('5: the page: every floor in light and dark, no page error, people and tags, the menu and the lift, the Etsy button, frame time', { timeout: 240000 }, async (t) => {
  let launch;
  try { ({ launch } = await import('../scripts/screenshots.mjs')); } catch (e) { t.skip('Playwright is not available: ' + e.message); return; }
  const r = tempRoot('r7a5'), engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, startScheduler: false });
  const es = createEngineServer({ engine, log: r.log });
  await new Promise((res) => es.server.listen(0, '127.0.0.1', res));
  let browser = null;
  t.after(async () => { if (browser) await browser.close(); es.closeAll(); await new Promise((res) => es.server.close(res)); try { engine.close(); } catch (_) {} r.cleanup(); });
  let gl;
  try { ({ browser, gl } = await launch({ headed: false })); } catch (e) { t.skip('no WebGL-capable browser: ' + e.message); return; }
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 }), problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  const base = 'http://127.0.0.1:' + es.server.address().port;
  await page.goto(base + '/?anim=0&quality=default&theme=light&floor=6', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__office && window.__office.ready(), null, { timeout: 60000 });
  const settle = () => page.waitForFunction(() => window.__office.settled(), null, { timeout: 15000 });
  const frames = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => window.__office.setTheme(th), theme);
    for (const f of FLOORS) {
      await page.evaluate((x) => window.__office.setFloor(x), f); await settle();
      const st = await page.evaluate(() => ({ floor: window.__office.floor(), tower: window.__office.office.towerState(), vacant: [...document.querySelectorAll('#labels .lbl-vacant')].map((e) => e.textContent), names: [...document.querySelectorAll('#labels .lbl:not(.lbl-vacant):not(.rack-lbl):not(.svc-lbl)')].map((e) => e.textContent), caption: document.querySelector('#floor-caption').textContent }));
      assert.equal(st.floor, f); assert.equal(st.tower.floor, f);
      const plan = planFloor(await page.evaluate(() => window.__office.snapshot()), f);
      assert.deepEqual(st.tower.seats.map((x) => [x.agentId, x.state, x.person]), plan.seats.map((x) => [x.agentId, x.state, x.state === 'hired']), 'floor ' + f + ': a person at every hired desk, none at an empty one');
      assert.equal(st.vacant.length, plan.seats.filter((x) => x.state === 'not-hired').length, 'floor ' + f + ': a tag per empty desk');
      for (const v of st.vacant) assert.match(v, /not hired yet \(R\d\)$/);
      for (const sc of st.tower.screens) if (['leaderboard', 'support', 'roadmap', 'metrics', 'pipeline', 'onboarding', 'kanban', 'checks'].includes(sc.kind)) assert.ok(sc.empty, f + ' ' + sc.kind + ' shows its empty state');
      assert.match(st.caption, f === 'G' ? /^Ground floor · Lobby/ : new RegExp('^Floor ' + f + ' · '));
      if (f === 'G') assert.deepEqual([st.tower.cabinet.length, st.tower.retired], [8, ['overseer']]);
      // R7a.2: every desk's tag is shown, and its stem's foot is nearer its own desk than any other desk on the floor
      const tags = await page.evaluate((seats) => {
        const o = window.__office.office, out = [];
        for (const s of seats) {
          const el = document.querySelector('#labels .lbl-desk[data-agent="' + s.agentId + '"]');
          if (!el) { out.push({ id: s.agentId, missing: true }); continue; }
          const r = el.getBoundingClientRect(), stage = document.querySelector('#labels').getBoundingClientRect(), pin = { x: r.left + r.width / 2 - stage.left, y: r.bottom + 12 - stage.top };
          const y = (o.anchors.agents[s.agentId] || o.anchors.vacant[s.agentId]).y;
          const d = seats.map((x) => { const p = o.project({ x: x.frame.monitor.x, y, z: x.frame.monitor.z }); return { id: x.agentId, d: Math.hypot(p.x - pin.x, p.y - pin.y) }; }).sort((a, b) => a.d - b.d);
          out.push({ id: s.agentId, shown: el.style.display !== 'none', nearest: d[0].id, dot: (el.querySelector('i.dot') || {}).className || null, text: el.textContent });
        }
        return out;
      }, plan.seats.map((x) => ({ agentId: x.agentId, state: x.state, frame: x.frame })));
      for (const x of tags) { assert.ok(!x.missing && x.shown, f + ' ' + x.id + ': its tag is shown'); assert.equal(x.nearest, x.id, f + ' ' + x.id + ': its tag stands on its own desk'); }
      for (const x of tags.filter((y) => plan.seats.find((z) => z.agentId === y.id).state === 'hired')) assert.match(x.dot, /dot-(working|idle)/, f + ' ' + x.id + ': a status dot');
      // R7a.2: the task box follows the floor
      const box = await page.evaluate(() => ({ etsy: !document.querySelector('#task-etsy').classList.contains('hidden'), floor: !document.querySelector('#task-floor').classList.contains('hidden'), text: document.querySelector('#task-floor-text').textContent, issue: !document.querySelector('#task-new-issue').classList.contains('hidden'), etsyOff: [...document.querySelectorAll('#task-etsy [data-go]')].every((b) => b.disabled), mode: document.querySelector('#task-mode').textContent }));
      if (f === 'G') assert.deepEqual([box.etsy, box.floor, box.etsyOff, box.mode], [true, false, true, 'archived · refused'], 'G: the Etsy controls, refused as archived');
      else if (f === '4') assert.deepEqual([box.etsy, box.floor, box.issue], [false, true, true], '4: New issue');
      else assert.deepEqual([box.etsy, box.floor, box.issue, box.text], [false, true, false, floorWork(await page.evaluate(() => window.__office.view()), null).text], f + ': no work line yet');
      if (f === 'G') {
        const tc = await page.evaluate(() => { const c = document.querySelector('#labels .trophy-card'), p = document.querySelector('#labels .lbl-plaque'); return { name: c && c.querySelector('.trophy-name').textContent, plaques: c ? c.querySelectorAll('.plaque').length : 0, shown: !!c && c.style.display !== 'none', retired: p && p.textContent, retiredShown: !!p && p.style.display !== 'none' }; });
        assert.deepEqual(tc, { name: 'TheStationShopFinds', plaques: 8, shown: true, retired: 'STATION-OVERSEERretired into COO', retiredShown: true });
      }
      if (theme === 'light') {
        const b = await page.evaluate(() => window.__office.bench(1500, { move: true }));
        frames.push({ floor: f, avgFrameMs: b.avgFrameMs, p95FrameMs: b.p95FrameMs, avgCpuMs: b.avgCpuMs, calls: b.calls, tris: b.tris });
      }
    }
  }
  // the floor menu (F) reaches every floor; so does the lift (the building view, G)
  for (const f of FLOORS) {
    await page.keyboard.press('f'); await page.waitForSelector('#floor-menu:not(.hidden)');
    await page.click('#floor-menu .fm-go[data-floor="' + f + '"]'); await settle();
    assert.equal(await page.evaluate(() => window.__office.floor()), f, 'menu → ' + f);
  }
  // R7a.2: the lift's floor numbers read in both themes: on their own chip, inside their floor's row, the text against the chip at 4.5:1 or more
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => window.__office.setTheme(th), theme);
    await page.evaluate(() => window.__office.openBuilding()); await page.waitForSelector('#building:not(.hidden) .lift');
    const nums = await page.evaluate(() => [...document.querySelectorAll('#building .lift-n')].map((n) => { const r = n.getBoundingClientRect(), b = n.closest('.lift-floor').getBoundingClientRect(), cs = getComputedStyle(n); return { n: n.textContent, inside: r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom && r.width > 0, fg: cs.color, bg: cs.backgroundColor }; }));
    const lum = (c) => { const v = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    assert.deepEqual(nums.map((x) => x.n), FLOORS);
    for (const x of nums) { const a = lum(x.fg), b = lum(x.bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); assert.ok(x.inside, theme + ' ' + x.n + ' inside its row'); assert.ok(ratio >= 4.5, theme + ' floor ' + x.n + ' contrast ' + ratio.toFixed(2)); }
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.__office.setTheme('light'));
  for (const f of ['G', '6']) {
    await page.evaluate(() => window.__office.openBuilding()); await page.waitForSelector('#building:not(.hidden) .lift');
    await page.click('#building .lift-floor[data-floor="' + f + '"]'); await settle();
    assert.equal(await page.evaluate(() => window.__office.floor()), f, 'lift → ' + f);
  }
  // the own-shop button (E7a) still opens its panel
  await page.click('#etsy-btn'); await page.waitForSelector('#dialogs .dlg', { timeout: 10000 });
  assert.match(await page.textContent('#dialogs .dlg h3'), /^Etsy/); await page.keyboard.press('Escape');
  assert.deepEqual(problems, [], 'no page error');
  const swift = /swiftshader/i.test(String(gl));
  t.diagnostic('GL renderer: ' + gl + (swift ? ' (software: the frame times are not the laptop\'s figure)' : ''));
  for (const x of frames) t.diagnostic('floor ' + x.floor + ': ' + x.avgFrameMs + ' ms a frame (p95 ' + x.p95FrameMs + ' ms, cpu ' + x.avgCpuMs + ' ms), ' + x.calls + ' draw calls, ' + x.tris + ' triangles');
  if (!swift) for (const x of frames) assert.ok(x.avgFrameMs > 0 && x.avgFrameMs < 16.7, 'floor ' + x.floor + ' frame ' + x.avgFrameMs + ' ms (60 fps: 16.7 ms)');
});

test('6: R7a.2: the tag dot, the trophy cabinet plaque and the floor-aware task box (pure)', (t) => {
  const s = buildEngineSnapshot(engineOn(t, 'r7a6'));
  assert.deepEqual(['working', 'idle', 'waiting', 'error', undefined].map(workDot), ['working', 'idle', 'idle', 'idle', 'idle']);
  // the cabinet's plaque: the product's name, the eight archived Etsy agents by name, never OVERSEER (it has its own plaque)
  const g = planFloor(s, 'G'), html = trophyCard(g);
  assert.match(html, /<h3 class="trophy-name">TheStationShopFinds<\/h3>/);
  assert.equal((html.match(/class="plaque"/g) || []).length, 8);
  for (const a of g.cabinet) assert.ok(html.includes('>' + a.name + '<'), a.name);
  assert.ok(!html.includes('OVERSEER'));
  assert.deepEqual(g.retired.map((a) => [a.name, a.label]), [['STATION-OVERSEER', 'retired into COO']]);
  // the task box per floor: the Etsy controls only in the archive (refused), New issue on Engineering, the phase elsewhere
  const work = Object.fromEntries(FLOORS.map((f) => { const w = floorWork(floorSnapshot(s, f)); return [f, w.kind === 'etsy' ? 'etsy' + (w.archived ? ' (archived)' : '') : w.kind === 'eng' ? 'eng' : w.kind === 'exec' ? 'exec' : w.text]; }));
  assert.deepEqual(work, { 6: 'exec', 5: 'No work line on this floor yet (opens in R6)', 4: 'eng', 3: 'No work line on this floor yet (opens in R4)', 2: 'No work line on this floor yet (opens in R5)', 1: 'No work line on this floor yet (opens in R6)', G: 'etsy (archived)' });
  assert.equal(floorWork(s), null, 'off the stack the box is as it was');
});
