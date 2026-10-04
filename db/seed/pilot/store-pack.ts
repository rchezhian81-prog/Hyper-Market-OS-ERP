// DEMO store pack for the demo store box (ADR-0016 · OB-12 DF-2). Non-production, synthetic data only.
//
// A store edge's screens (the till, the manager's day, the buyer's orders, the counts, the back store, the picker,
// the driver, …) are fed from the STORE PACK it reads at boot (`EDGE_PACK_FILE`). The product has no delivery for
// it yet — head office building the pack and every box pulling it is DF-3, the audit's "biggest gap"
// (docs/audit/OFFLINE_SYNC_AND_CONFLICT_STRATEGY.md). For the demo box only, this builds the WHOLE pack a practice
// session needs, from what already exists, so there is one commerce truth (P-02) and nothing is typed twice:
//
//   • products                              ← the signed catalogue pack the owner published (name, price, tax,
//                                             unit, status, recall flag, barcodes) + the product master (category)
//                                             + the cloud stock ledger (on hand). Unchanged since DF-1.
//   • roles / roleAssignments               ← the cloud's own role catalogue (services/api/src/roles.ts — the
//                                             permission words the cloud enforces) and the seeded people
//                                             (db/seed/pilot/dataset.ts), owner company-wide, the rest this branch.
//                                             This is what lets the store computer draw each person's menu.
//   • policies, managerPolicy, buyingPolicy,  ← the seeded branch and back store, the seeded tolerances (receipt
//     pricingPolicy, every <screen>Policy        tolerances, shift-close tolerance), and the practice script's cast
//                                             (docs/runbooks/demo-practice-environment.md §7): who is on which
//                                             screen, with that person's permissions from the role catalogue.
//   • approvals                             ← the cloud's PENDING approval requests (`GET /v1/approvals/decisions`),
//                                             real ids a manager can decide. Not invented.
//   • purchaseOrders, receipts,             ← the cloud's purchase orders (what is received per product is on the
//     supplierInvoices                         order) and supplier invoices (`GET /v1/purchase/orders`, `/invoices`).
//   • countsQueue                           ← the cloud's count records for the demo products at the back store.
//   • checklist, lossPreventionRules        ← practice fixtures, each marked (demo): a day-close checklist and the
//                                             loss-prevention limits the manager's exception list is judged by.
//   • warehouse, wave, route                ← ONE practice delivery, ONE practice wave, ONE practice route, built
//                                             from the published products, the seeded bins and the seeded costs —
//                                             the hand-written file of runbook §4.3, now built and never retyped.
// Deliberately NOT invented:
//   • cost on a product — the published pack does not carry it, so the box reports those sales as "uncostable"
//     rather than a false 100 % margin;
//   • any section whose cloud read did not answer (`null` below) — left OUT, so the screen says it was not told,
//     which is true (store-pack.ts: "a pack that never arrived is not an empty pack");
//   • shelf maps, slots, drivers, dispatch, finance ledgers, migration — not in DF-2's scope; those screens keep
//     saying so.
// Pure: no clock, no I/O — the caller fetches and writes (run-store-pack.ts).

import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import type { Role } from '../../../packages/rbac/src/rbac';
import type { PilotFoundation, PilotTradingPartners, PilotTransactions } from './dataset';

export interface DemoStorePackInput {
  /** The signed pack's snapshot, as `GET /v1/catalogue/pack` returns it (`body.snapshot`). */
  readonly snapshot: CatalogueSnapshot;
  /** Product master rows (`GET /v1/catalogue/products`): the category of each product. */
  readonly master: ReadonlyArray<{ readonly productId: string; readonly primaryCategoryId?: string | null; readonly nameTa?: string | null }>;
  /** Stock ledger rows (`GET /v1/inventory/availability`). */
  readonly availability: ReadonlyArray<{ readonly productId: string; readonly onHandMinor: number }>;
  /** The seeded people, org and partners — what the cloud was loaded with (db/seed/pilot/dataset.ts). */
  readonly foundation: PilotFoundation;
  readonly trading: PilotTradingPartners;
  readonly transactions: PilotTransactions;
  /** The cloud's role catalogue — the permission words it enforces (services/api/src/roles.ts). */
  readonly roles: readonly Role[];
  /** The cloud's own records. `null` = that read did not answer; the section is then left out, never invented. */
  readonly cloud: {
    readonly purchaseOrders: readonly CloudPurchaseOrder[] | null;
    readonly supplierInvoices: readonly CloudSupplierInvoiceRow[] | null;
    readonly approvalDecisions: readonly CloudApprovalRow[] | null;
    readonly counts: readonly unknown[] | null;
  };
  /** Who ran it and when — recorded in the pack's comment and used for the practice ids and the finance period. */
  readonly builtBy: string;
  readonly builtAt: string;
}

