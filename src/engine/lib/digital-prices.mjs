// PORTED from Virtual-workers/station/scripts/lib/digital-prices.mjs (the owner's own code) at 17/10/2026 12:34 Irish time (5th moment, re-ported: it changed after 16/10 19:42), source sha256 797d30b7fba8a38cd3fe0910204d20731aec2e7fb4af12f28879ce1bd4489700.
//   5th moment: the fill works from the design sign-off (QA DESIGN's approval or a valid owner set approval, owner-approval.mjs designSignOff), as in the source
//   change: file writes go through the engine's data jail (dataJail from ../store/active.mjs)
//   change: job folders are data/jobs/<id>/ with outbox/ inside (were room1-etsy/work/<id>/ and outbox/<id>/)
//   change: fillDigitalPrices takes the blocklist terms (extra) from the engine instead of reading the station's file
//   the engine's price-fill step calls it with the job's own id, never "the most recently changed listing" (legacy price-hook bug, port item 31)
//   change (owner decision 5, 17/10/2026): an OWNER BRIEF (lib/owner-brief.mjs) has owner bounds instead of market prices; LISTER
//           proposes a price within them with its reason (listing.json priceProposal), every variant lists at it, and the owner sets
//           the final price at approval. A missing or out-of-bounds proposal fails the fill (and the gate). Other briefs: unchanged
// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// digital-prices.mjs (lib) — the digital counterpart of fill-prices.mjs (productType "digital"). Before QA LISTING reviews a listing (price hook,
// every run) a station script, not an agent, fills the listing's FACT fields from the approved deliverable set (QA DESIGN's approval, or a valid
// owner set approval after the pass limit: owner-approval.mjs designSignOff) and the fee model:
//   deliverables      [{ name, format, widthPx, heightPx }] from the approved set-vN/deliverables.json (the listing must state exactly these files)
//   delivery          config.digital.delivery ("automatic download")
//   priceSuggestion   the owner price range when the brief has one, else the brief's sourced USD range in EUR (null where there is none)
//   listingPriceEur   the owner price point, else the low end of the owner range; without an owner price the top of the brief range
//   variantPricesEur  one entry per variant: the owner price as above (never the top-5 high); without one the larger of its floor and the
//                     brief high (no brief: floor + the no-brief uplift)
//   marginEstimate    margin AFTER Etsy fees incl. VAT on seller fees (no production cost, no shipping), min and max over the variants
// and adds the owner to-dos the licence and notice need. Idempotent (nothing written when nothing changes); records the listing originality
// screen. The package gate (digital-gate.mjs) recomputes every value.
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, productsFile } from './common.mjs';
import { variantLadder, noBriefUplift } from './etsy-fees.mjs';
import { briefUsdRange, expectedPricing } from './gates.mjs';
import { ownerPrice } from './demand-evidence.mjs';
import { isOwnerBrief, ownerBounds, proposalProblem } from './owner-brief.mjs';
import { publicView } from './digital-files.mjs';
import { noticeFor } from './digital-build.mjs';
import { recordListingOriginality } from './originality.mjs';
import { designSignOff } from './owner-approval.mjs';
import { dataJail } from '../store/active.mjs';

export const TODO_PRICE = 'confirm price';
export const TODO_TERMS = 'approve the licence and digital-download notice wording in config.digital (both are DRAFT)';
const ours = (t) => t === TODO_TERMS || Object.values(((defaultConfig.digital || {}).assetRegister || {}).assets || {}).some((a) => a.ownerTodo === t) || String(t).startsWith('no-brief price used') || String(t).startsWith('owner price line in the brief is malformed');

