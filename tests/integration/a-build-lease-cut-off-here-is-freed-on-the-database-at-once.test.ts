import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, Pool } from 'pg';
import {
  pgDedicatedSession, pgEndBackendVia, pgPoolClient, DedicatedSessionEndRefusedError, type PgStandaloneClient,
} from '../../packages/persistence/src/pg-client';
import { SqlSnapshotStore, PROJECTION_BUILD_LEASE_CLASS, type BuildLeaseHeld } from '../../packages/persistence/src/snapshot';
import { leaseSessionOptions, databaseSessionOptions, LEASE_SERVER_KEEPALIVE } from '../../services/api/src/main';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **Round 37 · M35-FR-03 · OB-106 · verifier r36 NEW-4 — a build lease whose connection head office cuts off (a query past its
 * bound: a half-open network, or a database that stopped answering) is freed ON THE DATABASE at once, so another head-office
 * process may build that shop straight away. On real PostgreSQL, as head office's own non-superuser login role.**
 *
 *   • round 36 destroyed only this side's socket: the session's backend went on holding the advisory lock (about 2 hours on a
 *     real half-open link — the server's default keepalive), and every process said "another head-office process is building
 *     it now" while nobody was. Shown first, as the contrast (no `endBackend`): the lock is still held after the release;
 *   • now the lease records its backend (process id and start time) and, when its connection is cut here, ends that exact
 *     backend from one of the pool's connections (`pg_terminate_backend` — the same role may end its own sessions, no
 *     superuser): after the release the lock is gone, the backend is gone, and another process takes the lease at once;
 *   • a refusal (the session is another role's: not visible to this one) is said by name (`DedicatedSessionEndRefusedError`);
 *   • the lease connection also carries the server's own keepalive (30 s idle, every 10 s, 3 tries) and a client check during a
 *     query (10 s) — the server notices a silent client within about a minute even if ending it from here fails.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const APP_ROLE = 'sre_app_connected';
const SLEEP_S = 4;

/** A lease connection whose unlock is made slow on the server (pg_sleep), so this side's 500 ms bound cuts it off. */
const slowUnlock = (url: string, options?: string) => (): PgStandaloneClient => {
  const c = new Client({ connectionString: url, keepAlive: true, ...(options === undefined ? {} : { options }) });
  const q = c.query.bind(c) as (text: string, params?: unknown[]) => Promise<unknown>;
  (c as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => typeof text === 'string' && text.includes('pg_advisory_unlock')
    ? q(`SELECT pg_sleep(${SLEEP_S}), pg_advisory_unlock($1::int, hashtext($2)) AS ok`, params) : q(text, params);
  return c as unknown as PgStandaloneClient;
};

describe.skipIf(DATABASE_URL === undefined)('round 37 · M35-FR-03 · OB-106 · verifier r36 NEW-4: a build lease cut off here is freed on the database at once (PostgreSQL)', () => {
  let platform: Pool;
  let app: Pool;
  let appUrl: string;
  const locksOn = async (key: string): Promise<number[]> => (await platform.query<{ pid: number }>(
    "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int::oid AND objid = hashtext($2)::oid AND granted", [PROJECTION_BUILD_LEASE_CLASS, key])).rows.map((r) => r.pid);
  const alive = async (pid: number): Promise<boolean> => (await platform.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rows.length > 0;
  /** Wait until the server-side sleep is over (the contrast case leaves a backend sleeping). */
  const settle = async (key: string): Promise<void> => {
    for (let i = 0; i < 100 && (await locksOn(key)).length > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  };

  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await ensureAppRole(platform, APP_ROLE);
    appUrl = asRole(DATABASE_URL!, APP_ROLE);
    app = new Pool({ connectionString: appUrl, max: 2 });
  });
  afterAll(async () => { await app.end(); await platform.end(); });

  it('M35-FR-03 OB-106 NEW-4: the lease connection carries the server\'s own keepalive and client check', async () => {
    const options = leaseSessionOptions(databaseSessionOptions(undefined).options);
    const shown = await pgDedicatedSession(() => new Client({ connectionString: appUrl, options }) as unknown as PgStandaloneClient)(async (conn) =>
      conn.query<{ i: string; n: string; c: string; k: string; t: string }>("SELECT current_setting('tcp_keepalives_idle') AS i, current_setting('tcp_keepalives_interval') AS n, current_setting('tcp_keepalives_count') AS c, current_setting('client_connection_check_interval') AS k, current_setting('idle_in_transaction_session_timeout') AS t"));
    expect(shown[0]).toEqual({ i: String(LEASE_SERVER_KEEPALIVE.idleSeconds), n: String(LEASE_SERVER_KEEPALIVE.intervalSeconds), c: String(LEASE_SERVER_KEEPALIVE.count), k: '10s', t: '1min' });
  });

  it('M35-FR-03 OB-106 NEW-4 (contrast, round 36): without ending the backend, the lock stays held on the server after the release', async () => {
    const key = `t-r37-contrast-${Date.now()}:p`;
    const store = new SqlSnapshotStore(pgPoolClient(app), { leaseSession: pgDedicatedSession(slowUnlock(appUrl), { queryTimeoutMs: 500 }), onLeaseProblem: () => undefined });
    const lease = await store.buildLease(key.split(':')[0]!, 'p') as BuildLeaseHeld;
    await lease();
    expect(store.buildLeasesHeld).toBe(0);
    expect((await locksOn(key)).length).toBe(1); // still held by the backend on the server
    const other = new SqlSnapshotStore(pgPoolClient(app), { leaseSession: pgDedicatedSession(() => new Client({ connectionString: appUrl }) as unknown as PgStandaloneClient) });
    expect(await other.buildLease(key.split(':')[0]!, 'p')).toBeUndefined(); // "another process is building it" — nobody is
    await settle(key);
  }, 30_000);

  it('M35-FR-03 OB-106 NEW-4: cut off here, the backend is ended from the pool — the lock is gone and another process takes it at once', async () => {
    const key = `t-r37-${Date.now()}:p`;
    const said: string[] = [];
    const sessionSaid: string[] = [];
    const store = new SqlSnapshotStore(pgPoolClient(app), {
      leaseSession: pgDedicatedSession(slowUnlock(appUrl, leaseSessionOptions('')), { queryTimeoutMs: 500, endBackend: pgEndBackendVia(app), onProblem: (d) => { sessionSaid.push(d); } }),
      onLeaseProblem: (d) => { said.push(d); },
    });
    const lease = await store.buildLease(key.split(':')[0]!, 'p') as BuildLeaseHeld;
    const [holder] = await locksOn(key);
    expect(holder).toBeDefined();
    const t0 = Date.now();
    await lease();
    const releaseMs = Date.now() - t0;
    expect(releaseMs).toBeLessThan(SLEEP_S * 1000); // never waits for the server's sleep to finish
    expect(store.buildLeasesHeld).toBe(0);
    expect(said.join(' ')).toMatch(/BuildLeaseUnlockError/);
    expect(sessionSaid).toEqual([]); // ended, nothing to say
    // On the server: the lock and the backend are gone at once.
    expect(await locksOn(key)).toEqual([]);
    expect(await alive(holder!)).toBe(false);
    // Another head-office process takes the lease promptly.
    const t1 = Date.now();
    const other = new SqlSnapshotStore(pgPoolClient(app), { leaseSession: pgDedicatedSession(() => new Client({ connectionString: appUrl }) as unknown as PgStandaloneClient) });
    const theirs = await other.buildLease(key.split(':')[0]!, 'p');
    expect(typeof theirs).toBe('function');
    expect(Date.now() - t1).toBeLessThan(3_000);
    await (theirs as BuildLeaseHeld)();
    expect(await locksOn(key)).toEqual([]);
  }, 30_000);

  it('M35-FR-03 OB-106 NEW-4: a session that is not this role\'s is never ended from here — refused and said by name', async () => {
    // The lease connection logs in as the superuser (as a misconfigured deployment would); the pool is the app role.
    const key = `t-r37-refused-${Date.now()}:p`;
    const sessionSaid: string[] = [];
    const store = new SqlSnapshotStore(pgPoolClient(app), {
      leaseSession: pgDedicatedSession(slowUnlock(DATABASE_URL!), { queryTimeoutMs: 500, endBackend: pgEndBackendVia(app), onProblem: (d) => { sessionSaid.push(d); } }),
      onLeaseProblem: () => undefined,
    });
    const lease = await store.buildLease(key.split(':')[0]!, 'p') as BuildLeaseHeld;
    await lease();
    expect(sessionSaid).toHaveLength(1);
    expect(sessionSaid[0]).toMatch(/could not be ended from another connection .*DedicatedSessionEndRefusedError/);
    expect((await locksOn(key)).length).toBe(1); // left to the server (its keepalive / the query's end)
    await settle(key);
    // The function itself, directly: refused by name.
    const admin = new Client({ connectionString: DATABASE_URL }); await admin.connect();
    try {
      const me = (await admin.query<{ pid: number; started: string }>('SELECT pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()')).rows[0]!;
      await expect(pgEndBackendVia(app)({ pid: me.pid, startedAt: me.started })).rejects.toBeInstanceOf(DedicatedSessionEndRefusedError);
      expect(await alive(me.pid)).toBe(true);
      // A process id with another start time (reused) is never ended: "already gone".
      const own = await app.connect();
      try {
        const o = (await own.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!;
        expect(await pgEndBackendVia(app)({ pid: o.pid, startedAt: '2000-01-01 00:00:00+00' })).toBe('already_gone');
        expect(await alive(o.pid)).toBe(true);
      } finally { own.release(); }
    } finally { await admin.end(); }
  }, 30_000);
});
