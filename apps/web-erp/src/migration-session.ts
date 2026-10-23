// Migration (MG-01…MG-12 · §34 · §34.1 · WF-19 · QG-07 · OD-05 · OD-06 · P-01 · P-08 ·
// hard rule #6 · hard rule #7 · hard rule #10).
//
// The design bar is one line: **no cutover without signed control totals, every exception kept,
// and a rollback that has been performed rather than designed.**
//
// ── The one that was not merely unwired ─────────────────────────────────────
//
// `decideCutover` is the gate on the single most irreversible act in this project: the night SRE
// Hyper Market stops running on the old system. It refuses GO until all eight checks pass, names
// every failure at once, and types `shopKeepsTrading` as the literal `true`.
//
// **It takes those eight as booleans supplied by the caller, and nothing in this codebase ever
// derived one.** Both integration tests and its own unit test hand it a literal with
// `qg07Passed: true`, `parallelRunSufficient: true`, `edgeUnsyncedItems: 0`, `deltaApplied: true`
// typed in by hand — including the test that stands as the Stage 11 gate evidence. The gate has
// never once been asked about the state of the migration. It has only ever been told.
//
// `packages/migration/src/cutover-checklist.ts` is the producer that was missing, and **this
// screen never constructs a checklist of its own**: it derives one, and an unanswerable check
// fails rather than defaulting.
//
// ── And the fifteen beside it ───────────────────────────────────────────────
//
// `inventorySources`, `approveMapping`, `assessCoverage`, `detectExceptions`, `resolveException`,
// `outstandingExceptions`, `buildMergeMap`, `recordControlTotal`, `assessReconciliation`,
// `signControlTotal`, `compareParallelDay`, `ownDifference`, `parallelRunPosition`,
// `proposeExclusion`, `approveExclusion`, `exclusionPosition` and `assessRetirement` were all
// called by nothing outside their own tests — the whole MG pipeline from discovery to retirement,
// which is the largest instance of this codebase's recurring shape so far.
//
// It matters more here than anywhere else because of OB-06: **the owner decided we extract our
// own data ourselves.** Nobody is coming to do this for him, and he is not a programmer. A
// migration pipeline that can only be driven from a test file is a migration nobody can run.
//
// ── What this screen refuses to let anybody believe ─────────────────────────
//
// **That a tick means somebody checked.** Every one of the eight says where its answer came
// from, in the producer's own words, and an answer nothing could give is drawn differently from
// an answer that came back bad — because one is work to finish and the other is a wire that was
// never connected.
//
// **That the rollback is a fallback.** It is one clearly-labelled action, available at any time,
// needing nobody's approval — a rollback that needs an approval chain gets performed an hour
// late, and the hour is the whole cost.
//
// **That a decision made here has been recorded.** The first version of this screen computed a
// signature, showed it in green, and dropped the result on the floor: the next render re-read the
// payload and the total was unsigned again. Found by driving it, not by reading it. A decision is
// now **committed locally and queued** (hard rule #1), the working copy is what the screen draws,
// and what has not yet reached the store computer is **counted on the page** (P-08).

import {
  assessReconciliation, assessRetirement, buildCutoverChecklist, decideCutover,
  exclusionPosition, inventorySources, outstandingExceptions, parallelRunPosition,
  performRollback, resolveException, signControlTotal,
  type ControlTotal, type CutoverDecision, type DerivedChecklist, type DiscoveryResult,
  type ExceptionResolution, type HistoryExclusion, type LegacyArchive, type LegacySource,
  type MigrationException, type OutstandingExceptions, type ParallelDayResult,
  type ParallelDifference, type ParallelRunPosition, type ReconciliationReport,
  type RetirementAssessment, type RollbackResult, type RollbackTrigger, type TeamMember,
  type BackupStanding, type RollbackLimits,
} from '../../../packages/migration/src/index';
import { compareParallelDay, ownDifference, type ComparisonArea, type DayComparison } from '../../../packages/migration/src/cutover';
import { dayDigestOf, signParallelDay, unexplainedDifferences, type DaySignRefusal } from '../../../packages/migration/src/parallel-day-sign';
import { SLICE_FILES, SLICE_TEMPLATES, sliceTemplateCsv, type SliceFile } from '../../../packages/migration/src/slice-import';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { makeEvent } from '../../../packages/contracts/src/event';

