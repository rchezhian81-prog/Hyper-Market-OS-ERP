// Points expiry (M17-FR-01 · D07-FR-03 · owner decision OB-295, 23 Oct 2026: "points expire N months after they are
// earned … OFF until the owner enters the number"; the CA confirms how expired points are accounted for).
//
// Points are kept in LOTS: every movement that adds points starts a lot dated when the points arrived. Points that leave
// (spent at the till or in the app, taken back on a return) leave the OLDEST lots first. A lot still holding points N
// months after it arrived expires — what is left of it, never more, and never twice: an expiry is a new movement on the
// member's append-only ledger, keyed on the lot, so a second run finds it already done. Nothing is overwritten (hard
// rule #2). With no N set, nothing ever expires.
//
// Pure and deterministic: the run's instant is passed in.

export interface LedgerMovement {
  readonly movementId: string;
  readonly delta: number;
  readonly reason: string;
  readonly at: string;
  /** For an expiry movement: which lot it expired (`lot:<movementId>`). */
  readonly sourceRef?: string | null;
}

export interface DueExpiry {
  /** The movement that started the lot. */
  readonly lotMovementId: string;
  readonly earnedAt: string;
  /** When the lot expired (N months after it arrived). */
  readonly expiresAt: string;
  readonly points: number;
  /** The id the expiry movement is recorded under — the same however many times the run is repeated. */
  readonly expiryMovementId: string;
}

export interface UpcomingExpiry { readonly lotMovementId: string; readonly expiresAt: string; readonly points: number }

export const MAX_EXPIRY_MONTHS = 120;
export const expiryMovementIdFor = (lotMovementId: string): string => `expiry-${lotMovementId}`;
export const expirySourceRef = (lotMovementId: string): string => `lot:${lotMovementId}`;

/** The same instant N calendar months later (the day clamped to the month's end, UTC). */
export function addMonths(at: string, months: number): string {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.toISOString();
}

interface Lot { readonly movementId: string; readonly earnedAt: string; readonly expiresAt: string; remaining: number; expired: boolean }

/**
 * Walk the member's ledger in time order. Points added start lots; points leaving (other than an expiry) come off the
 * oldest lot that still holds any; a lot's deadline passing expires what is left of it — counted from the recorded expiry
 * when there is one, otherwise DUE now if the deadline is on or before `asOf`. Returns what is due, and what will expire
 * next (for the member's own screen).
 */
export function pointsExpiry(input: {
  readonly movements: readonly LedgerMovement[];
  readonly expiryMonths: number;
  readonly asOf: string;
}): { readonly due: readonly DueExpiry[]; readonly upcoming: readonly UpcomingExpiry[]; readonly balance: number } {
  const months = Math.trunc(input.expiryMonths);
  const balance = input.movements.reduce((n, m) => n + m.delta, 0);
  if (!(months >= 1 && months <= MAX_EXPIRY_MONTHS)) return { due: [], upcoming: [], balance };
  const recorded = new Map<string, number>();
  for (const m of input.movements) {
    if (m.reason === 'expiry' && typeof m.sourceRef === 'string' && m.sourceRef.startsWith('lot:')) recorded.set(m.sourceRef.slice(4), -m.delta);
  }
  const ordered = [...input.movements].filter((m) => m.reason !== 'expiry').sort((a, b) => a.at.localeCompare(b.at) || a.movementId.localeCompare(b.movementId));
  const lots: Lot[] = [];
  const due: DueExpiry[] = [];
  const expireUpTo = (instant: string): void => {
    for (const lot of lots) {
      if (lot.expired || lot.expiresAt > instant) continue;
      lot.expired = true;
      const already = recorded.get(lot.movementId);
      if (already !== undefined) { lot.remaining = Math.max(0, lot.remaining - already); continue; }
      if (lot.remaining > 0 && lot.expiresAt <= input.asOf) {
        due.push({ lotMovementId: lot.movementId, earnedAt: lot.earnedAt, expiresAt: lot.expiresAt, points: lot.remaining, expiryMovementId: expiryMovementIdFor(lot.movementId) });
      }
      lot.remaining = 0;
    }
  };
  for (const m of ordered) {
    expireUpTo(m.at);
    if (m.delta > 0) {
      lots.push({ movementId: m.movementId, earnedAt: m.at, expiresAt: addMonths(m.at, months), remaining: m.delta, expired: false });
      continue;
    }
    let out = -m.delta;
    for (const lot of lots) {
      if (out <= 0) break;
      if (lot.expired || lot.remaining <= 0) continue;
      const take = Math.min(lot.remaining, out);
      lot.remaining -= take;
      out -= take;
    }
  }
  expireUpTo(input.asOf);
  const upcoming = lots.filter((l) => !l.expired && l.remaining > 0).map((l) => ({ lotMovementId: l.movementId, expiresAt: l.expiresAt, points: l.remaining }))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  return { due, upcoming, balance };
}
