import { describe, it, expect } from 'vitest';
import {
  buildRouter, Router, handle, ApiError, MemoryIdempotencyStore,
  type Route, type HttpRequest, type Principal,
} from '../../services/kernel/src/index';
import { WITHHELD_ON_REPLAY, withheldForReplay } from '../../services/kernel/src/pipeline';
import type { RequestContext } from '../../services/kernel/src/router';
import { AccessControl } from '../../packages/rbac/src/rbac';
import {
  peopleRoutes, foldPeople, isGenericName, oneTimePassword,
  type PeopleDeps, type PersonSignInEvent,
} from '../../services/identity/src/people';
import { DirectoryUnavailableError, directoryLocationOf, type DirectoryPerson, type IdentityDirectory, type IssueOutcome } from '../../services/identity/src/identity-directory';
import { withMultiFactor } from '../../services/identity/src/amr';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * People's sign-ins from the product (OB-15-c · M02-FR-01 · SEC-03 · §28 · hard rule #4), at the handler and through the
 * request pipeline: a named person only, never a shared account; never yourself; never somebody already holding a role;
 * the one-time password shown once and kept nowhere; a lost reply finished, never duplicated.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function lab(over: { directory?: IdentityDirectory | null; holders?: readonly string[]; events?: PersonSignInEvent[] } = {}) {
  const events: PersonSignInEvent[] = over.events ?? [];
  const issued: { person: DirectoryPerson; resume: boolean }[] = [];
  let clock = 0;
  const directory: IdentityDirectory = {
    issue: async (person, resume): Promise<IssueOutcome> => { issued.push({ person, resume }); return { result: 'issued', resumed: resume }; },
    end: async () => 'ended',
  };
  const deps: PeopleDeps = {
    now: () => `2026-10-08T10:00:${String(clock++).padStart(2, '0')}.000Z`,
    people: () => foldPeople(events),
    recordPerson: (_t, e) => { events.push(e); },
    holdsAnyRole: (_t, userId) => (over.holders ?? []).includes(userId),
    ...(over.directory === null ? {} : { directory: over.directory ?? directory }),
    generatePassword: () => 'ABCD-EFGH-JKMN-PQRS',
  };
  const post = peopleRoutes(deps).find((r) => r.method === 'POST')!;
  const call = (body: Record<string, unknown>, userId = 'u-admin') => post.handler({
    tenantId: T, userId, branchId: null, params: {}, query: {}, body, traceId: 't', idempotencyKey: 'k',
  } as RequestContext);
  return { call, events, issued };
}

