// Plans, entitlements and metering (M36-FR-01 / ADR-0003 / §35 / P-06).
//
// This is the commercial layer on top of the tenant foundation that has been in the code
// since Stage 5. `packages/tenant` already answers *"is this feature on for this tenant?"*.
// This module answers the harder commercial questions: **what did they buy, what are they
// using, and what happens at the edge of the plan.**
//
// The edge of the plan is where a product like this earns a bad reputation, and the way it
// happens is always the same: a shop hits its lane limit on the Saturday before Diwali and
// **the tills stop**. That is a commercial decision — "upgrade or stop trading" — being taken
// automatically, at the worst possible moment, by code that has no idea what is happening in
// the shop. So:
//
//   • **A LIMIT NEVER STOPS A SALE.** Exceeding a metered limit is *reported, invoiced and
//     escalated* — never enforced at the lane (P-01, hard rule #1). A vendor may withdraw a
//     service; a vendor's software may not close a shop on a Saturday.
//   • **AN ENTITLEMENT IS DEFAULT-OFF AND EXPLICIT.** A tenant gets what its plan grants
//     plus what it was explicitly given. There is no "probably fine" path.
//   • **DOWNGRADING NEVER SILENTLY DELETES.** Dropping a plan turns features off; it does
//     not remove the data behind them, because a tenant that upgrades again in March must
//     find its history intact.
//   • **METERING IS PER TENANT AND EXACT.** A usage figure that will appear on an invoice is
//     integer arithmetic over counted events, never an estimate.
//
// Pure and deterministic: the clock is injected, no I/O.

import type { FeatureKey } from '../../tenant/src/tenant';

export type MeteredDimension =
  | 'lanes'
  | 'branches'
  | 'named_users'
  | 'transactions_per_month'
  | 'storage_gb'
  | 'api_calls_per_month'
  | 'ai_tokens_per_month';

export interface Plan {
  readonly planId: string;
  readonly name: string;
  /** Features this plan grants. A tenant may hold more by explicit grant. */
  readonly grants: readonly FeatureKey[];
  /** Metered ceilings. An absent dimension is unmetered on this plan. */
  readonly limits: Partial<Readonly<Record<MeteredDimension, number>>>;
  readonly monthlyPriceMinor: number;
  /** Charge per unit above the limit, by dimension. Absent = not chargeable, only reported. */
  readonly overageMinor?: Partial<Readonly<Record<MeteredDimension, number>>>;
}

export interface TenantSubscription {
  readonly tenantId: string;
  readonly planId: string;
  readonly startedOn: string;
  /** Set when the tenant has given notice. Service continues until this date. */
  readonly endsOn?: string;
  /** Features granted outside the plan — a migration deal, a pilot, a goodwill gesture. */
  readonly extraGrants?: readonly FeatureKey[];
  /** Features suspended for non-payment. Reported, and never applied to core trading. */
  readonly suspendedGrants?: readonly FeatureKey[];
}

export type EntitlementSource = 'plan' | 'explicit_grant' | 'not_entitled' | 'suspended';

export interface EntitlementDecision {
  readonly tenantId: string;
  readonly feature: FeatureKey;
  readonly entitled: boolean;
  readonly source: EntitlementSource;
  readonly detail: string;
}

/**
 * Is this feature entitled for this tenant, and **why**?
 *
 * The `source` matters as much as the answer. "No" because the plan does not include it is a
 * sales conversation; "no" because billing suspended it is an accounts conversation; and a
 * support engineer who cannot tell them apart wastes an afternoon on the wrong one.
 *
 * Default-deny throughout: a feature nobody granted is off.
 */
export function checkEntitlement(input: {
  readonly subscription: TenantSubscription;
  readonly plan: Plan;
  readonly feature: FeatureKey;
}): EntitlementDecision {
  const base = { tenantId: input.subscription.tenantId, feature: input.feature };

  if ((input.subscription.suspendedGrants ?? []).includes(input.feature)) {
    return {
      ...base,
      entitled: false,
      source: 'suspended',
      detail: `"${input.feature}" is suspended on this account — that is a billing conversation, not a sales one`,
    };
  }
  if ((input.subscription.extraGrants ?? []).includes(input.feature)) {
    return {
      ...base,
      entitled: true,
      source: 'explicit_grant',
      detail: `"${input.feature}" granted to this tenant outside the ${input.plan.name} plan`,
    };
  }
  if (input.plan.grants.includes(input.feature)) {
    return {
      ...base,
      entitled: true,
      source: 'plan',
      detail: `"${input.feature}" is included in ${input.plan.name}`,
    };
  }
  return {
    ...base,
    entitled: false,
    source: 'not_entitled',
    detail: `"${input.feature}" is not in ${input.plan.name} — that is a sales conversation`,
  };
}

export interface UsageRecord {
  readonly tenantId: string;
  readonly dimension: MeteredDimension;
  /** Whole units. Integer, because this figure ends up on an invoice. */
  readonly units: number;
  readonly onDate: string;
}