/** What this surface can see, and what it honestly cannot. */
export interface MigrationPorts {
  /** Every legacy source discovered (MG-01). Absent means discovery has never been run. */
  sources(): readonly LegacySource[] | undefined;
  /** Every exception ever raised (MG-04). **Never pruned** — resolved ones are the evidence. */
  exceptions(): readonly MigrationException[] | undefined;
  /** Every control total recorded (MG-06). Absent means none has been. */
  totals(): readonly ControlTotal[] | undefined;
  /** Each day both systems were compared (MG-10), with the figures each side gave. Absent means no parallel run. */
  parallelDays(): readonly RecordedDayView[] | undefined;
  /** Every signature a parallel-run day has had, and whether it still applies to the day's figures (MG-10). */
  daySignatures?(): readonly DaySignatureView[] | undefined;
  /** The twelve-domain witness figures from the cloud (STEP-1 §4 item 5). Absent means the box has not been told. */
  verification?(): WitnessView | undefined;
  /** Every difference raised by those comparisons, in whatever state. */
  parallelDifferences(): readonly ParallelDifference[] | undefined;
  /** History exclusions (MG-07), proposed and approved. */
  exclusions(): readonly HistoryExclusion[] | undefined;
  /** The legacy archive (MG-12). Absent means nothing has been archived yet. */
  archive(): LegacyArchive | undefined;
  /**
   * What the store box still holds unsynced, from its own outbox.
   *
   * **`undefined` means nothing told this screen**, which is not the same as none — and an
   * unsynced till is an unmigrated sale.
   */
  edgeUnsyncedItems(): number | undefined;
  /** When the delta since the final extract was applied (MG-09). */
  deltaAppliedAt(): string | undefined;
  /** When a rollback was **performed** (MG-11). A designed one leaves this absent. */
  rollbackDemonstratedAt(): string | undefined;
  /** Who is on the night, with a role each. Absent means nobody has been asked. */
  namedTeam(): readonly TeamMember[] | undefined;
  /** When the owner gave GO. */
  ownerGoBy(): string | undefined;
  /**
   * OB-288 P5 · MG-11: the backup judged against the owner's limit, and the owner's rollback limits — head office's records.
   * Optional: a store box not sent them leaves both NOT KNOWN (each fails its check), never passed.
   */
  backup?(): BackupStanding | undefined;
  rollbackLimits?(): RollbackLimits | undefined;
  /** Assessments still open that could need the legacy records (MG-12). */
  openAssessments(): number | undefined;
  /**
   * Where a decision made on this screen is queued for the cloud.
   *
   * Local first, then sync idempotently (hard rule #1). A signature that exists only in a browser
   * tab is not a signature, and the first version of this screen produced exactly that.
   */
  outbox(): SyncOutbox;
}

/** A compared day as the box carries it: the engine's result, and — when the cloud recorded them — the figures. */
export type RecordedDayView = ParallelDayResult & { readonly comparisons?: readonly DayComparison[]; readonly recordedBy?: string };

/** A day's signature as the box carries it. */
export interface DaySignatureView {
  readonly businessDate: string;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly statement: string;
  readonly dayDigest: string;
  /** False when the day was recorded again with other figures after it was signed. */
  readonly stillApplies?: boolean;
}

/** The twelve-domain witness position, with each domain's figure (MG-06 / QG-07 evidence). */
export interface WitnessView {
  readonly findings?: readonly { readonly domain: string; readonly verdict: string; readonly figureMinor?: number; readonly figureLabel?: string; readonly provedBy?: readonly string[]; readonly whatItCannotProve?: string }[];
  readonly covered?: readonly string[];
  readonly missing?: readonly string[];
  readonly signaturesOverThisPage?: number;
  readonly detail?: string;
}

