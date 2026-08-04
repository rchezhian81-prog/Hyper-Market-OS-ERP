// Trial loads and delta capture — MG-05, MG-09 (§34, §31.1, hard rules #1, #7, #10).
//
// **MG-05 exists because the first full-volume load always fails**, and the only question is
// whether it fails in a rehearsal or on the night. Two things make it worth running:
//
//   • **Full volume, or it rehearsed nothing.** A load of a thousand sample rows proves the
//     mapping and nothing about the four hours. Timing is an output here, because the cutover
//     window is a real constraint on a real evening and *"about an hour"* is how a shop opens
//     late.
//   • **Repeatable, or it cannot be trusted.** A load that only works against an empty target
//     works exactly once, and the rehearsal is then also the cutover.
//
// **Hard rule #7 is the one control in this file that is absolute.** A trial load points at a
// non-production target. Not usually, not by convention, not by an environment variable somebody
// can set — `assertNonProduction` refuses at the call site, and `runTrialLoad` will not proceed
// without it. The realistic accident is not malice: it is a copied connection string in a
// terminal at eleven at night, and by the time it is noticed the production catalogue has been
// half-overwritten.
//
// **MG-09 is the step everybody underestimates.** Between the final extract and the cutover the
// shop keeps trading — that is the point of P-01 — so a delta always exists. It must apply
// exactly once (§31.1): applied twice it double-counts stock, and skipped it loses a day.
//
// Pure and deterministic: the clock is injected, no I/O.

export type TargetKind = 'production' | 'staging' | 'rehearsal' | 'local';

export interface LoadTarget {
  readonly targetId: string;
  readonly tenantId: string;
  readonly kind: TargetKind;
  /** Free-text label from configuration. Never trusted as evidence — `kind` decides. */
  readonly label: string;
}

export interface NonProductionAssertion {
  readonly permitted: boolean;
  readonly targetKind: TargetKind;
  readonly detail: string;
}

/**
 * Refuse a production target for anything a migration trial does.
 *
 * Deliberately a **separate, callable, testable function** rather than an `if` inside the loader.
 * It is the one control in the migration pipeline whose failure is unrecoverable, so it is
 * asserted directly in its own tests instead of being reached only through a larger path.
 */
export function assertNonProduction(target: LoadTarget): NonProductionAssertion {
  const permitted = target.kind !== 'production';
  return {
    permitted,
    targetKind: target.kind,
    detail: permitted
      ? `${target.label} is a ${target.kind} target — permitted`
      : `${target.label} is PRODUCTION — a trial load, a delta or a reconciliation run must never point at it (hard rule #7). The realistic accident is a copied connection string at eleven at night`,
  };
}

export type TrialRefusal =
  | 'production_target'
  | 'target_not_empty'
  | 'extract_not_verified'
  | 'blocking_exceptions_open'
  | 'no_operator';

export interface TrialLoadPlan {
  readonly trialId: string;
  readonly tenantId: string;
  readonly target: LoadTarget;
  readonly rowsToLoad: number;
  readonly operator: string;
  /** MG-02: the extract was verified against its seal before this plan was made. */
  readonly extractVerified: boolean;
  /** MG-04: blocking exceptions still without a decision. */
  readonly blockingExceptionsOpen: number;
  /** Whether the target was truncated first. A repeatable load says how it got repeatable. */
  readonly targetPreparedEmpty: boolean;
}

export interface TrialLoadResult {
  readonly ok: boolean;
  readonly trialId: string;
  readonly rowsLoaded: number;
  readonly elapsedMs?: number;
  /** Extrapolated to the real volume, because the cutover window is a real constraint. */
  readonly projectedFullVolumeMs?: number;
  readonly refusedBecause?: TrialRefusal;
  readonly repeatable: boolean;
  readonly detail: string;
}

/**
 * Run a full-volume trial load — or refuse, and say which control stopped it.
 *
 * Ordered so the unrecoverable check runs first: a production target is refused before anything
 * else is even considered, including before the operator's name is checked. Every other refusal
 * here costs an evening; this one costs the shop.
 */
export function runTrialLoad(input: {
  readonly plan: TrialLoadPlan;
  readonly elapsedMs: number;
  /** The real row count the cutover will carry, if larger than this rehearsal. */
  readonly fullVolumeRows?: number;
}): TrialLoadResult {
  const p = input.plan;
  const refuse = (refusedBecause: TrialRefusal, detail: string): TrialLoadResult => ({
    ok: false, trialId: p.trialId, rowsLoaded: 0, refusedBecause, repeatable: false, detail,
  });

  const assertion = assertNonProduction(p.target);
  if (!assertion.permitted) return refuse('production_target', assertion.detail);

  if (p.operator.trim() === '') {
    return refuse('no_operator', 'a load with nobody\'s name on it cannot be questioned when the figures come out wrong');
  }
  if (!p.extractVerified) {
    return refuse('extract_not_verified',
      'the extract has not been verified against its seal (MG-02) — loading unverified bytes produces a reconciliation of a shop nobody has seen');
  }
  if (p.blockingExceptionsOpen > 0) {
    return refuse('blocking_exceptions_open',
      `${p.blockingExceptionsOpen} blocking exceptions have no decision (MG-04) — a trial that loads them anyway rehearses the wrong data and reconciles to the wrong totals`);
  }
  if (!p.targetPreparedEmpty) {
    return refuse('target_not_empty',
      'the target was not prepared empty — a load that only works once is not a rehearsal, it is the cutover');
  }

  const fullVolumeRows = input.fullVolumeRows ?? p.rowsToLoad;
  const projectedFullVolumeMs = p.rowsToLoad === 0
    ? 0
    : Math.round((input.elapsedMs / p.rowsToLoad) * fullVolumeRows);

  return {
    ok: true,
    trialId: p.trialId,
    rowsLoaded: p.rowsToLoad,
    elapsedMs: input.elapsedMs,
    projectedFullVolumeMs,
    repeatable: true,
    detail: `${p.rowsToLoad} rows into ${p.target.label} (${p.target.kind}) in ${input.elapsedMs}ms; ${fullVolumeRows} rows projects to ${projectedFullVolumeMs}ms — the cutover window is a real evening, so this figure is an output, not a footnote`,
  };
}

