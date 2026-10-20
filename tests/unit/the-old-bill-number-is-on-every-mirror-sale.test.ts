import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import {
  OLD_ERP_BILL_MAX, OLD_ERP_BILL_WORDS, financialYearOf, isOldErpBillNumber, oldErpBillHolder, oldErpBillRefusal, oldErpBillRepeatRefusal,
  oldErpBillRepeatedWords, readOldErpBillNumber, saleForOldErpBill, type OldErpBillSale,
} from '../../packages/tender/src/old-erp-bill-number';
import { GST_INVOICE_NUMBER_MAX } from '../../packages/contracts/src/receipt-number';
import { openOldErpBills } from '../../edge/store-edge/src/old-erp-bills';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { migrationPayload, MIRROR_BILLS_SHOWN } from '../../edge/store-edge/src/screen-data';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { oldErpBillsOf } from '../../services/finance/src/day-book';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';
import type { SaleLookupResult } from '../../edge/store-edge/src/receipt-lookup';

/**
 * **OB-264 (owner, 20 Oct 2026, "Key old bill number") — the old ERP's bill number on every mirror-pilot sale.** The
 * rules once (`packages/tender/src/old-erp-bill-number.ts`), the store computer's register of them
 * (`edge/store-edge/src/old-erp-bills.ts`), the till's own check before its disk, and the number on its way to head
 * office, the day book and the evening check's bill-wise list. No network: pure engines and the till's model with a
 * stand-in disk.
 *
 *   • required on every mirror sale, refused outside the mirror pilot;
 *   • Rule 46(b) shape: at most 16 letters, digits, "-" and "/", kept in capitals;
 *   • never personal data: a mobile, Aadhaar or card-shaped number is refused;
 *   • keyed twice in one financial year → REFUSED (hard rule #10), unless the first sale's whole value came back.
 */

const AT = '2026-10-20T10:00:00.000Z';
const saved: CommitOutcome = { committed: true, durable: true, detail: 'saved', laneMessage: 'Saved.' };
const bill = (over: Partial<OldErpBillSale> = {}): OldErpBillSale => ({ saleId: 'S-A', number: 'ZZ000001', tradingDay: '2026-10-20', totalMinor: 21_000, refundedMinor: 0, oldErpBillNumber: 'OLD/1', ...over });

describe('what an old bill number may be (Rule 46(b), no personal data)', () => {
  it('is the GST invoice number\'s own bound — 16 characters', () => {
    expect(OLD_ERP_BILL_MAX).toBe(GST_INVOICE_NUMBER_MAX);
  });

  it('kept trimmed, in capitals: letters, digits, "-" and "/"', () => {
    for (const [typed, kept] of [['12345', '12345'], ['  sre/24-25/0012 ', 'SRE/24-25/0012'], ['a1', 'A1'], ['2024-123456', '2024-123456'], ['1234567890', '1234567890'], ['X'.repeat(16), 'X'.repeat(16)]] as const) {
      expect(readOldErpBillNumber(typed), typed).toEqual({ ok: true, value: kept });
    }
  });

  it('refused, with the reason in words: missing, too long, other characters', () => {
    expect(readOldErpBillNumber('')).toMatchObject({ ok: false, refusedBecause: 'old_bill_missing', laneMessage: OLD_ERP_BILL_WORDS.missing });
    expect(readOldErpBillNumber('   ')).toMatchObject({ ok: false, refusedBecause: 'old_bill_missing' });
    expect(readOldErpBillNumber(undefined)).toMatchObject({ ok: false, refusedBecause: 'old_bill_missing' });
    expect(readOldErpBillNumber(12345)).toMatchObject({ ok: false, refusedBecause: 'old_bill_missing' });
    for (const bad of ['X'.repeat(17), 'SRE 12', 'SRE#12', 'a@b.in', '12.5', 'பில்1', 'OLD\\1', '+919']) {
      expect(readOldErpBillNumber(bad), bad).toMatchObject({ ok: false, refusedBecause: 'old_bill_not_valid', laneMessage: OLD_ERP_BILL_WORDS.notValid });
    }
  });

  it('never a phone, Aadhaar or card number — refused before anything is kept', () => {
    for (const personal of ['9876543210', '98765-43210', '09876543210', '919876543210', '123456789012', '4111111111111111', '1234-5678-9012', '4111-1111-1111-1111']) {
      expect(readOldErpBillNumber(personal), personal).toMatchObject({ ok: false, refusedBecause: 'old_bill_looks_personal', laneMessage: OLD_ERP_BILL_WORDS.looksPersonal });
    }
  });

  it('a record carries it only in its kept form', () => {
    expect(isOldErpBillNumber('SRE/12')).toBe(true);
    expect(isOldErpBillNumber('sre/12')).toBe(false);
    expect(isOldErpBillNumber(' SRE/12')).toBe(false);
    expect(isOldErpBillNumber('9876543210')).toBe(false);
    expect(isOldErpBillNumber(undefined)).toBe(false);
  });
});

