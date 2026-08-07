import { describe, it, expect } from 'vitest';
import {
  issueQuotation,
  convertQuotation,
  withdrawQuotation,
  quotationsNeedingFollowUp,
  lineValueMinor,
  type Quotation,
  type QuotationLine,
} from '../../packages/suspended-sales/src/quotation';

// M12-FR-02 acceptance: "a quotation does not affect stock until converted."

const LINES: QuotationLine[] = [
  // 200 kg of rice at ₹42.00/kg, cost ₹36.00/kg
  { lineId: 'q-1', productId: 'p-rice', description: 'Rice 5kg', unitPriceMinor: 4_200, quantityMinor: 200, uom: 'kg', taxBps: 500, unitCostMinor: 3_600 },
  // 40 L of oil at ₹175.00/L, cost ₹150.00/L
  { lineId: 'q-2', productId: 'p-oil', description: 'Sunflower oil 1L', unitPriceMinor: 17_500, quantityMinor: 40, uom: 'ea', taxBps: 500, unitCostMinor: 15_000 },
];

function issue(overrides: Partial<Parameters<typeof issueQuotation>[0]> = {}) {
  return issueQuotation({
    quotationId: 'Q-1',
    tenantId: 't-1',
    storeId: 'store-1',
    customerRef: 'c-canteen-77',
    currency: 'INR',
    lines: LINES,
    issuedBy: 'u-sales',
    issuedAt: '2026-08-04T10:00:00Z',
    validUntil: '2026-08-11',
    ...overrides,
  });
}

describe('quotations promise a price, they do not make a sale (M12-FR-02)', () => {
  it('issues a quotation and totals it exactly', () => {
    const result = issue();
    expect(result.issued).toBe(true);
    // 200 × ₹42.00 = ₹8,400.00; 40 × ₹175.00 = ₹7,000.00; total ₹15,400.00
    expect(result.quotation?.totalMinor).toBe(840_000 + 700_000);
    expect(result.quotation?.state).toBe('issued');
  });

  it('MOVES NO STOCK — the acceptance criterion, asserted structurally', () => {
    // The module has no ledger, no outbox and no store: there is nothing it could
    // move stock with. This test states the claim the design makes, so that adding a
    // stock write later would have to change this file and be seen in review.
    const result = issue();
    expect(result.quotation).toBeDefined();
    expect(Object.keys(result)).toEqual(expect.not.arrayContaining(['movements', 'ledger', 'reservations']));

    // Quote the same pallet to three customers: none of them takes it off the shelf.
    const a = issue({ quotationId: 'Q-a', customerRef: 'c-a' });
    const b = issue({ quotationId: 'Q-b', customerRef: 'c-b' });
    const c = issue({ quotationId: 'Q-c', customerRef: 'c-c' });
    for (const q of [a, b, c]) expect(q.issued).toBe(true);
  });

  it('refuses an empty quotation and one that expires before it is issued', () => {
    expect(issue({ lines: [] }).outcome).toBe('no_lines');
    expect(issue({ validUntil: '2026-08-03' }).outcome).toBe('invalid_validity');
  });
});

describe('you cannot quote your way past the price guard (§28 / M05-FR-02)', () => {
  it('refuses a below-floor quotation with no approval', () => {
    // Rice quoted at cost: the whole quotation's margin drops below the floor.
    const cheap = issue({
      lines: [{ ...LINES[0]!, unitPriceMinor: 3_600 }, LINES[1]!],
      marginFloorBps: 1_200, // 12%
    });
    expect(cheap.issued).toBe(false);
    expect(cheap.outcome).toBe('below_floor_unapproved');
    expect(cheap.detail).toContain('before the price is promised');
  });

  it('checks the WHOLE quotation, so a loss-making line cannot hide behind a healthy one', () => {
    // Oil at a healthy margin, rice sold at a loss. Line by line, one passes. Together
    // they are below the floor — and the customer only ever sees the total.
    const disguised = issue({
      lines: [
        { ...LINES[0]!, unitPriceMinor: 3_000 }, // below cost
        LINES[1]!,
      ],
      marginFloorBps: 1_200,
    });
    expect(disguised.issued).toBe(false);
    expect(disguised.outcome).toBe('below_floor_unapproved');
  });

  it('refuses the salesperson approving their own below-floor price', () => {
    const self = issue({
      lines: [{ ...LINES[0]!, unitPriceMinor: 3_600 }, LINES[1]!],
      marginFloorBps: 1_200,
      approval: { subjectRef: 'Q-1', status: 'approved', decidedBy: 'u-sales', reason: 'big customer' },
    });
    expect(self.issued).toBe(false);
    expect(self.outcome).toBe('self_approved');
  });

  it('allows it with a separate approver, and records who approved', () => {
    const approved = issue({
      lines: [{ ...LINES[0]!, unitPriceMinor: 3_600 }, LINES[1]!],
      marginFloorBps: 1_200,
      approval: { subjectRef: 'Q-1', status: 'approved', decidedBy: 'u-owner', reason: 'volume account, wins the year' },
    });
    expect(approved.issued).toBe(true);
    expect(approved.quotation?.marginApprovedBy).toBe('u-owner');
  });

  it('needs no approval when the quotation clears the floor', () => {
    expect(issue({ marginFloorBps: 1_200 }).issued).toBe(true);
  });
});

