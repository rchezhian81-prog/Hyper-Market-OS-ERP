// The customer app's one road to the shop (M20-FR-03, §31 customer row).
//
// Until this file existed the app never spoke to the cloud: its "reached the shop" flag was the
// browser's own online flag, which is a guess about the network and says nothing about whether the
// shop has the order. This module is the transport whose answer `reachedTheShop` now IS — a POST of
// the reviewed basket to `POST /v1/storefront/orders/:orderId` carrying the customer's short-lived
// session token, and an honest reading of what came back.
//
// ── What the answer can be, and why the shapes are kept apart ────────────────
//
//   • **Reached, and the shop answered.** 201 or 200 (a retry of an order it already holds) means
//     the shop HAS the order — reserved and with the payment answer recorded. 401 means the session
//     has ended: the customer signs in again; the basket is kept. Any other 4xx is the shop saying
//     no in its own words (`whatHappened`), which the screen shows rather than paraphrasing. A 5xx is
//     the shop failing to answer properly: the order MAY have been saved, so the caller keeps the same
//     order id for the retry (the route is idempotent on it) and tells the customer nothing was
//     confirmed.
//   • **Did not reach.** No connection, a timeout, a network error. Nothing left the phone that the
//     shop acted on, so the basket is *prepared, not sent* — the model's `waiting_for_signal`.
//
// A card number never travels: the session refuses it before this module is called (hard rule #3),
// and the shop refuses it again at the door. The token is held in memory by the caller and appears
// here only as the bearer header of one request — never logged, never stored.

export type ShopPaymentResult = 'authorised' | 'declined' | 'unknown';

export interface ShopOrderRequest {
  readonly orderId: string;
  /** The customer's session token. In memory only; used once, as the bearer header. */
  readonly token: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
  /** The store that fulfils the order — the box tells the app which; the app never guesses one. */
  readonly locationId: string;
  readonly payment?: {
    readonly providerRef: string;
    readonly amountMinor: number;
    readonly result: ShopPaymentResult;
    readonly reason?: string;
  };
}

export type ShopAnswer =
  | { readonly reached: true; readonly status: number; readonly body: unknown }
  | { readonly reached: false; readonly why: 'no_connection' | 'timed_out' | 'network_error'; readonly detail: string };

export interface ShopTransport {
  placeOrder(request: ShopOrderRequest): Promise<ShopAnswer>;
}

/** What the shop's answer means for the customer's order. */
export type ShopVerdict =
  | {
    readonly kind: 'placed';
    readonly orderId: string;
    /** `true` when the shop already held this order — a retry that changed nothing. */
    readonly alreadyPlaced: boolean;
    readonly paymentState: string;
    readonly tellTheCustomer: string;
  }
  | { readonly kind: 'signed_out' }
  | { readonly kind: 'refused'; readonly code: string; readonly whatHappened: string }
  | { readonly kind: 'shop_could_not_answer'; readonly status: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Read the shop's answer without inventing anything it did not say. */
export function readShopAnswer(answer: { readonly status: number; readonly body: unknown }): ShopVerdict {
  const body = isObj(answer.body) ? answer.body : {};
  if (answer.status === 201 || answer.status === 200) {
    const payment = isObj(body['payment']) ? body['payment'] : {};
    return {
      kind: 'placed',
      orderId: typeof body['orderId'] === 'string' ? body['orderId'] : '',
      alreadyPlaced: body['alreadyPlaced'] === true,
      paymentState: typeof payment['state'] === 'string' ? payment['state'] : 'none',
      tellTheCustomer: typeof body['tellTheCustomer'] === 'string' ? body['tellTheCustomer'] : '',
    };
  }
  if (answer.status === 401) return { kind: 'signed_out' };
  if (answer.status >= 500) return { kind: 'shop_could_not_answer', status: answer.status };
  const error = isObj(body['error']) ? body['error'] : {};
  return {
    kind: 'refused',
    code: typeof error['code'] === 'string' ? error['code'] : `http_${answer.status}`,
    whatHappened: typeof error['whatHappened'] === 'string'
      ? error['whatHappened']
      : 'The shop did not accept this order and gave no reason it could show you.',
  };
}

/** The idempotency key for an order is the order itself: a retry is the same request, never a second order. */
export const orderIdempotencyKey = (orderId: string): string => `storefront-order-${orderId}`;

export interface HttpShopTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  /** Where the shop's API is. Empty (the default) means the same origin the app was served from. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** The device's own view of the network — consulted only to SKIP a request that cannot leave the phone. */
  readonly isOnline?: () => boolean;
}

/**
 * The HTTP transport. Relative by default: the app is served behind the same origin as the API
 * (the store's reverse proxy), so no cross-origin allowance is needed and the token goes only to
 * the host that served the page.
 */
export function httpShopTransport(options: HttpShopTransportOptions): ShopTransport {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    placeOrder: async (request) => {
      if (options.isOnline !== undefined && !options.isOnline()) {
        return { reached: false, why: 'no_connection', detail: 'this device reports no connection, so nothing was sent' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      try {
        const res = await options.fetch(`${base}/v1/storefront/orders/${encodeURIComponent(request.orderId)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.token}`,
            'idempotency-key': orderIdempotencyKey(request.orderId),
          },
          body: JSON.stringify({
            lines: request.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })),
            locationId: request.locationId,
            ...(request.payment === undefined ? {} : { payment: request.payment }),
          }),
          signal: controller.signal,
        });
        let body: unknown = undefined;
        try { body = await res.json(); } catch { body = undefined; }
        return { reached: true, status: res.status, body };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return aborted
          ? { reached: false, why: 'timed_out', detail: `the shop did not answer within ${timeoutMs}ms — nothing is confirmed` }
          : { reached: false, why: 'network_error', detail: 'the request could not reach the shop — nothing is confirmed' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
