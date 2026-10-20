import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { LocalCommitRefusedError } from '../../apps/pos/src/session';
import { LocalRefundRefusedError } from '../../apps/pos/src/till-session';
import { refundOutcomeOf } from '../../apps/pos/src/refund-view';
import { money } from '../../packages/contracts/src/money';
import { TENDER_KINDS, isTenderKind } from '../../packages/contracts/src/enums';
import {
  PAID_ON_OLD_ERP, PAID_ON_OLD_ERP_WORDS, saleTenderRefusal, refundTenderRefusal, paidOnOldErpRoom,
} from '../../packages/tender/src/paid-on-old-erp';
import { settle } from '../../packages/tender/src/tender';
import { withoutCardData } from '../../packages/tender/src/tender-card-data';
import { commitReturn, type CommitReturnInput } from '../../packages/returns/src/returns';
import { assessReturn } from '../../packages/returns/src/assess-return';
import { refundChannel, ELECTRONIC_TENDERS } from '../../packages/returns/src/refund-channel';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { buildDayBook, postDayBook, DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { SUGGESTED_ACCOUNT_CLASSES } from '../../services/finance/src/period-books';
import { tenderSplit, salesSummary } from '../../packages/reporting/src/sales-summary';
import { cashIntoDrawer, shiftFigures, type TillCashState } from '../../edge/store-edge/src/till-cash';
import { notBankedBillEffects } from '../../services/pos/src/index';
import type { CommitOutcome } from '../../edge/store-edge/src/durability';
import { migrationPayload, posLanePayload, MIRROR_PILOT_NOT_COMPARED } from '../../edge/store-edge/src/screen-data';
import { emptyPack } from '../../edge/store-edge/src/store-pack';

/**
 * **OB-256 (owner, 20 Oct 2026, "One 'paid on old' type") · OB-258 ("Ring on both") — the mirror pilot's tender, "Paid on
 * old system" (`paid_on_old_erp`), in every place the product names tenders.** No store computer, no network: the till's
 * own model with a stand-in durable write, and the pure engines head office and the store computer run.
 *
 *   • the rule: off → the tender is refused; on → it is the ONLY tender, for the whole bill, settled, no change, no card
 *     reference; a refund goes back to it, no exchange as one, never more than the bill was paid that way;
 *   • the till refuses before the disk in both directions (sale and refund), in the words the store computer uses;
 *   • the cash-up expects NO drawer money from it; it is settled (no provider reversal waits); it is its own line in the
 *     day book (posting with the suggested map, tax pulled out of the sale as for any other) and in every report;
 *   • card data is still stripped from it; it is not an electronic tender; head office words it as itself, never "cash".
 */

const AT = '2026-10-20T10:00:00.000Z';
const saved: CommitOutcome = { committed: true, durable: true, detail: 'saved', laneMessage: 'Saved.' };
const t = (kind: string, amountMinor: number, extra: Record<string, unknown> = {}) => ({ kind, amountMinor, status: 'settled', ...extra });

describe('the rule, once (packages/tender/src/paid-on-old-erp.ts)', () => {
  it('is a tender kind of its own', () => {
    expect(TENDER_KINDS).toContain(PAID_ON_OLD_ERP);
    expect(isTenderKind('paid_on_old_erp')).toBe(true);
    expect(PAID_ON_OLD_ERP_WORDS.name).toBe('Paid on old system');
  });

  it('with the mirror pilot OFF, a sale or refund that uses it is refused — and nothing else changes', () => {
    expect(saleTenderRefusal({ mirrorOn: false, totalMinor: 100, tenders: [t('paid_on_old_erp', 100)] })).toMatchObject({ refusedBecause: 'paid_on_old_erp_not_on', laneMessage: PAID_ON_OLD_ERP_WORDS.notOn });
    expect(saleTenderRefusal({ mirrorOn: false, totalMinor: 100, tenders: [t('cash', 60), t('paid_on_old_erp', 40)] })?.refusedBecause).toBe('paid_on_old_erp_not_on');
    expect(saleTenderRefusal({ mirrorOn: false, totalMinor: 100, tenders: [t('cash', 100)] })).toBeUndefined();
    expect(refundTenderRefusal({ mirrorOn: false, refundTender: 'paid_on_old_erp' })?.refusedBecause).toBe('paid_on_old_erp_not_on');
    expect(refundTenderRefusal({ mirrorOn: false, refundTender: 'exchange', exchange: { balance: 'refund', balanceTender: 'paid_on_old_erp' } })?.refusedBecause).toBe('paid_on_old_erp_not_on');
    expect(refundTenderRefusal({ mirrorOn: false, refundTender: 'exchange', exchange: { balance: 'top_up', topUpTenders: [{ kind: 'paid_on_old_erp', amountMinor: 5 }] } })?.refusedBecause).toBe('paid_on_old_erp_not_on');
    expect(refundTenderRefusal({ mirrorOn: false, refundTender: 'cash' })).toBeUndefined();
  });

  it('with the mirror pilot ON, the whole bill is paid by it alone — settled, exact, no reference, no card', () => {
    expect(saleTenderRefusal({ mirrorOn: true, totalMinor: 100, tenders: [t('paid_on_old_erp', 100)] })).toBeUndefined();
    // The cloud shape too (no status).
    expect(saleTenderRefusal({ mirrorOn: true, totalMinor: 100, tenders: [{ kind: 'paid_on_old_erp', amount: { minor: 100, currency: 'INR' } }] })).toBeUndefined();
    for (const tenders of [
      [t('cash', 100)],
      [t('card', 100, { ref: 'att-1' })],
      [t('upi', 100)],
      [t('paid_on_old_erp', 60), t('cash', 40)],
      [t('paid_on_old_erp', 90)],                       // not the whole bill
      [t('paid_on_old_erp', 120)],                      // no change: no money was handed over here
      [t('paid_on_old_erp', 100, { status: 'uncertain' })],
      [t('paid_on_old_erp', 100, { ref: 'OLD-BILL-1' })], // no approval or reference copied or invented
      [t('paid_on_old_erp', 100, { card: { last4: '4242' } })],
      [],
    ]) {
      expect(saleTenderRefusal({ mirrorOn: true, totalMinor: 100, tenders })?.refusedBecause, JSON.stringify(tenders)).toBe('mirror_sale_needs_paid_on_old_erp');
    }
  });

  it('with the mirror pilot ON, a refund goes back to it; any other way, or an exchange, is refused', () => {
    expect(refundTenderRefusal({ mirrorOn: true, refundTender: 'paid_on_old_erp' })).toBeUndefined();
    for (const how of ['cash', 'card', 'upi', 'store_credit']) {
      expect(refundTenderRefusal({ mirrorOn: true, refundTender: how })).toMatchObject({ refusedBecause: 'mirror_refund_needs_paid_on_old_erp', laneMessage: PAID_ON_OLD_ERP_WORDS.refundNeedsIt });
    }
    expect(refundTenderRefusal({ mirrorOn: true, refundTender: 'exchange', exchange: { balance: 'even' } })?.refusedBecause).toBe('mirror_no_exchange');
  });

  it('a refund stays within its bill: what it was paid that way, less every refund already against it', () => {
    expect(paidOnOldErpRoom({ totalMinor: 50_000, tenders: [{ kind: 'paid_on_old_erp', amountMinor: 50_000 }], priorRefundsMinor: 0 })).toBe(50_000);
    expect(paidOnOldErpRoom({ totalMinor: 50_000, tenders: [{ kind: 'paid_on_old_erp', amountMinor: 50_000 }], priorRefundsMinor: 20_000 })).toBe(30_000);
    expect(paidOnOldErpRoom({ totalMinor: 50_000, tenders: [{ kind: 'paid_on_old_erp', amountMinor: 50_000 }], priorRefundsMinor: 60_000 })).toBe(0);
    expect(paidOnOldErpRoom({ totalMinor: 50_000, tenders: [{ kind: 'cash', amountMinor: 50_000 }], priorRefundsMinor: 0 })).toBe(0);
    expect(paidOnOldErpRoom({ totalMinor: 50_000, tenders: undefined, priorRefundsMinor: 0 })).toBe(0);
  });
});

describe('the till refuses before the disk, both ways', () => {
  const till = (mirrorPilot: boolean) => {
    const sent: string[] = [];
    const view = bootPos({
      laneId: 'lane-1', cashierId: 'u-meena', taxPercent: 5, guestSalesOnly: true, ...(mirrorPilot ? { mirrorPilot: true } : {}),
      durable: async (_id, record) => { sent.push(record); return saved; },
      durableReturn: async (_id, record) => { sent.push(record); return saved; },
    });
    view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 2 });
    return { view, sent };
  };
  const refund = (refundTender: CommitReturnInput['refundTender']) => ({
    id: 'RT-1', number: 'RT-1', originalSaleId: 'S-1', processedAt: AT, reasonCode: 'damaged',
    lines: [{ productId: 'P1', uom: 'ea' as const, quantityMinor: 1, originalQtyMinor: 2, disposition: 'resell' as const }],
    refund: money(10_500, 'INR'), refundTender, maxRefund: money(21_000, 'INR'), approvalThresholdMinor: 1_000_000,
  });

  it('mirror ON: "Paid on old system" saves the bill — tax pulled out as for any sale, no cash, the till says it is on', async () => {
    const { view, sent } = till(true);
    expect(view.mirrorPilot()).toBe(true);
    expect(await view.tenderPaidOnOldErp('S-1', 'R-1', AT)).toBe('R-1');
    const record = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(record['tenders']).toEqual([expect.objectContaining({ kind: 'paid_on_old_erp', status: 'settled', amount: { minor: 21_000, currency: 'INR' } })]);
    expect(record).toMatchObject({ total: 21_000, taxMinor: 1_000, netMinor: 20_000 }); // GST inside, as on every bill
    expect(cashIntoDrawer(record)).toBe(0);
  });

  it('mirror ON: cash, card and a split are refused in words, and nothing reaches the disk', async () => {
    const { view, sent } = till(true);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toThrow(LocalCommitRefusedError);
    await expect(view.tenderCash('S-1', 'R-1', AT)).rejects.toMatchObject({ laneMessage: PAID_ON_OLD_ERP_WORDS.saleNeedsIt });
    await expect(view.tenderCardOrUpi({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, kind: 'card', outcome: 'approved', ref: 'att-1' })).rejects.toThrow(LocalCommitRefusedError);
    await expect(view.tenderSplit({ saleId: 'S-1', receiptNumber: 'R-1', atIsoUtc: AT, parts: [{ kind: 'cash', amountMinor: 21_000 }] })).rejects.toThrow(LocalCommitRefusedError);
    expect(sent).toEqual([]);
  });

  it('mirror OFF: "Paid on old system" is refused in words, and nothing reaches the disk; cash is as before', async () => {
    const { view, sent } = till(false);
    expect(view.mirrorPilot()).toBe(false);
    await expect(view.tenderPaidOnOldErp('S-1', 'R-1', AT)).rejects.toMatchObject({ name: 'LocalCommitRefusedError', laneMessage: PAID_ON_OLD_ERP_WORDS.notOn });
    expect(sent).toEqual([]);
    expect(await view.tenderCash('S-1', 'R-1', AT)).toBe('R-1');
  });

  it('a refund: mirror ON goes back to it (settled, the till says do not open the drawer); cash is refused; OFF refuses it', async () => {
    const on = till(true);
    await expect(on.view.till.refund(refund('cash'))).rejects.toMatchObject({ name: 'LocalRefundRefusedError', laneMessage: PAID_ON_OLD_ERP_WORDS.refundNeedsIt });
    expect(on.sent).toEqual([]);
    const outcome = await refundOutcomeOf(() => on.view.till.refund(refund('paid_on_old_erp')));
    expect(outcome).toMatchObject({ kind: 'settled', refundMinor: 10_500, laneMessage: PAID_ON_OLD_ERP_WORDS.refundDone });
    expect(JSON.parse(on.sent[0]!)).toMatchObject({ refundTender: 'paid_on_old_erp', refundMinor: 10_500 });

    const off = till(false);
    await expect(off.view.till.refund(refund('paid_on_old_erp'))).rejects.toBeInstanceOf(LocalRefundRefusedError);
    expect(off.sent).toEqual([]);
  });

  it('the second-person rule is unchanged: a refund above the threshold still needs another person\'s approval', async () => {
    const { view } = till(true);
    await expect(view.till.refund({ ...refund('paid_on_old_erp'), approvalThresholdMinor: 0 })).rejects.toMatchObject({ name: 'ApprovalRequiredError' });
  });
});

