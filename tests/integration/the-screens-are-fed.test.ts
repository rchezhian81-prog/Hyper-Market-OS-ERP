import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from '../../edge/store-edge/src/screen-server';
import { GLOBAL_FOR, SCREENS, type ScreenInput, type ScreenName } from '../../edge/store-edge/src/screen-data';
import { known, notKnown, type PackProduct, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { LoggedSale } from '../../edge/store-edge/src/read-model';
import { SyncOutbox } from '../../packages/sync/src/index';
import { CatalogueCache } from '../../packages/catalogue/src/index';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack, type SignedPack } from '../../services/catalogue/src/pack';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { resolvePrice } from '../../packages/price-list/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  bootAdmin, bootAi, bootBuying, bootCatalogue, bootExpiry, bootFinance, bootManager, bootMerchandising, bootMigration, bootReporting, bootService,
  buyingGaps, catalogueGaps, merchandisingGaps,
} from '../../apps/web-erp/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { bootShop, forgetfulBasket } from '../../apps/customer-app/src/browser-entry';
import { bootPicker } from '../../apps/picker-app/src/browser-entry';
import { bootWarehouse, type WarehouseAssignment } from '../../apps/warehouse-app/src/index';
import { bootWarehouseSupervisor, type SupervisorData } from '../../apps/web-erp/src/warehouse-supervisor-session';
import { bootDriver } from '../../apps/delivery-app/src/browser-entry';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import type { PackDelivery, PackDriver } from '../../edge/store-edge/src/store-pack';

/**
 * **The join, driven end to end over a real socket.**
 *
 * Every screen was built to read a global at boot and nothing ever set one, so six screens sat
 * honestly reporting that they had been told nothing. This proves the box now tells them — by
 * starting the real server, fetching the real shells from disk, pulling the injected payload out
 * of the HTML, and booting each screen's real session on it.
 *
 * Nothing is stubbed. If the marker were missing from a shell, if a payload builder produced the
 * wrong shape, or if a screen's global were renamed, this fails.
 *
 * **The headline case is the manager's day close.** It has refused to close for three sessions,
 * correctly, because the two registers it gates on had no producer anywhere. They do now.
 */

const NOW = '2026-08-05T14:00:00.000Z';
const DAY = '2026-08-05';

const PRODUCTS: PackProduct[] = [
  {
    productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00,
    unitCostMinor: 100_00, uom: 'ea', barcodes: ['8901'], availableMinor: 10,
    taxBps: 500, status: 'active',
  },
];

const SALE: LoggedSale = {
  id: 'S-1', number: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: DAY,
  committedAt: NOW, total: 145_00, netMinor: 122_88, taxMinor: 22_12, currency: 'INR',
  lines: [{ productId: 'p1', quantityMinor: 1, uom: 'ea' }],
  tenders: [{ kind: 'cash', amount: { minor: 145_00 } }],
};

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
  { storeId: 'store-1', productId: 'p-milk', locationId: 'L-COLD', capacityMinor: 60, primary: true },
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

const pack = (over: Partial<StorePack> = {}): StorePack => ({
  receivedAt: NOW,
  version: 7,
  policies: known({
    storeId: 'store-1', branchId: 'b1', branchName: 'SRE Hyper Market',
    tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_00,
    handoverToleranceMinor: 100_00, privacySlaDays: 30, warehouseId: 'wh-1',
  }),
  products: known(PRODUCTS),
  approvals: known([{
    id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg',
    requestedBy: 'u-buyer', branchId: 'b1', valueMinor: 45_000,
  }]),
  checklist: known([]),
  wave: known({
    waveId: 'w1', pickerId: 'u-picker',
    // Deliberately in the order a CUSTOMER would type it: milk, dal, milk again. Nothing had ever
    // re-sequenced a wave, so this is exactly the walk a picker used to be given.
    lines: [
      {
        lineId: 'l0', orderRef: 'ORD-1', productId: 'p-milk', description: 'Milk 1L',
        bin: 'C-01', requiredQty: 1, uom: 'ea', unitPriceMinor: 60_00,
      },
      {
        lineId: 'l1', orderRef: 'ORD-1', productId: 'p1', description: 'Toor dal 1kg',
        bin: 'A-01', requiredQty: 2, uom: 'ea', unitPriceMinor: 145_00,
      },
    ],
  }),
  route: known({
    routeId: 'r1', driverId: 'd1',
    stops: [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 250_00 }],
  }),
  deliveries: known([]),
  drivers: known([]),
  routingPolicy: known({
    storeLocation: { lat: 11, lon: 77 }, radiusMetres: 10_000,
    averageSpeedKmh: 20, serviceMinutesPerStop: 5,
  }),
  slots: known([{
    slotId: 'today-evening', startsAt: '2026-08-05T17:00:00.000Z',
    endsAt: '2026-08-05T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery',
  }]),
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
  reportingPolicy: known({ laggingAfterMinutes: 5, staleAfterMinutes: 60, userId: 'u-report' }),
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
  lossPreventionRules: known([{ kind: 'refund', maxCount: 2 }]),
  consentPurposes: known([{ purpose: 'marketing', channel: 'sms' }]),
  warehouse: known({
    assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
    bins: [{ binId: 'B-1', storeId: 'store-1', capacityMinor: 100, pickable: true }],
    goodsIn: [{ productId: 'p1', batchId: null, quantityMinor: 10, uom: 'ea', state: 'on_hand', expiry: null }],
    barcodes: [{ barcode: '8901', productId: 'p1', level: 'unit' }],
    ordered: [{ productId: 'p1', quantityMinor: 10, unitCostMinor: 100_00, currency: 'INR' }],
    grnId: 'GRN-1',
  }),
  ...over,
});

const STORE = { lat: 11.0, lon: 77.0 };
const DELIVERIES: PackDelivery[] = [
  { orderId: 'ORD-1', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Anna Nagar', location: { lat: 11.04, lon: 77.0 }, codMinor: 250_00 },
  { orderId: 'ORD-2', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Gandhipuram', location: { lat: 11.005, lon: 77.0 }, codMinor: 0 },
  { orderId: 'ORD-3', slotId: 'evening', slotStartsAt: '2026-08-05T17:00:00.000Z', slotEndsAt: '2026-08-05T19:00:00.000Z', area: 'Unknown', codMinor: 0 },
];
const DRIVERS: PackDriver[] = [
  { driverId: 'd1', maxStops: 10, availableFrom: '2026-08-05T16:00:00.000Z', availableUntil: '2026-08-05T21:00:00.000Z' },
];
const ROUTING = {
  storeLocation: STORE, radiusMetres: 10_000, averageSpeedKmh: 20, serviceMinutesPerStop: 5,
};

const servers: ScreenServer[] = [];
afterAll(async () => { for (const s of servers) await s.stop(); });

/** Start the real server against the real `apps/` folder on disk. */
async function serve(snapshot: () => ScreenInput): Promise<string> {
  const server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot });
  servers.push(server);
  return `http://${SCREEN_HOST}:${server.port}`;
}

const snapshotOf = (over: Partial<ScreenInput> = {}): (() => ScreenInput) => () => ({
  pack: pack(), sales: [SALE], unreadableRecords: 0, outbox: new SyncOutbox(),
  now: NOW, tradingDay: DAY, ...over,
});

/** Fetch a screen and pull the payload the box injected out of its HTML. */
async function payloadFromScreen(base: string, screen: ScreenName): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${base}/${screen}`);
  expect(response.status, `${screen} did not serve`).toBe(200);
  const html = await response.text();
  const global = GLOBAL_FOR[screen];
  const match = new RegExp(`<script>window\\.${global} = ([\\s\\S]*?);</script>`).exec(html);
  if (match === null) {
    // The box had nothing to say for this screen — a real, supported state. The pack-age badge
    // (SYNC-01) may still have replaced the marker with its own tag, so the honest invariant is that
    // the screen's OWN global is genuinely absent, not that the raw marker survived.
    expect(html, `${screen} unexpectedly carries its global`).not.toContain(`window.${global} =`);
    return null;
  }
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

/** Pull the pack-age badge (`window.catalogueFreshness`) the box injected out of a screen's HTML. */
async function freshnessFromScreen(base: string, screen: ScreenName): Promise<Record<string, unknown> | null> {
  const html = await (await fetch(`${base}/${screen}`)).text();
  const match = /<script>window\.catalogueFreshness = ([\s\S]*?);<\/script>/.exec(html);
  return match === null ? null : JSON.parse(match[1]!) as Record<string, unknown>;
}

function signedCatalogue(version: number, builtAt: string): SignedPack {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version, builtAt,
    products: [{ productId: 'P1', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(['screens', 'fed', 'freshness'].join('-').padEnd(48, '0')), publishedBy: 'u', publishedAt: builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe('every screen carries the pack-age badge (SYNC-01, P-08)', () => {
  it('injects the catalogue version and age from the real server, on every screen', async () => {
    const base = await serve(snapshotOf({ cataloguePack: signedCatalogue(9, '2026-08-05T09:00:00.000Z') }));
    for (const screen of SCREENS) {
      const badge = await freshnessFromScreen(base, screen);
      expect(badge, `${screen} missing pack-age badge`).toMatchObject({ known: true, version: 9, ageHours: 5 });
    }
  });

  it('says the age is not known when the box has pulled no catalogue — never a false "fresh"', async () => {
    const base = await serve(snapshotOf()); // no cataloguePack
    expect(await freshnessFromScreen(base, 'manager')).toEqual({ known: false });
  });
});

describe('every screen is served, and served its own data', () => {
  it('serves all six shells from disk with their payload injected', async () => {
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const payload = await payloadFromScreen(base, screen);
      expect(payload, `${screen} was served nothing`).not.toBeNull();
    }
  });

  it('serves each screen’s static files too, so the shell actually runs', async () => {
    const base = await serve(snapshotOf());
    const response = await fetch(`${base}/manager/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
  });

  it('refuses anything that is not a screen, and anything that climbs out', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/payroll`)).status).toBe(404);
    expect((await fetch(`${base}/manager/..%2f..%2f..%2fpackage.json`)).status).toBe(400);
    expect((await fetch(`${base}/manager/nothing-here.js`)).status).toBe(404);
  });

  it('refuses to be written to — this socket only reads', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/manager`, { method: 'POST' })).status).toBe(405);
  });

  it('sends the payload FRESH on every request, not the state at boot', async () => {
    // A manager reloading at four o'clock must see four o'clock's queue.
    const outbox = new SyncOutbox();
    const base = await serve(snapshotOf({ outbox }));
    expect((await payloadFromScreen(base, 'manager'))!['unsentItems']).toEqual([]);

    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    expect((await payloadFromScreen(base, 'manager'))!['unsentItems']).toHaveLength(1);
  });
});

describe('the manager’s day close — the loop that has been open for three sessions', () => {
  const manager = (payload: Record<string, unknown>) => bootManager({
    storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
    managerId: 'u-mgr', approvalLimitMinor: 500_000, warehouseId: 'wh-1',
    data: payload as Parameters<typeof bootManager>[0] extends undefined ? never : NonNullable<Parameters<typeof bootManager>[0]>['data'],
  });

  it('CLOSES a clean day, now that both gates have a producer', async () => {
    // The whole point of the session. Every previous run refused — correctly — because the
    // exception register and the unsent register had nothing behind them anywhere in the system.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-1', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(true);
    if (!attempt.closed) return;
    expect(attempt.result.locked).toBe(true);
  });

  it('still refuses when something really is unsent', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const base = await serve(snapshotOf({ outbox }));
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-2', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]).toMatchObject({ kind: 'items_unsent', count: 1 });
  });

  it('still refuses when the box was never told the loss-prevention rules', async () => {
    // The section is absent, so the screen says "not known" — and a day is not locked on a
    // register nobody ever checked. This is the control that has been holding all along.
    const base = await serve(snapshotOf({ pack: pack({ lossPreventionRules: notKnown('no rules sent') }) }));
    const payload = (await payloadFromScreen(base, 'manager'))!;

    const attempt = manager(payload).closeTheDay({
      dayCloseId: 'dc-3', closedAtLocal: '2026-08-05T02:30', closedAt: NOW,
    });
    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers[0]).toMatchObject({ kind: 'cannot_see', source: 'exceptions' });
  });

  it('shows the approval the cloud routed here, and lets the manager clear it', async () => {
    const base = await serve(snapshotOf());
    const session = manager((await payloadFromScreen(base, 'manager'))!);

    const queue = session.approvalQueue();
    expect(queue.known).toBe(true);
    if (!queue.known) return;
    expect(queue.rows[0]?.request.id).toBe('a1');

    const outcome = session.decideApproval({
      requestId: 'a1', decision: 'approved', reasonCode: 'checked_the_stock', decidedAt: NOW,
    });
    expect(outcome.ok).toBe(true);
  });

  it('can value a stock count, because the box served the cost prices', async () => {
    // Without them the count is refused rather than valued at nothing — proved from the other side
    // in the manager's own tests. This is the half that makes it work in a real shop.
    const base = await serve(snapshotOf());
    const session = manager((await payloadFromScreen(base, 'manager'))!);
    const attempt = session.countStock({
      countId: 'c-1', productId: 'p1', locationId: 'aisle-1', uom: 'ea',
      countedMinor: 0, reasonCode: 'shrinkage', at: NOW,
    });
    expect(attempt.counted).toBe(true);
  });
});

