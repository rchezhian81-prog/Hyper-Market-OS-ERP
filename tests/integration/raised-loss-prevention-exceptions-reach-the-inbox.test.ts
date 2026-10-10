import { describe, it, expect, afterEach } from 'vitest';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { fetchLpWorklist, bootLpInbox } from '../../apps/web-erp/src/browser-entry';
import { createLpInboxSession } from '../../apps/web-erp/src/loss-prevention-inbox-session';

/**
 * **PF-07 — what the store's rules raise on head office's own record reaches the manager's investigations inbox (M15-FR-01
 * "an anomaly raises an exception → alert to the owner inbox" · P-03).**
 *
 * The no-sales and price overrides relayed from the box are judged by the store's rules at head office. Here the inbox's
 * OWN read (`fetchLpWorklist`, the code the served page runs) goes to the real API with the manager's session and the
 * tested inbox model shows each raised exception in words: what it is about, how far over the rule (money as ₹), the
 * cashier (an id, never a name), the linked actions and whether a case is open. A manager without `lp.case.read` sees
 * nothing of it.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa7a7';
const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

describe('PF-07 — raised exceptions are in the manager\'s inbox', () => {
  it('two no-sales over a limit of one and a ₹140 price cut over ₹50 → both raised, shown in words, with the case opened from one', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const call = (method: 'POST' | 'GET', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${Math.random()}` } : {}), ...(body === undefined ? {} : { body }) });
    expect((await call('POST', '/v1/loss-prevention/rules/no_sale', 'u-owner', { maxCount: 1 })).status).toBe(201);
    expect((await call('POST', '/v1/loss-prevention/rules/discount', 'u-owner', { maxSingleValueMinor: 5_000 })).status).toBe(201);
    const at = new Date().toISOString();
    const base = { laneId: 'lane-1', cashierId: 'u-lanecash', at, approvedBy: 'u-mgr' };
    for (const id of ['N-1', 'N-2']) {
      expect((await call('POST', `/v1/loss-prevention/activity/${id}/synced`, 'u-box', { ...base, activityId: id, kind: 'no_sale', reason: 'change_for_customer', valueMinor: 0, approvalId: `apr-${id}` })).status).toBe(201);
    }
    expect((await call('POST', '/v1/loss-prevention/activity/O-1/synced', 'u-box', {
      ...base, activityId: 'O-1', kind: 'price_override', billRef: 'B-1', lineId: 'L1', productId: 'P1', description: 'Ghee 1L',
      fromUnitMinor: 64_000, toUnitMinor: 50_000, quantityMinor: 1, valueMinor: 14_000, reason: 'damaged_pack', approvalId: 'apr-O-1',
    })).status).toBe(201);
    // The manager opens a case from the no-sale exception.
    // Today by the SHOP's calendar (its time zone and cut-off) — the day the inbox reads by default.
    const raisedNow = (await h.request({ method: 'GET', path: '/v1/loss-prevention/exceptions', userId: 'u-mgr', tenantId: T })).body as { exceptions: { exceptionId: string; kind: string }[] };
    const noSale = raisedNow.exceptions.find((x) => x.kind === 'no_sale')!;
    expect((await call('POST', '/v1/loss-prevention/cases/case-ns', 'u-owner', { raisedFromRef: noSale.exceptionId, subjectRef: 'u-lanecash', summary: 'drawer opened twice', valueMinor: 0, assignedTo: 'u-mgr' })).status).toBe(201);

    // The served page's own read, with the manager's session, straight into the real API.
    const asUser = (userId: string) => {
      globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
        const res = await h.raw({ method: (init?.method ?? 'GET') as HttpRequest['method'], path: new URL(url, 'http://shop.test').pathname, token: TEST_IDP.issue({ sub: userId, tenantId: T }) });
        return new Response(JSON.stringify(res.body), { status: res.status });
      }) as unknown as typeof globalThis.fetch;
    };
    asUser('u-mgr');
    const worklist = await fetchLpWorklist();
    expect(worklist?.raised?.length).toBe(2);
    const session = createLpInboxSession({ userId: 'u-mgr' }, { worklist: () => worklist!, mayRead: () => true, mayManage: () => true, closePort: () => ({ post: async () => 'refused' }) });
    const view = session.view('en');
    expect(view.raised.map((r) => [r.what, r.cashierId, r.breach])).toEqual(expect.arrayContaining([
      ['Drawer opened with no sale', 'u-lanecash', '2 today — the rule allows 1'],
      ['Price overrides', 'u-lanecash', 'One of ₹140.00 — the rule allows ₹50.00 at a time'],
    ]));
    expect(view.raised.find((r) => r.what === 'Drawer opened with no sale')).toMatchObject({ caseId: 'case-ns', caseLabel: 'Case opened: case-ns' });
    expect(view.raised.every((r) => r.status.label !== '' && r.status.icon !== '')).toBe(true); // never colour alone
    expect(session.view('ta').raised[0]!.what).not.toBe(view.raised[0]!.what); // in Tamil too

    // A person without lp.case.read reads nothing (the inbox boots read-denied, and the API refuses).
    asUser('u-cashier-nobody');
    expect(await fetchLpWorklist()).toBeNull();
    const denied = bootLpInbox({ userId: 'u-x', permissions: [] }, worklist!);
    expect(denied!.view('en').raised).toEqual([]);
  });
});
