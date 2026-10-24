import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { seedOnlineShop, listShopOnline, callsFor, OWNER, MANAGER, CHECKER, CASHIER, CUSTOMER, OTHER_CUSTOMER, STORE } from '../support/online-shop';
import { sentWithApproval } from '../support/approval-request';

// M20-FR-03 ("notifications") · M31-FR-03/04 · P-08. What a customer is told about their own online order is worked out
// from the order's own facts — needs you, confirmed, delivered, refund issued — and handed to the SERVICE-message queue,
// which decides whether it may go (an approved template, their own consent, the budget, the do-not-contact register). A
// notice the queue refuses is kept with the queue's own words for staff — never dropped silently. Each is queued once.
// In memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
interface Notices { notices: { noticeId: string; kind: string; outcome: string; code?: string; detail: string; customerRef: string }[]; notQueued: { noticeId: string; code?: string }[]; detail: string }

describe.each(backings)('the customer is told where their order is (M20-FR-03) — on $name', ({ harness }) => {
  it('needs you → confirmed → delivered → refunded, each queued once through the consent-checked queue; refused ones said; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    const c = callsFor(() => h, T);
    const { req, ok } = c;
    await seedOnlineShop(h, T, c);
    await listShopOnline(c);
    const run = async () => (await ok(req('POST', '/v1/storefront/order-notices/run', {}, MANAGER), 'notices run')).body as { queued: number; notQueued: number };
    const read = async (hh = h) => { const r = await hh.request({ method: 'GET', path: '/v1/storefront/order-notices', userId: MANAGER, tenantId: T }); expect(r.status).toBe(200); return r.body as Notices; };

    // Two customers place orders with no payment yet (the app pays after) — each order needs them.
    for (const [orderId, who] of [['ORD-N1', CUSTOMER], ['ORD-N2', OTHER_CUSTOMER]] as const) {
      await ok(req('POST', `/v1/storefront/orders/${orderId}`, { lines: [{ productId: 'MILK', quantityMinor: 1 }], locationId: STORE }, who), `place ${orderId}`);
    }
    // No approved template yet: not queued, and said.
    expect(await run()).toEqual({ queued: 0, notQueued: 2 });
    const first = await read();
    expect(first.notQueued.map((n) => n.code)).toEqual(['template_not_approved', 'template_not_approved']);
    expect(first.detail).toMatch(/^2 notice\(s\) could not be queued — each says why/);
    // A second pass with the same reason records nothing new.
    expect(await run()).toEqual({ queued: 0, notQueued: 0 });

    // The owner's words, approved by a second person; a budget; one customer says yes to order updates.
    const words: Record<string, string> = {
      'order-needs-you': 'SRE: your order {orderId} needs you — please look in the app. (synthetic)',
      'order-confirmed': 'SRE: your order {orderId} is confirmed. (synthetic)',
      'order-delivered': 'SRE: your order {orderId} was delivered. (synthetic)',
      'order-refunded': 'SRE: we refunded {amount} on order {orderId}. (synthetic)',
    };
    for (const [id, body] of Object.entries(words)) {
      await ok(req('POST', `/v1/notifications/templates/${id}`, { purpose: 'transactional', channel: 'sms', body }, MANAGER), `draft ${id}`);
      await ok(req('POST', `/v1/notifications/templates/${id}/approval`, { version: 1 }, CHECKER), `approve ${id}`);
    }
    await ok(req('POST', '/v1/notifications/budget', { capMinor: 100_000, costMinorByChannel: { sms: 25 } }, OWNER), 'budget');
    await ok(req('POST', '/v1/me/privacy/consent', { purpose: 'transactional', channel: 'sms', given: true }, CUSTOMER), 'consent');
    // The other customer asked the shop never to message them (the do-not-contact register is absolute).
    await ok(req('POST', `/v1/notifications/suppressions/${OTHER_CUSTOMER}`, { channel: 'all', reason: 'asked at the desk (synthetic)', source: 'customer_request' }, OWNER), 'do not contact');

    expect(await run()).toEqual({ queued: 1, notQueued: 1 });
    const second = await read();
    expect(second.notices.find((n) => n.noticeId === 'order-notice-ORD-N1-needs_you')).toMatchObject({ outcome: 'queued', kind: 'needs_you', customerRef: CUSTOMER });
    // The other customer is on the do-not-contact register: the queue refuses, in its own words, and staff see it.
    const refused = second.notQueued.find((n) => n.noticeId === 'order-notice-ORD-N2-needs_you')!;
    expect(refused.code).toBe('customer_suppressed');

    // The desk takes the payment, the order goes out and arrives, and a goodwill refund is issued.
    await ok(req('POST', '/v1/orders/ORD-N1/payment', { providerRef: 'tok_n1', amountMinor: 60_00, result: 'authorised' }, MANAGER), 'pay');
    for (const event of ['confirm', 'pick', 'pack', 'dispatch', 'deliver']) await ok(req('POST', '/v1/orders/ORD-N1/transition', { event }), `ORD-N1 ${event}`);
    const refundBody = { refundId: 'rf-n1', amountMinor: 10_00, basis: 'goodwill', reason: 'late (synthetic)' };
    const refunded = await sentWithApproval(h, T, MANAGER, OWNER, { kind: 'order_refund', subjectRef: 'ORD-N1/rf-n1', pathIds: { orderId: 'ORD-N1' }, valueMinor: 10_00 }, refundBody,
      (b) => h.request({ method: 'POST', path: '/v1/orders/ORD-N1/refunds', userId: MANAGER, tenantId: T, idempotencyKey: 'refund-rf-n1', body: b }));
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);

    expect(await run()).toEqual({ queued: 3, notQueued: 0 });
    const third = await read();
    for (const id of ['order-notice-ORD-N1-confirmed', 'order-notice-ORD-N1-delivered', 'order-notice-ORD-N1-refund_issued-rf-n1']) {
      expect(third.notices.find((n) => n.noticeId === id)?.outcome, id).toBe('queued');
    }
    // Once: a pass more queues nothing. On the queue: rendered from the approved words, for this customer.
    expect(await run()).toEqual({ queued: 0, notQueued: 0 });
    const pending = (await req('GET', '/v1/notifications/queue/pending', undefined, OWNER)).body as { pending?: { id: string }[]; items?: { id: string }[] };
    const ids = JSON.stringify(pending);
    for (const id of ['order-notice-ORD-N1-needs_you', 'order-notice-ORD-N1-confirmed', 'order-notice-ORD-N1-delivered', 'order-notice-ORD-N1-refund_issued-rf-n1']) expect(ids).toContain(id);
    expect(ids).not.toContain('order-notice-ORD-N2');

    expect((await req('GET', '/v1/storefront/order-notices', undefined, CASHIER)).status).toBe(403);
    // A cold restart reads the same register.
    const again = await read(harness(h));
    expect(again.notices.filter((n) => n.outcome === 'queued')).toHaveLength(4);
  });
});
