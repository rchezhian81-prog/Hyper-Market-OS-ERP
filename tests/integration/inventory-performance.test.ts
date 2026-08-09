import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

// Stock productivity — turns and GMROI — end to end through the real API (M08-FR-04, API-04). "Is the
// money tied up in stock working, or sitting there dying?" TURNS (COGS ÷ average inventory) and
// days-of-cover are pure inventory, folded at weighted-average from the movement ledger over a
// period. GMROI (gross margin ÷ average inventory) needs revenue, so net sales are taken from the POS
// ledger de-grossed by the catalogue's tax rate; when a sold product has no known tax rate, GMROI is
// reported as NOT MEANINGFUL — never a guessed number (P-08). This proves the cross-domain wire.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-12-31T00:00:00.000Z';

interface Ratio { kind: 'ratio' | 'not_meaningful'; bp?: number; because?: string }
interface PerfRow {
  cogs: { minor: number; currency: string };
  averageInventory: { minor: number };
  netSales: { minor: number } | null;
  grossMargin: { minor: number } | null;
  turns: Ratio;
  annualisedTurns: Ratio;
  daysOfCover: Ratio;
  gmroi: Ratio;
}
interface PerfBody extends PerfRow {
  period: { from: string; to: string; days: number };
  byProduct: (PerfRow & { productId: string })[];
  method: string;
}

const base = { locationId: 'L1', uom: 'each', enteredBy: 'u-owner' };
const move = (h: ApiHarness, tenantId: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId, idempotencyKey: `mv-${m['movementId']}`, body: m });

