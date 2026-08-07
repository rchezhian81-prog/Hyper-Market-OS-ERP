import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Settlement — the cash office's day, end to end through the real API (M14-FR-03, API-09). A provider
// file is refused unless it reconciles to its OWN declared figures and is not a duplicate; then the
// day's card/UPI tenders are reviewed against what the provider actually paid, telling apart the
// tender that is merely NOT DUE YET from the one that is genuinely LATE, and valuing short/over/
// unknown separately (P-03, P-08). This proves the wired `packages/settlement` against the real
// pipeline and real per-tenant RBAC — the engine that, until now, nothing fed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const cardSale = (over: { saleId: string; ref: string; amount: number; committedAt: string }) => ({
  saleId: over.saleId, receiptNumber: `R-${over.saleId}`, laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: over.committedAt.slice(0, 10), committedAt: `${over.committedAt}T12:00:00.000Z`,
  totalMinor: over.amount, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: over.amount, lineTotalMinor: over.amount }],
  tenders: [{ kind: 'card', amountMinor: over.amount, ref: over.ref }],
});

const bank = (h: ApiHarness, tenantId: string, s: { saleId: string; ref: string; amount: number; committedAt: string }) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId, idempotencyKey: `bank-${s.saleId}`, body: cardSale(s) });

const batch = (over: Record<string, unknown> = {}) => ({
  batchId: 'BATCH-1', providerId: 'pinelabs', currency: 'INR', settlementDate: '2026-08-10',
  lines: [
    { id: 'c1', ref: 'PAY-MATCH', amountMinor: 10_000 },
    { id: 'c2', ref: 'PAY-SHORT', amountMinor: 39_000 },
    { id: 'c3', ref: 'PAY-UNKNOWN', amountMinor: 5_000 },
  ],
  declaredGrossMinor: 54_000, declaredFeesMinor: 0, declaredNetMinor: 54_000, ...over,
});

const importBatch = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: '/v1/settlement/batches', userId, tenantId, idempotencyKey: key ?? `sb-${body['batchId']}`, body });

const review = (h: ApiHarness, tenantId: string, userId: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/settlement/review', userId, tenantId, query: q });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Review { matchedCount: number; matchedValueMinor: number; awaitingValueMinor: number; atRiskValueMinor: number; exceptions: { finding: string; ref: string }[]; window: { from: string; to: string } }

describe('a provider settlement file must reconcile to its own figures before it is used (M14-FR-03)', () => {
  it('imports a batch whose lines sum to its gross and whose gross − fees = net', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await importBatch(h, A, 'u-owner', batch());
    expect(res.status).toBe(201);
    expect((res.body as { accepted: boolean }).accepted).toBe(true);
  });

  it('refuses a file whose lines do not sum to its declared gross', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await importBatch(h, A, 'u-owner', batch({ declaredGrossMinor: 55_000, declaredNetMinor: 55_000 }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('lines_do_not_sum_to_gross');
  });

  it('refuses a file whose own gross − fees does not equal its net', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await importBatch(h, A, 'u-owner', batch({ declaredFeesMinor: 1_000 })); // 54000 − 1000 ≠ 54000
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('gross_minus_fees_is_not_net');
  });

  it('refuses an empty batch and a duplicate, and an unreadable payload', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(codeOf(await importBatch(h, A, 'u-owner', batch({ batchId: 'E', lines: [], declaredGrossMinor: 0, declaredNetMinor: 0 })))).toBe('empty_batch');
    expect((await importBatch(h, A, 'u-owner', batch())).status).toBe(201);
    // A genuine RE-IMPORT (a new request, not a transport retry of the same one) is refused by the
    // business guard: importing the same file twice doubles every credit in it.
    expect(codeOf(await importBatch(h, A, 'u-owner', batch(), 'sb-BATCH-1-again'))).toBe('duplicate_batch');
    expect((await importBatch(h, A, 'u-owner', { batchId: '', lines: [] })).status).toBe(400);
  });
});

describe('the day review tells apart not-due-yet from late, and values what is at risk (M14-FR-03)', () => {
  it('matches what the provider paid, ages what it has not, and surfaces short/over/unknown', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await bank(h, A, { saleId: 'M', ref: 'PAY-MATCH', amount: 10_000, committedAt: '2026-08-09' }); // paid, matches
    await bank(h, A, { saleId: 'W', ref: 'PAY-AWAIT', amount: 20_000, committedAt: '2026-08-09' }); // unpaid, 1 day old
    await bank(h, A, { saleId: 'L', ref: 'PAY-LATE', amount: 30_000, committedAt: '2026-08-01' });  // unpaid, 9 days old
    await bank(h, A, { saleId: 'S', ref: 'PAY-SHORT', amount: 40_000, committedAt: '2026-08-09' }); // paid 39000 — short
    await bank(h, A, { saleId: 'X', ref: 'PAY-ANCIENT', amount: 99_000, committedAt: '2026-06-01' }); // before the window
    await importBatch(h, A, 'u-owner', batch());

    const r = (await review(h, A, 'u-owner', { date: '2026-08-10', cycleDays: '2', windowDays: '30' })).body as Review;

    expect(r.matchedCount).toBe(1);
    expect(r.matchedValueMinor).toBe(10_000);
    expect(r.awaitingValueMinor).toBe(20_000); // not due yet at T+2, reported for cash flow only
    // At risk: LATE 30000 + SHORT variance 1000 + UNKNOWN credit 5000.
    expect(r.atRiskValueMinor).toBe(36_000);

    const findings = new Set(r.exceptions.map((e) => e.finding));
    expect(findings).toContain('overdue_settlement'); // PAY-LATE
    expect(findings).toContain('short_settled');       // PAY-SHORT
    expect(findings).toContain('unknown_credit');      // PAY-UNKNOWN
    expect(findings).toContain('awaiting_settlement');  // PAY-AWAIT

    // The window is part of the answer, not a hidden assumption — the ancient tender is out of scope,
    // not silently called settled.
    expect(r.window.from).toBe('2026-07-11');
    expect(r.exceptions.some((e) => e.ref === 'PAY-ANCIENT')).toBe(false);
  });

  it('refuses a review with no date or cycle', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await review(h, A, 'u-owner', { cycleDays: '2' })).status).toBe(400);
    expect((await review(h, A, 'u-owner', { date: 'not-a-date', cycleDays: '2' })).status).toBe(400);
    expect((await review(h, A, 'u-owner', { date: '2026-08-10', cycleDays: 'x' })).status).toBe(400);
  });

  it('is authorized and per-tenant: a cashier cannot import or review, and one tenant\'s file is invisible to another', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await importBatch(h, A, 'u-owner', batch());

    expect((await importBatch(h, A, 'u-cash', batch({ batchId: 'C2' }))).status).toBe(403);
    expect((await review(h, A, 'u-cash', { date: '2026-08-10', cycleDays: '2' })).status).toBe(403);

    // Tenant B imported nothing and banked nothing: its review is empty, A's credits did not leak.
    await h.seedOwner(B, 'u-owner-b');
    const rb = (await review(h, B, 'u-owner-b', { date: '2026-08-10', cycleDays: '2' })).body as Review;
    expect(rb.matchedCount).toBe(0);
    expect(rb.exceptions).toEqual([]);
  });
});
