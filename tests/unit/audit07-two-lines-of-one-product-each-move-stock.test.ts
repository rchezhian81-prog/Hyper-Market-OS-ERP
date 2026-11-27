import { describe, it, expect } from 'vitest';
import { commitSale, type CommitSaleInput } from '../../packages/sale/src/index';
import { commitReceipt, type CommitReceiptInput } from '../../packages/receiving/src/index';
import { commitReturn } from '../../packages/returns/src/index';
import { money } from '../../packages/contracts/src/money';
import { makeEvent } from '../../packages/contracts/src/event';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

// Audit 27 Nov 2026, item 7 (OB-924, D-141): the local commit of a sale, a goods receipt and a return each built its stock
// movement's id and idempotency key from the PRODUCT id. A second line of the same product on one document — the same
// item rung twice at another price, a receipt of two batches of one product, a return of one unit to resell and one
// damaged — produced the same key, and the append-only ledger quietly treated it as a replay: the second line's stock
// never moved (hard rule #2, hard rule #10). Each line must move stock on its own.
//
// Compatibility (OB-925): the first line of a product on a document keeps EXACTLY the key it had before, and only a
// repeat of the product is suffixed — so a document with one line per product (every document before this fix that
// moved its stock correctly) produces the same keys as before, and an old document re-sent after the upgrade posts
// nothing twice.

interface Move { productId: string; deltaMinor: number; batchId?: string | null; disposition?: string }
const moves = (l: Ledger): Move[] => l.entries().map((r) => r.event.payload as Move);
const total = (l: Ledger): number => moves(l).reduce((s, m) => s + m.deltaMinor, 0);
const keys = (l: Ledger): string[] => l.entries().map((r) => r.event.idempotencyKey);
const ids = (l: Ledger): string[] => l.entries().map((r) => r.event.id);

const sale = (lines: CommitSaleInput['lines'], over: Partial<CommitSaleInput> = {}): CommitSaleInput => ({
  id: 'S-1', number: 'INV000001', laneId: 'lane-1', cashierId: 'cashier-1', tradingDay: '2026-11-27',
  committedAt: '2026-11-27T10:00:00Z', total: money(100_00, 'INR'), lines,
  tenders: [{ kind: 'cash', amount: money(100_00, 'INR'), status: 'settled' }], ...over,
});

const receipt = (lines: CommitReceiptInput['lines']): CommitReceiptInput => ({
  id: 'G-1', number: 'GRN000001', poId: 'po-1', warehouseId: 'wh-1', receivedBy: 'u-mgr', receivedAt: '2026-11-27T08:00:00Z', lines,
});

const ret = (lines: readonly { productId: string; quantityMinor: number; disposition: 'resell' | 'damaged' | 'quarantine' | 'scrap'; batchId?: string }[]) => ({
  id: 'R-1', number: 'R-0001', originalSaleId: 'S-1', laneId: 'lane-1', processedBy: 'clerk-1', processedAt: '2026-11-27T12:00:00Z',
  reasonCode: 'changed_mind',
  lines: lines.map((l) => ({ uom: 'ea', originalQtyMinor: 5, ...l })),
  refund: money(20_00, 'INR'), refundTender: 'cash' as const, maxRefund: money(150_00, 'INR'), approvalThresholdMinor: 100_00,
});

describe('audit item 7 — a second line of the same product on one document moves stock too', () => {
  it('a sale with the same product on two lines takes BOTH lines off stock', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    commitSale(sale([
      { productId: 'MILK', quantityMinor: 2, uom: 'ea' },
      { productId: 'BREAD', quantityMinor: 1, uom: 'ea' },
      { productId: 'MILK', quantityMinor: 3, uom: 'ea' },
    ]), ledger, new SyncOutbox());
    expect(ledger.entries()).toHaveLength(3);
    expect(total(ledger)).toBe(-6);
    expect(moves(ledger).filter((m) => m.productId === 'MILK').map((m) => m.deltaMinor)).toEqual([-2, -3]);
  });

  it('a goods receipt with two batches of the same product puts BOTH batches into stock', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    commitReceipt(receipt([
      { productId: 'DAL', quantityMinor: 10, uom: 'ea', batchId: 'B-1' },
      { productId: 'DAL', quantityMinor: 15, uom: 'ea', batchId: 'B-2' },
    ]), ledger, new SyncOutbox());
    expect(ledger.entries()).toHaveLength(2);
    expect(total(ledger)).toBe(25);
    expect(moves(ledger).map((m) => m.batchId)).toEqual(['B-1', 'B-2']);
  });

  it('a return of one unit to resell and one damaged unit of the same product records BOTH movements', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    commitReturn(ret([
      { productId: 'SOAP', quantityMinor: 1, disposition: 'resell' },
      { productId: 'SOAP', quantityMinor: 1, disposition: 'damaged' },
    ]), ledger, new SyncOutbox());
    expect(ledger.entries()).toHaveLength(2);
    expect(moves(ledger).map((m) => m.disposition)).toEqual(['resell', 'damaged']);
    expect(total(ledger)).toBe(2);
  });

  it('every movement of one document has its own id and its own key — nothing is ever deduped inside one document', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    commitSale(sale([1, 2, 3, 4].map((q) => ({ productId: 'EGG', quantityMinor: q, uom: 'ea' }))), ledger, new SyncOutbox());
    expect(new Set(keys(ledger)).size).toBe(4);
    expect(new Set(ids(ledger)).size).toBe(4);
    expect(total(ledger)).toBe(-10);
  });

  it('a product id that happens to look like a repeat key cannot swallow a real line (keys stay unique inside a document)', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    // A product literally named like the second-occurrence key of another product, rung before that product's repeat.
    commitSale(sale([
      { productId: 'P', quantityMinor: 1, uom: 'ea' },
      { productId: 'P#2', quantityMinor: 1, uom: 'ea' },
      { productId: 'P', quantityMinor: 1, uom: 'ea' },
    ]), ledger, new SyncOutbox());
    expect(ledger.entries()).toHaveLength(3);
    expect(new Set(keys(ledger)).size).toBe(3);
  });
});

