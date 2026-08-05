// The customer's shopping session (M16 / D06 / D08) — the model behind the customer screens.
//
// Everything a *rule* here is already in `packages/storefront`: reviewing a cart against the live
// catalogue, offering slots that can actually be had, refusing a card number where a provider
// token belongs. This session does not restate any of that. What it holds is the thing no single
// function can — **the order of events**, and what the customer is truthfully told at each point.
//
// ── The rule that only this layer can hold ───────────────────────────────────
//
// **An order is not placed until the shop has it.** On a phone with no signal, the basket is
// prepared and nothing else: the screen says *not sent yet*, never *order placed*.
//
// That is the deliberate **inverse** of the till (hard rule #1), and the difference is worth
// stating because getting it backwards is easy. At the till we commit locally first and sync
// afterwards, because the money is already in the drawer and the customer has gone — the event
// happened, and refusing to record it loses it. On a customer's phone nothing has happened at all:
// no money has moved, no goods have left, and the shop has never heard of this basket. An app that
// says "order placed" over a queued request has told the customer something untrue about the
// world, and they find out when nothing arrives.
//
// ── The other three, all about sequence ──────────────────────────────────────
//
//   • **Nothing is paid for that has not been reviewed.** `reviewCart` exists precisely so a
//     customer is told at review — not at the payment screen, and certainly not at the door — that
//     two items are gone. A session that lets checkout skip review makes that function optional.
//   • **A review goes stale.** The catalogue is republished while somebody is deciding, and the
//     price they were shown is no longer the price the till would charge. Paying against a review
//     built on an older pack charges a figure the customer never saw (P-02), so the session
//     refuses and asks them to look again rather than quietly repricing.
//   • **Problems are resolved deliberately, by the customer.** A short line is not silently
//     reduced to what is in stock. They accept the smaller quantity, or they do not.

import {
  reviewCart, type CartLine, type CartReview, type StorefrontProduct,
} from '../../../packages/storefront/src/browse';
import {
  bookSlot, placeOrder, checkServiceability,
  type Slot, type SlotBookingResult, type PaymentAnswer, type PlacedOrder,
  type ServiceabilityPolicy,
} from '../../../packages/storefront/src/checkout';

export type SessionStage =
  | 'browsing'
  | 'reviewed'
  | 'slot_booked'
  | 'sent'
  /** Prepared on the phone and **not** sent. Not a kind of "placed". */
  | 'waiting_for_signal';

export interface SessionState {
  readonly stage: SessionStage;
  readonly lines: readonly CartLine[];
  /** The review the customer actually saw, and the pack version it was built from. */
  readonly review?: CartReview;
  readonly reviewedAgainstPackVersion?: number;
  readonly slotId?: string;
  readonly order?: PlacedOrder;
  /** The sentence for the screen. Always true, including when it is unwelcome. */
  readonly tellTheCustomer: string;
}

export type Refusal =
  | 'nothing_in_the_basket'
  | 'not_reviewed'
  | 'review_is_out_of_date'
  | 'problems_not_resolved'
  | 'no_slot_booked'
  | 'card_number_supplied';

export interface StepResult {
  readonly ok: boolean;
  readonly state: SessionState;
  readonly refusedBecause?: Refusal;
  readonly detail: string;
}

const EMPTY: SessionState = {
  stage: 'browsing', lines: [],
  tellTheCustomer: 'Your basket is empty.',
};

/** A provider token, never a card. The same shape `packages/storefront` refuses at checkout. */
const PAN_LIKE = /^\d{13,19}$/;

export function newSession(): SessionState {
  return EMPTY;
}

/** Add or change a line. Any change invalidates the review — the customer must see the new total. */
export function setLine(state: SessionState, line: CartLine): SessionState {
  const lines = [
    ...state.lines.filter((l) => l.productId !== line.productId),
    ...(line.quantityMinor > 0 ? [line] : []),
  ];
  return {
    stage: 'browsing', lines,
    tellTheCustomer: lines.length === 0
      ? 'Your basket is empty.'
      : `${lines.length} item(s) in your basket. Prices are checked when you review.`,
  };
}

