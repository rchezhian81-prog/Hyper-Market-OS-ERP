import { describe, it, expect } from 'vitest';
import {
  buildLotTraceChain, traceCsv, sortRows, traceDueAt, traceRequestStanding, TRACE_CSV_COLUMNS,
  type TraceRequest,
} from '../../packages/quality/src/lot-trace-chain';

// D-26 — the pure engine: every hop from stored facts, gaps said in words, a CSV sorted by the column asked for, and the
// 24-hour clock on a trace request. Clockless: every time is passed in.

const facts = () => ({
  batchId: 'B-7',
  receipts: [
    { grnId: 'grn-1', grnNumber: 'GRN-0001', supplierId: 'sup-1', poId: 'po-1', productId: 'p-paneer', locationId: 'WH', receivedAt: '2030-05-01T08:00:00.000Z', quantityMinor: 30 },
  ],
  producedBy: [],
  transfers: [
    { transferId: 't-1', productId: 'p-paneer', fromLocationId: 'WH', toLocationId: 'S1', state: 'received', dispatchedAt: '2030-05-02T08:00:00.000Z', receivedAt: '2030-05-02T12:00:00.000Z', quantityMinor: 20 },
    { transferId: 't-0', productId: 'p-paneer', fromLocationId: 'WH', toLocationId: 'S2', state: 'proposed', quantityMinor: 5 }, // never moved
  ],
  usedIn: { connected: true as const, runs: [] },
  sales: [
    { saleId: 'S-2', soldDate: '2030-05-04', quantityMinor: 2, source: 'captured' as const },
    { saleId: 'S-1', soldDate: '2030-05-03', quantityMinor: 3, customerId: 'cust-42', source: 'captured' as const },
  ],
});

