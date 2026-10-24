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
import { PUBLISHED_RESPONSE_SLA_DAYS } from '../../../packages/customer/src/data-rights';
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
import { httpShopTransport, readShopAnswer, type ShopTransport, type ShopPaymentResult, type ShopMineRequest, type ShopCommerceRequest } from './shop-transport';
import { voiceQuery, voiceSearchLink, builtInRecogniser, customerVoiceSwitch, VOICE_SEARCH_SWITCHED_ON, type VoiceSearchPort, type RecognitionConstructor } from './voice-search';
import { basketKey, COUPON_CODE, repeatOrderBody, quoteRows, deliveryHandover, readReferralCode, referralWhy, HELP_TOPICS, SUBSTITUTION_CHOICES, type RepeatOrderForm, type RepeatOrderWhy, type ShopQuote } from './customer-commerce';
import { createScanAndGo, linesForTheShop, type ScanAndGo, type ScanProduct } from './scan-and-go';
import { readScan, scanFrames, scanSupported, type BarcodeReader } from './barcode-scan';

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
  /** Days the shop has to answer a data request — fixed at the published 15 days (R3 C5 · OB-195); the app never uses another figure. */
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
  /**
   * Round 8 (D08-FR-02/05): my own favourites, lists, complaints and return requests, ON THE SHOP and read back — saved
   * only on the shop's 2xx; signed out, offline or refused, nothing changes and the answer says which (`refusal`).
   */
  mine: MyShop;
  /** R4 Lane 2: the online store as the signed-in customer reads it — duties, stars, images, receipts, returns. */
  online: OnlineShop;
  /** OB-288 wave 3: the shop's price with offers, repeat orders, addresses, occasions, help, suggestions, substitutions. */
  commerce: CommerceShop;
}

/**
 * OB-288 wave 3 (WF-13 · M20-FR-02/03/04 · M21-FR-02 · OB-303 · OB-314 · D08-FR-03 · A04 · A05): the customer's own commerce
 * on the shop — each answered only by the shop's 2xx; signed out, offline or refused, nothing changes and the answer says which.
 */
