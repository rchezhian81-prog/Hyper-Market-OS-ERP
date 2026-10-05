import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, ConcurrencyConflictError } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import type { DomainEvent } from '../../packages/contracts/src/event';

/**
 * **Two distinct requests cannot spend the same balance twice — on real PostgreSQL (Wave 2a · audit PF-01, SF-04,
 * FUL-02, PA-11 · M13-FR-01 · M13-FR-03 · M17-FR-01 · M08-FR-02 · M18-FR-02 · hard rule #10).**
 *
 * The audit reproduced the double-spend on the in-memory store and asked for the proof on the database. This is
 * it: two guarded batches with the same key and the same expected version are fired at the same moment through
 * the transactional pool client (`pgPoolClient`, the wiring main.ts uses). The `UPDATE … WHERE version = $expected`
 * takes the guard row's lock; the loser re-evaluates after the winner commits, updates nothing, and its WHOLE
 * batch — already inserted in its transaction — rolls back. One succeeds; the other is a named conflict; the
 * ledger holds exactly the winner's events. Set DATABASE_URL to run; without it the suite skips, never passes quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `guard-${Date.now().toString(36)}`;
const TENANT = `9${Date.now().toString(16).slice(-7)}-9999-4999-8999-${'9'.repeat(12)}`;
const AT = new Date(Date.now() - 60_000).toISOString();

function ev(id: string): DomainEvent {
  return makeEvent({ id: `${RUN}-${id}`, type: 'RefundRecorded', occurredAt: AT, idempotencyKey: `${RUN}-${id}`, source: 'api/returns', payload: { id } });
}

const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('write guards on real PostgreSQL (Wave 2a)', () => {
  let pool: Pool;
  let store: SqlEventStore;
  const stream = `${RUN}/returns`;
  const key = `${RUN}:refund:S1`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    store = new SqlEventStore(pgPoolClient(pool));
    await store.registerTenant(TENANT, 'tests');
  });

  afterAll(async () => { await pool.end(); });

  it('a key nobody wrote under reads as 0; a guarded append at 0 lands and the version becomes 1', async () => {
    expect(await store.guardVersion(TENANT, key)).toBe(0);
    const out = await store.appendBatch(TENANT, [{ stream, event: ev('first') }], { guard: { key, expectedVersion: 0 } });
    expect(out[0]!.deduped).toBe(false);
    expect(await store.guardVersion(TENANT, key)).toBe(1);
  });

  it('two competitors at the same moment: ONE lands, the other is refused by name and its whole batch is rolled back', async () => {
    const v = await store.guardVersion(TENANT, key);
    const a = store.appendBatch(TENANT, [{ stream, event: ev('race-a') }, { stream: `${stream}/report`, event: ev('race-a-report') }], { guard: { key, expectedVersion: v } });
    const b = store.appendBatch(TENANT, [{ stream, event: ev('race-b') }, { stream: `${stream}/report`, event: ev('race-b-report') }], { guard: { key, expectedVersion: v } });
    const settled = await Promise.allSettled([a, b]);
    const won = settled.filter((s) => s.status === 'fulfilled');
    const lost = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ConcurrencyConflictError);
    expect((lost[0]!.reason as ConcurrencyConflictError).key).toBe(key);
    // exactly the winner's two events are on the ledger; nothing of the loser's batch survived its rollback
    const ids = (await store.readStream(TENANT, stream)).map((r) => r.event.id);
    const reports = (await store.readStream(TENANT, `${stream}/report`)).map((r) => r.event.id);
    const winner = ids.includes(`${RUN}-race-a`) ? 'a' : 'b';
    expect(ids).toEqual([`${RUN}-first`, `${RUN}-race-${winner}`]);
    expect(reports).toEqual([`${RUN}-race-${winner}-report`]);
    expect(await store.guardVersion(TENANT, key)).toBe(v + 1);
  });

  it('the loser re-reads the version and lands; a sequence of correctly-versioned writes all land', async () => {
    const v = await store.guardVersion(TENANT, key);
    await store.appendBatch(TENANT, [{ stream, event: ev('after-1') }], { guard: { key, expectedVersion: v } });
    await store.appendBatch(TENANT, [{ stream, event: ev('after-2') }], { guard: { key, expectedVersion: v + 1 } });
    expect(await store.guardVersion(TENANT, key)).toBe(v + 2);
  });

  it('a stale version is refused even with no competitor — the guard protects the decision, not just the race', async () => {
    await expect(store.appendBatch(TENANT, [{ stream, event: ev('stale') }], { guard: { key, expectedVersion: 0 } })).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(await store.findByIdempotencyKey(TENANT, `${RUN}-stale`)).toBeUndefined();
  });

  it('a whole-batch replay with the version it first read still dedups — a retried command never becomes a conflict', async () => {
    const v = await store.guardVersion(TENANT, key);
    const entries = [{ stream, event: ev('replayed') }];
    await store.appendBatch(TENANT, entries, { guard: { key, expectedVersion: v } });
    const replay = await store.appendBatch(TENANT, entries, { guard: { key, expectedVersion: v } });
    expect(replay[0]!.deduped).toBe(true);
    expect(await store.guardVersion(TENANT, key)).toBe(v + 1);
  });

  it('keys are independent, and a guard is per tenant', async () => {
    const other = `${RUN}:refund:S2`;
    expect(await store.guardVersion(TENANT, other)).toBe(0);
    await store.appendBatch(TENANT, [{ stream, event: ev('other') }], { guard: { key: other, expectedVersion: 0 } });
    expect(await store.guardVersion(TENANT, other)).toBe(1);
    const OTHER_TENANT = `9${(Date.now() + 1).toString(16).slice(-7)}-9999-4999-8999-${'7'.repeat(12)}`;
    await store.registerTenant(OTHER_TENANT, 'tests');
    expect(await store.guardVersion(OTHER_TENANT, key)).toBe(0);
  });
});
