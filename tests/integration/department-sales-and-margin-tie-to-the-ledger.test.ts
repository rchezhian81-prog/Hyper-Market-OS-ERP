import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedRequestId } from '../support/approval-request';
import { withApprovals } from '../support/refund-approval';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { DEFAULT_RETAIL_POSTING_MAP, splitInclusive } from '../../packages/finance/src/index';

// OB-340 (owner, 24 Oct 2026, in writing): department sales split for cost centres — "exact net value per line after its
// discount, to its department (day book change)", departments from the organisation's department/category ownership:
//   • the day book carries each till line's exact net (after the line's own discount) to the department that owns the
//     product; the revenue line is split the same way, each part naming its department; a product no department owns stays
//     with the store; the voucher still balances and the account totals are unchanged;
//   • the trial balance and the centre report show each department's sales, what its goods cost at the average buying cost
//     (OB-39), its margin, and the tie: departments plus what no department owns equal the month's revenue in the ledger;
//   • a return takes its net back off the department; a department with a product that has no cost shows "not known";
//   • a cashier reads neither (403); a cold restart reads the same.
// Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD = TODAY.slice(0, 7);

interface DeptRow { departmentId: string; name: string | null; salesMinor: number; costMinor: number | null; marginMinor: number | null; marginBps: number | null; notCosted: string[] }
interface Departments { departments: DeptRow[]; notInADepartmentMinor: number; ledgerRevenueMinor: number; ties: boolean; revenueAccounts: string[]; detail: string }
interface Tb { balanced: boolean; rows: { account: string; periodDebitMinor: number; periodCreditMinor: number }[]; departments: Departments | null }
interface Centres { ties: boolean; centres: { centre: string; accounts: { account: string; debitMinor: number; creditMinor: number }[] }[]; departments: Departments | null }

