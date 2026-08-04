import { describe, it, expect } from 'vitest';
import {
  assessSelfCheckout,
  decideScanAndGo,
  quotePrice,
  type ScannedLine,
} from '../../packages/self-checkout/src/self-checkout';
import {
  auditPriceIntegrity,
  pushEslPrice,
  type DisplayedPrice,
} from '../../packages/self-checkout/src/price-integrity';

// D04 (self-checkout / scan-and-go / price kiosk) and D06+D14 (shelf/POS/app/ESL price
// integrity) — the Stage 18 innovation wave.

const line = (over: Partial<ScannedLine>): ScannedLine => ({
  lineId: 'l-1', productId: 'p-bread', name: 'Bread 400g', qty: 1,
  unitPriceMinor: 4_500, scannedAt: '2026-08-04T18:00:00Z', ...over,
});

function basket(over: Partial<Parameters<typeof assessSelfCheckout>[0]> = {}) {
  return assessSelfCheckout({
    basketId: 'b-1', laneId: 'sco-1', mode: 'self_checkout',
    lines: [line({})], at: '2026-08-04T18:00:00Z', ...over,
  });
}

describe('an intervention is ASSISTANCE, never an accusation (D04)', () => {
  it('lets an ordinary basket pay and leave', () => {
    const result = basket();
    expect(result.canCompleteUnattended).toBe(true);
    expect(result.interventions).toEqual([]);
  });

  it('shows the customer a NEUTRAL message and the attendant a specific one', () => {
    const result = basket({
      lines: [line({ observedGrams: 900, expectedGrams: 400 })],
    });
    const i = result.interventions[0];
    expect(i?.kind).toBe('weight_mismatch');
    // A machine that publicly implies theft over a reusable bag gets switched off.
    expect(i?.customerMessage).toBe('Please wait — a colleague will be with you.');
    expect(i?.attendantDetail).toContain('check, do not accuse');
  });

  it('ALWAYS sends a human for an age-restricted line', () => {
    const result = basket({ lines: [line({ name: 'Beer 650ml', ageRestricted: true })] });
    expect(result.canCompleteUnattended).toBe(false);
    expect(result.interventions[0]?.kind).toBe('age_check');
    expect(result.interventions[0]?.attendantDetail).toContain('never will');
  });

  it('tolerates a bag on the platform without halting the lane', () => {
    // 10% out, inside the default 15% tolerance — a hand, a bag, a slightly heavy loaf.
    const result = basket({ lines: [line({ observedGrams: 440, expectedGrams: 400 })] });
    expect(result.interventions).toEqual([]);
  });

  it('flags unaccounted weight on the bagging area as a check, not a theft', () => {
    const result = basket({ unaccountedGrams: 300 });
    expect(result.interventions[0]?.kind).toBe('unscanned_item');
    expect(result.interventions[0]?.attendantDetail).toContain('reusable bag or a handbag');
  });
});

describe('patterns are scored across the BASKET, for the office not the lane', () => {
  it('spots the loose-produce pattern without holding the customer up', () => {
    const result = basket({
      lines: Array.from({ length: 5 }, (_, n) =>
        line({ lineId: `l-${n}`, productId: 'p-loose', name: 'Loose onions', looseProduce: true })),
    });
    const i = result.interventions.find((x) => x.kind === 'high_value_produce_pattern');
    expect(i?.blocking).toBe(false);
    expect(result.canCompleteUnattended).toBe(true);
    expect(i?.attendantDetail).toContain('say nothing about it');
    expect(result.riskBps).toBeGreaterThan(0);
  });

  it('does not call one loose item a pattern', () => {
    const result = basket({ lines: [line({ looseProduce: true })] });
    expect(result.interventions).toEqual([]);
  });

  it('notices repeated voids without confronting anybody', () => {
    const result = basket({ voidedLineIds: ['a', 'b', 'c'] });
    const i = result.interventions.find((x) => x.kind === 'void_pattern');
    expect(i?.blocking).toBe(false);
    expect(i?.attendantDetail).toContain('not worth a confrontation');
  });

  it('makes a random audit sound like what it is', () => {
    const result = basket({
      lines: [line({ unitPriceMinor: 400_000 })], selectedForAudit: true,
    });
    const i = result.interventions.find((x) => x.kind === 'random_audit');
    expect(i?.customerMessage).toContain('only take a moment');
    expect(i?.attendantDetail).toContain('Nothing is wrong with this basket');
  });

  it('does not audit a small basket even when it is drawn', () => {
    expect(basket({ selectedForAudit: true }).interventions).toEqual([]);
  });
});

