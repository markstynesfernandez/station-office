// PORTED from Virtual-workers/station/tests/etsy-fees.test.mjs at 16/10/2026 19:16 Irish time, source sha256 fe6b88a52fa363a7fefaec8fdf7a530352f17ab96c6151cc4b40b4113d22ead6.
//   change: imports point at src/engine/lib
//   change: the POD-only test (archived Printify products and the Premium option) is not ported
// etsy-fees.test.mjs — fee model, per-variant price floor and ladder, driven by config.etsyFees. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { etsyFees, marginAfterFees, variantFloor, variantsOf, variantLadder, briefPriceCheck, shippingFor } from '../../src/engine/lib/etsy-fees.mjs';
import { briefUsdRange } from '../../src/engine/lib/gates.mjs';
import { config } from '../../src/engine/lib/common.mjs';
import fs from 'node:fs';
import path from 'node:path';

// fx 1; transaction 10%, processing 10% + 0.30, VAT 20% on processing, Offsite Ads 15%, listing 0.20, minimum margin 4
const CFG = { fx: { usdToEur: 1 }, etsyFees: { currencies: { listingCurrency: 'EUR', payoutCurrency: 'EUR', currencyConversionPct: 2.5 }, minMarginEur: { value: 4 }, rates: { listingFeeUsd: { value: 0.2 }, transactionPct: { value: 10 }, paymentProcessingPct: { value: 10 }, paymentProcessingFixedEur: { value: 0.3 }, vatOnProcessingPct: { value: 20 } }, worstCase: { offsiteAdsPct: { value: 15 } } } };

