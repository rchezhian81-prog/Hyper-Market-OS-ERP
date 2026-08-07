import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The store box's operating policy is read from the ONE durable settings source (M01-FR-02 / M33).
// A tenant configures currency, languages, default tax, the age the till asks about, licence hours,
// delivery radius and receipt paper once; GET /v1/platform/store-pack/policies serves them, so every
// surface reads the same answer instead of a scattered constant. Proven end to end through the real
// pipeline (real token verifier, real per-tenant authorization).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POL = '/v1/platform/store-pack/policies';

interface Policy {
  tradingDayCutoff: string; baseCurrency: string; languages: string[]; defaultTaxBps: number;
  ageRestrictedMinimumAge: number; licenceHoursEnabled: boolean; deliveryRadiusKm: number; receiptPaperFormat: string;
}

const policyFor = async (h: ApiHarness, tenantId: string, userId: string): Promise<Policy> =>
  (await h.request({ method: 'GET', path: POL, userId, tenantId })).body as Policy;

const answer = (h: ApiHarness, key: string, value: unknown): Promise<{ status: number }> =>
  h.request({ method: 'PUT', path: `/v1/platform/setup/${key}`, userId: 'u-owner', tenantId: A, idempotencyKey: `s-${key}`, body: { value, ifVersion: 0 } });

describe('the box operating policy is read from durable tenant settings (M01-FR-02, M33)', () => {
  it('serves the documented defaults until the tenant configures anything', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(await policyFor(h, A, 'u-owner')).toMatchObject({
      tradingDayCutoff: '00:00', baseCurrency: 'INR', languages: ['en', 'ta'], defaultTaxBps: 0,
      ageRestrictedMinimumAge: 18, licenceHoursEnabled: false, deliveryRadiusKm: 0, receiptPaperFormat: 'thermal-80',
    });
  });

  it('reflects the tenant’s configured values across the whole policy', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await answer(h, 'tax.default_bps', 1800)).status).toBe(200);
    expect((await answer(h, 'pos.age_restricted.minimum_age', 21)).status).toBe(200);
    expect((await answer(h, 'pos.licence_hours.enabled', true)).status).toBe(200);
    expect((await answer(h, 'receipt.paper_format', 'thermal-58')).status).toBe(200);

    const p = await policyFor(h, A, 'u-owner');
    expect(p.defaultTaxBps).toBe(1800);
    expect(p.ageRestrictedMinimumAge).toBe(21);
    expect(p.licenceHoursEnabled).toBe(true);
    expect(p.receiptPaperFormat).toBe('thermal-58');
  });

  it('is per-tenant and authorized: tenant B keeps its defaults; a cashier is refused (403)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await answer(h, 'tax.default_bps', 1800);

    await h.seedOwner(B, 'u-b');
    expect((await policyFor(h, B, 'u-b')).defaultTaxBps).toBe(0);

    expect((await h.request({ method: 'GET', path: POL, userId: 'u-cash', tenantId: A })).status).toBe(403);
  });
});
