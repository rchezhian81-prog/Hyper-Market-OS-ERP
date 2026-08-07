import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Shift close, end to end through the real API (M14-FR-02, API-05). The cashier counts the drawer
// WITHOUT seeing the expected figure (a blind count protects integrity); the cloud computes expected
// = float + cash sales − pickups − cash refunds, the variance against the count, and requires a reason
// for a MATERIAL over/short — raising a reconciliation exception the cash office can see. Proves the
// wired shift-close surface against the real pipeline and real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// expected = 50000 + 100000 − 30000 − 5000 = 115000; tolerance 500.
const base = (over: Record<string, unknown> = {}) => ({
  tillId: 'T1', cashierId: 'cashier-1', tradingDay: '2026-08-07',
  openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
  countedCashMinor: 115_000, toleranceMinor: 500, ...over,
});

const close = (h: ApiHarness, tenantId: string, userId: string, shiftId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/shifts/${shiftId}/close`, userId, tenantId, idempotencyKey: key ?? `sc-${shiftId}`, body });

const overShort = (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/shifts/over-short', userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Closed { varianceMinor: number; exceptionRaised: boolean; expectedMinor: number }
interface OverShort { overShort: { shiftId: string; varianceMinor: number }[]; totalVarianceMinor: number }

describe('a shift closes on a blind count, over/short valued and explained (M14-FR-02, API-05)', () => {
  it('closes a balanced drawer clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await close(h, A, 'u-owner', 'S1', base());
    expect(res.status).toBe(201);
    expect(res.body as Closed).toMatchObject({ expectedMinor: 115_000, varianceMinor: 0, exceptionRaised: false });
  });

  it('closes clean within tolerance without a reason', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // +300 over, tolerance 500 → within tolerance, no reason needed, no exception.
    const res = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 115_300 }));
    expect(res.status).toBe(201);
    expect(res.body as Closed).toMatchObject({ varianceMinor: 300, exceptionRaised: false });
  });

  it('refuses a material over/short with no reason, and records it once a reason is given', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // −1000 short, tolerance 500 → material.
    const noReason = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000 }));
    expect(noReason.status).toBe(422);
    expect(codeOf(noReason)).toBe('material_variance_needs_a_reason');

    const withReason = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'gave_wrong_change_on_a_note' }), 'sc-S1-b');
    expect(withReason.status).toBe(201);
    expect((withReason.body as Closed).exceptionRaised).toBe(true);

    // The cash office sees the over/short on its reconciliation list.
    const list = (await overShort(h, A, 'u-owner')).body as OverShort;
    expect(list.overShort.map((r) => r.shiftId)).toContain('S1');
    expect(list.totalVarianceMinor).toBe(-1_000);
  });

  it('is idempotent per shift — a re-sent close does not record it twice on a different figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await close(h, A, 'u-owner', 'S1', base(), 'k1')).status).toBe(201);
    const again = await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 999 }), 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyClosed?: boolean }).alreadyClosed).toBe(true);
    expect((again.body as { varianceMinor: number }).varianceMinor).toBe(0); // the first, balanced close stands
  });

  it('is authorized and per-tenant, and refuses a malformed close', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant does not close shifts
    await close(h, A, 'u-owner', 'S1', base({ countedCashMinor: 114_000, reasonCode: 'short' }));

    expect((await close(h, A, 'u-acct', 'S2', base())).status).toBe(403);
    expect((await overShort(h, A, 'u-acct')).status).toBe(403);
    expect((await close(h, A, 'u-owner', 'S3', { tillId: 'T1', cashierId: 'c1', tradingDay: '2026-08-07' })).status).toBe(400); // no figures

    // Tenant B has no over/short of its own.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await overShort(h, B, 'u-owner-b')).body as OverShort).overShort).toEqual([]);
  });
});
