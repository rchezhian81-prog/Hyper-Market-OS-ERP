import { describe, it, expect } from 'vitest';
import { commitSale, UnpaidSaleError, type CommitSaleInput } from '../../packages/sale/src/index';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { Tender } from '../../packages/tender/src/index';

// The whole offline POS transaction, composed and tested: a fully-paid sale
// commits stock to the local ledger and queues itself for sync, with no network
// call (hard rule #1), and is idempotent on the sale id (§31.1).

const cashSettled = (minor: number): Tender => ({
  kind: 'cash',
  amount: money(minor, 'INR'),
  status: 'settled',
});

function baseInput(overrides: Partial<CommitSaleInput> = {}): CommitSaleInput {
  return {
    id: 'sale-1',
    number: 'INV000001',
    laneId: 'lane-3',
    cashierId: 'cashier-7',
    tradingDay: '2026-08-02',
    committedAt: '2026-08-02T10:00:00Z',
    total: money(35_40, 'INR'),
    lines: [
      { productId: 'p1', quantityMinor: 2, uom: 'ea' },
      { productId: 'p2', quantityMinor: 1, uom: 'ea' },
    ],
    tenders: [cashSettled(35_40)],
    ...overrides,
  };
}

interface Move {
  deltaMinor: number;
}

describe('commitSale', () => {
  it('commits stock locally and queues the sale for sync (no network)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const sale = commitSale(baseInput(), ledger, outbox);

    expect(ledger.entries()).toHaveLength(2); // one stock move per line
    expect(outbox.unsentCount()).toBe(1); // the sale queued for the cloud
    expect(sale.changeDue.minor).toBe(0);

    // stock decreased: projected balance is the sum of the (negative) deltas
    const stockDelta = ledger.project(0, (s, e) => s + (e.payload as Move).deltaMinor);
    expect(stockDelta).toBe(-3);
  });

  it('refuses to commit a sale that is not fully paid', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const input = baseInput({
      tenders: [{ kind: 'card', amount: money(35_40, 'INR'), status: 'pending' }],
    });
    expect(() => commitSale(input, ledger, outbox)).toThrow(UnpaidSaleError);
    expect(ledger.entries()).toHaveLength(0);
    expect(outbox.unsentCount()).toBe(0);
  });

  it('is idempotent: committing the same sale twice yields one effect (§31.1)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    commitSale(baseInput(), ledger, outbox);
    commitSale(baseInput(), ledger, outbox); // retry of the same sale
    expect(ledger.entries()).toHaveLength(2); // not 4
    expect(outbox.unsentCount()).toBe(1); // not 2
  });

  it('returns change due when the customer overpays with cash', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const sale = commitSale(
      baseInput({ total: money(35_00, 'INR'), tenders: [cashSettled(40_00)] }),
      ledger,
      outbox,
    );
    expect(sale.changeDue.minor).toBe(5_00);
  });
});
