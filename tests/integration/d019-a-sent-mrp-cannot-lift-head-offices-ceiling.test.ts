import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { storeRules } from '../support/store-rules';
import { approvedRequestId } from '../support/approval-request';
import { mrpOnRecord } from '../support/mrp-on-record';

/**
 * **D-019 · the MRP ceiling on head office's price-change route (`POST /v1/prices/changes`, M05-FR-02 · §28 · P-04).**
 *
 * The route used to believe whatever MRP a request sent. A request could therefore lift the legal ceiling by sending a
 * higher MRP than the one on the product master. Now head office judges the price against its OWN MRP in force today —
 * the lower of it and the one sent. Where it holds none, the MRP sent (read off the pack) is believed only with a second
 * person's approval for exactly this change, MRP included (the D-019 flow on the Change price screen). The audit trail says
 * which MRP was the ceiling and where it came from. Nothing about the margin floor, the size rule or the approvals is
 * loosened. Runs on the in-memory event store and, when DATABASE_URL is set, on real PostgreSQL.
 */

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const whatOf = (r: Res): string => (r.body as { error?: { whatHappened?: string } }).error?.whatHappened ?? '';

describe.each(useBackings())('the MRP ceiling on a price change is head office’s own — on $name', ({ harness }) => {
  async function shop(): Promise<{ h: ApiHarness; T: string; post: (body: Record<string, unknown>, who?: string) => Promise<Res> }> {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner2');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await aBranch(h, T, 'u-owner');
    await storeRules(h, T, 'u-owner', 'store-1', 0);
    const post = (body: Record<string, unknown>, who = 'u-mgr') =>
      h.request({ method: 'POST', path: '/v1/prices/changes', userId: who, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
    return { h, T, post };
  }
  const change = (productId: string, priceMinor: number, mrpMinor: number) => ({ productId, priceMinor, mrpMinor, costMinor: 1_000, currency: 'INR', marginFloorBps: 0 });
  const auditOf = async (h: ApiHarness, T: string, productId: string) =>
    ((await h.request({ method: 'GET', path: '/v1/audit/trail', userId: 'u-owner', tenantId: T, query: { objectType: 'product', objectId: productId } })).body as { matches: { action: string; after: Record<string, string> }[] })
      .matches.filter((m) => m.action === 'price.change');

  it('a sent MRP above the recorded one cannot raise the ceiling — the recorded one is the law', async () => {
    const { h, T, post } = await shop();
    await mrpOnRecord(h, T, 'u-owner', 'p-biscuit', 3_500); // ₹35 printed on the pack, on the product master
    // ₹38 with a "₹99 MRP" sent: refused, by head office's own ₹35 — and naming it.
    const lifted = await post(change('p-biscuit', 3_800, 9_900));
    expect(lifted.status).toBe(422);
    expect(codeOf(lifted)).toBe('price_above_mrp');
    expect(whatOf(lifted)).toMatch(/MRP of ₹35\.00 on the product master from 2026-01-01 \(lower than the ₹99\.00 sent\)/);
    // ...and no approval can lift it either.
    const approvalId = await approvedRequestId(h, T, 'u-mgr', 'u-owner', { kind: 'price_change', subjectRef: 'p-biscuit', details: change('p-biscuit', 3_800, 9_900), valueMinor: 3_800 });
    const approved = await post({ ...change('p-biscuit', 3_800, 9_900), approvalId });
    expect(codeOf(approved)).toBe('price_above_mrp');
    // At or under the recorded MRP it goes through alone, and the trail says the ceiling was the product master's.
    const ok = await post(change('p-biscuit', 3_200, 9_900));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await auditOf(h, T, 'p-biscuit')).at(-1)?.after).toMatchObject({ priceMinor: '3200', mrpMinor: '3500', mrpSource: 'product_master' });
  });

  it('a sent MRP lower than the recorded one is the ceiling (the lower of the two) — never loosened', async () => {
    const { h, T, post } = await shop();
    await mrpOnRecord(h, T, 'u-owner', 'p-oil', 13_500);
    const r = await post(change('p-oil', 13_000, 12_500));
    expect(codeOf(r)).toBe('price_above_mrp');
    const ok = await post(change('p-oil', 12_000, 12_500));
    expect(ok.status).toBe(201);
    expect((await auditOf(h, T, 'p-oil')).at(-1)?.after).toMatchObject({ mrpMinor: '12500', mrpSource: 'sent_lower_than_product_master' });
  });

  it('with no MRP on record, the MRP from the pack needs a second person — refused alone, with a plain reason', async () => {
    const { h, T, post } = await shop();
    const alone = await post(change('p-new', 3_200, 3_500));
    expect(alone.status).toBe(422);
    expect(codeOf(alone)).toBe('mrp_not_on_record_needs_second_person');
    expect(whatOf(alone)).toBe('Head office holds no MRP for p-new today, so the MRP sent with this price (₹35.00, read off the pack) cannot be relied on by one person alone. A second person who may approve prices has to check it against the pack and approve exactly this change.');
    // The owner sending it alone is refused too: it is not a matter of rank, it is a second pair of eyes on the pack.
    expect(codeOf(await post(change('p-new', 3_200, 3_500), 'u-owner'))).toBe('mrp_not_on_record_needs_second_person');
    // Somebody else's approval (asked by another maker) is not the manager's: it is refused, nothing saved.
    const notHers = await approvedRequestId(h, T, 'u-owner', 'u-owner2', { kind: 'price_change', subjectRef: 'p-new', details: change('p-new', 3_200, 3_500), valueMinor: 3_200 });
    expect((await post({ ...change('p-new', 3_200, 3_500), approvalId: notHers })).status).toBe(422);
    // An approval for a DIFFERENT MRP is not an approval for this one.
    const other = await approvedRequestId(h, T, 'u-mgr', 'u-owner', { kind: 'price_change', subjectRef: 'p-new', details: change('p-new', 3_200, 4_000), valueMinor: 3_200 });
    expect((await post({ ...change('p-new', 3_200, 3_500), approvalId: other })).status).toBe(422);
    // With a second person's approval for exactly this change and its MRP: saved, and the trail says where the MRP came from.
    const approvalId = await approvedRequestId(h, T, 'u-mgr', 'u-owner', { kind: 'price_change', subjectRef: 'p-new', details: change('p-new', 3_200, 3_500), valueMinor: 3_200 });
    const ok = await post({ ...change('p-new', 3_200, 3_500), approvalId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ approvedBy: 'u-owner' });
    expect((await auditOf(h, T, 'p-new')).at(-1)?.after).toMatchObject({ mrpMinor: '3500', mrpSource: 'pack_checked_by_second_person', approvedBy: 'u-owner' });
  });

  it('even with a second person, a price above the pack’s MRP is refused — no approval lifts the law', async () => {
    const { h, T, post } = await shop();
    const approvalId = await approvedRequestId(h, T, 'u-mgr', 'u-owner', { kind: 'price_change', subjectRef: 'p-new', details: change('p-new', 3_600, 3_500), valueMinor: 3_600 });
    expect(codeOf(await post({ ...change('p-new', 3_600, 3_500), approvalId }))).toBe('price_above_mrp');
  });

  it('an MRP dated ahead is not today’s: with only a future MRP on record, the price still needs a second person', async () => {
    const { h, T, post } = await shop();
    await mrpOnRecord(h, T, 'u-owner', 'p-later', 5_000, { from: '2099-01-01' });
    expect(codeOf(await post(change('p-later', 3_200, 5_000)))).toBe('mrp_not_on_record_needs_second_person');
  });
});
