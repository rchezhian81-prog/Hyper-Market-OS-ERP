import { describe, it, expect } from 'vitest';
import {
  detectExceptions, resolveException, buildMergeMap, outstandingExceptions,
  type MigrationException,
} from '../../packages/migration/src/cleaning';
import * as cleaning from '../../packages/migration/src/cleaning';
import { generateLegacyDataset } from '../../packages/migration/src/synthetic';
import { approveMapping, type MappingTable } from '../../packages/migration/src/mapping';

// MG-04 — cleaning proposes, people decide, and every finding is kept (hard rule #6).

const TAX_TABLE: MappingTable = approveMapping({
  table: {
    mappingId: 'map-tax', tenantId: 't-sre', version: 1, status: 'draft',
    entries: ['T0', 'T5', 'T12', 'T18', 'T28'].map((v) => ({
      domain: 'tax_code' as const, legacyValue: v, targetValue: `GST_${v.slice(1)}`,
      rationale: 'rate carried across as recorded',
    })),
  },
  approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z',
}).table!;

const damaged = generateLegacyDataset();
const report = detectExceptions({
  tenantId: 't-sre', dataset: damaged, mappingTable: TAX_TABLE, rateRevisionDate: '2020-01-01',
});

/** The rehearsal's central claim: the detector found exactly what was planted, and nothing else. */
const PLANTED_TO_KIND = {
  duplicate_products: 'duplicate_product',
  shared_barcodes: 'shared_barcode',
  negative_stock: 'negative_stock',
  missing_expiry: 'batch_without_expiry',
  duplicate_customers: 'duplicate_customer',
  duplicate_suppliers_by_gstin: 'duplicate_supplier_gstin',
  document_total_mismatch: 'document_total_mismatch',
  orphan_lines: 'orphan_line',
  unmapped_tax_code: 'unmapped_tax_code',
  stale_tax_codes: 'pre_revision_tax_document',
} as const;

describe('every planted fault is found, by identity and not by count', () => {
  it('finds EXACTLY the planted number of each of the ten fault kinds', () => {
    for (const [plantedKey, exceptionKind] of Object.entries(PLANTED_TO_KIND)) {
      expect(
        report.byKind[exceptionKind] ?? 0,
        `${exceptionKind}: found ${report.byKind[exceptionKind] ?? 0}, planted ${damaged.plantedFaults[plantedKey as keyof typeof damaged.plantedFaults]}`,
      ).toBe(damaged.plantedFaults[plantedKey as keyof typeof damaged.plantedFaults]);
    }
  });

  it('finds every planted record BY ID — a count can be right while the records are wrong', () => {
    const found = new Set(report.exceptions.flatMap((e) => e.legacyIds));
    for (const [kind, ids] of Object.entries(damaged.plantedIds)) {
      const missed = ids.filter((id) => !found.has(id));
      expect(missed, `${kind} missed: ${missed.slice(0, 3).join(', ')}`).toHaveLength(0);
    }
  });

  it('finds NOTHING on clean data — a detector that always fires detects nothing', () => {
    const clean = generateLegacyDataset({ withFaults: false });
    const r = detectExceptions({
      tenantId: 't-sre', dataset: clean, mappingTable: TAX_TABLE, rateRevisionDate: '2020-01-01',
    });
    expect(r.exceptions).toHaveLength(0);
    expect(r.detail).toContain('every record maps, balances and stands on its own');
  });

  it('is deterministic — the same seed gives the same findings', () => {
    const again = detectExceptions({
      tenantId: 't-sre', dataset: generateLegacyDataset(), mappingTable: TAX_TABLE, rateRevisionDate: '2020-01-01',
    });
    expect(again.byKind).toEqual(report.byKind);
  });

  it('does not judge tax codes at all when no approved mapping was supplied', () => {
    // Guessing is worse than not looking. Without MG-03 there is nothing to judge against.
    const r = detectExceptions({ tenantId: 't-sre', dataset: damaged, rateRevisionDate: '2020-01-01' });
    expect(r.byKind['unmapped_tax_code']).toBeUndefined();
  });
});

