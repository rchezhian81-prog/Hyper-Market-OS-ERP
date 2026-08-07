import { describe, it, expect } from 'vitest';
import * as platform from '../../packages/platform/src/index';
import {
  checkEntitlement,
  meterUsage,
  assessPlanChange,
  assertTenantIsolation,
  type Plan,
  type TenantSubscription,
  type UsageRecord,
} from '../../packages/platform/src/plans';

// M36-FR-01 acceptance: "no query returns another tenant's data; a tenant sees only its
// entitled modules; usage is metered per tenant."

const STANDARD: Plan = {
  planId: 'standard',
  name: 'Standard',
  grants: ['loyalty', 'delivery'],
  limits: { lanes: 4, branches: 1, transactions_per_month: 60_000 },
  monthlyPriceMinor: 1_500_000,
  overageMinor: { lanes: 300_000 },
};

const GROWTH: Plan = {
  planId: 'growth',
  name: 'Growth',
  grants: ['loyalty', 'delivery', 'customer_app', 'b2b'],
  limits: { lanes: 12, branches: 5, transactions_per_month: 250_000 },
  monthlyPriceMinor: 4_000_000,
  overageMinor: { lanes: 250_000 },
};

const sub = (over: Partial<TenantSubscription> = {}): TenantSubscription => ({
  tenantId: 't-sre',
  planId: 'standard',
  startedOn: '2026-01-01',
  ...over,
});

describe('an entitlement says WHY, not just yes or no (M36-FR-01)', () => {
  it('grants what the plan includes', () => {
    const d = checkEntitlement({ subscription: sub(), plan: STANDARD, feature: 'loyalty' });
    expect(d.entitled).toBe(true);
    expect(d.source).toBe('plan');
  });

  it('denies by default — a feature nobody granted is off', () => {
    const d = checkEntitlement({ subscription: sub(), plan: STANDARD, feature: 'b2b' });
    expect(d.entitled).toBe(false);
    expect(d.source).toBe('not_entitled');
    // The source matters: a support engineer who cannot tell "not sold" from "not paid"
    // wastes an afternoon on the wrong conversation.
    expect(d.detail).toContain('a sales conversation');
  });

  it('honours a grant made outside the plan', () => {
    const d = checkEntitlement({
      subscription: sub({ extraGrants: ['b2b'] }), plan: STANDARD, feature: 'b2b',
    });
    expect(d.source).toBe('explicit_grant');
  });

  it('separates SUSPENDED from not-entitled', () => {
    const d = checkEntitlement({
      subscription: sub({ extraGrants: ['b2b'], suspendedGrants: ['b2b'] }),
      plan: STANDARD, feature: 'b2b',
    });
    expect(d.entitled).toBe(false);
    expect(d.source).toBe('suspended');
    expect(d.detail).toContain('a billing conversation');
  });
});

const usage = (over: Partial<UsageRecord>): UsageRecord => ({
  tenantId: 't-sre', dimension: 'lanes', units: 4, onDate: '2026-07-15', ...over,
});

describe('a metered limit is INVOICED, never enforced at the lane (P-01)', () => {
  const period = { from: '2026-07-01', to: '2026-07-31' };

  it('lets a tenant keep trading past every limit', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [usage({ units: 7 }), usage({ dimension: 'transactions_per_month', units: 90_000 })],
    });
    // The type itself is `true`. Nothing here can close a shop on a Saturday.
    expect(result.mayContinueTrading).toBe(true);
    expect(result.detail).toContain('the shop keeps trading');
  });

  it('charges overage exactly where the plan prices it', () => {
    const result = meterUsage({ subscription: sub(), plan: STANDARD, ...period, usage: [usage({ units: 7 })] });
    const lanes = result.dimensions.find((d) => d.dimension === 'lanes');
    expect(lanes?.overBy).toBe(3);
    expect(lanes?.overageMinor).toBe(900_000);
    expect(result.totalMinor).toBe(1_500_000 + 900_000);
  });

  it('reports an unpriced overage without charging for it', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [usage({ dimension: 'transactions_per_month', units: 90_000 })],
    });
    const tx = result.dimensions.find((d) => d.dimension === 'transactions_per_month');
    expect(tx?.overBy).toBe(30_000);
    expect(tx?.overageMinor).toBe(0);
    expect(tx?.detail).toContain('NOT enforced');
  });

  it('meters a PEAK dimension at its peak, not its sum', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [
        usage({ units: 4, onDate: '2026-07-01' }),
        usage({ units: 4, onDate: '2026-07-02' }),
        usage({ units: 4, onDate: '2026-07-03' }),
      ],
    });
    // Metering four tills over three days as twelve would bill a shop 30x for the same lanes.
    expect(result.dimensions.find((d) => d.dimension === 'lanes')?.used).toBe(4);
  });

  it('meters a VOLUME dimension at its sum', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [
        usage({ dimension: 'transactions_per_month', units: 20_000, onDate: '2026-07-01' }),
        usage({ dimension: 'transactions_per_month', units: 25_000, onDate: '2026-07-15' }),
      ],
    });
    expect(result.dimensions.find((d) => d.dimension === 'transactions_per_month')?.used).toBe(45_000);
  });

  it('warns before the invoice does', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [usage({ dimension: 'transactions_per_month', units: 55_000 })],
    });
    const tx = result.dimensions.find((d) => d.dimension === 'transactions_per_month');
    expect(tx?.overBy).toBe(0);
    expect(tx?.notify).toBe(true);
    expect(tx?.detail).toContain('before the invoice does');
  });

  it('never counts another tenant\'s usage', () => {
    const result = meterUsage({
      subscription: sub(), plan: STANDARD, ...period,
      usage: [usage({ units: 4 }), usage({ tenantId: 't-other', units: 40 })],
    });
    expect(result.dimensions.find((d) => d.dimension === 'lanes')?.used).toBe(4);
  });

  it('exposes NO function that could suspend trading', () => {
    // Absence as a control: there is nothing here to wire into a "stop selling" path.
    const named = Object.keys(platform);
    expect(named).not.toContain('suspendTrading');
    expect(named).not.toContain('enforceLimit');
    expect(named).not.toContain('lockTenant');
  });
});

