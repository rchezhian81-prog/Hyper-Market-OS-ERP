import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { deliveryPlaces } from '../support/approved-supplier';
import { approvedBody } from '../support/approval-request';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// M23-FR-01 "trial balance and AP/AR reports … cost/profit centre allocation" (acceptance: "cost-centre reports tie to the
// ledger") and WF-18 "reconcile … tax → exceptions → period close" (OB-288 P5):
//   • the TRIAL BALANCE reads every account off the posted journals — brought forward, the month, carried forward — and
//     balances to the paisa; an empty month is said, never shown as a balanced zero;
//   • the CENTRE REPORT places each journal in a branch or department by its own facts (the store the receipts were sold
//     from; a line that names its centre), lists the unassigned with the reason, and ties to the ledger per account;
//     a line naming a centre the organisation does not have is refused;
//   • the CLOSE compares the books' output GST with the GST return for the month: agreeing, then a sale the books have not
//     posted is a difference that holds the close.
// Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD = TODAY.slice(0, 7);

interface Tb { rows: { account: string; accountClass: string | null; openingNetDebitMinor: number; periodDebitMinor: number; periodCreditMinor: number; closingNetDebitMinor: number }[]; balanced: boolean; totals: { periodDebitMinor: number; periodCreditMinor: number; closingDebitMinor: number; closingCreditMinor: number }; journalsInPeriod: number; detail: string; unclassified: string[] }
interface Centres { centres: { centre: string; name: string | null; known: boolean; accounts: { account: string; debitMinor: number; creditMinor: number }[]; incomeMinor: number; profitMinor: number }[]; unassigned: { accounts: unknown[]; journals: { entryId: string; reason: string }[] }; ties: boolean; attributedBps: number | null }
interface Evidence { checks: { name: string; leftMinor: number; rightMinor: number }[]; notChecked: string[] }

