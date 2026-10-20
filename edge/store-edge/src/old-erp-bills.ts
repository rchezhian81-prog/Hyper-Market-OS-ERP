// OB-264 — the store computer's register of the old ERP's bill numbers keyed on mirror-pilot sales.
//
// Built once at start from this box's own sale and refund logs, then told of every sale and refund it writes after that,
// so the check made on EVERY mirror sale ("is this old bill number already keyed?") is a look in memory, never a read of
// the whole log on the sale path (hard rule #1: nothing slow, nothing on the network). The rules are the pure ones in
// `packages/tender/src/old-erp-bill-number.ts`; this only holds the facts they are judged over:
//
//   • a sale with an old bill number: its id, new bill number, trading day and total;
//   • every refund against one of those sales (by `originalSaleId`), counted once per return id, so a sale whose whole
//     value has come back no longer holds its number (a bill keyed wrongly can be refunded and keyed again).
//
// `serialise` runs one mirror sale's check-and-write at a time, so two tills keying the same old bill number at the same
// moment cannot both pass the check before either is on the disk.

import {
  isOldErpBillNumber, oldErpBillRepeatRefusal, saleForOldErpBill, type OldErpBillRefused, type OldErpBillSale,
} from '../../../packages/tender/src/old-erp-bill-number';

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface OldErpBills {
  /** May this sale carry this old bill number? `undefined` = yes; otherwise the refusal, in words. */
  check(input: { readonly saleId: string; readonly oldErpBillNumber: string; readonly tradingDay: string }): OldErpBillRefused | undefined;
  /** A sale record now on the disk (one without an old bill number is ignored). */
  noteSale(record: unknown): void;
  /** A refund record now on the disk (counted against its original sale, once per return id). */
  noteReturn(record: unknown): void;
  /** The sale id a mirror refund is against, found by the old bill number on the customer's bill. */
  find(oldErpBillNumber: string): string | undefined;
  /** Every sale that carries an old bill number, in the order written. */
  bills(): readonly OldErpBillSale[];
  /** Run one check-and-write at a time. */
  serialise<T>(work: () => Promise<T>): Promise<T>;
}

export function openOldErpBills(saleRecords: readonly string[], returnRecords: readonly string[]): OldErpBills {
  const sales: { saleId: string; number: string; tradingDay: string; totalMinor: number; oldErpBillNumber: string }[] = [];
  const bySaleId = new Map<string, number>();
  const refunded = new Map<string, number>();
  const returnsSeen = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();

  const noteSale = (record: unknown): void => {
    const r = asRec(record);
    const saleId = str(r['id']) ?? str(r['saleId']);
    const oldBill = r['oldErpBillNumber'];
    if (saleId === undefined || !isOldErpBillNumber(oldBill) || bySaleId.has(saleId)) return;
    bySaleId.set(saleId, sales.length);
    sales.push({
      saleId, number: str(r['receiptNumber']) ?? str(r['number']) ?? saleId, tradingDay: str(r['tradingDay']) ?? '',
      totalMinor: int(r['total']) ?? int(r['totalMinor']) ?? 0, oldErpBillNumber: oldBill,
    });
  };
  const noteReturn = (record: unknown): void => {
    const r = asRec(record);
    const returnId = str(r['returnId']) ?? str(r['id']);
    const original = str(r['originalSaleId']);
    if (returnId === undefined || original === undefined || returnsSeen.has(returnId)) return;
    returnsSeen.add(returnId);
    refunded.set(original, (refunded.get(original) ?? 0) + Math.abs(int(r['refundMinor']) ?? 0));
  };
  const parse = (raw: string): unknown => { try { return JSON.parse(raw) as unknown; } catch { return undefined; } };
  for (const raw of saleRecords) noteSale(parse(raw));
  for (const raw of returnRecords) noteReturn(parse(raw));

  const bills = (): readonly OldErpBillSale[] => sales.map((s) => ({ ...s, refundedMinor: refunded.get(s.saleId) ?? 0 }));

  return {
    check: ({ saleId, oldErpBillNumber, tradingDay }) => oldErpBillRepeatRefusal({ oldErpBillNumber, saleId, tradingDay, sales: bills() }),
    noteSale,
    noteReturn,
    find: (oldErpBillNumber) => saleForOldErpBill(oldErpBillNumber, bills())?.saleId,
    bills,
    serialise: <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work, work);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
