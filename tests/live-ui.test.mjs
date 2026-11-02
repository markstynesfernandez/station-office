// live-ui.test.mjs — E5, the live office (ENGINE-PLAN.md §6), through the real HTTP server on a temp data root and the
// mock provider ($0, no keys), with the dry-run fixtures. Covers the write safety on every request (same origin, action
// token, idempotency key, expectedVersion), the e-stop, routines created disabled, approval decisions writing only the
// approvals and tracker rows, no write outside the data root, and every control end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { tempRoot, until, sleep } from './helpers/engine.mjs';
import { createEngine } from '../src/engine/engine.mjs';
import { createEngineServer } from '../src/server/engine-server.mjs';
import { loadConfig } from '../src/engine/config.mjs';
import { APP_ROOT } from '../src/engine/store/jail.mjs';
import { dublinDay } from '../src/engine/time.mjs';
import { createDryRunScript, JOB_A, JOB_B } from '../fixtures/engine/mock-script.mjs';
import { matchesFilter } from '../src/web/ui/taskpanel.js';

const FIX = path.join(APP_ROOT, 'fixtures', 'engine');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const OVERRIDES = { productsFile: readJson(path.join(FIX, 'products.json')), stationSet: readJson(path.join(FIX, 'station-config-patch.json')).set };
const briefText = (id) => fs.readFileSync(path.join(FIX, 'briefs', id + '.md'), 'utf8').replace(/\{\{TODAY\}\}/g, dublinDay());

const SPENDING = { '/api/tasks/research': () => 'research', '/api/tasks/brief': () => 'start-line', '/api/tasks/rerun-listing': () => 'rerun-listing', '/api/jobs/restart': () => 'restart', '/api/jobs/qa-only': () => 'qa-only', '/api/jobs/listing-only': () => 'listing-only', '/api/agents/update': (b) => (b.enabled === true ? 'agent-on-duty' : null), '/api/routines/enable': (b) => (b.enabled === true ? 'routine-arm' : null) };

async function boot(t, { mockDelayMs = 0, startScheduler = false, tag = 'live', wrap = (s) => s } = {}) {
  const r = tempRoot(tag);
  const station = loadConfig({ configDir: path.join(APP_ROOT, 'config'), promptsDir: path.join(APP_ROOT, 'prompts'), overrides: OVERRIDES }).station;
  const engine = createEngine({ archiveSandbox: true, J: r.J, log: r.log, script: wrap(createDryRunScript({ cfg: station })), overrides: OVERRIDES, startScheduler, mockDelayMs });
  // the research line's output: the two fixture briefs, verified, waiting in research/briefs/
  for (const id of [JOB_A, JOB_B]) r.J.put(path.join(r.dataRoot, 'research', 'briefs', id + '.md'), briefText(id));
  const es = createEngineServer({ engine, log: r.log });
  await new Promise((res) => es.server.listen(0, '127.0.0.1', res));
  const port = es.server.address().port, origin = 'http://127.0.0.1:' + port;
  t.after(async () => { es.closeAll(); await new Promise((res) => es.server.close(res)); try { engine.close(); } catch (_) {} r.cleanup(); });
  const raw = (method, p, { headers = {}, body = null } = {}) => new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (s) => { const parts = []; s.on('data', (c) => parts.push(c)); s.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (_) {} res({ status: s.statusCode, json, text }); }); });
    q.on('error', rej); if (body != null) q.write(body); q.end();
  });
  // a page's write: same origin, token, JSON, a fresh idempotency key unless given
  const send = (p, body = {}, { key = crypto.randomUUID(), origin: o = origin, token = es.token, headers = {} } = {}) => raw('POST', p, { headers: { 'content-type': 'application/json', ...(o ? { origin: o } : {}), ...(token ? { 'x-station-action': token } : {}), ...(key ? { 'x-idempotency-key': key } : {}), ...headers }, body: JSON.stringify(body) });
  // L2: an action that can spend goes through the confirm step first, as the page does (tests/l2-steer.test.mjs covers the refusals)
  const post = async (p, body = {}, opts = {}) => {
    const action = SPENDING[p] && SPENDING[p](body);
    if (action && opts.confirm !== false && body.confirmToken === undefined && opts.origin === undefined && opts.token === undefined) {
      const q = await send('/api/spend/quote', { action, params: body });
      if (q.status === 200 && q.json.result.token) body = { ...body, confirmToken: q.json.result.token };
    }
    return send(p, body, opts);
  };
  const snap = async () => (await raw('GET', '/api/office/snapshot?fresh')).json;
  const job = (id) => engine.store.getJob(id);
  const settled = (id) => until(() => { const j = job(id); return j && !engine.orchestrator.isActive(id) && !['running'].includes(j.state) && j; }, { timeout: 20000 });
  return { engine, r, raw, post, snap, job, settled, origin, token: es.token };
}