describe('everywhere else tenders are named, it is handled on purpose', () => {
  it('settles like cash (no fake approval needed, no provider waits) — and a refund to it is settled, never "pending"', () => {
    expect(settle(money(100, 'INR'), [{ kind: 'paid_on_old_erp', amount: money(100, 'INR'), status: 'settled' }]).fullyPaid).toBe(true);
    const done = commitReturn({
      id: 'RT-1', number: 'RT-1', originalSaleId: 'S-1', laneId: 'lane-1', processedBy: 'u-meena', processedAt: AT, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'resell' }],
      refund: money(100, 'INR'), refundTender: 'paid_on_old_erp', maxRefund: money(100, 'INR'), approvalThresholdMinor: 1_000_000,
    }, new Ledger(new InMemoryLedgerStore()), new SyncOutbox());
    expect(done.refundStatus).toBe('settled');
  });

  it('head office\'s return engine reads it as settled, and "back to the source" when the bill was paid that way', () => {
    const sale = { saleId: 'S-1', number: 'R-1', tradingDay: '2026-10-20', committedAt: AT, totalMinor: 21_000, lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 2 }], tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }] };
    const a = assessReturn({
      sale, priorReturns: [], priorRefunds: [],
      request: { returnId: 'RT-1', processedBy: 'u-meena', reasonCode: 'damaged', refundMinor: 10_500, refundTender: 'paid_on_old_erp', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }] } as never,
    });
    expect(a).toMatchObject({ refundStatus: 'settled' });
    expect(refundChannel({ saleTenders: sale.tenders, refundedByTender: {}, refundTender: 'paid_on_old_erp', refundMinor: 10_500 }).verdict).toBe('to_source');
    // A cash bill refunded "Paid on old system" is not the way the money came — head office says so.
    expect(refundChannel({ saleTenders: [{ kind: 'cash', amountMinor: 21_000 }], refundedByTender: {}, refundTender: 'paid_on_old_erp', refundMinor: 10_500 }).verdict).toBe('exception_needed');
    expect(ELECTRONIC_TENDERS).not.toContain(PAID_ON_OLD_ERP);
  });

  it('the blind cash-up expects NO drawer money from a mirror sale or a mirror refund', () => {
    const state = {
      tillId: 'lane-1', custodian: 'u-meena', balanceMinor: 50_000, openedAt: '2026-10-20T09:00:00.000Z',
      movementsSinceOpen: [{ movementKind: 'float_issue', amountMinor: 50_000 }], lastClose: null, movementIds: new Set(), shiftIds: new Set(),
    } as unknown as TillCashState;
    const figures = shiftFigures({
      state, laneId: 'lane-1', closedAt: '2026-10-20T18:00:00.000Z',
      sales: [{ id: 'S-1', laneId: 'lane-1', committedAt: AT, total: 21_000, tenders: [{ kind: 'paid_on_old_erp', amount: { minor: 21_000 } }] }],
      returns: [{ returnId: 'RT-1', laneId: 'lane-1', processedAt: AT, refundMinor: 10_500, refundTender: 'paid_on_old_erp' }],
    });
    expect(figures).toEqual({ openingFloatMinor: 50_000, pickupsMinor: 0, cashSalesMinor: 0, cashRefundsMinor: 0 });
  });

  it('the day book: its own tender and refund lines, posted with the suggested map; the sale\'s GST as for any bill', () => {
    const sale = { saleId: 'S-1', tradingDay: '2026-10-20', totalMinor: 21_000, lines: [{ productId: 'P1', quantityMinor: 2, lineTotalMinor: 21_000, taxRateBps: 500 }], tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }] };
    const book = buildDayBook({
      tradingDay: '2026-10-20', sales: [sale],
      returns: [{ returnId: 'RT-1', originalSaleId: 'S-1', refundMinor: 10_500, refundTender: 'paid_on_old_erp', lines: [{ productId: 'P1', quantityMinor: 1 }] }],
      originalSales: new Map([['S-1', sale]]), taxRateOf: () => undefined, alreadyPosted: new Map(),
    });
    expect(book.exceptions).toEqual([]);
    expect(book.aggregates.map((a) => a.kind)).toEqual(['refund:paid_on_old_erp', 'sale', 'sale_return', 'tender:paid_on_old_erp']);
    expect(book.aggregates.find((a) => a.kind === 'sale')!.components).toMatchObject({ total: 21_000, net: 20_000, tax: 1_000 });
    const posted = postDayBook(book, DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(posted.exceptions).toEqual([]);
    const tender = posted.journals.find((j) => j.aggregate.kind === 'tender:paid_on_old_erp')!;
    expect(JSON.stringify(tender.entry)).toContain('paid_on_old_erp_clearing');
    expect(JSON.stringify(posted.journals)).not.toMatch(/cash_in_hand|card_receivable|upi_receivable/);
    expect(SUGGESTED_ACCOUNT_CLASSES['paid_on_old_erp_clearing']).toBe('asset');
  });

  it('reports: its own line in the tender mix, never cash/card/UPI', () => {
    expect(tenderSplit({ totalMinor: 21_000, tender: 'paid_on_old_erp', tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }] })).toEqual({ paid_on_old_erp: 21_000 });
    const summary = salesSummary([{ saleId: 'S-1', netMinor: 20_000, taxMinor: 1_000, totalMinor: 21_000, cogsMinor: 0, units: 2, tender: 'paid_on_old_erp', tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }] } as never]);
    expect(summary.tenderMix).toEqual({ paid_on_old_erp: 21_000 });
  });

  it('card data is still stripped from it; head office words it as itself, with no drawer cash', () => {
    // Synthetic: the public test card number card networks publish, built from parts.
    const pan = ['4111', '1111', '1111', '1111'].join('');
    const { tenders, removed } = withoutCardData([{ kind: 'paid_on_old_erp', amountMinor: 100, pan }] as never);
    expect(JSON.stringify(tenders)).not.toContain(pan);
    expect(removed.length).toBe(1);
    const words = notBankedBillEffects({
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-20', committedAt: AT, totalMinor: 21_000,
      currency: 'INR', packVersion: 1, lines: [{ productId: 'P1', quantityMinor: 2, uom: 'ea', unitPriceMinor: 10_500 }], tenders: [{ kind: 'paid_on_old_erp', amountMinor: 21_000 }],
    } as never);
    expect(words).toContain('paid on the old system 21000');
    expect(words).not.toContain('drawer');
  });
});

