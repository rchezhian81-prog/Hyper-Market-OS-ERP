import { describe, it, expect } from 'vitest';
import * as fraudModule from '../../packages/loss-prevention/src/fraud-signals';
import {
  detectCouponAbuse,
  detectLoyaltyManipulation,
  detectCodAnomalies,
  detectSupplierAnomalies,
  prioritiseSignals,
  type CouponUse,
  type LoyaltyMovement,
  type CodRecord,
  type SupplierInvoiceLine,
} from '../../packages/loss-prevention/src/fraud-signals';

// M15-FR-02 acceptance: "coupon use beyond its abuse limit raises a signal; a supplier
// invoice priced abnormally vs history is flagged; THE AI AGENT CANNOT ITSELF BLOCK OR
// SANCTION."

describe('the fraud layer detects and never acts (hard rule #5 / AI-NFR-12)', () => {
  it('exports NO function that blocks, suspends, cancels or reverses anything', () => {
    const api = Object.keys(fraudModule);
    // The absence is the control. Adding one of these would have to change this test.
    expect(api.filter((n) => /block|suspend|cancel|reverse|sanction|freeze|ban/i.test(n))).toEqual([]);
    // What it does export is detection and prioritisation.
    expect(api).toContain('prioritiseSignals');
  });

  it('stamps every signal with actionTaken: false', () => {
    const uses: CouponUse[] = Array.from({ length: 8 }, (_, i) => ({
      useId: `u-${i}`,
      couponCode: 'SAVE50',
      accountRef: 'acc-1',
      saleId: `S-${i}`,
      discountMinor: 5_000,
      at: '2026-08-04T10:00:00Z',
      limitPerAccount: 3,
    }));
    const signals = detectCouponAbuse(uses);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.actionTaken === false)).toBe(true);
  });
});

describe('coupon abuse — a broken rule and a suspicious share are different things', () => {
  const use = (over: Partial<CouponUse>): CouponUse => ({
    useId: 'u-1',
    couponCode: 'SAVE50',
    accountRef: 'acc-1',
    saleId: 'S-1',
    discountMinor: 5_000,
    at: '2026-08-04T10:00:00Z',
    ...over,
  });

  it('raises a STRONG signal when a declared abuse limit is exceeded', () => {
    const uses = Array.from({ length: 4 }, (_, i) =>
      use({ useId: `u-${i}`, saleId: `S-${i}`, limitPerAccount: 3 }),
    );
    const [signal] = detectCouponAbuse(uses);
    expect(signal?.kind).toBe('coupon_beyond_limit');
    expect(signal?.confidence).toBe('strong'); // a rule was broken; that is a fact
    expect(signal?.valueMinor).toBe(20_000);
    expect(signal?.evidenceRefs).toHaveLength(4);
    expect(signal?.detail).toContain('against a limit of 3');
  });

  it('honours the promotion\'s own limit over the tenant default', () => {
    const uses = Array.from({ length: 4 }, (_, i) => use({ useId: `u-${i}`, saleId: `S-${i}` }));
    // Default limit is 5, so four uses is fine.
    expect(detectCouponAbuse(uses)).toEqual([]);
    // The promotion says two.
    expect(detectCouponAbuse(uses.map((u) => ({ ...u, limitPerAccount: 2 })))).toHaveLength(1);
  });

  it('raises only a PROBABLE signal for concentration, and says a keen regular looks the same', () => {
    // A real day's coupon traffic: 24 uses, of which one account holds 8 (33%) —
    // each on a different coupon, so no declared limit is broken.
    const uses = [
      ...Array.from({ length: 8 }, (_, i) => use({ useId: `a-${i}`, saleId: `S-a${i}`, couponCode: `C-${i}` })),
      ...Array.from({ length: 16 }, (_, i) =>
        use({ useId: `b-${i}`, accountRef: `acc-${i + 2}`, saleId: `S-b${i}`, couponCode: `C-x${i}` }),
      ),
    ];
    const [signal] = detectCouponAbuse(uses);
    expect(signal?.kind).toBe('coupon_concentrated_on_one_account');
    expect(signal?.confidence).toBe('probable');
    expect(signal?.detail).toContain('33% of all coupon use (8 of 24)');
    expect(signal?.detail).toContain('a keen regular looks the same');
  });

  it('SAYS NOTHING about a share of a tiny number — a quiet Tuesday is not evidence', () => {
    // Three uses in the whole shop, all by one account. That is 100% concentration
    // and means nothing at all; without this guard, quiet days accuse regulars.
    const quietDay = Array.from({ length: 3 }, (_, i) =>
      use({ useId: `q-${i}`, saleId: `S-q${i}`, couponCode: `C-${i}` }),
    );
    expect(detectCouponAbuse(quietDay)).toEqual([]);

    // The tenant can lower the bar if their shop genuinely is that small.
    const smallShop = detectCouponAbuse(quietDay, { couponConcentrationMinimumTotal: 3 });
    expect(smallShop).toHaveLength(1);
    expect(smallShop[0]?.kind).toBe('coupon_concentrated_on_one_account');
  });

  it('does not raise the same account twice for the same behaviour', () => {
    // Enough total traffic for concentration to be in play, and one account that also
    // breaks a declared limit. It should be reported once, on the stronger finding.
    const uses = [
      ...Array.from({ length: 6 }, (_, i) => use({ useId: `u-${i}`, saleId: `S-${i}`, limitPerAccount: 2 })),
      ...Array.from({ length: 14 }, (_, i) =>
        use({ useId: `o-${i}`, accountRef: `acc-${i + 2}`, saleId: `S-o${i}`, couponCode: `C-${i}` }),
      ),
    ];
    const signals = detectCouponAbuse(uses);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('coupon_beyond_limit');
  });

  it('is quiet when nothing is wrong', () => {
    expect(detectCouponAbuse([use({}), use({ useId: 'u-2', accountRef: 'acc-2', saleId: 'S-2' })])).toEqual([]);
  });
});

