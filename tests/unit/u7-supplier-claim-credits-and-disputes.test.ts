import { describe, it, expect } from 'vitest';
import { creditDrafts, approvedClaimCredits, claimDisputes, type ClaimCreditDecision, type SupplierRaisedClaim } from '../../services/purchase/src/supplier-claims';
import { planPayablesPostings, type PayablesAccount } from '../../packages/finance/src/index';

/**
 * U7 · OB-725 · M24-FR-02 alt — the pure reads behind the supplier-claims register: an accepted claim with a value is a draft
 * credit; only the FIRST decision per credit stands and only an approved one is a fact; a rejected claim is a dispute that
 * reads overdue once the shop day after the one it was raised on has begun; an approved credit posts once.
 */
const claim = (submissionId: string, state: SupplierRaisedClaim['state'], claimMinor: number | null, extra: Partial<SupplierRaisedClaim> = {}): SupplierRaisedClaim => ({
  supplierId: 's-1', submissionId, poId: 'po', claimMinor, why: 'freight', receivedAt: '2026-11-12T04:00:00.000Z', submittedBy: 'u-sup',
  state, decidedBy: state === 'awaiting_buyer' ? null : 'u-buyer', decidedAt: state === 'awaiting_buyer' ? null : '2026-11-12T05:00:00.000Z',
  reason: state === 'awaiting_buyer' ? null : 'checked', ...extra,
} as SupplierRaisedClaim);
const decision = (creditId: string, d: 'approved' | 'refused', by = 'u-acct', at = '2026-11-12T06:00:00.000Z'): ClaimCreditDecision => ({
  creditId, supplierId: 's-1', submissionId: creditId.slice(4), decision: d, amountMinor: 1_500, why: 'freight', acceptedBy: 'u-buyer', decidedBy: by, decidedAt: at, reason: 'r',
});

describe('U7 · supplier claim credits and disputes (pure)', () => {
  it('only an accepted claim with a value is a draft; awaiting, rejected, valueless are not', () => {
    const drafts = creditDrafts([claim('a', 'accepted', 1_500), claim('b', 'awaiting_buyer', 900), claim('c', 'rejected', 700), claim('d', 'accepted', null), claim('e', 'accepted', 0)], []);
    expect(drafts.map((d) => [d.creditId, d.state, d.acceptedBy])).toEqual([['SCC-a', 'draft', 'u-buyer']]);
  });

  it('the first decision stands; only an approved one becomes a credit fact', () => {
    const ds = [decision('SCC-a', 'approved'), decision('SCC-a', 'refused', 'u-other'), decision('SCC-b', 'refused')];
    expect(creditDrafts([claim('a', 'accepted', 1_500)], ds)[0]).toMatchObject({ state: 'approved', decision: { decidedBy: 'u-acct' } });
    expect(approvedClaimCredits(ds).map((c) => [c.creditId, c.amountMinor, c.approvedBy])).toEqual([['SCC-a', 1_500, 'u-acct']]);
  });

  it('a rejected claim is an open dispute owned by the rejecter; overdue only after its shop day; resolved never overdue', () => {
    const day = (iso: string) => iso.slice(0, 10); // a stand-in shop day for the pure test
    const c = [claim('r', 'rejected', 2_000, { reason: 'paid in full' } as Partial<SupplierRaisedClaim>), claim('a', 'accepted', 1_500)];
    expect(claimDisputes(c, [], day, '2026-11-12')).toEqual([expect.objectContaining({ exceptionId: 'DSP-r', valueMinor: 2_000, rejectedBecause: 'paid in full', ownerUserId: 'u-buyer', raisedOn: '2026-11-12', state: 'open', overdue: false })]);
    expect(claimDisputes(c, [], day, '2026-11-13')[0]).toMatchObject({ state: 'open', overdue: true });
    const settled = claimDisputes(c, [{ exceptionId: 'DSP-r', supplierId: 's-1', submissionId: 'r', outcome: 'supplier_withdrew', reason: 'ok', by: 'u-buyer', at: '2026-11-13T05:00:00.000Z' }], day, '2026-11-20');
    expect(settled[0]).toMatchObject({ state: 'resolved', overdue: false, resolution: { outcome: 'supplier_withdrew' } });
  });

  it('an approved credit plans one payables posting on its approval day; once posted, nothing more', () => {
    const account: PayablesAccount = { supplierId: 's-1', invoices: [], debitNotes: [], payments: [], claimCredits: [{ creditId: 'SCC-a', amountMinor: 1_500, approvedAt: '2026-11-12T06:00:00.000Z' }] };
    const planned = planPayablesPostings([account], [], (iso) => iso.slice(0, 10));
    expect(planned).toEqual([expect.objectContaining({ kind: 'supplier_claim_credit', sourceId: 'SCC-a', documentDate: '2026-11-12', components: { amount: 1_500 } })]);
    const posted = [{ kind: 'supplier_claim_credit' as const, sourceKind: 'supplier_claim_credit' as const, sourceId: 'SCC-a', supplierId: 's-1', components: { amount: 1_500 }, lines: [] }];
    expect(planPayablesPostings([account], posted as never, (iso) => iso.slice(0, 10))).toEqual([]);
  });
});
