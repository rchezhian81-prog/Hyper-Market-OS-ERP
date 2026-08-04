// Source discovery and preservation — MG-01, MG-02 (§34, hard rules #6, #7).
//
// The two steps everybody skips, and the two that decide whether the migration is recoverable.
//
// **MG-01 is not a technical task.** The incumbent ERP's database is the obvious source and the
// least dangerous one, because everyone knows it exists. The migration that goes wrong is the
// one where, three weeks after cutover, somebody mentions that the loyalty points were actually
// kept in a spreadsheet on the manager's laptop, and the supplier credit terms were in a
// notebook. Those are sources. They are just sources nobody wrote down.
//
//   • **A SOURCE NOBODY CLAIMS IS STILL A SOURCE.** An unowned source stays in the inventory,
//     named and unowned, rather than quietly dropping off it. Discovery is not complete while
//     one stands — completeness is the only thing MG-01 actually delivers.
//   • **"WE THINK ABOUT 40,000 PRODUCTS" IS NOT A VOLUME.** An estimated row count cannot
//     reconcile against anything, so a source with an estimate is incomplete until counted.
//   • **A HASH TAKEN AFTER LOADING PROVES NOTHING.** MG-02 seals the extract at extraction and
//     verifies at load. Hashing the file you are about to load tells you the file you are about
//     to load is the file you are about to load.
//   • **THE RAW EXTRACT IS NEVER MODIFIED.** Cleaning produces a *new* artefact pointing back at
//     the sealed one. There is no function here that edits or deletes an extract, and a test
//     asserts their absence — because the day somebody "just fixes one row in the source file"
//     is the day the reconciliation stops meaning anything.
//
// Pure and deterministic: the clock and the hasher are injected, no I/O.

export type SourceKind =
  | 'erp_database'
  | 'pos_database'
  | 'spreadsheet'
  | 'paper'
  | 'third_party_system'
  | 'report_only';

export type VolumeBasis = 'counted' | 'estimated' | 'unknown';

export interface LegacySource {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: SourceKind;
  /** The named person accountable for the content — never a department. */
  readonly ownerUserId?: string;
  readonly rowCount?: number;
  readonly volumeBasis: VolumeBasis;
  /** How long the law or the owner says it must be kept. Drives MG-12, not the load. */
  readonly retentionYears?: number;
  /** Whether we can actually get the data out. Discovered here; blocks nothing else. */
  readonly extractable: boolean;
  readonly notes?: string;
}

export type DiscoveryGapKind =
  | 'no_named_owner'
  | 'volume_estimated'
  | 'volume_unknown'
  | 'no_retention_period'
  | 'not_extractable';

export interface DiscoveryGap {
  readonly sourceId: string;
  readonly name: string;
  readonly kind: DiscoveryGapKind;
  readonly detail: string;
}

export interface DiscoveryResult {
  readonly tenantId: string;
  readonly sources: readonly LegacySource[];
  readonly gaps: readonly DiscoveryGap[];
  /** MG-01 is delivered or it is not. There is no partial discovery. */
  readonly complete: boolean;
  readonly countedRows: number;
  readonly detail: string;
}

/**
 * Inventory the sources and name what is missing from the inventory.
 *
 * The gaps are the output. A discovery report listing four sources cleanly is worth less than
 * one listing four sources and saying *"and nobody owns the loyalty spreadsheet"*.
 */
export function inventorySources(input: {
  readonly tenantId: string;
  readonly sources: readonly LegacySource[];
}): DiscoveryResult {
  const gaps: DiscoveryGap[] = [];

  for (const s of input.sources) {
    if (s.ownerUserId === undefined || s.ownerUserId.trim() === '') {
      gaps.push({
        sourceId: s.sourceId, name: s.name, kind: 'no_named_owner',
        detail: `${s.name} has no named owner — nobody can answer a question about what is in it`,
      });
    }
    if (s.volumeBasis === 'estimated') {
      gaps.push({
        sourceId: s.sourceId, name: s.name, kind: 'volume_estimated',
        detail: `${s.name} row count is an estimate — an estimate cannot reconcile against a load`,
      });
    }
    if (s.volumeBasis === 'unknown' || s.rowCount === undefined) {
      gaps.push({
        sourceId: s.sourceId, name: s.name, kind: 'volume_unknown',
        detail: `${s.name} volume is unknown — it cannot be a control total`,
      });
    }
    if (s.retentionYears === undefined) {
      gaps.push({
        sourceId: s.sourceId, name: s.name, kind: 'no_retention_period',
        detail: `${s.name} has no retention period — MG-12 cannot decide when it may be retired`,
      });
    }
    if (!s.extractable) {
      gaps.push({
        sourceId: s.sourceId, name: s.name, kind: 'not_extractable',
        detail: `${s.name} cannot be extracted as it stands — a route out of it must be agreed`,
      });
    }
  }

  const countedRows = input.sources
    .filter((s) => s.volumeBasis === 'counted')
    .reduce((t, s) => t + (s.rowCount ?? 0), 0);

  const complete = gaps.length === 0;
  return {
    tenantId: input.tenantId,
    sources: input.sources,
    gaps,
    complete,
    countedRows,
    detail: complete
      ? `${input.sources.length} sources, ${countedRows} counted rows, every one owned and measured`
      : `${gaps.length} gaps across ${input.sources.length} sources — discovery is not complete, and a migration that starts here migrates what somebody happened to remember`,
  };
}

