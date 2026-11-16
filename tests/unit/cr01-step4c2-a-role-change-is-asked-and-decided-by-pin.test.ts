import { describe, it, expect } from 'vitest';
import { createRoleChangeSession, permissionWords, roleChangeDoorsFrom, storePcRoleDecide, ROLE_CHANGE_COPY, type RolesView } from '../../apps/web-erp/src/role-change-session';
import { privilegeApiPath, privilegeDoorOf, PRIVILEGE_AUTHORITY } from '../../edge/store-edge/src/office-privilege';
import { PRIVILEGE_KINDS } from '../../packages/identity/src/privilege-seal';

/**
 * **CR-01 step 4c-2 · ADR-0034 · ADR-0033 §2 · OB-740 "B" · OB-809 A: the Users & roles page's "Change what a role may do",
 * and the store computer's two doors for it.**
 *   • Every permission has plain words in English and Tamil; the ones OB-809 names carry their own.
 *   • Asking on the store PC goes through the store computer's door with the asker's PIN, typed again; at head office it is
 *     the person's own approval request for exactly the change. A cancelled PIN sends nothing.
 *   • On the Approvals page a role change on the store PC is decided through the store computer's door with the approver's
 *     PIN; every other request goes the ordinary way.
 *   • A locked role, a never-list area and the owner's reserved powers are not offered.
 */

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(answer: (url: string) => { status: number; body: unknown }): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, json: async () => a.body } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const MANAGER = { userId: 'u-mgr', permissions: ['identity.role.adjust', 'identity.role.request'] };
const DOORS = (pin: string | null) => roleChangeDoorsFrom(
  { rolePermissions: '/office/privilege/role-permissions', roleDecide: '/office/privilege/role-permissions/{approvalId}/decide' },
  async () => pin,
)!;
const INDENTS = { roleId: 'warehouse_user', permission: 'inventory.indent.read', change: 'add' as const, reason: 'they fill the shelves' };

describe('CR-01 step 4c-2: plain words for every permission', () => {
  it('the permissions OB-809 names read in plain English and Tamil', () => {
    expect(permissionWords('inventory.indent.read', 'en')).toMatch(/floor indents/i);
    expect(permissionWords('inventory.goodsreceipt.read', 'en')).toMatch(/Goods receipt review/);
    expect(permissionWords('inventory.indent.read', 'ta')).toMatch(/தளக் கோரிக்கை/);
  });
  it('any other permission is put together from its area, thing and act — never left blank', () => {
    expect(permissionWords('payroll.run.approve', 'en')).toBe('Payroll — run: approve');
    expect(permissionWords('payroll.run.approve', 'ta')).toBe('சம்பளம் — run: ஒப்புதல் அளித்தல்');
    expect(permissionWords('loyalty.read', 'en')).toBe('Loyalty: see');
  });
  it('every English word on the section has a Tamil twin', () => {
    expect(Object.keys(ROLE_CHANGE_COPY.ta).sort()).toEqual(Object.keys(ROLE_CHANGE_COPY.en).sort());
  });
});

