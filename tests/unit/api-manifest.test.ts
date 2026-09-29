// M36-FR-04 / P-06 — the API surface manifest is generated from the route table itself, so it cannot drift.
import { describe, it, expect } from 'vitest';
import { buildApiManifest, renderApiSurface, apiManifestRoutes, API_DOMAINS, MAJOR_VERSION } from '../../services/platform/src/api-manifest';
import type { RequestContext, Route } from '../../services/kernel/src/index';

const NOW = '2026-09-29T10:00:00.000Z';
const ok = { status: 200, body: {} };
const route = (over: Partial<Route>): Route => ({ api: 'API-09', method: 'GET', path: '/v1/finance/x', permission: 'finance.period.read', handler: () => ok, ...over });
const TABLE: readonly Route[] = [
  route({ api: 'API-09', method: 'POST', path: '/v1/finance/day-book/:tradingDay/post', permission: 'finance.journal.post', idempotent: true }),
  route({ api: 'API-09', method: 'GET', path: '/v1/finance/day-book/:tradingDay', permission: 'finance.period.read' }),
  route({ api: 'API-09', method: 'PUT', path: '/v1/finance/posting-map', permission: 'finance.posting.configure', idempotent: true }),
  route({ api: 'API-09', method: 'GET', path: '/v1/finance/posting-map', permission: 'finance.period.read' }),
  route({ api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/tags/:tagId', permission: 'concession.tag.record', entitlement: 'dept.concession', idempotent: true }),
  route({ api: 'API-11', method: 'GET', path: '/v1/platform/api-manifest', permission: 'platform.partner.read' }),
];
const ctx = (over: Partial<RequestContext> = {}): RequestContext =>
  ({ tenantId: 't', userId: 'u', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

describe('buildApiManifest — the surface, grouped and judged', () => {
  it('groups every route under its API domain, sorted, with permission / feature / idempotency read off the route', () => {
    const m = buildApiManifest(TABLE, NOW);
    expect(m.majorVersion).toBe(MAJOR_VERSION);
    expect(m.generatedAt).toBe(NOW);
    expect(m.apis.map((s) => s.api)).toEqual(Object.keys(API_DOMAINS));
    const finance = m.apis.find((s) => s.api === 'API-09')!;
    expect(finance).toMatchObject({ name: 'Finance', modules: 'M23' });
    expect(finance.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/concession/contracts/:contractId/tags/:tagId',
      'GET /v1/finance/day-book/:tradingDay',
      'POST /v1/finance/day-book/:tradingDay/post',
      'GET /v1/finance/posting-map',
      'PUT /v1/finance/posting-map',
    ]);
    expect(finance.routes[0]).toEqual({ method: 'POST', path: '/v1/concession/contracts/:contractId/tags/:tagId', permission: 'concession.tag.record', entitlement: 'dept.concession', write: true, idempotent: true });
    expect(finance.routes[1]).toMatchObject({ entitlement: null, write: false, idempotent: false });
    expect(m.counts).toEqual({ apis: 2, routes: 6, writes: 3, idempotentWrites: 3, entitled: 1, permissions: 5 });
    expect(m.violations).toEqual([]);
    expect(m.apis.find((s) => s.api === 'API-13')!.routes).toEqual([]);
  });

  it('names a convention violation instead of hiding it: an unversioned path, a write without idempotency', () => {
    const m = buildApiManifest([
      route({ path: '/finance/legacy' }),
      route({ method: 'POST', path: '/v1/finance/fire', permission: 'finance.journal.post' }),
    ], NOW);
    expect(m.violations).toEqual([
      'GET /finance/legacy carries no major version (P-06)',
      'POST /v1/finance/fire is a write that does not declare idempotency',
    ]);
  });

  it('renders a deterministic markdown surface (no timestamp), one table per domain, feature and idempotency visible', () => {
    const md = renderApiSurface(buildApiManifest(TABLE, NOW));
    expect(md).not.toContain(NOW);
    expect(md).toContain('# The API surface (generated — do not edit by hand)');
    expect(md).toContain('## API-09 — Finance (M23)');
    expect(md).toContain('| POST | `/v1/concession/contracts/:contractId/tags/:tagId` | `concession.tag.record` | `dept.concession` | yes |');
    expect(md).toContain('| GET | `/v1/finance/day-book/:tradingDay` | `finance.period.read` | core | — |');
    expect(md).toContain('## API-13 — AI (A01–A10)\n\n_No endpoints served yet._');
    expect(md).toContain('| 2 | 6 | 3 | 3 | 1 | 5 |');
    expect(renderApiSurface(buildApiManifest(TABLE, '2027-01-01T00:00:00.000Z'))).toBe(md);
  });
});

describe('GET /v1/platform/api-manifest', () => {
  const live: Route[] = [...TABLE];
  const routes = apiManifestRoutes({ routes: () => live, now: () => NOW });
  const get = (query: Record<string, string> = {}) => routes[0]!.handler(ctx({ query }));

  it('is a partner-readable core read on API-11 and includes whatever is registered at request time — itself included', async () => {
    expect(routes.map((r) => [r.method, r.path, r.permission, r.entitlement])).toEqual([['GET', '/v1/platform/api-manifest', 'platform.partner.read', undefined]]);
    const body = (await get()).body as { counts: { routes: number }; apis: { api: string; routes: unknown[] }[] };
    expect(body.counts.routes).toBe(6);
    live.push(route({ api: 'API-05', method: 'GET', path: '/v1/sales/:saleId', permission: 'pos.sale.read' }));
    expect(((await get()).body as { counts: { routes: number } }).counts.routes).toBe(7);
  });

  it('filters to one domain, and refuses a domain that does not exist', async () => {
    const body = (await get({ api: 'API-11' })).body as { apis: { api: string }[] };
    expect(body.apis.map((s) => s.api)).toEqual(['API-11']);
    let refused: { status: number; body: { code: string } } | undefined;
    try { await get({ api: 'API-99' }); } catch (e) { refused = e as { status: number; body: { code: string } }; }
    expect(refused).toMatchObject({ status: 400, body: { code: 'unknown_api_domain' } });
  });
});
