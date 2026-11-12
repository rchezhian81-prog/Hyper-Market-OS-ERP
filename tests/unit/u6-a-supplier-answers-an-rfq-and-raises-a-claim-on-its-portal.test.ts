import { describe, it, expect } from 'vitest';
import { readRfqQuote, readClaim, SUPPLIER_PORTAL_COPY, COPY_KEYS, type SupplierRfqsFeed, type SupplierOrdersFeed } from '../../apps/supplier-app/src/supplier-portal-session';
import { postRfqQuote, postClaim, fetchSupplierRfqs, fetchSupplierClaims } from '../../apps/supplier-app/src/browser-entry';

/**
 * **U6 (UI/UX gap audit §27 "Supplier portal — RFQ / claims" were PARTIAL): the supplier's own two forms, DOM-free.**
 *   • `readRfqQuote` refuses on the page before anything is sent: no grant, requests not read, a request not sent to this
 *     supplier, a half-filled line (named by product), a price of zero, days that are not whole, nothing quoted at all; a blank
 *     line is one not quoted; the body is exactly what head office's route takes, in the request's currency;
 *   • `readClaim` refuses the same way (no grant, an order that is not this supplier's, a zero amount, no reason, a reason too
 *     long) and sends the `claim` document head office reads back ({ poId?, claimMinor, why });
 *   • the two posts go to the existing routes with an idempotency key that is the ANSWER's digest (a retry never doubles);
 *   • the two reads tolerate a feed that cannot be read (null, never a false "none") and read a row back whole;
 *   • every new word has its Tamil twin.
 */
const rfqs: SupplierRfqsFeed = {
  rfqsKnown: true, mayRespond: true,
  rfqs: [{ rfqId: 'rfq-1', requisitionId: 'rq-1', dueOn: '2026-11-20', sentAt: '2026-11-07T04:00:00.000Z', currency: 'INR', lines: [{ productId: 'rice', quantity: 10_000, uom: 'kg' }, { productId: 'dal', quantity: 4 }], replied: false, awaitingBuyer: false, answered: false, decision: null }],
};
const orders: SupplierOrdersFeed = { ordersKnown: true, mayUpdate: true, orders: [{ poId: 'po-1', number: 'PO-000001', issuedAt: '2026-11-01T04:00:00.000Z', deliverToLocationId: 'br-1', lines: 1 }] };

