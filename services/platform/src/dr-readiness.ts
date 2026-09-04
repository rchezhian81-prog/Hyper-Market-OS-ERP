// API-11 DR-drill scoring & backup-retention eligibility (M35-FR-02 / QG-08 / §32 / P-04 "tested
// recovery" / hard rule #6) — on the live API, run on the tested `packages/ops` engine.
//
// Its sibling `backup-verification.ts` proves ONE backup/restore is trustworthy. This is the readiness
// posture around them: can the shop actually come back inside the time the roadmap sets, and which old
// backups may be pruned without ever leaving the shelf bare.
//
//   - `GET  /v1/platform/recovery-targets` — the §32 recovery targets a drill is scored against
//     (committed local sales must not be lost at all: RPO 0). A caller drills TO these.
//   - `POST /v1/platform/dr-drills/score` — score a recovery rehearsal against its target: did it meet
//     the RPO (data loss) AND the RTO (time to be back)? A miss is NAMED (how much was lost / how long it
//     took against the target) — M35-FR-02: a drill that misses raises a remediation, it is not quietly
//     repeated until it passes and then reported as a pass.
//   - `POST /v1/platform/backups/eligible-for-removal` — which aged backups MAY be removed under a
//     retention policy, and — the point — which never may: the newest `keepAtLeast` are kept however old,
//     so a retention sweep can never empty the shelf (hard rule #6). This REPORTS candidates; it never
//     removes anything, and removal itself is a separate governed action, not built here.
//
// Stateless, exactly like the verify/reconcile siblings: the caller (the drill/backup job) supplies the
// facts and this is the ruling. Persisting a drill register — the evidence that recovery passed N quarters
// running — is an honest follow-on, not claimed here. Gated `backup.verify.read` (the M35 recovery-read
// scope), outside `platform.*`, so §28 confinement holds.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  scoreDrill, backupsEligibleForRemoval, DEFAULT_RECOVERY_TARGETS,
  type RecoveryTarget, type BackupManifest,
} from '../../../packages/ops/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function asRecoveryTarget(v: unknown): RecoveryTarget | undefined {
  if (!isObj(v) || !isStr(v['service']) || !isNonNegNum(v['rpoSeconds']) || !isNonNegNum(v['rtoSeconds'])) {
    return undefined;
  }
  return { service: v['service'].trim(), rpoSeconds: v['rpoSeconds'], rtoSeconds: v['rtoSeconds'] };
}

export function drReadinessRoutes(): readonly Route[] {
  return [
    {
      // The §32 targets a drill is measured against — RPO (max data loss) and RTO (max time to be back),
      // per service. Committed local sales carry an RPO of 0: they must not be lost at all.
      api: 'API-11', method: 'GET', path: '/v1/platform/recovery-targets',
      permission: 'backup.verify.read',
      handler: async () => ({
        status: 200,
        body: {
          targets: DEFAULT_RECOVERY_TARGETS,
          note: 'RPO = maximum acceptable data loss (seconds); RTO = maximum acceptable time to be back (seconds). §32.',
        },
      }),
    },
    {
      // Score a recovery rehearsal. Either name a `service` (looked up in the §32 targets) or pass a full
      // `target`; then the drill's real dataLossSeconds and recoverySeconds decide pass/fail.
      api: 'API-11', method: 'POST', path: '/v1/platform/dr-drills/score',
      permission: 'backup.verify.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;

        // Resolve the target: an explicit target wins; otherwise look a named service up in the §32 set.
        let target: RecoveryTarget | undefined;
        if (b['target'] !== undefined) {
          target = asRecoveryTarget(b['target']);
          if (target === undefined) {
            throw apiError(400, {
              code: 'target_not_a_recovery_target',
              whatHappened: 'A { target } must be { service, rpoSeconds, rtoSeconds } with non-negative second counts.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send a valid target, or send a { service } named in GET /v1/platform/recovery-targets.',
            });
          }
        } else if (isStr(b['service'])) {
          const wanted = b['service'].trim();
          target = DEFAULT_RECOVERY_TARGETS.find((t) => t.service === wanted);
          if (target === undefined) {
            throw apiError(400, {
              code: 'unknown_recovery_target',
              whatHappened: `There is no §32 recovery target for service '${wanted}'.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `Use one of: ${DEFAULT_RECOVERY_TARGETS.map((t) => t.service).join(', ')} — or pass a full { target }.`,
            });
          }
        } else {
          throw apiError(400, {
            code: 'drill_needs_a_target',
            whatHappened: 'Scoring a drill needs either a { service } named in the §32 targets or a full { target }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send a service name or a target.',
          });
        }

        if (!isNonNegNum(b['dataLossSeconds']) || !isNonNegNum(b['recoverySeconds'])) {
          throw apiError(400, {
            code: 'drill_needs_measured_seconds',
            whatHappened: 'A drill needs the measured { dataLossSeconds } and { recoverySeconds } — both non-negative numbers.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send how much data the rehearsal lost and how long recovery took.',
          });
        }

        const result = scoreDrill({
          target,
          dataLossSeconds: b['dataLossSeconds'],
          recoverySeconds: b['recoverySeconds'],
        });
        return { status: 200, body: result };
      },
    },
    {
      // Which aged backups MAY be pruned — and, the point, which never may. Reports candidates only; it
      // never removes anything, and the newest keepAtLeast are always kept however old (hard rule #6).
      api: 'API-11', method: 'POST', path: '/v1/platform/backups/eligible-for-removal',
      permission: 'backup.verify.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const manifests = b['manifests'];
        if (!Array.isArray(manifests) || !manifests.every((m) => isObj(m) && isStr(m['backupId']) && isStr(m['startedAt']))) {
          throw apiError(400, {
            code: 'removal_needs_manifests',
            whatHappened: 'This needs { manifests } — an array of backup manifests, each with at least a backupId and startedAt.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the backup manifests to assess.',
          });
        }
        if (!isStr(b['asOf']) || !isNonNegNum(b['retentionDays'])) {
          throw apiError(400, {
            code: 'removal_needs_asof_and_retention',
            whatHappened: 'This needs { asOf } (the moment to assess against) and { retentionDays } (a non-negative retention window).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send asOf and retentionDays.',
          });
        }
        if (b['keepAtLeast'] !== undefined && !isNonNegInt(b['keepAtLeast'])) {
          throw apiError(400, {
            code: 'keep_at_least_not_a_count',
            whatHappened: 'keepAtLeast must be a whole number of at least 0 when given — the floor of backups to keep however old.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send a whole-number floor, or leave it out for the default of 3.',
          });
        }
        const keepAtLeast = (b['keepAtLeast'] as number | undefined) ?? 3;
        const eligible = backupsEligibleForRemoval(
          manifests as unknown as readonly BackupManifest[],
          b['asOf'],
          b['retentionDays'],
          keepAtLeast,
        );
        return {
          status: 200,
          body: {
            eligibleForRemoval: eligible,
            eligibleCount: eligible.length,
            keptCount: manifests.length - eligible.length,
            keepAtLeast,
            retentionDays: b['retentionDays'],
            asOf: b['asOf'],
            note: `the newest ${keepAtLeast} backup(s) are kept however old (hard rule #6); this reports candidates only and removes nothing`,
          },
        };
      },
    },
  ];
}
