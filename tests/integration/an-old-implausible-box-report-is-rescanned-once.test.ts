import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { startRealCloud } from '../support/real-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { InMemorySnapshotStore, SqlSnapshotStore, type SnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName, bankedReceiptCounts } from '../../services/api/src/adapters';

/**
 * **Verifier r21 (cost) — one store computer report kept before head office judged reports (an implausible "through
 * 10,500" from an old release) no longer makes every store-pack build re-read the WHOLE box-health stream for ever.** The
 * highest plausible count per store and prefix is snapshotted; the stream is read once, then only the reports since.
 *
 *   1. through the store-pack route (memory): with 1,200 box reports kept, the first build reads them all; the next build
 *      reads only a short tail (at most a few hundred), and both give the same `bankedThrough` — never the implausible count;
 *   2. the counts above today's cap are KEPT in the snapshot and re-judged: once head office has banked enough that 10,500 is
 *      within banked + 10,000, the pack folds it — from the snapshot, without a full re-read;
 *   3. on PostgreSQL with the durable snapshot store: a SECOND process (a fresh store over the same database) reads only
 *      the tail — the rescan happened once, not once per process;
 *   4. found by (3), through the PRODUCTION API on PostgreSQL: the box-health high-water's snapshot keys held a NUL
 *      separator, which jsonb refuses — once a store's box had sent 64+ reports, EVERY store-pack build for that store
 *      failed (500, "unsupported Unicode escape sequence"). With 80 reports kept, the pack now builds, twice.
 */

const OWNER = 'u-owner';
const S1 = 'S1';
const P = 'S1L1-';
const pad = (n: number): string => String(n).padStart(6, '0');
const BOX = streamName(STREAM.org, 'store-computer-health');
const AT = new Date(Date.now() - 3_600_000).toISOString();

/** The store, counting how many box-health events each read returns. */
function counting(inner: EventStore): { store: EventStore; read: () => number; reset: () => void } {
  let n = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'readStream') {
        return async (...args: Parameters<EventStore['readStream']>) => {
          const out = await target.readStream(...args);
          if (args[1] === BOX) n += out.length;
          return out;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { store, read: () => n, reset: () => { n = 0; } };
}

const reportEvent = (T: string, i: number, through: number) => {
  const at = new Date(Date.parse(AT) + i * 1_000).toISOString();
  return { stream: BOX, event: makeEvent({
    id: `r21-box-${T}-${i}`, type: 'StoreComputerHealthReported', occurredAt: at, idempotencyKey: `r21-box-${T}-${i}`, source: 'tests',
    payload: {
      storeId: S1, observedAt: at, receivedAt: at, reportedBy: 'u-box', clockAheadCorrected: false, tills: [],
      disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 }, queue: { unsent: 0, deadLettered: 0 },
      receiptNumbersIssued: [{ prefix: P, through, soldThrough: Math.min(through, 30) }],
    },
  }) };
};
async function keepReports(store: EventStore, T: string): Promise<void> {
  // The old release's implausible report first, then 1,200 ordinary reports (through 31..35).
  // Two kept before judging: 10,500 (plausible once head office banks 500 more) and 999,999 (never) — so the running
  // maximum stays implausible and the snapshot's kept above-cap counts are what must be re-judged.
  await store.appendBatch(T, [reportEvent(T, 0, 10_500), reportEvent(T, 5_000, 999_999)]);
  for (let i = 1; i <= 1_200; i += 400) await store.appendBatch(T, Array.from({ length: 400 }, (_, j) => reportEvent(T, i + j, 31 + ((i + j) % 5))));
}
const bankDirect = async (store: EventStore, T: string, from: number, to: number): Promise<void> => {
  for (let n = from; n <= to; n += 500) {
    await store.appendBatch(T, Array.from({ length: Math.min(500, to - n + 1) }, (_, j) => {
      const rn = `${P}${pad(n + j)}`;
      return { stream: STREAM.sales, event: makeEvent({ id: `receipt-${rn}`, type: 'ReceiptNumberIssued', occurredAt: AT, idempotencyKey: `receipt-${T}-${rn}`, source: 'tests', payload: { receiptNumber: rn, saleId: `S-${rn}` } }) };
    }));
  }
};

