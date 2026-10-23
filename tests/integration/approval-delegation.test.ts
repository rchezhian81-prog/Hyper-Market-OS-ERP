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

// Approval delegation, end to end (M02-FR-03 · §28 · P-04 · hard rule #4, API-01). The manager goes on
// leave and the shop still needs refunds authorised. Delegation is the honest alternative to the shared
// login: a delegate acts as THEMSELVES under a named authority, time-boxed, never wider than the granter
// holds, never chained, never used to approve the granter's own request, and authorised by a SEPARATE
// person (§28). Gated approvals.delegation.grant (grant/revoke) / .read (review + effective authority).

// Round 12: each test runs on its own shop — in memory, and with DATABASE_URL on real PostgreSQL too.
let A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
const inr = (minor: number) => ({ minor, currency: 'INR' });
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const grant = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/access/delegations/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `g-${id}`, body });
const revoke = (h: ApiHarness, u: string, id: string, body: Record<string, unknown> = {}, key?: string) =>
  h.request({ method: 'POST', path: `/v1/access/delegations/${id}/revoke`, userId: u, tenantId: A, idempotencyKey: key ?? `rv-${id}`, body });
const effective = (h: ApiHarness, u: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: '/v1/access/delegations/effective-authority', userId: u, tenantId: A, idempotencyKey: key ?? `ea-${Math.abs(JSON.stringify(body).length)}`, body });
const review = (h: ApiHarness, u: string, query: Record<string, string> = {}) =>
  h.request({ method: 'GET', path: '/v1/access/delegations', userId: u, tenantId: A, query });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
// A valid delegation of u-boss's refund authority to u-deputy, capped below u-boss's own limit.
const boss = { userId: 'u-boss', branchScope: ['b1'], authorityLimit: inr(50000) };
const validGrant = (over: Record<string, unknown> = {}) =>
  ({ fromUserId: 'u-boss', toUserId: 'u-deputy', fromDate: day(0), untilDate: day(10), subjectTypes: ['refund'], reason: 'annual leave', granter: boss, valueCap: inr(30000), branchScope: ['b1'], ...over });

