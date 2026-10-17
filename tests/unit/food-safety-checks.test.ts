import { describe, it, expect } from 'vitest';
import {
  assessCheckRecord, definitionProblem, foodSafetyStatus, isSlotOf, slotsOf, checkInForceAt, versionWindows,
  type FoodSafetyCheck, type FoodSafetyCheckRecord,
} from '../../packages/facilities/src/food-safety';

// D-6 (roadmap v2.1 addendum, ratified R2): "Scheduled temperature/equipment checks and cleaning/receiving checklists with
// corrective-action capture and a tamper-evident trail; a missed check surfaces". The engine half (the trail is the
// route's — sealed into the audit chain — and is proved in tests/integration/d6-food-safety-checks-are-scheduled-corrected-and-sealed.test.ts).

const chiller: FoodSafetyCheck = {
  checkId: 'chiller-1', branchId: 'BR1', title: 'Dairy chiller temperature', kind: 'temperature',
  everyMinutes: 240, startsAt: '2026-10-16T02:00:00.000Z', graceMinutes: 30, minTenthsC: 0, maxTenthsC: 50,
  items: [], assignedRole: 'store_manager', escalatesTo: 'u-mgr', active: true,
};
const deliClean: FoodSafetyCheck = {
  checkId: 'deli-clean', branchId: 'BR1', title: 'Deli close-down clean', kind: 'cleaning',
  everyMinutes: 1_440, startsAt: '2026-10-15T15:30:00.000Z', graceMinutes: 60,
  items: [{ itemId: 'slicer', label: 'Slicer stripped and sanitised' }, { itemId: 'boards', label: 'Boards colour-coded and washed' }],
  assignedRole: 'store_manager', escalatesTo: 'u-mgr', active: true,
};
const slicer: FoodSafetyCheck = {
  checkId: 'slicer-guard', branchId: 'BR1', title: 'Slicer guard and cut-out', kind: 'equipment',
  everyMinutes: 1_440, startsAt: '2026-10-16T03:00:00.000Z', graceMinutes: 60,
  items: [{ itemId: 'guard', label: 'Guard in place' }, { itemId: 'cutout', label: 'Cut-out stops the blade' }],
  assignedRole: 'store_manager', escalatesTo: 'u-mgr', active: true,
};
const dock: FoodSafetyCheck = {
  checkId: 'dock-chilled', branchId: 'BR1', title: 'Chilled delivery at the dock', kind: 'receiving', graceMinutes: 0,
  minTenthsC: 0, maxTenthsC: 50,
  items: [{ itemId: 'pack', label: 'Packaging intact' }, { itemId: 'dates', label: 'Use-by dates acceptable' }],
  assignedRole: 'store_manager', escalatesTo: 'u-mgr', active: true,
};

const draft = (over: Partial<FoodSafetyCheckRecord> = {}) => ({
  recordId: 'r1', checkId: 'chiller-1', slotDueAt: '2026-10-16T06:00:00.000Z', performedBy: 'u-staff', performedAt: '2026-10-16T06:05:00.000Z', ...over,
});

describe('D-6 a check is defined with its schedule, limits or items', () => {
  it('accepts the four kinds and names what a malformed one lacks', () => {
    for (const c of [chiller, deliClean, slicer, dock]) expect(definitionProblem(c)).toBeNull();
    expect(definitionProblem({ ...chiller, minTenthsC: undefined })).toMatch(/limits/);
    expect(definitionProblem({ ...chiller, everyMinutes: undefined })).toMatch(/scheduled/);
    expect(definitionProblem({ ...deliClean, items: [] })).toMatch(/at least one item/);
    expect(definitionProblem({ ...dock, everyMinutes: 60, startsAt: chiller.startsAt })).toMatch(/per delivery/);
    expect(definitionProblem({ ...deliClean, items: [{ itemId: 'a', label: 'x' }, { itemId: 'a', label: 'y' }] })).toMatch(/own itemId/);
    expect(definitionProblem({ ...chiller, kind: 'pest' as unknown as FoodSafetyCheck['kind'] })).toMatch(/kind/);
  });

  it('derives its slots from the schedule — nothing stored, so a slot cannot be lost', () => {
    expect(slotsOf(chiller, '2026-10-16T00:00:00.000Z', '2026-10-16T12:00:00.000Z')).toEqual([
      '2026-10-16T02:00:00.000Z', '2026-10-16T06:00:00.000Z', '2026-10-16T10:00:00.000Z',
    ]);
    expect(isSlotOf(chiller, '2026-10-16T06:00:00.000Z')).toBe(true);
    expect(isSlotOf(chiller, '2026-10-16T06:30:00.000Z')).toBe(false);
    expect(slotsOf(dock, '2026-10-16T00:00:00.000Z', '2026-10-17T00:00:00.000Z')).toEqual([]);
  });
});

