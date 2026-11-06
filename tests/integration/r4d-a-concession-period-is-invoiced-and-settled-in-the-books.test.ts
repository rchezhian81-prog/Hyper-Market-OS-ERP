import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedBody } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **Round 4d · M27-FR-03 "settle concession counter sales, ISSUE INVOICES and reconcile".** Through the real API, in memory
 * and on real PostgreSQL (with a cold restart):
 *   • no invoice until the CA has set the GST treatment, and none without a `concession_settlement` posting rule;
 *   • the invoice is made by one person and approved by ANOTHER; its number comes from the gap-free series of its financial
 *     year; it charges the contract's revenue share with the CA's GST, nets what the tills collected for the concessionaire,
 *     and states the deposit (never netted);
 *   • a period whose tills and counter disagree is refused; an overlapping period is refused; a re-send is the same invoice;
 *   • the settlement journal is on the ledger, balanced, and the reconcile check agrees with the invoice figure for figure.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: () => pg() });
}

const OWNER = 'u-owner'; const ACCT = 'u-acct'; const CASH = 'u-cash';
const CT = '/v1/concession/contracts/ct-gold';
const SETTLEMENT_RULE = {
  kind: 'concession_settlement',
  legs: [
    { account: 'concession_collections_held', side: 'debit', component: 'collected' }, { account: 'concessionaire_receivable', side: 'debit', component: 'receivable' },
    { account: 'concession_income', side: 'credit', component: 'charge' }, { account: 'utilities_recovered', side: 'credit', component: 'utilities' },
    { account: 'gst_output_cgst', side: 'credit', component: 'cgst' }, { account: 'gst_output_sgst', side: 'credit', component: 'sgst' },
    { account: 'gst_output_igst', side: 'credit', component: 'igst' }, { account: 'payable_to_concessionaire', side: 'credit', component: 'payable' },
  ],
};

