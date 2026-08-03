import { describe, it, expect } from 'vitest';
import {
  captureReceipt,
  availableFromReceipt,
  IncompleteCaptureError,
  matchInvoice,
  InvalidMatchApprovalError,
  type CapturedLine,
  type MatchPolicy,
  type ProductReceiptRules,
  type ReceiptPolicy,
} from '../../packages/receiving/src/index';
import { money } from '../../packages/contracts/src/money';

// M07-FR-02/03/04 — the back door of the shop, where most of the money is actually
// lost. Nothing enters as sellable stock until it has been checked, and no invoice
// is paid that the order and the receipt do not both support (§28).

const INR = 'INR' as const;

const POLICY: ReceiptPolicy = {
  excessToleranceBp: 200, // 2% over-delivery accepted without a manager
  shortageToleranceBp: 100, // anything 1% or more short is raised
  nearExpiryDays: 30,
  coldChainMaxC: 5,
};

const RULES: ProductReceiptRules[] = [
  { productId: 'milk', batchTracked: true, coldChain: true, mrp: money(3000, INR) },
  { productId: 'rice', batchTracked: false, mrp: money(60000, INR) },
];

function line(over: Partial<CapturedLine> = {}): CapturedLine {
  return {
    lineId: 'l1',
    productId: 'rice',
    orderedMinor: 100,
    countedMinor: 100,
    uom: 'each',
    unitCost: money(5000, INR),
    condition: 'good',
    ...over,
  };
}

function capture(lines: readonly CapturedLine[], receivedOnDate = '2026-08-01') {
  return captureReceipt({
    receiptId: 'grn-1',
    lines,
    rules: RULES,
    policy: POLICY,
    receivedOnDate,
    currency: INR,
  });
}

describe('captureReceipt — count, batch, expiry, MRP, condition (M07-FR-02)', () => {
  it('accepts a clean delivery with nothing to report', () => {
    const result = capture([line()]);
    expect(result.discrepancies).toEqual([]);
    expect(result.requiresApproval).toBe(false);
    expect(result.lines[0]?.disposition).toBe('sellable');
    expect(availableFromReceipt(result)).toBe(100);
  });

  it('refuses a batch-tracked item with no batch or no expiry (M10 traceability)', () => {
    expect(() => capture([line({ productId: 'milk', temperatureC: 4, expiry: '2026-12-01' })])).toThrow(
      IncompleteCaptureError,
    );
    expect(() =>
      capture([line({ productId: 'milk', temperatureC: 4, batchId: 'B1', expiry: null })]),
    ).toThrow(IncompleteCaptureError);
    // With both present it goes through.
    const ok = capture([line({ productId: 'milk', temperatureC: 4, batchId: 'B1', expiry: '2026-12-01' })]);
    expect(ok.lines[0]?.batchId).toBe('B1');
  });

  it('refuses a cold-chain item with no recorded temperature (D05-FR-04)', () => {
    expect(() => capture([line({ productId: 'milk', batchId: 'B1', expiry: '2026-12-01' })])).toThrow(
      /recorded temperature/,
    );
  });

  it('never receives already-expired stock as sellable', () => {
    const result = capture([
      line({ productId: 'milk', batchId: 'B1', expiry: '2026-07-30', temperatureC: 4 }),
    ]);
    expect(result.lines[0]?.disposition).toBe('rejected');
    expect(availableFromReceipt(result)).toBe(0);
    expect(result.discrepancies[0]?.kind).toBe('expired');
    expect(result.discrepancies[0]?.requiresApproval).toBe(true);
  });

  it('flags near-expiry stock at the door, while still letting it be sold', () => {
    const result = capture([
      line({ productId: 'milk', batchId: 'B1', expiry: '2026-08-20', temperatureC: 4 }),
    ]);
    expect(result.lines[0]?.disposition).toBe('sellable');
    expect(result.discrepancies[0]?.kind).toBe('near_expiry');
    expect(result.discrepancies[0]?.detail).toContain('2026-08-20');
  });

  it('flags an MRP that differs from the master before it reaches the shelf', () => {
    const result = capture([line({ mrp: money(65000, INR) })]);
    expect(result.discrepancies.map((d) => d.kind)).toContain('mrp_mismatch');
  });
});

