import { describe, it, expect } from 'vitest';
import { projectLicences, licenceAlerts, type LicenceState, type LicenceEvent } from '../../services/platform/src/licences';

// M33-FR-04 — the fold + the expiry-alert engine behind "an expiring licence alerts a named owner".

const AT = '2026-09-02T09:00:00Z';
const ASOF = '2026-09-02';
const licence = (moduleId: string, over: Partial<LicenceState> = {}): LicenceState => ({
  moduleId, name: `${moduleId} licence`, enabled: true, ownerUserId: 'u-owner', ownerName: 'Chezhian', ...over,
});
const ev = (l: LicenceState): LicenceEvent => ({ licence: l, by: 'u-owner', at: AT });

describe('projectLicences — latest-per-module fold', () => {
  it('is empty for no events, and keeps one row per module with the latest winning', () => {
    expect(projectLicences([])).toEqual([]);
    const got = projectLicences([
      ev(licence('gst-filing', { enabled: true })),
      ev(licence('gst-filing', { enabled: false })), // re-set wins
      ev(licence('weighing-scale')),
    ]);
    expect(got).toHaveLength(2);
    expect(got.find((l) => l.moduleId === 'gst-filing')?.enabled).toBe(false);
  });
});

describe('licenceAlerts — worst first, keeps shouting after the date, names the owner', () => {
  it('ignores a perpetual, a disabled, or a far-off licence', () => {
    const alerts = licenceAlerts([
      licence('perpetual'), // no expiresOn
      licence('disabled', { enabled: false, expiresOn: '2026-09-05' }),
      licence('far', { expiresOn: '2026-12-31' }), // 120 days > noticeDays
    ], ASOF);
    expect(alerts).toEqual([]);
  });

  it('grades by how close expiry is, and an EXPIRED licence stays in the list', () => {
    const alerts = licenceAlerts([
      licence('notice', { expiresOn: '2026-10-10' }),   // 38 days
      licence('warning', { expiresOn: '2026-09-20' }),  // 18 days
      licence('critical', { expiresOn: '2026-09-05' }), // 3 days
      licence('expired', { expiresOn: '2026-08-25' }),  // -8 days
    ], ASOF);
    const byModule = Object.fromEntries(alerts.map((a) => [a.moduleId, a.level]));
    expect(byModule).toEqual({ notice: 'notice', warning: 'warning', critical: 'critical', expired: 'expired' });
    // Worst (most overdue) first.
    expect(alerts.map((a) => a.moduleId)).toEqual(['expired', 'critical', 'warning', 'notice']);
    // The expired one keeps shouting and names the owner.
    expect(alerts[0]?.message).toContain('EXPIRED');
    expect(alerts[0]?.message).toContain('Chezhian');
    expect(alerts[0]?.daysRemaining).toBeLessThan(0);
  });
});
