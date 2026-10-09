import { describe, it, expect } from 'vitest';
import {
  costTheDay, readSales, activityFrom, exceptionsFor, type LoggedSale,
} from '../../edge/store-edge/src/read-model';
import {
  emptyPack, readPack, known, notKnown, orElse, type PackProduct, type StorePack,
} from '../../edge/store-edge/src/store-pack';
import {
  payloadFor, managerPayload, ownerPayload, posPayload, posRefundPolicyPayload, customerPayload,
  pickerPayload, driverPayload, reportingPayload, merchandisingPayload, unsellablePayload, unsellableProducts, catalogueFreshness,
  GLOBAL_FOR, SCREENS, type ScreenInput,
  tillCatalogue,
} from '../../edge/store-edge/src/screen-data';
import { embed, injectPayload, routeOf, safeFile, DATA_MARKER, APP_SHELL } from '../../edge/store-edge/src/screen-server';
import { SyncOutbox } from '../../packages/sync/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import { CatalogueCache, type CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The store box feeding the six screens.**
 *
 * Every screen in this product was built to be told the truth, including the truth that the box
 * does not know something — and until now nothing told them anything at all. This is the join.
 *
 * The rule under test throughout is one character wide. `?? []` turns *"the cloud has never told
 * this box about approvals"* into *"no approvals are waiting"*. The manager's day close is built
 * to refuse the first and proceed on the second, so that one character decides whether a trading
 * day locks correctly or locks on nothing.
 */

const NOW = '2026-08-05T14:00:00.000Z';
const DAY = '2026-08-05';

const PRODUCTS: PackProduct[] = [
  {
    productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
    unitCostMinor: 100_00, uom: 'ea', barcodes: ['8901'], availableMinor: 10,
    taxBps: 500, status: 'active',
  },
  {
    productId: 'p2', name: 'Tomato', categoryId: 'produce', unitPriceMinor: 80_00,
    unitCostMinor: 50_00, uom: 'kg', barcodes: ['8902'], availableMinor: 20_000,
  },
];

const sale = (over: Partial<LoggedSale> = {}): LoggedSale => ({
  id: 'S-1', number: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY,
  committedAt: NOW, total: 145_00, netMinor: 122_88, taxMinor: 22_12, currency: 'INR',
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }],
  tenders: [{ kind: 'cash', amount: { minor: 145_00 } }],
  ...over,
});

const PLANOGRAM = {
  planogramId: 'pg-1', storeId: 'store-1', version: 1, effectiveFrom: '2026-08-01',
  createdBy: 'u-merch',
  assignments: [
    { storeId: 'store-1', productId: 'p1', locationId: 'L-A1', capacityMinor: 24, primary: true },
    { storeId: 'store-1', productId: 'p-milk', locationId: 'L-COLD', capacityMinor: 60, primary: true },
  ],
};