describe('captureReceipt — short, excess, damage and quarantine (M07-FR-03)', () => {
  it('raises a valued shortage that the supplier owes a credit for', () => {
    const result = capture([line({ countedMinor: 90 })]);
    const short = result.discrepancies.find((d) => d.kind === 'short');
    expect(short?.quantityMinor).toBe(10);
    expect(short?.value).toEqual({ minor: 50_000, currency: INR }); // 10 × ₹50.00
    expect(short?.detail).toContain('credit note');
  });

  it('accepts a small over-delivery, but needs approval beyond tolerance', () => {
    const small = capture([line({ countedMinor: 101 })]); // 1% — within 2%
    expect(small.discrepancies[0]?.kind).toBe('excess');
    expect(small.discrepancies[0]?.requiresApproval).toBe(false);
    expect(small.requiresApproval).toBe(false);

    const large = capture([line({ countedMinor: 130 })]); // 30% — beyond tolerance
    expect(large.discrepancies[0]?.requiresApproval).toBe(true);
    expect(large.requiresApproval).toBe(true);
  });

  it('quarantines damaged stock — counted, present, and not available to sell', () => {
    const result = capture([line({ condition: 'damaged' })]);
    expect(result.lines[0]?.disposition).toBe('quarantine');
    expect(result.lines[0]?.quarantinedMinor).toBe(100);
    // The acceptance test that matters: quarantined stock cannot be sold.
    expect(availableFromReceipt(result)).toBe(0);
    expect(result.requiresApproval).toBe(true);
  });

  it('quarantines stock that failed QC and stock that broke the cold chain', () => {
    const failed = capture([line({ qc: 'failed' })]);
    expect(failed.lines[0]?.disposition).toBe('quarantine');

    const warm = capture([
      line({ productId: 'milk', batchId: 'B1', expiry: '2026-12-01', temperatureC: 11 }),
    ]);
    expect(warm.lines[0]?.disposition).toBe('quarantine');
    expect(warm.discrepancies[0]?.detail).toContain('11°C');
  });

  it('values the whole delivery’s discrepancies so they can be prioritised (P-03)', () => {
    const result = capture([
      line({ lineId: 'l1', countedMinor: 90 }), // 10 short × ₹50.00 = ₹500.00
      line({ lineId: 'l2', countedMinor: 100, condition: 'damaged' }), // 100 × ₹50.00
    ]);
    expect(result.discrepancyValue).toEqual({ minor: 550_000, currency: INR });
    expect(result.discrepancies.every((d) => d.value.minor !== 0)).toBe(true);
  });

  it('refuses to receive a product it has no master rules for', () => {
    expect(() => capture([line({ productId: 'ghost' })])).toThrow(IncompleteCaptureError);
  });
});

