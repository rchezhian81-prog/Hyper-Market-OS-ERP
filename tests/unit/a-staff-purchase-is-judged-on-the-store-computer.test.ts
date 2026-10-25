import { describe, it, expect } from 'vitest';
import { checkStaffPurchase, packStaffPurchaseOf, staffBillOf } from '../../edge/store-edge/src/staff-purchase-gate';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';

// OB-301 (M15-FR-03, owner 23 Oct 2026): the store computer's half of "staff buy only at the service desk, under the owner's
// cap, never billing themselves" — read from the store pack's `policies.staffPurchase`, judged before the disk.

const policies = (staffPurchase: unknown) => ({ tradingDayCutoff: '00:00', staffPurchase });
const ACCOUNTS = [{ customerRef: 'M-RAVI', employeeId: 'u-ravi' }, { customerRef: 'M-MEENA', employeeId: 'u-meena' }];
const sale = (customerRef: string | undefined, lines: Record<string, unknown>[] = [{ productId: 'p', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_000, lineTotalMinor: 10_000 }], cashierId = 'u-meena') =>
  ({ id: 'S-1', laneId: 'claimed-lane', cashierId, lines, ...(customerRef === undefined ? {} : { customerRef }) });

describe('OB-301 — the store pack\'s staff-purchase policy, read on the store computer', () => {
  it('not carried → undefined; carried with nothing set → both parts "not set"; accounts read, junk skipped', () => {
    expect(packStaffPurchaseOf({ tradingDayCutoff: '00:00' })).toBeUndefined();
    expect(packStaffPurchaseOf(undefined)).toBeUndefined();
    const unset = packStaffPurchaseOf(policies({ staffDiscountCapBps: null, serviceDeskLaneIds: null, staffAccounts: [...ACCOUNTS, { customerRef: '' }, 'junk'] }))!;
    expect(unset.policy).toEqual({ staffDiscountCapBps: null, serviceDeskLaneIds: null });
    expect([...unset.accounts]).toEqual([['M-RAVI', 'u-ravi'], ['M-MEENA', 'u-meena']]);
    // A malformed cap is "not set" — never a guessed number.
    expect(packStaffPurchaseOf(policies({ staffDiscountCapBps: 'ten', serviceDeskLaneIds: [] }))!.policy).toEqual({ staffDiscountCapBps: null, serviceDeskLaneIds: null });
  });

  it('the bill as the rule reads it: a lowered price starts from its own list price; the record\'s lane is NOT used', () => {
    const bill = staffBillOf(sale('M-RAVI', [{ quantityMinor: 1, unitPriceMinor: 8_000, lineTotalMinor: 8_000, priceOverride: { fromUnitPriceMinor: 10_000 } }]), 'lane-desk');
    expect(bill).toEqual({ laneId: 'lane-desk', cashierId: 'u-meena', customerRef: 'M-RAVI', lines: [{ quantityMinor: 1, unitPriceMinor: 8_000, lineTotalMinor: 8_000, listUnitPriceMinor: 10_000 }] });
  });
});

