import { describe, it, expect } from 'vitest';
import { createOutsideLoginsSession, type OutsideLoginRow, type OutsideLoginsPort, type OutsideKind } from '../../apps/web-erp/src/outside-logins-session';

/**
 * OB-76 — the tested model behind "Logins for customers and suppliers" on the Admin page: kinds offered only to someone
 * who manages that kind of party (default-deny), the cheap refusals made before any request, the inviter never offered
 * Approve on their own invite, head office's own words shown for its refusals, and a one-time password held in memory only
 * until it is handed over. (The connected proof is tests/e2e/outside-logins-on-the-production-api.e2e.ts.)
 */

const row = (over: Partial<OutsideLoginRow> = {}): OutsideLoginRow => ({
  inviteId: 'inv-1', role: 'b2b_customer', partyId: 'CATERER', userId: 'u-clerk', displayName: 'Meena Raman', state: 'invited',
  invitedBy: 'u-owner', invitedAt: '2026-10-12T05:00:00.000Z', ...over,
});

const fakePort = (rows: OutsideLoginRow[]) => {
  const calls: string[] = [];
  const port: OutsideLoginsPort = {
    list: async (k: OutsideKind) => { calls.push(`list ${k}`); return { result: 'read', logins: rows.filter((r) => r.role === k) }; },
    invite: async (k, partyId, _id, body) => {
      calls.push(`invite ${k} ${partyId} ${body.userId ?? ''}`);
      if (partyId === 'NOBODY') return { result: 'refused', code: 'party_record_unknown', whatHappened: 'No business customer account "NOBODY" is held here.' };
      rows.push(row({ inviteId: 'inv-2', partyId, userId: body.userId ?? partyId, displayName: body.displayName }));
      return { result: 'done' };
    },
    approve: async (_k, id) => { calls.push(`approve ${id}`); return { result: 'done' }; },
    revoke: async (_k, id, reason) => { calls.push(`revoke ${id} ${reason}`); return { result: 'done' }; },
    signIn: async (_k, id) => { calls.push(`sign-in ${id}`); return { result: 'done', oneTimePassword: ['7KQ4', 'M2XP', '9WRT', 'HB3D'].join('-') }; },
  };
  return { port, calls };
};

describe('OB-76 — the outside-party logins model', () => {
  it('offers only the kinds the viewer manages; someone who manages none is told so and nothing is asked', async () => {
    const { port, calls } = fakePort([]);
    const acct = createOutsideLoginsSession({ userId: 'u-acct', permissions: ['b2b.account.manage'] }, port);
    expect(acct.view('en').kinds).toEqual(['b2b_customer']);
    const cashier = createOutsideLoginsSession({ userId: 'u-cash', permissions: ['pos.sale.create'] }, port);
    await cashier.refresh();
    expect(cashier.view('en')).toMatchObject({ kinds: [], cannot: 'You may not manage business customers, customers or suppliers, so you cannot invite or approve their logins.' });
    expect(cashier.view('ta').cannot).toMatch(/[஀-௿]/);
    expect(calls).toEqual([]);
  });

  it('refuses the cheap things before any request — a shared name, a bad login id, no grants, inviting yourself', async () => {
    const { port, calls } = fakePort([]);
    const s = createOutsideLoginsSession({ userId: 'u-owner', permissions: ['b2b.account.manage', 'customer.identity.manage'] }, port);
    const base = { kind: 'b2b_customer' as const, partyId: 'CATERER', userId: 'u-clerk', displayName: 'Meena Raman', grants: ['view_invoices'] };
    expect(await s.invite({ ...base, displayName: 'Store Account' })).toMatchObject({ kind: 'refused_here', words: 'refuseGeneric' });
    expect(await s.invite({ ...base, userId: 'U CLERK' })).toMatchObject({ kind: 'refused_here', words: 'refuseUser' });
    expect(await s.invite({ ...base, grants: [] })).toMatchObject({ kind: 'refused_here', words: 'refuseGrants' });
    expect(await s.invite({ ...base, userId: 'u-owner' })).toMatchObject({ kind: 'refused_here', words: 'refuseYourself' });
    expect(await s.invite({ ...base, kind: 'supplier' })).toMatchObject({ kind: 'refused_here', words: 'cannotPermission' });
    expect(calls).toEqual([]);
    // An app customer's login defaults to the customer's own record code.
    await s.invite({ kind: 'customer', partyId: 'cust-anita', userId: '', displayName: 'Anita Das', grants: [] });
    expect(calls[0]).toBe('invite customer cust-anita cust-anita');
  });

  it('shows head office\'s own words for its refusal, and never offers the inviter Approve on their own invite', async () => {
    const { port } = fakePort([row()]);
    const owner = createOutsideLoginsSession({ userId: 'u-owner', permissions: ['b2b.account.manage'] }, port);
    const refused = await owner.invite({ kind: 'b2b_customer', partyId: 'NOBODY', userId: 'u-x', displayName: 'Ravi Kumar', grants: ['view_invoices'] });
    expect(owner.present('en', refused).label).toBe('Head office said: No business customer account "NOBODY" is held here.');
    await owner.refresh();
    expect(owner.view('en').rows[0]).toMatchObject({ mayApprove: false, stateWords: 'waiting for a second person to approve' });
    const acct = createOutsideLoginsSession({ userId: 'u-acct', permissions: ['b2b.account.manage'] }, port);
    await acct.refresh();
    expect(acct.view('en').rows[0]).toMatchObject({ mayApprove: true, mayRevoke: false });
  });

  it('a revoke needs a reason; a one-time password is held in memory only until it is handed over', async () => {
    const { port, calls } = fakePort([row({ state: 'approved', approvedBy: 'u-acct' })]);
    const s = createOutsideLoginsSession({ userId: 'u-acct', permissions: ['b2b.account.manage'] }, port);
    await s.refresh();
    expect(s.view('en').rows[0]).toMatchObject({ mayRevoke: true, maySignIn: true });
    expect(s.view('en').rows[0]!.detail).toContain('invited by u-owner · approved by u-acct');
    expect(await s.revoke('b2b_customer', 'inv-1', '  ')).toMatchObject({ kind: 'refused_here', words: 'refuseReason' });
    expect(await s.signIn('b2b_customer', 'inv-1', 'cashier')).toMatchObject({ kind: 'refused_here', words: 'refuseGeneric' });
    await s.signIn('b2b_customer', 'inv-1', 'meena.r');
    expect(s.handOver()).toEqual({ displayName: 'Meena Raman', oneTimePassword: '7KQ4-M2XP-9WRT-HB3D' });
    s.handedOver();
    expect(s.handOver()).toBeNull();
    expect(calls.filter((c) => !c.startsWith('list'))).toEqual(['sign-in inv-1']);
  });
});
