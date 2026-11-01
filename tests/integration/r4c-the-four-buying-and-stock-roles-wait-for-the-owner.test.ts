import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { ROLE_CATALOGUE, ROLES_AWAITING_OWNER_APPROVAL } from '../../services/api/src/roles';

/**
 * **OB-615 (owner, 31 Oct 2026, in writing): the four roadmap §28 roles — Purchase User, Purchase Approver, Receiver/QC,
 * Warehouse User — defined with exactly the roadmap's scope, MAY and MUST NOT, shown to the owner, and given to NOBODY until
 * he approves them** (services/api/src/roles.ts · services/identity/src/roles-awaiting-approval.ts).
 */

const byId = (id: string) => ROLES_AWAITING_OWNER_APPROVAL.find((r) => r.id === id)!;
const LIVE_WORDS = new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions));

describe('the four roles are written down from §28, and are not live', () => {
  it('are exactly the four, with the roadmap\'s scope, MAY and MUST NOT word for word, and none is in the live catalogue', () => {
    expect(ROLES_AWAITING_OWNER_APPROVAL.map((r) => [r.id, r.name, r.roadmap.scope, r.roadmap.may, r.roadmap.mustNot])).toEqual([
      ['purchase_user', 'Purchase user', 'Assigned suppliers/categories', 'Requisition/RFQ/PO draft', 'Cannot receive, match and pay same transaction'],
      ['purchase_approver', 'Purchase approver', 'Configured limits', 'PO/contract/rate approval', 'Cannot approve own supplier/bank creation'],
      ['receiver_qc', 'Receiver / QC', 'Assigned locations', 'Receive/count/QC/quarantine', 'Cannot change PO price or approve supplier payment'],
      ['warehouse_user', 'Warehouse user', 'Assigned locations', 'Put-away/pick/transfer/count', 'Cannot self-approve material variances'],
    ]);
    for (const r of ROLES_AWAITING_OWNER_APPROVAL) expect(ROLE_CATALOGUE.some((x) => x.id === r.id), r.id).toBe(false);
  });

  it('every word is one the product already has (nothing invented), each has a reason, and no withheld word is held', () => {
    for (const r of ROLES_AWAITING_OWNER_APPROVAL) {
      expect(r.permissions).toEqual(r.words.map((w) => w.permission));
      expect(new Set(r.permissions).size, `${r.id} repeats a word`).toBe(r.permissions.length);
      for (const w of [...r.words, ...r.withheld]) {
        expect(LIVE_WORDS.has(w.permission), `${r.id}: ${w.permission} is not a word any live role holds`).toBe(true);
        expect(w.why.length, `${r.id}: ${w.permission} has no reason`).toBeGreaterThan(10);
      }
      for (const w of r.withheld) expect(r.permissions, `${r.id} holds withheld ${w.permission}`).not.toContain(w.permission);
    }
  });

  it('each MUST NOT is a word the role does not hold', () => {
    const lacks = (id: string, words: readonly string[]) => { for (const w of words) expect(byId(id).permissions, `${id} must not hold ${w}`).not.toContain(w); };
    // Purchase user: cannot receive, match and pay the same transaction (and does not approve its own draft).
    lacks('purchase_user', ['purchase.order.receive', 'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.supplier.pay', 'purchase.order.approve']);
    expect(byId('purchase_user').permissions).toContain('purchase.order.propose');
    // Purchase approver: cannot approve own supplier/bank creation — so creates neither; the limit is the owner's.
    lacks('purchase_approver', ['purchase.supplier.manage', 'purchase.supplier.bank', 'purchase.order.propose', 'purchase.supplier.pay']);
    expect(byId('purchase_approver').permissions).toContain('purchase.order.approve');
    expect(byId('purchase_approver').limitedBy).toEqual(['money limit']);
    // Receiver/QC: cannot change PO price or approve supplier payment.
    lacks('receiver_qc', ['purchase.order.propose', 'purchase.order.approve', 'purchase.supplier.pay', 'purchase.invoice.match', 'inventory.adjustment.approve']);
    expect(byId('receiver_qc').permissions).toEqual(expect.arrayContaining(['purchase.order.receive', 'quality.hold.manage']));
    // Warehouse user: cannot self-approve material variances.
    lacks('warehouse_user', ['inventory.adjustment.approve']);
    expect(byId('warehouse_user').permissions).toContain('inventory.movement.append');
    // No role here grants a role, sets a price, pays or closes anything.
    for (const r of ROLES_AWAITING_OWNER_APPROVAL) for (const p of r.permissions) expect(p, `${r.id}: ${p}`).not.toMatch(/^(identity\.role\.|price\.|finance\.|platform\.|cash\.|till\.)/);
  });
});

describe('on the real API: shown to the owner, given to nobody', () => {
  async function shop() {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    return { req };
  }

  it('the roles read lists the four as waiting, beside — never inside — the live roles', async () => {
    const { req } = await shop();
    const r = await req('GET', '/v1/identity/roles', 'u-owner');
    expect(r.status).toBe(200);
    const body = r.body as { roles: { id: string }[]; awaitingOwnerApproval: { id: string; permissions: string[]; words: { permission: string; why: string }[]; roadmap: { may: string } }[] };
    expect(body.awaitingOwnerApproval.map((x) => x.id)).toEqual(['purchase_user', 'purchase_approver', 'receiver_qc', 'warehouse_user']);
    expect(body.roles.map((x) => x.id)).not.toContain('purchase_user');
    expect(body.awaitingOwnerApproval[0]!.words.length).toBeGreaterThan(0);
  });

  it('a grant request for one of them is refused by name; so is a joiner change that names one', async () => {
    const { req } = await shop();
    for (const roleId of ['purchase_user', 'purchase_approver', 'receiver_qc', 'warehouse_user']) {
      const asked = await req('POST', '/v1/identity/grants', 'u-mgr', { grantId: `g-${roleId}`, userId: 'u-new', roleId, branchScope: ['store-1'], reason: 'new buyer' });
      expect(asked.status, roleId).toBe(422);
      expect((asked.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'role_awaiting_owner_approval' });
      expect((asked.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/OB-615/);
    }
    expect(((await req('GET', '/v1/identity/grants/pending', 'u-owner')).body as { requests: unknown[] }).requests).toEqual([]);
    const join = await req('POST', '/v1/access/lifecycle/j-1', 'u-mgr', { event: 'joiner', userId: 'u-new', reason: 'new receiver', grants: [{ userId: 'u-new', roleId: 'receiver_qc', branchScope: ['store-1'] }] });
    expect(join.status).toBe(422);
    expect((join.body as { error: { code: string } }).error.code).toBe('role_awaiting_owner_approval');
  });
});
