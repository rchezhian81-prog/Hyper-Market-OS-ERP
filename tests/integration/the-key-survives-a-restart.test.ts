import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **The guard that refuses a different request under a used key must survive a restart.**
 *
 * `MemoryIdempotencyStore` carried the comment "real deployments swap the port for PostgreSQL"
 * and `main()` was using it. The control it backs is the one that stops a sale of 400 being
 * answered with the stored result of a sale of 250 — and held in memory it fails in two ways that
 * no test would show and every deployment would meet: a restart empties it, and two instances
 * behind a load balancer never share it.
 *
 * Neither is a crash. Both are the control quietly not being there, which is the failure mode this
 * repository spends most of its effort making impossible.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `k${Date.now().toString(36)}`;
const TENANT = `7${Date.now().toString(16).slice(-7)}-7777-4777-8777-${'7'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('an idempotency key outlives the process (real PostgreSQL)', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const dir = 'db/migrations';
    await runMigrations(pgClient(client), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });

  afterAll(async () => { await client.end(); });

  const storeFor = () => new SqlIdempotencyStore(pgClient(client));

  it('remembers what it answered, through a completely new store instance', async () => {
    // A new instance is the test's version of a restart — and of a second API behind a load
    // balancer, which is the same problem wearing different clothes.
    await storeFor().put(TENANT, `${RUN}-A`, {
      requestHash: 'hash-of-a-250-rupee-sale', status: 202, body: { saleId: 'S-1' },
    });

    const afterRestart = await storeFor().get(TENANT, `${RUN}-A`);
    expect(afterRestart?.status).toBe(202);
    expect(afterRestart?.requestHash).toBe('hash-of-a-250-rupee-sale');
    expect(afterRestart?.body).toEqual({ saleId: 'S-1' });
  });

  it('keeps the FIRST answer when a second arrives under the same key', async () => {
    // Never an upsert. Two requests racing under one key would otherwise leave the second's result
    // stored against the first's hash, and every later retry would be told about a request that
    // never happened.
    await storeFor().put(TENANT, `${RUN}-B`, { requestHash: 'first', status: 202, body: { n: 1 } });
    await storeFor().put(TENANT, `${RUN}-B`, { requestHash: 'second', status: 500, body: { n: 2 } });

    const held = await storeFor().get(TENANT, `${RUN}-B`);
    expect(held?.requestHash).toBe('first');
    expect(held?.status).toBe(202);
  });

  it('keeps one tenant\'s keys away from another\'s (OB-01)', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    await storeFor().put(TENANT, `${RUN}-C`, { requestHash: 'ours', status: 201, body: {} });
    expect(await storeFor().get(other, `${RUN}-C`)).toBeUndefined();
  });

  it('answers not-found for a key nobody has used, rather than throwing', async () => {
    expect(await storeFor().get(TENANT, `${RUN}-never-seen`)).toBeUndefined();
  });

  it('stores a null body without turning it into a missing row', async () => {
    // A 204 has no body. Losing the row would make the guard forget the key entirely.
    await storeFor().put(TENANT, `${RUN}-D`, { requestHash: 'empty', status: 204, body: undefined });
    const held = await storeFor().get(TENANT, `${RUN}-D`);
    expect(held).toBeDefined();
    expect(held?.status).toBe(204);
  });

  it('tripwire — the in-memory store forgets, which is why this one exists', async () => {
    // Without this the tests above prove only that a database persists things.
    const first = new MemoryIdempotencyStore();
    first.put(TENANT, `${RUN}-E`, { requestHash: 'x', status: 202, body: {} });
    expect(first.get(TENANT, `${RUN}-E`)).toBeDefined();

    // The restart.
    expect(new MemoryIdempotencyStore().get(TENANT, `${RUN}-E`)).toBeUndefined();
  });
});
