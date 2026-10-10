import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { seedSubstitutionTruth, recordOrderRules } from '../support/substitution-truth';
import { approvedRequestId } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

// API-07 M18-FR-04 — the substitution write path. While picking, the picker offers a substitute and the
// customer confirms / declines / does not answer. The engine's rules are enforced at the boundary and the
// decision is RECORDED append-only on the order: no_answer is NOT a yes (silence short-picks, charges
// nothing); the customer never pays more for our failure to stock the item; a cheaper substitute leaves a
// refund DUE (a fact recorded here, issued downstream); a line is substituted once; a finished order refuses.
//
// FUL-14: everything but the picker's choice comes from STORED truth — the order's line, the published prices, the product
// master's attributes, the order's payment, and what the customer said (recorded with how they were reached). The prices
// in the offer below are the picker's and are NOT used: milk is published at Rs 50, the alternative at Rs 40, the dear one Rs 60.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOC = 'store-1';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

/** Place an order so it exists in the system (a promise that reserves nothing still records the order). */
const place = (h: ApiHarness, u: string, orderId: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: u, tenantId: A, idempotencyKey: `place-${orderId}`,
    body: { lines: [{ productId: 'MILK', quantityMinor: 2 }], locationId: LOC } });

const offer = (over: Record<string, unknown> = {}) => ({
  lineId: 'l1', orderedProductId: 'MILK', orderedName: 'Milk 1L', orderedUnitPriceMinor: 5_000, orderedQuantityMinor: 2,
  substituteProductId: 'MILK-ALT', substituteName: 'Milk 1L alt', substituteUnitPriceMinor: 4_000, substituteQuantityMinor: 2,
  offeredAt: '2026-08-14T10:00:00.000Z', ...over,
});

const sub = (h: ApiHarness, u: string, orderId: string, body: unknown, key = `sub-${orderId}`) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/substitute`, userId: u, tenantId: A, idempotencyKey: key, body });

/** The owner, a store manager, the published products. */
async function shop(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await seedSubstitutionTruth(h, A, [
    { productId: 'MILK', name: 'Milk 1L', priceMinor: 5_000, brand: 'aavin', categoryId: 'dairy' },
    { productId: 'MILK-ALT', name: 'Milk 1L alt', priceMinor: 4_000, brand: 'arokya', categoryId: 'dairy' },
    { productId: 'MILK-DEAR', name: 'Milk 1L premium', priceMinor: 6_000, brand: 'arokya', categoryId: 'dairy' },
    { productId: 'BEER', name: 'Beer 330ml', priceMinor: 4_000, categoryId: 'dairy', minimumAge: 21 },
  ]);
  return h;
}
/** Place the order and (unless told not to) record the customer's rules on it, as told to staff on the phone. */
async function placed(h: ApiHarness, orderId: string, rules: Record<string, unknown> | null = { preference: 'best_match' }): Promise<void> {
  await place(h, 'u-owner', orderId);
  if (rules !== null) await recordOrderRules(h, A, 'u-owner', orderId, rules);
}

const transition = (h: ApiHarness, u: string, orderId: string, event: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/transition`, userId: u, tenantId: A, idempotencyKey: `txn-${orderId}-${event}`, body: { event } });

