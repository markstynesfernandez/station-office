// PORTED from Virtual-workers/station/scripts/lib/etsy-fees.mjs (the owner's own code) at 16/10/2026 19:16 Irish time, source sha256 c22bf16e394b6074b38e2e87d97bffb60a9ef99c76cf69cd0aa8c51389250d19.
//   change: the POD shipping helpers are kept so the ported fee tests run unchanged; the digital line never calls them
//   change (E6 c0, owner D1 17/10/2026): a digital product's owner floor (products.json priceFloorUsd) replaces the fee-model floor in
//           variantLadder and briefPriceCheck (productFloor), so every check that reads the floor reads the same one

// Everything else is the source unchanged. PORTED.md lists every ported file; npm run port-drift checks the source.
// etsy-fees.mjs — Etsy fee model and the PER-VARIANT PRICE FLOOR, all driven by config.etsyFees (rates, sources and dates live there).
// Pure functions. Money in EUR unless named Usd. Fees: listing + transaction % + payment processing (% + fixed) + VAT. config.etsyFees.vatOnSellerFees
// (default on, 23%) puts VAT on ALL THREE seller fees (EU seller without a VAT ID); with it off, VAT is on the processing fee only (vatOnProcessingPct). Transaction fee: on the total excluding tax; processing: on the total including tax (estimatedSalesTaxPct, default 0). Offsite Ads is a
// WORST-CASE extra (opts.offsite), never part of the default or the floor. Currency conversion (2.5%) is not modelled: feeRates throws if listing and
// payout currency differ (config.etsyFees.currencies). SHIPPING is modelled (config.shippingPolicy.mode + products.json shippingCostUsd): Etsy's transaction and
// processing fees apply to the item price PLUS the shipping charged, and our shipping cost is a cost of the sale. pass-through: the buyer
// is charged shipping = our shipping cost; free-shipping: the buyer is charged 0 and the cost sits inside the item price.
// A variant's floor is the lowest item price at which price + shipping charged - fees - its OWN production cost - shipping cost >= the
// minimum margin. There is no single floor per product: each size/colour has its own.
import { config } from './common.mjs';

