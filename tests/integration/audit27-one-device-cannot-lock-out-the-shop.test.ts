import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { BackoffAuthThrottle } from '../../services/kernel/src/index';
import { officeCallKey, sealOfficeCall } from '../../packages/identity/src/office-call-seal';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { officeSignInRecords } from '../../services/api/src/office-sign-in-log';

/**
 * **Audit 27 Nov 2026, item 1 — through the REAL head-office router and authenticator (in memory).**
 *
 * One shop, one address. A tablet whose sign-in has expired keeps calling head office; a store PC sends office calls
 * whose seals went stale. Neither may lock the shop's other devices out. A forger at the same address is still locked —
 * for the person they claim — and the address-wide ceiling still stops a forger who changes names every try. The failed
 * tries are still KEPT on the shop's record (D13-FR-06): not counting a try towards a lockout is not forgetting it.
 */

const T = 'ab000000-0000-4000-8000-00000000a272';
const SHOP = '203.0.113.7';
const production = () => ({
  authThrottle: new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }),
  sourceAuthThrottle: new BackoffAuthThrottle({ threshold: 50, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }),
});
const forger = TEST_IDP.withDifferentKey(['someone', 'elses', 'key'].join('-').padEnd(40, '7'));

describe('audit 27 Nov item 1 — one device cannot lock the shop out (real router, in memory)', () => {
  it('an expired tablet sign-in, five times and more, never locks the owner\'s device at the same address — and each try is still kept', async () => {
    const store = new InMemoryEventStore();
    const h = apiHarness({ store, ...production() });
    await h.seedOwner(T, 'u-owner');
    const stale = TEST_IDP.issue({ sub: 'u-tablet', tenantId: T, ttlSeconds: -3600 });
    for (let i = 0; i < 8; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: stale, clientIp: SHOP })).status).toBe(401);

    const owner = await h.raw({ method: 'GET', path: '/v1/identity/me', token: TEST_IDP.issue({ sub: 'u-owner', tenantId: T }), clientIp: SHOP });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    // The tablet itself, once it has a fresh sign-in, is not locked either.
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: TEST_IDP.issue({ sub: 'u-tablet', tenantId: T }), clientIp: SHOP })).status).not.toBe(429);
    // D13-FR-06: the eight refused tries are kept; none was a lockout.
    expect((await officeSignInRecords(store, T)).map((r) => r.p.outcome)).toEqual(Array(8).fill('failed'));
  });

  it('forged tokens lock the person they claim at this address; the owner next to them keeps working', async () => {
    const store = new InMemoryEventStore();
    const h = apiHarness({ store, ...production() });
    await h.seedOwner(T, 'u-owner');
    for (let i = 0; i < 5; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: forger.issue({ sub: 'u-guess', tenantId: T }), clientIp: SHOP })).status).toBe(401);
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: forger.issue({ sub: 'u-guess', tenantId: T }), clientIp: SHOP })).status).toBe(429);
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: TEST_IDP.issue({ sub: 'u-owner', tenantId: T }), clientIp: SHOP })).status).toBe(200);
    const kept = (await officeSignInRecords(store, T)).map((r) => r.p.outcome);
    expect(kept).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'locked_out']);
  });

  it('a forger changing names every try is stopped by the address-wide ceiling (50)', async () => {
    const h = apiHarness({ ...production() });
    await h.seedOwner(T, 'u-owner');
    for (let i = 0; i < 50; i += 1) expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: forger.issue({ sub: `u-guess-${i}`, tenantId: T }), clientIp: SHOP })).status).toBe(401);
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: forger.issue({ sub: 'u-guess-x', tenantId: T }), clientIp: SHOP })).status).toBe(429);
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: TEST_IDP.issue({ sub: 'u-owner', tenantId: T }), clientIp: '198.51.100.9' })).status).toBe(200);
  });

  it('the store PC\'s STALE office-call seals (correctly sealed, too old) never lock the shop; a badly sealed one still counts', async () => {
    const secret = randomBytes(32).toString('base64url');
    const key = officeCallKey(privilegeSealKey(secret));
    const h = apiHarness({ privilegeSealSecret: secret, ...production() });
    await h.seedOwner(T, 'u-owner');
    const request = { method: 'GET', path: '/v1/identity/me', query: {}, body: undefined, idempotencyKey: undefined };
    const longAgo = Date.now() - 10 * 60_000;
    for (let i = 0; i < 8; i += 1) {
      const seal = sealOfficeCall(key, { tenantId: T, userId: 'u-owner', branchId: null, request, signedInAt: longAgo / 1000, nowMs: longAgo });
      expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: seal, clientIp: '127.0.0.1' })).status).toBe(401);
    }
    const good = sealOfficeCall(key, { tenantId: T, userId: 'u-owner', branchId: null, request, signedInAt: Date.now() / 1000, nowMs: Date.now() });
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: good, clientIp: '127.0.0.1' })).status).toBe(200);

    // A seal made with another key is a forgery: five of them lock that person at the store PC's address.
    const wrong = officeCallKey(privilegeSealKey(randomBytes(32).toString('base64url')));
    for (let i = 0; i < 5; i += 1) {
      const seal = sealOfficeCall(wrong, { tenantId: T, userId: 'u-owner', branchId: null, request, signedInAt: Date.now() / 1000, nowMs: Date.now() });
      expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: seal, clientIp: '127.0.0.1' })).status).toBe(401);
    }
    const after = sealOfficeCall(key, { tenantId: T, userId: 'u-owner', branchId: null, request, signedInAt: Date.now() / 1000, nowMs: Date.now() });
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: after, clientIp: '127.0.0.1' })).status).toBe(429);
  });
});
