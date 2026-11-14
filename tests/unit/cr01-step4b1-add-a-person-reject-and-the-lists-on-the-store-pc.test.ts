import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { PRIVILEGE_KINDS } from '../../packages/identity/src/privilege-seal';
import { PRIVILEGE_AUTHORITY, PRIVILEGE_WORDS, officeUsersView, privilegeAct, privilegeApiPath, privilegeDoorOf, usersViewApiPath, type PrivilegeDeps, type RelayAnswer } from '../../edge/store-edge/src/office-privilege';
import { createUsersSession, officePrivilegeFrom, usersWords } from '../../apps/web-erp/src/users-session';
import { foldPeople, type PersonSignInEvent } from '../../services/identity/src/people';
import { privilegeAlertWords, STORE_PC_PERSON_AUTHORITY } from '../../services/identity/src/box-privilege';
import { reviewAccess } from '../../packages/identity/src/access-review';

/**
 * **CR-01 step 4b-1 · OI-06 · ADR-0033 (amended) · OB-733 "A" · OB-735: on the store PC, adding a person and rejecting a
 * request are PIN-confirmed acts like giving and approving; the page reads its lists through the box; what does not work on
 * the store PC yet is said, never offered.**
 */

const KEY = privilegeSealKey(randomBytes(32).toString('base64url'));
const NOW = '2026-11-14T10:00:00.000Z';
const REQ = '0b0a8a6e-4c1d-4a5e-9f3b-2d7c6e5f4a3b';
const PIN = '482915';

