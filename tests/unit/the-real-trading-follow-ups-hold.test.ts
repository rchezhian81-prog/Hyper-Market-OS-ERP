import { describe, it, expect } from 'vitest';
import { cardPaymentsList, managerPayload, posPayload, tillCatalogue, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { settlementKeyOf } from '../../services/api/src/adapters';
import { reviewSettlement } from '../../packages/settlement/src/settlement';
import { assessExchange, MAX_BILL_ROUND_OFF_MINOR } from '../../packages/returns/src/exchange';
import type { OriginalSale } from '../../packages/returns/src/return-register';
import { invoiceRoundOff } from '../../packages/receipt/src/tax-invoice';

/**
 * **OB-271 follow-ups (real trading, switched OFF during the mirror pilot — OB-248):**
 *
 *   1. the manager's day close on the store computer lists the day's card/UPI payments with each machine's "Approval / Auth
 *      code / RRN" — only in real trading, and never a card number (hard rule #3);
 *   2. a catalogue from the PACK FILE carries each item's HSN code (the till's tax invoice needs it); blank stays absent;
 *   3. head office's settlement review matches a card/UPI payment taken on the shop's own machine by its APPROVAL NUMBER,
 *      and an unmatched or doubled number stays an exception (hard rule #10, P-08);
 *   4. an exchange in real trading charges the replacement its rounded bill (OB-279 · OB-285: never above it, never above
 *      the MRP) and is never refused for the paise a rounded-down bill was charged below its lines.
 *
 * Synthetic data only.
 */

const NOW = '2026-10-21T06:00:00.000Z';
const CARD = ['4111', '1111', '1111', '1111'].join('');
const screenInput = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  pack: emptyPack(), sales: [], unreadableRecords: 0, outbox: { pending: () => [] } as never, now: NOW, tradingDay: '2026-10-21', ...over,
});

describe('1 · the manager\'s day close lists the day\'s card/UPI payments with the machine\'s numbers (real trading only)', () => {
  const day: NonNullable<ScreenInput['cardPayments']> = {
    tradingDay: '2026-10-21',
    paid: [
      { attemptId: 'PAY-2', laneId: 'lane-2', kind: 'upi', amountMinor: 4_100, askedAt: '2026-10-21T07:00:00.000Z', machineRef: '412345678901', appliedToSaleId: 'S-2' },
      { attemptId: 'PAY-1', laneId: 'lane-1', kind: 'card', amountMinor: 10_500, askedAt: '2026-10-21T05:00:00.000Z', machineRef: 'A1B2C3', appliedToSaleId: 'S-1' },
      // An older box, or a log written by hand: a number that is not in its checked form, and one shaped like a card.
      { attemptId: 'PAY-3', laneId: 'lane-1', kind: 'card', amountMinor: 2_000, askedAt: '2026-10-21T08:00:00.000Z', machineRef: CARD },
      { attemptId: 'PAY-4', laneId: 'lane-1', kind: 'card', amountMinor: 3_000, askedAt: '2026-10-21T08:30:00.000Z', machineRef: 'a1 b2' },
    ],
    unresolved: [{ attemptId: 'PAY-5', laneId: 'lane-1', kind: 'card', amountMinor: 999, askedAt: '2026-10-21T09:00:00.000Z', billRef: 'B-5' }],
    refundsOnMachine: [{ billRef: 'RT-9', laneId: 'lane-1', refundTender: 'card', valueMinor: 10_500, machineRef: 'R98765', at: '2026-10-21T10:00:00.000Z', approvedBy: 'u-mgr', cashierId: 'u-cash' }],
  };

  it('absent from the manager\'s payload unless the box gives it (the mirror pilot never does)', () => {
    expect(managerPayload(screenInput())).not.toHaveProperty('cardPayments');
    expect(managerPayload(screenInput({ cardPayments: day }))).toHaveProperty('cardPayments');
  });

  it('each payment with its approval number, oldest first, with the totals; refunds done on the machine with their reference', () => {
    const list = cardPaymentsList(day) as { paid: { at: string; laneId: string; kind: string; amountMinor: number; machineRef: string | null; saleId: string | null }[]; unresolved: unknown[]; refundsOnMachine: unknown[]; paidTotalMinor: number; refundedTotalMinor: number };
    expect(list.paid.map((p) => [p.laneId, p.kind, p.amountMinor, p.machineRef, p.saleId])).toEqual([
      ['lane-1', 'card', 10_500, 'A1B2C3', 'S-1'],
      ['lane-2', 'upi', 4_100, '412345678901', 'S-2'],
      ['lane-1', 'card', 2_000, null, null],
      ['lane-1', 'card', 3_000, null, null],
    ]);
    expect(list.paidTotalMinor).toBe(19_600);
    expect(list.unresolved).toEqual([{ at: '2026-10-21T09:00:00.000Z', laneId: 'lane-1', kind: 'card', amountMinor: 999, billRef: 'B-5' }]);
    expect(list.refundsOnMachine).toEqual([{ at: '2026-10-21T10:00:00.000Z', laneId: 'lane-1', kind: 'card', amountMinor: 10_500, machineRef: 'R98765', returnId: 'RT-9', approvedBy: 'u-mgr' }]);
    expect(list.refundedTotalMinor).toBe(10_500);
  });

  it('hard rule #3: a number that is not a checked approval number is never served — a card number least of all', () => {
    const payload = managerPayload(screenInput({ cardPayments: day }));
    expect(payload['cardPayments']).toMatchObject({ paid: expect.arrayContaining([expect.objectContaining({ amountMinor: 2_000, machineRef: null })]) });
    const served = JSON.stringify(payload);
    expect(served).not.toContain(CARD);
    expect(served).not.toContain('a1 b2');
  });
});

