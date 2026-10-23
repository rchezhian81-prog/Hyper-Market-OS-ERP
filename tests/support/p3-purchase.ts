// OB-288 P3: one synthetic shop's procure-to-pay chain, driven through the real routes by DIFFERENT people for each step
// (§28) — the buyer raises, the owner issues, the receiver books it in, the buyer captures the bill, the accountant matches
// it, a second accountant pays it with a third person's approval. Synthetic data only.

import type { ApiHarness } from './api-harness';
import { approvedSuppliers, deliveryPlaces } from './approved-supplier';
import { sentWithApproval } from './approval-request';

export const P3 = {
  OWNER: 'u-owner', BUYER: 'u-buyer', RECEIVER: 'u-recv', MATCHER: 'u-match', PAYER: 'u-pay', PAY_APPROVER: 'u-pay-ok', CASHIER: 'u-cash',
  STORE: 'store-1', BACK: 'wh-1',
} as const;

export type Call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) => Promise<{ readonly status: number; readonly body: unknown }>;

export function caller(h: ApiHarness, T: string): Call {
  let n = 0;
  return (method, path, userId, body, key) => h.request({
    method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: key ?? `p3-${n++}-${path}` } : {}), ...(body === undefined ? {} : { body }),
  });
}

/** The cast and the places: suppliers approved by two people (OB-32), a store with a back store (OB-37). */
export async function p3Shop(h: ApiHarness, T: string, ...suppliers: string[]): Promise<void> {
  await h.seedOwner(T, P3.OWNER);
  await approvedSuppliers(h, T, ...(suppliers.length === 0 ? ['sup-1'] : suppliers));
  await deliveryPlaces(h, T, P3.STORE, P3.BACK);
  await h.provisionRole(T, P3.BUYER, 'store_manager');
  await h.provisionRole(T, P3.RECEIVER, 'store_manager');
  await h.provisionRole(T, P3.MATCHER, 'accountant');
  await h.provisionRole(T, P3.PAYER, 'accountant');
  await h.provisionRole(T, P3.PAY_APPROVER, 'accountant');
  await h.provisionRole(T, P3.CASHIER, 'cashier');
}

const must = async (p: Promise<{ status: number; body: unknown }>, what: string, ok: readonly number[] = [200, 201]) => {
  const r = await p;
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

export interface Line { readonly productId: string; readonly qty: number; readonly unitMinor: number }

/** The buyer raises the order; the owner issues it. */
export async function issuedOrder(call: Call, poId: string, lines: readonly Line[], supplierId = 'sup-1', extra: Record<string, unknown> = {}): Promise<void> {
  await must(call('POST', `/v1/purchase/orders/${poId}`, P3.BUYER, { supplierId, deliverToLocationId: P3.STORE, lines: lines.map((l) => ({ productId: l.productId, orderedQty: l.qty, unitCost: { minor: l.unitMinor, currency: 'INR' } })), ...extra }), `propose ${poId}`);
  await must(call('POST', `/v1/purchase/orders/${poId}/approval`, P3.OWNER, { reason: 'synthetic test order' }), `issue ${poId}`);
}

/** The receiver books the delivery in at the back store, all good. */
export async function received(call: Call, grnId: string, poId: string, lines: readonly Line[], by: string = P3.RECEIVER, extra: Record<string, unknown> = {}) {
  return must(call('POST', `/v1/inventory/goods-receipt/${grnId}`, by, {
    warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR', poId,
    lines: lines.map((l, i) => ({ lineId: `L${i + 1}`, productId: l.productId, orderedMinor: l.qty, countedMinor: l.qty, uom: 'ea', unitCost: { minor: l.unitMinor, currency: 'INR' }, condition: 'good' })),
    ...extra,
  }), `receive ${grnId}`);
}

/** The buyer captures the bill as the paper says it (with any landed charges); the accountant matches it. */
export async function capturedAndMatched(call: Call, invoiceId: string, poId: string, lines: readonly Line[], charges?: { freightMinor?: number; dutyMinor?: number; otherMinor?: number }, supplierId = 'sup-1', supplierInvoiceDate?: string) {
  const goods = lines.reduce((s, l) => s + l.qty * l.unitMinor, 0);
  const extra = (charges?.freightMinor ?? 0) + (charges?.dutyMinor ?? 0) + (charges?.otherMinor ?? 0);
  await must(call('POST', `/v1/purchase/invoices/${invoiceId}/capture`, P3.BUYER, {
    supplierId, poId, declaredTotalMinor: goods + extra,
    lines: lines.map((l) => ({ productId: l.productId, quantity: l.qty, unitPriceMinor: l.unitMinor, lineTotalMinor: l.qty * l.unitMinor })),
    ...(charges === undefined ? {} : { charges }), ...(supplierInvoiceDate === undefined ? {} : { supplierInvoiceDate }),
  }), `capture ${invoiceId}`);
  return must(call('POST', `/v1/purchase/invoices/${invoiceId}/match`, P3.MATCHER, {}), `match ${invoiceId}`);
}

/** A cash payment recorded by `payer`, approved by `approver` in their own session. */
export function payInCash(h: ApiHarness, T: string, supplierId: string, paymentId: string, amountMinor: number, payer: string = P3.PAYER, approver: string = P3.PAY_APPROVER) {
  const body = { amountMinor, paidOn: '2026-10-21', method: 'cash', reference: `CASH-${paymentId}` };
  return sentWithApproval(h, T, payer, approver, { kind: 'supplier_payment', subjectRef: `${supplierId}/${paymentId}`, pathIds: { supplierId, paymentId }, valueMinor: amountMinor }, body,
    (b) => h.request({ method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/payments/${paymentId}`, userId: payer, tenantId: T, idempotencyKey: `pay-${paymentId}`, body: b }));
}
