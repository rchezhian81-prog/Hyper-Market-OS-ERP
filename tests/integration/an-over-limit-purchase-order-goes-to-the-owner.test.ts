import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useSettingsBackings } from '../support/settings-backings';
import { P3, p3Shop } from '../support/p3-purchase';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';

// OB-290 · M02-FR-02 · M06-FR-04 — the integration follow-up (owner, 23 Oct 2026): procure-to-pay's purchase-order limit is
// identity's server-held rule (`authorityOf`), not a default kept in the purchasing code. A store manager may raise a
// purchase order up to ₹25,000 as theirs; above it the order goes to the OWNER, said on the order from the moment it is
// raised, and the owner issues it. The figure is the owner's to change — through two people on the Approval rules page —
// and a changed figure decides the next order, also after a cold restart. In memory and on real PostgreSQL.

const backings = useSettingsBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const LOCAL = 'u-local'; // a store manager whose authority is store-1 only
type Order = { status: string; buyingScope: string; routedToOwner?: { raiserLimitMinor: number | null; raiserLimitFrom: string | null; valueMinor: number; rulesVersion: number } };

describe.each(backings)('an over-limit purchase order goes to the owner (OB-290 follow-up) — on $name', ({ make }) => {
  it('a store manager\'s order above ₹25,000 is routed to the owner and the owner issues it; within it, it is theirs; the owner\'s changed limit decides after a restart', async () => {
    const backing = make();
    let h: ApiHarness = backing.harness();
    const T = randomUUID();
    await p3Shop(h, T);
    await h.provisionRole(T, LOCAL, 'store_manager', [P3.STORE]);
    await h.provisionRole(T, 'u-owner2', 'owner'); // the second person for an order the owner raises himself (§28)
    let n = 0;
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> => h.request({
      method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n++}-${path}` }),
      ...(userId === LOCAL ? { branchId: P3.STORE } : {}), ...(body === undefined ? {} : { body }),
    });
    const propose = (poId: string, userId: string, qty: number, unitMinor = 10_000) => req('POST', `/v1/purchase/orders/${poId}`, userId, {
      supplierId: 'sup-1', deliverToLocationId: P3.STORE, lines: [{ productId: 'rice', orderedQty: qty, unitCost: { minor: unitMinor, currency: 'INR' } }],
    });
    const order = async (poId: string): Promise<Order> => ((await req('GET', `/v1/purchase/orders/${poId}`, P3.OWNER)).body as { order: Order }).order;

    // ₹30,000 raised by the store manager: above his ₹25,000 — the owner's to decide, said on the order and in the reply.
    const big = await propose('po-big', LOCAL, 300);
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body).toMatchObject({ approval: { routedTo: 'owner' } });
    expect((big.body as { approval: { why: string } }).approval.why).toContain('up to ₹25,000.00 (store_manager)');
    expect(await order('po-big')).toMatchObject({ status: 'proposed', buyingScope: 'local', routedToOwner: { raiserLimitMinor: 2_500_000, raiserLimitFrom: 'store_manager', valueMinor: 3_000_000, rulesVersion: 0 } });
    // ₹25,000 exactly is within his limit: not routed.
    expect((await propose('po-ok', LOCAL, 250)).status).toBe(201);
    expect((await order('po-ok')).routedToOwner).toBeUndefined();
    // The owner issues the routed order (unlimited); the store manager may never issue his own (§28) — nor anyone's (no right).
    expect((await req('POST', '/v1/purchase/orders/po-big/approval', LOCAL, { reason: 'mine' })).status).toBe(403);
    const issued = await req('POST', '/v1/purchase/orders/po-big/approval', P3.OWNER, { reason: 'Diwali stock, checked' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(await order('po-big')).toMatchObject({ status: 'issued' });
    // The owner's own large order still needs a second person — another owner (unlimited) issues it.
    expect((await propose('po-own', P3.OWNER, 10_000)).status).toBe(201);
    expect((await order('po-own')).routedToOwner).toBeUndefined();
    expect(codeOf(await req('POST', '/v1/purchase/orders/po-own/approval', P3.OWNER, { reason: 'x' }))).toBe('proposer_cannot_approve');
    expect((await req('POST', '/v1/purchase/orders/po-own/approval', 'u-owner2', { reason: 'checked' })).status).toBe(200);
    // A cashier raises nothing.
    expect((await propose('po-cash', P3.CASHIER, 1)).status).toBe(403);

    // The owner raises the store manager's limit to ₹40,000 — asked by the accountant, approved by the owner (two people).
    const rules = (await req('GET', '/v1/approvals/rules', P3.OWNER)).body as { rules: { limits: { version: number; value: { byRole: Record<string, Record<string, number | null>> } } } };
    const change = { value: { byRole: { ...rules.rules.limits.value.byRole, store_manager: { ...rules.rules.limits.value.byRole['store_manager'], purchase_order: 4_000_000 } } }, basedOnVersion: 0, reason: 'festival buying at the store' };
    const ask = await askForApproval(h, T, P3.MATCHER, { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(change, { rule: 'limits' }) });
    const requestId = (ask.body as { requestId: string }).requestId;
    expect((await decide(h, T, P3.OWNER, requestId)).status).toBe(201);
    const applied = await req('PUT', '/v1/approvals/rules/limits', P3.MATCHER, { ...change, approvalId: requestId });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);

    h = backing.harness(); // ── cold restart: the limit is read back from the settings store ──
    expect((await propose('po-after', LOCAL, 300)).status).toBe(201);
    expect((await order('po-after')).routedToOwner).toBeUndefined();
    const above = await propose('po-above', LOCAL, 401);
    expect(above.body).toMatchObject({ approval: { routedTo: 'owner' } });
    expect(await order('po-above')).toMatchObject({ routedToOwner: { raiserLimitMinor: 4_000_000, rulesVersion: 1 } });
    // What was routed before the change stays as it was recorded (append-only).
    expect(await order('po-big')).toMatchObject({ routedToOwner: { raiserLimitMinor: 2_500_000, rulesVersion: 0 } });
  }, 120_000);
});
