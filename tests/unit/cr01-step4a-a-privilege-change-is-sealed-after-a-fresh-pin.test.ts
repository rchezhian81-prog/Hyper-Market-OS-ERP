import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { privilegeSealKey, tillSealKey } from '../../packages/identity/src/till-seal';
import { checkPrivilegeRecord, sealPrivilegeRecord, type PrivilegeRecord } from '../../packages/identity/src/privilege-seal';
import { PRIVILEGE_AUTHORITY, PRIVILEGE_WORDS, privilegeAct, privilegeDoorOf, type PrivilegeDeps, type RelayAnswer } from '../../edge/store-edge/src/office-privilege';
import { boxPrivilegeRoutes } from '../../services/identity/src/box-privilege';
import { createUsersSession, officePrivilegeFrom } from '../../apps/web-erp/src/users-session';
import { askOfficePin, type PinDoc, type PinEl } from '../../apps/web-erp/src/office-pin-prompt';

/**
 * **CR-01 step 4a · OI-06 · ADR-0033 · OB-731 "A" · OB-732 "B": the store PC seals a privilege change only after the
 * person's PIN is checked AGAIN, holding the act's own permission — and never keeps the PIN.**
 */

const SECRET = randomBytes(32).toString('base64url');
const KEY = privilegeSealKey(SECRET);
const NOW = '2026-11-14T10:00:00.000Z';
const REQ = '0b0a8a6e-4c1d-4a5e-9f3b-2d7c6e5f4a3b';
const PIN = '482915';

function box(over: { pinOk?: boolean; relay?: RelayAnswer | null; sealKey?: Buffer | null; failRecord?: boolean } = {}) {
  const records: Record<string, unknown>[] = [];
  const relayed: { path: string; body: unknown; key: string }[] = [];
  const pinAsked: { userId: string; pin: string; authority: string }[] = [];
  const d: PrivilegeDeps = {
    tenantId: 't-sre',
    sealKey: over.sealKey === null ? undefined : (over.sealKey ?? KEY),
    relay: over.relay === null ? undefined : async (path, body, key) => { relayed.push({ path, body, key }); return over.relay ?? { status: 202, body: { grantId: 'g-1', state: 'pending' } }; },
    verifyPin: async (userId, pin, authority) => { pinAsked.push({ userId, pin, authority }); return over.pinOk === false ? { ok: false, laneMessage: 'Wrong PIN. 4 tries left.' } : { ok: true }; },
    record: async (e) => { if (over.failRecord === true) throw new Error('disk full'); records.push(e); },
    now: () => NOW,
    newRequestId: () => REQ,
  };
  return { d, records, relayed, pinAsked };
}
const request = { grantId: 'g-1', userId: 'u-new', roleId: 'cashier', branchScope: 'all', reason: 'morning shift' };

describe('the key: its own secret, its own label', () => {
  it('privilegeSealKey differs from the till seal key made from the same text, and refuses a short secret', () => {
    expect(privilegeSealKey(SECRET).equals(tillSealKey(SECRET))).toBe(false);
    expect(() => privilegeSealKey('short')).toThrow(RangeError);
  });

  it('a record sealed with the privilege key checks; with the till seal key it does not', () => {
    const r: PrivilegeRecord = { kind: 'role_request', tenantId: 't-sre', userId: 'u-mgr', requestId: REQ, confirmedAt: NOW, via: 'office_pin', body: request };
    const nowMs = Date.parse(NOW) + 10_000;
    expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 't-sre', relayed: sealPrivilegeRecord(KEY, r), nowMs })).toMatchObject({ ok: true });
    expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 't-sre', relayed: sealPrivilegeRecord(tillSealKey(SECRET), r), nowMs })).toMatchObject({ ok: false, refusedBecause: 'privilege_seal_does_not_match' });
    expect(checkPrivilegeRecord(undefined, { kind: 'role_request', tenantId: 't-sre', relayed: sealPrivilegeRecord(KEY, r), nowMs })).toMatchObject({ ok: false });
    expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 'another-shop', relayed: sealPrivilegeRecord(KEY, r), nowMs })).toMatchObject({ ok: false, refusedBecause: 'privilege_record_does_not_match' });
    expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 't-sre', relayed: { ...sealPrivilegeRecord(KEY, r), pin: PIN }, nowMs })).toMatchObject({ ok: false, refusedBecause: 'privilege_record_not_readable' });
  });
});

