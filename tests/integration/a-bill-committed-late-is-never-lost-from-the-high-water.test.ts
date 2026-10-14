import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { takeHeldTransactionTurn } from '../support/held-transaction-turn';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlSnapshotStore } from '../../packages/persistence/src/snapshot';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, bankedReceiptCounts, bankedReceiptCountsByFullScan } from '../../services/api/src/adapters';

/**
 * **Verifier r19 HW-1 — a bill whose transaction commits LATE is never lost from the incremental bill-number high-water.**
 * PostgreSQL hands out a ledger position when a row is inserted, not when it commits; the high-water snapshot used to advance
 * over every position more than 256 behind the newest read, so a bill inserted early and committed after 400 others was
 * skipped for ever (the verifier's probe zz-v19-lag: incremental `S2L9-` undefined, full scan 50). Now the snapshot advances
 * only to a VISIBILITY FENCE — a position below which every transaction has finished (`positionFence` / `fenceSettled`):
 *
 *   1. THE PROBE: S2L9-000050 is inserted in an open transaction; 400 other bills commit; the pack is built THREE times
 *      while it is open (none may advance past it); it commits; the next build holds 50 — equal to the full scan.
 *   2. The same through the store's own guarded batch path (the sale's path), held open by a lock wait.
 *   3. A rolled-back late transaction leaves nothing behind and the fence still settles.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const at = '2026-10-12T10:00:00.000Z';
const ev = (T: string, rn: string) => ({
  stream: STREAM.sales,
  event: makeEvent({ id: `receipt-${rn}`, type: 'ReceiptNumberIssued', occurredAt: at, idempotencyKey: `receipt-${T}-${rn}`, source: 'test', payload: { receiptNumber: rn, saleId: `S-${rn}` } }),
});

describe.skipIf(DATABASE_URL === undefined)('HW-1: a late-committing bill is never lost from the high-water (PostgreSQL)', () => {
  // These tests hold a database transaction open on purpose; they take turns with every other such test (see the helper).
  let endTurn: (() => Promise<void>) | undefined;
  beforeAll(async () => { endTurn = await takeHeldTransactionTurn(DATABASE_URL!); }, 1_800_000);
  afterAll(async () => { await endTurn?.(); });
  it('the probe: an open transaction holds an early position while 400 bills commit; three builds; then it lands', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const store = new SqlEventStore(sql);
    const snaps = new SqlSnapshotStore(sql);
    const T = randomUUID();
    try {
      await store.registerTenant(T, 'test');
      const late = await pool.connect();
      try {
        await late.query('BEGIN');
        await late.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
        const e = ev(T, 'S2L9-000050').event;
        // A raw insert (as the verifier's probe does): its position is drawn now, its commit comes later.
        await late.query(
          'INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [e.id, T, STREAM.sales, e.type, e.occurredAt, e.idempotencyKey, e.source, e.version, JSON.stringify(e.payload)],
        );
        for (let i = 1; i <= 400; i += 100) await store.appendBatch(T, Array.from({ length: 100 }, (_, j) => ev(T, `S2L1-${String(i + j).padStart(6, '0')}`)));
        for (let k = 0; k < 3; k += 1) {
          const during = await bankedReceiptCounts(store, T, { snapshots: snaps });
          expect(during.get('S2L1-')).toBe(400);
          expect(during.get('S2L9-')).toBeUndefined(); // not committed yet: not banked
        }
        await late.query('COMMIT');
      } finally {
        late.release();
      }
      const after = await bankedReceiptCounts(store, T, { snapshots: snaps });
      const full = await bankedReceiptCountsByFullScan(store, T);
      expect(full.get('S2L9-')).toBe(50);
      expect(after.get('S2L9-')).toBe(50); // the verifier's probe gave undefined here
      expect(new Map([...after].sort())).toEqual(new Map([...full].sort()));
      // ...and the snapshot moved on: a warm build reads only a short tail.
      await store.appendBatch(T, Array.from({ length: 100 }, (_, j) => ev(T, `S2L1-${String(401 + j).padStart(6, '0')}`)));
      expect((await bankedReceiptCounts(store, T, { snapshots: snaps })).get('S2L1-')).toBe(500);
      const snap = await snaps.load<{ maxima: Record<string, number> }>(T, STREAM.sales, 'receipt-high-water@2:ReceiptNumberIssued');
      expect(snap?.result.state.maxima['S2L9-']).toBe(50);
      expect(snap?.result.watermarkSeq).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it('the store\'s own guarded batch held open by a lock wait, and a rolled-back one', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const store = new SqlEventStore(sql);
    const snaps = new SqlSnapshotStore(sql);
    const T = randomUUID();
    try {
      await store.registerTenant(T, 'test');
      // A blocker holds the guard row, so the sale batch inserts (position drawn) and then WAITS on the guard.
      await store.appendBatch(T, [ev(T, 'S3L1-000001')], { guard: { key: 'hw1-lock', expectedVersion: 0 } });
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
      await blocker.query('SELECT version FROM write_guards WHERE tenant_id = $1 AND key = $2 FOR UPDATE', [T, 'hw1-lock']);
      const waiting = store.appendBatch(T, [ev(T, 'S3L7-000070')], { guard: { key: 'hw1-lock', expectedVersion: 1 } });
      await new Promise((r) => setTimeout(r, 200));
      for (let i = 2; i <= 401; i += 100) await store.appendBatch(T, Array.from({ length: 100 }, (_, j) => ev(T, `S3L1-${String(i + j).padStart(6, '0')}`)));
      for (let k = 0; k < 2; k += 1) expect((await bankedReceiptCounts(store, T, { snapshots: snaps })).get('S3L7-')).toBeUndefined();
      await blocker.query('COMMIT');
      blocker.release();
      await waiting;
      expect((await bankedReceiptCounts(store, T, { snapshots: snaps })).get('S3L7-')).toBe(70);

      // A late transaction that ROLLS BACK: nothing is banked, and the fence still settles (the snapshot moves on).
      const late = await pool.connect();
      await late.query('BEGIN');
      await late.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
      const e = ev(T, 'S3L8-000080').event;
      await late.query(
        'INSERT INTO event_ledger (id, tenant_id, stream, type, occurred_at, idempotency_key, source, version, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [e.id, T, STREAM.sales, e.type, e.occurredAt, e.idempotencyKey, e.source, e.version, JSON.stringify(e.payload)],
      );
      for (let i = 402; i <= 601; i += 100) await store.appendBatch(T, Array.from({ length: 100 }, (_, j) => ev(T, `S3L1-${String(i + j).padStart(6, '0')}`)));
      await bankedReceiptCounts(store, T, { snapshots: snaps });
      await late.query('ROLLBACK');
      late.release();
      const end = await bankedReceiptCounts(store, T, { snapshots: snaps });
      expect(end.get('S3L8-')).toBeUndefined();
      expect(end.get('S3L1-')).toBe(601);
      expect(new Map([...end].sort())).toEqual(new Map([...await bankedReceiptCountsByFullScan(store, T)].sort()));
    } finally {
      await pool.end();
    }
  }, 120_000);
});
