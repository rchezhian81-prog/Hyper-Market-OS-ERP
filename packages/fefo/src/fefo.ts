// FEFO allocation & expiry action list (M10-FR-01) — stop money leaking to expiry
// and protect customers: sell OLDEST-first (First-Expiry-First-Out) and never sell
// expired or recall-blocked stock. Allocation walks batches by earliest expiry, so
// near-expiry stock goes out first; expired stock is excluded (it is not sellable —
// M08-FR-02), as is quarantined/damaged or recall-blocked stock (the recall block
// is honoured even offline — M10-FR-04). The expiry action list flags what to mark
// down (near expiry) or dispose (expired). Pure and deterministic — no clock, the
// caller passes `asOf` — so FEFO and the expiry list compute identically at the edge
// from the cached ledger (M10-FR-01 offline rule). Composes only date maths.

/** Stock states that can be sold (mirror of the enums; on_hand only). */
type SellableState = 'on_hand';

export interface Batch {
  readonly batchId: string;
  readonly productId: string;
  /** Available quantity in this batch (whole units). */
  readonly qty: number;
  /** Expiry date, "YYYY-MM-DD" (or ISO UTC). The date is the last sellable day. */
  readonly expiry: string;
  /** Stock state; anything other than 'on_hand' is not sellable. Default on_hand. */
  readonly state?: string;
  /** A recall-blocked batch can never be sold (M10-FR-04), even offline. */
  readonly recallBlocked?: boolean;
}

export interface FefoAllocation {
  readonly batchId: string;
  readonly qty: number;
  readonly expiry: string;
}

export interface FefoResult {
  readonly requiredQty: number;
  /** Batches drawn from, earliest expiry first. */
  readonly allocated: readonly FefoAllocation[];
  readonly allocatedQty: number;
  /** requiredQty − allocatedQty (0 when fully met). */
  readonly shortfallQty: number;
  readonly fullyAllocated: boolean;
}

export type ExpiryStatus = 'expired' | 'near_expiry';
export type ExpiryAction = 'dispose' | 'markdown';

export interface ExpiryActionItem {
  readonly batchId: string;
  readonly productId: string;
  readonly expiry: string;
  readonly qty: number;
  readonly status: ExpiryStatus;
  /** expired → dispose; near_expiry → markdown. */
  readonly action: ExpiryAction;
  /** Whole days until expiry (negative if already expired). */
  readonly daysToExpiry: number;
}

export class InvalidFefoRequestError extends Error {
  constructor(detail: string) {
    super(`Invalid FEFO request: ${detail}.`);
    this.name = 'InvalidFefoRequestError';
  }
}

const DAY_MS = 86_400_000;

function dayNumber(dateStr: string): number {
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) {
    throw new InvalidFefoRequestError(`unparseable date "${dateStr}"`);
  }
  return Math.floor(ms / DAY_MS);
}

/** Whole days from `asOf` to `expiry` (negative when expired). */
function daysBetween(asOf: string, expiry: string): number {
  return dayNumber(expiry) - dayNumber(asOf);
}

/** A batch is expired when its expiry date is strictly before `asOf`. */
export function isExpired(batch: Batch, asOf: string): boolean {
  return daysBetween(asOf, batch.expiry) < 0;
}

/** Sellable = on-hand, not recall-blocked, not expired, and has quantity. */
export function isSellable(batch: Batch, asOf: string): boolean {
  const state: SellableState | string = batch.state ?? 'on_hand';
  return state === 'on_hand' && !batch.recallBlocked && batch.qty > 0 && !isExpired(batch, asOf);
}

/**
 * Allocate `requiredQty` of a product across its batches First-Expiry-First-Out.
 * Only sellable batches are used (expired/recalled/quarantined excluded), earliest
 * expiry first (ties broken by batchId for determinism). Reports any shortfall
 * honestly rather than over-allocating.
 */
export function allocateFefo(
  batches: readonly Batch[],
  productId: string,
  requiredQty: number,
  asOf: string,
): FefoResult {
  if (!Number.isSafeInteger(requiredQty) || requiredQty < 0) {
    throw new InvalidFefoRequestError(`requiredQty must be an integer >= 0, got ${requiredQty}`);
  }

  const sellable = batches
    .filter((b) => b.productId === productId && isSellable(b, asOf))
    .sort((a, b) => {
      const byExpiry = dayNumber(a.expiry) - dayNumber(b.expiry);
      if (byExpiry !== 0) return byExpiry;
      return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
    });

  const allocated: FefoAllocation[] = [];
  let remaining = requiredQty;
  for (const batch of sellable) {
    if (remaining <= 0) break;
    const take = Math.min(batch.qty, remaining);
    allocated.push({ batchId: batch.batchId, qty: take, expiry: batch.expiry });
    remaining -= take;
  }

  const allocatedQty = requiredQty - remaining;
  return {
    requiredQty,
    allocated,
    allocatedQty,
    shortfallQty: remaining,
    fullyAllocated: remaining === 0,
  };
}

/**
 * Produce the expiry action list: every on-hand batch that is expired (→ dispose)
 * or within `nearExpiryDays` of expiry (→ markdown), earliest expiry first. Batches
 * that are already non-sellable for other reasons (quarantine/damaged/recalled) are
 * not listed here — this list drives markdown/disposal of sellable stock.
 */
export function expiryActions(
  batches: readonly Batch[],
  asOf: string,
  nearExpiryDays: number,
): ExpiryActionItem[] {
  if (!Number.isSafeInteger(nearExpiryDays) || nearExpiryDays < 0) {
    throw new InvalidFefoRequestError(`nearExpiryDays must be an integer >= 0, got ${nearExpiryDays}`);
  }

  const items: ExpiryActionItem[] = [];
  for (const batch of batches) {
    const state = batch.state ?? 'on_hand';
    if (state !== 'on_hand' || batch.recallBlocked || batch.qty <= 0) continue;
    const days = daysBetween(asOf, batch.expiry);
    if (days < 0) {
      items.push({ ...actionItem(batch, 'expired', 'dispose', days) });
    } else if (days <= nearExpiryDays) {
      items.push({ ...actionItem(batch, 'near_expiry', 'markdown', days) });
    }
  }
  return items.sort((a, b) => {
    const byExpiry = dayNumber(a.expiry) - dayNumber(b.expiry);
    if (byExpiry !== 0) return byExpiry;
    return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
  });
}

function actionItem(
  batch: Batch,
  status: ExpiryStatus,
  action: ExpiryAction,
  daysToExpiry: number,
): ExpiryActionItem {
  return {
    batchId: batch.batchId,
    productId: batch.productId,
    expiry: batch.expiry,
    qty: batch.qty,
    status,
    action,
    daysToExpiry,
  };
}
