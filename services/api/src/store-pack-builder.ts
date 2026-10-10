// The store pack, assembled from head office's OWN records (Wave 4 · PA-06 = DF-3-a · OB-26 "A").
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
//   checklist and the  ← the store's working rules head office holds (POST /v1/stores/:storeId/rules); every screen's
//   screen policies       viewer is the person who signed in (no person is named here)
//
//   buyingPolicy       ← the three-way-match policy head office applies (no buyer is named: the screen runs as the
//                        signed-in person — PA-06 part 3b)
// Not yet built here (DF-3-c): the practice warehouse delivery and bins, counts.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { StoreSettings, StoreRules } from '../../platform/src/store-packs';
import { SUPPLIER_INVOICE_SPEC, SUPPLIER_INVOICE_LABEL, PRODUCT_SPEC, PRODUCT_LABEL, templateView } from '../../purchase/src/import-templates';
import { AccessControl } from '../../../packages/rbac/src/rbac';
import {
  catalogueAdapter, productMasterAdapter, inventoryAdapter, effectiveGrants, peopleAdapter,
  foldPurchaseOrders, purchaseAdapter, lpRulesAdapter, allCountReconciliations, adjustmentRequestAdapter, goodsReceiptAdapter,
} from './adapters';
import { ROLE_CATALOGUE } from './roles';
import { DEFAULT_MATCH_POLICY } from '../../purchase/src/index';
import type { PackSigner } from '../../catalogue/src/pack';

export interface StorePackBuildInput {
  readonly store: EventStore;
  readonly now: () => string;
  readonly signer: PackSigner;
  readonly settings: (tenantId: string, storeId: string) => Promise<StoreSettings | undefined>;
  readonly storeName: (tenantId: string, storeId: string) => Promise<string | undefined>;
  /** DF-3-b-1: the store's working rules (limits, windows, checklist). */
  readonly rules?: (tenantId: string, storeId: string) => Promise<StoreRules | undefined>;
}

/**
 * The screens whose setup is only WHO is looking (DF-3-b-1). Head office does not know who will sit at a screen, so it
 * sends no person: behind the signed-in front each screen runs as the person who signed in (OB-16), with that person's
 * permissions from this setup's grants. A screen that is not behind it says nobody is named, never guesses (DF-3-c binds
 * every screen to the signed-in person).
 */
