import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { UnpaidSaleError } from '../../packages/sale/src/sale';
import { createRefundView } from '../../apps/pos/src/refund-view';
import { cashRoundOffMinor, cashToTakeMinor } from '../../packages/tender/src/cash-round-off';
import { buildReceipt, renderText, ReceiptTotalsError } from '../../packages/receipt/src/receipt';
import { commitReturn, ExcessRefundError } from '../../packages/returns/src/returns';
import { returnedValueAtOriginalPrices } from '../../packages/returns/src/exchange';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildDayBook, postDayBook, DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { cashIntoDrawer } from '../../edge/store-edge/src/till-cash';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';

/**
 * **OB-805 A (owner, 16 Nov 2026, in writing) · daily-work defect D-003 — a cash bill is rounded to the rupee, with a
 * "Round off" line on the bill.**
 *
 * D-003: a ₹303.50 cash bill always left the drawer short, because the blind count has no coin below ₹1. Now the cash taken
 * is the bill less its paise — DOWN only, because OB-285 (owner, in writing; Legal Metrology) says a customer never pays above
 * the goods' MRP-based total — and the bill records the paise as its round off (0 to −₹1, total = lines + round off), which
 * the store computer, head office and the day book already carry. The GST inside the lines does not move.
 *
 *   • the rule: .49 / .50 / .51 / .00 → −49 / −50 / −51 / 0 paise; nothing under ₹1 is rounded to nothing;
 *   • the till: a ₹303.50 cash bill takes ₹303.00 — the record's total, tender and round off, the bill's "Round off" line;
 *     card and UPI to the paisa; a split rounds only the cash that finishes the bill; the mirror pilot never rounds;
 *   • the drawer expects ₹303.00 (what the blind count can find); the day book posts the 50 paise to `round_off`, balanced;
 *   • a refund never pays back more than was taken: the bill's refunds stop at its ₹303.00.
 *
 * No network, no store computer: the till's own model with a stand-in durable write, and the pure engines. Synthetic data.
 */

const AT = '2026-11-16T10:00:00.000Z';
const saved: CommitOutcome = { committed: true, durable: true, detail: 'saved', laneMessage: 'Saved.' };
type Rec = { total: number; roundOffMinor?: number; netMinor: number; taxMinor: number; lines: { productId: string; quantityMinor: number; lineTotalMinor: number; taxRateBps: number }[]; tenders: { kind: string; amount: { minor: number } }[] };

function till(priceMinor = 30_350, extra: { mirrorPilot?: boolean } = {}) {
  const sent: Rec[] = [];
  const view = bootPos({
    laneId: 'lane-1', cashierId: 'u-meena', taxPercent: 5, ...extra,
    durable: async (_id, record) => { sent.push(JSON.parse(record) as Rec); return saved; },
  });
  view.scan({ productId: 'P1', description: 'Ponni rice 5kg', unitPriceMinor: priceMinor, qty: 1 });
  return { view, sent };
}

describe('the rule (packages/tender/src/cash-round-off.ts) — down only, never above the goods (OB-285)', () => {
  it('.49, .50, .51 and .00 lose their paise; a whole rupee is untouched', () => {
    expect(cashRoundOffMinor(30_349)).toBe(-49);
    expect(cashRoundOffMinor(30_350)).toBe(-50);
    expect(cashRoundOffMinor(30_351)).toBe(-51);
    expect(cashRoundOffMinor(30_300)).toBe(0);
    expect(cashToTakeMinor(30_350)).toBe(30_300);
    expect(cashToTakeMinor(30_399)).toBe(30_300);
  });

  it('never rounds up, and never rounds a cash amount under ₹1 away to nothing', () => {
    for (const due of [100, 101, 150, 199, 9_999, 30_350]) {
      expect(cashRoundOffMinor(due)).toBeLessThanOrEqual(0);
      expect(cashRoundOffMinor(due)).toBeGreaterThan(-100);
    }
    expect(cashRoundOffMinor(50)).toBe(0);
    expect(cashRoundOffMinor(0)).toBe(0);
    expect(cashRoundOffMinor(-50)).toBe(0);
    expect(cashRoundOffMinor(303.5)).toBe(0); // not a whole number of paise: nothing is guessed
  });
});