describe('loyalty — points from nowhere are not a pattern, they are a transaction', () => {
  it('raises a STRONG signal for points earned with no sale behind them, named to the staff member', () => {
    const movements: LoyaltyMovement[] = [
      { movementId: 'm-1', accountRef: 'acc-1', kind: 'earn', points: 500, at: '2026-08-04T10:00:00Z', staffId: 'u-cashier-7' },
      { movementId: 'm-2', accountRef: 'acc-2', kind: 'earn', points: 800, at: '2026-08-04T11:00:00Z', staffId: 'u-cashier-7' },
      { movementId: 'm-3', accountRef: 'acc-3', kind: 'earn', points: 20, at: '2026-08-04T12:00:00Z', saleId: 'S-9' },
    ];
    const [signal] = detectLoyaltyManipulation(movements);
    expect(signal?.kind).toBe('loyalty_earn_without_sale');
    expect(signal?.subjectRef).toBe('u-cashier-7');
    expect(signal?.confidence).toBe('strong');
    expect(signal?.detail).toContain('1300 points issued');
    expect(signal?.detail).toContain('came from nowhere');
  });

  it('compares a burn spike against the ACCOUNT\'S OWN history, and calls it weak', () => {
    const movements: LoyaltyMovement[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        movementId: `b-${i}`,
        accountRef: 'acc-1',
        kind: 'burn' as const,
        points: 100,
        at: `2026-07-0${i + 1}T10:00:00Z`,
      })),
      { movementId: 'b-big', accountRef: 'acc-1', kind: 'burn', points: 900, at: '2026-08-04T10:00:00Z' },
    ];
    const [signal] = detectLoyaltyManipulation(movements);
    expect(signal?.kind).toBe('loyalty_burn_spike');
    expect(signal?.confidence).toBe('weak');
    expect(signal?.detail).toContain('a saved-up redemption looks identical');
  });

  it('says nothing about an account with too little history to judge', () => {
    const movements: LoyaltyMovement[] = [
      { movementId: 'b-1', accountRef: 'acc-1', kind: 'burn', points: 100, at: '2026-08-01T10:00:00Z' },
      { movementId: 'b-2', accountRef: 'acc-1', kind: 'burn', points: 9_000, at: '2026-08-04T10:00:00Z' },
    ];
    expect(detectLoyaltyManipulation(movements)).toEqual([]);
  });
});

describe('cash on delivery — the one place the money is in a pocket', () => {
  const rec = (over: Partial<CodRecord>): CodRecord => ({
    stopId: 's-1',
    driverRef: 'drv-1',
    orderId: 'O-1',
    expectedMinor: 50_000,
    collectedMinor: 50_000,
    collectedAt: '2026-08-04T10:00:00Z',
    bankedAt: '2026-08-04T18:00:00Z',
    ...over,
  });

  it('needs a pattern, not one dispute, before it names a driver', () => {
    const one = detectCodAnomalies([rec({ collectedMinor: 45_000 })], '2026-08-05T10:00:00Z');
    expect(one).toEqual([]);

    const three = detectCodAnomalies(
      [
        rec({ stopId: 's-1', orderId: 'O-1', collectedMinor: 45_000 }),
        rec({ stopId: 's-2', orderId: 'O-2', collectedMinor: 48_000 }),
        rec({ stopId: 's-3', orderId: 'O-3', collectedMinor: 40_000 }),
      ],
      '2026-08-05T10:00:00Z',
    );
    const short = three.find((s) => s.kind === 'cod_short_repeatedly');
    expect(short?.valueMinor).toBe(17_000); // 5,000 + 2,000 + 10,000
    expect(short?.detail).toContain('one is a customer dispute, 3 is a pattern');
  });

  it('flags cash collected and not handed in, separately from any shortfall', () => {
    const signals = detectCodAnomalies(
      [rec({ collectedAt: '2026-08-03T10:00:00Z', bankedAt: undefined })],
      '2026-08-05T10:00:00Z',
    );
    const unbanked = signals.find((s) => s.kind === 'cod_collected_but_not_banked');
    expect(unbanked?.confidence).toBe('strong');
    expect(unbanked?.valueMinor).toBe(50_000);
  });

  it('says nothing about cash collected an hour ago', () => {
    expect(
      detectCodAnomalies([rec({ collectedAt: '2026-08-05T09:00:00Z', bankedAt: undefined })], '2026-08-05T10:00:00Z'),
    ).toEqual([]);
  });
});