// every row of the tables a decision must not touch, plus a hash of every file under the data root except the event log
function fingerprint(engine, dataRoot) {
  const db = engine.store.db, out = {};
  for (const t of ['jobs', 'stages', 'runs', 'routines', 'agents_state', 'ledger_mirror', 'meta']) out[t] = JSON.stringify(db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all());
  const files = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), rel = path.relative(dataRoot, f).replace(/\\/g, '/'); if (/^(events|logs)(\/|$)|^station\.db/.test(rel)) continue; if (e.isDirectory()) walk(f); else files[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } };
  walk(dataRoot); out.files = files;
  return out;
}
const rowsOf = (engine, t) => JSON.stringify(engine.store.db.prepare('SELECT * FROM ' + t + ' ORDER BY 1').all());

test('a stale tab\'s write is refused with "changed since you loaded it", and nothing is written', async (t) => {
  const { engine, post } = await boot(t);
  const c = await post('/api/routines/create', { name: 'Weekday research', target: 'line:research', input: 'sticker niches', schedule: '0 9 * * 1-5' });
  assert.equal(c.status, 200, c.text);
  const loaded = c.json.result.version;                                  // tab A loaded this version
  const b = await post('/api/routines/update', { id: c.json.result.id, expectedVersion: loaded, name: 'Weekday research (tab B)' });
  assert.equal(b.status, 200, b.text);                                   // tab B saved first
  const before = rowsOf(engine, 'routines');
  const a = await post('/api/routines/enable', { id: c.json.result.id, expectedVersion: loaded, enabled: true });   // tab A, stale
  assert.equal(a.status, 409);
  assert.match(a.json.error, /^Not saved: the routine "Weekday research \(tab B\)" changed since you loaded it\. The page has been refreshed/);
  assert.equal(a.json.code, 'STALE');
  assert.equal(rowsOf(engine, 'routines'), before, 'the stale write changed nothing');
  assert.equal(engine.store.getRoutine(c.json.result.id).enabled, false);
  // the same for an agent, a job decision and the e-stop resume
  const ag = await post('/api/agents/update', { agentKey: 'designer', expectedVersion: 0, effort: 'medium' }); assert.equal(ag.status, 200, ag.text);
  const ag2 = await post('/api/agents/update', { agentKey: 'designer', expectedVersion: 0, effort: 'high' }); assert.equal(ag2.status, 409);
  assert.equal(engine.store.agentState('designer').effort, 'medium');
  await post('/api/engine/halt', { reason: 'test' });
  const stale = await post('/api/engine/resume', { confirm: 'RESUME', expectedVersion: 1 }); assert.equal(stale.status, 409);
  assert.equal(engine.halt.isHalted(), true);
  // every refusal is logged and emitted as an event
  assert.ok(engine.bus.since(0).filter((e) => e.type === 'action.refused' && e.data.status === 409).length >= 3);
});

