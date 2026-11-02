// orchestrator.mjs — runs the lines written in config/lines/*.json (ENGINE-PLAN.md §3). A job moves step by step;
// every move is written to SQLite (job row + stage row, one transaction) before its event goes out.
//   agent steps       one run of one agent (runtime.mjs); QA steps route on the verdict from submit_verdict (one channel)
//   mechanical steps  station code, no model, no cost, fail closed: intake, prep, price fill, package gate, package
//   loops             design: max 2 sends back (3 reviews), then REJECTS-DESK; listing: max 1, then REJECTS-DESK (owner Q4)
//   hops              agent steps entered outside a loop count; maxHops from the line; a non-loop re-entry is refused
// No job starts from a file appearing anywhere: only startJob() (the owner's click, an enabled routine, or a re-run).
// One job per line at a time (owner Q12); a second one waits in `queued`.
// E5 (the live office): the owner's Stop, Restart (from the failed step, within the caps), Archive (files moved to
// rerun-archive-*, never deleted) and Re-run listing; an off-duty agent's step waits in `queued` until it is back on duty;
// the owner's approval decisions write only the approvals and tracker rows.
// E6 c0, the style-reference set (products.json styleReference.ownerOk; owner decisions 17/10/2026: QA first, then the owner;
// DESIGNER's maxImages unchanged): the designer step of such a product runs in two phases.
//   first file  DESIGNER draws ONLY file 1 (set-vN/raw/01-<subject>.png); the station builds it as delivered (clean-up, the pinned
//               Real-ESRGAN, padding) and flattens it on light and dark (lib/style-ref.mjs makeReviewImages); QA-DESIGN checks file 1
//               (verdict kind "file1"). A revise, a file 1 that was not made (e.g. a content refusal) or one that cannot be built is a
//               failed attempt: file 1 is drawn again, in a new set, before any other file, within the design loop limit (then
//               REJECTS-DESK). Approved (the file-1 gate, owner 18/10/2026): the QA pass is file 1's approval (style-ref.json, decidedBy
//               qa-design) and the rest of the set follows in the same step, without a pause. A job whose brief or routine sets
//               "ownerFile1": true (job.data.ownerFile1) keeps the manual pause: it waits (queued, waitingFor owner-style-ref) for the
//               owner's decision (npm run owner style-ref; then resume). An owner rejection sends its reason to the next first-file run.
//   rest of set after the owner's approval: DESIGNER draws files 2..N in batches that fit its maxImages (2 spare per batch for
//               regenerations), each image sent with the approved file 1 as the style reference (tools/index.mjs); prep then copies
//               the approved file 1 into raw/ and builds the set as before.
//   W2 (owner, 20/10/2026) after a QA DESIGN revise, only the files the verdict names (and any a build warning names) are redrawn; the
//               rest are copied into the new set unchanged (set-vN/rework.json). The set being drawn is recorded on the job
//               (data.designSet): a Resume after a run failed or was stopped mid-pass carries on that set from the first file not yet done.
//   L3 (owner, 21/10/2026) QA DESIGN's revise names the files to redraw as file ids in its record ("redraw": NN-subject), checked against
//               the set (tools submit_verdict, refused back once); a revise that still names none blocks the job for the owner: W2's
//               whole-set redraw is gone.
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, effectiveAgent } from './runtime.mjs';
import { VersionConflict } from './store/db.mjs';
import { checkBrief, briefField } from './lib/brief-check.mjs';
import { prepareDigitalSet, latestSet, manifestRel } from './lib/digital-prep.mjs';
import { buildDigitalSet, isPackaged, productFor, processFile } from './lib/digital-build.mjs';
import { usesStyleRef, approvedRef, ensureStyleRefInSet, readStyleRef, firstFileOf, fileOneVersion, makeReviewImages, recordDecision } from './lib/style-ref.mjs';
import { esrganUpscaler } from './lib/esrgan.mjs';
import { packageDigital } from './lib/package-digital.mjs';
import { designSignOff } from './lib/owner-approval.mjs';
import { setDecisionState } from './lib/set-decision.mjs';
import { foreignDataHits } from './business.mjs';
import { readJsonSafe, designPasses } from './lib/gates.mjs';
import { fillDigitalPrices } from './lib/digital-prices.mjs';
import { checkPackage } from './lib/gates.mjs';
import { isListingId, sha256, sha256File } from './lib/common.mjs';
import { hitLine, listingFields } from './lib/originality.mjs';
import { publicView } from './lib/digital-files.mjs';
import { canonicalDesignFile } from './tools/index.mjs';
import { COLUMNS as LEGACY_COLUMNS } from '../lib/legacy-readers/tracker.mjs';
import { dublinDay } from './time.mjs';
import { validateNotes, blocklistFromNotes, readDayNotes, scoutingBriefProblems, isScoutBrief, notesFile, notesRel, SCOUT_DIR, draftsDirOf, commonWords, commonWordWarnings, commonWordNote, pruneScouting, RETENTION_DAYS } from './lib/scouting.mjs';
import { checkScoutBrief, validateScoutBrief, priceStringProblems, hiddenRowProblems, briefFloorUsd, STATION_CITATIONS_RE, stationCitationLine, isIndicativeBrief, ownerSetsPriceOf, isLegacyBrief, LEGACY_BRIEF_REASON } from './lib/scout-brief.mjs';
import { returnedUrls, returnedPrices, searchPrices, urlsIn } from './lib/web-sources.mjs';
import { isOwnerBrief, checkOwnerBrief, OWNER_STATUS } from './lib/owner-brief.mjs';
import { briefFileProblems, briefFileList } from './lib/brief-files.mjs';
import { strictCleanFile, writeFlattened, writeAfterPreviews } from './lib/strict-cleanup.mjs';
import { stationPlan, withStationPlan, keptSections } from './lib/design-plan.mjs';
import { freezeInputs, readInputs, amendmentsNote, amendmentRefs } from './lib/job-inputs.mjs';
import { EXEC_KINDS } from './lib/exec-inputs.mjs';

// the listing record: the legacy listings.csv columns, with print_files renamed deliverables (ENGINE-PLAN.md §4.1)
export const TRACKER_COLUMNS = LEGACY_COLUMNS.map((c) => (c === 'print_files' ? 'deliverables' : c));
export const TERMINAL = ['approval', 'blocked', 'rejected', 'stopped', 'approved', 'rejected_by_owner', 'published', 'parked', 'retired', 'research-done'];

