// engine-server.mjs — the Station server in engine mode: the page, the office JSON built from the engine's own state,
// the live event stream (SSE), and the engine's write actions. Bound to 127.0.0.1 only.
// Every write request must (ENGINE-PLAN.md §6): come from the page's own origin, carry the per-launch action token the
// page got from /api/session, send JSON and carry an idempotency key (x-idempotency-key: a repeat of the same key gets
// the first answer back and does nothing again, so a double click creates one job). Every action on an existing record
// sends the version the page loaded (expectedVersion); a stale tab gets "changed since you loaded it" (HTTP 409) and
// nothing is written. The one exception is pressing the E-STOP, which is never refused for being stale. Every write,
// and every refusal, is logged and emitted as an event (action.done / action.refused). All files are written by the
// engine through dataJail under the data root.
// The page never receives keys, prompts or provider responses.
// ext (demo mode only, scripts/demo.mjs): extra POST actions behind the same origin/token/JSON checks, and extra fields
// merged into each snapshot response. `handler` and `dispose` let the demo swap engines behind one listening server.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { send, sendJson, serveStatic } from './index.mjs';
import { buildEngineSnapshot } from './engine-model.mjs';
import { loadLegacy } from './legacy-view.mjs';
import { RESUME_WORD } from '../engine/halt.mjs';
import { composeOwnerBrief } from '../engine/lib/owner-brief-form.mjs';
import { issueFromForm } from '../engine/lib/eng-records.mjs';

const MAX_BODY = 16 * 1024;

