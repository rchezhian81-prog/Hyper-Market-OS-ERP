import { describe, it, expect } from 'vitest';
import { buildOpenCaseWorklist } from '../../packages/loss-prevention/src/index';
import type { InvestigationCase } from '../../packages/loss-prevention/src/index';

// The manager's open-investigations worklist (M15-FR-04, P-03). Every OPEN case, highest value first, so
// an auto-opened shortage investigation cannot be opened and forgotten. A summary per case, never the
// sealed evidence chain.

const aCase = (over: Partial<InvestigationCase> = {}): InvestigationCase => ({
  caseId: 'c1', tenantId: 't', raisedFromRef: 'shift-shortage:S1', subjectRef: 'u-cashier',
  summary: 'a short', valueMinor: 1_000, openedBy: 'system:till-shortage-rule', openedAt: '2026-09-12T10:00:00Z',
  assignedTo: 'u-sm', state: 'open', evidence: [], ...over,
});

describe('the open-investigations worklist', () => {
  it('lists only OPEN cases — a closed case has an outcome and is off the list', () => {
    const wl = buildOpenCaseWorklist([
      aCase({ caseId: 'open-1' }),
      aCase({ caseId: 'closed-1', state: 'closed', outcome: 'unfounded' }),
    ]);
    expect(wl.openCount).toBe(1);
    expect(wl.cases.map((c) => c.caseId)).toEqual(['open-1']);
  });

  it('orders highest value first, then oldest, and totals the exposure', () => {
    const wl = buildOpenCaseWorklist([
      aCase({ caseId: 'small', valueMinor: 500 }),
      aCase({ caseId: 'big', valueMinor: 90_000 }),
      aCase({ caseId: 'mid-newer', valueMinor: 5_000, openedAt: '2026-09-12T12:00:00Z' }),
      aCase({ caseId: 'mid-older', valueMinor: 5_000, openedAt: '2026-09-12T08:00:00Z' }),
    ]);
    expect(wl.cases.map((c) => c.caseId)).toEqual(['big', 'mid-older', 'mid-newer', 'small']);
    expect(wl.totalValueMinor).toBe(500 + 90_000 + 5_000 + 5_000);
  });

  it('narrows to one investigator’s own cases with assignedTo (the "my investigations" view)', () => {
    const cases = [
      aCase({ caseId: 'mine-1', assignedTo: 'u-sm' }),
      aCase({ caseId: 'theirs', assignedTo: 'u-other' }),
      aCase({ caseId: 'mine-2', assignedTo: 'u-sm' }),
    ];
    const mine = buildOpenCaseWorklist(cases, { assignedTo: 'u-sm' });
    expect(mine.openCount).toBe(2);
    expect(mine.cases.every((c) => c.assignedTo === 'u-sm')).toBe(true);
    expect(buildOpenCaseWorklist(cases).openCount).toBe(3); // unfiltered sees all
  });

  it('summarises each case (evidence count, not the sealed items themselves)', () => {
    const withEvidence = aCase({
      evidence: [
        { evidenceId: 'e1', kind: 'note', ref: 'r', description: 'd', collectedBy: 'u', collectedAt: 't', collectedFrom: 'f', seal: 's' },
      ],
    });
    const wl = buildOpenCaseWorklist([withEvidence]);
    const row = wl.cases[0]!;
    expect(row.evidenceCount).toBe(1);
    expect((row as unknown as Record<string, unknown>)['evidence']).toBeUndefined(); // the chain is a separate read
    expect(row.subjectRef).toBe('u-cashier');
  });

  it('is empty and zero-valued when there are no open cases', () => {
    const wl = buildOpenCaseWorklist([aCase({ state: 'closed', outcome: 'proven' })]);
    expect(wl).toEqual({ openCount: 0, totalValueMinor: 0, cases: [] });
  });
});