describe('audit item 7 — compatibility: an old document re-sent after the upgrade posts nothing twice', () => {
  it('a document with one line per product produces EXACTLY the keys and ids it produced before the fix', () => {
    const s = new Ledger(new InMemoryLedgerStore());
    commitSale(sale([{ productId: 'MILK', quantityMinor: 2, uom: 'ea' }, { productId: 'BREAD', quantityMinor: 1, uom: 'ea' }]), s, new SyncOutbox());
    expect(keys(s)).toEqual(['sale-move:S-1:MILK', 'sale-move:S-1:BREAD']);
    expect(ids(s)).toEqual(['S-1:move:MILK', 'S-1:move:BREAD']);

    const g = new Ledger(new InMemoryLedgerStore());
    commitReceipt(receipt([{ productId: 'DAL', quantityMinor: 10, uom: 'ea' }, { productId: 'RICE', quantityMinor: 5, uom: 'ea' }]), g, new SyncOutbox());
    expect(keys(g)).toEqual(['grn-move:G-1:DAL', 'grn-move:G-1:RICE']);
    expect(ids(g)).toEqual(['G-1:move:DAL', 'G-1:move:RICE']);

    const r = new Ledger(new InMemoryLedgerStore());
    commitReturn(ret([{ productId: 'SOAP', quantityMinor: 1, disposition: 'resell' }, { productId: 'OIL', quantityMinor: 1, disposition: 'quarantine' }]), r, new SyncOutbox());
    expect(keys(r)).toEqual(['return-move:R-1:SOAP', 'return-move:R-1:OIL']);
    expect(ids(r)).toEqual(['R-1:move:SOAP', 'R-1:move:OIL']);
  });

  it('a ledger holding what the OLD code wrote for a sale, a receipt and a return takes the same documents again with no new movement', () => {
    // Exactly the events the code before this fix appended (product-keyed), written into the ledger by hand.
    const ledger = new Ledger(new InMemoryLedgerStore());
    const old = (id: string, key: string, productId: string, deltaMinor: number) =>
      ledger.append(makeEvent({ id, type: 'InventoryMoved', occurredAt: '2026-11-26T10:00:00Z', idempotencyKey: key, source: 'old-build', payload: { productId, deltaMinor, uom: 'ea' } }));
    old('S-1:move:MILK', 'sale-move:S-1:MILK', 'MILK', -2);
    old('S-1:move:BREAD', 'sale-move:S-1:BREAD', 'BREAD', -1);
    old('G-1:move:DAL', 'grn-move:G-1:DAL', 'DAL', 10);
    old('R-1:move:SOAP', 'return-move:R-1:SOAP', 'SOAP', 1);
    expect(ledger.entries()).toHaveLength(4);
    const before = total(ledger);

    // The till re-syncs / the outbox replays the same documents on the new build.
    const outbox = new SyncOutbox();
    commitSale(sale([{ productId: 'MILK', quantityMinor: 2, uom: 'ea' }, { productId: 'BREAD', quantityMinor: 1, uom: 'ea' }]), ledger, outbox);
    commitReceipt(receipt([{ productId: 'DAL', quantityMinor: 10, uom: 'ea' }]), ledger, outbox);
    commitReturn(ret([{ productId: 'SOAP', quantityMinor: 1, disposition: 'resell' }]), ledger, outbox);

    expect(ledger.entries()).toHaveLength(4);
    expect(total(ledger)).toBe(before);
  });

  it('a document with a repeated product, committed twice on the new build, moves each line exactly once', () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const lines = [{ productId: 'MILK', quantityMinor: 2, uom: 'ea' }, { productId: 'MILK', quantityMinor: 3, uom: 'ea' }];
    commitSale(sale(lines), ledger, outbox);
    commitSale(sale(lines), ledger, outbox);
    commitReceipt(receipt(lines), ledger, outbox);
    commitReceipt(receipt(lines), ledger, outbox);
    expect(ledger.entries()).toHaveLength(4);
    expect(total(ledger)).toBe(-5 + 5);
    expect(outbox.unsentCount()).toBe(2);
  });
});
