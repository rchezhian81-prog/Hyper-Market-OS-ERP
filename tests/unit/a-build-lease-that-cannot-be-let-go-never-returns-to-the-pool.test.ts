import { describe, it, expect } from 'vitest';
import { pgPoolClient, pgDedicatedSession, type PgPool, type PgPoolClient, type PgStandaloneClient } from '../../packages/persistence/src/pg-client';
import { SqlSnapshotStore, BUILD_LEASES_BUSY_HERE, type BuildLeaseHeld } from '../../packages/persistence/src/snapshot';

/**
 * **Round 35 · M35-FR-03 · verifier r34 NEW-3 / NEW-2 (OB-124 (5)) — a build lease's database session is never handed back
 * to a pool, and a failure to let go is said by name, never swallowed.**
 *
 *   • the unlock fails (a cancel, a statement error): the connection is DISCARDED (released with `true`, so the server ends the
 *     session and the lock with it) — never handed back still holding the lock; the failure is said, naming the lease and
 *     `BuildLeaseUnlockError`; the unlock answers "not held": the same;
 *   • even a clean unlock discards the pooled connection (a session's state never goes back to the pool);
 *   • at most `maxConcurrentLeases` (1 on the pool) at once — the next is told "busy here", never made to wait;
 *   • a session of its own (`pgDedicatedSession`) is ended after the lease, whatever happens, and says when the server ended it.
 */

interface FakeConn extends PgPoolClient { released: unknown[]; queries: string[] }
function fakePool(unlock: 'ok' | 'throws' | 'false'): { pool: PgPool; conns: FakeConn[] } {
  const conns: FakeConn[] = [];
  const pool: PgPool = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      const c: FakeConn = {
        released: [], queries: [],
        query: async (text: string) => {
          c.queries.push(text);
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ got: true }] };
          if (text.includes('pg_advisory_unlock')) {
            if (unlock === 'throws') throw Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
            return { rows: [{ ok: unlock === 'ok' }] };
          }
          return { rows: [] };
        },
        release: (err?: unknown) => { c.released.push(err); },
      };
      conns.push(c);
      return c;
    },
  };
  return { pool, conns };
}

describe('round 35 · NEW-3: a build lease whose unlock fails is never handed back to the pool', () => {
  for (const unlock of ['throws', 'false'] as const) {
    it(`M35-FR-03 OB-124 NEW-3: the unlock ${unlock === 'throws' ? 'throws' : 'answers "not held"'} — the connection is discarded and the failure said by name`, async () => {
      const { pool, conns } = fakePool(unlock);
      const said: string[] = [];
      const store = new SqlSnapshotStore(pgPoolClient(pool), { onLeaseProblem: (d) => { said.push(d); } });
      const lease = await store.buildLease('t-1', 'box-health-history@1') as BuildLeaseHeld;
      expect(typeof lease).toBe('function');
      await lease(); // the caller is never thrown at — but it is never silent either
      expect(conns).toHaveLength(1);
      expect(conns[0]!.released).toHaveLength(1);
      expect(conns[0]!.released[0]).toBeTruthy(); // discarded: node-postgres ends a client released with a truthy value
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/projection build lease t-1:box-health-history@1/);
      expect(said[0]).toMatch(/BuildLeaseUnlockError/);
      if (unlock === 'throws') expect(said[0]).toMatch(/57014/);
      expect(store.buildLeasesHeld).toBe(0);
    });
  }
  it('M35-FR-03 OB-124 NEW-3: a clean unlock — the pooled session is still discarded; nothing said', async () => {
    const { pool, conns } = fakePool('ok');
    const said: string[] = [];
    const store = new SqlSnapshotStore(pgPoolClient(pool), { onLeaseProblem: (d) => { said.push(d); } });
    const lease = await store.buildLease('t-1', 'p') as BuildLeaseHeld;
    expect(lease.lost()).toBe(false);
    // NEW-2: on the pool, one lease at a time — the next is "busy here", answered at once (no connection taken).
    expect(await store.buildLease('t-2', 'p')).toBe(BUILD_LEASES_BUSY_HERE);
    expect(conns).toHaveLength(1);
    await lease();
    expect(conns[0]!.released).toEqual([true]);
    expect(said).toEqual([]);
    expect(lease.lost()).toBe(true); // over: no longer held
    const next = await store.buildLease('t-2', 'p') as BuildLeaseHeld;
    await next();
    expect(conns).toHaveLength(2);
  });
});

describe('round 35 · NEW-2: a lease session of its own', () => {
  function fakeClient(): PgStandaloneClient & { ended: number; fire: (e: 'error' | 'end') => void } {
    const listeners: Record<string, ((err?: Error) => void)[]> = { error: [], end: [] };
    const c = {
      ended: 0,
      connect: async () => undefined,
      end: async () => { c.ended += 1; },
      query: async () => ({ rows: [] }),
      on: (event: 'error' | 'end', l: (err?: Error) => void) => { listeners[event]!.push(l); return c; },
      fire: (e: 'error' | 'end') => { for (const l of listeners[e]!) l(e === 'error' ? new Error('terminating connection due to administrator command') : undefined); },
    };
    return c;
  }
  it('M35-FR-03 NEW-2/NEW-3: ended after its work — when the work throws too — and says when the server ended it under the work', async () => {
    const a = fakeClient();
    const session = pgDedicatedSession(() => a);
    await session(async (_conn, ended) => { expect(ended()).toBeUndefined(); a.fire('error'); expect(ended()).toBeInstanceOf(Error); });
    expect(a.ended).toBe(1);
    const b = fakeClient();
    await expect(pgDedicatedSession(() => b)(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(b.ended).toBe(1);
    // A connection closed by us is not "ended under the work"; one closed by the server is.
    const c = fakeClient();
    await pgDedicatedSession(() => c)(async (_conn, ended) => { c.fire('end'); expect(ended()).toBeInstanceOf(Error); });
  });
});