test('a double click creates one job (same idempotency key, sent together)', async (t) => {
  const { engine, post, settled } = await boot(t);
  const key = crypto.randomUUID();
  const [a, b] = await Promise.all([post('/api/tasks/research', { text: 'cosy autumn sticker niches' }, { key }), post('/api/tasks/research', { text: 'cosy autumn sticker niches' }, { key })]);
  assert.equal(a.status, 200, a.text); assert.equal(b.status, 200, b.text);
  assert.equal(a.json.result.jobId, b.json.result.jobId);
  assert.ok(a.json.replayed || b.json.replayed, 'one of the two is a replay');
  assert.equal(engine.store.listJobs().filter((j) => j.kind === 'research').length, 1);
  // a later repeat (a retry after a network blip) is a replay too; a new key is a new job
  const c = await post('/api/tasks/research', { text: 'cosy autumn sticker niches' }, { key }); assert.equal(c.json.replayed, true);
  assert.equal(engine.store.listJobs().filter((j) => j.kind === 'research').length, 1);
  const k2 = crypto.randomUUID();
  const [d, e] = await Promise.all([post('/api/tasks/brief', { file: JOB_A + '.md' }, { key: k2 }), post('/api/tasks/brief', { file: JOB_A + '.md' }, { key: k2 })]);
  assert.equal(d.status, 200, d.text); assert.equal(e.status, 200, e.text);
  assert.equal(engine.store.listJobs().filter((j) => j.id === JOB_A).length, 1);
  assert.equal(engine.bus.since(0).filter((x) => x.type === 'job.created' && x.jobId === JOB_A).length, 1);
  for (const j of engine.store.listJobs()) await settled(j.id);
});

