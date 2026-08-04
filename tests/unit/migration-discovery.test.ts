import { describe, it, expect } from 'vitest';
import {
  inventorySources, sealExtract, verifyExtract, simpleHasher, type LegacySource,
} from '../../packages/migration/src/discovery';
import * as discovery from '../../packages/migration/src/discovery';

// MG-01 / MG-02 — the two steps everybody skips, and the two that decide whether the migration
// is recoverable.

const source = (over: Partial<LegacySource> = {}): LegacySource => ({
  sourceId: 'src-erp', tenantId: 't-sre', name: 'Incumbent ERP database', kind: 'erp_database',
  ownerUserId: 'u-manager', rowCount: 41_200, volumeBasis: 'counted', retentionYears: 8,
  extractable: true, ...over,
});

describe('discovery is complete or it is not', () => {
  it('accepts an inventory where every source is owned, counted and dated', () => {
    const r = inventorySources({ tenantId: 't-sre', sources: [source(), source({ sourceId: 'src-pos', name: 'POS database', kind: 'pos_database', rowCount: 900_000 })] });
    expect(r.complete).toBe(true);
    expect(r.countedRows).toBe(941_200);
  });

  it('keeps an UNOWNED source in the inventory rather than dropping it', () => {
    const spreadsheet = source({
      sourceId: 'src-loyalty', name: 'Loyalty points spreadsheet', kind: 'spreadsheet',
      ownerUserId: undefined,
    });
    const r = inventorySources({ tenantId: 't-sre', sources: [source(), spreadsheet] });

    // The point: it is still there, named, and it is why discovery is not complete.
    expect(r.sources).toHaveLength(2);
    expect(r.complete).toBe(false);
    expect(r.gaps.some((g) => g.kind === 'no_named_owner' && g.sourceId === 'src-loyalty')).toBe(true);
    expect(r.detail).toContain('migrates what somebody happened to remember');
  });

  it('refuses an ESTIMATED volume — an estimate cannot be a control total', () => {
    const r = inventorySources({ tenantId: 't-sre', sources: [source({ volumeBasis: 'estimated', rowCount: 40_000 })] });
    expect(r.complete).toBe(false);
    expect(r.gaps.map((g) => g.kind)).toContain('volume_estimated');
    // And it is excluded from the counted total, so it cannot silently become one.
    expect(r.countedRows).toBe(0);
  });

  it('names every gap on one source at once, not the first', () => {
    const paper = source({
      sourceId: 'src-book', name: 'Supplier terms notebook', kind: 'paper',
      ownerUserId: undefined, rowCount: undefined, volumeBasis: 'unknown',
      retentionYears: undefined, extractable: false,
    });
    const kinds = inventorySources({ tenantId: 't-sre', sources: [paper] }).gaps.map((g) => g.kind).sort();
    expect(kinds).toEqual(['no_named_owner', 'no_retention_period', 'not_extractable', 'volume_unknown']);
  });
});

describe('a hash taken after loading proves nothing', () => {
  const material = 'row1|row2|row3';

  it('seals an extract with a digest, a row count and a name', () => {
    const r = sealExtract({
      extractId: 'ex-1', tenantId: 't-sre', sourceId: 'src-erp', material, rowCount: 3,
      extractedBy: 'u-operator', backupVerifiedAt: '2026-08-04T20:00:00Z',
      hasher: simpleHasher, now: '2026-08-04T21:00:00Z',
    });
    expect(r.ok).toBe(true);
    expect(r.extract?.sealed).toBe(true);
    expect(r.extract?.digest).toHaveLength(16);
  });

  it('REFUSES to seal without a VERIFIED backup restore', () => {
    const r = sealExtract({
      extractId: 'ex-1', tenantId: 't-sre', sourceId: 'src-erp', material, rowCount: 3,
      extractedBy: 'u-operator', hasher: simpleHasher, now: '2026-08-04T21:00:00Z',
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('backup_not_verified');
    expect(r.detail).toContain('a backup job that reported success is not a backup that restores');
  });

  it('refuses an empty extract and an unnamed extractor', () => {
    const base = {
      extractId: 'ex-1', tenantId: 't-sre', sourceId: 'src-erp', material,
      backupVerifiedAt: '2026-08-04T20:00:00Z', hasher: simpleHasher, now: '2026-08-04T21:00:00Z',
    };
    expect(sealExtract({ ...base, rowCount: 0, extractedBy: 'u-operator' }).refusedBecause).toBe('empty_extract');
    expect(sealExtract({ ...base, rowCount: 3, extractedBy: '  ' }).refusedBecause).toBe('no_extractor_named');
  });

  it('verifies the same bytes, and catches changed content', () => {
    const sealed = sealExtract({
      extractId: 'ex-1', tenantId: 't-sre', sourceId: 'src-erp', material, rowCount: 3,
      extractedBy: 'u-operator', backupVerifiedAt: '2026-08-04T20:00:00Z',
      hasher: simpleHasher, now: '2026-08-04T21:00:00Z',
    }).extract!;

    expect(verifyExtract({ extract: sealed, material, rowCount: 3, hasher: simpleHasher }).matches).toBe(true);

    const tampered = verifyExtract({ extract: sealed, material: 'row1|row2|row9', rowCount: 3, hasher: simpleHasher });
    expect(tampered.matches).toBe(false);
    expect(tampered.detail).toContain('would reconcile a different shop');
  });

  it('catches a TRUNCATED extract separately — it loads perfectly and reconciles a smaller shop', () => {
    const sealed = sealExtract({
      extractId: 'ex-1', tenantId: 't-sre', sourceId: 'src-erp', material, rowCount: 3,
      extractedBy: 'u-operator', backupVerifiedAt: '2026-08-04T20:00:00Z',
      hasher: simpleHasher, now: '2026-08-04T21:00:00Z',
    }).extract!;

    const short = verifyExtract({ extract: sealed, material, rowCount: 2, hasher: simpleHasher });
    expect(short.matches).toBe(true);
    expect(short.rowCountMatches).toBe(false);
    expect(short.detail).toContain('part of the extract did not arrive');
  });
});

describe('the raw extract is never modified', () => {
  it('exposes no function that edits or deletes a sealed extract', () => {
    // Absence as a control. A sealed extract that can be edited is a seal in name only, and
    // "just fix one row in the source file" is the day the reconciliation stops meaning anything.
    const names = Object.keys(discovery);
    for (const forbidden of ['deleteExtract', 'editExtract', 'updateExtract', 'reseal', 'unsealExtract', 'purgeExtract']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
