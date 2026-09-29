// The migration screen's FEED — what the store box pulls so the screen at the box shows the cloud's
// register rather than a file somebody copied onto the box (Stage C3b). MG-04, MG-06, MG-10, §28, §31, P-08.
//
// Until this slice the migration screen read every one of its sections from the store pack, and the store
// pack was a file read once at boot (`EDGE_PACK_FILE`) that nothing on the cloud produced — the migration
// sections were only ever set by tests. C3a made the screen's DECISIONS land on the cloud; this makes the
// cloud's REGISTER land on the screen, so a person at the box on the night sees the same exceptions,
// totals, days and differences the desk sees, with the decisions already taken folded in.
//
// One route, one permission, one shape. It is a READ: it invents nothing and defaults nothing. A section
// the ledger holds no record for is ABSENT from the feed, and the box keeps it absent, because "no
// exceptions recorded" and "clean data" are different facts and the cutover gate is built to tell them
// apart (the guardrail `the-cutover-gate-is-never-ticked` polices the consumer; this file polices itself
// in `tests/unit/migration-screen-route.test.ts`).
//
// What the cloud can and cannot say:
//   • the parallel-run terms (MG-10) are the one place a cutover has an id and a required clean-day count
//     on the cloud — so `policy` is present exactly when the owner has written them;
//   • who ran the load is a ledger fact (the extraction run), never a body field (§28);
//   • a rollback DEMONSTRATED is the latest rollback PERFORMED — a designed one leaves it absent;
//   • the cutover decision itself, the delta applied, the named team and the owner's GO are NOT recorded
//     on the cloud today; the box keeps whatever it was told about them and this feed never overwrites it.

import type { Route } from '../../kernel/src/index';
import type { MigrationException } from '../../../packages/migration/src/cleaning';
import type { ControlTotal } from '../../../packages/migration/src/reconcile';
import type { ParallelDifference } from '../../../packages/migration/src/cutover';
import type { HistoryExclusion } from '../../../packages/migration/src/history';
import { assertSafeTarget } from './guards';
import { ledgerCutoverEvidence, type ParallelRunPolicy, type RecordedParallelDay, type RecordedRollback } from './parallel-run';
import { ALL_DOMAINS, applicableSignatures, findingsDigest } from './witness';
import type { RefusedDecision } from './decisions';
import type { MigrationDeps } from './index';

/** The owner's written parallel-run terms as the screen needs them (MG-10, §34.1). */
export type MigrationScreenPolicy = Pick<ParallelRunPolicy, 'cutoverId' | 'requiredCleanDays' | 'maxParallelDays' | 'startedOn' | 'dailyReconcilerUserId'>;

/** Where the twelve-domain verification report stands (MG-05 / QG-07 evidence, Stage B2). */
export interface MigrationScreenVerification {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
  readonly ownerKnown: boolean;
  readonly extractionOperatorKnown: boolean;
  readonly signaturesOverThisPage: number;
  readonly detail: string;
}

/**
 * Everything the migration screen reads that the cloud can vouch for. Every optional section is optional
 * because its ABSENCE means something the screen must keep meaning (see the file comment).
 */
export interface MigrationScreenFeed {
  readonly tenantId: string;
  /** The cloud's own clock when this was assembled — the screen's "as of" (P-08), never the box's boot time. */
  readonly generatedAt: string;
  /** Present exactly when the owner has written the parallel-run terms; that is when a cutover has an id. */
  readonly policy?: MigrationScreenPolicy;
  /** Who ran the extraction/load (§28). Absent means nothing can be signed at all. */
  readonly loadOperator?: string;
  /** When a rollback was PERFORMED, the latest. Absent when none has been — a designed one does not count. */
  readonly rollbackDemonstratedAt?: string;
  /** Every exception ever recorded, resolutions folded in, never pruned (#6). Absent until a cleaning pass is recorded. */
  readonly exceptions?: readonly MigrationException[];
  /** Every control total recorded, signatures folded in. Absent until one is recorded. */
  readonly totals?: readonly ControlTotal[];
  /** Relayed decisions the cloud could not accept (hard rule #10). A register, so an empty list is a fact. */
  readonly refusedDecisions: readonly RefusedDecision[];
  /** Present once the run has terms — possibly empty (a run with no reconciled day yet). */
  readonly parallelDays?: readonly RecordedParallelDay[];
  readonly parallelDifferences?: readonly ParallelDifference[];
  /** Every rollback decided, performed or not. A register, so an empty list is a fact. */
  readonly rollbacks: readonly RecordedRollback[];
  /** Present once at least one history exclusion has been proposed (MG-07). */
  readonly exclusions?: readonly HistoryExclusion[];
  readonly verification: MigrationScreenVerification;
}

