import { describe, it, expect } from 'vitest';
import * as workforce from '../../packages/workforce/src/index';
import {
  rosterGaps,
  canPerformTask,
  assessChecklist,
  computeIncentive,
  labourCost,
  sopStatus,
  type Employee,
  type Certification,
  type ShiftRequirement,
  type ChecklistItem,
} from '../../packages/workforce/src/workforce';

// M25-FR-01..04 acceptance: "ROSTER GAPS ARE VISIBLE by shift and role; a lapsed
// certification blocks the gated task; incentives are exact; SOP acknowledgement is
// tracked against the current version."

const employee = (over: Partial<Employee>): Employee => ({
  employeeId: 'e-1',
  name: 'Meena',
  branchId: 'b-main',
  roles: ['cashier'],
  active: true,
  hourlyRateMinor: 9_000,
  ...over,
});

const SUNDAY: ShiftRequirement = {
  shiftId: 'sh-sun-open',
  branchId: 'b-main',
  startsAt: '2026-08-09T06:00:00+05:30',
  endsAt: '2026-08-09T14:00:00+05:30',
  requiredRoles: [
    { role: 'opener', count: 1 },
    { role: 'cashier', count: 3 },
  ],
};

describe('a roster gap is NAMED with the hour, never averaged (M25-FR-01)', () => {
  it('says which shift, which role and how many short', () => {
    const gaps = rosterGaps({
      shifts: [SUNDAY],
      assignments: [
        { shiftId: 'sh-sun-open', employeeId: 'e-1', role: 'cashier' },
        { shiftId: 'sh-sun-open', employeeId: 'e-2', role: 'cashier' },
      ],
      employees: [employee({}), employee({ employeeId: 'e-2', name: 'Ravi' })],
    });
    expect(gaps).toHaveLength(2);
    const opener = gaps.find((g) => g.role === 'opener');
    expect(opener?.short).toBe(1);
    expect(opener?.assigned).toBe(0);
    // The whole point: this is the sentence a manager can act on from a phone.
    expect(opener?.detail).toBe('2026-08-09 06:00 has NOBODY rostered as opener');

    const cashier = gaps.find((g) => g.role === 'cashier');
    expect(cashier?.detail).toBe('2026-08-09 06:00 is 1 short of cashier');
  });

  it('reports nothing when the shift is genuinely covered', () => {
    const gaps = rosterGaps({
      shifts: [{ ...SUNDAY, requiredRoles: [{ role: 'cashier', count: 1 }] }],
      assignments: [{ shiftId: 'sh-sun-open', employeeId: 'e-1', role: 'cashier' }],
      employees: [employee({})],
    });
    expect(gaps).toEqual([]);
  });

  it('a LEAVER still on the roster is not cover — this is the gap nobody sees until morning', () => {
    const gaps = rosterGaps({
      shifts: [{ ...SUNDAY, requiredRoles: [{ role: 'cashier', count: 1 }] }],
      assignments: [{ shiftId: 'sh-sun-open', employeeId: 'e-gone', role: 'cashier' }],
      employees: [employee({ employeeId: 'e-gone', name: 'Suresh', active: false })],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.detail).toContain('NOBODY');
  });

  it('does not count someone rostered in a DIFFERENT role as cover', () => {
    const gaps = rosterGaps({
      shifts: [{ ...SUNDAY, requiredRoles: [{ role: 'opener', count: 1 }] }],
      assignments: [{ shiftId: 'sh-sun-open', employeeId: 'e-1', role: 'cashier' }],
      employees: [employee({})],
    });
    expect(gaps[0]?.role).toBe('opener');
  });

  it('orders gaps by when they bite', () => {
    const later: ShiftRequirement = {
      ...SUNDAY, shiftId: 'sh-sun-late', startsAt: '2026-08-09T14:00:00+05:30',
      requiredRoles: [{ role: 'cashier', count: 1 }],
    };
    const gaps = rosterGaps({
      shifts: [later, { ...SUNDAY, requiredRoles: [{ role: 'opener', count: 1 }] }],
      assignments: [], employees: [],
    });
    expect(gaps.map((g) => g.shiftId)).toEqual(['sh-sun-open', 'sh-sun-late']);
  });
});

const cert = (over: Partial<Certification>): Certification => ({
  certificationId: 'c-1',
  employeeId: 'e-1',
  kind: 'food_handling',
  issuedOn: '2025-06-01',
  validUntil: '2027-06-01',
  verifiedBy: 'u-manager',
  ...over,
});

describe('a lapsed certification blocks the TASK, never the person (M25-FR-02)', () => {
  const deli = {
    task: 'deli counter',
    requiresCertification: 'food_handling',
    today: '2026-08-04',
  };

  it('allows a verified, in-date certificate', () => {
    const decision = canPerformTask({ employee: employee({}), certifications: [cert({})], ...deli });
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe('allowed');
  });

  it('BLOCKS the task on an expired certificate and says the person is not blocked', () => {
    const decision = canPerformTask({
      employee: employee({}), certifications: [cert({ validUntil: '2026-06-01' })], ...deli,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('certification_expired');
    expect(decision.detail).toContain('this task is blocked, not this person');
    // Without this, the shop works around the system on a busy Saturday.
    expect(decision.stillAllowed).toBe('anything this role does that is not certification-gated');
  });

  it('THE SAME PERSON may still stack shelves', () => {
    const decision = canPerformTask({
      employee: employee({}), task: 'stack shelves',
      certifications: [cert({ validUntil: '2026-06-01' })], today: '2026-08-04',
    });
    expect(decision.allowed).toBe(true);
  });

  it('an unverified certificate is not a certificate', () => {
    const decision = canPerformTask({
      employee: employee({}), certifications: [cert({ verifiedBy: undefined })], ...deli,
    });
    expect(decision.outcome).toBe('certification_missing');
  });

  it('uses the LATEST certificate when one has been renewed', () => {
    const decision = canPerformTask({
      employee: employee({}),
      certifications: [cert({ validUntil: '2026-06-01' }), cert({ certificationId: 'c-2', validUntil: '2027-06-01' })],
      ...deli,
    });
    expect(decision.allowed).toBe(true);
  });

  it('the last valid day still counts', () => {
    const decision = canPerformTask({
      employee: employee({}), certifications: [cert({ validUntil: '2026-08-04' })], ...deli,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses a task the person does not hold the role for, and names what they do hold', () => {
    const decision = canPerformTask({
      employee: employee({}), task: 'authorise a refund', requiresRole: 'supervisor',
      certifications: [], today: '2026-08-04',
    });
    expect(decision.outcome).toBe('not_assigned');
    expect(decision.detail).toContain('this person is assigned cashier');
  });

  it('refuses everything for someone who has left', () => {
    const decision = canPerformTask({
      employee: employee({ active: false }), task: 'stack shelves',
      certifications: [], today: '2026-08-04',
    });
    expect(decision.outcome).toBe('inactive');
  });
});

const item = (over: Partial<ChecklistItem>): ChecklistItem => ({
  itemId: 'i-1', description: 'Sweep the entrance', done: true, blocking: false, ...over,
});

describe('a checklist separates what stops the shop from what does not (M25-FR-03)', () => {
  it('blocks on an outstanding blocking item and names it', () => {
    const result = assessChecklist({
      checklistId: 'cl-1', kind: 'opening', signedBy: 'u-manager',
      items: [item({}), item({ itemId: 'i-2', description: 'Chiller temperature recorded', done: false, blocking: true })],
    });
    expect(result.complete).toBe(false);
    expect(result.outcome).toBe('blocked_item');
    expect(result.detail).toContain('Chiller temperature recorded');
  });

  it('CARRIES non-blocking items into the handover instead of failing the shift', () => {
    const result = assessChecklist({
      checklistId: 'cl-1', kind: 'closing', signedBy: 'u-manager',
      items: [item({}), item({ itemId: 'i-2', description: 'Restock the leaflet stand', done: false })],
    });
    expect(result.complete).toBe(true);
    expect(result.outcome).toBe('incomplete');
    expect(result.outstanding).toHaveLength(1);
    expect(result.blockingOutstanding).toEqual([]);
    expect(result.detail).toContain('carried into the handover');
  });

  it('refuses an unsigned checklist — a list is not a record', () => {
    const result = assessChecklist({ checklistId: 'cl-1', kind: 'opening', items: [item({})] });
    expect(result.outcome).toBe('not_signed');
    expect(result.detail).toContain('is a list, not a record');
  });

  it('passes a fully done, signed checklist', () => {
    const result = assessChecklist({
      checklistId: 'cl-1', kind: 'handover', signedBy: 'u-manager',
      items: [item({}), item({ itemId: 'i-2', blocking: true })],
    });
    expect(result.outcome).toBe('complete');
  });
});

describe('incentives are exact, and a missed target pays NOTHING (M25-FR-04, §29.1)', () => {
  const target = {
    employeeId: 'e-1', metric: 'basket size', targetMinor: 1_000_000,
    payoutMinor: 250_00,
  };

  it('pays nothing at 96% of target — "nearly" is a conversation, not a formula', () => {
    const result = computeIncentive({ ...target, achievedMinor: 960_000 });
    expect(result.met).toBe(false);
    expect(result.payoutMinor).toBe(0);
    expect(result.achievementBps).toBe(9_600);
    expect(result.detail).toContain('"Nearly" is a conversation');
  });

  it('pays exactly the payout when the target is met on the nose', () => {
    const result = computeIncentive({ ...target, achievedMinor: 1_000_000 });
    expect(result.met).toBe(true);
    expect(result.payoutMinor).toBe(25_000);
  });

  it('applies an accelerator in exact integer arithmetic, never a float', () => {
    const result = computeIncentive({ ...target, achievedMinor: 1_300_000, acceleratorBps: 500 });
    // 300,000 excess × 500bps = 15,000 on top of 25,000
    expect(result.payoutMinor).toBe(40_000);
    expect(result.detail).toContain('accelerator');
  });

  it('honours a cap and says the payout was capped', () => {
    const result = computeIncentive({
      ...target, achievedMinor: 5_000_000, acceleratorBps: 500, capMinor: 50_000,
    });
    expect(result.payoutMinor).toBe(50_000);
    expect(result.detail).toContain('capped');
  });

  it('reports not_meaningful rather than dividing by a zero target', () => {
    const result = computeIncentive({ ...target, targetMinor: 0, achievedMinor: 500 });
    expect(result.achievementBps).toBe('not_meaningful');
    expect(result.met).toBe(true);
  });
});

describe('labour cost is REPORTED, never enforced', () => {
  const staff = [
    employee({ employeeId: 'e-1', hourlyRateMinor: 9_000 }),
    employee({ employeeId: 'e-2', hourlyRateMinor: 12_000 }),
  ];

  it('states the ratio and flags it above the guide without blocking anything', () => {
    const view = labourCost({
      branchId: 'b-main',
      hours: [{ employeeId: 'e-1', hours: 8 }, { employeeId: 'e-2', hours: 8 }],
      employees: staff,
      salesMinor: 1_000_000,
      guideBps: 1_200,
    });
    // (72,000 + 96,000) / 1,000,000 = 16.8%
    expect(view.labourCostMinor).toBe(168_000);
    expect(view.labourBps).toBe(1_680);
    expect(view.aboveGuide).toBe(true);
    expect(view.detail).toContain('a queue costs more than a cashier');
  });

  it('exposes NO function that could refuse a roster on cost', () => {
    // Absence as a control: there is nothing here to wire into a "you cannot roster" path.
    const named = Object.keys(workforce);
    expect(named).not.toContain('enforceLabourCost');
    expect(named).not.toContain('rejectShiftOnCost');
    expect(named).not.toContain('capRoster');
  });

  it('says the ratio means nothing on a day with no sales', () => {
    const view = labourCost({
      branchId: 'b-main', hours: [{ employeeId: 'e-1', hours: 8 }], employees: staff, salesMinor: 0,
    });
    expect(view.labourBps).toBe('not_meaningful');
    expect(view.aboveGuide).toBe(false);
  });

  it('is quiet when labour is within the guide', () => {
    const view = labourCost({
      branchId: 'b-main', hours: [{ employeeId: 'e-1', hours: 8 }], employees: staff,
      salesMinor: 1_000_000,
    });
    expect(view.aboveGuide).toBe(false);
    expect(view.detail).toBe('labour is 7.2% of sales');
  });
});

describe('acknowledging v3 is NOT acknowledging v5 (M25-FR-04)', () => {
  const sops = [
    { sopId: 'sop-cash', title: 'Cash handling', version: 5, forRoles: ['cashier'] },
    { sopId: 'sop-deli', title: 'Deli hygiene', version: 2, forRoles: ['deli'] },
  ];

  it('reports a stale acknowledgement as NOT up to date', () => {
    const status = sopStatus({
      employee: employee({}),
      sops,
      acknowledgements: [{ sopId: 'sop-cash', version: 3, employeeId: 'e-1', acknowledgedAt: '2025-04-01T00:00:00Z' }],
    });
    expect(status).toHaveLength(1);
    expect(status[0]?.upToDate).toBe(false);
    expect(status[0]?.acknowledgedVersion).toBe(3);
    expect(status[0]?.detail).toContain('looks like compliance and is not');
  });

  it('accepts a current acknowledgement', () => {
    const status = sopStatus({
      employee: employee({}), sops,
      acknowledgements: [{ sopId: 'sop-cash', version: 5, employeeId: 'e-1', acknowledgedAt: '2026-07-01T00:00:00Z' }],
    });
    expect(status[0]?.upToDate).toBe(true);
  });

  it('shows only the SOPs that apply to that person\'s roles', () => {
    const status = sopStatus({ employee: employee({}), sops, acknowledgements: [] });
    expect(status.map((s) => s.sopId)).toEqual(['sop-cash']);
    expect(status[0]?.detail).toContain('has never acknowledged');
  });

  it('does not credit another employee\'s acknowledgement', () => {
    const status = sopStatus({
      employee: employee({}), sops,
      acknowledgements: [{ sopId: 'sop-cash', version: 5, employeeId: 'e-2', acknowledgedAt: '2026-07-01T00:00:00Z' }],
    });
    expect(status[0]?.upToDate).toBe(false);
  });

  it('lists what is outstanding first', () => {
    const status = sopStatus({
      employee: employee({ roles: ['cashier', 'deli'] }), sops,
      acknowledgements: [{ sopId: 'sop-deli', version: 2, employeeId: 'e-1', acknowledgedAt: '2026-07-01T00:00:00Z' }],
    });
    expect(status.map((s) => s.sopId)).toEqual(['sop-cash', 'sop-deli']);
  });
});