describe('the other five screens boot on what the box served them', () => {
  it('the owner’s brief carries the day’s real takings and a real margin', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'owner'))!;
    const session = bootOwner(payload as Parameters<typeof bootOwner>[0], forgetfulQueueStore(), () => NOW)!;

    const brief = session.brief();
    expect(brief.kpis.grossSalesMinor).toBe(145_00);
    // ₹122.88 net − ₹100.00 cost. A margin that could only exist because the pack carried a cost.
    expect(brief.kpis.marginMinor).toBe(122_88 - 100_00);
    expect(brief.freshness.state).toBe('fresh');
  });

  it('the owner’s figures exclude what could not be costed, and say how many', async () => {
    const uncosted: LoggedSale = { ...SALE, id: 'S-2', lines: [{ productId: 'p-unknown', quantityMinor: 1, uom: 'ea' }] };
    const base = await serve(snapshotOf({ sales: [SALE, uncosted] }));
    const payload = (await payloadFromScreen(base, 'owner'))!;

    expect(payload['uncostable']).toMatchObject({ sales: 1, billCount: 2, products: ['p-unknown'] });
    const session = bootOwner(payload as Parameters<typeof bootOwner>[0], forgetfulQueueStore(), () => NOW)!;
    // One bill in the margin figures, two bills taken. Both true, and the gap is named.
    expect(session.brief().kpis.basketCount).toBe(1);
  });

  it('the customer app opens a real catalogue, tied to the pack version', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'customer'))!;
    const shop = bootShop(payload as Parameters<typeof bootShop>[0], forgetfulBasket(), () => 'DSR-1')!;

    // The hits ARRAY — the shape the engine actually returns. The view read `.hits` and reported
    // "nothing matched that" for every search there has ever been; found by driving this path.
    expect(shop.search('toor').length).toBeGreaterThan(0);
    expect(shop.search('toor')[0]?.product.name).toBe('Toor dal 1kg');
    expect(shop.slots()).toHaveLength(1);
    // The version is what lets a stale price be refused rather than quietly repriced (P-02).
    expect(payload['packVersion']).toBe(7);
  });

  it('the picker opens the wave the cloud assigned', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const wave = bootPicker(payload as Parameters<typeof bootPicker>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;

    expect(wave.work()).toHaveLength(2);
    expect(wave.work()[0]?.bin).toBe('A-01');
  });

  it('the driver opens the route the cloud dispatched', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'driver'))!;
    const route = bootDriver(payload as Parameters<typeof bootDriver>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;

    expect(route.route()).toHaveLength(1);
    expect(route.route()[0]?.codMinor).toBe(250_00);
  });

  it('the warehouse handheld opens the assignment the cloud gave it, and puts stock away over the socket', async () => {
    // The whole chain for the OA-9 PWA: the box serves the warehouse assignment, the real offline
    // session boots on it, and a put-away is decided by the authoritative engine — over a real socket.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'warehouse'))!;
    const session = bootWarehouse(payload as unknown as WarehouseAssignment, new DeviceOutbox(noDeviceStore()), () => NOW)!;

    expect(session).not.toBeNull();
    expect(session.goodsIn()).toHaveLength(1); // the goods-in the pack carried
    const put = session.putAway({ commandId: 'm1', scannedProductId: 'p1', scannedBinId: 'B-1', quantityMinor: 10, uom: 'ea', at: NOW });
    expect(put.result.accepted).toBe(true);
    expect(session.binContents()['B-1|p1|']).toBe(10);
  });

  it('the warehouse supervisor opens the oversight the box served — occupancy, stock and exceptions', async () => {
    // The supervisory half over the same socket: bin occupancy + stock from the served contents, and
    // the exception queue (here, a bin packed over its capacity). Same authoritative data as the handheld.
    const base = await serve(snapshotOf({
      pack: pack({
        warehouse: known({
          assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
          bins: [{ binId: 'B-1', storeId: 'store-1', capacityMinor: 100, pickable: true }],
          contents: { 'B-1|p1|': 40, 'B-1|p2|': 80 }, // 120 in a bin of 100 → over capacity
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'warehouse-supervisor'))!;
    const s = bootWarehouseSupervisor(payload as unknown as SupervisorData)!;

    expect(s).not.toBeNull();
    expect(s.bins()[0]).toMatchObject({ binId: 'B-1', usedMinor: 120, pctFull: 120 });
    const stock = s.stock();
    expect(stock.known).toBe(true);
    const ex = s.exceptions();
    expect(ex.known).toBe(true);
    if (!ex.known) return;
    expect(ex.rows.some((r) => r.kind === 'over_capacity' && r.binId === 'B-1')).toBe(true);
  });

  it('the supervisor decides a §28 approval served over the socket, and it queues for sync', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        warehouse: known({
          assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
          bins: [{ binId: 'B-1', storeId: 'store-1', capacityMinor: 100, pickable: true }],
          supervisor: { userId: 'u-super', branchScope: 'all', authorityLimitMinor: 1_000_00, currency: 'INR' },
          approvals: [{ id: 'ap-1', subjectType: 'stock_adjustment', subjectRef: 'adj-1', requestedBy: 'u-wh', valueMinor: 500_00, currency: 'INR' }],
        }),
      }),
    }));
    const s = bootWarehouseSupervisor((await payloadFromScreen(base, 'warehouse-supervisor'))! as unknown as SupervisorData)!;
    const outbox = new SyncOutbox();
    const out = s.decide({ requestId: 'ap-1', decision: 'approved', reasonCode: 'checked_the_stock', decidedAt: NOW }, outbox);
    expect(out.ok).toBe(true);
    expect(outbox.pending().map((i) => i.event.type)).toEqual(['WarehouseApprovalDecided']);
  });

  it('the supervisor plans a transfer and assigns a task, served over the socket, queued for sync', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        warehouse: known({
          assignmentId: 'wa-1', workerId: 'u-wh', storeId: 'store-1',
          bins: [{ binId: 'B-1', storeId: 'store-1', capacityMinor: 100, pickable: true }],
          supervisor: { userId: 'u-super', branchScope: 'all' },
        }),
      }),
    }));
    const s = bootWarehouseSupervisor((await payloadFromScreen(base, 'warehouse-supervisor'))! as unknown as SupervisorData)!;
    const outbox = new SyncOutbox();
    expect(s.proposeTransfer({ transferId: 't-1', fromLocationId: 'WH', toLocationId: 'S1', lines: [{ productId: 'p1', quantityMinor: 5, uom: 'EA', unitCostMinor: 90_00, currency: 'INR' }] }, outbox).ok).toBe(true);
    expect(s.assignTask({ taskId: 'tk-1', kind: 'put_away', assignedTo: 'u-wh', at: NOW }, outbox).ok).toBe(true);
    expect(outbox.pending().map((i) => i.event.type)).toEqual(['WarehouseTransferProposed', 'WarehouseTaskAssigned']);
  });

  it('the till gets a catalogue it can ACTUALLY BUILD, and scans with no line at all', async () => {
    // **This test used to check the payload's contents and never that the lane could consume
    // them** — and that is exactly how the defect survived. The box served a shape with no
    // `barcodes` array, no `status` and no `taxBps`, so `new CatalogueCache(payload)` threw
    // before the till rendered anything: a cashier saw a blank screen with nothing saying why.
    // The only honest check is to build the real cache and scan through it.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'pos'))!;
    const cache = new CatalogueCache(payload as never);
    const hit = cache.scan('8901');
    expect(hit.product.name).toBe('Toor dal 1kg');
    expect(hit.product.unitPriceMinor).toBe(145_00);
  });

  it('REFUSES a recalled item at the lane, by name, with no network', async () => {
    // The loudest safety claim in this codebase — "even offline" — and the flag had no field to
    // arrive in, so the refusal was unreachable and a recalled tin could be sold at the till.
    const base = await serve(snapshotOf({
      pack: pack({
        products: known([{ ...PRODUCTS[0]!, recallBlock: true }]),
      }),
    }));
    const cache = new CatalogueCache((await payloadFromScreen(base, 'pos'))! as never);
    expect(() => cache.scan('8901')).toThrow(/under recall/);
  });

  it('honours a recall from the product MASTER too, so the two cannot disagree', async () => {
    // Recall lives on the master and on the lane-facing summary. On a safety flag a disagreement
    // must fail one way only: either source saying blocked means blocked.
    const base = await serve(snapshotOf({
      pack: pack({
        productMaster: known([{ ...MASTER[0]!, recallBlocked: true }]),
      }),
    }));
    const cache = new CatalogueCache((await payloadFromScreen(base, 'pos'))! as never);
    expect(() => cache.scan('8901')).toThrow(/under recall/);
  });

  it('keeps a product it cannot price safely OFF the lane, and names it', async () => {
    // A guessed tax rate is a wrong number on every bill for that item. An unknown barcode is at
    // least a question somebody asks.
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, taxBps: undefined }]) }),
    }));
    const payload = (await payloadFromScreen(base, 'pos'))!;
    expect(payload['products']).toEqual([]);
    expect(payload['excludedProducts']).toEqual([
      { productId: 'p1', name: 'Toor dal 1kg', why: 'no tax rate on the catalogue' },
    ]);
  });

  it('ships a RECALLED product even when it cannot be priced, so the refusal is by name', async () => {
    // "Unknown barcode" on a recalled tin is a cashier keying it in by hand.
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, taxBps: undefined, recallBlock: true }]) }),
    }));
    const cache = new CatalogueCache((await payloadFromScreen(base, 'pos'))! as never);
    expect(() => cache.scan('8901')).toThrow(/under recall/);
  });
});

describe('a box that has been told nothing tells every screen so', () => {
  const nothing = snapshotOf({
    pack: {
      receivedAt: null, version: 0,
      policies: notKnown('never'), products: notKnown('never'), approvals: notKnown('never'),
      checklist: notKnown('never'), wave: notKnown('never'), route: notKnown('never'),
      deliveries: notKnown('never'), drivers: notKnown('never'), routingPolicy: notKnown('never'),
      slots: notKnown('never'), purchaseOrders: notKnown('never'), receipts: notKnown('never'),
      supplierInvoices: notKnown('never'), buyingPolicy: notKnown('never'),
      categories: notKnown('never'), productMaster: notKnown('never'),
      priceEntries: notKnown('never'), pricingPolicy: notKnown('never'),
      shelfLocations: notKnown('never'), shelfAssignments: notKnown('never'),
      shelfPolicy: notKnown('never'), planogram: notKnown('never'), shelfCounts: notKnown('never'),
      backstock: notKnown('never'), assortment: notKnown('never'), spaceAreas: notKnown('never'),
      salesByAreaMinor: notKnown('never'), marginByAreaMinor: notKnown('never'),
      displayContracts: notKnown('never'), fundingReceivedMinor: notKnown('never'),
      stillOccupying: notKnown('never'), merchandisingPolicy: notKnown('never'),
      reportingRecords: notKnown('never'), roles: notKnown('never'),
      roleAssignments: notKnown('never'), reportingPolicy: notKnown('never'),
      returnHistory: notKnown('never'), serviceCases: notKnown('never'),
      satisfaction: notKnown('never'), slaPolicy: notKnown('never'),
      servicePolicy: notKnown('never'),
      batches: notKnown('never'), recalls: notKnown('never'),
      expiryPolicy: notKnown('never'),
      tallyPostings: notKnown('never'), financeLedger: notKnown('never'),
      periodState: notKnown('never'), financePolicy: notKnown('never'),
      accounts: notKnown('never'), supportSessions: notKnown('never'),
      devices: notKnown('never'), versionPolicy: notKnown('never'),
      auditRecords: notKnown('never'), retentionPolicies: notKnown('never'),
      legalHolds: notKnown('never'), adminPolicy: notKnown('never'),
      killSwitches: notKnown('never'), agentBudgets: notKnown('never'),
      aiUsage: notKnown('never'),
      aiPending: notKnown('never'), aiEvaluations: notKnown('never'),
      aiPolicy: notKnown('never'),
      migrationSources: notKnown('never'), migrationExceptions: notKnown('never'),
      migrationTotals: notKnown('never'), parallelDays: notKnown('never'),
      parallelDifferences: notKnown('never'), historyExclusions: notKnown('never'),
      legacyArchive: notKnown('never'), migrationPolicy: notKnown('never'),
      lossPreventionRules: notKnown('never'), consentPurposes: notKnown('never'),
      warehouse: notKnown('never'),
    },
    sales: [],
  });

  it('serves the shells with no payload at all, marker intact', async () => {
    const base = await serve(nothing);
    for (const screen of ['pos', 'owner', 'picker', 'driver', 'customer', 'buying', 'catalogue', 'merchandising', 'reporting'] as const) {
      expect(await payloadFromScreen(base, screen), `${screen} invented something`).toBeNull();
    }
  });

  it('still tells the manager what it CAN answer, and stays silent on the rest', async () => {
    // The box always knows its own outbox, so the unsent register is answerable even on a box
    // that has never heard from the cloud. Everything else is absent rather than empty.
    const base = await serve(nothing);
    const payload = (await payloadFromScreen(base, 'manager'))!;
    expect(payload['unsentItems']).toEqual([]);
    for (const section of ['openExceptions', 'approvals', 'tasks', 'products']) {
      expect(section in payload, `"${section}" must be absent`).toBe(false);
    }
  });

  it('and the manager’s day close refuses, which is the correct answer', async () => {
    const base = await serve(nothing);
    const payload = (await payloadFromScreen(base, 'manager'))!;
    const attempt = bootManager({
      storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
      managerId: 'u-mgr', data: payload as never,
    }).closeTheDay({ dayCloseId: 'dc-9', closedAtLocal: '2026-08-05T02:30', closedAt: NOW });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.some((b) => b.kind === 'cannot_see')).toBe(true);
  });
});