describe('matchInvoice — three-way match and landed cost (M07-FR-04)', () => {
  const MATCH: MatchPolicy = { priceToleranceBp: 100, quantityToleranceBp: 0, immaterialMinor: 100 };
  const ORDERED = [
    { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5000, INR) },
    { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
  ];
  const RECEIVED = [
    { lineId: 'l1', productId: 'rice', quantityMinor: 100 },
    { lineId: 'l2', productId: 'milk', quantityMinor: 50 },
  ];

  function match(over: Partial<Parameters<typeof matchInvoice>[0]> = {}) {
    return matchInvoice({
      invoiceId: 'inv-1',
      ordered: ORDERED,
      received: RECEIVED,
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5000, INR) },
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
      policy: MATCH,
      currency: INR,
      receivedBy: 'receiver-1',
      ...over,
    });
  }

  it('pays an invoice that ties up with the order and the receipt', () => {
    const result = match();
    expect(result.outcome).toBe('matched');
    expect(result.payable).toBe(true);
    expect(result.variances).toEqual([]);
    expect(result.blockedReason).toBe('');
  });

  it('blocks payment when the price exceeds the agreed cost beyond tolerance', () => {
    const result = match({
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5500, INR) }, // +10%
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
    });
    expect(result.payable).toBe(false);
    expect(result.outcome).toBe('blocked_pending_approval');
    const v = result.variances.find((x) => x.kind === 'price_over');
    expect(v?.value).toEqual({ minor: 50_000, currency: INR }); // ₹5.00 × 100
    expect(v?.withinTolerance).toBe(false);
    expect(result.blockedReason).toContain('needs approval');
  });

  it('lets a price rise inside tolerance through without a human', () => {
    const result = match({
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5050, INR) }, // +1%
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
    });
    expect(result.payable).toBe(true);
    expect(result.outcome).toBe('variance_within_tolerance');
  });

  it('never pays for more than was received, or for goods never ordered', () => {
    const overInvoiced = match({
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 120, unitCost: money(5000, INR) },
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
    });
    expect(overInvoiced.payable).toBe(false);
    expect(overInvoiced.variances.some((v) => v.kind === 'quantity_over_invoiced')).toBe(true);

    const notOrdered = match({
      invoiced: [{ lineId: 'l9', productId: 'oil', quantityMinor: 10, unitCost: money(9000, INR) }],
    });
    expect(notOrdered.payable).toBe(false);
    expect(notOrdered.variances[0]?.kind).toBe('not_on_order');
    expect(notOrdered.variances[0]?.detail).toContain('nothing authorises this charge');
  });

  it('refuses to pay for goods that never arrived', () => {
    const result = match({
      received: [{ lineId: 'l1', productId: 'rice', quantityMinor: 100 }],
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5000, INR) },
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
    });
    expect(result.payable).toBe(false);
    expect(result.variances.find((v) => v.kind === 'not_received')?.detail).toContain('did not arrive');
  });

  it('notes goods received but not yet invoiced, without blocking the payment', () => {
    const result = match({
      invoiced: [{ lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5000, INR) }],
    });
    expect(result.payable).toBe(true);
    const pending = result.variances.find((v) => v.lineId === 'l2');
    expect(pending?.detail).toContain('invoice is still outstanding');
    expect(pending?.withinTolerance).toBe(true);
  });

  it('releases a blocked invoice on approval — but never by the receiver (§28)', () => {
    const overPriced = {
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5500, INR) },
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
      ],
    };
    const selfApproved = match({
      ...overPriced,
      approval: { subjectRef: 'inv-1', status: 'approved', decidedBy: 'receiver-1' },
    });
    expect(selfApproved.payable).toBe(false);
    expect(selfApproved.blockedReason).toContain('cannot approve');

    const approved = match({
      ...overPriced,
      approval: { subjectRef: 'inv-1', status: 'approved', decidedBy: 'buyer-1' },
    });
    expect(approved.payable).toBe(true);

    const pending = match({
      ...overPriced,
      approval: { subjectRef: 'inv-1', status: 'pending', decidedBy: 'buyer-1' },
    });
    expect(pending.payable).toBe(false);
  });

  it('refuses an approval that authorises a different invoice', () => {
    expect(() =>
      match({
        invoiced: [
          { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(9000, INR) },
          { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(2000, INR) },
        ],
        approval: { subjectRef: 'inv-OTHER', status: 'approved', decidedBy: 'buyer-1' },
      }),
    ).toThrow(InvalidMatchApprovalError);
  });

  it('spreads freight and duty across the lines by value, to the paisa (D03-FR-05)', () => {
    const result = match({
      charges: { freight: money(60_000, INR), duty: money(30_000, INR) },
    });
    // Goods: l1 = ₹5,000.00, l2 = ₹1,000.00 → 5:1. Charges ₹900.00 → ₹750.00 / ₹150.00.
    expect(result.landedCost[0]?.apportionedCharges).toEqual({ minor: 75_000, currency: INR });
    expect(result.landedCost[1]?.apportionedCharges).toEqual({ minor: 15_000, currency: INR });
    expect(result.landedCost[0]?.landedValue).toEqual({ minor: 575_000, currency: INR });
    // Nothing is lost in the apportionment — the parts sum to the whole.
    const spread = result.landedCost.reduce((s, l) => s + l.apportionedCharges.minor, 0);
    expect(spread).toBe(90_000);
  });

  it('leaves landed cost equal to goods value when there are no charges', () => {
    const result = match();
    expect(result.landedCost[0]?.apportionedCharges.minor).toBe(0);
    expect(result.landedCost[0]?.landedValue).toEqual({ minor: 500_000, currency: INR });
  });

  it('nets the variances so the buyer sees one number to argue about', () => {
    const result = match({
      invoiced: [
        { lineId: 'l1', productId: 'rice', quantityMinor: 100, unitCost: money(5100, INR) }, // +₹100.00
        { lineId: 'l2', productId: 'milk', quantityMinor: 50, unitCost: money(1900, INR) }, // −₹50.00
      ],
    });
    expect(result.netVariance).toEqual({ minor: 5_000, currency: INR });
  });
});
