import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { PRIVILEGE_KINDS } from '../../packages/identity/src/privilege-seal';
import { OWN_PIN_AUTHORITY, PRIVILEGE_AUTHORITY, PRIVILEGE_WORDS, privilegeAct, privilegeDoorOf, type PrivilegeDeps, type RelayAnswer } from '../../edge/store-edge/src/office-privilege';
import { createUsersSession, officePrivilegeFrom, usersWords, type PinAsk } from '../../apps/web-erp/src/users-session';
import { isRelayPermission, privilegeAlertWords } from '../../services/identity/src/box-privilege';

/**
 * **CR-01 step 4b-2 · OB-734 "A" · OB-735 "A" · OB-737 "A" · ADR-0033 amendment 2: till PINs and take-backs on the store PC —
 * the new PIN never leaves the box; it is written there only after head office has the record; a leaver's PIN is cancelled.**
 */

const KEY = privilegeSealKey(randomBytes(32).toString('base64url'));
const NOW = '2026-11-14T10:00:00.000Z';
const REQ = '0b0a8a6e-4c1d-4a5e-9f3b-2d7c6e5f4a3b';
const PIN = '482915';
const NEW = '135790';

function box(over: { relay?: RelayAnswer; writeFails?: boolean; noWriter?: boolean } = {}) {
  const records: Record<string, unknown>[] = [];
  const relayed: { path: string; body: Record<string, unknown> }[] = [];
  const written: { userId: string; pin: string | null; by: string }[] = [];
  const pinAsked: { userId: string; pin: string; authority: string }[] = [];
  const d: PrivilegeDeps = {
    tenantId: 't-sre', sealKey: KEY,
    relay: async (path, body) => { relayed.push({ path, body: body as Record<string, unknown> }); return over.relay ?? { status: 200, body: { recorded: true } }; },
    verifyPin: async (userId, pin, authority) => { pinAsked.push({ userId, pin, authority }); return { ok: true }; },
    record: async (e) => { records.push(e); },
    now: () => NOW, newRequestId: () => REQ,
    ...(over.noWriter === true ? {} : { writeTillPin: async (userId: string, pin: string | null, by: string) => { if (over.writeFails === true) throw new Error('disk full'); written.push({ userId, pin, by }); } }),
  };
  return { d, records, relayed, written, pinAsked };
}

