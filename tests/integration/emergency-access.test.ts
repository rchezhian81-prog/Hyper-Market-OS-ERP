import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Emergency access, end to end (M02-FR-04 · SEC-11 · §28, API-01). Elevated access that is real and
// necessary, and the one that quietly becomes permanent. Every rule stops that: time-bound AT GRANT (the
// expiry is computed and stored, it ends on its own), a specific reason, a SEPARATE approver (the requester
// can never approve their own, §28), capped by policy ("no perpetual support access"), never extended in
// place (more time is a new grant), and every grant REVIEWABLE. The authenticated caller is the approver.
// Gated identity.role.grant to grant/revoke, identity.role.read to review — owner-held.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REASON = 'diagnose the till freeze on lane 3';

const grant = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/access/emergency/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `eg-${id}`, body });
const revoke = (h: ApiHarness, u: string, id: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/access/emergency/${id}/revoke`, userId: u, tenantId: A, idempotencyKey: key ?? `rv-${id}`, body: {} });
const review = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/access/emergency', userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Review = { review: { grantId: string; userId: string; approvedBy: string; active: boolean; endedEarly: boolean; reason: string }[]; count: number; active: number };
// A valid grant body — userId/requestedBy are the person needing access; the approver is the caller (§28).
const req = (over: Record<string, unknown> = {}) => ({ userId: 'u-support', roleId: 'store_manager', branchScope: 'all', reason: REASON, minutes: 60, requestedBy: 'u-support', ...over });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner'); // identity.role.grant + identity.role.read
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // neither
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('emergency access: time-bound, self-expiring, separate approver, reviewed (M02-FR-04 · SEC-11)', () => {
  it('grants a time-bound elevation, surfaces it in the review, and survives a restart', async () => {
    const h = await cast();
    const g = await grant(h, 'u-owner', 'e1', req());
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ grantId: 'e1', userId: 'u-support', approvedBy: 'u-owner' });
    // The expiry is a stored fact computed at grant time (60 minutes on), never open-ended.
    expect(typeof (g.body as { expiresAt: string }).expiresAt).toBe('string');

    const r = (await review(h, 'u-owner')).body as Review;
    expect(r.count).toBe(1);
    expect(r.active).toBe(1);
    expect(r.review[0]).toMatchObject({ grantId: 'e1', approvedBy: 'u-owner', active: true, endedEarly: false, reason: REASON });

    // Event-sourced — the review is identical after a cold restart.
    const restarted = apiHarness({ store: h.store });
    expect(((await review(restarted, 'u-owner')).body as Review).count).toBe(1);
  });

  it('ends a grant early — recorded, never erased, and shown inactive in the review', async () => {
    const h = await cast();
    await grant(h, 'u-owner', 'e2', req());
    const rv = await revoke(h, 'u-owner', 'e2');
    expect(rv.status).toBe(200);
    expect(typeof (rv.body as { revokedAt: string }).revokedAt).toBe('string');

    const row = ((await review(h, 'u-owner')).body as Review).review.find((x) => x.grantId === 'e2');
    expect(row).toMatchObject({ endedEarly: true, active: false });
    expect((await revoke(h, 'u-owner', 'ghost')).status).toBe(404); // nothing to revoke
  });

  it('refuses self-approval (§28), a vague reason, and anything over the policy cap (SEC-11)', async () => {
    const h = await cast();
    // The approver (caller) cannot be the requester.
    expect(codeOf(await grant(h, 'u-owner', 'e3', req({ requestedBy: 'u-owner' })))).toBe('emergency_access_refused');
    // A reason too short to review afterwards.
    expect(codeOf(await grant(h, 'u-owner', 'e4', req({ reason: 'fix it' })))).toBe('emergency_access_refused');
    // Over the cap — there is no perpetual support access.
    expect(codeOf(await grant(h, 'u-owner', 'e5', req({ minutes: 1000, maxMinutes: 240 })))).toBe('emergency_access_refused');
  });

  it('is owner-only, and refuses a malformed request', async () => {
    const h = await cast();
    expect((await grant(h, 'u-mgr', 'e6', req())).status).toBe(403);
    expect((await grant(h, 'u-cash', 'e6', req())).status).toBe(403);
    expect((await review(h, 'u-mgr')).status).toBe(403);
    expect(codeOf(await grant(h, 'u-owner', 'e7', { userId: 'u-support', minutes: 60 }))).toBe('not_readable_as_an_emergency_request');
  });
});
