import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M01-FR-04: the governed branch open/close lifecycle on the live API. The decision is measured, returns
// every blocker at once, needs the owner's approval (and the approver is never the requester, §28), and
// refuses a permanent close over unsent sync items — that would destroy sales that were legitimately made.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const zero = { minor: 0, currency: 'INR' };
const CLEAN = { branchId: 'br-1', stockValue: zero, stockUnits: 0, cashBalance: zero, openDocuments: 0, unsentSyncItems: 0, unresolvedExceptions: 0, activeUserCount: 0 };

const evalT = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/platform/branches/transition/evaluate', userId, tenantId: A, idempotencyKey: key, body });

describe('branch open/close lifecycle (M01-FR-04)', () => {
  it('allows opening a configured, staffed, owner-approved branch from draft', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await evalT(h, 'u-owner', {
      request: { branchId: 'br-1', transition: 'open', requestedBy: 'u-mgr', reason: 'launch', at: '2026-08-11T09:00:00Z' },
      currentState: 'draft',
      readiness: { ...CLEAN, configured: true, devicesAssigned: 2 },
      approval: { subjectRef: 'br-1', status: 'approved', decidedBy: 'u-owner' }, // ≠ requestedBy
    }, 'bl-open')).body as { allowed: boolean; toState: string; blockers: unknown[] };
    expect(body.allowed).toBe(true);
    expect(body.toState).toBe('open');
    expect(body.blockers).toHaveLength(0);
  });

  it('refuses a permanent close over stock, unsent sync and missing approval — all blockers at once', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await evalT(h, 'u-owner', {
      request: { branchId: 'br-1', transition: 'permanently_close', requestedBy: 'u-mgr', reason: 'lease ended', at: '2026-08-11T09:00:00Z' },
      currentState: 'open',
      readiness: { ...CLEAN, stockValue: { minor: 50000, currency: 'INR' }, stockUnits: 5, unsentSyncItems: 3 },
      // no approval supplied
    }, 'bl-close')).body as { allowed: boolean; toState: string; blockers: { code: string }[] };
    expect(body.allowed).toBe(false);
    expect(body.toState).toBe('open'); // unchanged when blocked
    const codes = body.blockers.map((x) => x.code);
    expect(codes).toContain('stock_remains');
    expect(codes).toContain('unsent_sync');   // closing would lose legitimately-made sales (§31)
    expect(codes).toContain('approval_required');
  });

  it('blocks a self-approved closure (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const body = (await evalT(h, 'u-owner', {
      request: { branchId: 'br-1', transition: 'temporarily_close', requestedBy: 'u-mgr', reason: 'renovation', at: '2026-08-11T09:00:00Z' },
      currentState: 'open',
      readiness: CLEAN,
      approval: { subjectRef: 'br-1', status: 'approved', decidedBy: 'u-mgr' }, // same person who requested
    }, 'bl-self')).body as { blockers: { code: string }[] };
    expect(body.blockers.map((x) => x.code)).toContain('self_approved');
  });

  it('refuses a malformed request and gates on the permission', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await evalT(h, 'u-owner', { currentState: 'draft', readiness: CLEAN }, 'bl-noreq')).status).toBe(400);
    expect((await evalT(h, 'u-cash', { request: { branchId: 'br-1', transition: 'open', requestedBy: 'x', reason: 'y', at: 'z' }, currentState: 'draft', readiness: CLEAN }, 'bl-rbac')).status).toBe(403);
  });
});
