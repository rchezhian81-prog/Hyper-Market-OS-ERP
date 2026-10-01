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
/** A shop whose clocks keep UTC with a midnight cut-off: "today" is the calendar date, as these cases assume. */
const UTC = { timeZone: 'UTC', tradingDayCutoff: '00:00' };
/** The shop in Tamil Nadu: IST, trading past midnight to a 02:00 cut-off. */
const IST_0200 = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '02:00' };
const IST_MIDNIGHT = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' };

interface TenderIn { readonly kind: string; readonly amountMinor: number }

async function shopWith(
  sales: readonly { id: string; totalMinor: number; tenders: readonly TenderIn[]; tradingDay?: string; occurredAt?: string }[],
): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  for (const s of sales) {
    await store.append(TENANT, STREAM.sales, makeEvent({
      id: `e-${s.id}`, type: 'SaleCommitted', occurredAt: s.occurredAt ?? NOW,
      idempotencyKey: `sale-${TENANT}-${s.id}`, source: 'test',
      payload: {
        saleId: s.id, receiptNumber: `R-${s.id}`, laneId: 'lane-1', cashierId: 'u-1',
        tradingDay: s.tradingDay ?? DAY, committedAt: s.occurredAt ?? NOW, totalMinor: s.totalMinor,
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
    const figures = await reportingAdapter({ store, now: () => NOW, calendar: () => UTC }).figures(TENANT, 'dashboard');

    expect(byName(figures, 'Sales today')?.valueMinor).toBe(150_000);
    expect(byName(figures, 'Sales today — receipts')?.valueMinor).toBe(3);
  });

  it('breaks the day down by tender — the split the engine computes and the old path did not', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
      { id: 'S2', totalMinor: 50_000, tenders: [{ kind: 'upi', amountMinor: 50_000 }] },
      { id: 'S3', totalMinor: 20_000, tenders: [{ kind: 'cash', amountMinor: 20_000 }] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW, calendar: () => UTC }).figures(TENANT, 'dashboard');

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
    const figures = await reportingAdapter({ store, now: () => NOW, calendar: () => UTC }).figures(TENANT, 'dashboard');

    expect(byName(figures, 'Sales today — card')?.valueMinor).toBe(30_000);
    expect(byName(figures, 'Sales today — unrecorded')?.valueMinor).toBe(10_000);
  });

  it('never emits a margin, net or tax figure — the cloud event cannot support one', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW, calendar: () => UTC }).figures(TENANT, 'dashboard');

    for (const f of figures) {
      expect(f.name.toLowerCase()).not.toMatch(/margin|profit|\bnet\b|\btax\b|cogs|cost/);
    }
  });

  it('reads only today — a sale on another trading day is not counted', async () => {
    const store = await shopWith([
      { id: 'S1', totalMinor: 64_000, tenders: [{ kind: 'cash', amountMinor: 64_000 }] },
      { id: 'OLD', totalMinor: 99_000, tenders: [{ kind: 'cash', amountMinor: 99_000 }], tradingDay: '2026-08-09' },
    ]);
    const figures = await reportingAdapter({ store, now: () => NOW, calendar: () => UTC }).figures(TENANT, 'dashboard');
    expect(byName(figures, 'Sales today')?.valueMinor).toBe(64_000);
  });
});

describe('"Sales today" is the SHOP\'s trading day, not the server\'s date (F14 FIXED, SP-9-i-c · M01-FR-02 · M29-FR-01)', () => {
  // 20:00 UTC on 10 Aug is 01:30 IST on 11 Aug. The server's calendar says 10 Aug; the shop has crossed midnight.
  const LATE = '2026-08-10T20:00:00.000Z';
  const cash = (minor: number): TenderIn[] => [{ kind: 'cash', amountMinor: minor }];

  it('at 01:30 IST with a midnight cut-off, "today" is the 11th: the sale the till dated 11 Aug counts, the 10th\'s does not', async () => {
    const store = await shopWith([
      { id: 'LATE-10', totalMinor: 10_000, tenders: cash(10_000), tradingDay: '2026-08-10', occurredAt: '2026-08-10T12:00:00.000Z' },
      { id: 'LATE-11', totalMinor: 64_000, tenders: cash(64_000), tradingDay: '2026-08-11', occurredAt: '2026-08-10T19:00:00.000Z' },
    ]);
    const figures = await reportingAdapter({ store, now: () => LATE, calendar: () => IST_MIDNIGHT }).figures(TENANT, 'dashboard');
    expect(byName(figures, 'Sales today')?.valueMinor).toBe(64_000);
    expect(byName(figures, 'Sales today — receipts')?.valueMinor).toBe(1);
    // The old behaviour — the server's UTC date — would have reported the 10th's ₹100 and hidden the 11th's ₹640.
    const byServerDate = await reportingAdapter({ store, now: () => LATE, calendar: () => UTC }).figures(TENANT, 'dashboard');
    expect(byName(byServerDate, 'Sales today')?.valueMinor).toBe(10_000);
  });

  it('with the shop\'s 02:00 cut-off the same moment is still the 10th — the day that is open is the day reported', async () => {
    const store = await shopWith([
      { id: 'OPEN-10', totalMinor: 10_000, tenders: cash(10_000), tradingDay: '2026-08-10', occurredAt: '2026-08-10T19:00:00.000Z' },
      { id: 'EARLY-10', totalMinor: 5_000, tenders: cash(5_000), tradingDay: '2026-08-10', occurredAt: '2026-08-09T21:00:00.000Z' }, // 02:30 IST 10 Aug
      { id: 'NEXT-11', totalMinor: 64_000, tenders: cash(64_000), tradingDay: '2026-08-11', occurredAt: '2026-08-10T20:31:00.000Z' }, // 02:01 IST 11 Aug
    ]);
    const figures = await reportingAdapter({ store, now: () => LATE, calendar: () => IST_0200 }).figures(TENANT, 'dashboard');
    expect(byName(figures, 'Sales today')?.valueMinor).toBe(15_000);
    expect(byName(figures, 'Sales today — receipts')?.valueMinor).toBe(2);
  });

  it('the calendar is read per tenant, at request time — two shops in two zones see two different "todays" at one instant', async () => {
    const store = await shopWith([
      { id: 'X-10', totalMinor: 10_000, tenders: cash(10_000), tradingDay: '2026-08-10', occurredAt: '2026-08-10T12:00:00.000Z' },
      { id: 'X-11', totalMinor: 64_000, tenders: cash(64_000), tradingDay: '2026-08-11', occurredAt: '2026-08-10T19:00:00.000Z' },
    ]);
    const asked: string[] = [];
    const adapter = reportingAdapter({
      store, now: () => LATE,
      calendar: (tenantId) => { asked.push(tenantId); return tenantId === TENANT ? IST_MIDNIGHT : UTC; },
    });
    expect(byName(await adapter.figures(TENANT, 'dashboard'), 'Sales today')?.valueMinor).toBe(64_000);
    expect(asked).toEqual([TENANT]);
  });
});
