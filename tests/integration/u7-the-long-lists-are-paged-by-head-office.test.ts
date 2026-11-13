import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';
import { AuditTrail, InMemoryAuditStore } from '../../packages/audit/src/audit-trail';
import { storedAuditTrailRoutes } from '../../services/finance/src/audit-trail-store';
import { dataImportRoutes, type DataImportDeps } from '../../services/purchase/src/data-import';
import { floorDeviceRoutes, type FloorDeviceDeps, type EslPush } from '../../services/platform/src/device-events';
import type { RequestContext, Route } from '../../services/kernel/src/index';

/**
 * U7 (OB-725) · G17: the five lists that can grow past a few hundred rows — the audit trail, the import history, a
 * product's price history, the requisitions worklist and the shelf-label pushes — are paged by head office when the page
 * asks (`?page=&size=&search=&sort=&dir=`): the rows of that page, and the total it searched, so the register says
 * "Showing 1–2 of 3". Without `?page=` each answers exactly as before. A page it cannot read is refused by name.
 */
const T = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const route = (routes: readonly Route[], method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
const ctxOf = (query: Record<string, string>): RequestContext => ({ tenantId: T, userId: 'u-owner', scope: 'all', params: {}, query, body: undefined, traceId: 't' } as unknown as RequestContext);

describe('U7 · head office pages the long lists', () => {
  it('requisitions and a product\'s price history page through the real API; without ?page= the old answer', async () => {
    const h = apiHarness();
    await h.seedOwner(T, 'u-owner');
    for (const id of ['r1', 'r2', 'r3']) {
      expect((await h.request({ method: 'POST', path: `/v1/purchase/requisitions/${id}`, userId: 'u-owner', tenantId: T, idempotencyKey: id, body: { currency: 'INR', lines: [{ productId: 'P1', quantity: 2 }] } })).status).toBeLessThan(300);
    }
    const all = await h.request({ method: 'GET', path: '/v1/purchase/requisitions', userId: 'u-owner', tenantId: T });
    expect((all.body as { count: number; paging?: unknown }).count).toBe(3);
    expect((all.body as { paging?: unknown }).paging).toBeUndefined();
    const p2 = (await h.request({ method: 'GET', path: '/v1/purchase/requisitions', userId: 'u-owner', tenantId: T, query: { page: '2', size: '2', sort: 'requisitionId' } })).body as { requisitions: { requisitionId: string }[]; count: number; paging: { total: number; pages: number } };
    expect(p2.requisitions.map((r) => r.requisitionId)).toEqual(['r3']);
    expect(p2.paging).toMatchObject({ total: 3, pages: 2 });
    const bad = await h.request({ method: 'GET', path: '/v1/purchase/requisitions', userId: 'u-owner', tenantId: T, query: { page: '0' } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string; wasItSaved: string } }).error).toMatchObject({ code: 'not_readable_as_a_page', wasItSaved: 'not_saved' });

    const day = (n: number) => `2030-0${n}-01`;
    for (const [i, id] of ['e1', 'e2', 'e3'].entries()) {
      expect((await h.request({ method: 'POST', path: `/v1/prices/list/P1/entries/${id}`, userId: 'u-owner', tenantId: T, idempotencyKey: `price-${id}`, body: { scope: 'store', scopeRef: 'S1', priceMinor: 9_000 + i, currency: 'INR', mrpMinor: 10_000, costMinor: 1, marginFloorBps: 0, effectiveFrom: day(i + 1) } })).status).toBeLessThan(300);
    }
    const hist = (await h.request({ method: 'GET', path: '/v1/prices/list/P1/history', userId: 'u-owner', tenantId: T, query: { page: '1', size: '2', sort: 'effectiveFrom', dir: 'desc' } })).body as { entries: { id: string }[]; paging: { total: number } };
    expect(hist.entries.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(hist.paging.total).toBe(3);
  });

  it('the audit trail pages its matches, searching who and what', async () => {
    const trail = new AuditTrail(new InMemoryAuditStore());
    const at = (n: number) => `2026-11-13T0${n}:00:00.000Z`;
    for (const [n, who] of [[1, 'u-ravi'], [2, 'u-meena'], [3, 'u-ravi']] as const) {
      trail.record({ actorId: who, action: 'price.change', objectType: 'price_entry', objectId: `e${n}`, at: at(n), origin: { tenantId: T, branchId: null }, before: null, after: { priceMinor: String(n) } });
    }
    const r = route(storedAuditTrailRoutes({ records: () => trail.all() }), 'GET', '/v1/audit/trail');
    const old = (await r.handler(ctxOf({}))).body as { total: number; paging?: unknown };
    expect(old.total).toBe(3);
    expect(old.paging).toBeUndefined();
    const ravi = (await r.handler(ctxOf({ page: '1', size: '1', search: 'ravi', sort: 'at', dir: 'desc' }))).body as { matches: { objectId: string }[]; total: number; paging: { total: number } };
    expect(ravi.matches.map((m) => m.objectId)).toEqual(['e3']);
    expect(ravi.paging.total).toBe(2);
  });

  it('the import history and the shelf-label pushes page; the unconfirmed count stays the branch\'s whole count', async () => {
    const job = (n: number) => ({ jobId: `j${n}`, templateId: 'products', domain: 'products', uploadedBy: 'u-a', approvedBy: 'u-b', rowsApplied: n, at: `2026-11-1${n}T08:00:00.000Z`, rows: [] });
    const imp = route(dataImportRoutes({ commits: () => [job(1), job(2), job(3)], recordCommit: () => {}, now: () => '2026-11-13T09:00:00.000Z' } as unknown as DataImportDeps), 'GET', '/v1/import/commits');
    const page = (await imp.handler(ctxOf({ page: '1', size: '2' }))).body as { jobs: { jobId: string }[]; total: number; paging: { pages: number } };
    expect(page.jobs.map((j) => j.jobId)).toEqual(['j3', 'j2']); // newest first, as before
    expect(page.paging.pages).toBe(2);

    const push = (n: number): EslPush => ({ pushId: `p${n}`, branchId: 'S1', productId: `P${n}`, priceMinor: 100, because: 'price_change', sourceRef: `s${n}`, by: 'u', at: `2026-11-1${n}T08:00:00.000Z`, commands: [{ deviceId: 'd1', accepted: true, detail: 'ok' }], adapter: 'stub' });
    const esl = route(floorDeviceRoutes({ pushes: async () => [push(1), push(2), push(3)], events: async () => [], now: () => '2026-11-13T09:00:00.000Z' } as unknown as FloorDeviceDeps), 'GET', '/v1/devices/esl/pushes');
    const body = (await esl.handler(ctxOf({ branchId: 'S1', page: '1', size: '1', search: 'P2' }))).body as { pushes: { push: { pushId: string } }[]; notConfirmed: number; paging: { total: number } };
    expect(body.pushes.map((p) => p.push.pushId)).toEqual(['p2']);
    expect(body.paging.total).toBe(1);
    expect(body.notConfirmed).toBe(3);
  });
});
