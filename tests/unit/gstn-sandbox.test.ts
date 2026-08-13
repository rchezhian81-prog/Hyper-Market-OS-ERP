import { describe, it, expect } from 'vitest';
import { sandboxGstnProvider, sandboxArn, type GstnReturnRequest } from '../../packages/finance/src/index';

const REQ: GstnReturnRequest = { gstin: '33ABCDE1234F1Z5', period: '082026', returnType: 'GSTR1', returnDigest: 'sha256:abc' };

describe('sandboxGstnProvider — deterministic, unmistakably non-fileable', () => {
  it('acknowledges the first filing with a SANDBOX- ARN, deterministically', () => {
    const p = sandboxGstnProvider();
    const r = p.submit(REQ);
    expect(r.status).toBe('acknowledged');
    expect(r.arn).toBe(sandboxArn(REQ));
    expect(r.arn?.startsWith('SANDBOX-')).toBe(true);
    // Same request → same ARN (idempotent/deterministic), on a fresh provider.
    expect(sandboxGstnProvider().submit(REQ).arn).toBe(r.arn);
  });

  it('rejects a duplicate filing of the same period', () => {
    const p = sandboxGstnProvider();
    expect(p.submit(REQ).status).toBe('acknowledged');
    const dup = p.submit(REQ);
    expect(dup.status).toBe('failed');
    expect(dup.errorCode).toBe('DUPLICATE_RETURN');
    expect(dup.errorClass).toBe('duplicate');
  });

  it('forces the failed and unknown branches for testing the recovery paths', () => {
    const failed = sandboxGstnProvider({ forceOutcome: 'failed', failCode: 'AUTH_TOKEN_EXPIRED' }).submit(REQ);
    expect(failed.status).toBe('failed');
    expect(failed.errorClass).toBe('auth'); // classified from the code
    const unknown = sandboxGstnProvider({ forceOutcome: 'unknown' }).submit(REQ);
    expect(unknown.status).toBe('unknown');
    expect(unknown.arn).toBeUndefined();
  });
});
