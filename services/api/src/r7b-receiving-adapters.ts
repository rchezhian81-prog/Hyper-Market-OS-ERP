// Round 7 · R7-B (owner decisions OB-504, OB-508, OB-509, OB-513, OB-517, 28 Oct 2026) — head office's wiring for the
// receiving, costing and quality-release decisions. Kept in its own file: main.ts carries only spread/registration lines.
//
//   • OB-504 (B4): a PACKED product — its department is regulated `packed` on head office's category list — needs its month
//     and year of manufacture on every receiving path. `packagedRule` adds that fact to the receiving rule the goods-receipt
//     routes (direct, relayed, assembled) and the handheld's scan route already read; `packedProductIdsFor` is the store-pack
//     section the screens refuse from offline; `isPackedProduct` is the ASN acceptance's check.
//   • OB-508: the named owner of each receipt discrepancy — the buyer who raised the order (`requisitionedBy`) and the
//     receiving store's managers (the store-manager role grants for that branch), read now; nobody is ever invented.
//   • OB-509: a cost-not-known line's cost from the supplier's bill a person matched to the receipt — the receipt's next
//     version and a value-only posting (`StockCostAdjusted`, `costKnown`) in ONE append.
//   • OB-513: whether a held batch's product is FOOD (its department is regulated `food`) — undefined when head office
//     cannot tell, which the release treats as needing a sample (never assumed not food).
//   • OB-517: the received cost on the matched supplier bill, for the purchase-price variance.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  STREAM, streamName, goodsReceiptAdapter, foldPurchaseOrders, effectiveGrants, liveSupplierInvoices, productMasterAdapter, categoryRegisterAdapter,
  STOCK_COST_ADJUSTMENTS_STREAM,
} from './adapters';
import { STORE_MANAGER_ROLE_ID } from './roles';
import { receiptCostHooks } from './receipt-cost-adapters';
import type { GoodsReceiptDeps, GrnRecord, OrderLineCost, ProductReceiptFacts, SupplierBillForReceipt } from '../../inventory/src/goods-receipt';
import type { ProductReceiptRules } from '../../../packages/receiving/src/index';
import type { StockCostAdjustment } from '../../inventory/src/landed-cost';

interface Base { readonly store: EventStore; readonly now: () => string }

/** The regulated kinds of each product's department, by product id (head office's product master + category list). */
export async function regulatedKindsOf(input: Base, tenantId: string): Promise<(productId: string) => readonly string[] | undefined> {
  const [products, categories] = await Promise.all([productMasterAdapter(input).products(tenantId), categoryRegisterAdapter(input).categories(tenantId)]);
  const regulatedOf = new Map(categories.map((c) => [c.categoryId, c.regulated ?? []] as const));
  const categoryOf = new Map(products.map((p) => [p.productId, p.primaryCategoryId] as const));
  return (productId) => {
    if (!categoryOf.has(productId)) return undefined;
    const c = categoryOf.get(productId);
    return c === null || c === undefined ? [] : (regulatedOf.get(c) ?? []);
  };
}

const withPackaged = (rule: ProductReceiptRules | undefined, kinds: readonly string[] | undefined): ProductReceiptRules | undefined =>
  rule === undefined || !(kinds ?? []).includes('packed') ? rule : { ...rule, packaged: true };

/**
 * OB-504: the receiving rule with the product's PACKED fact added — the same `productRule` / `productFacts` the goods-receipt
 * adapter answers, spread after it so these win. A product the master holds under a `packed` department is packaged.
 */
export function packagedRule(input: Base): Pick<GoodsReceiptDeps, 'productRule'> & { readonly productFacts: NonNullable<GoodsReceiptDeps['productFacts']> } {
  const base = goodsReceiptAdapter(input);
  return {
    productRule: async (tenantId, productId) => withPackaged(await base.productRule(tenantId, productId), (await regulatedKindsOf(input, tenantId))(productId)),
    productFacts: async (tenantId, productIds) => {
      const facts = await base.productFacts!(tenantId, productIds);
      const kinds = await regulatedKindsOf(input, tenantId);
      const out = new Map<string, ProductReceiptFacts>();
      for (const [productId, f] of facts) {
        const rule = withPackaged(f.rule, kinds(productId));
        out.set(productId, { ...f, ...(rule === undefined ? {} : { rule }) });
      }
      return out;
    },
  };
}

/** OB-504: is this a packed product by head office's records? undefined when the master does not hold it. */
export async function isPackedProduct(input: Base, tenantId: string, productId: string): Promise<boolean | undefined> {
  const kinds = (await regulatedKindsOf(input, tenantId))(productId);
  return kinds === undefined ? undefined : kinds.includes('packed');
}

/** OB-504: every product head office makes PACKED — the store pack's `packedProductIds` section (sorted). */
export async function packedProductIdsFor(input: Base, tenantId: string): Promise<readonly string[]> {
  const products = await productMasterAdapter(input).products(tenantId);
  const kinds = await regulatedKindsOf(input, tenantId);
  return products.map((p) => p.productId).filter((id) => (kinds(id) ?? []).includes('packed')).sort();
}

/** OB-513: is this product FOOD (its department regulated `food`)? undefined when head office cannot tell. */
export async function isFoodProduct(input: Base, tenantId: string, productId: string): Promise<boolean | undefined> {
  const kinds = (await regulatedKindsOf(input, tenantId))(productId);
  return kinds === undefined ? undefined : kinds.includes('food');
}

const GRN_STREAM = streamName(STREAM.purchase, 'grn');

