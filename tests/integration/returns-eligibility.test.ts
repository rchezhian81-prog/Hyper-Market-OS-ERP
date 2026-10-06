import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { giveRefundApproval, withApprovals } from '../support/refund-approval';

// Return eligibility end to end through the real API (M13-FR-02, API-05, §28). A shop takes goods back
// only within its return WINDOW. This proves the wired desk guard + the owner's window config against
// the real pipeline and real per-tenant RBAC:
//   • the window is the OWNER's policy — enforced once set; until then a return is not age-restricted
//     (the money guards still apply) and the desk read says so plainly (P-08);
//   • inside the window a return proceeds; past it it is BLOCKED unless a supervisor authorises the
//     exception (§28) — a different person who genuinely holds refund-approval authority;
//   • a return dated before its own sale is a data fault no override can clear;
//   • only the owner can set the window.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOLD_AT = '2026-08-07T10:00:00.000Z';

// A bill: 3 units of P1 at ₹50, paid ₹150 in cash, committed 7 Aug.
const sale = () => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: SOLD_AT, totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
});

const bank = (h: ApiHarness, userId: string) =>
  h.request({ method: 'POST', path: '/v1/sales', userId, tenantId: A, idempotencyKey: 'bank-S1', body: sale() });

// A return of 1 unit of P1, resold, ₹50 refunded. The refund threshold defaults to 0, so every refund is
// material and needs a §28 approver — `u-mgr` (a store_manager holding pos.return.approve, ≠ the caller).
const line = () => ({ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' as const });
const req = (over: Record<string, unknown>) => ({
  returnId: 'RT1', reasonCode: 'customer_changed_mind', lines: [line()],
  refundMinor: 5000, refundTender: 'cash', approvedBy: 'u-mgr', ...over,
});

// A named approver becomes the approval that person gives in their own session (ADR-0022); `retNamed` sends the
// names as written — the audit's PF-02 reproduction.
const retNamed = (h: ApiHarness, userId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId, tenantId: A, idempotencyKey: `ret-${body['returnId']}`, body });
const ret = async (h: ApiHarness, userId: string, body: Record<string, unknown>) =>
  retNamed(h, userId, await withApprovals(h, A, userId, 'S1', body));

const getWindow = (h: ApiHarness, userId: string) =>
  h.request({ method: 'GET', path: '/v1/pos/return-window', userId, tenantId: A });
const setWindow = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/pos/return-window', userId, tenantId: A, idempotencyKey: key, body });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds pos.return.approve
  await h.provisionRole(A, 'u-cash', 'cashier');      // holds pos.return.record, NOT approve/window.set
  return h;
}

describe('a return is accepted only within the shop\'s window (M13-FR-02, API-05)', () => {
  it('until the owner sets a window, a return is not age-restricted, and the desk says so (P-08)', async () => {
    const h = await cast();
    await bank(h, 'u-owner');

    const w = await getWindow(h, 'u-owner');
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ returnWindowDays: null, isSet: false });

    // A return five months after the sale, with no window set → not blocked on age (money guards still apply).
    const old = await ret(h, 'u-owner', req({ returnId: 'ROLD', processedAt: '2027-01-07T10:00:00.000Z' }));
    expect(old.status).toBe(201);
  });

  it('only the owner may set the window; then it is readable', async () => {
    const h = await cast();
    // A cashier and even a store_manager cannot set the policy.
    expect((await setWindow(h, 'u-cash', { returnWindowDays: 7 }, 'w-cash')).status).toBe(403);
    expect((await setWindow(h, 'u-mgr', { returnWindowDays: 7 }, 'w-mgr')).status).toBe(403);
    // The owner sets 7 days.
    expect((await setWindow(h, 'u-owner', { returnWindowDays: 7 }, 'w-ok')).status).toBe(200);
    expect((await getWindow(h, 'u-owner')).body).toMatchObject({ returnWindowDays: 7, isSet: true });
  });

  it('rejects a malformed window without saving', async () => {
    const h = await cast();
    expect((await setWindow(h, 'u-owner', { returnWindowDays: -1 }, 'w-neg')).status).toBe(400);
    expect((await setWindow(h, 'u-owner', { returnWindowDays: 2.5 }, 'w-frac')).status).toBe(400);
    expect((await setWindow(h, 'u-owner', { returnWindowDays: '7' }, 'w-str')).status).toBe(400);
  });

  it('accepts a return inside the window and BLOCKS one past it (the FR-02 acceptance)', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setWindow(h, 'u-owner', { returnWindowDays: 7 }, 'w')).status).toBe(200);

    // 3 days after the sale → inside the 7-day window.
    expect((await ret(h, 'u-owner', req({ returnId: 'RIN', processedAt: '2026-08-10T10:00:00.000Z' }))).status).toBe(201);
    // 13 days after → past the window, no supervisor override → refused, no money moved.
    const out = await ret(h, 'u-owner', req({ returnId: 'ROUT', processedAt: '2026-08-20T10:00:00.000Z' }));
    expect(out.status).toBe(422);
    expect(codeOf(out)).toBe('outside_window');
  });

  it('a supervisor may authorise an out-of-window return (§28), but not the processor themselves nor an unauthorised name', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setWindow(h, 'u-owner', { returnWindowDays: 7 }, 'w')).status).toBe(200);
    const late = { processedAt: '2026-08-20T10:00:00.000Z' }; // 13 days → out of window

    // A NAME is not an authorisation (audit PF-02): a genuine manager named in the body who never approved — refused.
    expect(codeOf(await retNamed(h, 'u-owner', req({ returnId: 'RS0', ...late, approvedBy: undefined, outOfWindowApprovedBy: 'u-mgr' }))))
      .toBe('approver_named_without_approval');
    // The processor cannot authorise their own out-of-window return.
    const ask = { kind: 'out_of_window' as const, saleId: 'S1', valueMinor: 5000, requestedBy: 'u-owner' };
    expect(codeOf(await giveRefundApproval(h, A, 'u-owner', ask))).toBe('self_approval');
    // A person who does not hold refund-approval authority cannot give one (a cashier, or a made-up name).
    expect((await giveRefundApproval(h, A, 'u-cash', ask)).status).toBe(403);
    expect((await giveRefundApproval(h, A, 'u-nobody', ask)).status).toBe(403);
    // An approval of the REFUND does not authorise the WINDOW — each approval is for one kind of exception.
    const wrongKind = await withApprovals(h, A, 'u-owner', 'S1', req({ returnId: 'RS3', ...late }));
    expect(codeOf(await retNamed(h, 'u-owner', { ...wrongKind, outOfWindowApprovalId: wrongKind['approvalId'] })))
      .toBe('approval_does_not_match');
    // A genuine supervisor (store_manager), different from the processor, in their own session → allowed.
    expect((await ret(h, 'u-owner', req({ returnId: 'RS4', ...late, outOfWindowApprovedBy: 'u-mgr' }))).status).toBe(201);
  });

  it('a return dated before its own sale is a data fault no override can clear', async () => {
    const h = await cast();
    await bank(h, 'u-owner');
    expect((await setWindow(h, 'u-owner', { returnWindowDays: 7 }, 'w')).status).toBe(200);

    // Dated the day BEFORE the sale — even with a valid supervisor authoriser, refused as a data fault.
    const bad = await ret(h, 'u-owner', req({ returnId: 'RBEF', processedAt: '2026-08-06T10:00:00.000Z', outOfWindowApprovedBy: 'u-mgr' }));
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('return_before_sale');
  });
});
