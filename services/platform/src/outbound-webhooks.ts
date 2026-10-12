// API-11 OUTBOUND webhooks (M32-FR-01 "versioned APIs … webhooks and idempotency" · M32-FR-02 "retry and dead-letter
// queues" · D14-FR-06 · roadmap §30.1 "signed webhooks with replay protection, retry schedule, dead-letter and
// reconciliation endpoint" · P-06 · P-08 · hard rules #4 and #6).
//
// `webhooks.ts` is the INBOUND half (a provider calls us; we verify its signature). This is the outbound half: a
// partner subscribes to business events (§30.2) and head office delivers each one to the partner's https endpoint,
// SIGNED, retried on a schedule, and dead-lettered — visibly, never deleted — when it cannot get through.
//
//   • SUBSCRIBE — a person with setup rights names the partner, an https URL, the event types (from the published
//     list) and a vault:// reference to the signing secret (never the secret itself, #4). A change is a new version; a
//     subscription can be switched off (kept, with who and when). Events from the moment it is created are delivered.
//   • DELIVER — one pass reads each subscribed event type from the ledger and sends what is due. The body is versioned
//     (`apiVersion: "v1"`); the headers carry the message id (the partner's idempotency key — the same event is always
//     the same id), a timestamp and `v1=<HMAC-SHA256(secret, "<timestamp>.<body>")>`, so the partner can refuse a
//     forgery and a stale replay (`verifyOutboundSignature` is the reference check).
//   • RETRY / DEAD LETTER — a 2xx is delivered; a 408/429/5xx or no answer is retried after 1, 2, 4, 8 … minutes up to
//     the subscription's maxAttempts; any other 4xx is the partner refusing it — dead-lettered at once. A dead letter is
//     listed for a person, never deleted (#6); a person may send it again (a new series, the history kept).
//   • RECONCILE — the partner (or our operator) asks what was sent since a time: every message with its status, so the
//     two sides can compare (§30.1 reconciliation endpoint).
//
// The pass runs on a timer in the head-office process (the PA-08 worker) only when an outbound transport is configured;
// with none — today, no partner is live — messages wait, visible in the reconciliation read.
//
// Round 10:
//   • SSRF GUARD (public-destination.ts) — a subscription URL must resolve only to public internet addresses: refused
//     at subscribe (422 `webhook_destination_not_public`) and checked AGAIN before every send, because DNS can change
//     after the subscription was approved; a destination that has turned private is not sent to — the message is
//     dead-lettered, saying why. The vetted address is handed to the transport so it connects to exactly that address.
//   • MAKER-CHECKER — a partner subscription to business events (a new one, or any change to it) takes a second
//     person's approval through head office's approvals engine (kind `partner_webhook_subscription`, ADR-0024): the
//     maker asks for exactly this subscription, another person with setup rights approves it in their own session, and
//     the approval is spent once. Switching one OFF needs no second person (it only stops sending).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { judgeDestination, systemResolveHost, type ResolveHost } from './public-destination';

/** Round 10: the approvals-engine kind a partner subscription is made under. */
export const PARTNER_SUBSCRIPTION_APPROVAL = 'partner_webhook_subscription';

/** The business events a partner may subscribe to (§30.2), each with the ledger stream it is read from. */
export type PublishableEvents = Readonly<Record<string, string>>;

export interface OutboundSubscription {
  readonly subscriptionId: string;
  readonly partnerId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly signingKeyRef: string;
  readonly maxAttempts: number;
  readonly active: boolean;
  readonly version: number;
  /** Events that happened at or after this moment are delivered (the first version's time). */
  readonly deliverFrom: string;
  readonly setBy: string;
  readonly setAt: string;
  /** Round 10: the second person who approved this version (absent on a switch-off, and on versions from before). */
  readonly approvedBy?: string;
}

