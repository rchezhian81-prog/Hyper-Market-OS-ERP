import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { ROLE_CATALOGUE, SECURITY_REVIEWER_ROLE_ID } from '../../services/api/src/roles';

/**
 * OB-406 and OB-407 (owner, 27 Oct 2026, in writing — option B each), through the real API on the in-memory store AND (with
 * DATABASE_URL) real PostgreSQL, head office restarted cold.
 *
 * OB-406: a least-privilege "Security reviewer" role. A person given it through the normal maker-checker role grant (a
 * manager asks, the owner approves) can be named the security reviewer (OB-330 / OB-405) and sign a critical risk's
 * acceptance with the owner — and can do no business action: no price, refund, purchase order, write-off, risk register
 * or switch. Never by default; never with the IT role (OB-95); never to a machine identity.
 *
 * OB-407: switching a floor device (shelf labels, RFID, sensors, cameras) ON for a branch needs the owner's approval and
 * the named security reviewer's signature, each in their own session, never the person switching; with no reviewer named
 * it is refused by name; switching it OFF is one person with a reason. Synthetic data only.
 */

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('the security reviewer signs, and a floor device is switched on only by the owner and the reviewer (OB-406, OB-407) — on $name', ({ harness }) => {
  it('grant → named → signs a critical risk with the owner; no business action; cameras on only with both; off by one; restart-safe', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-scan', 'findings_push'); // the CI scanner's machine identity
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n++}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };
    await ok(call('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');

    // ── OB-406: nobody holds the role by default; it is given by the normal maker-checker grant ──
    expect(ROLE_CATALOGUE.find((r) => r.id === SECURITY_REVIEWER_ROLE_ID)?.permissions).toEqual(['identity.self.read', 'compliance.risk.read']);
    const grant = (grantId: string, userId: string) => call('POST', '/v1/identity/grants', 'u-mgr', { grantId, userId, roleId: SECURITY_REVIEWER_ROLE_ID, branchScope: 'all', reason: 'OB-405: the interim named security reviewer' });
    expect((await grant('g-siva', 'u-siva')).status).toBe(202);
    expect((await call('POST', '/v1/identity/grants/g-siva/approve', 'u-mgr', {})).status).toBeGreaterThanOrEqual(400); // never the asker's own
    expect((await call('POST', '/v1/identity/grants/g-siva/approve', 'u-owner', {})).status).toBe(201);
    // Never with the IT role (OB-95: it is not platform administration, so it counts as a business role) …
    expect(codeOf(await grant('g-it', 'u-it'))).toBe('it_role_and_business_role_on_one_person');
    // … and never to a machine identity.
    expect(codeOf(await grant('g-scan', 'u-scan'))).toBe('machine_identity_holds_only_its_role');

    // Before the owner names anyone, the reviewer may read the risk register but cannot sign; and no floor device goes on.
    expect((await call('GET', '/v1/compliance/risk-acceptances', 'u-siva')).status).toBe(200);
    expect((await call('GET', '/v1/compliance/gates/blocked', 'u-siva')).status).toBe(200);
    const on = { branchId: 'B1', enabled: true, reason: 'camera events trial in B1' };
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', on))).toBe('name_the_security_reviewer_first');
    expect(await ok(call('POST', '/v1/platform/rollout/cctv/preview', 'u-it', { branchId: 'B1', enabled: true }), 'preview')).toMatchObject({ needsSecurityReviewer: true, securityReviewer: null, refusedBecause: 'name_the_security_reviewer_first' });

    // The owner names u-siva — accepted because the role lets them read the risk register (OB-406's whole point).
    expect((await call('PUT', '/v1/compliance/security-reviewer', 'u-siva', { userId: 'u-siva', displayName: 'Mr Sivakumar', reason: 'x' })).status).toBe(403);
    expect(await ok(call('PUT', '/v1/compliance/security-reviewer', 'u-owner', { userId: 'u-siva', displayName: 'Mr Sivakumar', reason: 'OB-405: the IT custodian as interim reviewer' }), 'name')).toMatchObject({ reviewer: { userId: 'u-siva', displayName: 'Mr Sivakumar', namedBy: 'u-owner' } });

    // A critical risk: the owner signs, the reviewer signs in their own session — accepted with both.
    expect((await call('POST', '/v1/compliance/risks/R-C', 'u-mgr', { title: 'camera footage retention', severity: 'critical', ownerUserId: 'u-mgr', blocksGates: ['QG-06'] })).status).toBe(201);
    expect((await call('POST', '/v1/compliance/risks/R-C2', 'u-siva', { title: 'x', severity: 'critical', ownerUserId: 'u-siva' })).status).toBe(403); // cannot register
    expect((await call('POST', '/v1/compliance/risks/R-C/acceptance', 'u-siva', { rationale: 'alone' })).status).toBe(403); // cannot accept alone
    expect(await ok(call('POST', '/v1/compliance/risks/R-C/acceptance', 'u-owner', { rationale: 'carried for the pilot with compensating controls' }), 'owner signs')).toMatchObject({ status: 'awaiting_second_signature', waitingFor: 'security_reviewer' });
    h = harness(h); // ── cold restart between the two signatures ──
    expect(await ok(call('POST', '/v1/compliance/risks/R-C/acceptance/review', 'u-siva', { rationale: 'controls checked by the reviewer' }), 'reviewer signs')).toMatchObject({ status: 'accepted', acceptedBy: 'u-owner', securityReviewedBy: 'u-siva' });

    // No business action: price, refund, purchase order, write-off, a switch, a grant — each refused at the door.
    const forbidden: [string, string, unknown][] = [
      ['POST', '/v1/prices/changes', { productId: 'p-1', priceMinor: 100 }],
      ['POST', '/v1/prices/list/p-1/entries/e-1', { priceMinor: 100 }],
      ['POST', '/v1/pos/refund-approvals', { saleId: 's-1' }],
      ['POST', '/v1/purchase/orders/po-1/approval', {}],
      ['POST', '/v1/inventory/write-off/wo-1', { productId: 'p-1', quantityMinor: 1 }],
      ['POST', '/v1/inventory/write-off-captures/wo-1/decide', { decision: 'approved' }],
      ['PUT', '/v1/platform/rollout/cctv', on],
      ['POST', '/v1/identity/grants', { grantId: 'g-x', userId: 'u-x', roleId: 'cashier', branchScope: 'all', reason: 'x' }],
    ];
    for (const [method, path, body] of forbidden) expect((await call(method as 'POST' | 'PUT', path, 'u-siva', body)).status, `${method} ${path}`).toBe(403);

    // ── OB-407: switching a camera ON for B1 ──
    const subjectRef = 'rollout:cctv:B1';
    const details = actionDetails(on, { key: 'cctv' });
    const ask = async (who: string, kind: string): Promise<string> => {
      const r = await askForApproval(h, T, who, { kind, subjectRef, details });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body as { requestId: string }).requestId;
    };
    // Without the owner's approval.
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', on))).toBe('high_impact_change_needs_owner_approval');
    const ownerAsk = await ask('u-it', 'flag_change');
    expect((await decide(h, T, 'u-owner', ownerAsk)).status).toBe(201);
    // Without the reviewer's signature.
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerAsk }))).toBe('floor_device_switch_needs_security_reviewer');
    // A manager who may read the risk register cannot sign: since OB-420 only the named reviewer decides it — refused by
    // name, nothing recorded, so the signature is still missing at switch-on.
    const mgrSigns = await ask('u-it', 'floor_device_review');
    expect(codeOf(await decide(h, T, 'u-mgr', mgrSigns))).toBe('only_the_named_security_reviewer_decides');
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerAsk, reviewApprovalId: mgrSigns }))).toBe('approval_still_waiting');
    // The person switching can never be the approver: the owner switching asks, and cannot decide his own request.
    const selfAsk = await ask('u-owner', 'flag_change');
    expect(codeOf(await decide(h, T, 'u-owner', selfAsk))).toBe('self_approval');
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-owner', { ...on, approvalId: selfAsk, reviewApprovalId: mgrSigns }))).toBe('approval_still_waiting');
    // Nor use an approval someone else asked for.
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-owner', { ...on, approvalId: ownerAsk, reviewApprovalId: mgrSigns }))).toBe('approval_does_not_match');
    // A cashier, and the reviewer, cannot switch at all.
    expect((await call('PUT', '/v1/platform/rollout/cctv', 'u-cash', on)).status).toBe(403);
    // Nothing above changed the switch.
    expect(await ok(call('GET', '/v1/platform/rollout/cctv/decision', 'u-it', undefined, { branchId: 'B1' }), 'still off')).toMatchObject({ on: false, source: 'never_set' });

    // The named reviewer signs in their own session (from the approvals inbox, which their role opens).
    const revSigns = await ask('u-it', 'floor_device_review');
    const inbox = await ok(call('GET', '/v1/approvals/requests', 'u-siva'), 'inbox') as { waitingForMe: { requestId: string; kind: string }[] };
    expect(inbox.waitingForMe.map((r) => r.requestId)).toContain(revSigns);
    expect(inbox.waitingForMe.every((r) => r.kind === 'floor_device_review')).toBe(true); // nothing else is theirs to decide
    expect((await decide(h, T, 'u-siva', revSigns)).status).toBe(201);
    h = harness(h); // ── cold restart: both approvals survive ──
    const switched = await ok(call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerAsk, reviewApprovalId: revSigns }), 'switched on');
    expect(switched).toMatchObject({ highImpact: true, change: { enabled: true, version: 1, changedBy: 'u-it', approvedBy: 'u-owner', approvalId: ownerAsk, reviewedBy: 'u-siva', reviewApprovalId: revSigns }, now: { on: true, source: 'branch' } });
    // One approval allows one action.
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { ...on, approvalId: ownerAsk, reviewApprovalId: revSigns }))).toBe('approval_already_used');

    // OFF: one person, a reason, no approval.
    expect(codeOf(await call('PUT', '/v1/platform/rollout/cctv', 'u-it', { branchId: 'B1', enabled: false }))).toBe('reason_required');
    const off = await ok(call('PUT', '/v1/platform/rollout/cctv', 'u-it', { branchId: 'B1', enabled: false, reason: 'privacy notice not up yet' }), 'off');
    expect(off).toMatchObject({ change: { enabled: false, version: 2, changedBy: 'u-it' } });
    expect((off['change'] as Record<string, unknown>)['approvedBy']).toBeUndefined();

    // ── After a cold restart: the history, the board and the audit say who switched, who approved and who signed ──
    h = harness(h);
    const hist = await ok(call('GET', '/v1/platform/rollout/cctv/history', 'u-it', undefined, { branchId: 'B1' }), 'history') as { versions: Record<string, unknown>[]; highImpact: boolean };
    expect(hist.highImpact).toBe(true);
    expect(hist.versions.map((v) => [v['version'], v['enabled'], v['approvedBy'] ?? null, v['reviewedBy'] ?? null])).toEqual([[1, true, 'u-owner', 'u-siva'], [2, false, null, null]]);
    const board = await ok(call('GET', '/v1/platform/rollout', 'u-owner'), 'board') as { switches: Record<string, unknown>[] };
    expect(board.switches).toEqual([expect.objectContaining({ key: 'cctv', branchId: 'B1', enabled: false, version: 2, reviewedBy: null })]);
    expect(await ok(call('GET', '/v1/platform/rollout/cctv/decision', 'u-it', undefined, { branchId: 'B1' }), 'off now')).toMatchObject({ on: false, version: 2 });
    // The reviewer is still named after the restart.
    expect(((await ok(call('GET', '/v1/compliance/security-reviewer', 'u-siva'), 'reviewer')) as { reviewer: { userId: string } }).reviewer.userId).toBe('u-siva');
  }, 120_000);
});
