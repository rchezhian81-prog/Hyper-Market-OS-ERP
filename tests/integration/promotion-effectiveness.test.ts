import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

/**
 * **Promotion effectiveness + vendor funding, on the cloud (M05-FR-04 / D06 / D02, P-02).**
 *
 * A promotion is a decision to give away margin for volume, made on optimism and measured months
 * later — if at all. Simulate and launch were already governed on the cloud; these wire the last two
 * tested engines nothing fed: **was it worth doing?** (judged on incremental MARGIN, not units) and
 * **is the supplier actually covering the discount?** (claimed vs received). Both are pure computes
 * over figures the caller supplies; the API is the skin over `measureEffectiveness` /
 * `reconcileVendorFunding`, driven here through the real authenticated surface.
 */

const INR = 'INR';
const M = (minor: number) => ({ minor, currency: INR });
const TENANT = 't-sre';

describe('promotion effectiveness on the API', () => {
  it('judges a finished promotion on margin, not units — busier and poorer is NOT worth doing', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/promotions/promo-1/effectiveness', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'eff-1',
      body: { baselineUnits: 100, actualUnits: 160, baselineMargin: M(200_000), actualMargin: M(160_000) },
    });
    expect(res.status).toBe(200);
    const body = res.body as { upliftUnits: number; upliftBp: number; worthDoing: boolean; incrementalMargin: { minor: number }; detail: string };
    expect(body.upliftUnits).toBe(60);
    expect(body.upliftBp).toBe(6_000);
    expect(body.worthDoing).toBe(false);
    expect(body.incrementalMargin.minor).toBe(-40_000);
    expect(body.detail).toContain('busier, and poorer');
  });

  it('supplier funding can turn the same trade into one worth doing', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/promotions/promo-1/effectiveness', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'eff-2',
      body: { baselineUnits: 100, actualUnits: 160, baselineMargin: M(200_000), actualMargin: M(160_000), vendorFundingReceived: M(128_000) },
    });
    expect(res.status).toBe(200);
    expect((res.body as { worthDoing: boolean }).worthDoing).toBe(true);
  });

  it('refuses an unreadable measure without changing anything', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/promotions/promo-1/effectiveness', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'eff-bad', body: { baselineUnits: 100 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_an_effectiveness_measure');
  });
});

describe('vendor funding reconciliation on the API', () => {
  it('shows the discount given against the contribution actually received', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/promotions/promo-1/vendor-funding', userId: 'u-owner', tenantId: TENANT,
      idempotencyKey: 'vf-1',
      body: { supplierId: 'sup-1', agreedPerUnit: M(800), unitsSold: 160, receivedAmount: M(80_000) },
    });
    expect(res.status).toBe(200);
    const body = res.body as { claimable: { minor: number }; outstanding: { minor: number }; reconciled: boolean; detail: string };
    expect(body.claimable.minor).toBe(128_000);
    expect(body.outstanding.minor).toBe(48_000);
    expect(body.reconciled).toBe(false);
    expect(body.detail).toContain('the discount was given, the contribution was not');
  });

  it('is closed to a caller without the permission — nothing about a promotion leaks', async () => {
    const h = apiHarness();
    await h.seedOwner(TENANT, 'u-owner');
    const res = await h.request({
      method: 'POST', path: '/v1/promotions/promo-1/vendor-funding', userId: 'u-nobody', tenantId: TENANT,
      idempotencyKey: 'vf-403',
      body: { supplierId: 'sup-1', agreedPerUnit: M(800), unitsSold: 160 },
    });
    expect(res.status).toBe(403);
  });
});
