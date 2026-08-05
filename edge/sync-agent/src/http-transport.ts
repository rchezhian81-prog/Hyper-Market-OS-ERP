// The transport that actually reaches the cloud — §31, §31.1, P-01, P-08, hard rules #1 #6 #10.
//
// `SyncTransport` has been a port with no implementation: "a thin adapter at deployment". Until
// this file, the store edge committed sales durably, queued them honestly, reported its unsent
// count truthfully — and had **nowhere to send them**. This is the wire.
//
// ── An event goes to the endpoint that would have handled it anyway ─────────
//
// There is deliberately **no generic ingest endpoint**. A sale posted to `/v1/ingest` would skip
// everything `POST /v1/sales` does — the price check against the published pack, the receipt-number
// clash, the future-dated commit, the whole exception path — and arrive in the ledger having been
// examined by nothing. A sale that syncs late is still a sale that needs looking at, so it goes
// through the same door as one that syncs immediately, and gets the same answers.
//
// An event type with no route is **rejected by name**, which sends it to the dead-letter queue for
// a person (hard rule #6). It is not dropped, and it is not posted somewhere generic in the hope
// that something downstream copes.
//
// ── The outcome mapping is the whole of the risk ────────────────────────────
//
// `retryable` and `rejected` look similar in code and could not be more different in the shop. An
// unsent sale wrongly marked `rejected` is dead-lettered — it stops being retried, and the money in
// the drawer has no record in the cloud until somebody works the queue. So:
//
//   • **A timeout is retryable, and it is the common case.** A shop on a rural line times out
//     several times a day. Nothing about a slow link says the sale was bad.
//   • **An ambiguous outcome is retryable, never accepted.** If we do not know whether it landed,
//     we send it again; the receiver dedupes on the idempotency key, so a duplicate delivery is
//     one effect (§31.1). Guessing "accepted" loses the sale silently, which is the one outcome
//     with no way back.
//   • **A 5xx is retryable** — the cloud is having a bad minute, not judging the payload.
//   • **A 4xx is permanent**, because retrying a malformed payload forever buries everything
//     queued behind it — with two exceptions below that are not what they look like.
//   • **408 and 429 are retryable.** They are 4xx by number and transient by meaning.
//   • **401 is retryable, 403 is rejected.** An expired token is renewed by the next deployment
//     restart or token refresh, so the sale should still be waiting when it is. A permission the
//     till does not hold will not appear by itself, and that needs a person.
//
// ── Two things this must never do ───────────────────────────────────────────
//
//   • **Never put the token in a message.** The reason string reaches the dead-letter queue, the
//     logs, and eventually a screenshot in a support thread (hard rule #4).
//   • **Never generate its own idempotency key.** The key is the event's, minted when the sale was
//     committed at the lane. A key minted per attempt makes every retry a new sale, and the server
//     doing everything right banks all of them.

import type { DomainEvent } from '../../../packages/contracts/src/event';
import type { SendOutcome, SyncTransport } from './transport';

/**
 * Where each event type goes. Explicit, and small on purpose.
 *
 * The alternative — deriving a path from the type name — is a rule nobody can read and a silent
 * 404 the first time a type is renamed.
 */
export const EVENT_ROUTES: Readonly<Record<string, string>> = {
  SaleCommitted: '/v1/sales',
  InventoryMoved: '/v1/inventory/movements',
  DeliveryAttempted: '/v1/delivery/attempts',
  ConsentRecorded: '/v1/customers/:customerId/consent',
};

/** Fill `:name` segments from the payload, so a route can address a thing. */
function pathFor(event: DomainEvent): string | undefined {
  const template = EVENT_ROUTES[event.type];
  if (template === undefined) return undefined;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  let path = template;
  for (const match of template.matchAll(/:(\w+)/g)) {
    const value = payload[match[1]!];
    if (typeof value !== 'string' || value === '') return undefined;
    path = path.replace(match[0], encodeURIComponent(value));
  }
  return path;
}

/** Statuses that are 4xx by number and transient by meaning. */
const TRANSIENT_4XX = new Set([401, 408, 425, 429]);

export function classify(status: number): SendOutcome['status'] {
  if (status >= 200 && status < 300) return 'accepted';
  // The receiver already had it. That is what an idempotent send is for, and it is a success.
  if (status === 409) return 'accepted';
  if (status >= 500) return 'retryable';
  if (TRANSIENT_4XX.has(status)) return 'retryable';
  if (status >= 400) return 'rejected';
  // 1xx and 3xx: nothing here follows a redirect, and neither is an answer.
  return 'retryable';
}

export interface HttpTransportOptions {
  /** The cloud API's base URL, e.g. `https://api.example.test`. */
  readonly baseUrl: string;
  /** Bearer token for this store. Read from configuration; never logged (hard rule #4). */
  readonly token: string;
  /** How long to wait before giving up on one send. A hung socket must not stall the drain. */
  readonly timeoutMs?: number;
  /** Injected so the agent stays testable without a network. */
  readonly fetch: typeof globalThis.fetch;
}

export function httpTransport(options: HttpTransportOptions): SyncTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    send: async (event: DomainEvent): Promise<SendOutcome> => {
      const path = pathFor(event);
      if (path === undefined) {
        return {
          status: 'rejected',
          reason: `no cloud endpoint is defined for a "${event.type}" event, so it cannot be delivered. It is kept for a person rather than dropped`,
        };
      }

      // Bounded, and cancelled rather than left hanging: an abandoned request holding a socket is
      // how one slow endpoint becomes a queue that never drains.
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

      try {
        const response = await options.fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.token}`,
            // The EVENT's key, minted when the sale was committed at the lane. A key minted per
            // attempt makes every retry a new sale.
            'idempotency-key': event.idempotencyKey,
          },
          body: JSON.stringify(event.payload),
          signal: controller.signal,
        });

        const outcome = classify(response.status);
        if (outcome === 'accepted') return { status: 'accepted' };
        return {
          status: outcome,
          // The status, not the body. A body can echo the request, and the request carries the
          // header we must never write down.
          reason: `the cloud answered ${response.status} for ${event.type}`,
        };
      } catch (e) {
        // Everything that lands here — timeout, DNS failure, refused connection, TLS problem — is
        // the link, not the payload. Retryable, always. This is the branch that decides whether a
        // shop on a rural line keeps its sales.
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          status: 'retryable',
          reason: aborted
            ? `no answer within ${timeoutMs}ms — the sale is still queued and will be sent again`
            : 'could not reach the cloud — the sale is still queued and will be sent again',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
