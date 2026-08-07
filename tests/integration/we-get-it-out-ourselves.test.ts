import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import { generateLegacyDataset } from '../../packages/migration/src/synthetic';
import { renderStockReport, checkRoundTrip } from '../../packages/migration/src/render-report';
import { parseReport, parseReportMoney, checkAgainstPrintedTotal } from '../../packages/migration/src/report-parser';
import {
  assessRoute, planVerification, assessExtractionReadiness,
  type ExtractionRoute,
} from '../../packages/migration/src/extraction';
import { sealExtract, verifyExtract, simpleHasher } from '../../packages/migration/src/discovery';
import {
  recordControlTotal, assessReconciliation, signControlTotal, buildOpeningEvents,
  type ControlTotal,
} from '../../packages/migration/src/reconcile';

/**
 * OB-06 — **we get it out ourselves.**
 *
 * The Stage 11 gate proved the migration engine against a synthetic dataset in this product's own
 * clean shape. That was the right test for the engine, and it is **not the shape the data will
 * actually arrive in** now that the owner has decided we extract it without the incumbent
 * vendor's help. What actually arrives is a printed page in a spreadsheet.
 *
 * So this walks the real path, end to end: a known dataset is rendered back into that mess,
 * parsed with the same parser that will read the real thing, sealed, loaded, reconciled and
 * banked — with one rule enforced throughout that is the whole reason the approach is sound:
 *
 * **NOTHING IS VERIFIED AGAINST THE SYSTEM IT CAME FROM.** The stock figure is proved by a
 * physical count of our own shelves. Not by a second report from the same product, which would
 * agree perfectly and prove only that one system is internally consistent — it would be just as
 * consistent about a wrong number.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '99999999-9999-9999-9999-999999999999';
const RUN = `x${Date.now().toString(36)}`;

/** The truth. We generated it, so every check below has a right answer to compare against. */
const TRUTH = generateLegacyDataset();

/** What the old system would print if we asked it for a stock valuation. */
const PRINTED = renderStockReport(TRUTH, { rowsPerPage: 32 });

const route = (over: Partial<ExtractionRoute>): ExtractionRoute => ({
  domain: 'stock', method: 'printed_report',
  description: 'Stock Valuation Report → print to file',
  rowCount: TRUTH.stock.length,
  // Discovered by writing this test, and left in because it is true: a printed stock valuation
  // has no LOCATION column, so two rows for one product — shop floor and back store — arrive as
  // one figure. Route C cannot break them out, and opening state built from it is product-level.
  cannotYield: ['batch code', 'expiry date', 'stock location'], repeatable: true,
  ...over,
});

