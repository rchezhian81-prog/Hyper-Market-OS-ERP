import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { STREAM } from '../../services/api/src/adapters';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, managerApprovesOn } from '../support/till-operator';
import { lineCostMinor } from '../../edge/store-edge/src/read-model';
import { valueAtUnitCost } from '../../packages/contracts/src/quantity';

/**
 * **OB-31 "A" at the till (owner, 10 Oct 2026): weighed goods are counted in GRAMS, priced per kg, valued once.** A loose
 * item weighed at 1.234 kg is rung at the till (its unit spelt 'KG' — normalised to 'kg'), saved on the real store
 * computer, synced to head office: the bill charges 1234 g × ₹40.00/kg ÷ 1000 = ₹49.36, and the `sold` movement carries
 * 1234 with unit 'kg' — never 1 or 1.234. Then 500 g come back against the bill: the refund is the bill's own price for
 * 500 g and the `returned` movement carries 500 'kg'. Stock reads 5000 − 1234 + 500 = 4266 g. The cost side (COGS at the
 * store computer) is grams × cost per kg ÷ 1000, rounded once.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0031';

describe('a weighed item is sold and returned in grams, end to end (OB-31)', () => {
  let h: ApiHarness;
  let dir: string;
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-meena', 'cashier');
    await h.provisionRole(A, 'u-box', 'store_computer');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    // 5 kg of tomatoes on hand, at ₹25.00 a kg.
    expect((await h.request({ method: 'POST', path: '/v1/inventory/movements', userId: 'u-owner', tenantId: A, idempotencyKey: 'tom-in', body: {
      movementId: 'tom-in', productId: 'TOM', locationId: 'store-1', kind: 'received', quantityMinor: 5_000, uom: 'kg', occurredAt: new Date().toISOString(), enteredBy: 'u-owner', unitCostMinor: 2_500,
    } })).status).toBeLessThan(300);
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-weighed-'));
    await prepareTillBox({
      dir, key: TEST_PACK_KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
      pack: {
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
        lossPreventionRules: [],
      },
    });
  });
  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const moves = async (kind: string) => (await h.store.readStream(A, STREAM.inventory, { type: 'InventoryMoved' }))
    .map((e) => e.event.payload as { productId: string; kind: string; quantityMinor: number; uom: string }).filter((m) => m.productId === 'TOM' && m.kind === kind)
    .map((m) => [m.quantityMinor, m.uom]);

  it('sells 1.234 kg and takes 500 g back — the bill, the stock movements and the stock all in grams', async () => {
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      EDGE_PACK_FILE: join(dir, 'store-pack.json'), CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
    }, () => {}))!;
    try {
      const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
      await signInTill(till, 'u-meena');
      // The scale says 1.234 kg; the product's unit arrives spelt 'KG'.
      till.scan({ productId: 'TOM', description: 'Tomato (loose)', unitPriceMinor: 4_000, qty: 1_234, uom: 'KG' });
      const receipt = await till.nextReceipt();
      expect(await till.tenderSplit({ saleId: 'S-TOM', receiptNumber: receipt, atIsoUtc: new Date().toISOString(), parts: [{ kind: 'cash', amountMinor: 4_936 }] })).toBe(receipt);
      till.newSale();
      expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

      const sale = (await h.store.readStream(A, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId: string; totalMinor: number; lines: { quantityMinor: number; uom: string; lineTotalMinor: number }[] }).find((s) => s.saleId === 'S-TOM')!;
      expect(sale).toMatchObject({ totalMinor: 4_936, lines: [{ quantityMinor: 1_234, uom: 'kg', lineTotalMinor: 4_936 }] });
      expect(await moves('sold')).toEqual([[1_234, 'kg']]);

      // 500 g come back: the bill's own price for 500 g is 4936 × 500 ÷ 1234 = ₹20.00.
      const bill = (await till.lookupRefund(receipt))!;
      const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-TOM', valueMinor: 2_000, reason: 'damaged' });
      const back = await bill.submit({ returnId: 'RT-TOM', number: await till.nextReceipt(), reasonCode: 'damaged', lines: [{ productId: 'TOM', uom: 'kg', quantityMinor: 500, disposition: 'resell' }], refundMinor: 2_000, refundTender: 'cash', approval });
      expect(JSON.stringify(back)).not.toMatch(/refused|Nothing was saved/);
      expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
      expect(await moves('returned')).toEqual([[500, 'kg']]);

      const rows = ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: 'u-owner', tenantId: A, query: { productId: 'TOM' } })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows;
      expect(rows.find((r) => r.locationId === 'store-1')?.onHandMinor).toBe(4_266);
    } finally {
      await edge.stop();
    }
  }, 60_000);

  it('the cost of grams sold is grams × cost per kg ÷ 1000, rounded once — and an item is a plain count', () => {
    expect(lineCostMinor(2_500, { productId: 'TOM', quantityMinor: 1_234, uom: 'kg' } as never)).toBe(3_085); // 1234 × 2500 ÷ 1000 = 3085
    expect(lineCostMinor(2_501, { productId: 'TOM', quantityMinor: 1_234, uom: 'KG' } as never)).toBe(valueAtUnitCost(1_234, 'kg', 2_501)); // 3086.234 → 3086
    expect(lineCostMinor(1_200, { productId: 'OIL', quantityMinor: 2, uom: 'each' } as never)).toBe(2_400);
    expect(lineCostMinor(3, { productId: 'SAFFRON', quantityMinor: 7, uom: 'g' } as never)).toBe(21); // a gram product at its cost per gram
  });
});
