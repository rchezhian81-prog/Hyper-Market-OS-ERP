import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { CatalogueCache, ExpiredItemError, RecalledItemError, type CatalogueSnapshot, type CatalogueProduct } from '../../packages/catalogue/src/catalogue';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/sale-intake';
import { resolvePrice, type PriceEntry } from '../../packages/price-list/src/price-list';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';
import { money } from '../../packages/contracts/src/money';

// D-20 / SF-08 at the till's own surface (the view adapter the served page binds to) and at head office's intake:
//   • a 2D code's batch and use-by date ride on the basket line and on the sale record the box writes;
//   • a batch under markdown is charged its markdown price; the plain barcode the product's price;
//   • the lane judges the use-by against ITS OWN calendar day, not UTC midnight (no time-of-day trap);
//   • head office flags a sale of a blocked batch, and does NOT flag its sibling batch (OB-139 "A").

const PANEER = '8901000000019';
const GTIN = `0${PANEER}`;
const paneer = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: 'p-paneer', sku: 'SKU-PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 90_00, taxBps: 500, status: 'active', ...over,
});

function till(product: CatalogueProduct, clock: string) {
  const records: Record<string, unknown>[] = [];
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: clock.slice(0, 10), currency: 'INR', defaultTaxRate: taxRateFromPercent(5), clock: () => clock },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    (_id, record) => { records.push(JSON.parse(String(record)) as Record<string, unknown>); return Promise.resolve({ committed: true as const, durable: true as const, detail: 'ok', laneMessage: 'Sale complete.' }); },
  );
  const snapshot: CatalogueSnapshot = { tenantId: 't', version: 1, builtAt: clock, products: [product], barcodes: [{ code: PANEER, productId: product.productId, kind: 'standard' }] };
  return { view: createPosView(session, 'INR', new CatalogueCache(snapshot)), records, session };
}

describe('D-20: the served till carries a 2D batch onto the bill', () => {
  it('the line carries the batch and use-by; a marked-down batch is charged its markdown; the record keeps both', async () => {
    const { view, records } = till(paneer({ batchPrices: [{ batchId: 'B-3', unitPriceMinor: 45_00 }] }), '2030-06-10T06:00:00.000Z');
    const plain = view.scanBarcode(PANEER);
    expect(plain).toMatchObject({ amountMinor: 90_00 });
    expect(plain.batchId).toBeUndefined();
    const marked = view.scanBarcode(`(01)${GTIN}(17)300615(10)B-3`);
    expect(marked).toMatchObject({ amountMinor: 45_00, batchId: 'B-3', batchExpiry: '2030-06-15', markdown: true });
    expect(view.basket().map((l) => [l.unitPriceMinor, l.batchId])).toEqual([[90_00, undefined], [45_00, 'B-3']]);
    expect(view.payableMinor()).toBe(135_00);
    await view.tenderCash('S-1', 'R-1', '2030-06-10T06:01:00.000Z');
    const lines = records[0]!['lines'] as { batchId?: string; batchExpiry?: string; unitPriceMinor: number }[];
    expect(lines[0]!.batchId).toBeUndefined();
    expect(lines[1]).toMatchObject({ batchId: 'B-3', batchExpiry: '2030-06-15', unitPriceMinor: 45_00 });
  });

  it('an expired batch is refused at the lane by its own calendar day, and nothing joins the bill', () => {
    const { view } = till(paneer(), '2030-06-10T06:00:00.000Z');
    expect(() => view.scanBarcode(`(01)${GTIN}(17)300609(10)B-1`)).toThrow(ExpiredItemError);
    expect(view.basket()).toEqual([]);
    expect(view.scanBarcode(`(01)${GTIN}(17)300610(10)B-1`).batchExpiry).toBe('2030-06-10'); // the last sellable day sells
  });

  it('a recalled batch is refused by name and its sibling sells, through the view the page binds to', () => {
    const { view } = till(paneer({ recallBlock: true, blockedBatches: ['B-1'] }), '2030-06-10T06:00:00.000Z');
    expect(() => view.scanBarcode(`(01)${GTIN}(10)B-1`)).toThrow(RecalledItemError);
    expect(() => view.scanBarcode(PANEER)).toThrow(/Paneer 200g/);
    expect(view.scanBarcode(`(01)${GTIN}(10)B-2`).batchId).toBe('B-2');
  });
});

