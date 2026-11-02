import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { ROLE_CATALOGUE, ROLES_AWAITING_OWNER_APPROVAL, SECTION_28_ROLES } from '../../services/api/src/roles';
import { HANDHELD_AUTHORITY } from '../../edge/store-edge/src/handheld-sign-in';

/**
 * **OB-622 (owner, 1 Nov 2026, in writing): the four roadmap §28 buying and stock roles — Purchase User, Purchase Approver,
 * Receiver/QC, Warehouse User — "all four approved as shown" and LIVE; OB-571 (owner, 31 Oct 2026, "A"): the roadmap's
 * Picker and Delivery roles, each with exactly §28's scope and limits, so a picker and a driver can use their handhelds.**
 * (services/api/src/roles.ts.) Until OB-622 the four were refused by name (OB-615); now they are given through the normal
 * maker-checker grant on Users & roles, and nothing waits.
 */

const byId = (id: string) => SECTION_28_ROLES.find((r) => r.id === id)!;
const SIX = ['purchase_user', 'purchase_approver', 'receiver_qc', 'warehouse_user', 'picker', 'delivery_driver'];
const BASE_WORDS = new Set(ROLE_CATALOGUE.filter((r) => !SIX.includes(r.id)).flatMap((r) => r.permissions));

describe('the §28 roles are written from the roadmap and are live', () => {
  it('are exactly the six, with the roadmap\'s scope, MAY and MUST NOT word for word; all in the live catalogue; none waits', () => {
    expect(SECTION_28_ROLES.map((r) => [r.id, r.name, r.roadmap.scope, r.roadmap.may, r.roadmap.mustNot])).toEqual([
      ['purchase_user', 'Purchase user', 'Assigned suppliers/categories', 'Requisition/RFQ/PO draft', 'Cannot receive, match and pay same transaction'],
      ['purchase_approver', 'Purchase approver', 'Configured limits', 'PO/contract/rate approval', 'Cannot approve own supplier/bank creation'],
      ['receiver_qc', 'Receiver / QC', 'Assigned locations', 'Receive/count/QC/quarantine', 'Cannot change PO price or approve supplier payment'],
      ['warehouse_user', 'Warehouse user', 'Assigned locations', 'Put-away/pick/transfer/count', 'Cannot self-approve material variances'],
      // §28 has ONE row for both: "Picker/Delivery — Assigned orders — Pick/pack/deliver/proof/COD — Cannot change catalogue
      // price or reroute without policy". OB-571 asked for a Picker role and a Delivery role, each with exactly that.
      ['picker', 'Picker', 'Assigned orders', 'Pick/pack/deliver/proof/COD', 'Cannot change catalogue price or reroute without policy'],
      ['delivery_driver', 'Delivery driver', 'Assigned orders', 'Pick/pack/deliver/proof/COD', 'Cannot change catalogue price or reroute without policy'],
    ]);
    for (const r of SECTION_28_ROLES) {
      const live = ROLE_CATALOGUE.find((x) => x.id === r.id);
      expect(live, r.id).toBeDefined();
      expect(live!.permissions).toEqual(r.permissions);
      // The catalogue carries the words only — the store setup is not widened with the reasons.
      expect(Object.keys(live!).sort()).toEqual(['id', 'name', 'permissions']);
    }
    expect(ROLES_AWAITING_OWNER_APPROVAL).toEqual([]);
    expect(byId('purchase_user').liveBy).toMatch(/OB-622/);
    expect(byId('picker').liveBy).toMatch(/OB-571/);
  });

  it('every word is one the product already has (nothing invented), each has a reason, and no withheld word is held', () => {
    for (const r of SECTION_28_ROLES) {
      expect(r.permissions).toEqual(r.words.map((w) => w.permission));
      expect(new Set(r.permissions).size, `${r.id} repeats a word`).toBe(r.permissions.length);
      for (const w of [...r.words, ...r.withheld]) {
        expect(BASE_WORDS.has(w.permission), `${r.id}: ${w.permission} is not a word any other role holds`).toBe(true);
        expect(w.why.length, `${r.id}: ${w.permission} has no reason`).toBeGreaterThan(10);
      }
      for (const w of r.withheld) expect(r.permissions, `${r.id} holds withheld ${w.permission}`).not.toContain(w.permission);
    }
  });

  it('each MUST NOT is a word the role does not hold', () => {
    const lacks = (id: string, words: readonly string[]) => { for (const w of words) expect(byId(id).permissions, `${id} must not hold ${w}`).not.toContain(w); };
    lacks('purchase_user', ['purchase.order.receive', 'purchase.invoice.capture', 'purchase.invoice.match', 'purchase.supplier.pay', 'purchase.order.approve']);
    expect(byId('purchase_user').permissions).toContain('purchase.order.propose');
    lacks('purchase_approver', ['purchase.supplier.manage', 'purchase.supplier.bank', 'purchase.order.propose', 'purchase.supplier.pay']);
    expect(byId('purchase_approver').permissions).toContain('purchase.order.approve');
    expect(byId('purchase_approver').limitedBy).toEqual(['money limit']);
    lacks('receiver_qc', ['purchase.order.propose', 'purchase.order.approve', 'purchase.supplier.pay', 'purchase.invoice.match', 'inventory.adjustment.approve']);
    expect(byId('receiver_qc').permissions).toEqual(expect.arrayContaining(['purchase.order.receive', 'quality.hold.manage']));
    lacks('warehouse_user', ['inventory.adjustment.approve']);
    expect(byId('warehouse_user').permissions).toContain('inventory.movement.append');
    // The owner's answers of 1 Nov 2026: the manager keeps adding/editing suppliers and releasing holds; the approver keeps
    // the one supplier-deals word.
    lacks('purchase_user', ['purchase.supplier.manage']);
    lacks('receiver_qc', ['quality.hold.release']);
    expect(byId('purchase_approver').permissions).toContain('purchase.supplier.approve');
    for (const id of ['purchase_user', 'purchase_approver', 'receiver_qc']) expect(byId(id).questions, id).toEqual([]);
    // Picker / Delivery: cannot change a catalogue price, cannot reroute; each holds only its own phone's job.
    for (const id of ['picker', 'delivery_driver']) {
      lacks(id, ['price.change.propose', 'price.change.approve', 'catalogue.pack.publish', 'delivery.dispatch.manage', 'fulfilment.wave.assign', 'order.lifecycle.manage']);
      expect(byId(id).limitedBy).toEqual(['assigned work']);
    }
    expect(byId('picker').permissions).toEqual(['identity.self.read', 'payroll.ess.self', HANDHELD_AUTHORITY.picker]);
    expect(byId('delivery_driver').permissions).toEqual(['identity.self.read', 'payroll.ess.self', HANDHELD_AUTHORITY.driver]);
    lacks('picker', [HANDHELD_AUTHORITY.driver, HANDHELD_AUTHORITY.warehouse]);
    lacks('delivery_driver', [HANDHELD_AUTHORITY.picker, HANDHELD_AUTHORITY.warehouse, 'order.payment.record', 'delivery.settlement.approve']);
    // No role here grants a role, sets a price, pays or closes anything.
    for (const r of SECTION_28_ROLES) for (const p of r.permissions) expect(p, `${r.id}: ${p}`).not.toMatch(/^(identity\.role\.|price\.|finance\.|platform\.|cash\.|till\.)/);
  });
});

