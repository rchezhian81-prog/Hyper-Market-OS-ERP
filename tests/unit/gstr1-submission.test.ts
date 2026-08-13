import { describe, it, expect } from 'vitest';
import {
  foldGstr1Submission,
  evaluateGstr1SubmissionTransition,
  classifyGstnError,
  InvalidGstr1Submission,
  assertFilingPeriod,
  type Gstr1SubmissionEvent,
} from '../../packages/finance/src/index';

const DIGEST = 'sha256:abc123';
const previewed: Gstr1SubmissionEvent = { kind: 'previewed', period: '082026', returnDigest: DIGEST, by: 'maker', at: '2026-09-01T10:00:00Z', summary: 'B2C ₹1,80,000' };
const approved: Gstr1SubmissionEvent = { kind: 'approved', by: 'checker', at: '2026-09-01T10:05:00Z' };
const submitted: Gstr1SubmissionEvent = { kind: 'submitted', by: 'checker', at: '2026-09-01T10:10:00Z' };

const fold = (events: Gstr1SubmissionEvent[]) => foldGstr1Submission('082026', events);

describe('foldGstr1Submission — the safe submission lifecycle', () => {
  it('folds preview → approve → submit → acknowledge into filed', () => {
    const agg = fold([previewed, approved, submitted, { kind: 'acknowledged', arn: 'AA0826000001', at: '2026-09-01T10:12:00Z' }]);
    expect(agg?.state).toBe('filed');
    expect(agg?.arn).toBe('AA0826000001');
    expect(agg?.previewedBy).toBe('maker');
    expect(agg?.approvedBy).toBe('checker');
  });

  it('ignores a self-approval (maker ≠ checker) on the fold', () => {
    const agg = fold([previewed, { kind: 'approved', by: 'maker', at: '2026-09-01T10:05:00Z' }]);
    expect(agg?.state).toBe('previewed'); // the self-approval was not applied
    expect(agg?.approvedBy).toBeUndefined();
  });

  it('is replay-safe — a re-posted acknowledgement on a filed return is ignored', () => {
    const base: Gstr1SubmissionEvent[] = [previewed, approved, submitted, { kind: 'acknowledged', arn: 'AA1', at: '2026-09-01T10:12:00Z' }];
    const withDup = fold([...base, { kind: 'acknowledged', arn: 'AA2', at: '2026-09-01T10:20:00Z' }]);
    expect(withDup?.state).toBe('filed');
    expect(withDup?.arn).toBe('AA1'); // the first ack stands; the duplicate did not overwrite it
  });

  it('routes an unknown response to reconciliation, never straight to filed', () => {
    const unknown = fold([previewed, approved, submitted, { kind: 'unknownResponse', detail: 'gateway timeout', at: '2026-09-01T10:12:00Z' }]);
    expect(unknown?.state).toBe('unknown');
    const reconciled = fold([previewed, approved, submitted,
      { kind: 'unknownResponse', detail: 'gateway timeout', at: '2026-09-01T10:12:00Z' },
      { kind: 'reconciled', resolvedState: 'filed', by: 'operator', note: 'found ARN on portal', arn: 'AA9', at: '2026-09-01T11:00:00Z' }]);
    expect(reconciled?.state).toBe('filed');
    expect(reconciled?.arn).toBe('AA9');
  });

  it('lets a failed return be re-previewed and re-filed, keeping the failure in history', () => {
    const events: Gstr1SubmissionEvent[] = [previewed, approved, submitted,
      { kind: 'failed', errorCode: 'RET_VALIDATION_09', errorClass: 'validation', at: '2026-09-01T10:12:00Z' },
      { kind: 'previewed', period: '082026', returnDigest: 'sha256:def456', by: 'maker', at: '2026-09-01T12:00:00Z' }];
    const agg = fold(events);
    expect(agg?.state).toBe('previewed');
    expect(agg?.returnDigest).toBe('sha256:def456');
  });
});

