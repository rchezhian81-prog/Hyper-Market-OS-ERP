import { describe, it, expect } from 'vitest';
import {
  readCheckItems, readPassMark, scoreAttempt, roleCheckReading, qg02Blockers, QG02_FINAL_RELEASES,
  type RoleCheck, type RolePassMark, type CheckAttempt,
} from '../../packages/workforce/src/role-check';

// W3 · OB-675 (QG-02 · roadmap §2.3 "Training success ≥ 90% role assessment (pilot) / ≥ 95% (final)"): the scored check
// per role, its pass mark ("not set" until the owner sets it, never a default number), attempts (append-only; a retake is a
// new attempt), and the gate reading — never a pass from nothing.

const CHECK: RoleCheck = {
  roleId: 'cashier', version: 1, definedBy: 'u-mgr', definedAt: '2026-11-01T05:00:00.000Z',
  items: [
    { itemId: 'q1', kind: 'question', text: 'What do you do when the scanner cannot read a barcode?' },
    { itemId: 'q2', kind: 'question', text: 'When must a manager approve a refund?' },
    { itemId: 't1', kind: 'task', text: 'Ring up a weighed item' },
    { itemId: 't2', kind: 'task', text: 'Close the till drawer count' },
  ],
};
const MARK: RolePassMark = { roleId: 'cashier', passMarkPercent: 75, setBy: 'u-owner', setAt: '2026-11-01T06:00:00.000Z' };
const all = (passed: readonly boolean[]) => CHECK.items.map((i, n) => ({ itemId: i.itemId, passed: passed[n]! }));

const attempt = (employeeId: string, scorePercent: number, passed: boolean, recordedAt: string, attemptId = `${employeeId}-${recordedAt}`): CheckAttempt => ({
  attemptId, roleId: 'cashier', employeeId, checkVersion: 1, results: [], scorePercent, passMarkPercent: 75, passed, recordedBy: 'u-mgr', recordedAt,
});

describe('OB-675 — the check and the pass mark', () => {
  it('a check is a list of questions or observed tasks, each id once', () => {
    expect(readCheckItems(CHECK.items)).toEqual(CHECK.items);
    expect(readCheckItems([])).toMatch(/one or more/);
    expect(readCheckItems([{ itemId: 'a', kind: 'essay', text: 'x' }])).toMatch(/kind/);
    expect(readCheckItems([{ itemId: 'a', kind: 'task', text: 'x' }, { itemId: 'a', kind: 'task', text: 'y' }])).toMatch(/twice/);
  });
  it('a pass mark is a whole percentage 1–100 — nothing else, and no default', () => {
    expect(readPassMark(90)).toBe(90);
    for (const bad of [0, 101, 90.5, '90', null, undefined]) expect(typeof readPassMark(bad)).toBe('string');
  });
});

describe('OB-675 — scoring one attempt', () => {
  it('scores the share of items passed (rounded down) against the pass mark in force', () => {
    expect(scoreAttempt({ check: CHECK, passMark: MARK, employeeId: 'e-1', recordedBy: 'u-mgr', results: all([true, true, true, false]) })).toMatchObject({ scorePercent: 75, passMarkPercent: 75, passed: true });
    expect(scoreAttempt({ check: CHECK, passMark: MARK, employeeId: 'e-1', recordedBy: 'u-mgr', results: all([true, false, true, false]) })).toMatchObject({ scorePercent: 50, passed: false });
  });
  it('refuses with no check, with the pass mark not set, the person recording their own, or results not matching', () => {
    expect(scoreAttempt({ check: undefined, passMark: MARK, employeeId: 'e-1', recordedBy: 'u-mgr', results: [] })).toBe('no_check');
    expect(scoreAttempt({ check: CHECK, passMark: undefined, employeeId: 'e-1', recordedBy: 'u-mgr', results: all([true, true, true, true]) })).toBe('pass_mark_not_set');
    expect(scoreAttempt({ check: CHECK, passMark: MARK, employeeId: 'e-1', recordedBy: 'e-1', results: all([true, true, true, true]) })).toBe('cannot_record_own_attempt');
    expect(scoreAttempt({ check: CHECK, passMark: MARK, employeeId: 'e-1', recordedBy: 'u-mgr', results: all([true, true, true, true]).slice(1) })).toBe('results_do_not_match_the_check');
    expect(scoreAttempt({ check: CHECK, passMark: MARK, employeeId: 'e-1', recordedBy: 'u-mgr', results: [...all([true, true, true, true]), { itemId: 'q1', passed: true }] })).toBe('results_do_not_match_the_check');
  });
});

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ employeeId: `e-${String(i + 1).padStart(2, '0')}`, name: `Person ${i + 1}` }));
const read = (input: { checks?: RoleCheck[]; marks?: RolePassMark[]; attempts?: CheckAttempt[]; staff?: number; curriculumDone?: boolean }) => roleCheckReading({
  roles: ['cashier'], checks: input.checks ?? [CHECK], passMarks: input.marks ?? [MARK], attempts: input.attempts ?? [],
  people: () => people(input.staff ?? 10), curriculumDone: () => input.curriculumDone ?? true,
});

