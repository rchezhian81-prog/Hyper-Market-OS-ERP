import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **The self-checkout decision surface, on the cloud (D04 / M12 / M15 · P-01).**
 *
 * Self-checkout is the one place the customer operates the till: intervene rarely, watch always, never
 * accuse anybody at the lane. These drive the three tested decisions through the real authenticated
 * surface — the basket risk assessment (age is always a human), the scan-and-go release, and the
 * read-only price kiosk that always says how fresh it is. All stateless and offline-safe by design.
 */

const TENANT = 't-sre';
const AT = '2026-08-29T10:00:00.000Z';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const line = (over: Record<string, unknown> = {}) =>
  ({ lineId: 'l1', productId: 'p1', name: 'Bread', qty: 1, unitPriceMinor: 4_000, scannedAt: AT, ...over });

describe('self-checkout decisions on the API', () => {
  it('lets a clean basket complete unattended, with no intervention', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/self-checkout/assess', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sc-ok',
      body: { basketId: 'b1', laneId: 'sco-1', mode: 'self_checkout', at: AT, lines: [line(), line({ lineId: 'l2', name: 'Milk', unitPriceMinor: 6_000 })] },
    });
    expect(res.status).toBe(200);
    const b = res.body as { canCompleteUnattended: boolean; interventions: unknown[] };
    expect(b.canCompleteUnattended).toBe(true);
    expect(b.interventions).toEqual([]);
  });

  it('always stops an age-restricted line for a human, with a neutral message to the customer', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/self-checkout/assess', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sc-age',
      body: { basketId: 'b2', laneId: 'sco-1', mode: 'self_checkout', at: AT, lines: [line({ name: 'Whisky', ageRestricted: true })] },
    });
    expect(res.status).toBe(200);
    const b = res.body as { canCompleteUnattended: boolean; interventions: { kind: string; blocking: boolean; customerMessage: string; attendantDetail: string }[] };
    expect(b.canCompleteUnattended).toBe(false);
    const age = b.interventions.find((i) => i.kind === 'age_check');
    expect(age?.blocking).toBe(true);
    expect(age?.customerMessage).not.toMatch(/theft|steal|restricted/i); // neutral at the lane
    expect(age?.attendantDetail).toMatch(/age-restricted/i);             // specific to the attendant
  });

  it('releases a trusted scan-and-go trip, but never one carrying an age-restricted item', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const released = await h.request({
      method: 'POST', path: '/v1/self-checkout/scan-and-go', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sg-ok',
      body: { basketId: 'b3', customerId: 'c1', lines: [line()], tripsCompleted: 12, discrepanciesFound: 0, selectedForAudit: false },
    });
    expect((released.body as { outcome: string; released: boolean }).outcome).toBe('released');
    expect((released.body as { released: boolean }).released).toBe(true);

    const age = await h.request({
      method: 'POST', path: '/v1/self-checkout/scan-and-go', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sg-age',
      body: { basketId: 'b4', customerId: 'c1', lines: [line({ ageRestricted: true })], tripsCompleted: 12, discrepanciesFound: 0, selectedForAudit: false },
    });
    expect((age.body as { outcome: string; released: boolean }).outcome).toBe('age_restricted_present');
    expect((age.body as { released: boolean }).released).toBe(false);
  });

  it('quotes a fresh kiosk price and refuses a stale one', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const pack = [{ productId: 'p1', name: 'Bread', priceMinor: 4_000 }];
    const fresh = await h.request({
      method: 'POST', path: '/v1/self-checkout/kiosk-quote', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-fresh',
      body: { productId: 'p1', pack, packBuiltAt: '2026-08-29T09:30:00.000Z', at: AT }, // 30 min old
    });
    expect((fresh.body as { outcome: string; priceMinor: number }).outcome).toBe('quoted');
    expect((fresh.body as { priceMinor: number }).priceMinor).toBe(4_000);

    const stale = await h.request({
      method: 'POST', path: '/v1/self-checkout/kiosk-quote', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'k-stale',
      body: { productId: 'p1', pack, packBuiltAt: '2026-08-29T04:00:00.000Z', at: AT }, // 360 min old > 240
    });
    expect((stale.body as { outcome: string }).outcome).toBe('stale');
  });

  it('refuses an unreadable basket, and is closed without the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const bad = await h.request({
      method: 'POST', path: '/v1/self-checkout/assess', userId: 'u-owner', tenantId: TENANT, idempotencyKey: 'sc-bad',
      body: { basketId: 'b5', laneId: 'sco-1', mode: 'nonsense', at: AT, lines: [] },
    });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_basket');

    const forbidden = await h.request({
      method: 'POST', path: '/v1/self-checkout/assess', userId: 'u-nobody', tenantId: TENANT, idempotencyKey: 'sc-403',
      body: { basketId: 'b6', laneId: 'sco-1', mode: 'self_checkout', at: AT, lines: [line()] },
    });
    expect(forbidden.status).toBe(403);
  });
});
