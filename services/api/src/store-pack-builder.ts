// The store pack, assembled from head office's OWN records (Wave 4 · PA-06 = DF-3-a · OB-25 "A").
//
// One function per section, each reading the register that already holds the truth — nothing typed twice (P-02), and a
// section head office has nothing for is LEFT OUT so the store computer says it was not told (store-pack.ts: "a pack that
// never arrived is not an empty pack"). This replaces, section by section, what the demo-only builder
// (db/seed/pilot/store-pack.ts) made from the seed file:
//
//   policies          ← the store's settings head office holds (POST /v1/stores/:storeId/settings) + its org register name
//   products          ← the signed catalogue head office published + the product master's category + the stock ledger at
//                       this store
//   roles             ← the role catalogue head office enforces
//   roleAssignments   ← the grants head office holds that reach THIS store (company-wide or this branch); a revoked grant is
//                       gone
//   people            ← the names head office holds for those people (an unnamed person is shown by id, never a guess)
//   purchaseOrders /  ← head office's purchase orders and what has been received against each; its supplier invoices
//   receipts /
//   supplierInvoices
//   lossPreventionRules ← the store's own exception thresholds
//
// Not yet built here (DF-3-b/c): the approvals list, the per-screen policies, the checklist, the practice warehouse/wave/route, counts.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { StoreSettings } from '../../platform/src/store-packs';
import {
  catalogueAdapter, productMasterAdapter, inventoryAdapter, effectiveGrants, peopleAdapter,
  foldPurchaseOrders, purchaseAdapter, lpRulesAdapter,
} from './adapters';
import { ROLE_CATALOGUE } from './roles';
import type { PackSigner } from '../../catalogue/src/pack';

export interface StorePackBuildInput {
  readonly store: EventStore;
  readonly now: () => string;
  readonly signer: PackSigner;
  readonly settings: (tenantId: string, storeId: string) => Promise<StoreSettings | undefined>;
  readonly storeName: (tenantId: string, storeId: string) => Promise<string | undefined>;
}

export async function buildStorePackSections(input: StorePackBuildInput, tenantId: string, storeId: string): Promise<Record<string, unknown>> {
  const { store, now } = input;
  const sections: Record<string, unknown> = {};

  // ── the store itself ────────────────────────────────────────────────────────────────────────────────────────────
  const settings = await input.settings(tenantId, storeId);
  if (settings !== undefined) {
    sections['policies'] = {
      storeId, branchId: storeId, branchName: (await input.storeName(tenantId, storeId)) ?? storeId,
      tradingDayCutoff: settings.tradingDayCutoff, staleAfterSeconds: settings.staleAfterSeconds,
      countApprovalThresholdMinor: settings.countApprovalThresholdMinor, handoverToleranceMinor: settings.handoverToleranceMinor,
      cashVarianceToleranceMinor: settings.cashVarianceToleranceMinor, privacySlaDays: settings.privacySlaDays,
      warehouseId: settings.warehouseId ?? storeId,
    };
  }

  // ── products: what head office published, its category, the ledger at this store ───────────────────────────────
  const published = await catalogueAdapter({ store, now, signer: input.signer }).currentPack(tenantId);
  if (published !== undefined) {
    const master = new Map((await productMasterAdapter({ store, now }).products(tenantId)).map((p) => [p.productId, p] as const));
    const onHand = new Map<string, number>();
    for (const row of await inventoryAdapter({ store, now }).availability(tenantId)) {
      if (row.locationId === storeId) onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.onHandMinor);
    }
    const barcodes = new Map<string, string[]>();
    for (const b of published.snapshot.barcodes) barcodes.set(b.productId, [...(barcodes.get(b.productId) ?? []), b.code]);
    sections['products'] = published.snapshot.products.map((p) => {
      const m = master.get(p.productId);
      return {
        productId: p.productId, name: p.name,
        categoryId: typeof m?.primaryCategoryId === 'string' && m.primaryCategoryId !== '' ? m.primaryCategoryId : 'uncategorised',
        unitPriceMinor: p.unitPriceMinor, uom: p.baseUom, taxBps: p.taxBps, status: p.status, recallBlock: p.recallBlock === true,
        barcodes: barcodes.get(p.productId) ?? [],
        availableMinor: onHand.get(p.productId) ?? 0,
      };
    });
  }

  // ── people: the grants that reach this store, their roles, their names ─────────────────────────────────────────
  const grants = (await effectiveGrants(store, tenantId)).filter((g) => g.branchScope === 'all' || (Array.isArray(g.branchScope) && g.branchScope.includes(storeId)));
  sections['roles'] = ROLE_CATALOGUE;
  sections['roleAssignments'] = grants.map((g) => ({ userId: g.userId, roleId: g.roleId, branchScope: g.branchScope }));
  const names = new Map((await peopleAdapter({ store, now }).people(tenantId)).map((p) => [p.userId, p.displayName] as const));
  const seen = new Set<string>();
  sections['people'] = grants.filter((g) => (seen.has(g.userId) ? false : (seen.add(g.userId), true)))
    .map((g) => ({ userId: g.userId, displayName: names.get(g.userId) ?? g.userId, roleId: g.roleId }));

  // ── the work waiting: orders, receipts, bills ──────────────────────────────────────────────────────────────────
  // (The store's approvals list is not sent yet — the box-relayed decisions it serves are DF-3-b.)
  const orders = [...(await foldPurchaseOrders(store, tenantId)).values()];
  sections['purchaseOrders'] = orders.map((po) => ({ poId: po.poId, supplierId: po.supplierId, lines: po.lines.map((l) => ({ productId: l.productId, qty: l.orderedQty, unitMinor: l.unitCost.minor })) }));
  sections['receipts'] = orders
    .map((po) => ({ poId: po.poId, lines: Object.entries(po.receivedByProduct).filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty })) }))
    .filter((r) => r.lines.length > 0);
  sections['supplierInvoices'] = (await purchaseAdapter({ store, now }).invoices(tenantId))
    .map((inv) => ({ invoiceId: inv.invoiceId, lines: inv.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })) }));

  // ── the store's own exception thresholds ───────────────────────────────────────────────────────────────────────
  sections['lossPreventionRules'] = await lpRulesAdapter({ store, now }).rules(tenantId);

  return sections;
}
