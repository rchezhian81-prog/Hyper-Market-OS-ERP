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
 * **Round 13 (verifier D1, probe P7 · PA-01 · OB-54 · OB-69 · PF-06): a PERSON relays only for the branches their own
 * role covers.**
 *
 * The store lock judged only store computers. A store manager scoped to store-1 holds `till.dayclose.sync`, and through
 * their own sign-in marked store-2's open card payment PAID and raised a no-answer naming store-2. Now every relay write
 * (`/synced`, and the routes a store computer's records are placed by) judges a person's server-derived branch scope for
 * the route's permission: the stores the request names AND the held record's own store. On the real API (in memory, and
 * with DATABASE_URL on real PostgreSQL):
 *
 *   • the store-1 manager's resolve, late-answer and re-raise of store-2's attempt, and a no-answer naming store-2, are
 *     each 403 `outside_your_branch_scope` naming store-2 — nothing recorded; a re-send under the same key is refused again
 *     (the judgement runs before any stored reply is served);
 *   • the same manager raises and resolves their OWN store's attempt; the replay is the same answer;
 *   • the same rule on another relay family: a store-1 cashier's sale relay at store-2 is refused, at store-1 accepted;
 *   • a company-wide person (the owner) is not limited.
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
const noAnswer = (attemptId: string, over: Record<string, unknown> = {}) => ({
  attemptId, laneId: 'lane-1', billRef: `B-${attemptId}`, kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY,
  recordedAt: `${DAY}T05:00:30.000Z`, recordedBy: 'u-cash', ...over,
});
const lateAnswer = (over: Record<string, unknown> = {}) => ({
  laneId: 'lane-1', billRef: 'B-att-B1', kind: 'card', amountMinor: 64_000, askedAt: `${DAY}T05:00:00.000Z`, tradingDay: DAY, outcome: 'approved',
  answeredBy: 'u-cash', approvedBy: 'u-mgr', approvalId: 'apr-1', answeredAt: `${DAY}T09:00:00.000Z`, ...over,
});
const sale = (id: string, locationId: string) => ({
  saleId: id, receiptNumber: `R-${id}`, laneId: 'lane-1', cashierId: 'u-cash', locationId, tradingDay: DAY, committedAt: `${DAY}T06:00:00.000Z`,
  totalMinor: 5_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amountMinor: 5_000 }],
});
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const whatOf = (r: { body: unknown }): string => (r.body as { error?: { whatHappened?: string } } | null)?.error?.whatHappened ?? '';

describe.each(backings)('Round 13 — a person relays only for their own branches — on $name', ({ harness }) => {
  it('P7: a store-1 manager cannot resolve, answer or raise store-2\'s payment exceptions; their own store\'s work goes through', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box-b', 'store_computer', [S2]);
    await h.provisionRole(T, 'u-mgr1', 'store_manager', [S1]);
    await h.provisionRole(T, 'u-cash1', 'cashier', [S1]);
    await h.provisionRole(T, 'u-acct', 'accountant');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string) =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr1' || userId === 'u-cash1' ? { branchId: S1 } : {}), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const list = async () => (await call('GET', '/v1/finance/payment-exceptions', 'u-acct')).body as { exceptions: { attemptId: string; storeId: string; state: string }[]; lateAnswers: unknown[] };

    // Store-2's own computer raises store-2's open card payment.
    expect((await call('POST', '/v1/finance/payment-exceptions/att-B1/no-answer/synced', 'u-box-b', noAnswer('att-B1'))).status).toBe(202);

    // ── The store-1 manager acts on store-2: every relay refused by name, nothing recorded.
    const crossed: readonly [string, string, unknown, string][] = [
      ['resolve store-2\'s attempt as paid', '/v1/finance/payment-exceptions/att-B1/resolved/synced', { paid: true }, 'record.attemptId'],
      ['late-answer store-2\'s attempt (naming store-1)', '/v1/finance/payment-exceptions/att-B1/late-answer/synced', lateAnswer({ storeId: S1 }), 'record.attemptId'],
      ['re-raise store-2\'s attempt (naming store-1)', '/v1/finance/payment-exceptions/att-B1/no-answer/synced', noAnswer('att-B1', { storeId: S1 }), 'record.attemptId'],
      ['raise a no-answer naming store-2', '/v1/finance/payment-exceptions/att-X2/no-answer/synced', noAnswer('att-X2', { storeId: S2 }), 'body.storeId'],
      ['late-answer a new attempt naming store-2', '/v1/finance/payment-exceptions/att-X3/late-answer/synced', lateAnswer({ storeId: S2, billRef: 'B-att-X3' }), 'body.storeId'],
    ];
    for (const [what, path, body, field] of crossed) {
      const key = `cross-${path}`;
      const r = await call('POST', path, 'u-mgr1', body, key);
      expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(codeOf(r), what).toBe('outside_your_branch_scope');
      expect(whatOf(r), what).toContain(`"${S2}"`);
      expect(whatOf(r), what).toContain(field);
      // Re-sent under the same key after a lost reply: judged again, refused again.
      expect((await call('POST', path, 'u-mgr1', body, key)).status, what).toBe(403);
    }
    const after = await list();
    expect(after.exceptions.map((r) => [r.attemptId, r.storeId, r.state])).toEqual([['att-B1', S2, 'open']]);
    expect(after.lateAnswers).toEqual([]);

    // ── Their OWN store: raised, resolved once; a replay is the same answer.
    const own = await call('POST', '/v1/finance/payment-exceptions/att-A1/no-answer/synced', 'u-mgr1', noAnswer('att-A1', { storeId: S1 }), 'own-na');
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    const res = await call('POST', '/v1/finance/payment-exceptions/att-A1/resolved/synced', 'u-mgr1', { paid: true }, 'own-res');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await call('POST', '/v1/finance/payment-exceptions/att-A1/resolved/synced', 'u-mgr1', { paid: true }, 'own-res')).body).toEqual(res.body);
    expect((await list()).exceptions.map((r) => [r.attemptId, r.storeId, r.state]).sort()).toEqual([['att-A1', S1, 'resolved_paid'], ['att-B1', S2, 'open']]);

    // ── Another relay family under the same rule: a store-1 cashier's sale relay at store-2 is refused, at store-1 accepted.
    const away = await call('POST', '/v1/sales', 'u-cash1', sale('S-away', S2));
    expect(away.status, JSON.stringify(away.body)).toBe(403);
    expect(codeOf(away)).toBe('outside_your_branch_scope');
    expect((await call('GET', '/v1/sales/S-away', 'u-owner')).status).toBe(404);
    expect((await call('POST', '/v1/sales', 'u-cash1', sale('S-home', S1))).status).toBeLessThan(300);

    // ── A company-wide person is not limited: the owner resolves store-2's attempt.
    const owner = await call('POST', '/v1/finance/payment-exceptions/att-B1/resolved/synced', 'u-owner', { paid: false });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
  }, 60_000);
});
