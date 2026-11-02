// PORTED from Virtual-workers/station/scripts/lib/package-digital.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, new in the source on 17/10/2026), source sha256 0f7d8045d948052bc1794b7adc276760511c8ce9c26538a104f04261bbda7f0a.
//   kept:   only when the package gate passes; the set's download ZIP byte for byte, listing.json, listing.md, MANIFEST.json (every packaged
//           file and every file inside the ZIP with sha256; the gates; the design sign-off; QA LISTING; originality; the owner's approvals
//           and overrides in the owner's words; licence and notice wording with their status; the price as a proposal, final: false) and
//           cost.json; no timestamps; unchanged inputs -> nothing written; built in a staging folder, then renamed into place; refused
//           when the owner has decided on the package
//   change: the package is jobs/<id>/package/ (was approval-queue/<id>/), the engine's approval queue folder
//   change: cost.json is the engine's ledger rows of THIS job (by jobId, with workings), not the time window of the source (backlog item 2
//           of the legacy station, "job-keyed cost", done here); passed in by the orchestrator
//   change: the owner-decided check reads the engine's approvals row (passed in), not the tracker CSV
//   change: every override in MANIFEST.json also carries the file's sha256, the stage, the date and who decided (owner decision 17/10/2026:
//           overrides recorded per file with date, reason and owner, shown in MANIFEST.json)
//   change: file writes go through the engine's data jail; job folders are data/jobs/<id>/ with outbox/ inside
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, sha256, sha256File, isListingId } from './common.mjs';
import { checkPackage, readJsonSafe } from './gates.mjs';
import { MANIFEST_RE } from './digital-prep.mjs';
import { noticeFor, productFor } from './digital-build.mjs';
import { designSignOff, APPROVAL_FILE, checkOwnerListingApproval, LISTING_APPROVAL_FILE } from './owner-approval.mjs';
import { approvedRef } from './style-ref.mjs';
import { dataJail } from '../store/active.mjs';

const OWNER_STATUSES = new Set(['approved', 'rejected_by_owner', 'published', 'retired']);
const json = (v) => JSON.stringify(v, null, 2) + '\n';

