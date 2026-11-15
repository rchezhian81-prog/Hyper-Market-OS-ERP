import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { backings, openDatabase, closeDatabase, caller, codeOf, type Res } from '../support/r4-lane1';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { assessShiftClose } from '../../packages/till/src/index';

/**
 * **CR-01 OI-13-A12 and OI-13-A14 (OB-763 B, owner 14 Nov 2026) — the two assistants the owner chose before go-live, on
 * the real API, in memory and on REAL PostgreSQL, with a cold restart.** Synthetic data only.
 *
 *   • Both START OFF: a run is refused until the owner switches the assistant on by name.
 *   • A12 reads a REAL three-way match — an order of 50 at ₹12.36, 48 received, a bill for 50 at ₹12.48, matched by the
 *     manager and held back — and explains it line by line (2 more billed than received; ₹0.12 a unit above the order),
 *     with the supplier query drafted and its evidence (the match, the bill, the order). It pays nothing, issues no debit
 *     note and moves nothing: the purchase records are exactly as they were. Its draft is never approved by an owner-set
 *     rule (it carries no act; it is not an auto-approve kind).
 *   • A14 reads a REAL till close ₹500 short (relayed by the store box) and the till's own sale of exactly ₹500 recorded
 *     as cash, and lists the likely causes — records, not people: the cashier is named nowhere in the draft. Once the
 *     manager signs the over/short off through the ordinary route, the till is no longer explained.
 *   • A person's "agree" commits nothing. Each assistant has its own switch (one stopped, the other runs), its own spend
 *     ceiling, and the shop-wide kill switch stops both. After a cold restart the drafts are still on the register.
 */

beforeAll(openDatabase);
afterAll(closeDatabase);

interface Draft {
  readonly proposalId: string; readonly agent: string; readonly summary: string; readonly wouldRequire: string; readonly committed: boolean;
  readonly evidence: readonly { source: string; reference: string; summary: string }[];
  readonly reasons?: readonly { code: string; values: Record<string, string | number>; sentence: string; recordRef?: string }[];
  readonly draftText?: string; readonly act?: unknown; readonly confidence?: { band: string };
}
interface RunBody { readonly proposals: readonly Draft[]; readonly committedAnything: boolean; readonly costMinor: number; readonly calledAModel: boolean; readonly ruleDecisions: readonly { proposalId: string; outcome: string }[] }

const today = new Date().toISOString().slice(0, 10);