/** One area of a day as the reconciler types it: both systems' figures, the tolerance, and — if they differ — why. */
export interface DayEntryLine {
  readonly area: ComparisonArea;
  readonly legacyValue: number;
  readonly newValue: number;
  readonly toleranceMinor: number;
  readonly explanation?: string;
  readonly wrongSide?: 'legacy' | 'new' | 'both' | 'neither';
}

export type DayRefusal = 'nobody_is_named_at_this_desk' | 'nobody_named_to_reconcile' | 'not_the_named_reconciler' | 'not_a_date' | 'no_figures' | 'explanation_refused';
export type DaySignScreenRefusal = 'nobody_is_named_at_this_desk' | 'nobody_named_to_reconcile' | DaySignRefusal;

export interface DayView {
  readonly businessDate: string;
  readonly comparisons?: readonly DayComparison[];
  readonly differences: readonly ParallelDifference[];
  /** The differences beyond tolerance that still have no reason — the ones that stop a signature. */
  readonly unexplained: readonly ParallelDifference[];
  readonly signature?: DaySignatureView;
}

export type DayOutcome =
  | { readonly ok: true; readonly day: DayView; readonly detail: string }
  | { readonly ok: false; readonly refusal: DayRefusal; readonly detail: string };

export type DaySignOutcome =
  | { readonly ok: true; readonly signature: DaySignatureView; readonly detail: string }
  | { readonly ok: false; readonly refusal: DaySignScreenRefusal; readonly detail: string; readonly unexplained: readonly ParallelDifference[] };

export interface MigrationConfig {
  readonly tenantId: string;
  /** Who is looking. `null` means the box was not told — nothing may be signed or decided. */
  readonly userId: string | null;
  readonly now: string;
  readonly cutoverId: string;
  /** Consecutive clean days this shop requires before a cutover (§34.1). Per-tenant. */
  readonly requiredCleanDays: number;
  /**
   * Who ran the load.
   *
   * A signer who is also the loader is checking their own work (§28). Absent means the box was
   * never told, and then **nothing can be signed at all** — because a separation that cannot be
   * checked is not a separation.
   */
  readonly loadOperator: string | undefined;
  /** Whether the cutover has been accepted, for the retirement assessment (MG-12). */
  readonly cutoverAccepted: boolean;
  /**
   * The ONE person the owner named to reconcile the parallel run daily (R-05), from the cloud's written terms. Absent:
   * nobody is named, and no day can be entered or signed here.
   */
  readonly dailyReconcilerUserId?: string;
}

export type SignRefusal = 'nobody_is_named_at_this_desk' | 'nobody_ran_the_load' | 'refused';
export type ResolveRefusal = 'nobody_is_named_at_this_desk' | 'needs_a_reason' | 'refused';
export type RollbackRefusal = 'nobody_is_named_at_this_desk' | 'needs_a_reason';

const SIGN_REFUSAL_VALUES: Readonly<Record<SignRefusal, SignRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  nobody_ran_the_load: 'nobody_ran_the_load',
  refused: 'refused',
});
export const SIGN_REFUSAL_KINDS: readonly SignRefusal[] = Object.freeze(Object.values(SIGN_REFUSAL_VALUES));

const RESOLVE_REFUSAL_VALUES: Readonly<Record<ResolveRefusal, ResolveRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  needs_a_reason: 'needs_a_reason',
  refused: 'refused',
});
export const RESOLVE_REFUSAL_KINDS: readonly ResolveRefusal[] = Object.freeze(Object.values(RESOLVE_REFUSAL_VALUES));

const ROLLBACK_REFUSAL_VALUES: Readonly<Record<RollbackRefusal, RollbackRefusal>> = Object.freeze({
  nobody_is_named_at_this_desk: 'nobody_is_named_at_this_desk',
  needs_a_reason: 'needs_a_reason',
});
export const ROLLBACK_REFUSAL_KINDS: readonly RollbackRefusal[] = Object.freeze(Object.values(ROLLBACK_REFUSAL_VALUES));

/** Where the migration stands, and what stops the next step. */
export interface CutoverView {
  readonly derived: DerivedChecklist;
  readonly decision: CutoverDecision;
}

