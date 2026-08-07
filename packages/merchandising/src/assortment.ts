// Store assortment and range review (M04-FR-01 / D02).
//
// The assortment is the answer to "does this store carry this item?" — and it has to
// be an answer, not a habit. Two failures come from not having one:
//
//   • ORDERING WHAT YOU DO NOT SELL. Replenishment cheerfully reorders an item this
//     branch stopped carrying eighteen months ago, because nothing ever said stop.
//   • SELLING WHAT YOU DO NOT STOCK. An item rings up at a store that has no space
//     for it, no reorder point and no supplier line — so it sells once and then
//     disappoints every customer who comes back for it.
//
// So the rule is symmetric and enforced both ways: **an item sold in a store must be
// in that store's assortment, and an item not in the assortment is not reordered.**
//
// The dangerous operation is DROPPING an item. Deleting it from the range while
// stock sits on the shelf is how stock becomes invisible: not counted, not
// replenished, not sold, and eventually written off. So a drop with stock on hand
// does not remove anything — it routes the item to CLEARANCE, where it stays
// sellable until it is gone (M05/M10).
//
// Range decisions are effective-dated and carry a reason, because "why did we stop
// carrying this?" is asked six months later, by someone who was not in the meeting.
//
// Pure and deterministic: the date is injected, there is no clock.

export type RangeStatus = 'listed' | 'clearance' | 'delisted';

export type DropReason =
  | 'poor_sales'
  | 'poor_margin'
  | 'supplier_discontinued'
  | 'quality_issue'
  | 'range_rationalisation'
  | 'seasonal_end'
  | 'replaced_by_alternative';

export interface AssortmentEntry {
  readonly storeId: string;
  readonly productId: string;
  readonly status: RangeStatus;
  /** ISO-8601 date this status takes effect. Range changes are effective-dated. */
  readonly effectiveFrom: string;
  /** Required when leaving `listed` — asked six months later by someone else. */
  readonly reason?: DropReason;
  readonly reasonNote?: string;
  /** The item this one was replaced by, where that is the reason. */
  readonly replacedByProductId?: string;
  readonly decidedBy?: string;
}

export class RangeDecisionError extends Error {
  constructor(
    public readonly productId: string,
    why: string,
  ) {
    super(`Range decision for "${productId}" refused: ${why}`);
    this.name = 'RangeDecisionError';
  }
}

/** The assortment for one store, resolved as at a date. */
export class Assortment {
  private readonly byProduct = new Map<string, AssortmentEntry[]>();

  constructor(
    public readonly storeId: string,
    entries: readonly AssortmentEntry[] = [],
  ) {
    for (const entry of entries) {
      if (entry.storeId !== storeId) continue;
      const list = this.byProduct.get(entry.productId) ?? [];
      list.push(entry);
      this.byProduct.set(entry.productId, list);
    }
    for (const list of this.byProduct.values()) {
      list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    }
  }

  /** The entry in force on a date — nothing takes effect before its date. */
  statusOn(productId: string, onDate: string): RangeStatus | undefined {
    const applicable = (this.byProduct.get(productId) ?? []).filter(
      (e) => e.effectiveFrom <= onDate,
    );
    return applicable[applicable.length - 1]?.status;
  }

  /** May this store SELL the item on this date? Clearance still sells. */
  maySell(productId: string, onDate: string): boolean {
    const status = this.statusOn(productId, onDate);
    return status === 'listed' || status === 'clearance';
  }

  /**
   * May this store REORDER the item? Clearance deliberately does not — the whole
   * point of clearance is to sell down what is there, not to buy more of it.
   */
  mayReorder(productId: string, onDate: string): boolean {
    return this.statusOn(productId, onDate) === 'listed';
  }

  /** Everything this store carries on a date. */
  listedOn(onDate: string): readonly string[] {
    return [...this.byProduct.keys()]
      .filter((id) => this.statusOn(id, onDate) === 'listed')
      .sort();
  }

  entriesFor(productId: string): readonly AssortmentEntry[] {
    return this.byProduct.get(productId) ?? [];
  }
}

export interface DropDecision {
  /** What actually happens — never a deletion while stock remains. */
  readonly outcome: 'delisted' | 'routed_to_clearance';
  readonly entry: AssortmentEntry;
  readonly detail: string;
}

