import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TillRuleRefusedError } from '../../apps/pos/src/session';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { packPayloadOf } from '../../edge/store-edge/src/store-pack-held';
import { laneScalesFor, checkTillRules } from '../../edge/store-edge/src/lane-scales';
import { verifyStorePack, type StorePackEnvelope } from '../../services/platform/src/store-packs';
import { hmacSigner } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **R2 lane 1 — the till's legal gates, head office to till and back (roadmap v2.1 B5 · B6 · B14 · B19 · hard rules #1,
 * #2, #10 · P-08).** In memory and, with DATABASE_URL, on real PostgreSQL.
 *
 *   • B6: head office records a weighing scale on the register (append-only, a new version each change, audited); the
 *     store pack it signs for the store carries it; the store computer reads which scales THIS lane weighs on; the REAL
 *     till refuses weight from a lapsed stamp and sells on a current one; the store computer's own gate refuses a lapsed
 *     weight before its disk.
 *   • B14 · B19: the product master declares tobacco + pack size and the carry-bag / plastic facts; the pack preview
 *     carries them as `regulatedFlags`; a tobacco product without a pack size does not publish.
 *   • Sale intake (the cloud's re-check): a sale from an OLD till that sold a banned plastic, a thin bag, a loose
 *     cigarette and a weight with no scale record, rounded up, is BANKED (the goods are gone) and each is a finding; the
 *     same goods rung on the real till raise none of them.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: null };
const SCALE = { storeId: 'S1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-300), certificateRef: 'LM/VC/2026/0042' };

const SNAPSHOT = (tenantId: string): CatalogueSnapshot => ({
  tenantId, version: 1, builtAt: NOW,
  products: [
    { productId: 'p-banana', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
    { productId: 'p-cig', sku: 'CIG10', name: 'Cigarettes 10s (demo)', baseUom: 'ea', unitPriceMinor: 18_000, taxBps: 0, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 1 } },
    { productId: 'p-stick', sku: 'CIGSTICK', name: 'Cigarette stick (demo)', baseUom: 'ea', unitPriceMinor: 1_800, taxBps: 0, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10 } },
    { productId: 'p-straw', sku: 'STRAW', name: 'Plastic straws (demo)', baseUom: 'ea', unitPriceMinor: 2_000, taxBps: 0, status: 'active', regulatedFlags: { bannedSingleUsePlastic: true } },
    { productId: 'p-thin', sku: 'BAG50', name: 'Carry bag 50 micron (demo)', baseUom: 'ea', unitPriceMinor: 300, taxBps: 0, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 50 } },
    { productId: 'p-bag', sku: 'BAG120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 500, taxBps: 0, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
  ],
  barcodes: [
    { code: '8900000000110', productId: 'p-cig', kind: 'standard' },
    { code: '8900000000400', productId: 'p-bag', kind: 'standard' },
  ],
  embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
});

interface Banked { banked: boolean; exceptions: { kind: string; severity: string; productId?: string; differenceMinor?: number }[] }