test('fees: listing + transaction% + processing (% + fixed) + VAT on processing; Offsite Ads only on request', () => {
  assert.deepEqual(etsyFees(20, CFG), { listing: 0.2, transaction: 2, processing: 2.3, vatOnProcessing: 0.46, total: 4.96 });
  assert.equal(marginAfterFees(20, 10, CFG), 5.04);
  assert.equal(etsyFees(20, CFG, { offsite: true }).offsiteAds, 3);
  assert.equal(marginAfterFees(20, 10, CFG, { offsite: true }), 2.04, 'worst case = default minus 15% of the price');
});
test('floor is per variant: the price at which price - fees - THAT variant\'s cost = minimum margin (rounded up to the cent)', () => {
  const f10 = variantFloor(10, CFG);                          // (10 + 4 + 0.2 + 0.3 x 1.2) / (1 - 0.1 - 0.1 x 1.2) = 14.56 / 0.78 = 18.67
  assert.equal(f10.floorEur, 18.67);
  assert.ok(marginAfterFees(f10.floorEur, 10, CFG) >= 4, 'at the floor the margin is at least the minimum');
  assert.ok(marginAfterFees(f10.floorEur - 0.02, 10, CFG) < 4, 'a little below the floor it is not');
  assert.ok(variantFloor(5, CFG).floorEur < f10.floorEur, 'a cheaper variant has a lower floor: no single floor from the dearest variant');
});
test('variants: owner-entered variants win; otherwise the min/max endpoints stand in and are marked derived', () => {
  assert.deepEqual(variantsOf({ productionCostUsd: { min: 5, max: 10 } }).map((v) => [v.costUsd, v.derived]), [[5, true], [10, true]]);
  assert.deepEqual(variantsOf({ productionCostUsd: { min: 7, max: 7 } }).map((v) => v.costUsd), [7]);
  const v = variantsOf({ productionCostUsd: { min: 5, max: 10 }, variants: [{ label: 'S / White', productionCostUsd: 5 }, { label: '3XL / Black', productionCostUsd: 10 }] });
  assert.deepEqual(v.map((x) => [x.label, x.derived]), [['S / White', false], ['3XL / Black', false]]);
});
test('ladder: proposed = the larger of the variant floor and the brief HIGH (top of range); a floor above the brief high is flagged, not failed', () => {
  const prod = { productionCostUsd: { min: 5, max: 10 } };
  const lad = variantLadder(prod, { min: 15, max: 20 }, CFG);
  assert.equal(lad[0].floorEur, variantFloor(5, CFG).floorEur);
  assert.equal(lad[0].proposedEur, 20, 'cheap variant: priced at the top of the sourced range, not its floor and not the market low');
  assert.equal(lad[1].proposedEur, 20, 'dear variant: floor 18.67 is below the brief high, so the brief high');
  assert.ok(lad.every((l) => !l.aboveRange));
  const tight = variantLadder(prod, { min: 15, max: 18 }, CFG);
  assert.equal(tight[0].proposedEur, 18); assert.equal(tight[0].aboveRange, false);
  assert.equal(tight[1].proposedEur, 18.67, 'floor above the brief high: priced at its floor'); assert.equal(tight[1].aboveRange, true, 'and flagged');
  assert.equal(briefPriceCheck(15, prod, CFG, { min: 15, max: 18 }).ok, true, 'flagged, not failed: the brief still passes on the cheapest variant');
  for (const l of [...lad, ...tight]) assert.ok(l.proposedEur >= l.floorEur && l.marginEur >= 4 - 1e-9, 'never below the floor: every variant clears the minimum margin');
  assert.ok(lad[1].marginOffsiteEur < lad[1].marginEur);
});
test('ladder with no brief price: floor + 15% (config.pricingPolicy.noBriefUpliftPct), 2 dp, margin from that price', () => {
  const prod = { productionCostUsd: { min: 5, max: 10 } }, lad = variantLadder(prod, null, CFG);
  assert.equal(lad[1].proposedEur, Math.round(18.67 * 1.15 * 100) / 100); assert.equal(lad[0].proposedEur, Math.round(lad[0].floorEur * 1.15 * 100) / 100);
  assert.ok(lad.every((l) => l.aboveRange === false && l.proposedEur > l.floorEur));
  assert.equal(variantLadder(prod, null, { ...CFG, pricingPolicy: { noBriefUpliftPct: 20 } })[1].proposedEur, Math.round(18.67 * 1.2 * 100) / 100, 'the uplift comes from config');
  assert.equal(config.pricingPolicy.strategy, 'top-of-range'); assert.equal(config.pricingPolicy.noBriefUpliftPct, 15);
});
test('brief gate: lowest price must clear the CHEAPEST variant\'s floor, not the dearest\'s; an UNKNOWN price fails', () => {
  const prod = { productionCostUsd: { min: 5, max: 10 } };      // floors 12.26-ish and 18.67
  assert.equal(briefPriceCheck(variantFloor(5, CFG).floorUsd, prod, CFG).ok, true);
  assert.equal(briefPriceCheck(15, prod, CFG).ok, true, '15 is below the dearest variant\'s floor 18.67 but clears the cheapest: passes under per-variant floors');
  assert.equal(briefPriceCheck(10, prod, CFG).ok, false);
  assert.equal(briefPriceCheck(null, prod, CFG).ok, false);
});
test('an UNKNOWN price section has no range even when its text quotes a cost', () => {
  assert.equal(briefUsdRange('# N\n\n## Price range\nUNKNOWN — needs owner check. The production cost (USD 5.15) is a cost, not a retail price.\n\n## Seasonality\nx'), null);
  assert.deepEqual(briefUsdRange('## Price range\nUSD 24.99–29.99 shown.\n'), { min: 24.99, max: 29.99 });
});
test('estimated US sales tax enters the processing base only (default 0 changes nothing); transaction fee stays on the total excluding tax', () => {
  const tax = (pct) => ({ ...CFG, etsyFees: { ...CFG.etsyFees, rates: { ...CFG.etsyFees.rates, estimatedSalesTaxPct: { value: pct } } } });
  assert.deepEqual(etsyFees(20, tax(0)), etsyFees(20, CFG));
  const f = etsyFees(20, tax(10));   // processing = 20 x 10% x 1.10 + 0.30 = 2.5; transaction unchanged at 2; VAT on processing 0.5
  assert.equal(f.processing, 2.5); assert.equal(f.transaction, 2); assert.equal(f.vatOnProcessing, 0.5);
  const fl = variantFloor(10, tax(10)); assert.ok(fl.floorEur > variantFloor(10, CFG).floorEur, 'tax in the processing base raises the floor');
  assert.ok(marginAfterFees(fl.floorEur, 10, tax(10)) >= 4, 'and the floor still clears the minimum margin');
});
test('currency conversion is not modelled: the fee model refuses to run if listing and payout currency differ', () => {
  const bad = { ...CFG, etsyFees: { ...CFG.etsyFees, currencies: { listingCurrency: 'EUR', payoutCurrency: 'USD', currencyConversionPct: 2.5 } } };
  assert.throws(() => etsyFees(20, bad), /must equal payoutCurrency/); assert.throws(() => variantFloor(10, bad), /conversion fee is not modelled/);
  assert.equal(config.etsyFees.currencies.listingCurrency, config.etsyFees.currencies.payoutCurrency, 'the real config has matching currencies');
  assert.throws(() => etsyFees(20, { ...CFG, etsyFees: { ...CFG.etsyFees, currencies: undefined } }), /currencies/);
});

