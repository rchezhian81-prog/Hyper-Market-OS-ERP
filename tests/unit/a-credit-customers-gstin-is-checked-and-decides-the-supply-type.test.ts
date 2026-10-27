import { describe, it, expect } from 'vitest';
import { readCustomerGstin, buyerOf, type CustomerGstinRecord } from '../../services/finance/src/b2b-customer-gstin';
import { b2bOutwardSupplyOf } from '../../services/api/src/adapters';
import type { StoredB2BDocument } from '../../services/finance/src/b2b-documents';
import { createB2BDeskSession, B2B_DESK_COPY } from '../../apps/web-erp/src/b2b-desk-session';

// OB-416 (owner, option A, 27 Oct 2026 · M22 · A5): the customer's GSTIN on a credit account — read with the store setup's own GSTIN
// validator (15 characters, the pattern, the check character) plus a GST State code; and the supply type a B2B tax invoice
// files under: B2B with the buyer's GSTIN when the invoice names one, B2C rate-wise when it does not. GSTINs are synthetic.

const TN = '33ZZZZZ9999Z1ZF';
const KL = '32ZZZZZ9999Z1ZH';

describe('reading a credit customer\'s GSTIN', () => {
  it('accepts a valid GSTIN — trimmed and upper-cased — and names its State', () => {
    expect(readCustomerGstin(TN)).toEqual({ ok: true, gstin: TN, stateCode: '33', stateName: 'Tamil Nadu' });
    expect(readCustomerGstin(` ${KL.toLowerCase()} `)).toEqual({ ok: true, gstin: KL, stateCode: '32', stateName: 'Kerala' });
  });
  it('refuses each fault by name: length, pattern, check character, State code', () => {
    expect(readCustomerGstin('33ZZZZZ9999Z1Z')).toEqual({ ok: false, code: 'customer_gstin_not_valid', why: 'it must be 15 characters, this is 14' });
    expect(readCustomerGstin('3XZZZZZ9999Z1ZF')).toMatchObject({ ok: false, code: 'customer_gstin_not_valid', why: expect.stringContaining('does not follow the GSTIN pattern') });
    expect(readCustomerGstin('33ZZZZZ9999Z1ZA')).toMatchObject({ ok: false, code: 'customer_gstin_not_valid', why: expect.stringContaining('check character does not match') });
    expect(readCustomerGstin('99ZZZZZ9999Z1ZX')).toEqual({ ok: false, code: 'customer_gstin_state_unknown', why: 'its first two digits (99) are not a GST State code' });
  });
  it('the buyer a new invoice names is the latest record, without its bookkeeping', () => {
    const rec: CustomerGstinRecord = { customerId: 'C', gstin: TN, legalName: 'Synthetic Trust', stateCode: '33', stateName: 'Tamil Nadu', reason: 'r', recordedBy: 'u', recordedAt: '2026-10-27T10:00:00.000Z', previousGstin: null };
    expect(buyerOf(rec)).toEqual({ gstin: TN, legalName: 'Synthetic Trust', stateCode: '33', stateName: 'Tamil Nadu' });
    expect(buyerOf(undefined)).toBeUndefined();
  });
});

describe('the supply type a B2B tax invoice files under', () => {
  const invoice: StoredB2BDocument = {
    documentId: 'inv1', number: 'INV-000001', kind: 'tax_invoice', customerId: 'C', tenantId: 't', issuedAt: '2026-10-27T05:00:00.000Z',
    lines: [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }],
    netMinor: 100_000, taxMinor: 5_000, grossMinor: 105_000, taxClaimable: true, detail: '',
    gst: { placeOfSupply: 'intra_state', supplierStateCode: '33', deliveryStateCode: '33', basis: 'store_state_assumed', cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0, lines: [{ lineId: 'l1', taxableMinor: 100_000, rateBps: 500, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 }] },
  };
  const table = [{ productId: 'p1', hsnCode: '1006', rateBps: 500 }];
  it('with the buyer\'s GSTIN on the invoice: B2B under that GSTIN, the same lines and tax', () => {
    const out = b2bOutwardSupplyOf({ ...invoice, buyer: { gstin: TN, legalName: 'Synthetic Trust', stateCode: '33', stateName: 'Tamil Nadu' } }, 'C', '2026-10-27', table);
    expect(out).toEqual({ doc: expect.objectContaining({ documentId: 'INV-000001', supplyType: 'b2b', recipientGstin: TN, lines: [expect.objectContaining({ hsnCode: '1006', taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500 })] }) });
  });
  it('with none: B2C, no recipient GSTIN — exactly as before OB-416', () => {
    const out = b2bOutwardSupplyOf(invoice, 'C', '2026-10-27', table);
    expect(out).toMatchObject({ doc: { supplyType: 'b2c' } });
    expect('doc' in out && 'recipientGstin' in out.doc).toBe(false);
  });
});

describe('the business desk records the GSTIN', () => {
  it('sends the GSTIN (spaces out, capitals), the name and the reason; refuses an empty or mis-sized one before any request', async () => {
    const asked: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (path: string, init?: { body?: string }) => { asked.push({ path: String(path), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> }); return new Response('{}', { status: 201 }); }) as unknown as typeof globalThis.fetch;
    const s = createB2BDeskSession({ viewer: { userId: 'u-acct', permissions: ['b2b.document.read', 'b2b.account.manage'] }, fetch });
    expect(s.may.manageAccount).toBe(true);
    expect(await s.recordGstin({ customerId: 'SCHOOL', gstin: '33ZZZZZ9999', legalName: 'X', reason: 'y' })).toEqual({ result: 'invalid', why: 'needGstin' });
    expect(await s.recordGstin({ customerId: 'SCHOOL', gstin: TN, legalName: ' ', reason: 'y' })).toEqual({ result: 'invalid', why: 'needGstin' });
    expect(await s.recordGstin({ customerId: '', gstin: TN, legalName: 'X', reason: 'y' })).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(asked).toEqual([]);
    await s.recordGstin({ customerId: ' SCHOOL ', gstin: '33zzzzz 9999z1zf', legalName: ' Synthetic Trust ', reason: ' certificate ' });
    expect(asked).toEqual([{ path: '/v1/b2b/accounts/SCHOOL/gstin', body: { gstin: TN, legalName: 'Synthetic Trust', reason: 'certificate' } }]);
    expect(createB2BDeskSession({ viewer: { userId: 'u-mgr', permissions: ['b2b.document.read'] }, fetch }).may.manageAccount).toBe(false);
  });
  it('every new word has a Tamil twin', () => {
    for (const k of ['gstinH', 'gstinFig', 'gstinNone', 'gstinL', 'gstinNameL', 'gstinReasonL', 'gstinSave', 'gstinNote', 'billTo', 'billToNone', 'needGstin'] as const) {
      expect(B2B_DESK_COPY.en[k]).toBeTruthy();
      expect(B2B_DESK_COPY.ta[k]).toBeTruthy();
      expect(B2B_DESK_COPY.ta[k]).not.toBe(B2B_DESK_COPY.en[k] === 'GSTIN' ? '' : B2B_DESK_COPY.en[k]);
    }
  });
});
