// Fix batch 5 (OB-800 THE PLAN) · daily-work defects D-048, D-049, D-050, D-051 — the accountant's pages.
//   D-048: a payment that head office would refuse to record (supplier on hold, no checked bank account for a bank / cheque /
//          UPI payment, a shared account) is refused when it is ASKED for — before anyone approves it — with no requirement
//          codes in the words staff read.
//   D-049: the approver reads the supplier's name, "Bank transfer", and each bill the payment pays with its match result.
//   D-050: the Day book shows what the tills sent for the day (sales, takings, refunds) before posting, and says plainly
//          when the account names are not set up.
//   D-051: the GST page shows one job at a time (monthly GST / yearly returns / TDS) and every month is a month picker.
import { describe, it, expect } from 'vitest';
import {
  createSupplierPaymentSession, payBlockOf, supplierPayStateOf, paymentSummary, supplierPaymentOutcomeWords, SUPPLIER_PAYMENT_COPY,
} from '../../apps/web-erp/src/supplier-payment-session';
import { paymentFactsOf, paymentFactLines, createPaymentFactsReader, PAYMENT_FACTS_WORDS } from '../../apps/web-erp/src/payment-approval-facts';
import { presentRequest, APPROVALS_COPY, type ApprovalRequestView } from '../../apps/web-erp/src/approvals-session';
import { tillsSentOn } from '../../services/finance/src/day-book';
import { createDayBookSession, presentTillsSent, tenderWords, DAY_BOOK_COPY, type DayBookReadData } from '../../apps/web-erp/src/day-book-session';
import { GST_JOBS, GST_JOB_PARTS, GST_JOB_WORDS, partsHiddenFor, gstJobOf, mmyyyyOf, monthInputOf } from '../../apps/web-erp/src/gst-jobs';