const SHELF_LOCATIONS = [
  { storeId: 'store-1', locationId: 'L-A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A1' },
  // Physically the FIRST thing you walk past, and it must still be collected last.
  { storeId: 'store-1', locationId: 'L-COLD', aisle: 0, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Chiller', zone: 'chilled' as const },
];

const SHELF_ASSIGNMENTS = [
  { storeId: 'store-1', productId: 'p1', locationId: 'L-A1', capacityMinor: 24, primary: true },
];

const CATEGORIES = [{
  categoryId: 'grocery', name: 'Grocery', parentId: null,
  attributes: [{ key: 'packSize', label: 'a pack size', type: 'text' as const, required: true }],
}];

const MASTER = [{
  productId: 'p1', tenantId: 't1', sku: 'SKU-1', name: 'Toor dal 1kg', brand: 'Aachi',
  primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '0713',
  attributes: { packSize: '1kg' },
  mrpHistory: [{ value: { minor: 160_00, currency: 'INR' as const }, effectiveFrom: '2026-01-01' }],
  lifecycle: 'active' as const,
}];

const fullPack = (over: Partial<StorePack> = {}): StorePack => ({
  receivedAt: NOW,
  version: 7,
  policies: known({
    storeId: 'store-1', branchId: 'b1', branchName: 'SRE Hyper Market',
    tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_00,
    handoverToleranceMinor: 100_00, privacySlaDays: 30, warehouseId: 'wh-1',
  }),
  products: known(PRODUCTS),
  approvals: known([]),
  checklist: known([]),
  wave: known(null),
  route: known(null),
  deliveries: known([]),
  drivers: known([]),
  routingPolicy: known({
    storeLocation: { lat: 11, lon: 77 }, radiusMetres: 10_000,
    averageSpeedKmh: 20, serviceMinutesPerStop: 5,
  }),
  slots: known([]),
  purchaseOrders: known([{
    poId: 'PO-1', supplierId: 'sup-1',
    lines: [{ productId: 'p1', qty: 10, unitMinor: 90_00 }],
  }]),
  receipts: known([{ poId: 'PO-1', lines: [{ productId: 'p1', qty: 10 }] }]),
  supplierInvoices: known([]),
  buyingPolicy: known({
    buyerId: 'u-buyer', approvers: ['u-manager', 'u-buyer'],
    quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100,
  }),
  categories: known(CATEGORIES),
  productMaster: known(MASTER),
  priceEntries: known([{
    id: 'pe-1', productId: 'p1', scope: 'store', scopeRef: 'store-1',
    priceMinor: 145_00, effectiveFrom: '2026-01-01', status: 'active', version: 1,
  }]),
  pricingPolicy: known({
    userId: 'u-pricing', approvers: ['u-manager', 'u-pricing'], marginFloorBps: 2000,
  }),
  shelfLocations: known(SHELF_LOCATIONS),
  shelfAssignments: known(SHELF_ASSIGNMENTS),
  shelfPolicy: known({ zoneOrder: ['ambient', 'chilled', 'frozen'] }),
  planogram: known(PLANOGRAM),
  shelfCounts: known([]),
  backstock: known({ p1: 100, 'p-milk': 100 }),
  assortment: known([
    { storeId: 'store-1', productId: 'p1', status: 'listed', effectiveFrom: '2026-01-01' },
  ]),
  spaceAreas: known([{ areaId: 'grocery', storeId: 'store-1', name: 'Grocery', squareFeet: 2_000 }]),
  salesByAreaMinor: known({ grocery: 900_000 }),
  marginByAreaMinor: known({ grocery: 90_000 }),
  displayContracts: known([]),
  fundingReceivedMinor: known({}),
  stillOccupying: known([]),
  merchandisingPolicy: known({ refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'shelf-filler' }),
  // What this shop records, who may export it, and how old a figure may get (D13 / §32).
  reportingRecords: known([
    'sales_rung_at_the_till', 'cost_prices_on_the_catalogue', 'departments_on_the_catalogue',
    'the_boxs_own_outbox',
  ]),
  roles: known([{
    id: 'analyst', name: 'Analyst',
    permissions: ['reporting.sales.export', 'reporting.operations.export'],
  }]),
  roleAssignments: known([{ userId: 'u-report', roleId: 'analyst', branchScope: ['b1'] }]),
  people: notKnown('not pulled'),
  reportingPolicy: known({ laggingAfterMinutes: 5, staleAfterMinutes: 60, userId: 'u-report' }),
  // Who runs the manager screen on this box (Stage G slice 5c).
  managerPolicy: known({ userId: 'u-mgr', approvalLimitMinor: 500_000 }),
  // The service desk: what it needs to take goods back (M13) and run its cases (M21).
  returnHistory: known([]),
  serviceCases: known([{
    caseId: 'C-1', tenantId: 't1', kind: 'complaint', customerRef: 'cust-1',
    openedAt: '2026-08-05T09:00:00.000Z', assignedTo: 'u-desk', priority: 'high',
    state: 'open', summary: 'Milk was sour',
  }]),
  satisfaction: known([]),
  slaPolicy: known({ resolutionMinutes: { high: 240 }, firstResponseMinutes: { high: 60 } }),
  servicePolicy: known({
    returnWindowDays: 30, approvalThresholdMinor: 200_00, noReceiptCapMinor: 100_00,
    agentAuthorityMinor: 50_00, compensationCapMinor: 500_00, userId: 'u-desk',
  }),
  // Expiry and recall (M10). Batches with dates, and every recall this shop has run.
  batches: known([
    { batchId: 'B-OLD', productId: 'p1', qty: 10, expiry: '2026-08-04' },
    { batchId: 'B-SOON', productId: 'p1', qty: 20, expiry: '2026-08-09' },
  ]),
  recalls: known([]),
  expiryPolicy: known({ nearExpiryDays: 7, userId: 'u-qc' }),
  // Finance (M23). Both sides of the month, and this shop's own chart-of-accounts headings.
  tallyPostings: known([
    { postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
      debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1,
      queuedAt: '2026-07-31T23:00:00.000Z' },
  ]),
  financeLedger: known({ takingsMinor: 100_000_00, taxMinor: 0, refundsMinor: 0, billCount: 412 }),
  periodState: known({ closed: false }),
  financePolicy: known({
    period: '2026-07', tradingDayCutoff: '02:00',
    journalPrefixes: { takings: 'SALES', tax: 'GST', refunds: 'REFUND' },
    userId: 'u-finance',
  }),
  gstReconciliationQueue: known([{ documentType: 'e_invoice', id: 'INV-1', category: 'registered', number: 'IRN-1' }]),
  gstReconciliationPolicy: known({ userId: 'u-finance', permissions: ['finance.einvoice.read', 'finance.einvoice.generate'] }),
  categoryPolicyCategories: known([{ categoryId: 'grocery', history: [{ effectiveFrom: '2026-01-01', value: { traceability: 'none', quantityMode: 'each', valuation: 'retail_mrp', shelfLife: { perishable: false, blockSaleAfterExpiry: false }, returns: { returnable: true }, controlledSale: {}, approvals: [], enabledByDefault: true } }] }]),
  categoryPolicyPolicy: known({ userId: 'u-cat', permissions: ['catalogue.pack.read'] }),
  gstReturnsQueue: known([{ period: '062026', state: 'filed', arn: 'ARN-062026' }]),
  gstReturnsPolicy: known({ userId: 'u-finance', permissions: ['finance.gstr.read'] }),
  wasteWriteOffs: known([{ id: 'wo-1', productId: 'RICE-5', lossType: 'damage', qtyRemoved: 4, uom: 'ea', valueMinor: 240_000, currency: 'INR', requiredApproval: true, evidenceRef: 'photo-1' }]),
  wastePolicy: known({ userId: 'u-mgr', permissions: ['waste.view'] }),
  writeOffCapturePolicy: known({ userId: 'u-floor', permissions: ['inventory.movement.append'], materialThresholdMinor: 50_000 }),
  countsQueue: known([{ id: 'c-1', productId: 'RICE-5', expectedMinor: 20, countedMinor: 16, varianceMinor: -4, valueMinor: 240_000, currency: 'INR', uom: 'ea', requiredApproval: true, adjusted: true, counterId: 'u-floor', approvedBy: 'u-mgr' }]),
  countsPolicy: known({ userId: 'u-mgr', permissions: ['count.view'] }),
  fleetPolicy: known({ userId: 'u-mgr', permissions: ['platform.health.read', 'platform.device.manage'] }),
  // Products to publish (ADR-0013). Who may deliver a queued product publish; the queue is the device outbox.
  productPublishReviewPolicy: known({ userId: 'u-owner', permissions: ['catalogue.pack.publish'] }),
  dataQualityPolicy: known({ userId: 'u-owner', permissions: ['ai.proposal.read'] }),
  operationsInboxPolicy: known({ userId: 'u-owner', permissions: ['ai.proposal.read'] }),
  lossPreventionPolicy: known({ userId: 'u-mgr', permissions: ['lp.case.read', 'lp.case.manage'] }),
  substitutionExceptionPolicy: known({ userId: 'u-desk', permissions: ['order.read', 'order.exception.work'] }),
  dayBookPolicy: known({ userId: 'u-acct', permissions: ['finance.period.read', 'finance.journal.post'] }),
  documentTemplatePolicy: known({ userId: 'u-owner', permissions: ['platform.setup.read', 'platform.setup.write'] }),
  returnGovernancePolicy: known({ userId: 'u-mgr', permissions: ['lp.case.read'] }),
  cashOfficePolicy: known({ userId: 'u-cashoffice', permissions: ['till.shift.read', 'till.overshort.review'] }),
  riskAcceptancePolicy: known({ userId: 'u-seclead', permissions: ['compliance.risk.read', 'compliance.risk.manage'] }),
  dayReopenPolicy: known({ userId: 'u-accountant', permissions: ['till.dayclose.read', 'till.dayclose.approve'] }),
  stockHealthPolicy: known({ userId: 'u-manager', permissions: ['inventory.availability.read'] }),
  storedValuePolicy: known({ userId: 'u-manager', permissions: ['lp.case.read'] }),
  integrationHealthPolicy: known({ userId: 'u-admin', permissions: ['platform.health.read'] }),
  goodsReceiptPolicy: known({ userId: 'u-manager', permissions: ['inventory.availability.read'] }),
  // Suppliers (M06-FR-01 · §28). Who is looking + what they hold; the list comes live from the cloud.
  suppliersPolicy: known({ userId: 'u-acct', permissions: ['supplier.view', 'purchase.supplier.approve'] }),
  indentsPolicy: known({ userId: 'u-floor', permissions: ['inventory.indent.read', 'inventory.indent.request', 'inventory.movement.append'] }),
  floorIndents: notKnown('not pulled in this fixture'),
  assignments: notKnown('not pulled in this fixture'),
  dataIoPolicy: known({ userId: 'u-owner', permissions: ['export.read', 'purchase.import.read', 'purchase.import.record'], importTemplates: [{ id: 'products-basic', domain: 'products', label: 'Products', financial: false, columns: [{ name: 'sku', type: 'text' }], keyColumns: ['sku'] }] }),
  workforceInboxPolicy: known({ userId: 'u-owner', permissions: ['ai.proposal.read'] }),
  // Employee self-service (M25). Who is looking + whether they hold `payroll.ess.self`; rota + payslip come live.
  essPolicy: known({ userId: 'u-cash', permissions: ['payroll.ess.self'] }),
  // Manager rostering (M25-FR-01). Who is looking + what they hold; the gaps and staff come live from the cloud.
  rosteringPolicy: known({ userId: 'u-manager', permissions: ['workforce.roster.read', 'workforce.roster.manage'] }),
  // Manager checklist (M25-FR-02). Who is looking + what they hold; the day's checklists come live from the cloud.
  checklistPolicy: known({ userId: 'u-manager', permissions: ['workforce.checklist.read', 'workforce.roster.manage'] }),
  // Production quality-release (M11-FR-03). Who is looking + what they hold; the runs come live from the cloud.
  productionPolicy: known({ userId: 'u-qc', permissions: ['production.read', 'production.release'] }),
  facilitiesPolicy: known({ userId: 'u-fm', permissions: ['facilities.overdue.read', 'facilities.task.record'] }),
  // Admin and security (M01/M02/M33/M34). Support access is never pruned (hard rule #6).
  accounts: known([{
    userId: 'u-meena', tenantId: 't1', username: 'meena',
    person: { fullName: 'Meena R', email: 'meena@example.com' },
    status: 'active', mfaEnrolled: true, lastLoginAt: '2026-08-05T09:00:00.000Z',
  }]),
  supportSessions: known([]),
  devices: known([{
    deviceId: 'D-1', tenantId: 't1', branchId: 'b1', kind: 'pos', label: 'Lane 1',
    status: 'active', appVersion: '2.0.0', lastSeenAt: '2026-08-05T13:59:00.000Z',
  }]),
  versionPolicy: known({ currentVersion: '2.0.0', minimumSupportedVersion: '1.0.0' }),
  auditRecords: known([]),
  retentionPolicies: known([]),
  legalHolds: known([]),
  adminPolicy: known({ dormantAfterDays: 60, userId: 'u-admin' }),
  // AI control (M32/M36/A01-A10). Never pruned: a kill switch is the record of a decision.
  killSwitches: known([]),
  agentBudgets: known([
    { agentId: 'A02', tenantId: 'store-1', monthlyCeilingMinor: 100_000,
      defaultTier: 'standard', permittedTiers: ['small', 'standard'], enabled: true },
  ]),
  aiUsage: known([
    { tenantId: 'store-1', agentId: 'A02', period: '2026-08', inputTokens: 1_000,
      outputTokens: 500, tier: 'standard', costMinor: 30_000 },
  ]),
  aiPending: known([]),
  aiEvaluations: known({ A01: { passed: 19, total: 20, at: '2026-08-05T10:00:00.000Z' } }),
  aiPolicy: known({
    staleAfterMinutes: 60, period: '2026-08', platformCeilingMinor: 1_500_000, userId: 'u-owner',
  }),
  // Migration (MG-01..MG-12). The cutover gate is DERIVED from these, never asserted.
  migrationSources: known([{
    sourceId: 'S-1', tenantId: 'store-1', name: 'Legacy ERP database', kind: 'erp_database',
    ownerUserId: 'u-owner', rowCount: 41_200, volumeBasis: 'counted', retentionYears: 8,
    extractable: true,
  }]),
  migrationExceptions: known([{
    exceptionId: 'EX-1', tenantId: 'store-1', kind: 'negative_stock', severity: 'blocking',
    confidence: 'certain', legacyIds: ['p1'], evidence: 'stock on hand is -4 for toor dal 1kg',
    valueMinor: 40_000,
  }]),
  migrationTotals: known([{
    totalId: 'CT-1', tenantId: 'store-1', kind: 'migration', name: 'Product rows', unit: 'rows',
    legacyValue: 41_200, loadedValue: 41_200,
    legacyDerivation: 'count(*) on the legacy product table',
    loadedDerivation: 'count(*) on the loaded product table',
  }]),
  parallelDays: known([
    { tenantId: 'store-1', businessDate: '2026-08-03', differences: [], clean: true, totalDifferenceMinor: 0, detail: 'agree' },
    { tenantId: 'store-1', businessDate: '2026-08-04', differences: [], clean: true, totalDifferenceMinor: 0, detail: 'agree' },
  ]),
  parallelDifferences: known([]),
  historyExclusions: known([]),
  legacyArchive: known({
    archiveId: 'AR-1', tenantId: 'store-1', sourceId: 'S-1', digest: 'abc123', rowCount: 41_200,
    archivedAt: '2026-08-05T00:00:00.000Z', retentionYears: 8,
    earliestRecordDate: '2014-04-01', latestRecordDate: '2026-08-04', readOnly: true,
  }),
  migrationPolicy: known({
    cutoverId: 'cut-1', requiredCleanDays: 3, loadOperator: 'u-eng', userId: 'u-owner',
    openAssessments: 0,
  }),
  migrationFeed: notKnown('this box has never pulled the cloud register'),
  documentTemplates: notKnown('no published template has reached this box'),
  lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]),
  consentPurposes: known([]),
  warehouse: notKnown('no warehouse work sent'),
  ...over,
});

