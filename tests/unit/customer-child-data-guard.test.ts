import { describe, it, expect } from 'vitest';
import {
  assessChildDataProcessing,
  ageInYears,
  CHILD_AGE_LIMIT_YEARS,
} from '../../packages/customer/src/child-data-guard';

// C4 / DPDP Act 2023 s.9 — a child (under 18) is processed only with verifiable parental consent, and
// tracking / targeted advertising of a child is refused outright. Age unproven never assumes an adult.

describe('ageInYears', () => {
  it('is the whole years completed at the as-of date', () => {
    expect(ageInYears('2010-08-12', '2026-08-12')).toBe(16); // birthday today
    expect(ageInYears('2010-08-13', '2026-08-12')).toBe(15); // day before the birthday
  });

  it('turns 18 exactly on the eighteenth birthday, not the day before', () => {
    expect(ageInYears('2008-08-12', '2026-08-12')).toBe(18); // adult from today
    expect(ageInYears('2008-08-13', '2026-08-12')).toBe(17); // still a child the day before
  });

  it('ignores the time of day on the as-of stamp', () => {
    expect(ageInYears('2008-08-12', '2026-08-12T23:59:59Z')).toBe(18);
  });

  it('returns undefined for a malformed or impossible date rather than guessing', () => {
    expect(ageInYears('2010-13-01', '2026-08-12')).toBeUndefined(); // month 13
    expect(ageInYears('2010-04-31', '2026-08-12')).toBeUndefined(); // 31 April
    expect(ageInYears('2010', '2026-08-12')).toBeUndefined();       // too short
    expect(ageInYears('2010-08-12', 'nope')).toBeUndefined();       // bad as-of
  });
});

describe('assessChildDataProcessing (DPDP s.9)', () => {
  it('the child age limit is eighteen', () => {
    expect(CHILD_AGE_LIMIT_YEARS).toBe(18);
  });

  it('permits an adult — the ordinary consent rules take over', () => {
    const d = assessChildDataProcessing({ activity: 'marketing', ageYears: 30 });
    expect(d.allowed).toBe(true);
    expect(d.verdict).toBe('permitted');
    expect(d.isChild).toBe(false);
  });

  it('blocks marketing to a child without verifiable parental consent', () => {
    const d = assessChildDataProcessing({ activity: 'marketing', ageYears: 15 });
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe('needs_parental_consent');
    expect(d.isChild).toBe(true);
  });

  it('permits enrolment of a child WITH verifiable parental consent (s.9(1))', () => {
    const d = assessChildDataProcessing({ activity: 'account_enrolment', ageYears: 15, parentalConsentVerified: true });
    expect(d.allowed).toBe(true);
    expect(d.verdict).toBe('permitted');
    expect(d.isChild).toBe(true);
  });

  it('refuses profiling of a child without parental consent', () => {
    const d = assessChildDataProcessing({ activity: 'profiling', ageYears: 12 });
    expect(d.verdict).toBe('needs_parental_consent');
    expect(d.allowed).toBe(false);
  });

  it('prohibits behavioural tracking of a child even WITH parental consent (s.9(3))', () => {
    const d = assessChildDataProcessing({ activity: 'behavioural_tracking', ageYears: 15, parentalConsentVerified: true });
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe('prohibited_for_child'); // consent cannot cure it
  });

  it('prohibits advertising targeted at a child even WITH parental consent (s.9(3))', () => {
    const d = assessChildDataProcessing({ activity: 'targeted_advertising', ageYears: 10, parentalConsentVerified: true });
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe('prohibited_for_child');
  });

  it('refuses a child-restricted activity when the age is not established (never assumes an adult)', () => {
    const d = assessChildDataProcessing({ activity: 'marketing' }); // no age, no DOB
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe('age_unverified');
    expect(d.isChild).toBe('unknown');
  });

  it('lets a transactional or service message through regardless of age (not a child restriction)', () => {
    expect(assessChildDataProcessing({ activity: 'transactional', ageYears: 8 }).allowed).toBe(true);
    expect(assessChildDataProcessing({ activity: 'service' }).allowed).toBe(true); // even with age unknown
    expect(assessChildDataProcessing({ activity: 'service' }).verdict).toBe('permitted');
  });

  it('resolves age from a date of birth + as-of date', () => {
    // born 2012, as-of 2026 → 14 → a child; parental consent still required
    const child = assessChildDataProcessing({ activity: 'marketing', dateOfBirth: '2012-01-01', asOf: '2026-08-12' });
    expect(child.isChild).toBe(true);
    expect(child.verdict).toBe('needs_parental_consent');
    // born 2000 → 26 → an adult
    const adult = assessChildDataProcessing({ activity: 'marketing', dateOfBirth: '2000-01-01', asOf: '2026-08-12' });
    expect(adult.verdict).toBe('permitted');
  });
});
