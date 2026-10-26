import { describe, it, expect } from 'vitest';
import { contractExpiryAlerts, staleAlertIds, readWarningDays, contractAlertId, type ExpiringContract } from '../../packages/purchasing/src/contract-expiry';

// FG-4 · M04-FR-04 / M06-FR-03: which contracts the owner is told about today. Expired always; expiring only inside the
// window the owner entered (null = not set — nothing early, no invented number); unapproved never.

const c = (over: Partial<ExpiringContract>): ExpiringContract => ({ register: 'supplier', contractId: 'K1', supplierId: 'S1', endsOn: '2026-11-30', approved: true, ...over });

describe('contract-expiry alerts (M04-FR-04 · M06-FR-03)', () => {
  it('raises an ended contract as expired, whether or not the window is set', () => {
    const due = contractExpiryAlerts({ contracts: [c({ endsOn: '2026-10-25' })], today: '2026-10-26', warnDays: null });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ step: 'expired', daysLeft: -1, alertId: 'supplier-contract-expiry:K1:2026-10-25:expired' });
    expect(due[0]!.detail).toContain('no agreed terms');
  });

  it('the last day itself is not expired; inside the window it is expiring; with no window nothing early', () => {
    expect(contractExpiryAlerts({ contracts: [c({ endsOn: '2026-10-26' })], today: '2026-10-26', warnDays: null })).toEqual([]);
    const soon = contractExpiryAlerts({ contracts: [c({ endsOn: '2026-11-05' })], today: '2026-10-26', warnDays: 10 });
    expect(soon.map((a) => [a.step, a.daysLeft])).toEqual([['expiring', 10]]);
    expect(contractExpiryAlerts({ contracts: [c({ endsOn: '2026-11-06' })], today: '2026-10-26', warnDays: 10 })).toEqual([]);
  });

  it('an unapproved contract raises nothing; a display contract says what space it buys', () => {
    expect(contractExpiryAlerts({ contracts: [c({ approved: false, endsOn: '2026-01-01' })], today: '2026-10-26', warnDays: 30 })).toEqual([]);
    const d = contractExpiryAlerts({ contracts: [c({ register: 'display', what: 'end-cap at s1', endsOn: '2026-10-01' })], today: '2026-10-26', warnDays: null });
    expect(d[0]!.alertId).toBe('display-contract-expiry:K1:2026-10-01:expired');
    expect(d[0]!.detail).toContain('end-cap at s1');
    expect(d[0]!.detail).toContain('giving the space away');
  });

  it('a renewal (a later end date) makes the old alert stale; a still-due alert is never stale; foreign alerts are left alone', () => {
    const old = contractAlertId(c({ endsOn: '2026-10-01' }), 'expired');
    const due = contractExpiryAlerts({ contracts: [c({ endsOn: '2027-10-01' }), c({ contractId: 'K2', endsOn: '2026-09-01' })], today: '2026-10-26', warnDays: null });
    const stillDue = contractAlertId(c({ contractId: 'K2', endsOn: '2026-09-01' }), 'expired');
    expect(staleAlertIds({ openAlertIds: [old, stillDue, 'gst-time-bar:2023-04'], due })).toEqual([old]);
  });

  it('reads the owner\'s window strictly', () => {
    expect(readWarningDays(30)).toEqual({ ok: true, days: 30 });
    for (const bad of [0, -1, 366, 1.5, '30', null]) expect(readWarningDays(bad).ok).toBe(false);
  });
});
