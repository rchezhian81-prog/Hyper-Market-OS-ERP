// The product-publish DELIVERY step (ADR-0013 slice 2, M03-FR-01/03, P-04 · P-08, hard rule #6).
//
// This is the "the signed-in operator delivers it, as themselves" action from ADR-0013. It takes the queued
// publish commands, classifies them through the review-queue model (`product-publish-queue.ts`) against the
// operator's CURRENT context, and delivers ONLY the `ready` ones — each POSTed to the idempotent cloud route
// `POST /v1/catalogue/products/:productId/publish` **under the operator's own session** (an injected port
// that carries their auth, never a service token — ADR-0013). Nothing else is ever sent, and there is no
// auto-publish: this runs only when a person triggers it.
//
// Each delivery attempt transitions the durable outbox honestly (P-08, hard rule #6):
//   • accepted (2xx, or 409 because the idempotent route already had it) → acknowledged (done);
//   • retryable (a timeout, a 5xx, or a transient 4xx like 429) → left pending, the attempt counted, so it
//     is tried again next time — a slow link never loses a publish;
//   • rejected (a permanent 4xx — the payload is bad or the operator is not authorised) → dead-lettered with
//     the status, visible for a person, never silently dropped.
//
// The POST body is the command's own payload (`{ product, categories, ... }`) and the idempotency key is the
// command's own key, so a retry cannot create a duplicate product (ADR-0013 control 7).

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { ProductPublishPayload } from './catalogue-publish-command';
import {
  summarizePublishQueue,
  type QueuedPublishItem, type PublishReviewContext,
} from './product-publish-queue';

/** How the delivery reads the cloud's answer — mirrors the edge transport's rule so the two agree. A 0
 *  status stands for a network/timeout failure (retryable — a lost link never condemns a publish). */
export function classifyPublishResponse(status: number): 'accepted' | 'retryable' | 'rejected' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 409) return 'accepted'; // the idempotent route already had it — success, not a duplicate
  if (status === 0 || status >= 500) return 'retryable';
  if (status === 408 || status === 425 || status === 429 || status === 401) return 'retryable';
  if (status >= 400) return 'rejected';
  return 'retryable';
}

/**
 * Operator-authenticated POST of one publish command to its idempotent cloud route. The implementation
 * carries the operator's session auth and the command's idempotency key, and returns the HTTP status (or 0
 * for a network/timeout error). Injected, so delivery is tested without a network — and so this file, like
 * every screen, never opens a socket itself.
 */
export interface PublishDeliveryPort {
  post(payload: ProductPublishPayload, idempotencyKey: string): Promise<number>;
}

export type PublishDeliveryOutcome = 'delivered' | 'held' | 'refused';

export interface PublishDeliveryReport {
  readonly delivered: readonly string[];
  readonly held: readonly string[];
  readonly refused: readonly string[];
  /** Keys the review classified as NOT deliverable now (approval_required/conflict/…): left untouched. */
  readonly skipped: readonly string[];
}

type PublishOutbox = SyncOutbox<string, ProductPublishPayload>;

/** Project a durable outbox item into the review-queue shape (ADR-0013 control 2 — the retained evidence;
 *  no tokens are ever in the queue, so none are read here). The tenant and creator come from the command. */
export function toQueuedPublishItem(item: {
  readonly key: string;
  readonly state: QueuedPublishItem['outboxState'];
  readonly event: { readonly occurredAt: string; readonly payload: ProductPublishPayload };
}): QueuedPublishItem {
  return {
    key: item.key,
    tenantId: item.event.payload.product.tenantId,
    createdBy: item.event.payload.requestedBy,
    createdAt: item.event.occurredAt,
    outboxState: item.state,
    // The command only ever queues a product that passed the tested compliance gate; the central boundary
    // re-checks regardless (ADR-0013 control 9), so a stale client verdict cannot publish a bad product.
    clientValid: true,
  };
}

/**
 * Deliver the `ready` product-publishes, as the signed-in operator. Classifies the outbox against the
 * operator's current context, sends only the ready ones through the injected operator-session port, and
 * transitions each on its result. Returns what was delivered, held for retry, refused, and skipped.
 *
 * There is NO auto-publish: a caller (an explicit operator action) invokes this; it never runs itself.
 */
export async function deliverReadyPublishes(
  outbox: PublishOutbox,
  ctx: PublishReviewContext,
  port: PublishDeliveryPort,
): Promise<PublishDeliveryReport> {
  const items = outbox.pending().map((i) => toQueuedPublishItem(i));
  const summary = summarizePublishQueue(items, ctx);
  const readySet = new Set(summary.readyKeys);

  const delivered: string[] = [];
  const held: string[] = [];
  const refused: string[] = [];

  // Only the ready keys — never anything the review did not clear (ADR-0013 control 6, 8).
  for (const key of summary.readyKeys) {
    const item = outbox.find(key);
    if (item === undefined) continue;
    const status = await port.post(item.event.payload, item.event.idempotencyKey);
    switch (classifyPublishResponse(status)) {
      case 'accepted':
        outbox.acknowledge(key);
        delivered.push(key);
        break;
      case 'retryable':
        outbox.recordFailure(key); // stays pending — tried again next time
        held.push(key);
        break;
      case 'rejected':
        outbox.deadLetter(key, `the publish was refused by the cloud (HTTP ${status}) — kept for review`);
        refused.push(key);
        break;
    }
  }

  const skipped = summary.rows.filter((r) => !readySet.has(r.item.key)).map((r) => r.item.key);
  return { delivered, held, refused, skipped };
}
