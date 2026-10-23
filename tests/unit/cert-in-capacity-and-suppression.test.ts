import { describe, it, expect } from 'vitest';
import { certInClocks, certInOverdue, CERT_IN_REPORT_HOURS, type CertInFact } from '../../services/platform/src/cert-in-reporting';
import { capacityReport, CAPACITY_MEASURES, type CapacityMeasure, type MeasuredVolume } from '../../services/platform/src/capacity-report';
import { isSuppressed, suppressedChannels, type SuppressionFact } from '../../services/customer/src/suppression-register';

// OB-288 P5 — the pure folds behind M35-FR-04 (CERT-In clock, capacity report) and M31-FR-04 (do-not-contact register).

describe('the CERT-In clock (M35-FR-04)', () => {
  const classified = (incidentId: string, noticedAt: string, reportable = true): CertInFact => ({ change: 'classified', incidentId, reportable, category: 'c', reason: 'r', noticedAt, by: 'u-owner', at: noticedAt });
  it('is six hours from when it was noticed; due, overdue, reported in time or late', () => {
    expect(CERT_IN_REPORT_HOURS).toBe(6);
    const facts: CertInFact[] = [
      classified('A', '2026-10-23T00:00:00.000Z'),
      classified('B', '2026-10-23T05:00:00.000Z'),
      classified('C', '2026-10-23T00:00:00.000Z'),
      { change: 'reported', incidentId: 'C', reportedAt: '2026-10-23T05:59:00.000Z', reference: 'x', channel: 'email', by: 'u-owner', at: '2026-10-23T06:30:00.000Z' },
      classified('D', '2026-10-23T00:00:00.000Z'),
      { change: 'reported', incidentId: 'D', reportedAt: '2026-10-23T06:01:00.000Z', reference: 'y', channel: 'email', by: 'u-owner', at: '2026-10-23T06:30:00.000Z' },
      classified('E', '2026-10-23T00:00:00.000Z', false),
    ];
    const at = '2026-10-23T06:30:00.000Z';
    const byId = Object.fromEntries(certInClocks(facts, at).map((c) => [c.incidentId, c]));
    expect(byId['A']).toMatchObject({ state: 'overdue', reportBy: '2026-10-23T06:00:00.000Z', minutesLeft: -30 });
    expect(byId['B']).toMatchObject({ state: 'due', minutesLeft: 270 });
    expect(byId['C']!.state).toBe('reported_in_time');
    expect(byId['D']!.state).toBe('reported_late');
    expect(byId['E']).toMatchObject({ state: 'not_reportable', reportBy: null, minutesLeft: null });
    expect(certInOverdue(facts, at).map((c) => c.incidentId)).toEqual(['A']);
    // Exactly at six hours it is overdue — never a minute's grace.
    expect(certInClocks([classified('F', '2026-10-23T00:00:00.000Z')], '2026-10-23T06:00:00.000Z')[0]!.state).toBe('overdue');
  });
});

describe('the capacity report (M35-FR-04 · §32)', () => {
  const measured = (peaks: Partial<Record<CapacityMeasure, number | null>>): Record<CapacityMeasure, MeasuredVolume> =>
    Object.fromEntries(CAPACITY_MEASURES.map((m) => [m, { peak: peaks[m] ?? null, basis: 'test' }])) as Record<CapacityMeasure, MeasuredVolume>;
  it('is twice the measured peak, carried 12 months at the owner\'s growth, rounded up; never a zero for what is not known', () => {
    const noPlan = capacityReport(measured({ bills_per_day: 1000 }), undefined);
    expect(noPlan.find((r) => r.measure === 'bills_per_day')).toMatchObject({ twicePeak: 2000, target12Months: null, verdict: 'not_known', why: 'the expected growth over 12 months is not set' });
    expect(noPlan.find((r) => r.measure === 'products')).toMatchObject({ measuredPeak: null, twicePeak: null, verdict: 'not_known' });
    const plan = { growthPercentPerYear: 15, provisioned: { bills_per_day: 2300, lanes: 13 }, version: 1, setBy: 'u-owner', setAt: '2026-10-23T00:00:00.000Z' };
    const rows = capacityReport(measured({ bills_per_day: 1000, lanes: 6 }), plan);
    expect(rows.find((r) => r.measure === 'bills_per_day')).toMatchObject({ target12Months: 2300, verdict: 'ok' });
    expect(rows.find((r) => r.measure === 'lanes')).toMatchObject({ twicePeak: 12, target12Months: 14, verdict: 'short' }); // 13.8 → 14
    expect(capacityReport(measured({ bills_per_peak_hour: 10 }), plan).find((r) => r.measure === 'bills_per_peak_hour')).toMatchObject({ verdict: 'not_known', why: 'what the installation is provisioned for is not set' });
  });
});

describe('the do-not-contact register (M31-FR-04)', () => {
  const f = (change: 'suppressed' | 'lifted', channel: SuppressionFact['channel'], n: number): SuppressionFact => ({ change, factId: `f${n}`, customerId: 'C-1', channel, reason: 'r', by: 'u', at: `2026-10-2${n}T00:00:00.000Z` });
  it('the latest fact per channel wins; "all" covers every channel; a lift never removes the record', () => {
    const facts = [f('suppressed', 'sms', 1), f('suppressed', 'all', 2)];
    expect(isSuppressed(facts, 'C-1', 'email').suppressed).toBe(true);
    expect(isSuppressed(facts, 'C-2', 'sms').suppressed).toBe(false);
    const lifted = [...facts, f('lifted', 'all', 3)];
    expect([...suppressedChannels(lifted, 'C-1')]).toEqual(['sms']);
    expect(isSuppressed(lifted, 'C-1', 'email').suppressed).toBe(false);
    expect(isSuppressed(lifted, 'C-1', 'sms')).toMatchObject({ suppressed: true, by: { factId: 'f1' } });
  });
});
