import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { findB2BProbing, type B2BPortalRefusal } from '../../packages/b2b/src/portal-access';

/**
 * M22-FR-04 · §35 · hard rules #4 #6 — the B2B customer portal on the real API: a business customer reads ITS OWN
 * account, invoices, statement and documents. Who the login is comes from a binding a member of staff made,
 * never the request; a cross-customer ask is refused AND recorded; a missing grant is a permission answer, not an
 * empty statement. The figures a customer sees are the very figures the staff surfaces project.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22';
const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CAT = 'u-caterer'; const CAN = 'u-canteen'; const NOBODY = 'u-nobody';
const LINE = { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };

const post = (h: ApiHarness, path: string, u: string, key: string, body?: unknown) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, ...(body === undefined ? {} : { body }) });
const get = (h: ApiHarness, path: string, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path, userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(store = new InMemoryEventStore()): Promise<ApiHarness> {
  const h = apiHarness({ store });
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, ACCT, 'accountant');
  await h.enableFeature(A, 'b2b');
  // Two business customers with credit terms, invoices, a payment and a document each.
  await post(h, '/v1/b2b/accounts/CATERER', OWNER, 'acc-cat', { creditLimitMinor: 500_000 });
  await post(h, '/v1/b2b/accounts/CATERER/receivables', OWNER, 'ar-cat-1', { movementId: 'ar-cat-1', kind: 'invoice', amountMinor: 100_000, ref: 'INV-C1' });
  await post(h, '/v1/b2b/collections/CATERER/invoices/inv-c1', OWNER, 'inv-c1', { number: 'INV-C1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
  await post(h, '/v1/b2b/collections/CATERER/invoices/inv-c2', OWNER, 'inv-c2', { number: 'INV-C2', issuedOn: '2026-08-16', dueOn: '2026-09-15', grossMinor: 50_000 });
  await post(h, '/v1/b2b/collections/CATERER/payments/rcpt-c1', OWNER, 'rcpt-c1', { receivedMinor: 30_000 });
  await post(h, '/v1/b2b/documents/CATERER/quotations/q-c1', OWNER, 'q-c1', { lines: [LINE] });
  await post(h, '/v1/b2b/collections/CANTEEN/invoices/inv-k1', OWNER, 'inv-k1', { number: 'INV-K1', issuedOn: '2026-08-01', dueOn: '2026-08-31', grossMinor: 999_900 });
  // The portal logins, bound by staff — and one bound to nobody.
  await h.provisionRole(A, CAT, 'b2b_customer');
  await h.provisionRole(A, CAN, 'b2b_customer');
  await h.provisionRole(A, NOBODY, 'b2b_customer');
  await post(h, `/v1/b2b-portal/customers/CATERER/logins/${CAT}`, OWNER, 'bind-cat', { grants: ['view_statement', 'view_invoices'] });
  await post(h, `/v1/b2b-portal/customers/CANTEEN/logins/${CAN}`, OWNER, 'bind-can', { grants: ['view_invoices'] }); // no statement grant
  return h;
}

describe('findB2BProbing — a pattern of cross-customer refusals is named, a mis-click is not', () => {
  const r = (userId: string, requested: string, outcome: B2BPortalRefusal['outcome'] = 'not_your_data'): B2BPortalRefusal =>
    ({ customerId: 'CATERER', userId, requestedCustomerId: requested, action: 'read:statement', outcome, at: '2026-09-29T00:00:00.000Z' });
  it('counts only not_your_data refusals, from the threshold up, worst first', () => {
    const found = findB2BProbing([r('u1', 'X'), r('u1', 'Y'), r('u1', 'Y'), r('u2', 'X'), r('u2', 'X', 'no_grant'), r('u3', 'X'), r('u3', 'Y'), r('u3', 'Z'), r('u3', 'W')]);
    expect(found.map((p) => [p.userId, p.attempts, p.distinctTargets])).toEqual([['u3', 4, 4], ['u1', 3, 2]]);
    expect(findB2BProbing([r('u1', 'X')])).toEqual([]);
  });
});

describe('the B2B customer portal (M22-FR-04, §35)', () => {
  it('a customer reads ITS OWN account, invoices, statement and documents — the customer id from the binding, the figures from the staff surfaces', async () => {
    const h = await cast();
    const account = await get(h, '/v1/b2b-portal/me/account', CAT);
    expect(account.status).toBe(200);
    // FUL-09: the 30,000 received moved the AR balance too (100,000 − 30,000) — a collection is money off what is owed.
    expect(account.body).toMatchObject({ customerId: 'CATERER', hasCreditAccount: true, creditLimitMinor: 500_000, outstandingMinor: 70_000, availableCreditMinor: 430_000 });

    const invoices = (await get(h, '/v1/b2b-portal/me/invoices', CAT)).body as { customerId: string; invoices: { number: string; settledMinor: number; outstandingMinor: number }[]; outstandingMinor: number };
    expect(invoices.customerId).toBe('CATERER');
    // The payment of 30,000 was allocated oldest-due-first: INV-C1 settled 30,000; INV-C2 untouched.
    expect(invoices.invoices.map((i) => [i.number, i.settledMinor, i.outstandingMinor])).toEqual([['INV-C1', 30_000, 70_000], ['INV-C2', 0, 50_000]]);
    expect(invoices.outstandingMinor).toBe(120_000);

    const statement = (await get(h, '/v1/b2b-portal/me/statement', CAT, { asOf: '2026-08-31' })).body as { customerId: string; asAt: string; ageing: { totalOutstandingMinor: number; overdueMinor: number; buckets: Record<string, number> } };
    expect(statement.customerId).toBe('CATERER');
    expect(statement.ageing.totalOutstandingMinor).toBe(120_000);
    expect(statement.ageing.buckets['due_0_30']).toBe(70_000); // INV-C1, 11 days overdue, net of the payment
    expect(statement.ageing.buckets['not_due']).toBe(50_000);

    const docs = (await get(h, '/v1/b2b-portal/me/documents', CAT)).body as { documents: { documentId: string; kind: string; number: string }[] };
    expect(docs.documents.map((d) => [d.documentId, d.kind])).toEqual([['q-c1', 'quotation']]);
    const one = await get(h, '/v1/b2b-portal/me/documents/q-c1', CAT);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ documentId: 'q-c1', customerId: 'CATERER', grossMinor: 105_000 });

    // The other customer sees only ITS own from the same routes — never the caterer's.
    const theirs = (await get(h, '/v1/b2b-portal/me/invoices', CAN)).body as { customerId: string; invoices: { number: string }[] };
    expect(theirs.customerId).toBe('CANTEEN');
    expect(theirs.invoices.map((i) => i.number)).toEqual(['INV-K1']);
    expect((await get(h, '/v1/b2b-portal/me/documents/q-c1', CAN)).status).toBe(404); // not "not yours" — a 404 confirms nothing
  });

  it('a request naming ANOTHER customer is refused AND recorded; a pattern of them is surfaced to staff as probing', async () => {
    const h = await cast();
    expect(codeOf(await get(h, '/v1/b2b-portal/me/statement', CAT, { customerId: 'CANTEEN', asOf: '2026-08-31' }))).toBe('not_your_data');
    expect((await get(h, '/v1/b2b-portal/me/invoices', CAT, { customerId: 'CANTEEN' })).status).toBe(403);
    expect((await get(h, '/v1/b2b-portal/me/account', CAT, { customerId: 'SCHOOL' })).status).toBe(403);
    expect((await get(h, '/v1/b2b-portal/me/documents', CAT, { customerId: 'HOSTEL' })).status).toBe(403);
    const probing = (await get(h, '/v1/b2b-portal/probing', OWNER, { threshold: '3' })).body as { probing: { customerId: string; userId: string; attempts: number; distinctTargets: number }[]; refusals: number };
    expect(probing.refusals).toBe(4);
    expect(probing.probing).toEqual([expect.objectContaining({ customerId: 'CATERER', userId: CAT, attempts: 4, distinctTargets: 3 })]);
    // A customer cannot read the probing view or another customer's login list.
    expect((await get(h, '/v1/b2b-portal/probing', CAT)).status).toBe(403);
    expect((await get(h, '/v1/b2b-portal/customers/CANTEEN/logins', CAT)).status).toBe(403);
  });

  it('a missing grant is a permission answer (403 no_grant), not an empty statement; a login bound to nobody is not a B2B login', async () => {
    const h = await cast();
    const noStatement = await get(h, '/v1/b2b-portal/me/statement', CAN, { asOf: '2026-08-31' });
    expect(noStatement.status).toBe(403);
    expect(codeOf(noStatement)).toBe('no_grant');
    expect(codeOf(await get(h, '/v1/b2b-portal/me/account', CAN))).toBe('no_grant');
    expect((await get(h, '/v1/b2b-portal/me/invoices', CAN)).status).toBe(200); // the grant it does hold
    const nobody = await get(h, '/v1/b2b-portal/me/invoices', NOBODY);
    expect(nobody.status).toBe(403);
    expect(codeOf(nobody)).toBe('not_a_b2b_login');
    // A grant refusal is NOT a probe — the register holds only cross-customer asks.
    expect(((await get(h, '/v1/b2b-portal/probing', OWNER)).body as { refusals: number }).refusals).toBe(0);
  });

  it('staff bind, review and re-point logins; the binding survives a cold restart; a customer cannot bind', async () => {
    const store = new InMemoryEventStore();
    const h = await cast(store);
    const logins = (await get(h, '/v1/b2b-portal/customers/CATERER/logins', ACCT)).body as { logins: { userId: string; grants: string[]; boundBy: string }[] };
    expect(logins.logins).toEqual([expect.objectContaining({ userId: CAT, grants: ['view_statement', 'view_invoices'], boundBy: OWNER })]);
    expect((await post(h, `/v1/b2b-portal/customers/CATERER/logins/${CAN}`, CAT, 'bad-bind', { grants: ['view_invoices'] })).status).toBe(403);
    expect((await post(h, `/v1/b2b-portal/customers/CATERER/logins/u-x`, OWNER, 'bad-body', { grants: ['everything'] })).status).toBe(400);
    // Re-point the canteen's login to the caterer: it drops off the canteen's list and reads the caterer's data.
    await post(h, `/v1/b2b-portal/customers/CATERER/logins/${CAN}`, ACCT, 'rebind', { grants: ['view_invoices'] });
    expect(((await get(h, '/v1/b2b-portal/customers/CANTEEN/logins', OWNER)).body as { logins: unknown[] }).logins).toEqual([]);
    expect(((await get(h, '/v1/b2b-portal/me/invoices', CAN)).body as { customerId: string }).customerId).toBe('CATERER');
    // Cold restart over the same store: bindings and the refusal register are exactly where they were left.
    await get(h, '/v1/b2b-portal/me/invoices', CAT, { customerId: 'CANTEEN' });
    const h2 = apiHarness({ store });
    expect(((await get(h2, '/v1/b2b-portal/me/account', CAT)).body as { customerId: string }).customerId).toBe('CATERER');
    expect(((await get(h2, '/v1/b2b-portal/customers/CATERER/logins', OWNER)).body as { count: number }).count).toBe(2);
    expect(((await get(h2, '/v1/b2b-portal/probing', OWNER)).body as { refusals: number }).refusals).toBe(1);
  });

  it('a customer with no credit terms and no invoices is told so plainly — never a zero-balance statement; and the family is behind the b2b entitlement', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-new', 'b2b_customer');
    await post(h, '/v1/b2b-portal/customers/NEWCO/logins/u-new', OWNER, 'bind-new', { grants: ['view_statement', 'view_invoices'] });
    expect((await get(h, '/v1/b2b-portal/me/account', 'u-new')).body).toMatchObject({ customerId: 'NEWCO', hasCreditAccount: false, outstandingMinor: 0 });
    expect((await get(h, '/v1/b2b-portal/me/statement', 'u-new')).body).toMatchObject({ customerId: 'NEWCO', ageing: null });
    expect((await get(h, '/v1/b2b-portal/me/statement', 'u-new', { asOf: 'yesterday' })).status).toBe(400);

    const off = apiHarness();
    await off.seedOwner(A, OWNER);
    await off.provisionRole(A, CAT, 'b2b_customer');
    expect((await get(off, '/v1/b2b-portal/me/account', CAT)).status).toBe(403);
    expect(codeOf(await get(off, '/v1/b2b-portal/me/account', CAT))).toBe('feature_not_entitled');
  });
});