const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  pack: fullPack(), sales: [sale()], unreadableRecords: 0,
  outbox: new SyncOutbox(), now: NOW, tradingDay: DAY, ...over,
});

// A genuinely signed catalogue pack (real signature), for the pack-age badge tests below.
const FRESH_KEY = ['edge', 'screens', 'freshness', 'key'].join('-').padEnd(48, '0');
function signedCatalogue(version: number, builtAt: string, products?: CatalogueSnapshot['products']): SignedPack {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version, builtAt,
    products: products ?? [{ productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(FRESH_KEY), publishedBy: 'u-manager', publishedAt: builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe('the pack-age badge is on every screen (SYNC-01, P-08)', () => {
  it('says NOT KNOWN when the box has pulled no catalogue yet — never a misleading "0 hours old"', () => {
    expect(catalogueFreshness(input())).toEqual({ known: false });
  });

  it('reports the catalogue version and its age from the cloud builtAt, not the box clock', () => {
    // NOW is 2026-08-05T14:00Z; the pack was built five hours earlier.
    const fresh = catalogueFreshness(input({ cataloguePack: signedCatalogue(7, '2026-08-05T09:00:00.000Z') }));
    expect(fresh).toMatchObject({ known: true, version: 7, ageHours: 5 });
    expect(String(fresh['visibleToStaff'])).toContain('v7');
  });

  it('counts a stale catalogue in days once it is over a day old', () => {
    const fresh = catalogueFreshness(input({ cataloguePack: signedCatalogue(6, '2026-08-03T14:00:00.000Z') }));
    expect(fresh).toMatchObject({ known: true, ageHours: 48 });
    expect(String(fresh['visibleToStaff'])).toMatch(/day\(s\)/);
  });

  it('is injected as its own global on every screen, alongside (or instead of) the screen payload', () => {
    const held = input({ cataloguePack: signedCatalogue(7, '2026-08-05T09:00:00.000Z') });
    for (const screen of SCREENS) {
      const shell = `<html><head>${DATA_MARKER}</head></html>`;
      const html = injectPayload(shell, GLOBAL_FOR[screen], payloadFor(screen, held), { catalogueFreshness: catalogueFreshness(held) });
      expect(html, screen).toContain('window.catalogueFreshness =');
      expect(html, screen).toContain('"version":7');
    }
  });

  it('still shows the badge on a screen whose own payload is null (told nothing else)', () => {
    // The expiry screen's payload is null when the pack carries no expiry policy; the badge must still ride.
    const noPolicy = input({ pack: fullPack({ expiryPolicy: notKnown('no expiry policy') }), cataloguePack: signedCatalogue(7, '2026-08-05T09:00:00.000Z') });
    expect(payloadFor('expiry', noPolicy)).toBeNull();
    const html = injectPayload(`${DATA_MARKER}`, GLOBAL_FOR['expiry'], payloadFor('expiry', noPolicy), { catalogueFreshness: catalogueFreshness(noPolicy) });
    expect(html).toContain('window.catalogueFreshness =');
    expect(html).not.toContain(`window.${GLOBAL_FOR['expiry']} =`); // no screen payload, but the badge is there
    // The till is the one screen a held pack always feeds (SP-9-i · F13): a file with no products and a pulled pack = head office's catalogue.
    const noProducts = input({ pack: fullPack({ products: notKnown('no catalogue') }), cataloguePack: signedCatalogue(7, '2026-08-05T09:00:00.000Z') });
    expect(posPayload(noProducts)).toMatchObject({ source: 'head_office', version: 7 });
  });
});

describe('SF-01 — the offers head office signed into the pack reach the till through the box', () => {
  it('passes the pack\'s switched-on offers to the lane as signed; a pack with none sends none', () => {
    const offer = { id: 'ghee-10', kind: 'percent_off' as const, percentBps: 1000, productIds: ['P1'], startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z', status: 'active' as const };
    const plain = signedCatalogue(7, '2026-08-05T09:00:00.000Z');
    const withOffer = publishPack({ snapshot: { ...plain.snapshot, version: 8, promotions: [offer] }, approvals: [], signer: hmacSigner(FRESH_KEY), publishedBy: 'u-manager', publishedAt: '2026-08-05T09:00:00.000Z' });
    if (!withOffer.ok || withOffer.pack === undefined) throw new Error(withOffer.detail);
    expect(posPayload(input({ cataloguePack: withOffer.pack }))).toMatchObject({ version: 8, promotions: [offer] });
    expect(posPayload(input({ cataloguePack: plain }))).not.toHaveProperty('promotions');
  });
});

describe('a pack that never arrived is not an empty pack', () => {
  it('starts every section as NOT KNOWN, with the reason', () => {
    const pack = emptyPack();
    for (const section of [pack.policies, pack.products, pack.approvals, pack.checklist, pack.slots, pack.lossPreventionRules]) {
      expect(section.known).toBe(false);
      if (!section.known) expect(section.why).toMatch(/never received a pack/);
    }
    expect(pack.receivedAt).toBeNull();
  });

  it('keeps a section the cloud did not send as NOT KNOWN, rather than empty', () => {
    // The subtler half: a pack arrived, and it carried no approvals section at all.
    const pack = readPack({ version: 3, products: [] }, NOW);
    expect(pack.products).toEqual({ known: true, value: [] });
    expect(pack.approvals.known).toBe(false);
    if (!pack.approvals.known) expect(pack.approvals.why).toMatch(/carried no approvals/);
  });

  it('treats a pack it cannot read as knowing nothing, not as knowing zero', () => {
    for (const bad of [null, 'a string', 42]) {
      expect(readPack(bad, NOW).products.known).toBe(false);
    }
  });

  it('distinguishes a known-empty list from an unknown one at the reading end too', () => {
    expect(orElse(known<readonly string[]>([]), ['fallback'])).toEqual([]);
    expect(orElse(notKnown<readonly string[]>('down'), ['fallback'])).toEqual(['fallback']);
  });
});

describe('the two gates on a day close are produced HERE, not fetched', () => {
  it('serves the box’s own outbox as the unsent register', () => {
    // Nothing else in the system knows what has not reached the cloud — by definition, the cloud
    // does not. This is the only honest source there is.
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const payload = managerPayload(input({ outbox }));
    expect(payload['unsentItems']).toEqual([{ id: 'k1', what: 'SaleCommitted' }]);
  });

  it('drops an item from the unsent register once it is acknowledged', () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    outbox.acknowledge('k1');
    expect(managerPayload(input({ outbox }))['unsentItems']).toEqual([]);
  });

  it('evaluates the day’s exceptions locally, against the store’s own thresholds', () => {
    // Waiting for the cloud to notice a refund spike would blank the register exactly when the
    // line is down, which is when a shop is least supervised.
    const refunds = [
      sale({ id: 'S-1', total: -100_00 }),
      sale({ id: 'S-2', total: -200_00 }),
      sale({ id: 'S-3', total: -300_00 }),
    ];
    const payload = managerPayload(input({ sales: refunds }));
    const exceptions = payload['openExceptions'] as { id: string; what: string }[];
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.what).toMatch(/refund by u-meena: 3 against a limit of 2/);
  });

  it('OMITS the exception register entirely when the pack carried no rules', () => {
    // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching. The
    // section is absent, so the manager's screen says "not known" and refuses to close the day.
    const payload = managerPayload(input({ pack: fullPack({ lossPreventionRules: notKnown('no rules sent') }) }));
    expect('openExceptions' in payload).toBe(false);
  });

  it('raises an unreadable record on this disk as an exception in its own right', () => {
    // It is evidence that something went wrong here. Excluding it from the figures AND from the
    // list of things wrong with the day would make a power cut invisible (hard rule #6).
    const payload = managerPayload(input({ unreadableRecords: 2 }));
    const exceptions = payload['openExceptions'] as { id: string; what: string }[];
    expect(exceptions.some((e) => e.id === 'edge:unreadable-records')).toBe(true);
    expect(exceptions.find((e) => e.id === 'edge:unreadable-records')?.what).toMatch(/power cut/);
  });

  it('omits approvals, tasks and product costs when the pack has not carried them', () => {
    const bare = managerPayload(input({
      pack: fullPack({
        approvals: notKnown('x'), checklist: notKnown('x'), products: notKnown('x'),
      }),
    }));
    for (const section of ['approvals', 'tasks', 'products']) {
      expect(section in bare, `"${section}" must be ABSENT, not empty`).toBe(false);
    }
    // But the two gates it CAN answer are still answered.
    expect('unsentItems' in bare).toBe(true);
    expect('openExceptions' in bare).toBe(true);
  });

  it('serves a known-empty checklist as an empty task list, not as unknown', () => {
    expect(managerPayload(input())['tasks']).toEqual([]);
  });

  it('marks a blocking checklist item as one the shop cannot close without', () => {
    const payload = managerPayload(input({
      pack: fullPack({
        checklist: known([
          { itemId: 'c1', description: 'Chiller temperature logged', done: false, blocking: true },
          { itemId: 'c2', description: 'Aisle 4 faced up', done: false, blocking: false },
          { itemId: 'c3', description: 'Safe locked', done: true, blocking: true },
        ]),
      }),
    }));
    const tasks = payload['tasks'] as { id: string; what: string }[];
    expect(tasks.map((t) => t.id)).toEqual(['c1', 'c2']); // the done one is gone
    expect(tasks[0]?.what).toMatch(/cannot close without/);
    expect(tasks[1]?.what).not.toMatch(/cannot close without/);
  });
});

describe('margin is only served where it can genuinely be worked out', () => {
  it('costs a sale from the pack’s cost prices', () => {
    const day = costTheDay([sale()], PRODUCTS);
    expect(day.facts).toHaveLength(1);
    expect(day.facts[0]?.cogsMinor).toBe(100_00);
    expect(day.uncostableSales).toBe(0);
  });

  it('costs a weighed line by weight, in exact integers', () => {
    // 1.5 kg of tomatoes at ₹50/kg cost ₹75.00 — and the arithmetic never touches a float.
    const day = costTheDay([sale({
      id: 'S-2', lines: [{ productId: 'p2', quantityMinor: 1500, uom: 'kg' }],
    })], PRODUCTS);
    expect(day.facts[0]?.cogsMinor).toBe(75_00);
  });

  it('EXCLUDES a sale it cannot cost, and counts it, rather than costing it at zero', () => {
    // Zero cost reports a 100% margin. That is a lie that reads as very good news, so it would be
    // believed — which is exactly why it must not be possible to produce it.
    const day = costTheDay([
      sale({ id: 'S-1' }),
      sale({ id: 'S-2', total: 300_00, lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] }),
    ], PRODUCTS);

    expect(day.facts.map((f) => f.saleId)).toEqual(['S-1']);
    expect(day.uncostableSales).toBe(1);
    expect(day.productsWithoutCost).toEqual(['p-unknown']);
    // The money is still a fact — the shop took it either way.
    expect(day.takenMinor).toBe(145_00 + 300_00);
    expect(day.billCount).toBe(2);
  });

  it('treats a product present in the pack but with no cost price as uncostable', () => {
    const noCost: PackProduct[] = [{ ...PRODUCTS[0]!, unitCostMinor: undefined }];
    const day = costTheDay([sale()], noCost);
    expect(day.uncostableSales).toBe(1);
    expect(day.productsWithoutCost).toEqual(['p1']);
  });

  it('reports the gap on the owner’s payload, naming the products', () => {
    // The person who can fix a missing cost price is exactly the person reading this screen.
    const payload = ownerPayload(input({
      sales: [sale(), sale({ id: 'S-2', lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] })],
    }))!;
    expect(payload['uncostable']).toMatchObject({ sales: 1, billCount: 2, products: ['p-unknown'] });
  });
});

