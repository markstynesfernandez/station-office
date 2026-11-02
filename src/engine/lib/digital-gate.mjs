// PORTED from Virtual-workers/station/scripts/lib/digital-gate.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 20:04), source sha256 7a81b0ff6cac146bc631bec5dc60a05cf8a0feb49e8961fa6b71aff7ccdf6ebe.
//   5th moment: the removed-area and near-white fill rules, fileLimitProblems from digital-files.mjs, digitalDesignChecks' ownerApproved, as in the source
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   change (owner decision 5, 17/10/2026): the prices of an owner brief are re-checked against LISTER's proposal (listing.json
//           priceProposal) within the owner bounds, as digital-prices.mjs fills them; other briefs unchanged
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// digital-gate.mjs (lib) — the DIGITAL parts of the package gate (productType "digital"; checkPackage in gates.mjs calls these). Pure reads.
// A digital package passes only when:
//   - QA DESIGN approved THIS deliverable set (designFile = work/<id>/set-vN/deliverables.json, manifestSha256 = that file's sha256) with
//     complete, usable, matchesSpec, worthThePrice and licence all "pass" and a written worthThePrice reason;
//   - the files on disk are still exactly the manifest's (re-measured: name, bytes, sha256), within Etsy's digital limits (config.digital
//     .etsyFileLimits: files per listing, bytes per file), in a format the station can build and measure, never a font file, and they match
//     the product spec in products.json (count, format, pixel size); a packaged product delivers ONE zip whose entries are the spec's files
//     (read back and measured, png/jpg only) and NOTHING else (owner, 2026-10-16: the download is exactly the one zip), every entry the
//     station built, cleaned up and upscaled (set-vN/build.json), with no enclosed background-like region left (a handle hole that is not
//     see-through: digital-build.mjs enclosedBackgroundRegions), no opaque area removed by the clean-up that was not background-coloured in
//     the generated file, and, for the products under the palette rule (config.digital.build.cleanup.palette, owner 2026-10-17), no
//     near-white fill; its preview is a listing photo in set-vN/listing/, never in files/;
//   - the design notes passed the originality screen (set-vN/originality.json, for the current design.md);
//   - every asset the set used is in config.digital.assetRegister with commercialUse true and an owner-confirmed status;
//   - the listing states the deliverables EXACTLY (name, format, pixel size, count), delivery "automatic download", the owner-approved
//     digital-download notice and licence text word for word, no links and no shipping or physical-item claims;
//   - the owner's AI disclosure word for word (config.digital.aiDisclosure);
//   - every price is on the digital floor (Etsy fees + minimum margin; no cost, no shipping) and reconciles with the brief (the owner price
//     point, else the owner range low end, when the brief has an owner price) and the fee model.
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, productsFile, sha256, sha256File } from './common.mjs';
import { measureDir, publicView, fileLimitProblems } from './digital-files.mjs';
import { MANIFEST_RE } from './digital-prep.mjs';
import { isPackaged, noticeFor, previewDirOf } from './digital-build.mjs';
import { styleRefProblems } from './style-ref.mjs';
import { digitalPricing } from './digital-prices.mjs';
import { readJsonSafe } from './gates.mjs';
import { hitLine } from './originality.mjs';
import { imagePolicyProblem } from './image-policy.mjs';

const PRICE_TOL = 0.02;
export const QA_DIGITAL_CHECKS = ['complete', 'usable', 'matchesSpec', 'worthThePrice', 'licence'];
const approved = (s) => /^owner-(approved|confirmed)/i.test(String(s || ''));
const key = (f) => [f.format, f.widthPx, f.heightPx].join('|');

const multisetProblems = (wantSpec, files, where) => {
  const out = [], want = wantSpec.map((s) => key({ format: s.format, widthPx: s.widthPx, heightPx: s.heightPx })), got = files.map(key), show = (k) => k.replace(/\|/g, ' ').replace(/ (\d+) (\d+)$/, ' $1x$2 px');
  if (got.length !== want.length) out.push(where + ' has ' + got.length + ' file(s), the product spec lists ' + want.length);
  const left = [...got];
  for (const w of want) { const i = left.indexOf(w); if (i < 0) out.push('missing a file the product spec lists: ' + show(w)); else left.splice(i, 1); }
  for (const x of left) out.push('a file the product spec does not list: ' + show(x));
  return out;
};

