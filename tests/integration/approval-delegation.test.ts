import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Approval delegation, end to end (M02-FR-03 · §28 · P-04 · hard rule #4, API-01). The manager goes on
// leave and the shop still needs refunds authorised. Delegation is the honest alternative to the shared
// login: a delegate acts as THEMSELVES under a named authority, time-boxed, never wider than the granter
// holds, never chained, never used to approve the granter's own request, and authorised by a SEPARATE
// person (§28). Gated approvals.delegation.grant (grant/revoke) / .read (review + effective authority).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // delegation.grant + .read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('approval delegation — the honest alternative to the shared login (M02-FR-03)', () => {
  it('grants a valid delegation; the delegate acts on-behalf, but their own authority wins', async () => {
    const h = await seeded();
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

  it('refuses the routes that end in an unattributable decision', async () => {
    const h = await seeded();
    // Delegating to yourself changes nothing and hides that it changed nothing.
    expect(codeOf(await grant(h, 'u-owner', 'd-self', validGrant({ toUserId: 'u-boss' }), 'g-self'))).toBe('self_delegation');
    // You cannot lend more than you hold.
    expect(codeOf(await grant(h, 'u-owner', 'd-over', validGrant({ valueCap: inr(80000) }), 'g-over'))).toBe('exceeds_granter_authority');
    // A separate person must authorise it — the caller cannot be the one lending their own authority away.
    expect(codeOf(await grant(h, 'u-owner', 'd-selfauth', validGrant({ fromUserId: 'u-owner', granter: { userId: 'u-owner', branchScope: 'all', authorityLimit: null } }), 'g-selfauth'))).toBe('not_authorised');
    // A delegation that outlasts the absence it covers is a permanent change of who holds authority.
    expect(codeOf(await grant(h, 'u-owner', 'd-long', validGrant({ untilDate: day(200) }), 'g-long'))).toBe('too_long');
  });

  it('forbids chains, allows early revocation, and is gated', async () => {
    const h = await seeded();
    await grant(h, 'u-owner', 'd-base', { fromUserId: 'u-a', toUserId: 'u-b', fromDate: day(0), untilDate: day(10), subjectTypes: ['refund'], reason: 'cover', granter: { userId: 'u-a', branchScope: 'all', authorityLimit: null } });
    // u-b is now acting under a delegation and cannot pass it on — two hops in, nobody is accountable.
    expect(codeOf(await grant(h, 'u-owner', 'd-chain', { fromUserId: 'u-b', toUserId: 'u-c', fromDate: day(0), untilDate: day(5), subjectTypes: ['refund'], reason: 'chain', granter: { userId: 'u-b', branchScope: 'all', authorityLimit: null } }, 'g-chain'))).toBe('chain_forbidden');

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
    const h = await seeded();
    await grant(h, 'u-owner', 'd1', validGrant());
    const restarted = apiHarness({ store: h.store });
    const after = (await review(restarted, 'u-owner')).body as { rows: { delegationId: string }[] };
    expect(after.rows.some((r) => r.delegationId === 'd1')).toBe(true);
  });
});
