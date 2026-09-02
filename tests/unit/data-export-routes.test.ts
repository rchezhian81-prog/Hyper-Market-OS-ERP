import { describe, it, expect } from 'vitest';
import { dataExportRoutes, type ExportDomainSource } from '../../services/purchase/src/data-export';
import { AccessControl, type Role, type RoleAssignment } from '../../packages/rbac/src/rbac';
import type { ExportAudit } from '../../packages/export/src/export';
import type { RequestContext, HandlerResult } from '../../services/kernel/src/index';

// The export ROUTES pass the caller's real authority through to the tested engine, per domain and
// per caller: the domain's own permission decides allowed-or-403, the token's branch decides which
// rows, and `export.sensitive` decides shown-or-redacted — and every export is logged. These drive
// the handlers directly over a purpose-built domain (a people list with a branch column and a
// sensitive phone column) so the redaction and scope WIRING is proven end to end, not just the
// engine underneath it. (The route-level `export.read` gate is the kernel's, proven in the
// integration test.)

const PEOPLE: ExportDomainSource = {
  spec: {
    domain: 'people',
    requires: 'people.read',
    branchColumn: 'branch',
    columns: [
      { name: 'id', type: 'text' },
      { name: 'branch', type: 'text' },
      { name: 'phone', type: 'text', sensitive: true },
    ],
  },
  rows: () => [
    { id: '1', branch: 'b1', phone: '9990001111' },
    { id: '2', branch: 'b2', phone: '8880002222' },
  ],
};

const ROLES: readonly Role[] = [
  { id: 'viewer', name: 'Viewer', permissions: ['export.read', 'people.read'] },
  { id: 'viewer_sensitive', name: 'Viewer (sensitive)', permissions: ['export.read', 'people.read', 'export.sensitive'] },
  { id: 'export_only', name: 'Export only', permissions: ['export.read'] },
];
const ASSIGNMENTS: readonly RoleAssignment[] = [
  { userId: 'u-plain', roleId: 'viewer', branchScope: 'all' },
  { userId: 'u-sensitive', roleId: 'viewer_sensitive', branchScope: 'all' },
  { userId: 'u-b1', roleId: 'viewer', branchScope: ['b1'] },
  { userId: 'u-export-only', roleId: 'export_only', branchScope: 'all' },
];

const NOW = '2026-09-02T00:00:00.000Z';

function harness() {
  const logged: ExportAudit[] = [];
  const routes = dataExportRoutes({
    domains: [PEOPLE],
    access: () => new AccessControl(ROLES, ASSIGNMENTS),
    exports: () => logged,
    recordExport: (_t, r) => { logged.push(r); },
    now: () => NOW,
  });
  const byPath = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!;
  return { logged, list: byPath('GET', '/v1/export'), exportOne: byPath('POST', '/v1/export/:domain'), log: byPath('GET', '/v1/exports') };
}

const ctx = (over: Partial<RequestContext>): RequestContext => ({
  tenantId: 't-1', userId: 'u-plain', branchId: null, params: {}, query: {}, body: {}, traceId: 'trace-test', ...over,
});

// The handler throws an apiError object ({ status, body }) rather than returning it on refusal.
async function run(route: { handler: (c: RequestContext) => Promise<HandlerResult> | HandlerResult }, c: RequestContext): Promise<HandlerResult> {
  try {
    return await route.handler(c);
  } catch (e) {
    return e as HandlerResult;
  }
}

describe('data-export routes: authority, branch scope and sensitive redaction are wired to the engine', () => {
  it('redacts a sensitive column for a caller without export.sensitive, and records what was redacted', async () => {
    const h = harness();
    const res = await run(h.exportOne, ctx({ userId: 'u-plain', params: { domain: 'people' }, idempotencyKey: 'k1' }));
    expect(res.status).toBe(200);
    const body = res.body as { csv: string; audit: ExportAudit };
    expect(body.csv).toContain('[redacted]');
    expect(body.csv).not.toContain('9990001111');
    expect(body.audit.redactedColumns).toEqual(['phone']);
    expect(h.logged).toHaveLength(1); // the export was logged
  });

  it('shows the sensitive column for a caller who holds export.sensitive', async () => {
    const h = harness();
    const res = await run(h.exportOne, ctx({ userId: 'u-sensitive', params: { domain: 'people' }, idempotencyKey: 'k2' }));
    const body = res.body as { csv: string; audit: ExportAudit };
    expect(body.csv).toContain('9990001111');
    expect(body.csv).not.toContain('[redacted]');
    expect(body.audit.redactedColumns).toEqual([]);
  });

  it('filters rows to the caller’s branch (a manager cannot export another branch)', async () => {
    const h = harness();
    const res = await run(h.exportOne, ctx({ userId: 'u-b1', branchId: 'b1', params: { domain: 'people' }, idempotencyKey: 'k3' }));
    const body = res.body as { csv: string; audit: ExportAudit };
    expect(body.audit.rowCount).toBe(1); // only branch b1
    expect(body.csv).toContain('b1');
    expect(body.csv).not.toContain('b2');

    // The same user reaching for another branch is denied outright (their grant does not cover b2).
    const denied = await run(h.exportOne, ctx({ userId: 'u-b1', branchId: 'b2', params: { domain: 'people' }, idempotencyKey: 'k3b' }));
    expect(denied.status).toBe(403);
  });

  it('refuses a caller who lacks the domain’s own permission (403), logging nothing', async () => {
    const h = harness();
    const res = await run(h.exportOne, ctx({ userId: 'u-export-only', params: { domain: 'people' }, idempotencyKey: 'k4' }));
    expect(res.status).toBe(403);
    // Handlers throw the ApiError directly here, so its body is the raw ApiErrorBody (code at top level);
    // through the kernel the same body is wrapped under `error` (proven in the integration test).
    expect((res.body as { code?: string }).code).toBe('export_not_permitted');
    expect(h.logged).toHaveLength(0);
  });

  it('404s an unknown domain, lists the domains with their sensitivity, and reads the export log newest-first', async () => {
    const h = harness();
    expect((await run(h.exportOne, ctx({ params: { domain: 'nope' }, idempotencyKey: 'k5' }))).status).toBe(404);

    const list = (await run(h.list, ctx({}))).body as { domains: { domain: string; requires: string; columns: { name: string; sensitive: boolean }[] }[] };
    const people = list.domains.find((d) => d.domain === 'people')!;
    expect(people.requires).toBe('people.read');
    expect(people.columns.find((c) => c.name === 'phone')!.sensitive).toBe(true);

    await run(h.exportOne, ctx({ userId: 'u-plain', params: { domain: 'people' }, idempotencyKey: 'k6' }));
    const log = (await run(h.log, ctx({}))).body as { exports: ExportAudit[]; total: number };
    expect(log.total).toBe(1);
    expect(log.exports[0]!.domain).toBe('people');
  });
});