// the price decision for a digital listing, shared by the fill and the package gate. With an owner price line in the brief (owner,
// 2026-10-16): every variant at the owner's price point, else at the low end of the owner range; never the top-5 high. Without one: the
// brief high (or floor + uplift), as before. A malformed owner line is reported in `problem` and the gate fails on it.
const r2 = (n) => Math.round(n * 100) / 100;
export function digitalPricing({ product, briefText, cfg = defaultConfig, proposal = null }) {
  const range = briefText ? briefUsdRange(briefText) : null, rate = cfg.fx && cfg.fx.usdToEur, op = briefText ? ownerPrice(briefText) : null;
  // an owner brief without an owner price line: LISTER's proposal within the owner bounds (USD at fx.usdToEur, rounded UP to the
  // cent as the owner floor is, so a proposal at the floor never lists a cent below it)
  const ob = !op && briefText && isOwnerBrief(briefText) ? ownerBounds(briefText) : null;
  if (ob) {
    const problem = ob.problem || proposalProblem(proposal, ob), suggestion = ob.problem ? null : { min: r2(ob.min * rate), max: r2(ob.max * rate) };
    const priceEur = problem ? null : Math.ceil(proposal.usd * rate * 100 - 1e-9) / 100;
    return { basis: 'LISTER proposal', owner: null, ownerBrief: ob.problem ? null : { ...ob, proposal: problem ? null : proposal }, range, rate, priceEur, problem,
      ladder: problem ? variantLadder(product, range, cfg) : variantLadder(product, range, cfg, { priceEur }), suggestion, listingPriceEur: priceEur };
  }
  if (op && !op.problem) {
    const priceEur = op.point != null ? op.point : op.min;
    return { basis: op.point != null ? 'owner price point' : 'owner range low end', owner: op, range, rate, priceEur, problem: null,
      ladder: variantLadder(product, range, cfg, { priceEur }), suggestion: { min: op.min, max: op.max }, listingPriceEur: priceEur };
  }
  const exp = expectedPricing({ usd: range, rate, cost: null });
  return { basis: range ? 'brief high' : 'no brief price', owner: null, range, rate, priceEur: null, problem: (op && op.problem) || null,
    ladder: variantLadder(product, range, cfg), suggestion: exp ? { min: exp.min, max: exp.max } : null, listingPriceEur: exp ? exp.max : null };
}

