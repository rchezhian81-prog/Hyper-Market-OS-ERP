import { describe, it, expect } from 'vitest';
import type { RequestContext } from '../../services/kernel/src/index';
import {
  freeSampleRoutes, type FreeSampleDeps, type FreeSampleIssue, type FreeSampleRequest, type FreeSampleDecision, type FreeSampleGrant,
  freeSampleApproverRefusal, storeManagersOf,
} from '../../services/inventory/src/free-samples';
import type { ItcReversal } from '../../packages/input-tax/src/index';
import { createFreeSampleSession } from '../../apps/web-erp/src/free-sample-session';

/**
 * **OB-393 (owner decision, 26 Oct 2026) — a store manager other than the giver approves each free sample before the
 * stock and the GST change.** The route rule over in-memory records, and the screen's session.
 */

const AT = '2026-10-26T10:00:00.000Z';

function world() {
  const requests: FreeSampleRequest[] = [];
  const decisions: FreeSampleDecision[] = [];
  const issues: FreeSampleIssue[] = [];
  const reversals: ItcReversal[] = [];
  const audit: string[] = [];
  // OB-396: who holds which role where — u-mgr1 and u-mgr2 manage every store; u-owner is the owner.
  const grants: FreeSampleGrant[] = [
    { userId: 'u-mgr1', roleId: 'store_manager', branchScope: 'all' },
    { userId: 'u-mgr2', roleId: 'store_manager', branchScope: 'all' },
    { userId: 'u-owner', roleId: 'owner', branchScope: 'all' },
  ];
  const deps: FreeSampleDeps = {
    now: () => AT,
    requests: async () => requests, recordRequest: async (_t, r) => { requests.push(r); },
    decisions: async () => decisions, recordDecision: async (_t, d) => { decisions.push(d); },
    issues: async () => issues, recordIssue: async (_t, i) => { issues.push(i); },
    unitCostAt: async () => 5_000,
    ownersOfStockAt: async () => [],
    bills: async () => [{ invoiceId: 'B1', capturedAt: '2026-10-01T10:00:00Z', productId: 'rice', lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250 }],
    lockedMonths: async () => new Set(),
    recordReversal: async (_t, r) => { reversals.push(r); return r; },
    checks: async () => [], recordCheck: async () => {},
    tradingDay: async () => '2026-10-26',
    grants: async () => grants,
    recordAudit: (_t, e) => { audit.push(`${e.actorId}:${e.action}`); },
  };
  const routes = freeSampleRoutes(deps);
  const route = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  const ctx = (userId: string, params: Record<string, string>, body?: unknown): RequestContext =>
    ({ tenantId: 'T', userId, branchId: null, scope: 'all', params, query: {}, body, idempotencyKey: `k-${userId}`, traceId: 't' }) as RequestContext;
  const give = async (userId: string, id: string) => route('POST', '/v1/inventory/free-samples/:issueId').handler(ctx(userId, { issueId: id }, { productId: 'rice', locationId: 'wh-1', qty: 2, uom: 'ea', note: 'tasting' }));
  const decide = async (userId: string, id: string, decision: string, reason = 'seen at the counter') => route('POST', '/v1/inventory/free-samples/:issueId/decision').handler(ctx(userId, { issueId: id }, { decision, reason }));
  const pending = async () => route('GET', '/v1/inventory/free-samples/pending').handler(ctx('u-mgr2', {}));
  return { requests, decisions, issues, reversals, audit, grants, give, decide, pending };
}

const codeOf = async (p: unknown): Promise<string> => {
  try { await p; return 'no refusal'; } catch (e) { return (e as { body?: { code?: string } }).body?.code ?? `other: ${String(e)}`; }
};

