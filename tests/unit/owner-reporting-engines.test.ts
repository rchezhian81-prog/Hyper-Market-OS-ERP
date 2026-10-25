import { describe, it, expect } from 'vitest';
import {
  thresholdBoard, engineThresholds, readThresholdValue, latestThresholds, ownerExceptionAlertId, sweepOwnerExceptions, NOT_SET_SAY,
  type ThresholdSetting, type ExceptionSource, type OwnerExceptionsDeps,
} from '../../services/reporting/src/owner-exceptions';
import { runSchedulesPass, currentSchedules, SCHEDULE_SENDING_OFF, type ReportScheduleDeps, type ReportSchedule, type ScheduledRun } from '../../services/reporting/src/report-schedules';
import { renamed } from '../../services/api/src/dashboard-figures';
import { figure } from '../../services/reporting/src/index';
import type { ExceptionEvent } from '../../packages/owner-control/src/index';

/**
 * OB-288 P2 — the pure halves of the owner's exception alerts (M29-FR-03), the scheduled reports (M29-FR-04) and the
 * dashboard's figure naming (M29-FR-01): a threshold not set raises nothing and says so; a cleared one is not set again
 * (the earlier value kept); a value that is not one is refused; a missed run is carried and labelled late; a schedule
 * whose owner lost the authority never runs as anybody else; a renamed figure keeps its value, time and freshness.
 */

const sources: ExceptionSource[] = [
  { kind: 'large_discount', known: true, asAt: '2026-10-24T05:00:00Z' }, { kind: 'voided_bill', known: true, asAt: '2026-10-24T05:00:00Z' },
  { kind: 'price_override', known: true, asAt: '2026-10-24T05:00:00Z' }, { kind: 'after_hours_login', known: false, asAt: null, why: 'not received' },
  { kind: 'cash_short', known: true, asAt: null },
];
const set = (kind: ThresholdSetting['kind'], value: ThresholdSetting['value'], at = '2026-10-24T01:00:00Z'): ThresholdSetting => ({ kind, value, setBy: 'u-owner', setAt: at });

describe('owner exception thresholds (M29-FR-03)', () => {
  it('none set: every one says "not set", none can fire, and the engine is handed no threshold at all', () => {
    const board = thresholdBoard([], sources);
    expect(board.every((b) => b.state === 'not_set' && !b.canFire && b.whyNot === NOT_SET_SAY)).toBe(true);
    expect(engineThresholds([])).toEqual({});
  });
  it('a set threshold fires only where head office receives the records; a cleared one is not set again, the earlier value kept', () => {
    const history = [set('voided_bill', 3), set('after_hours_login', { opensAtHour: 8, closesAtHour: 23 }), set('voided_bill', 2, '2026-10-24T02:00:00Z')];
    const board = thresholdBoard(history, sources);
    expect(board.find((b) => b.kind === 'voided_bill')).toMatchObject({ state: 'set', value: 2, canFire: true });
    expect(board.find((b) => b.kind === 'after_hours_login')).toMatchObject({ state: 'set', canFire: false });
    expect(board.find((b) => b.kind === 'after_hours_login')!.whyNot).toContain('not received');
    expect(engineThresholds(history)).toEqual({ voidedBillCount: 2, tradingHours: [8, 23] });
    const cleared = [...history, { ...set('voided_bill', null, '2026-10-24T03:00:00Z'), reason: 'noisy' }];
    expect(latestThresholds(cleared).get('voided_bill')!.value).toBeNull();
    expect(engineThresholds(cleared)).toEqual({ tradingHours: [8, 23] });
    expect(cleared).toHaveLength(4); // append-only: nothing replaced
  });
  it('a value that is not a threshold is refused, by its kind', () => {
    expect(readThresholdValue('cash_short', 0).ok).toBe(false);
    expect(readThresholdValue('cash_short', 1.5).ok).toBe(false);
    expect(readThresholdValue('voided_bill', 3)).toEqual({ ok: true, value: 3 });
    expect(readThresholdValue('after_hours_login', { opensAtHour: 23, closesAtHour: 8 }).ok).toBe(false);
    expect(readThresholdValue('after_hours_login', { opensAtHour: 7, closesAtHour: 24 })).toEqual({ ok: true, value: { opensAtHour: 7, closesAtHour: 24 } });
  });
  it('the sweep raises each group once per day, over yesterday and today, and nothing without a threshold', async () => {
    const events: ExceptionEvent[] = [
      { eventId: 'v1', kind: 'voided_bill', at: '2026-10-24T05:00:00Z', branchId: 'S1', actorId: 'c-1', valueMinor: 100, transactionRef: 'B-1' },
      { eventId: 'v2', kind: 'voided_bill', at: '2026-10-24T05:10:00Z', branchId: 'S1', actorId: 'c-1', valueMinor: 200, transactionRef: 'B-2' },
    ];
    let settings: ThresholdSetting[] = [];
    const inbox = new Set<string>();
    const deps: OwnerExceptionsDeps = {
      now: () => '2026-10-24T06:00:00Z', settings: async () => settings, recordSetting: async () => {},
      today: async () => '2026-10-24', dayBefore: () => '2026-10-23',
      exceptions: async (_t, day) => ({ events: day === '2026-10-24' ? events : [], sources }),
      raisedIds: async () => inbox,
      raise: async (_t, day, alerts) => { let raised = 0; for (const a of alerts) { const id = ownerExceptionAlertId(day, a); if (!inbox.has(id)) { inbox.add(id); raised += 1; } } return { raised, alreadyRaised: 0, owners: 1 }; },
    };
    expect((await sweepOwnerExceptions(deps, 'T', '2026-10-24T06:00:00Z')).raised).toBe(0);
    settings = [set('voided_bill', 2)];
    const r = await sweepOwnerExceptions(deps, 'T', '2026-10-24T06:00:00Z');
    expect(r.raised).toBe(1);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-23', '2026-10-24']);
    expect([...inbox]).toEqual(['owner-exception:2026-10-24:voided_bill|S1|c-1']);
    expect((await sweepOwnerExceptions(deps, 'T', '2026-10-24T06:05:00Z')).raised).toBe(0);
  });
});

