import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { caRoleGrantRefusal, CA_GRANT_PERMISSION } from '../../services/identity/src/ca-role-grant';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from '../../services/api/src/roles';
import { auditTrailAdapter } from '../../services/api/src/adapters';

/**
 * **OB-681 (owner, 3 Nov 2026, in writing) · OB-143: the chartered accountant's role is given through a NAMED path.**
 * The CA role holds finance.rcm.configure, finance.tds.configure and privacy.volume.threshold.set, which the owner lacks, so
 * the ordinary grant is refused `escalates_beyond_the_approver`. Now: the OWNER asks, the IT CUSTODIAN (the security reviewer
 * named under OB-330 / OB-405) approves as the second, different person, and it is on the audit trail; the owner still does
 * not gain those three permissions, and no other role may use the path. Synthetic data only.
 */
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const THREE = ['finance.rcm.configure', 'finance.tds.configure', 'privacy.volume.threshold.set'];

describe('OB-681: the rule — owner asks, the named IT custodian approves', () => {
  const base = { askerRoles: ['owner'], asker: 'u-owner', subject: 'u-ca', subjectRoles: [] as string[], approver: 'u-siva', approverRoles: ['security_reviewer'], namedCustodian: 'u-siva' };
  it('owner + custodian is accepted', () => { expect(caRoleGrantRefusal(base)).toBeUndefined(); });
  it('the owner alone, self-approval, the subject approving, or any other role is refused by name', () => {
    expect(caRoleGrantRefusal({ ...base, approver: 'u-owner', approverRoles: ['owner'] })?.code).toBe('approved_by_the_requester');
    expect(caRoleGrantRefusal({ ...base, subject: 'u-owner' })?.code).toBe('granting_to_yourself');
    expect(caRoleGrantRefusal({ ...base, subject: 'u-owner2', subjectRoles: ['owner'] })?.code).toBe('owner_never_holds_the_ca_role');
    expect(caRoleGrantRefusal({ ...base, approver: 'u-ca', approverRoles: ['security_reviewer'], namedCustodian: 'u-ca' })?.code).toBe('ca_grant_approved_by_its_subject');
    expect(caRoleGrantRefusal({ ...base, approver: 'u-mgr', approverRoles: ['store_manager'] })?.code).toBe('ca_grant_needs_the_it_custodian');
    expect(caRoleGrantRefusal({ ...base, approver: 'u-it', approverRoles: ['platform_admin'] })?.code).toBe('ca_grant_needs_the_it_custodian');
    expect(caRoleGrantRefusal({ ...base, namedCustodian: undefined })?.code).toBe('name_the_security_reviewer_first');
    expect(caRoleGrantRefusal({ ...base, askerRoles: ['store_manager'], asker: 'u-mgr' })?.code).toBe('only_the_owner_asks_for_the_ca_role');
  });
  it('only the owner role holds the asking permission, and the owner still holds none of the CA\'s three settings permissions', () => {
    expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes(CA_GRANT_PERMISSION)).map((r) => r.id)).toEqual([OWNER_ROLE_ID]);
    const owner = ROLE_CATALOGUE.find((r) => r.id === OWNER_ROLE_ID)!;
    expect(owner.permissions.filter((p) => THREE.includes(p))).toEqual([]);
    expect(ROLE_CATALOGUE.find((r) => r.id === 'chartered_accountant')!.permissions).toEqual(expect.arrayContaining(THREE));
  });
});

async function cast(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await h.provisionRole(t, 'u-it', 'platform_admin');
  await h.provisionRole(t, 'u-siva', 'security_reviewer');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n++}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const grant = (changeId: string, body: Record<string, unknown>, who = 'u-owner') => call('POST', `/v1/identity/chartered-accountant/grants/${changeId}`, who, body);
  const ask = async (changeId: string, body: Record<string, unknown>, maker = 'u-owner') => {
    const r = await askForApproval(h, t, maker, { kind: 'ca_role_grant', subjectRef: changeId, details: actionDetails(body, { changeId }) });
    return r.status === 201 ? (r.body as { requestId: string }).requestId : r;
  };
  return { call, grant, ask };
}

