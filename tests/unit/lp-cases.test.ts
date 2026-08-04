import { describe, it, expect } from 'vitest';
import * as caseModule from '../../packages/loss-prevention/src/cases';
import {
  openCase,
  addEvidence,
  verifyEvidence,
  closeCase,
  ruleFeedback,
  sealOf,
  type InvestigationCase,
  type EvidenceItem,
} from '../../packages/loss-prevention/src/cases';

// M15-FR-04 acceptance: "case evidence CANNOT BE EDITED OR DELETED; a closed case has
// a recorded outcome; outcomes MEASURABLY ADJUST THE RULES that raised them."

function opened(): InvestigationCase {
  const r = openCase({
    caseId: 'CASE-1',
    tenantId: 't-1',
    raisedFromRef: 'lp-void-rule:EX-4471',
    subjectRef: 'u-cashier-7',
    summary: 'repeated post-tender voids on lane 3, ₹18,400 over eleven days',
    valueMinor: 1_840_000,
    openedBy: 'u-manager',
    assignedTo: 'u-security',
    at: '2026-08-04T09:00:00Z',
  });
  if (!r.case) throw new Error('unreachable');
  return r.case;
}

const CLIP: Omit<EvidenceItem, 'seal'> = {
  evidenceId: 'ev-1',
  kind: 'cctv_reference',
  ref: 'cctv/2026-08-01/lane-3/1815.mp4',
  description: 'lane 3, 18:15, the void at 18:16:40',
  collectedBy: 'u-security',
  collectedAt: '2026-08-04T10:00:00Z',
  collectedFrom: 'store DVR, channel 3',
};

describe('opening a case (M15-FR-04)', () => {
  it('opens from a raised exception, with a named investigator', () => {
    const c = opened();
    expect(c.state).toBe('open');
    expect(c.assignedTo).toBe('u-security');
    expect(c.evidence).toEqual([]);
  });

  it('refuses a case that comes from nowhere', () => {
    const r = openCase({
      caseId: 'CASE-2', tenantId: 't-1', raisedFromRef: '  ', subjectRef: 'u-7',
      summary: 'a feeling', valueMinor: 0, openedBy: 'u-m', assignedTo: 'u-s', at: '2026-08-04T09:00:00Z',
    });
    expect(r.opened).toBe(false);
    expect(r.detail).toContain('has nothing to check against');
  });

  it('refuses an unnamed investigator and an empty summary', () => {
    const noOne = openCase({
      caseId: 'C', tenantId: 't', raisedFromRef: 'r', subjectRef: 'u-7',
      summary: 's', valueMinor: 0, openedBy: 'u-m', assignedTo: '', at: '2026-08-04T09:00:00Z',
    });
    expect(noOne.opened).toBe(false);
    const noSummary = openCase({
      caseId: 'C', tenantId: 't', raisedFromRef: 'r', subjectRef: 'u-7',
      summary: '  ', valueMinor: 0, openedBy: 'u-m', assignedTo: 'u-s', at: '2026-08-04T09:00:00Z',
    });
    expect(noSummary.opened).toBe(false);
  });

  it('refuses to let the subject investigate their own case', () => {
    const r = openCase({
      caseId: 'C', tenantId: 't', raisedFromRef: 'r', subjectRef: 'u-7',
      summary: 's', valueMinor: 0, openedBy: 'u-m', assignedTo: 'u-7', at: '2026-08-04T09:00:00Z',
    });
    expect(r.opened).toBe(false);
    expect(r.detail).toContain('cannot investigate it');
  });
});

