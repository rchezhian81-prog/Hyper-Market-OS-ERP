import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn, shopMonthIn } from '../../packages/calendar/src/shop-clock';

/**
 * **WF-18 / M23-FR-01 / M22-FR-04 (re-audit 27 Oct 2026) — the month-end close checks the credit-customer receivables with
 * real figures.** Until now every close test reached only the "no credit customer" line of this check. Here, on the real
 * head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), a business customer on 30-day terms is invoiced
 * ₹1,000 and pays ₹600 through collections, so the credit-customer ledger says ₹400 is owed. Then:
 *   • before the accountant's posting run, the books hold nothing on the receivables account: the close is HELD, naming
 *     the receivables check and the exact difference;
 *   • after the run (posted by the owner, so the accountant may sign), the ledger and the books both say ₹400 — the check
 *     agrees, the collections sub-ledger agrees with the finance AR balance, and the month closes;
 *   • a credit note keyed straight onto the customer's ledger with no journal behind it (a deliberate mismatch) makes the
 *     ledger ₹350 against ₹400 in the books — the close is HELD again, naming the ₹50 difference, and nothing is saved.
 * The rice is zero-rated and carries no buying cost, so no output-GST or stock-value check is in play: the receivables
 * check is the only one that can hold or pass the close.
 */

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

const PERIOD = shopMonthIn(new Date().toISOString());
const TODAY = shopDateIn(new Date().toISOString());
const CHECK = `Credit-customer receivables as at the close of ${PERIOD}`;
// 10 × ₹100 zero-rated rice → ₹1,000 gross, no tax.
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 0 }];

interface Check { name: string; leftMinor: number; rightMinor: number; leftDerivation: string; rightDerivation: string }
interface Evidence { agrees: boolean; checks: Check[]; notChecked: string[]; books: { receivablesLedgerMinor: number; receivablesBooksMinor: number } }
interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }

async function creditCustomerInvoicedAndPartPaid(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.enableFeature(t, 'b2b');
  await h.provisionRole(t, 'u-acct', 'accountant');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

  await ok(setApprovedCreditLimit(h, t, 'u-owner', 'CUST1', { creditLimitMinor: 1_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), 'terms');
  await ok(call('POST', '/v1/b2b/documents/CUST1/quotations/q1', 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), 'CUST1', LINES) }), 'quote');
  await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' }), 'stock');
  await ok(call('POST', '/v1/b2b/documents/CUST1/orders/so1', 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
  await ok(call('POST', '/v1/b2b/documents/CUST1/challans/dc1', 'u-owner', { fromOrderId: 'so1', dispatched: { l1: 10 } }), 'challan');
  const inv = await ok(call('POST', '/v1/b2b/documents/CUST1/invoices/inv1', 'u-owner', { fromOrderId: 'so1' }), 'invoice');
  expect(inv.body).toMatchObject({ grossMinor: 100_000 });
  await ok(call('POST', '/v1/b2b/collections/CUST1/payments/r1', 'u-owner', { receivedMinor: 60_000 }), 'collection');
  await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'mapping');

  const evidence = async () => (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as Evidence;
  const reconciliation = async () => (await call('GET', '/v1/b2b/collections/CUST1/reconciliation', 'u-acct', undefined, { asOf: TODAY })).body as { portalOutstandingMinor: number; financeOutstandingMinor: number; agrees: boolean };
  // The owner closes; the accountant signs (a second person, ADR-0024). The owner posts, so the signer posted nothing.
  const close = async () => call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, t, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
  const post = () => ok(call('POST', '/v1/finance/b2b/post', 'u-owner', {}), 'B2B posting run');
  return { call, ok, evidence, reconciliation, close, post };
}

describe.each(backings)('WF-18 — the close checks the credit-customer receivables with real figures — on $name', ({ harness }) => {
  it('unposted receivables HOLD the close by name; once posted, the ledger and the books agree and the month closes', async () => {
    const h = harness();
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID());

    // ── The credit-customer ledger owes ₹400 (₹1,000 invoiced − ₹600 collected); nothing is in the books yet.
    const before = await s.evidence();
    expect(before.notChecked.join(' ')).not.toMatch(/Credit-customer receivables: no credit customer/);
    expect(before.checks.map((c) => c.name)).toEqual([CHECK]); // the only check in play
    expect(before.checks[0]).toMatchObject({ leftMinor: 40_000, rightMinor: 0, rightDerivation: expect.stringContaining('trade_receivables') });
    expect(before.books).toMatchObject({ receivablesLedgerMinor: 40_000, receivablesBooksMinor: 0 });
    expect(before.agrees).toBe(false);
    const held = await s.close();
    expect(held.status).toBe(422);
    const refusal = held.body as Refusal;
    expect(refusal.error.code).toBe('control_total_does_not_agree');
    expect(refusal.error.whatHappened).toContain(`"${CHECK}"`);
    expect(refusal.error.whatHappened).toMatch(/gives 40000 .* gives 0, a difference of -40000/);
    expect(refusal.error.wasItSaved).toBe('not_saved');

    // ── The accountant's mapping posts the invoice (receivables up) and the collection (receivables down), once each.
    await s.post();
    const after = await s.evidence();
    expect(after.checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 40_000, rightMinor: 40_000 });
    expect(after.books).toMatchObject({ receivablesLedgerMinor: 40_000, receivablesBooksMinor: 40_000 });
    expect(after.agrees).toBe(true);
    // The collections sub-ledger the customer sees agrees with the finance AR balance too.
    expect(await s.reconciliation()).toMatchObject({ portalOutstandingMinor: 40_000, financeOutstandingMinor: 40_000, agrees: true });

    const closed = await s.close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }, 60_000);

  it('a deliberate mismatch — a credit note on the customer\'s ledger with no journal — HOLDS the close, naming the ₹50 difference', async () => {
    const h = harness();
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID());
    await s.post();
    expect((await s.evidence()).agrees).toBe(true);

    // A ₹50 credit note keyed onto the customer's AR ledger only: no B2B posting fact, so no journal will ever carry it.
    await s.ok(s.call('POST', '/v1/b2b/accounts/CUST1/receivables', 'u-acct', { movementId: 'cn-1', kind: 'credit_note', amountMinor: 5_000, ref: 'CN-1' }), 'credit note');
    const ev = await s.evidence();
    expect(ev.checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 35_000, rightMinor: 40_000 });
    expect(ev.agrees).toBe(false);
    // The re-run has nothing to post for it: the difference is not something the posting run can paper over.
    expect(((await s.call('POST', '/v1/finance/b2b/post', 'u-owner', {})).body as { posted: unknown[] }).posted).toEqual([]);

    const held = await s.close();
    expect(held.status).toBe(422);
    const refusal = held.body as Refusal;
    expect(refusal.error.code).toBe('control_total_does_not_agree');
    expect(refusal.error.whatHappened).toContain(`"${CHECK}"`);
    expect(refusal.error.whatHappened).toMatch(/gives 35000 .* gives 40000, a difference of 5000/);
    expect(refusal.error.wasItSaved).toBe('not_saved');
    // The collections sub-ledger and the finance AR balance now disagree as well — both views show it.
    expect(await s.reconciliation()).toMatchObject({ portalOutstandingMinor: 40_000, financeOutstandingMinor: 35_000, agrees: false });
    // The month is still open: the close was refused, not recorded.
    expect((await s.close()).status).toBe(422);
  }, 60_000);
});
