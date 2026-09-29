import { describe, it, expect } from 'vitest';
import {
  catalogueRoutes, hmacSigner, publishPack, type CatalogueDeps, type SignedPack,
} from '../../services/catalogue/src/index';
import {
  buildRouter, handle, MemoryIdempotencyStore, type HttpRequest, type Principal,
} from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import type { CatalogueProduct, CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// POST /v1/catalogue/pack on the REAL kernel pipeline with a snapshot double: a BULK publish (at or above the
// owner's threshold) or a SENSITIVE one (a regulated product added / changed) is refused 403
// `reauthentication_required` unless the SIGNED token carries a fresh MFA re-auth — and NOTHING is stored; a
// routine publish (a few ordinary lines) is not asked. The snapshot double lets the regulated leg be proven
// here: the cloud's product master does not yet carry a restriction into the pack (a named follow-on).
// (ADR-0013 point 4 · SEC-03 · §28 · Stage E slice 1.)

const signer = hmacSigner(['catalogue', 'step', 'up', 'test', 'key'].join('-').padEnd(40, '0'));
const NOW_SEC = Math.floor(Date.now() / 1000);

const product = (i: number, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: `P${String(i).padStart(4, '0')}`, sku: `SKU-${i}`, name: `Product ${i}`,
  baseUom: 'each', unitPriceMinor: 1_000 + i, taxBps: 500, mrpMinor: 5_000, status: 'active', ...over,
});
const snapshot = (products: CatalogueProduct[], version: number): CatalogueSnapshot =>
  ({ tenantId: 't-sre', version, builtAt: '2026-09-29T06:00:00Z', products, barcodes: [] });
const many = (n: number) => Array.from({ length: n }, (_, i) => product(i));

const ACCESS = new AccessControl(
  [{ id: 'manager', name: 'Manager', permissions: ['catalogue.pack.read', 'catalogue.pack.publish'] }],
  [{ userId: 'u-manager', roleId: 'manager', branchScope: ['b-main'] }],
);
const FRESH_MFA: Principal = { tenantId: 't-sre', userId: 'u-manager', branchId: 'b-main', authTime: NOW_SEC - 5, amr: ['pwd', 'mfa'] };
const PWD_ONLY: Principal = { tenantId: 't-sre', userId: 'u-manager', branchId: 'b-main', authTime: NOW_SEC - 5, amr: ['pwd'] };
const NO_EVIDENCE: Principal = { tenantId: 't-sre', userId: 'u-manager', branchId: 'b-main' };

function service(input: { previous?: CatalogueSnapshot; next: CatalogueSnapshot; threshold?: number; principal: Principal }) {
  let stored: SignedPack | undefined = input.previous === undefined ? undefined
    : publishPack({ snapshot: input.previous, approvals: [], signer, publishedBy: 'u-manager', publishedAt: '2026-09-28T06:00:00Z' }).pack!;
  const deps: CatalogueDeps = {
    signer,
    currentPack: () => stored,
    storePack: (_t, p) => { stored = p; },
    buildSnapshot: () => input.next,
    approvalsSince: () => [],
    now: () => new Date().toISOString(),
    ...(input.threshold === undefined ? {} : { bulkPublishThreshold: () => input.threshold }),
  };
  const built = buildRouter(catalogueRoutes(deps));
  if (!built.ok) throw new Error(built.refusals.map((r) => r.detail).join('; '));
  const opts = {
    router: built.router!, authenticate: () => input.principal, access: ACCESS,
    idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
  };
  const publish = (key = 'k1') => handle(opts, {
    method: 'POST', path: '/v1/catalogue/pack', headers: { authorization: 'Bearer good', 'idempotency-key': key }, body: {},
  } as HttpRequest);
  return { publish, held: () => stored };
}

const codeOf = (res: { body: unknown }) => (res.body as { error?: { code?: string; whatHappened?: string } }).error;

describe('POST /v1/catalogue/pack — bulk / sensitive publish needs a fresh MFA re-auth at the API boundary', () => {
  it('a FIRST publish of 60 products (default threshold 50) with a password-only session is refused, and nothing is stored', async () => {
    const s = service({ next: snapshot(many(60), 1), principal: PWD_ONLY });
    const res = await s.publish();
    expect(res.status).toBe(403);
    expect(codeOf(res)?.code).toBe('reauthentication_required');
    expect(codeOf(res)?.whatHappened).toContain('changes 60 products');
    expect(codeOf(res)?.whatHappened).toContain('bulk threshold of 50');
    expect(s.held()).toBeUndefined();
  });

  it('the same first publish with a fresh MFA sign-in is published (201) and the pack is held', async () => {
    const s = service({ next: snapshot(many(60), 1), principal: FRESH_MFA });
    expect((await s.publish()).status).toBe(201);
    expect(s.held()?.snapshot.version).toBe(1);
  });

  it('a ROUTINE publish (one price changed, below the threshold) is not asked — password-only publishes it', async () => {
    const before = snapshot(many(20), 1);
    const after = snapshot(many(20).map((p, i) => (i === 3 ? { ...p, unitPriceMinor: 4_444 } : p)), 2);
    const s = service({ previous: before, next: after, principal: NO_EVIDENCE });
    expect((await s.publish()).status).toBe(201);
    expect(s.held()?.snapshot.version).toBe(2);
  });

  it('the OWNER’s threshold is honoured: 3 changed lines are bulk for a shop whose threshold is 3', async () => {
    const before = snapshot(many(20), 1);
    const after = snapshot(many(20).map((p, i) => (i < 3 ? { ...p, unitPriceMinor: 3_333 } : p)), 2); // below MRP: the pack itself is fine
    const refused = service({ previous: before, next: after, threshold: 3, principal: PWD_ONLY });
    expect((await refused.publish()).status).toBe(403);
    expect(refused.held()?.snapshot.version).toBe(1); // unchanged
    const allowed = service({ previous: before, next: after, threshold: 4, principal: PWD_ONLY });
    expect((await allowed.publish()).status).toBe(201);
  });

  it('a REGULATED product added in an otherwise tiny publish needs the step-up; no evidence at all → refused', async () => {
    const before = snapshot(many(5), 1);
    const after = snapshot([...many(5), product(99, { regulatedFlags: { minimumAge: 18 } })], 2);
    const s = service({ previous: before, next: after, principal: NO_EVIDENCE });
    const res = await s.publish();
    expect(res.status).toBe(403);
    expect(codeOf(res)?.whatHappened).toContain('regulated product (P0099)');
    expect(codeOf(res)?.whatHappened).toContain('carries none');
    expect(s.held()?.snapshot.version).toBe(1);
    const ok = service({ previous: before, next: after, principal: FRESH_MFA });
    expect((await ok.publish()).status).toBe(201);
  });

  it('a STALE MFA re-auth is refused for a bulk publish with its own reason', async () => {
    const stale: Principal = { ...FRESH_MFA, authTime: NOW_SEC - 100_000 };
    const s = service({ next: snapshot(many(60), 1), principal: stale });
    const res = await s.publish();
    expect(res.status).toBe(403);
    expect(codeOf(res)?.whatHappened).toContain('gone stale');
  });

  it('the pack’s own refusals still run AFTER the step-up passes (an empty pack is refused 422, not 403)', async () => {
    const s = service({ next: snapshot([], 1), principal: FRESH_MFA });
    const res = await s.publish();
    expect(res.status).toBe(422);
    expect(codeOf(res)?.code).toBe('empty_pack');
  });
});
