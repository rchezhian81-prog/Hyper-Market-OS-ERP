import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-288 commercial desks — M22-FR-01: a B2B contract is a RECORD, approved by a second person, and a quotation is priced
 * from it; an over-limit order goes to the owner (OB-290); an expired contract blocks or falls back by its own dates.**
 *
 * On the real API (in memory and, with DATABASE_URL, on real PostgreSQL with a cold restart):
 *   • the accountant PROPOSES a contract — recorded, awaiting approval, pricing nothing; the owner approves it in his own
 *     session (never the accountant's own); put in force, its credit limit and terms reach the customer's account;
 *   • a quotation left unpriced takes the CONTRACT price; a typed price that differs is refused by name; a product not on
 *     the contract takes the shop's price-list price; a product with no price anywhere is refused;
 *   • an approved contract is never rewritten (new terms are a new contract); the store manager who takes orders cannot
 *     propose one;
 *   • an order over the credit limit is refused; the order-taker asks, the ACCOUNTANT cannot approve, the OWNER can — then it
 *     converts once;
 *   • a lapsed "block" contract refuses a quotation and an order; a lapsed "fallback" one prices from the price list;
 *   • the desk lists the customer with its account, contract and documents; with the `b2b` feature off nothing answers.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const MGR = 'u-mgr';
const DAY = 86_400_000;
const today = (): string => new Date().toISOString().slice(0, 10);
const shift = (n: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
const RICE = { lineId: 'l1', productId: 'rice', description: 'Ponni rice 25kg', qty: 4, taxRateBps: 500 };
const DAL = { lineId: 'l2', productId: 'dal', description: 'Toor dal 1kg', qty: 10, taxRateBps: 500 };
const SALT = { lineId: 'l3', productId: 'salt', description: 'Salt 1kg', qty: 5, taxRateBps: 0 };
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('M22-FR-01 — the B2B contract register prices the desk, on $name', ({ name, harness }) => {
  it('proposed → approved by another person → quotes priced from it → over-limit to the owner → expiry by its dates', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, ACCT, 'accountant');
    await h.provisionRole(T, MGR, 'store_manager');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${user}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const approve = async (maker: string, checker: string, kind: string, subjectRef: string, body: Record<string, unknown>, ids: Record<string, string>, valueMinor: number | null = null) => {
      const asked = await askForApproval(h, T, maker, { kind, subjectRef, details: actionDetails(body, ids), valueMinor });
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      const requestId = (asked.body as { requestId: string }).requestId;
      const decided = await decide(h, T, checker, requestId);
      return { requestId, decided };
    };

    // The shop's price list: dal at ₹90 at store S1 (salt has no price anywhere). 25 bags of rice and 50 dal on the shelf.
    await ok(call('POST', '/v1/prices/list/dal/entries/dal-s1', OWNER, { scope: 'store', scopeRef: 'S1', priceMinor: 9_000, currency: 'INR', mrpMinor: 10_000, costMinor: 7_000, marginFloorBps: 0, effectiveFrom: today() }), 'dal price');
    for (const [p, q] of [['rice', 25], ['dal', 50], ['salt', 50]] as const) {
      await ok(call('POST', '/v1/inventory/movements', OWNER, { movementId: `${p}-in`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: q, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: OWNER }), `${p} stock`);
    }

    // ── 1 · The accountant PROPOSES: recorded, awaiting approval, and it prices nothing yet.
    const terms = { validFrom: shift(-1), validTo: shift(60), onExpiry: 'block', prices: [{ productId: 'rice', priceMinor: 120_000 }], creditLimitMinor: 600_000, paymentTermsDays: 30 };
    const proposed = await ok(call('POST', '/v1/b2b/contracts/SCHOOL/K-1', ACCT, terms), 'propose');
    expect(proposed.body).toMatchObject({ contract: { state: 'proposed', standing: 'awaiting_approval', proposedBy: ACCT }, needs: 'approval' });
    expect(codeOf(await call('POST', '/v1/b2b/documents/SCHOOL/quotations/q0', MGR, { lines: [RICE], locationId: 'S1' }))).toBe('quotation_no_price_on_record');
    // The store manager who takes orders reads contracts but cannot propose one (separation from order-taking).
    expect((await call('POST', '/v1/b2b/contracts/SCHOOL/K-x', MGR, terms)).status).toBe(403);
    expect((await call('GET', '/v1/b2b/contracts/SCHOOL', MGR)).status).toBe(200);
    // A typed approver is refused by name — the second person acts in their own session.
    expect(codeOf(await call('POST', '/v1/b2b/contracts/SCHOOL/K-1', ACCT, { ...terms, approvedBy: OWNER }))).toBe('approver_named_without_approval');

    // ── 2 · The accountant cannot approve their own; the OWNER approves; then it is in force and sets the account.
    const self = await approve(ACCT, ACCT, 'b2b_contract', 'SCHOOL/K-1', terms, { customerId: 'SCHOOL', contractId: 'K-1' });
    expect(self.decided.status).toBe(422); // a maker never approves their own request
    const { requestId } = await approve(ACCT, OWNER, 'b2b_contract', 'SCHOOL/K-1', terms, { customerId: 'SCHOOL', contractId: 'K-1' });
    const applied = await ok(call('POST', '/v1/b2b/contracts/SCHOOL/K-1', ACCT, { ...terms, approvalId: requestId }), 'put in force');
    expect(applied.body).toMatchObject({ contract: { state: 'approved', standing: 'in_force', approvedBy: OWNER } });
    expect((await call('GET', '/v1/b2b/accounts/SCHOOL', OWNER)).body).toMatchObject({ creditLimitMinor: 600_000, outstandingMinor: 0 });
    // Never rewritten: different terms under the same id are refused; the same terms again are the same record.
    expect(codeOf(await call('POST', '/v1/b2b/contracts/SCHOOL/K-1', ACCT, { ...terms, prices: [{ productId: 'rice', priceMinor: 1 }] }))).toBe('contract_already_approved');
    expect((await call('POST', '/v1/b2b/contracts/SCHOOL/K-1', ACCT, terms)).status).toBe(200);

    // ── 3 · A quotation priced FROM THE RECORD: rice at the contract price, dal at the shop's price-list price.
    const q1 = await ok(call('POST', '/v1/b2b/documents/SCHOOL/quotations/q1', MGR, { lines: [RICE, DAL], locationId: 'S1' }), 'priced quotation');
    expect(q1.body).toMatchObject({ grossMinor: Math.round((4 * 120_000 + 10 * 9_000) * 1.05) });
    const stored = (await call('GET', '/v1/b2b/documents/SCHOOL/q1', MGR)).body as { lines: { lineId: string; unitPriceMinor: number }[]; pricedFrom: { lineId: string; priceSource: string; contractId?: string }[] };
    expect(stored.lines.map((l) => l.unitPriceMinor)).toEqual([120_000, 9_000]);
    expect(stored.pricedFrom).toEqual([{ lineId: 'l1', priceSource: 'contract', contractId: 'K-1' }, { lineId: 'l2', priceSource: 'price_list' }]);
    // A typed price that differs from the record is refused by name; salt has no price anywhere and is refused unpriced.
    expect(codeOf(await call('POST', '/v1/b2b/documents/SCHOOL/quotations/q2', MGR, { lines: [{ ...RICE, unitPriceMinor: 100_000 }], locationId: 'S1' }))).toBe('quotation_not_the_contract_price');
    expect(codeOf(await call('POST', '/v1/b2b/documents/SCHOOL/quotations/q2', MGR, { lines: [{ ...DAL, unitPriceMinor: 8_000 }], locationId: 'S1' }))).toBe('quotation_not_the_price_on_record');
    expect(codeOf(await call('POST', '/v1/b2b/documents/SCHOOL/quotations/q2', MGR, { lines: [SALT], locationId: 'S1' }))).toBe('quotation_no_price_on_record');

    // ── 4 · Over the limit (₹6,000): ₹5,985 converts; the next quotation would take it over — the OWNER decides, not the accountant.
    await ok(call('POST', '/v1/b2b/documents/SCHOOL/orders/so1', MGR, { fromQuotationId: 'q1', locationId: 'S1' }), 'within limit');
    await ok(call('POST', '/v1/b2b/accounts/SCHOOL/receivables', OWNER, { movementId: 'inv-x', kind: 'invoice', amountMinor: 500_000 }), 'owed');
    await ok(call('POST', '/v1/b2b/documents/SCHOOL/quotations/q3', MGR, { lines: [{ ...RICE, qty: 1 }], locationId: 'S1' }), 'q3');
    const over = await call('POST', '/v1/b2b/documents/SCHOOL/orders/so3', MGR, { fromQuotationId: 'q3', locationId: 'S1' });
    expect(codeOf(over)).toBe('conversion_over_limit');
    const so3 = { fromQuotationId: 'q3', locationId: 'S1' };
    const byAcct = await approve(MGR, ACCT, 'b2b_credit_override', 'SCHOOL/so3', so3, { customerId: 'SCHOOL', documentId: 'so3' }, 126_000);
    expect(byAcct.decided.status).toBe(403); // the accountant holds no credit-override authority (OB-290: it is the owner's)
    const byOwner = await approve(MGR, OWNER, 'b2b_credit_override', 'SCHOOL/so3', so3, { customerId: 'SCHOOL', documentId: 'so3' }, 126_000);
    expect(byOwner.decided.status).toBe(201);
    await ok(call('POST', '/v1/b2b/documents/SCHOOL/orders/so3', MGR, { ...so3, approvalId: byOwner.requestId }), 'override converts');
    // One approval, one order.
    await ok(call('POST', '/v1/b2b/documents/SCHOOL/quotations/q4', MGR, { lines: [{ ...RICE, qty: 1 }], locationId: 'S1' }), 'q4');
    expect((await call('POST', '/v1/b2b/documents/SCHOOL/orders/so4', MGR, { fromQuotationId: 'q4', locationId: 'S1', approvalId: byOwner.requestId })).status).toBeGreaterThanOrEqual(400);

    // ── 5 · Expiry by its own dates: a lapsed "fallback" contract prices from the list; a lapsed "block" one refuses.
    const lapsedTerms = (onExpiry: string) => ({ validFrom: shift(-40), validTo: shift(-1), onExpiry, prices: [{ productId: 'dal', priceMinor: 7_500 }], creditLimitMinor: 10_000_000 });
    for (const [cust, policy] of [['HOSTEL', 'fallback'], ['CANTEEN', 'block']] as const) {
      const t = lapsedTerms(policy);
      // CANTEEN quotes first while it has no contract — the order made from it is judged against the lapsed contract later.
      if (cust === 'CANTEEN') await ok(call('POST', `/v1/b2b/documents/${cust}/quotations/qc`, MGR, { lines: [DAL], locationId: 'S1' }), 'canteen quote before');
      await ok(call('POST', `/v1/b2b/contracts/${cust}/K-${cust}`, ACCT, t), 'propose lapsed');
      const a = await approve(ACCT, OWNER, 'b2b_contract', `${cust}/K-${cust}`, t, { customerId: cust, contractId: `K-${cust}` });
      const r = await ok(call('POST', `/v1/b2b/contracts/${cust}/K-${cust}`, ACCT, { ...t, approvalId: a.requestId }), 'approve lapsed');
      expect(r.body).toMatchObject({ contract: { standing: 'expired' } });
    }
    const fallback = await ok(call('POST', '/v1/b2b/documents/HOSTEL/quotations/qh', MGR, { lines: [DAL], locationId: 'S1' }), 'fallback quote');
    expect(fallback.body).toMatchObject({ grossMinor: Math.round(10 * 9_000 * 1.05) }); // the list price, not the lapsed ₹75
    const blocked = await call('POST', '/v1/b2b/documents/CANTEEN/quotations/qb', MGR, { lines: [DAL], locationId: 'S1' });
    expect([blocked.status, codeOf(blocked)]).toEqual([409, 'quotation_contract_expired']);
    expect(codeOf(await call('POST', '/v1/b2b/documents/CANTEEN/orders/soc', MGR, { fromQuotationId: 'qc', locationId: 'S1' }))).toBe('conversion_contract_expired');
    // The credit check reads the register too: a caller saying "not expired" changes nothing.
    const check = await ok(call('POST', '/v1/b2b/accounts/CANTEEN/credit-check', MGR, { orderId: 'x', orderValueMinor: 100, contractExpired: false }), 'credit check');
    expect(check.body).toMatchObject({ verdict: 'contract_expired', allowed: false, contractFrom: 'the contract register' });
    expect((await ok(call('POST', '/v1/b2b/accounts/HOSTEL/credit-check', MGR, { orderId: 'y', orderValueMinor: 100, contractExpired: true }), 'fallback check')).body).toMatchObject({ verdict: 'ok', allowed: true });

    // ── 6 · The desk: every customer met, each with its account, contract and documents.
    const desk = (await ok(call('GET', '/v1/b2b/desk', MGR), 'desk')).body as { customers: { customerId: string; contract: { inForce: string | null; blocked: boolean } }[] };
    expect(desk.customers.map((c) => c.customerId)).toEqual(['CANTEEN', 'HOSTEL', 'SCHOOL']);
    expect(desk.customers.find((c) => c.customerId === 'CANTEEN')!.contract.blocked).toBe(true);
    const school = (await ok(call('GET', '/v1/b2b/desk/SCHOOL', MGR), 'desk SCHOOL')).body as { account: { creditLimitMinor: number; paymentTermsDays: number }; contract: { inForce: string; daysToExpiry: number }; documents: { documentId: string; kind: string; converted: boolean | null }[] };
    expect(school.account).toMatchObject({ creditLimitMinor: 600_000, paymentTermsDays: 30 });
    expect(school.contract).toMatchObject({ inForce: 'K-1', daysToExpiry: 60 });
    expect(school.documents.find((d) => d.documentId === 'q1')).toMatchObject({ kind: 'quotation', converted: true });
    const all = (await ok(call('GET', '/v1/b2b/contracts', ACCT), 'all contracts')).body as { contracts: { contractId: string; standing: string }[] };
    expect(all.contracts.map((c) => `${c.contractId}:${c.standing}`).sort()).toEqual(['K-1:in_force', 'K-CANTEEN:expired', 'K-HOSTEL:expired']);

    // ── 7 · A cold restart keeps all of it (PostgreSQL only — the in-memory store is the process).
    if (name === 'real PostgreSQL') {
      const sql = pgPoolClient(pool!);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
      const again = (await ok(call('GET', '/v1/b2b/contracts/SCHOOL', MGR), 'after restart')).body as { position: { inForce: string }; contracts: { state: string; approvedBy: string }[] };
      expect(again.position.inForce).toBe('K-1');
      expect(again.contracts[0]).toMatchObject({ state: 'approved', approvedBy: OWNER });
      const q5 = await ok(call('POST', '/v1/b2b/documents/SCHOOL/quotations/q5', MGR, { lines: [{ ...RICE, qty: 1 }], locationId: 'S1' }), 'priced after restart');
      expect(q5.body).toMatchObject({ grossMinor: 126_000 });
    }
  }, 120_000);

  it('with the b2b feature off, the contract and desk routes answer nothing', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    for (const path of ['/v1/b2b/contracts', '/v1/b2b/desk', '/v1/b2b/desk/SCHOOL']) {
      const r = await h.request({ method: 'GET', path, userId: OWNER, tenantId: T });
      expect([r.status, codeOf(r)]).toEqual([403, 'feature_not_entitled']);
    }
  });
});