export interface CommerceShop {
  /** WF-13: the coupon the customer typed (checked on the phone first); '' clears it. */
  setCoupon(code: string): { readonly ok: boolean };
  coupon(): string | undefined;
  /** WF-13: the shop's price for the basket as it stands — the till's offers and the coupon, the fee, what to pay, the points. */
  quote(): Promise<MineOutcome<ShopQuote>>;
  /** M21-FR-02: keep the basket on the shop while signed in (the abandoned-basket journey reads it — sent only if switched on). */
  holdCart(): Promise<MineOutcome<unknown>>;
  /** OB-303: my repeat orders; start one from the basket; pause, resume or cancel one. */
  repeatOrders(): Promise<MineOutcome<unknown>>;
  startRepeatOrder(form: Omit<RepeatOrderForm, 'lines' | 'locationId' | 'location'>): Promise<MineOutcome<unknown> | { readonly ok: false; readonly refusal: 'form'; readonly why: RepeatOrderWhy }>;
  changeRepeatOrder(subscriptionId: string, change: 'pause' | 'resume' | 'cancel'): Promise<MineOutcome<unknown>>;
  /** M20-FR-04: my saved addresses (a label and the location to about 100 m), and "remove saved payment" (nothing is saved). */
  addresses(): Promise<MineOutcome<unknown>>;
  saveAddress(label: string, landmark: string): Promise<MineOutcome<unknown> | { readonly ok: false; readonly refusal: 'no_location' }>;
  useAddress(location: { readonly lat: number; readonly lon: number }): void;
  removeAddress(addressId: string): Promise<MineOutcome<unknown>>;
  paymentMethods(): Promise<MineOutcome<unknown>>;
  /** M21-FR-02: an occasion I give with my yes, and remove in one tap. */
  occasions(): Promise<MineOutcome<unknown>>;
  giveOccasion(kind: 'birthday' | 'anniversary', monthDay: string, consent: boolean): Promise<MineOutcome<unknown>>;
  removeOccasion(occasionId: string): Promise<MineOutcome<unknown>>;
  /** A05: an answer to a chosen question, from the shop's own records, with the notice; typed questions go to a person. */
  help(topic: string, orderId?: string): Promise<MineOutcome<unknown>>;
  /** A04 · AI-NFR-11 (OB-314): in-stock alternatives with the AI notice; "bought before" only with my opt-in. */
  suggestions(productId?: string): Promise<MineOutcome<unknown>>;
  setAiPersonalisation(on: boolean): Promise<PrivacyOutcome>;
  /** M20-FR-02: "goes well with" — from what customers bought together; my history only with my yes. */
  recommendations(productId: string): Promise<MineOutcome<unknown>>;
  /** D08-FR-03 · FUL-14: what the shop does when something I ordered is out. */
  setSubstitution(preference: string): Promise<MineOutcome<unknown>>;
  /** The order the shop holds for this basket, if any. */
  heldOrderId(): string | undefined;
  /**
   * OB-294 · D08-FR-05: my delivery order's hand-over, as head office gives it — its 4-digit code (only my app can read it)
   * and the driver's last stamped stop with an estimate. Asked on a tap, never on a timer; a collection has no code.
   */
  handover(orderId: string): Promise<MineOutcome<{ readonly delivery: false } | { readonly delivery: true; readonly code: unknown; readonly eta: unknown }>>;
  /** OB-351 · M17-FR-02: my referral code, the rewards ("not set" until the owner enters them) and my referrals. */
  referral(): Promise<MineOutcome<unknown>>;
  /** OB-351: I was referred — the code a friend gave me (checked on the phone first). */
  claimReferral(code: string): Promise<MineOutcome<unknown> | { readonly ok: false; readonly refusal: 'form'; readonly why: 'bad_referral_code' }>;
  /** OB-350: the shop's price for the scan-and-go basket (the till's offers engine) — a what-if, nothing kept. */
  scanQuote(lines: readonly { readonly productId: string; readonly quantityMinor: number }[]): Promise<MineOutcome<ShopQuote>>;
  /** OB-350: hand the scan-and-go basket to head office for a till lane — the answer carries the six-digit code. */
  scanHand(basketId: string, lines: readonly { readonly productId: string; readonly quantityMinor: number }[]): Promise<MineOutcome<unknown>>;
  /** OB-350: my held scan-and-go baskets, and which till took each. */
  scanBaskets(): Promise<MineOutcome<unknown>>;
}

/**
 * R4 Lane 2 (B23 · D-28 · WF-16 · M20-FR-04 · D01-FR-06): reads and writes about the online store, ON THE SHOP — each
 * answered only by the shop's 2xx; signed out, offline or refused, nothing changes and the answer says which.
 */
export interface OnlineShop {
  /** Every duty for every product, before payment (B23), with stars and whether there is an image. */
  listing(): Promise<MineOutcome<unknown>>;
  /** A product's image from the shop's own server (OB-215), as a data address the page can show; none → refused. */
  image(productId: string): Promise<MineOutcome<string>>;
  receiptChoice(): Promise<MineOutcome<unknown>>;
  setReceipts(on: boolean): Promise<MineOutcome<boolean>>;
  receipts(): Promise<MineOutcome<unknown>>;
  rate(productId: string, stars: number): Promise<MineOutcome<unknown>>;
  myRatings(): Promise<MineOutcome<unknown>>;
  returns(): Promise<MineOutcome<unknown>>;
  returnPolicy(): Promise<MineOutcome<unknown>>;
}

