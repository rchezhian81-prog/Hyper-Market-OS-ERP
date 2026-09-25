// Pilot feature-safety verification (Phase 3). Proves, through the REAL cloud surface, that every
// dangerous capability is OFF or gated by default for a FRESH pilot tenant (an owner and nothing else).
// This is the single consolidated assertion the pilot-readiness gap assessment asked for. It asserts only
// controls that genuinely exist on the surface; controls that live outside the API (see FEATURE-SAFETY.md,
// e.g. step-up re-auth — GAP-SEC-06) are documented there, NOT asserted here, because a false assurance is
// worse than a named gap.

import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { OPTIONAL_FEATURES } from '../../packages/tenant/src/tenant';

const T = 'pilot-safety-tenant';
const OWNER = 'pilot-safety-owner';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** A fresh tenant: a genesis owner and nothing else turned on. */
async function freshTenant(migrationTargetKind?: 'rehearsal' | 'staging' | 'local' | 'production') {
  const h = migrationTargetKind === undefined ? apiHarness() : apiHarness({ migrationTargetKind });
  await h.seedOwner(T, OWNER);
  return h;
}

describe('pilot feature safety — dangerous capabilities are off/gated by default (Phase 3)', () => {
  it('live GST / e-invoice / e-way-bill portal is NOT live by default, and the kill switch overrides', async () => {
    const h = await freshTenant();
    const off = await h.request({ method: 'POST', path: '/v1/finance/gst-portal/gate', userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'safety-gst-off' });
    expect(off.status).toBe(200);
    expect((off.body as { canGoLive: boolean; reason: string }).canGoLive).toBe(false);
    expect((off.body as { reason: string }).reason).toBe('not_enabled');

    const killed = await h.request({ method: 'POST', path: '/v1/finance/gst-portal/gate', userId: OWNER, tenantId: T, body: { enabled: true, killed: true }, idempotencyKey: 'safety-gst-killed' });
    expect((killed.body as { canGoLive: boolean; reason: string }).canGoLive).toBe(false);
    expect((killed.body as { reason: string }).reason).toBe('killed');
  });

  it('optional/paid features are all OFF for a fresh tenant', async () => {
    const h = await freshTenant();
    const res = await h.request({ method: 'GET', path: '/v1/platform/entitlements', userId: OWNER, tenantId: T });
    expect(res.status).toBe(200);
    const body = res.body as { entitled: readonly string[]; off: readonly string[] };
    expect(body.entitled).toEqual([]);
    // Every catalogue feature is in the "off" list.
    for (const feature of OPTIONAL_FEATURES) expect(body.off).toContain(feature);
  });

  it('an entitlement-gated route is refused until the feature is turned on', async () => {
    const h = await freshTenant();
    const body = { kind: 'percent_off', validUntil: '2027-03-31', maxRedemptions: 100, maxPerCustomer: 1, percentBps: 1000 };
    const refused = await h.request({ method: 'POST', path: '/v1/loyalty/coupons/SAFETY-CHK', userId: OWNER, tenantId: T, body, idempotencyKey: 'safety-coupon-1' });
    expect(refused.status).toBe(403);
    expect(codeOf(refused)).toBe('feature_not_entitled');

    await h.enableFeature(T, 'loyalty');
    const allowed = await h.request({ method: 'POST', path: '/v1/loyalty/coupons/SAFETY-CHK', userId: OWNER, tenantId: T, body, idempotencyKey: 'safety-coupon-2' });
    expect(allowed.status).toBe(201);
  });

  it('the AI kill switch is ON by default — no agent run can proceed', async () => {
    const h = await freshTenant();
    const res = await h.request({ method: 'POST', path: '/v1/ai/agents/operations/runs', userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'safety-ai-1' });
    expect(res.status).toBe(503);
    expect(codeOf(res)).toBe('kill_switch_is_on');
  });

  it('migration refuses a PRODUCTION target on every request (never touch production)', async () => {
    const h = await freshTenant('production');
    const res = await h.request({ method: 'POST', path: '/v1/migration/discovery', userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'safety-mig-1' });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('target_is_production');
  });

  it('the cutover decision is NO-GO by default (an empty checklist never ticks GO)', async () => {
    const h = await freshTenant();
    const res = await h.request({ method: 'POST', path: '/v1/migration/cutover/decision', userId: OWNER, tenantId: T, body: { evidence: {} }, idempotencyKey: 'safety-cutover-1' });
    expect(res.status).toBe(200);
    expect((res.body as { decision: { go: boolean } }).decision.go).toBe(false);
  });

  it('maker-checker (§28) holds — a price change cannot be self-approved', async () => {
    const h = await freshTenant();
    const res = await h.request({
      method: 'POST', path: '/v1/prices/changes', userId: OWNER, tenantId: T, idempotencyKey: 'safety-price-1',
      // below cost, so it needs a separate approver — supplying the setter as the approver must be refused.
      body: { productId: 'safety-prod', priceMinor: 3000, mrpMinor: 6000, costMinor: 5000, currency: 'INR', marginFloorBps: 0, approval: { decidedBy: OWNER, reason: 'self' } },
    });
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('approved_by_the_setter');
  });

  it('a fresh tenant authorises nothing without a grant (default-deny)', async () => {
    // A user with no role grant cannot read even the org structure.
    const h = await freshTenant();
    const res = await h.request({ method: 'GET', path: '/v1/org/nodes', userId: 'nobody-in-particular', tenantId: T });
    expect(res.status).toBe(403);
  });
});
