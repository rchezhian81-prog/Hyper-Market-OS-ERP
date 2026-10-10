import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedDecision } from '../support/store-seal';

/**
 * **Every "second person" is a separate authenticated act (Wave 2b-iii · audit PA-03 · M02-FR-02 · M02-FR-03 · M26-FR-03
 * · M31-FR-01 · §28 · hard rule #4).** The audit executed routes that took two typed names as two people: a role granted
 * with a nonexistent requester and "approvedBy" whoever the body said (201); a template version published with an
 * unprovisioned author and reviewer (201); a store decision by a manager outside the request's branch recorded clean.
 * Now who acts is the sign-in: a body that names a different actor is refused by name, a body that names the second
 * person at all is refused by name, and the second person's part is their own call under their own sign-in. These are
 * the audit's reproductions inverted, on the real API surface.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const askGrant = (h: ApiHarness, u: string, grantId: string, body: Record<string, unknown>, key = `ask-${grantId}`) =>
  h.request({ method: 'POST', path: '/v1/identity/grants', userId: u, tenantId: A, idempotencyKey: key, body: { grantId, userId: 'u-new', roleId: 'cashier', branchScope: 'all', ...body } });
const approveGrant = (h: ApiHarness, u: string, grantId: string, key = `approve-${grantId}-${u}`) =>
  h.request({ method: 'POST', path: `/v1/identity/grants/${grantId}/approve`, userId: u, tenantId: A, idempotencyKey: key, body: {} });
const rejectGrant = (h: ApiHarness, u: string, grantId: string, reason: string) =>
  h.request({ method: 'POST', path: `/v1/identity/grants/${grantId}/reject`, userId: u, tenantId: A, idempotencyKey: `reject-${grantId}`, body: { reason } });
const pending = (h: ApiHarness, u: string) => h.request({ method: 'GET', path: '/v1/identity/grants/pending', userId: u, tenantId: A });
const me = (h: ApiHarness, u: string, branchId?: string) => h.request({ method: 'GET', path: '/v1/identity/me', userId: u, tenantId: A, ...(branchId === undefined ? {} : { branchId }) });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                            // approves (identity.role.grant)
  await h.provisionRole(A, 'u-hr', 'store_manager');          // asks (identity.role.request), cannot approve
  await h.provisionRole(A, 'u-cash', 'cashier');              // neither
  return h;
}

describe('a role grant is two acts — asked by one signed-in person, approved by another', () => {
  it('the audit\'s fabricated grant: a body naming requester and approver is refused by name, and nobody\'s access changed', async () => {
    const h = await cast();
    const fabricated = await askGrant(h, 'u-owner', 'g-fab', { requestedBy: 'u-nobody', approvedBy: 'u-owner' });
    expect(fabricated.status).toBe(400);
    expect(codeOf(fabricated)).toBe('second_person_is_a_separate_act');
    const wrongRequester = await askGrant(h, 'u-owner', 'g-fab2', { requestedBy: 'u-nobody' });
    expect(wrongRequester.status).toBe(400);
    expect(codeOf(wrongRequester)).toBe('actor_is_the_caller');
    expect((await me(h, 'u-new')).status).toBe(403);
  });

  it('HR asks, the owner approves: the person holds the role; HR alone cannot approve; the same person asking and approving is refused (§28)', async () => {
    const h = await cast();
    const asked = await askGrant(h, 'u-hr', 'g1', { reason: 'new cashier' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ grantId: 'g1', state: 'pending', requestedBy: 'u-hr' });
    expect(((await pending(h, 'u-owner')).body as { requests: { grantId: string }[] }).requests.map((r) => r.grantId)).toEqual(['g1']);
    expect((await me(h, 'u-new')).status).toBe(403);                // asked is not granted
    expect((await approveGrant(h, 'u-hr', 'g1')).status).toBe(403); // HR holds no identity.role.grant
    const approved = await approveGrant(h, 'u-owner', 'g1');
    expect(approved.status).toBe(201);
    expect((await me(h, 'u-new')).status).toBe(200);                 // now they hold it
    expect(((await pending(h, 'u-owner')).body as { requests: unknown[] }).requests).toEqual([]);
    // idempotent: approving again is the same answer, not a second grant
    expect((await approveGrant(h, 'u-owner', 'g1', 'approve-again')).body).toMatchObject({ alreadyGranted: true });
    // the owner asking for u-other and approving themselves is refused at the approval
    expect((await askGrant(h, 'u-owner', 'g-self', { userId: 'u-other' })).status).toBe(202);
    const self = await approveGrant(h, 'u-owner', 'g-self');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('approved_by_the_requester');
    expect((await me(h, 'u-other')).status).toBe(403);
  });

  it('a rejected request is a fact: it cannot be approved afterwards; a cashier may neither ask nor approve; asking for yourself is refused', async () => {
    const h = await cast();
    expect((await askGrant(h, 'u-hr', 'g2', {})).status).toBe(202);
    expect((await rejectGrant(h, 'u-owner', 'g2', 'not needed')).body).toMatchObject({ state: 'rejected', rejectedBy: 'u-owner' });
    expect(codeOf(await approveGrant(h, 'u-owner', 'g2'))).toBe('grant_request_rejected');
    expect((await askGrant(h, 'u-cash', 'g3', {})).status).toBe(403);
    expect((await approveGrant(h, 'u-cash', 'g2')).status).toBe(403);
    expect(codeOf(await askGrant(h, 'u-hr', 'g4', { userId: 'u-hr' }))).toBe('granting_to_yourself');
    expect(codeOf(await askGrant(h, 'u-hr', 'g5', { roleId: 'fresh_counter' }))).toBe('unknown_role');
    expect((await approveGrant(h, 'u-owner', 'g-unknown')).status).toBe(404);
  });
});

// ── a template change: drafted by one, approved by another ─────────────────────────────────────────────────────
const draft = (h: ApiHarness, u: string, templateId: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions`, userId: u, tenantId: A, idempotencyKey: key, body: { kind: 'tax_invoice', body: 'INVOICE {{total}}', changeNote: 'first layout', ...body } });
const approveDraft = (h: ApiHarness, u: string, templateId: string, version: number, key: string) =>
  h.request({ method: 'POST', path: `/v1/documents/templates/${templateId}/versions/${version}/approve`, userId: u, tenantId: A, idempotencyKey: key, body: {} });
const current = (h: ApiHarness, u: string, templateId: string) =>
  h.request({ method: 'GET', path: `/v1/documents/templates/${templateId}/current`, userId: u, tenantId: A });

describe('a template version is drafted by one signed-in person and approved by another', () => {
  it('the audit\'s fabricated template approval: author and approver in the body are refused by name; a draft is not in force until a different person approves it', async () => {
    const h = await cast();
    await h.provisionRole(A, 'u-designer', 'store_manager'); // document.template.manage
    const fab = await draft(h, 'u-designer', 'inv', { createdBy: 'u-ghost', approvedBy: 'u-ghost2' }, 'd-fab');
    expect(fab.status).toBe(400);
    expect(codeOf(fab)).toBe('second_person_is_a_separate_act');
    const wrongAuthor = await draft(h, 'u-designer', 'inv', { createdBy: 'u-ghost' }, 'd-fab2');
    expect(codeOf(wrongAuthor)).toBe('actor_is_the_caller');
    expect((await current(h, 'u-owner', 'inv')).status).toBe(404);
    const d1 = await draft(h, 'u-designer', 'inv', {}, 'd1');
    expect(d1.status).toBe(201);
    expect(d1.body).toMatchObject({ version: 1, state: 'draft', createdBy: 'u-designer' });
    expect((await current(h, 'u-owner', 'inv')).status).toBe(404);           // a draft is not in force
    const selfApproved = await approveDraft(h, 'u-designer', 'inv', 1, 'a-self');
    expect(selfApproved.status).toBe(422);
    expect(codeOf(selfApproved)).toBe('self_approved');
    const approved = await approveDraft(h, 'u-owner', 'inv', 1, 'a1');
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ version: 1, outcome: 'published', approvedBy: 'u-owner' });
    expect((await current(h, 'u-owner', 'inv')).body).toMatchObject({ version: 1, createdBy: 'u-designer', approvedBy: 'u-owner' });
    expect((await approveDraft(h, 'u-owner', 'inv', 1, 'a1-again')).body).toMatchObject({ alreadyApproved: true });
    expect((await approveDraft(h, 'u-owner', 'inv', 7, 'a-none')).status).toBe(404);
    // the next change is version 2, drafted and approved the same way
    expect((await draft(h, 'u-designer', 'inv', { body: 'INVOICE v2 {{total}}', changeNote: 'new address' }, 'd2')).body).toMatchObject({ version: 2, state: 'draft' });
    expect((await current(h, 'u-owner', 'inv')).body).toMatchObject({ version: 1 });
    await approveDraft(h, 'u-owner', 'inv', 2, 'a2');
    expect((await current(h, 'u-owner', 'inv')).body).toMatchObject({ version: 2 });
  });
});

// ── a store decision relayed by the box: the decider's BRANCH is checked, not only their role ──────────────────
describe('a relayed decision by a manager outside the request\'s branch is recorded and flagged, not applied', () => {
  const relay = (h: ApiHarness, requestId: string, decidedBy: string, branchId: string | null) =>
    h.request({ method: 'POST', path: `/v1/approvals/decisions/${requestId}/synced`, userId: 'u-box', tenantId: A, idempotencyKey: `dec-${requestId}`, body: sealedDecision(A, 'ApprovalDecided', {
      id: requestId, subjectType: 'refund', subjectRef: 'S-1', requestedBy: 'u-cash', branchId, value: { minor: 50_000, currency: 'INR' },
      status: 'approved', decidedBy, reason: 'customer unhappy', decidedAt: '2026-10-05T10:00:00.000Z', source: 'manager-screen', storeId: 'store-1',
    }) });
  type Relayed = { flags: string[]; applied: boolean };

  it('a br-1 manager deciding a br-2 refund is flagged decider_outside_branch; the same manager on br-1, or a company-wide owner anywhere, is clean', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr1', 'store_manager', ['br-1']);
    await h.provisionRole(A, 'u-box', 'store_computer'); // the box's sync credential relays; it decides nothing
    const away = (await relay(h, 'r-away', 'u-mgr1', 'br-2')).body as Relayed;
    expect(away.flags).toContain('decider_outside_branch');
    expect(away.applied).toBe(false);
    const home = (await relay(h, 'r-home', 'u-mgr1', 'br-1')).body as Relayed;
    expect(home.flags).toEqual([]);
    const owner = (await relay(h, 'r-owner', 'u-owner', 'br-2')).body as Relayed;
    expect(owner.flags).toEqual([]);
  });
});

// ── a delegation's approver records are the callers', their scope the server's ────────────────────────────────
describe('a delegation names the lender as the lender, and a decider\'s own record is their own', () => {
  const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  it('a granter record that names somebody other than the lender is refused by name; a decider cannot borrow another person\'s record', async () => {
    const h = await cast();
    const wrong = await h.request({ method: 'POST', path: '/v1/access/delegations/d-wrong', userId: 'u-owner', tenantId: A, idempotencyKey: 'd-wrong', body: {
      fromUserId: 'u-hr', toUserId: 'u-cash', fromDate: day(0), untilDate: day(5), subjectTypes: ['refund'], reason: 'leave',
      granter: { userId: 'u-owner', branchScope: 'all', authorityLimit: null },
    } });
    expect(wrong.status).toBe(400);
    expect(codeOf(wrong)).toBe('actor_is_the_caller');
    const borrowed = await h.request({ method: 'POST', path: '/v1/access/approvals/decide', userId: 'u-owner', tenantId: A, idempotencyKey: 'dec-borrow', body: {
      request: { id: 'r1', subjectType: 'refund', subjectRef: 'S-9', requestedBy: 'u-cash', branchId: 'br-1', value: { minor: 1_000, currency: 'INR' } },
      decision: 'approved', reason: 'ok', own: { userId: 'u-hr', branchScope: 'all', authorityLimit: null },
    } });
    expect(borrowed.status).toBe(400);
    expect(codeOf(borrowed)).toBe('actor_is_the_caller');
  });
});