describe('the day is read from the disk honestly', () => {
  it('drops a record it cannot parse, and counts it', () => {
    // A half-written record from a power cut is not a sale with fields missing; it is a thing
    // nobody can vouch for. Turning it into a zero-value sale would put a fiction in the figures.
    const result = readSales([JSON.stringify(sale()), 'not json', '{"no":"id"}']);
    expect(result.sales).toHaveLength(1);
    expect(result.unreadable).toBe(2);
  });

  it('reads a refund from the sign of the total rather than a flag nobody sets', () => {
    expect(activityFrom([sale({ total: -100_00 })])).toEqual([
      { txnId: 'S-1', kind: 'refund', cashierId: 'u-meena', valueMinor: 100_00, at: NOW },
    ]);
    expect(activityFrom([sale()])).toEqual([]);
  });

  it('says whether the rules were known, so an empty list is never mistaken for clean', () => {
    expect(exceptionsFor([], undefined)).toEqual({ exceptions: [], rulesKnown: false });
    expect(exceptionsFor([], [])).toEqual({ exceptions: [], rulesKnown: true });
  });
});

describe('each screen gets what it needs, and nothing when the box has nothing', () => {
  it('gives the till a catalogue, and null when there is none', () => {
    expect(posPayload(input())).toMatchObject({ version: 7 });
    expect(posPayload(input({ pack: fullPack({ products: notKnown('x') }) }))).toBeNull();
  });

  it('hands the till its refund policy — the approval threshold and the no-receipt cap, as the pack carries them — and nothing when the box holds none (SP-9b-i · M13-FR-01)', () => {
    // The same two numbers the service desk screen is given; the till reads no other desk limit. Without a service
    // policy the global is absent, and the till then offers NO return without a receipt rather than guessing a cap.
    expect(posRefundPolicyPayload(input())).toEqual({ approvalThresholdMinor: 200_00, noReceiptCapMinor: 100_00 });
    expect(posRefundPolicyPayload(input({ pack: fullPack({ servicePolicy: notKnown('no service policy on this box') }) }))).toBeUndefined();
  });

  it('gives the customer app the PACK VERSION, so a stale price cannot be paid against', () => {
    // Without the version the app cannot tell that prices moved while somebody was deciding, and
    // the check that refuses to charge a figure they never saw stops working entirely (P-02).
    expect(customerPayload(input())).toMatchObject({ packVersion: 7 });
  });

  it('names the store that fulfils the app\'s orders — the store of the pack, the same basis as the till\'s stock movements (M20 slice 2)', () => {
    expect(customerPayload(input())).toMatchObject({ locationId: 'store-1' });
    // No pack policy → no store named. The app then refuses to send rather than guessing one.
    expect(customerPayload(input({ pack: fullPack({ policies: notKnown('x') }) }))!['locationId']).toBeUndefined();
  });

  it('feeds the customer app the store location + radius so the 10 km check works, not {0,0}-refuse-everyone', () => {
    const payload = customerPayload(input())!;
    // The routing policy's store location and radius are the SAME ones dispatch uses (§6.2).
    expect(payload['storeLocation']).toEqual({ lat: 11, lon: 77 });
    expect(payload['policy']).toEqual({ radiusMetres: 10_000 });
  });

  it('generates the day\'s delivery slots from the store\'s delivery policy (M20-FR-03, OA-11)', () => {
    const withDelivery = input({
      pack: fullPack({
        routingPolicy: known({
          storeLocation: { lat: 11.0168, lon: 76.9558 }, radiusMetres: 10_000, // Coimbatore, 10 km
          averageSpeedKmh: 20, serviceMinutesPerStop: 5,
          // The owner's answer (OA-11): 8 slots a day, 9 am–9 pm IST, 10 orders each.
          deliverySlotsPerDay: 8, deliveryWindowOpen: '09:00', deliveryWindowClose: '21:00',
          deliverySlotCapacity: 10, deliveryUtcOffsetMinutes: 330,
        }),
      }),
    });
    const slots = customerPayload(withDelivery)!['slots'] as { startsAt: string; capacity: number; kind: string }[];
    expect(slots).toHaveLength(8);
    // 9 am IST on the trading day is 03:30 UTC; eight 90-minute windows cover to 21:00 IST (15:30 UTC).
    expect(slots[0]!.startsAt).toBe('2026-08-05T03:30:00.000Z');
    expect(slots[7]!.startsAt).toBe('2026-08-05T14:00:00.000Z');
    expect(slots.every((s) => s.capacity === 10 && s.kind === 'delivery')).toBe(true);
    expect(customerPayload(withDelivery)!['storeLocation']).toEqual({ lat: 11.0168, lon: 76.9558 });
  });

  it('offers no delivery slots (never a guess) when the store has no delivery policy and no concrete slots', () => {
    const noDelivery = input({ pack: fullPack({ slots: known([]) }) }); // routingPolicy has no slot config
    expect(customerPayload(noDelivery)!['slots']).toEqual([]); // the pack's own (empty) slots, nothing invented
  });

  it('gives the picker nothing when no wave was assigned, rather than an empty wave', () => {
    expect(pickerPayload(input())).toBeNull();
    const assigned = pickerPayload(input({
      pack: fullPack({
        wave: known({
          waveId: 'w1', pickerId: 'u-picker',
          lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Toor dal', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 145_00 }],
        }),
      }),
    }))!;
    expect(assigned['waveId']).toBe('w1');
    expect((assigned['lines'] as { unitPrice: unknown }[])[0]?.unitPrice).toEqual({ minor: 145_00, currency: 'INR' });
  });

  it('tells the picker how each product travels from the pulled catalogue pack — the product master\'s handling class — and says nothing for a product the pack does not classify (HA-2)', () => {
    const catalogue = signedCatalogue(8, '2026-08-05T09:00:00.000Z', [
      { productId: 'p-milk', sku: 'MILK1', name: 'Milk 1L', baseUom: 'each', unitPriceMinor: 60_00, taxBps: 0, status: 'active', handling: 'chilled' },
      { productId: 'p-rice', sku: 'RICE1', name: 'Rice 5kg', baseUom: 'each', unitPriceMinor: 100_00, taxBps: 500, status: 'active' },
    ]);
    const payload = pickerPayload(input({
      cataloguePack: catalogue,
      pack: fullPack({
        wave: known({
          waveId: 'w2', pickerId: 'u-picker',
          lines: [
            { lineId: 'l1', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00 },
            { lineId: 'l2', orderRef: 'ORD-1', productId: 'p-rice', description: 'Rice 5kg', bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 100_00 },
          ],
        }),
      }),
    }))!;
    const lines = payload['lines'] as { lineId: string; handling?: string }[];
    expect(lines.find((l) => l.lineId === 'l1')?.handling).toBe('chilled');
    expect(lines.find((l) => l.lineId === 'l2')).not.toHaveProperty('handling');
    // No catalogue pulled yet: no handling on any line — never a guess.
    const none = pickerPayload(input({ pack: fullPack({ wave: known({ waveId: 'w3', pickerId: 'u-picker', lines: [{ lineId: 'l1', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L', bin: 'B-04', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00 }] }) }) }))!;
    expect((none['lines'] as { handling?: string }[])[0]).not.toHaveProperty('handling');
  });

  it('gives the driver nothing when no route was dispatched (M20)', () => {
    expect(driverPayload(input())).toBeNull();
    const dispatched = driverPayload(input({
      pack: fullPack({
        route: known({
          routeId: 'r1', driverId: 'd1',
          stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 }],
        }),
      }),
    }))!;
    expect(dispatched['routeId']).toBe('r1');
    // The tenant's own handover tolerance travels with it rather than being a constant anywhere.
    expect(dispatched['handoverToleranceMinor']).toBe(100_00);
  });

  it('gives the owner nothing when the box does not even know which shop it is', () => {
    expect(ownerPayload(input({ pack: fullPack({ policies: notKnown('x') }) }))).toBeNull();
  });

  it('has a builder and a global for every screen, with no drift', () => {
    for (const screen of SCREENS) {
      expect(typeof GLOBAL_FOR[screen], `${screen} has no global`).toBe('string');
      expect(APP_SHELL[screen]?.dir, `${screen} has no app folder`).toBeTruthy();
      // Every one must be callable — a screen with no builder would 500 on its own URL.
      expect(() => payloadFor(screen, input())).not.toThrow();
    }
    expect(Object.keys(GLOBAL_FOR).sort()).toEqual([...SCREENS].sort());
  });
});

describe('the payload reaches the screen safely', () => {
  it('injects at the marker, above the bundle that reads it', () => {
    const html = `<head></head><body>${DATA_MARKER}<script type="module" src="./x.bundle.js"></script></body>`;
    const out = injectPayload(html, 'managerData', { a: 1 });
    expect(out).toContain('<script>window.managerData = {"a":1};</script>');
    expect(out.indexOf('window.managerData')).toBeLessThan(out.indexOf('x.bundle.js'));
  });

  it('leaves the shell untouched when there is nothing to say', () => {
    // The screen then falls back to its sample data, which it announces. Injecting `null` would
    // be worse: the shell reads a defined-but-empty global as real, and stops warning.
    const html = `x${DATA_MARKER}y`;
    expect(injectPayload(html, 'managerData', null)).toBe(html);
  });

  it('cannot be escaped out of by a product name (script injection)', () => {
    // A product name is text somebody typed into a spreadsheet, and it reaches this payload
    // verbatim. `</script>` inside it would end the element and everything after becomes markup.
    const nasty = embed({ name: '</script><script>alert(1)</script>' });
    expect(nasty).not.toContain('</script>');
    expect(nasty).toContain('\\u003c');
    expect(JSON.parse(nasty) as { name: string }).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});

describe('the screens socket refuses what it should', () => {
  it('routes a screen path, and refuses anything that is not a screen', () => {
    expect(routeOf('/manager')).toEqual({ screen: 'manager', file: 'index.html' });
    expect(routeOf('/manager/app.js')).toEqual({ screen: 'manager', file: 'app.js' });
    expect(routeOf('/owner/?x=1')).toEqual({ screen: 'owner', file: 'index.html' });
    expect(routeOf('/payroll')).toBeNull();
    expect(routeOf('/')).toBeNull();
  });

  it('refuses a path that climbs out of the screen’s folder', () => {
    // The oldest request in the book, and this server reads files from disk by name.
    for (const attack of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '/etc/passwd', 'a/../../b']) {
      expect(safeFile(attack), attack).toBeNull();
    }
  });

  it('allows an ordinary file inside the folder', () => {
    expect(safeFile('app.js')).toBe('app.js');
    expect(safeFile('manifest.webmanifest')).toBe('manifest.webmanifest');
  });

  it('decodes BEFORE it checks, because %2e%2e is not .. until it is decoded', () => {
    expect(safeFile('%2e%2e/secrets')).toBeNull();
  });
});

/**
 * **The sale facts the reporting screen is built on.**
 *
 * The screen's own rules are tested against its ports; this is the other side of the socket, where
 * a sale in this box's log becomes a fact a report is worked out from. Two of the conversions are
 * the sort that fail silently — the answer is simply wrong, on a screen, in the space where a real
 * figure goes, and nothing anywhere says so.
 */
describe('a sale in the log becomes a reporting fact, correctly', () => {
  const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
    pack: fullPack(), sales: [sale()], unreadableRecords: 0, outbox: new SyncOutbox(),
    now: NOW, tradingDay: DAY, ...over,
  });
  const first = (over: Partial<ScreenInput> = {}): Record<string, unknown> =>
    (reportingPayload(input(over))!['sales'] as Record<string, unknown>[])[0]!;

  it('costs a countable line by the count, not by the thousandth', () => {
    // One 1kg pack of dal costs ₹100. Dividing by a thousand — right for weighed goods, wrong for
    // everything countable — makes it 10 paise, and the margin report then says 99.92%, which is
    // the "100% margin reads as very good news" lie arrived at from the other side. Nothing fails.
    expect(first()['cogsMinor']).toBe(100_00);
  });

  it('costs a weighed line by the weight', () => {
    // 1.5kg of tomatoes at ₹50/kg is ₹75 — held as 1500, so the thousandths DO apply here.
    const weighed = sale({ lines: [{ productId: 'p2', quantityMinor: 1_500, uom: 'kg' }] });
    expect(first({ sales: [weighed] })['cogsMinor']).toBe(75_00);
  });

  it('counts a basket by the items in it, and a weighed line as one item', () => {
    const mixed = sale({
      lines: [
        { productId: 'p1', quantityMinor: 3, uom: 'ea' },
        { productId: 'p2', quantityMinor: 1_500, uom: 'kg' },
      ],
    });
    // Three packs and some tomatoes is four things in the basket, not 1,503.
    expect(first({ sales: [mixed] })['units']).toBe(4);
  });

  it('carries NO cost at all when one line in the basket has no cost price', () => {
    // Zero cost reports a 100% margin. The sale keeps its takings and loses only its margin.
    const unpriced = sale({ lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] });
    const row = first({ sales: [unpriced] });
    expect('cogsMinor' in row).toBe(false);
    expect(row['totalMinor']).toBe(145_00);
  });

  it('carries NO basket size when the record has no readable lines', () => {
    const broken = sale({ lines: undefined });
    expect('units' in first({ sales: [broken] })).toBe(false);
  });

  it('serves nothing at all when the box has no freshness thresholds', () => {
    expect(reportingPayload(input({ pack: fullPack({ reportingPolicy: notKnown('never sent') }) }))).toBeNull();
  });

  it('names no user rather than inventing one', () => {
    // The audit record of an export names who took the data; a default there is a name nobody holds.
    const anonymous = reportingPayload(input({
      pack: fullPack({ reportingPolicy: known({ laggingAfterMinutes: 5, staleAfterMinutes: 60 }) }),
    }))!;
    expect('userId' in anonymous).toBe(false);
    expect(reportingPayload(input())!['userId']).toBe('u-report');
  });
});

/**
 * **The day boundary — the one this box did not have.**
 *
 * `sales.log` is append-only and never rotated, so the box holds every sale it has ever committed.
 * Every screen that meant *today* was handed all of it, and the defect compounds daily. Nothing
 * crashed and no test went red: the owner's phone simply reported the week's takings as the day's.
 *
 * Worse than the wrong number, the manager's exception register — which the **day close gates on**
 * — counted a refund from last Tuesday against today's limit. On a box a fortnight old, a shop in
 * which nothing at all went wrong could no longer close its day, and there was nothing anybody
 * could do to clear it.
 */
describe('the box tells each screen about ONE trading day', () => {
  const on = (id: string, tradingDay: string, total: number) => ({
    id, number: id, laneId: 'lane-1', cashierId: 'u-meena', tradingDay,
    committedAt: `${tradingDay}T10:00:00.000Z`, total, netMinor: total, taxMinor: 0, currency: 'INR',
    lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }],
    tenders: [{ kind: 'cash', amount: { minor: total } }],
  });

  /** A box that has been trading since Saturday. Today is DAY, and today took ₹145. */
  const week = [
    on('S-SAT', '2026-08-01', 500_00),
    on('S-SUN', '2026-08-02', 700_00),
    on('S-MON', '2026-08-04', 900_00),
    on('S-TODAY', DAY, 145_00),
  ];

  const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
    pack: fullPack(), sales: week, unreadableRecords: 0, outbox: new SyncOutbox(),
    now: NOW, tradingDay: DAY, ...over,
  });

  it('reports the OWNER today’s takings, not the whole log’s', () => {
    const payload = ownerPayload(input())!;
    const uncostable = payload['uncostable'] as { takenMinor: number; billCount: number };
    expect(uncostable.takenMinor, 'the week was reported as the day').toBe(145_00);
    expect(uncostable.billCount).toBe(1);
    const branch = (payload['branches'] as { sales: unknown[] }[])[0]!;
    expect(branch.sales).toHaveLength(1);
  });

  it('reports the REPORTING screen today’s sales, not the whole log’s', () => {
    const payload = reportingPayload(input())!;
    expect(payload['sales']).toHaveLength(1);
    expect(payload['tradingDay']).toBe(DAY);
  });

  it('judges the MANAGER’s exception limits against today alone', () => {
    // The register the day close gates on. A "no more than one refund" limit counted against every
    // refund since the box was installed breaches on day two and never stops breaching.
    const refunds = [
      { ...on('R-OLD', '2026-08-01', -50_00), cashierId: 'u-meena' },
      { ...on('R-OLD2', '2026-08-04', -50_00), cashierId: 'u-meena' },
      { ...on('R-TODAY', DAY, -50_00), cashierId: 'u-meena' },
    ];
    const payload = managerPayload(input({
      sales: refunds,
      pack: fullPack({ lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]) }),
    }));
    // One refund today is inside a limit of two. Three across the week is not — and the week is
    // not what the limit is about.
    expect(payload['openExceptions'], 'yesterday’s refunds held today’s day close').toEqual([]);
  });

  it('still counts every day the box holds for the comparison', () => {
    // The whole log is not thrown away — it is what makes a comparison possible at all.
    const totals = reportingPayload(input())!['dayTotals'] as { tradingDay: string; totalMinor: number }[];
    expect(totals.map((d) => d.tradingDay)).toEqual([DAY, '2026-08-04', '2026-08-02', '2026-08-01']);
    expect(totals[1]?.totalMinor).toBe(900_00);
  });

  it('puts a sale with NO trading day in nobody’s figures, and says so', () => {
    // Including it puts another day's money in today's takings; dropping it silently loses real
    // takings from a total somebody reconciles against the till roll.
    const withUndated = input({ sales: [...week, { ...on('S-??', DAY, 999_00), tradingDay: undefined }] });
    const owner = ownerPayload(withUndated)!;
    expect((owner['uncostable'] as { takenMinor: number }).takenMinor).toBe(145_00);
    expect((owner['branches'] as { undatedSales?: number }[])[0]?.undatedSales).toBe(1);

    const manager = managerPayload(withUndated);
    const exceptions = manager['openExceptions'] as { id: string; what: string }[];
    expect(exceptions.map((e) => e.id)).toContain('edge:undated-sales');
    expect(exceptions.find((e) => e.id === 'edge:undated-sales')?.what).toContain("nobody's figures");
  });

  it('keeps the range check over the WHOLE log, which is a different question', () => {
    // "Has this shop ever sold something it does not range?" — an item that sold last Tuesday is
    // exactly as much evidence as one that sold this morning.
    const sold = merchandisingPayload(input())!['soldProductIds'] as string[];
    expect(sold).toEqual(['p1']);
  });
});

