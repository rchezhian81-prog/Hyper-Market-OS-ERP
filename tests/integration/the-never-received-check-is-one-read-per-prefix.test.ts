import { describe, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { unbankedAboveBanked, atRiskBelowBanked } from '../support/never-received-cost';

/**
 * Verifier r20 (cost) on PostgreSQL — the never-received check of one health read, with 8 lanes, COUNTED (no read one bill
 * at a time; one indexed read per prefix for at-risk numbers below banked) and TIMED (well under 200 ms; probe
 * zz-v20-lostcost took 1.9–2.8 s). The memory leg and the method are in tests/performance/the-never-received-check-reads-
 * by-range.test.ts (the performance suite runs without a database).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('verifier r20 (cost): the never-received check reads by range (PostgreSQL: counted and timed)', () => {
  const onPg = async (run: (store: EventStore, T: string) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
    const store = new SqlEventStore(pgPoolClient(pool));
    const T = randomUUID();
    await store.registerTenant(T, 'perf');
    try { await run(store, T); } finally { await pool.end(); }
  };
  it('8 lanes x 500 unbanked: one health read well under 200 ms, no per-number read', async () => { await onPg((s, T) => unbankedAboveBanked(s, T, true)); }, 120_000);
  it('8 lanes x 500 at-risk below banked: one indexed read per prefix, well under 200 ms', async () => { await onPg((s, T) => atRiskBelowBanked(s, T, true)); }, 120_000);
});
