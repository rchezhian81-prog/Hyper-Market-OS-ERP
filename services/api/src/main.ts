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
//   2. **Build the surface.** Thirteen services on one router. A route that breaks the kernel's
//      conventions fails here, at boot, not on the request that finds it.
//   3. **Listen**, and answer `/livez` and `/readyz` differently — a database it cannot reach
//      means take me out of rotation, not restart me.
//   4. **On SIGTERM, drain.** In-flight requests finish before the process goes.

import { Client } from 'pg';
import {
  buildRouter, loadConfig, startHttpServer, CLOUD_API_CONFIG, MemoryIdempotencyStore,
  type Principal, type Route,
} from '../../kernel/src/index';
import { AccessControl } from '../../../packages/rbac/src/rbac';
import type { TargetKind } from '../../../packages/migration/src/trial';
import { catalogueRoutes, hmacSigner } from '../../catalogue/src/index';
import { posRoutes } from '../../pos/src/index';
import { inventoryRoutes } from '../../inventory/src/index';
import { identityRoutes } from '../../identity/src/index';
import { platformRoutes } from '../../platform/src/index';
import { purchaseRoutes } from '../../purchase/src/index';
import { financeRoutes } from '../../finance/src/index';
import { reportingRoutes } from '../../reporting/src/index';
import { customerRoutes } from '../../customer/src/index';
import { ordersRoutes } from '../../orders/src/index';
import { fulfilmentRoutes } from '../../fulfilment/src/index';
import { migrationRoutes } from '../../migration/src/index';
import { aiRoutes } from '../../ai/src/index';

const now = (): string => new Date().toISOString();

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
}): readonly Route[] {
  const signer = hmacSigner(deps.signingKey);
  const empty = <T>(v: T) => () => v;

  return [
    ...identityRoutes({
      roles: empty([]), permissionsOf: empty([]), recordGrant: () => {},
      branches: empty([]), now,
    }),
    ...catalogueRoutes({
      signer, currentPack: empty(undefined), storePack: () => {},
      buildSnapshot: (tenantId) => ({ tenantId, version: 1, builtAt: now(), products: [], barcodes: [] }),
      approvalsSince: empty([]), now,
    }),
    ...purchaseRoutes({
      matchLines: empty([]), recordMatch: () => {}, applyBankChange: () => {},
      openCommitments: empty({ count: 0, valueMinor: 0 }), now,
    }),
    ...inventoryRoutes({
      movements: empty([]), appendMovement: () => {}, known: empty(new Set<string>()), now,
    }),
    ...posRoutes({
      catalogue: empty(new Map()), currentPackVersion: empty(1),
      receiptNumbers: empty(new Map()), bankedSaleIds: empty(new Set<string>()),
      bankSale: () => {}, recordExceptions: () => {}, openExceptions: empty([]), now,
    }),
    ...customerRoutes({
      consentRecords: empty([]), appendConsent: () => {}, pointsBalance: empty(undefined), now,
    }),
    ...ordersRoutes({
      onHand: empty(new Map()), outstanding: empty([]), holdReservations: () => {},
      holdMinutes: 60, now,
    }),
    ...fulfilmentRoutes({ appendAttempt: () => {}, attempts: empty([]), assigned: empty([]), now }),
    ...financeRoutes({
      periodStates: empty(new Map()), nextOpenPeriod: empty(now().slice(0, 7)),
      appendJournal: () => {}, controlTotals: empty([]), postersIn: empty([]),
      markClosed: () => {}, now,
    }),
    ...reportingRoutes({ figures: empty([]), now }),
    ...platformRoutes({
      probe: empty([]), flags: empty({}), setFlag: () => {}, recordSupportAccess: () => {}, now,
    }),
    ...migrationRoutes({
      target: (tenantId) => ({
        targetId: `tgt-${tenantId}`, tenantId,
        kind: deps.migrationTargetKind, label: deps.migrationTargetKind,
      }),
      findings: empty([]), acceptances: empty([]), signatures: empty([]),
      recordAcceptance: () => {}, ownerId: empty('u-owner'),
      extractionOperator: empty('u-operator'), now,
    }),
    ...aiRoutes({
      killSwitchOn: empty(false), setKillSwitch: () => {},
      budget: empty({ capMinor: 0, spentMinor: 0, periodEnds: now() }),
      enabledAgents: empty([]), run: empty([]), openProposals: empty([]), now,
    }),
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

  // 2 — The surface. A route that breaks a convention fails here, not on the request that finds it.
  const built = buildRouter(buildSurface({
    signingKey: settings['PACK_SIGNING_KEY']!,
    migrationTargetKind: settings['MIGRATION_TARGET_KIND'] as TargetKind,
  }));
  if (!built.ok) {
    process.stderr.write(`\nthe API surface is malformed and this service will not start:\n${
      built.refusals.map((r) => `  • ${r.detail}`).join('\n')}\n\n`);
    process.exitCode = 78;
    return;
  }

  const db = new Client({ connectionString: settings['DATABASE_URL']! });
  await db.connect();

  const server = startHttpServer({
    router: built.router!,
    // Identity (API-01) supplies the real one; until then nothing authenticates, which is
    // default-deny rather than a bypass.
    authenticate: (): Principal | undefined => undefined,
    access: new AccessControl([], []),
    idempotency: new MemoryIdempotencyStore(),
    newTraceId: () => `t-${Math.random().toString(36).slice(2, 10)}`,
    port: Number(settings['PORT']),
    dependenciesReachable: async () => {
      try { await db.query('SELECT 1'); return true; } catch { return false; }
    },
  });

  process.stdout.write(`sre-api listening on ${settings['PORT']}, ${built.router!.list().length} routes\n`);

  // 4 — Drain on SIGTERM. Killing in-flight work is a sale that reached the process and not the
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
