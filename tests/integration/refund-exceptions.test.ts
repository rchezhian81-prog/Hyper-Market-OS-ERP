import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M14-FR-03/04: the cash office's refund-exception list and day totals on the live API. A refund pays
// money OUT, so the failures are expensive — a failed reversal (customer owed now), an over-refund (paid
// out more than taken) — every entry valued and owned; and the day close states confirmed/uncertain/
// failed separately rather than pretending an uncertain reversal is settled.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-11T12:00:00Z';

const rev = (o: Partial<Record<string, unknown>> & { reversalId: string; refundId: string; originalTenderId: string; amountMinor: number; status: string }) =>
  ({ providerRef: `pref-${o.reversalId}`, currency: 'INR', requestedBy: 'u-cash', requestedAt: '2026-08-11T11:00:00Z', reconciled: true, ...o });
const orig = (tenderId: string, amountMinor: number) =>
  ({ tenderId, saleId: `sale-${tenderId}`, kind: 'card', providerRef: `oref-${tenderId}`, amountMinor, currency: 'INR', capturedAt: '2026-08-11T10:00:00Z' });

const exceptions = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/finance/refunds/exceptions', userId, tenantId: A, idempotencyKey: key, body });
const dayTotals = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/finance/refunds/day-totals', userId, tenantId: A, idempotencyKey: key, body });

describe('refund exceptions & day totals (M14-FR-03/04)', () => {
  it('lists refund failures worst-first: a failed reversal above an over-refund', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await exceptions(h, 'u-owner', {
      at: AT,
      owner: 'cash-office',
      originals: [orig('tndr-1', 50000), orig('tndr-2', 20000)],
      reversals: [
        rev({ reversalId: 'rv-fail', refundId: 'rf-fail', originalTenderId: 'tndr-1', amountMinor: 50000, status: 'failed', reconciled: false }),
        // Two succeeded reversals totalling 30000 against a 20000 charge — 10000 over.
        rev({ reversalId: 'rv-a', refundId: 'rf-a', originalTenderId: 'tndr-2', amountMinor: 15000, status: 'succeeded' }),
        rev({ reversalId: 'rv-b', refundId: 'rf-b', originalTenderId: 'tndr-2', amountMinor: 15000, status: 'succeeded' }),
      ],
    }, 're-worst')).body as { count: number; exceptions: { kind: string; valueMinor: number; owner: string }[] };

    expect(body.count).toBe(2);
    expect(body.exceptions[0]!.kind).toBe('reversal_failed'); // customer owed money right now — ranked first
    expect(body.exceptions[0]!.owner).toBe('cash-office');     // valued AND owned
    expect(body.exceptions[1]!.kind).toBe('over_refunded');
    expect(body.exceptions[1]!.valueMinor).toBe(10000);        // paid out more than taken
  });

  it('states confirmed / uncertain / failed separately at day close, never one guessed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await dayTotals(h, 'u-owner', {
      reversals: [
        rev({ reversalId: 'c1', refundId: 'rf-c1', originalTenderId: 't1', amountMinor: 30000, status: 'succeeded' }),
        rev({ reversalId: 'u1', refundId: 'rf-u1', originalTenderId: 't2', amountMinor: 5000, status: 'uncertain' }),
        rev({ reversalId: 'p1', refundId: 'rf-p1', originalTenderId: 't3', amountMinor: 1000, status: 'pending' }),
        rev({ reversalId: 'f1', refundId: 'rf-f1', originalTenderId: 't4', amountMinor: 2000, status: 'failed' }),
      ],
    }, 're-totals')).body as { confirmedMinor: number; uncertainMinor: number; failedMinor: number };

    expect(body.confirmedMinor).toBe(30000);
    expect(body.uncertainMinor).toBe(6000); // uncertain + pending — money in an unknown state
    expect(body.failedMinor).toBe(2000);
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await exceptions(h, 'u-owner', { at: AT, originals: [], reversals: [] }, 're-noowner')).status).toBe(400);
    expect((await exceptions(h, 'u-cash', { at: AT, owner: 'x', originals: [], reversals: [] }, 're-rbac')).status).toBe(403);
  });
});
