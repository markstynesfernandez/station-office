// owner.mjs — the owner's decisions and the owner-started mechanical steps on a job (port batch before E6, 17/10/2026; the legacy
// station's freeze exceptions d, h, i, l, m, n, o and the style-reference decisions, made engine actions). No model is ever called here.
//
// Owner decisions (DECISIONS.md "Port batch: owner decisions", 17/10/2026):
//   - an override applies ONLY to a QA judgement verdict (QA DESIGN or QA LISTING), per file, with the date, the reason and the owner, tied
//     to the file's sha256. Originality hard fails are never overridden: an override naming the originality or trademark check is refused,
//     and so is any override while the set's originality screen is a hit (that is fixed by an exact-word allow-list entry or by rewording).
//   - the owner's set approval stands in for further QA DESIGN passes only after the pass limit, tied to the exact file hashes
//     (lib/owner-approval.mjs composeSetApproval: the legacy rules, unchanged); the owner's listing approval in place of QA LISTING's
//     likewise (composeListingApproval). The package gate re-derives both from disk, so a stale record never passes.
// Records (all under jobs/<id>/, written through the data jail):
//   owner-decisions.jsonl   append-only, one line per decision (never edited in place); the source of truth
//   owner-review.json       DERIVED from the log for set N (the legacy record's shape, which composeSetApproval reads); rewritten only
//                           when the log changes what it says
//   owner-set-approval.json, owner-listing-approval.json   composed by the ported code, written only when valid
// Mechanical steps (fail closed: a refusal writes nothing and says why; idempotent: the same inputs write nothing):
//   editSet          recolour of an approved file / outline-colour normalise (lib/prop-edit.mjs) from an owner-authorised plan
//   fixListingText   the owner's US-English word list on the public listing fields (lib/listing-fix.mjs), before/after record
//   makeListingPhotos   Etsy listing-page photos from the packaged ZIP (lib/listing-photos.mjs), outside the package
//   styleRefDecision the owner's decision on file 1 (lib/style-ref.mjs recordDecision)
//   amendJob         an owner amendment to a job's frozen brief or spec (owner, 18/10/2026; lib/job-inputs.mjs addAmendment): a new dated
//                    record jobs/<id>/amendments/NNN-<date>.md, never an edit of the snapshot; agents read it with the snapshot
// Every action checks the job's version (E5 write path), refuses legacy history, a running job and the e-stop, is logged and emitted.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from './lib/common.mjs';
import { readJsonSafe, designPasses } from './lib/gates.mjs';
import { composeSetApproval, composeListingApproval, designSignOff, APPROVAL_FILE, LISTING_APPROVAL_FILE } from './lib/owner-approval.mjs';
import { applyEditPlan, readPlan } from './lib/prop-edit.mjs';
import { fixListing, chainFixRecord, US_SPELLING } from './lib/listing-fix.mjs';
import { gridLayout, sceneLayout, closeLayout, trimProp, renderPhoto, HERO, CLOSE, WARM_BG, DARK_BG } from './lib/listing-photos.mjs';
import { recordListingOriginality } from './lib/originality.mjs';
import { recordDecision, approvedRef } from './lib/style-ref.mjs';
import { addAmendment } from './lib/job-inputs.mjs';
import { readZip } from './lib/zip.mjs';
import { VersionConflict } from './store/db.mjs';
import { APP_ROOT } from './store/jail.mjs';
import { dublinDay } from './time.mjs';

