import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import type { DomainEvent } from '../../packages/contracts/src/event';

/**
 * **Appends are atomic.** (audit FND-01 / GAP-DATA-01, hard rule #2)
 *
 * A money-critical command writes more than one event — a banked sale plus its receipt-number index,
 * a return plus its reporting projection. Before FND-01 those were two separate appends, so a crash
 * between them left a partial set: a sale with no receipt, or a report missing a return. `appendBatch`
 * runs the whole set inside ONE real PostgreSQL transaction, through `pgPoolClient`, so it commits
 * entirely or not at all.
 *
 * This drives the real transaction against real PostgreSQL (not a fake): a good batch commits both
 * events; a batch whose second event violates a constraint mid-flight rolls the FIRST one back too,
 * leaving the ledger exactly as it was. `pgClient` (query-only) is not used here — atomicity is the
 * property under test, and only `pgPoolClient` can pin the connection a transaction needs.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `atomic-${Date.now().toString(36)}`;
const TENANT = `8${Date.now().toString(16).slice(-7)}-8888-4888-8888-${'8'.repeat(12)}`;
const AT = new Date(Date.now() - 60_000).toISOString();

function ev(id: string, key: string): DomainEvent {
  return makeEvent({
    id: `${RUN}-${id}`,
    type: 'SaleCommitted',
    occurredAt: AT,
    idempotencyKey: `${RUN}-${key}`,
    source: 'api/pos',
    payload: { note: id },
  });
}

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('appendBatch is atomic against real PostgreSQL (FND-01)', () => {
  let pool: Pool;
  let store: SqlEventStore;
  const stream = `${RUN}/sales`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    // The store gets the TRANSACTIONAL adapter — the same wiring production uses in main.ts.
    store = new SqlEventStore(pgPoolClient(pool));
  });

  afterAll(async () => { await pool.end(); });

  it('commits every event of a batch, in order, and dedups a whole-batch replay', async () => {
    const entries = [
      { stream, event: ev('sale', 'sale-key') },
      { stream, event: ev('receipt', 'receipt-key') },
    ];
    const first = await store.appendBatch(TENANT, entries);
    expect(first.map((r) => r.deduped)).toEqual([false, false]);

    // Both are durable and read back in append order.
    const banked = await store.readStream(TENANT, stream);
    expect(banked.map((r) => r.event.id)).toEqual([`${RUN}-sale`, `${RUN}-receipt`]);

    // A resend of the same command collapses entirely — the money leaves once (hard rule #2's cousin).
    const replay = await store.appendBatch(TENANT, entries);
    expect(replay.map((r) => r.deduped)).toEqual([true, true]);
    expect(await store.readStream(TENANT, stream)).toHaveLength(2);
  });

  it('rolls the WHOLE batch back when the second event fails mid-flight — no partial set', async () => {
    // Two entries sharing one event id: the first inserts, the second violates event_ledger_id_uq
    // (UNIQUE(id)) — a real Postgres error the `ON CONFLICT (tenant_id, idempotency_key)` clause does
    // NOT swallow, because the keys differ. Without a transaction the first would survive; with one,
    // it is rolled back.
    const clashStream = `${RUN}/clash`;
    const good = makeEvent({
      id: `${RUN}-clash`, type: 'SaleCommitted', occurredAt: AT,
      idempotencyKey: `${RUN}-clash-a`, source: 'api/pos', payload: {},
    });
    const collides = makeEvent({
      id: `${RUN}-clash`, type: 'SaleCommitted', occurredAt: AT, // same id, different key → UNIQUE(id) violation
      idempotencyKey: `${RUN}-clash-b`, source: 'api/pos', payload: {},
    });

    await expect(store.appendBatch(TENANT, [
      { stream: clashStream, event: good },
      { stream: clashStream, event: collides },
    ])).rejects.toThrow();

    // The first event was rolled back with the failing second — the stream is empty and neither
    // idempotency key resolves. A crash mid-command leaves NOTHING behind.
    expect(await store.readStream(TENANT, clashStream)).toHaveLength(0);
    expect(await store.findByIdempotencyKey(TENANT, `${RUN}-clash-a`)).toBeUndefined();
    expect(await store.findByIdempotencyKey(TENANT, `${RUN}-clash-b`)).toBeUndefined();
  });
});
