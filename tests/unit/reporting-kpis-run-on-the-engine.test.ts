import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { reportingAdapter, STREAM } from '../../services/api/src/adapters';
import type { Figure } from '../../services/reporting/src/index';

// CORE-02 inc1: the owner's dashboard figures on the cloud API are aggregated by the tested KPI
// engine (`packages/reporting` salesSummary, M29-FR-01), not a second copy of the arithmetic in the
// adapter. The engine's own maths is pinned in tests/unit/reporting.test.ts; here we prove the
// RUNNING API path delegates to it — including the tender mix, which the old inline reduce never
// produced — and that it never invents a margin the cloud event cannot support.

const TENANT = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-08-10';
const NOW = `${DAY}T12:00:00.000Z`;

interface TenderIn { readonly kind: string; readonly amountMinor: number }

async function shopWith(
  sales: readonly { id: string; totalMinor: number; tenders: readonly TenderIn[]; tradingDay?: string }[],
): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (const s of sales) {
    await store.append(TENANT, STREAM.sales, makeEvent({
      id: `e-${s.id}`, type: 'SaleCommitted', occurredAt: NOW,
      idempotencyKey: `sale-${TENANT}-${s.id}`, source: 'test',
      payload: {
        saleId: s.id, receiptNumber: `R-${s.id}`, laneId: 'lane-1', cashierId: 'u-1',
        tradingDay: s.tradingDay ?? DAY, committedAt: NOW, totalMinor: s.totalMinor,
        currency: 'INR', packVersion: 1, lines: [], tenders: s.tenders,
      },
    }));
  }
  return store;
}

const byName = (figures: readonly Figure[], name: string): Figure | undefined =>
  figures.find((f) => f.name === name);

describe('reporting figures are produced by the tested salesSummary engine (CORE-02)', () => {
  it('gross and receipts are the engine\'s Σ, not an inline reduce', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
      { id: 'S2', totalMinor: 50_000, tenders: [{ kind: 'upi', amountMinor: 50_000 }] },
      { id: 'S3', totalMinor: 36_000, tenders: [{ kind: 'card', amountMinor: 36_000 }] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW }).figures(TENANT, 'dashboard');

    expect(byName(figures, 'Sales today')?.valueMinor).toBe(150_000);
    expect(byName(figures, 'Sales today — receipts')?.valueMinor).toBe(3);
  });

  it('breaks the day down by tender — the split the engine computes and the old path did not', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
      { id: 'S2', totalMinor: 50_000, tenders: [{ kind: 'upi', amountMinor: 50_000 }] },
      { id: 'S3', totalMinor: 20_000, tenders: [{ kind: 'cash', amountMinor: 20_000 }] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW }).figures(TENANT, 'dashboard');

    expect(byName(figures, 'Sales today — cash')?.valueMinor).toBe(84_000);
    expect(byName(figures, 'Sales today — upi')?.valueMinor).toBe(50_000);
    // The parts reconcile to the whole — the honest property of a real read-model.
    expect(84_000 + 50_000).toBe(byName(figures, 'Sales today')?.valueMinor);
  });

  it('attributes a split payment to its largest tender, and shows tenderless sales as unrecorded', async () => {
    const store = await shopWith([
      // split basket: mostly card → booked to card
      { id: 'S1', totalMinor: 30_000, tenders: [{ kind: 'card', amountMinor: 25_000 }, { kind: 'cash', amountMinor: 5_000 }] },
      // a sale banked with no tender detail — visible, not hidden
      { id: 'S2', totalMinor: 10_000, tenders: [] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW }).figures(TENANT, 'dashboard');

    expect(byName(figures, 'Sales today — card')?.valueMinor).toBe(30_000);
    expect(byName(figures, 'Sales today — unrecorded')?.valueMinor).toBe(10_000);
  });

  it('never emits a margin, net or tax figure — the cloud event cannot support one', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW }).figures(TENANT, 'dashboard');

    for (const f of figures) {
      expect(f.name.toLowerCase()).not.toMatch(/margin|profit|\bnet\b|\btax\b|cogs|cost/);
    }
  });

  it('reads only today — a sale on another trading day is not counted', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
      { id: 'OLD', totalMinor: 99_000, tenders: [{ kind: 'cash', amountMinor: 99_000 }], tradingDay: '2026-08-09' },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW }).figures(TENANT, 'dashboard');
    expect(byName(figures, 'Sales today')?.valueMinor).toBe(64_000);
  });
});