describe('2 · the pack file\'s catalogue carries each item\'s HSN code', () => {
  const pack = (hsnCode?: string): StorePack => ({
    ...emptyPack(),
    products: { known: true, value: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 10_500, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 5, taxBps: 500, status: 'active', ...(hsnCode === undefined ? {} : { hsnCode }) }] },
  } as StorePack);

  it('from the pack file to the till\'s catalogue, as head office published it', () => {
    expect(tillCatalogue(pack('071360'), undefined, NOW)).toMatchObject({ source: 'pack_file', products: [expect.objectContaining({ productId: 'P1', hsnCode: '071360' })] });
    const served = posPayload(screenInput({ pack: pack('071360') })) as { products: { productId: string; hsnCode?: string }[] };
    expect(served.products).toEqual([expect.objectContaining({ productId: 'P1', hsnCode: '071360' })]);
  });

  it('no HSN, or a blank one: absent — never a made-up code (the A1 checker then refuses the real-trading bill)', () => {
    expect(tillCatalogue(pack(' 071360 '), undefined, NOW)!.products[0]).toMatchObject({ hsnCode: '071360' });
    for (const p of [pack(), pack('   ')]) {
      expect(tillCatalogue(p, undefined, NOW)!.products[0]).not.toHaveProperty('hsnCode');
      expect((posPayload(screenInput({ pack: p })) as { products: object[] }).products[0]).not.toHaveProperty('hsnCode');
    }
  });
});

describe('3 · head office\'s settlement review matches a machine payment by its approval number', () => {
  it('the approval number is the key when the tender carries one; the provider reference otherwise; cash has none', () => {
    expect(settlementKeyOf({ ref: 'PAY-box-attempt-1', machineRef: 'A1B2C3' })).toBe('A1B2C3');
    expect(settlementKeyOf({ ref: 'tok_provider_1' })).toBe('tok_provider_1');
    expect(settlementKeyOf({})).toBeUndefined();
    // Hard rule #3: a card-shaped "approval number" is never a key — the tender falls back to its own reference.
    expect(settlementKeyOf({ ref: 'PAY-box-attempt-2', machineRef: CARD })).toBe('PAY-box-attempt-2');
  });

  it('ticked against the slip: matched; one with no slip line stays an exception; two payments with one number are ambiguous', () => {
    const tender = (id: string, t: { ref?: string; machineRef?: string }, amountMinor: number) => ({ id, ref: settlementKeyOf(t)!, amountMinor, capturedOn: '2026-10-20' });
    const review = reviewSettlement({
      tenders: [
        tender('S-1:t0', { ref: 'PAY-1', machineRef: 'A1B2C3' }, 10_500),
        tender('S-2:t0', { ref: 'PAY-2', machineRef: 'Z9Y8X7' }, 4_100),
        tender('S-3:t0', { ref: 'PAY-3', machineRef: 'DUP111' }, 2_000),
        tender('S-4:t0', { ref: 'PAY-4', machineRef: 'DUP111' }, 3_000),
      ],
      credits: [{ id: 'L1', ref: 'A1B2C3', amountMinor: 10_500 }, { id: 'L2', ref: 'DUP111', amountMinor: 2_000 }],
      settlementCycleDays: 0, asOf: '2026-10-22',
    });
    expect(review.matchedCount).toBe(1);
    expect(review.exceptions.map((e) => [e.finding, e.ref])).toEqual(expect.arrayContaining([['overdue_settlement', 'Z9Y8X7'], ['ambiguous_reference', 'DUP111']]));
    expect(review.exceptions.every((e) => e.ref !== 'A1B2C3')).toBe(true);
  });
});

