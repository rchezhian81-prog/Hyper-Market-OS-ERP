// API-05 Suspended (parked) bills — park a basket, recall it, abandon it (M15-FR-01), and the manager's
// parked-bill report at close (M12-FR-02) — on the live API, run on the tested `packages/suspended-sales`
// engine.
//
// The dangerous cases are the money ones, and the engine handles each: a recall is a CLAIM that succeeds
// ONCE and refuses every attempt afterwards naming who has it (two lanes resuming one bill is a double
// charge both cashiers believe is correct); a bill belongs to the shop and lane it was rung up in, so a
// cross-lane or cross-store recall is refused unless policy allows it; an abandoned bill is KEPT with who
// abandoned it and why (hard rule #6 — repeated park-and-abandon is a loss-prevention pattern); and a bill
// parked longer than the price window still resumes (refusing it would strand the customer) but the lane
// is TOLD to re-price before tendering rather than left to guess.
//
// Event-sourced: each state transition is an append-only fact, and the current bill is the latest fact.
// The engine's synchronous `SuspendedBillStore` (the offline lane's own durable store, hard rule #1) is
// hydrated from those facts per request, the engine run, and any resulting state persisted.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  suspendBill, resumeBill, abandonBill, staleBills, SerialisedSuspendedBillStore,
  type SuspendedBill, type SuspendedLine, type SuspensionPolicy, type SuspendInput,
} from '../../../packages/suspended-sales/src/index';

export type { SuspendedBill } from '../../../packages/suspended-sales/src/index';

export interface SuspendedBillsDeps {
  /** Every suspended bill's latest state — the engine's store is hydrated from these. */
  readonly bills: (tenantId: string) => Promise<readonly SuspendedBill[]> | readonly SuspendedBill[];
  /** Append a bill's new state (suspended / resumed / abandoned). Idempotent on bill + state. */
  readonly record: (tenantId: string, bill: SuspendedBill) => Promise<void> | void;
  readonly now: () => string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asPolicy = (v: unknown): SuspensionPolicy => (isObj(v) ? (v as SuspensionPolicy) : {});

async function hydrate(deps: SuspendedBillsDeps, tenantId: string): Promise<SerialisedSuspendedBillStore> {
  const store = new SerialisedSuspendedBillStore();
  for (const bill of await deps.bills(tenantId)) store.put(bill);
  return store;
}

export function suspendedBillsRoutes(deps: SuspendedBillsDeps): readonly Route[] {
  return [
    {
      // Park a basket. Written as durable state so a lane restart cannot lose it.
      api: 'API-05', method: 'POST', path: '/v1/pos/suspended-bills/:billId',
      permission: 'pos.suspend.write', idempotent: true,
      handler: async (ctx) => {
        const billId = ctx.params['billId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['storeId'] !== 'string' || typeof b['laneId'] !== 'string' || typeof b['cashierId'] !== 'string' || typeof b['tradingDay'] !== 'string' || typeof b['currency'] !== 'string' || !Array.isArray(b['lines'])) {
          throw apiError(400, {
            code: 'suspend_needs_lane_cashier_lines',
            whatHappened: 'Parking a bill needs storeId, laneId, cashierId, tradingDay, currency and lines[].',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the basket’s lane, cashier, trading day, currency and lines.',
          });
        }
        const input: SuspendInput = {
          billId, tenantId: ctx.tenantId,
          storeId: b['storeId'], laneId: b['laneId'], cashierId: b['cashierId'],
          tradingDay: b['tradingDay'], currency: b['currency'],
          lines: b['lines'] as SuspendedLine[],
          at: typeof b['at'] === 'string' ? b['at'] : deps.now(),
          ...(typeof b['reason'] === 'string' ? { reason: b['reason'] } : {}),
          ...(typeof b['customerRef'] === 'string' ? { customerRef: b['customerRef'] } : {}),
        };
        const store = await hydrate(deps, ctx.tenantId);
        const result = suspendBill(input, store, asPolicy(b['policy']));
        if (!result.suspended || result.bill === undefined) {
          throw apiError(422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named problem and park again.' });
        }
        await deps.record(ctx.tenantId, result.bill);
        return { status: 201, body: { billId, state: result.bill.state, lineCount: result.bill.lines.length } };
      },
    },
    {
      // Recall a parked bill — a claim that succeeds once and names who has it thereafter.
      api: 'API-05', method: 'POST', path: '/v1/pos/suspended-bills/:billId/resume',
      permission: 'pos.suspend.write', idempotent: true,
      handler: async (ctx) => {
        const billId = ctx.params['billId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['byUserId'] !== 'string' || typeof b['onLaneId'] !== 'string' || typeof b['storeId'] !== 'string') {
          throw apiError(400, { code: 'resume_needs_user_lane_store', whatHappened: 'Resuming needs byUserId, onLaneId and storeId.', wasItSaved: 'not_saved', nextSafeAction: 'Send who is recalling it, on which lane, at which store.' });
        }
        const store = await hydrate(deps, ctx.tenantId);
        const result = resumeBill({ billId, byUserId: b['byUserId'], onLaneId: b['onLaneId'], storeId: b['storeId'], at: typeof b['at'] === 'string' ? b['at'] : deps.now() }, store, asPolicy(b['policy']));
        if (!result.resumed || result.bill === undefined) {
          throw apiError(result.outcome === 'not_found' ? 404 : 422, { code: result.outcome, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'A parked bill is recalled once; check who holds it.' });
        }
        await deps.record(ctx.tenantId, result.bill);
        return { status: 200, body: { billId, state: result.bill.state, repriceRequired: result.repriceRequired ?? false, minutesParked: result.minutesParked ?? 0 } };
      },
    },
    {
      // Abandon a parked bill — kept with who and why (hard rule #6).
      api: 'API-05', method: 'POST', path: '/v1/pos/suspended-bills/:billId/abandon',
      permission: 'pos.suspend.write', idempotent: true,
      handler: async (ctx) => {
        const billId = ctx.params['billId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['byUserId'] !== 'string' || typeof b['reason'] !== 'string') {
          throw apiError(400, { code: 'abandon_needs_user_reason', whatHappened: 'Abandoning needs byUserId and a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send who abandoned it and why.' });
        }
        const store = await hydrate(deps, ctx.tenantId);
        const result = abandonBill({ billId, byUserId: b['byUserId'], reason: b['reason'], at: typeof b['at'] === 'string' ? b['at'] : deps.now() }, store);
        if (!result.abandoned || result.bill === undefined) {
          throw apiError(result.bill === undefined ? 404 : 422, { code: 'not_abandoned', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Give a reason, and only a still-parked bill can be abandoned.' });
        }
        await deps.record(ctx.tenantId, result.bill);
        return { status: 200, body: { billId, state: result.bill.state } };
      },
    },
    {
      // The parked-bill report a manager needs at close — oldest first, valued.
      api: 'API-05', method: 'GET', path: '/v1/pos/suspended-bills/stale',
      permission: 'pos.suspend.read',
      handler: async (ctx) => {
        const at = ctx.query['at'] ?? deps.now();
        const store = await hydrate(deps, ctx.tenantId);
        const stale = staleBills(store, at, {});
        return { status: 200, body: { asAt: at, count: stale.length, bills: stale } };
      },
    },
  ];
}
