// API-06 Notification delivery queue (M31-FR-03/04 · M21-FR-01 · audit PA-08 / PF-10) — durable, consent-checked work.
//
// The audit enqueued a WhatsApp message by sending only `{ channel: 'whatsapp' }` and got 201: no recipient, no
// content, no consent. A queue that will carry anything it is handed is a queue that will message people who said no.
// So a notification is now a full INTENT, and head office decides — never the caller — whether it may go:
//
//   • TEMPLATES are head office's own register: drafted by one person, APPROVED by a different one (§28, M31-FR-04),
//     for one purpose and one channel. Only an approved version can be enqueued; the version is frozen on the item.
//   • ENQUEUE takes { customerId, purpose, channel, templateId, values } and is refused unless the template is approved
//     for that purpose and channel, every placeholder has a value, and the customer's OWN consent ledger (the same
//     record the rest of the system reads, P-02) allows that purpose on that channel now. Silence is not consent.
//   • SEND (the drain) RE-CHECKS consent immediately before each message: a customer who withdrew after the message was
//     queued is WITHHELD — kept, visible, never sent. Each send carries the item's id as the provider's idempotency
//     key; a failure is retried with backoff; a permanent failure or too many attempts dead-letters it (visible, never
//     dropped, hard rule #6). The delivery receipt and the failure are append-only facts.
//
// Transports are provider-neutral (`@sre/notifications` transport). The real SMS transport is release R4 (OB-29) and
// every provider is an external gate (credentials, certification); until one is configured the drain says so (503)
// and sends nothing. Tests run the RECORDING test adapter. The queue engine (retry, dead-letter, withhold) is the
// tested `NotificationQueue`, replayed over the append-only log — one implementation, not a second copy here.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  NotificationQueue, retryDelayMs, type NotificationItem, type NotificationTransport,
} from '../../../packages/notifications/src/index';
import { mayWeSend, type ConsentRecord, type ConsentPurpose, type Channel as ConsentChannel } from './index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const PURPOSES: readonly ConsentPurpose[] = ['marketing', 'transactional'];
const CHANNELS: readonly ConsentChannel[] = ['sms', 'whatsapp', 'email', 'push'];

/** What a queued message IS — recipient, purpose, the approved template version it was rendered from (PA-08). */
export interface NotificationIntent {
  readonly customerId: string;
  readonly purpose: ConsentPurpose;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly text: string;
}

/** One append-only fact about a queued notification. `change` says which; extra fields carry its detail. */
export interface NotificationQueueEvent {
  readonly id: string;
  readonly change: 'enqueued' | 'delivered' | 'failed' | 'dead_lettered' | 'withheld';
  readonly at: string;
  readonly by: string;
  /** `enqueued` only — the channel it goes down. */
  readonly channel?: string;
  /** `enqueued` only — the full intent (PA-08). Absent on items queued before PA-08, which cannot be sent. */
  readonly intent?: NotificationIntent;
  /** `failed` / `dead_lettered` / `withheld` — why. */
  readonly reason?: string;
  /** `failed` only — attempts before dead-lettering (per-tenant policy). */
  readonly maxAttempts?: number;
  /** `delivered` only — the transport's receipt. */
  readonly providerRef?: string;
  readonly transport?: string;
}

/** One version of a message template — drafted by one person, approved by another (§28). */
export interface MessageTemplateVersion {
  readonly templateId: string;
  readonly version: number;
  readonly purpose: ConsentPurpose;
  readonly channel: ConsentChannel;
  /** The words, with {placeholders} filled from the intent's values. */
  readonly body: string;
  readonly state: 'draft' | 'approved';
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface NotificationQueueDeps {
  /** The current queue — the tested engine replayed over the append-only log. */
  readonly queue: (tenantId: string) => Promise<NotificationQueue> | NotificationQueue;
  /** Every queue fact, oldest first — the intents the sender renders from. */
  readonly events?: (tenantId: string) => Promise<readonly NotificationQueueEvent[]> | readonly NotificationQueueEvent[];
  /** Append one queue fact. Idempotent on the key. */
  readonly record: (tenantId: string, event: NotificationQueueEvent, key: string) => Promise<void> | void;
  /** Every template version state, oldest first (latest state per version wins). */
  readonly templates?: (tenantId: string) => Promise<readonly MessageTemplateVersion[]> | readonly MessageTemplateVersion[];
  readonly recordTemplate?: (tenantId: string, version: MessageTemplateVersion) => Promise<void> | void;
  /** The customer's consent ledger — the SAME record the rest of the system reads (P-02). */
  readonly consentRecords?: (tenantId: string, customerId: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  /** The delivery transport. Absent in production until a real provider is certified (SMS is R4, OB-29). */
  readonly transport?: NotificationTransport;
  readonly now: () => string;
}

/** The latest state of each template version, and the newest APPROVED version of a template. */
export function approvedTemplate(versions: readonly MessageTemplateVersion[], templateId: string): MessageTemplateVersion | undefined {
  const latest = new Map<number, MessageTemplateVersion>();
  for (const v of versions) if (v.templateId === templateId) latest.set(v.version, v);
  return [...latest.values()].filter((v) => v.state === 'approved').sort((a, b) => b.version - a.version)[0];
}

/** Fill {placeholders}. Every placeholder must have a value — a message with a hole in it is not sent. */
export function renderTemplate(body: string, values: Readonly<Record<string, string>>): { ok: true; text: string } | { ok: false; missing: readonly string[] } {
  const missing = [...new Set([...body.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!))].filter((k) => !isStr(values[k]));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: body.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k: string) => values[k]!) };
}

