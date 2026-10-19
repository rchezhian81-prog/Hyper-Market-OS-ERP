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
 * **OB-55 / OB-69 — two provider answers for one card/UPI payment arriving at the same moment never lose one silently
 * (hard rule #10), and head office refuses card-like references on every payment-exception relay (hard rule #3, defence in
 * depth).** Real routes through the real pipeline, in memory and — with DATABASE_URL — on real PostgreSQL:
 *
 *   • RACE, different answers: `paid: true` and `paid: false` relayed for one attempt at once — exactly one stands (201), the
 *     other is refused 409 `resolution_conflicts` AND recorded on the item's `conflicts` (GET /v1/finance/payment-exceptions
 *     lists it as flagged). Repeated over several attempts so the race really happens. The same losing answer re-sent is
 *     refused again and recorded once; the winner's answer re-sent is `alreadyResolved`.
 *   • RACE, the same answer: both succeed — one 201, one 200 `alreadyResolved` — and no conflict is recorded.
 *   • CARD DATA: a no-answer relay, a late-answer relay and a day close whose carried payment has a card-number-like
 *     reference are each refused 422 `provider_ref_not_a_token` — nothing of them is kept (no item, no late answer, no close).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const DAY = '2026-10-07';
/** A Luhn-valid test card number, built at run time (never a real card). */
const CARD_LIKE = ['4111', '1111', '1111', '1111'].join('');

interface Row { attemptId: string; state: string; resolution: { paid: boolean } | null; conflicts: { standing: { paid: boolean }; offered: { paid: boolean; via: string } }[] }
interface ExceptionList { exceptions: Row[]; open: number; flagged: string[]; lateAnswers: unknown[] }

