import { describe, it, expect } from 'vitest';
import {
  ROSTERING_COPY, COPY_KEYS, createRosteringSession,
  type RosteringPorts, type RosteringData, type AssignResult,
} from '../../apps/web-erp/src/rostering-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import type { Employee, ShiftRequirement, ShiftAssignment, RosterGap } from '../../packages/workforce/src/workforce';

// The manager rostering screen (M25-FR-01 · API-11 · P-03 · P-04 · P-08). It shows every roster GAP — a
// shift short of a required role — worst first (a role with NOBODY at all outranks a partial shortfall),
// each reading as attention (never a bare colour); the one action from here is to ASSIGN an eligible person
// to the short shift (a human write in the manager's name). It refuses locally before any POST without the
// manage permission or when the person is not eligible (inactive / lacks the role / already on the shift).

const emp = (over: Partial<Employee> & Pick<Employee, 'employeeId'>): Employee => ({
  name: 'Staff', branchId: 'br-1', roles: ['cashier'], active: true, ...over,
});
const gap = (over: Partial<RosterGap> & Pick<RosterGap, 'shiftId' | 'role'>): RosterGap => ({
  startsAt: '2026-09-27T06:00:00.000Z', needed: 1, assigned: 0, short: 1,
  detail: '2026-09-27 06:00 has NOBODY rostered as cashier', ...over,
});

const data = (over: Partial<RosteringData> = {}): RosteringData => ({
  gaps: [], employees: [], shifts: [] as readonly ShiftRequirement[], assignments: [] as readonly ShiftAssignment[], ...over,
});

const session = (
  d: RosteringData,
  ports: Partial<RosteringPorts> = {},
  userId: string | null = 'u-manager',
) =>
  createRosteringSession({ userId }, {
    worklist: () => d,
    mayRead: () => true,
    mayManage: () => true,
    assignPort: () => ({ post: async () => 'assigned' as AssignResult }),
    ...ports,
  });

describe('the rostering copy is complete in both languages', () => {
  it('has no gap in either language across the whole vocabulary', () => {
    const gaps = bilingualGaps(ROSTERING_COPY, COPY_KEYS);
    expect(gaps.en, `English missing: ${gaps.en.join(', ')}`).toEqual([]);
    expect(gaps.ta, `Tamil missing: ${gaps.ta.join(', ')}`).toEqual([]);
  });

  it('tripwire — the detector fires on a key genuinely absent', () => {
    const holey = { en: { ...ROSTERING_COPY.en }, ta: { ...ROSTERING_COPY.ta, scrReady: '' } };
    expect(bilingualGaps(holey, COPY_KEYS).ta).toContain('scrReady');
  });
});

describe('the view lists roster gaps, worst first, each as attention (never colour alone)', () => {
  it('orders an unstaffed role (nobody) before a partial shortfall, then by size', () => {
    const view = session(data({
      gaps: [
        gap({ shiftId: 'S-2', role: 'picker', needed: 3, assigned: 1, short: 2, detail: 'S-2 is 2 short of picker' }),
        gap({ shiftId: 'S-1', role: 'cashier', needed: 1, assigned: 0, short: 1 }),
      ],
    })).view('en');
    expect(view.gapCount).toBe(2);
    // Nobody-at-all (assigned 0) ranks first, whatever its shortfall size.
    expect(view.gaps[0]?.shiftId).toBe('S-1');
    expect(view.gaps[0]?.assigned).toBe(0);
    expect(view.gaps[1]?.shiftId).toBe('S-2');
  });

  it('an unstaffed role is an error tone with an icon and a word; a partial shortfall is a warning', () => {
    const view = session(data({
      gaps: [
        gap({ shiftId: 'S-1', role: 'cashier', assigned: 0 }),
        gap({ shiftId: 'S-2', role: 'picker', needed: 2, assigned: 1, short: 1, detail: 'S-2 is 1 short of picker' }),
      ],
    })).view('en');
    const nobody = view.gaps.find((g) => g.shiftId === 'S-1')!;
    const short = view.gaps.find((g) => g.shiftId === 'S-2')!;
    expect(nobody.status.tone).toBe('error');
    expect(nobody.status.icon).toBeTruthy();
    expect(nobody.severityWord).toBe(ROSTERING_COPY.en.nobodyWord);
    expect(nobody.needsAttention).toBe(true);
    expect(short.status.tone).toBe('degraded');
    expect(short.severityWord).toBe(ROSTERING_COPY.en.shortWord);
  });

  it('offers, per gap, the ACTIVE staff who hold the role and are not already on that shift', () => {
    const view = session(data({
      gaps: [gap({ shiftId: 'S-1', role: 'cashier' })],
      employees: [
        emp({ employeeId: 'e-active', name: 'Asha', roles: ['cashier'] }),
        emp({ employeeId: 'e-leaver', roles: ['cashier'], active: false }),      // a leaver is not cover
        emp({ employeeId: 'e-wrongrole', roles: ['picker'] }),                    // lacks the role
        emp({ employeeId: 'e-onshift', roles: ['cashier'] }),                     // already on the shift
      ],
      assignments: [{ shiftId: 'S-1', employeeId: 'e-onshift', role: 'cashier' }],
    })).view('en');
    const g = view.gaps[0]!;
    expect(g.eligible.map((e) => e.employeeId)).toEqual(['e-active']);
    expect(g.eligible[0]?.label).toBe('Asha'); // name when known
  });

  it('falls back to the employee id as the label when the name is blank', () => {
    const view = session(data({
      gaps: [gap({ shiftId: 'S-1', role: 'cashier' })],
      employees: [emp({ employeeId: 'e-77', name: '  ', roles: ['cashier'] })],
    })).view('en');
    expect(view.gaps[0]?.eligible[0]?.label).toBe('e-77');
  });

  it('an empty roster with no gaps reads as all-staffed, not as unknown', () => {
    const view = session(data({ gaps: [] })).view('en');
    expect(view.gapCount).toBe(0);
    expect(view.screenState.label).toBe(ROSTERING_COPY.en.scrEmpty);
  });
});

