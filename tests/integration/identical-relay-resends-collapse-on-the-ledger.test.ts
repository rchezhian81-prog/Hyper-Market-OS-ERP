import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **Two identical re-sends of a card no-answer from the same store computer, at the same moment, collapse into one
 * item — neither caller sees a failure.** (hard rule #10, P-08, §31.1)
 *
 * The store computer re-sends a relay whose reply it lost; the re-send can overlap the original. Both pass the route's
 * "already raised?" check before either has written, and both append the same fixed event (same id, same key). On
 * PostgreSQL the loser used to hit the ledger's event-id constraint and come back 500 ("did it save?" unknown) — the
 * store computer would then keep retrying a record head office already held. Now the event store collapses it: one
 * answer is 202 `recorded`, the other 200 `alreadyRecorded`, and finance lists exactly one item per attempt.
 *
 * Driven through the real route and pipeline, in memory and — with DATABASE_URL — on real PostgreSQL. Both the same
 * request key (a true re-send) and a fresh request key (a re-send after the box lost its own reply bookkeeping) are
 * covered; a later replay of the same request returns the first answer.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 16, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const DAY = '2026-10-07';
/** How many copies of one relay arrive at once — enough that the race genuinely happens on a real pool. */
const RESENDS = 8;
interface ExceptionList { exceptions: { attemptId: string; state: string }[]; open: number }

describe.each(backings)('identical no-answer re-sends at once collapse — on $name', ({ harness }) => {
  const setup = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-acct', 'accountant');
    const body = (attemptId: string) => ({
      attemptId, laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 50_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY,
      recordedAt: `${DAY}T05:00:30.000Z`, recordedBy: 'u-lanecash', storeId: 'store-1',
    });
    const relay = (attemptId: string, key: string) => h.request({
      method: 'POST', path: `/v1/finance/payment-exceptions/${attemptId}/no-answer/synced`, userId: 'u-box', tenantId: T, idempotencyKey: key, body: body(attemptId),
    });
    const list = async () => (await h.request({ method: 'GET', path: '/v1/finance/payment-exceptions', userId: 'u-acct', tenantId: T })).body as ExceptionList;
    return { relay, list };
  };

  it('the SAME request sent twice at once (one key): one 202, the other success — never a 500; one item', async () => {
    const { relay, list } = await setup();
    const attempts = Array.from({ length: 12 }, (_, i) => `PAY-same-${i}`);
    for (const a of attempts) {
      const key = `relay-${a}`;
      const answers = await Promise.all(Array.from({ length: RESENDS }, () => relay(a, key)));
      const statuses = answers.map((r) => r.status);
      expect(statuses.every((s) => s === 200 || s === 202), JSON.stringify(answers.map((r) => r.body))).toBe(true);
      // At most one FRESH 202 — any other 202 is the pipeline replaying that first answer (marked as a replay).
      const fresh202 = answers.filter((r) => r.status === 202 && r.headers['idempotent-replay'] !== 'true');
      expect(fresh202.length).toBeLessThanOrEqual(1);
      for (const r of answers) expect(r.body).toMatchObject({ attemptId: a, recorded: true });
      // A later replay of the same request is answered, too.
      expect([200, 202]).toContain((await relay(a, key)).status);
    }
    const l = await list();
    expect(l.exceptions.map((e) => e.attemptId).sort()).toEqual([...attempts].sort());
    expect(l.open).toBe(attempts.length);
  }, 60_000);

  it('re-sends under FRESH request keys at once: exactly one 202, the rest 200 alreadyRecorded; one item each', async () => {
    const { relay, list } = await setup();
    const attempts = Array.from({ length: 12 }, (_, i) => `PAY-fresh-${i}`);
    for (const a of attempts) {
      const answers = await Promise.all(Array.from({ length: RESENDS }, () => relay(a, `k-${randomUUID()}`)));
      expect(answers.map((r) => r.status).sort(), JSON.stringify(answers.map((r) => r.body))).toEqual([...Array(RESENDS - 1).fill(200), 202]);
      for (const r of answers.filter((x) => x.status === 200)) expect(r.body).toMatchObject({ alreadyRecorded: true });
    }
    const l = await list();
    expect(l.exceptions).toHaveLength(attempts.length);
  }, 60_000);
});