/** `GET /v1/purchase/orders` → `orders[]` (services/purchase StoredPurchaseOrder, the fields this pack reads). */
export interface CloudPurchaseOrder {
  readonly poId: string;
  readonly supplierId: string;
  readonly status?: string;
  readonly lines: ReadonlyArray<{ readonly productId: string; readonly orderedQty: number; readonly unitCost: { readonly minor: number } }>;
  readonly receivedByProduct?: Readonly<Record<string, number>>;
}

/** `GET /v1/purchase/invoices` → `invoices[]` rows of `{ invoice, match }`. */
export interface CloudSupplierInvoiceRow {
  readonly invoice: {
    readonly invoiceId: string;
    readonly lines: ReadonlyArray<{ readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number; readonly lineTotalMinor: number }>;
  };
}

/** `GET /v1/approvals/decisions` → `decisions[]` (services/identity approval-decisions). */
export interface CloudApprovalRow {
  readonly requestId: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly value: { readonly minor: number } | null;
  readonly status: string;
}

export interface DemoStorePack {
  readonly _comment: string;
  readonly version: number;
  readonly products: ReadonlyArray<Record<string, unknown>>;
  readonly [section: string]: unknown;
}

/** The practice script's cast (runbook §7): who is on which screen. Every id is a seeded person, never a stand-in. */
const CAST = {
  owner: 'pilot-owner',
  manager: 'pilot-manager',
  accountant: 'pilot-accountant',
} as const;

/** Which seeded person each box screen runs as — the practice script's rows, one viewer per screen (KL-01). */
const SCREEN_VIEWERS: Readonly<Record<string, string>> = {
  // the manager's floor
  checklistPolicy: CAST.manager, countsPolicy: CAST.manager, goodsReceiptPolicy: CAST.manager, suppliersPolicy: CAST.manager,
  stockHealthPolicy: CAST.manager, indentsPolicy: CAST.manager, operationsInboxPolicy: CAST.manager, dataQualityPolicy: CAST.manager,
  wastePolicy: CAST.manager, workforceInboxPolicy: CAST.manager, essPolicy: CAST.manager, rosteringPolicy: CAST.manager,
  productionPolicy: CAST.manager, facilitiesPolicy: CAST.manager, storedValuePolicy: CAST.manager, substitutionExceptionPolicy: CAST.manager,
  documentTemplatePolicy: CAST.manager,
  // the cash office and the books
  cashOfficePolicy: CAST.accountant, dayBookPolicy: CAST.accountant, returnGovernancePolicy: CAST.accountant,
  gstReconciliationPolicy: CAST.accountant, gstReturnsPolicy: CAST.accountant,
  // the owner's controls
  dayReopenPolicy: CAST.owner, lossPreventionPolicy: CAST.owner, productPublishReviewPolicy: CAST.owner, fleetPolicy: CAST.owner,
  riskAcceptancePolicy: CAST.owner, integrationHealthPolicy: CAST.owner, categoryPolicyPolicy: CAST.owner,
};

