import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Promotion governance, end to end through the real API (M20 / M05-FR-04, §28, API-02). A promotion is
// a decision to give away margin for volume: this SIMULATES the margin impact before launch, and lets a
// margin-LOSING offer launch only with a named approver who is not the proposer and a written reason
// (§28) — a loss-leader is legitimate, but never by accident. Proves the wired `packages/promotions`
// governance against the real pipeline and real per-tenant RBAC — another engine nothing fed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const inr = (minor: number) => ({ minor, currency: 'INR' });

// A promotion that reduces per-unit margin but wins on volume — launches freely.
const goodPromo = (over: Record<string, unknown> = {}) => ({
  description: '10% off staple rice', normalPrice: inr(10_000), promoPrice: inr(9_000), unitCost: inr(5_000),
  baselineUnits: 100, expectedUnits: 200, ...over,
});
// A promotion that sells below cost — blocks approval.
const lossPromo = (over: Record<string, unknown> = {}) => goodPromo({ promoPrice: inr(4_000), ...over });

const simulate = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/promotions/${id}/simulate`, userId, tenantId, idempotencyKey: `sim-${id}`, body });

const launch = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/promotions/${id}/launch`, userId, tenantId, idempotencyKey: key ?? `launch-${id}`, body });

const getPromo = (h: ApiHarness, tenantId: string, userId: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/promotions/${id}`, userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Sim { verdict: string; blocksApproval: boolean }
interface Launched { launched: boolean; verdict?: string; approvedBy?: string | null }

describe('a promotion is simulated, then gated on its margin (M20 / M05-FR-04, §28)', () => {
  it('simulates the margin impact and the verdict without committing anything', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await simulate(h, A, 'u-owner', 'P1', goodPromo())).body as Sim).toMatchObject({ verdict: 'margin_reduced_but_positive', blocksApproval: false });
    expect((await simulate(h, A, 'u-owner', 'P2', lossPromo())).body as Sim).toMatchObject({ verdict: 'sells_below_cost', blocksApproval: true });
    // A what-if commits nothing: neither promotion is launched.
    expect(((await getPromo(h, A, 'u-owner', 'P1')).body as Launched).launched).toBe(false);
  });

  it('launches a margin-positive promotion freely', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const res = await launch(h, A, 'u-owner', 'P1', goodPromo());
    expect(res.status).toBe(201);
    expect((res.body as Launched).approvedBy).toBeNull(); // no approval needed
    expect((await getPromo(h, A, 'u-owner', 'P1')).body as Launched).toMatchObject({ launched: true, verdict: 'margin_reduced_but_positive' });
  });

  it('refuses a margin-losing offer without a second person, a reason, or a genuinely-authorised approver (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'owner');    // holds price.change.approve — a genuine approver
    await h.provisionRole(A, 'u-cash', 'cashier'); // holds NO pricing-approval authority

    expect(codeOf(await launch(h, A, 'u-owner', 'PL', lossPromo()))).toBe('launch_needs_approval'); // no approval
    // Self-approval is refused — the proposer cannot approve their own margin loss.
    expect(codeOf(await launch(h, A, 'u-owner', 'PL', lossPromo({ approvedBy: 'u-owner', rationale: 'clearance of short-dated stock' }), 'k-self'))).toBe('launch_needs_approval');
    // An approver who does NOT hold the pricing-approval authority does not count — a name typed in a box
    // is not an approval. This is the bypass being closed (a below-cost promotion is a pricing decision).
    expect(codeOf(await launch(h, A, 'u-owner', 'PL', lossPromo({ approvedBy: 'u-cash', rationale: 'festival loss leader for footfall' }), 'k-noauth'))).toBe('approver_may_not_approve');
    // A genuinely-authorised approver but no real reason is still refused.
    expect(codeOf(await launch(h, A, 'u-owner', 'PL', lossPromo({ approvedBy: 'u-mgr', rationale: 'ok' }), 'k-noreason'))).toBe('launch_needs_approval');
  });

  it('launches a margin-losing offer when a genuinely-authorised second person approves with a reason', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'owner'); // genuinely holds price.change.approve
    const res = await launch(h, A, 'u-owner', 'PL', lossPromo({ approvedBy: 'u-mgr', rationale: 'loss-leader to drive festival footfall' }));
    expect(res.status).toBe(201);
    expect((res.body as Launched).approvedBy).toBe('u-mgr');
  });

  it('is idempotent per promotion — a re-launch does not launch it twice', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await launch(h, A, 'u-owner', 'P1', goodPromo(), 'k1')).status).toBe(201);
    const again = await launch(h, A, 'u-owner', 'P1', goodPromo(), 'k2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyLaunched?: boolean }).alreadyLaunched).toBe(true);
  });

  it('is authorized and per-tenant, and refuses a malformed simulation', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not govern promotions
    await launch(h, A, 'u-owner', 'P1', goodPromo());

    expect((await launch(h, A, 'u-cash', 'P2', goodPromo())).status).toBe(403);
    expect((await launch(h, A, 'u-owner', 'P3', { normalPrice: inr(10_000) })).status).toBe(400); // missing fields

    // Tenant B never launched P1.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await getPromo(h, B, 'u-owner-b', 'P1')).body as Launched).launched).toBe(false);
  });
});
