// API-07 Order-status notices (M20-FR-03 "notifications" · M31-FR-03/04 · P-08 · hard rule #6).
//
// A pass over the shop's online orders works out what each customer should be told (`orderNoticesDue`: confirmed, needs
// you, out for delivery, delivered, refund issued) and hands each notice to the SERVICE-message queue — the one queue that
// checks an approved template, the customer's own consent, the budget and the do-not-contact register at enqueue and again
// at send. A notice the queue took is recorded once; one it refused is recorded with the queue's own words (and again only
// when the reason changes) — visible to staff, never silently dropped. It runs on head office's timer and on demand.

import type { Route } from '../../kernel/src/index';
import { orderNoticesDue, type DueNotice, type OrderNoticeFacts } from '../../../packages/storefront/src/order-notices';

export interface OrderNoticeFact {
  readonly noticeId: string;
  readonly orderId: string;
  readonly customerRef: string;
  readonly kind: DueNotice['kind'];
  readonly outcome: 'queued' | 'not_queued';
  /** The queue's refusal code, when not queued. */
  readonly code?: string;
  readonly detail: string;
  readonly channel?: string;
  readonly at: string;
}

export interface OrderNoticeDeps {
  /** Every online order a customer placed (the storefront's own index). */
  readonly onlineOrders: (tenantId: string) => Promise<readonly { readonly orderId: string; readonly customerRef: string }[]>;
  readonly facts: (tenantId: string, order: { readonly orderId: string; readonly customerRef: string }) => Promise<OrderNoticeFacts | undefined>;
  /** Hand one notice to the service-message queue; its answer, as the queue gave it. */
  readonly enqueue: (tenantId: string, notice: DueNotice) => Promise<{ readonly queued: true; readonly channel: string } | { readonly queued: false; readonly code: string; readonly detail: string }>;
  readonly notices: (tenantId: string) => Promise<readonly OrderNoticeFact[]>;
  readonly recordNotice: (tenantId: string, f: OrderNoticeFact) => Promise<void>;
  readonly now: () => string;
}

export async function runOrderNotices(deps: OrderNoticeDeps, tenantId: string): Promise<{ readonly queued: number; readonly notQueued: number }> {
  const held = await deps.notices(tenantId);
  const queued = new Set(held.filter((n) => n.outcome === 'queued').map((n) => n.noticeId));
  const lastRefusal = new Map<string, string>();
  for (const n of held) if (n.outcome === 'not_queued') lastRefusal.set(n.noticeId, n.code ?? '');
  let q = 0;
  let nq = 0;
  for (const order of await deps.onlineOrders(tenantId)) {
    const facts = await deps.facts(tenantId, order);
    if (facts === undefined) continue;
    for (const notice of orderNoticesDue(facts)) {
      if (queued.has(notice.noticeId)) continue;
      const r = await deps.enqueue(tenantId, notice);
      const at = deps.now();
      if (r.queued) {
        await deps.recordNotice(tenantId, { noticeId: notice.noticeId, orderId: notice.orderId, customerRef: notice.customerRef, kind: notice.kind, outcome: 'queued', channel: r.channel, detail: `queued on ${r.channel}`, at });
        q += 1;
      } else if (lastRefusal.get(notice.noticeId) !== r.code) {
        await deps.recordNotice(tenantId, { noticeId: notice.noticeId, orderId: notice.orderId, customerRef: notice.customerRef, kind: notice.kind, outcome: 'not_queued', code: r.code, detail: r.detail, at });
        lastRefusal.set(notice.noticeId, r.code);
        nq += 1;
      }
    }
  }
  return { queued: q, notQueued: nq };
}

export function orderNoticeRoutes(deps: OrderNoticeDeps): readonly Route[] {
  return [
    {
      // Staff: every order notice and what became of it — queued, or not queued and why (the latest per notice).
      api: 'API-07', method: 'GET', path: '/v1/storefront/order-notices',
      permission: 'order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const latest = new Map<string, OrderNoticeFact>();
        for (const n of await deps.notices(ctx.tenantId)) latest.set(n.noticeId, n);
        const all = [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
        const notQueued = all.filter((n) => n.outcome === 'not_queued');
        return {
          status: 200,
          body: {
            notices: all, notQueued,
            detail: notQueued.length === 0 ? 'Every order notice due so far is on the message queue.' : `${notQueued.length} notice(s) could not be queued — each says why (a template, consent, the budget or the do-not-contact register).`,
          },
        };
      },
    },
    {
      // Staff: work the notices out now (they also go on head office's timer).
      api: 'API-07', method: 'POST', path: '/v1/storefront/order-notices/run',
      permission: 'order.exception.manage', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await runOrderNotices(deps, ctx.tenantId) }),
    },
  ];
}
