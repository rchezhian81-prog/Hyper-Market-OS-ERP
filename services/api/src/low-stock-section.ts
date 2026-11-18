// Batch 15 (owner, gap audit, 18 Nov 2026): the store pack's LOW-STOCK list and SUPPLIER NAMES (P-02 · P-08).
//
// Low stock is head office's own judgement, made where its figures are: every item at this store whose stock on hand
// (floor and back store — the same stock the pack's products carry) is at or below the reorder point in force for it
// (D-038's reorder settings, M09-FR-02). An item with no reorder point is never "low" and never "fine" — it is simply not
// counted, and `levelsSet` says how many items have one, so the store computer can say "no reorder levels set yet"
// instead of a reassuring 0. Nothing here carries a build time: the pack's content hash must not change when nothing did.
//
// Supplier names are the master's names only (never a bank account, never a contact), so a screen names a supplier
// instead of showing its code.

/** The reorder settings in force for one item (the fields this list reads). */
export interface ReorderPointInForce {
  readonly productId: string;
  readonly reorderPoint?: number;
}

export interface LowStockItem {
  readonly productId: string;
  readonly name?: string;
  readonly onHandMinor: number;
  readonly reorderPoint: number;
  readonly uom?: string;
}

export interface LowStockSection {
  readonly levelsSet: number;
  readonly items: readonly LowStockItem[];
}

/**
 * The low-stock list: items whose on-hand is at or below their reorder point, the emptiest first (the share of the reorder
 * point still held), then by item. An item head office holds no stock record for at this store counts as 0 on hand.
 */
export function lowStockSectionOf(
  settings: readonly ReorderPointInForce[],
  onHand: ReadonlyMap<string, number>,
  describe: (productId: string) => { readonly name?: string; readonly uom?: string },
): LowStockSection {
  const withPoint = settings.filter((s): s is ReorderPointInForce & { reorderPoint: number } =>
    typeof s.reorderPoint === 'number' && Number.isFinite(s.reorderPoint) && s.reorderPoint >= 0);
  const items = withPoint
    .map((s) => ({ s, held: onHand.get(s.productId) ?? 0 }))
    .filter(({ s, held }) => held <= s.reorderPoint)
    .map(({ s, held }): LowStockItem => {
      const d = describe(s.productId);
      return {
        productId: s.productId,
        ...(d.name === undefined || d.name.trim() === '' ? {} : { name: d.name }),
        onHandMinor: held,
        reorderPoint: s.reorderPoint,
        ...(d.uom === undefined ? {} : { uom: d.uom }),
      };
    })
    .sort((a, b) => share(a) - share(b) || a.productId.localeCompare(b.productId));
  return { levelsSet: withPoint.length, items };
}

const share = (i: LowStockItem): number => (i.reorderPoint === 0 ? (i.onHandMinor <= 0 ? 0 : 1) : i.onHandMinor / i.reorderPoint);

/** The supplier master as names only, by supplier code; a record with no name is left out (the screen then shows the code). */
export function supplierNamesOf(records: Iterable<{ readonly supplierId: string; readonly name?: unknown }>): readonly { readonly supplierId: string; readonly name: string }[] {
  const out: { supplierId: string; name: string }[] = [];
  for (const r of records) {
    if (typeof r.name === 'string' && r.name.trim() !== '') out.push({ supplierId: r.supplierId, name: r.name.trim() });
  }
  return out.sort((a, b) => a.supplierId.localeCompare(b.supplierId));
}