describe('verifier r21 (cost): an old implausible box report is re-read once, not on every pack build (memory, through the pack route)', () => {
  it('the first build reads the stream, later builds read only the tail, and the answer is the same', async () => {
    const c = counting(new InMemoryEventStore());
    const h: ApiHarness = apiHarness({ store: c.store });
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) => h.request({ method, path, userId: OWNER, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
      expect((await call('POST', `/v1/org/nodes/${id}`, body)).status).toBeLessThan(300);
    }
    expect((await call('POST', `/v1/stores/${S1}/settings`, { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 })).status).toBeLessThan(300);
    expect((await call('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, { prefix: P })).status).toBe(201);
    await bankDirect(c.store, T, 1, 30);
    await keepReports(c.store, T);
    const bankedThrough = async (): Promise<number | undefined> => {
      const pack = await call('GET', `/v1/store-packs/${S1}`);
      expect(pack.status).toBe(200);
      return ((pack.body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries ?? []).find((s) => s.prefix === P)?.bankedThrough;
    };
    c.reset();
    expect(await bankedThrough()).toBe(35); // never 10,500 (above banked 30 + 10,000)
    const first = c.read();
    c.reset();
    expect(await bankedThrough()).toBe(35);
    const second = c.read();
    c.reset();
    expect(await bankedThrough()).toBe(35);
    const third = c.read();
    // The running maximum's own fold reads its (fenced) tail too; what matters is the full re-read is gone.
    expect(first).toBeGreaterThanOrEqual(1_201);
    expect(second).toBeLessThan(700);
    expect(third).toBeLessThan(700);
    expect(second).toBeLessThan(first / 2);

    // Re-judged from the snapshot: banked reaches 600, so 10,500 is now within 600 + 10,000 — the pack folds it.
    await bankDirect(c.store, T, 31, 600);
    c.reset();
    expect(await bankedThrough()).toBe(10_500);
    expect(c.read()).toBeLessThan(700);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r21 (cost): the rescan happens once, even across processes (PostgreSQL, durable snapshots)', () => {
  it('a second process over the same database reads only the tail', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    try {
      const sql = pgPoolClient(pool);
      const T = randomUUID();
      const base = new SqlEventStore(sql);
      await base.registerTenant(T, 'tests/r21-cost');
      const issue = makeEvent({ id: `iss-${T}`, type: 'TillReceiptPrefixIssued', occurredAt: AT, idempotencyKey: `iss-${T}`, source: 'tests', payload: { storeId: S1, tillId: 'lane-1', prefix: P, version: 1, setBy: OWNER, setAt: AT } });
      await base.append(T, streamName(STREAM.org, 'till-receipt-prefixes'), issue);
      await bankDirect(base, T, 1, 30);
      await keepReports(base, T);
      const snapshots: SnapshotStore = new SqlSnapshotStore(sql);
      const one = counting(new SqlEventStore(sql));
      expect((await bankedReceiptCounts(one.store, T, { snapshots, storeId: S1 })).get(P)).toBe(35);
      expect(one.read()).toBeGreaterThanOrEqual(1_201);
      // "Another process": a fresh store over the same database, the same durable snapshots.
      const two = counting(new SqlEventStore(sql));
      expect((await bankedReceiptCounts(two.store, T, { snapshots, storeId: S1 })).get(P)).toBe(35);
      // The plausible re-scan (1,202 reports) is gone: only its short tail is read. The running maximum beside it is fenced
      // (verifier r19 HW-1): while ANY transaction elsewhere on the database cluster is still open — another suite on a
      // shared CI database — it honestly re-reads its own tail, so that fold's reads are not part of what this proves.
      expect(two.read()).toBeLessThan(one.read() - 900);
      // The same answer as a cold read with no snapshot at all.
      expect((await bankedReceiptCounts(new SqlEventStore(sql), T, { snapshots: new InMemorySnapshotStore(), storeId: S1 })).get(P)).toBe(35);
    } finally {
      await pool.end();
    }
  }, 180_000);
});

describe.skipIf(DATABASE_URL === undefined)('verifier r21: the store pack still builds after many box reports (PostgreSQL, production API)', () => {
  it('80 box reports kept, then the store pack builds — twice (the snapshot is saved and read back)', async () => {
    const real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    try {
      const T = real.tenantId;
      const send = async (method: 'GET' | 'POST', path: string, sub: string, body?: unknown, branchId?: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`${real.baseUrl}${path}`, {
          method, headers: {
            authorization: `Bearer ${TEST_IDP.issue({ sub, tenantId: T, ...(branchId === undefined ? {} : { branchId }) })}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `k-${randomUUID()}` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
      };
      for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'Store One', parentId: 'C1', companyId: 'C1' }]] as const) {
        expect((await send('POST', `/v1/org/nodes/${id}`, OWNER, body)).status).toBeLessThan(300);
      }
      expect((await send('POST', `/v1/stores/${S1}/settings`, OWNER, { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30 })).status).toBeLessThan(300);
      expect((await send('POST', `/v1/stores/${S1}/tills/lane-1/receipt-prefix`, OWNER, { prefix: P })).status).toBe(201);
      await real.grant('u-box', 'store_computer', undefined, [S1]);
      for (let i = 0; i < 80; i += 1) {
        const r = await send('POST', '/v1/store-computers/health-reports', 'u-box', {
          observedAt: new Date(Date.now() - (80 - i) * 1_000).toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000 + i, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
          queue: { unsent: 0, deadLettered: 0 }, tills: [], receiptNumbersIssued: [{ prefix: P, through: 5 + (i % 3), soldThrough: 0, unsent: { count: 0 } }],
        }, S1);
        expect(r.status, `report ${i}: ${JSON.stringify(r.body).slice(0, 600)}`).toBe(200);
      }
      for (let k = 0; k < 2; k += 1) {
        const pack = await send('GET', `/v1/store-packs/${S1}`, OWNER);
        expect(pack.status, JSON.stringify(pack.body).slice(0, 300)).toBe(200);
        const series = ((pack.body as { sections: { receiptSeries?: { prefix: string; bankedThrough: number }[] } }).sections.receiptSeries ?? []).find((x) => x.prefix === P);
        expect(series?.bankedThrough).toBe(7); // the highest count the box gave (a voided bill keeps its number)
      }
    } finally {
      await real.stop();
    }
  }, 180_000);
});
