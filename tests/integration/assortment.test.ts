import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Store assortment / range management, end to end (M04-FR-01 · D02, API-04). The range answers "does THIS
// store carry this item?", enforced both ways: an item sold here must be in the range, an item not listed is
// not reordered. The dangerous operation is DROPPING — a drop WITH stock on hand routes to clearance rather
// than deleting (which would make the stock invisible: not counted, not replenished, eventually written off).
// Every decision is effective-dated and names its reason + who made it. Gated merchandising.range.manage
// (list/drop) / merchandising.range.read (integrity + read).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const list = (h: ApiHarness, u: string, store: string, product: string, effectiveFrom: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/assortment/${store}/${product}/list`, userId: u, tenantId: A, idempotencyKey: key ?? `l-${store}-${product}`, body: { effectiveFrom } });
const drop = (h: ApiHarness, u: string, store: string, product: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/assortment/${store}/${product}/drop`, userId: u, tenantId: A, idempotencyKey: key ?? `d-${store}-${product}`, body });
const integrity = (h: ApiHarness, u: string, store: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/merchandising/assortment/${store}/integrity`, userId: u, tenantId: A, idempotencyKey: key ?? `i-${store}`, body });
const rangeGet = (h: ApiHarness, u: string, store: string, onDate?: string) =>
  h.request({ method: 'GET', path: `/v1/merchandising/assortment/${store}`, userId: u, tenantId: A, query: onDate ? { onDate } : {} });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

// FUL-11: the drop and the integrity check read the STORE'S stock from head office's ledger — so the stock is put there
// (and sold off) through the real routes, never typed into the request.
const receiveAt = (h: ApiHarness, store: string, product: string, qty: number) =>
  h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: `rx-${store}-${product}`,
    body: { movementId: `rx-${store}-${product}`, productId: product, locationId: store, kind: 'received', quantityMinor: qty, unitCostMinor: 1000, uom: 'each', occurredAt: '2026-01-02T09:00:00.000Z', enteredBy: 'u-owner' },
  });
