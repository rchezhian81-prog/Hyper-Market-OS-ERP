// API-11 Connector DELIVERY queue (M32-FR-02, the transport-facing half) — the durable outbox that
// carries a mapped record to an external destination, on the live API over the tested `@sre/integration`
// connector engine. The sibling of `connectors.ts` (the mapping half) and the exact mirror of the
// notification delivery queue (M31-FR-04): the mapping half decided a record is SAFE to send; this is the
// queue that carries the ones that may go.
//
// A message is enqueued, marked delivered when the transport gets it through (a DUPLICATE counts as
// delivered — after a timeout the destination has usually taken it and treating that as a failure re-sends
// it forever), or its failure recorded. A failure is either PERMANENT (a rejected record — dead-lettered at
// once, without burning retries) or RETRYABLE (backed off, bounded); once it has failed `maxAttempts` times
// a retryable failure moves to a VISIBLE dead-letter queue for a person. A dead letter is READ, NEVER
// DELETED (hard rule #6) — there is no purge route here, and none in the engine; a poison message is
// resolved by a corrected message with a NEW key, and the original stays on file.
//
// Event-sourced: each enqueue / delivery / failure is an append-only fact, and the current queue is the
// tested engine (`drainConnector`) replayed over them — so the retry-then-dead-letter state machine runs
// once, in the fold, not a second copy here. A message carries its own connector version, so an in-flight
// message enqueued under v1 is delivered under v1 whatever is deployed by the time it drains.
//
// The transport that actually posts each pending item to the destination (and then calls `.../delivered` or
// `.../failed`) is a deployment step — an outbound network path, not a cloud endpoint. This is the durable
// queue it drains.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  drainConnector, deadLetters, type ConnectorMessage, type DeliveryResult,
} from '../../../packages/integration/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** One append-only fact about a queued connector message. `change` says which; extra fields carry detail. */
export interface ConnectorDeliveryEvent {
  readonly id: string;
  readonly change: 'enqueued' | 'delivered' | 'failed' | 'dead_lettered';
  readonly at: string;
  readonly by: string;
  /** `enqueued` only — the message the destination will see. */
  readonly connectorId?: string;
  readonly connectorVersion?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly deliveryKey?: string;
  /** `enqueued` only — attempts before a retryable failure dead-letters (default the engine's 5). */
  readonly maxAttempts?: number;
  /** `failed` / `dead_lettered` only — why. */
  readonly reason?: string;
}

export interface ConnectorDeliveryDeps {
  /** The current queue for one connector — the tested engine replayed over the append-only log. */
  readonly queue: (tenantId: string, connectorId: string) => Promise<readonly ConnectorMessage[]> | readonly ConnectorMessage[];
  /** Append one queue fact. Idempotent on the key. */
  readonly record: (tenantId: string, connectorId: string, event: ConnectorDeliveryEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function connectorDeliveryRoutes(deps: ConnectorDeliveryDeps): readonly Route[] {
  const find = async (tenantId: string, connectorId: string, messageId: string): Promise<ConnectorMessage | undefined> =>
    (await deps.queue(tenantId, connectorId)).find((m) => m.messageId === messageId);

  return [
    {
      // ENQUEUE a mapped record for delivery. Idempotent on its id — a re-enqueue returns the existing item.
      api: 'API-11', method: 'POST', path: '/v1/integration/connectors/:connectorId/queue/:messageId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const messageId = ctx.params['messageId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['kind']) || !isStr(b['deliveryKey']) || !isStr(b['connectorVersion'])) {
          throw apiError(400, {
            code: 'enqueue_needs_message_fields',
            whatHappened: 'Queuing a connector message needs { kind, deliveryKey, connectorVersion } — the destination sees the deliveryKey as its idempotency key, and the version travels WITH the message so an upgrade never re-maps it.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send kind, deliveryKey and connectorVersion.',
          });
        }
        if (b['payload'] === undefined) {
          throw apiError(400, { code: 'enqueue_needs_a_payload', whatHappened: 'A connector message needs a { payload } to deliver.', wasItSaved: 'not_saved', nextSafeAction: 'Send the mapped payload.' });
        }
        if (b['maxAttempts'] !== undefined && (!isInt(b['maxAttempts']) || (b['maxAttempts'] as number) < 1)) {
          throw apiError(400, { code: 'max_attempts_not_a_count', whatHappened: 'maxAttempts must be a whole number of at least 1 when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send how many attempts before dead-lettering, or leave it out.' });
        }
        const existing = await find(ctx.tenantId, connectorId, messageId);
        if (existing !== undefined) {
          return { status: 200, body: { messageId, connectorId, state: existing.state, alreadyQueued: true } };
        }
        await deps.record(ctx.tenantId, connectorId, {
          id: messageId, change: 'enqueued', by: ctx.userId, at: deps.now(),
          connectorId, connectorVersion: (b['connectorVersion'] as string).trim(),
          kind: (b['kind'] as string).trim(), payload: b['payload'], deliveryKey: (b['deliveryKey'] as string).trim(),
          ...(isInt(b['maxAttempts']) ? { maxAttempts: b['maxAttempts'] as number } : {}),
        }, `conn-enqueue-${connectorId}-${messageId}`);
        return { status: 201, body: { messageId, connectorId, state: 'queued' } };
      },
    },
    {
      // DELIVERED — the transport got it through (a duplicate counts as delivered). Idempotent; a delivery
      // of a non-queued message is a no-op.
      api: 'API-11', method: 'POST', path: '/v1/integration/connectors/:connectorId/queue/:messageId/delivered',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const messageId = ctx.params['messageId'] ?? '';
        const item = await find(ctx.tenantId, connectorId, messageId);
        if (item === undefined) throw notFound(connectorId, messageId);
        if (item.state !== 'queued') return { status: 200, body: { messageId, state: item.state, note: 'already resolved' } };
        await deps.record(ctx.tenantId, connectorId, { id: messageId, change: 'delivered', by: ctx.userId, at: deps.now() }, `conn-delivered-${connectorId}-${messageId}`);
        return { status: 200, body: { messageId, state: 'delivered' } };
      },
    },
    {
      // FAILED — a delivery attempt failed, with a reason. `permanent: true` dead-letters at once (a rejected
      // record — retrying it nine times buries the message that mattered); otherwise it is retryable and the
      // engine dead-letters it once it has failed maxAttempts times. The route records the fact; the fold (the
      // tested engine) decides the resulting state.
      api: 'API-11', method: 'POST', path: '/v1/integration/connectors/:connectorId/queue/:messageId/failed',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const messageId = ctx.params['messageId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'failure_needs_a_reason', whatHappened: 'Recording a failed delivery needs a { reason } — a poison message with no reason cannot be fixed.', wasItSaved: 'not_saved', nextSafeAction: 'Send why the delivery failed.' });
        }
        const item = await find(ctx.tenantId, connectorId, messageId);
        if (item === undefined) throw notFound(connectorId, messageId);
        if (item.state !== 'queued') return { status: 200, body: { messageId, state: item.state, note: 'already resolved' } };
        const permanent = b['permanent'] === true;
        // Key on the attempt number this records, so each distinct failure is its own fact while a retry of
        // the same POST collapses. A permanent failure is a single terminal fact.
        const key = permanent ? `conn-dead-${connectorId}-${messageId}` : `conn-failed-${connectorId}-${messageId}-${item.attempts + 1}`;
        await deps.record(ctx.tenantId, connectorId, {
          id: messageId, change: permanent ? 'dead_lettered' : 'failed', by: ctx.userId, at: deps.now(), reason: (b['reason'] as string).trim(),
        }, key);
        const after = await find(ctx.tenantId, connectorId, messageId);
        return { status: 200, body: { messageId, state: after?.state ?? item.state, attempts: after?.attempts ?? item.attempts + 1 } };
      },
    },
    {
      // PENDING — what still has to go out for this connector, in enqueue order.
      api: 'API-11', method: 'GET', path: '/v1/integration/connectors/:connectorId/queue/pending',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const pending = (await deps.queue(ctx.tenantId, connectorId)).filter((m) => m.state === 'queued');
        return { status: 200, body: { pending, count: pending.length, asAt: deps.now() } };
      },
    },
    {
      // DEAD-LETTERS — poison messages kept for a person, oldest first, never dropped (hard rule #6).
      api: 'API-11', method: 'GET', path: '/v1/integration/connectors/:connectorId/queue/dead-letters',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const connectorId = ctx.params['connectorId'] ?? '';
        const dead = deadLetters(await deps.queue(ctx.tenantId, connectorId), connectorId);
        return { status: 200, body: { deadLetters: dead, count: dead.length, asAt: deps.now() } };
      },
    },
  ];
}

