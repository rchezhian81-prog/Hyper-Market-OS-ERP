// M26-FR-01 "asset, warranty, AMC, service and SPARE tracking" — the spare-parts register (Round 4d).
//
// A spare part is a definition (what it is, which assets it fits, the level below which the shop wants more) and a ledger of
// MOVEMENTS: stock received, stock used on a service, and a counted correction. On hand is never stored — it is the sum of
// the movements (hard rule 2: a quantity is never overwritten; a wrong movement is put right by a compensating one). A
// service that uses spares draws them from this ledger; it cannot draw more than is on hand, and a part that does not fit
// the asset it is used on is refused by name. Pure and deterministic; the routes are services/platform/src/facilities-assets.ts.

export interface SparePart {
  readonly sparePartId: string;
  readonly branchId: string;
  readonly name: string;
  /** The assets this part fits. Empty: it fits none yet, so no service may use it until one is named. */
  readonly compatibleAssetIds: readonly string[];
  /** Below this many on hand the part shows as low. 0: never low. */
  readonly minimumLevel: number;
  /** How the part is counted (e.g. "each", "metre"). */
  readonly unit: string;
  readonly active: boolean;
  readonly definedBy: string;
  readonly definedAt: string;
}

export type SpareMovementKind = 'received' | 'used' | 'correction';

export interface SpareMovement {
  readonly movementId: string;
  readonly sparePartId: string;
  readonly kind: SpareMovementKind;
  /** Signed whole units: + received, − used; a correction either way. Never 0. */
  readonly qty: number;
  readonly on: string;
  readonly by: string;
  readonly at: string;
  /** A use names the asset and the service it was drawn for. */
  readonly assetId?: string;
  readonly serviceId?: string;
  /** A correction says why (a count, a damaged part). */
  readonly reason?: string;
}

export const onHandOf = (sparePartId: string, movements: readonly SpareMovement[]): number =>
  movements.filter((m) => m.sparePartId === sparePartId).reduce((n, m) => n + m.qty, 0);

export interface SpareView extends SparePart {
  readonly onHand: number;
  readonly low: boolean;
  readonly movements: readonly SpareMovement[];
}

/** Every part of a branch with what is on hand, whether it is low, and its movements (newest first). Low parts first. */
export function sparesView(parts: readonly SparePart[], movements: readonly SpareMovement[], branchId: string): readonly SpareView[] {
  return parts.filter((p) => p.branchId === branchId).map((p) => {
    const onHand = onHandOf(p.sparePartId, movements);
    return { ...p, onHand, low: p.active && p.minimumLevel > 0 && onHand < p.minimumLevel, movements: movements.filter((m) => m.sparePartId === p.sparePartId).slice().reverse() };
  }).sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));
}

export type DrawProblem =
  | { readonly problem: 'unknown_part'; readonly sparePartId: string }
  | { readonly problem: 'part_inactive'; readonly sparePartId: string }
  | { readonly problem: 'not_compatible'; readonly sparePartId: string; readonly assetId: string }
  | { readonly problem: 'not_enough'; readonly sparePartId: string; readonly onHand: number; readonly wanted: number };

/**
 * Whether a service on `assetId` may draw these spares now: each part known, in use, fitting the asset, and enough on hand
 * (two lines of the same part are added together first). Null when every draw stands.
 */
export function drawProblem(draws: readonly { readonly sparePartId: string; readonly qty: number }[], assetId: string, parts: readonly SparePart[], movements: readonly SpareMovement[]): DrawProblem | null {
  const wanted = new Map<string, number>();
  for (const d of draws) wanted.set(d.sparePartId, (wanted.get(d.sparePartId) ?? 0) + d.qty);
  for (const [sparePartId, qty] of wanted) {
    const part = parts.find((p) => p.sparePartId === sparePartId);
    if (part === undefined) return { problem: 'unknown_part', sparePartId };
    if (!part.active) return { problem: 'part_inactive', sparePartId };
    if (!part.compatibleAssetIds.includes(assetId)) return { problem: 'not_compatible', sparePartId, assetId };
    const onHand = onHandOf(sparePartId, movements);
    if (qty > onHand) return { problem: 'not_enough', sparePartId, onHand, wanted: qty };
  }
  return null;
}