// Mark published (W2, owner 20/10/2026): Etsy's country links (https://www.etsy.com/<two-letter country>/listing/<id>/..., e.g. /ie/,
// /es/) are taken and stored as https://www.etsy.com/listing/<id>/...; anything else that is not an Etsy listing URL -> null
export function etsyListingUrl(u) {
  const m = /^https:\/\/(?:www\.)?etsy\.com\/(?:[a-z]{2}\/)?listing\/(\d+)([\w/?=&.%-]*)$/i.exec(String(u || '').trim());
  return m ? 'https://www.etsy.com/listing/' + m[1] + m[2] : null;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const niche = (t) => { const m = /^# Niche\s*\n([^\n]+)/m.exec(t || ''); return m ? m[1].trim() : ''; };
const titleOf = (id) => id.slice(12).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// R1 (owner, 22/10/2026; RESTRUCTURE.md §8 R1): this orchestrator is the Etsy line's, frozen with the Etsy archive. Every job creation and
// start asks engine.lineHold first: an archived line (outside the mock-only archive sandbox) or a line the COO or the owner paused starts
// nothing, with the reason. New departments' lines get their own module from R2.
export function createOrchestrator(engine, { hooks = {} } = {}) {
  const { store, bus, log, cfg, J, halt, ledger } = engine;
  // observer hooks (the dry run's screenshots): a failing hook is logged and never changes the job
  const callHook = async (name, arg) => { if (!hooks[name]) return; try { await hooks[name](arg); } catch (e) { log.warn('hook failed (ignored)', { hook: name, error: e.message }); } };
  const dataRoot = J.dataRoot;
  const jobDir = (id) => path.join(dataRoot, 'jobs', id);
  const active = new Map();   // line id -> { jobId, promise }
  const stops = new Map();    // job id -> AbortController (the owner's Stop on a running job)
  const isActive = (id) => [...active.values()].some((a) => a.jobId === id);
  // R2: engineering and CTO-triage jobs belong to the engineering line (engineering.mjs): this orchestrator hands them over and never runs
  // them; the running-jobs limit counts both
  // R3: and the executives' jobs (the COO's report, the CEO's memo: execs.mjs), which run through the same side-line runner
  const engJob = (j) => !!j && (j.kind === 'engineering' || j.kind === 'eng-triage' || EXEC_KINDS.includes(j.kind));
  const engCount = () => (engine.engineering ? engine.engineering.activeCount() : 0);
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  // the brief check everywhere a brief is judged (research brief-check, intake): the ported checks, then the scouting
  // screen of the WHOLE brief (scouted game names; derivative wording in a genre-scout brief). warnings: a scouted
  // common-word title used as a bare word (never a fail)
  const researchDir = () => path.join(dataRoot, 'research');
  // E6 b2 (owner D1/D3): a genre-scout brief is judged on the genre brief schema with "indicative" evidence instead of
  // the ported Etsy demand-evidence format, and every URL in it must be one the scout job's web calls returned: at
  // brief-check the running job's transcript (citationsJob); at intake the job named in the station's citation line
  // (no line or no transcript: refused, fails closed)
  const transcriptOf = (id) => path.join(dataRoot, 'jobs', id, 'transcript.jsonl');
  function checkBriefAll(t, { citationsJob = null, productKey = null } = {}) {
    let c;
    // owner decision 5 (17/10/2026): an owner brief claims no demand evidence (level "owner"); its own schema, the originality
    // screen of the whole brief, the image policy and the owner bounds against the floor (lib/owner-brief.mjs), then the
    // scouting screen below like every brief
    if (isOwnerBrief(t)) c = checkOwnerBrief(t, { products: cfg.products, cfg: cfg.station });
    // E7a (owner decision 1, 19/10/2026): the research line's briefs (origin research) are indicative too, judged the same way
    else if (isIndicativeBrief(t)) {
      const jid = citationsJob || ([...t.matchAll(new RegExp(STATION_CITATIONS_RE.source, 'gm'))].pop() || [])[2] || null;   // the last one: brief-check appends it
      const tf = jid && isListingId(jid) ? transcriptOf(jid) : null;
      // owner, 17/10/2026 ("prices as shown"): every price figure must be one the job's web calls returned, too
      c = tf && fs.existsSync(tf) ? checkScoutBrief(t, { products: cfg.products, cfg: cfg.station, returned: returnedUrls(tf), returnedPrices: returnedPrices(tf), searches: searchPrices(tf), productKey })
        : { ok: false, reasons: ['citations: no transcript to check them against (' + (jid ? 'job ' + jid + ' has none' : 'no station citation line from brief-check') + ')'], key: briefField(t, 'product_type') };
    } else c = checkBrief(t, { products: cfg.products, cfg: cfg.station });
    const sp = scoutingBriefProblems(t, cfg.station), warnings = commonWordWarnings({ brief: t }, commonWords(researchDir()));
    // B0 building rule: another company's data never enters the Station (config/building.json foreignDataMarkers)
    const fd = foreignDataHits(t, cfg); if (fd.length) sp.push('refused by a building rule: the brief names another company (' + fd.join(', ') + '); its data never enters the Station');
    return sp.length ? { ...c, ok: false, reasons: [...(c.ok ? [] : c.reasons), ...sp], warnings } : { ...c, warnings };
  }
  // the listing's bare common-word uses (owner 17/10/2026: the gate warns, QA-LISTING checks the context)
  function listingWordWarnings(job) {
    const L = readJson(path.join(jobDir(job.id), 'outbox', 'listing.json'));
    return L ? commonWordWarnings(listingFields(L), commonWords(researchDir())) : [];
  }
  function qaListingWordNote(job) {
    const w = listingWordWarnings(job); if (!w.length) return '';
    log.info('QA-LISTING told to check a common-word use', { jobId: job.id, warnings: w });
    return '\n\n' + commonWordNote(w);
  }
  function lineOf(id) { const l = cfg.lines[id]; if (!l) throw new Error('no such line: ' + id); return l; }
  function trackerRow(job, patch) {
    const cur = store.getTracker(job.id) || {};
    const brief = readBrief(job.id);
    const row = { ...Object.fromEntries(TRACKER_COLUMNS.map((c) => [c, ''])), ...cur, listing_id: job.id, room: job.line, niche: niche(brief), product_key: job.product_key || '', brief_date: job.id.slice(0, 10), cost_usd: String(ledger.spent.job(job.id).toFixed(6)), updated_at: new Date().toISOString(), ...patch };
    delete row.legacy;
    store.upsertTracker(job.id, row);
  }
  // frozen job inputs (owner, 18/10/2026; lib/job-inputs.mjs): a job's brief and product spec come from its snapshot once it has one
  const snapshotOf = (id) => { const r = readInputs(dataRoot, id); return r.ok && r.frozen ? r : null; };
  const topBrief = (id) => { try { return fs.readFileSync(path.join(jobDir(id), 'brief.md'), 'utf8'); } catch (_) { return null; } };
  const readBrief = (id) => { const sn = snapshotOf(id); return sn ? sn.brief : (topBrief(id) || ''); };
  const productsOf = (id) => { const sn = snapshotOf(id); return sn ? sn.products : cfg.products; };
  // before every step of a line job: the snapshot intact, and brief.md (read by the ported gates) the same text as the frozen brief
  function inputsProblem(id) {
    const r = readInputs(dataRoot, id); if (!r.ok) return r.reason; if (!r.frozen) return null;
    return topBrief(id) === r.brief ? null : 'jobs/' + id + '/brief.md differs from the frozen brief (inputs/brief.md): a running job\'s brief is never edited; restore brief.md and record the change as an owner amendment (npm run owner -- amend ' + id + ' --from <file.json>)';
  }
  // what a QA record says it was judged against: the snapshot and every owner amendment (owner, 18/10/2026)
  function inputsRef(id) { const sn = snapshotOf(id); return { snapshot: sn ? { brief: sn.record.brief.sha256, products: sn.record.products.sha256, frozenAt: sn.record.frozenAt } : null, amendments: amendmentRefs(dataRoot, id) }; }
  function freezeJob(job, note = null) {
    const r = freezeInputs({ J, roomDir: dataRoot, id: job.id, briefText: topBrief(job.id) || '', products: cfg.products, productKey: job.product_key, by: 'station', note, log });
    if (!r.ok) log.warn('job inputs not frozen', { jobId: job.id, reason: r.reason });
    return r;
  }

  // ---- state changes: written first, event after
  function setJob(id, patch, event, data = {}) {
    const j = store.updateJob(id, patch);
    if (event) bus.emit(event, { jobId: id, agentKey: data.agentKey || null, data: { state: j.state, step: j.step, reason: j.reason, ...data } });
    return j;
  }
  function block(job, reason, { state = 'blocked', ...extra } = {}) {
    log.warn('job ' + state, { jobId: job.id, step: job.step, reason });
    const j = setJob(job.id, { state, reason, ended_at: Date.now() }, 'job.blocked', { ...extra, ...(state !== 'blocked' ? { incomplete: true } : {}) });
    if (job.kind !== 'research') trackerRow(j, { status: state, status_reason: reason });
    return j;
  }

  // owner, 18/10/2026 (DECISIONS.md "E6 step c: redraw-only mode, cleanup pass, mock guard"): the mock provider never runs an agent on
  // a job with live spend (its scripted replies would be recorded as the job's work). Run modes that run an agent and a restart are
  // refused up front; runSteps stops any other start before its first agent step
  const mockOnLive = (id) => !!(engine.providers && engine.providers.mode === 'mock') && ledger.rowsForJob(id).some((r) => r.provider && r.provider !== 'mock');
  function mockGuard(id, what) {
    if (!mockOnLive(id)) return;
    const e = new Error(what + ' refused: job ' + id + ' has live spend and this engine runs the mock provider (its replies would be recorded as the job\'s work); run it live, as a per-process override (npm run line:live)');
    e.code = 'MOCK_ON_LIVE'; throw e;
  }

  // ---- intake: a verified brief becomes a job (or is refused with its reasons; no job is created then)
  // ownerFile1 (owner, 18/10/2026): true keeps the owner's pause after QA DESIGN passes file 1; set by the brief ("ownerFile1: true" in its
  // front matter) or by the routine that starts the job
  function createJob({ briefText, line = 'room1-digital', by = 'owner', idempotencyKey = null, ownerFile1 = false }) {
    if (idempotencyKey) { const prev = store.idem.get('createJob:' + idempotencyKey); if (prev) return prev; }
    const L = lineOf(line), t = String(briefText || '').replace(/\r\n/g, '\n'), id = briefField(t, 'id'), reasons = [];
    const hold = engine.lineHold ? engine.lineHold(L.id) : null;
    if (hold) { log.warn('intake refused a brief: the line cannot start', { id, line: L.id, hold, by }); return { ok: false, id, reasons: [hold], code: /^archived/.test(hold) ? 'ARCHIVED' : 'PAUSED' }; }
    // E7a.1 (owner decision 4, 20/10/2026): only an indicative or an owner brief starts a job; a legacy one is refused with the one reason
    if (isLegacyBrief(t)) { log.warn('intake refused a brief', { id, reasons: [LEGACY_BRIEF_REASON], by }); return { ok: false, id, reasons: [LEGACY_BRIEF_REASON] }; }
    if (!isListingId(id)) reasons.push('the brief has no valid id (YYYY-MM-DD--slug)');
    const wantStatus = isOwnerBrief(t) ? OWNER_STATUS : 'verified';   // an owner brief is the owner's, never "verified" by the Evidence Checker
    if (briefField(t, 'status') !== wantStatus) reasons.push('the brief status is "' + (briefField(t, 'status') || 'missing') + '", not "' + wantStatus + '"');
    const chk = checkBriefAll(t);
    if (!chk.ok) reasons.push(...chk.reasons);
    if (id && store.getJob(id)) reasons.push('a job with id ' + id + ' already exists (a re-run needs a new -rN id)');
    if (reasons.length) { log.warn('intake refused a brief', { id, reasons, by }); return { ok: false, id, reasons }; }
    const job = store.tx(() => {
      const j = store.insertJob({ id, line, kind: 'line', title: titleOf(id), product_key: chk.key, state: 'queued', step: L.start, data: { createdBy: by, brief: 'jobs/' + id + '/brief.md', ownerFile1: ownerFile1 === true || briefField(t, 'ownerFile1') === 'true' } });
      const sid = store.openStage(id, 'intake', 1); store.closeStage(sid, 'done', isOwnerBrief(t) ? 'owner brief checked (evidence level owner: no market evidence): format, product, originality of the whole brief, scouting blocklist, image policy, owner bounds against the floor' : 'brief checked: demand evidence, keyword sources, product, originality, image policy, price');
      return j;
    });
    J.put(path.join(jobDir(id), 'brief.md'), t);
    freezeJob(job);
    bus.emit('job.created', { jobId: id, data: { line, title: job.title, product: chk.key, by } });
    log.info('job created', { id, line, product: chk.key, by });
    const out = { ok: true, id, job };
    if (idempotencyKey) store.idem.put('createJob:' + idempotencyKey, out);
    return out;
  }

  // ---- start: one job per line at a time (each line's maxConcurrentJobs, 1), and (L2) at most engine.maxRunningJobs across every line on an
  // instance started by npm start (L3, owner 20/10/2026: 2, so two lines run side by side); returns the run promise (or null when it has to
  // wait: the job stays queued as "next", for its line or for the total, and starts when a running job ends)
  // L3: an engine opened by a script (script-engine.mjs) starts no job (a maintenance script) or only the jobs the script starts itself
  const queuedAt = (j) => (j.data && j.data.queuedAt) || j.updated_at || j.created_at || 0;
  function startJob(id) {
    const job = store.getJob(id); if (!job) throw new Error('no such job: ' + id);
    if (engJob(job)) { if (!engine.engineering) throw new Error('job ' + id + ' is an engineering job and this engine has no engineering line'); return engine.engineering.start(id); }
    if (!['queued'].includes(job.state)) throw new Error('job ' + id + ' is ' + job.state + ', not queued');
    if (halt.isHalted()) throw new Error('e-stop is on');
    const hold = engine.lineHold ? engine.lineHold(job.line) : null;
    if (hold) throw Object.assign(new Error(hold), { code: /^archived/.test(hold) ? 'ARCHIVED' : 'PAUSED' });
    const sr = engine.scriptRun;
    if (sr && !sr.startsJobs) { const e = new Error('no job starts from this script (' + sr.purpose + '): it opens the engine for maintenance only'); e.code = 'SCRIPT'; throw e; }
    if (sr) sr.own.add(id);
    const L = lineOf(job.line), cur = active.get(L.id), max = engine.maxRunningJobs || null;
    if (cur && (L.maxConcurrentJobs || 1) <= 1) { setJob(id, { reason: 'next: waiting for ' + cur.jobId + ' (one job at a time on the ' + L.id + ' line)', data: { autoStart: true, next: true, nextFor: 'line', queuedAt: (job.data && job.data.next && job.data.queuedAt) || Date.now() } }); return null; }
    if (max && active.size + engCount() >= max) { const on = [...active.values()].map((a) => a.jobId).concat(engine.engineering ? engine.engineering.active() : []); setJob(id, { reason: 'next: waiting for ' + on.join(', ') + ' (at most ' + max + ' job' + (max === 1 ? '' : 's') + ' running at a time)', data: { autoStart: true, next: true, nextFor: 'total', queuedAt: (job.data && job.data.next && job.data.queuedAt) || Date.now() } }); return null; }
    if (job.data && job.data.next) store.updateJob(id, { data: { next: false, nextFor: null } });
    const promise = runJob(id).catch((e) => { log.error('job crashed', { id, error: String(e && e.stack || e) }); try { block(store.getJob(id), 'engine error: ' + e.message); } catch (_) { /* store gone */ } }).finally(() => { blocklistOnEnd(id); active.delete(L.id); startNext(id); });
    active.set(L.id, { jobId: id, promise });
    return promise;
  }
  // the queued jobs that start by themselves, oldest first (never one interrupted by a restart or waiting for an agent or the owner)
  function nextJobs(exceptId = null) {
    return store.listJobs({ states: ['queued'] }).filter((j) => j.id !== exceptId && !j.legacy && !engJob(j) && j.data && j.data.autoStart && !j.data.waitingFor && !/^interrupted/.test(j.reason || '') && !isActive(j.id)).sort((a, b) => queuedAt(a) - queuedAt(b));
  }
  function startNext(endedId) {
    if (halt.isHalted()) return;
    const max = engine.maxRunningJobs || null;
    for (const j of nextJobs(endedId)) {
      if (max && active.size + engCount() >= max) return;
      if (active.get(j.line)) continue;
      if (engine.scriptRun && !engine.scriptRun.own.has(j.id)) continue;   // L3: a script never starts a job it did not start itself
      try { startJob(j.id); } catch (e) { log.warn('next job not started', { jobId: j.id, error: e.message }); }
    }
  }

  async function runJob(id) {
    const ctl = new AbortController(); stops.set(id, ctl);
    try { return await runSteps(id, ctl.signal); } finally { if (stops.get(id) === ctl) stops.delete(id); }
  }
  async function runSteps(id, stopSignal) {
    let job = setJob(id, { state: 'running', started_at: store.getJob(id).started_at || Date.now(), reason: null, data: { stopRequested: null } }, 'job.stage', { step: store.getJob(id).step });
    const L = lineOf(job.line);
    // owner, 17/10/2026: the product key is checked against products.json before any step, model call or reservation;
    // a missing or unknown key ends the job incomplete at USD 0
    if (job.kind === 'research' && L.requiresProductKey && !(job.product_key && (cfg.products || []).some((p) => p.key === job.product_key))) {
      block(job, 'unknown product key: ' + (job.product_key || '(none)'), { state: 'incomplete' });
      return store.getJob(id);
    }
    // a line job created before frozen inputs existed is frozen at its first run from then on, from its brief.md as it stands
    if (job.kind === 'line' && !snapshotOf(id) && readInputs(dataRoot, id).ok) freezeJob(job, 'frozen at the first run after frozen inputs were built (18/10/2026), from brief.md as it stood');
    let step = job.step === 'intake' ? L.steps.intake.next : job.step;
    while (step) {
      job = store.getJob(id);
      if (job.kind === 'line') { const ip = inputsProblem(id); if (ip) { block(job, 'frozen inputs: ' + ip); return store.getJob(id); } }
      if (halt.isHalted()) { setJob(id, { state: 'stopped', reason: 'stopped by the e-stop at ' + step, ended_at: Date.now() }, 'job.stopped'); return store.getJob(id); }
      if (stopSignal.aborted) { setJob(id, { state: 'stopped', step, reason: 'stopped by the owner at ' + step, ended_at: Date.now() }, 'job.stopped'); return store.getJob(id); }
      const def = L.steps[step]; if (!def) { block(job, 'line ' + L.id + ' has no step "' + step + '"'); return store.getJob(id); }
      // an off-duty agent's step waits (ENGINE-PLAN.md §6): the job goes back to queued at this step, and starts again
      // when the owner puts the agent back on duty (wakeWaiting)
      if (def.kind === 'agent' && !effectiveAgent(engine, def.agent).enabled) {
        const who = (cfg.agents[def.agent] || {}).name || def.agent;
        log.info('job waits for an off-duty agent', { jobId: id, step, agent: def.agent });
        setJob(id, { state: 'queued', step, reason: 'waiting: ' + who + ' is off duty', data: { waitingFor: def.agent, autoStart: true } }, 'job.stage', { step, waiting: def.agent });
        return store.getJob(id);
      }
      // owner, 18/10/2026: the backstop of mockGuard (a server resume, a routine, any other start): no agent step of a job with live
      // spend runs on the mock; the job stops there and is resumed live (npm run line:live)
      if (def.kind === 'agent' && mockOnLive(id)) { setJob(id, { state: 'stopped', step, reason: 'stopped before ' + step + ': the job has live spend and this engine runs the mock provider (resume it live: npm run line:live)', ended_at: Date.now() }, 'job.stopped'); log.warn('mock run on a live job refused', { jobId: id, step }); return store.getJob(id); }
      // listing-only (the owner's cap): before every hop, spend so far + the estimate of this agent's run must fit under the cap
      const mode = job.data.runMode;
      if (mode && mode.kind === 'listing-only' && def.kind === 'agent') {
        const spent = ledger.spent.job(id) - (mode.spentAtStart || 0), est = agentEstimate(def.agent);
        if (spent + est > mode.maxUsd) { setJob(id, { state: 'stopped', step, reason: 'listing-only run stopped before ' + step + ': USD ' + spent.toFixed(4) + ' spent + USD ' + est.toFixed(4) + ' estimated would go over the owner cap USD ' + mode.maxUsd.toFixed(2), ended_at: Date.now(), data: { runMode: null } }, 'job.stopped'); return store.getJob(id); }
        store.updateJob(id, { data: { runCapUsd: Math.max(0, mode.maxUsd - spent) } });
      }
      const pass = def.kind === 'agent' ? passFor(job, step) : 1;
      if (def.kind === 'agent' && pass === 1 && step !== 'rejects-desk') {
        const visited = (job.data.visited || []);
        if (visited.includes(step)) { block(job, 'step ' + step + ' would run twice outside a loop'); return store.getJob(id); }
        if (job.hops + 1 > (L.maxHops || cfg.engine.caps.maxHops)) { block(job, 'maxHops ' + (L.maxHops || cfg.engine.caps.maxHops) + ' reached'); return store.getJob(id); }
        job = store.updateJob(id, { hops: job.hops + 1, data: { visited: [...visited, step] } });
      }
      const sid = store.tx(() => { const s = store.openStage(id, step, pass); store.updateJob(id, { step }); return s; });
      bus.emit('job.stage', { jobId: id, agentKey: def.agent || null, data: { step, column: def.column, pass, kind: def.kind } });
      await callHook('onStep', { job: store.getJob(id), step, def, pass, phase: 'start' });
      let r;
      try { r = def.kind === 'agent' ? await agentStep(store.getJob(id), step, def, pass, stopSignal) : await mechStep(store.getJob(id), step, def, stopSignal); }
      catch (e) { r = { blocked: 'engine error in ' + step + ': ' + e.message }; log.error('step crashed', { id, step, error: String(e && e.stack || e) }); }
      store.closeStage(sid, r.blocked ? 'blocked' : r.stopped ? 'stopped' : r.incomplete ? 'incomplete' : 'done', r.blocked || r.stopped || r.incomplete || r.modeDone || r.waiting || r.note || null);
      job = store.updateJob(id, { data: { costUsd: ledger.spent.job(id) } });
      await callHook('onStep', { job, step, def, pass, phase: 'end', result: r });
      // E6 c0: the owner decides on file 1 of a style-reference set; the job waits at this step (never started by itself)
      if (r.waiting) { setJob(id, { state: 'queued', step, reason: r.waiting, data: { waitingFor: 'owner-style-ref', autoStart: false } }, 'job.stage', { step, waiting: 'owner-style-ref' }); return store.getJob(id); }
      if (r.modeDone) { setJob(id, { state: 'stopped', reason: r.modeDone, ended_at: Date.now(), data: { runMode: null, runCapUsd: null, lastRunMode: { ...(store.getJob(id).data.runMode || {}), result: r.modeDone } } }, 'job.stopped'); return store.getJob(id); }
      if (r.stopped) { setJob(id, { state: 'stopped', reason: r.stopped, ended_at: Date.now() }, 'job.stopped'); return store.getJob(id); }
      if (r.blocked) { block(store.getJob(id), r.blocked); return store.getJob(id); }
      // missing outputs after the nudges: routed like a failure (no later step runs), state incomplete, never done
      if (r.incomplete) { block(store.getJob(id), r.incomplete, { state: 'incomplete' }); return store.getJob(id); }
      if (r.end === 'rejected') { setJob(id, { state: 'rejected', reason: r.reason, ended_at: Date.now() }, 'job.rejected'); return store.getJob(id); }
      if (r.end === 'approval') { setJob(id, { state: 'approval', reason: 'packaged, waiting for the owner\'s decision', ended_at: Date.now() }, 'job.queued-for-approval'); return store.getJob(id); }
      if (r.end === 'research-done') { setJob(id, { state: 'research-done', reason: r.reason, ended_at: Date.now() }, 'job.stage', { step: 'done' }); return store.getJob(id); }
      step = r.next;
    }
    return store.getJob(id);
  }

  // the estimate of one run of an agent for the owner's cap: the dearest of its last 10 runs in the ledger (all jobs), 0 with no history
  // (legacy run-line agentRunEstimate; a run = the rows sharing a runId)
  function agentEstimate(agentKey, last = 10) {
    const by = new Map(); for (const r of ledger.rows()) if (r.agentKey === agentKey) { const x = by.get(r.runId) || { usd: 0, ts: 0 }; x.usd += Number(r.usd) || 0; x.ts = Math.max(x.ts, Number(r.ts) || 0); by.set(r.runId, x); }
    const runs = [...by.values()].sort((a, b) => b.ts - a.ts).slice(0, last);
    return runs.length ? Number(Math.max(...runs.map((x) => x.usd)).toFixed(6)) : 0;
  }

  // the pass number of an agent step: design = 1 + sends back + prep retries; listing = 1 + sends back
  function passFor(job, step) {
    const l = job.loops || {};
    if (step === 'designer' || step === 'qa-design') return 1 + (l.design || 0) + (step === 'designer' ? (l.prep || 0) : 0);
    if (step === 'lister' || step === 'qa-listing') return 1 + (l.listing || 0);
    return 1;
  }
  const stopFrom = (run, who) => (run.status === 'stopped' ? { stopped: who + ' run stopped: ' + run.endReason } : run.status === 'cap' ? { blocked: run.endReason } : run.status === 'refused' ? { blocked: who + ' run refused: ' + run.endReason } : run.status === 'failed' ? { blocked: who + ' run failed: ' + run.error } : run.status === 'max-turns' ? { blocked: who + ' run hit ' + run.endReason } : run.status === 'incomplete' ? { incomplete: run.endReason } : null);

  function handoff(job, extra = []) { const n = latestSet(dataRoot, job.id); return ['```', 'LISTING_ID: ' + job.id, 'BRIEF: work/' + job.id + '/brief.md', ...(n ? ['DESIGN: work/' + job.id + '/set-v' + n + '/deliverables.json'] : []), ...extra, '```'].join('\n'); }

  // ---- the output contract (E6 b1): a line step's `outputs` says what its agent must leave behind before the step ends
  //   drafts:   `count` new genre drafts in this line's drafts folder for the day (partial allowed: >= 1 continues the line)
  //   verdicts: a verdict (status verified or rejected) on every draft that was in that folder when the step started
  // check() returns { want, have, missing: [what is missing, in words the agent can act on] }.
  function outputContract(job, def) {
    const o = def.outputs; if (!o || job.kind !== 'research') return null;
    const day = job.data.day || dublinDay(), dd = draftsDirOf(lineOf(job.line)), dir = path.join(dataRoot, 'research', dd, day), rel = dd + '/' + day + '/';
    const mds = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
    if (o.kind === 'drafts') {
      const before = new Set(mds()), want = o.count;
      return { tool: o.tool, partialOk: o.partialOk !== false, hint: 'Write each genre draft to ' + rel + '<id>.md in the GENRE BRIEF FORMAT (evidence level: indicative, from web search results only), status: candidate, one ' + o.tool + ' call per draft.',
        check() { const have = mds().filter((f) => !before.has(f)).length; return { want, have, missing: have >= want ? [] : [(want - have) + ' of ' + want + ' genre drafts (' + rel + '<id>.md)'] }; } };
    }
    if (o.kind === 'verdicts') {
      const received = mds();
      return { tool: o.tool, partialOk: false, hint: 'For each brief: fill in the Evidence check section, set status: verified or status: rejected, and write the whole brief back in one ' + o.tool + ' call.',
        check() { const open = received.filter((f) => { try { return !['verified', 'rejected'].includes(briefField(fs.readFileSync(path.join(dir, f), 'utf8'), 'status')); } catch (_) { return false; } }); return { want: received.length, have: received.length - open.length, missing: open.map((f) => 'a verdict for ' + rel + f) }; } };
    }
    throw new Error('unknown outputs kind ' + o.kind + ' on ' + def.agent);
  }

  async function agentStep(job, step, def, pass, stopSignal = null) {
    const L = lineOf(job.line), research = job.kind === 'research', folder = research ? path.join(dataRoot, 'research') : jobDir(job.id), l = job.loops || {}, max = research ? 0 : (L.steps['qa-design'].onRevise || {}).max ?? 2;
    let input, loopNote = null, why = null;
    if (research) {
      // each research line has its own drafts folder (the genre scout: scout-drafts/), so two lines can run on one day
      const dd = draftsDirOf(L);
      // the product key is data (owner, 17/10/2026): one exact line, validated against products.json before the job started
      const pk = L.requiresProductKey ? '\nproduct_key: ' + job.product_key + '\n(the products.json entry for this batch; every brief\'s product_type is exactly this key)' : '';
      J.makeDir(path.join(folder, dd, job.data.day)); input = (job.data.input || 'Run your standing orders for this batch.') + pk + '\nToday (Dublin) is ' + job.data.day + '. Drafts for this batch: ' + dd + '/' + job.data.day + '/.' + (dd !== 'drafts' ? ' This line keeps its drafts in ' + dd + '/: wherever your orders say drafts/<today>/, use ' + dd + '/' + job.data.day + '/.' : '');
      if ((cfg.agents[def.agent] || {}).scoutingNotes) {
        // E6 b3: this job's own notes file. An earlier attempt of this job (a restart, or a resume after an engine stop)
        // left notes: their names go on the blocklist first, then the file is moved aside (never overwritten)
        const nf = notesFile(folder, job.data.day, job.id);
        if (fs.existsSync(nf)) {
          blocklistJobNotes(store.getJob(job.id), 'before a new ' + step + ' attempt');
          let to, n = 0; do to = path.join(path.dirname(nf), 'notes-replaced-' + stamp() + (n++ ? n : '') + '.json'); while (fs.existsSync(to));
          J.move(nf, to);
          log.info('scouting notes of an earlier attempt moved aside', { jobId: job.id, to: path.relative(dataRoot, to).split(path.sep).join('/') });
        }
        J.makeDir(path.dirname(nf)); input += ' Your internal scouting notes for this run: ' + notesRel(job.data.day, job.id) + '.';
      }
      // owner D1: the checker verifies every citation against what this job's web calls really returned (the transcript)
      if (def.returnedSources) {
        const got = [...returnedUrls(transcriptOf(job.id))];
        input += '\n\nSOURCES RETURNED to this job\'s web calls so far (from the job transcript; a brief may cite ONLY these URLs, and you may fetch only one a web search returned; never etsy.com):\n' + (got.length ? got.map((u) => '- ' + u).join('\n') : '(none)');
        // owner, 17/10/2026 ("prices as shown"): the price figures those web calls showed; every number in a brief's prices must be one
        const prices = [...returnedPrices(transcriptOf(job.id))].sort((a, b) => Number(a) - Number(b));
        input += '\n\nPRICES RETURNED to this job\'s web calls so far (from the job transcript, as numbers; every number in a Demand evidence price must be one of these):\n' + (prices.length ? prices.join(', ') : '(none)');
      }
    }
    else if (step === 'designer') {
      // W2: a set left half-drawn by a failed or stopped run (job.data.designSet "drawing") is carried on, never started again
      const cont = designSetInProgress(job);
      why = cont ? cont.why : pass === 1 ? 'first' : job.data.prepFailure && (l.prep || 0) > 0 && !job.data.prepFailureSeen ? 'prep' : 'qa-revise';
      // W4 (owner, 21/10/2026): a style-reference set that failed the build short of files goes back to the SAME set: only the missing files
      const sp = !cont && why === 'prep' ? productFor(dataRoot, job.id, productsOf(job.id)).product : null;
      const fill = sp && usesStyleRef(sp) ? missingFilesOf(job, sp) : null;
      if (fill) why = 'missing';
      const n = cont ? cont.set : fill ? fill.set : latestSet(dataRoot, job.id) + 1;
      if (why === 'first') input = 'New verified brief for the Room 1 line. Write set-v' + n + '.\n\n' + readBrief(job.id) + '\n\n' + handoff(job);
      else if (why === 'missing') { input = '[STATION — set-v' + n + ' is not complete] ' + (job.data.prepFailure || 'files are missing') + '\nDraw only the missing files into set-v' + n + ' (named below); every file already in set-v' + n + '/raw/ stays as it is.\n\n' + handoff(job); if (!cont) store.updateJob(job.id, { data: { prepFailureSeen: true } }); }
      else if (why === 'prep') { input = '[STATION — the set could not be prepared] ' + job.data.prepFailure + '\nWrite a corrected set-v' + n + '.\n\n' + handoff(job); if (!cont) store.updateJob(job.id, { data: { prepFailureSeen: true } }); }
      else { const q = readJson(path.join(folder, 'qa', 'design-pass' + (l.design || 0) + '.json')) || {}; input = '[LOOP — pass ' + pass + ' of ' + (max + 1) + '] QA DESIGN asked for a revise. Write set-v' + n + ' and fix EVERY reason:\n' + (q.reasons || []).map((x, i) => (i + 1) + '. ' + x).join('\n') + '\n\n' + handoff(job); }
    } else if (step === 'qa-design' && job.data.runMode && job.data.runMode.kind === 'qa-only') input = job.data.runMode.startText;
    else if (step === 'qa-design') input = 'Review the newest set.' + (pass > 1 ? ' [LOOP — pass ' + pass + ' of ' + (max + 1) + ']' : '') + '\n\n' + handoff(job) + redrawNote(job) + reworkNote(job);
    else if (job.data.runMode && job.data.runMode.kind === 'listing-only' && (step === 'lister' || step === 'qa-listing')) {
      const m = job.data.runMode, q = step === 'lister' && pass > 1 ? readJson(path.join(folder, 'qa-listing', 'pass' + ((job.data.qaPasses || {}).listing || 0) + '.json')) || {} : null;
      const ho = ['```', 'LISTING_ID: ' + job.id, 'BRIEF: work/' + job.id + '/brief.md', 'DESIGN: ' + m.designFile.replace(/^jobs\//, 'work/'), 'STAGE_DONE: ' + (m.signOff === 'owner-set-approval' ? 'OWNER SET APPROVAL' : 'QA DESIGN'), '```'].join('\n');
      input = step === 'lister' ? (q ? '[LOOP — pass ' + pass + '] QA LISTING asked for a revise:\n' + (q.reasons || []).map((x, i) => (i + 1) + '. ' + x).join('\n') + '\n\n' + ho : m.startText) : 'Review the listing.' + (pass > 1 ? ' [LOOP — pass ' + pass + ']' : '') + '\n\n' + ho + qaListingWordNote(job);
    }
    else if (step === 'lister') { const q = pass > 1 ? readJson(path.join(folder, 'qa-listing', 'pass' + (l.listing || 0) + '.json')) || {} : null; input = (q ? '[LOOP — pass ' + pass + '] QA LISTING asked for a revise:\n' + (q.reasons || []).map((x, i) => (i + 1) + '. ' + x).join('\n') + '\n\n' : 'Write the listing for the QA-approved set.\n\n') + handoff(job); }
    else if (step === 'qa-listing') input = 'Review the listing.' + (pass > 1 ? ' [LOOP — pass ' + pass + ']' : '') + '\n\n' + handoff(job) + qaListingWordNote(job);
    else if (step === 'rejects-desk') { input = '[LOOP — escalated] ' + (job.data.escalation || 'the work was not approved') + '\nRecord why in REJECTED.md.\n\n' + handoff(job); loopNote = 'This job is being stopped: write REJECTED.md only.'; }
    else input = handoff(job);
    if (!research) input += amendmentsNote(dataRoot, job.id);
    if (step === 'designer' && !research) {
      const { product } = productFor(dataRoot, job.id, productsOf(job.id));
      if (product) input += designPlanNote(job, product);
      if (product && usesStyleRef(product) && job.data.runMode && job.data.runMode.kind === 'redraw-only') return redrawFiles(job, def, pass, stopSignal, product);
      if (product && usesStyleRef(product)) return styleRefDesigner(job, def, pass, input, stopSignal, product, why);
    }
    const run = await runAgent(engine, { agentKey: def.agent, job, step, pass, folder, folderLabel: research ? 'the research folder (' + draftsDirOf(L) + '/, briefs/, rejected/)' : 'the job folder of ' + job.id, input, loopNote, line: job.line, runCapUsd: job.data.runCapUsd ?? null, stopSignal, contract: outputContract(job, def), hooks: { onRunStart: hooks.onRunStart }, verdictFiles: step === 'qa-design' && !research ? setFileIds(job, reviewedSet(job)) : null });
    // owner D2: the agent said it cannot produce its outputs: the job ends incomplete with its reason, nothing downstream
    if (run.reportedBlocked && run.status === 'incomplete') {
      store.updateJob(job.id, { data: { reportedBlocked: { step, agent: def.agent, reason: run.reportedBlocked } } });
      return { incomplete: def.agent.toUpperCase() + ' reported blocked: ' + run.reportedBlocked };
    }
    const stop = stopFrom(run, def.agent.toUpperCase());
    if (stop) return stop;
    if (run.shortfall) {
      const sf = { step, agent: def.agent, ...run.shortfall };
      store.updateJob(job.id, { data: { shortfalls: [...(store.getJob(job.id).data.shortfalls || []), sf] } });
      log.warn('agent produced fewer outputs than required; the line continues with what it has', { jobId: job.id, ...sf });
      // owner decision 3: a shortfall after report_blocked carries the agent's reason (sf.reason) and the line continues
      return { next: def.next, note: def.agent.toUpperCase() + ' shortfall: ' + run.shortfall.have + ' of ' + run.shortfall.want + ' outputs' + (run.shortfall.reason ? ' (reported blocked: ' + run.shortfall.reason + ')' : '') };
    }
    if (def.verdict) return routeVerdict(store.getJob(job.id), step, def, pass, run);
    if (step === 'rejects-desk') {
      const rf = path.join(folder, 'REJECTED.md');
      if (!fs.existsSync(rf)) J.put(rf, '# REJECTED: ' + job.id + '\n\n' + (job.data.escalation || 'not approved') + '\n\n(written by the engine: REJECTS-DESK ended without writing this file)\n');
      trackerRow(job, { status: '', status_reason: 'rejected by QA: ' + (job.data.escalation || '') });
      return { end: 'rejected', reason: 'refused by QA, recorded by REJECTS-DESK: ' + firstLine(fs.readFileSync(rf, 'utf8')) };
    }
    return { next: def.next };
  }
  const firstLine = (t) => (String(t || '').split('\n').map((x) => x.replace(/^#+\s*/, '').trim()).filter(Boolean)[0] || '');

  // ---- E6 c0: the designer step of a style-reference product (see the header): first file, QA-DESIGN on file 1, the owner's
  // decision, then the rest of the set in batches with the approved file 1 as the style reference
  const pad2 = (n) => String(n).padStart(2, '0');
  const clipText = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
  const ownerWaitText = (aw) => 'waiting for the owner: file 1 of set-v' + aw.set + ' (' + aw.name + ') passed QA DESIGN (file 1 check, pass ' + aw.qaPass + '); see set-v' + aw.set + '/review/, then decide: npm run owner -- style-ref <id> \'{"set":' + aw.set + ',"status":"approved"}\' (or "rejected" with a "reason"), and resume the job';
  async function styleRefDesigner(job, def, pass, baseInput, stopSignal, product, why = null) {
    const L = lineOf(job.line), revise = L.steps['qa-design'].onRevise || {}, attemptLimit = 1 + (revise.max ?? 2);
    const designer = cfg.agents[def.agent] || {}, maxImages = (designer.limits || {}).maxImages || 0;
    const folder = jobDir(job.id), run0 = { job, line: job.line, folder, folderLabel: 'the job folder of ' + job.id, loopNote: null, runCapUsd: job.data.runCapUsd ?? null, stopSignal, contract: null, hooks: { onRunStart: hooks.onRunStart }, imageAttemptLimit: attemptLimit };
    const a = approvedRef(dataRoot, job.id);
    if (a.ok) {
      if (job.data.styleRef && job.data.styleRef.awaiting) store.updateJob(job.id, { data: { styleRef: { ...job.data.styleRef, awaiting: null, approved: { set: a.ref.set, name: a.ref.name, sha256: a.ref.sha256, version: a.ref.version || 'raw' } } } });
      return restOfSet(store.getJob(job.id), def, pass, baseInput, product, a.ref, maxImages, run0, why);
    }
    const ff = await firstFile(job, def, baseInput, product, attemptLimit, run0);
    if (!ff.qaApproved) return ff;
    // the file-1 gate: QA DESIGN's pass is file 1's approval, the rest of the set follows in this step
    const b = approvedRef(dataRoot, job.id);
    if (!b.ok) return { blocked: 'file 1 passed QA DESIGN but its approval does not stand: ' + b.reason };
    const sr = (store.getJob(job.id).data || {}).styleRef || {};
    store.updateJob(job.id, { data: { styleRef: { ...sr, awaiting: null, lastReasons: null, approved: { set: b.ref.set, name: b.ref.name, sha256: b.ref.sha256, version: b.ref.version || 'raw', decidedBy: b.ref.decidedBy, qaPass: b.ref.qaPass } } } });
    trackerRow(store.getJob(job.id), { status: 'running', status_reason: 'file 1 approved by QA DESIGN (file-1 gate, pass ' + b.ref.qaPass + '): the rest of the set follows' });
    return restOfSet(store.getJob(job.id), def, pass, baseInput, product, b.ref, maxImages, run0, why);
  }

  async function firstFile(job, def, baseInput, product, attemptLimit, run0) {
    const id = job.id, sr = job.data.styleRef || {}, latest = readStyleRef(dataRoot, id).current;
    // a file 1 that passed QA and waits for the owner: nothing is drawn again until the owner decides
    if (sr.awaiting && !(latest && latest.set === sr.awaiting.set)) return { waiting: ownerWaitText(sr.awaiting).replace('<id>', id) };
    let carry = Array.isArray(sr.lastReasons) ? sr.lastReasons : [];
    if (sr.awaiting && latest && latest.set === sr.awaiting.set && latest.status === 'rejected') {
      carry = ['the owner rejected file 1 of set-v' + latest.set + ': ' + (latest.reason || '(no reason given)')];
      store.updateJob(id, { data: { styleRef: { ...sr, awaiting: null, lastReasons: carry, ownerRejections: (sr.ownerRejections || 0) + 1 } } });
    }
    const total = product.deliverables.files.length;
    for (;;) {
      job = store.getJob(id);
      // W2: an attempt cut off by a failed or stopped run carries on in its own set; a file 1 already drawn there goes to its check
      const cont = designSetInProgress(job, 'first-file'), used = (job.loops || {}).file1 || 0, n = cont ? cont.set : latestSet(dataRoot, id) + 1;
      let run = null;
      if (cont && firstFileOf(dataRoot, id, n).ok) log.info('resume: file 1 of set-v' + n + ' is already drawn: it goes to its check without a new DESIGNER run', { jobId: id, set: n });
      else {
        if (!cont) store.updateJob(id, { data: { designSet: { set: n, mode: 'first-file', why: 'first', files: [1], status: 'drawing', startedAt: Date.now() } } });
        const input = '[RUN MODE: FIRST FILE ONLY — the style reference] Plan EVERY file of the set (' + total + ' files), then generate ONLY file 1, to work/' + id + '/set-v' + n + '/raw/01-<subject>.png, check it with image analysis, and write work/' + id + '/set-v' + n + '/design.md with the whole plan and file 1\'s prompt. The station builds file 1 as it will be delivered; QA DESIGN checks it, then the owner approves it before any other file is drawn.'
          + ' [FILE 1 — attempt ' + (used + 1) + ' of ' + attemptLimit + ']' + (carry.length ? '\nFix EVERY reason from the last attempt:\n' + carry.map((x, i) => (i + 1) + '. ' + x).join('\n') : '') + '\n\n' + baseInput;
        run = await runAgent(engine, { ...run0, agentKey: def.agent, step: 'designer', pass: used + 1, input, image: { mode: 'first-file', set: n } });
        const stop = stopFrom(run, 'DESIGNER'); if (stop) return stop;
      }
      let reasons = null;
      const ff = firstFileOf(dataRoot, id, n);
      if (!ff.ok) {
        const tried = Object.entries(((store.getJob(id).data || {}).imageAttempts) || {}).filter(([k]) => /^01-/.test(k)).map(([k, v]) => k + ': ' + v.map((x) => x.why).join(', '));
        reasons = ['file 1 was not made (' + ff.reason + ')' + (tried.length ? '; failed image attempts: ' + tried.join('; ') : '') + (run && run.text ? '; DESIGNER said: "' + clipText(run.text, 200) + '"' : '')];
      } else {
        const rv = await reviewFileOne(job, n, ff.name, product, run0.stopSignal);
        if (rv.stopped || rv.blocked) return rv;
        if (!rv.ok) reasons = ['file 1 (' + ff.name + ') could not be built for review: ' + rv.reason];
        else {
          const v = fileOneVersion(dataRoot, id, n);
          if (!v.ok) reasons = ['file 1: ' + v.reason];
          else {
            const k = 1 + (fs.existsSync(path.join(jobDir(id), 'qa')) ? fs.readdirSync(path.join(jobDir(id), 'qa')).filter((f) => /^file1-pass\d+\.json$/.test(f)).length : 0);
            const raw = 'set-v' + n + '/raw/' + ff.name, base = ff.name.replace(/\.png$/i, '');
            const reviews = Object.values(rv.review || {}).map((x) => 'work/' + id + '/' + x.file.replace(/^jobs\/[^/]+\//, ''));
            const qaInput = ['[RUN MODE: FILE 1 CHECK — the style reference] Only file 1 of this set exists. Check it before the owner sees it and before any other file is drawn. This is not the set review: there is no deliverables.json yet.',
              'FILE 1: work/' + id + '/' + raw + ' (the Designer\'s raw file' + (v.version === 'cleaned' ? '; the station\'s cleaned version, the one the owner decides on: work/' + id + '/' + v.file.replace(/^jobs\/[^/]+\//, '') : '') + ')',
              'REVIEW IMAGES (file 1 built as it will be delivered, flattened on each background): ' + reviews.join(', '),
              'PLAN: work/' + id + '/set-v' + n + '/design.md; BRIEF: work/' + id + '/brief.md',
              'Open file 1 and every review image with image analysis. Checks, each "pass" or "fail": originality, trademarks, etsyPolicy, briefFit, usable (clean edges, nothing cut off, no stray text or lettering, a real transparent background), styleReference (one clear, finished style the other ' + (total - 1) + ' files can follow). Any fail = revise, with specific reasons the Designer can act on.',
              'Call submit_verdict ONCE with record = { "stage": "file1", "listingId": "' + id + '", "file": "' + raw + '", "verdict": "approved" or "revise", "checks": { ... }, "reasons": [ ... ] }, then end your reply. Write no file.'].join('\n') + amendmentsNote(dataRoot, id);
            const qa = await runAgent(engine, { ...run0, agentKey: 'qa-design', step: 'qa-design', pass: k, input: qaInput, verdictKind: 'file1', file1: { rel: raw, sha256: ff.sha256 } });
            const qs = stopFrom(qa, 'QA DESIGN'); if (qs) return qs;
            const rec = { ...(qa.verdict || { stage: 'file1', listingId: id, file: raw, verdict: 'revise', checks: {}, reasons: ['the QA run ended without a valid verdict (counts as revise)'], recordedBy: 'engine' }), pass: k, set: n, reviewer: 'QA DESIGN', decides: { version: v.version, file: v.file, sha256: v.sha256 }, inputs: inputsRef(id) };
            J.put(path.join(jobDir(id), 'qa', 'file1-pass' + k + '.json'), JSON.stringify(rec, null, 1) + '\n');
            endDesignSet(id, n);
            log.info('file 1 verdict', { jobId: id, set: n, pass: k, verdict: rec.verdict, reasons: rec.reasons });
            if (rec.verdict === 'approved' && !store.getJob(id).data.ownerFile1) {
              const d = recordDecision({ roomDir: dataRoot, id, status: 'approved', date: dublinDay(), decidedBy: 'qa-design', n, qaPass: k });
              if (!d.ok) return { blocked: 'file 1 passed QA DESIGN, but its approval could not be recorded: ' + d.reason };
              log.info('file 1 approved by QA DESIGN (the file-1 gate): no owner pause', { jobId: id, set: n, qaPass: k, sha256: v.sha256 });
              return { qaApproved: true };
            }
            if (rec.verdict === 'approved') {
              const aw = { set: n, name: ff.name, qaPass: k, version: v.version, file: v.file, sha256: v.sha256, at: Date.now() };
              store.updateJob(id, { data: { styleRef: { ...((store.getJob(id).data || {}).styleRef || {}), awaiting: aw, lastReasons: null } } });
              trackerRow(store.getJob(id), { status: 'waiting', status_reason: 'file 1 passed QA DESIGN: owner decision on the style reference' });
              return { waiting: ownerWaitText(aw).replace('<id>', id) };
            }
            reasons = (rec.reasons && rec.reasons.length) ? rec.reasons : ['QA DESIGN asked for a revise of file 1'];
          }
        }
      }
      // a failed attempt at file 1: drawn again (a new set) before any other file, within the design loop limit
      endDesignSet(id, n);
      const sr2 = (store.getJob(id).data || {}).styleRef || {};
      store.updateJob(id, { loops: { file1: used + 1 }, data: { styleRef: { ...sr2, lastReasons: reasons } } });
      log.warn('file 1 attempt failed', { jobId: id, set: n, attempt: used + 1, of: attemptLimit, reasons });
      if (used + 1 >= attemptLimit) {
        const why = 'file 1 (the style reference) was not approved by QA DESIGN after ' + (used + 1) + ' attempt(s) (loop limit ' + (attemptLimit - 1) + ' sends back): ' + reasons.join('; ');
        store.updateJob(id, { data: { escalation: why } });
        return { next: L_escalate(job), note: 'file 1 loop exhausted: escalated' };
      }
      carry = reasons;
    }
  }
  const refWho = (ref) => (ref.decidedBy === 'qa-design' ? 'file 1, approved by QA DESIGN\'s file-1 check (pass ' + ref.qaPass + ')' : 'the owner-approved file 1');
  const L_escalate = (job) => (lineOf(job.line).steps['qa-design'].onRevise || {}).escalate || 'rejects-desk';

  // file 1 built as delivered and flattened for the owner (no model, $0): the pinned upscaler, killed by the e-stop or the Stop
  async function reviewFileOne(job, n, name, product, stopSignal) {
    const signal = stopSignal ? AbortSignal.any([halt.signal, stopSignal]) : halt.signal;
    const upscaler = engine.upscaler || esrganUpscaler({ pin: cfg.engine.upscale, workDir: path.join(jobDir(job.id), 'set-v' + n), signal });
    try { return await makeReviewImages({ roomDir: dataRoot, id: job.id, n, name, product, cfg: cfg.station, upscaler, log }); }
    catch (e) {
      if (e.code === 'STOPPED' || signal.aborted) return { stopped: 'stopped during the file 1 build: ' + e.message };
      return { blocked: 'the file 1 build failed (no retry through the Designer): ' + e.message };
    }
  }

  // the rest of the set (files 2..N) in batches that fit DESIGNER's maxImages, each image with the approved file 1 as the reference.
  // W2 (owner, 20/10/2026):
  //   after a QA DESIGN revise  only the files the verdict names (NN-subject.png in its reasons) and any file a build warning of the
  //                             reviewed set names are redrawn ("flagged"); every other file is copied into the new set byte for byte
  //                             (set-vN/rework.json records both). L3: the named files are the record's "redraw" ids; a verdict without
  //                             them blocks the job (W2's whole-set redraw is removed).
  //   a set in progress         the set is recorded on the job (data.designSet, status "drawing") before anything is drawn; a run that
  //                             fails or is stopped mid-pass leaves it "drawing", and the Resume carries on THAT set: the files already
  //                             in its raw/ are kept, only the planned files not yet there are drawn. "drawn" once every batch is done.
  async function restOfSet(job, def, pass, baseInput, product, ref, maxImages, run0, why = null) {
    const id = job.id, total = product.deliverables.files.length, chunk = Math.max(1, maxImages - 2);
    const refRel = String(ref.file).replace(/^jobs\/[^/]+\//, ''), refAbs = path.join(dataRoot, ref.file);
    let ds = designSetInProgress(job);
    if (ds && !(['rest', 'flagged', 'missing'].includes(ds.mode) && ds.ref === ref.sha256)) { log.warn('a set in progress is not carried on (another mode or style reference): a new set is drawn', { jobId: id, set: ds.set, mode: ds.mode }); endDesignSet(id, ds.set); ds = null; }
    const resumed = !!ds;
    // W4 (owner, 21/10/2026): the set that failed the build short of files is completed in place: a carried file is copied again by the
    // station ($0), every other missing file is drawn by DESIGNER into the same set with QA DESIGN's findings for it; never a fresh set
    const fill = !ds && why === 'missing' ? missingFilesOf(job, product) : null;
    if (fill) {
      const recopied = recarry(id, fill.set, fill.missing), files = fill.missing.filter((k) => !recopied.includes(k));
      store.updateJob(id, { data: { designSet: { set: fill.set, mode: 'missing', why: 'missing', files, ref: ref.sha256, recopied, status: 'drawing', startedAt: Date.now() } } });
      ds = store.getJob(id).data.designSet;
      log.info('set short of files: completed in the same set', { jobId: id, set: fill.set, missing: fill.missing.map(pad2), recopied: recopied.map(pad2), toDraw: files.map(pad2) });
    }
    if (!ds) {
      const n = latestSet(dataRoot, id) + 1, all = Array.from({ length: Math.max(0, total - 1) }, (_, i) => i + 2);
      let plan = { set: n, mode: 'rest', why: why || 'first', files: all, ref: ref.sha256 };
      if (why === 'qa-revise') {
        const fp = flaggedPlan(store.getJob(id), n, total);
        // L3 (owner, 21/10/2026): W2's whole-set fallback is removed: without the named files nothing is drawn and the owner decides
        if (!fp.ok) { log.warn('QA DESIGN revise without the files to redraw: nothing is drawn, the job blocks', { jobId: id, set: n, reason: fp.reason }); return { blocked: 'QA DESIGN asked for a revise without naming the files to redraw (' + fp.reason + '): nothing is redrawn; the owner decides (a QA-only run, a redraw-only set, or the owner\'s set approval)' }; }
        plan = { ...plan, mode: 'flagged', from: fp.from, qaPass: fp.qaPass, files: fp.redraw, carry: fp.carry };
      }
      store.updateJob(id, { data: { designSet: { ...plan, status: 'drawing', startedAt: Date.now() } } });
      ds = store.getJob(id).data.designSet;
      if (ds.mode === 'flagged') log.info('QA DESIGN revise: only the flagged files are redrawn', { jobId: id, set: ds.set, from: ds.from, qaPass: ds.qaPass, redraw: ds.files.map(pad2), carried: ds.carry });
    }
    const n = ds.set, sd = path.join(jobDir(id), 'set-v' + n), rw = ds.mode === 'flagged' ? carryFlagged(store.getJob(id), ds, product, ref) : null, fillMode = ds.mode === 'missing';
    const have = new Set(rawFiles(path.join(sd, 'raw')).map(numOf)), done = ds.files.filter((k) => have.has(k)), todo = ds.files.filter((k) => !have.has(k));
    if (resumed) log.info('resume: set-v' + n + ' carried on from the first file not yet done', { jobId: id, set: n, mode: ds.mode, kept: done.map(pad2), toDraw: todo.map(pad2) });
    if (!ds.files.length) { endDesignSet(id, n); return { next: def.next, note: fillMode ? 'set-v' + n + ': the missing file(s) ' + (ds.recopied || []).map(pad2).join(', ') + ' copied again from the set they were carried from; nothing to draw' : 'the set is file 1 alone (the owner-approved style reference)' }; }
    const batches = []; for (let i = 0; i < todo.length; i += chunk) batches.push(todo.slice(i, i + chunk));
    const label = (xs) => (xs.every((k, i) => !i || k === xs[i - 1] + 1) ? pad2(xs[0]) + '–' + pad2(xs[xs.length - 1]) : xs.map(pad2).join(', '));
    const refLine = 'STYLE REFERENCE: work/' + id + '/' + refRel + ' (' + refWho(ref) + ', ' + ref.name + '; the station sends it with every image and copies it into raw/ as file 1). ';
    for (let b = 0; b < batches.length; b++) {
      const xs = batches[b], md = fs.existsSync(path.join(sd, 'design.md'));
      const keepLine = done.length ? 'RESUMED: set-v' + n + '/raw/ already holds file(s) ' + done.map(pad2).join(', ') + ' of this set from the run that stopped: keep them, never draw them again. ' : '';
      const mdLine = md ? 'Read work/' + id + '/set-v' + n + '/design.md' + (rw ? ' (written by the station: its plan from the current spec and brief, and the carried files\' prompts)' : '') + ' and write it back whole, with these files\' ' + (rw ? 'new ' : '') + 'prompts and analysis added.'
        : 'Write work/' + id + '/set-v' + n + '/design.md with the plan for every file (file 1 = "approved style reference", its prompt copied from set-v' + ref.set + '/design.md) and these files\' prompts and analysis.';
      const input = fillMode
        ? '[RUN MODE: DRAW MISSING FILES — batch ' + (b + 1) + ' of ' + batches.length + ': files ' + xs.map(pad2).join(', ') + ' of ' + total + '] ' + refLine
          + 'set-v' + n + ' failed the build because these files are missing from set-v' + n + '/raw/. Every other file there stays exactly as it is: never draw, rename or touch it. ' + keepLine
          + 'Write set-v' + n + ': draw ONLY these files, each to work/' + id + '/set-v' + n + '/raw/NN-<subject>.png (NN = the file number; the subject is the brief\'s item N), each checked with image analysis. Never draw file 1.\n'
          + xs.map((k) => { const r = findingsOf(id, n, k); return '- ' + pad2(k) + (r.was ? ' (was ' + r.was + ')' : '') + (r.findings.length ? '. QA DESIGN: ' + r.findings.join(' | ') : '') + (r.buildWarnings.length ? '. Build warning: ' + r.buildWarnings.join(' | ') : ''); }).join('\n')
          + '\n' + mdLine + '\n\n' + baseInput
        : rw
        ? '[RUN MODE: REDRAW FLAGGED FILES — batch ' + (b + 1) + ' of ' + batches.length + ': files ' + xs.map(pad2).join(', ') + ' of ' + total + '] ' + refLine
          + 'QA DESIGN (pass ' + rw.qaPass + ') asked for a revise of set-v' + rw.from + '. set-v' + n + '/raw/ already holds every file it did not flag, copied unchanged from set-v' + rw.from + ' (' + (rw.carried.map((c) => c.name).join(', ') || 'none') + '): never draw, rename or touch them. ' + keepLine
          + 'Write set-v' + n + ': draw ONLY these files, each to work/' + id + '/set-v' + n + '/raw/NN-<subject>.png (NN = the file number; the subject is the brief\'s item N), each checked with image analysis. Never draw file 1.\n'
          + xs.map((k) => { const r = rw.redraw.find((x) => x.n === k) || {}; return '- ' + pad2(k) + (r.was ? ' (was ' + r.was + ')' : ' (missing from set-v' + rw.from + ')') + (r.findings && r.findings.length ? '. QA DESIGN: ' + r.findings.join(' | ') : '') + (r.buildWarnings && r.buildWarnings.length ? '. Build warning: ' + r.buildWarnings.join(' | ') : ''); }).join('\n')
          + (rw.general.length ? '\nQA DESIGN\'s reasons that name no file (apply them to the files you draw): ' + rw.general.join(' | ') : '')
          + (rw.file1Named ? '\nQA DESIGN also named file 01: it is the approved style reference and is never redrawn here.' : '') + '\n' + mdLine + '\n\n' + baseInput
        : '[RUN MODE: REST OF SET — batch ' + (b + 1) + ' of ' + batches.length + ': files ' + label(xs) + ' of ' + total + '] ' + refLine
          + 'Write set-v' + n + ': generate ONLY files ' + label(xs) + ', to work/' + id + '/set-v' + n + '/raw/NN-<subject>.png (NN = the file number), each checked with image analysis. Never draw file 1. ' + keepLine + mdLine + '\n\n' + baseInput;
      const run = await runAgent(engine, { ...run0, job: store.getJob(id), agentKey: def.agent, step: 'designer', pass, input, image: { mode: 'rest', set: n, from: xs[0], to: xs[xs.length - 1], only: xs, reference: { abs: refAbs, rel: refRel, name: ref.name, sha256: ref.sha256 } } });
      const stop = stopFrom(run, 'DESIGNER'); if (stop) return stop;
      log.info('rest-of-set batch done', { jobId: id, set: n, mode: ds.mode, batch: b + 1, of: batches.length, files: xs.map(pad2), images: run.counters && run.counters.images });
    }
    // W4: the carried files of a rework set are the station's: checked (and copied again if missing or changed) once DESIGNER is done
    if (rw || fillMode) recarry(id, n);
    endDesignSet(id, n);
    const drew = todo.length ? 'files ' + todo.map(pad2).join(', ') + ' drawn in ' + batches.length + ' DESIGNER run(s), each image with the style reference ' + ref.name : 'nothing left to draw';
    return { next: def.next, note: 'set-v' + n + ': ' + drew + (rw ? '; carried unchanged from set-v' + rw.from + ': ' + (rw.carried.map((c) => pad2(numOf(c.name))).join(', ') || 'none') : '') + (done.length ? '; kept from the run that stopped: ' + done.map(pad2).join(', ') : '') };
  }

  // ---- W2: the set a DESIGNER pass is drawing (job.data.designSet), carried on by a Resume while it is unbuilt
  const rawFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.png$/i.test(f) && numOf(f)) : []);
  function designSetInProgress(job, mode = null) {
    const ds = job && job.data && job.data.designSet;
    if (!ds || ds.status !== 'drawing' || (mode && ds.mode !== mode) || ds.set !== latestSet(dataRoot, job.id)) return null;
    return fs.existsSync(path.join(jobDir(job.id), 'set-v' + ds.set, 'deliverables.json')) ? null : ds;
  }
  function endDesignSet(id, n) { const ds = (store.getJob(id).data || {}).designSet; if (ds && ds.set === n && ds.status === 'drawing') store.updateJob(id, { data: { designSet: { ...ds, status: 'drawn', endedAt: Date.now() } } }); }

  // ---- W4 (owner, 21/10/2026): a set is completed in place, never redrawn whole because a file is missing
  // the newest set when it is unbuilt (no deliverables.json, not a redraw-only set) and its raw/ lacks planned files 02..N -> { set, missing }
  function missingFilesOf(job, product) {
    const n = latestSet(dataRoot, job.id); if (!n || !product) return null;
    const sd = path.join(jobDir(job.id), 'set-v' + n);
    if (!fs.existsSync(path.join(sd, 'raw')) || fs.existsSync(path.join(sd, 'deliverables.json')) || redrawPlanOf(job.id, n)) return null;
    const total = product.deliverables.files.length, have = new Set(rawFiles(path.join(sd, 'raw')).map(numOf)), missing = [];
    for (let k = 2; k <= total; k++) if (!have.has(k)) missing.push(k);
    return missing.length ? { set: n, missing } : null;
  }
  // the carried files of a rework set (set-vN/rework.json) are copied by the station, byte for byte: a carried file missing from raw/, or
  // with other bytes than the record, is copied again from the set it came from. only = the file numbers to check (all when null).
  // -> the file numbers copied again
  function recarry(id, n, only = null) {
    const sd = path.join(jobDir(id), 'set-v' + n), rw = readJson(path.join(sd, 'rework.json')), out = [];
    if (!rw) return out;
    for (const c of rw.carried || []) {
      const k = numOf(c.name); if (only && !only.includes(k)) continue;
      const to = path.join(sd, 'raw', c.name), from = path.join(dataRoot, 'jobs', id, c.sameAs);
      if (fs.existsSync(to) && sha256File(to) === c.sha256) continue;
      if (!fs.existsSync(from) || sha256File(from) !== c.sha256) { log.warn('a carried file cannot be copied again: its source is missing or changed', { jobId: id, set: n, file: c.name, from: c.sameAs }); continue; }
      J.copy(from, to); out.push(k);
      log.warn('carried file copied again by the station', { jobId: id, set: n, file: c.name, from: c.sameAs, sha256: c.sha256 });
    }
    return out;
  }
  // what DESIGNER is told about file k of set n: its rework entry (QA DESIGN's findings and build warnings), else the newest QA DESIGN
  // record's reasons that name it
  function findingsOf(id, n, k) {
    const rw = readJson(path.join(jobDir(id), 'set-v' + n, 'rework.json')), r = rw && (rw.redraw || []).find((x) => x.n === k);
    if (r) return { was: r.was || null, findings: r.findings || [], buildWarnings: r.buildWarnings || [] };
    const passes = designPasses(jobDir(id)), last = passes[passes.length - 1], rec = last && last.rec.ok ? last.rec.v : null;
    return { was: null, findings: rec ? (rec.reasons || []).filter((t) => namedNums(t).includes(k)) : [], buildWarnings: [] };
  }
  // the set a QA DESIGN run reviews: a QA-only run's own set (W4: an older set's file ids), else the newest set
  const reviewedSet = (job) => (job.data && job.data.runMode && job.data.runMode.kind === 'qa-only' && Number(job.data.runMode.set)) || null;

  // the file numbers a QA text names: "NN-subject" (with or without .png), never a date or a size ("2026-10-19", "2000x2000"); since L3 used
  // for build warnings and to give each redrawn file its findings, never to decide what is redrawn (that is the record's "redraw" list)
  const NAMED_FILE = /\b(\d{2})-[a-z][a-z0-9-]*/gi;
  const namedNums = (t) => [...String(t || '').matchAll(NAMED_FILE)].map((m) => Number(m[1]));
  // L3: the file ids of the newest set of a style-reference product (raw/NN-subject.png), for QA DESIGN's "redraw" list; null otherwise.
  // W4: set names another set (a QA-only run on an older set checks the ids of the set it reviews)
  function setFileIds(job, set = null) {
    const { product } = productFor(dataRoot, job.id, productsOf(job.id)); if (!product || !usesStyleRef(product)) return null;
    const n = set || latestSet(dataRoot, job.id); if (!n) return null;
    const sd = path.join(jobDir(job.id), 'set-v' + n), dir = fs.existsSync(path.join(sd, 'raw')) ? path.join(sd, 'raw') : path.join(sd, 'files');
    const ids = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d{2}-[a-z0-9][a-z0-9-]*\.(png|jpg)$/i.test(f)).map((f) => f.replace(/\.(png|jpg)$/i, '')).sort();
    return { set: n, ids, redrawable: ids.filter((x) => Number(x.slice(0, 2)) >= 2) };
  }
  // L3: why a design revise cannot go back to DESIGNER (no valid "redraw" list on a style-reference set), or null
  function redrawBlock(job, rec) {
    const vf = setFileIds(job); if (!vf) return null;
    if (rec.redrawProblem) return rec.redrawProblem;
    if (rec.recordedBy === 'engine') return 'the QA run ended without a valid verdict, so no file was named';
    if (!Array.isArray(rec.redraw) || !rec.redraw.length) return 'the revise names no file id in "redraw"';
    const bad = rec.redraw.filter((x) => !vf.redrawable.includes(x));
    return bad.length ? 'not a redrawable file of set-v' + vf.set + ': ' + bad.join(', ') : null;
  }
  // what a QA DESIGN revise asks to redraw: -> { ok, from, qaPass, redraw: [n], carry: [names], ... } or { ok: false, reason }
  // L3: the files are the record's "redraw" ids (checked when QA DESIGN submitted it), plus any file a build warning names and any file
  // missing from the reviewed set; no list -> not ok (the job blocks: nothing is redrawn)
  function flaggedPlan(job, n, total) {
    const qp = ((job.data || {}).qaPasses || {}).design || (job.loops || {}).design || 0, rec = readJson(path.join(jobDir(job.id), 'qa', 'design-pass' + qp + '.json'));
    if (!rec || rec.verdict !== 'revise') return { ok: false, reason: 'no QA DESIGN revise record (qa/design-pass' + qp + '.json)' };
    const from = Number((/set-v(\d+)\/deliverables\.json$/.exec(rec.designFile || '') || [])[1]) || null;
    if (from !== n - 1) return { ok: false, reason: 'the revise was on set-v' + from + ', not on the newest set-v' + (n - 1) };
    const src = new Map(rawFiles(path.join(jobDir(job.id), 'set-v' + from, 'raw')).map((f) => [numOf(f), f]));
    const warnings = (readJson(path.join(jobDir(job.id), 'set-v' + from, 'deliverables.json')) || {}).buildWarnings || [];
    if (rec.redrawProblem || !Array.isArray(rec.redraw) || !rec.redraw.length) return { ok: false, reason: rec.redrawProblem || 'the verdict names no file to redraw in "redraw" (qa/design-pass' + qp + '.json)' };
    const ids = rec.redraw.map((x) => numOf(String(x) + '.png')).filter((k) => k >= 2 && k <= total);
    if (ids.length !== rec.redraw.length) return { ok: false, reason: 'the "redraw" list holds an id that is not a file 02–' + pad2(total) + ': ' + rec.redraw.join(', ') };
    const named = new Set([...ids, ...warnings.flatMap(namedNums).filter((k) => k >= 2 && k <= total)]);
    for (let k = 2; k <= total; k++) if (!src.has(k)) named.add(k);   // a file missing from the reviewed set is drawn in any case
    const redraw = [...named].sort((a, b) => a - b), carry = [...src.entries()].filter(([k]) => k >= 2 && k <= total && !named.has(k)).sort((a, b) => a[0] - b[0]).map(([, f]) => f);
    return { ok: true, from, qaPass: qp, redraw, carry };
  }
  // the flagged set's carried files, design.md and rework.json: written once (a Resume finds them and changes nothing); -> rework.json
  function carryFlagged(job, ds, product, ref) {
    const id = job.id, n = ds.set, sd = path.join(jobDir(id), 'set-v' + n), srcDir = path.join(jobDir(id), 'set-v' + ds.from), rf = path.join(sd, 'rework.json');
    for (const f of ds.carry) if (!fs.existsSync(path.join(sd, 'raw', f))) J.copy(path.join(srcDir, 'raw', f), path.join(sd, 'raw', f));
    const old = readJson(rf); if (old) return old;
    const rec = readJson(path.join(jobDir(id), 'qa', 'design-pass' + ds.qaPass + '.json')) || {}, warnings = (readJson(path.join(srcDir, 'deliverables.json')) || {}).buildWarnings || [];
    const texts = [...(rec.reasons || []), ...(rec.worthThePrice && rec.worthThePrice.reason ? [rec.worthThePrice.reason] : [])], src = new Map(rawFiles(path.join(srcDir, 'raw')).map((f) => [numOf(f), f]));
    const carried = ds.carry.map((f) => ({ name: f, sha256: sha256File(path.join(sd, 'raw', f)), sameAs: 'set-v' + ds.from + '/raw/' + f }));
    const out = { listingId: id, set: n, from: ds.from, qaPass: ds.qaPass, createdAt: new Date().toISOString(),
      note: 'W2 (owner, 20/10/2026): after QA DESIGN pass ' + ds.qaPass + ' asked for a revise of set-v' + ds.from + ', only the files it named (and any a build warning named) are redrawn; every other file is copied unchanged (same sha256). The build and QA DESIGN cover the whole set.',
      redraw: ds.files.map((k) => ({ n: k, was: src.get(k) || null, findings: texts.filter((t) => namedNums(t).includes(k)), buildWarnings: warnings.filter((w) => namedNums(w).includes(k)) })),
      carried, general: texts.filter((t) => !namedNums(t).length), file1Named: texts.some((t) => namedNums(t).includes(1)) };
    const srcMd = path.join(srcDir, 'design.md'), kept = keptSections(fs.existsSync(srcMd) ? fs.readFileSync(srcMd, 'utf8') : '', ds.carry.map(numOf));
    if (!fs.existsSync(path.join(sd, 'design.md'))) J.put(path.join(sd, 'design.md'), withStationPlan('# Design plan, set-v' + n + ' (rework of set-v' + ds.from + ' after QA DESIGN pass ' + ds.qaPass + ': files ' + ds.files.map(pad2).join(', ') + ' to redraw)\n\n'
      + '01 is the approved style reference (' + ref.name + ', from set-v' + ref.set + ').\n\n## Prompts of the files carried from set-v' + ds.from + ' (copied: prompt and analysis only)\n\n' + (kept.length ? kept.join('\n\n') : '(none found in set-v' + ds.from + '/design.md)') + '\n', stationPlan({ briefText: readBrief(id), product })));
    J.put(rf, JSON.stringify(out, null, 1) + '\n');
    return out;
  }
  // what QA DESIGN is told on a style-reference set: how a rework set was made, and that only the files it names are redrawn
  function reworkNote(job) {
    const { product } = productFor(dataRoot, job.id, productsOf(job.id)); if (!product || !usesStyleRef(product)) return '';
    const n = latestSet(dataRoot, job.id), rw = n ? readJson(path.join(jobDir(job.id), 'set-v' + n, 'rework.json')) : null;
    return (rw ? '\n\n[STATION — set-v' + n + ' reworks set-v' + rw.from + ' after QA DESIGN pass ' + rw.qaPass + '] Redrawn for your findings: ' + rw.redraw.map((r) => pad2(r.n)).join(', ') + '. Carried unchanged (copied byte for byte, same sha256) from set-v' + rw.from + ': ' + (rw.carried.map((c) => c.name).join(', ') || 'none') + '. Review EVERY file of the set as usual.' : '')
      + '\n\n[STATION] On revise, list each file to redraw in the record\'s "redraw" field by its file id (NN-subject, without .png' + (() => { const vf = setFileIds(job); return vf && vf.redrawable.length ? '; this set: ' + vf.redrawable[0] + ' to ' + vf.redrawable[vf.redrawable.length - 1] + '; 01 is the style reference and is never redrawn' : ''; })() + '): only those files, and any file a build warning names, are redrawn; every other file goes into the next set unchanged. Name only the files that MUST be redrawn: a file you call borderline or acceptable stays out of "redraw" and is carried unchanged. A revise without valid file ids is refused once; then the job stops for the owner.';
  }


  // one verdict channel: the record from submit_verdict is written by the engine and routes the job
  function routeVerdict(job, step, def, pass, run) {
    const folder = jobDir(job.id), kind = def.verdict;
    const dir = kind === 'design' ? 'qa' : 'qa-listing', prefix = kind === 'design' ? 'design-pass' : 'pass';
    // the pass number is the job's own counter (port item 20: never the count of files in a folder); a record already on disk under
    // that number is never overwritten (the counter moves past it)
    const qp = { ...(job.data.qaPasses || {}) }; let n = (qp[kind] || 0) + 1;
    while (fs.existsSync(path.join(folder, dir, prefix + n + '.json'))) n++;
    store.updateJob(job.id, { data: { qaPasses: { ...qp, [kind]: n } } });
    let rec = run.verdict;
    if (!rec) rec = { stage: kind, listingId: job.id, pass: n, verdict: 'revise', checks: {}, reasons: ['the QA run ended without a valid verdict (counts as revise)'], reviewer: def.agent.toUpperCase(), recordedBy: 'engine' };
    rec = { ...rec, pass: n, inputs: inputsRef(job.id) };
    J.put(path.join(folder, dir, prefix + n + '.json'), JSON.stringify(rec, null, 1) + '\n');
    if (rec.verdict === 'approved') J.put(path.join(folder, 'outbox', kind === 'design' ? 'qa-design.json' : 'qa-listing.json'), JSON.stringify(rec, null, 1) + '\n');
    log.info('verdict', { jobId: job.id, step, pass: n, verdict: rec.verdict, reasons: rec.reasons });
    // the owner's run modes stop after the verdict they were started for (QA-only: one QA DESIGN pass; listing-only: no package step,
    // no Rejects Desk: the owner decides what comes next)
    const mode = job.data.runMode;
    if (mode && mode.kind === 'qa-only') return { modeDone: 'QA-only run finished: QA DESIGN pass ' + n + ' ' + rec.verdict + ' (nothing listed or packaged; the owner decides next)' };
    if (mode && mode.kind === 'listing-only' && kind === 'listing' && rec.verdict === 'approved') return { modeDone: 'listing-only run finished: QA LISTING pass ' + n + ' approved (the package step is the owner\'s next action)' };
    if (rec.verdict === 'approved') return { next: def.onApproved, note: 'approved (pass ' + n + ')' };
    const o = def.onRevise, used = (job.loops || {})[o.loop] || 0;
    if (mode && mode.kind === 'listing-only' && kind === 'listing' && used >= o.max) return { modeDone: 'listing-only run finished: QA LISTING pass ' + n + ' ' + rec.verdict + ', no rework left (the owner decides: a text fix, an owner listing approval, or a re-run)' };
    // L3 (owner, 21/10/2026): a design revise that would go back to DESIGNER must name the files to redraw; without them the job blocks
    // with the reason (nothing is redrawn, no loop is used)
    if (kind === 'design' && used < o.max) { const nb = redrawBlock(job, rec); if (nb) { log.warn('QA DESIGN revise names no file to redraw: the job blocks', { jobId: job.id, pass: n, reason: nb }); return { blocked: 'QA DESIGN pass ' + n + ' asked for a revise without naming the files to redraw (' + nb + '): nothing is redrawn; the owner decides (a QA-only run, a redraw-only set, or the owner\'s set approval)' }; } }
    if (used < o.max) { store.updateJob(job.id, { loops: { [o.loop]: used + 1 } }); return { next: o.back, note: 'revise (pass ' + n + '): back to ' + o.back }; }
    const why = (kind === 'design' ? 'QA DESIGN' : 'QA LISTING') + ' did not approve after ' + (used + 1) + ' review(s) (' + o.loop + ' loop limit ' + o.max + '): ' + (rec.reasons || []).join('; ');
    store.updateJob(job.id, { data: { escalation: why } });
    return { next: o.escalate, note: 'loop exhausted: escalated to ' + o.escalate };
  }

  // ---- the build of a packaged set (lib/digital-build.mjs): the Designer's raw/ -> files/<zip> + listing preview, no model. A Designer
  // problem (raw names, count, a transparent background missing) is a prep failure; anything else (the upscaler pin, the binary failing,
  // the e-stop) blocks the job at once and is never retried through the Designer.
  async function buildStep(job, n, product, stopSignal) {
    if (usesStyleRef(product) && approvedRef(dataRoot, job.id).ok) {
      const s = ensureStyleRefInSet({ roomDir: dataRoot, id: job.id, n, log });
      if (!s.ok) return { ok: false, reason: 'style reference: ' + s.reason };
    }
    const signal = stopSignal ? AbortSignal.any([halt.signal, stopSignal]) : halt.signal;
    const upscaler = engine.upscaler || esrganUpscaler({ pin: cfg.engine.upscale, workDir: path.join(jobDir(job.id), 'set-v' + n), signal });
    let r;
    try { r = await buildDigitalSet({ roomDir: dataRoot, id: job.id, n, cfg: cfg.station, products: productsOf(job.id), upscaler, log }); }
    catch (e) {
      if (e.code === 'STOPPED' || signal.aborted) return { stopped: 'stopped during the set build: ' + e.message };
      return { blocked: 'the set build failed (no retry through the Designer): ' + e.message };
    }
    if (r.ok) log.info('set build', { jobId: job.id, set: n, action: r.action, warnings: (r.record && r.record.warnings) || [] });
    return r;
  }

  // ---- mechanical steps (fail closed)
  async function mechStep(job, step, def, stopSignal = null) {
    const fn = MECH[def.fn]; if (!fn) return { blocked: 'no mechanical step "' + def.fn + '"' };
    const r = await fn(job, def, stopSignal);
    log.info('mechanical step', { jobId: job.id, step, ok: !r.blocked, next: r.next || r.end || null, reason: r.blocked || r.note || undefined });
    return r;
  }
  // owner, 18/10/2026: the product spec defines the format, the brief the files. A set whose file NN does not match the brief's
  // item N (when the brief numbers as many files as the spec has) fails closed, at prep and before a QA-only run (lib/brief-files.mjs)
  function briefFilesCheck(id, n, product) {
    const sd = path.join(jobDir(id), 'set-v' + n), dir = fs.existsSync(path.join(sd, 'raw')) ? path.join(sd, 'raw') : path.join(sd, 'files');
    return briefFileProblems(readBrief(id), product, fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  }
  const MECH = {
    async prep(job, def, stopSignal) {
      const n = latestSet(dataRoot, job.id);
      let reason = null, filesNote = null;
      if (!n) reason = 'DESIGNER wrote no set-v<N> folder';
      else {
        // a packaged product (zip + preview): the station builds files/ from raw/ first (clean-up, Real-ESRGAN, zip), no model (owner,
        // 17/10/2026: the build runs in the engine; the upscaler is the pinned local binary, killed by the e-stop or the owner's Stop)
        const { product } = productFor(dataRoot, job.id, productsOf(job.id));
        if (product && isPackaged(product)) {
          const b = await buildStep(job, n, product, stopSignal);
          if (b.stopped || b.blocked) return b;
          if (!b.ok) reason = b.reason;
        }
        const files = path.join(jobDir(job.id), 'set-v' + n, 'files');
        if (reason) { /* the build refused the Designer's raw files */ }
        else if (!fs.existsSync(files) || !fs.readdirSync(files).length) reason = 'set-v' + n + '/files/ is empty: no deliverables';
        else {
          // the plan in design.md is the station's, from the current spec and brief (owner, 18/10/2026), before the set is measured and screened
          const dm = path.join(jobDir(job.id), 'set-v' + n, 'design.md');
          if (product && fs.existsSync(dm)) { const was = fs.readFileSync(dm, 'utf8'), now = withStationPlan(was, stationPlan({ briefText: readBrief(job.id), product })); if (now !== was) J.put(dm, now); }
          const r = prepareDigitalSet({ roomDir: dataRoot, id: job.id, n, cfg: cfg.station, products: productsOf(job.id), log });
          if (!r.ok) reason = r.reason;
          else if (r.originality.result === 'hit') reason = 'ORIGINALITY HARD FAIL in set-v' + n + '/design.md: ' + r.originality.hits.map((h) => hitLine(h)).join('; ');
          else { const bf = briefFilesCheck(job.id, n, product); filesNote = bf.note; if (bf.problems.length) reason = 'the set does not match the brief\'s file list: ' + bf.problems.join('; '); }
        }
      }
      if (!reason) return { next: def.next, note: 'set-v' + n + ' measured; originality clear' + (filesNote ? '; ' + filesNote : '') };
      // a redraw-only set is never sent back to DESIGNER from prep (that would redraw the whole set): the owner decides
      if (redrawPlanOf(job.id, n)) return { blocked: 'prep failed on the redraw-only set-v' + n + ' (no retry, no loop added): ' + reason };
      const used = (job.loops || {}).prep || 0;
      if (used < (def.onFail ? def.onFail.max : 0)) { store.updateJob(job.id, { loops: { prep: used + 1 }, data: { prepFailure: reason, prepFailureSeen: false } }); return { next: def.onFail.back, note: 'prep failed, back to ' + def.onFail.back + ' once: ' + reason }; }
      return { blocked: 'prep failed' + (used ? ' again after one retry' : '') + ': ' + reason };
    },
    priceFill(job, def) {
      const lf = path.join(jobDir(job.id), 'outbox', 'listing.json'), L = readJson(lf);
      if (!L) return { blocked: 'LISTER wrote no valid outbox/listing.json' };
      // the prompt files name the legacy path; the gate wants the engine's (jobs/<id>/set-vN/deliverables.json)
      const df = canonicalDesignFile(L.designFile, job.id);
      if (df && df !== L.designFile) { J.put(lf, JSON.stringify({ ...L, designFile: df }, null, 2) + '\n'); log.info('listing designFile normalised', { jobId: job.id, from: L.designFile, to: df }); }
      const r = fillDigitalPrices({ id: job.id, roomDir: dataRoot, cfg: cfg.station, products: productsOf(job.id), extra: cfg.blocklist, log });
      if (!r.ok) return { blocked: 'price fill: ' + r.reason };
      if (r.originality && r.originality.error) return { blocked: 'listing originality record failed: ' + r.originality.error };
      const og = readJson(path.join(jobDir(job.id), 'derived', 'listing.originality.json'));
      if (!og) return { blocked: 'listing originality record missing' };
      if (og.result === 'hit') return { blocked: 'ORIGINALITY HARD FAIL in the listing: ' + og.hits.map((h) => hitLine(h)).join('; ') };
      const w = listingWordWarnings(job);
      if (w.length) { log.warn('listing uses a scouted common-word title as a bare word (warning, not a fail): QA-LISTING checks the context', { jobId: job.id, warnings: w }); store.updateJob(job.id, { data: { commonWordWarnings: w } }); }
      return { next: def.next, note: 'prices and facts filled: ' + r.prices.map((p) => p.variant + ' EUR ' + p.priceEur).join(', ') + (w.length ? '; common-word warning for QA-LISTING: ' + w.join('; ') : '') };
    },
    packageGate(job, def) {
      const r = checkPackage({ id: job.id, roomDir: dataRoot, blocklist: cfg.blocklist, cfg: cfg.station, products: productsOf(job.id) });
      store.updateJob(job.id, { data: { gate: { ok: r.ok, reasons: r.reasons, at: Date.now() } } });
      if (!r.ok) return { blocked: 'QA passed, package gate failed: ' + r.reasons.join('; ') };
      return { next: def.next, note: 'package gate passed' };
    },
    package(job) { return buildPackage(job); },
    briefCheck(job) { return researchBriefCheck(job); },
    scoutNotes(job, def) { return scoutNotesStep(job, def); },
    scoutRetention(job, def) { return scoutRetentionStep(job, def); }
  };

  // ---- the package: what the owner uploads by hand. A ZIP product (deliverables.package zip) gets the ported digital package step
  // (lib/package-digital.mjs: the ZIP byte for byte, every file and ZIP entry with sha256, the owner's approvals and overrides, no
  // timestamps); other products keep the E3 package below (idempotent on the inputs' hash)
  function buildPackage(job) {
    const { product } = productFor(dataRoot, job.id, productsOf(job.id));
    if (product && isPackaged(product)) {
      const ap = store.getApproval(job.id);
      const r = packageDigital({ id: job.id, roomDir: dataRoot, blocklist: cfg.blocklist, cost: costRecord(job.id), approvalStatus: ap && ap.status, apply: true, cfg: cfg.station, products: productsOf(job.id), log });
      if (!r.ok) return { blocked: 'package step: ' + r.reasons.join('; ') };
      store.queueApproval(job.id);
      const so = designSignOff({ id: job.id, roomDir: dataRoot, cfg: cfg.station });
      trackerRow(job, { status: 'packaged', status_reason: so.source === 'owner-set-approval' ? 'design sign-off: owner set approval' : '', packaged_at: new Date().toISOString(), design_file: r.manifest.designFile, deliverables: String(r.manifest.zipEntries.length) + ' in ' + r.manifest.download, qa_design: so.source === 'owner-set-approval' ? 'owner-set-approval' : 'approved', qa_listing: r.manifest.gates.qaListing.ownerOverride ? 'owner-override' : r.manifest.gates.qaListing.verdict });
      return { end: 'approval', note: 'packaged in jobs/' + job.id + '/package/ (' + r.action + ')' };
    }
    const dir = jobDir(job.id), out = path.join(dir, 'package');
    const L = readJson(path.join(dir, 'outbox', 'listing.json')), qd = readJson(path.join(dir, 'outbox', 'qa-design.json')), ql = readJson(path.join(dir, 'outbox', 'qa-listing.json'));
    const n = Number(/set-v(\d+)/.exec(qd.designFile)[1]), setDir = path.join(dir, 'set-v' + n), manifest = readJson(path.join(setDir, 'deliverables.json'));
    const files = fs.readdirSync(path.join(setDir, 'files')).sort();
    const history = [...(fs.existsSync(path.join(dir, 'qa')) ? fs.readdirSync(path.join(dir, 'qa')).map((f) => 'qa/' + f) : []), ...(fs.existsSync(path.join(dir, 'qa-listing')) ? fs.readdirSync(path.join(dir, 'qa-listing')).map((f) => 'qa-listing/' + f) : [])].sort();
    const inputs = [...files.map((f) => 'set-v' + n + '/files/' + f), 'outbox/listing.json', 'outbox/qa-design.json', 'outbox/qa-listing.json', 'brief.md', ...history];
    const inputHash = sha256(inputs.map((r) => r + ':' + sha256(fs.readFileSync(path.join(dir, r)))).join('\n'));
    const old = readJson(path.join(out, 'MANIFEST.json'));
    const cost = costRecord(job.id);
    if (!(old && old.inputHash === inputHash)) {
      if (fs.existsSync(out)) J.move(out, path.join(dir, 'package-replaced-' + Date.now()));
      for (const f of files) J.copy(path.join(setDir, 'files', f), path.join(out, 'files', f));
      J.put(path.join(out, 'listing.json'), JSON.stringify(L, null, 2) + '\n');
      J.put(path.join(out, 'listing.md'), listingMd(L));
      J.put(path.join(out, 'qa-design.json'), JSON.stringify(qd, null, 1) + '\n');
      J.put(path.join(out, 'qa-listing.json'), JSON.stringify(ql, null, 1) + '\n');
      for (const h of history) J.copy(path.join(dir, h), path.join(out, 'qa-history', h.replace('/', '-')));
      J.copy(path.join(dir, 'brief.md'), path.join(out, 'brief.md'));
      const mf = {
        listingId: job.id, line: job.line, productKey: L.productKey, packagedAt: new Date().toISOString(), inputHash,
        gates: { packageGate: 'pass', checkedAt: new Date((job.data.gate || {}).at || Date.now()).toISOString(), reasons: [] },
        designFile: qd.designFile, deliverables: manifest.files.map(publicView), files: manifest.files.map((f) => ({ name: 'files/' + f.name, bytes: f.bytes, sha256: f.sha256 })),
        licence: L.licence, delivery: L.delivery, prices: { listingPriceEur: L.listingPriceEur, variantPricesEur: L.variantPricesEur, marginEstimate: L.marginEstimate, priceSuggestion: L.priceSuggestion },
        qa: { design: { pass: qd.pass, verdict: qd.verdict }, listing: { pass: ql.pass, verdict: ql.verdict }, history: history.length },
        ownerTodo: [...(L.ownerTodo || []), 'trademark clearance: a clear originality screen is not trademark clearance; check before publishing', 'upload the files in files/ to the Etsy listing by hand'],
        costUsd: cost.totalUsd, provider: engine.providers.mode, note: engine.providers.mode === 'mock' ? 'MOCK RUN: every model and image call was the mock provider; no model was called and nothing was charged' : undefined
      };
      J.put(path.join(out, 'MANIFEST.json'), JSON.stringify(mf, null, 2) + '\n');
    }
    J.put(path.join(out, 'cost.json'), JSON.stringify(cost, null, 2) + '\n');
    store.queueApproval(job.id);
    trackerRow(job, { status: 'packaged', status_reason: '', packaged_at: new Date().toISOString(), design_file: qd.designFile, deliverables: String(files.length), qa_design: 'approved', qa_listing: 'approved' });
    return { end: 'approval', note: 'packaged in jobs/' + job.id + '/package/' };
  }

  // cost.json: the ledger rows of THIS job (by jobId, not by time window), with workings; text, image and web apart
  function costRecord(id) {
    const rows = ledger.rowsForJob(id).map((r) => ({ entryId: r.entryId, at: new Date(r.ts).toISOString(), agent: r.agentKey, runId: r.runId, kind: r.kind, provider: r.provider, model: r.model, tokens: r.tokens, count: r.count, usd: r.usd, estimated: !!r.estimated, priceSource: r.priceSource }));
    const by = (k) => Math.round(rows.filter((r) => r.kind === k).reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6;
    const total = Math.round(rows.reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6;
    return { jobId: id, source: ledger.label + ' rows with jobId = ' + id, mock: rows.every((r) => r.provider === 'mock'), rows: rows.length, byKind: { text: by('text'), image: by('image'), web: by('web') }, totalUsd: total, workings: rows.length ? rows.map((r) => r.usd.toFixed(6)).join(' + ') + ' = ' + total.toFixed(6) : 'no rows = 0', detail: rows };
  }
  function listingMd(L) {
    return ['# ' + L.title, '', '**Tags:** ' + (L.tags || []).join(', '), '', '**Price:** EUR ' + L.listingPriceEur + ' · delivery: ' + L.delivery + ' · licence: ' + L.licence, '', '## Description', '', L.description || '', '', '## Alt text', '', L.altText || '', '', '## Files', '', ...(L.deliverables || []).map((d) => '- ' + d.name + ' (' + d.format + ', ' + d.widthPx + 'x' + d.heightPx + ' px)'), '', '## Owner to-do', '', ...(L.ownerTodo || []).map((t) => '- ' + t), ''].join('\n');
  }

  // ---- the research line's brief check: a draft that passes goes to research/briefs/ (verified), else research/rejected/
  function researchBriefCheck(job) {
    const day = job.data.day || dublinDay(), drafts = path.join(dataRoot, 'research', draftsDirOf(lineOf(job.line)), day), out = [];
    for (const f of fs.existsSync(drafts) ? fs.readdirSync(drafts).filter((x) => x.endsWith('.md')) : []) {
      const t = fs.readFileSync(path.join(drafts, f), 'utf8'), st = briefField(t, 'status');
      if (st !== 'verified') { out.push(f + ': ' + (st || 'no status') + ' (not moved)'); continue; }
      const ind = isIndicativeBrief(t), scout = isScoutBrief(t);
      // E7a (owner decision 1, 19/10/2026): no Etsy data from an agent: a draft in the ported Etsy demand-evidence format (any
      // brief that is not indicative) is rejected here, whatever its status says
      const c = ind ? checkBriefAll(t, { citationsJob: job.id, productKey: scout ? job.product_key || null : null })
        : { ok: false, reasons: ['not an indicative brief (origin ' + (scout ? 'genre-scout' : 'research') + '): agents write no Etsy demand evidence until Etsy authorises it in writing (owner, 19/10/2026)'], warnings: [] };
      // a verified indicative brief carries the station's citation record, so intake can check the citations again later
      const osp = ownerSetsPriceOf(t);
      const kept = ind && c.ok ? t.replace(/\s*$/, '\n') + '\n## Station brief check\n' + stationCitationLine(urlsIn(t).length, job.id) + '\n- evidence level: indicative (non-Etsy web search results only; competitor count not measured)\n' + (osp ? '- price: owner sets price (no cited result shows a price)\n' : '') : t;
      if (c.ok) { J.put(path.join(dataRoot, 'research', 'briefs', f), kept); out.push(f + ': verified -> briefs/ (evidence indicative' + (osp ? '; owner sets price' : '') + ')' + (c.warnings.length ? ' (common-word warning, not a fail: ' + c.warnings.join('; ') + ')' : '')); }
      else { J.put(path.join(dataRoot, 'research', 'rejected', f), t + '\n\n## Station brief check\n' + c.reasons.map((r) => '- ' + r).join('\n') + '\n'); out.push(f + ': rejected -> ' + c.reasons.join('; ')); }
    }
    return { end: 'research-done', reason: out.join(' | ') || 'no drafts for ' + day };
  }

  // ---- genre-trend scouting (DECISIONS.md): after TREND-SCOUT, before anyone else reads the drafts. The notes must be
  // valid (2 AAA + 2 indie, evidence links, dates); every recorded title, studio and alsoBlock name goes on the scouting
  // blocklist; then each genre-scout draft of the day is screened whole, and one naming a scouted game (or using
  // derivative wording) is moved to scouting/blocked/<day>/ with the reasons (it names a game, so it stays inside the
  // scout-only folder), so EVIDENCE-CHECKER never sees it. Idempotent on a re-run.
  // E6 b3: the notes are this job's own file (scouting/<day>/<jobId>/notes.json); the other jobs' notes of the day go
  // through the same blocklist pass (fail closed), and the job's own names reach the blocklist at its end in any case
  function scoutNotesStep(job, def) {
    const day = job.data.day || dublinDay(), rdir = researchDir(), nf = notesFile(rdir, day, job.id);
    if (!fs.existsSync(nf)) return { blocked: 'TREND-SCOUT wrote no scouting notes (' + notesRel(day, job.id) + ')' };
    const v = validateNotes(readJson(nf), { day });
    if (!v.ok) return { blocked: 'scouting notes refused: ' + v.problems.join('; ') };
    const own = blocklistJobNotes(job, 'scout-notes', day);
    let others = 0, otherAdded = 0;
    for (const n of readDayNotes(rdir, day).filter((x) => x.file !== nf)) { others++; otherAdded += blocklistFromNotes(J, rdir, n.notes, { day, jobId: n.jobId, log }).added.length; }
    log.info('scouting blocklist updated', { jobId: job.id, added: own.added, refusedNotNames: own.refused.length, games: v.entries.length, otherNotesToday: others, addedFromOtherNotes: otherAdded });
    const drafts = path.join(rdir, draftsDirOf(lineOf(job.line)), day), out = [];
    // E6 b2: EVERY draft in this line's drafts folder is a genre draft (b1's drafts were skipped because their origin line
    // was malformed): each is screened whole for scouted names and derivative wording, then checked against the one
    // genre brief schema (owner D3); a draft that fails the schema goes to rejected/ with the reasons
    for (const f of fs.existsSync(drafts) ? fs.readdirSync(drafts).filter((x) => x.endsWith('.md')).sort() : []) {
      const t = fs.readFileSync(path.join(drafts, f), 'utf8');
      const sp = scoutingBriefProblems(t, cfg.station, { scout: true });
      if (!sp.length) {
        const sv0 = validateScoutBrief(t, { day, file: f, productKey: job.product_key || null });
        // owner, 17/10/2026 ("prices as shown"): every price figure must be one this job's web calls returned
        // owner correction, 17/10/2026: and it may not hide a result under the floor that its own searches showed
        const prod = (cfg.products || []).find((x) => x.key === job.product_key) || null;
        const sv = sv0.ok ? (() => { const tf = transcriptOf(job.id), pp = [...priceStringProblems(t, returnedPrices(tf)), ...(prod ? hiddenRowProblems(t, searchPrices(tf), briefFloorUsd(prod, cfg.station)) : [])]; return pp.length ? { ...sv0, ok: false, problems: pp } : sv0; })() : sv0;
        if (!sv.ok) {
          J.move(path.join(drafts, f), path.join(rdir, 'rejected', f));
          J.put(path.join(rdir, 'rejected', f), t + '\n\n## Station brief schema\n' + sv.problems.map((r) => '- ' + r).join('\n') + '\n');
          out.push(f + ': schema invalid -> rejected/ (' + sv.problems.length + ' problem' + (sv.problems.length > 1 ? 's' : '') + ')');
          log.warn('genre draft refused by the brief schema at the screen', { jobId: job.id, file: f, problems: sv.problems });
          continue;
        }
        const w = commonWordWarnings({ brief: t }, commonWords(rdir));
        if (w.length) log.warn('genre brief uses a scouted common-word title as a bare word (warning, not a fail)', { jobId: job.id, file: f, warnings: w });
        out.push(f + ': screened clear' + (w.length ? ' (common-word warning, not a fail: ' + w.join('; ') + ')' : '')); continue;
      }
      const rf = J.move(path.join(drafts, f), path.join(rdir, SCOUT_DIR, 'blocked', day, f));   // moved, never deleted; it names a game, so it stays in scouting/
      J.put(rf, t + '\n\n## Station scouting screen\n' + sp.map((r) => '- ' + r).join('\n') + '\n');
      const shown = scoutingBriefProblems(f.replace(/\.md$/, '').replace(/-/g, ' '), cfg.station, { scout: true }).length ? '(a draft whose file name names a scouted game)' : f;   // job notes reach the office page
      out.push(shown + ': BLOCKED -> ' + SCOUT_DIR + '/blocked/' + day + '/ (' + sp.length + ' hit' + (sp.length > 1 ? 's' : '') + ')');
      log.warn('genre brief blocked by the scouting screen', { jobId: job.id, file: f, reasons: sp });
    }
    // refused blocklist terms are reported by kind and reason only (a refused term is a placeholder, but never assume)
    const refused = own.refused;
    store.updateJob(job.id, { data: { scouting: { games: v.entries.length, added: own.added, refusedNotNames: refused, ...(others ? { otherNotesToday: others, addedFromOtherNotes: otherAdded } : {}), drafts: out } } });
    return { next: def.next, note: 'scouting notes valid (' + v.entries.length + ' games, ' + own.added + ' new blocklist names' + (refused.length ? ', ' + refused.length + ' not-a-name term(s) refused' : '') + (others ? '; ' + others + ' other notes file(s) today, ' + otherAdded + ' name(s) added from them' : '') + '); ' + (out.join(' | ') || 'no genre drafts') };
  }

  // ---- E6 b3 (owner, 17/10/2026): a scout job's names reach the blocklist whatever the job's outcome (done, research-done,
  // incomplete, report_blocked, failed, cap, e-stop, the owner's Stop, a crash, restart recovery), not only after a normal
  // TREND-SCOUT finish. Once per job: the job record keeps the sha256 of the notes it passed (data.scoutBlocklist; kinds
  // and counts only, never a name), so the same notes are not passed again (scout-notes, then the job's end); the pass
  // itself is idempotent in any case.
  const ENDED = [...TERMINAL, 'incomplete', 'archived'];
  const isScoutJob = (job) => job.kind === 'research' && Object.values((cfg.lines[job.line] || {}).steps || {}).some((s) => s.kind === 'agent' && (cfg.agents[s.agent] || {}).scoutingNotes);
  function blocklistJobNotes(job, when, day = job.data.day) {
    const nf = day ? notesFile(researchDir(), day, job.id) : null;
    if (!nf || !fs.existsSync(nf)) return null;
    const bytes = fs.readFileSync(nf), sha = sha256(bytes), prev = job.data.scoutBlocklist;
    if (prev && prev.notesSha256 === sha) return prev;
    let notes = null; try { notes = JSON.parse(bytes.toString('utf8')); } catch (_) { /* unreadable: blocklistFromNotes says so */ }
    const r = blocklistFromNotes(J, researchDir(), notes, { day, jobId: job.id, log });
    const rec = { notesSha256: sha, when, at: Date.now(), games: r.games, added: r.added.length, refused: r.refused.map((x) => ({ kind: x.kind, reason: x.reason })), notesProblems: r.problems.length, unreadable: r.unreadable };
    store.updateJob(job.id, { data: { scoutBlocklist: rec } });
    log.info('scouting blocklist pass', { jobId: job.id, when, games: r.games, added: r.added.length, refused: r.refused.length, notesProblems: r.problems.length });
    return rec;
  }
  // called when a job has ended (startJob, the owner's Stop of a queued job, restart recovery); never throws
  function blocklistOnEnd(id) {
    try {
      const job = store.getJob(id);
      if (!job || !ENDED.includes(job.state) || !isScoutJob(job)) return null;
      return blocklistJobNotes(job, 'job end (' + job.state + ')');
    } catch (e) { log.error('scouting blocklist pass at the job end failed', { jobId: id, error: String(e && e.stack || e) }); return null; }
  }

  // ---- scouting retention (owner, 17/10/2026): the first step of every scout run deletes the scouting notes
  // (scouting/<day>/, scouting/blocked/<day>/) whose day is more than 90 days old; every deletion is logged; the
  // scouting blocklist is never deleted. Idempotent: a second run the same day finds nothing.
  function scoutRetentionStep(job, def) {
    const day = job.data.day || dublinDay(), gone = pruneScouting(J, researchDir(), day);
    for (const g of gone) log.info('scouting notes deleted (retention ' + RETENTION_DAYS + ' days)', { jobId: job.id, folder: 'research/' + g.folder, day: g.day, today: day });
    log.info('scouting retention checked', { jobId: job.id, today: day, keepDays: RETENTION_DAYS, deleted: gone.length });
    return { next: def.next, note: 'scouting retention (' + RETENTION_DAYS + ' days): ' + (gone.length ? 'deleted ' + gone.map((g) => g.folder).join(', ') : 'nothing to delete') + '; the blocklist is kept' };
  }

  // ---- research jobs (the research line and the genre-scout line)
  // productKey (owner, 17/10/2026, "product key as data"): a line with requiresProductKey (the genre scout) runs for one
  // product key, carried as data on the job. Not given (undefined) -> the line config's default (config/lines/*.json
  // productKey), never anything from prompt wording; it is checked against products.json when the job starts (runSteps)
  function createResearchJob({ input = 'Run your standing orders for this batch.', by = 'owner', line = 'research', productKey } = {}) {
    const L = lineOf(line); if (L.kind !== 'research') throw new Error('not a research line: ' + line);
    const hold = engine.lineHold ? engine.lineHold(L.id) : null;
    if (hold) throw Object.assign(new Error(hold), { code: /^archived/.test(hold) ? 'ARCHIVED' : 'PAUSED' });
    const day = dublinDay(), n = store.listJobs().filter((j) => j.kind === 'research' && (j.line || 'research') === line && j.id.startsWith(day)).length + 1, id = day + '--' + line + '-' + n;
    const key = L.requiresProductKey ? (productKey !== undefined ? productKey : L.productKey) ?? null : null;
    store.insertJob({ id, line, kind: 'research', title: (L.label || 'Research') + ' batch ' + n, product_key: key, state: 'queued', step: L.start, data: { day, input, createdBy: by, ...(L.requiresProductKey ? { productKey: key, productKeySource: productKey !== undefined ? 'given' : 'line config' } : {}) } });
    bus.emit('job.created', { jobId: id, data: { line, by } });
    return { ok: true, id };
  }

  // ---- the owner's actions from the office (E5). Every one checks the record's version first (a stale tab is refused
  // before anything is written), refuses legacy history, and refuses to start anything while the e-stop is on.
  const ownJob = (id) => { const j = store.getJob(id); if (!j) throw new Error('no such job: ' + id); if (j.legacy || j.kind === 'legacy') throw new Error('legacy history is read only'); return j; };
  const checkVersion = (j, expectedVersion) => { if (expectedVersion == null || !Number.isInteger(expectedVersion)) throw new Error('expectedVersion is required'); if (j.version !== expectedVersion) throw new VersionConflict('job ' + j.id, j.version, expectedVersion); };
  const notHalted = (what) => { if (halt.isHalted()) { const e = new Error('e-stop is on: ' + what + ' refused until you resume'); e.code = 'HALTED'; throw e; } };
  // the job's state as the owner sees it: a job in the approval queue takes the approval row's decision
  function effState(j) {
    if (j.state !== 'approval') return j.state;
    const a = store.getApproval(j.id);
    return a && ['approved', 'published', 'rejected_by_owner'].includes(a.status) ? a.status : 'approval';
  }
  // move job files into jobs/<id>/rerun-archive-<stamp>/ (never deleted); returns the folder relative to the data root
  function archiveFiles(id, names) {
    const dir = jobDir(id), rel = 'rerun-archive-' + stamp(), moved = [];
    for (const n of names) { const f = path.join(dir, n); if (fs.existsSync(f)) { J.move(f, path.join(dir, rel, n)); moved.push(n); } }
    if (moved.length) log.info('job files archived', { jobId: id, folder: 'jobs/' + id + '/' + rel, moved });
    return { folder: moved.length ? 'jobs/' + id + '/' + rel : null, moved };
  }
  const RESTARTABLE = ['blocked', 'stopped'], ARCHIVABLE = ['blocked', 'stopped', 'rejected', 'rejected_by_owner', 'research-done'], RERUNNABLE = ['approval', 'rejected_by_owner', 'blocked', 'stopped', 'rejected'];
  // which controls a job offers (the snapshot shows only these buttons; each action checks again)
  function controlsFor(j) {
    if (!j || j.legacy || j.kind === 'legacy') return {};
    const st = effState(j), running = isActive(j.id) || j.state === 'running';
    const designOk = j.kind === 'line' && fs.existsSync(path.join(jobDir(j.id), 'outbox', 'qa-design.json'));
    const ap = store.getApproval(j.id);
    return {
      stop: running || (j.state === 'queued' && !isActive(j.id)),
      // a queued job that is not running and not waiting for an off-duty agent (e.g. left queued by the e-stop) can be started again
      restart: !running && (RESTARTABLE.includes(st) || (j.state === 'queued' && !(j.data && j.data.waitingFor))),
      archive: !running && ARCHIVABLE.includes(st),
      rerunListing: !running && designOk && RERUNNABLE.includes(st) && !(ap && ['approved', 'published'].includes(ap.status)),
      approve: !!ap && ap.status === 'pending' && j.state === 'approval', reject: !!ap && ap.status === 'pending' && j.state === 'approval', publish: !!ap && ap.status === 'approved',
      // L2, steering from the job panel: an owner amendment (the frozen-inputs record), the owner's decision on file 1 when the job waits
      // for it (ownerFile1), the owner's set approval or rejection with the owner's words, and where the CLI fix tools apply
      ...steering(j, st, running)
    };
  }
  function steering(j, st, running) {
    if (j.kind !== 'line' || running || ['archived', 'approved', 'published'].includes(st)) return {};
    const aw = j.data && j.data.styleRef && j.data.styleRef.awaiting, n = latestSet(dataRoot, j.id);
    const stoppedWithSet = n > 0 && ['blocked', 'stopped', 'rejected', 'incomplete'].includes(j.state) && fs.existsSync(path.join(jobDir(j.id), 'qa'));
    // W4 (owner, 21/10/2026): Approve / Reject set-vN only for a built set the approval would be accepted on; otherwise one line says why
    let sd = null;
    if (stoppedWithSet) { let total = null; try { const p = productFor(dataRoot, j.id, productsOf(j.id)).product; total = p && p.deliverables && p.deliverables.files ? p.deliverables.files.length : null; } catch (_) { total = null; } sd = setDecisionState({ roomDir: dataRoot, id: j.id, newest: n, total }); }
    return {
      amend: j.state !== 'approval' && fs.existsSync(path.join(jobDir(j.id), 'brief.md')),
      file1: j.state === 'queued' && j.data && j.data.waitingFor === 'owner-style-ref' && aw ? { set: aw.set } : null,
      setDecision: sd && sd.ok ? { set: sd.set, ...(sd.rule ? { rule: sd.rule, reviewedPreviews: sd.reviewedPreviews } : {}) } : null,
      setDecisionNote: sd ? sd.note : null,
      fixTools: n > 0 && ['blocked', 'stopped', 'rejected', 'incomplete'].includes(j.state) ? { set: n } : null
    };
  }

  // Stop: a running job's call in flight is aborted (this job only); a queued job is stopped at once. A running job's
  // version moves at every step, so a Stop sent with an older version is still accepted while that job is running
  // (stopping overwrites nothing); once it has finished or changed state, an old version is refused as stale.
  function stopJob(id, { expectedVersion, by = 'owner' } = {}) {
    if (engJob(store.getJob(id)) && engine.engineering) return engine.engineering.stop(id, { expectedVersion, by });
    const j = ownJob(id);
    const running = isActive(id) && stops.has(id);
    if (!(running && Number.isInteger(expectedVersion) && expectedVersion <= j.version)) checkVersion(j, expectedVersion);
    if (running) {
      if (expectedVersion !== j.version) log.info('stop sent with an older version of a running job: accepted', { jobId: id, had: expectedVersion, now: j.version });
      store.updateJob(id, { data: { stopRequested: Date.now() } });
      stops.get(id).abort(Object.assign(new Error('stopped by the owner'), { code: 'STOPPED' }));
      log.warn('job stop requested', { jobId: id, step: j.step, by });
      return { jobId: id, stopping: true };
    }
    if (!['queued', 'running'].includes(j.state)) throw new Error('job ' + id + ' is ' + j.state + ': nothing to stop');
    const out = store.updateJob(id, { state: 'stopped', reason: 'stopped by the owner at ' + (j.step || 'the start'), ended_at: Date.now(), data: { waitingFor: null, autoStart: false } }, { expectedVersion });
    bus.emit('job.stopped', { jobId: id, data: { state: out.state, step: out.step, reason: out.reason, by } });
    log.warn('job stopped', { jobId: id, by });
    blocklistOnEnd(id);
    return { jobId: id, stopped: true };
  }

  // Restart: from the step it stopped or was blocked at, within the caps (the guard still checks every call)
  function restartJob(id, { expectedVersion, by = 'owner' } = {}) {
    if (engJob(store.getJob(id)) && engine.engineering) return engine.engineering.resume(id, { expectedVersion, by });
    const j = ownJob(id); checkVersion(j, expectedVersion);
    if (!controlsFor(j).restart) throw new Error('job ' + id + ' is ' + effState(j) + ': only a blocked or stopped job can be restarted');
    notHalted('restart');
    mockGuard(id, 'a restart');
    const spent = ledger.spent.job(id), cap = cfg.engine.caps.perJobUsd;
    if (spent >= cap) throw new Error('job cap reached (' + spent.toFixed(2) + ' of ' + cap.toFixed(2) + '): a restart would be refused at its first call');
    const L = lineOf(j.line), step = j.step && L.steps[j.step] ? j.step : L.start;
    store.updateJob(id, { state: 'queued', step, reason: 'restarted by the owner at ' + step, ended_at: null, data: { visited: (j.data.visited || []).filter((x) => x !== step), restarts: (j.data.restarts || 0) + 1, autoStart: true, waitingFor: null, stopRequested: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step, restart: true, by } });
    log.info('job restarted', { jobId: id, step, by, spentUsd: spent });
    const run = startJob(id);
    return { jobId: id, step, started: isActive(id), ...(run ? { run } : {}) };
  }

  // Archive: the job leaves the board; its files move to jobs/<id>/rerun-archive-<stamp>/ (brief.md stays), never deleted
  function archiveJob(id, { expectedVersion, by = 'owner' } = {}) {
    if (engJob(store.getJob(id)) && engine.engineering) return engine.engineering.archive(id, { expectedVersion, by });
    const j = ownJob(id); checkVersion(j, expectedVersion);
    const st = effState(j);
    if (!controlsFor(j).archive) throw new Error('job ' + id + ' is ' + st + ': only a blocked, stopped, rejected or finished research job can be archived');
    const dir = jobDir(id);
    const names = j.kind === 'research' || !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter((n) => n !== 'brief.md' && !n.startsWith('rerun-archive-'));
    const a = archiveFiles(id, names);
    store.updateJob(id, { state: 'archived', reason: 'archived by the owner' + (a.folder ? '; files in ' + a.folder : ''), data: { archivedFrom: st, archiveFolder: a.folder, archivedAt: Date.now() } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'archived', step: j.step, by } });
    return { jobId: id, archived: true, folder: a.folder, moved: a.moved.length };
  }

  // Re-run listing on a QA-approved design: the listing, its QA records and the package move to rerun-archive-*, the
  // approval row (if any) is superseded, and the job runs again from LISTER
  function rerunListing(id, { expectedVersion, by = 'owner' } = {}) {
    const j = ownJob(id); checkVersion(j, expectedVersion);
    if (!controlsFor(j).rerunListing) throw new Error('job ' + id + ' has no QA-approved design to re-list, or is ' + effState(j));
    notHalted('re-run listing');
    const a = archiveFiles(id, ['outbox/listing.json', 'outbox/qa-listing.json', 'qa-listing', 'package', 'REJECTED.md']);
    const ap = store.getApproval(id);
    if (ap && ap.status !== 'superseded') store.decideApproval(id, { status: 'superseded', decided_at: Date.now(), reason: 'listing re-run by the owner' });
    trackerRow(j, { status: '', status_reason: 'listing re-run by the owner' + (a.folder ? '; old listing in ' + a.folder : '') });
    store.updateJob(id, { state: 'queued', step: 'lister', loops: { listing: 0 }, reason: 'listing re-run by the owner', ended_at: null, data: { visited: (j.data.visited || []).filter((x) => !['lister', 'qa-listing'].includes(x)), escalation: null, gate: null, rerunListing: (j.data.rerunListing || 0) + 1, autoStart: true, waitingFor: null, stopRequested: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step: 'lister', rerunListing: true, by } });
    log.info('listing re-run', { jobId: id, archived: a.folder, by });
    startJob(id);
    return { jobId: id, folder: a.folder };
  }

  // ---- the owner's run modes on an existing set (legacy run-line --qa-only / --listing-only, port items 23 and 27) and the package step.
  // Allowed on a job that has stopped (blocked, stopped, or rejected by QA's loop limit), never on legacy history, never under the e-stop.
  const MODE_STATES = ['blocked', 'stopped', 'rejected'];
  // the run's promise rides along without being sent to the page (tests await it)
  const withRun = (out, promise) => Object.defineProperty(out, 'run', { value: promise, enumerable: false });
  // the owner's run modes; a mode that runs an agent (model: true) is refused on the mock for a job with live spend (mockGuard)
  const forMode = (id, expectedVersion, what, { model = true } = {}) => {
    const j = ownJob(id); checkVersion(j, expectedVersion); notHalted(what);
    if (model) mockGuard(id, what);
    if (isActive(id) || !MODE_STATES.includes(j.state)) throw new Error('job ' + id + ' is ' + effState(j) + ': ' + what + ' needs a blocked, stopped or rejected job');
    if (j.kind !== 'line') throw new Error(what + ' is for line jobs');
    return j;
  };
  const capOf = (maxUsd) => { const c = Number(maxUsd); if (!(c > 0)) throw new Error('the owner\'s spend cap is required (maxUsd > 0)'); if (c > cfg.engine.caps.perJobUsd) throw new Error('maxUsd ' + c + ' is over the per-job cap ' + cfg.engine.caps.perJobUsd + ' (caps are raised only by the owner, in config/engine.json)'); return c; };
  // QA ONLY: one QA DESIGN pass on set N as it stands, with the owner's overrides (verbatim, tied to the file bytes) as context; the
  // Designer is not run; stops after the verdict whatever it is
  function qaOnly(id, { set, maxUsd, expectedVersion, by = 'owner' } = {}) {
    const j = forMode(id, expectedVersion, 'a QA-only run'), cap = capOf(maxUsd), n = Number(set), dir = jobDir(id), sd = path.join(dir, 'set-v' + n), reasons = [];
    if (!Number.isInteger(n) || n < 1 || !fs.existsSync(sd)) throw new Error('jobs/' + id + '/set-v' + set + ' does not exist');
    // the package gate allows 3 design passes (legacy maxDesignPasses): a pass past it could never be packaged, so it is not paid for
    const used = designPasses(dir).length;
    if (used >= 3) throw new Error('QA-only run refused: ' + used + ' of 3 design passes are on disk; a further QA DESIGN pass could never be packaged (the owner\'s set approval stands in after the pass limit)');
    const rv = readJsonSafe(path.join(dir, 'owner-review.json')), review = rv.ok ? rv.v : null;
    const overrides = review && review.set === n && Array.isArray(review.files) ? review.files.filter((f) => f.overridesQa === true) : [];
    for (const o of overrides) {
      const f = path.join(sd, 'raw', o.name);
      if (!fs.existsSync(f)) reasons.push('override file set-v' + n + '/raw/' + o.name + ' is missing');
      else if (sha256(fs.readFileSync(f)) !== o.rawSha256) reasons.push(o.name + ' changed since the owner decided on it (raw sha256 differs): the override does not apply to these bytes');
    }
    if (reasons.length) throw new Error('QA-only run refused: ' + reasons.join('; '));
    const pd = prepareDigitalSet({ roomDir: dataRoot, id, n, cfg: cfg.station, products: productsOf(id), log });
    if (!pd.ok) throw new Error('QA-only run refused: set preparation failed: ' + pd.reason);
    const bf = briefFilesCheck(id, n, productFor(dataRoot, id, productsOf(id)).product);
    if (bf.problems.length) throw new Error('QA-only run refused: the set does not match the brief\'s file list: ' + bf.problems.join('; '));
    const lines = ['[RUN MODE: QA ONLY — the owner asked for one QA DESIGN pass on this set as it stands. The Designer is not run.]'];
    if (overrides.length) {
      lines.push('OWNER DECISIONS (' + review.date + ', recorded in work/' + id + '/owner-review.json; they overrule an earlier QA DESIGN finding on the point named, nothing else):');
      for (const o of overrides) lines.push('- ' + o.name + ': ' + String(o.decision).toUpperCase() + '. Earlier QA finding: "' + o.qaSaid + '". Owner: "' + o.reason + '". Do not fail this file on that point. Still check it for everything else (originality, transparency, consistency with the set, file specs); report any new problem as a finding, never as overridden.');
    }
    if (fs.existsSync(path.join(sd, 'edits.json'))) lines.push('STATION EDITS: work/' + id + '/set-v' + n + '/edits.json records the owner-authorised deterministic edits of raw files after the Designer finished (it says which files and why); design.md describes the Designer\'s originals.');
    lines.push('', '```', 'LISTING_ID: ' + id, 'BRIEF: work/' + id + '/brief.md', 'DESIGN: work/' + id + '/set-v' + n + '/deliverables.json', 'STAGE_DONE: DESIGNER', '```');
    store.updateJob(id, { state: 'queued', step: 'qa-design', reason: 'QA-only run started by the owner (cap USD ' + cap.toFixed(2) + ')', ended_at: null, data: { runMode: { kind: 'qa-only', set: n, maxUsd: cap, by, startText: lines.join('\n'), overrides: overrides.map((o) => o.name) }, runCapUsd: cap, visited: (j.data.visited || []).filter((x) => x !== 'qa-design'), autoStart: true, waitingFor: null, stopRequested: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step: 'qa-design', runMode: 'qa-only', by } });
    log.info('QA-only run', { jobId: id, set: n, maxUsd: cap, overrides: overrides.map((o) => o.name), measured: { files: pd.manifest.count, limitProblems: pd.manifest.limitProblems, buildWarnings: pd.manifest.buildWarnings, originality: pd.originality.result } });
    return withRun({ jobId: id, mode: 'qa-only', set: n, maxUsd: cap, overrides: overrides.map((o) => o.name) }, startJob(id));
  }
  // REDRAW ONLY (owner decision 3, 18/10/2026; DECISIONS.md "E6 step c: redraw-only mode, cleanup pass, mock guard"), for a style-reference
  // product: a new set made of the owner-approved file 1, an earlier set's files QA DESIGN did not fail (copied byte for byte), files the
  // station cleans strictly at $0 (lib/strict-cleanup.mjs), and the files DESIGNER redraws, each with QA DESIGN's finding as its brief.
  //   prepareRedraw   station code, no model, $0 (allowed under the e-stop): writes set-vN (raw/, design.md copied, cleanup.json, the
  //                   before/after review images of the cleaned files, redraw.json). Re-run with another plan before the set is drawn: the
  //                   old prepared set is moved to jobs/<id>/redraw-replaced-<stamp>/ (never deleted); the same plan again changes nothing.
  //   redrawOnly      the run mode: one DESIGNER run draws only the named files (the image tool refuses any other number), then the line
  //                   runs on from prep. It is the next design loop (loops.design + 1), so a QA DESIGN revise past the loop limit goes to
  //                   the Rejects Desk as always; no loop is added.
  const redrawPlanOf = (id, n) => (n ? readJson(path.join(jobDir(id), 'set-v' + n, 'redraw.json')) : null);
  const numOf = (f) => Number((/^(\d{2})-/.exec(String(f)) || [])[1]) || null;
  async function prepareRedraw(id, { from, clean = [], redraw = [], expectedVersion, by = 'owner', signal = null } = {}) {
    const j = ownJob(id); checkVersion(j, expectedVersion);
    if (isActive(id) || !MODE_STATES.includes(j.state)) throw new Error('job ' + id + ' is ' + effState(j) + ': a redraw needs a blocked, stopped or rejected job');
    const { product } = productFor(dataRoot, id, productsOf(id));
    if (!product || !usesStyleRef(product) || !isPackaged(product)) throw new Error('redraw-only is for a packaged style-reference product');
    const a = approvedRef(dataRoot, id); if (!a.ok) throw new Error('redraw refused: no owner-approved file 1 (' + a.reason + ')');
    const total = product.deliverables.files.length, src = Number(from), srcRaw = path.join(jobDir(id), 'set-v' + src, 'raw');
    if (!Number.isInteger(src) || !fs.existsSync(srcRaw)) throw new Error('redraw refused: jobs/' + id + '/set-v' + from + '/raw does not exist');
    const srcFiles = new Map(fs.readdirSync(srcRaw).filter((f) => /\.png$/i.test(f) && numOf(f)).map((f) => [numOf(f), f]));
    const cleanN = clean.map(Number), list = redraw.map((r) => ({ n: Number(r.file), finding: String(r.finding || '').trim() })), seen = new Set(), bad = [];
    for (const k of [...cleanN, ...list.map((r) => r.n)]) { if (!Number.isInteger(k) || k < 2 || k > total) bad.push('file ' + k + ' is not one of 02–' + pad2(total)); else if (seen.has(k)) bad.push('file ' + pad2(k) + ' is named twice'); seen.add(k); }
    for (const k of cleanN) if (!srcFiles.has(k)) bad.push('set-v' + src + ' has no file ' + pad2(k) + ' to clean');
    for (const r of list) if (r.finding.length < 10) bad.push('file ' + pad2(r.n) + ' needs QA DESIGN\'s finding as its brief');
    const keep = []; for (let k = 2; k <= total; k++) if (!seen.has(k)) { if (srcFiles.has(k)) keep.push(k); else bad.push('set-v' + src + ' has no file ' + pad2(k) + ' to reuse'); }
    if (bad.length) throw new Error('redraw plan refused: ' + bad.join('; '));
    const items = briefFileList(readBrief(id)), itemOf = (k) => (items.length === total && items[k - 1] ? items[k - 1].text : null);
    const want = { from: src, keep: keep.map((k) => srcFiles.get(k)), clean: cleanN.map((k) => srcFiles.get(k)), redraw: list.map((r) => ({ n: r.n, was: srcFiles.get(r.n) || null, item: itemOf(r.n), finding: r.finding })), file1: { name: a.ref.name, sha256: a.ref.sha256 } };
    // the same plan on a prepared, undrawn set: unchanged; another plan: that set is moved aside and prepared again at the same number
    const latest = latestSet(dataRoot, id), lp = redrawPlanOf(id, latest);
    if (lp && lp.status === 'prepared' && JSON.stringify(lp.plan) === JSON.stringify(want)) return { jobId: id, set: latest, action: 'unchanged', plan: lp };
    if (lp && lp.status === 'prepared') J.move(path.join(jobDir(id), 'set-v' + latest), path.join(jobDir(id), 'redraw-replaced-' + stamp(), 'set-v' + latest));
    const n = lp && lp.status === 'prepared' ? latest : latest + 1, sd = path.join(jobDir(id), 'set-v' + n), raw = path.join(sd, 'raw'), rv = path.join(sd, 'review');
    J.makeDir(raw);
    const e1 = ensureStyleRefInSet({ roomDir: dataRoot, id, n, log }); if (!e1.ok) throw new Error('redraw refused: file 1: ' + e1.reason);
    const kept = want.keep.map((f) => { J.copy(path.join(srcRaw, f), path.join(raw, f)); return { name: f, sha256: sha256File(path.join(raw, f)) }; });
    // design.md from the CURRENT spec and brief (owner, 18/10/2026): the station plan, then only the kept files' own sections (prompt and
    // analysis) from set-v<from>/design.md; the earlier set's notes are never carried over (lib/design-plan.mjs)
    const srcMd = path.join(jobDir(id), 'set-v' + src, 'design.md'), oldMd = fs.existsSync(srcMd) ? fs.readFileSync(srcMd, 'utf8') : '';
    const carried = keptSections(oldMd, [...keep, ...cleanN]);
    J.put(path.join(sd, 'design.md'), withStationPlan('# Design plan, set-v' + n + ' (redraw-only set from set-v' + src + ': files ' + (list.map((r) => pad2(r.n)).join(', ') || 'none') + ' to draw)\n\n'
      + '01 is the owner-approved style reference (' + a.ref.name + ', from set-v' + a.ref.set + ').\n\n## Prompts of the files kept from set-v' + src + ' (copied: prompt and analysis only)\n\n' + (carried.length ? carried.join('\n\n') : '(none found in set-v' + src + '/design.md)') + '\n', stationPlan({ briefText: readBrief(id), product })));
    const upscaler = engine.upscaler || esrganUpscaler({ pin: cfg.engine.upscale, workDir: sd, signal });
    const bgs = cfg.station.digital.styleReference.review.backgrounds, cleaned = [];
    for (const f of want.clean) {
      const k = numOf(f), base = f.replace(/\.png$/i, ''), spec = product.deliverables.files[k - 1];
      const rec = await strictCleanFile({ input: path.join(srcRaw, f), output: path.join(raw, f) });
      const tmpDir = path.join(sd, '.tmp-redraw-' + process.pid), built = path.join(tmpDir, f);
      J.makeDir(tmpDir);
      let b; try { b = await processFile({ input: path.join(raw, f), output: built, widthPx: spec.widthPx, heightPx: spec.heightPx, cfg: cfg.station, upscaler, tmpDir, log }); if (b.ok) b.buf = fs.readFileSync(built); } finally { J.remove(tmpDir); }
      if (!b.ok) throw new Error('redraw refused: the cleaned ' + f + ' did not build: ' + b.reason);
      const beforeFile = path.join(jobDir(id), 'set-v' + src, 'build', f);
      const before = fs.existsSync(beforeFile) ? await writeFlattened({ buf: fs.readFileSync(beforeFile), dir: rv, base: base + '-before', backgrounds: bgs, rel: 'jobs/' + id + '/set-v' + n + '/review' }) : null;
      const after = await writeFlattened({ buf: b.buf, dir: rv, base: base + '-after', backgrounds: bgs, rel: 'jobs/' + id + '/set-v' + n + '/review' });
      cleaned.push({ name: f, ...rec, built: { cleanup: b.record.cleanup }, review: { before: before || 'set-v' + src + '/build/' + f + ' missing: no before image', after } });
      log.info('strict clean-up', { jobId: id, set: n, file: f, removedPx: rec.removedPx, regionsRemoved: rec.regionsRemoved, flooredPx: rec.flooredPx });
    }
    J.put(path.join(sd, 'cleanup.json'), JSON.stringify({ listingId: id, set: n, from: src, note: 'the station\'s strict clean-up of disconnected faint regions (lib/strict-cleanup.mjs), $0, no model; before = set-v' + src + '/build as delivered, after = the cleaned raw built the same way', files: cleaned }, null, 1) + '\n');
    const plan = { listingId: id, set: n, status: 'prepared', preparedBy: by, preparedAt: new Date().toISOString(), plan: want, kept, cleaned: cleaned.map((c) => ({ name: c.name, removedPx: c.removedPx, regionsRemoved: c.regionsRemoved, sha256: c.output.sha256 })) };
    J.put(path.join(sd, 'redraw.json'), JSON.stringify(plan, null, 1) + '\n');
    store.updateJob(id, { reason: 'redraw-only set-v' + n + ' prepared (files ' + (list.map((r) => pad2(r.n)).join(', ') || 'none') + ' to draw); the owner starts it', data: { redraw: { set: n, from: src, status: 'prepared' } } });
    log.info('redraw-only set prepared', { jobId: id, set: n, from: src, keep: want.keep.length, clean: want.clean.length, redraw: list.map((r) => r.n), by });
    return { jobId: id, set: n, action: 'prepared', plan, cleanup: cleaned };
  }
  function redrawOnly(id, { maxUsd = null, expectedVersion, by = 'owner' } = {}) {
    const j = forMode(id, expectedVersion, 'a redraw-only run'), n = latestSet(dataRoot, id), p = redrawPlanOf(id, n);
    if (!p || p.status !== 'prepared') throw new Error('redraw-only run refused: set-v' + n + ' is not a prepared redraw set (run prepare-redraw first)');
    const L = lineOf(j.line), max = (L.steps['qa-design'].onRevise || {}).max ?? 2, used = (j.loops || {}).design || 0;
    if (used >= max) throw new Error('redraw-only run refused: no design loop left (' + used + ' of ' + max + ' used); a loop is never added');
    const spent = ledger.spent.job(id); if (spent >= cfg.engine.caps.perJobUsd) throw new Error('job cap reached (' + spent.toFixed(2) + ' of ' + cfg.engine.caps.perJobUsd.toFixed(2) + ')');
    const cap = maxUsd != null ? capOf(maxUsd) : null, files = p.plan.redraw.map((r) => r.n), step = files.length ? 'designer' : 'prep';
    store.updateJob(id, { state: 'queued', step, loops: { design: used + 1 }, reason: 'redraw-only run started by the owner (set-v' + n + ', design loop ' + (used + 1) + ' of ' + max + ')', ended_at: null, data: { runMode: files.length ? { kind: 'redraw-only', set: n, files, by } : null, ...(cap != null ? { runCapUsd: cap } : {}), visited: (j.data.visited || []).filter((x) => !['designer', 'qa-design'].includes(x)), autoStart: true, waitingFor: null, stopRequested: null, prepFailure: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step, runMode: 'redraw-only', by } });
    log.info('redraw-only run', { jobId: id, set: n, files, designLoop: used + 1, by });
    return withRun({ jobId: id, mode: 'redraw-only', set: n, files, designLoop: used + 1 }, startJob(id));
  }
  // the DESIGNER run of a redraw-only set: the named files only, file 1 as the reference with every image
  async function redrawFiles(job, def, pass, stopSignal, product) {
    const id = job.id, m = job.data.runMode, n = m.set, sd = path.join(jobDir(id), 'set-v' + n), p = redrawPlanOf(id, n), a = approvedRef(dataRoot, id);
    if (!p || p.status !== 'prepared' || n !== latestSet(dataRoot, id)) return { blocked: 'redraw-only: set-v' + n + ' is not the prepared redraw set' };
    if (!a.ok) return { blocked: 'redraw-only: no owner-approved file 1: ' + a.reason };
    const L = lineOf(job.line), revise = L.steps['qa-design'].onRevise || {}, total = product.deliverables.files.length, files = p.plan.redraw, nums = files.map((f) => f.n);
    const refRel = String(a.ref.file).replace(/^jobs\/[^/]+\//, ''), refAbs = path.join(dataRoot, a.ref.file);
    const run0 = { job, line: job.line, folder: jobDir(id), folderLabel: 'the job folder of ' + id, loopNote: null, runCapUsd: job.data.runCapUsd ?? null, stopSignal, contract: null, hooks: { onRunStart: hooks.onRunStart }, imageAttemptLimit: 1 + (revise.max ?? 2) };
    const input = '[RUN MODE: REDRAW ONLY — design loop ' + ((job.loops || {}).design || 1) + ': files ' + nums.map(pad2).join(', ') + ' of ' + total + '] STYLE REFERENCE: work/' + id + '/' + refRel + ' (the owner-approved file 1, ' + a.ref.name + '; the station sends it with every image). '
      + 'work/' + id + '/set-v' + n + '/raw/ already holds every other file of the set (file 1, the files reused from set-v' + p.plan.from + ' and the files the station cleaned): never draw, rename or touch them. '
      + 'Draw ONLY these files, each to work/' + id + '/set-v' + n + '/raw/NN-<subject>.png (NN = the file number; the subject is the brief\'s item N), each checked with image analysis:\n'
      + files.map((f) => '- ' + pad2(f.n) + (f.was ? ' (was ' + f.was + ')' : '') + (f.item ? ': the brief\'s item: "' + f.item + '"' : '') + '. QA DESIGN\'s finding to fix: ' + f.finding).join('\n')
      + '\nThen read work/' + id + '/set-v' + n + '/design.md (written by the station: its plan from the current spec and brief, and the kept files\' prompts) and write it back whole, with these files\' new prompts and analysis.\n\n' + readBrief(id) + '\n\n' + handoff(job) + designPlanNote(job, product) + amendmentsNote(dataRoot, id);
    const run = await runAgent(engine, { ...run0, job: store.getJob(id), agentKey: def.agent, step: 'designer', pass, input, image: { mode: 'rest', set: n, from: Math.min(...nums), to: Math.max(...nums), only: nums, reference: { abs: refAbs, rel: refRel, name: a.ref.name, sha256: a.ref.sha256 } } });
    const stop = stopFrom(run, 'DESIGNER'); if (stop) return stop;
    const names = fs.readdirSync(path.join(sd, 'raw')), missing = nums.filter((k) => !names.some((f) => numOf(f) === k));
    J.put(path.join(sd, 'redraw.json'), JSON.stringify({ ...p, status: 'drawn', drawnAt: new Date().toISOString(), drawn: names.filter((f) => nums.includes(numOf(f))), missing: missing.map(pad2) }, null, 1) + '\n');
    store.updateJob(id, { data: { runMode: null, redraw: { ...(job.data.redraw || {}), status: 'drawn' } } });
    if (missing.length) return { blocked: 'redraw-only: DESIGNER did not draw file(s) ' + missing.map(pad2).join(', ') + ' (no loop is added)' };
    return { next: def.next, note: 'redraw-only set-v' + n + ': files ' + nums.map(pad2).join(', ') + ' drawn with the style reference ' + a.ref.name + '; the rest kept or cleaned by the station' };
  }
  // the station plan for design.md, given to DESIGNER at the start of every run (owner, 18/10/2026; lib/design-plan.mjs)
  const designPlanNote = (job, product) => '\n\nSTATION PLAN for design.md (from the CURRENT products.json and brief.md): start design.md with this section word for word. Carry no notes from an earlier set\'s design.md, only each file\'s own prompt and analysis; the station rewrites this section at prep.\n' + stationPlan({ briefText: readBrief(job.id), product });
  // what QA DESIGN is told about a redraw-only set (the whole set is reviewed as usual)
  function redrawNote(job) {
    const n = latestSet(dataRoot, job.id), p = redrawPlanOf(job.id, n); if (!p || !p.plan) return '';
    const names = (xs) => (xs.length ? xs.join(', ') : 'none');
    return '\n\n[STATION — redraw-only set-v' + n + ', design loop ' + ((job.loops || {}).design || 1) + '] 01 is the owner-approved style reference. Reused unchanged (byte for byte) from set-v' + p.plan.from + ': ' + names(p.plan.keep)
      + '. Cleaned by the station (strict clean-up of disconnected faint regions, $0; set-v' + n + '/cleanup.json): ' + names(p.plan.clean) + '. Redrawn by DESIGNER for your earlier findings: ' + names(p.plan.redraw.map((r) => pad2(r.n) + (r.was ? ' (was ' + r.was + ')' : ''))) + '. Review EVERY file of the set as usual.';
  }

  // REBUILD AND CHECK (owner, 18/10/2026): station code, $0, no model. Rebuilds set N from its raw files (the pinned upscaler, as at
  // prep), writes the current station plan into design.md, re-measures and re-screens the set, runs the brief-match check, and writes the
  // owner's after previews of every file an owner fix edited (set-vN/review-after/: on each background, a crop per fixed region, and a
  // <file>.preview.json tied to the built bytes). It changes no job state; the result says what the package gate and the set approval will see.
  async function rebuildSet(id, { set, expectedVersion, by = 'owner' } = {}) {
    const j = ownJob(id); checkVersion(j, expectedVersion); notHalted('a rebuild');
    if (isActive(id) || !MODE_STATES.includes(j.state)) throw new Error('job ' + id + ' is ' + effState(j) + ': a rebuild needs a blocked, stopped or rejected job');
    const n = Number(set), sd = path.join(jobDir(id), 'set-v' + n), { product } = productFor(dataRoot, id, productsOf(id));
    if (!Number.isInteger(n) || !fs.existsSync(path.join(sd, 'raw'))) throw new Error('jobs/' + id + '/set-v' + set + '/raw does not exist');
    if (!product || !isPackaged(product)) throw new Error('rebuild is for a packaged product');
    const b = await buildStep(j, n, product, null);
    if (b.stopped || b.blocked || !b.ok) throw new Error('rebuild failed: ' + (b.stopped || b.blocked || b.reason));
    const dm = path.join(sd, 'design.md');
    if (fs.existsSync(dm)) { const was = fs.readFileSync(dm, 'utf8'), now = withStationPlan(was, stationPlan({ briefText: readBrief(id), product })); if (now !== was) J.put(dm, now); }
    const pd = prepareDigitalSet({ roomDir: dataRoot, id, n, cfg: cfg.station, products: productsOf(id), log });
    if (!pd.ok) throw new Error('rebuild: the set could not be measured: ' + pd.reason);
    const bf = briefFilesCheck(id, n, product), ed = readJson(path.join(sd, 'edits.json')), bj = readJson(path.join(sd, 'build.json')) || {}, previews = [];
    for (const e of (ed && ed.edits) || []) {
      const name = String(e.file).replace(/^raw\//, ''), rec = (bj.files || []).find((x) => x.name === name), built = path.join(sd, 'build', name);
      if (!rec || !fs.existsSync(built)) continue;
      const p = await writeAfterPreviews({ dir: path.join(sd, 'review-after'), rel: 'jobs/' + id + '/set-v' + n + '/review-after', name, builtBuf: fs.readFileSync(built), rawSha256: sha256File(path.join(sd, 'raw', name)), rec, regions: (e.regions || []).map((g) => ({ label: g.label, box: g.select.box })), backgrounds: cfg.station.digital.styleReference.review.backgrounds, listingId: id, set: n });
      previews.push({ file: name, record: 'set-v' + n + '/review-after/' + name.replace(/\.png$/i, '') + '.preview.json', images: p.images.map((x) => x.file), regions: p.regions });
    }
    const out = { jobId: id, set: n, build: { action: b.action || null, warnings: (b.record && b.record.warnings) || [] }, manifest: { count: pd.manifest.count, buildWarnings: pd.manifest.buildWarnings, limitProblems: pd.manifest.limitProblems }, originality: pd.originality.result, briefMatch: { checked: bf.checked, problems: bf.problems, note: bf.note }, previews, by };
    log.info('rebuild and check', { jobId: id, set: n, buildWarnings: out.manifest.buildWarnings.length, limitProblems: out.manifest.limitProblems.length, originality: out.originality, briefMatch: bf.note, previews: previews.length, by });
    return out;
  }

  // LISTING ONLY: LISTER -> price fill -> QA LISTING (one rework if its estimate fits) on the design sign-off; refused when listing files
  // already exist (nothing is overwritten); the cap is checked before every hop; it never packages
  function listingOnly(id, { maxUsd, expectedVersion, by = 'owner' } = {}) {
    const j = forMode(id, expectedVersion, 'a listing-only run'), cap = capOf(maxUsd), dir = jobDir(id), reasons = [];
    const so = designSignOff({ id, roomDir: dataRoot, cfg: cfg.station }); if (!so.ok) reasons.push(...so.reasons);
    for (const f of ['outbox/listing.json', 'outbox/listing.md', 'outbox/qa-listing.json', 'qa-listing']) if (fs.existsSync(path.join(dir, f))) reasons.push('jobs/' + id + '/' + f + ' already exists: nothing is overwritten');
    const one = agentEstimate('lister') + agentEstimate('qa-listing');
    if (one > cap) reasons.push('one LISTER + QA LISTING pass is estimated at USD ' + one.toFixed(4) + ', over the owner cap USD ' + cap.toFixed(2));
    if (reasons.length) throw new Error('listing-only run refused: ' + reasons.join('; '));
    const owner = so.source === 'owner-set-approval';
    const startText = ['[RUN MODE: LISTING ONLY — the Designer and QA DESIGN are not run. DESIGN SIGN-OFF: ' + so.file.replace(/^jobs\//, 'work/') + (owner ? ' (the owner\'s approval of the set after QA DESIGN\'s pass limit, checked against the files by the station just now; there is no qa-design.json)' : '') + ']', '',
      '```', 'LISTING_ID: ' + id, 'BRIEF: work/' + id + '/brief.md', 'DESIGN: ' + so.designFile.replace(/^jobs\//, 'work/'), 'STAGE_DONE: ' + (owner ? 'OWNER SET APPROVAL' : 'QA DESIGN'), '```'].join('\n');
    store.updateJob(id, { state: 'queued', step: 'lister', loops: { listing: 0 }, reason: 'listing-only run started by the owner (cap USD ' + cap.toFixed(2) + ')', ended_at: null, data: { runMode: { kind: 'listing-only', maxUsd: cap, by, signOff: so.source, signOffFile: so.file, designFile: so.designFile, spentAtStart: ledger.spent.job(id), estimateOnePassUsd: one, startText }, visited: (j.data.visited || []).filter((x) => !['lister', 'qa-listing'].includes(x)), escalation: null, gate: null, autoStart: true, waitingFor: null, stopRequested: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step: 'lister', runMode: 'listing-only', by } });
    log.info('listing-only run', { jobId: id, maxUsd: cap, signOff: so.source, estimateOnePassUsd: one });
    return withRun({ jobId: id, mode: 'listing-only', maxUsd: cap, signOff: so.source, estimateOnePassUsd: one }, startJob(id));
  }
  // the package step on the owner's word (after a listing-only run, an owner listing approval or a text fix): the package gate, then the
  // package, then the approval queue. No model.
  function packageJob(id, { expectedVersion, by = 'owner' } = {}) {
    forMode(id, expectedVersion, 'the package step', { model: false });   // station code only: no agent runs
    store.updateJob(id, { state: 'queued', step: 'package-gate', reason: 'package step started by the owner', ended_at: null, data: { runMode: null, autoStart: true, waitingFor: null, stopRequested: null } }, { expectedVersion });
    bus.emit('job.stage', { jobId: id, data: { state: 'queued', step: 'package-gate', by } });
    return withRun({ jobId: id, step: 'package-gate' }, startJob(id));
  }

  // an agent back on duty: its waiting jobs start again (not while the e-stop is on)
  function wakeWaiting(agentKey) {
    if (halt.isHalted()) return [];
    const out = [];
    for (const j of store.listJobs({ states: ['queued'] }).filter((x) => x.data && x.data.waitingFor === agentKey).reverse()) {
      store.updateJob(j.id, { data: { waitingFor: null } });
      try { startJob(j.id); out.push(j.id); } catch (e) { log.warn('waiting job not started', { jobId: j.id, error: e.message }); }
    }
    return out;
  }

  // verified briefs in research/briefs/ (the research line's output) for "Start line on brief"; legacy: refused at intake (E7a.1)
  function verifiedBriefs() {
    const d = path.join(dataRoot, 'research', 'briefs');
    return (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^[A-Za-z0-9._-]+\.md$/.test(f)).sort() : []).map((file) => {
      const t = fs.readFileSync(path.join(d, file), 'utf8'), id = briefField(t, 'id');
      return { file, id, niche: niche(t) || null, status: briefField(t, 'status') || null, product: briefField(t, 'product') || null, jobId: id && store.getJob(id) ? id : null, legacy: isLegacyBrief(t) };
    });
  }
  // owner decision 5 (17/10/2026): an owner brief is saved to research/briefs/<id>.md only when it passes the intake checks (the
  // same checkBriefAll); never over another brief or a job's id. Saving the same text again changes nothing (idempotent).
  function saveOwnerBrief({ text, by = 'owner' }) {
    const t = String(text || '').replace(/\r\n/g, '\n'), id = briefField(t, 'id');
    if (!isOwnerBrief(t)) return { ok: false, id, reasons: ['not an owner brief (front matter "origin: owner")'] };
    const chk = checkBriefAll(t), reasons = chk.ok ? [] : [...chk.reasons];
    if (briefField(t, 'status') !== OWNER_STATUS) reasons.push('the brief status must be "' + OWNER_STATUS + '"');
    const f = isListingId(id) ? path.join(dataRoot, 'research', 'briefs', id + '.md') : null, same = f && fs.existsSync(f) && fs.readFileSync(f, 'utf8') === t;
    if (f && fs.existsSync(f) && !same) reasons.push('research/briefs/' + id + '.md already exists with other text (an owner brief is written once; use a new id)');
    if (id && store.getJob(id) && !same) reasons.push('a job with id ' + id + ' already exists');
    if (reasons.length) { log.warn('owner brief refused', { id, reasons, by }); return { ok: false, id, reasons }; }
    if (!same) J.put(f, t);
    log.info(same ? 'owner brief already saved: unchanged' : 'owner brief saved', { id, by, file: 'research/briefs/' + id + '.md' });
    return { ok: true, id, file: 'research/briefs/' + id + '.md', changed: !same, warnings: chk.warnings || [] };
  }
  function startBrief(file, { by = 'owner', idempotencyKey = null } = {}) {
    if (!/^[A-Za-z0-9._-]+\.md$/.test(String(file || ''))) throw new Error('pick a verified brief');
    const f = path.join(dataRoot, 'research', 'briefs', file); if (!fs.existsSync(f)) throw new Error('no such brief: ' + file);
    notHalted('starting a job');
    const c = createJob({ briefText: fs.readFileSync(f, 'utf8'), by, idempotencyKey });
    if (!c.ok) { const e = new Error('the brief was refused at intake: ' + c.reasons.join('; ')); e.code = 'INTAKE'; throw e; }
    const j = store.getJob(c.id);
    if (j.state === 'queued' && !isActive(c.id)) startJob(c.id);
    return { jobId: c.id };
  }
  function startResearch(text, { by = 'owner', runCapUsd = null } = {}) {
    const input = String(text || '').replace(/\r\n/g, '\n').trim();
    if (input.length < 3) throw new Error('describe what to research');
    if (input.length > 2000) throw new Error('keep the research request under 2,000 characters');
    notHalted('starting a job');
    const r = createResearchJob({ input, by });
    if (runCapUsd != null) store.updateJob(r.id, { data: { runCapUsd } });
    startJob(r.id);
    return { jobId: r.id };
  }

  // ---- the owner's decisions in the approval queue (ENGINE-PLAN.md §5.3): only the approvals row and the tracker row
  // are written. Approve sends nothing anywhere; the package folder is what the owner uploads by hand.
  function decide(jobId, { action, reason = '', etsyUrl = '', publishedOn = '', finalTitle = '', finalPriceEur = null, sku = '', expectedVersion, by = 'owner' }) {
    const j = ownJob(jobId);
    const a = store.getApproval(jobId); if (!a) throw new Error('not in the approval queue: ' + jobId);
    if (expectedVersion == null || !Number.isInteger(expectedVersion)) throw new Error('expectedVersion is required');
    if (a.version !== expectedVersion) throw new VersionConflict('approval ' + jobId, a.version, expectedVersion);
    const now = Date.now(), iso = new Date(now).toISOString();
    if (action === 'approve' || action === 'reject') {
      if (a.status !== 'pending') throw new Error('approval ' + jobId + ' is ' + a.status + ', not pending');
      if (action === 'approve') { store.decideApproval(jobId, { status: 'approved', decided_at: now, reason: '' }, { expectedVersion }); trackerRow(j, { status: 'approved', owner_decision_at: iso }); }
      else {
        const why = String(reason || '').trim(); if (!why) throw new Error('a rejection needs a reason'); if (why.length > 500) throw new Error('keep the reason under 500 characters');
        store.decideApproval(jobId, { status: 'rejected_by_owner', decided_at: now, reason: why }, { expectedVersion }); trackerRow(j, { status: 'rejected_by_owner', status_reason: why, owner_decision_at: iso });
      }
    } else if (action === 'published') {
      if (a.status !== 'approved') throw new Error('only an approved job can be marked published (it is ' + a.status + ')');
      const url = etsyListingUrl(etsyUrl); if (!url) throw new Error('paste the Etsy listing URL (https://www.etsy.com/listing/... or a country link such as https://www.etsy.com/ie/listing/...)');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(publishedOn || '')); const at = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : NaN;
      if (!m || Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== publishedOn) throw new Error('give the date it was published');
      if (publishedOn > dublinDay(now)) throw new Error('the published date is in the future');
      // what the owner published, as the legacy approval record holds it (owner-package-approval.json "published"): the final title, the
      // final price and the SKU as set on Etsy. The package itself is never rebuilt for them.
      const title = String(finalTitle || '').trim(), sk = String(sku || '').trim(), pr = finalPriceEur === '' || finalPriceEur == null ? null : Number(finalPriceEur);
      if (!title) throw new Error('give the final title as published on Etsy');
      if (title.length > 140) throw new Error('the final title is over Etsy\'s 140 characters');
      if (!(pr > 0) || Math.abs(Math.round(pr * 100) - pr * 100) > 1e-6) throw new Error('give the final price in EUR (e.g. 9.00)');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(sk)) throw new Error('give the SKU (letters, digits, dot, dash or underscore; up to 32)');
      const pkg = readJson(path.join(jobDir(jobId), 'package', 'MANIFEST.json'));
      const published = { publishedOn, etsyUrl: url, finalTitle: title, finalPriceEur: pr, currency: 'EUR', sku: sk, priceFinal: true, by,
        packagedTitle: pkg ? ((readJson(path.join(jobDir(jobId), 'package', 'listing.json')) || {}).title || null) : null, packageProposalEur: pkg && pkg.price ? pkg.price.listingPriceEur : null };
      store.decideApproval(jobId, { status: 'published', published_at: at, etsy_url: url, published }, { expectedVersion });
      trackerRow(j, { status: 'published', status_reason: 'published by the owner: SKU ' + sk + ', final price EUR ' + pr.toFixed(2) + ', final title "' + title + '"', published_at: publishedOn, etsy_listing_url: url });
    } else throw new Error('unknown decision ' + action);
    const out = store.getApproval(jobId);
    bus.emit('job.decided', { jobId, data: { action, status: out.status, by } });
    log.info('owner decision', { jobId, action, status: out.status, by });
    return out;
  }

  return { createJob, saveOwnerBrief, startJob, runJob, nextJobs, createResearchJob, decide, qaOnly, prepareRedraw, redrawOnly, rebuildSet, listingOnly, packageJob, agentEstimate, costRecord, active: () => [...active.values()].map((a) => a.jobId), activeCount: () => active.size, startNext, jobDir, stopJob, restartJob, archiveJob, rerunListing, wakeWaiting, verifiedBriefs, startBrief, startResearch, controlsFor, effState, isActive, blocklistOnEnd };
}