describe('the manager\'s payload carries who runs the screen, where and which day — from the pack, never defaulted (Stage G slice 5c)', () => {
  it('names the manager, their limit, the branch, the cut-off, the count threshold, the warehouse and the trading day', () => {
    const payload = managerPayload(input({ pack: fullPack() }));
    expect(payload['userId']).toBe('u-mgr');
    expect(payload['approvalLimitMinor']).toBe(500_000);
    expect(payload['storeId']).toBe('store-1');
    expect(payload['branchId']).toBe('b1');
    expect(payload['tradingDayCutoff']).toBe('02:00');
    expect(payload['countApprovalThresholdMinor']).toBe(100_00);
    expect(payload['warehouseId']).toBe('wh-1');
    expect(payload['tradingDay']).toBe(DAY);
  });

  it('a pack that names no manager yields NO userId — the screen then names nobody and refuses to decide', () => {
    const payload = managerPayload(input({ pack: fullPack({ managerPolicy: notKnown('not named') }) }));
    expect('userId' in payload).toBe(false);
    expect('approvalLimitMinor' in payload).toBe(false);
    expect(payload['branchId']).toBe('b1');
  });

  it('a limit the pack leaves out is served as null (no limit), and a company-wide branch as null — never dropped', () => {
    const payload = managerPayload(input({ pack: fullPack({
      managerPolicy: known({ userId: 'u-owner' }),
      policies: known({ storeId: 'store-1', branchId: null, branchName: 'HQ', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'wh-1' }),
    }) }));
    expect(payload['approvalLimitMinor']).toBeNull();
    expect(payload['branchId']).toBeNull();
  });
});

