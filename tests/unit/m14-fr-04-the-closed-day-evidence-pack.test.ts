import { describe, it, expect } from 'vitest';
import {
  buildDayEvidencePack, verifyDayEvidencePack, dayEvidenceCsv, NoCloseForThisDayError, DAY_EVIDENCE_SCHEMA, type DayEvidenceFacts,
} from '../../packages/day-close/src/evidence-pack';

/**
 * **M14-FR-04 — the closed-day evidence pack: sales, tenders, cash, over/short, exceptions and the reopen history of one
 * store-day, sealed with SHA-256 over its content, as JSON and as CSV for the CA.** Pure: the same facts in any order give
 * the same pack and the same seal; counted cash nobody recorded is "not known", never ₹0 (P-08); resolved exceptions stay
 * listed (hard rule #6). Synthetic data only.
 */

const FACTS: DayEvidenceFacts = {
  storeId: 'S1', storeName: 'SRE Hyper Market', tradingDay: '2026-10-22',
  closes: [{
    dayCloseId: 'dc-1', closedBy: 'u-mgr', closedAt: '2026-10-22T17:00:00.000Z',
    carriedForward: { approvedBy: 'u-owner', reason: 'card machine slip missing', attemptIds: ['att-1'], unresolvedMinor: { card: 25_000, upi: 0 }, flags: [] },
  }],
  reopens: [],
  sales: [
    { saleId: 'S-2', receiptNumber: 'L1-000002', laneId: 'lane-1', cashierId: 'u-c', committedAt: '2026-10-22T06:00:00.000Z', totalMinor: 25_000, tenders: [{ kind: 'card', amountMinor: 25_000 }] },
    { saleId: 'S-1', receiptNumber: 'L1-000001', laneId: 'lane-1', cashierId: 'u-c', committedAt: '2026-10-22T05:00:00.000Z', totalMinor: 10_500, tenders: [{ kind: 'cash', amountMinor: 10_500 }] },
    { saleId: 'S-3', receiptNumber: 'L2-000001', laneId: 'lane-2', cashierId: 'u-d', committedAt: '2026-10-22T07:00:00.000Z', totalMinor: 4_000, tenders: [{ kind: 'cash', amountMinor: 1_000 }, { kind: 'upi', amountMinor: 3_000 }] },
  ],
  refunds: [{ returnId: 'RT-1', number: 'R1-000001', originalSaleId: 'S-1', processedBy: 'u-c', processedAt: '2026-10-22T08:00:00.000Z', refundMinor: 2_000, refundTender: 'cash', reasonCode: 'faulty', approvedBy: 'u-mgr', governanceFlags: ['approver_not_verified_at_store'] }],
  shifts: [
    { shiftId: 'SH-2', tillId: 'lane-2', cashierId: 'u-d', closedAt: '2026-10-22T15:00:00.000Z', expectedMinor: 21_000, countedMinor: 21_000, varianceMinor: 0, exceptionRaised: false, reasonCode: null },
    { shiftId: 'SH-1', tillId: 'lane-1', cashierId: 'u-c', closedAt: '2026-10-22T15:30:00.000Z', expectedMinor: 58_500, countedMinor: 58_000, varianceMinor: -500, exceptionRaised: true, reasonCode: 'counting_error', review: { reviewedBy: 'u-owner', disposition: 'counting_error', reviewedAt: '2026-10-22T16:00:00.000Z' } },
  ],
  saleExceptions: [{ saleId: 'S-3', kind: 'price_mismatch', severity: 'material', detail: 'sold below the price list', differenceMinor: -200 }],
};

