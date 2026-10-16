import { describe, it, expect } from 'vitest';
import { pgDedicatedSession, DedicatedSessionTimeoutError, type PgStandaloneClient, type DedicatedBackend, type EndBackendOutcome } from '../../packages/persistence/src/pg-client';
import { leaseSessionOptions, LEASE_SERVER_KEEPALIVE } from '../../services/api/src/main';

/**
 * **Round 37 · M35-FR-03 · OB-106 · verifier r36 NEW-4 — when head office cuts off (or loses) a session of its own, it ends that
 * session's backend ON THE SERVER from another connection, and says by name when it cannot.** (The real PostgreSQL proof is
 * `tests/integration/a-build-lease-cut-off-here-is-freed-on-the-database-at-once.test.ts`.)
 *
 *   • the backend (process id and start time) is read when the session opens; a query past its bound destroys the socket AND
 *     ends that backend (`endBackend`), and the session is over only once that is done;
 *   • a connection that ends by itself under the session (an error, the socket closed) ends the backend too;
 *   • a closed session never ends anything; without `endBackend` nothing is asked;
 *   • a refusal, or a backend that did not end within the wait, is said by name (`DedicatedSessionEndRefusedError`);
 *   • production's lease connection carries the server's own keepalive and client check.
 */

function client(opts: { hang?: (t: string) => boolean; pid?: number } = {}) {
  const listeners: Record<string, ((e?: Error) => void)[]> = {};
  const c = {
    destroyed: 0,
    connect: async () => undefined,
    end: async () => undefined,
    query: (text: string) => {
      if (opts.hang?.(text) === true) return new Promise<never>(() => undefined);
      if (text.includes('pg_backend_pid')) return Promise.resolve({ rows: opts.pid === undefined ? [] : [{ pid: opts.pid, started: '2026-10-16 03:00:00.123456+00' }] });
      return Promise.resolve({ rows: [{ x: 1 }] });
    },
    on: (event: string, l: (e?: Error) => void) => { (listeners[event] ??= []).push(l); return c; },
    emit: (event: string, e?: Error) => { for (const l of listeners[event] ?? []) l(e); },
    connection: { stream: { destroy: () => { c.destroyed += 1; } } },
  };
  return c;
}
const recorder = (outcome: EndBackendOutcome | Error, delayMs = 0) => {
  const asked: DedicatedBackend[] = [];
  const fn = async (b: DedicatedBackend): Promise<EndBackendOutcome> => {
    asked.push(b);
    await new Promise((r) => setTimeout(r, delayMs));
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { asked, fn };
};

describe('round 37 · NEW-4: a session cut off here is ended on the server', () => {
  it('M35-FR-03 OB-106 NEW-4: a query past its bound ends that exact backend, and the session waits for it', async () => {
    const c = client({ hang: (t) => t.includes('pg_sleep'), pid: 4242 });
    const end = recorder('ended', 200);
    const said: string[] = [];
    const t0 = Date.now();
    await expect(pgDedicatedSession(() => c as unknown as PgStandaloneClient, { queryTimeoutMs: 100, endBackend: end.fn, onProblem: (d) => { said.push(d); } })(async (conn) => {
      await conn.query('SELECT pg_sleep(3600)');
    })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290); // the 100 ms bound + the 200 ms the ending took: awaited
    expect(c.destroyed).toBe(1);
    expect(end.asked).toEqual([{ pid: 4242, startedAt: '2026-10-16 03:00:00.123456+00' }]);
    expect(said).toEqual([]);
  });
  it('M35-FR-03 OB-106 NEW-4: a connection that fails by itself under the session ends the backend too (once)', async () => {
    const c = client({ pid: 7 });
    const end = recorder('already_gone');
    await pgDedicatedSession(() => c as unknown as PgStandaloneClient, { endBackend: end.fn })(async () => {
      c.emit('error', new Error('read ECONNRESET'));
      c.emit('end');
    });
    expect(end.asked.map((b) => b.pid)).toEqual([7]);
  });
  it('M35-FR-03 OB-106 NEW-4: a session closed normally ends nothing; without endBackend nothing is asked', async () => {
    const c = client({ pid: 8 });
    const end = recorder('ended');
    await pgDedicatedSession(() => c as unknown as PgStandaloneClient, { endBackend: end.fn })(async (conn) => { await conn.query('SELECT 1'); });
    c.emit('end'); // the close's own end event
    expect(end.asked).toEqual([]);
    const silent = client({ hang: (t) => t.includes('pg_sleep'), pid: 9 });
    await expect(pgDedicatedSession(() => silent as unknown as PgStandaloneClient, { queryTimeoutMs: 50 })(async (conn) => { await conn.query('SELECT pg_sleep(1)'); })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
  });
  it('M35-FR-03 OB-106 NEW-4: a refusal, or a backend still running after the wait, is said by name', async () => {
    for (const outcome of [new Error('permission denied to terminate process'), 'still_running' as const]) {
      const c = client({ hang: (t) => t.includes('pg_sleep'), pid: 11 });
      const said: string[] = [];
      await expect(pgDedicatedSession(() => c as unknown as PgStandaloneClient, { queryTimeoutMs: 50, endBackend: recorder(outcome).fn, onProblem: (d) => { said.push(d); } })(async (conn) => {
        await conn.query('SELECT pg_sleep(1)');
      })).rejects.toBeInstanceOf(DedicatedSessionTimeoutError);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/pid 11/);
      expect(said[0]).toMatch(/DedicatedSessionEndRefusedError/);
    }
  });
  it('M35-FR-03 OB-106 NEW-4: the lease connection\'s options carry the server keepalive and the client check', () => {
    const o = leaseSessionOptions('-c idle_in_transaction_session_timeout=60000');
    expect(o).toBe('-c idle_in_transaction_session_timeout=60000 -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3 -c client_connection_check_interval=10000');
    expect(LEASE_SERVER_KEEPALIVE.idleSeconds + LEASE_SERVER_KEEPALIVE.intervalSeconds * LEASE_SERVER_KEEPALIVE.count).toBeLessThanOrEqual(90);
  });
});
