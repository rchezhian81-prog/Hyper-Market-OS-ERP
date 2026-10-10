import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { readPack } from '../../edge/store-edge/src/store-pack';

/**
 * **FUL-11 — merchandising works on head office's own facts, not on figures typed into a request (M04-FR-01 · M04-FR-02 ·
 * M04-FR-03 · M04-FR-04 · D02-FR-06 · M23 · P-02 · P-08).**
 *
 * Through the real routes, as named people, on the in-memory store and, with DATABASE_URL, on REAL PostgreSQL:
 *
 *   1. RANGE DROP (FR-01 "a dropped item with stock is routed to clearance, not deleted"): the stock on hand is the STOCK
 *      LEDGER's figure at the store's locations — a request claiming "none on hand" for an item the store holds 40 of is
 *      routed to clearance anyway, and the typed figure is said and ignored.
 *   2. THE EFFECTIVE RANGE AT ORDERING (FR-01 "an item not in a store's assortment does not appear in that store's ordering /
 *      replenishment"): a floor indent for an item the store does not range is refused by name; the replenishment proposal
 *      for the store leaves out anything it may not reorder (never listed, delisted, on clearance) and lists it visibly.
 *   3. DISPLAY FUNDING RECONCILED TO FINANCE (FR-04): finance records what the supplier paid as a journal through the
 *      accountant's mapping; the contract review reads THAT (a typed "received" is ignored); the reconciliation shows
 *      agreed / received / outstanding beside what the ledger holds, and they agree to the paisa. Over-receipt, an unmapped
 *      kind and a merchandiser recording money are refused.
 *   4. THE STORE'S SETUP CARRIES THE PLANNING FACTS (DF-3): the shelf map, the plan in force, the range, the back-store
 *      stock and the display contracts with finance's received figure reach the store computer's pack, readable by it.
 */

const OWNER = 'u-owner';
const MGR = 'u-mgr';     // store_manager: merchandising (range, display space)
const ACCT = 'u-acct';   // accountant: finance records the money and approves the funding terms
const BOX = 'u-box';     // the store computer's own identity at S1
const STORE = 'S1';
const BACK = 'S1-BACK';
const today = new Date().toISOString().slice(0, 10);
const inr = (minor: number) => ({ minor, currency: 'INR' });

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

type Reply = { status: number; body: unknown };
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function setUp(h: ApiHarness, t: string) {
  await h.seedOwner(t, OWNER);
  await h.provisionRole(t, MGR, 'store_manager');
  await h.provisionRole(t, ACCT, 'accountant');
  await h.provisionRole(t, BOX, 'cashier', [STORE]);
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${path}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const receive = (locationId: string, productId: string, qty: number) => call('POST', '/v1/inventory/movements', OWNER, {
    movementId: `rx-${locationId}-${productId}`, productId, locationId, kind: 'received', quantityMinor: qty, unitCostMinor: 1_000, uom: 'each', occurredAt: `${today}T06:00:00.000Z`, enteredBy: OWNER,
  });
  const list = (productId: string) => call('POST', `/v1/merchandising/assortment/${STORE}/${productId}/list`, MGR, { effectiveFrom: '2026-01-01' });
  return { call, receive, list };
}

