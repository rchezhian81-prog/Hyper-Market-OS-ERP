import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M03-FR-04 §28: the reversible, two-person product merge on the live API. Detection produces a review
// list; THIS is the write path that resolves one — and it resolves it the way the roadmap insists a merge
// must: never automatic, never destructive. One person PROPOSES a merge (catalogue.merge.propose), a
// DIFFERENT person APPROVES it (catalogue.merge.approve); the proposer can never be the approver (§28); the
// result is a reversible LINK, not a deletion (hard rule #2); and resolveProductId tells any reader where a
// merged id now points. The lifecycle is event-sourced, so it survives a restart and reads as what happened.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const mergeOf = (res: { body: unknown }): { status?: string; link?: { keepProductId?: string; reversed?: boolean } } =>
  (res.body as { merge?: { status?: string; link?: { keepProductId?: string; reversed?: boolean } } }).merge ?? {};

const propose = (h: ApiHarness, u: string, mergeId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/merges/${mergeId}`, userId: u, tenantId: A, idempotencyKey: key, body });
const decide = (h: ApiHarness, u: string, mergeId: string, decision: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/merges/${mergeId}/decision`, userId: u, tenantId: A, idempotencyKey: key, body: { decision } });
const reverse = (h: ApiHarness, u: string, mergeId: string, key: string) =>
  h.request({ method: 'POST', path: `/v1/catalogue/merges/${mergeId}/reverse`, userId: u, tenantId: A, idempotencyKey: key, body: {} });
const list = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/catalogue/merges', userId: u, tenantId: A });
const canonical = (h: ApiHarness, u: string, productId: string) =>
  h.request({ method: 'GET', path: `/v1/catalogue/products/${productId}/canonical`, userId: u, tenantId: A });

/** The standard cast: the genesis owner (proposes + approves), a second owner (the independent approver),
 *  a store manager (may propose, may NOT approve), and a cashier (may do neither). */
async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionOwner(A, 'u-owner2');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.provisionRole(A, 'u-cashier', 'cashier');
  return h;
}

const body = (keep: string, supersede: string, reason = 'same item entered twice') =>
  ({ keepProductId: keep, supersedeProductId: supersede, reason });

