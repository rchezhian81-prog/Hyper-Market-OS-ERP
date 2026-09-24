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
import type { OrderState, OrderEvent } from '../../../packages/orders/src/lifecycle';
import { transitionOrder, canTransition, isTerminal } from '../../../packages/orders/src/lifecycle';
import { applySubstitution, reconcileChannel, type SubstitutionOffer, type SubstitutionDecision, type SubstitutionOutcome, type ChannelOrder } from '../../../packages/orders/src/amendments';
import {
  assessSubstitution,
  type CustomerSubstitutionRules,
  type ProductAttributes,
  type SubstitutionPreference,
  type SubstitutionEligibility,
} from '../../../packages/orders/src/substitution-policy';
import {
  settleSubstitutionMoney,
  type TenderMode,
  type SubstitutionSettlementKind,
} from '../../../packages/orders/src/substitution-money';
import { substitutionExceptions, type SubstitutionRecordView } from '../../../packages/orders/src/substitution-exceptions';

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

/** One line of an order as placed — the product and how much of it was asked for. */
export interface OrderLine {
  readonly productId: string;
  readonly quantityMinor: number;
}

/** The order as it entered the system, recorded so its lifecycle can be read and moved (M18-FR-01). */
export interface PlacedOrder {
  readonly orderId: string;
  readonly locationId: string;
  readonly lines: readonly OrderLine[];
  readonly state: OrderState;
  readonly placedAt: string;
}

/** One lifecycle step, recorded append-only so the order's history is auditable end-to-end. */
export interface OrderTransition {
  readonly orderId: string;
  readonly event: OrderEvent;
  readonly from: OrderState;
  readonly to: OrderState;
  readonly at: string;
}

/** Current view of an order — its folded state and how it was placed. */
export interface OrderStateView {
  readonly state: OrderState;
  readonly locationId: string;
  readonly lines: readonly OrderLine[];
}

/** A recorded substitution decision on one order line (M18-FR-04), append-only — a line is substituted once. */
export interface StoredSubstitution {
  readonly orderId: string;
  readonly lineId: string;
  readonly decision: SubstitutionDecision;
  readonly outcome: SubstitutionOutcome;
  /** The product the picker put in the crate, when the substitute was confirmed. */
  readonly pickProductId: string | null;
  readonly pickQuantityMinor: number;
  readonly chargeMinor: number;
  /** Refund due to the customer where the substitute was cheaper — a fact recorded here; the refund is
   *  ISSUED downstream by the finance/refund surface, never kept. */
  readonly refundMinor: number;
  readonly at: string;
  // M19-FR-01 policy + tender-aware money (optional — absent on a plain M18 substitution decision):
  /** The eligibility the policy engine returned, when the caller supplied the customer's rules + attributes. */
  readonly eligibility?: SubstitutionEligibility;
  /** Why the policy refused or asked for confirmation (a controlled item, an allergen, a blocked brand, …). */
  readonly policyReason?: string;
  /** How the order is paid — drives the settlement direction, when supplied. */
  readonly tender?: TenderMode;
  /** The tender-aware settlement: prepaid_refund / prepaid_additional_charge / collect_less / collect_more / none. */
  readonly settlementKind?: SubstitutionSettlementKind;
  /** The settlement amount, always >= 0; the direction is in `settlementKind`. */
  readonly settlementMinor?: number;
  /** True only when a dearer substitute was charged ABOVE the original price under explicit approval. */
  readonly aboveCap?: boolean;
}

/** One line of an order that could not be reserved in full — ordered more than was held (M18-FR-02). */
export interface BackorderLine {
  readonly productId: string;
  readonly requestedMinor: number;
  readonly reservedMinor: number;
  readonly shortfallMinor: number;
}

export type BackorderOutcome = 'backordered' | 'nothing_to_backorder';

/** The un-promised remainder of an order — what a partial promise could NOT hold. */
export interface BackorderPlan {
  readonly orderId: string;
  readonly outcome: BackorderOutcome;
  readonly lines: readonly BackorderLine[];
  readonly detail: string;
}

/** A backorder recorded against an order, append-only (M18-FR-02) — the shortfall is recorded once. */
export interface StoredBackorder {
  readonly orderId: string;
  readonly lines: readonly BackorderLine[];
  readonly at: string;
}