test('a cross-origin request, a missing or wrong token and a missing idempotency key are refused', async (t) => {
  const { engine, post } = await boot(t);
  const before = rowsOf(engine, 'jobs');
  const body = { text: 'something to research' };
  assert.equal((await post('/api/tasks/research', body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/tasks/research', body, { origin: null })).status, 403, 'no Origin header');
  assert.equal((await post('/api/tasks/research', body, { origin: 'http://localhost:1' })).status, 403, 'another local port');
  assert.equal((await post('/api/tasks/research', body, { token: null })).status, 403, 'no token');
  assert.equal((await post('/api/tasks/research', body, { token: 'stale-token-from-an-old-launch' })).status, 403, 'wrong token');
  assert.equal((await post('/api/tasks/research', body, { key: null })).status, 400, 'no idempotency key');
  assert.equal((await post('/api/tasks/research', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  for (const p of ['/api/routines/create', '/api/approvals/decide', '/api/agents/update', '/api/jobs/stop', '/api/engine/halt']) assert.equal((await post(p, {}, { origin: 'http://evil.example' })).status, 403, p);
  assert.equal(rowsOf(engine, 'jobs'), before, 'no job was created');
  assert.equal(engine.halt.isHalted(), false);
  const refused = engine.bus.since(0).filter((e) => e.type === 'action.refused');
  assert.ok(refused.length >= 12, 'every refusal is emitted');
});

test('while the e-stop is on no job starts and no routine fires', async (t) => {
  const { engine, post, job } = await boot(t);
  // a blocked job to try a restart on, and a routine that is enabled
  assert.equal((await post('/api/tasks/brief', { file: JOB_B + '.md' })).status, 200);
  await until(() => job(JOB_B) && job(JOB_B).state === 'blocked', { timeout: 20000 });
  const rt = (await post('/api/routines/create', { name: 'r', target: 'line:research', schedule: '*/5 * * * *' })).json.result;
  assert.equal((await post('/api/routines/enable', { id: rt.id, expectedVersion: rt.version, enabled: true })).status, 200);
  assert.equal((await post('/api/engine/halt', { reason: 'test' })).status, 200);
  const jobs = engine.store.listJobs().length, runs = engine.store.runsOf({ limit: 1000 }).length;
  const r1 = await post('/api/tasks/research', { text: 'anything' }); assert.equal(r1.status, 423); assert.match(r1.json.error, /e-stop is on/);
  const r2 = await post('/api/tasks/brief', { file: JOB_A + '.md' }); assert.equal(r2.status, 423);
  const r3 = await post('/api/jobs/restart', { jobId: JOB_B, expectedVersion: job(JOB_B).version }); assert.equal(r3.status, 423);
  const fired = await engine.scheduler.fire(engine.store.getRoutine(rt.id));
  assert.equal(fired.skipped, 'e-stop is on');
  assert.equal(engine.scheduler.armed().length, 0, 'the scheduler is stopped');
  // an agent put back on duty does not start its waiting jobs either
  const ag = await post('/api/agents/update', { agentKey: 'designer', expectedVersion: 0, enabled: true }); assert.equal(ag.status, 200);
  assert.deepEqual(ag.json.result.started, []);
  assert.equal(engine.store.listJobs().length, jobs, 'no job was created');
  assert.equal(engine.store.runsOf({ limit: 1000 }).length, runs, 'no run started');
  assert.equal(job(JOB_B).state, 'blocked');
  // resuming needs the typed word and the current state; stopped jobs are not restarted by it
  assert.equal((await post('/api/engine/resume', { confirm: 'yes', expectedVersion: engine.halt.state.at })).status, 400);
  assert.equal((await post('/api/engine/resume', { confirm: 'RESUME', expectedVersion: engine.halt.state.at })).status, 200);
  assert.equal(engine.halt.isHalted(), false); assert.equal(job(JOB_B).state, 'blocked');
});

test('routines are created disabled, an edit disables them again, legacy and unknown targets cannot be enabled', async (t) => {
  const { engine, post } = await boot(t);
  const c = await post('/api/routines/create', { name: 'Daily line', target: 'line:room1-digital', schedule: '30 10 * * *', enabled: true, maxRunsPerDay: 2, perRunCapUsd: 0.5 });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.result.enabled, false, 'created disabled whatever the request said');
  assert.equal(engine.store.getRoutine(c.json.result.id).enabled, false);
  assert.equal(engine.scheduler.armed().includes(c.json.result.id), false);
  // caps are config only: a per-run cap above the engine's is refused
  assert.equal((await post('/api/routines/create', { name: 'x', target: 'line:research', schedule: '0 9 * * *', perRunCapUsd: 5 })).status, 400);
  assert.equal((await post('/api/routines/create', { name: 'x', target: 'agent:designer', schedule: '0 9 * * *' })).status, 400);
  assert.equal((await post('/api/routines/create', { name: 'x', target: 'line:research', schedule: 'every day' })).status, 400);
  const on = await post('/api/routines/enable', { id: c.json.result.id, expectedVersion: c.json.result.version, enabled: true });
  assert.equal(on.status, 200); assert.equal(on.json.result.enabled, true);
  const ed = await post('/api/routines/update', { id: c.json.result.id, expectedVersion: on.json.result.version, schedule: '45 10 * * *' });
  assert.equal(ed.status, 200); assert.equal(ed.json.result.enabled, false, 'an edit needs a new approval'); assert.equal(ed.json.result.schedule, '45 10 * * *');
  const del = await post('/api/routines/delete', { id: c.json.result.id, expectedVersion: ed.json.result.version });
  assert.equal(del.status, 200); assert.equal(engine.store.getRoutine(c.json.result.id), null);
  engine.store.upsertLegacyRoutine({ id: 'legacy-x', name: 'legacy', target: 'legacy:agent:designer', schedule: '0 9 * * 1' });
  const lg = engine.store.getRoutine('legacy-x');
  assert.equal((await post('/api/routines/enable', { id: 'legacy-x', expectedVersion: lg.version, enabled: true })).status, 400);
  assert.equal((await post('/api/routines/delete', { id: 'legacy-x', expectedVersion: lg.version })).status, 400);
});

test('approve, reject and mark published write only the approvals and tracker rows', async (t) => {
  const { engine, post, job, r } = await boot(t);
  assert.equal((await post('/api/tasks/brief', { file: JOB_A + '.md' })).status, 200);
  await until(() => job(JOB_A).state === 'approval', { timeout: 20000 });
  const decideOnly = async (body) => {
    const before = fingerprint(engine, r.dataRoot), ap0 = rowsOf(engine, 'approvals'), tr0 = rowsOf(engine, 'tracker');
    const res = await post('/api/approvals/decide', { jobId: JOB_A, expectedVersion: engine.store.getApproval(JOB_A).version, ...body });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(fingerprint(engine, r.dataRoot), before, body.action + ' changed something besides the approvals and tracker rows');
    assert.notEqual(rowsOf(engine, 'approvals'), ap0); assert.notEqual(rowsOf(engine, 'tracker'), tr0);
    return res.json.result;
  };
  // refusals first: a reject needs a reason, publish needs approval first, a URL and a date not in the future
  assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, action: 'reject', reason: '  ', expectedVersion: engine.store.getApproval(JOB_A).version })).status, 400);
  assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, action: 'published', etsyUrl: 'https://www.etsy.com/listing/123', publishedOn: dublinDay(), expectedVersion: engine.store.getApproval(JOB_A).version })).status, 400);
  const a = await decideOnly({ action: 'approve' });
  assert.equal(a.status, 'approved'); assert.equal(engine.store.getTracker(JOB_A).status, 'approved');
  assert.equal(job(JOB_A).state, 'approval', 'the job row is not written');
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, action: 'published', etsyUrl: 'https://www.etsy.com/listing/123', publishedOn: tomorrow, expectedVersion: a.version })).status, 400);
  assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, action: 'published', etsyUrl: 'https://example.com/listing/123', publishedOn: dublinDay(), expectedVersion: a.version })).status, 400);
  // Mark published records the final title, final price and SKU as set on Etsy (port batch 17/10/2026); each is required
  const pub = { action: 'published', etsyUrl: 'https://www.etsy.com/listing/1234567890/mushroom-stickers', publishedOn: dublinDay(), finalTitle: 'Mushroom Sticker Sheet, FIXTURE', finalPriceEur: 4.5, sku: 'FIX-01' };
  for (const bad of [{ finalTitle: '' }, { finalPriceEur: 0 }, { finalPriceEur: 4.555 }, { sku: '' }, { sku: 'has space' }]) assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, ...pub, ...bad, expectedVersion: a.version })).status, 400, JSON.stringify(bad));
  const p = await decideOnly(pub);
  assert.equal(p.status, 'published'); assert.equal(engine.store.getTracker(JOB_A).etsy_listing_url, 'https://www.etsy.com/listing/1234567890/mushroom-stickers');
  assert.deepEqual([p.published.finalTitle, p.published.finalPriceEur, p.published.sku, p.published.priceFinal], ['Mushroom Sticker Sheet, FIXTURE', 4.5, 'FIX-01', true]);
  assert.match(engine.store.getTracker(JOB_A).status_reason, /SKU FIX-01, final price EUR 4\.50, final title "Mushroom Sticker Sheet, FIXTURE"/);
  // reject: the same queue row put back to pending (test set-up, as a listing re-run would)
  engine.store.decideApproval(JOB_A, { status: 'superseded' }); engine.store.queueApproval(JOB_A);
  const rj = await decideOnly({ action: 'reject', reason: 'colours too close to a known brand' });
  assert.equal(rj.status, 'rejected_by_owner'); assert.equal(rj.reason, 'colours too close to a known brand');
  assert.equal(engine.store.getTracker(JOB_A).status_reason, 'colours too close to a known brand');
});

