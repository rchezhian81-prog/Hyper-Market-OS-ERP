import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { giveRefundApproval, refundApprovalId } from '../support/refund-approval';
import { cashAdapter, refundApprovalsAdapter, STREAM, ROLE_REVOKED } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';

/**
 * **Audit PF-02, head office's half (ADR-0022 · Wave 2b-v-c · M13-FR-01/02/03 · M14-FR-01 · §28 · hard rule #10).**
 *
 * The audit's reproduction, through the real router, token auth, per-tenant RBAC and the append-only store: "Refund
 * body named a provisioned manager who never authenticated or approved; both requests settled. Cloud role lookup
 * proves that name has authority, not that the person approved this action." Here the same body is refused; the
 * manager approves in their OWN session, for this bill, this amount and this cashier; the refund names that approval;
 * the approval pays exactly one refund — also when two refunds spend it at the same moment on real PostgreSQL — and
 * stops counting when the manager leaves.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-06T10:00:00.000Z';

const sale = (saleId = 'S1') => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-06', committedAt: AT,
  totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, tenantId: string, saleId = 'S1') =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId, idempotencyKey: `bank-${saleId}`, body: sale(saleId) });
const refund = (over: Record<string, unknown> = {}) => ({
  returnId: 'RT-1', reasonCode: 'damaged', refundMinor: 5000, refundTender: 'cash', processedAt: AT,
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'damaged' }], ...over,
});
const ret = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, saleId = 'S1') =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns`, userId, tenantId, idempotencyKey: `ret-${String(body['returnId'])}`, body });
const noReceipt = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/returns/no-receipt', userId, tenantId, idempotencyKey: `nr-${String(body['returnId'])}`, body });
const refunded = async (h: ApiHarness, tenantId: string, saleId = 'S1') =>
  ((await h.request({ method: 'GET', path: `/v1/sales/${saleId}/returnable`, userId: 'u-owner', tenantId })).body as { refundedMinor: number }).refundedMinor;
/** A return without a receipt must name a product the shop sells; and that path is off until the owner sets a cap. */
async function openNoReceipt(h: ApiHarness, tenantId: string): Promise<void> {
  await h.request({ method: 'POST', path: '/v1/pos/no-receipt-cap', userId: 'u-owner', tenantId, idempotencyKey: `cap-${tenantId}`, body: { capMinor: 100000 } });
  await h.request({
    method: 'POST', path: '/v1/catalogue/products/P1/publish', userId: 'u-owner', tenantId, idempotencyKey: `pub-P1-${tenantId}`,
    body: { product: { sku: 'SKU-P1', name: 'P1', baseUom: 'each', primaryCategoryId: 'g', taxClass: '25010020', lifecycle: 'draft' }, categories: [{ categoryId: 'g', name: 'G', parentId: null }] },
  });
}
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(h: ApiHarness, tenantId: string): Promise<void> {
  await h.seedOwner(tenantId, 'u-owner');
  await h.provisionRole(tenantId, 'u-mgr', 'store_manager'); // holds pos.return.approve
  await h.provisionRole(tenantId, 'u-cash', 'cashier');      // pos.return.record; may not approve
  await h.provisionRole(tenantId, 'u-cash2', 'cashier');
}

