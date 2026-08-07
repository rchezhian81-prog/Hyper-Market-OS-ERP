import { describe, it, expect } from 'vitest';
import {
  proposeExclusion, approveExclusion, exclusionPosition, assessRetirement,
  type HistoryExclusion, type LegacyArchive,
} from '../../packages/migration/src/history';
import * as history from '../../packages/migration/src/history';

// MG-07 / MG-12 — two steps about the same question: what is kept, and who said so.

const propose = (over: Partial<Parameters<typeof proposeExclusion>[0]> = {}) => proposeExclusion({
  exclusionId: 'exc-1', tenantId: 't-sre', scope: 'documents_before',
  description: 'Sales documents dated before 1 April 2020',
  recordCount: 18_400, valueMinor: 1_240_000,
  reason: 'the rates were revised in 2020 and restating them would rewrite filed returns',
  proposedBy: 'u-operator', now: '2026-08-06T09:00:00Z', ...over,
});

const proposed = (): HistoryExclusion => propose().exclusion!;

describe('an exclusion is a written owner decision, not a config cutoff', () => {
  it('accepts a proposal whose reason is about usability', () => {
    const r = propose();
    expect(r.ok).toBe(true);
    expect(r.exclusion?.status).toBe('proposed');
  });

  it('REFUSES age as the sole reason — the one offered ninety per cent of the time', () => {
    for (const reason of ['too old', 'before 2019', 'older than 5 years', 'legacy', 'historical', 'not needed']) {
      const r = propose({ reason });
      expect(r.ok, reason).toBe(false);
      expect(r.refusedBecause).toBe('age_alone');
    }
    expect(propose({ reason: 'too old' }).detail).toContain('a warranty claim in year four');
  });

  it('refuses an unreasoned proposal and one covering nothing', () => {
    expect(propose({ reason: '   ' }).refusedBecause).toBe('no_reason');
    expect(propose({ recordCount: 0 }).refusedBecause).toBe('nothing_excluded');
  });

  it('requires the money, so the exclusion can be reconciled against', () => {
    expect(propose({ valueMinor: Number.NaN }).refusedBecause).toBe('no_value_stated');
  });
});

describe('only the owner approves, and never their own proposal', () => {
  const approve = (over: Partial<Parameters<typeof approveExclusion>[0]> = {}) => approveExclusion({
    exclusion: proposed(), decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
    ownerStatement: 'agreed — the CA confirmed the returns for those years are filed and closed',
    now: '2026-08-06T18:00:00Z', ...over,
  });

  it('approves with a written statement', () => {
    const r = approve();
    expect(r.ok).toBe(true);
    expect(r.exclusion?.status).toBe('approved');
    expect(r.detail).toContain('the reconciliation must account for exactly that figure');
  });

  it('REFUSES a manager approving an exclusion (OD-05)', () => {
    const r = approve({ decidedBy: 'u-manager', decidedByIsOwner: false });
    expect(r.refusedBecause).toBe('not_the_owner');
    expect(r.detail).toContain('OWNER approval');
  });

  it('REFUSES the proposer approving their own proposal, even as the owner', () => {
    const own = propose({ proposedBy: 'u-owner' }).exclusion!;
    const r = approveExclusion({
      exclusion: own, decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
      ownerStatement: 'yes', now: '2026-08-06T18:00:00Z',
    });
    expect(r.refusedBecause).toBe('proposer_cannot_approve');
    expect(r.detail).toContain('is not the person to confirm it');
  });

  it('refuses an unwritten decision and a re-decision', () => {
    expect(approve({ ownerStatement: '  ' }).refusedBecause).toBe('no_statement');
    const once = approve().exclusion!;
    expect(approveExclusion({ exclusion: once, decidedBy: 'u-owner', decidedByIsOwner: true, approve: true, ownerStatement: 'again', now: 'n' }).refusedBecause).toBe('not_proposed');
  });

  it('records a rejection as clearly as an approval — the records are migrated', () => {
    const r = approve({ approve: false, ownerStatement: 'no — I want the history for warranty claims' });
    expect(r.exclusion?.status).toBe('rejected');
    expect(r.detail).toContain('the records are migrated');
  });
});