export type SignOutcome =
  | { readonly ok: true; readonly totals: readonly ControlTotal[]; readonly detail: string }
  | { readonly ok: false; readonly refusal: SignRefusal; readonly detail: string };

export type ResolveOutcome =
  | { readonly ok: true; readonly exceptions: readonly MigrationException[]; readonly detail: string }
  | { readonly ok: false; readonly refusal: ResolveRefusal; readonly detail: string };

export type RollbackOutcome =
  | { readonly ok: true; readonly result: RollbackResult }
  | { readonly ok: false; readonly refusal: RollbackRefusal; readonly detail: string };

export interface MigrationSession {
  /** The eight checks, derived — never asserted — with the decision they produce. */
  cutover(): CutoverView;
  /** The old shop: every source and every gap in the inventory (MG-01). */
  discovery(): DiscoveryResult | undefined;
  /** What is wrong with the data, blocking first, and never deleted (MG-04). */
  cleaning(): OutstandingExceptions | undefined;
  /** Every exception in full, worst first. A resolved one stays on the list as evidence. */
  exceptionList(): readonly MigrationException[] | undefined;
  /** Every control total, both sides, and who signed (MG-06 / QG-07). */
  reconciliation(): ReconciliationReport | undefined;
  /** Where the parallel run stands (MG-10). */
  parallel(): ParallelRunPosition | undefined;
  /** Differences with nobody's name on them — the ones §34.1 says must be owned today. */
  unowned(): readonly ParallelDifference[];
  /** What the owner has approved leaving behind (MG-07). */
  exclusions(): ReturnType<typeof exclusionPosition> | undefined;
  /** Whether the legacy system may be switched off — and the data never deleted (MG-12). */
  retirement(): RetirementAssessment | undefined;
  /** Record a decision against an exception. It is updated, never removed (hard rule #6). */
  resolve(input: { readonly exceptionId: string; readonly action: ExceptionResolution['action']; readonly reason: string; readonly survivingLegacyId?: string }): ResolveOutcome;
  /** Sign a control total. Never the person who ran the load (§28). */
  sign(input: { readonly totalId: string; readonly signerRole: string; readonly statement: string }): SignOutcome;
  /** Roll back. One clearly-labelled action, needing nobody's approval. */
  rollback(input: { readonly trigger: RollbackTrigger; readonly legacySystemAvailable: boolean }): RollbackOutcome;
  /** One parallel-run day: both systems' figures, its differences, what still has no reason, and its signature. */
  day(businessDate: string): DayView;
  /**
   * Enter a day (MG-10): the old ERP's totals typed or imported beside the new system's, with a reason on each
   * difference. Committed here and queued for the cloud (hard rule #1); the cloud re-checks the person and the rules.
   */
  enterDay(input: { readonly businessDate: string; readonly lines: readonly DayEntryLine[] }): DayOutcome;
  /** Sign a day. Refused while any difference beyond tolerance has no reason. */
  signDay(input: { readonly businessDate: string; readonly statement: string }): DaySignOutcome;
  /** The witness figures, as the cloud last sent them. */
  witness(): WitnessView | undefined;
  /** The four department-slice CSV templates (OB-241), header line only — the file a person downloads and fills in. */
  sliceTemplates(): readonly { readonly file: SliceFile; readonly csv: string; readonly columns: readonly string[]; readonly required: readonly string[] }[];
  /**
   * Decisions made here that have not yet reached the store computer.
   *
   * Shown on the page. A screen that draws a signature it has not managed to record is the
   * failure P-08 exists to refuse, and it is the one this screen made on its first attempt.
   */
  unsent(): number;
}

