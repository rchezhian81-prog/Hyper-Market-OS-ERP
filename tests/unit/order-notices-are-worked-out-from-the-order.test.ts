import { describe, it, expect } from 'vitest';
import { orderNoticesDue, type OrderNoticeFacts } from '../../packages/storefront/src/order-notices';

// M20-FR-03: what the customer is told is worked out from the order's own facts, one notice id per order and step.

const f = (over: Partial<OrderNoticeFacts> = {}): OrderNoticeFacts => ({ orderId: 'O1', customerRef: 'c1', state: 'placed', paymentState: 'none', delivery: [], refunds: [], ...over });

describe('order notices (M20-FR-03)', () => {
  it('needs you while placed and unpaid; confirmed once paid; never for a cancelled order', () => {
    expect(orderNoticesDue(f()).map((n) => n.noticeId)).toEqual(['order-notice-O1-needs_you']);
    expect(orderNoticesDue(f({ paymentState: 'authorised', state: 'confirmed' })).map((n) => n.kind)).toEqual(['confirmed']);
    expect(orderNoticesDue(f({ state: 'cancelled' }))).toEqual([]);
    expect(orderNoticesDue(f({ paymentState: 'pending', state: 'payment_pending' }))).toEqual([]);
  });

  it('out for delivery and delivered from the driver\'s record; each refund the bank confirmed, with its amount', () => {
    const due = orderNoticesDue(f({
      paymentState: 'authorised', state: 'dispatched',
      delivery: [{ to: 'assigned', at: '1' }, { to: 'out_for_delivery', at: '2' }, { to: 'delivered', at: '3' }],
      refunds: [{ refundId: 'r1', amountMinor: 10_00, effectiveState: 'issued' }, { refundId: 'r2', amountMinor: 5_00, effectiveState: 'pending' }],
    }));
    expect(due.map((n) => n.noticeId)).toEqual(['order-notice-O1-confirmed', 'order-notice-O1-out_for_delivery', 'order-notice-O1-delivered', 'order-notice-O1-refund_issued-r1']);
    expect(due[3]).toMatchObject({ templateId: 'order-refunded', values: { orderId: 'O1', amount: '₹10.00' } });
  });
});
