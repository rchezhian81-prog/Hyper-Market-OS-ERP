// Backup manifests and restore verification (M35-FR-01 / QG-08 / §32).
//
// A backup nobody has restored is not a backup. It is a file, and a belief.
//
// The failure is always the same shape: backups have "been running fine for months",
// and on the evening that matters the file is truncated, or encrypted with a key
// nobody kept, or it restores cleanly and is missing the last eleven hours because
// the schedule silently stopped. Every one of those is invisible until you need it.
//
// So a backup here carries a MANIFEST — what was taken, when, how big, its checksum,
// and the CONTROL TOTALS of the data inside it — and a restore is only accepted when
// the restored database reproduces those totals exactly. Not "roughly", not "the
// tables are there": the same row counts and the same summed money, to the paisa.
//
// That is the difference between "the restore command exited zero" and "the business
// is back". A restore that exits zero and loses 300 sales exits zero.
//
// This module is pure: it defines and verifies. The scripts in `scripts/` do the
// actual dumping and restoring and hand their results here.

export interface ControlTotals {
  /** Rows per table — the coarse check that nothing whole went missing. */
  readonly rowCounts: Readonly<Record<string, number>>;
  /**
   * Summed money in minor units, per stream. The check that matters: a restore can
   * have every row and still be wrong if a column was truncated or a type coerced.
   */
  readonly valueTotals?: Readonly<Record<string, number>>;
  /** Highest ledger sequence — proves how far the backup actually reached. */
  readonly maxEventSeq?: number;
  /** Latest event timestamp in the backup — how much time a restore would lose. */
  readonly latestEventAt?: string;
}

export interface BackupManifest {
  readonly backupId: string;
  readonly tenantScope: 'all' | string;
  /** ISO-8601 UTC when the backup STARTED — the recovery point. */
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sizeBytes: number;
  /** SHA-256 of the artefact. A truncated file is caught before it is trusted. */
  readonly checksum: string;
  readonly checksumAlgorithm: 'sha256';
  /** True when the artefact is encrypted at rest (M35-FR-01 requires it). */
  readonly encrypted: boolean;
  /** Where the immutable off-site copy went. No single-device backup (§33). */
  readonly offsiteLocation?: string;
  readonly controlTotals: ControlTotals;
  /** Schema version the backup was taken at — a restore onto an older schema fails. */
  readonly schemaVersion: string;
}

export type BackupVerdict =
  | 'verified'
  | 'checksum_mismatch'
  | 'empty_artefact'
  | 'not_encrypted'
  | 'no_offsite_copy'
  | 'no_control_totals';

export interface BackupCheck {
  readonly backupId: string;
  readonly verdict: BackupVerdict;
  readonly usable: boolean;
  readonly detail: string;
}

/**
 * Check a backup artefact against its manifest, before anyone relies on it.
 * `actualChecksum` and `actualSize` come from the file as it now sits on disk — so a
 * file that rotted after it was written is caught here, not during a recovery.
 */
export function verifyBackup(
  manifest: BackupManifest,
  actual: { readonly checksum: string; readonly sizeBytes: number },
  policy: { readonly requireEncryption: boolean; readonly requireOffsite: boolean },
): BackupCheck {
  const base = { backupId: manifest.backupId };

  if (actual.sizeBytes === 0) {
    return {
      ...base,
      verdict: 'empty_artefact',
      usable: false,
      detail: 'the backup file is empty — the job reported success and produced nothing',
    };
  }
  if (actual.checksum !== manifest.checksum) {
    return {
      ...base,
      verdict: 'checksum_mismatch',
      usable: false,
      detail:
        'the file no longer matches the checksum recorded when it was taken — it is truncated, corrupted or was altered',
    };
  }
  if (Object.keys(manifest.controlTotals.rowCounts).length === 0) {
    return {
      ...base,
      verdict: 'no_control_totals',
      usable: false,
      detail: 'no control totals were recorded, so a restore could not be proven correct',
    };
  }
  if (policy.requireEncryption && !manifest.encrypted) {
    return {
      ...base,
      verdict: 'not_encrypted',
      usable: false,
      detail: 'the backup is not encrypted at rest',
    };
  }
  if (policy.requireOffsite && manifest.offsiteLocation === undefined) {
    return {
      ...base,
      verdict: 'no_offsite_copy',
      usable: false,
      detail: 'there is no immutable off-site copy — a single-device backup is not a backup (§33)',
    };
  }

  return {
    ...base,
    verdict: 'verified',
    usable: true,
    detail: `verified: ${actual.sizeBytes} bytes, checksum matches, ${
      Object.keys(manifest.controlTotals.rowCounts).length
    } table total(s) recorded`,
  };
}

export interface ReconciliationDifference {
  readonly kind: 'row_count' | 'value_total' | 'max_seq';
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  readonly difference: number;
  readonly detail: string;
}

export interface RestoreResult {
  readonly backupId: string;
  readonly restoredAt: string;
  /** Only true when EVERY total matches. There is no "close enough" here. */
  readonly reconciled: boolean;
  readonly differences: readonly ReconciliationDifference[];
  /** How much time the restore loses: backup start → the moment of failure. */
  readonly dataLossSeconds?: number;
  readonly detail: string;
}

/**
 * Reconcile a restored database against the manifest it came from. Every row count
 * and every money total must match exactly; a single difference fails the restore
 * and names what is missing and what it is worth (QG-07 / P-08).
 */
