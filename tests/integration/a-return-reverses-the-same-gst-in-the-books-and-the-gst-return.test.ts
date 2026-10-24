import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, gstReturnsAdapter, dayBookAdapter } from '../../services/api/src/adapters';
import { buildDayBook, splitInclusive } from '../../packages/finance/src/index';

// WF-18 close check "Output GST" (the books against the GST return) found a real filing bug: the store acceptance journey's
// month read 7144 paise in the books against 7182 on GSTR-1. The 38 paise were ONE return — 1 rice (₹480, 5% GST) of a bill
// the member had partly paid with points. OB-34 "A" (owner, in writing): the points the return gives back are part of the
// returned goods' value, so the sales return reverses revenue AND GST on the whole ₹480. The day book did; GSTR-1's
// returns side allocated only the money refunded (₹472) and so reversed the tax on ₹472 — overstating output tax.
// The same gap swallowed an exchange's credit (refund 0 → nothing reversed on the return). Both sides now read one
// returned value. Synthetic data, real head-office adapters over the event store.

const T = 'tenant-gst-return-value';
const DAY = '2026-10-20';
const at = (h: number) => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;
const RICE = 48_000;
const TOMATO = 6_000;

async function shop(ret: Record<string, unknown>, givenBackMinor?: number): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  await store.append(T, STREAM.sales, makeEvent({
    id: 'sale-S-2', type: 'SaleCommitted', occurredAt: at(5), idempotencyKey: `sale-${T}-S-2`, source: 'test/gst',
    payload: {
      saleId: 'S-2', receiptNumber: 'R-2', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: at(5), totalMinor: RICE + TOMATO, currency: 'INR', packVersion: 1,
      lines: [
        { productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: RICE, lineTotalMinor: RICE, hsnCode: '1006', taxRateBps: 500 },
        { productId: 'p-tomato', quantityMinor: 1_500, uom: 'kg', unitPriceMinor: 4_000, lineTotalMinor: TOMATO, hsnCode: '0702', taxRateBps: 0 },
      ],
      tenders: [{ kind: 'loyalty_points', amountMinor: 900 }, { kind: 'cash', amountMinor: RICE + TOMATO - 900 }],
    },
  }));
  await store.append(T, STREAM.returns, makeEvent({
    id: `return-${String(ret['returnId'])}`, type: 'ReturnRecorded', occurredAt: at(8), idempotencyKey: `return-${T}-${String(ret['returnId'])}`, source: 'test/gst',
    payload: { number: String(ret['returnId']), originalSaleId: 'S-2', reasonCode: 'damaged', refundTender: 'cash', processedBy: 'u-cash', processedAt: at(8), approvalThresholdMinor: 0, lines: [{ productId: 'p-rice', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], ...ret },
  }));
  if (givenBackMinor !== undefined) {
    await store.append(T, streamName(STREAM.loyalty, 'sale', 'S-2'), makeEvent({
      id: `giveback-${String(ret['returnId'])}`, type: 'LoyaltyReturnGaveBack', occurredAt: at(8), idempotencyKey: `giveback-${T}-${String(ret['returnId'])}`, source: 'test/gst',
      payload: { returnId: ret['returnId'], memberRef: 'm-1', returnedValueMinor: RICE, points: givenBackMinor / 100, valueMinor: givenBackMinor },
    }));
  }
  return store;
}

/** The GST each side reverses for the day's returns: the GST return's returned lines, and the day book's sale_return voucher. */
async function bothSides(store: InMemoryEventStore) {
  const now = () => `${DAY}T23:00:00.000Z`;
  const lines = await gstReturnsAdapter({ store, now }).returnedTaxLines(T, `${DAY}T00:00:00.000Z`, `${DAY}T23:59:59.999Z`);
  const gstReturn = lines.reduce((s, l) => s + splitInclusive(l.lineTotalMinor, l.rateBps ?? 0).tax, 0);
  const db = dayBookAdapter({ store, now });
  const returns = await db.returnsOn(T, DAY);
  const originals = await db.originalSales(T, ['S-2']);
  const book = buildDayBook({ tradingDay: DAY, sales: [], returns, originalSales: originals, taxRateOf: () => undefined, alreadyPosted: new Map() });
  const voucher = book.aggregates.find((a) => a.kind === 'sale_return')!;
  return { lines, gstReturn, books: (voucher.components['cgst'] ?? 0) + (voucher.components['sgst'] ?? 0) };
}

describe('a return reverses the same output GST in the books and on the GST return (WF-18 · OB-34 "A" · CGST s.34)', () => {
  it('a return of goods partly paid with points: both reverse the GST on the WHOLE returned value (the 38 paise of the acceptance journey)', async () => {
    // ₹480 of rice comes back: ₹472 in cash (the money share) and ₹8 of points given back to the member.
    const store = await shop({ returnId: 'RT-1', refundMinor: 47_200 }, 800);
    const { lines, gstReturn, books } = await bothSides(store);
    expect(lines.map((l) => [l.productId, l.lineTotalMinor, l.rateBps])).toEqual([['p-rice', RICE, 500]]);
    expect(books).toBe(splitInclusive(RICE, 500).tax);
    expect(gstReturn).toBe(books);
    // Before the fix the GST return reversed only the money share — 38 paise less tax than the books.
    expect(splitInclusive(RICE, 500).tax - splitInclusive(47_200, 500).tax).toBe(38);
  });

  it('an exchange: the credit applied to the replacement is reversed on both sides, not only a refunded balance', async () => {
    const store = await shop({ returnId: 'RT-2', refundMinor: 0, exchange: { exchangeId: 'X-1', replacementSaleId: 'S-9', replacementTotalMinor: RICE, appliedMinor: RICE, balance: 'even', balanceMinor: 0 } });
    const { lines, gstReturn, books } = await bothSides(store);
    expect(lines.map((l) => l.lineTotalMinor)).toEqual([RICE]);
    expect(gstReturn).toBe(books);
    expect(books).toBe(splitInclusive(RICE, 500).tax);
  });

  it('a plain cash refund is unchanged: the refund is the returned value on both sides', async () => {
    const store = await shop({ returnId: 'RT-3', refundMinor: RICE });
    const { lines, gstReturn, books } = await bothSides(store);
    expect(lines.map((l) => l.lineTotalMinor)).toEqual([RICE]);
    expect(gstReturn).toBe(books);
  });
});