describe('the till rounds a CASH bill and records the round off', () => {
  it('₹303.50 in cash: ₹303.00 taken, the record says total ₹303.00 with round off −₹0.50, the GST inside the lines unchanged', async () => {
    const { view, sent } = till();
    expect(view.payableMinor()).toBe(30_350);
    expect(view.cashRoundOffMinor(view.payableMinor())).toBe(-50);
    await view.tenderCash('S-1', 'R-1', AT);
    const rec = sent[0]!;
    expect(rec.total).toBe(30_300);
    expect(rec.roundOffMinor).toBe(-50);
    expect(rec.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(30_350);
    expect(rec.netMinor + rec.taxMinor).toBe(30_350); // the GST is of the goods — the round off is not taxed
    expect(rec.tenders).toEqual([expect.objectContaining({ kind: 'cash', status: 'settled', amount: { minor: 30_300, currency: 'INR' } })]);
  });

  it('the bill prints "Round off -0.50" above a TOTAL of 303.00, and cash 303.00', async () => {
    const { view } = till();
    await view.tenderCash('S-1', 'R-1', AT);
    const bill = view.receiptLines();
    if (!bill.ok) throw new Error(bill.why);
    const text = bill.lines.join('\n');
    expect(text).toMatch(/^ {2}1 x 303\.50 +303\.50$/m);
    expect(text).toMatch(/^Round off +-0\.50$/m);
    expect(text).toMatch(/^TOTAL +303\.00$/m);
    expect(text).toMatch(/^cash +303\.00$/m);
    expect(text.indexOf('Round off')).toBeLessThan(text.indexOf('TOTAL'));
  });

  it('a whole-rupee cash bill has no round off at all', async () => {
    const { view, sent } = till(30_000);
    await view.tenderCash('S-1', 'R-1', AT);
    expect(sent[0]!.total).toBe(30_000);
    expect(sent[0]!.roundOffMinor).toBeUndefined();
    const bill = view.receiptLines();
    expect(bill.ok && bill.lines.join('\n')).not.toMatch(/Round off/);
  });

  it('card and UPI are never rounded: ₹303.50 is charged to the paisa', async () => {
    for (const kind of ['card', 'upi'] as const) {
      const { view, sent } = till();
      await view.tenderCardOrUpi({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, kind, outcome: 'approved', ref: 'att-1' });
      expect(sent[0]!.total).toBe(30_350);
      expect(sent[0]!.roundOffMinor).toBeUndefined();
    }
  });

  it('a split: cash that FINISHES the bill is rounded (card ₹100.00 + cash ₹203.00); cash first then card is taken as keyed', async () => {
    const finishes = till();
    await finishes.view.tenderSplit({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, parts: [{ kind: 'card', amountMinor: 10_000, ref: 'att-1' }, { kind: 'cash', amountMinor: 20_300 }] });
    expect(finishes.sent[0]).toMatchObject({ total: 30_300, roundOffMinor: -50 });
    expect(cashIntoDrawer(finishes.sent[0])).toBe(20_300);

    const cardLast = till();
    await cardLast.view.tenderSplit({ saleId: 'S-2', receiptNumber: 'R-2', atIsoUtc: AT, parts: [{ kind: 'cash', amountMinor: 5_000 }, { kind: 'card', amountMinor: 25_350, ref: 'att-2' }] });
    expect(cardLast.sent[0]!.total).toBe(30_350);
    expect(cardLast.sent[0]!.roundOffMinor).toBeUndefined();
  });

  it('a split short by a rupee or more is still unpaid — the round off is only ever the paise', async () => {
    const { view, sent } = till();
    await expect(view.tenderSplit({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, parts: [{ kind: 'cash', amountMinor: 30_000 }] })).rejects.toThrow(UnpaidSaleError);
    // With no cash among the tenders nothing is rounded: a card paying ₹303.00 of ₹303.50 is short.
    await expect(view.tenderSplit({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, parts: [{ kind: 'card', amountMinor: 30_300, ref: 'att-1' }] })).rejects.toThrow(UnpaidSaleError);
    expect(sent).toEqual([]);
  });

  it('the mirror pilot never rounds (no cash is taken there)', () => {
    const { view } = till(30_350, { mirrorPilot: true });
    expect(view.cashRoundOffMinor(30_350)).toBe(0);
  });
});

describe('the drawer, the day book and the refund carry it', () => {
  it('the drawer expects the ₹303.00 taken — what the blind count can find', async () => {
    const { view, sent } = till();
    await view.tenderCash('S-1', 'R-1', AT);
    expect(cashIntoDrawer(sent[0])).toBe(30_300);
  });

  it('the day book posts the 50 paise to round_off and balances: cash in hand ₹303.00, sales clearing nets to nil', () => {
    const sale = { saleId: 'S-1', tradingDay: '2026-11-16', totalMinor: 30_300, roundOffMinor: -50, lines: [{ productId: 'P1', quantityMinor: 1, lineTotalMinor: 30_350, taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: 30_300 }] };
    const book = buildDayBook({ tradingDay: '2026-11-16', sales: [sale], returns: [], originalSales: new Map(), taxRateOf: () => undefined, alreadyPosted: new Map() });
    expect(book.exceptions).toEqual([]);
    const posted = postDayBook(book, DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(posted.exceptions).toEqual([]);
    for (const j of posted.journals) expect(j.entry.balanced).toBe(true);
    const lines = posted.journals.flatMap((j) => j.entry.lines);
    const signed = (l: (typeof lines)[number]): number => (l.side === 'debit' ? l.amount.minor : -l.amount.minor);
    const balance = (account: string) => lines.filter((l) => l.account === account).reduce((n, l) => n + signed(l), 0);
    expect(balance('round_off')).toBe(50);
    expect(balance('cash_in_hand')).toBe(30_300);
    expect(balance('sales_clearing')).toBe(0);
    expect(lines.reduce((n, l) => n + signed(l), 0)).toBe(0);
  });

  it('a refund never pays back more than was taken: the whole bill refunds ₹303.00, not ₹303.50', () => {
    const sale = { saleId: 'S-1', number: 'R-1', tradingDay: '2026-11-16', committedAt: AT, totalMinor: 30_300, lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, lineTotalMinor: 30_350 }], tenders: [{ kind: 'cash', amountMinor: 30_300 }] };
    const view = createRefundView({ refund: async () => { throw new Error('not called'); }, now: () => AT, policy: { approvalThresholdMinor: 1_000_000 } });
    const ceiling = view.maxRefundMinor(sale);
    expect(ceiling).toBe(30_300);
    // What the till offers back for the line: its bill value, never above what is left of the bill (browser-entry `lineValueMinor`).
    expect(Math.min(ceiling, returnedValueAtOriginalPrices(sale, [{ productId: 'P1', quantityMinor: 1 }]))).toBe(30_300);
    const ledger = new Ledger(new InMemoryLedgerStore());
    expect(() => commitReturn({
      id: 'RT-1', number: 'RT-1', originalSaleId: 'S-1', processedAt: AT, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' }],
      refund: money(30_350, 'INR'), refundTender: 'cash', maxRefund: money(ceiling, 'INR'), approvalThresholdMinor: 1_000_000,
    }, ledger, new SyncOutbox())).toThrow(ExcessRefundError);
  });
});

