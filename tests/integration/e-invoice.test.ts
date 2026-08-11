import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A20 — GST e-invoicing on the live API (deterministic core): eligibility (₹5-cr-gated, B2C-excluded),
// the IRP-request build (a Rule-46-invalid invoice is never sent), and the apply-IRP-answer step that
// never fabricates the government's IRN/QR and keeps an unknown answer as its own state.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OVER = 6_000_000_000;
const GSTIN = '33ABCDE1234F1Z5';
const IRN64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const INVOICE = {
  documentType: 'Tax Invoice', supplierGstin: GSTIN, invoiceNumber: 'INV/2627/000001', invoiceDate: '2026-08-11',
  hsnCode: '100610', taxableMinor: 100000, rateBps: 500, placeOfSupply: 'intra_state', taxComponents: ['CGST', 'SGST'],
};

const post = (h: ApiHarness, u: string, path: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path, userId: u, tenantId: A, idempotencyKey: key, body });

describe('e-invoicing deterministic core (A20)', () => {
  it('decides eligibility: B2B over ₹5cr required, B2C excluded', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect(((await post(h, 'u-owner', '/v1/finance/e-invoice/eligibility', { annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }, 'ei-b2b')).body as { required: boolean }).required).toBe(true);
    expect(((await post(h, 'u-owner', '/v1/finance/e-invoice/eligibility', { annualTurnoverMinor: OVER, supplyType: 'b2c', documentType: 'INV' }, 'ei-b2c')).body as { reason: string }).reason).toBe('b2c_excluded');
  });

  it('builds the IRP request from a valid invoice, and refuses a Rule-46-invalid one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const built = (await post(h, 'u-owner', '/v1/finance/e-invoice/build', { invoice: INVOICE, annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }, 'ei-build')).body as { built: boolean; idempotencyKey: string };
    expect(built.built).toBe(true);
    expect(built.idempotencyKey).toBe('33ABCDE1234F1Z5|INV|INV/2627/000001|2026-27');
    // A malformed invoice must not be sent to the IRP.
    expect((await post(h, 'u-owner', '/v1/finance/e-invoice/build', { invoice: { ...INVOICE, supplierGstin: 'BAD' }, annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }, 'ei-bad')).status).toBe(422);
  });

  it('applies the IRP answer without fabricating a signature it did not receive', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // A real registration is stored.
    expect(((await post(h, 'u-owner', '/v1/finance/e-invoice/apply-irp-result', { invoiceId: 'inv-1', result: { status: 'registered', irn: IRN64, signedQr: 'eyJhbGc...signed', ackNo: 'ACK1', ackDate: '2026-08-11' } }, 'ei-ok')).body as { state: string }).state).toBe('registered');
    // A malformed IRN is NOT stored as registered.
    expect(((await post(h, 'u-owner', '/v1/finance/e-invoice/apply-irp-result', { invoiceId: 'inv-1', result: { status: 'registered', irn: 'not-hex', signedQr: 'x', ackNo: 'A', ackDate: 'd' } }, 'ei-forge')).body as { state: string }).state).toBe('provider_error');
    // An unknown answer stays unknown — not a silent success.
    expect(((await post(h, 'u-owner', '/v1/finance/e-invoice/apply-irp-result', { invoiceId: 'inv-1', result: { status: 'unknown', reason: 'timeout' } }, 'ei-unk')).body as { state: string }).state).toBe('pending_unknown');
  });

  it('refuses malformed requests and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await post(h, 'u-owner', '/v1/finance/e-invoice/eligibility', { supplyType: 'b2b' }, 'ei-mal')).status).toBe(400);
    expect((await post(h, 'u-cash', '/v1/finance/e-invoice/eligibility', { annualTurnoverMinor: OVER, supplyType: 'b2b', recipientGstin: GSTIN, documentType: 'INV' }, 'ei-rbac')).status).toBe(403);
  });
});