export const DECISIONS_FILE = 'owner-decisions.jsonl';
export const QA_AGENTS = ['qa-design', 'qa-listing'];
export const NEVER_OVERRIDDEN = ['originality', 'trademarks'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_PNG = /^[a-z0-9][a-z0-9._-]*\.png$/;
const refuse = (msg, code = 'OWNER') => Object.assign(new Error(msg), { code });

export function createOwnerActions(engine) {
  const { J, store, bus, log, cfg, halt } = engine, dataRoot = J.dataRoot;
  const jobDir = (id) => path.join(dataRoot, 'jobs', id);
  const O = () => engine.orchestrator;

  function ownJob(id, expectedVersion) {
    const j = store.getJob(id); if (!j) throw refuse('no such job: ' + id);
    if (j.legacy || j.kind !== 'line') throw refuse('legacy history and research jobs are read only');
    if (expectedVersion == null || !Number.isInteger(expectedVersion)) throw refuse('expectedVersion is required');
    if (j.version !== expectedVersion) throw new VersionConflict('job ' + id, j.version, expectedVersion);
    if (O().isActive(id) || j.state === 'running') throw refuse('job ' + id + ' is running: wait for it to stop');
    if (halt.isHalted()) throw refuse('e-stop is on: owner steps are refused until you resume', 'HALTED');
    return j;
  }
  const dateOf = (d) => { const x = d || dublinDay(); if (!DATE_RE.test(x)) throw refuse('date must be YYYY-MM-DD'); if (x > dublinDay()) throw refuse('the date is in the future'); return x; };
  const words = (w, what) => { const s = String(w || '').trim(); if (!s) throw refuse(what + ' is required (the owner\'s words)'); if (s.length > 2000) throw refuse(what + ' is over 2,000 characters'); return s; };
  // the job's version moves on every recorded decision, so a second tab holding the old version is refused (E5)
  function done(id, action, data) {
    store.updateJob(id, { data: { ownerActions: (store.getJob(id).data.ownerActions || 0) + 1 } });
    log.info('owner action', { jobId: id, action, ...data });
    bus.emit('owner.action', { jobId: id, data: { action, ...data } });
    return { jobId: id, action, ...data };
  }

  // ---- the append-only decision log and the review derived from it
  function decisions(id) {
    const f = path.join(jobDir(id), DECISIONS_FILE); if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  function append(id, entry) {
    const prev = decisions(id), rec = { seq: prev.length + 1, decidedBy: 'owner', ...entry };
    J.add(path.join(jobDir(id), DECISIONS_FILE), JSON.stringify(rec) + '\n', { fsync: true });
    return rec;
  }
  // owner-review.json for set N, in the legacy shape: per file the first QA override is the decision, later ones laterOverrides
  function reviewFrom(id, n) {
    const ds = decisions(id).filter((d) => d.set === n), fileDs = ds.filter((d) => d.kind === 'file');
    if (!fileDs.length) return null;
    const byName = new Map();
    for (const d of fileDs) {
      const f = byName.get(d.name);
      if (!f || d.rawSha256 !== f.rawSha256 || !d.overridesQa) { byName.set(d.name, { name: d.name, rawSha256: d.rawSha256, decision: d.decision, ...(d.overridesQa ? { overridesQa: true, qaAgent: d.qaAgent, qaPass: d.qaPass, qaSaid: d.qaSaid } : {}), reason: d.reason || '', ...(d.fix ? { fix: d.fix } : {}), date: d.date, seq: d.seq }); continue; }
      if (!f.overridesQa) { Object.assign(f, { decision: d.decision, overridesQa: true, qaAgent: d.qaAgent, qaPass: d.qaPass, qaSaid: d.qaSaid, reason: d.reason, date: d.date, seq: d.seq }); continue; }
      (f.laterOverrides = f.laterOverrides || []).push({ qaPass: d.qaPass, qaSaid: d.qaSaid, reason: d.reason, date: d.date, seq: d.seq });
    }
    const sa = ds.filter((d) => d.kind === 'set-approval').pop();
    const passes = fileDs.filter((d) => d.overridesQa && d.qaPass).map((d) => d.qaPass), first = passes.length ? Math.min(...passes) : null;
    return { listingId: id, set: n, decidedBy: 'owner', date: fileDs[fileDs.length - 1].date, ...(first ? { reviewOf: { qaRecord: 'qa/design-pass' + first + '.json' } } : {}),
      note: 'DERIVED by the engine from jobs/' + id + '/' + DECISIONS_FILE + ' (append-only, the owner\'s decisions): do not edit; record a new decision instead.',
      ...(sa ? { setApproval: { decidedBy: 'owner', date: sa.date, afterQaPass: sa.afterQaPass, words: sa.words, worthThePrice: sa.worthThePrice || null, ...(sa.rule ? { rule: sa.rule, reviewedPreviews: sa.reviewedPreviews || [] } : {}) } } : {}),
      files: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
  const writeReview = (id, n) => { const r = reviewFrom(id, n); if (r) J.putIfChanged(path.join(jobDir(id), 'owner-review.json'), JSON.stringify(r, null, 1) + '\n'); return r; };

  // ---- an owner decision on one file of a set (approved, an override of a QA verdict, or a deterministic fix to come)
  function recordFileDecision(id, { set, name, decision, qaAgent = 'qa-design', qaPass = null, qaSaid = '', check = null, reason = '', fix = '', date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const n = Number(set), sd = path.join(jobDir(id), 'set-v' + n);
    if (!Number.isInteger(n) || n < 1 || !fs.existsSync(sd)) throw refuse('set-v' + set + ' does not exist');
    if (!SAFE_PNG.test(String(name || ''))) throw refuse('name a raw PNG of the set (e.g. 03-headphones.png)');
    const raw = path.join(sd, fs.existsSync(path.join(sd, 'raw-original', name)) && decision === 'fix' ? 'raw-original' : 'raw', name);
    if (!fs.existsSync(raw)) throw refuse('set-v' + n + '/raw/' + name + ' does not exist');
    if (!['approved', 'keep', 'accept', 'fix', 'replace'].includes(decision)) throw refuse('decision is approved, keep, accept, fix or replace');
    const overridesQa = decision === 'keep' || decision === 'accept';
    if (overridesQa) {
      if (!QA_AGENTS.includes(qaAgent)) throw refuse('an override applies only to a QA judgement verdict (QA DESIGN or QA LISTING)');
      if (qaAgent === 'qa-listing') throw refuse('QA LISTING\'s verdict covers the listing files together: use the owner listing approval');
      if (check && NEVER_OVERRIDDEN.includes(String(check))) throw refuse('the ' + check + ' check is a hard fail and is never overridden: fix it by an exact-word allow-list entry or by rewording');
      if (!Number.isInteger(Number(qaPass)) || !fs.existsSync(path.join(jobDir(id), 'qa', 'design-pass' + Number(qaPass) + '.json'))) throw refuse('qaPass must name a QA DESIGN pass on disk (qa/design-pass<N>.json)');
      words(qaSaid, 'what QA said'); words(reason, 'the reason');
      const og = readJsonSafe(path.join(sd, 'originality.json'));
      if (!og.ok || og.v.result !== 'clear') throw refuse('the set\'s originality screen is not clear: an owner override never overrules it');
    }
    if (decision === 'fix' || decision === 'replace') words(fix || reason, 'what to fix');
    const e = append(id, { kind: 'file', set: n, name, rawSha256: sha256File(raw), decision, overridesQa, ...(overridesQa ? { qaAgent, qaPass: Number(qaPass), qaSaid: words(qaSaid, 'what QA said'), ...(check ? { check } : {}) } : {}), reason: String(reason || '').trim(), ...(fix ? { fix: String(fix).trim() } : {}), date: dateOf(date) });
    writeReview(id, n);
    return done(id, 'file-decision', { set: n, name, decision, overridesQa, seq: e.seq });
  }

  // ---- the owner's approval of the whole set after QA DESIGN's pass limit (legacy approve-set.mjs)
  // rule "post-fix" (owner, 18/10/2026): before the pass limit, after a $0 deterministic fix of build-check findings only, with the after
  // previews the owner reviewed (reviewedPreviews: set-vN/review-after/<file>.preview.json); lib/owner-approval.mjs postFixProblems
  function approveSet(id, { set, words: w, worthThePrice = null, rule = null, reviewedPreviews = null, date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const n = Number(set), passes = designPasses(jobDir(id)), last = passes[passes.length - 1];
    if (!last) throw refuse('no QA DESIGN pass on disk');
    const d = dateOf(date);
    // checked before anything is written: the composition below must pass with this approval in the review
    const prev = reviewFrom(id, n); if (!prev) throw refuse('record the owner\'s decision on every file of set-v' + n + ' first');
    if (rule != null && rule !== 'post-fix') throw refuse('rule must be "post-fix" or left out');
    const extra = rule ? { rule, reviewedPreviews: Array.isArray(reviewedPreviews) ? reviewedPreviews.map(String) : [] } : {};
    const probe = { kind: 'set-approval', set: n, date: d, afterQaPass: 'qa/design-pass' + last.n + '.json', words: words(w, 'the owner\'s words'), worthThePrice, ...extra };
    const reviewFile = path.join(jobDir(id), 'owner-review.json'), before = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile) : null;
    J.put(reviewFile, JSON.stringify({ ...prev, setApproval: { decidedBy: 'owner', date: d, afterQaPass: probe.afterQaPass, words: probe.words, worthThePrice, ...extra } }, null, 1) + '\n');
    const c = composeSetApproval({ roomDir: dataRoot, id, n, maxDesignPasses: 3, cfg: cfg.station });
    if (!c.ok) { if (before) J.put(reviewFile, before); else J.remove(reviewFile); throw refuse('owner set approval refused: ' + c.reasons.join('; ')); }
    append(id, probe); writeReview(id, n);
    const c2 = composeSetApproval({ roomDir: dataRoot, id, n, maxDesignPasses: 3, cfg: cfg.station });
    if (!c2.ok) throw refuse('owner set approval refused: ' + c2.reasons.join('; '));
    J.putIfChanged(path.join(jobDir(id), APPROVAL_FILE), JSON.stringify(c2.record, null, 1) + '\n');
    return done(id, 'set-approval', { set: n, counts: c2.record.counts, afterQaPass: last.n });
  }

  // ---- the owner's listing approval in place of QA LISTING's (legacy approve-listing.mjs); originality stays hard
  function approveListing(id, { reason, date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const og = readJsonSafe(path.join(jobDir(id), 'derived', 'listing.originality.json'));
    if (!og.ok || og.v.result !== 'clear') throw refuse('the listing\'s originality screen is not clear: an owner approval never overrules it');
    const c = composeListingApproval({ roomDir: dataRoot, id, reason: words(reason, 'the reason'), date: dateOf(date), cfg: cfg.station });
    if (!c.ok) throw refuse('owner listing approval refused: ' + c.reasons.join('; '));
    const e = append(id, { kind: 'listing-approval', date: c.record.date, reason: c.record.ownerReason, qaListing: c.record.overrulesQa, listing: c.record.listing });
    J.putIfChanged(path.join(jobDir(id), LISTING_APPROVAL_FILE), JSON.stringify(c.record, null, 1) + '\n');
    return done(id, 'listing-approval', { seq: e.seq, failedChecks: c.record.overrulesQa.failedChecks });
  }

  // ---- deterministic edits of raw files: recolour of an APPROVED file, outline normalise to an APPROVED file's outline
  // the files an edit may start from: owner-approved in the review (sha256 as decided) or the approved style reference
  function approvedSources(id, n) {
    const r = reviewFrom(id, n), ok = new Map();
    for (const f of (r && r.files) || []) if (f.decision === 'approved' || f.overridesQa) ok.set(f.name, f.rawSha256);
    const sr = approvedRef(dataRoot, id); if (sr.ok) ok.set(sr.ref.name, sr.ref.sha256);
    return ok;
  }
  async function editSet(id, { set, plan, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const n = Number(set), sd = path.join(jobDir(id), 'set-v' + n); if (!fs.existsSync(path.join(sd, 'raw'))) throw refuse('set-v' + set + '/raw does not exist');
    if (!plan || typeof plan !== 'object') throw refuse('give the owner-authorised edit plan');
    const p = { listingId: id, set: n, ...plan }; if (p.listingId !== id || p.set !== n) throw refuse('the plan is for another job or set');
    const pf = path.join(sd, 'edit-plan.json'), before = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : null;
    const ok = approvedSources(id, n), bad = [];
    // a region edit (owner, 18/10/2026) fixes build-check findings only: each region quotes a build warning of that file, from the set's
    // current manifest (or, on a re-run, the warning its earlier record quoted); the full warning is kept in the plan and edits.json
    const mf = readJsonSafe(path.join(sd, 'deliverables.json')), prevEd = readJsonSafe(path.join(sd, 'edits.json'));
    const warningsOf = (file) => [...((mf.ok && mf.v.buildWarnings) || []), ...((prevEd.ok && (prevEd.v.edits || []).flatMap((x) => (x.regions || []).map((g) => g.addressesWarning).filter(Boolean))) || [])].filter((w) => String(w).startsWith(file + ':'));
    for (const e of p.edits || []) {
      if (e.op !== 'region') continue;
      for (const g of e.regions || []) {
        const w = warningsOf(e.file).find((x) => String(g.addresses || '').trim() && x.includes(String(g.addresses).trim()));
        if (!w) bad.push(e.file + ' region ' + (g.label || '?') + ': "' + g.addresses + '" is not a build-check finding of ' + e.file + ' (set-v' + n + '/deliverables.json buildWarnings)');
        else g.addressesWarning = w;
      }
    }
    for (const e of p.edits || []) {
      if (e.op === 'region') continue;   // its sample is a colour, not pixels copied from another file: no approved-source rule
      const src = e.op === 'recolour' ? e.source : e.like, f = path.join(sd, 'raw', String(src || ''));
      if (!SAFE_PNG.test(String(src || '')) || !fs.existsSync(f)) { bad.push(e.file + ': its ' + (e.op === 'recolour' ? 'source' : 'outline reference') + ' ' + src + ' is missing'); continue; }
      if (ok.get(src) !== sha256File(f)) bad.push(e.file + ': ' + src + ' is not an approved file (owner-approved in the review, or the approved style reference, with these exact bytes)');
    }
    if (bad.length) throw refuse('edit plan refused: ' + bad.join('; '));
    J.put(pf, JSON.stringify(p, null, 1) + '\n');   // with each region's full build warning (addressesWarning)
    const r0 = readPlan(sd); if (!r0.ok) { if (before != null) J.put(pf, before); else J.remove(pf); throw refuse('edit plan refused: ' + r0.reason); }
    const r = await applyEditPlan({ sd, log });
    if (!r.ok) throw refuse('edit failed (nothing kept half-done is used: the build re-checks every raw file): ' + r.reason);
    return done(id, 'edit-set', { set: n, actions: r.actions, record: r.recordAction });
  }

  // ---- the owner's deterministic listing text fix (legacy fix-listing-text.mjs): US English on the public fields, the reviewer note and the
  // owner to-do rebuilt from their records. Originals kept in derived/listing-before-fix-*/, record listing-fixes.json (every round)
  function fixListingText(id, { ownerWords, date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const work = jobDir(id), out = path.join(work, 'outbox'), jf = path.join(out, 'listing.json'), mf = path.join(out, 'listing.md'), lj = readJsonSafe(jf);
    if (!lj.ok || !fs.existsSync(mf)) throw refuse('jobs/' + id + '/outbox/listing.json and listing.md are needed');
    const so = designSignOff({ id, roomDir: dataRoot, cfg: cfg.station });
    const sa = so.ok && so.source === 'owner-set-approval' ? readJsonSafe(path.join(dataRoot, so.file)).v : null;
    const jText = fs.readFileSync(jf, 'utf8'), mText = fs.readFileSync(mf, 'utf8');
    const r = fixListing({ listing: lj.v, md: mText, setApproval: sa }), jNew = JSON.stringify(r.listing, null, 2) + '\n';
    if (!r.changes.length) return done(id, 'listing-text-fix', { changes: 0, action: 'unchanged' });
    const before = { 'listing.json': sha256(jText), 'listing.md': sha256(mText) }, bdir = path.join(work, 'derived', 'listing-before-fix-' + before['listing.json'].slice(0, 8) + before['listing.md'].slice(0, 8));
    const recFile = path.join(work, 'listing-fixes.json'), prev = fs.existsSync(recFile) ? readJsonSafe(recFile) : { ok: true, v: null };
    if (!prev.ok) throw refuse('listing-fixes.json ' + prev.err);
    const chain = chainFixRecord(prev.v, { base: { kind: 'listing-text-fix', listingId: id, decidedBy: 'owner', model: 'none (deterministic)', usSpelling: US_SPELLING.map(([uk, us]) => uk + '->' + us), noteFrom: sa ? so.file : null },
      date: dateOf(date), ownerWords: words(ownerWords, 'the owner\'s words'), before, after: { 'listing.json': sha256(jNew), 'listing.md': sha256(r.md) }, backup: path.relative(work, bdir).replace(/\\/g, '/'), changes: r.changes });
    if (!chain.ok) throw refuse(chain.reason);
    J.put(path.join(bdir, 'listing.json'), jText); J.put(path.join(bdir, 'listing.md'), mText);
    J.put(jf, jNew); J.put(mf, r.md);
    J.put(recFile, JSON.stringify(chain.record, null, 1) + '\n');
    const o = recordListingOriginality({ roomDir: dataRoot, id, cfg: cfg.station, extra: cfg.blocklist, log });
    append(id, { kind: 'listing-text-fix', date: chain.record.date, ownerWords: words(ownerWords, 'the owner\'s words'), changes: r.changes.length, after: chain.record.after });
    return done(id, 'listing-text-fix', { changes: r.changes.length, rounds: chain.record.rounds.length, originality: o.ok ? o.result : o.reason });
  }

  // ---- Etsy listing-page photos from the PACKAGED ZIP (renderListingPhotos below); written to jobs/<id>/listing-photos/, outside the package
  async function makeListingPhotos(id, { plan, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const r = await renderListingPhotos({ pkgDir: path.join(jobDir(id), 'package'), id, plan, date: dateOf(plan && plan.date), ownerWords: words(plan && plan.ownerWords, 'the owner\'s words') });
    const dir = path.join(jobDir(id), 'listing-photos'), acts = [];
    for (const p of r.rendered) { const f = path.join(dir, p.file), same = fs.existsSync(f) && sha256(fs.readFileSync(f)) === p.sha256; if (!same) J.put(f, p.buf); acts.push(p.file + (same ? ' unchanged' : ' written')); }
    const changed = J.putIfChanged(path.join(dir, 'photos.json'), JSON.stringify(r.record, null, 1) + '\n');
    if (sha256(fs.readFileSync(path.join(jobDir(id), 'package', 'MANIFEST.json'))) !== r.record.source.manifestSha256) throw refuse('MANIFEST.json changed during the run');
    return done(id, 'listing-photos', { photos: r.rendered.length, actions: acts, record: changed ? 'written' : 'unchanged', packageUntouched: true });
  }

  // ---- the owner's decision on file 1 (the style reference), per version (legacy style-ref.mjs --approve | --reject)
  function styleRefDecision(id, { set, status, reason = '', date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const r = recordDecision({ roomDir: dataRoot, id, status, reason, date: dateOf(date), decidedBy: 'owner', n: Number(set) });
    if (!r.ok) throw refuse('style reference decision refused: ' + r.reason);
    if (r.action === 'recorded') append(id, { kind: 'style-ref', set: Number(set), status, version: r.decision.version, sha256: r.decision.sha256, reason: r.decision.reason || '', date: r.decision.date });
    // E6 c0: a job waiting for this decision (file 1 passed QA DESIGN) may now be resumed by the owner (Restart / owner resume)
    const j = store.getJob(id), aw = j.data && j.data.styleRef && j.data.styleRef.awaiting;
    const freed = j.state === 'queued' && j.data.waitingFor === 'owner-style-ref' && aw && aw.set === Number(set);
    if (freed) store.updateJob(id, { reason: 'owner ' + status + ' file 1 of set-v' + set + ': resume the job to continue (' + (status === 'approved' ? 'the rest of the set is drawn with it as the style reference' : 'file 1 is drawn again with the owner\'s reason') + ')', data: { waitingFor: null } });
    return done(id, 'style-ref', { set: Number(set), status, action: r.action, version: r.decision.version, resumable: !!freed });
  }

  // an owner amendment (owner, 18/10/2026): the snapshot taken at job start stays as it is; the amendment is read alongside it by every
  // agent from the next run on and listed in the QA records
  function amendJob(id, { text, date, expectedVersion } = {}) {
    ownJob(id, expectedVersion);
    const r = addAmendment({ roomDir: dataRoot, id, text, date: dateOf(date), by: 'owner', log });
    if (!r.ok) throw refuse('amendment refused: ' + r.reason);
    append(id, { kind: 'amendment', file: r.file, sha256: r.sha256, date: r.date });
    return done(id, 'amend', { file: r.file, sha256: r.sha256 });
  }

  // the owner's rejection of a whole set with the owner's words (L2, from the job panel): recorded in the append-only decision log, and the
  // job ends rejected with that reason. Nothing is deleted; Archive moves the files later. Never on a job in the approval queue (Reject there).
  function rejectSet(id, { set, words: w, date, expectedVersion } = {}) {
    const j = ownJob(id, expectedVersion), n = Number(set);
    if (!Number.isInteger(n) || n < 1 || !fs.existsSync(path.join(jobDir(id), 'set-v' + n))) throw refuse('jobs/' + id + '/set-v' + set + ' does not exist');
    if (!['blocked', 'stopped', 'rejected', 'queued', 'incomplete'].includes(j.state)) throw refuse('job ' + id + ' is ' + j.state + ': a set is rejected on a job that has stopped (in the approval queue, use Reject there)');
    const d = dateOf(date), why = words(w, 'the owner\'s words');
    append(id, { kind: 'set-rejection', set: n, words: why, date: d });
    store.updateJob(id, { state: 'rejected', reason: 'owner rejected set-v' + n + ' (' + d + '): ' + why, ended_at: Date.now(), data: { waitingFor: null, autoStart: false, next: false } });
    bus.emit('job.rejected', { jobId: id, data: { state: 'rejected', by: 'owner', set: n } });
    return done(id, 'set-rejection', { set: n, date: d });
  }

  // what the job panel and MANIFEST show: every override with its file, sha256, stage, pass, date, reason and owner
  function summary(id) {
    const ds = decisions(id), dir = jobDir(id);
    const overrides = ds.filter((d) => d.kind === 'file' && d.overridesQa).map((d) => ({ seq: d.seq, set: d.set, file: d.name, sha256: d.rawSha256, stage: d.qaAgent === 'qa-listing' ? 'QA LISTING' : 'QA DESIGN', qaPass: d.qaPass, qaSaid: d.qaSaid, ownerReason: d.reason, date: d.date, decidedBy: d.decidedBy }));
    for (const d of ds.filter((x) => x.kind === 'listing-approval')) overrides.push({ seq: d.seq, file: 'listing (listing.json, listing.md)', sha256: d.listing, stage: 'QA LISTING', qaPass: d.qaListing && d.qaListing.pass, qaSaid: d.qaListing ? d.qaListing.verdict + ': ' + (d.qaListing.reasons || []).join(' | ') : '', ownerReason: d.reason, date: d.date, decidedBy: d.decidedBy });
    const sa = readJsonSafe(path.join(dir, APPROVAL_FILE)), la = readJsonSafe(path.join(dir, LISTING_APPROVAL_FILE));
    return { decisions: ds.length, overrides, fixes: ds.filter((d) => d.kind === 'file' && (d.decision === 'fix' || d.decision === 'replace')).map((d) => ({ set: d.set, file: d.name, fix: d.fix || d.reason, date: d.date })),
      setApproval: sa.ok ? { set: sa.v.set, date: sa.v.date, counts: sa.v.counts } : null, setRejection: (ds.filter((d) => d.kind === 'set-rejection').pop() || null), listingApproval: la.ok ? { date: la.v.date, reason: la.v.ownerReason } : null };
  }

  return { recordFileDecision, approveSet, rejectSet, approveListing, editSet, fixListingText, makeListingPhotos, styleRefDecision, amendJob, decisions, reviewFrom, summary };
}

// the listing photos of a packaged ZIP (legacy make-listing-photos.mjs, freeze exception o): reads the package only, checks every PNG against
// MANIFEST.json zipEntries, renders the grid, the dark grid, the desk scene and the close-ups. Returns { rendered: [{ file, buf, sha256 }],
// record } (photos.json); writes nothing. Deterministic: the same ZIP and plan give the same bytes.
export async function renderListingPhotos({ pkgDir, id, plan, date, ownerWords, packageLabel = 'jobs/' + id + '/package' }) {
  const mf = path.join(pkgDir, 'MANIFEST.json');
  if (!fs.existsSync(mf)) throw refuse('no package at ' + packageLabel);
  if (!plan || !Array.isArray(plan.scene) || !Array.isArray(plan.closeUps)) throw refuse('give the photo plan (scene, closeUps, ownerWords, date)');
  const manText = fs.readFileSync(mf, 'utf8'), M = JSON.parse(manText), zipRow = (M.files || []).find((f) => f.name.endsWith('.zip'));
  if (!zipRow) throw refuse('the package holds no ZIP');
  const zipBuf = fs.readFileSync(path.join(pkgDir, zipRow.name)); if (sha256(zipBuf) !== zipRow.sha256) throw refuse(zipRow.name + ' differs from MANIFEST.json');
  const z = readZip(zipBuf); if (!z.ok) throw refuse('zip: ' + z.problems.join('; '));
  const want = new Map((M.zipEntries || []).map((e) => [e.name, e.sha256])), trimmed = {}, props = [];
  for (const e of z.entries.filter((x) => x.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (want.get(e.name) !== sha256(e.data)) throw refuse(e.name + ' does not match MANIFEST.json zipEntries');
    trimmed[e.name] = await trimProp(e.data); props.push({ name: e.name, w: trimmed[e.name].w, h: trimmed[e.name].h });
  }
  if (props.length !== want.size) throw refuse('the zip holds ' + props.length + ' PNGs, MANIFEST.json lists ' + want.size);
  const grid = gridLayout(props, HERO), plans = [
    { file: '01-hero.jpg', what: 'all ' + props.length + ' props in a 4 x 3 grid on a soft warm background', background: WARM_BG, ...HERO, placements: grid },
    { file: '02-on-dark.jpg', what: 'the same grid on a dark background (shows the transparency)', background: DARK_BG, ...HERO, placements: grid },
    { file: '03-scene.jpg', what: 'the ten main props arranged as one desk scene on a plain background', background: WARM_BG, ...HERO, placements: sceneLayout(props, plan.scene, HERO) },
    ...plan.closeUps.map(([file, name]) => { const p = props.find((x) => x.name === name); if (!p) throw refuse('close-up names a prop that is not in the set: ' + name); return { file, what: 'close-up: ' + name, background: WARM_BG, ...CLOSE, placements: closeLayout(p, CLOSE) }; })
  ];
  const rendered = [], photos = [];
  for (const pl of plans) {
    const buf = await renderPhoto({ width: pl.width, height: pl.height, background: pl.background, placements: pl.placements, trimmed });
    rendered.push({ file: pl.file, buf, sha256: sha256(buf) });
    photos.push({ file: pl.file, format: 'jpeg', widthPx: pl.width, heightPx: pl.height, bytes: buf.length, sha256: sha256(buf), background: pl.background, what: pl.what, props: pl.placements.map((x) => x.name) });
  }
  const sharpVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'node_modules', 'sharp', 'package.json'), 'utf8')).version;
  const record = { kind: 'etsy-listing-photos', listingId: id, use: 'Etsy listing page only; not part of the buyer download', decidedBy: 'owner', date, ownerWords,
    method: 'deterministic compositing with sharp ' + sharpVersion + ' (trim to visible pixels, lanczos3 resize, JPEG q92 4:4:4); no model, no image generation, no text, labels or watermarks',
    source: { package: packageLabel, manifestSha256: sha256(manText), zip: { name: zipRow.name, sha256: zipRow.sha256 }, pngsCheckedAgainst: 'MANIFEST.json zipEntries sha256 (' + props.length + ' of ' + want.size + ')' }, photos };
  return { rendered, record };
}