describe('the box: a till PIN set, cancelled or changed — head office first, then this box; the PIN never sent', () => {
  it('the kinds, doors and authorities', () => {
    for (const k of ['access_change_request', 'access_change_decision', 'till_pin_change'] as const) expect(PRIVILEGE_KINDS).toContain(k);
    expect(PRIVILEGE_AUTHORITY.access_change_request).toBe('identity.role.request');
    expect(PRIVILEGE_AUTHORITY.access_change_decision).toBe('identity.role.grant');
    expect(PRIVILEGE_AUTHORITY.till_pin_change).toBe('identity.role.request');
    expect(OWN_PIN_AUTHORITY).toBe('identity.self.read');
    expect(privilegeDoorOf('/office/privilege/till-pins')).toEqual({ kind: 'till_pin_change' });
    expect(privilegeDoorOf('/office/privilege/access-changes')).toEqual({ kind: 'access_change_request' });
    expect(privilegeDoorOf('/office/privilege/access-changes/areq-1/decide')).toEqual({ kind: 'access_change_decision', grantId: 'areq-1' });
  });

  it('set: the manager\'s PIN with the maker\'s word; sealed { userId, action } ONLY; written after head office has it', async () => {
    const { d, relayed, written, pinAsked, records } = box();
    const out = await privilegeAct(d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request: { action: 'set', userId: ' U-Cash ', newPin: NEW, newPinAgain: NEW, extra: 'x' } });
    expect(out.answer).toMatchObject({ ok: true, kind: 'till_pin_change', ...PRIVILEGE_WORDS.pin_set });
    expect(pinAsked).toEqual([{ userId: 'u-mgr', pin: PIN, authority: 'identity.role.request' }]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.path).toBe('/v1/identity/box/till-pins');
    expect(relayed[0]!.body['body']).toEqual({ userId: 'u-cash', action: 'set' });
    expect(written).toEqual([{ userId: 'u-cash', pin: NEW, by: 'u-mgr' }]);
    for (const secret of [NEW, PIN]) {
      expect(JSON.stringify(relayed)).not.toContain(secret);
      expect(JSON.stringify(records)).not.toContain(secret);
      expect(JSON.stringify(out.answer)).not.toContain(secret);
    }
  });

  it('the new PIN must be six digits, the same twice — else nothing is asked, sent or written', async () => {
    for (const request of [{ action: 'set', userId: 'u-cash', newPin: '12345', newPinAgain: '12345' }, { action: 'set', userId: 'u-cash', newPin: NEW, newPinAgain: '135791' }, { action: 'own', newPin: 'abcdef', newPinAgain: 'abcdef' }]) {
      const { d, relayed, written, pinAsked } = box();
      const out = await privilegeAct(d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request });
      expect(out).toMatchObject({ status: 400, answer: { refusedBecause: 'new_pin_not_readable' } });
      expect([relayed, written, pinAsked]).toEqual([[], [], []]);
    }
  });

  it('own: the CURRENT PIN with only "I am me"; the record names the person at the screen, whoever the page named', async () => {
    const { d, relayed, written, pinAsked } = box();
    const out = await privilegeAct(d, 'till_pin_change', { userId: 'u-cash' }, { pin: PIN, request: { action: 'own', userId: 'u-owner', newPin: NEW, newPinAgain: NEW } });
    expect(out.answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.pin_changed_own });
    expect(pinAsked[0]!.authority).toBe('identity.self.read');
    expect(relayed[0]!.body['body']).toEqual({ userId: 'u-cash', action: 'own' });
    expect(written).toEqual([{ userId: 'u-cash', pin: NEW, by: 'u-cash' }]);
  });

  it('cancel writes a cancellation; head office refusing writes nothing; a box that cannot write says so, never "done"', async () => {
    const c = box();
    expect((await privilegeAct(c.d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request: { action: 'cancel', userId: 'u-cash' } })).answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.pin_cancelled });
    expect(c.written).toEqual([{ userId: 'u-cash', pin: null, by: 'u-mgr' }]);

    const no = box({ relay: { status: 403, body: { error: { code: 'person_holds_more_authority', whatHappened: 'u-owner holds authority u-mgr does not.' } } } });
    const refused = await privilegeAct(no.d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request: { action: 'cancel', userId: 'u-owner' } });
    expect(refused.answer).toMatchObject({ ok: false, refusedBecause: 'head_office_refused', code: 'person_holds_more_authority' });
    expect(no.written).toEqual([]);

    const fail = box({ writeFails: true });
    const out = await privilegeAct(fail.d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request: { action: 'set', userId: 'u-cash', newPin: NEW, newPinAgain: NEW } });
    expect(out).toMatchObject({ status: 503, answer: { ok: false, refusedBecause: 'pin_not_saved_here', ...PRIVILEGE_WORDS.pin_not_saved_here } });

    const none = box({ noWriter: true });
    expect((await privilegeAct(none.d, 'till_pin_change', { userId: 'u-mgr' }, { pin: PIN, request: { action: 'cancel', userId: 'u-cash' } })).answer).toMatchObject({ refusedBecause: 'not_set_up' });
    expect(none.relayed).toEqual([]);
  });
});

describe('the box: a take-back asked and decided — a leaver\'s PIN cancelled here once head office applied it', () => {
  const take = { requestId: 'access-1', event: 'leaver', userId: 'u-cash', reason: 'left', grants: [] };
  it('asked: exactly the change, nothing else; a mover must keep a role, a leaver keeps none', async () => {
    const { d, relayed } = box({ relay: { status: 201, body: { requestId: 'areq-1' } } });
    const out = await privilegeAct(d, 'access_change_request', { userId: 'u-mgr' }, { pin: PIN, request: { ...take, approvedBy: 'u-owner' } });
    expect(out.answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.take_back_asked });
    expect(relayed[0]!.body['body']).toEqual(take);
    for (const bad of [{ ...take, grants: [{ userId: 'u-cash', roleId: 'cashier', branchScope: 'all' }] }, { ...take, event: 'mover' }, { ...take, reason: '' }, { ...take, requestId: 'a b' }]) {
      const b = box();
      expect((await privilegeAct(b.d, 'access_change_request', { userId: 'u-mgr' }, { pin: PIN, request: bad })).answer).toMatchObject({ refusedBecause: 'not_readable' });
    }
  });

  it('approved and applied for a leaver: their till PIN is cancelled on this box; rejected: nothing written', async () => {
    const yes = box({ relay: { status: 200, body: { decided: 'approved', applied: true, tillPinToCancel: 'u-cash' } } });
    const out = await privilegeAct(yes.d, 'access_change_decision', { userId: 'u-owner' }, { pin: PIN, request: { decision: 'approved', reason: 'she left' }, grantId: 'areq-1' });
    expect(out.answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.take_back_done });
    expect(yes.relayed[0]).toMatchObject({ path: '/v1/identity/box/access-changes/areq-1/decide', body: { body: { approvalId: 'areq-1', decision: 'approved', reason: 'she left' } } });
    expect(yes.written).toEqual([{ userId: 'u-cash', pin: null, by: 'u-owner' }]);

    const no = box({ relay: { status: 200, body: { decided: 'rejected', applied: false } } });
    expect((await privilegeAct(no.d, 'access_change_decision', { userId: 'u-owner' }, { pin: PIN, request: { decision: 'rejected', reason: 'no' }, grantId: 'areq-1' })).answer).toMatchObject({ ok: true, ...PRIVILEGE_WORDS.take_back_rejected });
    expect(no.written).toEqual([]);
  });

  it('approved but not applied: said, with head office\'s words — never "done"', async () => {
    const b = box({ relay: { status: 200, body: { decided: 'approved', applied: false, result: { blockers: ['owns 2 open orders'] } } } });
    const out = await privilegeAct(b.d, 'access_change_decision', { userId: 'u-owner' }, { pin: PIN, request: { decision: 'approved', reason: 'x' }, grantId: 'areq-1' });
    expect((out.answer as { en: string }).en).toContain(PRIVILEGE_WORDS.take_back_not_applied.en);
    expect((out.answer as { en: string }).en).toContain('owns 2 open orders');
    expect(b.written).toEqual([]);
  });
});