export type OutboundFact =
  | { readonly change: 'subscribed'; readonly subscription: OutboundSubscription }
  | { readonly change: 'attempt'; readonly subscriptionId: string; readonly messageId: string; readonly series: number; readonly attempt: number; readonly status: number | null; readonly outcome: 'delivered' | 'retry' | 'dead_lettered'; readonly detail: string; readonly at: string; readonly nextAttemptAt?: string }
  | { readonly change: 'requeued'; readonly subscriptionId: string; readonly messageId: string; readonly series: number; readonly by: string; readonly at: string };

/** The port the pass sends through (HTTPS in a deployment, a recording fake in tests). */
export interface OutboundTransport {
  readonly name: string;
  /**
   * `address` (round 10): the public address the destination was vetted at just now — a real transport connects to
   * exactly it (keeping the URL's host for TLS and the Host header), so nothing resolves the name again in between.
   */
  send(input: { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly address?: string }): Promise<{ readonly status: number | null }>;
  /** Round 10: how this transport resolves a host name (the SSRF guard judges what it returns). Absent: the system's. */
  readonly resolve?: ResolveHost;
}

export interface OutboundWebhookDeps {
  readonly facts: (tenantId: string) => Promise<readonly OutboundFact[]>;
  readonly record: (tenantId: string, fact: OutboundFact, key: string) => Promise<void>;
  readonly publishable: PublishableEvents;
  /** The ledger's events of one type in one stream that happened at or after `from`: id (idempotency key), time, payload. */
  readonly eventsOf: (tenantId: string, stream: string, type: string, from: string) => Promise<readonly { readonly eventId: string; readonly occurredAt: string; readonly payload: unknown }[]>;
  /** Resolve a vault reference to its secret at send time; undefined = not available (the message waits, said). */
  readonly secretFor: (ref: string) => string | undefined;
  readonly transport?: OutboundTransport;
  /** Round 10: head office's maker-checker engine. Absent on a bare stub: then no subscription can be approved. */
  readonly approvals?: ApprovalPort;
  /** Round 10: the resolver the SSRF guard uses; absent → the transport's, else the operating system's. */
  readonly resolveHost?: ResolveHost;
  readonly now: () => string;
}

const resolverOf = (deps: OutboundWebhookDeps): ResolveHost => deps.resolveHost ?? deps.transport?.resolve ?? systemResolveHost;

export const OUTBOUND_API_VERSION = 'v1';
const RETRYABLE = (s: number | null): boolean => s === null || s === 408 || s === 429 || s >= 500;

