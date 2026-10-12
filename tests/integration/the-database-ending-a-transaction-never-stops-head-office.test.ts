import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startRealCloud, CONNECTED_APP_ROLE, type RealCloud } from '../support/real-store';
import { TEST_PACK_KEY } from '../support/api-harness';
import { pgPoolClient, DatabaseSessionEndedError, isSessionEnded } from '../../packages/persistence/src/pg-client';
import {
  startApi, databaseSessionOptions, idleInTransactionTimeoutProblem, lastResortVerdict, MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS,
} from '../../services/api/src/main';

/**
 * **Verifier r21 IDLE-CRASH — the database ending a transaction's session never takes head office down, and saves nothing.**
 *
 * Round 21 bounded every API session with `idle_in_transaction_session_timeout`. When it fired (or anything else ended a
 * checked-out session: pg_terminate_backend, a server restart) node-postgres emitted `'error'` on a client nobody listened
 * to, and the WHOLE API process exited (probe idle-crash.cjs: "Unhandled 'error' event … 25P03"). Proved here:
 *
 *   1. the probe's two shapes through the product's own adapter (pgPoolClient), with a 1-second limit — a transaction left
 *      idle while the event loop waits, and one stuck behind a busy event loop: each REJECTS with DatabaseSessionEndedError
 *      ("nothing in it was saved"), its row is NOT in the table, the process sees NO uncaught exception, and the very next
 *      transaction on the same pool works (the broken connection was discarded, not lent out again);
 *   2. through the REAL production API on PostgreSQL: a sale whose write is waiting when the database ends its session
 *      answers 500 `database_ended_transaction`, wasItSaved `not_saved`; the sale is NOT in the ledger; the API keeps
 *      serving — the next request answers, and the same sale re-sent under the same key is kept exactly once;
 *   3. `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` must be 0 (off) or ≥ 10 s: "60" is refused at boot by name (EX_CONFIG);
 *   4. the last-resort policy: a dead database connection → keep serving; anything else → exit (stated and tested).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner';

/** Every uncaught exception while a proof runs — an `'error'` event nobody listens to lands here instead of exiting. */
const uncaught: unknown[] = [];
const onUncaught = (e: unknown): void => { uncaught.push(e); };