/** Assemble the feed from the ledger. Exported so the composition root and the tests share one assembly. */
export async function migrationScreenFeed(deps: MigrationDeps, tenantId: string): Promise<MigrationScreenFeed> {
  const policy = deps.parallelPolicy === undefined ? undefined : await deps.parallelPolicy(tenantId);
  const loadOperator = await deps.extractionOperator(tenantId);
  const { rollbackDemonstratedAt } = await ledgerCutoverEvidence(deps, tenantId);
  const exceptions = deps.exceptions === undefined ? [] : await deps.exceptions(tenantId);
  const totals = deps.controlTotals === undefined ? [] : await deps.controlTotals(tenantId);
  const refused = deps.refusedDecisions === undefined ? [] : await deps.refusedDecisions(tenantId);
  const rollbacks = deps.rollbacks === undefined ? [] : await deps.rollbacks(tenantId);
  const exclusions = await deps.exclusions(tenantId);

  // The verification page's position, computed exactly as `GET /v1/migration/verification/progress` does,
  // so the screen and the desk cannot disagree about which domains still have no finding.
  const findings = await deps.findings(tenantId);
  const covered = new Set(findings.map((f) => f.domain));
  const missing = ALL_DOMAINS.filter((d) => !covered.has(d));
  const ownerId = await deps.ownerId(tenantId);
  const signatures = await deps.signatures(tenantId);
  const verification: MigrationScreenVerification = {
    covered: [...covered].sort(),
    missing,
    ownerKnown: ownerId !== undefined,
    extractionOperatorKnown: loadOperator !== undefined,
    signaturesOverThisPage: applicableSignatures(signatures, findingsDigest(findings)).length,
    detail: missing.length === 0
      ? `all ${ALL_DOMAINS.length} domains have a finding`
      : `${covered.size} of ${ALL_DOMAINS.length} domains have a finding; still missing: ${missing.join(', ')}`,
  };

  return {
    tenantId,
    generatedAt: deps.now(),
    ...(policy === undefined ? {} : {
      policy: {
        cutoverId: policy.cutoverId, requiredCleanDays: policy.requiredCleanDays, maxParallelDays: policy.maxParallelDays,
        startedOn: policy.startedOn, dailyReconcilerUserId: policy.dailyReconcilerUserId,
      },
    }),
    ...(loadOperator === undefined ? {} : { loadOperator }),
    ...(rollbackDemonstratedAt === undefined ? {} : { rollbackDemonstratedAt }),
    ...(exceptions.length === 0 ? {} : { exceptions }),
    ...(totals.length === 0 ? {} : { totals }),
    refusedDecisions: refused,
    // The run's days and differences exist as a register only once the run has terms. Before that, "no
    // days" is not "zero clean days of a run" — it is no run — and the screen must not read it as either.
    ...(policy === undefined ? {} : {
      parallelDays: deps.parallelDays === undefined ? [] : await deps.parallelDays(tenantId),
      parallelDifferences: deps.parallelDifferences === undefined ? [] : await deps.parallelDifferences(tenantId),
    }),
    rollbacks,
    ...(exclusions.length === 0 ? {} : { exclusions }),
    verification,
  };
}

export function screenRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      // The store box pulls this on its sync loop (edge/sync-agent `pullMigrationFeed`) and lays it over the
      // migration sections of its store pack; the desk may read it too. A read — idempotent by nature.
      api: 'API-12', method: 'GET', path: '/v1/migration/screen',
      permission: 'migration.screen.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        return { status: 200, body: await migrationScreenFeed(deps, ctx.tenantId) };
      },
    },
  ];
}
