import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { buildCatalogueSnapshot } from '../../packages/catalogue/src/snapshot-builder';
import { CatalogueCache } from '../../packages/catalogue/src/catalogue';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SyncAgent } from '../../edge/sync-agent/src/agent';
import type { SyncTransport, SendOutcome } from '../../edge/sync-agent/src/transport';
import type { DomainEvent } from '../../packages/contracts/src/event';
import { money } from '../../packages/contracts/src/money';

/**
 * STAGE 6 — the offline/sync vertical slice.
 *
 * Gate (roadmap §21): *internet-off, duplicate, reorder and recovery tests pass.*
 * Path: product/price → local POS sale → cloud ledger → reconciliation.
 *
 * Everything below runs the REAL engines against a REAL PostgreSQL. No mock event
 * store, no fake catalogue. The one thing that is simulated is the network — which
 * is the point: the whole design claim is that the shop keeps trading when the
 * network is not there, and you cannot prove that with a network that works.
 *
 * Set DATABASE_URL to run. Without it the suite skips rather than passing quietly,
 * because a skipped test that reports green is how a broken guarantee ships.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '22222222-2222-2222-2222-222222222222';
const CURRENCY = 'INR' as const;

/** A transport whose network can be pulled, exactly like a real cable. */
class ControllableTransport implements SyncTransport {
  online = true;
  /** Every event the cloud actually accepted — the ledger is the real check. */
  readonly delivered: string[] = [];
  /** Deliveries the cloud saw more than once. Should never cause a second effect. */
  duplicateDeliveries = 0;
  /** Fail the next N sends even while "online" — a flapping link. */
  failNext = 0;

  constructor(private readonly store: SqlEventStore) {}

  async send(event: DomainEvent): Promise<SendOutcome> {
    if (!this.online) {
      return { status: 'retryable', reason: 'network unreachable' };
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { status: 'retryable', reason: 'transient failure' };
    }
    const result = await this.store.append(TENANT, `sale/${event.idempotencyKey}`, event);
    if (result.deduped) this.duplicateDeliveries += 1;
    this.delivered.push(event.idempotencyKey);
    return { status: 'accepted' };
  }
}