export function packageDigital({ id, roomDir, blocklist = [], cost, approvalStatus = null, apply = false, cfg = defaultConfig, products = null, gate = checkPackage, log = { info() {}, warn() {}, error() {} } }) {
  if (cfg.productType !== 'digital') return { ok: false, action: 'refused', reasons: ['package-digital is for the digital line (productType is "' + cfg.productType + '")'] };
  if (!isListingId(id)) return { ok: false, action: 'refused', reasons: ['invalid listing id'] };
  if (approvalStatus && OWNER_STATUSES.has(approvalStatus)) return { ok: false, action: 'refused', reasons: ['the owner has decided "' + approvalStatus + '" on ' + id + ': the package is not rebuilt'] };
  const g = gate({ id, roomDir, blocklist, maxDesignPasses: 3, cfg, products });
  if (g.reasons.length) return { ok: false, action: 'blocked', reasons: g.reasons };
  const so = designSignOff({ id, roomDir, cfg });   // the gate passed, so this is QA DESIGN's approval or a valid owner set approval
  if (!so.ok || so.designFile !== g.designFile) return { ok: false, action: 'blocked', reasons: ['the design sign-off does not match the gate\'s design file'] };
  const mm = MANIFEST_RE(id).exec(String(g.designFile)), n = Number(mm[1]), workDir = path.join(roomDir, 'jobs', id), outDir = path.join(workDir, 'outbox'), sd = path.join(workDir, 'set-v' + n);
  const man = readJsonSafe(path.join(roomDir, g.designFile)).v, zipRow = (man.files || []).find((f) => f.format === 'zip');
  if (!zipRow || (man.files || []).length !== 1) return { ok: false, action: 'blocked', reasons: ['the set is not one ZIP download (the only digital package this step makes)'] };
  const zipSrc = path.join(sd, 'files', zipRow.name);
  if (sha256File(zipSrc) !== zipRow.sha256) return { ok: false, action: 'blocked', reasons: [zipRow.name + ' differs from the set manifest'] };
  const L = readJsonSafe(path.join(outDir, 'listing.json')).v, ql = readJsonSafe(path.join(outDir, 'qa-listing.json')).v;
  const { product } = productFor(roomDir, id, products);
  const lic = ((cfg.digital || {}).licences || {})[product && product.licence] || {}, notice = noticeFor(product, cfg);
  const costText = json(cost);
  const sources = { [zipRow.name]: zipSrc, 'listing.json': path.join(outDir, 'listing.json'), 'listing.md': path.join(outDir, 'listing.md') };
  const files = [...Object.entries(sources).map(([name, f]) => ({ name, bytes: fs.statSync(f).size, sha256: sha256File(f) })), { name: 'cost.json', bytes: Buffer.byteLength(costText), sha256: sha256(costText) }];
  // the owner's approvals: the set approval (each file's final status, every overruled QA finding with the owner's reason) and the style reference
  const ap = so.source === 'owner-set-approval' ? readJsonSafe(path.join(workDir, APPROVAL_FILE)).v : null, sr = approvedRef(roomDir, id);
  const overrides = ap ? ap.files.flatMap((f) => (f.overrides || []).map((o) => ({ file: f.name, sha256: f.rawSha256, stage: 'QA DESIGN', qaPass: o.qaPass, qaSaid: o.qaSaid, ownerReason: o.reason, date: ap.date, decidedBy: ap.decidedBy }))) : [];
  // the owner's listing approval in place of QA LISTING's (the gate passed, so a record that is there is valid), and the deterministic text fix it names
  const lo = checkOwnerListingApproval({ id, roomDir, cfg }), la = lo && !lo.problems.length ? readJsonSafe(path.join(workDir, LISTING_APPROVAL_FILE)).v : null;
  if (la) overrides.push({ file: 'listing (listing.json, listing.md)', sha256: la.listing, stage: 'QA LISTING', qaPass: la.overrulesQa.pass, qaSaid: la.overrulesQa.verdict + ': ' + la.overrulesQa.reasons.join(' | '), ownerReason: la.ownerReason, date: la.date, decidedBy: la.decidedBy });
  const lf = la && la.fixes ? readJsonSafe(path.join(roomDir, la.fixes.file)).v : null;
  const manifest = {
    kind: 'digital-package', listingId: id, productKey: L.productKey, set: n, designFile: g.designFile, download: zipRow.name,
    files, zipEntries: (zipRow.entries || []).map((e) => ({ name: e.name, bytes: e.bytes, widthPx: e.widthPx, heightPx: e.heightPx, sha256: e.sha256 })),
    gates: {
      packageGate: 'pass', warnings: g.warnings || [],
      designSignOff: { source: so.source, file: so.file, sha256: sha256File(path.join(roomDir, so.file)), ...(ap ? { inPlaceOf: ap.inPlaceOf, afterQaPass: ap.afterQaPass } : {}) },
      designPasses: g.passes,
      qaListing: { verdict: ql.verdict, pass: ql.pass ?? null, checks: ql.checks || {}, reasons: ql.reasons || [], sha256: sha256File(path.join(outDir, 'qa-listing.json')),
        ...(la ? { ownerOverride: { file: 'jobs/' + id + '/' + LISTING_APPROVAL_FILE, sha256: sha256File(path.join(workDir, LISTING_APPROVAL_FILE)), decidedBy: la.decidedBy, date: la.date, ownerReason: la.ownerReason, inPlaceOf: la.inPlaceOf, listingSha256: la.listing } } : {}) },
      listingTextFix: lf ? { file: la.fixes.file, sha256: la.fixes.sha256, date: lf.date, decidedBy: lf.decidedBy, model: lf.model, ownerWords: lf.ownerWords, changes: lf.changes } : null,
      originality: { set: readJsonSafe(path.join(sd, 'originality.json')).v.result, listing: (readJsonSafe(path.join(workDir, 'derived', 'listing.originality.json')).v || {}).result || null },
    },
    ownerApprovals: {
      setApproval: ap ? { file: so.file, decidedBy: ap.decidedBy, date: ap.date, ownerWords: ap.ownerWords, counts: ap.counts, files: ap.files.map((f) => ({ name: f.name, status: f.status, ...(f.fix ? { fix: f.fix } : {}) })), worthThePrice: ap.worthThePrice } : null,
      styleReference: sr.ok ? { file: sr.ref.file, sha256: sr.ref.sha256, date: sr.ref.date, decidedBy: sr.ref.decidedBy } : null,
    },
    overrides,
    licence: { key: product && product.licence, text: lic.listingText || null, status: lic.status || null },
    notice: { text: notice.text || null, status: notice.status || null, where: notice.where },
    price: { listingPriceEur: L.listingPriceEur ?? null, priceSuggestion: L.priceSuggestion || null, final: false, note: 'the station\'s proposal from the price rules; the owner sets the price before publishing' },
    costUsd: cost.totalUsd,
    ownerTodo: L.ownerTodo || [],
  };
  const manifestText = json(manifest), dest = path.join(workDir, 'package'), same = fs.existsSync(path.join(dest, 'MANIFEST.json')) && fs.readFileSync(path.join(dest, 'MANIFEST.json'), 'utf8') === manifestText
    && files.every((f) => fs.existsSync(path.join(dest, f.name)) && sha256File(path.join(dest, f.name)) === f.sha256) && fs.readdirSync(dest).length === files.length + 1;
  const summary = { dest: 'jobs/' + id + '/package', files: files.map((f) => f.name + ' (' + f.bytes + ' bytes)'), signOff: so.source, qaListing: ql.verdict + (la ? ' (owner override: ' + la.ownerReason + ')' : ''), costUsd: cost.totalUsd };
  if (same) { log.info('unchanged: jobs/' + id + '/package already holds this package'); return { ok: true, action: 'unchanged', manifest, ...summary }; }
  if (!apply) return { ok: true, action: 'dry', manifest, ...summary };
  const stage = path.join(workDir, 'package.staging-' + process.pid);
  fs.rmSync(dataJail(stage), { recursive: true, force: true }); fs.mkdirSync(dataJail(stage), { recursive: true });
  for (const [name, f] of Object.entries(sources)) fs.copyFileSync(f, dataJail(path.join(stage, name)));
  fs.writeFileSync(dataJail(path.join(stage, 'cost.json')), costText); fs.writeFileSync(dataJail(path.join(stage, 'MANIFEST.json')), manifestText);
  for (const f of files) if (sha256File(path.join(stage, f.name)) !== f.sha256) { fs.rmSync(dataJail(stage), { recursive: true, force: true }); return { ok: false, action: 'failed', reasons: [f.name + ' did not copy byte for byte'] }; }
  // an earlier package of this job is moved aside (job artefacts are never deleted), then the new one is renamed into place
  const replaced = fs.existsSync(dest);
  if (replaced) fs.renameSync(dataJail(dest), dataJail(path.join(workDir, 'package-replaced-' + sha256File(path.join(dest, 'MANIFEST.json')).slice(0, 12))));
  fs.renameSync(dataJail(stage), dataJail(dest));
  log.info((replaced ? 're-packaged (inputs changed): ' : 'packaged: ') + 'jobs/' + id + '/package', summary);
  return { ok: true, action: replaced ? 'repackaged' : 'packaged', manifest, ...summary };
}