function box(over: { relay?: RelayAnswer; read?: RelayAnswer | null } = {}) {
  const records: Record<string, unknown>[] = [];
  const relayed: { path: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  const pinAsked: { userId: string; authority: string }[] = [];
  const d: PrivilegeDeps = {
    tenantId: 't-sre', sealKey: KEY,
    relay: async (path, body) => { relayed.push({ path, body: body as Record<string, unknown> }); return over.relay ?? { status: 201, body: { ok: true } }; },
    ...(over.read === null ? {} : { read: async (path: string) => { reads.push(path); return over.read ?? { status: 200, body: { mayAsk: true, grants: [] } }; } }),
    verifyPin: async (userId, _pin, authority) => { pinAsked.push({ userId, authority }); return { ok: true }; },
    record: async (e) => { records.push(e); },
    now: () => NOW, newRequestId: () => REQ,
  };
  return { d, records, relayed, reads, pinAsked };
}

describe('the acts: who may, what is sealed', () => {
  it('a reject is its own sealed kind, and adding a person needs only the maker\'s word (OB-733 "A")', () => {
    expect(PRIVILEGE_KINDS).toContain('role_grant_rejection');
    expect(PRIVILEGE_AUTHORITY.person_provision).toBe('identity.role.request');
    expect(PRIVILEGE_AUTHORITY.person_provision).toBe(STORE_PC_PERSON_AUTHORITY);
    expect(PRIVILEGE_AUTHORITY.role_grant_rejection).toBe('identity.role.grant');
    expect(privilegeDoorOf('/office/privilege/grants/g-1/reject')).toEqual({ kind: 'role_grant_rejection', grantId: 'g-1' });
    expect(privilegeApiPath('role_grant_rejection', 'g 1')).toBe('/v1/identity/box/grants/g%201/reject');
    expect(usersViewApiPath('u mgr')).toBe('/v1/identity/box/users-view?for=u%20mgr');
  });

  it('adding a person: the PIN checked holding identity.role.request; ONLY the staff id and name are sealed — never a PIN', async () => {
    const { d, relayed, pinAsked, records } = box();
    const out = await privilegeAct(d, 'person_provision', { userId: 'u-mgr' }, { pin: PIN, request: { userId: ' Priya.K ', displayName: ' Priya K ', pin: PIN, role: 'owner' } });
    expect(out.status).toBe(200);
    expect(out.answer).toMatchObject({ ok: true, kind: 'person_provision', ...PRIVILEGE_WORDS.person_added });
    expect(pinAsked).toEqual([{ userId: 'u-mgr', authority: 'identity.role.request' }]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.path).toBe('/v1/identity/box/people');
    expect(relayed[0]!.body['body']).toEqual({ userId: 'priya.k', displayName: 'Priya K' });
    expect(JSON.stringify(relayed)).not.toContain(PIN);
    expect(JSON.stringify(records)).not.toContain(PIN);
    expect(records[0]).toMatchObject({ act: 'person_provision', outcome: 'sealed', forUserId: 'priya.k', displayName: 'Priya K' });
  });

  it('rejecting: a reason is required (≤ 300 characters), the PIN checked holding identity.role.grant, the reason sealed', async () => {
    for (const request of [undefined, {}, { reason: '  ' }, { reason: 'x'.repeat(301) }]) {
      const { d, relayed, pinAsked } = box();
      const out = await privilegeAct(d, 'role_grant_rejection', { userId: 'u-owner' }, { pin: PIN, request, grantId: 'g-1' });
      expect(out).toMatchObject({ status: 400, answer: { refusedBecause: 'not_readable' } });
      expect(relayed).toEqual([]);
      expect(pinAsked).toEqual([]);
    }
    const { d, relayed, pinAsked } = box({ relay: { status: 200, body: { state: 'rejected' } } });
    const out = await privilegeAct(d, 'role_grant_rejection', { userId: 'u-owner' }, { pin: PIN, request: { reason: ' not needed ' }, grantId: 'g-1' });
    expect(out.answer).toMatchObject({ ok: true, kind: 'role_grant_rejection', ...PRIVILEGE_WORDS.role_rejected });
    expect(pinAsked).toEqual([{ userId: 'u-owner', authority: 'identity.role.grant' }]);
    expect(relayed[0]).toMatchObject({ path: '/v1/identity/box/grants/g-1/reject', body: { kind: 'role_grant_rejection', body: { grantId: 'g-1', reason: 'not needed' } } });
  });

  it('every word the person reads has a Tamil twin, and none still says "comes in step 4b"', () => {
    for (const [k, w] of Object.entries(PRIVILEGE_WORDS)) {
      expect(w.ta, k).not.toBe('');
      expect(w.en).not.toMatch(/step 4b/);
    }
  });
});

describe('the lists through the box: for the person at the screen, never empty by silence', () => {
  it('reads head office for the signed-in person; nobody signed in reads nothing', async () => {
    const { d, reads } = box();
    expect(await officeUsersView(d, { userId: 'u-mgr' })).toEqual({ status: 200, answer: { ok: true, mayAsk: true, grants: [] } });
    expect(reads).toEqual(['/v1/identity/box/users-view?for=u-mgr']);
    const none = await officeUsersView(d, null);
    expect(none).toMatchObject({ status: 401, answer: { ok: false, refusedBecause: 'not_signed_in' } });
    expect(reads).toHaveLength(1);
  });

  it('head office silent, refusing, or not named — said as such, never an empty list', async () => {
    expect(await officeUsersView(box({ read: 'unreachable' }).d, { userId: 'u-mgr' })).toMatchObject({ status: 503, answer: { refusedBecause: 'head_office_unreachable' } });
    expect(await officeUsersView(box({ read: { status: 401, body: {} } }).d, { userId: 'u-mgr' })).toMatchObject({ status: 502, answer: { refusedBecause: 'head_office_refused' } });
    expect(await officeUsersView(box({ read: { status: 403, body: { error: { code: 'not_a_store_computer' } } } }).d, { userId: 'u-mgr' })).toMatchObject({ status: 403, answer: { code: 'not_a_store_computer' } });
    expect(await officeUsersView(box({ read: null }).d, { userId: 'u-mgr' })).toMatchObject({ status: 503, answer: { refusedBecause: 'not_set_up' } });
  });
});

describe('the Users & roles page on the store PC (4b-1)', () => {
  const DOORS = { grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view' };
  const owner = { userId: 'u-owner', permissions: ['identity.role.request', 'identity.role.grant', 'identity.role.read'] };
  const VIEW = {
    ok: true, mayAsk: true, mayRead: true,
    roles: [{ id: 'cashier', name: 'Cashier', nameTa: 'காசாளர்', permissions: ['pos.sale.sync'] }], awaitingOwnerApproval: [],
    grants: [{ userId: 'u-mgr', roleId: 'store_manager', branchScope: ['S1'] }, { userId: 'u-cash', roleId: 'cashier', branchScope: 'all' }],
    pending: [{ grantId: 'g-1', userId: 'priya.k', roleId: 'cashier', branchScope: ['S1'], requestedBy: 'u-mgr', requestedAt: NOW, reason: 'new', state: 'pending' }],
  };
  const fake = (answer: { status: number; body: unknown } = { status: 200, body: VIEW }) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const f = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { f, calls };
  };

  it('the doors are believed only when every one is the box\'s own', () => {
    expect(officePrivilegeFrom(DOORS, async () => PIN)).toBeDefined();
    for (const k of Object.keys(DOORS)) {
      expect(officePrivilegeFrom({ ...DOORS, [k]: undefined }, async () => PIN), k).toBeUndefined();
      expect(officePrivilegeFrom({ ...DOORS, [k]: `https://elsewhere${DOORS[k as keyof typeof DOORS]}` }, async () => PIN), k).toBeUndefined();
    }
  });

  it('the roles, who holds what and what waits come from the box\'s read — never from /v1', async () => {
    const { f, calls } = fake();
    const s = createUsersSession({ viewer: owner, fetch: f, office: officePrivilegeFrom(DOORS, async () => PIN)! });
    expect(s.onStorePc).toBe(true);
    const roles = await s.roles();
    expect(roles).toMatchObject({ result: 'ok', value: { live: [{ id: 'cashier', nameTa: 'காசாளர்' }], waiting: [] } });
    expect(await s.holders()).toEqual({ result: 'ok', value: [
      { userId: 'u-cash', grants: [{ userId: 'u-cash', roleId: 'cashier', branchScope: 'all' }] },
      { userId: 'u-mgr', grants: [{ userId: 'u-mgr', roleId: 'store_manager', branchScope: ['S1'] }] },
    ] });
    const pending = await s.pending();
    expect(pending).toMatchObject({ result: 'ok', value: [{ grantId: 'g-1', userId: 'priya.k', requestedBy: 'u-mgr', mine: false }] });
    expect(calls.map((c) => c.url)).toEqual(['/office/privilege/users-view', '/office/privilege/users-view', '/office/privilege/users-view']);
  });

  it('a list the box cannot read is said, never shown empty', async () => {
    const { f } = fake({ status: 503, body: { ok: false, refusedBecause: 'head_office_unreachable', en: PRIVILEGE_WORDS.head_office_unreachable.en } });
    const s = createUsersSession({ viewer: owner, fetch: f, office: officePrivilegeFrom(DOORS, async () => PIN)! });
    expect(await s.holders()).toEqual({ result: 'refused', status: 503, code: 'head_office_unreachable', whatHappened: PRIVILEGE_WORDS.head_office_unreachable.en });
  });

  it('reject asks the PIN and sends the reason to the box\'s reject door', async () => {
    const { f, calls } = fake({ status: 200, body: { ok: true } });
    const asked: string[] = [];
    const s = createUsersSession({ viewer: owner, fetch: f, office: officePrivilegeFrom(DOORS, async (w) => { asked.push(w); return PIN; })! });
    expect(await s.decide('g-1', 'reject', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.decide('g-1', 'reject', ' not needed ')).toEqual({ result: 'ok', value: { decided: 'rejected' } });
    expect(asked).toEqual(['reject']);
    expect(calls).toEqual([{ url: '/office/privilege/grants/g-1/reject', method: 'POST', body: { pin: PIN, request: { reason: 'not needed' } } }]);
  });

  it('add a person: a name and a staff id, the PIN asked, then the box\'s door — refused before the PIN when unreadable', async () => {
    const { f, calls } = fake({ status: 200, body: { ok: true } });
    const asked: string[] = [];
    const s = createUsersSession({ viewer: { userId: 'u-mgr', permissions: ['identity.role.request'] }, fetch: f, office: officePrivilegeFrom(DOORS, async (w) => { asked.push(w); return PIN; })! });
    expect(await s.addPerson({ userId: 'priya.k', displayName: ' ' })).toEqual({ result: 'invalid', why: 'needName' });
    expect(await s.addPerson({ userId: 'P K', displayName: 'Priya K' })).toEqual({ result: 'invalid', why: 'needStaffId' });
    expect(await s.addPerson({ userId: 'u-mgr', displayName: 'Mani' })).toEqual({ result: 'invalid', why: 'yourself' });
    expect(asked).toEqual([]);
    expect(await s.addPerson({ userId: 'Priya.K', displayName: ' Priya   K ' })).toEqual({ result: 'ok', value: { userId: 'priya.k' } });
    expect(asked).toEqual(['add']);
    expect(calls).toEqual([{ url: '/office/privilege/people', method: 'POST', body: { pin: PIN, request: { userId: 'priya.k', displayName: 'Priya K' } } }]);
    // A cashier is not offered it; away from the store PC it is not there at all.
    expect(await createUsersSession({ viewer: { userId: 'u-cash', permissions: [] }, fetch: f, office: officePrivilegeFrom(DOORS, async () => PIN)! }).addPerson({ userId: 'x.y', displayName: 'X Y' })).toEqual({ result: 'invalid', why: 'cannotAsk' });
    expect(await createUsersSession({ viewer: owner, fetch: f }).addPerson({ userId: 'x.y', displayName: 'X Y' })).toEqual({ result: 'invalid', why: 'notOnStorePc' });
  });

  it('take back, leaver, limits and "my changes" are not offered on the store PC yet — said, and nothing is sent', async () => {
    const { f, calls } = fake();
    const s = createUsersSession({ viewer: owner, fetch: f, office: officePrivilegeFrom(DOORS, async () => PIN)! });
    const holder = { userId: 'u-cash', grants: [{ userId: 'u-cash', roleId: 'cashier', branchScope: 'all' as const }] };
    expect(await s.askTakeBack(holder, 'leaver', 'left')).toEqual({ result: 'invalid', why: 'notOnStorePc' });
    expect(await s.askLimit({ userId: 'u-cash', roleId: 'cashier', dimension: 'departments', values: 'all', reason: 'x' })).toEqual({ result: 'invalid', why: 'notOnStorePc' });
    expect(await s.mine()).toEqual({ result: 'invalid', why: 'notOnStorePc' });
    expect(calls).toEqual([]);
    expect(usersWords('en', 'notOnStorePc')).toMatch(/Nothing was changed/);
    expect(usersWords('ta', 'storePcOnly')).not.toBe(usersWords('en', 'storePcOnly'));
  });

  it('the page offers "Add a person" on the store PC only, and hides take-back, limits and my changes there', () => {
    const html = readFileSync('apps/web-erp/web/users.html', 'utf8');
    const js = readFileSync('apps/web-erp/web/users.js', 'utf8');
    expect(html).toContain('id="add-form"');
    expect(html).toContain('id="store-pc-note"');
    expect(js).toContain("$('add').hidden = !onStorePc");
    expect(js).toContain("$('limit').hidden = onStorePc");
    expect(js).toContain("$('mine').hidden = onStorePc");
    expect(js).toContain('may.ask && !onStorePc && h.userId !== session.userId');
  });
});

describe('the store-PC person on the people register and the access review', () => {
  const at = (m: number) => `2026-11-14T10:${String(m).padStart(2, '0')}:00.000Z`;
  it('folds as store_pc with no second factor; a later sign-in at the identity server upgrades the same record', () => {
    const events: PersonSignInEvent[] = [{ type: 'PersonRecordedForStorePc', userId: 'priya.k', displayName: 'Priya K', recordedBy: 'u-mgr', storeId: 'S1', at: at(0) }];
    expect(foldPeople(events)).toEqual([{ userId: 'priya.k', username: 'priya.k', displayName: 'Priya K', state: 'store_pc', secondFactor: false, requestedBy: 'u-mgr', requestedAt: at(0) }]);
    // Recorded twice: the first stands.
    expect(foldPeople([...events, { ...events[0]!, displayName: 'Someone Else', at: at(1) } as PersonSignInEvent])[0]!.displayName).toBe('Priya K');
    const upgraded = foldPeople([...events,
      { type: 'PersonSignInRequested', userId: 'priya.k', username: 'priya', displayName: 'Priya K', secondFactor: true, requestedBy: 'u-it', at: at(2) },
      { type: 'PersonSignInIssued', userId: 'priya.k', issuedBy: 'u-it', resumed: false, at: at(3) }]);
    expect(upgraded).toEqual([expect.objectContaining({ userId: 'priya.k', username: 'priya', state: 'issued', secondFactor: true })]);
    expect(foldPeople([...events, { type: 'PersonSignInEnded', userId: 'priya.k', endedBy: 'u-owner', reason: 'leaver', at: at(4) }])[0]!.state).toBe('ended');
  });

  it('the access review shows them as "store PC only" — and flags a privileged role held without a second factor', () => {
    const rows = reviewAccess({
      people: [{ userId: 'priya.k', username: 'priya.k', displayName: 'Priya K', state: 'store_pc', secondFactor: false }],
      grants: [{ userId: 'priya.k', roleId: 'owner', branchScope: 'all' }],
      emergency: [], roles: [{ id: 'owner', name: 'Owner', permissions: ['identity.role.grant'] }], machineRoleIds: [], isItRole: () => false,
    });
    expect(rows[0]).toMatchObject({ userId: 'priya.k', signIn: 'store_pc', secondFactor: false });
    expect(rows[0]!.flags).not.toContain('holds_roles_with_no_sign_in');
    expect(rows[0]!.flags).toContain('privileged_without_second_factor');
  });

  it('the owner\'s alert names the person added and says they hold nothing yet', () => {
    const words = privilegeAlertWords({ requestId: REQ, kind: 'person_provision', actingUserId: 'u-mgr', subjectUserId: 'priya.k', roleId: '', branchScope: ['S1'], grantId: '', requestedBy: 'u-mgr', displayName: 'Priya K', confirmedAt: NOW, at: NOW, relayedBy: 'u-box', storeId: 'S1' });
    expect(words).toContain('u-mgr added a new person on the store PC: Priya K (staff id priya.k)');
    expect(words).toContain('They hold no role yet');
    expect(words).toContain(`(request ${REQ})`);
  });
});
