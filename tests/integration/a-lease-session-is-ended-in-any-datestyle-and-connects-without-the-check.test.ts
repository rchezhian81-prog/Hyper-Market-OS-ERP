import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, Pool } from 'pg';
import {
  pgDedicatedSession, pgEndBackendVia, DedicatedSessionTimeoutError, type PgStandaloneClient, type PgQueryable, type DedicatedBackend,
} from '../../packages/persistence/src/pg-client';
import { leaseSessionOptions, databaseSessionOptions, LEASE_SERVER_KEEPALIVE } from '../../services/api/src/main';
import { ensureAppRole, asRole } from '../support/db-app-role';

/**
 * **Round 39 · M35-FR-03 · OB-106 · verifier r37 L1, L2, L3 — on real PostgreSQL, as head office's own non-superuser login role.**
 *
 *   • L2: the lease session runs with DateStyle 'SQL, DMY' and TimeZone 'Asia/Kolkata', the request pool with DateStyle
 *     'Postgres, DMY' — round 37 read the start time as a date in words ("16/10/2026 10:47:04.56748 IST") and the other
 *     session could not read it back ("out of range"), so nothing was ended (shown first, as the contrast). Now it is read and
 *     compared as seconds since 1970, inside SQL: the cut-off session is ended, its backend gone;
 *   • L1: a request pool that never answers — the session (a build lease's release) is let go within its bound, said by name;
 *   • L3: the server refuses client_connection_check_interval at connect (simulated with a value PostgreSQL refuses with the
 *     same code, 22023, at the same moment) — the lease connects again without it, with its TCP keepalives, said by name.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const APP_ROLE = 'sre_app_connected';
const NOT_ISO = ' -c DateStyle=SQL,DMY -c TimeZone=Asia/Kolkata';

describe.skipIf(DATABASE_URL === undefined)('round 39 · M35-FR-03 · OB-106 · verifier r37 L1-L3: a lease session is ended in any DateStyle, bounded, and connects without the check (PostgreSQL)', () => {
  let platform: Pool;
  let app: Pool;
  let appUrl: string;
  const alive = async (pid: number): Promise<boolean> => (await platform.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rows.length > 0;

  beforeAll(async () => {
    platform = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await ensureAppRole(platform, APP_ROLE);
    appUrl = asRole(DATABASE_URL!, APP_ROLE);
    // The request pool in yet another DateStyle (and the same zone): nothing may depend on how a date is written.
    app = new Pool({ connectionString: appUrl, max: 2, options: `${databaseSessionOptions(undefined).options} -c DateStyle=Postgres,DMY -c TimeZone=Asia/Kolkata` });
  });
  afterAll(async () => { await app.end(); await platform.end(); });

  it('M35-FR-03 OB-106 L2 (contrast, round 37): the start time written in SQL, DMY with IST is not read back as itself by another session', async () => {
    const c = new Client({ connectionString: appUrl, options: NOT_ISO.trim() });
    await c.connect();
    try {
      const { rows: [r] } = await c.query<{ s: string; pid: number }>('SELECT pid, backend_start::text AS s FROM pg_stat_activity WHERE pid = pg_backend_pid()');
      expect(r!.s).toMatch(/^\d\d\/\d\d\/\d{4} .* IST$/);
      // Round 37's comparison, made in the request pool's session: refused ("out of range" in an ISO / MDY session), or —
      // here, DMY — read with "IST" as ISRAEL time, so the very same session no longer matches (it would answer already_gone).
      const same = await app.query<{ same: boolean }>('SELECT backend_start = $2::timestamptz AS same FROM pg_stat_activity WHERE pid = $1', [r!.pid, r!.s])
        .then((x) => x.rows[0]!.same, () => 'refused' as const);
      expect(same).not.toBe(true);
      await expect(platform.query('SELECT $1::timestamptz AS t', [r!.s])).rejects.toThrow(/out of range/);
    } finally { await c.end(); }
  });

  it('M35-FR-03 OB-106 L2: a cut-off lease session in DateStyle SQL, DMY / Asia/Kolkata is ended on the server (matched as a number)', async () => {
    const said: string[] = [];
    let seen: DedicatedBackend | undefined;
    const endVia = pgEndBackendVia(app);
    const session = pgDedicatedSession(() => new Client({ connectionString: appUrl, options: leaseSessionOptions(databaseSessionOptions(undefined).options) + NOT_ISO }) as unknown as PgStandaloneClient, {
      queryTimeoutMs: 500, endBackend: async (b) => { seen = b; return endVia(b); }, onProblem: (d) => { said.push(d); },
    });
    await expect(session(async (conn) => { await conn.query('SELECT pg_sleep(5)'); })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(seen!.startedAt).toMatch(/^\d{10}\.\d+$/); // seconds since 1970, as PostgreSQL's numeric text
    expect(said).toEqual([]); // ended — nothing to say
    expect(await alive(seen!.pid)).toBe(false); // round 37: still alive (the end was refused: "out of range")
    // A wrong start time (the pid reused) still ends nothing.
    const pc = await app.connect();
    try {
      const { rows: [me] } = await pc.query<{ pid: number; s: string }>('SELECT pid, extract(epoch from backend_start)::text AS s FROM pg_stat_activity WHERE pid = pg_backend_pid()');
      expect(await endVia({ pid: me!.pid, startedAt: String(Number(me!.s) - 1) })).toBe('already_gone');
      expect((await pc.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 });
      // … and the exact one, read in the request pool's own DateStyle, matches it (the same number in every DateStyle).
      const { rows: [same] } = await platform.query<{ same: boolean }>('SELECT extract(epoch from backend_start) = $2::numeric AS same FROM pg_stat_activity WHERE pid = $1', [me!.pid, me!.s]);
      expect(same!.same).toBe(true);
    } finally { pc.release(); }
  }, 30_000);

  it('M35-FR-03 OB-106 L1: a request pool that never answers — the release completes within its bound, said by name', async () => {
    const hung: PgQueryable = { query: () => new Promise<never>(() => undefined) };
    const said: string[] = [];
    const t0 = Date.now();
    await expect(pgDedicatedSession(() => new Client({ connectionString: appUrl }) as unknown as PgStandaloneClient, {
      queryTimeoutMs: 300, endBackend: pgEndBackendVia(hung), endBackendTimeoutMs: 500, onProblem: (d) => { said.push(d); },
    })(async (conn) => { await conn.query('SELECT pg_sleep(2)'); })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(Date.now() - t0).toBeLessThan(3_000); // round 37: still pending after 5 s
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/DedicatedSessionEndTimeoutError/);
  }, 30_000);

  it('M35-FR-03 OB-106 L3: refused at connect for client_connection_check_interval — connected without it, keepalives kept, said by name', async () => {
    const said: string[] = [];
    const base = databaseSessionOptions(undefined).options;
    const session = pgDedicatedSession(
      // The refusal a server that is not Linux gives (22023, at connect) — here from a value PostgreSQL refuses anywhere.
      () => new Client({ connectionString: appUrl, options: `${leaseSessionOptions(base, { clientCheck: false })} -c client_connection_check_interval=-5` }) as unknown as PgStandaloneClient,
      { openWithoutCheckInterval: () => new Client({ connectionString: appUrl, options: leaseSessionOptions(base, { clientCheck: false }) }) as unknown as PgStandaloneClient, onProblem: (d) => { said.push(d); } },
    );
    const shown = await session(async (conn) => conn.query<{ i: string; k: string }>("SELECT current_setting('tcp_keepalives_idle') AS i, current_setting('client_connection_check_interval') AS k"));
    expect(shown[0]).toEqual({ i: String(LEASE_SERVER_KEEPALIVE.idleSeconds), k: '0' });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/client_connection_check_interval/);
    expect(said[0]).toMatch(/ClientConnectionCheckRefused/);
    // The Linux path is unchanged: the production options connect as they are, with the check on.
    const linux = await pgDedicatedSession(() => new Client({ connectionString: appUrl, options: leaseSessionOptions(base) }) as unknown as PgStandaloneClient, {
      openWithoutCheckInterval: () => { throw new Error('not on Linux'); },
    })(async (conn) => conn.query<{ k: string }>("SELECT current_setting('client_connection_check_interval') AS k"));
    expect(linux[0]).toEqual({ k: '10s' });
  }, 30_000);
});
