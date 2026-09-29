// The day-book session (M23-FR-01 · API-09 · P-03 · P-08 · §28): what the accountant sees for a trading day — the
// posted journals, the accounts they move, the exceptions with their state — and the one act, posting the day,
// refused locally before any POST without permission or a valid trading day; every outcome presented with a
// tone, an icon and words.
import { describe, it, expect } from 'vitest';
import {
  createDayBookSession, DAY_BOOK_COPY, COPY_KEYS, isTradingDay,
  type DayBookPorts, type DayBookReadData, type DayBookJournalView, type DayBookExceptionView, type DayBookPostBody, type PostResult,
} from '../../apps/web-erp/src/day-book-session';

const journal = (over: Partial<DayBookJournalView> & Pick<DayBookJournalView, 'entryId' | 'kind'>): DayBookJournalView => ({
  sourceKind: 'sale', sources: 3, period: '2026-09', documentDate: '2026-09-28',
  components: { total: 300_00, net: 285_72, tax: 14_28, cgst: 7_14, sgst: 7_14 },
  lines: [{ accountCode: '1210', debitMinor: 300_00, creditMinor: 0 }, { accountCode: '4000', debitMinor: 0, creditMinor: 285_72 }, { accountCode: '2310', debitMinor: 0, creditMinor: 14_28 }],
  postedBy: 'u-acct', narrative: 'Day book 2026-09-28 — sale', ...over,
});
const exception = (over: Partial<DayBookExceptionView> & Pick<DayBookExceptionView, 'exceptionId' | 'state'>): DayBookExceptionView => ({
  tradingDay: '2026-09-28', sourceKind: 'sale', sourceIds: ['S-9'], reason: 'tax_rate_unknown', detail: 'S-9 line 2: tax rate for P-77 unknown',
  raisedAt: '2026-09-29T02:00:00.000Z', raisedBy: 'u-acct', ...over,
});
const READ: DayBookReadData = {
  tradingDay: '2026-09-28',
  journals: [
    journal({ entryId: 'daybook:2026-09-28:sale:1', kind: 'sale' }),
    journal({ entryId: 'daybook:2026-09-28:sale_return:1', kind: 'sale_return', sourceKind: 'return', sources: 1, components: { total: 50_00, net: 47_62, tax: 2_38, cgst: 1_19, sgst: 1_19 } }),
    journal({ entryId: 'daybook:2026-09-28:tender:cash:1', kind: 'tender:cash', components: { amount: 250_00 }, lines: [{ accountCode: '1000', debitMinor: 250_00, creditMinor: 0 }, { accountCode: '1210', debitMinor: 0, creditMinor: 250_00 }] }),
  ],
  accounts: [
    { accountCode: '1000', debitMinor: 250_00, creditMinor: 0, balanceMinor: 250_00 },
    { accountCode: '1210', debitMinor: 300_00, creditMinor: 250_00, balanceMinor: 50_00 },
  ],
  covered: 4,
  exceptions: [
    exception({ exceptionId: '2026-09-28:unmapped_kind:tender:upi:abc', state: 'resolved', reason: 'unmapped_kind', kind: 'tender:upi', sourceIds: ['S-1', 'S-2'], detail: 'no posting rule for tender:upi' }),
    exception({ exceptionId: '2026-09-28:tax_rate_unknown:sale:def', state: 'open' }),
  ],
  open: 1, asAt: '2026-09-29T09:00:00.000Z',
};
const POSTED: DayBookPostBody = {
  tradingDay: '2026-09-28', postedTo: '2026-09', journals: READ.journals, exceptions: [], skipped: 0, zeroValue: [], counted: { sales: 3, returns: 1 },
};

function harness(over: Partial<DayBookPorts> = {}, userId: string | null = 'u-acct') {
  const posts: unknown[] = [];
  const session = createDayBookSession({ userId }, {
    dayBook: () => READ, mayRead: () => true, mayPost: () => true,
    postPort: () => ({ post: async (input) => { posts.push(input); return { result: 'posted', body: POSTED }; } }),
    ...over,
  });
  return { session, posts };
}

