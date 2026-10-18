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
 * **R3 A14 — the reverse-charge self-invoice (signed OB-188; OB-143 "A" built SWITCHED OFF), in memory AND on real
 * PostgreSQL, with a cold restart.**
 *
 * It starts switched off with no heads: a freight purchase from an unregistered transporter raises nothing, and the GST
 * controls say so. The CA — and only the CA — lists the "goods transport agency" head; only the owner switches reverse
 * charge on. Then: a purchase under the head gets a self-invoice from the shop's own gap-free series (RCM/2627/000001,
 * …0002, two at once …0003 and …0004 — never one number twice, none skipped); a purchase under a head that is not
 * configured raises no RCM; an unregistered supplier with no configured head is an exception; a supplier not in the
 * master is refused. GSTR-3B Table 3.1(d) carries the liability, paid in cash only (set off against ITC: 0); its ITC
 * (4(A)(3)) appears only in the month the liability is marked paid with a challan. Paying a purchase with no liability is
 * refused. After a restart the series carries on at …0005.
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
const GTA = { name: 'Goods transport agency (synthetic)', rateBps: 500, notifiedUnder: 'Notfn 13/2017-CT(R) entry 1 (synthetic)' };
interface Heads { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }

describe.each(backings)('the reverse-charge self-invoice is gap-free and cash-only — on $name (A14)', ({ harness, restart }) => {
  it('switched off → CA lists a head → owner switches on → gap-free self-invoices → 3.1(d) cash-only → ITC only once paid', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-ca', 'chartered_accountant');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const req = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, userId = 'u-owner'): Promise<Res> => {
      const [path, qs] = url.split('?');
      return h.request({ method, path: path!, userId, tenantId: T, ...(qs === undefined ? {} : { query: Object.fromEntries(new URLSearchParams(qs)) }), ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    };
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const purchase = (id: string, supplierId: string, headCode: string | undefined, supplyDate = '2026-05-10', taxableMinor = 100_000, userId = 'u-acct') =>
      req('POST', `/v1/finance/rcm/purchases/${id}`, { supplierId, ...(headCode === undefined ? {} : { headCode }), supplyDate, taxableMinor, placeOfSupply: 'intra_state', description: 'synthetic inward supply' }, userId);
    const numberOf = (r: Res): string | undefined => (r.body as { purchase: { selfInvoiceNumber?: string } }).purchase.selfInvoiceNumber;

    await ok(req('POST', '/v1/purchase/suppliers/sup-truck', { name: 'Synthetic Transport (unregistered)' }), 'supplier 1');
    await ok(req('POST', '/v1/purchase/suppliers/sup-lawyer', { name: 'Synthetic Legal LLP', gstin: '33ABCDE1234F1Z5' }), 'supplier 2');

    // ── built switched off (OB-143): nothing raised, and it is said ─────────────────────────────────────────────────
    const controls = (await ok(req('GET', '/v1/finance/gst/controls'), 'controls')).body as { controls: { reverseCharge: { value: boolean }; rcmHeads: unknown[] }; said: { reverseCharge: string } };
    expect(controls.controls.reverseCharge.value).toBe(false);
    expect(controls.controls.rcmHeads).toEqual([]);
    expect(controls.said.reverseCharge).toMatch(/SWITCHED OFF/);
    const off = await ok(purchase('PU-OFF', 'sup-truck', 'GTA'), 'off purchase');
    expect((off.body as { decision: { kind: string } }).decision.kind).toBe('switched_off');
    expect(numberOf(off)).toBeUndefined();

    // ── only the CA lists heads; only the owner switches it on ─────────────────────────────────────────────────────
    expect((await req('POST', '/v1/finance/rcm/heads/GTA', GTA, 'u-owner')).status).toBe(403);
    expect((await req('POST', '/v1/finance/rcm/heads/GTA', GTA, 'u-acct')).status).toBe(403);
    expect(codeOf(await req('POST', '/v1/finance/rcm/heads/GTA', { ...GTA, notifiedUnder: '' }, 'u-ca'))).toBe('invalid_rcm_head');
    await ok(req('POST', '/v1/finance/rcm/heads/GTA', GTA, 'u-ca'), 'CA lists GTA');
    expect((await req('PUT', '/v1/finance/gst/controls/reverse-charge', { switchedOn: true, reason: 'x' }, 'u-ca')).status).toBe(403);
    expect((await req('PUT', '/v1/finance/gst/controls/reverse-charge', { switchedOn: true, reason: 'x' }, 'u-acct')).status).toBe(403);
    expect(codeOf(await req('PUT', '/v1/finance/gst/controls/reverse-charge', { switchedOn: true }))).toBe('switch_needs_state_and_reason');
    await ok(req('PUT', '/v1/finance/gst/controls/reverse-charge', { switchedOn: true, reason: 'the CA has listed the heads (synthetic)' }), 'owner switches on');

    // ── gap-free self-invoices ────────────────────────────────────────────────────────────────────────────────────
    expect((await purchase('PU-X', 'sup-truck', 'GTA', '2026-05-10', 100_000, 'u-cash')).status).toBe(403);
    expect(numberOf(await ok(purchase('PU-1', 'sup-truck', 'GTA'), 'pu-1'))).toBe('RCM/2627/000001');
    expect(numberOf(await ok(purchase('PU-2', 'sup-truck', 'GTA', '2026-05-12', 50_000), 'pu-2'))).toBe('RCM/2627/000002');
    expect(numberOf(await ok(purchase('PU-1', 'sup-truck', 'GTA'), 'pu-1 again'))).toBe('RCM/2627/000001'); // a retry is the same purchase
    const both = await Promise.all([purchase('PU-3', 'sup-truck', 'GTA', '2026-05-14'), purchase('PU-4', 'sup-truck', 'GTA', '2026-05-15')]);
    expect(both.map(numberOf).sort()).toEqual(['RCM/2627/000003', 'RCM/2627/000004']);
    // A head that is not configured raises no RCM; an unregistered supplier with no head is an exception; unknown supplier refused.
    expect(((await ok(purchase('PU-LEGAL', 'sup-lawyer', 'LEGAL'), 'legal')).body as { decision: { kind: string } }).decision.kind).toBe('no_rcm');
    expect(((await ok(purchase('PU-NOHEAD', 'sup-truck', undefined), 'no head')).body as { decision: { kind: string } }).decision.kind).toBe('exception');
    expect(codeOf(await purchase('PU-GHOST', 'sup-ghost', 'GTA'))).toBe('rcm_supplier_unknown');

    const reg = (await ok(req('GET', '/v1/finance/rcm/register?period=052026'), 'register')).body as { exceptions: { purchaseId: string; reason: string }[]; selfInvoices: { number: string }[]; liability: Heads; unpaid: string[] };
    expect(reg.exceptions).toEqual([expect.objectContaining({ purchaseId: 'PU-NOHEAD', reason: 'unregistered_supplier_no_head' })]);
    expect(reg.selfInvoices.map((s) => s.number)).toEqual(['RCM/2627/000001', 'RCM/2627/000002', 'RCM/2627/000003', 'RCM/2627/000004']);
    expect(reg.liability).toEqual({ taxableMinor: 350_000, cgstMinor: 8_750, sgstMinor: 8_750, igstMinor: 0 });

    // ── GSTR-3B: 3.1(d) paid in cash only; no ITC until paid ─────────────────────────────────────────────────────
    const may = (await ok(req('GET', '/v1/finance/gstr3b/052026'), '3B May')).body as { table31: { d: Heads }; table4: { a3ReverseCharge: Heads }; table61: { reverseChargeTaxMinor: number; reverseChargePaidInCashMinor: number; reverseChargeSetOffAgainstItcMinor: number } };
    expect(may.table31.d).toEqual(reg.liability);
    expect(may.table61).toMatchObject({ reverseChargeTaxMinor: 17_500, reverseChargePaidInCashMinor: 17_500, reverseChargeSetOffAgainstItcMinor: 0 });
    expect(may.table4.a3ReverseCharge.cgstMinor).toBe(0);

    expect(codeOf(await req('POST', '/v1/finance/rcm/purchases/PU-1/paid', { paidOn: '2026-06-05' }))).toBe('rcm_payment_needs_challan_and_date');
    expect(codeOf(await req('POST', '/v1/finance/rcm/purchases/PU-LEGAL/paid', { challanRef: 'CPIN-SYN-1', paidOn: '2026-06-05' }))).toBe('rcm_no_liability');
    await ok(req('POST', '/v1/finance/rcm/purchases/PU-1/paid', { challanRef: 'CPIN-SYN-1', paidOn: '2026-06-05' }, 'u-acct'), 'paid');

    // ── a cold restart ───────────────────────────────────────────────────────────────────────────────────────────
    h = restart(h);
    const mayAfter = (await ok(req('GET', '/v1/finance/gstr3b/052026'), '3B May again')).body as { table4: { a3ReverseCharge: Heads } };
    expect(mayAfter.table4.a3ReverseCharge.cgstMinor).toBe(0); // paid in June: no ITC in May
    const june = (await ok(req('GET', '/v1/finance/gstr3b/062026'), '3B June')).body as { table4: { a3ReverseCharge: Heads }; table31: { d: Heads } };
    expect(june.table4.a3ReverseCharge).toEqual({ taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500, igstMinor: 0 });
    expect(june.table31.d.cgstMinor).toBe(0);
    expect(numberOf(await ok(purchase('PU-5', 'sup-truck', 'GTA', '2026-06-02'), 'pu-5'))).toBe('RCM/2627/000005');
  }, 60_000);
});
