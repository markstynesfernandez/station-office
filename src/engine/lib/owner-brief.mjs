// lib/owner-brief.mjs — the OWNER BRIEF (owner decision 5, 17/10/2026; DECISIONS.md "E6 step c: owner brief path, research floor,
// scout paused"). A brief the owner writes, with no demand evidence claimed: its Demand evidence says `evidence level: owner` and
// holds no figure, price, table row or URL. The approval card shows "Evidence: OWNER BRIEF — no market evidence" (ui/evidence.js).
// Every originality, IP, blocklist and format check still applies in full:
//   - the schema below (front matter, headings, the owner bounds), at save (orchestrator saveOwnerBrief) and at intake
//   - the originality screen of the WHOLE brief, every category (brands, characters, franchises, people, derivative wording, ...),
//     as the prep step screens brief.md; the scouting blocklist screen (scouted games) runs on every brief (orchestrator checkBriefAll)
//   - the image policy and a digital product, as for every brief; the listing blocklist and gates apply downstream as always
// Price: `owner bounds: USD <min>–<max> (owner brief, YYYY-MM-DD)` in ## Price range; the minimum must be at or above the product's
// BRIEF FLOOR. LISTER proposes a price within the bounds with its reason (listing.json priceProposal: { usd, reason }); the price
// fill lists at it (digital-prices.mjs) and the owner sets the final price at approval. Station code, no model.
import { briefField } from './brief-check.mjs';
import { briefPriceCheck } from './etsy-fees.mjs';
import { imagePolicyProblem } from './image-policy.mjs';
import { screenText, hitLine } from './originality.mjs';
import { ownerPrice } from './demand-evidence.mjs';
import { isListingId, config as defaultConfig } from './common.mjs';

