import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **An age-restricted sale reaches head office carrying its check — and one without a check is a critical finding
 * (M12-FR-04 · Wave 2b · audit PF-03 · hard rules #1 and #10 · P-08).**
 *
 * The whole path on real code: the REAL till (`bootPos`, the shop's pack with a 21+ beer) asks, records the answer in the
 * signed-in cashier's name and writes the sale to its disk; the store computer maps that record for head office exactly
 * as it does in the shop (`toCloudSale`); head office banks it through the real API and the real catalogue it published.
 * A sale whose restricted line carries the check raises no age finding. A sale from a till that never asked — an old
 * till, a pack that predates the restriction — is banked (the goods are gone) and raised CRITICAL on the exceptions
 * register the manager reads, ranked above a money variance. Synthetic data only (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-05T11:00:00.000Z';

const SNAPSHOT: CatalogueSnapshot = {
  tenantId: A, version: 1, builtAt: AT,
  products: [
    { productId: 'p-rice', sku: 'RICE', name: 'Rice 1kg', baseUom: 'ea', unitPriceMinor: 10_000, taxBps: 0, status: 'active' },
    { productId: 'p-beer', sku: 'BEER', name: 'Beer 650ml', baseUom: 'ea', unitPriceMinor: 22_000, taxBps: 0, status: 'active', regulatedFlags: { minimumAge: 21 } },
  ],
  barcodes: [
    { code: '8900000000011', productId: 'p-rice', kind: 'standard' },
    { code: '8900000000035', productId: 'p-beer', kind: 'standard' },
  ],
};

interface Banked { banked: boolean; exceptions: { kind: string; severity: string; productId?: string }[] }
const kinds = (res: { body: unknown }): string[] => (res.body as Banked).exceptions.map((e) => e.kind);

async function headOffice(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-meena', 'cashier');
  await h.provisionRole(A, 'u-box', 'cashier'); // the store computer's sync identity
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { ...SNAPSHOT, scope: { tenantId: A, storeId: 'store-1' } } },
  }));
  return h;
}

/** Ring a sale on the REAL till and hand back the record the store computer would send head office. */
async function ringOnTheTill(ask: boolean): Promise<unknown> {
  const written: unknown[] = [];
  const view = bootPos({
    laneId: 'lane-3', tradingDay: '2026-10-05', catalogue: SNAPSHOT,
    durable: async (_id, record) => { written.push(JSON.parse(record)); return { committed: true, durable: true, detail: 'test', laneMessage: 'saved' }; },
  });
  view.signIn('u-meena');
  view.scanBarcode('8900000000011');
  if (ask) {
    view.confirmAge(21, AT, 'p-beer');
    view.scanBarcode('8900000000035');
  }
  await view.tenderCash('S-1', 'R-0001', AT);
  return toCloudSale(written[0], 1, 'store-1', 'lane-3');
}

describe('an age-restricted sale reaches head office carrying its check (PF-03)', () => {
  it('the till that asked: the check travels on the line, through the store computer, and head office raises no age finding', async () => {
    const h = await headOffice();
    const sale = await ringOnTheTill(true) as { lines: { productId: string; ageCheck?: Record<string, unknown> }[] };
    expect(sale.lines.find((l) => l.productId === 'p-beer')?.ageCheck).toEqual({ minimumAge: 21, confirmedAtLeast: 21, confirmedBy: 'u-meena', confirmedAt: AT });
    const res = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: 'k-asked', body: sale });
    expect(res.status).toBe(202);
    expect((res.body as Banked).banked).toBe(true);
    expect(kinds(res)).not.toContain('age_restricted_sold_without_check');
  });

  it('a till that never asked: banked (the goods are gone), raised CRITICAL first, and on the register the manager reads', async () => {
    const h = await headOffice();
    // An old till's record: the beer on the bill with no check, and a ₹1 tender variance beside it.
    const sale = {
      saleId: 'S-OLD', receiptNumber: 'R-0099', laneId: 'lane-9', cashierId: 'u-meena', tradingDay: '2026-10-05', committedAt: AT,
      totalMinor: 22_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-beer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 22_000, lineTotalMinor: 22_000, taxRateBps: 0 }],
      tenders: [{ kind: 'cash', amountMinor: 21_900 }],
    };
    const res = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: 'k-old', body: sale });
    expect(res.status).toBe(202);
    expect((res.body as Banked).banked).toBe(true);
    expect((res.body as Banked).exceptions[0]).toMatchObject({ kind: 'age_restricted_sold_without_check', severity: 'critical', productId: 'p-beer' });

    const register = await h.request({ method: 'GET', path: '/v1/sales/exceptions', userId: 'u-owner', tenantId: A });
    expect(register.status).toBe(200);
    expect(JSON.stringify(register.body)).toContain('age_restricted_sold_without_check');
  });
});
