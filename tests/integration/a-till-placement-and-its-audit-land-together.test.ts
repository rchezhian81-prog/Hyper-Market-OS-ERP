import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **OB-86 "A" · verifier r18 OB86-1 — an old till's automatic placement and its audit record land TOGETHER.** The placement
 * used to be appended, then its audit record in a second write: a crash between them left a placement with no audit entry
 * for ever (the next read saw the placement and wrote nothing). Now both are one atomic batch. Proved in memory and on
 * PostgreSQL through the real routes, with a write that fails exactly where the audit record is written (probe
 * zz-v18-place): the read fails (500), NOTHING is kept (no placement, no audit), and the next read places the till AND
 * audits it — once; later reads add nothing; two first reads at once keep one placement and one audit record.
 */

const DAY = '2026-10-07';
const PLACE = streamName(STREAM.cash, 'legacy-till-placements', 'v1');
type Res = { status: number; body: unknown };

/** A store whose next write that carries an audit-trail record throws once (a crash at exactly that point). */
function crashingOnAudit(inner: EventStore, armed: { on: boolean }): EventStore {
  return new Proxy(inner, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if ((p === 'appendBatch' || p === 'append') && typeof v === 'function') {
        return async (...args: unknown[]) => {
          const entries = p === 'appendBatch' ? (args[1] as { stream: string }[]) : [{ stream: args[1] as string }];
          if (armed.on && entries.some((e) => e.stream.includes('domain-trail'))) { armed.on = false; throw new Error('simulated crash where the audit record is written'); }
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as EventStore;
}

async function oneStoreWithAnOldTill(h: ApiHarness): Promise<{ T: string; call: (path: string, query?: Record<string, string>) => Promise<Res> }> {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  const post = (path: string, body: unknown) => h.request({ method: 'POST', path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
  expect((await post('/v1/org/nodes/C1', { kind: 'company', name: 'C' })).status).toBeLessThan(300);
  expect((await post('/v1/org/nodes/store-1', { kind: 'branch', name: 's1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
  const old = { movementId: 'cm-old-lane-1', tillId: 'lane-1', kind: 'float_issue', deltaMinor: 100_000, currency: 'INR', custodianId: 'u-cash', tradingDay: DAY, at: `${DAY}T03:00:00.000Z`, relayed: true };
  await h.store.append(T, streamName(STREAM.cash, 'lane-1'), makeEvent({ id: `cash-${old.movementId}`, type: 'CashMovement', occurredAt: old.at, idempotencyKey: `cash-${T}-${old.movementId}`, source: 'api/pos', payload: old }));
  return { T, call: (path, query) => h.request({ method: 'GET', path, userId: 'u-owner', tenantId: T, ...(query === undefined ? {} : { query }) }) };
}

async function crashThenReRead(mk: (s: EventStore) => ApiHarness, base: () => EventStore): Promise<void> {
  const armed = { on: false };
  const h = mk(crashingOnAudit(base(), armed));
  const { T, call } = await oneStoreWithAnOldTill(h);
  const audits = async (): Promise<number> => ((await call('/v1/audit/trail', { action: 'till.legacy.place' })).body as { total: number }).total;
  armed.on = true;
  const crashed = await call('/v1/tills/lane-1/cash', { storeId: 'store-1' });
  expect(crashed.status).toBe(500);
  expect(armed.on).toBe(false); // the crash was hit
  // Nothing half-done: no placement without its audit record.
  expect(await h.store.readStream(T, PLACE)).toHaveLength(0);
  expect(await audits()).toBe(0);
  // The next read places the till AND audits it.
  const again = await call('/v1/tills/lane-1/cash', { storeId: 'store-1' });
  expect(again.status).toBe(200);
  expect((again.body as { balanceMinor: number }).balanceMinor).toBe(100_000);
  expect(await h.store.readStream(T, PLACE)).toHaveLength(1);
  expect(await audits()).toBe(1);
  // Later reads add nothing.
  expect((await call('/v1/tills/lane-1/cash', { storeId: 'store-1' })).status).toBe(200);
  expect(await h.store.readStream(T, PLACE)).toHaveLength(1);
  expect(await audits()).toBe(1);
}

async function twoFirstReadsAtOnce(h: ApiHarness): Promise<void> {
  const { T, call } = await oneStoreWithAnOldTill(h);
  const [a, b] = await Promise.all([call('/v1/tills/lane-1/cash', { storeId: 'store-1' }), call('/v1/tills/lane-1/cash', { storeId: 'store-1' })]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect((a.body as { balanceMinor: number }).balanceMinor).toBe((b.body as { balanceMinor: number }).balanceMinor);
  expect(await h.store.readStream(T, PLACE)).toHaveLength(1);
  expect(((await call('/v1/audit/trail', { action: 'till.legacy.place' })).body as { total: number }).total).toBe(1);
}

describe('OB86-1: a till placement and its audit record land together (memory)', () => {
  it('a crash where the audit is written keeps nothing; the next read places and audits once', async () => {
    await crashThenReRead((s) => apiHarness({ store: s }), () => new InMemoryEventStore());
  }, 60_000);
  it('two first reads at once: one placement, one audit record', async () => { await twoFirstReadsAtOnce(apiHarness()); }, 60_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('OB86-1: a till placement and its audit record land together (PostgreSQL)', () => {
  const withPg = async (run: (sql: ReturnType<typeof pgPoolClient>) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try { await run(pgPoolClient(pool)); } finally { await pool.end(); }
  };
  it('a crash where the audit is written keeps nothing; the next read places and audits once', async () => {
    await withPg((sql) => crashThenReRead((s) => apiHarness({ store: s, idempotency: new SqlIdempotencyStore(sql) }), () => new SqlEventStore(sql)));
  }, 120_000);
  it('two first reads at once, five rounds: one placement, one audit record each time', async () => {
    await withPg(async (sql) => {
      for (let i = 0; i < 5; i += 1) await twoFirstReadsAtOnce(apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }));
    });
  }, 180_000);
});
