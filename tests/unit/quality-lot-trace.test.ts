import { describe, it, expect } from 'vitest';
import { buildLotTrace, InvalidLotTrace, type InboundLotRecord, type OutboundLotRecord } from '../../packages/quality/src/lot-trace';

// B11 / M10-FR-03: one-up/one-down lot traceability. For a batch, the export lists who it came FROM
// (supplier + GRN) and who it went TO (sales + customers where identified), reconciled so that
// dispatched-exceeds-received surfaces as a gap rather than reading clean.

const inbound: InboundLotRecord[] = [
  { supplierId: 'sup-1', supplierName: 'Amul', grnId: 'GRN-100', receivedDate: '2026-08-01', quantityMinor: 10000 },
];
const outbound: OutboundLotRecord[] = [
  { saleId: 'SALE-9', soldDate: '2026-08-05', quantityMinor: 3000, customerId: 'cust-7' },
  { saleId: 'SALE-3', soldDate: '2026-08-03', quantityMinor: 2000 }, // anonymous walk-in
];

describe('buildLotTrace — B11 one-up/one-down export', () => {
  it('assembles the trace, reconciles quantities, and counts identified vs anonymous recipients', () => {
    const t = buildLotTrace({ batchId: 'B-42', productId: 'milk-1l', inbound, outbound });
    expect(t.totalReceivedMinor).toBe(10000);
    expect(t.totalDispatchedMinor).toBe(5000);
    expect(t.remainingOnHandMinor).toBe(5000);
    expect(t.identifiedRecipientCount).toBe(1);
    expect(t.anonymousSaleCount).toBe(1);
    expect(t.reconciled).toBe(true);
  });

  it('keeps an anonymous sale in the trace rather than dropping it (the recall must still know)', () => {
    const t = buildLotTrace({ batchId: 'B-42', productId: 'milk-1l', inbound, outbound });
    expect(t.outbound.some((r) => r.saleId === 'SALE-3' && r.customerId === undefined)).toBe(true);
  });

  it('sorts inbound by receivedDate/GRN and outbound by soldDate/sale for a stable export', () => {
    const t = buildLotTrace({ batchId: 'B-42', productId: 'milk-1l', inbound, outbound });
    expect(t.outbound.map((r) => r.saleId)).toEqual(['SALE-3', 'SALE-9']); // 03 Aug before 05 Aug
  });

  it('flags an impossible over-dispatch (more sold than received) as unreconciled, negative remaining', () => {
    const t = buildLotTrace({
      batchId: 'B-42', productId: 'milk-1l', inbound,
      outbound: [{ saleId: 'SALE-1', soldDate: '2026-08-05', quantityMinor: 12000 }],
    });
    expect(t.reconciled).toBe(false);
    expect(t.remainingOnHandMinor).toBe(-2000);
  });

  it('handles a batch with no sales yet (all still on hand) and empty lists', () => {
    const t = buildLotTrace({ batchId: 'B-42', productId: 'milk-1l', inbound, outbound: [] });
    expect(t.remainingOnHandMinor).toBe(10000);
    expect(t.anonymousSaleCount).toBe(0);
    expect(t.reconciled).toBe(true);
    const empty = buildLotTrace({ batchId: 'B-42', productId: 'milk-1l', inbound: [], outbound: [] });
    expect(empty.totalReceivedMinor).toBe(0);
    expect(empty.reconciled).toBe(true);
  });

  it('refuses a missing batch/product, a bad date, a negative quantity, and a supplier-less inbound row', () => {
    expect(() => buildLotTrace({ batchId: '', productId: 'p', inbound: [], outbound: [] })).toThrow(InvalidLotTrace);
    expect(() => buildLotTrace({ batchId: 'B', productId: '', inbound: [], outbound: [] })).toThrow(InvalidLotTrace);
    expect(() => buildLotTrace({ batchId: 'B', productId: 'p', inbound: [{ ...inbound[0]!, receivedDate: 'Aug 1' }], outbound: [] })).toThrow(InvalidLotTrace);
    expect(() => buildLotTrace({ batchId: 'B', productId: 'p', inbound: [{ ...inbound[0]!, quantityMinor: -5 }], outbound: [] })).toThrow(InvalidLotTrace);
    expect(() => buildLotTrace({ batchId: 'B', productId: 'p', inbound: [{ ...inbound[0]!, supplierId: '' }], outbound: [] })).toThrow(InvalidLotTrace);
    expect(() => buildLotTrace({ batchId: 'B', productId: 'p', inbound: [], outbound: [{ saleId: '', soldDate: '2026-08-05', quantityMinor: 10 }] })).toThrow(InvalidLotTrace);
  });
});
