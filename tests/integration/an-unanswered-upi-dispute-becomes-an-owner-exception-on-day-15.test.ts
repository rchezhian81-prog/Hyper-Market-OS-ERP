import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **R3 · C14 — card and UPI disputes, on the real API, in memory AND on real PostgreSQL, with a cold restart.** Signed
 * sentence: "A UPI or card dispute is recorded with its received date and a response due date (UPI: 15 days). A dispute
 * not answered by the due date is an owner exception. A lost dispute posts as a compensating entry." Dates are fixed in
 * the data (`asOf`), never today's clock.
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
interface Register {
  upiResponseDays: number; open: number; lostMinor: number;
  disputes: { disputeId: string; state: string; respondBy: string; overdue: boolean; answeredLate: boolean }[];
  ownerExceptions: { disputeId: string; daysOverdue: number; headline: string }[];
  lossEntries: { entryId: string; amountMinor: number; lines: unknown[] }[];
}

describe.each(backings)('an unanswered UPI dispute becomes an owner exception after day 15 — on $name (C14)', ({ harness, restart }) => {
  it('recorded with its received date and due date → not answered in time → the owner sees it → answered late → lost → compensating entry', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const bank = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-owner', tenantId: T, idempotencyKey: 'bank-S-UPI', body: {
      saleId: 'S-UPI', receiptNumber: 'R-UPI', laneId: 'lane-1', cashierId: 'u-till', tradingDay: '2026-09-28', committedAt: '2026-09-28T10:00:00.000Z',
      totalMinor: 15_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 15_000 }],
      tenders: [{ kind: 'upi', amountMinor: 15_000, ref: 'upi_synthetic_9' }],
    } });
    expect(bank.status).toBe(202);
    const register = async (asOf: string, who = 'u-owner') => {
      const r = await call('GET', '/v1/finance/payment-disputes', who, undefined, { asOf });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Register;
    };
    const UPI = { instrument: 'upi', saleId: 'S-UPI', providerRef: 'NPCI-UDIR-SYN-0001', amountMinor: 15_000, receivedOn: '2026-10-01', reason: 'customer says goods not received (synthetic)' };

    // Who may: the accountant and the owner record; a cashier and a store manager may not record or read.
    expect((await call('POST', '/v1/finance/payment-disputes/D-1', 'u-till', UPI)).status).toBe(403);
    expect((await call('GET', '/v1/finance/payment-disputes', 'u-mgr')).status).toBe(403);
    // Never card data; never more than the bill paid by that instrument; a bill head office never banked is not found.
    expect(codeOf(await call('POST', '/v1/finance/payment-disputes/D-1', 'u-acct', { ...UPI, providerRef: '4111 1111 1111 1111' }))).toBe('looks_like_card_data');
    expect(codeOf(await call('POST', '/v1/finance/payment-disputes/D-1', 'u-acct', { ...UPI, amountMinor: 15_001 }))).toBe('dispute_more_than_paid');
    expect((await call('POST', '/v1/finance/payment-disputes/D-1', 'u-acct', { ...UPI, saleId: 'S-NONE' })).status).toBe(404);

    // RECORDED: the UPI answer is due 15 days after receipt — computed; a typed date does not move it.
    const rec = await call('POST', '/v1/finance/payment-disputes/D-1', 'u-acct', { ...UPI, respondBy: '2026-12-31' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body).toMatchObject({ dispute: { disputeId: 'D-1', instrument: 'upi', receivedOn: '2026-10-01', respondBy: '2026-10-16', recordedBy: 'u-acct' } });
    expect(((await call('POST', '/v1/finance/payment-disputes/D-1', 'u-acct', UPI)).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
    // A card dispute takes the reply-by date from the bank's notice — and is refused without one.
    expect(codeOf(await call('POST', '/v1/finance/payment-disputes/D-2', 'u-acct', { instrument: 'card', providerRef: 'ARN-SYN-77', amountMinor: 9_900, receivedOn: '2026-10-05', reason: 'not recognised (synthetic)' }))).toBe('dispute_due_date_not_known');
    expect((await call('POST', '/v1/finance/payment-disputes/D-2', 'u-acct', { instrument: 'card', providerRef: 'ARN-SYN-77', amountMinor: 9_900, receivedOn: '2026-10-05', respondBy: '2026-10-25', reason: 'not recognised (synthetic)' })).status).toBe(201);

    // ON THE DUE DATE (day 15): not yet an exception. THE DAY AFTER: the owner's exception, by name.
    let reg = await register('2026-10-16');
    expect(reg.upiResponseDays).toBe(15);
    expect(reg.ownerExceptions).toEqual([]);
    reg = await register('2026-10-17');
    expect(reg.ownerExceptions.map((e) => [e.disputeId, e.daysOverdue])).toEqual([['D-1', 1]]);
    expect(reg.ownerExceptions[0]!.headline).toBe('UPI dispute NPCI-UDIR-SYN-0001 for ₹150.00 was due an answer by 2026-10-16 — 1 day(s) late and still not answered');
    expect(reg.disputes.find((d) => d.disputeId === 'D-1')).toMatchObject({ state: 'open', overdue: true });

    // ── A COLD RESTART ──
    h = restart(h);
    expect((await register('2026-10-17')).ownerExceptions.map((e) => e.disputeId)).toEqual(['D-1']);

    // ANSWERED (late): off the owner's exception list, and the lateness is said.
    expect(codeOf(await call('POST', '/v1/finance/payment-disputes/D-1/response', 'u-acct', { respondedOn: '2026-09-30', evidenceRef: 'EVID-1' }))).toBe('answered_before_received');
    const ans = await call('POST', '/v1/finance/payment-disputes/D-1/response', 'u-acct', { respondedOn: '2026-10-18', evidenceRef: 'EVID-PACK-SYN-1 (bill copy + doorstep photo)' });
    expect(ans.status, JSON.stringify(ans.body)).toBe(201);
    expect(ans.body).toMatchObject({ answeredLate: true });
    reg = await register('2026-10-19');
    expect(reg.ownerExceptions).toEqual([]);
    expect(reg.disputes.find((d) => d.disputeId === 'D-1')).toMatchObject({ state: 'answered', answeredLate: true, overdue: false });
    // The card dispute, unanswered past its bank date, reaches the owner too.
    expect((await register('2026-10-26')).ownerExceptions.map((e) => e.disputeId)).toEqual(['D-2']);

    // LOST: a compensating entry posts once — the sale is not edited; a different outcome later is refused.
    const lost = await call('POST', '/v1/finance/payment-disputes/D-1/outcome', 'u-acct', { outcome: 'lost', decidedOn: '2026-11-02' });
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);
    expect(lost.body).toMatchObject({ outcome: { outcome: 'lost', lossEntry: { entryId: 'dispute-loss-D-1', saleId: 'S-UPI', amountMinor: 15_000, lines: [{ account: 'chargeback_loss', debitMinor: 15_000 }, { account: 'card_upi_settlement_receivable', creditMinor: 15_000 }] } } });
    expect(codeOf(await call('POST', '/v1/finance/payment-disputes/D-1/outcome', 'u-acct', { outcome: 'won', decidedOn: '2026-11-03' }))).toBe('dispute_already_decided');
    expect(((await call('POST', '/v1/finance/payment-disputes/D-1/outcome', 'u-acct', { outcome: 'lost', decidedOn: '2026-11-02' })).body as { alreadyRecorded: boolean }).alreadyRecorded).toBe(true);
    reg = await register('2026-11-03');
    expect(reg.lostMinor).toBe(15_000);
    expect(reg.lossEntries.map((e) => e.entryId)).toEqual(['dispute-loss-D-1']);
    expect(reg.disputes.find((d) => d.disputeId === 'D-1')!.state).toBe('lost');
    // The bill itself is untouched — still banked as it was.
    const held = await h.store.findByIdempotencyKey(T, `sale-${T}-S-UPI`);
    expect((held!.event.payload as { totalMinor: number }).totalMinor).toBe(15_000);
    // A won dispute posts nothing.
    expect((await call('POST', '/v1/finance/payment-disputes/D-2/outcome', 'u-owner', { outcome: 'won', decidedOn: '2026-11-04' })).body).toMatchObject({ outcome: { outcome: 'won', lossEntry: null } });
    expect((await register('2026-11-05')).lostMinor).toBe(15_000);
  }, 120_000);
});
