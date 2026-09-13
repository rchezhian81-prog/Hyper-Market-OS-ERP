// The manager's open-investigations worklist (M15-FR-04, P-03 control by exception).
//
// A material till short now auto-opens an investigation (auto-open-from-shortage.ts). But a case that is
// opened and then sits unseen is a case nobody worked — the exact failure "control by exception" exists
// to prevent. So the store manager needs one place that shows every OPEN case, ordered so the biggest
// potential loss is worked first, and narrowable to the cases that are theirs.
//
// This is the pure selection behind that view: it reads the folded cases and returns the open ones as a
// worklist. It returns a summary per case — never the sealed evidence chain — because a worklist is
// scanned, not read line by line; the full case (and its chain-of-custody verification) is a separate
// read. Pure and deterministic: no clock, no I/O.

import type { InvestigationCase } from './cases';

export interface OpenCaseSummary {
  readonly caseId: string;
  readonly subjectRef: string;
  readonly assignedTo: string;
  readonly summary: string;
  readonly valueMinor: number;
  readonly raisedFromRef: string;
  readonly openedBy: string;
  readonly openedAt: string;
  /** How many evidence items are on file — not the items themselves. */
  readonly evidenceCount: number;
}

export interface OpenCaseWorklist {
  readonly openCount: number;
  /** The total value at stake across the open cases — the size of the manager's open exposure. */
  readonly totalValueMinor: number;
  readonly cases: readonly OpenCaseSummary[];
}

/**
 * Build the open-investigations worklist from the folded cases. Only OPEN cases appear (a closed case
 * has an outcome and is off the list). With `assignedTo`, only that person's cases — the "my
 * investigations" view. Ordered highest value first, then oldest, then by id, so the order is stable and
 * the biggest loss is at the top.
 */
export function buildOpenCaseWorklist(
  cases: readonly InvestigationCase[],
  opts: { readonly assignedTo?: string } = {},
): OpenCaseWorklist {
  const open = cases
    .filter((c) => c.state === 'open')
    .filter((c) => opts.assignedTo === undefined || c.assignedTo === opts.assignedTo)
    .slice()
    .sort((a, b) =>
      b.valueMinor - a.valueMinor
      || a.openedAt.localeCompare(b.openedAt)
      || a.caseId.localeCompare(b.caseId));

  return {
    openCount: open.length,
    totalValueMinor: open.reduce((sum, c) => sum + c.valueMinor, 0),
    cases: open.map((c) => ({
      caseId: c.caseId,
      subjectRef: c.subjectRef,
      assignedTo: c.assignedTo,
      summary: c.summary,
      valueMinor: c.valueMinor,
      raisedFromRef: c.raisedFromRef,
      openedBy: c.openedBy,
      openedAt: c.openedAt,
      evidenceCount: c.evidence.length,
    })),
  };
}