describe('scheduled reports (M29-FR-04)', () => {
  const schedule = (over: Partial<ReportSchedule> = {}): ReportSchedule => ({
    scheduleId: 's1', kind: 'report', target: 'sales_by_day', dueAt: [21, 0], language: 'en', ownerUserId: 'u-owner', status: 'active',
    setAt: '2026-10-20T03:00:00Z', since: '2026-10-20T03:00:00Z', ...over,
  });
  const make = (schedules: ReportSchedule[], wall: string, mayRun = true) => {
    const runs: ScheduledRun[] = [];
    const deps: ReportScheduleDeps = {
      now: () => `${wall}:00Z`, schedules: async () => schedules, recordSchedule: async () => {},
      runs: async () => runs, recordRun: async (_t, r) => { if (!runs.some((x) => x.scheduleId === r.scheduleId && x.tradingDay === r.tradingDay)) runs.push(r); },
      shopClock: async () => ({ today: wall.slice(0, 10), wall }), tradingDayOf: async (_t, at) => at.slice(0, 10),
      reportKnown: async () => true, exportKnown: async () => true, mayRunAs: async () => mayRun,
      produceReport: async (_t, id, day) => ({ ok: true, rowCount: 1, figures: [], lines: [`${id} ${day}`] }),
      runExport: async () => ({ ok: false, why: 'not used' }),
    };
    return { deps, runs };
  };
  it('a missed day is carried and labelled LATE; today waits for its time; a second pass prepares nothing', async () => {
    const { deps, runs } = make([schedule()], '2026-10-22T20:00');
    const first = await runSchedulesPass(deps, 'T');
    expect(first.runs.map((r) => [r.tradingDay, r.reason])).toEqual([['2026-10-20', 'missed_catch_up'], ['2026-10-21', 'missed_catch_up']]);
    expect(first.runs[0]!.lines[0]).toContain('LATE');
    expect(first.runs.every((r) => r.sending === 'switched_off' && r.detail === SCHEDULE_SENDING_OFF)).toBe(true);
    expect((await runSchedulesPass(deps, 'T')).prepared).toBe(0);
    expect(runs).toHaveLength(2);
  });
  it('a schedule whose owner no longer holds the authority is refused by name — never run as anybody else', async () => {
    const { deps } = make([schedule({ since: '2026-10-22T03:00:00Z' })], '2026-10-22T21:30', false);
    const r = await runSchedulesPass(deps, 'T');
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ outcome: 'refused', ranAs: 'u-owner' });
    expect(r.runs[0]!.lines[0]).toContain('never runs as anybody else');
  });
  it('a stopped schedule prepares nothing; the latest fact per schedule applies', async () => {
    const facts = [schedule(), schedule({ status: 'stopped', setAt: '2026-10-21T00:00:00Z' })];
    expect(currentSchedules(facts)).toEqual([facts[1]]);
    const { deps } = make(facts, '2026-10-22T22:00');
    expect((await runSchedulesPass(deps, 'T')).prepared).toBe(0);
  });
  it('with the queue and a sending link on, the owner is told on the queue (production: off)', async () => {
    const queued: string[] = [];
    const { deps } = make([schedule({ since: '2026-10-22T03:00:00Z' })], '2026-10-22T21:30');
    const r = await runSchedulesPass({ ...deps, sendingOn: true, outbox: { enqueue: (_t, e) => { queued.push(e.id); } } }, 'T');
    expect(r.runs[0]!.sending).toBe('queued');
    expect(queued).toEqual(['report-s1-2026-10-22']);
  });
});

describe('the dashboard\'s figure names (M29-FR-01)', () => {
  it('a renamed figure keeps its value, time and freshness; an unavailable one keeps its reason', () => {
    const f = figure({ name: 'Taken', valueMinor: 500, unit: 'minor_currency', asAt: '2026-10-24T05:00:00Z', now: '2026-10-24T05:01:00Z' });
    expect(renamed(f, 'Sales today')).toMatchObject({ name: 'Sales today', valueMinor: 500, asAt: f.asAt, staleness: 'live' });
    expect(renamed(f, 'Sales today').detail.startsWith('Sales today:')).toBe(true);
    const na = figure({ name: 'Margin', unit: 'minor_currency', asAt: null, now: '2026-10-24T05:01:00Z', notAvailableBecause: 'no cost' });
    expect(renamed(na, 'Margin today')).toMatchObject({ name: 'Margin today', notAvailableBecause: 'no cost' });
    expect(renamed(na, 'Margin today').valueMinor).toBeUndefined();
  });
});
