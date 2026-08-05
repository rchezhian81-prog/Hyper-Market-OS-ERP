import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { buildSurface } from '../../services/api/src/main';
import { catalogueAdapter, posAdapter, STREAM } from '../../services/api/src/adapters';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import { project } from '../../services/inventory/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **It remembers.**
 *
 * Until this test the API booted, answered, and forgot everything — every service was wired to a
 * stub. This drives the real surface, against real PostgreSQL, through the path the shop actually
 * uses: publish a price list, sell against it, resend the sale the way a till does, and read back
 * what was banked.
 *
 * The property it exists to prove is the one everything else rests on: **the answer comes from
 * the history, not from a field somebody kept up to date.** There is no products table, no sales
 * table, no "current pack" column — the current anything is a fold over an append-only stream, so
 * nothing can disagree with the history about what happened.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `r${Date.now().toString(36)}`;

/**
 * A tenant of this run's own.
 *
 * The first version reused one fixed tenant, and the catalogue append **deduped against the
 * previous run's pack** — `catalogue-<tenant>-v1` is the same key every time — so the read
 * returned an older pack with an older signature. That was the store being exactly right and the
 * test being wrong, and it is the same run-scoping every other integration suite here uses,
 * because an append-only database keeps what earlier runs put in it.
 */
const TENANT = `9${Date.now().toString(16).slice(-7)}-9999-4999-8999-${'9'.repeat(12)}`;
const KEY = ['it', 'remembers', 'signing', 'key'].join('-').padEnd(48, '0');
const NOW = '2026-08-07T12:00:00Z';

/**
 * A minute ago, by the real clock.
 *
 * The first version dated the sale 2026-08-07 and the POS service raised
 * `committed_in_the_future` against the machine's actual clock — the check doing exactly its job,
 * on a fixture that was wrong. A sale cannot be committed later than the server has reached.
 */
const COMMITTED = new Date(Date.now() - 60_000).toISOString();

const ACCESS = new AccessControl(
  [{
    id: 'all', name: 'All', permissions: [
      'catalogue.pack.read', 'catalogue.pack.publish',
      'pos.sale.sync', 'pos.sale.read', 'pos.exception.read',
      'inventory.movement.append', 'inventory.availability.read',
    ],
  }],
  [{ userId: 'u-manager', roleId: 'all', branchScope: 'all' }],
);

