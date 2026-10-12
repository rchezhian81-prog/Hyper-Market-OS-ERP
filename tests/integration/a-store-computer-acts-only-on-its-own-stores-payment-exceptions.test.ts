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
 * **OB-54 round 12 (owner decision "A", 11 Oct 2026 · OB-69 · PF-06 · hard rules #3 #10): a store computer acts only on
 * its OWN store's card/UPI payment exceptions.**
 *
 * The three payment-exception relays (`/v1/finance/payment-exceptions/:attemptId/{no-answer,late-answer,resolved}/synced`,
 * under `till.dayclose.sync`) used to name the store only in the body, or not at all: box B (store-2) could resolve store-1's
 * open payment as paid, and a no-answer that named no store was kept with store "" — so a branch-scoped tender figure
 * dropped it. On the real API (in memory, and with DATABASE_URL on real PostgreSQL):
 *
 *   • box A (store-1) and box B (store-2) each relay a no-answer that names NO store — each is stamped server-side with
 *     its credential's store (on the stamp list at `storeId`), and the branch-scoped tender figures carry each at its store;
 *   • box B cannot resolve, late-answer or re-raise store-1's attempt, nor raise one naming store-1 — each 403 by name
 *     (`record.attemptId` for the held record's own store, `body.storeId` for the named one), nothing recorded, each on
 *     the refusal list once (a re-sent refusal collapses);
 *   • box A resolves its own attempt; a replay under its key is the same answer;
 *   • a person's relay that names no store is not read (400) — a payment exception is never kept with store "".
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
const S1 = 'store-1'; const S2 = 'store-2';
const BOX_A = 'u-box-a'; const BOX_B = 'u-box-b';

const noAnswer = (attemptId: string, over: Record<string, unknown> = {}) => ({
  attemptId, laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY,
  recordedAt: `${DAY}T05:00:30.000Z`, recordedBy: 'u-cash', ...over,
});
const lateAnswer = (over: Record<string, unknown> = {}) => ({
  laneId: 'lane-1', billRef: 'B-att-A1', kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY, outcome: 'approved',
  answeredBy: 'u-cash', approvedBy: 'u-mgr', approvalId: 'apr-1', answeredAt: `${DAY}T09:00:00.000Z`, ...over,
});

interface Row { attemptId: string; storeId: string; state: string }
interface Refusal { userId: string; reason: string; field?: string; namedStore?: string; path: string }
interface Stamp { userId: string; store: string; field: string | null; path: string }
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

describe.each(backings)('OB-54 r12 — a store computer acts only on its own store\'s payment exceptions — on $name', ({ harness }) => {
  it('stamps the box\'s store, refuses another store\'s attempt by name and lists it, and keeps branch tender figures whole', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, BOX_A, 'store_computer', [S1]);
    await h.provisionRole(T, BOX_B, 'store_computer', [S2]);
    await h.provisionRole(T, 'u-acct', 'accountant');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const list = async () => ((await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as { exceptions: Row[] }).exceptions;
    const refusals = async () => ((await call('GET', '/v1/store-computers/refusals', 'u-owner')).body as { refusals: Refusal[] }).refusals;
    const stamps = async () => ((await call('GET', '/v1/store-computers/stamps', 'u-owner')).body as { stamps: Stamp[] }).stamps;
    const unresolvedAt = async (scope: string) => ((await call('GET', '/v1/reports/tender_mix', 'u-owner', undefined, { day: DAY, scope })).body as { figures: { name: string; valueMinor?: number }[] })
      .figures.filter((f) => f.name.startsWith('unresolved')).map((f) => [f.name, f.valueMinor]);
    // A cash sale at each store, so each store's day report produces.
    for (const s of [S1, S2]) {
      expect((await call('POST', '/v1/sales', 'u-owner', {
        saleId: `S-${s}`, receiptNumber: `R-${s}`, laneId: 'lane-1', cashierId: 'u-cash', locationId: s, tradingDay: DAY, committedAt: `${DAY}T06:00:00.000Z`,
        totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
        tenders: [{ kind: 'cash', amountMinor: 5_000 }],
      })).status).toBeLessThan(300);
    }

    // ── Each box relays a no-answer naming NO store: stamped with its credential's store, never "".
    const a1 = await call('POST', '/v1/finance/payment-exceptions/att-A1/no-answer/synced', BOX_A, noAnswer('att-A1'), undefined, 'na-a1');
    expect(a1.status, JSON.stringify(a1.body)).toBe(202);
    expect((await call('POST', '/v1/finance/payment-exceptions/att-A1/no-answer/synced', BOX_A, noAnswer('att-A1'), undefined, 'na-a1')).body).toEqual(a1.body);
    const b1 = await call('POST', '/v1/finance/payment-exceptions/att-B1/no-answer/synced', BOX_B, noAnswer('att-B1', { kind: 'upi', amountMinor: 41_000 }), undefined, 'na-b1');
    expect(b1.status, JSON.stringify(b1.body)).toBe(202);
    expect((await list()).map((r) => [r.attemptId, r.storeId, r.state]).sort()).toEqual([['att-A1', S1, 'open'], ['att-B1', S2, 'open']]);
    expect((await stamps()).filter((s) => s.path.startsWith('/v1/finance/payment-exceptions')).map((s) => [s.userId, s.store, s.field]).sort())
      .toEqual([[BOX_A, S1, 'storeId'], [BOX_B, S2, 'storeId']]);
    // Branch-scoped tender figures carry each stamped item at its own store — and only there.
    expect(await unresolvedAt(S2)).toEqual([['unresolved — upi (att-B1)', 41_000]]);
    expect(await unresolvedAt(S1)).toEqual([['unresolved — card (att-A1)', 64_000]]);

    // ── Box B acts on store-1's attempt: every relay refused by name, nothing recorded, each listed.
    const crossed: readonly [string, string, unknown, string][] = [
      ['resolve store-1\'s attempt', '/v1/finance/payment-exceptions/att-A1/resolved/synced', { paid: true }, 'record.attemptId'],
      ['late-answer store-1\'s attempt', '/v1/finance/payment-exceptions/att-A1/late-answer/synced', lateAnswer(), 'record.attemptId'],
      ['re-raise store-1\'s attempt', '/v1/finance/payment-exceptions/att-A1/no-answer/synced', noAnswer('att-A1'), 'record.attemptId'],
      ['raise one naming store-1', '/v1/finance/payment-exceptions/att-X1/no-answer/synced', noAnswer('att-X1', { storeId: S1 }), 'body.storeId'],
    ];
    for (const [what, path, body, field] of crossed) {
      const r = await call('POST', path, BOX_B, body, undefined, `cross-${field}-${path}`);
      expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(codeOf(r), what).toBe('store_computer_record_names_another_store');
      // Re-sent after a lost reply: refused again, and still listed once.
      expect((await call('POST', path, BOX_B, body, undefined, `cross-again-${field}-${path}`)).status).toBe(403);
    }
    const mine = (await refusals()).filter((r) => r.userId === BOX_B);
    expect(mine.map((r) => [r.path, r.reason, r.field, r.namedStore]).sort()).toEqual([
      ['/v1/finance/payment-exceptions/:attemptId/late-answer/synced', 'record_names_another_store', 'record.attemptId', S1],
      ['/v1/finance/payment-exceptions/:attemptId/no-answer/synced', 'record_names_another_store', 'body.storeId', S1],
      ['/v1/finance/payment-exceptions/:attemptId/no-answer/synced', 'record_names_another_store', 'record.attemptId', S1],
      ['/v1/finance/payment-exceptions/:attemptId/resolved/synced', 'record_names_another_store', 'record.attemptId', S1],
    ].sort());
    // Nothing was recorded: att-A1 is still open, no X1, no late answer.
    const after = await call('GET', '/v1/finance/payment-exceptions', 'u-acct');
    expect((after.body as { exceptions: Row[] }).exceptions.map((r) => [r.attemptId, r.state]).sort()).toEqual([['att-A1', 'open'], ['att-B1', 'open']]);
    expect((after.body as { lateAnswers: unknown[] }).lateAnswers).toEqual([]);

    // ── Box A resolves its OWN attempt; the replay under its key is the same answer.
    const res = await call('POST', '/v1/finance/payment-exceptions/att-A1/resolved/synced', BOX_A, { paid: true }, undefined, 'res-a1');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await call('POST', '/v1/finance/payment-exceptions/att-A1/resolved/synced', BOX_A, { paid: true }, undefined, 'res-a1')).body).toEqual(res.body);
    expect((await list()).find((r) => r.attemptId === 'att-A1')?.state).toBe('resolved_paid');
    expect(await unresolvedAt(S1)).toEqual([]);
    expect(await unresolvedAt(S2)).toEqual([['unresolved — upi (att-B1)', 41_000]]);
    // Box B's own late answer for its own attempt is stamped with store-2.
    expect((await call('POST', '/v1/finance/payment-exceptions/att-B1/late-answer/synced', BOX_B, lateAnswer({ billRef: 'B-att-B1', kind: 'upi', amountMinor: 41_000 }))).status).toBe(202);
    const la = ((await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as { lateAnswers: { attemptId: string; storeId: string }[] }).lateAnswers;
    expect(la.map((a) => [a.attemptId, a.storeId])).toEqual([['att-B1', S2]]);

    // ── A person's relay that names no store is not read: a payment exception is never kept with store "".
    const person = await call('POST', '/v1/finance/payment-exceptions/att-P1/no-answer/synced', 'u-owner', noAnswer('att-P1'));
    expect(person.status).toBe(400);
    expect(codeOf(person)).toBe('not_readable_as_a_no_answer');
    expect((await list()).some((r) => r.storeId === '')).toBe(false);
  }, 60_000);
});