const perf = (h: ApiHarness, tenantId: string, userId: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/inventory/performance', userId, tenantId, ...(query === undefined ? {} : { query }) });

// A committed sale, seeded directly on the sales ledger the way the POS bank-sale path writes it.
const seedSale = (h: ApiHarness, tenantId: string, saleId: string, occurredAt: string, lines: { productId: string; quantityMinor: number; lineTotalMinor: number }[]) => {
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  return h.store.append(tenantId, STREAM.sales, makeEvent({
    id: `sale-${saleId}`, type: 'SaleCommitted', occurredAt,
    idempotencyKey: `sale-${tenantId}-${saleId}`, source: 'test/pos',
    payload: {
      saleId, receiptNumber: saleId, laneId: 'L1', cashierId: 'u-owner', tradingDay: occurredAt.slice(0, 10),
      committedAt: occurredAt, totalMinor, currency: 'INR', packVersion: 1,
      lines: lines.map((l) => ({ ...l, uom: 'each', unitPriceMinor: Math.round(l.lineTotalMinor / l.quantityMinor) })),
      tenders: [{ kind: 'cash', amountMinor: totalMinor }],
    },
  }));
};

// A published catalogue carrying each product's tax rate (basis points) — what de-grosses revenue.
const seedCatalogue = (h: ApiHarness, tenantId: string, products: { productId: string; taxBps: number }[]) =>
  h.store.append(tenantId, STREAM.catalogue, makeEvent({
    id: 'pack-1', type: 'CataloguePublished', occurredAt: FROM,
    idempotencyKey: `catalogue-${tenantId}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId, version: 1, builtAt: FROM, products, barcodes: [] } },
  }));

// Record a return against a banked sale, through the real API (which appends the returns projection).
const recordReturn = (h: ApiHarness, tenantId: string, saleId: string, ret: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: 'u-owner', tenantId, idempotencyKey: `ret-${ret['returnId']}`, body: ret });

const returnOf = (returnId: string, refundMinor: number, lines: { productId: string; quantityMinor: number; disposition: string }[]) => ({
  returnId, number: returnId, processedBy: 'u-owner', reasonCode: 'changed_mind',
  refundMinor, refundTender: 'cash', approvalThresholdMinor: 1_000_000, processedAt: '2026-06-15T10:00:00.000Z',
  lines: lines.map((l) => ({ ...l, uom: 'each' })),
});

describe('stock productivity — turns and GMROI over a period (M08-FR-04, API-04)', () => {
  it('computes turns and days-of-cover from inventory, and GMROI is not meaningful without a tax rate', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // 100 @ ₹10.00 received in March, 40 sold in June → COGS 40,000; value 60,000; avg (0+60,000)/2 = 30,000.
    await move(h, A, { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 40, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'SALE-1', '2026-06-01T10:00:00.000Z', [{ productId: 'P1', quantityMinor: 40, lineTotalMinor: 59000 }]);

    const body = (await perf(h, A, 'u-owner', { from: FROM, to: TO })).body as PerfBody;
    expect(body.method).toBe('weighted_average');
    expect(body.period.days).toBe(364);
    expect(body.cogs.minor).toBe(40000);
    expect(body.averageInventory.minor).toBe(30000);
    // Turns = 40,000 / 30,000 = 1.3333× (13,333 bp); days of cover = 30,000 × 364 / 40,000 = 273 days.
    expect(body.turns).toMatchObject({ kind: 'ratio', bp: 13333 });
    expect(body.daysOfCover).toMatchObject({ kind: 'ratio', bp: 2730000 });
    // No catalogue → the sold product's tax rate is unknown → revenue cannot be stated net of tax.
    expect(body.netSales).toBeNull();
    expect(body.grossMargin).toBeNull();
    expect(body.gmroi.kind).toBe('not_meaningful');

    // The per-product breakdown carries the same figures for P1, with its margin equally absent.
    expect(body.byProduct).toHaveLength(1);
    expect(body.byProduct[0]).toMatchObject({ productId: 'P1', cogs: { minor: 40000 }, averageInventory: { minor: 30000 }, netSales: null, turns: { kind: 'ratio', bp: 13333 } });
    expect(body.byProduct[0]!.gmroi.kind).toBe('not_meaningful');
  });

  it('computes GMROI once the catalogue supplies the tax rate (revenue net of tax)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 40, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'SALE-1', '2026-06-01T10:00:00.000Z', [{ productId: 'P1', quantityMinor: 40, lineTotalMinor: 59000 }]);
    await seedCatalogue(h, A, [{ productId: 'P1', taxBps: 1800 }]); // 18% GST

    const body = (await perf(h, A, 'u-owner', { from: FROM, to: TO })).body as PerfBody;
    // ₹590.00 gross ÷ 1.18 = ₹500.00 net sales; margin = 50,000 − 40,000 COGS = 10,000.
    expect(body.netSales).toEqual({ minor: 50000, currency: 'INR' });
    expect(body.grossMargin).toEqual({ minor: 10000, currency: 'INR' });
    // GMROI = 10,000 / 30,000 = 0.33× — below 1.0×, the line returns less cash than it ties up.
    expect(body.gmroi).toMatchObject({ kind: 'ratio', bp: 3333 });

    // The single product's row equals the store total when there is only one product.
    expect(body.byProduct).toHaveLength(1);
    expect(body.byProduct[0]).toMatchObject({ productId: 'P1', netSales: { minor: 50000 }, grossMargin: { minor: 10000 }, gmroi: { kind: 'ratio', bp: 3333 } });
  });

  it('breaks turns and GMROI down per product, and the store total is their sum', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    // P1: 100 @ ₹10 received, 40 sold → COGS 40,000, avg inv 30,000; net sales ₹500, margin 10,000.
    await move(h, A, { movementId: 'p1r', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 'p1s', productId: 'P1', kind: 'sold', quantityMinor: 40, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'S1', '2026-06-01T10:00:00.000Z', [{ productId: 'P1', quantityMinor: 40, lineTotalMinor: 59000 }]);
    // P2: 50 @ ₹20 received, 10 sold → COGS 20,000, avg inv 40,000; net sales ₹250, margin 5,000.
    await move(h, A, { movementId: 'p2r', productId: 'P2', kind: 'received', quantityMinor: 50, unitCostMinor: 2000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 'p2s', productId: 'P2', kind: 'sold', quantityMinor: 10, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'S2', '2026-06-01T10:00:00.000Z', [{ productId: 'P2', quantityMinor: 10, lineTotalMinor: 26250 }]);
    await seedCatalogue(h, A, [{ productId: 'P1', taxBps: 1800 }, { productId: 'P2', taxBps: 500 }]);

    const body = (await perf(h, A, 'u-owner', { from: FROM, to: TO })).body as PerfBody;
    const rows = new Map(body.byProduct.map((r) => [r.productId, r]));
    expect(rows.get('P1')).toMatchObject({ cogs: { minor: 40000 }, netSales: { minor: 50000 }, grossMargin: { minor: 10000 }, gmroi: { kind: 'ratio', bp: 3333 } });
    // P2's ₹262.50 gross at 5% GST = ₹250.00 net; margin 5,000; GMROI 5,000 / 40,000 = 0.125×.
    expect(rows.get('P2')).toMatchObject({ cogs: { minor: 20000 }, netSales: { minor: 25000 }, grossMargin: { minor: 5000 }, gmroi: { kind: 'ratio', bp: 1250 } });

    // The store total is the sum of the products: COGS 60,000, net sales 75,000, margin 15,000.
    expect(body.cogs.minor).toBe(60000);
    expect(body.averageInventory.minor).toBe(70000);
    expect(body.netSales).toEqual({ minor: 75000, currency: 'INR' });
    expect(body.grossMargin).toEqual({ minor: 15000, currency: 'INR' });
    expect(body.gmroi).toMatchObject({ kind: 'ratio', bp: 2143 });
  });

  it('nets a RESELL return out of sales AND cost — the goods come back sellable', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 40, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'SALE-1', '2026-06-01T10:00:00.000Z', [{ productId: 'P1', quantityMinor: 40, lineTotalMinor: 59000 }]);
    await seedCatalogue(h, A, [{ productId: 'P1', taxBps: 1800 }]);
    // 10 of the 40 come back, resold: refund ₹147.50 (10 × ₹14.75), i.e. ₹125.00 net of 18% GST.
    expect((await recordReturn(h, A, 'SALE-1', returnOf('RET-1', 14750, [{ productId: 'P1', quantityMinor: 10, disposition: 'resell' }]))).status).toBe(201);

    const body = (await perf(h, A, 'u-owner', { from: FROM, to: TO })).body as PerfBody & { returns: { minor: number } | null };
    // Net sales 50,000 − 12,500 returned = 37,500. COGS 40,000 − (10 × ₹10 WAC) 10,000 = 30,000.
    expect(body.netSales).toEqual({ minor: 37500, currency: 'INR' });
    expect(body.returns).toEqual({ minor: 12500, currency: 'INR' });
    expect(body.cogs.minor).toBe(30000);
    expect(body.grossMargin).toEqual({ minor: 7500, currency: 'INR' });
    // GMROI = 7,500 / 30,000 = 0.25×.
    expect(body.gmroi).toMatchObject({ kind: 'ratio', bp: 2500 });
    expect(body.byProduct[0]).toMatchObject({ productId: 'P1', returns: { minor: 12500 }, grossMargin: { minor: 7500 } });
  });

  it('nets a DAMAGED return out of sales but NOT cost — the goods are a loss, not stock', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: '2026-03-01T10:00:00.000Z', ...base });
    await move(h, A, { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 40, occurredAt: '2026-06-01T10:00:00.000Z', ...base });
    await seedSale(h, A, 'SALE-1', '2026-06-01T10:00:00.000Z', [{ productId: 'P1', quantityMinor: 40, lineTotalMinor: 59000 }]);
    await seedCatalogue(h, A, [{ productId: 'P1', taxBps: 1800 }]);
    // Same refund, but the goods come back DAMAGED — their cost stays in COGS.
    await recordReturn(h, A, 'SALE-1', returnOf('RET-1', 14750, [{ productId: 'P1', quantityMinor: 10, disposition: 'damaged' }]));

    const body = (await perf(h, A, 'u-owner', { from: FROM, to: TO })).body as PerfBody;
    expect(body.netSales).toEqual({ minor: 37500, currency: 'INR' }); // sales still fall
    expect(body.cogs.minor).toBe(40000); // cost does NOT — the 10 units are written off, not restocked
    // Margin 37,500 − 40,000 = −2,500: refunding damaged goods lost money on those units.
    expect(body.grossMargin).toEqual({ minor: -2500, currency: 'INR' });
  });

  it('is per-tenant and authorized: a cashier cannot read it (403), and an empty tenant is honest not zero', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, A, { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 10, unitCostMinor: 700, occurredAt: '2026-03-01T10:00:00.000Z', ...base });

    expect((await perf(h, A, 'u-cash', { from: FROM, to: TO })).status).toBe(403);

    await h.seedOwner(B, 'u-owner-b');
    const b = (await perf(h, B, 'u-owner-b')).body as PerfBody;
    expect(b.cogs.minor).toBe(0);
    expect(b.averageInventory.minor).toBe(0);
    // No stock held → turns and GMROI are not meaningful, never a fabricated 0.00×.
    expect(b.turns.kind).toBe('not_meaningful');
    expect(b.gmroi.kind).toBe('not_meaningful');
  });
});
