import { describe, it, expect } from 'vitest';
import { concessionExpiryAlerts, type ConcessionContract } from '../../packages/concession/src/index';
import { acceptSubmission, checkPartnerCompliance } from '../../packages/supplier-portal/src/index';
import { awaitsBuyer } from '../../services/purchase/src/supplier-review-desk';

// OB-288 commercial desks — M27-FR-04 (the alert steps) and M24-FR-02 (a delivery status is the order-communication grant's,
// reviewed by nobody), pure.

const counter = (over: Partial<ConcessionContract> = {}): ConcessionContract => ({
  contractId: 'C-J', tenantId: 't', branchId: 'BR1', concessionaireId: 'JEWEL', name: 'Jewellery counter',
  startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'fixed_rent', fixedRentMinor: 1, depositMinor: 0, active: true,
  approvedBy: 'u-owner', insuranceUntil: '2027-06-30', ...over,
});

describe('concession expiry alerts: 30 days, 7 days, lapsed — each step its own alert', () => {
  it('no alert while more than 30 days remain', () => {
    expect(concessionExpiryAlerts([counter()], '2026-11-30')).toEqual([]);
  });
  it('30-day, then 7-day, then lapsed — distinct ids, so the owner is told once per step', () => {
    const at30 = concessionExpiryAlerts([counter()], '2026-12-01');
    const at7 = concessionExpiryAlerts([counter()], '2026-12-25');
    const gone = concessionExpiryAlerts([counter()], '2027-01-01');
    expect([at30[0]!.level, at7[0]!.level, gone[0]!.level]).toEqual(['within_30_days', 'within_7_days', 'lapsed']);
    expect(new Set([at30[0]!.alertId, at7[0]!.alertId, gone[0]!.alertId]).size).toBe(3);
    expect(at7[0]!.daysLeft).toBe(6);
  });
  it('insurance and licence too, most urgent first; a renewal (a new date) is a new alert', () => {
    const a = concessionExpiryAlerts([counter({ insuranceUntil: '2026-12-05', licenceUntil: '2026-12-20' })], '2026-12-01');
    expect(a.map((x) => `${x.document}:${x.level}`)).toEqual(['insurance:within_7_days', 'licence:within_30_days', 'agreement:within_30_days']);
    const renewed = concessionExpiryAlerts([counter({ insuranceUntil: '2027-12-05', licenceUntil: '2026-12-20' })], '2026-12-01');
    expect(renewed.some((x) => x.document === 'insurance')).toBe(false);
  });
  it('no insurance on record is said (it blocks trading); an unapproved or inactive counter is not watched', () => {
    const noInsurance: ConcessionContract = { ...counter(), insuranceUntil: undefined } as unknown as ConcessionContract;
    expect(concessionExpiryAlerts([noInsurance], '2026-06-01')).toEqual([expect.objectContaining({ document: 'insurance', level: 'lapsed', on: '' })]);
    const unapproved = { ...counter({ endsOn: '2026-06-05' }), approvedBy: undefined } as unknown as ConcessionContract;
    expect(concessionExpiryAlerts([unapproved, counter({ active: false, endsOn: '2026-06-05' })], '2026-06-01')).toEqual([]);
  });
});

describe('a delivery status (M24-FR-02)', () => {
  const session = (grants: readonly ('acknowledge_orders' | 'view_orders')[]) => ({ sessionId: 's', partnerId: 'sup-a', tenantId: 't', userId: 'u-sup', grants });
  const compliance = checkPartnerCompliance({ partnerId: 'sup-a', documents: [], required: ['fssai_licence'], today: '2026-10-24' });
  it('needs the order-communication grant, its own order — and NOT compliance, and no review (it commits nothing)', () => {
    expect(acceptSubmission({ submissionId: 'd1', session: session(['acknowledge_orders']), kind: 'delivery_status', compliance, orderPartnerId: 'sup-a', at: 'x' }))
      .toMatchObject({ accepted: true, requiresReview: false });
    expect(acceptSubmission({ submissionId: 'd1', session: session(['view_orders']), kind: 'delivery_status', compliance, at: 'x' })).toMatchObject({ outcome: 'no_grant' });
    expect(acceptSubmission({ submissionId: 'd1', session: session(['acknowledge_orders']), kind: 'delivery_status', compliance, orderPartnerId: 'sup-b', at: 'x' })).toMatchObject({ outcome: 'not_your_order' });
  });
  it('the buyer\'s queue waits on proposals, claims and documented invoices / ASNs — never on a delivery status', () => {
    const base = { submissionId: 's', partnerId: 'p', receivedAt: 'x' };
    expect(awaitsBuyer({ ...base, kind: 'catalogue', requiresReview: true })).toBe(true);
    expect(awaitsBuyer({ ...base, kind: 'invoice', requiresReview: true })).toBe(false); // no document — feeds nothing
    expect(awaitsBuyer({ ...base, kind: 'invoice', requiresReview: true, document: {} })).toBe(true);
    expect(awaitsBuyer({ ...base, kind: 'delivery_status', requiresReview: false, document: {} })).toBe(false);
  });
});
