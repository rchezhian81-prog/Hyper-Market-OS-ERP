// Screen gap audit (31 Oct 2026) Round A — the store pack sections two office pages were never sent, read from head
// office's OWN registers (P-02: nothing typed twice; P-08: a page that was never told says so, and an empty register says
// "nothing recorded yet", never "all clear").
//
//   • `wasteWriteOffsSectionFor` — the Waste & write-off page (M28-FR-01): every write-off head office committed at THIS
//     store or its back store, as the review row the page reads. The register is the append-only write-off stream every
//     write-off path builds through (`writeOffCommittedEntry`); a correction is its own compensating write-off, shown as
//     itself. Sent even when empty, so the page can tell "nothing recorded yet" from "never told".
//   • `categoryPolicySectionFor` — the Category rules page (M03-FR-01 · CAT-POLICY): every category on head office's list.
//     Head office keeps NO dated rule set for a category yet (the rule engine is reached only through the read-only preview
//     route), so each category goes with an empty history and the page shows it as "No rules in force — set them": the
//     truth, never a preset passed off as the shop's own rules.
//
// Read-only: nothing here writes anything.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { categoryRegisterAdapter, writeOffAdapter } from './adapters';

/** One write-off as the Waste page reads it (`apps/web-erp/src/waste-review-session.ts` `WriteOffRow`). */
export interface WasteReviewRow {
  readonly id: string;
  readonly productId: string;
  readonly lossType: string;
  readonly qtyRemoved: number;
  readonly uom: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly requiredApproval: boolean;
  readonly evidenceRef?: string;
  readonly raisedBy: string;
  readonly at: string;
}

/**
 * The write-offs committed at this store's own places (the store and its back store), newest first. `branchOf` is the
 * builder's own "whose place is this" rule, so a write-off at a place the hierarchy puts under another store is never
 * shown here.
 */
export async function wasteWriteOffsSectionFor(
  store: EventStore, now: () => string, tenantId: string, storeId: string, branchOf: (locationId: string) => string,
): Promise<readonly WasteReviewRow[]> {
  const all = await writeOffAdapter({ store, now }).writeOffs(tenantId);
  return all
    .filter((w) => branchOf(w.locationId) === storeId)
    .map((w): WasteReviewRow => ({
      id: w.id, productId: w.productId, lossType: w.lossType, qtyRemoved: w.qtyRemoved, uom: w.uom,
      valueMinor: w.valueMinor, currency: w.currency, requiredApproval: w.requiredApproval,
      ...(typeof w.evidenceRef === 'string' && w.evidenceRef.trim() !== '' ? { evidenceRef: w.evidenceRef } : {}),
      raisedBy: w.raisedBy, at: w.at,
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

/** One category as the Category rules page reads it (`packages/product` `CategoryPolicy`), plus its name. */
export interface CategoryPolicyRow {
  readonly categoryId: string;
  readonly name: string;
  /** The category's dated rule entries. Empty: head office holds no rules for it (the page says "no rules in force"). */
  readonly history: readonly never[];
}

/** Every category on head office's list, by id. Head office keeps no dated rules for a category, so none are invented. */
export async function categoryPolicySectionFor(store: EventStore, now: () => string, tenantId: string): Promise<readonly CategoryPolicyRow[]> {
  const categories = await categoryRegisterAdapter({ store, now }).categories(tenantId);
  return [...categories]
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
    .map((c) => ({ categoryId: c.categoryId, name: c.name, history: [] }));
}