export function digitalPriceFields({ L, product, briefText, manifest, cfg = defaultConfig }) {
  const pr = digitalPricing({ product, briefText, cfg, proposal: L.priceProposal }), { range, rate, ladder } = pr;
  const exp = pr.suggestion;
  const url = (/https?:\/\/\S+/.exec((String(briefText || '').split('## Price range')[1] || '').split(/\n## /)[0]) || [''])[0].replace(/[).,;]+$/, '');
  const priceSuggestion = pr.ownerBrief && pr.priceEur != null
    ? { min: exp.min, max: exp.max, currency: 'EUR', source: 'brief.md ## Price range, owner bounds USD ' + pr.ownerBrief.min.toFixed(2) + '–' + pr.ownerBrief.max.toFixed(2) + ' (owner brief, ' + pr.ownerBrief.date + '); LISTER proposal USD ' + pr.ownerBrief.proposal.usd.toFixed(2) + ': ' + pr.ownerBrief.proposal.reason, workings: pr.ownerBrief.proposal.usd.toFixed(2) + ' x ' + rate + ' = EUR ' + pr.priceEur.toFixed(2) + ' (fx.usdToEur ' + rate + '); listed at the LISTER proposal; the owner sets the final price at approval' }
    : pr.owner
    ? { min: pr.owner.min, max: pr.owner.max, currency: 'EUR', source: 'brief.md ## Price range, owner price (recorded by owner, ' + pr.owner.date + ')' + (pr.owner.point != null ? '; owner price point EUR ' + pr.owner.point.toFixed(2) + ' (recorded by owner, ' + pr.owner.pointDate + ')' : ''), workings: 'listed at the ' + pr.basis + ': EUR ' + pr.priceEur.toFixed(2) + ' (never the top-5 high)' }
    : exp
      ? { min: exp.min, max: exp.max, currency: 'EUR', source: 'brief.md ## Price range, USD ' + range.min + (range.max !== range.min ? '–' + range.max : '') + (url ? ' (' + url + ')' : ''), workings: range.min + ' x ' + rate + ' = ' + exp.min + '; ' + range.max + ' x ' + rate + ' = ' + exp.max + ' (fx.usdToEur ' + rate + ')' }
      : { min: null, max: null, currency: 'EUR', source: 'the brief has no sourced USD price', workings: 'no parsable USD range in brief.md, or no owner FX rate' };
  const ms = ladder.map((l) => l.marginEur);
  const marginEstimate = ladder.length
    ? { minMarginEur: Math.min(...ms), maxMarginEur: Math.max(...ms), workings: ladder.map((l) => l.label + ': ' + l.proposedEur + ' - Etsy fees incl. VAT = ' + l.marginEur + ' (floor ' + l.floorEur + ')').join('; '), basis: 'after Etsy fees incl. VAT on seller fees; digital: no production cost, no shipping; Offsite Ads not included' }
    : { minMarginEur: null, maxMarginEur: null, workings: 'no variants', basis: 'after Etsy fees' };
  const todo = (Array.isArray(L.ownerTodo) ? L.ownerTodo : []).filter((t) => !ours(t));
  if (!todo.includes(TODO_PRICE)) todo.push(TODO_PRICE);
  const d = cfg.digital || {}, lic = (d.licences || {})[product.licence];
  if (!/^owner-approved/i.test(String(noticeFor(product, cfg).status)) || !lic || !/^owner-approved/i.test(String(lic.status || ''))) todo.push(TODO_TERMS);
  if (!range && !pr.owner) todo.push('no-brief price used (floor + ' + Math.round(noBriefUplift(cfg) * 100) + '%)');
  if (pr.problem) todo.push('owner price line in the brief is malformed: ' + pr.problem);
  for (const k of manifest.assets || []) { const t = (((d.assetRegister || {}).assets || {})[k] || {}).ownerTodo; if (t && !todo.includes(t)) todo.push(t); }   // e.g. skim OpenRouter's terms
  return { ...L, deliverables: manifest.files.map(publicView), delivery: d.delivery, licence: product.licence || null, priceSuggestion, listingPriceEur: pr.listingPriceEur,
    variantPricesEur: ladder.map((l) => ({ variant: l.label, priceEur: l.proposedEur })), marginEstimate, ownerTodo: todo };
}

export function fillDigitalPrices({ id, roomDir, cfg = defaultConfig, products = null, dry = false, extra = null, log = { info() {}, warn() {}, error() {} } }) {
  const lf = path.join(roomDir, 'jobs', id, 'outbox', 'listing.json'), bf = path.join(roomDir, 'jobs', id, 'brief.md');
  const rd = (f, what) => { try { return { v: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) { return { err: what + (fs.existsSync(f) ? ' is not valid JSON' : ' is missing') }; } };
  const l = rd(lf, 'jobs/' + id + '/outbox/listing.json'); if (l.err) return { ok: false, reason: l.err };
  // QA DESIGN's approval, or a valid owner set approval after the pass limit (owner exception 2026-10-17; the package gate's own check)
  const so = designSignOff({ id, roomDir, cfg }); if (!so.ok) return { ok: false, reason: 'no approved deliverable set to list: ' + so.reasons.join('; ') };
  const m = rd(path.join(roomDir, String(so.designFile || 'missing')), String(so.designFile)); if (m.err) return { ok: false, reason: m.err };
  const list = products || JSON.parse(fs.readFileSync(productsFile('digital'), 'utf8')).products, product = list.find((x) => x.key === l.v.productKey);
  if (!product || product.digital !== true) return { ok: false, reason: 'productKey "' + l.v.productKey + '" is not a digital product in products.json' };
  const bt = fs.existsSync(bf) ? fs.readFileSync(bf, 'utf8') : '';
  // an owner brief lists at LISTER's proposal: without a valid one there is no price to fill (fail closed, nothing written)
  if (isOwnerBrief(bt)) { const pp = digitalPricing({ product, briefText: bt, cfg, proposal: l.v.priceProposal }); if (pp.problem) return { ok: false, reason: 'owner brief: ' + pp.problem }; }
  const next = digitalPriceFields({ L: l.v, product, briefText: bt, manifest: m.v, cfg });
  const changed = JSON.stringify(next) !== JSON.stringify(l.v);
  if (changed && !dry) { const tmp = lf + '.tmp'; fs.writeFileSync(dataJail(tmp), JSON.stringify(next, null, 2) + '\n'); fs.renameSync(dataJail(tmp), dataJail(lf)); }
  log.info(dry ? 'dry run: digital fields not written' : changed ? 'digital fields written' : 'digital fields already correct: unchanged', { id, prices: next.variantPricesEur, files: next.deliverables.length });
  const out = { ok: true, changed, dry, prices: next.variantPricesEur, deliverables: next.deliverables.length };
  if (!dry) { try { const o = recordListingOriginality({ roomDir, id, cfg, log, ...(extra ? { extra } : {}) }); out.originality = o.ok ? { result: o.result, hits: o.hits.length } : { error: o.reason }; } catch (e) { log.warn('listing originality record failed: ' + e.message); } }
  return out;
}
