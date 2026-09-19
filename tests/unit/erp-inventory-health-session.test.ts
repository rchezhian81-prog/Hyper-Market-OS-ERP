import { describe, it, expect } from 'vitest';
import {
  STOCK_HEALTH_COPY, COPY_KEYS, createStockHealthSession,
  type StockHealthPorts, type StockHealthData,
} from '../../apps/web-erp/src/inventory-health-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The stock-health dashboard (M08 · API-04 · P-03 control-by-exception · P-08 no silent failure). A read-only
// manager view over the one true stock record: exceptions (negative stock) first, the honest gaps named
// (uncosted stock, a not-meaningful ratio), and freshness a fact on the page. Nothing here writes.

const session = (
  data: StockHealthData,
  ports: Partial<StockHealthPorts> = {},
  userId: string | null = 'u-mgr',
) =>
  createStockHealthSession({ userId }, {
    snapshot: () => data,
    mayRead: () => true,
    ...ports,
  });

describe('the stock-health copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(STOCK_HEALTH_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...STOCK_HEALTH_COPY.en }, ta: { ...STOCK_HEALTH_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the screen refuses to show anything without the read permission', () => {
  it('a reader without inventory.availability.read sees a not-permitted state and no figures', () => {
    const view = session({ valuation: { totalValueMinor: 100_00, currency: 'INR' } }, { mayRead: () => false }).view('en');
    expect(view.screenState.tone).toBe('error');
    expect(view.screenState.label.length).toBeGreaterThan(0);
    expect(view.signals).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.asOf).toBeNull();
  });
});

describe('a screen told nothing says so, rather than reporting a false zero (P-08)', () => {
  it('with no sections at all, the state is empty and nothing is invented', () => {
    const view = session({}).view('en');
    expect(view.screenState.tone).not.toBe('error');
    expect(view.signals).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.asOf).toBeNull();
  });
});

describe('exceptions come first, worst-first, and read as attention never colour alone (P-03)', () => {
  it('negative stock is surfaced most-negative first, each an error tone with an icon and a word', () => {
    const view = session({
      negative: [
        { productId: 'p-rice', locationId: 'L1', onHandMinor: -200, detail: 'ledger below zero', ownerAction: 'count L1' },
        { productId: 'p-dal', locationId: 'L2', onHandMinor: -900, detail: 'ledger below zero', ownerAction: 'count L2' },
      ],
    }).view('en');

    expect(view.signals).toHaveLength(2);
    const first = view.signals[0]!;
    expect(first.kind).toBe('negative_stock');
    expect(first.productId).toBe('p-dal'); // -900 is worse than -200 → first
    expect(first.status.tone).toBe('error');
    expect(first.status.needsAttention).toBe(true);
    expect(first.status.label.length).toBeGreaterThan(0);
    expect(first.status.icon.trim().length).toBeGreaterThan(0);
    expect(first.detail).toBe('count L2'); // the server's owner-action rides along as data
    expect(first.amountMinor).toBe(-900);
  });

  it('a healthy shop (data present, no exceptions) shows a single settled OK signal', () => {
    const view = session({
      valuation: { totalValueMinor: 500_00, currency: 'INR' },
      ageing: { oldestBucketValueMinor: 0, totalValueMinor: 500_00, unvaluedMinor: 0, currency: 'INR' },
    }).view('en');
    expect(view.signals).toHaveLength(1);
    expect(view.signals[0]!.kind).toBe('healthy');
    expect(view.signals[0]!.status.tone).toBe('ok');
    expect(view.signals[0]!.status.needsAttention).toBe(false);
    expect(view.signals[0]!.status.icon.trim().length).toBeGreaterThan(0);
  });
});

describe('the honest gaps are named, never valued at a guess (P-08)', () => {
  it('uncosted stock and stock over 90 days each raise their own degraded signal', () => {
    const view = session({
      ageing: { oldestBucketValueMinor: 300_00, totalValueMinor: 1000_00, unvaluedMinor: 150_00, currency: 'INR' },
    }).view('en');

    const kinds = view.signals.map((s) => s.kind);
    expect(kinds).toContain('uncosted_stock');
    expect(kinds).toContain('aged_stock');
    const uncosted = view.signals.find((s) => s.kind === 'uncosted_stock')!;
    expect(uncosted.status.tone).toBe('degraded');
    expect(uncosted.status.needsAttention).toBe(true);
    expect(uncosted.amountMinor).toBe(150_00);
    expect(uncosted.currency).toBe('INR');
  });

  it('a zero uncosted / zero aged figure raises no signal — it is not a problem to chase', () => {
    const view = session({
      ageing: { oldestBucketValueMinor: 0, totalValueMinor: 1000_00, unvaluedMinor: 0, currency: 'INR' },
    }).view('en');
    expect(view.signals.map((s) => s.kind)).toEqual(['healthy']);
  });
});

describe('the headline numbers are shown only for the sections the screen was told about', () => {
  it('valuation, ageing and performance each contribute their KPIs; an absent section contributes none', () => {
    const view = session({
      valuation: { totalValueMinor: 500_00, currency: 'INR' },
    }).view('en');
    const keys = view.kpis.map((k) => k.key);
    expect(keys).toEqual(['stockValue']); // no ageing/performance → no other KPIs, not zeros
    expect(view.kpis[0]!.value).toEqual({ kind: 'money', minor: 500_00, currency: 'INR' });
  });

  it('a ratio the engine could not compute is passed through as not_meaningful, never invented', () => {
    const view = session({
      performance: {
        turns: { kind: 'ratio', bp: 25_000 },
        daysOfCover: { kind: 'ratio', bp: 1_460 },
        gmroi: { kind: 'not_meaningful', because: 'a sold product has no known tax rate' },
      },
    }).view('en');
    const gmroi = view.kpis.find((k) => k.key === 'gmroi')!;
    expect(gmroi.value).toEqual({ kind: 'not_meaningful', because: 'a sold product has no known tax rate' });
    const turns = view.kpis.find((k) => k.key === 'turns')!;
    expect(turns.value).toEqual({ kind: 'ratio', bp: 25_000 });
  });

  it('marks uncosted and aged KPIs as attention with a word (not a colour) when above zero', () => {
    const view = session({
      ageing: { oldestBucketValueMinor: 300_00, totalValueMinor: 1000_00, unvaluedMinor: 150_00, currency: 'INR' },
    }).view('en');
    expect(view.kpis.find((k) => k.key === 'uncosted')!.attention).toBe(true);
    expect(view.kpis.find((k) => k.key === 'aged')!.attention).toBe(true);
  });
});

describe('freshness is a fact on the page', () => {
  it('the overall "as of" is the most recent section timestamp', () => {
    const view = session({
      valuation: { totalValueMinor: 1, currency: 'INR' },
      ageing: { oldestBucketValueMinor: 0, totalValueMinor: 1, unvaluedMinor: 0, currency: 'INR' },
      asAt: { valuation: '2026-09-19T06:00:00.000Z', ageing: '2026-09-19T08:30:00.000Z' },
    }).view('en');
    expect(view.asOf).toBe('2026-09-19T08:30:00.000Z');
  });
});
