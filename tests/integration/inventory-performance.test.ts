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
interface PerfBody {
  period: { from: string; to: string; days: number };
  cogs: { minor: number; currency: string };
  averageInventory: { minor: number };
  netSales: { minor: number } | null;
  grossMargin: { minor: number } | null;
  turns: Ratio;
  annualisedTurns: Ratio;
  daysOfCover: Ratio;
  gmroi: Ratio;
  method: string;
}

const base = { locationId: 'L1', uom: 'each', enteredBy: 'u-owner' };
const move = (h: ApiHarness, tenantId: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId, idempotencyKey: `mv-${m['movementId']}`, body: m });

const perf = (h: ApiHarness, tenantId: string, userId: string, query?: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/inventory/performance', userId, tenantId, ...(query === undefined ? {} : { query }) });

// A committed sale, seeded directly on the sales ledger the way the POS bank-sale path writes it.
const seedSale = (h: ApiHarness, tenantId: string, saleId: string, occurredAt: string, lines: { productId: string; quantityMinor: number; lineTotalMinor: number }[]) =>
  h.store.append(tenantId, STREAM.sales, makeEvent({
    id: `sale-${saleId}`, type: 'SaleCommitted', occurredAt,
    idempotencyKey: `sale-${tenantId}-${saleId}`, source: 'test/pos',
    payload: { saleId, committedAt: occurredAt, totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0), currency: 'INR', lines: lines.map((l) => ({ ...l, uom: 'each', unitPriceMinor: Math.round(l.lineTotalMinor / l.quantityMinor) })) },
  }));

// A published catalogue carrying each product's tax rate (basis points) — what de-grosses revenue.
const seedCatalogue = (h: ApiHarness, tenantId: string, products: { productId: string; taxBps: number }[]) =>
  h.store.append(tenantId, STREAM.catalogue, makeEvent({
    id: 'pack-1', type: 'CataloguePublished', occurredAt: FROM,
    idempotencyKey: `catalogue-${tenantId}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId, version: 1, builtAt: FROM, products, barcodes: [] } },
  }));

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
