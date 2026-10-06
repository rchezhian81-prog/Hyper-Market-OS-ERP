import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';

/**
 * **PF-01 — two distinct refunds of the same sale, at the same moment, cannot both land (Wave 2a · audit PF-01 ·
 * M13-FR-01 · M13-FR-03 · hard rule #10 · P-08).**
 *
 * The audit fired two refunds with two different ids against one sale through the real API harness and both
 * returned 201: each read the same "nothing refunded yet", each appended. The desk route now reads the sale's
 * refund-guard version before the history and appends under it; the second to land is refused BY NAME
 * (`concurrent_change`, 409, nothing saved) and re-reads. The synced route — the lane's money already left — never
 * refuses: it appends under the same guard and, when it loses a race, re-reads and lands. These drive the real
 * API surface over the in-memory store; the same guard on PostgreSQL is proven in write-guards-on-postgresql.test.ts.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-05T10:00:00.000Z';

const sale = (units: number, totalMinor: number) => ({
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash',
  tradingDay: '2026-10-05', committedAt: AT, totalMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: units, uom: 'each', unitPriceMinor: Math.round(totalMinor / units), lineTotalMinor: totalMinor }],
  tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});
const bank = (h: ApiHarness, units: number, totalMinor: number) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: A, idempotencyKey: 'bank-S1', body: sale(units, totalMinor) });
const line = (qty: number) => ({ productId: 'P1', uom: 'each', quantityMinor: qty, disposition: 'resell' as const });
/** A refund at the desk — the authenticated owner processes it, a genuine approver (store manager) approves it in their
 *  own session (ADR-0022) and the refund names that approval. `deskBody` gets the approval; `sendDesk` sends the refund,
 *  so a race fires the refunds themselves at the same moment. */
const deskBody = (h: ApiHarness, id: string, refundMinor: number, qty = 1) => withApprovals(h, A, 'u-owner', 'S1',
  { returnId: id, number: id, reasonCode: 'damaged', refundMinor, refundTender: 'cash', lines: [line(qty)], processedAt: AT, approvedBy: 'u-mgr' });
const sendDesk = (h: ApiHarness, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: 'u-owner', tenantId: A, idempotencyKey: `desk-${id}`, body });
const deskRefund = async (h: ApiHarness, id: string, refundMinor: number, qty = 1) => sendDesk(h, id, await deskBody(h, id, refundMinor, qty));
const syncedRefund = (h: ApiHarness, id: string, refundMinor: number, qty = 1) =>
  h.request({
    method: 'POST', path: '/v1/sales/S1/returns/synced', userId: 'u-owner', tenantId: A, idempotencyKey: `sync-${id}`,
    body: { returnId: id, number: id, processedBy: 'u-lanecashier', approvedBy: 'u-mgr', reasonCode: 'damaged', refundMinor, refundTender: 'cash', lines: [line(qty)], processedAt: AT },
  });

interface ErrorBody { code?: string; wasItSaved?: string; nextSafeAction?: string }
interface Body extends ErrorBody { error?: ErrorBody; remaining?: unknown; refundStatus?: string }
/** The three-part error the kernel answers with (§30), wherever the harness surfaces it. */
const problem = (body: unknown): ErrorBody => { const b = body as Body; return b.error ?? b; };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // a genuine refund approver, not the processor
  return h;
}

