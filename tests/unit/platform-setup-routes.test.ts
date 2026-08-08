import { describe, it, expect } from 'vitest';
import { platformRoutes, inMemorySettings, emptyExportBundle, type PlatformDeps } from '../../services/platform/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { SetupStatus } from '../../packages/tenant/src/index';

// The self-service store-setup surface on API-11 (M33-FR-01): a tenant reads its own setup state
// and answers items; an invalid answer is refused by name and nothing is stored; tenants isolated.

const NOW = '2026-08-07T10:00:00Z';

function deps(): PlatformDeps {
  return {
    probe: () => [],
    flags: () => ({}),
    setFlag: () => {},
    recordSupportAccess: () => {},
    settings: inMemorySettings(),
    exportTenant: () => emptyExportBundle(),
    setBranding: () => {},
    branding: () => undefined,
    now: () => NOW,
  };
}

function ctx(over: Partial<RequestContext>): RequestContext {
  return { tenantId: 'acme', userId: 'owner-1', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over };
}

const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};

interface ThrownApiError { readonly status: number; readonly body: { readonly code: string } }
async function statusOfThrow(fn: () => Promise<unknown>): Promise<ThrownApiError> {
  try {
    await fn();
  } catch (e) {
    return e as ThrownApiError;
  }
  throw new Error('expected the handler to throw');
}

describe('GET /v1/platform/setup', () => {
  it('reports a fresh tenant as running on defaults but blocked on the tax class', async () => {
    const routes = platformRoutes(deps());
    const res = await routeFor(routes, 'GET', '/v1/platform/setup').handler(ctx({}));
    expect(res.status).toBe(200);
    const body = res.body as SetupStatus;
    expect(body.blocking).toEqual(['tax.default_bps']);
    expect(body.complete).toBe(false);
    expect(body.answered).toBe(0);
  });
});

describe('PUT /v1/platform/setup/:key', () => {
  it('accepts a valid answer, clears the block, and persists for that tenant', async () => {
    const routes = platformRoutes(deps());
    const put = routeFor(routes, 'PUT', '/v1/platform/setup/:key');
    const res = await put.handler(ctx({ params: { key: 'tax.default_bps' }, body: { value: 1800 } }));
    expect(res.status).toBe(200);
    const body = res.body as SetupStatus;
    expect(body.complete).toBe(true);
    expect(body.blocking).toEqual([]);
    expect(body.answered).toBe(1);

    // A second read on the same deps still sees it (same settings instance).
    const get = routeFor(routes, 'GET', '/v1/platform/setup');
    const after = (await get.handler(ctx({}))).body as SetupStatus;
    expect(after.items.find((i) => i.key === 'tax.default_bps')?.state).toBe('answered');
    // A different tenant is untouched — still blocked.
    const other = (await get.handler(ctx({ tenantId: 'other' }))).body as SetupStatus;
    expect(other.blocking).toEqual(['tax.default_bps']);
  });

  it('refuses an unknown setting with 404', async () => {
    const put = routeFor(platformRoutes(deps()), 'PUT', '/v1/platform/setup/:key');
    const err = await statusOfThrow(() => Promise.resolve(put.handler(ctx({ params: { key: 'nope' }, body: { value: 1 } }))));
    expect(err.status).toBe(404);
    expect(err.body.code).toBe('unknown_setting');
  });

  it('refuses a body with no value with 400', async () => {
    const put = routeFor(platformRoutes(deps()), 'PUT', '/v1/platform/setup/:key');
    const err = await statusOfThrow(() => Promise.resolve(put.handler(ctx({ params: { key: 'tax.default_bps' }, body: {} }))));
    expect(err.status).toBe(400);
    expect(err.body.code).toBe('setup_value_not_given');
  });

  it('refuses an invalid value with 422 and stores nothing', async () => {
    const routes = platformRoutes(deps());
    const put = routeFor(routes, 'PUT', '/v1/platform/setup/:key');
    const err = await statusOfThrow(() => Promise.resolve(put.handler(ctx({ params: { key: 'tax.default_bps' }, body: { value: 999_999 } }))));
    expect(err.status).toBe(422);
    expect(err.body.code).toBe('setup_answer_refused');
    // Nothing was stored: still blocking.
    const get = routeFor(routes, 'GET', '/v1/platform/setup');
    expect(((await get.handler(ctx({}))).body as SetupStatus).blocking).toEqual(['tax.default_bps']);
  });

  it('refuses a stale save with 409 (optimistic concurrency)', async () => {
    const routes = platformRoutes(deps());
    const put = routeFor(routes, 'PUT', '/v1/platform/setup/:key');
    // First save takes the version to 1.
    await put.handler(ctx({ params: { key: 'trading_day.cutoff' }, body: { value: '22:00' } }));
    // A save that still thinks the version is 0 is refused, not applied.
    const err = await statusOfThrow(() => Promise.resolve(
      put.handler(ctx({ params: { key: 'trading_day.cutoff' }, body: { value: '23:00', ifVersion: 0 } })),
    ));
    expect(err.status).toBe(409);
    expect(err.body.code).toBe('setup_version_conflict');
    const get = routeFor(routes, 'GET', '/v1/platform/setup');
    const after = (await get.handler(ctx({}))).body as SetupStatus;
    expect(after.items.find((i) => i.key === 'trading_day.cutoff')?.value).toBe('22:00'); // unchanged
  });

  it('exposes each item version in the status, and bumps it on save', async () => {
    const routes = platformRoutes(deps());
    const get = routeFor(routes, 'GET', '/v1/platform/setup');
    expect(((await get.handler(ctx({}))).body as SetupStatus).items.every((i) => i.version === 0)).toBe(true);
    const put = routeFor(routes, 'PUT', '/v1/platform/setup/:key');
    await put.handler(ctx({ params: { key: 'trading_day.cutoff' }, body: { value: '22:00' } }));
    const after = (await get.handler(ctx({}))).body as SetupStatus;
    expect(after.items.find((i) => i.key === 'trading_day.cutoff')?.version).toBe(1);
  });
});