describe.each(backings)('FUL-11 merchandising reads head office\'s own facts — on $name', ({ backing }) => {
  it('a range drop takes the stock from the LEDGER; the store\'s effective range governs its indents and its replenishment proposal', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const { call, receive, list } = await setUp(h, t);
    for (const p of ['p-tea', 'p-old', 'p-gone']) expect((await list(p)).status).toBe(201);
    expect((await receive(STORE, 'p-old', 40)).status).toBe(202);
    expect((await receive(BACK, 'p-tea', 100)).status).toBe(202);
    expect((await receive(BACK, 'p-new', 30)).status).toBe(202);

    // 1. A request may not say what is on the shelf at all; the ledger says 40 are in the store: clearance, never a delete.
    const typed = await call('POST', `/v1/merchandising/assortment/${STORE}/p-old/drop`, MGR, { onHandMinor: 0, reason: 'poor_sales', effectiveFrom: today });
    expect(codeOf(typed)).toBe('drop_carries_caller_stock');
    const drop = await call('POST', `/v1/merchandising/assortment/${STORE}/p-old/drop`, MGR, { reason: 'poor_sales', effectiveFrom: today });
    expect(drop.status).toBe(201);
    expect(drop.body).toMatchObject({ outcome: 'routed_to_clearance', status: 'clearance', onHandMinor: 40 });
    const gone = await call('POST', `/v1/merchandising/assortment/${STORE}/p-gone/drop`, MGR, { reason: 'supplier_discontinued', effectiveFrom: today });
    expect(gone.body).toMatchObject({ outcome: 'delisted', onHandMinor: 0 });

    // 2a. The floor asks the back store: a ranged item is fine; one the store does not range is refused by name.
    const ok = await call('POST', '/v1/floor/indents/ind-1', MGR, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'p-tea', quantityMinor: 10, uom: 'each' }] });
    expect(ok.status).toBe(201);
    const notRanged = await call('POST', '/v1/floor/indents/ind-2', MGR, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'p-new', quantityMinor: 5, uom: 'each' }] });
    expect(notRanged.status).toBe(422);
    expect(codeOf(notRanged)).toBe('not_in_range');
    const delisted = await call('POST', '/v1/floor/indents/ind-3', MGR, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'p-gone', quantityMinor: 1, uom: 'each' }] });
    expect(codeOf(delisted)).toBe('not_in_range');
    expect((await call('GET', '/v1/floor/indents/ind-2', OWNER)).status).toBe(404); // nothing recorded
    // Clearance stock may still come out to sell down.
    expect((await call('POST', '/v1/floor/indents/ind-4', MGR, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'p-old', quantityMinor: 1, uom: 'each' }] })).status).toBe(201);

    // 2b. The replenishment proposal FOR THE STORE proposes only what it may reorder; the rest is listed, not dropped.
    const items = ['p-tea', 'p-old', 'p-gone', 'p-new'].map((productId) => ({ productId, onHand: 0, maxLevel: 50, reorderPoint: 10 }));
    const proposal = await call('POST', '/v1/replenishment/propose', MGR, { items }, { storeId: STORE });
    expect(proposal.status).toBe(200);
    const pb = proposal.body as { proposals: { productId: string }[]; outOfRange: { productId: string; status: string }[] };
    expect(pb.proposals.map((p) => p.productId)).toEqual(['p-tea']);
    expect(pb.outOfRange).toEqual([{ productId: 'p-old', status: 'clearance' }, { productId: 'p-gone', status: 'delisted' }, { productId: 'p-new', status: 'not_ranged' }]);

    // The integrity check runs on the ledger too: p-old's clearance stock is what the ledger holds, not a typed figure.
    const integrity = await call('POST', `/v1/merchandising/assortment/${STORE}/integrity`, MGR, { onDate: today, soldProductIds: [], onHand: { 'p-old': 0 } });
    expect(integrity.body).toMatchObject({ factsFrom: 'head_office_stock_ledger' });
    expect((integrity.body as { issues: { productId: string; finding: string }[] }).issues.some((i) => i.productId === 'p-old' && i.finding === 'clearance_with_no_stock')).toBe(false);
  }, 120_000);

  it('display funding is FINANCE\'s record: posted through the mapping, read by the review, reconciled to the ledger to the paisa', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const { call } = await setUp(h, t);
    const contract = { storeId: STORE, supplierId: 'sup-tea', description: 'tea end-cap by the door', fundingAmount: inr(60_000), startsOn: '2026-01-01', endsOn: '2026-12-31', locationIds: ['END-1'] };
    const recorded = await sentWithApproval(h, t, MGR, ACCT, { kind: 'display_contract', subjectRef: 'dc-tea', pathIds: { contractId: 'dc-tea' }, valueMinor: 60_000 },
      contract, (b) => call('POST', '/v1/merchandising/display-contracts/dc-tea', MGR, b));
    expect(recorded.status).toBe(201);
    const receipt = (id: string, minor: number, who = ACCT) => call('POST', `/v1/finance/display-funding/dc-tea/receipts/${id}`, who, { amountMinor: minor, receivedOn: today, reference: `NEFT-${id}` });

    // No mapping yet: the accountant has not said where the money goes — refused, nothing recorded.
    expect(codeOf(await receipt('r1', 40_000))).toBe('display_funding_not_mapped');
    expect((await call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP)).status).toBe(200);
    // A merchandiser does not record money.
    expect((await receipt('r1', 40_000, MGR)).status).toBe(403);
    const first = await receipt('r1', 40_000);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ outstandingMinor: 20_000, alreadyRecorded: false });
    expect(((await receipt('r1', 40_000)).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true); // a re-send is the same receipt
    expect(codeOf(await receipt('r2', 30_000))).toBe('receipt_exceeds_contract'); // only 20 000 is outstanding

    // The review reads finance's figure — 40 000 of 60 000 — whatever the request types.
    const review = await call('POST', '/v1/merchandising/display-contracts/review', MGR, { onDate: today, currency: 'INR', received: { 'dc-tea': inr(60_000) } });
    expect(review.body).toMatchObject({ receivedFrom: 'finance_display_funding_journals', typedReceivedIgnored: true });
    expect((review.body as { statuses: { contractId: string; finding: string }[] }).statuses).toEqual([expect.objectContaining({ contractId: 'dc-tea', finding: 'funding_not_received' })]);

    // The reconciliation: agreed / received / outstanding, beside what the LEDGER holds — they agree.
    const rec = (await call('GET', '/v1/finance/display-funding', ACCT)).body as { lines: { contractId: string; fundingMinor: number; receivedMinor: number; outstandingMinor: number; ledgerMinor: number; agrees: boolean; approved: boolean }[]; agrees: boolean; incomeAccount: string };
    expect(rec.incomeAccount).toBe('display_funding_income');
    expect(rec.lines).toEqual([expect.objectContaining({ contractId: 'dc-tea', fundingMinor: 60_000, receivedMinor: 40_000, outstandingMinor: 20_000, ledgerMinor: 40_000, agrees: true, approved: true })]);
    expect(rec.agrees).toBe(true);
    // The rest arrives; nothing outstanding; the review is clean.
    expect((await receipt('r2', 20_000)).status).toBe(201);
    const after = (await call('POST', '/v1/merchandising/display-contracts/review', MGR, { onDate: today, currency: 'INR' })).body as { statuses: { finding: string }[] };
    expect(after.statuses.map((s) => s.finding)).toEqual(['active']);
    const restarted = apiHarness({ store: h.store }); // a restart: a new process over the same records
    const rec2 = (await restarted.request({ method: 'GET', path: '/v1/finance/display-funding', userId: ACCT, tenantId: t })).body as { lines: { receivedMinor: number; ledgerMinor: number; outstandingMinor: number }[] };
    expect(rec2.lines).toEqual([expect.objectContaining({ receivedMinor: 60_000, ledgerMinor: 60_000, outstandingMinor: 0 })]);
  }, 120_000);

  it('the store\'s setup carries merchandising\'s planning facts from head office — shelf map, plan in force, range, back-store stock, display contracts and finance\'s received figure', async () => {
    const t = randomUUID();
    const h = apiHarness(backing());
    const { call, receive, list } = await setUp(h, t);
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [STORE, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }], [BACK, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: 'C1' }]] as const) {
      expect((await call('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBe(201);
    }
    expect((await call('POST', `/v1/stores/${STORE}/settings`, OWNER, { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: BACK })).status).toBe(201);
    expect((await call('PUT', `/v1/merchandising/stores/${STORE}/shelf-map`, OWNER, { locations: [
      { locationId: 'A1-1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient' },
      { locationId: 'END-1', aisle: 9, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient', label: 'End-cap by the door' },
    ] })).status).toBe(201);
    expect((await call('PUT', `/v1/merchandising/stores/${STORE}/planograms/pg-tea`, OWNER, { effectiveFrom: '2026-01-01', assignments: [
      { productId: 'p-tea', locationId: 'A1-1', capacityMinor: 24, primary: true },
    ] })).status).toBe(201);
    await list('p-tea');
    await receive(BACK, 'p-tea', 100);
    await receive(STORE, 'p-tea', 12);
    await sentWithApproval(h, t, MGR, ACCT, { kind: 'display_contract', subjectRef: 'dc-tea', pathIds: { contractId: 'dc-tea' }, valueMinor: 60_000 },
      { storeId: STORE, supplierId: 'sup-tea', description: 'tea end-cap', fundingAmount: inr(60_000), startsOn: '2026-01-01', endsOn: '2026-12-31', locationIds: ['END-1'] },
      (b) => call('POST', '/v1/merchandising/display-contracts/dc-tea', MGR, b));
    await call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP);
    expect((await call('POST', '/v1/finance/display-funding/dc-tea/receipts/r1', ACCT, { amountMinor: 25_000, receivedOn: today, reference: 'NEFT-1' })).status).toBe(201);

    // The store computer asks head office for its setup, as itself.
    const res = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: BOX, tenantId: t, branchId: STORE });
    expect(res.status).toBe(200);
    const sections = (res.body as { sections: Record<string, unknown> }).sections;
    const pack = readPack(sections, new Date().toISOString());
    expect(pack.shelfLocations.known && pack.shelfLocations.value.map((l) => l.locationId)).toEqual(['A1-1', 'END-1']);
    expect(pack.planogram.known && (pack.planogram.value as { planogramId: string }).planogramId).toBe('pg-tea');
    expect(pack.shelfAssignments.known && pack.shelfAssignments.value).toEqual([expect.objectContaining({ productId: 'p-tea', locationId: 'A1-1', capacityMinor: 24, primary: true })]);
    expect(pack.assortment.known && pack.assortment.value).toEqual([expect.objectContaining({ productId: 'p-tea', status: 'listed' })]);
    expect(pack.backstock.known && pack.backstock.value).toEqual({ 'p-tea': 100 }); // the back store's ledger, not the floor's 12
    expect(pack.displayContracts.known && (pack.displayContracts.value as { contractId: string }[]).map((c) => c.contractId)).toEqual(['dc-tea']);
    expect(pack.fundingReceivedMinor.known && pack.fundingReceivedMinor.value).toEqual({ 'dc-tea': 25_000 });
    // What head office has no register for is LEFT OUT — the store computer says it was not told, never a zero.
    expect(pack.spaceAreas.known).toBe(false);
    expect(pack.salesByAreaMinor.known).toBe(false);
  }, 120_000);
});
