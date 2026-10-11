import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { withApprovals } from '../support/refund-approval';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { segmentDataAdapter } from '../../services/api/src/adapters';

/**
 * **FUL-10 — the customer record is built from what the customer actually bought and returned, and one person is one
 * record — merged only by two people, and reversibly (M16-FR-01 · M16-FR-04 · P-02 · P-04 · §28 · hard rules #2 #6).**
 *
 * The audit: the profile read facts somebody typed in by hand, so real sales never reached it; duplicates were only a
 * proposal and nothing could be merged or un-merged. Through the real API:
 *   • two member sales (one resent) and a walk-in are banked; the member's record shows two purchases, their loyalty
 *     standing, and nothing of the walk-in — derived from the banked sales, not typed;
 *   • a return against one sale shows on the record and CORRECTS that purchase's fact for segmentation (never deletes it);
 *   • a cashier cannot read a customer's record; every look by a manager is recorded and the owner can see who looked;
 *   • two records for one person merge only when one person proposes and ANOTHER approves; the survivor then counts both;
 *     the merged record points at the survivor; the merge is reversed as a new fact and the records separate again;
 *   • a household link shows on the record;
 *   • after a restart (a new process over the same store) the record is the same — nothing counted twice.
 *
 * In memory and, with DATABASE_URL, on real PostgreSQL. Synthetic data only.
 */