async function seeded(make: () => ApiHarness = () => apiHarness()): Promise<ApiHarness> {
  const h = make();
  A = randomUUID();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // delegation.grant + .read
  // Wave 2b · PA-03: a lender must genuinely HOLD the authority they lend — the server derives their scope from their grants.
  await h.provisionRole(A, 'u-boss', 'store_manager', ['b1']);
  await h.provisionRole(A, 'u-a', 'store_manager');
  await h.provisionRole(A, 'u-b', 'store_manager');
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe.each(backings)('approval delegation — the honest alternative to the shared login (M02-FR-03) — on $name', ({ harness }) => {
  it('grants a valid delegation; the delegate acts on-behalf, but their own authority wins', async () => {
    const h = await seeded(harness);
    const g = await grant(h, 'u-owner', 'd1', validGrant());
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ delegationId: 'd1', toUserId: 'u-deputy', authorisedBy: 'u-owner' });

    // With no own authority, the deputy decides on u-boss's authority, capped, in their OWN name.
    const onBehalf = (await effective(h, 'u-mgr', { userId: 'u-deputy', subjectType: 'refund' }, 'ea1')).body as { source: string; onBehalfOf?: string; authorityLimit: { minor: number } | null; delegationId?: string };
    expect(onBehalf).toMatchObject({ source: 'delegated', onBehalfOf: 'u-boss', delegationId: 'd1' });
    expect(onBehalf.authorityLimit).toEqual(inr(30000));

    // If the deputy has their OWN authority, it wins — a delegation only adds what they don't already hold.
    const own = (await effective(h, 'u-mgr', { userId: 'u-deputy', subjectType: 'refund', own: { userId: 'u-deputy', branchScope: ['b1'], authorityLimit: inr(100000) } }, 'ea2')).body as { source: string };
    expect(own.source).toBe('own_authority');

    const rows = (await review(h, 'u-owner')).body as { rows: { delegationId: string; state: string }[] };
    expect(rows.rows.find((r) => r.delegationId === 'd1')?.state).toBe('active');
  });

  it('round 10: a delegation that names no branches is lent only where the lender holds the authority — never company-wide', async () => {
    const h = await seeded(harness);
    const unnamed: Record<string, unknown> = validGrant({ toUserId: 'u-deputy-2' });
    delete unnamed['branchScope'];
    expect((await grant(h, 'u-owner', 'd-unnamed', unnamed)).status).toBe(201);
    const lent = (await effective(h, 'u-mgr', { userId: 'u-deputy-2', subjectType: 'refund' }, 'ea-unnamed')).body as { source: string; branchScope: readonly string[] | 'all' };
    expect(lent).toMatchObject({ source: 'delegated', branchScope: ['b1'] });     // u-boss holds refunds at b1 only
  });

  it('round 12: each lent subject type stays where the lender holds THAT authority — never the union; an unknown type is refused', async () => {
    const h = await seeded(harness);
    // u-boss: store manager at b1 (refunds at b1) AND accountant shop-wide (reopening a closed day, everywhere).
    await h.provisionRole(A, 'u-boss', 'accountant');
    const both: Record<string, unknown> = validGrant({ toUserId: 'u-dep', subjectTypes: ['refund', 'day_close_reopen'] });
    delete both['branchScope'];
    const g = await grant(h, 'u-owner', 'd-both', both, 'g-both');
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    // Replayed under its key: the same answer, one delegation.
    expect((await grant(h, 'u-owner', 'd-both', both, 'g-both')).body).toEqual(g.body);
    const lentRefund = (await effective(h, 'u-mgr', { userId: 'u-dep', subjectType: 'refund' }, 'ea-both-refund')).body as { source: string; branchScope: readonly string[] | 'all' };
    expect(lentRefund).toMatchObject({ source: 'delegated', branchScope: ['b1'] });          // refunds stay at b1
    const lentReopen = (await effective(h, 'u-mgr', { userId: 'u-dep', subjectType: 'day_close_reopen' }, 'ea-both-reopen')).body as { source: string; branchScope: readonly string[] | 'all' };
    expect(lentReopen).toMatchObject({ source: 'delegated', branchScope: 'all' });          // the accountant's own reach
    // The decide gate agrees: a b2 refund under the delegation is out of scope, a b1 refund is not.
    const decide = (branchId: string, key: string) => h.request({ method: 'POST', path: '/v1/access/approvals/decide', userId: 'u-dep', tenantId: A, idempotencyKey: key, body: {
      request: { id: `r-${branchId}`, subjectType: 'refund', subjectRef: `RET-${branchId}`, requestedBy: 'u-cash', branchId, value: inr(10000) }, decision: 'approved', reason: 'checked the bill',
    } });
    await h.provisionRole(A, 'u-dep', 'store_manager'); // the gate needs approvals.delegation.read; no own record is sent, so only the delegation counts
    const b2 = await decide('b2', 'dec-b2');
    expect(codeOf(b2), JSON.stringify(b2.body)).toBe('out_of_scope');
    expect((await decide('b1', 'dec-b1')).status).toBe(200);
    // A subject type head office knows no authority for is refused by name — never lent as the body describes it.
    const odd = await grant(h, 'u-owner', 'd-odd', validGrant({ toUserId: 'u-dep-2', subjectTypes: ['refund', 'tea_break'] }), 'g-odd');
    expect(odd.status).toBe(422);
    expect(codeOf(odd)).toBe('unknown_subject_type');
    // A subject the lender holds nowhere cannot be lent at all.
    const none = await grant(h, 'u-owner', 'd-none', validGrant({ toUserId: 'u-dep-3', subjectTypes: ['purchase_order'], fromUserId: 'u-cash', granter: { userId: 'u-cash', branchScope: ['b1'], authorityLimit: inr(50000) } }), 'g-none');
    expect(none.status).toBe(422);
    expect(codeOf(none)).toBe('exceeds_granter_authority');
    // A named scope wider than the lender's authority for ONE of the lent types is refused (b2 is outside b1 refunds).
    const wide = await grant(h, 'u-owner', 'd-wide', validGrant({ toUserId: 'u-dep-4', subjectTypes: ['refund', 'day_close_reopen'], branchScope: ['b1', 'b2'] }), 'g-wide');
    expect(codeOf(wide)).toBe('widens_branch_scope');
    const rows = ((await review(h, 'u-owner')).body as { rows: { delegationId: string }[] }).rows.map((r) => r.delegationId);
    expect(rows).toContain('d-both');
    expect(rows.filter((r) => ['d-odd', 'd-none', 'd-wide'].includes(r))).toEqual([]);
  });

  it('refuses the routes that end in an unattributable decision', async () => {
    const h = await seeded(harness);
    // Delegating to yourself changes nothing and hides that it changed nothing.
    expect(codeOf(await grant(h, 'u-owner', 'd-self', validGrant({ toUserId: 'u-boss' }), 'g-self'))).toBe('self_delegation');
    // You cannot lend more than you hold — and what you hold is the SERVER's figure (OB-290: a store manager's ₹5,000
    // refund limit), never the `authorityLimit` the body claims for the lender.
    expect(codeOf(await grant(h, 'u-owner', 'd-over', validGrant({ valueCap: inr(600_000) }), 'g-over'))).toBe('exceeds_granter_authority');
    expect(codeOf(await grant(h, 'u-owner', 'd-over-body', validGrant({ valueCap: inr(600_000), granter: { ...boss, authorityLimit: null } }), 'g-over-body'))).toBe('exceeds_granter_authority');
    // A separate person must authorise it — the caller cannot be the one lending their own authority away.
    expect(codeOf(await grant(h, 'u-owner', 'd-selfauth', validGrant({ fromUserId: 'u-owner', granter: { userId: 'u-owner', branchScope: 'all', authorityLimit: null } }), 'g-selfauth'))).toBe('not_authorised');
    // A delegation that outlasts the absence it covers is a permanent change of who holds authority.
    expect(codeOf(await grant(h, 'u-owner', 'd-long', validGrant({ untilDate: day(200) }), 'g-long'))).toBe('too_long');
  });

  it('forbids chains, allows early revocation, and is gated', async () => {
    const h = await seeded(harness);
    // OB-290: a store manager's refund authority is capped at ₹5,000 on the server, so what they lend is capped too.
    expect((await grant(h, 'u-owner', 'd-base', { fromUserId: 'u-a', toUserId: 'u-b', fromDate: day(0), untilDate: day(10), subjectTypes: ['refund'], reason: 'cover', granter: { userId: 'u-a', branchScope: 'all', authorityLimit: null }, valueCap: inr(100_000) })).status).toBe(201);
    // u-b is now acting under a delegation and cannot pass it on — two hops in, nobody is accountable.
    expect(codeOf(await grant(h, 'u-owner', 'd-chain', { fromUserId: 'u-b', toUserId: 'u-c', fromDate: day(0), untilDate: day(5), subjectTypes: ['refund'], reason: 'chain', granter: { userId: 'u-b', branchScope: 'all', authorityLimit: null }, valueCap: inr(50_000) }, 'g-chain'))).toBe('chain_forbidden');

    // Revoke early — the counterpart to the March grant nobody remembered in August.
    expect((await revoke(h, 'u-owner', 'd-base')).status).toBe(200);
    expect(((await review(h, 'u-owner')).body as { rows: { delegationId: string; state: string }[] }).rows.find((r) => r.delegationId === 'd-base')?.state).toBe('revoked');
    expect((await revoke(h, 'u-owner', 'ghost')).status).toBe(404);

    // Gating.
    expect((await grant(h, 'u-cash', 'd-x', validGrant(), 'g-cash')).status).toBe(403);
    expect((await review(h, 'u-cash')).status).toBe(403);
    expect((await effective(h, 'u-cash', { userId: 'u-deputy', subjectType: 'refund' }, 'ea-cash')).status).toBe(403);
  });

  it('keeps granted delegations across a restart', async () => {
    const h = await seeded(harness);
    await grant(h, 'u-owner', 'd1', validGrant());
    const restarted = apiHarness({ store: h.store });
    const after = (await review(restarted, 'u-owner')).body as { rows: { delegationId: string }[] };
    expect(after.rows.some((r) => r.delegationId === 'd1')).toBe(true);
  });
});
