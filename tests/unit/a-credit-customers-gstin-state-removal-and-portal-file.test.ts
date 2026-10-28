import { describe, it, expect } from 'vitest';
import { deliveryStateFor, type StoredB2BDocument } from '../../services/finance/src/b2b-documents';
import { gstinInForce, type CustomerGstinFact, type CustomerGstinRecord } from '../../services/finance/src/b2b-customer-gstin';
import { b2bOutwardSupplyOf } from '../../services/api/src/adapters';
import { gstSplitOf } from '../../packages/b2b/src/documents';
import { gstr1Return, toGstnGstr1, Gstr1ExportRefused, type OutwardDocument, type OutwardSupplyLine } from '../../packages/finance/src/index';
import { createB2BDeskSession, deliveryStatePrefillOf, B2B_DESK_COPY } from '../../apps/web-erp/src/b2b-desk-session';

// OB-426 (option B) · OB-427 (option A) · OB-428 (option A) — owner, 27 Oct 2026, in writing. A credit customer's GSTIN
// pre-fills the tax invoice's delivery State (still changeable) and the CGST + SGST / IGST split follows the State used; a
// GSTIN can be removed with a reason (append-only), after which nothing is in force; and each B2B invoice in the GSTN
// GSTR-1 file carries its place of supply (`pos`), the reverse-charge flag (`rchrg`) and the invoice type. GSTINs are
// synthetic ("ZZZZZ9999Z" is no real PAN) with valid check characters.

const TN = '33ZZZZZ9999Z1ZF';
const KL = '32ZZZZZ9999Z1ZH';
const STORE = '33AABCS1429B1Z1';
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }];
const kerala = { gstin: KL, legalName: 'Synthetic Caterers', stateCode: '32', stateName: 'Kerala' };
const tamilNadu = { gstin: TN, legalName: 'Synthetic School Trust', stateCode: '33', stateName: 'Tamil Nadu' };

describe('OB-426 — the delivery State a tax invoice is judged on', () => {
  it('a State named by the person invoicing is used as named, whatever the GSTIN says', () => {
    expect(deliveryStateFor('33', kerala)).toEqual({ deliveryStateCode: '33' });
    expect(deliveryStateFor('32', undefined)).toEqual({ deliveryStateCode: '32' });
  });
  it('left blank, it is the State of the customer\'s GSTIN; with no GSTIN either, nothing is named (the store\'s State is assumed)', () => {
    expect(deliveryStateFor(undefined, kerala)).toEqual({ deliveryStateCode: '32', deliveryStateFrom: 'customer_gstin' });
    expect(deliveryStateFor(undefined, undefined)).toEqual({});
  });
  it('the split follows the State finally used: Kerala GSTIN → IGST; the same customer delivered in Tamil Nadu → CGST + SGST', () => {
    const fromGstin = gstSplitOf(LINES, { supplierStateCode: '33', ...deliveryStateFor(undefined, kerala) });
    expect(fromGstin).toMatchObject({ placeOfSupply: 'inter_state', deliveryStateCode: '32', basis: 'customer_gstin_state', igstMinor: 5_000, cgstMinor: 0, sgstMinor: 0 });
    const changed = gstSplitOf(LINES, { supplierStateCode: '33', ...deliveryStateFor('33', kerala) });
    expect(changed).toMatchObject({ placeOfSupply: 'intra_state', deliveryStateCode: '33', basis: 'delivery_state', igstMinor: 0, cgstMinor: 2_500, sgstMinor: 2_500 });
    const local = gstSplitOf(LINES, { supplierStateCode: '33', ...deliveryStateFor(undefined, tamilNadu) });
    expect(local).toMatchObject({ placeOfSupply: 'intra_state', deliveryStateCode: '33', basis: 'customer_gstin_state', cgstMinor: 2_500, sgstMinor: 2_500 });
    expect(gstSplitOf(LINES, { supplierStateCode: '33', ...deliveryStateFor(undefined, undefined) })).toMatchObject({ basis: 'store_state_assumed', deliveryStateCode: '33' });
  });
});