export function createMigrationSession(config: MigrationConfig, ports: MigrationPorts): MigrationSession {
  /**
   * Decisions taken on this page, over the top of what the box last sent.
   *
   * The first version of this screen had none of this: `sign` returned a new array of totals and
   * the view dropped it, so a signature showed green and vanished on the next render. Found by
   * driving the real page rather than by reading it.
   *
   * `undefined` here means **nothing has been decided on this page**, and the port's answer stands
   * — never an empty array, which would say the box had sent nothing.
   */
  let workingTotals: readonly ControlTotal[] | undefined;
  let workingExceptions: readonly MigrationException[] | undefined;
  // MG-10: days entered and signed on THIS page, over what the box last sent — drawn at once, queued for the cloud.
  const workingDays = new Map<string, RecordedDayView>();
  let workingDifferences: readonly ParallelDifference[] | undefined;
  const workingSignatures: DaySignatureView[] = [];
  const daysNow = (): readonly RecordedDayView[] | undefined => {
    const sent = ports.parallelDays();
    if (sent === undefined && workingDays.size === 0) return undefined;
    const byDate = new Map<string, RecordedDayView>();
    for (const d of sent ?? []) byDate.set(d.businessDate, d);
    for (const [k, d] of workingDays) byDate.set(k, d);
    return [...byDate.values()];
  };
  const differencesNow = (): readonly ParallelDifference[] | undefined => workingDifferences ?? ports.parallelDifferences();
  const signaturesNow = (): readonly DaySignatureView[] => [...(ports.daySignatures?.() ?? []), ...workingSignatures];
  const shortHash = (text: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, '0');
  };

  const totalsNow = (): readonly ControlTotal[] | undefined => workingTotals ?? ports.totals();
  const exceptionsNow = (): readonly MigrationException[] | undefined =>
    workingExceptions ?? ports.exceptions();

  /** Commit locally and queue idempotently (hard rule #1). Nothing here waits on the cloud. */
  const queue = (type: string, subject: string, payload: Record<string, unknown>): void => {
    ports.outbox().enqueue(makeEvent({
      // Deterministic, so the same decision replayed collapses to one effect (§31.1).
      id: `${type}-${subject}-${config.now}`,
      type,
      occurredAt: config.now,
      idempotencyKey: `${config.tenantId}:${type}:${subject}`,
      source: 'migration-screen',
      payload: { tenantId: config.tenantId, cutoverId: config.cutoverId, ...payload },
    }));
  };

  const reconciliation = (): ReconciliationReport | undefined => {
    const totals = totalsNow();
    // No totals at all is not a reconciliation with nothing wrong. `assessReconciliation` says so
    // itself on an empty list, but it has to be given one to say it — and it never was.
    if (totals === undefined) return undefined;
    return assessReconciliation({ tenantId: config.tenantId, totals });
  };

  const cleaning = (): OutstandingExceptions | undefined => {
    const exceptions = exceptionsNow();
    if (exceptions === undefined) return undefined;
    return outstandingExceptions(exceptions);
  };

  const parallel = (): ParallelRunPosition | undefined => {
    const days = daysNow();
    const differences = differencesNow();
    // Days without differences would report every day clean; differences without days would
    // report no run at all. Both are needed, and neither is defaulted to an empty list.
    if (days === undefined || differences === undefined) return undefined;
    return parallelRunPosition({ days, differences, requiredCleanDays: config.requiredCleanDays });
  };

  const session: MigrationSession = {
    cutover: () => {
      // **Derived, never asserted.** Every one of the eight comes from the producer that owns it,
      // and an input nothing could answer arrives as a failure rather than a default.
      const derived = buildCutoverChecklist({
        cutoverId: config.cutoverId,
        tenantId: config.tenantId,
        evidence: {
          ...(reconciliation() === undefined ? {} : { reconciliation: reconciliation()! }),
          ...(parallel() === undefined ? {} : { parallel: parallel()! }),
          ...(cleaning() === undefined ? {} : { exceptions: cleaning()! }),
          ...(ports.edgeUnsyncedItems() === undefined ? {} : { edgeUnsyncedItems: ports.edgeUnsyncedItems()! }),
          ...(ports.deltaAppliedAt() === undefined ? {} : { deltaAppliedAt: ports.deltaAppliedAt()! }),
          ...(ports.rollbackDemonstratedAt() === undefined ? {} : { rollbackDemonstratedAt: ports.rollbackDemonstratedAt()! }),
          ...(ports.namedTeam() === undefined ? {} : { namedTeam: ports.namedTeam()! }),
          ...(ports.ownerGoBy() === undefined ? {} : { ownerGoBy: ports.ownerGoBy()! }),
          ...(ports.backup?.() === undefined ? {} : { backup: ports.backup!()! }),
          ...(ports.rollbackLimits?.() === undefined ? {} : { rollbackLimits: ports.rollbackLimits!()! }),
        },
      });
      return { derived, decision: decideCutover(derived.checklist) };
    },

    discovery: () => {
      const sources = ports.sources();
      // An empty inventory is not a shop with nothing in it. Discovery that has never run and
      // discovery that found nothing are opposite facts, and only one is possible.
      if (sources === undefined) return undefined;
      return inventorySources({ tenantId: config.tenantId, sources });
    },

    cleaning,

    exceptionList: () => {
      const exceptions = exceptionsNow();
      if (exceptions === undefined) return undefined;
      const rank: Readonly<Record<MigrationException['severity'], number>> = {
        blocking: 0, high: 1, medium: 2, low: 3,
      };
      // Undecided first within each severity — a resolved exception stays on the list because it
      // is the evidence somebody looked at it (hard rule #6), but it is not the working queue.
      return [...exceptions].sort((a, b) =>
        (a.resolution === undefined ? 0 : 1) - (b.resolution === undefined ? 0 : 1)
        || rank[a.severity] - rank[b.severity]
        || (a.exceptionId < b.exceptionId ? -1 : 1));
    },

    reconciliation,

    parallel,

    unowned: () => (differencesNow() ?? [])
      .filter((d) => d.status !== 'resolved' && d.ownerUserId === undefined),

    exclusions: () => {
      const exclusions = ports.exclusions();
      if (exclusions === undefined) return undefined;
      return exclusionPosition(exclusions);
    },

    retirement: () => {
      const archive = ports.archive();
      const openAssessments = ports.openAssessments();
      // Absent open-assessment count is NOT nought. Retiring the legacy system on a number
      // nobody supplied is the one MG-12 mistake that cannot be undone by anybody.
      if (archive === undefined || openAssessments === undefined) return undefined;
      return assessRetirement({
        archive,
        cutoverAccepted: config.cutoverAccepted,
        openAssessments,
        today: config.now.slice(0, 10),
      });
    },

    resolve: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: RESOLVE_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A decision about the old shop’s data carries the name of whoever made it, because in a year that name is the only record that anybody did.',
        };
      }
      if (input.reason.trim() === '') {
        return {
          ok: false,
          refusal: RESOLVE_REFUSAL_VALUES.needs_a_reason,
          detail: 'the reason is the only part of this record anybody reads a year later.',
        };
      }
      const exceptions = exceptionsNow();
      if (exceptions === undefined) {
        return { ok: false, refusal: RESOLVE_REFUSAL_VALUES.refused, detail: 'this screen has not been told what is wrong with the data.' };
      }
      const result = resolveException({
        exceptions,
        exceptionId: input.exceptionId,
        resolution: {
          action: input.action,
          decidedBy: config.userId,
          decidedAt: config.now,
          reason: input.reason,
          ...(input.survivingLegacyId === undefined ? {} : { survivingLegacyId: input.survivingLegacyId }),
        },
      });
      if (!result.ok) {
        return { ok: false, refusal: RESOLVE_REFUSAL_VALUES.refused, detail: result.detail };
      }
      // Held, so the screen draws it — and queued, so it is not only held.
      workingExceptions = result.exceptions;
      queue('MigrationExceptionResolved', input.exceptionId, {
        exceptionId: input.exceptionId,
        action: input.action,
        decidedBy: config.userId,
        reason: input.reason,
        ...(input.survivingLegacyId === undefined ? {} : { survivingLegacyId: input.survivingLegacyId }),
      });
      return { ok: true, exceptions: result.exceptions, detail: result.detail };
    },

    sign: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: SIGN_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A control total carries a signature or it does not count.',
        };
      }
      if (config.loadOperator === undefined) {
        // Not defaulted to somebody who cannot be the signer. A separation of duties that cannot
        // be checked is not a separation, and this is the last place a wrong opening balance can
        // still be stopped.
        return {
          ok: false,
          refusal: SIGN_REFUSAL_VALUES.nobody_ran_the_load,
          detail: 'this screen has not been told who ran the load, so it cannot check that the signer is somebody else (§28) — and a signature that cannot be checked is not a control.',
        };
      }
      const totals = totalsNow();
      if (totals === undefined) {
        return { ok: false, refusal: SIGN_REFUSAL_VALUES.refused, detail: 'this screen has not been told about any control totals.' };
      }
      const result = signControlTotal({
        totals,
        totalId: input.totalId,
        signedBy: config.userId,
        signerRole: input.signerRole,
        loadOperator: config.loadOperator,
        statement: input.statement,
        now: config.now,
      });
      if (!result.ok) {
        return { ok: false, refusal: SIGN_REFUSAL_VALUES.refused, detail: result.detail };
      }
      workingTotals = result.totals;
      queue('MigrationTotalSigned', input.totalId, {
        totalId: input.totalId,
        signedBy: config.userId,
        signerRole: input.signerRole,
        statement: input.statement,
      });
      return { ok: true, totals: result.totals, detail: result.detail };
    },

    rollback: (input) => {
      if (config.userId === null) {
        return {
          ok: false,
          refusal: ROLLBACK_REFUSAL_VALUES.nobody_is_named_at_this_desk,
          detail: 'this store box has not been told who is using this screen. A rollback carries the name of whoever decided it.',
        };
      }
      // Deliberately NOT gated on the checklist, an approval, or a state. A rollback that needs
      // an approval chain gets performed an hour late, and the hour is the whole cost.
      return {
        ok: true,
        result: performRollback({
          cutoverId: config.cutoverId,
          trigger: input.trigger,
          decidedBy: config.userId,
          legacySystemAvailable: input.legacySystemAvailable,
          now: config.now,
        }),
      };
    },

    day: (businessDate) => {
      const recorded = (daysNow() ?? []).find((d) => d.businessDate === businessDate);
      const differences = (differencesNow() ?? []).filter((d) => d.businessDate === businessDate);
      const comparisons = recorded?.comparisons;
      const signature = signaturesNow().filter((sg) => sg.businessDate === businessDate
        && sg.stillApplies !== false && comparisons !== undefined && sg.dayDigest === dayDigestOf(comparisons)).at(-1);
      return {
        businessDate, differences, unexplained: unexplainedDifferences(businessDate, differences),
        ...(comparisons === undefined ? {} : { comparisons }),
        ...(signature === undefined ? {} : { signature }),
      };
    },

    enterDay: (input) => {
      if (config.userId === null) {
        return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this store box has not been told who is using this screen. A day\'s figures carry the name of whoever entered them.' };
      }
      if (config.dailyReconcilerUserId === undefined) {
        return { ok: false, refusal: 'nobody_named_to_reconcile', detail: 'the owner has not named the person who reconciles the parallel run daily (R-05), so no day can be entered.' };
      }
      if (config.userId !== config.dailyReconcilerUserId) {
        return { ok: false, refusal: 'not_the_named_reconciler', detail: `${config.dailyReconcilerUserId} is the person named to reconcile daily; at the store screen only they enter a day (the owner may, at head office).` };
      }
      const date = input.businessDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, refusal: 'not_a_date', detail: 'the business date must be YYYY-MM-DD.' };
      const lines = input.lines.filter((l) => Number.isFinite(l.legacyValue) && Number.isFinite(l.newValue) && Number.isFinite(l.toleranceMinor) && l.toleranceMinor >= 0);
      if (lines.length === 0 || lines.length !== input.lines.length) {
        return { ok: false, refusal: 'no_figures', detail: 'every line needs both systems\' figures and a tolerance of 0 or more — a blank is not a zero.' };
      }
      const comparisons: DayComparison[] = lines.map((l) => ({ area: l.area, legacyValue: l.legacyValue, newValue: l.newValue, toleranceMinor: l.toleranceMinor }));
      const held = (daysNow() ?? []).find((d) => d.businessDate === date);
      let differences = [...(differencesNow() ?? [])];
      let fresh: RecordedDayView | undefined;
      if (held?.comparisons === undefined || dayDigestOf(held.comparisons) !== dayDigestOf(comparisons)) {
        // New figures are a new fact about the day: its differences are raised afresh and need their reasons afresh.
        const result = compareParallelDay({ tenantId: config.tenantId, businessDate: date, comparisons });
        differences = [...differences.filter((d) => d.businessDate !== date), ...result.differences];
        fresh = { ...result, comparisons, recordedBy: config.userId };
      }
      const refusedReasons: string[] = [];
      for (const l of lines) {
        const why = (l.explanation ?? '').trim();
        if (why === '') continue;
        const target = differences.find((d) => d.businessDate === date && d.area === l.area && d.status !== 'resolved');
        if (target === undefined) continue;
        const r = ownDifference({ differences, differenceId: target.differenceId, ownerUserId: config.userId, explanation: why, ...(l.wrongSide === undefined ? {} : { wrongSide: l.wrongSide }) });
        if (!r.ok) { refusedReasons.push(r.detail); continue; }
        differences = [...r.differences];
      }
      if (refusedReasons.length > 0) return { ok: false, refusal: 'explanation_refused', detail: refusedReasons.join('; ') };
      if (fresh !== undefined) workingDays.set(date, fresh);
      workingDifferences = differences;
      const explanations = lines.filter((l) => (l.explanation ?? '').trim() !== '')
        .map((l) => ({ area: l.area, explanation: l.explanation!.trim(), ...(l.wrongSide === undefined ? {} : { wrongSide: l.wrongSide }) }));
      queue('MigrationParallelDayEntered', `${date}:${shortHash(JSON.stringify({ comparisons, explanations }))}`, {
        businessDate: date, enteredBy: config.userId, comparisons, explanations, enteredAt: config.now,
      });
      const day = session.day(date);
      return {
        ok: true, day,
        detail: day.differences.length === 0
          ? `${date}: both systems agree in every area`
          : `${date}: ${day.differences.length} difference(s), ${day.unexplained.length} still without a reason`,
      };
    },

    signDay: (input) => {
      if (config.userId === null) {
        return { ok: false, refusal: 'nobody_is_named_at_this_desk', detail: 'this store box has not been told who is using this screen. A day is signed by a name or not at all.', unexplained: [] };
      }
      if (config.dailyReconcilerUserId === undefined) {
        return { ok: false, refusal: 'nobody_named_to_reconcile', detail: 'the owner has not named the person who reconciles daily (R-05).', unexplained: [] };
      }
      const date = input.businessDate.trim();
      const day = session.day(date);
      const result = signParallelDay({
        businessDate: date, comparisons: day.comparisons, differences: differencesNow() ?? [], signedBy: config.userId,
        statement: input.statement, now: config.now, reconcilerUserId: config.dailyReconcilerUserId, ownerUserId: undefined,
      });
      if (!result.ok) return { ok: false, refusal: result.refusedBecause, detail: result.detail, unexplained: result.unexplained };
      const signature: DaySignatureView = {
        businessDate: date, signedBy: result.signature.signedBy, signedAt: result.signature.signedAt,
        statement: result.signature.statement, dayDigest: result.signature.dayDigest, stillApplies: true,
      };
      workingSignatures.push(signature);
      queue('MigrationParallelDaySigned', `${date}:${signature.dayDigest}`, {
        businessDate: date, signedBy: config.userId, statement: signature.statement, dayDigest: signature.dayDigest, signedAt: config.now,
      });
      return { ok: true, signature, detail: result.detail };
    },

    witness: () => ports.verification?.(),

    sliceTemplates: () => SLICE_FILES.map((file) => ({
      file, csv: sliceTemplateCsv(file), columns: SLICE_TEMPLATES[file].columns, required: SLICE_TEMPLATES[file].required,
    })),

    // What this page has decided and not yet managed to send. Drawn on the page, because a
    // screen showing a signature it could not record is the failure P-08 exists to refuse.
    unsent: () => ports.outbox().pending().length,
  };

  return session;
}
