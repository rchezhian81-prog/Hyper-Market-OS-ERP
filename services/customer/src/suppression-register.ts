// API-06 — the DO-NOT-CONTACT (suppression) register (M31-FR-04 "retry, SUPPRESSION, cost and template approval" ·
// M21-FR-01 · D07-FR-02 · DPDP · P-04 · hard rules #2, #6 — OB-288 P5).
//
// Until now "suppressed" was a flag the CALLER sent to `/v1/notifications/can-send`: nothing stored that a customer had
// asked never to be contacted, so the next campaign could message them again. This is the stored register:
//
//   • ADD (`POST /v1/notifications/suppressions/:customerId`) — { channel (sms / whatsapp / email / push / all), reason,
//     source (customer_request / staff / provider_bounce / complaint) }. The person recording it is the caller.
//   • LIFT (`POST /v1/notifications/suppressions/:customerId/lift`) — { channel, reason }: only by a person, with a reason;
//     the suppression stays on the record (append-only), a later fact lifts it.
//   • READ (`GET /v1/notifications/suppressions`) — who is suppressed now, on which channels, and every fact behind it.
//
// Suppression is ABSOLUTE (`packages/notifications` guard): the send guard, the queue at enqueue AND at send, and the
// campaign plan and send all read this register — a suppressed contact is never messaged, whatever the purpose, and a
// message already waiting for them is withheld, kept and visible. Pure fold below; nothing is deleted.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export const SUPPRESSION_CHANNELS = ['sms', 'whatsapp', 'email', 'push', 'all'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];
export const SUPPRESSION_SOURCES = ['customer_request', 'staff', 'provider_bounce', 'complaint'] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

/** One append-only fact on the register. */
export interface SuppressionFact {
  readonly change: 'suppressed' | 'lifted';
  readonly factId: string;
  readonly customerId: string;
  readonly channel: SuppressionChannel;
  readonly reason: string;
  readonly source?: SuppressionSource;
  readonly by: string;
  readonly at: string;
}

/** The channels a customer is suppressed on now (latest fact per channel wins; `all` covers every channel). */
export function suppressedChannels(facts: readonly SuppressionFact[], customerId: string): ReadonlySet<SuppressionChannel> {
  const latest = new Map<SuppressionChannel, SuppressionFact>();
  for (const f of facts) if (f.customerId === customerId) latest.set(f.channel, f);
  return new Set([...latest.values()].filter((f) => f.change === 'suppressed').map((f) => f.channel));
}

/** Is this customer suppressed on this channel now? */
export function isSuppressed(facts: readonly SuppressionFact[], customerId: string, channel: string): { readonly suppressed: boolean; readonly by?: SuppressionFact } {
  const on = suppressedChannels(facts, customerId);
  if (!on.has('all') && !on.has(channel as SuppressionChannel)) return { suppressed: false };
  const by = [...facts].reverse().find((f) => f.customerId === customerId && f.change === 'suppressed' && on.has(f.channel) && (f.channel === 'all' || f.channel === channel));
  return by === undefined ? { suppressed: true } : { suppressed: true, by };
}

export interface SuppressionDeps {
  readonly facts: (tenantId: string) => Promise<readonly SuppressionFact[]> | readonly SuppressionFact[];
  readonly record: (tenantId: string, fact: SuppressionFact) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function suppressionRoutes(deps: SuppressionDeps): readonly Route[] {
  const read = (body: unknown, needSource: boolean) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const ok = SUPPRESSION_CHANNELS.includes(b['channel'] as SuppressionChannel) && isStr(b['reason']) && (b['reason'] as string).length <= 500
      && (!needSource || SUPPRESSION_SOURCES.includes(b['source'] as SuppressionSource));
    return ok ? { channel: b['channel'] as SuppressionChannel, reason: (b['reason'] as string).trim(), ...(needSource ? { source: b['source'] as SuppressionSource } : {}) } : undefined;
  };
  return [
    {
      api: 'API-06', method: 'POST', path: '/v1/notifications/suppressions/:customerId',
      permission: 'notification.suppression.manage', idempotent: true,
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const r = read(ctx.body, true);
        if (customerId === '' || r === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_suppression', whatHappened: `A do-not-contact entry needs { channel (${SUPPRESSION_CHANNELS.join(' / ')}), reason, source (${SUPPRESSION_SOURCES.join(' / ')}) }.`, wasItSaved: 'not_saved', nextSafeAction: 'Say which channel, why, and who asked. Nothing was recorded.' });
        }
        const facts = await deps.facts(ctx.tenantId);
        if (suppressedChannels(facts, customerId).has(r.channel)) return { status: 200, body: { customerId, channel: r.channel, alreadySuppressed: true } };
        const at = deps.now();
        const fact: SuppressionFact = { change: 'suppressed', factId: `sup-${customerId}-${r.channel}-${facts.filter((f) => f.customerId === customerId).length + 1}`, customerId, channel: r.channel, reason: r.reason, source: r.source!, by: ctx.userId, at };
        await deps.record(ctx.tenantId, fact);
        return { status: 201, body: { suppression: fact, detail: `Nothing more is sent to ${customerId} on ${r.channel === 'all' ? 'any channel' : r.channel}; a message already waiting is withheld by the sender, kept and visible.` } };
      },
    },
    {
      api: 'API-06', method: 'POST', path: '/v1/notifications/suppressions/:customerId/lift',
      permission: 'notification.suppression.manage', idempotent: true,
      handler: async (ctx) => {
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const r = read(ctx.body, false);
        if (customerId === '' || r === undefined) {
          throw apiError(400, { code: 'not_readable_as_a_lift', whatHappened: `Lifting a do-not-contact entry needs { channel (${SUPPRESSION_CHANNELS.join(' / ')}), reason }.`, wasItSaved: 'not_saved', nextSafeAction: 'Say which channel and why it may be used again. Nothing was changed.' });
        }
        const facts = await deps.facts(ctx.tenantId);
        if (!suppressedChannels(facts, customerId).has(r.channel)) {
          throw apiError(409, { code: 'not_suppressed', whatHappened: `${customerId} is not on the do-not-contact register for ${r.channel}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const fact: SuppressionFact = { change: 'lifted', factId: `sup-${customerId}-${r.channel}-${facts.filter((f) => f.customerId === customerId).length + 1}`, customerId, channel: r.channel, reason: r.reason, by: ctx.userId, at: deps.now() };
        await deps.record(ctx.tenantId, fact);
        return { status: 200, body: { lifted: fact, detail: 'The earlier entry stays on the record; consent is still checked before every message.' } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/notifications/suppressions',
      permission: 'notification.send.check',
      handler: async (ctx) => {
        const facts = await deps.facts(ctx.tenantId);
        const customers = [...new Set(facts.map((f) => f.customerId))].sort();
        return {
          status: 200,
          body: {
            suppressed: customers.map((c) => ({ customerId: c, channels: [...suppressedChannels(facts, c)].sort() })).filter((x) => x.channels.length > 0),
            facts, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