describe('a product with a unit of measure the till cannot price is kept OFF the lane, and named (Stage G slice 5c)', () => {
  it('excludes it with the reason, like a missing tax rate — no more ₹NaN on a line', () => {
    const payload = posPayload(input({ pack: fullPack({ products: known([{ ...PRODUCTS[0]!, uom: 'each' }]) }) }))!;
    expect(payload['products']).toEqual([]);
    expect(payload['excludedProducts']).toEqual([
      { productId: 'p1', name: 'Toor dal 1kg', why: 'unknown unit of measure "each" on the catalogue' },
    ]);
  });

  it('still ships a RECALLED product with a bad unit, WITH its block, so the lane refuses it by name', () => {
    const payload = posPayload(input({ pack: fullPack({ products: known([{ ...PRODUCTS[0]!, uom: 'each', recallBlock: true }]) }) }))!;
    const products = payload['products'] as { productId: string; recallBlock?: boolean }[];
    expect(products.map((p) => [p.productId, p.recallBlock])).toEqual([['p1', true]]);
  });
});

// ── SP-9-i (F13 · P-02): the till sells from the catalogue head office PUBLISHED and this box PULLED — the file is the fallback ──
describe('the till is built from the pulled head-office pack once the box holds one, and from the pack file until then (SP-9-i · F13 · P-02)', () => {
  const HO_KEY = ['head', 'office', 'pack', 'key'].join('-').padEnd(48, '0');
  const headOffice = (over: Partial<CatalogueSnapshot> = {}): SignedPack => {
    const snapshot: CatalogueSnapshot = {
      tenantId: 't-sre', scope: { tenantId: 't-sre', storeId: 'S1' }, version: 12, builtAt: '2026-10-01T04:00:00.000Z',
      products: [
        { productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 500, hsnCode: '0405', mrpMinor: 70_000, status: 'active' },
        { productId: 'P2', sku: 'BEER-650', name: 'Lager 650ml', baseUom: 'ea', unitPriceMinor: 18_000, taxBps: 2800, status: 'active', regulatedFlags: { minimumAge: 21 } },
        { productId: 'P3', sku: 'TIN-400', name: 'Recalled tin', baseUom: 'ea', unitPriceMinor: 9_000, taxBps: 500, status: 'clearance', recallBlock: true, batchTracked: true },
        { productId: 'P4', sku: 'ODD', name: 'Odd unit', baseUom: 'each', unitPriceMinor: 1_000, taxBps: 500, status: 'active' },
        { productId: 'P5', sku: 'OLD', name: 'Discontinued', baseUom: 'ea', unitPriceMinor: 1_000, taxBps: 500, status: 'discontinued' },
      ],
      barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }, { code: '8901234567891', productId: 'P1', kind: 'alternate' }, { code: '2000001000005', productId: 'P2', kind: 'price_embedded' }],
      embeddedRules: [],
      ...over,
    };
    const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(HO_KEY), publishedBy: 'u-owner', publishedAt: snapshot.builtAt });
    if (!result.ok || result.pack === undefined) throw new Error(result.detail);
    return result.pack;
  };

  it('with a pulled pack held, the till is head office\'s catalogue — version, build time, store scope, prices, tax, HSN, MRP, every barcode with its kind, the age flag and the recall block as published', () => {
    const payload = posPayload(input({ cataloguePack: headOffice() }))!;
    expect(payload).toMatchObject({ source: 'head_office', tenantId: 't-sre', version: 12, builtAt: '2026-10-01T04:00:00.000Z', scope: { storeId: 'S1' }, embeddedRules: [] });
    const products = payload['products'] as Record<string, unknown>[];
    expect(products.map((p) => p['productId'])).toEqual(['P1', 'P2', 'P3', 'P5']); // P4's unit the till cannot price: excluded, named
    expect(products[0]).toEqual({ productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 500, hsnCode: '0405', mrpMinor: 70_000, status: 'active' });
    expect(products[1]).toMatchObject({ productId: 'P2', regulatedFlags: { minimumAge: 21 } });
    expect(products[2]).toMatchObject({ productId: 'P3', recallBlock: true, batchTracked: true, status: 'clearance' });
    expect(payload['barcodes']).toEqual([
      { code: '8901234567890', productId: 'P1', kind: 'standard' }, { code: '8901234567891', productId: 'P1', kind: 'alternate' }, { code: '2000001000005', productId: 'P2', kind: 'price_embedded' },
    ]);
    expect(payload['excludedProducts']).toEqual([{ productId: 'P4', name: 'Odd unit', why: 'unknown unit of measure "each" on the catalogue' }]);
    // The file's products (seven of them, v7) are NOT what the lane sells from any more.
    expect(products.some((p) => p['productId'] === 'p1')).toBe(false);
    // …and it builds a real lane catalogue.
    expect(new CatalogueCache(payload as never).scan('8901234567890').product.unitPriceMinor).toBe(64_000);
  });

  it('the file\'s master still wins a SAFETY argument: a recall only the master knows blocks the pulled product too (either source says blocked → blocked)', () => {
    const master = [{ productId: 'P1', tenantId: 't-sre', sku: 'GHEE-1L', name: 'Ghee 1L', primaryCategoryId: null, baseUom: 'ea', taxClass: null, lifecycle: 'active' as const, recallBlocked: true }];
    const payload = posPayload(input({ pack: fullPack({ productMaster: known(master) }), cataloguePack: headOffice() }))!;
    expect((payload['products'] as { productId: string; recallBlock?: boolean }[]).find((p) => p.productId === 'P1')?.recallBlock).toBe(true);
  });

  it('the "products nobody can sell" screen judges the SAME catalogue the till sells from, and counts against it', () => {
    const rows = unsellableProducts(fullPack(), headOffice());
    expect(rows.map((r) => [r.productId, r.why])).toEqual([['P3', 'recall_block'], ['P4', 'unknown_uom'], ['P5', 'not_on_sale']]);
    const payload = unsellablePayload(input({ cataloguePack: headOffice() }))!;
    expect(payload).toMatchObject({ source: 'head_office', asAt: '2026-10-01T04:00:00.000Z', sellableCount: 2 });
    expect((payload['rows'] as { productId: string }[]).map((r) => r.productId)).toEqual(['P3', 'P4', 'P5']);
  });

  it('with NO pulled pack the file is the catalogue, named as such — and with neither, the till has none', () => {
    const fromFile = posPayload(input())!;
    expect(fromFile).toMatchObject({ source: 'pack_file', version: 7, tenantId: 'store-1' });
    expect((fromFile['barcodes'] as { kind: string }[]).every((b) => b.kind === 'ean13')).toBe(true);
    expect(unsellablePayload(input())).toMatchObject({ source: 'pack_file' });
    expect(tillCatalogue(fullPack({ products: notKnown('none') }), undefined, NOW)).toBeUndefined();
    expect(posPayload(input({ pack: fullPack({ products: notKnown('none') }) }))).toBeNull();
    // A pulled pack with a file that carries no products: the till still has head office's catalogue.
    expect(posPayload(input({ pack: fullPack({ products: notKnown('none') }), cataloguePack: headOffice() }))).toMatchObject({ source: 'head_office', version: 12 });
  });
});

