// Sync transport port (§31 / §30.2) — how the edge hands a locally-committed event
// to the cloud. The agent depends only on this interface, never on a concrete
// client, so the agent is fully testable offline and the real transport (HTTPS to
// the ingest API, or a durable broker publish) is a thin adapter at deployment.
//
// The result deliberately distinguishes three outcomes, because they demand
// different behaviour:
//   • accepted   — delivered (or already known: the receiver dedupes on the
//                  idempotency key, so a replay is accepted, never double-applied);
//   • retryable  — a transient failure (offline, timeout, 5xx): keep it queued and
//                  try again later. NEVER dropped;
//   • rejected   — a permanent failure (malformed, refused, a conflict the cloud
//                  will not resolve): it goes to the visible dead-letter queue as an
//                  exception for a human, never silently discarded (hard rule #6,
//                  and #10 — conflicts are exceptions, never last-write-wins).

import type { DomainEvent } from '../../../packages/contracts/src/event';

export type SendOutcome =
  | { readonly status: 'accepted' }
  | { readonly status: 'retryable'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string };

export interface SyncTransport {
  /**
   * Deliver one event to the cloud. Implementations MUST be safe to call more than
   * once with the same event — delivery is idempotent on `event.idempotencyKey`.
   */
  send(event: DomainEvent): Promise<SendOutcome>;
}
