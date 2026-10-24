import { describe, it, expect } from 'vitest';
import { accessMatch } from '../../packages/workforce/src/access-match';
import { trainingRows, checkCompletion, checkCompetency, currentCurricula, readCurriculumItems } from '../../packages/workforce/src/training';
import { rosteredMinutes, salesPerLabourHour, productivityReport } from '../../packages/workforce/src/productivity';
import { adoptionGate, proposedCurricula, currentChampions } from '../../packages/workforce/src/adoption-gate';
import { renderLetter, unknownPlaceholders, hourlyRateWords } from '../../packages/workforce/src/appointment-letter';
import { BUILT_IN_SOPS, OWNER_GUIDE_PARTS } from '../../packages/workforce/src/sop-library.generated';
import type { Employee } from '../../packages/workforce/src/workforce';

// M25-FR-01/03/04 · QG-09 · D11-FR-04 · OB-317/320/323 — the pure engines behind the workforce enablement routes.

const emp = (employeeId: string, roles: string[], active = true, branchId = 'br-1'): Employee => ({ employeeId, name: employeeId.toUpperCase(), branchId, roles, active });

describe('access matches assignment (M25-FR-01)', () => {
  it('names each difference, worst first, and compares only the staff roles', () => {
    const r = accessMatch({
      employees: [emp('a', ['cashier']), emp('b', ['store_manager']), emp('gone', ['cashier'], false), emp('d', ['deli'])],
      grants: [
        { userId: 'a', roleId: 'cashier', branchScope: ['br-1'] }, { userId: 'a', roleId: 'store_manager', branchScope: ['br-1'] },
        { userId: 'b', roleId: 'store_manager', branchScope: ['br-1', 'br-2'] }, { userId: 'gone', roleId: 'cashier', branchScope: ['br-1'] },
        { userId: 'x', roleId: 'accountant', branchScope: 'all' }, { userId: 'o', roleId: 'owner', branchScope: 'all' },
      ],
    });
    expect(r.mismatches.map((m) => [m.severity, m.kind, m.userId, m.roleId])).toEqual([
      ['critical', 'leaver_still_has_access', 'gone', 'cashier'],
      ['warning', 'grant_without_assignment', 'a', 'store_manager'],
      ['warning', 'branch_outside_assignment', 'b', 'store_manager'],
      ['warning', 'not_on_staff_list', 'x', 'accountant'],
    ]);
    expect([r.peopleCompared, r.matching, r.notCompared]).toEqual([5, 1, [{ roleId: 'owner', holders: 1 }]]);
    // A duty that is not a sign-in role ("deli") can never be missing one.
    expect(r.mismatches.some((m) => m.userId === 'd')).toBe(false);
    expect(r.mismatches[0]!.detail.ta).toMatch(/அணுகலை நீக்கவும்/);
  });
});

