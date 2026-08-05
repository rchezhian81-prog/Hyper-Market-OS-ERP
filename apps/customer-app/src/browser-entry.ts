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
// thing that turns a prepared basket into a sent one.
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
  /** The purposes this tenant asks consent for. Choose-able, never hard-coded. */
  readonly consentPurposes?: readonly ConsentPurposeSpec[];
  readonly consent?: ConsentState;
  /** Days the tenant has to answer a data request. Per-tenant policy. */
  readonly privacySlaDays?: number;
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
  /** Send the order. `reachedTheShop` is the transport's answer and never this app's guess. */
  send(input: {
    readonly orderId: string;
    readonly providerRef: string;
    readonly result: 'authorised' | 'declined' | 'unknown';
    readonly reachedTheShop: boolean;
  }): ReturnType<typeof send>;
  /** What the order screen says afterwards. `payment_pending` reads as waiting, never as done. */
  statusLine(): string | null;
  /** The consent switches — one row, one toggle, same cost in both directions. */
  consent(): ReturnType<typeof consentControls>;
  setConsent(purpose: string, channel: string, granted: boolean): ReturnType<typeof setConsent>;
  /** The rights on offer, each marked with whether the law lets it be complete. */
  rights(): typeof RIGHTS_OFFERED;
  raise(kind: (typeof RIGHTS_OFFERED)[number]['kind'], at: string): ReturnType<typeof raiseRequest>;
}

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
): Shop | null {
  const products = data?.products;
  if (products === undefined || products.length === 0) return null;

  let state = basket.read() ?? newSession();
  const purposes = data?.consentPurposes ?? [];
  let consent: ConsentState = data?.consent ?? { grants: [] };

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

    send: (input) => {
      const result = send(state, {
        orderId: input.orderId,
        customerRef: data?.customerRef ?? 'guest',
        deliveryFeeMinor: data?.deliveryFeeMinor ?? 0,
        currentPackVersion: data?.packVersion ?? 0,
        // 10 km is the D08 default and it lives in the package, not here. An empty policy takes
        // the package's own defaults rather than a second copy of them drifting in this file.
        policy: data?.policy ?? {},
        storeLocation: data?.storeLocation ?? { lat: 0, lon: 0 },
        deliveryLocation: data?.deliveryLocation ?? { lat: 0, lon: 0 },
        // A provider token. The session refuses a card number outright rather than redacting it,
        // because redacting means it was held first (hard rule #3).
        // A declined or unanswered payment carries a REASON, not a reference — there is nothing
        // to reference. Keeping the shapes apart is what stops "unknown" being read as a token.
        payment: input.result === 'authorised'
          ? { result: 'authorised', providerRef: input.providerRef }
          : { result: input.result, reason: input.providerRef },
        reachedTheShop: input.reachedTheShop,
      });
      keep(result.state);
      return result;
    },

    statusLine: () => (state.order === undefined ? null : orderStatusLine(state.order)),

    consent: () => consentControls(consent, purposes),

    setConsent: (purpose, channel, granted) => {
      const change = setConsent(consent, purposes, { purpose, channel, granted });
      if (change.ok) consent = change.state;
      return change;
    },

    rights: () => RIGHTS_OFFERED,

    raise: (kind, at) => raiseRequest({
      requestId: nextId(),
      tenantId: data?.tenantId ?? 'tenant',
      customerRef: data?.customerRef ?? 'guest',
      kind,
      at,
      slaDays: data?.privacySlaDays ?? 30,
    }),
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
  let counter = 0;
  const shop = bootShop(browserWindow.shopData, basket, () => `DSR-${(counter += 1)}`);
  if (shop !== null) browserWindow.shop = shop;
}
