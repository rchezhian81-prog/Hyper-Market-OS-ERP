import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Returns reconcile on sync (M13-FR-01 offline-first · §31 · §28, API-05, Slice 1). A receipted return works
// with the network cable out and RECONCILES ON SYNC. The offline lane commits the refund against its own log
// (money leaves the drawer) and queues it; the sync agent later relays it to POST /v1/sales/:saleId/returns/
// synced under the store's sync token. Unlike the desk guard (which refuses before money moves), this route
// TRUSTS the operator identity captured at the lane and NEVER rejects a refund that happened — it records the
// return into the register (so the at-most-once guard and the money cap finally see it) and, for a §28 breach
// (a threshold-worthy refund with no approver, a self-approval, or an approver who lacks the authority),
// records a VISIBLE governance exception (record-and-flag, hard rule #10) rather than a rejection.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-08-07T10:00:00.000Z';

const sale = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});
const bank = (h: ApiHarness, u: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: 'bank-S1', body: sale() });

const line = (qty = 1) => ({ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' as const });
// A synced refund as the sync agent relays it: the OPERATOR identity is in the body (captured at the lane).
const synced = (over: Record<string, unknown> = {}) => ({
  returnId: 'RT1', number: 'RT1', processedBy: 'u-lanecashier', reasonCode: 'customer_changed_mind',
  refundMinor: 5000, refundTender: 'cash', lines: [line(1)], processedAt: AT, ...over,
});
const syncRet = (h: ApiHarness, u: string, saleId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns/synced`, userId: u, tenantId: A, idempotencyKey: `sync-${body['returnId']}`, body });
const exceptions = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: u, tenantId: A });
const returnable = (h: ApiHarness, u: string, saleId: string) =>
  h.request({ method: 'GET', path: `/v1/sales/${saleId}/returnable`, userId: u, tenantId: A });
const setThreshold = (h: ApiHarness, u: string, thresholdMinor: number, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/refund-threshold', userId: u, tenantId: A, idempotencyKey: key, body: { thresholdMinor } });

interface Flags { returnId?: string; reconciled?: boolean; flags?: string[] }
interface Exc { count: number; exceptions: { returnId: string; processedBy: string; approvedBy?: string; refundMinor: number; governanceFlags: string[] }[] }
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                     // pos.return.sync + pos.return.approve + lp.case.read
  await h.provisionRole(A, 'u-mgr', 'store_manager');  // pos.return.approve (a genuine refund approver)
  await h.provisionRole(A, 'u-cash', 'cashier');       // pos.return.sync, but NOT approve, NOT lp.case.read
  await h.provisionRole(A, 'u-acct', 'accountant');    // holds NO pos.return.sync
  return h;
}

describe('returns reconcile on sync — record-and-flag, never reject (M13-FR-01, §28)', () => {
  it('reconciles a clean synced refund with a genuinely-authorised approver — recorded, no flags', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    const res = await syncRet(h, 'u-owner', 'S1', synced({ approvedBy: 'u-mgr' }));
    expect(res.status).toBe(202);
    expect(res.body as Flags).toMatchObject({ returnId: 'RT1', reconciled: true, flags: [] });

    // It reconciled INTO the register: one unit is now off the returnable, ₹50 off the refundable.
    const r = (await returnable(h, 'u-owner', 'S1')).body as { returnable: { productId: string; returnableMinor: number }[]; refundableMinor: number };
    expect(r.returnable.find((l) => l.productId === 'P1')?.returnableMinor).toBe(2); // 3 sold − 1 back
    expect(r.refundableMinor).toBe(10000);
    // A clean refund is not a governance exception.
    expect((await exceptions(h, 'u-owner')).body as Exc).toMatchObject({ count: 0 });
  });

  it('records-and-flags a synced refund whose approver lacks authority — 202, never rejected', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    // The lane relayed an approver who does not hold pos.return.approve (an unprovisioned name) — the money
    // already left the drawer, so this is recorded, not refused, and flagged for a person to work.
    const res = await syncRet(h, 'u-owner', 'S1', synced({ approvedBy: 'u-nobody' }));
    expect(res.status).toBe(202);
    expect((res.body as Flags).flags).toEqual(['approver_lacks_authority']);

    // Recorded (the refund happened): the register reflects it.
    expect(((await returnable(h, 'u-owner', 'S1')).body as { refundableMinor: number }).refundableMinor).toBe(10000);
    // Surfaced as a visible governance exception.
    const exc = (await exceptions(h, 'u-owner')).body as Exc;
    expect(exc.count).toBe(1);
    expect(exc.exceptions[0]).toMatchObject({ returnId: 'RT1', processedBy: 'u-lanecashier', approvedBy: 'u-nobody', governanceFlags: ['approver_lacks_authority'] });
  });

  it('flags a material synced refund given with no approver, and one self-approved (§28)', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    expect((await syncRet(h, 'u-owner', 'S1', synced({ returnId: 'RN', approvedBy: undefined })) ).body as Flags).toMatchObject({ flags: ['given_without_approval'] });
    // The processor cannot approve their own refund.
    expect((await syncRet(h, 'u-owner', 'S1', synced({ returnId: 'RS', processedBy: 'u-x', approvedBy: 'u-x' }))).body as Flags).toMatchObject({ flags: ['approved_by_the_processor'] });

    const exc = (await exceptions(h, 'u-owner')).body as Exc;
    expect(exc.count).toBe(2);
  });

  it('does not flag an immaterial synced refund (below the tenant threshold)', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    // Owner raises the threshold to ₹100 — a ₹50 refund is now immaterial and needs no approver.
    expect((await setThreshold(h, 'u-owner', 10000, 't-1')).status).toBe(200);

    const res = await syncRet(h, 'u-owner', 'S1', synced({ refundMinor: 5000, approvedBy: undefined }));
    expect(res.status).toBe(202);
    expect((res.body as Flags).flags).toEqual([]);
    expect((await exceptions(h, 'u-owner')).body as Exc).toMatchObject({ count: 0 });
  });

  it('is idempotent on the return id — a re-synced refund reconciles once, not twice', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    expect((await syncRet(h, 'u-owner', 'S1', synced({ returnId: 'RX', lines: [line(2)], refundMinor: 10000, approvedBy: 'u-mgr' }))).status).toBe(202);
    expect((await syncRet(h, 'u-owner', 'S1', synced({ returnId: 'RX', lines: [line(2)], refundMinor: 10000, approvedBy: 'u-mgr' }))).status).toBe(202);
    // If the retry had counted twice, 4 of 3 units would be returned; instead 1 is still returnable.
    expect(((await returnable(h, 'u-owner', 'S1')).body as { returnable: { productId: string; returnableMinor: number }[] }).returnable.find((l) => l.productId === 'P1')?.returnableMinor).toBe(1);
  });

  it('is gated: only a holder of pos.return.sync may relay, and only lp.case.read may read the exceptions', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    // An accountant holds no pos.return.sync → cannot relay a synced refund.
    expect((await syncRet(h, 'u-acct', 'S1', synced({ returnId: 'RG', approvedBy: 'u-mgr' }))).status).toBe(403);
    // A cashier can relay (the lane syncs), but cannot read the governance/loss surface (no lp.case.read).
    expect((await syncRet(h, 'u-cash', 'S1', synced({ returnId: 'RC', approvedBy: 'u-nobody' }))).status).toBe(202);
    expect((await exceptions(h, 'u-cash')).status).toBe(403);
    // A malformed synced payload is a 400 — but it is kept at the lane, not dropped.
    expect(codeOf(await syncRet(h, 'u-owner', 'S1', { returnId: 'RB', processedBy: 'u-x' }))).toBe('not_readable_as_a_synced_return');
  });
});
