import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails, APPROVAL_KINDS, checkersOf } from '../../services/identity/src/approval-requests';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-613 (owner, 31 Oct 2026, in writing): when the OWNER himself asks to change the business structure, move a till's
 * bill numbers to a replacement store computer, or change an approval rule, the store's ACCOUNTANT is the second approver;
 * the owner never approves his own request — on the real API (services/identity/src/approval-requests.ts).**
 *
 *   • the owner's branch activation request is marked as his, goes to the accountant's inbox (not the owner's, not the
 *     manager's), is refused to the owner and the manager, is approved by the accountant, and then activates the branch;
 *   • somebody else's request of the same kind still needs the owner — the accountant may not approve it;
 *   • a money-limit change the owner asks for, approved by the accountant, applies — unless it touches the accountant's
 *     own limits (§28), which is refused by name and the approval is not used.
 */

const G1 = '33AABCS1429B1Z1';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const idOf = (r: Res): string => (r.body as { requestId: string }).requestId;

async function shop() {
  const h = apiHarness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
  await h.provisionRole(T, 'u-acc', 'accountant');
  await h.provisionRole(T, 'u-it', 'platform_admin');
  const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (r: Promise<Res>, what: string): Promise<Res> => { const x = await r; expect(x.status, `${what}: ${JSON.stringify(x.body)}`).toBeLessThan(300); return x; };
  return { h, T, req, ok };
}
const inbox = async (req: (m: 'GET', p: string, u: string) => Promise<Res>, who: string): Promise<{ requestId: string; decidedByTheAccountant?: string }[]> =>
  ((await req('GET', '/v1/approvals/requests', who)).body as { waitingForMe: { requestId: string; decidedByTheAccountant?: string }[] }).waitingForMe;

describe('OB-613: the store\'s accountant approves what the owner asks for himself', () => {
  it('the three kinds name the accountant as the second approver; the accountant holds those words, and the owner only so he may grant them', () => {
    for (const kind of ['org_structure_change', 'store_computer_replaced', 'approval_rule_change']) {
      expect(APPROVAL_KINDS[kind]?.whenTheOwnerAsks?.checkerRole, kind).toBe('accountant');
      const word = APPROVAL_KINDS[kind]!.whenTheOwnerAsks!.checkerPermission;
      expect(ROLE_CATALOGUE.filter((r) => r.permissions.includes(word)).map((r) => r.id).sort(), word).toEqual(['accountant', 'owner']);
      // The owner's ordinary authority stays (a co-owner may still decide); the accountant is added — word and role.
      expect(checkersOf({ kind, raisedByTheOwner: true })).toEqual([{ permission: APPROVAL_KINDS[kind]!.checkerPermission }, { permission: word, role: 'accountant' }]);
      expect(checkersOf({ kind })).toEqual([{ permission: APPROVAL_KINDS[kind]!.checkerPermission }]);
    }
    // Every other kind is unchanged.
    expect(Object.values(APPROVAL_KINDS).filter((k) => k.whenTheOwnerAsks !== undefined).map((k) => k.kind).sort()).toEqual(['approval_rule_change', 'customer_credit_note', 'org_structure_change', 'store_computer_replaced']); // W3 · OB-679: the owner's own credit note
  });

  it('the owner\'s branch activation goes to the accountant, who alone approves it; then the branch opens', async () => {
    const { h, T, req, ok } = await shop();
    await ok(req('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', `/v1/org/gst-registrations/${G1}`, 'u-owner', { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }), 'gst');
    await ok(req('POST', '/v1/org/nodes/B1', 'u-owner', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }), 'branch draft');
    const asked = await askForApproval(h, T, 'u-owner', { kind: 'org_structure_change', subjectRef: 'B1', details: { nodeId: 'B1', action: 'activate' } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ raisedByTheOwner: true });
    expect((asked.body as { decidedByTheAccountant: string }).decidedByTheAccountant).toMatch(/store's accountant approves it/);
    const id = idOf(asked);
    expect((await inbox(req, 'u-acc')).map((r) => r.requestId)).toContain(id);
    expect((await inbox(req, 'u-acc')).find((r) => r.requestId === id)?.decidedByTheAccountant).toMatch(/OB-613/);
    expect((await inbox(req, 'u-owner')).map((r) => r.requestId)).not.toContain(id);
    expect((await inbox(req, 'u-mgr')).map((r) => r.requestId)).not.toContain(id);
    // The owner never approves his own; the manager is not the accountant.
    const own = await decide(h, T, 'u-owner', id);
    expect(own.status).toBe(422);
    expect(codeOf(own)).toBe('self_approval');
    const mgr = await decide(h, T, 'u-mgr', id);
    expect(mgr.status).toBe(403);
    expect(JSON.stringify(mgr.body)).toMatch(/store's accountant approves it/);
    // Not yet approved: the branch does not open.
    expect(codeOf(await req('POST', '/v1/org/nodes/B1/activation', 'u-owner', { approvalId: id }))).toBe('approval_still_waiting');
    expect((await decide(h, T, 'u-acc', id)).status).toBe(201);
    const opened = await ok(req('POST', '/v1/org/nodes/B1/activation', 'u-owner', { approvalId: id }), 'activate');
    expect((opened.body as { node: { status: string } }).node.status).toBe('active');
  });

  it('somebody else\'s request of the same kind still needs the owner — the accountant may not approve it', async () => {
    const { h, T, req, ok } = await shop();
    await ok(req('POST', '/v1/org/nodes/C1', 'u-it', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', `/v1/org/gst-registrations/${G1}`, 'u-it', { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }), 'gst');
    await ok(req('POST', '/v1/org/nodes/B1', 'u-it', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1', gstin: G1 }), 'branch draft');
    const asked = await askForApproval(h, T, 'u-it', { kind: 'org_structure_change', subjectRef: 'B1', details: { nodeId: 'B1', action: 'activate' } });
    expect(asked.body).not.toHaveProperty('raisedByTheOwner');
    const id = idOf(asked);
    expect((await inbox(req, 'u-acc')).map((r) => r.requestId)).not.toContain(id);
    expect((await decide(h, T, 'u-acc', id)).status).toBe(403);
    expect((await decide(h, T, 'u-owner', id)).status).toBe(201);
    await ok(req('POST', '/v1/org/nodes/B1/activation', 'u-it', { approvalId: id }), 'activate');
  });

  it('a limit change the owner asks for: the accountant approves it — never one that touches the accountant\'s own limits', async () => {
    const { h, T, req } = await shop();
    const rules = (await req('GET', '/v1/approvals/rules', 'u-owner')).body as { rules: { limits: { value: { byRole: Record<string, Record<string, number | null>> } } } };
    const byRole = rules.rules.limits.value.byRole;
    const touchesAccountant = { value: { byRole: { ...byRole, accountant: { refund: 100_000 } } }, basedOnVersion: 0, reason: 'the accountant signs off refunds at the desk' };
    const a1 = await askForApproval(h, T, 'u-owner', { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(touchesAccountant, { rule: 'limits' }) });
    expect(a1.body).toMatchObject({ raisedByTheOwner: true });
    expect(codeOf(await decide(h, T, 'u-owner', idOf(a1)))).toBe('self_approval');
    expect((await decide(h, T, 'u-acc', idOf(a1))).status).toBe(201);
    const refused = await req('PUT', '/v1/approvals/rules/limits', 'u-owner', { ...touchesAccountant, approvalId: idOf(a1) });
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('approver_cannot_approve_own_limits');
    // The approval was not used, and nothing changed.
    expect(((await req('GET', '/v1/approvals/rules', 'u-owner')).body as { rules: { limits: { version: number } } }).rules.limits.version).toBe(0);

    const managers = { value: { byRole: { ...byRole, store_manager: { ...byRole['store_manager'], refund: 600_000 } } }, basedOnVersion: 0, reason: 'Diwali returns' };
    const a2 = await askForApproval(h, T, 'u-owner', { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(managers, { rule: 'limits' }) });
    expect((await decide(h, T, 'u-acc', idOf(a2))).status).toBe(201);
    const applied = await req('PUT', '/v1/approvals/rules/limits', 'u-owner', { ...managers, approvalId: idOf(a2) });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ version: 1, approvedBy: 'u-acc', changedBy: 'u-owner' });
  });
});
