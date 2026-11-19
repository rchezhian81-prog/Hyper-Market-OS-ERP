import { describe, it, expect } from 'vitest';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { receiptLineProblems } from '../../packages/receiving/src/receiving';
import { createManagerSession, ReceiptLinesRefusedError, type ManagerConfig } from '../../apps/web-erp/src/manager-session';
import { receiptRuleFor } from '../../services/inventory/src/goods-receipt';

/**
 * Batch 18a · R3 / R4 (M07-FR-02/03 · P-01 · P-08), DOM-free: Receive (office) takes, per line, the MRP printed on the pack and
 * how many FAILED THE QUALITY CHECK or were refused at the door. A wrong figure is refused offline with nothing saved; the
 * screen's own ledger raises only the good units; both travel to head office on the line; and head office's receiving rule
 * now carries the MRP it publishes, so a different one on the pack is flagged. Synthetic data only.
 */

const AT = '2026-11-19T10:00:00.000Z';

function session() {
  const outbox = new SyncOutbox();
  const ledger = new Ledger(new InMemoryLedgerStore());
  const config: ManagerConfig = {
    storeId: 'store-1', branchId: 'store-1', tradingDay: '2026-11-19', tradingDayRule: { cutoff: '02:00' } as unknown as ManagerConfig['tradingDayRule'],
    manager: { userId: 'u-mgr', branchScope: ['store-1'], authorityLimit: null }, currency: 'INR', warehouseId: 'wh-1',
  };
  const ports = { approvals: () => ({ known: false as const, why: 'x' }), exceptions: () => ({ known: false as const, why: 'x' }), unsent: () => ({ known: false as const, why: 'x' }), tasks: () => ({ known: false as const, why: 'x' }), pendingPayments: () => ({ known: false as const, why: 'x' }) };
  return { s: createManagerSession(config, ports as never, ledger, outbox), outbox, ledger };
}

describe('Batch 18a · R3/R4 — the pack MRP and a failed quality check on Receive', () => {
  it('names every wrong line: failed not whole, damaged + failed above what arrived, an MRP that is not an amount', () => {
    expect(receiptLineProblems([
      { productId: 'a', quantityMinor: 5, qcFailedMinor: 1.5 },
      { productId: 'b', quantityMinor: 5, damagedMinor: 3, qcFailedMinor: 3 },
      { productId: 'c', quantityMinor: 5, mrpMinor: 0 },
      { productId: 'd', quantityMinor: 5, mrpMinor: 12.5 },
      { productId: 'e', quantityMinor: 5, damagedMinor: 2, qcFailedMinor: 3, mrpMinor: 21_000 },
    ]).map((p) => `${p.productId}:${p.kind}`)).toEqual([
      'a:qc_failed_not_whole', 'b:set_aside_more_than_arrived', 'c:mrp_not_an_amount', 'd:mrp_not_an_amount',
    ]);
  });

  it('refused offline with nothing saved; a right line raises only the good units and carries both to head office', () => {
    const { s, outbox, ledger } = session();
    expect(() => s.receive({ grnId: 'g1', number: 'DN-1', poId: null, receivedAt: AT, lines: [{ productId: 'p-oil', quantityMinor: 4, uom: 'ea', qcFailedMinor: 5 }] })).toThrow(ReceiptLinesRefusedError);
    expect(outbox.pending()).toEqual([]);
    expect(ledger.entries()).toEqual([]);

    s.receive({ grnId: 'g2', number: 'DN-2', poId: null, receivedAt: AT, lines: [
      { productId: 'p-oil', quantityMinor: 12, uom: 'ea', batchId: 'OIL-1', damagedMinor: 1, qcFailedMinor: 3, mrpMinor: 22_000 },
      { productId: 'p-salt', quantityMinor: 2, uom: 'ea', qcFailedMinor: 2 },
    ] });
    expect(ledger.entries().map((r) => r.event.payload as { productId: string; deltaMinor: number })).toEqual([expect.objectContaining({ productId: 'p-oil', deltaMinor: 8 })]);
    expect((outbox.pending()[0]!.event.payload as { lines: unknown[] }).lines).toEqual([
      { productId: 'p-oil', quantityMinor: 12, uom: 'ea', batchId: 'OIL-1', damagedMinor: 1, qcFailedMinor: 3, mrpMinor: 22_000 },
      { productId: 'p-salt', quantityMinor: 2, uom: 'ea', batchId: null, qcFailedMinor: 2 },
    ]);
  });

  it('head office\'s receiving rule carries the MRP it publishes (none when it publishes none)', () => {
    expect(receiptRuleFor('p-oil', { batchTracked: false, mrpMinor: 21_000 }, undefined, [])).toMatchObject({ mrp: { minor: 21_000, currency: 'INR' } });
    expect(receiptRuleFor('p-oil', { batchTracked: false }, undefined, [])).not.toHaveProperty('mrp');
  });
});