describe('on a sale record: required in the mirror pilot, refused outside it', () => {
  it('mirror ON: required, in its kept form', () => {
    expect(oldErpBillRefusal({ mirrorOn: true, value: 'OLD/1' })).toBeUndefined();
    expect(oldErpBillRefusal({ mirrorOn: true, value: undefined })).toMatchObject({ refusedBecause: 'old_bill_missing' });
    expect(oldErpBillRefusal({ mirrorOn: true, value: 'old/1' })).toMatchObject({ refusedBecause: 'old_bill_not_valid' });
    expect(oldErpBillRefusal({ mirrorOn: true, value: '9876543210' })).toMatchObject({ refusedBecause: 'old_bill_looks_personal' });
  });

  it('mirror OFF: none, and one sent is refused in words', () => {
    expect(oldErpBillRefusal({ mirrorOn: false, value: undefined })).toBeUndefined();
    expect(oldErpBillRefusal({ mirrorOn: false, value: 'OLD/1' })).toMatchObject({ refusedBecause: 'old_bill_not_on', laneMessage: OLD_ERP_BILL_WORDS.notOn });
  });
});

describe('keyed twice → refused (hard rule #10), within one financial year (Rule 46(b))', () => {
  it('the Indian financial year runs 1 April to 31 March', () => {
    expect(financialYearOf('2026-03-31')).toBe('2025-26');
    expect(financialYearOf('2026-04-01')).toBe('2026-27');
    expect(financialYearOf('2099-12-31')).toBe('2099-00');
    expect(financialYearOf('not a day')).toBeUndefined();
  });

  it('another live sale this year holds it → refused, naming the new bill that holds it; a re-send of the same sale is the same sale', () => {
    const sales = [bill()];
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/1', saleId: 'S-B', tradingDay: '2026-11-02', sales })?.saleId).toBe('S-A');
    expect(oldErpBillRepeatRefusal({ oldErpBillNumber: 'OLD/1', saleId: 'S-B', tradingDay: '2026-11-02', sales })).toEqual({ refusedBecause: 'old_bill_repeated', laneMessage: oldErpBillRepeatedWords('OLD/1', 'ZZ000001') });
    expect(oldErpBillRepeatedWords('OLD/1', 'ZZ000001')).toBe('Old bill number OLD/1 is already keyed on another sale (new bill ZZ000001). Check the number on the old bill. If it is right, this bill was already keyed — do not key it twice. Nothing was saved.');
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/1', saleId: 'S-A', tradingDay: '2026-10-20', sales })).toBeUndefined();
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/2', saleId: 'S-B', tradingDay: '2026-10-20', sales })).toBeUndefined();
  });

  it('a new financial year starts the old ERP\'s series again: the same number then is a different bill', () => {
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/1', saleId: 'S-B', tradingDay: '2027-04-01', sales: [bill({ tradingDay: '2027-03-31' })] })).toBeUndefined();
  });

  it('a sale whose whole value came back no longer holds it (a bill keyed wrongly is refunded and keyed again); a part refund still holds it', () => {
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/1', saleId: 'S-B', tradingDay: '2026-10-20', sales: [bill({ refundedMinor: 21_000 })] })).toBeUndefined();
    expect(oldErpBillHolder({ oldErpBillNumber: 'OLD/1', saleId: 'S-B', tradingDay: '2026-10-20', sales: [bill({ refundedMinor: 10_500 })] })?.saleId).toBe('S-A');
  });

  it('a mirror refund finds the sale that still holds it; when every one was refunded, the latest (so the till can say nothing is left)', () => {
    const first = bill({ saleId: 'S-A', refundedMinor: 21_000 });
    const second = bill({ saleId: 'S-B', number: 'ZZ000002' });
    expect(saleForOldErpBill('OLD/1', [first, second])?.saleId).toBe('S-B');
    expect(saleForOldErpBill('OLD/1', [first])?.saleId).toBe('S-A');
    expect(saleForOldErpBill('OLD/9', [first, second])).toBeUndefined();
  });
});

