import { describe, it, expect } from 'vitest';
import {
  assessTillSpend, walletAvailable, readWalletFeed, spendsOfSaleRecord, spendRefFor,
  type WalletFeed, type LocalSpend,
} from '../../packages/loyalty/src/wallet';

// PF-09 step 3: the store computer's decision on a points / store-credit spend at the till — against its copy of head
// office's balances, less its own not-yet-applied spends, within the owner's till spend cap (M17-FR-01/03 offline caps).

const M = `m-${'a'.repeat(24)}`;
const OTHER = `m-${'b'.repeat(24)}`;
const DAY = '2026-10-10';
const feed = (over: Partial<WalletFeed['rule']> = {}, member: Partial<WalletFeed['members'][number]> = {}): WalletFeed => ({
  tenantId: 't1', generatedAt: '2026-10-10T08:00:00.000Z',
  rule: { pointsPer100Inr: 1, pointValuePaise: 100, tillSpendCapPaise: 50_000, ...over },
  members: [{ memberRef: M, points: 100, storeCreditMinor: 20_000, appliedSpendRefs: [], ...member }],
});
const spend = (saleId: string, kind: LocalSpend['kind'], amountMinor: number, tradingDay = DAY, memberRef = M): LocalSpend =>
  ({ ref: spendRefFor(saleId, kind), saleId, memberRef, kind, amountMinor, tradingDay });

describe('assessTillSpend — the box decides a spend before the disk', () => {
  it('a sale with no spend tender is always fine, member or not, feed or not', () => {
    expect(assessTillSpend({ feed: undefined, saleId: 'S1', memberRef: undefined, tenders: [{ kind: 'cash', amountMinor: 100 }], localSpends: [], tradingDay: DAY })).toEqual({ ok: true, spends: [] });
  });

  it('allows points within the copy, the cap and whole points; records the spend by sale and kind', () => {
    const r = assessTillSpend({ feed: feed(), saleId: 'S1', memberRef: M, tenders: [{ kind: 'loyalty_points', amountMinor: 5_000 }, { kind: 'store_credit', amountMinor: 2_000 }, { kind: 'cash', amountMinor: 1 }], localSpends: [], tradingDay: DAY });
    expect(r).toEqual({ ok: true, spends: [spend('S1', 'loyalty_points', 5_000), spend('S1', 'store_credit', 2_000)] });
  });

  it.each([
    ['no member named', { memberRef: undefined }, 'no_member_named'],
    ['no feed yet', { feed: undefined }, 'wallets_not_known'],
    ['till spending off (cap 0)', { feed: feed({ tillSpendCapPaise: 0 }) }, 'till_spending_off'],
    ['point value not set', { feed: feed({ pointValuePaise: 0 }) }, 'points_value_not_set'],
    ['not whole points', { tenders: [{ kind: 'loyalty_points', amountMinor: 150 }] }, 'not_whole_points'],
    ['more points than held', { tenders: [{ kind: 'loyalty_points', amountMinor: 10_100 }] }, 'not_enough_points'],
    ['more credit than held', { tenders: [{ kind: 'store_credit', amountMinor: 20_001 }] }, 'not_enough_store_credit'],
    ['over the day cap', { feed: feed({ tillSpendCapPaise: 6_000 }), tenders: [{ kind: 'loyalty_points', amountMinor: 5_000 }, { kind: 'store_credit', amountMinor: 2_000 }] }, 'over_till_spend_cap'],
    ['points twice on one bill', { tenders: [{ kind: 'loyalty_points', amountMinor: 100 }, { kind: 'loyalty_points', amountMinor: 100 }] }, 'one_spend_of_each_kind'],
    ['a zero spend', { tenders: [{ kind: 'store_credit', amountMinor: 0 }] }, 'spend_amount_invalid'],
  ] as const)('refuses before the disk: %s', (_, over, reason) => {
    const r = assessTillSpend({ feed: feed(), saleId: 'S1', memberRef: M, tenders: [{ kind: 'loyalty_points', amountMinor: 100 }], localSpends: [], tradingDay: DAY, ...over });
    expect(r).toMatchObject({ ok: false, refusedBecause: reason });
    expect((r as { laneMessage: string }).laneMessage).toMatch(/Nothing was saved/);
  });

  it('this box\'s own unapplied spends count against the copy; applied ones do not count twice', () => {
    const local = [spend('S0', 'loyalty_points', 6_000), spend('S0', 'store_credit', 15_000)];
    // 100 points − 60 pending = 40 left (₹40); ₹200 − ₹150 = ₹50 credit left.
    expect(assessTillSpend({ feed: feed(), saleId: 'S1', memberRef: M, tenders: [{ kind: 'loyalty_points', amountMinor: 4_100 }], localSpends: local, tradingDay: DAY })).toMatchObject({ refusedBecause: 'not_enough_points' });
    expect(assessTillSpend({ feed: feed(), saleId: 'S1', memberRef: M, tenders: [{ kind: 'store_credit', amountMinor: 5_100 }], localSpends: local, tradingDay: DAY })).toMatchObject({ refusedBecause: 'not_enough_store_credit' });
    // Once head office has applied S0, its balances already reflect it: the copy is not reduced again.
    const applied = feed({}, { points: 40, storeCreditMinor: 5_000, appliedSpendRefs: [spendRefFor('S0', 'loyalty_points'), spendRefFor('S0', 'store_credit')] });
    expect(assessTillSpend({ feed: applied, saleId: 'S1', memberRef: M, tenders: [{ kind: 'loyalty_points', amountMinor: 4_000 }], localSpends: local, tradingDay: DAY })).toMatchObject({ ok: true });
  });

  it('the day cap counts every spend at this box today, applied or not, and resets the next trading day', () => {
    const local = [spend('S0', 'store_credit', 45_000, DAY)];
    const f = feed({}, { storeCreditMinor: 100_000, appliedSpendRefs: [spendRefFor('S0', 'store_credit')] });
    expect(assessTillSpend({ feed: f, saleId: 'S1', memberRef: M, tenders: [{ kind: 'store_credit', amountMinor: 5_001 }], localSpends: local, tradingDay: DAY })).toMatchObject({ refusedBecause: 'over_till_spend_cap' });
    expect(assessTillSpend({ feed: f, saleId: 'S1', memberRef: M, tenders: [{ kind: 'store_credit', amountMinor: 5_000 }], localSpends: local, tradingDay: DAY })).toMatchObject({ ok: true });
    expect(assessTillSpend({ feed: f, saleId: 'S1', memberRef: M, tenders: [{ kind: 'store_credit', amountMinor: 40_000 }], localSpends: local, tradingDay: '2026-10-11' })).toMatchObject({ ok: true });
  });

  it('a re-sent sale is not counted against itself, and another member\'s spends never count', () => {
    const local = [spend('S1', 'loyalty_points', 10_000), spend('S9', 'loyalty_points', 10_000, DAY, OTHER)];
    expect(assessTillSpend({ feed: feed(), saleId: 'S1', memberRef: M, tenders: [{ kind: 'loyalty_points', amountMinor: 10_000 }], localSpends: local, tradingDay: DAY })).toMatchObject({ ok: true });
  });
});

