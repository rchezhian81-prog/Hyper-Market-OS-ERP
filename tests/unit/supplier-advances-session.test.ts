import { describe, it, expect } from 'vitest';
import { createSupplierAdvancesSession, advanceBody, advancesWords, advancesOutcomeWords, SUPPLIER_ADVANCES_COPY, type PaymentAsk } from '../../apps/web-erp/src/supplier-advances-session';
import { actionDetails } from '../../services/identity/src/approval-requests';

/**
 * Supplier advances on the Supplier bills page (D10-FR-01 · §28): the payment asked for carries exactly the details head
 * office fingerprints when it is recorded, the record takes those details FROM the approved request (never retyped), and a
 * use or an undo is one call each. The connected proof is tests/e2e/supplier-advances-are-paid-used-and-undone-on-the-supplier-bills-page.e2e.ts.
 */

const FORM = { supplierId: ' sup-1 ', amountRupees: '1,000', paidOn: '2026-11-01', method: 'bank_transfer', reference: ' NEFT-1 ', poId: '' };
function fakeFetch(answers: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    return { ok: true, status: 201, json: async () => answers[`${init.method} ${path}`] ?? {} };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const PAYER = { userId: 'u-pay', permissions: ['finance.period.read', 'purchase.supplier.pay', 'finance.journal.post'] };

describe('supplier advances (D10-FR-01)', () => {
  it('reads the payment form into the pay route\'s body, and refuses an incomplete one', () => {
    expect(advanceBody(FORM)).toEqual({ supplierId: 'sup-1', amountMinor: 100_000, paidOn: '2026-11-01', method: 'bank_transfer', reference: 'NEFT-1' });
    expect(advanceBody({ ...FORM, poId: ' po-a ' })).toMatchObject({ poId: 'po-a' });
    for (const bad of [{ amountRupees: '0' }, { amountRupees: 'ten' }, { method: 'barter' }, { reference: ' ' }, { paidOn: '1/11/2026' }, { supplierId: '' }]) expect(advanceBody({ ...FORM, ...bad })).toBeNull();
  });

  it('asks for exactly what is recorded: the record takes the approved request\'s details and names it', async () => {
    const { fetch, sent } = fakeFetch({ 'POST /v1/approvals/requests': { requestId: 'apr-1' } });
    const s = createSupplierAdvancesSession({ viewer: PAYER, fetch, newId: (p) => `${p}-9` });
    expect(await s.askToPay(FORM)).toEqual({ result: 'ok', value: { requestId: 'apr-1', advanceId: 'adv-9' } });
    const asked = sent[0]!.body as { kind: string; subjectRef: string; details: Record<string, unknown>; valueMinor: number };
    expect(asked).toMatchObject({ kind: 'supplier_payment', subjectRef: 'advance:adv-9', valueMinor: 100_000 });
    const approved: PaymentAsk = { requestId: 'apr-1', subjectRef: asked.subjectRef, status: 'approved', details: asked.details, valueMinor: 100_000 };
    await s.record(approved);
    const recorded = sent[1]!;
    expect(recorded.path).toBe('/v1/finance/supplier-advances/adv-9');
    expect(recorded.body).toEqual({ supplierId: 'sup-1', amountMinor: 100_000, paidOn: '2026-11-01', method: 'bank_transfer', reference: 'NEFT-1', approvalId: 'apr-1' });
    // The engine's own rule: what was asked for is the recorded body plus the path id.
    expect(asked.details).toEqual(actionDetails(recorded.body, { advanceId: 'adv-9' }));
  });

  it('a use and an undo are one call each, in paise, refused before any call when incomplete', async () => {
    const { fetch, sent } = fakeFetch();
    const s = createSupplierAdvancesSession({ viewer: PAYER, fetch, newId: (p) => `${p}-1` });
    expect(await s.use('adv-9', { invoiceId: '', amountRupees: '300', on: '2026-11-01' })).toEqual({ result: 'invalid', why: 'needUse' });
    expect(await s.undo('adv-9', { applicationId: 'use-1', amountMinor: 30_000 }, '')).toEqual({ result: 'invalid', why: 'needUndo' });
    await s.use('adv-9', { invoiceId: ' inv-a ', amountRupees: '300', on: '2026-11-01' });
    await s.undo('adv-9', { applicationId: 'use-1', amountMinor: 30_000 }, '2026-11-02');
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/finance/supplier-advances/adv-9/applications/use-1', body: { amountMinor: 30_000, invoiceId: 'inv-a', appliedOn: '2026-11-01' } },
      { method: 'POST', path: '/v1/finance/supplier-advances/adv-9/applications/undo-1', body: { reverses: 'use-1', amountMinor: 30_000, appliedOn: '2026-11-02' } },
    ]);
  });

  it('only the advance payments are listed as asks; each role is offered only its own acts; every word has a Tamil twin', async () => {
    const { fetch, sent } = fakeFetch({ 'GET /v1/approvals/requests': { mine: [
      { requestId: 'a', kind: 'supplier_payment', subjectRef: 'advance:adv-1', status: 'waiting', details: {}, valueMinor: 1 },
      { requestId: 'b', kind: 'supplier_payment', subjectRef: 'pay-77', status: 'approved', details: {}, valueMinor: 1 },
      { requestId: 'c', kind: 'rebate_claim', subjectRef: 'advance:x', status: 'approved', details: {}, valueMinor: 1 },
    ] } });
    const s = createSupplierAdvancesSession({ viewer: PAYER, fetch });
    const asks = await s.myAsks();
    expect(asks.result === 'ok' && asks.value.map((q) => q.requestId)).toEqual(['a']);
    const reader = createSupplierAdvancesSession({ viewer: { userId: 'u-r', permissions: ['finance.period.read'] }, fetch });
    expect(reader.may).toEqual({ named: true, read: true, pay: false, use: false });
    expect(await reader.askToPay(FORM)).toEqual({ result: 'invalid', why: 'cannotPay' });
    expect(await reader.use('adv-1', { invoiceId: 'i', amountRupees: '1', on: '2026-11-01' })).toEqual({ result: 'invalid', why: 'cannotUse' });
    expect(await createSupplierAdvancesSession({ viewer: { userId: 'u-c', permissions: [] }, fetch }).register()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(sent).toHaveLength(1);
    expect(advancesOutcomeWords('en', { result: 'ok', value: { alreadyRecorded: true } }, 'recordedNow')).toBe('Already recorded — nothing changed.');
    for (const k of Object.keys(SUPPLIER_ADVANCES_COPY.en)) expect(advancesWords('ta', k), k).not.toBe(advancesWords('en', k));
  });
});