describe('the idle-in-transaction limit has a floor, and the last resort is a stated policy', () => {
  it('refuses a limit between 0 and 10 s at boot, by name (EX_CONFIG), and accepts 0 and ≥ 10 s', async () => {
    expect(MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(10_000);
    expect(idleInTransactionTimeoutProblem(undefined)).toBeUndefined();
    expect(idleInTransactionTimeoutProblem('0')).toBeUndefined();
    expect(idleInTransactionTimeoutProblem('10000')).toBeUndefined();
    expect(idleInTransactionTimeoutProblem('60000')).toBeUndefined();
    for (const bad of ['60', '9999', '1', '-5', '15000.5']) {
      expect(idleInTransactionTimeoutProblem(bad)).toMatch(/must be 0 \(off\) or a whole number of milliseconds of at least 10000/);
    }
    const said: string[] = [];
    const running = await startApi({
      DATABASE_URL: ['postgres://nobody', '127.0.0.1:1/never'].join('@'), PACK_SIGNING_KEY: 'k'.repeat(48), IDP_SIGNING_KEY: 'i'.repeat(48),
      IDP_ISSUER: 'https://issuer.test', IDP_AUDIENCE: 'sre', PORT: '0', NODE_ENV: 'test', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60',
    }, (t) => { said.push(t); }, (t) => { said.push(t); });
    expect(running).toBeUndefined(); // main() turns this into exit code 78 (EX_CONFIG), before any database is touched
    expect(said.join('')).toMatch(/DB_IDLE_IN_TRANSACTION_TIMEOUT_MS is "60" — it must be 0 \(off\).*one minute is 60000/s);
  });

  it('keeps serving on a database connection whose session ended, and exits on anything else', () => {
    const terminated = Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' });
    expect(lastResortVerdict(terminated)).toBe('keep_serving');
    expect(lastResortVerdict(new Error('Connection terminated unexpectedly'))).toBe('keep_serving');
    expect(lastResortVerdict(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe('keep_serving');
    expect(lastResortVerdict(new TypeError('Cannot read properties of undefined'))).toBe('exit');
    expect(lastResortVerdict(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('exit');
    expect(isSessionEnded(Object.assign(new Error('relation does not exist'), { code: '42P01' }))).toBe(false);
  });
});

describe.skipIf(DATABASE_URL === undefined)('verifier r21 IDLE-CRASH: the database ending a transaction never stops head office (PostgreSQL)', () => {
  let real: RealCloud;
  let platform: Pool;
  const TENANT = randomUUID();
  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    platform = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await platform.query('CREATE TABLE IF NOT EXISTS r21_idle_crash_proof (id text PRIMARY KEY)');
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: TENANT, owner: OWNER, packSigningKey: TEST_PACK_KEY, env: { DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '10000' } });
  }, 180_000);
  afterAll(async () => {
    await real?.stop();
    await platform?.query('DROP TABLE IF EXISTS r21_idle_crash_proof');
    await platform?.end();
    process.removeListener('uncaughtException', onUncaught);
  });

  const held = async (id: string): Promise<boolean> => (await platform.query('SELECT 1 FROM r21_idle_crash_proof WHERE id = $1', [id])).rows.length > 0;

  for (const shape of ['idle while the event loop waits', 'stuck behind a busy event loop'] as const) {
    it(`the probe, ${shape}: the transaction is refused as "nothing saved", the process lives, and the pool serves the next one`, async () => {
      uncaught.length = 0;
      const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: databaseSessionOptions('1000').options });
      const said: string[] = [];
      const sql = pgPoolClient(pool, { onConnectionEnded: (d) => { said.push(d); } });
      try {
        const id = `${shape}-${randomUUID()}`;
        const failed = sql.transaction!(async (tx) => {
          await tx.query('INSERT INTO r21_idle_crash_proof (id) VALUES ($1)', [id]);
          if (shape === 'idle while the event loop waits') await new Promise((r) => setTimeout(r, 2_500));
          else { const end = Date.now() + 2_500; while (Date.now() < end) { /* the event loop is blocked */ } }
          await tx.query('SELECT 1');
          return 'committed';
        });
        const error = await failed.then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(DatabaseSessionEndedError);
        expect((error as Error).message).toMatch(/^the database ended this transaction before it finished, so nothing in it was saved \(/);
        expect((error as Error).message).toMatch(/idle-in-transaction|25P03|terminated|not queryable/i);
        expect(await held(id)).toBe(false); // all-or-nothing: the database rolled it back
        await new Promise((r) => setTimeout(r, 300)); // the dying socket's last words, if any, arrive now
        expect(uncaught).toEqual([]); // nothing escaped: before r22 this was "Unhandled 'error' event" and the process exited
        // The broken connection was DISCARDED: the same one-connection pool serves the next transaction cleanly.
        const next = `${shape}-next-${randomUUID()}`;
        await sql.transaction!(async (tx) => { await tx.query('INSERT INTO r21_idle_crash_proof (id) VALUES ($1)', [next]); });
        expect(await held(next)).toBe(true);
        expect(pool.totalCount).toBe(1);
      } finally {
        await pool.end();
      }
    }, 30_000);
  }

  it('an IDLE pooled connection ended by the server is said in the log, and the pool opens a fresh one', async () => {
    uncaught.length = 0;
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: 'r21-idle-pooled-proof' });
    const said: string[] = [];
    const sql = pgPoolClient(pool, { onConnectionEnded: (d) => { said.push(d); } });
    try {
      await sql.transaction!(async (tx) => { await tx.query('SELECT 1'); }); // one connection now sits idle in the pool
      const ended = await platform.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'r21-idle-pooled-proof'");
      expect(ended.rows.length).toBe(1);
      for (let i = 0; i < 50 && said.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
      expect(said.join('\n')).toMatch(/^database: the server ended a pooled connection \(57P01: terminating connection due to administrator command\); it was discarded/);
      const id = `after-idle-${randomUUID()}`;
      await sql.transaction!(async (tx) => { await tx.query('INSERT INTO r21_idle_crash_proof (id) VALUES ($1)', [id]); });
      expect(await held(id)).toBe(true);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('through the production API: a sale whose session the database ends answers "not saved", is not kept, and head office keeps serving', async () => {
    uncaught.length = 0;
    const receipt = `IC1L1-${String(Date.now() % 1_000_000).padStart(6, '0')}`;
    const committedAt = new Date().toISOString(); // one bill: every send is the SAME request (a resend, not a new sale)
    const sale = () => real.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: `ic-${receipt}`, body: {
      saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: committedAt.slice(0, 10), committedAt,
      totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    } });
    const kept = async (): Promise<number> => (await platform.query(
      "SELECT count(*)::int AS n FROM event_ledger WHERE tenant_id = $1 AND payload->>'receiptNumber' = $2", [TENANT, receipt],
    )).rows[0].n as number;

    // The ledger is held so the API's write WAITS inside its transaction; the database then ends that session.
    const blocker = await platform.connect();
    let reply: Awaited<ReturnType<typeof sale>>;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE event_ledger IN EXCLUSIVE MODE');
      const pending = sale();
      let ended = 0;
      for (let i = 0; i < 100 && ended === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const r = await platform.query(
          "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE usename = $1 AND datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO event_ledger%'",
          [CONNECTED_APP_ROLE],
        );
        ended = r.rows.length;
      }
      expect(ended).toBeGreaterThan(0);
      reply = await pending;
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(reply.status).toBe(500);
    const body = (reply.body as { error: { code: string; wasItSaved: string; whatHappened: string } }).error;
    expect(body.code).toBe('database_ended_transaction');
    expect(body.wasItSaved).toBe('not_saved');
    expect(body.whatHappened).toMatch(/The database ended this transaction before it finished .* nothing in it was saved/);
    expect(await kept()).toBe(0); // all-or-nothing: the sale is not in head office's books

    await new Promise((r) => setTimeout(r, 300));
    expect(uncaught).toEqual([]); // the process never saw it: before r22 this exited the API

    // Head office keeps serving: a read answers, and the same sale re-sent under the same key is kept — exactly once.
    const health = await real.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER });
    expect(health.status).toBe(200);
    const again = await sale();
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(await kept()).toBeGreaterThanOrEqual(1);
    const once = await kept();
    const replay = await sale();
    expect(replay.status).toBeLessThan(300);
    expect(await kept()).toBe(once);
  }, 60_000);
});
