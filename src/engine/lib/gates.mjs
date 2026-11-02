// PORTED from Virtual-workers/station/scripts/lib/gates.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 19:16), source sha256 9036e90693594b7e0a61d8173b757e304dd9f4b365ab36b078712da272eff633.
//   5th moment: the owner set approval (the design sign-off after the pass limit) and the owner listing approval (in place of QA LISTING's), as in the source
//   change: the POD branch and its import (archive/pod) are removed: digital only
//   change: listingSpellingProblems comes from ./spelling.mjs and gets cfg
//   change: the listing originality screen uses the cfg passed in (the source used the module default config there)
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// gates.mjs — the deterministic package gate collect-outbox applies. Pure reads only (no writes).
// A package passes ONLY with: a valid listing ID; an approved qa-design.json that matches the LATEST design QA
// pass on disk; an approved qa-listing.json; a listing.json within Etsy's limits that names the same design file;
// the AI-disclosure line; and no blocklisted terms. Anything else -> blocked, with every reason listed.
// productType (config, owner 2026-10-16) picks the product checks: "digital" -> lib/digital-gate.mjs (deliverable set, Etsy file limits,
// delivery, licence, asset register, price floor); "pod" -> archive/pod/scripts/lib/pod-gates.mjs (print check, shirt colours, per-variant
// prices, print areas). Everything else here is shared by both.
// Owner set approval (OWNER exception to the station freeze, 2026-10-17; digital only): when there is no approved qa-design.json, a valid
// work/<id>/owner-set-approval.json (lib/owner-approval.mjs: made at the pass limit, after the last QA pass, tied to the set's bytes) is the
// design sign-off in place of a further QA DESIGN pass. Every other check still runs; originality stays a hard check.
// Owner listing approval (OWNER exception, 2026-10-17; digital only): when QA LISTING did not approve cleanly, a valid
// work/<id>/owner-listing-approval.json (tied to the listing files and QA's record by sha256) stands in for its approval. The listing checks
// below (limits, US spelling, originality, digital checks) still run on the listing.
import fs from 'node:fs';
import path from 'node:path';
import { config, isListingId } from './common.mjs';
const pod = false;   // digital only
import { listingSpellingProblems } from './spelling.mjs';
import { screenFields, listingFields, hitLine, SOFT_CATEGORIES } from './originality.mjs';
import { digitalDesignChecks, digitalListingChecks } from './digital-gate.mjs';
import { checkOwnerSetApproval, APPROVAL_FILE, checkOwnerListingApproval, LISTING_APPROVAL_FILE } from './owner-approval.mjs';

export const readJsonSafe = (f) => { try { return { ok: true, v: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) { return { ok: false, err: fs.existsSync(f) ? 'unreadable JSON' : 'missing' }; } };

export function loadBlocklist(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
}

// design QA passes on disk, sorted by pass number
export function designPasses(workDir) {
  const qdir = path.join(workDir, 'qa');
  if (!fs.existsSync(qdir)) return [];
  return fs.readdirSync(qdir).map((n) => /^design-pass(\d+)\.json$/.exec(n)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), file: path.join(qdir, m[0]) })).sort((a, b) => a.n - b.n)
    .map((x) => ({ ...x, rec: readJsonSafe(x.file) }));
}

const r2 = (n) => Math.round(n * 100) / 100;
const PRICE_TOL = 0.02;
// first USD range (or single price) in the brief's "## Price range" section; null when there is none
export function briefUsdRange(briefText) {
  const i = String(briefText || '').indexOf('## Price range');
  if (i < 0) return null;
  const j = briefText.indexOf('\n## ', i + 5);
  const sec = briefText.slice(i, j < 0 ? undefined : j);
  if (/^## Price range\s*\n\s*UNKNOWN/i.test(sec)) return null;   // an UNKNOWN price has no range, even if the text quotes a cost
  const m = /USD\s*([\d]+(?:\.\d+)?)\s*(?:[–—-]|to)\s*(?:USD\s*)?([\d]+(?:\.\d+)?)/i.exec(sec) || /USD\s*([\d]+(?:\.\d+)?)/i.exec(sec);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2] !== undefined ? m[2] : m[1]) };
}
// expected EUR price and margin from the brief, the owner's fx rate and products.json cost. Pure.
export function expectedPricing({ usd, rate, cost }) {
  if (!usd || !rate) return null;
  const out = { min: r2(usd.min * rate), max: r2(usd.max * rate), margin: null };
  if (cost && cost.min != null && cost.max != null) out.margin = { min: r2(out.min - cost.max * rate), max: r2(out.max - cost.min * rate) };
  return out;
}

export const AI_DISCLOSURE_RE = /\bAI\b/;   // description must disclose AI use (exact wording owner-checked)