// ---- shipping: fees apply to item price + shipping charged, in both modes ----
const SHIP = (mode) => ({ ...CFG, shippingPolicy: { mode } });
const TEE = { productionCostUsd: { min: 5, max: 10 }, shippingCostUsd: 5 };
test('shipping: pass-through charges the buyer our cost; free-shipping charges 0; unknown shipping is flagged, not guessed', () => {
  assert.deepEqual(shippingFor(TEE, SHIP('pass-through')), { mode: 'pass-through', known: true, costUsd: 5, costEur: 5, chargedEur: 5 });
  assert.deepEqual(shippingFor(TEE, SHIP('free-shipping')), { mode: 'free-shipping', known: true, costUsd: 5, costEur: 5, chargedEur: 0 });
  assert.equal(shippingFor({ productionCostUsd: { min: 1, max: 2 } }, SHIP('pass-through')).known, false);
  assert.equal(shippingFor(TEE, CFG).mode, 'pass-through', 'no policy configured: pass-through is the default');
});
test('fees are charged on item price + shipping charged', () => {
  assert.deepEqual(etsyFees(20, CFG, { shipChargedEur: 5 }), etsyFees(25, CFG), 'item 20 + shipping 5 is fee-wise a 25 sale');
  assert.equal(etsyFees(20, CFG, { shipChargedEur: 5, offsite: true }).offsiteAds, 3.75);
  // margin: 20 + 5 charged - fees(25) - production 10 - shipping cost 5
  const ship = shippingFor(TEE, SHIP('pass-through'));
  assert.equal(marginAfterFees(20, 10, CFG, { ship }), Math.round((25 - etsyFees(25, CFG).total - 10 - 5) * 100) / 100);
  assert.ok(marginAfterFees(20, 10, CFG, { ship }) < marginAfterFees(20, 10, CFG), 'shipping that is passed through still costs the fees on it');
});
test('floor with shipping reconciles in both modes: margin >= minimum at the floor, below it a cent less', () => {
  for (const mode of ['pass-through', 'free-shipping']) {
    const cfg = SHIP(mode), ship = shippingFor(TEE, cfg), f = variantFloor(10, cfg, ship);
    assert.ok(marginAfterFees(f.floorEur, 10, cfg, { ship }) >= 4 - 1e-9, mode + ' at floor');
    assert.ok(marginAfterFees(f.floorEur - 0.02, 10, cfg, { ship }) < 4, mode + ' just below floor');
  }
});
test('floor: shipping raises it; free-shipping builds the whole shipping cost into the item price (floor = pass-through floor + shipping cost)', () => {
  const pt = variantFloor(10, SHIP('pass-through'), shippingFor(TEE, SHIP('pass-through'))).floorEur, fs0 = variantFloor(10, SHIP('free-shipping'), shippingFor(TEE, SHIP('free-shipping'))).floorEur;
  assert.ok(pt > variantFloor(10, CFG).floorEur, 'pass-through floor is above the no-shipping floor (fees on the shipping charged)');
  assert.ok(Math.abs(fs0 - (pt + 5)) <= 0.011, 'free ' + fs0 + ' vs pass-through ' + pt + ' + 5');
});
test('ladder carries the shipping basis; the brief gate uses the shipping-inclusive floor', () => {
  const cfg = SHIP('pass-through'), lad = variantLadder(TEE, { min: 40, max: 40 }, cfg);
  assert.equal(lad[0].shipKnown, true); assert.equal(lad[0].shipChargedEur, 5); assert.equal(lad[0].shipMode, 'pass-through');
  assert.ok(lad.every((l) => l.marginEur >= 4 - 1e-9));
  const floor = variantFloor(5, cfg, shippingFor(TEE, cfg));
  assert.equal(briefPriceCheck(floor.floorUsd, TEE, cfg).ok, true); assert.equal(briefPriceCheck(floor.floorUsd - 0.5, TEE, cfg).ok, false);
});
// (POD-only test "real config and products.json ... Premium option" not ported: Printify products are archived)

test('variantsOf: a null cost is the dearest known cost and flagged; a real or blank-only cost wins and is not flagged', () => {
  const p = { productionCostUsd: { min: 12.43, max: 19.43 }, productionCostBreakdown: { frontPrintUsd: 7.47 }, variants: [{ label: 'S / Black', productionCostUsd: null }, { label: 'M / Black', productionCostUsd: 12.43 }, { label: 'L / Black', blankUsd: 5.5 }] };
  assert.deepEqual(variantsOf(p).map((v) => [v.costUsd, v.unconfirmed]), [[19.43, true], [12.43, false], [12.97, false]]);
  const lad = variantLadder(p, null, CFG); assert.equal(lad[0].unconfirmed, true); assert.ok(lad[0].floorEur > lad[1].floorEur, 'confirmed cheaper variants get a lower floor than the unconfirmed one');
});