describe('D-26: one batch, every hop', () => {
  it('supplier → GRN → transfer → sales, in date order, complete when nothing is missing', () => {
    const chain = buildLotTraceChain(facts());
    expect(chain.rows.map((r) => [r.hop, r.reference, r.from, r.to])).toEqual([
      ['supplier_to_store', 'GRN GRN-0001 (PO po-1)', 'sup-1', 'WH'],
      ['transfer', 'transfer t-1 (received)', 'WH', 'S1'],
      ['sale', 'sale S-1', 'store', 'cust-42'],
      ['sale', 'sale S-2', 'store', 'walk-in'],
    ]);
    expect(chain).toMatchObject({ receivedMinor: 30, soldMinor: 5, usedInProductionMinor: 0, gaps: [], complete: true, productIds: ['p-paneer'] });
  });

  it('every missing hop is a gap in words — never a silent blank (P-08)', () => {
    const chain = buildLotTraceChain({
      ...facts(),
      receipts: [
        { grnId: null, movementId: 'mv-9', supplierId: null, poId: null, productId: 'p-paneer', locationId: 'S1', receivedAt: '2030-05-01T00:00:00Z', quantityMinor: 1 },
        { grnId: 'grn-2', supplierId: null, poId: null, productId: 'p-paneer', locationId: 'S1', receivedAt: '2030-05-01T00:00:00Z', quantityMinor: 1 },
      ],
      usedIn: { connected: false, why: 'the seam is not connected' },
      sales: [{ saleId: 'S-9', soldDate: '2030-05-05', quantityMinor: 5, source: 'fifo_receipt_estimate' }],
    });
    expect(chain.complete).toBe(false);
    expect(chain.usedInProductionMinor).toBe('not_known');
    expect(chain.gaps.join(' | ')).toMatch(/no goods-receipt note \(movement mv-9\).*supplier is not known/);
    expect(chain.gaps.join(' | ')).toMatch(/goods receipt grn-2 names no purchase order/);
    expect(chain.gaps.join(' | ')).toMatch(/used in production is not known: the seam is not connected/);
    expect(chain.gaps.join(' | ')).toMatch(/5 of this batch left the shop but only 2 ever arrived/);
    expect(chain.gaps.join(' | ')).toMatch(/FIFO estimate/);
    expect(buildLotTraceChain({ ...facts(), receipts: [], transfers: [], sales: [] }).gaps).toContain('no receipt and no production of this batch is on record — where it came from is not known');
  });

  it('D-25 → D-26: a run that used the batch, and the output batch\'s sales, are on the road — not counted as this batch\'s sales', () => {
    const chain = buildLotTraceChain({
      ...facts(),
      usedIn: { connected: true, runsWithoutRecordedInputs: 0, runs: [{
        runId: 'run-1', at: '2030-05-05T06:00:00.000Z', quantityMinor: 4, outputProductId: 'p-tikka', outputBatchId: 'TK-1',
        outputSales: [{ saleId: 'S-T1', soldDate: '2030-05-06', quantityMinor: 2, customerId: 'cust-7', source: 'captured' }],
      }] },
    });
    expect(chain.rows.filter((r) => r.hop === 'production_used' || r.from.startsWith('p-tikka')).map((r) => [r.hop, r.reference, r.from, r.to, r.productId, r.quantityMinor])).toEqual([
      ['production_used', 'production run run-1', 'B-7', 'p-tikka batch TK-1', 'p-tikka', 4],
      ['sale', 'sale S-T1', 'p-tikka batch TK-1', 'cust-7', 'p-tikka', 2],
    ]);
    expect(chain.rows.find((r) => r.reference === 'sale S-T1')!.source).toBe('till recorded the batch — made from this batch in run run-1');
    // 30 in; 5 sold + 4 into the run out; the tikka's 2 are not the paneer's own sales.
    expect(chain).toMatchObject({ soldMinor: 5, usedInProductionMinor: 4, gaps: [], complete: true });
  });

  it('runs recorded before D-25 carry no input batches — how many is a gap, never "not used"', () => {
    const chain = buildLotTraceChain({ ...facts(), usedIn: { connected: true, runs: [], runsWithoutRecordedInputs: 3 } });
    expect(chain.complete).toBe(false);
    expect(chain.gaps).toEqual(['3 production run(s) were recorded before runs kept their ingredient batches (D-25) — whether they used this batch is not known']);
  });

  it('the CSV has a fixed header and sorts by any column, ties in road order', () => {
    const chain = buildLotTraceChain(facts());
    const csv = traceCsv(chain, 'quantity').trim().split('\n');
    expect(csv[0]).toBe(TRACE_CSV_COLUMNS.join(','));
    expect(csv.slice(1).map((l) => l.split(',')[8])).toEqual(['2', '3', '20', '30']);
    expect(sortRows(chain.rows, 'hop').map((r) => r.hop)).toEqual(['supplier_to_store', 'transfer', 'sale', 'sale']);
    expect(sortRows(chain.rows, 'to').map((r) => r.to)).toEqual(['S1', 'WH', 'cust-42', 'walk-in']);
  });

  it('a cell a spreadsheet would run as a formula is written as text; commas and quotes are quoted', () => {
    const chain = buildLotTraceChain({ ...facts(), sales: [{ saleId: '=HYPERLINK("x")', soldDate: '2030-05-03', quantityMinor: 1, customerId: 'a,b' }] });
    const row = traceCsv(chain).split('\n').find((l) => l.includes('HYPERLINK'))!;
    expect(row).toContain('"sale =HYPERLINK(""x"")"');
    expect(row).toContain('"a,b"');
    const lead = buildLotTraceChain({ ...facts(), sales: [{ saleId: 'S', soldDate: '2030-05-03', quantityMinor: 1, customerId: '=cmd' }] });
    expect(traceCsv(lead)).toContain(",'=cmd,");
  });
});

describe('D-26: a trace request not answered within 24 hours raises an exception', () => {
  const request: TraceRequest = { requestId: 'TR-1', batchId: 'B-7', askedBy: 'FSSAI officer', reason: 'complaint', requestedAt: '2030-05-10T10:00:00.000Z', recordedBy: 'u-owner', dueAt: traceDueAt('2030-05-10T10:00:00.000Z') };
  const answer = (at: string) => ({ requestId: 'TR-1', answeredAt: at, answeredBy: 'u-owner', rowCount: 4, gapCount: 0, csvSha256: 'x' });
  it('due 24 hours after it was asked', () => {
    expect(request.dueAt).toBe('2030-05-11T10:00:00.000Z');
  });
  it('open inside the 24 hours; overdue and critical after them; answered on time is clean; answered late keeps the exception', () => {
    expect(traceRequestStanding(request, undefined, '2030-05-11T09:59:59.000Z')).toEqual({ state: 'open' });
    expect(traceRequestStanding(request, undefined, '2030-05-11T10:00:01.000Z')).toMatchObject({ state: 'overdue', exception: { kind: 'trace_request_not_answered_in_24h', severity: 'critical', raisedAt: request.dueAt } });
    expect(traceRequestStanding(request, answer('2030-05-11T09:00:00.000Z'), '2030-05-20T00:00:00.000Z')).toEqual({ state: 'answered' });
    expect(traceRequestStanding(request, answer('2030-05-11T11:00:00.000Z'), '2030-05-20T00:00:00.000Z')).toMatchObject({ state: 'answered_late', exception: { severity: 'critical' } });
  });
});
