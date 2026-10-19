// An online return after delivery (R4 · WF-16 · OB-58 · OB-213) — the pure rules.
//
// Roadmap WF-16: "Eligibility → cancel/collect/receive → stock disposition → payment refund → customer notice/reconcile".
//
//   • ELIGIBILITY by the product's CATEGORY (OB-213): a return is raised within the window the owner set for the category,
//     counted from when the order was delivered (or collected). Outside it → "return window closed". A product on the
//     owner's non-returnable list → "not returnable". Until the owner gives the windows and the list they read "not set",
//     and a return cannot be judged — it is refused by name, never waved through on a guessed window.
//   • COLLECT → RECEIVE with a COUNT: what came back is counted per line; never more than was asked for.
//   • DISPOSITION by a PERSON, per received line: back to sellable, quarantine, or waste with a reason.
//   • REFUND only for lines RECEIVED (the count), at the price the line was charged, back to the order's own payment
//     (refund to source — C14). A line refunded once is refused a second time ("already refunded"). A refund the payment
//     provider has not confirmed reads "waiting", never done.
//
// Pure and deterministic: no clock, no I/O.

/** OB-213: the owner's return windows by category, and the non-returnable list. Versioned; the latest wins. */
export interface ReturnPolicySettings {
  readonly version: number;
  /** Days after delivery a return may be raised, per category id. A category not listed is "not set". */
  readonly windowDaysByCategory: Readonly<Record<string, number>>;
  /** Products that cannot be returned. Absent = the owner has not given the list yet ("not set"). */
  readonly nonReturnable?: readonly string[];
  readonly setBy: string;
  readonly setAt: string;
}

export const RETURN_WINDOW_CLOSED = 'return window closed';
export const NOT_RETURNABLE = 'not returnable';
export const ALREADY_REFUNDED = 'already refunded';
export const WINDOW_NOT_SET = 'return window not set';
export const LIST_NOT_SET = 'non-returnable list not set';

export type LineEligibility =
  | { readonly ok: true; readonly productId: string; readonly windowDays: number; readonly closesAt: string }
  | { readonly ok: false; readonly productId: string; readonly code: 'return_window_not_set' | 'non_returnable_list_not_set' | 'not_returnable' | 'return_window_closed'; readonly refusal: string };

/** May this line be returned now? `deliveredAt` is when the order was delivered or collected. */
export function lineEligibility(input: {
  readonly productId: string;
  readonly categoryId: string | undefined;
  readonly deliveredAt: string;
  readonly now: string;
  readonly policy: ReturnPolicySettings | undefined;
}): LineEligibility {
  const { productId, policy } = input;
  const days = input.categoryId === undefined ? undefined : policy?.windowDaysByCategory[input.categoryId];
  if (days === undefined || !Number.isInteger(days) || days < 0) {
    return { ok: false, productId, code: 'return_window_not_set', refusal: `${WINDOW_NOT_SET}: ${input.categoryId ?? 'no category'}` };
  }
  if (policy?.nonReturnable === undefined) return { ok: false, productId, code: 'non_returnable_list_not_set', refusal: LIST_NOT_SET };
  if (policy.nonReturnable.includes(productId)) return { ok: false, productId, code: 'not_returnable', refusal: NOT_RETURNABLE };
  const closesAt = new Date(Date.parse(input.deliveredAt) + days * 86_400_000).toISOString();
  if (input.now > closesAt) return { ok: false, productId, code: 'return_window_closed', refusal: RETURN_WINDOW_CLOSED };
  return { ok: true, productId, windowDays: days, closesAt };
}

export type ReturnDisposition = 'sellable' | 'quarantine' | 'waste';
export const DISPOSITIONS: readonly ReturnDisposition[] = ['sellable', 'quarantine', 'waste'];

/** One step of an online return, append-only. The fold of these is the return. */
export type OnlineReturnStep =
  | { readonly kind: 'requested'; readonly returnId: string; readonly orderId: string; readonly customerRef: string; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[]; readonly reason: string; readonly at: string }
  | { readonly kind: 'collection_scheduled'; readonly returnId: string; readonly collectOn: string; readonly by: string; readonly at: string }
  | {
    readonly kind: 'collected'; readonly returnId: string; readonly by: string; readonly at: string;
    /** WF-16 (driver): what the driver took at the door, from the booked lines only. Absent when the desk recorded it. */
    readonly lines?: readonly { readonly productId: string; readonly collectedMinor: number }[];
    /** WF-16 (driver): the route it was collected on, and the store computer that relayed the phone's record. */
    readonly routeId?: string;
    readonly relayedBy?: string;
  }
  /** WF-16 (driver): the driver came and nothing was collected — the booking stands until the shop books again. */
  | { readonly kind: 'collection_missed'; readonly returnId: string; readonly reason: CollectionMissReason; readonly note?: string; readonly routeId?: string; readonly by: string; readonly relayedBy?: string; readonly at: string }
  | { readonly kind: 'received'; readonly returnId: string; readonly lines: readonly { readonly productId: string; readonly receivedMinor: number }[]; readonly by: string; readonly at: string }
  | { readonly kind: 'disposed'; readonly returnId: string; readonly productId: string; readonly disposition: ReturnDisposition; readonly reason?: string; readonly by: string; readonly at: string }
  | { readonly kind: 'refund_recorded'; readonly returnId: string; readonly refundId: string; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly priceBasis: string }[]; readonly amountMinor: number; readonly state: 'issued' | 'pending' | 'refused'; readonly by: string; readonly at: string };

