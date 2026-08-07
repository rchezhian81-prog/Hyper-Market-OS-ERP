import { describe, it, expect } from 'vitest';
import {
  traceBatch,
  RecallRegistry,
  RecalledBatchError,
  MissingRecallEvidenceError,
} from '../../packages/traceability/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';

// Trace a batch supplier↔customer over the ledger, and block a recalled batch even
// offline, closing only with retained evidence (M10-FR-03/04).

const AT = '2026-08-02T09:00:00Z';

function append(
  ledger: Ledger,
  id: string,
  type: string,
  payload: Record<string, unknown>,
  source = 'wh-1',
) {
  ledger.append(
    makeEvent({ id, type, occurredAt: AT, idempotencyKey: id, source, payload }),
  );
}

describe('traceBatch', () => {
  it('traces a batch inbound (received) and outbound (sold to a customer)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    // received 100 of batch B1 on GRN g1
    append(ledger, 'grn:g1:move', 'InventoryMoved', {
      productId: 'p1', batchId: 'B1', deltaMinor: 100, grnId: 'g1',
    });
    // sold 2 to a customer, and 3 to a walk-in (no customer)
    append(ledger, 'sale:s1:move', 'InventoryMoved', {
      productId: 'p1', batchId: 'B1', deltaMinor: -2, saleId: 's1', customerId: 'cust-9',
    }, 'lane-1');
    append(ledger, 'sale:s2:move', 'InventoryMoved', {
      productId: 'p1', batchId: 'B1', deltaMinor: -3, saleId: 's2',
    }, 'lane-1');
    // a different batch — should not appear
    append(ledger, 'sale:s3:move', 'InventoryMoved', {
      productId: 'p1', batchId: 'B2', deltaMinor: -1, saleId: 's3',
    }, 'lane-1');

    const trace = traceBatch(ledger, 'B1');
    expect(trace.receivedQty).toBe(100);
    expect(trace.issuedQty).toBe(5);
    expect(trace.inbound.map((r) => r.ref)).toEqual(['g1']);
    expect(trace.outbound.map((r) => r.ref)).toEqual(['s1', 's2']);
    expect(trace.outbound[0]?.customerRef).toBe('cust-9'); // identified customer
    expect(trace.outbound[1]?.customerRef).toBeNull(); // anonymous walk-in still traced
  });

  it('treats a GoodsReceived event as inbound even without an explicit delta', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    append(ledger, 'grn:g1', 'GoodsReceived', { batchId: 'B1', grnId: 'g1' });
    const trace = traceBatch(ledger, 'B1');
    expect(trace.inbound).toHaveLength(1);
    expect(trace.inbound[0]?.direction).toBe('inbound');
  });
});

describe('RecallRegistry', () => {
  const initiate = { batchId: 'B1', reason: 'contamination', initiatedBy: 'qc-1', at: AT };

  it('blocks a recalled batch from being sold (even offline)', () => {
    const registry = new RecallRegistry();
    registry.initiate(initiate);
    expect(registry.isRecalled('B1')).toBe(true);
    expect(() => registry.assertSellable('B1')).toThrow(RecalledBatchError);
    // a different batch is fine
    expect(() => registry.assertSellable('B2')).not.toThrow();
  });

  it('is idempotent on initiate and lists open recalls for offline caching', () => {
    const registry = new RecallRegistry();
    registry.initiate(initiate);
    registry.initiate(initiate);
    expect(registry.openRecalls()).toHaveLength(1);
  });

  it('closes only with evidence and retains the record', () => {
    const registry = new RecallRegistry();
    registry.initiate(initiate);
    expect(() =>
      registry.close({ batchId: 'B1', closedBy: 'qc-1', evidenceRef: '  ', at: AT }),
    ).toThrow(MissingRecallEvidenceError);

    const closed = registry.close({ batchId: 'B1', closedBy: 'qc-1', evidenceRef: 'DOC-42', at: AT });
    expect(closed.status).toBe('closed');
    expect(registry.isRecalled('B1')).toBe(false);
    // the record and its evidence are retained, never deleted
    expect(registry.find('B1')?.evidenceRef).toBe('DOC-42');
  });
});