export interface DimensionUsage {
  readonly dimension: MeteredDimension;
  readonly used: number;
  readonly limit: number | 'unmetered';
  readonly overBy: number;
  readonly overageMinor: number;
  /** True when the tenant should hear about it before the invoice does. */
  readonly notify: boolean;
  readonly detail: string;
}

export interface MeteringResult {
  readonly tenantId: string;
  readonly planId: string;
  readonly from: string;
  readonly to: string;
  readonly dimensions: readonly DimensionUsage[];
  readonly baseMinor: number;
  readonly overageMinor: number;
  readonly totalMinor: number;
  /** ALWAYS true. Nothing in this module can stop a tenant trading. */
  readonly mayContinueTrading: true;
  readonly detail: string;
}

/**
 * Meter a tenant's usage against its plan for a period.
 *
 * **`mayContinueTrading` is typed as `true`.** Not a boolean that happens to be true — the
 * type itself. There is no code path in this module, and no future edit to it, that can
 * return false and stop a shop trading, because a vendor's software closing a hypermarket on
 * the Saturday before Diwali is not a limit being enforced, it is a business being damaged
 * by its supplier.
 *
 * A peak dimension (lanes, branches, users) meters at its **highest** point in the period;
 * a volume dimension (transactions, API calls, tokens) meters at its **sum**. Metering a
 * peak as a sum would bill a shop 30× for the same four tills.
 */
const PEAK_DIMENSIONS: ReadonlySet<MeteredDimension> = new Set([
  'lanes',
  'branches',
  'named_users',
  'storage_gb',
]);

export function meterUsage(input: {
  readonly subscription: TenantSubscription;
  readonly plan: Plan;
  readonly usage: readonly UsageRecord[];
  readonly from: string;
  readonly to: string;
  /** Warn the tenant at this share of the limit, in basis points. Default 9,000 (90%). */
  readonly notifyAtBps?: number;
}): MeteringResult {
  const notifyAt = input.notifyAtBps ?? 9_000;
  const window = input.usage.filter(
    (u) =>
      u.tenantId === input.subscription.tenantId && u.onDate >= input.from && u.onDate <= input.to,
  );

  const measured = new Set<MeteredDimension>([
    ...window.map((u) => u.dimension),
    ...(Object.keys(input.plan.limits) as MeteredDimension[]),
  ]);

  const dimensions: DimensionUsage[] = [];
  let overageTotal = 0;

  for (const dimension of [...measured].sort()) {
    const rows = window.filter((u) => u.dimension === dimension);
    const used = PEAK_DIMENSIONS.has(dimension)
      ? rows.reduce((peak, r) => Math.max(peak, r.units), 0)
      : rows.reduce((sum, r) => sum + r.units, 0);

    const limitValue = input.plan.limits[dimension];
    const limit = limitValue === undefined ? ('unmetered' as const) : limitValue;
    const overBy = limit === 'unmetered' ? 0 : Math.max(0, used - limit);
    const rate = input.plan.overageMinor?.[dimension] ?? 0;
    const overageMinor = overBy * rate;
    overageTotal += overageMinor;

    const usedBps =
      limit === 'unmetered' || limit === 0
        ? 0
        : Number((BigInt(used) * 10_000n) / BigInt(limit));

    dimensions.push({
      dimension,
      used,
      limit,
      overBy,
      overageMinor,
      notify: overBy > 0 || usedBps >= notifyAt,
      detail:
        limit === 'unmetered'
          ? `${used} ${dimension.replace(/_/g, ' ')}, not metered on this plan`
          : overBy > 0
            ? rate > 0
              ? `${used} against a limit of ${limit} — ${overBy} over, charged at ${rate} each. Nothing is switched off`
              : `${used} against a limit of ${limit} — ${overBy} over. Reported for a conversation, not charged and NOT enforced`
            : usedBps >= notifyAt
              ? `${used} of ${limit} — ${(usedBps / 100).toFixed(0)}% of the plan, worth telling them before the invoice does`
              : `${used} of ${limit}`,
    });
  }

  const over = dimensions.filter((d) => d.overBy > 0);

  return {
    tenantId: input.subscription.tenantId,
    planId: input.plan.planId,
    from: input.from,
    to: input.to,
    dimensions,
    baseMinor: input.plan.monthlyPriceMinor,
    overageMinor: overageTotal,
    totalMinor: input.plan.monthlyPriceMinor + overageTotal,
    // The point of the whole module.
    mayContinueTrading: true,
    detail:
      over.length === 0
        ? `${input.plan.name}: ${input.plan.monthlyPriceMinor}, within every limit`
        : `${input.plan.name}: ${input.plan.monthlyPriceMinor} plus ${overageTotal} of overage across ${over.length} dimension(s) — the shop keeps trading and somebody has a conversation`,
  };
}

export type PlanChangeKind = 'upgrade' | 'downgrade' | 'same';

export interface PlanChangeResult {
  readonly tenantId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: PlanChangeKind;
  /** Features that switch off. The DATA behind them is never touched. */
  readonly featuresLost: readonly FeatureKey[];
  readonly featuresGained: readonly FeatureKey[];
  /** Dimensions where current usage already exceeds the new plan's limit. */
  readonly wouldExceed: readonly { readonly dimension: MeteredDimension; readonly used: number; readonly newLimit: number }[];
  readonly allowed: boolean;
  readonly detail: string;
}

