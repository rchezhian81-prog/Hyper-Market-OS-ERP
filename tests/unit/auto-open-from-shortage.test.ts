import { describe, it, expect } from 'vitest';
import { planInvestigationFromShortage, type ShiftShortageFacts } from '../../packages/loss-prevention/src/index';

// Auto-open an investigation from a material cash shortage (M15-FR-04 / P-03). A material SHORT opens a
// case automatically, assigned to a store manager who is NOT the cashier who counted the drawer. An over
// or a within-tolerance close opens nothing; a store with no eligible investigator is a visible gap.

const shift = (over: Partial<ShiftShortageFacts> = {}): ShiftShortageFacts => ({
  shiftId: 'S1', tillId: 'T1', cashierId: 'u-cashier', tradingDay: '2026-09-12',
  varianceMinor: -1_000, exceptionRaised: true, currency: 'INR', ...over,
});

describe('planning an investigation from a shift shortage', () => {
  it('opens a case on a material short, subject = cashier, assigned to a store manager who is not the cashier', () => {
    const plan = planInvestigationFromShortage({ shift: shift(), storeManagers: ['u-sm'] });
    expect(plan.open).toBe(true);
    expect(plan.subjectRef).toBe('u-cashier');
    expect(plan.assignedTo).toBe('u-sm');
    expect(plan.valueMinor).toBe(1_000);
    expect(plan.caseId).toBe('shortage-S1');
    expect(plan.raisedFromRef).toBe('shift-shortage:S1');
  });

  it('does NOT open a case for an over (a surplus is not a loss to investigate)', () => {
    const plan = planInvestigationFromShortage({ shift: shift({ varianceMinor: 1_000 }), storeManagers: ['u-sm'] });
    expect(plan.open).toBe(false);
    expect(plan.refusedBecause).toBe('not_a_material_shortage');
  });

  it('does NOT open a case for a within-tolerance close (not an exception)', () => {
    const plan = planInvestigationFromShortage({ shift: shift({ varianceMinor: -10, exceptionRaised: false }), storeManagers: ['u-sm'] });
    expect(plan.open).toBe(false);
    expect(plan.refusedBecause).toBe('not_a_material_shortage');
  });

  it('refuses (visibly) when there is no store manager to assign the investigation to', () => {
    const plan = planInvestigationFromShortage({ shift: shift(), storeManagers: [] });
    expect(plan.open).toBe(false);
    expect(plan.refusedBecause).toBe('no_eligible_investigator');
  });

  it('will not assign the cashier to investigate their own drawer — picks another manager, or refuses', () => {
    // The cashier is themselves a store manager, and the only one → no eligible investigator.
    const soleManagerIsCashier = planInvestigationFromShortage({ shift: shift({ cashierId: 'u-sm' }), storeManagers: ['u-sm'] });
    expect(soleManagerIsCashier.open).toBe(false);
    expect(soleManagerIsCashier.refusedBecause).toBe('no_eligible_investigator');

    // With another manager present, that other manager is chosen (deterministically, by id).
    const another = planInvestigationFromShortage({ shift: shift({ cashierId: 'u-sm' }), storeManagers: ['u-sm', 'u-other'] });
    expect(another.open).toBe(true);
    expect(another.assignedTo).toBe('u-other');
  });

  it('picks deterministically (lowest id) when several managers are eligible', () => {
    const plan = planInvestigationFromShortage({ shift: shift(), storeManagers: ['u-zed', 'u-amy', 'u-bob'] });
    expect(plan.assignedTo).toBe('u-amy');
  });
});