// ── MG-02 preservation ────────────────────────────────────────────────────────

/** Injected so the package keeps zero runtime dependencies (§19). */
export type Hasher = (material: string) => string;

export interface SealedExtract {
  readonly extractId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  /** Taken at EXTRACTION. Verifying a hash you computed at load time proves nothing. */
  readonly digest: string;
  readonly rowCount: number;
  readonly extractedAt: string;
  readonly extractedBy: string;
  /** A verified restore of the source, not merely a backup job that reported success. */
  readonly backupVerifiedAt?: string;
  readonly sealed: true;
}

export type PreservationRefusal =
  | 'backup_not_verified'
  | 'empty_extract'
  | 'no_extractor_named';

export interface SealResult {
  readonly ok: boolean;
  readonly extract?: SealedExtract;
  readonly refusedBecause?: PreservationRefusal;
  readonly detail: string;
}

/**
 * Seal a raw extract: hash it, stamp it, and record who took it.
 *
 * **Refused without a verified backup restore.** A backup job that reports success and a backup
 * that restores are different things, and the difference is only ever discovered at the moment
 * it matters. MG-02 says *verified* source backups, and this is where that word is enforced.
 */
export function sealExtract(input: {
  readonly extractId: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly material: string;
  readonly rowCount: number;
  readonly extractedBy: string;
  readonly backupVerifiedAt?: string;
  readonly hasher: Hasher;
  readonly now: string;
}): SealResult {
  if (input.extractedBy.trim() === '') {
    return {
      ok: false, refusedBecause: 'no_extractor_named',
      detail: 'an extract with nobody\'s name on it cannot be questioned later',
    };
  }
  if (input.rowCount <= 0) {
    return {
      ok: false, refusedBecause: 'empty_extract',
      detail: 'an empty extract seals to a valid hash and reconciles to nothing — refused as a mistake, not accepted as a fact',
    };
  }
  if (input.backupVerifiedAt === undefined) {
    return {
      ok: false, refusedBecause: 'backup_not_verified',
      detail: 'MG-02 requires a VERIFIED source backup — a backup job that reported success is not a backup that restores, and the difference is only discovered when it matters',
    };
  }

  return {
    ok: true,
    extract: {
      extractId: input.extractId,
      tenantId: input.tenantId,
      sourceId: input.sourceId,
      digest: input.hasher(input.material),
      rowCount: input.rowCount,
      extractedAt: input.now,
      extractedBy: input.extractedBy,
      backupVerifiedAt: input.backupVerifiedAt,
      sealed: true,
    },
    detail: `sealed ${input.rowCount} rows from ${input.sourceId}`,
  };
}

export interface VerifyResult {
  readonly matches: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly rowCountMatches: boolean;
  readonly detail: string;
}

/**
 * Verify at load time that the bytes about to be loaded are the bytes that were sealed.
 *
 * Both the digest **and** the row count, because they fail differently: a changed digest means
 * the content moved, a changed row count means part of it did not arrive. A truncated extract
 * loads perfectly and reconciles to a smaller, entirely self-consistent shop.
 */
export function verifyExtract(input: {
  readonly extract: SealedExtract;
  readonly material: string;
  readonly rowCount: number;
  readonly hasher: Hasher;
}): VerifyResult {
  const actual = input.hasher(input.material);
  const matches = actual === input.extract.digest;
  const rowCountMatches = input.rowCount === input.extract.rowCount;

  const detail = matches && rowCountMatches
    ? `verified against the seal taken at ${input.extract.extractedAt}`
    : !rowCountMatches && matches
      ? `row count moved from ${input.extract.rowCount} to ${input.rowCount} — part of the extract did not arrive`
      : `digest does not match the seal — this is not the extract that was taken, and loading it would reconcile a different shop`;

  return { matches, expected: input.extract.digest, actual, rowCountMatches, detail };
}

/**
 * A dependency-free FNV-style digest, adequate for chain-of-custody within a rehearsal.
 *
 * Deliberately injected everywhere rather than called directly, so a deployment that needs a
 * cryptographic digest supplies one without touching a single caller.
 */
export function simpleHasher(material: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
