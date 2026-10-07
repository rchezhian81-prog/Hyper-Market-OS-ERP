import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';

/**
 * **The order's payment and its refunds, through the real authenticated API (M18-FR-04 · M20-FR-03 · §28 · §31 · #3).**
 *
 * The checkout's answer is recorded once against the order; a card-shaped reference is refused unrecorded; an
 * unknown answer leaves the order payment-pending and the lifecycle will not confirm or pick it; a refund goes to
 * the order's own token for an amount the ledger can vouch for, approved by a second person with the authority;
 * the test-mode processor's three answers land as issued / refused / pending; a pending refund sits on the
 * worklist until its statement line is recorded; and every figure reads back from the order's money position.
 */

const T = 'ab000000-0000-4000-8000-000000000046';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const LOC = 'store-1';

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MGR, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = OWNER) => h.request({ method: 'GET', path, userId, tenantId: T });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const place = (h: ApiHarness, orderId: string) =>
  post(h, `/v1/orders/${orderId}/promise`, OWNER, `place-${orderId}`, { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: LOC });
const pay = (h: ApiHarness, orderId: string, over: Record<string, unknown> = {}, user = MGR) =>
  post(h, `/v1/orders/${orderId}/payment`, user, `pay-${orderId}-${JSON.stringify(over)}`, { providerRef: 'tok_ok_1', amountMinor: 10_000, result: 'authorised', ...over });
/**
 * A refund as two people make it (ADR-0024): the issuer asks for exactly this refund; the person named as `approvedBy`
 * (the owner unless said) approves it in their own session; the refund names the approval. When that person may not
 * approve it (the issuer, a cashier), the engine's refusal comes back and nothing is sent. `approvedBy: undefined` sends
 * the refund with no approval at all.
 */
const refund = (h: ApiHarness, orderId: string, body: Record<string, unknown>, user = MGR, key = `rf-${orderId}-${String(body['refundId'])}`) => {
  const { approvedBy, ...rest } = { basis: 'goodwill', reason: 'late delivery', approvedBy: OWNER, ...body } as Record<string, unknown>;
  const send = (b: Record<string, unknown>) => post(h, `/v1/orders/${orderId}/refunds`, user, key, b);
  if (typeof approvedBy !== 'string') return send(rest);
  return sentWithApproval(h, T, user, approvedBy, {
    kind: 'order_refund', subjectRef: `${orderId}/${String(rest['refundId'])}`, pathIds: { orderId }, valueMinor: rest['amountMinor'] as number,
  }, rest, send);
};

interface Position { paidMinor: number; refundedMinor: number; pendingMinor: number; refundableMinor: number; refunds: { refundId: string; effectiveState: string }[] }
interface MoneyRead { payment: { state: string; paidMinor: number }; position: Position }

describe('the order\'s payment (M20-FR-03 → M18)', () => {
  it('is recorded once as the checkout answered it; a card-shaped reference is refused unrecorded; a second record is refused', async () => {
    const h = await seeded();
    await place(h, 'o-1');
    expect((await pay(h, 'o-1', { providerRef: '4111 1111 1111 1111' })).status).toBe(422);
    expect(codeOf(await pay(h, 'o-1', { providerRef: '4111 1111 1111 1111' }))).toBe('not_a_provider_token');
    expect((await get(h, '/v1/orders/o-1/refunds')).body as MoneyRead).toMatchObject({ payment: { state: 'none', paidMinor: 0 } });
    const rec = await pay(h, 'o-1');
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body).toMatchObject({ payment: { state: 'authorised', paidMinor: 10_000 } });
    expect(codeOf(await pay(h, 'o-1', { amountMinor: 9_999 }))).toBe('payment_already_recorded');
    expect((await pay(h, 'o-nope')).status).toBe(404);
    expect((await pay(h, 'o-1', {}, CASHIER)).status).toBe(403);
    // A confirmed, paid order moves through its lifecycle as before.
    expect((await post(h, '/v1/orders/o-1/transition', OWNER, 't1', { event: 'confirm' })).status).toBe(200);
  });

  it('an UNKNOWN answer leaves the order payment-pending: it cannot be confirmed or picked until the bank says (§31); a resolution settles it', async () => {
    const h = await seeded();
    await place(h, 'o-2');
    const rec = await pay(h, 'o-2', { providerRef: 'tok_slow', result: 'unknown', reason: 'gateway timeout' });
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ payment: { state: 'pending', paidMinor: 0 } });
    expect((rec.body as { tellTheCustomer: string }).tellTheCustomer).toContain('not placed yet');
    const blocked = await post(h, '/v1/orders/o-2/transition', OWNER, 't2', { event: 'confirm' });
    expect(blocked.status).toBe(409);
    expect(codeOf(blocked)).toBe('payment_pending');
    // Nor may money go back on a payment that may never have arrived.
    expect(codeOf(await refund(h, 'o-2', { refundId: 'rf-early', amountMinor: 1_000 }))).toBe('payment_pending');
    // On the worklist until the statement says.
    const pending = (await get(h, '/v1/orders/refunds/pending')).body as { pendingPayments: { orderId: string }[] };
    expect(pending.pendingPayments.map((p) => p.orderId)).toEqual(['o-2']);
    expect(codeOf(await post(h, '/v1/orders/o-2/payment/resolution', MGR, 'res-bad', { result: 'authorised' }))).toBe('not_readable_as_a_resolution');
    const res = await post(h, '/v1/orders/o-2/payment/resolution', MGR, 'res-1', { result: 'authorised', evidenceRef: 'gateway statement line 41' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payment: { state: 'authorised', paidMinor: 10_000 } });
    expect(codeOf(await post(h, '/v1/orders/o-2/payment/resolution', MGR, 'res-2', { result: 'declined', evidenceRef: 'again' }))).toBe('no_pending_payment'); // the first resolution stands
    expect((await post(h, '/v1/orders/o-2/transition', OWNER, 't3', { event: 'confirm' })).status).toBe(200);
    expect(((await get(h, '/v1/orders/refunds/pending')).body as { pendingPayments: unknown[] }).pendingPayments).toEqual([]);
  });

  it('a DECLINED answer keeps the order out of picking too; an order with no online payment is not held', async () => {
    const h = await seeded();
    await place(h, 'o-3');
    await pay(h, 'o-3', { result: 'declined', reason: 'insufficient funds' });
    expect(codeOf(await post(h, '/v1/orders/o-3/transition', OWNER, 't4', { event: 'confirm' }))).toBe('payment_declined');
    expect((await post(h, '/v1/orders/o-3/transition', OWNER, 't5', { event: 'cancel' })).status).toBe(200); // cancel is the way out
    await place(h, 'o-cod');
    expect((await post(h, '/v1/orders/o-cod/transition', OWNER, 't6', { event: 'confirm' })).status).toBe(200);
  });
});