describe('cleaning proposes, it never decides', () => {
  it('changes nothing, and says so as a value rather than a promise', () => {
    expect(report.nothingWasModified).toBe(true);
    const before = JSON.stringify(damaged.products.slice(0, 20));
    detectExceptions({ tenantId: 't-sre', dataset: damaged, mappingTable: TAX_TABLE });
    expect(JSON.stringify(damaged.products.slice(0, 20))).toBe(before);
  });

  it('exposes no function that merges, corrects or drops a record by itself', () => {
    const names = Object.keys(cleaning);
    for (const forbidden of [
      'autoMerge', 'applyCleaning', 'mergeProducts', 'deleteDuplicates', 'fixNegativeStock',
      'discardException', 'clearExceptions', 'purgeExceptions', 'deleteException',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('separates CERTAIN from PROBABLE — two products that look identical are sometimes two products', () => {
    const duplicates = report.exceptions.filter((e) => e.kind === 'duplicate_product');
    expect(duplicates.every((e) => e.confidence === 'certain' || e.confidence === 'probable')).toBe(true);
    // A GSTIN cannot legitimately collide; a name in two departments can.
    expect(report.exceptions.filter((e) => e.kind === 'duplicate_supplier_gstin').every((e) => e.confidence === 'certain')).toBe(true);
  });
});

describe('severity is about money and law, not tidiness', () => {
  it('ranks an unmappable tax code and negative stock ABOVE a duplicate name', () => {
    const severityOf = (kind: string): string => report.exceptions.find((e) => e.kind === kind)!.severity;
    expect(severityOf('unmapped_tax_code')).toBe('blocking');
    expect(severityOf('negative_stock')).toBe('blocking');
    expect(severityOf('duplicate_product')).toBe('low');
  });

  it('values a negative stock row and a mismatched total, because the exposure is the point', () => {
    expect(report.exceptions.find((e) => e.kind === 'negative_stock')?.valueMinor).toBeGreaterThan(0);
    expect(report.exceptions.find((e) => e.kind === 'document_total_mismatch')?.valueMinor).toBeGreaterThan(0);
  });

  it('gives evidence a person can check against the old system', () => {
    for (const e of report.exceptions.slice(0, 50)) {
      expect(e.evidence.length).toBeGreaterThan(30);
      expect(e.legacyIds.length).toBeGreaterThan(0);
    }
  });
});

describe('an exception is kept, resolved or not (hard rule #6)', () => {
  const one = report.exceptions.find((e) => e.kind === 'duplicate_customer')!;
  const resolution = {
    action: 'merge' as const, decidedBy: 'u-manager', decidedAt: '2026-08-06T10:00:00Z',
    reason: 'same person, phone typed with +91 on one record', survivingLegacyId: one.legacyIds[1]!,
  };

  it('records the decision on the exception rather than removing it', () => {
    const r = resolveException({ exceptions: report.exceptions, exceptionId: one.exceptionId, resolution });
    expect(r.ok).toBe(true);
    expect(r.exceptions).toHaveLength(report.exceptions.length);
    expect(r.exceptions.find((e) => e.exceptionId === one.exceptionId)?.resolution?.decidedBy).toBe('u-manager');
  });

  it('refuses a second decision — the first one is the evidence', () => {
    const once = resolveException({ exceptions: report.exceptions, exceptionId: one.exceptionId, resolution }).exceptions;
    const twice = resolveException({ exceptions: once, exceptionId: one.exceptionId, resolution });
    expect(twice.refusedBecause).toBe('already_resolved');
  });

  it('refuses a merge that does not name the survivor, or names an uninvolved record', () => {
    const noSurvivor = resolveException({
      exceptions: report.exceptions, exceptionId: one.exceptionId,
      resolution: { ...resolution, survivingLegacyId: undefined },
    });
    expect(noSurvivor.refusedBecause).toBe('merge_without_survivor');

    const stranger = resolveException({
      exceptions: report.exceptions, exceptionId: one.exceptionId,
      resolution: { ...resolution, survivingLegacyId: 'C99999' },
    });
    expect(stranger.refusedBecause).toBe('survivor_not_involved');
  });

  it('refuses an unnamed decider and an unreasoned decision', () => {
    expect(resolveException({ exceptions: report.exceptions, exceptionId: one.exceptionId, resolution: { ...resolution, decidedBy: ' ' } }).refusedBecause).toBe('no_decider');
    expect(resolveException({ exceptions: report.exceptions, exceptionId: one.exceptionId, resolution: { ...resolution, reason: '  ' } }).refusedBecause).toBe('no_reason');
  });

  it('a MERGE is a redirection, not a delete — the retired id stays resolvable', () => {
    const resolved = resolveException({ exceptions: report.exceptions, exceptionId: one.exceptionId, resolution }).exceptions;
    const merges = buildMergeMap(resolved);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      survivingLegacyId: one.legacyIds[1]!,
      retiredLegacyId: one.legacyIds[0]!,
      decidedBy: 'u-manager',
    });
    expect(merges[0]?.reason).toContain('same person');
  });
});

describe('a blocking exception is cleared by a DECISION, including a decision to keep it', () => {
  it('blocks the cutover while a valuation or tax exception is unexamined', () => {
    const o = outstandingExceptions(report.exceptions);
    expect(o.blockingUnresolved.length).toBeGreaterThan(0);
    expect(o.clearForCutover).toBe(false);
    expect(o.detail).toContain('none may be inherited by accident');
  });

  it('clears once every blocking exception has a named decision — even "migrate as is"', () => {
    let exceptions: readonly MigrationException[] = report.exceptions;
    for (const e of report.exceptions.filter((x) => x.severity === 'blocking')) {
      exceptions = resolveException({
        exceptions, exceptionId: e.exceptionId,
        resolution: {
          action: 'migrate_as_is', decidedBy: 'u-owner', decidedAt: '2026-08-06T10:00:00Z',
          reason: 'accepted knowingly: the stock will be corrected by the first physical count',
        },
      }).exceptions;
    }
    const o = outstandingExceptions(exceptions);
    expect(o.blockingUnresolved).toHaveLength(0);
    expect(o.clearForCutover).toBe(true);
    // Nothing was removed to get there.
    expect(o.total).toBe(report.exceptions.length);
    expect(o.detail).toContain('every valuation and tax exception has a named decision behind it');
  });

  it('sums the money still at stake in undecided exceptions', () => {
    expect(outstandingExceptions(report.exceptions).valueAtStakeMinor).toBeGreaterThan(0);
  });
});
