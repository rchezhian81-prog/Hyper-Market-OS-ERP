// Import job history and data-quality scoring (M30-FR-04 remainder / P-08 / hard rule #6).
//
// `validateImport` and `commitImport` already refuse a bad file with per-row line numbers and
// an all-or-nothing commit. What was missing is the part that matters over months rather than
// minutes: **the record of what was imported, by whom, and whether the data is getting better
// or worse.**
//
// The failure this closes is quiet and expensive. A supplier's price file has been arriving
// with 12% of rows rejected every week for a year. Nobody is *wrong* — the operator fixes the
// dozen rows by hand each time and the import succeeds, so no alert ever fires and no report
// ever shows a problem. The cost is an hour a week forever, and a standing risk that one week
// somebody fixes a row incorrectly. It is only visible as a **trend**, and only if somebody
// kept the history.
//
//   • **A JOB RECORD IS KEPT WHETHER IT SUCCEEDED OR NOT** (hard rule #6). A history of only
//     the successes is how a file that fails half the time looks perfect.
//   • **THE SCORE IS THE SOURCE'S, NOT THE OPERATOR'S.** Rejection rates are reported per
//     source file and supplier, because the fix is at the supplier's end and blaming the
//     person retyping the rows fixes nothing.
//   • **AN IMPROVING BAD SCORE STILL BEATS A STABLE MEDIOCRE ONE.** Direction is reported
//     beside the level, so effort that is working is visible.
//   • **A REJECTION REASON IS A DIFFERENT JOB FROM A REJECTION COUNT.** "88% clean" is a
//     dashboard; *"every failure is the same missing HSN column"* is one email to a supplier.
//
// Pure and deterministic: the clock is injected, no I/O.

import type { ImportPreview, RowError, RowErrorKind } from './import-job';

export type JobOutcome = 'committed' | 'refused' | 'abandoned';

export interface ImportJobRecord {
  readonly jobId: string;
  readonly tenantId: string;
  readonly templateId: string;
  /** Where the file came from — a supplier, a system, a person. The score belongs to this. */
  readonly sourceId: string;
  readonly fileName: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly outcome: JobOutcome;
  readonly totalRows: number;
  readonly validRows: number;
  readonly errorRows: number;
  readonly duplicatesForReview: number;
  /** Every error, kept — the reasons are the actionable part. */
  readonly errors: readonly RowError[];
  readonly approvedBy?: string;
  readonly refusalReason?: string;
  readonly sumMinor?: number;
  readonly reconciled?: boolean;
}

/**
 * Turn a preview and its outcome into a permanent job record.
 *
 * **Refused jobs are recorded too.** A history of only the successes is exactly how a file
 * that fails half the time looks perfect — the operator fixes the rows, resubmits, and only
 * the clean run is remembered.
 */
export function recordJob(input: {
  readonly jobId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly fileName: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly preview: ImportPreview;
  readonly outcome: JobOutcome;
  readonly approvedBy?: string;
  readonly refusalReason?: string;
}): ImportJobRecord {
  return {
    jobId: input.jobId,
    tenantId: input.tenantId,
    templateId: input.preview.template.id,
    sourceId: input.sourceId,
    fileName: input.fileName,
    uploadedBy: input.uploadedBy,
    uploadedAt: input.uploadedAt,
    outcome: input.outcome,
    totalRows: input.preview.totalRows,
    validRows: input.preview.validCount,
    errorRows: input.preview.errorRowCount,
    duplicatesForReview: input.preview.duplicatesForReview.length,
    errors: input.preview.errors,
    approvedBy: input.approvedBy,
    refusalReason: input.refusalReason,
    sumMinor: input.preview.sumMinor,
    reconciled: input.preview.reconciles,
  };
}

export type QualityBand = 'clean' | 'acceptable' | 'poor' | 'unusable' | 'not_enough_data';
export type QualityDirection = 'improving' | 'stable' | 'worsening' | 'not_comparable';

export interface ReasonCount {
  readonly kind: RowErrorKind;
  readonly column: string;
  readonly count: number;
  readonly shareBps: number;
  /** What to actually do about it. */
  readonly action: string;
}

export interface QualityScore {
  readonly sourceId: string;
  readonly from: string;
  readonly to: string;
  readonly jobs: number;
  readonly totalRows: number;
  readonly rejectedRows: number;
  /** Basis points of rows accepted. 10,000 = every row. */
  readonly acceptedBps: number | 'not_enough_data';
  readonly band: QualityBand;
  readonly direction: QualityDirection;
  /** The reasons, ranked — because a count is a dashboard and a reason is an email. */
  readonly topReasons: readonly ReasonCount[];
  /** Hours a year this source costs at the current rejection rate, if it never improves. */
  readonly annualFixHours: number;
  readonly detail: string;
}