describe('the box: a fresh PIN check with the act\'s own permission, then a seal — never the PIN', () => {
  it('asking for a role: the PIN is checked holding identity.role.request, then the record is sealed and relayed', async () => {
    const { d, records, relayed, pinAsked } = box();
    const out = await privilegeAct(d, 'role_request', { userId: 'u-mgr' }, { pin: PIN, request });
    expect(out.status).toBe(200);
    expect(out.answer).toMatchObject({ ok: true, kind: 'role_request', requestId: REQ, ...PRIVILEGE_WORDS.role_requested });
    expect(pinAsked).toEqual([{ userId: 'u-mgr', pin: PIN, authority: 'identity.role.request' }]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.path).toBe('/v1/identity/box/grants');
    expect(relayed[0]!.key).toBe(REQ);
    expect(relayed[0]!.body).toMatchObject({ kind: 'role_request', tenantId: 't-sre', userId: 'u-mgr', requestId: REQ, confirmedAt: NOW, via: 'office_pin', body: request });
    // The seal checks with the privilege key at head office.
    expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 't-sre', relayed: relayed[0]!.body, nowMs: Date.parse(NOW) })).toMatchObject({ ok: true });
    // The PIN is in nothing kept or sent.
    expect(JSON.stringify(relayed)).not.toContain(PIN);
    expect(JSON.stringify(records)).not.toContain(PIN);
    expect(records.map((r) => r['outcome'])).toEqual(['sealed', 'accepted']);
  });

  it('approving: the PIN is checked holding identity.role.grant; the request is named by its id only', async () => {
    const { d, relayed, pinAsked } = box({ relay: { status: 201, body: { granted: 'u-new granted Cashier' } } });
    const door = privilegeDoorOf('/office/privilege/grants/g-1/approve');
    expect(door).toEqual({ kind: 'role_grant_approval', grantId: 'g-1' });
    const out = await privilegeAct(d, door!.kind, { userId: 'u-owner' }, { pin: PIN, request: { roleId: 'owner' }, grantId: door!.grantId! });
    expect(out.answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.role_granted });
    expect(pinAsked[0]!.authority).toBe(PRIVILEGE_AUTHORITY.role_grant_approval);
    expect(relayed[0]!.path).toBe('/v1/identity/box/grants/g-1/approve');
    expect((relayed[0]!.body as { body: unknown }).body).toEqual({ grantId: 'g-1' }); // nothing else the page sent
  });

  it('a wrong PIN: refused, and NOTHING is sealed or relayed; the refusal is written down without the PIN', async () => {
    const { d, records, relayed } = box({ pinOk: false });
    const out = await privilegeAct(d, 'role_request', { userId: 'u-mgr' }, { pin: '000000', request });
    expect(out.status).toBe(403);
    expect(out.answer).toMatchObject({ ok: false, refusedBecause: 'pin_not_confirmed', en: PRIVILEGE_WORDS.pin_not_confirmed.en, ta: PRIVILEGE_WORDS.pin_not_confirmed.ta });
    expect(relayed).toEqual([]);
    expect(records).toEqual([{ kind: 'privilege_act', act: 'role_request', at: NOW, userId: 'u-mgr', outcome: 'refused:pin_not_confirmed' }]);
  });

  it('nobody signed in, no PIN, no request: refused before any PIN is asked; nothing relayed', async () => {
    for (const [kind, who, input, why, status] of [
      ['role_request', null, { pin: PIN, request }, 'not_signed_in', 401],
      ['role_request', { userId: 'u-mgr' }, { pin: '', request }, 'not_readable', 400],
      ['role_request', { userId: 'u-mgr' }, { pin: PIN, request: 'cashier' }, 'not_readable', 400],
      ['role_grant_approval', { userId: 'u-owner' }, { pin: PIN, request: {} }, 'not_readable', 400],
    ] as const) {
      const { d, relayed, pinAsked, records } = box();
      const out = await privilegeAct(d, kind, who, input);
      expect(out.status).toBe(status);
      expect(out.answer).toMatchObject({ ok: false, refusedBecause: why });
      expect(relayed).toEqual([]);
      expect(pinAsked).toEqual([]);
      expect(records.map((r) => r['outcome'])).toEqual([`refused:${why}`]);
    }
  });

  it('not set up (no privilege key, or no office service named): refused, the PIN never asked', async () => {
    for (const over of [{ sealKey: null }, { relay: null }] as const) {
      const { d, pinAsked } = box(over);
      const out = await privilegeAct(d, 'role_request', { userId: 'u-mgr' }, { pin: PIN, request });
      expect(out).toMatchObject({ status: 503, answer: { refusedBecause: 'not_set_up' } });
      expect(pinAsked).toEqual([]);
    }
  });

  it('adding a person (built in 4b-1) takes only a staff id and a name: anything else is not read, the PIN never asked', async () => {
    const { d, relayed, pinAsked } = box();
    const out = await privilegeAct(d, 'person_provision', { userId: 'u-owner' }, { pin: PIN, request: { signInName: 'priya.k' } });
    expect(out).toMatchObject({ status: 400, answer: { refusedBecause: 'not_readable' } });
    expect(relayed).toEqual([]);
    expect(pinAsked).toEqual([]);
  });

  it('head office\'s refusal is said in its own words; its 401 (the box\'s credential) is never "sign in again"', async () => {
    const refusal = { status: 422, body: { error: { code: 'approved_by_the_requester', whatHappened: 'u-owner both requested and approved this.' } } };
    const { d } = box({ relay: refusal });
    const out = await privilegeAct(d, 'role_grant_approval', { userId: 'u-owner' }, { pin: PIN, request: undefined, grantId: 'g-1' });
    expect(out.status).toBe(422);
    expect(out.answer).toMatchObject({ ok: false, refusedBecause: 'head_office_refused', code: 'approved_by_the_requester', ta: PRIVILEGE_WORDS.head_office_refused.ta });
    expect((out.answer as { en: string }).en).toContain('u-owner both requested and approved this.');
    const b = box({ relay: { status: 401, body: {} } });
    expect((await privilegeAct(b.d, 'role_request', { userId: 'u-mgr' }, { pin: PIN, request })).status).toBe(502);
    const c = box({ relay: 'unreachable' });
    expect((await privilegeAct(c.d, 'role_request', { userId: 'u-mgr' }, { pin: PIN, request })).answer).toMatchObject({ refusedBecause: 'head_office_unreachable' });
  });

  it('if the act cannot be written down first, it is not sent', async () => {
    const { d, relayed } = box({ failRecord: true });
    const out = await privilegeAct(d, 'role_request', { userId: 'u-mgr' }, { pin: PIN, request });
    expect(out.answer).toMatchObject({ refusedBecause: 'not_recorded' });
    expect(relayed).toEqual([]);
  });
});

