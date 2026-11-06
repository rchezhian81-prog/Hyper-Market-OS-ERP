import { describe, it, expect } from 'vitest';
import { createNotesSession, notesWords, B2B_NOTES_COPY } from '../../apps/web-erp/src/b2b-notes-session';
import { creditNotesInTheBooks, type NotesBooks } from '../../services/finance/src/credit-notes';

// M23-FR-02 (W4) — the month's credit notes against the books. Head office reads the books from the POSTED LEDGER (the
// b2b:credit_note journals its posting run put there); the office screen sends only the month, never a figure.

const viewer = { userId: 'u-acct', permissions: ['finance.creditnote.issue'] };
const recorder = () => {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return new Response(JSON.stringify({ period: '2026-11', notesIssued: 1, reconciles: false, differenceMinor: 21_000, ledger: { totalMinor: 0 }, notInTheBooks: [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('the Business customers page asks head office for a month\'s reconciliation, sending only the month (M23-FR-02)', () => {
  it('sends the month alone — no ledger figure leaves the screen', async () => {
    const r = recorder();
    const out = await createNotesSession({ viewer, fetch: r.fetch }).reconcile(' 2026-11 ');
    expect(out.result).toBe('ok');
    expect(r.calls).toEqual(['GET /v1/finance/credit-notes/reconciliation?period=2026-11']);
  });

  it('refuses a missing or malformed month on the screen, and a person who may not issue notes, before calling head office', async () => {
    const r = recorder();
    const s = createNotesSession({ viewer, fetch: r.fetch });
    expect(await s.reconcile('')).toEqual({ result: 'invalid', why: 'needPeriod' });
    expect(await s.reconcile('2026-13')).toEqual({ result: 'invalid', why: 'needPeriod' });
    expect(await createNotesSession({ viewer: { userId: 'u-mgr', permissions: ['finance.period.read'] }, fetch: r.fetch }).reconcile('2026-11')).toEqual({ result: 'invalid', why: 'cannotIssue' });
    expect(await createNotesSession({ viewer: undefined, fetch: r.fetch }).reconcile('2026-11')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(r.calls).toEqual([]);
  });

  it('speaks English and Tamil for every reconciliation word', () => {
    const keys = ['reconH', 'reconLead', 'periodL', 'reconShow', 'needPeriod', 'notesSide', 'booksSide', 'diffL', 'agrees', 'differs', 'splitUnknown', 'outsideWindow', 'missingH', 'missingNone',
      'state_waiting_for_posting_rule', 'state_not_posted_yet', 'state_posted_to_another_period'];
    for (const k of keys) {
      expect((B2B_NOTES_COPY.en as Record<string, string>)[k], k).toBeTruthy();
      expect((B2B_NOTES_COPY.ta as Record<string, string>)[k], k).toBeTruthy();
      expect(notesWords('ta', k)).not.toBe(notesWords('en', k));
    }
  });
});

describe('what the posted ledger carries for a month\'s credit notes (M23-FR-02)', () => {
  const rule = { kind: 'b2b:credit_note', legs: [{ account: 'sales_returns', side: 'debit' as const, component: 'net' }, { account: 'gst_output', side: 'debit' as const, component: 'tax' }, { account: 'ar', side: 'credit' as const, component: 'total' }] };
  const j = (id: string, period: string, net: number, tax: number, kind = 'b2b:credit_note') => ({
    sourceId: id, entryId: `b2b:${id}`, period, kind,
    lines: [{ accountCode: 'sales_returns', debitMinor: net, creditMinor: 0 }, { accountCode: 'gst_output', debitMinor: tax, creditMinor: 0 }, { accountCode: 'ar', debitMinor: 0, creditMinor: net + tax }],
  });

  it('sums only the month\'s credit-note journals, splitting GST by the account the rule names', () => {
    const books: NotesBooks = { ruleKinds: ['b2b:credit_note'], rules: [rule], journals: [j('a', '2026-11', 20_000, 1_000), j('b', '2026-12', 5_000, 250), j('c', '2026-11', 9_999, 1, 'b2b:invoice')] };
    expect(creditNotesInTheBooks(books, '2026-11')).toMatchObject({ journals: ['b2b:a'], totalMinor: 21_000, taxableMinor: 20_000, taxMinor: 1_000, split: 'by_account', taxAccount: 'gst_output' });
  });

  it('says the split is not known when no rule names a separate GST account — the whole value still counts', () => {
    const books: NotesBooks = { ruleKinds: undefined, journals: [j('a', '2026-11', 20_000, 1_000)] };
    expect(creditNotesInTheBooks(books, '2026-11')).toMatchObject({ totalMinor: 21_000, taxableMinor: 21_000, taxMinor: 0, split: 'not_known' });
    expect(creditNotesInTheBooks({ ruleKinds: undefined, journals: [] }, '2026-11')).toMatchObject({ totalMinor: 0, journals: [] });
  });
});