/** What each rejection kind actually needs somebody to do. */
const ACTION_FOR: Readonly<Record<RowErrorKind, string>> = {
  missing_required: 'ask the source to include this column — it is missing at their end, not ours',
  not_an_integer: 'the source is sending text where a whole number belongs',
  not_an_amount: 'the source is sending an amount we cannot parse — usually a currency symbol or a comma',
  not_allowed_value: 'the source is using a code we do not recognise — agree a list with them once',
  unknown_reference: 'the source references something not in our master data — either add it or correct theirs',
  duplicate_in_file: 'the same key appears twice in one file — the source is exporting duplicates',
};

function bandOf(acceptedBps: number): QualityBand {
  if (acceptedBps >= 9_900) return 'clean';
  if (acceptedBps >= 9_500) return 'acceptable';
  if (acceptedBps >= 8_000) return 'poor';
  return 'unusable';
}

/**
 * Score a source's data quality over a window.
 *
 * **The score belongs to the source, not to the operator.** A supplier whose price file has
 * arrived with 12% of rows rejected every week for a year is not an operator problem — the
 * operator has been fixing it by hand and the import has been succeeding, which is why no
 * alert has ever fired. `annualFixHours` puts a number on that quiet cost, because *"12%
 * rejected"* is tolerable-sounding and *"52 hours a year retyping their rows"* is not.
 *
 * `direction` is reported beside the level so that effort which is working shows up: a source
 * improving from unusable to poor is a success, and a report that only shows the band would
 * call it a failure two quarters running.
 */
export function scoreSource(input: {
  readonly sourceId: string;
  readonly jobs: readonly ImportJobRecord[];
  readonly from: string;
  readonly to: string;
  /** Earlier window, for direction. */
  readonly previous?: readonly ImportJobRecord[];
  /** Rows before a score means anything. Default 100. */
  readonly minimumRows?: number;
  /** Minutes to fix one rejected row by hand. Per-tenant. Default 2. */
  readonly minutesPerRow?: number;
  /** Basis-point move that counts as a real change. Default 200 (2 percentage points). */
  readonly directionToleranceBps?: number;
}): QualityScore {
  const minimum = input.minimumRows ?? 100;
  const perRow = input.minutesPerRow ?? 2;
  const tolerance = input.directionToleranceBps ?? 200;

  const window = input.jobs.filter(
    (j) => j.sourceId === input.sourceId && j.uploadedAt >= input.from && j.uploadedAt <= `${input.to}T23:59:59Z`,
  );

  const totalRows = window.reduce((s, j) => s + j.totalRows, 0);
  const rejectedRows = window.reduce((s, j) => s + j.errorRows, 0);

  const acceptedOf = (rows: number, rejected: number): number | undefined =>
    rows === 0 ? undefined : Number((BigInt(rows - rejected) * 10_000n) / BigInt(rows));

  const accepted = acceptedOf(totalRows, rejectedRows);

  // Reasons, ranked. This is the actionable half.
  const byReason = new Map<string, { kind: RowErrorKind; column: string; count: number }>();
  for (const job of window) {
    for (const error of job.errors) {
      const key = `${error.kind}|${error.column}`;
      const seen = byReason.get(key) ?? { kind: error.kind, column: error.column, count: 0 };
      byReason.set(key, { ...seen, count: seen.count + 1 });
    }
  }
  const totalErrors = [...byReason.values()].reduce((s, r) => s + r.count, 0);
  const topReasons = [...byReason.values()]
    .map((r): ReasonCount => ({
      kind: r.kind,
      column: r.column,
      count: r.count,
      shareBps: totalErrors === 0 ? 0 : Number((BigInt(r.count) * 10_000n) / BigInt(totalErrors)),
      action: ACTION_FOR[r.kind],
    }))
    .sort((a, b) => b.count - a.count || a.column.localeCompare(b.column));

  // Weeks in the window, so the annual cost is an extrapolation rather than a guess.
  const days = Math.max(
    1,
    Math.floor((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000) + 1,
  );
  const annualFixHours = Math.round(((rejectedRows * perRow) / 60) * (365 / days));

  if (accepted === undefined || totalRows < minimum) {
    return {
      sourceId: input.sourceId,
      from: input.from,
      to: input.to,
      jobs: window.length,
      totalRows,
      rejectedRows,
      acceptedBps: 'not_enough_data',
      band: 'not_enough_data',
      direction: 'not_comparable',
      topReasons,
      annualFixHours,
      detail: `${totalRows} row(s) from this source is too little to score against a ${minimum}-row minimum — a rate on a handful of rows is noise, not quality`,
    };
  }

  const band = bandOf(accepted);

  let direction: QualityDirection = 'not_comparable';
  if (input.previous !== undefined) {
    const prior = input.previous.filter((j) => j.sourceId === input.sourceId);
    const priorRows = prior.reduce((s, j) => s + j.totalRows, 0);
    const priorAccepted = acceptedOf(priorRows, prior.reduce((s, j) => s + j.errorRows, 0));
    if (priorAccepted !== undefined && priorRows >= minimum) {
      const move = accepted - priorAccepted;
      direction = move > tolerance ? 'improving' : move < -tolerance ? 'worsening' : 'stable';
    }
  }

  const worst = topReasons[0];

  return {
    sourceId: input.sourceId,
    from: input.from,
    to: input.to,
    jobs: window.length,
    totalRows,
    rejectedRows,
    acceptedBps: accepted,
    band,
    direction,
    topReasons,
    annualFixHours,
    detail:
      band === 'clean'
        ? `${(accepted / 100).toFixed(1)}% of rows accepted across ${window.length} file(s) — nothing to chase`
        : worst === undefined
          ? `${(accepted / 100).toFixed(1)}% accepted`
          : `${(accepted / 100).toFixed(1)}% accepted and ${direction}; ${(worst.shareBps / 100).toFixed(0)}% of every failure is "${worst.column}" — ${worst.action}. At this rate it costs about ${annualFixHours} hour(s) a year of somebody retyping rows`,
  };
}

export interface JobHistoryRow {
  readonly jobId: string;
  readonly fileName: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly outcome: JobOutcome;
  readonly rows: string;
  readonly detail: string;
}

/**
 * The job history somebody actually reads — **refusals included**.
 *
 * Sorted newest first, because the question is almost always *"what happened this morning?"*,
 * and a refused job that was resubmitted and succeeded shows as **both rows**: the first
 * attempt is the evidence that the file was wrong.
 */
export function jobHistory(input: {
  readonly jobs: readonly ImportJobRecord[];
  readonly sourceId?: string;
  readonly templateId?: string;
  readonly limit?: number;
}): readonly JobHistoryRow[] {
  return input.jobs
    .filter((j) => input.sourceId === undefined || j.sourceId === input.sourceId)
    .filter((j) => input.templateId === undefined || j.templateId === input.templateId)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.jobId.localeCompare(b.jobId))
    .slice(0, input.limit ?? 50)
    .map((j): JobHistoryRow => ({
      jobId: j.jobId,
      fileName: j.fileName,
      uploadedBy: j.uploadedBy,
      uploadedAt: j.uploadedAt,
      outcome: j.outcome,
      rows: `${j.validRows}/${j.totalRows}`,
      detail:
        j.outcome === 'committed'
          ? `${j.validRows} row(s) applied${j.approvedBy === undefined ? '' : `, approved by ${j.approvedBy}`}${j.duplicatesForReview > 0 ? `; ${j.duplicatesForReview} duplicate(s) were left for review` : ''}`
          : j.outcome === 'refused'
            ? `refused: ${j.refusalReason ?? 'unspecified'} — ${j.errorRows} of ${j.totalRows} row(s) had errors`
            : `abandoned with ${j.errorRows} error(s) outstanding`,
    }));
}

