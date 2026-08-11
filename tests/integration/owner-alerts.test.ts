import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M29-FR-03: the owner alerts inbox on the live API. Control by exception (P-03) — raw exceptions are
// GROUPED by kind, branch and person into the few alerts an owner will read, every threshold the owner's
// own, and an unset kind raises nothing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const owner = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/reporting/owner-alerts', userId, tenantId: A, idempotencyKey: key, body });

const discount = (eventId: string, actorId: string, valueMinor: number, at: string) =>
  ({ eventId, kind: 'large_discount', at, branchId: 'br-1', actorId, valueMinor, transactionRef: `txn-${eventId}` });

describe('owner alerts inbox (M29-FR-03)', () => {
  it('groups many exceptions by person into one alert, keeping every transaction id', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const events = [
      discount('d1', 'u-cash-A', 60000, '2026-08-11T10:00:00Z'),
      discount('d2', 'u-cash-A', 70000, '2026-08-11T11:00:00Z'),
      discount('d3', 'u-cash-A', 65000, '2026-08-11T12:00:00Z'),
      // Two voids by a different cashier, below the owner's threshold — not an alert.
      { eventId: 'v1', kind: 'voided_bill', at: '2026-08-11T10:05:00Z', branchId: 'br-1', actorId: 'u-cash-B', valueMinor: 10000, transactionRef: 'txn-v1' },
      { eventId: 'v2', kind: 'voided_bill', at: '2026-08-11T10:15:00Z', branchId: 'br-1', actorId: 'u-cash-B', valueMinor: 12000, transactionRef: 'txn-v2' },
    ];
    const body = (await owner(h, 'u-owner', { events, thresholds: { largeDiscountMinor: 50000, voidedBillCount: 3 } }, 'oa-group')).body as { count: number; alerts: { kind: string; count: number; actorId: string; transactionRefs: string[]; severity: string }[] };

    expect(body.count).toBe(1); // six voids would be one conversation; two below threshold is none
    expect(body.alerts[0]!.kind).toBe('large_discount');
    expect(body.alerts[0]!.count).toBe(3);
    expect(body.alerts[0]!.actorId).toBe('u-cash-A');
    expect(body.alerts[0]!.transactionRefs).toEqual(['txn-d1', 'txn-d2', 'txn-d3']); // kept for drill-through
  });

  it('raises nothing for a kind the owner set no threshold for', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const events = [discount('d1', 'u-cash-A', 90000, '2026-08-11T10:00:00Z')];
    const body = (await owner(h, 'u-owner', { events, thresholds: {} }, 'oa-none')).body as { count: number };
    expect(body.count).toBe(0);
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await owner(h, 'u-owner', { thresholds: {} }, 'oa-noevents')).status).toBe(400);
    expect((await owner(h, 'u-cash', { events: [], thresholds: {} }, 'oa-rbac')).status).toBe(403);
  });
});
