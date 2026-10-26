import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import type { ApiHarness } from '../support/api-harness';

/**
 * **OB-396 (owner decision, 26 Oct 2026): free samples are decided by a store manager other than the giver, and by the
 * owner ONLY when the giver is the only store manager of that store** — worked out on the server from head office's live
 * grants, on the live API, in memory and on real PostgreSQL, across a cold restart.
 *
 *   • store-1 has ONE store manager (u-solo); u-solo gives a sample there; the owner decides it — allowed;
 *   • a second store manager of store-1 is granted; u-solo gives another; the owner is now refused BY NAME, naming who
 *     may decide; nothing moves; the second store manager decides it;
 *   • a store manager of store-2 only cannot decide a store-1 sample;
 *   • the refusal is the same after a cold restart (the grants are read again from the store, never from the request).
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string; nextSafeAction?: string } }).error?.code;
const OWNER = 'u-owner';
const SOLO = 'u-solo';
const SECOND = 'u-second';
const ELSEWHERE = 'u-elsewhere';
const sample = { productId: 'p-biscuit', locationId: 'store-1', qty: 1, uom: 'ea', note: 'tasting at the biscuit aisle' };

describe.each(backings)('OB-396 — the owner decides a free sample only when the giver is the only store manager — on $name', ({ harness }) => {
  it('derived from the live grants; refused by name otherwise; the same after a cold restart', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, SOLO, 'store_manager', ['store-1']);
    await h.provisionRole(T, ELSEWHERE, 'store_manager', ['store-2']);
    const as = (hh: ApiHarness, userId: string, path: string, body: Record<string, unknown>, key: string, branchId?: string) =>
      hh.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body, ...(branchId === undefined ? {} : { branchId }) });
    const give = (id: string) => as(h, SOLO, `/v1/inventory/free-samples/${id}`, sample, `give-${id}`, 'store-1');
    const decide = (hh: ApiHarness, id: string, by: string, decision = 'approve', branchId?: string) => as(hh, by, `/v1/inventory/free-samples/${id}/decision`, { decision, reason: 'seen at the aisle' }, `dec-${id}-${by}-${decision}`, branchId);

    // ── 1 · u-solo is the only store manager of store-1: the owner decides.
    expect((await give('fs-1')).status).toBe(202);
    const ok = await decide(h, 'fs-1', OWNER);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body as { issue: { issuedBy: string; approvedBy: string } }).issue).toMatchObject({ issuedBy: SOLO, approvedBy: OWNER });

    // ── 2 · a second store manager of store-1: the owner is refused by name; the second one decides.
    await h.provisionRole(T, SECOND, 'store_manager', ['store-1']);
    expect((await give('fs-2')).status).toBe(202);
    const refused = await decide(h, 'fs-2', OWNER);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'free_sample_owner_only_when_the_giver_is_the_only_store_manager']);
    expect((refused.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toContain(`Ask ${SECOND}`);
    expect(codeOf(await decide(h, 'fs-2', OWNER, 'reject'))).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    // A store manager of another store only may not decide it either.
    expect((await decide(h, 'fs-2', ELSEWHERE, 'approve', 'store-2')).status).toBe(403);
    const waiting = (await h.request({ method: 'GET', path: '/v1/inventory/free-samples/pending', userId: SECOND, tenantId: T, branchId: 'store-1' })).body as { pending: { issueId: string }[] };
    expect(waiting.pending.map((p) => p.issueId)).toEqual(['fs-2']); // nothing moved on a refusal

    // ── 3 · a cold restart: the grants are read again; the owner is still refused, the second store manager decides.
    const h2 = harness(h);
    expect(codeOf(await decide(h2, 'fs-2', OWNER))).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    const second = await decide(h2, 'fs-2', SECOND, 'approve', 'store-1');
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((second.body as { issue: { approvedBy: string } }).issue.approvedBy).toBe(SECOND);
  }, 60_000);
});
