// Browser entry — the bundler's input for the customer app (`pnpm build:customer`). It wires the
// real shopping session and privacy centre and attaches them as `window.shop`, which
// `web/app.js` binds to.
//
// ── The one thing this surface must get right, and it is the inverse of the till ──
//
// **An order is not placed until the shop has it.** The till commits locally and syncs afterwards
// (hard rule #1) because the money is already in the drawer and the customer has walked away — the
// event happened, and refusing to record it loses it. Here nothing has happened at all: no money
// has moved, no goods have left, and the shop has never heard of this basket. An app that says
// "order placed" over a request that never left the phone has told somebody something untrue about
// the world, and they find out when nothing arrives.
//
// So `reachedTheShop` is the transport's honest answer, never the app's guess, and it is the only
// thing that turns a prepared basket into a sent one. Since M20 slice 2 that transport is REAL:
// `place()` POSTs the reviewed basket to the shop's `/v1/storefront/orders/:orderId` with the
// customer's session token (`shop-transport.ts`), and what the shop answered — has it, refused it,
// session ended, could not answer, never reached — is what the customer is told. The token lives in
// this closure for the tab's life and appears nowhere else (hard rule #4: the app mints nothing).
//
// ── What is cached and what is not (§31 customer row) ───────────────────────
//
// The **basket** may cache: it is the customer's own working state and losing it on a bus is a
// nuisance nobody benefits from. Ordering and payment **require online** and say so plainly.
// Prices are never treated as current from a cache — the review carries the catalogue pack version
// it was built against, and paying against a stale one is refused rather than quietly repriced.

import type { StorefrontProduct } from '../../../packages/storefront/src/browse';
import { searchCatalogue, repeatOrder, type SavedList } from '../../../packages/storefront/src/browse';
import type { Slot, ServiceabilityPolicy } from '../../../packages/storefront/src/checkout';
import type { ConsentState } from '../../../packages/customer/src/consent';
import {
  newSession,
  setLine,
  review,
  acceptWhatIsAvailable,
  chooseSlot,
  send,
  orderStatusLine,
  type SessionState,
} from './shopping-session';
import {
  consentControls,
  raiseRequest,
  setConsent,
  RIGHTS_OFFERED,
  type ConsentPurposeSpec,
} from './privacy-centre';
import { httpShopTransport, readShopAnswer, type ShopTransport, type ShopPaymentResult } from './shop-transport';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The practice-data strip ("TRIAL COPY · PRACTICE DATA"), exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
// build-time constant baked in by esbuild (`scripts/build-app.mjs`): '1' in the hosted-demo build, empty
// in production. `typeof` guards the unbundled case (identifier absent) and a non-browser import.
declare const PILOT_DEMO_BANNER: string;
const demoBannerDoc = (globalThis as { document?: unknown }).document;
if (demoBannerDoc !== undefined && demoBannerDoc !== null) {
  mountDemoBanner(demoBannerDoc as BannerDocument, typeof PILOT_DEMO_BANNER === 'string' ? PILOT_DEMO_BANNER : '');
}

/** Everything the app was given about this shop and this customer. */
export interface ShopData {
  readonly tenantId?: string;
  readonly customerRef?: string;
  readonly products?: readonly StorefrontProduct[];
  /** The catalogue pack version these products came from. Prices are only valid against it. */
  readonly packVersion?: number;
  readonly slots?: readonly Slot[];
  readonly savedLists?: readonly SavedList[];
  readonly policy?: ServiceabilityPolicy;
  readonly storeLocation?: { readonly lat: number; readonly lon: number };
  readonly deliveryLocation?: { readonly lat: number; readonly lon: number };
  readonly deliveryFeeMinor?: number;
  /** The store (stock location) that fulfils this app's orders — told by the box, never guessed here. */
  readonly locationId?: string;
  /** The purposes this tenant asks consent for. Choose-able, never hard-coded. */
  readonly consentPurposes?: readonly ConsentPurposeSpec[];
  readonly consent?: ConsentState;
  /** Days the tenant has to answer a data request. Per-tenant policy. */
  readonly privacySlaDays?: number;
}

/** A source of the customer's current position — the browser's geolocation, or a fake in a test. */
export type GeoProvider = () => Promise<{ readonly lat: number; readonly lon: number }>;

