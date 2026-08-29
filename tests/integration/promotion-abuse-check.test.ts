import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **A promotion's usage cap, on the cloud AND at an offline lane (M20 promo integrity, §31, P-01, P-08).**
 *
 * "One per customer" and "500 in total" are only real if they hold at the till in the busiest hour —
 * which is often the hour the line to head office is down. So the rule runs from counts the CALLER
 * supplies, so the same check runs at an offline lane off its cached pack; and when the lane is
 * offline it says the count MAY be behind rather than pretending certainty. This drives the pure
 * `checkAbuseLimit` through the real authenticated surface. It decides only — it commits nothing.
 */

const TENANT = 't-sre';
const path = '/v1/promotions/promo-1/abuse-check';
const limit = { promotionId: 'promo-1', perCustomer: 2, perBasket: 1, totalUses: 500 };

describe('promotion abuse-check on the API', () => {
  it('allows a use that is within every cap', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'ab-ok',
      body: { limit, usedByThisCustomer: 1, usedInThisBasket: 0, usedInTotal: 100 },
    });
    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; allowed: boolean; countMayBeStale?: boolean };
    expect(body.verdict).toBe('allowed');
    expect(body.allowed).toBe(true);
    expect(body.countMayBeStale).toBeUndefined();
  });

  it('stops a second use in one basket, a third by one customer, and the offer once its budget is spent', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const call = (key: string, counts: { usedByThisCustomer: number; usedInThisBasket: number; usedInTotal: number }) =>
      h.request({ method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: key, body: { limit, ...counts } });

    const basket = await call('ab-b', { usedByThisCustomer: 0, usedInThisBasket: 1, usedInTotal: 10 });
    expect((basket.body as { verdict: string; allowed: boolean }).verdict).toBe('basket_limit');
    expect((basket.body as { allowed: boolean }).allowed).toBe(false);

    const customer = await call('ab-c', { usedByThisCustomer: 2, usedInThisBasket: 0, usedInTotal: 10 });
    expect((customer.body as { verdict: string }).verdict).toBe('customer_limit');

    const budget = await call('ab-t', { usedByThisCustomer: 0, usedInThisBasket: 0, usedInTotal: 500 });
    expect((budget.body as { verdict: string }).verdict).toBe('budget_exhausted');
  });

  it('still enforces at an offline lane, and says plainly the count may be behind (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'ab-off',
      body: { limit, usedByThisCustomer: 2, usedInThisBasket: 0, usedInTotal: 10, offline: true },
    });
    expect(res.status).toBe(200);
    const body = res.body as { allowed: boolean; verdict: string; countMayBeStale?: boolean };
    expect(body.allowed).toBe(false);
    expect(body.verdict).toBe('customer_limit');
    expect(body.countMayBeStale).toBe(true);
  });

  it('refuses an unreadable check — a limit and the three counts are required', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'ab-bad',
      body: { limit, usedByThisCustomer: 1 }, // missing usedInThisBasket / usedInTotal
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_an_abuse_check');
  });

  it('is closed to a caller without the promotion permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path, userId: 'u-nobody', tenantId: TENANT, idempotencyKey: 'ab-403',
      body: { limit, usedByThisCustomer: 0, usedInThisBasket: 0, usedInTotal: 0 },
    });
    expect(res.status).toBe(403);
  });
});
