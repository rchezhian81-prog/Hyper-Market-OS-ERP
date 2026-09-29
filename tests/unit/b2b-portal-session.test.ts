import { describe, it, expect } from 'vitest';
import {
  createB2BPortalSession, B2B_PORTAL_COPY, COPY_KEYS,
  type B2BPortalData, type B2BInvoiceView, type B2BAccountView, type B2BStatementView, type B2BDocumentView,
} from '../../apps/b2b-app/src/b2b-portal-session';
import { bilingualGaps } from '../../packages/ui/src/index';

// The business-customer portal (M22-FR-04 · API-09 · §35 · P-03 · P-04 · P-08) is READ-ONLY: a credit customer
// reads its OWN account, invoices, statement and documents, and nothing else. These are unit tests on the tested
// session model — the DOM and the fetch are proven separately (guardrail, browser e2e).

const ASAT = '2026-09-29T10:00:00.000Z';
const account = (over: Partial<B2BAccountView> = {}): B2BAccountView => ({
  customerId: 'c-caterer', hasCreditAccount: true, creditLimitMinor: 5_000_000, currency: 'INR', outstandingMinor: 1_250_000, availableCreditMinor: 3_750_000, ...over,
});
const invoice = (over: Partial<B2BInvoiceView> & { invoiceId: string }): B2BInvoiceView => ({
  number: over.invoiceId.toUpperCase(), issuedOn: '2026-08-01', dueOn: '2026-08-31', grossMinor: 500_000, settledMinor: 0, outstandingMinor: 500_000, disputed: false, ...over,
});
const statement = (over: Partial<B2BStatementView> = {}): B2BStatementView => ({
  customerId: 'c-caterer', asAt: '2026-09-29',
  ageing: { totalOutstandingMinor: 1_250_000, overdueMinor: 750_000, disputedMinor: 200_000, buckets: { not_due: 500_000, due_0_30: 0, due_31_60: 750_000, due_61_90: 0, due_90_plus: 0 }, detail: '750000 overdue' },
  ...over,
});
const documents: readonly B2BDocumentView[] = [
  { documentId: 'd-q1', kind: 'quotation', number: 'Q-0001', grossMinor: 300_000, validUntil: '2026-10-15' },
  { documentId: 'd-inv1', kind: 'tax_invoice', number: 'INV-0007', grossMinor: 750_000, derivedFrom: 'd-ch1' },
];
const data = (over: Partial<B2BPortalData> = {}): B2BPortalData => ({
  account: account(),
  invoices: [
    invoice({ invoiceId: 'inv-overdue', dueOn: '2026-08-15', outstandingMinor: 750_000, grossMinor: 750_000 }),
    invoice({ invoiceId: 'inv-open', dueOn: '2026-10-20' }),
    invoice({ invoiceId: 'inv-disputed', dueOn: '2026-08-20', outstandingMinor: 200_000, grossMinor: 200_000, disputed: true, disputeReason: 'two cases short on delivery' }),
    invoice({ invoiceId: 'inv-paid', dueOn: '2026-07-31', settledMinor: 500_000, outstandingMinor: 0 }),
  ],
  statement: statement(), documents, refusals: {}, asAt: ASAT, ...over,
});
const session = (d: B2BPortalData, mayRead = true, userId: string | null = 'u-caterer') =>
  createB2BPortalSession({ userId }, { portal: () => d, mayRead: () => mayRead });

describe('the B2B portal is offered in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(B2B_PORTAL_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });
  it('the same view in Tamil carries Tamil words', () => {
    const v = session(data()).view('ta');
    expect(v.documents[0]!.kindLabel).toBe('விலைப்புள்ளி');
    expect(v.invoices[0]!.status.label).toContain('தாமதம்');
  });
});

describe('the credit account — the terms and what is owed, never a made-up zero', () => {
  it('presents the limit, the outstanding and what is left; exhausted credit reads as attention', () => {
    const v = session(data()).view('en');
    expect(v.account).toMatchObject({ hasCreditAccount: true, creditLimit: '₹50,000.00', outstanding: '₹12,500.00', available: '₹37,500.00' });
    expect(v.account!.status.tone).toBe('ok');
    const maxed = session(data({ account: account({ outstandingMinor: 5_200_000, availableCreditMinor: 0 }) })).view('en');
    expect(maxed.account!.status).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(maxed.account!.status.icon.trim().length).toBeGreaterThan(0);
  });
  it('"no credit terms" is a plain fact — no panel, the noTerms line, and the feed counts as shown', () => {
    const v = session(data({ account: { customerId: 'c-caterer', hasCreditAccount: false, outstandingMinor: 0, detail: 'no credit terms have been set for this account' } })).view('en');
    expect(v.account).toBeNull();
    expect(v.noTerms).toBe(true);
    expect(v.screenState.tone).not.toBe('error');
  });
});

