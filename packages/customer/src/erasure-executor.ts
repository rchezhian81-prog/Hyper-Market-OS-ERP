// Erasure-plan executor (M16-FR-03 / M20-FR-04) — the step that CARRIES OUT an `ErasurePlan`.
//
// `planErasure` answers the question honestly, category by category: erase this, minimise that,
// keep the rest and say why. But a plan on its own deletes nothing. This engine is what turns
// that plan into action against the stores that actually hold the data.
//
// It is PROVIDER-NEUTRAL by design. Each data category is served by an `ErasableSource` — an
// adapter that knows how to erase or minimise that one category in its own store. In production
// the real domain stores (orders, loyalty, the served customer profile, …) register as sources
// at the edge; in tests they are in-memory fakes. The engine never knows or cares which. That
// separation is deliberate: the executor is fully buildable and testable now, and wiring the
// real stores in behind these adapters is the one remaining step that needs the live data model.
//
// Three rules it will not break:
//   • Retained data is NEVER touched — not even if a store is registered for that category. Audit
//     evidence, tax and GST invoices survive an erasure intact; a person becomes a pseudonym, the
//     trail does not (hard rule #6). The retain branch does not call the source at all.
//   • Nothing fails silently. A category the plan wanted actioned but that has no registered source,
//     or whose source raised, becomes a VISIBLE exception in the report — never a quiet skip that
//     would let the trail claim an erasure that never reached the data (P-08).
//   • One failing store does not abort the erasure. The other categories are still actioned, and
//     the failure is surfaced to be retried.
//
// Pure of I/O itself: the sources do the I/O, "now" is injected, and the report is a plain value
// an append-only trail can record.

import type { Disposition, ErasurePlan, RetentionBasis } from './data-rights';

/** What a store reports after acting on one category for one subject. */
export interface SourceResult {
  /** How many records the store changed. Zero is legitimate — the store simply held nothing. */
  readonly recordsAffected: number;
  /** An optional note the store wants on the evidence trail (e.g. "3 orders anonymised"). */
  readonly note?: string;
}

/**
 * A store that holds personal data for ONE category and can carry out a disposition on it.
 * Provider-neutral: the real domain stores implement this at the edge; tests use in-memory ones.
 * `subjectRef` is the customer reference the plan was built for.
 */
export interface ErasableSource {
  /** The category this store answers for — matched against `CategoryPlan.category`. */
  readonly category: string;
  /** Remove the subject's records in this store. */
  erase(subjectRef: string): SourceResult | Promise<SourceResult>;
  /** Redact the subject's records to the lawful minimum, keeping the record itself. */
  minimise(subjectRef: string): SourceResult | Promise<SourceResult>;
}

/** What actually happened to one category — which may differ from what the plan asked. */
export type ExecutionOutcome =
  | 'erased' // the store removed the records
  | 'minimised' // the store redacted the records, keeping them
  | 'retained' // kept in full under a statute — the store was NOT touched
  | 'no_source' // the plan wanted this actioned but no store is registered — a visible exception
  | 'failed'; // the store raised — surfaced, never swallowed

export interface CategoryExecution {
  readonly category: string;
  /** What the plan asked for. */
  readonly disposition: Disposition;
  /** What the executor actually did. */
  readonly outcome: ExecutionOutcome;
  /** Records the store changed. Zero for retained / no_source / failed. */
  readonly recordsAffected: number;
  /** Carried through for a retained category, so the trail keeps the statute and release date. */
  readonly retentionBasis?: RetentionBasis;
  readonly retainUntil?: string;
  /** A store note, or the reason a category could not be actioned. */
  readonly note?: string;
}

