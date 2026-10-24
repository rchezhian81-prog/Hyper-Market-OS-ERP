import { describe, it, expect } from 'vitest';
import { createOwnerAlertsSession, paiseOfRupees, hoursOfText, shownValue, ownerAlertsWords, OWNER_ALERTS_COPY } from '../../apps/web-erp/src/owner-alerts-session';

/**
 * The owner alerts and schedules page's session (OB-288 lane 4 · P2): what each role may do, what a typed threshold
 * becomes before it is sent (and what is refused on the page, sending nothing), and that every word has a Tamil twin.
 */

type Sent = { method: string; path: string; body: unknown };
const recorder = () => {
  const sent: Sent[] = [];
  const fetch = (async (path: string, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
};

describe('owner alerts session', () => {
  it('the owner may manage and schedule; a manager may only read; nobody signed in may do nothing', () => {
    const owner = createOwnerAlertsSession({ viewer: { userId: 'u-owner', permissions: ['owner.alert.read', 'owner.alert.manage', 'owner.kpi.read', 'owner.report.schedule'] } });
    expect(owner.may).toEqual({ named: true, open: true, manage: true, schedulesRead: true, schedule: true });
    const mgr = createOwnerAlertsSession({ viewer: { userId: 'u-mgr', permissions: ['owner.alert.read', 'owner.kpi.read'] } });
    expect(mgr.may).toEqual({ named: true, open: true, manage: false, schedulesRead: true, schedule: false });
    expect(createOwnerAlertsSession({ viewer: undefined }).may.open).toBe(false);
  });

  it('a typed threshold is sent in the unit head office reads; a bad one is refused on the page, nothing sent', async () => {
    const { sent, fetch } = recorder();
    const s = createOwnerAlertsSession({ viewer: { userId: 'u-owner', permissions: ['owner.alert.manage'] }, fetch, newKey: () => 'k' });
    expect(await s.setThreshold('cash_short', '')).toEqual({ result: 'invalid', why: 'needValue' });
    expect(await s.setThreshold('cash_short', '-5')).toEqual({ result: 'invalid', why: 'needRupees' });
    expect(await s.setThreshold('voided_bill', '1.5')).toEqual({ result: 'invalid', why: 'needCount' });
    expect(await s.setThreshold('after_hours_login', '23-8')).toEqual({ result: 'invalid', why: 'needHours' });
    expect(await s.clearThreshold('cash_short', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(sent).toEqual([]);
    await s.setThreshold('cash_short', '500.50');
    await s.setThreshold('voided_bill', '3');
    await s.setThreshold('after_hours_login', '8-23');
    await s.saveSchedule({ scheduleId: 's1', kind: 'export', target: 'sales', time: '21:30', language: 'ta' });
    expect(sent.map((x) => [x.path, x.body])).toEqual([
      ['/v1/reporting/owner-alert-thresholds/cash_short', { value: 50_050 }],
      ['/v1/reporting/owner-alert-thresholds/voided_bill', { value: 3 }],
      ['/v1/reporting/owner-alert-thresholds/after_hours_login', { value: { opensAtHour: 8, closesAtHour: 23 } }],
      ['/v1/reporting/report-schedules/s1', { kind: 'export', target: 'sales', dueAt: [21, 30], language: 'ta' }],
    ]);
    expect(await s.saveSchedule({ scheduleId: 's1', kind: 'report', target: 'x', time: '25:00', language: 'en' })).toEqual({ result: 'invalid', why: 'needSchedule' });
  });

  it('values read back in the owner\'s words; every word has a Tamil twin', () => {
    expect(paiseOfRupees('1,000')).toBe(100_000);
    expect(paiseOfRupees('0')).toBeUndefined();
    expect(hoursOfText(' 9 - 22 ')).toEqual({ opensAtHour: 9, closesAtHour: 22 });
    expect(shownValue('cash_short', 50_050)).toBe('₹500.50');
    expect(shownValue('after_hours_login', { opensAtHour: 8, closesAtHour: 23 })).toBe('8-23');
    expect(Object.keys(OWNER_ALERTS_COPY.ta).sort()).toEqual(Object.keys(OWNER_ALERTS_COPY.en).sort());
    expect(ownerAlertsWords('ta', 'notSet')).not.toBe(ownerAlertsWords('en', 'notSet'));
  });
});
