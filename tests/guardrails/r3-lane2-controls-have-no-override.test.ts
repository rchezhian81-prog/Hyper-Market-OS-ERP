import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { buildSurface } from '../../services/api/src/main';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { TokenRevocationList } from '../../services/identity/src/revocation';
import { tokenRevocationAdapter } from '../../services/api/src/adapters';
import { apiHarness } from '../support/api-harness';

/**
 * R3 lane 2 — every "no override exists" claim, held by a check (A17 · A24 · C14 · C5 · A23):
 *
 *   • A17 — ITC is claimed only from the accepted 2B lines: no route takes a claim amount; an action is the signed-in
 *     person's (a body naming who acted is refused); only a matched line may be accepted.
 *   • A24 (OB-143) — only the CA fills the TDS list and only the owner switches TDS on: no other role holds either
 *     permission, and the list cannot carry the switch.
 *   • C14 (OB-144) — a refund not to the source passes ONLY with a second person's `tender_exception` approval: a name in
 *     the body does not count; a UPI dispute's reply-by date is computed, never typed.
 *   • C5 (OB-146) — no request can be given longer than the published 15 days.
 *   • A23 — a dispatch carries no field that skips the e-way-bill gate.
 */

const read = (f: string): string => readFileSync(f, 'utf8');
const holders = (permission: string): string[] => ROLE_CATALOGUE.filter((r) => r.permissions.includes(permission)).map((r) => r.id).sort();

describe('R3 lane 2: no override exists', () => {
  it('A17: the ITC routes are exactly five, none takes a claim amount, and the port reads the review', () => {
    const store = new InMemoryEventStore();
    const routes = buildSurface({ signingKey: 'x'.repeat(48), boxHistorySealSecret: 'y'.repeat(64), migrationTargetKind: 'rehearsal', store, revocations: new TokenRevocationList(tokenRevocationAdapter({ store })) })
      .filter((r) => r.path.startsWith('/v1/finance/itc'));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /v1/finance/itc/:period', 'GET /v1/finance/itc/:period/claim', 'POST /v1/finance/itc/:period/lines/:lineId/action',
      'POST /v1/finance/itc/:period/reversals/:reversalId', 'POST /v1/finance/itc/:period/statement',
    ]);
    const src = read('services/finance/src/itc-store.ts');
    // The only amounts a body carries are a reversal's (readReversalAmounts) — never a claim.
    expect(src.match(/b\['(igst|cgst|sgst|cess)Minor'\]/g)).toBeNull();
    expect(src).toMatch(/itc_action_names_a_person/);
    expect(src).toMatch(/if \(action === 'accept' && !mayAccept\(line\)\)/);
    expect(read('services/api/src/r3-tax-pay-adapters.ts')).toMatch(/makeItcForPeriod\(\(tenantId, period\) => loadItcReview\(deps, tenantId, period\)\)/);
  });

  it('A24: only the CA fills the TDS list and only the owner switches it; the list cannot switch itself', () => {
    expect(holders('finance.tds.configure')).toEqual(['chartered_accountant']);
    expect(holders('finance.tds.switch')).toEqual(['owner']);
    expect(read('services/finance/src/tds-store.ts')).toMatch(/if \(b\['enabled'\] !== undefined\) \{\s*throw apiError\(400, \{ code: 'tds_config_cannot_switch'/);
  });

  it('A24: a payee flagged TDS-applicable with no section is never paid gross — the refusal comes before the approval is spent', () => {
    const src = read('services/purchase/src/supplier-master.ts');
    const refusal = src.indexOf("if (tds?.outcome === 'refused')");
    const spend = src.indexOf('await opened.spend();', src.indexOf("path: '/v1/purchase/suppliers/:supplierId/payments/:paymentId'"));
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(spend);
  });

  it('C14: a name in the body is not a tender exception — only an approval the second person gave', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-desk', 'store_manager');
    await h.provisionRole(T, 'u-sup', 'store_manager');
    expect((await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: T, idempotencyKey: 'bank', body: {
      saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-10', committedAt: '2026-10-10T10:00:00.000Z', totalMinor: 5_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }], tenders: [{ kind: 'card', amountMinor: 5_000, ref: 'tok_synthetic' }],
    } })).status).toBe(202);
    const apr = await h.request({ method: 'POST', path: '/v1/pos/refund-approvals', userId: 'u-sup', tenantId: T, idempotencyKey: 'apr', body: { kind: 'refund', saleId: 'S1', valueMinor: 5_000, requestedBy: 'u-desk', reason: 'synthetic' } });
    const res = await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-desk', tenantId: T, idempotencyKey: 'ret', body: {
      returnId: 'RT1', reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }], refundMinor: 5_000, refundTender: 'cash',
      approvalId: (apr.body as { approvalId: string }).approvalId, tenderExceptionApprovedBy: 'u-sup', tenderExceptionReason: 'typed, not given',
    } });
    expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([422, 'refund_not_to_source']);
    expect(read('services/pos/src/returns.ts')).toMatch(/const given = await take\(exceptionId, 'tender_exception'\);/);
  });

  it('C14: a UPI dispute\'s reply-by date is computed from the day it was received — a typed date is not used', () => {
    expect(read('packages/payment-disputes/src/disputes.ts')).toMatch(/if \(input\.instrument === 'upi'\) return \{ respondBy: addDays\(input\.receivedOn, UPI_DISPUTE_RESPONSE_DAYS\) \};/);
  });

  it('C5: no request may be given longer than the published 15 days', () => {
    expect(read('services/customer/src/data-rights.ts')).toMatch(/if \(slaDays > PUBLISHED_RESPONSE_SLA_DAYS\) \{\s*throw apiError\(422, \{ code: 'sla_longer_than_published'/);
    expect(read('services/customer/src/privacy-self.ts')).not.toMatch(/\?\? 30/);
  });

  it('A23: the dispatch reads nothing from its body that could skip the gate; the gate is asked before anything moves', () => {
    const src = read('services/inventory/src/warehouse-transfers.ts');
    const route = src.slice(src.indexOf("path: '/v1/warehouse/transfers/:transferId/dispatch'"), src.indexOf("path: '/v1/warehouse/transfers/:transferId/receive'"));
    expect(route).toMatch(/const b = \(ctx\.body \?\? \{\}\) as \{ approvedBy\?: unknown; available\?: unknown \};/);
    expect(route.indexOf("if (ewb?.outcome === 'refused')")).toBeLessThan(route.indexOf('await deps.recordDispatched('));
  });
});
