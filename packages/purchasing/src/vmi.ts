// Vendor-managed inventory (D03-FR-04 "VMI and consignment ownership"; OB-288 brought it back from R6 — OB-65 had deferred
// it; FG-4, 26 Oct 2026).
//
// The supplier watches its OWN items at a store and proposes a replenishment; it never orders anything. The rules:
//
//   • THE BUYER SETS THE LIMITS. For each of the supplier's items at a store the buyer records a minimum and a maximum
//     stock. Until a limit is recorded the item is "not set" and the supplier may propose nothing for it — no number is
//     invented. The items with a limit ARE the supplier's VMI items: it sees only those;
//   • A PROPOSAL STAYS INSIDE THEM. On hand at the store plus what is already on order from this supplier plus the proposed
//     quantity may not pass the maximum; a line that would is refused by name, with the room left. A proposal while stock
//     is still at or above the minimum is allowed but said ("not yet at the minimum"), so the buyer decides with it in view;
//   • NOTHING COMMITS WITHOUT THE BUYER. A proposal waits; a buyer accepts it — it then becomes a purchase-order PROPOSAL
//     raised by that buyer, which a second person still issues (§28) — or rejects it with a reason. The supplier sets no
//     price: the order is priced the way any purchase order is (the buyer's costs, or a blanket agreement's).
//
// Pure and deterministic: the stock positions are given, nothing is written here.

export interface VmiLimit {
  readonly supplierId: string;
  readonly storeId: string;
  readonly productId: string;
  /** Null when the buyer took the limit off (the item is then no longer a VMI item). */
  readonly minQty: number | null;
  readonly maxQty: number | null;
  readonly uom: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason?: string;
}

const key = (l: Pick<VmiLimit, 'supplierId' | 'storeId' | 'productId'>): string => `${l.supplierId}\u0000${l.storeId}\u0000${l.productId}`;

/** The limits in force: the latest record per (supplier, store, product); one taken off is gone. */
export function limitsInForce(records: readonly VmiLimit[]): readonly VmiLimit[] {
  const by = new Map<string, VmiLimit>();
  for (const r of records) by.set(key(r), r);
  return [...by.values()].filter((l) => l.minQty !== null && l.maxQty !== null)
    .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.productId.localeCompare(b.productId));
}

/** Read a buyer's limit: whole numbers, 0 ≤ min ≤ max, max above 0. */
export function readLimit(min: unknown, max: unknown): { readonly ok: true; readonly minQty: number; readonly maxQty: number } | { readonly ok: false; readonly why: string } {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return { ok: false, why: 'the minimum and the maximum are whole numbers' };
  if ((min as number) < 0 || (max as number) <= 0) return { ok: false, why: 'the minimum is 0 or more and the maximum above 0' };
  if ((min as number) > (max as number)) return { ok: false, why: 'the minimum is not more than the maximum' };
  return { ok: true, minQty: min as number, maxQty: max as number };
}

export interface VmiPosition {
  readonly storeId: string;
  readonly productId: string;
  readonly minQty: number;
  readonly maxQty: number;
  readonly uom: string;
  readonly onHand: number;
  /** Still to arrive on this supplier's open orders for the item at the store. */
  readonly onOrder: number;
  /** How much more may be proposed: maximum − on hand − on order, never below 0. */
  readonly room: number;
  readonly belowMinimum: boolean;
}

export function positionOf(limit: VmiLimit, onHand: number, onOrder: number): VmiPosition {
  const min = limit.minQty ?? 0;
  const max = limit.maxQty ?? 0;
  return {
    storeId: limit.storeId, productId: limit.productId, minQty: min, maxQty: max, uom: limit.uom, onHand, onOrder,
    room: Math.max(0, max - onHand - onOrder), belowMinimum: onHand + onOrder < min,
  };
}

export type VmiLineRefusal = 'not_your_item' | 'bad_quantity' | 'above_the_agreed_maximum' | 'repeated_item';

export interface VmiLineJudgement {
  readonly productId: string;
  readonly quantity: number;
  readonly ok: boolean;
  readonly refusal?: VmiLineRefusal;
  readonly position?: VmiPosition;
  readonly detail: string;
}

/** Judge a supplier's proposed lines for one store against the buyer's limits and the stock positions. */
export function judgeVmiProposal(input: {
  readonly lines: readonly { readonly productId: string; readonly quantity: unknown }[];
  /** The positions of THIS supplier's VMI items at THIS store (an item absent here is not the supplier's). */
  readonly positions: readonly VmiPosition[];
}): { readonly ok: boolean; readonly lines: readonly VmiLineJudgement[] } {
  const seen = new Set<string>();
  const lines = input.lines.map((l): VmiLineJudgement => {
    const quantity = Number.isInteger(l.quantity) ? (l.quantity as number) : NaN;
    if (seen.has(l.productId)) return { productId: l.productId, quantity, ok: false, refusal: 'repeated_item', detail: `${l.productId} is on the proposal twice — one line per item` };
    seen.add(l.productId);
    const p = input.positions.find((x) => x.productId === l.productId);
    if (p === undefined) return { productId: l.productId, quantity, ok: false, refusal: 'not_your_item', detail: `${l.productId} is not one of your items at this store — the buyer has set no limits for it` };
    if (!Number.isInteger(quantity) || quantity <= 0) return { productId: l.productId, quantity, ok: false, refusal: 'bad_quantity', position: p, detail: `the quantity for ${l.productId} is a whole number above 0` };
    if (quantity > p.room) {
      return { productId: l.productId, quantity, ok: false, refusal: 'above_the_agreed_maximum', position: p, detail: `${quantity} ${p.uom} of ${l.productId} would take the store past its maximum of ${p.maxQty} (on hand ${p.onHand}, on order ${p.onOrder}); at most ${p.room} may be proposed` };
    }
    return { productId: l.productId, quantity, ok: true, position: p, detail: p.belowMinimum ? `${quantity} ${p.uom} — the store is below its minimum of ${p.minQty}` : `${quantity} ${p.uom} — not yet at the minimum of ${p.minQty}; the buyer decides` };
  });
  return { ok: lines.length > 0 && lines.every((l) => l.ok), lines };
}