/** Why `place()` did not hand the order to the shop — the session's own reasons, plus the shop's. */
export type PlaceRefusal =
  | NonNullable<ReturnType<typeof send>['refusedBecause']>
  | 'order_refused'
  | 'already_sent'
  | 'not_signed_in'
  | 'no_store_named'
  | 'no_road_to_the_shop'
  | 'signed_out'
  | 'the_shop_refused'
  | 'the_shop_could_not_answer';

export type PlaceOutcome =
  | {
    readonly ok: true;
    readonly state: SessionState;
    /** `true` — the shop HAS the order. `false` — prepared, not sent; nothing charged. */
    readonly shopHasIt: boolean;
    readonly orderId: string;
    readonly detail: string;
    /** FUL-07: the shop could not promise everything; nothing is charged until the customer decides. */
    readonly needsDecision?: boolean;
    readonly shortages?: readonly { readonly productId: string; readonly requestedMinor: number; readonly promisedMinor: number }[];
    /** The shop's own price for what it promised (FUL-03). */
    readonly quoteMinor?: number;
    /** The payment as the SHOP holds it: authorised only when the provider said so. */
    readonly paymentState?: string;
  }
  | {
    readonly ok: false;
    readonly state: SessionState;
    readonly refusedBecause: PlaceRefusal;
    /** What the customer is told — the session's or the shop's own sentence, never a cheerier one. */
    readonly tellTheCustomer: string;
    readonly detail: string;
  };

/** Order ids must be unique across every phone: a clash would read as a probe of someone else's order. */
const randomOrderId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `ORD-${id.replace(/-/g, '').slice(0, 20).toUpperCase()}`;
};

export interface LocationCaptureResult {
  readonly ok: boolean;
  /** The plain sentence for the screen — the truth whether it worked or the customer said no. */
  readonly detail: string;
}

/** The basket, kept on the device so a dropped signal is a nuisance and not a lost afternoon. */
export interface BasketStore {
  read(): SessionState | null;
  write(state: SessionState): void;
}

export function forgetfulBasket(): BasketStore {
  let held: SessionState | null = null;
  return { read: () => held, write: (s) => { held = s; } };
}

/**
 * The device's own storage for the basket, guarded.
 *
 * A basket is the customer's own working state — no card data, no tokens, no order history, just
 * product ids and quantities (hard rules #3, #4). A failed read opens an empty basket rather than
 * refusing to start: an app that will not open because of one bad byte is worse than one that
 * opens with an empty basket, and the customer can see at a glance which they have.
 */
export function deviceBasket(
  key: string,
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined,
  onProblem: (why: string) => void,
): BasketStore {
  if (storage === undefined) {
    onProblem('this device will not remember your basket if you close the app');
    return forgetfulBasket();
  }
  return {
    read: () => {
      try {
        const raw = storage.getItem(key);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        return parsed as SessionState;
      } catch {
        onProblem('your saved basket could not be read, so you are starting with an empty one');
        return null;
      }
    },
    write: (state) => {
      try {
        storage.setItem(key, JSON.stringify(state));
      } catch {
        onProblem('this device could not save your basket');
      }
    },
  };
}

export class UnknownListError extends Error {
  constructor(listId: string) {
    super(`No saved list "${listId}" on this device.`);
    this.name = 'UnknownListError';
  }
}

