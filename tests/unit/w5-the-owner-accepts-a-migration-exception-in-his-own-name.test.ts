import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import { buildRouter, handle, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import type { Acceptance } from '../../packages/migration/src/verification-report';

/**
 * W5 · OD-05 ("exceptions require owner approval") · MG-11 · P-04 — the owner accepts a migration exception in HIS OWN
 * NAME. Until W5 the acceptance route compared the body's `acceptedBy` with the owner, never the signed-in person: anybody
 * holding `migration.exception.accept` could type the owner's sign-in into the body and the acceptance was recorded as his.
 * Now head office takes the name from the session: a caller who is not the owner is refused whatever the body says, and
 * the recorded acceptance carries the signed-in owner and head office's own time.
 * Synthetic values only.
 */

const NOW = '2026-11-03T12:00:00.000Z';
const ACCESS = new AccessControl(
  [{ id: 'all', name: 'All', permissions: ['migration.exception.accept'] }],
  [{ userId: 'u-owner', roleId: 'all', branchScope: 'all' }, { userId: 'u-manager', roleId: 'all', branchScope: 'all' }],
);

function kernel(userId: string, recorded: Acceptance[], over: Partial<MigrationDeps> = {}) {
  const deps: MigrationDeps = {
    target: () => ({ targetId: 'tgt-1', tenantId: 't-sre', kind: 'rehearsal', label: 'synthetic rehearsal' }),
    findings: () => [], acceptances: () => recorded, signatures: () => [],
    recordAcceptance: (_t, a) => { recorded.push(a); }, ownerId: () => 'u-owner',
    extractionOperator: () => 'u-operator', exclusions: () => [], recordExclusion: () => {}, now: () => NOW, ...over,
  };
  const built = buildRouter(migrationRoutes(deps));
  expect(built.ok).toBe(true);
  return {
    router: built.router!, authenticate: () => ({ tenantId: 't-sre', userId, branchId: null }),
    access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
  };
}
const post = (k: ReturnType<typeof kernel>, body: unknown, key: string) =>
  handle(k, { method: 'POST', path: '/v1/migration/acceptances', body, headers: { authorization: 'Bearer good', 'idempotency-key': key } });

describe('OD-05 — only the signed-in owner accepts an exception, in his own name', () => {
  it('REFUSES somebody else who types the owner\'s sign-in into the body — nothing is recorded', async () => {
    const recorded: Acceptance[] = [];
    const res = await post(kernel('u-manager', recorded), { domain: 'batches', acceptedBy: 'u-owner', acceptedOn: NOW, reason: 'batch numbers were never kept in the old system for loose goods' }, 'k-1');
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('accepted_by_somebody_other_than_the_owner');
    expect(recorded).toEqual([]);
  });

  it('the owner signed in: recorded in his name and at head office\'s time, whatever the body says about either', async () => {
    const recorded: Acceptance[] = [];
    const res = await post(kernel('u-owner', recorded), { domain: 'batches', acceptedOn: '1999-01-01', reason: 'batch numbers were never kept in the old system for loose goods' }, 'k-2');
    expect(res.status).toBe(201);
    expect(recorded).toEqual([{ domain: 'batches', acceptedBy: 'u-owner', acceptedOn: NOW, reason: 'batch numbers were never kept in the old system for loose goods' }]);
    expect(res.body).toMatchObject({ acceptedBy: 'u-owner', domain: 'batches' });
  });

  it('refuses an acceptance that names no kind of record, or gives no reason — nothing is recorded', async () => {
    const recorded: Acceptance[] = [];
    const k = kernel('u-owner', recorded);
    for (const [i, body] of [{ domain: 'nonsense', reason: 'x y z' }, { domain: 'stock', reason: '   ' }, { domain: 'stock' }].entries()) {
      const res = await post(k, body, `k-bad-${i}`);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_readable_as_an_acceptance');
    }
    expect(recorded).toEqual([]);
  });

  it('still refuses when nobody is recorded as the owner', async () => {
    const res = await post(kernel('u-owner', [], { ownerId: () => undefined }), { domain: 'stock', reason: 'the cold room was never counted in the old system' }, 'k-3');
    expect(res.status).toBe(409);
  });
});
