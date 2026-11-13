import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';

/**
 * **U6 (UI/UX gap audit §27 "Purchase — RFQ: PARTIAL") · M06-FR-02 "RFQ to suppliers" · M24-FR-01 "respond to RFQs" · §28.**
 *
 * Before this, a buyer could only KEY IN what a supplier quoted; nothing sent a request for quotation and a supplier had
 * nowhere to answer one. Now, through the real routes:
 *   • a buyer sends an RFQ for a requisition to named, APPROVED suppliers with a day the quotes are due; a supplier the
 *     master has not approved is refused by name; the RFQ is audited;
 *   • each supplier reads the RFQs sent to IT (its own partner, never another's) with the lines; it answers with its prices
 *     and lead times — the answer lands as an `rfq_response` submission that WAITS for a buyer (nothing a supplier submits
 *     takes effect on its own);
 *   • when a buyer ACCEPTS the reply on the review desk, head office records it as the supplier's quote on the requisition
 *     (the quote id is the RFQ + the supplier, so a re-quote supersedes) and the like-for-like comparison sees it; a REJECTED
 *     reply records no quote;
 *   • the RFQ register says which suppliers have answered, which are still open, and which are overdue.
 */

const T = randomUUID();
const INR = 'INR';
const OWNER = 'u-owner'; const BUYER = 'u-buyer'; const SUP_A = 'u-sup-a'; const SUP_B = 'u-sup-b'; const CASH = 'u-cash';

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, BUYER, 'store_manager');
  await h.provisionRole(T, CASH, 'cashier');
  await h.provisionRole(T, SUP_A, 'supplier');
  await h.provisionRole(T, SUP_B, 'supplier');
  await approvedSuppliers(h, T, 'sup-a', 'sup-b');
  return h;
}
const call = (h: ApiHarness, method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Readonly<Record<string, string>>) =>
  h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${userId}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe('U6 · an RFQ is sent to suppliers and their quotes come back through the portal (M06-FR-02 · M24-FR-01)', () => {
  it('send → each supplier reads its own → answers → the buyer accepts → the quote is on the comparison; the register says who answered', async () => {
    const h = await cast();
    // The requisition: rice 10, dal 4 — and two suppliers bound to two portal logins.
    expect((await call(h, 'POST', '/v1/purchase/requisitions/rq-1', BUYER, { currency: INR, lines: [{ productId: 'p-rice', quantity: 10 }, { productId: 'p-dal', quantity: 4 }] })).status).toBe(201);
    for (const [partner, login] of [['sup-a', SUP_A], ['sup-b', SUP_B]] as const) {
      const r = await call(h, 'POST', `/v1/supplier-portal/partners/${partner}`, BUYER, { grants: ['respond_rfq', 'view_statement'], documents: [], requiredDocuments: [], logins: [login] });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }

    // ── 1 · the buyer sends the RFQ; a cashier cannot; a supplier not in the master is refused by name.
    expect((await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-1', CASH, { supplierIds: ['sup-a'], dueOn: '2099-01-10' })).status).toBe(403);
    const unknown = await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-x', BUYER, { supplierIds: ['sup-a', 'sup-zzz'], dueOn: '2099-01-10' });
    expect(codeOf(unknown)).toBe('supplier_not_approved');
    expect(codeOf(await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-1', BUYER, { supplierIds: ['sup-a'], dueOn: '10/01/2099' }))).toBe('not_readable_as_an_rfq');
    expect(codeOf(await call(h, 'POST', '/v1/purchase/requisitions/rq-nope/rfq/rfq-1', BUYER, { supplierIds: ['sup-a'], dueOn: '2099-01-10' }))).toBe('not_found');
    const sent = await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-1', BUYER, { supplierIds: ['sup-a', 'sup-b'], dueOn: '2099-01-10', note: 'please quote per kg' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ rfq: { rfqId: 'rfq-1', requisitionId: 'rq-1', supplierIds: ['sup-a', 'sup-b'], dueOn: '2099-01-10', sentBy: BUYER } });

    // ── 2 · the register: two asked, none answered, open (the day is in the future).
    const reg1 = (await call(h, 'GET', '/v1/purchase/rfqs', BUYER)).body as { rfqs: { rfqId: string; state: string; asked: number; answered: number; suppliers: { supplierId: string; answered: boolean }[] }[] };
    expect(reg1.rfqs).toHaveLength(1);
    expect(reg1.rfqs[0]).toMatchObject({ rfqId: 'rfq-1', state: 'open', asked: 2, answered: 0 });
    expect((await call(h, 'GET', '/v1/purchase/rfqs', CASH)).status).toBe(403);

    // ── 3 · supplier A reads ITS RFQs — the lines, the due day, that it has not answered; supplier B's view is its own; a
    //        login bound to nobody is told so.
    const mineA = (await call(h, 'GET', '/v1/supplier-portal/me/rfqs', SUP_A)).body as { rfqsKnown: boolean; mayRespond: boolean; rfqs: { rfqId: string; requisitionId: string; dueOn: string; answered: boolean; lines: { productId: string; quantity: number }[] }[] };
    expect(mineA.rfqsKnown).toBe(true);
    expect(mineA.mayRespond).toBe(true);
    expect(mineA.rfqs).toHaveLength(1);
    expect(mineA.rfqs[0]).toMatchObject({ rfqId: 'rfq-1', requisitionId: 'rq-1', dueOn: '2099-01-10', answered: false });
    expect(mineA.rfqs[0]!.lines.map((l) => l.productId)).toEqual(['p-rice', 'p-dal']);
    expect((await call(h, 'GET', '/v1/supplier-portal/me/rfqs', SUP_A, undefined, { partnerId: 'sup-b' })).status).toBe(403); // a probe, refused and recorded
    expect((await call(h, 'GET', '/v1/supplier-portal/me/rfqs', CASH)).status).toBe(403); // a cashier holds no supplier-portal word at all

    // ── 4 · supplier A answers; a line naming a product the RFQ did not ask for is refused; supplier B cannot answer A's
    //        RFQ twice over (its own copy is its own); the answer WAITS for a buyer.
    const bad = await call(h, 'POST', '/v1/supplier-portal/me/rfqs/rfq-1/quote', SUP_A, { lines: [{ productId: 'p-oil', unitCost: { minor: 100, currency: INR }, leadTimeDays: 2 }] });
    expect(codeOf(bad)).toBe('not_readable_as_a_quote');
    const quoteA = await call(h, 'POST', '/v1/supplier-portal/me/rfqs/rfq-1/quote', SUP_A, { lines: [
      { productId: 'p-rice', unitCost: { minor: 5_000, currency: INR }, leadTimeDays: 10 }, { productId: 'p-dal', unitCost: { minor: 2_500, currency: INR }, leadTimeDays: 8 },
    ] });
    expect(quoteA.status, JSON.stringify(quoteA.body)).toBe(201);
    expect(quoteA.body).toMatchObject({ kind: 'rfq_response', requiresReview: true });
    expect(codeOf(await call(h, 'POST', '/v1/supplier-portal/me/rfqs/rfq-nope/quote', SUP_B, { lines: [{ productId: 'p-rice', unitCost: { minor: 1, currency: INR }, leadTimeDays: 1 }] }))).toBe('not_found');
    // Nothing on the comparison yet: a supplier's word takes effect only once a buyer accepts it (§28).
    const before = (await call(h, 'GET', '/v1/purchase/requisitions/rq-1/comparison', BUYER)).body as { comparison: { totals: unknown[] } };
    expect(before.comparison.totals).toEqual([]);
    const mineA2 = (await call(h, 'GET', '/v1/supplier-portal/me/rfqs', SUP_A)).body as { rfqs: { answered: boolean; awaitingBuyer: boolean }[] };
    expect(mineA2.rfqs[0]).toMatchObject({ answered: false, awaitingBuyer: true });

    // ── 5 · the buyer's queue holds the reply; accepting it records the quote; the comparison names supplier A.
    const queue = (await call(h, 'GET', '/v1/supplier-portal/review-queue', BUYER)).body as { waiting: { submissionId: string; partnerId: string; kind: string }[] };
    const reply = queue.waiting.find((w) => w.kind === 'rfq_response');
    expect(reply).toMatchObject({ partnerId: 'sup-a' });
    const accepted = await call(h, 'POST', `/v1/supplier-portal/partners/sup-a/submissions/${reply!.submissionId}/review`, BUYER, { decision: 'accept', reason: 'a fair price, asked by us' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body).toMatchObject({ review: { decision: 'accepted', fed: { quoteId: 'rfq-1-sup-a', requisitionId: 'rq-1' } } });
    const after = (await call(h, 'GET', '/v1/purchase/requisitions/rq-1/comparison', BUYER)).body as { comparison: { totals: { supplierId: string; quoteId: string; totalCost: { minor: number } }[]; cheapestOverall?: { supplierId: string } } };
    expect(after.comparison.totals).toEqual([expect.objectContaining({ supplierId: 'sup-a', quoteId: 'rfq-1-sup-a', totalCost: expect.objectContaining({ minor: 60_000 }) })]);
    expect(after.comparison.cheapestOverall).toMatchObject({ supplierId: 'sup-a' });

    // ── 6 · supplier B answers and the buyer REJECTS it with a reason: no quote lands; the register says A answered, B not.
    const quoteB = await call(h, 'POST', '/v1/supplier-portal/me/rfqs/rfq-1/quote', SUP_B, { lines: [
      { productId: 'p-rice', unitCost: { minor: 4_000, currency: INR }, leadTimeDays: 30 }, { productId: 'p-dal', unitCost: { minor: 2_000, currency: INR }, leadTimeDays: 30 },
    ] });
    expect(quoteB.status).toBe(201);
    const q2 = (await call(h, 'GET', '/v1/supplier-portal/review-queue', BUYER)).body as { waiting: { submissionId: string; partnerId: string }[] };
    const replyB = q2.waiting.find((w) => w.partnerId === 'sup-b')!;
    const rejected = await call(h, 'POST', `/v1/supplier-portal/partners/sup-b/submissions/${replyB.submissionId}/review`, OWNER, { decision: 'reject', reason: 'thirty days is too slow' });
    expect(rejected.body).toMatchObject({ review: { decision: 'rejected', fed: null } });
    const after2 = (await call(h, 'GET', '/v1/purchase/requisitions/rq-1/comparison', BUYER)).body as { comparison: { totals: { supplierId: string }[] } };
    expect(after2.comparison.totals.map((x) => x.supplierId)).toEqual(['sup-a']);
    const reg2 = (await call(h, 'GET', '/v1/purchase/rfqs', BUYER, undefined, { requisitionId: 'rq-1' })).body as { rfqs: { answered: number; state: string; suppliers: { supplierId: string; answered: boolean; quoteId?: string }[] }[] };
    expect(reg2.rfqs[0]).toMatchObject({ answered: 1, state: 'open' });
    expect(reg2.rfqs[0]!.suppliers).toEqual([{ supplierId: 'sup-a', answered: true, quoteId: 'rfq-1-sup-a' }, { supplierId: 'sup-b', answered: false }]);
    const mineB = (await call(h, 'GET', '/v1/supplier-portal/me/rfqs', SUP_B)).body as { rfqs: { answered: boolean; awaitingBuyer: boolean; decision: string | null }[] };
    expect(mineB.rfqs[0]).toMatchObject({ answered: false, awaitingBuyer: false, decision: 'rejected' });

    // ── 7 · an RFQ whose day has passed with a supplier unanswered is OVERDUE; one every supplier answered is ANSWERED.
    expect((await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-old', BUYER, { supplierIds: ['sup-b'], dueOn: '2020-01-01' })).status).toBe(201);
    expect((await call(h, 'POST', '/v1/purchase/requisitions/rq-1/rfq/rfq-done', BUYER, { supplierIds: ['sup-a'], dueOn: '2020-01-01' })).status).toBe(201);
    const reg3 = (await call(h, 'GET', '/v1/purchase/rfqs', BUYER)).body as { rfqs: { rfqId: string; state: string }[]; counts: Record<string, number> };
    expect(Object.fromEntries(reg3.rfqs.map((r) => [r.rfqId, r.state]))).toEqual({ 'rfq-1': 'open', 'rfq-old': 'overdue', 'rfq-done': 'answered' });
    expect(reg3.counts).toMatchObject({ open: 1, overdue: 1, answered: 1 });
  });
});
