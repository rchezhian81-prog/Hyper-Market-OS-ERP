import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../packages/contracts/src/event';
import { streamName, STREAM } from '../../services/api/src/adapters';
import { tradingDayIn } from '../../packages/calendar/src/index';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';

/**
 * **FG-4 · A12 (1) · OB-386 (owner, 26 Oct 2026, option A): a "free sample" stock issue; the system computes the GST credit
 * to give back from the buying cost and places it in the next GST return for the accountant to check.**
 *
 *   • two rice given as samples: the stock falls by two; the buying value is head office's own cost (₹100.00); the credit
 *     given back is CGST ₹2.50 + SGST ₹2.50 — the rate of the latest bill that charged rice — placed in this month's return;
 *   • the GSTR-3B for the month states it under Table 4(B) on its own, never netted off 4(A);
 *   • dal, never billed: the credit is NOT computed and says why — no reversal, never a zero;
 *   • with this month's GSTR-3B locked, the next sample's give-back goes into the next month, and says so;
 *   • the accountant checks it (agreed / query); the person who recorded a sample cannot check it; a body naming its own
 *     value or tax is refused; an id is used once; a reader outside the branch cannot record one there;
 *   • OB-393: each sample waits for a store manager OTHER THAN THE GIVER — nothing moves until approved; the giver approving
 *     their own is refused by name (`free_sample_self_approval`); the waiting ones are listed; a rejection moves nothing;
 *   • append-only and audited; a cold restart reads the same.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const month = tradingDayIn(new Date().toISOString(), { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' }).slice(0, 7);
const nextMonth = (m: string): string => { const y = Number(m.slice(0, 4)); const n = Number(m.slice(5, 7)); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`; };
const mmyyyy = (m: string): string => `${m.slice(5, 7)}${m.slice(0, 4)}`;
interface Issue { issueId: string; itc: { state: string; cgstMinor?: number; sgstMinor?: number; why?: string; buyingValueMinor: number | null }; returnMonth?: string; movedFrom?: string; reversalId?: string; check: { outcome: string } | null; itcWords: string }

describe.each(backings)('OB-386 — a free sample gives back its GST credit in the next return — on $name', ({ harness }) => {
  it('computed from the buying cost, placed in the next return, stated in 4(B), checked by the accountant', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    await issuedOrder(call, 'po-1', [{ productId: 'rice', qty: 10, unitMinor: 5_000 }, { productId: 'dal', qty: 5, unitMinor: 3_000 }]);
    await received(call, 'grn-1', 'po-1', [{ productId: 'rice', qty: 10, unitMinor: 5_000 }, { productId: 'dal', qty: 5, unitMinor: 3_000 }]);
    // The rice bill charged 5% GST intra-state (CGST 2.5% + SGST 2.5%); dal was never billed.
    expect((await call('POST', '/v1/purchase/invoices/inv-1/capture', P3.BUYER, {
      supplierId: 'sup-1', poId: 'po-1', declaredTotalMinor: 52_500,
      lines: [{ productId: 'rice', quantity: 10, unitPriceMinor: 5_000, lineTotalMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250 }],
    })).status).toBe(201);

    const sample = (id: string, body: Record<string, unknown>, by: string = P3.RECEIVER, key = `fs-${id}`) => call('POST', `/v1/inventory/free-samples/${id}`, by, body, key);
    // OB-393: another store manager decides.
    const decide = (id: string, decision: 'approve' | 'reject', by: string = P3.BUYER, reason = 'seen at the counter') => call('POST', `/v1/inventory/free-samples/${id}/decision`, by, { decision, reason }, `dec-${id}-${by}-${decision}`);
    const given = async (id: string, body: Record<string, unknown>, by: string = P3.RECEIVER, approver: string = P3.BUYER) => {
      const asked = await sample(id, body, by);
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      return decide(id, 'approve', approver);
    };
    const onHand = async () => ((await call('GET', '/v1/inventory/valuation', P3.OWNER)).body as { rows: { productId: string; locationId: string; onHandMinor: number }[] }).rows.find((r) => r.productId === 'rice' && r.locationId === P3.BACK)?.onHandMinor;
    const rice2 = { productId: 'rice', locationId: P3.BACK, qty: 2, uom: 'ea', note: 'tasting at the rice counter' };

    // Refusals first: a body naming its own value; nothing readable; a cashier; outside the branch.
    expect(codeOf(await sample('fs-x', { ...rice2, valueMinor: 1 }))).toBe('free_sample_carries_its_own_figures');
    expect(codeOf(await sample('fs-y', { productId: 'rice', locationId: P3.BACK, qty: 0, uom: 'ea', note: 'x' }))).toBe('not_readable_as_a_free_sample');
    expect((await sample('fs-z', rice2, P3.CASHIER)).status).toBe(403);
    await h.provisionRole(T, 'u-elsewhere', 'store_manager', ['store-2']);
    expect((await h.request({ method: 'POST', path: '/v1/inventory/free-samples/fs-w', userId: 'u-elsewhere', tenantId: T, branchId: 'store-2', idempotencyKey: 'fs-w', body: rice2 })).status).toBe(403);

    // ── 1 · Two rice as samples: recorded and WAITING (OB-393) — nothing has moved, no credit is given back yet.
    const asked = await sample('fs-1', rice2);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'awaiting_approval', request: { issueId: 'fs-1', requestedBy: P3.RECEIVER } });
    expect(await onHand()).toBe(10);
    expect(((await call('GET', `/v1/finance/itc/${month}`, P3.MATCHER)).body as { reversals: unknown[] }).reversals).toEqual([]);
    const pending = (await call('GET', '/v1/inventory/free-samples/pending', P3.BUYER)).body as { pending: { issueId: string; requestedBy: string }[]; count: number };
    expect(pending).toMatchObject({ count: 1, pending: [{ issueId: 'fs-1', requestedBy: P3.RECEIVER }] });
    expect((await call('GET', '/v1/inventory/free-samples/pending', P3.CASHIER)).status).toBe(403);
    // The giver cannot approve their own — refused by name; a cashier may not decide; a decision needs a reason.
    const self = await decide('fs-1', 'approve', P3.RECEIVER);
    expect([self.status, codeOf(self)]).toEqual([403, 'free_sample_self_approval']);
    expect((await decide('fs-1', 'approve', P3.CASHIER)).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/inventory/free-samples/fs-1/decision', P3.BUYER, { decision: 'approve' }))).toBe('not_readable_as_a_free_sample_decision');
    expect((await call('POST', '/v1/inventory/free-samples/fs-nope/decision', P3.BUYER, { decision: 'approve', reason: 'x' })).status).toBe(404);
    expect(await onHand()).toBe(10);
    // Another store manager approves: computed from the buying cost, in this month's return; both people named.
    const r1 = await decide('fs-1', 'approve');
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const i1 = (r1.body as { issue: Issue & { issuedBy: string; approvedBy: string } }).issue;
    expect(i1).toMatchObject({ issuedBy: P3.RECEIVER, approvedBy: P3.BUYER });
    expect((await decide('fs-1', 'approve')).status).toBe(201); // the same request again (same key) is the same answer
    expect(codeOf(await decide('fs-1', 'reject', P3.OWNER))).toBe('free_sample_already_decided');
    expect(((await call('GET', '/v1/inventory/free-samples/pending', P3.BUYER)).body as { count: number }).count).toBe(0);
    expect(i1.itc).toMatchObject({ state: 'computed', buyingValueMinor: 10_000, cgstMinor: 250, sgstMinor: 250 });
    expect(i1).toMatchObject({ returnMonth: month, reversalId: 'free-sample-fs-1' });
    expect((await sample('fs-1', rice2)).status).toBe(202); // the same request again (same key) is the same answer
    expect(codeOf(await sample('fs-1', rice2, P3.RECEIVER, 'another-key'))).toBe('free_sample_already_recorded'); // a second issue with the id is refused
    // The stock fell by two.
    expect(await onHand()).toBe(8);

    // The month's ITC review carries the reversal; the GSTR-3B states it under 4(B), on its own.
    const review = (await call('GET', `/v1/finance/itc/${month}`, P3.MATCHER)).body as { reversals: { reversalId: string; rule: string; by: string; cgstMinor: number }[] };
    expect(review.reversals).toEqual([expect.objectContaining({ reversalId: 'free-sample-fs-1', rule: 'free_samples', by: 'system:free-sample', cgstMinor: 250 })]);
    const g3b = await call('GET', `/v1/finance/gstr3b/${mmyyyy(month)}`, P3.OWNER);
    expect(g3b.status, JSON.stringify(g3b.body)).toBe(200);
    expect((g3b.body as { table4: { a5AllOther: { detail: string } } }).table4.a5AllOther.detail).toMatch(/Table 4\(B\) ITC reversed: CGST ₹2\.50, SGST ₹2\.50 \(₹5\.00 in 1 reversal\(s\)\)/);

    // ── 2 · Dal was never billed: not computed, said why, no reversal.
    const r2 = await given('fs-2', { productId: 'dal', locationId: P3.BACK, qty: 1, uom: 'ea', note: 'sample to a regular customer' });
    expect(r2.status).toBe(201);
    expect((r2.body as { issue: Issue; itcWords: string }).issue.itc).toMatchObject({ state: 'not_computed', why: 'no_bill_for_the_product', buyingValueMinor: 3_000 });
    expect((r2.body as { itcWords: string }).itcWords).toMatch(/^Not computed: no supplier bill/);

    // ── 3 · This month's GSTR-3B locked → the next sample goes into the next month's return, and says so.
    await h.store.append(T, streamName(STREAM.gstreturns, 'gstr3b'), makeEvent({
      id: `lock-${month}`, type: 'Gstr3bLocked', occurredAt: new Date().toISOString(), idempotencyKey: `lock-${T}-${month}`, source: 'test/setup',
      payload: { period: mmyyyy(month), figures: {}, arn: 'AA-SYNTHETIC', lockedBy: P3.MATCHER, lockedAt: new Date().toISOString(), filedDigest: 'd' },
    }));
    const r3 = await given('fs-3', { ...rice2, qty: 1 });
    expect((r3.body as { issue: Issue }).issue).toMatchObject({ returnMonth: nextMonth(month), movedFrom: month, itc: { cgstMinor: 125, sgstMinor: 125 } });

    // ── 4 · The accountant's list and check; the person who recorded a sample cannot check it.
    const list = async (q: Record<string, string> = {}, hh = h) => (await hh.request({ method: 'GET', path: '/v1/finance/free-sample-itc', userId: P3.MATCHER, tenantId: T, query: q })).body as { issues: Issue[]; count: number; toCheck: number; notComputed: number };
    expect(await list({ month })).toMatchObject({ count: 2, toCheck: 2, notComputed: 1 }); // fs-1 (this return) and fs-2 (not computed, given this month)
    expect(((await list({ month })) as unknown as { awaitingApproval: { issueId: string }[] }).awaitingApproval).toEqual([]);
    expect((await list({ month: nextMonth(month) })).issues.map((i) => i.issueId)).toEqual(['fs-3']);
    expect(codeOf(await h.request({ method: 'GET', path: '/v1/finance/free-sample-itc', userId: P3.MATCHER, tenantId: T, query: { month: '2026-13' } }))).toBe('not_a_month');
    // The owner records one and tries to check it himself.
    expect((await given('fs-4', { ...rice2, qty: 1 }, P3.OWNER, P3.RECEIVER)).status).toBe(201);
    // OB-393: a rejected sample moves nothing; one still waiting is listed for the accountant on its own, never as nothing.
    const stockBefore = await onHand();
    expect((await sample('fs-5', { ...rice2, qty: 1 })).status).toBe(202);
    const rejected = await decide('fs-5', 'reject', P3.BUYER, 'not an approved tasting');
    expect(rejected.status).toBe(201);
    expect(codeOf(await decide('fs-5', 'approve', P3.OWNER))).toBe('free_sample_already_decided');
    expect((await sample('fs-6', { ...rice2, qty: 1 })).status).toBe(202);
    expect(await onHand()).toBe(stockBefore);
    expect(codeOf(await call('POST', '/v1/finance/free-sample-itc/fs-4/check', P3.OWNER, { outcome: 'agreed', note: 'mine' }))).toBe('self_check');
    expect(codeOf(await call('POST', '/v1/finance/free-sample-itc/fs-1/check', P3.MATCHER, { outcome: 'maybe', note: 'x' }))).toBe('not_readable_as_a_check');
    expect((await call('POST', '/v1/finance/free-sample-itc/fs-1/check', P3.RECEIVER, { outcome: 'agreed', note: 'x' })).status).toBe(403);
    expect((await call('POST', '/v1/finance/free-sample-itc/fs-1/check', P3.MATCHER, { outcome: 'agreed', note: 'rate matches bill inv-1' })).status).toBe(201);
    expect((await call('POST', '/v1/finance/free-sample-itc/fs-2/check', P3.MATCHER, { outcome: 'query', note: 'dal bill to be found' })).status).toBe(201);
    const after = await list({ month });
    expect(after.toCheck).toBe(1); // the query still waits
    expect(((await list({ month })) as unknown as { awaitingApproval: { issueId: string }[] }).awaitingApproval.map((w) => w.issueId)).toEqual(['fs-6']);
    expect(after.issues.find((i) => i.issueId === 'fs-1')?.check).toMatchObject({ outcome: 'agreed' });

    // ── 5 · A cold restart reads the same.
    const h2 = harness(h);
    const again = await list({ month }, h2);
    expect([again.count, again.toCheck]).toEqual([2, 1]);
    const stillWaiting = (await caller(h2, T)('GET', '/v1/inventory/free-samples/pending', P3.BUYER)).body as { pending: { issueId: string }[] };
    expect(stillWaiting.pending.map((w) => w.issueId)).toEqual(['fs-6']);
    const self6 = await caller(h2, T)('POST', '/v1/inventory/free-samples/fs-6/decision', P3.RECEIVER, { decision: 'approve', reason: 'mine' });
    expect(codeOf(self6)).toBe('free_sample_self_approval');
    // The seals: the request, the rejection and the approval, each by its own person.
    const trail = async (action: string) => ((await h2.request({ method: 'GET', path: '/v1/audit/trail', userId: P3.OWNER, tenantId: T, query: { action } })).body as { matches: { actorId: string; correlationId?: string }[] }).matches.map((m) => m.actorId);
    expect(await trail('stock.free_sample.reject')).toEqual([P3.BUYER]);
    expect((await trail('stock.free_sample')).sort()).toEqual([P3.BUYER, P3.BUYER, P3.BUYER, P3.RECEIVER].sort());
  }, 120_000);
});
