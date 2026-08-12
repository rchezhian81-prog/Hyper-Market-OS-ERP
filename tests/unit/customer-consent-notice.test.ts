import { describe, it, expect } from 'vitest';
import { checkConsentNotice, type ConsentNotice } from '../../packages/customer/src/consent-notice';

// C1 / DPDP Act 2023 s.5–6 — a consent notice must itemise each data category with its purpose and carry,
// in the notice, the ways to withdraw / raise a grievance / complain to the Board, with withdrawal as easy
// as giving (s.6(6)). Pure: it validates the notice it is handed.

const complete = (over: Partial<ConsentNotice> = {}): ConsentNotice => ({
  items: [
    { dataCategory: 'contact', purpose: 'send your order updates' },
    { dataCategory: 'purchase history', purpose: 'personalise offers you consented to' },
  ],
  withdrawMethod: 'tap "stop" in the app, one tap',
  grievanceContact: 'dpo@sre.example',
  boardComplaintLink: 'https://dpb.gov.in/complaint',
  giveSteps: 2,
  withdrawSteps: 1,
  ...over,
});

const defectsOf = (n: ConsentNotice) => checkConsentNotice(n).defects.map((d) => d.defect);

describe('checkConsentNotice', () => {
  it('passes a complete, itemised notice', () => {
    const check = checkConsentNotice(complete());
    expect(check.compliant).toBe(true);
    expect(check.defects).toEqual([]);
    expect(check.itemCount).toBe(2);
  });

  it('flags a notice that itemises nothing', () => {
    expect(defectsOf(complete({ items: [] }))).toContain('no_itemised_purposes');
  });

  it('flags a data category taken with no stated purpose', () => {
    const check = checkConsentNotice(complete({ items: [{ dataCategory: 'location', purpose: '  ' }] }));
    expect(check.compliant).toBe(false);
    expect(check.defects.find((d) => d.defect === 'purpose_missing')!.detail).toContain('location');
  });

  it('requires the withdraw, grievance and Board links to be present', () => {
    expect(defectsOf(complete({ withdrawMethod: undefined }))).toContain('no_withdraw_method');
    expect(defectsOf(complete({ grievanceContact: '  ' }))).toContain('no_grievance_contact');
    expect(defectsOf(complete({ boardComplaintLink: undefined }))).toContain('no_board_complaint_link');
  });

  it('requires withdrawal to be no harder than giving (s.6(6))', () => {
    expect(defectsOf(complete({ giveSteps: 1, withdrawSteps: 3 }))).toContain('withdrawal_harder_than_giving');
    // Equal or easier is fine.
    expect(checkConsentNotice(complete({ giveSteps: 2, withdrawSteps: 2 })).compliant).toBe(true);
    // The symmetry is only checked when both counts are supplied.
    expect(checkConsentNotice(complete({ giveSteps: undefined, withdrawSteps: undefined })).compliant).toBe(true);
  });

  it('names EVERY defect at once, not just the first', () => {
    const bare: ConsentNotice = { items: [] };
    const defects = defectsOf(bare);
    expect(defects).toEqual(
      expect.arrayContaining(['no_itemised_purposes', 'no_withdraw_method', 'no_grievance_contact', 'no_board_complaint_link']),
    );
  });
});