export function checkPackage({ id, roomDir, blocklist, maxDesignPasses = 3, cfg = config, products = null }) {
  const reasons = [];
  const lim = cfg.etsyLimits;
  const out = { id, reasons, warnings: [], designFile: null, productKey: null, passes: 0, productType: cfg.productType };
  if (!isListingId(id)) { reasons.push('invalid listing id'); return out; }
  const workDir = path.join(roomDir, 'jobs', id), outDir = path.join(roomDir, 'jobs', id, 'outbox');

  // --- design QA ---
  const passes = designPasses(workDir);
  out.passes = passes.length;
  const latest = passes[passes.length - 1];
  const qd = readJsonSafe(path.join(outDir, 'qa-design.json'));
  // the owner's set approval stands in for QA DESIGN only when QA has not approved (null: there is none)
  const oa = qd.ok && qd.v.verdict === 'approved' ? null : checkOwnerSetApproval({ id, roomDir, maxDesignPasses, cfg });
  if (oa) {
    out.ownerSetApproval = { file: 'jobs/' + id + '/' + APPROVAL_FILE, ok: oa.problems.length === 0 };
    for (const pr of oa.problems) reasons.push('owner set approval: ' + pr);
    out.designFile = oa.designFile;
  } else {
    if (!qd.ok) reasons.push('qa-design.json ' + qd.err);
    else {
      const r = qd.v;
      if (r.stage !== 'design') reasons.push('qa-design.json stage is not "design"');
      if (r.verdict !== 'approved') reasons.push('qa-design.json verdict is "' + r.verdict + '"');
      if (r.listingId !== id) reasons.push('qa-design.json listingId mismatch');
      out.designFile = r.designFile;
    }
    if (!latest) reasons.push('no design QA pass records in jobs/' + id + '/qa/');
    else if (!latest.rec.ok) reasons.push('latest design QA record unreadable');
    else {
      if (latest.rec.v.verdict !== 'approved') reasons.push('latest design QA pass (' + latest.n + ') verdict is "' + latest.rec.v.verdict + '"');
      if (qd.ok && latest.rec.v.designFile !== qd.v.designFile) reasons.push('qa-design.json does not match the latest QA pass design file');
    }
  }
  if (passes.length > maxDesignPasses) reasons.push('design took ' + passes.length + ' QA passes (> ' + maxDesignPasses + ' allowed)');
  const failedChecks = (rec) => Object.entries((rec && rec.checks) || {}).filter(([, v]) => v === 'fail').map(([k]) => k);
  if (!oa && qd.ok && failedChecks(qd.v).length) reasons.push('qa-design.json approved with failed checks: ' + failedChecks(qd.v).join(', '));

  // the approved design: POD print file, or the digital deliverable set
  const design = digitalDesignChecks({ id, roomDir, workDir, designFile: out.designFile, qaDesign: oa ? null : (qd.ok ? qd.v : null), ownerApproved: !!oa, reasons, cfg, products });

  // --- listing QA ---
  const ql = readJsonSafe(path.join(outDir, 'qa-listing.json'));
  // the owner's listing approval stands in for QA LISTING's only when QA has not approved cleanly (null: there is none)
  const lo = ql.ok && (ql.v.verdict !== 'approved' || failedChecks(ql.v).length) ? checkOwnerListingApproval({ id, roomDir, cfg }) : null;
  if (lo) {
    out.ownerListingApproval = { file: 'jobs/' + id + '/' + LISTING_APPROVAL_FILE, ok: lo.problems.length === 0 };
    for (const pr of lo.problems) reasons.push('owner listing approval: ' + pr);
  } else if (!ql.ok) reasons.push('qa-listing.json ' + ql.err);
  else {
    if (ql.v.stage !== 'listing') reasons.push('qa-listing.json stage is not "listing"');
    if (ql.v.verdict !== 'approved') reasons.push('qa-listing.json verdict is "' + ql.v.verdict + '"');
    if (ql.v.listingId !== id) reasons.push('qa-listing.json listingId mismatch');
    if (failedChecks(ql.v).length) reasons.push('qa-listing.json approved with failed checks: ' + failedChecks(ql.v).join(', '));
  }

  // --- listing content (deterministic re-check of Etsy limits; QA is not trusted to count) ---
  const lj = readJsonSafe(path.join(outDir, 'listing.json'));
  if (!lj.ok) reasons.push('listing.json ' + lj.err);
  else {
    const L = lj.v;
    out.productKey = L.productKey || null;
    if (L.listingId !== id) reasons.push('listing.json listingId mismatch');
    if (out.designFile && L.designFile !== out.designFile) reasons.push('listing.json designFile differs from the QA-approved design');
    const title = String(L.title || '');
    if (!title.trim()) reasons.push('title empty');
    if ([...title].length > lim.titleMaxChars) reasons.push('title ' + [...title].length + ' chars > ' + lim.titleMaxChars);
    const tags = Array.isArray(L.tags) ? L.tags : [];
    if (!tags.length) reasons.push('no tags');
    if (tags.length > lim.tagsMax) reasons.push(tags.length + ' tags > ' + lim.tagsMax);
    const tagRe = new RegExp(lim.tagPattern);
    for (const t of tags) {
      if ([...String(t)].length > lim.tagMaxChars) reasons.push('tag "' + t + '" ' + [...String(t)].length + ' chars > ' + lim.tagMaxChars);
      if (!tagRe.test(String(t))) reasons.push('tag "' + t + '" has characters Etsy does not allow');
    }
    const lower = tags.map((t) => String(t).toLowerCase().trim());
    if (new Set(lower).size !== lower.length) reasons.push('duplicate tags');
    for (const r of listingSpellingProblems(L, cfg)) reasons.push(r);   // the market is US: UK spellings fail
    digitalListingChecks({ L, workDir, design, reasons, cfg });
    if (!AI_DISCLOSURE_RE.test(String(L.description || ''))) reasons.push('description lacks the AI-use disclosure');
    // originality hard fail on every public text field: title, each tag, description, alt text (lists in config.sloganScreen + rooms/etsy-digital/blocklist.txt)
    for (const h of screenFields(listingFields(L), cfg, { extra: blocklist, ignore: SOFT_CATEGORIES }).hits) reasons.push('originality: ' + hitLine(h));
  }
  out.ok = reasons.length === 0;
  return out;
}
