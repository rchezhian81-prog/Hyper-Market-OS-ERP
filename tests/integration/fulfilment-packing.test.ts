import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

// Packing & dispatch, end to end (M19-FR-02 / D09 / M10-FR-02, API-08). Between the shelf and the van the
// shop can catch a mistake for free or make an expensive one: a weighed line's final price is captured AT
// PACK (never guessed at the doorstep), a cold item packed warm or unmeasured does not go on the van, a crate
// cannot mix incompatible handling, and the dispatch manifest is derived from what was PACKED — never from
// what was ordered, which is why the pack is recorded and the dispatch reads it back. Gated
// fulfilment.pack.record (write) / .read (reads).
//
// FUL-04 (Batch 2): the desk packs an order HEAD OFFICE HOLDS under HEAD OFFICE'S rules. The audit's case — a frozen line
// with no temperature accepted by sending `rules: []`, then dispatched for an order that never existed — is refused at both
// steps. The order and its quantities come from the order register; handling and cold-chain limits from the product master
// (the same resolver as the wave path); name and price from the published catalogue. The desk says only what it observed.
// In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type PackBody = { packed: boolean; outcome: string; totalMinor: number; lines: { lineId: string; finalPriceMinor: number; coldChain?: { source: string } }[]; refused: { lineId: string; reason: string }[] };
const AT = '2026-10-10T08:00:00.000Z';

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

/** Catalogue (name, price) and product master (unit, handling, limits) for the products the orders below ask for. */
const PRODUCTS: readonly { id: string; name: string; priceMinor: number; baseUom: string; handling?: string; coldChain?: { minTenthsC?: number; maxTenthsC?: number } }[] = [
  { id: 'p-chk', name: 'chicken', priceMinor: 20_000, baseUom: 'kg', handling: 'raw_meat' },
  { id: 'p-atta', name: 'atta 5kg', priceMinor: 5_000, baseUom: 'each', handling: 'ambient' },
  { id: 'p-milk', name: 'milk', priceMinor: 3_000, baseUom: 'each', handling: 'chilled' },
  { id: 'p-ice', name: 'ice cream', priceMinor: 25_000, baseUom: 'each', handling: 'frozen' },
  { id: 'p-rice', name: 'rice', priceMinor: 6_000, baseUom: 'each', handling: 'ambient' },
  { id: 'p-tin', name: 'tinned beans', priceMinor: 4_000, baseUom: 'each', handling: 'ambient' },
  { id: 'p-apple', name: 'apples', priceMinor: 3_000, baseUom: 'each', handling: 'ambient' },
  { id: 'p-paneer', name: 'paneer', priceMinor: 9_000, baseUom: 'each', handling: 'chilled', coldChain: { minTenthsC: -20, maxTenthsC: 40 } },
  { id: 'p-new', name: 'new line', priceMinor: 1_000, baseUom: 'each' }, // the master names no handling class
];

