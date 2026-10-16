import { describe, it, expect } from 'vitest';
import {
  assessPiiSafeguards, assessSecurityLogRetention, realmSecurityLogs, SECURITY_LOG_MINIMUM_DAYS,
  type PiiFieldDeclaration,
} from '../../packages/customer/src/pii-safeguards';

// C7 (v2.1 addendum · M02/M34/M35): personal-data fields are encrypted or masked; security logs are kept ≥ 1 year.

const POLICY = { LoyaltyMember: [{ fields: ['mobileLast4'] }], ServiceCaseRecorded: [{ fields: ['summary', 'resolution'] }] };
const d = (over: Partial<PiiFieldDeclaration>): PiiFieldDeclaration => ({ file: 'f.ts', field: 'x', whose: 'customer', protection: 'not_kept', evidence: 'why', ...over });

describe('every personal-data field is sealed, masked, never kept, or held by the identity server (C7)', () => {
  it('passes a declaration the policy and the maskers bear out', () => {
    const r = assessPiiSafeguards({
      declarations: [
        d({ field: 'mobileLast4', protection: 'sealed_per_subject', evidence: 'LoyaltyMember' }),
        d({ field: 'aadhaar', whose: 'staff', protection: 'masked_on_read', evidence: 'maskAadhaar' }),
        d({ field: 'email', whose: 'user', protection: 'held_by_identity_server' }),
      ],
      sealingPolicy: POLICY, maskers: ['maskAadhaar'],
    });
    expect(r.compliant).toBe(true);
    expect(r.byProtection).toMatchObject({ sealed_per_subject: 1, masked_on_read: 1, held_by_identity_server: 1, unprotected: 0 });
  });

  it('a field declared sealed that the policy does not seal is a false claim', () => {
    const r = assessPiiSafeguards({ declarations: [d({ field: 'phone', protection: 'sealed_per_subject', evidence: 'LoyaltyMember' })], sealingPolicy: POLICY, maskers: [] });
    expect(r.findings.map((f) => f.flag)).toEqual(['claimed_sealed_but_not_sealed']);
  });

  it('a field declared masked by a function that does not exist is a finding', () => {
    const r = assessPiiSafeguards({ declarations: [d({ protection: 'masked_on_read', evidence: 'maskNothing' })], sealingPolicy: POLICY, maskers: ['maskAadhaar'] });
    expect(r.findings.map((f) => f.flag)).toEqual(['masked_without_a_masker']);
  });

  it('an unprotected field is always a finding, naming the decision it waits on', () => {
    const r = assessPiiSafeguards({ declarations: [d({ field: 'phone', whose: 'supplier_contact', protection: 'unprotected', awaitingDecision: 'the owner\'s decision' })], sealingPolicy: POLICY, maskers: [] });
    expect(r.compliant).toBe(false);
    expect(r.findings[0]?.detail).toContain('waiting on the owner\'s decision');
  });
});

describe('security logs are kept at least one year (C7)', () => {
  it('the floor is 365 days', () => { expect(SECURITY_LOG_MINIMUM_DAYS).toBe(365); });

  it('passes sign-in events kept 366 days and an audit trail kept for ever', () => {
    const logs = [...realmSecurityLogs('sre-store', { eventsEnabled: true, eventsExpiration: 366 * 86_400, adminEventsEnabled: true }),
      { logId: 'audit_log', kind: 'audit_trail' as const, enabled: true, retentionDays: 'forever' as const }];
    expect(assessSecurityLogRetention(logs)).toMatchObject({ compliant: true, findings: [] });
  });

  it('fails sign-in events that are off, or kept less than a year, and a missing audit trail', () => {
    const off = assessSecurityLogRetention(realmSecurityLogs('r', { eventsEnabled: false, adminEventsEnabled: true }));
    expect(off.findings.map((f) => f.flag)).toEqual(['not_enabled', 'not_enabled', 'not_enabled']);
    const short = assessSecurityLogRetention([...realmSecurityLogs('r', { eventsEnabled: true, eventsExpiration: 30 * 86_400, adminEventsEnabled: true }),
      { logId: 'audit_log', kind: 'audit_trail', enabled: true, retentionDays: 'forever' }]);
    expect(short.findings).toEqual([expect.objectContaining({ logId: 'r:sign-in-events', flag: 'kept_less_than_a_year' })]);
  });

  it('a realm with events on and no expiry keeps them for ever', () => {
    expect(realmSecurityLogs('r', { eventsEnabled: true })[0]?.retentionDays).toBe('forever');
  });
});
