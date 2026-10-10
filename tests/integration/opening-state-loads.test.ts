import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { aStoreWithRules } from '../support/store-rules';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import {
  planLoad, executeLoad, readBackOpening,
  type ExtractBundle, type LoadRequest, type LoadPlanOk, type LoadClient,
} from '../../packages/migration/src/index';

/**
 * **GT-05 — opening loads produce REAL domain effects, read back and reconciled (MG-05 · MG-07 · MG-08 · QG-07 · hard rules
 * #2 #6 #10 · P-08).**
 *
 * A synthetic legacy extract with every opening domain MG-08 names that this system holds a ledger for — stock by LOCATION
 * and BATCH/EXPIRY across three locations, loyalty points, gift-card and store-credit balances, credit customers' unpaid
 * invoices, and suppliers' unpaid bills — is loaded through the SAME routes a person uses (never table writes), as a named
 * operator, on the in-memory store and, with DATABASE_URL, on REAL PostgreSQL. Then:
 *
 *   1. every opening READS BACK through the domain routes (availability, the opening receipts' batch lines, valuation,
 *      points, stored value, receivables ageing, the supplier opening register) and agrees with the extract, per location /
 *      batch / account, to the unit and the paisa;
 *   2. the supplier openings are NOT owed until a second person signs the load off against the old system's creditors'
 *      total — the loader cannot sign; a wrong total is refused; then they are owed, post to the ledger through the
 *      accountant's mapping, and the register and the ledger reconcile;
 *   3. an INTERRUPTED load (the power goes half-way) resumed after a restart, and then run a third time, doubles nothing;
 *   4. bad rows are refused by name before anything is sent, and a conflicting re-send of an opening is a visible 409.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run.
 */

const OPERATOR = 'u-loader';     // owner: runs the load
const ACCOUNTANT = 'u-acct';     // accountant: signs the supplier openings off, posts payables
const STORE = 'S1';
const BACK = 'S1-BACK';
const WH = 'WH-1';
const LOAD = 'load-2026-10-10';
const COUNT_DATE = '2026-10-10';
/** Scale of the synthetic extract — raise OPENING_VOLUME to rehearse a bigger file (the shape stays the same). */
const VOLUME = Math.max(1, Number(process.env['OPENING_VOLUME'] ?? '1'));