describe.each(backings)('M27-FR-03 — a concession period is invoiced and settled in the books — on $name', ({ harness, restart }) => {
  it('refuses until the CA and the accountant have decided; then invoices on a gap-free series, settles, and reconciles', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ACCT, 'accountant');
    await h.provisionRole(T, CASH, 'cashier');
    await h.enableFeature(T, 'dept.concession');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const codeOf = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;
    const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // a revenue-share counter (15%), a 50,000 deposit, ₹500 utilities a period; approved by a second person
    const terms = { concessionaireId: 'cx-gold', name: 'Gold counter', branchId: 'br-1', startsOn: '2026-01-01', endsOn: '2027-12-31', basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 5_000_000, utilitiesMinor: 50_000, insuranceUntil: '2027-12-31', licenceUntil: '2027-12-31' };
    await ok(req('POST', CT, OWNER, await approvedBody(h, T, OWNER, ACCT, 'concession_contract', 'ct-gold', terms, { contractId: 'ct-gold' })), 'contract');
    // August: the shop's tills took ₹2,00,000 for the counter (and the counter's own till ₹50,000, not ours)
    await ok(req('POST', `${CT}/sales`, OWNER, { saleId: 's1', grossMinor: 12_000_000, taxMinor: 0, tenderedTo: 'store_till', at: '2026-08-05T10:00:00.000Z' }), 's1');
    await ok(req('POST', `${CT}/sales`, OWNER, { saleId: 's2', grossMinor: 8_000_000, taxMinor: 0, tenderedTo: 'store_till', at: '2026-08-20T10:00:00.000Z' }), 's2');
    await ok(req('POST', `${CT}/sales`, OWNER, { saleId: 's3', grossMinor: 5_000_000, taxMinor: 0, tenderedTo: 'concessionaire_till', at: '2026-08-21T10:00:00.000Z' }), 's3');
    const AUG = { from: '2026-08-01', to: '2026-08-31', bankedForThemMinor: 20_000_000 };
    // the maker previews the period first (nothing written), and asks approval for exactly that total
    const preview = async (body: Record<string, unknown>) => (await req('GET', `${CT}/invoice-preview`, OWNER, undefined, { from: String(body['from']), to: String(body['to']), bankedForThemMinor: String(body['bankedForThemMinor']) })).body as { invoiceTotalMinor?: number };
    const issue = async (invoiceId: string, body: Record<string, unknown>, maker = OWNER, checker = ACCT) =>
      req('POST', `${CT}/invoices/${invoiceId}`, maker, await approvedBody(h, T, maker, checker, 'concession_invoice', `concession-invoice:${invoiceId}`, body, { contractId: 'ct-gold', invoiceId }, (await preview(body)).invoiceTotalMinor ?? null));

    // no GST treatment yet: refused by name (the CA's decision)
    const noGst = await req('POST', `${CT}/invoices/inv-1`, OWNER, AUG);
    expect([noGst.status, codeOf(noGst)]).toEqual([409, 'concession_gst_not_set']);
    expect((await req('PUT', '/v1/concession/gst-treatment', CASH, { rentBps: 1800, revenueShareBps: 1800, utilitiesBps: 1800, supply: 'intra_state' })).status).toBe(403);
    await ok(req('PUT', '/v1/concession/gst-treatment', ACCT, { rentBps: 1800, revenueShareBps: 1800, utilitiesBps: 1800, supply: 'intra_state', note: 'as the CA confirmed (synthetic)' }), 'gst');
    // no posting rule yet: refused, the approval unused
    await ok(req('PUT', '/v1/finance/posting-map', ACCT, { rules: DEFAULT_RETAIL_POSTING_MAP.rules }), 'map without the rule');
    const noRule = await req('POST', `${CT}/invoices/inv-1`, OWNER, AUG);
    expect([noRule.status, codeOf(noRule)]).toEqual([409, 'concession_settlement_not_mapped']);
    await ok(req('PUT', '/v1/finance/posting-map', ACCT, { rules: [...DEFAULT_RETAIL_POSTING_MAP.rules, SETTLEMENT_RULE] }), 'map with the rule');
    // the maker alone: refused (a second person approves)
    const alone = await req('POST', `${CT}/invoices/inv-1`, OWNER, AUG);
    expect([alone.status, codeOf(alone)]).toEqual([422, 'concession_invoice_needs_approval']);
    // tills and counter disagree: refused
    const off = await issue('inv-off', { ...AUG, bankedForThemMinor: 19_900_000 });
    expect([off.status, codeOf(off)]).toEqual([409, 'settlement_does_not_reconcile']);

    const first = (await ok(issue('inv-1', AUG), 'issue')).body as { invoice: Record<string, unknown> & { lines: { kind: string; taxableMinor: number; cgstMinor: number; sgstMinor: number }[] } };
    // 15% of ₹2,50,000 gross = ₹37,500 share + ₹500 utilities, each with 9% + 9%; collected ₹2,00,000 held for them
    expect(first.invoice).toMatchObject({
      number: 'CI/2026-27/0001', financialYear: '2026-27', madeBy: OWNER, approvedBy: ACCT, collectedForThemMinor: 20_000_000,
      taxableMinor: 3_800_000, cgstMinor: 342_000, sgstMinor: 342_000, igstMinor: 0, invoiceTotalMinor: 4_484_000, netPayableToThemMinor: 15_516_000, depositHeldMinor: 5_000_000,
    });
    expect(first.invoice.lines.map((l) => [l.kind, l.taxableMinor, l.cgstMinor, l.sgstMinor])).toEqual([['revenue_share', 3_750_000, 337_500, 337_500], ['utilities', 50_000, 4_500, 4_500]]);
    // a re-send is the same invoice; an overlapping period is refused
    expect(((await ok(issue('inv-1', AUG), 'again')).body as { alreadyIssued: boolean }).alreadyIssued).toBe(true);
    const overlap = await issue('inv-2', { from: '2026-08-15', to: '2026-09-15', bankedForThemMinor: 8_000_000 });
    expect([overlap.status, codeOf(overlap)]).toEqual([409, 'period_already_invoiced']);
    // September (nothing sold through our tills): the next number on the series; they owe the shop the charge
    const sep = (await ok(issue('inv-3', { from: '2026-09-01', to: '2026-09-30', bankedForThemMinor: 0 }), 'september')).body as { invoice: { number: string; netPayableToThemMinor: number } };
    expect(sep.invoice.number).toBe('CI/2026-27/0002');
    expect(sep.invoice.netPayableToThemMinor).toBeLessThan(0);

    h = restart(h); // ── COLD RESTART ──
    const read = (await ok(req('GET', `${CT}/invoices`, OWNER), 'read')).body as { invoices: { number: string }[]; reconcile: { number: string; agrees: boolean; journal: string | null }[]; allAgree: boolean };
    expect(read.invoices.map((i) => i.number)).toEqual(['CI/2026-27/0001', 'CI/2026-27/0002']);
    expect(read.allAgree).toBe(true);
    expect(read.reconcile.map((r) => r.journal)).toEqual(['concession-settlement:inv-1', 'concession-settlement:inv-3']);
    // the ledger holds the August settlement, balanced: the liability off, income, output GST, payable to them
    const tb = (await ok(req('GET', '/v1/finance/periods/2026-08/trial-balance', ACCT), 'trial balance')).body as { rows: { account: string; periodDebitMinor: number; periodCreditMinor: number }[] };
    const row = (a: string) => tb.rows.find((r) => r.account === a);
    expect(row('concession_collections_held')?.periodDebitMinor).toBe(20_000_000);
    expect(row('concession_income')?.periodCreditMinor).toBe(3_750_000);
    expect(row('payable_to_concessionaire')?.periodCreditMinor).toBe(15_516_000);
    expect((await req('GET', `${CT}/invoices`, CASH)).status).toBe(403);
  });
});