describe('D-6 corrective-action capture', () => {
  it('a reading inside the limits passes; outside them it FAILS and needs its corrective action, or nothing is recorded', () => {
    expect(assessCheckRecord(chiller, { ...draft(), readingTenthsC: 38 })).toMatchObject({ ok: true, record: { outcome: 'pass', failures: [], late: false } });
    expect(assessCheckRecord(chiller, { ...draft(), readingTenthsC: 72 })).toMatchObject({ ok: false, refusal: 'corrective_action_required' });
    expect(assessCheckRecord(chiller, { ...draft(), readingTenthsC: 72, correctiveAction: '   ' })).toMatchObject({ ok: false, refusal: 'corrective_action_required' });
    const fixed = assessCheckRecord(chiller, { ...draft(), readingTenthsC: 72, correctiveAction: ' Moved the milk to chiller 2; engineer called ' });
    expect(fixed).toMatchObject({ ok: true, record: { outcome: 'fail', failures: ['reading 7.2°C is outside 0.0–5.0°C'], correctiveAction: 'Moved the milk to chiller 2; engineer called' } });
    expect(assessCheckRecord(chiller, draft())).toMatchObject({ ok: false, refusal: 'reading_required' });
  });

  it('a checklist is done only when every item is ticked; a failed item needs its corrective action', () => {
    const base = { ...draft({ checkId: 'deli-clean', slotDueAt: '2026-10-16T15:30:00.000Z', performedAt: '2026-10-16T15:40:00.000Z' }) };
    expect(assessCheckRecord(deliClean, { ...base, itemResults: { slicer: 'pass' } })).toMatchObject({ ok: false, refusal: 'items_incomplete' });
    expect(assessCheckRecord(deliClean, { ...base, itemResults: { slicer: 'pass', boards: 'fail' } })).toMatchObject({ ok: false, refusal: 'corrective_action_required' });
    expect(assessCheckRecord(deliClean, { ...base, itemResults: { slicer: 'pass', boards: 'fail' }, correctiveAction: 'Re-washed the boards' }))
      .toMatchObject({ ok: true, record: { outcome: 'fail', failures: ['Boards colour-coded and washed: failed'] } });
    expect(assessCheckRecord(slicer, { ...draft({ checkId: 'slicer-guard', slotDueAt: '2026-10-16T03:00:00.000Z', performedAt: '2026-10-16T03:10:00.000Z' }), itemResults: { guard: 'pass', cutout: 'pass' } }))
      .toMatchObject({ ok: true, record: { outcome: 'pass' } });
  });

  it('a receiving checklist names its delivery, and its reading is judged against the limits too', () => {
    const at = { recordId: 'r-dock', checkId: 'dock-chilled', performedBy: 'u-staff', performedAt: '2026-10-16T07:00:00.000Z', itemResults: { pack: 'pass' as const, dates: 'pass' as const } };
    expect(assessCheckRecord(dock, at)).toMatchObject({ ok: false, refusal: 'needs_a_delivery' });
    expect(assessCheckRecord(dock, { ...at, subjectRef: 'GRN-17', readingTenthsC: 81 })).toMatchObject({ ok: false, refusal: 'corrective_action_required' });
    expect(assessCheckRecord(dock, { ...at, subjectRef: 'GRN-17', readingTenthsC: 81, correctiveAction: 'Rejected the chilled lines to the supplier' }))
      .toMatchObject({ ok: true, record: { outcome: 'fail', late: false } });
  });

  it('a record must answer a real slot that is open; a late one is kept, marked late', () => {
    expect(assessCheckRecord(chiller, { ...draft({ slotDueAt: '2026-10-16T06:30:00.000Z' }), readingTenthsC: 30 })).toMatchObject({ ok: false, refusal: 'not_a_slot' });
    expect(assessCheckRecord(chiller, { ...draft({ performedAt: '2026-10-16T05:00:00.000Z' }), readingTenthsC: 30 })).toMatchObject({ ok: false, refusal: 'slot_not_yet_open' });
    expect(assessCheckRecord(chiller, { ...draft({ performedAt: '2026-10-16T07:00:00.000Z' }), readingTenthsC: 30 })).toMatchObject({ ok: true, record: { late: true } });
  });
});

