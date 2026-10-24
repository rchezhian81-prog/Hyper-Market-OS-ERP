import { describe, it, expect } from 'vitest';
import { matchSupplier, matchFingerprint, readRelatedParty, normalPhone, maskedAccount, shownParty, type RelatedParty } from '../../packages/loss-prevention/src/related-party';
import { judgeStaffPurchase, staffDiscountOf, readStaffPurchasePolicy } from '../../packages/restricted-sales/src/staff-purchase';
import { withRelatedPartyOrderGuard, relatedPartyApprovalRoutes, type RelatedPartyOrderGuardDeps, type RelatedPartyOrderApproval } from '../../services/purchase/src/related-party-order-guard';
import type { Route, RequestContext } from '../../services/kernel/src/index';
import { ApiError } from '../../services/kernel/src/index';
import type { StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';

// M15-FR-03 · OB-301 — the related-party match, the staff-purchase rule and the purchase-order guard, as pure units.

const party = (over: Partial<RelatedParty> = {}): RelatedParty => ({
  partyId: 'RP-1', name: 'Kumar Traders', kind: 'firm', relation: 'brother', gstins: ['33ABCDE1234F1Z5'], phones: [], bankAccountRefs: [], active: true, ...over,
});

describe('the related-party match (OB-301)', () => {
  it('matches on a GSTIN, a phone or a bank account, each in its one written form — never on a name', () => {
    const p = party({ phones: ['9840012345'], bankAccountRefs: ['HDFC00012345678'] });
    const supplier = { supplierId: 's', gstin: '33abcde1234f1z5', phone: '+91-98400 12345', bankAccountRef: 'hdfc 0001 2345 678' };
    expect(matchSupplier(supplier, [p]).map((m) => [m.on, m.shown])).toEqual([['gstin', '33ABCDE1234F1Z5'], ['phone', '98****2345'], ['bank_account', '••••5678']]);
    expect(matchSupplier({ supplierId: 's', gstin: null, phone: null, bankAccountRef: null }, [party({ name: 'Same Name' })])).toEqual([]);
    // An inactive entry matches nothing; a usable fact is required (a 3-digit "phone" matches nothing).
    expect(matchSupplier(supplier, [{ ...p, active: false }])).toEqual([]);
    expect(matchSupplier({ supplierId: 's', gstin: null, phone: '123', bankAccountRef: null }, [party({ phones: ['123'] })])).toEqual([]);
    expect(normalPhone('0 98400-12345')).toBe('9840012345');
    expect(maskedAccount('12')).toBe('••••');
  });

  it('fingerprints the facts and the matching entries, so a changed fact or list is a different match', () => {
    const s = { supplierId: 's', gstin: '33ABCDE1234F1Z5', phone: null, bankAccountRef: null };
    const one = matchFingerprint(s, matchSupplier(s, [party()]));
    expect(matchFingerprint(s, matchSupplier(s, [party()]))).toBe(one);
    expect(matchFingerprint({ ...s, phone: '9840012345' }, matchSupplier(s, [party()]))).not.toBe(one);
    expect(matchFingerprint(s, matchSupplier(s, [party(), party({ partyId: 'RP-2' })]))).not.toBe(one);
    // A one-way SHA-256: an approval record never carries the phone or the bank account itself.
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads an entry only with at least one fact, and shows its bank accounts masked', () => {
    expect(readRelatedParty('RP-1', { name: 'K', kind: 'firm', relation: 'x' })).toMatchObject({ ok: false });
    expect(readRelatedParty('RP-1', { name: 'K', kind: 'shop', relation: 'x', gstins: ['33ABCDE1234F1Z5'] })).toMatchObject({ ok: false });
    expect(readRelatedParty('RP-1', { name: 'K', kind: 'firm', relation: 'x', phones: ['12'] })).toMatchObject({ ok: false });
    const r = readRelatedParty('RP-1', { name: ' K ', kind: 'person', relation: 'cousin', bankAccountRefs: ['sbi-1234 5678'] });
    expect(r.ok && shownParty(r.party).bankAccountRefs).toEqual(['••••5678']);
  });
});

describe('the staff-purchase rule (OB-301) — the same answer at the till and at head office', () => {
  const staff = new Map([['M-1', 'u-asha']]);
  const set = { staffDiscountCapBps: 1000, serviceDeskLaneIds: ['desk-1'] };
  const lines = (charged: number, list?: number) => [{ quantityMinor: 1, unitPriceMinor: charged, lineTotalMinor: charged, ...(list === undefined ? {} : { listUnitPriceMinor: list }) }];

  it('is not a staff purchase when no staff account is named', () => {
    expect(judgeStaffPurchase({ laneId: 'lane-1', cashierId: 'u-asha', customerRef: 'M-9', lines: lines(100) }, set, staff)).toEqual({ staffPurchase: false, allowed: true });
    expect(judgeStaffPurchase({ laneId: 'lane-1', cashierId: 'u-asha', lines: lines(100) }, set, staff)).toEqual({ staffPurchase: false, allowed: true });
  });

  it('refuses self-billing anywhere, a lane that is not the service desk, and a discount above the cap', () => {
    const self = judgeStaffPurchase({ laneId: 'desk-1', cashierId: 'u-asha', customerRef: 'M-1', lines: lines(100) }, set, staff);
    expect(self).toMatchObject({ staffPurchase: true, allowed: false, refusals: ['self_billing'], employeeId: 'u-asha' });
    expect(judgeStaffPurchase({ laneId: 'lane-1', cashierId: 'u-bala', customerRef: 'M-1', lines: lines(100) }, set, staff)).toMatchObject({ allowed: false, refusals: ['not_at_service_desk'] });
    expect(judgeStaffPurchase({ laneId: 'desk-1', cashierId: 'u-bala', customerRef: 'M-1', lines: lines(9_000, 10_000) }, set, staff)).toMatchObject({ allowed: true, refusals: [], discountBps: 1000 });
    const over = judgeStaffPurchase({ laneId: 'desk-1', cashierId: 'u-bala', customerRef: 'M-1', lines: lines(8_900, 10_000) }, set, staff);
    expect(over).toMatchObject({ allowed: false, refusals: ['discount_above_cap'], discountMinor: 1_100, discountBps: 1100 });
    expect(over.staffPurchase && over.words.en).toBe("This bill gives 11% off; the owner's staff discount is at most 10%.");
  });

  it('with nothing set: no till is the service desk and no discount may be given — said as "not set", never guessed', () => {
    const none = readStaffPurchasePolicy({});
    expect(none).toEqual({ staffDiscountCapBps: null, serviceDeskLaneIds: null });
    const d = judgeStaffPurchase({ laneId: 'desk-1', cashierId: 'u-bala', customerRef: 'M-1', lines: lines(9_500, 10_000) }, none, staff);
    expect(d).toMatchObject({ allowed: false, refusals: ['not_at_service_desk', 'discount_above_cap'], notSet: ['service_desk', 'staff_discount_cap'] });
    expect(d.staffPurchase && d.words.en).toMatch(/not named the service-desk till yet \(not set\).*not set the staff discount yet \(not set\)/);
    expect(d.staffPurchase && d.words.ta).toMatch(/அமைக்கப்படவில்லை/);
    // A full-price staff purchase at a desk the owner named is fine with the cap still not set.
    expect(judgeStaffPurchase({ laneId: 'desk-1', cashierId: 'u-bala', customerRef: 'M-1', lines: lines(100) }, { staffDiscountCapBps: null, serviceDeskLaneIds: ['desk-1'] }, staff)).toMatchObject({ allowed: true, notSet: ['staff_discount_cap'] });
    expect(readStaffPurchasePolicy({ staffDiscountCapBps: 20_000, serviceDeskLaneIds: [] })).toEqual({ staffDiscountCapBps: null, serviceDeskLaneIds: null });
  });

  it('works the discount from the lane\'s own prices, weighed lines included, never below zero', () => {
    // 500 g at a price per kg lowered from ₹200 to ₹180: list ₹100, charged ₹90.
    expect(staffDiscountOf([{ quantityMinor: 500, unitPriceMinor: 18_000, listUnitPriceMinor: 20_000, lineTotalMinor: 9_000 }])).toEqual({ discountMinor: 1_000, listMinor: 10_000, discountBps: 1000 });
    expect(staffDiscountOf([{ quantityMinor: 1, unitPriceMinor: 120, listUnitPriceMinor: 100, lineTotalMinor: 120 }]).discountMinor).toBe(0);
  });
});

describe('the related-party purchase-order guard', () => {
  const PO: StoredPurchaseOrder = { poId: 'po-1', number: 'PO-1', supplierId: 'sup-k', requisitionedBy: 'u-buyer', at: 'x', lines: [], totalMinor: 100, currency: 'INR', status: 'proposed', approvedBy: null, issuedAt: null, receivedByProduct: {}, cancelledByProduct: {}, amendmentCount: 0 } as unknown as StoredPurchaseOrder;
  const deps = (over: Partial<RelatedPartyOrderGuardDeps> = {}): RelatedPartyOrderGuardDeps & { approvalsHeld: RelatedPartyOrderApproval[]; audits: string[] } => {
    const approvalsHeld: RelatedPartyOrderApproval[] = [];
    const audits: string[] = [];
    return {
      approvalsHeld, audits,
      order: () => PO,
      supplierFacts: async (_t, supplierId) => ({ supplierId, gstin: '33ABCDE1234F1Z5', phone: null, bankAccountRef: null }),
      relatedParties: async () => [party()],
      approvals: async () => approvalsHeld,
      recordApproval: async (_t, a) => { approvalsHeld.push(a); },
      isOwner: async (_t, u) => u === 'u-owner',
      recordAudit: (_t, e) => { audits.push(`${e.action}:${e.actorId}`); },
      now: () => '2026-10-24T00:00:00.000Z',
      ...over,
    };
  };
  const issued: string[] = [];
  const routes: Route[] = [
    { api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId', permission: 'p', handler: async () => ({ status: 201, body: { order: { supplierId: 'sup-k' } } }) },
    { api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/approval', permission: 'p', handler: async (ctx) => { issued.push(ctx.userId); return { status: 201, body: { order: { status: 'issued' } } }; } },
  ];
  const ctx = (userId: string, body: unknown = { reason: 'weekly' }): RequestContext => ({ tenantId: 't', userId, branchId: null, params: { poId: 'po-1' }, query: {}, body, traceId: 'x' });

  it('refuses anyone but the owner to issue an unapproved related-party order — by the matched fact — and seals it; nothing is issued', async () => {
    const d = deps();
    const guarded = withRelatedPartyOrderGuard(routes, d);
    const issue = guarded.find((r) => r.path.endsWith('/approval'))!;
    const err = await Promise.resolve().then(() => issue.handler(ctx('u-approver'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body.code).toBe('related_party_needs_owner');
    expect((err as ApiError).body.whatHappened).toMatch(/GSTIN matches an entry on the owner's related-party list/);
    expect((err as ApiError).body.whatHappened).not.toMatch(/Kumar|brother/);
    expect(issued).toEqual([]);
    expect(d.audits).toEqual(['purchase.order.refused_related_party:u-approver']);
    // With the owner's approval for these facts, the same approver issues it.
    const approve = relatedPartyApprovalRoutes(d).find((r) => r.method === 'POST')!;
    await approve.handler(ctx('u-owner', { reason: 'I know them' }));
    await issue.handler(ctx('u-approver'));
    expect(issued).toEqual(['u-approver']);
  });

  it('the owner issuing is his approval; a proposer is told; a missing route stops start-up', async () => {
    const d = deps();
    const guarded = withRelatedPartyOrderGuard(routes, d);
    await guarded.find((r) => r.path.endsWith('/approval'))!.handler(ctx('u-owner'));
    expect(d.approvalsHeld.map((a) => [a.approvedBy, a.via])).toEqual([['u-owner', 'owner_issued']]);
    const told = await guarded.find((r) => r.path === '/v1/purchase/orders/:poId')!.handler(ctx('u-buyer'));
    expect((told.body as { relatedParty: { needsOwnerApproval: boolean } }).relatedParty.needsOwnerApproval).toBe(true);
    expect(() => withRelatedPartyOrderGuard([routes[0]!], d)).toThrow(/cannot find POST \/v1\/purchase\/orders\/:poId\/approval/);
    // Only the owner approves on the approval route, even if the permission were held by somebody else.
    const approve = relatedPartyApprovalRoutes(d).find((r) => r.method === 'POST')!;
    expect(((await Promise.resolve().then(() => approve.handler(ctx('u-mgr', { reason: 'x' }))).catch((e: unknown) => e)) as ApiError).status).toBe(403);
  });
});
