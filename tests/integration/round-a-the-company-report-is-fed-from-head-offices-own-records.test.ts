import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { approvedRequestId } from '../support/approval-request';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **Screen gap audit (31 Oct 2026) Round A — the Company report is fed from head office's own records, and never says
 * "every branch reported" when none did (M01 / M29 / D13 · P-08), on the real API, in memory and on PostgreSQL, with a
 * cold restart.**
 *
 * Before: nothing produced a branch contribution and the roll-up expected only branches a feed had POSTed, so for this
 * one-store business it expected none, found none missing, called itself reconciled — and the page said "No branch has
 * reported" and "Every expected branch has reported" at once. Now, on the production route `GET /v1/consolidation`:
 *   • a company with NO open branch expects nothing and does NOT reconcile ("no branch is expected");
 *   • once its branch is activated (owner-approved), the branch is EXPECTED: before it sends a sale it is named MISSING;
 *   • the sales its store sent head office are the branch's month (gross and bills), dated by the shop's trading day — a
 *     sale of another month is not counted — and the report reconciles;
 *   • the refunds head office holds are the branch's "returns" month, by the bill they refund;
 *   • a contribution a branch feed POSTs still wins for its (branch, month, family).
 * Synthetic data only.
 */
const backings = r3OpsBackings();
const PERIOD = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => { const d = new Date(`${PERIOD}-01T00:00:00.000Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
const GSTIN = '33AABCS1429B1Z1';

interface Report { expectedBranches: string[]; reportedBranches: string[]; missingBranches: string[]; reconciles: boolean; measures: Record<string, number>; detail: string; contributors: { branchId: string; measures: Record<string, number> }[] }

describe.each(backings)('Round A — the Company report from head office\'s own records — on $name', ({ harness, restart }) => {
  it('no branch → nothing expected, not reconciled · the branch expected and missing → its sales and refunds → a posted feed still wins', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-acct', 'accountant');
    const { req, ok } = tenantClient(() => h, T);
    const report = async (family: 'sales' | 'returns'): Promise<Report> =>
      (await ok(req('GET', '/v1/consolidation', undefined, 'u-owner', { node: 'SRE', family, period: PERIOD }), `report ${family}`)).body as Report;

    // ── the company and its store, as drafts: no open branch yet ──
    await ok(req('POST', `/v1/org/gst-registrations/${GSTIN}`, { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }), 'gst registration');
    await ok(req('POST', '/v1/org/nodes/SRE', { kind: 'company', name: 'SRE', parentId: null }), 'company');
    await ok(req('POST', '/v1/org/nodes/SRE-MAIN', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: GSTIN }), 'branch');
    const empty = await report('sales');
    expect(empty.expectedBranches).toEqual([]);
    expect(empty.reconciles).toBe(false); // nothing to reconcile is never "complete"
    expect(empty.detail).toMatch(/no branch is expected/);

    // ── the owner approves opening the company and the store (the administrator asks, M01-FR-01) ──
    for (const nodeId of ['SRE', 'SRE-MAIN']) {
      const approvalId = await approvedRequestId(h, T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: nodeId, details: { nodeId, action: 'activate' }, valueMinor: null });
      await ok(req('POST', `/v1/org/nodes/${nodeId}/activation`, { approvalId }, 'u-it'), `activate ${nodeId}`);
    }
    const silent = await report('sales');
    expect(silent.expectedBranches).toEqual(['SRE-MAIN']);
    expect(silent.missingBranches).toEqual(['SRE-MAIN']); // named missing — never "every branch reported"
    expect(silent.reconciles).toBe(false);

    // ── the store sends head office two sales this month and one last month ──
    const sale = (saleId: string, day: string, totalMinor: number) => ok(req('POST', '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', locationId: 'SRE-MAIN', tradingDay: day, committedAt: `${day}T06:00:00.000Z`,
      totalMinor, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'OIL', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor, taxRateBps: 500 }],
      tenders: [{ kind: 'cash', amountMinor: totalMinor }],
    }), saleId);
    await sale('S1', TODAY, 10_500);
    await sale('S2', TODAY, 4_200);
    await sale('S0', LAST_MONTH, 99_900);
    // A refund of S1 head office holds (as the till's synced refund lands it on the returns register).
    await h.store.append(T, STREAM.returns, makeEvent({
      id: 'ret-RT1', type: 'ReturnRecorded', occurredAt: `${TODAY}T07:00:00.000Z`, idempotencyKey: `ret-${T}-RT1`, source: 'test/synthetic',
      payload: { returnId: 'RT1', number: 'RT-1', originalSaleId: 'S1', processedBy: 'u-owner', processedAt: `${TODAY}T07:00:00.000Z`, reasonCode: 'damaged', refundMinor: 2_100, refundTender: 'cash', refundStatus: 'refunded', lines: [] },
    }));

    h = restart(h); // ── COLD RESTART ──

    const sales = await report('sales');
    expect(sales.reportedBranches).toEqual(['SRE-MAIN']);
    expect(sales.missingBranches).toEqual([]);
    expect(sales.reconciles).toBe(true);
    expect(sales.measures).toEqual({ grossMinor: 14_700, count: 2 }); // last month's ₹999 is not this month's
    const returns = await report('returns');
    expect(returns.measures).toEqual({ refundMinor: 2_100, count: 1 });
    expect(returns.reconciles).toBe(true);

    // ── a branch feed's posted month wins over head office's own reading for that (branch, month, family) ──
    await ok(req('POST', '/v1/consolidation/contributions', { branchId: 'SRE-MAIN', period: PERIOD, family: 'sales', measures: { grossMinor: 1, count: 1 }, lastRefreshAt: new Date().toISOString(), revision: 1 }), 'posted');
    expect((await report('sales')).measures).toEqual({ grossMinor: 1, count: 1 });
    expect((await report('returns')).measures).toEqual({ refundMinor: 2_100, count: 1 }); // the other family still head office's

    // ── the export is the same roll-up ──
    const exported = (await ok(req('POST', '/v1/consolidation/export', { node: 'SRE', family: 'returns', period: PERIOD }), 'export')).body as { rows: number; csv: string };
    expect(exported.rows).toBe(1);
    expect(exported.csv).toContain('SRE-MAIN');
  }, 120_000);
});
