// API-08 Fulfilment / Delivery — picks, packs, routes, proof.
//
// **A failed delivery is a state, not an absence.** The commonest way delivery data goes wrong is
// that success is recorded and failure is silence: the order sits at "out for delivery" forever,
// nobody is chasing it, the customer rings, and there is no record of what the driver found. So
// every attempt is recorded — arrived, nobody in, refused, wrong address — and an order cannot
// leave "out for delivery" without one.
//
// **Proof of delivery is evidence and is never deleted** (hard rule #6). It is what settles a
// dispute about whether goods arrived, and the moment it becomes deletable it settles nothing.
//
// And **cash on delivery is money the driver is carrying.** It is reconciled against the driver,
// by run, before it is reconciled against anything else — because that is the only point at which
// the person who had it is still identifiable.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export type AttemptOutcome =
  | 'delivered' | 'nobody_in' | 'refused' | 'wrong_address' | 'could_not_access' | 'damaged_in_transit';

export interface DeliveryAttempt {
  readonly attemptId: string;
  readonly orderId: string;
  readonly driverId: string;
  readonly attemptedAt: string;
  readonly outcome: AttemptOutcome;
  /** Signature reference, photo reference or OTP confirmation. Never deleted (#6). */
  readonly proofRef?: string;
  readonly notes?: string;
  /** Cash taken at the door, if any. */
  readonly cashCollectedMinor?: number;
}

export type AttemptRefusal = 'delivered_without_proof' | 'failure_without_a_reason' | 'cash_without_delivery';

export interface AttemptCheck {
  readonly ok: boolean;
  readonly refusedBecause?: AttemptRefusal;
  readonly detail: string;
}

/**
 * Record an attempt, or refuse.
 *
 * A delivery claimed without proof is the one that cannot be defended when the customer says the
 * goods never arrived — and by then the driver has done two hundred more drops and remembers none
 * of them.
 */
export function checkAttempt(a: DeliveryAttempt): AttemptCheck {
  if (a.outcome === 'delivered' && (a.proofRef === undefined || a.proofRef.trim() === '')) {
    return {
      ok: false, refusedBecause: 'delivered_without_proof',
      detail: 'a delivery recorded with no proof cannot be defended when the customer says it never arrived, and by then the driver has done two hundred more drops and remembers none of them',
    };
  }
  if (a.outcome !== 'delivered' && (a.notes === undefined || a.notes.trim().length < 5)) {
    return {
      ok: false, refusedBecause: 'failure_without_a_reason',
      detail: `a ${a.outcome} attempt with no note tells whoever redelivers nothing about what to do differently`,
    };
  }
  if ((a.cashCollectedMinor ?? 0) > 0 && a.outcome !== 'delivered') {
    return {
      ok: false, refusedBecause: 'cash_without_delivery',
      detail: `cash was recorded against a ${a.outcome} attempt. Money taken at a door where nothing was handed over needs a person to look at it, not a record that quietly balances`,
    };
  }
  return { ok: true, detail: `${a.orderId}: ${a.outcome} by ${a.driverId}` };
}

export interface RunReconciliation {
  readonly driverId: string;
  readonly runDate: string;
  readonly attempts: number;
  readonly delivered: number;
  readonly failed: number;
  readonly cashExpectedMinor: number;
  readonly cashHandedInMinor: number;
  readonly differenceMinor: number;
  readonly outstanding: readonly string[];
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * Settle a driver's run.
 *
 * Cash first, and against the driver by name: it is the only point at which the person who had
 * the money is still identifiable. An order with no attempt at all is listed separately — it is
 * not a failure, it is an order nobody can account for.
 */
export function reconcileRun(input: {
  readonly driverId: string;
  readonly runDate: string;
  readonly assignedOrderIds: readonly string[];
  readonly attempts: readonly DeliveryAttempt[];
  readonly cashHandedInMinor: number;
}): RunReconciliation {
  const mine = input.attempts.filter((a) => a.driverId === input.driverId);
  const delivered = mine.filter((a) => a.outcome === 'delivered');
  const cashExpectedMinor = delivered.reduce((t, a) => t + (a.cashCollectedMinor ?? 0), 0);
  const attempted = new Set(mine.map((a) => a.orderId));
  const outstanding = input.assignedOrderIds.filter((id) => !attempted.has(id)).sort();
  const differenceMinor = input.cashHandedInMinor - cashExpectedMinor;

  return {
    driverId: input.driverId, runDate: input.runDate,
    attempts: mine.length, delivered: delivered.length, failed: mine.length - delivered.length,
    cashExpectedMinor, cashHandedInMinor: input.cashHandedInMinor, differenceMinor, outstanding,
    detail: `${input.driverId} on ${input.runDate}: ${delivered.length} delivered, ${mine.length - delivered.length} failed, ${outstanding.length} not attempted`,
    ownerAction: differenceMinor !== 0
      ? `cash is out by ${differenceMinor} against what the delivered orders say was collected. Settle it with ${input.driverId} today — tomorrow nobody can say which door it was`
      : outstanding.length > 0
        ? `${outstanding.length} order(s) went out and have no attempt recorded at all: ${outstanding.join(', ')}. Those are not failures, they are orders nobody can account for`
        : 'nothing — the run reconciles and every order has an outcome',
  };
}

export interface FulfilmentDeps {
  readonly appendAttempt: (tenantId: string, a: DeliveryAttempt) => Promise<void> | void;
  readonly attempts: (tenantId: string, driverId: string, runDate: string) => Promise<readonly DeliveryAttempt[]> | readonly DeliveryAttempt[];
  readonly assigned: (tenantId: string, driverId: string, runDate: string) => Promise<readonly string[]> | readonly string[];
  readonly now: () => string;
}

export function fulfilmentRoutes(deps: FulfilmentDeps): readonly Route[] {
  return [
    {
      api: 'API-08', method: 'POST', path: '/v1/delivery/attempts',
      permission: 'delivery.attempt.record', idempotent: true,
      handler: async (ctx) => {
        const attempt = ctx.body as DeliveryAttempt;
        const check = checkAttempt(attempt);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The order still shows as out for delivery. Add what is missing and send it again — do not leave the drop unrecorded.',
          });
        }
        await deps.appendAttempt(ctx.tenantId, attempt);
        return { status: 201, body: { attemptId: attempt.attemptId, recorded: check.detail } };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/runs/:driverId',
      permission: 'delivery.run.read',
      handler: async (ctx) => {
        const driverId = ctx.params['driverId'] ?? '';
        const runDate = ctx.query['runDate'] ?? deps.now().slice(0, 10);
        return {
          status: 200,
          body: reconcileRun({
            driverId, runDate,
            assignedOrderIds: await deps.assigned(ctx.tenantId, driverId, runDate),
            attempts: await deps.attempts(ctx.tenantId, driverId, runDate),
            cashHandedInMinor: Number(ctx.query['cashHandedInMinor'] ?? '0'),
          }),
        };
      },
    },
  ];
}