describe('refunds against the order\'s own token (M18-FR-04)', () => {
  it('a cheaper substitute leaves a refund DUE; the refund is issued on that basis, never more than the substitutions owe, and the position reads back', async () => {
    const h = await seeded();
    await place(h, 'o-4');
    await pay(h, 'o-4');
    const offer = { lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2, substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2, offeredAt: '2026-10-10T10:00:00.000Z' };
    const sub = await post(h, '/v1/orders/o-4/substitute', OWNER, 'sub-4', { offer, decision: 'confirmed' });
    expect(sub.body).toMatchObject({ refundMinor: 2_000, refundDue: true });
    expect(codeOf(await refund(h, 'o-4', { refundId: 'rf-4a', amountMinor: 2_001, basis: 'substitution' }))).toBe('basis_not_recorded');
    const issued = await refund(h, 'o-4', { refundId: 'rf-4a', amountMinor: 2_000, basis: 'substitution', reason: 'cheaper substitute agreed' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body).toMatchObject({ refund: { effectiveState: 'issued', providerRefundRef: 'rf-test-rf-4a', approvedBy: OWNER, requestedBy: MGR }, position: { paidMinor: 10_000, refundedMinor: 2_000, refundableMinor: 8_000 } });
    expect((issued.body as { tellTheCustomer: string }).tellTheCustomer).toContain('have refunded');
    // Idempotent on the refund id even under a NEW idempotency key (a retry from another screen): the record comes back
    // before any approval is looked at, nothing is sent again; a different amount under the same refund id is refused.
    expect((await refund(h, 'o-4', { refundId: 'rf-4a', amountMinor: 2_000, basis: 'substitution', reason: 'cheaper substitute agreed', approvedBy: undefined }, MGR, 'rf-4a-retry')).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await post(h, `/v1/orders/o-4/refunds`, MGR, 'rf-4a-other', { refundId: 'rf-4a', amountMinor: 999, basis: 'goodwill', reason: 'x' }))).toBe('refund_id_reused');
    const read = (await get(h, '/v1/orders/o-4/refunds')).body as MoneyRead;
    expect(read.position).toMatchObject({ refundedMinor: 2_000, pendingMinor: 0, refundableMinor: 8_000 });
    expect(read.position.refunds.map((r) => [r.refundId, r.effectiveState])).toEqual([['rf-4a', 'issued']]);
    expect(await h.store.readStream(T, 'orders', { type: 'OrderRefundIssued' })).toHaveLength(0); // the order's own stream, not the tenant root
  });

  it('approval per policy (§28): no approval, the requester approving themselves, a cashier approving, or a typed approver all refuse before any money moves; the amount never exceeds what is refundable', async () => {
    const h = await seeded();
    await place(h, 'o-5');
    await pay(h, 'o-5');
    expect(codeOf(await refund(h, 'o-5', { refundId: 'a', amountMinor: 1_000, approvedBy: undefined }))).toBe('given_without_approval');
    // The issuer cannot approve their own refund, and a cashier cannot approve one at all — the engine refuses the decision.
    expect(codeOf(await refund(h, 'o-5', { refundId: 'b', amountMinor: 1_000, approvedBy: MGR }))).toBe('self_approval');
    expect((await refund(h, 'o-5', { refundId: 'c', amountMinor: 1_000, approvedBy: CASHIER })).status).toBe(403);
    // A name typed as the approver is refused by name (audit PA-03) — before, the owner's typed name moved the money.
    expect(codeOf(await post(h, '/v1/orders/o-5/refunds', MGR, 'rf-typed', { refundId: 'c2', amountMinor: 1_000, basis: 'goodwill', reason: 'x', approvedBy: OWNER }))).toBe('approver_named_without_approval');
    expect(codeOf(await refund(h, 'o-5', { refundId: 'd', amountMinor: 10_001 }))).toBe('exceeds_refundable');
    expect(codeOf(await refund(h, 'o-5', { refundId: 'e', amountMinor: 0 }))).toBe('nothing_to_refund');
    expect((await refund(h, 'o-5', { refundId: 'f', amountMinor: 1_000 }, CASHIER)).status).toBe(403);
    expect(((await get(h, '/v1/orders/o-5/refunds')).body as MoneyRead).position.refunds).toEqual([]); // nothing was recorded, let alone sent
    // Two refunds that together exceed the payment: the second is refused on what the first left.
    expect((await refund(h, 'o-5', { refundId: 'g', amountMinor: 6_000 })).status).toBe(201);
    expect(codeOf(await refund(h, 'o-5', { refundId: 'h', amountMinor: 4_001 }))).toBe('exceeds_refundable');
    expect((await refund(h, 'o-5', { refundId: 'i', amountMinor: 4_000 })).status).toBe(201);
    expect(((await get(h, '/v1/orders/o-5/refunds')).body as MoneyRead).position).toMatchObject({ refundedMinor: 10_000, refundableMinor: 0 });
  });

  it('the processor\'s answer is recorded as it came: declined → refused (refundable untouched); unknown → PENDING on the worklist until the statement line lands', async () => {
    const h = await seeded();
    await place(h, 'o-6'); await pay(h, 'o-6', { providerRef: 'tok-declines' });
    const declined = await refund(h, 'o-6', { refundId: 'rf-6', amountMinor: 3_000 });
    expect(declined.status).toBe(201);
    expect(declined.body).toMatchObject({ refund: { effectiveState: 'refused', providerOutcome: 'declined' }, position: { refundedMinor: 0, refundableMinor: 10_000 } });
    expect((declined.body as { tellTheCustomer: string }).tellTheCustomer).toContain('did not accept');

    await place(h, 'o-7'); await pay(h, 'o-7', { providerRef: 'tok-unknown' });
    const pending = await refund(h, 'o-7', { refundId: 'rf-7', amountMinor: 3_000 });
    expect(pending.body).toMatchObject({ refund: { effectiveState: 'pending' }, position: { pendingMinor: 3_000, refundableMinor: 7_000 } });
    expect((pending.body as { tellTheCustomer: string }).tellTheCustomer).toContain('waiting for it to confirm');
    const list = (await get(h, '/v1/orders/refunds/pending')).body as { pendingRefunds: { refundId: string }[]; pendingRefundMinor: number };
    expect(list.pendingRefunds.map((r) => r.refundId)).toEqual(['rf-7']);
    expect(list.pendingRefundMinor).toBe(3_000);
    // An outcome on a refund that is not pending is refused; the pending one is settled by its FIRST outcome.
    expect(codeOf(await post(h, '/v1/orders/o-6/refunds/rf-6/outcome', MGR, 'oc-6', { result: 'refunded', evidenceRef: 'x' }))).toBe('refund_not_pending');
    expect((await post(h, '/v1/orders/o-7/refunds/rf-nope/outcome', MGR, 'oc-nope', { result: 'refunded', evidenceRef: 'x' })).status).toBe(404);
    const settled = await post(h, '/v1/orders/o-7/refunds/rf-7/outcome', MGR, 'oc-7', { result: 'declined', evidenceRef: 'gateway statement line 9' });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ refund: { effectiveState: 'refused', outcome: { evidenceRef: 'gateway statement line 9' } }, position: { pendingMinor: 0, refundableMinor: 10_000 } });
    expect(codeOf(await post(h, '/v1/orders/o-7/refunds/rf-7/outcome', MGR, 'oc-7b', { result: 'refunded', evidenceRef: 'later' }))).toBe('refund_not_pending');
    expect(((await get(h, '/v1/orders/refunds/pending')).body as { pendingRefunds: unknown[] }).pendingRefunds).toEqual([]);
    // Restart-safe: a fresh surface over the same ledger reads the same position (append-only facts, hard rule #2).
    const again = apiHarness({ store: h.store });
    expect(((await again.request({ method: 'GET', path: '/v1/orders/o-7/refunds', userId: OWNER, tenantId: T })).body as MoneyRead).position).toMatchObject({ paidMinor: 10_000, refundedMinor: 0, pendingMinor: 0, refundableMinor: 10_000 });
  });
});