describe('reversible product merge (M03-FR-04 §28)', () => {
  it('a manager proposes and a DIFFERENT owner approves → a reversible link, and the merged id now resolves', async () => {
    const h = await cast();
    const p = await propose(h, 'u-mgr', 'm1', body('p-keep', 'p-dupe'), 'k-propose');
    expect(p.status).toBe(201);
    expect(mergeOf(p).status).toBe('pending');
    // Before approval, nothing is merged — the duplicate still resolves to itself.
    expect((await canonical(h, 'u-mgr', 'p-dupe')).body).toMatchObject({ canonicalProductId: 'p-dupe', merged: false });

    const a = await decide(h, 'u-owner', 'm1', 'approved', 'k-approve');
    expect(a.status).toBe(201);
    expect(mergeOf(a).status).toBe('approved');
    expect(mergeOf(a).link).toMatchObject({ keepProductId: 'p-keep' });
    // Now the superseded id resolves to the surviving record — that is what the merge MEANS to a reader.
    expect((await canonical(h, 'u-mgr', 'p-dupe')).body).toMatchObject({ canonicalProductId: 'p-keep', merged: true });
    // The survivor still resolves to itself.
    expect((await canonical(h, 'u-mgr', 'p-keep')).body).toMatchObject({ canonicalProductId: 'p-keep', merged: false });
  });

  it('§28: the person who proposed a merge cannot approve it — a second person is required', async () => {
    const h = await cast();
    // The owner holds BOTH codes, yet still cannot approve their own proposal.
    await propose(h, 'u-owner', 'm2', body('p-keep', 'p-dupe'), 'k1');
    const self = await decide(h, 'u-owner', 'm2', 'approved', 'k2');
    expect(self.status).toBe(409);
    expect(codeOf(self)).toBe('merge_needs_a_second_person');
    // Nothing merged — the duplicate still resolves to itself.
    expect((await canonical(h, 'u-owner', 'p-dupe')).body).toMatchObject({ merged: false });
    // A DIFFERENT owner can approve the same proposal.
    expect((await decide(h, 'u-owner2', 'm2', 'approved', 'k3')).status).toBe(201);
    expect((await canonical(h, 'u-owner', 'p-dupe')).body).toMatchObject({ canonicalProductId: 'p-keep', merged: true });
  });

  it('an approved merge can be REVERSED — the superseded id resolves to itself again, and history is kept', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm3', body('p-keep', 'p-dupe'), 'k1');
    await decide(h, 'u-owner', 'm3', 'approved', 'k2');
    const rev = await reverse(h, 'u-owner', 'm3', 'k3');
    expect(rev.status).toBe(200);
    expect(mergeOf(rev).status).toBe('reversed');
    expect(mergeOf(rev).link?.reversed).toBe(true);
    // The merge no longer takes effect — the duplicate resolves to itself once more.
    expect((await canonical(h, 'u-mgr', 'p-dupe')).body).toMatchObject({ canonicalProductId: 'p-dupe', merged: false });
    // Reversing again is refused — it is already reversed (nothing to undo twice).
    expect((await reverse(h, 'u-owner', 'm3', 'k4')).status).toBe(409);
  });

  it('a merge can be REJECTED — nothing is merged, the rejection is kept, and it cannot then be reversed', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm4', body('p-keep', 'p-dupe'), 'k1');
    const rej = await decide(h, 'u-owner', 'm4', 'rejected', 'k2');
    expect(rej.status).toBe(200);
    expect(mergeOf(rej).status).toBe('rejected');
    expect((await canonical(h, 'u-mgr', 'p-dupe')).body).toMatchObject({ merged: false });
    // A rejected merge never took effect, so there is nothing to reverse; and it cannot be decided again.
    expect((await reverse(h, 'u-owner', 'm4', 'k3')).status).toBe(409);
    expect((await decide(h, 'u-owner', 'm4', 'approved', 'k4')).status).toBe(409);
  });

  it('gates the two steps on distinct permissions: a manager cannot approve, a cashier cannot propose', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm5', body('p-keep', 'p-dupe'), 'k1');
    // The manager proposed it but cannot approve it — approval is a separate authority (like price approve).
    expect((await decide(h, 'u-mgr', 'm5', 'approved', 'k2')).status).toBe(403);
    // A cashier cannot even propose a merge.
    expect((await propose(h, 'u-cashier', 'm6', body('p-a', 'p-b'), 'k3')).status).toBe(403);
    // Reads are open to any catalogue reader (the manager).
    expect((await list(h, 'u-mgr')).status).toBe(200);
  });

  it('the review surface lists every merge, pending first, with a pending count', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm-a', body('p1', 'p2'), 'k1');
    await propose(h, 'u-mgr', 'm-b', body('p3', 'p4'), 'k2');
    await decide(h, 'u-owner', 'm-b', 'approved', 'k3');
    const l = await list(h, 'u-owner');
    expect(l.status).toBe(200);
    const b = l.body as { count: number; pendingCount: number; merges: { status: string }[] };
    expect(b.count).toBe(2);
    expect(b.pendingCount).toBe(1);
    expect(b.merges[0]?.status).toBe('pending'); // the one still waiting on a decision is first
  });

  it('refuses nonsense at the boundary: self-merge (422), no reason (400), unknown merge (404), bad decision (400)', async () => {
    const h = await cast();
    // A product cannot be merged into itself.
    const self = await propose(h, 'u-mgr', 'm7', body('p-x', 'p-x'), 'k1');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('a_product_cannot_merge_into_itself');
    // A merge with no reason is never recorded.
    expect((await propose(h, 'u-mgr', 'm8', { keepProductId: 'p-a', supersedeProductId: 'p-b', reason: '  ' }, 'k2')).status).toBe(400);
    // Deciding a merge that was never proposed is a 404.
    expect((await decide(h, 'u-owner', 'never-proposed', 'approved', 'k3')).status).toBe(404);
    // A decision that is neither approved nor rejected is a 400.
    await propose(h, 'u-mgr', 'm9', body('p-a', 'p-b'), 'k4');
    expect((await decide(h, 'u-owner', 'm9', 'maybe', 'k5')).status).toBe(400);
  });

  it('a decided merge is not re-opened by re-proposing its id (409)', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm10', body('p-keep', 'p-dupe'), 'k1');
    await decide(h, 'u-owner', 'm10', 'approved', 'k2');
    const again = await propose(h, 'u-mgr', 'm10', body('p-keep', 'p-dupe'), 'k3');
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('merge_already_decided');
  });

  it('survives a restart: the merge lifecycle is rebuilt from the event store', async () => {
    const h = await cast();
    await propose(h, 'u-mgr', 'm11', body('p-keep', 'p-dupe'), 'k1');
    await decide(h, 'u-owner', 'm11', 'approved', 'k2');
    // A fresh harness over the SAME store is a cold start — the read model is folded from events, not memory.
    const restarted = apiHarness({ store: h.store });
    expect((await canonical(restarted, 'u-owner', 'p-dupe')).body).toMatchObject({ canonicalProductId: 'p-keep', merged: true });
    const l = await list(restarted, 'u-owner');
    expect((l.body as { merges: { status: string }[] }).merges[0]?.status).toBe('approved');
  });
});
