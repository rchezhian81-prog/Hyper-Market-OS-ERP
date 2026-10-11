import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { planLoad, executeLoad, readBackOpening, openingReceiptChunks, type ExtractBundle, type LoadRequest } from '../../packages/migration/src/index';

/**
 * **GT-05 (MG-05 "repeatable full-volume migrations") — the opening state at a REAL store's volume, on REAL PostgreSQL.**
 *
 * Opt-in, so the everyday suite stays fast: set `GT05_STORE_VOLUME` to the number of products (e.g. 15000 for a 14 000 sq ft
 * hypermarket) and `DATABASE_URL`. The synthetic store: that many products, each with a barcode and a price, opening stock
 * across FOUR locations (the shop floor, its back store, the central warehouse, the cold room) with a third of the products
 * batch-tracked in two batches each, plus suppliers and loyalty customers — loaded through the same routes a person uses,
 * as the named operator. It records how long the load and the read-back take, and the read-back must agree to the unit and
 * the paisa, per location, per batch and per product value. Nothing here is a real shop's data.
 */

const N = Number(process.env['GT05_STORE_VOLUME'] ?? '0');
const DATABASE_URL = process.env['DATABASE_URL'];
const OPERATOR = 'u-loader';
const STORE = 'S1';
const LOCATIONS = { floor: STORE, back: 'S1-BACK', warehouse: 'WH-1', cold: 'COLD-1' } as const;

function storeExtract(n: number): ExtractBundle {
  const products = Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(6, '0');
    const cost = 500 + (i % 97) * 37;
    return {
      productId: `P-${id}`, sku: `SKU-${id}`, name: `Synthetic item ${id}`, baseUom: 'each', primaryCategoryId: i % 2 === 0 ? 'home' : 'grocery', taxClass: i % 2 === 0 ? '3402' : '1006',
      lifecycle: 'active' as const, barcodes: [{ code: `INT-${id}`, kind: 'internal' as const }],
      priceMinor: cost + 300, mrpMinor: cost + 600, costMinor: cost, marginFloorBps: 0,
    };
  });
  const openingStock: ExtractBundle['openingStock'][number][] = [];
  products.forEach((p, i) => {
    const qty = 6 + (i % 23);
    if (i % 3 === 0) {
      // batch-tracked: two batches on the floor, the older one also in the back store (and some in the cold room)
      openingStock.push({ productId: p.productId, locationId: LOCATIONS.floor, quantityMinor: qty, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-A`, expiry: '2027-06-30' });
      openingStock.push({ productId: p.productId, locationId: LOCATIONS.floor, quantityMinor: qty + 2, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-B`, expiry: '2027-09-30' });
      openingStock.push({ productId: p.productId, locationId: i % 9 === 0 ? LOCATIONS.cold : LOCATIONS.back, quantityMinor: qty * 3, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-A`, expiry: '2027-06-30' });
    } else {
      openingStock.push({ productId: p.productId, quantityMinor: qty, uom: 'each', unitCostMinor: p.costMinor });
      if (i % 2 === 0) openingStock.push({ productId: p.productId, locationId: LOCATIONS.back, quantityMinor: qty * 2, uom: 'each', unitCostMinor: p.costMinor });
      if (i % 5 === 0) openingStock.push({ productId: p.productId, locationId: LOCATIONS.warehouse, quantityMinor: qty * 10, uom: 'each', unitCostMinor: p.costMinor });
    }
  });
  return {
    categories: [{ categoryId: 'home', name: 'Home care', parentId: null }, { categoryId: 'grocery', name: 'Grocery', parentId: null }],
    taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }, { hsnCode: '1006', effectiveFrom: '2017-07-01', rateBps: 500 }],
    products,
    suppliers: Array.from({ length: 40 }, (_, i) => ({ partnerId: `SUP-${i + 1}`, name: `Synthetic Traders ${i + 1}` })),
    customers: Array.from({ length: 200 }, (_, i) => ({ customerId: `C-${String(i + 1).padStart(5, '0')}`, ...(i % 2 === 0 ? { loyaltyPoints: 10 + i } : {}) })),
    openingStock,
  };
}

let pool: Pool | undefined;
beforeAll(async () => {
  if (N <= 0 || DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

describe.skipIf(N <= 0 || DATABASE_URL === undefined)(`GT-05 the opening state at store volume (${N} products) — on real PostgreSQL`, () => {
  it('loads through the routes, reads back per location / batch / value, and agrees — with the time it took', async () => {
    const t = randomUUID();
    const sql = pgPoolClient(pool!);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await h.seedOwner(t, OPERATOR);
    await aStoreWithRules(h, t, OPERATOR, STORE, 0);
    const bundle = storeExtract(N);
    const req: LoadRequest = {
      target: { targetId: 'rehearsal-volume', tenantId: t, kind: 'rehearsal', label: 'GT-05 store-volume rehearsal' },
      tenantId: t, demoTenantIds: [], operator: OPERATOR, targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0,
      loadId: 'load-volume', stockLocationId: STORE, receivedOnDate: '2026-10-10', currency: 'INR',
    };
    const plan = planLoad(bundle, req);
    if (!plan.ok) throw new Error(`${plan.refusedBecause}: ${plan.problems.slice(0, 5).join('; ')}`);
    const chunks = openingReceiptChunks(bundle, req);
    const started = Date.now();
    // Progress, for a long rehearsal: every 1 000 steps, the group and the elapsed seconds (to GT05_PROGRESS_FILE when set).
    const progressFile = process.env['GT05_PROGRESS_FILE'];
    let done = 0;
    const client = {
      request: async (input: Parameters<typeof h.request>[0]) => {
        const r = await h.request(input);
        done += 1;
        if (progressFile !== undefined && (done % 1_000 === 0 || done === plan.steps.length)) appendFileSync(progressFile, `${done}/${plan.steps.length} ${input.path.split('/').slice(0, 4).join('/')} ${Math.round((Date.now() - started) / 1000)}s\n`);
        return r;
      },
    };
    const report = await executeLoad(client as never, plan);
    const loadedMs = Date.now() - started;
    expect(report.steps.filter((s) => !s.ok).slice(0, 5)).toEqual([]);
    const readStarted = Date.now();
    const rb = await readBackOpening(h, bundle, req);
    const readMs = Date.now() - readStarted;
    const batches = bundle.openingStock.filter((r) => r.batchId !== undefined).length;
    // The measured numbers, for the record (MG-05).
    console.log(JSON.stringify({
      products: N, stockLines: bundle.openingStock.length, batchLines: batches, locations: Object.keys(LOCATIONS).length,
      openingReceipts: chunks.length, steps: plan.steps.length, loadSeconds: Math.round(loadedMs / 100) / 10, readBackSeconds: Math.round(readMs / 100) / 10,
      checks: rb.lines.length, differences: rb.differences.length,
      stockValueMinor: rb.totals.stock_value,
    }));
    expect(rb.differences.slice(0, 5)).toEqual([]);
    expect(rb.agrees).toBe(true);
    expect(rb.lines.filter((l) => l.domain === 'stock_batch')).toHaveLength(batches);
    expect(new Set(rb.lines.filter((l) => l.domain === 'stock_location').map((l) => l.key.split('@')[1]))).toEqual(new Set(Object.values(LOCATIONS)));
  }, 6 * 60 * 60 * 1000);
});
