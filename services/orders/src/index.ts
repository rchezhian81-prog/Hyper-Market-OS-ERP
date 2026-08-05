// API-07 OMS — orders, reservations, routing.
//
// **A promise is made once, at the moment the customer is told, and it is made against stock that
// is reserved in the same breath.** Checking availability and then reserving it a moment later is
// the oversell: two customers read the same free figure and both are promised the last bag of rice.
//
// So `promise()` takes the free quantity and the reservations already outstanding, and answers
// with what it has *taken*. Nothing here can say "yes, it is available" without also holding it —
// there is no `checkAvailability` to call and then act on, deliberately.
//
// And a promise that cannot be kept fails **now**, in front of the customer, rather than at pick
// time in front of nobody. A customer told at checkout is inconvenienced; a customer who finds out
// when the driver arrives has been let down.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export interface Reservation {
  readonly reservationId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly quantityMinor: number;
  readonly locationId: string;
  readonly heldUntil: string;
}

export type PromiseOutcome = 'promised' | 'partially_promised' | 'cannot_promise';

export interface OrderLinePromise {
  readonly productId: string;
  readonly requestedMinor: number;
  readonly promisedMinor: number;
  readonly outcome: PromiseOutcome;
  readonly reservation?: Reservation;
  readonly detail: string;
}

export interface PromiseResult {
  readonly orderId: string;
  readonly lines: readonly OrderLinePromise[];
  readonly outcome: PromiseOutcome;
  /** What must be shown to the customer before they pay, not after. */
  readonly customerMessage: string;
  readonly detail: string;
}

/**
 * Promise an order and reserve the stock in the same call.
 *
 * Availability minus outstanding reservations is the only figure a promise may be made against.
 * Substitution and backorder are decisions for a person or a policy; this reports what it could
 * actually hold, and never more.
 */
export function promise(input: {
  readonly orderId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly onHand: ReadonlyMap<string, number>;
  readonly outstanding: readonly Reservation[];
  readonly locationId: string;
  readonly heldUntil: string;
  readonly reservationIdFor: (orderId: string, productId: string) => string;
}): PromiseResult {
  const held = new Map<string, number>();
  for (const r of input.outstanding) {
    held.set(r.productId, (held.get(r.productId) ?? 0) + r.quantityMinor);
  }

  const lines = input.lines.map((l): OrderLinePromise => {
    const free = (input.onHand.get(l.productId) ?? 0) - (held.get(l.productId) ?? 0);
    const promisedMinor = Math.max(0, Math.min(l.quantityMinor, free));
    const outcome: PromiseOutcome = promisedMinor === l.quantityMinor ? 'promised'
      : promisedMinor === 0 ? 'cannot_promise' : 'partially_promised';

    return {
      productId: l.productId, requestedMinor: l.quantityMinor, promisedMinor, outcome,
      ...(promisedMinor > 0 ? {
        reservation: {
          reservationId: input.reservationIdFor(input.orderId, l.productId),
          orderId: input.orderId, productId: l.productId, quantityMinor: promisedMinor,
          locationId: input.locationId, heldUntil: input.heldUntil,
        },
      } : {}),
      // Why it is short matters to whoever handles it: nothing on the shelf is a buying problem,
      // held by other orders is a picking-sequence one, and they go to different people.
      detail: outcome === 'promised' ? `${l.productId}: ${promisedMinor} held`
        : `${l.productId}: ${promisedMinor} of ${l.quantityMinor} held — ${
          (input.onHand.get(l.productId) ?? 0) <= 0 ? 'none on the shelf'
            : (held.get(l.productId) ?? 0) > 0 ? 'the rest is already promised to other orders'
              : 'the rest is not on the shelf'}`,
    };
  });

  const outcome: PromiseOutcome = lines.every((l) => l.outcome === 'promised') ? 'promised'
    : lines.every((l) => l.outcome === 'cannot_promise') ? 'cannot_promise' : 'partially_promised';

  const short = lines.filter((l) => l.outcome !== 'promised');

  return {
    orderId: input.orderId, lines, outcome,
    customerMessage: outcome === 'promised'
      ? 'Everything on this order is held for you.'
      : `We cannot supply ${short.map((l) => l.productId).join(', ')} in full. Please choose a substitute or remove it before paying — we would rather tell you now than when the driver arrives.`,
    detail: outcome === 'promised'
      ? `${input.orderId}: all ${lines.length} line(s) reserved`
      : `${input.orderId}: ${short.length} line(s) short, told before payment rather than at pick time`,
  };
}

/** Reservations that have expired and no longer hold anything. */
export const expired = (rs: readonly Reservation[], now: string): readonly Reservation[] =>
  rs.filter((r) => Date.parse(r.heldUntil) <= Date.parse(now));

export interface OrdersDeps {
  readonly onHand: (tenantId: string, locationId: string) => Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
  readonly outstanding: (tenantId: string, locationId: string) => Promise<readonly Reservation[]> | readonly Reservation[];
  readonly holdReservations: (tenantId: string, rs: readonly Reservation[]) => Promise<void> | void;
  readonly holdMinutes: number;
  readonly now: () => string;
}

export function ordersRoutes(deps: OrdersDeps): readonly Route[] {
  return [
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/promise',
      permission: 'order.promise', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as {
          lines?: readonly { productId: string; quantityMinor: number }[]; locationId?: string;
        };
        if (!Array.isArray(body.lines) || body.locationId === undefined) {
          throw apiError(400, {
            code: 'nothing_to_promise',
            whatHappened: 'An order promise needs lines and a location to promise from.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was reserved. Send the lines and the location.',
          });
        }
        const orderId = ctx.params['orderId'] ?? '';
        const result = promise({
          orderId, lines: body.lines,
          onHand: await deps.onHand(ctx.tenantId, body.locationId),
          outstanding: await deps.outstanding(ctx.tenantId, body.locationId),
          locationId: body.locationId,
          heldUntil: new Date(Date.parse(deps.now()) + deps.holdMinutes * 60_000).toISOString(),
          reservationIdFor: (o, p) => `${o}${p}`,
        });
        const reservations = result.lines.flatMap((l) => (l.reservation === undefined ? [] : [l.reservation]));
        if (reservations.length > 0) await deps.holdReservations(ctx.tenantId, reservations);
        // 200 even when short: the answer is a truthful promise, not a failure.
        return { status: 200, body: result };
      },
    },
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/reservations',
      permission: 'order.reservation.read',
      handler: async (ctx) => {
        const locationId = ctx.query['locationId'] ?? '';
        const all = await deps.outstanding(ctx.tenantId, locationId);
        return {
          status: 200,
          body: { outstanding: all, expired: expired(all, deps.now()), asAt: deps.now() },
        };
      },
    },
  ];
}