/** Why a driver came back without the goods. Chosen on the phone, never typed. */
export const COLLECTION_MISS_REASONS = Object.freeze(['customer_not_available', 'nothing_handed_over'] as const);
export type CollectionMissReason = (typeof COLLECTION_MISS_REASONS)[number];
const MISS_WORDS: Readonly<Record<CollectionMissReason, string>> = Object.freeze({
  customer_not_available: 'nobody was there to hand it over',
  nothing_handed_over: 'nothing was handed over',
});

export type OnlineReturnStage = 'requested' | 'collection_scheduled' | 'collected' | 'received' | 'refund_waiting' | 'refunded' | 'refund_refused';

export interface OnlineReturnView {
  readonly returnId: string;
  readonly orderId: string;
  readonly customerRef: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly requestedMinor: number;
    /** What the driver recorded taking at the door (WF-16, driver) — absent when the desk recorded the collection. */
    readonly collectedMinor?: number;
    readonly receivedMinor?: number;
    readonly disposition?: ReturnDisposition;
    readonly dispositionReason?: string;
    /** The refund this line was refunded on (pending or issued), when it has been. */
    readonly refundId?: string;
  }[];
  readonly collectOn?: string;
  readonly collectedAt?: string;
  /** Who recorded the collection, and the route it was on when a driver did. */
  readonly collectedBy?: string;
  readonly collectedOnRoute?: string;
  /** Every visit that came back without the goods, oldest first (P-08: a miss is shown, never dropped). */
  readonly missedCollections: readonly { readonly at: string; readonly reason: CollectionMissReason; readonly by: string; readonly note?: string }[];
  readonly receivedAt?: string;
  readonly refunds: readonly { readonly refundId: string; readonly amountMinor: number; readonly state: 'issued' | 'pending' | 'refused' }[];
  readonly stage: OnlineReturnStage;
  /** Each step in words, oldest first — what the customer sees in the app. */
  readonly steps: readonly { readonly at: string; readonly say: string }[];
}

const inr = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * Fold one return's steps. `refundStates` is the effective state of each refund after any later outcome from the
 * provider's statement (C14 / FUL-03): a pending refund that the statement later confirmed is issued.
 */