describe('invoices — each stands as a state with a word and an icon, never colour alone', () => {
  it('settled → ok, disputed → degraded (with a person), overdue → error, open → idle; counts follow', () => {
    const v = session(data()).view('en');
    const by = (id: string) => v.invoices.find((i) => i.invoiceId === id)!;
    expect(by('inv-paid').status).toMatchObject({ tone: 'ok', label: 'Settled' });
    expect(by('inv-disputed').status.tone).toBe('degraded');
    expect(by('inv-disputed').disputeReason).toBe('two cases short on delivery');
    expect(by('inv-overdue')).toMatchObject({ overdue: true, open: '₹7,500.00' });
    expect(by('inv-overdue').status.tone).toBe('error');
    expect(by('inv-open').status).toMatchObject({ tone: 'idle' });
    expect(by('inv-open').overdue).toBe(false);
    for (const i of v.invoices) { expect(i.status.icon.trim().length).toBeGreaterThan(0); expect(i.status.label.length).toBeGreaterThan(0); }
    expect(v.overdueCount).toBe(1);
    expect(v.disputedCount).toBe(1);
    expect(v.anyAttention).toBe(true);
  });
});

describe('the statement — aged from the due dates; overdue is attention, 90+ days an error', () => {
  it('presents totals, disputed separately, and every bucket with a label', () => {
    const v = session(data()).view('en');
    expect(v.statement).toMatchObject({ totalOutstanding: '₹12,500.00', overdue: '₹7,500.00', disputed: '₹2,000.00' });
    expect(v.statement!.buckets.map((b) => [b.label, b.amount])).toEqual([
      ['Not yet due', '₹5,000.00'], ['1–30 days overdue', '₹0.00'], ['31–60 days overdue', '₹7,500.00'], ['61–90 days overdue', '₹0.00'], ['Over 90 days overdue', '₹0.00'],
    ]);
    expect(v.statement!.status.tone).toBe('degraded');
    const old = session(data({ statement: statement({ ageing: { totalOutstandingMinor: 100, overdueMinor: 100, disputedMinor: 0, buckets: { not_due: 0, due_0_30: 0, due_31_60: 0, due_61_90: 0, due_90_plus: 100 }, detail: 'x' } }) })).view('en');
    expect(old.statement!.status.tone).toBe('error');
    const clean = session(data({ statement: statement({ ageing: { totalOutstandingMinor: 100, overdueMinor: 0, disputedMinor: 0, buckets: { not_due: 100, due_0_30: 0, due_31_60: 0, due_61_90: 0, due_90_plus: 0 }, detail: 'x' } }) })).view('en');
    expect(clean.statement!.status.tone).toBe('ok');
  });
  it('no invoices ever recorded → no statement panel and the plain "nothing to age" note (feed empty, not refused)', () => {
    const v = session(data({ statement: statement({ ageing: null, detail: 'no invoices have been recorded for this account' }) })).view('en');
    expect(v.statement).toBeNull();
    expect(v.feeds.statement).toBe('empty');
    expect(v.feedNotes.statement).toBeUndefined();
  });
});

describe('a missing grant is a permission answer, never a zero (P-08); each feed stands on its own', () => {
  it('a refused statement and account say "ask us" while invoices and documents still show', () => {
    const v = session(data({ account: null, statement: null, refusals: { account: 'no_grant', statement: 'no_grant' } })).view('en');
    expect(v.account).toBeNull();
    expect(v.noTerms).toBe(false);
    expect(v.statement).toBeNull();
    expect(v.feeds).toEqual({ account: 'no_grant', invoices: 'shown', statement: 'no_grant', documents: 'shown' });
    expect(v.feedNotes.account).toMatch(/cannot see the account balance/);
    expect(v.feedNotes.statement).toMatch(/does not mean nothing is owed/);
    expect(v.feedNotes.invoices).toBeUndefined();
    expect(v.invoices).toHaveLength(4);
    expect(v.documents.map((d) => d.kindLabel)).toEqual(['Quotation', 'Tax invoice']);
    expect(v.screenState.tone).not.toBe('error');
  });
  it('a feed that could not be read is "unavailable" with its own words, and an empty list is just empty', () => {
    const v = session(data({ documents: null, invoices: [], refusals: { documents: 'unavailable' } })).view('en');
    expect(v.feeds.documents).toBe('unavailable');
    expect(v.feedNotes.documents).toMatch(/Could not be read just now/);
    expect(v.feeds.invoices).toBe('empty');
    expect(v.feedNotes.invoices).toBeUndefined();
  });
});

describe('who may look', () => {
  it('a login without b2b.portal.self gets a not-permitted state and none of the data', () => {
    const v = session(data(), false).view('en');
    expect(v.screenState.tone).toBe('error');
    expect(v.account).toBeNull();
    expect(v.invoices).toEqual([]);
    expect(v.statement).toBeNull();
    expect(v.documents).toEqual([]);
  });
  it('an unidentified login is flagged; nothing at all on the account is the empty state', () => {
    expect(session(data(), true, null).view('en').notIdentified).toBe(true);
    const empty = session({ account: null, invoices: [], statement: null, documents: [], refusals: {}, asAt: ASAT }).view('en');
    expect(empty.screenState.label).toMatch(/Nothing to show yet/);
  });
});