describe.each(backings)('payment-exception answers race, and card data is refused — on $name', ({ harness }) => {
  const setup = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const list = async () => (await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as ExceptionList;
    const noAnswer = (attemptId: string, extra: Record<string, unknown> = {}) => call('POST', `/v1/finance/payment-exceptions/${attemptId}/no-answer/synced`, 'u-box', {
      attemptId, laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 50_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY,
      recordedAt: `${DAY}T05:00:30.000Z`, recordedBy: 'u-lanecash', storeId: 'store-1', ...extra,
    });
    const resolved = (attemptId: string, paid: boolean) => call('POST', `/v1/finance/payment-exceptions/${attemptId}/resolved/synced`, 'u-box', { paid, detail: paid ? 'captured' : 'declined' });
    return { h, T, call, list, noAnswer, resolved };
  };

  it('two DIFFERENT answers at once: one stands, the other is a visible conflict — never silently dropped', async () => {
    const { list, noAnswer, resolved } = await setup();
    const attempts = ['PAY-r1', 'PAY-r2', 'PAY-r3', 'PAY-r4', 'PAY-r5'];
    for (const a of attempts) expect((await noAnswer(a)).status).toBe(202);
    for (const a of attempts) {
      const [yes, no] = await Promise.all([resolved(a, true), resolved(a, false)]);
      // Exactly one lands; the other is refused by name — never two 201s.
      expect([yes.status, no.status].sort(), JSON.stringify([yes.body, no.body])).toEqual([201, 409]);
      const loser = yes.status === 409 ? yes : no;
      expect((loser.body as { error: { code: string } }).error.code).toBe('resolution_conflicts');
    }
    let l = await list();
    expect(l.open).toBe(0);
    for (const a of attempts) {
      const row = l.exceptions.find((e) => e.attemptId === a)!;
      expect(row.resolution).not.toBeNull();
      // The losing answer is on the item's conflicts, the standing one beside it.
      expect(row.conflicts).toHaveLength(1);
      expect(row.conflicts[0]!.standing.paid).toBe(row.resolution!.paid);
      expect(row.conflicts[0]!.offered).toMatchObject({ paid: !row.resolution!.paid, via: 'store_computer' });
      expect(l.flagged).toContain(a);
    }
    // Idempotent replay: the winner's answer again is a no-op; the loser's again is refused again and recorded once.
    const row1 = l.exceptions.find((e) => e.attemptId === 'PAY-r1')!;
    const again = await resolved('PAY-r1', row1.resolution!.paid);
    expect(again).toMatchObject({ status: 200, body: { alreadyResolved: true } });
    expect((await resolved('PAY-r1', !row1.resolution!.paid)).status).toBe(409);
    l = await list();
    expect(l.exceptions.find((e) => e.attemptId === 'PAY-r1')!.conflicts).toHaveLength(1);
    expect(l.exceptions.find((e) => e.attemptId === 'PAY-r1')!.resolution!.paid).toBe(row1.resolution!.paid);
  }, 60_000);

  it('the SAME answer twice at once: one records it, the other is told it already stands — no conflict', async () => {
    const { list, noAnswer, resolved } = await setup();
    expect((await noAnswer('PAY-s1')).status).toBe(202);
    const both = await Promise.all([resolved('PAY-s1', true), resolved('PAY-s1', true)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(both.find((r) => r.status === 200)!.body).toMatchObject({ alreadyResolved: true, resolution: { paid: true } });
    const row = (await list()).exceptions.find((e) => e.attemptId === 'PAY-s1')!;
    expect(row).toMatchObject({ state: 'resolved_paid', conflicts: [] });
  }, 60_000);

  it('a card-like reference is refused on the no-answer relay, the late-answer relay and a day close\'s carried payments — nothing kept', async () => {
    const { h, T, call, list, noAnswer } = await setup();
    // No-answer relay: a card-like bill reference, and a card-like attempt id.
    const byBill = await noAnswer('PAY-c1', { billRef: CARD_LIKE });
    expect(byBill.status).toBe(422);
    expect((byBill.body as { error: { code: string } }).error.code).toBe('provider_ref_not_a_token');
    const byId = await noAnswer(CARD_LIKE);
    expect(byId.status).toBe(422);
    expect((await list()).exceptions).toEqual([]);

    // Late-answer relay: a card-like bill reference is refused; a clean one is recorded (the route works).
    const late = (attemptId: string, billRef: string) => call('POST', `/v1/finance/payment-exceptions/${attemptId}/late-answer/synced`, 'u-box', {
      laneId: 'lane-1', billRef, kind: 'card', amountMinor: 20_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY, outcome: 'approved',
      answeredBy: 'u-lanecash', approvedBy: 'u-mgr', approvalId: 'apr-1', answeredAt: `${DAY}T09:00:00.000Z`, storeId: 'store-1',
    });
    const lateCard = await late('PAY-l1', CARD_LIKE);
    expect(lateCard.status).toBe(422);
    expect((lateCard.body as { error: { code: string } }).error.code).toBe('provider_ref_not_a_token');
    expect((await late(CARD_LIKE, 'B-l2')).status).toBe(422);
    expect((await list()).lateAnswers).toEqual([]);
    expect((await late('PAY-l3', 'B-l3')).status).toBe(202);
    expect((await list()).lateAnswers).toHaveLength(1);

    // A day close carrying a payment whose reference is card-like: refused whole — no close, no exception kept.
    const close = (dayCloseId: string, billRef: string) => call('POST', `/v1/pos/day-close/${dayCloseId}/synced`, 'u-box', {
      dayCloseId, storeId: 'store-1', tradingDay: DAY, closedBy: 'u-mgr', closedAt: '2026-10-08T03:00:00.000Z', locked: true,
      carriedForward: {
        approvalId: 'apr-x', approvedBy: 'u-owner', reason: 'provider down',
        payments: [{ attemptId: `PAY-${dayCloseId}`, laneId: 'lane-1', billRef, kind: 'card', amountMinor: 30_000, askedAt: `${DAY}T05:00:00.000Z`, state: 'no_answer', tradingDay: DAY }],
      },
    });
    const dcCard = await close('dc-card', CARD_LIKE);
    expect(dcCard.status).toBe(422);
    expect((dcCard.body as { error: { code: string } }).error.code).toBe('provider_ref_not_a_token');
    const closes = (await call('GET', '/v1/pos/day-close', 'u-owner')).body as { dayCloses: { dayCloseId: string }[] };
    expect(closes.dayCloses.map((c) => c.dayCloseId)).not.toContain('dc-card');
    expect((await list()).exceptions).toEqual([]);
    // The same close with a proper reference is recorded and carried (the refusal is the card data, nothing else).
    expect((await close('dc-ok', 'B-ok')).status).toBe(202);
    expect((await list()).exceptions.map((e) => e.attemptId)).toEqual(['PAY-dc-ok']);
    // Nothing card-like was written ANYWHERE for this shop — not even the relay's record-owner placement, which once kept
    // a card-like attempt id as its key after the route had refused it (found by the whole-database scan in F1).
    expect(JSON.stringify(await h.store.exportTenant(T))).not.toContain(CARD_LIKE);
  }, 60_000);
});