describe('head office: only a store computer\'s credential relays', () => {
  it('a caller without the store computer role is refused not_a_store_computer, before any seal is read', async () => {
    const routes = boxPrivilegeRoutes({
      identity: { roles: () => [], permissionsOf: () => ['identity.role.request'], recordGrant: () => {}, grantRequests: () => [], recordGrantRequest: () => {}, recordGrantRejection: () => {}, branches: () => [], allocateNumber: async () => 1, now: () => NOW },
      privilegeSealKey: KEY, now: () => NOW, spendRequestId: async () => 'first', rolesHeldBy: () => ['owner'],
    });
    for (const route of routes) {
      await expect(Promise.resolve(route.handler({ tenantId: 't-sre', userId: 'u-owner', branchId: null, params: { grantId: 'g-1' }, query: {}, body: {}, traceId: 't' })))
        .rejects.toMatchObject({ body: { code: 'not_a_store_computer' } });
    }
  });
});

describe('the Users & roles page on the store PC: give and approve through the box, the PIN asked each time', () => {
  const viewer = { userId: 'u-mgr', permissions: ['identity.role.request', 'identity.role.grant', 'identity.role.read'] };
  const fakeFetch = (answer: { status: number; body: unknown }) => {
    const calls: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { f, calls };
  };

  it('give: the PIN is asked, then sent once with the request to the box\'s door — never to /v1', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { ok: true } });
    const asked: string[] = [];
    const office = officePrivilegeFrom({ grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view', accessChanges: '/office/privilege/access-changes', decide: '/office/privilege/access-changes/{approvalId}/decide', tillPins: '/office/privilege/till-pins' }, async (w) => { asked.push(w); return PIN; })!;
    const s = createUsersSession({ viewer, fetch: f, newId: () => 'grant-1', office });
    expect(await s.give({ userId: 'u-new', roleId: 'cashier', stores: 'all', reason: 'morning shift' }, [])).toEqual({ result: 'ok', value: { grantId: 'grant-1' } });
    expect(asked).toEqual(['give']);
    expect(calls).toEqual([{ url: '/office/privilege/grants', body: { pin: PIN, request: { grantId: 'grant-1', userId: 'u-new', roleId: 'cashier', branchScope: 'all', reason: 'morning shift' } } }]);
  });

  it('approve asks the PIN; a cancelled PIN sends nothing (reject through the box: 4b-1, its own test)', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: { ok: true } });
    let pin: string | null = PIN;
    const office = officePrivilegeFrom({ grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view', accessChanges: '/office/privilege/access-changes', decide: '/office/privilege/access-changes/{approvalId}/decide', tillPins: '/office/privilege/till-pins' }, async () => pin)!;
    const s = createUsersSession({ viewer, fetch: f, office });
    expect(await s.decide('g 1', 'approve', '')).toEqual({ result: 'ok', value: { decided: 'approved' } });
    expect(calls[0]).toEqual({ url: '/office/privilege/grants/g%201/approve', body: { pin: PIN } });
    pin = null;
    expect(await s.decide('g-2', 'approve', '')).toEqual({ result: 'invalid', why: 'pinNeeded' });
    expect(await s.decide('g-2', 'reject', 'no')).toEqual({ result: 'invalid', why: 'pinNeeded' });
    expect(calls).toHaveLength(1);
  });

  it('the box\'s refusal is shown in its own words', async () => {
    const { f } = fakeFetch({ status: 403, body: { ok: false, refusedBecause: 'pin_not_confirmed', en: PRIVILEGE_WORDS.pin_not_confirmed.en } });
    const office = officePrivilegeFrom({ grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view', accessChanges: '/office/privilege/access-changes', decide: '/office/privilege/access-changes/{approvalId}/decide', tillPins: '/office/privilege/till-pins' }, async () => '000000')!;
    const out = await createUsersSession({ viewer, fetch: f, office }).decide('g-1', 'approve', '');
    expect(out).toEqual({ result: 'refused', status: 403, code: 'pin_not_confirmed', whatHappened: PRIVILEGE_WORDS.pin_not_confirmed.en });
  });

  it('only the box\'s own /office/ doors are believed from the page\'s global', () => {
    expect(officePrivilegeFrom({ ...{ grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view', accessChanges: '/office/privilege/access-changes', decide: '/office/privilege/access-changes/{approvalId}/decide', tillPins: '/office/privilege/till-pins' }, grants: 'https://elsewhere/x' }, async () => PIN)).toBeUndefined();
    expect(officePrivilegeFrom(undefined, async () => PIN)).toBeUndefined();
  });

  it('the PIN box: a password field; Confirm hands back the PIN and removes the box; Cancel hands back nothing', async () => {
    const made: FakeEl[] = [];
    class FakeEl implements PinEl {
      attrs: Record<string, string> = {}; kids: FakeEl[] = []; textContent: string | null = null; value = ''; on: Record<string, (e: { preventDefault(): void }) => void> = {};
      constructor(readonly tag: string) { made.push(this); }
      setAttribute(n: string, v: string) { this.attrs[n] = v; }
      appendChild(el: PinEl) { this.kids.push(el as FakeEl); }
      addEventListener(t: string, fn: (e: { preventDefault(): void }) => void) { this.on[t] = fn; }
    }
    const shown = new Set<FakeEl>();
    const doc: PinDoc = { createElement: (t) => new FakeEl(t), body: { appendChild: (el) => shown.add(el as FakeEl), removeChild: (el) => shown.delete(el as FakeEl) } };
    const words = { ask: 'Type your PIN', askTa: 'PIN', ok: 'Confirm', cancel: 'Cancel' };
    const p1 = askOfficePin(doc, words);
    const input = made.find((e) => e.tag === 'input')!;
    expect(input.attrs['type']).toBe('password');
    input.value = PIN;
    made.find((e) => e.tag === 'form')!.on['submit']!({ preventDefault: () => {} });
    expect(await p1).toBe(PIN);
    expect(shown.size).toBe(0);
    expect(input.value).toBe(''); // not left in the page
    made.length = 0;
    const p2 = askOfficePin(doc, words);
    made.filter((e) => e.tag === 'button')[1]!.on['click']!({ preventDefault: () => {} });
    expect(await p2).toBeNull();
  });
});

// a uuid the box would make is accepted by head office's reader
it('the box\'s request id is a uuid head office reads', () => {
  const r: PrivilegeRecord = { kind: 'role_request', tenantId: 't', userId: 'u', requestId: randomUUID(), confirmedAt: NOW, via: 'office_pin', body: {} };
  expect(checkPrivilegeRecord(KEY, { kind: 'role_request', tenantId: 't', relayed: sealPrivilegeRecord(KEY, r), nowMs: Date.parse(NOW) })).toMatchObject({ ok: true });
});