/**
 * Review the basket against the live catalogue.
 *
 * The pack version is carried forward with the review, and that is the whole point of recording
 * it: it is what makes the staleness check below possible at all.
 */
export function review(state: SessionState, input: {
  readonly products: readonly StorefrontProduct[];
  readonly packVersion: number;
  readonly language?: 'en' | 'ta';
}): StepResult {
  if (state.lines.length === 0) {
    return {
      ok: false, refusedBecause: 'nothing_in_the_basket', state,
      detail: 'there is nothing to review',
    };
  }

  const reviewed = reviewCart({
    lines: state.lines, products: input.products,
    ...(input.language === undefined ? {} : { language: input.language }),
  });

  return {
    ok: true,
    detail: reviewed.detail,
    state: {
      ...state,
      stage: 'reviewed',
      review: reviewed,
      reviewedAgainstPackVersion: input.packVersion,
      tellTheCustomer: reviewed.hasProblems
        ? `${reviewed.unavailable.length} item(s) are unavailable and ${reviewed.shortfalls.length} are short. Telling you now rather than at the door — please choose what to do with them.`
        : `${reviewed.lines.length} item(s), ${reviewed.subtotalMinor / 100} to pay before delivery.`,
    },
  };
}

/**
 * Accept the review as it stands — short lines reduced to what is actually there, unavailable
 * lines dropped.
 *
 * Deliberately a **separate step the customer takes**, not something `review` does for them. A
 * basket that quietly becomes a smaller basket is a customer who finds out at the door, which is
 * exactly what reviewing before checkout exists to prevent.
 */
export function acceptWhatIsAvailable(state: SessionState): StepResult {
  if (state.review === undefined) {
    return { ok: false, refusedBecause: 'not_reviewed', state, detail: 'nothing has been reviewed' };
  }
  const kept = state.review.lines.filter((l) => l.availableMinor > 0);
  const lines = kept.map((l): CartLine => ({ productId: l.productId, quantityMinor: l.availableMinor }));

  return {
    ok: true,
    detail: `${lines.length} line(s) kept`,
    state: {
      ...state,
      lines,
      // Back to reviewed, against the same pack — the quantities changed, not the prices. The
      // subtotal is recomputed from the kept lines rather than carried over: it happens to be the
      // same number, because a dropped line contributed zero, and relying on that is how a total
      // survives a change to the thing it totals.
      review: {
        ...state.review, lines: kept, unavailable: [], shortfalls: [], hasProblems: false,
        subtotalMinor: kept.reduce((t, l) => t + l.lineTotalMinor, 0),
      },
      tellTheCustomer: `Your basket now has ${lines.length} item(s), with what was short reduced to what we have.`,
    },
  };
}

export function chooseSlot(state: SessionState, input: {
  readonly slotId: string;
  readonly slots: readonly Slot[];
  readonly now: string;
  readonly leadMinutes?: number;
}): StepResult & { readonly booking: SlotBookingResult } {
  const booking = bookSlot({
    slotId: input.slotId, slots: input.slots, now: input.now,
    ...(input.leadMinutes === undefined ? {} : { leadMinutes: input.leadMinutes }),
  });

  if (!booking.booked) {
    return {
      ok: false, booking, state: {
        ...state,
        tellTheCustomer: `${booking.detail}. ${booking.alternatives.length} other time(s) are free.`,
      },
      detail: booking.detail,
    };
  }

  return {
    ok: true, booking, detail: booking.detail,
    state: {
      ...state, stage: 'slot_booked', slotId: input.slotId,
      tellTheCustomer: `Booked for ${booking.slotId}. Nothing is charged until you pay.`,
    },
  };
}

/**
 * Send the order to the shop.
 *
 * `reachedTheShop` is the caller's honest answer to "did this request get there?" — and the whole
 * design turns on the app never guessing it. When the answer is no, the session goes to
 * `waiting_for_signal`, which is **not** a kind of placed: nothing was paid, nothing will be
 * picked, and the customer is told so in those words.
 */
