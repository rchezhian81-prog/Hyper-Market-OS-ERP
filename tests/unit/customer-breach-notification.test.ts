import { describe, it, expect } from 'vitest';
import {
  assessBreachNotification,
  InvalidBreachInputError,
  BOARD_REPORT_FIELDS,
  PRINCIPAL_NOTICE_FIELDS,
  type BreachInput,
} from '../../packages/customer/src/breach-notification';

// C2 / DPDP Act 2023 s.8(6) — a personal-data breach becomes the notification workflow the law requires:
// the Data Protection Board (immediate + a 72-hour report) and every affected person, each with prescribed
// content. It drafts and tracks; a person sends. Pure: the deadline comes from discovery, "now" is supplied.

const DISCOVERED = '2026-08-10T09:00:00Z';

const base = (over: Partial<BreachInput> = {}): BreachInput => ({
  breachId: 'BR-1',
  discoveredAt: DISCOVERED,
  asOf: '2026-08-10T12:00:00Z', // 3 hours after discovery
  affectedDataCategories: ['contact', 'loyalty'],
  affectedPrincipalCount: 40,
  ...over,
});

const obligation = (plan: ReturnType<typeof assessBreachNotification>, kind: string) =>
  plan.obligations.find((o) => o.obligation === kind)!;

describe('assessBreachNotification', () => {
  it('sets the 72-hour Board report deadline from the discovery time', () => {
    const plan = assessBreachNotification(base());
    expect(plan.reportDeadline).toBe('2026-08-13T09:00:00.000Z'); // discovery + 72h
    expect(plan.advisoryOnly).toBe(true);
  });

  it('raises all three obligations as due for a fresh, unactioned breach', () => {
    const plan = assessBreachNotification(base());
    expect(plan.obligations.map((o) => o.obligation)).toEqual([
      'board_immediate_intimation', 'board_72h_report', 'affected_principal_notices',
    ]);
    expect(obligation(plan, 'board_immediate_intimation').status).toBe('due');
    expect(obligation(plan, 'board_72h_report').status).toBe('due'); // within 72h
    expect(obligation(plan, 'affected_principal_notices').status).toBe('due');
    expect(plan.allSatisfied).toBe(false);
  });

  it('lists the prescribed content still missing on each notice', () => {
    const plan = assessBreachNotification(base());
    expect(obligation(plan, 'board_72h_report').missingContent).toEqual([...BOARD_REPORT_FIELDS]);
    expect(obligation(plan, 'affected_principal_notices').missingContent).toEqual([...PRINCIPAL_NOTICE_FIELDS]);
  });

  it('clears the missing-content list as the prescribed fields are supplied', () => {
    const plan = assessBreachNotification(base({
      description: 'an export ran without the usual access control',
      likelyConsequences: 'contact details may be exposed',
      mitigationMeasures: 'access revoked, tokens rotated',
      remedialMeasures: 'the export path now requires approval',
      safetyMeasuresForPrincipals: 'watch for unexpected messages',
      contactPoint: 'dpo@sre.example',
    }));
    expect(obligation(plan, 'board_72h_report').missingContent).toEqual([]);
    expect(obligation(plan, 'affected_principal_notices').missingContent).toEqual([]);
  });

  it('marks the 72-hour report OVERDUE once the deadline passes with no filing', () => {
    const plan = assessBreachNotification(base({ asOf: '2026-08-13T10:00:00Z' })); // an hour past the deadline
    expect(obligation(plan, 'board_72h_report').status).toBe('overdue');
    expect(plan.detail).toContain('OVERDUE');
  });

  it('is satisfied only when every obligation is done AND the content is complete', () => {
    const done = base({
      description: 'd', likelyConsequences: 'c', mitigationMeasures: 'm', remedialMeasures: 'r',
      safetyMeasuresForPrincipals: 's', contactPoint: 'dpo@sre.example',
      boardIntimatedAt: '2026-08-10T10:00:00Z',
      boardReportFiledAt: '2026-08-11T09:00:00Z',
      principalsNotifiedAt: '2026-08-10T18:00:00Z',
    });
    const plan = assessBreachNotification(done);
    expect(plan.obligations.every((o) => o.status === 'done')).toBe(true);
    expect(plan.allSatisfied).toBe(true);
    expect(plan.detail).toBe('every breach-notification obligation is met');

    // A recorded filing is taken as done: the content checklist is a pre-filing DRAFTING aid, not
    // re-validated after the fact — the filing timestamp is the caller's attestation it went with content.
    const filed = assessBreachNotification(base({
      boardIntimatedAt: '2026-08-10T10:00:00Z', boardReportFiledAt: '2026-08-11T09:00:00Z', principalsNotifiedAt: '2026-08-10T18:00:00Z',
    }));
    expect(filed.obligations.every((o) => o.status === 'done')).toBe(true);
    expect(filed.allSatisfied).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => assessBreachNotification(base({ breachId: '' }))).toThrow(InvalidBreachInputError);
    expect(() => assessBreachNotification(base({ discoveredAt: 'nope' }))).toThrow(InvalidBreachInputError);
    expect(() => assessBreachNotification(base({ affectedPrincipalCount: -1 }))).toThrow(InvalidBreachInputError);
  });
});
