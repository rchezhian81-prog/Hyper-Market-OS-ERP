import { describe, it, expect } from 'vitest';
import {
  pgDedicatedSession, pgEndBackendVia, checkIntervalRefused, DedicatedSessionTimeoutError, END_BACKEND_ANSWER_MS, END_BACKEND_WAIT_MS,
  type PgStandaloneClient, type PgQueryable,
} from '../../packages/persistence/src/pg-client';
import { leaseSessionOptions } from '../../services/api/src/main';

/**
 * **Round 39 · M35-FR-03 · OB-106 · verifier r37 L1, L2, L3 — ending a cut-off lease session is bounded; the start time is
 * matched as a number; a database server that refuses the client check connects without it.** (Real PostgreSQL:
 * `tests/integration/a-lease-session-is-ended-in-any-datestyle-and-connects-without-the-check.test.ts`.)
 *
 *   • L1: the request pool never answers the "end that session" query — the session (a build lease's release) is still let go,
 *     within END_BACKEND_ANSWER_MS, and that is said by name (`DedicatedSessionEndTimeoutError`). Round 37: still waiting;
 *   • L2: the start time is read and compared as seconds since 1970 (`extract(epoch …)`), never as a date in words;
 *   • L3: the connect is refused for client_connection_check_interval (PostgreSQL not on Linux, 22023): the session connects
 *     again without it, says so by name once (`ClientConnectionCheckRefused`), and later sessions go without it at once; any
 *     other connect failure is thrown as it was; without the option the refusal is thrown as before (the Linux path unchanged).
 */

function client(opts: { hang?: (t: string) => boolean; pid?: number; connectError?: Error; name?: string; log?: string[] } = {}) {
  const listeners: Record<string, ((e?: Error) => void)[]> = {};
  const c = {
    destroyed: 0,
    connect: async () => { opts.log?.push(`connect ${opts.name ?? ''}`); if (opts.connectError !== undefined) { c.emit('end'); throw opts.connectError; } },
    end: async () => undefined,
    query: (text: string) => {
      opts.log?.push(`query ${opts.name ?? ''}`);
      if (opts.hang?.(text) === true) return new Promise<never>(() => undefined);
      if (text.includes('pg_backend_pid')) return Promise.resolve({ rows: opts.pid === undefined ? [] : [{ pid: opts.pid, started: '1760583600.123456' }] });
      return Promise.resolve({ rows: [{ x: 1 }] });
    },
    on: (event: string, l: (e?: Error) => void) => { (listeners[event] ??= []).push(l); return c; },
    emit: (event: string, e?: Error) => { for (const l of listeners[event] ?? []) l(e); },
    connection: { stream: { destroy: () => { c.destroyed += 1; } } },
  };
  return c;
}
/** PostgreSQL's answer on a server that is not Linux (FATAL at connect, 22023). */
const refusedOffLinux = (): Error => Object.assign(new Error('invalid value for parameter "client_connection_check_interval": "10000"'), {
  code: '22023', detail: '"client_connection_check_interval" must be set to 0 on this platform.',
});