describe('evidence is append-only and sealed (hard rule #6)', () => {
  it('EXPORTS NO WAY TO EDIT OR DELETE EVIDENCE — the absence is the control', () => {
    const api = Object.keys(caseModule);
    expect(api.filter((n) => /remove|delete|edit|update|clear|purge/i.test(n))).toEqual([]);
    expect(api).toContain('addEvidence');
    expect(api).toContain('verifyEvidence');
  });

  it('appends without touching what is already there', () => {
    const first = addEvidence(opened(), CLIP);
    const second = addEvidence(first.case, {
      ...CLIP,
      evidenceId: 'ev-2',
      kind: 'witness_statement',
      ref: 'stmt/2026-08-04/priya.pdf',
      description: 'supervisor saw no customer at the lane',
    });
    expect(second.case.evidence).toHaveLength(2);
    // Item one is byte-for-byte what it was.
    expect(second.case.evidence[0]).toEqual(first.case.evidence[0]);
  });

  it('refuses evidence with no chain of custody', () => {
    const noCollector = addEvidence(opened(), { ...CLIP, collectedBy: '  ' });
    expect(noCollector.added).toBe(false);
    expect(noCollector.detail).toContain('material, not evidence');

    const noSource = addEvidence(opened(), { ...CLIP, collectedFrom: '' });
    expect(noSource.added).toBe(false);
  });

  it('refuses the same evidence id twice', () => {
    const one = addEvidence(opened(), CLIP);
    expect(addEvidence(one.case, CLIP).added).toBe(false);
  });

  it('refuses to add evidence to a closed case', () => {
    const one = addEvidence(opened(), CLIP);
    const closed = closeCase({
      case: one.case, outcome: 'unfounded', note: 'customer was present; the void was genuine',
      closedBy: 'u-manager', at: '2026-08-06T09:00:00Z',
    });
    const late = addEvidence(closed.case, { ...CLIP, evidenceId: 'ev-late' });
    expect(late.added).toBe(false);
    expect(late.detail).toContain('reopens it as a new case');
  });

  it('DETECTS AN EDIT made straight in the database, behind the code', () => {
    const one = addEvidence(opened(), CLIP);
    const two = addEvidence(one.case, { ...CLIP, evidenceId: 'ev-2', description: 'second angle' });
    expect(verifyEvidence(two.case).intact).toBe(true);

    // Someone changes what the clip is said to show, keeping the seal.
    const tampered: InvestigationCase = {
      ...two.case,
      evidence: [
        { ...two.case.evidence[0]!, description: 'nothing visible' },
        two.case.evidence[1]!,
      ],
    };
    const check = verifyEvidence(tampered);
    expect(check.intact).toBe(false);
    expect(check.breaks[0]?.evidenceId).toBe('ev-1');
    expect(check.breaks[0]?.detail).toContain('altered, or one before it was removed');
  });

  it('DETECTS A REMOVAL from the middle', () => {
    let c = opened();
    for (let i = 1; i <= 3; i += 1) {
      c = addEvidence(c, { ...CLIP, evidenceId: `ev-${i}`, description: `item ${i}` }).case;
    }
    expect(verifyEvidence(c).intact).toBe(true);

    const gapped: InvestigationCase = { ...c, evidence: [c.evidence[0]!, c.evidence[2]!] };
    expect(verifyEvidence(gapped).intact).toBe(false);
  });

  it('reports EVERY break, not just the first', () => {
    let c = opened();
    for (let i = 1; i <= 4; i += 1) {
      c = addEvidence(c, { ...CLIP, evidenceId: `ev-${i}`, description: `item ${i}` }).case;
    }
    const doubled: InvestigationCase = {
      ...c,
      evidence: c.evidence.map((e, i) => (i === 1 || i === 3 ? { ...e, description: 'changed' } : e)),
    };
    const check = verifyEvidence(doubled);
    expect(check.breaks.map((b) => b.evidenceId)).toEqual(['ev-2', 'ev-4']);
  });

  it('seals each item to the one before it, so order is part of the record', () => {
    const a = sealOf('0000000000000000', CLIP);
    const b = sealOf('ffffffffffffffff', CLIP);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(16);
  });
});

