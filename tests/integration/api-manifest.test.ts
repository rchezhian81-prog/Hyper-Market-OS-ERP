// M36-FR-04 / P-06 through the real authenticated API: a partner-facing read of the versioned surface the
// kernel serves — itself included — with the permission and feature each call needs; nothing across tenants.
import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa36';
const OWNER = 'u-owner'; const PADMIN = 'u-padmin'; const CASH = 'u-cash';
const get = (h: ApiHarness, path: string, u: string, query: Record<string, string> = {}) => h.request({ method: 'GET', path, userId: u, tenantId: A, query });
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Manifest { majorVersion: string; apis: { api: string; name: string; routes: { method: string; path: string; permission: string; entitlement: string | null; idempotent: boolean; write: boolean }[] }[]; counts: { routes: number; apis: number; writes: number; idempotentWrites: number }; violations: string[]; conventions: Record<string, string>; documentation: Record<string, string> }

describe('the versioned API surface manifest (M36-FR-04, API-11)', () => {
  it('lists every endpoint the running kernel serves, grouped by domain, with what each call needs — itself included', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, PADMIN, 'platform_admin');
    const res = await get(h, '/v1/platform/api-manifest', PADMIN);
    expect(res.status).toBe(200);
    const m = res.body as Manifest;
    expect(m.majorVersion).toBe('v1');
    expect(m.counts.routes).toBeGreaterThan(300);
    expect(m.counts.writes).toBe(m.counts.idempotentWrites); // every write on the surface declares idempotency
    expect(m.violations).toEqual([]);
    const all = m.apis.flatMap((s) => s.routes);
    expect(all.every((r) => r.path.startsWith('/v1/'))).toBe(true);
    expect(all.find((r) => r.path === '/v1/platform/api-manifest')).toMatchObject({ method: 'GET', permission: 'platform.partner.read', entitlement: null, write: false });
    const finance = m.apis.find((s) => s.api === 'API-09')!;
    expect(finance.name).toBe('Finance');
    expect(finance.routes.find((r) => r.path === '/v1/finance/day-book/:tradingDay/post')).toMatchObject({ method: 'POST', permission: 'finance.journal.post', idempotent: true });
    expect(finance.routes.find((r) => r.path === '/v1/concession/contracts/:contractId/tags/:tagId')).toMatchObject({ entitlement: 'dept.concession' });
    expect(m.documentation['surface']).toBe('docs/api/surface.md');
    expect(m.conventions['versioning']).toMatch(/\/v1\//);
  });

  it('filters to one domain, refuses an unknown one, and is for the platform operator — not a cashier, not even the owner', async () => {
    const h = apiHarness();
    await h.seedOwner(A, OWNER);
    await h.provisionRole(A, PADMIN, 'platform_admin');
    await h.provisionRole(A, CASH, 'cashier');
    const pos = (await get(h, '/v1/platform/api-manifest', PADMIN, { api: 'API-05' })).body as Manifest;
    expect(pos.apis.map((s) => s.api)).toEqual(['API-05']);
    expect(pos.apis[0]!.routes.some((r) => r.path === '/v1/sales')).toBe(true);
    const bad = await get(h, '/v1/platform/api-manifest', PADMIN, { api: 'API-99' });
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('unknown_api_domain');
    expect((await get(h, '/v1/platform/api-manifest', CASH)).status).toBe(403);
    expect((await get(h, '/v1/platform/api-manifest', OWNER)).status).toBe(403);
  });
});
