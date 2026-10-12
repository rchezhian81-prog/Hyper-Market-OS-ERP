import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import {
  SqlEventStore, InMemoryEventStore, EventIdClashError, type EventStore,
} from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import type { DomainEvent } from '../../packages/contracts/src/event';

/**
 * **Identical concurrent appends collapse — they never become a 500.** (hard rule #10, P-08, §31.1)
 *
 * A store computer that re-sends a record whose reply it lost, or two amendment re-sends racing each other, present
 * the SAME event twice at once: the same fixed event id and the same idempotency key. That is one event. Before
 * this fix the PostgreSQL store named only the idempotency key as its conflict target, so the two inserts could race
 * past the key's pre-check and the loser hit the event id's unique constraint as a raw error — a 500 where the
 * caller was owed "already recorded". Now every unique constraint is an arbiter: exactly one row lands, every caller
 * gets success (one `deduped: false`, the rest `deduped: true`, all returning the one stored row), and the ledger is
 * never overwritten.
 *
 * The same id under a DIFFERENT key is a genuine clash, and stays an error — refused by name (`EventIdClashError`),
 * never silently kept, and never mistaken for a dedup. Both stores (memory and PostgreSQL) behave alike.
 *
 * The PG leg needs DATABASE_URL; without it that leg skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `collapse-${Date.now().toString(36)}`;
const AT = new Date(Date.now() - 60_000).toISOString();
const PARALLEL = 24;

function ev(id: string, key: string, note = id): DomainEvent {
  return makeEvent({
    id: `${RUN}-${id}`, type: 'PaymentNoAnswerRecorded', occurredAt: AT,
    idempotencyKey: `${RUN}-${key}`, source: 'edge/store-1', payload: { note },
  });
}

function contract(label: string, tenant: string, makeStore: () => EventStore) {
  it(`${label}: ${PARALLEL} parallel identical appends land ONE row and every caller succeeds`, async () => {
    const store = makeStore();
    const stream = `${RUN}/${label}/same`;
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => store.append(tenant, stream, ev(`${label}-same`, `${label}-same-key`))),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const ok = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<EventStore['append']>>>).value);
    expect(ok.filter((r) => !r.deduped)).toHaveLength(1);
    expect(ok.filter((r) => r.deduped)).toHaveLength(PARALLEL - 1);
    // Every caller holds the one stored row.
    expect(new Set(ok.map((r) => r.record.seq)).size).toBe(1);
    const rows = await store.readStream(tenant, stream);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.id).toBe(`${RUN}-${label}-same`);
  });

  it(`${label}: parallel identical BATCHES collapse too, all-or-nothing`, async () => {
    const store = makeStore();
    const stream = `${RUN}/${label}/batch`;
    const batch = [
      { stream, event: ev(`${label}-b1`, `${label}-b1-key`) },
      { stream, event: ev(`${label}-b2`, `${label}-b2-key`) },
    ];
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.appendBatch(tenant, batch)));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(await store.readStream(tenant, stream)).toHaveLength(2);
  });

  it(`${label}: a replay after the race is a dedup returning the stored row unchanged`, async () => {
    const store = makeStore();
    const stream = `${RUN}/${label}/replay`;
    const first = await store.append(tenant, stream, ev(`${label}-r`, `${label}-r-key`, 'original'));
    const again = await store.append(tenant, stream, ev(`${label}-r`, `${label}-r-key`, 'a different body'));
    expect(again.deduped).toBe(true);
    expect(again.record.seq).toBe(first.record.seq);
    expect(again.record.event.payload).toEqual({ note: 'original' }); // never overwritten (hard rule #2)
  });

  it(`${label}: the same id under ANOTHER key is a named clash — never a dedup, never kept`, async () => {
    const store = makeStore();
    const stream = `${RUN}/${label}/clash`;
    await store.append(tenant, stream, ev(`${label}-c`, `${label}-c-key-a`));
    const clash = store.append(tenant, stream, ev(`${label}-c`, `${label}-c-key-b`));
    await expect(clash).rejects.toBeInstanceOf(EventIdClashError);
    await expect(clash).rejects.toThrow(/already recorded under another key/);
    expect(await store.findByIdempotencyKey(tenant, `${RUN}-${label}-c-key-b`)).toBeUndefined();
    expect(await store.readStream(tenant, stream)).toHaveLength(1);
  });

  it(`${label}: concurrent same-id/different-key appends — exactly one lands, the other is refused by name`, async () => {
    const store = makeStore();
    const stream = `${RUN}/${label}/race-clash`;
    const results = await Promise.allSettled([
      store.append(tenant, stream, ev(`${label}-rc`, `${label}-rc-key-a`)),
      store.append(tenant, stream, ev(`${label}-rc`, `${label}-rc-key-b`)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(EventIdClashError);
    expect(await store.readStream(tenant, stream)).toHaveLength(1);
  });
}

describe('identical concurrent appends collapse — memory store', () => {
  const mem = new InMemoryEventStore();
  contract('memory', 'tenant-mem', () => mem);
});

const describePg = DATABASE_URL ? describe : describe.skip;

describePg('identical concurrent appends collapse — PostgreSQL store (real pool, real concurrency)', () => {
  const TENANT = `9${Date.now().toString(16).slice(-7)}-9999-4999-8999-${'9'.repeat(12)}`;
  let pool: Pool;
  let store: SqlEventStore;

  beforeAll(async () => {
    // A pool wide enough that the parallel appends genuinely run on separate connections at once.
    pool = new Pool({ connectionString: DATABASE_URL, max: PARALLEL, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(pgPoolClient(pool));
    await store.registerTenant(TENANT, 'tests');
  });

  afterAll(async () => { await pool.end(); });

  contract('pg', TENANT, () => store);

  it('pg: repeated rounds of the race never surface the raw unique violation', async () => {
    // The race is timing-dependent; many rounds make a regression all but certain to show.
    for (let round = 0; round < 15; round += 1) {
      const stream = `${RUN}/pg/rounds/${round}`;
      const results = await Promise.allSettled(
        Array.from({ length: PARALLEL }, () => store.append(TENANT, stream, ev(`round-${round}`, `round-${round}-key`))),
      );
      const errors = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
      expect(errors).toEqual([]);
      expect(await store.readStream(TENANT, stream)).toHaveLength(1);
    }
  });
});
