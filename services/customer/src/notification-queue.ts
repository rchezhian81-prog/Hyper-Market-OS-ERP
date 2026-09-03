// API-06 Notification delivery queue (M31-FR-04) — the durable outbox behind the send-guard, on the live
// API over the tested `@sre/notifications` `NotificationQueue`.
//
// The guard (`POST /v1/notifications/can-send`) decides WHETHER a message may go (consent, suppression); this
// is the queue that carries the ones that may. A send is enqueued, marked delivered on success, or its
// failure recorded — and once it has failed `maxAttempts` times it moves to a VISIBLE dead-letter queue for a
// person to see. It is **never silently dropped** (hard rule #6), exactly like the sync outbox and the Tally
// connector: a notification that quietly vanishes is one a customer was promised and never got, and nobody
// knows.
//
// Event-sourced: each enqueue / delivery / failure / dead-letter is an append-only fact, and the current queue
// is the tested engine replayed over them — so the retry-then-dead-letter state machine is the engine's, run
// once, not a second copy here. Gated `notification.send.check` (the notification-pipeline permission).
//
// The transport that actually sends each pending item down a channel (SMS / WhatsApp / email / push) is a
// deployment step — an outbound network path, not a cloud endpoint. This is the durable queue it drains.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { NotificationQueue, type NotificationItem } from '../../../packages/notifications/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** One append-only fact about a queued notification. `change` says which; extra fields carry its detail. */
export interface NotificationQueueEvent {
  readonly id: string;
  readonly change: 'enqueued' | 'delivered' | 'failed' | 'dead_lettered';
  readonly at: string;
  readonly by: string;
  /** `enqueued` only — the channel it goes down. */
  readonly channel?: string;
  /** `failed` / `dead_lettered` only — why. */
  readonly reason?: string;
  /** `failed` only — attempts before dead-lettering (per-tenant policy). */
  readonly maxAttempts?: number;
}

export interface NotificationQueueDeps {
  /** The current queue — the tested engine replayed over the append-only log. */
  readonly queue: (tenantId: string) => Promise<NotificationQueue> | NotificationQueue;
  /** Append one queue fact. Idempotent on the key. */
  readonly record: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function notificationQueueRoutes(deps: NotificationQueueDeps): readonly Route[] {
  return [
    {
      // ENQUEUE a notification for delivery. Idempotent on its id — a re-enqueue returns the existing item.
      api: 'API-06', method: 'POST', path: '/v1/notifications/queue/:id',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['id'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['channel'])) {
          throw apiError(400, { code: 'enqueue_needs_a_channel', whatHappened: 'Queuing a notification needs the { channel } it goes down (e.g. sms, whatsapp, email, push).', wasItSaved: 'not_saved', nextSafeAction: 'Send the channel.' });
        }
        const existing = (await deps.queue(ctx.tenantId)).find(id);
        if (existing !== undefined) {
          return { status: 200, body: { id, state: existing.state, alreadyQueued: true } };
        }
        await deps.record(ctx.tenantId, { id, change: 'enqueued', by: ctx.userId, at: deps.now(), channel: (b['channel'] as string).trim() }, `notif-enqueue-${id}`);
        return { status: 201, body: { id, channel: (b['channel'] as string).trim(), state: 'pending' } };
      },
    },
    {
      // DELIVERED — the transport got it through. Idempotent; a delivery of a non-pending item is a no-op.
      api: 'API-06', method: 'POST', path: '/v1/notifications/queue/:id/delivered',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['id'] ?? '';
        const item = (await deps.queue(ctx.tenantId)).find(id);
        if (item === undefined) throw notFound(id);
        await deps.record(ctx.tenantId, { id, change: 'delivered', by: ctx.userId, at: deps.now() }, `notif-delivered-${id}`);
        return { status: 200, body: { id, state: 'delivered' } };
      },
    },
    {
      // FAILED — a delivery attempt failed, with a reason. After maxAttempts the engine dead-letters it. The
      // route records the fact; the fold (the tested engine) decides the resulting state.
      api: 'API-06', method: 'POST', path: '/v1/notifications/queue/:id/failed',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['id'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'failure_needs_a_reason', whatHappened: 'Recording a failed delivery needs a { reason } — a poison send with no reason cannot be fixed.', wasItSaved: 'not_saved', nextSafeAction: 'Send why the delivery failed.' });
        }
        if (b['maxAttempts'] !== undefined && (!isInt(b['maxAttempts']) || (b['maxAttempts'] as number) < 1)) {
          throw apiError(400, { code: 'max_attempts_not_a_count', whatHappened: 'maxAttempts must be a whole number of at least 1 when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send how many attempts before dead-lettering, or leave it out.' });
        }
        const item = (await deps.queue(ctx.tenantId)).find(id);
        if (item === undefined) throw notFound(id);
        if (item.state !== 'pending') {
          return { status: 200, body: { id, state: item.state, note: 'already resolved' } };
        }
        // Key on the attempt number this records, so each distinct failure is its own fact while a retry of
        // the same POST collapses.
        await deps.record(ctx.tenantId, { id, change: 'failed', by: ctx.userId, at: deps.now(), reason: (b['reason'] as string).trim(), ...(isInt(b['maxAttempts']) ? { maxAttempts: b['maxAttempts'] as number } : {}) }, `notif-failed-${id}-${item.attempts + 1}`);
        const after = (await deps.queue(ctx.tenantId)).find(id);
        return { status: 200, body: { id, state: after?.state ?? 'pending', attempts: after?.attempts ?? item.attempts + 1 } };
      },
    },
    {
      // PENDING — what still has to go out, in enqueue order.
      api: 'API-06', method: 'GET', path: '/v1/notifications/queue/pending',
      permission: 'notification.send.check',
      handler: async (ctx) => {
        const pending = (await deps.queue(ctx.tenantId)).pending();
        return { status: 200, body: { pending, count: pending.length, asAt: deps.now() } };
      },
    },
    {
      // DEAD-LETTERS — poison sends kept for a person, never dropped (hard rule #6).
      api: 'API-06', method: 'GET', path: '/v1/notifications/queue/dead-letters',
      permission: 'notification.send.check',
      handler: async (ctx) => {
        const dead = (await deps.queue(ctx.tenantId)).deadLetters();
        return { status: 200, body: { deadLetters: dead, count: dead.length, asAt: deps.now() } };
      },
    },
  ];
}

function notFound(id: string): ReturnType<typeof apiError> {
  return apiError(404, {
    code: 'unknown_notification',
    whatHappened: `There is no queued notification '${id}'.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Enqueue it first with POST /v1/notifications/queue/' + id + '.',
  });
}

/** Rebuild the tested queue from its append-only log — the retry/dead-letter state machine is the engine's. */
export function replayNotificationQueue(events: readonly NotificationQueueEvent[]): NotificationQueue {
  const q = new NotificationQueue();
  for (const e of events) {
    if (e.change === 'enqueued' && e.channel !== undefined) q.enqueue(e.id, e.channel);
    else if (e.change === 'delivered') q.markDelivered(e.id);
    else if (e.change === 'failed') q.recordFailure(e.id, e.reason ?? '', e.maxAttempts);
    else if (e.change === 'dead_lettered') q.deadLetter(e.id, e.reason ?? '');
  }
  return q;
}

export type { NotificationItem };