describe('round 39 · L1: ending a cut-off lease session is bounded', () => {
  it('M35-FR-03 OB-106 L1: a request pool that never answers — the session is let go after the bound, said by name', async () => {
    const hung: PgQueryable = { query: () => new Promise<never>(() => undefined) };
    const c = client({ hang: (t) => t.includes('pg_sleep'), pid: 31 });
    const said: string[] = [];
    const t0 = Date.now();
    await expect(pgDedicatedSession(() => c as unknown as PgStandaloneClient, {
      queryTimeoutMs: 50, endBackend: pgEndBackendVia(hung), endBackendTimeoutMs: 200, onProblem: (d) => { said.push(d); },
    })(async (conn) => { await conn.query('SELECT pg_sleep(3600)'); })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(240); // 50 ms bound + the 200 ms wait for the end: waited for, but…
    expect(took).toBeLessThan(2_000); // … bounded (round 37: never let go)
    expect(c.destroyed).toBe(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/pid 31/);
    expect(said[0]).toMatch(/did not answer within 200 ms/);
    expect(said[0]).toMatch(/DedicatedSessionEndTimeoutError/);
  });
  it('M35-FR-03 OB-106 L1: the default bound is the server\'s own wait plus 5 s', () => {
    expect(END_BACKEND_ANSWER_MS).toBe(END_BACKEND_WAIT_MS + 5_000);
  });
  it('M35-FR-03 OB-106 L1: an end that answers in time is not said (and ends nothing more)', async () => {
    const asked: unknown[] = [];
    const quick: PgQueryable = { query: async (_t, values) => { asked.push(values); return { rows: [{ ok: true, hidden: false, same: true }] }; } };
    const c = client({ hang: (t) => t.includes('pg_sleep'), pid: 32 });
    const said: string[] = [];
    await expect(pgDedicatedSession(() => c as unknown as PgStandaloneClient, { queryTimeoutMs: 50, endBackend: pgEndBackendVia(quick), endBackendTimeoutMs: 200, onProblem: (d) => { said.push(d); } })(async (conn) => {
      await conn.query('SELECT pg_sleep(1)');
    })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(said).toEqual([]);
    expect(asked).toEqual([[32, '1760583600.123456', END_BACKEND_WAIT_MS]]);
  });
});

describe('round 39 · L2: the start time is matched as a number, in SQL', () => {
  it('M35-FR-03 OB-106 L2: the session reads extract(epoch …) as text; the end compares it as numeric', async () => {
    const texts: string[] = [];
    const pool: PgQueryable = { query: async (t) => { texts.push(t); return { rows: [] }; } };
    expect(await pgEndBackendVia(pool)({ pid: 1, startedAt: '1760583600.123456' })).toBe('already_gone');
    expect(texts[0]).toContain('extract(epoch from backend_start) = $2::numeric');
    expect(texts[0]).not.toContain('$2::timestamptz');
    const seen: string[] = [];
    const c = { ...client({ pid: 5 }), query: (t: string) => { seen.push(t); return Promise.resolve({ rows: t.includes('pg_backend_pid') ? [{ pid: 5, started: '1760583600.5' }] : [] }); } };
    await pgDedicatedSession(() => c as unknown as PgStandaloneClient, { endBackend: async () => 'ended' })(async () => undefined);
    expect(seen[0]).toContain('extract(epoch from backend_start)::text AS started');
  });
});

describe('round 39 · L3: a server that refuses client_connection_check_interval — the lease connects without it', () => {
  it('M35-FR-03 OB-106 L3: the refusal at connect — connected again without it, said once by name; later sessions go without it', async () => {
    const log: string[] = [];
    const said: string[] = [];
    let opened = 0;
    const session = pgDedicatedSession(() => { opened += 1; return client({ connectError: refusedOffLinux(), name: 'with', log }) as unknown as PgStandaloneClient; }, {
      openWithoutCheckInterval: () => client({ name: 'without', log }) as unknown as PgStandaloneClient, onProblem: (d) => { said.push(d); },
    });
    let ended: unknown = 'not asked';
    expect(await session(async (conn, e) => { await conn.query('SELECT 1'); ended = e(); return 'built'; })).toBe('built');
    expect(ended).toBeUndefined(); // the given-up connection's own "end" does not count against the new one
    expect(log).toEqual(['connect with', 'connect without', 'query without']);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/ClientConnectionCheckRefused/);
    expect(said[0]).toMatch(/only on Linux/);
    // The next session goes straight to the connection without it, and says nothing more.
    log.length = 0;
    expect(await session(async (conn) => { await conn.query('SELECT 1'); return 'again'; })).toBe('again');
    expect(log).toEqual(['connect without', 'query without']);
    expect(opened).toBe(1);
    expect(said).toHaveLength(1);
  });
  it('M35-FR-03 OB-106 L3: any other connect failure is thrown as it is; without the fallback the refusal is thrown (Linux path unchanged)', async () => {
    const other = Object.assign(new Error('password authentication failed for user "sre_app"'), { code: '28P01' });
    const withFallback = (e: Error) => pgDedicatedSession(() => client({ connectError: e }) as unknown as PgStandaloneClient, {
      openWithoutCheckInterval: () => { throw new Error('must not be opened'); }, onProblem: () => undefined,
    });
    await expect(withFallback(other)(async () => 'x')).rejects.toBe(other);
    const badValue = Object.assign(new Error('invalid value for parameter "work_mem": "x"'), { code: '22023' });
    await expect(withFallback(badValue)(async () => 'x')).rejects.toBe(badValue);
    const refused = refusedOffLinux();
    await expect(pgDedicatedSession(() => client({ connectError: refused }) as unknown as PgStandaloneClient)(async () => 'x')).rejects.toBe(refused);
    // The Linux path: a connect that succeeds never opens the fallback.
    const log: string[] = [];
    await pgDedicatedSession(() => client({ name: 'with', log }) as unknown as PgStandaloneClient, { openWithoutCheckInterval: () => client({ name: 'without', log }) as unknown as PgStandaloneClient })(async (conn) => { await conn.query('SELECT 1'); });
    expect(log).toEqual(['connect with', 'query with']);
  });
  it('M35-FR-03 OB-106 L3: only that refusal is recognised; the options without the check keep the keepalives', () => {
    expect(checkIntervalRefused(refusedOffLinux())).toBe(true);
    expect(checkIntervalRefused(Object.assign(new Error('"-5" is outside the valid range for parameter "client_connection_check_interval" (0 .. 2147483647)'), { code: '22023' }))).toBe(true);
    expect(checkIntervalRefused(Object.assign(new Error('invalid value for parameter "client_connection_check_interval"'), { code: '42501' }))).toBe(false);
    expect(checkIntervalRefused(new Error('client_connection_check_interval'))).toBe(false);
    expect(checkIntervalRefused(undefined)).toBe(false);
    expect(leaseSessionOptions('-c a=1', { clientCheck: false })).toBe('-c a=1 -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3');
    expect(leaseSessionOptions('-c a=1')).toBe('-c a=1 -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3 -c client_connection_check_interval=10000');
  });
});