/** A synthetic legacy extract — every opening domain, deterministic, sized by VOLUME. */
function syntheticExtract(): ExtractBundle {
  const nProducts = 24 * VOLUME;
  const products = Array.from({ length: nProducts }, (_, i) => {
    const n = String(i + 1).padStart(4, '0');
    const cost = 1_000 + (i % 17) * 250;
    return {
      productId: `P-${n}`, sku: `SKU-${n}`, name: `Synthetic item ${n}`, baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402',
      lifecycle: 'active' as const, barcodes: [{ code: `INT-${n}`, kind: 'internal' as const }],
      priceMinor: cost + 500, mrpMinor: cost + 800, costMinor: cost, marginFloorBps: 0,
    };
  });
  const openingStock: ExtractBundle['openingStock'][number][] = [];
  products.forEach((p, i) => {
    const qty = 10 + (i % 9) * 5;
    if (i % 3 === 0) {
      // batch-tracked: two batches at the store, one in the back store
      openingStock.push({ productId: p.productId, locationId: STORE, quantityMinor: qty, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-A`, expiry: '2027-06-30' });
      openingStock.push({ productId: p.productId, locationId: STORE, quantityMinor: qty + 3, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-B`, expiry: '2027-09-30' });
      openingStock.push({ productId: p.productId, locationId: BACK, quantityMinor: qty * 2, uom: 'each', unitCostMinor: p.costMinor, batchId: `B${i}-A`, expiry: '2027-06-30' });
    } else {
      openingStock.push({ productId: p.productId, quantityMinor: qty, uom: 'each', unitCostMinor: p.costMinor }); // the load's own location
      if (i % 2 === 0) openingStock.push({ productId: p.productId, locationId: WH, quantityMinor: qty * 4, uom: 'each', unitCostMinor: p.costMinor });
    }
  });
  const customers = Array.from({ length: 12 * VOLUME }, (_, i) => ({
    customerId: `C-${String(i + 1).padStart(4, '0')}`, ...(i % 3 === 2 ? {} : { loyaltyPoints: 50 + i * 7 }),
  }));
  const storedValue = Array.from({ length: 6 * VOLUME }, (_, i) => ({
    instrumentId: `GV-${String(i + 1).padStart(4, '0')}`, kind: (i % 2 === 0 ? 'gift_card' : 'store_credit') as 'gift_card' | 'store_credit',
    customerId: customers[i % customers.length]!.customerId, balanceMinor: 25_000 + i * 1_100,
    ...(i % 2 === 0 ? { expiresOn: '2027-12-31' } : {}),
  }));
  const receivables = Array.from({ length: 5 * VOLUME }, (_, i) => ({
    customerId: customers[i % 3]!.customerId, invoiceId: `INV-${i + 1}`, number: `SRE/B2B/${1000 + i}`,
    issuedOn: '2026-09-01', dueOn: i % 2 === 0 ? '2026-10-01' : '2026-11-01', outstandingMinor: 150_000 + i * 12_345,
  }));
  const suppliers = Array.from({ length: 4 }, (_, i) => ({ partnerId: `SUP-${i + 1}`, name: `Synthetic Traders ${i + 1}` }));
  const payables = Array.from({ length: 8 * VOLUME }, (_, i) => ({
    supplierId: suppliers[i % suppliers.length]!.partnerId, openingId: `OB-${i + 1}`, billNumber: `BILL-${700 + i}`,
    billDate: '2026-09-15', ...(i % 2 === 0 ? { dueOn: '2026-10-15' } : {}), outstandingMinor: 80_000 + i * 9_999,
  }));
  return {
    categories: [{ categoryId: 'home', name: 'Home care', parentId: null }],
    taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }],
    products, suppliers, customers, openingStock, storedValue, receivables, payables,
  };
}

const requestFor = (tenantId: string): LoadRequest => ({
  target: { targetId: 'rehearsal-gt05', tenantId, kind: 'rehearsal', label: 'GT-05 rehearsal tenant' },
  tenantId, demoTenantIds: [], operator: OPERATOR, targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0,
  loadId: LOAD, stockLocationId: STORE, receivedOnDate: COUNT_DATE, currency: 'INR',
});

const planOf = (bundle: ExtractBundle, req: LoadRequest): LoadPlanOk => {
  const p = planLoad(bundle, req);
  if (!p.ok) throw new Error(`${p.refusedBecause}: ${p.detail} ${p.problems.join('; ')}`);
  return p;
};

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

async function cast(h: ApiHarness, t: string): Promise<void> {
  await h.seedOwner(t, OPERATOR);
  await aStoreWithRules(h, t, OPERATOR, STORE, 0); // M05: the owner sets the store's margin floor before prices load
  await h.provisionRole(t, ACCOUNTANT, 'accountant');
  await h.enableFeature(t, 'b2b'); // credit customers' receivables live behind the B2B feature
}

/** A client that dies after `after` calls — the power going half-way through a load. */
function dyingClient(h: ApiHarness, after: number): LoadClient {
  let calls = 0;
  return {
    request: async (input) => {
      calls += 1;
      if (calls > after) throw new Error('power cut');
      return h.request(input);
    },
  };
}

let pool: Pool | undefined;
const DATABASE_URL = process.env['DATABASE_URL'];
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly store: EventStore; readonly idempotency: MemoryIdempotencyStore | SqlIdempotencyStore }
const backings: { name: string; backing: () => Backing }[] = [
  { name: 'the in-memory event store', backing: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) },
];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });
}