describe('the printed bill checks its own sums with a round off', () => {
  const base = {
    number: 'R-1', saleId: 'S-1', tradingDay: '2026-11-16', committedAt: AT, laneId: 'lane-1', cashierId: 'u-meena', currency: 'INR' as const,
    lines: [{ description: 'Rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 30_350, lineTotalMinor: 30_350 }],
    taxBands: [{ rateBps: 500, netMinor: 28_905, taxMinor: 1_445 }], netMinor: 28_905, taxMinor: 1_445,
    tenders: [{ kind: 'cash', amountMinor: 30_300 }], pricesIncludeTax: true, header: [], footer: [],
  };
  it('lines + round off = total; net + GST = the lines', () => {
    expect(renderText(buildReceipt({ ...base, totalMinor: 30_300, roundOffMinor: -50 }))).toContain('Round off                            -0.50');
  });
  it('a round off that does not add up, or one above the lines, is refused', () => {
    expect(() => buildReceipt({ ...base, totalMinor: 30_300 })).toThrow(ReceiptTotalsError);
    expect(() => buildReceipt({ ...base, totalMinor: 30_400, roundOffMinor: 50 })).toThrow(ReceiptTotalsError);
    expect(() => buildReceipt({ ...base, totalMinor: 30_200, roundOffMinor: -150 })).toThrow(ReceiptTotalsError);
  });
});