async function cast(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager'); // fulfilment.pack.record + read
  await h.provisionRole(t, 'u-cash', 'cashier');       // neither
  await h.store.append(t, STREAM.catalogue, makeEvent({
    id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: t, version: 1, builtAt: AT, scope: { tenantId: t, storeId: 'store-01' }, barcodes: [], products:
      PRODUCTS.map((p) => ({ productId: p.id, sku: p.id, name: p.name, unitPriceMinor: p.priceMinor, taxBps: 0, status: 'active', uom: p.baseUom === 'kg' ? 'kg' : 'ea', batchTracked: false })) } },
  }));
  for (const p of PRODUCTS) {
    expect((await call('POST', `/v1/catalogue/products/${p.id}/publish`, 'u-owner', {
      product: { sku: p.id, name: p.name, baseUom: p.baseUom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', ...(p.handling === undefined ? {} : { handling: p.handling }), ...(p.coldChain === undefined ? {} : { coldChain: p.coldChain }) },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, `pub-${p.id}`)).status).toBe(201);
  }
  /** An order on head office's register, confirmed — the way a customer's order reaches the desk. */
  const order = async (orderId: string, lines: { productId: string; quantityMinor: number }[], confirm = true) => {
    expect((await call('POST', `/v1/orders/${orderId}/promise`, 'u-mgr', { lines, locationId: 'store-01' }, `promise-${orderId}`)).status).toBe(200);
    if (confirm) expect((await call('POST', `/v1/orders/${orderId}/transition`, 'u-mgr', { event: 'confirm' }, `confirm-${orderId}`)).status).toBeLessThan(300);
  };
  const pack = (u: string, orderId: string, body: Record<string, unknown>, key?: string) => call('POST', `/v1/fulfilment/orders/${orderId}/pack`, u, body, key ?? `pack-${orderId}`);
  const dispatch = (u: string, orderId: string, body: Record<string, unknown>, key?: string) => call('POST', `/v1/fulfilment/orders/${orderId}/dispatch`, u, body, key ?? `disp-${orderId}`);
  return { call, order, pack, dispatch };
}

describe.each(backings)('fulfilment packing: price at pack, cold-chain crate rules, manifest from what was packed (M19-FR-02 · FUL-04) — on $name', ({ harness }) => {
  it('prices a weighed line at its packed weight from the catalogue price, dispatches a sealed load, and the manifest survives a restart', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    await c.order('o1', [{ productId: 'p-chk', quantityMinor: 1_187 }, { productId: 'p-atta', quantityMinor: 2 }]);
    const res = await c.pack('u-mgr', 'o1', {
      lines: [{ productId: 'p-chk', pickedMinor: 1_187, packedGrams: 1_187, packTenthsC: 20 }, { productId: 'p-atta', pickedMinor: 2 }],
      crateAssignment: { 'p-chk': 'crate-1', 'p-atta': 'crate-2' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as PackBody;
    expect(body).toMatchObject({ packed: true, outcome: 'packed' });
    expect(body.refused).toHaveLength(0);
    // Exact integer price from the packed grams at the CATALOGUE's ₹200.00 a kg: 20000 × 1187 g = 23740, never a float.
    expect(body.lines.find((l) => l.lineId === 'p-chk')?.finalPriceMinor).toBe(23_740);
    expect(body.totalMinor).toBe(23_740 + 10_000);

    const disp = await c.dispatch('u-mgr', 'o1', { manifestId: 'm1', locationId: 'store-01', seals: { 'crate-1': 'seal-a', 'crate-2': 'seal-b' } });
    expect(disp.status).toBe(200);
    expect(disp.body).toMatchObject({ dispatched: true, outcome: 'dispatched' });

    // The manifest is derived from what was PACKED, is event-sourced, and survives a cold restart.
    const restarted = apiHarness({ store: h.store });
    const man = await restarted.request({ method: 'GET', path: '/v1/fulfilment/orders/o1/manifest', userId: 'u-owner', tenantId: t });
    expect(man.status).toBe(200);
    const manifest = man.body as { orderId: string; totalMinor: number; crates: string[]; detail: string };
    expect(manifest).toMatchObject({ orderId: 'o1', totalMinor: 33_740 });
    expect(manifest.crates).toEqual(['crate-1', 'crate-2']);
    expect(manifest.detail).toContain('what was packed');
  }, 60_000);

  it('FUL-04 — the audit\'s case: rules: [] cannot switch the cold chain off; a handling class or a price from the desk is refused by name; nothing is packed', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    await c.order('o-ice', [{ productId: 'p-ice', quantityMinor: 1 }]);
    const noRules = await c.pack('u-mgr', 'o-ice', { lines: [{ productId: 'p-ice', pickedMinor: 1 }], rules: [] });
    expect(noRules.status).toBe(400);
    expect(codeOf(noRules)).toBe('pack_carries_caller_rules');
    for (const [field, value] of [['handling', 'ambient'], ['unitPriceMinor', 1], ['orderedMinor', 1], ['coldChain', { maxTenthsC: 500 }]] as const) {
      expect(codeOf(await c.pack('u-mgr', 'o-ice', { lines: [{ productId: 'p-ice', pickedMinor: 1, [field]: value }] }, `pack-${field}`)), field).toBe('pack_carries_caller_rules');
    }
    expect((await c.call('GET', '/v1/fulfilment/orders/o-ice/pack', 'u-mgr')).status).toBe(404);
    // Sent honestly, the frozen line with no temperature is refused by the MASTER's rule — and cannot be dispatched.
    const honest = (await c.pack('u-mgr', 'o-ice', { lines: [{ productId: 'p-ice', pickedMinor: 1 }], crateAssignment: { 'p-ice': 'crate-f' } }, 'pack-honest')).body as PackBody;
    expect(honest.refused).toEqual([expect.objectContaining({ lineId: 'p-ice', reason: 'temperature_not_taken' })]);
    expect(codeOf(await c.dispatch('u-mgr', 'o-ice', { manifestId: 'm-ice', locationId: 'store-01', seals: { 'crate-f': 's' } }))).toBe('nothing_packed');
  }, 60_000);

  it('FUL-04 — an order head office does not hold is neither packed nor dispatched; nor one not yet confirmed; nor a product not on it, nor more than was ordered', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    const ghost = await c.pack('u-mgr', 'ghost', { lines: [{ productId: 'p-tin', pickedMinor: 1 }] });
    expect(ghost.status).toBe(404);
    expect(codeOf(ghost)).toBe('order_unknown');
    expect(codeOf(await c.dispatch('u-mgr', 'ghost', { manifestId: 'm', locationId: 's', seals: {} }))).toBe('order_unknown');
    await c.order('o-placed', [{ productId: 'p-tin', quantityMinor: 1 }], false);
    expect(codeOf(await c.pack('u-mgr', 'o-placed', { lines: [{ productId: 'p-tin', pickedMinor: 1 }] }))).toBe('order_not_packable');
    await c.order('o-x', [{ productId: 'p-tin', quantityMinor: 2 }]);
    expect(codeOf(await c.pack('u-mgr', 'o-x', { lines: [{ productId: 'p-rice', pickedMinor: 1 }] }, 'px1'))).toBe('not_on_order');
    expect(codeOf(await c.pack('u-mgr', 'o-x', { lines: [{ productId: 'p-tin', pickedMinor: 3 }] }, 'px2'))).toBe('more_picked_than_ordered');
  }, 60_000);

  it('refuses an unmeasured cold chain, an incompatible crate, a weightless weighed line and a product with no handling class — the rest still packs; the product\'s own limits apply', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    await c.order('o2', [
      { productId: 'p-milk', quantityMinor: 1 }, { productId: 'p-ice', quantityMinor: 1 }, { productId: 'p-rice', quantityMinor: 1 },
      { productId: 'p-chk', quantityMinor: 500 }, { productId: 'p-tin', quantityMinor: 3 }, { productId: 'p-new', quantityMinor: 1 }, { productId: 'p-paneer', quantityMinor: 1 },
    ]);
    const body = (await c.pack('u-mgr', 'o2', {
      lines: [
        { productId: 'p-milk', pickedMinor: 1 },                        // chilled, no temperature → temperature_not_taken
        { productId: 'p-ice', pickedMinor: 1, packTenthsC: -180 },
        { productId: 'p-rice', pickedMinor: 1 },                        // frozen + ambient share crate-x → incompatible
        { productId: 'p-chk', pickedMinor: 500, packTenthsC: 0 },       // weighed (master: kg), no packedGrams
        { productId: 'p-tin', pickedMinor: 3 },                         // clean
        { productId: 'p-new', pickedMinor: 1 },                         // the master names no handling class
        { productId: 'p-paneer', pickedMinor: 1, packTenthsC: 45 },     // 4.5 °C: above paneer's OWN 4 °C limit
      ],
      crateAssignment: { 'p-milk': 'crate-cold', 'p-ice': 'crate-x', 'p-rice': 'crate-x', 'p-chk': 'crate-fish', 'p-tin': 'crate-dry', 'p-new': 'crate-dry', 'p-paneer': 'crate-cold2' },
    })).body as PackBody;
    const reasons = Object.fromEntries(body.refused.map((r) => [r.lineId, r.reason]));
    expect(reasons['p-milk']).toBe('temperature_not_taken');
    expect(['p-ice', 'p-rice'].some((id) => reasons[id] === 'incompatible_crate')).toBe(true);
    expect(reasons['p-chk']).toBe('weight_not_captured');
    expect(reasons['p-new']).toBe('handling_unknown');
    expect(reasons['p-paneer']).toBeDefined();
    // One bad crate never stops the rest — the clean tin still packed at the catalogue's ₹40.00.
    expect(body.lines.find((l) => l.lineId === 'p-tin')?.finalPriceMinor).toBe(12_000);
    expect(body.packed).toBe(true);
  }, 60_000);

  it('an ordered product the desk did not name was not picked — a short line, said; dispatch needs it resolved and every crate sealed', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    await c.order('o3', [{ productId: 'p-apple', quantityMinor: 5 }, { productId: 'p-tin', quantityMinor: 1 }]);
    expect(codeOf(await c.dispatch('u-mgr', 'o3', { manifestId: 'm', locationId: 's', seals: {} }, 'd-never'))).toBe('no_pack_recorded');
    const packed = (await c.pack('u-mgr', 'o3', { lines: [{ productId: 'p-apple', pickedMinor: 3 }], crateAssignment: { 'p-apple': 'crate-1' } })).body as PackBody;
    expect(packed.lines.map((l) => l.lineId)).toContain('p-apple');
    expect(codeOf(await c.dispatch('u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: { 'crate-1': 'seal' } }, 'd3a'))).toBe('unresolved_lines');
    expect(codeOf(await c.dispatch('u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: {}, resolvedLineIds: ['p-apple', 'p-tin'] }, 'd3b'))).toBe('unsealed_crate');
    const ok = await c.dispatch('u-mgr', 'o3', { manifestId: 'm3', locationId: 's', seals: { 'crate-1': 'seal' }, resolvedLineIds: ['p-apple', 'p-tin'] }, 'd3c');
    expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ dispatched: true });
  }, 60_000);

  it('is gated to fulfilment staff and refuses a malformed pack', async () => {
    const h = harness();
    const t = randomUUID();
    const c = await cast(h, t);
    await c.order('o4', [{ productId: 'p-tin', quantityMinor: 1 }]);
    const good = { lines: [{ productId: 'p-tin', pickedMinor: 1 }], crateAssignment: { 'p-tin': 'crate-1' } };
    expect((await c.pack('u-cash', 'o4', good)).status).toBe(403);
    expect((await c.dispatch('u-cash', 'o4', { manifestId: 'm', locationId: 's', seals: {} })).status).toBe(403);
    expect((await c.call('GET', '/v1/fulfilment/orders/o4/pack', 'u-cash')).status).toBe(403);
    expect(codeOf(await c.pack('u-mgr', 'o4', { lines: [], crateAssignment: {} }, 'p-empty'))).toBe('not_readable_as_a_pack');
    expect(codeOf(await c.pack('u-mgr', 'o4', { lines: [{ productId: 'p-tin', pickedMinor: 1 }, { productId: 'p-tin', pickedMinor: 1 }] }, 'p-dup'))).toBe('not_readable_as_a_pack');
  }, 60_000);
});
