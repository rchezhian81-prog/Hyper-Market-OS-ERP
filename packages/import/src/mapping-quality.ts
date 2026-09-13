// Suspicious-mapping detection over import history (M30-FR-04 · A08 "Data Quality" · P-05).
//
// A08's remit (§7.1) is to "detect duplicates, missing attributes and SUSPICIOUS MAPPINGS." The first two
// legs read the product master; this is the third, and it reads the one thing import history actually keeps:
// the **per-column rejection fingerprint**. Every import job — committed, refused or abandoned — keeps its
// `errors[]`, each tagged with the TARGET column it failed on and why (`RowError { column, kind }`). A file
// whose "hsn" column is rejected every week is not a run of bad luck; it is a mapping that is wrong at the
// source's end — the wrong column is mapped to it, its values use codes we do not recognise, or it is simply
// absent. That recurring fingerprint is a suspicious mapping, and it is what a data steward should chase.
//
// It deliberately does NOT try to PROPOSE a source-header → target-field mapping for a fresh file: the raw
// source headers are never persisted (only the post-mapping rows and their rejections are), so a header
// matcher would have nothing real to work from. Inventing one would be guessing. This detects the mappings
// that history shows are already going wrong — grounded in data that exists.
//
// It reuses the tested `scoreSource` engine (packages/import/src/job-history.ts) for the ranking and the
// plain-English corrective action, so there is one definition of "which column is failing and what to do".
//
// Pure and deterministic: no clock beyond the dates on the jobs, no I/O.

import { scoreSource, type ImportJobRecord } from './job-history';
import type { RowErrorKind } from './import-job';

/**
 * Rejection kinds that point at a MAPPING problem — the source column is wrong, unmapped, or its values /
 * format do not match the target field. `duplicate_in_file` is a data problem at the source, not a mapping,
 * so it is excluded: a steward cannot fix a supplier exporting the same key twice by re-mapping a column.
 */
export const MAPPING_REJECTION_KINDS: readonly RowErrorKind[] = Object.freeze([
  'missing_required', 'not_an_integer', 'not_an_amount', 'not_allowed_value', 'unknown_reference',
]);

export interface MappingQualityFinding {
  /** Stable, deterministic id: the same history yields the same finding id every time. */
  readonly findingId: string;
  /** The source (supplier/system/file) whose imports keep failing on this column. */
  readonly sourceId: string;
  /** The TARGET field that keeps rejecting — the one whose mapping is suspect. */
  readonly column: string;
  readonly kind: RowErrorKind;
  /** How many rows from this source were rejected on this column+reason across the history. */
  readonly count: number;
  /** This reason's share of the source's total failures, in basis points (10,000 = all of them). */
  readonly shareBps: number;
  /** One line a data steward reads first. */
  readonly headline: string;
  /** Why it matters and what to do — no jargon. */
  readonly detail: string;
  /** The corrective action, from the tested engine's own map (what actually fixes it). */
  readonly action: string;
}

/**
 * Scan import history for the mappings a source keeps failing on.
 *
 * A finding is raised for a (source, column, reason) that recurs enough to be a PATTERN rather than a typo —
 * at least `minCount` rejected rows AND at least `minShareBps` of that source's failures — and only for a
 * mapping-related reason. Read-only and deterministic; it produces a review list, never an action.
 */
export function assessMappingQuality(input: {
  readonly jobs: readonly ImportJobRecord[];
  /** A (column, reason) must recur at least this many times to be a pattern. Default 3. */
  readonly minCount?: number;
  /** ...and be at least this share of the source's failures. Default 2,000 bps (20%). */
  readonly minShareBps?: number;
}): readonly MappingQualityFinding[] {
  const minCount = input.minCount ?? 3;
  const minShareBps = input.minShareBps ?? 2_000;
  const mappingKinds = new Set<RowErrorKind>(MAPPING_REJECTION_KINDS);

  // Group jobs by their source — the score, and the fix, belong to the source (job-history.ts).
  const bySource = new Map<string, ImportJobRecord[]>();
  for (const j of input.jobs) {
    const list = bySource.get(j.sourceId);
    if (list === undefined) bySource.set(j.sourceId, [j]);
    else list.push(j);
  }

  const findings: MappingQualityFinding[] = [];
  for (const [sourceId, jobs] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dates = jobs.map((j) => j.uploadedAt.slice(0, 10)).sort();
    // scoreSource's `topReasons` ranks every (column, reason) with its share and corrective action; it is
    // computed over the whole window regardless of whether there are enough rows to BAND the source, so it is
    // meaningful here even for a short history.
    const score = scoreSource({ sourceId, jobs, from: dates[0] ?? '1970-01-01', to: dates[dates.length - 1] ?? '1970-01-01' });
    for (const reason of score.topReasons) {
      if (!mappingKinds.has(reason.kind)) continue;
      if (reason.count < minCount || reason.shareBps < minShareBps) continue;
      const sharePct = Math.round(reason.shareBps / 100);
      findings.push({
        findingId: `dq-mapping:${sourceId}:${reason.column}:${reason.kind}`,
        sourceId,
        column: reason.column,
        kind: reason.kind,
        count: reason.count,
        shareBps: reason.shareBps,
        headline: `Imports from "${sourceId}" keep failing on the "${reason.column}" column`,
        detail:
          `${reason.count} row(s) from ${sourceId} were rejected on "${reason.column}" — ${sharePct}% of ` +
          `everything that source gets wrong. ${reason.action}.`,
        action: reason.action,
      });
    }
  }

  // Worst (most rejected rows) first, then a stable source/column order.
  return findings.sort((a, b) =>
    b.count - a.count || a.sourceId.localeCompare(b.sourceId) || a.column.localeCompare(b.column));
}