export interface ErasureExecutionReport {
  readonly requestId: string;
  readonly customerRef: string;
  readonly executedAt: string;
  readonly lines: readonly CategoryExecution[];
  readonly totals: {
    /** Records erased. */
    readonly erased: number;
    /** Records minimised. */
    readonly minimised: number;
    /** Records retained (kept in full) — taken from the plan, since nothing is touched. */
    readonly retained: number;
    /** Categories whose store raised. */
    readonly failed: number;
    /** Categories the plan wanted actioned but with no registered store. */
    readonly noSource: number;
  };
  /** True only when every erase / minimise the plan asked for was actioned. Retained never blocks. */
  readonly complete: boolean;
  /** The categories that could not be actioned — surfaced for retry, never silent (P-08). */
  readonly exceptions: readonly CategoryExecution[];
}

/**
 * Carry out an erasure plan against the registered sources.
 *
 * Deterministic: processes categories in plan order, and given the same plan and sources produces
 * the same report. Async because a real store's erase/minimise is I/O; a synchronous fake works too.
 */
export async function executeErasurePlan(input: {
  readonly plan: ErasurePlan;
  readonly sources: readonly ErasableSource[];
  readonly at: string;
}): Promise<ErasureExecutionReport> {
  const byCategory = new Map<string, ErasableSource>();
  for (const source of input.sources) byCategory.set(source.category, source);

  const subjectRef = input.plan.customerRef;
  const lines: CategoryExecution[] = [];

  for (const cp of input.plan.plan) {
    // Retained data is never touched — the strongest hard-rule-#6 guard. Even if a store is
    // registered for this category, the executor does not call it: audit evidence, tax and GST
    // records are kept in full, and the plan already carries the statute and release date.
    if (cp.disposition === 'retain') {
      lines.push({
        category: cp.category,
        disposition: 'retain',
        outcome: 'retained',
        recordsAffected: 0,
        ...(cp.retentionBasis === undefined ? {} : { retentionBasis: cp.retentionBasis }),
        ...(cp.retainUntil === undefined ? {} : { retainUntil: cp.retainUntil }),
      });
      continue;
    }

    const source = byCategory.get(cp.category);
    if (source === undefined) {
      // The plan wanted this category erased or minimised, but no store answers for it. Skipping it
      // silently would let the trail claim an erasure that never reached this data — so it is a
      // visible exception to be resolved by registering the store, not a success (P-08).
      lines.push({
        category: cp.category,
        disposition: cp.disposition,
        outcome: 'no_source',
        recordsAffected: 0,
        note: `No registered source for category "${cp.category}" — ${cp.disposition} not carried out.`,
      });
      continue;
    }

    try {
      const result =
        cp.disposition === 'erase' ? await source.erase(subjectRef) : await source.minimise(subjectRef);
      lines.push({
        category: cp.category,
        disposition: cp.disposition,
        outcome: cp.disposition === 'erase' ? 'erased' : 'minimised',
        recordsAffected: result.recordsAffected,
        ...(result.note === undefined ? {} : { note: result.note }),
      });
    } catch (err) {
      // One store failing does not abort the erasure — the remaining categories are still actioned,
      // and this one is surfaced as an exception to retry, never swallowed (P-08).
      lines.push({
        category: cp.category,
        disposition: cp.disposition,
        outcome: 'failed',
        recordsAffected: 0,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sumAffected = (outcome: ExecutionOutcome): number =>
    lines.filter((l) => l.outcome === outcome).reduce((s, l) => s + l.recordsAffected, 0);
  const countOutcome = (outcome: ExecutionOutcome): number =>
    lines.filter((l) => l.outcome === outcome).length;

  const exceptions = lines.filter((l) => l.outcome === 'failed' || l.outcome === 'no_source');

  return {
    requestId: input.plan.requestId,
    customerRef: subjectRef,
    executedAt: input.at,
    lines,
    totals: {
      erased: sumAffected('erased'),
      minimised: sumAffected('minimised'),
      retained: input.plan.retainedRecordCount,
      failed: countOutcome('failed'),
      noSource: countOutcome('no_source'),
    },
    complete: exceptions.length === 0,
    exceptions,
  };
}
