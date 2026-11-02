// PORTED from Virtual-workers/station/scripts/lib/owner-approval.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, new in the source on 17/10/2026), source sha256 41466fa009f3fcba53b650f03e847a1a7deff0159902496b31830e15b2bc536a.
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   pure reads; the engine writes the records through its owner actions (src/engine/owner.mjs), never an agent
//   change (owner, 18/10/2026, DECISIONS.md "E6 step c: owner fix tools, post-fix approval rule"): a set approval with rule "post-fix" may
//           stand in for a further QA DESIGN pass BEFORE the pass limit, after a $0 deterministic owner fix of build-check findings only, if
//           (a) originality passed on the previous QA pass, (b) the rebuilt set has no build warnings and no limit problems, (c) every file
//           still matches the brief, and (d) the owner reviewed the after previews of every fixed file (postFixProblems). Originality and
//           build warnings are never overridden, under either rule
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// owner-approval.mjs (lib) — the OWNER's approval of a whole digital deliverable set after QA DESIGN's pass limit (OWNER exception to the
// station freeze, 2026-10-17: PNGTuber desk props set-v4, after QA DESIGN pass 3 of 3). The record work/<id>/owner-set-approval.json is the
// package gate's design sign-off IN PLACE OF a further QA DESIGN pass. Pure reads; scripts/approve-set.mjs writes the record.
//   - composed from the owner's own review (work/<id>/owner-review.json: per-file decisions in the owner's words, and a setApproval block)
//     and the set on disk: every raw file gets one final status, "qa-pass", "owner-override" (each QA finding overruled, with the owner's
//     reason) or "deterministic-fix" (set-vN/edits.json made it: its output is the raw file now, its original is the file the owner decided on);
//   - only at the pass limit (passes on disk == maxDesignPasses) and only after a QA verdict that is not "approved", naming that last pass;
//   - originality stays a hard check: the set's originality.json must be clear, for the current design.md (the gate re-checks it too);
//   - no limit problems and no build warnings in the manifest;
//   - tied to the bytes: the manifest, the owner review, the edit record and every raw file by sha256. The gate re-composes the record from
//     disk and refuses it when anything differs (a changed file, a new QA pass, an edited review), so a stale approval never passes.
// Nothing here relaxes the rest of the gate: files == manifest, Etsy limits, product spec, station build, style reference, assets, listing QA.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, sha256File } from './common.mjs';
import { designPasses, readJsonSafe } from './gates.mjs';
import { manifestRel, MANIFEST_RE } from './digital-prep.mjs';
import { productFor } from './digital-build.mjs';
import { briefFileProblems } from './brief-files.mjs';