export interface SourceComparison {
  readonly asAt: string;
  readonly sources: readonly QualityScore[];
  /** Sources whose files cost more to fix than they are worth chasing quietly. */
  readonly worthAConversation: readonly string[];
  readonly totalAnnualFixHours: number;
  readonly detail: string;
}

/**
 * Compare every source, so the conversation happens with the right supplier.
 *
 * The output is deliberately a **list of people to talk to**, not a league table. A ranked
 * chart gets screenshotted into a meeting and nothing changes; *"these three files cost you 90
 * hours a year and each one is a single missing column"* is an email somebody sends.
 */
export function compareSources(input: {
  readonly scores: readonly QualityScore[];
  /** Annual hours above which a source is worth a conversation. Default 10. */
  readonly conversationAboveHours?: number;
  readonly asAt: string;
}): SourceComparison {
  const threshold = input.conversationAboveHours ?? 10;
  const sources = [...input.scores].sort(
    (a, b) => b.annualFixHours - a.annualFixHours || a.sourceId.localeCompare(b.sourceId),
  );
  const worthAConversation = sources
    .filter((s) => s.annualFixHours >= threshold && s.band !== 'clean' && s.band !== 'not_enough_data')
    .map((s) => s.sourceId);
  const totalAnnualFixHours = sources.reduce((s, x) => s + x.annualFixHours, 0);

  return {
    asAt: input.asAt,
    sources,
    worthAConversation,
    totalAnnualFixHours,
    detail:
      worthAConversation.length === 0
        ? `${sources.length} source(s) reviewed, none costing enough to chase`
        : `${worthAConversation.join(', ')} cost about ${totalAnnualFixHours} hour(s) a year between them — and each one is usually a single column somebody could fix at their end once`,
  };
}