type LiveInvoice = Awaited<ReturnType<typeof liveSupplierInvoices>>[number];
/** OB-509: a registered supplier bill as the goods-receipt match reads it — only what a receipt's cost is read from. */
const billForReceipt = (inv: LiveInvoice): SupplierBillForReceipt => ({
  invoiceId: inv.invoiceId, supplierId: inv.supplierId, poId: inv.poId, currency: inv.currency, approvedBy: inv.approvedBy,
  lines: inv.lines.map((l) => ({ productId: l.productId, unitPriceMinor: l.unitPriceMinor, ...(l.unitPricePer === undefined ? {} : { unitPricePer: l.unitPricePer }) })),
});

/** OB-508 · OB-509 · Round 7: everything the goods-receipt routes take from this round, spread into their deps (main.ts). */
export function r7bReceiptHooks(input: Base): Pick<GoodsReceiptDeps, 'orderRaisedBy' | 'storeManagersOf' | 'supplierBill' | 'supplierBills' | 'commitBillMatch' | 'orderLineCost' | 'productRule' | 'productFacts'> {
  return {
    ...receiptCostHooks(input),
    ...packagedRule(input),
    // OB-508: the buyer who raised the order — head office's own record of who raised it, never a typed name.
    orderRaisedBy: async (tenantId, poId) => (await foldPurchaseOrders(input.store, tenantId)).get(poId)?.requisitionedBy,
    // OB-508: everyone granted the store manager role for the branch (or for every branch) — possibly nobody.
    storeManagersOf: async (tenantId, branchId) => [...new Set((await effectiveGrants(input.store, tenantId))
      .filter((g) => g.roleId === STORE_MANAGER_ROLE_ID && (g.branchScope === 'all' || g.branchScope.includes(branchId)))
      .map((g) => g.userId))],
    // OB-509: the supplier's bill as head office's register holds it (a withdrawn bill is not on it).
    supplierBill: async (tenantId, invoiceId): Promise<SupplierBillForReceipt | undefined> => {
      const inv = (await liveSupplierInvoices(input.store, tenantId)).find((i) => i.invoiceId === invoiceId);
      return inv === undefined ? undefined : billForReceipt(inv);
    },
    // OB-509 (G3): every bill on the register — the ones the bill-matching screen offers beside a receipt waiting for its cost.
    supplierBills: async (tenantId) => (await liveSupplierInvoices(input.store, tenantId)).map(billForReceipt),
    // OB-509: the receipt's next version and the value its bill puts on the unvalued stock — ONE append, once per bill.
    commitBillMatch: async (tenantId, record, postings, key) => {
      const at = record.billCosts?.at(-1)?.matchedAt ?? input.now();
      const by = record.billCosts?.at(-1)?.matchedBy ?? '';
      await input.store.appendBatch(tenantId, [
        { stream: GRN_STREAM, event: makeEvent({
          id: `grn-bill-match-${key}`, type: 'GoodsReceiptBillMatched', occurredAt: at,
          idempotencyKey: `grn-bill-match-${tenantId}-${key}`, source: 'api/inventory', payload: record as unknown as Record<string, unknown>,
        }) },
        ...postings.map((p) => {
          const adj: StockCostAdjustment = {
            adjustmentId: `bill-cost:${record.grnId}:${p.lineId}`, invoiceId: p.invoiceId, poId: p.poId, productId: p.productId, locationId: p.locationId,
            quantityMinor: p.quantityMinor, valueMinor: p.valueMinor, occurredAt: at, postedBy: by, matchedAt: at,
            costKnown: true, grnId: record.grnId, lineId: p.lineId, uom: p.uom,
          };
          return { stream: STOCK_COST_ADJUSTMENTS_STREAM, event: makeEvent({
            id: adj.adjustmentId, type: 'StockCostAdjusted', occurredAt: at,
            // Once per receipt line: a second bill for the same line can never value its stock twice.
            idempotencyKey: `stock-cost-${tenantId}-${adj.adjustmentId}`, source: 'api/inventory', payload: adj as unknown as Record<string, unknown>,
          }) };
        }),
      ]);
    },
  };
}

/** OB-504: an accepted ASN's lines — each packed product's line needs its month of manufacture (supplier-portal review). */
export function r7bAsnHooks(input: Base): { readonly packedProduct: (tenantId: string, productId: string) => Promise<boolean | undefined> } {
  return { packedProduct: (tenantId, productId) => isPackedProduct(input, tenantId, productId) };
}

/** OB-513: the quality-hold routes' food lookup (direct release and the store computer's relayed release). */
export function r7bQualityHooks(input: Base): { readonly isFood: (tenantId: string, productId: string) => Promise<boolean | undefined> } {
  return { isFood: (tenantId, productId) => isFoodProduct(input, tenantId, productId) };
}

/** OB-504: the handheld's scan route reads the packed fact through the same rule. */
export function r7bScanHooks(input: Base): { readonly productRule: GoodsReceiptDeps['productRule'] } {
  return { productRule: packagedRule(input).productRule };
}

/**
 * OB-517 · OB-530 (owner, 28 Oct 2026): the cost each receipt line was BILLED at — ONLY the price on the supplier bill matched
 * to THAT EXACT RECEIPT (its `billCosts`, recorded by the bill-match route). A bill matched to the order, or to another receipt
 * on it, is never borrowed. Undefined → "not yet billed".
 */
export async function billedCostOf(): Promise<(g: GrnRecord, lineId: string, productId: string) => { readonly unitCost: OrderLineCost; readonly invoiceId: string } | undefined> {
  return (g, lineId) => {
    const own = (g.billCosts ?? []).find((b) => b.lineId === lineId);
    return own === undefined ? undefined : { unitCost: own.unitCost, invoiceId: own.invoiceId };
  };
}