describe('4 · an exchange in real trading: the replacement is charged its rounded bill, never refused for paise', () => {
  // A real-trading bill charged BELOW its lines: two ₹50.00 items at 5% — CGST and SGST are ₹2.38 each and round DOWN to ₹2
  // (OB-279), so the bill is ₹99.24 against lines of ₹100.00. And a bill whose total is its lines (₹100.00).
  const rounded = invoiceRoundOff([{ lineTotalMinor: 5_000, taxRateBps: 500 }, { lineTotalMinor: 5_000, taxRateBps: 500 }]);
  const below: OriginalSale = {
    saleId: 'S-1', number: 'R-1', tradingDay: '2026-10-21', committedAt: NOW, totalMinor: 10_000 + rounded.totalLessGoodsMinor,
    lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2, lineTotalMinor: 10_000 }] as never,
  };
  const exact: OriginalSale = { ...below, saleId: 'S-2', number: 'R-2', totalMinor: 10_000 };
  const back = (quantityMinor: number) => [{ productId: 'P1', uom: 'ea', quantityMinor, disposition: 'resell' as const }];
  const out = (unitPriceMinor: number) => [{ productId: 'P2', uom: 'ea', quantityMinor: 1, unitPriceMinor, lineTotalMinor: unitPriceMinor }];

  it('the bill below its lines is what the test means: charged less than its lines, by less than ₹1', () => {
    expect(rounded.totalLessGoodsMinor).toBe(-76);
    expect(below.totalMinor).toBe(9_924);
    expect(rounded.totalLessGoodsMinor).toBeGreaterThanOrEqual(-MAX_BILL_ROUND_OFF_MINOR);
  });

  it('the replacement is its lines plus its round off: the customer pays the bill, and the difference is worked out against it', () => {
    const a = assessExchange({ sale: exact, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-1', returnLines: back(1), replacementLines: out(10_000), replacementRoundOffMinor: -100 } });
    expect(a).toMatchObject({ ok: true, returnedValueMinor: 5_000, replacementTotalMinor: 9_900, balance: 'top_up', balanceMinor: 4_900, appliedMinor: 5_000 });
    const r = assessExchange({ sale: exact, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-2', returnLines: back(2), replacementLines: out(5_000), replacementRoundOffMinor: -40 } });
    expect(r).toMatchObject({ ok: true, returnedValueMinor: 10_000, replacementTotalMinor: 4_960, balance: 'refund', balanceMinor: 5_040, appliedMinor: 4_960 });
    // No round off (off real trading): exactly as before.
    expect(assessExchange({ sale: exact, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-3', returnLines: back(1), replacementLines: out(10_000) } }))
      .toMatchObject({ ok: true, replacementTotalMinor: 10_000, balanceMinor: 5_000 });
  });

  it('a round off above 0, beyond ₹1 or not whole is refused before anything is recorded', () => {
    for (const bad of [1, -101, -0.5, Number.NaN]) {
      expect(assessExchange({ sale: exact, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-4', returnLines: back(1), replacementLines: out(10_000), replacementRoundOffMinor: bad } }))
        .toMatchObject({ ok: false, refusedBecause: 'round_off_not_readable' });
    }
  });

  it('the whole of a bill charged below its lines comes back for what was PAID — never refused for the paise, never more than paid', () => {
    const all = assessExchange({ sale: below, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-5', returnLines: back(2), replacementLines: out(20_000) } });
    expect(all).toMatchObject({ ok: true, returnedValueMinor: below.totalMinor, balance: 'top_up', balanceMinor: 20_000 - below.totalMinor });
    // The last piece after one came back at its line price: what is left of the bill, not the line price.
    const first = assessExchange({ sale: below, priorReturns: [], priorRefunds: [], exchange: { exchangeId: 'X-6', returnLines: back(1), replacementLines: out(20_000) } });
    expect(first).toMatchObject({ ok: true, returnedValueMinor: 5_000 });
    const last = assessExchange({
      sale: below,
      priorReturns: [{ returnId: 'X-6', originalSaleId: 'S-1', lines: back(1) }] as never,
      priorRefunds: [{ returnId: 'X-6', originalSaleId: 'S-1', refundMinor: 5_000 }],
      exchange: { exchangeId: 'X-7', returnLines: back(1), replacementLines: out(20_000) },
    });
    expect(last).toMatchObject({ ok: true, returnedValueMinor: below.totalMinor - 5_000 });
  });

  it('more than the bill\'s own round off over what is left is still refused, as before', () => {
    // A bill charged below its lines takes back what was paid, and not a paisa beyond: past the round off, refused.
    expect(assessExchange({
      sale: below, priorReturns: [], priorRefunds: [{ returnId: 'RT-0', originalSaleId: 'S-1', refundMinor: 100 }],
      exchange: { exchangeId: 'X-9', returnLines: back(2), replacementLines: out(20_000) },
    })).toMatchObject({ ok: false, refusedBecause: 'refund_exceeds_what_is_left' });
    const refunded = assessExchange({
      sale: exact, priorReturns: [], priorRefunds: [{ returnId: 'RT-0', originalSaleId: 'S-2', refundMinor: 5_000 }],
      exchange: { exchangeId: 'X-8', returnLines: back(2), replacementLines: out(20_000) },
    });
    expect(refunded).toMatchObject({ ok: false, refusedBecause: 'refund_exceeds_what_is_left' });
  });
});
