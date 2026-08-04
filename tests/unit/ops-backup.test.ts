import { describe, it, expect } from 'vitest';
import {
  verifyBackup,
  reconcileRestore,
  scoreDrill,
  backupsEligibleForRemoval,
  DEFAULT_RECOVERY_TARGETS,
  type BackupManifest,
} from '../../packages/ops/src/index';

// M35-FR-01/02 — a backup nobody has restored is not a backup; it is a file, and a
// belief. Every check here exists because of a specific way that belief fails.

const POLICY = { requireEncryption: true, requireOffsite: true };

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    backupId: 'bk-1',
    tenantScope: 'all',
    startedAt: '2026-08-04T01:00:00Z',
    completedAt: '2026-08-04T01:02:00Z',
    sizeBytes: 19_166,
    checksum: 'abc123',
    checksumAlgorithm: 'sha256',
    encrypted: true,
    offsiteLocation: 's3://immutable/backups',
    schemaVersion: '0004_append_only_guards.sql',
    controlTotals: {
      rowCounts: { event_ledger: 201, config_versions: 1, sync_outbox: 0, schema_migrations: 4 },
      valueTotals: { SaleCommitted: 2_773_200 },
      maxEventSeq: 203,
      latestEventAt: '2026-08-04T00:59:00Z',
    },
    ...over,
  };
}

describe('verifyBackup — before anyone relies on it', () => {
  it('verifies a good backup', () => {
    const check = verifyBackup(manifest(), { checksum: 'abc123', sizeBytes: 19_166 }, POLICY);
    expect(check.verdict).toBe('verified');
    expect(check.usable).toBe(true);
  });

  it('rejects a file that rotted after it was written', () => {
    const check = verifyBackup(manifest(), { checksum: 'different', sizeBytes: 19_166 }, POLICY);
    expect(check.usable).toBe(false);
    expect(check.verdict).toBe('checksum_mismatch');
    expect(check.detail).toContain('truncated, corrupted or was altered');
  });

  it('rejects the job that reported success and produced nothing', () => {
    const check = verifyBackup(manifest(), { checksum: 'abc123', sizeBytes: 0 }, POLICY);
    expect(check.verdict).toBe('empty_artefact');
    expect(check.detail).toContain('reported success and produced nothing');
  });

  it('rejects a backup that cannot be proven, encrypted, or kept off-site', () => {
    expect(
      verifyBackup(
        manifest({ controlTotals: { rowCounts: {} } }),
        { checksum: 'abc123', sizeBytes: 100 },
        POLICY,
      ).verdict,
    ).toBe('no_control_totals');

    expect(
      verifyBackup(manifest({ encrypted: false }), { checksum: 'abc123', sizeBytes: 100 }, POLICY)
        .verdict,
    ).toBe('not_encrypted');

    const single = verifyBackup(
      manifest({ offsiteLocation: undefined }),
      { checksum: 'abc123', sizeBytes: 100 },
      POLICY,
    );
    expect(single.verdict).toBe('no_offsite_copy');
    expect(single.detail).toContain('a single-device backup is not a backup');
  });

  it('lets a local, unencrypted backup pass when policy does not require otherwise', () => {
    const check = verifyBackup(
      manifest({ encrypted: false, offsiteLocation: undefined }),
      { checksum: 'abc123', sizeBytes: 100 },
      { requireEncryption: false, requireOffsite: false },
    );
    expect(check.usable).toBe(true);
  });
});

