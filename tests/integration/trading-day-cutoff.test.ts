import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { packCutoff } from '../../edge/store-edge/src/main';
import { tradingDate } from '../../packages/calendar/src/trading-day';

// M01-FR-02: the tenant's configured trading-day cut-off actually drives trading-day dating, instead
// of the "00:00" fallback. This proves the whole chain end to end: a tenant's durable setting →
// the served store-pack policy (GET /v1/platform/store-pack/policies) → the EDGE's own
// `packCutoff` + the calendar's `tradingDate` (the exact code the store box dates every sale with).
//
// Acceptance (docs/requirements/M01.md): "A sale committed at 00:30 falls in the correct trading day
// per the configured rule."

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICIES = '/v1/platform/store-pack/policies';

/** Date a local wall-clock moment exactly as the edge does, from a served cut-off. */
const dateAsEdgeWould = (localMoment: string, servedCutoff: string): string =>
  tradingDate(localMoment, packCutoff({ policies: { known: true, value: { tradingDayCutoff: servedCutoff } } }));

describe('the tenant’s configured trading-day cut-off drives trading-day dating (M01-FR-02)', () => {
  it('defaults to 00:00 until configured — a 00:30 sale dates to the same calendar day', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const res = await h.request({ method: 'GET', path: POLICIES, userId: 'u-owner', tenantId: A });
    expect(res.status).toBe(200);
    const cutoff = (res.body as { tradingDayCutoff: string }).tradingDayCutoff;
    expect(cutoff).toBe('00:00');
    expect(dateAsEdgeWould('2026-08-07T00:30', cutoff)).toBe('2026-08-07');
  });

  it('once the owner sets a 02:00 cut-off, a 00:30 sale dates to the PRIOR trading day', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const put = await h.request({
      method: 'PUT', path: '/v1/platform/setup/trading_day.cutoff', userId: 'u-owner', tenantId: A,
      idempotencyKey: 'set-cutoff', body: { value: '02:00', ifVersion: 0 },
    });
    expect(put.status).toBe(200);

    const served = (await h.request({ method: 'GET', path: POLICIES, userId: 'u-owner', tenantId: A }))
      .body as { tradingDayCutoff: string };
    expect(served.tradingDayCutoff).toBe('02:00');

    // The roadmap's own acceptance case: 00:30 is before the 02:00 cut-off → previous trading day.
    expect(dateAsEdgeWould('2026-08-07T00:30', served.tradingDayCutoff)).toBe('2026-08-06');
    // A daytime sale still dates to today; the boundary is at the cut-off, not midnight.
    expect(dateAsEdgeWould('2026-08-07T09:00', served.tradingDayCutoff)).toBe('2026-08-07');
    // And a sale exactly at the cut-off belongs to the new day.
    expect(dateAsEdgeWould('2026-08-07T02:00', served.tradingDayCutoff)).toBe('2026-08-07');
  });

  it('is per-tenant and authorized: another tenant is unaffected, and a cashier cannot read the policy (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await h.request({
      method: 'PUT', path: '/v1/platform/setup/trading_day.cutoff', userId: 'u-owner', tenantId: A,
      idempotencyKey: 'set-cutoff-2', body: { value: '02:00', ifVersion: 0 },
    });

    // Tenant B never set a cut-off → still the 00:00 default (no cross-tenant bleed).
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await h.seedOwner(B, 'u-owner-b');
    const bPolicy = (await h.request({ method: 'GET', path: POLICIES, userId: 'u-owner-b', tenantId: B }))
      .body as { tradingDayCutoff: string };
    expect(bPolicy.tradingDayCutoff).toBe('00:00');

    // A cashier holds no platform.setup.read → refused.
    expect((await h.request({ method: 'GET', path: POLICIES, userId: 'u-cash', tenantId: A })).status).toBe(403);
  });
});