describe('a free sample waits for a store manager other than the giver (OB-393)', () => {
  it('recorded: waiting, nothing moved, no credit given back; listed as pending', async () => {
    const w = world();
    const r = await w.give('u-mgr1', 'fs-1');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'awaiting_approval' });
    expect([w.issues.length, w.reversals.length]).toEqual([0, 0]);
    expect((await w.pending()).body).toMatchObject({ count: 1, pending: [{ issueId: 'fs-1', requestedBy: 'u-mgr1' }] });
  });

  it('the giver approving their own is refused by name; nothing moves', async () => {
    const w = world();
    await w.give('u-mgr1', 'fs-1');
    expect(await codeOf(w.decide('u-mgr1', 'fs-1', 'approve'))).toBe('free_sample_self_approval');
    expect(await codeOf(w.decide('u-mgr1', 'fs-1', 'reject'))).toBe('free_sample_self_approval');
    expect([w.issues.length, w.reversals.length, w.decisions.length]).toEqual([0, 0, 0]);
  });

  it('another store manager approves: the stock leaves and the give-back is placed, both people named; once only', async () => {
    const w = world();
    await w.give('u-mgr1', 'fs-1');
    const r = await w.decide('u-mgr2', 'fs-1', 'approve');
    expect(r.status).toBe(201);
    expect(w.issues).toEqual([expect.objectContaining({ issueId: 'fs-1', issuedBy: 'u-mgr1', approvedBy: 'u-mgr2', returnMonth: '2026-10' })]);
    expect(w.reversals).toEqual([expect.objectContaining({ reversalId: 'free-sample-fs-1', cgstMinor: 250, sgstMinor: 250 })]);
    expect(w.audit).toEqual(['u-mgr1:stock.free_sample.request', 'u-mgr2:stock.free_sample']);
    expect((await w.decide('u-mgr2', 'fs-1', 'approve')).status).toBe(200); // the same decider again: the same answer
    expect(await codeOf(w.decide('u-owner', 'fs-1', 'reject'))).toBe('free_sample_already_decided');
    expect(w.issues.length).toBe(1);
    expect((await w.pending()).body).toMatchObject({ count: 0 });
  });

  it('rejected: kept with the reason, nothing moves; a decision needs a reason; an unknown sample is not found', async () => {
    const w = world();
    await w.give('u-mgr1', 'fs-1');
    expect(await codeOf(w.decide('u-mgr2', 'fs-1', 'maybe'))).toBe('not_readable_as_a_free_sample_decision');
    expect(await codeOf(w.decide('u-mgr2', 'fs-1', 'approve', ' '))).toBe('not_readable_as_a_free_sample_decision');
    expect(await codeOf(w.decide('u-mgr2', 'fs-9', 'approve'))).toBe('not_found');
    expect((await w.decide('u-mgr2', 'fs-1', 'reject', 'not an approved tasting')).status).toBe(201);
    expect(w.decisions).toEqual([expect.objectContaining({ decision: 'rejected', reason: 'not an approved tasting', by: 'u-mgr2' })]);
    expect([w.issues.length, w.reversals.length]).toEqual([0, 0]);
    expect(await codeOf(w.give('u-mgr1', 'fs-1'))).toBe('free_sample_already_recorded'); // an id is used once
  });
});

