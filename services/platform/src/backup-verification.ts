// API-11 Backup verification & restore reconciliation (M35-FR-01/02, P-04 "tested recovery") — on the
// live API, run on the tested `packages/ops` engine. A backup nobody has verified is a hope, not a
// backup, and the day you find out it was empty is the day you needed it.
//
// `verifyBackup` checks an artefact against its manifest BEFORE anyone relies on it: an empty file (the
// job reported success and produced nothing), a checksum that no longer matches (truncated/corrupted/
// altered), no control totals (a restore could never be proven correct), not encrypted at rest, or no
// off-site copy (a single-device backup is not a backup, §33). `reconcileRestore` then proves a RESTORE
// correct: every row count and every money total must match EXACTLY — there is no "close enough" — and a
// single difference names what is missing and what it is worth, plus how much time the restore lost.
//
// Stateless: the caller (the backup/restore job) supplies the manifest and the file/DB facts; this is the
// ruling on whether recovery can be trusted, not a store of backups.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  verifyBackup, reconcileRestore,
  type BackupManifest, type ControlTotals,
} from '../../../packages/ops/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function backupVerificationRoutes(): readonly Route[] {
  return [
    {
      // Is this backup artefact trustworthy? Read modelled as POST (a manifest in the body).
      api: 'API-11', method: 'POST', path: '/v1/platform/backups/verify',
      permission: 'backup.verify.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const actual = b['actual'];
        const policy = b['policy'];
        if (!isObj(b['manifest']) || !isObj(actual) || typeof actual['checksum'] !== 'string' || typeof actual['sizeBytes'] !== 'number' || !isObj(policy) || typeof policy['requireEncryption'] !== 'boolean' || typeof policy['requireOffsite'] !== 'boolean') {
          throw apiError(400, {
            code: 'verify_needs_manifest_actual_policy',
            whatHappened: 'Verifying a backup needs the manifest, the artefact’s actual { checksum, sizeBytes } as it sits on disk, and a policy { requireEncryption, requireOffsite }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the manifest, the file’s real checksum and size, and the policy.',
          });
        }
        const check = verifyBackup(
          b['manifest'] as unknown as BackupManifest,
          { checksum: actual['checksum'], sizeBytes: actual['sizeBytes'] },
          { requireEncryption: policy['requireEncryption'], requireOffsite: policy['requireOffsite'] },
        );
        return { status: 200, body: check };
      },
    },
    {
      // Did the restore come back whole? Every total must match exactly, or the restore fails and says why.
      api: 'API-11', method: 'POST', path: '/v1/platform/backups/reconcile-restore',
      permission: 'backup.verify.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const restored = b['restored'];
        if (!isObj(b['manifest']) || !isObj(restored) || !isObj(restored['rowCounts']) || typeof b['restoredAt'] !== 'string') {
          throw apiError(400, {
            code: 'reconcile_needs_manifest_restored_at',
            whatHappened: 'Reconciling a restore needs the manifest, the restored control totals { rowCounts, valueTotals? }, and restoredAt.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the manifest, the restored database’s totals and the restore time.',
          });
        }
        const result = reconcileRestore({
          manifest: b['manifest'] as unknown as BackupManifest,
          restored: restored as unknown as ControlTotals,
          restoredAt: b['restoredAt'],
          ...(typeof b['failedAt'] === 'string' ? { failedAt: b['failedAt'] } : {}),
        });
        return { status: 200, body: result };
      },
    },
  ];
}
