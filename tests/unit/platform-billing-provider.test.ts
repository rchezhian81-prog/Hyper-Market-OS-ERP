import { describe, it, expect } from 'vitest';
import {
  SandboxRecurringBillingProvider,
  sandboxSignature,
  foldBilling,
  type BillingEvent,
  type DunningPolicy,
  type Plan,
} from '../../packages/platform/src/index';

/**
 * WP5 / ADR-0014 — the sandbox provider and the append-only billing fold.
 *
 * The sandbox is a real runtime mode (used until a live merchant account exists), not a test double:
 * it deterministically stands in for the provider, moving no money and touching no network.
 * `foldBilling` reads a tenant's current billing state from its immutable history.
 */

const PLAN: Plan = {
  planId: 'standard', name: 'Standard', grants: ['loyalty', 'delivery'],
  limits: { lanes: 6 }, monthlyPriceMinor: 500_000,
};

describe('the sandbox provider sets up a mandate without touching money or card data', () => {
  const provider = new SandboxRecurringBillingProvider();

  it('creates an active, AFA-completed mandate with provider references only', async () => {
    const created = await provider.createSubscription({
      tenantId: 't-sre', plan: PLAN, rail: 'upi_autopay', anchorDay: 5,
      startsOn: '2026-09-05', preDebitNoticeHours: 24,
    });
    expect(created.mandate.status).toBe('active');
    expect(created.mandate.createdWithAfa).toBe(true);
    expect(created.providerRef.mandateRef).not.toBe('');
    expect(created.schedule.amountMinor).toBe(500_000);
    // No instrument detail is present anywhere — references only (hard rule #3).
    expect(JSON.stringify(created)).not.toMatch(/card_number|cvv|expiry/i);
  });

  it('verifies its own webhook signature and rejects a forged one', () => {
    const rawBody = JSON.stringify({ tenantId: 't-sre', outcome: 'succeeded' });
    expect(provider.verifyWebhook({ rawBody, signature: sandboxSignature(rawBody) })).toBe(true);
    expect(provider.verifyWebhook({ rawBody, signature: 'sandbox:forged' })).toBe(false);
  });

  it('parses a well-formed charge event and rejects a malformed one', () => {
    const ok = provider.parseChargeEvent(JSON.stringify({
      tenantId: 't-sre', subscriptionRef: 's', outcome: 'failed', chargeRef: 'c1', amountMinor: 500_000, at: '2026-10-05',
    }));
    expect(ok?.outcome).toBe('failed');
    expect(provider.parseChargeEvent('not json')).toBeUndefined();
    expect(provider.parseChargeEvent(JSON.stringify({ tenantId: 't', outcome: 'maybe' }))).toBeUndefined();
  });
});

describe('foldBilling reads current state from the append-only history', () => {
  const policy: DunningPolicy = { maxRetries: 3, suspendableGrants: ['loyalty', 'delivery'] };
  const started: BillingEvent = {
    kind: 'subscription_started', planId: 'standard', rail: 'upi_autopay',
    mandate: {
      mandateId: 'm', tenantId: 't-sre', rail: 'upi_autopay',
      providerRef: { customerRef: 'c', subscriptionRef: 's', mandateRef: 'u' },
      status: 'active', maxAmountMinor: 1_500_000, createdWithAfa: true, createdAt: '2026-09-05',
    },
    schedule: {
      tenantId: 't-sre', planId: 'standard', cadence: 'monthly', amountMinor: 500_000,
      anchorDay: 5, startsOn: '2026-09-05', preDebitNoticeHours: 24,
    },
    startedOn: '2026-09-05', by: 'u-owner',
  };

  it('returns undefined for a tenant that never subscribed', () => {
    expect(foldBilling({ tenantId: 't-sre', events: [], policy, asAt: '2026-09-20' })).toBeUndefined();
  });

  it('reports an active subscription with a next charge and current dunning', () => {
    const snap = foldBilling({ tenantId: 't-sre', events: [started], policy, asAt: '2026-09-20' });
    expect(snap?.planId).toBe('standard');
    expect(snap?.dunning.state).toBe('current');
    expect(snap?.nextCharge?.chargeOn).toBe('2026-10-05');
  });

  it('folds failed charges into a climbing dunning state, trading never stopping', () => {
    const fails: BillingEvent[] = [1, 2, 3, 4, 5].map((i) => ({
      kind: 'charge_recorded', outcome: 'failed', chargeRef: `f${i}`, amountMinor: 500_000, at: '2026-10-05',
    }));
    const snap = foldBilling({ tenantId: 't-sre', events: [started, ...fails], policy, asAt: '2026-10-06' });
    expect(snap?.dunning.state).toBe('suspended');
    expect(snap?.dunning.mayContinueTrading).toBe(true);
  });

  it('honours a cancellation, and has no next charge once the period has ended', () => {
    const cancelled: BillingEvent = { kind: 'subscription_cancelled', endsOn: '2026-10-05', by: 'u-owner', at: '2026-09-20' };
    const during = foldBilling({ tenantId: 't-sre', events: [started, cancelled], policy, asAt: '2026-09-25' });
    expect(during?.endsOn).toBe('2026-10-05');
    const after = foldBilling({ tenantId: 't-sre', events: [started, cancelled], policy, asAt: '2026-11-01' });
    expect(after?.nextCharge).toBeUndefined();
  });

  it('a re-subscribe after a lapse is a new fact — an earlier cancellation does not bleed into it', () => {
    const cancelled: BillingEvent = { kind: 'subscription_cancelled', endsOn: '2026-10-05', by: 'u-owner', at: '2026-09-20' };
    const restarted: BillingEvent = { ...started, startedOn: '2026-11-01' };
    const snap = foldBilling({ tenantId: 't-sre', events: [started, cancelled, restarted], policy, asAt: '2026-11-10' });
    expect(snap?.endsOn).toBeUndefined();
    expect(snap?.nextCharge).toBeDefined();
  });
});
