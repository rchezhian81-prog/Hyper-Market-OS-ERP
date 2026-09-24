// Effective-dated serviceability (M18-FR-01 / D08 · roadmap §5). The serviceable radius, the delivery
// fee, the free-delivery threshold and the minimum order are OWNER decisions that change — a festival
// week widens the radius, a fuel rise lifts the fee, a new dark store shifts the free threshold — and the
// policy that applies to an order is the one in force ON THAT DAY, not today's. This resolves it
// deterministically from a per-tenant effective-dated schedule, exactly as `resolveGstRate` resolves a
// tax rate: the store never hard-codes the numbers, it picks the period in force.
//
// Two deliberate choices make this shippable BEFORE the owner has settled his real radii and slots
// (his explicit instruction — "do not require my final production radii to implement this"):
//
//   • Until a schedule is configured — an empty schedule, or an order dated before the first period —
//     the D08 DEFAULT applies (a 10-km radius, no minimum, no fee). The store is serviceable on sensible
//     defaults from day one; the owner replaces them by adding a period, no code change.
//   • A MALFORMED period is a visible config error, not a silent default — a bad date or a negative radius
//     throws, because a serviceability policy nobody can trust is worse than none (P-08).
//
// Pure and deterministic — no clock, no I/O. Composes with `checkServiceability`, which takes the resolved
// policy and answers whether one address, on one order, is serviceable.

import type { ServiceabilityPolicy } from './checkout';

/**
 * The D08 default serviceability policy — in force until the owner configures real radii/slots/fees.
 * A 10-km radius, no minimum order, no delivery fee. Frozen so a caller cannot mutate the shared default.
 */
export const DEFAULT_SERVICEABILITY_POLICY: ServiceabilityPolicy = Object.freeze({ radiusMetres: 10_000 });

export interface ServiceabilityPeriod {
  /** The date this policy takes effect, inclusive (YYYY-MM-DD). */
  readonly effectiveFrom: string;
  readonly policy: ServiceabilityPolicy;
}

export type ServiceabilitySource = 'scheduled' | 'default';

export interface ResolvedServiceabilityPolicy {
  readonly policy: ServiceabilityPolicy;
  /** `scheduled` when a configured period applied; `default` when the D08 default was used. */
  readonly source: ServiceabilitySource;
  /** The effective-from of the period that applied, or `null` when the default was used. */
  readonly effectiveFrom: string | null;
  readonly on: string;
}

export class InvalidServiceabilitySchedule extends Error {
  constructor(detail: string) {
    super(`Cannot resolve the serviceability policy: ${detail}`);
    this.name = 'InvalidServiceabilitySchedule';
  }
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

const isNonNegIntOrAbsent = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

/** A serviceability policy is money and metres — every present field must be a whole, non-negative number. */
function assertPolicy(policy: ServiceabilityPolicy, effectiveFrom: string): void {
  const p = policy as Record<string, unknown>;
  for (const field of ['radiusMetres', 'minimumOrderMinor', 'deliveryFeeMinor', 'freeDeliveryAboveMinor'] as const) {
    if (!isNonNegIntOrAbsent(p[field])) {
      throw new InvalidServiceabilitySchedule(`period ${effectiveFrom} has an invalid ${field} (${String(p[field])}) — it must be a whole, non-negative number`);
    }
  }
}

/**
 * Resolve the serviceability policy in force on a date, from a per-tenant effective-dated schedule.
 *
 * Picks the latest period whose `effectiveFrom` is on or before `on` — so an order on the day a new
 * policy takes effect gets the NEW policy, and the day before gets the old one (the same boundary rule
 * as GST). With no configured period in force (empty schedule, or `on` before the earliest), the D08
 * default applies, so the store is serviceable before the owner has set his real numbers.
 *
 * @throws InvalidServiceabilitySchedule if `on` is not a valid date, or a period has a bad date, a
 *   duplicate effective date, or a negative/non-whole field — a config error is surfaced, never guessed.
 */
export function resolveServiceabilityPolicy(input: {
  readonly schedule: readonly ServiceabilityPeriod[];
  readonly on: string;
}): ResolvedServiceabilityPolicy {
  if (!isDate(input.on)) {
    throw new InvalidServiceabilitySchedule('the date to resolve on must be a valid YYYY-MM-DD');
  }
  const schedule = Array.isArray(input.schedule) ? input.schedule : [];
  const seen = new Set<string>();
  for (const period of schedule) {
    if (!isDate(period.effectiveFrom)) throw new InvalidServiceabilitySchedule(`a period has an invalid effective date (${String(period.effectiveFrom)})`);
    if (seen.has(period.effectiveFrom)) throw new InvalidServiceabilitySchedule(`two periods share the effective date ${period.effectiveFrom} — the schedule is ambiguous`);
    seen.add(period.effectiveFrom);
    assertPolicy(period.policy, period.effectiveFrom);
  }

  const applicable = schedule
    .filter((p) => p.effectiveFrom <= input.on) // ISO YYYY-MM-DD compares lexicographically = chronologically
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const period = applicable[applicable.length - 1];
  if (period === undefined) {
    // No configured policy in force yet — ship on the D08 default; the owner replaces it by adding a period.
    return { policy: DEFAULT_SERVICEABILITY_POLICY, source: 'default', effectiveFrom: null, on: input.on };
  }
  return { policy: period.policy, source: 'scheduled', effectiveFrom: period.effectiveFrom, on: input.on };
}
