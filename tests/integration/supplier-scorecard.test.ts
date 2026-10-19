import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';

// M06-FR-03 · D-10: supplier scorecards + contract alerts on the live API. Since D-10 (R4) the scorecard is BUILT from the
// supplier's own purchase orders, goods receipts and matched invoices — the whole lifecycle is proved in
// tests/integration/a-scorecard-is-built-from-orders-receipts-and-invoices.test.ts. This file keeps the contract review
// (expiring / expired / UNAPPROVED, worst-first; an approver who gave it in their own session), proves the old typed
// delivery-outcome door is closed by name, and that a supplier with no evidence reads `not_rated`.
// Recording a contract is gated purchase.contract.manage; reads purchase.commitment.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INR = 'INR';
const money = (minor: number) => ({ minor, currency: INR });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Rating = { kind: string; bp?: number; because?: string };
interface CardShape {
  deliveries?: number;
  summary?: string;
  fillRate: Rating;
  onTimeInFull: Rating;
  leadTimeReliability: Rating;
  invoiceAccuracy: Rating;
  rejectionRate: Rating;
}
const cardOf = (res: { body: unknown }): CardShape =>
  ((res.body as { scorecard?: unknown }).scorecard ?? {}) as CardShape;

const receiptBody = (over: Record<string, unknown> = {}) => ({
  orderedOn: '2026-07-01', receivedOn: '2026-07-08',
  orderedQtyMinor: 100, receivedQtyMinor: 100,
  agreedValue: money(100_000), invoicedValue: money(100_000), ...over,
});