describe('training and competency (M25-FR-03 · D11-FR-04)', () => {
  const a = { assignmentId: 'T1', employeeId: 'asha', itemId: 'SOP-04', title: 'PIN', assignedBy: 'mgr', assignedAt: '2030-01-01T00:00:00Z', dueOn: '2030-01-10' };
  it('the trainee never records their own; competency needs completion and a second person', () => {
    expect(checkCompletion(a, 'asha')).toBe('trainee_cannot_record_own_training');
    expect(checkCompletion(a, 'mgr')).toBeNull();
    expect(checkCompetency(a, null, 'mgr2')).toBe('not_completed_yet');
    const done = { assignmentId: 'T1', recordedBy: 'mgr', completedAt: '2030-01-02T00:00:00Z' };
    expect(checkCompetency(a, done, 'mgr')).toBe('second_person_required');
    expect(checkCompetency(a, done, 'asha')).toBe('second_person_required');
    expect(checkCompetency(a, done, 'mgr2')).toBeNull();
  });
  it('states come from the facts and today: overdue, completed, not yet, competent (the latest sign-off wins)', () => {
    const rows = (signOffs: { outcome: 'competent' | 'not_yet' }[], completed: boolean, today: string) => trainingRows({
      assignments: [a], today,
      completions: completed ? [{ assignmentId: 'T1', recordedBy: 'mgr', completedAt: 'x' }] : [],
      signOffs: signOffs.map((s, i) => ({ assignmentId: 'T1', signedBy: 'mgr2', signedAt: `t${i}`, outcome: s.outcome })),
    })[0]!.state;
    expect(rows([], false, '2030-01-05')).toBe('assigned');
    expect(rows([], false, '2030-01-11')).toBe('overdue');
    expect(rows([], true, '2030-01-11')).toBe('completed');
    expect(rows([{ outcome: 'not_yet' }], true, '2030-01-11')).toBe('not_yet_competent');
    expect(rows([{ outcome: 'not_yet' }, { outcome: 'competent' }], true, '2030-01-11')).toBe('competent');
  });
  it('a curriculum list is read whole; the latest approved version per role is the one in force', () => {
    expect(readCurriculumItems([])).toMatch(/one or more/);
    expect(readCurriculumItems([{ itemId: 'a', title: 'A', source: 'SOP-01' }, { itemId: 'a', title: 'A', source: 'SOP-01' }])).toMatch(/twice/);
    const c = currentCurricula([
      { roleId: 'cashier', version: 1, items: [], approvedBy: 'o', approvedAt: '1' }, { roleId: 'cashier', version: 2, items: [], approvedBy: 'o', approvedAt: '2' },
    ]);
    expect(c.get('cashier')!.version).toBe(2);
  });
});

describe('the role curriculum is proposed from the shop\'s own sheets (OB-320)', () => {
  it('one list per role, from each sheet\'s "For:" line, and the owner guide for the owner', () => {
    const p = proposedCurricula(BUILT_IN_SOPS, OWNER_GUIDE_PARTS);
    expect([...p.keys()]).toEqual(['cashier', 'owner', 'store_manager']);
    expect(p.get('cashier')!.map((i) => i.source)).toEqual(['SOP-01', 'SOP-02', 'SOP-04']);
    expect(p.get('owner')!.slice(0, 2).map((i) => i.source)).toEqual(['SOP-03', 'SOP-04']);
    expect(p.get('owner')!.filter((i) => i.source.startsWith('owner-guide:')).length).toBe(OWNER_GUIDE_PARTS.length);
    expect(OWNER_GUIDE_PARTS[0]).toEqual({ part: 12, title: 'Give the store system a fixed share of memory (OB-247)' });
  });
});