describe.each(backings)('R2 lane 1 — the till enforces the legal gates — on $name', ({ harness }) => {
  async function headOffice(): Promise<{ h: ApiHarness; T: string; call: (method: 'GET' | 'POST', path: string, body?: unknown, userId?: string, query?: Record<string, string>) => ReturnType<ApiHarness['request']> }> {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    await h.provisionRole(T, 'u-cash', 'cashier', ['S1']);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    expect((await call('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' })).status).toBe(201);
    expect((await call('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' })).status).toBe(201);
    expect((await call('POST', '/v1/stores/S1/settings', SETTINGS)).status).toBe(201);
    return { h, T, call };
  }

  it('B6: the scale register is head office\'s (versioned, audited, permissioned); the signed store pack carries it to the lane; the till and the box refuse weight from a lapsed stamp', async () => {
    const { h, T, call } = await headOffice();
    // Refused: unreadable, unknown store, a cashier.
    const bad = await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: 'next year' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('reverificationDueOn must be a date YYYY-MM-DD');
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, storeId: 'S9', reverificationDueOn: day(100) })).status).toBe(404);
    expect((await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: day(100) }, 'u-cash')).status).toBe(403);

    // Recorded, then restated with a lapsed stamp: a new version, the first kept.
    const first = await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: day(100) });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ scale: { version: 1, setBy: 'u-owner', laneIds: ['lane-1'] }, verification: { tradingBlocked: false } });
    const SCALES = streamName(STREAM.facilities, 'weighing-scales');
    const versions = await h.store.readStream(T, SCALES);
    expect(versions).toHaveLength(1);

    const register = await call('GET', '/v1/facilities/scales', undefined, 'u-owner', { storeId: 'S1' });
    expect(register.status).toBe(200);
    expect((register.body as { scales: { assetId: string; verification: { level: string } }[] }).scales.map((s) => [s.assetId, s.verification.level])).toEqual([['SCALE-1', 'current']]);

    // The store computer pulls its signed setup: the scale rides in it, and the signature covers it.
    const pull = await call('GET', '/v1/store-packs/S1', undefined, 'u-box');
    expect(pull.status).toBe(200);
    const env = pull.body as StorePackEnvelope;
    expect(verifyStorePack(hmacSigner(TEST_PACK_KEY), env, { tenantId: T, storeId: 'S1', heldVersion: null, now: NOW })).toEqual({ accepted: true });
    expect(env.sections['weighingScales']).toEqual([{ assetId: 'SCALE-1', laneIds: ['lane-1'], approvalNo: SCALE.approvalNo, capacityGrams: 30_000, lastStampedOn: SCALE.lastStampedOn, reverificationDueOn: day(100), version: 1, certificateRef: SCALE.certificateRef }]);
    const tampered = { ...env, sections: { ...env.sections, weighingScales: [{ ...(env.sections['weighingScales'] as Record<string, unknown>[])[0], reverificationDueOn: '2099-12-31' }] } };
    expect(verifyStorePack(hmacSigner(TEST_PACK_KEY), tampered, { tenantId: T, storeId: 'S1', heldVersion: null, now: NOW }).accepted).toBe(false);

    const pack = readPack(packPayloadOf(env), NOW);
    const lane1 = laneScalesFor(pack, 'lane-1');
    expect(lane1).toEqual({ known: true, scales: [{ assetId: 'SCALE-1', approvalNo: SCALE.approvalNo, capacityGrams: 30_000, lastStampedOn: SCALE.lastStampedOn, reverificationDueOn: day(100) }] });
    expect(laneScalesFor(pack, 'lane-2')).toEqual({ known: true, scales: [] }); // a lane with no scale weighs nothing

    // The real till on lane 1 sells by weight on the current stamp…
    const sold = bootPos({ laneId: 'lane-1', cashierId: 'u-cash', catalogue: SNAPSHOT(T), laneScales: lane1, durable: async () => ({ committed: true, durable: true, detail: 'test', laneMessage: 'saved' }) });
    sold.scanBarcode('2000123003330');
    expect(sold.payableMinor()).toBe(33_29); // B5: 333 g × ₹99.99/kg, never rounded up

    // …and once head office restates the stamp as lapsed, the next pack stops it.
    const lapsed = await call('POST', '/v1/facilities/scales/SCALE-1', { ...SCALE, reverificationDueOn: day(-1) });
    expect(lapsed.status).toBe(200);
    expect(lapsed.body).toMatchObject({ scale: { version: 2 }, verification: { tradingBlocked: true, level: 'expired' } });
    expect(await h.store.readStream(T, SCALES)).toHaveLength(2); // append-only: version 1 kept
    // Each change is on the audit trail, with who, before and after.
    const trail = (await call('GET', '/v1/audit/trail', undefined, 'u-owner', { action: 'facilities.scale.set' })).body as { matches: { actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.before?.['reverificationDueOn'] ?? null, m.after['reverificationDueOn']])).toEqual(expect.arrayContaining([
      ['u-owner', 'SCALE-1', null, day(100)], ['u-owner', 'SCALE-1', day(100), day(-1)],
    ]));
    const pack2 = readPack(packPayloadOf((await call('GET', '/v1/store-packs/S1', undefined, 'u-box')).body as StorePackEnvelope), NOW);
    const refused = bootPos({ laneId: 'lane-1', cashierId: 'u-cash', catalogue: SNAPSHOT(T), laneScales: laneScalesFor(pack2, 'lane-1'), durable: async () => ({ committed: true, durable: true, detail: 'test', laneMessage: 'saved' }) });
    expect(() => refused.scanBarcode('2000123003330')).toThrow(TillRuleRefusedError);
    // The store computer's own gate, before its disk, on a record from a till page that skipped the check.
    const box = checkTillRules({ lines: [{ productId: 'p-banana', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99 }] }, {
      products: new Map([['p-banana', { name: 'Banana (loose)' }]]), scales: laneScalesFor(pack2, 'lane-1'), today: day(0),
    });
    expect(box).toMatchObject({ ok: false, refusedBecause: 'weighed_on_lapsed_scale', productId: 'p-banana' });
    expect((box as { laneMessage: string }).laneMessage).toMatch(/^Do not take payment\. .* Nothing was saved\.$/);
  });

  it('B14 · B19: the product master carries tobacco pack size and carry-bag facts into the pack; a tobacco product with no pack size does not publish', async () => {
    const { call } = await headOffice();
    const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
    const TOBACCO = { categoryId: 'tobacco', name: 'Tobacco', parentId: null, regulated: ['age_restricted'] };
    const product = (sku: string, name: string, cat: string, safety: Record<string, unknown>) => ({ sku, name, baseUom: 'each', primaryCategoryId: cat, taxClass: '24022010', lifecycle: 'draft', safety });
    const publish = (id: string, p: unknown, categories: unknown[]) => call('POST', `/v1/catalogue/products/${id}/publish`, { product: p, categories });

    const noPack = await publish('p-cig', product('CIG10', 'Cigarettes 10s', 'tobacco', { minimumAge: 18, tobacco: true }), [TOBACCO]);
    expect(noPack.status).toBe(422);
    expect(JSON.stringify(noPack.body)).toContain('a tobacco product needs its pack size');
    const underAge = await publish('p-cig', product('CIG10', 'Cigarettes 10s', 'tobacco', { minimumAge: 16, tobacco: true, packMinimumMinor: 1 }), [TOBACCO]);
    expect(underAge.status).toBe(422);
    expect((await publish('p-cig', product('CIG10', 'Cigarettes 10s', 'tobacco', { minimumAge: 18, tobacco: true, packMinimumMinor: 1 }), [TOBACCO])).status).toBe(201);
    expect((await publish('p-bag', product('BAG120', 'Carry bag 120 micron', 'grocery', { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 }), [GROCERY])).status).toBe(201);
    expect((await publish('p-straw', product('STRAW', 'Plastic straws', 'grocery', { bannedSingleUsePlastic: true }), [GROCERY])).status).toBe(201);
    expect((await call('POST', '/v1/catalogue/tax-classes/24022010/rates/2017-07-01', { rateBps: 2800 })).status).toBe(201);
    for (const id of ['p-cig', 'p-bag', 'p-straw']) {
      expect((await call('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: 'S1', priceMinor: 500, mrpMinor: 600, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' })).status).toBe(201);
    }
    const preview = await call('GET', '/v1/catalogue/pack/preview', undefined, 'u-owner', { storeId: 'S1', asOf: '2030-06-01' });
    expect(preview.status).toBe(200);
    const flags = Object.fromEntries((preview.body as { snapshot: { products: { productId: string; regulatedFlags?: unknown }[] } }).snapshot.products.map((p) => [p.productId, p.regulatedFlags]));
    expect(flags).toEqual({
      'p-cig': { tobacco: true, minimumAge: 18, packMinimumMinor: 1 },
      'p-bag': { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 },
      'p-straw': { bannedSingleUsePlastic: true },
    });
  });

  it('sale intake re-checks: an OLD till\'s unlawful lines are banked AND raised; the same goods rung on the real till raise none', async () => {
    const { h, T } = await headOffice();
    await h.store.append(T, STREAM.catalogue, makeEvent({
      id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: NOW, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { ...SNAPSHOT(T), scope: { tenantId: T, storeId: 'S1' } } },
    }));
    const old = {
      saleId: 'S-OLD', receiptNumber: 'R-OLD-1', laneId: 'lane-9', cashierId: 'u-cash', tradingDay: day(0), committedAt: NOW,
      totalMinor: 2_000 + 300 + 1_800 + 33_30, currency: 'INR', packVersion: 1,
      lines: [
        { productId: 'p-straw', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_000, lineTotalMinor: 2_000, taxRateBps: 0 },
        { productId: 'p-thin', quantityMinor: 1, uom: 'ea', unitPriceMinor: 300, lineTotalMinor: 300, taxRateBps: 0 },
        { productId: 'p-stick', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_800, lineTotalMinor: 1_800, taxRateBps: 0, ageCheck: { minimumAge: 18, confirmedAtLeast: 18, confirmedBy: 'u-cash', confirmedAt: NOW } },
        { productId: 'p-banana', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 33_30, taxRateBps: 0 },
      ],
      tenders: [{ kind: 'cash', amountMinor: 2_000 + 300 + 1_800 + 33_30 }],
    };
    const res = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: T, idempotencyKey: 'k-old', body: old });
    expect(res.status).toBe(202);
    const body = res.body as Banked;
    expect(body.banked).toBe(true);
    const found = body.exceptions.map((e) => [e.kind, e.severity, e.productId]);
    expect(found).toEqual(expect.arrayContaining([
      ['unlawful_plastic_sold', 'critical', 'p-straw'],
      ['unlawful_plastic_sold', 'critical', 'p-thin'],
      ['tobacco_sold_below_pack', 'critical', 'p-stick'],
      ['weighed_on_unverified_scale', 'material', 'p-banana'],
      ['weighed_line_charged_above_weight_times_price', 'material', 'p-banana'],
    ]));
    expect(body.exceptions.find((e) => e.kind === 'weighed_line_charged_above_weight_times_price')?.differenceMinor).toBe(1);

    // A weighed line whose OWN evidence shows the stamp had lapsed is critical.
    const lapsed = { ...old, saleId: 'S-LAPSED', receiptNumber: 'R-OLD-2', totalMinor: 33_29, tenders: [{ kind: 'cash', amountMinor: 33_29 }],
      lines: [{ productId: 'p-banana', quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 33_29, taxRateBps: 0, scaleCheck: { checkedOn: day(0), scales: [{ assetId: 'SCALE-1', reverificationDueOn: day(-2) }] } }] };
    const lapsedRes = (await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: T, idempotencyKey: 'k-lapsed', body: lapsed })).body as Banked;
    expect(lapsedRes.exceptions.map((e) => [e.kind, e.severity])).toContainEqual(['weighed_on_unverified_scale', 'critical']);

    // The same goods, lawfully, on the REAL till: a whole pack with the ID check, a 120-micron bag, banana on a current scale.
    const written: unknown[] = [];
    const tillView = bootPos({
      laneId: 'lane-1', cashierId: 'u-cash', tradingDay: day(0), catalogue: SNAPSHOT(T),
      laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: day(100) }] },
      durable: async (_id, record) => { written.push(JSON.parse(record)); return { committed: true, durable: true, detail: 'test', laneMessage: 'saved' }; },
    });
    tillView.confirmAge(18, NOW, 'p-cig');
    tillView.scanBarcode('8900000000110');
    tillView.scanBarcode('8900000000400');
    tillView.scanBarcode('2000123003330');
    await tillView.tenderCash('S-NEW', 'R-NEW-1', NOW);
    const sale = toCloudSale(written[0], 1, 'S1', 'lane-1');
    const clean = (await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: T, idempotencyKey: 'k-new', body: sale })).body as Banked;
    const lawKinds = ['unlawful_plastic_sold', 'tobacco_sold_below_pack', 'weighed_on_unverified_scale', 'weighed_line_charged_above_weight_times_price', 'age_restricted_sold_without_check'];
    expect(clean.exceptions.filter((e) => lawKinds.includes(e.kind))).toEqual([]);
  });
});