describe('CR-01 step 4c-2: asking for a role change', () => {
  it('on the store PC: the asker\'s PIN, then the store computer\'s door with exactly the change — nothing else', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true, en: 'Asked.', result: { requestId: 'areq-1' } } }));
    const s = createRoleChangeSession({ viewer: MANAGER, fetch: f.fetch, doors: DOORS('123456'), newId: () => 'rpc-1' });
    const out = await s.ask(INDENTS);
    expect(out).toEqual({ result: 'ok', value: { requestId: 'rpc-1', approvalId: 'areq-1', words: 'Asked.' } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('/office/privilege/role-permissions');
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ pin: '123456', request: { requestId: 'rpc-1', ...INDENTS } });
  });
  it('a cancelled PIN sends nothing', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const s = createRoleChangeSession({ viewer: MANAGER, fetch: f.fetch, doors: DOORS(null) });
    expect(await s.ask(INDENTS)).toEqual({ result: 'invalid', why: 'pinNeeded' });
    expect(f.calls).toHaveLength(0);
  });
  it('at head office: the person\'s own approval request for exactly the change and its request id', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { requestId: 'areq-2' } }));
    const s = createRoleChangeSession({ viewer: MANAGER, fetch: f.fetch, newId: () => 'rpc-2' });
    expect(await s.ask(INDENTS)).toMatchObject({ result: 'ok', value: { requestId: 'rpc-2', approvalId: 'areq-2' } });
    expect(f.calls[0]!.url).toBe('/v1/approvals/requests');
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toMatchObject({ kind: 'role_permission_change', subjectRef: 'rpc-2', details: { ...INDENTS, requestId: 'rpc-2' }, valueMinor: null });
  });
  it('nobody signed in, or a role without the word, may not ask; a reason is required', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    expect(await createRoleChangeSession({ viewer: undefined, fetch: f.fetch }).ask(INDENTS)).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createRoleChangeSession({ viewer: { userId: 'u-cash', permissions: ['pos.sale.create'] }, fetch: f.fetch }).ask(INDENTS)).toEqual({ result: 'invalid', why: 'cannot' });
    expect(await createRoleChangeSession({ viewer: MANAGER, fetch: f.fetch }).ask({ ...INDENTS, reason: ' ' })).toEqual({ result: 'invalid', why: 'needReason' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('CR-01 step 4c-2: what is offered', () => {
  const view: RolesView = {
    roles: [
      { roleId: 'warehouse_user', name: 'Warehouse user', locked: null, permissions: ['inventory.availability.read'], added: [], removed: [] },
      { roleId: 'store_computer', name: 'Store computer', locked: 'it belongs to a machine', permissions: ['inventory.indent.read'], added: [], removed: [] },
      { roleId: 'owner', name: 'Owner', locked: null, permissions: ['inventory.indent.read', 'payroll.run.approve', 'identity.role.adjust', 'inventory.availability.read'], added: [], removed: [] },
    ],
    productPermissions: ['identity.role.adjust', 'inventory.availability.read', 'inventory.indent.read', 'payroll.run.approve'],
    ownerReserved: ['payroll.run.approve'],
    lockedAreas: [{ match: 'identity.role.', words: 'it decides who may change roles' }],
    history: [],
  };
  const s = createRoleChangeSession({ viewer: MANAGER });
  it('an ordinary read permission for a person\'s role is offered', () => {
    expect(s.offered(view, 'warehouse_user', 'inventory.indent.read')).toBe(true);
  });
  it('a machine\'s role, a never-list area and the owner\'s reserved powers are not', () => {
    expect(s.offered(view, 'store_computer', 'inventory.indent.read')).toBe(false);
    expect(s.offered(view, 'warehouse_user', 'identity.role.adjust')).toBe(false);
    expect(s.offered(view, 'warehouse_user', 'payroll.run.approve')).toBe(false);
  });
});

describe('CR-01 step 4c-2: deciding on the Approvals page', () => {
  const fallbackCalls: string[] = [];
  const fallback = async (i: { requestId: string; decision: 'approved' | 'rejected'; reason: string; kind?: string }) => { fallbackCalls.push(i.requestId); return { result: 'decided' as const, decision: i.decision, decidedBy: 'u-owner' }; };

  it('a role change on the store PC: the approver\'s PIN, then the store computer\'s door; applied at once is said', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true, en: 'Approved and done', result: { applied: true } } }));
    const decide = storePcRoleDecide(DOORS('654321'), fallback, f.fetch);
    const out = await decide({ requestId: 'areq-9', decision: 'approved', reason: 'agreed', kind: 'role_permission_change' });
    expect(out).toMatchObject({ result: 'decided', decision: 'approved', roleChange: { applied: true } });
    expect(f.calls[0]!.url).toBe('/office/privilege/role-permissions/areq-9/decide');
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ pin: '654321', request: { decision: 'approved', reason: 'agreed' } });
  });
  it('approved but not applied is said as not applied (P-08)', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true, en: 'Approved, but not applied', result: { applied: false } } }));
    const out = await storePcRoleDecide(DOORS('654321'), fallback, f.fetch)({ requestId: 'areq-9', decision: 'approved', reason: 'agreed', kind: 'role_permission_change' });
    expect(out).toMatchObject({ result: 'decided', roleChange: { applied: false } });
  });
  it('every other request goes the ordinary way; a cancelled PIN decides nothing', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    await storePcRoleDecide(DOORS('1'), fallback, f.fetch)({ requestId: 'areq-price', decision: 'approved', reason: 'ok', kind: 'price_change' });
    expect(fallbackCalls).toContain('areq-price');
    const none = await storePcRoleDecide(DOORS(null), fallback, f.fetch)({ requestId: 'areq-9', decision: 'approved', reason: 'ok', kind: 'role_permission_change' });
    expect(none).toMatchObject({ result: 'refused', code: 'pin_needed' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('CR-01 step 4c-2: the store computer\'s doors', () => {
  it('both doors are recognised and relayed to head office\'s routes', () => {
    expect(privilegeDoorOf('/office/privilege/role-permissions')).toEqual({ kind: 'role_permission_request' });
    expect(privilegeDoorOf('/office/privilege/role-permissions/areq-1/decide')).toEqual({ kind: 'role_permission_decision', grantId: 'areq-1' });
    expect(privilegeApiPath('role_permission_request')).toBe('/v1/identity/box/role-permissions');
    expect(privilegeApiPath('role_permission_decision', 'areq-1')).toBe('/v1/identity/box/role-permissions/areq-1/decide');
  });
  it('the PIN is checked holding the role-change word, for both people (OB-740 "B")', () => {
    expect(PRIVILEGE_AUTHORITY.role_permission_request).toBe('identity.role.adjust');
    expect(PRIVILEGE_AUTHORITY.role_permission_decision).toBe('identity.role.adjust');
    expect(PRIVILEGE_KINDS).toEqual(expect.arrayContaining(['role_permission_request', 'role_permission_decision']));
  });
  it('the page\'s doors are read only from the store computer\'s own /office/ paths', () => {
    expect(roleChangeDoorsFrom({ rolePermissions: 'https://elsewhere/x', roleDecide: '/office/privilege/role-permissions/{approvalId}/decide' }, async () => '1')).toBeUndefined();
    expect(roleChangeDoorsFrom(undefined, async () => '1')).toBeUndefined();
  });
});