/**
 * Drop an item from a store's range. With stock on hand this becomes a CLEARANCE
 * listing rather than a delisting, because removing a stocked item from the range
 * makes its stock invisible — not counted, not replenished, not sold, eventually
 * written off (M04-FR-01 acceptance).
 */
export function dropFromRange(input: {
  readonly storeId: string;
  readonly productId: string;
  readonly onHandMinor: number;
  readonly reason: DropReason;
  readonly reasonNote?: string;
  readonly decidedBy: string;
  readonly effectiveFrom: string;
  readonly replacedByProductId?: string;
}): DropDecision {
  if (input.decidedBy.trim() === '') {
    throw new RangeDecisionError(input.productId, 'a range decision must name who made it');
  }
  if (input.reason === 'replaced_by_alternative' && input.replacedByProductId === undefined) {
    throw new RangeDecisionError(
      input.productId,
      'dropping an item as "replaced" must say what replaced it, or the customer is simply told no',
    );
  }
  if (input.onHandMinor < 0) {
    throw new RangeDecisionError(input.productId, 'on-hand cannot be negative');
  }

  const shared = {
    storeId: input.storeId,
    productId: input.productId,
    effectiveFrom: input.effectiveFrom,
    reason: input.reason,
    ...(input.reasonNote !== undefined ? { reasonNote: input.reasonNote } : {}),
    ...(input.replacedByProductId !== undefined
      ? { replacedByProductId: input.replacedByProductId }
      : {}),
    decidedBy: input.decidedBy,
  };

  if (input.onHandMinor > 0) {
    return {
      outcome: 'routed_to_clearance',
      entry: { ...shared, status: 'clearance' },
      detail: `${input.onHandMinor} still on hand — the item goes to clearance and stays sellable until it is gone; it is not reordered`,
    };
  }

  return {
    outcome: 'delisted',
    entry: { ...shared, status: 'delisted' },
    detail: 'no stock on hand — the item leaves the range cleanly',
  };
}

export type IntegrityFinding =
  | 'sold_not_in_assortment'
  | 'reordered_not_listed'
  | 'clearance_with_no_stock'
  | 'listed_never_sold';

export interface AssortmentIssue {
  readonly productId: string;
  readonly finding: IntegrityFinding;
  readonly detail: string;
}

/**
 * Check the range against what the store actually did. The first two findings are
 * control failures; the last two are commercial signals — an item on clearance with
 * nothing left should be delisted, and a listed item that has never sold is taking
 * up shelf space and cash.
 */
export function checkAssortmentIntegrity(input: {
  readonly assortment: Assortment;
  readonly onDate: string;
  /** Products that were actually sold at this store in the period. */
  readonly soldProductIds: readonly string[];
  /** Products that replenishment proposed reordering. */
  readonly reorderedProductIds?: readonly string[];
  /** On-hand per product, for the clearance check. */
  readonly onHand?: Readonly<Record<string, number>>;
}): readonly AssortmentIssue[] {
  const issues: AssortmentIssue[] = [];

  for (const productId of input.soldProductIds) {
    if (!input.assortment.maySell(productId, input.onDate)) {
      issues.push({
        productId,
        finding: 'sold_not_in_assortment',
        detail:
          'sold at this store but not in its range — it has no reorder point and no shelf, so the next customer is disappointed',
      });
    }
  }

  for (const productId of input.reorderedProductIds ?? []) {
    if (!input.assortment.mayReorder(productId, input.onDate)) {
      issues.push({
        productId,
        finding: 'reordered_not_listed',
        detail: 'proposed for reorder but not listed here — this is how a dropped item keeps arriving',
      });
    }
  }

  for (const productId of Object.keys(input.onHand ?? {})) {
    if (
      input.assortment.statusOn(productId, input.onDate) === 'clearance' &&
      (input.onHand?.[productId] ?? 0) === 0
    ) {
      issues.push({
        productId,
        finding: 'clearance_with_no_stock',
        detail: 'clearance is finished — the item can now be delisted cleanly',
      });
    }
  }

  const sold = new Set(input.soldProductIds);
  for (const productId of input.assortment.listedOn(input.onDate)) {
    if (!sold.has(productId)) {
      issues.push({
        productId,
        finding: 'listed_never_sold',
        detail: 'listed here but sold nothing in the period — it is holding shelf space and cash',
      });
    }
  }

  return issues;
}
