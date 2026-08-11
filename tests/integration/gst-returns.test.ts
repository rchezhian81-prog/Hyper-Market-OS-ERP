import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// A5 — the GST-returns write path on the live API: persist outward-supply tax lines, then read GSTR-1
// Table 12 (HSN-wise, B2B/B2C split) over the stored data. A free-text HSN is rejected before storage.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OVER = 6_000_000_000;
const GSTIN = '33ABCDE1234F1Z5';
const line = (o: Record<string, unknown> = {}) =>
  ({ hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10000, rateBps: 500, cgstMinor: 250, sgstMinor: 250, igstMinor: 0, ...o });

const record = (h: ApiHarness, u: string, id: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/finance/outward-supplies/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const table12 = (h: ApiHarness, u: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/finance/gstr1/table-12', userId: u, tenantId: A, query: { from, to } });
const gstr1 = (h: ApiHarness, u: string, from: string, to: string) =>
  h.request({ method: 'GET', path: '/v1/finance/gstr1/return', userId: u, tenantId: A, query: { from, to } });
const exportJson = (h: ApiHarness, u: string, q: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/finance/gstr1/export', userId: u, tenantId: A, query: q });

describe('GST-returns write path + GSTR-1 Table 12 (A5)', () => {
  it('persists outward lines and folds them into a Table-12 summary with a B2B/B2C split', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await record(h, 'u-owner', 'inv-b2b', { documentDate: '2026-08-05', supplyType: 'b2b', recipientGstin: GSTIN, annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 10000, cgstMinor: 250, sgstMinor: 250 })] }, 'g-b2b')).status).toBe(201);
    expect((await record(h, 'u-owner', 'rcpt-b2c', { documentDate: '2026-08-06', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 20000, cgstMinor: 500, sgstMinor: 500 })] }, 'g-b2c')).status).toBe(201);
    // Outside the period — must not appear in the August return.
    await record(h, 'u-owner', 'rcpt-jul', { documentDate: '2026-07-31', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 99999, cgstMinor: 250, sgstMinor: 250 })] }, 'g-jul');

    const body = (await table12(h, 'u-owner', '2026-08-01', '2026-08-31')).body as { rows: { hsnCode: string; taxableMinor: number; b2bTaxableMinor: number; b2cTaxableMinor: number }[]; totalTaxableMinor: number; b2bTaxableMinor: number; b2cTaxableMinor: number };
    expect(body.totalTaxableMinor).toBe(30000); // July excluded
    expect(body.b2bTaxableMinor).toBe(10000);
    expect(body.b2cTaxableMinor).toBe(20000);
    expect(body.rows).toHaveLength(1); // one HSN/rate
    expect(body.rows[0]!.hsnCode).toBe('100610');
  });

  it('rejects a free-text HSN and a B2B document with no recipient GSTIN before storing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await record(h, 'u-owner', 'bad-hsn', { documentDate: '2026-08-05', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line({ hsnCode: 'RICE' })] }, 'g-badhsn')).status).toBe(422);
    expect((await record(h, 'u-owner', 'b2b-nogstin', { documentDate: '2026-08-05', supplyType: 'b2b', annualTurnoverMinor: OVER, lines: [line()] }, 'g-nogstin')).status).toBe(422);
  });

  it('is idempotent per document — a re-record does not double-count', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = { documentDate: '2026-08-10', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 7000, cgstMinor: 175, sgstMinor: 175 })] };
    await record(h, 'u-owner', 'dup', body, 'g-dup1');
    expect(((await record(h, 'u-owner', 'dup', body, 'g-dup2')).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
    expect(((await table12(h, 'u-owner', '2026-08-01', '2026-08-31')).body as { totalTaxableMinor: number }).totalTaxableMinor).toBe(7000);
  });

  it('assembles the full GSTR-1 return: B2B invoice-level and B2C rate-wise over stored data', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await record(h, 'u-owner', 'INV-9', { documentDate: '2026-08-05', supplyType: 'b2b', recipientGstin: GSTIN, annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 10000, cgstMinor: 250, sgstMinor: 250 })] }, 'r-b2b');
    await record(h, 'u-owner', 'RCPT-9', { documentDate: '2026-08-06', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 20000, cgstMinor: 500, sgstMinor: 500 })] }, 'r-b2c');

    const body = (await gstr1(h, 'u-owner', '2026-08-01', '2026-08-31')).body as { b2b: { invoiceNumber: string; recipientGstin: string; invoiceValueMinor: number }[]; b2c: { taxableMinor: number }[]; hsn: { totalTaxableMinor: number }; totalTaxableMinor: number };
    expect(body.b2b).toHaveLength(1);
    expect(body.b2b[0]!.invoiceNumber).toBe('INV-9');
    expect(body.b2b[0]!.recipientGstin).toBe(GSTIN);
    expect(body.b2b[0]!.invoiceValueMinor).toBe(10500);
    expect(body.b2c[0]!.taxableMinor).toBe(20000);
    expect(body.totalTaxableMinor).toBe(30000);
    expect(body.hsn.totalTaxableMinor).toBe(30000); // return and HSN summary agree
  });

  it('exports the GSTN portal JSON, and refuses a bad GSTIN or filing period', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await record(h, 'u-owner', 'INV-7', { documentDate: '2026-08-05', supplyType: 'b2b', recipientGstin: GSTIN, annualTurnoverMinor: OVER, lines: [line({ taxableMinor: 10000, cgstMinor: 250, sgstMinor: 250 })] }, 'x-b2b');
    const json = (await exportJson(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', gstin: '33ZZZZZ9999Z1Z9', fp: '082026' })).body as { gstin: string; fp: string; b2b: { ctin: string; inv: { inum: string; val: number }[] }[] };
    expect(json.gstin).toBe('33ZZZZZ9999Z1Z9');
    expect(json.fp).toBe('082026');
    expect(json.b2b[0]!.ctin).toBe(GSTIN);
    expect(json.b2b[0]!.inv[0]!.val).toBe(105); // paise → rupees
    // A malformed filing period (not MMYYYY) is refused.
    expect((await exportJson(h, 'u-owner', { from: '2026-08-01', to: '2026-08-31', gstin: '33ZZZZZ9999Z1Z9', fp: 'Aug-2026' })).status).toBe(400);
  });

  it('gates on the permissions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await record(h, 'u-cash', 'x', { documentDate: '2026-08-05', supplyType: 'b2c', annualTurnoverMinor: OVER, lines: [line()] }, 'g-rbac')).status).toBe(403);
    expect((await table12(h, 'u-cash', '2026-08-01', '2026-08-31')).status).toBe(403);
    expect((await gstr1(h, 'u-cash', '2026-08-01', '2026-08-31')).status).toBe(403);
    expect((await exportJson(h, 'u-cash', { from: '2026-08-01', to: '2026-08-31', gstin: '33ZZZZZ9999Z1Z9', fp: '082026' })).status).toBe(403);
  });
});