export const VIEWER_ONLY_SCREEN_SECTIONS: readonly string[] = Object.freeze([
  'checklistPolicy', 'countsPolicy', 'goodsReceiptPolicy', 'suppliersPolicy', 'stockHealthPolicy', 'indentsPolicy',
  'operationsInboxPolicy', 'dataQualityPolicy', 'wastePolicy', 'workforceInboxPolicy', 'essPolicy', 'rosteringPolicy',
  'productionPolicy', 'facilitiesPolicy', 'storedValuePolicy', 'substitutionExceptionPolicy', 'documentTemplatePolicy',
  'cashOfficePolicy', 'dayBookPolicy', 'returnGovernancePolicy', 'gstReconciliationPolicy', 'gstReturnsPolicy',
  'dayReopenPolicy', 'lossPreventionPolicy', 'productPublishReviewPolicy', 'fleetPolicy', 'riskAcceptancePolicy',
  'integrationHealthPolicy', 'categoryPolicyPolicy',
]);

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
  // PA-06 part 3b (DF-3-c-3b): the buying screen's tolerances are the match policy head office applies (OC-13; the
  // default in force until the owner sets one). WHO buys is never named here — the screen runs as the signed-in person.
  const matchPolicy = (await purchaseAdapter({ store, now }).matchPolicy(tenantId)) ?? DEFAULT_MATCH_POLICY;
  sections['buyingPolicy'] = {
    approvers: [],
    quantityToleranceBps: matchPolicy.quantityToleranceBps, priceToleranceBps: matchPolicy.priceToleranceBps, immaterialMinor: matchPolicy.immaterialMinor,
  };
  sections['supplierInvoices'] = (await purchaseAdapter({ store, now }).invoices(tenantId))
    .map((inv) => ({ invoiceId: inv.invoiceId, lines: inv.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })) }));

  // ── the screens: who is looking comes from the sign-in; the rules come from head office (DF-3-b-1) ───────────────
  for (const section of VIEWER_ONLY_SCREEN_SECTIONS) sections[section] = { permissions: [] };
  sections['dataIoPolicy'] = {
    permissions: [],
    importTemplates: [
      templateView({ spec: SUPPLIER_INVOICE_SPEC, label: SUPPLIER_INVOICE_LABEL, financial: true }),
      templateView({ spec: PRODUCT_SPEC, label: PRODUCT_LABEL, financial: false }),
    ],
  };
  const rules = input.rules === undefined ? undefined : await input.rules(tenantId, storeId);
  if (rules !== undefined) {
    // Who may approve a price below the floor at this store: the people whose grants here carry the authority — read from
    // the grants, never a list typed into a file.
    const access = new AccessControl(ROLE_CATALOGUE, grants);
    const approversOf = (permission: string): string[] => [...new Set(grants.map((g) => g.userId))].filter((u) => access.can({ userId: u, permission, branchId: storeId })).sort();
    sections['checklist'] = rules.checklist.map((c) => ({ itemId: c.itemId, description: c.description, done: false, blocking: c.blocking }));
    sections['managerPolicy'] = { approvalLimitMinor: rules.approvalLimitMinor };
    sections['pricingPolicy'] = { approvers: approversOf('price.change.approve'), marginFloorBps: rules.marginFloorBps };
    sections['reportingPolicy'] = { laggingAfterMinutes: rules.reporting.laggingAfterMinutes, staleAfterMinutes: rules.reporting.staleAfterMinutes };
    sections['reportingRecords'] = [];
    sections['expiryPolicy'] = { nearExpiryDays: rules.nearExpiryDays };
    sections['servicePolicy'] = { ...rules.service };
    if (settings !== undefined) {
      sections['financePolicy'] = { period: now().slice(0, 7), tradingDayCutoff: settings.tradingDayCutoff, journalPrefixes: { ...rules.journalPrefixes } };
    }
    sections['adminPolicy'] = { dormantAfterDays: rules.dormantAfterDays, permissions: [] };
    sections['aiPolicy'] = { staleAfterMinutes: rules.aiStaleAfterMinutes, period: now().slice(0, 7) };
    sections['merchandisingPolicy'] = { ...rules.merchandising, permissions: [] };
    sections['writeOffCapturePolicy'] = { permissions: [], materialThresholdMinor: rules.writeOffMaterialThresholdMinor };
  }

  // ── DF-3-b-2: the work waiting for this store's manager, from head office's own registers ──────────────────────
  // The three subjects head office APPLIES when the store's manager decides them (approve-then-apply, SP-4): a held
  // blind count, a pending stock correction, and a delivery's held excess — at this store or its back store. Each is
  // listed under the id the decision comes back with.
  const here = new Set([storeId, ...(settings?.warehouseId !== undefined && settings.warehouseId !== null ? [settings.warehouseId] : [])]);
  const counts = (await allCountReconciliations(store, tenantId)).filter((c) => here.has(c.locationId));
  const heldCounts = counts.filter((c) => c.pendingApproval === true);
  const pendingCorrections = (await adjustmentRequestAdapter({ store, now }).requests(tenantId))
    .filter((r) => r.status === 'pending' && (here.has(r.locationId) || (r.storeId !== null && here.has(r.storeId))));
  const heldExcess = (await goodsReceiptAdapter({ store, now }).all(tenantId))
    .filter((g) => here.has(g.warehouseId) && g.heldMinor > 0 && g.excessDecision === undefined);
  sections['approvals'] = [
    ...heldCounts.map((c) => ({ id: `stock_count:${c.countId}`, subjectType: 'stock_count', subjectRef: c.countId, requestedBy: c.counterId, branchId: storeId, valueMinor: Math.abs(c.valueMinor) })),
    ...pendingCorrections.map((r) => ({ id: `stock_adjustment:${r.requestId}`, subjectType: 'stock_adjustment', subjectRef: r.requestId, requestedBy: r.requestedBy, branchId: storeId, valueMinor: Math.abs(r.valueMinor) })),
    ...heldExcess.map((g) => ({ id: `goods_receipt_excess:${g.grnId}`, subjectType: 'goods_receipt_excess', subjectRef: g.grnId, requestedBy: g.receivedBy, branchId: storeId, valueMinor: null })),
  ];
  sections['countsQueue'] = counts;
  // Which catalogue head office has published — the store computer compares it with the one it holds (SF-08 hand-over).
  if (published !== undefined) sections['catalogueVersion'] = published.snapshot.version;

  // ── the store's own exception thresholds ───────────────────────────────────────────────────────────────────────
  sections['lossPreventionRules'] = await lpRulesAdapter({ store, now }).rules(tenantId);

  return sections;
}
