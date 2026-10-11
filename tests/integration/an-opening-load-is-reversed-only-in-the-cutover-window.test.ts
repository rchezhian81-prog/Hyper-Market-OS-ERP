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
import { planLoad, executeLoad, type ExtractBundle, type LoadRequest } from '../../packages/migration/src/index';

/**
 * **OB-44 "A" (owner, 11 Oct 2026, "Trial: new shop; cutover: reverse") — an opening load is reversed only inside the real
 * cutover window, by a named person with a SECOND approver, through each domain's own compensating record, kept, and read back
 * to zero against the load (GT-05 · MG-08 · MG-11 · §28 · hard rules #2 #6 #10).**
 *
 * A synthetic opening — stock at two places with a batch, two gift cards / store credit, a credit customer's invoice, loyalty
 * points, two supplier bills (signed and posted) and the old trial balance (signed and posted) — is loaded through the real
 * routes, on the in-memory store and, with DATABASE_URL, on REAL PostgreSQL. Then:
 *
 *   1. outside any cutover window (none recorded; one already closed) the reversal is refused by name, nothing recorded; a
 *      store manager cannot ask at all; a request for a card that has been spent since is refused by name;
 *   2. inside the window the owner asks; the SAME person cannot approve (`self_approval`); a second owner approves;
 *   3. every opening is taken back out by its own domain's record — stock out at its own cost, the cards adjusted to zero, the
 *      invoice credited, the points reversed, the supplier bills reversed and their postings undone, the trial balance's
 *      journal mirrored — and nothing is deleted: every opening record is still there beside its reversal;
 *   4. the read-back nets every domain to zero; the domains' own reads agree (on-hand, value, card balances, ageing, points,
 *      the supplier account, the payables ledger, the account openings); approving again lands nothing twice.
 */

const OPERATOR = 'u-loader';   // owner: runs the load, asks for the reversal
const APPROVER = 'u-owner2';   // a second owner: approves it
const ACCOUNTANT = 'u-acct';
const MANAGER = 'u-mgr';
const STORE = 'S1';
const BACK = 'S1-BACK';
const LOAD = 'load-cutover';
const COUNT_DATE = new Date().toISOString().slice(0, 10);

function extract(): ExtractBundle {
  const products = [1, 2, 3].map((i) => ({
    productId: `P-${i}`, sku: `SKU-${i}`, name: `Synthetic item ${i}`, baseUom: 'each', primaryCategoryId: 'home', taxClass: '3402',
    lifecycle: 'active' as const, barcodes: [{ code: `INT-${i}`, kind: 'internal' as const }], priceMinor: 2_000, mrpMinor: 2_500, costMinor: 1_000 + i * 100, marginFloorBps: 0,
  }));
  return {
    categories: [{ categoryId: 'home', name: 'Home care', parentId: null }],
    taxRates: [{ hsnCode: '3402', effectiveFrom: '2017-07-01', rateBps: 1800 }],
    products,
    suppliers: [{ partnerId: 'SUP-1', name: 'Synthetic Traders 1' }, { partnerId: 'SUP-2', name: 'Synthetic Traders 2' }],
    customers: [{ customerId: 'C-1', loyaltyPoints: 150 }, { customerId: 'C-2' }],
    openingStock: [
      { productId: 'P-1', locationId: STORE, quantityMinor: 12, uom: 'each', unitCostMinor: 1_100, batchId: 'B1', expiry: '2027-06-30' },
      { productId: 'P-1', locationId: BACK, quantityMinor: 30, uom: 'each', unitCostMinor: 1_100, batchId: 'B1', expiry: '2027-06-30' },
      { productId: 'P-2', quantityMinor: 7, uom: 'each', unitCostMinor: 1_200 },
      { productId: 'P-3', locationId: BACK, quantityMinor: 40, uom: 'each', unitCostMinor: 1_300 },
    ],
    storedValue: [
      { instrumentId: 'GV-1', kind: 'gift_card', customerId: 'C-1', balanceMinor: 50_000, expiresOn: '2027-12-31' },
      { instrumentId: 'SC-1', kind: 'store_credit', customerId: 'C-2', balanceMinor: 12_500 },
    ],
    receivables: [{ customerId: 'C-1', invoiceId: 'INV-1', number: 'SRE/B2B/1001', issuedOn: '2026-09-01', dueOn: '2026-10-01', outstandingMinor: 180_000 }],
    payables: [
      { supplierId: 'SUP-1', openingId: 'OB-1', billNumber: 'BILL-1', billDate: '2026-09-15', outstandingMinor: 60_000 },
      { supplierId: 'SUP-2', openingId: 'OB-2', billNumber: 'BILL-2', billDate: '2026-09-15', outstandingMinor: 30_000 },
    ],
  };
}
const STOCK_VALUE = 42 * 1_100 + 7 * 1_200 + 40 * 1_300; // 106 600
const TB = [
  { accountCode: 'inventory', accountName: 'Stock in trade', debitMinor: STOCK_VALUE, creditMinor: 0 },
  { accountCode: 'bank', accountName: 'Bank', debitMinor: 200_000, creditMinor: 0 },
  { accountCode: 'opening_balances', accountName: 'Sundry creditors (control — bills loaded per supplier)', debitMinor: 0, creditMinor: 90_000 },
  { accountCode: 'capital', accountName: 'Capital', debitMinor: 0, creditMinor: STOCK_VALUE + 200_000 - 90_000 },
];
/** What the load opened that head office cannot find by the load id alone — named from the extract. */
const REQUEST = {
  storedValue: [{ instrumentId: 'GV-1', balanceMinor: 50_000 }, { instrumentId: 'SC-1', balanceMinor: 12_500 }],
  receivables: [{ customerId: 'C-1', invoiceId: 'INV-1', outstandingMinor: 180_000 }],
  pointsCustomers: ['C-1'],
};

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
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', backing: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