// the owner's post-fix rule (owner, 18/10/2026): -> problems[] (empty when the set approval may stand in for a further QA DESIGN pass)
export const POST_FIX = 'post-fix';
export function postFixProblems({ roomDir, id, n, last, sa, maxDesignPasses = 3 }) {
  const out = [], workDir = path.join(roomDir, 'jobs', id), sd = path.join(workDir, 'set-v' + n), passes = designPasses(workDir);
  if (passes.length > maxDesignPasses) out.push('post-fix rule: ' + passes.length + ' design passes are past the limit ' + maxDesignPasses);
  // the fix: a $0 deterministic owner fix of build-check findings only (region edits, each quoting a build warning of its file)
  const ed = readJsonSafe(path.join(sd, 'edits.json')), edits = ed.ok && Array.isArray(ed.v.edits) ? ed.v.edits : [];
  if (!edits.length) out.push('post-fix rule: no deterministic owner fix in set-v' + n + '/edits.json');
  for (const e of edits) {
    const rs = e.regions || [];
    if (e.op !== 'region' || !rs.length || rs.some((g) => !String(g.addresses || '').trim() || !String(g.addressesWarning || '').trim())) out.push('post-fix rule: ' + String(e.file || '').replace(/^raw\//, '') + ' is not a region fix of build-check findings only (every region must quote the build warning it fixes)');
  }
  // (a) originality passed on the previous QA pass
  const lv = last && last.rec && last.rec.ok ? last.rec.v : null;
  if (!lv || !lv.checks || lv.checks.originality !== 'pass') out.push('post-fix rule (a): originality did not pass on the previous QA DESIGN pass (' + (last ? 'qa/design-pass' + last.n + '.json: ' + ((lv && lv.checks && lv.checks.originality) || 'no originality check') : 'none on disk') + ')');
  // (b) the REBUILT set: every fixed file was built from its edited raw bytes (warnings and limits are checked for every set approval)
  const bj = readJsonSafe(path.join(sd, 'build.json'));
  for (const e of edits) {
    const name = String(e.file || '').replace(/^raw\//, ''), br = bj.ok ? (bj.v.files || []).find((x) => x.name === name) : null;
    if (!br || !e.output || br.input.sha256 !== e.output.sha256) out.push('post-fix rule (b): set-v' + n + ' was not rebuilt after the fix of ' + name + ' (npm run owner -- rebuild)');
  }
  // (c) every file still matches the brief (the station's brief-match check, which must apply: the brief numbers the spec's files)
  let product = null; try { product = productFor(roomDir, id).product; } catch (_) { product = null; }
  const briefText = fs.existsSync(path.join(workDir, 'brief.md')) ? fs.readFileSync(path.join(workDir, 'brief.md'), 'utf8') : '';
  const names = fs.existsSync(path.join(sd, 'raw')) ? fs.readdirSync(path.join(sd, 'raw')).filter((x) => /\.png$/i.test(x)) : [];
  const bf = briefFileProblems(briefText, product, names);
  if (!bf.checked) out.push('post-fix rule (c): the brief-match check does not apply (' + bf.note + ')');
  else if (bf.problems.length) out.push('post-fix rule (c): ' + bf.problems.join('; '));
  // (d) the owner reviewed the after previews of every fixed file, for the files as built now
  const reviewed = new Set(Array.isArray(sa && sa.reviewedPreviews) ? sa.reviewedPreviews.map(String) : []);
  for (const e of edits) {
    const name = String(e.file || '').replace(/^raw\//, ''), base = name.replace(/\.png$/i, ''), rel = 'set-v' + n + '/review-after/' + base + '.preview.json', pr = readJsonSafe(path.join(workDir, rel));
    if (!reviewed.has(rel)) { out.push('post-fix rule (d): the owner has not listed the after previews of ' + name + ' (' + rel + ') as reviewed'); continue; }
    if (!pr.ok) { out.push('post-fix rule (d): ' + rel + ' is ' + pr.err); continue; }
    const built = path.join(sd, 'build', name);
    if (!fs.existsSync(built) || pr.v.builtSha256 !== sha256File(built)) out.push('post-fix rule (d): the after previews of ' + name + ' are for another build (rebuild and review them again)');
    for (const im of pr.v.images || []) { const fp = path.join(roomDir, im.file); if (!fs.existsSync(fp) || sha256File(fp) !== im.sha256) out.push('post-fix rule (d): preview ' + im.file + ' is missing or changed'); }
  }
  return out;
}

export const APPROVAL_FILE = 'owner-set-approval.json';
export const FILE_STATUSES = ['qa-pass', 'owner-override', 'deterministic-fix'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const qaPassOf = (rel) => { const m = /design-pass(\d+)\.json$/.exec(String(rel || '')); return m ? Number(m[1]) : null; };

// every QA finding the owner overruled on this file: the review's own (made on review.reviewOf's pass) and any laterOverrides [{ qaPass, qaSaid, reason }]
export function overridesOf(f, reviewPass) {
  const out = [];
  if (f.overridesQa) out.push({ qaPass: f.qaPass ?? reviewPass, qaSaid: f.qaSaid || '', reason: f.reason || '' });
  for (const o of f.laterOverrides || []) out.push({ qaPass: o.qaPass ?? null, qaSaid: o.qaSaid || '', reason: o.reason || '' });
  return out;
}

// the approval record from the owner review and the set on disk. { ok, record } or { ok: false, reasons }
export function composeSetApproval({ roomDir, id, n, maxDesignPasses = 3, cfg }) {
  const reasons = [], workDir = path.join(roomDir, 'jobs', id), sd = path.join(workDir, 'set-v' + n), rel = (f) => path.relative(workDir, f).replace(/\\/g, '/');
  if (cfg && cfg.productType !== 'digital') return { ok: false, reasons: ['an owner set approval is a digital-line exception (productType is "' + cfg.productType + '")'] };
  if (!fs.existsSync(sd)) return { ok: false, reasons: ['jobs/' + id + '/set-v' + n + ' does not exist'] };
  const rf = path.join(workDir, 'owner-review.json'), rv = readJsonSafe(rf);
  if (!rv.ok) return { ok: false, reasons: ['owner-review.json is ' + rv.err] };
  const review = rv.v, sa = review.setApproval || null;
  if (review.listingId !== id || review.set !== n || review.decidedBy !== 'owner' || !DATE_RE.test(String(review.date || ''))) reasons.push('owner-review.json is not the owner\'s dated review of set-v' + n);
  if (!sa || sa.decidedBy !== 'owner' || !DATE_RE.test(String(sa.date || '')) || !String(sa.words || '').trim()) reasons.push('owner-review.json has no setApproval by the owner (decidedBy, date and the owner\'s words)');
  // the pass limit, and the last pass is the one the owner approved after
  const passes = designPasses(workDir), last = passes[passes.length - 1];
  const postFix = !!(sa && sa.rule === POST_FIX);
  if (passes.length !== maxDesignPasses && !postFix) reasons.push('an owner set approval stands in for a QA pass only at the pass limit: ' + passes.length + ' of ' + maxDesignPasses + ' design passes on disk');
  if (postFix) reasons.push(...postFixProblems({ roomDir, id, n, last, sa, maxDesignPasses }));
  if (!last || !last.rec.ok) reasons.push('no readable QA DESIGN pass record in jobs/' + id + '/qa/');
  else {
    if (last.rec.v.verdict === 'approved') reasons.push('the last QA DESIGN pass approved the set: no owner set approval is needed');
    if (sa && qaPassOf(sa.afterQaPass) !== last.n) reasons.push('setApproval.afterQaPass (' + (sa && sa.afterQaPass) + ') is not the last QA pass on disk (qa/design-pass' + last.n + '.json)');
  }
  // the manifest: no limit problems, no build warnings
  const mf = path.join(sd, 'deliverables.json'), m = readJsonSafe(mf);
  if (!m.ok) reasons.push('set-v' + n + '/deliverables.json is ' + m.err + ' (prepare the set first)');
  else {
    if ((m.v.limitProblems || []).length) reasons.push('the manifest has limit problems: ' + m.v.limitProblems.join('; '));
    if ((m.v.buildWarnings || []).length) reasons.push('the manifest has build warnings: ' + m.v.buildWarnings.join('; '));
  }
  // originality: a hard check, for the current design.md
  const dm = path.join(sd, 'design.md'), og = readJsonSafe(path.join(sd, 'originality.json'));
  if (!fs.existsSync(dm)) reasons.push('set-v' + n + '/design.md is missing');
  else if (!og.ok) reasons.push('set-v' + n + '/originality.json is ' + og.err);
  else if (og.v.designNotesSha256 !== sha256(fs.readFileSync(dm, 'utf8'))) reasons.push('the originality record is for an older design.md');
  else if (og.v.result !== 'clear') reasons.push('originality is not clear (' + og.v.result + '): an owner approval never overrules the originality screen');
  // every raw file: one final status
  const raw = path.join(sd, 'raw'), names = fs.existsSync(raw) ? fs.readdirSync(raw).filter((f) => /\.png$/i.test(f)).sort() : [];
  if (!names.length) reasons.push('set-v' + n + '/raw has no PNG files');
  const ef = path.join(sd, 'edits.json'), ed = fs.existsSync(ef) ? readJsonSafe(ef) : null;
  if (ed && !ed.ok) reasons.push('set-v' + n + '/edits.json is ' + ed.err);
  const editOf = (name) => (ed && ed.ok && Array.isArray(ed.v.edits) ? ed.v.edits.find((e) => e.file === 'raw/' + name) : null);
  const reviewPass = qaPassOf(review.reviewOf && review.reviewOf.qaRecord), byName = new Map((review.files || []).map((f) => [f.name, f]));
  const files = [];
  for (const name of names) {
    const f = byName.get(name), now = sha256File(path.join(raw, name));
    if (!f) { reasons.push(name + ': no owner decision in owner-review.json'); continue; }
    const ov = overridesOf(f, reviewPass), row = { name, rawSha256: now };
    if (f.decision === 'fix' || f.decision === 'replace') {
      const e = editOf(name);
      if (!e) { reasons.push(name + ': the owner decided "' + f.decision + '" but set-v' + n + '/edits.json has no edit of raw/' + name); continue; }
      if (!e.output || e.output.sha256 !== now) { reasons.push(name + ': raw/' + name + ' is not the output edits.json records (re-run edit-prop?)'); continue; }
      if (!e.original || e.original.sha256 !== f.rawSha256) { reasons.push(name + ': the edit started from a file other than the one the owner decided on'); continue; }
      Object.assign(row, { status: 'deterministic-fix', fix: f.fix || '', ops: [e.op, ...(e.then || []).map((t) => t.op)], record: 'set-v' + n + '/edits.json' });
    } else if (ov.length) {
      if (f.rawSha256 !== now) { reasons.push(name + ': changed since the owner decided (owner-review.json rawSha256)'); continue; }
      const bad = ov.filter((o) => !String(o.reason).trim() || !String(o.qaSaid).trim());
      if (bad.length) { reasons.push(name + ': an owner override needs the QA finding and the owner\'s reason'); continue; }
      Object.assign(row, { status: 'owner-override', decision: f.decision, overrides: ov });
    } else if (f.decision === 'approved') {
      if (f.rawSha256 !== now) { reasons.push(name + ': changed since the owner decided (owner-review.json rawSha256)'); continue; }
      row.status = 'qa-pass';
    } else { reasons.push(name + ': owner decision "' + f.decision + '" is not approved, an override or a fix'); continue; }
    files.push(row);
  }
  for (const f of review.files || []) if (!names.includes(f.name)) reasons.push(f.name + ': in owner-review.json but not in set-v' + n + '/raw');
  if (reasons.length) return { ok: false, reasons };
  const record = {
    kind: 'owner-set-approval', listingId: id, set: n, decidedBy: 'owner', date: sa.date,
    inPlaceOf: postFix ? 'a further QA DESIGN pass (owner post-fix rule, 18/10/2026: a $0 deterministic fix of build-check findings only)' : 'QA DESIGN pass ' + (maxDesignPasses + 1) + ' (the package gate allows ' + maxDesignPasses + ' design passes)',
    ...(postFix ? { rule: POST_FIX, reviewedPreviews: [...sa.reviewedPreviews].map(String).sort() } : {}),
    ownerWords: sa.words,
    afterQaPass: { file: rel(last.file), pass: last.n, sha256: sha256File(last.file), verdict: last.rec.v.verdict },
    designFile: manifestRel(id, n), manifestSha256: sha256File(mf),
    originality: { result: og.v.result, designNotesSha256: og.v.designNotesSha256 },
    measured: { limitProblems: m.v.limitProblems || [], buildWarnings: m.v.buildWarnings || [], zip: m.v.build && m.v.build.zip ? { name: m.v.build.zip.name, bytes: m.v.build.zip.bytes, sha256: m.v.build.zip.sha256 } : null },
    worthThePrice: sa.worthThePrice || null,
    review: { file: 'owner-review.json', sha256: sha256File(rf) },
    edits: ed && ed.ok ? { file: 'set-v' + n + '/edits.json', sha256: sha256File(ef) } : null,
    counts: Object.fromEntries(FILE_STATUSES.map((s) => [s, files.filter((x) => x.status === s).length])),
    files,
  };
  return { ok: true, record };
}

// the design sign-off the LISTING stage works from (OWNER exception 2026-10-17, digital): QA DESIGN's approved outbox/<id>/qa-design.json, else a
// valid owner set approval, judged by the package gate's own check below (re-composed from disk, so a stale record never counts). Read by the
// price fill (digital-prices.mjs), run-line --listing-only and package-digital. { ok, source, file, designFile, reasons }
export function designSignOff({ id, roomDir, maxDesignPasses = 3, cfg }) {
  const qd = readJsonSafe(path.join(roomDir, 'jobs', id, 'outbox', 'qa-design.json'));
  if (qd.ok && qd.v.verdict === 'approved') return { ok: true, source: 'qa-design', file: 'jobs/' + id + '/outbox/qa-design.json', designFile: qd.v.designFile || null, reasons: [] };
  const oa = checkOwnerSetApproval({ id, roomDir, maxDesignPasses, cfg });
  if (oa && !oa.problems.length) return { ok: true, source: 'owner-set-approval', file: 'jobs/' + id + '/' + APPROVAL_FILE, designFile: oa.designFile, reasons: [] };
  const reasons = [qd.ok ? 'qa-design.json verdict is "' + qd.v.verdict + '"' : 'jobs/' + id + '/outbox/qa-design.json is ' + qd.err];
  if (oa) reasons.push(...oa.problems.map((x) => 'owner set approval: ' + x)); else reasons.push('jobs/' + id + '/' + APPROVAL_FILE + ' is missing');
  return { ok: false, source: null, file: null, designFile: null, reasons };
}

// OWNER listing approval (OWNER exception 2026-10-17, digital): the owner overrules QA LISTING's "revise" with a reason, IN PLACE OF a further
// QA LISTING pass. work/<id>/owner-listing-approval.json is tied to the bytes the same way as the set approval: listing.json, listing.md, QA
// LISTING's record and the deterministic fix record (work/<id>/listing-fixes.json, when there is one) by sha256, and the design sign-off it
// was made on. The gate re-composes it from disk: any change to the listing (or a new QA LISTING record) makes it stale. It never relaxes the
// gate's own listing checks (Etsy limits, US spelling, originality, licence, notice, price floor), which still run on the listing.
export const LISTING_APPROVAL_FILE = 'owner-listing-approval.json';
export function composeListingApproval({ roomDir, id, reason, date, cfg }) {
  const reasons = [], workDir = path.join(roomDir, 'jobs', id), outDir = path.join(roomDir, 'jobs', id, 'outbox');
  if (cfg && cfg.productType !== 'digital') return { ok: false, reasons: ['an owner listing approval is a digital-line exception (productType is "' + cfg.productType + '")'] };
  if (!String(reason || '').trim()) reasons.push('the owner\'s reason is missing');
  if (!DATE_RE.test(String(date || ''))) reasons.push('the date is missing or not YYYY-MM-DD');
  const qf = path.join(outDir, 'qa-listing.json'), q = readJsonSafe(qf), jf = path.join(outDir, 'listing.json'), mf = path.join(outDir, 'listing.md'), L = readJsonSafe(jf);
  const failed = q.ok ? Object.entries(q.v.checks || {}).filter(([, v]) => v === 'fail').map(([k]) => k) : [];
  if (!q.ok) reasons.push('jobs/' + id + '/outbox/qa-listing.json is ' + q.err + ': there is no QA LISTING verdict to overrule');
  else {
    if (q.v.stage !== 'listing' || q.v.listingId !== id) reasons.push('qa-listing.json is not QA LISTING\'s record for ' + id);
    if (q.v.verdict === 'approved' && !failed.length) reasons.push('QA LISTING approved the listing: no owner listing approval is needed');
  }
  if (!L.ok) reasons.push('jobs/' + id + '/outbox/listing.json is ' + L.err);
  else if (L.v.listingId !== id) reasons.push('listing.json listingId mismatch');
  if (!fs.existsSync(mf)) reasons.push('jobs/' + id + '/outbox/listing.md is missing');
  const so = designSignOff({ id, roomDir, cfg });
  if (!so.ok) reasons.push(...so.reasons.map((x) => 'design sign-off: ' + x));
  else if (L.ok && L.v.designFile !== so.designFile) reasons.push('listing.json designFile differs from the design sign-off\'s');
  const ff = path.join(workDir, 'listing-fixes.json'), fx = fs.existsSync(ff) ? readJsonSafe(ff) : null;
  if (fx && !fx.ok) reasons.push('listing-fixes.json is ' + fx.err);
  else if (fx && fs.existsSync(mf) && L.ok && (fx.v.after['listing.json'] !== sha256File(jf) || fx.v.after['listing.md'] !== sha256File(mf))) reasons.push('the listing changed after the deterministic fix (listing-fixes.json)');
  if (reasons.length) return { ok: false, reasons };
  const record = {
    kind: 'owner-listing-approval', listingId: id, decidedBy: 'owner', date,
    inPlaceOf: 'a further QA LISTING pass (pass ' + (q.v.pass ?? '?') + ' sent the listing back)',
    ownerReason: reason,
    overrulesQa: { file: 'jobs/' + id + '/outbox/qa-listing.json', sha256: sha256File(qf), pass: q.v.pass ?? null, verdict: q.v.verdict, failedChecks: failed, reasons: q.v.reasons || [] },
    designSignOff: { source: so.source, file: so.file, sha256: sha256File(path.join(roomDir, so.file)) }, designFile: so.designFile,
    listing: { 'listing.json': sha256File(jf), 'listing.md': sha256File(mf) },
    fixes: fx ? { file: 'jobs/' + id + '/listing-fixes.json', sha256: sha256File(ff), changes: fx.v.changes.length } : null,
  };
  return { ok: true, record };
}
// the gate's check: null when there is none; else { problems } (empty = a valid sign-off in place of QA LISTING's approval)
export function checkOwnerListingApproval({ id, roomDir, cfg }) {
  const af = path.join(roomDir, 'jobs', id, LISTING_APPROVAL_FILE);
  if (!fs.existsSync(af)) return null;
  const a = readJsonSafe(af);
  if (!a.ok) return { problems: [LISTING_APPROVAL_FILE + ' is ' + a.err] };
  const r = a.v;
  if (r.kind !== 'owner-listing-approval' || r.listingId !== id || r.decidedBy !== 'owner') return { problems: [LISTING_APPROVAL_FILE + ' is not the owner\'s approval of the listing of ' + id] };
  const c = composeListingApproval({ roomDir, id, reason: r.ownerReason, date: r.date, cfg });
  if (!c.ok) return { problems: c.reasons };
  const differs = Object.keys({ ...c.record, ...r }).filter((k) => JSON.stringify(c.record[k]) !== JSON.stringify(r[k]));
  if (differs.length) return { problems: [LISTING_APPROVAL_FILE + ' is stale: the listing, QA LISTING\'s record or the design sign-off changed since it was written (' + differs.join(', ') + '); re-run approve-listing.mjs after the owner confirms'] };
  return { problems: [] };
}

// the gate's check: null when there is no owner set approval; else { designFile, problems } (problems empty = a valid design sign-off)
export function checkOwnerSetApproval({ id, roomDir, maxDesignPasses = 3, cfg }) {
  const af = path.join(roomDir, 'jobs', id, APPROVAL_FILE);
  if (!fs.existsSync(af)) return null;
  const a = readJsonSafe(af);
  if (!a.ok) return { designFile: null, problems: [APPROVAL_FILE + ' is ' + a.err] };
  const r = a.v, mm = MANIFEST_RE(id).exec(String(r.designFile || ''));
  if (r.kind !== 'owner-set-approval' || r.listingId !== id || r.decidedBy !== 'owner' || !mm) return { designFile: null, problems: [APPROVAL_FILE + ' is not the owner\'s approval of a deliverable set of ' + id] };
  const c = composeSetApproval({ roomDir, id, n: Number(mm[1]), maxDesignPasses, cfg });
  if (!c.ok) return { designFile: null, problems: c.reasons };
  const differs = Object.keys({ ...c.record, ...r }).filter((k) => k !== 'files' && JSON.stringify(c.record[k]) !== JSON.stringify(r[k]));
  const fileDiffs = c.record.files.filter((f) => JSON.stringify(f) !== JSON.stringify((r.files || []).find((x) => x.name === f.name))).map((f) => f.name);
  if ((r.files || []).length !== c.record.files.length) fileDiffs.push('file count');
  if (differs.length || fileDiffs.length) return { designFile: null, problems: [APPROVAL_FILE + ' is stale: the set, the QA record or the owner review changed since it was written (' + [...differs, ...fileDiffs].join(', ') + '); re-run approve-set.mjs after the owner confirms'] };
  return { designFile: r.designFile, problems: [] };
}