describe.each(backings)('GT-05 opening loads — real domain effects, read back and reconciled — on $name', ({ backing }) => {
  it('every opening lands in its domain ledger and reads back to the unit and the paisa, by location, batch and account', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await cast(h, t);
    const bundle = syntheticExtract();
    const req = requestFor(t);
    const plan = planOf(bundle, req);
    // one opening receipt per location, not one pooled receipt
    expect(plan.steps.filter((s) => s.group === 'stock').map((s) => (s.body as { warehouseId: string }).warehouseId)).toEqual([STORE, BACK, WH]);

    const report = await executeLoad(h, plan);
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);

    const rb = await readBackOpening(h, bundle, req);
    expect(rb.differences).toEqual([]);
    expect(rb.agrees).toBe(true);
    // every domain was actually checked, line by line
    const domains = new Set(rb.lines.map((l) => l.domain));
    expect([...domains].sort()).toEqual(['payable', 'points', 'receivable', 'stock_batch', 'stock_location', 'stock_value', 'stored_value']);
    expect(rb.totals.stock_location).toEqual({ expected: sum(bundle.openingStock.map((r) => r.quantityMinor)), actual: sum(bundle.openingStock.map((r) => r.quantityMinor)) });
    expect(rb.lines.filter((l) => l.domain === 'stock_batch')).toHaveLength(bundle.openingStock.filter((r) => r.batchId !== undefined).length);
    expect(rb.totals.stored_value?.actual).toBe(sum((bundle.storedValue ?? []).map((v) => v.balanceMinor)));
    expect(rb.totals.receivable?.actual).toBe(sum((bundle.receivables ?? []).map((r) => r.outstandingMinor)));
    // recorded — but NOT owed until a second person signs the load off
    expect(rb.payablesSignedOff).toBe(false);
    expect(rb.lines.filter((l) => l.domain === 'payable').every((l) => l.note?.includes('awaiting'))).toBe(true);

    // The migrated stored value is a REAL balance: it can be spent, and the spend comes off it.
    const gv = bundle.storedValue![0]!;
    const spend = await h.request({ method: 'POST', path: `/v1/stored-value/instruments/${gv.instrumentId}/redeem`, userId: OPERATOR, tenantId: t, idempotencyKey: 'spend-1', body: { movementId: 'spend-1', amountMinor: 5_000, channel: 'store' } });
    expect(spend.status).toBe(200);
    const after = (await h.request({ method: 'GET', path: `/v1/stored-value/instruments/${gv.instrumentId}`, userId: OPERATOR, tenantId: t })).body as { balanceMinor: number };
    expect(after.balanceMinor).toBe(gv.balanceMinor - 5_000);
    // …and the read-back now names the difference instead of hiding it (P-08)
    const rb2 = await readBackOpening(h, bundle, req);
    expect(rb2.differences).toEqual([expect.objectContaining({ domain: 'stored_value', key: gv.instrumentId, expected: gv.balanceMinor, actual: gv.balanceMinor - 5_000, agrees: false })]);
  }, 180_000);

  it('supplier openings are owed only after a SECOND person signs the load off against the old system\'s total — then they post and reconcile', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await cast(h, t);
    const bundle = syntheticExtract();
    const req = requestFor(t);
    expect((await executeLoad(h, planOf(bundle, req))).ok).toBe(true);
    const payables = bundle.payables!;
    const total = sum(payables.map((p) => p.outstandingMinor));
    const sup1 = payables.filter((p) => p.supplierId === 'SUP-1');

    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });

    // Before sign-off: SHOWN on the supplier's account as awaiting sign-off, owed nothing, and the supplier needs a person.
    let sup = (await call('GET', '/v1/purchase/suppliers/SUP-1', OPERATOR)).body as { account: { totals: { owedMinor: number; openingMinor: number; openingPendingSignOffMinor: number }; openings: unknown[] }; attention: string[] };
    expect(sup.account.totals).toMatchObject({ owedMinor: 0, openingMinor: 0, openingPendingSignOffMinor: sum(sup1.map((p) => p.outstandingMinor)) });
    expect(sup.account.openings).toHaveLength(sup1.length);
    expect(sup.attention).toContain('opening_awaiting_sign_off');

    // The loader cannot sign their own load (§28).
    const self = await call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, OPERATOR, { expectedTotalMinor: total, expectedCount: payables.length }, 'so-self');
    expect(self.status).toBe(403);
    expect((self.body as { error: { code: string } }).error.code).toBe('signer_recorded_the_openings');
    // A total that does not agree with what was loaded is refused, nothing signed (MG-06).
    const wrong = await call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, ACCOUNTANT, { expectedTotalMinor: total + 1, expectedCount: payables.length }, 'so-wrong');
    expect(wrong.status).toBe(422);
    expect((wrong.body as { error: { code: string } }).error.code).toBe('opening_total_differs');
    // The right total, by finance: signed.
    const signed = await call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, ACCOUNTANT, { expectedTotalMinor: total, expectedCount: payables.length, note: 'agrees to the old creditors list' }, 'so-ok');
    expect(signed.status).toBe(201);
    expect((signed.body as { signOff: { totalMinor: number; signedBy: string; openingIds: string[] } }).signOff).toMatchObject({ totalMinor: total, signedBy: ACCOUNTANT });
    // Signing again is the same sign-off.
    expect(((await call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, ACCOUNTANT, { expectedTotalMinor: total, expectedCount: payables.length }, 'so-again')).body as { alreadySigned: boolean }).alreadySigned).toBe(true);

    sup = (await call('GET', '/v1/purchase/suppliers/SUP-1', OPERATOR)).body as typeof sup;
    expect(sup.account.totals).toMatchObject({ owedMinor: sum(sup1.map((p) => p.outstandingMinor)), openingMinor: sum(sup1.map((p) => p.outstandingMinor)), openingPendingSignOffMinor: 0 });
    expect(sup.attention).not.toContain('opening_awaiting_sign_off');
    const rb = await readBackOpening(h, bundle, req);
    expect(rb.payablesSignedOff).toBe(true);
    expect(rb.agrees).toBe(true);

    // Finance posts the openings through the accountant's mapping; the purchase register and the ledger agree to the paisa.
    expect((await call('PUT', '/v1/finance/posting-map', ACCOUNTANT, DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBe(200);
    const posted = await call('POST', '/v1/finance/payables/post', ACCOUNTANT, {}, 'pay-1');
    expect(posted.status).toBe(201);
    const journals = (posted.body as { journals: { kind: string; sourceId: string }[] }).journals;
    expect(journals.filter((j) => j.kind === 'supplier_opening_balance').map((j) => j.sourceId).sort()).toEqual(payables.map((p) => p.openingId).sort());
    const read = (await call('GET', '/v1/finance/payables', ACCOUNTANT)).body as { reconciliation: { agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number } };
    expect(read.reconciliation).toMatchObject({ agrees: true, registerOwedMinor: total, ledgerOwedMinor: total });
    // A second posting run posts nothing twice.
    const again = await call('POST', '/v1/finance/payables/post', ACCOUNTANT, {}, 'pay-2');
    expect((again.body as { journals: unknown[] }).journals).toEqual([]);
  }, 180_000);

  it('an INTERRUPTED load, resumed after a restart and then run a third time, doubles nothing — every opening once', async () => {
    const t = randomUUID();
    const b = backing();
    const first = apiHarness(b);
    await cast(first, t);
    const bundle = syntheticExtract();
    const req = requestFor(t);
    const plan = planOf(bundle, req);
    // The power goes two-thirds of the way through — after the supplier openings and some customer balances.
    const cut = Math.floor(plan.steps.length * 2 / 3);
    await expect(executeLoad(dyingClient(first, cut), plan)).rejects.toThrow('power cut');
    const partial = await readBackOpening(first, bundle, req);
    expect(partial.agrees).toBe(false); // half a load is visibly half a load

    // Restart: a NEW process over the same database (and the same idempotency records) resumes the same load.
    const restarted = apiHarness(b);
    const resumed = await executeLoad(restarted, planOf(bundle, req));
    expect(resumed.steps.filter((s) => !s.ok)).toEqual([]);
    const rb = await readBackOpening(restarted, bundle, req);
    expect(rb.differences).toEqual([]);

    // And once more, for luck: still every figure exactly once.
    const third = await executeLoad(apiHarness(b), planOf(bundle, req));
    expect(third.ok).toBe(true);
    const rb3 = await readBackOpening(restarted, bundle, req);
    expect(rb3.differences).toEqual([]);
    const openings = (await restarted.request({ method: 'GET', path: '/v1/purchase/opening-balances', userId: OPERATOR, tenantId: t, query: { loadId: LOAD } })).body as { count: number };
    expect(openings.count).toBe(bundle.payables!.length);
  }, 240_000);

  it('bad rows are refused BY NAME before anything is sent; a conflicting re-send of an opening is a visible 409, never an overwrite', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    await cast(h, t);
    const good = syntheticExtract();
    const bad: ExtractBundle = {
      ...good,
      openingStock: [
        ...good.openingStock,
        { ...good.openingStock[0]! },                                                                       // same product/location/batch twice
        { productId: 'P-0002', quantityMinor: 5, uom: 'each', unitCostMinor: 1_250, batchId: 'OLD', expiry: '2026-09-30' }, // expired
      ],
      storedValue: [...good.storedValue!, { instrumentId: 'GV-X', kind: 'gift_card', customerId: 'C-NOBODY', balanceMinor: 100 }],
      receivables: [...good.receivables!, { customerId: 'C-0001', invoiceId: 'INV-0', number: 'X', issuedOn: '2026-09-01', dueOn: '2026-10-01', outstandingMinor: 0 }],
      payables: [...good.payables!, { supplierId: 'SUP-UNKNOWN', openingId: 'OB-X', billNumber: 'B', billDate: '2026-09-01', outstandingMinor: 10 }],
    };
    const sent: string[] = [];
    const refused = planLoad(bad, requestFor(t));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusedBecause).toBe('malformed_rows');
    const text = refused.problems.join('\n');
    expect(text).toMatch(/same product, location and batch as row 1/);
    expect(text).toMatch(/expired 2026-09-30, before the count date 2026-10-10/);
    expect(text).toMatch(/stored value row \d+ \(GV-X\): customer "C-NOBODY" is not in the extract/);
    expect(text).toMatch(/receivable row \d+ \(C-0001\/INV-0\): the outstanding amount must be whole paise above 0/);
    expect(text).toMatch(/payable row \d+ \(SUP-UNKNOWN\/OB-X\): supplier "SUP-UNKNOWN" is not in the extract/);
    expect(refused.problems).toHaveLength(5);
    expect(sent).toEqual([]); // the plan was refused, so no client was ever called
    const products = (await h.request({ method: 'GET', path: '/v1/catalogue/products', userId: OPERATOR, tenantId: t })).body as { products: unknown[] };
    expect(products.products).toEqual([]);

    // The good file loads; then a re-send of one opening with DIFFERENT figures is refused by name — the first stands.
    expect((await executeLoad(h, planOf(good, requestFor(t)))).ok).toBe(true);
    const ob1 = good.payables![0]!;
    const conflict = await h.request({ method: 'POST', path: `/v1/purchase/suppliers/${ob1.supplierId}/opening-balances/${ob1.openingId}`, userId: OPERATOR, tenantId: t, idempotencyKey: 'ob1-changed', body: { billNumber: ob1.billNumber, billDate: ob1.billDate, dueOn: ob1.dueOn, amountMinor: ob1.outstandingMinor + 100, openingDate: COUNT_DATE, loadId: LOAD } });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string } }).error.code).toBe('opening_balance_conflict');
    // An opening for a supplier the master does not hold is refused, nothing recorded.
    const unknown = await h.request({ method: 'POST', path: '/v1/purchase/suppliers/SUP-GHOST/opening-balances/OB-GHOST', userId: OPERATOR, tenantId: t, idempotencyKey: 'ghost', body: { billNumber: 'G', billDate: '2026-09-01', amountMinor: 500, openingDate: COUNT_DATE, loadId: LOAD } });
    expect(unknown.status).toBe(422);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('supplier_unknown');
    // A cashier cannot record an opening balance at all.
    await h.provisionRole(t, 'u-cash', 'cashier');
    const cashier = await h.request({ method: 'POST', path: `/v1/purchase/suppliers/${ob1.supplierId}/opening-balances/OB-CASH`, userId: 'u-cash', tenantId: t, idempotencyKey: 'cash', body: { billNumber: 'C', billDate: '2026-09-01', amountMinor: 500, openingDate: COUNT_DATE, loadId: LOAD } });
    expect(cashier.status).toBe(403);
    const rb = await readBackOpening(h, good, requestFor(t));
    expect(rb.differences).toEqual([]); // none of the refused writes changed a figure
  }, 180_000);
});
