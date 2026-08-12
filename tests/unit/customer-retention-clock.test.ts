import { describe, it, expect } from 'vitest';
import {
  assessRetention,
  InvalidRetentionInputError,
  type RetainedCategory,
} from '../../packages/customer/src/retention-clock';

// C3 / DPDP Act 2023 s.8(7) — the automated retention clock. Once a category's purpose is served or consent
// is withdrawn it moves toward erasure, through a pre-erasure notice window, unless the law requires it kept
// (minimise, or retain audit evidence in full — hard rule #6). Pure: the clock is injected.

const NOW = '2026-08-12T00:00:00Z';
const cat = (over: Partial<RetainedCategory> & Pick<RetainedCategory, 'category'>): RetainedCategory => ({
  recordCount: 1, ...over,
});
const actionOf = (sweep: ReturnType<typeof assessRetention>, category: string) =>
  sweep.categories.find((c) => c.category === category)!.action;

describe('assessRetention', () => {
  it('retains a category whose purpose is still live and consent is held', () => {
    const sweep = assessRetention({ asOf: NOW, categories: [cat({ category: 'App activity' })] });
    expect(actionOf(sweep, 'App activity')).toBe('retain');
  });

  it('erases an erasable category once purpose is served and the notice window has passed', () => {
    // purpose served 40 days ago, notice window 30 → the erasure date (served + 30) is in the past.
    const sweep = assessRetention({
      asOf: NOW, noticeLeadDays: 30,
      categories: [cat({ category: 'Marketing preferences', purposeServedAt: '2026-07-03T00:00:00Z' })],
    });
    const c = sweep.categories.find((x) => x.category === 'Marketing preferences')!;
    expect(c.action).toBe('erase');
    expect(c.trigger).toEqual({ reason: 'purpose_served', at: '2026-07-03T00:00:00Z' });
    expect(sweep.eraseNowCount).toBe(1);
  });

  it('gives a pre-erasure notice while the window is still open, with the scheduled date', () => {
    // consent withdrawn 5 days ago, notice window 30 → erasure scheduled 25 days out; notice due now.
    const sweep = assessRetention({
      asOf: NOW, noticeLeadDays: 30,
      categories: [cat({ category: 'Marketing preferences', consentWithdrawnAt: '2026-08-07T00:00:00Z' })],
    });
    const c = sweep.categories.find((x) => x.category === 'Marketing preferences')!;
    expect(c.action).toBe('notice');
    expect(c.erasureScheduledFor).toBe('2026-09-06T00:00:00.000Z'); // withdrawn + 30 days
    expect(sweep.preErasureNotice).toBeDefined();
    expect(sweep.preErasureNotice!.join(' ')).toContain('2026-09-06');
  });

  it('minimises a legally-retained but minimisable category instead of erasing it', () => {
    const sweep = assessRetention({
      asOf: NOW,
      categories: [cat({ category: 'Sales invoices', recordCount: 3, purposeServedAt: '2026-01-01T00:00:00Z', retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', minimisable: true })],
    });
    expect(actionOf(sweep, 'Sales invoices')).toBe('minimise');
    expect(sweep.minimiseCount).toBe(1);
  });

  it('keeps audit evidence in full and never erases it (hard rule #6)', () => {
    const sweep = assessRetention({
      asOf: NOW,
      categories: [cat({ category: 'Audit trail', recordCount: 96, consentWithdrawnAt: '2026-01-01T00:00:00Z', retentionBasis: 'audit_evidence' })],
    });
    expect(actionOf(sweep, 'Audit trail')).toBe('retain_by_law');
    expect(sweep.eraseNowCount).toBe(0);
  });

  it('starts the clock from the EARLIER of purpose-served and consent-withdrawn', () => {
    const sweep = assessRetention({
      asOf: NOW, noticeLeadDays: 30,
      categories: [cat({ category: 'Marketing preferences', purposeServedAt: '2026-08-10T00:00:00Z', consentWithdrawnAt: '2026-08-01T00:00:00Z' })],
    });
    const c = sweep.categories.find((x) => x.category === 'Marketing preferences')!;
    expect(c.trigger!.reason).toBe('consent_withdrawn'); // 1 Aug is earlier than 10 Aug
    expect(c.erasureScheduledFor).toBe('2026-08-31T00:00:00.000Z'); // 1 Aug + 30
  });

  it('rejects malformed input', () => {
    expect(() => assessRetention({ asOf: 'nope', categories: [] })).toThrow(InvalidRetentionInputError);
    expect(() => assessRetention({ asOf: NOW, categories: [], noticeLeadDays: -1 })).toThrow(InvalidRetentionInputError);
  });
});