export function foldOnlineReturn(steps: readonly OnlineReturnStep[], refundStates: Readonly<Record<string, 'issued' | 'pending' | 'refused'>> = {}): OnlineReturnView | undefined {
  const req = steps.find((s): s is Extract<OnlineReturnStep, { kind: 'requested' }> => s.kind === 'requested');
  if (req === undefined) return undefined;
  const received = new Map<string, number>();
  const disposed = new Map<string, { disposition: ReturnDisposition; reason?: string }>();
  const refundOf = new Map<string, string>();
  const refunds: { refundId: string; amountMinor: number; state: 'issued' | 'pending' | 'refused' }[] = [];
  const say: { at: string; say: string }[] = [{ at: req.at, say: `Return asked for: ${req.lines.map((l) => `${l.quantityMinor} × ${l.productId}`).join(', ')}` }];
  let collectOn: string | undefined; let collectedAt: string | undefined; let receivedAt: string | undefined;
  let collectedBy: string | undefined; let collectedOnRoute: string | undefined;
  const collected = new Map<string, number>();
  const missed: { at: string; reason: CollectionMissReason; by: string; note?: string }[] = [];
  for (const s of steps) {
    switch (s.kind) {
      case 'collection_scheduled': collectOn = s.collectOn; say.push({ at: s.at, say: `Collection booked for ${s.collectOn}` }); break;
      case 'collected':
        if (collectedAt === undefined) {
          collectedAt = s.at; collectedBy = s.by; collectedOnRoute = s.routeId;
          for (const l of s.lines ?? []) collected.set(l.productId, l.collectedMinor);
          const taken = (s.lines ?? []).filter((l) => l.collectedMinor > 0);
          say.push({ at: s.at, say: taken.length === 0 ? 'Collected from you' : `Collected from you: ${taken.map((l) => `${l.collectedMinor} × ${l.productId}`).join(', ')}` });
        }
        break;
      case 'collection_missed':
        if (collectedAt === undefined) {
          missed.push({ at: s.at, reason: s.reason, by: s.by, ...(s.note === undefined ? {} : { note: s.note }) });
          say.push({ at: s.at, say: `The driver came to collect, but ${MISS_WORDS[s.reason]}. The shop will book again.` });
        }
        break;
      case 'received':
        if (receivedAt === undefined) {
          receivedAt = s.at;
          for (const l of s.lines) received.set(l.productId, l.receivedMinor);
          say.push({ at: s.at, say: `Received back at the shop: ${s.lines.map((l) => `${l.receivedMinor} × ${l.productId}`).join(', ')}` });
        }
        break;
      case 'disposed': if (!disposed.has(s.productId)) disposed.set(s.productId, { disposition: s.disposition, ...(s.reason === undefined ? {} : { reason: s.reason }) }); break;
      case 'refund_recorded': {
        const state = refundStates[s.refundId] ?? s.state;
        refunds.push({ refundId: s.refundId, amountMinor: s.amountMinor, state });
        if (state !== 'refused') for (const l of s.lines) refundOf.set(l.productId, s.refundId);
        say.push({ at: s.at, say: state === 'issued' ? `Refunded ${inr(s.amountMinor)} to the way you paid` : state === 'pending' ? `Refund of ${inr(s.amountMinor)} asked for — waiting for the bank to confirm` : `The bank did not accept the refund of ${inr(s.amountMinor)}; the shop will be in touch` });
        break;
      }
      default: break;
    }
  }
  const live = refunds.filter((r) => r.state !== 'refused');
  const stage: OnlineReturnStage = live.some((r) => r.state === 'pending') ? 'refund_waiting'
    : live.length > 0 ? 'refunded'
      : refunds.length > 0 ? 'refund_refused'
        : receivedAt !== undefined ? 'received' : collectedAt !== undefined ? 'collected' : collectOn !== undefined ? 'collection_scheduled' : 'requested';
  return {
    returnId: req.returnId, orderId: req.orderId, customerRef: req.customerRef, reason: req.reason, requestedAt: req.at,
    lines: req.lines.map((l) => {
      const d = disposed.get(l.productId);
      const r = received.get(l.productId);
      const f = refundOf.get(l.productId);
      const c = collectedAt === undefined || collected.size === 0 ? undefined : collected.get(l.productId) ?? 0;
      return {
        productId: l.productId, requestedMinor: l.quantityMinor,
        ...(c === undefined ? {} : { collectedMinor: c }),
        ...(r === undefined ? {} : { receivedMinor: r }),
        ...(d === undefined ? {} : { disposition: d.disposition, ...(d.reason === undefined ? {} : { dispositionReason: d.reason }) }),
        ...(f === undefined ? {} : { refundId: f }),
      };
    }),
    ...(collectOn === undefined ? {} : { collectOn }), ...(collectedAt === undefined ? {} : { collectedAt }),
    ...(collectedBy === undefined ? {} : { collectedBy }), ...(collectedOnRoute === undefined ? {} : { collectedOnRoute }),
    missedCollections: missed,
    ...(receivedAt === undefined ? {} : { receivedAt }),
    refunds, stage, steps: say.sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export type ReceiveCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** A count must name only lines asked for, whole numbers from 0 to what was asked. */
export function checkReceivedCount(view: OnlineReturnView, lines: readonly { readonly productId: string; readonly receivedMinor: number }[]): ReceiveCheck {
  const asked = new Map(view.lines.map((l) => [l.productId, l.requestedMinor] as const));
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.productId)) return { ok: false, detail: `${l.productId} is counted twice` };
    seen.add(l.productId);
    const a = asked.get(l.productId);
    if (a === undefined) return { ok: false, detail: `${l.productId} was not on this return` };
    if (!Number.isInteger(l.receivedMinor) || l.receivedMinor < 0 || l.receivedMinor > a) return { ok: false, detail: `${l.productId}: counted ${l.receivedMinor}, but ${a} was asked to be returned` };
  }
  for (const id of asked.keys()) if (!seen.has(id)) return { ok: false, detail: `${id} was not counted — count it, 0 if it did not come back` };
  return { ok: true };
}

export type CollectedCheck =
  | { readonly ok: true; readonly lines: readonly { readonly productId: string; readonly collectedMinor: number }[] }
  | { readonly ok: false; readonly code: 'not_on_this_return' | 'not_a_whole_number' | 'more_than_booked' | 'counted_twice' | 'nothing_collected'; readonly detail: string };

