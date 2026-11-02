import { describe, it, expect } from 'vitest';
import {
  createB2BOrderingSession, quoteLinesOf, transferNoteBody, paiseOfRupees, b2bOrderingWords, B2B_ORDERING_COPY,
} from '../../apps/b2b-app/src/b2b-portal-ordering-session';
import { createTransferNotesSession, matchBody, transferNotesWords, B2B_TRANSFER_NOTES_COPY } from '../../apps/web-erp/src/b2b-transfer-notes-session';

/**
 * M22-FR-04 (W3) — the B2B portal's WRITE path and finance's matching of a payment notice, as tested DOM-free sessions:
 *   • the customer asks for a quote (items and quantities only — no price is ever sent), places an order from ITS OWN
 *     quotation (only the quotation id is sent — no customer id, no price), and tells the shop it sent a transfer (amount,
 *     day, bank reference — no card or account detail, hard rule #3); each id is its own idempotency key;
 *   • finance matches a note to the line on the shop's own bank statement, or rejects it with a reason; incomplete forms
 *     are refused before anything is sent.
 * The connected browser proof is tests/e2e/w3-a-business-customer-asks-orders-and-pays-and-finance-matches-it.e2e.ts.
 */

function fakeFetch(answers: Record<string, unknown> = {}) {
  const sent: { method: string; path: string; key?: string; body?: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    sent.push({ method: init.method, path, ...(init.headers['idempotency-key'] === undefined ? {} : { key: init.headers['idempotency-key'] }), ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
    return { ok: true, status: 201, json: async () => answers[`${init.method} ${path}`] ?? {} };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const CUSTOMER = { userId: 'u-caterer', permissions: ['b2b.portal.self'] };

describe('the business customer asks, orders and tells the shop it paid (M22-FR-04)', () => {
  it('reads the forms: whole quantities, rupees in paise, a bank reference — and nothing else', () => {
    expect(quoteLinesOf([{ productId: ' p1 ', qty: '5' }, { productId: '', qty: '' }])).toEqual([{ productId: 'p1', qty: 5 }]);
    for (const bad of [[{ productId: 'p1', qty: '2.5' }], [{ productId: '', qty: '3' }], [{ productId: 'p1', qty: '0' }], []]) expect(quoteLinesOf(bad)).toBeNull();
    expect(paiseOfRupees('1,000.50')).toBe(100_050);
    expect(paiseOfRupees('0')).toBeNull();
    expect(transferNoteBody({ amountRupees: '1,000', sentOn: '2026-11-01', bankReference: ' UTR123456 ', against: 'INV-1, INV-2' })).toEqual({ amountMinor: 100_000, transferredOn: '2026-11-01', bankReference: 'UTR123456', against: ['INV-1', 'INV-2'] });
    for (const bad of [{ amountRupees: 'ten' }, { sentOn: '1/11/2026' }, { bankReference: 'abc' }, { bankReference: 'UTR 123456' }]) {
      expect(transferNoteBody({ amountRupees: '1000', sentOn: '2026-11-01', bankReference: 'UTR123456', against: '', ...bad })).toBeNull();
    }
  });

  it('each write sends only what the route reads, under its own id as the idempotency key; no customer id, no price', async () => {
    const { fetch, sent } = fakeFetch();
    const s = createB2BOrderingSession({ viewer: CUSTOMER, fetch, newId: (p) => `${p}-1` });
    await s.askForQuote([{ productId: 'p1', qty: '5' }], ' for the hostel ');
    await s.placeOrder('q-c1');
    await s.tellPaid({ amountRupees: '1000', sentOn: '2026-11-01', bankReference: 'UTR123456', against: '' });
    expect(sent).toEqual([
      { method: 'POST', path: '/v1/b2b-portal/me/quote-requests/QR-1', key: 'QR-1', body: { lines: [{ productId: 'p1', qty: 5 }], note: 'for the hostel' } },
      { method: 'POST', path: '/v1/b2b-portal/me/orders/SO-1', key: 'SO-1', body: { fromQuotationId: 'q-c1' } },
      { method: 'POST', path: '/v1/b2b-portal/me/transfer-notes/TN-1', key: 'TN-1', body: { amountMinor: 100_000, transferredOn: '2026-11-01', bankReference: 'UTR123456' } },
    ]);
  });

  it('offers only quotations no order was made from; refuses incomplete forms and a login that is not a business customer', async () => {
    const { fetch, sent } = fakeFetch({ 'GET /v1/b2b-portal/me/documents': { documents: [
      { documentId: 'q-1', kind: 'quotation', number: 'QT-1', grossMinor: 10_500 },
      { documentId: 'q-2', kind: 'quotation', number: 'QT-2', grossMinor: 20_000, validUntil: '2026-11-30' },
      { documentId: 'so-1', kind: 'sales_order', number: 'SO-1', grossMinor: 10_500, derivedFrom: 'q-1' },
    ] } });
    const s = createB2BOrderingSession({ viewer: CUSTOMER, fetch });
    const open = await s.openQuotations();
    expect(open).toEqual({ result: 'ok', value: [{ documentId: 'q-2', number: 'QT-2', grossMinor: 20_000, validUntil: '2026-11-30' }] });
    expect(await s.placeOrder(' ')).toEqual({ result: 'invalid', why: 'needQuotation' });
    expect(await s.askForQuote([{ productId: 'p1', qty: 'lots' }], '')).toEqual({ result: 'invalid', why: 'needLines' });
    expect(await s.tellPaid({ amountRupees: '', sentOn: '', bankReference: '', against: '' })).toEqual({ result: 'invalid', why: 'needPayment' });
    const staff = createB2BOrderingSession({ viewer: { userId: 'u-mgr', permissions: ['b2b.document.read'] }, fetch });
    expect(await staff.placeOrder('q-2')).toEqual({ result: 'invalid', why: 'cannotOrder' });
    expect(await staff.tellPaid({ amountRupees: '1', sentOn: '2026-11-01', bankReference: 'UTR123456', against: '' })).toEqual({ result: 'invalid', why: 'cannotPay' });
    expect(sent.filter((x) => x.method === 'POST')).toEqual([]);
  });
});

describe('finance matches a payment note to its own bank statement, or rejects it (M22-FR-04 · OB-41)', () => {
  const FINANCE = { userId: 'u-acct', permissions: ['b2b.receivable.record'] };
  it('sends what the statement shows, exactly; a reject needs a reason; nothing without the right', async () => {
    expect(matchBody({ receivedRupees: '1,000', receivedOn: '2026-11-02', bankReference: ' UTR123456 ' })).toEqual({ receivedMinor: 100_000, receivedOn: '2026-11-02', bankReference: 'UTR123456' });
    expect(matchBody({ receivedRupees: '1000', receivedOn: 'today', bankReference: 'UTR123456' })).toBeNull();
    const { fetch, sent } = fakeFetch();
    const s = createTransferNotesSession({ viewer: FINANCE, fetch });
    expect(await s.match('TN-1', { receivedRupees: '', receivedOn: '2026-11-02', bankReference: 'UTR123456' })).toEqual({ result: 'invalid', why: 'needMatch' });
    expect(await s.reject('TN-1', ' ')).toEqual({ result: 'invalid', why: 'needWhy' });
    await s.queue();
    await s.match('TN-1', { receivedRupees: '1000', receivedOn: '2026-11-02', bankReference: 'UTR123456' });
    await s.reject('TN-2', 'no such credit on the statement');
    expect(sent.map((x) => [x.method, x.path, x.body])).toEqual([
      ['GET', '/v1/b2b/transfer-notes', undefined],
      ['POST', '/v1/b2b/transfer-notes/TN-1/match', { receivedMinor: 100_000, receivedOn: '2026-11-02', bankReference: 'UTR123456' }],
      ['POST', '/v1/b2b/transfer-notes/TN-2/reject', { reason: 'no such credit on the statement' }],
    ]);
    expect(await createTransferNotesSession({ viewer: { userId: 'u-mgr', permissions: [] }, fetch }).queue()).toEqual({ result: 'invalid', why: 'cannotRead' });
  });

  it('every word on both screens has a Tamil twin', () => {
    for (const [copy, words] of [[B2B_ORDERING_COPY, b2bOrderingWords], [B2B_TRANSFER_NOTES_COPY, transferNotesWords]] as const) {
      const en = Object.keys(copy.en).sort();
      expect(Object.keys(copy.ta).sort()).toEqual(en);
      for (const k of en) expect(words('ta', k)).not.toBe(words('en', k));
    }
  });
});