describe('on the real API: listed live, asked by the manager, approved by the owner, held', () => {
  async function shop() {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    expect((await req('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'C' })).status).toBeLessThan(300);
    expect((await req('POST', '/v1/org/nodes/store-1', 'u-owner', { kind: 'branch', name: 's1', parentId: 'C1', companyId: 'C1' })).status).toBeLessThan(300);
    return { req };
  }

  it('the roles read lists the six among the live roles and nothing as waiting', async () => {
    const { req } = await shop();
    const r = await req('GET', '/v1/identity/roles', 'u-owner');
    expect(r.status).toBe(200);
    const body = r.body as { roles: { id: string }[]; awaitingOwnerApproval: unknown[] };
    expect(body.roles.map((x) => x.id)).toEqual(expect.arrayContaining(SIX));
    expect(body.awaitingOwnerApproval).toEqual([]);
  });

  it('each of the six is asked for by the manager, approved by the owner (never by the asker), and then held', async () => {
    const { req } = await shop();
    for (const roleId of SIX) {
      const user = `u-${roleId}`;
      const asked = await req('POST', '/v1/identity/grants', 'u-mgr', { grantId: `g-${roleId}`, userId: user, roleId, branchScope: ['store-1'], reason: 'new colleague' });
      expect(asked.status, `${roleId}: ${JSON.stringify(asked.body)}`).toBe(202);
      expect((asked.body as { state: string }).state).toBe('pending');
      // The asker cannot approve their own request.
      expect((await req('POST', `/v1/identity/grants/g-${roleId}/approve`, 'u-mgr', {})).status, roleId).toBeGreaterThanOrEqual(400);
      const approved = await req('POST', `/v1/identity/grants/g-${roleId}/approve`, 'u-owner', {});
      expect(approved.status, `${roleId}: ${JSON.stringify(approved.body)}`).toBe(201);
    }
    const grants = (await req('GET', '/v1/identity/grants', 'u-owner')).body as { grants: { userId: string; roleId: string }[] };
    for (const roleId of SIX) expect(grants.grants.some((g) => g.userId === `u-${roleId}` && g.roleId === roleId), roleId).toBe(true);
    // A joiner change naming one is no longer refused by name (OB-615 before OB-622): it goes on to the normal rule — it needs
    // the owner's approval for exactly this change, like any other role.
    const join = await req('POST', '/v1/access/lifecycle/j-1', 'u-mgr', { event: 'joiner', userId: 'u-new', reason: 'new receiver', grants: [{ userId: 'u-new', roleId: 'receiver_qc', branchScope: ['store-1'] }] });
    expect((join.body as { error?: { code?: string } }).error?.code).toBe('access_change_needs_approval');
  });
});