describe('order substitution write path (M18-FR-04)', () => {
  it('records a confirmed cheaper substitute — charged at the PUBLISHED lower price, refund DUE', async () => {
    const h = await shop();
    await placed(h, 'ord-1');
    const res = await sub(h, 'u-owner', 'ord-1', { offer: offer({ orderedUnitPriceMinor: 1, substituteUnitPriceMinor: 1 }), decision: 'confirmed' });
    expect(res.status).toBe(201);
    const body = res.body as { outcome: string; pickProductId: string | null; chargeMinor: number; refundMinor: number; refundDue: boolean; prices: unknown; fromStoredTruth: boolean };
    expect(body.outcome).toBe('substituted');
    expect(body.pickProductId).toBe('MILK-ALT');
    expect(body.prices).toEqual({ orderedUnitPriceMinor: 5_000, substituteUnitPriceMinor: 4_000 }); // the catalogue's, never the picker's
    expect(body.chargeMinor).toBe(8_000);  // min(substitute 8000, ordered 10000)
    expect(body.refundMinor).toBe(2_000);  // ordered 10000 - substitute 8000
    expect(body.refundDue).toBe(true);
    expect(body.fromStoredTruth).toBe(true);
  });

  it('a dearer substitute is charged at the ORIGINAL price — the customer never pays for our shortfall', async () => {
    const h = await shop();
    await placed(h, 'ord-2');
    const res = await sub(h, 'u-owner', 'ord-2', { offer: offer({ substituteProductId: 'MILK-DEAR' }), decision: 'confirmed' });
    expect(res.status).toBe(201);
    const body = res.body as { chargeMinor: number; refundMinor: number; refundDue: boolean };
    expect(body.chargeMinor).toBe(10_000); // charged the original line, not the dearer substitute
    expect(body.refundMinor).toBe(0);
    expect(body.refundDue).toBe(false);
  });

  it('no_answer is NOT a yes — the line is short-picked and charged nothing (no rules needed to short-pick)', async () => {
    const h = await shop();
    await placed(h, 'ord-3', null);
    const res = await sub(h, 'u-owner', 'ord-3', { offer: offer(), decision: 'no_answer' });
    expect(res.status).toBe(201);
    const body = res.body as { outcome: string; chargeMinor: number; pickQuantityMinor: number };
    expect(body.outcome).toBe('not_confirmed');
    expect(body.chargeMinor).toBe(0);
    expect(body.pickQuantityMinor).toBe(0);
  });

  it('a declined substitute short-picks the line', async () => {
    const h = await shop();
    await placed(h, 'ord-4', null);
    const res = await sub(h, 'u-owner', 'ord-4', { offer: offer(), decision: 'declined' });
    expect((res.body as { outcome: string }).outcome).toBe('short_picked');
  });

  it('a line is substituted once — a second decision on the same line is refused (append-only)', async () => {
    const h = await shop();
    await placed(h, 'ord-5');
    expect((await sub(h, 'u-owner', 'ord-5', { offer: offer(), decision: 'confirmed' }, 'sub-5a')).status).toBe(201);
    const again = await sub(h, 'u-owner', 'ord-5', { offer: offer(), decision: 'declined' }, 'sub-5b');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('line_already_substituted');
    // A DIFFERENT line on the same order is fine.
    expect((await sub(h, 'u-owner', 'ord-5', { offer: offer({ lineId: 'l2' }), decision: 'confirmed' }, 'sub-5c')).status).toBe(201);
  });

  it('refuses a substitution on an unknown order and on a finished (cancelled) one', async () => {
    const h = await shop();
    const unknown = await sub(h, 'u-owner', 'ord-nope', { offer: offer(), decision: 'confirmed' });
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown)).toBe('order_unknown');
    await placed(h, 'ord-6');
    await transition(h, 'u-owner', 'ord-6', 'cancel');
    const finished = await sub(h, 'u-owner', 'ord-6', { offer: offer(), decision: 'confirmed' });
    expect(finished.status).toBe(409);
    expect(codeOf(finished)).toBe('order_finished');
  });

  it('refuses a malformed substitution and gates on order.lifecycle.manage', async () => {
    const h = await shop();
    await h.provisionRole(A, 'u-cash', 'cashier');
    await placed(h, 'ord-7');
    const bad = await sub(h, 'u-owner', 'ord-7', { decision: 'confirmed' }); // no offer
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_substitution');
    expect((await sub(h, 'u-cash', 'ord-7', { offer: offer(), decision: 'confirmed' }, 'sub-7c')).status).toBe(403);
  });
});

