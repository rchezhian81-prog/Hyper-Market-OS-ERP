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

// M27 ownership + eligibility: a lapsed agreement/insurance/licence blocks trading; a deposit is a
// liability projected from movements (an unapproved forfeit stays a liability); a valuation excludes
// what the store does not own and names it; somebody else's stock is not ours to write off.
const mayTrade = (h: ApiHarness, tenantId: string, userId: string, id: string, today: string) =>
  h.request({ method: 'GET', path: `/v1/concession/contracts/${id}/may-trade`, userId, tenantId, query: { today } });
const depositMove = (h: ApiHarness, tenantId: string, userId: string, cid: string, mid: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/concession/concessionaires/${cid}/deposit-movements/${mid}`, userId, tenantId, idempotencyKey: `dm-${mid}`, body });
const depositPos = (h: ApiHarness, tenantId: string, userId: string, cid: string) =>
  h.request({ method: 'GET', path: `/v1/concession/concessionaires/${cid}/deposit`, userId, tenantId });
const valuation = (h: ApiHarness, tenantId: string, userId: string, body: unknown, key = 'val1') =>
  h.request({ method: 'POST', path: '/v1/concession/valuation', userId, tenantId, idempotencyKey: key, body });
const stockAccess = (h: ApiHarness, tenantId: string, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/concession/stock-access', userId, tenantId, idempotencyKey: key, body });

const tradeable = (over: Record<string, unknown> = {}) =>
  contract({ approvedBy: 'u-owner', insuranceUntil: '2026-12-31', licenceUntil: '2026-12-31', ...over });

describe('concession ownership + eligibility (M27)', () => {
  it('may-trade blocks a lapsed insurance / unapproved / expired counter, every reason at once', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setContract(h, A, 'u-owner', 'OK', tradeable());
    const ok = (await mayTrade(h, A, 'u-owner', 'OK', '2026-06-01')).body as { mayTrade: boolean; blockedBy: string[] };
    expect(ok.mayTrade).toBe(true);

    // Base contract() has no approver and no insurance → blocked on both.
    await setContract(h, A, 'u-owner', 'BAD', contract(), 'cc-BAD');
    const bad = (await mayTrade(h, A, 'u-owner', 'BAD', '2026-06-01')).body as { mayTrade: boolean; blockedBy: string[] };
    expect(bad.mayTrade).toBe(false);
    expect(bad.blockedBy).toEqual(expect.arrayContaining(['not_approved', 'insurance_lapsed']));

    // Insured + approved but the day is past the agreement's end → expired.
    const exp = (await mayTrade(h, A, 'u-owner', 'OK', '2027-01-05')).body as { blockedBy: string[] };
    expect(exp.blockedBy).toContain('contract_expired');
  });

  it('projects the deposit as a liability; an unapproved forfeit stays a liability', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await depositMove(h, A, 'u-owner', 'JEWEL', 'd1', { kind: 'received', amountMinor: 1_000_000 });
    await depositMove(h, A, 'u-owner', 'JEWEL', 'd2', { kind: 'refunded', amountMinor: 200_000 });
    // A forfeit with nobody's name on it must NOT reduce the liability.
    await depositMove(h, A, 'u-owner', 'JEWEL', 'd3', { kind: 'forfeited', amountMinor: 100_000 });
    const p1 = (await depositPos(h, A, 'u-owner', 'JEWEL')).body as { outstandingLiabilityMinor: number; detail: string };
    expect(p1.outstandingLiabilityMinor).toBe(800_000); // 1,000,000 − 200,000; the unapproved forfeit is ignored
    expect(p1.detail).toContain('nobody');

    // Approve a forfeit → now it reduces the liability.
    await depositMove(h, A, 'u-owner', 'JEWEL', 'd4', { kind: 'forfeited', amountMinor: 100_000, approvedBy: 'u-owner' });
    expect(((await depositPos(h, A, 'u-owner', 'JEWEL')).body as { outstandingLiabilityMinor: number }).outstandingLiabilityMinor).toBe(700_000);
  });

  it('values only the stock the store owns and names what it excluded', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const lots = [
      { lotId: 'l1', productId: 'p1', branchId: 'BR1', qty: 10, unitCostMinor: 5_000, ownership: 'own' },
      { lotId: 'l2', productId: 'gold', branchId: 'BR1', qty: 2, unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'JEWEL' },
    ];
    const v = (await valuation(h, A, 'u-owner', { branchId: 'BR1', lots })).body as { ownedValueMinor: number; excludedValueMinor: number; excluded: { ownerId: string }[] };
    expect(v.ownedValueMinor).toBe(50_000); // only the store's own lot
    expect(v.excludedValueMinor).toBe(4_000_000); // the jeweller's gold, excluded not dropped
    expect(v.excluded[0]?.ownerId).toBe('JEWEL');
  });

  it('refuses store staff writing off the concession\'s stock, and flags a concessionaire touching what is not theirs', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const concessionLot = { lotId: 'l2', productId: 'gold', branchId: 'BR1', qty: 2, unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'JEWEL' };
    // Store staff cannot write off somebody else's stock.
    const wo = (await stockAccess(h, A, 'u-owner', { lot: concessionLot, actorId: 'u-staff', actorKind: 'store_staff', action: 'write_off' }, 'sa1')).body as { allowed: boolean; outcome: string };
    expect(wo).toMatchObject({ allowed: false, outcome: 'not_permitted' });
    // A concessionaire reaching for stock that is not theirs is a security event.
    const otherLot = { ...concessionLot, ownerId: 'PHONES' };
    const sec = (await stockAccess(h, A, 'u-owner', { lot: otherLot, actorId: 'u-jewel', actorKind: 'concessionaire', action: 'sell', concessionaireId: 'JEWEL' }, 'sa2')).body as { allowed: boolean; outcome: string; securityEvent: boolean };
    expect(sec).toMatchObject({ allowed: false, outcome: 'not_your_stock', securityEvent: true });
    // Store staff MAY sell the concession's stock on their behalf when the contract allows it.
    const behalf = (await stockAccess(h, A, 'u-owner', { lot: concessionLot, actorId: 'u-staff', actorKind: 'store_staff', action: 'sell', storeSellsOnBehalf: true }, 'sa3')).body as { allowed: boolean };
    expect(behalf.allowed).toBe(true);
  });

  it('gates the new routes and survives a restart (deposit rebuilds from the event store)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    // A cashier cannot record a deposit movement (needs concession.contract.manage).
    expect((await depositMove(h, A, 'u-cash', 'JEWEL', 'd1', { kind: 'received', amountMinor: 1_000_000 })).status).toBe(403);
    await depositMove(h, A, 'u-owner', 'JEWEL', 'd1', { kind: 'received', amountMinor: 1_000_000 });

    const restarted = apiHarness({ store: h.store });
    expect(((await depositPos(restarted, A, 'u-owner', 'JEWEL')).body as { outstandingLiabilityMinor: number }).outstandingLiabilityMinor).toBe(1_000_000);
  });
});
