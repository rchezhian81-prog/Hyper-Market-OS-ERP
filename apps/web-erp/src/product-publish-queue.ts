// The product-publish REVIEW QUEUE (ADR-0013, M03-FR-01/03, P-03 · P-04 · P-08, hard rule #10) — the
// deterministic core of "the signed-in operator delivers a queued product publish, as themselves".
//
// A product authored offline queues a `ProductPublishRequested` command (`catalogue-publish-command.ts`).
// This model turns that queue into a REVIEWED, RE-VALIDATED step rather than a blind drain: for each queued
// item it computes the state the operator sees — `pending`, `ready`, `validation_failed`, `approval_required`,
// `conflict`, `published`, or `permanently_refused` — from the operator's CURRENT authenticated context, and
// NEVER from the permissions captured when the item was queued (ADR-0013 controls 3, 5, 10). Publishing is a
// SEPARATE action a person takes on the `ready` items; nothing here publishes, and there is no auto-publish.
//
// The refusals that matter (P-08, no silent failure):
//   • a cross-tenant item — queued under a tenant the operator is not in — is refused outright, never
//     delivered under the wrong tenant (control 10, 13);
//   • an operator who does NOT currently hold the publish permission cannot publish — the item is routed for
//     someone who does (`approval_required`), never published under a stale grant (control 3, 10);
//   • an item whose ORIGINAL creator has since lost the permission, changed tenant, been suspended or left is
//     routed for reassignment/approval, never published silently as if by them (control 10);
//   • a bulk publish, or a sensitive-category item, needs a FRESH re-authentication (control 4).
//
// Pure and deterministic: the caller supplies the current context and the queued items; the model classifies.

import type { OutboxState } from '../../../packages/sync/src/outbox';

export type PublishQueueState =
  | 'pending'
  | 'ready'
  | 'validation_failed'
  | 'approval_required'
  | 'conflict'
  | 'published'
  | 'permanently_refused';

/** One queued product-publish, with the evidence retained at queue time (ADR-0013 control 2 — NO tokens). */
export interface QueuedPublishItem {
  readonly key: string;
  readonly tenantId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly device?: string;
  /** The outbox delivery state: pending → (acknowledged | dead_letter). */
  readonly outboxState: OutboxState;
  /** Did the product validate against the compliance rules when it was queued? (A client pre-check; the
   *  central boundary re-checks again — ADR-0013 control 9.) */
  readonly clientValid: boolean;
  /** A sensitive-category product (e.g. a controlled vertical) — publishing needs a fresh re-auth (control 4). */
  readonly sensitive?: boolean;
  /** The central boundary reported this item conflicts with a concurrent change — surfaced, never
   *  last-write-wins (control 11, hard rule #10). */
  readonly conflict?: boolean;
}

/** The operator's CURRENT authenticated context — re-read every time, never the queued snapshot (control 3). */
export interface PublishReviewContext {
  readonly userId: string;
  readonly tenantId: string;
  /** The permissions the operator holds RIGHT NOW. */
  readonly permissions: ReadonlySet<string>;
  /** Is there a live authenticated session? A publish needs one (control 3). */
  readonly sessionActive: boolean;
  /** Is the operator currently a member of `tenantId`? */
  readonly tenantMember: boolean;
  /** Age of the last MFA/re-auth in seconds, or undefined if none this session. */
  readonly mfaFreshSeconds?: number;
  /** Creators (by id) who have since lost the publish authority, changed tenant, been suspended or left —
   *  their queued items are routed, never published as if by them (control 10). */
  readonly revokedCreators?: ReadonlySet<string>;
  /** True when publishing this batch as a whole (bulk) — bulk needs a fresh re-auth (control 4). */
  readonly bulk?: boolean;
}

export const PUBLISH_PERMISSION = 'catalogue.pack.publish';
/** How recent an MFA/re-auth must be to release a bulk or sensitive publish. */
export const MFA_FRESH_LIMIT_SECONDS = 120;

const mfaFresh = (ctx: PublishReviewContext): boolean =>
  ctx.mfaFreshSeconds !== undefined && ctx.mfaFreshSeconds <= MFA_FRESH_LIMIT_SECONDS;

/**
 * Classify one queued item against the operator's CURRENT context. Terminal outbox states win first (an
 * acknowledged item is published; a dead-lettered one is permanently refused); otherwise the authorisation
 * and validation checks decide, re-evaluated from the live context every time.
 */
export function classifyPublishItem(item: QueuedPublishItem, ctx: PublishReviewContext): PublishQueueState {
  if (item.outboxState === 'acknowledged') return 'published';
  if (item.outboxState === 'dead_letter') return 'permanently_refused';
  // A cross-tenant item is refused outright — never delivered under the wrong tenant (control 10, 13).
  if (item.tenantId !== ctx.tenantId || !ctx.tenantMember) return 'permanently_refused';
  if (item.conflict === true) return 'conflict';
  // No live session, or the operator does not currently hold the publish authority → route it, never publish
  // under a stale grant (control 3, 10).
  if (!ctx.sessionActive || !ctx.permissions.has(PUBLISH_PERMISSION)) return 'approval_required';
  // The ORIGINAL creator has since lost the authority / left / moved tenant → route for reassignment (control 10).
  if (ctx.revokedCreators?.has(item.createdBy) === true) return 'approval_required';
  if (!item.clientValid) return 'validation_failed';
  // A bulk or sensitive publish needs a fresh re-authentication (control 4).
  if ((ctx.bulk === true || item.sensitive === true) && !mfaFresh(ctx)) return 'approval_required';
  return 'ready';
}

export interface PublishQueueRow {
  readonly item: QueuedPublishItem;
  readonly state: PublishQueueState;
}

export interface PublishQueueSummary {
  readonly rows: readonly PublishQueueRow[];
  readonly counts: Readonly<Record<PublishQueueState, number>>;
  /** The keys of the items that are safe to deliver now — nothing else may be published (control 6, 8). */
  readonly readyKeys: readonly string[];
}

const ZERO_COUNTS: Readonly<Record<PublishQueueState, number>> = Object.freeze({
  pending: 0, ready: 0, validation_failed: 0, approval_required: 0, conflict: 0, published: 0, permanently_refused: 0,
});

/** Classify the whole queue into an operator-visible review — rows, a per-state count, and the ready set. */
export function summarizePublishQueue(
  items: readonly QueuedPublishItem[],
  ctx: PublishReviewContext,
): PublishQueueSummary {
  const rows = items.map((item) => ({ item, state: classifyPublishItem(item, ctx) }));
  const counts: Record<PublishQueueState, number> = { ...ZERO_COUNTS };
  for (const row of rows) counts[row.state] += 1;
  const readyKeys = rows.filter((r) => r.state === 'ready').map((r) => r.item.key);
  return { rows, counts, readyKeys };
}