/**
 * Work out the un-promised remainder of an order and record it, so a partial promise is a visible
 * exception rather than a silently dropped line (M18-FR-02 "backorders the rest per policy"; P-08).
 *
 * The shortfall is what was ORDERED minus what is actually RESERVED for the order — a figure already
 * on the ledger, never a fresh availability guess, so recording a backorder can never oversell. A
 * line whose whole quantity is held has no shortfall and is not backordered. (The reservation model
 * holds one reservation per product per order, so a product appears on at most one line here.)
 */
export function planBackorder(input: {
  readonly orderId: string;
  readonly lines: readonly OrderLine[];
  readonly reserved: ReadonlyMap<string, number>;
}): BackorderPlan {
  const lines = input.lines.flatMap((l): BackorderLine[] => {
    const reservedMinor = input.reserved.get(l.productId) ?? 0;
    const shortfallMinor = Math.max(0, l.quantityMinor - reservedMinor);
    return shortfallMinor > 0
      ? [{ productId: l.productId, requestedMinor: l.quantityMinor, reservedMinor, shortfallMinor }]
      : [];
  });
  const outcome: BackorderOutcome = lines.length > 0 ? 'backordered' : 'nothing_to_backorder';
  return {
    orderId: input.orderId, outcome, lines,
    detail: outcome === 'backordered'
      ? `${input.orderId}: ${lines.length} line(s) short of stock, recorded as a backorder rather than dropped`
      : `${input.orderId}: everything ordered is held — nothing to backorder`,
  };
}

export interface OrdersDeps {
  readonly onHand: (tenantId: string, locationId: string) => Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
  readonly outstanding: (tenantId: string, locationId: string) => Promise<readonly Reservation[]> | readonly Reservation[];
  readonly holdReservations: (tenantId: string, rs: readonly Reservation[]) => Promise<void> | void;
  readonly holdMinutes: number;
  readonly now: () => string;
  // Lifecycle (M18-FR-01) and cancellation-releases-reservation (M18-FR-04).
  readonly recordPlaced: (tenantId: string, order: PlacedOrder) => Promise<void> | void;
  readonly orderState: (tenantId: string, orderId: string) => Promise<OrderStateView | undefined> | OrderStateView | undefined;
  readonly orderReservations: (tenantId: string, orderId: string, locationId: string) => Promise<readonly Reservation[]> | readonly Reservation[];
  readonly recordTransition: (tenantId: string, t: OrderTransition) => Promise<void> | void;
  readonly releaseReservations: (tenantId: string, rs: readonly Reservation[]) => Promise<void> | void;
  // Substitution (M18-FR-04): record the picker's substitution decision on a line, append-only.
  readonly recordSubstitution: (tenantId: string, sub: StoredSubstitution) => Promise<void> | void;
  readonly orderSubstitutions: (tenantId: string, orderId: string) => Promise<readonly StoredSubstitution[]> | readonly StoredSubstitution[];
  /** Every substitution recorded for the tenant — a fold of the tenant-wide index, for the exception worklist. */
  readonly allSubstitutions: (tenantId: string) => Promise<readonly StoredSubstitution[]> | readonly StoredSubstitution[];
  // Backorder (M18-FR-02): record the un-promised remainder of an order, append-only, and read it back.
  readonly recordBackorder: (tenantId: string, bo: StoredBackorder) => Promise<void> | void;
  readonly orderBackorders: (tenantId: string, orderId: string) => Promise<readonly StoredBackorder[]> | readonly StoredBackorder[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const SUB_DECISIONS: readonly SubstitutionDecision[] = ['confirmed', 'declined', 'no_answer'];

/** A substitution offer the engine can price: the ordered line and the substitute, both with a price and qty. */
const isOffer = (v: unknown): v is SubstitutionOffer =>
  typeof v === 'object' && v !== null
  && isStr((v as Record<string, unknown>)['lineId'])
  && isStr((v as Record<string, unknown>)['orderedProductId']) && isStr((v as Record<string, unknown>)['orderedName'])
  && isNonNegInt((v as Record<string, unknown>)['orderedUnitPriceMinor']) && isPosInt((v as Record<string, unknown>)['orderedQuantityMinor'])
  && isStr((v as Record<string, unknown>)['substituteProductId']) && isStr((v as Record<string, unknown>)['substituteName'])
  && isNonNegInt((v as Record<string, unknown>)['substituteUnitPriceMinor']) && isPosInt((v as Record<string, unknown>)['substituteQuantityMinor'])
  && isStr((v as Record<string, unknown>)['offeredAt']);

const SUB_PREFERENCES: readonly SubstitutionPreference[] = ['no_substitution', 'best_match', 'contact_me'];
const TENDER_MODES: readonly TenderMode[] = ['prepaid', 'cod', 'pay_at_store'];
const strList = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/** The optional M19-FR-01 substitution POLICY inputs: the customer's rules + the two products' attributes.
 *  Absent → a plain M18 substitution (no eligibility gate). All-or-nothing: eligibility runs only when the
 *  customer rules and BOTH product attribute sets are readable. */
const readSubRules = (v: unknown): CustomerSubstitutionRules | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['preference'] !== 'string' || !SUB_PREFERENCES.includes(r['preference'] as SubstitutionPreference)) return undefined;
  return {
    preference: r['preference'] as SubstitutionPreference,
    ...(Array.isArray(r['blockedBrands']) ? { blockedBrands: strList(r['blockedBrands']) } : {}),
    ...(Array.isArray(r['blockedCategories']) ? { blockedCategories: strList(r['blockedCategories']) } : {}),
    ...(Array.isArray(r['avoidAllergens']) ? { avoidAllergens: strList(r['avoidAllergens']) } : {}),
    ...(isNonNegInt(r['weightToleranceBps']) ? { weightToleranceBps: r['weightToleranceBps'] } : {}),
  };
};