describe.skipIf(!DATABASE_URL)('the API remembers (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;
  let kernel: Parameters<typeof handle>[0];

  const req = (over: Partial<HttpRequest>): HttpRequest => ({
    method: 'GET', path: '/', headers: { authorization: 'Bearer good' }, ...over,
  });
  const post = (path: string, body: unknown, key: string): HttpRequest =>
    req({ method: 'POST', path, body, headers: { authorization: 'Bearer good', 'idempotency-key': key } });

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(sql);

    const built = buildRouter(buildSurface({
      signingKey: KEY, migrationTargetKind: 'rehearsal', store,
    }));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);

    kernel = {
      router: built.router!,
      authenticate: () => ({ tenantId: TENANT, userId: 'u-manager', branchId: 'b-main' }),
      access: ACCESS, idempotency: new MemoryIdempotencyStore(),
      newTraceId: () => `trace-${RUN}`,
    };
  });

  afterAll(async () => { await client.end(); });

  // ─── 1. A price list, published and read back ───────────────────────────────

  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 1, builtAt: NOW,
    products: [
      { productId: `${RUN}-P1`, sku: 'GHEE-1L', name: 'Amul Ghee Gold 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' },
      { productId: `${RUN}-P2`, sku: 'OIL-5L', name: 'Sunflower Oil 5L', baseUom: 'each', unitPriceMinor: 30_000, taxBps: 500, mrpMinor: 35_000, status: 'active' },
    ],
    barcodes: [{ code: '8901234567890', productId: `${RUN}-P1`, kind: 'standard' }],
  };

  it('publishes a price list and reads back the SAME one', async () => {
    const signer = hmacSigner(KEY);
    const pack = publishPack({
      snapshot, approvals: [], signer, publishedBy: 'u-manager', publishedAt: NOW,
    }).pack!;

    const adapter = catalogueAdapter({ store, signer, now: () => NOW });
    await adapter.storePack(TENANT, pack);

    const back = await adapter.currentPack(TENANT);
    expect(back?.snapshot.version).toBe(1);
    expect(back?.snapshot.products).toHaveLength(2);
    // Round-tripped through PostgreSQL and still verifies against its signature.
    expect(back?.signature).toBe(pack.signature);
  });

  it('serves that pack over the API, to a caller with the permission', async () => {
    const res = await handle(kernel, req({ path: '/v1/catalogue/pack' }));
    expect(res.status).toBe(200);
    expect((res.body as { snapshot: { products: unknown[] } }).snapshot.products).toHaveLength(2);
  });

  // ─── 2. A sale, banked and remembered ───────────────────────────────────────

  const sale = {
    saleId: `${RUN}-S1`, receiptNumber: `${RUN}-R1`, laneId: 'lane-1', cashierId: 'u-meena',
    tradingDay: COMMITTED.slice(0, 10), committedAt: COMMITTED, totalMinor: 64_000, currency: 'INR',
    packVersion: 1,
    lines: [{ productId: `${RUN}-P1`, quantityMinor: 1, uom: 'each', unitPriceMinor: 64_000, lineTotalMinor: 64_000 }],
    tenders: [{ kind: 'cash', amountMinor: 64_000 }],
  };

  it('banks a sale and finds it afterwards', async () => {
    const res = await handle(kernel, post('/v1/sales', sale, `k-${RUN}-1`));
    expect(res.status).toBe(202);
    expect((res.body as { banked: boolean; exceptions: unknown[] }).banked).toBe(true);
    expect((res.body as { exceptions: unknown[] }).exceptions).toEqual([]);

    const found = await handle(kernel, req({ path: `/v1/sales/${sale.saleId}` }));
    expect(found.status).toBe(200);
  });

  it('collapses a RESEND to one sale, the way a till actually behaves', async () => {
    // The till resends what it could not confirm. Three arrivals, one sale — and the collapse
    // happens on the sale's own id, so it holds even if the transport used a different key.
    await handle(kernel, post('/v1/sales', sale, `k-${RUN}-1`));
    await handle(kernel, post('/v1/sales', sale, `k-${RUN}-DIFFERENT`));

    const banked = await posAdapter({ store, now: () => NOW }).bankedSaleIds(TENANT);
    expect([...banked].filter((id) => id === sale.saleId)).toHaveLength(1);

    const stream = await store.readStream(TENANT, STREAM.sales);
    expect(stream.filter((e) => (e.event.payload as { saleId: string }).saleId === sale.saleId)).toHaveLength(1);
  });

  it('prices the sale against the pack the SHOP published, not a stub', async () => {
    // The catalogue the POS service checks against comes from the stream, so a price that
    // disagrees is a real finding rather than an artefact of an empty stub map.
    const wrongPrice = {
      ...sale, saleId: `${RUN}-S2`, receiptNumber: `${RUN}-R2`,
      totalMinor: 50_000,
      lines: [{ productId: `${RUN}-P1`, quantityMinor: 1, uom: 'each', unitPriceMinor: 50_000, lineTotalMinor: 50_000 }],
      tenders: [{ kind: 'cash', amountMinor: 50_000 }],
    };
    const res = await handle(kernel, post('/v1/sales', wrongPrice, `k-${RUN}-2`));
    expect(res.status).toBe(202); // banked regardless — the money is in the drawer

    const kinds = (res.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind);
    expect(kinds).toContain('price_differs_from_catalogue');
  });

  it('remembers the exception too, and serves it', async () => {
    const res = await handle(kernel, req({ path: '/v1/sales/exceptions' }));
    expect(res.status).toBe(200);
    const body = res.body as { material: unknown[]; informational: number };
    expect(body.material.length + body.informational).toBeGreaterThan(0);
  });

  // ─── 3. Stock, projected rather than stored ─────────────────────────────────

  it('projects a stock balance from movements, in any arrival order', async () => {
    const move = (id: string, kind: string, qty: number) => ({
      movementId: `${RUN}-${id}`, productId: `${RUN}-P1`, locationId: 'L1', kind,
      quantityMinor: qty, uom: 'each', occurredAt: COMMITTED, enteredBy: 'u-warehouse',
    });

    // Deliberately out of order — a handheld back from the chiller sends them like this.
    for (const [i, m] of [move('M3', 'sold', 20), move('M1', 'received', 100), move('M2', 'sold', 30)].entries()) {
      const res = await handle(kernel, post('/v1/inventory/movements', m, `k-${RUN}-mv${i}`));
      expect(res.status).toBe(202);
    }

    // The query goes in its own field. Putting it in the path made the router fail to match, and
    // the 404 body has no `rows` — which is how the first version of this failed.
    const res = await handle(kernel, req({
      path: '/v1/inventory/availability', query: { productId: `${RUN}-P1` },
    }));
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: { onHandMinor: number }[] }).rows;
    expect(rows[0]?.onHandMinor).toBe(50);
  });

  it('gives the same balance whichever way the stream is read', async () => {
    const ms = await store.readStream(TENANT, STREAM.inventory);
    const payloads = ms.map((e) => e.event.payload as never);
    const forward = project(payloads, NOW);
    const backward = project([...payloads].reverse(), NOW);
    expect(backward).toEqual(forward);
  });

  // ─── 4. The property everything rests on ────────────────────────────────────

  it('the database itself refuses to change what was banked (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, STREAM.sales))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"x":1}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [first.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  it('holds no table anyone could overwrite a quantity in', async () => {
    // The reason everything is an event. A table with an UPDATE on it is a quantity somebody can
    // overwrite, and no amount of discipline in the application layer survives one hurried fix.
    const rows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = rows.rows.map((r) => r.table_name).sort();
    expect(names).toContain('event_ledger');
    for (const forbidden of ['sales', 'products', 'stock', 'stock_balances', 'inventory']) {
      expect(names, `a mutable ${forbidden} table would undo hard rule #2`).not.toContain(forbidden);
    }
  });

  it('keeps one tenant out of another (OB-01)', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    expect(await store.readStream(other, STREAM.sales)).toEqual([]);
    expect(await catalogueAdapter({
      store, signer: hmacSigner(KEY), now: () => NOW,
    }).currentPack(other)).toBeUndefined();
  });
});