export function buildDemoStorePack(input: DemoStorePackInput): DemoStorePack {
  const day = input.builtAt.slice(0, 10).replace(/-/g, '');
  const month = input.builtAt.slice(0, 7);
  const branch = input.foundation.org.find((n) => n.kind === 'branch');
  const warehouse = input.foundation.org.find((n) => n.kind === 'warehouse');
  if (branch === undefined || warehouse === undefined) throw new Error('the seed dataset names no branch or no warehouse — the pack cannot say which store this is');

  // ── products: unchanged since DF-1 — the published list, the master's category, the ledger's on hand ──────────
  const category = new Map(input.master.map((m) => [m.productId, m] as const));
  const onHand = new Map<string, number>();
  for (const row of input.availability) onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.onHandMinor);
  const barcodes = new Map<string, string[]>();
  for (const b of input.snapshot.barcodes) barcodes.set(b.productId, [...(barcodes.get(b.productId) ?? []), b.code]);
  const products = input.snapshot.products.map((p) => {
    const m = category.get(p.productId);
    return {
      productId: p.productId,
      name: p.name,
      ...(typeof m?.nameTa === 'string' && m.nameTa !== '' ? { nameTa: m.nameTa } : {}),
      // A product with no category in the master is filed under an honest label, not a guessed category.
      categoryId: typeof m?.primaryCategoryId === 'string' && m.primaryCategoryId !== '' ? m.primaryCategoryId : 'uncategorised',
      unitPriceMinor: p.unitPriceMinor,
      uom: p.baseUom,
      taxBps: p.taxBps,
      status: p.status,
      recallBlock: p.recallBlock === true,
      barcodes: barcodes.get(p.productId) ?? [],
      // The cloud ledger's on-hand; a product with no movements has none on hand — that IS the ledger's answer.
      availableMinor: onHand.get(p.productId) ?? 0,
    };
  });

  // ── people: the cloud's role catalogue and the seeded assignments — the menu is drawn from these ─────────────
  const people = [input.foundation.genesisOwner, ...input.foundation.users];
  const roleOf = new Map(people.map((u) => [u.userId, u.role] as const));
  const permissionsOf = (userId: string): readonly string[] => {
    const roleId = roleOf.get(userId);
    const role = input.roles.find((r) => r.id === roleId);
    if (roleId === undefined || role === undefined) throw new Error(`"${userId}" is not a seeded person with a role in the cloud's catalogue — the pack names only people who exist`);
    return role.permissions;
  };
  const roleAssignments = people.map((u) => ({
    userId: u.userId,
    roleId: u.role,
    // The owner is company-wide; everybody else works this branch. The box's own machine identity never gets a screen.
    branchScope: u.userId === input.foundation.genesisOwner.userId ? ('all' as const) : [branch.nodeId],
  }));
  const viewer = (userId: string) => ({ userId, permissions: permissionsOf(userId) });

  // ── the store: seeded branch and back store; tolerances the seed set through the real policy routes ──────────
  const shiftTolerance = input.transactions.shiftCloses[0]?.toleranceMinor ?? 10_000;
  const policies = {
    storeId: branch.nodeId,
    branchId: branch.nodeId,
    branchName: branch.name,
    tradingDayCutoff: '00:00',
    staleAfterSeconds: 900,
    countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: shiftTolerance,
    cashVarianceToleranceMinor: shiftTolerance,
    privacySlaDays: 30,
    warehouseId: warehouse.nodeId,
  };

  // ── the cloud's own records; a read that did not answer leaves its section out ───────────────────────────────
  const orders = input.cloud.purchaseOrders;
  const purchaseOrders = orders === null ? undefined : orders.map((po) => ({
    poId: po.poId,
    supplierId: po.supplierId,
    lines: po.lines.map((l) => ({ productId: l.productId, qty: l.orderedQty, unitMinor: l.unitCost.minor })),
  }));
  const receipts = orders === null ? undefined : orders
    .map((po) => ({ poId: po.poId, lines: Object.entries(po.receivedByProduct ?? {}).filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty })) }))
    .filter((r) => r.lines.length > 0);
  const supplierInvoices = input.cloud.supplierInvoices === null ? undefined : input.cloud.supplierInvoices.map((row) => ({
    invoiceId: row.invoice.invoiceId,
    lines: row.invoice.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })),
  }));
  const approvals = input.cloud.approvalDecisions === null ? undefined : input.cloud.approvalDecisions
    .filter((r) => r.status === 'pending')
    .map((r) => ({ id: r.requestId, subjectType: r.subjectType, subjectRef: r.subjectRef, requestedBy: r.requestedBy, branchId: r.branchId, valueMinor: r.value?.minor ?? null }));
  const countsQueue = input.cloud.counts === null ? undefined : input.cloud.counts;

  // ── the practice delivery, wave and route — from the published products, the seeded bins and the seeded costs ─
  const byId = new Map(input.snapshot.products.map((p) => [p.productId, p] as const));
  const costOf = new Map<string, number>();
  for (const grn of input.trading.goodsReceipts) for (const l of grn.lines) costOf.set(l.productId, l.unitCostMinor);
  const bins = input.trading.bins.map((b) => ({ binId: b.binId, storeId: b.storeId, capacityMinor: b.capacityMinor, pickable: b.pickable, ...(b.zone === undefined ? {} : { zone: b.zone }) }));
  const pickBin = input.trading.bins.find((b) => b.pickable && (b.zone ?? 'ambient') === 'ambient') ?? input.trading.bins[0];
  if (pickBin === undefined) throw new Error('the seed dataset names no bin — the practice wave has nowhere to pick from');
  const warehouseSection = {
    assignmentId: `practice-${day}`,
    workerId: CAST.manager,
    storeId: warehouse.nodeId,
    bins,
    grnId: `practice-grn-${day}`,
    // One practice delivery of every published product. Quantities are WHOLE UNITS here — the handheld shows this
    // field as units (apps/warehouse-app) — a scale DF-3 must settle once for every section (docs/STATUS.md).
    ordered: input.snapshot.products.map((p) => ({ productId: p.productId, quantityMinor: 24, unitCostMinor: costOf.get(p.productId) ?? 0, currency: 'INR' })),
    barcodes: input.snapshot.barcodes.map((b) => ({ barcode: b.code, productId: b.productId, level: 'unit' })),
    goodsIn: [],
  };
  const wanted: ReadonlyArray<readonly [string, number]> = [['prod-rice', 2], ['prod-soap', 1], ['prod-biscuit', 2]];
  const waveLines = wanted.flatMap(([productId, qty], i) => {
    const p = byId.get(productId);
    return p === undefined ? [] : [{ lineId: `l${i + 1}`, orderRef: 'ORD-practice-1', productId, description: p.name, bin: pickBin.binId, requiredQty: qty, uom: p.baseUom, unitPriceMinor: p.unitPriceMinor }];
  });
  const waveValue = waveLines.reduce((sum, l) => sum + l.requiredQty * l.unitPriceMinor, 0);
  const wave = { waveId: `practice-wave-${day}`, pickerId: CAST.manager, lines: waveLines };
  const route = {
    routeId: `practice-route-${day}`,
    driverId: CAST.manager,
    stops: [
      { stopId: 's1', orderRef: 'ORD-practice-1', area: 'Anna Nagar (demo)', codMinor: waveValue, orderValueMinor: waveValue },
      { stopId: 's2', orderRef: 'ORD-practice-2', area: 'Gandhipuram (demo)', codMinor: 0, orderValueMinor: 25_000 },
    ],
  };

  // ── practice fixtures, each marked (demo) ────────────────────────────────────────────────────────────────────
  const checklist = [
    { itemId: 'close-1', description: 'Count every till blind and hand the sheets to the cash office (demo)', done: false, blocking: true },
    { itemId: 'close-2', description: 'Lock the back store and the safe (demo)', done: false, blocking: true },
    { itemId: 'close-3', description: 'Walk the chiller and note the temperatures (demo)', done: false, blocking: false },
    { itemId: 'close-4', description: 'Pull the near-expiry lines from today\'s list (demo)', done: false, blocking: false },
    { itemId: 'close-5', description: 'Confirm tomorrow\'s deliveries with the back store (demo)', done: false, blocking: false },
  ];
  const lossPreventionRules = [
    { kind: 'refund', maxCount: 5, maxTotalValueMinor: 500_000, escalateAtMultiple: 2 },
    { kind: 'void', maxCount: 10, escalateAtMultiple: 2 },
    { kind: 'discount', maxTotalValueMinor: 200_000, maxSingleValueMinor: 50_000 },
    { kind: 'no_sale', maxCount: 6 },
  ];

  const screenPolicies = Object.fromEntries(Object.entries(SCREEN_VIEWERS).map(([section, userId]) => [section, viewer(userId)]));

  return {
    _comment: `DEMO store pack (ADR-0016, OB-12 DF-2) — synthetic data only, not for production. Built from the published catalogue pack v${input.snapshot.version}, the cloud's role catalogue and records, and the seed dataset, by ${input.builtBy} at ${input.builtAt}. Product cost and every section not listed are deliberately absent; a section a cloud read did not answer is left out, not invented.`,
    version: input.snapshot.version,
    products,
    policies,
    roles: input.roles,
    roleAssignments,
    managerPolicy: { userId: CAST.manager, approvalLimitMinor: 500_000 },
    buyingPolicy: { buyerId: CAST.manager, approvers: [CAST.owner], quantityToleranceBps: input.trading.receiptPolicy.excessToleranceBp, priceToleranceBps: 500, immaterialMinor: 10_000 },
    pricingPolicy: { userId: CAST.manager, approvers: [CAST.owner], marginFloorBps: 2000 },
    reportingPolicy: { laggingAfterMinutes: 5, staleAfterMinutes: 60, userId: CAST.owner },
    reportingRecords: [],
    expiryPolicy: { nearExpiryDays: input.trading.receiptPolicy.nearExpiryDays, userId: CAST.manager },
    servicePolicy: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000, userId: CAST.manager },
    financePolicy: { period: month, tradingDayCutoff: policies.tradingDayCutoff, journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, userId: CAST.accountant },
    adminPolicy: { dormantAfterDays: 60, userId: CAST.owner },
    aiPolicy: { staleAfterMinutes: 60, period: month, userId: CAST.owner },
    merchandisingPolicy: { refillAtBp: 2500, countStaleAfterMinutes: 240, refillRole: 'store_manager', ...viewer(CAST.manager) },
    writeOffCapturePolicy: { ...viewer(CAST.manager), materialThresholdMinor: 50_000 },
    dataIoPolicy: { ...viewer(CAST.owner), importTemplates: [] },
    ...screenPolicies,
    checklist,
    lossPreventionRules,
    warehouse: warehouseSection,
    wave,
    route,
    devices: [],
    ...(approvals === undefined ? {} : { approvals }),
    ...(purchaseOrders === undefined ? {} : { purchaseOrders }),
    ...(receipts === undefined ? {} : { receipts }),
    ...(supplierInvoices === undefined ? {} : { supplierInvoices }),
    ...(countsQueue === undefined ? {} : { countsQueue }),
  };
}