describe('scan-and-go is earned trust with an honest sampling rate (D04)', () => {
  const go = (over: Partial<Parameters<typeof decideScanAndGo>[0]> = {}) =>
    decideScanAndGo({
      basketId: 'b-1', customerId: 'c-1', lines: [line({})],
      tripsCompleted: 20, discrepanciesFound: 0, selectedForAudit: false, ...over,
    });

  it('releases a trusted customer straight out', () => {
    expect(go().released).toBe(true);
  });

  it('ends the trip at a till for an age-restricted item, always', () => {
    const d = go({ lines: [line({ ageRestricted: true })] });
    expect(d.outcome).toBe('age_restricted_present');
    expect(d.detail).toContain('no scan-and-go trip clears one, ever');
  });

  it('audits sometimes — a scheme that never audits is a free-for-all', () => {
    const d = go({ selectedForAudit: true });
    expect(d.outcome).toBe('audit_required');
    expect(d.detail).toContain('free-for-all within a month');
  });

  it('withdraws trust on FOUND discrepancies, and says so plainly', () => {
    const d = go({ discrepanciesFound: 2 });
    expect(d.outcome).toBe('trust_withdrawn');
    expect(d.detail).toContain('loses them for good');
  });
});

describe('a price kiosk always says how fresh it is (D04)', () => {
  const PACK = [{ productId: 'p-bread', name: 'Bread 400g', priceMinor: 4_500 }];

  it('quotes with the age of the list attached', () => {
    const q = quotePrice({
      productId: 'p-bread', pack: PACK,
      packBuiltAt: '2026-08-04T17:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(q.outcome).toBe('quoted');
    expect(q.priceMinor).toBe(4_500);
    expect(q.minutesSincePack).toBe(60);
  });

  it('STOPS QUOTING when the list is stale, rather than quoting a number it does not trust', () => {
    const q = quotePrice({
      productId: 'p-bread', pack: PACK,
      packBuiltAt: '2026-08-03T09:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(q.outcome).toBe('stale');
    // A kiosk quoting yesterday's promotion is worse than no kiosk.
    expect(q.detail).toContain('check the price at the counter');
  });

  it('says an unknown barcode is unknown', () => {
    const q = quotePrice({
      productId: 'p-mystery', pack: PACK,
      packBuiltAt: '2026-08-04T17:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(q.outcome).toBe('not_found');
  });

  it('refuses to quote nothing for an unpriced product', () => {
    const q = quotePrice({
      productId: 'p-bread', pack: [{ productId: 'p-bread', name: 'Bread 400g' }],
      packBuiltAt: '2026-08-04T17:00:00Z', at: '2026-08-04T18:00:00Z',
    });
    expect(q.outcome).toBe('no_price');
  });
});

const shown = (over: Partial<DisplayedPrice>): DisplayedPrice => ({
  surface: 'shelf_label', productId: 'p-atta', branchId: 'b-main', priceMinor: 26_500,
  lastConfirmedAt: '2026-08-04T08:00:00Z', shelfAddress: 'A-04-3', ...over,
});

const PRODUCTS = [
  { productId: 'p-atta', name: 'Atta 5kg', posPriceMinor: 26_500 },
  { productId: 'p-oil', name: 'Sunflower oil 1L', posPriceMinor: 14_000 },
];

describe('the shelf showing LESS than the till is a legal problem, ranked first (D06)', () => {
  const audit = (over: Partial<Parameters<typeof auditPriceIntegrity>[0]> = {}) =>
    auditPriceIntegrity({
      branchId: 'b-main', products: PRODUCTS,
      displayed: [shown({}), shown({ productId: 'p-oil', priceMinor: 14_000 })],
      asAt: '2026-08-04T12:00:00Z', ...over,
    });

  it('says nothing when everything agrees', () => {
    const report = audit();
    expect(report.overchargeRisks).toEqual([]);
    expect(report.other).toEqual([]);
    expect(report.detail).toContain('agree across every surface');
  });

  it('puts a ₹4 overcharge risk ABOVE a ₹5,000 margin leak', () => {
    const report = audit({
      displayed: [
        // Shelf ₹4 cheaper than the till — small money, real legal exposure.
        shown({ priceMinor: 26_100 }),
        // Shelf ₹50 dearer, 100 units sold — ₹5,000 of margin.
        shown({ productId: 'p-oil', priceMinor: 19_000 }),
      ],
      unitsSold: { 'p-atta': 2, 'p-oil': 100 },
    });
    expect(report.overchargeRisks).toHaveLength(1);
    expect(report.overchargeRisks[0]?.productId).toBe('p-atta');
    expect(report.overchargeRisks[0]?.detail).toContain('what the customer was offered');
    // The bigger number is the SECOND list, on purpose.
    expect(report.other[0]?.kind).toBe('undercharge');
    expect(report.undercharedExposureMinor).toBe(500_000);
  });

  it('treats a surface that has not confirmed as UNCONFIRMED, not as agreeing', () => {
    const report = audit({
      displayed: [shown({ lastConfirmedAt: '2026-07-26T08:00:00Z' }), shown({ productId: 'p-oil' })],
    });
    expect(report.other[0]?.kind).toBe('stale_surface');
    expect(report.other[0]?.detail).toContain('not as agreeing');
  });

  it('names the ESL device and shelf so somebody can walk to it', () => {
    const report = auditPriceIntegrity({
      branchId: 'b-main', products: [PRODUCTS[0]!],
      displayed: [shown({ surface: 'esl', deviceId: 'esl-118', lastConfirmedAt: '2026-07-26T08:00:00Z' })],
      requiredSurfaces: ['esl'], asAt: '2026-08-04T12:00:00Z',
    });
    expect(report.other[0]?.kind).toBe('esl_unreachable');
    expect(report.other[0]?.detail).toContain('esl-118');
    expect(report.other[0]?.detail).toContain('A-04-3');
    expect(report.other[0]?.detail).toContain('keep showing it');
  });

  it('flags a product on sale with no price on the shelf at all', () => {
    const report = audit({ displayed: [shown({})] });
    expect(report.other.some((f) => f.kind === 'surface_missing')).toBe(true);
  });

  it('ignores another branch\'s labels', () => {
    const report = audit({
      displayed: [shown({}), shown({ productId: 'p-oil' }), shown({ branchId: 'b-other', priceMinor: 1 })],
    });
    expect(report.overchargeRisks).toEqual([]);
  });
});

describe('an ESL price change waits for the shelf to confirm (D14)', () => {
  const devices = [
    { deviceId: 'esl-1', shelfAddress: 'A-04-3', batteryPercent: 80 },
    { deviceId: 'esl-2', shelfAddress: 'A-04-4', batteryPercent: 75 },
  ];

  it('lets the till move once every label has echoed the price back', () => {
    const result = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500, devices,
      confirmedBy: ['esl-1', 'esl-2'],
    });
    expect(result.safeToChangeAtTill).toBe(true);
    expect(result.outcome).toBe('pushed');
  });

  it('HOLDS the till price when a label did not confirm', () => {
    const result = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500, devices,
      confirmedBy: ['esl-1'],
    });
    expect(result.safeToChangeAtTill).toBe(false);
    expect(result.unconfirmed).toEqual(['esl-2']);
    // Fire-and-forget would CREATE the overcharge risk the audit above exists to catch.
    expect(result.detail).toContain('exactly the problem this system exists to prevent');
  });

  it('lets the till move on a confirmed push while flagging a flat battery separately', () => {
    const result = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500,
      devices: [{ deviceId: 'esl-1', batteryPercent: 8 }], confirmedBy: ['esl-1'],
    });
    expect(result.safeToChangeAtTill).toBe(true);
    expect(result.outcome).toBe('stale_battery');
    expect(result.detail).toContain('dark in the middle of a promotion');
  });

  it('does not block a shop that has no electronic labels', () => {
    const result = pushEslPrice({
      productId: 'p-atta', branchId: 'b-main', priceMinor: 27_500, devices: [], confirmedBy: [],
    });
    expect(result.safeToChangeAtTill).toBe(true);
    expect(result.outcome).toBe('no_devices');
  });
});
