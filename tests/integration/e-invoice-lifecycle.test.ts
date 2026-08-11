import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A20 inc2 — the durable e-invoice lifecycle on the live API: submit → the GSP connector posts the IRP's
// answer back → cancel within 24h. A registered IRN is final; nothing here fabricates the government's
// signature; an unknown answer stays retryable.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OVER = 6_000_000_000;
const GSTIN = '33ABCDE1234F1Z5';
const IRN64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const INVOICE = {
  documentType: 'Tax Invoice', supplierGstin: GSTIN, invoiceNumber: 'INV/2627/000001', invoiceDate: '2026-08-11',
  hsnCode: '100610', taxableMinor: 100000, rateBps: 500, placeOfSupply: 'intra_state', taxComponents: ['CGST', 'SGST'],
};
const B2B = { invoice: INVOICE, annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' };

const submit = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/submit`, userId: u, tenantId: A, idempotencyKey: key, body });
const record = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/record-response`, userId: u, tenantId: A, idempotencyKey: key, body });
const cancel = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/e-invoice/invoices/${id}/cancel`, userId: u, tenantId: A, idempotencyKey: key, body });
const get = (h: ApiHarness, u: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/finance/e-invoice/invoices/${id}`, userId: u, tenantId: A });

const REGISTERED = { result: { status: 'registered', irn: IRN64, signedQr: 'signed', ackNo: 'ACK1', ackDate: '2026-08-11' } };

describe('e-invoice lifecycle store (A20 inc2)', () => {
  it('submits, records the IRP registration, and reads back a final registered state', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await submit(h, 'u-owner', 'inv-1', B2B, 'l-sub')).body as { state: string }).state).toBe('submitted');
    expect(((await record(h, 'u-owner', 'inv-1', { ...REGISTERED, at: '2026-08-11T09:05:00Z' }, 'l-reg')).body as { state: string; irn: string }).irn).toBe(IRN64);
    const got = (await get(h, 'u-owner', 'inv-1')).body as { state: string; irn: string };
    expect(got.state).toBe('registered');
    expect(got.irn).toBe(IRN64);
  });

  it('keeps a registered IRN final — a later response cannot change it', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await submit(h, 'u-owner', 'inv-2', B2B, 'l2-sub');
    await record(h, 'u-owner', 'inv-2', REGISTERED, 'l2-reg');
    // A rejected response arriving afterwards is ignored.
    await record(h, 'u-owner', 'inv-2', { result: { status: 'rejected', errors: ['late'] } }, 'l2-late');
    expect(((await get(h, 'u-owner', 'inv-2')).body as { state: string }).state).toBe('registered');
  });

  it('does not e-invoice a B2C document, and refuses recording a response with no submission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await submit(h, 'u-owner', 'inv-3', { ...B2B, supplyType: 'b2c', recipientGstin: undefined }, 'l3-b2c')).body as { required: boolean }).required).toBe(false);
    expect((await record(h, 'u-owner', 'inv-3', REGISTERED, 'l3-noresp')).status).toBe(404); // never submitted
  });

  it('cancels a registered IRN within the 24-hour window, and refuses cancelling a non-registered one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // Registered just now (no explicit at → registeredAt ≈ now), so the cancel is inside the window.
    await submit(h, 'u-owner', 'inv-4', B2B, 'l4-sub');
    await record(h, 'u-owner', 'inv-4', REGISTERED, 'l4-reg');
    expect(((await cancel(h, 'u-owner', 'inv-4', { reason: 'wrong buyer GSTIN' }, 'l4-cx')).body as { state: string }).state).toBe('cancelled');
    // A submitted-but-not-registered invoice has no IRN to cancel.
    await submit(h, 'u-owner', 'inv-4b', B2B, 'l4b-sub');
    expect((await cancel(h, 'u-owner', 'inv-4b', { reason: 'x' }, 'l4b-cx')).status).toBe(422);
    // (The 24h-elapsed refusal is unit-tested via assessCancellation with an injected clock.)
  });

  it('gates on the permissions and 404s an unknown invoice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await get(h, 'u-owner', 'nope')).status).toBe(404);
    expect((await submit(h, 'u-cash', 'inv-5', B2B, 'l5-rbac')).status).toBe(403);
    expect((await get(h, 'u-cash', 'inv-1')).status).toBe(403);
  });
});
