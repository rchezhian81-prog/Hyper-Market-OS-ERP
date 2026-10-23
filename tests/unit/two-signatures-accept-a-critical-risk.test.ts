import { describe, it, expect } from 'vitest';
import { judgeAcceptanceSignature, acceptanceSignatures, needsTwoSignatures, type Risk, type SecurityReviewer, type RiskAcceptanceSignature } from '../../packages/compliance/src/index';

// OB-330 · §35.1: the two-signature rule for accepting a critical or high risk. Pure.

const risk = (over: Partial<Risk> = {}): Risk => ({ riskId: 'R1', title: 'unpatched edge OS', severity: 'critical', status: 'open', controlIds: [], ownerUserId: 'u-sec', blocksGates: ['QG-06'], ...over });
const reviewer: SecurityReviewer = { userId: 'u-rev', displayName: 'R. Reviewer', namedBy: 'u-owner', namedAt: '2026-10-23T05:00:00Z', reason: 'pilot' };
const sign = (as: 'owner' | 'security_reviewer', signer: string, prior: readonly RiskAcceptanceSignature[] = [], over: { risk?: Risk; reviewer?: SecurityReviewer | undefined; isOwner?: boolean } = {}) =>
  judgeAcceptanceSignature({ risk: over.risk ?? risk(), as, signer, signerIsOwner: over.isOwner ?? signer.startsWith('u-owner'), rationale: 'carried with controls', reviewer: 'reviewer' in over ? over.reviewer : reviewer, prior, at: '2026-10-23T06:00:00Z' });

describe('two signatures accept a critical or high risk (OB-330)', () => {
  it('critical and high need two; medium and low do not', () => {
    expect(['critical', 'high', 'medium', 'low'].map((severity) => needsTwoSignatures({ severity: severity as Risk['severity'] }))).toEqual([true, true, false, false]);
  });

  it('with no reviewer named nothing critical or high is accepted — it must be fixed', () => {
    expect(sign('owner', 'u-owner', [], { reviewer: undefined })).toMatchObject({ ok: false, refusal: 'must_be_fixed_no_security_reviewer' });
    expect(acceptanceSignatures(risk(), [], undefined)).toMatchObject({ needsTwo: true, mustBeFixed: true, owner: null, securityReviewer: null });
  });

  it('the owner\'s signature is an owner\'s; the reviewer\'s the named reviewer\'s; one person never gives both', () => {
    expect(sign('owner', 'u-mgr')).toMatchObject({ ok: false, refusal: 'owner_signs_as_owner' });
    expect(sign('security_reviewer', 'u-mgr')).toMatchObject({ ok: false, refusal: 'not_the_named_security_reviewer' });
    const first = sign('owner', 'u-owner');
    expect(first).toMatchObject({ ok: true, waitingFor: 'security_reviewer' });
    if (!first.ok) return;
    expect(first.accepted).toBeUndefined();
    // A reviewer who is also an owner cannot give the second signature after giving the first.
    expect(sign('security_reviewer', 'u-owner', [first.signature], { reviewer: { ...reviewer, userId: 'u-owner' } })).toMatchObject({ ok: false, refusal: 'one_person_cannot_sign_twice' });
    const second = sign('security_reviewer', 'u-rev', [first.signature]);
    expect(second.ok && second.accepted).toMatchObject({ status: 'accepted', acceptedBy: 'u-owner', acceptanceRationale: 'carried with controls', securityReviewedBy: 'u-rev' });
  });

  it('a signature counts for the risk as it stood, and from the reviewer named now', () => {
    const rev = sign('security_reviewer', 'u-rev');
    if (!rev.ok) throw new Error('refused');
    // The risk re-stated: the reviewer's signature no longer counts; the owner's is the first again.
    expect(sign('owner', 'u-owner', [rev.signature], { risk: risk({ title: 'wider exposure' }) })).toMatchObject({ ok: true, waitingFor: 'security_reviewer' });
    // A different reviewer named since: the old reviewer's signature no longer counts.
    expect(sign('owner', 'u-owner', [rev.signature], { reviewer: { ...reviewer, userId: 'u-rev2' } })).toMatchObject({ ok: true, waitingFor: 'security_reviewer' });
    expect(sign('owner', 'u-owner', [rev.signature])).toMatchObject({ ok: true, accepted: { status: 'accepted' } });
    expect(sign('owner', 'u-owner', [], { risk: risk({ status: 'accepted' }) })).toMatchObject({ ok: false, refusal: 'risk_not_open' });
    expect(sign('owner', 'u-owner', [], { risk: risk({ severity: 'medium' }) })).toMatchObject({ ok: false, refusal: 'not_a_two_signature_risk' });
  });
});