const failure = async (p: unknown): Promise<{ status: number; code: string; saved: string }> => {
  try { await p; } catch (e) {
    if (e instanceof ApiError) {
      const b = e.body as unknown as { error?: { code?: string; wasItSaved?: string }; code?: string; wasItSaved?: string };
      return { status: e.status, code: b.error?.code ?? b.code ?? '', saved: b.error?.wasItSaved ?? b.wasItSaved ?? '' };
    }
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('a sign-in is for one named person', () => {
  it.each(['cashier', 'cashier2', 'till-3', 'admin_1', 'store', 'manager', 'shared.counter', 'billing01', 'demo', 'staff'])(
    '"%s" names a job, a place or a shared account — refused', async (name) => {
      expect(isGenericName(name)).toBe(true);
      const l = lab();
      expect(await failure(l.call({ signInName: name, displayName: 'Asha Kumar' }))).toMatchObject({ status: 422, code: 'shared_or_generic_sign_in', saved: 'not_saved' });
      expect(l.events).toHaveLength(0);
    });

  it.each(['asha.k', 'ravi', 'meena2', 'p.selvam'])('"%s" is a person\'s name — accepted', (name) => {
    expect(isGenericName(name)).toBe(false);
  });

  it('a person\'s name that is a job ("Store Manager", "Cashier 2") is refused too', async () => {
    const l = lab();
    expect((await failure(l.call({ signInName: 'asha.k', displayName: 'Store Manager' }))).code).toBe('shared_or_generic_sign_in');
    expect((await failure(l.call({ signInName: 'asha.k', displayName: 'Cashier 2' }))).code).toBe('shared_or_generic_sign_in');
  });

  it('nobody gives themselves a sign-in; nobody already holding a role is given one here', async () => {
    const l = lab({ holders: ['u-owner'] });
    expect((await failure(l.call({ signInName: 'u-admin', displayName: 'Admin Person' }, 'u-admin'))).code).toBe('signing_in_yourself');
    expect((await failure(l.call({ signInName: 'chezhian', userId: 'u-owner', displayName: 'Chezhian R' }))).code).toBe('person_already_holds_authority');
    expect(l.events).toHaveLength(0);
    expect(l.issued).toHaveLength(0);
  });

  it('a password is never sent in; an unreadable request is refused by name', async () => {
    const l = lab();
    expect((await failure(l.call({ signInName: 'asha.k', displayName: 'Asha Kumar', password: 'x'.repeat(14) }))).code).toBe('password_is_never_sent');
    expect((await failure(l.call({ signInName: 'A', displayName: 'Asha Kumar' }))).code).toBe('not_readable_as_a_person');
    expect((await failure(l.call({ signInName: 'asha.k', displayName: '12' }))).code).toBe('not_readable_as_a_person');
  });

  it('without the identity server connected, nothing is recorded (503)', async () => {
    const l = lab({ directory: null });
    expect(await failure(l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' }))).toMatchObject({ status: 503, code: 'identity_server_not_connected', saved: 'not_saved' });
    expect(l.events).toHaveLength(0);
  });
});

describe('issuing', () => {
  it('records the attempt BEFORE the identity server, then the outcome; the person must use a second factor; the password is in the reply only', async () => {
    const l = lab();
    const res = await l.call({ signInName: 'Asha.K', displayName: '  Asha   Kumar ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: 'asha.k', signInName: 'asha.k', displayName: 'Asha Kumar', state: 'issued', secondFactor: 'required', oneTimePassword: 'ABCD-EFGH-JKMN-PQRS' });
    expect(l.events.map((e) => e.type)).toEqual(['PersonSignInRequested', 'PersonSignInIssued']);
    expect(l.issued).toEqual([{ person: { username: 'asha.k', userId: 'asha.k', displayName: 'Asha Kumar', secondFactor: true, temporaryPassword: 'ABCD-EFGH-JKMN-PQRS' }, resume: false }]);
    expect(JSON.stringify(l.events)).not.toContain('ABCD-EFGH');
    expect(foldPeople(l.events)).toEqual([expect.objectContaining({ userId: 'asha.k', state: 'issued', requestedBy: 'u-admin', secondFactor: true })]);
  });

  it('a second sign-in for the same person is refused, and their password is never replaced from here', async () => {
    const l = lab();
    await l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' });
    expect((await failure(l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' }))).code).toBe('person_already_has_a_sign_in');
    expect((await failure(l.call({ signInName: 'asha.k', userId: 'u-other', displayName: 'Asha Kumar' }))).code).toBe('sign_in_name_or_person_already_used');
    expect(l.issued).toHaveLength(1);
  });

  it('the identity server not answering: the attempt stays recorded (503, saved), and the same request later FINISHES it', async () => {
    let up = false;
    const issued: boolean[] = [];
    const flaky: IdentityDirectory = {
      issue: async (_p, resume) => { if (!up) throw new DirectoryUnavailableError('not reachable'); issued.push(resume); return { result: 'issued', resumed: resume }; },
      end: async () => 'none',
    };
    const l = lab({ directory: flaky });
    expect(await failure(l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' }))).toMatchObject({ status: 503, code: 'identity_server_unavailable', saved: 'saved' });
    expect(foldPeople(l.events)[0]?.state).toBe('requested');
    up = true;
    const res = await l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' });
    expect(res.status).toBe(201);
    expect(issued).toEqual([true]);
    expect(l.events.filter((e) => e.type === 'PersonSignInRequested')).toHaveLength(1);
    expect(foldPeople(l.events)[0]?.state).toBe('issued');
  });

  it('the name taken at the identity server: refused, and the attempt withdrawn so another name can be tried', async () => {
    const taken: IdentityDirectory = {
      issue: async (p) => (p.username === 'asha.k'
        ? { result: 'refused', code: 'username_taken', detail: 'The sign-in name "asha.k" already belongs to somebody else in the identity server.' }
        : { result: 'issued', resumed: false }),
      end: async () => 'none',
    };
    const l = lab({ directory: taken });
    expect((await failure(l.call({ signInName: 'asha.k', userId: 'u-asha', displayName: 'Asha Kumar' }))).code).toBe('username_taken');
    expect(foldPeople(l.events)).toEqual([]);
    expect((await l.call({ signInName: 'asha.kumar', userId: 'u-asha', displayName: 'Asha Kumar' })).status).toBe(201);
  });

  it('a person whose sign-in ended when they left is not revived from here', async () => {
    const l = lab({ events: [
      { type: 'PersonSignInRequested', userId: 'asha.k', username: 'asha.k', displayName: 'Asha Kumar', secondFactor: true, requestedBy: 'u-admin', at: 'a' },
      { type: 'PersonSignInIssued', userId: 'asha.k', issuedBy: 'u-admin', resumed: false, at: 'b' },
      { type: 'PersonSignInEnded', userId: 'asha.k', endedBy: 'u-owner', reason: 'leaver', at: 'c' },
    ] });
    expect((await failure(l.call({ signInName: 'asha.k', displayName: 'Asha Kumar' }))).code).toBe('sign_in_ended');
  });

  it('the one-time password: four groups of four unambiguous characters, different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => oneTimePassword()));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(p).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
  });
});

describe('shown once — through the request pipeline (hard rule #4)', () => {
  const PRINCIPAL: Principal = { tenantId: T, userId: 'u-admin', branchId: null, authTime: Math.floor(Date.now() / 1000), amr: ['pwd', 'otp', 'mfa'] };
  const kernel = (routes: readonly Route[], idempotency = new MemoryIdempotencyStore()) => {
    const built = buildRouter(routes);
    if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
    return {
      router: built.router!, authenticate: (t: string) => (t === 'good' ? PRINCIPAL : undefined),
      access: new AccessControl(ROLE_CATALOGUE, [{ userId: 'u-admin', roleId: 'platform_admin', branchScope: 'all' }]),
      idempotency, newTraceId: () => 'trace-1',
    };
  };
  const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({
    method: 'POST', path: '/v1/identity/people', headers: { authorization: 'Bearer good', 'idempotency-key': 'k-1' },
    body: { signInName: 'asha.k', displayName: 'Asha Kumar' }, ...over,
  });

  it('the reply carries the password once, marked no-store; the kept reply and every replay carry "withheld"', async () => {
    const idempotency = new MemoryIdempotencyStore();
    const k = kernel(peopleRoutes(depsFor()), idempotency);
    const first = await handle(k, req());
    expect(first.status).toBe(201);
    expect((first.body as { oneTimePassword: string }).oneTimePassword).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(first.headers['cache-control']).toBe('no-store');
    const kept = await idempotency.get(T, 'k-1');
    expect(JSON.stringify(kept)).not.toContain('ABCD-EFGH');
    const replay = await handle(k, req());
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.headers['cache-control']).toBe('no-store');
    expect((replay.body as { oneTimePassword: string }).oneTimePassword).toBe(WITHHELD_ON_REPLAY);
  });

  it('a platform administrator without a recent second factor is refused before anything happens', async () => {
    const weak: Principal = { ...PRINCIPAL, amr: ['pwd'] };
    const k = { ...kernel(peopleRoutes(depsFor())), authenticate: (t: string) => (t === 'good' ? weak : undefined) };
    expect((await handle(k, req())).status).toBe(403);
  });

  it('only the platform administrator\'s role holds the provisioning permission — the owner and every shop role do not', () => {
    const holders = ROLE_CATALOGUE.filter((r) => r.permissions.includes('platform.person.provision')).map((r) => r.id);
    expect(holders).toEqual(['platform_admin']);
  });

  it('a read cannot declare reply fields shown once; withheldForReplay touches only the named fields', () => {
    const r = new Router().add({ api: 'API-01', method: 'GET', path: '/v1/x', permission: 'a.b', shownOnce: ['x'], handler: () => ({ status: 200, body: {} }) });
    expect(r.refusedBecause).toBe('shown_once_on_a_read');
    expect(withheldForReplay({ a: 1, oneTimePassword: 'p' }, ['oneTimePassword'])).toEqual({ a: 1, oneTimePassword: WITHHELD_ON_REPLAY });
    expect(withheldForReplay({ a: 1 }, ['oneTimePassword'])).toEqual({ a: 1 });
    expect(withheldForReplay({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

function depsFor(): PeopleDeps {
  const events: PersonSignInEvent[] = [];
  return {
    now: () => '2026-10-08T10:00:00.000Z',
    people: () => foldPeople(events),
    recordPerson: (_t, e) => { events.push(e); },
    holdsAnyRole: () => false,
    directory: { issue: async () => ({ result: 'issued', resumed: false }), end: async () => 'none' },
    generatePassword: () => 'ABCD-EFGH-JKMN-PQRS',
  };
}

describe('a password and a phone code is a two-factor sign-in (RFC 8176)', () => {
  it.each([
    [['pwd', 'otp'], ['pwd', 'otp', 'mfa']],
    [['pwd'], ['pwd']],
    [['otp'], ['otp']],
    [['pwd', 'pin'], ['pwd', 'pin']],
    [['pwd', 'mfa'], ['pwd', 'mfa']],
    [['pin', 'hwk'], ['pin', 'hwk', 'mfa']],
  ])('%j → %j', (amr, expected) => {
    expect(withMultiFactor(amr)).toEqual(expected);
  });
});

describe('where the identity server is', () => {
  it('reads the base and realm from its key-set address, and nothing else', () => {
    expect(directoryLocationOf('http://idp:8080/auth/realms/sre-store/protocol/openid-connect/certs')).toEqual({ baseUrl: 'http://idp:8080/auth', realm: 'sre-store' });
    expect(directoryLocationOf('http://127.0.0.1:8180/realms/sre-store/protocol/openid-connect/certs')).toEqual({ baseUrl: 'http://127.0.0.1:8180', realm: 'sre-store' });
    expect(directoryLocationOf('http://idp:8080/auth/realms/sre-store')).toBeUndefined();
  });
});