describe.each(backings)('department sales and margin tie to the ledger (OB-340 · M23-FR-01) — on $name', ({ harness }) => {
  it('each line\'s exact net reaches its department; sales, cost and margin per department tie to the revenue in the ledger; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The organisation: a store with a dairy and a grocery department; each owns its category (owner-approved).
    await ok(req('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/store-01', 'u-owner', { kind: 'branch', name: 'Main store', parentId: 'C1', companyId: 'C1' }), 'branch');
    for (const [id, name] of [['D-dairy', 'Dairy'], ['D-grocery', 'Grocery']] as const) await ok(req('POST', `/v1/org/nodes/${id}`, 'u-owner', { kind: 'department', name, parentId: 'store-01' }), id);
    await ok(req('POST', '/v1/catalogue/tax-classes/04059020/rates/2017-07-01', 'u-owner', { rateBps: 1200 }), 'tax');
    for (const [id, cat] of [['p-ghee', 'dairy-cat'], ['p-rice', 'grocery-cat'], ['p-pen', 'stationery-cat']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: cat, taxClass: '04059020', lifecycle: 'draft' }, categories: [{ categoryId: cat, name: cat, parentId: null }] }), `publish ${id}`);
    }
    // The ghee was bought at ₹60 a unit; the rice has never been received at a cost (its cost is not known).
    await ok(req('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-ghee', productId: 'p-ghee', locationId: 'store-01', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: `${TODAY}T00:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 6_000 }), 'receive ghee');
    for (const [dept, cat] of [['D-dairy', 'dairy-cat'], ['D-grocery', 'grocery-cat']] as const) {
      const link = { categoryIds: [cat], reason: `${dept} counter` };
      const approvalId = await approvedRequestId(h, T, 'u-it', 'u-owner', { kind: 'org_structure_change', subjectRef: `department:${dept}`, details: actionDetails(link, { departmentId: dept }) });
      await ok(req('POST', `/v1/org/departments/${dept}/categories`, 'u-it', { ...link, approvalId }), `link ${dept}`);
    }

    // One bill: two ghee at ₹112 less a ₹4 discount (₹220), rice ₹105, a pen ₹56 (no department owns stationery).
    const lines = [
      { productId: 'p-ghee', quantityMinor: 2, uom: 'EA', unitPriceMinor: 11_200, lineTotalMinor: 22_000, hsnCode: '04059020', taxRateBps: 1200 },
      { productId: 'p-rice', quantityMinor: 1, uom: 'EA', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '10063020', taxRateBps: 500 },
      { productId: 'p-pen', quantityMinor: 1, uom: 'EA', unitPriceMinor: 5_600, lineTotalMinor: 5_600, hsnCode: '96081019', taxRateBps: 1200 },
    ];
    const total = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    await ok(req('POST', '/v1/sales', 'u-cash', {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', locationId: 'store-01', tradingDay: TODAY, committedAt: `${TODAY}T05:00:00.000Z`,
      totalMinor: total, currency: 'INR', packVersion: 1, lines, tenders: [{ kind: 'cash', amountMinor: total }],
    }), 'sale');
    await ok(req('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'map');
    await ok(req('PUT', '/v1/finance/account-classes', 'u-acct', { classes: { sales_revenue: 'income' } }), 'classes');
    const posted = await ok(req('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-acct', {}), 'day book');

    const ghee = splitInclusive(22_000, 1200).net;
    const rice = splitInclusive(10_500, 500).net;
    const pen = splitInclusive(5_600, 1200).net;
    // ── The day book: the sale voucher's revenue line is carried per department; the pen's net stays with the store.
    const voucher = (posted.body as { journals: { kind: string; netByDepartment?: Record<string, number>; lines: { accountCode: string; debitMinor: number; creditMinor: number; centre?: string }[] }[] }).journals.find((j) => j.kind === 'sale')!;
    expect(voucher.netByDepartment).toEqual({ 'D-dairy': ghee, 'D-grocery': rice });
    expect(voucher.lines.filter((l) => l.accountCode === 'sales_revenue')).toEqual([
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: ghee, centre: 'D-dairy' },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: rice, centre: 'D-grocery' },
      { accountCode: 'sales_revenue', debitMinor: 0, creditMinor: pen },
    ]);
    expect(voucher.lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(voucher.lines.reduce((s, l) => s + l.creditMinor, 0));

    // ── The trial balance: balanced; the department section ties to the revenue account to the paisa.
    const tb = (await ok(req('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-acct'), 'tb')).body as Tb;
    expect(tb.balanced).toBe(true);
    const revenue = tb.rows.find((r) => r.account === 'sales_revenue')!;
    expect(revenue.periodCreditMinor - revenue.periodDebitMinor).toBe(ghee + rice + pen);
    expect(tb.departments).toMatchObject({ revenueAccounts: ['sales_revenue'], notInADepartmentMinor: pen, ledgerRevenueMinor: ghee + rice + pen, ties: true });
    const dairy = tb.departments!.departments.find((d) => d.departmentId === 'D-dairy')!;
    expect(dairy).toMatchObject({ name: 'Dairy', salesMinor: ghee, costMinor: 12_000, marginMinor: ghee - 12_000, marginBps: Math.round(((ghee - 12_000) * 10_000) / ghee), notCosted: [] });
    // The rice has no average buying cost: the grocery margin is NOT KNOWN, by name — never a 100% margin on a zero cost.
    expect(tb.departments!.departments.find((d) => d.departmentId === 'D-grocery')).toMatchObject({ salesMinor: rice, costMinor: null, marginMinor: null, notCosted: ['p-rice'] });
    expect((await req('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-cash')).status).toBe(403);

    // ── The centres: each department carries its own revenue; the store keeps the rest; the report ties to the ledger.
    const c = (await ok(req('GET', `/v1/finance/periods/${PERIOD}/centres`, 'u-acct'), 'centres')).body as Centres;
    expect(c.ties).toBe(true);
    expect(c.centres.find((x) => x.centre === 'D-dairy')!.accounts).toEqual([{ account: 'sales_revenue', debitMinor: 0, creditMinor: ghee }]);
    expect(c.centres.find((x) => x.centre === 'store-01')!.accounts.find((a) => a.account === 'sales_revenue')).toEqual({ account: 'sales_revenue', debitMinor: 0, creditMinor: pen });
    expect(c.departments?.ties).toBe(true);
    expect((await req('GET', `/v1/finance/periods/${PERIOD}/centres`, 'u-cash')).status).toBe(403);

    // ── A return of one ghee takes its net back off dairy (and its cost), never off another department.
    const back = await req('POST', '/v1/sales/S-1/returns', 'u-owner', await withApprovals(h, T, 'u-owner', 'S-1', {
      returnId: 'RT-1', number: 'RT-1', reasonCode: 'changed_mind', refundMinor: 11_000, refundTender: 'cash', approvedBy: 'u-mgr', processedAt: `${TODAY}T08:00:00Z`,
      lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'EA', disposition: 'resell' }],
    }));
    expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);
    await ok(req('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-acct', {}), 'day book again');
    const backNet = splitInclusive(11_000, 1200).net;
    const after = (await ok(req('GET', `/v1/finance/periods/${PERIOD}/trial-balance`, 'u-acct'), 'tb after')).body as Tb;
    expect(after.departments!.departments.find((d) => d.departmentId === 'D-dairy')).toMatchObject({ salesMinor: ghee - backNet, costMinor: 6_000, marginMinor: ghee - backNet - 6_000 });
    expect(after.departments!.departments.find((d) => d.departmentId === 'D-grocery')!.salesMinor).toBe(rice);
    expect(after.departments).toMatchObject({ ledgerRevenueMinor: ghee + rice + pen - backNet, ties: true });

    // A cold restart reads the same departments and the same tie.
    const h2 = harness(h);
    const tb2 = (await h2.request({ method: 'GET', path: `/v1/finance/periods/${PERIOD}/trial-balance`, userId: 'u-acct', tenantId: T })).body as Tb;
    expect(tb2.departments).toEqual(after.departments);
  }, 120_000);
});
