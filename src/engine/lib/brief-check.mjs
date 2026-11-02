// PORTED from Virtual-workers/station/scripts/check-briefs.mjs (the owner's own code) at 16/10/2026 19:58 Irish time (re-ported: it changed after 19:42), source sha256 8b308745d8be4852ac9b2cc7607301d42a1b06fbb1a1ff7e82ef756afc7425c3.
//   change: the per-brief checks of the digital branch become one function, checkBrief(), used by the research line's brief-check step
//           and by the line's intake step (a "verified" brief is checked again before a job starts; the engine never trusts a status alone)
//   change: no CLI, no folder walk, no console output; products, config and today are passed in
//   change: the saturated list applies to the Design direction too (owner Q5, via SOFT_CATEGORIES = [])
//   change (owner, 17/10/2026, DECISIONS.md "E6 step c: owner brief path, research floor"): without an owner price line the floor
//           passes when at least MIN_FLOOR_ROWS top-5 rows show a current price at or above it (floorRowsResearch; EUR rows at the
//           station rate), not on the lowest price; the Price range must be the rows' full range (cheap rows included)
// The rules and their order are the source's: demand evidence first, then at least 5 sourced keywords (owner, 2026-10-16), then a digital product, the originality of the Design direction,
// the image policy, then the price floor (or the owner price line).
import { briefUsdRange } from './gates.mjs';
import { briefPriceCheck, variantLadder } from './etsy-fees.mjs';
import { imagePolicyProblem } from './image-policy.mjs';
import { screenText, hitLine, SOFT_CATEGORIES } from './originality.mjs';
import { demandEvidenceProblems, keywordSourceProblems, ownerPrice } from './demand-evidence.mjs';
import { config as defaultConfig } from './common.mjs';

export const designDirectionOf = (t) => (/^## Design direction[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(t || '').replace(/\r\n/g, '\n')) || [])[1] || '';
export const briefField = (t, k) => { const m = new RegExp('^' + k + ':[ \\t]*(\\S+)', 'm').exec(String(t || '')); return m ? m[1] : null; };

// owner, 17/10/2026: the floor is our minimum listing price, not a rule that the market has no cheaper listings (the genre-scout
// rule, scout-brief.mjs floorRows, now the research line's too). Each top-5 row's current price in USD (a EUR row at fx.usdToEur,
// rounded to the cent; another currency is not counted); the brief passes when MIN_FLOOR_ROWS of them clear the floor
export const MIN_FLOOR_ROWS = 3;
const usdOfRow = (p, cfg) => (!p ? null : p.currency === 'USD' ? p.amount : p.currency === 'EUR' && cfg.fx && cfg.fx.usdToEur ? Math.round((p.amount / cfg.fx.usdToEur) * 100) / 100 : null);
export function floorRowsResearch(evidence, floorUsd, cfg = defaultConfig) {
  const usd = ((evidence && evidence.rows) || []).map((r) => usdOfRow(r.price, cfg)).filter((x) => x != null);
  const at = usd.filter((x) => x >= floorUsd - 1e-9).length;
  return { at, of: usd.length, ok: at >= MIN_FLOOR_ROWS, min: usd.length ? Math.min(...usd) : null, max: usd.length ? Math.max(...usd) : null };
}

// -> { ok, reasons: [], key, product, evidence, price }
export function checkBrief(text, { products = [], cfg = defaultConfig, today = new Date() } = {}) {
  const t = String(text || '').replace(/\r\n/g, '\n'), reasons = [];
  const key = briefField(t, 'product_type'), prod = products.find((x) => x.key === key) || null;
  const de = demandEvidenceProblems(t, { today });
  if (!de.ok) return { ok: false, reasons: ['demand evidence: ' + de.problems.join('; ')], key, product: prod };
  const kw = keywordSourceProblems(t);
  if (!kw.ok) return { ok: false, reasons: ['keywords: ' + kw.problems.join('; ')], key, product: prod };
  if (!(prod && prod.digital === true)) return { ok: false, reasons: ['product_type ' + key + ' is not a digital product in products.json'], key, product: prod };
  const og = screenText(designDirectionOf(t), cfg, { ignore: SOFT_CATEGORIES });
  if (og.result === 'hit') return { ok: false, reasons: ['originality: Design direction ' + og.hits.map((h) => hitLine({ field: 'concept', ...h })).join('; ')], key, product: prod, originality: og };
  const policy = imagePolicyProblem(prod, cfg); if (policy) return { ok: false, reasons: [policy], key, product: prod };
  const range = briefUsdRange(t), r = briefPriceCheck((range || {}).min ?? null, prod, cfg, range);
  const op = ownerPrice(t);
  if (!op && range) {
    // owner, 17/10/2026: 3+ top-5 prices at or above the floor; the Price range is the full range of the rows (within a cent)
    const fr = floorRowsResearch(de.evidence, r.floorUsd, cfg), full = fr.min != null && Math.abs(range.min - fr.min) <= 0.01 + 1e-9 && Math.abs(range.max - fr.max) <= 0.01 + 1e-9;
    r.ok = fr.ok && full;
    r.reason = !full ? 'the Price range USD ' + range.min + '–' + range.max + ' must be the full range of the top-5 prices, USD ' + (fr.min != null ? fr.min.toFixed(2) + '–' + fr.max.toFixed(2) : '(no USD or EUR row)') + ' (cheap rows included, never hidden)'
      : fr.at + ' of ' + fr.of + ' top-5 prices at or above the floor USD ' + r.floorUsd + (fr.ok ? '' : ', needs at least ' + MIN_FLOOR_ROWS + ' (cheaper listings stay in the brief and never fail it)');
  }
  if (op && op.problem) { r.ok = false; r.reason = op.problem; }
  else if (op) {
    r.ladder = variantLadder(prod, range, cfg, { priceEur: op.point != null ? op.point : op.min });
    r.ok = op.min >= r.floorEur - 1e-9 && (op.point == null || op.point >= r.floorEur - 1e-9);
    r.reason = 'owner price EUR ' + op.min.toFixed(2) + '–' + op.max.toFixed(2) + ' (recorded by owner, ' + op.date + ') ' + (op.min >= r.floorEur - 1e-9 ? '>=' : 'is BELOW') + ' the floor EUR ' + r.floorEur.toFixed(2);
  }
  if (!r.ok) reasons.push('price: ' + r.reason);
  return { ok: reasons.length === 0, reasons, key, product: prod, evidence: de.evidence, price: { ok: r.ok, reason: r.reason, floorEur: r.floorEur } };
}