const r2 = (n) => Math.round(n * 100) / 100;
export function vatRates(e) {
  const v = e.vatOnSellerFees;
  if (v && v.enabled !== false) { const r = (v.ratePct || 0) / 100, on = new Set(v.appliesTo || ['listing', 'transaction', 'processing']); return { vat: on.has('processing') ? r : 0, vatListing: on.has('listing') ? r : 0, vatTx: on.has('transaction') ? r : 0, vatAll: true }; }
  const p = e.rates.vatOnProcessingPct ? e.rates.vatOnProcessingPct.value / 100 : 0;
  return { vat: p, vatListing: 0, vatTx: 0, vatAll: false };
}
export const feeRates = (cfg = config) => {
  const e = cfg.etsyFees, r = e.rates, fx = cfg.fx.usdToEur, c = e.currencies;
  // the 2.5% currency-conversion fee is not modelled, so the model refuses to run if the listing and payout currencies ever differ
  if (!c || !c.listingCurrency || c.listingCurrency !== c.payoutCurrency) throw new Error('etsyFees.currencies: listingCurrency (' + (c && c.listingCurrency) + ') must equal payoutCurrency (' + (c && c.payoutCurrency) + '): the ' + (c && c.currencyConversionPct) + '% conversion fee is not modelled');
  const tax = r.estimatedSalesTaxPct ? r.estimatedSalesTaxPct.value / 100 : 0;
  return {
    // procPct is applied to item + shipping charged; Etsy charges it on the total INCLUDING tax, so the estimated sales tax is folded in here (fixed part unaffected)
    listing: r.listingFeeUsd.value * fx, txPct: r.transactionPct.value / 100, procPct: r.paymentProcessingPct.value / 100 * (1 + tax), salesTax: tax, procFixed: r.paymentProcessingFixedEur.value,
    // VAT on seller fees: vatOnSellerFees on (default) -> the one rate on listing, transaction AND processing; off -> only the processing fee (legacy vatOnProcessingPct)
    ...vatRates(e), offsitePct: e.worstCase && e.worstCase.offsiteAdsPct ? e.worstCase.offsiteAdsPct.value / 100 : 0,
    minMargin: e.minMarginEur.value, fx
  };
};
// shipping for one product under the owner's policy: cost to us, what the buyer is charged, and whether the cost is known at all.
export function shippingFor(product, cfg = config) {
  if (product && product.digital === true) return { mode: 'none (digital download)', known: true, costUsd: 0, costEur: 0, chargedEur: 0 };   // automatic download: nothing ships
  const mode = (cfg.shippingPolicy && cfg.shippingPolicy.mode) || 'pass-through', fx = cfg.fx.usdToEur;
  const usd = product && typeof product.shippingCostUsd === 'number' ? product.shippingCostUsd : null, costEur = r2((usd || 0) * fx);
  return { mode, known: usd != null, costUsd: usd || 0, costEur, chargedEur: mode === 'pass-through' ? costEur : 0 };
}
const NO_SHIP = { mode: 'none', known: false, costUsd: 0, costEur: 0, chargedEur: 0 };
// fees on one sale: base = item price + shipping charged (listing fee is per listing/sale, counted once per sale: conservative)
export function etsyFees(priceEur, cfg = config, { offsite = false, shipChargedEur = 0 } = {}) {
  const k = feeRates(cfg), base = priceEur + shipChargedEur, proc = base * k.procPct + k.procFixed;
  const parts = { listing: k.listing, transaction: base * k.txPct, processing: proc, vatOnProcessing: proc * k.vat };
  if (k.vatAll) { parts.vatOnListing = k.listing * k.vatListing; parts.vatOnTransaction = base * k.txPct * k.vatTx; }
  if (offsite) parts.offsiteAds = base * k.offsitePct;
  const out = Object.fromEntries(Object.entries(parts).map(([a, b]) => [a, r2(b)]));
  out.total = r2(Object.values(parts).reduce((s, v) => s + v, 0));
  return out;
}
// margin = item price + shipping charged - fees on (item + shipping charged) - production cost - shipping cost. opts.ship = shippingFor(...)
export const marginAfterFees = (priceEur, costEur, cfg = config, { ship = NO_SHIP, offsite = false } = {}) => r2(priceEur + ship.chargedEur - etsyFees(priceEur, cfg, { offsite, shipChargedEur: ship.chargedEur }).total - costEur - ship.costEur);
// floor ITEM price (EUR) for ONE variant with scalar production cost in USD, shipping per `ship` (shippingFor): with B = P + charged, solve
//   P + charged - (listing + txPct*B + (procPct*B + procFixed)*(1 + vat)) - cost - shipCost = minMargin
export function variantFloor(costUsd, cfg = config, ship = NO_SHIP) {
  const k = feeRates(cfg), cost = costUsd * k.fx, d = 1 - k.txPct * (1 + k.vatTx) - k.procPct * (1 + k.vat);
  const eur = (cost + ship.costEur - ship.chargedEur + k.minMargin + k.listing * (1 + k.vatListing) + k.procFixed * (1 + k.vat) + ship.chargedEur * (1 - d)) / d;
  const floorEur = Math.ceil(eur * 100 - 1e-9) / 100, floorUsd = Math.ceil((floorEur / k.fx) * 100 - 1e-9) / 100;
  return { floorEur, floorUsd, costEur: r2(cost), minMargin: k.minMargin,
    workings: `(${r2(cost)} production + ${ship.costEur} shipping cost - ${ship.chargedEur} shipping charged + ${k.minMargin} min margin + ${r2(k.listing * (1 + k.vatListing))} listing incl. VAT + ${k.procFixed} x ${r2(1 + k.vat)} processing fixed incl. VAT + ${ship.chargedEur} x ${r2(1 - d)} fees on shipping charged) / (1 - ${k.txPct} x ${r2(1 + k.vatTx)} - ${k.procPct} x ${r2(1 + k.vat)}) = ${floorEur} EUR = USD ${floorUsd} at ${k.fx}` };
}
// The variants of a products.json product. `variants: [{ label, productionCostUsd }]` when the owner has entered them; otherwise the two
// ENDPOINTS of productionCostUsd {min,max} stand in (derived: true) so the gap is visible, never papered over.
// A DIGITAL product (products.json `digital: true`, productType "digital") has no production cost: every variant costs 0, so its floor is
// Etsy fees (listing, transaction, processing, VAT on seller fees) + the minimum margin. Default variant: "Digital download".
export function variantsOf(product) {
  if (product && product.digital === true) return (Array.isArray(product.variants) && product.variants.length ? product.variants.filter((v) => v.active !== false) : [{ label: 'Digital download' }]).map((v) => ({ label: v.label, costUsd: 0, derived: false, unconfirmed: false }));
  if (Array.isArray(product.variants) && product.variants.length) {
    const dearest = (product.productionCostUsd || {}).max;
    return product.variants.filter((v) => v.active !== false).map((v) => {
      if (typeof v.productionCostUsd === 'number') return { label: v.label, costUsd: v.productionCostUsd, derived: false, unconfirmed: false };
      if (typeof v.blankUsd === 'number') return { label: v.label, costUsd: r2(v.blankUsd + ((product.productionCostBreakdown || {}).frontPrintUsd || 0)), derived: false, unconfirmed: false };
      // cost not entered: conservative rule (owner, 2026-10-15): treat it as the DEAREST known blank + print, flagged "cost unconfirmed"
      return { label: v.label, costUsd: dearest, derived: false, unconfirmed: true };
    });
  }
  const c = product.productionCostUsd; if (!c || c.min == null || c.max == null) return [];
  return c.min === c.max ? [{ label: 'all variants (single cost as read)', costUsd: c.max, derived: true }]
    : [{ label: 'cheapest variant (cost as read)', costUsd: c.min, derived: true }, { label: 'dearest variant (cost as read)', costUsd: c.max, derived: true }];
}
// price ladder: per variant cost -> minimum price (floor) -> proposed price. Owner rule (2026-10-15): price toward the TOP of the range.
// With a brief: proposed = the larger of the variant's floor and the brief's HIGHEST sourced price. Without one: floor + the no-brief
// uplift (cfg.pricingPolicy.noBriefUpliftPct, default 15%). 2 dp. aboveRange: the variant's floor exceeds the brief's highest sourced
// price (it cannot be sold at the sourced price level: FLAGGED for the owner, never a failure). briefUsd = { min, max } or null.
// the basis line written into a package's variant-prices.json (collect-outbox, refresh-variant-prices)
export function variantPricesBasis(cfg = config) {
  const v = vatRates(cfg.etsyFees), pct = v.vatAll ? (cfg.etsyFees.vatOnSellerFees.ratePct + '% VAT on listing, transaction and processing fees') : 'VAT on processing';
  return 'per-variant floor: production cost + shipping + Etsy fees (incl. ' + pct + ') + minimum margin EUR ' + cfg.etsyFees.minMarginEur.value + '; proposed = larger of the floor and the brief HIGH (no brief price: floor + the no-brief uplift); margin shown after Etsy fees and with Offsite Ads (worst case); before AI spend';
}
// fee settings not yet owner-confirmed (config.etsyFees.rates + the vatOnSellerFees switch when it is on)
export function unconfirmedFeeRates(cfg = config) {
  const e = cfg.etsyFees, out = Object.entries(e.rates).filter(([, v]) => !/^owner-confirmed/i.test(v.status)).map(([k]) => k);
  if (e.vatOnSellerFees && e.vatOnSellerFees.enabled !== false && !/^owner-confirmed/i.test(e.vatOnSellerFees.status || '')) out.push('vatOnSellerFees');
  return out;
}
// the floor of ANY digital item (no production cost, no shipping): fees + minimum margin, with its workings
export const digitalFloor = (cfg = config) => variantFloor(0, cfg, NO_SHIP);
// owner D1 (17/10/2026): a digital product may carry the owner's own floor, products.json priceFloorUsd { value } in USD. It is
// a minimum and replaces the fee-model floor for that product: USD as given, EUR = USD x fx rounded UP to the cent. Malformed: null
// (the fee-model floor applies, the safe side for a value the owner did not write correctly).
export function ownerFloor(product, cfg = config) {
  const f = product && product.digital === true ? product.priceFloorUsd : null;
  if (!f || typeof f.value !== 'number' || !Number.isFinite(f.value) || !(f.value > 0)) return null;
  const fx = cfg.fx.usdToEur, floorUsd = r2(f.value), floorEur = Math.ceil(floorUsd * fx * 100 - 1e-9) / 100;
  return { floorUsd, floorEur, decidedBy: f.decidedBy || null, date: f.date || null };
}
// the floor of one variant of a product: the owner floor when the product has one, else the fee-model floor
export function productFloor(product, v, cfg = config, ship = NO_SHIP) {
  const f = variantFloor(v.costUsd, cfg, ship), o = ownerFloor(product, cfg);
  if (!o) return f;
  return { ...f, floorEur: o.floorEur, floorUsd: o.floorUsd, ownerFloor: true,
    workings: 'owner floor USD ' + o.floorUsd + ' (products.json priceFloorUsd, ' + (o.decidedBy || 'owner') + ' ' + (o.date || '') + ') x ' + cfg.fx.usdToEur + ' = EUR ' + o.floorEur + ' (rounded up); fee-model floor would be ' + f.workings };
}
export const noBriefUplift = (cfg = config) => ((cfg.pricingPolicy && cfg.pricingPolicy.noBriefUpliftPct) ?? 15) / 100;
// opts.priceEur (digital, owner price): every variant is proposed at exactly that price, never the brief high; the gate checks it against the floor
export function variantLadder(product, briefUsd = null, cfg = config, { priceEur = null } = {}) {
  const fx = cfg.fx.usdToEur, ship = shippingFor(product, cfg);
  return variantsOf(product).map((v) => {
    const f = productFloor(product, v, cfg, ship);
    const highEur = priceEur != null ? null : briefUsd ? r2(briefUsd.max * fx) : null;
    const proposedEur = r2(priceEur != null ? priceEur : highEur != null ? Math.max(f.floorEur, highEur) : f.floorEur * (1 + noBriefUplift(cfg)));
    return { label: v.label, derived: v.derived, unconfirmed: !!v.unconfirmed, costUsd: v.costUsd, costEur: f.costEur, floorEur: f.floorEur, floorUsd: f.floorUsd, proposedEur,
      marginEur: marginAfterFees(proposedEur, f.costEur, cfg, { ship }), marginOffsiteEur: marginAfterFees(proposedEur, f.costEur, cfg, { ship, offsite: true }),
      shipCostEur: ship.costEur, shipChargedEur: ship.chargedEur, shipMode: ship.mode, shipKnown: ship.known, aboveRange: highEur != null && f.floorEur > highEur + 1e-9, workings: f.workings };
  });
}
// brief gate: the lowest sourced price must clear the floor of the CHEAPEST variant (the base item is sold at the market's low). Dearer
// variants are priced on their own floors by variantLadder and flagged when they exceed the sourced range; they do not fail the brief.
// usdMin null (UNKNOWN price) fails: the brief has no price to test.
export function briefPriceCheck(usdMin, product, cfg = config, briefUsd = null) {
  const vs = variantsOf(product);
  if (!vs.length) return { ok: false, reason: 'product has no production cost', variants: [] };
  const ship = shippingFor(product, cfg), floors = vs.map((v) => ({ ...v, ...productFloor(product, v, cfg, ship) })), cheapest = floors.reduce((a, b) => (b.floorUsd < a.floorUsd ? b : a));
  const ladder = variantLadder(product, briefUsd || (usdMin != null ? { min: usdMin, max: usdMin } : null), cfg);
  if (usdMin == null) return { ok: false, reason: 'brief has no sourced USD price', floorUsd: cheapest.floorUsd, floorEur: cheapest.floorEur, ladder };
  const ok = usdMin >= cheapest.floorUsd - 1e-9;
  const above = ladder.filter((x) => x.aboveRange).map((x) => x.label);
  return { ok, floorUsd: cheapest.floorUsd, floorEur: cheapest.floorEur, cheapest: cheapest.label, ladder, aboveRange: above,
    reason: (ok ? 'lowest price USD ' + usdMin + ' >= floor USD ' + cheapest.floorUsd : 'lowest price USD ' + usdMin + ' is below the floor USD ' + cheapest.floorUsd + ' (EUR ' + cheapest.floorEur + ') of the cheapest variant')
      + (above.length ? '; variants above the sourced range: ' + above.join(', ') : '') };
}