// the product spec's files vs the measured files, as multisets of format + pixel size. A packaged product (deliverables.package zip):
// files/ holds exactly ONE zip whose entries are the spec's files and nothing else: the preview is a listing photo (set-vN/listing/), not a download
export function specProblems(product, files, cfg = defaultConfig) {
  const spec = product && product.deliverables && Array.isArray(product.deliverables.files) ? product.deliverables.files : null;
  if (!spec) return ['products.json "' + (product && product.key) + '" has no deliverables.files spec: the set cannot be checked as complete'];
  if (!isPackaged(product)) return multisetProblems(spec, files, 'the set');
  const zips = files.filter((f) => f.format === 'zip'), rest = files.filter((f) => f.format !== 'zip'), out = [];
  if (zips.length !== 1) out.push('a packaged product delivers exactly ONE zip; files/ has ' + zips.length);
  else out.push(...multisetProblems(spec, zips[0].entries || [], 'the zip ' + zips[0].name).map((s) => 'inside the zip: ' + s));
  if (rest.length) out.push('the download is exactly the one zip, but files/ also holds ' + rest.map((f) => f.name).join(', ') + ' (a preview is a listing photo: set-vN/' + previewDirOf(cfg) + '/, never files/)');
  return out;
}

// the station build record (digital-build.mjs) must cover every delivered file: the zip's entries are exactly the files it built (sha256),
// each cleaned up and upscaled as the product's prep says. The AI disclosure says the files were cleaned up. The listing preview (not a
// download) must be the one it made, in set-vN/listing/, when setDir is given.
export function buildProblems(product, manifest, files, setDir = null, cfg = defaultConfig) {
  const prep = product && product.deliverables && product.deliverables.prep;
  if (!isPackaged(product) && !prep) return [];
  const b = manifest && manifest.build, out = [];
  if (!b || !Array.isArray(b.files)) return ['no station build record in the manifest (set-vN/build.json): the files were not built by the station'];
  const zip = files.find((f) => f.format === 'zip'), entries = (zip && zip.entries) || [];
  if (zip && (zip.name !== (b.zip || {}).name || zip.sha256 !== (b.zip || {}).sha256)) out.push(zip.name + ' is not the zip the station built (build.json)');
  if (entries.length !== b.files.length) out.push('the zip has ' + entries.length + ' file(s), the build record ' + b.files.length);
  for (const e of entries) {
    const r = b.files.find((x) => x.name === e.name);
    if (!r) { out.push(e.name + ': not in the build record'); continue; }
    if (!r.output || r.output.sha256 !== e.sha256) { out.push(e.name + ': differs from the file the station built'); continue; }
    if (prep && prep.cleanup && !r.cleanup) out.push(e.name + ': no clean-up record (the AI disclosure says every file is cleaned up)');
    // enclosed background (owner exception 2026-10-16, the mug's handle hole): the build re-checks every finished file; any enclosed
    // background-like region left (opaque near-white inside a closed shape) is flagged, whatever its outline share
    if (prep && prep.cleanup && r.cleanup) {
      const enc = r.cleanup.enclosed, left = enc && Array.isArray(enc.remainingAfterBuild) ? enc.remainingAfterBuild : null;
      if (!left) out.push(e.name + ': no enclosed-transparency check in the build record (built before it existed: rebuild the set)');
      else if (left.length) out.push(e.name + ': ' + left.length + ' enclosed region(s) of background-like pixels, opaque near-white inside a closed shape (content px x,y,w,h: ' + left.map((x) => x.box.join(',')).join('; ') + '): a hole that should be see-through? Owner check; make it transparent or redraw');
      // the clean-up may remove only what was background-coloured in the generated file (owner, 2026-10-17; every packaged product)
      const rm = enc && enc.removed;
      if (enc && !rm) out.push(e.name + ': no removed-area check in the build record (built before it existed: rebuild the set)');
      else if (rm && rm.nonBackgroundPx) out.push(e.name + ': the clean-up made ' + rm.nonBackgroundPx + ' px transparent that were not background-coloured in the generated file (luminance >= ' + rm.background.minLum + ', channels within ' + rm.background.maxChroma + '; generator px x,y,w,h: ' + rm.nonBackgroundBox.join(',') + '): it removed part of the drawing. Owner check; redraw');
      // the palette rule (owner, 2026-10-17): no pure-white or grey-white fills, for the products config.digital.build.cleanup.palette lists
      const pal = ((cfg.digital.build || {}).cleanup || {}).palette;
      if (pal && (pal.products || []).includes(product.key)) {
        const nw = r.cleanup.palette && r.cleanup.palette.nearWhiteFills;
        if (!Array.isArray(nw)) out.push(e.name + ': no near-white fill check in the build record (built before it existed: rebuild the set)');
        else if (nw.length) out.push(e.name + ': ' + nw.length + ' near-white fill(s), pure white or grey-white (channels within ' + r.cleanup.palette.threshold.maxChroma + '; generator px x,y,w,h: ' + nw.map((x) => x.box.join(',')).join('; ') + '): the palette rule for this product wants cream or a pale palette tint. Redraw');
      }
    }
    if (prep && prep.upscale && (!r.upscale || r.upscale.method !== prep.upscale)) out.push(e.name + ': upscaled with ' + ((r.upscale && r.upscale.method) || 'nothing') + ', not ' + prep.upscale + ' as the product spec requires');
  }
  if (setDir && product.deliverables.package && product.deliverables.package.preview) {
    const want = previewDirOf(cfg) + '/' + (cfg.digital.build.preview || {}).name, pf = path.join(setDir, want);
    if (!b.preview || b.preview.path !== want) out.push('the build record has no listing preview at ' + want + ' (built before the preview left files/? rebuild the set)');
    else if (!fs.existsSync(pf) || sha256File(pf) !== b.preview.sha256) out.push('the listing preview ' + want + ' is missing or is not the one the station built');
  }
  return out;
}