describe.each(backings())('A12 explains a supplier bill and A14 a till over/short, and neither commits anything — on $name (CR-01 OI-13)', ({ harness, restart }) => {
  it('start off · explain from the real records · evidence · agree commits nothing · own switch · kill switch · restart', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await approvedSuppliers(h, T, 'sup-demo-foods');
    await deliveryPlaces(h, T, 'store-1');
    const { req, ok } = caller(() => h, T);
    const put = (path: string, body: unknown): Promise<Res> => h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    const run = (agent: 'A12' | 'A14'): Promise<Res> => req('POST', `/v1/ai/agents/${agent}/runs`, {});

    // ── A real bill that does not match: ordered 50 at ₹12.36, received 48, billed 50 at ₹12.48 ──────────────────────
    await ok(req('POST', '/v1/purchase/orders/po-demo-1', { supplierId: 'sup-demo-foods', deliverToLocationId: 'store-1', lines: [{ productId: 'p-oil', orderedQty: 50, unitCost: { minor: 1_236, currency: 'INR' } }] }, 'u-buyer'), 'order');
    await ok(req('POST', '/v1/purchase/orders/po-demo-1/approval', { reason: 'synthetic order' }), 'issue');
    await ok(req('POST', '/v1/inventory/goods-receipt/grn-demo-1', {
      warehouseId: 'store-1', receivedOnDate: today, currency: 'INR', poId: 'po-demo-1',
      lines: [{ lineId: 'L1', productId: 'p-oil', orderedMinor: 50, countedMinor: 48, uom: 'ea', unitCost: { minor: 1_236, currency: 'INR' }, condition: 'good' }],
    }), 'receive 48');
    await ok(req('POST', '/v1/purchase/invoices/INV-DF-101/capture', { supplierId: 'sup-demo-foods', poId: 'po-demo-1', declaredTotalMinor: 62_400, lines: [{ productId: 'p-oil', quantity: 50, unitPriceMinor: 1_248, lineTotalMinor: 62_400 }] }, 'u-buyer'), 'capture');
    const match = (await ok(req('POST', '/v1/purchase/invoices/INV-DF-101/match', {}, 'u-mgr'), 'match')).body as { blocked: boolean; withheldMinor: number };
    expect(match.blocked).toBe(true);

    // ── A real till close ₹500 short, relayed by the store box, and the till's own ₹500 cash sale ───────────────────────
    const figures = { openingFloatMinor: 50_000, cashSalesMinor: 1_000_000, pickupsMinor: 500_000, cashRefundsMinor: 0, countedCashMinor: 500_000, toleranceMinor: 500 };
    const d = assessShiftClose({ ...figures, reasonCode: 'short' });
    const { countedCashMinor, ...rest } = figures;
    await ok(req('POST', '/v1/shifts/SH-DEMO-1/close/synced', {
      ...rest, tillId: 'T1', laneId: 'T1', cashierId: 'cashier-demo-7', tradingDay: today, reasonCode: 'short',
      openedAt: `${today}T03:00:00.000Z`, closedAt: `${today}T15:00:00.000Z`,
      countedMinor: countedCashMinor, expectedMinor: d.expectedMinor, varianceMinor: d.varianceMinor, exceptionRaised: d.exceptionRaised,
    }), 'close short');
    expect(d.varianceMinor).toBe(-50_000);
    // The sale as the store box relays it onto the sales ledger (the relay itself is proved by the sale-intake suites).
    await h.store.append(T, STREAM.sales, makeEvent({
      id: `sale-${T}-demo-r1001`, type: 'SaleCommitted', occurredAt: `${today}T09:00:00.000Z`, idempotencyKey: `sale-${T}-demo-r1001`, source: 'test/synthetic-sale',
      payload: { saleId: 'sale-demo-r1001', receiptNumber: 'R-1001', laneId: 'T1', cashierId: 'cashier-demo-7', tradingDay: today, committedAt: `${today}T09:00:00.000Z`, totalMinor: 50_000, lines: [], tenders: [{ kind: 'cash', amountMinor: 50_000 }] },
    }));

    // ── Both START OFF: refused until switched on by name ─────────────────────────────────────────────────────────────
    expect((await put('/v1/ai/kill-switch', { on: false, reason: 'synthetic test of A12 and A14' })).status).toBe(200);
    expect((await put('/v1/ai/budget', { capMinor: 100_000, periodEnds: '2099-01-01T00:00:00.000Z' })).status).toBe(200);
    for (const agent of ['A12', 'A14'] as const) {
      const off = await run(agent);
      expect(off.status, agent).toBe(429);
      expect(codeOf(off)).toBe('agent_not_permitted_here');
    }
    expect((await put('/v1/ai/agents/enabled', { expected: [], agents: ['A12', 'A14'] })).status).toBe(200);
    // Each its own spend ceiling (₹0: it runs on rules and calls no model).
    for (const agent of ['A12', 'A14']) expect((await put(`/v1/ai/agents/${agent}/budget`, { ceilingMinor: 0 })).status, agent).toBe(200);

    const purchaseBefore = (await h.store.readStream(T, STREAM.purchase)).length;
    const shiftsBefore = (await h.store.readStream(T, streamName(STREAM.cash, 'shifts'))).length;

    // ── A12: explains the real match, line and figure, with its evidence and the supplier query drafted ───────────────
    const a12 = (await ok(run('A12'), 'run A12')).body as RunBody;
    expect(a12).toMatchObject({ committedAnything: false, costMinor: 0, calledAModel: false });
    const bill = a12.proposals.find((p) => p.proposalId.startsWith('a12-bill:INV-DF-101:'));
    expect(bill, JSON.stringify(a12)).toBeDefined();
    expect(bill!.committed).toBe(false);
    expect(bill!.act).toBeUndefined();
    expect(bill!.reasons!.map((r) => r.code)).toEqual(['billed_more_than_received', 'price_higher_than_order']);
    expect(bill!.reasons![0]!.sentence).toBe('p-oil: the bill says 50, we received 48 — 2 more billed than received.');
    expect(bill!.reasons![1]!.sentence).toBe('p-oil: the bill price is ₹0.12 a unit higher than the order.');
    expect(bill!.summary).toContain(`held back`);
    expect(bill!.draftText).toContain('Please send a corrected bill or a credit note');
    expect(bill!.evidence.map((e) => e.source)).toEqual(['three-way match verdict', 'supplier bill', 'purchase order and goods received']);
    expect(bill!.wouldRequire).toMatch(/accounts person/);
    // Never approved by an owner-set rule: it is not an auto-approve kind.
    expect(a12.ruleDecisions.filter((r) => r.outcome === 'approved')).toEqual([]);

    // ── A14: lists the likely causes from the till's records — never a person ────────────────────────────────────────
    const a14 = (await ok(run('A14'), 'run A14')).body as RunBody;
    const till = a14.proposals.find((p) => p.proposalId === 'a14-till:SH-DEMO-1');
    expect(till, JSON.stringify(a14)).toBeDefined();
    expect(till!.act).toBeUndefined();
    expect(till!.reasons!.map((r) => r.code)).toEqual(['cash_sale_may_be_upi_or_card', 'round_sum_short', 'count_not_broken_down']);
    expect(till!.reasons![0]!.recordRef).toBe('R-1001');
    expect(till!.summary).toBe(`Till T1 on ${today} is ₹500.00 short. 2 likely cause(s) from the records — a manager checks them and decides.`);
    expect(JSON.stringify(till)).not.toContain('cashier-demo-7');
    expect(till!.wouldRequire).toBe('POST /v1/shifts/SH-DEMO-1/over-short/review by the manager (never the person who counted the drawer)');

    // ── Neither moved anything: the purchase records and the till closes are exactly as they were ───────────────────────
    expect((await h.store.readStream(T, STREAM.purchase)).length).toBe(purchaseBefore);
    expect((await h.store.readStream(T, streamName(STREAM.cash, 'shifts'))).length).toBe(shiftsBefore);
    const stillHeld = (await ok(req('GET', '/v1/purchase/invoices/INV-DF-101'), 'bill')).body as { match?: { blocked: boolean } | null };
    if (stillHeld.match !== undefined && stillHeld.match !== null) expect(stillHeld.match.blocked).toBe(true);

    // ── A person agrees — a decision on record that commits nothing ──────────────────────────────────────────────────
    const agreed = await ok(req('POST', `/v1/ai/proposals/${encodeURIComponent(bill!.proposalId)}/outcome`, { decision: 'approved' }, 'u-mgr'), 'agree');
    expect((agreed.body as { outcome: { committedAnything: boolean } }).outcome.committedAnything).toBe(false);
    expect((await h.store.readStream(T, STREAM.purchase)).length).toBe(purchaseBefore);

    // ── Each its own switch: stop A12 alone, A14 still runs; the shop-wide switch stops both ──────────────────────────
    await ok(req('POST', '/v1/ai/kill-switches', { scope: 'single_agent', agentId: 'A12', reason: 'synthetic: stop the bill explainer only' }), 'stop A12');
    expect(codeOf(await run('A12'))).toBe('kill_switch_is_on');
    expect((await run('A14')).status).toBe(200);
    expect((await put('/v1/ai/kill-switch', { on: true, reason: 'synthetic: stop all AI' })).status).toBe(200);
    for (const agent of ['A12', 'A14'] as const) expect(codeOf(await run(agent)), agent).toBe('kill_switch_is_on');

    // ── A COLD RESTART: the drafts are on the register, with their reasons ───────────────────────────────────────────
    h = restart(h);
    const register = (await ok(req('GET', '/v1/ai/proposals'), 'register')).body as { proposals: (Draft & { outcome: { decision: string } | null })[] };
    const kept = register.proposals.find((p) => p.proposalId === bill!.proposalId);
    expect(kept?.reasons?.map((r) => r.code)).toEqual(['billed_more_than_received', 'price_higher_than_order']);
    expect(kept?.outcome?.decision).toBe('approved');
    expect(register.proposals.some((p) => p.proposalId === 'a14-till:SH-DEMO-1')).toBe(true);

    // ── Once the manager signs the over/short off the ordinary way, the till is no longer explained ──────────────────────
    expect((await put('/v1/ai/kill-switch', { on: false, reason: 'synthetic: resume' })).status).toBe(200);
    await ok(req('POST', '/v1/shifts/SH-DEMO-1/over-short/review', { disposition: 'tender_error', note: 'R-1001 was paid by UPI (synthetic)' }, 'u-mgr'), 'sign off');
    const after = (await ok(run('A14'), 'run A14 again')).body as RunBody;
    expect(after.proposals.some((p) => p.proposalId === 'a14-till:SH-DEMO-1')).toBe(false);
  });
});
