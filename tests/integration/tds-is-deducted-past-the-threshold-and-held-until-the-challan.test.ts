import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sentWithApproval } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { seedItcShop, ACCOUNTANT } from '../support/itc-shop';

/**
 * **R3 · A24 — TDS on supplier payments, built SWITCHED OFF (OB-143 "A"), on the real API, in memory AND on real
 * PostgreSQL, with a cold restart.** Signed sentence: "a payment to a payee tagged with a TDS section deducts at the
 * configured rate once the single/aggregate threshold is crossed. The payee is paid net. The TDS is a liability until a
 * challan reference is recorded. A quarterly 26Q summary is produced. A payment with no section tag to a payee flagged
 * "TDS applicable" is refused." The rates and thresholds here are SYNTHETIC stand-ins for the CA's own list.
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
const CA = 'u-ca';
const PAYER = 'u-acct-pay';
const PAY_APPROVER = 'u-acct-ok'; // OB-288 P3 (§28): the owner booked the goods in, so a different person approves paying for them
/** The CA's list — SYNTHETIC figures: 194C at 1%, single over ₹3,000 or the year over ₹10,000, catching the year up. */
const CA_LIST = {
  sections: [{ section: '194C', label: 'Contractors (synthetic)', rateBps: 100, singleThresholdMinor: 300_000, aggregateThresholdMinor: 1_000_000, onCrossing: 'whole_aggregate' }],
  payees: [
    { supplierId: 's-foods', tdsApplicable: true, section: '194C', pan: 'AAAPA1234A' },
    { supplierId: 's-oils', tdsApplicable: true },
  ],
};