describe('only an APPROVED exclusion may explain a control-total difference', () => {
  const approvedOne = approveExclusion({
    exclusion: proposed(), decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
    ownerStatement: 'agreed', now: '2026-08-06T18:00:00Z',
  }).exclusion!;
  const pending = propose({ exclusionId: 'exc-2', valueMinor: 800_000, recordCount: 3_100 }).exclusion!;

  it('sums approved and undecided separately', () => {
    const p = exclusionPosition([approvedOne, pending]);
    expect(p.approvedValueMinor).toBe(1_240_000);
    expect(p.approvedRecords).toBe(18_400);
    expect(p.undecidedValueMinor).toBe(800_000);
  });

  it('says plainly that an undecided exclusion explains NOTHING', () => {
    const p = exclusionPosition([approvedOne, pending]);
    expect(p.detail).toContain('until decided they explain nothing');
  });

  it('excludes a rejected exclusion from both figures', () => {
    const rejected = approveExclusion({
      exclusion: propose({ exclusionId: 'exc-3', valueMinor: 500_000 }).exclusion!,
      decidedBy: 'u-owner', decidedByIsOwner: true, approve: false,
      ownerStatement: 'migrate them', now: 'n',
    }).exclusion!;
    const p = exclusionPosition([approvedOne, rejected]);
    expect(p.approvedValueMinor).toBe(1_240_000);
    expect(p.undecidedValueMinor).toBe(0);
  });
});

describe('retiring the legacy SYSTEM never destroys the legacy DATA', () => {
  const archive = (over: Partial<LegacyArchive> = {}): LegacyArchive => ({
    archiveId: 'arc-1', tenantId: 't-sre', sourceId: 'src-erp', digest: 'abc123', rowCount: 41_200,
    archivedAt: '2026-09-01T00:00:00Z', retentionYears: 8,
    earliestRecordDate: '2011-04-01', latestRecordDate: '2026-08-31',
    readOnly: true, restoreVerifiedAt: '2026-09-02T10:00:00Z', ...over,
  });

  it('computes retention from the LATEST RECORD, not the archive date', () => {
    const r = assessRetirement({ archive: archive(), cutoverAccepted: true, openAssessments: 0, today: '2030-01-01' });
    expect(r.retentionEndsOn).toBe('2034-08-31');
    expect(r.mayRetireSystem).toBe(false);
    expect(r.blockedBy).toContain('retention_not_elapsed');
  });

  it('permits retirement once retention has elapsed and everything else is settled', () => {
    const r = assessRetirement({ archive: archive(), cutoverAccepted: true, openAssessments: 0, today: '2034-09-01' });
    expect(r.mayRetireSystem).toBe(true);
    expect(r.detail).toContain('never deleted');
  });

  it('BLOCKS on an archive whose restore was never demonstrated', () => {
    const r = assessRetirement({
      archive: archive({ restoreVerifiedAt: undefined }), cutoverAccepted: true,
      openAssessments: 0, today: '2034-09-01',
    });
    expect(r.blockedBy).toContain('restore_never_verified');
    expect(r.detail).toContain('an untested archive is a hope');
  });

  it('names every blocker at once, not the first', () => {
    const r = assessRetirement({
      archive: archive({ restoreVerifiedAt: undefined }), cutoverAccepted: false,
      openAssessments: 2, today: '2027-01-01',
    });
    expect([...r.blockedBy].sort()).toEqual(['cutover_not_accepted', 'open_assessment', 'restore_never_verified', 'retention_not_elapsed']);
  });

  it('states that the data is never deleted, as a typed literal rather than a promise', () => {
    // The two acts get conflated constantly: the licence renewal is the pressure, switching the
    // server off is the action, and deleting the archive is what quietly happens alongside it.
    const r = assessRetirement({ archive: archive(), cutoverAccepted: true, openAssessments: 0, today: '2034-09-01' });
    const dataIsNeverDeleted: true = r.dataIsNeverDeleted;
    expect(dataIsNeverDeleted).toBe(true);
  });

  it('exposes no function that deletes or rewrites an archive (hard rule #6)', () => {
    const names = Object.keys(history);
    for (const forbidden of ['deleteArchive', 'purgeArchive', 'destroyArchive', 'editArchive', 'retireData']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