describe('a downgrade switches features off and DELETES NOTHING', () => {
  it('names exactly what goes dark and what limits are already exceeded', () => {
    const result = assessPlanChange({
      subscription: sub({ planId: 'growth' }), current: GROWTH, target: STANDARD,
      currentUsage: [usage({ units: 9 }), usage({ dimension: 'branches', units: 3 })],
      asAt: '2026-08-04',
    });
    expect(result.kind).toBe('downgrade');
    expect(result.featuresLost).toEqual(['b2b', 'customer_app']);
    expect(result.wouldExceed.map((w) => w.dimension)).toEqual(['branches', 'lanes']);
    expect(result.detail).toContain('**No data is deleted**');
  });

  it('permits the downgrade anyway — trapping a tenant helps nobody', () => {
    const result = assessPlanChange({
      subscription: sub({ planId: 'growth' }), current: GROWTH, target: STANDARD,
      currentUsage: [usage({ units: 12 })], asAt: '2026-08-04',
    });
    expect(result.allowed).toBe(true);
  });

  it('names what an upgrade adds', () => {
    const result = assessPlanChange({
      subscription: sub(), current: STANDARD, target: GROWTH, currentUsage: [], asAt: '2026-08-04',
    });
    expect(result.kind).toBe('upgrade');
    expect(result.featuresGained).toEqual(['b2b', 'customer_app']);
    expect(result.featuresLost).toEqual([]);
  });

  it('keeps an explicit grant across a plan change', () => {
    const result = assessPlanChange({
      subscription: sub({ planId: 'growth', extraGrants: ['b2b'] }),
      current: GROWTH, target: STANDARD, currentUsage: [], asAt: '2026-08-04',
    });
    expect(result.featuresLost).toEqual(['customer_app']);
  });
});

describe('cross-tenant access is a CRITICAL DEFECT, not a filtered row (§35)', () => {
  const rows = [
    { id: 'a', tenantId: 't-sre' },
    { id: 'b', tenantId: 't-sre' },
  ];

  it('passes a clean result set through', () => {
    const d = assertTenantIsolation({ tenantId: 't-sre', rows, what: 'sales' });
    expect(d.allowed).toBe(true);
    expect(d.rows).toHaveLength(2);
  });

  it('REFUSES the whole result set when one foreign row appears', () => {
    const d = assertTenantIsolation({
      tenantId: 't-sre', rows: [...rows, { id: 'c', tenantId: 't-other' }], what: 'sales',
    });
    expect(d.allowed).toBe(false);
    expect(d.outcome).toBe('cross_tenant');
    expect(d.criticalDefect).toBe(true);
    // Filtering it out silently is the version of this bug nobody ever investigates.
    expect(d.rows).toEqual([]);
    expect(d.detail).toContain('something upstream is broken');
  });

  it('refuses an unscoped query outright', () => {
    const d = assertTenantIsolation({ rows, what: 'sales' });
    expect(d.outcome).toBe('no_tenant_context');
    expect(d.criticalDefect).toBe(true);
    expect(d.detail).toContain('how every one of these incidents starts');
  });

  it('treats an empty tenant id as no context', () => {
    expect(assertTenantIsolation({ tenantId: '   ', rows, what: 'sales' }).outcome).toBe('no_tenant_context');
  });
});
