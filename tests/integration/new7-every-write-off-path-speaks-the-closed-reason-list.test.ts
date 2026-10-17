import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { withApprovals } from '../support/refund-approval';

/**
 * **NEW-7 (verifier, D-5 · OB-159 "Use these six") — a write-off raised OUTSIDE the write-off route still speaks the closed
 * reason list.** The verifier's case: a manager writes off a held returned milk with the reason "smelt funny" — it was 201,
 * the register said "smelt funny" and the analytics filed 100% of the value under "unclassified". Now, on the real API in
 * memory and on PostgreSQL: the off-list reason is refused by name and nothing moves; the same decision with the reason
 * `expiry` and "smelt funny" as the NOTE lands, the register keeps both, and the analytics file it under its reason — none
 * unclassified. (A damaged arrival is written off as `damage` with the note "arrived damaged" —
 * tests/integration/a-damaged-arrival-*.test.ts; the one-builder tripwire is
 * tests/guardrails/every-write-off-speaks-the-closed-reason-list.test.ts.)
 */

const backings = useBackings();
const AT = '2026-10-09T10:00:00.000Z';
const SALE = {
  saleId: 'S1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', locationId: 'store-1', tradingDay: '2026-10-09', committedAt: AT, totalMinor: 4_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'MILK', quantityMinor: 2, uom: 'each', unitPriceMinor: 2_000, lineTotalMinor: 4_000, batchId: 'M-1', batchExpiry: '2026-10-12' }], tenders: [{ kind: 'cash', amountMinor: 4_000 }],
};
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('NEW-7 — every write-off path speaks the closed reason list — on $name', ({ harness }) => {
  it('a held returned unit\'s write-off with an off-list reason is refused by name; with a listed reason and a note it lands and is classified', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner'); await h.provisionRole(t, 'u-mgr', 'store_manager'); await h.provisionRole(t, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }), ...(query === undefined ? {} : { query }) });
    expect((await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rcv', productId: 'MILK', locationId: 'store-1', kind: 'received', quantityMinor: 5, uom: 'each', occurredAt: '2026-10-01T09:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 1_500, batchId: 'M-1' })).status).toBe(202);
    expect((await call('POST', '/v1/sales', 'u-owner', SALE)).status).toBe(202);
    const ret = await call('POST', '/v1/sales/S1/returns', 'u-owner', await withApprovals(h, t, 'u-owner', 'S1', { returnId: 'RT1', reasonCode: 'damaged_in_use', refundMinor: 2_000, refundTender: 'cash', approvedBy: 'u-mgr', lines: [{ productId: 'MILK', uom: 'each', quantityMinor: 1, disposition: 'quarantine', batchId: 'M-1' }] }));
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const items = ((await call('GET', '/v1/returns/held-stock/worklist', 'u-mgr')).body as { items: { heldId: string }[] }).items;
    const heldId = items[0]!.heldId;
    const moved = async (): Promise<number> => ((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: unknown[] }).writeOffs.length;

    // The verifier's exact case: refused by name, nothing on the register.
    const off = await call('POST', `/v1/returns/held-stock/${heldId}/decisions/d1`, 'u-mgr', { decision: 'write_off', reasonCode: 'smelt funny' });
    expect(off.status).toBe(400);
    expect(codeOf(off)).toBe('waste_reason_not_in_taxonomy');
    expect((off.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/expiry \/ damage \/ shrinkage \/ preparation \/ customer_return \/ recall/);
    expect(await moved()).toBe(0);

    // The person's own words become the note; the reason is from the list.
    const ok = await call('POST', `/v1/returns/held-stock/${heldId}/decisions/d2`, 'u-mgr', { decision: 'write_off', reasonCode: 'expiry', note: 'smelt funny' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const register = (await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { reasonCode: string; note?: string }[] };
    expect(register.writeOffs.map((w) => [w.reasonCode, w.note])).toEqual([['expiry', 'smelt funny']]);
    const an = (await call('GET', '/v1/waste/analytics', 'u-owner', undefined, { from: '2020-01-01', to: '2030-12-31' })).body as { writeOffs: { byReason: { key: string; valueMinor: number }[]; unclassified: { events: number } } };
    expect(an.writeOffs.byReason).toEqual([expect.objectContaining({ key: 'expiry', valueMinor: 1_500 })]);
    expect(an.writeOffs.unclassified.events).toBe(0);
  });
});