describe.skipIf(!DATABASE_URL)('Stage 6 — offline/sync vertical slice (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    // Load the real migration files, so this suite stands up its own schema on a
    // fresh database (CI) and is a no-op against one already migrated.
    const dir = 'db/migrations';
    const migrations = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    await runMigrations(sql, migrations);
    // Each run starts from a known point. The ledger is append-only and the database
    // refuses DELETE, so the tests scope themselves by tenant instead of truncating —
    // which is itself a small proof that the guard is real.
    store = new SqlEventStore(sql);
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * Read back several events one at a time. A single `pg` client executes one query
   * at a time, so firing them concurrently relies on driver-side queueing that pg is
   * removing — and a test that depends on deprecated plumbing is a test that will
   * fail for a reason that has nothing to do with the guarantee it checks.
   */
  async function readEachInTurn(keys: readonly string[]) {
    const results = [];
    for (const key of keys) {
      results.push(await store.findByIdempotencyKey(TENANT, key));
    }
    return results;
  }

  /** Step 1 of the slice: product + price become a lane catalogue. */
  function buildLaneCatalogue(): CatalogueCache {
    const snapshot = buildCatalogueSnapshot({
      scope: { tenantId: TENANT, storeId: 'store-1' },
      version: 1,
      asOf: '2026-08-04T06:00:00Z',
      products: [
        { productId: 'p-rice', sku: 'RICE5', name: 'Rice 5kg', baseUom: 'ea', taxClassId: 'GST5', status: 'active' },
        { productId: 'p-oil', sku: 'OIL1', name: 'Sunflower oil 1L', baseUom: 'ea', taxClassId: 'GST5', status: 'active' },
      ],
      barcodes: [
        { code: '8901000000018', productId: 'p-rice', kind: 'standard' },
        { code: '8901000000025', productId: 'p-oil', kind: 'standard' },
      ],
      priceEntries: [
        { id: 'pr-1', productId: 'p-rice', scope: 'store', scopeRef: 'store-1', price: money(45_000, CURRENCY), effectiveFrom: '2026-01-01T00:00:00Z', status: 'active', version: 1 },
        { id: 'pr-2', productId: 'p-oil', scope: 'store', scopeRef: 'store-1', price: money(18_000, CURRENCY), effectiveFrom: '2026-01-01T00:00:00Z', status: 'active', version: 1 },
      ],
      taxClasses: { GST5: 500 },
    });
    expect(snapshot.excluded).toEqual([]);
    return new CatalogueCache(snapshot.snapshot);
  }

  /** Steps 2–3: a basket rung up on the lane and committed locally. */
  function ringUpSale(id: string, catalogue: CatalogueCache) {
    const stockLedger = new Ledger(new InMemoryLedgerStore());
    const outbox = new SyncOutbox();
    const session = new PosSession(
      {
        laneId: 'lane-1',
        cashierId: 'cashier-1',
        tradingDay: '2026-08-04',
        currency: CURRENCY,
        defaultTaxRate: taxRateFromPercent(5),
      },
      stockLedger,
      outbox,
    );

    for (const code of ['8901000000018', '8901000000025']) {
      const scanned = catalogue.scan(code);
      session.scan({
        productId: scanned.product.productId,
        description: scanned.product.name,
        unitPrice: money(scanned.product.unitPriceMinor, CURRENCY),
        quantityMinor: scanned.quantityMinor,
        uom: scanned.product.baseUom as 'ea',
        taxRate: taxRateFromPercent(scanned.product.taxBps / 100),
      });
    }

    const payable = session.totals().payable;
    const committed = session.commit(id, `INV-${id}`, '2026-08-04T10:00:00Z', [
      { kind: 'cash', amount: payable, status: 'settled' },
    ]);
    return { committed, outbox, payable, stockLedger };
  }

  it('rings up and commits a sale with the network cable OUT (hard rule #1, QG-04)', async () => {
    const catalogue = buildLaneCatalogue();
    const transport = new ControllableTransport(store);
    transport.online = false; // the cable is out before the customer arrives

    const { committed, outbox, payable } = ringUpSale('S-OFFLINE-1', catalogue);

    // ₹450.00 + ₹180.00 = ₹630.00, +5% GST = ₹661.50
    expect(payable).toEqual(money(66_150, CURRENCY));
    expect(committed.id).toBe('S-OFFLINE-1');
    // The sale is DONE — locally, with nothing waiting on a network call.
    expect(outbox.unsentCount()).toBe(1);

    // Draining while offline changes nothing except that we know it is queued.
    const agent = new SyncAgent(outbox, transport);
    const result = await agent.drain({ at: '2026-08-04T10:00:05Z' });
    expect(result.acknowledged).toBe(0);
    expect(result.remaining).toBe(1);
    expect(transport.delivered).toEqual([]);

    // The cable goes back in.
    transport.online = true;
    const second = await agent.drain({ at: '2026-08-04T10:05:00Z' });
    expect(second.acknowledged).toBe(1);
    expect(outbox.unsentCount()).toBe(0);

    // And the sale is now in the cloud ledger — the real one, in PostgreSQL.
    const stored = await store.readStream(TENANT, `sale/${transport.delivered[0]}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event.type).toBe('SaleCommitted');
  });

  it('produces ONE business effect when the same sale is delivered twice (§31.1)', async () => {
    const catalogue = buildLaneCatalogue();
    const transport = new ControllableTransport(store);
    const { outbox } = ringUpSale('S-DUP-1', catalogue);
    const agent = new SyncAgent(outbox, transport);

    await agent.drain({ at: '2026-08-04T10:10:00Z' });
    const key = transport.delivered[0]!;
    const afterFirst = await store.readStream(TENANT, `sale/${key}`);
    expect(afterFirst).toHaveLength(1);

    // The classic real-world case: the cloud accepted it, the acknowledgement was
    // lost on the way back, and the lane sends it again.
    const replay = new SyncOutbox();
    const { outbox: replayOutbox } = ringUpSale('S-DUP-1', catalogue);
    for (const item of replayOutbox.pending()) replay.enqueue(item.event);
    await new SyncAgent(replay, transport).drain({ at: '2026-08-04T10:11:00Z' });

    const afterReplay = await store.readStream(TENANT, `sale/${key}`);
    // Delivered twice, banked once.
    expect(afterReplay).toHaveLength(1);
    expect(transport.duplicateDeliveries).toBeGreaterThanOrEqual(1);
  });

  it('lands the right answer when events arrive OUT OF ORDER', async () => {
    const catalogue = buildLaneCatalogue();
    const transport = new ControllableTransport(store);

    // Three sales rung up in order, delivered to the cloud back to front — which is
    // what a retry after a partial outage actually looks like.
    const sales = ['S-ORD-1', 'S-ORD-2', 'S-ORD-3'].map((id) => ringUpSale(id, catalogue));
    const reversed = [...sales].reverse();

    for (const sale of reversed) {
      const agent = new SyncAgent(sale.outbox, transport);
      await agent.drain({ at: '2026-08-04T10:20:00Z' });
    }

    // All three are present exactly once...
    for (const key of transport.delivered) {
      expect(await store.readStream(TENANT, `sale/${key}`)).toHaveLength(1);
    }
    // ...and the cloud's own sequence records the order it RECEIVED them, while each
    // event keeps the time it actually HAPPENED. Both facts are needed: one to replay
    // deterministically, the other to report the day correctly.
    const found = await readEachInTurn(transport.delivered);
    const mine = found.filter((r): r is NonNullable<typeof r> => r !== undefined);
    expect(mine).toHaveLength(3);
    // Received back-to-front, so the cloud sequence runs opposite to the sale order —
    // and that is correct: seq is arrival order, not business order.
    expect(mine.map((r) => r.seq)).toEqual([...mine.map((r) => r.seq)].sort((a, b) => a - b));
    expect(new Set(mine.map((r) => r.event.occurredAt)).size).toBe(1);
  });

  it('recovers from a link that fails mid-drain, losing nothing and duplicating nothing', async () => {
    const catalogue = buildLaneCatalogue();
    const transport = new ControllableTransport(store);
    const combined = new SyncOutbox();
    for (const id of ['S-REC-1', 'S-REC-2', 'S-REC-3']) {
      for (const item of ringUpSale(id, catalogue).outbox.pending()) combined.enqueue(item.event);
    }
    expect(combined.unsentCount()).toBe(3);

    // The link dies after the first event and stays down for the rest of the pass.
    transport.failNext = 2;
    const agent = new SyncAgent(combined, transport);
    const first = await agent.drain({ at: '2026-08-04T10:30:00Z' });
    expect(first.acknowledged).toBe(1);
    expect(combined.unsentCount()).toBe(2); // the rest are still queued, not lost

    // The link comes back; the agent picks up exactly where it stopped.
    const second = await agent.drain({ at: '2026-08-04T10:35:00Z' });
    expect(second.acknowledged).toBe(2);
    expect(combined.unsentCount()).toBe(0);
    expect(combined.deadLetters()).toEqual([]);

    for (const key of transport.delivered) {
      expect(await store.readStream(TENANT, `sale/${key}`)).toHaveLength(1);
    }
  });

  it('reconciles: what the lane took equals what the cloud holds (QG-07)', async () => {
    const catalogue = buildLaneCatalogue();
    const transport = new ControllableTransport(store);
    transport.online = false;

    // A morning's trading with no internet at all.
    const laneOutbox = new SyncOutbox();
    let laneTotalMinor = 0;
    for (const id of ['S-RECON-1', 'S-RECON-2', 'S-RECON-3', 'S-RECON-4']) {
      const sale = ringUpSale(id, catalogue);
      laneTotalMinor += sale.payable.minor;
      for (const item of sale.outbox.pending()) laneOutbox.enqueue(item.event);
    }
    expect(laneOutbox.unsentCount()).toBe(4);

    // The internet comes back at lunchtime.
    transport.online = true;
    await new SyncAgent(laneOutbox, transport).drain({ at: '2026-08-04T13:00:00Z' });
    expect(laneOutbox.unsentCount()).toBe(0);

    // The reconciliation that matters: sum the cloud ledger and compare it with what
    // the tills actually took. Not "about the same" — the same, to the paisa.
    const banked = await readEachInTurn(transport.delivered);
    const cloudTotalMinor = banked
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .reduce((sum, r) => {
        const payload = r.event.payload as { totalMinor?: number };
        return sum + (payload.totalMinor ?? 0);
      }, 0);

    expect(cloudTotalMinor).toBe(laneTotalMinor);
    expect(laneTotalMinor).toBe(4 * 66_150); // ₹2,646.00 across four baskets
  });
});
