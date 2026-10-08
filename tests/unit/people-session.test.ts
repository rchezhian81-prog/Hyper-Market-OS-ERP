import { describe, it, expect } from 'vitest';
import { createPeopleSession, type IssueResult, type PeoplePort, type PersonRow } from '../../apps/web-erp/src/people-session';
import { bootPeople, personRowOf } from '../../apps/web-erp/src/browser-entry';
import { isGenericName as headOfficeRule } from '../../services/identity/src/people';
import { isGenericName as screenRule } from '../../packages/identity/src/sign-in-names';

/**
 * The People part of "Who can get in" (OB-15-c-2): the screen refuses what head office would refuse, BEFORE sending —
 * from the very same rules; it holds the one-time password in memory only until it is handed over; every answer is said
 * in words, in English and Tamil; somebody without the authority gets no form and a sentence why.
 */

const ASHA: PersonRow = { userId: 'asha.k', signInName: 'asha.k', displayName: 'Asha Kumar', state: 'issued', requestedBy: 'u-admin', requestedAt: '2026-10-08T05:00:00.000Z', issuedAt: '2026-10-08T05:00:01.000Z' };

function port(over: Partial<PeoplePort> = {}): PeoplePort & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    read: async () => ({ result: 'read', people: [ASHA], connected: true }),
    issue: async (input): Promise<IssueResult> => { sent.push(input); return { result: 'issued', userId: input.signInName, signInName: input.signInName, displayName: input.displayName, oneTimePassword: 'ABCD-EFGH-JKMN-PQRS' }; },
    ...over,
  };
}

const admin = { userId: 'u-admin', mayProvision: true };

describe('the screen refuses what head office would refuse — from the same rules, before anything is sent', () => {
  it('the name rules are ONE set, shared by the screen and head office', () => {
    expect(screenRule).toBe(headOfficeRule);
  });

  it.each([
    [{ displayName: '', signInName: 'asha.k' }, 'Type the person’s full name.'],
    [{ displayName: 'Asha Kumar', signInName: 'A' }, 'The sign-in name must be 3 to 40 lower-case letters or digits (dots, hyphens and underscores allowed).'],
    [{ displayName: 'Counter Two', signInName: 'cashier2' }, '“cashier2” names a job, a place or a shared account, not a person. Use the person’s own name.'],
    [{ displayName: 'Store Manager', signInName: 'asha.k' }, '“Store Manager” names a job, a place or a shared account, not a person. Use the person’s own name.'],
    [{ displayName: 'Admin Person', signInName: 'U-Admin' }, 'Nobody gives themselves a sign-in. Ask another administrator.'],
  ])('%j → refused here, nothing sent', async (input, words) => {
    const p = port();
    const s = createPeopleSession(admin, p);
    const outcome = await s.issue(input);
    expect(outcome.kind).toBe('refused_here');
    expect(s.present('en', outcome, input).label).toBe(words);
    expect(p.sent).toEqual([]);
  });
});

describe('giving a sign-in', () => {
  it('sends only the tidied name and sign-in name; holds the password until handed over; reads the list again', async () => {
    const p = port();
    const s = createPeopleSession(admin, p, () => '2026-10-08T05:00:02.000Z');
    const outcome = await s.issue({ displayName: '  Asha   Kumar ', signInName: ' Asha.K ' });
    expect(outcome).toEqual({ kind: 'issued' });
    expect(p.sent).toEqual([{ signInName: 'asha.k', displayName: 'Asha Kumar' }]);
    expect(s.handOver()).toEqual({ signInName: 'asha.k', displayName: 'Asha Kumar', oneTimePassword: 'ABCD-EFGH-JKMN-PQRS' });
    expect(s.present('en', outcome).label).toBe('Sign-in made for Asha Kumar (asha.k).');
    expect(s.view('en').rows).toEqual([expect.objectContaining({ name: 'Asha Kumar (asha.k)', stateWords: 'has a sign-in', tone: 'ok' })]);
    s.handedOver();
    expect(s.handOver()).toBeNull();
  });

  it('a reply without the password (head office withheld it) says so, and holds nothing', async () => {
    const s = createPeopleSession(admin, port({ issue: async (i) => ({ result: 'issued', userId: i.signInName, signInName: i.signInName, displayName: i.displayName }) }));
    const outcome = await s.issue({ displayName: 'Asha Kumar', signInName: 'asha.k' });
    expect(outcome.kind).toBe('issued_without_password');
    expect(s.handOver()).toBeNull();
    expect(s.present('en', outcome).label).toMatch(/did not show the password again/);
  });

  it('head office\'s refusals in plain words, English and Tamil; a code it does not know keeps head office\'s own sentence', async () => {
    const refuse = (code: string, whatHappened = 'Something head office said in full.') => createPeopleSession(admin, port({ issue: async () => ({ result: 'refused', code, whatHappened }) }));
    const input = { displayName: 'Ravi Shankar', signInName: 'ravi.s' };
    let s = refuse('person_already_holds_authority');
    let o = await s.issue(input);
    expect(s.present('en', o).label).toMatch(/^This person already holds a role\./);
    expect(s.present('ta', o).label).toMatch(/^இவருக்கு ஏற்கனவே ஒரு பொறுப்பு உள்ளது/);
    s = refuse('reauthentication_required');
    o = await s.issue(input);
    expect(s.present('en', o).label).toMatch(/sign in again with the code from your phone/);
    s = refuse('something_new');
    o = await s.issue(input);
    expect(s.present('en', o).label).toBe('Something head office said in full.');
  });

  it('a lost link holds nothing and tells the person to check before trying again', async () => {
    const s = createPeopleSession(admin, port({ issue: async () => ({ result: 'lost_link' }) }));
    const o = await s.issue({ displayName: 'Asha Kumar', signInName: 'asha.k' });
    expect(o.kind).toBe('lost_link');
    expect(s.handOver()).toBeNull();
    expect(s.present('en', o).label).toMatch(/Check again/);
  });
});

