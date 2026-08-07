import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Concession, end to end through the real API (M27, API-09). A partner trades a counter inside the
// store; the money the tills take for their sales was NEVER the store's revenue — it is money held on
// their behalf, a liability the settlement discharges. The period charge (rent / revenue share /
// higher-of-both) is exact; a refund reduces the base; the deposit is stated but never netted; a
// till-vs-counter difference is a valued exception. Proves the wired concession surface against the
// real pipeline and real per-tenant RBAC — another engine nothing fed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const contract = (over: Record<string, unknown> = {}) => ({
  concessionaireId: 'JEWEL', name: 'Jewellery counter', branchId: 'BR1',
  startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'higher_of_both',
  fixedRentMinor: 500_000, revenueShareBps: 1_500, depositMinor: 1_000_000, ...over,
});

const setContract = (h: ApiHarness, tenantId: string, userId: string, id: string, body = contract(), key?: string) =>
  h.request({ method: 'POST', path: `/v1/concession/contracts/${id}`, userId, tenantId, idempotencyKey: key ?? `cc-${id}`, body });

const sale = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/concession/contracts/${id}/sales`, userId, tenantId, idempotencyKey: `cs-${body['saleId']}`, body });

const s = (saleId: string, grossMinor: number, at: string, tenderedTo = 'store_till') => ({ saleId, grossMinor, taxMinor: 0, tenderedTo, at: `${at}T10:00:00.000Z` });

const charge = (h: ApiHarness, tenantId: string, userId: string, id: string, from: string, to: string) =>
  h.request({ method: 'GET', path: `/v1/concession/contracts/${id}/charge`, userId, tenantId, query: { from, to } });

const settlement = (h: ApiHarness, tenantId: string, userId: string, id: string, from: string, to: string, banked: number) =>
  h.request({ method: 'GET', path: `/v1/concession/contracts/${id}/settlement`, userId, tenantId, query: { from, to, bankedForThemMinor: String(banked) } });

interface Charge { grossSalesMinor: number; chargeMinor: number; totalDueMinor: number; basis: string }
interface Settlement { collectedForThemMinor: number; payableToThemMinor: number; depositHeldMinor: number; reconciles: boolean; differenceMinor: number }

describe('concession: the tills hold the partner\'s money, and the charge is exact (M27, API-09)', () => {
  it('charges the higher of rent and revenue share', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setContract(h, A, 'u-owner', 'C1');
    await sale(h, A, 'u-owner', 'C1', s('s1', 2_000_000, '2026-08-05'));
    await sale(h, A, 'u-owner', 'C1', s('s2', 2_000_000, '2026-08-10'));

    // 4,000,000 of sales: rent 500,000 vs 15% revenue share 600,000 → the higher (600,000) applies.
    const r = (await charge(h, A, 'u-owner', 'C1', '2026-08-01', '2026-08-31')).body as Charge;
    expect(r).toMatchObject({ grossSalesMinor: 4_000_000, chargeMinor: 600_000, totalDueMinor: 600_000, basis: 'higher_of_both' });
  });

  it('lets a refund reduce the revenue base by construction', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setContract(h, A, 'u-owner', 'C1');
    await sale(h, A, 'u-owner', 'C1', s('s1', 2_000_000, '2026-08-05'));
    await sale(h, A, 'u-owner', 'C1', s('s2', 2_000_000, '2026-08-10'));
    await sale(h, A, 'u-owner', 'C1', { ...s('r1', -1_300_000, '2026-08-15'), refundOf: 's1' });

    // 2,700,000 base: 15% = 405,000, below the 500,000 rent — rent now applies.
    expect(((await charge(h, A, 'u-owner', 'C1', '2026-08-01', '2026-08-31')).body as Charge).chargeMinor).toBe(500_000);
  });

  it('settles the collected money as a liability, deposit stated but not netted', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setContract(h, A, 'u-owner', 'C1');
    await sale(h, A, 'u-owner', 'C1', s('s1', 2_000_000, '2026-08-05'));
    await sale(h, A, 'u-owner', 'C1', s('s2', 2_000_000, '2026-08-10'));

    const st = (await settlement(h, A, 'u-owner', 'C1', '2026-08-01', '2026-08-31', 4_000_000)).body as Settlement;
    // We hold 4,000,000 for them and charge 600,000 → 3,400,000 payable; the 1,000,000 deposit is NOT netted.
    expect(st).toMatchObject({ collectedForThemMinor: 4_000_000, payableToThemMinor: 3_400_000, depositHeldMinor: 1_000_000, reconciles: true, differenceMinor: 0 });
  });

  it('flags a till-vs-counter difference as a valued exception', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setContract(h, A, 'u-owner', 'C1');
    await sale(h, A, 'u-owner', 'C1', s('s1', 2_000_000, '2026-08-05'));
    await sale(h, A, 'u-owner', 'C1', s('s2', 2_000_000, '2026-08-10'));

    const st = (await settlement(h, A, 'u-owner', 'C1', '2026-08-01', '2026-08-31', 3_900_000)).body as Settlement;
    expect(st.reconciles).toBe(false);
    expect(st.differenceMinor).toBe(100_000); // counter rang 4,000,000, till banked 3,900,000
  });

  it('is authorized and per-tenant, and refuses unknown/ malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier'); // a cashier does not run concession settlement
    await setContract(h, A, 'u-owner', 'C1');

    expect((await setContract(h, A, 'u-cash', 'C9')).status).toBe(403);
    expect((await charge(h, A, 'u-owner', 'GHOST', '2026-08-01', '2026-08-31')).status).toBe(404);
    expect((await setContract(h, A, 'u-owner', 'CX', contract({ basis: 'nonsense' }))).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect((await charge(h, B, 'u-owner-b', 'C1', '2026-08-01', '2026-08-31')).status).toBe(404); // A's contract did not leak
  });
});
