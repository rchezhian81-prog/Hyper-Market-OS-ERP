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
 * **Round 13 (verifier D6, probe P5 · PF-06 · OB-54 · hard rule #10): a second, DIFFERENT late answer for a card/UPI
 * attempt is a visible conflict; an attempt head office already holds for one store cannot be claimed by another.**
 *
 * Late answers were de-duplicated on the attempt id alone: a different second answer got 200 `alreadyRecorded` and was
 * dropped. On the real API (in memory, and with DATABASE_URL on real PostgreSQL):
 *   • the same late answer again (a fresh key) is 200 `alreadyRecorded`; the same request under its key replays;
 *   • a DIFFERENT one is 409 `late_answer_conflicts`, recorded on the exception list beside the standing answer (which
 *     fields differ, who relayed it), the row is flagged; re-sent, it is refused again and listed once;
 *   • two different answers at the same moment: one lands, the other is a recorded conflict — never silently dropped;
 *   • P5: an attempt head office holds ONLY as another store's late answer is that store's — store-1's computer cannot
 *     answer it again or raise a no-answer for it (403 by name, on the refusal list), nothing recorded.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const DAY = '2026-10-07';
const noAnswer = (attemptId: string) => ({
  attemptId, laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY,
  recordedAt: `${DAY}T05:00:30.000Z`, recordedBy: 'u-cash',
});
const lateAnswer = (attemptId: string, over: Record<string, unknown> = {}) => ({
  laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY, outcome: 'approved',
  answeredBy: 'u-cash', approvedBy: 'u-mgr', approvalId: 'apr-1', answeredAt: `${DAY}T09:00:00.000Z`, ...over,
});
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
interface Listing {
  exceptions: { attemptId: string; storeId: string; lateAnswerConflicts: unknown[] }[];
  flagged: string[];
  lateAnswers: { attemptId: string; storeId: string; outcome: string }[];
  lateAnswerConflicts: { attemptId: string; differs: string[]; relayedBy: string; standing: { outcome: string }; offered: { outcome: string } }[];
}

describe.each(backings)('Round 13 — a second, different late answer is a visible conflict — on $name', ({ harness }) => {
  it('same answer collapses, a different one is a recorded 409 conflict, a race keeps both visible, and another store\'s held attempt cannot be claimed', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box-a', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-box-b', 'store_computer', ['store-2']);
    await h.provisionRole(T, 'u-acct', 'accountant');
    const call = (path: string, userId: string, body: unknown, key?: string) => h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key ?? `k-${randomUUID()}`, body });
    const list = async () => (await h.request({ method: 'GET', path: '/v1/finance/payment-exceptions', userId: 'u-acct', tenantId: T })).body as Listing;
    const late = (id: string) => `/v1/finance/payment-exceptions/${id}/late-answer/synced`;

    expect((await call('/v1/finance/payment-exceptions/att-A1/no-answer/synced', 'u-box-a', noAnswer('att-A1'))).status).toBe(202);
    const first = await call(late('att-A1'), 'u-box-a', lateAnswer('att-A1'), 'la-1');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    // The same request under its key replays; the same answer under a fresh key is alreadyRecorded.
    expect((await call(late('att-A1'), 'u-box-a', lateAnswer('att-A1'), 'la-1')).body).toEqual(first.body);
    const same = await call(late('att-A1'), 'u-box-a', lateAnswer('att-A1'));
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ alreadyRecorded: true });

    // A DIFFERENT answer: 409 by name, recorded beside the standing one; re-sent, refused again and listed once.
    const other = await call(late('att-A1'), 'u-box-a', lateAnswer('att-A1', { outcome: 'declined', answeredAt: `${DAY}T09:05:00.000Z` }));
    expect([other.status, codeOf(other)], JSON.stringify(other.body)).toEqual([409, 'late_answer_conflicts']);
    expect((other.body as { error: { whatHappened: string } }).error.whatHappened).toContain('differs in outcome, answeredAt');
    expect((await call(late('att-A1'), 'u-box-a', lateAnswer('att-A1', { outcome: 'declined', answeredAt: `${DAY}T09:05:00.000Z` }))).status).toBe(409);
    let l = await list();
    expect(l.lateAnswers.map((a) => [a.attemptId, a.storeId, a.outcome])).toEqual([['att-A1', 'store-1', 'approved']]);
    expect(l.lateAnswerConflicts.map((c) => [c.attemptId, c.differs, c.relayedBy, c.standing.outcome, c.offered.outcome])).toEqual([['att-A1', ['outcome', 'answeredAt'], 'u-box-a', 'approved', 'declined']]);
    expect(l.exceptions.find((e) => e.attemptId === 'att-A1')!.lateAnswerConflicts).toHaveLength(1);
    expect(l.flagged).toContain('att-A1');

    // A race: two different answers at the same moment — one lands, the other is a recorded conflict.
    expect((await call('/v1/finance/payment-exceptions/att-A2/no-answer/synced', 'u-box-a', noAnswer('att-A2'))).status).toBe(202);
    const [ra, rb] = await Promise.all([
      call(late('att-A2'), 'u-box-a', lateAnswer('att-A2', { outcome: 'approved' })),
      call(late('att-A2'), 'u-box-a', lateAnswer('att-A2', { outcome: 'declined' })),
    ]);
    expect([ra.status, rb.status].sort(), JSON.stringify([ra.body, rb.body])).toEqual([202, 409]);
    l = await list();
    const landed = l.lateAnswers.find((a) => a.attemptId === 'att-A2')!;
    const conflict = l.lateAnswerConflicts.filter((c) => c.attemptId === 'att-A2');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.standing.outcome).toBe(landed.outcome);
    expect(conflict[0]!.offered.outcome).not.toBe(landed.outcome);

    // P5: box B (store-2) relays a late answer for an attempt head office does not yet hold: it is held for store-2.
    expect((await call(late('att-A9'), 'u-box-b', lateAnswer('att-A9'))).status).toBe(202);
    // Store-1's computer cannot answer it again or raise a no-answer for it: refused by name, on the refusal list.
    for (const [what, path, body] of [['late answer', late('att-A9'), lateAnswer('att-A9', { outcome: 'declined' })], ['no-answer', '/v1/finance/payment-exceptions/att-A9/no-answer/synced', noAnswer('att-A9')]] as const) {
      const r = await call(path, 'u-box-a', body);
      expect([r.status, codeOf(r)], what).toEqual([403, 'store_computer_record_names_another_store']);
    }
    const refusals = ((await h.request({ method: 'GET', path: '/v1/store-computers/refusals', userId: 'u-owner', tenantId: T })).body as { refusals: { userId: string; field?: string; namedStore?: string }[] }).refusals;
    expect(refusals.filter((r) => r.userId === 'u-box-a').map((r) => [r.field, r.namedStore])).toEqual([['record.attemptId', 'store-2'], ['record.attemptId', 'store-2']]);
    l = await list();
    expect(l.lateAnswers.filter((a) => a.attemptId === 'att-A9').map((a) => a.storeId)).toEqual(['store-2']);
    expect(l.exceptions.some((e) => e.attemptId === 'att-A9')).toBe(false);
  }, 60_000);
});