describe('head office: OB-737 compares authority, not the till\'s relay hops', () => {
  it('a *.sync hop and the template pull are relays; a real permission is not', () => {
    for (const p of ['cash.movement.sync', 'approvals.decision.sync', 'org.template.pull']) expect(isRelayPermission(p)).toBe(true);
    for (const p of ['identity.role.grant', 'cash.movement.record', 'price.change.approve']) expect(isRelayPermission(p)).toBe(false);
  });

  it('the owner\'s alert says what happened to whose PIN, and a leaver in plain words', () => {
    const base = { requestId: REQ, actingUserId: 'u-mgr', subjectUserId: 'u-cash', roleId: '', branchScope: ['S1'], grantId: '', requestedBy: 'u-mgr', confirmedAt: NOW, at: NOW, relayedBy: 'u-box', storeId: 'S1' } as const;
    expect(privilegeAlertWords({ ...base, kind: 'till_pin_change', pinAction: 'cancel' })).toContain('u-mgr cancelled till PIN of u-cash; they cannot sign in');
    expect(privilegeAlertWords({ ...base, kind: 'till_pin_change', pinAction: 'set' })).toContain('they typed it themselves');
    expect(privilegeAlertWords({ ...base, kind: 'access_change_request', event: 'leaver' })).toContain('record that u-cash has left');
    expect(privilegeAlertWords({ ...base, kind: 'access_change_decision', actingUserId: 'u-owner', event: 'leaver', grantId: 'areq-1' })).toContain('u-owner approved u-cash leaving: every role taken back and their till PIN cancelled, asked for by u-mgr');
  });
});

