// Data-freshness indicator (M29-FR-01 / §31 / P-08) — every dashboard number must
// carry how current it is: offline or lagging data is shown as STALE or MISSING,
// never as fresh. This classifier turns a last-synced timestamp into an honest
// freshness state against an as-of moment and a staleness threshold. Pure and
// deterministic (the caller passes `asOf`; no clock).

export type FreshnessState = 'fresh' | 'stale' | 'missing';

export interface Freshness {
  readonly lastSyncedAt: string | null;
  readonly asOf: string;
  /** Age of the data in seconds (null when never synced). */
  readonly ageSeconds: number | null;
  readonly state: FreshnessState;
}

export class InvalidFreshnessTimeError extends Error {
  constructor(which: string) {
    super(`Freshness ${which} must be a valid ISO-8601 timestamp.`);
    this.name = 'InvalidFreshnessTimeError';
  }
}

/**
 * Classify data freshness. `missing` when never synced; `stale` when the data is
 * older than `staleAfterSeconds`; otherwise `fresh`. Never reports stale/missing
 * data as fresh (P-08).
 */
export function freshness(
  lastSyncedAt: string | null,
  asOf: string,
  staleAfterSeconds: number,
): Freshness {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) throw new InvalidFreshnessTimeError('asOf');

  if (lastSyncedAt === null) {
    return { lastSyncedAt: null, asOf, ageSeconds: null, state: 'missing' };
  }
  const syncedMs = Date.parse(lastSyncedAt);
  if (Number.isNaN(syncedMs)) throw new InvalidFreshnessTimeError('lastSyncedAt');

  const ageSeconds = Math.max(0, Math.round((asOfMs - syncedMs) / 1000));
  return {
    lastSyncedAt,
    asOf,
    ageSeconds,
    state: ageSeconds > staleAfterSeconds ? 'stale' : 'fresh',
  };
}