const readAttrs = (v: unknown): ProductAttributes | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  const a = v as Record<string, unknown>;
  if (!isStr(a['productId']) || !isStr(a['name'])) return undefined;
  return {
    productId: a['productId'], name: a['name'],
    ...(isStr(a['brand']) ? { brand: a['brand'] } : {}),
    ...(isStr(a['categoryId']) ? { categoryId: a['categoryId'] } : {}),
    ...(isNonNegInt(a['sizeMinor']) ? { sizeMinor: a['sizeMinor'] } : {}),
    ...(Array.isArray(a['allergens']) ? { allergens: strList(a['allergens']) } : {}),
    ...(typeof a['ageRestricted'] === 'boolean' ? { ageRestricted: a['ageRestricted'] } : {}),
  };
};

const readTender = (v: unknown): TenderMode | undefined =>
  typeof v === 'string' && TENDER_MODES.includes(v as TenderMode) ? (v as TenderMode) : undefined;

/** One order as a channel or our ledger reports it: an id, a value, and a state — the three things
 *  reconciliation compares. */
const isChannelOrder = (v: unknown): v is ChannelOrder =>
  typeof v === 'object' && v !== null
  && isStr((v as Record<string, unknown>)['orderId'])
  && isNonNegInt((v as Record<string, unknown>)['valueMinor'])
  && isStr((v as Record<string, unknown>)['state']);

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
        // The order now exists in the system — record it (idempotent on the order id) so it can
        // be read and moved through its lifecycle, and cancelled to give its stock back. A promise
        // that reserved nothing is still a placed order the customer is owed an answer on.
        await deps.recordPlaced(ctx.tenantId, {
          orderId, locationId: body.locationId, lines: body.lines, state: 'placed', placedAt: deps.now(),
        });
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
    // The tenant-wide substitution EXCEPTION worklist (M19-FR-01, P-08) — every swap that owes the
    // customer money back, needs a COD/collect adjustment, was charged above the cap under approval, or
    // was refused by policy and left short, worst (most money at stake) first. It reads the tenant-wide
    // index and runs the tested `substitutionExceptions` engine — it prices nothing itself; the amounts
    // are already on the recorded decisions. A same-price swap that owes nothing never appears. Gated
    // `order.read` (a management view of order money-at-risk — owner/manager, not the cashier), the same
    // gate as the backorder exception read. Registered BEFORE `/v1/orders/:orderId` so the literal path
    // is never captured as an order id.
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/substitution-exceptions',
      permission: 'order.read',
      handler: async (ctx) => {
        const subs = await deps.allSubstitutions(ctx.tenantId);
        const views: readonly SubstitutionRecordView[] = subs.map((s) => ({
          orderId: s.orderId,
          lineId: s.lineId,
          outcome: s.outcome,
          refundMinor: s.refundMinor,
          ...(s.eligibility !== undefined ? { eligibility: s.eligibility } : {}),
          ...(s.settlementKind !== undefined ? { settlementKind: s.settlementKind } : {}),
          ...(s.settlementMinor !== undefined ? { settlementMinor: s.settlementMinor } : {}),
          ...(s.aboveCap !== undefined ? { aboveCap: s.aboveCap } : {}),
        }));
        return { status: 200, body: substitutionExceptions(views) };
      },
    },
    // Read one order's lifecycle end-to-end (M18-FR-01). Registered AFTER the literal
    // `/v1/orders/reservations` and `/v1/orders/substitution-exceptions` above, so that address is
    // never captured as an order id.
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/:orderId',
      permission: 'order.read',
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const state = await deps.orderState(ctx.tenantId, orderId);
        if (state === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `No order "${orderId}" has been placed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order reference. Nothing was changed.',
          });
        }
        const reservations = await deps.orderReservations(ctx.tenantId, orderId, state.locationId);
        return {
          status: 200,
          body: {
            orderId, state: state.state, locationId: state.locationId,
            lines: state.lines, reservations,
          },
        };
      },
    },
    // Move an order along its lifecycle (M18-FR-01); an illegal step is refused, never applied.
    // A cancel gives every reservation back in the SAME step (M18-FR-04) — a cancel that forgets
    // the release makes stock invisible to the shop floor, the commonest phantom out-of-stock.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/transition',
      permission: 'order.lifecycle.manage', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const body = (ctx.body ?? {}) as { event?: OrderEvent };
        const current = await deps.orderState(ctx.tenantId, orderId);
        if (current === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `No order "${orderId}" has been placed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order reference. Nothing was changed.',
          });
        }
        if (body.event === undefined) {
          throw apiError(400, {
            code: 'no_transition',
            whatHappened: 'A lifecycle change needs an event (confirm, pick, pack, dispatch, deliver, collect or cancel).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. Send the event to apply.',
          });
        }
        if (!canTransition(current.state, body.event)) {
          throw apiError(409, {
            code: 'illegal_transition',
            whatHappened: `An order in "${current.state}" cannot "${body.event}".`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. The order is where it was.',
          });
        }
        const to = transitionOrder(current.state, body.event);
        const at = deps.now();
        let released: readonly Reservation[] = [];
        if (body.event === 'cancel') {
          released = await deps.orderReservations(ctx.tenantId, orderId, current.locationId);
          if (released.length > 0) await deps.releaseReservations(ctx.tenantId, released);
        }
        await deps.recordTransition(ctx.tenantId, { orderId, event: body.event, from: current.state, to, at });
        return {
          status: 200,
          body: { orderId, event: body.event, from: current.state, state: to, released },
        };
      },
    },
    // Record a substitution decision on an order line while picking (M18-FR-04). The picker offers a
    // substitute; the customer confirms, declines, or does not answer. **`no_answer` is NOT a yes** —
    // silence short-picks the line and charges nothing (the engine enforces it). The customer NEVER pays
    // more for our failure to stock the item; where the substitute is cheaper a refund is due, recorded as
    // a fact here and ISSUED downstream by the finance/refund surface (never kept). Append-only: a line is
    // substituted once (a re-decision is refused), and a substitution on a finished order is refused.
    //
    // M19-FR-01 extends this write path with two OPTIONAL, backward-compatible inputs (a plain M18 call
    // omits both): `{ rules, orderedAttrs, substituteAttrs }` runs the substitution POLICY — a `refused`
    // eligibility (a controlled item, an avoided allergen, a blocked brand/category, a size out of
    // tolerance) BLOCKS the swap even on a "confirmed" decision, short-picking the line; and `{ tender,
    // approvedAboveCap }` runs the tender-aware MONEY settlement (refund vs collect-less, and an approved
    // dearer swap above the cap). Both compose the tested `packages/orders` engines — no logic is copied.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/substitute',
      permission: 'order.lifecycle.manage', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const b = (ctx.body ?? {}) as {
          offer?: unknown; decision?: unknown;
          rules?: unknown; orderedAttrs?: unknown; substituteAttrs?: unknown;
          tender?: unknown; approvedAboveCap?: unknown;
        };
        if (!isOffer(b.offer) || !SUB_DECISIONS.includes(b.decision as SubstitutionDecision)) {
          throw apiError(400, {
            code: 'not_readable_as_a_substitution',
            whatHappened: 'A substitution needs an offer (lineId, the ordered product/name/price/qty and the substitute product/name/price/qty, offeredAt) and a decision (confirmed, declined or no_answer).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the offer and the customer’s decision. Nothing was changed.',
          });
        }
        const current = await deps.orderState(ctx.tenantId, orderId);
        if (current === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `No order "${orderId}" has been placed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order reference. Nothing was changed.',
          });
        }
        if (isTerminal(current.state)) {
          throw apiError(409, {
            code: 'order_finished',
            whatHappened: `Order "${orderId}" is ${current.state} — a substitution cannot be recorded against a finished order.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. A change to a finished order is a return or a new order.',
          });
        }
        const offer = b.offer;
        const already = await deps.orderSubstitutions(ctx.tenantId, orderId);
        if (already.some((s) => s.lineId === offer.lineId)) {
          throw apiError(409, {
            code: 'line_already_substituted',
            whatHappened: `Line "${offer.lineId}" already has a recorded substitution decision — a line is substituted once (append-only).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. A further change is a return or a re-pick, not a second substitution.',
          });
        }

        const decision = b.decision as SubstitutionDecision;

        // M19-FR-01 POLICY gate (optional): when the caller supplies the customer's rules and both
        // products' attributes, the eligibility engine decides whether the swap may be offered at all.
        // A `refused` policy result BLOCKS the swap regardless of the picker's decision — a controlled
        // item, an avoided allergen or a blocked brand is short-picked, never applied "because the
        // picker said confirmed". `auto_accept` / `needs_confirmation` proceed with the picker's decision.
        const bodyRules = readSubRules(b['rules']);
        const orderedAttrs = readAttrs(b['orderedAttrs']);
        const substituteAttrs = readAttrs(b['substituteAttrs']);
        let eligibility: SubstitutionEligibility | undefined;
        let policyReason: string | undefined;
        let effectiveDecision = decision;
        if (bodyRules !== undefined && orderedAttrs !== undefined && substituteAttrs !== undefined) {
          const assessed = assessSubstitution({ lineId: offer.lineId, ordered: orderedAttrs, substitute: substituteAttrs, rules: bodyRules });
          eligibility = assessed.eligibility;
          policyReason = assessed.reason;
          if (assessed.eligibility === 'refused') effectiveDecision = 'declined'; // policy blocks it → short-pick, charge nothing
        }

        const result = applySubstitution({ offer, decision: effectiveDecision });

        // M19-FR-01 tender-aware MONEY (optional): when the caller supplies how the order is paid, the
        // settlement engine decides how the difference moves (refund vs collect-less, and an approved
        // dearer swap above the cap). Without a tender, the plain M18 charge/refund fact is recorded.
        const tender = readTender(b['tender']);
        const approvedAboveCap = b['approvedAboveCap'] === true;
        const money = tender !== undefined
          ? settleSubstitutionMoney({ offer, decision: effectiveDecision, tender, approvedAboveCap })
          : undefined;
        const chargeMinor = money?.chargeMinor ?? result.chargeMinor;
        const tellTheCustomer = money?.tellTheCustomer ?? result.tellTheCustomer;

        const at = deps.now();
        const sub: StoredSubstitution = {
          orderId, lineId: result.lineId, decision, outcome: result.outcome,
          pickProductId: result.pickProductId ?? null, pickQuantityMinor: result.pickQuantityMinor,
          chargeMinor, refundMinor: result.refundMinor, at,
          ...(eligibility !== undefined ? { eligibility } : {}),
          ...(policyReason !== undefined ? { policyReason } : {}),
          ...(money !== undefined ? { tender, settlementKind: money.settlementKind, settlementMinor: money.settlementMinor, aboveCap: money.aboveCap } : {}),
        };
        await deps.recordSubstitution(ctx.tenantId, sub);
        return {
          status: 201,
          body: {
            orderId, lineId: result.lineId, outcome: result.outcome,
            pickProductId: result.pickProductId ?? null, pickQuantityMinor: result.pickQuantityMinor,
            chargeMinor, refundMinor: result.refundMinor,
            refundDue: result.refundMinor > 0, tellTheCustomer,
            ...(eligibility !== undefined ? { eligibility, policyReason } : {}),
            ...(money !== undefined ? { tender, settlementKind: money.settlementKind, settlementMinor: money.settlementMinor, aboveCap: money.aboveCap } : {}),
          },
        };
      },
    },
    // Record the un-promised remainder of an order as a backorder (M18-FR-02 "backorders the rest per
    // policy"). The shortfall is what was ORDERED minus what is actually RESERVED for the order — a fact
    // already on the ledger, so recording it can never oversell. A fully-held order has nothing to
    // backorder (200, records nothing). Append-only and idempotent on the order id: the shortfall is
    // recorded once; a re-run once a backorder exists is refused, and a backorder on a finished order is
    // refused. P-08: a partial promise must leave a VISIBLE exception, never a silently dropped line.
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/backorder',
      permission: 'order.backorder.manage', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const current = await deps.orderState(ctx.tenantId, orderId);
        if (current === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `No order "${orderId}" has been placed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order reference. Nothing was changed.',
          });
        }
        if (isTerminal(current.state)) {
          throw apiError(409, {
            code: 'order_finished',
            whatHappened: `Order "${orderId}" is ${current.state} — a backorder cannot be recorded against a finished order.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. A change to a finished order is a new order.',
          });
        }
        const already = await deps.orderBackorders(ctx.tenantId, orderId);
        if (already.length > 0) {
          throw apiError(409, {
            code: 'already_backordered',
            whatHappened: `Order "${orderId}" already has a recorded backorder — the shortfall is recorded once (append-only).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. Read the backorder, or place a new order for more.',
          });
        }
        // Ordered minus actually-reserved — never a fresh availability check, so this cannot oversell.
        const reservations = await deps.orderReservations(ctx.tenantId, orderId, current.locationId);
        const reserved = new Map<string, number>();
        for (const r of reservations) reserved.set(r.productId, (reserved.get(r.productId) ?? 0) + r.quantityMinor);
        const plan = planBackorder({ orderId, lines: current.lines, reserved });
        if (plan.outcome === 'nothing_to_backorder') {
          // Everything ordered is held: no exception to record, and no error — a truthful "nothing owed".
          return { status: 200, body: plan };
        }
        const at = deps.now();
        await deps.recordBackorder(ctx.tenantId, { orderId, lines: plan.lines, at });
        return { status: 201, body: { ...plan, at } };
      },
    },
    // Read an order's backorders — the visible exception a partial promise leaves (M18-FR-02, P-08).
    // Registered as a deeper path than `/v1/orders/:orderId`, so it is never captured as an order id.
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/:orderId/backorders',
      permission: 'order.read',
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const state = await deps.orderState(ctx.tenantId, orderId);
        if (state === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `No order "${orderId}" has been placed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order reference. Nothing was changed.',
          });
        }
        const backorders = await deps.orderBackorders(ctx.tenantId, orderId);
        return { status: 200, body: { orderId, backorders } };
      },
    },
    // Reconcile a sales channel against our own ledger, in BOTH directions (M18-FR-04). The two failures are
    // different and a one-way check misses one entirely: an order the CHANNEL has and we do NOT is revenue we
    // never fulfilled (a customer waiting); an order WE have and the channel does not is a phantom that will
    // never be paid for. A value or state mismatch on a matched order is surfaced too — the customer reads the
    // channel. Stateless: the caller supplies both order lists (a marketplace export vs our own); nothing is
    // stored. Gated `order.read` (reading order data to reconcile it).
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/channel-reconcile',
      permission: 'order.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { channel?: unknown; channelOrders?: unknown; ledgerOrders?: unknown };
        if (!isStr(b.channel) || !Array.isArray(b.channelOrders) || !Array.isArray(b.ledgerOrders)
          || !b.channelOrders.every(isChannelOrder) || !b.ledgerOrders.every(isChannelOrder)) {
          throw apiError(400, {
            code: 'not_readable_as_a_channel_reconciliation',
            whatHappened: 'A channel reconciliation needs a channel name, channelOrders and ledgerOrders — each order an { orderId, whole valueMinor, state }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the two order lists. Nothing is stored — this only reports where they disagree.',
          });
        }
        const result = reconcileChannel({
          channel: b.channel,
          channelOrders: b.channelOrders as ChannelOrder[],
          ledgerOrders: b.ledgerOrders as ChannelOrder[],
        });
        return { status: 200, body: result };
      },
    },
  ];
}
