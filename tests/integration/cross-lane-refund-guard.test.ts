import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **GAP-REFUND-XLANE-01 — global at-most-once for cross-lane refunds, at the cloud.**
 *
 * A lane enforces at-most-once for the sales it rang (RR-F04). A refund against a bill rung on
 * ANOTHER lane is invisible to it — only the cloud sees every lane's sales and returns at once. The
 * synced-return route never rejects (the money already left the lane, hard rule #10), so a cross-lane
 * over-return must be **recorded and flagged as a visible exception**, the same way a §28 breach is —
 * not silently accepted. These drive the real API surface through the harness.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-12T10:00:00.000Z';

const sale = (units: number, totalMinor: number) => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-09-12', committedAt: AT, totalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: units, uom: 'each', unitPriceMinor: Math.round(totalMinor / units), lineTotalMinor: totalMinor }],
  tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});
const bank = (h: ApiHarness, units: number, totalMinor: number) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: 'bank-S1', body: sale(units, totalMinor) });
const line = (qty: number) => ({ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' as const });
const syncRet = (h: ApiHarness, id: string, over: Record<string, unknown> = {}) =>
  h.request({
    method: 'POST', path: '/v1/sales/S1/returns/synced', userId: 'u-owner', tenantId: A, idempotencyKey: `sync-${id}`,
    body: { returnId: id, number: id, processedBy: 'u-lanecashier', approvedBy: 'u-mgr', reasonCode: 'damaged', refundMinor: 5000, refundTender: 'cash', lines: [line(1)], processedAt: AT, ...over },
  });
const exceptions = (h: ApiHarness) => h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: 'u-owner', tenantId: A });

interface Flags { flags?: string[] }
interface Exc { count: number; exceptions: { returnId: string; governanceFlags: string[] }[] }

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                    // pos.return.sync + approve + lp.case.read
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // a genuine refund approver
  return h;
}

describe('GAP-REFUND-XLANE-01 — the cloud flags a cross-lane over-return', () => {
  it('legitimate cross-lane partials within entitlement are NOT flagged', async () => {
    const h = await cast();
    await bank(h, 3, 15000);                          // 3 units, ₹150
    // Two different lanes each refund one unit — 2 of 3, within entitlement.
    expect((await syncRet(h, 'RT-laneA')).status).toBe(202);
    expect(((await syncRet(h, 'RT-laneB')).body as Flags).flags).toEqual([]);
    expect((await exceptions(h)).body as Exc).toMatchObject({ count: 0 });
  });

  it('a second cross-lane refund of the same unit is recorded AND flagged as an over-return', async () => {
    const h = await cast();
    await bank(h, 1, 5000);                           // 1 unit, ₹50
    expect(((await syncRet(h, 'RT-laneA')).body as Flags).flags).toEqual([]);
    const second = await syncRet(h, 'RT-laneB');       // the same unit, a different lane's id
    expect(second.status).toBe(202);                  // never rejected — the money already left the lane
    expect((second.body as Flags).flags).toContain('over_returned_goods');
    expect((second.body as Flags).flags).toContain('refund_exceeds_paid');
    // Surfaced on the loss report a person works.
    const exc = (await exceptions(h)).body as Exc;
    expect(exc.count).toBe(1);
    expect(exc.exceptions[0]?.returnId).toBe('RT-laneB');
    expect(exc.exceptions[0]?.governanceFlags).toContain('over_returned_goods');
  });

  it('flags an over-refund of MONEY even when goods are within entitlement', async () => {
    const h = await cast();
    await bank(h, 2, 10000);                          // 2 units, ₹100
    // Each lane refunds one unit (goods 2 of 2 — fine) but ₹80 each (₹160 > ₹100 paid).
    expect(((await syncRet(h, 'RM-A', { refundMinor: 8000 })).body as Flags).flags).toEqual([]);
    const second = await syncRet(h, 'RM-B', { refundMinor: 8000 });
    expect((second.body as Flags).flags).toContain('refund_exceeds_paid');
    expect((second.body as Flags).flags).not.toContain('over_returned_goods'); // goods are within entitlement
  });

  it('is idempotent on the return id — a re-synced over-return flags once, not twice', async () => {
    const h = await cast();
    await bank(h, 1, 5000);
    await syncRet(h, 'RT-laneA');
    expect(((await syncRet(h, 'RT-laneB')).body as Flags).flags).toContain('over_returned_goods');
    expect(((await syncRet(h, 'RT-laneB')).body as Flags).flags).toContain('over_returned_goods'); // re-sync
    expect(((await exceptions(h)).body as Exc).count).toBe(1); // still one exception, not two
  });

  it('a synced refund against a sale the cloud has not banked is recorded without a cross-lane flag', async () => {
    const h = await cast();
    // No bank() — the sale is unknown to the cloud (e.g. not synced yet). Cannot be entitlement-checked
    // here; it must still be recorded (never dropped), just without a cross-lane finding.
    const res = await syncRet(h, 'RT-orphan');
    expect(res.status).toBe(202);
    expect((res.body as Flags).flags).toEqual([]);
  });

  it('an over-return AND a §28 breach are both flagged together', async () => {
    const h = await cast();
    await bank(h, 1, 5000);
    await syncRet(h, 'RT-laneA');
    // Second lane, over-returns AND names an approver who lacks authority.
    const second = await syncRet(h, 'RT-laneB', { approvedBy: 'u-nobody' });
    const flags = (second.body as Flags).flags ?? [];
    expect(flags).toContain('over_returned_goods');
    expect(flags).toContain('approver_lacks_authority');
  });
});