describe.each(backings)('TDS is deducted past the threshold and held until the challan — on $name (A24)', ({ harness, restart }) => {
  it('switched off → the CA fills the list → the owner switches on → net payments past the threshold → refused without a section → liability → challan → 26Q', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, CA, 'chartered_accountant');
    await h.provisionRole(T, PAY_APPROVER, 'accountant');
    await h.provisionRole(T, PAYER, 'accountant'); // OB-288 P3 (§28): the accountant who matched the bills does not also pay them
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: idempotencyKey ?? `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    await seedItcShop({ call, owner: 'u-owner', grant: (u, r) => h.provisionRole(T, u, r), store: 'st-tds', createStore: true });
    const pay = (supplierId: string, paymentId: string, amountMinor: number, paidOn: string) => {
      const body = { amountMinor, paidOn, method: 'cash', reference: `CASH-${paymentId}` };
      return sentWithApproval(h, T, PAYER, PAY_APPROVER, { kind: 'supplier_payment', subjectRef: `${supplierId}/${paymentId}`, pathIds: { supplierId, paymentId }, valueMinor: amountMinor }, body,
        (b) => h.request({ method: 'POST', path: `/v1/purchase/suppliers/${supplierId}/payments/${paymentId}`, userId: PAYER, tenantId: T, idempotencyKey: `pay-${paymentId}`, body: b }));
    };
    const register = async () => (await call('GET', '/v1/finance/tds', ACCOUNTANT)).body as {
      enabled: boolean; state: string; config: { version: number; sections: unknown[] }; payeesWithoutSection: string[];
      liabilities: { paymentId: string; tdsMinor: number; state: string; challanRef: string | null }[]; openLiabilityMinor: number;
    };

    // ── SWITCHED OFF, the list EMPTY — and said so ──
    expect(await register()).toMatchObject({ enabled: false, config: { version: 0, sections: [] }, liabilities: [], openLiabilityMinor: 0 });
    expect((await register()).state).toMatch(/switched off\. The CA has not filled the payee, section and rate list yet/);
    const tooSoon = await call('POST', '/v1/finance/tds/switch', 'u-owner', { enabled: true, reason: 'try' });
    expect([tooSoon.status, codeOf(tooSoon)]).toEqual([409, 'tds_list_empty']);
    // A payment while off is paid gross, and the reply says why.
    const off = await pay('s-foods', 'pay-0', 100_000, '2026-10-20');
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body).toMatchObject({ netPaidMinor: 100_000, tds: { outcome: 'switched_off' } });
    expect((off.body as { payment: Record<string, unknown> }).payment['tds']).toBeUndefined();

    // ── THE CA FILLS THE LIST; only the CA may; the list cannot switch itself on ──
    expect((await call('POST', '/v1/finance/tds/config', 'u-owner', CA_LIST)).status).toBe(403);
    expect((await call('POST', '/v1/finance/tds/config', ACCOUNTANT, CA_LIST)).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/finance/tds/config', CA, { ...CA_LIST, enabled: true }))).toBe('tds_config_cannot_switch');
    expect(codeOf(await call('POST', '/v1/finance/tds/config', CA, { ...CA_LIST, sections: [{ ...CA_LIST.sections[0]!, rateBps: 0 }] }))).toBe('tds_list_not_valid');
    const set = await call('POST', '/v1/finance/tds/config', CA, CA_LIST);
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body).toMatchObject({ config: { version: 1, setBy: CA }, payeesWithoutSection: ['s-oils'], enabled: false });
    expect((await register()).state).toMatch(/switched off\. The CA's list is filled; it takes effect when the owner switches it on/);
    // Still off: a payment is still gross.
    expect((await pay('s-foods', 'pay-0b', 50_000, '2026-10-21')).body).toMatchObject({ netPaidMinor: 50_000, tds: { outcome: 'switched_off' } });

    // ── ONLY THE OWNER SWITCHES IT ON ──
    expect((await call('POST', '/v1/finance/tds/switch', CA, { enabled: true, reason: 'x' })).status).toBe(403);
    expect((await call('POST', '/v1/finance/tds/switch', ACCOUNTANT, { enabled: true, reason: 'x' })).status).toBe(403);
    expect((await call('POST', '/v1/finance/tds/switch', 'u-owner', { enabled: true, reason: 'CA has signed the list (synthetic)' })).status).toBe(201);
    expect(await register()).toMatchObject({ enabled: true, state: expect.stringMatching(/switched on/) });

    // ── A payee flagged "TDS applicable" with no section: REFUSED, nothing recorded ──
    const untagged = await pay('s-oils', 'pay-oils', 10_000, '2026-10-22');
    expect([untagged.status, codeOf(untagged)]).toEqual([422, 'tds_section_missing']);
    expect((await call('GET', '/v1/purchase/suppliers/s-oils', ACCOUNTANT)).body).not.toMatchObject({ payments: [expect.objectContaining({ paymentId: 'pay-oils' })] });

    // ── Below the thresholds: ₹1,000 + ₹500 earlier this year, now ₹1,000 (single ₹3,000 · year ₹10,000) → gross ──
    expect((await pay('s-foods', 'pay-1', 100_000, '2026-10-23')).body).toMatchObject({ netPaidMinor: 100_000, tds: { outcome: 'below_threshold' } });
    // ── Single crossed: ₹3,500 in one payment → 1% withheld, paid net ──
    const single = await pay('s-foods', 'pay-2', 350_000, '2026-10-24');
    expect(single.status, JSON.stringify(single.body)).toBe(201);
    expect(single.body).toMatchObject({ netPaidMinor: 346_500, payment: { amountMinor: 350_000, tds: { section: '194C', rateBps: 100, baseMinor: 350_000, tdsMinor: 3_500, netMinor: 346_500 } } });
    // ── Year crossed: ₹6,000 so far + ₹5,000 = ₹11,000 > ₹10,000 → the CA's catch-up: 1% of ₹11,000 less the ₹3,500 already
    //    deducted on = ₹75 ──
    const yearly = await pay('s-foods', 'pay-3', 500_000, '2026-10-25');
    expect(yearly.body).toMatchObject({ netPaidMinor: 492_500, payment: { tds: { baseMinor: 750_000, tdsMinor: 7_500 } } });

    // ── A COLD RESTART ──
    h = restart(h);
    let reg = await register();
    expect(reg.liabilities.map((l) => [l.paymentId, l.tdsMinor, l.state])).toEqual([['pay-2', 3_500, 'liability'], ['pay-3', 7_500, 'liability']]);
    expect(reg.openLiabilityMinor).toBe(11_000);

    // ── THE CHALLAN: refused unless it names exactly the deductions to the paisa; then deposited ──
    expect((await call('POST', '/v1/finance/tds/challans/ch-1', CA, { challanRef: 'x', depositedOn: '2026-11-07', paymentIds: ['pay-2'], amountMinor: 3_500 })).status).toBe(403);
    const short = await call('POST', '/v1/finance/tds/challans/ch-1', ACCOUNTANT, { challanRef: 'BSR 0001234 07-11-2026 00042', depositedOn: '2026-11-07', paymentIds: ['pay-2', 'pay-3'], amountMinor: 10_000 });
    expect([short.status, codeOf(short)]).toEqual([422, 'tds_challan_does_not_match']);
    const noTds = await call('POST', '/v1/finance/tds/challans/ch-1', ACCOUNTANT, { challanRef: 'BSR 0001234 07-11-2026 00042', depositedOn: '2026-11-07', paymentIds: ['pay-1'], amountMinor: 1 });
    expect(codeOf(noTds)).toBe('tds_challan_does_not_match');
    const ch = await call('POST', '/v1/finance/tds/challans/ch-1', ACCOUNTANT, { challanRef: 'BSR 0001234 07-11-2026 00042', depositedOn: '2026-11-07', paymentIds: ['pay-2'], amountMinor: 3_500 });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    reg = await register();
    expect(reg.liabilities.map((l) => [l.paymentId, l.state, l.challanRef])).toEqual([['pay-2', 'deposited', 'BSR 0001234 07-11-2026 00042'], ['pay-3', 'liability', null]]);
    expect(reg.openLiabilityMinor).toBe(7_500);
    expect(codeOf(await call('POST', '/v1/finance/tds/challans/ch-2', ACCOUNTANT, { challanRef: 'BSR-2', depositedOn: '2026-11-07', paymentIds: ['pay-2'], amountMinor: 3_500 }))).toBe('tds_challan_does_not_match');

    // ── THE QUARTERLY 26Q (FY 2026-27, Q3: October–December) ──
    expect((await call('GET', '/v1/finance/tds/26q/2026-28/Q3', ACCOUNTANT)).status).toBe(400);
    const q3 = (await call('GET', '/v1/finance/tds/26q/2026-27/Q3', CA)).body as Record<string, unknown>;
    expect(q3).toMatchObject({
      financialYear: '2026-27', quarter: 'Q3', enabled: true, totalTdsMinor: 11_000, depositedMinor: 3_500, undeposited: ['pay-3'], withoutPan: [],
      bySection: [{ section: '194C', count: 2, paidMinor: 850_000, tdsMinor: 11_000, depositedMinor: 3_500 }],
    });
    expect((q3['rows'] as { paymentId: string; pan: string; challanRef: string | null }[]).map((r) => [r.paymentId, r.pan, r.challanRef])).toEqual([['pay-2', 'AAAPA1234A', 'BSR 0001234 07-11-2026 00042'], ['pay-3', 'AAAPA1234A', null]]);
    expect((await call('GET', '/v1/finance/tds/26q/2026-27/Q3', 'u-buyer')).status).toBe(403);

    // ── Switched off again by the owner: the next payment is gross, the history stands (append-only) ──
    expect((await call('POST', '/v1/finance/tds/switch', 'u-owner', { enabled: false, reason: 'synthetic pause' })).status).toBe(201);
    expect((await pay('s-foods', 'pay-4', 100_000, '2026-10-26')).body).toMatchObject({ netPaidMinor: 100_000, tds: { outcome: 'switched_off' } });
    expect((await register()).liabilities).toHaveLength(2);
  }, 120_000);
});