test('every control works end to end on the mock provider, and no write lands outside the data root', async (t) => {
  // record every file-system write the process makes while the controls run
  const { engine, post, job, snap, settled, r } = await boot(t, { tag: 'e2e', startScheduler: true });
  const writes = [], orig = {};
  const W = ['writeFileSync', 'appendFileSync', 'openSync', 'renameSync', 'mkdirSync', 'rmSync', 'copyFileSync', 'unlinkSync', 'rmdirSync'];
  for (const k of W) { orig[k] = fs[k]; fs[k] = function (...a) { if (k !== 'openSync' || /[wa+]/.test(String(a[1] || 'r'))) { writes.push([k, String(a[0])]); if (k === 'renameSync' || k === 'copyFileSync') writes.push([k, String(a[1])]); } return orig[k].apply(this, a); }; }
  t.after(() => { for (const k of W) fs[k] = orig[k]; });

  // task box: research this -> a research job runs to research-done
  const rs = await post('/api/tasks/research', { text: 'woodland sticker niches for autumn' });
  assert.equal(rs.status, 200, rs.text);
  assert.equal((await settled(rs.json.result.jobId)).state, 'research-done');
  // task box: start line on brief (A) -> approval queue; (B) -> blocked by originality
  assert.equal((await post('/api/tasks/brief', { file: JOB_A + '.md' })).status, 200);
  assert.equal((await settled(JOB_A)).state, 'approval');
  assert.equal((await post('/api/tasks/brief', { file: '../../etc/passwd.md' })).status, 400, 'a brief name outside research/briefs/ is refused');
  let s = await snap();
  assert.ok(s.briefs.find((b) => b.id === JOB_A).jobId, 'the brief now shows its job');
  assert.ok(s.jobs.find((j) => j.id === JOB_A).controls.approve);
  // approval queue: reject with a reason, then re-run the listing on the approved design -> back in the queue
  const ap = engine.store.getApproval(JOB_A);
  assert.equal((await post('/api/approvals/decide', { jobId: JOB_A, action: 'reject', reason: 'tags too generic', expectedVersion: ap.version })).status, 200);
  s = await snap();
  const ja = s.jobs.find((j) => j.id === JOB_A);
  assert.equal(ja.lane, 'rejected'); assert.equal(ja.controls.rerunListing, true);
  const pkgBefore = fs.readdirSync(path.join(r.dataRoot, 'jobs', JOB_A, 'package')).length;
  const rr = await post('/api/tasks/rerun-listing', { jobId: JOB_A, expectedVersion: job(JOB_A).version });
  assert.equal(rr.status, 200, rr.text);
  assert.equal((await settled(JOB_A)).state, 'approval');
  const arch = fs.readdirSync(path.join(r.dataRoot, 'jobs', JOB_A)).filter((n) => n.startsWith('rerun-archive-'));
  assert.equal(arch.length, 1);
  assert.equal(fs.readdirSync(path.join(r.dataRoot, 'jobs', JOB_A, arch[0], 'package')).length, pkgBefore, 'the old package was moved, not deleted');
  assert.ok(fs.existsSync(path.join(r.dataRoot, 'jobs', JOB_A, arch[0], 'outbox', 'listing.json')));
  assert.equal(engine.store.getApproval(JOB_A).status, 'pending', 'back in the approval queue');
  assert.ok(fs.existsSync(path.join(r.dataRoot, 'jobs', JOB_A, 'package', 'MANIFEST.json')), 'a new package');
  // approve and mark published
  let a = await post('/api/approvals/decide', { jobId: JOB_A, action: 'approve', expectedVersion: engine.store.getApproval(JOB_A).version }); assert.equal(a.status, 200);
  a = await post('/api/approvals/decide', { jobId: JOB_A, action: 'published', etsyUrl: 'https://www.etsy.com/listing/42', publishedOn: dublinDay(), finalTitle: 'FIXTURE title', finalPriceEur: 3, sku: 'FIX-02', expectedVersion: a.json.result.version }); assert.equal(a.status, 200);
  s = await snap(); assert.equal(s.jobs.find((j) => j.id === JOB_A).status, 'done');

  // job B: blocked by originality -> archive (files moved to rerun-archive-*, never deleted)
  assert.equal((await post('/api/tasks/brief', { file: JOB_B + '.md' })).status, 200);
  assert.equal((await settled(JOB_B)).state, 'blocked');
  const dirB = path.join(r.dataRoot, 'jobs', JOB_B);
  const count = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  const nB = count(dirB);
  const ar = await post('/api/jobs/archive', { jobId: JOB_B, expectedVersion: job(JOB_B).version });
  assert.equal(ar.status, 200, ar.text);
  assert.equal(job(JOB_B).state, 'archived'); assert.equal(count(dirB), nB, 'no file deleted');
  assert.deepEqual(fs.readdirSync(dirB).sort().filter((n) => !n.startsWith('rerun-archive-')), ['brief.md']);
  s = await snap();
  assert.ok(!Object.values(s.board.lanes).flat().includes(JOB_B) && !s.board.columns.some((c) => c.jobIds.includes(JOB_B)), 'an archived job leaves the board');
  assert.equal(matchesFilter(s.jobs.find((j) => j.id === JOB_B), 'archived'), true);
  assert.equal(matchesFilter(s.jobs.find((j) => j.id === JOB_B), 'all'), false);

  // desk panel: tier and effort apply at the next run, no restart; off duty makes the step wait, on duty resumes it
  const ds = await post('/api/agents/update', { agentKey: 'demand-researcher', expectedVersion: 0, tier: 'cheap', effort: 'high' });
  assert.equal(ds.status, 200, ds.text);
  assert.equal((await post('/api/agents/update', { agentKey: 'demand-researcher', expectedVersion: ds.json.result.version, tier: 'huge' })).status, 400, 'tiers come from config');
  const off = await post('/api/agents/update', { agentKey: 'demand-researcher', expectedVersion: ds.json.result.version, enabled: false });
  assert.equal(off.status, 200);
  const r2 = await post('/api/tasks/research', { text: 'second batch' });
  const r2id = r2.json.result.jobId;
  await until(() => job(r2id).state === 'queued' && job(r2id).data.waitingFor === 'demand-researcher', { timeout: 5000 });
  assert.match(job(r2id).reason, /DEMAND-RESEARCHER is off duty/);
  s = await snap(); assert.equal(s.agents.find((x) => x.id === 'demand-researcher').statusText, 'off duty');
  const on = await post('/api/agents/update', { agentKey: 'demand-researcher', expectedVersion: off.json.result.version, enabled: true });
  assert.deepEqual(on.json.result.started, [r2id]);
  assert.equal((await settled(r2id)).state, 'research-done');
  const started = engine.bus.since(0).filter((e) => e.type === 'run.start' && e.jobId === r2id && e.agentKey === 'demand-researcher');
  assert.equal(started[0].data.effort, 'high'); assert.equal(started[0].data.model, engine.cfg.engine.tiers.cheap.model);

  // scheduler: create (disabled) -> enable -> a fire starts a job from the next verified brief... none waits now
  const rt = (await post('/api/routines/create', { name: 'Morning line', target: 'line:room1-digital', schedule: '0 8 * * *' })).json.result;
  const en = await post('/api/routines/enable', { id: rt.id, expectedVersion: rt.version, enabled: true });
  assert.equal(en.status, 200); assert.ok(engine.scheduler.armed().includes(rt.id));
  const f1 = await engine.scheduler.fire(engine.store.getRoutine(rt.id));
  assert.equal(f1.skipped, 'no verified brief is waiting');
  const rtR = (await post('/api/routines/create', { name: 'Research', target: 'line:research', schedule: '0 7 * * *', perRunCapUsd: 0.25 })).json.result;
  await post('/api/routines/enable', { id: rtR.id, expectedVersion: rtR.version, enabled: true });
  const nResearch = engine.store.listJobs().filter((j) => j.kind === 'research').length;
  await engine.scheduler.fire(engine.store.getRoutine(rtR.id));
  const fired = engine.store.listJobs().filter((j) => j.kind === 'research');
  assert.equal(fired.length, nResearch + 1);
  assert.equal(fired.find((j) => j.data.routineId === rtR.id).data.runCapUsd, 0.25);

  // e-stop from the top bar, and resume
  assert.equal((await post('/api/engine/halt', { reason: 'office button' })).status, 200);
  s = await snap(); assert.equal(s.engine.halted, true); assert.equal(s.controls.haltVersion, engine.halt.state.at);
  assert.equal((await post('/api/engine/resume', { confirm: 'RESUME', expectedVersion: s.controls.haltVersion })).status, 200);

  // every write the controls made is inside the data root or the logs folder
  const inside = (f, root) => { const a = path.resolve(f).toLowerCase(), b = path.resolve(root).toLowerCase(); return a === b || a.startsWith(b + path.sep); };
  assert.ok(writes.length > 50, 'writes were recorded');
  const outside = writes.filter(([, f]) => !inside(f, r.dataRoot) && !inside(f, r.logs));
  assert.deepEqual(outside, [], 'writes outside data/: ' + JSON.stringify(outside.slice(0, 5)));
  assert.ok(engine.ledger.rows().every((x) => x.provider === 'mock' && x.usd === 0), 'all mock, $0');
});