export const OWNER_ORIGIN = 'owner', OWNER_STATUS = 'owner', OWNER_LEVEL = 'owner';
export const OWNER_HEADINGS = ['# Niche', '## Demand evidence', '## Design direction', '## Price range'];
const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
const frontMatter = (t) => (/^---\n([\s\S]*?)\n---\n/.exec(norm(t)) || [])[1] || '';
export const isOwnerBrief = (t) => new RegExp('^origin:[ \\t]*' + OWNER_ORIGIN + '[ \\t]*$', 'm').test(frontMatter(t));
const section = (t, h) => { const s = norm(t), i = s.search(new RegExp('^' + h.replace(/[#]/g, '\\#') + '[ \\t]*$', 'm')); if (i < 0) return null; const rest = s.slice(i).split('\n').slice(1).join('\n'), j = rest.search(/^#{1,2} /m); return j < 0 ? rest : rest.slice(0, j); };

// the owner's price bounds: { min, max, date } or { problem } or null (no line)
const BOUNDS_RE = /^owner bounds:[ \t]*USD[ \t]*(\d+(?:\.\d{1,2})?)[ \t]*(?:[–—-]|to)[ \t]*(?:USD[ \t]*)?(\d+(?:\.\d{1,2})?)[ \t]*\(owner brief,[ \t]*(\d{4}-\d{2}-\d{2})\)[ \t]*$/mi;
export function ownerBounds(text) {
  const sec = section(text, '## Price range'); if (sec === null) return null;
  if (!/^owner bounds:/mi.test(sec)) return null;
  const m = BOUNDS_RE.exec(sec);
  if (!m) return { problem: 'owner bounds must read "owner bounds: USD <min>–<max> (owner brief, YYYY-MM-DD)"' };
  const b = { min: Number(m[1]), max: Number(m[2]), date: m[3] };
  return b.min > b.max ? { problem: 'owner bounds minimum is above its maximum' } : b;
}
// LISTER's proposal (listing.json priceProposal) against the bounds: null when valid, else the problem
export function proposalProblem(p, bounds) {
  if (!p || typeof p !== 'object') return 'LISTER wrote no priceProposal ({ "usd": <price within the owner bounds>, "reason": "<one sentence>" })';
  if (typeof p.usd !== 'number' || !Number.isFinite(p.usd) || Math.round(p.usd * 100) / 100 !== p.usd) return 'priceProposal.usd must be a number in USD with at most 2 decimals, got ' + JSON.stringify(p.usd);
  if (p.usd < bounds.min - 1e-9 || p.usd > bounds.max + 1e-9) return 'priceProposal.usd ' + p.usd.toFixed(2) + ' is outside the owner bounds USD ' + bounds.min.toFixed(2) + '–' + bounds.max.toFixed(2);
  if (typeof p.reason !== 'string' || p.reason.trim().length < 10) return 'priceProposal.reason must give LISTER\'s reason in a sentence';
  return null;
}

// the schema: -> problems[]
export function validateOwnerBrief(text) {
  const t = norm(text), fm = frontMatter(t), p = [];
  if (!fm) return ['an owner brief starts with front matter between --- lines'];
  const f = (k) => briefField(fm, k), id = f('id'), date = f('date');
  if (!isListingId(id)) p.push('id must be YYYY-MM-DD--<slug> (a-z, 0-9, hyphens)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || (id && date !== id.slice(0, 10))) p.push('date must be YYYY-MM-DD and match the id\'s date');
  if (f('status') !== OWNER_STATUS) p.push('status must be "' + OWNER_STATUS + '" (an owner brief is not verified by the Evidence Checker)');
  if (!f('product_type')) p.push('product_type is missing');
  if (!/^audience_segment:[ \t]*\S/m.test(fm)) p.push('audience_segment is missing');
  for (const h of OWNER_HEADINGS) if (section(t, h) === null) p.push('heading "' + h + '" is missing');
  const de = section(t, '## Demand evidence');
  if (de !== null) {
    if (!new RegExp('^evidence level:[ \\t]*' + OWNER_LEVEL + '[ \\t]*$', 'mi').test(de)) p.push('Demand evidence must say "evidence level: ' + OWNER_LEVEL + '"');
    // no demand evidence claimed: no URL, price or count, no table, no Etsy evidence fields, no owner-recorded marker
    if (/https?:\/\//i.test(de)) p.push('Demand evidence of an owner brief cites nothing (a URL is a claim)');
    if (/\b(?:USD|EUR|GBP|CAD|AUD)\s*\d|[$€£]\s*\d/i.test(de)) p.push('Demand evidence of an owner brief claims no price');
    if (/^\s*\|/m.test(de)) p.push('Demand evidence of an owner brief has no table');
    if (/^(?:search phrase|search URL|competitor count|saturation|checked):/mi.test(de) || /^recorded by owner\b/mi.test(de)) p.push('Demand evidence of an owner brief has no Etsy evidence fields (it claims no market evidence)');
  }
  const b = ownerBounds(t), op = ownerPrice(t);
  if (!b && !op) p.push('Price range needs "owner bounds: USD <min>–<max> (owner brief, YYYY-MM-DD)"');
  if (b && b.problem) p.push(b.problem);
  if (op && op.problem) p.push(op.problem);
  if (/\b(?:UNKNOWN|TBD|TODO)\b/.test(t)) p.push('a placeholder (UNKNOWN, TBD, TODO) is not a fact');
  return p;
}

// intake and save: -> { ok, reasons, key, product, evidence: { level: 'owner' }, price }
export function checkOwnerBrief(text, { products = [], cfg = defaultConfig } = {}) {
  const t = norm(text), key = briefField(frontMatter(t), 'product_type'), prod = products.find((x) => x.key === key) || null;
  const v = validateOwnerBrief(t);
  if (v.length) return { ok: false, reasons: v.map((x) => 'owner brief format: ' + x), key, product: prod };
  if (!(prod && prod.digital === true)) return { ok: false, reasons: ['product_type ' + key + ' is not a digital product in products.json'], key, product: prod };
  // the whole brief, every category (a game, brand, character, person, franchise, derivative wording ...)
  const og = screenText(t, cfg);
  if (og.result === 'hit') return { ok: false, reasons: ['originality: owner brief ' + og.hits.map((h) => hitLine({ field: 'text', ...h })).join('; ')], key, product: prod, originality: og };
  const policy = imagePolicyProblem(prod, cfg); if (policy) return { ok: false, reasons: [policy], key, product: prod };
  const r = briefPriceCheck(null, prod, cfg), b = ownerBounds(t), op = ownerPrice(t);
  const price = op
    ? { ok: op.min >= r.floorEur - 1e-9 && (op.point == null || op.point >= r.floorEur - 1e-9), reason: 'owner price EUR ' + op.min.toFixed(2) + '–' + op.max.toFixed(2) + ' against the floor EUR ' + r.floorEur.toFixed(2) }
    : { ok: b.min >= r.floorUsd - 1e-9, reason: 'owner bounds USD ' + b.min.toFixed(2) + '–' + b.max.toFixed(2) + (b.min >= r.floorUsd - 1e-9 ? ' >= ' : ': the minimum is BELOW ') + 'the floor USD ' + r.floorUsd };
  return { ok: price.ok, reasons: price.ok ? [] : ['price: ' + price.reason], key, product: prod, evidence: { level: OWNER_LEVEL }, price: { ...price, floorUsd: r.floorUsd, floorEur: r.floorEur, bounds: b || null } };
}
