import { describe, it, expect } from 'vitest';
import {
  currentNominee, nominationAction, mayNomineeAct, overdueRequests, PUBLISHED_RESPONSE_SLA_DAYS, publishedSlaStatement, RIGHT_KINDS,
  type NomineeRecord, type NomineeActivation, type DataSubjectRequest,
} from '../../packages/customer/src/index';

/**
 * R3 · C5 — the pure rules (DPDP s.13–14 · OB-146 "B": 15 days). A nominee is recorded, changed and withdrawn as new
 * records; the latest stands. The nominee acts only after a verified death or incapacity naming them. A grievance is a
 * request kind; an overdue one surfaces like any other.
 */

const rec = (action: NomineeRecord['action'], nomineeRef: string | null, at: string, customerRef = 'c1'): NomineeRecord =>
  ({ customerRef, action, nomineeRef, relationship: nomineeRef === null ? null : 'spouse', by: customerRef, at });

describe('the nominee', () => {
  it('the latest record stands; a withdrawal leaves none; another customer\'s is not mine', () => {
    const records = [rec('recorded', 'N-1', '2026-10-01T00:00:00Z'), rec('changed', 'N-2', '2026-10-02T00:00:00Z'), rec('recorded', 'N-9', '2026-10-02T00:00:00Z', 'c2')];
    expect(currentNominee(records, 'c1')).toEqual({ nomineeRef: 'N-2', relationship: 'spouse', since: '2026-10-02T00:00:00Z' });
    expect(nominationAction(records, 'c1')).toBe('changed');
    const withdrawn = [...records, rec('withdrawn', null, '2026-10-03T00:00:00Z')];
    expect(currentNominee(withdrawn, 'c1')).toBeNull();
    expect(nominationAction(withdrawn, 'c1')).toBe('recorded');
    expect(currentNominee(withdrawn, 'c2')!.nomineeRef).toBe('N-9');
    expect(currentNominee([], 'c3')).toBeNull();
  });

  it('acts only once a death or incapacity naming THIS nominee is verified', () => {
    const records = [rec('recorded', 'N-1', '2026-10-01T00:00:00Z')];
    const activation: NomineeActivation = { activationId: 'A-1', customerRef: 'c1', nomineeRef: 'N-1', basis: 'incapacity', evidenceRef: 'MED-1', verifiedBy: 'u-dpo', verifiedAt: '2026-10-05T00:00:00Z' };
    expect(mayNomineeAct({ records, activations: [], customerRef: 'c1', nomineeRef: 'N-1' })).toMatchObject({ ok: false, reason: 'not_verified' });
    expect(mayNomineeAct({ records, activations: [activation], customerRef: 'c1', nomineeRef: 'N-2' })).toMatchObject({ ok: false, reason: 'not_the_nominee' });
    expect(mayNomineeAct({ records: [], activations: [activation], customerRef: 'c1', nomineeRef: 'N-1' })).toMatchObject({ ok: false, reason: 'no_nominee' });
    expect(mayNomineeAct({ records, activations: [activation], customerRef: 'c1', nomineeRef: 'N-1' })).toMatchObject({ ok: true, activation: { activationId: 'A-1' } });
    // A verification for an earlier nominee does not carry over to a new one.
    const changed = [...records, rec('changed', 'N-3', '2026-10-06T00:00:00Z')];
    expect(mayNomineeAct({ records: changed, activations: [activation], customerRef: 'c1', nomineeRef: 'N-3' })).toMatchObject({ ok: false, reason: 'not_verified' });
  });
});

describe('the published answer-by time and the grievance', () => {
  it('is 15 days, said in words, and a grievance is a request kind', () => {
    expect(PUBLISHED_RESPONSE_SLA_DAYS).toBe(15);
    expect(publishedSlaStatement()).toBe('We answer every privacy request and every complaint about your data within 15 days of receiving it.');
    expect(RIGHT_KINDS).toContain('grievance');
  });

  it('an overdue grievance surfaces like any other overdue request', () => {
    const g: DataSubjectRequest = { requestId: 'G1', tenantId: 't', customerRef: 'c1', kind: 'grievance', raisedAt: '2026-10-01T09:00:00Z', state: 'raised', dueBy: '2026-10-16' };
    expect(overdueRequests([g], '2026-10-16')).toEqual([]);
    expect(overdueRequests([g], '2026-10-17')).toEqual([expect.objectContaining({ requestId: 'G1', kind: 'grievance', daysOverdue: 1 })]);
  });
});