// ── MG-09 delta ───────────────────────────────────────────────────────────────

export type DeltaOperation = 'insert' | 'update' | 'delete';

export interface DeltaChange {
  /** Stable across retries. The same change re-sent carries the same key (§31.1). */
  readonly changeKey: string;
  readonly entity: string;
  readonly legacyId: string;
  readonly operation: DeltaOperation;
  readonly changedAt: string;
  /** Quantity or money moved, so a mis-applied delta is visible as a number, not a row count. */
  readonly deltaMinor?: number;
  readonly deltaQty?: number;
}

export type DeltaOutcome = 'applied' | 'already_applied' | 'refused_before_cutoff' | 'refused_production';

export interface DeltaLine {
  readonly changeKey: string;
  readonly outcome: DeltaOutcome;
  readonly detail: string;
}

export interface DeltaResult {
  readonly ok: boolean;
  readonly applied: number;
  readonly duplicatesIgnored: number;
  readonly refused: number;
  readonly lines: readonly DeltaLine[];
  /** The keys now considered applied — carried into the next run, never recomputed. */
  readonly appliedKeys: readonly string[];
  readonly netValueMinor: number;
  readonly netQty: number;
  readonly detail: string;
}

/**
 * Apply the changes made since the final extract, **exactly once**.
 *
 * A duplicate is `already_applied`, which is a **success**, not an error. The alternative — a
 * delta run that fails on a re-send — makes an interrupted run unresumable, and the recovery
 * from that at midnight is somebody deciding by hand which half went in.
 *
 * Changes dated before the extract cutoff are refused rather than applied: they are already in
 * the extract, and applying them again is precisely the double-count MG-09 exists to prevent.
 */
export function applyDelta(input: {
  readonly target: LoadTarget;
  readonly changes: readonly DeltaChange[];
  /** The moment the final extract was taken. Anything earlier is already loaded. */
  readonly extractCutoff: string;
  /** Keys applied by an earlier run of this same delta. */
  readonly alreadyApplied?: readonly string[];
}): DeltaResult {
  const assertion = assertNonProduction(input.target);
  if (!assertion.permitted) {
    return {
      ok: false, applied: 0, duplicatesIgnored: 0, refused: input.changes.length,
      lines: input.changes.map((c) => ({ changeKey: c.changeKey, outcome: 'refused_production' as const, detail: assertion.detail })),
      appliedKeys: [...(input.alreadyApplied ?? [])],
      netValueMinor: 0, netQty: 0,
      detail: assertion.detail,
    };
  }

  const seen = new Set(input.alreadyApplied ?? []);
  const lines: DeltaLine[] = [];
  let applied = 0;
  let duplicatesIgnored = 0;
  let refused = 0;
  let netValueMinor = 0;
  let netQty = 0;

  for (const c of input.changes) {
    if (seen.has(c.changeKey)) {
      duplicatesIgnored += 1;
      lines.push({
        changeKey: c.changeKey, outcome: 'already_applied',
        detail: 'seen before — a re-send is a success, because a delta that fails on a retry cannot be resumed at midnight',
      });
      continue;
    }
    if (c.changedAt < input.extractCutoff) {
      refused += 1;
      lines.push({
        changeKey: c.changeKey, outcome: 'refused_before_cutoff',
        detail: `changed ${c.changedAt}, before the extract cutoff ${input.extractCutoff} — it is already in the extract, and applying it again is the double-count MG-09 exists to prevent`,
      });
      continue;
    }

    seen.add(c.changeKey);
    applied += 1;
    netValueMinor += c.deltaMinor ?? 0;
    netQty += c.deltaQty ?? 0;
    lines.push({ changeKey: c.changeKey, outcome: 'applied', detail: `${c.operation} ${c.entity} ${c.legacyId}` });
  }

  return {
    ok: true,
    applied,
    duplicatesIgnored,
    refused,
    lines,
    appliedKeys: [...seen].sort(),
    netValueMinor,
    netQty,
    detail: `${applied} changes applied, ${duplicatesIgnored} already applied, ${refused} refused as pre-cutoff; net ${netValueMinor} minor units and ${netQty} units moved`,
  };
}
