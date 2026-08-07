import { describe, it, expect } from 'vitest';
import {
  returnRegister, returnableLines, overReturned, alreadyRefundedMinor,
  type OriginalSale, type RecordedReturn,
} from '../../packages/returns/src/index';

/**
 * **The producer that made the at-most-once rule real (M13-FR-01).**
 *
 * `commitReturn` has enforced *a line is returned at most once* since the day it was written, and
 * it enforces it against `alreadyReturnedMinor` — supplied by the caller. Outside one unit test,
 * nothing in this system ever supplied it, so every return in the running product was judged
 * against **nothing already returned**. The same receipt could be refunded today, again tomorrow,
 * and again the day after, each refund passing a rule written specifically to stop it.
 *
 * This is that producer. Its job is arithmetic, and the arithmetic is money.
 */

const SALE: OriginalSale = {
  saleId: 'S-1', number: 'R-1001', tradingDay: '2026-08-01',
  committedAt: '2026-08-01T10:00:00.000Z', totalMinor: 500_00,
  lines: [
    { productId: 'p1', uom: 'ea', quantityMinor: 3 },
    { productId: 'p2', uom: 'kg', quantityMinor: 1_500 },
  ],
  tenders: [{ kind: 'card', amountMinor: 500_00 }],
};

const ret = (over: Partial<RecordedReturn> = {}): RecordedReturn => ({
  returnId: 'RT-1', originalSaleId: 'S-1', processedAt: '2026-08-02T10:00:00.000Z',
  lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 1 }],
  ...over,
});

describe('what has already come back off a bill', () => {
  it('is nothing at all when nothing has come back', () => {
    const lines = returnableLines(SALE, returnRegister([]));
    expect(lines.find((l) => l.productId === 'p1')).toEqual({
      productId: 'p1', uom: 'ea', soldMinor: 3, alreadyReturnedMinor: 0, returnableMinor: 3,
    });
  });

  it('subtracts what came back, so the second return cannot repeat the first', () => {
    const lines = returnableLines(SALE, returnRegister([ret()]));
    const p1 = lines.find((l) => l.productId === 'p1')!;
    expect(p1.alreadyReturnedMinor).toBe(1);
    expect(p1.returnableMinor).toBe(2);
  });

  it('leaves nothing returnable once the whole line has come back', () => {
    const all = ret({ lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }] });
    expect(returnableLines(SALE, returnRegister([all])).find((l) => l.productId === 'p1')?.returnableMinor)
      .toBe(0);
  });

  it('adds up several returns against the same bill', () => {
    const register = returnRegister([
      ret({ returnId: 'RT-1' }),
      ret({ returnId: 'RT-2' }),
    ]);
    expect(returnableLines(SALE, register).find((l) => l.productId === 'p1')?.returnableMinor).toBe(1);
  });

  it('counts the SAME return once, however many sources carried it', () => {
    // The box's own log and the cloud's history overlap by design. Double-counting the overlap
    // would refuse a second, legitimate return of a different unit — a customer turned away at the
    // desk over a bookkeeping artefact, which is the failure people remember.
    const register = returnRegister([ret(), ret(), ret()]);
    expect(returnableLines(SALE, register).find((l) => l.productId === 'p1')?.alreadyReturnedMinor)
      .toBe(1);
  });

  it('keeps one bill’s returns away from another’s', () => {
    const other = ret({ returnId: 'RT-9', originalSaleId: 'S-2', lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 3 }] });
    expect(returnableLines(SALE, returnRegister([other])).find((l) => l.productId === 'p1')?.returnableMinor)
      .toBe(3);
  });

  it('ignores a no-receipt return, which is against no bill at all', () => {
    // It is capped by value instead — there is no line to count it against.
    const noReceipt = ret({ returnId: 'RT-NR', originalSaleId: null });
    expect(returnRegister([noReceipt]).size).toBe(0);
  });

  it('sums two lines of the SAME product into one entry', () => {
    // A bill can carry one product on two lines — two scans of the same tin. Matching a return to
    // a line INDEX would then let "line 2" be returned twice while "line 1" is untouched.
    const twice: OriginalSale = {
      ...SALE,
      lines: [
        { productId: 'p1', uom: 'ea', quantityMinor: 2 },
        { productId: 'p1', uom: 'ea', quantityMinor: 2 },
      ],
    };
    const lines = returnableLines(twice, returnRegister([]));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.soldMinor).toBe(4);
  });

  it('takes a quantity as its magnitude, whichever sign it was written with', () => {
    const negative = ret({ lines: [{ productId: 'p1', uom: 'ea', quantityMinor: -2 }] });
    expect(returnableLines(SALE, returnRegister([negative])).find((l) => l.productId === 'p1')?.returnableMinor)
      .toBe(1);
  });

  it('never offers a negative quantity to return', () => {
    // More has come back than went out, which should be impossible. Whatever went wrong, a
    // negative arriving at `commitReturn` is arithmetic nobody could explain.
    const tooMuch = ret({ lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 5 }] });
    expect(returnableLines(SALE, returnRegister([tooMuch])).find((l) => l.productId === 'p1')?.returnableMinor)
      .toBe(0);
  });

  it('surfaces the impossible case rather than quietly clamping it away', () => {
    // It means a return went against the wrong bill, or the same goods were refunded twice before
    // this register existed. Both are money, and both need a person to look.
    const tooMuch = ret({ lines: [{ productId: 'p1', uom: 'ea', quantityMinor: 5 }] });
    expect(overReturned(SALE, returnRegister([tooMuch]))).toEqual([
      { productId: 'p1', soldMinor: 3, returnedMinor: 5 },
    ]);
    expect(overReturned(SALE, returnRegister([]))).toEqual([]);
  });
});

describe('what has already gone back in money', () => {
  const refund = (returnId: string, refundMinor: number, originalSaleId: string | null = 'S-1') =>
    ({ returnId, originalSaleId, refundMinor });

  it('is nothing when nothing has been refunded', () => {
    expect(alreadyRefundedMinor('S-1', [])).toBe(0);
  });

  it('adds up the refunds against one bill and no others', () => {
    expect(alreadyRefundedMinor('S-1', [
      refund('RT-1', 100_00), refund('RT-2', 50_00), refund('RT-3', 900_00, 'S-2'),
    ])).toBe(150_00);
  });

  it('counts the same refund once', () => {
    expect(alreadyRefundedMinor('S-1', [refund('RT-1', 100_00), refund('RT-1', 100_00)])).toBe(100_00);
  });

  it('is a different guard from the line one, and catches what it cannot', () => {
    // A discounted bill: three items sold, ₹500 paid. Return one item and refund ₹400, then
    // return another and refund ₹400. The LINE rule is satisfied both times — different units —
    // and the shop has refunded ₹800 against a ₹500 bill.
    expect(alreadyRefundedMinor('S-1', [refund('RT-1', 400_00)])).toBe(400_00);
    expect(SALE.totalMinor - alreadyRefundedMinor('S-1', [refund('RT-1', 400_00)])).toBe(100_00);
  });

  it('takes a refund as its magnitude, whichever sign it was written with', () => {
    expect(alreadyRefundedMinor('S-1', [refund('RT-1', -100_00)])).toBe(100_00);
  });
});