describe('the Users & roles page on the store PC (4b-2)', () => {
  const DOORS = { grants: '/office/privilege/grants', approve: '/office/privilege/grants/{grantId}/approve', reject: '/office/privilege/grants/{grantId}/reject', people: '/office/privilege/people', view: '/office/privilege/users-view', accessChanges: '/office/privilege/access-changes', decide: '/office/privilege/access-changes/{approvalId}/decide', tillPins: '/office/privilege/till-pins' };
  const fake = (body: unknown = { ok: true }) => {
    const calls: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init?: { body?: string }) => { calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => body } as Response; }) as unknown as typeof globalThis.fetch;
    return { f, calls };
  };
  const answers = (map: Partial<Record<PinAsk, string | null>>) => { const asked: PinAsk[] = []; return { asked, ask: async (w: PinAsk) => { asked.push(w); return map[w] ?? null; } }; };
  const mgr = { userId: 'u-mgr', permissions: ['identity.role.request'] };
  const owner = { userId: 'u-owner', permissions: ['identity.role.request', 'identity.role.grant', 'identity.role.read'] };

  it('set a PIN: the asker\'s PIN, then the new one twice; a mismatch sends nothing', async () => {
    const { f, calls } = fake();
    const a = answers({ pinSet: PIN, newPin: NEW, newPinAgain: NEW });
    const s = createUsersSession({ viewer: mgr, fetch: f, office: officePrivilegeFrom(DOORS, a.ask)! });
    expect(await s.tillPin('set', ' U-Cash ')).toEqual({ result: 'ok', value: { done: 'set' } });
    expect(a.asked).toEqual(['pinSet', 'newPin', 'newPinAgain']);
    expect(calls).toEqual([{ url: '/office/privilege/till-pins', body: { pin: PIN, request: { action: 'set', userId: 'u-cash', newPin: NEW, newPinAgain: NEW } } }]);
    const b = answers({ pinSet: PIN, newPin: NEW, newPinAgain: '000000' });
    const s2 = createUsersSession({ viewer: mgr, fetch: f, office: officePrivilegeFrom(DOORS, b.ask)! });
    expect(await s2.tillPin('set', 'u-cash')).toEqual({ result: 'invalid', why: 'newPinMismatch' });
    expect(calls).toHaveLength(1);
  });

  it('cancel asks only the asker\'s PIN; own asks the CURRENT PIN and names nobody; a cashier may only change their own', async () => {
    const { f, calls } = fake();
    const c = answers({ pinCancel: PIN });
    expect(await createUsersSession({ viewer: mgr, fetch: f, office: officePrivilegeFrom(DOORS, c.ask)! }).tillPin('cancel', 'u-cash')).toEqual({ result: 'ok', value: { done: 'cancel' } });
    expect(c.asked).toEqual(['pinCancel']);
    const o = answers({ pinCurrent: PIN, newPin: NEW, newPinAgain: NEW });
    const cashier = createUsersSession({ viewer: { userId: 'u-cash', permissions: ['identity.self.read'] }, fetch: f, office: officePrivilegeFrom(DOORS, o.ask)! });
    expect(await cashier.tillPin('own', 'u-owner')).toEqual({ result: 'ok', value: { done: 'own' } });
    expect(calls[1]).toEqual({ url: '/office/privilege/till-pins', body: { pin: PIN, request: { action: 'own', newPin: NEW, newPinAgain: NEW } } });
    expect(await cashier.tillPin('set', 'u-two')).toEqual({ result: 'invalid', why: 'cannotAsk' });
    expect(await createUsersSession({ viewer: mgr, fetch: f, office: officePrivilegeFrom(DOORS, c.ask)! }).tillPin('cancel', 'u-mgr')).toEqual({ result: 'invalid', why: 'yourself' });
  });

  it('take back and "they have left" go to the box\'s door by PIN; the owner decides one with a reason', async () => {
    const { f, calls } = fake();
    const a = answers({ takeBack: PIN, approve: PIN });
    const s = createUsersSession({ viewer: mgr, fetch: f, newId: () => 'access-9', office: officePrivilegeFrom(DOORS, a.ask)! });
    const holder = { userId: 'u-two', grants: [{ userId: 'u-two', roleId: 'cashier', branchScope: 'all' as const }, { userId: 'u-two', roleId: 'accountant', branchScope: ['S1'] }] };
    expect(await s.askTakeBack(holder, holder.grants[0]!, ' moved to accounts ')).toEqual({ result: 'ok', value: { requestId: 'access-9' } });
    expect(calls[0]).toEqual({ url: '/office/privilege/access-changes', body: { pin: PIN, request: { requestId: 'access-9', event: 'mover', userId: 'u-two', reason: 'moved to accounts', grants: [{ userId: 'u-two', roleId: 'accountant', branchScope: ['S1'] }] } } });
    expect(await s.askTakeBack(holder, 'leaver', 'left')).toEqual({ result: 'ok', value: { requestId: 'access-9' } });
    expect((calls[1]!.body as { request: { event: string; grants: unknown[] } }).request).toMatchObject({ event: 'leaver', grants: [] });
    const d = createUsersSession({ viewer: owner, fetch: f, office: officePrivilegeFrom(DOORS, a.ask)! });
    expect(await d.decideTakeBack('areq-1', 'approve', '')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await d.decideTakeBack('areq-1', 'approve', ' she left ')).toMatchObject({ result: 'ok', value: { decided: 'approved' } });
    expect(calls[2]).toEqual({ url: '/office/privilege/access-changes/areq-1/decide', body: { pin: PIN, request: { decision: 'approved', reason: 'she left' } } });
  });

  it('the page: take-backs and till PINs on the store PC, take-back buttons there too, every word in Tamil', () => {
    const html = readFileSync('apps/web-erp/web/users.html', 'utf8');
    const js = readFileSync('apps/web-erp/web/users.js', 'utf8');
    for (const id of ['id="takebacks"', 'id="pins"', 'id="pin-form"', 'id="p-own"', 'id="p-cancel"']) expect(html).toContain(id);
    expect(js).toContain("$('takebacks').hidden = !onStorePc");
    expect(js).toContain("$('pins').hidden = !onStorePc");
    expect(js).not.toContain('may.ask && !onStorePc');
    for (const k of ['takeBacksH', 'pinsH', 'pinAskNew', 'pinAskNewAgain', 'pinAskCurrent', 'newPinMismatch', 'pinSetDone']) expect(usersWords('ta', k)).not.toBe(usersWords('en', k));
    for (const [k, w] of Object.entries(PRIVILEGE_WORDS)) expect(w.ta, k).not.toBe('');
  });
});
