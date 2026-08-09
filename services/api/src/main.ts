// The composition root — the one place the whole cloud API is assembled and started.
//
// Everything above this file is pure and injected; this is where the real database, the real
// signing key and the real socket arrive. Keeping that in one file is what makes every other file
// testable without any of them.
//
// The order it does things in is the deployment contract:
//
//   1. **Check the configuration.** If anything is missing, a placeholder, or too short to be a
//      secret, print every problem at once and **exit non-zero**. Nothing else runs. A service
//      that starts with a default signing key is a service running in production with one.
//   2. **Open the event store.** Before the surface, because the surface is built around it —
//      the thirteen services take their persistence as a port, and this is where the real one
//      is supplied (`adapters.ts`).
//   3. **Build the surface.** Thirteen services on one router. A route that breaks the kernel's
//      conventions fails here, at boot, not on the request that finds it.
//   4. **Listen**, and answer `/livez` and `/readyz` differently — a database it cannot reach
//      means take me out of rotation, not restart me.
//   5. **On SIGTERM, drain.** In-flight requests finish before the process goes.

import { Client } from 'pg';
import { SqlEventStore } from '../../../packages/persistence/src/event-store';
import { SqlConfigVersionStore } from '../../../packages/persistence/src/config-store';
import { SqlNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { pgClient } from '../../../packages/persistence/src/pg-client';
import { DurableTenantSettings } from '../../../packages/tenant/src/index';
import {
  buildRouter, loadConfig, startHttpServer, CLOUD_API_CONFIG, SqlIdempotencyStore, SqlAuditSink,
  structuredLogger, combineObservers, RequestMetrics,
  type Route,
} from '../../kernel/src/index';
import { tenantAccessResolver, seedGenesisOwner } from './access';
import type { TargetKind } from '../../../packages/migration/src/trial';
import { catalogueRoutes, hmacSigner } from '../../catalogue/src/index';
import { pricingRoutes } from '../../pricing/src/index';
import { priceListRoutes } from '../../pricing/src/price-list';
import { promotionCatalogueRoutes } from '../../pricing/src/promotion-catalogue';
import { posRoutes } from '../../pos/src/index';
import { returnsRoutes } from '../../pos/src/returns';
import { cashRoutes } from '../../pos/src/cash';
import { supplierPortalRoutes } from '../../purchase/src/supplier-portal';
import { shiftRoutes } from '../../pos/src/shift';
import { lpCasesRoutes, lpRulesRoutes } from '../../pos/src/loss-prevention';
import { fraudSignalsRoutes } from '../../pos/src/fraud-signals';
import { storedValueRoutes } from '../../customer/src/stored-value';
import { promotionRoutes } from '../../pricing/src/promotions';
import { settlementRoutes } from '../../finance/src/settlement';
import { b2bCreditRoutes } from '../../finance/src/b2b-credit';
import { b2bCollectionsRoutes } from '../../finance/src/b2b-collections';
import { b2bCommissionRoutes } from '../../finance/src/b2b-commission';
import { b2bDocumentsRoutes } from '../../finance/src/b2b-documents';
import { concessionRoutes } from '../../finance/src/concession';
import { scrapRoutes } from '../../finance/src/scrap';
import { facilitiesRoutes } from '../../platform/src/facilities';
import { facilitiesAssetsRoutes } from '../../platform/src/facilities-assets';
import { facilitiesMonitoringRoutes } from '../../platform/src/facilities-monitoring';
import { inventoryRoutes } from '../../inventory/src/index';
import { warehouseRoutes } from '../../inventory/src/warehouse';
import { transfersRoutes } from '../../inventory/src/warehouse-transfers';
import { replenishmentRoutes } from '../../inventory/src/replenishment';
import { countsRoutes } from '../../inventory/src/counts';
import { productionRoutes } from '../../inventory/src/production';
import { packagingRoutes } from '../../inventory/src/packaging';
import { wasteRoutes } from '../../inventory/src/waste';
import { integrationRoutes } from '../../platform/src/integration';
import { webhookRoutes, webhookHasher } from '../../platform/src/webhooks';
import { connectorRoutes } from '../../platform/src/connectors';
import { identityRoutes, tokenAuthenticator } from '../../identity/src/index';
import { platformRoutes, inMemorySettings, emptyExportBundle } from '../../platform/src/index';
import { purchaseRoutes } from '../../purchase/src/index';
import { financeRoutes } from '../../finance/src/index';
import { reportingRoutes } from '../../reporting/src/index';
import { customerRoutes } from '../../customer/src/index';
import { ordersRoutes } from '../../orders/src/index';
import { fulfilmentRoutes } from '../../fulfilment/src/index';
import { migrationRoutes } from '../../migration/src/index';
import { aiRoutes } from '../../ai/src/index';
import {
  catalogueAdapter, pricingAdapter, priceListAdapter, posAdapter, returnsAdapter, inventoryAdapter, warehouseAdapter, transfersAdapter, countsAdapter, productionAdapter, packagingAdapter, wasteAdapter, purchaseAdapter, financeAdapter, settlementAdapter,
  customerAdapter, ordersAdapter, fulfilmentAdapter, identityAdapter, platformAdapter,
  reportingAdapter, migrationAdapter, aiAdapter, storedValueAdapter, promotionAdapter, promotionCatalogueAdapter, cashAdapter, shiftAdapter, lpCasesAdapter, lpRulesAdapter, fraudSignalsAdapter, b2bCreditAdapter, b2bCollectionsAdapter, b2bCommissionAdapter, b2bDocumentsAdapter, supplierPortalAdapter, concessionAdapter, scrapAdapter, facilitiesAdapter, facilitiesAssetsAdapter, facilitiesMonitoringAdapter, integrationAdapter, webhookAdapter, connectorAdapter,
} from './adapters';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from './roles';
import type { DependencyProbe } from '../../platform/src/index';
import type { EventStore } from '../../../packages/persistence/src/event-store';

const now = (): string => new Date().toISOString();

/**
 * How long a click-and-collect reservation holds stock.
 *
 * Named here rather than typed twice as `60`, because the stub path and the live path both need
 * it and two literals drift. It belongs in tenant settings (M02) once the config store is on this
 * surface — a shop with one van and a shop with six do not hold stock for the same hour.
 */
const HOLD_MINUTES = 60;

/**
 * Build the whole API surface.
 *
 * Exported so a test can assemble it exactly as production does — the surface gate in
 * `tests/integration/thirteen-apis-one-surface.test.ts` proves properties of *this* list, and it
 * would prove nothing about a list assembled differently here.
 */
export function buildSurface(deps: {
  readonly signingKey: string;
  readonly migrationTargetKind: TargetKind;
  /**
   * Reachability of what the shop cannot trade without. A real call every time it is asked, not a
   * flag something set earlier — a cached "reachable: true" is a health check that reports the
   * last time things were fine.
   */
  readonly probes?: () => Promise<readonly DependencyProbe[]>;
  /**
   * Where the events go. Omitted, the surface still assembles and answers — which is what the
   * route-shape tests need — but nothing persists. Supplying it is what turns the API from a
   * shell into a system, and `main()` always does.
   */
  readonly store?: EventStore;
  /** Durable per-tenant settings (a SqlConfigVersionStore-backed store in production). */
  readonly settings?: DurableTenantSettings;
  /** Durable gap-free number series (a SqlNumberSeriesStore-backed store in production). */
  readonly numberSeries?: NumberSeriesStore;
}): readonly Route[] {
  const signer = hmacSigner(deps.signingKey);
  const whHasher = webhookHasher(deps.signingKey);
  const empty = <T>(v: T) => () => v;
  const store = deps.store;

  const probes = deps.probes ?? (async () => []);

  return [
    ...identityRoutes(store === undefined ? {
      roles: empty([]), permissionsOf: empty([]), recordGrant: () => {},
      branches: empty([]), allocateNumber: () => Promise.resolve(1), now,
    } : identityAdapter({ store, now, roleCatalogue: ROLE_CATALOGUE, numberSeries: deps.numberSeries })),
    ...catalogueRoutes(store === undefined ? {
      signer, currentPack: empty(undefined), storePack: () => {},
      buildSnapshot: (tenantId) => ({ tenantId, version: 1, builtAt: now(), products: [], barcodes: [] }),
      approvalsSince: empty([]), now,
    } : catalogueAdapter({ store, signer, now })),
    ...pricingRoutes(store === undefined
      ? { recordPriceChange: () => {}, canApprove: () => Promise.resolve(false), now }
      : pricingAdapter({ store, now })),
    ...priceListRoutes(store === undefined
      ? { entries: empty([]), recordEntry: () => {}, now }
      : priceListAdapter({ store, now })),
    ...promotionRoutes(store === undefined
      ? { launchedPromotion: empty(undefined), recordLaunch: () => {}, now }
      : promotionAdapter({ store, now })),
    ...promotionCatalogueRoutes(store === undefined
      ? { promotion: empty(undefined), promotions: empty([]), recordDefined: () => {}, recordStatus: () => {}, now }
      : promotionCatalogueAdapter({ store, now })),
    ...purchaseRoutes(store === undefined ? {
      matchLines: empty([]), recordCapture: () => {}, recordMatch: () => {}, applyBankChange: () => {},
      openCommitments: empty(undefined), now,
    } : purchaseAdapter({ store, now })),
    ...supplierPortalRoutes(store === undefined ? {
      partner: empty(undefined), submissions: empty([]), statementLines: empty([]), opening: empty(0),
      recordPartner: () => {}, recordSubmission: () => {}, recordStatementLine: () => {}, recordOpening: () => {}, now,
    } : supplierPortalAdapter({ store, now })),
    ...inventoryRoutes(store === undefined ? {
      availability: empty([]), appendMovement: () => {}, isKnown: empty(false), valuation: empty([]),
      ageing: empty({ lots: [], unvaluedMinor: 0 }),
      performance: empty({ from: '', to: '', periodDays: 0, cogs: { minor: 0, currency: 'INR' }, averageInventory: { minor: 0, currency: 'INR' } }), now,
    } : inventoryAdapter({ store, now })),
    ...warehouseRoutes(store === undefined ? {
      bins: empty([]), contents: empty({}), appliedCommandIds: empty([]), recordBin: () => {}, recordMovement: () => {}, now,
    } : warehouseAdapter({ store, now })),
    ...transfersRoutes(store === undefined ? {
      transfer: empty(undefined), recordProposed: () => {}, recordDispatched: () => {}, recordReceived: () => {}, now,
    } : transfersAdapter({ store, now })),
    ...replenishmentRoutes({ now }),
    ...countsRoutes(store === undefined ? {
      onHand: empty(0), reconciliations: empty([]), countExists: empty(false), recordReconciliation: () => {}, now,
    } : countsAdapter({ store, now })),
    ...productionRoutes(store === undefined ? {
      recipe: empty(undefined), recordRecipe: () => {}, ingredientCost: empty(undefined), recordCost: () => {},
      onHand: empty(0), priorConsumption: empty({}),
      runExists: empty(false), runs: empty([]), run: empty(undefined), recordRun: () => {}, recordRelease: () => {},
      enabledDepartments: empty([]), recordDepartmentEnabled: () => {}, now,
    } : productionAdapter({ store, now })),
    ...packagingRoutes(store === undefined ? {
      item: empty(undefined), movements: empty([]), registerItem: () => {}, recordMovement: () => {}, now,
    } : packagingAdapter({ store, now })),
    ...wasteRoutes(store === undefined ? {
      records: empty([]), coverage: empty({ expected: [], departmentNames: {} }), recordWaste: () => {}, recordCoverage: () => {}, now,
    } : wasteAdapter({ store, now })),
    ...integrationRoutes(store === undefined ? {
      matrix: empty([]), adapters: empty([]), heartbeats: empty([]),
      recordMatrixEntry: () => {}, recordAdapter: () => {}, recordHeartbeat: () => {}, now,
    } : integrationAdapter({ store, now })),
    ...webhookRoutes(store === undefined ? {
      config: empty(undefined), seenDeliveryIds: empty([]), recordConfig: () => {}, recordDelivery: () => {}, hasher: whHasher, now,
    } : webhookAdapter({ store, now, hasher: whHasher })),
    ...connectorRoutes(store === undefined ? {
      mapping: empty(undefined), recordMapping: () => {}, now,
    } : connectorAdapter({ store, now })),
    ...posRoutes(store === undefined ? {
      catalogue: empty(new Map()), currentPackVersion: empty(1),
      saleHoldingReceipt: empty(undefined), isBanked: empty(false),
      bankSale: () => {}, recordExceptions: () => {}, openExceptions: empty([]), now,
    } : posAdapter({ store, now })),
    ...returnsRoutes(store === undefined ? {
      originalSale: empty(undefined), priorReturns: empty([]), priorRefunds: empty([]),
      recordReturn: () => {}, now,
    } : returnsAdapter({ store, now })),
    ...cashRoutes(store === undefined
      ? { tillMovements: empty([]), recordCashMovement: () => {}, now }
      : cashAdapter({ store, now })),
    ...shiftRoutes(store === undefined
      ? { closedShift: empty(undefined), recordShiftClose: () => {}, overShortShifts: empty([]), now }
      : shiftAdapter({ store, now })),
    ...lpCasesRoutes(store === undefined
      ? { cases: empty([]), case: empty(undefined), recordOpened: () => {}, recordEvidence: () => {}, recordClosed: () => {}, now }
      : lpCasesAdapter({ store, now })),
    ...lpRulesRoutes(store === undefined
      ? { rules: empty([]), recordRule: () => {}, now }
      : lpRulesAdapter({ store, now })),
    ...fraudSignalsRoutes(store === undefined
      ? { thresholds: empty({}), recordThresholds: () => {}, bankHolders: empty([]), now }
      : fraudSignalsAdapter({ store, now })),
    ...customerRoutes(store === undefined ? {
      consentRecords: empty([]), appendConsent: () => {}, pointsBalance: empty(undefined),
      pointsMovements: empty([]), recordPointsMovement: () => {}, now,
    } : customerAdapter({ store, now })),
    ...storedValueRoutes(store === undefined ? {
      instrument: empty(undefined), movements: empty([]), recordIssue: () => {}, recordMovement: () => {}, now,
    } : storedValueAdapter({ store, now })),
    ...ordersRoutes(store === undefined ? {
      onHand: empty(new Map()), outstanding: empty([]), holdReservations: () => {},
      holdMinutes: HOLD_MINUTES, now,
      recordPlaced: () => {}, orderState: empty(undefined), orderReservations: empty([]),
      recordTransition: () => {}, releaseReservations: () => {},
    } : ordersAdapter({ store, now, holdMinutes: HOLD_MINUTES })),
    ...fulfilmentRoutes(store === undefined
      ? { appendAttempt: () => {}, attempts: empty([]), assigned: empty([]), now }
      : fulfilmentAdapter({ store, now })),
    ...financeRoutes(store === undefined ? {
      periodStates: empty(new Map()), nextOpenPeriod: empty(now().slice(0, 7)),
      appendJournal: () => {}, controlTotals: empty([]), postersIn: empty([]),
      markClosed: () => {}, now,
    } : financeAdapter({ store, now })),
    ...settlementRoutes(store === undefined ? {
      importedBatchIds: empty([]), recordBatch: () => {}, credits: empty([]),
      electronicTenders: empty([]), investigations: empty([]),
      recordInvestigationOpened: () => {}, recordInvestigationEvidence: () => {}, recordInvestigationResolved: () => {}, now,
    } : settlementAdapter({ store, now })),
    ...b2bCreditRoutes(store === undefined ? {
      account: empty(undefined), outstandingMinor: empty(0), recordAccount: () => {}, recordReceivable: () => {}, now,
    } : b2bCreditAdapter({ store, now })),
    ...b2bCollectionsRoutes(store === undefined ? {
      invoices: empty([]), recordInvoice: () => {}, recordPayment: () => {}, now,
    } : b2bCollectionsAdapter({ store, now })),
    ...b2bCommissionRoutes(store === undefined ? {
      accruals: empty([]), recordAccrual: () => {}, now,
    } : b2bCommissionAdapter({ store, now })),
    ...b2bDocumentsRoutes(store === undefined ? {
      document: empty(undefined), documents: empty([]), convertedQuotationIds: empty([]), recordDocument: () => {},
      allocateNumber: () => Promise.resolve(1), creditAllowed: empty(false), now,
    } : b2bDocumentsAdapter({ store, now, numberSeries: deps.numberSeries })),
    ...concessionRoutes(store === undefined ? {
      contract: empty(undefined), sales: empty([]), recordContract: () => {}, recordSale: () => {}, now,
    } : concessionAdapter({ store, now })),
    ...scrapRoutes(store === undefined ? {
      scrapSales: empty([]), recordScrapSale: () => {}, recordPosted: () => {}, now,
    } : scrapAdapter({ store, now })),
    ...facilitiesRoutes(store === undefined ? {
      schedules: empty([]), tasks: empty([]), recordSchedule: () => {}, recordTaskDue: () => {}, recordTaskCompleted: () => {},
      incidents: empty([]), recordIncident: () => {}, now,
    } : facilitiesAdapter({ store, now })),
    ...facilitiesAssetsRoutes(store === undefined ? {
      assets: empty([]), services: empty([]), downtime: empty([]), energyReadings: empty([]),
      recordAsset: () => {}, recordService: () => {}, recordDowntime: () => {}, recordEnergy: () => {}, now,
    } : facilitiesAssetsAdapter({ store, now })),
    ...facilitiesMonitoringRoutes(store === undefined ? {
      ranges: empty([]), readings: empty([]), contents: empty([]), powerEvents: empty([]),
      recordRange: () => {}, recordReading: () => {}, recordContents: () => {}, recordPowerEvent: () => {}, now,
    } : facilitiesMonitoringAdapter({ store, now })),
    ...reportingRoutes(store === undefined
      ? { figures: empty([]), now }
      : reportingAdapter({ store, now })),
    ...platformRoutes(store === undefined ? {
      probe: probes, flags: empty({}), setFlag: () => {}, recordSupportAccess: () => {},
      settings: inMemorySettings(), exportTenant: emptyExportBundle,
      setBranding: () => {}, branding: empty(undefined),
      setEntitlement: () => {}, entitlements: empty([]), now,
    } : platformAdapter({ store, now, probes, settings: deps.settings ?? inMemorySettings() })),
    ...migrationRoutes(store === undefined ? {
      target: (tenantId) => ({
        targetId: `tgt-${tenantId}`, tenantId,
        kind: deps.migrationTargetKind, label: deps.migrationTargetKind,
      }),
      // Not `'u-owner'` and `'u-operator'`. A control that compares a caller against a
      // placeholder is satisfied by anybody who types the placeholder.
      findings: empty([]), acceptances: empty([]), signatures: empty([]),
      recordAcceptance: () => {}, ownerId: empty(undefined),
      extractionOperator: empty(undefined), now,
    } : migrationAdapter({
      store, now, targetKind: deps.migrationTargetKind, ownerRoleId: OWNER_ROLE_ID,
    })),
    ...aiRoutes(store === undefined ? {
      // Stopped by default, matching the adapter. A kill switch that defaults off is an agent
      // running because nobody has told it not to.
      killSwitchOn: empty(true), setKillSwitch: () => {},
      budget: empty({ capMinor: 0, spentMinor: 0, periodEnds: now() }),
      enabledAgents: empty([]), run: empty([]), openProposals: empty([]), now,
    } : aiAdapter({ store, now })),
  ];
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  // 1 — Configuration. Every problem at once, then stop.
  const config = loadConfig(CLOUD_API_CONFIG, env);
  if (!config.ok) {
    process.stderr.write(`\n${config.detail}\n\n`);
    process.exitCode = 78; // EX_CONFIG — a configuration fault, not a crash
    return;
  }
  const settings = config.value!;

  // 2 — Persistence, before the surface, because the surface is built around it.
  const db = new Client({ connectionString: settings['DATABASE_URL']! });
  await db.connect();
  const store = new SqlEventStore(pgClient(db));

  // 2b — Genesis owner (optional bootstrap). Because granting a role itself needs a role
  // (maker-checker), a brand-new tenant has nobody who can grant the first one. Where the initial
  // owner is configured, establish them once — idempotent, a no-op if the tenant already has any
  // grant. The owner's identity is an owner input supplied by configuration, not decided here.
  const genesisTenant = settings['BOOTSTRAP_OWNER_TENANT_ID'];
  const genesisOwner = settings['BOOTSTRAP_OWNER_USER_ID'];
  if (genesisTenant !== undefined && genesisOwner !== undefined) {
    const outcome = await seedGenesisOwner(store, OWNER_ROLE_ID, genesisTenant, genesisOwner, new Date().toISOString());
    process.stdout.write(`genesis owner for tenant ${genesisTenant}: ${outcome}\n`);
  }

  // 3 — The surface. A route that breaks a convention fails here, not on the request that finds it.
  //
  // Built exactly once. The first version of this built it twice — once to check the shape at boot
  // and again with the store behind it — and then served `live.router!` without checking `live.ok`.
  // Two surfaces that are asserted to be identical is one surface and one assumption, and the
  // assumption is the one holding the non-null.
  const reachable = async (): Promise<boolean> => {
    try { await db.query('SELECT 1'); return true; } catch { return false; }
  };

  const built = buildRouter(buildSurface({
    signingKey: settings['PACK_SIGNING_KEY']!,
    migrationTargetKind: settings['MIGRATION_TARGET_KIND'] as TargetKind,
    store,
    // Durable, append-only per-tenant settings: setup answers land in config_versions and survive a
    // restart, the same table and rules the in-memory path uses in tests.
    settings: new DurableTenantSettings(new SqlConfigVersionStore(pgClient(db))),
    numberSeries: new SqlNumberSeriesStore(pgClient(db)),
    probes: async () => [{
      name: 'postgres',
      criticality: 'shop_cannot_trade_without_it',
      reachable: await reachable(),
    }],
  }));
  if (!built.ok) {
    process.stderr.write(`\nthe API surface is malformed and this service will not start:\n${
      built.refusals.map((r) => `  • ${r.detail}`).join('\n')}\n\n`);
    await db.end();
    process.exitCode = 78;
    return;
  }

  // Observability: one structured JSON line per request to stdout, and in-memory request metrics
  // served at /metricz. Provider-neutral (P-06) — a real log shipper or metrics/OTel exporter is a
  // change to these two lines, not to any handler.
  const metrics = new RequestMetrics();
  const observe = combineObservers(
    structuredLogger((line) => process.stdout.write(`${line}\n`)),
    metrics.record,
  );

  const server = startHttpServer({
    router: built.router!,
    observe,
    metricsSnapshot: () => metrics.snapshot(),

    // Tokens are verified against the identity provider's key, and the reason a token was not
    // believed goes to the operator's log — never back to the caller, who is told "unauthenticated"
    // and no more. "The signature did not verify" and "that token expired" are different sentences,
    // and the difference is free information for whoever is trying tokens.
    authenticate: tokenAuthenticator(
      {
        secret: settings['IDP_SIGNING_KEY']!,
        issuer: settings['IDP_ISSUER']!,
        audience: settings['IDP_AUDIENCE']!,
      },
      (reason) => { process.stderr.write(`auth refused: ${reason}\n`); },
    ),
    // Real, per-tenant authorization. Was `new AccessControl([], [])` — a global, empty table that
    // authorised NOTHING and, worse, was never rebuilt from anyone's grants, so the whole least-
    // privilege apparatus was inert on the live surface. Now every request resolves the caller's
    // authority from THEIR tenant's own `RoleGranted` history in the ledger. Default-deny survives:
    // a tenant with no grants still authorises nothing — but now for the right reason, and a
    // provisioned tenant's owner and staff can actually act.
    access: tenantAccessResolver(store, ROLE_CATALOGUE),
    // Durable and shared. In memory it emptied on every restart and was never shared between
    // instances, so the guard that refuses a different request under a used key was quietly not
    // there — which is not a crash, and would never have shown up in a test.
    idempotency: new SqlIdempotencyStore(pgClient(db)),

    // The audit trail. Optional in the kernel's type and NOT optional in a deployment: the port
    // existed, nothing supplied it, and `writeAudit` returned immediately on every request — so
    // hard rule #6 was protecting evidence that was never being kept.
    audit: new SqlAuditSink(pgClient(db), (detail) => { process.stderr.write(`${detail}\n`); }),
    newTraceId: () => `t-${Math.random().toString(36).slice(2, 10)}`,
    port: Number(settings['PORT']),
    dependenciesReachable: reachable,
  });

  process.stdout.write(`sre-api listening on ${settings['PORT']}, ${built.router!.list().length} routes\n`);

  // 5 — Drain on SIGTERM. Killing in-flight work is a sale that reached the process and not the
  // database, while the till believes it was delivered.
  const shutdown = (signal: string) => {
    void (async () => {
      process.stdout.write(`${signal}: draining\n`);
      await server.stop();
      await db.end();
      process.stdout.write('stopped cleanly\n');
    })();
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}