export interface Shop {
  /** The basket as it stands, and the sentence to show about it. */
  state(): SessionState;
  /** Search the catalogue this device holds. Typo-tolerant; the ranking lives in the package. */
  search(term: string): ReturnType<typeof searchCatalogue>;
  /** Add or change a line. Any change invalidates the review — the total must be seen again. */
  setLine(productId: string, quantityMinor: number): SessionState;
  /** Rebuild a past basket in one tap (≤3 taps to reorder, QG-02). */
  repeat(listId: string): ReturnType<typeof repeatOrder>;
  /** Check the basket against the live catalogue before anything is paid for. */
  review(): ReturnType<typeof review>;
  /** Take the basket as it actually is — short lines reduced, unavailable lines dropped. */
  acceptWhatIsAvailable(): ReturnType<typeof acceptWhatIsAvailable>;
  slots(): readonly Slot[];
  chooseSlot(slotId: string, now: string): ReturnType<typeof chooseSlot>;
  /**
   * Capture the customer's OWN location for the delivery distance check, from a position provider —
   * the device's geolocation in the browser, injected here so it is testable and needs no external
   * service. Until it is captured, delivery cannot be judged and the app must not guess a location:
   * a refused capture leaves it UNSET (and `send` then refuses delivery honestly), never a silent
   * {0,0} that reads as "9,000 km away".
   */
  useMyLocation(provider: GeoProvider): Promise<LocationCaptureResult>;
  /** Whether the customer's delivery location has been captured — the app gates delivery on it. */
  hasLocation(): boolean;
  /** Send the order. `reachedTheShop` is the transport's answer and never this app's guess. */
  send(input: {
    readonly orderId: string;
    readonly providerRef: string;
    readonly result: 'authorised' | 'declined' | 'unknown';
    readonly reachedTheShop: boolean;
  }): ReturnType<typeof send>;
  /**
   * Place the order THROUGH THE SHOP (M20-FR-03). Runs the session's own checks first (reviewed,
   * resolved, current prices, slot, no card number — none of these ever reaches the network), then
   * POSTs the basket with the session token and turns the shop's answer into the truth the customer
   * sees. A request that never reached the shop leaves the basket *prepared, not sent*; `retry()`
   * sends the same order (same id, same idempotency key) so it can never become two.
   */
  place(input: { readonly providerRef: string; readonly result: ShopPaymentResult }): Promise<PlaceOutcome>;
  /** Re-send a prepared basket. `null` when nothing is waiting to go. */
  retry(): Promise<PlaceOutcome | null>;
  /**
   * FUL-07: after a shortage, pay for what the shop promised — the shop's quote, never the app's sum — or cancel. And ask
   * the shop to check a pending payment with the provider. Each answer is the shop's; the screen shows it as it came.
   */
  payForWhatTheShopHas(input: { readonly providerRef: string; readonly result: ShopPaymentResult }): Promise<PlaceOutcome>;
  cancelOrder(): Promise<PlaceOutcome>;
  checkPayment(): Promise<PlaceOutcome>;
  /** Hold the customer's session token, in memory only. */
  signedIn(token: string): void;
  signOut(): void;
  isSignedIn(): boolean;
  /** What the order screen says afterwards. `payment_pending` reads as waiting, never as done. */
  statusLine(): string | null;
  /** The consent switches — one row, one toggle, same cost in both directions — as the SHOP last said it holds them. */
  consent(): ReturnType<typeof consentControls>;
  /**
   * Grant or withdraw (FUL-06). Saved on the shop in the customer's own session and READ BACK: the switch moves only
   * when the shop has it. Offline, signed out or refused, nothing moves and the customer is told so in plain words.
   */
  setConsent(purpose: string, channel: string, granted: boolean): Promise<PrivacyOutcome>;
  /** Read my consent and my requests from the shop (on sign-in, and after any change). */
  loadPrivacy(): Promise<PrivacyOutcome>;
  /** The rights on offer, each marked with whether the law lets it be complete. */
  rights(): typeof RIGHTS_OFFERED;
  /** Raise a request ON THE SHOP (FUL-06). "Received" only when the shop has it; the shop's own reference and date. */
  raise(kind: (typeof RIGHTS_OFFERED)[number]['kind'], at: string): Promise<RaiseOutcome>;
  /** My requests as the shop last reported them. */
  myRequests(): readonly MyPrivacyRequest[];
}

/** Why a privacy change did not reach the shop — each one says nothing was saved. */
export type PrivacyRefusal =
  | 'unknown_purpose' | 'required_for_service'
  | 'not_signed_in' | 'no_road_to_the_shop' | 'not_saved_no_connection'
  | 'signed_out' | 'the_shop_refused' | 'the_shop_could_not_answer';

export type PrivacyOutcome =
  | { readonly ok: true; readonly granted?: boolean; readonly tellTheCustomer: string }
  | { readonly ok: false; readonly refusal: PrivacyRefusal; readonly tellTheCustomer: string };

export interface MyPrivacyRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly state: string;
  readonly dueBy: string;
}

export type RaiseOutcome =
  | { readonly ok: true; readonly request: MyPrivacyRequest; readonly tellTheCustomer: string }
  | { readonly ok: false; readonly refusal: PrivacyRefusal; readonly tellTheCustomer: string };

