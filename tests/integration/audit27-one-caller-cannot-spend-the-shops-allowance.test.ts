import { describe, it, expect } from 'vitest';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { TokenBucketRateLimiter, type Principal } from '../../services/kernel/src/index';
import { CUSTOMER_SUBJECT_PREFIX } from '../../services/identity/src/keycloak-customer-signer';

/**
 * **Audit 27 Nov 2026, item 3 — through the REAL head-office router and token verifier (in memory).** One shop: a tablet
 * that floods head office spends its own address's allowance, never the shop's; customers on the app spend their own
 * allowance, never the tills'. The limiters are the production kind with small numbers so the test is quick.
 */

const T = 'ab000000-0000-4000-8000-00000000a274';
const bucket = (capacity: number) => new TokenBucketRateLimiter({ capacity, refillPerSecond: 0.0001 }, () => 0);
const isCustomer = (p: Principal): boolean => p.userId.startsWith(CUSTOMER_SUBJECT_PREFIX);
const me = { method: 'GET' as const, path: '/v1/identity/me' };

describe('audit 27 Nov item 3 — the shop\'s and the customers\' allowances (real router, in memory)', () => {
  it('a flooding tablet spends its own address only; the owner from another address is still served', async () => {
    const h = apiHarness({ rateLimit: bucket(6), tenantRateLimit: bucket(40), customerRateLimit: bucket(40), isCustomer });
    await h.seedOwner(T, 'u-owner');
    const tablet = TEST_IDP.issue({ sub: 'u-owner', tenantId: T });
    for (let i = 0; i < 6; i += 1) expect((await h.raw({ ...me, token: tablet, clientIp: '203.0.113.30' })).status).toBe(200);
    expect((await h.raw({ ...me, token: tablet, clientIp: '203.0.113.30' })).status).toBe(429);
    const office = await h.raw({ ...me, token: TEST_IDP.issue({ sub: 'u-owner', tenantId: T }), clientIp: '203.0.113.31' });
    expect(office.status, JSON.stringify(office.body)).toBe(200);
  });

  it('customers spending their whole allowance leave the owner served', async () => {
    const h = apiHarness({ rateLimit: bucket(100), tenantRateLimit: bucket(8), customerRateLimit: bucket(8), isCustomer });
    await h.seedOwner(T, 'u-owner');
    for (let i = 0; i < 8; i += 1) {
      const r = await h.raw({ ...me, token: TEST_IDP.issue({ sub: `${CUSTOMER_SUBJECT_PREFIX}c${i}`, tenantId: T }), clientIp: `198.51.100.${i + 1}` });
      expect(r.status).not.toBe(429);
    }
    expect((await h.raw({ ...me, token: TEST_IDP.issue({ sub: `${CUSTOMER_SUBJECT_PREFIX}c9`, tenantId: T }), clientIp: '198.51.100.9' })).status).toBe(429);
    for (let i = 0; i < 8; i += 1) expect((await h.raw({ ...me, token: TEST_IDP.issue({ sub: 'u-owner', tenantId: T }), clientIp: `203.0.113.${i + 1}` })).status).toBe(200);
  });
});