describe('the box plans the driver’s route itself (M19-FR-03)', () => {
  const dispatching = snapshotOf({
    pack: pack({
      route: known(null), // nothing hand-written, so the planner decides
      deliveries: known(DELIVERIES),
      drivers: known(DRIVERS),
      routingPolicy: known(ROUTING),
    }),
  });

  it('serves a planned route the driver’s phone can open', async () => {
    // Dispatch runs on the BOX. A shop whose routes could only be planned when the internet was
    // up would stop delivering on the afternoon the router dies (P-01).
    const base = await serve(dispatching);
    const payload = (await payloadFromScreen(base, 'driver'))!;

    expect(payload['plannedBy']).toBe('this store box');
    expect(payload['distancesAre']).toBe('straight_line');

    const route = bootDriver(payload as Parameters<typeof bootDriver>[0], new DeviceOutbox(noDeviceStore()), () => NOW)!;
    // The two that could be placed, nearest first. The third had no location.
    expect(route.route().map((s) => s.orderRef)).toEqual(['ORD-2', 'ORD-1']);
    expect(route.route()[0]?.codMinor).toBe(0);
  });

  it('puts the order it could NOT plan on the manager’s exception register', async () => {
    // An undispatched order is a customer who ordered, paid and is waiting. It belongs where
    // somebody looks — and it holds the day close, which is correct.
    const base = await serve(dispatching);
    const manager = (await payloadFromScreen(base, 'manager'))!;
    const exceptions = manager['openExceptions'] as { id: string; what: string }[];

    const unplanned = exceptions.find((e) => e.id === 'dispatch:ORD-3');
    expect(unplanned).toBeDefined();
    expect(unplanned?.what).toMatch(/no delivery location/i);
  });

  it('and the day will not close while that order is still unplanned', async () => {
    const base = await serve(dispatching);
    const attempt = bootManager({
      storeId: 'store-1', branchId: 'b1', tradingDay: '2026-08-04', tradingDayCutoff: '02:00',
      managerId: 'u-mgr', data: (await payloadFromScreen(base, 'manager'))! as never,
    }).closeTheDay({ dayCloseId: 'dc-r', closedAtLocal: '2026-08-05T02:30', closedAt: NOW });

    expect(attempt.closed).toBe(false);
    if (attempt.closed) return;
    expect(attempt.blockers.find((b) => b.kind === 'exceptions_open')?.items.some((i) => i.id === 'dispatch:ORD-3')).toBe(true);
  });

  it('lets a dispatcher override the planner, and says which the driver is holding', async () => {
    // Software that cannot be overridden gets worked around — which means a driver with a piece
    // of paper and a screen that disagrees with it.
    const base = await serve(snapshotOf({
      pack: pack({
        deliveries: known(DELIVERIES), drivers: known(DRIVERS), routingPolicy: known(ROUTING),
        route: known({
          routeId: 'by-hand', driverId: 'd1',
          stops: [{ stopId: 's1', orderRef: 'ORD-9', area: 'Wherever the dispatcher said', codMinor: 0 }],
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'driver'))!;
    expect(payload['routeId']).toBe('by-hand');
    expect(payload['plannedBy']).toBe('a dispatcher, by hand');
  });

  it('serves nothing when the box has not been told the orders or the fleet', async () => {
    // Not an empty route. "Nobody has any deliveries today" and "I have not been told what today's
    // deliveries are" are different sentences, and the screen says which.
    const base = await serve(snapshotOf({
      pack: pack({ route: known(null), deliveries: notKnown('never sent'), drivers: known(DRIVERS), routingPolicy: known(ROUTING) }),
    }));
    expect(await payloadFromScreen(base, 'driver')).toBeNull();
  });

  it('re-plans the day around a van that is off the road', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        route: known(null), deliveries: known(DELIVERIES), routingPolicy: known(ROUTING),
        drivers: known([
          { ...DRIVERS[0]!, unavailable: true },
          { driverId: 'd2', maxStops: 10, availableFrom: '2026-08-05T16:00:00.000Z', availableUntil: '2026-08-05T21:00:00.000Z' },
        ]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'driver'))!;
    expect(payload['driverId']).toBe('d2');
    expect((payload['stops'] as unknown[])).toHaveLength(2);
  });
});

/**
 * **The buyer's screen, driven over the same socket (M06 · M07 · §28).**
 *
 * This is the one screen where being wrong costs money that has already left. So it is driven the
 * hard way: the real server, the real `buying.html` off disk, the payload pulled back out of the
 * page, and the real `BuyingSession` booted on it — the same code path a buyer standing at the
 * goods-in door would be running.
 */
describe('the buyer’s screen is fed, and fed only what the box actually knows', () => {
  /** A clean two-line invoice for the products the pack carries: 10 × ₹90 = ₹900.00 */
  const FILE = [
    'productId,quantity,unitPriceMinor,lineTotalMinor',
    'p1,10,9000,90000',
  ].join('\n');
  const TOTAL = 90_000;

  const approvalBy = (decidedBy: string, invoiceId: string) => ({
    id: `ap-${invoiceId}`, subjectType: 'supplier_invoice', subjectRef: invoiceId,
    requestedBy: 'u-buyer', branchId: null, value: null,
    status: 'approved' as const, decidedBy, reason: 'checked_with_supplier', decidedAt: NOW,
  });

  it('serves the buyer their OWN page, not the manager’s', async () => {
    // Both screens live in `apps/web-erp/web` and share one bundle. A bare `/buying` that resolved
    // to `index.html` would put a day close in front of somebody who came to capture an invoice.
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/buying`)).text();
    expect(html).toContain('id="declared-total"');
    expect(html, 'the manager’s screen was served to the buyer').not.toContain('id="close-title"');
    // …and the manager's own page is still the manager's.
    const manager = await (await fetch(`${base}/manager`)).text();
    expect(manager).toContain('id="close-title"');
  });

  it('removes the buyer from their own approver list before the page is even built', async () => {
    // The pack lists `u-buyer` among the approvers — a tenant misconfiguration, and exactly the
    // one that separation of duties is supposed to survive. It must never reach the screen.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect(payload['approvers']).toEqual(['u-manager']);
    expect(payload['buyerId']).toBe('u-buyer');
  });

  it('captures a whole supplier invoice in one go, once somebody else has checked it', async () => {
    // Audit finding A-03: eighty lines retyped by hand every week. This is the replacement.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'buying'))!;
    const buying = bootBuying(payload as never)!;

    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL });
    expect(preview.problems).toEqual([]);
    expect(preview.readyToApprove).toBe(true);

    const outcome = buying.captureInvoice({
      invoiceId: 'INV-1', supplierId: 'sup-1', preview, approval: approvalBy('u-manager', 'INV-1'),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.totalMinor).toBe(TOTAL);
  });

  it('refuses the buyer’s own approval, on the payload the box actually served', async () => {
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL });
    const outcome = buying.captureInvoice({
      invoiceId: 'INV-2', supplierId: 'sup-1', preview, approval: approvalBy('u-buyer', 'INV-2'),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('approved_by_the_person_who_captured_it');
  });

  it('catches a missing line that every remaining line would pass', async () => {
    // The control total is the only figure in the flow that does not come from the file. A file
    // whose lines are each perfect and whose sum is short is a file missing a line, and nothing
    // else in the system can notice.
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const preview = buying.previewInvoice({ text: FILE, declaredTotalMinor: TOTAL + 45_00 });

    expect(preview.problems).toEqual([]); // every line is individually fine
    expect(preview.readyToApprove).toBe(false);
    const outcome = buying.captureInvoice({
      invoiceId: 'INV-3', supplierId: 'sup-1', preview, approval: approvalBy('u-manager', 'INV-3'),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('does_not_add_up_to_the_invoice_total');
  });

  it('will not call an uncaptured invoice agreed with the order', async () => {
    // *Not checked* is not *clean*. Three documents cannot agree when we are holding two of them.
    const base = await serve(snapshotOf());
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const result = buying.match({ poId: 'PO-1', invoiceId: 'INV-NEVER-CAPTURED' });
    expect(result.blocked).toBe(true);
  });

  it('matches a captured invoice against what was ordered and what arrived', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        supplierInvoices: known([{
          invoiceId: 'INV-9',
          lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 90_00, lineTotalMinor: 900_00 }],
        }]),
      }),
    }));
    const buying = bootBuying((await payloadFromScreen(base, 'buying'))! as never)!;
    const result = buying.match({ poId: 'PO-1', invoiceId: 'INV-9' });
    expect(result.blocked).toBe(false);
    expect(result.payableMinor).toBe(900_00);
  });

  it('adds up two deliveries against one order rather than losing the first', async () => {
    // Half on Monday and the rest on Thursday is an ordinary week. Overwriting would report that
    // only Thursday's half arrived, and the match would withhold payment for goods on the shelf.
    const base = await serve(snapshotOf({
      pack: pack({
        receipts: known([
          { poId: 'PO-1', lines: [{ productId: 'p1', qty: 4 }] },
          { poId: 'PO-1', lines: [{ productId: 'p1', qty: 6 }] },
        ]),
        supplierInvoices: known([{
          invoiceId: 'INV-9',
          lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 90_00, lineTotalMinor: 900_00 }],
        }]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    const received = payload['received'] as Record<string, { qty: number }[]>;
    expect(received['PO-1']?.[0]?.qty).toBe(10);

    const buying = bootBuying(payload as never)!;
    expect(buying.match({ poId: 'PO-1', invoiceId: 'INV-9' }).blocked).toBe(false);
  });

  it('serves the buyer nothing at all when the box has no buying policy', async () => {
    // A screen inventing its own match tolerances would be deciding, on its own authority, how big
    // a price difference is worth nobody's attention.
    const base = await serve(snapshotOf({ pack: pack({ buyingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'buying')).toBeNull();
    expect(bootBuying(undefined)).toBeNull();
  });

  it('names what it was NOT told, rather than letting a refusal read as a supplier’s fault', async () => {
    // Every gap here already fails toward a refusal. That is the safe direction and still not
    // honest on its own: "this was never ordered" looks identical whether the supplier invented
    // the line or the box was simply never sent the order, and only one is an argument to have.
    const base = await serve(snapshotOf({
      pack: pack({ purchaseOrders: notKnown('never sent'), receipts: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect('ordered' in payload, '"ordered" must be absent, not empty').toBe(false);
    expect(buyingGaps(payload as never)).toEqual(['what_was_ordered', 'what_arrived']);
  });

  it('reports an unserved approver list as a gap, because it stops the same work', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        buyingPolicy: known({
          buyerId: 'u-buyer', approvers: ['u-buyer'], // only the buyer — stripped, leaving nobody
          quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100,
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'buying'))!;
    expect(payload['approvers']).toEqual([]);
    expect(buyingGaps(payload as never)).toContain('who_may_approve');
  });
});

/**
 * **A bare screen path, driven over the real socket.**
 *
 * `/pos` and `/pos/` look like the same address and are not: without the trailing slash a browser
 * resolves `./pos.bundle.js` against `/`, asks this box for `/pos.bundle.js`, and gets nothing —
 * so the page opens with no bundle, no view and no service worker registered. A blank screen, with
 * nothing anywhere saying why, served with a cheerful 200.
 */
describe('the box sends a bare screen path to its own folder first', () => {
  it('redirects `/<screen>` to `/<screen>/` for every screen it serves', async () => {
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const response = await fetch(`${base}/${screen}`, { redirect: 'manual' });
      expect(response.status, `${screen} was served without a redirect`).toBe(301);
      expect(response.headers.get('location')).toBe(`/${screen}/`);
    }
  });

  it('keeps the query string across the redirect', async () => {
    const base = await serve(snapshotOf());
    const response = await fetch(`${base}/driver?driverId=d1`, { redirect: 'manual' });
    expect(response.headers.get('location')).toBe('/driver/?driverId=d1');
  });

  it('serves the screen itself once the slash is there, payload intact', async () => {
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/pos/`)).text();
    expect(html).toContain('window.posCatalogue');
    expect(html).toContain('./pos.bundle.js');
  });

  it('still refuses a path that is not a screen at all', async () => {
    const base = await serve(snapshotOf());
    expect((await fetch(`${base}/payroll`, { redirect: 'manual' })).status).toBe(404);
  });

  it('serves each screen’s service worker, so there is something to register', async () => {
    // It existed for weeks and only the owner's phone ever registered it.
    const base = await serve(snapshotOf());
    for (const screen of SCREENS) {
      const response = await fetch(`${base}/${screen}/sw.js`);
      expect(response.status, `${screen} has no service worker to fetch`).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/javascript/);
      expect(await response.text()).toContain('shellCachedAt');
    }
  });
});