/** Why a call about my own records did not happen — the view words each one, in English and Tamil. */
export type MineRefusal = 'not_signed_in' | 'no_road_to_the_shop' | 'not_saved_no_connection' | 'signed_out' | 'the_shop_could_not_answer' | 'the_shop_refused';
export type MineOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: MineRefusal; readonly shopSaid?: string };
export interface MyCase {
  readonly caseId: string; readonly kind: string; readonly state: string; readonly openedAt: string; readonly orderRef?: string;
  readonly replies: readonly { readonly text: string; readonly at: string; readonly channel: string }[];
  readonly returnRequest?: { readonly requestId: string; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[] };
}
export interface MyShop {
  favourites(): Promise<MineOutcome<readonly string[]>>;
  setFavourite(productId: string, favourite: boolean): Promise<MineOutcome<boolean>>;
  lists(): Promise<MineOutcome<readonly { readonly listId: string; readonly name: string; readonly items: readonly { readonly productId: string; readonly quantityMinor: number }[] }[]>>;
  /** Save the basket as it stands as a named list. */
  saveBasketAsList(name: string): Promise<MineOutcome<string>>;
  /** Put a saved list's items in the basket (the basket must then be checked again). */
  addListToBasket(items: readonly { readonly productId: string; readonly quantityMinor: number }[]): SessionState;
  complain(summary: string, orderRef?: string): Promise<MineOutcome<string>>;
  requestReturn(orderId: string, lines: readonly { readonly productId: string; readonly quantityMinor: number }[], reason: string): Promise<MineOutcome<string>>;
  cases(): Promise<MineOutcome<readonly MyCase[]>>;
  /**
   * OB-77 (owner, 12 Oct 2026): where my order is, as the SHOP holds it — the order's state and the driver's delivery status
   * with its as-of time (`delivery` is null until a driver has recorded a step). Read only; nothing is saved.
   */
  order(orderId: string): Promise<MineOutcome<MyOrderTracking>>;
}

/** OB-77: my order as the shop reads it back — the driver's status is a code the screen words in English or Tamil. */
export interface MyOrderTracking {
  readonly orderId: string;
  readonly state: string;
  readonly tellTheCustomer: string;
  readonly delivery: {
    readonly status: string; readonly asOf: string; readonly asOfMinutesAgo: number; readonly stale: boolean; readonly final: boolean; readonly tellTheCustomer: string;
  } | null;
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
  // WF-13: the coupon the customer typed, and the shop's last quote (good only for the basket it was asked for).
  let couponCode: string | undefined;

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
      raiseRequest({ requestId: 'check', tenantId: data?.tenantId ?? 'tenant', customerRef: 'self', kind, at, slaDays: PUBLISHED_RESPONSE_SLA_DAYS }); // R3 C5 · OB-195: always 15
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

