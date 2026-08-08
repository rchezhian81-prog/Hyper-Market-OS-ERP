import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The B2B document chain, part 2 — proforma → challan → tax-invoice-from-challans + the chain check
// (M22-FR-02, API-09), end to end through the real API, the real gap-free number series and the real
// RBAC. The controls that cost real money if wrong:
//
//   • A PROFORMA IS NOT A TAX INVOICE — taxClaimable is false and it draws from its own series.
//   • A CHALLAN CARRIES WHAT ACTUALLY LEFT — over-delivery (cumulative dispatch beyond the order) is
//     refused; a number is drawn only on success.
//   • THE TAX INVOICE IS BUILT FROM THE CHALLANS, NEVER THE ORDER — partial delivery bills partially,
//     and an invoice that would exceed what was delivered is refused.
//   • THE CHAIN CHECK NAMES GOODS GONE OUT WITH NO CLAIM ON THEM — delivered-but-not-invoiced.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Order: l1 = 10 × ₹100 @5%, l2 = 5 × ₹200 @5% → gross ₹2,100.00 (2,10,000 minor).
const LINES = [
  { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 },
  { lineId: 'l2', productId: 'p2', description: 'Oil 15L', qty: 5, unitPriceMinor: 20_000, taxRateBps: 500 },
];
const ORDER_GROSS = 210_000;