describe('who may, and what the screen says', () => {
  it('without the administrator\'s authority there is no form, and a sentence why; nothing is sent', async () => {
    const p = port();
    const s = createPeopleSession({ userId: 'u-owner', mayProvision: false }, p);
    expect(s.view('en')).toMatchObject({ mayIssue: false, cannot: 'Only the platform administrator gives sign-ins.' });
    expect((await s.issue({ displayName: 'Asha Kumar', signInName: 'asha.k' })).kind).toBe('refused_here');
    expect(p.sent).toEqual([]);
    expect(createPeopleSession({ userId: null, mayProvision: true }, p).view('en').cannot).toMatch(/not told who you are/);
  });

  it('head office not connected to the identity server: no form, and it says so', async () => {
    const s = createPeopleSession(admin, port({ read: async () => ({ result: 'read', people: [], connected: false }) }));
    await s.refresh();
    expect(s.view('en')).toMatchObject({ mayIssue: false, listKnown: true });
    expect(s.view('en').source.label).toMatch(/not connected to the identity server yet/);
  });

  it('the source line: read, refused as not permitted, lost link; and the page without head office', async () => {
    const s = createPeopleSession(admin, port(), () => '2026-10-08T05:00:00.000Z');
    await s.refresh();
    expect(s.view('en').source.label).toBe('Head office, as at 08-10-2026 10:30.');
    const no = createPeopleSession(admin, port({ read: async () => ({ result: 'refused', code: 'forbidden', whatHappened: '' }) }));
    await no.refresh();
    expect(no.view('en').source.label).toBe('You may not see who has a sign-in.');
    const lost = createPeopleSession(admin, port({ read: async () => ({ result: 'lost_link' }) }));
    await lost.refresh();
    expect(lost.view('ta').source.label).toMatch(/பதிலளிக்கவில்லை/);
    expect(createPeopleSession(admin).view('en')).toMatchObject({ mayIssue: false, cannot: 'This screen is not connected to head office, so no sign-in can be given here.' });
  });
});

describe('the browser side', () => {
  it('reads head office\'s rows defensively — a row missing its ids, name or state is dropped', () => {
    expect(personRowOf({ userId: 'asha.k', username: 'asha.k', displayName: 'Asha Kumar', state: 'issued', requestedBy: 'u-admin', requestedAt: 'a', issuedAt: 'b' }))
      .toEqual({ userId: 'asha.k', signInName: 'asha.k', displayName: 'Asha Kumar', state: 'issued', requestedBy: 'u-admin', requestedAt: 'a', issuedAt: 'b' });
    expect(personRowOf({ userId: 'asha.k', username: 'asha.k', displayName: 'Asha Kumar', state: 'weird', requestedBy: 'u', requestedAt: 'a' })).toBeNull();
    expect(personRowOf({ userId: '', username: 'asha.k', displayName: 'Asha Kumar', state: 'issued', requestedBy: 'u', requestedAt: 'a' })).toBeNull();
    expect(personRowOf(null)).toBeNull();
  });

  it('the authority comes from what the box says this person holds — default-deny', () => {
    expect(bootPeople(undefined)).toBeNull();
    expect(bootPeople({ userId: 'u-admin', permissions: ['platform.person.provision'] })!.view('en').cannot).toMatch(/not connected to head office/);
    expect(bootPeople({ userId: 'u-admin' }, port())!.view('en').cannot).toBe('Only the platform administrator gives sign-ins.');
  });
});