// Etsy limits, our formats, never a font: lives in digital-files.mjs so digital-prep can write the same answer into the manifest QA DESIGN reads
export { fileLimitProblems };

export function assetProblems(assets, cfg = defaultConfig) {
  const reg = ((cfg.digital || {}).assetRegister || {}).assets || {}, out = [];
  for (const k of assets || []) {
    const a = reg[k];
    if (!a) out.push('asset "' + k + '" is not in config.digital.assetRegister: nothing we have not cleared may go into a deliverable');
    else if (a.commercialUse !== true) out.push('asset "' + k + '": commercial use not established (' + (a.status || 'no status') + ')');
    else if (!approved(a.status)) out.push('asset "' + k + '": licence not owner-confirmed yet (' + a.status + ')');
  }
  return out;
}

// ownerApproved: the design sign-off is a valid owner set approval (lib/owner-approval.mjs, checked by the caller against these exact bytes),
// not qa-design.json: QA DESIGN's per-check verdicts are not required; every check below them still runs.
export function digitalDesignChecks({ id, roomDir, workDir, designFile, qaDesign, ownerApproved = false, reasons, cfg = defaultConfig, products = null }) {
  const res = { manifest: null, product: null };
  if (!designFile) return res;
  const norm = String(designFile).replace(/\\/g, '/'), mm = MANIFEST_RE(id).exec(norm);
  if (!mm) { reasons.push('designFile is not a deliverable-set manifest (jobs/' + id + '/set-vN/deliverables.json): ' + designFile); return res; }
  const mf = path.join(roomDir, norm), sd = path.dirname(mf), m = readJsonSafe(mf);
  if (!m.ok) { reasons.push('deliverables manifest ' + m.err + ': ' + norm); return res; }
  res.manifest = m.v;
  if (!ownerApproved) {
    if (qaDesign && qaDesign.manifestSha256 !== sha256File(mf)) reasons.push('qa-design.json manifestSha256 does not match ' + norm + ': QA DESIGN did not review this exact set');
    // QA DESIGN's digital checks and the worth-the-price judgement
    const ch = (qaDesign && qaDesign.checks) || {};
    for (const c of QA_DIGITAL_CHECKS) if (ch[c] !== 'pass') reasons.push('qa-design.json check "' + c + '" is ' + (ch[c] === undefined ? 'missing' : '"' + ch[c] + '"') + ' (digital QA requires it to pass)');
    const wp = qaDesign && qaDesign.worthThePrice;
    if (!wp || wp.verdict !== 'pass' || !String(wp.reason || '').trim()) reasons.push('qa-design.json worthThePrice needs verdict "pass" and a written reason (would a buyer feel this was worth the price?)');
  }
  // the files on disk are exactly the manifest's
  const now = measureDir(path.join(sd, 'files')), was = Array.isArray(m.v.files) ? m.v.files : [];
  const sig = (fs_) => JSON.stringify(fs_.map((f) => [f.name, f.bytes, f.sha256]));
  if (sig(now.files) !== sig(was)) reasons.push('the files in ' + path.posix.dirname(norm) + '/files/ have changed since the manifest was written (re-run the design hook and QA DESIGN)');
  if (now.subfolders.length) reasons.push('sub-folders inside files/ are not deliverables: ' + now.subfolders.join(', '));
  for (const r of fileLimitProblems(now.files, cfg)) reasons.push(r);
  // product spec: complete set
  const bf = path.join(workDir, 'brief.md'), pk = fs.existsSync(bf) ? ((/^product_type:\s*(\S+)/m.exec(fs.readFileSync(bf, 'utf8')) || [])[1] || null) : null;
  let list = products; if (!list) { try { list = JSON.parse(fs.readFileSync(productsFile('digital'), 'utf8')).products; } catch (_) { list = []; } }
  res.product = list.find((x) => x.key === pk) || null;
  if (!res.product || res.product.digital !== true) reasons.push('brief product_type "' + pk + '" is not a digital product in products.json');
  else {
    const pol = imagePolicyProblem(res.product, cfg); if (pol) reasons.push(pol);
    for (const r of specProblems(res.product, now.files, cfg)) reasons.push('incomplete or wrong set: ' + r);
    for (const r of buildProblems(res.product, m.v, now.files, sd, cfg)) reasons.push('station build: ' + r);
    for (const r of styleRefProblems({ roomDir, id, product: res.product, build: m.v.build })) reasons.push('style reference: ' + r);
  }
  // originality of the design notes (prompts), for the current design.md
  const dm = path.join(sd, 'design.md'), og = readJsonSafe(path.join(sd, 'originality.json'));
  if (!fs.existsSync(dm)) reasons.push('design.md missing in ' + path.posix.dirname(norm));
  else if (!og.ok) reasons.push('originality record ' + og.err + ' (' + path.posix.dirname(norm) + '/originality.json)');
  else if (og.v.designNotesSha256 !== sha256(fs.readFileSync(dm, 'utf8'))) reasons.push('the originality record is for an older design.md');
  else if (og.v.result !== 'clear') reasons.push(...(og.v.hits || []).map((h) => 'originality: ' + hitLine(h) + ' (set-v' + mm[1] + ')'), ...(og.v.hits && og.v.hits.length ? [] : ['originality record result is "' + og.v.result + '"']));
  // licence: every asset cleared for commercial use
  for (const r of assetProblems(m.v.assets, cfg)) reasons.push(r);
  return res;
}