describe('OB-396: who decides a free sample — a store manager of that store; the owner only when the giver is its only one', () => {
  const sm = (userId: string, branchScope: readonly string[] | 'all' = 'all'): FreeSampleGrant => ({ userId, roleId: 'store_manager', branchScope });
  const owner: FreeSampleGrant = { userId: 'u-owner', roleId: 'owner', branchScope: 'all' };
  const judge = (approver: string, giver: string, grants: FreeSampleGrant[], store = 'store-1') => freeSampleApproverRefusal({ approver, giver, store, grants })?.code ?? 'may decide';

  it('the store managers of a store are those whose live grant reaches it', () => {
    expect(storeManagersOf([sm('a'), sm('b', ['store-1']), sm('c', ['store-2']), owner, sm('a', ['store-1'])], 'store-1')).toEqual(['a', 'b']);
  });

  it('another store manager of that store may; one of another store, a cashier or the giver may not', () => {
    expect(judge('b', 'a', [sm('a'), sm('b', ['store-1'])])).toBe('may decide');
    expect(judge('c', 'a', [sm('a'), sm('c', ['store-2'])])).toBe('free_sample_approver_not_a_store_manager');
    expect(judge('u-cash', 'a', [sm('a'), sm('b'), { userId: 'u-cash', roleId: 'cashier', branchScope: 'all' }])).toBe('free_sample_approver_not_a_store_manager');
  });

  it('the owner may ONLY when the giver is the only store manager of that store — refused by name otherwise, naming who may', () => {
    expect(judge('u-owner', 'a', [sm('a'), owner])).toBe('may decide');
    expect(judge('u-owner', 'a', [sm('a'), sm('c', ['store-2']), owner])).toBe('may decide'); // c manages another store only
    const two = freeSampleApproverRefusal({ approver: 'u-owner', giver: 'a', store: 'store-1', grants: [sm('a'), sm('b'), owner] });
    expect(two?.code).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    expect(two?.nextSafeAction).toContain('Ask b');
    // A giver who is not a store manager: the owner may not; the store's store manager decides.
    expect(judge('u-owner', 'u-cash', [sm('b'), owner])).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    // OB-398 (owner, 26 Oct 2026): a store with NO store manager at all — the owner decides, never the giver.
    expect(judge('u-owner', 'u-cash', [owner])).toBe('may decide');
    expect(judge('u-owner', 'u-owner', [owner])).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    // An owner who is ALSO a store manager of that store decides as a store manager.
    expect(judge('u-owner', 'a', [sm('a'), sm('b'), owner, sm('u-owner', ['store-1'])])).toBe('may decide');
  });

  it('on the route: the owner is refused while another store manager exists, and decides once the giver is the only one; nothing moves on a refusal', async () => {
    const w = world();
    await w.give('u-mgr1', 'fs-1');
    expect(await codeOf(w.decide('u-owner', 'fs-1', 'approve'))).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    expect(await codeOf(w.decide('u-owner', 'fs-1', 'reject'))).toBe('free_sample_owner_only_when_the_giver_is_the_only_store_manager');
    expect([w.issues.length, w.decisions.length]).toEqual([0, 0]);
    w.grants.splice(w.grants.findIndex((g) => g.userId === 'u-mgr2'), 1); // u-mgr2's grant is revoked
    expect((await w.decide('u-owner', 'fs-1', 'approve')).status).toBe(201);
    expect(w.issues).toEqual([expect.objectContaining({ issuedBy: 'u-mgr1', approvedBy: 'u-owner' })]);
  });

  it('a store manager whose grant does not reach the sample\'s store is refused by name', async () => {
    const w = world();
    w.grants.push({ userId: 'u-mgr9', roleId: 'store_manager', branchScope: ['store-9'] });
    await w.give('u-mgr1', 'fs-1');
    expect(await codeOf(w.decide('u-mgr9', 'fs-1', 'approve'))).toBe('free_sample_approver_not_a_store_manager');
  });
});

describe('the write-off screen\'s free-sample session lists and decides (OB-393)', () => {
  const recorder = () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      return new Response(JSON.stringify({ pending: [], count: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it('may.approve follows the permission; the viewer\'s own sample is refused here before anything is sent; a reason is needed', async () => {
    const r = recorder();
    const s = createFreeSampleSession({ viewer: { userId: 'u-mgr1', permissions: ['inventory.movement.append', 'inventory.freesample.approve'] }, fetch: r.fetch, newKey: () => 'k' });
    expect(s.may).toEqual({ named: true, record: true, approve: true });
    expect(createFreeSampleSession({ viewer: { userId: 'u', permissions: ['inventory.movement.append'] }, fetch: r.fetch }).may.approve).toBe(false);
    expect(await s.decide({ issueId: 'fs-1', requestedBy: 'u-mgr1' }, 'approve', 'ok')).toEqual({ result: 'invalid', why: 'yours' });
    expect(await s.decide({ issueId: 'fs-1', requestedBy: 'u-mgr2' }, 'approve', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect((await s.pending()).result).toBe('ok');
    expect((await s.decide({ issueId: 'fs-1', requestedBy: 'u-mgr2' }, 'reject', 'not approved')).result).toBe('ok');
    expect(r.calls).toEqual([
      { url: '/v1/inventory/free-samples/pending', method: 'GET' },
      { url: '/v1/inventory/free-samples/fs-1/decision', method: 'POST', body: { decision: 'reject', reason: 'not approved' } },
    ]);
  });
});
