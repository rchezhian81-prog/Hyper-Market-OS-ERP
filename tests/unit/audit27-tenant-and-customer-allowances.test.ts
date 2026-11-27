import { describe, it, expect } from 'vitest';
import {
  buildRouter, handle, MemoryIdempotencyStore, TokenBucketRateLimiter,
  type Route, type HttpRequest, type Principal,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { loadConfig, CLOUD_API_CONFIG } from '../../services/kernel/src/config';
import { rateLimitSettingsOf, isCustomerCaller } from '../../services/api/src/rate-limit-settings';

/**
 * **Audit 27 Nov 2026, item 3 — the shop's allowance is its own, larger than one caller's; customers have their own.**
 *
 * Before: head office used ONE token-bucket limiter (240 burst, 20 a second) for both the per-address limit and the
 * per-shop limit, so one caller spending its own address allowance had spent the whole SHOP's allowance too — every till,
 * the store computer and the office were then refused. And customers' phones drew on the same shop allowance as the staff
 * and the store computers, so a busy hour on the customer app could refuse the tills.
 *
 * Now: the per-address limit, the shop's allowance (staff and store computers) and the customers' allowance are three
 * separate limiters, the shop's larger than one address's, each a setting with a default.
 */

const ACCESS = new AccessControl(
  [{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read'] }],
  ['u-anbu', 'u-bala', 'u-chitra', 'u-devi', ...Array.from({ length: 100 }, (_, i) => `customer-c${i}`)]
    .map((userId) => ({ userId, roleId: 'cashier', branchScope: ['b-main'] })),
);
const ROUTE: Route = { api: 'API-05', method: 'GET', path: '/v1/sales', permission: 'pos.sale.read', handler: () => ({ status: 200, body: { ok: true } }) };
const who = (t: string): Principal | undefined => (t.startsWith('staff:') || t.startsWith('customer:')
  ? { tenantId: 't-sre', userId: t.startsWith('customer:') ? `customer-${t.slice(9)}` : t.slice(6), branchId: 'b-main' } : undefined);
const isCustomer = (p: Principal): boolean => p.userId.startsWith('customer-');

function kernel(over: Record<string, unknown>) {
  const built = buildRouter([ROUTE]);
  if (!built.ok) throw new Error('router');
  return { router: built.router!, authenticate: who, access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 't', ...over };
}
const call = (token: string, clientIp: string): HttpRequest => ({ method: 'GET', path: '/v1/sales', headers: { authorization: `Bearer ${token}` }, clientIp });
const bucket = (capacity: number) => new TokenBucketRateLimiter({ capacity, refillPerSecond: 0.0001 }, () => 0);

describe('audit 27 Nov item 3 — one caller cannot spend the shop\'s allowance', () => {
  it('one address spending its own allowance leaves the shop\'s larger allowance for every other device', async () => {
    const k = kernel({ rateLimit: bucket(5), tenantRateLimit: bucket(50) });
    for (let i = 0; i < 5; i += 1) expect((await handle(k, call('staff:u-anbu', '203.0.113.1'))).status).toBe(200);
    expect((await handle(k, call('staff:u-anbu', '203.0.113.1'))).status, 'the address is spent').toBe(429);
    // Another device of the same shop, from another address: the SHOP still has allowance.
    for (let i = 0; i < 5; i += 1) expect((await handle(k, call('staff:u-bala', '203.0.113.2'))).status, `call ${i + 1}`).toBe(200);
  });

  it('the shop allowance is its own limit: once IT is spent, every address of the shop is refused', async () => {
    const k = kernel({ rateLimit: bucket(100), tenantRateLimit: bucket(6) });
    for (let i = 0; i < 6; i += 1) expect((await handle(k, call('staff:u-anbu', `203.0.113.${i + 10}`))).status).toBe(200);
    expect((await handle(k, call('staff:u-bala', '203.0.113.99'))).status).toBe(429);
  });
});

describe('audit 27 Nov item 3 — customers have their own allowance, apart from the staff and the store computers', () => {
  it('customers spending all of theirs never refuses a till', async () => {
    const k = kernel({ rateLimit: bucket(100), tenantRateLimit: bucket(10), customerRateLimit: bucket(10), isCustomer });
    for (let i = 0; i < 10; i += 1) expect((await handle(k, call(`customer:c${i}`, `198.51.100.${i + 1}`))).status).toBe(200);
    expect((await handle(k, call('customer:c99', '198.51.100.99'))).status, 'the customers\' allowance is spent').toBe(429);
    for (let i = 0; i < 10; i += 1) expect((await handle(k, call('staff:u-chitra', `203.0.113.${i + 1}`))).status, `till call ${i + 1}`).toBe(200);
  });

  it('the staff spending all of theirs never refuses a customer', async () => {
    const k = kernel({ rateLimit: bucket(100), tenantRateLimit: bucket(4), customerRateLimit: bucket(4), isCustomer });
    for (let i = 0; i < 4; i += 1) expect((await handle(k, call('staff:u-devi', `203.0.113.${i + 1}`))).status).toBe(200);
    expect((await handle(k, call('staff:u-devi', '203.0.113.50'))).status).toBe(429);
    expect((await handle(k, call('customer:c1', '198.51.100.1'))).status).toBe(200);
  });
});

describe('audit 27 Nov item 3 — the allowances are settings, with defaults, and a shop\'s can never be smaller than one address\'s', () => {
  const only = (env: Record<string, string>) => {
    const keys = CLOUD_API_CONFIG.filter((c) => c.key.startsWith('RATE_LIMIT_'));
    const loaded = loadConfig(keys, env);
    if (!loaded.ok) return { loaded, settings: undefined };
    return { loaded, settings: rateLimitSettingsOf(loaded.value!) };
  };

  it('defaults: 240 + 20/s per address, 2400 + 200/s per shop, 1200 + 100/s for the shop\'s customers', () => {
    const { settings } = only({});
    expect(settings).toEqual({ ok: true, value: {
      perAddress: { capacity: 240, refillPerSecond: 20 },
      perShop: { capacity: 2400, refillPerSecond: 200 },
      customersPerShop: { capacity: 1200, refillPerSecond: 100 },
    } });
  });

  it('a setting can change them', () => {
    const { settings } = only({ RATE_LIMIT_PER_SHOP_BURST: '5000', RATE_LIMIT_CUSTOMERS_PER_SHOP_PER_SECOND: '40' });
    expect(settings?.ok && settings.value.perShop.capacity).toBe(5000);
    expect(settings?.ok && settings.value.customersPerShop.refillPerSecond).toBe(40);
  });

  it('a shop allowance smaller than one address\'s is refused (it would bring the fault back); zero or less is refused', () => {
    const { settings } = only({ RATE_LIMIT_PER_SHOP_BURST: '100' });
    expect(settings?.ok).toBe(false);
    expect(settings !== undefined && !settings.ok && settings.detail).toContain('RATE_LIMIT_PER_SHOP must be at least RATE_LIMIT_PER_ADDRESS');
    expect(only({ RATE_LIMIT_PER_ADDRESS_PER_SECOND: '0' }).loaded.ok).toBe(false);
  });

  it('a customer is read from the signed caller id (the customer realm\'s `customer-…`), nobody else', () => {
    expect(isCustomerCaller({ tenantId: 't', userId: 'customer-ab12', branchId: null })).toBe(true);
    expect(isCustomerCaller({ tenantId: 't', userId: 'u-owner', branchId: null })).toBe(false);
  });
});
