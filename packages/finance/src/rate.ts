// Effective-dated GST rate resolution (roadmap v2.1 A6). GST rates change — the 2017 slabs, the GST 2.0
// slabs (0/5/18% + a 40% demerit rate) — and the rate that applies to a sale is the one in force on the
// TIME OF SUPPLY, not the invoice date and not today. Billing a September supply at August's rate (or
// vice versa across a rate change) is a real, common error at the boundary; this resolves it
// deterministically from a per-HSN effective-dated schedule.
//
// The slabs themselves are data, not logic — a schedule carries whatever rates apply and from when — so
// this engine never hard-codes a rate; it only picks the period in force. Pure and deterministic.

export interface GstRatePeriod {
  /** The date this rate takes effect, inclusive (YYYY-MM-DD). */
  readonly effectiveFrom: string;
  readonly rateBps: number;
}

export interface ResolvedGstRate {
  readonly rateBps: number;
  /** The effective-from date of the period that applied. */
  readonly effectiveFrom: string;
  readonly supplyDate: string;
}

export class InvalidRateSchedule extends Error {
  constructor(detail: string) {
    super(`Cannot resolve the GST rate: ${detail}`);
    this.name = 'InvalidRateSchedule';
  }
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

/**
 * Resolve the GST rate in force on the supply date (A6) from a per-HSN effective-dated schedule.
 *
 * Picks the latest period whose `effectiveFrom` is on or before the supply date — so a supply on the
 * day a new rate takes effect gets the NEW rate, and the day before gets the old one.
 *
 * @throws InvalidRateSchedule if the schedule is empty, carries a bad date / non-whole rate / duplicate
 *   effective date, or if the supply date falls before the earliest period (no rate is in force then —
 *   a gap that must be answered by extending the schedule, never by guessing a rate).
 */
export function resolveGstRate(input: {
  readonly schedule: readonly GstRatePeriod[];
  readonly supplyDate: string;
}): ResolvedGstRate {
  if (!Array.isArray(input.schedule) || input.schedule.length === 0) {
    throw new InvalidRateSchedule('the rate schedule is empty — there is nothing to resolve against');
  }
  if (!isDate(input.supplyDate)) {
    throw new InvalidRateSchedule('the supply date must be a valid YYYY-MM-DD');
  }
  const seen = new Set<string>();
  for (const p of input.schedule) {
    if (!isDate(p.effectiveFrom)) throw new InvalidRateSchedule(`a period has an invalid effective date (${String(p.effectiveFrom)})`);
    if (!Number.isInteger(p.rateBps) || p.rateBps < 0) throw new InvalidRateSchedule(`a period has an invalid rate (${String(p.rateBps)} bps)`);
    if (seen.has(p.effectiveFrom)) throw new InvalidRateSchedule(`two rates share the effective date ${p.effectiveFrom} — the schedule is ambiguous`);
    seen.add(p.effectiveFrom);
  }

  // Latest period effective on or before the supply date.
  const applicable = [...input.schedule]
    .filter((p) => p.effectiveFrom <= input.supplyDate) // ISO YYYY-MM-DD compares lexicographically = chronologically
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const period = applicable[applicable.length - 1];
  if (period === undefined) {
    const earliest = [...input.schedule].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0]!;
    throw new InvalidRateSchedule(`the supply date ${input.supplyDate} is before the earliest rate (${earliest.effectiveFrom}) — no rate is in force then`);
  }

  return { rateBps: period.rateBps, effectiveFrom: period.effectiveFrom, supplyDate: input.supplyDate };
}