describe('OB-301 — judged before the disk', () => {
  const set = packStaffPurchaseOf(policies({ staffDiscountCapBps: 1_000, serviceDeskLaneIds: ['lane-desk'], staffAccounts: ACCOUNTS }));
  const unset = packStaffPurchaseOf(policies({ staffDiscountCapBps: null, serviceDeskLaneIds: null, staffAccounts: ACCOUNTS }));

  it('a pack without the policy refuses nothing (head office\'s list backstops it); a customer\'s bill is never a staff purchase', () => {
    expect(checkStaffPurchase(sale('M-RAVI'), 'lane-1', undefined)).toEqual({ ok: true, staffPurchase: false });
    expect(checkStaffPurchase(sale('M-CUSTOMER'), 'lane-1', set)).toEqual({ ok: true, staffPurchase: false });
    expect(checkStaffPurchase(sale(undefined), 'lane-1', set)).toEqual({ ok: true, staffPurchase: false });
  });

  it('"not set": no service desk named → refused at every till; no cap → no staff discount at all (the shelf price is fine at the desk)', () => {
    const r = checkStaffPurchase(sale('M-RAVI'), 'lane-desk', unset);
    expect(r).toMatchObject({ ok: false, refusedBecause: 'staff_purchase_refused', refusals: ['not_at_service_desk'], notSet: ['service_desk', 'staff_discount_cap'] });
    if (r.ok) throw new Error('refused');
    expect(r.laneMessage).toMatch(/^Do not take payment\. This is a staff member's own shopping\. .*not set.* Nothing was saved\.$/);
    expect(r.laneMessageTa).toMatch(/^பணம் வாங்க வேண்டாம்\. .*அமைக்கப்படவில்லை.*எதுவும் சேமிக்கப்படவில்லை\.$/);
    const deskOnly = packStaffPurchaseOf(policies({ staffDiscountCapBps: null, serviceDeskLaneIds: ['lane-desk'], staffAccounts: ACCOUNTS }));
    expect(checkStaffPurchase(sale('M-RAVI'), 'lane-desk', deskOnly)).toEqual({ ok: true, staffPurchase: true });
    expect(checkStaffPurchase(sale('M-RAVI', [{ quantityMinor: 1, unitPriceMinor: 9_900, lineTotalMinor: 9_900, priceOverride: { fromUnitPriceMinor: 10_000 } }]), 'lane-desk', deskOnly))
      .toMatchObject({ ok: false, refusals: ['discount_above_cap'], notSet: ['staff_discount_cap'] });
  });

  it('set: at the desk within the cap → saved; at another lane → refused; over the cap → refused; self-billing → refused, whatever the lane', () => {
    expect(checkStaffPurchase(sale('M-RAVI'), 'lane-desk', set)).toEqual({ ok: true, staffPurchase: true });
    const within = [{ quantityMinor: 1, unitPriceMinor: 9_000, lineTotalMinor: 9_000, priceOverride: { fromUnitPriceMinor: 10_000 } }];
    expect(checkStaffPurchase(sale('M-RAVI', within), 'lane-desk', set)).toEqual({ ok: true, staffPurchase: true });
    // The record says it came from the desk; this box's lane is lane-1 — refused.
    expect(checkStaffPurchase({ ...sale('M-RAVI'), laneId: 'lane-desk' }, 'lane-1', set)).toMatchObject({ ok: false, refusals: ['not_at_service_desk'] });
    const over = checkStaffPurchase(sale('M-RAVI', [{ quantityMinor: 1, unitPriceMinor: 8_500, lineTotalMinor: 8_500, priceOverride: { fromUnitPriceMinor: 10_000 } }]), 'lane-desk', set);
    expect(over).toMatchObject({ ok: false, refusals: ['discount_above_cap'] });
    if (over.ok) throw new Error('refused');
    expect(over.laneMessage).toMatch(/15% off; the owner's staff discount is at most 10%/);
    expect(checkStaffPurchase(sale('M-MEENA'), 'lane-desk', set)).toMatchObject({ ok: false, refusals: ['self_billing'] });
    expect(checkStaffPurchase(sale('M-MEENA'), 'lane-1', set)).toMatchObject({ ok: false, refusals: ['self_billing', 'not_at_service_desk'] });
  });
});

describe('OB-301 — head office puts the policy in the store pack', () => {
  it('sent with "not set" parts as null, and the accounts; not wired → not sent', async () => {
    const store = new InMemoryEventStore();
    const base = {
      store, now: () => '2026-10-24T08:00:00.000Z', signer: { sign: () => 'sig', verify: () => true } as never,
      settings: async () => ({ tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, cashVarianceToleranceMinor: 1, privacySlaDays: 15, warehouseId: 'S1' }),
      storeName: async () => 'Store 1',
    };
    const without = await buildStorePackSections(base as never, 't', 'S1');
    expect((without['policies'] as Record<string, unknown>)['staffPurchase']).toBeUndefined();
    const sent = { staffDiscountCapBps: null, serviceDeskLaneIds: null, staffAccounts: ACCOUNTS };
    const withIt = await buildStorePackSections({ ...base, staffPurchase: async () => sent } as never, 't', 'S1');
    expect((withIt['policies'] as Record<string, unknown>)['staffPurchase']).toEqual(sent);
  });
});