test('Stop aborts a running job mid-call; Restart runs it again from the stopped step', async (t) => {
  const { engine, post, job, settled } = await boot(t, { mockDelayMs: 150, tag: 'stop' });
  assert.equal((await post('/api/tasks/brief', { file: JOB_A + '.md' })).status, 200);
  await until(() => job(JOB_A).state === 'running' && engine.store.runsOf({ jobId: JOB_A }).some((x) => x.status === 'running'), { timeout: 10000 });
  // the page loaded the job one step ago: a running job's version moves on, and Stop is still accepted
  const loaded = job(JOB_A).version;
  await until(() => job(JOB_A).version > loaded, { timeout: 10000 });
  const st = await post('/api/jobs/stop', { jobId: JOB_A, expectedVersion: loaded });
  assert.equal(st.status, 200, st.text);
  const stopped = await settled(JOB_A);
  assert.equal(stopped.state, 'stopped'); assert.match(stopped.reason, /stopped by the owner/);
  const calls = engine.providers.text.calls, rows = engine.ledger.totals.rows;
  await sleep(400);
  assert.equal(engine.providers.text.calls, calls, 'no further provider call'); assert.equal(engine.ledger.totals.rows, rows, 'no further ledger row');
  // once it is no longer running, an old version is stale again
  assert.equal((await post('/api/jobs/stop', { jobId: JOB_A, expectedVersion: loaded })).status, 409);
  const step = stopped.step;
  const rs = await post('/api/jobs/restart', { jobId: JOB_A, expectedVersion: stopped.version });
  assert.equal(rs.status, 200, rs.text); assert.equal(rs.json.result.step, step);
  assert.equal((await settled(JOB_A)).state, 'approval');
  assert.equal(job(JOB_A).data.restarts, 1);
  // a legacy job takes no control
  engine.store.upsertLegacyJob({ id: '2026-01-01--legacy-x', line: 'room1', state: 'blocked', created_at: 1, updated_at: 1 });
  assert.equal((await post('/api/jobs/restart', { jobId: '2026-01-01--legacy-x', expectedVersion: 1 })).status, 400);
});

