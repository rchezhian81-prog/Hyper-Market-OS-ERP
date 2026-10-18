import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { containsCardNumber } from '../../packages/tender/src/card-token';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **Follow-up F1 (till) at head office — on the in-memory store and, with DATABASE_URL, on real PostgreSQL.**
 *
 *   • NEW-3 (C10 · hard rule #3): a sale whose tender carries a card number, a security code and an expiry is BANKED (it
 *     happened) with those removed, and raised CRITICAL by field name. Nothing card-like is in the event store, the
 *     findings, the answer — or, on PostgreSQL, in any row of any table.
 *   • NEW-1 (B19): an offer that names a carry bag is refused when it is defined.
 *   • L2 (B6 integrity): a scale names its verification certificate; EXTENDING its stamp needs the new certificate and a
 *     second person's approval on the maker-checker engine (ADR-0024); cutting it short needs neither.
 *   • L3 (B6): head office judges a weighed line against its OWN scale register for that lane, on the sale's day — not
 *     against the stamp the till claimed.
 *   • OB-160 and NEW-2 at intake: a part pack of tobacco is critical; a weighed product sent in another unit is weighed.
 * Synthetic data only (hard rule #7).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; sql: boolean; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', sql: false, harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', sql: true, harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: null };
const PAN = ['4111', '1111', '1111', '1111'].join('');
const SCALE = { storeId: 'S1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-300), reverificationDueOn: day(-2) };

const SNAPSHOT = (tenantId: string): CatalogueSnapshot => ({
  tenantId, version: 1, builtAt: NOW, scope: { tenantId, storeId: 'S1' },
  products: [
    { productId: 'p-banana', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
    { productId: 'p-rice', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
    { productId: 'p-stick', sku: 'CIGSTICK', name: 'Cigarette stick (demo)', baseUom: 'ea', unitPriceMinor: 1_800, taxBps: 0, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10 } },
  ],
  barcodes: [],
});

interface Banked { banked: boolean; exceptions: { kind: string; severity: string; productId?: string; detail: string }[] }

describe.each(backings)('F1 at head office — on $name', ({ harness, sql }) => {
  async function headOffice() {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['S1']);
    await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', branchId?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(branchId === undefined ? {} : { branchId }), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: NOW, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: SNAPSHOT(T) },
    }));
    return { h, T, call };
  }
  const sale = (over: Record<string, unknown>) => ({
    saleId: `S-${randomUUID()}`, receiptNumber: `R-${randomUUID().slice(0, 8)}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day(0), committedAt: NOW,
    totalMinor: 70_00, currency: 'INR', packVersion: 1, locationId: 'S1',
    lines: [{ productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 70_00, taxRateBps: 0 }],
    tenders: [{ kind: 'cash', amountMinor: 70_00 }], ...over,
  });

  it('NEW-3: a card number in a tender is banked removed, raised critical by name, and found nowhere afterwards', async () => {
    const { h, T, call } = await headOffice();
    const hostile = sale({ tenders: [{ kind: 'card', amountMinor: 70_00, ref: PAN, card: { tokenRef: `ntok_${PAN}`, last4: '1111', network: 'visa', pan: PAN, cvv: '123', expiry: '12/29' } }] });
    const res = await call('POST', '/v1/sales', hostile, 'u-box');
    expect(res.status).toBe(202);
    const body = res.body as Banked;
    expect(body.banked).toBe(true);
    expect(body.exceptions.filter((e) => e.kind === 'card_data_in_tender').map((e) => e.severity)).toEqual(['critical']);
    expect(JSON.stringify(res.body)).not.toContain(PAN);

    const everything = JSON.stringify(await h.store.exportTenant(T));
    expect(everything).toContain(hostile.saleId); // banked — not lost
    expect(everything).not.toContain(PAN);
    expect(containsCardNumber(everything)).toBe(false);
    const open = await call('GET', '/v1/sales/exceptions');
    expect(JSON.stringify(open.body)).toContain('card data a tender may not keep');
    expect(JSON.stringify(open.body)).not.toContain(PAN);

    if (sql) {
      // Every row of every table in the database, read as text: nothing card-like anywhere.
      const tables = (await pool!.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
      expect(tables).toContain('event_ledger');
      for (const t of tables) {
        const hit = await pool!.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1`, [`%${PAN}%`]);
        expect(hit.rows[0]!.n, `table ${t}`).toBe('0');
      }
    }
  });

  it('r2final NEW-3: a card number sent as a JSON NUMBER, or nested, is banked removed and raised; a normal amount is kept', async () => {
    const { h, T, call } = await headOffice();
    const NUM = Number(PAN);
    const hostile = sale({ tenders: [
      { kind: 'card', amountMinor: 30_00, ref: NUM },
      { kind: 'card', amountMinor: 20_00, status: { pan: NUM }, amount: { minor: 20_00, deep: [NUM] } },
      { kind: 'upi', amountMinor: 20_00, ref: 'UTR2026101700042' },
    ] });
    const res = await call('POST', '/v1/sales', hostile, 'u-box');
    expect(res.status).toBe(202);
    const body = res.body as Banked;
    expect(body.banked).toBe(true);
    const found = body.exceptions.filter((e) => e.kind === 'card_data_in_tender');
    expect(found.map((e) => e.severity)).toEqual(['critical']);
    expect(found[0]!.detail).toMatch(/tender 1 \(card\): ref; tender 2 \(card\): amount, status/);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
    const everything = JSON.stringify(await h.store.exportTenant(T));
    expect(everything).toContain(hostile.saleId);
    expect(everything).not.toContain(PAN);
    // The amounts were figures, not card data: every tender kept its amountMinor, so the tenders still add up.
    expect(body.exceptions.map((e) => e.kind)).not.toContain('tender_does_not_sum_to_total');
    if (sql) {
      const tables = (await pool!.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
      for (const t of tables) {
        const hit = await pool!.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1`, [`%${PAN}%`]);
        expect(hit.rows[0]!.n, `table ${t}`).toBe('0');
      }
    }
  });

  it('NEW-1: an offer that names a carry bag is refused when it is defined; one on rice is defined', async () => {
    const { call } = await headOffice();
    const product = (sku: string, safety: Record<string, unknown>) => ({ sku, name: sku, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '63053300', lifecycle: 'draft', safety });
    const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
    expect((await call('POST', '/v1/catalogue/products/p-bag/publish', { product: product('BAG120', { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 }), categories: [GROCERY] })).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/products/p-rice/publish', { product: product('RICE1', {}), categories: [GROCERY] })).status).toBe(201);
    const offer = (productIds: string[]) => ({ kind: 'amount_off', startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', amountOffMinor: 500, productIds });
    const bag = await call('POST', '/v1/promotions/PR-FREEBAG/definition', offer(['p-rice', 'p-bag']));
    expect(bag.status).toBe(422);
    expect(bag.body).toMatchObject({ error: { code: 'promotion_targets_a_carry_bag' } });
    expect(JSON.stringify(bag.body)).toContain('p-bag');
    expect((await call('GET', '/v1/promotions/PR-FREEBAG/definition')).status).toBe(404); // nothing was recorded
    expect((await call('POST', '/v1/promotions/PR-RICE/definition', offer(['p-rice']))).status).toBe(201);
  });

  it('L2: a certificate on every scale; extending a stamp needs the new certificate AND a second person; cutting it short needs neither', async () => {
    const { call } = await headOffice();
    const noCert = await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: day(100) });
    expect(noCert.status).toBe(422);
    expect(noCert.body).toMatchObject({ error: { code: 'scale_certificate_required' } });
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: day(100), certificateRef: 'LM/VC/2025/0042' }, 'u-mgr', 'S1')).status).toBe(201);

    // The manager extends the stamp alone: refused — first for the certificate on record, then for the second person.
    const extended = { ...SCALE, lastStampedOn: day(0), reverificationDueOn: day(365) };
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...extended, certificateRef: 'LM/VC/2025/0042' }, 'u-mgr', 'S1')).body).toMatchObject({ error: { code: 'scale_certificate_required' } });
    const change = { ...extended, certificateRef: 'LM/VC/2026/0107' };
    const alone = await call('POST', '/v1/facilities/scales/SCALE-1', change, 'u-mgr', 'S1');
    expect(alone.status).toBe(422);
    expect(alone.body).toMatchObject({ error: { code: 'scale_stamp_change_needs_approval' } });
    // A typed approver's name is no approval.
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, approvedBy: 'u-owner' }, 'u-mgr', 'S1')).status).toBeGreaterThanOrEqual(400);

    // The manager asks; the manager cannot approve their own; the owner approves in his own session.
    const asked = await call('POST', '/v1/approvals/requests', { kind: 'scale_stamp_change', subjectRef: 'SCALE-1', valueMinor: null, details: { ...change, assetId: 'SCALE-1' }, summary: 'SCALE-1 re-verified', reason: 'new stamp certificate LM/VC/2026/0107' }, 'u-mgr', 'S1');
    expect(asked.status).toBe(201);
    const requestId = (asked.body as { requestId: string }).requestId;
    expect((await call('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'mine' }, 'u-mgr', 'S1')).status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', `/v1/approvals/requests/${requestId}/decide`, { decision: 'approved', reason: 'certificate seen' })).status).toBe(201);
    // An approval for a DIFFERENT change does not cover this one.
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, reverificationDueOn: day(700), approvalId: requestId }, 'u-mgr', 'S1')).status).toBeGreaterThanOrEqual(400);
    const done = await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, approvalId: requestId }, 'u-mgr', 'S1');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ scale: { version: 2, reverificationDueOn: day(365), certificateRef: 'LM/VC/2026/0107', approvalId: requestId, approvedBy: 'u-owner', setBy: 'u-mgr' } });
    // Used once.
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, reverificationDueOn: day(366), approvalId: requestId }, 'u-mgr', 'S1')).status).toBeGreaterThanOrEqual(400);

    // A scale found faulty: the manager cuts the stamp short alone — it only stops weighing.
    const cut = await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, lastStampedOn: day(-10), reverificationDueOn: day(-1) }, 'u-mgr', 'S1');
    expect(cut.status).toBe(200);
    expect(cut.body).toMatchObject({ scale: { version: 3, reverificationDueOn: day(-1) }, verification: { tradingBlocked: true } });
    // Moving lanes leaves the dates alone: no second person.
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...change, lastStampedOn: day(-10), reverificationDueOn: day(-1), laneIds: ['lane-1', 'lane-2'] }, 'u-mgr', 'S1')).status).toBe(200);
  });

  it('L3: a weighed line is judged against head office\'s OWN register for that lane, not the stamp the till claimed', async () => {
    const { call } = await headOffice();
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, certificateRef: 'LM/VC/2025/0042' })).status).toBe(201); // lapsed 2 days ago
    const weighed = (laneId: string) => sale({
      laneId, totalMinor: 33_29, tenders: [{ kind: 'cash', amountMinor: 33_29 }],
      // The till CLAIMS a current scale.
      lines: [{ productId: 'p-banana', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 33_29, taxRateBps: 0, scaleCheck: { checkedOn: day(0), scales: [{ assetId: 'SCALE-1', reverificationDueOn: day(300) }] } }],
    });
    const lane1 = (await call('POST', '/v1/sales', weighed('lane-1'), 'u-box')).body as Banked;
    const b6 = lane1.exceptions.filter((e) => e.kind === 'weighed_on_unverified_scale');
    expect(b6.map((e) => e.severity)).toEqual(['critical']);
    expect(b6[0]!.detail).toContain(`SCALE-1 (stamp valid to ${day(-2)})`);
    // A lane head office's register gives no scale at all in that store.
    const lane2 = (await call('POST', '/v1/sales', weighed('lane-2'), 'u-box')).body as Banked;
    expect(lane2.exceptions.filter((e) => e.kind === 'weighed_on_unverified_scale').map((e) => [e.severity, e.detail])).toEqual([['material', expect.stringContaining("head office's scale register has no scale for that lane") as unknown]]);
  });

  it('OB-160 and NEW-2 at intake: a part pack is critical; a kg product sent as "ea" is weighed and its unit is raised', async () => {
    const { call } = await headOffice();
    const part = (await call('POST', '/v1/sales', sale({
      totalMinor: 27_000, tenders: [{ kind: 'cash', amountMinor: 27_000 }],
      lines: [{ productId: 'p-stick', quantityMinor: 15, uom: 'ea', unitPriceMinor: 1_800, lineTotalMinor: 27_000, taxRateBps: 0, ageCheck: { minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u-cash', confirmedAt: NOW } }],
    }), 'u-box')).body as Banked;
    expect(part.exceptions.map((e) => [e.kind, e.severity])).toContainEqual(['tobacco_sold_below_pack', 'critical']);
    const asEach = (await call('POST', '/v1/sales', sale({
      totalMinor: 33_29, tenders: [{ kind: 'cash', amountMinor: 33_29 }],
      lines: [{ productId: 'p-banana', quantityMinor: 333, uom: 'ea', unitPriceMinor: 99_99, lineTotalMinor: 33_29, taxRateBps: 0 }],
    }), 'u-box')).body as Banked;
    const kinds = asEach.exceptions.map((e) => e.kind);
    expect(kinds).toContain('weighed_on_unverified_scale');
    expect(kinds).toContain('unit_differs_from_catalogue');
  });
});
