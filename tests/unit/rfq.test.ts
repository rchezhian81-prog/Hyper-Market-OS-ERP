import { describe, it, expect } from 'vitest';
import { compareQuotes, EmptyRequisitionError, type Requisition, type Quote } from '../../packages/purchasing/src/index';
import { money } from '../../packages/contracts/src/money';

// M06-FR-02 — quotation comparison is only useful if it is like-for-like: the cheapest and the fastest
// are named per line and overall, a quote missing a line is never ranked as if it were complete, and a
// quote in another currency is shown but not compared.

const INR = 'INR' as const;

const req: Requisition = {
  requisitionId: 'rq-1',
  currency: INR,
  lines: [
    { productId: 'p1', quantity: 10 },
    { productId: 'p2', quantity: 4 },
  ],
};

function quote(quoteId: string, supplierId: string, p1: { cost: number; lead: number }, p2: { cost: number; lead: number }): Quote {
  return {
    quoteId,
    supplierId,
    lines: [
      { productId: 'p1', unitCost: money(p1.cost, INR), leadTimeDays: p1.lead },
      { productId: 'p2', unitCost: money(p2.cost, INR), leadTimeDays: p2.lead },
    ],
  };
}

describe('compareQuotes — like-for-like, cheapest and fastest', () => {
  it('names the cheapest and fastest overall, which are often different suppliers', () => {
    // A: cheaper (p1 5000, p2 2500 → 10×5000+4×2500 = 60000) but slow (10 days).
    // B: dearer (p1 5200, p2 2600 → 52000+10400 = 62400) but fast (3 days).
    const c = compareQuotes({ requisition: req, quotes: [quote('qA', 'supA', { cost: 5000, lead: 10 }, { cost: 2500, lead: 8 }), quote('qB', 'supB', { cost: 5200, lead: 3 }, { cost: 2600, lead: 2 })] });
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
    expect(c.fastestOverall).toEqual({ supplierId: 'supB', quoteId: 'qB' });
    expect(c.totals.find((t) => t.quoteId === 'qA')?.totalCost).toEqual(money(60000, INR));
    expect(c.totals.find((t) => t.quoteId === 'qA')?.maxLeadTimeDays).toBe(10); // the slowest line
    expect(c.summary).toContain('cheapest overall: supA');
    expect(c.summary).toContain('fastest overall: supB');
  });

  it('names cheapest and fastest per line', () => {
    const c = compareQuotes({ requisition: req, quotes: [quote('qA', 'supA', { cost: 5000, lead: 10 }, { cost: 2900, lead: 1 }), quote('qB', 'supB', { cost: 5200, lead: 3 }, { cost: 2500, lead: 9 })] });
    const p1 = c.lines.find((l) => l.productId === 'p1')!;
    const p2 = c.lines.find((l) => l.productId === 'p2')!;
    expect(p1.cheapest).toEqual({ supplierId: 'supA', quoteId: 'qA' }); // 5000 < 5200
    expect(p1.fastest).toEqual({ supplierId: 'supB', quoteId: 'qB' }); // 3 < 10
    expect(p2.cheapest).toEqual({ supplierId: 'supB', quoteId: 'qB' }); // 2500 < 2900
    expect(p2.fastest).toEqual({ supplierId: 'supA', quoteId: 'qA' }); // 1 < 9
  });

  it('never totals a quote that is missing a line — it is called out, not ranked cheap', () => {
    // qC looks cheap on p1 (4000) but never quoted p2. It must not win overall on an incomplete basket.
    const partial: Quote = { quoteId: 'qC', supplierId: 'supC', lines: [{ productId: 'p1', unitCost: money(4000, INR), leadTimeDays: 5 }] };
    const c = compareQuotes({ requisition: req, quotes: [quote('qA', 'supA', { cost: 5000, lead: 10 }, { cost: 2500, lead: 8 }), partial] });
    expect(c.incompleteQuotes).toEqual(['qC']);
    expect(c.totals.map((t) => t.quoteId)).toEqual(['qA']); // only the complete quote is totalled
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
    // qC still shows as the cheapest on the p1 LINE (that part is like-for-like)…
    expect(c.lines.find((l) => l.productId === 'p1')!.cheapest).toEqual({ supplierId: 'supC', quoteId: 'qC' });
    expect(c.summary).toContain('could not be compared in full: qC');
  });

  it('shows a different-currency quote but does not rank it', () => {
    const usd: Quote = { quoteId: 'qU', supplierId: 'supU', lines: [
      { productId: 'p1', unitCost: money(50, 'USD'), leadTimeDays: 1 },
      { productId: 'p2', unitCost: money(25, 'USD'), leadTimeDays: 1 },
    ] };
    const c = compareQuotes({ requisition: req, quotes: [quote('qA', 'supA', { cost: 5000, lead: 10 }, { cost: 2500, lead: 8 }), usd] });
    const p1 = c.lines.find((l) => l.productId === 'p1')!;
    const usdOffer = p1.offers.find((o) => o.quoteId === 'qU')!;
    expect(usdOffer.comparable).toBe(false);
    expect(usdOffer.reason).toContain('USD');
    // The USD quote cannot win despite a tiny minor value — it is not like-for-like.
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
    expect(c.incompleteQuotes).toContain('qU');
  });

  it('handles no quotes yet, and refuses an empty requisition', () => {
    const none = compareQuotes({ requisition: req, quotes: [] });
    expect(none.totals).toEqual([]);
    expect(none.cheapestOverall).toBeUndefined();
    expect(none.summary).toBe('no quotes to compare yet');
    expect(() => compareQuotes({ requisition: { ...req, lines: [] }, quotes: [] })).toThrow(EmptyRequisitionError);
  });

  it('breaks a cheapest tie toward the faster supplier (stable, objective)', () => {
    // Both total the same; A is faster.
    const c = compareQuotes({ requisition: req, quotes: [quote('qA', 'supA', { cost: 5000, lead: 4 }, { cost: 2500, lead: 4 }), quote('qB', 'supB', { cost: 5000, lead: 9 }, { cost: 2500, lead: 9 })] });
    expect(c.cheapestOverall).toEqual({ supplierId: 'supA', quoteId: 'qA' });
  });
});
