import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';

// OB-330 (owner, 23 Oct 2026, in writing · roadmap §35.1): accepting a critical or high risk takes TWO signatures — the
// owner and a named security reviewer, each in their own session. Until the owner names a reviewer (on screen, never in
// code) a critical or high risk cannot be accepted at all: it must be fixed. The reviewer is a person head office knows
// who may read the risk register, never the owner naming them; the two signatures are two different people; a risk
// re-stated after a signature needs signing again; a medium risk is still one manager's. In memory and on real
// PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('a critical or high risk is accepted only by the owner and the named security reviewer (OB-330) — on $name', ({ harness }) => {
  it('must be fixed until a reviewer is named; then owner + reviewer, in either order, two people; a restart keeps it', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-owner2', 'owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-rev', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    let n = 0;
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n++}` }), ...(body === undefined ? {} : { body }) });
    const risk = (id: string, severity: string, title = `risk ${id}`) => req('POST', `/v1/compliance/risks/${id}`, 'u-mgr', { title, severity, ownerUserId: 'u-mgr', blocksGates: ['QG-06'] });
    const ownerSigns = (id: string, who = 'u-owner') => req('POST', `/v1/compliance/risks/${id}/acceptance`, who, { rationale: 'carried for the pilot with compensating controls' });
    const reviewerSigns = (id: string, who = 'u-rev') => req('POST', `/v1/compliance/risks/${id}/acceptance/review`, who, { rationale: 'controls checked by the reviewer' });
    const canPass = async (): Promise<boolean> => ((await req('GET', '/v1/compliance/gates/QG-06/can-pass', 'u-owner')).body as { canPass: boolean }).canPass;
    expect((await risk('R-C', 'critical')).status).toBe(201);
    expect((await risk('R-H', 'high')).status).toBe(201);
    expect((await risk('R-M', 'medium')).status).toBe(201);

    // No reviewer named: neither the critical nor the high can be accepted — they must be fixed.
    const state0 = (await req('GET', '/v1/compliance/risk-acceptances', 'u-mgr')).body as { reviewer: unknown; mustBeFixed: boolean; risks: { riskId: string; mustBeFixed: boolean }[] };
    expect(state0).toMatchObject({ reviewer: null, mustBeFixed: true });
    expect(state0.risks.map((r) => [r.riskId, r.mustBeFixed]).sort()).toEqual([['R-C', true], ['R-H', true]]);
    expect(codeOf(await ownerSigns('R-C'))).toBe('must_be_fixed_no_security_reviewer');
    expect(codeOf(await reviewerSigns('R-H'))).toBe('must_be_fixed_no_security_reviewer');
    // A medium risk is still one compliance manager's decision.
    expect((await req('POST', '/v1/compliance/risks/R-M/acceptance', 'u-mgr', { rationale: 'low exposure' })).body).toMatchObject({ status: 'accepted', acceptedBy: 'u-mgr' });

    // Naming the reviewer: the owner's alone; never himself; only a person who may read the risk register.
    const name = (body: Record<string, unknown>, who = 'u-owner') => req('PUT', '/v1/compliance/security-reviewer', who, body);
    expect((await name({ userId: 'u-rev', displayName: 'R. Reviewer', reason: 'pilot security reviewer' }, 'u-mgr')).status).toBe(403);
    expect(codeOf(await name({ userId: 'u-owner', displayName: 'Me', reason: 'x' }))).toBe('owner_cannot_be_their_own_reviewer');
    expect(codeOf(await name({ userId: 'u-cash', displayName: 'Cashier', reason: 'x' }))).toBe('reviewer_cannot_sign_here');
    expect(codeOf(await name({ userId: 'u-nobody', displayName: 'Nobody', reason: 'x' }))).toBe('reviewer_cannot_sign_here');
    expect(codeOf(await name({ userId: 'u-rev' }))).toBe('not_readable_as_a_reviewer');
    expect((await name({ userId: 'u-rev', displayName: 'R. Reviewer', reason: 'pilot security reviewer' })).body).toMatchObject({ reviewer: { userId: 'u-rev', displayName: 'R. Reviewer', namedBy: 'u-owner' } });

    // The critical: owner first, then the reviewer — accepted only with both.
    expect(codeOf(await ownerSigns('R-C', 'u-mgr'))).toBe('owner_signs_as_owner');
    expect((await ownerSigns('R-C')).body).toMatchObject({ status: 'awaiting_second_signature', waitingFor: 'security_reviewer' });
    expect(await canPass()).toBe(false);
    expect(codeOf(await reviewerSigns('R-C', 'u-mgr'))).toBe('not_the_named_security_reviewer');
    expect((await req('POST', '/v1/compliance/risks/R-C/acceptance/review', 'u-cash', { rationale: 'x' })).status).toBe(403);

    h = harness(h); // ── cold restart between the two signatures ──
    expect((await reviewerSigns('R-C')).body).toMatchObject({ status: 'accepted', acceptedBy: 'u-owner', securityReviewedBy: 'u-rev' });

    // The high: the reviewer first, then a re-statement of the risk (a different risk now) — the old signature no longer
    // counts; both sign again, the owner this time a second owner. One person can never give both.
    expect((await reviewerSigns('R-H')).body).toMatchObject({ status: 'awaiting_second_signature', waitingFor: 'owner' });
    expect((await risk('R-H', 'high', 'restated: wider exposure')).status).toBe(201);
    expect((await ownerSigns('R-H', 'u-owner2')).body).toMatchObject({ status: 'awaiting_second_signature', waitingFor: 'security_reviewer' });
    expect(codeOf(await name({ userId: 'u-owner2', displayName: 'Co-owner', reason: 'second reviewer' }, 'u-owner2'))).toBe('owner_cannot_be_their_own_reviewer');
    expect((await reviewerSigns('R-H')).body).toMatchObject({ status: 'accepted', acceptedBy: 'u-owner2', securityReviewedBy: 'u-rev' });
    expect(await canPass()).toBe(true);

    // After a restart: the register says who signed what; the reviewer is still named.
    h = harness(h);
    const risks = ((await req('GET', '/v1/compliance/risks', 'u-owner')).body as { risks: { riskId: string; status: string; acceptedBy?: string; securityReviewedBy?: string }[] }).risks;
    expect(risks.filter((r) => r.riskId !== 'R-M').map((r) => [r.riskId, r.status, r.acceptedBy, r.securityReviewedBy]).sort()).toEqual([['R-C', 'accepted', 'u-owner', 'u-rev'], ['R-H', 'accepted', 'u-owner2', 'u-rev']]);
    expect(((await req('GET', '/v1/compliance/security-reviewer', 'u-mgr')).body as { reviewer: { userId: string } }).reviewer.userId).toBe('u-rev');
    expect((await req('GET', '/v1/compliance/security-reviewer', 'u-cash')).status).toBe(403);
  }, 120_000);
});
