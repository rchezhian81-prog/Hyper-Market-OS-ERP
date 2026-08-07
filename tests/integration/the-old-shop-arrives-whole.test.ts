import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import { generateLegacyDataset, datasetChecksum } from '../../packages/migration/src/synthetic';
import {
  inventorySources, sealExtract, verifyExtract, simpleHasher, type LegacySource,
} from '../../packages/migration/src/discovery';
import { approveMapping, assessCoverage, type MappingTable } from '../../packages/migration/src/mapping';
import {
  detectExceptions, resolveException, buildMergeMap, outstandingExceptions,
  type MigrationException,
} from '../../packages/migration/src/cleaning';
import { assertNonProduction, runTrialLoad, applyDelta, type LoadTarget } from '../../packages/migration/src/trial';
import {
  recordControlTotal, assessReconciliation, signControlTotal, buildOpeningEvents,
  type ControlTotal,
} from '../../packages/migration/src/reconcile';
import {
  proposeExclusion, approveExclusion, exclusionPosition, assessRetirement,
} from '../../packages/migration/src/history';
import {
  compareParallelDay, ownDifference, parallelRunPosition, decideCutover, performRollback,
  type ParallelDayResult, type ParallelDifference,
} from '../../packages/migration/src/cutover';

/**
 * STAGE 11 REHEARSAL — the migration pipeline, MG-01…MG-12.
 *
 * Gate (roadmap §34): **the old shop arrives whole, or it does not arrive.**
 *
 * EX-02 — lawful export access to the incumbent ERP — is owner action pending, and by the
 * owner's instruction of 4 August 2026 it blocks real-data extraction and does **not** block
 * synthetic migration testing. So this runs end to end against a generated legacy dataset with
 * ten kinds of realistic damage planted in it, and asserts that every planted fault is found
 * **by identity**. A rehearsal that only handles good data rehearses nothing.
 *
 * The claim on trial is not that the pipeline works. It is that the pipeline **refuses** — at
 * the extract that was not sealed, at the tax code nobody can map, at the total that was
 * computed the same way twice, at the signature of the person who ran the load, at the ledger
 * that has no signed total behind it, and at the cutover whose rollback was designed rather
 * than demonstrated.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '88888888-8888-8888-8888-888888888888';
const RUN = `w${Date.now().toString(36)}`;

const RATE_REVISION = '2020-01-01';
const REHEARSAL: LoadTarget = { targetId: `tgt-${RUN}`, tenantId: TENANT, kind: 'rehearsal', label: 'migration rehearsal' };
const PRODUCTION: LoadTarget = { targetId: `prod-${RUN}`, tenantId: TENANT, kind: 'production', label: 'sre-prod' };

const dataset = generateLegacyDataset();

const TAX_TABLE: MappingTable = approveMapping({
  table: {
    mappingId: `map-${RUN}`, tenantId: TENANT, version: 1, status: 'draft',
    entries: [
      ...['T0', 'T5', 'T12', 'T18', 'T28'].map((v) => ({
        domain: 'tax_code' as const, legacyValue: v, targetValue: `GST_${v.slice(1)}`,
        rationale: 'rate carried across exactly as recorded on the legacy invoice',
      })),
      ...['EA', 'KG'].map((v) => ({
        domain: 'uom' as const, legacyValue: v, targetValue: v.toLowerCase(),
        rationale: 'unit of measure normalised to lower case',
      })),
    ],
  },
  approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z',
}).table!;

describe.skipIf(!DATABASE_URL)('Stage 11 — the old shop arrives whole (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
  });

  afterAll(async () => {
    await client.end();
  });

  // ─── 1. MG-01: DISCOVERY IS NOT A TECHNICAL TASK ────────────────────────────

  it('will not call discovery complete while the loyalty spreadsheet has no owner', () => {
    const known: LegacySource = {
      sourceId: `src-erp-${RUN}`, tenantId: TENANT, name: 'Incumbent ERP database',
      kind: 'erp_database', ownerUserId: 'u-manager', rowCount: dataset.products.length + dataset.documents.length,
      volumeBasis: 'counted', retentionYears: 8, extractable: true,
    };
    // The one nobody wrote down. It is the reason MG-01 exists.
    const forgotten: LegacySource = {
      sourceId: `src-loyalty-${RUN}`, tenantId: TENANT, name: 'Loyalty points spreadsheet',
      kind: 'spreadsheet', volumeBasis: 'unknown', extractable: true,
    };

    const incomplete = inventorySources({ tenantId: TENANT, sources: [known, forgotten] });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.sources).toHaveLength(2);
    expect(incomplete.gaps.map((g) => g.kind).sort()).toEqual(['no_named_owner', 'no_retention_period', 'volume_unknown']);

    const claimed = inventorySources({
      tenantId: TENANT,
      sources: [known, { ...forgotten, ownerUserId: 'u-owner', rowCount: 1_240, volumeBasis: 'counted', retentionYears: 8 }],
    });
    expect(claimed.complete).toBe(true);
    expect(claimed.countedRows).toBe(known.rowCount! + 1_240);
  });

  // ─── 2. MG-02: THE SEAL, AND WHAT IT CATCHES ────────────────────────────────

  it('seals the extract at extraction, and catches both a changed byte and a missing row', () => {
    const material = JSON.stringify(dataset.products);

    const unbacked = sealExtract({
      extractId: `ex-${RUN}`, tenantId: TENANT, sourceId: `src-erp-${RUN}`, material,
      rowCount: dataset.products.length, extractedBy: 'u-operator',
      hasher: simpleHasher, now: '2026-08-05T21:00:00Z',
    });
    expect(unbacked.refusedBecause).toBe('backup_not_verified');

    const sealed = sealExtract({
      extractId: `ex-${RUN}`, tenantId: TENANT, sourceId: `src-erp-${RUN}`, material,
      rowCount: dataset.products.length, extractedBy: 'u-operator',
      backupVerifiedAt: '2026-08-05T20:00:00Z', hasher: simpleHasher, now: '2026-08-05T21:00:00Z',
    }).extract!;

    expect(verifyExtract({ extract: sealed, material, rowCount: dataset.products.length, hasher: simpleHasher }).matches).toBe(true);

    const tampered = JSON.stringify([{ ...dataset.products[0]!, priceMinor: 1 }, ...dataset.products.slice(1)]);
    expect(verifyExtract({ extract: sealed, material: tampered, rowCount: dataset.products.length, hasher: simpleHasher }).matches).toBe(false);

    // A truncated extract loads perfectly and reconciles a smaller, self-consistent shop.
    const short = verifyExtract({ extract: sealed, material, rowCount: dataset.products.length - 1, hasher: simpleHasher });
    expect(short.matches).toBe(true);
    expect(short.rowCountMatches).toBe(false);

    // Chain of custody survives the whole rehearsal.
    expect(datasetChecksum(dataset)).toBe(datasetChecksum(generateLegacyDataset()));
  });

  // ─── 3. MG-03: THE TAX CODE NOBODY CAN MAP ──────────────────────────────────

  it('measures mapping coverage against the extract, and names the codes it cannot map', () => {
    const observedTax = [...new Set(dataset.products.map((p) => p.taxCode))].sort().map((value) => ({
      domain: 'tax_code' as const, value,
      rows: dataset.products.filter((p) => p.taxCode === value).length,
    }));

    const coverage = assessCoverage({ tenantId: TENANT, table: TAX_TABLE, observed: observedTax });
    expect(coverage.fullyCovered).toBe(false);
    expect(coverage.byDomain[0]?.uncovered).toEqual(['TX']);
    expect(coverage.totalAffectedRows).toBe(dataset.plantedFaults.unmapped_tax_code);

    // And the contradiction that cannot be resolved at load time is refused at approval.
    const contradiction = approveMapping({
      table: {
        mappingId: `map-bad-${RUN}`, tenantId: TENANT, version: 1, status: 'draft',
        entries: [
          { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST_0', rationale: 'assumed zero-rated' },
          { domain: 'tax_code', legacyValue: 'TX', targetValue: 'GST_18', rationale: 'assumed standard' },
        ],
      },
      approvedBy: 'u-ca', now: '2026-08-05T09:00:00Z',
    });
    expect(contradiction.refusedBecause).toBe('one_legacy_value_two_targets');
    expect(contradiction.conflicts).toEqual(['tax_code:TX → GST_0 / GST_18']);
  });

  // ─── 4. MG-04: EVERY PLANTED FAULT, FOUND BY IDENTITY ───────────────────────

  const report = detectExceptions({
    tenantId: TENANT, dataset, mappingTable: TAX_TABLE, rateRevisionDate: RATE_REVISION,
    idPrefix: `EXC-${RUN}`,
  });

  it('finds all ten kinds of planted damage, in exactly the planted quantity', () => {
    const expected: Readonly<Record<string, number>> = {
      duplicate_product: dataset.plantedFaults.duplicate_products,
      shared_barcode: dataset.plantedFaults.shared_barcodes,
      negative_stock: dataset.plantedFaults.negative_stock,
      batch_without_expiry: dataset.plantedFaults.missing_expiry,
      duplicate_customer: dataset.plantedFaults.duplicate_customers,
      duplicate_supplier_gstin: dataset.plantedFaults.duplicate_suppliers_by_gstin,
      document_total_mismatch: dataset.plantedFaults.document_total_mismatch,
      orphan_line: dataset.plantedFaults.orphan_lines,
      unmapped_tax_code: dataset.plantedFaults.unmapped_tax_code,
      pre_revision_tax_document: dataset.plantedFaults.stale_tax_codes,
    };
    for (const [kind, count] of Object.entries(expected)) {
      expect(report.byKind[kind] ?? 0, kind).toBe(count);
    }
  });

  it('finds every planted record BY ID — a right count over the wrong records is a lucky detector', () => {
    const found = new Set(report.exceptions.flatMap((e) => e.legacyIds));
    for (const [kind, ids] of Object.entries(dataset.plantedIds)) {
      expect(ids.filter((id) => !found.has(id)), kind).toHaveLength(0);
    }
  });

  it('finds NOTHING on the same generator run clean — the control that makes the rest mean something', () => {
    const clean = detectExceptions({
      tenantId: TENANT, dataset: generateLegacyDataset({ withFaults: false }),
      mappingTable: TAX_TABLE, rateRevisionDate: RATE_REVISION,
    });
    expect(clean.exceptions).toHaveLength(0);
  });

  it('changed none of the legacy data while doing it', () => {
    expect(report.nothingWasModified).toBe(true);
  });

  // ─── 5. MG-04: RESOLUTION KEEPS EVERYTHING (HARD RULE #6) ───────────────────

  const resolved: readonly MigrationException[] = (() => {
    let acc: readonly MigrationException[] = report.exceptions;
    for (const e of report.exceptions) {
      const isMerge = e.kind === 'duplicate_customer' || e.kind === 'duplicate_supplier_gstin';
      acc = resolveException({
        exceptions: acc, exceptionId: e.exceptionId,
        resolution: isMerge
          ? {
            action: 'merge', decidedBy: 'u-manager', decidedAt: '2026-08-06T10:00:00Z',
            reason: 'same party under two records', survivingLegacyId: e.legacyIds[1]!,
          }
          : {
            action: 'migrate_as_is', decidedBy: 'u-owner', decidedAt: '2026-08-06T10:00:00Z',
            reason: 'accepted knowingly and corrected by the first physical count',
          },
      }).exceptions;
    }
    return acc;
  })();

  it('resolves every exception without removing a single one, and blocks cutover until it does', () => {
    expect(outstandingExceptions(report.exceptions).clearForCutover).toBe(false);

    const after = outstandingExceptions(resolved);
    expect(after.total).toBe(report.exceptions.length);
    expect(after.blockingUnresolved).toHaveLength(0);
    expect(after.clearForCutover).toBe(true);
  });

  it('turns a merge into a REDIRECTION — the retired id still resolves', () => {
    const merges = buildMergeMap(resolved);
    expect(merges.length).toBe(
      dataset.plantedFaults.duplicate_customers + dataset.plantedFaults.duplicate_suppliers_by_gstin,
    );
    for (const m of merges) {
      expect(m.retiredLegacyId).not.toBe(m.survivingLegacyId);
      expect(m.decidedBy).toBe('u-manager');
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });

  // ─── 6. MG-05: HARD RULE #7, BEFORE ANYTHING ELSE ───────────────────────────

  it('REFUSES a production target for the trial load, ahead of every other check', () => {
    expect(assertNonProduction(PRODUCTION).permitted).toBe(false);

    const refused = runTrialLoad({
      plan: {
        trialId: `trial-${RUN}`, tenantId: TENANT, target: PRODUCTION,
        rowsToLoad: dataset.products.length, operator: '', extractVerified: false,
        blockingExceptionsOpen: 22, targetPreparedEmpty: false,
      },
      elapsedMs: 1_000,
    });
    expect(refused.refusedBecause).toBe('production_target');
    expect(refused.rowsLoaded).toBe(0);
  });

  it('runs a repeatable full-volume trial and projects the cutover window', () => {
    const rows = dataset.products.length + dataset.stock.length + dataset.customers.length
      + dataset.suppliers.length + dataset.documents.length + dataset.lines.length;

    const blocked = runTrialLoad({
      plan: {
        trialId: `trial-${RUN}`, tenantId: TENANT, target: REHEARSAL, rowsToLoad: rows,
        operator: 'u-operator', extractVerified: true,
        blockingExceptionsOpen: outstandingExceptions(report.exceptions).blockingUnresolved.length,
        targetPreparedEmpty: true,
      },
      elapsedMs: 8_400,
    });
    expect(blocked.refusedBecause).toBe('blocking_exceptions_open');

    const ok = runTrialLoad({
      plan: {
        trialId: `trial-${RUN}`, tenantId: TENANT, target: REHEARSAL, rowsToLoad: rows,
        operator: 'u-operator', extractVerified: true, blockingExceptionsOpen: 0, targetPreparedEmpty: true,
      },
      elapsedMs: 8_400,
      fullVolumeRows: rows * 20,
    });
    expect(ok.ok).toBe(true);
    expect(ok.repeatable).toBe(true);
    expect(ok.projectedFullVolumeMs).toBe(168_000);
  });

  // ─── 7. MG-07: AN EXCLUSION IS THE OWNER'S, IN WRITING ──────────────────────

  const preRevisionDocs = dataset.documents.filter((d) => d.documentDate < RATE_REVISION);
  const excludedValue = preRevisionDocs.reduce((t, d) => t + d.totalMinor, 0);

  it('refuses "too old" and accepts a reason about usability, approved only by the owner', () => {
    expect(proposeExclusion({
      exclusionId: `exc-${RUN}-bad`, tenantId: TENANT, scope: 'documents_before',
      description: 'pre-2020 documents', recordCount: preRevisionDocs.length,
      valueMinor: excludedValue, reason: 'too old', proposedBy: 'u-operator', now: '2026-08-06T09:00:00Z',
    }).refusedBecause).toBe('age_alone');

    const proposal = proposeExclusion({
      exclusionId: `exc-${RUN}`, tenantId: TENANT, scope: 'documents_before',
      description: 'Documents dated before the 2020 rate revision',
      recordCount: preRevisionDocs.length, valueMinor: excludedValue,
      reason: 'their tax was struck under a superseded rate table and restating it would rewrite filed returns',
      proposedBy: 'u-operator', now: '2026-08-06T09:00:00Z',
    }).exclusion!;

    expect(approveExclusion({
      exclusion: proposal, decidedBy: 'u-manager', decidedByIsOwner: false, approve: true,
      ownerStatement: 'fine by me', now: '2026-08-06T18:00:00Z',
    }).refusedBecause).toBe('not_the_owner');

    const approved = approveExclusion({
      exclusion: proposal, decidedBy: 'u-owner', decidedByIsOwner: true, approve: true,
      ownerStatement: 'agreed — the CA confirms those years are filed and closed',
      now: '2026-08-06T18:00:00Z',
    }).exclusion!;

    const position = exclusionPosition([approved]);
    expect(position.approvedValueMinor).toBe(excludedValue);
    expect(position.undecidedValueMinor).toBe(0);
  });

  // ─── 8. MG-06 / QG-07: THE TOTAL THAT PROVES NOTHING ────────────────────────

  const legacyStockValue = dataset.stock.reduce((t, r) => t + r.valueMinor, 0);
  const legacyLoyalty = dataset.customers.reduce((t, c) => t + c.loyaltyPoints, 0);
  const legacyDocValue = dataset.documents.reduce((t, d) => t + d.totalMinor, 0);
  const legacyTax = dataset.documents.reduce((t, d) => t + d.taxMinor, 0);

  const total = (over: Partial<ControlTotal>): ControlTotal => ({
    totalId: `ct-${RUN}-stock`, tenantId: TENANT, kind: 'stock', name: 'Stock value',
    unit: 'minor_currency', legacyValue: legacyStockValue, loadedValue: legacyStockValue,
    legacyDerivation: 'SUM(value) over the sealed legacy stock extract',
    loadedDerivation: 'SUM(value) projected from loaded opening stock events',
    ...over,
  });

  it('REFUSES a control total whose two sides were computed the same way', () => {
    const r = recordControlTotal({
      totals: [],
      total: total({ loadedDerivation: 'sum(VALUE)   over the sealed legacy stock extract' }),
    });
    expect(r.refusedBecause).toBe('same_derivation_both_sides');
  });

  const totals: readonly ControlTotal[] = [
    total({}),
    total({
      totalId: `ct-${RUN}-loyalty`, kind: 'loyalty', name: 'Loyalty points', unit: 'points',
      legacyValue: legacyLoyalty, loadedValue: legacyLoyalty,
      legacyDerivation: 'SUM(points) over the sealed legacy customer extract',
      loadedDerivation: 'SUM(points) projected from loaded loyalty events',
    }),
    // The one that legitimately differs, by exactly the owner-approved exclusion.
    total({
      totalId: `ct-${RUN}-financial`, kind: 'financial', name: 'Document value', unit: 'minor_currency',
      legacyValue: legacyDocValue, loadedValue: legacyDocValue - excludedValue,
      approvedExclusionValue: excludedValue,
      explanation: `pre-2020 documents excluded by owner decision exc-${RUN}`,
      legacyDerivation: 'SUM(total) over the sealed legacy document extract',
      loadedDerivation: 'SUM(total) projected from loaded document events',
    }),
    total({
      totalId: `ct-${RUN}-tax`, kind: 'tax', name: 'Output tax', unit: 'minor_currency',
      legacyValue: legacyTax, loadedValue: legacyTax,
      legacyDerivation: 'SUM(tax) over the sealed legacy document extract',
      loadedDerivation: 'SUM(tax) projected from loaded document events',
    }),
  ];

  it('accepts an EXPLAINED difference only when the arithmetic closes to the rupee', () => {
    const exact = assessReconciliation({ tenantId: TENANT, totals });
    expect(exact.assessments.find((a) => a.kind === 'financial')?.status).toBe('explained');

    const roughly = assessReconciliation({
      tenantId: TENANT,
      totals: totals.map((t) => (t.kind === 'financial' ? { ...t, loadedValue: t.loadedValue - 100 } : t)),
    });
    expect(roughly.assessments.find((a) => a.kind === 'financial')?.status).toBe('open');
    expect(roughly.qg07Passed).toBe(false);
  });

  const signed: readonly ControlTotal[] = (() => {
    let acc = totals;
    for (const t of totals) {
      const isCa = t.kind === 'financial' || t.kind === 'tax';
      acc = signControlTotal({
        totals: acc, totalId: t.totalId,
        signedBy: isCa ? 'u-ca' : 'u-checker',
        signerRole: isCa ? 'chartered_accountant' : 'store_manager',
        loadOperator: 'u-operator',
        statement: 'agreed against the legacy report', now: '2026-08-07T09:00:00Z',
      }).totals;
    }
    return acc;
  })();

  it('refuses the loader signing their own load, and a manager signing tax', () => {
    expect(signControlTotal({
      totals, totalId: `ct-${RUN}-stock`, signedBy: 'u-operator', signerRole: 'store_manager',
      loadOperator: 'u-operator', statement: 'looks right', now: '2026-08-07T09:00:00Z',
    }).refusedBecause).toBe('signer_ran_the_load');

    expect(signControlTotal({
      totals, totalId: `ct-${RUN}-tax`, signedBy: 'u-owner', signerRole: 'owner',
      loadOperator: 'u-operator', statement: 'fine', now: '2026-08-07T09:00:00Z',
    }).refusedBecause).toBe('finance_or_tax_needs_ca');
  });

  it('passes QG-07 only when every total is closed AND signed', () => {
    expect(assessReconciliation({ tenantId: TENANT, totals }).qg07Passed).toBe(false);
    const r = assessReconciliation({ tenantId: TENANT, totals: signed });
    expect(r.open).toHaveLength(0);
    expect(r.unsigned).toHaveLength(0);
    expect(r.qg07Passed).toBe(true);
  });

  // ─── 9. MG-08: OPENING BALANCES ARE EVENTS, IN A REAL LEDGER ────────────────

  it('REFUSES to open the ledger before QG-07, then banks opening EVENTS in PostgreSQL', async () => {
    const positions = dataset.stock.slice(0, 25).map((s) => ({
      kind: 'stock' as const, subjectId: `${s.legacyProductId}@${s.locationCode}`,
      quantity: s.qty, valueMinor: s.valueMinor, fromTotalId: `ct-${RUN}-stock`,
    }));

    const tooEarly = buildOpeningEvents({ tenantId: TENANT, totals, positions, now: '2026-08-08T05:00:00Z' });
    expect(tooEarly.refusedBecause).toBe('qg07_not_passed');

    const built = buildOpeningEvents({
      tenantId: TENANT, totals: signed, positions, now: '2026-08-08T05:00:00Z', idPrefix: `OPEN-${RUN}`,
    });
    expect(built.ok).toBe(true);
    expect(built.events).toHaveLength(25);

    for (const e of built.events) {
      const appended = await store.append(TENANT, `migration-opening-${RUN}`, makeEvent({
        id: e.eventId, type: 'InventoryAdjusted', occurredAt: e.occurredAt,
        idempotencyKey: `open-${RUN}-${e.subjectId}`, source: 'migration/MG-08',
        payload: {
          subjectId: e.subjectId, quantity: e.quantity, valueMinor: e.valueMinor,
          fromTotalId: e.fromTotalId, reason: 'migration opening state',
        },
      }));
      expect(appended.deduped).toBe(false);
    }

    const banked = await store.readStream(TENANT, `migration-opening-${RUN}`);
    expect(banked).toHaveLength(25);

    // A replay of the whole opening state banks nothing twice (§31.1).
    const replay = await store.append(TENANT, `migration-opening-${RUN}`, makeEvent({
      id: built.events[0]!.eventId, type: 'InventoryAdjusted', occurredAt: built.events[0]!.occurredAt,
      idempotencyKey: `open-${RUN}-${built.events[0]!.subjectId}`, source: 'migration/MG-08',
      payload: { replayed: true },
    }));
    expect(replay.deduped).toBe(true);
    expect((await store.readStream(TENANT, `migration-opening-${RUN}`))).toHaveLength(25);
  });

  it('the DATABASE ITSELF refuses to change an opening event (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, `migration-opening-${RUN}`))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"tampered":true}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [first.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  // ─── 10. MG-09: THE SHOP KEPT TRADING WHILE WE MIGRATED ─────────────────────

  it('applies the delta exactly once, and refuses what the extract already holds', () => {
    const changes = dataset.stock.slice(0, 40).map((s, i) => ({
      changeKey: `chg-${RUN}-${i}`, entity: 'stock', legacyId: s.legacyProductId,
      operation: 'update' as const,
      changedAt: i % 8 === 0 ? '2026-08-04T12:00:00Z' : '2026-08-06T12:00:00Z',
      deltaQty: 1, deltaMinor: 100,
    }));

    const first = applyDelta({ target: REHEARSAL, changes, extractCutoff: '2026-08-05T22:00:00Z' });
    expect(first.applied).toBe(35);
    expect(first.refused).toBe(5);
    expect(first.netQty).toBe(35);

    const replay = applyDelta({
      target: REHEARSAL, changes, extractCutoff: '2026-08-05T22:00:00Z', alreadyApplied: first.appliedKeys,
    });
    expect(replay.applied).toBe(0);
    expect(replay.duplicatesIgnored).toBe(35);
    expect(replay.netQty).toBe(0);

    expect(applyDelta({ target: PRODUCTION, changes, extractCutoff: '2026-08-05T22:00:00Z' }).ok).toBe(false);
  });

  // ─── 11. MG-10: THE ONLY STEP THAT TESTS AGAINST REALITY ────────────────────

  const days: readonly ParallelDayResult[] = [
    compareParallelDay({
      tenantId: TENANT, businessDate: '2026-09-01', idPrefix: `PD-${RUN}`,
      comparisons: [
        { area: 'sales_value', legacyValue: 41_20_000, newValue: 41_20_000, toleranceMinor: 100 },
        { area: 'tax', legacyValue: 206_000, newValue: 206_040, toleranceMinor: 100 },
      ],
    }),
    compareParallelDay({
      tenantId: TENANT, businessDate: '2026-09-02', idPrefix: `PD-${RUN}`,
      comparisons: [{ area: 'sales_value', legacyValue: 38_90_000, newValue: 38_85_500, toleranceMinor: 100 }],
    }),
    compareParallelDay({
      tenantId: TENANT, businessDate: '2026-09-03', idPrefix: `PD-${RUN}`,
      comparisons: [{ area: 'sales_value', legacyValue: 44_10_000, newValue: 44_10_000, toleranceMinor: 100 }],
    }),
  ];

  it('resets the clean-day counter on a bad day, and refuses last-write-wins as an explanation', () => {
    const allDifferences: readonly ParallelDifference[] = days.flatMap((d) => d.differences);
    expect(allDifferences).toHaveLength(1);

    const before = parallelRunPosition({ days, differences: allDifferences, requiredCleanDays: 3 });
    expect(before.daysRun).toBe(3);
    expect(before.consecutiveCleanDays).toBe(1);
    expect(before.sufficient).toBe(false);
    expect(before.unownedDifferences).toHaveLength(1);

    const id = allDifferences[0]!.differenceId;
    const lazy = ownDifference({
      differences: allDifferences, differenceId: id, ownerUserId: 'u-manager',
      explanation: 'the new system is probably right',
    });
    expect(lazy.refusedBecause).toBe('newer_is_not_a_reason');

    const proper = ownDifference({
      differences: allDifferences, differenceId: id, ownerUserId: 'u-manager',
      explanation: 'a ₹4,500 cash refund was keyed twice into the old system by the evening cashier',
      wrongSide: 'legacy',
    });
    expect(proper.ok).toBe(true);
    expect(proper.differences[0]?.status).toBe('resolved');

    const cleanRun = parallelRunPosition({
      days: [...days, compareParallelDay({ tenantId: TENANT, businessDate: '2026-09-04', comparisons: [] }),
        compareParallelDay({ tenantId: TENANT, businessDate: '2026-09-05', comparisons: [] })],
      differences: proper.differences, requiredCleanDays: 3,
    });
    expect(cleanRun.consecutiveCleanDays).toBe(3);
    expect(cleanRun.sufficient).toBe(true);
  });

  // ─── 12. MG-11: THE ROLLBACK IS THE DELIVERABLE ─────────────────────────────

  it('refuses GO on a designed rollback, gives GO on a demonstrated one, and keeps the shop trading either way', () => {
    const base = {
      cutoverId: `cut-${RUN}`, tenantId: TENANT, qg07Passed: true,
      parallelRunSufficient: true, edgeUnsyncedItems: 0, blockingExceptionsOpen: 0,
      deltaApplied: true,
      namedTeam: [{ userId: 'u-operator', role: 'load' }, { userId: 'u-manager', role: 'floor' }, { userId: 'u-ca', role: 'totals' }],
      ownerGoBy: 'u-owner',
    };

    const designed = decideCutover({ ...base, rollbackDemonstratedAt: undefined });
    expect(designed.go).toBe(false);
    expect(designed.failed).toEqual(['rollback_demonstrated']);
    expect(designed.shopKeepsTrading).toBe(true);

    const everythingWrong = decideCutover({
      ...base, qg07Passed: false, rollbackDemonstratedAt: undefined, parallelRunSufficient: false,
      edgeUnsyncedItems: 4, blockingExceptionsOpen: 22, deltaApplied: false, namedTeam: [], ownerGoBy: undefined,
    });
    expect(everythingWrong.failed).toHaveLength(8);

    const go = decideCutover({ ...base, rollbackDemonstratedAt: '2026-09-10T22:00:00Z' });
    expect(go.go).toBe(true);
    expect(go.shopKeepsTrading).toBe(true);
    expect(go.ownerAction).toContain('nothing further');
  });

  it('rolls back on one decision, and unwinds no evidence', async () => {
    const r = performRollback({
      cutoverId: `cut-${RUN}`, trigger: 'control_total_failed', decidedBy: 'u-manager',
      legacySystemAvailable: true, now: '2026-09-15T05:40:00Z',
    });
    expect(r.performed).toBe(true);
    expect(r.evidenceRetained).toBe(true);
    expect(r.shopKeepsTrading).toBe(true);

    // The opening events banked before the rollback are still there. Hard rule #6.
    expect(await store.readStream(TENANT, `migration-opening-${RUN}`)).toHaveLength(25);
  });

  // ─── 13. MG-12: RETIRE THE SYSTEM, NEVER THE DATA ───────────────────────────

  it('will not retire the legacy system early, and never deletes the archive', () => {
    const archive = {
      archiveId: `arc-${RUN}`, tenantId: TENANT, sourceId: `src-erp-${RUN}`,
      digest: datasetChecksum(dataset), rowCount: dataset.documents.length,
      archivedAt: '2026-09-20T00:00:00Z', retentionYears: 8,
      earliestRecordDate: '2017-01-01', latestRecordDate: '2026-08-31',
      readOnly: true as const, restoreVerifiedAt: '2026-09-21T10:00:00Z',
    };

    const early = assessRetirement({ archive, cutoverAccepted: true, openAssessments: 0, today: '2027-01-01' });
    expect(early.mayRetireSystem).toBe(false);
    expect(early.retentionEndsOn).toBe('2034-08-31');

    const untested = assessRetirement({
      archive: { ...archive, restoreVerifiedAt: undefined },
      cutoverAccepted: true, openAssessments: 0, today: '2034-09-01',
    });
    expect(untested.blockedBy).toContain('restore_never_verified');

    const due = assessRetirement({ archive, cutoverAccepted: true, openAssessments: 0, today: '2034-09-01' });
    expect(due.mayRetireSystem).toBe(true);
    expect(due.dataIsNeverDeleted).toBe(true);
    expect(due.detail).toContain('never deleted');
  });
});