/** A request reference unique across every phone — a clash would read as another customer's request. */
const randomRequestId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `DSR-${id.replace(/-/g, '').slice(0, 20).toUpperCase()}`;
};

/**
 * Build the customer's session from what the app was given.
 *
 * Returns `null` when there is no catalogue. A shop app with no products is not an empty shop —
 * it is an app that has not been told anything, and the screen says which.
 */
export function bootShop(
  data: ShopData | undefined,
  basket: BasketStore,
  nextId: () => string,
  transport?: ShopTransport,
  newOrderId: () => string = randomOrderId,
): Shop | null {
  const products = data?.products;
  if (products === undefined || products.length === 0) return null;

  let state = basket.read() ?? newSession();
  // The session token — in memory for the tab's life, never written anywhere (hard rule #4).
  let token: string | undefined;
  // A basket the shop has not yet acknowledged: the order id and payment answer it must go out
  // with again, so a retry is the SAME order and can never become two.
  let prepared: { readonly orderId: string; readonly providerRef: string; readonly result: ShopPaymentResult; readonly review: SessionState['review'] } | undefined;
  // The order the shop holds and what it last said about it (FUL-07) — the screen shows this, never the app's own guess.
  let held: { readonly orderId: string; readonly quoteMinor?: number } | undefined;
  let awaitingDecision = false;
  const purposes = data?.consentPurposes ?? [];
  let consent: ConsentState = data?.consent ?? { grants: [] };
  // FUL-06: my requests as the shop last reported them, and a request sent but not yet acknowledged (kept for retry).
  let requests: readonly MyPrivacyRequest[] = [];
  let pendingRequest: { readonly kind: string; readonly requestId: string } | undefined;
  const newRequestId = nextId;
  let consentTaps = 0;
  // The customer's OWN delivery location. Undefined until captured from the device — never guessed,
  // so the distance check refuses honestly rather than measuring from {0,0}.
  let deliveryLocation = data?.deliveryLocation;

  const keep = (next: SessionState): SessionState => {
    state = next;
    basket.write(next);
    return next;
  };

  return {
    state: () => state,

    search: (term) => searchCatalogue({ query: term, products }),

    setLine: (productId, quantityMinor) => keep(setLine(state, { productId, quantityMinor })),

    repeat: (listId) => {
      // A list this device was never given is not an empty list. Rebuilding a basket from nothing
      // and calling it a repeat order is how the milk quietly disappears from somebody's weekly
      // shop — the package already refuses to lose an item silently, and this must not undo that.
      const list = (data?.savedLists ?? []).find((l) => l.listId === listId);
      if (list === undefined) throw new UnknownListError(listId);
      const result = repeatOrder({ previousLines: list.lines, products });
      for (const line of result.lines) state = setLine(state, line);
      basket.write(state);
      return result;
    },

    review: () => {
      const result = review(state, { products, packVersion: data?.packVersion ?? 0 });
      keep(result.state);
      return result;
    },

    acceptWhatIsAvailable: () => {
      const result = acceptWhatIsAvailable(state);
      keep(result.state);
      return result;
    },

    slots: () => data?.slots ?? [],

    chooseSlot: (slotId, now) => {
      const result = chooseSlot(state, { slotId, slots: data?.slots ?? [], now });
      keep(result.state);
      return result;
    },

    hasLocation: () => deliveryLocation !== undefined,

    useMyLocation: async (provider) => {
      try {
        const at = await provider();
        // A provider that hands back nonsense is not a location. Reject it rather than let the
        // distance check run on rubbish — the customer is told to try again, not silently refused.
        if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
          return { ok: false, detail: 'we could not read a usable location — please try again' };
        }
        deliveryLocation = { lat: at.lat, lon: at.lon };
        return { ok: true, detail: 'got your location — we can now check we deliver to you' };
      } catch {
        // Permission denied, timeout, no signal — all the same to the customer: we do not have it,
        // and we say so plainly rather than proceeding as if we did.
        deliveryLocation = undefined;
        return { ok: false, detail: 'we do not have your location, so we cannot check delivery — you can allow it and try again, or collect from the store' };
      }
    },

    send: (input) => {
      const result = send(state, sendInput(input.orderId, input.providerRef, input.result, input.reachedTheShop));
      keep(result.state);
      return result;
    },

    place: (input) => placeThroughTheShop(input.providerRef, input.result),

    retry: () => (prepared === undefined || state.stage !== 'waiting_for_signal'
      ? Promise.resolve(null)
      : placeThroughTheShop(prepared.providerRef, prepared.result)),

    payForWhatTheShopHas: (input) => followUp('payment', { providerRef: input.providerRef, amountMinor: held?.quoteMinor ?? 0, result: input.result }),
    cancelOrder: () => followUp('cancel', {}),
    checkPayment: () => followUp('payment/check', {}),

    signedIn: (t) => { token = t; },
    signOut: () => { token = undefined; },
    isSignedIn: () => token !== undefined,

    // FUL-07: while the shop waits for the customer's decision on a shortage, its own sentence is the status.
    statusLine: () => (state.order === undefined ? null : awaitingDecision ? `Order ${state.order.orderId}: ${state.tellTheCustomer}` : orderStatusLine(state.order)),

    consent: () => consentControls(consent, purposes),

    setConsent: async (purpose, channel, granted) => {
      // The tenant's own rules first, on the phone (an unknown switch, a required purpose): nothing is sent.
      const change = setConsent(consent, purposes, { purpose, channel, granted });
      if (!change.ok) {
        return { ok: false, refusal: change.refusal, tellTheCustomer: change.refusal === 'required_for_service'
          ? 'Messages about an order you placed are needed to deliver it, so they cannot be switched off.'
          : 'This is not a choice this shop offers.' };
      }
      // Then the shop. The switch moves only when the shop has saved it and we have read it back.
      const answer = await privacyCall({ method: 'POST', path: '/consent', body: { purpose, channel, given: granted }, idempotencyKey: `consent-${purpose}-${channel}-${granted ? 'on' : 'off'}-${Date.now().toString(36)}-${(consentTaps += 1)}` });
      if (!answer.ok) return answer;
      const reread = await loadPrivacyFromTheShop();
      if (!reread.ok) return { ok: false, refusal: reread.refusal, tellTheCustomer: `The shop took your choice but we could not read it back to show you. ${reread.tellTheCustomer}` };
      const body = answer.body as { granted?: unknown; tellTheCustomer?: unknown };
      return { ok: true, granted: body.granted === true, tellTheCustomer: typeof body.tellTheCustomer === 'string' ? body.tellTheCustomer : 'Saved.' };
    },

    loadPrivacy: () => loadPrivacyFromTheShop(),

    rights: () => RIGHTS_OFFERED,

    raise: async (kind, at) => {
      // The phone's own check that this is a right it offers (an unknown one throws, as before) — nothing sent.
      raiseRequest({ requestId: 'check', tenantId: data?.tenantId ?? 'tenant', customerRef: 'self', kind, at, slaDays: data?.privacySlaDays ?? 30 });
      // One reference for this request, kept for a retry so a lost answer can never raise it twice.
      const requestId = pendingRequest?.kind === kind ? pendingRequest.requestId : newRequestId();
      pendingRequest = { kind, requestId };
      const answer = await privacyCall({ method: 'POST', path: `/requests/${requestId}`, body: { kind }, idempotencyKey: `privacy-request-${requestId}` });
      if (!answer.ok) return answer;
      pendingRequest = undefined;
      const b = answer.body as { requestId?: unknown; kind?: unknown; state?: unknown; dueBy?: unknown; tellTheCustomer?: unknown };
      const request: MyPrivacyRequest = { requestId: String(b.requestId ?? requestId), kind: String(b.kind ?? kind), state: String(b.state ?? 'raised'), dueBy: String(b.dueBy ?? '') };
      requests = [request, ...requests.filter((r) => r.requestId !== request.requestId)];
      // The shop's own sentence: received, with its reference and its date — never "done".
      return { ok: true, request, tellTheCustomer: typeof b.tellTheCustomer === 'string' ? b.tellTheCustomer : `We have your request (reference ${request.requestId}).` };
    },

    myRequests: () => requests,
  };

  /** One privacy call as the signed-in customer, read honestly: saved only on the shop's 2xx. */
  async function privacyCall(call: { method: 'GET' | 'POST'; path: '' | '/consent' | `/requests/${string}`; body?: unknown; idempotencyKey?: string }):
    Promise<{ ok: true; body: unknown } | { ok: false; refusal: PrivacyRefusal; tellTheCustomer: string }> {
    if (token === undefined) return { ok: false, refusal: 'not_signed_in', tellTheCustomer: 'Please sign in first, so the shop knows these are your choices. Nothing was changed.' };
    if (transport?.privacy === undefined) return { ok: false, refusal: 'no_road_to_the_shop', tellTheCustomer: 'This app has no connection to the shop set up, so nothing was saved. Your earlier choices stand.' };
    const answer = await transport.privacy({ token, ...call });
    if (!answer.reached) return { ok: false, refusal: 'not_saved_no_connection', tellTheCustomer: 'Not saved — this did not reach the shop. Your earlier choice stands; please try again when you have a signal.' };
    if (answer.status === 200 || answer.status === 201) return { ok: true, body: answer.body };
    if (answer.status === 401) { token = undefined; return { ok: false, refusal: 'signed_out', tellTheCustomer: 'Your sign-in has ended. Please sign in again — nothing was changed.' }; }
    if (answer.status >= 500) return { ok: false, refusal: 'the_shop_could_not_answer', tellTheCustomer: 'The shop could not save this just now. Nothing was changed — please try again in a moment.' };
    const err = (answer.body as { error?: { whatHappened?: unknown } } | undefined)?.error;
    return { ok: false, refusal: 'the_shop_refused', tellTheCustomer: typeof err?.whatHappened === 'string' ? err.whatHappened : 'The shop did not accept this. Nothing was changed.' };
  }

  /** Replace the phone's copy with what the shop holds — consent per purpose/channel, and my requests. */
  async function loadPrivacyFromTheShop(): Promise<PrivacyOutcome> {
    const answer = await privacyCall({ method: 'GET', path: '' });
    if (!answer.ok) return answer;
    const b = answer.body as { consent?: unknown; requests?: unknown };
    const held = Array.isArray(b.consent) ? (b.consent as { purpose?: unknown; channel?: unknown; granted?: unknown }[]) : [];
    consent = {
      grants: held.filter((c) => typeof c.purpose === 'string' && typeof c.channel === 'string').map((c) => ({
        purpose: c.purpose as string, channel: c.channel as string, granted: c.granted === true, ...(c.granted === true ? {} : { withdrawn: true }),
      })),
    };
    requests = (Array.isArray(b.requests) ? (b.requests as Record<string, unknown>[]) : []).map((r) => ({
      requestId: String(r['requestId']), kind: String(r['kind']), state: String(r['state']), dueBy: String(r['dueBy']),
    }));
    return { ok: true, tellTheCustomer: 'These are the choices the shop holds for you.' };
  }

  /** The session's `send` input for one attempt — the same figures whether it is a dry run or the real thing. */
  function sendInput(orderId: string, providerRef: string, result: ShopPaymentResult, reachedTheShop: boolean): Parameters<typeof send>[1] {
    return {
        orderId,
        customerRef: data?.customerRef ?? 'guest',
        deliveryFeeMinor: data?.deliveryFeeMinor ?? 0,
        currentPackVersion: data?.packVersion ?? 0,
        // 10 km is the D08 default and it lives in the package, not here. An empty policy takes
        // the package's own defaults rather than a second copy of them drifting in this file.
        policy: data?.policy ?? {},
        storeLocation: data?.storeLocation ?? { lat: 0, lon: 0 },
        // The customer's captured location. Unset → {0,0}, which is out of every real radius, so an
        // un-located delivery is refused rather than measured from nowhere (the UI gates on
        // `hasLocation()` before offering delivery, so this is the belt-and-braces refusal).
        deliveryLocation: deliveryLocation ?? { lat: 0, lon: 0 },
        // A provider token. The session refuses a card number outright rather than redacting it,
        // because redacting means it was held first (hard rule #3).
        // A declined or unanswered payment carries a REASON, not a reference — there is nothing
        // to reference. Keeping the shapes apart is what stops "unknown" being read as a token.
        payment: result === 'authorised'
          ? { result: 'authorised', providerRef }
          : { result, reason: providerRef },
        reachedTheShop,
    };
  }

  async function followUp(action: 'payment' | 'payment/check' | 'cancel', body: unknown): Promise<PlaceOutcome> {
    const refuse = (refusedBecause: PlaceRefusal, tellTheCustomer: string, detail: string): PlaceOutcome => ({ ok: false, state, refusedBecause, tellTheCustomer, detail });
    if (held === undefined) return refuse('order_refused', 'There is no order with the shop to do this for.', 'no order is held');
    if (token === undefined) return refuse('not_signed_in', 'Please sign in first. Nothing has been charged.', 'no session token');
    if (transport?.followUp === undefined) return refuse('no_road_to_the_shop', 'This app has no connection to the shop set up. Nothing has been charged.', 'no follow-up transport');
    const answer = await transport.followUp({ orderId: held.orderId, token, action, body });
    if (!answer.reached) return refuse('the_shop_could_not_answer', 'This did not reach the shop. Nothing has changed — please try again.', answer.detail);
    const verdict = readShopAnswer(answer);
    if (verdict.kind !== 'placed') {
      return refuse(verdict.kind === 'refused' ? 'the_shop_refused' : verdict.kind === 'signed_out' ? 'signed_out' : 'the_shop_could_not_answer',
        verdict.kind === 'refused' ? verdict.whatHappened : 'The shop could not answer just now. Nothing has changed.', verdict.kind);
    }
    keep(fromTheShop(state, verdict));
    awaitingDecision = verdict.paymentState === 'none' && verdict.orderState === 'placed';
    return { ok: true, state, shopHasIt: true, orderId: held.orderId, detail: `the shop answered the ${action}`, paymentState: verdict.paymentState, ...(verdict.quoteMinor === undefined ? {} : { quoteMinor: verdict.quoteMinor }) };
  }

  async function placeThroughTheShop(providerRef: string, result: ShopPaymentResult): Promise<PlaceOutcome> {
    // An order the shop already has is not sent again by tapping Pay twice: the customer changes the
    // basket (which starts a new review) to order again. The idempotent retry path is `retry()`.
    if (state.stage === 'sent') {
      return { ok: false, state, refusedBecause: 'already_sent', tellTheCustomer: state.tellTheCustomer, detail: 'this basket was already sent and the shop has it — change the basket to start a new order' };
    }
    // The same order id as the last attempt for THIS reviewed basket; a fresh one otherwise.
    const orderId = prepared !== undefined && prepared.review === state.review ? prepared.orderId : newOrderId();

    // 1. The session's own checks, offline and first: not reviewed, problems unresolved, prices
    //    moved, no slot, a card number. None of these ever reaches the network, and each keeps the
    //    session's own sentence (a stale review is sent back to look, as `send` already does).
    const dry = send(state, sendInput(orderId, providerRef, result, true));
    if (!dry.ok) {
      keep(dry.state);
      const refusedBecause: PlaceRefusal = dry.refusedBecause ?? 'order_refused';
      return { ok: false, state, refusedBecause, tellTheCustomer: dry.state.order?.tellTheCustomer ?? dry.state.tellTheCustomer, detail: dry.detail };
    }
    const refuse = (refusedBecause: PlaceRefusal, tellTheCustomer: string, detail: string): PlaceOutcome =>
      ({ ok: false, state, refusedBecause, tellTheCustomer, detail });
    if (token === undefined) {
      return refuse('not_signed_in', 'Please sign in first, so the shop knows whose order this is. Your basket is kept.', 'no session token — the shop would not know who is ordering');
    }
    const locationId = data?.locationId;
    if (locationId === undefined) {
      return refuse('no_store_named', 'This app has not been told which store fulfils orders, so it cannot send one. Nothing has been charged.', 'ShopData.locationId is missing — the box did not name the fulfilling store');
    }
    if (transport === undefined) {
      return refuse('no_road_to_the_shop', 'This app has no connection to the shop set up, so it cannot send an order. Nothing has been charged.', 'no transport was given to bootShop');
    }

    // 2. The real thing. The amount is the session's own payable (items + fee) — the shop records
    //    it as the checkout's answer and invents nothing.
    const payable = dry.state.order?.payableMinor ?? 0;
    const slotKind = (data?.slots ?? []).find((sl) => sl.slotId === state.slotId)?.kind;
    const answer = await transport.placeOrder({
      orderId, token, locationId,
      lines: state.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })),
      payment: { providerRef, amountMinor: payable, result },
      // The shop quotes its own delivery fee for a delivery (FUL-03).
      ...(slotKind === undefined ? {} : { fulfilment: slotKind }),
    });

    if (!answer.reached) {
      // Nothing the shop acted on left the phone. Prepared, not sent — the model's own words.
      const waiting = send(state, sendInput(orderId, providerRef, result, false));
      keep(waiting.state);
      prepared = { orderId, providerRef, result, review: state.review };
      return { ok: true, state, shopHasIt: false, orderId, detail: answer.detail };
    }

    const verdict = readShopAnswer(answer);
    switch (verdict.kind) {
      case 'placed':
        // FUL-07: the order as the SHOP holds it — its payment state and its sentence — not the app's dry run.
        keep(fromTheShop(dry.state, verdict));
        prepared = undefined;
        held = { orderId, ...(verdict.quoteMinor === undefined ? {} : { quoteMinor: verdict.quoteMinor }) };
        awaitingDecision = verdict.needsCustomerDecision;
        return {
          ok: true, state, shopHasIt: true, orderId,
          detail: verdict.alreadyPlaced ? 'the shop already held this order — nothing was placed twice' : 'the shop has the order',
          paymentState: verdict.paymentState,
          ...(verdict.quoteMinor === undefined ? {} : { quoteMinor: verdict.quoteMinor }),
          ...(verdict.needsCustomerDecision ? { needsDecision: true, shortages: verdict.shortages } : {}),
        };
      case 'signed_out':
        token = undefined;
        prepared = { orderId, providerRef, result, review: state.review };
        return refuse('signed_out', 'Your sign-in has ended. Please sign in again — your basket is kept and nothing has been charged.', 'the shop answered 401');
      case 'shop_could_not_answer':
        prepared = { orderId, providerRef, result, review: state.review };
        return refuse('the_shop_could_not_answer', 'The shop could not take your order just now. Nothing is confirmed and nothing has been charged — please try again in a moment.', `the shop answered ${verdict.status}`);
      case 'refused':
        prepared = undefined;
        return refuse('the_shop_refused', verdict.whatHappened, `the shop refused: ${verdict.code}`);
    }
  }
}

