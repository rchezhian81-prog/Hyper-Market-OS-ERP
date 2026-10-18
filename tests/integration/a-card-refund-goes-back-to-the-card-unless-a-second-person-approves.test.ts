import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { refundApprovalId, giveRefundApproval } from '../support/refund-approval';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, STREAM_FOR, streamName } from '../../services/api/src/adapters';
import type { ReturnRecord } from '../../services/pos/src/returns';

/**
 * **R3 · C14 · OB-144 "A" — a refund goes back the way the bill was paid, on the real desk refund route, in memory AND on
 * real PostgreSQL, with a cold restart.** Signed sentence: "a refund on a card or UPI sale goes to the same instrument
 * unless a policy exception (Q6) is approved by a second person with a reason." The owner's answer to Q6 (OB-144 "A"):
 * back to the source; cash only for cash sales; a cash refund on a card/UPI sale needs a second person and a written reason.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const AT = '2026-10-10T10:00:00.000Z';
/** A bill: 4 × P1 at ₹50 = ₹200, paid as `tenders` say. */
const sale = (saleId: string, tenders: readonly Record<string, unknown>[]) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-10', committedAt: AT,
  totalMinor: 20_000, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 4, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 20_000 }], tenders,
});
const PROCESSOR = 'u-desk';
const SUPERVISOR = 'u-sup';