describe('M14-FR-04 — the closed-day evidence pack', () => {
  it('every section from the facts; the seal re-derives and breaks on one changed figure; order does not matter', () => {
    const pack = buildDayEvidencePack(FACTS);
    expect(pack).toMatchObject({
      schema: DAY_EVIDENCE_SCHEMA, storeId: 'S1', storeName: 'SRE Hyper Market', tradingDay: '2026-10-22', final: true, notFinalBecause: null,
      sales: { count: 3, grossMinor: 39_500, byLane: [{ laneId: 'lane-1', count: 2, grossMinor: 35_500 }, { laneId: 'lane-2', count: 1, grossMinor: 4_000 }] },
      refunds: { count: 1, totalMinor: 2_000 },
      tenders: [
        { kind: 'card', takenMinor: 25_000, refundedMinor: 0, netMinor: 25_000 },
        { kind: 'cash', takenMinor: 11_500, refundedMinor: 2_000, netMinor: 9_500 },
        { kind: 'upi', takenMinor: 3_000, refundedMinor: 0, netMinor: 3_000 },
      ],
      cash: { expectedMinor: 79_500, countedMinor: 79_000, overShortMinor: -500, notKnownBecause: null },
      overShort: [{ shiftId: 'SH-1', tillId: 'lane-1', overShortMinor: -500, material: true, signedOffBy: 'u-owner', disposition: 'counting_error' }],
    });
    expect(pack.sales.bills.map((b) => b.saleId)).toEqual(['S-1', 'S-2', 'S-3']);
    expect(pack.exceptions.map((e) => [e.source, e.ref, e.kind, e.resolved])).toEqual([
      ['sale', 'S-3', 'price_mismatch', false], ['refund', 'RT-1', 'approver_not_verified_at_store', false],
      ['cash', 'SH-1', 'cash_over_short', true], ['carried_payment', 'dc-1', 'card_upi_carried_forward', false],
    ]);
    expect(pack.openExceptions).toBe(3);
    expect(pack.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDayEvidencePack(pack)).toBe(true);
    expect(verifyDayEvidencePack({ ...pack, refunds: { ...pack.refunds, totalMinor: 1_999 } })).toBe(false);
    const shuffled = buildDayEvidencePack({ ...FACTS, sales: [...FACTS.sales].reverse(), shifts: [...FACTS.shifts].reverse() });
    expect(shuffled.contentHash).toBe(pack.contentHash);
  });

  it('no till closed its shift → cash "not known" (never ₹0); a reopen after the last close → not final, said; no close → refused', () => {
    const noCash = buildDayEvidencePack({ ...FACTS, shifts: [] });
    expect(noCash.cash).toEqual({ expectedMinor: null, countedMinor: null, overShortMinor: null, notKnownBecause: expect.stringMatching(/counted cash is not known/), tills: [] });
    const reopened = buildDayEvidencePack({ ...FACTS, reopens: [{ dayCloseId: 'dc-1', reopenedBy: 'u-mgr', approvedBy: null, reason: 'late credit note', reopenedAt: '2026-10-21T00:00:00.000Z', governanceFlags: ['given_without_approval'] }] });
    expect(reopened).toMatchObject({ final: false, notFinalBecause: expect.stringMatching(/reopened .* by u-mgr and has not been closed again/) });
    expect(reopened.history.map((h) => h.event)).toEqual(['closed', 'reopened']); // the reopen follows its close, whatever the clocks say
    expect(reopened.exceptions.at(-1)).toMatchObject({ source: 'reopen', kind: 'given_without_approval' });
    expect(() => buildDayEvidencePack({ ...FACTS, closes: [] })).toThrow(NoCloseForThisDayError);
  });

  it('the CSV: figures in rupees, numbers kept as numbers, a cell that would run as a formula written as text, the seal last', () => {
    const pack = buildDayEvidencePack(FACTS);
    const rows = dayEvidenceCsv(pack).split('\r\n');
    expect(rows[0]).toBe('section,item,amount_rupees,detail');
    expect(rows).toEqual(expect.arrayContaining(['sales,total,395.00,3 bills', 'tender,cash,95.00,"taken 115.00, refunded 20.00"', 'cash,over/short,-5.00,']));
    const odd = dayEvidenceCsv(buildDayEvidencePack({ ...FACTS, sales: [{ ...FACTS.sales[0]!, receiptNumber: '=HYPERLINK("x")' }] })).split('\r\n');
    expect(odd.find((r) => r.startsWith('bill,'))).toBe(`bill,"'=HYPERLINK(""x"")",250.00,S-2 lane lane-1 cashier u-c at 2026-10-22T06:00:00.000Z`);
    expect(rows.at(-2)).toBe(`seal,sha256,,${pack.contentHash}`);
    expect(rows.at(-1)).toBe('');
  });
});