test('the top bar\'s live spend: each cap with its use, a warning from 80% and "reached" at 100%', async (t) => {
  const { engine, snap } = await boot(t, { tag: 'caps' });
  const row = (usd, n) => engine.ledger.append({ entryId: 'test-cap-' + n, ts: Date.now(), jobId: null, runId: 'run_cap_' + n, agentKey: 'designer', line: 'room1-digital', provider: 'test', model: 'cheap-model', kind: 'text', usd, estimated: false, priceSource: 'test row' });
  let s = await snap();
  assert.deepEqual(s.spend.capStatus.map((c) => c.level), s.spend.capStatus.map(() => 'ok'));
  assert.ok(s.spend.capStatus.some((c) => c.cap === 'perDay' && c.limit === engine.cfg.engine.caps.perDayUsd), 'the day cap comes from config');
  row(8.5, 1);
  s = await snap();
  const day = s.spend.capStatus.find((c) => c.cap === 'perDay');
  assert.equal(day.level, 'warn'); assert.equal(day.pct, 85);
  assert.ok(s.warnings.some((w) => /^Cap warning: station day 8\.50 of 10\.00 USD \(85%\)/.test(w)), s.warnings.join(' | '));
  row(1.5, 2);
  s = await snap();
  assert.equal(s.spend.capStatus.find((c) => c.cap === 'perDay').level, 'hit');
  assert.ok(s.warnings.some((w) => /^CAP REACHED: station day/.test(w)));
});