describe("the store computer's register, from its own logs (edge/store-edge/src/old-erp-bills.ts)", () => {
  const saleRec = (id: string, oldBill: unknown, total = 21_000, tradingDay = '2026-10-20') => JSON.stringify({ id, number: `N-${id}`, tradingDay, total, ...(oldBill === undefined ? {} : { oldErpBillNumber: oldBill }) });
  const returnRec = (returnId: string, originalSaleId: string, refundMinor: number) => JSON.stringify({ returnId, originalSaleId, refundMinor });

  it('rebuilt at start: sales with a kept old bill number, refunds counted once per return id; a torn line or a bad number is skipped', () => {
    const bills = openOldErpBills(
      [saleRec('S-1', 'OLD/1'), '{"id":"S-x', saleRec('S-2', 'old/2'), saleRec('S-3', undefined), saleRec('S-4', 'OLD/4'), saleRec('S-1', 'OLD/1')],
      [returnRec('RT-1', 'S-1', 10_500), returnRec('RT-1', 'S-1', 10_500), returnRec('RT-2', 'S-4', 21_000), 'not json'],
    );
    expect(bills.bills()).toEqual([
      { saleId: 'S-1', number: 'N-S-1', tradingDay: '2026-10-20', totalMinor: 21_000, refundedMinor: 10_500, oldErpBillNumber: 'OLD/1' },
      { saleId: 'S-4', number: 'N-S-4', tradingDay: '2026-10-20', totalMinor: 21_000, refundedMinor: 21_000, oldErpBillNumber: 'OLD/4' },
    ]);
    expect(bills.find('OLD/1')).toBe('S-1');
    expect(bills.check({ saleId: 'S-9', oldErpBillNumber: 'OLD/1', tradingDay: '2026-10-21' })).toMatchObject({ refusedBecause: 'old_bill_repeated' });
    // S-4 came back whole: its number is free again.
    expect(bills.check({ saleId: 'S-9', oldErpBillNumber: 'OLD/4', tradingDay: '2026-10-21' })).toBeUndefined();
  });

  it('told of each sale and refund it writes after that', () => {
    const bills = openOldErpBills([], []);
    expect(bills.check({ saleId: 'S-1', oldErpBillNumber: 'OLD/7', tradingDay: '2026-10-20' })).toBeUndefined();
    bills.noteSale(JSON.parse(saleRec('S-1', 'OLD/7')));
    expect(bills.check({ saleId: 'S-2', oldErpBillNumber: 'OLD/7', tradingDay: '2026-10-20' })?.refusedBecause).toBe('old_bill_repeated');
    bills.noteReturn(JSON.parse(returnRec('RT-1', 'S-1', 21_000)));
    expect(bills.check({ saleId: 'S-2', oldErpBillNumber: 'OLD/7', tradingDay: '2026-10-20' })).toBeUndefined();
    bills.noteSale(JSON.parse(saleRec('S-2', 'OLD/7')));
    expect(bills.find('OLD/7')).toBe('S-2');
  });

  it('one check-and-write at a time, in order, and a failed one does not stop the next', async () => {
    const bills = openOldErpBills([], []);
    const order: string[] = [];
    const slow = bills.serialise(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('first'); throw new Error('disk'); });
    const fast = bills.serialise(async () => { order.push('second'); return 2; });
    await expect(slow).rejects.toThrow('disk');
    expect(await fast).toBe(2);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('the till: asked before "Paid on old system", judged before its disk, on the sale record', () => {
  const till = (mirrorPilot: boolean, lookupByOldBill?: (oldBill: string) => Promise<SaleLookupResult | null>) => {
    const sent: string[] = [];
    const view = bootPos({
      laneId: 'lane-1', cashierId: 'u-meena', taxPercent: 5, guestSalesOnly: true, ...(mirrorPilot ? { mirrorPilot: true } : {}),
      durable: async (_id, record) => { sent.push(record); return saved; },
      ...(lookupByOldBill === undefined ? {} : { laneLookupByOldBill: lookupByOldBill }),
    });
    view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 2 });
    return { view, sent };
  };

  it('mirror ON: none, or one not in its kept form, is refused before the disk; a good one is on the record', async () => {
    const { view, sent } = till(true);
    await expect(view.tenderPaidOnOldErp('S-1', 'R-1', AT)).rejects.toMatchObject({ name: 'LocalCommitRefusedError', laneMessage: OLD_ERP_BILL_WORDS.missing });
    await expect(view.tenderPaidOnOldErp('S-1', 'R-1', AT, '9876543210')).rejects.toMatchObject({ laneMessage: OLD_ERP_BILL_WORDS.looksPersonal });
    await expect(view.tenderPaidOnOldErp('S-1', 'R-1', AT, 'sre/12')).rejects.toMatchObject({ laneMessage: OLD_ERP_BILL_WORDS.notValid });
    expect(sent).toEqual([]);
    // The screen reads what was typed first (capitals, trimmed), then hands the kept form over.
    const read = view.readOldBill('  sre/12 ');
    expect(read).toEqual({ ok: true, value: 'SRE/12' });
    expect(view.readOldBill('98765 43210')).toMatchObject({ ok: false, refusedBecause: 'old_bill_looks_personal' });
    expect(view.readOldBill('SRE 12')).toMatchObject({ ok: false, refusedBecause: 'old_bill_not_valid' });
    expect(await view.tenderPaidOnOldErp('S-1', 'R-1', AT, 'SRE/12')).toBe('R-1');
    expect(JSON.parse(sent[0]!)).toMatchObject({ id: 'S-1', oldErpBillNumber: 'SRE/12', tenders: [{ kind: 'paid_on_old_erp' }] });
  });

  it('mirror OFF: no old bill number on any sale', async () => {
    const { view, sent } = till(false);
    expect(await view.tenderCash('S-1', 'R-1', AT)).toBe('R-1');
    expect(JSON.parse(sent[0]!)['oldErpBillNumber']).toBeUndefined();
  });

  it('a mirror refund asks the store computer for the sale by the old bill number — in its kept form — and the refund rules then apply', async () => {
    const asked: string[] = [];
    const found: SaleLookupResult = {
      sale: { saleId: 'S-1', number: 'ZZ000001', tradingDay: '2026-10-20', committedAt: AT, totalMinor: 21_000, lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }], tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }] },
      returns: [], refunds: [],
    };
    const { view } = till(true, async (oldBill) => { asked.push(oldBill); return oldBill === 'SRE/12' ? found : null; });
    const refund = await view.lookupRefundByOldBill(' sre/12');
    expect(asked).toEqual(['SRE/12']);
    expect(refund?.sale).toEqual({ saleId: 'S-1', number: 'ZZ000001', totalMinor: 21_000 });
    expect(refund?.maxRefundMinor).toBe(21_000);
    expect(refund?.returnable).toEqual([expect.objectContaining({ productId: 'P1', returnableMinor: 2 })]);
    expect(await view.lookupRefundByOldBill('SRE/13')).toBeNull();
    // Not an old bill number at all: nothing is asked.
    expect(await view.lookupRefundByOldBill('9876543210')).toBeNull();
    expect(asked).toEqual(['SRE/12', 'SRE/13']);
  });
});

