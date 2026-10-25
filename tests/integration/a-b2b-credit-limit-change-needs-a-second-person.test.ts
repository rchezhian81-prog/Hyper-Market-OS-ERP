import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { InMemoryEventStore, SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { MemoryIdempotencyStore, SqlIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-360 (owner, 24–25 Oct 2026, in writing): every B2B credit-limit change goes through the approval engine with a
 * second person — including `POST /v1/b2b/accounts/:id`, which used to set a limit directly.**
 *
 * On the real API (in memory and, with DATABASE_URL, on real PostgreSQL with a cold restart):
 *   • a limit sent with no approval is refused by name and NOTHING is set (the account still answers 404);
 *   • a typed "approvedBy" is refused by name; the asker cannot approve their own request;
 *   • the owner asks, the accountant approves in her own session → the limit is set, naming the approver;
 *   • the same approval cannot be spent twice; re-sending the terms already on the account changes nothing and needs none;
 *   • raising the limit later needs a NEW approval; without one the old limit stands;
 *   • a cashier cannot set a limit (403); after a cold restart the limit and the spent approval are both still there.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CASH = 'u-cash';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly stores: () => { store: EventStore; idempotency: IdempotencyStore } }
const backings: Backing[] = [{ name: 'the in-memory event store', stores: () => ({ store: new InMemoryEventStore(), idempotency: new MemoryIdempotencyStore() }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', stores: () => { const sql = pgPoolClient(pool!); return { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }; } });

describe.each(backings)('OB-360 — a B2B credit-limit change needs a second person, on $name', ({ name, stores }) => {
  it('refused without an approval; set with another person\'s; never spent twice; kept across a cold restart', async () => {
    const backing = stores();
    let h: ApiHarness = apiHarness(backing);
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.enableFeature(T, 'b2b');
    await h.provisionRole(T, ACCT, 'accountant');
    await h.provisionRole(T, CASH, 'cashier');
    const post = (user: string, body: Record<string, unknown>, customerId = 'SCHOOL') =>
      h.request({ method: 'POST', path: `/v1/b2b/accounts/${customerId}`, userId: user, tenantId: T, idempotencyKey: `acc-${randomUUID()}`, body });
    const account = (customerId = 'SCHOOL') => h.request({ method: 'GET', path: `/v1/b2b/accounts/${customerId}`, userId: OWNER, tenantId: T });
    const ask = async (maker: string, body: Record<string, unknown>, customerId = 'SCHOOL') => {
      const asked = await askForApproval(h, T, maker, { kind: 'b2b_credit_limit', subjectRef: customerId, details: actionDetails(body, { customerId }) });
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      return (asked.body as { requestId: string }).requestId;
    };

    // ── 1 · No approval: refused by name, nothing set.
    const terms = { creditLimitMinor: 500_000, paymentTermsDays: 30 };
    const bare = await post(OWNER, terms);
    expect(bare.status).toBe(422);
    expect(codeOf(bare)).toBe('credit_limit_needs_approval');
    expect((await account()).status, 'nothing was set').toBe(404);
    // A typed second person is refused by name — the second person approves in their own session.
    const typed = await post(OWNER, { ...terms, approvedBy: ACCT });
    expect(typed.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(typed)).toBe('approver_named_without_approval');
    expect((await account()).status).toBe(404);

    // ── 2 · The asker cannot approve their own; another person who manages B2B accounts can.
    const own = await ask(OWNER, terms);
    expect((await decide(h, T, OWNER, own)).status, 'a maker never approves their own request').toBe(422);
    const requestId = await ask(OWNER, terms);
    expect((await decide(h, T, ACCT, requestId)).status).toBe(201);
    const set = await post(OWNER, { ...terms, approvalId: requestId });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body).toMatchObject({ customerId: 'SCHOOL', creditLimitMinor: 500_000, paymentTermsDays: 30, approvedBy: ACCT, approvalId: requestId, previousLimitMinor: null });
    expect((await account()).body).toMatchObject({ creditLimitMinor: 500_000, outstandingMinor: 0 });

    // ── 3 · One approval, one change: the same approval for another limit is refused; the same terms again change nothing.
    const reuse = await post(OWNER, { creditLimitMinor: 900_000, paymentTermsDays: 30, approvalId: requestId });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    expect(((await account()).body as { creditLimitMinor: number }).creditLimitMinor).toBe(500_000);
    const again = await post(OWNER, terms);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadySet: true, creditLimitMinor: 500_000 });

    // ── 4 · Raising it later needs a new approval; without one the old limit stands.
    const raise = { creditLimitMinor: 750_000, paymentTermsDays: 30 };
    expect(codeOf(await post(OWNER, raise))).toBe('credit_limit_needs_approval');
    expect(((await account()).body as { creditLimitMinor: number }).creditLimitMinor).toBe(500_000);
    // The accountant may ask and the owner approve — they check each other.
    const raiseId = await ask(ACCT, raise);
    expect((await decide(h, T, OWNER, raiseId)).status).toBe(201);
    const raised = await post(ACCT, { ...raise, approvalId: raiseId });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body).toMatchObject({ creditLimitMinor: 750_000, approvedBy: OWNER, previousLimitMinor: 500_000 });

    // ── 5 · A cashier cannot set a limit, with or without an approval.
    expect((await post(CASH, { creditLimitMinor: 1, approvalId: raiseId })).status).toBe(403);

    // ── 6 · Cold restart: a fresh API over the same records still holds the limit, and the spent approval stays spent.
    h = apiHarness(name === 'real PostgreSQL' ? stores() : backing);
    expect((await account()).body).toMatchObject({ creditLimitMinor: 750_000 });
    const afterRestart = await post(OWNER, { creditLimitMinor: 1_000_000, paymentTermsDays: 30, approvalId: raiseId });
    expect(afterRestart.status).toBeGreaterThanOrEqual(400);
    expect(((await account()).body as { creditLimitMinor: number }).creditLimitMinor).toBe(750_000);
  }, 60_000);
});
