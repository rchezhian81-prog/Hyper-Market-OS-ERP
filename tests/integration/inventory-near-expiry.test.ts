import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M10-FR-01 (A03 "Inventory" · ADR-0006 · ADR-0015): near-expiry stock on the live API — the STATEFUL read
// that answers "what is on the shelves now and close to (or past) its use-by?". It proves the ADR-0015 wire
// end to end: a batch-tracked goods receipt now carries its expiry onto the cloud stock ledger, and this read
// folds those received batches, NETS what has already sold (FIFO-by-receipt, ADR-0006) and what was wasted,
// and returns the batches still on hand that are expired (dispose) or near expiry (markdown), worst-first.
// It is a pure READ — gated inventory.availability.read, it writes nothing (P-05: nothing is committed here).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const POLICY = { excessToleranceBp: 500, shortageToleranceBp: 200, nearExpiryDays: 7 };
const cost = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface NEItem { readonly batchId: string; readonly productId: string; readonly action: string; readonly qty: number; readonly expiry: string }
interface NEBody { readonly items: readonly NEItem[]; readonly count: number; readonly markdownCount: number; readonly disposeCount: number; readonly asOf: string; readonly nearExpiryDays: number }

const grnLine = (extra: Record<string, unknown> = {}) =>
  ({ lineId: 'L1', productId: 'milk-1l', orderedMinor: 100, countedMinor: 100, uom: 'each', unitCost: cost(5000), condition: 'good', ...extra });

const receive = (h: ApiHarness, u: string, grnId: string, lines: unknown[], rules: unknown[], key: string, receivedOnDate = '2026-09-05') =>
  h.request({
    method: 'POST', path: `/v1/inventory/goods-receipt/${grnId}`, userId: u, tenantId: A, idempotencyKey: key,
    body: { warehouseId: 'wh1', receivedOnDate, currency: INR, lines, rules, policy: POLICY },
  });

// A banked sale whose line carries the batch — the OUTBOUND the near-expiry read nets against on-hand.
// Money fields mirror the proven `/v1/sales` shape (total == line total == tender); only quantity/batch matter here.
const sell = (h: ApiHarness, u: string, saleId: string, productId: string, batchId: string, qtyMinor: number, key: string, tradingDay = '2026-09-12') =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: key,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T10:00:00Z`, totalMinor: 5000, currency: INR, packVersion: 1,
      lines: [{ productId, quantityMinor: qtyMinor, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: 5000, batchId }],
      tenders: [{ kind: 'cash', amountMinor: 5000 }],
    },
  });

const nearExpiry = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/inventory/near-expiry', userId: u, tenantId: A, query });

const onHand = async (h: ApiHarness, u: string, productId: string): Promise<number> => {
  const res = await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: u, tenantId: A, query: { productId } });
  return (res.body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);
};

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // inventory.movement.append + inventory.availability.read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('near-expiry stock read (M10-FR-01 · ADR-0015)', () => {
  it('flags a near-expiry batch on hand for markdown, net of what has already sold — and the read commits nothing', async () => {
    const h = await cast();
    // Receive 100 of a batch-tracked line expiring 2026-09-18 (13 days out at receipt — clean, sellable).
    expect((await receive(h, 'u-mgr', 'grn-ne', [grnLine({ batchId: 'B-NE', expiry: '2026-09-18' })], [{ productId: 'milk-1l', batchTracked: true }], 'k1')).status).toBe(201);
    // Sell 30 of that batch (a banked sale is accepted with 202 — it happened, there may be work attached).
    expect((await sell(h, 'u-owner', 'S-1', 'milk-1l', 'B-NE', 30, 's1')).status).toBe(202);

    // Availability BEFORE the read — to prove the read itself writes nothing.
    const before = await onHand(h, 'u-mgr', 'milk-1l');

    // As of 2026-09-14 the batch is 4 days from expiry → markdown, on the 70 still on hand (100 − 30 sold).
    const body = (await nearExpiry(h, 'u-mgr', { withinDays: '7', asOf: '2026-09-14' })).body as NEBody;
    const item = body.items.find((i) => i.batchId === 'B-NE');
    expect(item).toBeDefined();
    expect(item?.action).toBe('markdown');
    expect(item?.qty).toBe(70); // 100 received − 30 FIFO-attributed sold (ADR-0006)
    expect(item?.expiry).toBe('2026-09-18');
    expect(body.markdownCount).toBeGreaterThanOrEqual(1);

    // A read never mutates: availability is unchanged, and reading again is byte-identical.
    expect(await onHand(h, 'u-mgr', 'milk-1l')).toBe(before);
    const again = (await nearExpiry(h, 'u-mgr', { withinDays: '7', asOf: '2026-09-14' })).body as NEBody;
    expect(again.items.find((i) => i.batchId === 'B-NE')?.qty).toBe(70);
  });

  it('flags an expired-on-hand batch for disposal', async () => {
    const h = await cast();
    // Received 2026-09-01, expiry 2026-09-10 (9 days out at receipt — accepted as sellable). By asOf it is expired.
    expect((await receive(
      h, 'u-mgr', 'grn-exp',
      [grnLine({ productId: 'bread-1', batchId: 'B-EXP', expiry: '2026-09-10', orderedMinor: 50, countedMinor: 50 })],
      [{ productId: 'bread-1', batchTracked: true }], 'k2', '2026-09-01',
    )).status).toBe(201);

    const body = (await nearExpiry(h, 'u-mgr', { withinDays: '7', asOf: '2026-09-14' })).body as NEBody;
    const item = body.items.find((i) => i.batchId === 'B-EXP');
    expect(item?.action).toBe('dispose');
    expect(item?.qty).toBe(50);
    expect(body.disposeCount).toBeGreaterThanOrEqual(1);
  });

  it('a far-off batch and a sold-through batch do not appear', async () => {
    const h = await cast();
    // Far-off expiry — not near.
    await receive(h, 'u-mgr', 'grn-far', [grnLine({ productId: 'rice-5kg', batchId: 'B-FAR', expiry: '2027-06-01' })], [{ productId: 'rice-5kg', batchTracked: true }], 'k3');
    // Near expiry but fully sold through → net zero, nothing to act on.
    await receive(h, 'u-mgr', 'grn-sold', [grnLine({ productId: 'yoghurt-1', batchId: 'B-SOLD', expiry: '2026-09-18', orderedMinor: 40, countedMinor: 40 })], [{ productId: 'yoghurt-1', batchTracked: true }], 'k4');
    await sell(h, 'u-owner', 'S-2', 'yoghurt-1', 'B-SOLD', 40, 's2');

    const body = (await nearExpiry(h, 'u-mgr', { withinDays: '7', asOf: '2026-09-14' })).body as NEBody;
    expect(body.items.some((i) => i.batchId === 'B-FAR')).toBe(false);
    expect(body.items.some((i) => i.batchId === 'B-SOLD')).toBe(false);
  });

  it('validates the window and gates the read on inventory.availability.read', async () => {
    const h = await cast();
    expect(codeOf(await nearExpiry(h, 'u-mgr', { withinDays: '-1' }))).toBe('not_a_valid_window');
    expect((await nearExpiry(h, 'u-cash')).status).toBe(403); // a cashier lacks inventory.availability.read
    expect((await nearExpiry(h, 'u-mgr')).status).toBe(200);    // default window (7), today — a manager may read
  });
});