describe('the QG-09 adoption gate', () => {
  const base = {
    roles: ['cashier'], training: [], sops: [{ sopId: 'S1', title: 'S1', version: 2, forRoles: ['cashier'] }], acknowledgements: [],
    departments: [{ departmentId: 'D1', name: 'Grocery' }], champions: currentChampions([{ departmentId: 'D1', employeeId: 'asha', namedBy: 'o', at: 't' }]),
    activeStaff: [emp('asha', ['cashier'])], peopleOf: () => [emp('asha', ['cashier'])],
  };
  it('NOT_PROVEN until the owner approves the role\'s list; HOLD naming who and what; GO when nothing is missing', () => {
    expect(adoptionGate({ ...base, curricula: new Map() }).verdict).toBe('NOT_PROVEN');
    const curricula = new Map([['cashier', { roleId: 'cashier', version: 1, items: [{ itemId: 'S1', title: 'S1', source: 'SOP-01' }], approvedBy: 'o', approvedAt: 't' }]]);
    const hold = adoptionGate({ ...base, curricula, acknowledgements: [{ sopId: 'S1', version: 1, employeeId: 'asha', acknowledgedAt: 't' }] });
    expect([hold.verdict, hold.why]).toEqual(['HOLD', ['cashier: ASHA (asha) not signed competent on S1; has not acknowledged S1.']]);
    const row = { assignmentId: 'T', employeeId: 'asha', itemId: 'S1', title: 'S1', assignedBy: 'm', assignedAt: 't', state: 'competent' as const, completion: null, competency: null };
    const go = adoptionGate({ ...base, curricula, training: [row], acknowledgements: [{ sopId: 'S1', version: 2, employeeId: 'asha', acknowledgedAt: 't' }] });
    expect([go.verdict, go.why]).toEqual(['GO', []]);
    // Floor support: a department with no champion, or a champion who has left, holds the gate.
    const noChamp = adoptionGate({ ...base, curricula, training: [row], acknowledgements: [{ sopId: 'S1', version: 2, employeeId: 'asha', acknowledgedAt: 't' }], champions: new Map() });
    expect([noChamp.verdict, noChamp.why]).toEqual(['HOLD', ['Floor support: Grocery has no floor champion (not set).']]);
    const left = adoptionGate({ ...base, curricula, training: [row], acknowledgements: [{ sopId: 'S1', version: 2, employeeId: 'asha', acknowledgedAt: 't' }], activeStaff: [] });
    expect(left.floorSupport.departments[0]!.state).toBe('champion_left');
    expect(adoptionGate({ ...base, roles: [], curricula: new Map() }).why[0]).toMatch(/No role is judged yet/);
  });
});

describe('productivity (OB-317)', () => {
  it('rostered minutes of active people inside the window; paise per hour rounded once; departments never get a made-up rate', () => {
    const m = rosteredMinutes({
      shifts: [{ shiftId: 's', branchId: 'b', startsAt: '2030-01-01T22:00:00Z', endsAt: '2030-01-02T06:00:00Z', requiredRoles: [] }],
      assignments: [{ shiftId: 's', employeeId: 'a', role: 'x' }, { shiftId: 's', employeeId: 'gone', role: 'x' }],
      employees: [emp('a', []), emp('gone', [], false)], from: '2030-01-02T00:00:00Z', to: '2030-01-03T00:00:00Z',
    });
    expect([m.totalMinutes, m.people]).toEqual([360, 1]);
    expect(salesPerLabourHour(1_000, 7)).toEqual({ kind: 'per_hour', minorPerHour: 8_571 });
    expect(salesPerLabourHour(1_000, 0).kind).toBe('not_meaningful');
    const r = productivityReport({ from: 'f', to: 't', labour: { totalMinutes: 60, people: 1 }, totalSalesMinor: 500, departments: [{ departmentId: 'D', name: 'D', salesMinor: 400 }], unownedSalesMinor: 100, departmentMinutes: new Map([['D', 30]]) });
    expect(r.departments[0]!.rate).toEqual({ kind: 'per_hour', minorPerHour: 800 });
    expect(r.hoursAttributed).toBe(true);
  });
});

describe('appointment letters (C17 · OB-323)', () => {
  it('renders the owner\'s words from the record, refusing a field the record lacks, and an unknown placeholder', () => {
    const w = { bodyEn: 'Dear {{employeeName}}, from {{effectiveFrom}} at {{hourlyRate}}.', bodyTa: '{{employeeName}} — {{effectiveFrom}}' };
    expect(renderLetter(w, { employeeName: 'Asha', effectiveFrom: '2030-01-01', hourlyRate: hourlyRateWords(12_550) })).toEqual({ ok: true, textEn: 'Dear Asha, from 2030-01-01 at ₹125.50 per hour.', textTa: 'Asha — 2030-01-01' });
    expect(renderLetter(w, { employeeName: 'Asha', effectiveFrom: '2030-01-01' })).toEqual({ ok: false, missing: ['hourlyRate'] });
    expect(unknownPlaceholders('{{employeeName}} {{salary}} {{ salary }}')).toEqual(['salary']);
  });
});
