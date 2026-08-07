import { describe, it, expect } from 'vitest';
import { commitReceipt, EmptyReceiptError } from '../../packages/receiving/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Goods receiving is the inbound mirror of the sale: stock goes UP in the local
// ledger and the receipt queues for sync, offline and idempotent.

interface Move {
  deltaMinor: number;
}

function baseInput() {
  return {
    id: 'grn-1',
    number: 'GRN000001',
    poId: 'po-9',
    warehouseId: 'wh-1',
    receivedBy: 'receiver-2',
    receivedAt: '2026-08-02T08:00:00Z',
    lines: [
      { productId: 'p1', quantityMinor: 100, uom: 'ea' },
      { productId: 'p2', quantityMinor: 5_000, uom: 'kg' }, // 5.000 kg
    ],
  };
}

describe('commitReceipt', () => {
  it('adds stock to the local ledger and queues the receipt', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const grn = commitReceipt(baseInput(), ledger, outbox);

    expect(ledger.entries()).toHaveLength(2);
    expect(outbox.unsentCount()).toBe(1);
    expect(grn.lineCount).toBe(2);

    // stock increased: projected balance is the sum of positive deltas
    const stock = ledger.project(0, (s, e) => s + (e.payload as Move).deltaMinor);
    expect(stock).toBe(5_100);
  });

  it('is idempotent: re-committing the same GRN yields one effect', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitReceipt(baseInput(), ledger, outbox);
    commitReceipt(baseInput(), ledger, outbox);
    expect(ledger.entries()).toHaveLength(2);
    expect(outbox.unsentCount()).toBe(1);
  });

  it('rejects an empty receipt', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    expect(() => commitReceipt({ ...baseInput(), lines: [] }, ledger, outbox)).toThrow(
      EmptyReceiptError,
    );
  });
});