describe('converting honours the promise — inside the window, and only there', () => {
  function issued(): Quotation {
    const r = issue();
    if (!r.quotation) throw new Error('unreachable');
    return r.quotation;
  }

  it('converts at the QUOTED prices', () => {
    const result = convertQuotation({ quotation: issued(), saleId: 'S-1', at: '2026-08-06T11:00:00Z' });
    expect(result.converted).toBe(true);
    expect(result.saleLines?.map((l) => l.unitPriceMinor)).toEqual([4_200, 17_500]);
    expect(result.quotation.state).toBe('converted');
    expect(result.quotation.convertedSaleId).toBe('S-1');
  });

  it('REFUSES AN EXPIRED QUOTATION rather than honouring it or re-pricing it quietly', () => {
    const result = convertQuotation({ quotation: issued(), saleId: 'S-1', at: '2026-08-12T09:00:00Z' });
    expect(result.converted).toBe(false);
    expect(result.outcome).toBe('expired');
    expect(result.detail).toContain('re-quote rather than honouring or changing it quietly');
    expect(result.quotation.state).toBe('expired');
  });

  it('still honours it on the last valid day', () => {
    const result = convertQuotation({ quotation: issued(), saleId: 'S-1', at: '2026-08-11T23:00:00Z' });
    expect(result.converted).toBe(true);
  });

  it('converts to exactly ONE sale', () => {
    const first = convertQuotation({ quotation: issued(), saleId: 'S-1', at: '2026-08-06T11:00:00Z' });
    const second = convertQuotation({ quotation: first.quotation, saleId: 'S-2', at: '2026-08-06T11:05:00Z' });
    expect(second.converted).toBe(false);
    expect(second.outcome).toBe('already_converted');
    // And it points at the sale that already exists rather than making another.
    expect(second.saleId).toBe('S-1');
  });

  it('allows a partial take, and refuses more than was quoted', () => {
    const partial = convertQuotation({
      quotation: issued(),
      saleId: 'S-1',
      at: '2026-08-06T11:00:00Z',
      quantities: { 'q-1': 150, 'q-2': 0 },
    });
    expect(partial.converted).toBe(true);
    expect(partial.saleLines).toHaveLength(1);
    expect(lineValueMinor(partial.saleLines![0]!)).toBe(630_000); // 150 × ₹42.00

    const greedy = convertQuotation({
      quotation: issued(),
      saleId: 'S-2',
      at: '2026-08-06T11:00:00Z',
      quantities: { 'q-1': 500 },
    });
    expect(greedy.converted).toBe(false);
    expect(greedy.outcome).toBe('quantity_exceeds_quote');
    expect(greedy.detail).toContain('the held price covers the quoted quantity only');
  });

  it('refuses to convert a withdrawn quotation, and keeps the withdrawal reason', () => {
    const w = withdrawQuotation({
      quotation: issued(),
      byUserId: 'u-manager',
      reason: 'customer went elsewhere',
      at: '2026-08-05T10:00:00Z',
    });
    expect(w.withdrawn).toBe(true);
    expect(w.quotation.withdrawReason).toBe('customer went elsewhere');

    const converted = convertQuotation({ quotation: w.quotation, saleId: 'S-1', at: '2026-08-06T11:00:00Z' });
    expect(converted.converted).toBe(false);
    expect(converted.outcome).toBe('withdrawn');
  });

  it('refuses to withdraw without a reason', () => {
    expect(withdrawQuotation({ quotation: issued(), byUserId: 'u-1', reason: '', at: '2026-08-05T10:00:00Z' }).withdrawn).toBe(false);
  });
});

describe('the follow-up list — a quotation nobody chased is a sale already paid for', () => {
  it('surfaces expiring and lapsed quotations, soonest first', () => {
    const base = issue().quotation!;
    const quotations: Quotation[] = [
      { ...base, quotationId: 'Q-lapsed', validUntil: '2026-08-02' },
      { ...base, quotationId: 'Q-today', validUntil: '2026-08-04' },
      { ...base, quotationId: 'Q-soon', validUntil: '2026-08-06' },
      { ...base, quotationId: 'Q-far', validUntil: '2026-09-30' },
      { ...base, quotationId: 'Q-done', validUntil: '2026-08-05', state: 'converted' },
    ];

    const list = quotationsNeedingFollowUp(quotations, '2026-08-04', 3);
    expect(list.map((q) => q.quotationId)).toEqual(['Q-lapsed', 'Q-today', 'Q-soon']);
    expect(list[0]?.detail).toContain('lapsed 2 day(s) ago without an answer');
    expect(list[1]?.detail).toBe('expires today');
    expect(list[2]?.daysLeft).toBe(2);
    expect(list[0]?.valueMinor).toBe(1_540_000);
  });
});