// etsy (E7a): the own-shop Etsy connection (providers/etsy.mjs on live, the mock on dev), or { unavailable: reason }; the
// page reads GET /api/etsy (status, never a token) and connects, refreshes or disconnects through the POST actions below
export function createEngineServer({ engine, log, snapshotTtlMs = 300, ext = null, etsy = null }) {
  const token = crypto.randomBytes(24).toString('hex');   // per launch; only the page on our own origin can read it
  // R1 (locked rule owner-only-approver): this token is the owner's page session; the engine accepts a request decision, a line resume and
  // an owner pause only with it (requests.mjs). A server on a script engine has no session, so it cannot decide anything.
  const unregisterOwner = engine.requests && !engine.scriptRun ? engine.requests.registerOwnerSession(token) : () => {};
  const owner = { kind: 'owner', session: token };
  const hostLabel = 'Node ' + process.version + ' · ' + os.platform() + ' ' + os.release() + ' (station host)';
  let cache = { at: 0, seq: -1, snap: null };
  const clients = new Set();
  const thumbs = new Map();

  function snapshot(force = false) {
    const now = Date.now();
    if (!force && cache.snap && cache.seq === engine.bus.seq && now - cache.at < snapshotTtlMs * 20) return cache.snap;
    cache = { at: now, seq: engine.bus.seq, snap: buildEngineSnapshot(engine, { now, host: { label: hostLabel } }) };
    return cache.snap;
  }
  // SSE: every bus event goes to every page; a reconnecting page gets what it missed (Last-Event-ID)
  const unsub = engine.bus.subscribe((ev) => { for (const c of clients) writeEvent(c, ev); });
  function writeEvent(res, ev) { try { res.write('id: ' + ev.seq + '\nevent: ' + ev.type + '\ndata: ' + JSON.stringify({ seq: ev.seq, ts: ev.ts, type: ev.type, jobId: ev.jobId, agentKey: ev.agentKey, data: ev.data }) + '\n\n'); } catch (_) { clients.delete(res); } }
  const beat = setInterval(() => { for (const c of clients) { try { c.write(': beat\n\n'); } catch (_) { clients.delete(c); } } }, 15000); beat.unref();

  // R2c: the engineering controls answer the loopback address only (the server binds 127.0.0.1; this holds even behind a forwarder)
  const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes((req.socket && req.socket.remoteAddress) || '');
  const sameOrigin = (req) => { const host = req.headers.host || ''; const o = req.headers.origin; return !!o && (o === 'http://' + host) && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host); };
  function readBody(req) { return new Promise((resolve, reject) => { let n = 0; const parts = []; req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); }); req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('body is not JSON')); } }); req.on('error', reject); }); }

  // sub: files (the delivered PNGs), build (a packaged set's built PNGs; L2) or review (file 1 flattened on light and dark for the owner; L2)
  async function thumb(id, set, file, sub = 'files') {
    const key = id + '/' + set + '/' + sub + '/' + file; if (thumbs.has(key)) return thumbs.get(key);
    if (!/^\d{4}-\d{2}-\d{2}--[a-z0-9-]+$/.test(id)) return null;
    const f = path.join(engine.J.dataRoot, 'jobs', id, set, sub, file);
    if (!fs.existsSync(f)) return null;
    const { default: sharp } = await import('sharp');
    const buf = await sharp(f).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    thumbs.set(key, buf); if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value);
    return buf;
  }

  // imported legacy images (data/legacy/jobs/<id>/...), thumbnailed in memory only; the path must stay inside the job folder
  async function legacyThumb(id, rel) {
    const key = 'legacy/' + id + '/' + rel; if (thumbs.has(key)) return thumbs.get(key);
    const base = path.join(engine.J.dataRoot, 'legacy', 'jobs', id), f = path.resolve(base, rel);
    if (!f.startsWith(base + path.sep) || !fs.existsSync(f)) return null;
    const { default: sharp } = await import('sharp');
    const buf = await sharp(f, { limitInputPixels: 40000 * 40000 }).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    thumbs.set(key, buf); if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value);
    return buf;
  }
  function legacyCost(id) {
    const L = loadLegacy(engine.J.dataRoot); if (!L) return null;
    const rows = L.ledger.filter((r) => r.jobId === id);
    return { totalUsd: Math.round(rows.reduce((s, r) => s + r.usd, 0) * 1e7) / 1e7, rows: rows.length, byKind: { text: rows.length }, mock: false, legacy: true, note: 'legacy ledger rows attributed to this job; image cost not recorded' };
  }

  const O = engine.orchestrator, BY = 'owner (office)';
  const stale = (what) => Object.assign(new Error(what + ' changed since you loaded it'), { code: 'STALE' });
  const ver = (b) => (Number.isInteger(b.expectedVersion) ? b.expectedVersion : null);
  const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
  // L2: an action that can spend passes the spend gate first (src/engine/spend.mjs): the e-stop, the confirm token from /api/spend/quote,
  // the day caps now. It runs only after that; a refusal writes nothing.
  const spends = (action, fn) => (body, key) => { engine.spend.gate(action, body); return fn(body, key); };
  // the owner brief from the page's form: composed (lib/owner-brief-form.mjs), then saved through the same intake checks as the CLI
  function saveFormBrief(body) {
    const c = composeOwnerBrief({ title: body.title, theme: body.theme, audience: body.audience, items: Array.isArray(body.items) ? body.items.slice(0, 50).map((x) => str(x, 200)) : [], productKey: str(body.productKey, 80), ownerFile1: body.ownerFile1 === true, minUsd: body.minUsd, maxUsd: body.maxUsd }, { products: engine.cfg.products, cfg: engine.cfg.station });
    if (!c.ok) throw Object.assign(new Error('the owner brief needs: ' + c.problems.join('; ')), { code: 'BAD_REQUEST' });
    const r = O.saveOwnerBrief({ text: c.text, by: BY });
    if (!r.ok) throw Object.assign(new Error('the owner brief was refused at intake (nothing saved): ' + r.reasons.join('; ')), { code: 'INTAKE' });
    return { id: r.id, file: r.id + '.md', saved: r.file, changed: r.changed, warnings: r.warnings };
  }
  // R2c: the engineering line (engine.engineering): every call carries the owner's page session, and the engine refuses any other actor
  const E = () => { if (!engine.engineering) throw Object.assign(new Error('this engine has no engineering line'), { code: 'BAD_REQUEST' }); return engine.engineering; };
  const X = () => { if (!engine.execs) throw Object.assign(new Error('this engine has no executives'), { code: 'BAD_REQUEST' }); return engine.execs; };
  const noPromise = (r) => { if (!r || typeof r !== 'object') return r; const { promise, ...rest } = r; return rest; };
  // the owner's session is checked first, before the spend gate: a server without it (a script engine) refuses every engineering control
  const asOwner = (fn) => (body, key) => { if (!engine.requests || !engine.requests.isOwner(owner)) throw Object.assign(new Error('refused: only the owner, on the page, controls the engineering line and the executives (this server has no owner session)'), { code: 'LOCKED' }); return fn(body, key); };
  const ACTIONS = {
    // the e-stop: pressing it is never refused for a stale page; resuming needs the typed word and the current state
    'POST /api/engine/halt': (body) => engine.halt.press({ by: 'owner (office button)', reason: str(body.reason) }),
    'POST /api/engine/resume': (body) => { if (ver(body) !== (engine.halt.state.at || 0)) throw stale('the e-stop'); return engine.halt.resume({ by: 'owner (office, typed confirmation)', confirm: body.confirm }); },
    // the task box
    'POST /api/tasks/research': spends('research', (body) => O.startResearch(str(body.text, 4000), { by: BY })),
    'POST /api/tasks/brief': spends('start-line', (body, key) => O.startBrief(str(body.file), { by: BY, idempotencyKey: key })),
    'POST /api/tasks/rerun-listing': spends('rerun-listing', (body) => O.rerunListing(str(body.jobId), { expectedVersion: ver(body), by: BY })),
    // L2: an owner brief from the page's form (saving spends nothing; Start line is the spending step)
    'POST /api/tasks/owner-brief': (body) => saveFormBrief(body),
    // the scheduler (routines are created disabled; enabling is the approval)
    'POST /api/routines/create': (body) => engine.routines.create(body),
    'POST /api/routines/update': (body) => engine.routines.update(str(body.id), body, { expectedVersion: ver(body) }),
    // L2.1 (owner, 19/10/2026): arming a routine needs the confirm token like every spending action; disarming needs none
    'POST /api/routines/enable': (body) => (body.enabled === true && engine.spend.gate('routine-arm', body), engine.routines.enable(str(body.id), body.enabled === true, { expectedVersion: ver(body) })),
    'POST /api/routines/delete': (body) => engine.routines.remove(str(body.id), { expectedVersion: ver(body) }),
    // R1: the Owner's office: the owner decides a request (approve or reject, with the owner's words); nothing is sent anywhere. Pausing a
    // line is the COO's or the owner's; resuming it is the owner's only
    // R2c: a git.merge request of an engineering job is decided by the engineering line (the branch and the diff are checked first)
    'POST /api/requests/decide': (body) => { const id = str(body.id, 60), r = mergeRequestRow(id); if (r) return E().ownerDecide({ jobId: r.job_id, decision: str(body.decision, 20), words: str(body.words, 2000), requestVersion: ver(body) }, { actor: owner }).then(noPromise); return engine.requests.decide(id, { decision: str(body.decision, 20), words: str(body.words, 2000), expectedVersion: ver(body), actor: owner }); },
    'POST /api/lines/pause': (body) => engine.actions.pauseLine(str(body.line, 60), { actor: owner, reason: str(body.reason, 500) }),
    'POST /api/lines/resume': (body) => engine.actions.resumeLine(str(body.line, 60), { actor: owner, words: str(body.words, 2000) }),
    // the approval queue (B0's, the Etsy history): approvals and tracker rows only; nothing is sent anywhere
    'POST /api/approvals/decide': (body) => O.decide(str(body.jobId), { action: str(body.action, 20), reason: str(body.reason, 600), etsyUrl: str(body.etsyUrl, 300), publishedOn: str(body.publishedOn, 10), finalTitle: str(body.finalTitle, 200), finalPriceEur: body.finalPriceEur == null || body.finalPriceEur === '' ? null : Number(body.finalPriceEur), sku: str(body.sku, 40), expectedVersion: ver(body), by: BY }),
    // the owner's decisions and owner-started mechanical steps on a job (src/engine/owner.mjs; port batch 17/10/2026). Each checks the job's
    // version; an override applies only to a QA judgement verdict, never to the originality screen
    'POST /api/owner/file-decision': (body) => engine.owner.recordFileDecision(str(body.jobId), { set: Number(body.set), name: str(body.name, 100), decision: str(body.decision, 20), qaAgent: str(body.qaAgent, 20) || 'qa-design', qaPass: body.qaPass == null ? null : Number(body.qaPass), qaSaid: str(body.qaSaid, 2000), check: str(body.check, 40) || null, reason: str(body.reason, 2000), fix: str(body.fix, 2000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/owner/set-approval': (body) => engine.owner.approveSet(str(body.jobId), { set: Number(body.set), words: str(body.words, 2000), worthThePrice: body.worthThePrice && typeof body.worthThePrice === 'object' ? body.worthThePrice : null, rule: body.rule === 'post-fix' ? 'post-fix' : null, reviewedPreviews: Array.isArray(body.reviewedPreviews) ? body.reviewedPreviews.slice(0, 50).map((x) => str(x, 300)) : null, date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/owner/listing-approval': (body) => engine.owner.approveListing(str(body.jobId), { reason: str(body.reason, 2000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/owner/edit-set': (body) => engine.owner.editSet(str(body.jobId), { set: Number(body.set), plan: body.plan && typeof body.plan === 'object' ? body.plan : null, expectedVersion: ver(body) }),
    'POST /api/owner/fix-listing-text': (body) => engine.owner.fixListingText(str(body.jobId), { ownerWords: str(body.ownerWords, 2000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/owner/listing-photos': (body) => engine.owner.makeListingPhotos(str(body.jobId), { plan: body.plan && typeof body.plan === 'object' ? body.plan : null, expectedVersion: ver(body) }),
    'POST /api/owner/style-ref': (body) => engine.owner.styleRefDecision(str(body.jobId), { set: Number(body.set), status: str(body.status, 20), reason: str(body.reason, 1000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    // L2: an owner amendment (the frozen-inputs amendment record) and the owner's rejection of a set, from the job panel
    'POST /api/owner/amend': (body) => engine.owner.amendJob(str(body.jobId), { text: str(body.text, 8000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/owner/set-rejection': (body) => engine.owner.rejectSet(str(body.jobId), { set: Number(body.set), words: str(body.words, 2000), date: str(body.date, 10) || undefined, expectedVersion: ver(body) }),
    'POST /api/jobs/qa-only': spends('qa-only', (body) => O.qaOnly(str(body.jobId), { set: Number(body.set), maxUsd: Number(body.maxUsd), expectedVersion: ver(body), by: BY })),
    'POST /api/jobs/listing-only': spends('listing-only', (body) => O.listingOnly(str(body.jobId), { maxUsd: Number(body.maxUsd), expectedVersion: ver(body), by: BY })),
    'POST /api/jobs/package': (body) => O.packageJob(str(body.jobId), { expectedVersion: ver(body), by: BY }),
    // desk panels: on/off duty, tier, effort (applies at the next run)
    // back on duty starts the agent's waiting jobs: that can spend, so it passes the spend gate when there are any (under the e-stop nothing wakes)
    'POST /api/agents/update': (body) => (body.enabled === true && !engine.halt.isHalted() && engine.spend.gate('agent-on-duty', body), engine.updateAgent(str(body.agentKey, 60), { enabled: body.enabled, tier: body.tier, effort: body.effort }, { expectedVersion: ver(body) })),
    // job panel and board
    'POST /api/jobs/stop': (body) => O.stopJob(str(body.jobId), { expectedVersion: ver(body), by: BY }),
    'POST /api/jobs/restart': spends('restart', (body) => O.restartJob(str(body.jobId), { expectedVersion: ver(body), by: BY })),
    'POST /api/jobs/archive': (body) => O.archiveJob(str(body.jobId), { expectedVersion: ver(body), by: BY }),
    // R2c: the Engineering panel (owner only): issues, the CTO's triage, a start, Stop, and the decision on a finished job. Triage, start,
    // resume and rework can spend, so they pass the spend gate (the confirm token from /api/spend/quote) first
    'POST /api/eng/issue': asOwner((body) => E().writeIssue({ productId: str(body.productId, 60), ...issueFromForm({ title: str(body.title, 200), happens: str(body.happens, 3000), should: str(body.should, 3000), where: str(body.where, 1000), acceptance: str(body.acceptance, 4000), model: str(body.model, 20) || 'default' }) }, { actor: owner })),
    'POST /api/eng/issue-decide': asOwner((body) => E().decideIssue({ productId: str(body.productId, 60), issueId: str(body.issueId, 100), decision: str(body.decision, 20), words: str(body.words, 2000) }, { actor: owner })),
    'POST /api/eng/triage': asOwner(spends('eng-triage', (body) => noPromise(E().startTriage({ productId: str(body.productId, 60), by: BY }, { actor: owner })))),
    'POST /api/eng/start': asOwner(spends('eng-start', (body) => noPromise(E().startIssue({ productId: str(body.productId, 60), issueId: str(body.issueId, 100), by: BY }, { actor: owner })))),
    'POST /api/eng/stop': asOwner((body) => E().stop(str(body.jobId, 120), { expectedVersion: ver(body) })),
    'POST /api/eng/resume': asOwner(spends('restart', (body) => E().resume(str(body.jobId, 120), { expectedVersion: ver(body), by: BY }))),
    'POST /api/eng/archive': asOwner((body) => E().archive(str(body.jobId, 120), { expectedVersion: ver(body) })),
    'POST /api/eng/decide': asOwner(async (body) => { const decision = str(body.decision, 20); if (decision === 'rework') engine.spend.gate('eng-rework', body); return noPromise(await E().ownerDecide({ jobId: str(body.jobId, 120), decision, words: str(body.words, 2000), expectedVersion: ver(body) }, { actor: owner })); }),
    // R3: the executives (owner only, localhost): the COO's report or the CEO's memo now (each can spend: the spend gate first), and the
    // owner's mark on a proposal (taken, declined or later: a note on a document, it approves or starts nothing)
    'POST /api/exec/coo-report': asOwner(spends('coo-report', () => noPromise(X().start('coo', { by: BY }, { actor: owner })))),
    'POST /api/exec/ceo-memo': asOwner(spends('ceo-memo', () => noPromise(X().start('ceo', { by: BY }, { actor: owner })))),
    'POST /api/exec/proposal-mark': asOwner((body) => X().markProposal({ week: str(body.week, 20), proposal: str(body.proposal, 8), mark: str(body.mark, 10), words: str(body.words, 500) }, { actor: owner })),
    // E7a: the own-shop Etsy connection (read scopes only; nothing is written to Etsy and nothing spends)
    'POST /api/etsy/connect/start': () => etsyClient().startConnect(),
    'POST /api/etsy/connect/finish': (body) => etsyClient().finishConnect(str(body.pasted, 4000)),
    'POST /api/etsy/listings': () => etsyClient().listings({ force: true }).then(() => etsyClient().status()),
    'POST /api/etsy/disconnect': () => etsyClient().disconnect(),
    ...((ext && ext.actions) || {})
  };
  // a pending or approved git.merge request of an engineering job, or null (any other request is decided by requests.mjs as before)
  function mergeRequestRow(id) {
    if (!engine.engineering || !engine.store.hasProductColumns()) return null;
    const r = engine.requests.get(id), j = r && r.job_id ? engine.store.getJob(r.job_id) : null;
    return r && r.action === 'git.merge' && j && j.kind === 'engineering' ? r : null;
  }
  function etsyClient() {
    if (!etsy || etsy.unavailable) throw Object.assign(new Error('Etsy is not available on this Station: ' + ((etsy && etsy.unavailable) || 'no Etsy client')), { code: 'ETSY_UNAVAILABLE' });
    return etsy;
  }
  const etsyStatus = () => (!etsy ? { available: false, reason: 'no Etsy client', notice: (engine.cfg.engine.etsy || {}).notice || null }
    : etsy.unavailable ? { available: false, reason: etsy.unavailable, notice: (engine.cfg.engine.etsy || {}).notice || null }
      : { available: true, instance: engine.instance ? engine.instance.name : null, ...etsy.status() });
  // a refusal or a done action: logged, and emitted so every open page refreshes
  const audit = (ok, p, data) => { try { engine.bus.emit(ok ? 'action.done' : 'action.refused', { jobId: data.jobId || null, agentKey: data.agentKey || null, data: { action: p, ...data } }); } catch (_) { /* bus closed */ } };
  const refuse = (res, p, status, error, extra = {}) => { log.warn('write refused', { path: p, status, error, ...extra }); audit(false, p, { status, error, ...extra }); return sendJson(res, { error, code: extra.code || null }, status); };
  const inFlight = new Map();   // idempotency key -> promise of the first request's answer (a double click arrives together)

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'POST') {
        const act = ACTIONS['POST ' + p];
        if (!act && p !== '/api/spend/quote') return sendJson(res, { error: 'unknown action' }, 404);
        if ((p.startsWith('/api/eng/') || p.startsWith('/api/exec/')) && !loopback(req)) return refuse(res, p, 403, 'localhost only', { remote: (req.socket && req.socket.remoteAddress) || null });
        if (!sameOrigin(req)) return refuse(res, p, 403, 'same-origin requests only', { origin: req.headers.origin || null });
        if (req.headers['x-station-action'] !== token) return refuse(res, p, 403, 'missing or stale action token: reload the page', { token: req.headers['x-station-action'] ? 'wrong' : 'missing' });
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return refuse(res, p, 415, 'JSON only');
        const key = String(req.headers['x-idempotency-key'] || '');
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return refuse(res, p, 400, 'missing idempotency key (x-idempotency-key)');
        let body;
        try { body = await readBody(req); } catch (e) { return refuse(res, p, 400, e.message); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(res, p, 400, 'body must be a JSON object');
        // L2: the spend quote and its confirm token; writes nothing, so it is not kept for idempotency (a token is single use)
        if (p === '/api/spend/quote') { try { return sendJson(res, { ok: true, result: engine.spend.quote(str(body.action, 40), body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {}) }); } catch (e) { return refuse(res, p, 400, e.message, { code: e.code || null }); } }
        const ik = 'action:' + p + ':' + key;
        // a repeat: the same answer again, nothing done twice (in flight, or already recorded)
        if (inFlight.has(ik)) { const prev = await inFlight.get(ik); log.info('action repeat (idempotent)', { path: p, key }); return sendJson(res, { ...prev.body, replayed: true }, prev.status); }
        const done = engine.store.idem.get(ik);
        if (done) { log.info('action repeat (idempotent)', { path: p, key }); return sendJson(res, { ok: true, result: done.result, replayed: true }); }
        const run = (async () => {
          try {
            const out = await act(body, key);
            engine.store.idem.put(ik, { result: out ?? null, at: Date.now() });
            const who = { jobId: (out && out.jobId) || body.jobId || null, agentKey: body.agentKey || null };
            log.info('action', { path: p, key, ...who }); audit(true, p, who);
            return { status: 200, body: { ok: true, result: out ?? null } };
          } catch (e) {
            const status = e.code === 'STALE' ? 409 : e.code === 'HALTED' ? 423 : e.code === 'CONFIRM_REQUIRED' ? 428 : e.code === 'DAY_CAP' ? 422 : e.code === 'LOCKED' ? 403 : 400;
            const error = e.code === 'STALE' ? 'Not saved: ' + e.message.replace(/ \(version .*\)$/, '') + '. The page has been refreshed; check it and try again.' : e.message;
            log.warn('action refused', { path: p, key, status, error: e.message }); audit(false, p, { status, error, code: e.code || null, jobId: body.jobId || null });
            return { status, body: { error, code: e.code || null } };
          }
        })();
        inFlight.set(ik, run);
        try { const r = await run; return sendJson(res, r.body, r.status); } finally { inFlight.delete(ik); }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
      if (p === '/api/session') {
        // the token goes only to a same-origin page request (a cross-site page cannot read it)
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return sendJson(res, { error: 'same-origin only' }, 403);
        return sendJson(res, { actionToken: token, resumeWord: RESUME_WORD });
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const last = Number(req.headers['last-event-id'] || url.searchParams.get('since') || NaN);
        if (Number.isFinite(last)) for (const ev of engine.bus.since(last)) writeEvent(res, ev);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/office/health') { const g = engine.guard.status(); const inst = engine.instance || null; return sendJson(res, { ok: true, view: 'engine', instance: inst ? inst.name : null, commit: inst ? inst.commit : null, provider: engine.providers.mode, halted: engine.halt.isHalted(), jobsRunning: engine.store.listJobs({ states: ['running'] }).length, ledgerOk: g.ledgerOk, spentToday: g.spentToday, inFlight: g.inFlight, seq: engine.bus.seq, logs: log.counts, uptimeS: Math.round(process.uptime()) }); }
      if (p === '/api/office/snapshot') return sendJson(res, ext && ext.snapshotExtra ? { ...snapshot(url.searchParams.has('fresh')), ...ext.snapshotExtra() } : snapshot(url.searchParams.has('fresh')));
      if (p === '/api/office/ledger' && url.searchParams.get('source') === 'legacy') { const L = loadLegacy(engine.J.dataRoot); const all = L ? L.ledger : []; const rows = all.slice(-Math.min(500, Number(url.searchParams.get('limit')) || 100)).reverse().map((r) => ({ at: r.ts, agent: r.agentName || r.legacyAgentId, runId: r.runId, jobId: r.jobId, model: r.model, provider: r.provider, kind: r.kind, tokens: r.tokens ?? null, usd: r.usd, legacy: true })); return sendJson(res, { total: all.length, usd: L ? L.ledgerUsd : 0, rows, source: 'data/legacy/ledger.jsonl (imported legacy history; not in the engine caps)' }); }
      if (p === '/api/office/ledger') { const rows = engine.ledger.rows().slice(-Math.min(500, Number(url.searchParams.get('limit')) || 100)).reverse().map((r) => ({ at: r.ts, agent: r.agentKey, runId: r.runId, jobId: r.jobId, model: r.model, provider: r.provider, kind: r.kind, tokens: r.tokens ? r.tokens.in + r.tokens.out : null, usd: r.usd, estimated: !!r.estimated })); return sendJson(res, { total: engine.ledger.totals.rows, rows, source: engine.ledger.label }); }
      let m;
      if ((m = /^\/api\/office\/jobs\/([^/]+)$/.exec(p))) { const job = snapshot().jobs.find((j) => j.id === m[1]); if (!job) return sendJson(res, { error: 'no such job' }, 404); const cost = job.kind === 'research' ? null : job.kind === 'legacy' ? legacyCost(job.id) : engine.orchestrator.costRecord(job.id); return sendJson(res, { ...job, cost: cost && { totalUsd: cost.totalUsd, rows: cost.rows, byKind: cost.byKind, mock: cost.mock } }); }
      if ((m = /^\/api\/office\/agents\/([^/]+)$/.exec(p))) { const s = snapshot(); const a = s.agents.find((x) => x.id === m[1]); if (!a) return sendJson(res, { error: 'no such agent' }, 404); const runs = engine.store.runsOf({ agentKey: a.id, limit: 12 }).map((r) => ({ at: r.ended_at || r.started_at, title: (r.step || '') + ' pass ' + (r.pass || 1) + ' · ' + (r.job_id || ''), reason: r.status === 'done' ? 'done' : r.status, usd: r.usd, tokens: r.tokens_in + r.tokens_out, durationMs: r.ended_at ? r.ended_at - r.started_at : null, failureCode: ['failed', 'cap', 'refused'].includes(r.status) ? r.status : null })); const jobs = a.recentJobs.map((id) => s.jobs.find((j) => j.id === id)).filter(Boolean); return sendJson(res, { ...a, runs, jobs }); }
      if ((m = /^\/api\/office\/image\/job\/([^/]+)\/(set-v\d+)\/(?:(build|review)\/)?([a-z0-9][a-z0-9._-]*\.(?:png|jpg))$/.exec(p))) { const buf = await thumb(m[1], m[2], m[4], m[3] || 'files'); return buf ? send(res, 200, buf, 'image/png', { 'Cache-Control': 'public, max-age=60' }) : send(res, 404, 'no such image', 'text/plain'); }
      if ((m = /^\/api\/office\/image\/legacy\/(\d{4}-\d{2}-\d{2}--[a-z0-9-]+)\/((?:work|package|rejected)\/[a-z0-9][a-z0-9._/-]*\.png)$/.exec(p)) && !m[2].includes('..')) { const buf = await legacyThumb(m[1], m[2]); return buf ? send(res, 200, buf, 'image/png', { 'Cache-Control': 'public, max-age=300' }) : send(res, 404, 'no such image', 'text/plain'); }
      if (p === '/api/etsy') return sendJson(res, etsyStatus());
      // R2c: the Engineering panel's reads: localhost, same origin, and the owner's page session (the action token), like a write
      if (p.startsWith('/api/eng/') || p.startsWith('/api/exec/')) {
        if (!loopback(req)) return refuse(res, p, 403, 'localhost only', { remote: (req.socket && req.socket.remoteAddress) || null });
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return refuse(res, p, 403, 'same-origin requests only');
        if (req.headers['x-station-action'] !== token || !engine.requests || !engine.requests.isOwner(owner)) return refuse(res, p, 403, "only the owner's page session: reload the page", { token: req.headers['x-station-action'] ? 'wrong' : 'missing' });
        if (p === '/api/eng/view') return sendJson(res, E().view());
        // R3: one earlier report or memo (the Owner's office lists them)
        if ((m = /^\/api\/exec\/(coo|ceo)\/([0-9A-Z-]{7,14})$/.exec(p))) { const d = X().record(m[1], m[2]); return d ? sendJson(res, d) : sendJson(res, { error: 'no such record' }, 404); }
        if ((m = /^\/api\/eng\/job\/([a-z0-9][a-z0-9-]{2,120})$/.exec(p))) { const d = await E().jobDetail(m[1]); return d ? sendJson(res, d) : sendJson(res, { error: 'no such engineering job' }, 404); }
        return sendJson(res, { error: 'unknown route' }, 404);
      }
      if (p.startsWith('/api/')) return sendJson(res, { error: 'unknown route' }, 404);
      return serveStatic(res, p);
    } catch (e) {
      log.error('request failed', { path: p, error: String(e && e.stack || e) });
      return sendJson(res, { error: 'server error', detail: String(e && e.message || e) }, 500);
    }
  };
  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
  const closeAll = () => { for (const c of clients) { try { c.end(); } catch (_) {} } clients.clear(); };
  const dispose = () => { clearInterval(beat); unsub(); closeAll(); unregisterOwner(); };
  server.on('close', dispose);
  return { server, handler, snapshot, token, closeAll, dispose };
}
