import { describe, it, expect } from 'vitest';
import {
  buildRouter, handle, MemoryIdempotencyStore, BackoffAuthThrottle,
  type Route, type HttpRequest,
} from '../../services/kernel/src/index';
import { tokenAuthenticator } from '../../services/identity/src/token';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { LocalIdp } from '../support/local-idp';

/**
 * **Audit 27 Nov 2026, item 1 — one device cannot lock the whole shop out of sign-in.**
 *
 * Before: the sign-in lockout was keyed on the source address alone, and every token the API did not believe counted as
 * a guessing attempt. A whole shop leaves from one address, so one tablet holding an EXPIRED sign-in (five background
 * calls) locked every till, every phone and the office PC out of head office for minutes.
 *
 * Now:
 *   • a token head office's own key signed — but which has expired (or is otherwise refused AFTER its signature checked)
 *     — is not a guess and is never counted towards a lockout: nobody guesses a correctly signed token;
 *   • a forged or badly signed token still counts, against the address AND the person it claims, so a guesser is
 *     locked while another person's device at the same address keeps working;
 *   • an address that keeps sending forged tokens under ever-changing names still hits a higher, address-wide ceiling.
 */

const SECRET = ['audit27', 'item1', 'lockout', 'signing', 'key'].join('-').padEnd(40, '0');
const idp = new LocalIdp({ secret: SECRET, issuer: 'https://idp.audit27.test', audience: 'sre-retail-os' });
const forger = idp.withDifferentKey(['not', 'head', 'office', 'key'].join('-').padEnd(40, '9'));
const T = 'ab000000-0000-4000-8000-00000000a271';

const ROUTE: Route = { api: 'API-01', method: 'GET', path: '/v1/sales', permission: 'pos.sale.read', handler: () => ({ status: 200, body: { ok: true } }) };
const ACCESS = new AccessControl(
  [{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read'] }],
  ['u-anbu', 'u-bala', 'u-chitra'].map((userId) => ({ userId, roleId: 'cashier', branchScope: ['b-main'] })),
);

function kernel(over: Record<string, unknown> = {}) {
  const built = buildRouter([ROUTE]);
  if (!built.ok) throw new Error('router');
  return {
    router: built.router!, authenticate: tokenAuthenticator(idp.policy()), access: ACCESS,
    idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-a27-1',
    // The production settings (services/api/src/main.ts).
    authThrottle: new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }),
    ...over,
  };
}

const SHOP = '203.0.113.7'; // every device in the shop leaves from here
const call = (token: string, clientIp = SHOP): HttpRequest => ({ method: 'GET', path: '/v1/sales', headers: { authorization: `Bearer ${token}` }, clientIp });
const expired = (sub: string): string => idp.issue({ sub, tenantId: T, branchId: 'b-main', ttlSeconds: -3600 });
const fresh = (sub: string): string => idp.issue({ sub, tenantId: T, branchId: 'b-main' });
const forged = (sub: string): string => forger.issue({ sub, tenantId: T, branchId: 'b-main' });

describe('audit 27 Nov item 1 — the sign-in lockout is per caller, and an expired sign-in is not a guess', () => {
  it('five EXPIRED sign-ins from one tablet do not lock another device at the same shop address', async () => {
    const k = kernel();
    for (let i = 0; i < 5; i += 1) expect((await handle(k, call(expired('u-anbu')))).status).toBe(401);
    const other = await handle(k, call(fresh('u-bala')));
    expect(other.status, 'another person at the same address must not be locked out').toBe(200);
  });

  it('a correctly signed but expired token is never counted: twenty of them, then the same person signs in again', async () => {
    const k = kernel();
    for (let i = 0; i < 20; i += 1) expect((await handle(k, call(expired('u-anbu')))).status).toBe(401);
    expect((await handle(k, call(fresh('u-anbu')))).status).toBe(200);
  });

  it('FORGED tokens still count — they lock the person they claim at this address, not everyone else', async () => {
    const k = kernel();
    for (let i = 0; i < 5; i += 1) expect((await handle(k, call(forged('u-anbu')))).status).toBe(401);
    const sixth = await handle(k, call(forged('u-anbu')));
    expect(sixth.status).toBe(429);
    expect((sixth.body as { error: { code: string } }).error.code).toBe('too_many_sign_in_attempts');
    // The claimed person is locked at this address, even with the right token (the guessing run is stopped)…
    expect((await handle(k, call(fresh('u-anbu')))).status).toBe(429);
    // …but another person's device in the same shop keeps working.
    expect((await handle(k, call(fresh('u-bala')))).status).toBe(200);
    // And from another address, the claimed person is not locked either.
    expect((await handle(k, call(fresh('u-anbu'), '198.51.100.4'))).status).toBe(200);
  });

  it('forging under ever-changing names does not escape: the address-wide ceiling still locks that address', async () => {
    const k = kernel({ sourceAuthThrottle: new BackoffAuthThrottle({ threshold: 12, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }) });
    for (let i = 0; i < 12; i += 1) expect((await handle(k, call(forged(`u-guess-${i}`)))).status).toBe(401);
    expect((await handle(k, call(forged('u-guess-99')))).status).toBe(429);
    expect((await handle(k, call(fresh('u-bala')))).status, 'the address is locked once the ceiling is crossed').toBe(429);
    expect((await handle(k, call(fresh('u-bala'), '198.51.100.4'))).status, 'another address is untouched').toBe(200);
  });

  it('a garbage credential with no readable claims still counts, and a good sign-in clears the slate', async () => {
    const k = kernel();
    for (let i = 0; i < 4; i += 1) expect((await handle(k, call('not-a-token'))).status).toBe(401);
    expect((await handle(k, call(fresh('u-chitra')))).status).toBe(200);
    expect((await handle(k, call('not-a-token'))).status).toBe(401);
    expect((await handle(k, call('not-a-token'))).status).toBe(401);
  });
});