const setLimit = (h: ApiHarness, t: string, u: string, cust: string, creditLimitMinor: number) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${cust}`, userId: u, tenantId: t, idempotencyKey: `lim-${cust}`, body: { creditLimitMinor } });
const quote = (h: ApiHarness, t: string, u: string, cust: string, id: string, lines: unknown) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/quotations/${id}`, userId: u, tenantId: t, idempotencyKey: `q-${id}`, body: { lines } });
const order = (h: ApiHarness, t: string, u: string, cust: string, id: string, fromQuotationId: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/orders/${id}`, userId: u, tenantId: t, idempotencyKey: `o-${id}`, body: { fromQuotationId } });
const proforma = (h: ApiHarness, t: string, u: string, cust: string, id: string, fromOrderId: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/proformas/${id}`, userId: u, tenantId: t, idempotencyKey: `pf-${id}`, body: { fromOrderId } });
const challan = (h: ApiHarness, t: string, u: string, cust: string, id: string, fromOrderId: string, dispatched: unknown) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/challans/${id}`, userId: u, tenantId: t, idempotencyKey: `dc-${id}`, body: { fromOrderId, dispatched } });
const invoice = (h: ApiHarness, t: string, u: string, cust: string, id: string, fromOrderId: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/invoices/${id}`, userId: u, tenantId: t, idempotencyKey: `inv-${id}`, body: { fromOrderId } });
const chain = (h: ApiHarness, t: string, u: string, cust: string, orderId: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/documents/${cust}/orders/${orderId}/chain`, userId: u, tenantId: t });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Doc { number: string; kind: string; taxClaimable?: boolean; grossMinor: number }
interface Chain { complete: boolean; orderedMinor: number; deliveredMinor: number; invoicedMinor: number; undeliveredMinor: number; uninvoicedMinor: number }

// Seed an owner, a generous credit limit, and an order 'so1' derived from quotation 'q1'.
async function makeOrder(h: ApiHarness, cust: string): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await setLimit(h, A, 'u-owner', cust, 1_000_000);
  await quote(h, A, 'u-owner', cust, 'q1', LINES);
  expect((await order(h, A, 'u-owner', cust, 'so1', 'q1')).status).toBe(201);
}

describe('b2b document chain part 2: proforma, challan (what left), invoice-from-challans, chain check (M22-FR-02)', () => {
  it('a proforma is a request for payment on its own series, never a tax invoice', async () => {
    const h = apiHarness();
    await makeOrder(h, 'CUST1');

    const pf = await proforma(h, A, 'u-owner', 'CUST1', 'pf1', 'so1');
    expect(pf.status).toBe(201);
    expect((pf.body as Doc).number).toBe('PF-000001');   // its OWN series
    expect((pf.body as Doc).taxClaimable).toBe(false);   // the single most important field
    expect((pf.body as Doc).grossMinor).toBe(ORDER_GROSS);
  });

  it('a challan carries what LEFT the building, and over-delivery is refused with no number drawn', async () => {
    const h = apiHarness();
    await makeOrder(h, 'CUST1');

    // 11 of l1 against 10 ordered — refused.
    const over = await challan(h, A, 'u-owner', 'CUST1', 'dc-bad', 'so1', { l1: 11 });
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('challan_over_delivery');

    // A partial dispatch: 6 of l1 goes, l2 stays. First accepted challan is DC-000001 (the bad one drew nothing).
    const dc = await challan(h, A, 'u-owner', 'CUST1', 'dc1', 'so1', { l1: 6 });
    expect(dc.status).toBe(201);
    expect((dc.body as Doc).number).toBe('DC-000001');
    expect((dc.body as Doc).grossMinor).toBe(63_000);   // 6 × ₹100 + 5%
  });

  it('the invoice is built from the challans — partial bills partially, and it cannot exceed what was delivered', async () => {
    const h = apiHarness();
    await makeOrder(h, 'CUST1');

    // Nothing delivered yet → nothing to invoice.
    expect(codeOf(await invoice(h, A, 'u-owner', 'CUST1', 'inv-early', 'so1'))).toBe('invoice_no_challan');

    // Deliver 6 of l1, then invoice — it bills the DELIVERED 6, not the ordered 10.
    await challan(h, A, 'u-owner', 'CUST1', 'dc1', 'so1', { l1: 6 });
    const inv1 = await invoice(h, A, 'u-owner', 'CUST1', 'inv1', 'so1');
    expect(inv1.status).toBe(201);
    expect((inv1.body as Doc).number).toBe('INV-000001');
    expect((inv1.body as Doc).taxClaimable).toBe(true);
    expect((inv1.body as Doc).grossMinor).toBe(63_000);

    // Deliver the rest (4 of l1, 5 of l2), then invoice the remainder only.
    await challan(h, A, 'u-owner', 'CUST1', 'dc2', 'so1', { l1: 4, l2: 5 });
    const inv2 = await invoice(h, A, 'u-owner', 'CUST1', 'inv2', 'so1');
    expect(inv2.status).toBe(201);
    expect((inv2.body as Doc).grossMinor).toBe(147_000);   // 4 × ₹100 + 5 × ₹200, each +5%

    // Everything delivered is now billed — a further invoice is refused, not a duplicate bill.
    expect(codeOf(await invoice(h, A, 'u-owner', 'CUST1', 'inv3', 'so1'))).toBe('invoice_exceeds_delivered');
  });

  it('the chain check names goods delivered but not yet billed, then reconciles once billed', async () => {
    const h = apiHarness();
    await makeOrder(h, 'CUST1');

    await challan(h, A, 'u-owner', 'CUST1', 'dc1', 'so1', { l1: 6 });
    const mid = (await chain(h, A, 'u-owner', 'CUST1', 'so1')).body as Chain;
    expect(mid.deliveredMinor).toBe(63_000);
    expect(mid.invoicedMinor).toBe(0);
    expect(mid.uninvoicedMinor).toBe(63_000);   // gone out of the door, no claim on it
    expect(mid.complete).toBe(false);

    // Bill it and deliver + bill the rest.
    await invoice(h, A, 'u-owner', 'CUST1', 'inv1', 'so1');
    await challan(h, A, 'u-owner', 'CUST1', 'dc2', 'so1', { l1: 4, l2: 5 });
    await invoice(h, A, 'u-owner', 'CUST1', 'inv2', 'so1');

    const done = (await chain(h, A, 'u-owner', 'CUST1', 'so1')).body as Chain;
    expect(done.orderedMinor).toBe(ORDER_GROSS);
    expect(done.deliveredMinor).toBe(ORDER_GROSS);
    expect(done.invoicedMinor).toBe(ORDER_GROSS);
    expect(done.undeliveredMinor).toBe(0);
    expect(done.uninvoicedMinor).toBe(0);
    expect(done.complete).toBe(true);
  });

  it('is authorized and per-tenant: a cashier cannot issue or read the chain; another tenant sees nothing', async () => {
    const h = apiHarness();
    await makeOrder(h, 'CUST1');
    await h.provisionRole(A, 'u-acct', 'accountant');   // reads
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither

    expect((await proforma(h, A, 'u-cash', 'CUST1', 'pf-x', 'so1')).status).toBe(403);
    expect((await challan(h, A, 'u-cash', 'CUST1', 'dc-x', 'so1', { l1: 1 })).status).toBe(403);
    expect((await chain(h, A, 'u-cash', 'CUST1', 'so1')).status).toBe(403);
    expect((await chain(h, A, 'u-acct', 'CUST1', 'so1')).status).toBe(200);   // an accountant may read

    await h.seedOwner(B, 'u-owner-b');
    expect((await chain(h, B, 'u-owner-b', 'CUST1', 'so1')).status).toBe(404);
  });
});
