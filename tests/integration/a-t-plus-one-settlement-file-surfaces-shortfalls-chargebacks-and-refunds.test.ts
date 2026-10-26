import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **C13 (v2.1 addendum · M23/M14 · P-08) — POS, UPI and card captures are matched to the aggregator's T+1 settlement file;
 * shortfalls, chargebacks and refunds surface as exceptions.** On the real API, in memory and (with DATABASE_URL) on real
 * PostgreSQL. The file is uploaded by a person (there is no live provider):
 *   • the till banks a card sale, a UPI sale and another card sale yesterday, and refunds part of the first card sale today
 *     (through the real returns route, approved by a second person);
 *   • the aggregator's file for today pays the UPI sale and the second card sale in full, the first card sale SHORT, debits
 *     the till's refund exactly, takes back the UPI sale as a CHARGEBACK, and debits a refund the till never gave;
 *   • the review at T+1 matches two captures and one refund, and surfaces the shortfall, the chargeback (linked to its sale)
 *     and the unexplained refund, each valued; a file whose refund names no original is refused; a cashier may neither
 *     upload nor review; another shop sees nothing.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASHIER = 'u-cash';
const DAY = 86_400_000;
const today = shopDateIn(new Date().toISOString());
const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const sale = (saleId: string, kind: 'card' | 'upi', ref: string, amount: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER,
  tradingDay: yesterday, committedAt: `${yesterday}T10:00:00.000Z`, totalMinor: amount, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: amount, lineTotalMinor: amount }],
  tenders: [{ kind, amountMinor: amount, ref }],
});

interface Exc { finding: string; ref: string; valueMinor: number; tenderId?: string; settlementId?: string; needsInvestigation: boolean }
interface Review { matchedCount: number; matchedRefundCount: number; atRiskValueMinor: number; exceptions: Exc[]; detail: string }

describe.each(backings)('C13 — a T+1 settlement file surfaces shortfalls, chargebacks and refunds — on $name', ({ harness }) => {
  it('matches captures and refunds to the uploaded file; the shortfall, the chargeback and the unexplained refund are exceptions', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, CASHIER, 'cashier');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });

    const pfx = T.slice(0, 8);
    const C1 = `CARD-${pfx}-1`; const U2 = `UPI-${pfx}-2`; const C3 = `CARD-${pfx}-3`;
    for (const s of [sale('S1', 'card', C1, 50_000), sale('S2', 'upi', U2, 20_000), sale('S3', 'card', C3, 30_000)]) {
      const r = await call('POST', '/v1/sales', OWNER, s);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    // Today the till refunds ₹50 of the first card sale back to the card (approved by the store manager).
    const refundBody = await withApprovals(h, T, OWNER, 'S1', { returnId: 'RT1', reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }], refundMinor: 5_000, refundTender: 'card', approvedBy: MGR });
    const ret = await h.request({ method: 'POST', path: '/v1/sales/S1/returns', userId: OWNER, tenantId: T, idempotencyKey: 'ret-RT1', body: refundBody });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);

    const file = {
      batchId: `AGG-${pfx}-${today}`, providerId: 'example-aggregator', currency: 'INR', settlementDate: today, sourceName: 'aggregator-settlement.csv',
      lines: [
        { id: 'L1', ref: U2, amountMinor: 20_000 },
        { id: 'L2', ref: C1, amountMinor: 49_000 },
        { id: 'L3', ref: C3, amountMinor: 30_000 },
        { id: 'L4', ref: 'RF-1', type: 'refund', originalRef: C1, amountMinor: 5_000 },
        { id: 'L5', ref: 'CB-1', type: 'chargeback', originalRef: U2, amountMinor: 20_000 },
        { id: 'L6', ref: 'RF-2', type: 'refund', originalRef: C3, amountMinor: 2_000 },
      ],
      declaredGrossMinor: 72_000, declaredFeesMinor: 720, declaredNetMinor: 71_280,
    };
    // A cashier may not upload the file; a refund line that names no original is refused, and nothing is kept.
    expect((await call('POST', '/v1/settlement/batches', CASHIER, file)).status).toBe(403);
    const orphan = { ...file, batchId: `${file.batchId}-x`, lines: [...file.lines.slice(0, 3), { id: 'Lx', ref: 'RF-x', type: 'refund', amountMinor: 1 }], declaredGrossMinor: 98_999, declaredFeesMinor: 0, declaredNetMinor: 98_999 };
    const refused = await call('POST', '/v1/settlement/batches', OWNER, orphan);
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('reversal_without_an_original');
    const up = await call('POST', '/v1/settlement/batches', OWNER, file);
    expect(up.status, JSON.stringify(up.body)).toBe(201);

    const q = { date: today, cycleDays: '1', windowDays: '7' };
    expect((await call('GET', '/v1/settlement/review', CASHIER, undefined, q)).status).toBe(403);
    const res = await call('GET', '/v1/settlement/review', OWNER, undefined, q);
    expect(res.status).toBe(200);
    const r = res.body as Review;
    expect(r.matchedCount).toBe(2); // U2 and C3 paid in full
    expect(r.matchedRefundCount).toBe(1); // RT1 ↔ L4
    const by = (f: string) => r.exceptions.filter((e) => e.finding === f);
    expect(by('chargeback')).toEqual([expect.objectContaining({ ref: U2, tenderId: 'S2:t0', settlementId: 'L5', valueMinor: 20_000, needsInvestigation: true })]);
    expect(by('short_settled')).toEqual([expect.objectContaining({ ref: C1, valueMinor: 1_000, needsInvestigation: true })]);
    expect(by('refund_without_a_till_record')).toEqual([expect.objectContaining({ ref: C3, settlementId: 'L6', valueMinor: 2_000, needsInvestigation: true })]);
    expect(r.exceptions[0]?.finding).toBe('chargeback');
    expect(r.atRiskValueMinor).toBe(23_000);
    expect(r.detail).toContain('1 refund(s) matched');

    // A case can be opened on the chargeback, owned by a named person.
    const open = await call('POST', '/v1/settlement/investigations', OWNER, { investigationId: `inv-${pfx}`, exception: by('chargeback')[0], ownerId: MGR, dueBy: today });
    expect(open.status, JSON.stringify(open.body)).toBe(201);

    // Another shop sees none of it.
    const OTHER = randomUUID();
    await h.seedOwner(OTHER, 'u-owner-b');
    const rb = (await h.request({ method: 'GET', path: '/v1/settlement/review', userId: 'u-owner-b', tenantId: OTHER, query: q })).body as Review;
    expect(rb.exceptions).toEqual([]);
    expect(rb.matchedCount).toBe(0);
  });
});