describe('PF-01 — concurrent distinct refunds of one sale', () => {
  it('two full refunds fired at the same moment: exactly one 201, the other a named 409 with nothing saved; a third is refused as over-refund', async () => {
    const h = await cast();
    expect((await bank(h, 1, 5000)).status).toBe(202); // accepted into the ledger
    const [ba, bb] = [await deskBody(h, 'RT-1', 5000), await deskBody(h, 'RT-2', 5000)];
    const [a, b] = await Promise.all([sendDesk(h, 'RT-1', ba), sendDesk(h, 'RT-2', bb)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(problem(loser.body).code).toBe('concurrent_change');
    expect(problem(loser.body).wasItSaved).toBe('not_saved');
    expect(problem(loser.body).nextSafeAction).toMatch(/Read sale S1 again/);
    // the money left once: the next refund, decided on fresh figures, is refused for what is left — not raced
    const third = await deskRefund(h, 'RT-3', 5000);
    expect(third.status).toBe(422);
    // the goods check comes first (nothing left to return), then the money check — either is the honest refusal
    expect(['more_than_was_sold', 'refund_exceeds_what_is_left']).toContain(problem(third.body).code);
  });

  it('legitimate refunds one after another all land — the guard refuses stale decisions, not sequences', async () => {
    const h = await cast();
    await bank(h, 2, 10000);
    expect((await deskRefund(h, 'RT-A', 5000)).status).toBe(201);
    expect((await deskRefund(h, 'RT-B', 5000)).status).toBe(201);
    expect((await deskRefund(h, 'RT-C', 5000)).status).toBe(422); // nothing left
  });

  it('a replay of the SAME refund (lost reply) is still answered idempotently, not as a conflict', async () => {
    const h = await cast();
    await bank(h, 1, 5000);
    const first = await deskRefund(h, 'RT-1', 5000);
    const again = await deskRefund(h, 'RT-1', 5000);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
  });

  it('a lane\'s synced refund racing a desk refund is never refused — it lands under the same guard and the register flags what it did', async () => {
    const h = await cast();
    await bank(h, 1, 5000);
    const deskApproved = await deskBody(h, 'RT-desk', 5000);
    const [desk, synced] = await Promise.all([sendDesk(h, 'RT-desk', deskApproved), syncedRefund(h, 'RT-lane', 5000)]);
    expect(synced.status).toBe(202);                       // the money already left the lane: recorded, flagged, never refused
    expect([201, 409]).toContain(desk.status);             // the desk either won or lost the race by name
    if (desk.status === 409) expect(problem(desk.body).code).toBe('concurrent_change');
  });
});

// ── The same guard on the other two balances the audit named: gift value and loyalty points (M17-FR-01 / M17-FR-03) ──
const issue = (h: ApiHarness, id: string, faceValueMinor: number) =>
  h.request({ method: 'POST', path: '/v1/stored-value/instruments', userId: 'u-owner', tenantId: A, idempotencyKey: `iss-${id}`, body: { instrumentId: id, kind: 'gift_card', ownerRef: 'H1', faceValueMinor } });
const redeem = (h: ApiHarness, id: string, movementId: string, amountMinor: number) =>
  h.request({ method: 'POST', path: `/v1/stored-value/instruments/${id}/redeem`, userId: 'u-owner', tenantId: A, idempotencyKey: `red-${movementId}`, body: { movementId, amountMinor, channel: 'store' } });
const points = (h: ApiHarness, movementId: string, kind: 'earn' | 'burn', pts: number) =>
  h.request({ method: 'POST', path: '/v1/customers/C1/points', userId: 'u-owner', tenantId: A, idempotencyKey: `pm-${movementId}`, body: { movementId, kind, points: pts } });

describe('PF-01 — concurrent distinct redemptions of one gift card', () => {
  it('two redemptions of the whole balance at the same moment: one 200, the other a named 409; the card is not overdrawn', async () => {
    const h = await cast();
    expect((await issue(h, 'GC-1', 10_000)).status).toBe(201);
    const [a, b] = await Promise.all([redeem(h, 'GC-1', 'r1', 10_000), redeem(h, 'GC-1', 'r2', 10_000)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(problem(loser.body).code).toBe('concurrent_change');
    expect(problem(loser.body).wasItSaved).toBe('not_saved');
    const third = await redeem(h, 'GC-1', 'r3', 1);
    expect(third.status).toBe(422); // nothing left — decided on fresh figures, not raced
    const read = await h.request({ method: 'GET', path: '/v1/stored-value/instruments/GC-1', userId: 'u-owner', tenantId: A });
    expect((read.body as { balanceMinor: number }).balanceMinor).toBe(0);
  });

  it('a replay of the same redemption is answered idempotently, and partial redemptions in sequence all land', async () => {
    const h = await cast();
    await issue(h, 'GC-2', 10_000);
    expect((await redeem(h, 'GC-2', 'p1', 4_000)).status).toBe(200);
    expect((await redeem(h, 'GC-2', 'p1', 4_000)).status).toBe(200); // the same movement again: already applied
    expect((await redeem(h, 'GC-2', 'p2', 6_000)).status).toBe(200);
    expect((await redeem(h, 'GC-2', 'p3', 1)).status).toBe(422);
  });
});

describe('PF-01 — concurrent distinct burns of one customer\'s points', () => {
  it('two burns of the whole balance at the same moment: one 201, the other a named 409; the balance never goes below zero', async () => {
    const h = await cast();
    expect((await points(h, 'e1', 'earn', 100)).status).toBe(201);
    const [a, b] = await Promise.all([points(h, 'b1', 'burn', 100), points(h, 'b2', 'burn', 100)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(problem(loser.body).code).toBe('concurrent_change');
    expect((await points(h, 'b3', 'burn', 1)).status).toBe(422);
    const read = await h.request({ method: 'GET', path: '/v1/customers/C1/points', userId: 'u-owner', tenantId: A });
    expect((read.body as { pointsBalance: number }).pointsBalance).toBe(0);
  });
});
