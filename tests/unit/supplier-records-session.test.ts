import { describe, it, expect } from 'vitest';
import {
  createSupplierRecordsSession, bankChangeBody, documentFrom, looksLikeAFullAccountNumber, supplierRecordsWords, SUPPLIER_RECORDS_COPY, type BankAsk,
} from '../../apps/web-erp/src/supplier-records-session';

/**
 * WF-02 supplier onboarding (M06-FR-01 · §28 · P-04): the Suppliers page's papers, bank-account change and hold, as a tested
 * DOM-free session. A paper is captured "not checked" or checked by the person at the screen; every paper already on file is
 * sent back as stored (nothing lost); a bank change is ASKED for with exactly the details the bank-details route will compare,
 * and RECORDED from the approved request itself (never retyped); a full account number is refused before anything is sent;
 * a hold needs a reason. The connected browser proof is tests/e2e/suppliers-on-the-production-api.e2e.ts.
 */

const RECORD = {
  supplierId: 'SUP-KAV', name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', phone: null, email: null, address: null, paymentTermsDays: 30, status: 'proposed',
  documents: [{ documentId: 'doc-old', kind: 'fssai_licence', reference: 'FS-1', validFrom: '2026-01-01', validUntil: '2027-01-01', verifiedBy: 'u-owner', verifiedAt: '2026-02-01T00:00:00.000Z' }],
};
function fakeFetch(answers: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    return { ok: true, status: 200, json: async () => answers[`${init.method} ${path}`] ?? {} };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const BUYER = { userId: 'u-mgr', permissions: ['supplier.view', 'purchase.supplier.manage', 'purchase.supplier.block'] };
const OWNER = { userId: 'u-owner', permissions: ['supplier.view', 'purchase.supplier.bank', 'purchase.supplier.block'] };
const BANK = { account: '••••4321', via: 'letter', arrivedOn: '2026-11-01', calledBack: '+91-90000-00001', heldNumber: '+91-90000-00001', why: 'supplier letter, rang back' };

describe('a supplier\'s papers, bank change and hold on the Suppliers page (WF-02 · M06-FR-01)', () => {
  it('reads a paper from the form, refusing a missing number or a "valid until" before "valid from"', () => {
    const form = { kind: 'gst_registration', reference: ' 33KAVER1234F1Z5 ', validFrom: '2026-01-01', validUntil: '2027-12-31', seenNow: false };
    expect(documentFrom(form, 'doc-1', 'u-mgr')).toEqual({ documentId: 'doc-1', kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' });
    expect(documentFrom({ ...form, seenNow: true }, 'doc-1', 'u-mgr')).toMatchObject({ verifiedBy: 'u-mgr' });
    for (const bad of [{ kind: 'passport' }, { reference: ' ' }, { validFrom: '01/01/2026' }, { validUntil: '2025-12-31' }, { validUntil: '2026-02-30x' }]) {
      expect(documentFrom({ ...form, ...bad }, 'doc-1', 'u-mgr')).toEqual({ why: 'needDoc' });
    }
  });

  it('adds a paper to the record as head office holds it NOW, sending every paper on file back as stored', async () => {
    const { fetch, sent } = fakeFetch({ 'GET /v1/purchase/suppliers/SUP-KAV': { supplier: RECORD, blocked: false, bank: null } });
    const s = createSupplierRecordsSession({ viewer: BUYER, fetch, newId: (p) => `${p}-9` });
    const out = await s.addDocument('SUP-KAV', { kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31', seenNow: false });
    expect(out.result).toBe('ok');
    expect(sent.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/purchase/suppliers/SUP-KAV', 'POST /v1/purchase/suppliers/SUP-KAV']);
    expect(sent[1]!.body).toEqual({
      name: 'Kaveri Foods', gstin: '33KAVER1234F1Z5', phone: null, email: null, address: null, paymentTermsDays: 30,
      documents: [
        { documentId: 'doc-old', kind: 'fssai_licence', reference: 'FS-1', validFrom: '2026-01-01', validUntil: '2027-01-01', verifiedBy: 'u-owner' },
        { documentId: 'doc-9', kind: 'gst_registration', reference: '33KAVER1234F1Z5', validFrom: '2026-01-01', validUntil: '2027-12-31' },
      ],
    });
  });

  it('marks an unchecked paper as checked by the person at the screen; an already-checked one is said, nothing sent', async () => {
    const withNew = { ...RECORD, documents: [...RECORD.documents, { documentId: 'doc-9', kind: 'gst_registration', reference: 'G', validFrom: '2026-01-01', validUntil: '2027-01-01' }] };
    const { fetch, sent } = fakeFetch({ 'GET /v1/purchase/suppliers/SUP-KAV': { supplier: withNew, blocked: false, bank: null } });
    const s = createSupplierRecordsSession({ viewer: BUYER, fetch });
    expect(await s.verifyDocument('SUP-KAV', 'doc-old')).toEqual({ result: 'invalid', why: 'alreadyChecked' });
    expect(sent.filter((x) => x.method === 'POST')).toEqual([]);
    await s.verifyDocument('SUP-KAV', 'doc-9');
    const docs = (sent.at(-1)!.body as { documents: { documentId: string; verifiedBy?: string }[] }).documents;
    expect(docs.map((d) => [d.documentId, d.verifiedBy])).toEqual([['doc-old', 'u-owner'], ['doc-9', 'u-mgr']]);
  });

  it('a supplier with no record has no papers to add to — said, nothing sent', async () => {
    const { fetch, sent } = fakeFetch({ 'GET /v1/purchase/suppliers/SUP-X': { supplier: null, blocked: false, bank: null } });
    const s = createSupplierRecordsSession({ viewer: BUYER, fetch });
    expect(await s.addDocument('SUP-X', { kind: 'gst_registration', reference: 'G', validFrom: '2026-01-01', validUntil: '2027-01-01', seenNow: true })).toEqual({ result: 'invalid', why: 'noRecord' });
    expect(sent.filter((x) => x.method === 'POST')).toEqual([]);
  });

  it('refuses a full account number, a call-back to a number we did not hold, and an incomplete change — before anything is sent', () => {
    expect(looksLikeAFullAccountNumber('50100123456789')).toBe(true);
    expect(looksLikeAFullAccountNumber('5010 0123 4567 89')).toBe(true);
    expect(looksLikeAFullAccountNumber('••••4321')).toBe(false);
    expect(looksLikeAFullAccountNumber('tok-kaveri-acct')).toBe(false);
    expect(bankChangeBody({ ...BANK, account: '50100123456789' })).toEqual({ why: 'fullNumber' });
    expect(bankChangeBody({ ...BANK, calledBack: '+91-99999-99999' })).toEqual({ why: 'notTheHeldNumber' });
    for (const bad of [{ account: '' }, { via: 'pigeon' }, { arrivedOn: 'yesterday' }, { heldNumber: '' }, { why: ' ' }]) expect(bankChangeBody({ ...BANK, ...bad })).toEqual({ why: 'needBank' });
  });

  it('asks for exactly what is recorded: the record takes the approved request\'s details and names the approval', async () => {
    const { fetch, sent } = fakeFetch({ 'POST /v1/approvals/requests': { requestId: 'areq-1' } });
    const s = createSupplierRecordsSession({ viewer: OWNER, fetch });
    expect(await s.askBankChange('SUP-KAV', BANK)).toEqual({ result: 'ok', value: { requestId: 'areq-1' } });
    const asked = sent[0]!.body as { kind: string; subjectRef: string; details: Record<string, unknown>; valueMinor: null; reason: string };
    expect(asked).toMatchObject({ kind: 'supplier_bank_change', subjectRef: 'SUP-KAV', valueMinor: null, reason: 'supplier letter, rang back' });
    const approved: BankAsk = { requestId: 'areq-1', subjectRef: 'SUP-KAV', status: 'approved', details: asked.details, decidedBy: 'u-acct' };
    await s.recordBankChange(approved);
    const recorded = sent[1]!;
    expect(recorded.path).toBe('/v1/purchase/suppliers/SUP-KAV/bank-details');
    expect(recorded.body).toEqual({ newAccount: '••••4321', requestedVia: 'letter', requestedAt: '2026-11-01', calledBackOn: '+91-90000-00001', numberWeAlreadyHeld: '+91-90000-00001', approvalId: 'areq-1' });
    // The bank-details route's own rule (services/purchase/src/index.ts): the approval's details are its body less the
    // approval, plus the supplier from the path.
    const { approvalId: _a, ...rest } = recorded.body as Record<string, unknown>;
    void _a;
    expect(asked.details).toEqual({ ...rest, supplierId: 'SUP-KAV' });
  });

  it('lists only this person\'s bank-change asks', async () => {
    const { fetch } = fakeFetch({ 'GET /v1/approvals/requests': { mine: [
      { requestId: 'a', kind: 'supplier_bank_change', subjectRef: 'SUP-KAV', status: 'waiting', details: {} },
      { requestId: 'b', kind: 'supplier_payment', subjectRef: 'advance:x', status: 'approved', details: {} },
    ] } });
    const s = createSupplierRecordsSession({ viewer: OWNER, fetch });
    const out = await s.myBankAsks();
    expect(out.result === 'ok' ? out.value.map((a) => a.requestId) : out).toEqual(['a']);
  });

  it('a hold and its removal each need a reason; each right is its own; nobody signed in can do nothing', async () => {
    const { fetch, sent } = fakeFetch();
    const s = createSupplierRecordsSession({ viewer: BUYER, fetch });
    expect(await s.setHold('SUP-KAV', true, ' ')).toEqual({ result: 'invalid', why: 'needWhy' });
    await s.setHold('SUP-KAV', true, 'short deliveries three weeks running');
    expect(sent).toEqual([{ method: 'POST', path: '/v1/purchase/suppliers/SUP-KAV/block-status', body: { blocked: true, reason: 'short deliveries three weeks running' } }]);
    // The buyer holds no bank right; the owner here holds no papers right.
    expect(await s.askBankChange('SUP-KAV', BANK)).toEqual({ result: 'invalid', why: 'cannotBank' });
    expect(await createSupplierRecordsSession({ viewer: OWNER, fetch }).addDocument('SUP-KAV', { kind: 'gst_registration', reference: 'G', validFrom: '2026-01-01', validUntil: '2027-01-01', seenNow: false })).toEqual({ result: 'invalid', why: 'cannotManage' });
    const nobody = createSupplierRecordsSession({ viewer: undefined, fetch });
    expect(nobody.may).toEqual({ named: false, read: false, manage: false, bank: false, hold: false });
    expect(await nobody.detail('SUP-KAV')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(sent).toHaveLength(1);
  });

  it('every word has a Tamil twin', () => {
    const en = Object.keys(SUPPLIER_RECORDS_COPY.en).sort();
    expect(Object.keys(SUPPLIER_RECORDS_COPY.ta).sort()).toEqual(en);
    for (const k of en) expect(supplierRecordsWords('ta', k)).not.toBe(supplierRecordsWords('en', k));
  });
});
