import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A20 — the sandbox GSP register route: run a canonical IRP request through the deterministic simulator so
// the submit → register → apply loop can be driven without a live GSP. The IRN is hash-derived and the QR
// is SANDBOX-marked; nothing here is valid for a real filing.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = {
  supplierGstin: '33ABCDE1234F1Z5', documentType: 'INV', documentNumber: 'INV/2627/000001',
  documentDate: '2026-08-11', financialYear: '2026-27', recipientGstin: '33ZZZZZ9999Z1Z5', taxableMinor: 100_000,
};
const IRN64 = /^[0-9a-fA-F]{64}$/;

const sandbox = (h: ApiHarness, u: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/finance/e-invoice/sandbox/register', userId: u, tenantId: A, idempotencyKey: key, body });

describe('POST /v1/finance/e-invoice/sandbox/register (A20)', () => {
  it('registers a valid request, returning a sandbox IRN + SANDBOX-marked QR through the applied record', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await sandbox(h, 'u-owner', { invoiceId: 'inv-1', request: REQUEST }, 'sb-1')).body as {
      sandbox: boolean; result: { status: string }; record: { state: string; irn: string; signedQr: string };
    };
    expect(body.sandbox).toBe(true);
    expect(body.result.status).toBe('registered');
    expect(body.record.state).toBe('registered');
    expect(body.record.irn).toMatch(IRN64);
    expect(body.record.signedQr.startsWith('SANDBOX.')).toBe(true);
  });

  it('exercises the unknown (timeout) and rejected paths on demand', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const unknown = (await sandbox(h, 'u-owner', { invoiceId: 'inv-2', request: REQUEST, force: 'unknown' }, 'sb-2')).body as { record: { state: string } };
    expect(unknown.record.state).toBe('pending_unknown');
    const rejected = (await sandbox(h, 'u-owner', { invoiceId: 'inv-3', request: REQUEST, force: 'rejected' }, 'sb-3')).body as { record: { state: string } };
    expect(rejected.record.state).toBe('rejected');
  });

  it('refuses a malformed request, a bad force value, and gates on the e-invoice permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // no finance.einvoice.generate

    expect((await sandbox(h, 'u-owner', { invoiceId: 'inv-4' }, 'sb-4')).status).toBe(400); // no request
    expect((await sandbox(h, 'u-owner', { invoiceId: 'inv-5', request: { ...REQUEST, taxableMinor: 'lots' } }, 'sb-5')).status).toBe(400); // bad field
    expect((await sandbox(h, 'u-owner', { invoiceId: 'inv-6', request: REQUEST, force: 'boom' }, 'sb-6')).status).toBe(400); // bad force
    expect((await sandbox(h, 'u-cash', { invoiceId: 'inv-7', request: REQUEST }, 'sb-7')).status).toBe(403); // permission
  });
});
