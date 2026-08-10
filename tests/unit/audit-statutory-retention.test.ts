import { describe, it, expect } from 'vitest';
import {
  longestStatutoryRetention, statutoryRetentionDecision, STATUTORY_RETENTION, InvalidRetentionInput,
} from '../../packages/audit/src/statutory-retention';

// Roadmap v2.1 A28 — a record is kept for the LONGEST period any binding statute demands, and a legal
// hold blocks deletion regardless of the clock.

describe('longestStatutoryRetention — A28', () => {
  it('picks the longest period when several statutes apply (Companies Act 8yr beats GST/IT 6yr)', () => {
    const r = longestStatutoryRetention(['gst', 'income_tax', 'companies_act']);
    expect(r.months).toBe(96);
    expect(r.governingStatute).toBe('companies_act');
  });

  it('uses a single statute when only one applies', () => {
    expect(longestStatutoryRetention(['gst']).months).toBe(72);
  });

  it('has each statutory minimum as a named constant (≥ 8 years available)', () => {
    expect(STATUTORY_RETENTION.gst.months).toBe(72);
    expect(STATUTORY_RETENTION.income_tax.months).toBe(72);
    expect(STATUTORY_RETENTION.companies_act.months).toBe(96);
  });

  it('rejects an empty or unknown statute set', () => {
    expect(() => longestStatutoryRetention([])).toThrow(InvalidRetentionInput);
    expect(() => longestStatutoryRetention(['vat' as never])).toThrow(InvalidRetentionInput);
  });
});

describe('statutoryRetentionDecision — A28: longest wins + legal hold', () => {
  const base = { recordDate: '2026-08-10', statutes: ['gst', 'income_tax', 'companies_act'] as const };

  it('computes retain-until from the governing period (8 years → 2034-08-10)', () => {
    const d = statutoryRetentionDecision({ ...base, asOf: '2026-08-10' });
    expect(d.retainUntil).toBe('2034-08-10');
    expect(d.effective.governingStatute).toBe('companies_act');
  });

  it('blocks deletion within the retention period', () => {
    const d = statutoryRetentionDecision({ ...base, asOf: '2030-01-01' });
    expect(d.mayDelete).toBe(false);
    expect(d.blockedBy).toBe('retention_period');
  });

  it('allows review once the governing period has elapsed and no hold applies', () => {
    const d = statutoryRetentionDecision({ ...base, asOf: '2034-08-10' });
    expect(d.mayDelete).toBe(true);
    expect(d.blockedBy).toBeUndefined();
  });

  it('a LEGAL HOLD blocks deletion regardless of the clock, even long after expiry', () => {
    const d = statutoryRetentionDecision({ ...base, asOf: '2099-01-01', onLegalHold: true });
    expect(d.mayDelete).toBe(false);
    expect(d.blockedBy).toBe('legal_hold');
  });

  it('rejects a bad date', () => {
    expect(() => statutoryRetentionDecision({ ...base, asOf: '10-08-2026' })).toThrow(InvalidRetentionInput);
  });
});