describe('permission gating (P-04 least privilege)', () => {
  it('a user without read permission sees a not-permitted state and no gaps', () => {
    const view = session(data({ gaps: [gap({ shiftId: 'S-1', role: 'cashier' })] }), { mayRead: () => false }).view('en');
    expect(view.gapCount).toBe(0);
    expect(view.screenState.label).toBe(ROSTERING_COPY.en.stateNotPermitted);
  });

  it('a reader without manage permission sees the gaps but is not offered the assign action', () => {
    const view = session(data({ gaps: [gap({ shiftId: 'S-1', role: 'cashier' })] }), { mayManage: () => false }).view('en');
    expect(view.gapCount).toBe(1);
    expect(view.mayManage).toBe(false);
  });

  it('flags when the box was not told who is at the screen', () => {
    expect(session(data(), {}, null).view('en').nobodyNamed).toBe(true);
    expect(session(data(), {}, 'u-manager').view('en').nobodyNamed).toBe(false);
  });
});

describe('assigning is a human write, gated and eligibility-checked before any POST (§28/P-04)', () => {
  const filled = () => data({
    gaps: [gap({ shiftId: 'S-1', role: 'cashier' })],
    employees: [emp({ employeeId: 'e-active', roles: ['cashier'] }), emp({ employeeId: 'e-leaver', roles: ['cashier'], active: false })],
  });

  it('an eligible assignment POSTs and reports assigned', async () => {
    const calls: { shiftId: string; employeeId: string; role: string }[] = [];
    const s = session(filled(), { assignPort: () => ({ post: async (i) => { calls.push(i); return 'assigned'; } }) });
    const out = await s.assign('S-1', 'e-active', 'cashier');
    expect(out).toBe('assigned');
    expect(calls).toEqual([{ shiftId: 'S-1', employeeId: 'e-active', role: 'cashier' }]);
  });

  it('refuses without the manage permission, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { mayManage: () => false, assignPort: () => ({ post: async () => { posted = true; return 'assigned'; } }) });
    expect(await s.assign('S-1', 'e-active', 'cashier')).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses an ineligible person (a leaver), before any POST', async () => {
    let posted = false;
    const s = session(filled(), { assignPort: () => ({ post: async () => { posted = true; return 'assigned'; } }) });
    expect(await s.assign('S-1', 'e-leaver', 'cashier')).toBe('refused');
    expect(posted).toBe(false);
  });

  it('refuses an assignment to a shift/role that is not actually short, before any POST', async () => {
    let posted = false;
    const s = session(filled(), { assignPort: () => ({ post: async () => { posted = true; return 'assigned'; } }) });
    expect(await s.assign('S-9', 'e-active', 'cashier')).toBe('refused');
    expect(posted).toBe(false);
  });

  it('surfaces a lost link honestly (P-08), not a false assigned', async () => {
    const s = session(filled(), { assignPort: () => ({ post: async () => 'lost_link' as AssignResult }) });
    const out = await s.assign('S-1', 'e-active', 'cashier');
    expect(out).toBe('lost_link');
    expect(s.presentAssignResult('en', out).needsAttention).toBe(true);
  });

  it('presents each outcome as one glanceable status', () => {
    const s = session(filled());
    expect(s.presentAssignResult('en', 'assigned').tone).toBe('ok');
    expect(s.presentAssignResult('en', 'refused').tone).toBe('error');
    expect(s.presentAssignResult('en', 'lost_link').tone).toBe('degraded');
  });
});
