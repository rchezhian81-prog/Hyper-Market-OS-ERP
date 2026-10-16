import { describe, it, expect } from 'vitest';
import { pgDedicatedSession, DedicatedSessionTimeoutError, type PgStandaloneClient } from '../../packages/persistence/src/pg-client';
import { SqlSnapshotStore, type BuildLeaseHeld } from '../../packages/persistence/src/snapshot';
import { pgPoolClient, type PgPool } from '../../packages/persistence/src/pg-client';
import { LEASE_QUERY_TIMEOUT_MS, LEASE_KEEPALIVE_DELAY_MS } from '../../services/api/src/main';

/**
 * **Round 36 · M35-FR-03 · OB-106 · verifier r35 NEW-6 — a build lease on a connection that stops answering (a half-open TCP
 * connection: the network dropped with no reset) is let go in bounded time, said by name, never left hanging until a restart.**
 *
 *   • every query on a session of its own — the try-lock, the unlock — and its close are bounded (`queryTimeoutMs`); past the
 *     bound the connection's socket is DESTROYED, the session counts as ended (`ended()`, so the lease reads as lost), and the
 *     query fails with `DedicatedSessionTimeoutError`;
 *   • the build lease whose unlock never answers: the release returns within the bound, the failure is said by name
 *     (`BuildLeaseUnlockError`, with the timeout), the lease count goes back to 0 (the next build may take it);
 *   • a try-lock that never answers: the lease is refused with the named error (the build says it failed), the count is 0;
 *   • production composes it with TCP keepalive and a 30-second bound (main.ts).
 */

function silentClient(silent: { query?: (text: string) => boolean; end?: boolean } = {}): PgStandaloneClient & { destroyed: number; ended: number; texts: string[] } {
  const c = {
    destroyed: 0, ended: 0, texts: [] as string[],
    connect: async () => undefined,
    end: () => { c.ended += 1; return silent.end === true ? new Promise<void>(() => undefined) : Promise.resolve(); },
    query: (text: string) => {
      c.texts.push(text);
      if (silent.query?.(text) === true) return new Promise<never>(() => undefined); // never answers
      if (text.includes('pg_try_advisory_lock')) return Promise.resolve({ rows: [{ got: true }] });
      if (text.includes('pg_advisory_unlock')) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({ rows: [] });
    },
    on: () => c,
    connection: { stream: { destroy: () => { c.destroyed += 1; } } },
  };
  return c;
}
const noPool: PgPool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('the request pool is never used for a lease'); } };

describe('round 36 · NEW-6: a session of its own is bounded', () => {
  it('M35-FR-03 OB-106 NEW-6: a query that never answers fails by name in bounded time; the socket is destroyed; the session reads as ended', async () => {
    const c = silentClient({ query: (t) => t.includes('pg_sleep') });
    const started = Date.now();
    let endedSeen: unknown;
    await expect(pgDedicatedSession(() => c, { queryTimeoutMs: 100 })(async (conn, ended) => {
      try { await conn.query('SELECT pg_sleep(3600)'); } finally { endedSeen = ended(); }
    })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(c.destroyed).toBeGreaterThanOrEqual(1);
    expect(endedSeen).toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(c.ended).toBe(1);
  });
  it('M35-FR-03 OB-106 NEW-6: a close that never answers is bounded too (the socket is destroyed)', async () => {
    const c = silentClient({ end: true });
    const started = Date.now();
    await pgDedicatedSession(() => c, { queryTimeoutMs: 100 })(async (conn) => { await conn.query('SELECT 1'); });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(c.destroyed).toBe(1);
  });
  it('M35-FR-03 OB-106 NEW-6: production bounds a lease query at 30 seconds, with TCP keepalive', () => {
    expect(LEASE_QUERY_TIMEOUT_MS).toBe(30_000);
    expect(LEASE_KEEPALIVE_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('round 36 · NEW-6: a build lease on a silent connection is let go in bounded time', () => {
  it('M35-FR-03 OB-106 NEW-6: the unlock never answers — the release returns, the failure is said by name, the count is 0', async () => {
    const c = silentClient({ query: (t) => t.includes('pg_advisory_unlock') });
    const said: string[] = [];
    const store = new SqlSnapshotStore(pgPoolClient(noPool), { leaseSession: pgDedicatedSession(() => c, { queryTimeoutMs: 100 }), onLeaseProblem: (d) => { said.push(d); } });
    const lease = await store.buildLease('t-1', 'box-health-history@1') as BuildLeaseHeld;
    expect(typeof lease).toBe('function');
    expect(store.buildLeasesHeld).toBe(1);
    const started = Date.now();
    await lease(); // before round 36: never returned (the build's finally hung, the shop stayed "being prepared")
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(store.buildLeasesHeld).toBe(0);
    expect(lease.lost()).toBe(true);
    expect(c.destroyed).toBeGreaterThanOrEqual(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/projection build lease t-1:box-health-history@1: letting go failed .*DedicatedSessionTimeoutError|took more than 100 ms/);
    expect(said[0]).toMatch(/BuildLeaseUnlockError/);
    // The next build may take a lease at once.
    const next = await new SqlSnapshotStore(pgPoolClient(noPool), { leaseSession: pgDedicatedSession(() => silentClient(), { queryTimeoutMs: 100 }) }).buildLease('t-1', 'p') as BuildLeaseHeld;
    await next();
  });
  it('M35-FR-03 OB-106 NEW-6: the try-lock never answers — the lease is refused with the named error, the count is 0', async () => {
    const c = silentClient({ query: (t) => t.includes('pg_try_advisory_lock') });
    const store = new SqlSnapshotStore(pgPoolClient(noPool), { leaseSession: pgDedicatedSession(() => c, { queryTimeoutMs: 100 }) });
    await expect(store.buildLease('t-1', 'p')).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(store.buildLeasesHeld).toBe(0);
    expect(c.destroyed).toBeGreaterThanOrEqual(1);
  });
});