describe('supplier anomalies — against the supplier\'s own history, and only with enough of it', () => {
  const history: SupplierInvoiceLine[] = Array.from({ length: 6 }, (_, i) => ({
    invoiceId: `INV-h${i}`,
    supplierId: 'sup-1',
    productId: 'p-rice',
    unitPriceMinor: 4_000,
    quantityMinor: 100,
    at: `2026-0${i + 1}-01T00:00:00Z`,
  }));

  it('flags a price well outside the supplier\'s own history', () => {
    const [signal] = detectSupplierAnomalies({
      lines: [{ invoiceId: 'INV-new', supplierId: 'sup-1', productId: 'p-rice', unitPriceMinor: 6_000, quantityMinor: 100, at: '2026-08-04T00:00:00Z' }],
      history,
    });
    expect(signal?.kind).toBe('supplier_price_out_of_history');
    expect(signal?.confidence).toBe('strong'); // 50% drift, double the 25% threshold
    expect(signal?.valueMinor).toBe(200_000); // ₹20.00 × 100
    expect(signal?.detail).toContain('up 50%');
  });

  it('flags a price DROP too — a supplier suddenly half price is also worth asking about', () => {
    const [signal] = detectSupplierAnomalies({
      lines: [{ invoiceId: 'INV-new', supplierId: 'sup-1', productId: 'p-rice', unitPriceMinor: 2_800, quantityMinor: 100, at: '2026-08-04T00:00:00Z' }],
      history,
    });
    expect(signal?.detail).toContain('down 30%');
  });

  it('says NOTHING when there is not enough history to have an opinion', () => {
    expect(
      detectSupplierAnomalies({
        lines: [{ invoiceId: 'INV-new', supplierId: 'sup-1', productId: 'p-rice', unitPriceMinor: 9_000, quantityMinor: 100, at: '2026-08-04T00:00:00Z' }],
        history: history.slice(0, 2),
      }),
    ).toEqual([]);
  });

  it('treats a quantity jump as weak, because a seasonal order looks the same', () => {
    const signals = detectSupplierAnomalies({
      lines: [{ invoiceId: 'INV-new', supplierId: 'sup-1', productId: 'p-rice', unitPriceMinor: 4_000, quantityMinor: 300, at: '2026-08-04T00:00:00Z' }],
      history,
    });
    const qty = signals.find((s) => s.kind === 'supplier_quantity_out_of_history');
    expect(qty?.confidence).toBe('weak');
    expect(qty?.detail).toContain('check before asking');
  });

  it('is quiet on a normal invoice', () => {
    expect(
      detectSupplierAnomalies({
        lines: [{ invoiceId: 'INV-new', supplierId: 'sup-1', productId: 'p-rice', unitPriceMinor: 4_200, quantityMinor: 110, at: '2026-08-04T00:00:00Z' }],
        history,
      }),
    ).toEqual([]);
  });
});

describe('the output is a list to read, sorted so the strongest thing is first', () => {
  it('ranks strong before probable before weak, then by value', () => {
    const signals = prioritiseSignals([
      { signalId: 'w', domain: 'loyalty', kind: 'loyalty_burn_spike', subjectRef: 'a', confidence: 'weak', valueMinor: 900_000, evidenceRefs: [], detail: '', actionTaken: false },
      { signalId: 's-small', domain: 'coupon', kind: 'coupon_beyond_limit', subjectRef: 'b', confidence: 'strong', valueMinor: 1_000, evidenceRefs: [], detail: '', actionTaken: false },
      { signalId: 'p', domain: 'supplier', kind: 'supplier_price_out_of_history', subjectRef: 'c', confidence: 'probable', valueMinor: 500_000, evidenceRefs: [], detail: '', actionTaken: false },
      { signalId: 's-big', domain: 'delivery', kind: 'cod_collected_but_not_banked', subjectRef: 'd', confidence: 'strong', valueMinor: 50_000, evidenceRefs: [], detail: '', actionTaken: false },
    ]);
    expect(signals.map((s) => s.signalId)).toEqual(['s-big', 's-small', 'p', 'w']);
  });
});