describe('D-20: a batch markdown is a price for that batch only', () => {
  const entry = (over: Partial<PriceEntry>): PriceEntry => ({
    id: 'e', productId: 'p-paneer', scope: 'store', scopeRef: 's1', price: money(90_00, 'INR'), effectiveFrom: '2030-01-01', status: 'active', version: 1, ...over,
  });
  it('resolvePrice never answers the product price with a batch price, and the pack carries the batch price separately', () => {
    const entries = [entry({ id: 'base' }), entry({ id: 'md', price: money(45_00, 'INR'), effectiveFrom: '2030-06-01', version: 1, batchId: 'B-3' })];
    expect(resolvePrice(entries, { productId: 'p-paneer', at: '2030-06-10', storeId: 's1' })!.id).toBe('base');
    expect(resolvePrice(entries, { productId: 'p-paneer', at: '2030-06-10', storeId: 's1', batchId: 'B-3' })!.id).toBe('md');
    expect(resolvePrice(entries, { productId: 'p-paneer', at: '2030-06-10', storeId: 's1', batchId: 'B-9' })).toBeNull();
    const built = buildCatalogueSnapshot({
      scope: { tenantId: 't', storeId: 's1' }, version: 1, asOf: '2030-06-10T00:00:00.000Z',
      products: [{ productId: 'p-paneer', sku: 'P', name: 'Paneer', baseUom: 'ea', taxClassId: 'h', status: 'active', mrpMinor: 95_00 }],
      barcodes: [], priceEntries: [...entries, entry({ id: 'over-mrp', price: money(99_00, 'INR'), batchId: 'B-4' })], taxClasses: { h: 500 },
    });
    expect(built.snapshot.products[0]).toMatchObject({ unitPriceMinor: 90_00, batchPrices: [{ batchId: 'B-3', unitPriceMinor: 45_00 }] });
  });
});

describe('SF-08: head office backstops a blocked-batch sale and leaves its sibling alone', () => {
  const ctx = (product: CatalogueProduct): IntakeContext => ({
    catalogue: new Map([[product.productId, product]]), currentPackVersion: 1, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2030-06-10T10:00:00.000Z',
  });
  const sale = (batchId?: string): IncomingSale => ({
    saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'clerk-1', tradingDay: '2030-06-10', committedAt: '2030-06-10T10:00:00.000Z',
    totalMinor: 90_00, currency: 'INR', packVersion: 1, tenders: [{ kind: 'cash', amountMinor: 90_00 }],
    lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 90_00, lineTotalMinor: 90_00, ...(batchId === undefined ? {} : { batchId }) }],
  });
  const recalled = (s: IncomingSale, p: CatalogueProduct) => acceptSale(s, ctx(p)).exceptions.filter((e) => e.kind === 'sold_a_recalled_product');
  it('a sale naming the blocked batch is critical and names the batch; a sibling batch is not flagged; no batch is the whole product', () => {
    const p = paneer({ recallBlock: true, blockedBatches: ['B-1'] });
    expect(recalled(sale('B-1'), p)).toEqual([expect.objectContaining({ severity: 'critical', detail: expect.stringContaining('recalled batch B-1') })]);
    expect(recalled(sale('B-2'), p)).toEqual([]);
    expect(recalled(sale(), p)).toHaveLength(1);
    expect(recalled(sale('B-2'), paneer({ recallBlock: true }))).toHaveLength(1); // a block on the product itself: every batch
  });
});
