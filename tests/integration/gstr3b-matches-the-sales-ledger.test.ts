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

/**
 * **R3 A15 + A16 — GSTR-3B matches the till, and locks to the filed GSTR-1 (signed OB-188), in memory AND on real
 * PostgreSQL, with cold restarts.**
 *
 * May 2026: two sales banked at the till and a return processed in the month. GSTR-3B Table 3.1(a) is the net, to the
 * paisa: equal to the till's banked sales less returns and to GSTR-1's total, with no difference. Monthly periods only:
 * a quarter is refused. Before GSTR-1 is filed the figure is provisional; an attempt to change it is refused; it cannot
 * be locked. GSTR-1 is previewed (by a maker, with the digest head office gave), approved by a different person and
 * filed (sandbox). After a restart, GSTR-3B is LOCKED to it. A sale then banked late for May is a NAMED difference — the
 * filed figure stands — until an amendment of May carries it into June's GSTR-1 as a compensating entry. A second
 * amendment has nothing to carry. June's GSTR-3B declares it and names it. GSTR-3B for May is recorded filed; June's
 * cannot be (not locked). A cashier is refused (403) everywhere. ITC is "not yet reconciled" — an exception, not zero.
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
  const sqlHarness = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const GSTIN = '33ABCDE1234F1Z5';
interface Heads { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }
interface Diff { code: string; explained: boolean; grossMinor: number; amendmentId?: string }
interface G3b {
  period: string; basis: string; editable: boolean; table31: { a: Heads; c: { taxableMinor: number }; d: Heads };
  table4: { a5AllOther: { status: string } }; gstr1PreviewDigest: string;
  reconciliation: { equalsGstr1: boolean; equalsSalesLedger: boolean; differences: Diff[]; salesLedger: { netGrossMinor: number } };
  exceptions: { code: string }[];
}

describe.each(backings)('GSTR-3B matches the sales ledger and locks to the filed GSTR-1 — on $name (A15 · A16)', ({ harness, restart }) => {
  it('provisional → refused edits → GSTR-1 filed → locked → late sale named → amendment into June → recorded filed', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner'): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const sell = (saleId: string, productId: string, qty: number, lineTotalMinor: number, tradingDay: string, hsnCode: string, taxRateBps: number) => ok(req('POST', '/v1/sales', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay, committedAt: `${tradingDay}T05:30:00Z`,
      totalMinor: lineTotalMinor, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: lineTotalMinor / qty, lineTotalMinor, hsnCode, taxRateBps }],
      tenders: [{ kind: 'cash', amountMinor: lineTotalMinor }],
    }), `sale ${saleId}`);
    const g3b = async (period: string): Promise<G3b> => (await ok(req('GET', `/v1/finance/gstr3b/${period}`), `3B ${period}`)).body as G3b;

    // ── May 2026 at the till: paneer ×2 (₹210 at 5%), ghee (₹118 at 18%), one paneer returned (₹105) ──────────────
    await sell('S-1', 'p-paneer', 2, 21_000, '2026-05-10', '040610', 500);
    await sell('S-2', 'p-ghee', 1, 11_800, '2026-05-12', '040590', 1800);
    await ok(h.request({
      method: 'POST', path: '/v1/sales/S-1/returns', userId: 'u-owner', tenantId: T, idempotencyKey: 'ret-1',
      body: await withApprovals(h, T, 'u-owner', 'S-1', { returnId: 'RT-1', number: 'RT-1', reasonCode: 'changed_mind', refundMinor: 10_500, refundTender: 'cash', approvedBy: 'u-mgr', processedAt: '2026-05-20T06:00:00Z', lines: [{ productId: 'p-paneer', quantityMinor: 1, uom: 'each', disposition: 'resell' }] }),
    }), 'return');

    // ── A15: 3.1(a) equals the till and GSTR-1, to the paisa ──────────────────────────────────────────────────────
    let may = await g3b('052026');
    expect(may.table31.a).toEqual({ taxableMinor: 20_000, cgstMinor: 1_150, sgstMinor: 1_150, igstMinor: 0 });
    expect(may.reconciliation.salesLedger.netGrossMinor).toBe(21_000 + 11_800 - 10_500);
    expect(may.table31.a.taxableMinor + may.table31.a.cgstMinor + may.table31.a.sgstMinor).toBe(may.reconciliation.salesLedger.netGrossMinor);
    expect(may.reconciliation.equalsGstr1).toBe(true);
    expect(may.reconciliation.equalsSalesLedger).toBe(true);
    expect(may.reconciliation.differences).toEqual([]);
    expect(may.basis).toBe('provisional_gstr1_not_filed');
    expect(may.editable).toBe(false);
    expect(may.table4.a5AllOther.status).toBe('not_reconciled');
    expect(may.exceptions.map((e) => e.code).sort()).toEqual(['gstr1_not_filed', 'itc_not_yet_reconciled']);

    // Monthly only (D2); a cashier may not read it; an edit is refused; nothing can be locked yet.
    expect(codeOf(await req('GET', '/v1/finance/gstr3b/Q1-2026'))).toBe('gst_period_must_be_a_month');
    expect((await req('GET', '/v1/finance/gstr3b/052026', undefined, 'u-cash')).status).toBe(403);
    expect((await req('POST', '/v1/finance/gstr3b/052026/lock', {}, 'u-cash')).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/finance/gstr3b/052026/outward-liability', { taxableMinor: 1 }))).toBe('gstr3b_outward_derived_from_stored_sales');
    expect(codeOf(await req('POST', '/v1/finance/gstr3b/052026/lock', {}))).toBe('gstr3b_gstr1_not_filed');
    expect(codeOf(await req('POST', '/v1/finance/gstr3b/052026/amendments/AM-0', { reason: 'too early' }))).toBe('amendment_not_locked');

    // ── GSTR-1 for May: a maker previews the digest head office gave, a DIFFERENT person approves, it is filed ───────
    await ok(req('POST', '/v1/finance/gstr1/submission/052026/preview', { returnDigest: may.gstr1PreviewDigest }, 'u-mgr'), 'preview');
    await ok(req('POST', '/v1/finance/gstr1/submission/052026/approve', {}), 'approve');
    await ok(req('POST', '/v1/finance/gstr1/submission/052026/submit', { gstin: GSTIN, digest: may.gstr1PreviewDigest }), 'file');

    // ── a cold restart: everything below is rebuilt from the store ────────────────────────────────────────────────
    h = restart(h);
    may = await g3b('052026');
    expect(may.basis).toBe('gstr1_filed_not_yet_locked');
    await ok(req('POST', '/v1/finance/gstr3b/052026/lock', {}, 'u-mgr'), 'lock');
    may = await g3b('052026');
    expect(may.basis).toBe('locked_to_filed_gstr1');
    expect(may.exceptions.map((e) => e.code)).toEqual(['itc_not_yet_reconciled']); // the digest matched: no mismatch
    expect(((await req('POST', '/v1/finance/gstr3b/052026/lock', {})).body as { alreadyLocked?: boolean }).alreadyLocked).toBe(true);
    expect(codeOf(await req('POST', '/v1/finance/gstr3b/052026/outward-liability', { taxableMinor: 1 }))).toBe('gstr3b_outward_locked_to_filed_gstr1');

    // ── a paneer sale for 30 May reaches head office after filing: named, never absorbed; the filed figure stands ─────
    await sell('S-3', 'p-paneer', 1, 10_500, '2026-05-30', '040610', 500);
    may = await g3b('052026');
    expect(may.table31.a.taxableMinor).toBe(20_000);
    expect(may.reconciliation.differences).toEqual([expect.objectContaining({ code: 'changed_after_gstr1_filed', explained: false, grossMinor: 10_500 })]);
    expect(may.exceptions.map((e) => e.code)).toContain('reconciliation_difference');

    // ── the correction: an amendment of May, declared in June's GSTR-1 (a compensating event) ─────────────────────
    expect((await req('POST', '/v1/finance/gstr3b/052026/amendments/AM-1', { reason: 'x' }, 'u-cash')).status).toBe(403);
    const am = await ok(req('POST', '/v1/finance/gstr3b/052026/amendments/AM-1', { reason: 'sale S-3 synced after GSTR-1 was filed' }, 'u-mgr'), 'amend');
    expect((am.body as { amendment: { intoPeriod: string } }).amendment.intoPeriod).toBe('062026');
    expect(((await req('POST', '/v1/finance/gstr3b/052026/amendments/AM-1', { reason: 'again' }, 'u-mgr')).body as { alreadyRecorded?: boolean }).alreadyRecorded).toBe(true);
    expect(codeOf(await req('POST', '/v1/finance/gstr3b/052026/amendments/AM-2', { reason: 'again' }, 'u-mgr'))).toBe('amendment_nothing_to_amend');
    h = restart(h);
    may = await g3b('052026');
    expect(may.reconciliation.differences.map((d) => [d.code, d.explained])).toEqual([['carried_by_amendment', true]]);
    const june = await g3b('062026');
    expect(june.table31.a).toEqual({ taxableMinor: 10_000, cgstMinor: 250, sgstMinor: 250, igstMinor: 0 });
    expect(june.reconciliation.differences).toEqual([expect.objectContaining({ code: 'amendment_from_earlier_period', explained: true, amendmentId: 'AM-1', grossMinor: 10_500 })]);

    // ── GSTR-3B for May recorded filed (only once); June's cannot be — it is not locked to a filed GSTR-1 ───────────
    expect((await req('POST', '/v1/finance/returns/GSTR3B/052026/filed', { arn: 'AA3305260000001', filedOn: '2026-06-19' }, 'u-mgr')).status).toBe(403);
    await ok(req('POST', '/v1/finance/returns/GSTR3B/052026/filed', { arn: 'AA3305260000001', filedOn: '2026-06-19' }), 'record 3B');
    expect(codeOf(await req('POST', '/v1/finance/returns/GSTR3B/052026/filed', { arn: 'AA3305260000001', filedOn: '2026-06-19' }))).toBe('return_already_filed');
    expect(codeOf(await req('POST', '/v1/finance/returns/GSTR3B/062026/filed', { arn: 'AA3306260000001', filedOn: '2026-07-19' }))).toBe('gstr3b_not_locked_to_gstr1');
    // A filed return is recorded once; a GSTR-1 in this system's submission store cannot be typed in as "filed elsewhere".
    expect(codeOf(await req('POST', '/v1/finance/returns/GSTR1/052026/filed', { arn: 'X', filedOn: '2026-06-10' }))).toBe('return_already_filed');
    await ok(req('POST', '/v1/finance/gstr1/submission/062026/preview', { returnDigest: june.gstr1PreviewDigest }, 'u-mgr'), 'preview June');
    expect(codeOf(await req('POST', '/v1/finance/returns/GSTR1/062026/filed', { arn: 'X', filedOn: '2026-07-10' }))).toBe('gstr1_filed_through_this_system');
  }, 60_000);
});
