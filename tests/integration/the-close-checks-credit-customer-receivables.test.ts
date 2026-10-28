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
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

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
 *
 * **OB-408 (owner, option A, 27 Oct 2026)** — three faults this test found, fixed:
 *   1. a TAXED (5%) B2B invoice's output GST reaches the GST return as it is issued, once, under its invoice number — the
 *      month closes with "Output GST" agreeing, and a hand entry for the same invoice is recognised or refused by name;
 *   2. a customer whose only movements were keyed by hand on their receivables ledger is compared (and holds the close);
 *   3. the check is cut off at the period's end on the shop's calendar — an entry after it is not in that period's check.
 *
 * **OB-416** — with the customer's GSTIN on the credit account, the same 5% invoice files in GSTR-1's B2B section under that
 * GSTIN, and the close's Output GST still agrees with the books (the tax is the same; only the section changes).
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
const GST_CHECK = `Output GST for ${PERIOD}`;
const PREV = ((y: number, m: number) => (m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`))(Number(PERIOD.slice(0, 4)), Number(PERIOD.slice(5, 7)));
// 10 × ₹100 zero-rated rice → ₹1,000 gross, no tax.
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 0 }];
// OB-408: the same rice at 5% GST → ₹1,000 net + ₹50 GST (₹25 CGST + ₹25 SGST, delivered inside Tamil Nadu) = ₹1,050.
const TAXED_LINES = [{ ...LINES[0]!, taxRateBps: 500 }];

interface Check { name: string; leftMinor: number; rightMinor: number; leftDerivation: string; rightDerivation: string }
interface Evidence { agrees: boolean; checks: Check[]; notChecked: string[]; books: { receivablesLedgerMinor: number; receivablesBooksMinor: number } }
interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }

async function creditCustomerInvoicedAndPartPaid(h: ApiHarness, t: string, opts: { readonly taxed?: boolean; readonly gstin?: string } = {}) {
  await h.seedOwner(t, 'u-owner');
  await h.enableFeature(t, 'b2b');
  await h.provisionRole(t, 'u-acct', 'accountant');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  const lines = opts.taxed === true ? TAXED_LINES : LINES;
  if (opts.taxed === true) {
    // The store's GSTIN (33, Tamil Nadu) so the invoice carries its CGST + SGST split; rice's HSN in the published catalogue.
    await ok(call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' }), 'company');
    await ok(call('POST', '/v1/org/gst-registrations/33AABCS1429B1Z1', 'u-owner', { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }), 'GST registration');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: '33AABCS1429B1Z1', placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' }), 'store');
    const at = new Date().toISOString();
    await h.store.append(t, STREAM.catalogue, makeEvent({
      id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: t, version: 1, builtAt: at, products: [{ productId: 'p1', sku: 'p1', name: 'Rice 25kg', unitPriceMinor: 10_000, taxBps: 500, hsnCode: '1006', status: 'active', uom: 'ea' }], barcodes: [] } },
    }));
  }

  await ok(setApprovedCreditLimit(h, t, 'u-owner', 'CUST1', { creditLimitMinor: 1_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), 'terms');
  // OB-416: a registered customer — its GSTIN on the credit account before the invoice is issued.
  if (opts.gstin !== undefined) await ok(call('POST', '/v1/b2b/accounts/CUST1/gstin', 'u-acct', { gstin: opts.gstin, legalName: 'Synthetic Caterers', reason: 'GST certificate on file' }), 'customer GSTIN');
  await ok(call('POST', '/v1/b2b/documents/CUST1/quotations/q1', 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), 'CUST1', lines) }), 'quote');
  await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: 'u-owner' }), 'stock');
  await ok(call('POST', '/v1/b2b/documents/CUST1/orders/so1', 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
  await ok(call('POST', '/v1/b2b/documents/CUST1/challans/dc1', 'u-owner', { fromOrderId: 'so1', dispatched: { l1: 10 } }), 'challan');
  const inv = await ok(call('POST', '/v1/b2b/documents/CUST1/invoices/inv1', 'u-owner', { fromOrderId: 'so1' }), 'invoice');
  expect(inv.body).toMatchObject({ grossMinor: opts.taxed === true ? 105_000 : 100_000 });
  const invoiceNumber = (inv.body as { number: string }).number;
  await ok(call('POST', '/v1/b2b/collections/CUST1/payments/r1', 'u-owner', { receivedMinor: 60_000 }), 'collection');
  await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'mapping');

  const evidence = async (period = PERIOD) => (await call('GET', `/v1/finance/periods/${period}/independent-evidence`, 'u-acct')).body as Evidence;
  const reconciliation = async () => (await call('GET', '/v1/b2b/collections/CUST1/reconciliation', 'u-acct', undefined, { asOf: TODAY })).body as { portalOutstandingMinor: number; financeOutstandingMinor: number; agrees: boolean };
  // The owner closes; the accountant signs (a second person, ADR-0024). The owner posts, so the signer posted nothing.
  const close = async () => call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, t, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
  const post = () => ok(call('POST', '/v1/finance/b2b/post', 'u-owner', {}), 'B2B posting run');
  return { call, ok, evidence, reconciliation, close, post, invoiceNumber };
}

describe.each(backings)('WF-18 — the close checks the credit-customer receivables with real figures — on $name', ({ harness }) => {
  it('unposted receivables HOLD the close by name; once posted, the ledger and the books agree and the month closes', async () => {
    const h = harness();
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID());

    // ── The credit-customer ledger owes ₹400 (₹1,000 invoiced − ₹600 collected); nothing is in the books yet.
    const before = await s.evidence();
    expect(before.notChecked.join(' ')).not.toMatch(/Credit-customer receivables: no credit customer/);
    expect(before.checks.map((c) => c.name)).toEqual([CHECK]); // the only check in play
    // OB-408: rice has no HSN in any catalogue and the store's GSTIN is not on record, so the invoice could not be put on
    // the GST return when issued — said by its number and why, never left silently off the return.
    expect(before.notChecked.join(' ')).toMatch(new RegExp(`Output GST: 1 B2B tax invoice\\(s\\) of ${PERIOD} could not be put on the GST return when issued \\(${s.invoiceNumber}: .*no CGST / SGST / IGST split.*"Rice 25kg" \\(p1\\) has no HSN`));
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
  it('OB-408 (1) — a 5% B2B invoice\'s output GST reaches the GST return as it is issued: the month closes with Output GST agreeing, and a hand entry for it is never counted twice', async () => {
    const h = harness();
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID(), { taxed: true });
    await s.post();
    const ev = await s.evidence();
    // The books' output tax (posted by the B2B run) and the GST return's tax for the month — both ₹50.
    expect(ev.checks.find((c) => c.name === GST_CHECK), JSON.stringify(ev)).toMatchObject({ leftMinor: 5_000, rightMinor: 5_000 });
    expect(ev.checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 45_000, rightMinor: 45_000 });
    expect(ev.agrees, JSON.stringify(ev.checks)).toBe(true);
    // The return carries the invoice once, under its number, with the split the invoice charged.
    const from = `${PERIOD}-01`;
    const to = `${PERIOD}-31`;
    const ret = (await s.call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, { from, to })).body as { documentCount: number; totalTaxMinor: number; hsn: { rows: { hsnCode: string; rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number }[] } };
    expect(ret).toMatchObject({ documentCount: 1, totalTaxMinor: 5_000 });
    expect(ret.hsn.rows).toEqual([expect.objectContaining({ hsnCode: '1006', rateBps: 500, taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500 })]);

    // A hand entry under the invoice's number is the same document — recognised, not added.
    const hand = { documentDate: TODAY, supplyType: 'b2c', annualTurnoverMinor: 0, lines: [{ hsnCode: '1006', quantityMinor: 10, uom: 'ea', taxableMinor: 100_000, rateBps: 500, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 }] };
    const same = await s.call('POST', `/v1/finance/outward-supplies/${encodeURIComponent(s.invoiceNumber)}`, 'u-owner', hand);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body).toMatchObject({ alreadyRecorded: true, fedFrom: { kind: 'b2b_tax_invoice', customerId: 'CUST1', invoiceDocumentId: 'inv1' } });
    // A hand entry naming the invoice by its document id is refused by name — it would count the GST twice.
    const twice = await s.call('POST', '/v1/finance/outward-supplies/inv1', 'u-owner', hand);
    expect(twice.status).toBe(409);
    expect((twice.body as Refusal).error).toMatchObject({ code: 'b2b_invoice_already_on_the_return', wasItSaved: 'not_saved' });
    expect((await s.evidence()).checks.find((c) => c.name === GST_CHECK)).toMatchObject({ leftMinor: 5_000, rightMinor: 5_000 });

    const closed = await s.close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }, 60_000);

  it('OB-416 — a registered customer\'s 5% invoice files B2B under its GSTIN, and the close\'s Output GST still agrees with the books', async () => {
    const h = harness();
    const gstin = '33ZZZZZ9999Z1ZF'; // synthetic, valid check character — no real business
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID(), { taxed: true, gstin });
    await s.post();
    const ev = await s.evidence();
    expect(ev.checks.find((c) => c.name === GST_CHECK), JSON.stringify(ev)).toMatchObject({ leftMinor: 5_000, rightMinor: 5_000 });
    expect(ev.checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 45_000, rightMinor: 45_000 });
    expect(ev.agrees, JSON.stringify(ev.checks)).toBe(true);
    const ret = (await s.call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, { from: `${PERIOD}-01`, to: `${PERIOD}-31` })).body as { documentCount: number; totalTaxMinor: number; b2b: { recipientGstin: string; invoiceNumber: string }[]; b2c: unknown[] };
    expect(ret).toMatchObject({ documentCount: 1, totalTaxMinor: 5_000, b2c: [] });
    expect(ret.b2b).toEqual([expect.objectContaining({ recipientGstin: gstin, invoiceNumber: s.invoiceNumber })]);
    const closed = await s.close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }, 60_000);

  it('OB-408 (2) — a customer whose only movements were keyed by hand is compared, and their balance with nothing in the books HOLDS the close', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.enableFeature(t, 'b2b');
    await h.provisionRole(t, 'u-acct', 'accountant');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `h-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    expect((await call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    // ₹250 keyed by hand onto CUST2's receivables ledger — no B2B invoice, no posting fact, no journal.
    const keyed = await call('POST', '/v1/b2b/accounts/CUST2/receivables', 'u-acct', { movementId: 'hand-1', kind: 'invoice', amountMinor: 25_000, ref: 'OLD-BILL-7' });
    expect(keyed.status, JSON.stringify(keyed.body)).toBe(201);

    const ev = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as Evidence;
    expect(ev.notChecked.join(' ')).not.toMatch(/Credit-customer receivables: no credit customer/);
    expect(ev.checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 25_000, rightMinor: 0 });
    expect(ev.books).toMatchObject({ receivablesLedgerMinor: 25_000, receivablesBooksMinor: 0 });
    expect(ev.agrees).toBe(false);
    const held = await call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, t, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
    expect(held.status).toBe(422);
    const refusal = held.body as Refusal;
    expect(refusal.error.code).toBe('control_total_does_not_agree');
    expect(refusal.error.whatHappened).toContain(`"${CHECK}"`);
    expect(refusal.error.whatHappened).toMatch(/gives 25000 .* gives 0, a difference of -25000/);
    expect(refusal.error.wasItSaved).toBe('not_saved');
  }, 60_000);

  it('OB-408 (3) — the check is cut off at the period\'s end: this month\'s invoice and collection are not in last month\'s check', async () => {
    const h = harness();
    const s = await creditCustomerInvoicedAndPartPaid(h, randomUUID());
    await s.post();
    // This month: the ledger and the books both hold the ₹400.
    expect((await s.evidence()).checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 40_000, rightMinor: 40_000 });
    // Last month closed before any of it: neither side holds anything dated by its end, so it is not compared — said.
    const prev = await s.evidence(PREV);
    expect(prev.checks.map((c) => c.name)).not.toContain(`Credit-customer receivables as at the close of ${PREV}`);
    expect(prev.notChecked).toContain(`Credit-customer receivables: no credit customer has an invoice, a collection or any other movement dated by the close of ${PREV}.`);
    expect(prev.books).toMatchObject({ receivablesLedgerMinor: 0, receivablesBooksMinor: 0 });
    // A hand-keyed credit note today changes this month's ledger, never last month's.
    await s.ok(s.call('POST', '/v1/b2b/accounts/CUST1/receivables', 'u-acct', { movementId: 'cn-late', kind: 'credit_note', amountMinor: 5_000, ref: 'CN-LATE' }), 'credit note');
    expect((await s.evidence()).checks.find((c) => c.name === CHECK)).toMatchObject({ leftMinor: 35_000, rightMinor: 40_000 });
    expect((await s.evidence(PREV)).books).toMatchObject({ receivablesLedgerMinor: 0, receivablesBooksMinor: 0 });
  }, 60_000);
});