function notFound(connectorId: string, messageId: string): ReturnType<typeof apiError> {
  return apiError(404, {
    code: 'unknown_connector_message',
    whatHappened: `There is no queued message '${messageId}' on connector '${connectorId}'.`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Enqueue it first with POST /v1/integration/connectors/${connectorId}/queue/${messageId}.`,
  });
}

/**
 * Rebuild the current queue from its append-only log by REPLAYING each recorded outcome through the tested
 * engine (`drainConnector`), one message at a time — so the retry-then-dead-letter state machine is the
 * engine's, run once, not a second copy here. An enqueue adds a queued message; a delivered/failed/
 * dead-lettered fact for a message that is no longer queued is a no-op (idempotent replay).
 */
export function replayConnectorQueue(events: readonly ConnectorDeliveryEvent[]): readonly ConnectorMessage[] {
  let messages: ConnectorMessage[] = [];
  const maxById = new Map<string, number>();

  for (const e of events) {
    if (e.change === 'enqueued') {
      if (messages.some((m) => m.messageId === e.id)) continue; // enqueue is idempotent on the id
      messages.push({
        messageId: e.id,
        tenantId: '',
        connectorId: e.connectorId ?? '',
        connectorVersion: e.connectorVersion ?? 'v1',
        kind: e.kind ?? '',
        payload: e.payload,
        deliveryKey: e.deliveryKey ?? '',
        enqueuedAt: e.at,
        state: 'queued',
        attempts: 0,
      });
      if (e.maxAttempts !== undefined) maxById.set(e.id, e.maxAttempts);
      continue;
    }

    const target = messages.find((m) => m.messageId === e.id);
    if (target === undefined || target.state !== 'queued') continue;

    const result: DeliveryResult =
      e.change === 'delivered' ? { outcome: 'delivered', detail: 'delivered' }
        : e.change === 'dead_lettered' ? { outcome: 'permanent', detail: e.reason ?? 'permanent failure' }
          : { outcome: 'retryable', detail: e.reason ?? 'retryable failure' };

    // Isolate the one message so the drain applies the engine's state machine to it alone.
    const others = messages.filter((m) => m.messageId !== target.messageId);
    const maxAttempts = maxById.get(target.messageId);
    const drained = drainConnector({
      connectorId: target.connectorId,
      messages: [target],
      transport: () => result,
      at: e.at,
      ...(maxAttempts === undefined ? {} : { policy: { maxAttempts } }),
    });
    messages = [...others, ...drained.messages];
  }

  return messages;
}