describe('OB-681 on the production API surface', () => {
  it('the ordinary grant is still refused; the named path gives the role once the custodian approves, audited; the owner gains nothing', async () => {
    const h = apiHarness();
    const t = randomUUID();
    const s = await cast(h, t);
    const body = { userId: 'u-ca', reason: 'the CA fills the reverse-charge and TDS lists (OB-143)' };

    // The ordinary route stays as it was: the owner cannot approve a role carrying what he does not hold.
    expect((await s.call('POST', '/v1/identity/grants', 'u-mgr', { grantId: 'g-ca', userId: 'u-ca', roleId: 'chartered_accountant', branchScope: 'all', reason: 'x' })).status).toBe(202);
    expect(codeOf(await s.call('POST', '/v1/identity/grants/g-ca/approve', 'u-owner', {}))).toBe('escalates_beyond_the_approver');

    // No custodian named yet: refused by name.
    expect(codeOf(await s.grant('CA1', body))).toBe('name_the_security_reviewer_first');
    expect((await s.call('PUT', '/v1/compliance/security-reviewer', 'u-owner', { userId: 'u-siva', displayName: 'Mr Sivakumar', reason: 'OB-405' })).status).toBe(200);
    // Without the custodian's approval, nothing changes.
    expect(codeOf(await s.grant('CA1', body))).toBe('ca_grant_needs_the_it_custodian');
    // Nobody but the owner asks or uses the path.
    expect((await s.grant('CA1', body, 'u-mgr')).status).toBe(403);
    expect((await s.grant('CA1', body, 'u-it')).status).toBe(403);
    expect(typeof (await s.ask('CA9', body, 'u-mgr'))).not.toBe('string');

    const requestId = await s.ask('CA1', body);
    expect(typeof requestId).toBe('string');
    // The owner cannot approve his own; a store manager or the IT administrator cannot decide it either.
    for (const who of ['u-owner', 'u-mgr', 'u-it']) expect((await decide(h, t, who, requestId as string)).status, who).not.toBe(201);
    expect((await decide(h, t, 'u-siva', requestId as string)).status).toBe(201);

    const done = await s.grant('CA1', { ...body, approvalId: requestId });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ userId: 'u-ca', roleId: 'chartered_accountant', requestedBy: 'u-owner', approvedBy: 'u-siva' });
    const ca = (await s.call('GET', '/v1/identity/me', 'u-ca')).body as { permissions: string[] };
    expect(ca.permissions).toEqual(expect.arrayContaining(THREE));
    const owner = (await s.call('GET', '/v1/identity/me', 'u-owner')).body as { permissions: string[] };
    expect(owner.permissions.filter((p) => THREE.includes(p)), 'the owner gains none of the three').toEqual([]);
    // Sent again: already held, nothing given twice; the approval cannot be used for a different person.
    expect((await s.grant('CA1', { ...body, approvalId: requestId })).body).toMatchObject({ alreadyHeld: true });
    expect((await s.grant('CA2', { userId: 'u-other', reason: body.reason, approvalId: requestId })).status).toBeGreaterThanOrEqual(400);

    const trail = await auditTrailAdapter({ store: h.store }).records(t);
    expect(trail.find((r) => r.action === 'role.grant' && r.objectId === 'u-ca' && r.correlationId === 'CA1'))
      .toMatchObject({ actorId: 'u-owner', after: expect.objectContaining({ roleId: 'chartered_accountant', approvedBy: 'u-siva', requestedBy: 'u-owner' }) });
  });

  it('the owner is never given the role, and the subject never approves their own', async () => {
    const h = apiHarness();
    const t = randomUUID();
    const s = await cast(h, t);
    await h.provisionRole(t, 'u-owner2', 'owner');
    expect((await s.call('PUT', '/v1/compliance/security-reviewer', 'u-owner', { userId: 'u-siva', displayName: 'Mr Sivakumar', reason: 'OB-405' })).status).toBe(200);
    expect(codeOf(await s.grant('X1', { userId: 'u-owner', reason: 'x' }))).toBe('granting_to_yourself');
    expect(codeOf(await s.grant('X2', { userId: 'u-owner2', reason: 'x' }))).toBe('owner_never_holds_the_ca_role');
    // The custodian himself as the CA: he cannot approve his own grant.
    const body = { userId: 'u-siva', reason: 'x' };
    const id = await s.ask('X3', body);
    expect((await decide(h, t, 'u-siva', id as string)).status).toBe(201);
    expect(codeOf(await s.grant('X3', { ...body, approvalId: id }))).toBe('ca_grant_approved_by_its_subject');
  });
});