describe('on its way: head office, the day book, the evening check', () => {
  it('the store computer sends it to head office in its kept form only', () => {
    const rec = { id: 'S-1', number: 'R-1', total: 100, tenders: [], lines: [] };
    expect(toCloudSale({ ...rec, oldErpBillNumber: 'SRE/12' }, 3).oldErpBillNumber).toBe('SRE/12');
    expect(toCloudSale({ ...rec, oldErpBillNumber: '9876543210' }, 3).oldErpBillNumber).toBeUndefined();
    expect('oldErpBillNumber' in toCloudSale(rec, 3)).toBe(false);
  });

  it('the day book lists each voucher\'s old bill numbers: a sale\'s own, a refund\'s from its sale', () => {
    const sales = [
      { saleId: 'S-1', tradingDay: '2026-10-20', totalMinor: 100, lines: [], tenders: [], oldErpBillNumber: 'OLD/1' },
      { saleId: 'S-2', tradingDay: '2026-10-20', totalMinor: 100, lines: [], tenders: [] },
    ];
    expect(oldErpBillsOf('sale', ['S-1', 'S-2'], sales, [], new Map())).toEqual([{ sourceId: 'S-1', oldErpBillNumber: 'OLD/1' }]);
    expect(oldErpBillsOf('sale', ['S-2'], sales, [], new Map())).toBeUndefined();
    const returns = [{ returnId: 'RT-1', originalSaleId: 'S-0', refundMinor: 50, refundTender: 'paid_on_old_erp', lines: [] }];
    const originals = new Map([['S-0', { saleId: 'S-0', tradingDay: '2026-10-19', totalMinor: 100, lines: [], tenders: [], oldErpBillNumber: 'OLD/0' }]]);
    expect(oldErpBillsOf('return', ['RT-1'], [], returns, originals)).toEqual([{ sourceId: 'RT-1', oldErpBillNumber: 'OLD/0' }]);
  });

  it('the evening check\'s bill-wise list: only in the mirror pilot, from the box\'s register, with what came back', () => {
    const base = { pack: { ...emptyPack(), migrationPolicy: { known: true as const, value: { cutoverId: 'CUT-1', requiredCleanDays: 3 } } }, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-10-20' };
    const bills = [bill({ refundedMinor: 10_500 }), bill({ saleId: 'S-B', number: 'ZZ000002', oldErpBillNumber: 'OLD/2', tradingDay: '2026-10-19' })];
    const on = migrationPayload({ ...base, mirrorPilot: { on: true, by: 'store_computer_setting' }, oldErpBills: bills } as never)!;
    expect(on['mirrorBills']).toEqual({
      tradingDay: '2026-10-20', truncated: false,
      bills: [
        { number: 'ZZ000001', oldErpBillNumber: 'OLD/1', tradingDay: '2026-10-20', totalMinor: 21_000, refundedMinor: 10_500 },
        { number: 'ZZ000002', oldErpBillNumber: 'OLD/2', tradingDay: '2026-10-19', totalMinor: 21_000, refundedMinor: 0 },
      ],
    });
    expect(migrationPayload({ ...base, mirrorPilot: { on: false, by: null }, oldErpBills: bills } as never)!['mirrorBills']).toBeUndefined();
    const many = Array.from({ length: MIRROR_BILLS_SHOWN + 1 }, (_, i) => bill({ saleId: `S-${i}`, oldErpBillNumber: `OLD/${i}` }));
    const capped = migrationPayload({ ...base, mirrorPilot: { on: true, by: 'store_pack' }, oldErpBills: many } as never)!['mirrorBills'] as { truncated: boolean; bills: unknown[] };
    expect(capped.truncated).toBe(true);
    expect(capped.bills).toHaveLength(MIRROR_BILLS_SHOWN);
  });
});