describe('a head-office refund approval is the approver\'s own act (audit PF-02)', () => {
  it('the audit\'s body — a provisioned manager NAMED who never approved — is refused, and nothing moves', async () => {
    const h = apiHarness();
    await cast(h, A);
    await bank(h, A);
    const res = await ret(h, A, 'u-cash', refund({ approvedBy: 'u-mgr' }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('approver_named_without_approval');
    expect(await refunded(h, A)).toBe(0);
    // The same, on a return without a receipt (once the owner has switched that path on).
    await openNoReceipt(h, A);
    expect(codeOf(await noReceipt(h, A, 'u-cash', { ...refund({ returnId: 'NR-1', approvedBy: 'u-mgr' }) }))).toBe('approver_named_without_approval');
  });

  it('the manager approves in their own session; the refund names the approval and lands, recording who approved', async () => {
    const h = apiHarness();
    await cast(h, A);
    await bank(h, A);
    const given = await giveRefundApproval(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash', reason: 'pack torn' });
    expect(given.status).toBe(201);
    const approvalId = (given.body as { approvalId: string }).approvalId;

    const res = await ret(h, A, 'u-cash', refund({ approvalId }));
    expect(res.status).toBe(201);
    expect(await refunded(h, A)).toBe(5000);
    // Head office's register shows the approval spent by THIS refund.
    const state = await refundApprovalsAdapter({ store: h.store, now: () => AT }).refundApproval(A, approvalId);
    expect(state).toMatchObject({ approval: { approvedBy: 'u-mgr', requestedBy: 'u-cash', saleId: 'S1', valueMinor: 5000 }, usedBy: 'RT-1' });
    // The lost reply resent — same refund, same approval — is the same answer, not a second refund.
    expect((await ret(h, A, 'u-cash', refund({ approvalId }))).status).toBe(201);
    expect(await refunded(h, A)).toBe(5000);
  });

  it('one approval pays ONE refund — of this bill, this amount, by this cashier', async () => {
    const h = apiHarness();
    await cast(h, A);
    await bank(h, A);
    await bank(h, A, 'S2');
    const approvalId = await refundApprovalId(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash' });

    expect(codeOf(await ret(h, A, 'u-cash2', refund({ approvalId })))).toBe('approval_does_not_match');            // another cashier
    expect(codeOf(await ret(h, A, 'u-cash', refund({ approvalId, refundMinor: 10000, lines: [{ productId: 'P1', uom: 'each', quantityMinor: 2, disposition: 'damaged' }] })))).toBe('approval_does_not_match'); // more money
    expect(codeOf(await ret(h, A, 'u-cash', refund({ approvalId }), 'S2'))).toBe('approval_does_not_match');         // another bill
    expect((await ret(h, A, 'u-cash', refund({ approvalId }))).status).toBe(201);
    // The bill still has two units and ₹100 left — but the approval is spent.
    expect(codeOf(await ret(h, A, 'u-cash', refund({ returnId: 'RT-2', approvalId })))).toBe('approval_already_used');
    expect(await refunded(h, A)).toBe(5000);
  });

  it('an approval stops counting when the approver leaves — and a leaver can give no more', async () => {
    const h = apiHarness();
    await cast(h, A);
    await bank(h, A);
    const approvalId = await refundApprovalId(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash' });
    await h.store.append(A, STREAM.identity, makeEvent({
      id: 'revoke-u-mgr', type: ROLE_REVOKED, occurredAt: AT, idempotencyKey: `revoke-${A}-u-mgr`, source: 'test/provision',
      payload: { userId: 'u-mgr', roleId: 'store_manager', branchScope: 'all' },
    }));
    expect(codeOf(await ret(h, A, 'u-cash', refund({ approvalId })))).toBe('approver_may_not_approve');
    expect((await giveRefundApproval(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash' })).status).toBe(403);
    expect(await refunded(h, A)).toBe(0);
  });

  it('giving an approval is gated: a cashier cannot, nobody approves their own, and a replay is the same approval', async () => {
    const h = apiHarness();
    await cast(h, A);
    expect((await giveRefundApproval(h, A, 'u-cash', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash2' })).status).toBe(403);
    expect(codeOf(await giveRefundApproval(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-mgr' }))).toBe('self_approval');
    expect(codeOf(await giveRefundApproval(h, A, 'u-mgr', { saleId: 'S1', valueMinor: 5000, requestedBy: 'u-ghost' }))).toBe('requester_unknown');
    const send = () => h.request({
      method: 'POST', path: '/v1/pos/refund-approvals', userId: 'u-mgr', tenantId: A, idempotencyKey: 'apr-once',
      body: { kind: 'refund', saleId: 'S1', valueMinor: 5000, requestedBy: 'u-cash', reason: 'r' },
    });
    const first = await send();
    expect(first.status).toBe(201);
    expect((await send()).body).toEqual(first.body);
  });

  it('a no-receipt return spends its approval once', async () => {
    const h = apiHarness();
    await cast(h, A);
    await openNoReceipt(h, A);
    const approvalId = await refundApprovalId(h, A, 'u-mgr', { kind: 'no_receipt_return', valueMinor: 5000, requestedBy: 'u-cash' });
    const nr = (returnId: string) => ({ ...refund({ returnId, approvalId }), lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'quarantine' }] });
    expect((await noReceipt(h, A, 'u-cash', nr('NR-1'))).status).toBe(201);
    expect(codeOf(await noReceipt(h, A, 'u-cash', nr('NR-2')))).toBe('approval_already_used');
  });

  it('a head-office cash movement records the signed-in person who did it', async () => {
    const h = apiHarness();
    await cast(h, A);
    const res = await h.request({
      method: 'POST', path: '/v1/tills/T1/cash-movements', userId: 'u-mgr', tenantId: A, idempotencyKey: 'cm-1',
      body: { movementId: 'm1', kind: 'float_issue', amountMinor: 10000, custodianId: 'u-cash', tradingDay: '2026-10-06', performedBy: 'u-owner' },
    });
    expect(res.status).toBe(201);
    const moved = await cashAdapter({ store: h.store, now: () => AT }).tillMovements(A, 'T1');
    expect(moved.map((m) => m.performedBy)).toEqual(['u-mgr']);
    // A till is never put in the name of someone head office does not know.
    expect(codeOf(await h.request({
      method: 'POST', path: '/v1/tills/T2/cash-movements', userId: 'u-mgr', tenantId: A, idempotencyKey: 'cm-2',
      body: { movementId: 'm2', kind: 'float_issue', amountMinor: 10000, custodianId: 'u-ghost', tradingDay: '2026-10-06' },
    }))).toBe('custodian_unknown');
  });
});

// The race, on the database the cloud runs on: two refunds spending ONE approval at the same moment. Skips (never
// passes quietly) without DATABASE_URL; runs in the "Stage gate suites" CI job.
const DATABASE_URL = process.env['DATABASE_URL'];
const RUN = `ap${Date.now().toString(36)}`;
const PG_TENANT = `a${Date.now().toString(16).slice(-7)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('one approval, two refunds at the same moment — real PostgreSQL (audit PF-02)', () => {
  let pool: Pool;
  let h: ApiHarness;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
    const sql = pgPoolClient(pool);
    const dir = 'db/migrations';
    await runMigrations(sql, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    await cast(h, PG_TENANT);
  });
  afterAll(async () => { await pool.end(); });

  it('two refunds of one bill naming the same approval: exactly one lands, the other is refused by name, nothing doubled', async () => {
    const S = `${RUN}-S1`;
    expect((await bank(h, PG_TENANT, S)).status).toBe(202);
    const approvalId = await refundApprovalId(h, PG_TENANT, 'u-mgr', { saleId: S, valueMinor: 5000, requestedBy: 'u-cash' });
    const [a, b] = await Promise.all([
      ret(h, PG_TENANT, 'u-cash', refund({ returnId: `${RUN}-RA`, approvalId }), S),
      ret(h, PG_TENANT, 'u-cash', refund({ returnId: `${RUN}-RB`, approvalId }), S),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const loser = a.status === 201 ? b : a;
    expect(['concurrent_change', 'approval_already_used']).toContain(codeOf(loser));
    expect(await refunded(h, PG_TENANT, S)).toBe(5000);
  });

  it('two returns without a receipt spending one approval: exactly one lands — the approval guards itself', async () => {
    await openNoReceipt(h, PG_TENANT);
    const approvalId = await refundApprovalId(h, PG_TENANT, 'u-mgr', { kind: 'no_receipt_return', valueMinor: 5000, requestedBy: 'u-cash' });
    const nr = (returnId: string) => ({ ...refund({ returnId, approvalId }), lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'quarantine' }] });
    const [a, b] = await Promise.all([noReceipt(h, PG_TENANT, 'u-cash', nr(`${RUN}-NA`)), noReceipt(h, PG_TENANT, 'u-cash', nr(`${RUN}-NB`))]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const loser = a.status === 201 ? b : a;
    expect(['concurrent_change', 'approval_already_used']).toContain(codeOf(loser));
    const report = (await h.request({ method: 'GET', path: '/v1/pos/no-receipt-returns', userId: 'u-owner', tenantId: PG_TENANT })).body as { count: number; totalRefundedMinor: number };
    expect(report).toMatchObject({ count: 1, totalRefundedMinor: 5000 });
  });
});