describe('U6 · a supplier answers a request for quotation', () => {
  it('is refused on the page first, by name; a blank line is not quoted; the body is what head office takes', () => {
    const typed = { rice: { unitPrice: '42', leadTimeDays: '3' }, dal: { unitPrice: '', leadTimeDays: '' } };
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: typed }, rfqs, false)).toEqual({ ok: false, why: 'cannotQuote' });
    expect(readRfqQuote({ rfqId: ' ', lines: typed }, rfqs, true)).toEqual({ ok: false, why: 'needRfq' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: typed }, null, true)).toEqual({ ok: false, why: 'rfqsUnknownSend' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: typed }, { ...rfqs, rfqsKnown: false }, true)).toEqual({ ok: false, why: 'rfqsUnknownSend' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: typed }, { ...rfqs, mayRespond: false }, true)).toEqual({ ok: false, why: 'cannotQuote' });
    expect(readRfqQuote({ rfqId: 'rfq-9', lines: typed }, rfqs, true)).toEqual({ ok: false, why: 'notYourRfq' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '42', leadTimeDays: '' } } }, rfqs, true)).toEqual({ ok: false, why: 'badLead', productId: 'rice' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '42', leadTimeDays: '2.5' } } }, rfqs, true)).toEqual({ ok: false, why: 'badLead', productId: 'rice' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { dal: { unitPrice: '0', leadTimeDays: '2' } } }, rfqs, true)).toEqual({ ok: false, why: 'badQuotePrice', productId: 'dal' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { dal: { unitPrice: 'abc', leadTimeDays: '2' } } }, rfqs, true)).toEqual({ ok: false, why: 'badQuotePrice', productId: 'dal' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: {} }, rfqs, true)).toEqual({ ok: false, why: 'needQuoteLine' });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { ...typed, wheat: { unitPrice: '5', leadTimeDays: '1' } } }, rfqs, true)).toEqual({
      ok: true, rfqId: 'rfq-1', body: { lines: [{ productId: 'rice', unitCost: { minor: 4200, currency: 'INR' }, leadTimeDays: 3 }] }, // wheat was not asked for — ignored, never sent
    });
    expect(readRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '₹ 39.50', leadTimeDays: '0' }, dal: { unitPrice: '90', leadTimeDays: '7' } } }, rfqs, true)).toMatchObject({
      ok: true, body: { lines: [{ productId: 'rice', unitCost: { minor: 3950, currency: 'INR' }, leadTimeDays: 0 }, { productId: 'dal', unitCost: { minor: 9000, currency: 'INR' }, leadTimeDays: 7 }] },
    });
  });

  it('posts the quote to the request\'s own route, once per distinct answer; a refusal comes back in head office\'s words; no link is said', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const before = g.fetch;
    g.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (calls.length === 1) return new Response(JSON.stringify({ submissionId: 'rfq-rfq-1-sup-a-abc', kind: 'rfq_response' }), { status: 201 });
      return new Response(JSON.stringify({ error: { whatHappened: 'The quote names wheat, which this request did not ask for.' } }), { status: 400 });
    }) as typeof fetch;
    try {
      const sent = await postRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '42', leadTimeDays: '3' } } }, rfqs, true);
      expect(sent).toEqual({ result: 'sent', submissionId: 'rfq-rfq-1-sup-a-abc' });
      expect(calls[0]!.url).toBe('/v1/supplier-portal/me/rfqs/rfq-1/quote');
      expect(calls[0]!.init.method).toBe('POST');
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ lines: [{ productId: 'rice', unitCost: { minor: 4200, currency: 'INR' }, leadTimeDays: 3 }] });
      const key = (calls[0]!.init.headers as Record<string, string>)['idempotency-key'];
      expect(key).toMatch(/^rfq-quote-rfq-1-/);
      const again = await postRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '42.00', leadTimeDays: '3' } } }, rfqs, true);
      expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBe(key); // the same answer → the same key
      expect(again).toEqual({ result: 'refused', whatHappened: 'The quote names wheat, which this request did not ask for.' });
      expect(await postRfqQuote({ rfqId: 'rfq-1', lines: {} }, rfqs, true)).toEqual({ result: 'invalid', why: 'needQuoteLine' });
      expect(calls.length).toBe(2); // the refusal on the page sent nothing
      g.fetch = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
      expect(await postRfqQuote({ rfqId: 'rfq-1', lines: { rice: { unitPrice: '42', leadTimeDays: '3' } } }, rfqs, true)).toEqual({ result: 'lost_link' });
    } finally {
      g.fetch = before;
    }
  });

  it('reads the requests back whole, and says "could not read" (null) rather than a false none', async () => {
    const g = globalThis as { fetch?: typeof fetch };
    const before = g.fetch;
    try {
      g.fetch = (async () => new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 })) as typeof fetch;
      expect(await fetchSupplierRfqs()).toBeNull();
      expect(await fetchSupplierClaims()).toBeNull();
      g.fetch = (async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/rfqs')
        ? { partnerId: 'sup-a', rfqsKnown: true, mayRespond: true, rfqs: [{ ...rfqs.rfqs[0], note: 'per kg', replied: true, submissionId: 's-1', repliedAt: '2026-11-08T04:00:00.000Z', awaitingBuyer: false, answered: false, decision: 'rejected', reason: 'too dear' }] }
        : { partnerId: 'sup-a', claimsKnown: true, claims: [{ claimId: 'grn-1:p2', kind: 'debit_note', grnId: 'grn-1', poId: 'po-1', productId: 'p2', quantityMinor: 2, valueMinor: 20_000, reason: 'damaged', raisedAt: '2026-11-07T05:00:00.000Z', number: null, state: 'raised' }] }), { status: 200 })) as typeof fetch;
      const r = await fetchSupplierRfqs();
      expect(r).toEqual({ rfqsKnown: true, mayRespond: true, rfqs: [{ ...rfqs.rfqs[0], note: 'per kg', replied: true, submissionId: 's-1', repliedAt: '2026-11-08T04:00:00.000Z', awaitingBuyer: false, answered: false, decision: 'rejected', reason: 'too dear' }] });
      const c = await fetchSupplierClaims();
      expect(c).toEqual({ claimsKnown: true, claims: [{ claimId: 'grn-1:p2', kind: 'debit_note', grnId: 'grn-1', poId: 'po-1', productId: 'p2', quantityMinor: 2, valueMinor: 20_000, reason: 'damaged', raisedAt: '2026-11-07T05:00:00.000Z', number: null, state: 'raised' }] });
    } finally {
      g.fetch = before;
    }
  });
});

