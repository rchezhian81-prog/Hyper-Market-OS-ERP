// The order's payment and refunds on API-07 — M18-FR-04 · M20-FR-03 · §28 · §31 · hard rules #2, #3, #10.
//
// The cloud half of the checkout hop and the "refund surface" the substitution and cancellation paths have
// been recording a refund DUE towards. The rules live in `packages/orders/src/payment-refunds.ts`; this file
// reads bodies strictly, refuses before any money moves, calls the processor port exactly once per refund,
// and records what came back as it came back.
//
//   • a payment is recorded ONCE per order, as the checkout answered it; a card-shaped reference is refused
//     unrecorded (#3); an `unknown` answer leaves the order payment-PENDING, and the lifecycle refuses to
//     confirm or pick it (§31 — nothing is picked against a payment that may not exist);
//   • a refund goes to the ORDER'S token, never one in the request; it is planned from recorded facts and
//     approved per policy (§28) before the processor is asked; the processor's `unknown` is a PENDING refund,
//     shown on a worklist until the statement says which way it went — never reported as done (#10).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  looksLikeCardNumber, paymentPosition, refundPosition, planOrderRefund, refundMessage, foldRefunds,
  type OrderPayment, type OrderPaymentResolution, type OrderRefund, type OrderRefundOutcome, type RefundBasis,
  type RefundProcessor, type PaymentResult,
} from '../../../packages/orders/src/payment-refunds';
import { DEFAULT_REFUND_THRESHOLD_MINOR } from '../../../packages/returns/src/assess-return';
import type { OrderStateView, StoredSubstitution } from './index';