export function reconcileRestore(input: {
  readonly manifest: BackupManifest;
  readonly restored: ControlTotals;
  readonly restoredAt: string;
  /** ISO-8601 UTC of the incident, to measure real data loss against RPO. */
  readonly failedAt?: string;
}): RestoreResult {
  const { manifest, restored } = input;
  const differences: ReconciliationDifference[] = [];

  const tables = new Set([
    ...Object.keys(manifest.controlTotals.rowCounts),
    ...Object.keys(restored.rowCounts),
  ]);
  for (const table of [...tables].sort()) {
    const expected = manifest.controlTotals.rowCounts[table] ?? 0;
    const actual = restored.rowCounts[table] ?? 0;
    if (expected !== actual) {
      differences.push({
        kind: 'row_count',
        name: table,
        expected,
        actual,
        difference: actual - expected,
        detail:
          actual < expected
            ? `${expected - actual} row(s) missing from "${table}" after restore`
            : `${actual - expected} unexpected row(s) in "${table}" — the target was not empty before the restore`,
      });
    }
  }

  const streams = new Set([
    ...Object.keys(manifest.controlTotals.valueTotals ?? {}),
    ...Object.keys(restored.valueTotals ?? {}),
  ]);
  for (const stream of [...streams].sort()) {
    const expected = manifest.controlTotals.valueTotals?.[stream] ?? 0;
    const actual = restored.valueTotals?.[stream] ?? 0;
    if (expected !== actual) {
      differences.push({
        kind: 'value_total',
        name: stream,
        expected,
        actual,
        difference: actual - expected,
        // Every row present and the money still wrong is the case a row count misses.
        detail: `"${stream}" totals ${actual} after restore but ${expected} in the backup — a difference of ${
          actual - expected
        } minor units`,
      });
    }
  }

  if (manifest.controlTotals.maxEventSeq !== undefined) {
    const expected = manifest.controlTotals.maxEventSeq;
    const actual = restored.maxEventSeq ?? 0;
    if (expected !== actual) {
      differences.push({
        kind: 'max_seq',
        name: 'event_ledger.seq',
        expected,
        actual,
        difference: actual - expected,
        detail: `the restored ledger reaches sequence ${actual}, the backup reached ${expected}`,
      });
    }
  }

  const reconciled = differences.length === 0;
  const dataLossSeconds =
    input.failedAt === undefined
      ? undefined
      : Math.max(
          0,
          Math.floor((Date.parse(input.failedAt) - Date.parse(manifest.startedAt)) / 1000),
        );

  return {
    backupId: manifest.backupId,
    restoredAt: input.restoredAt,
    reconciled,
    differences,
    ...(dataLossSeconds !== undefined ? { dataLossSeconds } : {}),
    detail: reconciled
      ? 'restore reconciles exactly against the backup manifest'
      : `${differences.length} difference(s) — this restore is NOT accepted: ${differences
          .map((d) => d.detail)
          .join('; ')}`,
  };
}

/** Roadmap §32 recovery targets, per service. */
export interface RecoveryTarget {
  readonly service: string;
  /** Maximum acceptable data loss, seconds. 0 for committed local sales. */
  readonly rpoSeconds: number;
  /** Maximum acceptable time to be back, seconds. */
  readonly rtoSeconds: number;
}

export const DEFAULT_RECOVERY_TARGETS: readonly RecoveryTarget[] = [
  // §32: committed local sales must not be lost at all.
  { service: 'store-edge (committed sales)', rpoSeconds: 0, rtoSeconds: 1_800 },
  { service: 'cloud', rpoSeconds: 900, rtoSeconds: 14_400 },
];

export interface DrillResult {
  readonly service: string;
  readonly metRpo: boolean;
  readonly metRto: boolean;
  readonly actualDataLossSeconds: number;
  readonly actualRecoverySeconds: number;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Score a recovery drill against its targets. A drill that misses raises a
 * remediation — it is not repeated until it passes and then reported as a pass
 * (M35-FR-02).
 */
export function scoreDrill(input: {
  readonly target: RecoveryTarget;
  readonly dataLossSeconds: number;
  readonly recoverySeconds: number;
}): DrillResult {
  const metRpo = input.dataLossSeconds <= input.target.rpoSeconds;
  const metRto = input.recoverySeconds <= input.target.rtoSeconds;
  const parts: string[] = [];
  if (!metRpo) {
    parts.push(
      `lost ${input.dataLossSeconds}s of data against an RPO of ${input.target.rpoSeconds}s`,
    );
  }
  if (!metRto) {
    parts.push(
      `took ${input.recoverySeconds}s to recover against an RTO of ${input.target.rtoSeconds}s`,
    );
  }
  return {
    service: input.target.service,
    metRpo,
    metRto,
    actualDataLossSeconds: input.dataLossSeconds,
    actualRecoverySeconds: input.recoverySeconds,
    passed: metRpo && metRto,
    detail:
      parts.length === 0
        ? `met both targets: ${input.dataLossSeconds}s data loss, back in ${input.recoverySeconds}s`
        : parts.join('; '),
  };
}

/** Backups that may be removed, and the ones that never may (hard rule #6). */
export function backupsEligibleForRemoval(
  manifests: readonly BackupManifest[],
  asOf: string,
  retentionDays: number,
  /** Always keep at least this many, however old — an empty shelf is not a policy. */
  keepAtLeast = 3,
): readonly BackupManifest[] {
  const sorted = [...manifests].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const cutoff = Date.parse(asOf) - retentionDays * 86_400_000;
  return sorted
    .slice(keepAtLeast)
    .filter((m) => Date.parse(m.startedAt) < cutoff);
}