/** Sign exactly what is sent: "<timestamp>.<body>", HMAC-SHA256, hex, prefixed with the scheme version. */
export function signOutbound(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** The partner's reference check: the signature matches, and the timestamp is within `toleranceSeconds` of now. */
export function verifyOutboundSignature(input: { readonly secret: string; readonly timestamp: string; readonly body: string; readonly signature: string; readonly nowMs: number; readonly toleranceSeconds?: number }): { ok: boolean; reason?: 'bad_signature' | 'stale' } {
  const expected = Buffer.from(signOutbound(input.secret, input.timestamp, input.body));
  const given = Buffer.from(input.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  const age = Math.abs(input.nowMs - Date.parse(input.timestamp)) / 1000;
  if (!Number.isFinite(age) || age > (input.toleranceSeconds ?? 300)) return { ok: false, reason: 'stale' };
  return { ok: true };
}

interface MessageState { series: number; attempts: number; status: 'pending' | 'delivered' | 'dead_lettered'; nextAttemptAt?: string; lastDetail?: string; lastStatus?: number | null; deliveredAt?: string }

/** Fold the facts: the latest version of every subscription, and every message's state in its current series. */
export function projectOutbound(facts: readonly OutboundFact[]): { subscriptions: ReadonlyMap<string, OutboundSubscription>; messages: ReadonlyMap<string, MessageState> } {
  const subscriptions = new Map<string, OutboundSubscription>();
  const messages = new Map<string, MessageState>();
  for (const f of facts) {
    if (f.change === 'subscribed') { subscriptions.set(f.subscription.subscriptionId, f.subscription); continue; }
    const key = `${f.subscriptionId}\u001f${f.messageId}`;
    const m = messages.get(key) ?? { series: 1, attempts: 0, status: 'pending' as const };
    if (f.change === 'requeued') {
      if (f.series > m.series) messages.set(key, { series: f.series, attempts: 0, status: 'pending' });
      continue;
    }
    if (f.series !== m.series) continue;
    m.attempts = Math.max(m.attempts, f.attempt);
    m.lastDetail = f.detail; m.lastStatus = f.status;
    if (f.outcome === 'delivered') { m.status = 'delivered'; m.deliveredAt = f.at; }
    else if (f.outcome === 'dead_lettered') m.status = 'dead_lettered';
    else m.nextAttemptAt = f.nextAttemptAt;
    messages.set(key, m);
  }
  return { subscriptions, messages };
}

export interface OutboundPass { readonly transport: string; readonly outcome: readonly { readonly id: string; readonly result: string; readonly detail: string }[]; readonly asAt: string }

/** One delivery pass for one shop — what the timer runs and what the drain route runs. */
export async function drainOutboundWebhooks(deps: OutboundWebhookDeps, tenantId: string): Promise<OutboundPass> {
  const asAt = deps.now();
  const transport = deps.transport;
  if (transport === undefined) return { transport: 'none', outcome: [], asAt };
  const { subscriptions, messages } = projectOutbound(await deps.facts(tenantId));
  const outcome: { id: string; result: string; detail: string }[] = [];
  for (const sub of subscriptions.values()) {
    if (!sub.active) continue;
    const secret = deps.secretFor(sub.signingKeyRef);
    for (const type of sub.eventTypes) {
      const stream = deps.publishable[type];
      if (stream === undefined) continue;
      for (const e of await deps.eventsOf(tenantId, stream, type, sub.deliverFrom)) {
        const messageId = `${sub.subscriptionId}.${e.eventId}`;
        const state = messages.get(`${sub.subscriptionId}\u001f${messageId}`) ?? { series: 1, attempts: 0, status: 'pending' as const };
        if (state.status !== 'pending') continue;
        if (state.nextAttemptAt !== undefined && state.nextAttemptAt > asAt) { outcome.push({ id: messageId, result: 'retry_later', detail: `next attempt at ${state.nextAttemptAt}` }); continue; }
        if (secret === undefined) { outcome.push({ id: messageId, result: 'held', detail: `the signing secret ${sub.signingKeyRef} is not available — nothing is sent unsigned` }); continue; }
        const body = JSON.stringify({ id: messageId, apiVersion: OUTBOUND_API_VERSION, type, occurredAt: e.occurredAt, tenantId, subscriptionId: sub.subscriptionId, data: e.payload });
        const timestamp = deps.now();
        const headers = {
          'content-type': 'application/json', 'x-sre-webhook-id': messageId, 'x-sre-webhook-timestamp': timestamp,
          'x-sre-webhook-signature': signOutbound(secret, timestamp, body), 'x-sre-api-version': OUTBOUND_API_VERSION,
        };
        const attempt = state.attempts + 1;
        // Round 10: the destination is judged AGAIN, now — DNS can have changed since the subscription was approved.
        const where = await judgeDestination(sub.url, resolverOf(deps));
        if (!where.ok) {
          const fact: OutboundFact = { change: 'attempt', subscriptionId: sub.subscriptionId, messageId, series: state.series, attempt, status: null, outcome: 'dead_lettered', detail: `not sent: ${where.why}`, at: deps.now() };
          await deps.record(tenantId, fact, `attempt-${sub.subscriptionId}-${messageId}-s${state.series}-a${attempt}`);
          outcome.push({ id: messageId, result: 'dead_lettered', detail: fact.detail });
          continue;
        }
        let status: number | null;
        try { status = (await transport.send({ url: sub.url, headers, body, address: where.addresses[0]! })).status; } catch { status = null; }
        const at = deps.now();
        let fact: OutboundFact;
        if (status !== null && status >= 200 && status < 300) {
          fact = { change: 'attempt', subscriptionId: sub.subscriptionId, messageId, series: state.series, attempt, status, outcome: 'delivered', detail: `${status}`, at };
        } else if (RETRYABLE(status) && attempt < sub.maxAttempts) {
          const nextAttemptAt = new Date(Date.parse(at) + 60_000 * 2 ** (attempt - 1)).toISOString();
          fact = { change: 'attempt', subscriptionId: sub.subscriptionId, messageId, series: state.series, attempt, status, outcome: 'retry', detail: status === null ? 'no answer' : `${status}`, at, nextAttemptAt };
        } else {
          fact = { change: 'attempt', subscriptionId: sub.subscriptionId, messageId, series: state.series, attempt, status, outcome: 'dead_lettered', detail: RETRYABLE(status) ? `gave up after ${attempt} attempt(s) (${status ?? 'no answer'})` : status !== null && status >= 300 && status < 400 ? `the partner answered with a redirect (${status}) — a redirect is never followed` : `the partner refused it (${status})`, at };
        }
        await deps.record(tenantId, fact, `attempt-${sub.subscriptionId}-${messageId}-s${state.series}-a${attempt}`);
        outcome.push({ id: messageId, result: fact.outcome === 'delivered' ? 'delivered' : fact.outcome === 'retry' ? 'retry_later' : 'dead_lettered', detail: fact.detail });
      }
    }
  }
  return { transport: transport.name, outcome, asAt };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isHttpsUrl = (v: unknown): v is string => { if (typeof v !== 'string') return false; try { return new URL(v).protocol === 'https:'; } catch { return false; } };

export function outboundWebhookRoutes(deps: OutboundWebhookDeps): readonly Route[] {
  const load = async (tenantId: string, subscriptionId: string) => {
    const projected = projectOutbound(await deps.facts(tenantId));
    const sub = projected.subscriptions.get(subscriptionId);
    if (sub === undefined) throw notFound(`outbound webhook subscription ${subscriptionId}`);
    return { sub, projected };
  };
  /** Every message for a subscription since `from`: what the ledger holds × what was done with it. */
  const ledgerView = async (tenantId: string, sub: OutboundSubscription, messages: ReadonlyMap<string, MessageState>, from: string) => {
    const rows: { messageId: string; type: string; occurredAt: string; status: string; attempts: number; lastStatus: number | null; detail: string | null; deliveredAt: string | null }[] = [];
    const since = from > sub.deliverFrom ? from : sub.deliverFrom;
    for (const type of sub.eventTypes) {
      const stream = deps.publishable[type];
      if (stream === undefined) continue;
      for (const e of await deps.eventsOf(tenantId, stream, type, since)) {
        const messageId = `${sub.subscriptionId}.${e.eventId}`;
        const m = messages.get(`${sub.subscriptionId}\u001f${messageId}`);
        rows.push({ messageId, type, occurredAt: e.occurredAt, status: m?.status ?? 'pending', attempts: m?.attempts ?? 0, lastStatus: m?.lastStatus ?? null, detail: m?.lastDetail ?? null, deliveredAt: m?.deliveredAt ?? null });
      }
    }
    return rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  };
  return [
    {
      // SUBSCRIBE (or change: a new version) — { partnerId, url (https), eventTypes[], signingKeyRef (vault://), maxAttempts? }.
      api: 'API-11', method: 'POST', path: '/v1/integration/outbound-webhooks/:subscriptionId',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const subscriptionId = (ctx.params['subscriptionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const types = Array.isArray(b['eventTypes']) && (b['eventTypes'] as unknown[]).length > 0 && (b['eventTypes'] as unknown[]).every(isStr) ? [...new Set(b['eventTypes'] as string[])].sort() : undefined;
        const maxAttempts = b['maxAttempts'] === undefined ? 8 : b['maxAttempts'];
        if (subscriptionId === '' || !isStr(b['partnerId']) || !isHttpsUrl(b['url']) || types === undefined
          || !(typeof b['signingKeyRef'] === 'string' && /^vault:\/\/\S+$/.test(b['signingKeyRef']))
          || !(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 20)) {
          throw apiError(400, { code: 'not_readable_as_an_outbound_webhook', whatHappened: 'An outbound webhook needs { partnerId, url (https only), eventTypes: [..], signingKeyRef ("vault://…" — never the secret itself), maxAttempts? (1–20) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again with those fields. Nothing was set up.' });
        }
        const unknown = types.filter((t) => deps.publishable[t] === undefined);
        if (unknown.length > 0) {
          throw apiError(422, { code: 'event_type_not_published', whatHappened: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among the events head office publishes to partners (${Object.keys(deps.publishable).sort().join(', ')}).`, wasItSaved: 'not_saved', nextSafeAction: 'Subscribe to published events only. Nothing was set up.' });
        }
        const { subscriptions } = projectOutbound(await deps.facts(ctx.tenantId));
        const prior = subscriptions.get(subscriptionId);
        const same = prior !== undefined && prior.active && prior.partnerId === b['partnerId'] && prior.url === b['url'] && prior.signingKeyRef === b['signingKeyRef'] && prior.maxAttempts === maxAttempts && prior.eventTypes.join(',') === types.join(',');
        if (same) return { status: 200, body: { subscription: prior, unchanged: true } };
        // Round 10 (SSRF): the URL must resolve only to public internet addresses — never head office's own network.
        const where = await judgeDestination(b['url'] as string, resolverOf(deps));
        if (!where.ok) {
          throw apiError(422, { code: 'webhook_destination_not_public', whatHappened: `Head office will not send to ${b['url'] as string}: ${where.why}. A partner's endpoint must be on the public internet.`, wasItSaved: 'not_saved', nextSafeAction: 'Use the partner\'s public https address. Nothing was set up.' });
        }
        const at = deps.now();
        const version = (prior?.version ?? 0) + 1;
        // Round 10 (maker-checker): a second person approves exactly this subscription, in their own session.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: PARTNER_SUBSCRIPTION_APPROVAL, subjectRef: subscriptionId, details: actionDetails(ctx.body, { subscriptionId }), valueMinor: null,
          maker: ctx.userId, usedBy: `outbound-webhook:${subscriptionId}:v${version}`, now: at,
        });
        if (opened === undefined) {
          throw apiError(422, { code: 'partner_subscription_needs_approval', whatHappened: 'Sending the shop\'s business events to a partner needs a second person\'s approval, given in their own session for exactly this subscription (§28).', wasItSaved: 'not_saved', nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind ${PARTNER_SUBSCRIPTION_APPROVAL}, with exactly this subscription); once another person approves it, send it again with the approvalId. Nothing was set up.` });
        }
        const subscription: OutboundSubscription = {
          subscriptionId, partnerId: b['partnerId'] as string, url: b['url'] as string, eventTypes: types, signingKeyRef: b['signingKeyRef'] as string,
          maxAttempts, active: true, version, deliverFrom: prior?.deliverFrom ?? at, setBy: ctx.userId, setAt: at, approvedBy: opened.decision.decidedBy,
        };
        await opened.spend();
        await deps.record(ctx.tenantId, { change: 'subscribed', subscription }, `sub-${subscriptionId}-v${subscription.version}`);
        return { status: 201, body: { subscription } };
      },
    },
    {
      // SWITCH OFF — kept, with who and when; nothing more is sent. Switching on again is a new version (POST above).
      api: 'API-11', method: 'POST', path: '/v1/integration/outbound-webhooks/:subscriptionId/deactivate',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const { sub } = await load(ctx.tenantId, (ctx.params['subscriptionId'] ?? '').trim());
        if (!sub.active) return { status: 200, body: { subscription: sub, alreadyOff: true } };
        // A switch-off is nobody's approval: the earlier version's approver is not carried onto it.
        const was: Partial<OutboundSubscription> & OutboundSubscription = { ...sub };
        delete (was as { approvedBy?: string }).approvedBy;
        const subscription: OutboundSubscription = { ...was, active: false, version: sub.version + 1, setBy: ctx.userId, setAt: deps.now() };
        await deps.record(ctx.tenantId, { change: 'subscribed', subscription }, `sub-${sub.subscriptionId}-v${subscription.version}`);
        return { status: 200, body: { subscription } };
      },
    },
    {
      // ONE PASS now (the worker runs the same pass on its timer).
      api: 'API-11', method: 'POST', path: '/v1/integration/outbound-deliveries/drain',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        if (deps.transport === undefined) {
          throw apiError(503, { code: 'no_outbound_transport', whatHappened: 'No outbound connection to partners is configured, so nothing can be sent. Every message waits, listed in the reconciliation read.', wasItSaved: 'not_saved', nextSafeAction: 'Configure the partner transport at deployment. Nothing was sent or lost.' });
        }
        return { status: 200, body: await drainOutboundWebhooks(deps, ctx.tenantId) };
      },
    },
    {
      // RECONCILE — every message since ?from= (default: the subscription's start) with its status, and the totals.
      api: 'API-11', method: 'GET', path: '/v1/integration/outbound-webhooks/:subscriptionId/reconciliation',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const { sub, projected } = await load(ctx.tenantId, (ctx.params['subscriptionId'] ?? '').trim());
        const from = ctx.query['from'] ?? sub.deliverFrom;
        if (Number.isNaN(Date.parse(from))) throw apiError(400, { code: 'not_a_time', whatHappened: `"${from}" is not a time.`, wasItSaved: 'not_saved', nextSafeAction: 'Send ?from= as an ISO time.' });
        const rows = await ledgerView(ctx.tenantId, sub, projected.messages, from);
        const count = (s: string) => rows.filter((r) => r.status === s).length;
        return { status: 200, body: { subscription: sub, from, messages: rows, totals: { all: rows.length, delivered: count('delivered'), pending: count('pending'), deadLettered: count('dead_lettered') }, asAt: deps.now() } };
      },
    },
    {
      // DEAD LETTERS — what could not be delivered, for a person; never deleted.
      api: 'API-11', method: 'GET', path: '/v1/integration/outbound-webhooks/:subscriptionId/dead-letters',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const { sub, projected } = await load(ctx.tenantId, (ctx.params['subscriptionId'] ?? '').trim());
        const rows = (await ledgerView(ctx.tenantId, sub, projected.messages, sub.deliverFrom)).filter((r) => r.status === 'dead_lettered');
        return { status: 200, body: { subscriptionId: sub.subscriptionId, deadLetters: rows } };
      },
    },
    {
      // SEND AGAIN — a person puts a dead letter back in the queue: a new series of attempts; the old ones stay.
      api: 'API-11', method: 'POST', path: '/v1/integration/outbound-webhooks/:subscriptionId/messages/:messageId/redeliver',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const { sub, projected } = await load(ctx.tenantId, (ctx.params['subscriptionId'] ?? '').trim());
        const messageId = (ctx.params['messageId'] ?? '').trim();
        const m = projected.messages.get(`${sub.subscriptionId}\u001f${messageId}`);
        if (m === undefined || m.status !== 'dead_lettered') {
          throw apiError(409, { code: 'not_a_dead_letter', whatHappened: `Message ${messageId} is ${m?.status ?? 'not one that was attempted'}; only a dead letter is sent again by hand.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the dead letters (GET …/dead-letters). Nothing changed.' });
        }
        const series = m.series + 1;
        await deps.record(ctx.tenantId, { change: 'requeued', subscriptionId: sub.subscriptionId, messageId, series, by: ctx.userId, at: deps.now() }, `requeue-${sub.subscriptionId}-${messageId}-s${series}`);
        return { status: 200, body: { subscriptionId: sub.subscriptionId, messageId, series, requeuedBy: ctx.userId } };
      },
    },
  ];
}