describe('MG-10 in the mirror pilot (OB-256): what the store computer tells its screens', () => {
  const pack = { ...emptyPack(), migrationPolicy: { known: true as const, value: { cutoverId: 'c', requiredCleanDays: 3 } } };
  const input = { pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-10-20' };

  it('the six areas stay the six; in the mirror pilot payments and loyalty are said to be not compared — decided, by OB-256', () => {
    expect(migrationPayload({ ...input, mirrorPilot: { on: true, by: 'store_computer_setting' } })!['notCompared']).toEqual([
      { area: 'payments', decision: 'OB-256' }, { area: 'loyalty', decision: 'OB-256' },
    ]);
    expect(MIRROR_PILOT_NOT_COMPARED.map((n) => n.area)).toEqual(['payments', 'loyalty']);
    // Off (or never told): nothing is left out — all six are compared, as before.
    expect(migrationPayload(input)).not.toHaveProperty('notCompared');
    expect(migrationPayload({ ...input, mirrorPilot: { on: false, by: null } })).not.toHaveProperty('notCompared');
  });

  it('the till is told whether it is in the mirror pilot, and off when the box says nothing', () => {
    expect(posLanePayload({ ...input, mirrorPilot: { on: true, by: 'store_pack' } }, 'lane-1')['mirrorPilot']).toEqual({ on: true, by: 'store_pack' });
    expect(posLanePayload(input, 'lane-1')['mirrorPilot']).toEqual({ on: false, by: null });
  });
});