describe('evaluateGstr1SubmissionTransition — the safety guards', () => {
  const cur = (events: Gstr1SubmissionEvent[]) => fold(events);

  it('refuses a self-approval', () => {
    const d = evaluateGstr1SubmissionTransition({ current: cur([previewed]), action: 'approve', actor: 'maker' });
    expect(d).toMatchObject({ allowed: false, refusal: 'self_approval' });
  });

  it('prevents a duplicate submission (already filed) and an in-flight second submit', () => {
    const filed = cur([previewed, approved, submitted, { kind: 'acknowledged', arn: 'AA1', at: '2026-09-01T10:12:00Z' }]);
    expect(evaluateGstr1SubmissionTransition({ current: filed, action: 'submit', actor: 'checker' })).toMatchObject({ allowed: false, refusal: 'already_filed' });
    const inFlight = cur([previewed, approved, submitted]);
    expect(evaluateGstr1SubmissionTransition({ current: inFlight, action: 'submit', actor: 'checker' })).toMatchObject({ allowed: false, refusal: 'in_flight' });
    // A new preview is also refused while filed/in-flight.
    expect(evaluateGstr1SubmissionTransition({ current: filed, action: 'preview', actor: 'maker', period: '082026' })).toMatchObject({ allowed: false, refusal: 'already_filed' });
  });

  it('refuses to submit figures that changed since approval (digest mismatch)', () => {
    const approvedAgg = cur([previewed, approved]);
    expect(evaluateGstr1SubmissionTransition({ current: approvedAgg, action: 'submit', actor: 'checker', digest: 'sha256:CHANGED' }))
      .toMatchObject({ allowed: false, refusal: 'digest_mismatch' });
    expect(evaluateGstr1SubmissionTransition({ current: approvedAgg, action: 'submit', actor: 'checker', digest: DIGEST }))
      .toMatchObject({ allowed: true, resultingState: 'submitting' });
  });

  it('needs a period to preview, and evidence to reconcile', () => {
    expect(evaluateGstr1SubmissionTransition({ action: 'preview', actor: 'maker' })).toMatchObject({ allowed: false, refusal: 'invalid_period' });
    expect(evaluateGstr1SubmissionTransition({ action: 'preview', actor: 'maker', period: '082026' })).toMatchObject({ allowed: true, resultingState: 'previewed' });
    const unknown = cur([previewed, approved, submitted, { kind: 'unknownResponse', detail: 't/o', at: '2026-09-01T10:12:00Z' }]);
    expect(evaluateGstr1SubmissionTransition({ current: unknown, action: 'reconcile', actor: 'operator' })).toMatchObject({ allowed: false, refusal: 'reason_required' });
    expect(evaluateGstr1SubmissionTransition({ current: unknown, action: 'reconcile', actor: 'operator', note: 'found on portal' })).toMatchObject({ allowed: true });
  });

  it('refuses any action before a preview exists', () => {
    expect(evaluateGstr1SubmissionTransition({ action: 'submit', actor: 'x' })).toMatchObject({ allowed: false, refusal: 'no_submission' });
  });
});

describe('classifyGstnError — recovery class for operators', () => {
  it('maps portal codes to a recovery class, conservatively', () => {
    expect(classifyGstnError('AUTH_TOKEN_EXPIRED')).toBe('auth');
    expect(classifyGstnError('DUPLICATE_RETURN')).toBe('duplicate');
    expect(classifyGstnError('RATE_LIMIT_429')).toBe('rate_limit');
    expect(classifyGstnError('GATEWAY_TIMEOUT')).toBe('timeout');
    expect(classifyGstnError('SERVICE_UNAVAILABLE')).toBe('portal_outage');
    expect(classifyGstnError('RET_VALIDATION_ERROR')).toBe('validation');
    expect(classifyGstnError('something-nobody-mapped')).toBe('unknown');
    expect(classifyGstnError('')).toBe('unknown');
  });
});

describe('assertFilingPeriod', () => {
  it('accepts MMYYYY and rejects anything else', () => {
    expect(() => assertFilingPeriod('082026')).not.toThrow();
    expect(() => assertFilingPeriod('2026-08')).toThrow(InvalidGstr1Submission);
    expect(() => assertFilingPeriod('8/2026')).toThrow(InvalidGstr1Submission);
  });
});