/**
 * Assess a plan change **before** it happens.
 *
 * A downgrade is allowed even when current usage exceeds the new plan's limits — refusing it
 * traps a struggling tenant on a plan they cannot pay for, which helps nobody. What it does
 * instead is **say exactly what will happen**: which features go dark, and which limits they
 * are already over.
 *
 * **No feature loss deletes data.** A tenant who drops loyalty in January and takes it back in
 * March must find every point balance intact, because the alternative is a shop telling its
 * customers their points are gone.
 */
export function assessPlanChange(input: {
  readonly subscription: TenantSubscription;
  readonly current: Plan;
  readonly target: Plan;
  readonly currentUsage: readonly UsageRecord[];
  readonly asAt: string;
}): PlanChangeResult {
  const held = new Set([...input.current.grants, ...(input.subscription.extraGrants ?? [])]);
  const target = new Set([...input.target.grants, ...(input.subscription.extraGrants ?? [])]);

  const featuresLost = [...held].filter((f) => !target.has(f)).sort();
  const featuresGained = [...target].filter((f) => !held.has(f)).sort();

  const kind: PlanChangeKind =
    input.current.planId === input.target.planId
      ? 'same'
      : input.target.monthlyPriceMinor > input.current.monthlyPriceMinor
        ? 'upgrade'
        : 'downgrade';

  const latestByDimension = new Map<MeteredDimension, number>();
  for (const record of input.currentUsage.filter((u) => u.tenantId === input.subscription.tenantId)) {
    const seen = latestByDimension.get(record.dimension) ?? 0;
    latestByDimension.set(record.dimension, Math.max(seen, record.units));
  }

  const wouldExceed = (Object.keys(input.target.limits) as MeteredDimension[])
    .map((dimension) => ({
      dimension,
      used: latestByDimension.get(dimension) ?? 0,
      newLimit: input.target.limits[dimension]!,
    }))
    .filter((row) => row.used > row.newLimit)
    .sort((a, b) => a.dimension.localeCompare(b.dimension));

  return {
    tenantId: input.subscription.tenantId,
    from: input.current.planId,
    to: input.target.planId,
    kind,
    featuresLost,
    featuresGained,
    wouldExceed,
    // A downgrade is always permitted. Trapping a tenant on a plan they cannot pay for
    // helps nobody, least of all us.
    allowed: true,
    detail:
      featuresLost.length === 0 && wouldExceed.length === 0
        ? `${kind} to ${input.target.name}${featuresGained.length === 0 ? '' : `, adding ${featuresGained.join(', ')}`}`
        : `${kind} to ${input.target.name}: ${featuresLost.length} feature(s) switch OFF (${featuresLost.join(', ') || 'none'}) and ${wouldExceed.length} limit(s) are already exceeded. **No data is deleted** — take the plan back and the history is still there`,
  };
}

export type IsolationOutcome = 'allowed' | 'cross_tenant' | 'no_tenant_context';

export interface IsolationDecision<T> {
  readonly allowed: boolean;
  readonly outcome: IsolationOutcome;
  readonly rows: readonly T[];
  /** Cross-tenant access is a CRITICAL defect (§35), never a warning. */
  readonly criticalDefect: boolean;
  readonly detail: string;
}

/**
 * The last line of tenant isolation.
 *
 * Every query in the product is already `tenant_id`-scoped at the database, and the portals
 * scope from the session. This is the belt to those braces: a final assertion that a result
 * set about to leave the platform plane contains **nothing belonging to another tenant**.
 *
 * A cross-tenant row is reported as a **critical defect**, not a filtered row, because the
 * dangerous version of this bug is the one that silently returns fewer rows than expected and
 * nobody investigates. If it fires, something upstream is broken and must be found.
 */
export function assertTenantIsolation<T extends { readonly tenantId?: string }>(input: {
  readonly tenantId?: string;
  readonly rows: readonly T[];
  readonly what: string;
}): IsolationDecision<T> {
  if (input.tenantId === undefined || input.tenantId.trim() === '') {
    return {
      allowed: false,
      outcome: 'no_tenant_context',
      rows: [],
      criticalDefect: true,
      detail: `${input.what} was requested with NO tenant context — an unscoped query is how every one of these incidents starts`,
    };
  }

  const foreign = input.rows.filter((r) => r.tenantId !== undefined && r.tenantId !== input.tenantId);
  if (foreign.length > 0) {
    return {
      allowed: false,
      outcome: 'cross_tenant',
      rows: [],
      criticalDefect: true,
      detail: `${input.what} returned ${foreign.length} row(s) belonging to another tenant — this is a CRITICAL defect (§35), not a row to filter out, and something upstream is broken`,
    };
  }

  return {
    allowed: true,
    outcome: 'allowed',
    rows: input.rows,
    criticalDefect: false,
    detail: `${input.rows.length} row(s), all within ${input.tenantId}`,
  };
}
