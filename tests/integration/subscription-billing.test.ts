import { describe, it, expect } from 'vitest';
import type { HttpResponse } from '../../services/kernel/src/index';
import { apiHarness } from '../support/api-harness';
import { sandboxSignature } from '../../packages/platform/src/index';

/**
 * WP5 / ADR-0014 — subscription & recurring billing over the REAL API surface (API-11).
 *
 * Exercises the whole chain the way production composes it: the billing routes, the event-sourced
 * `billingAdapter` over the store, the sandbox provider, and the RBAC pipeline. Proves the funnel
 * (plans → subscribe → mandate → webhook → dunning → cancel), that no real money can move in sandbox,
 * that a failed run never stops trading, and that only the OWNER can set up a paid subscription.
 */

const T = 't-sre';
const OWNER = 'u-owner';
const bodyOf = (res: HttpResponse) => (typeof res.body === 'string' ? JSON.parse(res.body) : res.body);

const subscribe = (h: ReturnType<typeof apiHarness>, key = 'sub-1') =>
  h.request({ method: 'POST', path: '/v1/platform/subscription', userId: OWNER, tenantId: T, idempotencyKey: key, body: { planId: 'standard', rail: 'upi_autopay' } });

const chargeWebhook = (h: ReturnType<typeof apiHarness>, key: string, outcome: 'succeeded' | 'failed', chargeRef: string) => {
  const event = { tenantId: T, subscriptionRef: 'sbx', outcome, chargeRef, amountMinor: 500_000, at: '2026-10-05T00:00:00.000Z' };
  return h.request({
    method: 'POST', path: '/v1/platform/billing/webhook', userId: OWNER, tenantId: T,
    idempotencyKey: key, body: { event, signature: sandboxSignature(JSON.stringify(event)) },
  });
};

describe('WP5 subscription billing over the real surface', () => {
  it('lists plans, all under the RBI no-OTP ceiling', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const res = await h.request({ method: 'GET', path: '/v1/platform/plans', userId: OWNER, tenantId: T });
    expect(res.status).toBe(200);
    const b = bodyOf(res);
    expect(b.plans.length).toBeGreaterThan(0);
    expect(b.plans.every((p: { monthlyPriceMinor: number }) => p.monthlyPriceMinor <= 1_500_000)).toBe(true);
  });

  it('reports no subscription until one is set up', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const res = await h.request({ method: 'GET', path: '/v1/platform/subscription', userId: OWNER, tenantId: T });
    expect(res.status).toBe(200);
    expect(bodyOf(res).subscribed).toBe(false);
  });

  it('subscribes, sets up a sandbox mandate, and says plainly that no real money can move', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const res = await subscribe(h);
    expect(res.status).toBe(201);
    const b = bodyOf(res);
    expect(b.providerMode).toBe('sandbox');
    expect(b.subscription.mandate.status).toBe('active');
    expect(b.subscription.mandate.createdWithAfa).toBe(true);
    expect(b.subscription.nextCharge).toBeDefined();
    expect(b.note).toMatch(/NO real money/);
    expect(JSON.stringify(b)).not.toMatch(/card_number|cvv|expiry/i);
  });

  it('refuses an unknown plan (404) and an unknown rail (400)', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const p = await h.request({ method: 'POST', path: '/v1/platform/subscription', userId: OWNER, tenantId: T, idempotencyKey: 'sx', body: { planId: 'nope', rail: 'upi_autopay' } });
    expect(p.status).toBe(404);
    const r = await h.request({ method: 'POST', path: '/v1/platform/subscription', userId: OWNER, tenantId: T, idempotencyKey: 'sy', body: { planId: 'standard', rail: 'bitcoin' } });
    expect(r.status).toBe(400);
  });

  it('records a successful debit via the provider webhook, and rejects a forged one', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    await subscribe(h);
    const ok = await chargeWebhook(h, 'wh-1', 'succeeded', 'chg-1');
    expect(ok.status).toBe(200);
    expect(bodyOf(ok).applied).toBe(true);
    expect(bodyOf(ok).dunning.state).toBe('current');

    const event = { tenantId: T, subscriptionRef: 'sbx', outcome: 'succeeded', chargeRef: 'chg-2', amountMinor: 500_000, at: '2026-10-05T00:00:00.000Z' };
    const forged = await h.request({ method: 'POST', path: '/v1/platform/billing/webhook', userId: OWNER, tenantId: T, idempotencyKey: 'wh-forge', body: { event, signature: 'sandbox:forged' } });
    expect(forged.status).toBe(400);
  });

  it('a run of failed debits suspends optional features but NEVER stops trading (P-01)', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    await subscribe(h);
    let last: HttpResponse | undefined;
    for (let i = 0; i < 6; i += 1) last = await chargeWebhook(h, `whf-${i}`, 'failed', `f-${i}`);
    const d = bodyOf(last!).dunning;
    expect(d.state).toBe('suspended');
    expect(d.suspendedGrants.length).toBeGreaterThan(0);
    expect(d.mayContinueTrading).toBe(true);
  });

  it('cancels with notice (404 when never subscribed)', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const none = await h.request({ method: 'POST', path: '/v1/platform/subscription/cancellation', userId: OWNER, tenantId: T, idempotencyKey: 'c0', body: {} });
    expect(none.status).toBe(404);
    await subscribe(h);
    const res = await h.request({ method: 'POST', path: '/v1/platform/subscription/cancellation', userId: OWNER, tenantId: T, idempotencyKey: 'c1', body: {} });
    expect(res.status).toBe(200);
    expect(bodyOf(res).subscription.endsOn).toBeDefined();
  });

  it('only the OWNER may set up a paid subscription — a platform_admin is refused (403) but may read plans', async () => {
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-admin', 'platform_admin');
    const read = await h.request({ method: 'GET', path: '/v1/platform/plans', userId: 'u-admin', tenantId: T });
    expect(read.status).toBe(200);
    const sub = await h.request({ method: 'POST', path: '/v1/platform/subscription', userId: 'u-admin', tenantId: T, idempotencyKey: 'adm', body: { planId: 'standard', rail: 'upi_autopay' } });
    expect(sub.status).toBe(403);
  });
});