describe('a case closes only with an outcome', () => {
  it('needs a note saying what was found', () => {
    const c = addEvidence(opened(), CLIP).case;
    expect(closeCase({ case: c, outcome: 'proven', note: '  ', closedBy: 'u-manager', at: '2026-08-06T09:00:00Z' }).closed).toBe(false);
  });

  it('records UNFOUNDED as a first-class outcome', () => {
    const c = addEvidence(opened(), CLIP).case;
    const result = closeCase({
      case: c,
      outcome: 'unfounded',
      note: 'the customer had walked away; the void was correct and the cashier followed policy',
      closedBy: 'u-security',
      at: '2026-08-06T09:00:00Z',
    });
    expect(result.closed).toBe(true);
    expect(result.case.outcome).toBe('unfounded');
    // The investigator may close their own unfounded case — it is a proven one that
    // needs a second signature.
    expect(result.case.closedBy).toBe('u-security');
  });

  it('needs a SECOND PERSON to sign off a proven outcome (§28)', () => {
    const c = addEvidence(opened(), CLIP).case;
    const self = closeCase({
      case: c, outcome: 'proven', note: 'admitted', closedBy: 'u-security', at: '2026-08-06T09:00:00Z',
    });
    expect(self.closed).toBe(false);
    expect(self.detail).toContain('other than the investigator');

    const proper = closeCase({
      case: c, outcome: 'proven', note: 'admitted in the meeting; ₹18,400 recovered', closedBy: 'u-owner', at: '2026-08-06T09:00:00Z',
    });
    expect(proper.closed).toBe(true);
  });

  it('cannot prove a case with no evidence on it', () => {
    const bare = closeCase({
      case: opened(), outcome: 'proven', note: 'obvious', closedBy: 'u-owner', at: '2026-08-06T09:00:00Z',
    });
    expect(bare.closed).toBe(false);
    expect(bare.detail).toContain('no evidence on it');
  });

  it('REFUSES TO CLOSE ON EVIDENCE THAT DOES NOT VERIFY', () => {
    const c = addEvidence(opened(), CLIP).case;
    const tampered: InvestigationCase = {
      ...c,
      evidence: [{ ...c.evidence[0]!, ref: 'cctv/somewhere-else.mp4' }],
    };
    const result = closeCase({
      case: tampered, outcome: 'proven', note: 'clear', closedBy: 'u-owner', at: '2026-08-06T09:00:00Z',
    });
    expect(result.closed).toBe(false);
    expect(result.detail).toContain('evidence that does not verify');
  });

  it('refuses to close twice', () => {
    const c = addEvidence(opened(), CLIP).case;
    const once = closeCase({ case: c, outcome: 'unfounded', note: 'no case to answer', closedBy: 'u-security', at: '2026-08-06T09:00:00Z' });
    expect(closeCase({ case: once.case, outcome: 'proven', note: 'again', closedBy: 'u-owner', at: '2026-08-07T09:00:00Z' }).closed).toBe(false);
  });
});

describe('outcomes MEASURABLY adjust the rules that raised them', () => {
  const closed = (rule: string, outcome: InvestigationCase['outcome'], n: number): InvestigationCase[] =>
    Array.from({ length: n }, (_, i) => ({
      caseId: `${rule}-${outcome}-${i}`,
      tenantId: 't-1',
      raisedFromRef: `${rule}:EX-${i}`,
      subjectRef: 'u-x',
      summary: 's',
      valueMinor: 1_000,
      openedBy: 'u-m',
      openedAt: '2026-07-01T09:00:00Z',
      assignedTo: 'u-s',
      state: 'closed' as const,
      evidence: [],
      outcome,
      outcomeNote: 'n',
      closedBy: 'u-owner',
      closedAt: '2026-07-05T09:00:00Z',
    }));

  it('RETIRES a rule that has never once been right', () => {
    const [adjustment] = ruleFeedback(closed('rule-noisy', 'unfounded', 8));
    expect(adjustment?.action).toBe('retire');
    expect(adjustment?.detail).toContain('never once been right');
  });

  it('RELAXES a rule that is mostly noise', () => {
    const [adjustment] = ruleFeedback([...closed('rule-a', 'unfounded', 9), ...closed('rule-a', 'proven', 1)]);
    expect(adjustment?.action).toBe('relax');
    expect(adjustment?.detail).toContain('10% of 10 cases proven');
    expect(adjustment?.detail).toContain('training people to ignore it');
  });

  it('TIGHTENS a rule that keeps finding real losses', () => {
    const [adjustment] = ruleFeedback([...closed('rule-b', 'proven', 8), ...closed('rule-b', 'unfounded', 2)]);
    expect(adjustment?.action).toBe('tighten');
    expect(adjustment?.detail).toContain('catch more of them');
  });

  it('KEEPS a rule that is working', () => {
    const [adjustment] = ruleFeedback([...closed('rule-c', 'proven', 5), ...closed('rule-c', 'unfounded', 5)]);
    expect(adjustment?.action).toBe('keep');
    expect(adjustment?.detail).toContain('working as intended');
  });

  it('refuses to judge a rule on a handful of outcomes', () => {
    const [adjustment] = ruleFeedback(closed('rule-new', 'unfounded', 2));
    expect(adjustment?.action).toBe('keep');
    expect(adjustment?.detail).toContain('too few to judge');
  });

  it('ignores cases that are still open', () => {
    const open = closed('rule-d', 'unfounded', 8).map((c) => ({ ...c, state: 'open' as const }));
    expect(ruleFeedback(open)).toEqual([]);
  });

  it('counts a police referral as proven, not as a separate limbo', () => {
    const [adjustment] = ruleFeedback([
      ...closed('rule-e', 'referred_to_police', 6),
      ...closed('rule-e', 'inconclusive', 2),
    ]);
    expect(adjustment?.action).toBe('tighten');
  });
});