describe('walletAvailable, the feed reader and the disk reader', () => {
  it('says what is left, never below zero, and how old the copy is', () => {
    const a = walletAvailable({ feed: feed(), memberRef: M, localSpends: [spend('S0', 'loyalty_points', 20_000)], tradingDay: DAY });
    expect(a).toMatchObject({ known: true, points: 0, pointsValueMinor: 0, storeCreditMinor: 20_000, spentTodayMinor: 20_000, capRemainingMinor: 30_000, asOf: '2026-10-10T08:00:00.000Z' });
    expect(walletAvailable({ feed: feed(), memberRef: OTHER, localSpends: [], tradingDay: DAY })).toMatchObject({ known: true, points: 0, storeCreditMinor: 0 });
    expect(walletAvailable({ feed: undefined, memberRef: M, localSpends: [], tradingDay: DAY })).toMatchObject({ known: false });
  });

  it('a malformed feed is refused whole; a phone number is never a member', () => {
    expect(readWalletFeed(feed())).toEqual(feed());
    expect(readWalletFeed({ ...feed(), members: [{ memberRef: '9840012345', points: 1, storeCreditMinor: 0, appliedSpendRefs: [] }] })).toBeUndefined();
    expect(readWalletFeed({ ...feed(), rule: { pointsPer100Inr: 1, pointValuePaise: -1, tillSpendCapPaise: 0 } })).toBeUndefined();
    expect(readWalletFeed(null)).toBeUndefined();
  });

  it('reads the spends off a saved sale record in either tender shape', () => {
    expect(spendsOfSaleRecord({ id: 'S1', tradingDay: DAY, customerRef: M, tenders: [{ kind: 'loyalty_points', amount: { minor: 300 } }, { kind: 'store_credit', amountMinor: 200 }, { kind: 'cash', amountMinor: 5 }] }))
      .toEqual([spend('S1', 'loyalty_points', 300), spend('S1', 'store_credit', 200)]);
    expect(spendsOfSaleRecord({ id: 'S1', customerRef: 'not-a-member', tenders: [{ kind: 'store_credit', amountMinor: 200 }] })).toEqual([]);
  });
});