interface Call { readonly method: string; readonly url: string; readonly body?: unknown }
/** A stand-in head office: the supplier read answers `supplier`; the approvals POST answers a request id. */
function headOffice(supplier: unknown, supplierStatus = 200) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    if (method === 'GET') return new Response(JSON.stringify(supplierStatus === 200 ? supplier : { error: { code: 'x', whatHappened: 'no' } }), { status: supplierStatus });
    return new Response(JSON.stringify({ requestId: 'rq-1' }), { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const PAYER = { userId: 'u-acct', permissions: ['purchase.supplier.pay'] };
const FORM = { supplierId: 'sup-1', amountRupees: '500', paidOn: '2026-11-12', method: 'bank_transfer', reference: 'NEFT-1', settles: 'inv-a' };
const GOOD = { supplier: { name: 'Sakthi Traders' }, blocked: false, bank: { accountRef: 'xx-1234' }, duplicateBankAccount: false };

describe('D-048 · a payment head office could never record is refused when it is asked for', () => {
  it('reads the supplier first; held, no checked account, or a shared account → no approval is asked, in plain words', async () => {
    for (const [state, why] of [
      [{ ...GOOD, blocked: true }, 'supplierHeld'],
      [{ ...GOOD, bank: null }, 'noVerifiedBank'],
      [{ ...GOOD, duplicateBankAccount: true }, 'sharedBank'],
    ] as const) {
      const ho = headOffice(state);
      const s = createSupplierPaymentSession({ viewer: PAYER, fetch: ho.fetch, newId: () => 'pay-1' });
      const out = await s.ask(FORM);
      expect(out).toEqual({ result: 'invalid', why });
      expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/purchase/suppliers/sup-1']); // nothing asked
      const words = supplierPaymentOutcomeWords('en', out);
      expect(words).toMatch(/Nothing was asked\.$/);
      expect(words).not.toMatch(/M\d{2}-FR|§\d|OB-\d/);
      expect(supplierPaymentOutcomeWords('ta', out)).toMatch(/எதுவும் கேட்கப்படவில்லை\.$/);
    }
  });

  it('the same rules as the record route: cash needs no bank account; a payable supplier is asked for, named and in words', async () => {
    expect(payBlockOf({ name: null, blocked: false, bankVerified: false, sharedBank: false }, 'cash')).toBeNull();
    expect(payBlockOf({ name: null, blocked: false, bankVerified: false, sharedBank: false }, 'cheque')).toBe('noVerifiedBank');
    expect(payBlockOf({ name: null, blocked: false, bankVerified: false, sharedBank: false }, 'upi')).toBe('noVerifiedBank');
    expect(payBlockOf({ name: null, blocked: true, bankVerified: true, sharedBank: false }, 'cash')).toBe('supplierHeld');
    const ho = headOffice(GOOD);
    const s = createSupplierPaymentSession({ viewer: PAYER, fetch: ho.fetch, newId: () => 'pay-1' });
    expect(await s.ask(FORM)).toEqual({ result: 'ok', value: { requestId: 'rq-1', paymentId: 'pay-1' } });
    const asked = ho.calls[1]!.body as { summary: string; details: Record<string, unknown> };
    expect(asked.summary).toBe('Payment to Sakthi Traders (sup-1): ₹500.00 by Bank transfer on 2026-11-12, ref NEFT-1, settles bill(s) inv-a');
    // The details stay exactly the record route's body (the engine's fingerprint) — the name is only in the words.
    expect(asked.details).toEqual({ amountMinor: 50_000, paidOn: '2026-11-12', method: 'bank_transfer', reference: 'NEFT-1', settles: ['inv-a'], supplierId: 'sup-1', paymentId: 'pay-1' });
  });

  it('a supplier this person cannot read goes on to be asked (head office still refuses on record); no link asks nothing', async () => {
    const hidden = headOffice({}, 403);
    expect((await createSupplierPaymentSession({ viewer: PAYER, fetch: hidden.fetch, newId: () => 'pay-1' }).ask(FORM)).result).toBe('ok');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    expect(await createSupplierPaymentSession({ viewer: PAYER, fetch: down }).ask(FORM)).toEqual({ result: 'lost_link' });
  });

  it('reads the supplier answer and words a summary without a name; every new word has a Tamil twin', () => {
    expect(supplierPayStateOf({ supplier: null, blocked: false, bank: null })).toEqual({ name: null, blocked: false, bankVerified: false, sharedBank: false });
    expect(paymentSummary({ supplierId: 'sup-9', supplierName: null, body: { amountMinor: 100, paidOn: '2026-11-01', method: 'cash', reference: 'R1' } }))
      .toBe('Payment to sup-9: ₹1.00 by Cash on 2026-11-01, ref R1');
    expect(Object.keys(SUPPLIER_PAYMENT_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_PAYMENT_COPY.en).sort());
  });
});

describe('D-049 · the approver reads the supplier by name, "Bank transfer", and each bill with its match result', () => {
  const ACCOUNT = { ...GOOD, account: { invoices: [
    { invoiceId: 'inv-a', matched: true, blocked: false, payableMinor: 50_000, withheldMinor: 0 },
    { invoiceId: 'inv-b', matched: true, blocked: true, payableMinor: 0, withheldMinor: 12_000 },
    { invoiceId: 'inv-c', matched: false, blocked: false, payableMinor: 0, withheldMinor: 30_000 },
  ] } };

  it('names each bill: matched (and what may be paid), held back, not matched yet, or not this supplier\'s', () => {
    const facts = paymentFactsOf(ACCOUNT, ['inv-a', 'inv-b', 'inv-c', 'inv-z']);
    expect(facts.supplierName).toBe('Sakthi Traders');
    expect(facts.bills.map((b) => b.match)).toEqual(['matched', 'held_back', 'not_matched', 'not_theirs']);
    const lines = paymentFactLines('en', facts, 'sup-1', 'bank_transfer');
    expect(lines.map((l) => l.text)).toEqual([
      'Supplier: Sakthi Traders (sup-1)',
      'inv-a — matched; ₹500.00 may be paid',
      'inv-b — matched, but ₹120.00 is held back',
      'inv-c — not matched yet; nothing may be paid on it',
      'inv-z — not a bill of this supplier',
    ]);
    expect(lines.filter((l) => l.warn).length).toBe(3);
    expect(paymentFactLines('ta', facts, 'sup-1', 'bank_transfer')[1]!.text).toBe('inv-a — பொருத்தப்பட்டது; ₹500.00 செலுத்தலாம்');
  });

  it('warns of a supplier on hold or without a checked account; a payment naming no bill says so', () => {
    expect(paymentFactLines('en', paymentFactsOf({ ...ACCOUNT, bank: null }, []), 'sup-1', 'bank_transfer').map((l) => l.text))
      .toEqual(['Supplier: Sakthi Traders (sup-1)', PAYMENT_FACTS_WORDS.en.bankNotChecked, `Bills it pays: ${PAYMENT_FACTS_WORDS.en.noBills}`]);
    expect(paymentFactLines('en', paymentFactsOf({ ...ACCOUNT, bank: null }, []), 'sup-1', 'cash').some((l) => l.warn)).toBe(false);
    expect(paymentFactLines('en', paymentFactsOf({ ...ACCOUNT, blocked: true }, []), 'sup-1', 'cash')[1]!.text).toBe(PAYMENT_FACTS_WORDS.en.onHold);
    expect(Object.keys(PAYMENT_FACTS_WORDS.ta).sort()).toEqual(Object.keys(PAYMENT_FACTS_WORDS.en).sort());
  });

  it('reads head office\'s account of the supplier once, as the person signed in — a GET only', async () => {
    const ho = headOffice(ACCOUNT);
    const out = await createPaymentFactsReader({ fetch: ho.fetch }).read(' sup-1 ', ['inv-a']);
    expect(out.result === 'ok' ? out.value.bills[0]!.match : null).toBe('matched');
    expect(ho.calls).toEqual([{ method: 'GET', url: '/v1/purchase/suppliers/sup-1' }]);
  });

  it('the Approvals page says "Bank transfer", never bank_transfer, and carries the payment\'s supplier and bills', () => {
    const r: ApprovalRequestView = {
      requestId: 'rq-1', kind: 'supplier_payment', subjectRef: 'sup-1/pay-1', label: '', summary: 'Payment to Sakthi Traders (sup-1)', requestedBy: 'u-acct',
      reason: 'r', requestedAt: '2026-11-12T05:00:00Z', valueMinor: 50_000, status: 'waiting',
      details: { amountMinor: 50_000, paidOn: '2026-11-12', method: 'bank_transfer', reference: 'NEFT-1', settles: ['inv-a'], supplierId: 'sup-1', paymentId: 'pay-1' },
    } as unknown as ApprovalRequestView;
    const shown = presentRequest('en', r, true);
    expect(shown.details.find((d) => d.key === 'method')?.value).toBe('Bank transfer');
    expect(presentRequest('ta', r, true).details.find((d) => d.key === 'method')?.value).toBe('வங்கிப் பரிமாற்றம்');
    expect(shown.payment).toEqual({ supplierId: 'sup-1', settles: ['inv-a'], method: 'bank_transfer' });
    expect(presentRequest('en', { ...r, kind: 'stock_write_off' } as ApprovalRequestView).payment).toBeUndefined();
    expect(Object.keys(APPROVALS_COPY.ta).sort()).toEqual(Object.keys(APPROVALS_COPY.en).sort());
  });
});

describe('D-050 · the Day book shows what the tills sent before posting, and says when account names are missing', () => {
  const sale = (saleId: string, totalMinor: number, tenders: [string, number][]) => ({ saleId, tradingDay: '2026-11-15', totalMinor, lines: [], tenders: tenders.map(([kind, amountMinor]) => ({ kind, amountMinor })) });
  const ret = (returnId: string, refundMinor: number, refundTender: string) => ({ returnId, originalSaleId: null, refundMinor, refundTender, lines: [] });

  it('head office totals the day\'s sales, takings by tender and refunds by tender, and counts what no journal covers', () => {
    const sent = tillsSentOn([sale('s1', 10_000, [['cash', 10_000]]), sale('s2', 25_000, [['upi', 20_000], ['cash', 5_000]])], [ret('r1', 3_000, 'cash')], new Set(['s1']));
    expect(sent).toEqual({
      sales: { count: 2, totalMinor: 35_000 }, takings: [{ kind: 'cash', amountMinor: 15_000 }, { kind: 'upi', amountMinor: 20_000 }],
      returns: { count: 1, refundsMinor: 3_000 }, refunds: [{ kind: 'cash', amountMinor: 3_000 }], notYetPosted: 2,
    });
    expect(tillsSentOn([], [], new Set()).notYetPosted).toBe(0);
  });

  it('the screen reads it as lines, in both languages; tender kinds in words', () => {
    const shown = presentTillsSent('en', { sales: { count: 2, totalMinor: 35_000 }, takings: [{ kind: 'cash', amountMinor: 15_000 }, { kind: 'upi', amountMinor: 20_000 }], returns: { count: 1, refundsMinor: 3_000 }, refunds: [{ kind: 'cash', amountMinor: 3_000 }], notYetPosted: 2 });
    expect(shown).toEqual({
      sales: 'Sales: 2 bill(s), ₹350.00', takings: ['Cash: ₹150.00', 'UPI: ₹200.00'], returns: 'Returns: 1, ₹30.00 given back', refunds: ['Cash: ₹30.00'],
      waiting: '2 bill(s) or return(s) not yet in the books.', allPosted: false, none: false,
    });
    expect(tenderWords('en', 'store_credit')).toBe('Store credit');
    expect(tenderWords('ta', 'cash')).toBe('ரொக்கம்');
    expect(Object.keys(DAY_BOOK_COPY.ta).sort()).toEqual(Object.keys(DAY_BOOK_COPY.en).sort());
  });

  it('the view carries the tills\' day and says the account names are missing when head office says so', () => {
    const data = (extra: Partial<DayBookReadData>): DayBookReadData => ({ tradingDay: '2026-11-15', journals: [], accounts: [], covered: 0, exceptions: [], open: 0, asAt: 'now', ...extra });
    const session = (d: DayBookReadData) => createDayBookSession({ userId: 'u-acct' }, { dayBook: () => d, mayRead: () => true, mayPost: () => true, postPort: () => ({ post: async () => ({ result: 'lost_link' }) }) });
    const v = session(data({ tillsSent: { sales: { count: 1, totalMinor: 100 }, takings: [], returns: { count: 0, refundsMinor: 0 }, refunds: [], notYetPosted: 1 }, postingMapDefined: false })).view('en');
    expect(v.mapMissing).toBe(true);
    expect(v.tillsSent?.sales).toBe('Sales: 1 bill(s), ₹1.00');
    expect(DAY_BOOK_COPY.en.mapMissing).toMatch(/Accounts and Tally names/);
    const older = session(data({})).view('en');
    expect(older.tillsSent).toBeNull();
    expect(older.mapMissing).toBe(false); // an older head office that does not say is never read as "missing"
  });
});

describe('D-051 · the GST page by job, with a month picker', () => {
  it('every part of the page is in exactly one job; choosing a job hides every other job\'s parts', () => {
    const all = GST_JOBS.flatMap((j) => GST_JOB_PARTS[j]);
    expect(new Set(all).size).toBe(all.length);
    for (const j of GST_JOBS) {
      expect(partsHiddenFor(j).some((id) => GST_JOB_PARTS[j].includes(id))).toBe(false);
      expect(partsHiddenFor(j).length + GST_JOB_PARTS[j].length).toBe(all.length);
    }
    expect(GST_JOB_PARTS.tds).toEqual(['d-tds']);
    expect(gstJobOf('yearly')).toBe('yearly');
    expect(gstJobOf('nonsense')).toBe('monthly');
    expect(gstJobOf(null)).toBe('monthly');
    expect(Object.keys(GST_JOB_WORDS.ta).sort()).toEqual(Object.keys(GST_JOB_WORDS.en).sort());
  });

  it('a month picker\'s YYYY-MM is head office\'s MMYYYY and back; anything else is not a month', () => {
    expect(mmyyyyOf('2026-05')).toBe('052026');
    expect(mmyyyyOf('052026')).toBe('052026'); // a browser with no picker: typed as before
    expect(mmyyyyOf(' 2026-12 ')).toBe('122026');
    for (const bad of ['', '2026-13', '13-26', '132026', '2026/05', null, undefined]) expect(mmyyyyOf(bad)).toBeNull();
    expect(monthInputOf('052026')).toBe('2026-05');
    expect(monthInputOf('2026-05')).toBe('2026-05');
    expect(monthInputOf('')).toBe('');
    expect(monthInputOf('992026')).toBe('');
  });
});
