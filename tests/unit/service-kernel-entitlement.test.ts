import { describe, it, expect } from 'vitest';
import {
  buildRouter, handle, MemoryIdempotencyStore,
  type Route, type HttpRequest, type Principal, type EntitlementResolver,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';

/**
 * Per-route FEATURE ENTITLEMENT enforcement (M36-FR-01 · §35 · P-04 default-deny).
 *
 * SRE Retail OS is a commercial, multi-tenant product: some routes belong to OPTIONAL/paid features a
 * tenant's plan may or may not include. A route that names an `entitlement` is refused for a tenant whose
 * plan has not enabled it — **on top of the permission check, and default-deny**: a paid feature the shop
 * did not buy is off even for a user who holds the permission, and the tenant is read only from the SIGNED
 * principal, never anything the caller supplied. Core routes carry no `entitlement` and are always
 * available. A route that names a feature while no entitlement resolver is wired is refused (fail-closed),
 * never let through.
 */

const ok = (body: unknown = { ok: true }) => () => ({ status: 200, body });

// A CORE route (no entitlement) and a PAID route (entitlement 'delivery'); both need only the cashier's
// pos.sale.read, so a refusal is about the ENTITLEMENT, never a missing permission.
const CORE: Route = { api: 'API-05', method: 'GET', path: '/v1/sales', permission: 'pos.sale.read', handler: ok() };
const PAID: Route = { api: 'API-07', method: 'GET', path: '/v1/delivery/orders', permission: 'pos.sale.read', entitlement: 'delivery', handler: ok() };
// A paid route the cashier does NOT hold the permission for — to prove permission is checked BEFORE the feature.
const PAID_LOCKED: Route = { api: 'API-07', method: 'GET', path: '/v1/delivery/settings', permission: 'platform.setup.write', entitlement: 'delivery', handler: ok() };

const ACCESS = new AccessControl(
  [{ id: 'cashier', name: 'Cashier', permissions: ['pos.sale.read'] }],
  [
    { userId: 'u-meena', roleId: 'cashier', branchScope: ['b-main'] },
    { userId: 'u-other', roleId: 'cashier', branchScope: ['b-main'] },
  ],
);

const SRE: Principal = { tenantId: 't-sre', userId: 'u-meena', branchId: 'b-main' };
const OTHER: Principal = { tenantId: 't-other', userId: 'u-other', branchId: 'b-main' };

// t-sre's plan includes delivery; every other tenant's plan does not (default-deny).
const entitlements: EntitlementResolver = (tenantId) => (tenantId === 't-sre' ? ['delivery'] : []);

const kernel = (over: Partial<Parameters<typeof handle>[0]> = {}) => {
  const built = buildRouter([CORE, PAID, PAID_LOCKED]);
  if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
  return {
    router: built.router!,
    authenticate: (t: string) => (t === 'sre' ? SRE : t === 'other' ? OTHER : undefined),
    access: ACCESS, idempotency: new MemoryIdempotencyStore(),
    entitlements, newTraceId: () => 'trace-ent', ...over,
  };
};

const get = (path: string, token = 'sre'): HttpRequest => ({ method: 'GET', path, headers: { authorization: `Bearer ${token}` } });

describe('a core route is unaffected by entitlements', () => {
  it('serves the core /v1/sales for an entitled and an un-entitled tenant alike', async () => {
    expect((await handle(kernel(), get('/v1/sales', 'sre'))).status).toBe(200);
    expect((await handle(kernel(), get('/v1/sales', 'other'))).status).toBe(200);
    // Even with NO resolver wired, a core route (no entitlement) is untouched.
    expect((await handle(kernel({ entitlements: undefined }), get('/v1/sales', 'sre'))).status).toBe(200);
  });
});

describe('a paid route is gated on the tenant plan, default-deny', () => {
  it('the entitled tenant reaches it', async () => {
    const res = await handle(kernel(), get('/v1/delivery/orders', 'sre'));
    expect(res.status).toBe(200);
  });

  it('an un-entitled tenant is refused feature_not_entitled — even holding the permission', async () => {
    const res = await handle(kernel(), get('/v1/delivery/orders', 'other'));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('feature_not_entitled');
    // The reason names the feature, not the user — this is about the plan, not the person.
    expect((res.body as { error?: { whatHappened?: string } }).error?.whatHappened).toContain('delivery');
  });

  it('per-tenant isolation: enabling delivery for one tenant never turns it on for another', async () => {
    // The SAME kernel, two tenants: t-sre reaches it, t-other does not.
    const k = kernel();
    expect((await handle(k, get('/v1/delivery/orders', 'sre'))).status).toBe(200);
    expect((await handle(k, get('/v1/delivery/orders', 'other'))).status).toBe(403);
  });
});

describe('the entitlement check is fail-closed and ordered after the permission check', () => {
  it('a paid route with NO entitlement resolver wired is refused, never let through (fail-closed)', async () => {
    const res = await handle(kernel({ entitlements: undefined }), get('/v1/delivery/orders', 'sre'));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('feature_not_entitled');
  });

  it('a caller LACKING the permission on a paid route gets the permission refusal, not a hint of the feature', async () => {
    // u-meena (cashier) does not hold platform.setup.write. The permission check fires FIRST, so an
    // unauthorized caller learns nothing about whether the shop has the feature.
    const res = await handle(kernel(), get('/v1/delivery/settings', 'sre'));
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('forbidden');
  });
});