describe('OB-427 — the GSTIN in force after a removal', () => {
  const rec = (gstin: string): CustomerGstinRecord => ({ customerId: 'C', gstin, legalName: 'Synthetic Trust', stateCode: gstin.slice(0, 2), stateName: 'x', reason: 'r', recordedBy: 'u', recordedAt: '2026-10-27T10:00:00.000Z', previousGstin: null });
  const removal: CustomerGstinFact = { customerId: 'C', removed: true, removedGstin: TN, legalName: 'Synthetic Trust', stateCode: '33', reason: 'registration cancelled', removedBy: 'u', removedAt: '2026-10-27T11:00:00.000Z' };
  it('none, a recording, a removal after it, and a recording after that', () => {
    expect(gstinInForce([])).toBeUndefined();
    expect(gstinInForce([rec(TN)])?.gstin).toBe(TN);
    expect(gstinInForce([rec(TN), removal])).toBeUndefined();
    expect(gstinInForce([rec(TN), removal, rec(KL)])?.gstin).toBe(KL);
  });
});

describe('OB-428 — the place of supply on the GSTN file', () => {
  const invoice = (gst: NonNullable<StoredB2BDocument['gst']>): StoredB2BDocument => ({
    documentId: 'inv1', number: 'INV-000001', kind: 'tax_invoice', customerId: 'C', tenantId: 't', issuedAt: '2026-10-27T05:00:00.000Z',
    lines: LINES, netMinor: 100_000, taxMinor: 5_000, grossMinor: 105_000, taxClaimable: true, detail: '', gst, buyer: kerala,
  });
  it('a B2B tax invoice files under the delivery State it records — the single source', () => {
    const inter = gstSplitOf(LINES, { supplierStateCode: '33', deliveryStateCode: '32' });
    const out = b2bOutwardSupplyOf(invoice(inter), 'C', '2026-10-27', [{ productId: 'p1', hsnCode: '1006', rateBps: 500 }]);
    expect(out).toMatchObject({ doc: { supplyType: 'b2b', recipientGstin: KL, placeOfSupplyStateCode: '32' } });
  });

  const line = (o: Partial<OutwardSupplyLine> = {}): OutwardSupplyLine => ({ hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10_000, rateBps: 500, cgstMinor: 250, sgstMinor: 250, igstMinor: 0, ...o });
  const igst = line({ cgstMinor: 0, sgstMinor: 0, igstMinor: 500 });
  const doc = (documentId: string, o: Partial<OutwardDocument>): OutwardDocument => ({ documentId, documentDate: '2026-10-05', supplyType: 'b2b', recipientGstin: KL, lines: [line()], ...o });

  it('each B2B invoice carries pos (2-digit State), rchrg "N" and inv_typ "R" at the invoice level', () => {
    const file = toGstnGstr1(gstr1Return([
      doc('INV-1', { placeOfSupplyStateCode: '32', lines: [igst] }),
      doc('INV-2', { placeOfSupplyStateCode: '33' }),
    ]), { gstin: STORE, fp: '102026' });
    expect(file.b2b).toEqual([{ ctin: KL, inv: [
      { inum: 'INV-1', idt: '05-10-2026', val: 105, pos: '32', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 5, txval: 100, camt: 0, samt: 0, iamt: 5 } }] },
      { inum: 'INV-2', idt: '05-10-2026', val: 105, pos: '33', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 5, txval: 100, camt: 2.5, samt: 2.5, iamt: 0 } }] },
    ] }]);
  });
  it('an invoice recorded without a State that charged only CGST + SGST is inside the filer\'s own State', () => {
    const file = toGstnGstr1(gstr1Return([doc('INV-3', {})]), { gstin: STORE, fp: '102026' });
    expect(file.b2b[0]!.inv[0]).toMatchObject({ pos: '33', rchrg: 'N' });
  });
  it('IGST with no State recorded, or a State that disagrees with the split, is refused naming each invoice — never guessed', () => {
    const run = (docs: OutwardDocument[]) => { try { toGstnGstr1(gstr1Return(docs), { gstin: STORE, fp: '102026' }); return undefined; } catch (e) { return e; } };
    const missing = run([doc('INV-4', { lines: [igst] })]);
    expect(missing).toBeInstanceOf(Gstr1ExportRefused);
    expect((missing as Gstr1ExportRefused).problems).toEqual([{ invoiceNumber: 'INV-4', recipientGstin: KL, why: 'it charged IGST (a supply to another State) but no place of supply is recorded on it' }]);
    const igstHome = run([doc('INV-5', { placeOfSupplyStateCode: '33', lines: [igst] })]);
    expect((igstHome as Gstr1ExportRefused).problems[0]!.why).toMatch(/charged IGST but its place of supply \(33\) is the filer's own State/);
    const localAway = run([doc('INV-6', { placeOfSupplyStateCode: '32' })]);
    expect((localAway as Gstr1ExportRefused).problems[0]!.why).toMatch(/charged CGST \+ SGST but its place of supply \(32\) is not the filer's own State \(33\)/);
  });
  it('the B2C summary is untouched (rate-wise, as before)', () => {
    const file = toGstnGstr1(gstr1Return([doc('B-1', { supplyType: 'b2c', recipientGstin: undefined })]), { gstin: STORE, fp: '102026' });
    expect(file.b2b).toEqual([]);
    expect(file.b2cs).toEqual([{ sply_ty: 'INTRA', typ: 'OE', rt: 5, txval: 100, camt: 2.5, samt: 2.5, iamt: 0 }]);
  });
});