// ── SP-8c-ii: the "Products nobody can sell" screen reads the SAME judgement the till payload is built from ──────────
describe('the products nobody can sell: one judgement for the till and for the person who can fix it (SP-8c-ii · P-08)', () => {
  const catalogue = [
    { productId: 'ok', name: 'Sells', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: ['1'], availableMinor: 5, taxBps: 500, status: 'active' },
    { productId: 'notax', name: 'No tax', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: [], availableMinor: 5, status: 'active' },
    { productId: 'nostatus', name: 'No status', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: [], availableMinor: 5, taxBps: 500 },
    { productId: 'unit', name: 'Odd unit', nameTa: 'வித்தியாச அலகு', categoryId: 'c', unitPriceMinor: 100, uom: 'each', barcodes: [], availableMinor: 5, taxBps: 500, status: 'active' },
    { productId: 'recalled', name: 'Recalled tin', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: ['2'], availableMinor: 5, taxBps: 500, status: 'clearance', recallBlock: true },
    { productId: 'draft', name: 'Not yet', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: [], availableMinor: 0, taxBps: 500, status: 'draft' },
    // Recalled only on the MASTER, with a gap the till would otherwise drop it for: recall wins, and it is shipped with its block.
    { productId: 'master-recall', name: 'Master says recalled', categoryId: 'c', unitPriceMinor: 100, uom: 'ea', barcodes: [], availableMinor: 5, status: 'active' },
  ];
  const master = [{ productId: 'master-recall', tenantId: 't1', sku: 'MR', name: 'Master says recalled', primaryCategoryId: null, baseUom: 'ea', taxClass: null, lifecycle: 'active' as const, recallBlocked: true }];
  const withGaps = () => input({ pack: fullPack({ products: known(catalogue), productMaster: known(master) }) });

  it('names every product the till cannot sell with WHY and the box\'s own sentence, recall first and from either source', () => {
    const rows = unsellableProducts(withGaps().pack);
    expect(rows.map((r) => [r.productId, r.why])).toEqual([
      ['notax', 'no_tax_rate'], ['nostatus', 'no_status'], ['unit', 'unknown_uom'], ['recalled', 'recall_block'], ['draft', 'not_on_sale'], ['master-recall', 'recall_block'],
    ]);
    expect(rows.find((r) => r.productId === 'unit')).toMatchObject({ nameTa: 'வித்தியாச அலகு', detail: 'unknown unit of measure "each" on the catalogue' });
    expect(rows.find((r) => r.productId === 'draft')?.detail).toBe('status "draft" on the catalogue — refused at the till');
  });

  it('the till payload is built from that list: exactly the catalogue GAPS are excluded (with the same words), the recalled and the off-sale ones are shipped and refused by name', () => {
    const payload = posPayload(withGaps())!;
    const rows = unsellableProducts(withGaps().pack);
    const gaps = rows.filter((r) => r.why === 'no_tax_rate' || r.why === 'no_status' || r.why === 'unknown_uom');
    expect(payload['excludedProducts']).toEqual(gaps.map((r) => ({ productId: r.productId, name: r.name, why: r.detail })));
    const shipped = (payload['products'] as { productId: string; recallBlock?: boolean; status: string }[]);
    expect(shipped.map((p) => p.productId).sort()).toEqual(['draft', 'master-recall', 'ok', 'recalled']);
    expect(shipped.find((p) => p.productId === 'recalled')?.recallBlock).toBe(true);
    expect(shipped.find((p) => p.productId === 'master-recall')?.recallBlock).toBe(true);
    expect(shipped.find((p) => p.productId === 'draft')?.status).toBe('draft');
  });

  it('feeds the screen the same rows, when the catalogue was judged, and how many the till CAN sell; nothing at all when the box has no catalogue', () => {
    const payload = unsellablePayload(withGaps())!;
    expect(payload['storeId']).toBe('store-1');
    expect(payload['sellableCount']).toBe(1);
    expect((payload['rows'] as { productId: string; reason: string; detail: string }[]).map((r) => r.productId)).toEqual(['notax', 'nostatus', 'unit', 'recalled', 'draft', 'master-recall']);
    expect((payload['rows'] as { reason: string }[])[3]?.reason).toBe('recall_block');
    expect(typeof payload['asAt']).toBe('string');
    expect(unsellablePayload(input({ pack: fullPack({ products: notKnown('never') }) }))).toBeNull();
    // A clean catalogue is an empty list, not an absent payload — "all clear" is a statement the screen may make only when told so.
    expect(unsellablePayload(input({ pack: fullPack({ products: known([catalogue[0]!]) }) }))).toMatchObject({ rows: [], sellableCount: 1 });
  });
});