export function digitalListingChecks({ L, workDir, design, reasons, cfg = defaultConfig }) {
  const d = cfg.digital, desc = String(L.description || ''), product = design && design.product, manifest = design && design.manifest;
  if (L.delivery !== d.delivery) reasons.push('delivery must be "' + d.delivery + '" (got ' + JSON.stringify(L.delivery) + ')');
  // the listing states the files exactly
  if (manifest && Array.isArray(manifest.files)) {
    const want = JSON.stringify(manifest.files.map(publicView)), got = JSON.stringify(Array.isArray(L.deliverables) ? L.deliverables.map(publicView) : null);
    if (want !== got) reasons.push('listing deliverables do not match the approved set exactly (name, format, pixel size, count): listing ' + got + ', set ' + want);
  }
  // notice and licence: owner-approved wording, word for word
  const nt = noticeFor(product, cfg);
  if (!approved(nt.status)) reasons.push('the digital-download notice wording is not owner-approved (' + nt.where + ': ' + nt.status + ')');
  if (!nt.text || !desc.includes(nt.text)) reasons.push('description lacks the digital-download notice, word for word (' + nt.where + ')');
  const lic = product && d.licences[product.licence];
  if (!product || !product.licence) reasons.push('the product has no licence key in products.json');
  else if (!lic) reasons.push('licence "' + product.licence + '" is not in config.digital.licences');
  else {
    if (L.licence !== product.licence) reasons.push('listing licence "' + L.licence + '" differs from the product licence "' + product.licence + '"');
    if (!approved(lic.status)) reasons.push('licence "' + product.licence + '" wording is not owner-approved (' + lic.status + ')');
    if (!desc.includes(lic.listingText)) reasons.push('description lacks the licence terms, word for word (config.digital.licences.' + product.licence + '.listingText)');
  }
  if (/https?:\/\/|www\./i.test(desc)) reasons.push('description contains a link: delivery is automatic download only, never an external link');
  const rest = nt.text ? desc.split(nt.text).join(' ') : desc;
  if (/\b(ships?|shipping|shipped|postage|printed and (sent|mailed)|physical (item|product|print))\b/i.test(rest)) reasons.push('description makes a shipping or physical-item claim: this is a digital download');
  if (L.printAreas != null) reasons.push('printAreas has no meaning for a digital download');
  // the image model's terms (owner, 2026-10-16): never claim unique, exclusive or one of a kind, never hand-drawn
  if (d.forbiddenClaims && d.forbiddenClaims.pattern) {
    const re = new RegExp(d.forbiddenClaims.pattern, 'i');
    for (const [k, v] of [['title', L.title], ['tags', (L.tags || []).join(' | ')], ['description', desc], ['altText', L.altText]]) { const m = re.exec(String(v || '')); if (m) reasons.push(k + ' says "' + m[0] + '": a listing never claims the files are unique, exclusive, one of a kind or hand-drawn (image model terms, owner 2026-10-16)'); }
  }
  // the owner's AI disclosure, word for word; it says the files were cleaned up, so the product must have the station clean-up step
  const ai = d.aiDisclosure && d.aiDisclosure.text;
  if (!ai) reasons.push('config.digital.aiDisclosure.text is missing');
  else {
    if (!desc.includes(ai)) reasons.push('description lacks the AI disclosure, word for word (config.digital.aiDisclosure.text)');
    if (/cleaned up/i.test(ai) && product && !(product.deliverables && product.deliverables.prep && product.deliverables.prep.cleanup)) reasons.push('the AI disclosure says each file is cleaned up, but product "' + product.key + '" has no station clean-up step (deliverables.prep.cleanup)');
  }
  // prices on the digital floor, reconciled with the brief (or the owner price in it) and the fee model
  if (!product) return;
  const bf = path.join(workDir, 'brief.md'), pr = digitalPricing({ product, briefText: fs.existsSync(bf) ? fs.readFileSync(bf, 'utf8') : '', cfg, proposal: L.priceProposal });
  if (pr.problem) reasons.push('brief owner price: ' + pr.problem);
  const usd = pr.range, rate = pr.rate, ladder = pr.ladder, exp = pr.suggestion, ps = L.priceSuggestion || {}, me = L.marginEstimate || {};
  if (!Array.isArray(L.variantPricesEur) || !L.variantPricesEur.length) { reasons.push('variantPricesEur is required (one { variant, priceEur } per variant)'); return; }
  const got = new Map(L.variantPricesEur.map((v) => [String(v.variant), v.priceEur]));
  for (const w of ladder) {
    const g = got.get(w.label);
    if (typeof g !== 'number') reasons.push('variantPricesEur has no price for "' + w.label + '" (expected EUR ' + w.proposedEur + ')');
    else if (g < w.floorEur - PRICE_TOL) reasons.push('variantPricesEur "' + w.label + '" is ' + g + ', BELOW the digital floor EUR ' + w.floorEur + ' (Etsy fees incl. VAT + minimum margin)');
    else if (Math.abs(g - w.proposedEur) > PRICE_TOL) reasons.push('variantPricesEur "' + w.label + '" is ' + g + ', expected EUR ' + w.proposedEur + (pr.owner ? ' (the ' + pr.basis + ' in the brief)' : pr.ownerBrief ? ' (the LISTER proposal within the owner bounds)' : usd ? ' (the larger of the floor ' + w.floorEur + ' and the brief high)' : ' (no brief price: floor + the no-brief uplift)'));
  }
  for (const k of got.keys()) if (!ladder.some((w) => w.label === k)) reasons.push('variantPricesEur names a variant that is not in products.json: "' + k + '"');
  const what = pr.owner ? 'the owner price range in the brief' : pr.ownerBrief ? 'the owner bounds in the brief at ' + rate : 'the brief range at ' + rate;
  if (!exp) { if (ps.min != null || ps.max != null) reasons.push('priceSuggestion has numbers but the brief has no parsable USD range or there is no FX rate: it must be null'); }
  else if (ps.currency !== 'EUR' || Math.abs((ps.min ?? NaN) - exp.min) > PRICE_TOL || Math.abs((ps.max ?? NaN) - exp.max) > PRICE_TOL) reasons.push('priceSuggestion must be EUR ' + exp.min + '–' + exp.max + ' (' + what + ')');
  if (pr.listingPriceEur != null && L.listingPriceEur != null && Math.abs(L.listingPriceEur - pr.listingPriceEur) > PRICE_TOL) reasons.push('listingPriceEur ' + L.listingPriceEur + ' must be EUR ' + pr.listingPriceEur + ' (' + (pr.owner ? 'the ' + pr.basis : pr.ownerBrief ? 'the LISTER proposal' : 'the top of the brief range') + ')');
  const ms = ladder.map((w) => w.marginEur);
  if (typeof me.minMarginEur !== 'number' || Math.abs(me.minMarginEur - Math.min(...ms)) > PRICE_TOL || Math.abs(me.maxMarginEur - Math.max(...ms)) > PRICE_TOL) reasons.push('marginEstimate must be EUR ' + Math.min(...ms) + '–' + Math.max(...ms) + ' after Etsy fees (got ' + me.minMarginEur + '–' + me.maxMarginEur + ')');
}