const notWired = (what: string): never => {
  throw apiError(503, {
    code: 'notification_store_not_wired',
    whatHappened: `Head office cannot ${what} here, so nothing was done.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Use the full head-office service.',
  });
};

export function notificationQueueRoutes(deps: NotificationQueueDeps): readonly Route[] {
  const consentNow = async (tenantId: string, customerId: string, purpose: ConsentPurpose, channel: ConsentChannel) => {
    if (deps.consentRecords === undefined) notWired('read the consent ledger');
    return mayWeSend({ customerId, purpose, channel, records: await deps.consentRecords!(tenantId, customerId), now: deps.now() });
  };
  const templateVersions = async (tenantId: string) => {
    if (deps.templates === undefined || deps.recordTemplate === undefined) notWired('keep message templates');
    return deps.templates!(tenantId);
  };

  return [
    {
      // DRAFT a message template version — for one purpose and one channel. Body: { purpose, channel, body }.
      api: 'API-06', method: 'POST', path: '/v1/notifications/templates/:templateId',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = (ctx.params['templateId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (templateId === '' || !PURPOSES.includes(b['purpose'] as ConsentPurpose) || !CHANNELS.includes(b['channel'] as ConsentChannel) || !isStr(b['body'])) {
          throw apiError(400, { code: 'not_readable_as_a_message_template', whatHappened: `A message template needs { purpose (${PURPOSES.join('/')}), channel (${CHANNELS.join('/')}), body }.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the purpose, channel and the words.' });
        }
        const all = await templateVersions(ctx.tenantId);
        const version = Math.max(0, ...all.filter((v) => v.templateId === templateId).map((v) => v.version)) + 1;
        const draft: MessageTemplateVersion = {
          templateId, version, purpose: b['purpose'] as ConsentPurpose, channel: b['channel'] as ConsentChannel, body: (b['body'] as string).trim(),
          state: 'draft', draftedBy: ctx.userId, draftedAt: deps.now(),
        };
        await deps.recordTemplate!(ctx.tenantId, draft);
        return { status: 201, body: { template: draft, nextSafeAction: 'A different person approves it before anything can be sent with it.' } };
      },
    },
    {
      // APPROVE a drafted version — a DIFFERENT person (§28). Body: { version }.
      api: 'API-06', method: 'POST', path: '/v1/notifications/templates/:templateId/approval',
      permission: 'document.template.manage', idempotent: true,
      handler: async (ctx) => {
        const templateId = (ctx.params['templateId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isInt(b['version'])) throw apiError(400, { code: 'approval_needs_a_version', whatHappened: 'Approving a template needs the { version } being approved.', wasItSaved: 'not_saved', nextSafeAction: 'Send the version number.' });
        const all = await templateVersions(ctx.tenantId);
        const current = [...all].reverse().find((v) => v.templateId === templateId && v.version === b['version']);
        if (current === undefined) throw apiError(404, { code: 'unknown_template_version', whatHappened: `There is no version ${String(b['version'])} of template ${templateId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Draft it first.' });
        if (current.state === 'approved') return { status: 200, body: { template: current, alreadyApproved: true } };
        if (current.draftedBy === ctx.userId) {
          throw apiError(403, { code: 'maker_cannot_approve', whatHappened: `${ctx.userId} drafted this template and cannot also approve it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask a second person with template authority to approve it.' });
        }
        const approved: MessageTemplateVersion = { ...current, state: 'approved', approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordTemplate!(ctx.tenantId, approved);
        return { status: 200, body: { template: approved } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/notifications/templates',
      permission: 'notification.send.check',
      handler: async (ctx) => {
        const latest = new Map<string, MessageTemplateVersion>();
        for (const v of await templateVersions(ctx.tenantId)) latest.set(`${v.templateId}|${v.version}`, v);
        return { status: 200, body: { templates: [...latest.values()], asAt: deps.now() } };
      },
    },
    {
      // SEND — one pass of the sender over the pending queue (PA-08). Declared BEFORE `queue/:id` so `drain` is not read as an id. For each pending item that is due (backoff after a
      // failure): RE-CHECK consent now — a withdrawal since it was queued WITHHOLDS it, never sent; otherwise hand it to
      // the transport with its id as the idempotency key; record the receipt, or the failure (retried with backoff,
      // dead-lettered when permanent or after maxAttempts). Body: { maxAttempts? }. 503 when no transport is configured.
      api: 'API-06', method: 'POST', path: '/v1/notifications/queue/drain',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        if (deps.transport === undefined) {
          throw apiError(503, {
            code: 'no_transport_configured',
            whatHappened: 'No message provider is configured, so nothing was sent. The queue is kept exactly as it is.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Messages stay queued until a provider is certified and configured (the SMS provider is release R4).',
          });
        }
        if (deps.events === undefined) notWired('read the queued intents');
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const maxAttempts = isInt(b['maxAttempts']) && (b['maxAttempts'] as number) >= 1 ? (b['maxAttempts'] as number) : 5;
        const queue = await deps.queue(ctx.tenantId);
        const intents = new Map<string, { channel: string; intent?: NotificationIntent }>();
        for (const e of await deps.events!(ctx.tenantId)) if (e.change === 'enqueued') intents.set(e.id, { channel: e.channel ?? '', ...(e.intent === undefined ? {} : { intent: e.intent }) });
        const now = deps.now();
        const outcome: { id: string; result: string; detail: string }[] = [];
        for (const item of queue.pending()) {
          if (item.lastAttemptAt !== undefined && Date.parse(now) - Date.parse(item.lastAttemptAt) < retryDelayMs(item.attempts)) {
            outcome.push({ id: item.id, result: 'not_yet_due', detail: `waiting ${Math.round(retryDelayMs(item.attempts) / 60_000)} minute(s) after attempt ${item.attempts}` });
            continue;
          }
          const queued = intents.get(item.id);
          if (queued?.intent === undefined) {
            await deps.record(ctx.tenantId, { id: item.id, change: 'dead_lettered', by: ctx.userId, at: now, reason: 'queued before PA-08 with no recipient or content — it cannot be sent; a person must decide' }, `notif-dead-${item.id}-nointent`);
            outcome.push({ id: item.id, result: 'dead_lettered', detail: 'no recipient or content on record' });
            continue;
          }
          const consent = await consentNow(ctx.tenantId, queued.intent.customerId, queued.intent.purpose, queued.channel as ConsentChannel);
          if (consent.verdict !== 'may_send') {
            await deps.record(ctx.tenantId, { id: item.id, change: 'withheld', by: ctx.userId, at: now, reason: `consent no longer holds at the moment of sending: ${consent.detail}` }, `notif-withheld-${item.id}`);
            outcome.push({ id: item.id, result: 'withheld', detail: consent.detail });
            continue;
          }
          const sent = await deps.transport.send({ messageId: item.id, channel: queued.channel, customerId: queued.intent.customerId, text: queued.intent.text });
          if (sent.ok) {
            await deps.record(ctx.tenantId, { id: item.id, change: 'delivered', by: ctx.userId, at: now, providerRef: sent.providerRef, transport: deps.transport.name }, `notif-delivered-${item.id}`);
            outcome.push({ id: item.id, result: 'delivered', detail: sent.providerRef });
          } else if (sent.permanent === true) {
            await deps.record(ctx.tenantId, { id: item.id, change: 'dead_lettered', by: ctx.userId, at: now, reason: sent.reason, transport: deps.transport.name }, `notif-dead-${item.id}-${item.attempts + 1}`);
            outcome.push({ id: item.id, result: 'dead_lettered', detail: sent.reason });
          } else {
            await deps.record(ctx.tenantId, { id: item.id, change: 'failed', by: ctx.userId, at: now, reason: sent.reason, maxAttempts, transport: deps.transport.name }, `notif-failed-${item.id}-${item.attempts + 1}`);
            outcome.push({ id: item.id, result: item.attempts + 1 >= maxAttempts ? 'dead_lettered' : 'retry_later', detail: sent.reason });
          }
        }
        return { status: 200, body: { transport: deps.transport.name, outcome, asAt: now } };
      },
    },
    {
      // ENQUEUE a notification — a full intent, decided by head office (PA-08). Body: { customerId, purpose, channel,
      // templateId, values? }. Refused unless the template is approved for this purpose and channel, every placeholder
      // has a value, and the customer's own consent ledger allows it now. Idempotent on the id.
      api: 'API-06', method: 'POST', path: '/v1/notifications/queue/:id',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['id'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const values = b['values'] === undefined ? {} : b['values'];
        if (!isStr(b['customerId']) || !PURPOSES.includes(b['purpose'] as ConsentPurpose) || !CHANNELS.includes(b['channel'] as ConsentChannel)
          || !isStr(b['templateId']) || !isObj(values) || !Object.values(values).every((v) => typeof v === 'string')) {
          throw apiError(400, {
            code: 'enqueue_needs_a_full_intent',
            whatHappened: `Queuing a notification needs who it is for and what it says: { customerId, purpose (${PURPOSES.join('/')}), channel (${CHANNELS.join('/')}), templateId, values? }. A channel alone is not a message.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the customer, purpose, channel and the approved template to use.',
          });
        }
        const existing = (await deps.queue(ctx.tenantId)).find(id);
        if (existing !== undefined) return { status: 200, body: { id, state: existing.state, alreadyQueued: true } };
        const purpose = b['purpose'] as ConsentPurpose;
        const channel = b['channel'] as ConsentChannel;
        const customerId = (b['customerId'] as string).trim();
        const template = approvedTemplate(await templateVersions(ctx.tenantId), (b['templateId'] as string).trim());
        if (template === undefined || template.purpose !== purpose || template.channel !== channel) {
          throw apiError(422, {
            code: 'template_not_approved',
            whatHappened: template === undefined
              ? `Template ${String(b['templateId'])} has no approved version — nothing is sent with words a second person has not approved (M31-FR-04).`
              : `Template ${template.templateId} is approved for ${template.purpose} on ${template.channel}, not ${purpose} on ${channel}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a template approved for this purpose and channel.',
          });
        }
        const rendered = renderTemplate(template.body, values as Record<string, string>);
        if (!rendered.ok) {
          throw apiError(422, { code: 'template_value_missing', whatHappened: `The template needs ${rendered.missing.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send a value for every {placeholder}.' });
        }
        const consent = await consentNow(ctx.tenantId, customerId, purpose, channel);
        if (consent.verdict !== 'may_send') {
          throw apiError(422, {
            code: consent.verdict === 'must_not_send' ? 'consent_withdrawn' : 'no_consent_on_record',
            whatHappened: `${customerId} may not be sent ${purpose} messages on ${channel}: ${consent.detail}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was queued. Only a customer who said yes, and has not withdrawn, is messaged.',
          });
        }
        const intent: NotificationIntent = { customerId, purpose, templateId: template.templateId, templateVersion: template.version, text: rendered.text };
        await deps.record(ctx.tenantId, { id, change: 'enqueued', by: ctx.userId, at: deps.now(), channel, intent }, `notif-enqueue-${id}`);
        return { status: 201, body: { id, channel, state: 'pending', intent } };
      },
    },
    {
      // DELIVERED — a transport's receipt arriving out of band. Idempotent; a receipt for a non-pending item is a no-op.
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
    {
      // WITHHELD — messages NOT sent because consent no longer held at the moment of sending (PA-08). Kept, visible.
      api: 'API-06', method: 'GET', path: '/v1/notifications/queue/withheld',
      permission: 'notification.send.check',
      handler: async (ctx) => {
        const withheld = (await deps.queue(ctx.tenantId)).withheld();
        return { status: 200, body: { withheld, count: withheld.length, asAt: deps.now() } };
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

/** Rebuild the tested queue from its append-only log — the retry/dead-letter/withhold state machine is the engine's. */
export function replayNotificationQueue(events: readonly NotificationQueueEvent[]): NotificationQueue {
  const q = new NotificationQueue();
  for (const e of events) {
    if (e.change === 'enqueued' && e.channel !== undefined) q.enqueue(e.id, e.channel);
    else if (e.change === 'delivered') q.markDelivered(e.id);
    else if (e.change === 'failed') q.recordFailure(e.id, e.reason ?? '', e.maxAttempts, e.at);
    else if (e.change === 'dead_lettered') q.deadLetter(e.id, e.reason ?? '');
    else if (e.change === 'withheld') q.withhold(e.id, e.reason ?? '');
  }
  return q;
}

export type { NotificationItem };