/**
 * WF-16 (driver): what the driver took at the door may name only lines booked on this return, whole numbers from 0 to what
 * was booked — never more. A line not named was not taken (0). Taking nothing at all is not a collection: it is a miss.
 * The answer lists every booked line, in the return's order.
 */
export function checkCollectedLines(view: OnlineReturnView, lines: readonly { readonly productId: string; readonly collectedMinor: number }[]): CollectedCheck {
  const booked = new Map(view.lines.map((l) => [l.productId, l.requestedMinor] as const));
  const took = new Map<string, number>();
  for (const l of lines) {
    if (took.has(l.productId)) return { ok: false, code: 'counted_twice', detail: `${l.productId} is named twice` };
    const b = booked.get(l.productId);
    if (b === undefined) return { ok: false, code: 'not_on_this_return', detail: `${l.productId} was not booked on this return` };
    if (!Number.isInteger(l.collectedMinor) || l.collectedMinor < 0) return { ok: false, code: 'not_a_whole_number', detail: `${l.productId}: ${l.collectedMinor} is not a whole number of items` };
    if (l.collectedMinor > b) return { ok: false, code: 'more_than_booked', detail: `${l.productId}: collected ${l.collectedMinor}, but ${b} was booked for collection` };
    took.set(l.productId, l.collectedMinor);
  }
  const out = view.lines.map((l) => ({ productId: l.productId, collectedMinor: took.get(l.productId) ?? 0 }));
  if (out.every((l) => l.collectedMinor === 0)) return { ok: false, code: 'nothing_collected', detail: 'no item was taken — record it as "nothing handed over" instead' };
  return { ok: true, lines: out };
}

export type RefundLinePlan =
  | { readonly ok: true; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly priceBasis: string }[]; readonly amountMinor: number }
  | { readonly ok: false; readonly code: 'not_received_yet' | 'already_refunded' | 'nothing_received' | 'price_not_known' | 'not_disposed_yet'; readonly detail: string };

/**
 * What may be refunded now: every RECEIVED line (count above 0) a person has given a disposition, not yet refunded — at
 * the price it was charged. A line already refunded (pending or issued) is refused "already refunded".
 */
export function planReturnRefund(view: OnlineReturnView, priceOf: (productId: string) => { readonly unitPriceMinor: number; readonly basis: string } | undefined, only?: readonly string[]): RefundLinePlan {
  if (view.receivedAt === undefined) return { ok: false, code: 'not_received_yet', detail: 'nothing is refunded until the goods are received back and counted' };
  const wanted = view.lines.filter((l) => only === undefined || only.includes(l.productId));
  const already = wanted.filter((l) => l.refundId !== undefined);
  if (already.length > 0) return { ok: false, code: 'already_refunded', detail: `${ALREADY_REFUNDED}: ${already.map((l) => l.productId).join(', ')}` };
  const due = wanted.filter((l) => (l.receivedMinor ?? 0) > 0);
  if (due.length === 0) return { ok: false, code: 'nothing_received', detail: 'no line came back, so there is nothing to refund' };
  const undisposed = due.filter((l) => l.disposition === undefined);
  if (undisposed.length > 0) return { ok: false, code: 'not_disposed_yet', detail: `a person has not chosen where ${undisposed.map((l) => l.productId).join(', ')} goes (sellable, quarantine or waste)` };
  const out: { productId: string; quantityMinor: number; unitPriceMinor: number; priceBasis: string }[] = [];
  for (const l of due) {
    const p = priceOf(l.productId);
    if (p === undefined) return { ok: false, code: 'price_not_known', detail: `the price ${l.productId} was charged at is not known, so its refund cannot be worked out` };
    out.push({ productId: l.productId, quantityMinor: l.receivedMinor!, unitPriceMinor: p.unitPriceMinor, priceBasis: p.basis });
  }
  return { ok: true, lines: out, amountMinor: out.reduce((t, l) => t + l.quantityMinor * l.unitPriceMinor, 0) };
}

/** The customer's words for each stage. */
export function returnStageWords(stage: OnlineReturnStage): string {
  switch (stage) {
    case 'requested': return 'We have your return request. The shop will book a collection.';
    case 'collection_scheduled': return 'A collection is booked.';
    case 'collected': return 'Collected — on its way back to the shop.';
    case 'received': return 'Received back at the shop and counted. The refund follows for what came back.';
    case 'refund_waiting': return 'Refund asked for — waiting for the bank to confirm. It is not done until the bank says so.';
    case 'refunded': return 'Refunded to the way you paid.';
    case 'refund_refused': return 'The bank did not accept the refund. The shop will be in touch.';
  }
}