/**
 * **The product-and-pricing screen, driven over the same socket (M03 · M05 · D01 · §28).**
 *
 * Everything needed to police a price was built and tested — the MRP ceiling, the margin floor, the
 * effective-dated resolution, the append-only history, the catalogue snapshot that carries it to a
 * lane — and **nothing anywhere produced a price**. This proves the whole chain now runs: the box
 * serves the master records and the tenant's own rules, the screen makes a price, and the price the
 * lane would resolve is the one the screen decided.
 */
describe('the product-and-pricing screen is fed, and cannot break the law', () => {
  const approvalBy = (decidedBy: string, subjectRef: string) => ({
    id: `ap-${subjectRef}`, subjectType: 'price_change', subjectRef,
    requestedBy: 'u-pricing', branchId: null, value: null,
    status: 'approved' as const, decidedBy, reason: 'clearance', decidedAt: NOW,
  });

  it('serves its OWN page, not the manager’s and not the buyer’s', async () => {
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/catalogue/`)).text();
    expect(html).toContain('id="floor-value"');
    expect(html).not.toContain('id="close-title"');
    expect(html).not.toContain('id="declared-total"');
  });

  it('removes the person setting prices from their own approver list', async () => {
    // The pack lists `u-pricing` among the approvers — a tenant misconfiguration, and exactly the
    // one that separation of duties has to survive. It must never reach the screen.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['approvers']).toEqual(['u-manager']);
    expect(payload['userId']).toBe('u-pricing');
  });

  it('serves the shop’s trading day rather than leaving the screen to read a clock', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['today']).toBe(DAY);
  });

  it('makes a price, and the lane would resolve exactly that price', async () => {
    // The whole chain, end to end: nothing has ever produced a `PriceEntry` before this.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    const catalogue = bootCatalogue(payload as never)!;

    const proposal = catalogue.proposePrice({
      id: 'pc-1', productId: 'p1', priceMinor: 150_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual([]);
    const outcome = catalogue.activatePrice(proposal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The same engine the till's catalogue snapshot uses, given the new entry alongside the old.
    const resolved = resolvePrice(
      [...(payload['priceEntries'] as Parameters<typeof resolvePrice>[0]), outcome.entry],
      { productId: 'p1', at: `${DAY}T12:00:00.000Z`, storeId: 'store-1' },
    );
    expect(resolved?.price.minor).toBe(150_00);
    expect(resolved?.id).toBe('pc-1');
  });

  it('refuses a price above the MRP the box served, whoever approves it', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-2', productId: 'p1', priceMinor: 175_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toContain('above_the_printed_mrp');
    expect(catalogue.activatePrice(proposal, approvalBy('u-manager', 'pc-2')).ok).toBe(false);
  });

  it('needs an approver for a below-floor price, using the tenant’s own floor', async () => {
    // Cost ₹100 from the pack, floor 20% from the pack ⇒ under ₹125 is below the floor.
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-3', productId: 'p1', priceMinor: 110_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual(['below_the_margin_floor']);
    expect(catalogue.activatePrice(proposal).ok).toBe(false);
    expect(catalogue.activatePrice(proposal, approvalBy('u-manager', 'pc-3')).ok).toBe(true);
  });

  it('will not check a margin against a cost the box never sent', async () => {
    // The pack's product carries no `unitCostMinor` here, so the payload's cost map has no entry —
    // NOT a zero, which would make every price look like a 100% margin.
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, unitCostMinor: undefined }]) }),
    }));
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect(payload['costsMinor']).toEqual({});

    const catalogue = bootCatalogue(payload as never)!;
    const proposal = catalogue.proposePrice({
      id: 'pc-4', productId: 'p1', priceMinor: 1_00, effectiveFrom: DAY,
    });
    expect(proposal.refusals).toEqual(['the_cost_is_not_known_so_the_margin_was_never_checked']);
    expect(catalogue.activatePrice(proposal).ok).toBe(false);
  });

  it('scores what is missing from a record, against the tenant’s own department rules', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const view = catalogue.shelf()[0]!;
    expect(view.score.knowable).toBe(true);
    if (!view.score.knowable) return;
    expect(view.score.percent).toBe(100);
    expect(view.score.publishable).toBe(true);
  });

  it('says a record is NOT KNOWABLE when the box never sent its department', async () => {
    // A zero would read as "somebody has filled in nothing" and send a person to fix a finished
    // record. The reason names the department nobody told this screen about.
    const base = await serve(snapshotOf({ pack: pack({ categories: known([]) }) }));
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    const score = catalogue.shelf()[0]!.score;
    expect(score.knowable).toBe(false);
    if (score.knowable) return;
    expect(score.why).toContain('grocery');
  });

  it('serves the screen nothing at all when the box has no pricing policy', async () => {
    const base = await serve(snapshotOf({ pack: pack({ pricingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'catalogue')).toBeNull();
    expect(bootCatalogue(undefined)).toBeNull();
  });

  it('names what it was NOT told rather than letting a refusal read as somebody’s fault', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ categories: notKnown('never sent'), priceEntries: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'catalogue'))!;
    expect('categories' in payload, '"categories" must be absent, not empty').toBe(false);
    expect(catalogueGaps(payload as never)).toEqual(['what_each_department_needs', 'the_prices_already_set']);
  });
});

/**
 * **The picker's walk, sequenced by the shop's own shelf map (M04-FR-02).**
 *
 * `ShelfMap.routeFor` was written, tested and **never called by anything** — so every wave was
 * walked in whatever order the cloud sent it, which on an online grocery order is the order the
 * customer typed: dairy, rice, back to dairy. The roadmap's audit calls picking time the largest
 * controllable cost in this business, and it is decided here.
 */
describe('the box puts the picker’s list in the order they walk the shop', () => {
  it('re-sequences the wave, and collects the chiller last', async () => {
    // The wave arrives milk-then-dal. The chiller is aisle 0 — physically the FIRST thing you walk
    // past — and it must still be collected last, because this store said so.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string; shelf?: string }[];

    expect(lines.map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(lines[1]?.shelf).toBe('Chiller (chilled)');
    expect(payload['orderedBy']).toContain('in the order this store set');
  });

  it('and the picker’s real session keeps that order and shows the shelf', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const picker = bootPicker(payload as never, new DeviceOutbox(noDeviceStore()), () => NOW)!;
    expect(picker.work().map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(picker.work()[0]?.shelf).toBe('A1');
  });

  it('applies NO zone order when the store has not said which zones to collect last', async () => {
    // Guessing a cold-chain order would be this repository deciding a licensed matter for every
    // tenant, and the wrong guess is silent: the route looks sensible and the milk is warm.
    const base = await serve(snapshotOf({ pack: pack({ shelfPolicy: known({}) }) }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string }[];
    // Aisle 0 first, on physical position alone.
    expect(lines.map((l) => l.productId)).toEqual(['p-milk', 'p1']);
    expect(payload['orderedBy']).toContain('has not said which zones');
  });

  it('puts a line with no shelf address LAST and names it, rather than hiding it', async () => {
    // Hiding it would send the picker back across the shop; dropping it would lose the line.
    const base = await serve(snapshotOf({
      pack: pack({ shelfAssignments: known([SHELF_ASSIGNMENTS[0]!]) }),
    }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    const lines = payload['lines'] as { productId: string; unmapped: boolean }[];
    expect(lines.map((l) => l.productId)).toEqual(['p1', 'p-milk']);
    expect(lines[1]?.unmapped).toBe(true);
    expect(payload['unmapped']).toEqual(['p-milk']);
  });

  it('says the list is in the order it arrived when the shop has no shelf map', async () => {
    // A shop that has not addressed its shelves is a real state, not a degraded one. What must
    // never happen is a picker believing a list is sequenced when nothing sequenced it.
    const base = await serve(snapshotOf({ pack: pack({ shelfLocations: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    expect((payload['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p-milk', 'p1']);
    expect(payload['orderedBy']).toContain('no shelf map');
  });

  it('drops one contradictory assignment rather than taking the whole map down', async () => {
    // A pack claiming two homes for one product must not blank the route for every OTHER product
    // in the shop. The bad row is dropped and the product reads as unmapped — which it is.
    const base = await serve(snapshotOf({
      pack: pack({
        shelfAssignments: known([
          ...SHELF_ASSIGNMENTS,
          { storeId: 'store-1', productId: 'p1', locationId: 'L-COLD', capacityMinor: 5, primary: true },
        ]),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'picker'))!;
    expect((payload['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p1', 'p-milk']);
    expect(payload['unmapped']).toEqual([]);
  });

  it('serves the shelf map to the product screen, so somebody can fix an unmapped item', async () => {
    const base = await serve(snapshotOf());
    const catalogue = bootCatalogue((await payloadFromScreen(base, 'catalogue'))! as never)!;
    expect(catalogue.shelves().map((l) => l.locationId)).toEqual(['L-COLD', 'L-A1']);
    expect(catalogue.shelfOf('p1')?.label).toBe('A1');
  });
});

/**
 * **SRE's own answer, driven rather than filed (OB-07, 6 August 2026).**
 *
 * The owner's zone order is `ambient → secure → chilled → frozen`. An owner answer that lives only
 * in a register is an answer nobody checks, and the ones that matter are exactly the ones that
 * would fail quietly: a wrong pick order does not throw, it just walks a sensible-looking route and
 * delivers warm milk.
 *
 * So this runs the real order through the real box against a shop laid out to punish it — every
 * zone sitting in the WRONG physical place, so a route that ignored the zones would come back in
 * exactly the reverse of what the owner asked for.
 */
describe('the owner’s pick zone order, end to end (OB-07)', () => {
  const OWNER_ZONE_ORDER = ['ambient', 'secure', 'chilled', 'frozen'];

  /** Aisle numbers deliberately fight the zone order: frozen is nearest the door, ambient furthest. */
  const AWKWARD_SHOP = [
    { storeId: 'store-1', locationId: 'L-FROZEN', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Freezer', zone: 'frozen' as const },
    { storeId: 'store-1', locationId: 'L-CHILL', aisle: 2, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Chiller', zone: 'chilled' as const },
    { storeId: 'store-1', locationId: 'L-LOCK', aisle: 3, rack: 1, bay: 1, shelf: 1, position: 1, label: 'Cabinet', zone: 'secure' as const },
    { storeId: 'store-1', locationId: 'L-DRY', aisle: 4, rack: 1, bay: 1, shelf: 1, position: 1, label: 'A4' },
  ];

  const FOUR_ZONES = () => snapshotOf({
    pack: pack({
      shelfLocations: known(AWKWARD_SHOP),
      shelfPolicy: known({ zoneOrder: OWNER_ZONE_ORDER }),
      shelfAssignments: known([
        { storeId: 'store-1', productId: 'p1', locationId: 'L-DRY', capacityMinor: 24, primary: true },
        { storeId: 'store-1', productId: 'p-milk', locationId: 'L-CHILL', capacityMinor: 60, primary: true },
        { storeId: 'store-1', productId: 'p-peas', locationId: 'L-FROZEN', capacityMinor: 40, primary: true },
        { storeId: 'store-1', productId: 'p-whisky', locationId: 'L-LOCK', capacityMinor: 12, primary: true },
      ]),
      wave: known({
        waveId: 'w-zones', pickerId: 'u-picker',
        // Arrives in the worst possible order — frozen first, dry goods last.
        lines: ['p-peas', 'p-milk', 'p-whisky', 'p1'].map((productId, i) => ({
          lineId: `l${i}`, orderRef: 'ORD-9', productId, description: productId,
          bin: 'B', requiredQty: 1, uom: 'ea', unitPriceMinor: 100_00,
        })),
      }),
    }),
  });

  it('walks ambient, then the secure cabinet, then the chiller, then the freezer', async () => {
    const base = await serve(FOUR_ZONES());
    const payload = (await payloadFromScreen(base, 'picker'))!;
    expect((payload['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p1', 'p-whisky', 'p-milk', 'p-peas']);
  });

  it('does it in spite of the aisle numbers, not because of them', async () => {
    // The freezer is aisle 1 and the dry aisle is aisle 4, so a route that ignored the zones would
    // come back in exactly the reverse. That is the whole point of this fixture.
    const base = await serve(FOUR_ZONES());
    const withoutZones = await serve(snapshotOf({
      pack: pack({
        shelfLocations: known(AWKWARD_SHOP),
        shelfPolicy: known({}),
        shelfAssignments: known([
          { storeId: 'store-1', productId: 'p1', locationId: 'L-DRY', capacityMinor: 24, primary: true },
          { storeId: 'store-1', productId: 'p-milk', locationId: 'L-CHILL', capacityMinor: 60, primary: true },
          { storeId: 'store-1', productId: 'p-peas', locationId: 'L-FROZEN', capacityMinor: 40, primary: true },
          { storeId: 'store-1', productId: 'p-whisky', locationId: 'L-LOCK', capacityMinor: 12, primary: true },
        ]),
        wave: known({
          waveId: 'w-zones', pickerId: 'u-picker',
          lines: ['p-peas', 'p-milk', 'p-whisky', 'p1'].map((productId, i) => ({
            lineId: `l${i}`, orderRef: 'ORD-9', productId, description: productId,
            bin: 'B', requiredQty: 1, uom: 'ea', unitPriceMinor: 100_00,
          })),
        }),
      }),
    }));

    const owner = (await payloadFromScreen(base, 'picker'))!;
    const plain = (await payloadFromScreen(withoutZones, 'picker'))!;
    expect((plain['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual(['p-peas', 'p-milk', 'p-whisky', 'p1']);
    expect((owner['lines'] as { productId: string }[]).map((l) => l.productId))
      .toEqual([...(plain['lines'] as { productId: string }[]).map((l) => l.productId)].reverse());
  });

  it('reaches the picker’s real session with the shelf sign on every line', async () => {
    const base = await serve(FOUR_ZONES());
    const picker = bootPicker(
      (await payloadFromScreen(base, 'picker'))! as never,
      new DeviceOutbox(noDeviceStore()),
      () => NOW,
    )!;
    expect(picker.work().map((l) => l.shelf))
      .toEqual(['A4', 'Cabinet (secure)', 'Chiller (chilled)', 'Freezer (frozen)']);
  });

  it('is the same order the example pack ships, so a new store starts right', async () => {
    // The register, the setting and the example pack have to agree. Three copies of one answer is
    // two of them going stale, and this is the check that stops it.
    const example = JSON.parse(
      readFileSync('edge/store-edge/sample/store-pack.example.json', 'utf8'),
    ) as { shelfPolicy: { zoneOrder: string[] } };
    expect(example.shelfPolicy.zoneOrder).toEqual(OWNER_ZONE_ORDER);
  });
});

/**
 * **The merchandising screen, driven over the same socket (M04 · D02).**
 *
 * The headline is the fault that gated this whole build: `planogramCompliance` read
 * `state?.onShelfMinor ?? 0`, so an **uncounted** facing came through as an **empty** one — the
 * loudest finding it has. On day one, before anybody had counted anything, that fired for every
 * product in the shop and sent staff to full shelves.
 */
describe('the merchandising screen is fed, and an uncounted shelf stays uncounted', () => {
  const COUNTED = (productId: string, locationId: string, countedMinor: number, at: string) =>
    ({ storeId: 'store-1', locationId, productId, countedMinor, countedBy: 'u-merch', at });

  it('serves its OWN page, not the manager’s, the buyer’s or the pricer’s', async () => {
    const base = await serve(snapshotOf());
    const html = await (await fetch(`${base}/merchandising/`)).text();
    expect(html).toContain('id="count-qty"');
    expect(html).not.toContain('id="close-title"');
    expect(html).not.toContain('id="declared-total"');
    expect(html).not.toContain('id="floor-value"');
  });

  it('sends nobody anywhere when nothing has been counted', async () => {
    const base = await serve(snapshotOf());
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    const check = merch.check();
    expect('why' in check).toBe(false);
    if ('why' in check) return;
    expect(check.tasks).toEqual([]);
    expect(check.issues.map((i) => i.finding)).toEqual(['never_counted', 'never_counted']);
    expect(check.notObserved).toBe(2);
    expect(check.complianceBp, 'an unchecked shop reported as compliant').toBe(0);
  });

  it('raises the urgent refill once somebody has actually looked', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ shelfCounts: known([COUNTED('p1', 'L-A1', 0, NOW)]) }),
    }));
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    const check = merch.check();
    if ('why' in check) return;
    const task = check.tasks.find((t) => t.productId === 'p1');
    expect(task?.priority).toBe('urgent');
    expect(task?.quantityMinor).toBe(24);
    expect(task?.assignedRole).toBe('shelf-filler');
    // …and it still says only half the plan was looked at.
    expect(check.wholePlanObserved).toBe(false);
    expect(check.plannedFacings).toBe(2);
  });

  it('goes quiet again when the count goes stale, against the tenant’s own window', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ shelfCounts: known([COUNTED('p1', 'L-A1', 0, '2026-08-01T09:00:00.000Z')]) }),
    }));
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    const check = merch.check();
    if ('why' in check) return;
    expect(check.tasks).toEqual([]);
    expect(check.issues.find((i) => i.productId === 'p1')?.finding).toBe('last_counted_too_long_ago');
  });

  it('takes a count from the screen and refuses one against a shelf that does not exist', async () => {
    const base = await serve(snapshotOf());
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    expect(merch.count({ locationId: 'L-A1', productId: 'p1', countedMinor: 12 }).ok).toBe(true);
    const bad = merch.count({ locationId: 'L-TYPO', productId: 'p1', countedMinor: 12 });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.refusal).toBe('this_shop_has_no_such_shelf');
  });

  it('puts never-counted facings at the top of the counting list', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ shelfCounts: known([COUNTED('p1', 'L-A1', 5, '2026-08-01T09:00:00.000Z')]) }),
    }));
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    expect(merch.countingList().map((r) => r.productId)).toEqual(['p-milk', 'p1']);
    expect(merch.countingList()[0]?.lastCountedAt).toBeNull();
  });

  it('says WHY the shelves cannot be checked, rather than reporting a clean shop', async () => {
    const noPlan = await serve(snapshotOf({ pack: pack({ planogram: known(null) }) }));
    const merch = bootMerchandising((await payloadFromScreen(noPlan, 'merchandising'))! as never)!;
    expect(merch.check()).toEqual({ why: 'this_store_has_never_published_a_planogram' });

    const noShelves = await serve(snapshotOf({ pack: pack({ shelfLocations: notKnown('never sent') }) }));
    const bare = bootMerchandising((await payloadFromScreen(noShelves, 'merchandising'))! as never)!;
    expect(bare.check()).toEqual({ why: 'this_store_has_no_shelf_map' });
  });

  it('routes a drop with stock on hand to clearance, never to a deletion', async () => {
    // The pack says 10 of `p1` are available, and the box serves that as on-hand. Serving nothing
    // would be the dangerous default here: every drop would delist, and the stock still on the
    // shelf would become invisible — not counted, not replenished, eventually written off.
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'merchandising'))!;
    expect(payload['onHand']).toEqual({ p1: 10 });

    const merch = bootMerchandising(payload as never)!;
    const outcome = merch.drop({ productId: 'p1', reason: 'poor_sales' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.outcome).toBe('routed_to_clearance');
    expect(outcome.decision.detail).toContain('10 still on hand');
  });

  it('delists cleanly only when the shop genuinely has none left', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, availableMinor: 0 }]) }),
    }));
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    const outcome = merch.drop({ productId: 'p1', reason: 'supplier_discontinued' });
    if (!outcome.ok) return;
    expect(outcome.decision.outcome).toBe('delisted');
  });

  it('checks the range against what this box’s OWN log says was sold', async () => {
    // Not the cloud's idea of what sold — this box wrote the sales, so it is the honest source.
    const base = await serve(snapshotOf({
      pack: pack({ assortment: known([]) }),
    }));
    const payload = (await payloadFromScreen(base, 'merchandising'))!;
    expect(payload['soldProductIds']).toEqual(['p1']);
    const merch = bootMerchandising(payload as never)!;
    expect(merch.rangeIssues().find((i) => i.productId === 'p1')?.finding)
      .toBe('sold_not_in_assortment');
  });

  it('serves the screen nothing at all without the tenant’s own thresholds', async () => {
    const base = await serve(snapshotOf({ pack: pack({ merchandisingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'merchandising')).toBeNull();
    expect(bootMerchandising(undefined)).toBeNull();
  });

  it('names what it was NOT told rather than reporting an empty shop', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ backstock: notKnown('never sent'), spaceAreas: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'merchandising'))!;
    expect('backstock' in payload, '"backstock" must be absent, not empty').toBe(false);
    expect(merchandisingGaps(payload as never))
      .toEqual(['what_is_in_the_stockroom', 'how_big_each_part_of_the_floor_is']);
  });
});

/**
 * **SRE's own merchandising thresholds, driven rather than filed (OB-08, 6 August 2026).**
 *
 * Two hours, and half empty. Both fail quietly if they are wrong: a shop whose counts stop working
 * at 119 minutes has been given a different rule from the one it agreed to, and it would find out
 * by somebody walking to a shelf that did not need them. So the line itself is driven, over the
 * real socket, from both sides.
 */
describe('the owner’s merchandising thresholds, end to end (OB-08)', () => {
  const AT = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
  const COUNT = (onShelf: number, minutesAgo: number) => ([{
    storeId: 'store-1', locationId: 'L-A1', productId: 'p1',
    countedMinor: onShelf, countedBy: 'u-merch', at: AT(minutesAgo),
  }]);

  const withCount = (onShelf: number, minutesAgo: number) => snapshotOf({
    pack: pack({ shelfCounts: known(COUNT(onShelf, minutesAgo)) }),
  });

  const tasksFor = async (onShelf: number, minutesAgo: number) => {
    const base = await serve(withCount(onShelf, minutesAgo));
    const merch = bootMerchandising((await payloadFromScreen(base, 'merchandising'))! as never)!;
    const check = merch.check();
    return 'why' in check ? null : check;
  };

  it('serves the shop’s own two figures rather than the screen inventing them', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'merchandising'))!;
    expect(payload['countStaleAfterMinutes']).toBe(120);
    expect(payload['refillAtBp']).toBe(5_000);
  });

  it('a count exactly two hours old still raises the refill; a minute later it does not', async () => {
    const onTheLine = await tasksFor(0, 120);
    expect(onTheLine?.tasks, 'two hours exactly was treated as stale').toHaveLength(1);

    const past = await tasksFor(0, 121);
    expect(past?.tasks, 'a count just past two hours still sent somebody walking').toEqual([]);
    expect(past?.issues.find((i) => i.productId === 'p1')?.finding).toBe('last_counted_too_long_ago');
  });

  it('a facing exactly half full raises no trip; below half does', async () => {
    // Capacity 24 on the plan: 12 is exactly half, 11 is below it.
    const half = await tasksFor(12, 5);
    expect(half?.tasks, 'a half-full facing sent somebody walking').toEqual([]);

    const below = await tasksFor(11, 5);
    expect(below?.tasks).toHaveLength(1);
    expect(below?.tasks[0]?.quantityMinor).toBe(13);
  });

  it('is the same pair the example pack ships, so a new store starts right', async () => {
    // The register, the tenant setting and the example pack have to agree. Three copies of one
    // answer is two of them going stale.
    const example = JSON.parse(
      readFileSync('edge/store-edge/sample/store-pack.example.json', 'utf8'),
    ) as { merchandisingPolicy: { refillAtBp: number; countStaleAfterMinutes: number } };
    expect(example.merchandisingPolicy.countStaleAfterMinutes).toBe(120);
    expect(example.merchandisingPolicy.refillAtBp).toBe(5_000);
  });
});

/**
 * **The reporting screen, driven over the real socket (D13 · M29-FR-01/02 · API-10).**
 *
 * Everything this screen refuses to do is a thing that looks like working software when it goes
 * wrong. A report that runs and returns nought is indistinguishable from a shop with nothing to
 * report; a figure quoted three hours after the sync stopped looks exactly like a live one; a
 * column added months later rides out of the building in a file somebody emails.
 *
 * So this drives the whole path — the box builds the payload from its own log and its own outbox,
 * the shell carries it, the real session boots on it, and a report is run and written out.
 */
describe('the reporting screen, fed by the box', () => {
  it('boots on what the box injected, with no clock of its own', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    // The box's clock, not the device's. A tablet an hour out would relabel a stale figure as live.
    expect(payload['now']).toBe(NOW);
    expect(payload['laggingAfterMinutes']).toBe(5);
    expect(payload['staleAfterMinutes']).toBe(60);

    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('sales_by_day');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The one sale this box logged, at the price it was rung at.
    expect(outcome.result.figures.find((f) => f.name === 'Taken')?.valueMinor).toBe(145_00);
    expect(outcome.result.figures.find((f) => f.name === 'Bills')?.valueMinor).toBe(1);
    for (const f of outcome.result.figures) expect(f.asAt, `${f.name} has no as-at`).toBe(NOW);
  });

  it('refuses a report this shop does not record, by name, rather than showing nought', async () => {
    const base = await serve(snapshotOf());
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const outcome = reporting.run('waste');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_shop_does_not_record_that_yet');
    expect(outcome.detail).toContain('what is thrown away recorded');
  });

  it('refuses a report this BUILD cannot compute, and does not blame the shop', async () => {
    // The shop records everything `shrinkage` names and there is no code here that works it out.
    // Judged on the pack's records alone it would open with no figures and no rows, under its own
    // name, and be read as "no shrinkage".
    const base = await serve(snapshotOf({
      pack: pack({
        reportingRecords: known([
          'sales_rung_at_the_till', 'cost_prices_on_the_catalogue', 'the_boxs_own_outbox',
          'stock_movements_recorded', 'stock_counted_on_the_shelves',
        ]),
      }),
    }));
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const outcome = reporting.run('shrinkage');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_version_cannot_produce_that_yet');
    expect(outcome.missing, 'the shop was blamed for our gap').toEqual([]);
  });

  it('lists what it cannot run alongside what it can, never hiding it', async () => {
    const base = await serve(snapshotOf());
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const all = reporting.catalogue();
    expect(all.filter((e) => e.availability.available).length).toBeGreaterThan(5);
    expect(all.filter((e) => !e.availability.available).length).toBeGreaterThan(10);
    for (const entry of all) {
      if (entry.availability.available) continue;
      expect(entry.availability.why, `${entry.report.id} says nothing useful`).not.toMatch(/no data/i);
    }
  });

  it('reports the box’s OWN queue, which the cloud cannot tell it', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const base = await serve(snapshotOf({ outbox }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect(payload['unsentCount']).toBe(1);
    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('sync_health');
    if (!outcome.ok) return;
    expect(outcome.result.figures[0]?.valueMinor).toBe(1);
  });

  it('says NEVER SYNCED rather than nought minutes ago', async () => {
    // Zero minutes is the freshest possible answer, and on a box that has never heard from the
    // cloud it would be exactly wrong.
    const base = await serve(snapshotOf({ pack: { ...pack(), receivedAt: null } }));
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const outcome = reporting.run('data_freshness');
    if (!outcome.ok) return;
    const f = outcome.result.figures[0]!;
    expect(f.valueMinor).toBeUndefined();
    expect(f.notAvailableBecause).toContain('never sent anything');
  });

  it('says nothing was CHECKED when the shop has no loss-prevention limits', async () => {
    // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching.
    const base = await serve(snapshotOf({ pack: pack({ lossPreventionRules: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect(payload['exceptionRulesKnown']).toBe(false);
    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('exceptions');
    if (!outcome.ok) return;
    expect(outcome.result.figures[0]?.valueMinor).toBeUndefined();
    expect(outcome.result.figures[0]?.notAvailableBecause).toContain('nothing was checked');
  });

  it('carries NO cost rather than a zero cost for a product with no cost price', async () => {
    // Zero cost reports a 100% margin, which is a lie that reads as very good news.
    const base = await serve(snapshotOf({
      pack: pack({ products: known([{ ...PRODUCTS[0]!, unitCostMinor: undefined }]) }),
    }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    const sales = payload['sales'] as Record<string, unknown>[];
    expect('cogsMinor' in sales[0]!, 'a costless basket was costed anyway').toBe(false);

    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('margin');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Margin')?.valueMinor).toBeUndefined();
    expect(outcome.result.figures.find((f) => f.name === 'Sales with no cost price')?.valueMinor).toBe(1);
  });

  it('carries NO basket size for a record whose lines could not be read', async () => {
    const base = await serve(snapshotOf({ sales: [{ ...SALE, lines: undefined }] }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    const sales = payload['sales'] as Record<string, unknown>[];
    expect('units' in sales[0]!, 'a broken record was counted as a basket of nothing').toBe(false);

    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('basket');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Units per basket')?.valueMinor).toBeUndefined();
    expect(outcome.result.figures.find((f) => f.name === 'Bills with no readable lines')?.valueMinor).toBe(1);
    // The takings are still real and still counted — the till printed them.
    expect(outcome.result.figures.find((f) => f.name === 'Average basket')?.valueMinor).toBe(145_00);
  });

  it('writes a report out under the shop’s OWN access control, and refuses without it', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    // The box names who this screen acts as; nothing here invents it.
    expect(payload['userId']).toBe('u-report');

    const result = bootReporting(payload as never)!.export('sales_by_day');
    expect('csv' in result, 'the analyst could not export their own family').toBe(true);
    if (!('csv' in result)) return;
    expect(result.audit.rowCount).toBe(1);
    expect(result.audit.userId).toBe('u-report');
    expect(result.schema.columns.map((c) => c.name)).toEqual(['saleId', 'at', 'totalMinor', 'tender']);

    // Default-deny: somebody the shop has given no role to gets nothing, from the same check.
    const stranger = bootReporting({ ...payload, userId: 'u-nobody' } as never)!;
    expect('csv' in stranger.export('sales_by_day')).toBe(false);
  });

  it('writes nothing out at all when the box does not know who is looking', async () => {
    // Not a permission failure — a different problem, and it says so. Denying under a default id
    // would put a name nobody holds into the record of who took the shop's data.
    const base = await serve(snapshotOf({
      pack: pack({ reportingPolicy: known({ laggingAfterMinutes: 5, staleAfterMinutes: 60 }) }),
    }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);

    const reporting = bootReporting(payload as never)!;
    // The reports still run: reading them is not the thing that needs a name against it.
    expect(reporting.run('sales_by_day').ok).toBe(true);
    const result = reporting.export('sales_by_day');
    expect('csv' in result).toBe(false);
    if ('csv' in result) return;
    expect(result.detail).toContain('has not been told who is using this screen');
  });

  it('reports TODAY, not every day the box has ever traded', async () => {
    // `sales.log` is never rotated, so the box holds every sale it has ever committed. Handed
    // whole to a report that means today, "Sales by day" reported the week's takings as the
    // day's — nothing failed, and the number was simply wrong on a screen people quote from.
    const earlier = (id: string, tradingDay: string, total: number): LoggedSale => ({
      ...SALE, id, number: id, tradingDay, committedAt: `${tradingDay}T10:00:00.000Z`,
      total, netMinor: total, taxMinor: 0,
    });
    const base = await serve(snapshotOf({
      sales: [earlier('S-OLD1', '2026-08-01', 500_00), earlier('S-OLD2', '2026-08-04', 900_00), SALE],
    }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect(payload['tradingDay']).toBe(DAY);
    expect(payload['sales'], 'the whole log was served as today').toHaveLength(1);

    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('sales_by_day');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Taken')?.valueMinor).toBe(145_00);
    expect(outcome.result.figures.find((f) => f.name === 'Bills')?.valueMinor).toBe(1);
  });

  it('compares today against the last day the box actually holds', async () => {
    const earlier = (id: string, tradingDay: string, total: number): LoggedSale => ({
      ...SALE, id, number: id, tradingDay, committedAt: `${tradingDay}T10:00:00.000Z`,
      total, netMinor: total, taxMinor: 0,
    });
    const base = await serve(snapshotOf({
      sales: [earlier('S-OLD', '2026-08-04', 900_00), SALE],
    }));
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const outcome = reporting.run('day_on_day');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Today')?.valueMinor).toBe(145_00);
    expect(outcome.result.figures.find((f) => f.name === '2026-08-04')?.valueMinor).toBe(900_00);
    expect(outcome.result.figures.find((f) => f.name === 'Up or down')?.valueMinor).toBe(-755_00);
  });

  it('refuses the comparison on a box that holds only today', async () => {
    // A box installed this morning has no yesterday, and a yesterday of nought would report the
    // shop as having doubled its takings overnight.
    const base = await serve(snapshotOf());
    const reporting = bootReporting((await payloadFromScreen(base, 'reporting'))! as never)!;
    const outcome = reporting.run('day_on_day');
    if (!outcome.ok) return;
    const change = outcome.result.figures.find((f) => f.name === 'Up or down')!;
    expect(change.valueMinor).toBeUndefined();
    expect(change.notAvailableBecause).toContain('no earlier trading day');
  });

  it('reports what is selling by department, from the shop’s own catalogue', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect(payload['unitsByCategory']).toEqual({ grocery: 1 });
    const reporting = bootReporting(payload as never)!;
    const outcome = reporting.run('units_by_category');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Named, not shown as an id, because the box carried the department names too.
    expect(outcome.result.figures[0]?.name).toBe('Grocery');
    expect(outcome.result.figures[0]?.valueMinor).toBe(1);
  });

  it('counts an item the catalogue places in no department apart, never inside one', async () => {
    const orphan: LoggedSale = { ...SALE, lines: [{ productId: 'p-unlisted', quantityMinor: 2, uom: 'ea' }] };
    const base = await serve(snapshotOf({ sales: [SALE, orphan] }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect(payload['unitsWithNoCategory']).toBe(2);
    const outcome = bootReporting(payload as never)!.run('units_by_category');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Items in no department')?.valueMinor).toBe(2);
    expect(outcome.result.figures.find((f) => f.name === 'Grocery')?.valueMinor).toBe(1);
  });

  it('serves the screen nothing at all without the tenant’s own freshness thresholds', async () => {
    // A screen inventing them would be deciding, on its own authority, how old a number may be
    // before somebody should stop making decisions on it.
    const base = await serve(snapshotOf({ pack: pack({ reportingPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'reporting')).toBeNull();
    expect(bootReporting(undefined)).toBeNull();
  });

  it('runs nothing at all when the box was never told what this shop records', async () => {
    // Honest for a shop that has just been switched on: not one report, and a reason on each.
    const base = await serve(snapshotOf({ pack: pack({ reportingRecords: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'reporting'))!;
    expect('records' in payload, '"records" must be absent, not empty').toBe(false);
    const reporting = bootReporting(payload as never)!;
    expect(reporting.catalogue().every((e) => !e.availability.available)).toBe(true);
    expect(reporting.run('sales_by_day').ok).toBe(false);
  });
});

/**
 * **The service desk, driven over the real socket (M13-FR-01…04 · M21-FR-03/04).**
 *
 * The till has been saying *"this lane cannot look up a receipt — send the customer to the service
 * desk"* for as long as it has had a refund button, and there was no service desk.
 *
 * The headline is the double refund. `commitReturn` has enforced *a line is returned at most once*
 * since it was written, against a figure the caller supplies — and nothing in this system ever
 * supplied it, so every return was judged against nothing already returned. This drives the real
 * path: find last week's bill in the box's own log, refund it, record it, and ask for the same
 * refund again.
 */
describe('the service desk, fed by the box', () => {
  const BILL: LoggedSale = {
    ...SALE, id: 'S-LASTWEEK', number: 'R-1001', tradingDay: '2026-08-01',
    committedAt: '2026-08-01T10:00:00.000Z', total: 500_00, netMinor: 500_00, taxMinor: 0,
    lines: [{ productId: 'p1', quantityMinor: 3, uom: 'ea' }],
    tenders: [{ kind: 'card', amount: { minor: 500_00 } }],
  };

  const wired = () => ({
    returns: [] as { returnId: string; originalSaleId: string | null; processedAt: string; lines: { productId: string; uom: string; quantityMinor: number }[] }[],
    stockLedger: new Ledger(new InMemoryLedgerStore()),
    outbox: new SyncOutbox(),
  });

  it('is served EVERY bill the box holds, not just today’s', async () => {
    // A receipt from last Tuesday is the ordinary case, and the reason the screen exists.
    const base = await serve(snapshotOf({ sales: [BILL, SALE] }));
    const payload = (await payloadFromScreen(base, 'service'))!;
    const bills = payload['sales'] as { number: string }[];
    expect(bills.map((b) => b.number).sort()).toEqual(['R-1', 'R-1001']);
  });

  it('finds last week’s bill and says what may still come back', async () => {
    const base = await serve(snapshotOf({ sales: [BILL] }));
    const desk = bootService((await payloadFromScreen(base, 'service'))! as never, wired())!;
    const found = desk.lookUp('R-1001');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.receipt.ageDays).toBe(4);
    expect(found.receipt.lines.find((l) => l.productId === 'p1')?.returnableMinor).toBe(3);
  });

  it('REFUSES the same refund twice, once the first is on the box’s own log', async () => {
    const base = await serve(snapshotOf({ sales: [BILL] }));
    const payload = (await payloadFromScreen(base, 'service'))!;
    const local = wired();
    const desk = bootService(payload as never, local)!;

    const first = desk.refund({
      returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'damaged',
      lines: [{ productId: 'p1', quantityMinor: 3, disposition: 'resell' }],
      refundMinor: 150_00, refundTender: 'card',
    });
    expect(first.ok).toBe(true);

    // Exactly what the box's durable return log would hold afterwards.
    local.returns.push({
      returnId: 'RT-1', originalSaleId: 'S-LASTWEEK', processedAt: NOW,
      lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }],
    });

    const again = desk.refund({
      returnId: 'RT-2', number: 'RTN-2', receiptNumber: 'R-1001', reasonCode: 'damaged',
      lines: [{ productId: 'p1', quantityMinor: 3, disposition: 'resell' }],
      refundMinor: 150_00, refundTender: 'card',
    });
    expect(again.ok, 'the same goods were refunded twice').toBe(false);
    if (again.ok) return;
    expect(again.detail).toContain('already been returned');

    // And the bill itself now says so, rather than opening with nothing selectable and no reason.
    const found = desk.lookUp('R-1001');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.refusal).toBe('nothing_left_to_return');
  });

  it('leaves a card refund PENDING and tells the customer the truth', async () => {
    const base = await serve(snapshotOf({ sales: [BILL] }));
    const desk = bootService((await payloadFromScreen(base, 'service'))! as never, wired())!;
    const outcome = desk.refund({
      returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'faulty',
      lines: [{ productId: 'p1', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 50_00, refundTender: 'card',
    });
    if (!outcome.ok) return;
    expect(outcome.committed.refundStatus).toBe('pending');
    expect(outcome.tellTheCustomer).toContain('NOT back on the card yet');
  });

  it('does not put damaged goods back on the shelf', async () => {
    const base = await serve(snapshotOf({ sales: [BILL] }));
    const desk = bootService((await payloadFromScreen(base, 'service'))! as never, wired())!;
    const outcome = desk.refund({
      returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'damaged',
      lines: [{ productId: 'p1', quantityMinor: 1, disposition: 'damaged' }],
      refundMinor: 50_00, refundTender: 'cash',
    });
    if (!outcome.ok) return;
    expect(outcome.committed.restockedLines).toBe(0);
  });

  it('needs a second person above the shop’s own threshold', async () => {
    const base = await serve(snapshotOf({ sales: [BILL] }));
    const desk = bootService((await payloadFromScreen(base, 'service'))! as never, wired())!;
    const outcome = desk.refund({
      returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'faulty',
      lines: [{ productId: 'p1', quantityMinor: 3, disposition: 'resell' }],
      refundMinor: 300_00, refundTender: 'cash',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_a_second_person');
  });

  it('commits nothing at all when the box does not know who is on the desk', async () => {
    const base = await serve(snapshotOf({
      sales: [BILL],
      pack: pack({
        servicePolicy: known({
          returnWindowDays: 30, approvalThresholdMinor: 200_00, noReceiptCapMinor: 100_00,
          agentAuthorityMinor: 50_00, compensationCapMinor: 500_00,
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'service'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const desk = bootService(payload as never, wired())!;
    const outcome = desk.refund({
      returnId: 'RT-1', number: 'RTN-1', receiptNumber: 'R-1001', reasonCode: 'faulty',
      lines: [{ productId: 'p1', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 50_00, refundTender: 'cash',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('runs the case queue on the shop’s own SLA, and says when it is not', async () => {
    const base = await serve(snapshotOf());
    const desk = bootService((await payloadFromScreen(base, 'service'))! as never, wired())!;
    expect(desk.caseList()[0]?.targetsAreDefaults).toBe(false);

    const noPolicy = await serve(snapshotOf({ pack: pack({ slaPolicy: notKnown('never sent') }) }));
    const other = bootService((await payloadFromScreen(noPolicy, 'service'))! as never, wired())!;
    expect(other.caseList()[0]?.targetsAreDefaults).toBe(true);
  });

  it('serves the screen nothing at all without the shop’s own limits', async () => {
    const base = await serve(snapshotOf({ pack: pack({ servicePolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'service')).toBeNull();
    expect(bootService(undefined)).toBeNull();
  });
});

/**
 * **Expiry and recall, driven over the real socket (M10-FR-01…04).**
 *
 * The recall block is the loudest safety claim in this product — *"even offline"* — and it was
 * unreachable: the flag had no field in the pack, and the payload the box served the lane was not
 * a `CatalogueSnapshot` at all, so the till threw on boot before rendering anything.
 */
describe('the expiry and recall screen, fed by the box', () => {
  it('lists what is going out of date, earliest first, from the box’s own batches', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'expiry'))!;
    expect(payload['nearExpiryDays']).toBe(7);

    const screen = bootExpiry(payload as never)!;
    const list = screen.actionList();
    expect(list.map((l) => l.batchId)).toEqual(['B-OLD', 'B-SOON']);
    expect(list[0]?.action).toBe('dispose');
    // Named, because this is a screen about food.
    expect(list[0]?.name).toBe('Toor dal 1kg');
  });

  it('says the shop records NO batch dates, rather than showing an empty list', async () => {
    // "Nothing is expiring" on a shop that has never recorded an expiry date is the most
    // reassuring wrong sentence on this screen.
    const base = await serve(snapshotOf({ pack: pack({ batches: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'expiry'))!;
    expect('batches' in payload, '"batches" must be absent, not empty').toBe(false);
    expect(bootExpiry(payload as never)!.actionList()).toEqual([]);
  });

  it('serves the screen nothing at all without the shop’s own near-expiry window', async () => {
    const base = await serve(snapshotOf({ pack: pack({ expiryPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'expiry')).toBeNull();
    expect(bootExpiry(undefined)).toBeNull();
  });

  it('starts a recall and says how much is still in customers’ homes', async () => {
    const base = await serve(snapshotOf());
    const screen = bootExpiry((await payloadFromScreen(base, 'expiry'))! as never)!;
    const outcome = screen.start({ recallId: 'RC-1', batchId: 'B-SOON', reason: 'supplier notice' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recall.productId).toBe('p1');
    expect(outcome.view.open).toBe(true);
  });

  it('refuses a batch this box has never heard of', async () => {
    const base = await serve(snapshotOf());
    const screen = bootExpiry((await payloadFromScreen(base, 'expiry'))! as never)!;
    const outcome = screen.start({ recallId: 'RC-1', batchId: 'B-NOPE', reason: 'glass' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_such_batch');
  });

  it('starts nothing when the box does not know who is asking', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ expiryPolicy: known({ nearExpiryDays: 7 }) }),
    }));
    const payload = (await payloadFromScreen(base, 'expiry'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const outcome = bootExpiry(payload as never)!
      .start({ recallId: 'RC-1', batchId: 'B-SOON', reason: 'glass' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('will not close a recall without evidence', async () => {
    const started = {
      recallId: 'RC-1', batchId: 'B-SOON', productId: 'p1', reason: 'glass',
      startedBy: 'u-qc', startedAt: '2026-08-05T09:00:00.000Z',
    };
    const base = await serve(snapshotOf({ pack: pack({ recalls: known([started]) }) }));
    const screen = bootExpiry((await payloadFromScreen(base, 'expiry'))! as never)!;
    const outcome = screen.close({ recallId: 'RC-1', evidence: '  ', recoveredQty: 0, disposedQty: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('needs_evidence');
  });
});

/**
 * **Finance, driven over the real socket (M23-FR-04 / QG-07).**
 *
 * The roadmap's acceptance is one sentence: *a CA can sign the control totals.* Until this build
 * nothing produced one, so no month could close — which at least failed in the safe direction.
 */
describe('finance, fed by the box', () => {
  it('states both sides of every figure from what the box was told', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'finance'))!;
    expect(payload['period']).toBe('2026-07');
    expect(payload['journalPrefixes']).toEqual({ takings: 'SALES', tax: 'GST', refunds: 'REFUND' });

    const view = bootFinance(payload as never)!.period();
    expect(view.totals, 'the box served no ledger side').toBeDefined();
    const takings = view.totals?.find((t) => t.name === 'Takings');
    expect(takings?.ledgerMinor).toBe(100_000_00);
    expect(takings?.postedMinor).toBe(100_000_00);
    expect(view.allReconcile).toBe(true);
  });

  it('has NO totals at all when the box has not said what the shop took', async () => {
    // Not an empty list: an empty list reconciles vacuously and the month closes on nothing.
    const base = await serve(snapshotOf({ pack: pack({ financeLedger: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'finance'))!;
    expect('ledger' in payload, '"ledger" must be absent, not zeroed').toBe(false);

    const finance = bootFinance(payload as never)!;
    expect(finance.period().totals).toBeUndefined();
    expect(finance.period().allReconcile, 'nothing compared read as everything agreeing').toBe(false);

    const outcome = finance.close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('the_shop_has_not_told_us_what_it_took');
  });

  it('does not count a posting the accounts have not accepted', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        tallyPostings: known([{
          postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
          debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'queued', attempts: 1,
          queuedAt: '2026-07-31T23:00:00.000Z',
        }]),
      }),
    }));
    const view = bootFinance((await payloadFromScreen(base, 'finance'))! as never)!.period();
    expect(view.totals?.find((t) => t.name === 'Takings')?.postedMinor).toBe(0);
    expect(view.posted.pendingMinor).toBe(100_000_00);
    expect(view.allReconcile).toBe(false);
  });

  it('blocks the close on a refused posting and lists it in full', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        tallyPostings: known([
          { postingId: 'P-1', idempotencyKey: 'k-1', period: '2026-07', journalRef: 'SALES-001',
            debitMinor: 100_000_00, creditMinor: 100_000_00, state: 'posted', attempts: 1,
            queuedAt: '2026-07-31T23:00:00.000Z' },
          { postingId: 'P-2', idempotencyKey: 'k-2', period: '2026-07', journalRef: 'SALES-002',
            debitMinor: 5_00, creditMinor: 5_00, state: 'dead_lettered', attempts: 5,
            queuedAt: '2026-07-31T23:00:00.000Z', lastFailure: 'ledger not found' },
        ]),
      }),
    }));
    const finance = bootFinance((await payloadFromScreen(base, 'finance'))! as never)!;
    expect(finance.period().deadLettered[0]?.lastFailure).toBe('ledger not found');
    const outcome = finance.close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result?.blockers.some((b) => b.kind === 'dead_lettered_postings')).toBe(true);
  });

  it('blocks the close on sales this box has not sent to head office', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e1', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k1', source: 'lane-1', payload: {},
    }));
    const base = await serve(snapshotOf({ outbox }));
    const payload = (await payloadFromScreen(base, 'finance'))!;
    expect(payload['unsentSyncCount']).toBe(1);
    const outcome = bootFinance(payload as never)!.close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result?.blockers.some((b) => b.kind === 'unsent_sync_items')).toBe(true);
  });

  it('closes nothing when the box does not know who is asking', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        financePolicy: known({
          period: '2026-07', tradingDayCutoff: '02:00',
          journalPrefixes: { takings: 'SALES', tax: 'GST', refunds: 'REFUND' },
        }),
      }),
    }));
    const payload = (await payloadFromScreen(base, 'finance'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const outcome = bootFinance(payload as never)!.close();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('serves the screen nothing at all without the shop’s own headings', async () => {
    const base = await serve(snapshotOf({ pack: pack({ financePolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'finance')).toBeNull();
    expect(bootFinance(undefined)).toBeNull();
  });
});

/**
 * **Admin and security, driven over the real socket (M01 · M02 · M33 · M34 · D12).**
 *
 * The design bar is one line: time-bound, audited support access — never standing god-mode. Two
 * things stood between that sentence and the running system: the control had two implementations
 * and the weaker was wired, and the expiry was never checked by anything.
 */
describe('migration, fed by the box', () => {
  it('DERIVES the eight checks rather than being told them', async () => {
    // `decideCutover` has refused GO on eight checks since it was written, and every call site in
    // this codebase had always handed it a literal with the answers typed in.
    const base = await serve(snapshotOf());
    const view = bootMigration((await payloadFromScreen(base, 'migration'))! as never)!.cutover();
    expect(view.decision.go).toBe(false);
    expect(view.derived.checks).toHaveLength(8);
    // Every one of them says where its answer came from.
    for (const check of view.derived.checks) {
      expect(check.evidence.length, `${check.check} says nothing`).toBeGreaterThan(20);
    }
  });

  it('takes what the store box still holds from the box’s OWN outbox', async () => {
    const outbox = new SyncOutbox();
    outbox.enqueue(makeEvent({
      id: 'e-unsent', type: 'SaleCommitted', occurredAt: NOW, idempotencyKey: 'k-unsent',
      source: 'lane-1', payload: {},
    }));
    const base = await serve(snapshotOf({ outbox }));
    const payload = (await payloadFromScreen(base, 'migration'))!;
    expect(payload['edgeUnsyncedItems']).toBe(1);
    const view = bootMigration(payload as never)!.cutover();
    expect(view.decision.failed).toContain('edge_fully_synced');
  });

  it('never turns a section the box was not sent into a passed check', async () => {
    // The one substitution that would undo the whole fix: an empty exception list reads as clean
    // data, and an empty totals list reads as a reconciliation with nothing wrong.
    const base = await serve(snapshotOf({
      pack: pack({ migrationExceptions: notKnown('never sent'), migrationTotals: notKnown('never sent') }),
    }));
    const payload = (await payloadFromScreen(base, 'migration'))!;
    expect('exceptions' in payload, '"exceptions" must be absent, not invented').toBe(false);
    expect('totals' in payload, '"totals" must be absent, not invented').toBe(false);
    const view = bootMigration(payload as never)!.cutover();
    expect(view.derived.notKnown).toContain('blocking_exceptions_cleared');
    expect(view.derived.notKnown).toContain('control_totals_signed');
  });

  it('counts the parallel run CONSECUTIVELY, against the shop’s own required days', async () => {
    const base = await serve(snapshotOf());
    const position = bootMigration((await payloadFromScreen(base, 'migration'))! as never)!.parallel();
    // Two clean days in the pack, three required by this shop's own policy.
    expect(position?.consecutiveCleanDays).toBe(2);
    expect(position?.sufficient).toBe(false);
  });

  it('keeps a blocking exception in the working queue until somebody decides', async () => {
    const base = await serve(snapshotOf());
    const migration = bootMigration((await payloadFromScreen(base, 'migration'))! as never)!;
    expect(migration.cleaning()?.blockingUnresolved).toHaveLength(1);
    const outcome = migration.resolve({
      exceptionId: 'EX-1', action: 'correct', reason: 'counted the shelf and set it to four',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Updated, never removed (hard rule #6).
    expect(outcome.exceptions).toHaveLength(1);
    expect(outcome.exceptions[0]?.resolution?.decidedBy).toBe('u-owner');
  });

  it('refuses a signature from whoever ran the load (§28)', async () => {
    const base = await serve(snapshotOf());
    const payload = (await payloadFromScreen(base, 'migration'))!;
    expect(payload['loadOperator']).toBe('u-eng');
    const outcome = bootMigration({ ...payload, userId: 'u-eng' } as never)!
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'I checked it against the report' });
    expect(outcome.ok).toBe(false);
  });

  it('refuses to sign anything at all when nobody knows who ran the load', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ migrationPolicy: known({ cutoverId: 'cut-1', requiredCleanDays: 3, userId: 'u-owner' }) }),
    }));
    const payload = (await payloadFromScreen(base, 'migration'))!;
    expect('loadOperator' in payload, '"loadOperator" must be absent, not invented').toBe(false);
    const outcome = bootMigration(payload as never)!
      .sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'I checked it against the report' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_ran_the_load');
  });

  it('rolls back on the word of whoever is on the night, needing nobody’s approval', async () => {
    const base = await serve(snapshotOf());
    const outcome = bootMigration((await payloadFromScreen(base, 'migration'))! as never)!
      .rollback({ trigger: 'control_total_failed', legacySystemAvailable: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.evidenceRetained).toBe(true);
    expect(outcome.result.shopKeepsTrading).toBe(true);
  });

  it('decides and signs nothing when the box does not know who is at the desk', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ migrationPolicy: known({ cutoverId: 'cut-1', requiredCleanDays: 3, loadOperator: 'u-eng' }) }),
    }));
    const payload = (await payloadFromScreen(base, 'migration'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const migration = bootMigration(payload as never)!;
    expect(migration.rollback({ trigger: 'owner_decision', legacySystemAvailable: true }).ok).toBe(false);
    expect(migration.sign({ totalId: 'CT-1', signerRole: 'owner', statement: 'checked' }).ok).toBe(false);
  });

  it('serves the screen nothing at all without the shop’s own cutover policy', async () => {
    const base = await serve(snapshotOf({ pack: pack({ migrationPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'migration')).toBeNull();
    expect(bootMigration(undefined)).toBeNull();
  });
});

describe('AI control, fed by the box', () => {
  const stopped = {
    switchId: 'KS-1', tenantId: 'store-1', scope: 'single_agent', agentId: 'A04',
    reason: 'it told a customer the wrong allergen', activatedBy: 'u-manager',
    activatedAt: '2026-08-05T13:00:00.000Z',
  };

  it('draws a stopped assistant as stopped, decided from the switch the box carried', async () => {
    const base = await serve(snapshotOf({ pack: pack({ killSwitches: known([stopped]) }) }));
    const ai = bootAi((await payloadFromScreen(base, 'ai'))! as never)!;
    expect(ai.agents().filter((a) => a.stopped).map((a) => a.agentId)).toEqual(['A04']);
    // Stopped first, because that is what somebody opened this screen about.
    expect(ai.agents()[0]?.agentId).toBe('A04');
  });

  it('and the same box, told no switches, draws none stopped — never an invented empty list', async () => {
    const base = await serve(snapshotOf({ pack: pack({ killSwitches: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'ai'))!;
    expect('killSwitches' in payload, '"killSwitches" must be absent, not invented').toBe(false);
    expect(bootAi(payload as never)!.agents().filter((a) => a.stopped)).toHaveLength(0);
  });

  it('stops the AI in a named person’s name, and the shop keeps trading', async () => {
    const base = await serve(snapshotOf());
    const ai = bootAi((await payloadFromScreen(base, 'ai'))! as never)!;
    const outcome = ai.pull({ scope: 'all_ai', reason: 'the provider is answering nonsense' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stops).toHaveLength(10);
    expect(outcome.detail).toContain('u-owner');
  });

  it('stops nothing when the box does not know who is at the desk', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ aiPolicy: known({ staleAfterMinutes: 60, period: '2026-08', platformCeilingMinor: 1_500_000 }) }),
    }));
    const payload = (await payloadFromScreen(base, 'ai'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const outcome = bootAi(payload as never)!.pull({ scope: 'all_ai', reason: 'stop it' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('shows an agent with no ceiling as having NONE, not a ceiling of nought', async () => {
    const base = await serve(snapshotOf());
    const ai = bootAi((await payloadFromScreen(base, 'ai'))! as never)!;
    // Only A02 has a budget row in the pack.
    expect(ai.agents().find((a) => a.agentId === 'A03')?.budget)
      .toEqual({ known: false, why: 'no_ceiling_set' });
    expect(ai.agents().find((a) => a.agentId === 'A02')?.budget)
      .toEqual({ known: true, spentMinor: 30_000, ceilingMinor: 100_000, remainingMinor: 70_000 });
  });

  it('says the spend is NOT KNOWN when the box has never been told any usage', async () => {
    // A substituted empty list hands every assistant its whole ceiling again, every month.
    const base = await serve(snapshotOf({ pack: pack({ aiUsage: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'ai'))!;
    expect('usage' in payload, '"usage" must be absent, not invented').toBe(false);
    const ai = bootAi(payload as never)!;
    expect(ai.agents().find((a) => a.agentId === 'A02')?.budget)
      .toEqual({ known: false, why: 'spend_not_known' });
    expect(ai.spend()).toBeUndefined();
  });

  it('gives the assistants tab and the cost tab the SAME number, from the same calls', async () => {
    // A real box found the alternative: 95,000 on one tab and nought on the other, same agent.
    const base = await serve(snapshotOf());
    const ai = bootAi((await payloadFromScreen(base, 'ai'))! as never)!;
    const onTheAgent = ai.agents().find((a) => a.agentId === 'A02')!.budget;
    const onTheCostTab = ai.spend()?.byAgent.find((a) => a.agentId === 'A02');
    expect(onTheAgent.known && onTheAgent.spentMinor).toBe(onTheCostTab?.costMinor);
  });

  it('shows an agent never evaluated as never evaluated, not as scoring nought', async () => {
    const base = await serve(snapshotOf());
    const ai = bootAi((await payloadFromScreen(base, 'ai'))! as never)!;
    expect(ai.agents().find((a) => a.agentId === 'A02')?.evaluation).toBeUndefined();
    expect(ai.agents().find((a) => a.agentId === 'A01')?.evaluation?.passed).toBe(19);
  });

  it('reports no spend summary at all when the owner has agreed no platform ceiling (D3)', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ aiPolicy: known({ staleAfterMinutes: 60, period: '2026-08', userId: 'u-owner' }) }),
    }));
    const payload = (await payloadFromScreen(base, 'ai'))!;
    expect('platformCeilingMinor' in payload).toBe(false);
    expect(bootAi(payload as never)!.spend()).toBeUndefined();
  });

  it('summarises spend against the owner’s own ceiling when he has set one', async () => {
    const base = await serve(snapshotOf());
    const summary = bootAi((await payloadFromScreen(base, 'ai'))! as never)!.spend();
    expect(summary?.totalMinor).toBe(30_000);
    expect(summary?.platformCeilingMinor).toBe(1_500_000);
  });

  it('serves the screen nothing at all without the shop’s own AI policy', async () => {
    const base = await serve(snapshotOf({ pack: pack({ aiPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'ai')).toBeNull();
    expect(bootAi(undefined)).toBeNull();
  });
});

describe('admin and security, fed by the box', () => {
  const live = {
    sessionId: 'S-LIVE', requesterId: 'u-eng', requesterName: 'Engineer', approvedBy: 'u-owner',
    reason: 'investigating the duplicate settlement raised in ticket 4471',
    scopes: ['read:settlements'], tenantId: 't1',
    startedAt: '2026-08-05T13:00:00.000Z', expiresAt: '2026-08-05T15:00:00.000Z', actions: [],
  };

  it('judges a support session against the box’s clock, not a stored flag', async () => {
    const base = await serve(snapshotOf({ pack: pack({ supportSessions: known([live]) }) }));
    const admin = bootAdmin((await payloadFromScreen(base, 'admin'))! as never)!;
    // NOW is 14:00; the grant runs to 15:00.
    expect(admin.support()[0]?.active).toBe(true);
    expect(admin.support()[0]?.minutesLeft).toBe(60);
  });

  it('reports an EXPIRED session as not access at all', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ supportSessions: known([{ ...live, expiresAt: '2026-08-05T13:30:00.000Z' }]) }),
    }));
    const admin = bootAdmin((await payloadFromScreen(base, 'admin'))! as never)!;
    expect(admin.support()[0]?.active, 'an expired grant still read as access').toBe(false);
  });

  it('REFUSES blanket access — the rule the API path could not even state', async () => {
    const base = await serve(snapshotOf());
    const admin = bootAdmin((await payloadFromScreen(base, 'admin'))! as never)!;
    const outcome = admin.grant({
      request: {
        requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Engineer',
        reason: 'investigating the duplicate settlement raised in ticket 4471',
        scopes: [], tenantId: 'store-1', minutes: 60, at: NOW,
      },
      approval: { subjectRef: 'R-1', status: 'approved', decidedBy: 'u-owner' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('never blanket admin');
  });

  it('lets nobody in when the box does not know who is letting them', async () => {
    const base = await serve(snapshotOf({
      pack: pack({ adminPolicy: known({ dormantAfterDays: 60 }) }),
    }));
    const payload = (await payloadFromScreen(base, 'admin'))!;
    expect('userId' in payload, '"userId" must be absent, not invented').toBe(false);
    const outcome = bootAdmin(payload as never)!.grant({
      request: {
        requestId: 'R-1', requesterId: 'u-eng', requesterName: 'Engineer',
        reason: 'investigating the duplicate settlement raised in ticket 4471',
        scopes: ['read:settlements'], tenantId: 'store-1', minutes: 60, at: NOW,
      },
      approval: { subjectRef: 'R-1', status: 'approved', decidedBy: 'u-owner' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('nobody_is_named_at_this_desk');
  });

  it('reports a fleet as UNENFORCED when the shop has set no version policy', async () => {
    // Judging it against a minimum nobody set would report it compliant with a rule the shop
    // never made.
    const base = await serve(snapshotOf({ pack: pack({ versionPolicy: notKnown('never sent') }) }));
    const payload = (await payloadFromScreen(base, 'admin'))!;
    expect('versionPolicy' in payload).toBe(false);
    const fleet = bootAdmin(payload as never)!.fleet();
    expect(fleet.policyKnown).toBe(false);
    expect(fleet.summary).toBeUndefined();
  });

  it('reports retention as UNDECIDED when the shop has set no policy', async () => {
    const base = await serve(snapshotOf());
    expect(bootAdmin((await payloadFromScreen(base, 'admin'))! as never)!.retention()).toBeUndefined();
  });

  it('flags a privileged account with no second factor', async () => {
    const base = await serve(snapshotOf({
      pack: pack({
        accounts: known([{
          userId: 'u-boss', tenantId: 't1', username: 'boss',
          person: { fullName: 'Owner', email: 'owner@example.com' },
          status: 'active', privileged: true, mfaEnrolled: false,
          lastLoginAt: '2026-08-05T09:00:00.000Z',
        }]),
      }),
    }));
    const rows = bootAdmin((await payloadFromScreen(base, 'admin'))! as never)!.access();
    expect(rows[0]?.flags.join(' ')).toContain('second factor');
  });

  it('serves the screen nothing at all without the shop’s own windows', async () => {
    const base = await serve(snapshotOf({ pack: pack({ adminPolicy: notKnown('never sent') }) }));
    expect(await payloadFromScreen(base, 'admin')).toBeNull();
    expect(bootAdmin(undefined)).toBeNull();
  });
});
