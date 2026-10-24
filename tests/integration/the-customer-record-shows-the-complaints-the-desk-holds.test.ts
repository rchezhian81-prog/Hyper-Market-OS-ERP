import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';

// OB-288 · M16-FR-04 ("complaint history is visible to service"). The customer's record shows the service desk's OWN
// cases — complaints first, open ones counted — read from M21's register, never typed onto the record; the cases list
// narrows to one customer; and segmentation counts the complaints the desk recorded (a complaint raised in the app is a
// fact without anyone typing it in). In memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const MEMBER = 'm-0123456789abcdef01234567';
const OTHER = 'm-fedcba9876543210fedcba98';
const DAY = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

const sale = (saleId: string, customerRef: string, totalMinor: number) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', tradingDay: DAY, committedAt: `${DAY}T06:30:00.000Z`,
  totalMinor, currency: 'INR', packVersion: 1, customerRef,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor, taxRateBps: 500 }],
  tenders: [{ kind: 'cash', amountMinor: totalMinor }],
});

interface ServiceHistory { read: boolean; say: string; complaints: { count: number; open: number; recent: { caseId: string; state: string; summary: string; orderRef?: string }[] }; otherCases: { count: number; recent: { caseId: string; kind: string }[] }; lastComplaintAt: string | null }

describe.each(backings)('the customer record shows the complaints the service desk holds (M16-FR-04) — on $name', ({ harness }) => {
  it('complaints first on the record, the cases list for one customer, segments count the desk\'s complaints; 403s; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });

    for (const [id, ref, total] of [['S1', MEMBER, 50_000], ['S2', OTHER, 20_000]] as const) {
      const r = await h.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: T, idempotencyKey: `bank-${id}`, body: sale(id, ref, total) });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
    }
    const open = (caseId: string, kind: string, customerRef: string, summary: string, orderRef?: string) =>
      call('POST', `/v1/service/cases/${caseId}`, 'u-mgr', { kind, customerRef, priority: 'normal', summary, assignedTo: 'u-mgr', ...(orderRef === undefined ? {} : { orderRef }) });
    expect((await open('C1', 'complaint', MEMBER, 'Milk was sour (synthetic)', 'S1')).status).toBe(201);
    expect((await open('C2', 'complaint', MEMBER, 'Bill printed twice (synthetic)')).status).toBe(201);
    expect((await open('C3', 'enquiry', MEMBER, 'Do you stock ragi flour? (synthetic)')).status).toBe(201);
    expect((await open('C4', 'complaint', OTHER, 'Someone else\'s complaint (synthetic)')).status).toBe(201);
    expect((await call('POST', '/v1/service/cases/C2/resolution', 'u-mgr', { resolution: 'Reprinted once, apologised' })).status).toBe(200);

    const record = async (hh = h) => {
      const r = await hh.request({ method: 'GET', path: `/v1/customers/${MEMBER}/profile`, userId: 'u-mgr', tenantId: T });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { serviceHistory: ServiceHistory; purchases: { count: number } });
    };
    const first = await record();
    expect(first.purchases.count).toBe(1);
    const sh = first.serviceHistory;
    expect(sh.read).toBe(true);
    expect(sh.complaints.count).toBe(2);
    expect(sh.complaints.open).toBe(1);
    expect(sh.complaints.recent.map((c) => c.caseId).sort()).toEqual(['C1', 'C2']);
    expect(sh.complaints.recent.find((c) => c.caseId === 'C1')).toMatchObject({ state: 'open', summary: 'Milk was sour (synthetic)', orderRef: 'S1' });
    expect(sh.otherCases.count).toBe(1);
    expect(sh.otherCases.recent[0]).toMatchObject({ caseId: 'C3', kind: 'enquiry' });
    expect(sh.say).toBe('2 complaint(s) on record, 1 still open — answer those first.');
    // Another customer's complaint is never on this record.
    expect(JSON.stringify(sh)).not.toContain('C4');

    // The cases list narrows to one customer, with what each was about.
    const mine = await call('GET', '/v1/service/cases', 'u-mgr', undefined, { customerRef: MEMBER });
    expect(mine.status).toBe(200);
    const rows = (mine.body as { cases: { caseId: string; summary?: string; customerRef: string }[]; customerRef: string }).cases;
    expect(rows.map((c) => c.caseId).sort()).toEqual(['C1', 'C2', 'C3']);
    expect(rows.every((c) => c.customerRef === MEMBER && typeof c.summary === 'string')).toBe(true);
    // Without the filter every case is listed as before — no summaries in the shop-wide queue.
    const everyone = (await call('GET', '/v1/service/cases', 'u-mgr')).body as { cases: { caseId: string; summary?: string }[] };
    expect(everyone.cases.map((c) => c.caseId).sort()).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(everyone.cases.every((c) => c.summary === undefined)).toBe(true);

    // Segmentation counts the desk's complaints (no one typed them in): the Customers page's overview reads them.
    const overview = await call('GET', '/v1/customer/overview', 'u-mgr');
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    const rowsOf = (overview.body as { customers: { customerRef: string; openComplaints: number }[] }).customers;
    expect(rowsOf.find((c) => c.customerRef === MEMBER)?.openComplaints).toBe(1);
    expect(rowsOf.find((c) => c.customerRef === OTHER)?.openComplaints).toBe(1);

    // A cashier reads no customer's record and no cases.
    expect((await h.request({ method: 'GET', path: `/v1/customers/${MEMBER}/profile`, userId: 'u-cash', tenantId: T })).status).toBe(403);
    expect((await call('GET', '/v1/service/cases', 'u-cash', undefined, { customerRef: MEMBER })).status).toBe(403);

    // A customer with only a complaint (never billed, not a member) still has a record the desk can open.
    expect((await open('C5', 'complaint', 'cust-app-only', 'Order came late (synthetic)')).status).toBe(201);
    const appOnly = await call('GET', '/v1/customers/cust-app-only/profile', 'u-mgr');
    expect(appOnly.status, JSON.stringify(appOnly.body)).toBe(200);
    expect((appOnly.body as { serviceHistory: ServiceHistory }).serviceHistory.complaints.count).toBe(1);

    // A cold restart reads the same history.
    const again = await record(harness(h));
    expect(again.serviceHistory.complaints.count).toBe(2);
    expect(again.serviceHistory.complaints.open).toBe(1);
  });
});