describe('OB-675 — the QG-02 reading per role', () => {
  it('never passes with no check, the pass mark not set, or nobody trained', () => {
    const noCheck = read({ checks: [] })[0]!;
    expect([noCheck.pilot, noCheck.final]).toEqual(['not_passed', 'not_passed']);
    expect(noCheck.why.join(' ')).toMatch(/no check has been set/);
    const noMark = read({ marks: [] })[0]!;
    expect(noMark.passMarkPercent).toBeNull();
    expect(noMark.why.join(' ')).toMatch(/pass mark is not set/);
    const nobody = read({ curriculumDone: false })[0]!;
    expect(nobody.trained).toEqual([]);
    expect(nobody.passedPercent).toBeNull();
    expect(nobody.why.join(' ')).toMatch(/nobody is trained/);
    expect(qg02Blockers([nobody])).toEqual([expect.objectContaining({ gate: 'QG-02', ref: 'role-check:cashier' })]);
    expect(qg02Blockers([nobody])[0]!.releases).toBeUndefined(); // blocks every release
    expect(qg02Blockers([])).toHaveLength(1);
  });

  it('9 of 10 trained passed → pilot passed (90%), final not (95%): blocks only the releases after the pilot', () => {
    const attempts = people(10).map((p, i) => attempt(p.employeeId, i < 9 ? 100 : 50, i < 9, '2026-11-01T07:00:00.000Z'));
    const r = read({ attempts })[0]!;
    expect([r.passedCount, r.passedPercent, r.pilot, r.final]).toEqual([9, 90, 'passed', 'not_passed']);
    expect(r.why.join(' ')).toMatch(/9 of 10 trained passed \(90%\) — below the final 95%; not passed: Person 10 \(e-10, 50%\)/);
    const b = qg02Blockers([r]);
    expect(b).toHaveLength(1);
    expect(b[0]!.releases).toEqual(QG02_FINAL_RELEASES);
  });

  it('a trained person who has not sat it counts as not passed; 8 of 10 is below the pilot', () => {
    const attempts = people(8).map((p) => attempt(p.employeeId, 100, true, '2026-11-01T07:00:00.000Z'));
    const r = read({ attempts })[0]!;
    expect([r.passedCount, r.trained.length, r.pilot]).toEqual([8, 10, 'not_passed']);
    expect(r.why.join(' ')).toMatch(/below the pilot 90%.*e-09, not yet sat/);
  });

  it('a retake is a new attempt and the latest counts; 20 of 20 passes at both levels — no blocker', () => {
    const first = people(20).map((p) => attempt(p.employeeId, p.employeeId === 'e-03' ? 25 : 100, p.employeeId !== 'e-03', '2026-11-01T07:00:00.000Z'));
    const retake = attempt('e-03', 100, true, '2026-11-01T09:00:00.000Z', 'e-03-retake');
    const r = read({ attempts: [...first, retake], staff: 20 })[0]!;
    expect([r.passedCount, r.pilot, r.final, r.why]).toEqual([20, 'passed', 'passed', []]);
    expect(r.trained.find((t) => t.employeeId === 'e-03')!.latest).toMatchObject({ scorePercent: 100, passed: true });
    expect(qg02Blockers([r])).toEqual([]);
  });

  it('only the trained count: someone not trained and not sat is outside the share', () => {
    const r = roleCheckReading({
      roles: ['cashier'], checks: [CHECK], passMarks: [MARK], attempts: [attempt('e-01', 100, true, '2026-11-01T07:00:00.000Z')],
      people: () => people(3), curriculumDone: (_r, e) => e === 'e-01',
    })[0]!;
    expect(r.trained.map((t) => t.employeeId)).toEqual(['e-01']);
    expect(r.final).toBe('passed');
  });
});
