import { describe, it, expect } from 'vitest';
import { createUsersSession, applyCall, readIds, USERS_COPY, type Holder } from '../../apps/web-erp/src/users-session';

/** Round 4c: the Users & roles session — what it refuses before anything is sent, and exactly what it sends. */

type Sent = { method: string; path: string; body: unknown };
function fakeHeadOffice(answers: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const value = answers[`${init.method} ${path}`] ?? {};
    return { ok: true, status: 200, json: async () => value } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const ALL = ['identity.role.read', 'identity.role.request', 'identity.role.grant'];
const ids = () => { let n = 0; return (p: string) => `${p}-${++n}`; };

describe('the Users & roles session', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(USERS_COPY.ta).sort()).toEqual(Object.keys(USERS_COPY.en).sort());
  });

  it('refuses before sending: nobody named, no word, a role for yourself, a waiting role, blanks', async () => {
    const ho = fakeHeadOffice();
    expect(await createUsersSession({ viewer: undefined, fetch: ho.fetch }).holders()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createUsersSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch }).holders()).toEqual({ result: 'invalid', why: 'cannotAsk' });
    expect(await createUsersSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch }).roles()).toEqual({ result: 'invalid', why: 'cannotRead' });
    const s = createUsersSession({ viewer: { userId: 'u-mgr', permissions: ALL }, fetch: ho.fetch });
    const give = (userId: string, roleId: string, stores: string, reason: string) => s.give({ userId, roleId, stores, reason }, ['purchase_user']);
    expect(await give('u-mgr', 'cashier', 'all', 'x')).toEqual({ result: 'invalid', why: 'yourself' });
    expect(await give('u-new', 'purchase_user', 'all', 'x')).toEqual({ result: 'invalid', why: 'waitingRole' });
    expect(await give('', 'cashier', 'all', 'x')).toEqual({ result: 'invalid', why: 'needPerson' });
    expect(await give('u-new', 'cashier', ' , ', 'x')).toEqual({ result: 'invalid', why: 'needStores' });
    expect(await give('u-new', 'cashier', 'all', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.decide('g-1', 'reject', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(ho.sent).toEqual([]);
  });

  it('gives a role in the caller\'s own name (no requester or approver in the body)', async () => {
    const ho = fakeHeadOffice();
    const s = createUsersSession({ viewer: { userId: 'u-mgr', permissions: ALL }, fetch: ho.fetch, newId: ids() });
    expect(await s.give({ userId: ' u-new ', roleId: 'cashier', stores: 'store-2, store-1', reason: ' Monday ' }, [])).toEqual({ result: 'ok', value: { grantId: 'grant-1' } });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/identity/grants', body: { grantId: 'grant-1', userId: 'u-new', roleId: 'cashier', branchScope: ['store-1', 'store-2'], reason: 'Monday' } }]);
  });

  it('taking one role back asks for a mover that keeps the others; the only role is a leaver; the approved change is applied exactly', async () => {
    const ho = fakeHeadOffice({ 'POST /v1/approvals/requests': { requestId: 'areq-1' } });
    const s = createUsersSession({ viewer: { userId: 'u-mgr', permissions: ALL }, fetch: ho.fetch, newId: ids() });
    const h: Holder = { userId: 'u-c', grants: [{ userId: 'u-c', roleId: 'cashier', branchScope: ['store-1'] }, { userId: 'u-c', roleId: 'security_reviewer', branchScope: 'all' }] };
    expect(await s.askTakeBack(h, h.grants[1]!, 'not the reviewer now')).toEqual({ result: 'ok', value: { requestId: 'areq-1' } });
    const asked = ho.sent[0]!.body as { kind: string; subjectRef: string; details: Record<string, unknown> };
    expect(asked).toMatchObject({ kind: 'access_change', subjectRef: 'access-1' });
    expect(asked.details).toEqual({ event: 'mover', userId: 'u-c', reason: 'not the reviewer now', grants: [{ userId: 'u-c', roleId: 'cashier', branchScope: ['store-1'] }], requestId: 'access-1' });
    expect(await s.askTakeBack({ userId: 'u-c', grants: [h.grants[0]!] }, h.grants[0]!, 'x')).toEqual({ result: 'invalid', why: 'onlyRole' });
    expect(await s.askTakeBack({ userId: 'u-mgr', grants: [] }, 'leaver', 'x')).toEqual({ result: 'invalid', why: 'yourself' });
    const change = { requestId: 'areq-1', kind: 'access_change' as const, subjectRef: 'access-1', summary: '', status: 'approved' as const, details: asked.details, requestedAt: '' };
    expect(applyCall(change)).toEqual({ path: '/v1/access/lifecycle/access-1', body: { event: 'mover', userId: 'u-c', reason: 'not the reviewer now', grants: [{ userId: 'u-c', roleId: 'cashier', branchScope: ['store-1'] }] } });
    expect(await s.apply({ ...change, status: 'waiting' })).toEqual({ result: 'invalid', why: 'notReady' });
  });

  it('a limit asks for exactly the scope route\'s details: departments, or suppliers, categories and locations', async () => {
    const ho = fakeHeadOffice({ 'POST /v1/approvals/requests': { requestId: 'areq-2' } });
    const s = createUsersSession({ viewer: { userId: 'u-mgr', permissions: ALL }, fetch: ho.fetch });
    await s.askLimit({ userId: 'u-c', roleId: 'cashier', dimension: 'departments', values: 'D-dairy', reason: 'dairy' });
    await s.askLimit({ userId: 'u-c', roleId: 'cashier', dimension: 'locations', values: 'all', reason: 'lift' });
    expect(ho.sent.map((x) => x.body)).toEqual([
      expect.objectContaining({ kind: 'department_scope_change', subjectRef: 'u-c/cashier', details: { departments: ['D-dairy'], reason: 'dairy', userId: 'u-c', roleId: 'cashier' } }),
      expect.objectContaining({ kind: 'role_scope_change', subjectRef: 'u-c/cashier/locations', details: { values: 'all', reason: 'lift', userId: 'u-c', roleId: 'cashier', dimension: 'locations' } }),
    ]);
    expect(applyCall({ requestId: 'r', kind: 'role_scope_change', subjectRef: '', summary: '', status: 'approved', requestedAt: '', details: { values: 'all', reason: 'lift', userId: 'u-c', roleId: 'cashier', dimension: 'locations' } }))
      .toEqual({ path: '/v1/identity/role-scopes/u-c/cashier/locations', body: { values: 'all', reason: 'lift' } });
    expect(readIds(' all ')).toBe('all'); expect(readIds('b, a, a')).toEqual(['a', 'b']); expect(readIds(' ')).toBeUndefined();
  });
});