type Reply = { status: number; body: unknown };
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Line { domain: string; key: string; openedMinor: number; reversedMinor: number; netMinor: number }

async function loadedShop(h: ApiHarness, t: string) {
  await h.seedOwner(t, OPERATOR);
  await aStoreWithRules(h, t, OPERATOR, STORE, 0);
  await h.provisionRole(t, APPROVER, 'owner');
  await h.provisionRole(t, ACCOUNTANT, 'accountant');
  await h.provisionRole(t, MANAGER, 'store_manager');
  await h.enableFeature(t, 'b2b');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Reply> =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${n += 1}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const req: LoadRequest = {
    target: { targetId: 'cutover', tenantId: t, kind: 'rehearsal', label: 'OB-44 cutover tenant' }, tenantId: t, demoTenantIds: [], operator: OPERATOR,
    targetProductCount: 0, extractSealed: true, blockingExceptionsOpen: 0, loadId: LOAD, stockLocationId: STORE, receivedOnDate: COUNT_DATE, currency: 'INR',
  };
  const plan = planLoad(extract(), req);
  if (!plan.ok) throw new Error(`${plan.refusedBecause}: ${plan.problems.join('; ')}`);
  const loaded = await executeLoad(h, plan);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.steps.filter((s) => !s.ok)));
  // Finance signs the supplier bills and the trial balance; the payables post.
  expect((await call('POST', `/v1/purchase/opening-balances/sign-off/${LOAD}`, ACCOUNTANT, { expectedTotalMinor: 90_000, expectedCount: 2 })).status).toBe(201);
  expect((await call('PUT', '/v1/finance/posting-map', ACCOUNTANT, DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
  expect((await call('POST', '/v1/finance/payables/post', ACCOUNTANT, {})).status).toBe(201);
  expect((await call('POST', `/v1/finance/account-openings/${LOAD}`, OPERATOR, { openingDate: COUNT_DATE, lines: TB })).status).toBe(201);
  const dr = TB.reduce((s, l) => s + l.debitMinor, 0);
  expect((await call('POST', `/v1/finance/account-openings/${LOAD}/sign-off`, ACCOUNTANT, { oldSystemDebitMinor: dr, oldSystemCreditMinor: dr, accountCount: TB.length })).status).toBe(201);
  return call;
}

const hour = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe.each(backings)('OB-44 an opening load is reversed only in the cutover window — on $name', ({ backing }) => {
  it('outside the window and by one person it is refused; inside it, a second approver reverses every opening by its own record, kept, read back to zero', async () => {
    const t = randomUUID();
    const b = backing();
    const h = apiHarness(b);
    const call = await loadedShop(h, t);
    const ask = (userId: string, cutoverId: string, key?: string) => call('POST', `/v1/migration/opening-reversals/${LOAD}`, userId, { cutoverId, reason: 'wrong extract loaded on cutover night', ...REQUEST }, key);

    // 1. No window at all; a window already closed; a store manager — each refused, nothing recorded.
    expect(codeOf(await ask(OPERATOR, 'C-1'))).toBe('outside_cutover_window');
    expect((await call('POST', '/v1/migration/cutover/windows/C-old', OPERATOR, { opensAt: iso(Date.now() - 48 * hour), closesAt: iso(Date.now() - 40 * hour) })).status).toBe(201);
    expect(codeOf(await ask(OPERATOR, 'C-old'))).toBe('outside_cutover_window');
    expect((await call('POST', '/v1/migration/cutover/windows/C-1', MANAGER, { opensAt: iso(Date.now() - hour), closesAt: iso(Date.now() + hour) })).status).toBe(403);
    expect((await call('GET', `/v1/migration/opening-reversals/${LOAD}`, OPERATOR)).status).toBe(404);

    // 2. The owner opens tonight's window and asks; a manager may not ask; the asker may not approve; a second owner does.
    expect((await call('POST', '/v1/migration/cutover/windows/C-1', OPERATOR, { opensAt: iso(Date.now() - hour), closesAt: iso(Date.now() + hour) })).status).toBe(201);
    expect((await ask(MANAGER, 'C-1')).status).toBe(403);
    const asked = await ask(OPERATOR, 'C-1', 'ask-1');
    expect(asked.status).toBe(201);
    expect((asked.body as { position: Line[] }).position.every((l) => l.reversedMinor === 0 && l.netMinor === l.openedMinor)).toBe(true);
    const self = await call('POST', `/v1/migration/opening-reversals/${LOAD}/approval`, OPERATOR, {});
    expect(self.status).toBe(403);
    expect(codeOf(self)).toBe('self_approval');
    const approved = await call('POST', `/v1/migration/opening-reversals/${LOAD}/approval`, APPROVER, {}, 'approve-1');
    expect(approved.status).toBe(201);

    // 3–4. Read back: every domain nets to zero, and each line opened what the extract says.
    const rb = (await call('GET', `/v1/migration/opening-reversals/${LOAD}`, OPERATOR)).body as { position: Line[]; reversedToZero: boolean; approval: { approvedBy: string } };
    expect(rb.reversedToZero).toBe(true);
    expect(rb.approval.approvedBy).toBe(APPROVER);
    const by = (domain: string) => rb.position.filter((l) => l.domain === domain);
    expect(by('stock_quantity').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual([['P-1@S1', 12, 0], ['P-1@S1-BACK', 30, 0], ['P-2@S1', 7, 0], ['P-3@S1-BACK', 40, 0]]);
    expect(by('stock_value')).toEqual([expect.objectContaining({ openedMinor: STOCK_VALUE, reversedMinor: STOCK_VALUE, netMinor: 0 })]);
    expect(by('stored_value').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual([['GV-1', 50_000, 0], ['SC-1', 12_500, 0]]);
    expect(by('receivables').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual([['C-1/INV-1', 180_000, 0]]);
    expect(by('points').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual([['C-1', 150, 0]]);
    expect(by('supplier_openings').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual([['SUP-1/OB-1', 60_000, 0], ['SUP-2/OB-2', 30_000, 0]]);
    expect(by('ledger').map((l) => [l.key, l.openedMinor, l.netMinor])).toEqual(TB.map((l) => [l.accountCode, l.debitMinor - l.creditMinor, 0]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)));

    // The domains' own reads agree.
    const avail = ((await call('GET', '/v1/inventory/availability', OPERATOR)).body as { rows: { productId: string; onHandMinor: number }[] }).rows;
    expect(avail.every((r) => r.onHandMinor === 0)).toBe(true);
    const valuation = (await call('GET', '/v1/inventory/valuation', OPERATOR)).body as { totalValueMinor: number; rows: { cogs: { minor: number } }[] };
    expect(valuation.totalValueMinor).toBe(0);
    expect(valuation.rows.every((r) => r.cogs.minor === 0)).toBe(true); // undone, never "sold"
    for (const id of ['GV-1', 'SC-1']) expect((await call('GET', `/v1/stored-value/instruments/${id}`, OPERATOR)).body).toMatchObject({ balanceMinor: 0 });
    expect((await call('GET', '/v1/b2b/collections/C-1/ageing', OPERATOR, undefined, undefined, { asOf: COUNT_DATE })).body).toMatchObject({ totalOutstandingMinor: 0 });
    expect((await call('GET', '/v1/customers/C-1/points', OPERATOR)).body).toMatchObject({ pointsBalance: 0 });
    const sup = (await call('GET', '/v1/purchase/suppliers/SUP-1/account', OPERATOR)).body as { totals: { openingMinor: number; owedMinor: number } };
    expect(sup.totals).toMatchObject({ openingMinor: 0, owedMinor: 0 });
    // The payables posting run takes the openings' postings back out by their own journal; the ledger and the register agree.
    expect((await call('POST', '/v1/finance/payables/post', ACCOUNTANT, {})).status).toBe(201);
    const pay = (await call('GET', '/v1/finance/payables', ACCOUNTANT)).body as { reconciliation: { agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number } };
    expect(pay.reconciliation).toMatchObject({ agrees: true, registerOwedMinor: 0, ledgerOwedMinor: 0 });
    const books = (await call('GET', `/v1/finance/account-openings/${LOAD}`, ACCOUNTANT)).body as { reversed: boolean; agrees: boolean; ledger: { debitMinor: number; creditMinor: number }[] };
    expect(books.reversed).toBe(true);
    expect(books.ledger.every((l) => l.debitMinor === 0 && l.creditMinor === 0)).toBe(true);
    expect(books.agrees).toBe(true); // every account at zero, and the opening clearing account at nothing

    // Kept, never erased: the opening records are all still there beside their reversals.
    const moved = await b.store.readStream(t, 'inventory', { type: 'InventoryMoved' });
    const kinds = moved.map((e) => (e.event.payload as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'received')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'opening_reversed')).toHaveLength(4);
    expect((((await call('GET', '/v1/purchase/opening-balances', OPERATOR, undefined, undefined, { loadId: LOAD })).body) as { openings: { reversed?: boolean }[] }).openings.every((o) => o.reversed === true)).toBe(true);

    // Approving again (an interrupted run re-sent) lands nothing twice; a restart reads the same.
    const again = await call('POST', `/v1/migration/opening-reversals/${LOAD}/approval`, APPROVER, {}, 'approve-2');
    expect(again.body).toMatchObject({ alreadyApproved: true });
    expect((await b.store.readStream(t, 'inventory', { type: 'InventoryMoved' })).length).toBe(moved.length);
    const restarted = apiHarness(b);
    const rb2 = (await restarted.request({ method: 'GET', path: `/v1/migration/opening-reversals/${LOAD}`, userId: OPERATOR, tenantId: t })).body as { reversedToZero: boolean };
    expect(rb2.reversedToZero).toBe(true);
    // The plain movements route never takes the reversal kind.
    const typed = await call('POST', '/v1/inventory/movements', OPERATOR, { movementId: 'x-1', productId: 'P-1', locationId: STORE, kind: 'opening_reversed', quantityMinor: 1, uom: 'each', occurredAt: new Date().toISOString(), enteredBy: OPERATOR });
    expect(codeOf(typed)).toBe('opening_reversal_uses_its_own_route');
  }, 180_000);

  it('a gift card spent since the load is refused by name — never half-undone — and nothing is recorded', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const call = await loadedShop(h, t);
    expect((await call('POST', '/v1/migration/cutover/windows/C-1', OPERATOR, { opensAt: iso(Date.now() - hour), closesAt: iso(Date.now() + hour) })).status).toBe(201);
    expect((await call('POST', '/v1/stored-value/instruments/GV-1/redeem', OPERATOR, { movementId: 'spend-1', amountMinor: 5_000, channel: 'store' })).status).toBeLessThan(300);
    const refused = await call('POST', `/v1/migration/opening-reversals/${LOAD}`, OPERATOR, { cutoverId: 'C-1', reason: 'wrong extract', ...REQUEST });
    expect(codeOf(refused)).toBe('opening_cannot_be_reversed_as_loaded');
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/GV-1 has moved since it opened/);
    expect((await call('GET', `/v1/migration/opening-reversals/${LOAD}`, OPERATOR)).status).toBe(404);
  }, 180_000);
});