describe.skipIf(!DATABASE_URL)('OB-06 — we get it out ourselves (real PostgreSQL)', () => {
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

  // ─── 1. THE ROUTE IS JUDGED BEFORE IT IS USED ───────────────────────────────

  it('accepts a printed report as a source, and states what it cannot give', () => {
    const assessed = assessRoute(route({}));
    expect(assessed.usable).toBe(true);
    // Named up front rather than discovered at reconciliation: a printed stock report has no
    // batch or expiry on it, and no amount of careful parsing invents them.
    expect(assessed.risks).toContain('aggregated_only');
    expect(assessed.risks).toContain('known_gaps');
    expect(assessed.detail).toContain('batch code, expiry date, stock location');
  });

  it('REFUSES a re-keyed table as a migration source, however carefully it was typed', () => {
    const assessed = assessRoute(route({ method: 'manual_rekey', repeatable: false }));
    expect(assessed.usable).toBe(false);
    expect(assessed.detail).toContain('cannot be re-run');
  });

  // ─── 2. MG-02: SEAL THE COPY BEFORE ANYTHING READS IT ───────────────────────

  it('seals the printed file before parsing it, and catches a byte changed afterwards', () => {
    const material = PRINTED.map((r) => r.join('\t')).join('\n');

    const sealed = sealExtract({
      extractId: `ex-${RUN}`, tenantId: TENANT, sourceId: `src-stock-${RUN}`, material,
      rowCount: PRINTED.length, extractedBy: 'u-operator',
      backupVerifiedAt: '2026-08-07T19:00:00Z', hasher: simpleHasher, now: '2026-08-07T20:00:00Z',
    }).extract!;

    expect(verifyExtract({ extract: sealed, material, rowCount: PRINTED.length, hasher: simpleHasher }).matches).toBe(true);

    const edited = material.replace('4,12,000.00', '4,12,000.01');
    const tampered = verifyExtract({ extract: sealed, material: edited, rowCount: PRINTED.length, hasher: simpleHasher });
    // If nothing matched, the substitution did not happen and this test is asserting nothing.
    if (edited !== material) expect(tampered.matches).toBe(false);
  });

  // ─── 3. THE PARSE, AGAINST GROUND TRUTH ─────────────────────────────────────

  const parsed = parseReport({ grid: PRINTED, expectColumn: 'Item Code' });

  it('finds the header under the shop banner and reads every row back exactly', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.report!.headerLine).toBeGreaterThan(1);

    const trip = checkRoundTrip({
      dataset: TRUTH, parsedRows: parsed.report!.rows, parseMoney: parseReportMoney,
    });
    // The check a real file can never give: we know the answer.
    expect(trip.lossless, trip.detail).toBe(true);
    expect(trip.parsedRows).toBe(TRUTH.stock.length);
  });

  it('never counts a "Total for GROCERY" line as a product', () => {
    expect(parsed.report!.subtotals.length).toBeGreaterThan(0);
    expect(parsed.report!.rows.some((r) => (r['Item Code'] ?? '').toLowerCase().includes('total'))).toBe(false);
  });

  it('accounts for every line it did not take, including the banner above the header (P-08)', () => {
    const taken = parsed.report!.rows.length + 1; // rows + the header itself
    expect(taken + parsed.report!.dropped.length).toBe(PRINTED.length);
    for (const d of parsed.report!.dropped) expect(d.why.length).toBeGreaterThan(10);
  });

  it('uses the report\'s own grand total to check the READING — and calls it nothing more', () => {
    const check = checkAgainstPrintedTotal({
      rows: parsed.report!.rows, amountColumn: 'Value',
      ...(parsed.report!.grandTotal?.amount ? { printed: parsed.report!.grandTotal.amount } : {}),
    });
    expect(check.matches).toBe(true);
    // Typed as the literal false. Both sides came out of the same system.
    const verifies: false = check.verifiesTheData;
    expect(verifies).toBe(false);
    expect(check.detail).toContain('both sides came from the same system');
  });

  // ─── 4. THE CONTROL THE WHOLE APPROACH RESTS ON ─────────────────────────────

  it('REFUSES to verify stock against another report from the same product', () => {
    const r = planVerification({ routes: [route({})], available: [] });
    expect(r.sound).toBe(false);
    expect(r.refusals[0]?.refusal).toBe('verified_by_the_same_system');
    expect(r.refusals[0]?.detail).toContain('just as consistent about a wrong number');
    // And it says what to go and get.
    expect(r.refusals[0]?.detail).toContain('physical_count');
  });

  it('accepts a physical count — the only truth about stock that exists', () => {
    const r = planVerification({ routes: [route({})], available: ['physical_count'] });
    expect(r.sound).toBe(true);
    expect(r.detail).toContain('a vendor file is one system\'s account of itself');
  });

  it('is not ready until every domain has a route, evidence and a preserved copy', () => {
    const nothingReady = assessExtractionReadiness({
      routes: [route({})], available: [], preservationCopyTaken: false,
    });
    expect(nothingReady.ready).toBe(false);
    expect([...nothingReady.blockers].sort()).toEqual([
      'domain_not_covered', 'no_independent_verification', 'no_preservation_copy',
    ]);
    // Whatever the answer, the shop is still selling on the old system.
    expect(nothingReady.shopKeepsTrading).toBe(true);
  });

  // ─── 5. RECONCILE AGAINST THE SHELVES, NOT THE REPORT ───────────────────────

  const parsedTotalMinor = parsed.report!.rows.reduce(
    (t, r) => t + (parseReportMoney(r['Value'] ?? '')?.minor ?? 0), 0,
  );

  it('REFUSES a control total whose two sides both came off the report', () => {
    const r = recordControlTotal({
      totals: [],
      total: {
        totalId: `ct-${RUN}-bad`, tenantId: TENANT, kind: 'stock', name: 'Stock value',
        unit: 'minor_currency', legacyValue: parsedTotalMinor, loadedValue: parsedTotalMinor,
        legacyDerivation: 'SUM(Value) from the parsed stock valuation report',
        loadedDerivation: 'sum(value)  from the PARSED stock valuation report',
      },
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('same_derivation_both_sides');
  });

  const totals: readonly ControlTotal[] = [{
    totalId: `ct-${RUN}-stock`, tenantId: TENANT, kind: 'stock', name: 'Stock value',
    unit: 'minor_currency',
    legacyValue: parsedTotalMinor,
    loadedValue: parsedTotalMinor,
    legacyDerivation: 'SUM(Value) from the parsed stock valuation report',
    // The independent side: our own people, counting our own shelves.
    loadedDerivation: 'SUM(counted qty × cost) from the physical count sheets, keyed independently',
  }];

  it('accepts the total when the other side is a physical count, and blocks until it is signed', () => {
    const recorded = recordControlTotal({ totals: [], total: totals[0]! });
    expect(recorded.ok).toBe(true);

    const unsigned = assessReconciliation({ tenantId: TENANT, totals });
    expect(unsigned.assessments[0]?.status).toBe('reconciled');
    expect(unsigned.qg07Passed).toBe(false); // reconciled, but nobody has signed it
  });

  const signed = signControlTotal({
    totals, totalId: `ct-${RUN}-stock`, signedBy: 'u-checker', signerRole: 'store_manager',
    loadOperator: 'u-operator', statement: 'agreed to the count sheets', now: '2026-08-08T09:00:00Z',
  }).totals;

  it('passes QG-07 once the count is signed by somebody who did not run the load', () => {
    expect(assessReconciliation({ tenantId: TENANT, totals: signed }).qg07Passed).toBe(true);

    expect(signControlTotal({
      totals, totalId: `ct-${RUN}-stock`, signedBy: 'u-operator', signerRole: 'store_manager',
      loadOperator: 'u-operator', statement: 'looks right', now: '2026-08-08T09:00:00Z',
    }).ok).toBe(false);
  });

  // ─── 6. OPENING STATE, FROM DATA WE EXTRACTED OURSELVES ─────────────────────

  it('banks opening EVENTS in PostgreSQL from the parsed report, once QG-07 has passed', async () => {
    // AGGREGATED BY PRODUCT, deliberately, because that is all the report gives. The first
    // version of this test invented an `@MAIN` location suffix, and the event store immediately
    // refused the second row for a product stocked in two places — which was the store being
    // right and the test being wrong. Pretending to a location the source never carried is how a
    // migration produces stock in a place nobody put it.
    const byProduct = new Map<string, { quantity: number; valueMinor: number }>();
    for (const r of parsed.report!.rows) {
      const id = r['Item Code'] ?? '';
      const acc = byProduct.get(id) ?? { quantity: 0, valueMinor: 0 };
      acc.quantity += Number(r['Qty'] ?? '0');
      acc.valueMinor += parseReportMoney(r['Value'] ?? '')?.minor ?? 0;
      byProduct.set(id, acc);
    }
    const positions = [...byProduct.entries()].slice(0, 20).map(([id, acc]) => ({
      kind: 'stock' as const,
      subjectId: id,
      quantity: acc.quantity,
      valueMinor: acc.valueMinor,
      fromTotalId: `ct-${RUN}-stock`,
    }));

    expect(buildOpeningEvents({ tenantId: TENANT, totals, positions, now: '2026-08-08T05:00:00Z' })
      .refusedBecause).toBe('qg07_not_passed');

    const built = buildOpeningEvents({
      tenantId: TENANT, totals: signed, positions, now: '2026-08-08T05:00:00Z', idPrefix: `OPEN-${RUN}`,
    });
    expect(built.ok).toBe(true);

    for (const e of built.events) {
      const appended = await store.append(TENANT, `self-extract-${RUN}`, makeEvent({
        id: e.eventId, type: 'InventoryAdjusted', occurredAt: e.occurredAt,
        idempotencyKey: `open-${RUN}-${e.subjectId}`, source: 'migration/OB-06',
        payload: {
          subjectId: e.subjectId, quantity: e.quantity, valueMinor: e.valueMinor,
          fromTotalId: e.fromTotalId, reason: 'opening state, extracted without vendor cooperation',
        },
      }));
      expect(appended.deduped).toBe(false);
    }

    const banked = await store.readStream(TENANT, `self-extract-${RUN}`);
    expect(banked).toHaveLength(20);
  });

  it('the database itself refuses to change what was banked (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, `self-extract-${RUN}`))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"x":1}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [first.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  // ─── 7. AND NONE OF IT TOUCHED THEIR SOFTWARE ───────────────────────────────

  it('does the whole thing from a printed file, with no connection to the incumbent at all', async () => {
    // The boundary, as a test rather than a promise: everything above ran from a file. There is
    // no code in this path that connects to the old system, reads its program, or needs anything
    // the vendor has to agree to hand over.
    const extraction = await import('../../packages/migration/src/extraction');
    const parser = await import('../../packages/migration/src/report-parser');
    for (const module of [extraction, parser]) {
      for (const forbidden of ['connectToLegacy', 'readLegacyDatabase', 'dumpDatabase', 'decompile', 'bypassProtection']) {
        expect(Object.keys(module)).not.toContain(forbidden);
      }
    }
  });
});