/**
 * The session state, reconciled with what the shop said (FUL-07): an order is "confirmed" on this screen only when the
 * SHOP holds its payment as authorised; otherwise it is waiting, in the shop's own words.
 */
function fromTheShop(dry: SessionState, verdict: { readonly paymentState: string; readonly tellTheCustomer: string; readonly orderState?: string }): SessionState {
  if (dry.order === undefined) return dry;
  const confirmed = verdict.paymentState === 'authorised' && verdict.orderState !== 'cancelled';
  const tell = verdict.tellTheCustomer !== '' ? verdict.tellTheCustomer : dry.order.tellTheCustomer;
  return {
    ...dry,
    order: { ...dry.order, state: confirmed ? 'confirmed' : verdict.paymentState === 'declined' || verdict.orderState === 'cancelled' ? 'refused' : 'payment_pending', releaseForPicking: confirmed, tellTheCustomer: tell },
    tellTheCustomer: tell,
  };
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface ShopWindow {
  shop?: Shop;
  shopData?: ShopData;
  /** Anything that went wrong saving the basket, for the view to show (P-08). */
  shopStorageProblem?: string | null;
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: ShopWindow }).window;
if (browserWindow !== undefined) {
  const storage = (globalThis as {
    localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  }).localStorage;
  browserWindow.shopStorageProblem = null;
  const who = browserWindow.shopData?.customerRef ?? 'guest';
  const basket = deviceBasket(`sre.shop.basket.${who}`, storage, (why) => {
    browserWindow.shopStorageProblem = why;
  });
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  const transport = typeof globalThis.fetch === 'function'
    ? httpShopTransport({ fetch: globalThis.fetch.bind(globalThis), isOnline: () => nav?.onLine !== false })
    : undefined;
  const shop = bootShop(browserWindow.shopData, basket, randomRequestId, transport);
  if (shop !== null) browserWindow.shop = shop;
}