describe('reconcileRestore — exits zero is not the same as recovered', () => {
  it('accepts a restore that reproduces every total exactly', () => {
    const result = reconcileRestore({
      manifest: manifest(),
      restored: manifest().controlTotals,
      restoredAt: '2026-08-04T02:00:00Z',
    });
    expect(result.reconciled).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it('fails a restore that is missing rows, and says how many', () => {
    const result = reconcileRestore({
      manifest: manifest(),
      restored: { ...manifest().controlTotals, rowCounts: { ...manifest().controlTotals.rowCounts, event_ledger: 198 } },
      restoredAt: '2026-08-04T02:00:00Z',
    });
    expect(result.reconciled).toBe(false);
    expect(result.differences[0]?.detail).toContain('3 row(s) missing from "event_ledger"');
    expect(result.detail).toContain('NOT accepted');
  });

  it('catches the case a row count misses — every row present, money still wrong', () => {
    const result = reconcileRestore({
      manifest: manifest(),
      restored: { ...manifest().controlTotals, valueTotals: { SaleCommitted: 2_773_100 } },
      restoredAt: '2026-08-04T02:00:00Z',
    });
    expect(result.reconciled).toBe(false);
    expect(result.differences[0]?.kind).toBe('value_total');
    expect(result.differences[0]?.difference).toBe(-100);
  });

  it('notices a target that was not empty before the restore', () => {
    const result = reconcileRestore({
      manifest: manifest(),
      restored: { ...manifest().controlTotals, rowCounts: { ...manifest().controlTotals.rowCounts, event_ledger: 205 } },
      restoredAt: '2026-08-04T02:00:00Z',
    });
    expect(result.differences[0]?.detail).toContain('the target was not empty');
  });

  it('reports how far the ledger reached, and how much time the restore loses', () => {
    const short = reconcileRestore({
      manifest: manifest(),
      restored: { ...manifest().controlTotals, maxEventSeq: 190 },
      restoredAt: '2026-08-04T02:00:00Z',
    });
    expect(short.differences[0]?.detail).toContain('reaches sequence 190, the backup reached 203');

    const withLoss = reconcileRestore({
      manifest: manifest(),
      restored: manifest().controlTotals,
      restoredAt: '2026-08-04T02:00:00Z',
      failedAt: '2026-08-04T01:20:00Z',
    });
    expect(withLoss.dataLossSeconds).toBe(1_200); // backup started 01:00, failure 01:20
  });
});

describe('scoreDrill — a drill that misses raises a remediation', () => {
  const cloud = DEFAULT_RECOVERY_TARGETS.find((t) => t.service === 'cloud')!;
  const store = DEFAULT_RECOVERY_TARGETS.find((t) => t.service.startsWith('store-edge'))!;

  it('passes a drill inside both targets', () => {
    const result = scoreDrill({ target: cloud, dataLossSeconds: 300, recoverySeconds: 3_600 });
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('met both targets');
  });

  it('fails on data loss and on time, naming the target it missed', () => {
    const slow = scoreDrill({ target: cloud, dataLossSeconds: 1_800, recoverySeconds: 20_000 });
    expect(slow.passed).toBe(false);
    expect(slow.metRpo).toBe(false);
    expect(slow.metRto).toBe(false);
    expect(slow.detail).toContain('against an RPO of 900s');
    expect(slow.detail).toContain('against an RTO of 14400s');
  });

  it('holds committed local sales to RPO 0 — losing one is a failed drill (§32)', () => {
    expect(scoreDrill({ target: store, dataLossSeconds: 0, recoverySeconds: 900 }).passed).toBe(true);
    // A single second of lost committed sales fails, by design.
    expect(scoreDrill({ target: store, dataLossSeconds: 1, recoverySeconds: 900 }).metRpo).toBe(false);
  });
});

describe('backupsEligibleForRemoval — never an empty shelf', () => {
  const backups = [1, 2, 3, 4, 5, 6].map((d) =>
    manifest({ backupId: `bk-${d}`, startedAt: `2026-0${d < 6 ? '7' : '8'}-0${d} T01:00:00Z`.replace(' ', '') }),
  );

  it('keeps a minimum number however old they are', () => {
    const removable = backupsEligibleForRemoval(backups, '2026-12-01T00:00:00Z', 30);
    expect(removable.length).toBe(backups.length - 3);
  });

  it('keeps everything inside the retention window', () => {
    expect(backupsEligibleForRemoval(backups, '2026-08-07T00:00:00Z', 365)).toEqual([]);
  });
});