describe('U6 · a supplier raises a claim on the shop', () => {
  it('is refused on the page first; the document is what head office reads back; the post is the existing claim submission', async () => {
    expect(readClaim({ poId: 'po-1', amount: '1250', why: 'short paid' }, orders, false)).toEqual({ ok: false, why: 'cannotSubmit' });
    expect(readClaim({ poId: 'po-1', amount: '1250', why: 'short paid' }, null, true)).toEqual({ ok: false, why: 'ordersUnknownSend' });
    expect(readClaim({ poId: 'po-9', amount: '1250', why: 'short paid' }, orders, true)).toEqual({ ok: false, why: 'notYourOrder' });
    expect(readClaim({ poId: 'po-1', amount: '0', why: 'short paid' }, orders, true)).toEqual({ ok: false, why: 'badClaimAmount' });
    expect(readClaim({ poId: 'po-1', amount: 'twelve', why: 'short paid' }, orders, true)).toEqual({ ok: false, why: 'badClaimAmount' });
    expect(readClaim({ poId: 'po-1', amount: '1250', why: '  ' }, orders, true)).toEqual({ ok: false, why: 'needWhy' });
    expect(readClaim({ poId: 'po-1', amount: '1250', why: 'x'.repeat(301) }, orders, true)).toEqual({ ok: false, why: 'whyTooLong' });
    expect(readClaim({ poId: '', amount: '1250.50', why: ' price difference on rice ' }, null, true)).toEqual({ ok: true, document: { claimMinor: 125_050, why: 'price difference on rice' } }); // no order named: the orders need not be read
    expect(readClaim({ poId: 'po-1', amount: '1250', why: 'short paid' }, orders, true)).toEqual({ ok: true, document: { poId: 'po-1', claimMinor: 125_000, why: 'short paid' } });

    const calls: { url: string; init: RequestInit }[] = [];
    const g = globalThis as { fetch?: typeof fetch };
    const before = g.fetch;
    g.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return new Response(JSON.stringify({ submissionId: 'clm-k1', kind: 'claim', requiresReview: true }), { status: 201 }); }) as typeof fetch;
    try {
      expect(await postClaim({ poId: 'po-1', amount: '1250', why: 'short paid' }, orders, true, () => 'k1')).toEqual({ result: 'sent', submissionId: 'clm-k1' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('/v1/supplier-portal/me/submissions');
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ submissionId: 'clm-k1', kind: 'claim', document: { poId: 'po-1', claimMinor: 125_000, why: 'short paid' } });
      expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('clm-k1');
      expect(await postClaim({ poId: 'po-1', amount: '', why: 'short paid' }, orders, true, () => 'k2')).toEqual({ result: 'invalid', why: 'badClaimAmount' });
      expect(calls).toHaveLength(1);
    } finally {
      g.fetch = before;
    }
  });

  it('every new word has its Tamil twin, and no key is missing on either side', () => {
    const mine = COPY_KEYS.filter((k) => /^(rfq|quote|cannotQuote|rfqs|needRfq|notYourRfq|needQuoteLine|badQuotePrice|badLead|claim|raise|sendClaim|badClaimAmount|needWhy|whyTooLong)/.test(k));
    expect(mine.length).toBeGreaterThanOrEqual(48);
    for (const k of mine) {
      expect(SUPPLIER_PORTAL_COPY.ta[k], k).toBeTruthy();
      if (k !== 'rfqLineFacts') expect(SUPPLIER_PORTAL_COPY.ta[k], k).not.toBe(SUPPLIER_PORTAL_COPY.en[k]); // "{product} × {qty}" has no word to translate
    }
    expect(Object.keys(SUPPLIER_PORTAL_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_PORTAL_COPY.en).sort());
  });
});