describe.each(backings)('a card refund goes back to the card unless a second person approves — on $name (C14 · OB-144)', ({ harness, restart }) => {
  it('to the source by default; cash on a card or UPI bill refused; allowed only with a second person\'s approval and its written reason', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, PROCESSOR, 'store_manager');
    await h.provisionRole(T, SUPERVISOR, 'store_manager');
    for (const [id, tenders] of [
      ['S-CARD', [{ kind: 'card', amountMinor: 20_000, ref: 'tok_synthetic_card_1' }]],
      ['S-UPI', [{ kind: 'upi', amountMinor: 20_000, ref: 'upi_synthetic_1' }]],
      ['S-CASH', [{ kind: 'cash', amountMinor: 20_000 }]],
      ['S-MIX', [{ kind: 'cash', amountMinor: 5_000 }, { kind: 'card', amountMinor: 15_000, ref: 'tok_synthetic_card_2' }]],
    ] as const) {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: T, idempotencyKey: `bank-${id}`, body: sale(id, tenders) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    const refund = async (saleId: string, returnId: string, refundTender: string, refundMinor: number, extra: Record<string, unknown> = {}): Promise<Res> => {
      const approvalId = await refundApprovalId(h, T, SUPERVISOR, { saleId, valueMinor: refundMinor, requestedBy: PROCESSOR });
      return h.request({
        method: 'POST', path: `/v1/sales/${saleId}/returns`, userId: PROCESSOR, tenantId: T, idempotencyKey: `ret-${returnId}-${randomUUID()}`,
        body: { returnId, reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: refundMinor / 5_000, disposition: 'resell' }], refundMinor, refundTender, approvalId, ...extra },
      });
    };
    const exception = (saleId: string, valueMinor: number, reason = 'customer\'s card is closed — the bank letter seen (synthetic)', by = SUPERVISOR) =>
      giveRefundApproval(h, T, by, { kind: 'tender_exception', saleId, valueMinor, requestedBy: PROCESSOR, reason });

    // ── TO THE SOURCE: a card bill refunds to the card (pending until the provider confirms), a cash bill in cash ──
    const toCard = await refund('S-CARD', 'RT-1', 'card', 5_000);
    expect(toCard.status, JSON.stringify(toCard.body)).toBe(201);
    expect(toCard.body).toMatchObject({ refundSource: 'to_source', refundStatus: 'pending' });
    expect((await refund('S-CASH', 'RT-2', 'cash', 5_000)).body).toMatchObject({ refundSource: 'to_source', refundStatus: 'settled' });

    // ── CASH ON A CARD OR UPI BILL: refused, nothing moves ──
    const cashOnCard = await refund('S-CARD', 'RT-3', 'cash', 5_000);
    expect([cashOnCard.status, codeOf(cashOnCard)]).toEqual([422, 'refund_not_to_source']);
    expect((cashOnCard.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/does not go back to the card it came from/);
    expect(codeOf(await refund('S-UPI', 'RT-4', 'cash', 5_000))).toBe('refund_not_to_source');
    expect(codeOf(await refund('S-UPI', 'RT-4b', 'store_credit', 5_000, { customerRef: 'cust-1' }))).toBe('refund_not_to_source');
    // A mixed bill: ₹50 of cash comes back in cash; more cash than it paid is the exception.
    expect((await refund('S-MIX', 'RT-5', 'cash', 5_000)).body).toMatchObject({ refundSource: 'to_source' });
    expect(codeOf(await refund('S-MIX', 'RT-6', 'cash', 5_000))).toBe('refund_not_to_source');
    // Nothing of the refused refunds was recorded.
    const recorded = async (saleId: string) => (await h.store.readStream(T, STREAM_FOR.forSaleReturns(saleId), { type: 'ReturnRecorded' })).map((e) => e.event.payload as ReturnRecord);
    expect((await recorded('S-CARD')).map((r) => r.returnId)).toEqual(['RT-1']);
    expect(await recorded('S-UPI')).toEqual([]);

    // ── THE EXCEPTION: a second person, in their own session, with a written reason ──
    // The person processing it cannot approve it; an approval with no reason is not one; an approval for another amount
    // or another kind does not fit.
    const self = await exception('S-CARD', 5_000, 'x', PROCESSOR);
    expect([self.status, codeOf(self)]).toEqual([422, 'self_approval']);
    expect((await exception('S-CARD', 5_000, '   ')).status).toBe(400);
    const wrongAmount = (await exception('S-CARD', 4_000)).body as { approvalId: string };
    expect(codeOf(await refund('S-CARD', 'RT-7', 'cash', 5_000, { tenderExceptionApprovalId: wrongAmount.approvalId }))).toBe('approval_does_not_match');
    const plainRefundApproval = await refundApprovalId(h, T, SUPERVISOR, { saleId: 'S-CARD', valueMinor: 5_000, requestedBy: PROCESSOR });
    expect(codeOf(await refund('S-CARD', 'RT-7', 'cash', 5_000, { tenderExceptionApprovalId: plainRefundApproval }))).toBe('approval_does_not_match');
    // The real one: the supervisor approves this cash refund on the card bill with a reason — it goes through.
    const given = await exception('S-CARD', 5_000);
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    const exceptionId = (given.body as { approvalId: string }).approvalId;
    const allowed = await refund('S-CARD', 'RT-7', 'cash', 5_000, { tenderExceptionApprovalId: exceptionId });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body).toMatchObject({ refundSource: 'exception_approved', refundStatus: 'settled', tenderException: { approvedBy: SUPERVISOR, reason: 'customer\'s card is closed — the bank letter seen (synthetic)' } });
    // One approval allows one refund.
    expect(codeOf(await refund('S-CARD', 'RT-8', 'cash', 5_000, { tenderExceptionApprovalId: exceptionId }))).toBe('approval_already_used');

    // ── A COLD RESTART: the exception is on the refund's own record, and on the sealed audit trail ──
    h = restart(h);
    const rt7 = (await recorded('S-CARD')).find((r) => r.returnId === 'RT-7')!;
    expect(rt7.tenderException).toMatchObject({ approvalId: exceptionId, approvedBy: SUPERVISOR, reason: expect.stringMatching(/card is closed/) });
    expect((await recorded('S-CARD')).find((r) => r.returnId === 'RT-1')!.tenderException).toBeUndefined();
    const trail = (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' })).map((e) => e.event.payload as { action: string; actorId: string; after: Record<string, string> | null });
    const sealed = trail.find((a) => a.action === 'refund.accept' && a.after?.['returnId'] === 'RT-7');
    expect(sealed).toMatchObject({ actorId: PROCESSOR, after: { tenderExceptionApprovedBy: SUPERVISOR } });
    // The restarted surface still refuses cash on the card bill without an exception.
    expect(codeOf(await refund('S-CARD', 'RT-9', 'cash', 5_000))).toBe('refund_not_to_source');
    // And after the exception refund, the card can still take its own back: ₹200 paid, ₹50 to the card, ₹50 in cash.
    expect((await refund('S-CARD', 'RT-10', 'card', 5_000)).body).toMatchObject({ refundSource: 'to_source' });
  }, 120_000);
});