    mine: {
      favourites: async () => {
        const a = await mineCall({ method: 'GET', path: 'favourites' });
        return a.ok ? { ok: true, value: ((a.body as { favourites?: { productId: string }[] }).favourites ?? []).map((f) => f.productId) } : a;
      },
      setFavourite: async (productId, favourite) => {
        const a = await mineCall({ method: 'POST', path: `favourites/${encodeURIComponent(productId)}`, body: { favourite }, idempotencyKey: `fav-${productId}-${favourite}-${nextId()}` });
        return a.ok ? { ok: true, value: favourite } : a;
      },
      lists: async () => {
        const a = await mineCall({ method: 'GET', path: 'lists' });
        return a.ok ? { ok: true, value: (a.body as { lists?: { listId: string; name: string; items: { productId: string; quantityMinor: number }[] }[] }).lists ?? [] } : a;
      },
      saveBasketAsList: async (name) => {
        const listId = `l-${nextId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const items = state.lines.filter((l) => l.quantityMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
        const a = await mineCall({ method: 'POST', path: `lists/${listId}`, body: { name, items }, idempotencyKey: `list-${listId}` });
        return a.ok ? { ok: true, value: listId } : a;
      },
      addListToBasket: (items) => {
        let next = state;
        for (const i of items) next = setLine(next, { productId: i.productId, quantityMinor: (next.lines.find((l) => l.productId === i.productId)?.quantityMinor ?? 0) + i.quantityMinor });
        return keep(next);
      },
      complain: async (summary, orderRef) => {
        const id = `c-${nextId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const a = await mineCall({ method: 'POST', path: `complaints/${id}`, body: { summary, ...(orderRef === undefined ? {} : { orderRef }) }, idempotencyKey: `complaint-${id}` });
        return a.ok ? { ok: true, value: String((a.body as { caseId?: unknown }).caseId ?? id) } : a;
      },
      requestReturn: async (orderId, lines, reason) => {
        // R4 · WF-16: an online return after delivery — judged by the window for each product's category (OB-213).
        const id = `r-${nextId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const a = await mineCall({ method: 'POST', path: `orders/${encodeURIComponent(orderId)}/online-returns/${id}`, body: { lines, reason }, idempotencyKey: `return-${id}` });
        return a.ok ? { ok: true, value: id } : a;
      },
      cases: async () => {
        const a = await mineCall({ method: 'GET', path: 'cases' });
        return a.ok ? { ok: true, value: (a.body as { cases?: MyCase[] }).cases ?? [] } : a;
      },
      order: async (orderId) => {
        if (token === undefined) return { ok: false, refusal: 'not_signed_in' };
        if (transport?.readOrder === undefined) return { ok: false, refusal: 'no_road_to_the_shop' };
        const answer = await transport.readOrder({ orderId, token });
        if (!answer.reached) return { ok: false, refusal: 'not_saved_no_connection' };
        if (answer.status === 401) { token = undefined; return { ok: false, refusal: 'signed_out' }; }
        if (answer.status >= 500) return { ok: false, refusal: 'the_shop_could_not_answer' };
        if (answer.status !== 200) {
          const err = (answer.body as { error?: { whatHappened?: unknown } } | undefined)?.error;
          return { ok: false, refusal: 'the_shop_refused', ...(typeof err?.whatHappened === 'string' ? { shopSaid: err.whatHappened } : {}) };
        }
        const b = answer.body as Partial<MyOrderTracking>;
        return { ok: true, value: { orderId: String(b.orderId ?? orderId), state: String(b.state ?? ''), tellTheCustomer: String(b.tellTheCustomer ?? ''), delivery: b.delivery ?? null } };
      },
    },

    // ── R4 Lane 2 (begin): the online store, read and written on the shop as me ──
    online: {
      listing: async () => { const a = await storefrontCall('listing'); return a.ok ? { ok: true, value: a.body } : a; },
      image: async (productId) => {
        const a = await storefrontCall(`products/${encodeURIComponent(productId)}/image`);
        if (!a.ok) return a;
        const b = a.body as { mediaType?: unknown; contentBase64?: unknown };
        // Only the three photo types the shop keeps are ever turned into an address the page shows (OB-215).
        if ((b.mediaType !== 'image/jpeg' && b.mediaType !== 'image/png' && b.mediaType !== 'image/webp') || typeof b.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.contentBase64)) return { ok: false, refusal: 'the_shop_refused' };
        return { ok: true, value: `data:${b.mediaType};base64,${b.contentBase64}` };
      },
      receiptChoice: async () => { const a = await mineCall({ method: 'GET', path: 'receipts/choice' }); return a.ok ? { ok: true, value: a.body } : a; },
      setReceipts: async (on) => {
        const a = await mineCall({ method: 'POST', path: 'receipts/choice', body: { on }, idempotencyKey: `receipts-${on}-${nextId()}` });
        return a.ok ? { ok: true, value: (a.body as { on?: unknown }).on === true } : a;
      },
      receipts: async () => { const a = await mineCall({ method: 'GET', path: 'receipts' }); return a.ok ? { ok: true, value: a.body } : a; },
      rate: async (productId, stars) => {
        const a = await mineCall({ method: 'POST', path: `ratings/${encodeURIComponent(productId)}`, body: { stars }, idempotencyKey: `rate-${productId}-${stars}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      myRatings: async () => { const a = await mineCall({ method: 'GET', path: 'ratings' }); return a.ok ? { ok: true, value: a.body } : a; },
      returns: async () => { const a = await mineCall({ method: 'GET', path: 'online-returns' }); return a.ok ? { ok: true, value: a.body } : a; },
      returnPolicy: async () => { const a = await mineCall({ method: 'GET', path: 'return-policy' }); return a.ok ? { ok: true, value: a.body } : a; },
    },
    // ── R4 Lane 2 (end) ──

    // ── OB-288 wave 3 (begin) ──
    commerce: {
      setCoupon: (code) => {
        const c = code.trim();
        if (c === '') { couponCode = undefined; return { ok: true }; }
        if (!COUPON_CODE.test(c)) return { ok: false };
        couponCode = c;
        return { ok: true };
      },
      coupon: () => couponCode,
      quote: async () => {
        const a = await shopQuote();
        return a.ok ? { ok: true, value: a.body as ShopQuote } : a;
      },
      holdCart: async () => {
        const lines = state.lines.filter((l) => l.quantityMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
        const a = await commerceCall({ method: 'PUT', path: 'me/cart', body: { lines }, idempotencyKey: `cart-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      repeatOrders: async () => { const a = await commerceCall({ method: 'GET', path: 'me/subscriptions' }); return a.ok ? { ok: true, value: a.body } : a; },
      startRepeatOrder: async (form) => {
        const built = repeatOrderBody({ ...form, lines: state.lines, locationId: data?.locationId, ...(deliveryLocation === undefined ? {} : { location: deliveryLocation }) });
        if (!built.ok) return { ok: false, refusal: 'form', why: built.why };
        const id = `sub-${nextId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
        const a = await commerceCall({ method: 'POST', path: `me/subscriptions/${id}`, body: built.body, idempotencyKey: `subscription-${id}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      changeRepeatOrder: async (subscriptionId, change) => {
        const a = await commerceCall({ method: 'POST', path: `me/subscriptions/${encodeURIComponent(subscriptionId)}/${change}`, body: {}, idempotencyKey: `subscription-${subscriptionId}-${change}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      addresses: async () => { const a = await commerceCall({ method: 'GET', path: 'me/addresses' }); return a.ok ? { ok: true, value: a.body } : a; },
      saveAddress: async (label, landmark) => {
        if (deliveryLocation === undefined) return { ok: false, refusal: 'no_location' };
        const id = `a-${nextId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
        const a = await commerceCall({ method: 'POST', path: `me/addresses/${id}`, body: { label, location: deliveryLocation, ...(landmark.trim() === '' ? {} : { landmark }) }, idempotencyKey: `address-${id}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      useAddress: (location) => { deliveryLocation = { lat: location.lat, lon: location.lon }; },
      removeAddress: async (addressId) => {
        const a = await commerceCall({ method: 'POST', path: `me/addresses/${encodeURIComponent(addressId)}/remove`, body: {}, idempotencyKey: `address-remove-${addressId}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      paymentMethods: async () => { const a = await commerceCall({ method: 'GET', path: 'me/payment-methods' }); return a.ok ? { ok: true, value: a.body } : a; },
      occasions: async () => { const a = await commerceCall({ method: 'GET', path: 'me/occasions' }); return a.ok ? { ok: true, value: a.body } : a; },
      giveOccasion: async (kind, monthDay, consent) => {
        const a = await commerceCall({ method: 'POST', path: `me/occasions/${kind}`, body: { kind, monthDay, consent }, idempotencyKey: `occasion-${kind}-${monthDay}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      removeOccasion: async (occasionId) => {
        const a = await commerceCall({ method: 'POST', path: `me/occasions/${encodeURIComponent(occasionId)}/remove`, body: {}, idempotencyKey: `occasion-remove-${occasionId}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      help: async (topic, orderId) => {
        const a = await commerceCall({ method: 'POST', path: 'me/help/answers', body: { topic, ...(orderId === undefined ? {} : { orderId }) }, idempotencyKey: `help-${topic}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      suggestions: async (productId) => {
        const q = `locationId=${encodeURIComponent(data?.locationId ?? '')}${productId === undefined ? '' : `&productId=${encodeURIComponent(productId)}`}`;
        const a = await commerceCall({ method: 'GET', path: `me/ai-suggestions?${q}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      setAiPersonalisation: async (on) => {
        // OB-314: an explicit opt-in, the same one switch both ways — the purpose is suggestions in the app, not messages.
        const answer = await privacyCall({ method: 'POST', path: '/consent', body: { purpose: 'ai_personalisation', channel: 'push', given: on }, idempotencyKey: `consent-ai-${on ? 'on' : 'off'}-${nextId()}` });
        if (!answer.ok) return answer;
        const b = answer.body as { tellTheCustomer?: unknown };
        return { ok: true, tellTheCustomer: typeof b.tellTheCustomer === 'string' ? b.tellTheCustomer : 'Saved.' };
      },
      recommendations: async (productId) => {
        const a = await commerceCall({ method: 'GET', path: `storefront/recommendations?productId=${encodeURIComponent(productId)}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      setSubstitution: async (preference) => {
        const a = await commerceCall({ method: 'PUT', path: 'storefront/substitution-preferences', body: { rules: { preference } }, idempotencyKey: `substitution-${preference}-${nextId()}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      heldOrderId: () => held?.orderId,
      handover: async (orderId) => {
        if (chosenFulfilment() === 'pickup') return { ok: true, value: { delivery: false } };
        const id = encodeURIComponent(orderId);
        const code = await commerceCall({ method: 'GET', path: `storefront/orders/${id}/delivery-code` });
        if (!code.ok) return code;
        const eta = await commerceCall({ method: 'GET', path: `storefront/orders/${id}/delivery-eta` });
        // The code stands on its own: an ETA the shop could not give reads "not given yet", never a guess.
        return { ok: true, value: { delivery: true, code: code.body, eta: eta.ok ? eta.body : null } };
      },
      referral: async () => { const a = await commerceCall({ method: 'GET', path: 'me/referral' }); return a.ok ? { ok: true, value: a.body } : a; },
      claimReferral: async (code) => {
        const c = readReferralCode(code);
        if (c === undefined) return { ok: false, refusal: 'form', why: 'bad_referral_code' };
        const a = await commerceCall({ method: 'POST', path: 'me/referral/claim', body: { code: c }, idempotencyKey: `referral-claim-${c}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      scanQuote: async (lines) => {
        if (lines.length === 0) return { ok: false, refusal: 'the_shop_refused', shopSaid: 'Your scan-and-go basket is empty.' };
        // No fulfilment: nothing is delivered — the till's offers and the coupon engine, the shelf prices, no fee.
        const a = await commerceCall({ method: 'POST', path: 'storefront/cart/quote', body: { lines }, idempotencyKey: `sg-quote-${nextId()}` });
        return a.ok ? { ok: true, value: a.body as ShopQuote } : a;
      },
      scanHand: async (basketId, lines) => {
        const a = await commerceCall({ method: 'POST', path: `storefront/scan-and-go/baskets/${encodeURIComponent(basketId)}`, body: { lines }, idempotencyKey: `sg-hand-${basketId}` });
        return a.ok ? { ok: true, value: a.body } : a;
      },
      scanBaskets: async () => { const a = await commerceCall({ method: 'GET', path: 'storefront/scan-and-go/baskets' }); return a.ok ? { ok: true, value: a.body } : a; },
    },
    // ── OB-288 wave 3 (end) ──
  };

  // ── OB-288 wave 3 (begin) ──
  /** The fulfilment the chosen slot implies (FUL-03). */
  function chosenFulfilment(): 'delivery' | 'pickup' | undefined {
    return (data?.slots ?? []).find((sl) => sl.slotId === state.slotId)?.kind;
  }
  /** WF-13: the shop's own price for the basket as it stands now, with the coupon. */
  async function shopQuote(): Promise<{ ok: true; body: unknown } | { ok: false; refusal: MineRefusal; shopSaid?: string }> {
    const lines = state.lines.filter((l) => l.quantityMinor > 0).map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor }));
    if (lines.length === 0) return { ok: false, refusal: 'the_shop_refused', shopSaid: 'Your basket is empty.' };
    const fulfilment = chosenFulfilment();
    return commerceCall({ method: 'POST', path: 'storefront/cart/quote', body: { lines, ...(fulfilment === undefined ? {} : { fulfilment }), ...(couponCode === undefined ? {} : { couponCode }) }, idempotencyKey: `quote-${basketKey(lines, fulfilment, couponCode).length}-${nextId()}` });
  }
  /** One commerce call as me, read honestly — saved only on the shop's 2xx, and why not otherwise. */
  async function commerceCall(call: Omit<ShopCommerceRequest, 'token'>): Promise<{ ok: true; body: unknown } | { ok: false; refusal: MineRefusal; shopSaid?: string }> {
    if (token === undefined) return { ok: false, refusal: 'not_signed_in' };
    if (transport?.commerce === undefined) return { ok: false, refusal: 'no_road_to_the_shop' };
    const answer = await transport.commerce({ token, ...call });
    if (!answer.reached) return { ok: false, refusal: 'not_saved_no_connection' };
    if (answer.status === 200 || answer.status === 201) return { ok: true, body: answer.body };
    if (answer.status === 401) { token = undefined; return { ok: false, refusal: 'signed_out' }; }
    if (answer.status >= 500) return { ok: false, refusal: 'the_shop_could_not_answer' };
    const err = (answer.body as { error?: { whatHappened?: unknown } } | undefined)?.error;
    return { ok: false, refusal: 'the_shop_refused', ...(typeof err?.whatHappened === 'string' ? { shopSaid: err.whatHappened } : {}) };
  }
  // ── OB-288 wave 3 (end) ──

  // ── R4 Lane 2 (begin) ──
  /** A read of the online store as me — the same honest answers as `mineCall`. */
  async function storefrontCall(path: 'listing' | 'ratings' | `products/${string}/image`): Promise<{ ok: true; body: unknown } | { ok: false; refusal: MineRefusal; shopSaid?: string }> {
    if (token === undefined) return { ok: false, refusal: 'not_signed_in' };
    if (transport?.storefront === undefined) return { ok: false, refusal: 'no_road_to_the_shop' };
    const answer = await transport.storefront({ token, path });
    if (!answer.reached) return { ok: false, refusal: 'not_saved_no_connection' };
    if (answer.status === 200) return { ok: true, body: answer.body };
    if (answer.status === 401) { token = undefined; return { ok: false, refusal: 'signed_out' }; }
    if (answer.status >= 500) return { ok: false, refusal: 'the_shop_could_not_answer' };
    const err = (answer.body as { error?: { whatHappened?: unknown } } | undefined)?.error;
    return { ok: false, refusal: 'the_shop_refused', ...(typeof err?.whatHappened === 'string' ? { shopSaid: err.whatHappened } : {}) };
  }
  // ── R4 Lane 2 (end) ──

  /** Round 8: one call about my own records, read honestly — saved only on the shop's 2xx, and why not otherwise. */
  async function mineCall(call: Omit<ShopMineRequest, 'token'>): Promise<{ ok: true; body: unknown } | { ok: false; refusal: MineRefusal; shopSaid?: string }> {
    if (token === undefined) return { ok: false, refusal: 'not_signed_in' };
    if (transport?.mine === undefined) return { ok: false, refusal: 'no_road_to_the_shop' };
    const answer = await transport.mine({ token, ...call });
    if (!answer.reached) return { ok: false, refusal: 'not_saved_no_connection' };
    if (answer.status === 200 || answer.status === 201) return { ok: true, body: answer.body };
    if (answer.status === 401) { token = undefined; return { ok: false, refusal: 'signed_out' }; }
    if (answer.status >= 500) return { ok: false, refusal: 'the_shop_could_not_answer' };
    const err = (answer.body as { error?: { whatHappened?: unknown } } | undefined)?.error;
    return { ok: false, refusal: 'the_shop_refused', ...(typeof err?.whatHappened === 'string' ? { shopSaid: err.whatHappened } : {}) };
  }

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

    // 2. The real thing. The amount is the SHOP's price for this basket (WF-13: the till's offers and the coupon, then
    //    the fee), asked for now; with no answer it is the session's own payable (items + fee) — and a difference is the
    //    shop's to flag ("not taken as paid; a person must look"), never silently taken.
    let payable = dry.state.order?.payableMinor ?? 0;
    if (transport.commerce !== undefined) {
      const q = await shopQuote();
      const body = q.ok ? (q.body as ShopQuote) : undefined;
      if (body?.priced === true && typeof body.payableMinor === 'number') payable = body.payableMinor;
    }
    const chosen = (data?.slots ?? []).find((sl) => sl.slotId === state.slotId);
    const slotKind = chosen?.kind;
    const answer = await transport.placeOrder({
      orderId, token, locationId,
      lines: state.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })),
      payment: { providerRef, amountMinor: payable, result },
      // The shop quotes its own delivery fee for a delivery (FUL-03).
      ...(slotKind === undefined ? {} : { fulfilment: slotKind }),
      // …and checks the slot and the address against its own record (FUL-03) — what the app saw is only a view.
      ...(chosen === undefined || slotKind !== 'delivery' ? {} : { deliverySlot: { startsAt: chosen.startsAt, endsAt: chosen.endsAt } }),
      ...(slotKind !== 'delivery' || deliveryLocation === undefined ? {} : { deliveryLocation }),
      ...(couponCode === undefined ? {} : { couponCode }),
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
  /** Round 8 (D08-FR-02): a speech engine, when this device was given one (none is chosen yet), and the tested rule
   *  that turns what it heard into search words. */
  shopVoice?: VoiceSearchPort;
  shopVoiceQuery?: typeof voiceQuery;
  /** R4 · D08: a browser test's stand-in engine (never set by the product). */
  shopVoiceStandIn?: VoiceSearchPort;
  /** OB-322: the customer's own voice switch, kept on this phone. */
  shopVoiceSwitch?: { readonly off: () => boolean; readonly set: (on: boolean) => boolean; readonly phoneCanListen: () => boolean };
  /** OB-288 wave 3: the tested rules the commerce screens show (customer-commerce.ts). */
  shopCommerceRules?: { readonly quoteRows: typeof quoteRows; readonly deliveryHandover: typeof deliveryHandover; readonly helpTopics: typeof HELP_TOPICS; readonly substitutionChoices: typeof SUBSTITUTION_CHOICES; readonly readReferralCode: typeof readReferralCode; readonly referralWhy: typeof referralWhy };
  /** OB-350: the scan-and-go basket on this phone (scan-and-go.ts) and the lines it sends — ids and counts only. */
  shopScanAndGo?: { readonly basket: ScanAndGo; readonly linesForTheShop: typeof linesForTheShop };
  /** D08-FR-02: the camera barcode rule (the page owns the camera; these decide what was read). */
  shopBarcode?: { readonly readScan: typeof readScan; readonly scanFrames: typeof scanFrames; readonly supported: () => Promise<boolean> };
  /** A browser test's stand-in barcode reader (never set by the product). */
  shopBarcodeStandIn?: BarcodeReader;
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  BarcodeDetector?: { getSupportedFormats?: () => Promise<readonly string[]> };
  navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } };
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
  browserWindow.shopVoiceQuery = voiceQuery;
  // OB-322: voice search through the phone's built-in recogniser, where it has one, and the customer's own switch to turn
  // it off (kept on this phone). A browser TEST may put its stand-in engine behind the link (`shopVoiceStandIn`, set
  // before this bundle runs); nothing in the product ever sets it.
  const standIn = browserWindow.shopVoiceStandIn;
  const voiceSwitch = customerVoiceSwitch(storage);
  const recogniser = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
  const engine = standIn ?? builtInRecogniser(recogniser);
  browserWindow.shopVoiceSwitch = { ...voiceSwitch, phoneCanListen: () => VOICE_SEARCH_SWITCHED_ON && engine.available() };
  browserWindow.shopVoice = voiceSearchLink({ switchedOn: VOICE_SEARCH_SWITCHED_ON, engine, offByCustomer: voiceSwitch.off });
  browserWindow.shopCommerceRules = { quoteRows, deliveryHandover, helpTopics: HELP_TOPICS, substitutionChoices: SUBSTITUTION_CHOICES, readReferralCode, referralWhy };
  // OB-350: scan-and-go — the basket is built from the shop's own list on this phone and kept here (a convenience).
  const data = browserWindow.shopData as { products?: readonly ScanProduct[] } | undefined;
  browserWindow.shopScanAndGo = {
    basket: createScanAndGo({ products: () => data?.products ?? [], newBasketId: () => `sg-${randomRequestId()}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60), storage, key: `sre.shop.scan-and-go.${who}` }),
    linesForTheShop,
  };
  // D08-FR-02: the camera barcode — the phone's own reader; without one, the typed number always works.
  const win = browserWindow;
  browserWindow.shopBarcode = { readScan, scanFrames, supported: async () => (win.shopBarcodeStandIn !== undefined ? true : scanSupported(win)) };
}