export function send(state: SessionState, input: {
  readonly orderId: string;
  readonly customerRef: string;
  readonly deliveryFeeMinor: number;
  readonly currentPackVersion: number;
  readonly policy: ServiceabilityPolicy;
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  readonly deliveryLocation: { readonly lat: number; readonly lon: number };
  /** A provider token. A card number here is a refusal, never a redaction (hard rule #3). */
  readonly payment: PaymentAnswer;
  /** Did the request reach the shop? The app does not decide this; the transport reports it. */
  readonly reachedTheShop: boolean;
}): StepResult {
  if (state.review === undefined) {
    return {
      ok: false, refusedBecause: 'not_reviewed', state,
      detail: 'this basket has not been reviewed, so the customer has not been shown what they are paying for',
    };
  }
  if (state.review.hasProblems) {
    return {
      ok: false, refusedBecause: 'problems_not_resolved', state,
      detail: 'some lines are short or unavailable and the customer has not said what to do about them. Reducing the basket for them is how they find out at the door',
    };
  }
  if (state.reviewedAgainstPackVersion !== input.currentPackVersion) {
    return {
      ok: false, refusedBecause: 'review_is_out_of_date', state: {
        ...state, stage: 'browsing',
        tellTheCustomer: 'Prices changed while you were deciding. Please have another look at your basket before paying.',
      },
      detail: `the review was built on pack ${state.reviewedAgainstPackVersion} and the shop is now on ${input.currentPackVersion}. Charging against the older one bills a figure the customer never saw`,
    };
  }
  if (state.slotId === undefined) {
    return { ok: false, refusedBecause: 'no_slot_booked', state, detail: 'no delivery or collection time has been chosen' };
  }
  if (input.payment.result === 'authorised' && PAN_LIKE.test(input.payment.providerRef.replace(/\s|-/g, ''))) {
    // Refused, not redacted. Redacting means it was held first, and by then it is in memory, in a
    // crash report and in whatever the phone wrote to disk (hard rule #3).
    return {
      ok: false, refusedBecause: 'card_number_supplied', state,
      detail: 'a payment reference that looks like a card number was supplied where a provider token belongs. Nothing was sent',
    };
  }

  // Not sent is not placed.
  if (!input.reachedTheShop) {
    return {
      ok: true, detail: 'prepared, not sent',
      state: {
        ...state, stage: 'waiting_for_signal',
        tellTheCustomer: 'Your basket is ready but has NOT been sent — there is no connection. Nothing has been charged and the shop has not seen it yet. It will go as soon as you are back online.',
      },
    };
  }

  const serviceability = checkServiceability({
    storeLocation: input.storeLocation,
    deliveryLocation: input.deliveryLocation,
    policy: input.policy,
    // The reviewed subtotal, not a figure passed alongside it. Two numbers for one basket is one
    // of them being wrong, and the minimum-order rule turns on which.
    basketMinor: state.review.subtotalMinor,
  });

  const order = placeOrder({
    orderId: input.orderId,
    customerRef: input.customerRef,
    slotId: state.slotId,
    itemsMinor: state.review.subtotalMinor,
    deliveryFeeMinor: input.deliveryFeeMinor,
    serviceability,
    payment: input.payment,
  });

  return {
    ok: order.state !== 'refused',
    detail: order.detail,
    state: {
      ...state, stage: 'sent', order,
      // Straight from the domain, which already has the honest sentence for the `unknown` branch.
      tellTheCustomer: order.tellTheCustomer,
    },
  };
}

/**
 * What the customer's order screen shows afterwards.
 *
 * `payment_pending` is reported as waiting rather than as done, because it *is* waiting: the
 * provider has not answered, nothing will be picked, and telling somebody their order is confirmed
 * against a payment that may not exist is how a shop delivers goods it was never paid for.
 */
export function orderStatusLine(order: PlacedOrder): string {
  return order.state === 'confirmed'
    ? `Order ${order.orderId} is confirmed and will be picked for your slot.`
    : order.state === 'payment_pending'
      ? `Order ${order.orderId} is waiting on your bank. It has not been confirmed and nothing will be picked until it is. We will tell you either way.`
      : `Order ${order.orderId} was not placed. ${order.tellTheCustomer}`;
}
