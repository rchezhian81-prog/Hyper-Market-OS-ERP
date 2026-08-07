import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Returns and refunds, end to end through the real API (M13-FR-01/FR-03, M21, API-05). A refund is
// where money leaves the till, so the cloud is the authoritative guard: it sees every return against
// a bill at once, where a single lane sees only its own log. This proves the wired returns surface
// against the real pipeline and real per-tenant RBAC — the cloud register is now FED, so the same
// receipt cannot be refunded twice (hard rule #2: corrections are compensating events, never a
// second bite), a refund can never exceed what was paid, and a material refund needs a second person
// (§28). A card refund is reported PENDING, never assumed settled (M13-FR-04).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-07T10:00:00.000Z';

// A bill: 3 units of P1 at ₹50, paid ₹150 in cash.
const sale = (over: Record<string, unknown> = {}) => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-08-07', committedAt: AT, totalMinor: 15000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amountMinor: 15000 }],
  ...over,
});

const bank = (h: ApiHarness, tenantId: string, userId: string, body = sale()) =>
  h.request({ method: 'POST', path: '/v1/sales', userId, tenantId, idempotencyKey: `bank-${(body as { saleId: string }).saleId}`, body });

const ret = (h: ApiHarness, tenantId: string, userId: string, saleId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns`, userId, tenantId, idempotencyKey: `ret-${body['returnId']}`, body });

// A return of `qty` units of P1, refunding `refundMinor`, resold. The approval threshold defaults
// high so a refund is not "material" unless a test lowers it — that keeps the §28 rule to the one
// test about it, rather than leaking into every other one.
const line = (qty = 1) => ({ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' as const });
const req = (over: Record<string, unknown>) => ({
  returnId: 'RT1', processedBy: 'u-owner', reasonCode: 'customer_changed_mind',
  lines: [line(1)], refundMinor: 5000, refundTender: 'cash', approvalThresholdMinor: 9_999_999, ...over,
});

interface Body { returnId?: string; refundStatus?: string; restockedLines?: number; remaining?: { productId: string; returnableMinor: number }[] }
/** The error code lives at `body.error.code` — the kernel wraps every refusal in an `error` envelope. */
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('a refund is guarded where the whole history lives (M13/M21, API-05)', () => {
  it('refunds a receipted return and shows what is left on the bill', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await bank(h, A, 'u-owner')).status).toBe(202);

    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 5000 }));
    expect(res.status).toBe(201);
    const body = res.body as Body;
    expect(body.refundStatus).toBe('settled'); // cash settles at the desk
    expect(body.restockedLines).toBe(1); // resold → back on the shelf
    expect(body.remaining?.find((r) => r.productId === 'P1')?.returnableMinor).toBe(2); // 3 sold − 1 back
  });

  it('enforces at-most-once against the whole history — the guard the cloud was not feeding', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);
    // Only 1 of the 3 is left; asking 2 back is refused as over-returned, not silently paid.
    const over = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT2', lines: [line(2)], refundMinor: 5000 }));
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('more_than_was_sold');
    // The last one is fine.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT3', lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);
  });

  it('never refunds more money than the bill was paid (M13-FR-03)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    // One unit back, but a refund of ₹200 against a ₹150 bill — refused before any approval question.
    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 20000 }));
    expect(res.status).toBe(422);
    expect(codeOf(res)).toBe('refund_exceeds_what_is_left');
  });

  it('needs a second, different person for a material refund (§28)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    // ₹120 refund is at/above the ₹100 threshold → material.
    const material = (over: Record<string, unknown>) => req({ lines: [line(1)], refundMinor: 12000, approvalThresholdMinor: 10000, ...over });
    expect((await ret(h, A, 'u-owner', 'S1', material({ returnId: 'RM1' }))).status).toBe(422); // no approver
    expect(codeOf(await ret(h, A, 'u-owner', 'S1', material({ returnId: 'RM2', approvedBy: 'u-owner' }))))
      .toBe('approved_by_the_person_processing_it');
    expect((await ret(h, A, 'u-owner', 'S1', material({ returnId: 'RM3', approvedBy: 'u-manager' }))).status).toBe(201); // a different person
  });

  it('reports a card refund as pending, never assumed settled (M13-FR-04)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    const res = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RT1', lines: [line(1)], refundMinor: 5000, refundTender: 'card' }));
    expect(res.status).toBe(201);
    expect((res.body as Body).refundStatus).toBe('pending');
  });

  it('refuses a product that was not on the bill, and a bill it never banked', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    const ghost = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RG1', lines: [{ productId: 'P-GHOST', uom: 'each', quantityMinor: 1, disposition: 'resell' }] }));
    expect(ghost.status).toBe(422);
    expect(codeOf(ghost)).toBe('product_not_on_this_bill');

    // A return against a sale this system never saw is a 404, not a guess.
    expect((await ret(h, A, 'u-owner', 'S-NONE', req({ returnId: 'RN1' }))).status).toBe(404);
  });

  it('is idempotent on the return id — a retry does not double-count the goods', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    // The till resends what it could not confirm: same return id, twice. Both succeed, one refund.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RX', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RX', lines: [line(2)], refundMinor: 10000 }))).status).toBe(201);

    // If the retry had counted twice, 4 of 3 would be returned and nothing would be left. Instead 1 is.
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RY', lines: [line(1)], refundMinor: 5000 }))).status).toBe(201);
    const over = await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RZ', lines: [line(1)], refundMinor: 5000 }));
    expect(over.status).toBe(422);
    expect(codeOf(over)).toBe('more_than_was_sold');
  });

  it('is authorized and per-tenant: a role without the permission is refused, and one tenant\'s sale is invisible to another', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-acct', 'accountant'); // an accountant holds no POS return permission
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-acct', 'S1', req({ returnId: 'RA1' }))).status).toBe(403);

    // Tenant B never banked S1, so B returning against it finds nothing — A's sale did not leak.
    await h.seedOwner(B, 'u-owner-b');
    expect((await ret(h, B, 'u-owner-b', 'S1', req({ returnId: 'RB1', processedBy: 'u-owner-b' }))).status).toBe(404);
  });

  it('refuses an empty or unreadable return without moving money', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bank(h, A, 'u-owner');

    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RE1', lines: [] }))).status).toBe(422); // no lines
    expect((await ret(h, A, 'u-owner', 'S1', req({ returnId: 'RE2', reasonCode: '' }))).status).toBe(422); // no reason
    // A structurally-broken payload (no refund amount) is a 400 before any assessment.
    expect((await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: A, idempotencyKey: 'ret-RE3', body: { returnId: 'RE3', processedBy: 'u-owner', reasonCode: 'x', lines: [line(1)], refundTender: 'cash', approvalThresholdMinor: 10000 } })).status).toBe(400);
  });
});