const KEY = loyaltyMemberKey(TEST_PACK_KEY);
const MEENA = memberRefFor(KEY, '98400 12345')!;
const MEENA_OLD = memberRefFor(KEY, '98400 67890')!; // the same person's old number, a second record
const RAVI = memberRefFor(KEY, '98400 11111')!;
const RAVI_WORK = memberRefFor(KEY, '98400 22222')!;
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
const backings: { name: string; harness: (store?: EventStore) => ApiHarness }[] = [{ name: 'the in-memory event store', harness: (store) => apiHarness(store === undefined ? {} : { store }) }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (store) => { const sql = pgPoolClient(pool!); return apiHarness({ store: store ?? new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface Profile {
  customerRef: string; identities: string[]; mergedInto?: string;
  purchases: { count: number; grossMinor: number; recent: { saleId: string }[] };
  returns: { count: number; refundedMinor: number };
  corrections: { count: number; creditedMinor: number; debitedMinor: number; recent: { noteId: string; saleId: string; kind: string; counted: boolean }[] };
  netSpendMinor: number; loyalty: { pointsBalance?: number; member?: { status: string; mobileLast4: string } };
  household: { householdId: string; members: string[] } | null;
}

describe.each(backings)('FUL-10 — the customer record from banked sales and returns; one governed identity — on $name', ({ harness }) => {
  it('derived purchases, returns and loyalty; least privilege and every look recorded; merge by two people, reversible; household; same after a restart', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (hh: ApiHarness, method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown, key?: string) =>
      hh.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${randomUUID()}` }) });
    const profile = async (ref: string, hh = h, user = 'u-mgr') => (await call(hh, 'GET', `/v1/customers/${ref}/profile`, user)).body as Profile;

    expect((await call(h, 'PUT', '/v1/platform/setup/loyalty.points_per_100_inr', 'u-owner', { value: 1 })).status).toBeLessThan(300);
    for (const mobile of ['98400 12345', '98400 67890', '98400 11111', '98400 22222']) {
      expect((await call(h, 'POST', '/v1/loyalty/members', 'u-mgr', { mobile, consent: true, verifiedHow: 'seen_on_phone' })).status).toBe(201);
    }
    const sale = (saleId: string, customerRef: string | undefined, totalMinor = 125_000) => ({
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-10', committedAt: new Date().toISOString(),
      totalMinor, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P1', quantityMinor: totalMinor / 25_000, uom: 'each', unitPriceMinor: 25_000, lineTotalMinor: totalMinor }],
      tenders: [{ kind: 'cash', amountMinor: totalMinor }], ...(customerRef === undefined ? {} : { customerRef }),
    });
    const bank = async (body: Record<string, unknown>, key = `bank-${String(body['saleId'])}`) => expect((await call(h, 'POST', '/v1/sales', 'u-cash', body, key)).status).toBe(202);
    await bank(sale('S1', MEENA));
    await bank(sale('S1', MEENA), 'bank-S1-resent'); // the till resends — one purchase
    await bank(sale('S2', MEENA));
    await bank(sale('S3', undefined)); // a walk-in: no personal data
    await bank(sale('S4', MEENA_OLD, 50_000));

    // ── 0 · Segmentation reads the facts DERIVED from those sales — nobody typed them, nobody opened a profile first.
    const audience = (await h.request({ method: 'GET', path: '/v1/customer/segments/audience', userId: 'u-owner', tenantId: T, query: { segment: 'new', purpose: 'service' } })).body as { customerRefs: string[] };
    expect(audience.customerRefs).toEqual([MEENA_OLD]); // one purchase → new; Meena's two → not new; the walk-in → nobody

    // ── 1 · The record is DERIVED from the banked sales: two purchases, the points they earned, no walk-in.
    const p1 = await profile(MEENA);
    expect(p1.purchases).toMatchObject({ count: 2, grossMinor: 250_000 });
    expect(p1.purchases.recent.map((x) => x.saleId).sort()).toEqual(['S1', 'S2']);
    expect(p1.loyalty).toMatchObject({ pointsBalance: 24, member: { status: 'member', mobileLast4: '2345' } });
    expect(JSON.stringify(p1)).not.toContain('98400');

    // ── 2 · A return against S1 shows, and CORRECTS S1's fact (₹1,250 → ₹750) — the purchase is never deleted.
    const ret = await withApprovals(h, T, 'u-owner', 'S1', { returnId: 'RT-1', reasonCode: 'customer_changed_mind', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 2, disposition: 'resell' }], refundMinor: 50_000, refundTender: 'cash', approvedBy: 'u-mgr' });
    expect((await call(h, 'POST', '/v1/sales/S1/returns', 'u-owner', ret, 'ret-RT-1')).status).toBe(201);
    const p2 = await profile(MEENA);
    expect(p2.purchases.count).toBe(2);
    expect(p2.returns).toMatchObject({ count: 1, refundedMinor: 50_000 });
    expect(p2.netSpendMinor).toBe(200_000);
    const facts = await segmentDataAdapter({ store: h.store, now: () => new Date().toISOString() }).orderFacts(T);
    expect(facts.filter((f) => f.customerRef === MEENA).map((f) => [f.orderId, f.netMinor]).sort()).toEqual([['S1', 75_000], ['S2', 125_000]]);

    // ── 2b · A sale CORRECTED after it was committed (FUL-10): a GST credit note against S2 (a price correction of ₹210)
    //    corrects Meena's facts like a return — a new fact; the purchase is never edited. A goods-returned credit note on S1,
    //    whose return is already recorded, is that return's tax document: kept, not counted twice.
    const creditNote = (noteId: string, saleId: string, reason: string, taxable: number, half: number) => ({
      noteId, number: `CN-${noteId}`, kind: 'credit_note', reason, customerId: MEENA, taxableMinor: taxable,
      taxes: [{ component: 'CGST', rateBps: 250, amountMinor: half }, { component: 'SGST', rateBps: 250, amountMinor: half }],
      invoice: { invoiceId: saleId, number: `R-${saleId}`, customerId: MEENA, issuedOn: '2026-10-10', taxableMinor: 119_048, taxes: [{ component: 'CGST', rateBps: 250, amountMinor: 2_976 }, { component: 'SGST', rateBps: 250, amountMinor: 2_976 }], grossMinor: 125_000, financialYear: '2026-27' },
      issuedOn: '2026-10-11',
    });
    expect((await call(h, 'POST', '/v1/finance/credit-notes', 'u-owner', creditNote('cn-1', 'S2', 'price_correction', 20_000, 500), 'cn-1')).status).toBe(201);
    expect((await call(h, 'POST', '/v1/finance/credit-notes', 'u-owner', creditNote('cn-2', 'S1', 'goods_returned', 47_619, 1_190), 'cn-2')).status).toBe(201);
    const p2b = await profile(MEENA);
    expect(p2b.corrections).toMatchObject({ count: 2, creditedMinor: 21_000, debitedMinor: 0 });
    expect(p2b.corrections.recent.map((c) => [c.noteId, c.saleId, c.counted]).sort()).toEqual([['cn-1', 'S2', true], ['cn-2', 'S1', false]]);
    expect(p2b.netSpendMinor).toBe(200_000 - 21_000);
    expect(p2b.purchases).toMatchObject({ count: 2, grossMinor: 250_000 });
    const facts2 = await segmentDataAdapter({ store: h.store, now: () => new Date().toISOString() }).orderFacts(T);
    expect(facts2.filter((f) => f.customerRef === MEENA).map((f) => [f.orderId, f.netMinor]).sort()).toEqual([['S1', 75_000], ['S2', 104_000]]);
    // Read again: nothing counted twice.
    expect((await profile(MEENA)).corrections).toMatchObject({ count: 2, creditedMinor: 21_000 });

    // ── 3 · Least privilege: a cashier cannot read it; every look is recorded, and the owner sees who looked.
    expect((await call(h, 'GET', `/v1/customers/${MEENA}/profile`, 'u-cash')).status).toBe(403);
    const views = (await call(h, 'GET', `/v1/customers/${MEENA}/profile/views`, 'u-owner')).body as { views: { viewedBy: string }[] };
    expect(views.views.length).toBeGreaterThanOrEqual(2);
    expect(new Set(views.views.map((v) => v.viewedBy))).toEqual(new Set(['u-mgr']));

    // ── 4 · One person, two records: proposed by the manager, approved by the OWNER (never by the proposer).
    await call(h, 'POST', `/v1/customers/${MEENA}/merges/m-1`, 'u-mgr', { mergedRef: MEENA_OLD, reason: 'same person, changed number' });
    expect((await call(h, 'POST', '/v1/customers/merges/m-1/approve', 'u-mgr', {})).status).toBe(403); // no approval authority
    // FUL-10: records that do not exist cannot be merged — not as the survivor, not as the merged record.
    const ghost = await call(h, 'POST', '/v1/customers/C-NOBODY/merges/m-ghost', 'u-mgr', { mergedRef: MEENA_OLD, reason: 'x' });
    expect(ghost.status).toBe(404);
    expect(codeOf(ghost)).toBe('customer_record_unknown');
    expect(codeOf(await call(h, 'POST', `/v1/customers/${RAVI}/merges/m-ghost2`, 'u-mgr', { mergedRef: 'C-NOBODY', reason: 'x' }))).toBe('customer_record_unknown');
    expect(((await call(h, 'GET', '/v1/customers/C-NOBODY/identity-history', 'u-mgr')).body as { merges: unknown[] }).merges).toEqual([]);
    expect((await call(h, 'POST', `/v1/customers/${RAVI}/merges/m-self`, 'u-owner', { mergedRef: RAVI_WORK, reason: 'x' })).status).toBe(201);
    expect(codeOf(await call(h, 'POST', '/v1/customers/merges/m-self/approve', 'u-owner', {}))).toBe('self_approval');
    await call(h, 'POST', '/v1/customers/merges/m-self/reverse', 'u-owner', { reason: 'proposed in error' });
    // Before approval the records are still apart.
    expect((await profile(MEENA)).purchases.count).toBe(2);
    expect((await call(h, 'POST', '/v1/customers/merges/m-1/approve', 'u-owner', {})).status).toBe(200);
    const merged = await profile(MEENA);
    expect(merged.identities).toEqual([MEENA, MEENA_OLD]);
    expect(merged.purchases).toMatchObject({ count: 3, grossMinor: 300_000 });
    expect((await profile(MEENA_OLD)).mergedInto).toBe(MEENA);
    // A record that holds another cannot itself be merged away; a merged record cannot be merged twice.
    expect(codeOf(await call(h, 'POST', `/v1/customers/${RAVI}/merges/m-2`, 'u-mgr', { mergedRef: MEENA, reason: 'no' }))).toBe('record_holds_merged_records');
    expect(codeOf(await call(h, 'POST', `/v1/customers/${RAVI_WORK}/merges/m-3`, 'u-mgr', { mergedRef: MEENA_OLD, reason: 'no' }))).toBe('record_already_merged');

    // ── 5 · A household link shows on the record.
    expect((await call(h, 'POST', `/v1/customers/${MEENA}/household`, 'u-mgr', { householdId: 'HH-7' })).status).toBe(201);
    expect((await profile(MEENA)).household).toEqual({ householdId: 'HH-7', members: [MEENA] });

    // ── 6 · After a restart (a new process over the same store): the same record, nothing counted twice.
    const restarted = harness(h.store);
    const again = await profile(MEENA, restarted);
    expect(again.purchases).toMatchObject({ count: 3, grossMinor: 300_000 });
    expect(again.returns.count).toBe(1);

    // ── 7 · The merge is REVERSED — a new fact; the records separate again and the history keeps all three stages.
    expect(codeOf(await call(restarted, 'POST', '/v1/customers/merges/m-1/reverse', 'u-owner', {}))).toBe('reversal_needs_a_reason');
    expect((await call(restarted, 'POST', '/v1/customers/merges/m-1/reverse', 'u-owner', { reason: 'two different people after all' })).status).toBe(200);
    expect((await profile(MEENA, restarted)).purchases.count).toBe(2);
    expect((await profile(MEENA_OLD, restarted)).purchases).toMatchObject({ count: 1, grossMinor: 50_000 });
    const history = (await call(restarted, 'GET', `/v1/customers/${MEENA}/identity-history`, 'u-mgr')).body as { merges: { mergeId: string; proposedBy: string; approvedBy?: string; reversedBy?: string; inForce: boolean }[] };
    expect(history.merges.find((m) => m.mergeId === 'm-1')).toMatchObject({ proposedBy: 'u-mgr', approvedBy: 'u-owner', reversedBy: 'u-owner', inForce: false });

    // ── 8 · A VOID after the sale was committed: the whole of S4 cancelled by a credit note — Meena's old record's facts are
    //    corrected to nothing spent, the purchase kept; processed by the restarted process, once.
    const s4Taxes = [{ component: 'CGST', rateBps: 250, amountMinor: 1_190 }, { component: 'SGST', rateBps: 250, amountMinor: 1_191 }];
    const voidNote = {
      noteId: 'cn-void', number: 'CN-cn-void', kind: 'credit_note', reason: 'order_cancelled', customerId: MEENA_OLD, taxableMinor: 47_619, taxes: s4Taxes,
      invoice: { invoiceId: 'S4', number: 'R-S4', customerId: MEENA_OLD, issuedOn: '2026-10-10', taxableMinor: 47_619, taxes: s4Taxes, grossMinor: 50_000, financialYear: '2026-27' },
      issuedOn: '2026-10-11',
    };
    expect((await call(restarted, 'POST', '/v1/finance/credit-notes', 'u-owner', voidNote, 'cn-void')).status).toBe(201);
    const old = await profile(MEENA_OLD, restarted);
    expect(old.purchases).toMatchObject({ count: 1, grossMinor: 50_000 });
    expect(old.corrections).toMatchObject({ count: 1, creditedMinor: 50_000 });
    expect(old.netSpendMinor).toBe(0);
    const facts3 = await segmentDataAdapter({ store: h.store, now: () => new Date().toISOString() }).orderFacts(T);
    expect(facts3.filter((f) => f.customerRef === MEENA_OLD).map((f) => [f.orderId, f.netMinor]).sort()).toEqual([['S4', 0]]);
    expect((await profile(MEENA_OLD, h)).corrections.count).toBe(1);
  }, 60_000);
});
