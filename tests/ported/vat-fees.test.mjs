// PORTED from Virtual-workers/station/tests/vat-fees.test.mjs at 16/10/2026 19:16 Irish time, source sha256 9c4ed0cfe28b48c74c55db9c4a5df8675493b87360982962520e9b02fe3ce102.
//   change: imports point at src/engine/lib
// vat-fees.test.mjs — VAT on ALL Etsy seller fees (config.etsyFees.vatOnSellerFees): fees, floor, switch-off fallback, digital-product record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { etsyFees, variantFloor, marginAfterFees, feeRates } from '../../src/engine/lib/etsy-fees.mjs';
import { config } from '../../src/engine/lib/common.mjs';

const base = (vat) => ({
  fx: { usdToEur: 1 },
  etsyFees: {
    currencies: { listingCurrency: 'EUR', payoutCurrency: 'EUR', currencyConversionPct: 2.5 }, minMarginEur: { value: 4 },
    rates: { listingFeeUsd: { value: 0.2 }, transactionPct: { value: 10 }, paymentProcessingPct: { value: 10 }, paymentProcessingFixedEur: { value: 0 }, vatOnProcessingPct: { value: 20 } },
    ...(vat ? { vatOnSellerFees: vat } : {})
  }
});

test('with vatOnSellerFees on, VAT is charged on the listing, transaction and processing fees', () => {
  const f = etsyFees(20, base({ enabled: true, ratePct: 20 }));
  assert.deepEqual(f, { listing: 0.2, transaction: 2, processing: 2, vatOnProcessing: 0.4, vatOnListing: 0.04, vatOnTransaction: 0.4, total: 5.04 });
});

test('with it off (or absent) only the processing fee carries VAT, exactly as before', () => {
  const off = etsyFees(20, base({ enabled: false, ratePct: 20 })), absent = etsyFees(20, base(null));
  assert.deepEqual(off, { listing: 0.2, transaction: 2, processing: 2, vatOnProcessing: 0.4, total: 4.6 });
  assert.deepEqual(absent, off);
});

test('the floor reconciles: at the floor price the margin is the minimum margin (never below it)', () => {
  for (const vat of [{ enabled: true, ratePct: 20 }, null]) {
    const cfg = base(vat), fl = variantFloor(6, cfg), m = marginAfterFees(fl.floorEur, fl.costEur, cfg);
    assert.ok(m >= 4 - 1e-9 && m < 4.05, 'margin ' + m + ' at floor ' + fl.floorEur);
  }
});

test('VAT on all fees raises the floor above the processing-only floor', () => {
  const all = variantFloor(6, base({ enabled: true, ratePct: 20 })).floorEur, only = variantFloor(6, base(null)).floorEur;
  assert.ok(all > only, all + ' vs ' + only);
});

test('the live config: on by default, 23%, all three fees, flagged to confirm against the first statement', () => {
  const v = config.etsyFees.vatOnSellerFees;
  assert.equal(v.enabled, true); assert.equal(v.ratePct, 23);
  assert.deepEqual([...v.appliesTo].sort(), ['listing', 'processing', 'transaction']);
  assert.match(v.status, /confirm against the first Etsy statement/i);
  const k = feeRates(config); assert.equal(k.vat, 0.23); assert.equal(k.vatListing, 0.23); assert.equal(k.vatTx, 0.23);
});

test('config records the digital-product rule: no VAT built into prices, automatic download only', () => {
  const d = config.etsyFees.digitalProducts;
  assert.match(d.euVat, /collects and remits EU VAT/i); assert.match(d.euVat, /no VAT is built into digital prices/i);
  assert.match(d.delivery, /automatic download only/i);
});
