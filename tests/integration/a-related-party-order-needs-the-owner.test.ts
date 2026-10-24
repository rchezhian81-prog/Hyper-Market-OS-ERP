import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedRequestId } from '../support/approval-request';
import { deliveryPlaces, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

// M15-FR-03 · OB-301 (owner, 23 Oct 2026, in writing): "the owner keeps a related-party list; a supplier matching that
// list by GSTIN, phone or bank account needs the owner's approval before a purchase order". Through the real API, in
// memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart between the list and the orders. Synthetic data.
//
//   • only the owner keeps and reads the list (a manager and a cashier are refused, 403);
//   • a supplier whose GSTIN, phone or bank account is on the list: the order may be proposed (the reply says it needs
//     the owner, naming the matched fact and never the related person); the owner approves it in writing (sealed on the
//     audit trail) before it is issued. (In this shop's role catalogue only the owner issues an order at all; the guard's
//     refusal of anybody else is proven in tests/unit/related-party-controls.test.ts.)
//   • an approval covers THESE facts: when the list gains an entry the supplier now also matches, a fresh approval is needed;
//   • the owner issuing an order himself is his approval (recorded);
//   • a supplier on nobody's list is ordered exactly as before.

const backings = useRestartableBackings();
const GSTIN = '33ABCDE1234F1Z5';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('a related-party order needs the owner (M15-FR-03 · OB-301) — on $name', ({ harness }) => {
  it('list → propose (told, by the fact) → the owner approves in writing → issued; the owner issuing is his approval; a changed match needs a fresh approval; plain suppliers unaffected', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, SUPPLIER_MAKER, 'store_manager');
    await h.provisionRole(T, SUPPLIER_CHECKER, 'accountant');
    await deliveryPlaces(h, T, 'S1', 'WH');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const supplier = async (id: string, body: Record<string, unknown>) => {
      await ok(call('POST', `/v1/purchase/suppliers/${id}`, SUPPLIER_MAKER, body), `propose ${id}`);
      await ok(call('POST', `/v1/purchase/suppliers/${id}/approval`, SUPPLIER_CHECKER, { reason: 'documents checked' }), `approve ${id}`);
    };
    await supplier('sup-kumar', { name: 'Kumar Wholesale', gstin: GSTIN, phone: '+91 98400 12345' });
    await supplier('sup-plain', { name: 'Plain Distributors', gstin: '33ZZZZZ9999Z1Z9' });
    const order = (poId: string, supplierId: string) => call('POST', `/v1/purchase/orders/${poId}`, 'u-buyer', { supplierId, deliverToLocationId: 'WH', lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }] });

    // Only the owner keeps the list.
    const entry = { name: 'Kumar Traders', kind: 'firm', relation: "owner's brother's firm", gstins: [GSTIN.toLowerCase()] };
    expect((await call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-mgr', entry)).status).toBe(403);
    expect((await call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-cash', entry)).status).toBe(403);
    expect((await call('GET', '/v1/loss-prevention/related-parties', 'u-mgr')).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-owner', { ...entry, gstins: [] }))).toBe('not_readable_as_a_related_party');
    expect(codeOf(await call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-owner', { ...entry, gstins: ['33ABC'] }))).toBe('not_readable_as_a_related_party');
    await ok(call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-owner', entry), 'the owner records RP-1');

    h = harness(h); // ── COLD RESTART: the guard reads the list and the supplier from what is stored ──

    const list = (await ok(call('GET', '/v1/loss-prevention/related-parties', 'u-owner'), 'list')).body as { parties: { partyId: string; gstins: string[] }[]; supplierMatches: { supplierId: string; matches: { partyId: string; on: string; shown: string }[] }[] };
    expect(list.parties.map((p) => [p.partyId, p.gstins])).toEqual([['RP-1', [GSTIN]]]);
    expect(list.supplierMatches).toEqual([{ supplierId: 'sup-kumar', name: 'Kumar Wholesale', matches: [{ partyId: 'RP-1', partyName: 'Kumar Traders', relation: "owner's brother's firm", on: 'gstin', shown: GSTIN }] }]);

    // Proposing is allowed, and the buyer is told at once.
    const proposed = (await ok(order('po-1', 'sup-kumar'), 'propose po-1')).body as { relatedParty?: { needsOwnerApproval: boolean; matchedOn: string; detail: string } };
    expect(proposed.relatedParty).toMatchObject({ needsOwnerApproval: true, matchedOn: 'GSTIN' });
    expect(JSON.stringify(proposed)).not.toMatch(/Kumar Traders|brother/); // the buyer is told the FACT, never the person
    expect((await ok(call('GET', '/v1/purchase/orders/po-1/related-party', 'u-mgr'), 'position')).body).toMatchObject({ needed: true, matchedOn: 'GSTIN', approved: false, approval: null });
    // Issuing a purchase order is the owner's alone in this shop's role catalogue; a manager is refused before anything.
    expect((await call('POST', '/v1/purchase/orders/po-1/approval', 'u-mgr', { reason: 'weekly rice' })).status).toBe(403);

    // The owner approves the related-party order in writing (only the owner; a reason is required).
    expect((await call('POST', '/v1/purchase/orders/po-1/related-party-approval', 'u-mgr', { reason: 'fine' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/purchase/orders/po-1/related-party-approval', 'u-owner', {}))).toBe('reason_required');
    await ok(call('POST', '/v1/purchase/orders/po-1/related-party-approval', 'u-owner', { reason: 'best rate this month; I know the firm' }), 'owner approves po-1');
    // The same approval again is the same approval.
    expect((await ok(call('POST', '/v1/purchase/orders/po-1/related-party-approval', 'u-owner', { reason: 'again' }), 'again')).body).toMatchObject({ alreadyApproved: true });

    h = harness(h); // ── COLD RESTART ──
    expect((await ok(call('GET', '/v1/purchase/orders/po-1/related-party', 'u-mgr'), 'position')).body).toMatchObject({ needed: true, approved: true, approval: { approvedBy: 'u-owner', via: 'approval_route', reason: 'best rate this month; I know the firm' } });
    const issued = (await ok(call('POST', '/v1/purchase/orders/po-1/approval', 'u-owner', { reason: 'weekly rice' }), 'issue po-1')).body as { order: { status: string } };
    expect(issued.order.status).toBe('issued');
    const trail = (await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'purchase.order.related_party_approved' }), 'trail')).body as { matches: { actorId: string; objectId: string; after: Record<string, string>; reason?: string }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after['matchedOn'], m.reason])).toEqual([['u-owner', 'po-1', 'GSTIN', 'best rate this month; I know the firm']]);

    // The owner issuing an order himself IS his approval — recorded beside the order.
    await ok(order('po-2', 'sup-kumar'), 'propose po-2');
    await ok(call('POST', '/v1/purchase/orders/po-2/approval', 'u-owner', { reason: 'I approve this one myself' }), 'owner issues po-2');
    expect((await ok(call('GET', '/v1/purchase/orders/po-2/related-party', 'u-mgr'), 'po-2')).body).toMatchObject({ needed: true, approved: true, approval: { approvedBy: 'u-owner', via: 'owner_issued' } });

    // An approval covers THESE facts: the owner adds the supplier's phone to the list — the match changed, so the
    // approval given for the GSTIN alone no longer covers po-3; a fresh one does.
    await ok(order('po-3', 'sup-kumar'), 'propose po-3');
    await ok(call('POST', '/v1/purchase/orders/po-3/related-party-approval', 'u-owner', { reason: 'approved for the GSTIN' }), 'approve po-3');
    await ok(call('POST', '/v1/loss-prevention/related-parties/RP-2', 'u-owner', { name: 'Ravi', kind: 'person', relation: 'store manager\'s cousin', phones: ['9840012345'] }), 'RP-2');
    expect((await ok(call('GET', '/v1/purchase/orders/po-3/related-party', 'u-mgr'), 'po-3')).body).toMatchObject({ needed: true, matchedOn: 'GSTIN, phone number', approved: false });
    await ok(call('POST', '/v1/purchase/orders/po-3/related-party-approval', 'u-owner', { reason: 'approved for both' }), 'approve po-3 again');
    expect((await ok(call('GET', '/v1/purchase/orders/po-3/related-party', 'u-mgr'), 'po-3')).body).toMatchObject({ approved: true, approval: { reason: 'approved for both' } });

    // A supplier on nobody's list is ordered exactly as before.
    const plain = (await ok(order('po-4', 'sup-plain'), 'propose po-4')).body as Record<string, unknown>;
    expect(plain['relatedParty']).toBeUndefined();
    expect((await ok(call('GET', '/v1/purchase/orders/po-4/related-party', 'u-mgr'), 'po-4')).body).toMatchObject({ needed: false, matchedOn: null });
    await ok(call('POST', '/v1/purchase/orders/po-4/approval', 'u-owner', { reason: 'weekly' }), 'issue po-4');

    // Taking an entry off the list (kept, inactive) stops it matching.
    await ok(call('POST', '/v1/loss-prevention/related-parties/RP-1', 'u-owner', { ...entry, active: false }), 'RP-1 off');
    // The take-off door keeps the entry's facts (append-only) and needs a reason; a relative's number is shown masked.
    const shownBefore = (await ok(call('GET', '/v1/loss-prevention/related-parties', 'u-owner'), 'list')).body as { parties: { partyId: string; phones: string[] }[] };
    expect(shownBefore.parties.find((p) => p.partyId === 'RP-2')!.phones).toEqual(['98****2345']);
    expect((await call('POST', '/v1/loss-prevention/related-parties/RP-2/take-off', 'u-mgr', { reason: 'x' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/loss-prevention/related-parties/RP-2/take-off', 'u-owner', {}))).toBe('take_off_needs_a_reason');
    expect((await call('POST', '/v1/loss-prevention/related-parties/RP-9/take-off', 'u-owner', { reason: 'gone' })).status).toBe(404);
    await ok(call('POST', '/v1/loss-prevention/related-parties/RP-2/take-off', 'u-owner', { reason: 'no longer related' }), 'RP-2 off');
    expect(((await ok(call('POST', '/v1/loss-prevention/related-parties/RP-2/take-off', 'u-owner', { reason: 'again' }), 'RP-2 off again')).body as { alreadyOff: boolean }).alreadyOff).toBe(true);
    await ok(order('po-5', 'sup-kumar'), 'propose po-5');
    expect((await ok(call('GET', '/v1/purchase/orders/po-5/related-party', 'u-mgr'), 'po-5')).body).toMatchObject({ needed: false });
    const after = (await ok(call('GET', '/v1/loss-prevention/related-parties', 'u-owner'), 'list')).body as { count: number; active: number; supplierMatches: unknown[] };
    expect([after.count, after.active, after.supplierMatches]).toEqual([2, 0, []]);
  }, 120_000);
});

describe.each(backings)('staff purchases and salary accounts (M15-FR-03 · OB-301) — on $name', ({ harness }) => {
  it('the owner\'s two numbers are "not set" until entered; staff bills are judged by the till\'s own rule; a salary account shared with a supplier blocks the payment', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, SUPPLIER_MAKER, 'store_manager');
    await h.provisionRole(T, SUPPLIER_CHECKER, 'accountant');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    for (const [id, name, roles] of [['u-cash', 'Asha', ['cashier']], ['u-mgr', 'Bala', ['store_manager']], ['u-staff', 'Chitra', ['cashier']]] as const) {
      await ok(call('POST', `/v1/hr/workforce/employees/${id}`, 'u-mgr2', { name, branchId: 'br-1', roles, active: true }), `employee ${id}`);
    }

    // Not set until the owner enters it — said, never a made-up number.
    expect((await ok(call('GET', '/v1/loss-prevention/staff-purchases/policy', 'u-mgr'), 'policy')).body).toMatchObject({ staffDiscountCapBps: null, serviceDeskLaneIds: null, notSet: ['staff_discount_cap', 'service_desk'] });
    expect((await call('POST', '/v1/loss-prevention/staff-purchases/policy', 'u-mgr', { staffDiscountCapBps: 1000, serviceDeskLaneIds: ['desk-1'] })).status).toBe(403);

    // A manager records a staff member's own customer account; never their own; only someone on the staff list.
    expect((await call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-staff', 'u-cash', { customerRef: 'M-333' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-mgr', 'u-mgr', { customerRef: 'M-222' }))).toBe('own_staff_account');
    expect((await call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-nobody', 'u-mgr', { customerRef: 'M-999' })).status).toBe(404);
    await ok(call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-cash', 'u-mgr', { customerRef: 'M-111' }), 'staff account u-cash');
    await ok(call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-staff', 'u-mgr', { customerRef: 'M-333' }), 'staff account u-staff');
    expect(codeOf(await call('POST', '/v1/loss-prevention/staff-purchases/accounts/u-mgr', 'u-mgr2', { customerRef: 'M-111' }))).toBe('customer_account_already_staff');

    // The bills that arrived. S1: the cashier rang her own shopping at lane 1. S2: at the desk, 5% off. S3: at the desk,
    // 20% off. S4: an ordinary customer.
    const day = new Date().toISOString().slice(0, 10);
    const sale = (saleId: string, laneId: string, cashierId: string, customerRef: string | undefined, charged: number, from?: number) => {
      const line = { productId: 'p-rice', quantityMinor: 1, uom: 'each', unitPriceMinor: charged, lineTotalMinor: charged, ...(from === undefined ? {} : { priceOverride: { fromUnitPriceMinor: from, approvedBy: 'u-mgr2' } }) };
      return ok(call('POST', '/v1/sales', 'u-owner', {
        saleId, receiptNumber: `R-${saleId}`, laneId, cashierId, tradingDay: day, committedAt: new Date(Date.now() - 60_000).toISOString(), totalMinor: charged, currency: 'INR', packVersion: 1, locationId: 'br-1',
        lines: [line], tenders: [{ kind: 'cash', amountMinor: charged }], ...(customerRef === undefined ? {} : { customerRef }),
      }), `sale ${saleId}`);
    };
    await sale('S1', 'lane-1', 'u-cash', 'M-111', 10_000);
    await sale('S2', 'desk-1', 'u-mgr', 'M-333', 9_500, 10_000);
    await sale('S3', 'desk-1', 'u-mgr', 'M-333', 8_000, 10_000);
    await sale('S4', 'lane-1', 'u-cash', 'M-444', 10_000);

    const notSet = (await ok(call('GET', '/v1/loss-prevention/staff-purchases/exceptions', 'u-mgr'), 'exceptions')).body as { bills: { saleId: string; allowed: boolean; refusals: string[]; notSet: string[] }[]; staffBills: number; refused: number };
    // With nothing set, every staff bill is refused: no till is the service desk yet, and no discount may be given.
    expect(notSet.bills.map((b) => [b.saleId, b.allowed, b.refusals]).sort()).toEqual([
      ['S1', false, ['self_billing', 'not_at_service_desk']], ['S2', false, ['not_at_service_desk', 'discount_above_cap']], ['S3', false, ['not_at_service_desk', 'discount_above_cap']],
    ]);
    expect(notSet.staffBills).toBe(3);

    await ok(call('POST', '/v1/loss-prevention/staff-purchases/policy', 'u-owner', { staffDiscountCapBps: 1000, serviceDeskLaneIds: ['desk-1'] }), 'the owner sets both');
    h = harness(h); // ── COLD RESTART ──
    const judged = (await ok(call('GET', '/v1/loss-prevention/staff-purchases/exceptions', 'u-mgr'), 'exceptions')).body as { bills: { saleId: string; allowed: boolean; refusals: string[]; discountBps: number; words: { en: string; ta: string } }[]; refused: number; policy: { notSet: string[] } };
    expect(judged.policy.notSet).toEqual([]);
    expect(judged.bills.map((b) => [b.saleId, b.allowed, b.refusals, b.discountBps]).sort()).toEqual([
      ['S1', false, ['self_billing', 'not_at_service_desk'], 0], ['S2', true, [], 500], ['S3', false, ['discount_above_cap'], 2000],
    ]);
    expect(judged.refused).toBe(2);
    expect(judged.bills.find((b) => b.saleId === 'S3')!.words.en).toBe("This bill gives 20% off; the owner's staff discount is at most 10%.");
    expect(judged.bills.find((b) => b.saleId === 'S1')!.words.ta).toMatch(/பணியாளர்/);
    // The till's copy of the rule, for its pack.
    expect((await ok(call('GET', '/v1/loss-prevention/staff-purchases/till-policy', 'u-owner'), 'till policy')).body).toMatchObject({ staffDiscountCapBps: 1000, serviceDeskLaneIds: ['desk-1'], staffAccounts: [{ customerRef: 'M-111', employeeId: 'u-cash' }, { customerRef: 'M-333', employeeId: 'u-staff' }] });
    expect((await call('GET', '/v1/loss-prevention/staff-purchases/till-policy', 'u-acct')).status).toBe(403);

    // A supplier whose account is the staff member's salary account: the duplicate fold names both; the payment is blocked.
    await ok(call('POST', '/v1/purchase/suppliers/sup-x', SUPPLIER_MAKER, { name: 'X Supplies' }), 'propose sup-x');
    await ok(call('POST', '/v1/purchase/suppliers/sup-x/approval', SUPPLIER_CHECKER, { reason: 'documents checked' }), 'approve sup-x');
    const change = { newAccount: 'HDFC-0001-2345-6789', requestedVia: 'letter', calledBackOn: '+91-800-1', numberWeAlreadyHeld: '+91-800-1', requestedAt: '2026-09-30T08:00:00.000Z' };
    const approvalId = await approvedRequestId(h, T, 'u-owner', 'u-acct', { kind: 'supplier_bank_change', subjectRef: 'sup-x', details: { ...change, supplierId: 'sup-x' } });
    await ok(call('POST', '/v1/purchase/suppliers/sup-x/bank-details', 'u-owner', { ...change, approvalId }), 'bank details');
    expect((await call('POST', '/v1/hr/workforce/employees/u-staff/salary-account', 'u-mgr', { accountRef: 'HDFC 0001 2345 6789' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/hr/workforce/employees/u-acct/salary-account', 'u-acct', { accountRef: '1234567890' }))).toBe('own_salary_account');
    const recorded = (await ok(call('POST', '/v1/hr/workforce/employees/u-staff/salary-account', 'u-acct', { accountRef: 'hdfc 0001 2345 6789' }), 'salary account')).body as { account: string };
    expect(recorded.account).toBe('••••6789');
    expect((await ok(call('GET', '/v1/hr/workforce/salary-accounts', 'u-owner'), 'salary accounts')).body).toMatchObject({ accounts: [{ employeeId: 'u-staff', account: '••••6789', recordedBy: 'u-acct' }] });

    h = harness(h); // ── COLD RESTART ──
    const dup = (await ok(call('GET', '/v1/fraud-signals/duplicate-bank', 'u-mgr'), 'duplicate bank')).body as { flags: { accountRef: string; holders: { holderId: string; holderType: string }[] }[]; blocked: string[]; employeesFolded: number };
    expect(dup.flags).toEqual([{ accountRef: '••••6789', holders: [{ holderId: 'sup-x', holderType: 'supplier' }, { holderId: 'u-staff', holderType: 'employee' }] }]);
    expect([dup.blocked, dup.employeesFolded]).toEqual([['sup-x', 'u-staff'], 1]);
    const pay = await call('POST', '/v1/purchase/suppliers/sup-x/payments/pay-1', 'u-acct', { amountMinor: 1000, paidOn: '2026-10-02', method: 'bank_transfer', reference: 'UTR-1' });
    expect(pay.status).toBe(409);
    expect((pay.body as { error: { code: string; whatHappened: string } }).error).toMatchObject({ code: 'duplicate_bank_account' });
    expect((pay.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/also an employee's salary account/);
    const sealed = (await ok(call('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'hr.salaryaccount.recorded' }), 'trail')).body as { matches: { actorId: string; objectId: string; after: Record<string, string> }[] };
    expect(sealed.matches.map((m) => [m.actorId, m.objectId, m.after['account']])).toEqual([['u-acct', 'u-staff', '••••6789']]);
  }, 120_000);
});
