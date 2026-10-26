// API-09 the Concessions desk's reads and the expiry warnings (M27-FR-01 · M27-FR-04 · P-03 · P-07 · P-08). OB-288
// package 3 "Commercial desks"; OB-304 (owner, 23 Oct 2026): SRE runs no concessions today — the screens are built in
// full and the feature (`dept.concession`) stays OFF until the owner turns it on. With it off every route here answers
// `feature_not_entitled`, as the rest of the concession surface does.
//
//   • GET /v1/concession/contracts — every counter's contract in the caller's branches, each with whether it may trade
//     today and why not (`mayConcessionTrade`, every blocker at once), its deposit held (a liability, never rent), and the
//     expiry alerts — the agreement, the insurance and the licence, 30 and 7 days ahead and once lapsed.
//   • POST /v1/concession/expiry-alerts/raise — put today's alerts into every owner's alert inbox now (the ops-alert worker
//     does the same on its own timer). Each step is raised once; a renewal is a new alert.

import type { Route } from '../../kernel/src/index';
import { branchInScope } from '../../kernel/src/index';
import {
  mayConcessionTrade, depositPosition, concessionExpiryAlerts, CONCESSION_WARN_DAYS,
  type ConcessionContract, type DepositMovement, type ConcessionExpiryAlert,
} from '../../../packages/concession/src/index';
import { shopClock, shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

export interface ConcessionDeskDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  /** Every contract's latest terms. */
  readonly contracts: (tenantId: string) => Promise<readonly ConcessionContract[]>;
  readonly depositMovements: (tenantId: string, concessionaireId: string) => Promise<readonly DepositMovement[]>;
  /** Raise one alert to every owner, once while it is open; false when it was already open (or there is no owner). */
  readonly raiseToOwners: (tenantId: string, alert: ConcessionExpiryAlert, by: string, at: string) => Promise<boolean>;
  readonly now: () => string;
}

export function concessionDeskRoutes(deps: ConcessionDeskDeps): readonly Route[] {
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts',
      permission: 'concession.charge.read',
      entitlement: 'dept.concession',
      handler: async (ctx) => {
        const today = await shopToday(deps, ctx.tenantId);
        // PA-01-r1: only the counters in the caller's own branches.
        const contracts = (await deps.contracts(ctx.tenantId)).filter((c) => branchInScope(ctx, c.branchId));
        const deposits = new Map<string, ReturnType<typeof depositPosition>>();
        for (const id of new Set(contracts.map((c) => c.concessionaireId))) {
          deposits.set(id, depositPosition({ concessionaireId: id, movements: await deps.depositMovements(ctx.tenantId, id) }));
        }
        const alerts = concessionExpiryAlerts(contracts, today);
        return {
          status: 200,
          body: {
            today,
            contracts: contracts.map((contract) => ({
              contract,
              trading: mayConcessionTrade({ contract, today, warnWithinDays: CONCESSION_WARN_DAYS }),
              deposit: deposits.get(contract.concessionaireId),
              alerts: alerts.filter((a) => a.contractId === contract.contractId),
            })),
            alerts,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/expiry-alerts/raise',
      permission: 'concession.contract.manage', idempotent: true,
      entitlement: 'dept.concession',
      handler: async (ctx) => {
        const at = deps.now();
        const alerts = concessionExpiryAlerts((await deps.contracts(ctx.tenantId)).filter((c) => branchInScope(ctx, c.branchId)), await shopClock(deps.calendar).dateOf(ctx.tenantId, at));
        let raised = 0;
        for (const a of alerts) if (await deps.raiseToOwners(ctx.tenantId, a, ctx.userId, at)) raised += 1;
        return { status: 200, body: { alerts: alerts.length, raised, alreadyOpen: alerts.length - raised, asAt: at } };
      },
    },
  ];
}

/** The worker's pass for one shop: raise today's concession alerts to the owners (only where the feature is on). */
export async function raiseConcessionAlerts(deps: ConcessionDeskDeps, tenantId: string, at: string): Promise<number> {
  let raised = 0;
  for (const a of concessionExpiryAlerts(await deps.contracts(tenantId), await shopClock(deps.calendar).dateOf(tenantId, at))) {
    if (await deps.raiseToOwners(tenantId, a, 'system:concession-expiry', at)) raised += 1;
  }
  return raised;
}