describe('D-6 a missed check surfaces', () => {
  it('reads every slot: done, failed with its action, done late, due — and MISSED, escalated by name', () => {
    const rec = (recordId: string, slotDueAt: string, performedAt: string, readingTenthsC: number, correctiveAction?: string) => {
      const a = assessCheckRecord(chiller, { recordId, checkId: 'chiller-1', slotDueAt, performedBy: 'u-staff', performedAt, readingTenthsC, ...(correctiveAction === undefined ? {} : { correctiveAction }) });
      if (!a.ok) throw new Error(a.detail);
      return a.record;
    };
    const records = [
      rec('a', '2026-10-16T02:00:00.000Z', '2026-10-16T02:10:00.000Z', 31),
      rec('b', '2026-10-16T06:00:00.000Z', '2026-10-16T06:05:00.000Z', 66, 'Door seal replaced; stock moved'),
      // 10:00 nobody did; 14:00 done late at 15:00
      rec('d', '2026-10-16T14:00:00.000Z', '2026-10-16T15:00:00.000Z', 40),
    ];
    const s = foodSafetyStatus({ checks: [chiller, dock], records, from: '2026-10-16T00:00:00.000Z', asAt: '2026-10-16T17:45:00.000Z' });
    expect(s.slots.map((x) => [x.slotDueAt.slice(11, 16), x.state])).toEqual([
      ['02:00', 'done'], ['06:00', 'done_failed'], ['10:00', 'missed'], ['14:00', 'done_late'], ['18:00', 'due'],
    ]);
    expect(s.missed).toHaveLength(1);
    expect(s.missed[0]).toMatchObject({ checkId: 'chiller-1', escalateTo: 'u-mgr' });
    expect(s.missed[0]!.detail).toContain('MISSED');
    expect(s.failed[0]).toMatchObject({ correctiveAction: 'Door seal replaced; stock moved' });
    expect(s.detail).toBe('1 food-safety check(s) MISSED since 2026-10-16T00:00:00.000Z — each escalated to the person named');
    // An inactive check raises nothing; a receiving checklist is never "missed".
    expect(foodSafetyStatus({ checks: [{ ...chiller, active: false }, dock], records: [], from: '2026-10-16T00:00:00.000Z', asAt: '2026-10-16T17:45:00.000Z' }).missed).toEqual([]);
  });
});

describe('NEW-8: a redefinition is a version from its own moment — the slots already due stay', () => {
  const v1: FoodSafetyCheck = { ...chiller, startsAt: '2026-10-16T02:00:00.000Z', everyMinutes: 240, effectiveFrom: '2026-10-16T01:00:00.000Z' };
  it('a later start does not erase the slots missed before it; the new schedule runs from the redefinition', () => {
    const v2: FoodSafetyCheck = { ...v1, startsAt: '2026-10-16T20:00:00.000Z', effectiveFrom: '2026-10-16T15:00:00.000Z' };
    const s = foodSafetyStatus({ checks: [v1, v2], records: [], from: '2026-10-16T00:00:00.000Z', asAt: '2026-10-16T21:00:00.000Z' });
    expect(s.slots.map((x) => [x.slotDueAt.slice(11, 16), x.state])).toEqual([['02:00', 'missed'], ['06:00', 'missed'], ['10:00', 'missed'], ['14:00', 'missed'], ['20:00', 'missed']]);
  });
  it('set inactive stops the future, never the past', () => {
    const off: FoodSafetyCheck = { ...v1, active: false, effectiveFrom: '2026-10-16T11:00:00.000Z' };
    const s = foodSafetyStatus({ checks: [v1, off], records: [], from: '2026-10-16T00:00:00.000Z', asAt: '2026-10-16T21:00:00.000Z' });
    expect(s.missed.map((x) => x.slotDueAt.slice(11, 16))).toEqual(['02:00', '06:00', '10:00']);
  });
  it('the version in force at a moment is the one that governed it', () => {
    const v2: FoodSafetyCheck = { ...v1, everyMinutes: 60, effectiveFrom: '2026-10-16T12:00:00.000Z' };
    expect(checkInForceAt([v1, v2], v1.checkId, '2026-10-16T06:00:00.000Z')?.everyMinutes).toBe(240);
    expect(checkInForceAt([v1, v2], v1.checkId, '2026-10-16T13:00:00.000Z')?.everyMinutes).toBe(60);
    expect(versionWindows([v1, v2]).map((w) => [w.fromMs, w.toMs])).toEqual([[Number.NEGATIVE_INFINITY, Date.parse('2026-10-16T12:00:00.000Z')], [Date.parse('2026-10-16T12:00:00.000Z'), Number.POSITIVE_INFINITY]]);
  });
});