const sellAt = (h: ApiHarness, store: string, product: string, qty: number) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: `sale-${store}-${product}`,
    body: {
      saleId: `sale-${store}-${product}`, receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner', tradingDay: '2026-03-01',
      committedAt: '2026-03-01T10:00:00.000Z', totalMinor: qty * 2000, currency: 'INR', packVersion: 1, locationId: store,
      lines: [{ productId: product, quantityMinor: qty, uom: 'each', unitPriceMinor: 2000, lineTotalMinor: qty * 2000 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 2000 }],
    },
  });

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // range.manage + range.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('assortment / range management (M04-FR-01)', () => {
  it('lists items, then a drop with stock goes to clearance and a drop with none delists', async () => {
    const h = await seeded();
    await list(h, 'u-mgr', 's1', 'p1', '2026-01-01');
    await list(h, 'u-mgr', 's1', 'p2', '2026-01-01');
    expect(((await rangeGet(h, 'u-owner', 's1', '2026-08-24')).body as { listed: string[] }).listed).toEqual(['p1', 'p2']);
    expect((await receiveAt(h, 's1', 'p1', 500)).status).toBe(202);

    // The ledger says 500 of p1 are in the store: clearance — whatever figure (if any) the request carries.
    const clr = await drop(h, 'u-mgr', 's1', 'p1', { reason: 'poor_sales', effectiveFrom: '2026-08-01' });
    expect(clr.status).toBe(201);
    expect(clr.body).toMatchObject({ outcome: 'routed_to_clearance', status: 'clearance', onHandMinor: 500, onHandFrom: 'head_office_stock_ledger' });
    // A request claiming "none on hand" for p2 is believed only because the ledger agrees (there is none).
    const del = await drop(h, 'u-mgr', 's1', 'p2', { onHandMinor: 0, reason: 'supplier_discontinued', effectiveFrom: '2026-08-01' });
    expect(del.body).toMatchObject({ outcome: 'delisted', status: 'delisted', onHandMinor: 0 });

    // Neither is "carried" any more — clearance sells down, it is not part of the live range.
    expect(((await rangeGet(h, 'u-owner', 's1', '2026-08-24')).body as { listed: string[] }).listed).toEqual([]);
  });

  it('flags ordering what you do not sell, selling what you do not stock, and dead range', async () => {
    const h = await seeded();
    await list(h, 'u-mgr', 's2', 'p-listed', '2026-01-01');
    await list(h, 'u-mgr', 's2', 'p-neversold', '2026-01-01');
    await list(h, 'u-mgr', 's2', 'p-clr', '2026-01-01');
    await receiveAt(h, 's2', 'p-clr', 100);
    expect((await drop(h, 'u-mgr', 's2', 'p-clr', { reason: 'poor_sales', effectiveFrom: '2026-02-01' })).body).toMatchObject({ status: 'clearance' }); // 100 held
    // The ledger itself says what sold here: the clearance stock sold out, and an item never ranged here was sold.
    await sellAt(h, 's2', 'p-clr', 100);
    await receiveAt(h, 's2', 'p-ghost', 5);
    await sellAt(h, 's2', 'p-ghost', 1);

    const res = await integrity(h, 'u-mgr', 's2', {
      onDate: '2026-08-24',
      soldProductIds: ['p-listed'],            // the till's own report, added to what the ledger recorded selling
      reorderedProductIds: ['p-clr'],          // clearance is not reordered
      onHand: { 'p-clr': 999 },                // a typed figure — ignored: the ledger says 0, the clearance is finished
    });
    expect((res.body as { factsFrom: string }).factsFrom).toBe('head_office_stock_ledger');
    expect(res.status).toBe(200);
    const issues = (res.body as { issues: { productId: string; finding: string }[]; count: number });
    const has = (productId: string, finding: string) => issues.issues.some((i) => i.productId === productId && i.finding === finding);
    expect(has('p-ghost', 'sold_not_in_assortment')).toBe(true);
    expect(has('p-clr', 'reordered_not_listed')).toBe(true);
    expect(has('p-clr', 'clearance_with_no_stock')).toBe(true);
    expect(has('p-neversold', 'listed_never_sold')).toBe(true);
    expect(issues.count).toBe(4);
  });

  it('refuses a nonsense drop and is gated to range staff', async () => {
    const h = await seeded();
    // "replaced" must say what replaced it, or the customer is simply told no.
    expect(codeOf(await drop(h, 'u-mgr', 's3', 'p1', { onHandMinor: 10, reason: 'replaced_by_alternative', effectiveFrom: '2026-08-01' }, 'd-repl'))).toBe('range_decision_refused');
    expect((await list(h, 'u-cash', 's3', 'p1', '2026-01-01', 'l-cash')).status).toBe(403);
    expect((await drop(h, 'u-cash', 's3', 'p1', { onHandMinor: 0, reason: 'poor_sales', effectiveFrom: '2026-08-01' }, 'd-cash')).status).toBe(403);
    expect((await integrity(h, 'u-cash', 's3', { onDate: '2026-08-24', soldProductIds: [] }, 'i-cash')).status).toBe(403);
    expect((await rangeGet(h, 'u-cash', 's3')).status).toBe(403);
    expect(codeOf(await list(h, 'u-mgr', 's3', 'p1', 'not-a-date', 'l-bad'))).toBe('not_readable_as_a_listing');
    expect(codeOf(await drop(h, 'u-mgr', 's3', 'p2', { onHandMinor: -1, reason: 'poor_sales', effectiveFrom: '2026-08-01' }, 'd-bad'))).toBe('not_readable_as_a_drop');
  });

  it('resolves the range as-at a date and survives a restart', async () => {
    const h = await seeded();
    await list(h, 'u-mgr', 's4', 'p1', '2026-06-01');
    expect(((await rangeGet(h, 'u-owner', 's4', '2026-05-01')).body as { listed: string[] }).listed).toEqual([]); // before it takes effect
    expect(((await rangeGet(h, 'u-owner', 's4', '2026-07-01')).body as { listed: string[] }).listed).toEqual(['p1']);

    const restarted = apiHarness({ store: h.store });
    expect(((await rangeGet(restarted, 'u-owner', 's4', '2026-07-01')).body as { listed: string[] }).listed).toEqual(['p1']);
  });
});