describe('the business desk — the pre-filled State and removing a GSTIN', () => {
  it('the delivery State starts as the GSTIN\'s State when one is on record; blank when none', () => {
    expect(deliveryStatePrefillOf({ gstin: { ...kerala } })).toEqual({ stateCode: '32', stateName: 'Kerala' });
    expect(deliveryStatePrefillOf({ gstin: null })).toBeNull();
    expect(deliveryStatePrefillOf(null)).toBeNull();
  });
  it('removing sends the reason; with no reason or customer it asks before any request', async () => {
    const asked: { path: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (path: string, init?: { body?: string }) => { asked.push({ path: String(path), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> }); return new Response('{}', { status: 201 }); }) as unknown as typeof globalThis.fetch;
    const s = createB2BDeskSession({ viewer: { userId: 'u-acct', permissions: ['b2b.document.read', 'b2b.account.manage'] }, fetch });
    expect(await s.removeGstin({ customerId: 'SCHOOL', reason: '  ' })).toEqual({ result: 'invalid', why: 'needRemoveReason' });
    expect(await s.removeGstin({ customerId: ' ', reason: 'cancelled' })).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(await createB2BDeskSession({ viewer: undefined, fetch }).removeGstin({ customerId: 'SCHOOL', reason: 'x' })).toEqual({ result: 'invalid', why: 'nobody' });
    expect(asked).toEqual([]);
    await s.removeGstin({ customerId: ' SCHOOL ', reason: ' registration cancelled ' });
    expect(asked).toEqual([{ path: '/v1/b2b/accounts/SCHOOL/gstin/removal', body: { reason: 'registration cancelled' } }]);
  });
  it('every new word has a Tamil twin', () => {
    for (const k of ['deliveryState', 'deliveryFromGstin', 'deliveryBlank', 'removeGstin', 'removeGstinNote', 'needRemoveReason'] as const) {
      expect(B2B_DESK_COPY.en[k]).toBeTruthy();
      expect(B2B_DESK_COPY.ta[k]).toBeTruthy();
      expect(B2B_DESK_COPY.ta[k]).not.toBe(B2B_DESK_COPY.en[k]);
    }
  });
});