const recordReceipt = (h: ApiHarness, u: string, sup: string, po: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/suppliers/${sup}/receipts/${po}`, userId: u, tenantId: A, idempotencyKey: key, body });
const recordContract = (h: ApiHarness, u: string, cid: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: `/v1/purchase/contracts/${cid}`, userId: u, tenantId: A, idempotencyKey: key, body });
const scorecard = (h: ApiHarness, u: string, sup: string) =>
  h.request({ method: 'GET', path: `/v1/purchase/suppliers/${sup}/scorecard`, userId: u, tenantId: A });
const contractAlerts = (h: ApiHarness, u: string, onDate: string) =>
  h.request({ method: 'GET', path: '/v1/purchase/contracts/alerts', userId: u, tenantId: A, query: { onDate } });

const contract = (over: Record<string, unknown> = {}) =>
  ({ supplierId: 'sup-1', startsOn: '2026-01-01', endsOn: '2026-12-31', agreedLeadTimeDays: 7, ...over });
/** A contract as two people make it (ADR-0024): `u` records the terms and asks; `checker` approves them in their own session. */
const approvedContract = (h: ApiHarness, u: string, checker: string, cid: string, body: Record<string, unknown>, key: string) =>
  sentWithApproval(h, A, u, checker, { kind: 'purchase_contract', subjectRef: cid, pathIds: { contractId: cid } }, body, (b) => recordContract(h, u, cid, b, key));

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // record + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('supplier scorecards + contract alerts (M06-FR-03 · D-10)', () => {
  it('the typed delivery-outcome door is closed by name (D-10: no typed figures) — nothing it sends reaches the scorecard', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract(), 'kc');
    const typed = await recordReceipt(h, 'u-mgr', 'sup-1', 'po-1', receiptBody(), 'k1');
    expect(typed.status).toBe(410);
    expect(codeOf(typed)).toBe('typed_delivery_outcome_retired');
    const card = cardOf(await scorecard(h, 'u-owner', 'sup-1'));
    expect(card.deliveries).toBe(0);
    expect(card.fillRate).toEqual({ kind: 'not_rated', because: 'no delivery in the period' });
  });

  it('says "not rated" rather than flattering a supplier with no evidence', async () => {
    const h = await cast();
    const empty = cardOf(await scorecard(h, 'u-owner', 'sup-9'));
    for (const r of [empty.fillRate, empty.onTimeInFull, empty.leadTimeReliability, empty.invoiceAccuracy, empty.rejectionRate]) expect(r.kind).toBe('not_rated');
    expect(empty.summary).toContain('not the same as a good supplier');
  });

  it('surfaces expiring/expired/unapproved contracts worst-first', async () => {
    const h = await cast();
    // The store manager records the terms; the owner approves two of them in their own session; the third is unapproved.
    expect((await approvedContract(h, 'u-mgr', 'u-owner', 'far', contract({ endsOn: '2026-12-31' }), 'k1')).status).toBe(201);
    expect((await approvedContract(h, 'u-mgr', 'u-owner', 'soon', contract({ endsOn: '2026-09-01' }), 'k2')).status).toBe(201);
    await recordContract(h, 'u-mgr', 'unappr', contract({ endsOn: '2026-10-01' }), 'k3');

    const res = await contractAlerts(h, 'u-owner', '2026-08-04');
    const body = res.body as { alerts: { contractId: string; finding: string }[]; actionNeededCount: number };
    expect(body.alerts.map((a) => a.contractId)).toEqual(['soon', 'unappr', 'far']);
    expect(body.alerts.find((a) => a.contractId === 'soon')?.finding).toBe('expiring_soon');
    expect(body.alerts.find((a) => a.contractId === 'unappr')?.finding).toBe('unapproved');
    expect(body.actionNeededCount).toBe(2);
  });

  it('a contract\'s approver approves it in their own session: a typed name, the recorder, or someone who may not approve suppliers is refused (2b-vi-c-1, PA-03)', async () => {
    const h = await cast();
    // THE BYPASS, CLOSED: any typed name used to clear the `unapproved` alert.
    expect(codeOf(await recordContract(h, 'u-mgr', 'c-typed', contract({ approvedBy: 'u-owner' }), 'k1'))).toBe('approver_named_without_approval');
    expect(codeOf(await approvedContract(h, 'u-owner', 'u-owner', 'c-self', contract(), 'k2'))).toBe('self_approval');
    expect((await approvedContract(h, 'u-owner', 'u-mgr', 'c-mgr', contract(), 'k3')).status).toBe(403);
    // None of them landed: no contract is on file to alert about.
    const alerts = (await contractAlerts(h, 'u-owner', '2026-08-04')).body as { alerts: { contractId: string }[] };
    expect(alerts.alerts.map((a) => a.contractId)).toEqual([]);
    // The owner's approval is recorded as the contract's approver.
    const ok = await approvedContract(h, 'u-mgr', 'u-owner', 'c-ok', contract(), 'k4');
    expect((ok.body as { contract: { approvedBy?: string } }).contract.approvedBy).toBe('u-owner');
  });

  it('gates recording and reading, and refuses a malformed contract', async () => {
    const h = await cast();
    expect((await recordReceipt(h, 'u-cash', 'sup-1', 'po-1', receiptBody(), 'k1')).status).toBe(403);
    expect((await recordContract(h, 'u-cash', 'c-1', contract(), 'k2')).status).toBe(403);
    expect((await scorecard(h, 'u-cash', 'sup-1')).status).toBe(403);
    expect(codeOf(await recordContract(h, 'u-mgr', 'c-bad', { supplierId: 'sup-1' }, 'k3'))).toBe('not_readable_as_a_contract');
    expect(codeOf(await recordContract(h, 'u-mgr', 'c-back', contract({ startsOn: '2026-12-31', endsOn: '2026-01-01' }), 'k4'))).toBe('contract_ends_before_it_starts');
  });

  it('survives a restart: the contracts are rebuilt from the event store', async () => {
    const h = await cast();
    await recordContract(h, 'u-owner', 'c-1', contract({ endsOn: '2026-09-01' }), 'kc');
    const restarted = apiHarness({ store: h.store });
    const body = (await contractAlerts(restarted, 'u-owner', '2026-08-04')).body as { alerts: { contractId: string }[] };
    expect(body.alerts.map((a) => a.contractId)).toEqual(['c-1']);
  });
});