describe.each(backings)('the trial balance, the centres and the close\'s GST check (M23-FR-01 · WF-18) — on $name', ({ harness }) => {
  it('balances, places each journal in its centre, ties to the ledger, and holds the close on a GST difference; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await deliveryPlaces(h, T, 'store-1', 'wh-1');
    const dept = await h.request({ method: 'POST', path: '/v1/org/nodes/dept-grocery', userId: 'u-org-setup', tenantId: T, idempotencyKey: 'dept', body: { kind: 'department', name: 'Groceries', parentId: 'store-1', companyId: 'C-FIXTURE' } });
    expect(dept.status, JSON.stringify(dept.body)).toBeLessThan(300);
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const sell = (saleId: string, total: number) => call('POST', '/v1/sales', 'u-cash', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', locationId: 'store-1', tradingDay: TODAY, committedAt: `${TODAY}T05:00:00.000Z`,
      totalMinor: total, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'each', unitPriceMinor: total, lineTotalMinor: total, hsnCode: '040590', taxRateBps: 1800 }],
      tenders: [{ kind: 'cash', amountMinor: total }],
    });

    // An empty month is said — not a balanced zero.
    const empty = (await call('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-acct')).body as Tb;
    expect(empty.rows).toEqual([]);
    expect(empty.detail).toMatch(/not a balanced zero/);

    for (const [id, total] of [['S1', 11_800], ['S2', 23_600]] as const) expect((await sell(id, total)).status).toBe(202);
    expect((await call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    expect((await call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-acct', {})).status).toBeLessThan(300);
    // A hand journal naming its department centre; one naming no centre (unassigned); one naming a centre nobody has.
    const hand = (entryId: string, centre?: string) => ({
      entryId, period: PERIOD, documentDate: TODAY, narrative: `Shop cleaning paid from petty cash, voucher ${entryId}`, postedBy: 'u-acct',
      lines: [{ accountCode: 'shop_expenses', debitMinor: 1_000, creditMinor: 0, ...(centre === undefined ? {} : { centre }) }, { accountCode: 'cash_in_hand', debitMinor: 0, creditMinor: 1_000, ...(centre === undefined ? {} : { centre }) }],
    });
    expect((await call('POST', '/v1/finance/journals', 'u-acct', hand('PC-1', 'dept-grocery'))).status).toBe(201);
    expect((await call('POST', '/v1/finance/journals', 'u-acct', hand('PC-2'))).status).toBe(201);
    expect(codeOf(await call('POST', '/v1/finance/journals', 'u-acct', hand('PC-3', 'nowhere')))).toBe('unknown_centre');

    // ── The trial balance: balanced to the paisa; the month's debits equal its credits.
    const tbRes = await call('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-acct');
    expect(tbRes.status).toBe(200);
    const tb = tbRes.body as Tb;
    expect(tb.balanced).toBe(true);
    expect(tb.totals.periodDebitMinor).toBe(tb.totals.periodCreditMinor);
    expect(tb.totals.closingDebitMinor).toBe(tb.totals.closingCreditMinor);
    expect(tb.rows.find((r) => r.account === 'sales_revenue')).toMatchObject({ periodCreditMinor: 30_000, closingNetDebitMinor: -30_000 });
    expect(tb.rows.find((r) => r.account === 'cash_in_hand')).toMatchObject({ periodDebitMinor: 35_400, periodCreditMinor: 2_000, closingNetDebitMinor: 33_400 });
    expect(tb.unclassified).toContain('shop_expenses'); // no class set yet — said
    expect((await call('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-cash')).status).toBe(403);
    expect(codeOf(await call('GET', '/v1/finance/periods/2026-13/trial-balance', 'u-acct'))).toBe('bad_period');

    // ── The centres: the day book is the store's; PC-1 is the department's; PC-2 is unassigned with the reason; it ties.
    const cRes = await call('GET', `/v1/finance/periods/${PERIOD}/centres`, 'u-acct');
    expect(cRes.status).toBe(200);
    const c = cRes.body as Centres;
    expect(c.ties).toBe(true);
    const store = c.centres.find((x) => x.centre === 'store-1')!;
    expect(store).toMatchObject({ known: true, name: 'Store store-1' });
    expect(store.accounts.find((a) => a.account === 'sales_revenue')).toMatchObject({ creditMinor: 30_000 });
    expect(c.centres.find((x) => x.centre === 'dept-grocery')!.accounts).toEqual([{ account: 'cash_in_hand', debitMinor: 0, creditMinor: 1_000 }, { account: 'shop_expenses', debitMinor: 1_000, creditMinor: 0 }]);
    expect(c.unassigned.journals).toEqual([{ entryId: 'PC-2', reason: expect.stringMatching(/names no store/) }]);
    expect(c.attributedBps).toBeLessThan(10_000);
    // With the accountant's classes, the store's profit is its income less its expenses.
    expect((await call('PUT', '/v1/finance/account-classes', 'u-acct', { classes: { sales_revenue: 'income', shop_expenses: 'expense' } })).status).toBe(200);
    const classed = (await call('GET', `/v1/finance/periods/${PERIOD}/centres`, 'u-acct')).body as Centres;
    expect(classed.centres.find((x) => x.centre === 'store-1')).toMatchObject({ incomeMinor: 30_000, profitMinor: 30_000 });
    expect(classed.centres.find((x) => x.centre === 'dept-grocery')).toMatchObject({ profitMinor: -1_000 });

    // ── WF-18: the books' output GST equals the GST return for the month …
    const evidence = async (hh = h) => (await hh.request({ method: 'GET', path: `/v1/finance/periods/${PERIOD}/independent-evidence`, userId: 'u-acct', tenantId: T })).body as Evidence;
    const gst = (e: Evidence) => e.checks.find((x) => x.name === `Output GST for ${PERIOD}`);
    expect(gst(await evidence())).toMatchObject({ leftMinor: 5_400, rightMinor: 5_400 });
    expect((await evidence()).notChecked.join(' ')).toMatch(/Tally: the accountant has not named/);
    // … then a sale the books have not posted yet: the return has its tax, the books do not — a difference that holds the close.
    expect((await sell('S3', 5_900)).status).toBe(202);
    expect(gst(await evidence())).toMatchObject({ leftMinor: 5_400, rightMinor: 6_300 });
    const close = await call('POST', `/v1/finance/periods/${PERIOD}/close`, 'u-owner', await approvedBody(h, T, 'u-owner', 'u-acct', 'period_close', PERIOD, {}, { period: PERIOD }));
    expect(close.status).toBe(422);
    expect(codeOf(close)).toBe('control_total_does_not_agree');
    expect(JSON.stringify(close.body)).toMatch(/Output GST/);
    // Posting the day book again carries S3 (a supplementary journal): the books and the return agree once more.
    expect((await call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-acct', {})).status).toBeLessThan(300);
    expect(gst(await evidence())).toMatchObject({ leftMinor: 6_300, rightMinor: 6_300 });

    // A cold restart reads the same trial balance and the same tie.
    const h2 = harness(h);
    const tb2 = (await h2.request({ method: 'GET', path: `/v1/finance/periods/${PERIOD}/trial-balance`, userId: 'u-acct', tenantId: T })).body as Tb;
    expect(tb2.balanced).toBe(true);
    expect(tb2.rows.find((r) => r.account === 'sales_revenue')).toMatchObject({ periodCreditMinor: 35_000 });
    expect(((await h2.request({ method: 'GET', path: `/v1/finance/periods/${PERIOD}/centres`, userId: 'u-acct', tenantId: T })).body as Centres).ties).toBe(true);
  }, 120_000);
});