// M19-FR-01 — the substitution POLICY + tender-aware MONEY on the same write path, now from STORED truth (FUL-14): the
// customer's rules, both products' attributes and the tender are read, never taken from the body.
describe('order substitution — policy gate + tender money from stored truth (M19-FR-01 · FUL-14)', () => {
  it('a policy REFUSAL blocks the swap even when the picker sent "confirmed" — short-picked, charged nothing', async () => {
    const h = await shop();
    await placed(h, 'ord-p1');
    const res = await sub(h, 'u-owner', 'ord-p1', { offer: offer({ substituteProductId: 'BEER' }), decision: 'confirmed', rules: { preference: 'best_match' }, substituteAttrs: { productId: 'BEER', name: 'x', ageRestricted: false } });
    expect(res.status).toBe(201);
    const body = res.body as { outcome: string; chargeMinor: number; eligibility: string; policyReason: string };
    expect(body.eligibility).toBe('refused'); // the master says it is age-restricted, whatever the body claims
    expect(body.policyReason).toBe('controlled_item');
    expect(body.outcome).toBe('short_picked'); // blocked despite "confirmed"
    expect(body.chargeMinor).toBe(0);
  });

  it('best_match + a cheaper swap on a PREPAID order (its recorded payment) records a prepaid refund of the difference', async () => {
    const h = await shop();
    await placed(h, 'ord-p2');
    expect((await h.request({ method: 'POST', path: '/v1/orders/ord-p2/payment', userId: 'u-mgr', tenantId: A, idempotencyKey: 'pay-p2', body: { providerRef: 'tok_p2', amountMinor: 10_000, result: 'authorised' } })).status).toBeLessThan(300);
    const res = await sub(h, 'u-owner', 'ord-p2', { offer: offer(), decision: 'confirmed', tender: 'cod' });
    const body = res.body as { eligibility: string; chargeMinor: number; tender: string; settlementKind: string; settlementMinor: number };
    expect(body.eligibility).toBe('auto_accept');
    expect(body.tender).toBe('prepaid'); // from the payment, not the body's "cod"
    expect(body.chargeMinor).toBe(8_000);
    expect(body.settlementKind).toBe('prepaid_refund');
    expect(body.settlementMinor).toBe(2_000);
  });

  it('a dearer swap ABOVE the cap needs the customer\'s yes to the higher price AND a second person\'s approval — then a COD order collects more', async () => {
    const h = await shop();
    await placed(h, 'ord-p3');
    const dear = offer({ substituteProductId: 'MILK-DEAR' }); // 12000 vs ordered 10000
    // A typed "approvedAboveCap" is a claim, not an approval.
    expect(codeOf(await sub(h, 'u-mgr', 'ord-p3', { offer: dear, decision: 'confirmed', approvedAboveCap: true }, 'p3-typed'))).toBe('above_cap_needs_an_approval');
    const approvalId = await approvedRequestId(h, A, 'u-mgr', 'u-owner', {
      kind: 'substitution_above_cap', subjectRef: 'ord-p3/l1', valueMinor: 2_000,
      details: actionDetails({ substituteProductId: 'MILK-DEAR', substituteQuantityMinor: 2 }, { orderId: 'ord-p3', lineId: 'l1' }),
    });
    // No customer yes recorded, no documented contact → refused, nothing recorded.
    expect(codeOf(await sub(h, 'u-mgr', 'ord-p3', { offer: dear, decision: 'confirmed', approvalId }, 'p3-noconsent'))).toBe('customer_consent_required');
    // The customer said yes to the higher price on the phone — documented.
    const res = await sub(h, 'u-mgr', 'ord-p3', { offer: dear, decision: 'confirmed', approvalId, customerAcceptsHigherPrice: true, contact: { method: 'phone', reference: 'call-0042' } }, 'p3-ok');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ chargeMinor: 12_000, aboveCap: true, tender: 'cod', settlementKind: 'collect_more', settlementMinor: 2_000, aboveCapApprovedBy: 'u-owner', consent: { given: 'staff_contact' } });
  });

  it('FAILS CLOSED: a confirmed swap with no customer rules on record, or a product the master does not know, is refused and nothing is recorded', async () => {
    const h = await shop();
    await placed(h, 'ord-p4', null);
    const noRules = await sub(h, 'u-owner', 'ord-p4', { offer: offer(), decision: 'confirmed', rules: { preference: 'best_match' } });
    expect(noRules.status).toBe(409);
    expect(codeOf(noRules)).toBe('substitution_facts_missing');
    await recordOrderRules(h, A, 'u-owner', 'ord-p4', { preference: 'best_match' });
    const unknownProduct = await sub(h, 'u-owner', 'ord-p4', { offer: offer({ substituteProductId: 'NOT-PUBLISHED' }), decision: 'confirmed' }, 'p4-b');
    expect(codeOf(unknownProduct)).toBe('substitution_facts_missing');
    expect((unknownProduct.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/NOT-PUBLISHED/);
    // A line not on the order is not a substitution.
    expect(codeOf(await sub(h, 'u-owner', 'ord-p4', { offer: offer({ orderedProductId: 'BREAD' }), decision: 'confirmed' }, 'p4-c'))).toBe('not_on_the_order');
    // Nothing above was recorded: the line can still be decided.
    expect((await sub(h, 'u-owner', 'ord-p4', { offer: offer(), decision: 'confirmed' }, 'p4-d')).status).toBe(201);
  });

  it('a "contact me" customer needs their yes: from the documented contact here', async () => {
    const h = await shop();
    await placed(h, 'ord-p5', { preference: 'contact_me' });
    expect(codeOf(await sub(h, 'u-owner', 'ord-p5', { offer: offer(), decision: 'confirmed' }))).toBe('customer_consent_required');
    const ok = await sub(h, 'u-owner', 'ord-p5', { offer: offer(), decision: 'confirmed', contact: { method: 'whatsapp', reference: 'msg-77' } }, 'p5-ok');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ eligibility: 'needs_confirmation', outcome: 'substituted', consent: { given: 'staff_contact', by: 'u-owner' } });
  });
});