describe('the view — the day as the cloud holds it', () => {
  it('presents the journals with a kind label and amount, the accounts, and the exceptions open-first with their state', () => {
    const v = harness().session.view('en');
    expect(v.tradingDay).toBe('2026-09-28');
    expect(v.posted).toBe(true);
    expect(v.journals.map((j) => [j.kindLabel, j.amount, j.sources])).toEqual([['Sales', '₹300.00', 3], ['Returns', '₹50.00', 1], ['Takings — cash', '₹250.00', 3]]);
    expect(v.journals[0]!.lines).toEqual([
      { accountCode: '1210', debit: '₹300.00', credit: '₹0.00' }, { accountCode: '4000', debit: '₹0.00', credit: '₹285.72' }, { accountCode: '2310', debit: '₹0.00', credit: '₹14.28' },
    ]);
    expect(v.journals[0]!.status).toMatchObject({ tone: 'ok', label: 'Posted' });
    expect(v.salesTotal).toBe('₹300.00');
    expect(v.returnsTotal).toBe('₹50.00');
    expect(v.covered).toBe(4);
    expect(v.accounts.map((a) => [a.accountCode, a.debit, a.credit, a.balance])).toEqual([['1000', '₹250.00', '₹0.00', '₹250.00'], ['1210', '₹300.00', '₹250.00', '₹50.00']]);
    expect(v.exceptions.map((e) => [e.state, e.reasonLabel, e.kind])).toEqual([['open', 'Tax rate unknown', null], ['resolved', 'No posting rule for this kind', 'tender:upi']]);
    expect(v.exceptions[0]!.status).toMatchObject({ tone: 'error', label: 'Open — not in the accounts', needsAttention: true });
    expect(v.exceptions[1]!.status).toMatchObject({ tone: 'ok', label: 'Resolved' });
    expect(v.openCount).toBe(1);
    expect(v.resolvedCount).toBe(1);
    for (const s of [...v.journals.map((j) => j.status), ...v.exceptions.map((e) => e.status)]) { expect(s.icon.trim().length).toBeGreaterThan(0); expect(s.label.length).toBeGreaterThan(0); }
  });

  it('a day posted late into the next open period is marked as attention; an unknown reason still reads as words', () => {
    const late: DayBookReadData = { ...READ, journals: [journal({ entryId: 'j', kind: 'sale', period: '2026-10', belongsTo: '2026-09' })], exceptions: [exception({ exceptionId: 'x', state: 'open', reason: 'something_new' })] };
    const v = harness({ dayBook: () => late }).session.view('en');
    expect(v.journals[0]).toMatchObject({ late: true, belongsTo: '2026-09', period: '2026-10' });
    expect(v.journals[0]!.status).toMatchObject({ tone: 'degraded', needsAttention: true });
    expect(v.exceptions[0]!.reasonLabel).toBe('Could not be posted');
  });

  it('nothing read yet or nothing posted → the empty state, never figures that look booked; no read permission → error; Tamil words', () => {
    const none = harness({ dayBook: () => null }).session.view('en');
    expect(none.posted).toBe(false);
    expect(none.journals).toEqual([]);
    expect(none.screenState.label).toMatch(/Nothing posted/);
    const unposted = harness({ dayBook: () => ({ ...READ, journals: [], accounts: [], covered: 0, exceptions: [], open: 0 }) }).session.view('en');
    expect(unposted.posted).toBe(false);
    expect(unposted.salesTotal).toBeNull();
    expect(unposted.screenState.tone).not.toBe('error');
    const noRead = harness({ mayRead: () => false }).session.view('en');
    expect(noRead.screenState.tone).toBe('error');
    expect(noRead.journals).toEqual([]);
    expect(harness({}, null).session.view('en').nobodyNamed).toBe(true);
    const ta = harness().session.view('ta');
    expect(ta.journals[0]!.kindLabel).toBe('விற்பனை');
    expect(ta.exceptions[0]!.status.label).toContain('திறந்தது');
    for (const key of COPY_KEYS) { expect(DAY_BOOK_COPY.en[key].length, `en ${key}`).toBeGreaterThan(0); expect(DAY_BOOK_COPY.ta[key].length, `ta ${key}`).toBeGreaterThan(0); }
  });
});

describe('posting the day — refused locally before any POST unless permitted and a valid trading day', () => {
  it('reaches the port only with finance.journal.post and a YYYY-MM-DD trading day', async () => {
    const h = harness();
    expect(await h.session.post('2026-09-28')).toEqual({ result: 'posted', body: POSTED });
    expect(h.posts).toEqual([{ tradingDay: '2026-09-28' }]);
    expect(await h.session.post('28/09/2026')).toEqual({ result: 'refused' });
    expect(await h.session.post('')).toEqual({ result: 'refused' });
    expect(await h.session.post('2026-13-45')).toEqual({ result: 'refused' });
    expect(h.posts).toHaveLength(1);
    const noPost = harness({ mayPost: () => false });
    expect(noPost.session.view('en').mayPost).toBe(false);
    expect(await noPost.session.post('2026-09-28')).toEqual({ result: 'refused' });
    expect(noPost.posts).toEqual([]);
    expect(isTradingDay('2026-02-30')).toBe(true); // shape-valid; the cloud owns the calendar
    expect(isTradingDay('2026-2-3')).toBe(false);
  });

  it('every outcome is presented with a tone, an icon and words — posted (with the count and the period), late, nothing new, no posting map, refused, lost link', () => {
    const s = harness().session;
    const posted = s.presentPostResult('en', { result: 'posted', body: POSTED });
    expect(posted.tone).toBe('ok');
    expect(posted.label).toContain('3 journals posted → 2026-09');
    expect(posted.label).toContain('3/1 counted');
    const late = s.presentPostResult('en', { result: 'posted', body: { ...POSTED, postedTo: '2026-10', postedLate: { belongsTo: '2026-09' } } });
    expect(late.tone).toBe('degraded');
    expect(late.label).toContain('closed month');
    expect(s.presentPostResult('en', { result: 'nothing_new', body: { ...POSTED, journals: [] } })).toMatchObject({ tone: 'idle', needsAttention: false });
    expect(s.presentPostResult('en', { result: 'no_posting_map' }).label).toMatch(/posting map is not defined/);
    expect(s.presentPostResult('ta', { result: 'no_posting_map' }).label).toMatch(/பதிவு வரைபடம்/);
    expect(s.presentPostResult('en', { result: 'refused' })).toMatchObject({ tone: 'error', needsAttention: true });
    expect(s.presentPostResult('en', { result: 'lost_link' })).toMatchObject({ tone: 'degraded', label: 'No connection — not saved. Try again.' });
    const all: PostResult[] = [{ result: 'posted', body: POSTED }, { result: 'nothing_new', body: POSTED }, { result: 'no_posting_map' }, { result: 'refused' }, { result: 'lost_link' }];
    for (const r of all) { const p = s.presentPostResult('en', r); expect(p.icon.trim().length).toBeGreaterThan(0); expect(p.label.length).toBeGreaterThan(0); }
  });
});
