// Order-status notices for the customer (M20-FR-03 "notifications" · WF-13/WF-15 · P-08).
//
// What the customer is told about their own online order, worked out from the order's own facts — never typed in:
// confirmed (the bank confirmed the payment), needs you (the shop could not promise everything, or a repeat order waits
// for payment), out for delivery and delivered (the driver's record), and each refund the bank confirmed. Each notice has
// one id per order and step, so it is queued once however often the pass comes round. Whether it may go — an approved
// template, the customer's own consent for service messages, the budget, the do-not-contact register — is the
// notification queue's decision at enqueue and again at send; this only says what is due.
//
// Pure and deterministic.

export type OrderNoticeKind = 'confirmed' | 'needs_you' | 'out_for_delivery' | 'delivered' | 'refund_issued';
export const ORDER_NOTICE_KINDS: readonly OrderNoticeKind[] = ['confirmed', 'needs_you', 'out_for_delivery', 'delivered', 'refund_issued'];

/** The register template each notice is sent with — approved by two people in the template register (M31-FR-04). */
export const ORDER_NOTICE_TEMPLATE: Readonly<Record<OrderNoticeKind, string>> = {
  confirmed: 'order-confirmed', needs_you: 'order-needs-you', out_for_delivery: 'order-out-for-delivery', delivered: 'order-delivered', refund_issued: 'order-refunded',
};

export interface OrderNoticeFacts {
  readonly orderId: string;
  readonly customerRef: string;
  /** The order's lifecycle state now. */
  readonly state: string;
  /** The payment as the shop holds it: none / pending / authorised / declined. */
  readonly paymentState: string;
  /** The driver's recorded steps, oldest first. */
  readonly delivery: readonly { readonly to: string; readonly at: string }[];
  /** Refunds and what the bank said. */
  readonly refunds: readonly { readonly refundId: string; readonly amountMinor: number; readonly effectiveState: string }[];
}

export interface DueNotice {
  readonly noticeId: string;
  readonly orderId: string;
  readonly customerRef: string;
  readonly kind: OrderNoticeKind;
  readonly templateId: string;
  /** The template's placeholders. */
  readonly values: Readonly<Record<string, string>>;
}

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/** Every notice an order's facts call for now (already-sent ones are the caller's to skip, by id). */
export function orderNoticesDue(f: OrderNoticeFacts): readonly DueNotice[] {
  const out: DueNotice[] = [];
  const add = (kind: OrderNoticeKind, suffix: string, values: Record<string, string> = {}): void => {
    out.push({ noticeId: `order-notice-${f.orderId}-${kind}${suffix}`.slice(0, 120), orderId: f.orderId, customerRef: f.customerRef, kind, templateId: ORDER_NOTICE_TEMPLATE[kind], values: { orderId: f.orderId, ...values } });
  };
  const cancelled = f.state === 'cancelled';
  if (!cancelled && f.paymentState === 'none' && f.state === 'placed') add('needs_you', '');
  if (!cancelled && f.paymentState === 'authorised') add('confirmed', '');
  if (f.delivery.some((d) => d.to === 'out_for_delivery')) add('out_for_delivery', '');
  if (f.delivery.some((d) => d.to === 'delivered') || f.state === 'delivered') add('delivered', '');
  for (const r of f.refunds) if (r.effectiveState === 'issued') add('refund_issued', `-${r.refundId}`, { amount: rupees(r.amountMinor) });
  return out;
}
