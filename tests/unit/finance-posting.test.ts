import { describe, it, expect } from 'vitest';
import {
  postJournal,
  postBatch,
  UnmappedKindError,
  MissingComponentError,
  UnbalancedJournalError,
  type PostingMap,
  type PostingInput,
} from '../../packages/finance/src/index';
import { money } from '../../packages/contracts/src/money';

// Posting is deterministic from a configurable chart-of-accounts map; every journal
// balances or is refused; an unmapped event is a visible exception (M23-FR-01/02).

const MAP: PostingMap = {
  rules: [
    {
      kind: 'sale',
      legs: [
        { account: 'cash', side: 'debit', component: 'total' },
        { account: 'sales_revenue', side: 'credit', component: 'net' },
        { account: 'gst_output', side: 'credit', component: 'tax' },
      ],
    },
    {
      kind: 'sale_return',
      legs: [
        { account: 'sales_revenue', side: 'debit', component: 'net' },
        { account: 'gst_output', side: 'debit', component: 'tax' },
        { account: 'cash', side: 'credit', component: 'total' },
      ],
    },
    {
      // deliberately broken rule to prove the balance guard
      kind: 'broken',
      legs: [
        { account: 'a', side: 'debit', component: 'total' },
        { account: 'b', side: 'credit', component: 'net' },
      ],
    },
  ],
};

const AT = '2026-08-02T18:00:00Z';

function sale(overrides: Partial<PostingInput> = {}): PostingInput {
  return {
    id: 'sale-1',
    kind: 'sale',
    at: AT,
    currency: 'INR',
    components: { total: 118_00, net: 100_00, tax: 18_00 },
    ...overrides,
  };
}

describe('postJournal', () => {
  it('posts a balanced double-entry journal for a sale (with GST)', () => {
    const entry = postJournal(sale(), MAP);
    expect(entry.balanced).toBe(true);
    expect(entry.totalDebit).toEqual(money(118_00, 'INR'));
    expect(entry.totalCredit).toEqual(money(118_00, 'INR'));
    expect(entry.lines).toEqual([
      { account: 'cash', side: 'debit', amount: money(118_00, 'INR') },
      { account: 'sales_revenue', side: 'credit', amount: money(100_00, 'INR') },
      { account: 'gst_output', side: 'credit', amount: money(18_00, 'INR') },
    ]);
  });

  it('reverses tax and revenue on a return', () => {
    const entry = postJournal(
      sale({ id: 'ret-1', kind: 'sale_return' }),
      MAP,
    );
    expect(entry.totalDebit).toEqual(money(118_00, 'INR'));
    expect(entry.totalCredit).toEqual(money(118_00, 'INR'));
    const gst = entry.lines.find((l) => l.account === 'gst_output');
    expect(gst?.side).toBe('debit'); // tax reversed
  });

  it('omits a zero component line (e.g. tax on an exempt sale) and still balances', () => {
    const entry = postJournal(
      sale({ components: { total: 100_00, net: 100_00, tax: 0 } }),
      MAP,
    );
    expect(entry.lines.map((l) => l.account)).toEqual(['cash', 'sales_revenue']);
    expect(entry.balanced).toBe(true);
  });

  it('raises an exception for an unmapped kind (never silently unposted)', () => {
    expect(() => postJournal(sale({ kind: 'mystery' }), MAP)).toThrow(UnmappedKindError);
  });

  it('raises an exception when a required amount component is missing', () => {
    expect(() => postJournal(sale({ components: { total: 118_00, net: 100_00 } }), MAP)).toThrow(
      MissingComponentError,
    );
  });

  it('refuses an unbalanced journal', () => {
    expect(() =>
      postJournal(
        { id: 'x', kind: 'broken', at: AT, currency: 'INR', components: { total: 100_00, net: 90_00 } },
        MAP,
      ),
    ).toThrow(UnbalancedJournalError);
  });
});

describe('postBatch', () => {
  it('posts the good entries and surfaces the bad ones as visible exceptions', () => {
    const result = postBatch(
      [sale({ id: 's1' }), sale({ id: 's2', kind: 'mystery' }), sale({ id: 's3' })],
      MAP,
    );
    expect(result.entries.map((e) => e.sourceId)).toEqual(['s1', 's3']);
    expect(result.exceptions).toEqual([
      { ok: false, sourceId: 's2', error: 'UnmappedKindError' },
    ]);
  });
});
