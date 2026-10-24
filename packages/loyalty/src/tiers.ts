// Loyalty tiers (M17-FR-01 · D07-FR-03 · owner decision OB-295, 23 Oct 2026: "tiers by 12-month spend, each with a points
// multiplier … OFF until the owner enters the numbers").
//
// A member's tier is worked out, never stored: it is the highest tier whose qualifying spend their own spend in the 12
// months before a bill reaches. So a member who spends less drops a tier by themselves (the "downgrade"), and nobody can
// be put in a tier by hand. Each tier multiplies the points the owner's base rule earns. With no tiers set, every member
// earns the base rule — the screens say "not set", never a made-up ladder.
//
// Pure and deterministic: no clock, no I/O. Money in whole paise; the multiplier in basis points (10 000 = 1×).

export interface LoyaltyTier {
  readonly tierId: string;
  /** What the member and the desk read, in English — and Tamil where the owner gave it. */
  readonly name: string;
  readonly nameTa?: string;
  /** The member's spend in the last 12 months (paise) that puts them in this tier. */
  readonly minSpend12mMinor: number;
  /** Points multiplier in basis points: 10 000 = 1×, 15 000 = 1.5×. Never below 1× — a tier never earns less. */
  readonly multiplierBps: number;
}

/** The bounds the screen and the server both hold (one rule). */
export const TIER_LIMITS = Object.freeze({ maxTiers: 6, minMultiplierBps: 10_000, maxMultiplierBps: 100_000, maxSpendMinor: 1_000_000_000_00 });

export type TierProblem =
  | 'not_a_list' | 'too_many_tiers' | 'tier_unreadable' | 'tier_id_repeated' | 'name_repeated'
  | 'thresholds_not_rising' | 'multiplier_out_of_range' | 'multipliers_not_rising';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Read the owner's tier ladder: up to six tiers, each with an id, a name, a whole-paise qualifying spend and a multiplier
 * from 1× to 10×; thresholds strictly rising, multipliers never falling. An EMPTY list is valid and means "tiers off".
 */
export function readTiers(raw: unknown): { readonly ok: true; readonly tiers: readonly LoyaltyTier[] } | { readonly ok: false; readonly problem: TierProblem; readonly detail: string } {
  if (!Array.isArray(raw)) return { ok: false, problem: 'not_a_list', detail: 'Tiers are a list: [{ tierId, name, nameTa?, minSpend12mMinor, multiplierBps }].' };
  if (raw.length > TIER_LIMITS.maxTiers) return { ok: false, problem: 'too_many_tiers', detail: `At most ${TIER_LIMITS.maxTiers} tiers.` };
  const tiers: LoyaltyTier[] = [];
  for (const t of raw) {
    const o = (t ?? {}) as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    const nameTa = typeof o['nameTa'] === 'string' ? o['nameTa'].trim() : '';
    if (typeof o['tierId'] !== 'string' || !ID.test(o['tierId']) || name === '' || name.length > 40 || nameTa.length > 40
      || !Number.isSafeInteger(o['minSpend12mMinor']) || (o['minSpend12mMinor'] as number) < 0 || (o['minSpend12mMinor'] as number) > TIER_LIMITS.maxSpendMinor
      || !Number.isSafeInteger(o['multiplierBps'])) {
      return { ok: false, problem: 'tier_unreadable', detail: 'Each tier needs a short id (a–z, 0–9), a name (up to 40 letters), the 12-month spend in whole paise, and a whole multiplier in basis points.' };
    }
    const bps = o['multiplierBps'] as number;
    if (bps < TIER_LIMITS.minMultiplierBps || bps > TIER_LIMITS.maxMultiplierBps) {
      return { ok: false, problem: 'multiplier_out_of_range', detail: `A multiplier is from 1× (10000) to 10× (100000); ${bps} is outside that.` };
    }
    tiers.push({ tierId: o['tierId'] as string, name, ...(nameTa === '' ? {} : { nameTa }), minSpend12mMinor: o['minSpend12mMinor'] as number, multiplierBps: bps });
  }
  if (new Set(tiers.map((t) => t.tierId)).size !== tiers.length) return { ok: false, problem: 'tier_id_repeated', detail: 'Each tier needs its own id.' };
  if (new Set(tiers.map((t) => t.name.toLowerCase())).size !== tiers.length) return { ok: false, problem: 'name_repeated', detail: 'Each tier needs its own name.' };
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i]!.minSpend12mMinor <= tiers[i - 1]!.minSpend12mMinor) return { ok: false, problem: 'thresholds_not_rising', detail: 'List the tiers from the lowest spend to the highest; each needs more spend than the one before.' };
    if (tiers[i]!.multiplierBps < tiers[i - 1]!.multiplierBps) return { ok: false, problem: 'multipliers_not_rising', detail: 'A higher tier never earns a smaller multiplier than a lower one.' };
  }
  return { ok: true, tiers };
}

export interface TierStanding {
  /** The tier the spend reaches, or null below the lowest (or with no tiers set). */
  readonly tier: LoyaltyTier | null;
  readonly multiplierBps: number;
  readonly spend12mMinor: number;
  /** The next tier up and how much more spend reaches it — absent at the top or with no tiers. */
  readonly next?: { readonly tier: LoyaltyTier; readonly moreSpendMinor: number };
  readonly tiersSet: boolean;
}

/** The tier a 12-month spend reaches. No tiers set → no tier, base points (1×). */
export function tierFor(tiers: readonly LoyaltyTier[], spend12mMinor: number): TierStanding {
  const spend = Math.max(0, Math.trunc(spend12mMinor));
  let tier: LoyaltyTier | null = null;
  for (const t of tiers) if (spend >= t.minSpend12mMinor) tier = t;
  const nextTier = tiers.find((t) => t.minSpend12mMinor > spend);
  return {
    tier, multiplierBps: tier?.multiplierBps ?? 10_000, spend12mMinor: spend, tiersSet: tiers.length > 0,
    ...(nextTier === undefined ? {} : { next: { tier: nextTier, moreSpendMinor: nextTier.minSpend12mMinor - spend } }),
  };
}

/** Points after a tier's multiplier — whole points, rounded down (a fraction of a point is never given). */
export function withMultiplier(basePoints: number, multiplierBps: number): number {
  if (!Number.isSafeInteger(basePoints) || basePoints <= 0) return 0;
  return Number((BigInt(basePoints) * BigInt(Math.max(10_000, multiplierBps))) / 10_000n);
}

/** The window a tier is judged over: the 12 months before `at` (from the same instant a year earlier, exclusive of `at`). */
export function twelveMonthsBefore(at: string): { readonly from: string; readonly to: string } {
  const d = new Date(at);
  const from = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  return { from: from.toISOString(), to: d.toISOString() };
}
