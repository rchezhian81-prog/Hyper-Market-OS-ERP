import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { TEST_PACK_KEY } from '../support/api-harness';
import { databaseSessionOptions } from '../../services/api/src/main';
import { HIGH_WATER_WAIT_WARN_SECONDS } from '../../services/platform/src/observed-health';

/**
 * **Verifier r20 HW-2 (P-08) — a transaction left open anywhere on the database server can no longer stall the bill-number
 * high-water INVISIBLY, and the API's own sessions cannot leave one open for long.**
 *
 * The high-water snapshot advances only past a visibility fence every transaction below which has finished (r19 HW-1).
 * Transaction ids are cluster-wide, so ONE long-open write transaction — in any database on the server — holds the fence:
 * the count stays right but re-reads every bill since, slower and slower, and nothing said so (probe zz-v20-fence E).
 * Through the REAL production API on PostgreSQL (startApi, the application role, over HTTP). (Each open transaction here is
 * held for as short a time as the proof allows: transaction ids are cluster-wide, so while one is open every other test's
 * fence on the same server waits too — exactly the effect being proved.)
 *
 *   1. the API says at boot how long one of its sessions may sit idle inside an open transaction
 *      (`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, default one minute), and the same session options really end such a session;
 *   2. a write transaction held open elsewhere: within HIGH_WATER_WAIT_WARN_SECONDS nothing is raised (a fence normally
 *      settles in milliseconds — P-03); past it, the owner's health shows `bill_number_high_water` DEGRADED, "bill-number
 *      high-water is waiting on an open database transaction since …", and the shop's summary names it; the bill count is
 *      still right meanwhile;
 *   3. the transaction ends: the next read clears it by itself;
 *   4. a transaction opened with the API's own session options and left idle is ended by the database, and the fence
 *      settles without anybody acting.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = 'u-owner';
const pad = (n: number): string => String(n).padStart(6, '0');

interface Component { name: string; status: string; detail: string; evidence?: Record<string, unknown> }
interface Observed { health: { summary: string; components: Component[] } }

describe.skipIf(DATABASE_URL === undefined)('verifier r20 HW-2: a stalled bill-number fence is said, and bounded (PostgreSQL, production API)', () => {
  let real: RealCloud;
  let other: Pool;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY, env: { DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000' } });
    other = new Pool({ connectionString: DATABASE_URL, max: 4 });
  }, 180_000);
  afterAll(async () => { await other?.end(); await real?.stop(); });

  const observed = async (): Promise<Observed> => {
    const r = await real.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: OWNER });
    expect(r.status).toBe(200);
    return r.body as Observed;
  };
  const fence = async (): Promise<Component | undefined> => (await observed()).health.components.find((c) => c.name === 'bill_number_high_water');
  let sold = 0;
  const sell = async (): Promise<void> => {
    sold += 1;
    const receipt = `HW2L1-${pad(sold)}`;
    const r = await real.request({ method: 'POST', path: '/v1/sales', userId: OWNER, idempotencyKey: `hw2-${receipt}`, body: {
      saleId: `S-${receipt}`, receiptNumber: receipt, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
      totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000 }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    } });
    expect(r.status).toBe(202);
  };
  const holdOpen = async (pool: Pool): Promise<PoolClient> => {
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('SELECT pg_current_xact_id()'); // a write transaction id: what holds the fence back cluster-wide
    return c;
  };

  it('the API states its idle-in-transaction limit at boot, and those session options really end an idle transaction', async () => {
    expect(real.said.join('\n')).toMatch(/a session idle inside an open transaction is ended after 60000 ms \(idle_in_transaction_session_timeout\)/);
    expect(databaseSessionOptions(undefined)).toEqual({ idleInTransactionMs: 60_000, options: '-c idle_in_transaction_session_timeout=60000' });
    const short = new Pool({ connectionString: DATABASE_URL, max: 1, options: databaseSessionOptions('300').options });
    short.on('error', () => { /* the database ending the idle session is the point */ });
    try {
      const c = await short.connect();
      c.on('error', () => { /* expected: terminated by the server */ });
      try {
        expect((await c.query<{ idle_in_transaction_session_timeout: string }>('SHOW idle_in_transaction_session_timeout')).rows[0]!.idle_in_transaction_session_timeout).toBe('300ms');
        await c.query('BEGIN');
        await c.query('SELECT pg_current_xact_id()');
        await new Promise((r) => setTimeout(r, 900));
        await expect(c.query('SELECT 1')).rejects.toThrow(/not queryable|idle-in-transaction|terminat/i);
      } finally {
        c.release(true);
      }
    } finally {
      await short.end();
    }
  }, 60_000);

  it('a transaction held open elsewhere is said once it has waited past the line, and clears when it ends', async () => {
    await sell();
    expect(await fence()).toBeUndefined();
    const blocker = await holdOpen(other);
    try {
      for (let i = 0; i < 3; i += 1) await sell();
      // Seen waiting — but a fence normally settles in milliseconds, so nothing is raised yet (P-03).
      expect(await fence()).toBeUndefined();
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      try {
        vi.setSystemTime(Date.now() + (HIGH_WATER_WAIT_WARN_SECONDS + 60) * 1000);
        await sell();
        const o = await observed();
        const c = o.health.components.find((x) => x.name === 'bill_number_high_water');
        expect(c?.status).toBe('degraded');
        expect(c?.detail).toMatch(/^bill-number high-water is waiting on an open database transaction since \d{4}-\d{2}-\d{2}T/);
        expect(c?.detail).toMatch(/still counts every bill number correctly/);
        expect(Number(c?.evidence?.['waitingSeconds'])).toBeGreaterThanOrEqual(HIGH_WATER_WAIT_WARN_SECONDS);
        expect(o.health.summary).toMatch(/bill-number high-water is waiting on an open database transaction/);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    // It ended: the next read clears it by itself.
    expect(await fence()).toBeUndefined();
  }, 120_000);

  it('a transaction left idle with the API\'s own session options is ended by the database, and the fence settles by itself', async () => {
    const own = new Pool({ connectionString: DATABASE_URL, max: 1, options: databaseSessionOptions('1000').options });
    own.on('error', () => { /* the database ends it — the point */ });
    try {
      const c = await own.connect();
      c.on('error', () => { /* expected */ });
      await c.query('BEGIN');
      await c.query('SELECT pg_current_xact_id()');
      await sell();
      expect(await fence()).toBeUndefined(); // seen waiting from now (not yet past the line)
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      try {
        await new Promise((r) => setTimeout(r, 1_600)); // the database ends the idle session after 1 s
        vi.setSystemTime(Date.now() + (HIGH_WATER_WAIT_WARN_SECONDS + 60) * 1000);
        await sell();
        expect(await fence()).toBeUndefined(); // settled by itself — nobody had to act
      } finally {
        vi.useRealTimers();
      }
      c.release(true);
    } finally {
      await own.end();
    }
  }, 60_000);
});