export interface PaymentRefundDeps {
  readonly now: () => string;
  readonly orderState: (tenantId: string, orderId: string) => Promise<OrderStateView | undefined> | OrderStateView | undefined;
  readonly orderSubstitutions: (tenantId: string, orderId: string) => Promise<readonly StoredSubstitution[]> | readonly StoredSubstitution[];
  readonly orderPayment: (tenantId: string, orderId: string) => Promise<OrderPayment | undefined> | OrderPayment | undefined;
  readonly paymentResolution: (tenantId: string, orderId: string) => Promise<OrderPaymentResolution | undefined> | OrderPaymentResolution | undefined;
  readonly recordPayment: (tenantId: string, p: OrderPayment) => Promise<void> | void;
  readonly recordPaymentResolution: (tenantId: string, r: OrderPaymentResolution) => Promise<void> | void;
  readonly orderRefunds: (tenantId: string, orderId: string) => Promise<readonly OrderRefund[]> | readonly OrderRefund[];
  readonly refundOutcomes: (tenantId: string, orderId: string) => Promise<readonly OrderRefundOutcome[]> | readonly OrderRefundOutcome[];
  readonly recordRefund: (tenantId: string, r: OrderRefund) => Promise<void> | void;
  readonly recordRefundOutcome: (tenantId: string, o: OrderRefundOutcome) => Promise<void> | void;
  /** Tenant-wide, for the worklist: every payment and refund recorded, and every refund outcome. */
  readonly allPayments: (tenantId: string) => Promise<readonly OrderPayment[]> | readonly OrderPayment[];
  readonly allPaymentResolutions: (tenantId: string) => Promise<readonly OrderPaymentResolution[]> | readonly OrderPaymentResolution[];
  readonly allRefunds: (tenantId: string) => Promise<readonly OrderRefund[]> | readonly OrderRefund[];
  readonly allRefundOutcomes: (tenantId: string) => Promise<readonly OrderRefundOutcome[]> | readonly OrderRefundOutcome[];
  /** The tenant's refund approval threshold (M13-FR-03 policy, shared) — undefined means the default (every refund). */
  readonly refundThreshold: (tenantId: string) => Promise<number | undefined> | number | undefined;
  readonly holdsPermission: (tenantId: string, userId: string, permission: string) => Promise<boolean> | boolean;
  readonly refundProcessor: RefundProcessor;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAYMENT_RESULTS: readonly PaymentResult[] = ['authorised', 'declined', 'unknown'];
const BASES: readonly RefundBasis[] = ['cancellation', 'substitution', 'short_pick', 'goodwill'];

export function paymentRefundRoutes(deps: PaymentRefundDeps): readonly Route[] {
  const orderOr404 = async (tenantId: string, orderId: string): Promise<OrderStateView> => {
    const state = await deps.orderState(tenantId, orderId);
    if (state === undefined) {
      throw apiError(404, {
        code: 'order_unknown',
        whatHappened: `No order "${orderId}" has been placed.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Check the order reference. Nothing was changed.',
      });
    }
    return state;
  };
  const position = async (tenantId: string, orderId: string) => {
    const payment = paymentPosition(await deps.orderPayment(tenantId, orderId), await deps.paymentResolution(tenantId, orderId));
    const refunds = refundPosition({ payment, refunds: await deps.orderRefunds(tenantId, orderId), outcomes: await deps.refundOutcomes(tenantId, orderId) });
    return { payment, refunds };
  };

  return [
    {
      // Record the checkout's payment answer against the order — once (M20-FR-03 → M18). Body:
      // { providerRef, amountMinor, result: authorised|declined|unknown, reason? }.
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/payment',
      permission: 'order.payment.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        await orderOr404(ctx.tenantId, orderId);
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['providerRef']) || !Number.isInteger(b['amountMinor']) || (b['amountMinor'] as number) < 0
          || !PAYMENT_RESULTS.includes(b['result'] as PaymentResult) || (b['reason'] !== undefined && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_payment',
            whatHappened: 'A payment record needs { providerRef, amountMinor (paise, whole), result: authorised | declined | unknown, reason? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Send the checkout\'s answer as it came.',
          });
        }
        if (looksLikeCardNumber(b['providerRef'] as string)) {
          throw apiError(422, {
            code: 'not_a_provider_token',
            whatHappened: 'The payment reference looks like a card number. Only a provider token may be recorded (hard rule #3).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Send the provider\'s token for this payment, never the card.',
          });
        }
        const existing = await deps.orderPayment(ctx.tenantId, orderId);
        if (existing !== undefined) {
          throw apiError(409, {
            code: 'payment_already_recorded',
            whatHappened: `Order "${orderId}" already has a payment recorded (${existing.result}). A payment is recorded once; a later answer from the bank is a resolution.`,
            wasItSaved: 'not_saved',
            nextSafeAction: existing.result === 'unknown' ? 'Record what the bank finally said with POST …/payment/resolution.' : 'Nothing was changed.',
          });
        }
        const payment: OrderPayment = {
          orderId, providerRef: b['providerRef'] as string, amountMinor: b['amountMinor'] as number, result: b['result'] as PaymentResult,
          ...(isStr(b['reason']) ? { reason: b['reason'] } : {}),
          recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordPayment(ctx.tenantId, payment);
        const pos = paymentPosition(payment, undefined);
        return { status: 201, body: { orderId, payment: pos, ...(pos.state === 'pending' ? { tellTheCustomer: 'We are waiting for your bank to confirm the payment. Your order is not placed yet and we will not pick it until we know.' } : {}) } };
      },
    },
    {
      // What the bank finally said about a payment that was unknown at checkout. Body: { result, evidenceRef }.
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/payment/resolution',
      permission: 'order.payment.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        await orderOr404(ctx.tenantId, orderId);
        const b = ctx.body;
        if (!isObj(b) || (b['result'] !== 'authorised' && b['result'] !== 'declined') || !isStr(b['evidenceRef'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_resolution',
            whatHappened: 'A payment resolution needs { result: authorised | declined, evidenceRef } — the statement line or provider reference it rests on.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded.',
          });
        }
        const payment = await deps.orderPayment(ctx.tenantId, orderId);
        const prior = await deps.paymentResolution(ctx.tenantId, orderId);
        if (payment === undefined || payment.result !== 'unknown' || prior !== undefined) {
          throw apiError(409, {
            code: 'no_pending_payment',
            whatHappened: payment === undefined ? `Order "${orderId}" has no payment recorded.` : prior !== undefined ? 'This payment was already resolved; the first resolution stands.' : `This payment was ${payment.result} at checkout; there is nothing to resolve.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed.',
          });
        }
        const resolution: OrderPaymentResolution = { orderId, result: b['result'] as 'authorised' | 'declined', evidenceRef: b['evidenceRef'] as string, resolvedBy: ctx.userId, resolvedAt: deps.now() };
        await deps.recordPaymentResolution(ctx.tenantId, resolution);
        return { status: 200, body: { orderId, payment: paymentPosition(payment, resolution), ...(resolution.result === 'declined' ? { nextSafeAction: 'The bank did not pay. Cancel the order so its stock is released; nothing has been charged.' } : {}) } };
      },
    },
    {
      // Issue a refund against the order's own token (M18-FR-04). Body: { refundId, amountMinor, basis, reason, approvedBy? }.
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/refunds',
      permission: 'order.refund.issue', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        await orderOr404(ctx.tenantId, orderId);
        const b = ctx.body;
        if (!isObj(b) || !isStr(b['refundId']) || !Number.isInteger(b['amountMinor']) || !BASES.includes(b['basis'] as RefundBasis) || !isStr(b['reason'])
          || (b['approvedBy'] !== undefined && !isStr(b['approvedBy']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_refund',
            whatHappened: 'A refund needs { refundId, amountMinor (paise, whole), basis: cancellation | substitution | short_pick | goodwill, reason, approvedBy? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was sent to the provider and nothing was recorded.',
          });
        }
        const refundId = b['refundId'] as string;
        const amountMinor = b['amountMinor'] as number;
        const existing = (await deps.orderRefunds(ctx.tenantId, orderId)).find((r) => r.refundId === refundId);
        if (existing !== undefined) {
          if (existing.amountMinor === amountMinor && existing.basis === b['basis']) {
            const pos = await position(ctx.tenantId, orderId);
            return { status: 200, body: { refund: pos.refunds.refunds.find((r) => r.refundId === refundId), position: pos.refunds, alreadyRecorded: true } };
          }
          throw apiError(409, {
            code: 'refund_id_reused',
            whatHappened: `Refund "${refundId}" is already recorded on this order for a different amount or basis.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new refund id. Nothing was sent.',
          });
        }
        const { payment, refunds } = await position(ctx.tenantId, orderId);
        const substitutions = await deps.orderSubstitutions(ctx.tenantId, orderId);
        const approvedBy = isStr(b['approvedBy']) ? b['approvedBy'] : undefined;
        const plan = planOrderRefund({
          payment, position: refunds, amountMinor, basis: b['basis'] as RefundBasis,
          substitutionRefundDueMinor: substitutions.reduce((t, s) => t + s.refundMinor, 0),
          requestedBy: ctx.userId,
          ...(approvedBy === undefined ? {} : { approvedBy }),
          approverHoldsAuthority: approvedBy === undefined ? false : await deps.holdsPermission(ctx.tenantId, approvedBy, 'order.refund.approve'),
          approvalThresholdMinor: (await deps.refundThreshold(ctx.tenantId)) ?? DEFAULT_REFUND_THRESHOLD_MINOR,
        });
        if (!plan.ok) {
          throw apiError(409, {
            code: plan.refusedBecause ?? 'refund_refused',
            whatHappened: `The refund was not sent: ${plan.detail}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. Correct the request — or, for an approval finding, have a second person with refund-approval authority approve it.',
          });
        }
        // The money moves here — against the ORDER's token, once. Whatever the processor says is recorded as it said it.
        const answer = await deps.refundProcessor.refund({ refundId, providerRef: payment.providerRef!, amountMinor, currency: 'INR' });
        const state = answer.result === 'refunded' ? 'issued' : answer.result === 'declined' ? 'refused' : 'pending';
        const refund: OrderRefund = {
          refundId, orderId, amountMinor, basis: b['basis'] as RefundBasis, reason: b['reason'] as string, requestedBy: ctx.userId,
          ...(approvedBy === undefined ? {} : { approvedBy }),
          providerOutcome: answer.result, state,
          ...(answer.providerRefundRef === undefined ? {} : { providerRefundRef: answer.providerRefundRef }),
          ...(answer.detail === undefined ? {} : { providerDetail: answer.detail }),
          at: deps.now(),
        };
        await deps.recordRefund(ctx.tenantId, refund);
        const after = await position(ctx.tenantId, orderId);
        return { status: 201, body: { refund: { ...refund, effectiveState: state }, position: after.refunds, tellTheCustomer: refundMessage(state, amountMinor) } };
      },
    },
    {
      // The provider's final word on a pending refund, from its statement. Body: { result: refunded | declined, evidenceRef }.
      api: 'API-07', method: 'POST', path: '/v1/orders/:orderId/refunds/:refundId/outcome',
      permission: 'order.refund.issue', idempotent: true,
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const refundId = ctx.params['refundId'] ?? '';
        await orderOr404(ctx.tenantId, orderId);
        const b = ctx.body;
        if (!isObj(b) || (b['result'] !== 'refunded' && b['result'] !== 'declined') || !isStr(b['evidenceRef'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_outcome',
            whatHappened: 'A refund outcome needs { result: refunded | declined, evidenceRef } — the statement line it rests on.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded.',
          });
        }
        const views = foldRefunds(await deps.orderRefunds(ctx.tenantId, orderId), await deps.refundOutcomes(ctx.tenantId, orderId));
        const refund = views.find((r) => r.refundId === refundId);
        if (refund === undefined) {
          throw apiError(404, {
            code: 'refund_unknown',
            whatHappened: `No refund "${refundId}" is recorded on order "${orderId}".`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the refund reference. Nothing was changed.',
          });
        }
        if (refund.effectiveState !== 'pending') {
          throw apiError(409, {
            code: 'refund_not_pending',
            whatHappened: `Refund "${refundId}" is ${refund.effectiveState}; only a pending refund takes an outcome, and the first outcome stands.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed.',
          });
        }
        const outcome: OrderRefundOutcome = { refundId, orderId, result: b['result'] as 'refunded' | 'declined', evidenceRef: b['evidenceRef'] as string, resolvedBy: ctx.userId, at: deps.now() };
        await deps.recordRefundOutcome(ctx.tenantId, outcome);
        const after = await position(ctx.tenantId, orderId);
        const finalState = outcome.result === 'refunded' ? 'issued' : 'refused';
        return { status: 200, body: { refund: after.refunds.refunds.find((r) => r.refundId === refundId), position: after.refunds, tellTheCustomer: refundMessage(finalState, refund.amountMinor) } };
      },
    },
    {
      // Every payment still unknown and every refund still pending, tenant-wide — the worklist (P-08, #10).
      // Registered BEFORE the parameterised read below, as the substitution-exception read is.
      api: 'API-07', method: 'GET', path: '/v1/orders/refunds/pending',
      permission: 'order.read',
      handler: async (ctx) => {
        const resolved = new Set((await deps.allPaymentResolutions(ctx.tenantId)).map((r) => r.orderId));
        const pendingPayments = (await deps.allPayments(ctx.tenantId)).filter((p) => p.result === 'unknown' && !resolved.has(p.orderId));
        const pendingRefunds = foldRefunds(await deps.allRefunds(ctx.tenantId), await deps.allRefundOutcomes(ctx.tenantId)).filter((r) => r.effectiveState === 'pending');
        return {
          status: 200,
          body: {
            pendingPayments, pendingRefunds,
            pendingRefundMinor: pendingRefunds.reduce((t, r) => t + r.amountMinor, 0),
            detail: pendingPayments.length === 0 && pendingRefunds.length === 0
              ? 'nothing is waiting on a bank'
              : `${pendingPayments.length} payment(s) and ${pendingRefunds.length} refund(s) are waiting on the bank's word — each needs its statement line recorded`,
          },
        };
      },
    },
    {
      // The order's money position: what was paid, what was refunded, what is pending, what is still refundable.
      api: 'API-07', method: 'GET', path: '/v1/orders/:orderId/refunds',
      permission: 'order.read',
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        await orderOr404(ctx.tenantId, orderId);
        const pos = await position(ctx.tenantId, orderId);
        return { status: 200, body: { orderId, payment: pos.payment, position: pos.refunds } };
      },
    },
  ];
}
